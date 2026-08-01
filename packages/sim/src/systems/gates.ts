import { GateMode, Kind, type SimState } from '../state.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import type { SpatialHash } from '../spatial.ts'

// Gates: a wall section that is open to its owners and barred to everyone else.
//
// Two kinds, and the difference is who decides. A sally port is a door sensor:
// it opens for whoever walks up, because nobody wants to click a postern open
// every time a battalion files out. A great gate is a decision — it starts
// barred and a player works it, because when to open the front of your fortress
// is the whole question a siege asks.
//
// The walkgrid is one shared array with no team dimension, and giving it one
// would mean a grid and an A* pass per team. It is not needed. A gate simply
// unblocks its own footprint while a friendly unit is close and no enemy is —
// which is what a gate looks like from the outside anyway:
//
//   * defenders walk through, because their approach is what opens it
//   * an attacker arrives to find it shut and has to break it down
//   * a sally port lets infantry out without opening the wall to whoever is
//     standing on the other side of it
//
// The one artifact worth guarding against is sealing a unit inside stone, so a
// gate will not close while anything is standing in the archway.

/**
 * Open and close every gate for this tick. Runs before pathing, so a path
 * planned this tick sees the state the unit will actually meet.
 */
export function gates(s: SimState, grid: WalkGrid, hash: SpatialHash): void {
  const radii = s.def.stats.gateRadius
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i]) continue
    const r = radii[s.type[i]]
    if (r <= 0) continue

    const x = s.posX[i]
    const z = s.posZ[i]
    const mode = s.gateMode[i]
    let open: boolean
    if (mode === GateMode.Open) {
      open = true
    } else if (mode === GateMode.Shut) {
      open = false
    } else {
      // Auto: the door-sensor rule. A friendly close by opens it, an enemy
      // close by keeps it barred whatever your own troops are doing.
      const myTeam = s.playerTeam[s.owner[i]]
      let friendNear = false
      let enemyNear = false
      hash.forNeighbors(x, z, r, (j) => {
        if (j === i || !s.alive[j]) return
        // Buildings do not open gates — a wall standing next to its own gate
        // would otherwise hold it open all match.
        if (s.kind[j] === Kind.Building) return
        const dx = s.posX[j] - x
        const dz = s.posZ[j] - z
        if (dx * dx + dz * dz > r * r) return
        if (s.playerTeam[s.owner[j]] === myTeam) friendNear = true
        else enemyNear = true
      })
      open = friendNear && !enemyNear
    }
    // Never close on top of somebody. Being crushed into a wall by your own
    // gate is not a mechanic, it is a bug report.
    if (!open && s.gateOpen[i] === 1 && occupied(s, grid, i)) open = true

    if (open && s.gateOpen[i] === 0) {
      for (const cell of s.entityBlocked[i]) grid.walkable[cell] = 1
      s.gateOpen[i] = 1
      s.events.push({ t: 'gateOpened', idx: i, x, z })
    } else if (!open && s.gateOpen[i] === 1) {
      for (const cell of s.entityBlocked[i]) grid.walkable[cell] = 0
      s.gateOpen[i] = 0
      s.events.push({ t: 'gateClosed', idx: i, x, z })
    }
  }
}

function occupied(s: SimState, grid: WalkGrid, gate: number): boolean {
  const cells = s.entityBlocked[gate]
  if (cells.length === 0) return false
  for (let j = 0; j < s.count; j++) {
    if (!s.alive[j] || j === gate) continue
    if (s.kind[j] === Kind.Building) continue
    const idx = grid.idx(grid.cellX(s.posX[j]), grid.cellZ(s.posZ[j]))
    if (cells.includes(idx)) return true
  }
  return false
}
