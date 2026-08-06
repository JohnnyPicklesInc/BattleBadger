import type { SimEvent, SimState } from '@battlebadger/sim'

// What crosses the thread boundary, and nothing else.
//
// The client is READ-ONLY against sim state — audited: the only write anywhere
// in packages/client is aiLevel at construction, and that moves into the
// worker's init message. So the main thread does not need the simulation, it
// needs a picture of it, and the picture is small: 39 of SimState's 88 fields
// are ever read by the renderer, the HUD or input.
//
// The trick that keeps this cheap is that the main thread builds its OWN
// SimState with the same setupMatch call and then never steps it. Every object
// in the graph — def, the doodad and projectile stores, the horde store, the
// per-building queues — already exists on both sides and is already the right
// shape. All that has to travel is the numbers that changed.
//
// One buffer per tick, written at fixed offsets and TRANSFERRED rather than
// copied, then handed back for reuse. At four thousand entities that is about
// 400 KB a tick, ten times a second, and none of it lands on the main thread's
// clock: the memcpy happens on the worker.

/** Per-entity arrays the client reads. Order defines the wire layout. */
const ENTITY_F64 = ['posX', 'posZ', 'velX', 'velZ', 'faceX', 'faceZ'] as const
const ENTITY_I32 = [
  'type',
  'owner',
  'hp',
  'target',
  'hordeOf',
  'plotHost',
  'buildTicks',
  'lastAttackTick',
  'swooping',
  'onWall',
  'stun',
  'carryAmt',
  'queueTicks',
] as const
const ENTITY_U8 = ['alive', 'hidden', 'kind', 'gateMode', 'gateOpen'] as const

/** Horde-store arrays the HUD and input read. */
const HORDE_I32 = ['owner', 'defIdx', 'level'] as const

/** Doodad arrays: harvesting depletes them, so they are not static. */
const DOODAD_F64 = ['x', 'z'] as const
const DOODAD_I32 = ['defIdx', 'hp', 'amount', 'occupants'] as const

/** Every shot in flight, so the renderer can draw the arc. */
const PROJ_F64 = ['x', 'z', 'startX', 'startZ', 'tgtX', 'tgtZ', 'speed', 'splash'] as const
const PROJ_I32 = ['damage', 'edgePct', 'owner', 'srcType', 'srcHorde'] as const

/** Per-player arrays. Eight slots, so their size never depends on the battle. */
const PLAYER_I32 = ['playerTeam', 'aiLevel', 'supplyUsed', 'supplyCap'] as const

/**
 * The parts that are not flat numbers. Small — a handful of events a tick, and
 * membership lists only for hordes that exist — so structured clone is the
 * right tool and a hand-rolled encoding would be a lot of code to save nothing.
 */
export interface SimSides {
  tick: number
  count: number
  winner: number
  hordeCount: number
  doodadCount: number
  projCount: number
  events: SimEvent[]
  /** horde index → entity ids, only for live hordes. */
  members: [number, number[]][]
  /** building id → queued def indices, only for non-empty queues. */
  queues: [number, number[]][]
  /** Flat [player * resCount + i], copied whole: it is 8 × a few. */
  resources: number[]
  hordeAlive: number[]
  projAlive: number[]
  doodadAlive: number[]
}

export interface SimPacket {
  sides: SimSides
  buf: ArrayBuffer
}

/** Bytes needed for one snapshot at this population. Fixed layout, so both
 *  sides compute it from the same three counts and never exchange offsets. */
function layout(
  count: number,
  hordeCount: number,
  doodadCount: number,
  projCount: number,
  abStride: number,
): { size: number; at: (i: number) => number } {
  const parts = [
    ENTITY_F64.length * count * 8,
    ENTITY_I32.length * count * 4,
    ENTITY_U8.length * count,
    HORDE_I32.length * hordeCount * 4,
    2 * hordeCount * 8, // horde faceX/faceZ
    DOODAD_F64.length * doodadCount * 8,
    DOODAD_I32.length * doodadCount * 4,
    PROJ_F64.length * projCount * 8,
    PROJ_I32.length * projCount * 4,
    PLAYER_I32.length * 8 * 4,
    count * abStride * 4, // ability cooldowns
  ]
  const offsets: number[] = []
  let off = 0
  for (const p of parts) {
    // Eight-byte alignment throughout: a Float64Array view refuses a misaligned
    // offset, and the alternative is arithmetic that is wrong once and then
    // wrong in a way that looks like a desync.
    off = (off + 7) & ~7
    offsets.push(off)
    off += p
  }
  return { size: off, at: (i) => offsets[i] }
}

