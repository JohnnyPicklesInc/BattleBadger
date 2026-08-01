import { abStride, type SimState } from './state.ts'
import type { RtsMapDoc } from './mapdoc.ts'

// FNV-1a over 32-bit ints. Integer ops only — bit-identical everywhere.
export function fnv1aInit(): number {
  return 0x811c9dc5 | 0
}

export function fnv1aInt(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), 16777619)
  h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619)
  h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619)
  h = Math.imul(h ^ ((v >>> 24) & 0xff), 16777619)
  return h | 0
}

export function fnv1aStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = fnv1aInt(h, s.charCodeAt(i))
  return h
}

// Type tags, so [1,2] and {"a":1} can never collide into the same digest.
const TAG_NULL = 0x4e
const TAG_NUM = 0x23
const TAG_BOOL = 0x42
const TAG_STR = 0x53
const TAG_ARR = 0x5b
const TAG_OBJ = 0x7b

// Canonical fold: object keys sorted, undefined dropped. JSON.stringify's key
// order follows insertion order, so a doc built by a generator and the same doc
// round-tripped through a baked file would otherwise digest differently.
function foldValue(h: number, v: unknown): number {
  if (v === null || v === undefined) return fnv1aInt(h, TAG_NULL)
  if (typeof v === 'number') return fnv1aStr(fnv1aInt(h, TAG_NUM), String(v))
  if (typeof v === 'boolean') return fnv1aInt(fnv1aInt(h, TAG_BOOL), v ? 1 : 0)
  if (typeof v === 'string') return fnv1aStr(fnv1aInt(h, TAG_STR), v)
  if (Array.isArray(v)) {
    h = fnv1aInt(fnv1aInt(h, TAG_ARR), v.length)
    for (const item of v) h = foldValue(h, item)
    return h
  }
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  h = fnv1aInt(fnv1aInt(h, TAG_OBJ), keys.length)
  for (const k of keys) {
    h = fnv1aStr(fnv1aInt(h, TAG_STR), k)
    h = foldValue(h, obj[k])
  }
  return h
}

// A map's identity: a digest of everything that determines what the map IS —
// terrain, doodads, pre-placed entities, regions, triggers and the inline
// GameDef. This, not the filename, is what two clients must agree on; it is
// folded into stateHash so a stale bake or an edited map desyncs at tick 0
// with an obvious cause instead of drifting into a mystery.
//
// Computed from the doc rather than stored on it, so it can never go stale.
export function mapContentHash(doc: RtsMapDoc): number {
  return foldValue(fnv1aInit(), doc) >>> 0
}

const quant = (v: number): number => Math.floor(v * 256) | 0

