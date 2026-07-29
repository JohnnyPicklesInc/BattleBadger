import type { RtsMapDoc } from './mapdoc.ts'
import { createSim, spawnUnit, type SimState } from './state.ts'
import type { WalkGrid } from './path/walkgrid.ts'
import { compileGameDef, type GameDefCompiled } from './defs/compile.ts'
import type { GameDef } from './defs/schema.ts'
import { spawnBuilding, spawnHorde, supplyPower } from './systems/economy.ts'
import { compileTriggers } from './systems/triggers.ts'
import { mapContentHash } from './hash.ts'
import skirmishJson from './defs/presets/skirmish.json'

export const SKIRMISH_DEF = skirmishJson as GameDef

export function compileMapDef(doc: RtsMapDoc): GameDefCompiled {
  return compileGameDef(doc.gameDef ?? SKIRMISH_DEF)
}

// Mark walkgrid cells under a doodad/building unwalkable; returns the indices.
export function blockCells(grid: WalkGrid, x: number, z: number, radius: number): number[] {
  const blocked: number[] = []
  const r = radius + 0.2
  const cx0 = grid.cellX(x - r)
  const cx1 = grid.cellX(x + r)
  const cy0 = grid.cellZ(z - r)
  const cy1 = grid.cellZ(z + r)
  const homeX = grid.cellX(x)
  const homeY = grid.cellZ(z)
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!grid.inBounds(cx, cy)) continue
      // the containing cell always blocks; others by circle test
      if (!(cx === homeX && cy === homeY)) {
        const dx = grid.centerX(cx) - x
        const dz = grid.centerZ(cy) - z
        if (dx * dx + dz * dz > r * r) continue
      }
      const idx = grid.idx(cx, cy)
      if (grid.walkable[idx] === 1) {
        grid.walkable[idx] = 0
        blocked.push(idx)
      }
    }
  }
  return blocked
}

// Doodad death: restore walkability + emit event (trees falling, nodes depleting).
export function killDoodad(s: SimState, grid: WalkGrid, idx: number): void {
  const d = s.doodads
  if (d.alive[idx] !== 1) return
  d.alive[idx] = 0
  for (const cell of d.blockedCells[idx]) grid.walkable[cell] = 1
  d.blockedCells[idx] = []
  s.events.push({ t: 'doodadDied', idx, type: d.defIdx[idx], x: d.x[idx], z: d.z[idx] })
}

// Deterministic match setup: identical on every client for a given doc.
// Spawns the doc's pre-placed entities (map generators emit armies this way).
// `playerCount` skips content owned by absent slots (e.g. a 4-slot team map
// played 1v1).
export function setupMatch(doc: RtsMapDoc, grid: WalkGrid, playerCount = 2): SimState {
  const def = compileMapDef(doc)
  const s = createSim(doc.seed, def)
  // Content identity, not the filename: two clients on "dunhollow.json" that
  // disagree about its contents now desync at tick 0 rather than drifting.
  s.mapHash = mapContentHash(doc)
  s.playerCount = Math.max(1, Math.min(8, playerCount | 0))
  if (doc.slotTeams) {
    for (let i = 0; i < 8; i++) {
      const t = doc.slotTeams[i]
      if (t !== undefined) s.playerTeam[i] = Math.max(0, Math.min(7, t | 0))
    }
  }
  s.trig = compileTriggers(doc)

  const docDoodads = (doc.doodads ?? []).filter((dd) => def.entIndex.has(dd.def))
  const n = docDoodads.length
  s.doodads = {
    count: n,
    defIdx: new Int32Array(n),
    x: new Float64Array(n),
    z: new Float64Array(n),
    hp: new Int32Array(n),
    amount: new Int32Array(n),
    alive: new Uint8Array(n).fill(1),
    occupants: new Int32Array(n),
    blockedCells: [],
  }
  docDoodads.forEach((dd, i) => {
    const typeIdx = def.entIndex.get(dd.def)!
    const e = def.entities[typeIdx]
    s.doodads.defIdx[i] = typeIdx
    s.doodads.x[i] = dd.x
    s.doodads.z[i] = dd.z
    s.doodads.hp[i] = e.hp
    s.doodads.amount[i] = e.resourceNode ? e.resourceNode.amount : -1
    s.doodads.blockedCells.push(blockCells(grid, dd.x, dd.z, e.radius * (dd.scale ?? 1)))
  })

  // buildings first so unit spawn-snapping avoids their footprints;
  // content owned by absent player slots is skipped
  const placed = [...(doc.placed ?? [])].filter(
    (p) => def.entIndex.has(p.def) && p.owner >= 0 && p.owner < 8 && (p.owner < s.playerCount || p.always === true),
  )
  placed.sort((a, b) => {
    const ka = def.entities[def.entIndex.get(a.def)!].kind === 'building' ? 0 : 1
    const kb = def.entities[def.entIndex.get(b.def)!].kind === 'building' ? 0 : 1
    return ka - kb
  })
  for (const p of placed) {
    const typeIdx = def.entIndex.get(p.def)!
    if (def.entities[typeIdx].kind === 'building') {
      spawnBuilding(s, grid, typeIdx, p.owner, p.x, p.z, false)
      continue
    }
    let x = p.x
    let z = p.z
    if (!grid.isWalkableWorld(x, z)) {
      const near = grid.nearestWalkable(grid.cellX(x), grid.cellZ(z))
      if (near) {
        x = grid.centerX(near[0])
        z = grid.centerZ(near[1])
      }
    }
    // A placed horde TICKET spawns its whole battalion, bound as one horde —
    // otherwise a map's starting army would be loose soldiers with no
    // formation, no veterancy track and no command-point cost, which on a
    // battalion-centric map means the opening army plays by different rules
    // than everything trained afterwards.
    if (def.hordeUnit[typeIdx] >= 0) {
      // face the map centre, so both sides form up looking inward
      const cx = doc.originX + doc.cols * doc.cellSize * 0.5
      const cz = doc.originZ + doc.rows * doc.cellSize * 0.5
      let dx = cx - x
      let dz = cz - z
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d < 1e-9) {
        dx = 0
        dz = 1
      } else {
        dx /= d
        dz /= d
      }
      spawnHorde(s, grid, typeIdx, p.owner, x, z, dx, dz)
      continue
    }
    spawnUnit(s, typeIdx, p.owner, x, z)
  }
  supplyPower(s)
  return s
}
