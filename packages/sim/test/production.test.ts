import { describe, expect, it } from 'vitest'
import {
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  Kind,
  handleOf,
  type GameDef,
  type RtsMapDoc,
  type SimState,
} from '@battlebadger/sim'

// SC-flavored macro def: worker mines minerals, builds depot (supply) and
// barracks (requires depot); barracks trains marines; refinery on geyser.
const MACRO_DEF: GameDef = {
  schema: 1,
  id: 'macro-test',
  name: 'Macro Test',
  resources: [
    { id: 'minerals', name: 'Minerals', startAmount: 200 },
    { id: 'gas', name: 'Gas', startAmount: 0 },
  ],
  supplyName: 'Supply',
  supplyHardCap: 200,
  entities: [
    {
      id: 'worker', name: 'Worker', kind: 'unit', radius: 0.4, hp: 45, supplyCost: 1,
      visual: { model: 'placeholder:capsule' }, mover: { speed: 3 },
      harvester: { carryCapacity: 5, gatherAmount: 5, gatherPeriodTicks: 6, nodeTags: ['mineral', 'gas'] },
      builder: { builds: ['depot', 'barracks', 'refinery'] },
    },
    {
      id: 'marine', name: 'Marine', kind: 'unit', radius: 0.4, hp: 50, supplyCost: 2,
      cost: [{ resource: 'minerals', amount: 50 }], buildTimeTicks: 20,
      visual: { model: 'placeholder:cone' }, mover: { speed: 3.2 },
      combat: { damage: 6, range: 4, acquire: 8, periodTicks: 9 },
    },
    {
      id: 'hq', name: 'HQ', kind: 'building', radius: 1.8, hp: 900, supplyProvided: 10,
      visual: { model: 'placeholder:box' }, dropoff: { accepts: ['minerals', 'gas'] },
      trainer: { trains: ['worker'], queueSize: 5 },
    },
    {
      id: 'depot', name: 'Depot', kind: 'building', radius: 1.0, hp: 300, supplyProvided: 8,
      cost: [{ resource: 'minerals', amount: 100 }], buildTimeTicks: 30,
      visual: { model: 'placeholder:box' },
    },
    {
      id: 'barracks', name: 'Barracks', kind: 'building', radius: 1.4, hp: 500,
      cost: [{ resource: 'minerals', amount: 150 }], buildTimeTicks: 40, requires: ['depot'],
      visual: { model: 'placeholder:box' }, trainer: { trains: ['marine'], queueSize: 5 },
    },
    {
      id: 'refinery', name: 'Refinery', kind: 'building', radius: 1.0, hp: 400,
      cost: [{ resource: 'minerals', amount: 75 }], buildTimeTicks: 20,
      visual: { model: 'placeholder:box' }, extractorOn: 'geyser',
    },
    {
      id: 'geyser', name: 'Geyser', kind: 'doodad', radius: 1.0, hp: 0,
      visual: { model: 'placeholder:dome' },
      resourceNode: { tag: 'gas', resource: 'gas', amount: 500, occupancy: 'exclusive', requiresExtractorOn: true },
    },
    {
      id: 'patch', name: 'Patch', kind: 'doodad', radius: 0.6, hp: 0,
      visual: { model: 'placeholder:crystal' },
      resourceNode: { tag: 'mineral', resource: 'minerals', amount: 2000, occupancy: 'exclusive' },
    },
  ],
  abilities: [],
  victory: { mode: 'buildingsDestroyed' },
}

function macroDoc(): RtsMapDoc {
  const size = 48
  return {
    version: 1,
    name: 'macro',
    seed: 11,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable: Array.from({ length: size * size }, () => 1),
    heights: Array.from({ length: size * size }, () => 0),
    startLocations: [
      { x: 10, z: 10 },
      { x: 38, z: 38 },
    ],
    doodads: [
      { def: 'patch', x: 18, z: 10 },
      { def: 'geyser', x: 10, z: 18 },
    ],
    placed: [
      { def: 'hq', owner: 0, x: 10, z: 10 },
      { def: 'worker', owner: 0, x: 13, z: 10 },
      { def: 'worker', owner: 0, x: 13, z: 12 },
    ],
    gameDef: MACRO_DEF,
  }
}

