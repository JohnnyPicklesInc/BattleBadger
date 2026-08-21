import { Kind, MAX_UNITS, Order, TICK_S, type SimState } from '../state.ts'
import type { SpatialHash } from '../spatial.ts'
import type { WalkGrid } from '../path/walkgrid.ts'

const SEP_PAD = 0.25
/**
 * How much of a body's width two ALLIED soldiers may share while one of them
 * is marching. Friends squeeze past each other; enemies never do, because
 * walking through the man you are fighting is the one thing a shield wall is
 * for. Without this, two battalions of the same army meeting head-on lock
 * solid and both give up where they stand.
 */
const ALLY_SQUEEZE = 0.8
/**
 * How hard a marching man steers AROUND what is in front of him rather than
 * into it. The radial push alone only ever slows a column down; the sideways
 * component is what makes it flow.
 */
const TANGENT_GAIN = 1.0

/**
 * This tick's ordered velocity, and who will step aside for whom.
 *
 * `givesWay` is set for a man standing about with no orders. A man holding
 * the line, fighting, or marching himself is not, and neither is masonry.
 *
 * Scratch, like the spatial hash: rebuilt every tick, never hashed.
 */
const givesWay = new Uint8Array(MAX_UNITS)
const intentX = new Float64Array(MAX_UNITS)
const intentZ = new Float64Array(MAX_UNITS)
let intentTick = -1

// Per-entity facts the inner loops would otherwise reach through s.type[j] for.
// One flat load instead of two dependent ones, per neighbour, per pass.
const radiusOf = new Float64Array(MAX_UNITS)
const teamOf = new Int32Array(MAX_UNITS)
/** bit 0 alive, bit 1 flying, bit 2 untargetable, bit 3 mobile (Kind.Unit) */
const flagOf = new Uint8Array(MAX_UNITS)
const F_ALIVE = 1
const F_FLYING = 2
const F_UNTARGETABLE = 4
const F_MOBILE = 8

function noteFacts(s: SimState): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    const ty = s.type[i]
    radiusOf[i] = st.radius[ty]
    teamOf[i] = s.playerTeam[s.owner[i]]
    flagOf[i] =
      (s.alive[i] ? F_ALIVE : 0) |
      (st.flying[ty] ? F_FLYING : 0) |
      (st.untargetable[ty] ? F_UNTARGETABLE : 0) |
      (s.kind[i] === Kind.Unit ? F_MOBILE : 0)
  }
}

// Candidate scratch, shared by both passes. Sized for every entity at once so
// a gather can never silently truncate and quietly drop a neighbour.
const qId = new Int32Array(MAX_UNITS)
const qX = new Float64Array(MAX_UNITS)
const qZ = new Float64Array(MAX_UNITS)

/**
 * Take the snapshot, before anybody is nudged.
 *
 * Both separation and the overlap pass ask whether a neighbour is marching or
 * standing, and they must get the same answer no matter which id asks first —
 * separation writes velocities as it goes, so reading them live would make the
 * answer depend on iteration order.
 */
