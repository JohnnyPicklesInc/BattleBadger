import { describe, expect, it } from 'vitest'
import {
  compileGameDef,
  createSim,
  handleOf,
  spawnUnit,
  stateHash,
  step,
  walkGridFromDoc,
  type GameDef,
  type SimState,
} from '@battlebadger/sim'

const DEF: GameDef = {
  schema: 1,
  id: 'charge-test',
  name: 'Charge Test',
  resources: [{ id: 'gold', name: 'Gold', startAmount: 0 }],
  armorTypes: ['infantry', 'engine'],
  entities: [
    {
      id: 'lancer', name: 'Lancer', kind: 'unit', radius: 0.5, hp: 220,
      crusherLevel: 2, crushableLevel: 2,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 8 },
      combat: {
        damage: 10, range: 0.8, acquire: 10, periodTicks: 11,
        charge: { minSpeed: 5, damage: 80, knockback: 2, cooldownTicks: 30 },
      },
    },
    {
      id: 'footman', name: 'Footman', kind: 'unit', radius: 0.4, hp: 400,
      armorType: 'infantry', crushableLevel: 1,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 1 },
    },
    {
      // an armoured engine: a horse should not bowl this over
      id: 'engine', name: 'Engine', kind: 'unit', radius: 0.5, hp: 400,
      armorType: 'engine', crushableLevel: 3,
      visual: { model: 'placeholder:box' },
      mover: { speed: 1 },
    },
    {
      // no charge block: proves the gate is per-def, not global
      id: 'walker', name: 'Walker', kind: 'unit', radius: 0.5, hp: 220,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 8 },
      combat: { damage: 10, range: 0.8, acquire: 10, periodTicks: 11 },
    },
  ],
  abilities: [],
  victory: { mode: 'triggersOnly' },
}

const FLAT = {
  version: 1 as const, name: 'flat', seed: 1, cols: 90, rows: 90, cellSize: 1,
  originX: 0, originZ: 0,
  walkable: Array.from({ length: 90 * 90 }, () => 1),
  startLocations: [{ x: 8, z: 8 }],
}

function world(): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } {
  const s = createSim(1, compileGameDef(DEF))
  s.playerCount = 2
  s.playerTeam[0] = 0
  s.playerTeam[1] = 1
  return { s, grid: walkGridFromDoc(FLAT) }
}

const spawn = (s: SimState, id: string, owner: number, x: number, z: number): number =>
  spawnUnit(s, s.def.entIndex.get(id)!, owner, x, z)

/** Ride `rider` at `foe` and report the worst damage seen in one contact. */
function ride(s: SimState, grid: ReturnType<typeof walkGridFromDoc>, rider: number, foe: number, ticks = 60): number {
  const hp0 = s.hp[foe]
  step(s, grid, [{ kind: 'attackMove', player: s.owner[rider], units: [handleOf(s, rider)], x: s.posX[foe], z: s.posZ[foe] }])
  let worstStep = 0
  let prev = hp0
  for (let t = 0; t < ticks; t++) {
    step(s, grid, [])
    const lost = prev - s.hp[foe]
    if (lost > worstStep) worstStep = lost
    prev = s.hp[foe]
  }
  return worstStep
}

