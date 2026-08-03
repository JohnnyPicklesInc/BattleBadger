import {
  MAP_CHUNK_CHARS,
  TICK_MS,
  type ClientMsg,
  type Command,
  type PlayerCommand,
  type SeatPick,
  type ServerMsg,
  type TickBundle,
} from '@battlebadger/sim'

export interface Transport {
  sendCmd(c: Command): void
  sendHash(tick: number, h: number): void
  onBundle: ((b: TickBundle) => void) | null
  close(): void
  // Rejoin. Offline these are no-ops: a practice match has nobody to wait for
  // and nowhere to come back from.
  sendReady(): void
  sendKick(slot: number): void
}

// Offline practice: fabricates tick bundles locally at the real cadence so the
// game loop is identical online and offline.
export class LocalLoopback implements Transport {
  onBundle: ((b: TickBundle) => void) | null = null
  private tick = 0
  private pending: PlayerCommand[] = []
  private timer: ReturnType<typeof setInterval>

  constructor() {
    this.timer = setInterval(() => {
      const cmds = this.pending
      this.pending = []
      this.onBundle?.({ tick: this.tick++, cmds })
    }, TICK_MS)
  }

  sendCmd(c: Command): void {
    this.pending.push({ ...c, player: 0 })
  }

  sendHash(): void {}

  sendReady(): void {}

  sendKick(): void {}

  close(): void {
    clearInterval(this.timer)
  }
}

export interface WsCallbacks {
  // `versions` is every player's client build, by slot — absent entries are
  // clients too old to report one.
  onJoined?: (
    slot: number,
    players: (string | null)[],
    versions: (string | null)[],
    seat?: { token?: string; resumed?: boolean },
  ) => void
  onLobby?: (players: (string | null)[], versions: (string | null)[]) => void
  // ---- rejoin ----
  /** The backlog to replay, sparse: ticks not listed carried no orders. */
  onCatchup?: (from: number, to: number, cmds: [number, PlayerCommand[]][]) => void
  onPaused?: (slots: number[], names: (string | null)[], untilMs: number) => void
  onResumed?: (tick: number) => void
  /** Socket dropped mid-match and we are trying to get back in. */
  onReconnecting?: (attempt: number) => void
  onStart?: (seed: number, players: (string | null)[]) => void
  onDesync?: (tick: number) => void
  onForfeit?: (winner: number) => void
  onError?: (message: string) => void
  onClose?: () => void
  onMapDoc?: (json: string) => void // guest: fully reassembled custom map
  onMapAck?: (ok: boolean, slot: number) => void // host: a guest confirmed receipt
  onPlayerLeft?: (slot: number, name: string) => void
  onPick?: (slot: number, pick: SeatPick) => void // host: a guest asked for a race/team
  onSeats?: (seats: SeatPick[]) => void // guest: the seating the host settled on
}

export class WsTransport implements Transport {
  // Public so the game screen can rebind desync/forfeit handlers after start.
  cb: WsCallbacks
  private ws: WebSocket
  // The relay's metronome starts the instant it broadcasts `start`, but the
  // game screen only binds onBundle once the map and asset geometries have
  // loaded — a window a backgrounded tab stretches from a few ms into seconds.
  // Bundles are the sim's only clock (one bundle = one tick, never resynced),
  // so a single one dropped here shifts that client's tick stream permanently
  // and it desyncs at the next hash. Hold them until someone is listening.
  private queued: TickBundle[] = []
  private bundleCb: ((b: TickBundle) => void) | null = null

  get onBundle(): ((b: TickBundle) => void) | null {
    return this.bundleCb
  }

  set onBundle(cb: ((b: TickBundle) => void) | null) {
    this.bundleCb = cb
    if (!cb || this.queued.length === 0) return
    const backlog = this.queued
    this.queued = []
    for (const b of backlog) cb(b)
  }

  // Kept so a dropped socket can be replaced by an identical one. The seat
  // fields are filled in from `joined`: reconnecting means proving which chair
  // was ours, and only the token does that.
  private url: string
  private slot = -1
  private token: string | null = null
  private reconnects = 0
  private closing = false

  /** Reopen the socket, claiming our own seat back. Called on an unexpected
   * close mid-match; harmless if the match is over, since the relay refuses. */
  private reopen(): void {
    if (this.closing || this.token === null) return
    this.reconnects++
    if (this.reconnects > 12) return
    this.cb.onReconnecting?.(this.reconnects)
    const sep = this.url.includes('?') ? '&' : '?'
    const url = `${this.url}${sep}slot=${this.slot}&token=${encodeURIComponent(this.token)}`
    // Back off, but not far: the room is paused and everyone else is waiting.
    setTimeout(() => {
      if (this.closing) return
      this.bind(new WebSocket(url))
    }, Math.min(4000, 400 * this.reconnects))
  }

