import { describe, expect, it } from 'vitest'
import {
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  type GameDef,
  type PlacedDoodad,
  type PlacedEntity,
  type RtsMapDoc,
  type SimState,
} from '@battlebadger/sim'

// Minimal open map with an inline GameDef — the whole point of Phase 2:
// four classic economies expressed purely as data.
function makeDoc(
  gameDef: GameDef,
  doodads: PlacedDoodad[],
  placed: PlacedEntity[],
  size = 40,
): RtsMapDoc {
  return {
    version: 1,
    name: 'econ-test',
    seed: 7,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable: Array.from({ length: size * size }, () => 1),
    heights: Array.from({ length: size * size }, () => 0),
    startLocations: [
      { x: 5, z: 5 },
      { x: size - 5, z: size - 5 },
    ],
    doodads,
    placed,
    gameDef,
  }
}

function base(id: string, extra: Partial<GameDef>): GameDef {
  return {
    schema: 1,
    id,
    name: id,
    resources: [],
    entities: [],
    abilities: [],
    victory: { mode: 'triggersOnly' },
    ...extra,
  }
}

const run = (doc: RtsMapDoc, ticks: number): SimState => {
  const grid = walkGridFromDoc(doc)
  const sim = setupMatch(doc, grid)
  // each worker auto-sent to its NEAREST matching node via a harvest command
  const cmds = []
  for (let i = 0; i < sim.count; i++) {
    const h = sim.def.entities[sim.type[i]].harvester
    if (!h) continue
    let best = -1
    let bestDSq = Infinity
    for (let n = 0; n < sim.doodads.count; n++) {
      const nd = sim.def.entities[sim.doodads.defIdx[n]].resourceNode
      if (!nd || !h.nodeTags.includes(nd.tag)) continue
      const dx = sim.doodads.x[n] - sim.posX[i]
      const dz = sim.doodads.z[n] - sim.posZ[i]
      const dSq = dx * dx + dz * dz
      if (dSq < bestDSq) {
        best = n
        bestDSq = dSq
      }
    }
    if (best >= 0) cmds.push({ kind: 'harvest' as const, player: sim.owner[i], units: [i], x: 0, z: 0, target: -1 - best })
  }
  step(sim, grid, cmds)
  for (let t = 1; t < ticks; t++) step(sim, grid, [])
  return sim
}

const runTwiceHashEqual = (doc: RtsMapDoc, ticks: number): SimState => {
  const a = run(doc, ticks)
  const b = run(doc, ticks)
  expect(stateHash(a)).toBe(stateHash(b))
  return a
}

const res = (s: SimState, player: number, idx: number): number =>
  s.resources[player * s.def.resources.length + idx]

