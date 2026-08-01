import { describe, expect, it } from 'vitest'
import {
  BUILTIN_RULESETS,
  checkModuleFits,
  composeRuleset,
  extractModule,
  installModule,
  moduleRequirements,
  toPack,
  validateGameDef,
  validateRulesetPack,
  type GameDef,
  type RulesetBase,
  type RulesetModule,
} from '@battlebadger/sim'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'
import { BASE_RULES } from '../src/mapgen/factions/shared.ts'
import { FACTION as BADGERS } from '../src/mapgen/factions/badgers.ts'
import { FACTION as HORDE } from '../src/mapgen/factions/horde.ts'

// Rulesets are how rules move between maps. The properties that matter are:
// a module knows what it needs, extraction produces something that stands up
// on its own, and importing can never half-apply.
//
// That composition itself is unchanged by all this is proved elsewhere and
// more strictly — packages/client/test/bakedMaps.test.ts compares the content
// hash of every shipped map against its generator.

const FOUR = generateFourCorners().gameDef!

const MINI_BASE: RulesetBase = {
  schema: 1,
  resources: [{ id: 'gold', name: 'Gold', startAmount: 500 }],
  damageTypes: ['sword'],
  armorTypes: ['infantry'],
  damageTable: [{ damage: 'sword', armor: 'infantry', pct: 100 }],
  abilities: [],
}

const MINI_MOD: RulesetModule = {
  id: 'mini',
  name: 'Mini',
  entities: [
    {
      id: 'grunt',
      name: 'Grunt',
      kind: 'unit',
      radius: 0.4,
      hp: 100,
      armorType: 'infantry',
      cost: [{ resource: 'gold', amount: 50 }],
      visual: { model: 'gen:mini-grunt' },
      combat: { damage: 10, range: 1, acquire: 8, periodTicks: 10, damageType: 'sword' },
    },
  ],
  blueprints: [{ id: 'mini-grunt', seed: 1, palette: { skin: '#8a4' }, parts: [{ shape: 'box', color: 'skin' }] }],
}

describe('a module knows what it needs', () => {
  it('derives its requirements from its entities rather than a declared list', () => {
    const req = moduleRequirements(MINI_MOD)
    expect(req.damageTypes).toEqual(['sword'])
    expect(req.armorTypes).toEqual(['infantry'])
    expect(req.resources).toEqual(['gold'])
    // it carries the blueprint for its own model, so nothing is outstanding
    expect(req.models).toEqual([])
  })

  it('reports a model it wears but does not carry', () => {
    const bare = { ...MINI_MOD, blueprints: undefined }
    expect(moduleRequirements(bare).models).toEqual(['gen:mini-grunt'])
  })

  it('reports entities it references but does not define', () => {
    const ticket: RulesetModule = {
      id: 'ticket-only',
      name: 'Ticket only',
      entities: [
        {
          id: 'h-grunts',
          name: 'Grunts',
          kind: 'unit',
          radius: 0.4,
          hp: 1,
          visual: { model: 'gen:x' },
          horde: { unit: 'grunt', count: 9, spacing: 1 },
        },
      ],
    }
    expect(moduleRequirements(ticket).entities).toEqual(['grunt'])
  })

  it('fits a base that has its vocabulary, and names what is missing when it does not', () => {
    expect(checkModuleFits(MINI_MOD, MINI_BASE)).toEqual([])
    // The failure that matters: a missing damage type is not a crash. The
    // matrix has no row, the multiplier silently defaults to 100%, and the
    // unit ignores every counter it was designed around.
    const noSword: RulesetBase = { ...MINI_BASE, damageTypes: ['arrow'], damageTable: [] }
    expect(checkModuleFits(MINI_MOD, noSword)).toEqual([`damage type "sword" is not in this map's rules`])
    const noGold: RulesetBase = { ...MINI_BASE, resources: [{ id: 'wood', name: 'Wood', startAmount: 0 }] }
    expect(checkModuleFits(MINI_MOD, noGold)).toContain(`resource "gold" is not in this map's rules`)
  })

  it('a real faction fits the base it was written against', () => {
    for (const f of [BADGERS, HORDE]) expect(checkModuleFits(f, BASE_RULES), f.id).toEqual([])
  })
})

