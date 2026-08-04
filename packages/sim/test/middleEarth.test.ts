import { describe, expect, it } from 'vitest'
import { generateMiddleEarth, MIDDLE_EARTH_DEF } from '../src/mapgen/middleEarth.ts'
import { deriveTerrain } from '../src/mapdoc.ts'
import { validateGameDef } from '../src/defs/schema.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { setupMatch } from '../src/setup.ts'
import { spawnBuilding } from '../src/systems/economy.ts'
import { outgoingPct } from '../src/systems/hordes.ts'
import { step } from '../src/step.ts'
import { Kind, MAX_UNITS, Order, spawnUnit } from '../src/state.ts'

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
    // Eight powers, 29 camps, and deliberately not three apiece: Mordor holds
    // five because it fights on two fronts, Gondor/Elves/Dwarves four, and
    // Rohan, Isengard, Harad and Moria three. The asymmetry is the design.
    const camps = MIDDLE_EARTH_DEF.entities.filter((e) => e.id.startsWith('muster-'))
    expect(camps).toHaveLength(29)
    expect(new Set(camps.map((c) => c.id)).size).toBe(29)
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
  it('seats eight powers, four a side', () => {
    expect(doc.startLocations).toHaveLength(8)
    expect(doc.slotTeams).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
    // Slot order is by front, so every lobby size is a real matchup.
    expect(doc.startNames).toEqual([
      'Gondor', 'Mordor', 'Rohan', 'Isengard', 'The Elves', 'Harad', 'The Dwarves', 'Moria',
    ])
  })

  it('every camp, tower and battalion stands on walkable ground', () => {
    const { walkable } = deriveTerrain(doc)
    const at = (p: { x: number; z: number }): number => walkable[Math.floor(p.z) * doc.cols + Math.floor(p.x)]
    for (const p of doc.placed!) {
      expect(at(p), `${p.def} at ${p.x},${p.z} is on blocked ground`).toBe(1)
    }
    for (const s of doc.startLocations) expect(at(s)).toBe(1)
  })

  it('all eight powers can reach each other by land', () => {
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
    for (const z of [40, 100, 160, 220, 260]) {
      let wet = false
      for (let x = 200; x < 340; x++) if (!dry(x, z)) wet = true
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
      // Mordor five, Gondor/Elves/Dwarves four, Rohan/Isengard/Harad three —
      // the asymmetry is the design, not a rounding error, so it is asserted
      // per power rather than averaged away.
      const want = [4, 5, 3, 3, 4, 3, 4, 3][slot]
      expect(camps, `slot ${slot} camps`).toHaveLength(want)
      const units = mine.filter((i) => s.kind[i] === Kind.Unit)
      expect(units.length, `slot ${slot} opening army`).toBeGreaterThan(30)
    }
  })

  it('every power fields a roster nobody else does', () => {
    // The failure this exists for is silent: a realm whose wave table names
    // tickets it shares with everyone else still WORKS, it just stops being
    // that realm. Each of these is the one thing that power is for.
    const ticketsOf = (slot: number): Set<string> => {
      const out = new Set<string>()
      for (const t of doc.triggers!) {
        for (const a of t.actions) {
          if (a.type === 'spawnUnits' && a.owner === slot) out.add(a.def)
        }
      }
      return out
    }
    const gondor = ticketsOf(0)
    const rohan = ticketsOf(2)
    const isengard = ticketsOf(3)
    const elves = ticketsOf(4)
    const dwarves = ticketsOf(6)

    // Rohan opens on horse — at the FIRST age, which nobody else does.
    const rohanAgeOne = doc.triggers!.find((t) => t.id === 'wave-muster-edoras-a0')!
    expect(rohanAgeOne.actions.every((a) => a.type === 'spawnUnits' && a.def === 'h-riders')).toBe(true)
    expect(rohan.has('h-catapult'), 'Rohan should have no siege').toBe(false)

    // The Elves are archers and nothing else much; the Dwarves are the reverse.
    expect(elves.has('h-elf-archers')).toBe(true)
    expect(elves.has('h-riders'), 'Elves field no horse').toBe(false)
    expect(dwarves.has('h-dwarf-warriors')).toBe(true)
    expect(dwarves.has('h-riders'), 'Dwarves field no horse').toBe(false)

    // Isengard is the only power that musters men AND orcs.
    expect(isengard.has('h-swordsmen') && isengard.has('h-orcs')).toBe(true)
    expect(gondor.has('h-orcs'), 'Gondor fields no orcs').toBe(false)

    // The elven archer outranges every other bow on the map, which is the
    // entire faction — assert the number, not just that the unit exists.
    const bow = (id: string): number => MIDDLE_EARTH_DEF.entities.find((e) => e.id === id)!.combat!.range
    expect(bow('elf-archer')).toBeGreaterThan(bow('archer'))
    expect(bow('elf-archer')).toBeGreaterThan(bow('orc-archer'))
    // …and the dwarf out-bodies every other footman.
    const hp = (id: string): number => MIDDLE_EARTH_DEF.entities.find((e) => e.id === id)!.hp
    expect(hp('dwarf-warrior')).toBeGreaterThan(hp('swordsman'))
    expect(hp('dwarf-warrior')).toBeGreaterThan(hp('orc'))
  })

  it('heroes ride out at the third age, from the capital only', () => {
    const heroTickets = [
      'h-gondor-captain', 'h-black-captain', 'h-mark-marshal', 'h-uruk-captain',
      'h-warg-rider', 'h-elf-lord', 'h-serpent-lord', 'h-dwarf-lord', 'h-goblin-king',
    ]
    const heroWaves = doc.triggers!.filter(
      (t) => t.id.startsWith('wave-') && t.actions.some((a) => a.type === 'spawnUnits' && heroTickets.includes(a.def)),
    )
    expect(heroWaves.length).toBeGreaterThan(0)
    for (const t of heroWaves) {
      // Third age (index 2) and nowhere earlier.
      expect(t.id.endsWith('-a2'), `${t.id} musters a hero outside the third age`).toBe(true)
    }
    // One hero-mustering camp per power — the capital — so a five-camp realm
    // does not field five heroes a minute.
    // One trigger per power, not per hero: Isengard musters both a Captain and
    // a Warg Chieftain, but from the same camp on the same clock.
    const capitals = new Set(heroWaves.map((t) => t.id))
    expect(capitals.size).toBe(8)
    ;[
        'wave-muster-minas-tirith-a2',
        'wave-muster-barad-dur-a2',
        'wave-muster-edoras-a2',
        'wave-muster-orthanc-a2',
        'wave-muster-rivendell-a2',
        'wave-muster-umbar-a2',
        'wave-muster-erebor-a2',
      ].forEach((id) => expect(capitals.has(id), `${id} should muster its power's hero`).toBe(true))
  })

  it('the opening army arrives as bound battalions, not loose soldiers', () => {
    const { s } = simOf()
    let bound = 0
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.kind[i] === Kind.Unit && s.hordeOf[i] >= 0) bound++
    expect(bound).toBeGreaterThan(200)
    expect(s.hordes.count).toBeGreaterThanOrEqual(48) // 6 battalions x 8 powers
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
      // not one ROUND over, which is what staggering the camps' clocks buys.
      // Driven at a cap of 60, where a power's BUILDINGS alone already exceed
      // it — a fortified camp's curtain is thirty pieces by itself — so the
      // bound is generous and the assertion that matters is the one above.
      expect(owned(slot), `slot ${slot} ran away past its cap`).toBeLessThan(360)
    }
  }, 60000)

  it('the shipped cap cannot fill the entity pool', () => {
    // spawnUnit THROWS at MAX_UNITS rather than degrading, so this is a crash
    // guard, not a tuning preference: eight powers at the cap, each already
    // holding a full round of waves it has not yet been stopped from taking.
    const caps = new Set<number>()
    for (const t of doc.triggers!) {
      for (const c of t.conditions) if (c.type === 'unitCountInRegion' && c.count > 1) caps.add(c.count)
    }
    expect(caps.size, 'every camp should share one army cap').toBe(1)
    const cap = [...caps][0]
    const biggestRound = 5 * 60 // Mordor's five camps, over a camp's Age-IV wave
    expect(8 * (cap + biggestRound)).toBeLessThan(MAX_UNITS)
  })
})

