import { describe, expect, it } from 'vitest'
import { mapOwners, mapSlotCount, resizeMap, type RtsMapDoc } from '@battlebadger/sim'

// Document surgery the editor performs. It lives in the sim because it is
// fiddly index arithmetic with real edge cases, and because that is where it
// can be tested without a browser.

const doc = (over: Partial<RtsMapDoc> = {}): RtsMapDoc => ({
  version: 2,
  name: 'test',
  seed: 1,
  cols: 8,
  rows: 8,
  cellSize: 1,
  originX: 0,
  originZ: 0,
  startLocations: [
    { x: 1, z: 1 },
    { x: 3, z: 3 },
  ],
  ...over,
})

// row-major grid whose value is its own index, so a reshuffle is visible
const ramp = (cols: number, rows: number): number[] => Array.from({ length: cols * rows }, (_, i) => i)

describe('slots come from the start locations', () => {
  it('counts them, and clamps to the eight the sim supports', () => {
    expect(mapSlotCount(doc())).toBe(2)
    expect(mapSlotCount(doc({ startLocations: Array.from({ length: 12 }, () => ({ x: 1, z: 1 })) }))).toBe(8)
    expect(mapSlotCount(doc({ startLocations: [] }))).toBe(1)
  })

  it('lists war slots too — owners with content but no start location', () => {
    // A MOBA parks its lane creeps in a slot no human ever occupies; the editor
    // still has to offer that owner or the map cannot be authored at all.
    const d = doc({ placed: [{ def: 'creep', owner: 6, x: 1, z: 1 }] })
    expect(mapOwners(d)).toEqual([0, 1, 6])
  })

  it('counts an owner a trigger spawns for', () => {
    const d = doc({
      triggers: [
        {
          id: 't',
          name: 'T',
          events: [{ type: 'mapInit' }],
          conditions: [],
          actions: [{ type: 'spawnUnits', def: 'creep', owner: 7, count: 1, at: { x: 1, z: 1 } }],
        },
      ],
    })
    expect(mapOwners(d)).toContain(7)
  })
})

describe('resizing a map', () => {
  it('grows anchored at the origin, keeping every old cell where it was', () => {
    const d = doc({ texture: ramp(8, 8) })
    const { doc: out } = resizeMap(d, 12, 12)
    expect(out.cols).toBe(12)
    for (let z = 0; z < 8; z++) {
      for (let x = 0; x < 8; x++) expect(out.texture![z * 12 + x], `cell ${x},${z}`).toBe(z * 8 + x)
    }
  })

  it('makes new ground walkable, not a wall', () => {
    // The bug this prevents: layers default to 0, and 0 means BLOCKED, so a
    // grown map would be ringed by an invisible barrier.
    const d = doc({ walkable: Array.from({ length: 64 }, () => 1) })
    const { doc: out } = resizeMap(d, 12, 12)
    expect(out.walkable!.every((v) => v === 1)).toBe(true)
  })

  it('crops when shrinking, and reports what it threw away', () => {
    const d = doc({
      texture: ramp(8, 8),
      doodads: [{ def: 'tree', x: 0.5, z: 0.5 }, { def: 'tree', x: 6.5, z: 6.5 }],
      placed: [{ def: 'peon', owner: 0, x: 6.5, z: 0.5 }],
      startLocations: [{ x: 1, z: 1 }, { x: 6, z: 6 }],
    })
    const r = resizeMap(d, 4, 4)
    expect(r.doc.texture).toEqual([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 24, 25, 26, 27])
    expect(r.doc.doodads).toHaveLength(1)
    expect(r.droppedDoodads).toBe(1)
    expect(r.droppedPlaced).toBe(1)
    expect(r.droppedStarts).toBe(1) // the start at (6,6) is outside 4x4
  })

  it('clips a region that overhangs rather than dropping it', () => {
    const d = doc({ regions: [{ id: 'r', name: 'R', x0: 1, z0: 1, x1: 9, z1: 9 }] })
    const r = resizeMap(d, 5, 5)
    expect(r.doc.regions![0]).toMatchObject({ x1: 5, z1: 5 })
    expect(r.clampedRegions).toBe(1)
    expect(r.droppedRegions).toBe(0)
  })

  it('drops a region that ends up entirely outside', () => {
    const d = doc({ regions: [{ id: 'r', name: 'R', x0: 6, z0: 6, x1: 7, z1: 7 }] })
    const r = resizeMap(d, 5, 5)
    expect(r.doc.regions).toEqual([])
    expect(r.droppedRegions).toBe(1)
  })

  it('leaves the original document untouched', () => {
    const d = doc({ texture: ramp(8, 8), doodads: [{ def: 'tree', x: 6.5, z: 6.5 }] })
    resizeMap(d, 4, 4)
    expect(d.cols).toBe(8)
    expect(d.texture).toHaveLength(64)
    expect(d.doodads).toHaveLength(1)
  })

  it('refuses to make a map too small to hold anything, or absurdly large', () => {
    expect(resizeMap(doc(), 1, 1).doc.cols).toBe(4)
    expect(resizeMap(doc(), 9999, 9999).doc.cols).toBe(512)
  })

  it('only rebuilds the layers the map actually has', () => {
    const d = doc({ texture: ramp(8, 8) }) // no walkable, no cliffLevel
    const { doc: out } = resizeMap(d, 12, 12)
    expect(out.walkable).toBeUndefined()
    expect(out.cliffLevel).toBeUndefined()
    expect(out.texture).toHaveLength(144)
  })
})
