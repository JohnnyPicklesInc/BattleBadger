import { describe, expect, it } from 'vitest'
import {
  SKIRMISH_DEF,
  WalkGrid,
  compileGameDef,
  createSim,
  handleOf,
  spawnUnit,
  step,
  type PlayerCommand,
  type SimState,
} from '@battlebadger/sim'

const def = compileGameDef(SKIRMISH_DEF)
const PRIEST = def.entIndex.get('priest')!
const GRUNT = def.entIndex.get('grunt')!
const HEAL = def.abIndex.get('heal')!
const GRUNT_HP = def.stats.maxHp[GRUNT]

function openGrid(size = 40): WalkGrid {
  const walkable = new Uint8Array(size * size).fill(1)
  return new WalkGrid(size, size, 1, 0, 0, walkable, new Float64Array(size * size))
}

function hurtGrunt(s: SimState, owner: number, x: number, z: number, hp: number): number {
  const id = spawnUnit(s, GRUNT, owner, x, z)
  s.hp[id] = hp
  return id
}

describe('heal (as generic ability)', () => {
  it('priest auto-acquires an injured ally, walks over, and heals to full', () => {
    const grid = openGrid()
    const s = createSim(1, def)
    const priest = spawnUnit(s, PRIEST, 0, 10, 10)
    const hurt = hurtGrunt(s, 0, 16, 10, 20)
    for (let t = 0; t < 120 && s.hp[hurt] < GRUNT_HP; t++) step(s, grid, [])
    expect(s.hp[hurt]).toBe(GRUNT_HP)
    step(s, grid, [])
    expect(s.target[priest]).toBe(-1)
  })

  it('priest never targets enemies and cannot damage', () => {
    const grid = openGrid()
    const s = createSim(2, def)
    const priest = spawnUnit(s, PRIEST, 0, 10, 10)
    const enemy = hurtGrunt(s, 1, 13, 10, 20)
    for (let t = 0; t < 40; t++) step(s, grid, [])
    expect(s.target[priest]).toBe(-1)
    expect(s.hp[enemy]).toBe(20)
  })

  it('manual ability command locks onto the chosen ally; non-casters ignore it', () => {
    const grid = openGrid()
    const s = createSim(3, def)
    const priest = spawnUnit(s, PRIEST, 0, 10, 10)
    const grunt = spawnUnit(s, GRUNT, 0, 11, 12)
    hurtGrunt(s, 0, 12, 10, 30) // nearer injured ally auto-acquire would pick
    const hurtFar = hurtGrunt(s, 0, 20, 10, 30)
    const cmd: PlayerCommand = {
      kind: 'ability',
      ability: HEAL,
      player: 0,
      units: [handleOf(s, priest), handleOf(s, grunt)],
      x: 0,
      z: 0,
      target: handleOf(s, hurtFar),
    }
    step(s, grid, [cmd])
    expect(s.target[priest]).toBe(hurtFar)
    expect(s.target[grunt]).toBe(-1)
    for (let t = 0; t < 150 && s.hp[hurtFar] < GRUNT_HP; t++) step(s, grid, [])
    expect(s.hp[hurtFar]).toBe(GRUNT_HP)
  })

  it('ability validation: enemy target, self-target, and unknown ability are rejected', () => {
    const grid = openGrid()
    const s = createSim(4, def)
    const priest = spawnUnit(s, PRIEST, 0, 10, 10)
    const enemy = hurtGrunt(s, 1, 30, 30, 20)
    const h = handleOf(s, priest)
    step(s, grid, [{ kind: 'ability', ability: HEAL, player: 0, units: [h], x: 0, z: 0, target: handleOf(s, enemy) }])
    expect(s.target[priest]).toBe(-1)
    step(s, grid, [{ kind: 'ability', ability: HEAL, player: 0, units: [h], x: 0, z: 0, target: h }])
    expect(s.target[priest]).toBe(-1)
    step(s, grid, [{ kind: 'ability', ability: 99, player: 0, units: [h], x: 0, z: 0, target: h }])
    expect(s.target[priest]).toBe(-1)
  })

  it('healing never exceeds max hp', () => {
    const grid = openGrid()
    const s = createSim(5, def)
    spawnUnit(s, PRIEST, 0, 10, 10)
    const hurt = hurtGrunt(s, 0, 11, 10, GRUNT_HP - 1)
    for (let t = 0; t < 60; t++) {
      step(s, grid, [])
      expect(s.hp[hurt]).toBeLessThanOrEqual(GRUNT_HP)
    }
    expect(s.hp[hurt]).toBe(GRUNT_HP)
  })
})