describe('The War of the Ring — fortresses', () => {
  // What a fortified camp's curtain must be: a closed ring with no gap wide
  // enough to walk through. The version this replaces put seven pieces on a
  // 15-tile arc — 9.4 tiles apart for a 3-tile wall — so it looked like a
  // fortress and was two thirds holes.
  const ringOf = (campDef: string): { x: number; z: number; def: string }[] => {
    const camp = doc.placed!.find((p) => p.def === campDef)!
    const WALLS = new Set(['wall', 'gate', 'wall-tower', 'sally-port'])
    return doc
      .placed!.filter((p) => WALLS.has(p.def))
      .filter((p) => Math.sqrt((p.x - camp.x) ** 2 + (p.z - camp.z) ** 2) < 22)
      .map((p) => ({ x: p.x, z: p.z, def: p.def }))
  }

  it('every fortified camp is ringed all the way round', () => {
    const forts = ['muster-minas-tirith', 'muster-osgiliath', 'muster-barad-dur', 'muster-minas-morgul']
    for (const f of forts) {
      const ring = ringOf(f)
      expect(ring.length, `${f} has barely any curtain`).toBeGreaterThanOrEqual(28)
      const camp = doc.placed!.find((p) => p.def === f)!

      // Sort the pieces by bearing and check consecutive gaps. Every neighbour
      // must be close enough that the stones meet; one 6-tile hole is a door
      // an army walks through and the whole feature is decorative.
      const byBearing = ring
        .map((p) => ({ ...p, a: Math.atan2(p.z - camp.z, p.x - camp.x) }))
        .sort((u, v) => u.a - v.a)
      let worst = 0
      let worstAt = ''
      for (let i = 0; i < byBearing.length; i++) {
        const a = byBearing[i]
        const b = byBearing[(i + 1) % byBearing.length]
        const gap = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
        // The gate is 8.4 wide and legitimately spans its neighbours.
        const allowed = a.def === 'gate' || b.def === 'gate' ? 7.5 : 3.6
        if (gap - allowed > worst) {
          worst = gap - allowed
          worstAt = `${a.def}→${b.def} ${gap.toFixed(1)}`
        }
      }
      expect(worst, `${f} has a hole in its curtain (${worstAt})`).toBeLessThanOrEqual(0)
    }
  })

  it('a sealed fort still lets its own garrison out', () => {
    const ring = ringOf('muster-osgiliath')
    // A great gate that starts barred, and posterns that open by themselves.
    expect(ring.filter((p) => p.def === 'gate').length).toBe(1)
    expect(ring.filter((p) => p.def === 'sally-port').length).toBeGreaterThanOrEqual(2)
    const port = MIDDLE_EARTH_DEF.entities.find((e) => e.id === 'sally-port')!
    expect(port.gate!.manual, 'a sealed ring with only manual gates traps its garrison').not.toBe(true)
  })

  it('the curtain stands outside the musters and inside the cleared ground', () => {
    const camp = doc.placed!.find((p) => p.def === 'muster-minas-tirith')!
    for (const p of ringOf('muster-minas-tirith')) {
      const d = Math.sqrt((p.x - camp.x) ** 2 + (p.z - camp.z) ** 2)
      expect(d, 'the curtain is inside its own muster ground').toBeGreaterThan(12)
      expect(d, 'the curtain is outside the ground carved for it').toBeLessThan(20)
    }
  })
})

