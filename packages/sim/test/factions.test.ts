import { describe, expect, it } from 'vitest'
import { expansionRings, setupMatch, walkGridFromDoc } from '@battlebadger/sim'
import { generateDunhollow } from '../src/mapgen/dunhollow.ts'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'

// Four Corners is the map that seats both factions, so its composed def is
// where the badger/Horde comparison lives. Dunhollow no longer knows orcs
// exist, which is the point of composing per map.
const FOUR = generateFourCorners().gameDef!
const ent = (id: string) => FOUR.entities.find((e) => e.id === id)!

describe('two factions on one ruleset', () => {
  // A faction is not an engine concept: it is which keep you start with. The
  // keep decides its expansion plot, the plot decides which buildings you may
  // raise, and those decide what you can train.
  it('each keep gates a different building set', () => {
    // the first ring is the build plots; later rings are the tower pads
    const badgerPlot = expansionRings(ent('fortress'))[0].plot
    const hordePlot = expansionRings(ent('dark-fortress'))[0].plot
    expect(badgerPlot).not.toBe(hordePlot)
    const badgerBuilds = new Set(ent(badgerPlot).plot!.accepts)
    const hordeBuilds = new Set(ent(hordePlot).plot!.accepts)
    // barracks are badger-only, the orc pit is Horde-only
    expect(badgerBuilds.has('barracks')).toBe(true)
    expect(hordeBuilds.has('barracks')).toBe(false)
    expect(hordeBuilds.has('orc-pit')).toBe(true)
    expect(badgerBuilds.has('orc-pit')).toBe(false)
    // both may still take a farm, so the economy game is shared
    expect(badgerBuilds.has('farm') && hordeBuilds.has('farm')).toBe(true)
  })

  it('the ogre belongs to the Horde, and is gated behind their pit', () => {
    const trainers = FOUR.entities.filter((e) => e.trainer?.trains.includes('h-ogre'))
    expect(trainers.map((e) => e.id)).toEqual(['ogre-pen'])
    // and the pen itself is not an opening move
    expect(ent('ogre-pen').requires).toContain('orc-pit')
    // the badgers' siege works no longer sells it
    expect(ent('siege-works').trainer!.trains).not.toContain('h-ogre')
  })

  it('Horde infantry is cheaper per body and comes in bigger battalions', () => {
    const orcs = ent('h-orcs')
    const swords = ent('h-swordsmen')
    const perOrc = orcs.cost![0].amount / orcs.horde!.count
    const perSword = swords.cost![0].amount / swords.horde!.count
    expect(perOrc, 'an orc should be cheaper than a swordsman').toBeLessThan(perSword)
    expect(orcs.horde!.count, 'an orc horde should outnumber a badger one').toBeGreaterThan(
      swords.horde!.count,
    )
    // ...and weaker body for body, or it would simply be better
    expect(ent('orc').hp).toBeLessThan(ent('swordsman').hp)
    expect(ent('orc').combat!.damage).toBeLessThan(ent('swordsman').combat!.damage)
  })

  it('the Horde still has an answer to cavalry', () => {
    // every faction needs one, or horses just farm it
    expect(ent('orc-pikeman').chargeGuard).toBeGreaterThan(0)
    expect(ent('orc-pikeman').combat!.damageType).toBe('spear')
  })

  it('Four Corners seats both factions, on opposite diagonals', () => {
    const doc = generateFourCorners()
    const keepOf = new Map<number, string>()
    for (const p of doc.placed ?? []) {
      if (p.def === 'fortress' || p.def === 'dark-fortress') keepOf.set(p.owner, p.def)
    }
    expect(keepOf.size).toBe(4)
    // BASES are NW, NE, SW, SE — diagonals share a faction
    expect(keepOf.get(0)).toBe(keepOf.get(3))
    expect(keepOf.get(1)).toBe(keepOf.get(2))
    expect(keepOf.get(0)).not.toBe(keepOf.get(1))
  })

  it('both factions field an army at setup', () => {
    const doc = generateFourCorners()
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 4)
    const orcTy = s.def.entIndex.get('orc')!
    const swordTy = s.def.entIndex.get('swordsman')!
    let orcs = 0
    let swords = 0
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i]) continue
      if (s.type[i] === orcTy) orcs++
      else if (s.type[i] === swordTy) swords++
    }
    expect(orcs, 'no orcs fielded').toBeGreaterThan(0)
    expect(swords, 'no badgers fielded').toBeGreaterThan(0)
    expect(orcs, 'the Horde should field more bodies').toBeGreaterThan(swords)
  })

  it('a badgers-only map carries no Horde definitions at all', () => {
    const solo = generateDunhollow(5).gameDef!
    const ids = new Set(solo.entities.map((e) => e.id))
    expect(ids.has('swordsman')).toBe(true)
    expect(ids.has('orc'), 'Dunhollow should not ship orcs').toBe(false)
    expect(ids.has('skiff'), 'Dunhollow should not ship the Compact').toBe(false)
  })

  it('the badger ruleset still works on its own map', () => {
    const doc = generateDunhollow(5)
    const s = setupMatch(doc, walkGridFromDoc(doc), 2)
    // Dunhollow seats badgers only; the Horde defs exist but go unused
    let keeps = 0
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.def.entities[s.type[i]].id === 'fortress') keeps++
    }
    expect(keeps).toBe(2)
  })
})

