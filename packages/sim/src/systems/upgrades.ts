import type { SimState } from '../state.ts'
import { rampartRangeBonus } from './ramparts.ts'

// Upgrades: bought once, owned for the match, and felt by every unit the buyer
// already has as well as every one they train afterwards.
//
// The compiled stat tables are per entity TYPE, and an upgrade is per PLAYER —
// two armies of swordsmen have to be able to hit differently. So nothing here
// edits those tables. Instead each player carries a row of integer percentages
// indexed by type, rebuilt when research completes, and the handful of places
// that actually read a stat multiply through it.
//
// Integer percent throughout, like the formation stances, so a long match
// cannot drift between two clients.

/** Whether `player` has finished `upIdx`. */
export function hasUpgrade(s: SimState, player: number, upIdx: number): boolean {
  const n = s.def.upgrades.length
  if (upIdx < 0 || upIdx >= n) return false
  return s.upgradeOwned[player * n + upIdx] === 1
}

/**
 * Recompute one player's multiplier rows from the upgrades they own.
 *
 * Effects stack multiplicatively rather than by addition, so two +25% blades
 * are +56% and not +50% — and, more usefully, three -25% armour upgrades can
 * never add up to taking no damage at all.
 */
export function refreshUpgrades(s: SimState, player: number): void {
  const types = s.def.entities.length
  const base = player * types
  for (let t = 0; t < types; t++) {
    s.upgDamagePct[base + t] = 100
    s.upgTakenPct[base + t] = 100
    s.upgRangePct[base + t] = 100
    s.upgSpeedPct[base + t] = 100
  }
  const n = s.def.upgrades.length
  for (let u = 0; u < n; u++) {
    if (s.upgradeOwned[player * n + u] !== 1) continue
    const def = s.def.upgrades[u]
    for (const t of s.def.upgradeApplies[u]) {
      if (def.damagePct) s.upgDamagePct[base + t] = scale(s.upgDamagePct[base + t], 100 + def.damagePct)
      if (def.armorPct) s.upgTakenPct[base + t] = scale(s.upgTakenPct[base + t], 100 - def.armorPct)
      if (def.rangePct) s.upgRangePct[base + t] = scale(s.upgRangePct[base + t], 100 + def.rangePct)
      if (def.speedPct) s.upgSpeedPct[base + t] = scale(s.upgSpeedPct[base + t], 100 + def.speedPct)
    }
  }
}

// Compose two integer percentages. Floors, and never below 1% — an upgrade
// stack that reduced a stat to zero would be a divide-by-nothing somewhere.
function scale(a: number, b: number): number {
  return Math.max(1, Math.floor((a * b) / 100))
}

/** Grant a finished upgrade. Idempotent. */
export function grantUpgrade(s: SimState, player: number, upIdx: number): void {
  const n = s.def.upgrades.length
  if (upIdx < 0 || upIdx >= n) return
  if (s.upgradeOwned[player * n + upIdx] === 1) return
  s.upgradeOwned[player * n + upIdx] = 1
  refreshUpgrades(s, player)
  s.events.push({ t: 'upgradeDone', player, upgrade: upIdx })
}

/**
 * Whether the owner holds every building an upgrade needs. Same rule as
 * `requires` on a building: alive and finished, not merely paid for.
 */
export function upgradeRequiresMet(s: SimState, player: number, upIdx: number): boolean {
  const need = s.def.upgradeRequires[upIdx]
  if (need.length === 0) return true
  for (const t of need) {
    let found = false
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === player && s.type[i] === t && s.buildTicks[i] === 0) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/** Already owned, or already on a queue somewhere. */
export function upgradeInProgress(s: SimState, player: number, upIdx: number): boolean {
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.owner[i] !== player) continue
    for (const q of s.queue[i]) if (q < 0 && -1 - q === upIdx) return true
  }
  return false
}

// ---- how the rest of the sim reads a stat -------------------------------

export function attackDamage(s: SimState, id: number): number {
  const t = s.type[id]
  return Math.floor((s.def.stats.damage[t] * s.upgDamagePct[s.owner[id] * s.def.entities.length + t]) / 100)
}

export function attackRange(s: SimState, id: number): number {
  const t = s.type[id]
  const base = (s.def.stats.atkRange[t] * s.upgRangePct[s.owner[id] * s.def.entities.length + t]) / 100
  // Height. Added after the percentage rather than scaled by it: the wall is
  // the same height whatever the archer has been drilled in.
  return base + rampartRangeBonus(s, id)
}

/** Percentage of incoming damage this entity takes, from its owner's armour. */
export function takenPct(s: SimState, id: number): number {
  return s.upgTakenPct[s.owner[id] * s.def.entities.length + s.type[id]]
}

export function speedPct(s: SimState, id: number): number {
  return s.upgSpeedPct[s.owner[id] * s.def.entities.length + s.type[id]]
}