describe('economy archetypes (pure data)', () => {
  it('SC-style: exclusive mineral patches serialize workers; minerals bank at the nexus', () => {
    const def = base('sc-mini', {
      resources: [
        { id: 'minerals', name: 'Minerals', startAmount: 0 },
        { id: 'gas', name: 'Gas', startAmount: 0 },
      ],
      entities: [
        {
          id: 'scv', name: 'SCV', kind: 'unit', radius: 0.4, hp: 45,
          visual: { model: 'placeholder:capsule' }, mover: { speed: 3 },
          harvester: { carryCapacity: 5, gatherAmount: 5, gatherPeriodTicks: 8, nodeTags: ['mineral'] },
        },
        {
          id: 'nexus', name: 'Nexus', kind: 'building', radius: 1.6, hp: 500,
          visual: { model: 'placeholder:box' }, dropoff: { accepts: ['minerals', 'gas'] },
        },
        {
          id: 'patch', name: 'Mineral Patch', kind: 'doodad', radius: 0.6, hp: 0,
          visual: { model: 'placeholder:crystal' },
          resourceNode: { tag: 'mineral', resource: 'minerals', amount: 100, occupancy: 'exclusive' },
        },
      ],
    })
    const doc = makeDoc(def, [{ def: 'patch', x: 14, z: 10 }], [
      { def: 'nexus', owner: 0, x: 8, z: 10 },
      { def: 'scv', owner: 0, x: 10, z: 9 },
      { def: 'scv', owner: 0, x: 10, z: 11 },
    ])
    const s = runTwiceHashEqual(doc, 600)
    const banked = res(s, 0, 0)
    expect(banked).toBeGreaterThan(0)
    expect(banked % 5).toBe(0)
    // conservation: banked + carried + remaining in node == 100
    let carried = 0
    for (let i = 0; i < s.count; i++) if (s.carryRes[i] === 0) carried += s.carryAmt[i]
    const remaining = s.doodads.alive[0] ? s.doodads.amount[0] : 0
    expect(banked + carried + remaining).toBe(100)
    // exclusivity held every tick is hard to observe post-hoc; occupancy must be 0 or 1 now
    expect(s.doodads.alive[0] ? s.doodads.occupants[0] <= 1 : true).toBe(true)
  })

  it('WC3-style: workers vanish inside the gold mine; trees chop down and unblock cells', () => {
    const def = base('wc3-mini', {
      resources: [
        { id: 'gold', name: 'Gold', startAmount: 0 },
        { id: 'lumber', name: 'Lumber', startAmount: 0 },
      ],
      entities: [
        {
          id: 'peon', name: 'Peon', kind: 'unit', radius: 0.4, hp: 50,
          visual: { model: 'placeholder:capsule' }, mover: { speed: 3 },
          harvester: { carryCapacity: 10, gatherAmount: 10, gatherPeriodTicks: 6, nodeTags: ['goldmine', 'tree'] },
        },
        {
          id: 'hall', name: 'Great Hall', kind: 'building', radius: 1.8, hp: 800,
          visual: { model: 'placeholder:box' }, dropoff: { accepts: ['gold', 'lumber'] },
        },
        {
          id: 'mine', name: 'Gold Mine', kind: 'doodad', radius: 1.4, hp: 0,
          visual: { model: 'placeholder:dome' },
          resourceNode: { tag: 'goldmine', resource: 'gold', amount: 500, occupancy: 'inside', maxOccupants: 1, insideTicks: 5 },
        },
        {
          id: 'tree', name: 'Tree', kind: 'doodad', radius: 0.45, hp: 60,
          visual: { model: 'placeholder:tree' },
          resourceNode: { tag: 'tree', resource: 'lumber', amount: 20, occupancy: 'surround' },
        },
      ],
    })
    const doc = makeDoc(def, [
      { def: 'mine', x: 16, z: 10 },
      { def: 'tree', x: 10, z: 16 },
      { def: 'tree', x: 11.2, z: 16 },
    ], [
      { def: 'hall', owner: 0, x: 8, z: 10 },
      { def: 'peon', owner: 0, x: 10, z: 9 },
    ])
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    // tree blocks its cell at setup
    expect(grid.isWalkableWorld(10, 16)).toBe(false)

    // send the peon to gold: it should go hidden inside the mine at some point
    step(sim, grid, [{ kind: 'harvest', player: 0, units: [1], x: 0, z: 0, target: -1 - 0 }])
    let wasHidden = false
    for (let t = 0; t < 400; t++) {
      step(sim, grid, [])
      if (sim.hidden[1]) wasHidden = true
    }
    expect(wasHidden).toBe(true)
    expect(res(sim, 0, 0)).toBeGreaterThan(0)
    expect(res(sim, 0, 0) % 10).toBe(0)

    // now chop the first tree to depletion → doodadDied → cell unblocks
    // (wait for the peon to emerge first — hidden units ignore commands, as in WC3)
    for (let t = 0; t < 50 && sim.hidden[1]; t++) step(sim, grid, [])
    expect(sim.hidden[1]).toBe(0)
    step(sim, grid, [{ kind: 'harvest', player: 0, units: [1], x: 0, z: 0, target: -1 - 1 }])
    for (let t = 0; t < 400 && sim.doodads.alive[1]; t++) step(sim, grid, [])
    expect(sim.doodads.alive[1]).toBe(0)
    expect(grid.isWalkableWorld(10, 16)).toBe(true)
    // after the first tree dies the peon re-acquires the second tree
    for (let t = 0; t < 300 && sim.doodads.alive[2]; t++) step(sim, grid, [])
    expect(sim.doodads.alive[2]).toBe(0)
    // let the peon walk its final load home
    for (let t = 0; t < 150 && res(sim, 0, 1) < 40; t++) step(sim, grid, [])
    expect(res(sim, 0, 1)).toBe(40) // both trees fully banked
  })

  it('C&C-style: big-carry harvester makes round trips to the refinery', () => {
    const def = base('cnc-mini', {
      resources: [{ id: 'credits', name: 'Credits', startAmount: 0 }],
      powerEnabled: true,
      entities: [
        {
          id: 'harvesterTruck', name: 'Harvester', kind: 'unit', radius: 0.6, hp: 150,
          visual: { model: 'placeholder:box' }, mover: { speed: 2.4 },
          harvester: { carryCapacity: 60, gatherAmount: 15, gatherPeriodTicks: 4, nodeTags: ['ore'] },
        },
        {
          id: 'refinery', name: 'Refinery', kind: 'building', radius: 1.6, hp: 600,
          visual: { model: 'placeholder:box' }, dropoff: { accepts: ['credits'] },
        },
        {
          id: 'oreField', name: 'Ore Field', kind: 'doodad', radius: 0.5, hp: 0,
          visual: { model: 'placeholder:crystal' },
          resourceNode: { tag: 'ore', resource: 'credits', amount: 300, occupancy: 'surround' },
        },
      ],
    })
    const doc = makeDoc(def, [{ def: 'oreField', x: 18, z: 10 }], [
      { def: 'refinery', owner: 0, x: 8, z: 10 },
      { def: 'harvesterTruck', owner: 0, x: 10, z: 10 },
    ])
    const s = runTwiceHashEqual(doc, 800)
    const banked = res(s, 0, 0)
    expect(banked).toBeGreaterThan(0)
    expect(banked % 60).toBe(0) // banks arrive in full truckloads
  })

  it('AoE-style: two resources bank at their own dropoff buildings', () => {
    const def = base('aoe-mini', {
      resources: [
        { id: 'food', name: 'Food', startAmount: 0 },
        { id: 'wood', name: 'Wood', startAmount: 0 },
      ],
      entities: [
        {
          id: 'villager', name: 'Villager', kind: 'unit', radius: 0.38, hp: 40,
          visual: { model: 'placeholder:capsule' }, mover: { speed: 3 },
          harvester: { carryCapacity: 8, gatherAmount: 4, gatherPeriodTicks: 5, nodeTags: ['berries', 'tree'] },
        },
        {
          id: 'granary', name: 'Granary', kind: 'building', radius: 1.2, hp: 400,
          visual: { model: 'placeholder:box' }, dropoff: { accepts: ['food'] },
        },
        {
          id: 'lumberCamp', name: 'Lumber Camp', kind: 'building', radius: 1.2, hp: 400,
          visual: { model: 'placeholder:box' }, dropoff: { accepts: ['wood'] },
        },
        {
          id: 'berryBush', name: 'Berry Bush', kind: 'doodad', radius: 0.4, hp: 0,
          visual: { model: 'placeholder:tree' },
          resourceNode: { tag: 'berries', resource: 'food', amount: 60, occupancy: 'surround' },
        },
        {
          id: 'aoeTree', name: 'Tree', kind: 'doodad', radius: 0.4, hp: 0,
          visual: { model: 'placeholder:tree' },
          resourceNode: { tag: 'tree', resource: 'wood', amount: 60, occupancy: 'surround' },
        },
      ],
    })
    const doc = makeDoc(def, [
      { def: 'berryBush', x: 14, z: 8 },
      { def: 'aoeTree', x: 14, z: 14 },
    ], [
      { def: 'granary', owner: 0, x: 8, z: 8 },
      { def: 'lumberCamp', owner: 0, x: 8, z: 14 },
      { def: 'villager', owner: 0, x: 10, z: 8 },
      { def: 'villager', owner: 0, x: 10, z: 14 },
    ])
    const s = runTwiceHashEqual(doc, 900)
    expect(res(s, 0, 0)).toBeGreaterThan(0) // food banked
    expect(res(s, 0, 1)).toBeGreaterThan(0) // wood banked
    // full depletion conservation across both nodes
    let carried0 = 0
    let carried1 = 0
    for (let i = 0; i < s.count; i++) {
      if (s.carryRes[i] === 0) carried0 += s.carryAmt[i]
      if (s.carryRes[i] === 1) carried1 += s.carryAmt[i]
    }
    const rem0 = s.doodads.alive[0] ? s.doodads.amount[0] : 0
    const rem1 = s.doodads.alive[1] ? s.doodads.amount[1] : 0
    expect(res(s, 0, 0) + carried0 + rem0).toBe(60)
    expect(res(s, 0, 1) + carried1 + rem1).toBe(60)
  })
})