describe('The War of the Ring — leadership', () => {
  it('gives every power a hero, and no two the same standing', () => {
    const heroes = MIDDLE_EARTH_DEF.entities.filter((e) => e.aura)
    expect(heroes.length).toBe(9) // eight powers, and Isengard fields two
    // A hero whose aura is identical to another's is a reskin, not a hero.
    const shapes = heroes.map((h) => JSON.stringify(h.aura))
    expect(new Set(shapes).size, 'two heroes carry the same aura').toBe(heroes.length)
    // Exactly one of them is dread, pointed at the enemy rather than the men.
    const dread = heroes.filter((h) => h.aura!.affects === 'enemies')
    expect(dread.map((h) => h.id)).toEqual(['black-captain'])
    expect(dread[0].aura!.damagePct).toBeLessThan(0)
  })

  it('a captain makes the men around him hit harder', () => {
    const { grid, s } = simOf(8)
    // Find a Gondorian swordsman and a captain, and stand them together.
    let man = -1
    for (let i = 0; i < s.count && man < 0; i++) {
      if (s.alive[i] && s.def.entities[s.type[i]].id === 'swordsman' && s.owner[i] === 0) man = i
    }
    expect(man).toBeGreaterThanOrEqual(0)
    const base = outgoingPct(s, man)

    const cap = spawnUnit(s, s.def.entIndex.get('gondor-captain')!, 0, s.posX[man] + 2, s.posZ[man])
    step(s, grid, [])
    const led = outgoingPct(s, man)
    expect(led, 'leadership did nothing').toBeGreaterThan(base)

    // …and stops the moment he does. Walk him out of range rather than killing
    // him, so this is testing the aura and not the death path.
    s.posX[cap] = s.posX[man] + 400
    step(s, grid, [])
    expect(outgoingPct(s, man), 'leadership outlived the captain leaving').toBe(base)
  })

  it('dread lands on the enemy and never on your own', () => {
    const { grid, s } = simOf(8)
    const at = { x: 60, z: 300 } // empty desert, well away from anybody
    const foe = spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, at.x, at.z)
    const own = spawnUnit(s, s.def.entIndex.get('orc')!, 1, at.x + 2, at.z)
    const nazgul = spawnUnit(s, s.def.entIndex.get('black-captain')!, 1, at.x + 1, at.z)
    expect(nazgul).toBeGreaterThanOrEqual(0)
    step(s, grid, [])
    expect(outgoingPct(s, foe), 'dread did not weaken the enemy').toBeLessThan(100)
    expect(outgoingPct(s, own), 'dread weakened its own side').toBeGreaterThanOrEqual(100)
  })

  it('overlapping leadership stacks but cannot run away', () => {
    const { grid, s } = simOf(8)
    const at = { x: 90, z: 300 }
    const man = spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, at.x, at.z)
    // Eight captains on one man. Multiplicative stacking without a clamp would
    // be 25% compounded eight times — about 6x — which is exactly the
    // degenerate hero-ball the clamp exists to forbid.
    for (let k = 0; k < 8; k++) {
      spawnUnit(s, s.def.entIndex.get('gondor-captain')!, 0, at.x + 1 + k * 0.1, at.z)
    }
    step(s, grid, [])
    const stacked = outgoingPct(s, man)
    expect(stacked, 'stacking did not stack at all').toBeGreaterThan(125)
    expect(stacked, 'stacking ran away').toBeLessThanOrEqual(200)
  })
})

