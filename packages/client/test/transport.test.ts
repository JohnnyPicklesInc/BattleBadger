import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TickBundle } from '@battlebadger/sim'
import { WsTransport } from '../src/net/transport.ts'

// The relay starts its metronome the moment it broadcasts `start`, but the
// game screen only binds onBundle after the map and asset geometries have
// loaded. One bundle = one sim tick and the client never resyncs its tick
// counter against the relay, so anything dropped in that window shifts this
// client's stream permanently — a guaranteed desync at the next hash compare.
// A backgrounded tab widens that window from milliseconds into seconds, which
// is why "tabbing out desyncs" was reproducible and a fast machine was not.

class FakeSocket {
  static OPEN = 1
  readyState = 1
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

let socket: FakeSocket
const realWs = globalThis.WebSocket

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = class {
    constructor() {
      socket = new FakeSocket()
      return socket as unknown as WebSocket
    }
    static OPEN = 1
  }
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = realWs
})

const bundle = (tick: number) => ({ t: 'bundle', tick, cmds: [] })

describe('WsTransport bundle buffering', () => {
  it('holds bundles that arrive before the game binds onBundle', () => {
    const t = new WsTransport('wss://x/ws', {})
    socket.deliver(bundle(0))
    socket.deliver(bundle(1))
    socket.deliver(bundle(2))

    const got: TickBundle[] = []
    t.onBundle = (b) => got.push(b)

    expect(got.map((b) => b.tick)).toEqual([0, 1, 2])
  })

  it('delivers live once bound, with no gap against the buffered run', () => {
    const t = new WsTransport('wss://x/ws', {})
    socket.deliver(bundle(0))
    socket.deliver(bundle(1))

    const got: TickBundle[] = []
    t.onBundle = (b) => got.push(b)
    socket.deliver(bundle(2))
    socket.deliver(bundle(3))

    // Contiguous from 0: the game's stepOnce refuses any other sequence.
    expect(got.map((b) => b.tick)).toEqual([0, 1, 2, 3])
  })

  it('buffers again if the handler is unbound', () => {
    const t = new WsTransport('wss://x/ws', {})
    const got: TickBundle[] = []
    t.onBundle = (b) => got.push(b)
    socket.deliver(bundle(0))
    t.onBundle = null
    socket.deliver(bundle(1))
    expect(got.map((b) => b.tick)).toEqual([0])

    t.onBundle = (b) => got.push(b)
    expect(got.map((b) => b.tick)).toEqual([0, 1])
  })
})
