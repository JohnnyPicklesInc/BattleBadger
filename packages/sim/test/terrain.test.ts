import { describe, expect, it } from 'vitest'
import {
  CLIFF_STEP,
  deriveTerrain,
  findPath,
  generateMap,
  walkGridFromDoc,
  type RtsMapDoc,
} from '@battlebadger/sim'

// 16x16: an 6x6 tier-1 plateau (x 5..10, y 5..10) with a 2-wide ramp on its
// east edge (x 9..12, y 7..8).
function cliffDoc(): RtsMapDoc {
  const size = 16
  const cliffLevel = Array.from({ length: size * size }, () => 0)
  const ramp = Array.from({ length: size * size }, () => 0)
  for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) cliffLevel[y * size + x] = 1
  for (let y = 7; y <= 8; y++) for (let x = 9; x <= 12; x++) ramp[y * size + x] = 1
  return {
    version: 2,
    name: 'cliff-fixture',
    seed: 1,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    cliffLevel,
    ramp,
    startLocations: [{ x: 2, z: 2 }],
  }
}

describe('cliff terrain derivation', () => {
  it('heights follow tiers; ramps sit halfway', () => {
    const doc = cliffDoc()
    const { heights } = deriveTerrain(doc)
    expect(heights[7 * 16 + 7]).toBe(CLIFF_STEP) // plateau interior
    expect(heights[2 * 16 + 2]).toBe(0) // low ground
    expect(heights[7 * 16 + 10]).toBe(CLIFF_STEP / 2) // ramp cell bridging 0↔1
  })

  it('carves an unwalkable band along tier boundaries, except through ramps', () => {
    const doc = cliffDoc()
    const { walkable } = deriveTerrain(doc)
    // plateau edge cell bordering low ground (west edge) is carved
    expect(walkable[7 * 16 + 5]).toBe(0)
    // plateau interior is walkable
    expect(walkable[7 * 16 + 7]).toBe(1)
    // ramp cells are walkable
    expect(walkable[7 * 16 + 9]).toBe(1)
    expect(walkable[7 * 16 + 11]).toBe(1)
    // low ground next to the cliff (not next to ramp) is walkable — the band
    // is carved on the high side only
    expect(walkable[3 * 16 + 7]).toBe(1)
  })

  it('A* reaches the plateau only via the ramp', () => {
    const doc = cliffDoc()
    const grid = walkGridFromDoc(doc)
    const path = findPath(grid, 2, 7, 7, 7) // low ground → plateau interior
    expect(path).not.toBeNull()
    // path must pass through a ramp cell
    const rampCells = new Set<number>()
    for (let y = 7; y <= 8; y++) for (let x = 9; x <= 12; x++) rampCells.add(y * 16 + x)
    expect(path!.some((c) => rampCells.has(c))).toBe(true)

    // sealing the ramp makes the plateau unreachable
    const sealed = cliffDoc()
    sealed.ramp = Array.from({ length: 16 * 16 }, () => 0)
    const grid2 = walkGridFromDoc(sealed)
    expect(findPath(grid2, 2, 7, 7, 7)).toBeNull()
  })

  it('generated skirmish map v2: starts walkable and mutually reachable', () => {
    const doc = generateMap(1234)
    expect(doc.version).toBe(2)
    const grid = walkGridFromDoc(doc)
    const [a, b] = doc.startLocations
    expect(grid.isWalkableWorld(a.x, a.z)).toBe(true)
    expect(grid.isWalkableWorld(b.x, b.z)).toBe(true)
    const path = findPath(grid, grid.cellX(a.x), grid.cellZ(a.z), grid.cellX(b.x), grid.cellZ(b.z))
    expect(path).not.toBeNull()
  })

  it('derivation is deterministic and identical across calls', () => {
    const doc = generateMap(99)
    const t1 = deriveTerrain(doc)
    const t2 = deriveTerrain(doc)
    expect([...t1.walkable]).toEqual([...t2.walkable])
    expect([...t1.heights]).toEqual([...t2.heights])
  })
})
