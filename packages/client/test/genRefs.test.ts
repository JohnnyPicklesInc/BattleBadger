import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SKIRMISH_DEF, generateMap, type GameDef } from '@battlebadger/sim'
import { GEN_BLUEPRINTS } from '../src/gen/registry.ts'

// An unregistered 'gen:<id>' does not throw — resolveModel quietly falls back
// to a placeholder box. That is the right runtime behaviour (a bad model can
// never break a match) but it makes typos invisible, so pin the references
// here. The baked maps are what the client actually loads, so a def edit that
// was never re-baked (node scripts/gen-starter-maps.mjs) fails this too.
const BAKED = ['cerebrate-war', 'dunhollow', 'econ-demo']

function genIds(def: GameDef | undefined): string[] {
  return (def?.entities ?? [])
    .map((e) => e.visual?.model ?? '')
    .filter((m) => m.startsWith('gen:'))
    .map((m) => m.slice(4))
}

describe('gen model references resolve', () => {
  it('skirmish preset', () => {
    const ids = genIds(SKIRMISH_DEF)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(GEN_BLUEPRINTS[id], `unregistered gen:${id}`).toBeDefined()
  })

  it('runtime-generated skirmish valley', () => {
    for (const id of genIds(generateMap(1).gameDef)) {
      expect(GEN_BLUEPRINTS[id], `unregistered gen:${id}`).toBeDefined()
    }
  })

  for (const name of BAKED) {
    it(`baked map ${name}.json`, () => {
      const doc = JSON.parse(readFileSync(`packages/client/public/maps/${name}.json`, 'utf8'))
      const ids = genIds(doc.gameDef)
      expect(ids.length, `${name}.json has no gen: models — stale bake?`).toBeGreaterThan(0)
      for (const id of ids) expect(GEN_BLUEPRINTS[id], `unregistered gen:${id}`).toBeDefined()
    })
  }
})
