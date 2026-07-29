import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import type { GameDef } from '../defs/schema.ts'
import { DUNHOLLOW_DEF } from './dunhollow.ts'

// "The Pit" — one ogre against a mob of swordsmen.
//
// A sandbox for the club: the ogre's swing throws bodies, so this is the map
// to watch that on. It also answers the balance question the unit raises —
// how many footmen does it take to bring a troll down, and does it take any
// of them with it?
//
// Rules come from Dunhollow so the units and damage matrix are the real ones;
// only the victory mode changes, so the pit actually resolves.

const SIZE = 96
const TEX_GRASS = 0
const TEX_DIRT = 1

const MOB_PACKS = 2 // × 9 swordsmen

const PIT_DEF: GameDef = {
  ...DUNHOLLOW_DEF,
  id: 'troll-pit',
  name: 'The Pit',
  victory: { mode: 'annihilation' },
}

export function generateTrollPit(seed = 20260729): RtsMapDoc {
  const n = SIZE * SIZE
  const walkable = Array.from<number>({ length: n }).fill(1)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)

  const cx = SIZE / 2
  const cz = SIZE / 2
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) walkable[i] = 0
      else {
        // a beaten dirt ring marking the killing floor
        const dx = x + 0.5 - cx
        const dz = z + 0.5 - cz
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < 22) texture[i] = TEX_DIRT
      }
    }
  }

  // The ogre is placed as the SOLDIER def, not its horde ticket: the ticket
  // spawns a pair, and this map wants exactly one troll. It is therefore loose
  // — no formation or veterancy — which costs nothing in a sandbox.
  const placed: PlacedEntity[] = [{ def: 'ogre', owner: 0, x: cx - 8, z: cz }]

  // The mob, in a loose arc so they close from a spread rather than a column.
  for (let k = 0; k < MOB_PACKS; k++) {
    placed.push({
      def: 'h-swordsmen',
      owner: 1,
      x: cx + 14,
      z: cz - 6 + k * 12,
    })
  }

  return {
    version: 2,
    name: 'troll-pit',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    texture,
    heightJitter,
    fog: 'off', // a thing to watch, not a thing to scout
    startLocations: [
      { x: cx - 8, z: cz },
      { x: cx + 14, z: cz },
    ],
    placed,
    gameDef: PIT_DEF,
  }
}
