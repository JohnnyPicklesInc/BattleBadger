import { describe, expect, it } from 'vitest'
import { mapContentHash, setupMatch, stateHash, walkGridFromDoc, type RtsMapDoc } from '@battlebadger/sim'
import { generateEconDemo } from '../src/mapgen/econDemo.ts'

// Baked-file/manifest verification lives in packages/client, which owns
// public/maps — see packages/client/test/bakedMaps.test.ts.

describe('map identity is content, not filename', () => {
  it('the digest is stable across a JSON round trip', () => {
    // The canonical fold exists for exactly this: a generated doc and the same
    // doc parsed back from a file have different key insertion order.
    const doc = generateEconDemo(7)
    expect(mapContentHash(JSON.parse(JSON.stringify(doc)))).toBe(mapContentHash(doc))
  })

  it('the digest is order-independent for keys but not for content', () => {
    const doc = generateEconDemo(7)
    const reordered = Object.fromEntries(
      Object.keys(doc)
        .sort()
        .reverse()
        .map((k) => [k, (doc as unknown as Record<string, unknown>)[k]]),
    ) as unknown as RtsMapDoc
    expect(mapContentHash(reordered)).toBe(mapContentHash(doc))
  })

  it('any gameplay-relevant edit changes the digest', () => {
    const base = generateEconDemo(7)
    const h = mapContentHash(base)
    const edits: [string, (d: RtsMapDoc) => void][] = [
      ['a moved start location', (d) => (d.startLocations[0].x += 1)],
      // cell 0 is in the unwalkable border ring already — flip an open one
      ['a blocked cell', (d) => (d.walkable![d.walkable!.indexOf(1)] = 0)],
      ['a moved doodad', (d) => (d.doodads![0].x += 0.5)],
      ['a pre-placed unit', (d) => d.placed!.push({ def: 'peon', owner: 0, x: 5, z: 5 })],
      ['a rules change', (d) => (d.gameDef!.entities[0].hp += 1)],
      ['a different seed', (d) => (d.seed += 1)],
    ]
    for (const [what, edit] of edits) {
      const copy: RtsMapDoc = JSON.parse(JSON.stringify(base))
      edit(copy)
      expect(mapContentHash(copy), `${what} left the digest unchanged`).not.toBe(h)
    }
  })

  it('type tags keep differently-shaped content apart', () => {
    const a = { version: 1, name: 'x', seed: 0, cols: 1, rows: 1, cellSize: 1, originX: 0, originZ: 0, startLocations: [] }
    const b = { ...a, walkable: [1] }
    const c = { ...a, walkable: ['1'] } as unknown as RtsMapDoc
    expect(mapContentHash(b as RtsMapDoc)).not.toBe(mapContentHash(c))
  })

  it('two clients disagreeing about map content desync at tick 0', () => {
    const docA = generateEconDemo(7)
    const docB: RtsMapDoc = JSON.parse(JSON.stringify(docA))
    docB.gameDef!.entities[0].hp += 1 // same filename, different contents
    const sA = setupMatch(docA, walkGridFromDoc(docA), 2)
    const sB = setupMatch(docB, walkGridFromDoc(docB), 2)
    expect(sA.mapHash).not.toBe(sB.mapHash)
    expect(stateHash(sA)).not.toBe(stateHash(sB))
  })

  it('identical content on both sides agrees at tick 0', () => {
    const docA = generateEconDemo(7)
    const docB: RtsMapDoc = JSON.parse(JSON.stringify(docA))
    const sA = setupMatch(docA, walkGridFromDoc(docA), 2)
    const sB = setupMatch(docB, walkGridFromDoc(docB), 2)
    expect(sA.mapHash).toBe(sB.mapHash)
    expect(stateHash(sA)).toBe(stateHash(sB))
  })
})
