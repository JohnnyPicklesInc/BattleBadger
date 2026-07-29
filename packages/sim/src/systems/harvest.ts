import { Harv, Kind, Order, releaseHarvest, type SimState } from '../state.ts'
import { killDoodad } from '../setup.ts'
export { killDoodad }
import { planPath } from './orders.ts'
import type { WalkGrid } from '../path/walkgrid.ts'

// One state machine covers all four economy archetypes:
//   surround  (SC minerals, C&C ore, AoE nodes): stand adjacent, repeat gathers
//   exclusive (SC-style one-worker-at-a-time patches): claim while gathering
//   inside    (WC3 gold mine): disappear into the node for insideTicks per trip
// Trips: toNode → gathering/inside → (carry full) → toDropoff → bank → back.

function nodeReach(s: SimState, i: number, n: number): number {
  const nodeDef = s.def.entities[s.doodads.defIdx[n]]
  // A node that blocks walkgrid cells cannot be approached to its geometric
  // edge: the footprint is cell-quantised (radius + 0.2, rounded out to whole
  // cells), so the nearest standable point sits up to a cell diagonal further
  // out. Without this slack a large blocking node is simply unharvestable —
  // Econ Demo's radius-1.5 gold mine had a reach of 2.35 while its harvesters
  // physically bottomed out at ~2.9, so they queued at ToNode forever.
  const blocked = s.doodads.blockedCells[n].length > 0 ? 1 : 0
  return nodeDef.radius + s.def.stats.radius[s.type[i]] + 0.45 + blocked
}

// Walk toward a world point via the normal order/path machinery.
function walkTo(s: SimState, grid: WalkGrid, i: number, x: number, z: number): void {
  const dx = s.destX[i] - x
  const dz = s.destZ[i] - z
  if (s.order[i] !== Order.Idle && dx * dx + dz * dz < 1) return // already headed there
  s.order[i] = Order.Move
  s.destX[i] = x
  s.destZ[i] = z
  s.paths[i] = planPath(grid, s.posX[i], s.posZ[i], x, z)
  s.stuck[i] = 0
  s.repathed[i] = 0
  s.progress[i] = 1000000
}

// A node behind `requiresExtractorOn` is only usable once the player has a
// completed extractor building sitting on it (SC geyser → refinery).
export function nodeUsable(s: SimState, player: number, n: number): boolean {
  const nd = s.def.entities[s.doodads.defIdx[n]].resourceNode
  if (!nd) return false
  if (!nd.requiresExtractorOn) return true
  for (let i = 0; i < s.count; i++) {
    if (
      s.alive[i] &&
      s.kind[i] === Kind.Building &&
      s.owner[i] === player &&
      s.harvNode[i] === n &&
      s.buildTicks[i] === 0
    )
      return true
  }
  return false
}

// Nearest living node with the same tag within radius (distance, then index).
export function findNode(s: SimState, i: number, tag: string, radius: number): number {
  const d = s.doodads
  let best = -1
  let bestDSq = radius * radius
  for (let n = 0; n < d.count; n++) {
    if (d.alive[n] !== 1) continue
    const nd = s.def.entities[d.defIdx[n]].resourceNode
    if (!nd || nd.tag !== tag || d.amount[n] === 0) continue
    if (!nodeUsable(s, s.owner[i], n)) continue
    const dx = d.x[n] - s.posX[i]
    const dz = d.z[n] - s.posZ[i]
    const dSq = dx * dx + dz * dz
    if (dSq < bestDSq) {
      best = n
      bestDSq = dSq
    }
  }
  return best
}

// Nearest own completed building accepting this resource.
function findDropoff(s: SimState, i: number, resIdx: number): number {
  let best = -1
  let bestDSq = Infinity
  for (let j = 0; j < s.count; j++) {
    if (!s.alive[j] || s.kind[j] !== Kind.Building || s.owner[j] !== s.owner[i]) continue
    if ((s.def.dropoffMask[s.type[j]] & (1 << resIdx)) === 0) continue
    const dx = s.posX[j] - s.posX[i]
    const dz = s.posZ[j] - s.posZ[i]
    const dSq = dx * dx + dz * dz
    if (dSq < bestDSq || (dSq === bestDSq && j < best)) {
      best = j
      bestDSq = dSq
    }
  }
  return best
}

function beginGather(s: SimState, i: number, n: number): void {
  const nd = s.def.entities[s.doodads.defIdx[n]].resourceNode!
  const h = s.def.entities[s.type[i]].harvester!
  if (nd.occupancy === 'inside') {
    s.doodads.occupants[n]++
    s.harvState[i] = Harv.Inside
    s.hidden[i] = 1
    s.harvTimer[i] = s.tick + (nd.insideTicks ?? 10)
  } else {
    if (nd.occupancy === 'exclusive') s.doodads.occupants[n]++
    s.harvState[i] = Harv.Gathering
    s.harvTimer[i] = s.tick + h.gatherPeriodTicks
  }
  s.order[i] = Order.Idle
  s.paths[i] = null
  const dx = s.doodads.x[n] - s.posX[i]
  const dz = s.doodads.z[n] - s.posZ[i]
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d > 0.0001) {
    s.faceX[i] = dx / d
    s.faceZ[i] = dz / d
  }
}