// Canonical state fingerprint used for desync detection. Includes defHash so
// a GameDef/map mismatch desyncs at tick 0 instead of drifting.
export function stateHash(s: SimState): number {
  let h = fnv1aInit()
  h = fnv1aInt(h, s.def.defHash | 0)
  h = fnv1aInt(h, s.mapHash | 0)
  h = fnv1aInt(h, s.tick)
  h = fnv1aInt(h, s.rng.a)
  h = fnv1aInt(h, s.rng.b)
  h = fnv1aInt(h, s.rng.c)
  h = fnv1aInt(h, s.rng.d)
  h = fnv1aInt(h, s.winner)
  h = fnv1aInt(h, s.playerCount)
  for (let p = 0; p < 8; p++) h = fnv1aInt(h, s.playerTeam[p] | (s.aiLevel[p] << 8))
  // Research changes what every unit a player owns does, so two clients
  // disagreeing about it would diverge in damage rather than loudly.
  for (let i = 0; i < s.upgradeOwned.length; i++) h = fnv1aInt(h, s.upgradeOwned[i])
  const numRes = s.def.resources.length
  for (let p = 0; p < 2; p++) {
    for (let r = 0; r < numRes; r++) h = fnv1aInt(h, s.resources[p * numRes + r])
  }
  for (let i = 0; i < s.count; i++) {
    h = fnv1aInt(h, s.alive[i] | (s.gen[i] << 1))
    if (!s.alive[i]) continue
    h = fnv1aInt(h, quant(s.posX[i]))
    h = fnv1aInt(h, quant(s.posZ[i]))
    h = fnv1aInt(h, s.hp[i])
    h = fnv1aInt(h, s.order[i] | (s.kind[i] << 4) | (s.hidden[i] << 8) | (s.harvState[i] << 9))
    // A gate is player-controlled and changes walkability, so two clients
    // disagreeing about one would diverge in pathing rather than loudly.
    h = fnv1aInt(h, s.gateOpen[i] | (s.gateMode[i] << 1))
    // A diving flyer is a ground target, so this decides who can reach it.
    h = fnv1aInt(h, s.swooping[i])
    h = fnv1aInt(h, s.target[i] | (s.forced[i] << 24) | (s.chased[i] << 25))
    h = fnv1aInt(h, s.followTarget[i])
    h = fnv1aInt(h, quant(s.homeX[i]))
    h = fnv1aInt(h, quant(s.homeZ[i]))
    h = fnv1aInt(h, quant(s.destX[i]))
    h = fnv1aInt(h, quant(s.destZ[i]))
    h = fnv1aInt(h, s.cooldown[i] | (s.chargeCd[i] << 16))
    h = fnv1aInt(h, s.chargeRun[i] | (s.stun[i] << 16))
    h = fnv1aInt(h, s.castAb[i] | (s.castTarget[i] << 8))
    if (s.castAb[i] >= 0) {
      h = fnv1aInt(h, quant(s.castX[i]))
      h = fnv1aInt(h, quant(s.castZ[i]))
    }
    const nAb = abStride(s.def)
    for (let a = 0; a < s.def.abilities.length; a++) h = fnv1aInt(h, s.abCd[i * nAb + a])
    h = fnv1aInt(h, s.carryAmt[i] | ((s.carryRes[i] & 0xff) << 20))
    h = fnv1aInt(h, s.buildTicks[i] | (s.queueTicks[i] << 16))
    h = fnv1aInt(h, s.plotHost[i])
    h = fnv1aInt(h, s.plotOf[i] | (s.plotParent[i] << 12))
    h = fnv1aInt(h, s.hordeOf[i])
    if (s.queue[i].length > 0) {
      for (const q of s.queue[i]) h = fnv1aInt(h, q + 1)
      h = fnv1aInt(h, quant(s.rallyX[i]))
      h = fnv1aInt(h, quant(s.rallyZ[i]))
    }
  }
  for (let p = 0; p < 2; p++) {
    h = fnv1aInt(h, s.supplyUsed[p] | (s.supplyCap[p] << 12))
    h = fnv1aInt(h, s.powerUsed[p] | (s.powerProvided[p] << 12))
  }
  const trig = s.trig
  for (let t = 0; t < trig.defs.length; t++) {
    h = fnv1aInt(h, trig.enabled[t] | (trig.armed[t] << 1) | (trig.fired[t] << 2))
    h = fnv1aInt(h, trig.timerNext[t])
  }
  if (trig.regions.length > 0) {
    for (let i = 0; i < s.count; i++) h = fnv1aInt(h, trig.prevRegionMask[i])
  }
  const hd = s.hordes
  for (let i = 0; i < hd.count; i++) {
    h = fnv1aInt(h, hd.alive[i] | (hd.formation[i] << 1) | (hd.level[i] << 8))
    if (!hd.alive[i]) continue
    h = fnv1aInt(h, hd.xp[i])
    h = fnv1aInt(h, hd.owner[i] | (hd.defIdx[i] << 4) | (hd.members[i].length << 12))
    h = fnv1aInt(h, quant(hd.faceX[i]))
    h = fnv1aInt(h, quant(hd.faceZ[i]))
  }
  const pr = s.projectiles
  for (let k = 0; k < pr.count; k++) {
    h = fnv1aInt(h, pr.alive[k])
    if (!pr.alive[k]) continue
    h = fnv1aInt(h, quant(pr.x[k]))
    h = fnv1aInt(h, quant(pr.z[k]))
    h = fnv1aInt(h, quant(pr.tgtX[k]))
    h = fnv1aInt(h, quant(pr.tgtZ[k]))
    h = fnv1aInt(h, pr.damage[k] | (pr.owner[k] << 24))
  }
  const d = s.doodads
  for (let n = 0; n < d.count; n++) {
    h = fnv1aInt(h, d.alive[n] | (d.occupants[n] << 1))
    if (!d.alive[n]) continue
    h = fnv1aInt(h, d.hp[n])
    h = fnv1aInt(h, d.amount[n])
  }
  return h >>> 0
}
