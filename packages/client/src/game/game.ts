import {
  HASH_EVERY_TICKS,
  TICK_MS,
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  FogState,
  type PlayerCommand,
  type RtsMapDoc,
  type SimState,
  type TickBundle,
  type WalkGrid,
} from '@battlebadger/sim'
import type { Transport } from '../net/transport.ts'
import { GameRenderer } from '../render/renderer.ts'
import { PLAYER_COLORS } from '../render/unitMeshes.ts'
import { InputController } from '../input/input.ts'
import { MouseCursor } from '../input/cursor.ts'
import { Hud } from '../ui/hud.ts'
import { banner, DiagOverlay } from '../ui/diag.ts'
import { HoldOverlay } from '../ui/hold.ts'
import { VERSION } from '../version.ts'

export interface GameEndInfo {
  won: boolean
  reason: 'defeat' | 'forfeit' | 'desync' | 'surrender' | 'crash'
}

// How long without a tick bundle before we say so on screen. The relay sends
// one every TICK_MS, so a second of silence is already far outside normal.
const STALL_MS = 1500
// Bundles queued before this machine is declared unable to keep up. The loop
// fast-forwards up to 30 steps a frame, so a queue that stays above this is
// losing ground rather than absorbing a hiccup.
const BEHIND_QUEUE = 20

export class Game {
  private sim: SimState
  private grid: WalkGrid
  private renderer3d: GameRenderer
  private input: InputController
  private cursor: MouseCursor
  private hud: Hud
  private mySlot: number
  private transport: Transport
  private fog: FogState
  private bundles: TickBundle[] = []
  private cmdLog: TickBundle[] = []
  private prevX: Float64Array
  private prevZ: Float64Array
  private lastStepAt = 0
  private lastFrameAt = 0
  private running = true
  // ---- freeze diagnostics ----
  private diag = new DiagOverlay()
  private lastBundleAt = 0
  private fps = 0
  private framesThisSecond = 0
  private fpsWindowAt = 0
  private stepMs = 0
  private frameMs = 0
  private trouble = ''
  // Consecutive throws out of the frame loop. One is a hiccup worth logging;
  // a run of them means the loop cannot make progress and limping on would
  // only bury the first, most useful error under thousands of repeats.
  private frameErrors = 0
  // ---- rejoin ----
  /** Tick we are replaying towards; -1 when not catching up. While catching
   * up the sim runs flat out and stays quiet: its hashes describe ticks the
   * rest of the room settled long ago. */
  private catchupTo = -1
  private catchupFrom = 0
  private hold: HoldOverlay | null = null
  /** The room is deliberately not sending ticks — held, replaying, or
   * reconnecting. Distinguishes "nothing is arriving" from "nothing is meant
   * to be arriving yet". */
  private waiting = false
  private seed: number
  private onEnd: (info: GameEndInfo) => void

