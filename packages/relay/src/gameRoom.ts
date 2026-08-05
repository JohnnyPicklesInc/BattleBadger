import { DurableObject } from 'cloudflare:workers'
import { REJOIN_GRACE_MS, TICK_MS } from '@battlebadger/sim'
import type { ClientMsg, ServerMsg } from '@battlebadger/sim/protocol'
import type { PlayerCommand } from '@battlebadger/sim'

interface Attachment {
  slot: number
  name: string
  /** Client build, reported on connect. Handed back so the lobby can name who
   * is on stale code, and compared on the way in — see `buildRefusal`. */
  ver?: string
}

/** A seat, remembered across the socket that was sitting in it. */
interface Seat {
  name: string
  /** Presented on reconnect to claim this slot back. Without it, anyone with
   * the room code could take a dropped player's army. */
  token: string
  ver?: string
  /** Dropped for good — timed out or kicked. Their seat cannot be reclaimed. */
  gone?: boolean
}

const MAX_PLAYERS = 8

// What has to outlive an eviction. Everything else a room holds — reported
// hashes, transferred map bytes — is re-derivable or disposable; this is not.
interface RoomState {
  started: boolean
  ended: boolean
  /** The next tick to emit. The bundle stream is the sim's ONLY clock and is
   * never resynced, so resuming anywhere but here desyncs every client at
   * once — which is why it is worth a storage write per bundle. */
  tick: number
  /** Held for players who dropped: the metronome is stopped, so nobody plays
   * on while a returning client is still replaying the backlog. */
  paused: boolean
  /** Slots being waited for. */
  missing: number[]
  /** When the wait runs out and the missing are dropped for good. */
  graceEndsAt: number
  /** By slot. Survives the socket, which is the whole point: a seat has to be
   * recognisable when its player comes back on a new connection. */
  seats: (Seat | null)[]
  /** The build this room plays. Set by whoever opens it — see `buildRefusal`. */
  build?: string
}

const STATE_KEY = 'room'
/** Per-tick orders, keyed `c:<zero-padded tick>` so a range list is ordered.
 * Only ticks that carry orders are stored — the rest are empty by definition
 * and cost nothing to reconstruct. This log IS the match: replaying it from
 * tick 0 is how a client that reloaded gets back to the present. */
const CMD_PREFIX = 'c:'
const cmdKey = (tick: number): string => CMD_PREFIX + String(tick).padStart(9, '0')

// Seat secret. Long enough that guessing one is not a way into someone else's
// army; the room code is already the door, this is the key to a chair.
function newToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// How often the watchdog alarm checks that a running room still has its
// metronome. A frozen room sends nothing, so no client will ever wake it: an
// alarm is the only thing that can. Long enough to be cheap, short enough that
// an eviction costs seconds rather than the match.
const WATCHDOG_MS = 10_000

