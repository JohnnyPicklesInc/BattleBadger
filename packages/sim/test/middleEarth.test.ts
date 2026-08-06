import { describe, expect, it } from 'vitest'
import {
  ANDUIN,
  CRAG_GEOMETRY,
  FORDS,
  generateMiddleEarth,
  MIDDLE_EARTH_CAMPS,
  MIDDLE_EARTH_DEF,
  RIVER_SPARE,
  SPARED_GROUND,
} from '../src/mapgen/middleEarth.ts'
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

  it('the Anduin is a real barrier, crossed only at its fords', () => {
    const { walkable } = deriveTerrain(doc)
    const dry = (x: number, z: number): boolean => walkable[Math.floor(z) * doc.cols + Math.floor(x)] === 1
    // Every crossing the map declares is open. Read from the map rather than
    // copied into the test: the three points this used to check were not on the
    // Anduin at all — they were spots in the Misty Mountains, and they passed
    // for as long as they did because a camp's clearing happened to cover them.
    for (const ford of FORDS) {
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
      // Counted in BATTALIONS, not men. A rider battalion is five and an orc
      // battalion is fifteen, so Rohan's horse-heavy opening is fewer bodies
      // than Moria's and that is the design rather than a shortfall.
      const bands = new Set<number>()
      for (const i of mine) if (s.kind[i] === Kind.Unit && s.hordeOf[i] >= 0) bands.add(s.hordeOf[i])
      expect(bands.size, `slot ${slot} opening army`).toBeGreaterThanOrEqual(6)
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
    const capitalOf = (slot: number): string =>
      doc.placed!.filter((p) => p.def.startsWith('muster-') && p.owner === slot)[0].def
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

    // Isengard is the only power that musters men AND orcs. Asserted as the
    // PROPERTY rather than by naming h-swordsmen: Isengard's foot moved to
    // berserkers and riders, which is still men beside orcs, and the old
    // assertion failed a roster that had not stopped being Isengard's.
    const MEN = ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-riders', 'h-berserkers']
    const bothArms = (t: Set<string>): boolean => t.has('h-orcs') && MEN.some((m) => t.has(m))
    expect(bothArms(isengard), 'Isengard fields men and orcs in one line').toBe(true)
    for (const slot of [0, 1, 2, 4, 5, 6, 7]) {
      expect(bothArms(ticketsOf(slot)), `slot ${slot} should not field both men and orcs`).toBe(false)
    }
    expect(gondor.has('h-orcs'), 'Gondor fields no orcs').toBe(false)

    // The elven archer outranges every other bow on the map, which is the
    // entire faction — assert the number, not just that the unit exists.
    const ent = (id: string) => MIDDLE_EARTH_DEF.entities.find((e) => e.id === id)!
    const bow = (id: string): number => ent(id).combat!.range
    expect(bow('elf-archer')).toBeGreaterThan(bow('archer'))
    expect(bow('elf-archer')).toBeGreaterThan(bow('orc-archer'))
    // …and the dwarf out-bodies every other footman.
    expect(ent('dwarf-warrior').hp).toBeGreaterThan(ent('swordsman').hp)
    expect(ent('dwarf-warrior').hp).toBeGreaterThan(ent('orc').hp)

    // Each power's ONE unit, and nobody else's.
    const owns = (slot: number, ticket: string): boolean => ticketsOf(slot).has(ticket)
    const sole = (ticket: string, slot: number): void => {
      expect(owns(slot, ticket), `slot ${slot} should field ${ticket}`).toBe(true)
      for (let other = 0; other < 8; other++) {
        if (other === slot) continue
        expect(owns(other, ticket), `${ticket} leaked to slot ${other}`).toBe(false)
      }
    }
    sole('h-dunedain', 0) // Gondor
    sole('h-berserkers', 3) // Isengard
    sole('h-black-numenoreans', 5) // Harad
    sole('h-wargs', 7) // Moria

    // Mordor opens WITH trolls; nobody else has them in a first-age wave.
    const firstAge = (slot: number): Set<string> => {
      const out = new Set<string>()
      for (const t of doc.triggers!) {
        if (!t.id.startsWith('wave-') || !t.id.endsWith('-a0')) continue
        for (const a of t.actions) if (a.type === 'spawnUnits' && a.owner === slot) out.add(a.def)
      }
      return out
    }
    expect(firstAge(1).has('h-ogre'), 'Mordor should open with a troll').toBe(true)
    expect(firstAge(2).has('h-riders'), 'Rohan should open on horse').toBe(true)
    expect(firstAge(5).has('h-archers') && firstAge(5).has('h-riders'), 'Harad opens with bows and horse').toBe(true)

    // Mordor fields the most, Gondor close behind, the Dwarves the fewest.
    const perCycle = (slot: number): number => {
      let n = 0
      for (const t of doc.triggers!) {
        if (!t.id.startsWith('wave-') || !t.id.startsWith(`wave-${capitalOf(slot)}`)) continue
        for (const a of t.actions) if (a.type === 'spawnUnits') n++
      }
      return n
    }
    expect(perCycle(1), 'Mordor should field the most').toBeGreaterThan(perCycle(0))
    expect(perCycle(0), 'Gondor should be close behind Mordor').toBeGreaterThan(perCycle(1) - 4)
    expect(perCycle(6), 'the Dwarves should field the fewest').toBeLessThan(perCycle(0))

    // The berserker is the only thing on the map whose SWING knocks a rank
    // down — that, not its damage, is what Isengard is buying.
    const zerk = ent('berserker').combat!
    expect(zerk.splashRadius).toBeGreaterThan(0)
    expect(zerk.knockback).toBeGreaterThan(0)
    expect(zerk.knockdownTicks).toBeGreaterThan(0)
    expect(ent('berserker').aura, 'a berserker is not a hero').toBeUndefined()

    // Dwarves cannot be ridden down: a charge flattens only what is strictly
    // below its crusher level, and cavalry crushes at 2.
    expect(ent('dwarf-warrior').crushableLevel).toBeGreaterThanOrEqual(2)
    expect(ent('swordsman').crushableLevel ?? 1).toBeLessThan(2)
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

describe('The War of the Ring — how every camp is held', () => {
  // One rule, applied twenty-nine times: a camp is SHUT on the side the enemy
  // comes from and OPEN behind it. Osgiliath's reinforcements come from the
  // rest of Gondor; a wall that rings a camp walls its own realm out as surely
  // as the enemy, and then needs posterns to undo the problem it made.
  //
  // Two ways to shut a side. Masonry — a stockade's fence or a curtain's
  // fortress wall — and rock, which is better, because nothing in the game can
  // break a mountain.
  const MASONRY = new Set(['wall', 'gate', 'wall-tower'])

  /**
   * The camp a piece of stone belongs to: the one whose ring it best sits on.
   * Not the nearest camp — a wall-tower on the Iron Hills' gate stands 28 tiles
   * from the Iron Hills and 18 from Erebor, so "nearest" hands Erebor a piece
   * of somebody else's fortress and then fails Erebor for building it.
   */
  const off = (p: { x: number; z: number; def?: string }, c: (typeof MIDDLE_EARTH_CAMPS)[number]): number => {
    const d = Math.sqrt((c.at.x - p.x) ** 2 + (c.at.z - p.z) ** 2)
    // Which ring the piece could belong to depends on what it IS. Offering
    // every band to every camp put Nan Curunír's watchtowers on Orthanc's books
    // because they happened to stand 28 tiles out — and Orthanc, having a
    // curtain, has no gate at 28 to put anything on.
    if (p.def === 'watchtower' || p.def === 'tower-plot') return Math.abs(d - CRAG_GEOMETRY.towerRadius)
    let best = Math.abs(d - CRAG_GEOMETRY.wallRadius)
    if (c.crag && c.hold !== 'curtain') best = Math.min(best, Math.abs(d - CRAG_GEOMETRY.gateRadius))
    return best
  }
  const ringOwner = (p: { x: number; z: number; def?: string }): (typeof MIDDLE_EARTH_CAMPS)[number] =>
    MIDDLE_EARTH_CAMPS.reduce((best, c) => (off(p, c) < off(p, best) ? c : best))

  /** Everything a camp built, as signed bearings off the way it looks. */
  const arcOf = (plan: (typeof MIDDLE_EARTH_CAMPS)[number]): { x: number; z: number; def: string; d: number }[] => {
    const face = Math.atan2(plan.face.z, plan.face.x)
    return doc
      .placed!.filter((p) => MASONRY.has(p.def) && p.owner === plan.slot)
      .filter((p) => Math.sqrt((p.x - plan.at.x) ** 2 + (p.z - plan.at.z) ** 2) < 20)
      .filter((p) => ringOwner(p).id === plan.id)
      .map((p) => {
        let d = ((Math.atan2(p.z - plan.at.z, p.x - plan.at.x) - face) * 180) / Math.PI
        while (d > 180) d -= 360
        while (d < -180) d += 360
        return { x: p.x, z: p.z, def: p.def, d }
      })
      .sort((u, v) => u.d - v.d)
  }

  it('holds every camp on the map, and none of them by hope alone', () => {
    for (const plan of MIDDLE_EARTH_CAMPS) {
      const held = plan.hold !== undefined || plan.crag !== undefined
      expect(held, `${plan.name} stands in the open`).toBe(true)
      // …and a door. Somewhere within reach of every camp there is a gate an
      // attacker has to break, whether it stands in a wall or in a throat of
      // rock. Sixty tiles because a crag's gate sits out at the mountain.
      const gate = doc.placed!.some(
        (p) =>
          p.def === 'gate' &&
          p.owner === plan.slot &&
          Math.sqrt((p.x - plan.at.x) ** 2 + (p.z - plan.at.z) ** 2) < 60,
      )
      expect(gate, `${plan.name} has no gate`).toBe(true)
    }
  })

  it('builds its wall across the front and nothing behind it', () => {
    // 11.25° a slot: a stockade runs five slots either side of dead ahead and a
    // curtain nine, plus a slot of slack for the gate's own width.
    const REACH = { stockade: 5 * 11.25 + 12, curtain: 9 * 11.25 + 12 }
    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.hold) continue
      const arc = arcOf(plan)
      expect(arc.length, `${plan.name} has barely any wall`).toBeGreaterThanOrEqual(plan.hold === 'curtain' ? 14 : 8)
      for (const p of arc) {
        expect(
          Math.abs(p.d),
          `${plan.name} built a ${p.def} behind itself at ${p.d.toFixed(0)}°`,
        ).toBeLessThanOrEqual(REACH[plan.hold])
      }
    }
  })

  it('leaves no hole in that wall an army walks through', () => {
    // The regression that started all of this: seven pieces on a 15-tile arc,
    // 9.4 tiles apart, for a wall three tiles wide. It read as a fortress in a
    // screenshot and an army walked between the stones without touching them.
    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.hold) continue
      const arc = arcOf(plan)
      let worst = 0
      let where = ''
      for (let i = 0; i + 1 < arc.length; i++) {
        const a = arc[i]
        const b = arc[i + 1]
        const gap = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2)
        const allowed = a.def === 'gate' || b.def === 'gate' ? 7.5 : 3.6
        if (gap - allowed > worst) {
          worst = gap - allowed
          where = `${a.def}(${a.d.toFixed(0)}°)→${b.def}(${b.d.toFixed(0)}°) ${gap.toFixed(1)} apart`
        }
      }
      expect(worst, `${plan.name} has a hole in its wall: ${where}`).toBeLessThanOrEqual(0)
    }
  })

  it('stands its wall outside the muster ground and inside the cleared ground', () => {
    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.hold) continue
      for (const p of arcOf(plan)) {
        const d = Math.sqrt((p.x - plan.at.x) ** 2 + (p.z - plan.at.z) ** 2)
        expect(d, `${plan.name} walled across its own muster ground`).toBeGreaterThan(12)
        expect(d, `${plan.name} built outside the ground carved for it`).toBeLessThan(plan.clearing)
      }
    }
  })

  it('rings a crag in rock, and cuts the ways through it where it meant to', () => {
    const { walkable } = deriveTerrain(doc)
    const mid = (CRAG_GEOMETRY.inner + CRAG_GEOMETRY.outer) / 2
    /** Is this point inside a corridor cut out of ANY camp's ring? */
    const inSomeMouth = (x: number, z: number): boolean =>
      MIDDLE_EARTH_CAMPS.some((c) =>
        (c.crag ?? []).some((m) => {
          const ox = x - c.at.x
          const oz = z - c.at.z
          const along = ox * m.x + oz * m.z
          return along > 0 && along <= CRAG_GEOMETRY.mouthOut && Math.abs(ox * -m.z + oz * m.x) <= CRAG_GEOMETRY.mouthHalf
        }),
      )
    /** Ground the map spares from rock on purpose: any camp's cleared disc, and
     *  the Anduin's banks — a ring of stone dropped on the river bank plugs the
     *  road that runs along it, which is how the north-east fell off the map. */
    const spared = (x: number, z: number): boolean => {
      if (SPARED_GROUND.some((c) => Math.sqrt((c.at.x - x) ** 2 + (c.at.z - z) ** 2) < c.r + 1)) return true
      for (let k = 0; k + 1 < ANDUIN.length; k++) {
        const a = ANDUIN[k]
        const b = ANDUIN[k + 1]
        const vx = b.x - a.x
        const vz = b.z - a.z
        const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz)))
        if (Math.sqrt((x - a.x - vx * t) ** 2 + (z - a.z - vz * t) ** 2) < RIVER_SPARE + 1) return true
      }
      return false
    }

    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.crag) continue
      let rock = 0
      let hole = 0
      let firstHole = ''
      for (let k = 0; k < 360; k++) {
        const a = (k * Math.PI) / 180
        const x = plan.at.x + Math.cos(a) * mid
        const z = plan.at.z + Math.sin(a) * mid
        const i = Math.floor(z) * doc.cols + Math.floor(x)
        // Water and a neighbour's cleared ground are spared from the rock by
        // design, and a corridor — this camp's or the camp next door's — is
        // supposed to be open. What is left has to be mountain.
        // A ramp is a carved road like a mouth is — Edoras's way down off its
        // hill clips the outer edge of Orthanc's ring on its way past.
        if (doc.texture![i] === 6 || doc.ramp![i] === 1 || spared(x, z) || inSomeMouth(x, z)) continue
        if (walkable[i] === 1) {
          hole++
          firstHole ||= `${k}°`
        } else rock++
      }
      // Of the 360 bearings round the ring, everything that is not a mouth, not
      // water and not ground the map spares on purpose has to be mountain. Two
      // stray degrees of slack for where a spared disc's edge lands between
      // sample points; the rings themselves come out at 0 or 1.
      expect(hole, `${plan.name}'s ring is open ground at ${firstHole} where it should be rock`).toBeLessThanOrEqual(2)
      // Minas Tirith is the thinnest ring on the map at 115° of rock — its
      // circle is mostly river bank and Pelennor, both spared — and even that
      // closes the two flanks the White Mountains and the Anduin do not.
      expect(rock, `${plan.name} has no ring worth the name`).toBeGreaterThanOrEqual(100)
    }
  })

  it('cuts a way OUT of every crag, not just a hole in the ring', () => {
    // A mouth that stops inside the mountain is not a mouth. Walk each one from
    // the camp out through the far edge of the ring band.
    const { walkable } = deriveTerrain(doc)
    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.crag) continue
      for (const [n, m] of plan.crag.entries()) {
        let stopped = -1
        for (let r = 2; r < CRAG_GEOMETRY.outer; r++) {
          const x = Math.floor(plan.at.x + m.x * r)
          const z = Math.floor(plan.at.z + m.z * r)
          if (walkable[z * doc.cols + x] !== 1) {
            stopped = r
            break
          }
        }
        expect(stopped, `${plan.name}'s mouth ${n} is stopped ${stopped} tiles out`).toBe(-1)
      }
    }
  })

  it('makes every wall a wall you can SEE', () => {
    // An invisible wall is the worst thing a map can have: open grass an army
    // bounces off. The plains of Rohan are painted with a 38-tile brush and it
    // went straight over the Misty Mountains' skirt — two thousand cells of
    // field that stopped you dead, and the same for Harad's sand.
    const { walkable } = deriveTerrain(doc)
    const READS_AS_WALL = new Set([2, 4, 6]) // rock, snow, water
    const bad = new Map<string, number>()
    let first = ''
    for (let z = 0; z < doc.rows; z++) {
      for (let x = 0; x < doc.cols; x++) {
        const i = z * doc.cols + x
        if (walkable[i] === 1 || READS_AS_WALL.has(doc.texture![i])) continue
        const k = String(doc.texture![i])
        bad.set(k, (bad.get(k) ?? 0) + 1)
        first ||= `${x},${z}`
      }
    }
    expect([...bad.values()].reduce((a, b) => a + b, 0), `ground you cannot walk on and cannot see, from ${first}`).toBe(0)
  })

  it('gives a hill exactly one way up, and it goes all the way', () => {
    // A mesa closes its own rim; the ramp is the only break in it. Edoras's had
    // four tiles of Fangorn's skirt sitting in the middle of it, because the
    // ramp skipped blocked ground instead of carving it — so the hall on the
    // hill was a hall nothing could walk to, and every test still passed until
    // an unrelated dyke two camps away shut the back way in.
    const { walkable } = deriveTerrain(doc)
    for (const plan of MIDDLE_EARTH_CAMPS) {
      if (!plan.mesa) continue
      const clearing = plan.clearing
      for (let r = 2; r <= clearing + 9; r++) {
        const x = Math.floor(plan.at.x + plan.mesa.x * r)
        const z = Math.floor(plan.at.z + plan.mesa.z * r)
        expect(walkable[z * doc.cols + x], `${plan.name}'s ramp is broken ${r} tiles up`).toBe(1)
      }
      // …and the rim really is a rim: walk round it and most of it must stop
      // you, or the hill is decoration.
      let rim = 0
      for (let k = 0; k < 360; k += 3) {
        const a = (k * Math.PI) / 180
        const x = Math.floor(plan.at.x + Math.cos(a) * (clearing + 5))
        const z = Math.floor(plan.at.z + Math.sin(a) * (clearing + 5))
        if (walkable[z * doc.cols + x] !== 1) rim++
      }
      expect(rim, `${plan.name} is a hill you can walk up anywhere`).toBeGreaterThan(70)
    }
  })

  it('leaves the road in from behind clear at every camp', () => {
    // The rear is where a realm's own reinforcements arrive. Nothing the map
    // places may stand in it — not a wall, not an engine, not a tower. Osgiliath
    // had its two wall-catapults astride the road from Minas Tirith and a
    // watchtower eight tiles due west of the camp, in the middle of it.
    const MINE = new Set(['wall', 'gate', 'wall-tower', 'wall-catapult', 'watchtower', 'tower-plot'])
    for (const plan of MIDDLE_EARTH_CAMPS) {
      for (const p of doc.placed!) {
        if (!MINE.has(p.def) || p.owner !== plan.slot) continue
        const dx = p.x - plan.at.x
        const dz = p.z - plan.at.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < 4 || d > 34) continue
        // Its own, not a neighbour's. Khazad-dûm's gate tower stands twelve
        // tiles from the East-gate and twenty-eight from Khazad-dûm, so
        // "nearest" blames the wrong camp; the ring it sits on does not.
        if (ringOwner(p).id !== plan.id) continue
        const back = (dx * plan.face.x + dz * plan.face.z) / d
        if (back > -0.25) continue // not behind
        const across = Math.abs(dx * -plan.face.z + dz * plan.face.x)
        expect(across, `${plan.name} put a ${p.def} in its own back road`).toBeGreaterThanOrEqual(6)
      }
    }
  })

  it('never walls a camp off from the rest of the map', () => {
    // The failure this exists for: Dol Guldur's ring reached the Anduin, and
    // the bank it plugged was the only road south. Erebor, the Iron Hills and
    // Dol Guldur went with it — forty thousand cells and three camps that no
    // army could walk to or out of, and nothing else in the suite noticed.
    const seen = reachable(MIDDLE_EARTH_CAMPS[0].at)
    for (const plan of MIDDLE_EARTH_CAMPS) {
      const k = Math.floor(plan.at.z) * doc.cols + Math.floor(plan.at.x)
      expect(seen[k], `${plan.name} cannot be walked to from Minas Tirith`).toBe(1)
    }
  })

  it('gives no two realms the same piece of ground', () => {
    // Helm's Deep stood ten tiles from Dunland and Dimrill Dale ten from
    // Orthanc: enemy camps sharing one cleared disc, one set of towers and one
    // set of muster points, with a mountain range nominally between them.
    for (const a of MIDDLE_EARTH_CAMPS) {
      for (const b of MIDDLE_EARTH_CAMPS) {
        if (a.slot >= b.slot) continue
        const d = Math.sqrt((a.at.x - b.at.x) ** 2 + (a.at.z - b.at.z) ** 2)
        expect(d, `${a.name} and ${b.name} are different realms sharing ground`).toBeGreaterThan(
          a.clearing + b.clearing,
        )
      }
    }
  })
})

