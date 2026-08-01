import { describe, expect, it } from 'vitest'
import { generateDunhollow } from '../src/mapgen/dunhollow.ts'
import { KEEP_SLOTS, KEEP_TOWER_SLOTS } from '../src/mapgen/factions/shared.ts'
import {
  addMember,
  addXp,
  applyDamageTable,
  createHorde,
  deriveTerrain,
  formationSlot,
  planPath,
  formationWorld,
  handleOf,
  incomingPct,
  outgoingPct,
  setupMatch,
  spawnBuilding,
  spawnUnit,
  stateHash,
  step,
  unitSpeed,
  walkGridFromDoc,
  type GameDef,
  type IncomeDef,
  type PlacedEntity,
  type PlayerCommand,
  type RtsMapDoc,
  type SimState,
} from '@battlebadger/sim'

// The BFME rules layer: passive building income, the damage/armor matrix,
// build plots, hordes/formations and veterancy — all expressed as GameDef data.

function makeDoc(gameDef: GameDef, placed: PlacedEntity[], size = 60): RtsMapDoc {
  return {
    version: 1,
    name: 'bfme-test',
    seed: 11,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable: Array.from({ length: size * size }, () => 1),
    heights: Array.from({ length: size * size }, () => 0),
    startLocations: [
      { x: 8, z: 8 },
      { x: size - 8, z: size - 8 },
    ],
    placed,
    gameDef,
  }
}

function base(id: string, extra: Partial<GameDef>): GameDef {
  return {
    schema: 1,
    id,
    name: id,
    resources: [{ id: 'res', name: 'Resources', startAmount: 0 }],
    entities: [],
    abilities: [],
    victory: { mode: 'triggersOnly' },
    ...extra,
  }
}

const run = (doc: RtsMapDoc, ticks: number): SimState => {
  const grid = walkGridFromDoc(doc)
  const sim = setupMatch(doc, grid)
  for (let t = 0; t < ticks; t++) step(sim, grid, [])
  return sim
}

const resOf = (s: SimState, player: number): number => s.resources[player * s.def.resources.length]

describe('passive building income', () => {
  const farmDef = (extra: Partial<IncomeDef> = {}): GameDef =>
    base('farms', {
      entities: [
        {
          id: 'farm',
          name: 'Farm',
          kind: 'building',
          radius: 2,
          hp: 500,
          visual: { model: 'placeholder:box' },
          income: { resource: 'res', amount: 10, perTicks: 10, ...extra },
        },
      ],
    })

  it('pays out on cadence with no harvester anywhere', () => {
    const doc = makeDoc(farmDef(), [{ def: 'farm', owner: 0, x: 10, z: 10 }])
    // ticks 10..100 → 10 payouts of 10
    expect(resOf(run(doc, 101), 0)).toBe(100)
  })

  it('pays nothing while under construction', () => {
    const def = farmDef()
    def.entities[0].buildTimeTicks = 1000
    const doc = makeDoc(def, [])
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    spawnBuilding(sim, grid, sim.def.entIndex.get('farm')!, 0, 10, 10, true)
    for (let t = 0; t < 101; t++) step(sim, grid, [])
    expect(resOf(sim, 0)).toBe(0)
  })

  it('crowding cuts payout per neighbour, floored', () => {
    // 3 farms inside 8 units of each other: each sees 2 neighbours →
    // 100 - 25*2 = 50% → 5 each per payout → 15/payout for the player.
    const def = farmDef({ crowdRadius: 8, crowdPenaltyPct: 25, crowdFloorPct: 40 })
    const doc = makeDoc(def, [
      { def: 'farm', owner: 0, x: 10, z: 10 },
      { def: 'farm', owner: 0, x: 15, z: 10 },
      { def: 'farm', owner: 0, x: 10, z: 15 },
    ])
    expect(resOf(run(doc, 11), 0)).toBe(15)
  })

  it('spread-out farms keep full payout, and enemy farms never crowd yours', () => {
    const def = farmDef({ crowdRadius: 8, crowdPenaltyPct: 25, crowdFloorPct: 40 })
    const doc = makeDoc(def, [
      { def: 'farm', owner: 0, x: 10, z: 10 },
      { def: 'farm', owner: 0, x: 40, z: 40 },
      { def: 'farm', owner: 1, x: 12, z: 10 },
    ])
    const s = run(doc, 11)
    expect(resOf(s, 0)).toBe(20)
    expect(resOf(s, 1)).toBe(10)
  })

  it('honours the crowding floor', () => {
    // 5 farms in a tight cluster → 100 - 25*4 = 0 → floored to 40%
    const def = farmDef({ crowdRadius: 8, crowdPenaltyPct: 25, crowdFloorPct: 40 })
    const doc = makeDoc(def, [
      { def: 'farm', owner: 0, x: 10, z: 10 },
      { def: 'farm', owner: 0, x: 12, z: 10 },
      { def: 'farm', owner: 0, x: 14, z: 10 },
      { def: 'farm', owner: 0, x: 10, z: 12 },
      { def: 'farm', owner: 0, x: 12, z: 12 },
    ])
    expect(resOf(run(doc, 11), 0)).toBe(20) // 5 farms × floor(10 * 40/100)
  })
})