describe('cavalry charge', () => {
  it('a galloping rider hits far harder than its swing', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20)
    const foe = spawn(s, 'footman', 1, 45, 20)
    const worst = ride(s, grid, rider, foe)
    // the weapon does 10; the impact does 80
    expect(worst, 'never landed a charge').toBeGreaterThan(40)
  })

  it('a unit with no charge block only ever swings', () => {
    const { s, grid } = world()
    const walker = spawn(s, 'walker', 0, 20, 20)
    const foe = spawn(s, 'footman', 1, 45, 20)
    const worst = ride(s, grid, walker, foe)
    expect(worst, 'a non-charger dealt impact damage').toBeLessThanOrEqual(10)
  })

  it('a standing rider cannot charge — momentum is required', () => {
    const { s, grid } = world()
    spawn(s, 'lancer', 0, 20, 20)
    const foe = spawn(s, 'footman', 1, 20.9, 20) // already in contact, no run-up
    const hp0 = s.hp[foe]
    let prev = hp0
    let worst = 0
    for (let t = 0; t < 40; t++) {
      step(s, grid, [])
      const lost = prev - s.hp[foe]
      if (lost > worst) worst = lost
      prev = s.hp[foe]
    }
    expect(s.hp[foe], 'nothing happened at all').toBeLessThan(hp0) // it still fights
    expect(worst, 'charged from a standstill').toBeLessThanOrEqual(10)
  })

  it('the victim is shoved away from the rider', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20)
    const foe = spawn(s, 'footman', 1, 45, 20)
    const startX = s.posX[foe]
    ride(s, grid, rider, foe, 60)
    // knocked along the line of the charge (+x), not merely jostled
    expect(s.posX[foe] - startX, 'victim was not knocked back').toBeGreaterThan(0.5)
  })

  it('impact winds the rider down, so it cannot grind on the spot', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20)
    const foe = spawn(s, 'footman', 1, 45, 20)
    step(s, grid, [{ kind: 'attackMove', player: 0, units: [handleOf(s, rider)], x: 45, z: 20 }])
    for (let t = 0; t < 60 && s.chargeCd[rider] === 0; t++) step(s, grid, [])
    expect(s.chargeCd[rider], 'no wind-down after impact').toBeGreaterThan(0)
    // and while winding down another impact cannot land
    const hpAfterImpact = s.hp[foe]
    let prev = hpAfterImpact
    let worst = 0
    for (let t = 0; t < 12; t++) {
      step(s, grid, [])
      const lost = prev - s.hp[foe]
      if (lost > worst) worst = lost
      prev = s.hp[foe]
    }
    expect(worst, 'charged again during wind-down').toBeLessThanOrEqual(10)
  })

  it('never tramples an ally', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20)
    const friend = spawn(s, 'footman', 0, 32, 20)
    const friendHp = s.hp[friend]
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, rider)], x: 60, z: 20 }])
    for (let t = 0; t < 60; t++) step(s, grid, [])
    expect(s.hp[friend], 'rode down a friendly').toBe(friendHp)
  })

  it('raises a trample event the client can render', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20)
    spawn(s, 'footman', 1, 45, 20)
    step(s, grid, [{ kind: 'attackMove', player: 0, units: [handleOf(s, rider)], x: 45, z: 20 }])
    let seen = false
    for (let t = 0; t < 60 && !seen; t++) {
      step(s, grid, [])
      for (const ev of s.events) if (ev.t === 'trample') seen = true
    }
    expect(seen, 'no trample event').toBe(true)
  })

  it('charging is lockstep-deterministic', () => {
    const run = (): number[] => {
      const { s, grid } = world()
      const rider = spawn(s, 'lancer', 0, 20, 20)
      for (let k = 0; k < 6; k++) spawn(s, 'footman', 1, 40 + k * 0.9, 19 + (k % 3))
      const out: number[] = []
      step(s, grid, [{ kind: 'attackMove', player: 0, units: [handleOf(s, rider)], x: 45, z: 20 }])
      for (let t = 0; t < 150; t++) {
        step(s, grid, [])
        out.push(stateHash(s))
      }
      return out
    }
    expect(run()).toEqual(run())
  })
})

// Cavalry fights as a pack, not as individuals. A map that pre-places horde
// TICKETS must get bound battalions, exactly like ones trained at a barracks —
// otherwise the opening army has no formation, no veterancy and costs nothing.
describe('pre-placed armies are battalions', () => {
  it('Dunhollow opens with bound hordes, riders among them', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const { setupMatch, walkGridFromDoc: wg } = await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const s = setupMatch(doc, wg(doc), 2)

    for (const slot of [0, 1]) {
      let hordes = 0
      for (let h = 0; h < s.hordes.count; h++) {
        if (s.hordes.alive[h] === 1 && s.hordes.owner[h] === slot) hordes++
      }
      expect(hordes, `slot ${slot} fielded no battalions`).toBeGreaterThan(0)
      expect(s.supplyUsed[slot], 'a standing army should cost command points').toBeGreaterThan(0)
    }

    // every rider belongs to a horde, and that horde is a pack
    const riderTy = s.def.entIndex.get('rider')!
    let riders = 0
    const packs = new Set<number>()
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.type[i] !== riderTy) continue
      riders++
      expect(s.hordeOf[i], 'a loose rider').toBeGreaterThanOrEqual(0)
      packs.add(s.hordeOf[i])
    }
    expect(riders, 'no cavalry at all').toBeGreaterThan(0)
    for (const h of packs) {
      expect(s.hordes.members[h].length, 'cavalry should ride in a pack').toBeGreaterThan(1)
    }
  })

  it('a placed battalion levels, which a loose soldier cannot', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const { setupMatch, walkGridFromDoc: wg } = await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const s = setupMatch(doc, wg(doc), 2)
    const riderTy = s.def.entIndex.get('rider')!
    let rider = -1
    for (let i = 0; i < s.count && rider < 0; i++) if (s.alive[i] && s.type[i] === riderTy) rider = i
    const horde = s.hordeOf[rider]
    expect(horde).toBeGreaterThanOrEqual(0)
    expect(s.hordes.level[horde]).toBe(1)
    expect(s.def.hordeLevels.length, 'the map declares a veterancy ladder').toBeGreaterThan(1)
  })
})