/** Write everything the client reads into `buf`. Runs on the worker. */
export function writeSnapshot(s: SimState, abStride: number, buf: ArrayBuffer): SimSides {
  const n = s.count
  const hn = s.hordes.count
  const dn = s.doodads.count
  const pn = s.projectiles.count
  const { at } = layout(n, hn, dn, pn, abStride)

  let k = 0
  const f64 = new Float64Array(buf, at(k), ENTITY_F64.length * n)
  ENTITY_F64.forEach((f, i) => f64.set(s[f].subarray(0, n), i * n))
  k++
  const i32 = new Int32Array(buf, at(k), ENTITY_I32.length * n)
  ENTITY_I32.forEach((f, i) => i32.set(s[f].subarray(0, n), i * n))
  k++
  const u8 = new Uint8Array(buf, at(k), ENTITY_U8.length * n)
  ENTITY_U8.forEach((f, i) => u8.set(s[f].subarray(0, n), i * n))
  k++

  const hi = new Int32Array(buf, at(k), HORDE_I32.length * hn)
  HORDE_I32.forEach((f, i) => hi.set(s.hordes[f].subarray(0, hn), i * hn))
  k++
  const hf = new Float64Array(buf, at(k), 2 * hn)
  hf.set(s.hordes.faceX.subarray(0, hn), 0)
  hf.set(s.hordes.faceZ.subarray(0, hn), hn)
  k++

  const df = new Float64Array(buf, at(k), DOODAD_F64.length * dn)
  DOODAD_F64.forEach((f, i) => df.set(s.doodads[f].subarray(0, dn), i * dn))
  k++
  const di = new Int32Array(buf, at(k), DOODAD_I32.length * dn)
  DOODAD_I32.forEach((f, i) => di.set(s.doodads[f].subarray(0, dn), i * dn))
  k++

  const pf = new Float64Array(buf, at(k), PROJ_F64.length * pn)
  PROJ_F64.forEach((f, i) => pf.set(s.projectiles[f].subarray(0, pn), i * pn))
  k++
  const pi = new Int32Array(buf, at(k), PROJ_I32.length * pn)
  PROJ_I32.forEach((f, i) => pi.set(s.projectiles[f].subarray(0, pn), i * pn))
  k++

  const pl = new Int32Array(buf, at(k), PLAYER_I32.length * 8)
  PLAYER_I32.forEach((f, i) => pl.set(s[f].subarray(0, 8), i * 8))
  k++

  const ab = new Int32Array(buf, at(k), n * abStride)
  ab.set(s.abCd.subarray(0, n * abStride))

  const members: [number, number[]][] = []
  for (let h = 0; h < hn; h++) if (s.hordes.alive[h] === 1) members.push([h, s.hordes.members[h].slice()])
  const queues: [number, number[]][] = []
  for (let i = 0; i < n; i++) if (s.queue[i] && s.queue[i].length > 0) queues.push([i, s.queue[i].slice()])

  return {
    tick: s.tick,
    count: n,
    winner: s.winner,
    hordeCount: hn,
    doodadCount: dn,
    projCount: pn,
    events: s.events.slice(),
    members,
    queues,
    resources: Array.from(s.resources),
    hordeAlive: Array.from(s.hordes.alive.subarray(0, hn)),
    projAlive: Array.from(s.projectiles.alive.subarray(0, pn)),
    doodadAlive: Array.from(s.doodads.alive.subarray(0, dn)),
  }
}

