import { Kind, type SimState } from '../state.ts'
import type { SpatialHash } from '../spatial.ts'
import type { WalkGrid } from '../path/walkgrid.ts'

const SEP_PAD = 0.25

/**
 * Shove a unit away from a point, stopping at the last walkable spot.
 * Deterministic: fixed candidate fractions, no search. Buildings are rooted.
 *
 * Lives here rather than in charge.ts because both a cavalry impact and an
 * ogre's club use it, and combat.ts cannot import from charge.ts without a
 * cycle (charge already depends on combat for the damage table).
 */
// Flyers cannot be shoved by anything on the ground.
export function shoveUnit(
  s: SimState,
  grid: WalkGrid,
  victim: number,
  dirX: number,
  dirZ: number,
  dist: number,
): void {
  if (dist <= 0 || s.kind[victim] !== Kind.Unit) return
  if (s.def.stats.flying[s.type[victim]]) return
  const x0 = s.posX[victim]
  const z0 = s.posZ[victim]
  for (const frac of [1, 0.6, 0.3]) {
    const nx = x0 + dirX * dist * frac
    const nz = z0 + dirZ * dist * frac
    if (grid.isWalkableWorld(nx, nz)) {
      s.posX[victim] = nx
      s.posZ[victim] = nz
      return
    }
  }
  // pinned against terrain: it takes the hit but does not move
}

// Separation steering: units push away from close neighbors. Applied to
// velocity before integration; capped so it can't dominate the order.
// Buildings never move; units are pushed away from them instead.
export function separation(s: SimState, hash: SpatialHash): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
      if (s.onWall[i] >= 0) continue
    if (!s.alive[i] || s.kind[i] !== Kind.Unit || s.hidden[i]) continue
    const ri = st.radius[s.type[i]]
    const moving = s.velX[i] !== 0 || s.velZ[i] !== 0
    let pushX = 0
    let pushZ = 0
    const airI = st.flying[s.type[i]]
    hash.forNeighbors(s.posX[i], s.posZ[i], ri + 1.2, (j) => {
      if (j === i || !s.alive[j] || st.untargetable[s.type[j]]) return
      // different layers: a gunship and a footman occupy the same ground plane
      // in the sim but not in the world, so they slide past each other
      if (st.flying[s.type[j]] !== airI) return
      const dx = s.posX[i] - s.posX[j]
      const dz = s.posZ[i] - s.posZ[j]
      const dSq = dx * dx + dz * dz
      const minD = ri + st.radius[s.type[j]] + SEP_PAD
      if (dSq >= minD * minD || dSq < 0.000001) return
      const d = Math.sqrt(dSq)
      const w = (minD - d) / minD
      pushX += (dx / d) * w
      pushZ += (dz / d) * w
    })
    if (pushX !== 0 || pushZ !== 0) {
      const cap = st.speed[s.type[i]] * 0.1 * (moving ? 0.6 : 0.35)
      const m = Math.sqrt(pushX * pushX + pushZ * pushZ)
      const k = Math.min(cap, m * cap) / m
      s.velX[i] += pushX * k
      s.velZ[i] += pushZ * k
    }
  }
}

// Integrate velocities with per-axis walkability clamp (slide along walls).
export function integrate(s: SimState, grid: WalkGrid): void {
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Unit || s.hidden[i]) continue
    // A man on a wall holds his slot: he does not walk, and nothing on the
    // ground jostles him off it.
    if (s.onWall[i] >= 0) continue
    const x0 = s.posX[i]
    const z0 = s.posZ[i]
    let nx = x0 + s.velX[i]
    let nz = z0 + s.velZ[i]
    // A flyer is over the terrain, not on it: no walkability clamp at all.
    if (!s.def.stats.flying[s.type[i]] && !grid.isWalkableWorld(nx, nz)) {
      if (grid.isWalkableWorld(nx, z0)) {
        nz = z0
      } else if (grid.isWalkableWorld(x0, nz)) {
        nx = x0
      } else {
        nx = x0
        nz = z0
      }
    }
    s.posX[i] = nx
    s.posZ[i] = nz
    // Face along actual movement when meaningfully moving without a target.
    if (s.target[i] < 0) {
      const mx = nx - x0
      const mz = nz - z0
      const m = Math.sqrt(mx * mx + mz * mz)
      if (m > 0.005) {
        s.faceX[i] = mx / m
        s.faceZ[i] = mz / m
      }
    }
  }
}

// One pairwise push-out relaxation pass, then re-clamp to walkable ground.
// Buildings are immovable: overlapping units take the full push instead.
export function resolveOverlaps(s: SimState, grid: WalkGrid, hash: SpatialHash): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
      if (s.onWall[i] >= 0) continue
    if (!s.alive[i] || s.hidden[i] || st.untargetable[s.type[i]]) continue
    const ri = st.radius[s.type[i]]
    hash.forNeighbors(s.posX[i], s.posZ[i], ri + 1.0, (j) => {
      if (j <= i || !s.alive[j] || st.untargetable[s.type[j]]) return
      if (st.flying[s.type[j]] !== st.flying[s.type[i]]) return // separate layers
      const minD = ri + st.radius[s.type[j]]
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      const dSq = dx * dx + dz * dz
      if (dSq >= minD * minD) return
      let ux: number
      let uz: number
      let overlap: number
      if (dSq < 0.000001) {
        // Perfect overlap: deterministic separation axis from ids.
        ux = 1
        uz = 0
        overlap = minD
      } else {
        const d = Math.sqrt(dSq)
        ux = dx / d
        uz = dz / d
        overlap = minD - d
      }
      const iMobile = s.kind[i] === Kind.Unit
      const jMobile = s.kind[j] === Kind.Unit
      if (!iMobile && !jMobile) return
      const iShare = iMobile ? (jMobile ? 0.5 : 1) : 0
      const jShare = jMobile ? (iMobile ? 0.5 : 1) : 0
      const ix = s.posX[i] - ux * overlap * iShare
      const iz = s.posZ[i] - uz * overlap * iShare
      const jx = s.posX[j] + ux * overlap * jShare
      const jz = s.posZ[j] + uz * overlap * jShare
      if (iMobile && grid.isWalkableWorld(ix, iz)) {
        s.posX[i] = ix
        s.posZ[i] = iz
      }
      if (jMobile && grid.isWalkableWorld(jx, jz)) {
        s.posX[j] = jx
        s.posZ[j] = jz
      }
    })
  }
}