describe('The War of the Ring — the economy', () => {
  it('every camp stands on a pad that survives it', () => {
    const { s } = simOf()
    const pads = []
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.def.entities[s.type[i]].id.startsWith('pad-')) pads.push(i)
    }
    expect(pads).toHaveLength(29) // one per camp
    // Bound, not merely co-located: plotHost is what makes the ruin rebuildable.
    for (const p of pads) expect(s.plotHost[p], 'a pad has no camp on it').toBeGreaterThanOrEqual(0)
  })

  it('a razed camp leaves its ground behind', () => {
    const { grid, s } = simOf(2)
    let camp = -1
    for (let i = 0; i < s.count && camp < 0; i++) {
      if (s.alive[i] && s.owner[i] === 0 && s.def.entities[s.type[i]].id.startsWith('muster-')) camp = i
    }
    const pad = s.plotOf[camp]
    expect(pad, 'the camp is not standing on its pad').toBeGreaterThanOrEqual(0)
    s.hp[camp] = 0
    step(s, grid, [])
    expect(s.alive[camp], 'the camp survived being razed').toBe(0)
    // The ruin is still there, and free for its owner to build on again.
    expect(s.alive[pad], 'razing the camp took its ground with it').toBe(1)
    expect(s.plotHost[pad], 'the pad still thinks it is occupied').toBe(-1)
  })

  it('mustering pays, and pays more as the ages stack', () => {
    const { grid, s } = simOf(2)
    const res = (owner: number): number => s.resources[owner * s.def.resources.length]
    const start = res(0)
    expect(start, 'a power should open with a purse').toBeGreaterThan(0)
    // One full wave cycle at the first age.
    for (let t = 0; t < 60 * 10; t++) step(s, grid, [])
    const afterAgeOne = res(0)
    expect(afterAgeOne, 'the muster paid nothing').toBeGreaterThan(start)
    const ageOneRate = (afterAgeOne - start) / 600

    // Past the fourth age every camp fires all four tithes, so the same camps
    // pay several times over — the income curve IS the age curve. This holds
    // even though the realm is long since at its army cap and mustering
    // nothing, which is the whole point of splitting income off the waves.
    for (let t = 0; t < 11500; t++) step(s, grid, [])
    const beforeLate = res(0)
    for (let t = 0; t < 600; t++) step(s, grid, [])
    const lateRate = (res(0) - beforeLate) / 600
    expect(lateRate, 'income did not rise with the ages').toBeGreaterThan(ageOneRate)
  }, 120000)

  it('everything this map PLACES a pad for is something money can buy', () => {
    // The composed def also carries the Badgers' and the Horde's own keeps and
    // barracks — this map seats their units, not their architecture, and none
    // of that is reachable here. What must hold is the other direction: every
    // pad on the ground accepts something, and that something has a price.
    const byId = new Map(MIDDLE_EARTH_DEF.entities.map((e) => [e.id, e]))
    const padded = new Set(doc.placed!.map((p) => p.def).filter((d) => byId.get(d)?.plot))
    expect(padded.size).toBeGreaterThan(0)
    for (const padId of padded) {
      const accepts = byId.get(padId)!.plot!.accepts
      expect(accepts.length, `${padId} accepts nothing`).toBeGreaterThan(0)
      for (const id of accepts) {
        const target = byId.get(id)
        expect(target, `${padId} accepts "${id}", which is not defined`).toBeDefined()
        expect((target!.cost ?? []).length, `${id} is free — the muster's income has nowhere to go`)
          .toBeGreaterThan(0)
      }
    }
  })

  it('a rebuilt camp musters again', () => {
    // The regression this exists for: the old wiring switched a camp's waves
    // off for good when it fell. That was right when a razed camp was gone
    // forever, and silently wrong the moment one could be raised again.
    const campWaves = doc.triggers!.filter((t) => t.id.startsWith('wave-muster-minas-tirith-'))
    expect(campWaves.length).toBe(4)
    for (const t of campWaves) {
      const stands = t.conditions.find(
        (c) => c.type === 'unitCountInRegion' && c.def === 'muster-minas-tirith',
      )
      expect(stands, `${t.id} does not check that its camp is standing`).toBeDefined()
      expect(stands!.type === 'unitCountInRegion' && stands!.op).toBe('>=')
    }
    // And nothing switches a wave off permanently any more.
    for (const t of doc.triggers!) {
      for (const a of t.actions) {
        expect(a.type === 'setTrigger' && a.trigger.startsWith('wave-'), `${t.id} disables a wave for good`).toBe(false)
      }
    }
  })

  it('income keeps flowing when a realm is at its army cap', () => {
    // The cap governs how many troops you may hold, not whether your camps
    // work — otherwise the moment you are losing ground is the moment you can
    // no longer afford to take it back.
    const income = doc.triggers!.filter((t) => t.id.startsWith('income-'))
    expect(income.length).toBeGreaterThan(0)
    for (const t of income) {
      const capGate = t.conditions.find((c) => c.type === 'unitCountInRegion' && c.op === '<=')
      expect(capGate, `${t.id} is gated on the army cap`).toBeUndefined()
    }
  })

  it('the chokepoints can be fortified by whoever holds them', () => {
    const sites = doc.placed!.filter((p) => p.def === 'tower-site')
    expect(sites.length).toBeGreaterThanOrEqual(16)
    // Neutral, and marked `always` so they exist whatever the player count.
    const def = MIDDLE_EARTH_DEF.entities.find((e) => e.id === 'tower-site')!
    expect(def.plot!.neutral).toBe(true)
    expect(def.plot!.accepts).toEqual(['watchtower'])
    for (const p of sites) expect(p.always).toBe(true)
  })
})

