import { describe, expect, it } from 'vitest'
import { generateMiddleEarth, MIDDLE_EARTH_DEF } from '../src/mapgen/middleEarth.ts'
import { deriveTerrain } from '../src/mapdoc.ts'
import { validateGameDef } from '../src/defs/schema.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { setupMatch } from '../src/setup.ts'
import { step } from '../src/step.ts'
import { Kind, MAX_UNITS, Order } from '../src/state.ts'

const SEED = 20260803
const doc = generateMiddleEarth(SEED)

const simOf = (players = 8) => {
  const grid = walkGridFromDoc(doc)
  return { grid, s: setupMatch(doc, grid, players) }
}

/** Flood fill the walkable layer from a world point. */
function reachable(from: { x: number; z: number }): Uint8Array {
  const { walkable } = deriveTerrain(doc)
  const seen = new Uint8Array(doc.cols * doc.rows)
  const sx = Math.floor(from.x)
  const sz = Math.floor(from.z)
  const start = sz * doc.cols + sx
  if (walkable[start] !== 1) return seen
  const stack = [start]
  seen[start] = 1
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % doc.cols
    const z = (i / doc.cols) | 0
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nz < 0 || nx >= doc.cols || nz >= doc.rows) continue
      const ni = nz * doc.cols + nx
      if (seen[ni] === 1 || walkable[ni] !== 1) continue
      seen[ni] = 1
      stack.push(ni)
    }
  }
  return seen
}

describe('The War of the Ring — rules', () => {
  it('composes a valid GameDef', () => {
    expect(validateGameDef(MIDDLE_EARTH_DEF)).toEqual([])
  })

  it('defines one muster-camp entity per camp, so a death names which fell', () => {
    // 25, not 24: seven realms of three, and Mordor's four. The black land is
    // deliberately the one realm that out-camps everybody.
    const camps = MIDDLE_EARTH_DEF.entities.filter((e) => e.id.startsWith('muster-'))
    expect(camps).toHaveLength(25)
    expect(new Set(camps.map((c) => c.id)).size).toBe(25)
    // Every camp def must be referenced by exactly one placed entity.
    for (const c of camps) {
      expect(doc.placed!.filter((p) => p.def === c.id)).toHaveLength(1)
    }
  })

  it('defines every doodad it places — an undefined one is dropped at setup', () => {
    const defined = new Set(MIDDLE_EARTH_DEF.entities.map((e) => e.id))
    for (const d of doc.doodads!) expect(defined.has(d.def), `doodad "${d.def}" is not defined`).toBe(true)
    expect(doc.doodads!.length).toBeGreaterThan(500)
  })

  it('only muster camps can end the match', () => {
    expect(MIDDLE_EARTH_DEF.victory.mode).toBe('triggersOnly')
  })
})

describe('The War of the Ring — ground', () => {
  it('seats eight realms on two teams', () => {
    expect(doc.startLocations).toHaveLength(8)
    expect(doc.slotTeams).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
  })

  it('every camp, tower and battalion stands on walkable ground', () => {
    const { walkable } = deriveTerrain(doc)
    const at = (p: { x: number; z: number }): number => walkable[Math.floor(p.z) * doc.cols + Math.floor(p.x)]
    for (const p of doc.placed!) {
      expect(at(p), `${p.def} at ${p.x},${p.z} is on blocked ground`).toBe(1)
    }
    for (const s of doc.startLocations) expect(at(s)).toBe(1)
  })

  it('all eight realms can reach each other by land', () => {
    // The failure this exists for: one more pass of the Misty Mountains or one
    // wider bend of the Anduin and a realm is sealed off with nobody to fight.
    const seen = reachable(doc.startLocations[0])
    for (const p of doc.placed!) {
      if (!p.def.startsWith('muster-')) continue
      const i = Math.floor(p.z) * doc.cols + Math.floor(p.x)
      expect(seen[i], `${p.def} is cut off from Gondor`).toBe(1)
    }
  })

  it('the Anduin is a real barrier, crossed only at its three fords', () => {
    const { walkable } = deriveTerrain(doc)
    const dry = (x: number, z: number): boolean => walkable[Math.floor(z) * doc.cols + Math.floor(x)] === 1
    // The three fords are open…
    for (const ford of [
      { x: 163, z: 96 },
      { x: 170, z: 165 },
      { x: 168, z: 199 },
    ]) {
      expect(dry(ford.x, ford.z), `ford at ${ford.x},${ford.z} is under water`).toBe(true)
    }
    // …and away from them the river is a wall. Walk each latitude across the
    // river's band; every one of these must hit water.
    for (const z of [20, 40, 70, 120, 145, 220, 240]) {
      let wet = false
      for (let x = 150; x < 190; x++) if (!dry(x, z)) wet = true
      expect(wet, `the Anduin can be walked around at z=${z}`).toBe(true)
    }
  })
})

