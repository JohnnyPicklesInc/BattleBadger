import type { PlacedEntity, PlacedDoodad, RtsMapDoc } from '../mapdoc.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'
import { FACTION as HORDE } from './factions/horde.ts'
import { FORTIFICATIONS } from './factions/fortifications.ts'
import { CARDINALS, DIAGONALS, ring } from './factions/shared.ts'

// "The Last Alliance" — 4v4, west against east, a real fortress at each end.
//
// The fortress is built into the map rather than being a building you plant:
// a curtain wall of individual sections, a great gate that has to be broken,
// sally ports the defenders sortie from, corner towers, and siege emplacements
// already cut into the battlements waiting for an engine.
//
// The shape is three levels, and each one is a different fight:
//
//   * the FIELD, all one level, where the armies meet and the settlements are
//   * the COURTYARD, at field level and enclosed only by the wall — which is
//     what makes the gate the door rather than decoration. Break in and you
//     are inside, immediately, with four players' production around you.
//   * the INNER WARD (tier 1) and CITADEL (tier 2) behind it, reached by ramps.
//     Losing the wall is not losing the fortress; it is the start of the part
//     that is fought uphill.
//
// Four players share each fortress. That is deliberate: nobody owns "the north
// wall", so the emplacements are cheap enough in attention that somebody will
// actually crew them, and a sally is a thing a team agrees to rather than a
// thing one player does.

// Roughly half again as large in both directions. The old fortress was 64
// cells across inside its walls, which four players had to share — bases
// overlapped, the plots had to be squeezed into two columns, and the field
// between the gates was short enough that an army was under fire almost as
// soon as it left. There is now room to keep a real base and room to march.
const W = 352
const H = 224
const MID_X = W / 2

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_SNOW = 4

// Fortress box, in cells, for the WEST side. The east is mirrored.
const FORT_X0 = 10
const FORT_X1 = 108 // the front wall — the face the enemy sees
const FORT_Z0 = 22
const FORT_Z1 = H - 22

// The tiers, as bands of x. The cliff between two bands is impassable except
// where a ramp cuts it, so every plot has to sit wholly inside one band —
// which is why these are named rather than derived.
const CITADEL_X1 = 34 // tier 2: the back strongpoint, x 12..34
const WARD_X1 = 84 // tier 1 runs from the citadel edge out to here — where the
// four keeps and their plots live
const WARD_Z0 = 34
const WARD_Z1 = H - 34

// Each player's base is a ring around their keep, the same shape a keep's own
// expansion ring makes on an open map — it just has to be authored here,
// because four of them share one enclosure and four overlapping rings deal one
// ally twelve plots and another nine.
//
// The keep sits in the MIDDLE of the ward rather than against its outer edge,
// so the ring is a circle rather than a circle with one side shaved off by the
// cliff.
const KEEP_X = 60
const KEEP_Z = [52, 92, 132, 172]
const PLOT_RING = 11 // build plots, eight of them evenly around the keep
const PAD_RING = 18 // towers: one to each quarter, out on the approaches
const PAD_INNER = 16 // and four drawn in, filling the gaps between them

// Ground the whole team may build on, in the courtyard and along the wall.
const SHARED_PLOT_X = 96
const SHARED_PAD_X = 90
const SHARED_ROWS = [34, 58, 82, 142, 166, 190]
const SHARED_PAD_ROWS = [40, 64, 88, 136, 160, 184]
// Bands of z with no player's block in them — where ramps and the citadel
// stair can cut through without landing on somebody's plots.
const WARD_RAMP_Z = [[68, 76], [148, 156]] as const
const CITADEL_RAMP_Z = [108, 116] as const

const WALL_STEP = 3 // wall sections this far apart overlap into a solid curtain
// The gate and the sally ports stand ON the wall lattice, and each is sized to
// cover exactly the sections it displaces. Put one between two lattice points
// and the curtain develops a hole beside it that an army walks through.
// floor(+0.5) rather than rounding: this file lives under packages/sim, where
// rounding is banned outright (see scripts/check-sim-purity.mjs).
const onLattice = (z: number): number => FORT_Z0 + Math.floor((z - FORT_Z0) / WALL_STEP + 0.5) * WALL_STEP
const GATE_Z = onLattice(H / 2)
const SALLY_Z = [onLattice(FORT_Z0 + 42), onLattice(FORT_Z1 - 42)]

