import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'

// "The Charge" — a proving ground for cavalry, not a game.
//
// Player 1 fields fifty horsemen against a shield wall of archers and
// infantry, on open flat ground with a long approach so the charge has room to
// build momentum (a rider needs several ticks above its minSpeed before an
// impact counts). No economy, no buildings, no plots: the armies are all there
// is, so a run reads as a clean answer to "what happens when cavalry hits
// this?" rather than as a match.
//
// Rules come straight from Dunhollow so the units, damage matrix and crush
// hierarchy are the real ones — the only change is annihilation victory, so
// the field actually resolves instead of sitting there.

const SIZE = 128
const TEX_GRASS = 0
const TEX_DIRT = 1

// Formations are HORDE TICKETS: setupMatch spawns each as a bound battalion,
// so the cavalry rides as packs and everything carries its formation and
// veterancy — placing loose soldiers here would not be the same fight.
const CAV_PACKS = 10 // × 5 riders = 50 horsemen
const ARCHER_PACKS = 4 // × 8 archers = 32
const FOOT_PACKS = 4 // × 9 swordsmen = 36

const CHARGE_DEF = composeDef({
  id: 'charge-field',
  name: 'The Charge',
  factions: [BADGERS],
  victory: { mode: 'annihilation' },
})

export function generateChargeField(seed = 20260729): RtsMapDoc {
  const n = SIZE * SIZE
  const walkable = Array.from<number>({ length: n }).fill(1)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)

  // Sealed border, and a beaten track down the middle where the two lines meet.
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) walkable[i] = 0
      else if (x > 58 && x < 70) texture[i] = TEX_DIRT
    }
  }

  // Two facing lines with ~55 units of open ground between them: enough for a
  // full gallop, and enough that the archers get several volleys on the way in.
  const CAV_X = 26
  const FOOT_X = 96
  const placed: PlacedEntity[] = []

  const line = (count: number, def: string, owner: number, x: number): void => {
    // Tight frontage on purpose. Spread the lines wide and a charge into the
    // middle simply misses the flanks, which then stand around out of acquire
    // range and the field never resolves.
    const span = 42
    const step = count > 1 ? span / (count - 1) : 0
    const z0 = (SIZE - span) / 2
    for (let k = 0; k < count; k++) {
      placed.push({ def, owner, x, z: z0 + k * step })
    }
  }

  line(CAV_PACKS, 'h-riders', 0, CAV_X)
  // Archers behind, foot in front of them — the wall the horses have to reach.
  line(FOOT_PACKS, 'h-swordsmen', 1, FOOT_X)
  line(ARCHER_PACKS, 'h-archers', 1, FOOT_X + 10)

  return {
    version: 2,
    name: 'charge-field',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    texture,
    heightJitter,
    // A test bed you are meant to watch: no fog.
    fog: 'off',
    // BFME is a two-race game: these are the armies a lobby may seat here.
    races: ['badgers', 'horde'],
    startLocations: [
      { x: CAV_X, z: SIZE / 2 },
      { x: FOOT_X + 6, z: SIZE / 2 },
    ],
    placed,
    gameDef: CHARGE_DEF,
  }
}
