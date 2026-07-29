import { describe, expect, it } from 'vitest'
import {
  SKIRMISH_DEF,
  WalkGrid,
  compileGameDef,
  createSim,
  despawn,
  handleOf,
  resolveHandle,
  spawnUnit,
  step,
  validateGameDef,
  type GameDef,
} from '@battlebadger/sim'

const def = compileGameDef(SKIRMISH_DEF)

function openGrid(size = 30): WalkGrid {
  const walkable = new Uint8Array(size * size).fill(1)
  return new WalkGrid(size, size, 1, 0, 0, walkable, new Float64Array(size * size))
}

describe('GameDef compile', () => {
  it('skirmish preset validates and compiles', () => {
    expect(validateGameDef(SKIRMISH_DEF)).toEqual([])
    expect(def.entities.length).toBe(3)
    expect(def.stats.damage[def.entIndex.get('grunt')!]).toBe(9)
    expect(def.stats.autoAcquire[def.entIndex.get('priest')!]).toBe(2)
    expect(def.stats.allyAb[def.entIndex.get('priest')!]).toBe(def.abIndex.get('heal')!)
    expect(def.defHash).toBeGreaterThan(0)
  })

  it('rejects bad references', () => {
    const bad = JSON.parse(JSON.stringify(SKIRMISH_DEF)) as GameDef
    bad.entities[0].requires = ['nonexistent']
    expect(() => compileGameDef(bad)).toThrow(/unknown requires/)
  })

  it('defHash changes when the def changes', () => {
    const tweaked = JSON.parse(JSON.stringify(SKIRMISH_DEF)) as GameDef
    tweaked.entities[0].hp = 71
    expect(compileGameDef(tweaked).defHash).not.toBe(def.defHash)
  })
})

describe('entity handles + free list', () => {
  it('recycled slots invalidate stale handles', () => {
    const grid = openGrid()
    const s = createSim(1, def)
    const a = spawnUnit(s, 0, 0, 5, 5)
    const staleHandle = handleOf(s, a)
    expect(resolveHandle(s, staleHandle)).toBe(a)
    despawn(s, a)
    expect(resolveHandle(s, staleHandle)).toBe(-1)
    // slot is recycled with a bumped generation
    const b = spawnUnit(s, 0, 1, 6, 6)
    expect(b).toBe(a)
    expect(resolveHandle(s, staleHandle)).toBe(-1)
    expect(resolveHandle(s, handleOf(s, b))).toBe(b)
    // stale-handle command is a no-op even though the slot is alive again
    step(s, grid, [{ kind: 'move', player: 0, units: [staleHandle], x: 20, z: 20 }])
    for (let t = 0; t < 5; t++) step(s, grid, [])
    expect(s.order[b]).toBe(0)
  })

  it('spawn and death emit events', () => {
    const grid = openGrid()
    const s = createSim(2, def)
    const a = spawnUnit(s, 0, 0, 5, 5)
    expect(s.events.some((e) => e.t === 'spawned' && e.id === a)).toBe(true)
    s.hp[a] = 0
    step(s, grid, [])
    expect(s.events.some((e) => e.t === 'died' && e.id === a)).toBe(true)
  })
})