describe('a charge only flattens what it is allowed to', () => {
  it('rides down infantry but not an armoured engine', () => {
    const a = world()
    const rider = spawn(a.s, 'lancer', 0, 20, 20)
    const foot = spawn(a.s, 'footman', 1, 45, 20)
    expect(ride(a.s, a.grid, rider, foot), 'infantry was not ridden down').toBeGreaterThan(40)

    const b = world()
    const rider2 = spawn(b.s, 'lancer', 0, 20, 20)
    const engine = spawn(b.s, 'engine', 1, 45, 20)
    expect(ride(b.s, b.grid, rider2, engine), 'flattened an engine').toBeLessThanOrEqual(10)
  })

  it('the hierarchy is a single number, and buildings sit above it by default', () => {
    const def = compileGameDef(DEF)
    const lancer = def.entIndex.get('lancer')!
    const footman = def.entIndex.get('footman')!
    const engine = def.entIndex.get('engine')!
    // strictly heavier wins: foot yes, its own weight no, heavier no
    expect(def.stats.crusherLevel[lancer]).toBeGreaterThan(def.stats.crushableLevel[footman])
    expect(def.stats.crusherLevel[lancer]).toBeLessThanOrEqual(def.stats.crushableLevel[lancer])
    expect(def.stats.crusherLevel[lancer]).toBeLessThan(def.stats.crushableLevel[engine])
  })

  it('a building can never be trampled even if nobody authored a level', () => {
    const def = compileGameDef({
      ...DEF,
      entities: [
        ...DEF.entities,
        { id: 'wall', name: 'Wall', kind: 'building', radius: 2, hp: 500, visual: { model: 'placeholder:box' } },
      ],
    })
    const wall = def.entIndex.get('wall')!
    expect(def.stats.crushableLevel[wall]).toBeGreaterThan(1000)
  })
})

// The damage matrix, not a special case, is what makes archers the prize.
describe('cavalry are worst for archers', () => {
  it('a charge kills an archer outright but not a swordsman', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const { setupMatch, walkGridFromDoc: wg, handleOf: h, spawnUnit: sp, step: st } =
      await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const grid = wg(doc)

    const hit = (victimId: string): { dmg: number; dead: boolean } => {
      const s = setupMatch(doc, grid, 1)
      // open ground with a clear run
      let ax = 0
      let az = 0
      outer: for (let z = 100; z < 150; z += 2) {
        for (let x = 20; x < 60; x += 2) {
          if (grid.isWalkableWorld(x, z) && grid.lineWalkable(x, z, x + 30, z)) {
            ax = x
            az = z
            break outer
          }
        }
      }
      const rider = sp(s, s.def.entIndex.get('rider')!, 0, ax, az)
      const victim = sp(s, s.def.entIndex.get(victimId)!, 1, ax + 26, az)
      const hp0 = s.hp[victim]
      st(s, grid, [{ kind: 'attackMove', player: 0, units: [h(s, rider)], x: ax + 26, z: az }])
      let worst = 0
      let prev = hp0
      for (let t = 0; t < 80; t++) {
        st(s, grid, [])
        const lost = prev - s.hp[victim]
        if (lost > worst) worst = lost
        prev = s.hp[victim]
        if (!s.alive[victim]) break
      }
      return { dmg: worst, dead: s.alive[victim] === 0 }
    }

    const onArcher = hit('archer')
    const onSword = hit('swordsman')
    expect(onArcher.dmg, 'archers should take the worst of it').toBeGreaterThan(onSword.dmg)
    expect(onArcher.dead, 'a charge should ride an archer down outright').toBe(true)
  })
})

