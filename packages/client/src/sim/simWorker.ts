/// <reference lib="webworker" />
import {
  HASH_EVERY_TICKS,
  abStride,
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  type RtsMapDoc,
  type SimState,
  type TickBundle,
  type WalkGrid,
} from '@battlebadger/sim'
import { snapshotBytes, writeSnapshot, type SimPacket } from './snapshot.ts'

// The simulation, on its own thread.
//
// Everything here is the code that used to run inside requestAnimationFrame,
// unchanged — the sim was already a pure function of (state, commands) with no
// DOM dependency, and check-sim-purity.mjs already bans the environment-
// dependent calls (Math.random, Date.now) that would otherwise make a second
// thread behave differently from the first. That is why this is plumbing
// rather than a rewrite.
//
// What it does NOT do is make a tick faster. A fifty-millisecond step still
// takes fifty milliseconds; it just no longer takes them out of the frame the
// renderer owed the screen.

export type ToWorker =
  | { kind: 'init'; doc: RtsMapDoc; playerCount: number; aiLevels: number[] }
  | { kind: 'bundles'; bundles: TickBundle[] }
  | { kind: 'recycle'; buf: ArrayBuffer }
  | { kind: 'stop' }

export type FromWorker =
  | { kind: 'ready' }
  | { kind: 'ticked'; packet: SimPacket; stepMs: number; hash: { tick: number; hash: number } | null }
  | { kind: 'gap'; expected: number; got: number }
  | { kind: 'error'; message: string; tick: number }

const ctx = self as unknown as DedicatedWorkerGlobalScope

let sim: SimState | null = null
let grid: WalkGrid | null = null
let stride = 1
/** Buffers handed back by the main thread, ready to be filled again. Without
 *  this the worker allocates a few hundred kilobytes ten times a second and
 *  the collector pays for it forever. */
const spare: ArrayBuffer[] = []

function bufferOf(bytes: number): ArrayBuffer {
  for (let i = 0; i < spare.length; i++) {
    if (spare[i].byteLength >= bytes) {
      const b = spare.splice(i, 1)[0]
      // A recycled buffer may be larger than this tick needs, which is fine:
      // the layout is computed from the counts, not from the length.
      return b
    }
  }
  // Round up so a battle that grows steadily is not reallocating every tick.
  return new ArrayBuffer(Math.ceil(bytes * 1.25))
}

function publish(stepMs: number, hash: { tick: number; hash: number } | null): void {
  const s = sim!
  const buf = bufferOf(snapshotBytes(s, stride))
  const sides = writeSnapshot(s, stride, buf)
  const msg: FromWorker = { kind: 'ticked', packet: { sides, buf }, stepMs, hash }
  ctx.postMessage(msg, [buf])
}

ctx.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data
  try {
    if (msg.kind === 'init') {
      grid = walkGridFromDoc(msg.doc)
      sim = setupMatch(msg.doc, grid, msg.playerCount)
      msg.aiLevels.forEach((lvl, i) => {
        if (i < 8) sim!.aiLevel[i] = Math.max(0, Math.min(3, lvl | 0))
      })
      stride = abStride(sim.def)
      ctx.postMessage({ kind: 'ready' } as FromWorker)
      publish(0, null)
      return
    }
    if (msg.kind === 'recycle') {
      if (spare.length < 4) spare.push(msg.buf)
      return
    }
    if (msg.kind === 'stop') {
      ctx.close()
      return
    }
    const s = sim
    const g = grid
    if (!s || !g) return

    // The whole backlog in one go. There is no frame to be late for here, so
    // the time budget the main-thread loop needed does not apply — the worker's
    // job is to be as far forward as the bundles allow, and the renderer draws
    // whatever the last published tick was.
    const t0 = performance.now()
    for (const bundle of msg.bundles) {
      if (bundle.tick !== s.tick) {
        ctx.postMessage({ kind: 'gap', expected: s.tick, got: bundle.tick } as FromWorker)
        return
      }
      step(s, g, bundle.cmds)
    }
    const stepMs = performance.now() - t0
    const hash = s.tick % HASH_EVERY_TICKS === 0 ? { tick: s.tick, hash: stateHash(s) } : null
    publish(stepMs, hash)
  } catch (err) {
    ctx.postMessage({
      kind: 'error',
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
      tick: sim?.tick ?? -1,
    } as FromWorker)
  }
}
