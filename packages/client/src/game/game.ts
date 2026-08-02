import {
  HASH_EVERY_TICKS,
  TICK_MS,
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  FogState,
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
import { VERSION } from '../version.ts'

export interface GameEndInfo {
  won: boolean
  reason: 'defeat' | 'forfeit' | 'desync' | 'surrender'
}

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
    transport.onBundle = (b) => this.bundles.push(b)
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
    // trigger-driven client effects
    for (const ev of this.sim.events) {
      if (ev.t === 'message' && (ev.player === -1 || ev.player === this.mySlot)) {
        this.toast(ev.text)
      } else if (ev.t === 'panCamera' && ev.player === this.mySlot) {
        this.renderer3d.cam.moveTo(ev.x, ev.z)
      }
    }
    this.lastStepAt = now
    if (this.sim.tick % HASH_EVERY_TICKS === 0) {
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

  private frame(now: number): void {
    if (!this.running) return
    const dtMs = this.lastFrameAt === 0 ? 16 : Math.min(100, now - this.lastFrameAt)
    this.lastFrameAt = now

    // Step when a bundle is due; fast-forward if we've fallen behind.
    let guard = 0
    while (this.bundles.length > 0 && guard < 30) {
      const behind = this.bundles.length > 2
      const due = now - this.lastStepAt >= TICK_MS - 4
      if (!behind && !due) break
      this.stepOnce(now)
      guard++
      if (!this.running) return
    }

    const alpha = Math.min(1, (now - this.lastStepAt) / TICK_MS)
    this.input.prune()
    this.renderer3d.render(this.sim, this.prevX, this.prevZ, alpha, this.input.selection, dtMs, this.fog)
    this.hud.update(this.sim, this.input.selection, this.renderer3d.camera, this.fog)
    requestAnimationFrame((t) => this.frame(t))
  }
}