  constructor(
    container: HTMLElement,
    doc: RtsMapDoc,
    mySlot: number,
    transport: Transport,
    onEnd: (info: GameEndInfo) => void,
    assets: Map<string, import('three').BufferGeometry> = new Map(),
    playerCount = 2,
    aiLevels: number[] = [],
  ) {
    this.seed = doc.seed
    this.mySlot = mySlot
    this.transport = transport
    this.onEnd = onEnd
    this.grid = walkGridFromDoc(doc)
    this.sim = setupMatch(doc, this.grid, playerCount)
    // Computer opponents. Hashed state, so this must be identical on every
    // client — the lobby decides it once and hands the same array to all.
    aiLevels.forEach((lvl, i) => {
      if (i < 8) this.sim.aiLevel[i] = Math.max(0, Math.min(3, lvl | 0))
    })
    // Fog is per-viewer derived state: our team's eyes only, never simulated.
    this.fog = new FogState(doc, this.sim.playerTeam[mySlot])
    this.prevX = Float64Array.from(this.sim.posX)
    this.prevZ = Float64Array.from(this.sim.posZ)
    this.cursor = new MouseCursor(container)
    this.cursor.enabled = true
    // AI-slot content (owner >= playerCount, e.g. MOBA lane creeps) renders in
    // its TEAM's color — the lowest human slot on the same team — so the war
    // reads as blue vs red instead of whatever palette slots 6/7 have.
    const ownerColors = PLAYER_COLORS.map((c, owner) => {
      if (owner < playerCount) return c
      for (let p = 0; p < playerCount; p++) {
        if (this.sim.playerTeam[p] === this.sim.playerTeam[owner]) return PLAYER_COLORS[p]
      }
      return c
    })
    this.renderer3d = new GameRenderer(
      container,
      doc,
      this.grid,
      mySlot,
      this.cursor,
      this.sim.def,
      assets,
      ownerColors,
    )
    this.input = new InputController(this.renderer3d, this.sim, this.grid, mySlot, this.cursor, (c) =>
      transport.sendCmd(c),
    )
    this.input.fog = this.fog
    this.hud = new Hud(
      doc,
      this.sim.def,
      this.renderer3d.cam,
      mySlot,
      {
        armAttack: () => this.input.armAttack(),
        armMove: () => this.input.armMove(),
        armPatrol: () => this.input.armPatrol(),
        hold: () => this.input.holdCmd(),
        selectOnly: (id) => this.input.selectOnly(id),
        deselectOne: (id) => this.input.deselectOne(id),
        selectSameType: (id) => this.input.selectSameType(id),
        armAbility: (abIdx) => this.input.armAbility(abIdx),
        armBuild: (defIdx) => this.input.armBuild(defIdx),
        train: (defIdx) => this.input.train(defIdx),
        stop: () => this.input.stopCmd(),
        selectedAbilities: () => this.input.selectedAbilities(),
        buildOptions: () => this.input.buildOptions(),
        plotOptions: () => this.input.plotOptions(),
        buildOnPlot: (defIdx) => this.input.buildOnPlot(defIdx),
        hordeFormations: () => this.input.hordeFormations(),
        setFormation: (index) => this.input.setFormation(index),
        setMuted: (on) => this.renderer3d.audio.setMuted(on),
        researchOptions: () => this.input.researchOptions(),
        researchReady: (up) => this.input.researchReady(up),
        research: (up) => this.input.research(up),
        selectedGates: () => this.input.selectedGates(),
        gateMode: () => this.input.gateMode(),
        setGateMode: (mode) => this.input.setGateMode(mode),
        selectedBuilding: () => this.input.selectedBuilding(),
        abilityCooldown: (abIdx) => this.input.abilityCooldown(abIdx),
        centerOn: (id) => this.input.centerOn(id),
        minimapOrder: (x, z) => this.input.minimapOrder(x, z),
        surrender: () => this.end({ won: false, reason: 'surrender' }),
      },
      (menuOpen) => {
        // Free the mouse while the menu is up; clicks re-capture afterwards.
        this.cursor.enabled = !menuOpen && this.running
        if (menuOpen) this.cursor.release()
      },
      ownerColors,
    )
    this.input.hud = this.hud
    transport.onBundle = (b) => {
      this.bundles.push(b)
      this.lastBundleAt = performance.now()
    }
    this.lastBundleAt = performance.now()
    requestAnimationFrame((t) => this.frame(t))
  }

  // Trigger messages as fading toasts.
  private toast(text: string): void {
    let host = document.getElementById('toasts')
    if (!host) {
      host = document.createElement('div')
      host.id = 'toasts'
      document.body.appendChild(host)
    }
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = text
    host.appendChild(el)
    setTimeout(() => el.classList.add('fade'), 5200)
    setTimeout(() => el.remove(), 6000)
  }

  // External end (forfeit win / desync freeze).
  end(info: GameEndInfo): void {
    if (!this.running) return
    this.running = false
    this.cursor.enabled = false
    this.cursor.destroy()
    this.hud.destroy()
    this.diag.destroy()
    this.hold?.destroy()
    if (info.reason === 'desync') {
      // The command log + seed IS a replay — dump it for offline debugging.
      // The build goes in it too: "the two clients were on different code" is
      // the first thing to rule out, and the log alone cannot say.
      console.error('DESYNC — replay dump:', JSON.stringify({ version: VERSION, seed: this.seed, log: this.cmdLog }))
    }
    this.transport.close()
    this.onEnd(info)
  }