/** How big a buffer this population needs, so the worker can size one. */
export function snapshotBytes(s: SimState, abStride: number): number {
  return layout(s.count, s.hordes.count, s.doodads.count, s.projectiles.count, abStride).size
}

/** Read a snapshot into the main thread's own (never-stepped) SimState. */
export function applySnapshot(s: SimState, abStride: number, packet: SimPacket): void {
  const { sides, buf } = packet
  const n = sides.count
  const hn = sides.hordeCount
  const dn = sides.doodadCount
  const pn = sides.projCount
  const { at } = layout(n, hn, dn, pn, abStride)

  let k = 0
  const f64 = new Float64Array(buf, at(k), ENTITY_F64.length * n)
  ENTITY_F64.forEach((f, i) => s[f].set(f64.subarray(i * n, (i + 1) * n)))
  k++
  const i32 = new Int32Array(buf, at(k), ENTITY_I32.length * n)
  ENTITY_I32.forEach((f, i) => s[f].set(i32.subarray(i * n, (i + 1) * n)))
  k++
  const u8 = new Uint8Array(buf, at(k), ENTITY_U8.length * n)
  ENTITY_U8.forEach((f, i) => s[f].set(u8.subarray(i * n, (i + 1) * n)))
  k++

  const hi = new Int32Array(buf, at(k), HORDE_I32.length * hn)
  HORDE_I32.forEach((f, i) => s.hordes[f].set(hi.subarray(i * hn, (i + 1) * hn)))
  k++
  const hf = new Float64Array(buf, at(k), 2 * hn)
  s.hordes.faceX.set(hf.subarray(0, hn))
  s.hordes.faceZ.set(hf.subarray(hn, 2 * hn))
  k++

  const df = new Float64Array(buf, at(k), DOODAD_F64.length * dn)
  DOODAD_F64.forEach((f, i) => s.doodads[f].set(df.subarray(i * dn, (i + 1) * dn)))
  k++
  const di = new Int32Array(buf, at(k), DOODAD_I32.length * dn)
  DOODAD_I32.forEach((f, i) => s.doodads[f].set(di.subarray(i * dn, (i + 1) * dn)))
  k++

  const pf = new Float64Array(buf, at(k), PROJ_F64.length * pn)
  PROJ_F64.forEach((f, i) => s.projectiles[f].set(pf.subarray(i * pn, (i + 1) * pn)))
  k++
  const pi = new Int32Array(buf, at(k), PROJ_I32.length * pn)
  PROJ_I32.forEach((f, i) => s.projectiles[f].set(pi.subarray(i * pn, (i + 1) * pn)))
  k++

  const pl = new Int32Array(buf, at(k), PLAYER_I32.length * 8)
  PLAYER_I32.forEach((f, i) => s[f].set(pl.subarray(i * 8, (i + 1) * 8)))
  k++

  const ab = new Int32Array(buf, at(k), n * abStride)
  s.abCd.set(ab)

  // Anything that shrank has to be cleared, not left holding last tick's
  // values: `count` is a high-water mark that only ever grows, but a horde or
  // a shell that died leaves a slot behind, and a renderer reading `alive`
  // from two ticks ago draws a corpse.
  s.hordes.alive.fill(0, 0, s.hordes.alive.length)
  for (let h = 0; h < hn; h++) s.hordes.alive[h] = sides.hordeAlive[h]
  s.projectiles.alive.fill(0)
  for (let p = 0; p < pn; p++) s.projectiles.alive[p] = sides.projAlive[p]
  for (let d = 0; d < dn; d++) s.doodads.alive[d] = sides.doodadAlive[d]

  for (const [h, ids] of sides.members) s.hordes.members[h] = ids
  for (let i = 0; i < n; i++) if (s.queue[i]?.length) s.queue[i] = []
  for (const [i, q] of sides.queues) s.queue[i] = q

  s.tick = sides.tick
  s.count = n
  s.winner = sides.winner
  s.hordes.count = hn
  s.doodads.count = dn
  s.projectiles.count = pn
  s.events = sides.events
  s.resources.set(sides.resources)
}
