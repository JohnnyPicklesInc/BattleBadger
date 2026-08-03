import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'
import { FACTION as HORDE } from './factions/horde.ts'

// "Four Corners" — a 4-player free-for-all on the BFME ruleset.
//
// Each player holds a corner behind a mountain spur, and the spurs radiate out
// from a single open plaza in the middle. There is no side door: to reach ANY
// other player you must come through the centre, so the plaza is both the only
// road and the thing worth holding. Settlements ring it, so taking the middle
// pays for itself.
//
// Rules are Dunhollow's, so plots, battalions, formations, veterancy and the
// whole damage matrix come along unchanged. Only the victory mode differs —
// last army standing, since there are no triggers here.

const SIZE = 176
const MID = SIZE / 2
const PLAZA_R = 26 // open ground in the middle, where everyone meets
const SPUR_HALF = 7 // half-width of each mountain arm

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2

const BASES = [
  { x: 34, z: 34 },
  { x: SIZE - 34, z: 34 },
  { x: 34, z: SIZE - 34 },
  { x: SIZE - 34, z: SIZE - 34 },
]

// Two factions, seated on opposite diagonals so each player faces one of
// each across the plaza. A player's faction is decided by which keep they
// start with: the keep's expansion plots gate which buildings they can raise,
// which gates what they can train. No engine support for "factions" is needed
// — it falls out of the plot system.
const BADGER_KEEP = 'fortress'
const HORDE_KEEP = 'dark-fortress'

const BADGER_ARMY = ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-riders', 'h-captain']
// Cheaper and far more numerous: 15+14+12 bodies against 9+9+8.
const HORDE_ARMY = ['h-orcs', 'h-orc-pikemen', 'h-orc-archers', 'h-orcs', 'h-ogre']

const FACTIONS = [
  { keep: BADGER_KEEP, army: BADGER_ARMY },
  { keep: HORDE_KEEP, army: HORDE_ARMY },
]

// BASES run NW, NE, SW, SE — so this puts the two factions on opposite
// diagonals, and every player faces one of each across the plaza.
const SLOT_FACTION = [0, 1, 1, 0]

// Seats exactly the two factions it uses. Balance is per-map: the tuning
// below applies here and nowhere else, so a change made for this map cannot
// quietly rebalance Dunhollow.
const FOUR_DEF = composeDef({
  id: 'four-corners',
  name: 'Four Corners',
  factions: [BADGERS, HORDE],
  victory: { mode: 'annihilation' },
})

// Deterministic craggy variation. Integer hash, no RNG state — this file is
// imported by scripts/gen-starter-maps.mjs under plain Node, so it must not
// reach the sim's runtime chain.
function crag(x: number, z: number): number {
  let h = Math.imul(x * 374761393 + z * 668265263, 1274126177)
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}

export function generateFourCorners(seed = 20260729): RtsMapDoc {
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
      const dx = x + 0.5 - MID
      const dz = z + 0.5 - MID
      const fromMid = Math.sqrt(dx * dx + dz * dz)

      // Four mountain arms on the axes, cut short of the middle. Everything
      // inside PLAZA_R stays open, which is what leaves exactly one way
      // between any two corners.
      const onArm = Math.abs(dx) < SPUR_HALF || Math.abs(dz) < SPUR_HALF
      if (onArm && fromMid > PLAZA_R) {
        // Blocked explicitly as well as raised: deriveTerrain only carves the
        // cliff *edge*, so a wide plateau would otherwise be walkable on top.
        walkable[i] = 0
        cliffLevel[i] = 2
        texture[i] = TEX_ROCK
        heightJitter[i] = 1.2 + crag(x, z) * 2.4
        continue
      }

      // The plaza floor, and the roads running out to each corner.
      if (fromMid < PLAZA_R) texture[i] = TEX_DIRT
      else if (Math.abs(Math.abs(dx) - Math.abs(dz)) < 4) texture[i] = TEX_DIRT
    }
  }

  const placed: PlacedEntity[] = []
  BASES.forEach((base, owner) => {
    const faction = FACTIONS[SLOT_FACTION[owner]]
    placed.push({ def: faction.keep, owner, x: base.x, z: base.z })
    // Muster on the diagonal facing the middle, clear of the fortress's own
    // ring of expansion plots.
    const towardX = base.x < MID ? 1 : -1
    const towardZ = base.z < MID ? 1 : -1
    faction.army.forEach((def, k) => {
      placed.push({
        def,
        owner,
        x: base.x + towardX * (16 + (k % 2) * 5),
        z: base.z + towardZ * (16 + Math.floor(k / 2) * 6),
      })
    })
  })

  // Settlements: two out in each corner, plus a ring around the plaza that is
  // only safely held by whoever controls the middle.
  const settlements: { x: number; z: number }[] = []
  for (const b of BASES) {
    const tx = b.x < MID ? 1 : -1
    const tz = b.z < MID ? 1 : -1
    settlements.push({ x: b.x + tx * 4, z: b.z + tz * 30 })
    settlements.push({ x: b.x + tx * 30, z: b.z + tz * 4 })
  }
  for (const [ox, oz] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    settlements.push({ x: MID + ox * (PLAZA_R - 8), z: MID + oz * (PLAZA_R - 8) })
  }
  for (const st of settlements) placed.push({ def: 'settlement', owner: 0, x: st.x, z: st.z })

  return {
    version: 2,
    name: 'four-corners',
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
    // No slotTeams: slot = team, so this is a free-for-all. Add
    // [0, 1, 0, 1] here to make it 2v2 across the diagonals.
    // BFME is a two-race game: these are the armies a lobby may seat here.
    races: ['badgers', 'horde'],
    startLocations: BASES.map((b) => ({ x: b.x, z: b.z })),
    placed,
    gameDef: FOUR_DEF,
  }
}