const WEST_SLOTS = [0, 1, 2, 3]
const EAST_SLOTS = [4, 5, 6, 7]

const WEST_ARMY = ['h-swordsmen', 'h-archers', 'h-spearmen']
const EAST_ARMY = ['h-orcs', 'h-orc-archers', 'h-orc-pikemen']

const DEF = composeDef({
  id: 'last-alliance',
  name: 'The Last Alliance',
  factions: [BADGERS, HORDE],
  modules: [FORTIFICATIONS],
  victory: { mode: 'annihilation' },
  // The keeps bring no ring of their own on this map. Four of them share one
  // enclosure, so their rings would overlap and the plots are authored below
  // instead — every player gets the same block, in their own lane.
  tune: {
    fortress: { expansion: [] },
    'dark-fortress': { expansion: [] },
  },
  // A siege map has to be paid for. Four players behind a wall with a normal
  // opening purse never field the engines the map is built around, and the
  // attack that never comes is the worst version of this map.
  startAmount: 6000,
})

// Deterministic craggy variation. Integer hash, no RNG state — this file is
// imported by scripts/gen-starter-maps.mjs under plain Node.
function crag(x: number, z: number): number {
  let h = Math.imul(x * 374761393 + z * 668265263, 1274126177)
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}

/** Mirror a west-side cell x onto the east side. */
const mx = (x: number): number => W - 1 - x

interface Fort {
  side: 'west' | 'east'
  slots: number[]
  keep: string
  plot: string
  army: string[]
  /** owner that holds the masonry — the team's lowest slot */
  holder: number
}