// Bracing: a stance that raises crushableLevel refuses the charge outright,
// and the charger breaks on it. This is what makes Porcupine worth pressing.
describe('a refused charge breaks on the spears', () => {
  it('braced infantry cannot be ridden down, and the rider pays for trying', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const grid = sim.walkGridFromDoc(doc)

    const fight = (brace: boolean): { riders: number; pikes: number } => {
      const s = sim.setupMatch(doc, grid, 1)
      let ax = 0
      let az = 0
      outer: for (let z = 100; z < 150; z += 2) {
        for (let x = 20; x < 70; x += 2) {
          if (grid.isWalkableWorld(x, z) && grid.lineWalkable(x, z, x + 34, z)) {
            ax = x
            az = z
            break outer
          }
        }
      }
      const riders = sim.spawnHorde(s, grid, s.def.entIndex.get('h-riders')!, 0, ax, az, 1, 0)
      const pikes = sim.spawnHorde(s, grid, s.def.entIndex.get('h-spearmen')!, 1, ax + 30, az, -1, 0)
      if (brace) {
        // stance 2 is Porcupine — set to receive cavalry
        s.hordes.formation[s.hordeOf[pikes[0]]] = 2
        expect(sim.crushableOf(s, pikes[0]), 'bracing did not raise the level').toBeGreaterThan(
          s.def.stats.crushableLevel[s.type[pikes[0]]],
        )
      }
      step(s, grid, [
        { kind: 'attackMove', player: 0, units: riders.map((i) => sim.handleOf(s, i)), x: ax + 30, z: az },
      ])
      for (let t = 0; t < 250; t++) step(s, grid, [])
      return {
        riders: riders.filter((i) => s.alive[i]).length,
        pikes: pikes.filter((i) => s.alive[i]).length,
      }
    }

    const loose = fight(false)
    const braced = fight(true)
    // Loose pikes get run over; braced pikes break the charge and survive.
    // Both wipe the cavalry now that pikes bite back, so the difference shows
    // in how many spearmen are left standing, not in the horses.
    expect(loose.pikes, 'loose pikes should be ridden down').toBeLessThan(braced.pikes)
    expect(braced.riders, 'a charge into braced pikes should not pay').toBe(0)
  })

  it('recoil is opt-in: without it a refused charge is merely wasted', () => {
    const def = compileGameDef(DEF)
    // the test lancer declares no recoilPct
    expect(def.stats.chgRecoilPct[def.entIndex.get('lancer')!]).toBe(0)
  })

  it('a charge refused by weight deals no damage at all', () => {
    const { s, grid } = world()
    const rider = spawn(s, 'lancer', 0, 20, 20) // crusher 2
    const other = spawn(s, 'lancer', 1, 45, 20) // crushable 2 — equal, so refused
    ride(s, grid, rider, other, 80)
    // baseline AFTER the ride, or the first delta sweeps in everything above
    let worst = 0
    let prev = s.hp[other]
    for (let t = 0; t < 40; t++) {
      step(s, grid, [])
      const lost = prev - s.hp[other]
      if (lost > worst) worst = lost
      prev = s.hp[other]
    }
    expect(worst, 'flattened something of its own weight').toBeLessThanOrEqual(10)
  })
})

// The point of pikes. Loose, they must at minimum trade evenly with cavalry
// on resources; braced, they must win outright. Cavalry keeps its prey.
describe('pikes hold the line on cost', () => {
  it('spearmen trade at least evenly loose, and win braced; archers still die', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const grid = sim.walkGridFromDoc(doc)
    const RIDER_EACH = 500 / 5

    const clash = (
      foeTicket: string,
      foeCost: number,
      foeCount: number,
      stance = 0,
    ): { cavLost: number; foeLost: number } => {
      const s = sim.setupMatch(doc, grid, 1)
      let ax = 0
      let az = 0
      outer: for (let z = 100; z < 150; z += 2) {
        for (let x = 20; x < 70; x += 2) {
          if (grid.isWalkableWorld(x, z) && grid.lineWalkable(x, z, x + 34, z)) {
            ax = x
            az = z
            break outer
          }
        }
      }
      const riders = sim.spawnHorde(s, grid, s.def.entIndex.get('h-riders')!, 0, ax, az, 1, 0)
      const foes = sim.spawnHorde(s, grid, s.def.entIndex.get(foeTicket)!, 1, ax + 30, az, -1, 0)
      if (stance) s.hordes.formation[s.hordeOf[foes[0]]] = stance
      step(s, grid, [
        { kind: 'attackMove', player: 0, units: riders.map((i) => sim.handleOf(s, i)), x: ax + 30, z: az },
      ])
      for (let t = 0; t < 400; t++) step(s, grid, [])
      return {
        cavLost: (5 - riders.filter((i) => s.alive[i]).length) * RIDER_EACH,
        foeLost: (foeCount - foes.filter((i) => s.alive[i]).length) * (foeCost / foeCount),
      }
    }

    const loose = clash('h-spearmen', 300, 9)
    expect(loose.cavLost, 'loose pikes must not lose on cost').toBeGreaterThanOrEqual(loose.foeLost)

    const braced = clash('h-spearmen', 300, 9, 2) // Porcupine
    expect(braced.cavLost, 'braced pikes should win outright').toBeGreaterThan(braced.foeLost)
    // Loose pikes now also wipe the cavalry, so bracing cannot cost the horses
    // MORE — its payoff is that the spearmen survive to hold the ground.
    expect(braced.foeLost, 'bracing should save the pikes').toBeLessThan(loose.foeLost)

    // cavalry must still eat what it is meant to eat
    const vsArchers = clash('h-archers', 350, 8)
    expect(vsArchers.foeLost, 'cavalry should still ruin archers').toBeGreaterThan(vsArchers.cavLost)
  })
})

