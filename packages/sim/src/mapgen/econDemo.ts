import type { RtsMapDoc } from '../mapdoc.ts'
import type { GameDef } from '../defs/schema.ts'

// Small WC3-flavored economy demo map (dev/testing: ?demo=econ in the client).
// Exercises: inside-occupancy gold mine, choppable trees, dropoff building,
// harvesters, resources HUD — everything Phase 2 added, as pure data.
export const ECON_DEMO_DEF: GameDef = {
  schema: 1,
  id: 'econ-demo',
  name: 'Economy Demo',
  resources: [
    { id: 'gold', name: 'Gold', startAmount: 1500, uiColor: '#ffd75e' },
    { id: 'lumber', name: 'Lumber', startAmount: 500, uiColor: '#7ec97e' },
  ],
  supplyName: 'Food',
  entities: [
    {
      id: 'peon', name: 'Peon', kind: 'unit', radius: 0.4, hp: 50, supplyCost: 1,
      cost: [{ resource: 'gold', amount: 50 }], buildTimeTicks: 25,
      visual: { model: 'gen:badger-worker', tint: 'owner' },
      mover: { speed: 3.1 },
      combat: { damage: 5, range: 0.5, acquire: 5, periodTicks: 12 },
      harvester: { carryCapacity: 10, gatherAmount: 10, gatherPeriodTicks: 8, nodeTags: ['goldmine', 'tree'] },
      builder: { builds: ['farm', 'barracks'] },
    },
    {
      id: 'grunt', name: 'Grunt', kind: 'unit', radius: 0.42, hp: 70, supplyCost: 2,
      cost: [{ resource: 'gold', amount: 80 }, { resource: 'lumber', amount: 10 }], buildTimeTicks: 40,
      visual: { model: 'gen:badger-sword', tint: 'owner' },
      mover: { speed: 3.4 },
      combat: { damage: 9, range: 0.5, acquire: 7, periodTicks: 10 },
    },
    {
      id: 'hall', name: 'Great Hall', kind: 'building', radius: 2.0, hp: 900, supplyProvided: 6,
      visual: { model: 'gen:hall', tint: 'owner' },
      dropoff: { accepts: ['gold', 'lumber'] },
      trainer: { trains: ['peon'], queueSize: 5 },
    },
    {
      id: 'farm', name: 'Farm', kind: 'building', radius: 1.0, hp: 250, supplyProvided: 4,
      cost: [{ resource: 'gold', amount: 60 }], buildTimeTicks: 50,
      visual: { model: 'gen:farm', scale: 0.55, tint: 'owner' },
    },
    {
      id: 'barracks', name: 'Barracks', kind: 'building', radius: 1.5, hp: 600,
      cost: [{ resource: 'gold', amount: 120 }, { resource: 'lumber', amount: 30 }],
      buildTimeTicks: 80, requires: ['farm'],
      visual: { model: 'gen:barracks', scale: 0.7, tint: 'owner' },
      trainer: { trains: ['grunt'], queueSize: 5 },
    },
    {
      id: 'mine', name: 'Gold Mine', kind: 'doodad', radius: 1.5, hp: 0,
      visual: { model: 'gen:mine', scale: 1.6, tint: 'none' },
      resourceNode: { tag: 'goldmine', resource: 'gold', amount: 5000, occupancy: 'inside', maxOccupants: 2, insideTicks: 8 },
    },
    {
      id: 'tree', name: 'Tree', kind: 'doodad', radius: 0.45, hp: 60,
      visual: { model: 'gen:oak', tint: 'none' },
      resourceNode: { tag: 'tree', resource: 'lumber', amount: 100, occupancy: 'surround' },
    },
  ],
  abilities: [],
  victory: { mode: 'annihilation' },
}

export function generateEconDemo(seed: number): RtsMapDoc {
  const size = 56
  const walkable = Array.from({ length: size * size }, () => 1)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x < 2 || y < 2 || x >= size - 2 || y >= size - 2) walkable[y * size + x] = 0
    }
  }
  const doodads = [{ def: 'mine', x: 40.5, z: 28.5 }]
  // a small forest
  for (let i = 0; i < 24; i++) {
    const gx = 14 + (i % 6) * 1.4
    const gz = 38 + Math.floor(i / 6) * 1.4
    doodads.push({ def: 'tree', x: gx + (i % 3) * 0.3, z: gz + (i % 2) * 0.3 })
  }
  // Both sides open identically: a hall, a work crew and a small guard.
  // Slot 1 previously had two loose grunts and no base — nothing to play.
  const opening = (owner: number, hx: number, hz: number, sign: number) => [
    { def: 'hall', owner, x: hx, z: hz },
    ...Array.from({ length: 4 }, (_, k) => ({
      def: 'peon', owner, x: hx + sign * 4, z: hz - 2 + k * 1.4,
    })),
    ...Array.from({ length: 4 }, (_, k) => ({
      def: 'grunt', owner, x: hx + sign * 6.5, z: hz - 1.5 + k * 1.2,
    })),
  ]
  const placed = [...opening(0, 20, 28, 1), ...opening(1, 44, 44, -1)]
  return {
    version: 1,
    name: 'econ-demo',
    seed,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    heights: Array.from({ length: size * size }, () => 0),
    startLocations: [
      { x: 22, z: 28 },
      { x: 48, z: 46 },
    ],
    doodads,
    placed,
    gameDef: ECON_DEMO_DEF,
  }
}
