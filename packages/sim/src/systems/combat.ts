import { attackDamage, takenPct } from './upgrades.ts'
import { Kind, Order, allied, despawn, type SimState } from '../state.ts'
import type { SpatialHash } from '../spatial.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { targetReach } from './orders.ts'
import { addXp, incomingPct, outgoingPct } from './hordes.ts'
import { launchProjectile } from './projectiles.ts'
import { shoveUnit } from './motion.ts'

// Target validation + auto-acquire, driven by the compiled def:
// autoAcquire 1 = nearest enemy; 2 = nearest injured ally (autocast healer).
// Move orders never acquire. Tie-break: lowest id.
export function acquireTargets(s: SimState, hash: SpatialHash): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i]) continue
    const ty = s.type[i]
    const mode = st.autoAcquire[ty]
    const acquire = st.acquire[ty]

    const cur = s.target[i]
    if (cur >= 0) {
      let drop = !s.alive[cur] || s.hidden[cur] === 1
      if (!drop && mode !== 2 && !canHit(s, ty, s.type[cur])) drop = true
      if (!drop && allied(s, s.owner[cur], s.owner[i])) {
        // ally target (heal-style): drop once fully healed
        drop = s.hp[cur] >= st.maxHp[s.type[cur]]
      }
      // A player-ordered attack chases to the ends of the earth; auto-acquired
      // targets are dropped once they outrun the leash (WC3 guard behavior).
      if (!drop && s.forced[i] !== 1) {
        const dx = s.posX[cur] - s.posX[i]
        const dz = s.posZ[cur] - s.posZ[i]
        const leash = Math.max(acquire, 4) * 1.6
        drop = dx * dx + dz * dz > leash * leash
      }
      if (drop) {
        s.target[i] = -1
        s.forced[i] = 0
      }
    }

    if (s.target[i] >= 0) continue
    if (mode === 0 || acquire <= 0) continue
    // Move orders walk past enemies; every other order engages.
    if (s.order[i] === Order.Move) continue

    let best = -1
    let bestDSq = acquire * acquire
    hash.forNeighbors(s.posX[i], s.posZ[i], acquire, (j) => {
      if (!s.alive[j] || j === i || st.untargetable[s.type[j]]) return
      if (mode !== 2 && !canHit(s, ty, s.type[j])) return // wrong layer
      if (mode === 2) {
        if (!allied(s, s.owner[j], s.owner[i]) || s.hp[j] >= st.maxHp[s.type[j]]) return
      } else if (allied(s, s.owner[j], s.owner[i])) return
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      const dSq = dx * dx + dz * dz
      if (dSq < bestDSq || (dSq === bestDSq && (best === -1 || j < best))) {
        best = j
        bestDSq = dSq
      }
    })
    if (best >= 0) {
      s.target[i] = best
      // engaging from a standstill means leaving the post: remember to return
      if (s.order[i] === Order.Idle) s.chased[i] = 1
    }
  }
}

// Damage type vs armor type. Percentages are integers and the result floors,
// but a hit that the table doesn't fully negate always lands for at least 1 —
// otherwise cheap units become literally unkillable by weak weapons.
/**
 * Can `attackerType`'s weapon reach a target on `victimType`'s layer?
 *
 * Shared by acquisition, the combat loop and shell detonation so a unit can
 * never acquire something it then cannot shoot — the classic way anti-air
 * ends up looking broken is a ground army that locks onto a gunship and
 * stands there.
 */
export function canHit(s: SimState, attackerType: number, victimType: number): boolean {
  const need = s.def.stats.flying[victimType] === 1 ? 2 : 1
  return (s.def.stats.hitMask[attackerType] & need) !== 0
}

export function applyDamageTable(s: SimState, attackerType: number, defenderType: number, base: number): number {
  const table = s.def.damageTable
  if (table.length === 0 || base <= 0) return base
  const d = s.def.stats.dmgType[attackerType]
  const a = s.def.stats.armorType[defenderType]
  if (d < 0 || a < 0) return base
  const pct = table[d * s.def.armorTypeCount + a]
  if (pct === 0) return 0
  return Math.max(1, Math.floor((base * pct) / 100))
}