  private stepOnce(now: number): void {
    const bundle = this.bundles.shift()!
    // The bundle stream IS the clock: the sim steps once per bundle and never
    // resyncs against the relay, so a dropped or duplicated one shifts this
    // client's tick stream forever. Catch it here rather than letting it
    // surface as a mystery hash mismatch up to HASH_EVERY_TICKS later.
    if (bundle.tick !== this.sim.tick) {
      console.error(`bundle gap: expected tick ${this.sim.tick}, got ${bundle.tick}`)
      this.end({ won: false, reason: 'desync' })
      return
    }
    this.prevX.set(this.sim.posX)
    this.prevZ.set(this.sim.posZ)
    this.cmdLog.push(bundle)
    step(this.sim, this.grid, bundle.cmds)
    // Replaying history: these already happened. Toasting a rejoining player
    // through twenty minutes of announcements, or panning their camera around
    // to old events, would be theatre.
    const replaying = this.catchupTo >= 0
    if (!replaying) {
      // trigger-driven client effects
      for (const ev of this.sim.events) {
        if (ev.t === 'message' && (ev.player === -1 || ev.player === this.mySlot)) {
          this.toast(ev.text)
        } else if (ev.t === 'panCamera' && ev.player === this.mySlot) {
          this.renderer3d.cam.moveTo(ev.x, ev.z)
        }
      }
    }
    this.lastStepAt = now
    // Hashes describe a tick everyone else agreed on long ago; reporting them
    // mid-replay would compare our past against their present.
    if (!replaying && this.sim.tick % HASH_EVERY_TICKS === 0) {
      this.transport.sendHash(this.sim.tick, stateHash(this.sim))
    }
    if (this.sim.winner >= 0) {
      this.end({ won: this.sim.winner === this.sim.playerTeam[this.mySlot], reason: 'defeat' })
    }
  }

  // Relay forfeit: the last remaining player's slot wins for their team.
  endForfeit(survivorSlot: number): void {
    const myTeam = this.sim.playerTeam[this.mySlot]
    const winTeam = survivorSlot >= 0 ? this.sim.playerTeam[survivorSlot] : -1
    this.end({ won: winTeam === myTeam, reason: 'forfeit' })
  }

  // Trigger toasts are also useful for lobby-level notices (player left).
  notify(text: string): void {
    this.toast(text)
  }

  // ---- rejoin ----

  /** How far this client has simulated — where a reconnect asks to resume. */
  get tick(): number {
    return this.sim.tick
  }

  private holdUi(): HoldOverlay {
    this.hold ??= new HoldOverlay({
      kick: (slot) => {
        this.transport.sendKick(slot)
      },
    })
    return this.hold
  }

  /**
   * Replay what we missed. The bundles go through the ordinary queue and the
   * ordinary step path — a rejoin is not a special kind of simulation, it is
   * the same simulation run faster — with the empty ticks the relay left out
   * filled back in, because the sim counts bundles, not orders.
   */
  catchUp(from: number, to: number, cmds: [number, PlayerCommand[]][]): void {
    this.waiting = true
    if (to <= from) {
      this.transport.sendReady()
      return
    }
    const byTick = new Map(cmds)
    for (let t = from; t < to; t++) this.bundles.push({ tick: t, cmds: byTick.get(t) ?? [] })
    this.catchupFrom = from
    this.catchupTo = to
    this.lastBundleAt = performance.now()
    this.holdUi().catchingUp(from, to)
    console.warn(`[bb] rejoin: replaying ticks ${from}..${to}`)
  }

  /** The room is holding for players who dropped. */
  heldFor(slots: number[], names: (string | null)[], untilMs: number): void {
    this.waiting = true
    if (this.catchupTo >= 0) return // our own catch-up screen is more useful
    if (slots.includes(this.mySlot)) return // we are the missing one; we are back
    this.holdUi().waitingFor(slots, names, untilMs)
  }

  /** Everyone is present again and the stream is about to restart. */
  released(): void {
    this.waiting = false
    this.hold?.hide()
    // A long hold leaves the step clock far in the past; without this the loop
    // would treat every queued bundle as overdue and fast-forward through it.
    this.lastStepAt = performance.now()
    this.lastBundleAt = performance.now()
  }

  reconnecting(attempt: number): void {
    this.waiting = true
    this.holdUi().reconnecting(attempt)
  }

  // An exception used to escape here and take requestAnimationFrame with it:
  // the loop was never re-armed, so the client stopped dead with nothing on
  // screen and nothing in the console beyond the raw error. Re-arming is what
  // makes a freeze survivable — and reportable.
  private frame(now: number): void {
    if (!this.running) return
    try {
      this.tickFrame(now)
      this.frameErrors = 0
    } catch (err) {
      if (!this.onFrameError(err)) return
    }
    requestAnimationFrame((t) => this.frame(t))
  }

