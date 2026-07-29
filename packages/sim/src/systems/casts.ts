import { Order, abStride, allied, type SimState } from '../state.ts'
import type { SpatialHash } from '../spatial.ts'
import { addXp, incomingPct } from './hordes.ts'

// One-shot ability casts: 'enemy' nukes, 'point' ground casts and 'self'
// bursts. (Sustained 'ally' abilities stay in the combat loop — they ride the
// normal target/reach machinery.)
//
// A cast is pending state on the caster (castAb/castX/castZ/castTarget) so a
// caster that is out of range walks in and fires on arrival, WC3-style, rather
// than the order being silently dropped.
//
// Ability damage deliberately bypasses the damage/armor table: abilities carry
// no damageType, so a nuke hits every armor class alike. Veterancy still
// applies, and integer order is fixed (veterancy → floor → min 1).

// Whom an area cast hits. Authors can override; the default reads intent from
// the sign of hpDelta.
function hits(s: SimState, caster: number, victim: number, abIdx: number): boolean {
  const ab = s.def.abilities[abIdx]
  if (s.def.stats.untargetable[s.type[victim]]) return false
  const affects = ab.affects ?? (ab.hpDelta > 0 ? 'allies' : 'enemies')
  if (affects === 'all') return true
  const ally = allied(s, s.owner[victim], s.owner[caster])
  return affects === 'allies' ? ally : !ally
}

function applyEffect(s: SimState, caster: number, victim: number, abIdx: number): void {
  const ab = s.def.abilities[abIdx]
  const maxHp = s.def.stats.maxHp[s.type[victim]]
  if (ab.hpDelta >= 0) {
    s.hp[victim] = Math.min(maxHp, s.hp[victim] + ab.hpDelta)
    return
  }
  let dmg = Math.floor((-ab.hpDelta * incomingPct(s, victim)) / 100)
  if (dmg < 1) dmg = 1
  const wasAlive = s.hp[victim] > 0
  s.hp[victim] -= dmg
  if (wasAlive && s.hp[victim] <= 0) addXp(s, s.hordeOf[caster], s.def.stats.xpValue[s.type[victim]])
}

// Everything an area cast lands on, ascending by id. Sorting keeps the effect
// order independent of spatial-hash bucket order, which is not id-stable.
function gather(s: SimState, hash: SpatialHash, caster: number, abIdx: number, cx: number, cz: number): number[] {
  const ab = s.def.abilities[abIdx]
  const area = ab.area
  if (!area) return []
  const out: number[] = []
  if (area.shape === 'circle') {
    hash.forNeighbors(cx, cz, area.radius, (j) => {
      if (!s.alive[j] || s.hidden[j] || !hits(s, caster, j, abIdx)) return
      const dx = s.posX[j] - cx
      const dz = s.posZ[j] - cz
      const reach = area.radius + s.def.stats.radius[s.type[j]]
      if (dx * dx + dz * dz <= reach * reach) out.push(j)
    })
  } else {
    // Cone: opens at the caster, aimed at the cast point. The half-angle test
    // is a dot product against the authored cosine — no trig, so it is
    // bit-identical everywhere (see AbilityDef.area).
    const ax = s.posX[caster]
    const az = s.posZ[caster]
    let dirX = cx - ax
    let dirZ = cz - az
    const dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ)
    if (dirLen < 1e-9) return []
    dirX /= dirLen
    dirZ /= dirLen
    hash.forNeighbors(ax, az, area.radius, (j) => {
      if (j === caster || !s.alive[j] || s.hidden[j] || !hits(s, caster, j, abIdx)) return
      const vx = s.posX[j] - ax
      const vz = s.posZ[j] - az
      const dist = Math.sqrt(vx * vx + vz * vz)
      if (dist > area.radius + s.def.stats.radius[s.type[j]]) return
      // a victim standing on the caster has no direction — always inside
      if (dist < 1e-9) {
        out.push(j)
        return
      }
      if (vx * dirX + vz * dirZ >= area.halfAngleCos * dist) out.push(j)
    })
  }
  out.sort((a, b) => a - b)
  return out
}

export function casts(s: SimState, hash: SpatialHash): void {
  const nAb = abStride(s.def)
  // every ability cooldown ticks down, whether or not a cast is pending
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i]) continue
    for (let a = 0; a < s.def.abilities.length; a++) {
      const k = i * nAb + a
      if (s.abCd[k] > 0) s.abCd[k]--
    }
  }

  for (let i = 0; i < s.count; i++) {
    const abIdx = s.castAb[i]
    if (abIdx < 0) continue
    const ab = s.def.abilities[abIdx]
    if (!s.alive[i] || s.hidden[i] || !ab || s.stun[i] > 0) {
      s.castAb[i] = -1
      s.castTarget[i] = -1
      continue
    }
    // Cooling down (a second cast queued behind the first): drop it rather
    // than let it fire late and surprise the player.
    if (s.abCd[i * nAb + abIdx] > 0) {
      s.castAb[i] = -1
      s.castTarget[i] = -1
      continue
    }

    // Where the cast lands, and how far the caster must be from it.
    let cx = s.castX[i]
    let cz = s.castZ[i]
    const tgt = s.castTarget[i]
    if (ab.target === 'self') {
      cx = s.posX[i]
      cz = s.posZ[i]
    } else if (tgt >= 0) {
      if (!s.alive[tgt] || s.hidden[tgt]) {
        s.castAb[i] = -1
        s.castTarget[i] = -1
        continue
      }
      cx = s.posX[tgt]
      cz = s.posZ[tgt]
    }

    const dx = cx - s.posX[i]
    const dz = cz - s.posZ[i]
    const dist = Math.sqrt(dx * dx + dz * dz)
    let reach = ab.range + s.def.stats.radius[s.type[i]]
    if (tgt >= 0) reach += s.def.stats.radius[s.type[tgt]]
    if (dist > reach + 0.15) {
      // out of range: walk in and try again next tick
      if (s.kind[i] !== 0) {
        s.castAb[i] = -1
        s.castTarget[i] = -1
        continue
      }
      s.order[i] = Order.Move
      s.destX[i] = cx
      s.destZ[i] = cz
      continue
    }

    if (ab.area) {
      for (const j of gather(s, hash, i, abIdx, cx, cz)) applyEffect(s, i, j, abIdx)
    } else if (tgt >= 0) {
      applyEffect(s, i, tgt, abIdx)
    } else if (ab.target === 'self') {
      applyEffect(s, i, i, abIdx)
    }

    s.abCd[i * nAb + abIdx] = ab.periodTicks
    s.lastAttackTick[i] = s.tick // drives the client's cast/swing animation
    s.castAb[i] = -1
    s.castTarget[i] = -1
    // face the cast so the animation reads
    if (dist > 1e-9) {
      s.faceX[i] = dx / dist
      s.faceZ[i] = dz / dist
    }
  }
}