// One room = one match, up to 8 players. The DO is a dumb relay and metronome:
// it never runs the sim, knows nothing about teams, and stamps player slots
// onto commands from the connection (never the payload). It broadcasts a
// TickBundle every TICK_MS and compares client state hashes for desync
// detection across every connected client.
//
// Its WebSockets are hibernatable and outlive the object's memory. Everything
// that drives a running match therefore has to be restorable, or an eviction
// leaves every client watching a picture that never moves again.
// No bindings of its own: a room is a metronome and a mailbox.
export class GameRoom extends DurableObject<unknown> {
  private started = false
  private ended = false
  private tick = 0
  private pending: PlayerCommand[] = []
  private hashes = new Map<number, Map<number, number>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private mapBytes = 0
  private paused = false
  private missing: number[] = []
  private graceEndsAt = 0
  private seats: (Seat | null)[] = Array.from({ length: MAX_PLAYERS }, () => null)
  /** The build every client in this room must be on. Empty until the first one
   * that reports a build arrives; forgotten again when the lobby empties. */
  private build = ''
  /** The match's orders by tick, sparse — see CMD_PREFIX. */
  private log = new Map<number, PlayerCommand[]>()

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    // Every handler below assumes the room's state is in memory. After an
    // eviction it is not, so no request may be served until it is back.
    ctx.blockConcurrencyWhile(async () => this.restore())
  }

  // Pick the match back up exactly where it stopped. The clients never learned
  // that anything happened: their sims are parked one tick behind the last
  // bundle we emitted, so the stream resumes there and the only casualty is
  // the orders that were in flight — dropped for everyone alike, which is the
  // one kind of loss lockstep does not mind.
  private async restore(): Promise<void> {
    const saved = await this.ctx.storage.get<RoomState>(STATE_KEY)
    if (!saved) return
    this.started = saved.started
    this.ended = saved.ended
    this.tick = saved.tick
    this.paused = saved.paused
    this.missing = saved.missing
    this.graceEndsAt = saved.graceEndsAt
    this.seats = saved.seats
    this.build = saved.build ?? ''
    if (!this.started || this.ended) return

    // The order log has to come back too: it is what a returning player
    // replays, and a match that lost it can never take one back.
    const stored = await this.ctx.storage.list<PlayerCommand[]>({ prefix: CMD_PREFIX })
    for (const [key, cmds] of stored) this.log.set(Number(key.slice(CMD_PREFIX.length)), cmds)

    if (this.sockets().length === 0 && !this.paused) {
      // Nobody came back with us: the match is over whether or not anyone
      // said so, and a metronome ticking to an empty room is just a bill.
      this.finish()
      return
    }
    if (this.paused) return // still waiting on someone; the alarm decides
    console.warn(`[relay] room revived at tick ${this.tick} — restarting the metronome`)
    this.startMetronome()
  }

  /**
   * A room's vital signs, for diagnosing a reported freeze from outside:
   * a climbing `tick` means the relay is fine and the problem is a client; a
   * stuck one with players still connected means the room is the problem.
   */
  async roomState(): Promise<{
    started: boolean
    ended: boolean
    tick: number
    players: number
    ticking: boolean
    alarmInMs: number | null
    paused: boolean
    missing: number[]
    /** Orders kept for replay — what a returning player would receive. */
    logged: number
  }> {
    const alarm = await this.ctx.storage.getAlarm()
    return {
      started: this.started,
      ended: this.ended,
      tick: this.tick,
      players: this.sockets().length,
      ticking: this.timer !== null,
      alarmInMs: alarm === null ? null : alarm - Date.now(),
      paused: this.paused,
      missing: [...this.missing],
      logged: this.log.size,
    }
  }

  private persist(): void {
    // Unawaited: the runtime flushes pending writes before it evicts, and
    // putting disk latency inside a 10 Hz metronome would be worse than the
    // failure it protects against.
    void this.ctx.storage.put(STATE_KEY, {
      started: this.started,
      ended: this.ended,
      tick: this.tick,
      paused: this.paused,
      missing: this.missing,
      graceEndsAt: this.graceEndsAt,
      seats: this.seats,
      build: this.build,
    } satisfies RoomState)
  }

  private startMetronome(): void {
    if (this.timer !== null || this.ended || this.paused) return
    this.timer = setInterval(() => this.emitBundle(), TICK_MS)
    void this.armWatchdog()
  }

  private stopMetronome(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async armWatchdog(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    }
  }

  // Two jobs on one alarm: keep a running room's metronome alive across an
  // eviction, and end the wait for players who never came back.
  override async alarm(): Promise<void> {
    if (this.ended) return
    if (this.paused && Date.now() >= this.graceEndsAt) {
      // Their time is up. Whoever is still here plays on without them.
      // A copy: dropSlot edits the list we are walking.
      for (const slot of this.missing.slice()) this.dropSlot(slot, 'timed out')
      this.settleWait()
    }
    if (this.ended) return
    if (this.sockets().length === 0 && !this.paused) return
    if (this.started && !this.paused) this.startMetronome()
    const next = this.paused ? Math.min(this.graceEndsAt, Date.now() + WATCHDOG_MS) : Date.now() + WATCHDOG_MS
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 250))
  }

  // ---- rejoin: hold the match, then either welcome them back or move on ----

  /** Hold everything for a slot whose socket just went away. */
  private holdFor(slot: number): void {
    if (this.missing.includes(slot)) return
    this.missing.push(slot)
    this.stopMetronome()
    if (!this.paused) {
      this.paused = true
      // One deadline for the whole wait: a second player dropping must not
      // extend the first one's grace indefinitely.
      this.graceEndsAt = Date.now() + REJOIN_GRACE_MS
    }
    this.persist()
    this.announceWait()
    void this.ctx.storage.setAlarm(this.graceEndsAt)
  }

  private announceWait(): void {
    this.broadcast({
      t: 'paused',
      slots: [...this.missing],
      names: this.missing.map((s) => this.seats[s]?.name ?? null),
      untilMs: Math.max(0, this.graceEndsAt - Date.now()),
    })
  }

  /** Out for good: timed out, or kicked by someone who did not want to wait. */
  private dropSlot(slot: number, why: string): void {
    const seat = this.seats[slot]
    this.missing = this.missing.filter((s) => s !== slot)
    if (!seat || seat.gone) return
    seat.gone = true
    console.warn(`[relay] slot ${slot} ${why} — dropped from the match`)
    this.broadcast({ t: 'playerLeft', slot, name: seat.name })
  }

  /**
   * Decide what a room does now that its missing list has changed: resume if
   * everyone is back, end if too few are left to have a match.
   */
  private settleWait(): void {
    if (this.ended) return
    const here = this.sockets().length
    if (here === 0) {
      // Everybody is gone and nobody is coming back.
      this.finish()
      return
    }
    if (this.missing.length > 0) {
      this.announceWait()
      return
    }
    // A match needs an opponent. One player left standing wins by forfeit,
    // exactly as when someone quits outright.
    const contenders = this.seats.filter((s) => s && !s.gone).length
    if (contenders <= 1 && this.startedWithMany) {
      const winner = this.sockets()[0]
      this.finish()
      this.broadcast({ t: 'forfeit', winner: this.att(winner).slot })
      for (const ws of this.sockets()) {
        try {
          ws.close(1000, 'match over')
        } catch {
          // already closing
        }
      }
      return
    }
    this.paused = false
    this.persist()
    this.broadcast({ t: 'resumed', tick: this.tick })
    this.startMetronome()
  }

  /** Whether this match ever had an opponent to lose. */
  private get startedWithMany(): boolean {
    return this.seats.filter(Boolean).length > 1
  }

  private att(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets()
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg)
    for (const ws of this.sockets()) {
      try {
        ws.send(data)
      } catch {
        // closing socket; webSocketClose will handle it
      }
    }
  }

  private forwardTo(slot: number, msg: ServerMsg): void {
    for (const ws of this.sockets()) {
      if (this.att(ws).slot !== slot) continue
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // closing socket
      }
    }
  }

  private lobbyPlayers(): (string | null)[] {
    const out: (string | null)[] = Array.from({ length: MAX_PLAYERS }, () => null)
    for (const ws of this.sockets()) {
      const a = this.att(ws)
      out[a.slot] = a.name
    }
    return out
  }

  private lobbyVersions(): (string | null)[] {
    const out: (string | null)[] = Array.from({ length: MAX_PLAYERS }, () => null)
    for (const ws of this.sockets()) {
      const a = this.att(ws)
      out[a.slot] = a.ver ?? null
    }
    return out
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const name = (url.searchParams.get('name') ?? 'Badger').slice(0, 16)
    const ver = url.searchParams.get('ver')?.slice(0, 24) ?? undefined
    const claim = url.searchParams.get('token')
    const claimSlot = Number(url.searchParams.get('slot'))

    // Everyone in a room must be running the same build. Different builds
    // disagree about unit stats, pathing and the order the sim does things in,
    // so they desync on the first tick with nothing on screen to explain it.
    // The lobby's warning is the polite version; this is the one that cannot
    // be played through. Applies to a rejoin too — reloading into a deploy
    // that landed mid-match is exactly how somebody comes back on new code.
    const refusal = this.buildRefusal(ver)
    if (refusal !== null) return this.refuse(refusal)

    // A player coming back to a seat they already hold. Only their own token
    // opens it, and only while the match is still running.
    if (claim) {
      const seat = Number.isInteger(claimSlot) ? this.seats[claimSlot] : null
      if (!this.started || this.ended) return new Response('no match to rejoin', { status: 409 })
      if (!seat || seat.token !== claim || seat.gone) return new Response('seat not yours', { status: 403 })
      if (this.sockets().some((w) => this.att(w).slot === claimSlot)) {
        return new Response('seat already connected', { status: 409 })
      }
      return this.attach(claimSlot, seat.name, ver, true)
    }

    if (this.started || this.sockets().length >= MAX_PLAYERS) {
      return new Response('room full or match already started', { status: 409 })
    }
    const taken = new Set(this.sockets().map((w) => this.att(w).slot))
    let slot = 0
    while (taken.has(slot)) slot++
    // The seat is recorded now, not at start: it is what a reconnect is checked
    // against, and it has to outlive the socket it was created for.
    this.seats[slot] = { name, token: newToken(), ver }
    return this.attach(slot, name, ver, false)
  }

  /** Why this build cannot be seated here, or null if it can. A client that
   * reports no build at all is let in: only a client old enough to predate the
   * `ver` parameter does that, and there is nothing to compare it against. */
  private buildRefusal(ver: string | undefined): string | null {
    if (!ver || this.build === '' || ver === this.build) return null
    return (
      `Everyone in this room has to be on the same build: you are on ${ver} and ` +
      `the room is on ${this.build}. Reload to pick up the newest one.`
    )
  }

  /** Turn a connection away with an explanation it can actually show.
   *
   * The socket is accepted so the message can be sent down it — a refused
   * upgrade reaches the client as a bare connection failure, and "the room
   * refused the connection" is exactly the kind of dead end this check exists
   * to replace. */
  private refuse(message: string): Response {
    const pair = new WebSocketPair()
    pair[1].accept()
    try {
      pair[1].send(JSON.stringify({ t: 'error', message } satisfies ServerMsg))
      pair[1].close(4001, 'build mismatch')
    } catch {
      // The client gave up first; there is nobody left to tell.
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private attach(slot: number, name: string, ver: string | undefined, resumed: boolean): Response {
    // The first client through the door decides what the room plays, and
    // everyone after it is measured against that.
    if (this.build === '' && ver) this.build = ver
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ slot, name, ver } satisfies Attachment)

    const players = this.lobbyPlayers()
    players[slot] = name
    const versions = this.lobbyVersions()
    versions[slot] = ver ?? null
    pair[1].send(
      JSON.stringify({
        t: 'joined',
        slot,
        players,
        versions,
        token: this.seats[slot]?.token,
        ...(resumed ? { resumed: true } : {}),
      } satisfies ServerMsg),
    )
    if (!resumed) this.broadcast({ t: 'lobby', players, versions })
    this.persist()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(raw)) as ClientMsg
    } catch {
      return
    }
    const a = this.att(ws)
    // A started room with no metronome should be impossible unless it is
    // deliberately held: an eviction is repaired on the way in (see restore),
    // and the only other way to lose the timer is finishing, which sets
    // `ended`. If it happens anyway the room can never tick again, so close it
    // rather than let it freeze in silence.
    if (this.started && !this.ended && !this.paused && this.timer === null) {
      this.roomLost()
      return
    }
    switch (msg.t) {
      // ---- rejoin ----
      case 'resume': {
        // A returning client says how far it got; we send the rest. Sparse,
        // because a match is mostly ticks in which nobody ordered anything.
        if (!this.started || this.ended) return
        const from = Math.max(0, Math.min(this.tick, msg.tick | 0))
        const cmds: [number, PlayerCommand[]][] = []
        for (let t = from; t < this.tick; t++) {
          const c = this.log.get(t)
          if (c && c.length > 0) cmds.push([t, c])
        }
        try {
          ws.send(JSON.stringify({ t: 'catchup', from, to: this.tick, cmds } satisfies ServerMsg))
        } catch {
          // closing; webSocketClose will hold the seat again
        }
        break
      }
      case 'ready': {
        // Level with everyone else. If they were the last one being waited
        // for, the match starts moving again.
        if (!this.started || this.ended) return
        if (!this.missing.includes(a.slot)) return
        this.missing = this.missing.filter((s) => s !== a.slot)
        this.persist()
        console.warn(`[relay] slot ${a.slot} rejoined at tick ${this.tick}`)
        this.settleWait()
        break
      }
      case 'kick': {
        // Anyone still here may end the wait. It only brings forward what the
        // grace timer would do on its own, so there is nothing to vote on.
        if (!this.paused || this.ended) return
        const slot = msg.slot | 0
        if (!this.missing.includes(slot)) return
        this.dropSlot(slot, `kicked by slot ${a.slot}`)
        this.settleWait()
        break
      }
      case 'startReq': {
        // only the host starts; solo (1-player) matches are allowed
        if (this.started || a.slot !== 0 || this.sockets().length < 1) return
        this.started = true
        // Padded, not compacted: slot 2 playing while slot 1 sits empty is
        // ordinary once the host seats computers, and every client has to agree
        // about which slot each name holds.
        const players = this.lobbyPlayers()
        const seed = Math.floor(Math.random() * 0xffffffff)
        this.broadcast({ t: 'start', seed, players })
        this.persist()
        this.startMetronome()
        break
      }
      case 'cmd': {
        if (!this.started || this.ended) return
        const c = msg.c
        // Shape-generic validation: the relay knows no game semantics. The sim
        // deterministically ignores unknown kinds and stale/invalid references.
        if (!c || typeof c.kind !== 'string' || c.kind.length > 24) return
        if (!Array.isArray(c.units) || c.units.length > 1024) return
        const x = Number(c.x)
        const z = Number(c.z)
        if (!Number.isFinite(x) || !Number.isFinite(z)) return
        this.pending.push({
          kind: c.kind as PlayerCommand['kind'],
          units: c.units.map((u) => Number(u) | 0).slice(0, 1024),
          x,
          z,
          ability: c.ability !== undefined ? Number(c.ability) | 0 : undefined,
          target: c.target !== undefined ? Number(c.target) | 0 : undefined,
          def: c.def !== undefined ? Number(c.def) | 0 : undefined,
          player: a.slot, // stamped from the connection — payload never trusted
        })
        break
      }
      case 'mapBegin':
      case 'mapChunk': {
        // custom-map fan-out: host (slot 0) → every guest; relay stores nothing
        if (this.started || a.slot !== 0) return
        if (msg.t === 'mapBegin') {
          if (msg.bytes > 8 * 1024 * 1024 || msg.chunks > 128) return
          this.mapBytes = msg.bytes
        } else if (this.mapBytes === 0 || typeof msg.data !== 'string' || msg.data.length > 262144) {
          return
        }
        for (const other of this.sockets()) {
          if (this.att(other).slot === 0) continue
          try {
            other.send(JSON.stringify(msg as unknown as ServerMsg))
          } catch {
            // closing
          }
        }
        break
      }
      case 'mapAck': {
        if (a.slot === 0) return
        this.forwardTo(0, { t: 'mapAck', ok: msg.ok === true, slot: a.slot })
        break
      }
      case 'pick': {
        // A guest asking for a race/team. The relay does not interpret it — the
        // host decides what is seatable and answers with 'seats'.
        if (this.started || a.slot === 0) return
        const p = msg.pick
        if (typeof p !== 'object' || p === null) return
        const faction = typeof p.faction === 'string' ? p.faction.slice(0, 64) : null
        const team = Number.isFinite(p.team) ? Math.max(0, Math.min(7, Number(p.team) | 0)) : undefined
        const start = Number.isFinite(p.start) ? Math.max(0, Math.min(7, Number(p.start) | 0)) : undefined
        // `ai` is deliberately not forwarded: seating a computer is the host's
        // call, and a guest asking for one would only be ignored downstream.
        this.forwardTo(0, {
          t: 'pick',
          pick: { faction, ...(team === undefined ? {} : { team }), ...(start === undefined ? {} : { start }) },
          slot: a.slot,
        })
        break
      }
      case 'seats': {
        // The host publishing the agreed seating to everyone else.
        if (this.started || a.slot !== 0) return
        if (!Array.isArray(msg.seats) || msg.seats.length > MAX_PLAYERS) return
        for (const ws2 of this.sockets()) {
          if (this.att(ws2).slot === 0) continue
          try {
            ws2.send(JSON.stringify({ t: 'seats', seats: msg.seats } satisfies ServerMsg))
          } catch {
            // closing
          }
        }
        break
      }
      case 'hash': {
        if (!this.started || this.ended) return
        const t = msg.tick | 0
        let m = this.hashes.get(t)
        if (!m) {
          m = new Map()
          this.hashes.set(t, m)
        }
        m.set(a.slot, msg.h >>> 0)
        // compare once every connected client reported this tick
        if (m.size >= this.sockets().length) {
          const values = [...m.values()]
          this.hashes.delete(t)
          if (values.some((v) => v !== values[0])) {
            this.broadcast({ t: 'desync', tick: t })
            this.finish()
          }
          for (const key of this.hashes.keys()) if (key < t - 200) this.hashes.delete(key)
        }
        break
      }
    }
  }

  override webSocketClose(ws: WebSocket): void {
    const a = this.att(ws)
    if (!this.started) {
      // In the lobby a disconnect is just a disconnect — the seat opens up.
      this.seats[a.slot] = null
      // Last one out forgets the build as well. An empty room is nobody's
      // match, and holding yesterday's build against the next player to open
      // the door would turn them away from a room with nothing in it.
      if (this.sockets().filter((s) => s !== ws).length === 0) this.build = ''
      this.persist()
      this.broadcast({ t: 'lobby', players: this.lobbyPlayers(), versions: this.lobbyVersions() })
      return
    }
    if (this.ended) return
    const seat = this.seats[a.slot]
    if (seat?.gone) return // already dropped for good; nothing to wait for
    // Mid-match a disconnect is not a departure any more: it might be a tab
    // reloading or a lift with no signal. Hold the match and let them back in.
    if (this.sockets().filter((s) => s !== ws).length === 0 && !this.startedWithMany) {
      // A solo match ending is just the player leaving — nothing to hold for.
      this.finish()
      return
    }
    console.warn(`[relay] slot ${a.slot} dropped at tick ${this.tick} — holding the match`)
    this.holdFor(a.slot)
  }

  private emitBundle(): void {
    if (this.ended || this.paused) return
    const cmds = this.pending
    this.pending = []
    const tick = this.tick++
    this.broadcast({ t: 'bundle', tick, cmds })
    if (cmds.length > 0) {
      // Only ticks that carry orders are worth keeping: the rest are empty by
      // definition, and a returning client fills them in itself.
      this.log.set(tick, cmds)
      void this.ctx.storage.put(cmdKey(tick), cmds)
    }
    this.persist()
  }

  private finish(): void {
    this.ended = true
    this.paused = false
    this.missing = []
    this.stopMetronome()
    this.persist()
    // The replay log exists to let someone rejoin THIS match. There is no
    // match now, so it is just storage nobody will ever read.
    if (this.log.size > 0) {
      void this.ctx.storage.delete([...this.log.keys()].map(cmdKey))
      this.log.clear()
    }
    // Nothing left to watch over. An alarm left armed would revive this object
    // every ten seconds for a match that is already over.
    void this.ctx.storage.deleteAlarm()
  }

  // Backstop for a room whose state could not be restored at all — a room
  // started before this object learned to persist itself, say. The tick stream
  // is the sim's only clock and cannot be guessed, so resuming would desync
  // every client at once. Tell them plainly and hang up.
  private roomLost(): void {
    console.error('[relay] room state lost mid-match (evicted) — closing the room')
    this.finish()
    this.broadcast({ t: 'error', message: 'the room restarted — the match cannot continue' })
    for (const ws of this.sockets()) {
      try {
        ws.close(1011, 'room restarted')
      } catch {
        // already closing
      }
    }
  }
}
