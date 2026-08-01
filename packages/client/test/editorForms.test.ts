import { describe, expect, it } from 'vitest'
import { SKIRMISH_DEF, validateGameDef, type GameDef } from '@battlebadger/sim'
import { cleanTriggers, entityToForm, formToEntity } from '../src/editor/schemaForms.ts'

// The visual editors are DOM, but the shape conversions either side of them
// are not — and they are where an editor silently corrupts a def. These pin
// the round trip.

type Obj = Record<string, unknown>

describe('entity <-> form conversion', () => {
  it('round-trips every shipped entity unchanged', () => {
    // The strongest available check: whatever the form does to a def, opening
    // and closing it without touching anything must be a no-op.
    for (const e of SKIRMISH_DEF.entities) {
      const back = formToEntity(entityToForm(e as unknown as Obj))
      expect(back, e.id).toEqual(JSON.parse(JSON.stringify(e)))
    }
  })

  it('flattens id lists for editing and rebuilds them on the way out', () => {
    const e: Obj = {
      id: 'barracks',
      name: 'Barracks',
      kind: 'building',
      hp: 100,
      radius: 1,
      visual: { model: 'gen:x' },
      trainer: { trains: ['swordsman', 'archer'], queueSize: 3 },
      plot: { accepts: ['farm'] },
    }
    const form = entityToForm(e)
    expect((form.trainer as Obj).trains).toBe('swordsman, archer')
    expect((form.plot as Obj).accepts).toBe('farm')

    // ...and a human typing spaces or a trailing comma still gets a clean list
    ;((form.trainer as Obj).trains as string) = ' swordsman ,archer, '
    expect((formToEntity(form).trainer as Obj).trains).toEqual(['swordsman', 'archer'])
  })

  it('turns an emptied list into an empty array, not undefined', () => {
    const form: Obj = { id: 'x', trainer: { trains: '', queueSize: 1 } }
    expect((formToEntity(form).trainer as Obj).trains).toEqual([])
  })

  it('does not alias the original, so an abandoned edit changes nothing', () => {
    const e = SKIRMISH_DEF.entities[0] as unknown as Obj
    const form = entityToForm(e)
    form.hp = 99999
    ;(form.visual as Obj).model = 'wrecked'
    expect(e.hp).not.toBe(99999)
  })
})

describe('trigger cleanup', () => {
  it('collapses a spawn point to coordinates OR a region, never both', () => {
    // The schema is a union; the form shows one group with all three inputs,
    // so whichever half the author did not use has to be stripped.
    const withRegion = cleanTriggers([
      { id: 't', events: [], actions: [{ type: 'spawnUnits', def: 'x', owner: 0, count: 1, at: { x: 5, z: 6, region: 'lane' } }] },
    ])
    expect((withRegion[0].actions as Obj[])[0].at).toEqual({ region: 'lane' })

    const withPoint = cleanTriggers([
      { id: 't', events: [], actions: [{ type: 'spawnUnits', def: 'x', owner: 0, count: 1, at: { x: 5, z: 6, region: '' } }] },
    ])
    expect((withPoint[0].actions as Obj[])[0].at).toEqual({ x: 5, z: 6 })
  })

  it('fills in the arrays the schema requires', () => {
    const [t] = cleanTriggers([{ id: 't', name: 'T' }])
    expect(t.events).toEqual([])
    expect(t.conditions).toEqual([])
    expect(t.actions).toEqual([])
    expect(t.initiallyOn).toBe(true)
  })

  it('leaves other action types alone', () => {
    const [t] = cleanTriggers([{ id: 't', actions: [{ type: 'message', text: 'hi', to: 'all' }] }])
    expect((t.actions as Obj[])[0]).toEqual({ type: 'message', text: 'hi', to: 'all' })
  })

  it('does not mutate what it was given', () => {
    const input = [{ id: 't', actions: [{ type: 'spawnUnits', def: 'x', owner: 0, count: 1, at: { x: 1, z: 2 } }] }]
    cleanTriggers(input)
    expect(input[0].conditions).toBeUndefined()
  })
})

describe('a def with no model is rejected', () => {
  it('is caught by validation rather than crashing the renderer', () => {
    // The type says visual is required, but a def arriving from a JSON file or
    // a half-filled form has nothing enforcing that, and the renderer reads
    // e.visual.model directly.
    const def = JSON.parse(JSON.stringify(SKIRMISH_DEF)) as GameDef
    delete (def.entities[0] as unknown as Obj).visual
    expect(validateGameDef(def).join(' ')).toMatch(/needs a visual model/)
  })

  it('accepts every shipped def', () => {
    expect(validateGameDef(SKIRMISH_DEF)).toEqual([])
  })
})