// Only the armor table can make a hit deal nothing (pct 0 = immune); every
// other modifier bottoms out at 1 so cheap attackers stay relevant.
function tableImmune(s: SimState, attackerType: number, defenderType: number): boolean {
  const table = s.def.damageTable
  if (table.length === 0) return false
  const d = s.def.stats.dmgType[attackerType]
  const a = s.def.stats.armorType[defenderType]
  if (d < 0 || a < 0) return false
  return table[d * s.def.armorTypeCount + a] === 0
}


/**
 * Land one blow: armour table, defender veterancy, knockback and kill credit.
 * `pct` scales the attacker-side damage — 100 for the man actually struck,
 * less for anyone merely caught by the sweep.
 */
function smite(
  s: SimState,
  grid: WalkGrid,
  attacker: number,
  victim: number,
  outgoing: number,
  pct: number,
): void {
  const st = s.def.stats
  const ty = s.type[attacker]
  let dmg = Math.floor((outgoing * pct) / 100)
  dmg = applyDamageTable(s, ty, s.type[victim], dmg)
  dmg = Math.floor((dmg * incomingPct(s, victim)) / 100)
  // Researched armour, on the victim's side of the blow.
  dmg = Math.floor((dmg * takenPct(s, victim)) / 100)
  if (dmg < 1 && !tableImmune(s, ty, s.type[victim])) dmg = 1
  const wasAlive = s.hp[victim] > 0
  s.hp[victim] -= dmg
  // A club that throws bodies. The event is what the client watches to launch
  // a corpse, so a killing blow reads as being sent flying.
  const kb = st.atkKnockback[ty]
  if (kb > 0) {
    const dx = s.posX[victim] - s.posX[attacker]
    const dz = s.posZ[victim] - s.posZ[attacker]
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d > 0.0001) {
      shoveUnit(s, grid, victim, dx / d, dz / d, kb)
      if (s.kind[victim] === Kind.Unit && st.atkKnockdown[ty] > 0) {
        s.stun[victim] = Math.max(s.stun[victim], st.atkKnockdown[ty])
      }
      s.events.push({ t: 'trample', x: s.posX[victim], z: s.posZ[victim] })
    }
  }
  // the killing blow feeds the killer's horde (a hero is a horde of one)
  if (wasAlive && s.hp[victim] <= 0) addXp(s, s.hordeOf[attacker], st.xpValue[s.type[victim]])
}

