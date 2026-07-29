import { describe, expect, it } from 'vitest'
import { handleOf, setupMatch, spawnHorde, spawnUnit, step, walkGridFromDoc } from '@battlebadger/sim'
import { DUNHOLLOW_DEF } from '../src/mapgen/dunhollow.ts'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'

const doc = generateFourCorners()
const ent = (id: string) => DUNHOLLOW_DEF.entities.find((e) => e.id === id)!

/** Fight two forces and report survivors. */
function clash(a: string, an: number, b: string, bn: number): { a: number; b: number } {
  const grid = walkGridFromDoc(doc)
  const s = setupMatch(doc, grid, 1)
  const A: number[] = []
  const B: number[] = []
  for (let k = 0; k < an; k++) A.push(...spawnHorde(s, grid, s.def.entIndex.get(a)!, 0, 60, 80 + k * 7, 1, 0))
  for (let k = 0; k < bn; k++) B.push(...spawnHorde(s, grid, s.def.entIndex.get(b)!, 1, 100, 80 + k * 7, -1, 0))
  step(s, grid, [{ kind: 'attackMove', player: 0, units: A.map((i) => handleOf(s, i)), x: 100, z: 88 }])
  step(s, grid, [{ kind: 'attackMove', player: 1, units: B.map((i) => handleOf(s, i)), x: 60, z: 88 }])
  for (let t = 0; t < 900; t++) {
    step(s, grid, [])
    if (A.every((i) => !s.alive[i]) || B.every((i) => !s.alive[i])) break
  }
  return { a: A.filter((i) => s.alive[i]).length, b: B.filter((i) => s.alive[i]).length }
}

describe('the air layer', () => {
  it('ground-only is the default, so anti-air must be opted into', () => {
    // The whole counter web rests on this. If it ever flips back to 'both', a
    // swordsman swats a gunship and flight is worthless.
    expect(ent('swordsman').combat!.hits).toBeUndefined()
    expect(ent('archer').combat!.hits).toBe('both')
    expect(ent('lancer').combat!.hits).toBe('air')
    expect(ent('skiff').combat!.hits).toBe('ground')
  })

  it('melee and swarms simply cannot touch a flyer', () => {
    expect(clash('h-skiffs', 2, 'h-swordsmen', 3)).toEqual({ a: 8, b: 0 })
    // 75 orcs lose to 8 skiffs without landing a hit — mass is no answer
    expect(clash('h-skiffs', 2, 'h-orcs', 5)).toEqual({ a: 8, b: 0 })
  })

  it('anything that shoots upward answers it', () => {
    const vsArchers = clash('h-skiffs', 2, 'h-archers', 3)
    expect(vsArchers.a, 'archers should shoot skiffs down').toBe(0)
    const vsLancers = clash('h-skiffs', 2, 'h-lancers', 2)
    expect(vsLancers.a, 'dedicated AA should shoot skiffs down').toBe(0)
  })

  it('a dedicated anti-air unit is helpless against ground', () => {
    const r = clash('h-lancers', 2, 'h-swordsmen', 2)
    expect(r.a, 'lancers should lose to infantry they cannot shoot').toBe(0)
    expect(r.b).toBe(18)
  })

  it('a flyer crosses terrain that would stop an army', () => {
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 1)
    const MID = doc.cols / 2
    // drop a skiff on one side of a mountain arm and send it straight over
    const skiff = spawnUnit(s, s.def.entIndex.get('skiff')!, 0, MID, 40)
    const target = { x: MID, z: 120 }
    // the direct line is through the mountains: no ground unit could walk it
    expect(grid.lineWalkable(MID, 40, target.x, target.z)).toBe(false)
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, skiff)], x: target.x, z: target.z }])
    for (let t = 0; t < 400 && Math.abs(s.posZ[skiff] - target.z) > 2; t++) step(s, grid, [])
    expect(Math.abs(s.posZ[skiff] - target.z), 'the skiff did not fly over').toBeLessThan(3)
  })

  it('a flyer cannot be ridden down or shoved', () => {
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 1)
    const skiff = spawnUnit(s, s.def.entIndex.get('skiff')!, 0, 60, 88)
    // uncrushable by default, so a charge is refused rather than landing
    expect(s.def.stats.crushableLevel[s.type[skiff]]).toBeGreaterThan(1000)
    spawnUnit(s, s.def.entIndex.get('rider')!, 1, 40, 88)
    const z0 = s.posZ[skiff]
    for (let t = 0; t < 120; t++) step(s, grid, [])
    expect(s.posZ[skiff], 'a flyer got shoved').toBeCloseTo(z0, 1)
  })
})
