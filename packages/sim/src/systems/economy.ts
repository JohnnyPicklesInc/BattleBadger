import { grantUpgrade } from './upgrades.ts'
import { Kind, Order, addMember, allied, createHorde, spawnUnit, type SimState } from '../state.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { blockCells } from '../setup.ts'
import { planPath } from './orders.ts'
import { formationSlot, formationWorld } from './hordes.ts'

// ---- cost / tech helpers ----

export function canAfford(s: SimState, player: number, defIdx: number): boolean {
  const cost = s.def.costVec[defIdx]
  const numRes = s.def.resources.length
  for (let r = 0; r < numRes; r++) {
    if (s.resources[player * numRes + r] < cost[r]) return false
  }
  return true
}

export function canAffordUpgrade(s: SimState, player: number, upIdx: number): boolean {
  const cost = s.def.upgradeCost[upIdx]
  const numRes = s.def.resources.length
  for (let r = 0; r < numRes; r++) {
    if (s.resources[player * numRes + r] < cost[r]) return false
  }
  return true
}

export function deductUpgrade(s: SimState, player: number, upIdx: number): void {
  const cost = s.def.upgradeCost[upIdx]
  const numRes = s.def.resources.length
  for (let r = 0; r < numRes; r++) s.resources[player * numRes + r] -= cost[r]
}

export function deduct(s: SimState, player: number, defIdx: number, sign: number): void {
  const cost = s.def.costVec[defIdx]
  const numRes = s.def.resources.length
  for (let r = 0; r < numRes; r++) s.resources[player * numRes + r] -= cost[r] * sign
}

// Tech gate: player owns a completed, living entity of every required def.
export function requiresMet(s: SimState, player: number, defIdx: number): boolean {
  for (const req of s.def.requiresIdx[defIdx]) {
    let found = false
    for (let i = 0; i < s.count && !found; i++) {
      if (s.alive[i] && s.owner[i] === player && s.type[i] === req && s.buildTicks[i] === 0) found = true
    }
    if (!found) return false
  }
  return true
}

export function supplyRoom(s: SimState, player: number, defIdx: number): boolean {
  if (s.def.supplyName === '') return true
  const cost = s.def.entities[defIdx].supplyCost ?? 0
  if (cost === 0) return true
  return s.supplyUsed[player] + cost <= s.supplyCap[player]
}

// ---- building placement ----

// The doodad node an extractor building must sit on, or -1.
export function extractorNodeAt(s: SimState, defIdx: number, x: number, z: number): number {
  const onId = s.def.entities[defIdx].extractorOn
  if (!onId) return -1
  const onIdx = s.def.entIndex.get(onId)
  const d = s.doodads
  for (let n = 0; n < d.count; n++) {
    if (d.alive[n] !== 1 || d.defIdx[n] !== onIdx) continue
    const dx = d.x[n] - x
    const dz = d.z[n] - z
    const r = s.def.entities[d.defIdx[n]].radius
    if (dx * dx + dz * dz <= r * r) {
      // one extractor per node: buildings remember their node in harvNode
      let taken = false
      for (let i = 0; i < s.count && !taken; i++) {
        if (s.alive[i] && s.kind[i] === Kind.Building && s.harvNode[i] === n) taken = true
      }
      return taken ? -1 : n
    }
  }
  return -1
}

// The free build plot at (x,z) that accepts `defIdx` for `player`, or -1.
// Neutral plots are up for grabs; owned plots only serve their owner's team.
export function freePlotAt(
  s: SimState,
  defIdx: number,
  player: number,
  x: number,
  z: number,
): number {
  for (let p = 0; p < s.count; p++) {
    if (!s.alive[p] || !s.def.stats.isPlot[s.type[p]] || s.plotHost[p] >= 0) continue
    const plot = s.def.entities[s.type[p]].plot!
    if (!plot.neutral && !allied(s, s.owner[p], player)) continue
    if (!s.def.plotAcceptsIdx[s.type[p]].includes(defIdx)) continue
    const dx = s.posX[p] - x
    const dz = s.posZ[p] - z
    const r = s.def.stats.radius[s.type[p]]
    if (dx * dx + dz * dz <= r * r) return p
  }
  return -1
}