// Cooldowns, range checks, damage and ability effects. Effects land
// immediately in id order; deaths are processed afterward.
export function combat(s: SimState, grid: WalkGrid): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i]) continue
    if (s.cooldown[i] > 0) s.cooldown[i]--
    // Getting back up. Ticked here because this loop already walks every
    // living unit once a tick, ahead of the systems that read it.
    if (s.stun[i] > 0) {
      s.stun[i]--
      continue // flat on your back: no swinging
    }
    const tgt = s.target[i]
    if (tgt < 0 || !s.alive[tgt] || s.hidden[tgt]) continue
    const ty = s.type[i]
    const dx = s.posX[tgt] - s.posX[i]
    const dz = s.posZ[tgt] - s.posZ[i]
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d > targetReach(s, i, tgt) + 0.15 || s.cooldown[i] !== 0) continue

    if (allied(s, s.owner[tgt], s.owner[i])) {
      // ally-target ability (heal-style)
      const abIdx = st.allyAb[ty]
      if (abIdx < 0) continue
      const ab = s.def.abilities[abIdx]
      const max = st.maxHp[s.type[tgt]]
      if (ab.hpDelta > 0 && s.hp[tgt] >= max) continue
      s.hp[tgt] = Math.min(max, s.hp[tgt] + ab.hpDelta)
      s.cooldown[i] = ab.periodTicks
      s.lastAttackTick[i] = s.tick
    } else if (st.damage[ty] > 0 && canHit(s, ty, s.type[tgt])) {
      // Attacker-side scaling happens here for both weapon kinds; the armor
      // matrix and defender scaling are applied on impact for a shell.
      const outgoing = Math.floor((attackDamage(s, i) * outgoingPct(s, i)) / 100)
      if (st.projSpeed[ty] > 0) {
        // A flying shot is aimed at the ground the target occupies RIGHT NOW.
        // It is not steered afterwards, so the target can walk out of it.
        launchProjectile(s, i, s.posX[tgt], s.posZ[tgt], outgoing)
        s.cooldown[i] = st.atkPeriod[ty]
        s.lastAttackTick[i] = s.tick
        continue
      }
      // base → veterancy/formation of the attacker → armor matrix →
      // veterancy/formation of the defender. Fixed order, integer throughout.
      s.cooldown[i] = st.atkPeriod[ty]
      s.lastAttackTick[i] = s.tick

      // Everyone the swing reaches, gathered around the man actually struck.
      // Walked in id order — a direct scan rather than the spatial hash, which
      // was built before this tick's movement and would be slightly stale.
      const splash = st.atkSplash[ty]
      if (splash > 0) {
        const edge = st.atkSplashEdge[ty]
        for (let j = 0; j < s.count; j++) {
          if (j === tgt || j === i) continue
          if (!s.alive[j] || s.hidden[j] || st.untargetable[s.type[j]]) continue
          if (allied(s, s.owner[j], s.owner[i])) continue
          if (!canHit(s, ty, s.type[j])) continue
          const sx = s.posX[j] - s.posX[tgt]
          const sz = s.posZ[j] - s.posZ[tgt]
          const reach = splash + st.radius[s.type[j]]
          const dSq = sx * sx + sz * sz
          if (dSq > reach * reach) continue
          const t = Math.min(1, Math.sqrt(dSq) / splash)
          smite(s, grid, i, j, outgoing, 100 - Math.floor(t * (100 - edge)))
        }
      }
      smite(s, grid, i, tgt, outgoing, 100)
    }
  }
}

// Deaths cascade through build plots: a razed fortress takes its expansion
// slots with it, and a slot takes whatever stands on it. Repeat until settled.
export function deaths(s: SimState, grid: WalkGrid): void {
  for (;;) {
    let died = false
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hp[i] > 0) continue
      const plot = s.plotOf[i]
      if (plot >= 0 && s.alive[plot]) s.plotHost[plot] = -1
      const host = s.plotHost[i]
      if (host >= 0 && s.alive[host]) s.hp[host] = 0
      for (let p = 0; p < s.count; p++) {
        if (s.alive[p] && s.plotParent[p] === i) s.hp[p] = 0
      }
      // buildings free their footprint
      for (const cell of s.entityBlocked[i]) grid.walkable[cell] = 1
      s.entityBlocked[i] = []
      despawn(s, i)
      died = true
    }
    if (!died) break
  }
}

// Data-driven, team-based victory evaluation. A team is "in play" once it has
// had a relevant entity; the last team with survivors wins.
export function victory(s: SimState): void {
  if (s.winner >= 0) return
  const mode = s.def.raw.victory.mode
  if (mode === 'triggersOnly') return
  const buildingsOnly = mode === 'buildingsDestroyed'
  const inPlay = buildingsOnly ? s.hadBuilding : s.teamHadAny
  const aliveCount = new Int32Array(8)
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.def.stats.untargetable[s.type[i]]) continue
    if (buildingsOnly && s.kind[i] !== Kind.Building) continue
    aliveCount[s.playerTeam[s.owner[i]]]++
  }
  let survivors = 0
  let lastTeam = -1
  let anyEliminated = false
  for (let t = 0; t < 8; t++) {
    if (!inPlay[t]) continue
    if (aliveCount[t] > 0) {
      survivors++
      lastTeam = t
    } else {
      anyEliminated = true
    }
  }
  if (anyEliminated && survivors === 1) s.winner = lastTeam
}
