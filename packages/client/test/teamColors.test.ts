import { describe, expect, it } from 'vitest'
import { PLAYER_COLORS, teamOwnerColors } from '../src/render/unitMeshes.ts'

// Who is on my side has to be answerable from the colour of a distant army.
// These pin the two halves of that: allies sit in one hue family, and enemies
// are nowhere near it.

const hue = (c: { getHSL: (o: { h: number; s: number; l: number }) => void }): number => {
  const o = { h: 0, s: 0, l: 0 }
  c.getHSL(o)
  return o.h
}

/** Shortest distance around the colour wheel, 0..0.5. */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 1
  return Math.min(d, 1 - d)
}

describe('team colours', () => {
  it('is the plain palette in a free-for-all', () => {
    const teams = Int32Array.from({ length: 8 }, (_, i) => i)
    const colors = teamOwnerColors(teams, 8)
    for (let i = 0; i < 8; i++) expect(colors[i].getHex(), `slot ${i}`).toBe(PLAYER_COLORS[i].getHex())
  })

  it('puts an alliance in one hue family and the enemy in another', () => {
    // Middle-earth's shape: four realms of the Free Peoples against four of
    // the Shadow.
    const teams = Int32Array.from([0, 1, 0, 1, 0, 1, 0, 1])
    const colors = teamOwnerColors(teams, 8)
    const free = [0, 2, 4, 6].map((i) => hue(colors[i]))
    const shadow = [1, 3, 5, 7].map((i) => hue(colors[i]))
    for (const h of free) expect(hueGap(h, free[0]), 'an ally is off the family hue').toBeLessThan(0.1)
    for (const h of shadow) expect(hueGap(h, shadow[0]), 'an ally is off the family hue').toBeLessThan(0.1)
    for (const f of free) {
      for (const s of shadow) expect(hueGap(f, s), 'an enemy shares our hue').toBeGreaterThan(0.25)
    }
  })

  it('still tells four allies apart', () => {
    const teams = Int32Array.from([0, 1, 0, 1, 0, 1, 0, 1])
    const colors = teamOwnerColors(teams, 8)
    const hexes = [0, 2, 4, 6].map((i) => colors[i].getHex())
    expect(new Set(hexes).size, 'two allies wear the same colour').toBe(4)
  })

  it('gives the lowest slot on each team the team colour itself', () => {
    const teams = Int32Array.from([0, 0, 1, 1, 1, 1, 0, 0])
    const colors = teamOwnerColors(teams, 8)
    expect(colors[0].getHex()).toBe(PLAYER_COLORS[0].getHex())
    expect(colors[2].getHex()).toBe(PLAYER_COLORS[1].getHex())
  })

  it('does not mutate the shared palette', () => {
    const before = PLAYER_COLORS.map((c) => c.getHex())
    teamOwnerColors(Int32Array.from([0, 0, 1, 1, 2, 2, 3, 3]), 8)
    expect(PLAYER_COLORS.map((c) => c.getHex())).toEqual(before)
  })
})