export function validPlacement(
  s: SimState,
  grid: WalkGrid,
  defIdx: number,
  x: number,
  z: number,
  player = 0,
): boolean {
  const e = s.def.entities[defIdx]
  if (s.def.stats.plotPlaced[defIdx]) return freePlotAt(s, defIdx, player, x, z) >= 0
  if (e.extractorOn) return extractorNodeAt(s, defIdx, x, z) >= 0
  const r = e.radius + 0.2
  const cx0 = grid.cellX(x - r)
  const cx1 = grid.cellX(x + r)
  const cy0 = grid.cellZ(z - r)
  const cy1 = grid.cellZ(z + r)
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!grid.isWalkable(cx, cy)) return false
    }
  }
  return true
}

// Spawn a building: blocks its footprint cells and nudges any standing units
// out so nobody gets sealed inside unwalkable ground.

// How close one of your own things must be to claim an outer settlement, and
// how close an enemy must be to contest it. Measured plot centre to entity
// edge, so a big unit reaches marginally further than a small one.
export const PLOT_CLAIM_RANGE = 10
export const PLOT_CONTEST_RANGE = 10

/**
 * May `player` build on plot `plotIdx` right now?
 *
 * Two different rules, because the two kinds of plot mean different things:
 *
 *   - A plot inside your own base (the ring a fortress spawns) is yours
 *     already. Build on it whenever you can pay — the fortress standing in the
 *     middle of the ring is the presence.
 *
 *   - An outer settlement is ground you have to take. You must have something
 *     of your own beside it, AND no enemy may be standing on it: you cannot
 *     quietly raise a farm on a plot an enemy warband is occupying.
 *
 * Plots never count as presence for either test, or a captured settlement
 * would vouch for its neighbours in a chain.
 *
 * Shared by applyCommands and the AI so the two can never disagree.
 */
export function plotClaimable(s: SimState, player: number, plotIdx: number): boolean {
  const st = s.def.stats
  const plotDef = s.def.entities[s.type[plotIdx]].plot
  // Own base plot: freePlotAt has already established it is allied, so the
  // only remaining question is affordability, handled by the caller.
  if (!plotDef?.neutral) return true

  const px = s.posX[plotIdx]
  const pz = s.posZ[plotIdx]
  let held = false
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i]) continue
    if (st.isPlot[s.type[i]]) continue // a pad cannot vouch for another pad
    const dx = s.posX[i] - px
    const dz = s.posZ[i] - pz
    const dSq = dx * dx + dz * dz
    const r = st.radius[s.type[i]]
    if (allied(s, s.owner[i], player)) {
      const reach = PLOT_CLAIM_RANGE + r
      if (dSq <= reach * reach) held = true
    } else {
      const reach = PLOT_CONTEST_RANGE + r
      if (dSq <= reach * reach) return false // contested: nobody builds here
    }
  }
  return held
}


/**
 * Spawn a horde ticket's whole battalion, formed up and bound into one horde.
 *
 * Shared by production (a barracks finishing an order) and setup (a map's
 * pre-placed armies), because only a bound horde carries formation, veterancy
 * and command-point cost — a loose soldier has none of those, so placing
 * battalions as individuals quietly opts out of the whole battalion game.
 *
 * Returns the spawned member ids.
 */