describe('build plots and fortress expansion', () => {
  // BFME base building: structures only go on plots, the fortress brings its
  // own ring of expansion slots, and razing the fortress razes the ring.
  const plotsDef = (): GameDef =>
    base('plots', {
      entities: [
        {
          id: 'plot',
          name: 'Build Plot',
          kind: 'building',
          radius: 2.5,
          hp: 100,
          visual: { model: 'placeholder:box' },
          plot: { accepts: ['farm', 'barracks'] },
        },
        {
          id: 'settler',
          name: 'Settler',
          kind: 'unit',
          radius: 0.4,
          hp: 100,
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 3 },
        },
        {
          id: 'outpost_plot',
          name: 'Settlement',
          kind: 'building',
          radius: 2.5,
          hp: 100,
          visual: { model: 'placeholder:box' },
          plot: { accepts: ['farm'], neutral: true },
        },
        {
          id: 'farm',
          name: 'Farm',
          kind: 'building',
          radius: 2,
          hp: 400,
          placement: 'plot',
          buildTimeTicks: 5,
          cost: [{ resource: 'res', amount: 100 }],
          visual: { model: 'placeholder:box' },
          income: { resource: 'res', amount: 5, perTicks: 10 },
        },
        {
          id: 'barracks',
          name: 'Barracks',
          kind: 'building',
          radius: 2,
          hp: 400,
          placement: 'plot',
          buildTimeTicks: 5,
          visual: { model: 'placeholder:box' },
        },
        {
          id: 'fortress',
          name: 'Fortress',
          kind: 'building',
          radius: 4,
          hp: 5000,
          visual: { model: 'placeholder:box' },
          expansion: {
            plot: 'plot',
            offsets: [
              { dx: 8, dz: 0 },
              { dx: -8, dz: 0 },
              { dx: 0, dz: 8 },
            ],
          },
        },
      ],
    })

  const setup = (
    def: GameDef,
    placed: PlacedEntity[],
  ): { sim: SimState; grid: ReturnType<typeof walkGridFromDoc>; doc: RtsMapDoc } => {
    const doc = makeDoc(def, placed)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    sim.resources[0] = 1000
    return { sim, grid, doc }
  }

  const buildCmd = (sim: SimState, defId: string, x: number, z: number, player = 0) => ({
    kind: 'build' as const,
    player,
    units: [handleOf(sim, 0)],
    x,
    z,
    def: sim.def.entIndex.get(defId)!,
  })

  const countOf = (s: SimState, id: string): number => {
    const ty = s.def.entIndex.get(id)!
    let n = 0
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.type[i] === ty) n++
    return n
  }

  it('a fortress spawns its ring of expansion plots', () => {
    const { sim } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    expect(countOf(sim, 'plot')).toBe(3)
  })

  it('refuses structures off a plot and accepts them on one', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    step(sim, grid, [buildCmd(sim, 'farm', 20, 20)]) // open ground
    expect(countOf(sim, 'farm')).toBe(0)
    expect(sim.resources[0]).toBe(1000)

    step(sim, grid, [buildCmd(sim, 'farm', 38, 30)]) // the +x expansion plot
    expect(countOf(sim, 'farm')).toBe(1)
    expect(sim.resources[0]).toBe(900)
  })

  it('a plot holds one structure at a time', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    step(sim, grid, [buildCmd(sim, 'farm', 38, 30)])
    step(sim, grid, [buildCmd(sim, 'barracks', 38, 30)])
    expect(countOf(sim, 'barracks')).toBe(0)
  })

  it('plot structures raise themselves with no builder present', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    step(sim, grid, [buildCmd(sim, 'farm', 38, 30)])
    const farm = sim.count - 1
    expect(sim.buildTicks[farm]).toBeGreaterThan(0)
    for (let t = 0; t < 10; t++) step(sim, grid, [])
    expect(sim.buildTicks[farm]).toBe(0)
  })

  it('freeing a plot by destroying its structure lets you rebuild', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    step(sim, grid, [buildCmd(sim, 'farm', 38, 30)])
    const farm = sim.count - 1
    sim.hp[farm] = 0
    step(sim, grid, [])
    expect(countOf(sim, 'farm')).toBe(0)
    step(sim, grid, [buildCmd(sim, 'barracks', 38, 30)])
    expect(countOf(sim, 'barracks')).toBe(1)
  })

  it('razing the fortress takes its plots and everything on them', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    step(sim, grid, [buildCmd(sim, 'farm', 38, 30)])
    step(sim, grid, [buildCmd(sim, 'barracks', 22, 30)])
    expect(countOf(sim, 'farm') + countOf(sim, 'barracks')).toBe(2)
    sim.hp[0] = 0 // the fortress
    step(sim, grid, [])
    expect(countOf(sim, 'plot')).toBe(0)
    expect(countOf(sim, 'farm')).toBe(0)
    expect(countOf(sim, 'barracks')).toBe(0)
  })

  it('owned plots serve only their owner; neutral plots serve anyone held', () => {
    const { sim, grid } = setup(plotsDef(), [
      { def: 'fortress', owner: 0, x: 30, z: 30 },
      { def: 'outpost_plot', owner: 0, x: 45, z: 45 },
      // player 1 has a settler standing on the settlement: a plot is only
      // claimable by someone actually holding the ground around it
      { def: 'settler', owner: 1, x: 46, z: 46 },
    ])
    sim.resources[sim.def.resources.length] = 1000 // player 1's purse
    // player 1 may not use player 0's fortress plot...
    step(sim, grid, [{ ...buildCmd(sim, 'farm', 38, 30, 1), units: [] }])
    expect(countOf(sim, 'farm')).toBe(0)
    // ...but the neutral settlement is fair game where they stand
    step(sim, grid, [{ ...buildCmd(sim, 'farm', 45, 45, 1), units: [handleOf(sim, 1)] }])
    expect(countOf(sim, 'farm')).toBe(1)
  })

  it('a neutral settlement nobody is standing near cannot be claimed', () => {
    const { sim, grid } = setup(plotsDef(), [
      { def: 'fortress', owner: 0, x: 30, z: 30 },
      { def: 'outpost_plot', owner: 0, x: 90, z: 90 }, // far from everything
    ])
    step(sim, grid, [buildCmd(sim, 'farm', 90, 90)])
    expect(countOf(sim, 'farm'), 'claimed a settlement with no presence').toBe(0)
  })

  it('plots never block pathing and are never shot at', () => {
    const { sim, grid } = setup(plotsDef(), [{ def: 'fortress', owner: 0, x: 30, z: 30 }])
    expect(grid.isWalkableWorld(38, 30)).toBe(true)
    for (let i = 0; i < sim.count; i++) {
      if (sim.def.stats.isPlot[sim.type[i]]) expect(sim.def.stats.untargetable[sim.type[i]]).toBe(1)
    }
  })
})

