import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapContentHash, type RtsMapDoc } from '@battlebadger/sim'
// Authoring-time generators, imported by path exactly as
// scripts/gen-starter-maps.mjs does — they are not part of the runtime API.
import { generateMiddleEarth } from '../../sim/src/mapgen/middleEarth.ts'
import { generateSquadSupport } from '../../sim/src/mapgen/squadSupport.ts'

// These seeds must match scripts/gen-starter-maps.mjs. That coupling is the
// point: identity comes from content, so the content has to be reproducible.
const BAKED: { file: string; gen: () => RtsMapDoc }[] = [
  { file: 'middle-earth.json', gen: () => generateMiddleEarth(20260803) },
  { file: 'squad-support.json', gen: () => generateSquadSupport(20260809) },
]

const DIR = 'packages/client/public/maps'
const manifest = (): { file: string; name: string; hash: number }[] =>
  JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8'))
const bakedDoc = (file: string): RtsMapDoc => JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'))

// The regression this exists for: a map def was edited but never re-baked, so
// the running client silently served the previous build's content for an hour.
// A filename cannot disagree with itself; a content hash can, and now does.
describe('baked starter maps are current', () => {
  for (const { file, gen } of BAKED) {
    it(`${file} matches what its generator produces now`, () => {
      expect(
        mapContentHash(bakedDoc(file)),
        `${file} is a STALE BAKE — run: node scripts/gen-starter-maps.mjs`,
      ).toBe(mapContentHash(gen()))
    })

    it(`${file} matches the hash recorded in index.json`, () => {
      const entry = manifest().find((m) => m.file === file)
      expect(entry, `${file} is missing from index.json`).toBeDefined()
      expect(entry!.hash, `index.json is stale for ${file}`).toBe(mapContentHash(bakedDoc(file)))
    })
  }

  it('every manifest entry points at a map that exists', () => {
    for (const m of manifest()) {
      expect(() => bakedDoc(m.file), `${m.file} listed but not on disk`).not.toThrow()
      expect(typeof m.hash, `${m.file} has no content hash`).toBe('number')
    }
  })
})
