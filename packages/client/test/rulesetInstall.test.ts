import { describe, expect, it } from 'vitest'
import { BUILTIN_RULESETS, toPack, validateGameDef, type GameDef, type RtsMapDoc, type RulesetPack } from '@battlebadger/sim'
import { describeRuleset, installRuleset } from '../src/rulesetLibrary.ts'

// Installing is the step that touches somebody's map, so the contract is:
// it either produces a complete result or throws, and it never half-applies.

const blankDoc = (gameDef?: GameDef): RtsMapDoc => ({
  version: 2,
  name: 'test',
  seed: 1,
  cols: 8,
  rows: 8,
  cellSize: 1,
  originX: 0,
  originZ: 0,
  startLocations: [],
  gameDef,
})

const BADGERS = BUILTIN_RULESETS.find((p) => p.id === 'badgers')!
const HORDE = BUILTIN_RULESETS.find((p) => p.id === 'horde')!

describe('installing a ruleset into a map', () => {
  it('seeds a blank map with the pack’s own physics', () => {
    const doc = blankDoc()
    const out = installRuleset(doc, BADGERS)
    expect(out.gameDef.damageTypes).toEqual(BADGERS.base!.damageTypes)
    expect(out.gameDef.entities.some((e) => e.id === 'fortress')).toBe(true)
    expect(validateGameDef(out.gameDef)).toEqual([])
    expect(out.notes.join(' ')).toMatch(/adopted the damage and economy rules/)
  })

  it('leaves the map untouched — the caller decides whether to keep the result', () => {
    const doc = blankDoc()
    installRuleset(doc, BADGERS)
    expect(doc.gameDef).toBeUndefined()
    expect(doc.blueprints).toBeUndefined()
  })

  it('layers a second faction onto a map that already has rules', () => {
    const doc = blankDoc(installRuleset(blankDoc(), BADGERS).gameDef)
    const out = installRuleset(doc, HORDE)
    expect(out.gameDef.entities.some((e) => e.id === 'fortress')).toBe(true)
    expect(out.gameDef.entities.some((e) => e.id === 'dark-fortress')).toBe(true)
    // Both packs carry the neutral structures. Shared content installing twice
    // must be a no-op, not a collision.
    expect(out.gameDef.entities.filter((e) => e.id === 'farm')).toHaveLength(1)
    expect(validateGameDef(out.gameDef)).toEqual([])
    expect(out.notes.join(' ')).toMatch(/kept this map's own damage and economy rules/)
  })

  it('refuses a pack whose units speak a vocabulary this map does not have', () => {
    const alien: RulesetPack = {
      ...HORDE,
      base: undefined,
      modules: HORDE.modules.map((m) => ({
        ...m,
        entities: m.entities.map((e) => (e.combat ? { ...e, combat: { ...e.combat, damageType: 'plasma' } } : e)),
      })),
    }
    const doc = blankDoc(installRuleset(blankDoc(), BADGERS).gameDef)
    // The failure this prevents is silent: with no 'plasma' row the matrix
    // returns 100% against everything and the counter web quietly stops.
    expect(() => installRuleset(doc, alien)).toThrow(/damage type "plasma" is not in this map's rules/)
    expect(doc.gameDef!.entities.some((e) => e.id === 'dark-fortress')).toBe(false)
  })

  it('refuses an add-on when the map has no rules to add it to', () => {
    const addon = toPack({ id: 'a', name: 'Add-on' }, HORDE.modules)
    expect(() => installRuleset(blankDoc(), addon)).toThrow(/needs a map that already has rules/)
  })

  it('refuses a pack that would redefine a unit under a name already in use', () => {
    const impostor: RulesetPack = {
      ...BADGERS,
      id: 'impostor',
      name: 'Impostor',
      modules: BADGERS.modules.map((m) => ({ ...m, entities: m.entities.map((e) => ({ ...e, hp: e.hp + 1 })) })),
    }
    const doc = blankDoc(installRuleset(blankDoc(), BADGERS).gameDef)
    expect(() => installRuleset(doc, impostor)).toThrow(/redefines entities this map already has/)
  })
})

describe('models travel with the units', () => {
  const withModel: RulesetPack = {
    ...BADGERS,
    id: 'modelled',
    name: 'Modelled',
    modules: BADGERS.modules.map((m, i) =>
      i === 0 ? { ...m, blueprints: [{ id: 'pack-model', seed: 3, palette: {}, parts: [{ shape: 'box' as const, color: 'player' }] }] } : m,
    ),
  }

  it('copies the pack’s blueprints into the map', () => {
    const out = installRuleset(blankDoc(), withModel)
    expect(out.blueprints?.map((b) => b.id)).toContain('pack-model')
  })

  it('keeps the map’s own version of a model the pack also carries', () => {
    // An author who edited a shape should not have it reverted by importing
    // the pack it came from.
    const mine = { id: 'pack-model', seed: 99, palette: {}, parts: [{ shape: 'sphere' as const, color: 'player' }] }
    const doc = { ...blankDoc(), blueprints: [mine] }
    const out = installRuleset(doc, withModel)
    expect(out.blueprints?.find((b) => b.id === 'pack-model')).toBe(mine)
    expect(out.notes.join(' ')).toMatch(/kept this map's version of the model "pack-model"/)
  })
})

describe('the shelf summarises what a pack is', () => {
  it('says whether it is a whole game or an add-on', () => {
    expect(describeRuleset(BADGERS)).toMatch(/full rules/)
    expect(describeRuleset(toPack({ id: 'a', name: 'A' }, HORDE.modules))).toMatch(/add-on/)
    expect(describeRuleset(BADGERS)).toMatch(/\d+ entities/)
  })
})
