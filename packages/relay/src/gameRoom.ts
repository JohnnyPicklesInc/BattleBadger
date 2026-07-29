import { DurableObject } from 'cloudflare:workers'
import { TICK_MS } from '@battlebadger/sim'
import type { ClientMsg, ServerMsg } from '@battlebadger/sim/protocol'
import type { PlayerCommand } from '@battlebadger/sim'

interface Attachment {
  slot: number
  name: string
}

const MAX_PLAYERS = 8

// One room = one match, up to 8 players. The DO is a dumb relay and metronome:
// it never runs the sim, knows nothing about teams, and stamps player slots
// onto commands from the connection (never the payload). It broadcasts a
// TickBundle every TICK_MS and compares client state hashes for desync
// detection across every connected client.
export class GameRoom extends DurableObject {
  private started = false
  private ended = false
  private tick = 0
  private pending: PlayerCommand[] = []
  private hashes = new Map<number, Map<number, number>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private mapBytes = 0

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

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    if (this.started || this.sockets().length >= MAX_PLAYERS) {
      return new Response('room full or match already started', { status: 409 })
    }
    const name = (url.searchParams.get('name') ?? 'Badger').slice(0, 16)
    const taken = new Set(this.sockets().map((w) => this.att(w).slot))
    let slot = 0
    while (taken.has(slot)) slot++

    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({ slot, name } satisfies Attachment)

    const players = this.lobbyPlayers()
    players[slot] = name
    pair[1].send(JSON.stringify({ t: 'joined', slot, players } satisfies ServerMsg))
    this.broadcast({ t: 'lobby', players })

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
    switch (msg.t) {
      case 'startReq': {
        // only the host starts; solo (1-player) matches are allowed
        if (this.started || a.slot !== 0 || this.sockets().length < 1) return
        this.started = true
        const players = this.lobbyPlayers()
          .filter((p): p is string => p !== null)
        const seed = Math.floor(Math.random() * 0xffffffff)
        this.broadcast({ t: 'start', seed, players })
        this.timer = setInterval(() => this.emitBundle(), TICK_MS)
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
    if (this.started && !this.ended) {
      const remaining = this.sockets().filter((s) => s !== ws)
      this.broadcast({ t: 'playerLeft', slot: a.slot, name: a.name })
      // a solo match ending is just the player leaving — nothing to forfeit
      if (remaining.length === 0) {
        this.finish()
      } else if (remaining.length === 1) {
        this.finish()
        this.broadcast({ t: 'forfeit', winner: this.att(remaining[0]).slot })
        for (const s of remaining) {
          try {
            s.close(1000, 'match over')
          } catch {
            // already closed
          }
        }
      }
    } else if (!this.started) {
      this.broadcast({ t: 'lobby', players: this.lobbyPlayers() })
    }
  }

  private emitBundle(): void {
    if (this.ended) return
    const cmds = this.pending
    this.pending = []
    this.broadcast({ t: 'bundle', tick: this.tick++, cmds })
  }

  private finish(): void {
    this.ended = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
