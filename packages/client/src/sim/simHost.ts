import type { RtsMapDoc, SimState, TickBundle } from '@battlebadger/sim'
import { abStride } from '@battlebadger/sim'
import { applySnapshot } from './snapshot.ts'
import type { FromWorker, ToWorker } from './simWorker.ts'

// The main thread's end of the sim worker.
//
// It owns a SimState it NEVER steps. Everything the renderer, the HUD and input
// already do — reading posX, walking hordes.members, drawing projectiles — goes
// on working unchanged against that object; the host just refills it from the
// worker's snapshot once per tick. That is the whole reason this is a contained
// change rather than a rewrite of the client.
//
// One message in flight at a time. That is backpressure, not politeness: while
// the worker is chewing, bundles pile up in `queue`, the existing watchdog in
// Game sees the queue climbing and says "this machine cannot simulate as fast
// as the match runs" — which is exactly what is true, and exactly what it said
// before, except now the picture keeps moving while it is true.

/** Bundles handed over at once. Small enough that a catch-up still repaints
 *  its progress bar, large enough that replaying twenty minutes is not twelve
 *  thousand round trips. */
const CHUNK = 40

export interface SimHostEvents {
  /** A tick (or a run of them) landed and `view` now describes it. */
  onTick: (stepMs: number) => void
  /** Periodic desync check, forwarded to the relay. */
  onHash: (tick: number, hash: number) => void
  /** The bundle stream skipped: the same fatal the in-thread path reports. */
  onGap: (expected: number, got: number) => void
  /** The sim threw. There is no recovering a lockstep sim mid-tick. */
  onError: (message: string, tick: number) => void
}

export class SimHost {
  /** The picture of the simulation. Read it; never write it. */
  readonly view: SimState
  private worker: Worker
  private queue: TickBundle[] = []
  private busy = false
  private stride: number
  private stopped = false
  /** Set once the worker has built its own sim and sent the opening state. */
  ready = false

  /** Last tick's positions, for the renderer to interpolate from. Taken here
   *  because they have to be copied BEFORE the snapshot lands on top of the
   *  current ones — the in-thread path takes them just before `step`, and
   *  getting this backwards makes every unit on screen judder without ever
   *  failing a test. */
  private prevX: Float64Array
  private prevZ: Float64Array
  private ev: SimHostEvents

  constructor(
    view: SimState,
    doc: RtsMapDoc,
    playerCount: number,
    aiLevels: number[],
    prevX: Float64Array,
    prevZ: Float64Array,
    ev: SimHostEvents,
  ) {
    this.view = view
    this.prevX = prevX
    this.prevZ = prevZ
    this.ev = ev
    this.stride = abStride(view.def)
    this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data)
    this.worker.onerror = (e) => this.ev.onError(`worker failed to start: ${e.message}`, -1)
    this.post({ kind: 'init', doc, playerCount, aiLevels })
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    if (!this.stopped) this.worker.postMessage(msg, transfer)
  }

  private onMessage(msg: FromWorker): void {
    if (this.stopped) return
    if (msg.kind === 'ready') {
      this.ready = true
      return
    }
    if (msg.kind === 'gap') {
      this.ev.onGap(msg.expected, msg.got)
      return
    }
    if (msg.kind === 'error') {
      this.ev.onError(msg.message, msg.tick)
      return
    }
    this.prevX.set(this.view.posX)
    this.prevZ.set(this.view.posZ)
    applySnapshot(this.view, this.stride, msg.packet)
    // Straight back for reuse: the worker fills it again next tick rather than
    // allocating, and neither side ever holds two.
    this.post({ kind: 'recycle', buf: msg.packet.buf }, [msg.packet.buf])
    this.busy = false
    if (msg.hash) this.ev.onHash(msg.hash.tick, msg.hash.hash)
    this.ev.onTick(msg.stepMs)
    this.pump()
  }

  /** How many ticks are waiting to be simulated. The watchdog's number. */
  get backlog(): number {
    return this.queue.length
  }

  push(bundle: TickBundle): void {
    this.queue.push(bundle)
    this.pump()
  }

  pushAll(bundles: TickBundle[]): void {
    for (const b of bundles) this.queue.push(b)
    this.pump()
  }

  private pump(): void {
    if (this.busy || this.stopped || this.queue.length === 0) return
    const bundles = this.queue.splice(0, CHUNK)
    this.busy = true
    this.post({ kind: 'bundles', bundles })
  }

  /** Hand back everything not yet simulated, so the in-thread path can take
   *  over if the worker never started. */
  drain(): TickBundle[] {
    const q = this.queue
    this.queue = []
    return q
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.post({ kind: 'stop' })
    this.worker.terminate()
  }
}

/**
 * Whether to run the sim off-thread. On by default; `?worker=0` puts it back on
 * the main thread, which is the only way to compare the two on one machine and
 * the first thing to try if the client misbehaves.
 */
export function wantsWorker(): boolean {
  try {
    if (typeof Worker === 'undefined') return false
    const v = new URLSearchParams(location.search).get('worker')
    return v !== '0' && v !== 'off' && v !== 'false'
  } catch {
    return false
  }
}