// A club that throws bodies. Unlike a charge this needs no momentum — the
// weapon does the work, so a stationary brute still sends men flying.
describe('weapon knockback', () => {
  it('an ogre swing shoves its victim away and raises the FX event', async () => {
    // The Pit, because the ogre is a Horde unit and that is the map that seats
    // the Horde. Its killing floor is open ground, so no site search is needed.
    const { generateTrollPit } = await import('../src/mapgen/trollPit.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateTrollPit()
    const grid = sim.walkGridFromDoc(doc)
    const s = sim.setupMatch(doc, grid, 1)
    const ax = 40
    const az = 48
    const ogre = sim.spawnUnit(s, s.def.entIndex.get('ogre')!, 0, ax, az)
    const foe = sim.spawnUnit(s, s.def.entIndex.get('swordsman')!, 1, ax + 2.2, az)
    const startX = s.posX[foe]
    let flung = false
    for (let t = 0; t < 60 && s.alive[foe]; t++) {
      step(s, grid, [])
      for (const ev of s.events) if (ev.t === 'trample') flung = true
    }
    expect(flung, 'no knockback FX event').toBe(true)
    // shoved away along the line of the blow, or killed outright by it
    if (s.alive[foe]) expect(s.posX[foe]).toBeGreaterThan(startX)
    expect(s.def.stats.atkKnockback[s.type[ogre]]).toBeGreaterThan(0)
  })

  it('an ordinary weapon shoves nobody', () => {
    const def = compileGameDef(DEF)
    // the test defs declare no knockback
    for (const id of ['lancer', 'walker']) {
      expect(def.stats.atkKnockback[def.entIndex.get(id)!]).toBe(0)
    }
  })
})

// A slow single-target hitter is out-DPSed by the ring of men around it, so
// the ogre's club sweeps. These pin the shape of the unit: it eats cheap
// infantry, and its counters still counter it.
describe('a sweeping club', () => {
  it('the ogre beats swordsmen worth twice its price, but not three times', async () => {
    const { generateTrollPit } = await import('../src/mapgen/trollPit.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateTrollPit()
    const grid = sim.walkGridFromDoc(doc)

    const pit = (foeTicket: string, packs: number): boolean => {
      const s = sim.setupMatch(doc, grid, 1)
      const ogre = sim.spawnUnit(s, s.def.entIndex.get('ogre')!, 0, 40, 48)
      const mob: number[] = []
      for (let k = 0; k < packs; k++) {
        mob.push(...sim.spawnHorde(s, grid, s.def.entIndex.get(foeTicket)!, 1, 62, 42 + k * 9, -1, 0))
      }
      step(s, grid, [
        { kind: 'attackMove', player: 1, units: mob.map((i) => sim.handleOf(s, i)), x: s.posX[ogre], z: s.posZ[ogre] },
      ])
      for (let t = 0; t < 900; t++) {
        step(s, grid, [])
        if (!s.alive[ogre] || mob.every((i) => !s.alive[i])) break
      }
      return s.alive[ogre] === 1
    }

    // 325 res of ogre against 300 and 600 res of swordsmen
    expect(pit('h-swordsmen', 1), 'lost to nine swordsmen').toBe(true)
    expect(pit('h-swordsmen', 2), 'lost to eighteen swordsmen').toBe(true)
    expect(pit('h-swordsmen', 3), 'beat three times its cost in swordsmen').toBe(false)

    // its counters still work: spears shred it (it wears cavalry armour) and
    // archers out-range it entirely
    expect(pit('h-spearmen', 1), 'spearmen should beat an ogre').toBe(false)
    expect(pit('h-archers', 1), 'archers should kite an ogre down').toBe(false)
  })

  it('splash is opt-in — an ordinary weapon strikes one man', () => {
    const def = compileGameDef(DEF)
    for (const id of ['lancer', 'walker']) {
      expect(def.stats.atkSplash[def.entIndex.get(id)!]).toBe(0)
    }
  })
})

// Knockdown: a shove that also takes the victim out of the fight for a moment.
describe('knockdown', () => {
  it('a shoved victim cannot move, attack or cast until it is up', async () => {
    // The Pit, because the ogre is a Horde unit and that is the map that seats
    // the Horde. Its killing floor is open ground, so no site search is needed.
    const { generateTrollPit } = await import('../src/mapgen/trollPit.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateTrollPit()
    const grid = sim.walkGridFromDoc(doc)
    const s = sim.setupMatch(doc, grid, 1)
    const ax = 40
    const az = 48
    sim.spawnUnit(s, s.def.entIndex.get('ogre')!, 0, ax, az)
    const foe = sim.spawnUnit(s, s.def.entIndex.get('swordsman')!, 1, ax + 2.2, az)
    let sawStun = false
    for (let t = 0; t < 80 && s.alive[foe]; t++) {
      step(s, grid, [])
      if (s.stun[foe] > 0) {
        sawStun = true
        // pinned: it holds still while it is down
        const x0 = s.posX[foe]
        const z0 = s.posZ[foe]
        step(s, grid, [])
        if (s.stun[foe] > 0 && s.alive[foe]) {
          expect(Math.abs(s.posX[foe] - x0) + Math.abs(s.posZ[foe] - z0)).toBeLessThan(0.05)
        }
        break
      }
    }
    expect(sawStun, 'the club never knocked anybody down').toBe(true)
  })

  it('knockdown is opt-in and wears off', () => {
    const def = compileGameDef(DEF)
    // the test defs declare none
    expect(def.stats.atkKnockdown[def.entIndex.get('lancer')!]).toBe(0)

    const { s, grid } = world()
    const victim = spawn(s, 'footman', 1, 30, 30)
    s.stun[victim] = 5
    for (let t = 0; t < 10; t++) step(s, grid, [])
    expect(s.stun[victim], 'stun never expired').toBe(0)
  })
})

// BFME's rule: running onto pikes hurts the horse, braced or not.
describe('pikes bite the charger', () => {
  it('a rider that rides down a loose pikeman still pays for it', async () => {
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const sim = await import('@battlebadger/sim')
    const doc = generateDunhollow(5)
    const grid = sim.walkGridFromDoc(doc)

    const ride1v1 = (foeId: string): { riderHp: number; maxHp: number } => {
      const s = sim.setupMatch(doc, grid, 1)
      let ax = 0
      let az = 0
      outer: for (let z = 100; z < 150; z += 2) {
        for (let x = 20; x < 70; x += 2) {
          if (grid.isWalkableWorld(x, z) && grid.lineWalkable(x, z, x + 30, z)) {
            ax = x
            az = z
            break outer
          }
        }
      }
      const rider = sim.spawnUnit(s, s.def.entIndex.get('rider')!, 0, ax, az)
      const foe = sim.spawnUnit(s, s.def.entIndex.get(foeId)!, 1, ax + 26, az)
      step(s, grid, [{ kind: 'attackMove', player: 0, units: [sim.handleOf(s, rider)], x: ax + 26, z: az }])
      // stop the instant the charge lands so we read the impact, not the melee
      for (let t = 0; t < 120; t++) {
        step(s, grid, [])
        if (s.chargeCd[rider] > 0) break
        if (!s.alive[foe] || !s.alive[rider]) break
      }
      return { riderHp: s.hp[rider], maxHp: s.def.stats.maxHp[s.type[rider]] }
    }

    const vsPike = ride1v1('spearman')
    const vsSword = ride1v1('swordsman')
    // both cost the rider something on the way in, but the spear costs more
    expect(vsPike.maxHp - vsPike.riderHp, 'the spear did not bite').toBeGreaterThan(
      vsSword.maxHp - vsSword.riderHp,
    )
  })

  it('chargeGuard is opt-in — an ordinary footman does not bite', () => {
    const def = compileGameDef(DEF)
    expect(def.stats.chargeGuard[def.entIndex.get('footman')!]).toBe(0)
  })
})