export function spawnHorde(
  s: SimState,
  grid: WalkGrid,
  ticketDef: number,
  owner: number,
  px: number,
  pz: number,
  dirX: number,
  dirZ: number,
): number[] {
  const spawned: number[] = []
  const horde = createHorde(s, ticketDef, owner)
  s.hordes.faceX[horde] = dirX
  s.hordes.faceZ[horde] = dirZ
  const memberDef = s.def.hordeUnit[ticketDef]
  const n = s.def.hordeCount[ticketDef]
  const spacing = s.def.hordeSpacing[ticketDef]
  for (let k = 0; k < n; k++) {
    const [ox, oz] = formationSlot(0, k, n, spacing)
    const [wx, wz] = formationWorld(px, pz, dirX, dirZ, ox, oz)
    let sx = wx
    let sz = wz
    if (!grid.isWalkableWorld(sx, sz)) {
      const near = grid.nearestWalkable(grid.cellX(sx), grid.cellZ(sz))
      if (!near) {
        sx = px
        sz = pz
      } else {
        sx = grid.centerX(near[0])
        sz = grid.centerZ(near[1])
      }
    }
    const m = spawnUnit(s, memberDef, owner, sx, sz)
    addMember(s, horde, m)
    spawned.push(m)
  }
  return spawned
}

// Is a building already standing where one is about to go? Plots and keeps
// only — units get pushed out of a new footprint, buildings do not.
function occupiedBy(s: SimState, x: number, z: number, radius: number): boolean {
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Building) continue
    const dx = s.posX[i] - x
    const dz = s.posZ[i] - z
    const r = radius + s.def.stats.radius[s.type[i]]
    if (dx * dx + dz * dz < r * r) return true
  }
  return false
}

export function spawnBuilding(
  s: SimState,
  grid: WalkGrid,
  defIdx: number,
  owner: number,
  x: number,
  z: number,
  underConstruction: boolean,
): number {
  const e = s.def.entities[defIdx]
  const st = s.def.stats
  // plot-placed structures snap to their pad and claim it
  let plot = -1
  if (st.plotPlaced[defIdx]) {
    plot = freePlotAt(s, defIdx, owner, x, z)
    if (plot >= 0) {
      x = s.posX[plot]
      z = s.posZ[plot]
    }
  }
  const id = spawnUnit(s, defIdx, owner, x, z)
  if (plot >= 0) {
    s.plotHost[plot] = id
    s.plotOf[id] = plot
  }
  // plots themselves are pads: they never block pathing
  if (st.isPlot[defIdx]) {
    // nothing to block
  } else if (!e.extractorOn) {
    s.entityBlocked[id] = blockCells(grid, x, z, e.radius)
  } else {
    const n = extractorNodeAt(s, defIdx, x, z)
    // node cells already block; remember the node claim
    if (n >= 0) {
      s.harvNode[id] = n
      s.posX[id] = s.doodads.x[n]
      s.posZ[id] = s.doodads.z[n]
    }
  }
  if (underConstruction) {
    s.buildTicks[id] = Math.max(1, e.buildTimeTicks ?? 1)
    // Half strength on the day it is founded; addBuildHp pays out the rest as
    // the work proceeds, so raising a barracks in the open is a real risk.
    s.hp[id] = Math.max(1, Math.floor(st.maxHp[defIdx] / 2))
  }
  // A fortress brings its rings of expansion plots with it — but only the ones
  // that have somewhere to go. A slot landing in a cliff, in the sea, or on top
  // of a neighbour's plot used to spawn anyway: on a map where several keeps
  // share one enclosure that stacked pads on each other and buried others in
  // the rock. Skipping them keeps the ring honest about what it actually got.
  for (const ring of s.def.expansionRings[defIdx]) {
    for (let o = 0; o + 1 < ring.offsets.length; o += 2) {
      const px = x + ring.offsets[o]
      const pz = z + ring.offsets[o + 1]
      if (!grid.isWalkableWorld(px, pz)) continue
      if (occupiedBy(s, px, pz, st.radius[ring.plot])) continue
      const p = spawnBuilding(s, grid, ring.plot, owner, px, pz, false)
      s.plotParent[p] = id
    }
  }
  // push out units standing in the fresh footprint
  for (let j = 0; j < s.count; j++) {
    if (!s.alive[j] || s.kind[j] !== Kind.Unit || s.hidden[j]) continue
    if (grid.isWalkableWorld(s.posX[j], s.posZ[j])) continue
    const near = grid.nearestWalkable(grid.cellX(s.posX[j]), grid.cellZ(s.posZ[j]))
    if (near) {
      s.posX[j] = grid.centerX(near[0])
      s.posZ[j] = grid.centerZ(near[1])
    }
  }
  return id
}