describe('The War of the Ring — the claimable holds', () => {
  it('puts neutral holds out where nobody already is', () => {
    const sites = doc.placed!.filter((p) => p.def === 'garrison-site')
    expect(sites).toHaveLength(8)
    const def = MIDDLE_EARTH_DEF.entities.find((e) => e.id === 'garrison-site')!
    expect(def.plot!.neutral, 'a hold nobody may claim is not a hold').toBe(true)
    for (const p of sites) expect(p.always).toBe(true)

    // Not inside anybody's ground. A hold sitting in a realm's own clearing is
    // a gift to whoever spawned there, not an objective.
    const camps = doc.placed!.filter((p) => p.def.startsWith('muster-'))
    for (const site of sites) {
      for (const camp of camps) {
        const d = Math.sqrt((site.x - camp.x) ** 2 + (site.z - camp.z) ** 2)
        expect(d, `a hold sits on top of ${camp.def}`).toBeGreaterThan(24)
      }
    }
  })

  it('each hold musters a militia that exists nowhere else', () => {
    const byId = new Map(MIDDLE_EARTH_DEF.entities.map((e) => [e.id, e]))
    const holds = MIDDLE_EARTH_DEF.entities.filter((e) => e.id.startsWith('hold-'))
    expect(holds).toHaveLength(8)

    // Every hold's militia ticket, and no two the same — the whole point is
    // that taking THIS place is the only way to field THESE men.
    const tickets = new Set<string>()
    for (const h of holds) {
      const musters = doc.triggers!.filter((t) => t.id.startsWith(`hold-${h.id}-p`))
      expect(musters.length, `${h.id} musters for nobody`).toBe(8) // one per power
      const spawns = new Set(
        musters.flatMap((t) => t.actions.filter((a) => a.type === 'spawnUnits').map((a) => a.def)),
      )
      expect(spawns.size, `${h.id} musters more than one kind of militia`).toBe(1)
      const ticket = [...spawns][0]
      expect(byId.get(ticket), `${ticket} is not defined`).toBeDefined()
      tickets.add(ticket)
    }
    expect(tickets.size, 'two holds field the same militia').toBe(8)

    // …and none of that militia is anything a realm can muster from its camps.
    const campTickets = new Set(
      doc.triggers!
        .filter((t) => t.id.startsWith('wave-'))
        .flatMap((t) => t.actions.filter((a) => a.type === 'spawnUnits').map((a) => a.def)),
    )
    for (const t of tickets) {
      expect(campTickets.has(t), `${t} is already available from a camp`).toBe(false)
    }
  })

  it('a hold brings three emplacements, and they take towers or engines', () => {
    const hold = MIDDLE_EARTH_DEF.entities.find((e) => e.id === 'hold-druadan')!
    const rings = Array.isArray(hold.expansion) ? hold.expansion : hold.expansion ? [hold.expansion] : []
    expect(rings).toHaveLength(1)
    expect(rings[0].offsets, 'a hold should bring three pads').toHaveLength(3)
    const pad = MIDDLE_EARTH_DEF.entities.find((e) => e.id === rings[0].plot)!
    expect(pad.plot!.accepts).toEqual(['watchtower', 'wall-catapult'])
    expect(hold.cost!.length).toBeGreaterThan(0)
  })

  it('whoever holds it musters it, and nobody else does', () => {
    const { grid, s } = simOf(8)
    const site = doc.placed!.find((p) => p.def === 'garrison-site')!
    // Gondor takes the Drúadan hold. Deliberately the power whose ground it
    // sits nearest: the first version of this test gave it to ISENGARD, and
    // Gondor and Rohan simply razed it inside the first minute — which is the
    // map behaving correctly and the test being wrong.
    const built = spawnBuilding(s, grid, s.def.entIndex.get('hold-druadan')!, 0, site.x, site.z, false)
    expect(built).toBeGreaterThanOrEqual(0)
    const count = (owner: number, def: string): number => {
      let n = 0
      for (let i = 0; i < s.count; i++) {
        if (s.alive[i] && s.owner[i] === owner && s.def.entities[s.type[i]].id === def) n++
      }
      return n
    }
    const beforeHolder = count(0, 'wose')
    const beforeOther = count(1, 'wose')
    for (let t = 0; t < 800; t++) step(s, grid, [])
    expect(s.alive[built], 'the hold did not survive to muster').toBe(1)
    expect(count(0, 'wose'), 'the holder mustered nothing').toBeGreaterThan(beforeHolder)
    expect(count(1, 'wose'), 'somebody who does not hold it got the militia').toBe(beforeOther)
  }, 60000)
})

