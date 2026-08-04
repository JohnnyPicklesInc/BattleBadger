import { allied, type SimState } from '../state.ts'
import type { SpatialHash } from '../spatial.ts'

// Leadership: the standing modifier a hero puts on everything around it.
//
// This is what a hero is FOR. The nuke on its command card is the flourish;
// what makes a captain worth walking into a line with is that the line hits
// harder while he is in it. Nothing else in the engine does this — veterancy is
// per horde, research is per player, and both are positionless.
//
// Recomputed from scratch every tick and never hashed, exactly like the spatial
// hash: it is a pure function of positions, ownership and hp, all of which ARE
// hashed. Two clients that agree on where everyone is standing cannot disagree
// about who is inspired.
//
// Cost is set by the number of aura BEARERS, not by the size of the army: a
// handful of heroes each run one neighbour query, rather than every soldier
// asking who is near it.

/** Nothing may be lifted past this, or dropped below it, however many sources overlap. */
const AURA_MIN = 40
const AURA_MAX = 200

const clamp = (v: number): number => Math.max(AURA_MIN, Math.min(AURA_MAX, v))

export function auras(s: SimState, hash: SpatialHash): void {
  const types = s.def.auraTypes
  const st = s.def.stats
  // Reset. Only touching live slots is not an optimisation worth the bug: a
  // recycled slot would inherit the last occupant's leadership.
  s.auraDamagePct.fill(100, 0, s.count)
  s.auraTakenPct.fill(100, 0, s.count)
  s.auraSpeedPct.fill(100, 0, s.count)
  if (types.length === 0) return

  // Ascending entity id, so overlapping sources multiply in a fixed order.
  // Integer percentages floor at every step, which makes the order observable —
  // and a fixed order is the difference between deterministic and nearly so.
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i]) continue
    const ty = s.type[i]
    const radius = st.auraRadius[ty]
    if (radius <= 0) continue
    // A building still under construction inspires nobody.
    if (s.buildTicks[i] > 0) continue

    const dmg = st.auraDamagePct[ty]
    const taken = st.auraTakenPct[ty]
    const speed = st.auraSpeedPct[ty]
    const foe = st.auraFoe[ty] === 1
    const self = st.auraSelf[ty] === 1
    const owner = s.owner[i]
    const r2 = radius * radius

    hash.forNeighbors(s.posX[i], s.posZ[i], radius, (j) => {
      if (!s.alive[j] || s.hidden[j]) return
      if (j === i && !self) return
      // Dread lands on the enemy; leadership lands on your own.
      if (allied(s, s.owner[j], owner) === foe) return
      // Structures are not inspired and cannot be frightened.
      if (st.isBuilding[s.type[j]] === 1) return
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      if (dx * dx + dz * dz > r2) return
      if (dmg !== 100) s.auraDamagePct[j] = clamp(Math.floor((s.auraDamagePct[j] * dmg) / 100))
      if (taken !== 100) s.auraTakenPct[j] = clamp(Math.floor((s.auraTakenPct[j] * taken) / 100))
      if (speed !== 100) s.auraSpeedPct[j] = clamp(Math.floor((s.auraSpeedPct[j] * speed) / 100))
    })
  }
}