// ---- per-tick systems ----

// Buildings under construction advance while any capable own builder stands
// adjacent (multiple builders don't stack — WC3 style).
export function construction(s: SimState): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Building || s.buildTicks[i] === 0) continue
    // plot structures raise themselves: BFME has no builder to stand there
    if (s.plotOf[i] >= 0) {
      s.buildTicks[i]--
      addBuildHp(s, i)
      continue
    }
    const ri = st.radius[s.type[i]]
    let hasBuilder = false
    for (let j = 0; j < s.count && !hasBuilder; j++) {
      if (!s.alive[j] || s.hidden[j] || s.kind[j] !== Kind.Unit || s.owner[j] !== s.owner[i]) continue
      if (!s.def.buildsIdx[s.type[j]].includes(s.type[i])) continue
      const dx = s.posX[j] - s.posX[i]
      const dz = s.posZ[j] - s.posZ[i]
      const reach = ri + st.radius[s.type[j]] + 1.0
      if (dx * dx + dz * dz <= reach * reach) hasBuilder = true
    }
    if (hasBuilder) {
      s.buildTicks[i]--
      addBuildHp(s, i)
    }
  }
}

/**
 * A structure goes up at half strength and earns the rest as it builds, so a
 * half-finished barracks is a genuine liability rather than a full-HP wall.
 *
 * HP is ADDED per tick rather than interpolated from progress, so damage taken
 * mid-build is not silently undone by the next construction tick.
 */
function addBuildHp(s: SimState, i: number): void {
  // construction() runs before deaths(), so a structure already reduced to 0
  // is awaiting removal — topping it up here would resurrect it.
  if (s.hp[i] <= 0) return
  const maxHp = s.def.stats.maxHp[s.type[i]]
  const total = Math.max(1, s.def.entities[s.type[i]].buildTimeTicks ?? 1)
  // the half that was withheld at spawn, paid out across the build
  const gain = Math.floor(maxHp / 2 / total)
  s.hp[i] = Math.min(maxHp, s.hp[i] + Math.max(1, gain))
  // finished: top it up so rounding never leaves a building short
  if (s.buildTicks[i] === 0) s.hp[i] = maxHp
}

function powerDeficit(s: SimState, player: number): boolean {
  return s.def.powerEnabled && s.powerUsed[player] > s.powerProvided[player]
}

// Production queues: completed buildings train units, spawning at the edge
// nearest the rally point (or +x), then walking to the rally.
export function production(s: SimState, grid: WalkGrid): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Building || s.buildTicks[i] > 0) continue
    const q = s.queue[i]
    if (q.length === 0) continue
    // C&C power model: low power halves production speed (integer: skip odd ticks)
    if (powerDeficit(s, s.owner[i]) && (s.tick & 1) === 1) continue
    s.queueTicks[i]++
    const unitDef = q[0]
    // A negative entry is research rather than a unit: nothing spawns, the
    // owner simply comes to own it.
    if (unitDef < 0) {
      const up = -1 - unitDef
      if (s.queueTicks[i] < Math.max(1, s.def.upgrades[up].buildTimeTicks)) continue
      grantUpgrade(s, s.owner[i], up)
      q.shift()
      s.queueTicks[i] = 0
      continue
    }
    const needed = Math.max(1, s.def.entities[unitDef].buildTimeTicks ?? 10)
    if (s.queueTicks[i] < needed) continue

    // spawn toward the rally (or +x when unset)
    let dirX = 1
    let dirZ = 0
    const hasRally = s.rallyX[i] !== 0 || s.rallyZ[i] !== 0
    if (hasRally) {
      const dx = s.rallyX[i] - s.posX[i]
      const dz = s.rallyZ[i] - s.posZ[i]
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d > 0.001) {
        dirX = dx / d
        dirZ = dz / d
      }
    }
    const dist = st.radius[s.type[i]] + st.radius[unitDef] + 0.4
    let px = s.posX[i] + dirX * dist
    let pz = s.posZ[i] + dirZ * dist
    if (!grid.isWalkableWorld(px, pz)) {
      const near = grid.nearestWalkable(grid.cellX(px), grid.cellZ(pz))
      if (!near) continue // fully sealed in: hold the queue
      px = grid.centerX(near[0])
      pz = grid.centerZ(near[1])
    }
    // A horde ticket spawns its whole battalion, formed up, as one horde.
    const spawned: number[] =
      s.def.hordeUnit[unitDef] >= 0
        ? spawnHorde(s, grid, unitDef, s.owner[i], px, pz, dirX, dirZ)
        : [spawnUnit(s, unitDef, s.owner[i], px, pz)]
    for (const id of spawned) {
      if (!hasRally) continue
      s.order[id] = Order.Move
      s.destX[id] = s.rallyX[i]
      s.destZ[id] = s.rallyZ[i]
      s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], s.rallyX[i], s.rallyZ[i])
      s.progress[id] = 1000000
    }
    q.shift()
    s.queueTicks[i] = 0
  }
}