describe('The War of the Ring — the muster loop', () => {
  it('gives every realm its camps and an opening army', () => {
    const { s } = simOf()
    for (let slot = 0; slot < 8; slot++) {
      const mine = []
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot) mine.push(i)
      const camps = mine.filter((i) => s.def.entities[s.type[i]].id.startsWith('muster-'))
      // Three each, and FOUR for Mordor — the asymmetry is the point, not a
      // rounding error, so it is asserted per slot rather than averaged away.
      expect(camps, `slot ${slot} camps`).toHaveLength(slot === 1 ? 4 : 3)
      const units = mine.filter((i) => s.kind[i] === Kind.Unit)
      expect(units.length, `slot ${slot} opening army`).toBeGreaterThan(30)
    }
  })

  it('the opening army arrives as bound battalions, not loose soldiers', () => {
    const { s } = simOf()
    let bound = 0
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.kind[i] === Kind.Unit && s.hordeOf[i] >= 0) bound++
    expect(bound).toBeGreaterThan(200)
    expect(s.hordes.count).toBeGreaterThanOrEqual(48) // 6 battalions x 8 realms
  })

  it('a camp musters a BATTALION on its clock, not a loose soldier', () => {
    const { grid, s } = simOf(2)
    const before = s.hordes.count
    const wave = 60 * 10 // longest realm period is 48+7 s; 60 s clears it
    for (let t = 0; t < wave; t++) step(s, grid, [])
    expect(s.hordes.count, 'no battalion mustered').toBeGreaterThan(before)
    // Everything that arrived is bound to a horde — that is the whole point of
    // routing trigger spawns through spawnHorde.
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.kind[i] !== Kind.Unit) continue
      expect(s.hordeOf[i], `entity ${i} (${s.def.entities[s.type[i]].id}) is a loose soldier`).toBeGreaterThanOrEqual(0)
    }
  })

  it("waves are not ordered anywhere — they are the player's to command", () => {
    const { grid, s } = simOf(2)
    for (let t = 0; t < 900; t++) step(s, grid, [])
    // The distinction that matters: nothing was given a destination. Units
    // jostle each other apart, which is fine; a marching creep wave is not.
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.kind[i] !== Kind.Unit) continue
      expect(s.order[i], `entity ${i} was ordered somewhere by the map`).toBe(Order.Idle)
    }
  })

  it('holds the muster once a realm is at its army cap', () => {
    // Driven at a deliberately tiny cap so the ceiling is reached in seconds.
    // The shipped value is checked arithmetically below — simulating eight
    // realms up to 700 apiece takes minutes and asserts nothing extra.
    const small = generateMiddleEarth(SEED)
    for (const t of small.triggers!) {
      for (const c of t.conditions) if (c.type === 'unitCountInRegion' && c.count > 1) c.count = 60
    }
    const grid = walkGridFromDoc(small)
    const s = setupMatch(small, grid, 2)
    const owned = (slot: number): number => {
      let n = 0
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot) n++
      return n
    }
    for (let t = 0; t < 3000; t++) step(s, grid, [])
    const atFiveMin = [owned(0), owned(1)]
    for (let t = 0; t < 3000; t++) step(s, grid, [])

    for (const slot of [0, 1]) {
      // Production stopped: a realm over its cap musters nothing more.
      expect(owned(slot), `slot ${slot} kept mustering past its cap`).toBe(atFiveMin[slot])
      // A camp's wave lands as a block, so a realm can sit one wave over — but
      // not one ROUND over, which is what staggering the three camps buys.
      expect(owned(slot), `slot ${slot} ran away past its cap`).toBeLessThan(160)
    }
  }, 60000)

  it('the shipped cap cannot fill the entity pool', () => {
    // spawnUnit THROWS at MAX_UNITS rather than degrading, so this is a crash
    // guard, not a tuning preference: eight realms at the cap, each already
    // holding a full round of waves it has not yet been stopped from taking.
    const caps = new Set<number>()
    for (const t of doc.triggers!) {
      for (const c of t.conditions) if (c.type === 'unitCountInRegion' && c.count > 1) caps.add(c.count)
    }
    expect(caps.size, 'every camp should share one army cap').toBe(1)
    const cap = [...caps][0]
    const biggestRound = 3 * 60 // three camps, generously over a camp's Age-IV wave
    expect(8 * (cap + biggestRound)).toBeLessThan(MAX_UNITS)
  })
})