// Take one load from the node into the carry slot. Returns false if node dry.
function takeLoad(s: SimState, i: number, n: number): boolean {
  const nd = s.def.entities[s.doodads.defIdx[n]].resourceNode!
  const h = s.def.entities[s.type[i]].harvester!
  const resIdx = s.def.resIndex.get(nd.resource)!
  if (s.carryRes[i] !== resIdx) {
    s.carryRes[i] = resIdx
    s.carryAmt[i] = 0
  }
  let take = Math.min(h.gatherAmount, h.carryCapacity - s.carryAmt[i])
  if (s.doodads.amount[n] >= 0) take = Math.min(take, s.doodads.amount[n])
  if (take <= 0) return false
  s.carryAmt[i] += take
  if (s.doodads.amount[n] > 0) s.doodads.amount[n] -= take
  return true
}

function nodeInvalid(s: SimState, n: number): boolean {
  return n < 0 || s.doodads.alive[n] !== 1 || s.doodads.amount[n] === 0
}

function nodeInvalidFor(s: SimState, i: number, n: number): boolean {
  return nodeInvalid(s, n) || !nodeUsable(s, s.owner[i], n)
}

export function harvest(s: SimState, grid: WalkGrid): void {
  const d = s.doodads
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.harvState[i] === Harv.None) continue
    const hdef = s.def.entities[s.type[i]].harvester
    if (!hdef) {
      releaseHarvest(s, i)
      continue
    }
    const state = s.harvState[i]
    let n = s.harvNode[i]

    // A dead/dry/unpowered node: retarget (keep carrying toward dropoff).
    if (state !== Harv.ToDropoff && state !== Harv.Inside && nodeInvalidFor(s, i, n)) {
      if (n >= 0) {
        const nd = s.def.entities[d.defIdx[n]]?.resourceNode
        const tag = nd?.tag
        releaseHarvest(s, i)
        const next = tag !== undefined ? findNode(s, i, tag, 14) : -1
        if (next >= 0) {
          s.harvState[i] = Harv.ToNode
          s.harvNode[i] = next
          continue
        }
      }
      // nothing left: bank whatever we carry, else go idle
      if (s.carryAmt[i] > 0) {
        s.harvState[i] = Harv.ToDropoff
        s.harvNode[i] = -1
      } else {
        releaseHarvest(s, i)
        s.order[i] = Order.Idle
      }
      continue
    }

    if (state === Harv.ToNode) {
      const dx = d.x[n] - s.posX[i]
      const dz = d.z[n] - s.posZ[i]
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist <= nodeReach(s, i, n)) {
        const nd = s.def.entities[d.defIdx[n]].resourceNode!
        const cap = nd.occupancy === 'surround' ? 1000000 : (nd.maxOccupants ?? 1)
        if (nd.occupancy !== 'surround' && d.occupants[n] >= cap) {
          // node busy: wait in place
          s.order[i] = Order.Idle
          s.paths[i] = null
        } else {
          beginGather(s, i, n)
        }
      } else {
        walkTo(s, grid, i, d.x[n], d.z[n])
      }
    } else if (state === Harv.Gathering) {
      if (s.tick >= s.harvTimer[i]) {
        const ok = takeLoad(s, i, n)
        if (d.amount[n] === 0) killDoodad(s, grid, n)
        const h = s.def.entities[s.type[i]].harvester!
        if (!ok || s.carryAmt[i] >= h.carryCapacity) {
          // release the claim and head to a dropoff
          const nd = s.def.entities[d.defIdx[n]].resourceNode!
          if (nd.occupancy === 'exclusive') d.occupants[n] = Math.max(0, d.occupants[n] - 1)
          s.harvState[i] = Harv.ToDropoff
        } else {
          s.harvTimer[i] = s.tick + h.gatherPeriodTicks
        }
      }
    } else if (state === Harv.Inside) {
      if (s.tick >= s.harvTimer[i]) {
        // emerge with a full trip's load
        d.occupants[n] = Math.max(0, d.occupants[n] - 1)
        s.hidden[i] = 0
        takeLoad(s, i, n)
        if (d.amount[n] === 0) killDoodad(s, grid, n)
        s.harvState[i] = Harv.ToDropoff
      }
    } else if (state === Harv.ToDropoff) {
      if (s.carryAmt[i] <= 0 || s.carryRes[i] < 0) {
        s.harvState[i] = nodeInvalid(s, n) ? Harv.None : Harv.ToNode
        continue
      }
      const drop = findDropoff(s, i, s.carryRes[i])
      if (drop < 0) {
        // no dropoff exists: stand by (players can build one later)
        s.order[i] = Order.Idle
        continue
      }
      const dx = s.posX[drop] - s.posX[i]
      const dz = s.posZ[drop] - s.posZ[i]
      const dist = Math.sqrt(dx * dx + dz * dz)
      const reach = s.def.stats.radius[s.type[drop]] + s.def.stats.radius[s.type[i]] + 0.6
      if (dist <= reach) {
        const numRes = s.def.resources.length
        s.resources[s.owner[i] * numRes + s.carryRes[i]] += s.carryAmt[i]
        s.carryAmt[i] = 0
        s.carryRes[i] = -1
        if (!nodeInvalid(s, n)) {
          s.harvState[i] = Harv.ToNode
        } else {
          const nd = n >= 0 ? s.def.entities[d.defIdx[n]]?.resourceNode : undefined
          const next = nd ? findNode(s, i, nd.tag, 14) : -1
          if (next >= 0) {
            s.harvState[i] = Harv.ToNode
            s.harvNode[i] = next
          } else {
            releaseHarvest(s, i)
          }
        }
      } else {
        walkTo(s, grid, i, s.posX[drop], s.posZ[drop])
      }
    }
  }
}
