import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'
import { FACTION as COMPACT } from './factions/compact.ts'

// "Ridge Crossing" — the Compact's home, against the Badgers.
//
// A ridge splits the map with only two ground passes through it, which is the
// whole point of seating an air faction here: the Compact can ignore the
// terrain the Badgers have to walk around, and the Badgers have to answer that
// with archers and towers rather than by holding the passes.
//
// Balance is per-map. The tuning below applies to this map alone — the Compact
// is untested against Badgers at Four Corners' numbers, so anything adjusted
// here cannot leak into a map somebody has already balanced.

const SIZE = 160
const MID = SIZE / 2
const RIDGE_HALF = 8 // the ridge runs north-south through the middle
const PASS_R = 14

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2

const BASE_W = { x: 30, z: MID }
const BASE_E = { x: SIZE - 30, z: MID }
const PASSES = [
  { x: MID, z: 38 },
  { x: MID, z: SIZE - 38 },
]

const BADGER_ARMY = ['h-swordsmen', 'h-archers', 'h-spearmen', 'h-riders']
const COMPACT_ARMY = ['h-troopers', 'h-lancers', 'h-skiffs', 'h-troopers']

const RIDGE_DEF = composeDef({
  id: 'ridge-crossing',
  name: 'Ridge Crossing',
  factions: [BADGERS, COMPACT],
  victory: { mode: 'annihilation' },
  startAmount: 3200,
  // Per-map balance, and the reason composeDef takes a tune block at all.
  tune: {
    // Air is strongest where ground armies cannot follow, and this map has a
    // ridge to hide behind — so skiffs are costed higher here than they would
    // need to be on open ground.
    'h-skiffs': { cost: [{ resource: 'res', amount: 600 }] },
    // ...and the Badgers get a little more reach on the one weapon they have
    // that can answer a flyer at all.
    archer: { combat: { range: 14 } },
  },
})

function crag(x: number, z: number): number {
  let h = Math.imul(x * 374761393 + z * 668265263, 1274126177)
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}

export function generateRidgeCrossing(seed = 20260730): RtsMapDoc {
  const n = SIZE * SIZE
  const cliffLevel = Array.from<number>({ length: n }).fill(0)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)
  const walkable = Array.from<number>({ length: n }).fill(1)

  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) {
        walkable[i] = 0
        texture[i] = TEX_ROCK
        continue
      }
      if (Math.abs(x + 0.5 - MID) >= RIDGE_HALF) continue
      // two gaps a formation can actually march through
      const inPass = PASSES.some((p) => {
        const dx = x + 0.5 - p.x
        const dz = z + 0.5 - p.z
        return dx * dx + dz * dz < PASS_R * PASS_R
      })
      if (inPass) {
        texture[i] = TEX_DIRT
        continue
      }
      walkable[i] = 0
      cliffLevel[i] = 2
      texture[i] = TEX_ROCK
      heightJitter[i] = 1.0 + crag(x, z) * 2.2
    }
  }

  const placed: PlacedEntity[] = []
  const seat = (owner: number, base: { x: number; z: number }, keep: string, army: string[]): void => {
    placed.push({ def: keep, owner, x: base.x, z: base.z })
    const toward = base.x < MID ? 1 : -1
    army.forEach((def, k) => {
      placed.push({
        def,
        owner,
        x: base.x + toward * (16 + (k % 2) * 5),
        z: base.z - 9 + Math.floor(k / 2) * 9,
      })
    })
  }
  seat(0, BASE_W, BADGERS.keep, BADGER_ARMY)
  seat(1, BASE_E, COMPACT.keep, COMPACT_ARMY)

  // Settlements out toward each pass, so the ground fight has a prize even
  // while the Compact is busy going over the top.
  for (const p of PASSES) {
    placed.push({ def: 'settlement', owner: 0, x: p.x - 22, z: p.z })
    placed.push({ def: 'settlement', owner: 0, x: p.x + 22, z: p.z })
  }

  return {
    version: 2,
    name: 'ridge-crossing',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    cliffLevel,
    texture,
    heightJitter,
    fog: 'full',
    startLocations: [BASE_W, BASE_E],
    placed,
    gameDef: RIDGE_DEF,
  }
}