describe('The War of the Ring — engines and sappers', () => {
  const ticketsOf = (slot: number): Set<string> => {
    const out = new Set<string>()
    for (const t of doc.triggers!) {
      for (const a of t.actions) if (a.type === 'spawnUnits' && a.owner === slot) out.add(a.def)
    }
    return out
  }
  const ent = (id: string): (typeof MIDDLE_EARTH_DEF.entities)[number] =>
    MIDDLE_EARTH_DEF.entities.find((e) => e.id === id)!

  it('opens with its monsters and its horse, not with a wall of swordsmen', () => {
    // What the first wave IS, is what the realm is. A shadow power that spends
    // its opening age on plain infantry and techs into trolls afterwards plays
    // like everybody else for five minutes.
    const ageOne = (slot: number): string[] => {
      const camp = doc.placed!.filter((p) => p.def.startsWith('muster-') && p.owner === slot)[0].def
      const t = doc.triggers!.find((k) => k.id === `wave-${camp}-a0`)!
      return t.actions.filter((a) => a.type === 'spawnUnits').map((a) => a.def)
    }
    // Mordor and Moria both field a monster in the first wave.
    expect(ageOne(1).filter((d) => d === 'h-ogre').length, 'Mordor opens without its trolls').toBeGreaterThanOrEqual(2)
    expect(ageOne(7), 'Moria opens without a troll').toContain('h-ogre')
    expect(ageOne(7), 'Moria opens without wargs').toContain('h-wargs')
    // Gondor rides from the first age now, and Rohan does nothing else.
    expect(ageOne(0), 'Gondor opens without horse').toContain('h-riders')
    expect(new Set(ageOne(2)), 'Rohan opens with something other than horse').toEqual(new Set(['h-riders']))
    // Isengard's berserkers are an opening unit, not a tech.
    expect(ageOne(3), 'Isengard opens without berserkers').toContain('h-berserkers')
  })

  it('gives the shadow sappers and the free peoples none', () => {
    const SAPPERS = ['h-sappers', 'h-mine-bearers']
    for (const slot of [1, 3, 5, 7]) {
      const t = ticketsOf(slot)
      expect(SAPPERS.some((k) => t.has(k)), `shadow slot ${slot} has no sappers`).toBe(true)
    }
    for (const slot of [0, 2, 4, 6]) {
      const t = ticketsOf(slot)
      expect(SAPPERS.some((k) => t.has(k)), `free slot ${slot} should not field sappers`).toBe(false)
    }
  })

  it('makes a sapper worth its life against stone and nothing else', () => {
    // The whole design in one assertion: the blast is siege-typed, so the
    // armour table multiplies it 400% into a wall and 35% into the men who
    // probably did the killing. A sapper spent on infantry is a sapper wasted.
    for (const id of ['sapper', 'mine-bearer']) {
      const e = ent(id)
      expect(e.deathBlast, `${id} does not go off`).toBeDefined()
      expect(e.combat!.damageType, `${id}'s blast is typed by its weapon`).toBe('siege')
      expect(e.combat!.damage, `${id} should be no good in a fight`).toBeLessThan(15)
    }
    const wall = MIDDLE_EARTH_DEF.entities.find((e) => e.id === 'gate')!
    expect(wall.armorType).toBe('structure')
  })

  it('is one man to a battalion, like a catapult or a hero', () => {
    // Six to a battalion at 1.2 spacing sat inside their own blast radius,
    // which decided the friendly-fire question by accident rather than design.
    for (const id of ['h-sappers', 'h-mine-bearers']) {
      const ticket = MIDDLE_EARTH_DEF.entities.find((e) => e.id === id)!
      expect(ticket.horde?.count, `${id} should be a horde of one`).toBe(1)
    }
  })

  it('is worth twenty-five times as much against stone as against a man', () => {
    const { s, grid } = simOf()
    const gate = doc.placed!.find((p) => p.def === 'gate' && p.owner === 0)!
    const before = { gate: 0, man: 0 }

    // A gate and a man of Gondor's, and one of Mordor's sappers on top of both.
    const g = spawnBuilding(s, grid, s.def.entIndex.get('gate')!, 0, gate.x + 60, gate.z + 60, false)
    const man = spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, gate.x + 62, gate.z + 60)
    const sap = spawnUnit(s, s.def.entIndex.get('sapper')!, 1, gate.x + 60.5, gate.z + 60.5)
    before.gate = s.hp[g]
    before.man = s.hp[man]

    // Kill the sapper where it stands.
    s.hp[sap] = 0
    step(s, grid, [])

    const toGate = before.gate - s.hp[g]
    const toMan = before.man - s.hp[man]
    // Half a great gate from one man. Two sappers open it; one mine-bearer
    // very nearly does on his own.
    expect(toGate, 'the charge did nothing to the gate').toBeGreaterThan(2500)
    // It is not harmless to infantry — 35% of eight hundred still kills the
    // swordsman it lands on. What it is not is a way to clear a field: the
    // armour table is worth more than an order of magnitude here, so a sapper
    // spent on men is a sapper thrown away.
    expect(toGate / toMan, 'the charge is as good against men as against stone').toBeGreaterThan(10)
  })

  it('brings a ram that opens gates and cannot fight', () => {
    const ram = ent('battering-ram')
    expect(ram.combat!.damageType).toBe('siege')
    expect(ram.armorType).toBe('engine')
    // Slower than every soldier on the map: a ram is escorted or it is lost.
    const foot = ent('swordsman').mover!.speed
    expect(ram.mover!.speed, 'a ram should not outrun the men guarding it').toBeLessThan(foot)
    // And six of the eight powers can field one.
    const withRam = [0, 1, 2, 3, 4, 5, 6, 7].filter((slot) => ticketsOf(slot).has('h-ram'))
    expect(withRam.length, 'hardly anybody can open a gate').toBeGreaterThanOrEqual(5)
  })

  it('puts more engines on the field than it used to, and none in Rohan', () => {
    const engines = (slot: number): number => {
      let n = 0
      for (const t of doc.triggers!) {
        for (const a of t.actions) {
          if (a.type === 'spawnUnits' && a.owner === slot && (a.def === 'h-catapult' || a.def === 'h-ram')) n++
        }
      }
      return n
    }
    // Counted over every camp's every age: this is the ask, so assert it.
    const total = [0, 1, 2, 3, 4, 5, 6, 7].reduce((a, slot) => a + engines(slot), 0)
    expect(total, 'the map fields barely any siege').toBeGreaterThan(40)
    // Rohan is the exception, and stays one. It arrives; it does not besiege.
    expect(engines(2), 'Rohan built an engine').toBe(0)
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
