import { Kind, TICK_S, allied, type SimState } from '../state.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { applyDamageTable } from './combat.ts'
import { addXp, crushableOf, incomingPct, outgoingPct } from './hordes.ts'
import { shoveUnit } from './motion.ts'

// Cavalry impact — riding somebody down rather than swinging at them.
//
// This is deliberately NOT the attack loop. A charge is delivered by momentum:
// the rider must actually be travelling at `minSpeed`, must be moving TOWARD
// the victim, and must physically reach it. It ignores weapon reach and the
// attack cooldown, and it cannot be delivered from a standstill — a stopped
// horse is just a slow swordsman. After connecting, the rider winds down for
// `cooldownTicks`, so a lancer has to pull out, turn and build speed again
// instead of grinding a formation down on the spot.
//
// Runs after integration so it reads the positions units actually reached this
// tick, and before deaths() so anything ridden down is cleaned up on schedule.

/** Ticks at charge speed needed before an impact counts as a charge. */
const RUN_UP_TICKS = 4

export function charges(s: SimState, grid: WalkGrid): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || s.kind[i] !== Kind.Unit) continue
    if (s.stun[i] > 0) {
      s.chargeRun[i] = 0 // knocked down: momentum is gone
      continue
    }
    if (s.chargeCd[i] > 0) {
      s.chargeCd[i]--
      s.chargeRun[i] = 0
      continue
    }
    const ty = s.type[i]
    const minSpeed = st.chgMinSpeed[ty]
    if (minSpeed <= 0) continue

    // velX/velZ hold this tick's displacement, so speed is per-second again
    const vx = s.velX[i]
    const vz = s.velZ[i]
    const stepLen = Math.sqrt(vx * vx + vz * vz)

    // Momentum is lost by STOPPING, not by slowing. Movement clamps the last
    // step to the distance remaining, so a rider always decelerates over the
    // final tick or two before contact; gating the impact on current speed
    // meant the run-up was wiped exactly as the horse arrived and whether a
    // charge landed came down to tick alignment.
    if (stepLen < 1e-6) {
      s.chargeRun[i] = 0
      continue
    }
    if (s.chargeRun[i] < RUN_UP_TICKS) {
      // still building speed — only fast ticks count toward the run-up
      if (stepLen / TICK_S >= minSpeed) s.chargeRun[i]++
      continue
    }
    const dirX = vx / stepLen
    const dirZ = vz / stepLen

    // Whatever is physically in front matters, crushable or not: a horse
    // that runs into a spear wall does not politely look past it for a softer
    // target standing behind. Nearest colliding enemy wins, lowest id on ties.
    let victim = -1
    let bestDSq = Infinity
    const ri = st.radius[ty]
    const crusher = st.crusherLevel[ty]
    for (let j = 0; j < s.count; j++) {
      if (j === i || !s.alive[j] || s.hidden[j]) continue
      if (st.untargetable[s.type[j]]) continue
      if (st.flying[s.type[j]] === 1) continue // you cannot ride down a flyer
      if (allied(s, s.owner[j], s.owner[i])) continue
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      const dSq = dx * dx + dz * dz
      const reach = ri + st.radius[s.type[j]] + 0.2
      if (dSq > reach * reach) continue
      // must be riding INTO them, not merely passing by or breaking off
      if (dx * dirX + dz * dirZ <= 0) continue
      if (dSq < bestDSq) {
        bestDSq = dSq
        victim = j
      }
    }
    if (victim < 0) continue

    // Refused: the thing in front is too heavy to bowl over — braced pikes,
    // another horse, a siege engine. The charge is spent either way, and the
    // rider takes the impact it meant to deliver.
    if (crusher <= crushableOf(s, victim)) {
      const recoil = Math.floor((st.chgDamage[ty] * st.chgRecoilPct[ty]) / 100)
      if (recoil > 0) {
        let self = Math.floor((recoil * incomingPct(s, i)) / 100)
        if (self < 1) self = 1
        s.hp[i] -= self
      }
      s.chargeCd[i] = st.chgCooldown[ty]
      s.chargeRun[i] = 0
      s.events.push({ t: 'trample', x: s.posX[i], z: s.posZ[i] })
      continue
    }

    // Momentum damage: the charge value replaces the weapon's, then takes the
    // usual attacker → armour table → defender chain so the trample multiplier
    // in the damage matrix still applies.
    let dmg = Math.floor((st.chgDamage[ty] * outgoingPct(s, i)) / 100)
    dmg = applyDamageTable(s, ty, s.type[victim], dmg)
    dmg = Math.floor((dmg * incomingPct(s, victim)) / 100)
    if (dmg < 1) dmg = 1
    const wasAlive = s.hp[victim] > 0
    s.hp[victim] -= dmg
    if (wasAlive && s.hp[victim] <= 0) addXp(s, s.hordeOf[i], st.xpValue[s.type[victim]])

    // The spear the horse ran onto. Applies even though the charge connected:
    // riding down a pikeman is supposed to cost something, or cavalry simply
    // farms loose spearmen with no answer.
    const guard = st.chargeGuard[s.type[victim]]
    if (guard > 0) {
      let back = Math.floor((guard * incomingPct(s, i)) / 100)
      if (back < 1) back = 1
      s.hp[i] -= back
    }

    shoveUnit(s, grid, victim, dirX, dirZ, st.chgKnockback[ty])
    if (s.kind[victim] === Kind.Unit && st.chgKnockdown[ty] > 0) {
      s.stun[victim] = Math.max(s.stun[victim], st.chgKnockdown[ty])
    }
    s.chargeCd[i] = st.chgCooldown[ty]
    s.chargeRun[i] = 0
    s.lastAttackTick[i] = s.tick // the client's impact animation
    s.events.push({ t: 'trample', x: s.posX[victim], z: s.posZ[victim] })
  }
}