describe('hordes, formations and veterancy', () => {
  // Everything the player touches is horde-level: one purchase, one command
  // point, one selection, one XP track.
  const hordeDef = (): GameDef =>
    base('hordes', {
      supplyName: 'Command Points',
      hordeLevels: [
        { xp: 0, damagePct: 100, damageTakenPct: 100 },
        { xp: 20, damagePct: 150, damageTakenPct: 90 },
        { xp: 60, damagePct: 200, damageTakenPct: 75 },
      ],
      entities: [
        {
          id: 'soldier',
          name: 'Soldier',
          kind: 'unit',
          radius: 0.4,
          hp: 100,
          xpValue: 10,
          supplyCost: 0,
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 4 },
          combat: { damage: 10, range: 1.5, acquire: 14, periodTicks: 10 },
        },
        {
          id: 'swordsmen',
          name: 'Swordsmen',
          kind: 'unit',
          radius: 0.4,
          hp: 0,
          supplyCost: 5,
          buildTimeTicks: 2,
          cost: [{ resource: 'res', amount: 50 }],
          visual: { model: 'placeholder:capsule' },
          horde: {
            unit: 'soldier',
            count: 9,
            spacing: 1.2,
            formations: [
              { id: 'block', name: 'Block', kind: 'block' },
              { id: 'line', name: 'Line', kind: 'line', damagePct: 110, speedPct: 120 },
              { id: 'porcupine', name: 'Porcupine', kind: 'ring', damageTakenPct: 50, speedPct: 50 },
            ],
          },
        },
        {
          id: 'barracks',
          name: 'Barracks',
          kind: 'building',
          radius: 3,
          hp: 1000,
          supplyProvided: 20,
          visual: { model: 'placeholder:box' },
          trainer: { trains: ['swordsmen'], queueSize: 5 },
        },
      ],
    })

  const trained = (): { sim: SimState; grid: ReturnType<typeof walkGridFromDoc> } => {
    const doc = makeDoc(hordeDef(), [{ def: 'barracks', owner: 0, x: 20, z: 30 }])
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    sim.resources[0] = 500
    step(sim, grid, [
      { kind: 'train', player: 0, units: [handleOf(sim, 0)], x: 0, z: 0, def: sim.def.entIndex.get('swordsmen')! },
    ])
    for (let t = 0; t < 4; t++) step(sim, grid, [])
    return { sim, grid }
  }

  const memberIds = (s: SimState): number[] => s.hordes.members[0].slice()

  it('training a horde ticket spawns a whole battalion bound into one horde', () => {
    const { sim } = trained()
    expect(sim.hordes.count).toBe(1)
    expect(sim.hordes.members[0].length).toBe(9)
    for (const m of memberIds(sim)) expect(sim.hordeOf[m]).toBe(0)
    // the ticket itself never becomes an entity
    const ticket = sim.def.entIndex.get('swordsmen')!
    for (let i = 0; i < sim.count; i++) if (sim.alive[i]) expect(sim.type[i]).not.toBe(ticket)
  })

  it('costs one command-point charge per horde, not per soldier', () => {
    const { sim } = trained()
    expect(sim.supplyUsed[0]).toBe(5)
    expect(sim.supplyCap[0]).toBe(20)
  })

  it('ordering one soldier moves the whole horde in formation', () => {
    const { sim, grid } = trained()
    const one = memberIds(sim)[3]
    step(sim, grid, [{ kind: 'move', player: 0, units: [handleOf(sim, one)], x: 40, z: 30 }])
    const dests = memberIds(sim).map((m) => [sim.destX[m], sim.destZ[m]])
    // every member got its own slot around the target, and they differ
    expect(new Set(dests.map((d) => d.join(','))).size).toBe(9)
    for (const [dx, dz] of dests) {
      expect(Math.abs(dx - 40)).toBeLessThan(4)
      expect(Math.abs(dz - 30)).toBeLessThan(4)
    }
  })

  it('marches there and arrives as a formation', () => {
    const { sim, grid } = trained()
    step(sim, grid, [{ kind: 'move', player: 0, units: [handleOf(sim, memberIds(sim)[0])], x: 45, z: 30 }])
    for (let t = 0; t < 200; t++) step(sim, grid, [])
    for (const m of memberIds(sim)) {
      const dx = sim.posX[m] - 45
      const dz = sim.posZ[m] - 30
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(5)
    }
  })

  it('switching stance re-forms the horde and changes its speed', () => {
    const { sim, grid } = trained()
    const h = handleOf(sim, memberIds(sim)[0])
    step(sim, grid, [{ kind: 'formation', player: 0, units: [h], x: 0, z: 0, def: 2 }]) // porcupine
    expect(sim.hordes.formation[0]).toBe(2)
    // porcupine halves speed and halves incoming damage
    expect(unitSpeed(sim, memberIds(sim)[0])).toBe(2)
    expect(incomingPct(sim, memberIds(sim)[0])).toBe(50)
    step(sim, grid, [{ kind: 'formation', player: 0, units: [h], x: 0, z: 0, def: 1 }]) // line
    expect(outgoingPct(sim, memberIds(sim)[0])).toBe(110)
    expect(unitSpeed(sim, memberIds(sim)[0])).toBeCloseTo(4.8, 6)
  })

  it('rejects an out-of-range formation index', () => {
    const { sim, grid } = trained()
    const h = handleOf(sim, memberIds(sim)[0])
    step(sim, grid, [{ kind: 'formation', player: 0, units: [h], x: 0, z: 0, def: 7 }])
    expect(sim.hordes.formation[0]).toBe(0)
  })

  it('kills feed the horde XP track and promote it', () => {
    const { sim, grid } = trained()
    const horde = 0
    expect(sim.hordes.level[horde]).toBe(1)
    addXp(sim, horde, 20)
    expect(sim.hordes.level[horde]).toBe(2)
    expect(outgoingPct(sim, memberIds(sim)[0])).toBe(150)
    expect(incomingPct(sim, memberIds(sim)[0])).toBe(90)
    addXp(sim, horde, 40)
    expect(sim.hordes.level[horde]).toBe(3)
    expect(sim.hordes.xp[horde]).toBe(60)
    void grid
  })

  it('awards XP to the killer horde when a soldier falls', () => {
    const doc = makeDoc(hordeDef(), [{ def: 'barracks', owner: 0, x: 20, z: 30 }])
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    sim.resources[0] = 500
    step(sim, grid, [
      { kind: 'train', player: 0, units: [handleOf(sim, 0)], x: 0, z: 0, def: sim.def.entIndex.get('swordsmen')! },
    ])
    for (let t = 0; t < 4; t++) step(sim, grid, [])
    // one enemy soldier walks into the battalion and dies
    const victim = spawnUnit(sim, sim.def.entIndex.get('soldier')!, 1, 21, 31)
    sim.hp[victim] = 5
    for (let t = 0; t < 30 && sim.alive[victim]; t++) step(sim, grid, [])
    expect(sim.alive[victim]).toBe(0)
    expect(sim.hordes.xp[0]).toBe(10) // one kill, xpValue 10
  })

  it('a horde dissolves when its last soldier dies', () => {
    const { sim, grid } = trained()
    for (const m of memberIds(sim)) sim.hp[m] = 0
    step(sim, grid, [])
    expect(sim.hordes.alive[0]).toBe(0)
    expect(sim.hordes.members[0].length).toBe(0)
  })

  it('survivors keep stable formation slots after casualties', () => {
    const { sim, grid } = trained()
    const before = memberIds(sim)
    sim.hp[before[2]] = 0
    step(sim, grid, [])
    expect(memberIds(sim)).toEqual(before.filter((m) => m !== before[2]))
  })
})