describe('The War of the Ring — victory', () => {
  it('razing every camp of a team wins, and nothing else does', () => {
    const { grid, s } = simOf(2)
    // Kill slot 1's whole army — the match must NOT end.
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 1 && !s.def.entities[s.type[i]].id.startsWith('muster-')) s.hp[i] = 0
    }
    step(s, grid, [])
    expect(s.winner, 'losing an entire army ended the match').toBe(-1)

    // Now throw down its three camps.
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 1 && s.def.entities[s.type[i]].id.startsWith('muster-')) s.hp[i] = 0
    }
    step(s, grid, [])
    expect(s.winner).toBe(s.playerTeam[0])
  })

  it('a fallen camp musters no more', () => {
    const { grid, s } = simOf(2)
    const camps: { at: number; def: string }[] = []
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 0 && s.def.entities[s.type[i]].id.startsWith('muster-')) {
        camps.push({ at: i, def: s.def.entities[s.type[i]].id })
      }
    }
    expect(camps).toHaveLength(3)
    // Read the def id BEFORE razing — the entity slot is recycled on death.
    const razed = camps[0].def
    const spared = camps[2].def
    s.hp[camps[0].at] = 0
    s.hp[camps[1].at] = 0
    for (let t = 0; t < 60 * 10 * 3; t++) step(s, grid, [])

    const wavesFor = (campDef: string): number[] =>
      s.trig.defs.map((d, i) => ({ d, i })).filter(({ d }) => d.id === `wave-${campDef}-a0` || d.id.startsWith(`wave-${campDef}-a`)).map(({ i }) => i)

    const dead = wavesFor(razed)
    expect(dead.length).toBe(4) // four ages
    for (const i of dead) expect(s.trig.enabled[i], `${razed} is still mustering`).toBe(0)
    // The camp they did NOT raze keeps working.
    for (const i of wavesFor(spared)) expect(s.trig.enabled[i], `${spared} stopped mustering`).toBe(1)
  })
})

describe('determinism', () => {
  it('two sims of the same map agree after 600 ticks', () => {
    const a = simOf(8)
    const b = simOf(8)
    for (let t = 0; t < 600; t++) {
      step(a.s, a.grid, [])
      step(b.s, b.grid, [])
    }
    expect(a.s.count).toBe(b.s.count)
    for (let i = 0; i < a.s.count; i++) {
      expect(a.s.posX[i]).toBe(b.s.posX[i])
      expect(a.s.posZ[i]).toBe(b.s.posZ[i])
      expect(a.s.hp[i]).toBe(b.s.hp[i])
    }
  })

  it('regenerating the map from the same seed is bit-identical', () => {
    expect(JSON.stringify(generateMiddleEarth(SEED))).toBe(JSON.stringify(doc))
  })
})