function noteIntent(s: SimState): void {
  for (let i = 0; i < s.count; i++) {
    intentX[i] = s.velX[i]
    intentZ[i] = s.velZ[i]
    givesWay[i] =
      s.kind[i] === Kind.Unit &&
      s.velX[i] === 0 &&
      s.velZ[i] === 0 &&
      s.target[i] < 0 &&
      s.order[i] !== Order.Hold
        ? 1
        : 0
  }
  intentTick = s.tick
}

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
//
// Two things beyond a plain radial push, both aimed at a column that has to
// get past something:
//
//   - Right of way. A man with an order pushes THROUGH a friend who is merely
//     standing about, and the friend takes the shove instead of trading it.
//     Enemies get no such courtesy.
//   - Steering. Whatever is ahead is dodged sideways, not just leaned away
//     from — and when two friends meet head on, both step to their own right,
//     which is the only tie-break that puts them on opposite sides of the road.
export function separation(s: SimState, hash: SpatialHash): void {
  const st = s.def.stats
  noteIntent(s)
  noteFacts(s)
  for (let i = 0; i < s.count; i++) {
      if (s.onWall[i] >= 0) continue
    if (!s.alive[i] || s.kind[i] !== Kind.Unit || s.hidden[i]) continue
    const ri = radiusOf[i]
    const moving = intentX[i] !== 0 || intentZ[i] !== 0
    // A man closing on something he means to kill does not pick his way round
    // the crowd — he presses in. Steering is for the march, not the melee: an
    // ogre surrounded by spearmen must be surrounded, not politely circled.
    const closing = s.target[i] >= 0 && s.order[i] !== Order.Move
    // Heading, for the steering term. Zero for a man who is going nowhere.
    let dirX = 0
    let dirZ = 0
    if (moving && !closing) {
      const m = Math.sqrt(intentX[i] * intentX[i] + intentZ[i] * intentZ[i])
      dirX = intentX[i] / m
      dirZ = intentZ[i] / m
    }
    let pushX = 0
    let pushZ = 0
    const airI = flagOf[i] & F_FLYING
    const myTeam = teamOf[i]
    const xi = s.posX[i]
    const zi = s.posZ[i]
    const gi = givesWay[i]
    const n = hash.gatherAll(xi, zi, ri + 1.2, qId, qX, qZ)
    for (let k = 0; k < n; k++) {
      const j = qId[k]
      const fj = flagOf[j]
      if (j === i || (fj & F_ALIVE) === 0 || (fj & F_UNTARGETABLE) !== 0) continue
      // different layers: a gunship and a footman occupy the same ground plane
      // in the sim but not in the world, so they slide past each other
      if ((fj & F_FLYING) !== airI) continue
      const dx = xi - qX[k]
      const dz = zi - qZ[k]
      const dSq = dx * dx + dz * dz
      const minD = ri + radiusOf[j] + SEP_PAD
      if (dSq >= minD * minD || dSq < 0.000001) continue
      const d = Math.sqrt(dSq)
      let w = (minD - d) / minD
      const friend = teamOf[j] === myTeam
      if (friend && givesWay[j] !== gi) {
        // one of the two is only standing there: he is the one who moves
        w *= gi ? 1.7 : 0.3
      }
      pushX += (dx / d) * w
      pushZ += (dz / d) * w
      // Go round it. Only what is genuinely ahead, and never an enemy — an
      // army that sidesteps the men it is supposed to be fighting never
      // closes.
      if (!moving || closing || (!friend && (fj & F_MOBILE) !== 0)) continue
      const ahead = -(dirX * dx + dirZ * dz) / d
      if (ahead <= 0.2) continue
      // +perp is "my right"; take it when the obstacle is on my left or dead
      // ahead, my left when it is on my right.
      const side = dirZ * dx - dirX * dz >= 0 ? 1 : -1
      const t = w * ahead * TANGENT_GAIN * side
      pushX += dirZ * t
      pushZ += -dirX * t
    }
    if (pushX !== 0 || pushZ !== 0) {
      // TICK_S, not a hardcoded 0.1. This caps the shove as a fraction of the
      // distance a man can WALK in one tick, so it has to be measured in the
      // same tick the walking is. Frozen at 0.1 it silently meant "a tenth of
      // a second's travel" — correct only while the clock ran at 10 Hz. At
      // 30 Hz it let the crowd push people apart three times harder than they
      // could step, and a battalion ordered through an enemy line was held off
      // it and cut down to a man: nine dead for four, where it had been three
      // survivors and the line wiped.
      const cap = st.speed[s.type[i]] * TICK_S * (moving ? 0.6 : 0.35)
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

/**
 * Put a unit down, sliding along whatever it cannot walk into.
 *
 * The all-or-nothing version refuses the whole push when the corner it lands
 * on is masonry — which is precisely how a man ends up wedged between a wall
 * and his own battalion with nowhere the solver will let him go.
 */
function place(s: SimState, grid: WalkGrid, id: number, x: number, z: number): void {
  if (s.def.stats.flying[s.type[id]] || grid.isWalkableWorld(x, z)) {
    s.posX[id] = x
    s.posZ[id] = z
    return
  }
  if (grid.isWalkableWorld(x, s.posZ[id])) s.posX[id] = x
  else if (grid.isWalkableWorld(s.posX[id], z)) s.posZ[id] = z
}

// One pairwise push-out relaxation pass, then re-clamp to walkable ground.
// Buildings are immovable: overlapping units take the full push instead.
//
// Allies who are on the move interpenetrate a little (ALLY_SQUEEZE) and the
// one with somewhere to be keeps most of his ground. Both are what lets a
// column pass through its own army instead of stalling in it.
export function resolveOverlaps(s: SimState, grid: WalkGrid, hash: SpatialHash): void {
  const st = s.def.stats
  const intent = intentTick === s.tick
  for (let i = 0; i < s.count; i++) {
      if (s.onWall[i] >= 0) continue
    if (!s.alive[i] || s.hidden[i] || st.untargetable[s.type[i]]) continue
    const ri = radiusOf[i]
    const fi = flagOf[i]
    const iMobile = (fi & F_MOBILE) !== 0
    const myTeam = teamOf[i]
    // Ids only: this pass MOVES people as it goes, so positions must be read
    // live. The gather is here to get the cell walk out of a closure.
    const n = hash.gatherAll(s.posX[i], s.posZ[i], ri + 1.0, qId, qX, qZ)
    for (let k = 0; k < n; k++) {
      const j = qId[k]
      const fj = flagOf[j]
      if (j <= i || (fj & F_ALIVE) === 0 || (fj & F_UNTARGETABLE) !== 0) continue
      if ((fj & F_FLYING) !== (fi & F_FLYING)) continue // separate layers
      const jMobile = (fj & F_MOBILE) !== 0
      if (!iMobile && !jMobile) continue
      const friend = teamOf[j] === myTeam
      const squeeze = friend && intent && iMobile && jMobile && (!givesWay[i] || !givesWay[j])
      const minD = (ri + radiusOf[j]) * (squeeze ? ALLY_SQUEEZE : 1)
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      const dSq = dx * dx + dz * dz
      if (dSq >= minD * minD) continue
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
      let iShare = iMobile ? (jMobile ? 0.5 : 1) : 0
      let jShare = jMobile ? (iMobile ? 0.5 : 1) : 0
      // Right of way again: between friends, whoever is only standing there
      // is the one who gives up the ground.
      if (friend && intent && iMobile && jMobile && givesWay[i] !== givesWay[j]) {
        iShare = givesWay[i] ? 0.85 : 0.15
        jShare = 1 - iShare
      }
      if (iMobile) place(s, grid, i, s.posX[i] - ux * overlap * iShare, s.posZ[i] - uz * overlap * iShare)
      if (jMobile) place(s, grid, j, s.posX[j] + ux * overlap * jShare, s.posZ[j] + uz * overlap * jShare)
    }
  }
}