describe('The War of the Ring — victory', () => {
  it('razing every camp of a team wins, and nothing else does', () => {
    const { grid, s } = simOf(2)
    // Kill slot 1's whole army and every tower — but NOT the pads. A plot's
    // death cascades into whatever stands on it, so sweeping them would take
    // the camps out sideways and prove nothing.
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.owner[i] !== 1) continue
      const id = s.def.entities[s.type[i]].id
      if (id.startsWith('muster-') || id.startsWith('pad-') || id === 'tower-plot') continue
      s.hp[i] = 0
    }
    step(s, grid, [])
    expect(s.winner, 'losing an entire army ended the match').toBe(-1)

    // Now throw down every camp it holds.
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 1 && s.def.entities[s.type[i]].id.startsWith('muster-')) s.hp[i] = 0
    }
    step(s, grid, [])
    expect(s.winner).toBe(s.playerTeam[0])
  })

  it('a razed camp stops mustering, and a rebuilt one starts again', () => {
    const { grid, s } = simOf(2)
    const camps: { at: number; def: string }[] = []
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 0 && s.def.entities[s.type[i]].id.startsWith('muster-')) {
        camps.push({ at: i, def: s.def.entities[s.type[i]].id })
      }
    }
    expect(camps.length).toBeGreaterThan(2)
    const razed = camps[0].def
    const spared = camps[2].def
    const firedFor = (campDef: string): number =>
      s.trig.defs.reduce((sum, d, i) => (d.id.startsWith(`wave-${campDef}-a`) ? sum + s.trig.fired[i] : sum), 0)

    s.hp[camps[0].at] = 0
    step(s, grid, [])
    const razedAtDeath = firedFor(razed)
    const sparedAtDeath = firedFor(spared)

    // Three wave cycles with the camp down.
    for (let t = 0; t < 60 * 10 * 3; t++) step(s, grid, [])
    expect(firedFor(razed), `${razed} is still mustering`).toBe(razedAtDeath)
    expect(firedFor(spared), `${spared} stopped mustering`).toBeGreaterThan(sparedAtDeath)

    // Now raise it again on the ground it left behind. The waves must resume —
    // they are gated on the camp standing, not switched off when it fell.
    const pad = (): number => {
      for (let i = 0; i < s.count; i++) {
        if (s.alive[i] && s.def.entities[s.type[i]].id === `pad-${razed}`) return i
      }
      return -1
    }
    const p = pad()
    expect(p, 'the razed camp left no ground behind').toBeGreaterThanOrEqual(0)
    spawnBuilding(s, grid, s.def.entIndex.get(razed)!, 0, s.posX[p], s.posZ[p], false)
    const rebuiltAt = firedFor(razed)
    for (let t = 0; t < 60 * 10 * 2; t++) step(s, grid, [])
    expect(firedFor(razed), `${razed} was rebuilt but never mustered again`).toBeGreaterThan(rebuiltAt)
  }, 60000)
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