  constructor(url: string, cb: WsCallbacks) {
    this.cb = cb
    this.url = url
    this.ws = new WebSocket(url)
    this.bind(this.ws)
  }

  private bind(ws: WebSocket): void {
    this.ws = ws
    this.ws.onopen = () => {
      this.reconnects = 0
    }
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg
      switch (msg.t) {
        case 'joined':
          this.slot = msg.slot
          if (msg.token) this.token = msg.token
          this.cb.onJoined?.(msg.slot, msg.players, msg.versions ?? [], {
            token: msg.token,
            resumed: msg.resumed,
          })
          break
        case 'lobby':
          this.cb.onLobby?.(msg.players, msg.versions ?? [])
          break
        case 'start':
          this.cb.onStart?.(msg.seed, msg.players)
          break
        case 'bundle': {
          const b: TickBundle = { tick: msg.tick, cmds: msg.cmds }
          if (this.bundleCb) this.bundleCb(b)
          else this.queued.push(b)
          break
        }
        case 'desync':
          this.cb.onDesync?.(msg.tick)
          break
        case 'forfeit':
          this.cb.onForfeit?.(msg.winner)
          break
        case 'error':
          this.cb.onError?.(msg.message)
          break
        case 'mapBegin':
          this.mapChunks = Array.from({ length: msg.chunks }, () => '')
          this.mapReceived = 0
          break
        case 'mapChunk':
          if (this.mapChunks && msg.i >= 0 && msg.i < this.mapChunks.length && this.mapChunks[msg.i] === '') {
            this.mapChunks[msg.i] = msg.data
            this.mapReceived++
            if (this.mapReceived === this.mapChunks.length) {
              const json = this.mapChunks.join('')
              this.mapChunks = null
              this.send({ t: 'mapAck', ok: true })
              this.cb.onMapDoc?.(json)
            }
          }
          break
        case 'mapAck':
          this.cb.onMapAck?.(msg.ok, msg.slot ?? 1)
          break
        case 'playerLeft':
          this.cb.onPlayerLeft?.(msg.slot, msg.name)
          break
        case 'pick':
          this.cb.onPick?.(msg.slot, msg.pick)
          break
        case 'seats':
          this.cb.onSeats?.(msg.seats)
          break
        case 'catchup':
          this.cb.onCatchup?.(msg.from, msg.to, msg.cmds)
          break
        case 'paused':
          this.cb.onPaused?.(msg.slots, msg.names, msg.untilMs)
          break
        case 'resumed':
          this.cb.onResumed?.(msg.tick)
          break
      }
    }
    this.ws.onclose = () => {
      // Mid-match a close is not the end: the room holds our seat for a while,
      // so try to take it back before telling anyone the match is over.
      if (!this.closing && this.token !== null) {
        this.reopen()
        return
      }
      this.cb.onClose?.()
    }
    this.ws.onerror = () => {
      if (this.closing || this.token === null) this.cb.onError?.('connection error')
    }
  }

  private send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  sendCmd(c: Command): void {
    this.send({ t: 'cmd', c })
  }

  sendHash(tick: number, h: number): void {
    this.send({ t: 'hash', tick, h })
  }

  requestStart(): void {
    this.send({ t: 'startReq' })
  }

  /** Guest: ask the host for a race and a team. */
  sendPick(pick: SeatPick): void {
    this.send({ t: 'pick', pick })
  }

  /** Host: publish the seating everyone is playing. */
  sendSeats(seats: SeatPick[]): void {
    this.send({ t: 'seats', seats })
  }

  /** Rejoin: "I have everything up to `tick` — send me the rest." */
  sendResume(tick: number): void {
    this.send({ t: 'resume', tick })
  }

  /** Rejoin: caught up and level with the room, which may now play on. */
  sendReady(): void {
    this.send({ t: 'ready' })
  }

  /** Stop waiting for a player who is not coming back. */
  sendKick(slot: number): void {
    this.send({ t: 'kick', slot })
  }

  /** The seat we hold, for stashing against a reload. */
  get seat(): { slot: number; token: string | null } {
    return { slot: this.slot, token: this.token }
  }

  private mapChunks: string[] | null = null
  private mapReceived = 0

  // Host: stream a custom map doc to the guest through the relay.
  sendMapDoc(json: string): void {
    const chunks: string[] = []
    for (let i = 0; i < json.length; i += MAP_CHUNK_CHARS) chunks.push(json.slice(i, i + MAP_CHUNK_CHARS))
    this.send({ t: 'mapBegin', chunks: chunks.length, bytes: json.length })
    chunks.forEach((data, i) => this.send({ t: 'mapChunk', i, data }))
  }

  close(): void {
    this.closing = true
    this.ws.onclose = null
    this.ws.close()
  }
}