  /** True if the loop should keep running. */
  private onFrameError(err: unknown): boolean {
    this.frameErrors++
    console.error(
      `[bb] frame error #${this.frameErrors} — v${VERSION}, tick ${this.sim.tick}, ` +
        `queue ${this.bundles.length}, entities ${this.sim.count}`,
      err,
    )
    if (this.frameErrors < 3) {
      // Probably a one-off (a mesh, a HUD paint). Say so and carry on rather
      // than ending a match that is otherwise fine.
      this.trouble = 'recovered from a client error — see the console'
      this.diag.force(true)
      return true
    }
    banner(`Client error at tick ${this.sim.tick} — see the console (F12). Build v${VERSION}.`, { sticky: true })
    this.end({ won: false, reason: 'crash' })
    return false
  }

  private tickFrame(now: number): void {
    const dtMs = this.lastFrameAt === 0 ? 16 : Math.min(100, now - this.lastFrameAt)
    this.frameMs = this.lastFrameAt === 0 ? 16 : now - this.lastFrameAt
    this.lastFrameAt = now

    // Step when a bundle is due; fast-forward if we've fallen behind. While
    // replaying a rejoin the whole point is to go as fast as the machine can,
    // so the step cap becomes a time budget instead — enough to keep the
    // progress bar painting, not so little that a long match takes minutes.
    const stepStart = performance.now()
    const replaying = this.catchupTo >= 0
    let guard = 0
    while (this.bundles.length > 0 && (replaying ? performance.now() - stepStart < 24 : guard < 30)) {
      const behind = this.bundles.length > 2
      const due = now - this.lastStepAt >= TICK_MS - 4
      if (!replaying && !behind && !due) break
      this.stepOnce(now)
      guard++
      if (!this.running) return
    }
    this.stepMs = performance.now() - stepStart
    if (replaying) this.replayProgress()

    const alpha = Math.min(1, (now - this.lastStepAt) / TICK_MS)
    this.input.prune()
    this.renderer3d.render(this.sim, this.prevX, this.prevZ, alpha, this.input.selection, dtMs, this.fog)
    this.hud.update(this.sim, this.input.selection, this.renderer3d.camera, this.fog)
    this.watch(now)
  }

  // Replaying the backlog: paint the bar, and announce the moment we are level
  // with everyone else — the room is paused waiting for exactly that.
  private replayProgress(): void {
    if (this.sim.tick < this.catchupTo) {
      this.holdUi().catchingUp(this.sim.tick - this.catchupFrom, this.catchupTo - this.catchupFrom)
      return
    }
    console.warn(`[bb] rejoin: caught up at tick ${this.sim.tick}`)
    this.catchupTo = -1
    this.hold?.hide()
    this.lastStepAt = performance.now()
    this.transport.sendReady()
  }

  // Name the freeze while it is happening. Both conditions look the same to a
  // player — the picture stops — but one is the room's problem and the other
  // is this machine's, and they are told apart by which number is climbing.
  private watch(now: number): void {
    this.framesThisSecond++
    if (now - this.fpsWindowAt >= 1000) {
      this.fps = (this.framesThisSecond * 1000) / (now - this.fpsWindowAt)
      this.framesThisSecond = 0
      this.fpsWindowAt = now
    }

    const bundleAgeMs = now - this.lastBundleAt
    // A held room is silent on purpose and says so on its own screen; calling
    // that a stall would be crying wolf at the one moment the player already
    // knows exactly what is happening.
    const held = this.waiting
    const stalled = bundleAgeMs > STALL_MS && !held
    const behind = this.bundles.length > BEHIND_QUEUE
    const note = stalled
      ? `no ticks from the relay for ${(bundleAgeMs / 1000).toFixed(1)}s — the connection or the room stalled`
      : behind
        ? `${this.bundles.length} ticks behind — this machine cannot simulate as fast as the match runs`
        : this.frameErrors > 0
          ? this.trouble
          : ''
    if (note !== this.trouble) {
      this.trouble = note
      // Log the transition, not the state: a copy of the console then reads as
      // a timeline of when the trouble started and when it cleared.
      console.warn(`[bb] ${note || 'recovered — ticks flowing again'} (tick ${this.sim.tick})`)
    }
    banner(note || null)
    this.diag.force(Boolean(note))
    this.diag.update(now, {
      slot: this.mySlot,
      tick: this.sim.tick,
      queue: this.bundles.length,
      bundleAgeMs,
      fps: this.fps,
      frameMs: this.frameMs,
      stepMs: this.stepMs,
      entities: this.sim.count,
      note,
    })
  }
}