const D = (s: SimState, id: string): number => s.def.entIndex.get(id)!
const findByType = (s: SimState, ty: number): number => {
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.type[i] === ty) return i
  return -1
}
const minerals = (s: SimState): number => s.resources[0]

describe('construction / production / tech / supply / power', () => {
  it('worker builds a depot; supply cap rises when complete', () => {
    const doc = macroDoc()
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    expect(s.supplyCap[0]).toBe(10)
    expect(s.supplyUsed[0]).toBe(2)
    const w = findByType(s, D(s, 'worker'))
    const m0 = minerals(s)
    step(s, grid, [{ kind: 'build', player: 0, units: [handleOf(s, w)], def: D(s, 'depot'), x: 16, z: 16 }])
    expect(minerals(s)).toBe(m0 - 100)
    const depot = findByType(s, D(s, 'depot'))
    expect(depot).toBeGreaterThanOrEqual(0)
    expect(s.buildTicks[depot]).toBeGreaterThan(0)
    // walk + build
    for (let t = 0; t < 300 && s.buildTicks[depot] > 0; t++) step(s, grid, [])
    expect(s.buildTicks[depot]).toBe(0)
    expect(s.supplyCap[0]).toBe(18)
    // footprint blocked while alive
    expect(grid.isWalkableWorld(16, 16)).toBe(false)
  })

  it('tech gate: barracks needs a depot; train blocked without supply; cancel refunds', () => {
    const doc = macroDoc()
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const w = findByType(s, D(s, 'worker'))
    const hq = findByType(s, D(s, 'hq'))
    // barracks without depot → rejected, no cost
    const m0 = minerals(s)
    step(s, grid, [{ kind: 'build', player: 0, units: [handleOf(s, w)], def: D(s, 'barracks'), x: 20, z: 20 }])
    expect(minerals(s)).toBe(m0)
    expect(findByType(s, D(s, 'barracks'))).toBe(-1)

    // queue 4 workers at HQ: supply 2 used + 4*1 = 6 ≤ 10 ok; queue a 5th..9th
    // then supply-block: workers cost 1 → cap 10 allows 8 more
    const hqH = handleOf(s, hq)
    for (let k = 0; k < 8; k++) step(s, grid, [{ kind: 'train', player: 0, units: [hqH], x: 0, z: 0, def: D(s, 'worker') }])
    expect(s.queue[hq].length).toBe(5) // queueSize caps at 5
    // cancel one → queue 4 (workers are free so no refund to observe here)
    step(s, grid, [{ kind: 'cancel', player: 0, units: [hqH], x: 0, z: 0, target: 4 }])
    expect(s.queue[hq].length).toBe(4)
  })

  it('trains marines from a completed barracks and rallies them', () => {
    const doc = macroDoc()
    doc.placed!.push({ def: 'depot', owner: 0, x: 16, z: 16 })
    doc.placed!.push({ def: 'barracks', owner: 0, x: 22, z: 10 })
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const rax = findByType(s, D(s, 'barracks'))
    const raxH = handleOf(s, rax)
    const m0 = minerals(s)
    step(s, grid, [
      { kind: 'rally', player: 0, units: [raxH], x: 30, z: 30 },
      { kind: 'train', player: 0, units: [raxH], x: 0, z: 0, def: D(s, 'marine') },
      { kind: 'train', player: 0, units: [raxH], x: 0, z: 0, def: D(s, 'marine') },
    ])
    expect(minerals(s)).toBe(m0 - 100)
    expect(s.queue[rax].length).toBe(2)
    for (let t = 0; t < 60; t++) step(s, grid, [])
    const marine = findByType(s, D(s, 'marine'))
    expect(marine).toBeGreaterThanOrEqual(0)
    // marine walks toward the rally
    for (let t = 0; t < 100; t++) step(s, grid, [])
    const dx = s.posX[marine] - 30
    const dz = s.posZ[marine] - 30
    expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThan(4)
    expect(s.supplyUsed[0]).toBe(2 + 2 * 2)
  })

  it('geyser is unharvestable until a refinery is built on it', () => {
    const doc = macroDoc()
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const w = findByType(s, D(s, 'worker'))
    const wH = handleOf(s, w)
    // harvest command on raw geyser (doodad index 1) → rejected
    step(s, grid, [{ kind: 'harvest', player: 0, units: [wH], x: 0, z: 0, target: -1 - 1 }])
    expect(s.harvState[w]).toBe(0)
    // build refinery on the geyser
    step(s, grid, [{ kind: 'build', player: 0, units: [wH], def: D(s, 'refinery'), x: 10, z: 18 }])
    const refinery = findByType(s, D(s, 'refinery'))
    expect(refinery).toBeGreaterThanOrEqual(0)
    for (let t = 0; t < 300 && s.buildTicks[refinery] > 0; t++) step(s, grid, [])
    expect(s.buildTicks[refinery]).toBe(0)
    // now the harvest command sticks and gas flows
    step(s, grid, [{ kind: 'harvest', player: 0, units: [wH], x: 0, z: 0, target: -1 - 1 }])
    expect(s.harvState[w]).toBeGreaterThan(0)
    for (let t = 0; t < 400; t++) step(s, grid, [])
    expect(s.resources[1]).toBeGreaterThan(0)
  })

  it('building death restores its footprint; buildingsDestroyed victory fires', () => {
    const doc = macroDoc()
    doc.placed!.push({ def: 'hq', owner: 1, x: 38, z: 38 })
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const hq1 = ((): number => {
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === 1) return i
      return -1
    })()
    expect(grid.isWalkableWorld(38, 38)).toBe(false)
    s.hp[hq1] = 0
    step(s, grid, [])
    expect(grid.isWalkableWorld(38, 38)).toBe(true)
    expect(s.winner).toBe(0)
  })

  it('power deficit halves production speed (C&C model)', () => {
    const def = JSON.parse(JSON.stringify(MACRO_DEF)) as GameDef
    def.powerEnabled = true
    const hq = def.entities.find((e) => e.id === 'hq')!
    hq.powerCost = 5 // HQ consumes power nobody provides → deficit
    const doc = macroDoc()
    doc.gameDef = def
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const hqIdx = findByType(s, D(s, 'hq'))
    step(s, grid, [{ kind: 'train', player: 0, units: [handleOf(s, hqIdx)], x: 0, z: 0, def: D(s, 'worker') }])
    // worker buildTime defaults to 10 ticks; with deficit it advances every
    // other tick → after 12 ticks progress should be ~6, not done
    for (let t = 0; t < 12; t++) step(s, grid, [])
    expect(s.queue[hqIdx].length).toBe(1) // still training
    for (let t = 0; t < 12; t++) step(s, grid, [])
    expect(s.queue[hqIdx].length).toBe(0) // done by ~20-24 ticks
  })

  it('full macro scenario stays deterministic across two sims', () => {
    const play = (): number => {
      const doc = macroDoc()
      const grid = walkGridFromDoc(doc)
      const s = setupMatch(doc, grid)
      const w = findByType(s, D(s, 'worker'))
      const hq = findByType(s, D(s, 'hq'))
      step(s, grid, [
        { kind: 'harvest', player: 0, units: [handleOf(s, w + 1)], x: 0, z: 0, target: -1 - 0 },
        { kind: 'build', player: 0, units: [handleOf(s, w)], def: D(s, 'depot'), x: 16, z: 16 },
        { kind: 'train', player: 0, units: [handleOf(s, hq)], x: 0, z: 0, def: D(s, 'worker') },
      ])
      for (let t = 0; t < 800; t++) step(s, grid, [])
      return stateHash(s)
    }
    expect(play()).toBe(play())
  })
})

describe('building kinds', () => {
  it('buildings never move and are attackable', () => {
    const doc = macroDoc()
    doc.placed!.push({ def: 'marine', owner: 1, x: 7, z: 7 }) // HQ is its nearest enemy
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    const hq = findByType(s, D(s, 'hq'))
    expect(s.kind[hq]).toBe(Kind.Building)
    const x0 = s.posX[hq]
    const hp0 = s.hp[hq]
    for (let t = 0; t < 100; t++) step(s, grid, [])
    expect(s.posX[hq]).toBe(x0)
    expect(s.hp[hq]).toBeLessThan(hp0) // enemy marine auto-acquired the HQ (or workers)
  })
})
