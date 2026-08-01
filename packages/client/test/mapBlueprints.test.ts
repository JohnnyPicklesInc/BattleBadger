import { afterEach, describe, expect, it } from 'vitest'
import { validateBlueprints, type GenBlueprint } from '@battlebadger/sim'
import { GEN_BLUEPRINTS, findBlueprint, setMapBlueprints, useMapBlueprints } from '../src/gen/registry.ts'
import { genGeometry, genGroups } from '../src/gen/build.ts'
import { validateMap } from '../src/editor/editor.ts'
import { SKIRMISH_DEF, generateMap, type GameDef } from '@battlebadger/sim'

// A map can carry its own procedural models. They are authored by whoever made
// the map, so the contract is: the map wins over the built-ins, and nothing a
// map file says can throw during rendering.

const RED: GenBlueprint = {
  id: 'test-marker',
  seed: 4,
  palette: { hull: '#ff0000' },
  parts: [{ shape: 'box', color: 'hull', size: [1, 2, 1] }],
}

afterEach(() => setMapBlueprints(undefined))

describe('map-authored blueprints', () => {
  it('resolve alongside the built-ins', () => {
    expect(findBlueprint('test-marker')).toBeUndefined()
    setMapBlueprints([RED])
    expect(findBlueprint('test-marker')).toBe(RED)
    expect(genGeometry('test-marker')).not.toBeNull()
  })

  it('override a built-in of the same id, for that map only', () => {
    const id = Object.keys(GEN_BLUEPRINTS)[0]
    const builtIn = GEN_BLUEPRINTS[id]
    setMapBlueprints([{ ...RED, id }])
    expect(findBlueprint(id)).not.toBe(builtIn)
    setMapBlueprints(undefined)
    expect(findBlueprint(id)).toBe(builtIn)
  })

  it('leave the built-ins reachable', () => {
    const id = Object.keys(GEN_BLUEPRINTS)[0]
    setMapBlueprints([RED])
    expect(findBlueprint(id)).toBe(GEN_BLUEPRINTS[id])
  })

  it('load from a doc, and an absent list clears the previous map', () => {
    useMapBlueprints({ blueprints: [RED] })
    expect(findBlueprint('test-marker')).toBe(RED)
    useMapBlueprints({})
    expect(findBlueprint('test-marker')).toBeUndefined()
    useMapBlueprints(null)
    expect(findBlueprint('test-marker')).toBeUndefined()
  })
})

describe('a malformed blueprint degrades instead of breaking', () => {
  it('costs the author that one model and no others', () => {
    const bad = { id: 'broken', seed: 1, palette: {}, parts: [{ shape: 'trapezoid', color: 'hull' }] }
    setMapBlueprints([bad as unknown as GenBlueprint, RED])
    expect(findBlueprint('broken')).toBeUndefined()
    expect(findBlueprint('test-marker')).toBe(RED) // the good one still loaded
  })

  it('never throws out of the geometry builders', () => {
    // Shapes the interpreter would choke on if it saw them unfiltered.
    const hostile = [
      { id: 'no-parts', seed: 1, palette: {}, parts: [] },
      { id: 'nan-size', seed: 1, palette: { a: '#fff' }, parts: [{ shape: 'box', color: 'a', size: [1, NaN, 1] }] },
      { id: 'short-lathe', seed: 1, palette: { a: '#fff' }, parts: [{ shape: 'lathe', color: 'a', profile: [[1, 0]] }] },
    ]
    setMapBlueprints(hostile as unknown as GenBlueprint[])
    for (const bp of hostile) {
      expect(() => genGeometry(bp.id)).not.toThrow()
      expect(() => genGroups(bp.id, null, 1)).not.toThrow()
      expect(genGeometry(bp.id)).toBeNull() // caller falls back to a placeholder
    }
  })

  it('survives one the validator let through', () => {
    // Validation is the first line, but it only knows the failures we thought
    // of. Inject past it to prove the builders' own guard holds — this is the
    // case that would otherwise take the renderer down mid-match.
    const thrower = {
      get parts(): never {
        throw new Error('boom')
      },
    }
    GEN_BLUEPRINTS['test-thrower'] = thrower as unknown as GenBlueprint
    try {
      expect(genGeometry('test-thrower')).toBeNull()
      expect(genGroups('test-thrower', null, 1)).toBeNull()
    } finally {
      delete GEN_BLUEPRINTS['test-thrower']
    }
  })
})

describe('validateBlueprints names what is wrong', () => {
  const cases: [string, unknown, RegExp][] = [
    ['not an array', { id: 'x' }, /must be an array/],
    ['no id', [{ seed: 1, palette: {}, parts: [] }], /string "id"/],
    ['duplicate ids', [RED, RED], /duplicate blueprint id/],
    ['non-numeric seed', [{ ...RED, seed: 'four' }], /"seed" must be a number/],
    ['no parts', [{ ...RED, parts: [] }], /non-empty array/],
    ['unknown shape', [{ ...RED, parts: [{ shape: 'blob', color: 'hull' }] }], /unknown shape/],
    // The commonest authoring mistake: a colour slot that was renamed or typo'd
    // renders grey, which reads as a lighting bug rather than a bad blueprint.
    ['missing palette slot', [{ ...RED, parts: [{ shape: 'box', color: 'huII' }] }], /not in the palette/],
    ['unknown group', [{ ...RED, parts: [{ shape: 'box', color: 'hull', group: 'legs' }] }], /unknown group/],
    ['bad vector', [{ ...RED, parts: [{ shape: 'box', color: 'hull', at: [0, 1] }] }], /three finite numbers/],
    ['runaway count', [{ ...RED, parts: [{ shape: 'box', color: 'hull', count: 99999 }] }], /"count" must be/],
  ]
  for (const [what, input, message] of cases) {
    it(what, () => expect(() => validateBlueprints(input)).toThrow(message))
  }

  it('accepts a valid list and every built-in', () => {
    expect(validateBlueprints([RED])).toHaveLength(1)
    expect(validateBlueprints(undefined)).toEqual([])
    // The built-ins are the worked examples an author copies from, so they have
    // to pass the same check the editor applies to authored ones.
    expect(() => validateBlueprints(Object.values(GEN_BLUEPRINTS))).not.toThrow()
  })
})

describe('the editor tells an author about a broken model reference', () => {
  it('flags a gen: id that no blueprint provides, and clears once one does', () => {
    const doc = generateMap(1)
    doc.gameDef = JSON.parse(JSON.stringify(SKIRMISH_DEF)) as GameDef
    const unit = doc.gameDef.entities.find((e) => e.visual?.model?.startsWith('gen:'))!
    unit.visual!.model = 'gen:not-a-real-model'
    expect(validateMap(doc).join('\n')).toMatch(/unknown model "gen:not-a-real-model"/)

    // ...and authoring that model in the map is what fixes it.
    doc.blueprints = [{ ...RED, id: 'not-a-real-model' }]
    expect(validateMap(doc).join('\n')).not.toMatch(/unknown model/)
  })
})