describe('Siege of Dunhollow (the whole BFME loop as data)', () => {
  const play = (ticks: number, cmds: Map<number, PlayerCommand[]> = new Map()) => {
    const doc = generateDunhollow(20260727)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    for (let t = 0; t < ticks; t++) step(sim, grid, cmds.get(t) ?? [])
    return { sim, grid, doc }
  }

  const findType = (s: SimState, id: string, owner: number): number => {
    const ty = s.def.entIndex.get(id)!
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.type[i] === ty && s.owner[i] === owner) return i
    return -1
  }

  it('compiles and sets up both fortresses with their plot rings', () => {
    const { sim } = play(1)
    // Two rings now: build plots close in, tower pads out on the approaches.
    const count = (def: string): [number, number] => {
      const type = sim.def.entIndex.get(def)!
      let a = 0
      let b = 0
      for (let i = 0; i < sim.count; i++) {
        if (!sim.alive[i] || sim.type[i] !== type) continue
        if (sim.owner[i] === 0) a++
        else b++
      }
      return [a, b]
    }
    expect(count('fortress-plot')).toEqual([12, 12])
    // Eight pads are authored; this map's terrain refuses one of them, and the
    // expansion guard drops it rather than burying it in a cliff. Both players
    // lose the same one, which is what actually matters.
    const [padsA, padsB] = count('tower-plot')
    expect(padsA).toBe(padsB)
    expect(padsA).toBeGreaterThanOrEqual(7)
    expect(sim.supplyCap[0]).toBe(90)
  })

  it('the build plots make a circle, not a cluster', () => {
    // They used to sit on three arcs at three radii, which read as a huddle:
    // the diagonals crowded the keep while the cardinals sat out alone.
    const r = KEEP_SLOTS.map((o) => Math.sqrt(o.dx * o.dx + o.dz * o.dz))
    const min = Math.min(...r)
    const max = Math.max(...r)
    expect(max - min, 'every slot should sit on one radius').toBeLessThan(1.5)
    expect(KEEP_SLOTS.length).toBe(12)

    // ...and evenly spaced around it, so there are lanes between the halls
    // rather than two buildings shoulder to shoulder and a gap opposite.
    const angles = KEEP_SLOTS.map((o) => Math.atan2(o.dz, o.dx)).sort((a, b) => a - b)
    for (let i = 0; i < angles.length; i++) {
      const gap = i === 0 ? angles[0] + Math.PI * 2 - angles[angles.length - 1] : angles[i] - angles[i - 1]
      expect(gap, `gap ${i} is uneven`).toBeGreaterThan(0.4)
    }
  })

  it('the towers are four to the compass, and four drawn in behind them', () => {
    const r = KEEP_TOWER_SLOTS.map((o) => Math.sqrt(o.dx * o.dx + o.dz * o.dz))
    expect(KEEP_TOWER_SLOTS.length).toBe(8)
    // an outer picket of four, one to each quarter...
    const outer = KEEP_TOWER_SLOTS.filter((_, i) => r[i] > 26)
    expect(outer.length).toBe(4)
    for (const o of outer) expect(o.dx === 0 || o.dz === 0, 'the outer four sit on the compass points').toBe(true)
    // ...and four more closer in, filling the gaps between them
    const inner = KEEP_TOWER_SLOTS.filter((_, i) => r[i] <= 26)
    expect(inner.length).toBe(4)
    for (const o of inner) expect(o.dx !== 0 && o.dz !== 0, 'the inner four fill the diagonals').toBe(true)
    expect(Math.max(...r.filter((_, i) => r[i] <= 26))).toBeLessThan(Math.min(...r.filter((_, i) => r[i] > 26)))
  })

  it('the tower pads take a tower and nothing else', () => {
    // The outer ring is defence, not more economy: the reason to push your
    // perimeter out should be to see and shoot, not to earn.
    const { sim } = play(1)
    const pad = sim.def.entities[sim.def.entIndex.get('tower-plot')!]
    expect(pad.plot!.accepts).toEqual(['watchtower'])
    const inner = sim.def.entities[sim.def.entIndex.get('fortress-plot')!]
    expect(inner.plot!.accepts).toContain('barracks')
  })

  it('build plots stand clear of the keep rather than against it', () => {
    // Plots pressed against the citadel made a base one solid blob — no lanes
    // between buildings and a single catapult shot landing on four things.
    const { sim } = play(1)
    const keepType = sim.def.entIndex.get('fortress')!
    const plotType = sim.def.entIndex.get('fortress-plot')!
    let keep = -1
    for (let i = 0; i < sim.count; i++) if (sim.alive[i] && sim.type[i] === keepType && sim.owner[i] === 0) keep = i
    expect(keep).toBeGreaterThanOrEqual(0)
    const keepR = sim.def.stats.radius[keepType]
    const plotR = sim.def.stats.radius[plotType]
    for (let i = 0; i < sim.count; i++) {
      if (!sim.alive[i] || sim.type[i] !== plotType || sim.plotParent[i] !== keep) continue
      const dx = sim.posX[i] - sim.posX[keep]
      const dz = sim.posZ[i] - sim.posZ[keep]
      const gap = Math.sqrt(dx * dx + dz * dz) - keepR - plotR
      expect(gap, `plot at ${dx},${dz} is touching the keep`).toBeGreaterThan(3)
    }
  })

  it('a farm on a plot funds the war with no worker on the map', () => {
    const doc = generateDunhollow(20260727)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    const farm = sim.def.entIndex.get('farm')!
    const plot = findType(sim, 'fortress-plot', 0)
    const before = sim.resources[0]
    step(sim, grid, [{ kind: 'build', player: 0, units: [], x: sim.posX[plot], z: sim.posZ[plot], def: farm }])
    expect(sim.resources[0]).toBe(before - 300)
    for (let t = 0; t < 300; t++) step(sim, grid, [])
    // 100 ticks of construction, then ~10 payouts of 8
    expect(sim.resources[0]).toBeGreaterThan(before - 300)
    expect(findType(sim, 'farm', 0)).toBeGreaterThan(0)
  })

  it('a barracks trains a battalion that answers as one unit', () => {
    const doc = generateDunhollow(20260727)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    sim.resources[0] = 5000
    const plot = findType(sim, 'fortress-plot', 0)
    step(sim, grid, [
      { kind: 'build', player: 0, units: [], x: sim.posX[plot], z: sim.posZ[plot], def: sim.def.entIndex.get('barracks')! },
    ])
    for (let t = 0; t < 160; t++) step(sim, grid, [])
    const barracks = findType(sim, 'barracks', 0)
    expect(barracks).toBeGreaterThan(0)
    // measure the DELTA: the map now opens with a standing army, so the
    // absolute figure is not the point — the charge being per horde is
    const hordesBefore = sim.hordes.members.filter((m) => m.length > 0).length
    const supplyBefore = sim.supplyUsed[0]
    step(sim, grid, [
      {
        kind: 'train',
        player: 0,
        units: [handleOf(sim, barracks)],
        x: 0,
        z: 0,
        def: sim.def.entIndex.get('h-swordsmen')!,
      },
    ])
    for (let t = 0; t < 100; t++) step(sim, grid, [])
    const withMembers = sim.hordes.members.filter((m) => m.length > 0)
    expect(withMembers.length, 'no new battalion').toBe(hordesBefore + 1)
    const horde = sim.hordes.members.findIndex((m) => m.length === 9 && m.every((id) => sim.alive[id]))
    expect(horde).toBeGreaterThanOrEqual(0)
    expect(sim.hordes.members[horde].length).toBe(9)
    // one command-point charge for nine men, not nine charges
    expect(sim.supplyUsed[0] - supplyBefore).toBe(8)
  })

  it('spearmen gut cavalry and cavalry runs down archers', () => {
    const doc = generateDunhollow(20260727)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    const spear = sim.def.stats.damage[sim.def.entIndex.get('spearman')!]
    const rider = sim.def.entIndex.get('rider')!
    const archer = sim.def.entIndex.get('archer')!
    const spearman = sim.def.entIndex.get('spearman')!
    // spear → cavalry at 300%, spear → infantry at 70%
    expect(applyDamageTable(sim, spearman, rider, spear)).toBe(Math.floor(spear * 3))
    expect(applyDamageTable(sim, spearman, spearman, spear)).toBe(Math.floor((spear * 70) / 100))
    // trample → archer at 300%
    const trample = sim.def.stats.damage[rider]
    expect(applyDamageTable(sim, rider, archer, trample)).toBe(trample * 3)
    // and a catapult is worthless against anything that moves
    const cat = sim.def.entIndex.get('catapult')!
    const siege = sim.def.stats.damage[cat]
    expect(applyDamageTable(sim, cat, sim.def.entIndex.get('fortress')!, siege)).toBe(siege * 4)
    expect(applyDamageTable(sim, cat, rider, siege)).toBe(Math.floor((siege * 25) / 100))
  })

  // Map sanity. The first version of this map put the ridge on the wrong
  // diagonal — the one that runs *through* both corners — so both fortresses
  // sat on a narrow plateau ringed by cliff bands and battalions snagged on
  // the walls instead of marching. These assertions are what caught it.
  describe('map sanity', () => {
    const doc = generateDunhollow(20260727)
    const terrain = deriveTerrain(doc)
    const walkableAt = (x: number, z: number): number =>
      terrain.walkable[Math.floor(z) * doc.cols + Math.floor(x)]

    it('keeps both bases and their whole plot rings on open ground', () => {
      const { sim } = play(1)
      for (let i = 0; i < sim.count; i++) {
        if (!sim.alive[i]) continue
        const id = sim.def.entities[sim.type[i]].id
        if (id !== 'fortress' && id !== 'fortress-plot' && id !== 'settlement') continue
        // the pad itself and a ring around it must be standable
        for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
          expect(walkableAt(sim.posX[i] + dx, sim.posZ[i] + dz), `${id} at ${sim.posX[i]},${sim.posZ[i]}`).toBe(1)
        }
      }
    })

    it('neither base sits on the ridge', () => {
      for (const b of doc.startLocations) {
        expect(Math.abs(b.x - b.z)).toBeGreaterThan(20)
      }
    })

    it('routes armies between the bases through a pass, not around a wall', () => {
      const grid = walkGridFromDoc(doc)
      const a = doc.startLocations[0]
      const b = doc.startLocations[1]
      const path = planPath(grid, a.x, a.z, b.x, b.z)
      expect(path).not.toBeNull()
      // the ridge must actually divide the map: a straight run is impossible
      expect(grid.lineWalkable(a.x, a.z, b.x, b.z)).toBe(false)
      expect(path!.pts.length / 2).toBeGreaterThan(1)
    })

    it('marches a battalion the length of the map without getting stuck', () => {
      const grid = walkGridFromDoc(doc)
      // One player only: this is a TERRAIN test (can a battalion cross the
      // ridge?), and playerCount 1 drops slot 1's content so the enemy's
      // standing army is not sitting on the finish line fighting back.
      const sim = setupMatch(doc, grid, 1)
      const ticket = sim.def.entIndex.get('h-swordsmen')!
      const horde = createHorde(sim, ticket, 0)
      const a = doc.startLocations[0]
      for (let k = 0; k < 9; k++) {
        const at = { x: a.x + (k % 3) * 1.2, z: a.z - 8 + Math.floor(k / 3) * 1.2 }
        addMember(sim, horde, spawnUnit(sim, sim.def.hordeUnit[ticket], 0, at.x, at.z))
      }
      const ids = sim.hordes.members[horde].slice()
      const b = doc.startLocations[1]
      step(sim, grid, [{ kind: 'move', player: 0, units: [handleOf(sim, ids[0])], x: b.x, z: b.z - 12 }])
      for (let t = 0; t < 1500; t++) step(sim, grid, [])
      for (const id of ids) {
        const dx = sim.posX[id] - b.x
        const dz = sim.posZ[id] - (b.z - 12)
        expect(Math.sqrt(dx * dx + dz * dz), `soldier ${id} stalled`).toBeLessThan(8)
      }
    })
  })

  it('stays bit-identical across two independent simulations', () => {
    const cmds = new Map<number, PlayerCommand[]>()
    const doc = generateDunhollow(20260727)
    const grid0 = walkGridFromDoc(doc)
    const probe = setupMatch(doc, grid0)
    const plot0 = findType(probe, 'fortress-plot', 0)
    const plot1 = findType(probe, 'fortress-plot', 1)
    cmds.set(5, [
      { kind: 'build', player: 0, units: [], x: probe.posX[plot0], z: probe.posZ[plot0], def: probe.def.entIndex.get('barracks')! },
      { kind: 'build', player: 1, units: [], x: probe.posX[plot1], z: probe.posZ[plot1], def: probe.def.entIndex.get('farm')! },
    ])

    const runOne = (): number => {
      const g = walkGridFromDoc(doc)
      const s = setupMatch(doc, g)
      for (let t = 0; t < 600; t++) step(s, g, cmds.get(t) ?? [])
      return stateHash(s)
    }
    expect(runOne()).toBe(runOne())
  })
})