// Passive building income (BFME model: no harvesters, farms just pay out).
// Payouts ride a global cadence so a building's income never depends on when
// it was built. Crowding: each same-group building of the same owner inside
// crowdRadius cuts this building's payout, floored at crowdFloorPct.
export function income(s: SimState): void {
  if (!s.def.anyIncome || s.tick === 0) return
  const inc = s.def.income
  const numRes = s.def.resources.length
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.buildTicks[i] > 0) continue
    const ty = s.type[i]
    const ri = inc.resIdx[ty]
    if (ri < 0 || s.tick % inc.period[ty] !== 0) continue
    let pct = 100
    const r = inc.crowdRadius[ty]
    if (r > 0 && inc.crowdPenaltyPct[ty] > 0) {
      let crowd = 0
      for (let j = 0; j < s.count; j++) {
        if (j === i || !s.alive[j] || s.owner[j] !== s.owner[i]) continue
        if (inc.group[s.type[j]] !== inc.group[ty]) continue
        const dx = s.posX[j] - s.posX[i]
        const dz = s.posZ[j] - s.posZ[i]
        if (dx * dx + dz * dz <= r * r) crowd++
      }
      pct = Math.max(inc.crowdFloorPct[ty], 100 - inc.crowdPenaltyPct[ty] * crowd)
    }
    s.resources[s.owner[i] * numRes + ri] += Math.floor((inc.amount[ty] * pct) / 100)
  }
}

// Recompute per-player supply and power totals (derived state, hashed).
export function supplyPower(s: SimState): void {
  s.supplyUsed.fill(0)
  s.supplyCap.fill(0)
  s.powerUsed.fill(0)
  s.powerProvided.fill(0)
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i]) continue
    const e = s.def.entities[s.type[i]]
    const p = s.owner[i]
    s.supplyUsed[p] += e.supplyCost ?? 0
    if (s.buildTicks[i] === 0) {
      s.supplyCap[p] += e.supplyProvided ?? 0
      s.powerProvided[p] += e.powerProvided ?? 0
      s.powerUsed[p] += e.powerCost ?? 0
    }
  }
  // Command points are spent per horde, not per soldier: the ticket carries
  // the cost and its members are authored at 0.
  for (let h = 0; h < s.hordes.count; h++) {
    if (s.hordes.alive[h] !== 1) continue
    s.supplyUsed[s.hordes.owner[h]] += s.def.entities[s.hordes.defIdx[h]].supplyCost ?? 0
  }
  if (s.def.supplyHardCap > 0) {
    for (let p = 0; p < 8; p++) s.supplyCap[p] = Math.min(s.supplyCap[p], s.def.supplyHardCap)
  }
}
