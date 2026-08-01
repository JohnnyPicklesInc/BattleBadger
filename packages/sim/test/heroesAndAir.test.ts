import { describe, expect, it } from 'vitest'
import { setupMatch, spawnUnit, step, walkGridFromDoc } from '@battlebadger/sim'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'

// Eagles, fell beasts and the four heroes. What matters is not that they exist
// but that they sit inside the counter web rather than beside it.

const doc = generateFourCorners()
const DEF = doc.gameDef!
const ent = (id: string) => DEF.entities.find((e) => e.id === id)!

const fresh = () => {
  const grid = walkGridFromDoc(doc)
  return { grid, s: setupMatch(doc, grid, 4) }
}

describe('the flyers', () => {
  it('fly, and can be answered only by something that shoots up', () => {
    for (const id of ['eagle', 'fell-beast']) {
      expect(ent(id).flying, id).toBe(true)
      // Cavalry armour is the counter: arrows hit it at full rate, swords at
      // 75%, and spears — which would shred it at 300% — cannot reach it.
      expect(ent(id).armorType, id).toBe('cavalry')
      expect(ent(id).combat!.hits, id).toBe('both')
    }
    expect(ent('archer').combat!.hits).toBe('both')
    expect(ent('orc-archer').combat!.hits).toBe('both')
    expect(ent('spearman').combat!.hits ?? 'ground').toBe('ground')
  })

  it('ignores the ground a walker has to path around', () => {
    // The whole point of air on this ruleset: it is a way past the wall.
    const { grid, s } = fresh()
    const wall = { x: 88, z: 20 } // mountain spur on Four Corners
    expect(grid.isWalkableWorld(wall.x, wall.z)).toBe(false)
    const bird = spawnUnit(s, s.def.entIndex.get('eagle')!, 0, wall.x - 12, wall.z)
    s.order[bird] = 1 // Move
    s.destX[bird] = wall.x + 12
    s.destZ[bird] = wall.z
    s.homeX[bird] = s.destX[bird]
    s.homeZ[bird] = s.destZ[bird]
    const startX = s.posX[bird]
    for (let t = 0; t < 120; t++) step(s, grid, [])
    expect(s.posX[bird], 'it should have crossed the spur').toBeGreaterThan(startX + 6)
  })

  it('a ground-only weapon cannot touch it at all', () => {
    // The reason air is worth its price: swords and spears are simply not an
    // answer, however many of them there are.
    const { grid, s } = fresh()
    const bird = spawnUnit(s, s.def.entIndex.get('eagle')!, 0, 88, 88)
    for (let k = 0; k < 12; k++) spawnUnit(s, s.def.entIndex.get('orc')!, 1, 84 + k * 0.7, 90)
    const hp0 = s.hp[bird]
    for (let t = 0; t < 300; t++) step(s, grid, [])
    expect(s.hp[bird], 'twelve orcs should not have scratched it').toBe(hp0)
  })

  it('archers are the answer, and it takes a real body of them', () => {
    const { grid, s } = fresh()
    const bird = spawnUnit(s, s.def.entIndex.get('eagle')!, 0, 88, 88)
    // Two battalions' worth, spread wide so one stoop does not wipe them.
    for (let k = 0; k < 24; k++) {
      spawnUnit(s, s.def.entIndex.get('orc-archer')!, 1, 78 + (k % 12) * 1.7, 96 + Math.floor(k / 12) * 2)
    }
    for (let t = 0; t < 900 && s.alive[bird]; t++) step(s, grid, [])
    expect(s.alive[bird], 'massed archery should bring it down').toBe(0)
  })

})

describe('the heroes', () => {
  it('are hordes of one, so they hold veterancy', () => {
    for (const id of ['h-marshal', 'h-ranger', 'h-warg-chief', 'h-marksman']) {
      expect(ent(id).horde!.count, id).toBe(1)
    }
  })

  it('cast what they carry, and the def carries what they cast', () => {
    const abilities = new Set(DEF.abilities.map((a) => a.id))
    for (const id of ['marshal', 'ranger', 'warg-chief', 'marksman']) {
      const used = ent(id).abilities ?? []
      expect(used.length, id).toBeGreaterThan(0)
      for (const a of used) expect(abilities.has(a.ability), `${id} casts missing ${a.ability}`).toBe(true)
    }
  })

  it('the mounted heroes are still cavalry, so pikes still answer them', () => {
    // A hero is a very good unit, not an exception to the counter web.
    for (const id of ['marshal', 'warg-chief']) {
      expect(ent(id).armorType, id).toBe('cavalry')
      expect(ent(id).combat!.charge, id).toBeDefined()
    }
    // spear vs cavalry is the 300% row
    const row = DEF.damageTable!.find((m) => m.damage === 'spear' && m.armor === 'cavalry')!
    expect(row.pct).toBeGreaterThan(100)
  })

  it('a lone hero loses to a battalion of the line troops he outclasses', () => {
    // The check that matters for a hero: strong, not unanswerable.
    const { grid, s } = fresh()
    const hero = spawnUnit(s, s.def.entIndex.get('marshal')!, 0, 88, 88)
    const mob: number[] = []
    for (let k = 0; k < 14; k++) mob.push(spawnUnit(s, s.def.entIndex.get('orc-pikeman')!, 1, 84 + (k % 7) * 1.1, 94 + Math.floor(k / 7) * 1.1))
    for (let t = 0; t < 900 && s.alive[hero]; t++) step(s, grid, [])
    expect(s.alive[hero], 'a pike battalion should bring a mounted hero down').toBe(0)
  })

  it('the archer heroes outrange the line archer they lead', () => {
    expect(ent('ranger').combat!.range).toBeGreaterThan(ent('archer').combat!.range)
    expect(ent('marksman').combat!.range).toBeGreaterThan(ent('orc-archer').combat!.range)
  })
})

describe('the new buildings gate the new units', () => {
  it('air is behind a building, and that building is behind another', () => {
    expect(ent('eyrie').trainer!.trains).toContain('h-eagles')
    expect(ent('eyrie').requires).toContain('archery-range')
    expect(ent('fell-roost').trainer!.trains).toContain('h-fell-beasts')
    expect(ent('fell-roost').requires).toContain('orc-pit')
    // ...and each faction's plot will actually accept the new building
    expect(ent('fortress-plot').plot!.accepts).toContain('eyrie')
    expect(ent('horde-plot').plot!.accepts).toContain('fell-roost')
  })

  it('every hero is trainable somewhere', () => {
    const trained = new Set(DEF.entities.flatMap((e) => e.trainer?.trains ?? []))
    for (const id of ['h-marshal', 'h-ranger', 'h-warg-chief', 'h-marksman', 'h-eagles', 'h-fell-beasts']) {
      expect(trained.has(id), `${id} is not sold anywhere`).toBe(true)
    }
  })
})