describe('extraction brings what the units need', () => {
  it('a horde ticket brings the soldier it spawns', () => {
    const mod = extractModule({ id: 'archers', name: 'Archers', gameDef: FOUR, entityIds: ['h-archers'] })
    const ids = mod.entities.map((e) => e.id)
    expect(ids).toContain('h-archers')
    expect(ids).toContain('archer') // the ticket is useless without it
  })

  it('a building brings what it trains, transitively', () => {
    const mod = extractModule({ id: 'barracks', name: 'Barracks', gameDef: FOUR, entityIds: ['barracks'] })
    const ids = new Set(mod.entities.map((e) => e.id))
    for (const t of FOUR.entities.find((e) => e.id === 'barracks')!.trainer!.trains) {
      expect(ids.has(t), `barracks trains ${t} but the module left it behind`).toBe(true)
    }
  })

  it('brings the abilities its units cast', () => {
    const caster = FOUR.entities.find((e) => (e.abilities?.length ?? 0) > 0)!
    const mod = extractModule({ id: 'caster', name: 'Caster', gameDef: FOUR, entityIds: [caster.id] })
    for (const a of caster.abilities!) {
      expect(mod.abilities?.some((x) => x.id === a.ability), `lost ability ${a.ability}`).toBe(true)
    }
  })

  it('brings the map-authored models its units wear, and no others', () => {
    const def: GameDef = { ...MINI_BASE, id: 'm', name: 'M', entities: MINI_MOD.entities, abilities: [], victory: { mode: 'annihilation' } }
    const spare = { id: 'unused', seed: 2, palette: {}, parts: [{ shape: 'box' as const, color: 'player' }] }
    const mod = extractModule({
      id: 'x',
      name: 'X',
      gameDef: def,
      entityIds: ['grunt'],
      blueprints: [...MINI_MOD.blueprints!, spare],
    })
    expect(mod.blueprints?.map((b) => b.id)).toEqual(['mini-grunt'])
  })

  it('is stable: the same picks produce the same module', () => {
    const a = extractModule({ id: 'k', name: 'K', gameDef: FOUR, entityIds: ['h-archers', 'barracks'] })
    const b = extractModule({ id: 'k', name: 'K', gameDef: FOUR, entityIds: ['barracks', 'h-archers'] })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('refuses an entity the map does not have', () => {
    expect(() => extractModule({ id: 'x', name: 'X', gameDef: FOUR, entityIds: ['nope'] })).toThrow(/unknown entity "nope"/)
  })
})

describe('installing into a map', () => {
  const base: GameDef = { ...MINI_BASE, id: 'm', name: 'M', entities: [], abilities: [], victory: { mode: 'annihilation' } }

  it('adds entities without touching the original', () => {
    const next = installModule(base, MINI_MOD)
    expect(next.entities.map((e) => e.id)).toEqual(['grunt'])
    expect(base.entities).toEqual([]) // the caller decides whether to keep it
  })

  it('is idempotent for shared content, so two packs can both carry the neutrals', () => {
    const once = installModule(base, MINI_MOD)
    expect(installModule(once, MINI_MOD).entities.map((e) => e.id)).toEqual(['grunt'])
    // ...and still matches after a trip through a file, where key order moves
    const reloaded = JSON.parse(JSON.stringify(MINI_MOD)) as RulesetModule
    expect(installModule(once, reloaded).entities).toHaveLength(1)
  })

  it('refuses a DIFFERENT entity under an id the map already has', () => {
    const once = installModule(base, MINI_MOD)
    const impostor: RulesetModule = { ...MINI_MOD, entities: [{ ...MINI_MOD.entities[0], hp: 999 }] }
    expect(() => installModule(once, impostor)).toThrow(/redefines entities this map already has: grunt/)
  })

  it('merges abilities by id, since two modules may share one', () => {
    const ability = { id: 'heal', name: 'Heal', target: 'ally' as const, hpDelta: 10, range: 5, periodTicks: 60 }
    const a: RulesetModule = { ...MINI_MOD, abilities: [ability] }
    const b: RulesetModule = { id: 'b', name: 'B', entities: [{ ...MINI_MOD.entities[0], id: 'grunt2' }], abilities: [ability] }
    const out = installModule(installModule(base, a), b)
    expect(out.abilities.map((x) => x.id)).toEqual(['heal'])
  })
})

describe('the shareable file', () => {
  it('survives a round trip through JSON and still builds a valid game', () => {
    const mod = extractModule({
      id: 'badger-inf',
      name: 'Badger infantry',
      gameDef: FOUR,
      entityIds: ['h-swordsmen', 'h-archers', 'h-spearmen'],
    })
    const pack = toPack({ id: mod.id, name: mod.name, version: 1, base: BASE_RULES }, [mod])
    const reloaded = validateRulesetPack(JSON.parse(JSON.stringify(pack)))
    expect(reloaded.modules[0].entities.map((e) => e.id)).toEqual(mod.entities.map((e) => e.id))

    const { gameDef } = composeRuleset({
      id: 'fresh',
      name: 'Fresh',
      base: reloaded.base!,
      modules: reloaded.modules,
      victory: { mode: 'annihilation' },
    })
    expect(validateGameDef(gameDef)).toEqual([])
  })

  it('rejects files that are not rulesets, or are internally broken', () => {
    const cases: [string, unknown, RegExp][] = [
      ['a map file', { version: 2, name: 'x', cols: 8 }, /not a ruleset file/],
      ['a future schema', { kind: 'bb-ruleset', schema: 9, id: 'a', name: 'A', modules: [] }, /unsupported ruleset schema/],
      ['no modules', { kind: 'bb-ruleset', schema: 1, id: 'a', name: 'A', modules: [] }, /no modules/],
      [
        'a module with no entities',
        { kind: 'bb-ruleset', schema: 1, id: 'a', name: 'A', modules: [{ id: 'm', name: 'M', entities: [] }] },
        /non-empty array/,
      ],
      [
        'two modules with one id',
        {
          kind: 'bb-ruleset',
          schema: 1,
          id: 'a',
          name: 'A',
          modules: [MINI_MOD, { ...MINI_MOD, entities: [{ ...MINI_MOD.entities[0], id: 'other' }] }],
        },
        /duplicate module id/,
      ],
      [
        'a keep that is not one of its own entities',
        { kind: 'bb-ruleset', schema: 1, id: 'a', name: 'A', modules: [{ ...MINI_MOD, keep: 'castle' }] },
        /keep "castle" is not one of its entities/,
      ],
      [
        'a bad model',
        {
          kind: 'bb-ruleset',
          schema: 1,
          id: 'a',
          name: 'A',
          modules: [{ ...MINI_MOD, blueprints: [{ id: 'x', seed: 1, palette: {}, parts: [{ shape: 'blob', color: 'a' }] }] }],
        },
        /unknown shape/,
      ],
    ]
    for (const [what, input, message] of cases) {
      expect(() => validateRulesetPack(input), what).toThrow(message)
    }
  })

  it('rejects a complete ruleset that would not compile as a game', () => {
    // A pack carrying a base claims to be a whole game, so it is held to that:
    // an entity naming a resource the base never declares fails at the door,
    // not at match time on somebody else's machine.
    const broken = toPack({ id: 'b', name: 'B', base: { ...MINI_BASE, resources: [{ id: 'wood', name: 'W', startAmount: 0 }] } }, [
      MINI_MOD,
    ])
    expect(() => validateRulesetPack(broken)).toThrow(/not a valid game/)
  })
})

describe('the shipped factions are the starter library', () => {
  it('every built-in is a valid, complete, self-consistent ruleset', () => {
    expect(BUILTIN_RULESETS.length).toBeGreaterThan(0)
    for (const pack of BUILTIN_RULESETS) {
      expect(() => validateRulesetPack(pack), pack.id).not.toThrow()
      expect(pack.base, `${pack.id} should be startable from a blank map`).toBeDefined()
      for (const m of pack.modules) expect(checkModuleFits(m, pack.base!), pack.id).toEqual([])
    }
  })

  it('two of them can be seated on one map, which is the point of modules', () => {
    const badgers = BUILTIN_RULESETS.find((p) => p.id === 'badgers')!
    const horde = BUILTIN_RULESETS.find((p) => p.id === 'horde')!
    const { gameDef } = composeRuleset({
      id: 'both',
      name: 'Both',
      base: badgers.base!,
      modules: [...badgers.modules, ...horde.modules],
      victory: { mode: 'annihilation' },
    })
    expect(gameDef.entities.some((e) => e.id === 'fortress')).toBe(true)
    expect(gameDef.entities.some((e) => e.id === 'dark-fortress')).toBe(true)
  })

  it('a map only ships the factions it seats', () => {
    // The regression this guards: one shared def gave a two-player badger map
    // orc and gunship definitions it could never spawn.
    const badgers = BUILTIN_RULESETS.find((p) => p.id === 'badgers')!
    const { gameDef } = composeRuleset({
      id: 'solo',
      name: 'Solo',
      base: badgers.base!,
      modules: badgers.modules,
      victory: { mode: 'annihilation' },
    })
    expect(gameDef.entities.some((e) => e.id === 'dark-fortress')).toBe(false)
  })
})