// composeDef is where "balance is per-map" lives.
describe('composing a def per map', () => {
  it('a map seats only the factions it uses', async () => {
    const { generateRidgeCrossing } = await import('../src/mapgen/skirmishRidge.ts')
    const ridge = generateRidgeCrossing().gameDef!
    const ids = new Set(ridge.entities.map((e) => e.id))
    expect(ids.has('skiff'), 'Ridge Crossing seats the Compact').toBe(true)
    expect(ids.has('swordsman'), 'and the Badgers').toBe(true)
    expect(ids.has('orc'), 'but not the Horde').toBe(false)
  })

  it('tuning applies to one map and cannot leak into another', async () => {
    const { generateRidgeCrossing } = await import('../src/mapgen/skirmishRidge.ts')
    const { generateFourCorners } = await import('../src/mapgen/fourCorners.ts')
    const ridge = generateRidgeCrossing().gameDef!
    const four = generateFourCorners().gameDef!
    const archerOn = (d: typeof ridge) => d.entities.find((e) => e.id === 'archer')!.combat!.range
    // Ridge Crossing lengthens the archer; Four Corners must be untouched
    expect(archerOn(ridge)).toBe(14)
    expect(archerOn(four)).toBe(13)
  })

  it('a deep tune patches one field and keeps the rest of the block', async () => {
    const { composeDef } = await import('../src/mapgen/factions/compose.ts')
    const { FACTION: BADGERS } = await import('../src/mapgen/factions/badgers.ts')
    const d = composeDef({
      id: 't', name: 'T', factions: [BADGERS], victory: { mode: 'annihilation' },
      tune: { archer: { combat: { damage: 99 } } },
    })
    const c = d.entities.find((e) => e.id === 'archer')!.combat!
    expect(c.damage).toBe(99)
    expect(c.range, 'the rest of the weapon should survive the patch').toBeGreaterThan(0)
    expect(c.hits, 'including its ability to shoot upward').toBe('both')
  })

  it('refuses a tune for an entity that is not there', async () => {
    const { composeDef } = await import('../src/mapgen/factions/compose.ts')
    const { FACTION: BADGERS } = await import('../src/mapgen/factions/badgers.ts')
    // a typo'd id would otherwise be a balance change that silently did nothing
    expect(() =>
      composeDef({
        id: 't', name: 'T', factions: [BADGERS], victory: { mode: 'annihilation' },
        tune: { skiff: { hp: 1 } },
      }),
    ).toThrow(/unknown entity "skiff"/)
  })
})
