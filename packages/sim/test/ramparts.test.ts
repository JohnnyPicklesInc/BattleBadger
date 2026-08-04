import { describe, expect, it } from 'vitest'
import { setupMatch } from '../src/setup.ts'
import { step } from '../src/step.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { handleOf, spawnUnit, type SimState } from '../src/state.ts'
import { spawnBuilding } from '../src/systems/economy.ts'
import { attackRange } from '../src/systems/upgrades.ts'
import { canReachRampart } from '../src/systems/ramparts.ts'
import { generateMiddleEarth } from '../src/mapgen/middleEarth.ts'
import type { RtsMapDoc } from '../src/mapdoc.ts'

// Wall tops. The feature is "archers on a wall are safe from swords and shoot
// further"; every test here is one clause of that sentence.

const doc: RtsMapDoc = generateMiddleEarth(20260803)
const sim = (): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } => {
  const grid = walkGridFromDoc(doc)
  return { s: setupMatch(doc, grid, 8), grid }
}
// Open desert, far from anything the map placed.
const OPEN = { x: 70, z: 300 }

function wallAt(s: SimState, grid: ReturnType<typeof walkGridFromDoc>, owner: number, x: number, z: number): number {
  const w = spawnBuilding(s, grid, s.def.entIndex.get('wall')!, owner, x, z, false)
  s.faceX[w] = 1
  s.faceZ[w] = 0
  return w
}

describe('wall tops', () => {
  it('walls, gates and towers can be manned; open ground cannot', () => {
    const { s } = sim()
    const st = s.def.stats
    const slots = (id: string): number => st.rampartSlots[s.def.entIndex.get(id)!]
    expect(slots('wall')).toBeGreaterThan(0)
    expect(slots('wall-tower')).toBeGreaterThan(0)
    expect(slots('sally-port')).toBeGreaterThan(0)
    expect(slots('swordsman')).toBe(0)
    expect(slots('watchtower')).toBe(0)
    // A tower stands its men higher than the curtain does.
    const bonus = (id: string): number => st.rampartRange[s.def.entIndex.get(id)!]
    expect(bonus('wall-tower')).toBeGreaterThan(bonus('wall'))
  })

  it('a soldier ordered onto a wall walks there and climbs it', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 0, OPEN.x, OPEN.z)
    const man = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 12, OPEN.z)
    expect(s.onWall[man]).toBe(-1)

    s.playerCount = 8
    step(s, grid, [{ kind: 'garrison', player: 0, units: [handleOf(s, man)], x: 0, z: 0, target: handleOf(s, w) }])
    // Not teleported: he has to cross the ground first, which is the point.
    expect(s.onWall[man], 'he teleported onto the wall').toBe(-1)
    expect(s.wantWall[man]).toBe(w)

    for (let t = 0; t < 200 && s.onWall[man] < 0; t++) step(s, grid, [])
    expect(s.onWall[man], 'he never made it up').toBe(w)
  })

  it('being up there is worth something: more range, and no melee can touch him', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 0, OPEN.x, OPEN.z)
    const archer = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 3, OPEN.z)
    const ground = attackRange(s, archer)

    s.wantWall[archer] = w
    for (let t = 0; t < 60 && s.onWall[archer] < 0; t++) step(s, grid, [])
    expect(s.onWall[archer]).toBe(w)
    expect(attackRange(s, archer), 'height bought no range').toBeGreaterThan(ground)

    // A swordsman cannot reach him; another archer, and a catapult, can.
    const sword = spawnUnit(s, s.def.entIndex.get('swordsman')!, 1, OPEN.x + 2, OPEN.z)
    const bow = spawnUnit(s, s.def.entIndex.get('archer')!, 1, OPEN.x + 8, OPEN.z)
    expect(canReachRampart(s, sword, archer), 'a sword reached a man on a wall').toBe(false)
    expect(canReachRampart(s, bow, archer), 'an archer could not shoot a wall top').toBe(true)
    // …and he can always be reached once he is back on the ground.
    expect(canReachRampart(s, sword, bow)).toBe(true)
  })

  it('a wall only holds so many, and the rest give up rather than mill about', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 0, OPEN.x, OPEN.z)
    const slots = s.def.stats.rampartSlots[s.type[w]]
    const men: number[] = []
    for (let k = 0; k < slots + 3; k++) {
      const m = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 2 - k * 0.4, OPEN.z + 1)
      s.wantWall[m] = w
      men.push(m)
    }
    for (let t = 0; t < 40; t++) step(s, grid, [])
    const up = men.filter((m) => s.onWall[m] === w).length
    expect(up).toBe(slots)
    // Nobody is left queueing forever for a spot that will not come.
    expect(men.every((m) => s.wantWall[m] === -1)).toBe(true)
  })

  it('breaching the wall kills everyone standing on it', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 0, OPEN.x, OPEN.z)
    const men = [0, 1].map((k) => {
      const m = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 2, OPEN.z + k)
      s.wantWall[m] = w
      return m
    })
    for (let t = 0; t < 40; t++) step(s, grid, [])
    expect(men.every((m) => s.onWall[m] === w)).toBe(true)

    s.hp[w] = 0
    step(s, grid, [])
    step(s, grid, [])
    // A garrison that stepped neatly onto the rubble would make breaching a
    // wall pointless, which is the whole reason this cascade exists.
    expect(men.every((m) => s.alive[m] === 0), 'the garrison outlived its wall').toBe(true)
  })

  it('any other order steps him back down', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 0, OPEN.x, OPEN.z)
    const man = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 2, OPEN.z)
    s.wantWall[man] = w
    for (let t = 0; t < 40 && s.onWall[man] < 0; t++) step(s, grid, [])
    expect(s.onWall[man]).toBe(w)

    s.playerCount = 8
    step(s, grid, [
      { kind: 'move', player: 0, units: [handleOf(s, man)], x: OPEN.x - 20, z: OPEN.z },
    ])
    // Otherwise a garrisoned archer accepts a move order, refuses to move, and
    // looks broken.
    expect(s.onWall[man], 'he stayed on the wall after being ordered away').toBe(-1)
    for (let t = 0; t < 60; t++) step(s, grid, [])
    expect(s.posX[man]).toBeLessThan(OPEN.x - 5)
  })

  it('you cannot man the enemy’s wall', () => {
    const { s, grid } = sim()
    const w = wallAt(s, grid, 1, OPEN.x, OPEN.z)
    const man = spawnUnit(s, s.def.entIndex.get('archer')!, 0, OPEN.x - 3, OPEN.z)
    s.playerCount = 8
    step(s, grid, [{ kind: 'garrison', player: 0, units: [handleOf(s, man)], x: 0, z: 0, target: handleOf(s, w) }])
    expect(s.wantWall[man], 'an enemy wall accepted a garrison').toBe(-1)
  })
})