describe('formation geometry', () => {
  it('places every slot exactly once with no duplicates', () => {
    for (const kind of [0, 1, 2, 3]) {
      const seen = new Set<string>()
      for (let slot = 0; slot < 12; slot++) {
        const [x, z] = formationSlot(kind, slot, 12, 1)
        seen.add(`${x},${z}`)
      }
      expect(seen.size).toBe(12)
    }
  })

  it('rotates offsets into world space without trig', () => {
    // facing +x: local forward (+z) must come out as world +x
    const [wx, wz] = formationWorld(0, 0, 1, 0, 0, 2)
    expect(wx).toBeCloseTo(2, 9)
    expect(wz).toBeCloseTo(0, 9)
    // facing +z: local right (+x) must come out as world +x
    const [rx, rz] = formationWorld(0, 0, 0, 1, 2, 0)
    expect(rx).toBeCloseTo(2, 9)
    expect(rz).toBeCloseTo(0, 9)
  })

  it('a single-soldier horde (a hero) sits at the centre', () => {
    expect(formationSlot(0, 0, 1, 1.2)).toEqual([0, 0])
  })
})

describe('damage type vs armor type', () => {
  // A pike wall shreds cavalry and tickles infantry; the matrix is the only
  // thing that differs between the two fights.
  const matrixDef = (): GameDef =>
    base('matrix', {
      damageTypes: ['spear', 'sword'],
      armorTypes: ['flesh', 'cavalry'],
      damageTable: [
        { damage: 'spear', armor: 'cavalry', pct: 300 },
        { damage: 'spear', armor: 'flesh', pct: 50 },
      ],
      entities: [
        {
          id: 'pike',
          name: 'Pikeman',
          kind: 'unit',
          radius: 0.4,
          hp: 1000,
          armorType: 'flesh',
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 0 },
          combat: { damage: 10, range: 2, acquire: 12, periodTicks: 10, damageType: 'spear' },
        },
        {
          id: 'rider',
          name: 'Rider',
          kind: 'unit',
          radius: 0.4,
          hp: 1000,
          armorType: 'cavalry',
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 0 },
        },
        {
          id: 'peasant',
          name: 'Peasant',
          kind: 'unit',
          radius: 0.4,
          hp: 1000,
          armorType: 'flesh',
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 0 },
        },
      ],
    })

  const damageDealtTo = (targetId: string): number => {
    const doc = makeDoc(matrixDef(), [
      { def: 'pike', owner: 0, x: 20, z: 20 },
      { def: targetId, owner: 1, x: 21, z: 20 },
    ])
    const s = run(doc, 31) // 4 swings at periodTicks 10
    return 1000 - s.hp[1]
  }

  it('multiplies damage against the matching armor type', () => {
    expect(damageDealtTo('rider')).toBe(4 * 30)
  })

  it('reduces damage against a resistant armor type', () => {
    expect(damageDealtTo('peasant')).toBe(4 * 5)
  })

  it('leaves untyped fights alone', () => {
    const def = matrixDef()
    delete def.entities[0].combat!.damageType
    const doc = makeDoc(def, [
      { def: 'pike', owner: 0, x: 20, z: 20 },
      { def: 'rider', owner: 1, x: 21, z: 20 },
    ])
    expect(1000 - run(doc, 31).hp[1]).toBe(4 * 10)
  })
})
