import { describe, expect, it } from 'vitest'
import { Color } from 'three'
import { GEN_BLUEPRINTS } from '../src/gen/registry.ts'
import { UNIT_BLUEPRINTS } from '../src/gen/units.ts'
import { STRUCTURE_BLUEPRINTS } from '../src/gen/structures.ts'
import { buildGenGeometry, buildGenGroups, genGeometry, genGroups } from '../src/gen/build.ts'

describe('gen blueprints', () => {
  for (const [id, bp] of Object.entries(GEN_BLUEPRINTS)) {
    it(`${id} builds deterministic flat-shaded geometry`, () => {
      const a = buildGenGeometry(bp)
      const b = buildGenGeometry(bp)
      const pa = a.getAttribute('position')
      expect(pa.count).toBeGreaterThan(0)
      expect(pa.count % 3).toBe(0) // non-indexed triangle soup
      expect(a.getAttribute('color').count).toBe(pa.count)
      expect(a.getAttribute('normal').count).toBe(pa.count)
      // same blueprint → identical mesh, every build, every client
      expect(Array.from(pa.array)).toEqual(Array.from(b.getAttribute('position').array))
    })
  }

  it('registry ids resolve through genGeometry; unknown ids return null', () => {
    expect(genGeometry('oak')).not.toBeNull()
    expect(genGeometry('no-such-blueprint')).toBeNull()
  })

  it('blueprint ids match their registry keys', () => {
    for (const [key, bp] of Object.entries(GEN_BLUEPRINTS)) expect(bp.id).toBe(key)
  })
})

describe('unit animation groups', () => {
  it('badger units expose hinged arm groups with shoulder pivots', () => {
    for (const id of ['badger-sword', 'badger-spear', 'badger-bow', 'badger-staff', 'badger-worker', 'badger-hero']) {
      const roles = buildGenGroups(UNIT_BLUEPRINTS[id]).map((g) => g.role)
      expect(roles).toContain('body')
      expect(roles).toContain('armL')
      expect(roles).toContain('armR')
      for (const g of buildGenGroups(UNIT_BLUEPRINTS[id])) {
        if (g.role !== 'body') expect(g.pivot[1]).toBeGreaterThan(0) // hinge sits at the shoulder
      }
    }
  })

  it('gnasher and cavalry are single body groups (whole-unit animation only)', () => {
    expect(buildGenGroups(UNIT_BLUEPRINTS.gnasher).map((g) => g.role)).toEqual(['body'])
    // a couched lance flailing to the infantry walk cycle looks absurd
    expect(buildGenGroups(UNIT_BLUEPRINTS['badger-rider']).map((g) => g.role)).toEqual(['body'])
  })

  it("the catapult's throwing arm is a 'weapon' group hinged at the axle", () => {
    const groups = buildGenGroups(UNIT_BLUEPRINTS.catapult)
    const roles = groups.map((g) => g.role)
    expect(roles).toContain('body')
    expect(roles).toContain('weapon')
    // 'weapon' fires on attack only — it must never pick up the walk swing
    expect(roles).not.toContain('armL')
    expect(roles).not.toContain('armR')
    const arm = groups.find((g) => g.role === 'weapon')!
    expect(arm.pivot[1]).toBeGreaterThan(0.5) // hinged up on the A-frame
  })

  // Only things with moving parts get hinged groups. Everything else must be
  // one body, or the construction rise and the walk cycle would drive parts of
  // a building that have no business moving.
  const HINGED_STRUCTURES = new Set(['gate', 'sally-port', 'wall-catapult'])

  it('structures are one body unless they have a moving part', () => {
    for (const [id, bp] of Object.entries(STRUCTURE_BLUEPRINTS)) {
      if (HINGED_STRUCTURES.has(id)) continue
      expect(buildGenGroups(bp).map((g) => g.role), id).toEqual(['body'])
    }
  })

  it('gates hinge their doors, so the renderer has something to swing', () => {
    for (const id of ['gate', 'sally-port']) {
      const roles = buildGenGroups(STRUCTURE_BLUEPRINTS[id]).map((g) => g.role)
      expect(roles, id).toContain('body')
      expect(roles.some((r) => r === 'armL' || r === 'armR'), id).toBe(true)
      // A door hinges on its jamb, not on the middle of the archway.
      for (const g of buildGenGroups(STRUCTURE_BLUEPRINTS[id])) {
        if (g.role === 'armL' || g.role === 'armR') expect(Math.abs(g.pivot[0])).toBeGreaterThan(0.4)
      }
    }
  })

  it('grouping never changes the mesh: groups merge back to the plain build', () => {
    const bp = UNIT_BLUEPRINTS['badger-sword']
    const whole = buildGenGeometry(bp).getAttribute('position').count
    const grouped = buildGenGroups(bp).reduce((n, g) => n + g.geometry.getAttribute('position').count, 0)
    expect(grouped).toBe(whole)
  })

  it('the player palette slot bakes the owner color into vertex colors', () => {
    const red = buildGenGroups(UNIT_BLUEPRINTS['badger-sword'], new Color(1, 0, 0))
    const blue = buildGenGroups(UNIT_BLUEPRINTS['badger-sword'], new Color(0, 0, 1))
    const flat = (gs: typeof red): number[] => gs.flatMap((g) => Array.from(g.geometry.getAttribute('color').array as Float32Array))
    const a = flat(red)
    const b = flat(blue)
    expect(a.length).toBe(b.length)
    expect(a).not.toEqual(b) // owner color reached the mesh
    // and positions are still identical — only paint differs
    const pos = (gs: typeof red): number[] => gs.flatMap((g) => Array.from(g.geometry.getAttribute('position').array as Float32Array))
    expect(pos(red)).toEqual(pos(blue))
  })

  it('genGroups scales geometry and pivots together', () => {
    const one = genGroups('badger-sword', null, 1)!
    const two = genGroups('badger-sword', null, 2)!
    const armOne = one.find((g) => g.role === 'armR')!
    const armTwo = two.find((g) => g.role === 'armR')!
    expect(armTwo.pivot[1]).toBeCloseTo(armOne.pivot[1] * 2)
  })
})