export function generateLastAlliance(seed = 20260731): RtsMapDoc {
  const n = W * H
  const cliffLevel = Array.from<number>({ length: n }).fill(0)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)
  const walkable = Array.from<number>({ length: n }).fill(1)
  const ramp = Array.from<number>({ length: n }).fill(0)

  const at = (x: number, z: number): number => z * W + x

  // ---- the field -------------------------------------------------------
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, z)
      if (x < 2 || z < 2 || x >= W - 2 || z >= H - 2) {
        walkable[i] = 0
        texture[i] = TEX_ROCK
        continue
      }
      // Mountains close the north and south edges, so the only way between the
      // two fortresses is across the field. There is no flank to find.
      const edge = Math.min(z, H - 1 - z)
      if (edge < 16) {
        walkable[i] = 0
        cliffLevel[i] = 3
        texture[i] = edge < 8 ? TEX_SNOW : TEX_ROCK
        heightJitter[i] = 1.4 + crag(x, z) * 3.0
        continue
      }
      // The road between the gates, which is where the armies will meet.
      if (Math.abs(z + 0.5 - H / 2) < 11) texture[i] = TEX_DIRT
    }
  }

  // ---- the raised ground inside each fortress ---------------------------
  const raise = (x0: number, x1: number, z0: number, z1: number, level: number): void => {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 2 || z < 2 || x >= W - 2 || z >= H - 2) continue
        cliffLevel[at(x, z)] = level
        texture[at(x, z)] = TEX_ROCK
      }
    }
  }
  const cutRamp = (x0: number, x1: number, z0: number, z1: number): void => {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 2 || z < 2 || x >= W - 2 || z >= H - 2) continue
        ramp[at(x, z)] = 1
        texture[at(x, z)] = TEX_DIRT
      }
    }
  }

  const forts: Fort[] = [
    { side: 'west', slots: WEST_SLOTS, keep: BADGERS.keep, plot: 'fortress-plot', army: WEST_ARMY, holder: 0 },
    { side: 'east', slots: EAST_SLOTS, keep: HORDE.keep, plot: 'horde-plot', army: EAST_ARMY, holder: 4 },
  ]

  const placed: PlacedEntity[] = []
  const doodads: PlacedDoodad[] = []
  const startLocations: { x: number; z: number }[] = []

  for (const fort of forts) {
    const west = fort.side === 'west'
    // Every x below is written for the west fortress and mirrored for the east,
    // so the two are identical rather than separately hand-tuned.
    const fx = (x: number): number => (west ? x : mx(x))
    // A wall section's model runs along its own local X, which the renderer
    // lays across `facing`. So a run of wall along world Z and a run along
    // world X are the same entity pointed two ways — without this every wall
    // on the map pointed the same way and half of them read as loose blocks.
    const ALONG_Z = { x: 1, z: 0 } // sections stack north-south (the front wall)
    const ALONG_X = { x: 0, z: 1 } // sections stack east-west (the side walls)
    const put = (
      def: string,
      x: number,
      z: number,
      facing: { x: number; z: number } = ALONG_Z,
      owner = fort.holder,
    ): void => {
      placed.push({ def, owner, x: fx(x) + 0.5, z: z + 0.5, always: true, facing })
    }

    // Citadel (tier 2) at the back, inner ward (tier 1) in front of it. Both
    // held off the side walls so a courtyard lane runs all the way round.
    const raiseBand = (x0: number, x1: number, z0: number, z1: number, level: number): void => {
      if (west) raise(x0, x1, z0, z1, level)
      else raise(mx(x1), mx(x0), z0, z1, level)
    }
    raiseBand(FORT_X0 + 2, WARD_X1, WARD_Z0, WARD_Z1, 1)
    raiseBand(FORT_X0 + 2, CITADEL_X1, WARD_Z0 + 14, WARD_Z1 - 14, 2)

    // Ramps. Two from the courtyard into the ward and one up to the citadel —
    // few enough that holding the ward is a real line once the wall is gone,
    // and threaded between the players' plot blocks so nothing sits on them.
    const rampBand = (x0: number, x1: number, z0: number, z1: number): void => {
      if (west) cutRamp(x0, x1, z0, z1)
      else cutRamp(mx(x1), mx(x0), z0, z1)
    }
    for (const [z0, z1] of WARD_RAMP_Z) rampBand(WARD_X1 - 2, WARD_X1 + 4, z0, z1)
    rampBand(CITADEL_X1 - 2, CITADEL_X1 + 4, CITADEL_RAMP_Z[0], CITADEL_RAMP_Z[1])

    // ---- the curtain wall ----------------------------------------------
    for (let z = FORT_Z0; z <= FORT_Z1; z += WALL_STEP) {
      // The gate displaces three sections, a sally port exactly one.
      const nearGate = Math.abs(z - GATE_Z) <= WALL_STEP
      const nearSally = SALLY_Z.some((sz) => z === sz)
      if (nearGate || nearSally) continue
      put('wall', FORT_X1, z)
    }
    put('gate', FORT_X1, GATE_Z)
    for (const sz of SALLY_Z) put('sally-port', FORT_X1, sz)
    put('wall-tower', FORT_X1, FORT_Z0 + 18)
    put('wall-tower', FORT_X1, FORT_Z1 - 18)
    put('wall-corner', FORT_X1, FORT_Z0)
    put('wall-corner', FORT_X1, FORT_Z1)

    // North and south walls. They run all the way to the map's own edge, not
    // just to the fortress box: stopping at FORT_X0 left a corridor around the
    // back of the wall wide enough to walk an army through, which made the
    // gate decorative.
    for (let x = 2; x < FORT_X1; x += WALL_STEP) {
      put('wall', x, FORT_Z0, ALONG_X)
      put('wall', x, FORT_Z1, ALONG_X)
    }
    // The back needs no masonry — the map border closes it.

    // Emplacements along the battlement, already cut and waiting for engines.
    for (const ez of [GATE_Z - 30, GATE_Z - 14, GATE_Z + 14, GATE_Z + 30]) {
      put('siege-emplacement', FORT_X1 - 5, ez)
    }
    for (const sz of SALLY_Z) put('siege-emplacement', FORT_X1 - 5, sz + 6)

    // ---- shared ground -------------------------------------------------
    // Team-owned, and plots are open to allies, so all four players may build
    // on these. Nobody owns the courtyard, which is the point: it is the ward
    // everybody defends and the first thing an attacker walks into.
    for (const cz of SHARED_ROWS) put(fort.plot, SHARED_PLOT_X, cz)
    for (const tz of SHARED_PAD_ROWS) put('tower-plot', SHARED_PAD_X, tz)
    // ...and pads OUTSIDE the wall, flanking the gate approach. Exposed on
    // purpose: a tower out here sees the army forming up, and dies to it.
    for (const tz of [GATE_Z - 16, GATE_Z + 16, GATE_Z - 44, GATE_Z + 44]) {
      put('tower-plot', FORT_X1 + 7, tz)
    }

    // ---- the four players ------------------------------------------------
    // Every slot gets the same block, laid out in its own lane. Hand-placed
    // rather than sprayed from each keep's expansion ring: four rings inside
    // one enclosure overlap, and the guard that drops a colliding pad then
    // hands one ally twelve plots and another nine.
    fort.slots.forEach((slot, k) => {
      const kz = KEEP_Z[k]
      placed.push({ def: fort.keep, owner: slot, x: fx(KEEP_X) + 0.5, z: kz + 0.5 })
      startLocations.push({ x: fx(KEEP_X) + 0.5, z: kz + 0.5 })
      for (const o of ring([...CARDINALS, ...DIAGONALS], PLOT_RING)) {
        put(fort.plot, KEEP_X + o.dx, kz + o.dz, ALONG_Z, slot)
      }
      for (const o of [...ring(CARDINALS, PAD_RING), ...ring(DIAGONALS, PAD_INNER)]) {
        put('tower-plot', KEEP_X + o.dx, kz + o.dz, ALONG_Z, slot)
      }
      // A starting battalion each, formed up in the courtyard behind the wall
      // rather than on the ward — they are the garrison, not a reserve.
      fort.army.forEach((ticket, a) => {
        placed.push({ def: ticket, owner: slot, x: fx(FORT_X1 - 14 - a * 5) + 0.5, z: kz + 0.5 })
      })
    })
  }

  // ---- the field between -----------------------------------------------
  // The reason to leave the walls at all. All of it is neutral, so either side
  // may claim it, and all of it sits in the open where holding a spot means
  // winning the field fight rather than sneaking a builder out.
  //
  // Two grades. Settlements are the small change, scattered wide. Expansions
  // are the prize: a handful of them, on the road, where both armies have to
  // walk past each other to reach one.
  for (const sz of [GATE_Z - 64, GATE_Z - 40, GATE_Z + 40, GATE_Z + 64]) {
    for (const sx of [MID_X - 56, MID_X - 28, MID_X, MID_X + 28, MID_X + 56]) {
      placed.push({ def: 'settlement', owner: 0, x: sx + 0.5, z: sz + 0.5, always: true })
    }
  }
  for (const [ex, ez] of [
    [MID_X - 46, GATE_Z - 20],
    [MID_X - 46, GATE_Z + 20],
    [MID_X + 46, GATE_Z - 20],
    [MID_X + 46, GATE_Z + 20],
    [MID_X, GATE_Z - 28],
    [MID_X, GATE_Z + 28],
    [MID_X - 92, GATE_Z],
    [MID_X + 92, GATE_Z],
  ] as const) {
    placed.push({ def: 'expansion-plot', owner: 0, x: ex + 0.5, z: ez + 0.5, always: true })
  }

  // Scattered cover on the field, thinning toward the road so the main
  // approach stays open ground a formation can cross.
  for (let z = 22; z < H - 22; z += 6) {
    for (let x = 124; x < W - 124; x += 6) {
      const h = crag(x, z)
      if (h < 0.72) continue
      if (Math.abs(z + 0.5 - H / 2) < 14) continue
      doodads.push({ def: h > 0.9 ? 'rock' : 'tree', x: x + 0.5 + h, z: z + 0.5 - h, scale: 0.9 + h * 0.5 })
    }
  }

  return {
    version: 2,
    name: 'last-alliance',
    seed,
    cols: W,
    rows: H,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    fog: 'units',
    // West is team 0, east is team 1. Alternating would put allies at opposite
    // ends of the map, which is the one arrangement this map cannot support.
    slotTeams: [0, 0, 0, 0, 1, 1, 1, 1],
    startLocations,
    placed,
    doodads,
    gameDef: DEF,
  }
}
