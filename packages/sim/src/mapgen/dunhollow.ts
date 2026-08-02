import type { MapRegion, PlacedDoodad, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'

// "Siege of Dunhollow" — a Battle for Middle-earth style skirmish, expressed
// entirely as GameDef + map data. What makes it play like BFME rather than
// like a StarCraft clone:
//
//   * No harvesters. Farms pay a passive trickle, and farms crowded together
//     pay less each — expansion is spatial, not a worker-count problem.
//   * No free base building. Structures only go on plots: a ring around each
//     fortress, plus neutral settlements out on the map worth fighting over —
//     and sites where a whole new base goes up, three buildings, six, or a
//     second fortress with the full ring, depending on the ground.
//   * Battalions, not soldiers. A barracks trains a *horde*: nine men, one
//     command-point charge, one selection, one XP track, one formation.
//   * Rock-paper-scissors lives in the damage/armor matrix: spears gut cavalry,
//     cavalry runs down archers, archers shred infantry, catapults level walls
//     and are useless against anything that moves.
//   * Heroes are hordes of one, so veterancy works on them for free.
//
// Everything above is data. The only engine features it leans on are income,
// plots, hordes/formations and veterancy.

const SIZE = 160
const BASE_A = { x: 30, z: 128 } // player 0, south-west
const BASE_B = { x: 128, z: 30 } // player 1, north-east
const RIDGE_HALF = 9 // the ridge runs along x ≈ z, dividing the two corners
const GATES = [
  { x: 44, z: 44 }, // north pass
  { x: 116, z: 116 }, // south pass
]
const GATE_R = 13

// Crush hierarchy: a charge flattens anything strictly below its own level.
// Foot troops go down under hooves; horses do not ride over other horses, a
// siege engine, or a wall. Buildings default to uncrushable in compile.ts.

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_SAND = 3
const TEX_FOREST = 5

// Siege of Dunhollow seats the Badgers alone. Composing rather than sharing one
// monolithic def is what keeps a two-player badger map from shipping orc and
// gunship definitions it can never spawn.
export const DUNHOLLOW_DEF = composeDef({
  id: 'dunhollow',
  name: 'Siege of Dunhollow',
  factions: [BADGERS],
  victory: { mode: 'triggersOnly' },
})


// Deterministic LCG — the same seed lays out the same world on every client.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Circle {
  x: number
  z: number
  r: number
}

const inside = (c: Circle, x: number, z: number): boolean => {
  const dx = x - c.x
  const dz = z - c.z
  return dx * dx + dz * dz <= c.r * c.r
}

// The two corners are mirror images across the x = z diagonal, so anything
// placed for one side is placed for the other by swapping its coordinates.
// Authoring both halves by hand is how a map that claims to be symmetric ends
// up not being one — which the old settlement list quietly was.
const mirrored = (pts: { x: number; z: number }[]): { x: number; z: number }[] =>
  pts.flatMap((p) => [p, { x: p.z, z: p.x }])

// Points along a polyline, used to paint roads and to keep them clear.
function alongPath(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]
    const b = pts[k + 1]
    const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z))
    const n = Math.max(1, Math.ceil(len / step))
    for (let i = 0; i <= n; i++) {
      out.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n })
    }
  }
  return out
}

export function generateDunhollow(seed = 20260727): RtsMapDoc {
  const n = SIZE * SIZE
  const cliffLevel = Array.from<number>({ length: n }).fill(0)
  const ramp = Array.from<number>({ length: n }).fill(0)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)
  const next = rng(seed)

  // The bases sit in opposite corners (south-west and north-east), so the
  // ground that divides them is the x ≈ z diagonal. Getting this wrong puts
  // both fortresses on the same plateau with cliff bands around their bases —
  // the map-sanity test below exists because that is exactly what happened.
  const onRidge = (x: number, z: number): boolean => Math.abs(x - z) < RIDGE_HALF
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      if (!onRidge(x, z)) continue
      const i = z * SIZE + x
      cliffLevel[i] = 1
      texture[i] = TEX_ROCK
    }
  }
  // Two passes through the ridge. Wider than the band, so each is a real
  // corridor rather than a notch a formation can't fit through.
  for (const gate of GATES) {
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        const i = z * SIZE + x
        if (cliffLevel[i] !== 1 || !inside({ ...gate, r: GATE_R }, x, z)) continue
        ramp[i] = 1
        texture[i] = TEX_DIRT
      }
    }
  }

  // Settlements: one-building pads, two per side plus one at each end of each
  // pass, all worth fighting for.
  const settlements = [
    ...mirrored([{ x: 22, z: 104 }, { x: 58, z: 108 }, { x: 26, z: 78 }]),
    { x: GATES[0].x - 14, z: GATES[0].z + 14 }, { x: GATES[0].x + 14, z: GATES[0].z - 14 },
    { x: GATES[1].x - 14, z: GATES[1].z + 14 }, { x: GATES[1].x + 14, z: GATES[1].z - 14 },
  ]

  // Ground you can raise a NEW BASE on, in three sizes. This is the BFME
  // expansion game: an outpost is three buildings, a camp six and its own
  // picket of tower pads, and a castle site takes a second fortress with the
  // full ring. Each is placed with the room its ring needs — `clear` below
  // keeps the woods off it, and the map-sanity test proves the ring lands on
  // open ground rather than half of it in the rock.
  const sites = [
    ...mirrored([{ x: 46, z: 84 }]).map((p) => ({ ...p, def: 'castle-site', r: 20 })),
    ...mirrored([{ x: 84, z: 142 }]).map((p) => ({ ...p, def: 'camp-site', r: 16 })),
    ...mirrored([{ x: 76, z: 116 }]).map((p) => ({ ...p, def: 'outpost-site', r: 11 })),
  ]

  // A standing army at each fortress, mustered as BATTALIONS rather than
  // loose men: these are horde tickets, so setupMatch spawns each as a bound
  // horde with its formation, veterancy track and command-point cost intact.
  // Riders in particular need this — cavalry fights as a pack.
  const STARTING_ARMY = ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-riders', 'h-catapult', 'h-captain']

  // Spread the battalions along the flank of each fortress, clear of its ring
  // of build plots. Laid out inline rather than via systems/orders: this file
  // is imported by scripts/gen-starter-maps.mjs under plain Node, so it must
  // not reach the sim's runtime import chain.
  const muster = (owner: number, base: { x: number; z: number }, sign: number): PlacedEntity[] =>
    STARTING_ARMY.map((def, k) => ({
      def,
      owner,
      x: base.x + sign * 15 + (k - 2.5) * 5.5,
      z: base.z + sign * 15,
    }))

  const placed: PlacedEntity[] = [
    { def: 'fortress', owner: 0, x: BASE_A.x, z: BASE_A.z },
    { def: 'fortress', owner: 1, x: BASE_B.x, z: BASE_B.z },
    ...muster(0, BASE_A, 1),
    ...muster(1, BASE_B, -1),
    // Neutral settlements: outer plots worth pushing for. Owner 0 is only a
    // placement slot — `neutral` is what decides who may build.
    ...settlements.map((s) => ({ def: 'settlement', owner: 0, x: s.x, z: s.z })),
    ...sites.map((s) => ({ def: s.def, owner: 0, x: s.x, z: s.z })),
  ]

  // ---- roads: base → each pass → enemy base, painted dirt and kept clear ----
  const roads = [
    alongPath([BASE_A, { x: GATES[0].x - 10, z: GATES[0].z + 10 }, GATES[0], { x: GATES[0].x + 10, z: GATES[0].z - 10 }, BASE_B], 2),
    alongPath([BASE_A, { x: GATES[1].x - 10, z: GATES[1].z + 10 }, GATES[1], { x: GATES[1].x + 10, z: GATES[1].z - 10 }, BASE_B], 2),
  ].flat()
  for (const p of roads) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.floor(p.x) + dx
        const z = Math.floor(p.z) + dz
        if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) continue
        const i = z * SIZE + x
        if (texture[i] === TEX_GRASS) texture[i] = TEX_DIRT
      }
    }
  }

  // ---- keep-out list: bases and their plot rings, settlements, passes, roads
  const clear: Circle[] = [
    { x: BASE_A.x, z: BASE_A.z, r: 20 },
    { x: BASE_B.x, z: BASE_B.z, r: 20 },
    ...settlements.map((s) => ({ x: s.x, z: s.z, r: 9 })),
    // A site needs room for the base it will one day carry, not for the pad.
    ...sites.map((s) => ({ x: s.x, z: s.z, r: s.r })),
    ...GATES.map((g) => ({ x: g.x, z: g.z, r: GATE_R + 3 })),
    ...roads.map((p) => ({ x: p.x, z: p.z, r: 4 })),
  ]
  const isClear = (x: number, z: number): boolean => !clear.some((c) => inside(c, x, z))

  // ---- doodads: clumped, not sprinkled. Woods block movement, so they shape
  // the fight as much as the ridge does — hence the clearings above.
  const doodads: PlacedDoodad[] = []
  const paintUnder = (x: number, z: number, r: number, tex: number): void => {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = Math.floor(x) + dx
        const cz = Math.floor(z) + dz
        if (cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE) continue
        if (dx * dx + dz * dz > r * r) continue
        const i = cz * SIZE + cx
        if (texture[i] === TEX_GRASS) texture[i] = tex
      }
    }
  }
  // woods
  for (let attempt = 0, made = 0; attempt < 400 && made < 26; attempt++) {
    const cx = 8 + next() * (SIZE - 16)
    const cz = 8 + next() * (SIZE - 16)
    if (!isClear(cx, cz) || onRidge(cx, cz)) continue
    made++
    const spread = 5 + next() * 5
    paintUnder(cx, cz, Math.ceil(spread) + 1, TEX_FOREST)
    const trees = 7 + Math.floor(next() * 9)
    for (let t = 0; t < trees; t++) {
      const x = cx + (next() - 0.5) * spread * 2
      const z = cz + (next() - 0.5) * spread * 2
      if (x < 3 || z < 3 || x > SIZE - 3 || z > SIZE - 3 || !isClear(x, z)) continue
      doodads.push({ def: 'pine', x, z, rot: next() * 6.28, scale: 0.9 + next() * 0.7 })
    }
  }
  // rock outcrops, hugging the ridge where the ground is already stone
  for (let attempt = 0, made = 0; attempt < 300 && made < 18; attempt++) {
    const cx = 6 + next() * (SIZE - 12)
    const cz = 6 + next() * (SIZE - 12)
    if (!isClear(cx, cz) || Math.abs(cx - cz) > RIDGE_HALF + 16) continue
    made++
    paintUnder(cx, cz, 4, TEX_ROCK)
    const rocks = 2 + Math.floor(next() * 4)
    for (let t = 0; t < rocks; t++) {
      const x = cx + (next() - 0.5) * 7
      const z = cz + (next() - 0.5) * 7
      if (x < 3 || z < 3 || x > SIZE - 3 || z > SIZE - 3 || !isClear(x, z)) continue
      doodads.push({ def: 'boulder', x, z, rot: next() * 6.28, scale: 0.8 + next() * 0.9 })
    }
  }
  // sandy clearings around every settlement so they read as places
  for (const s of settlements) paintUnder(s.x, s.z, 7, TEX_SAND)
  // and a bigger one under a site, so the ground a base can stand on is
  // legible from the camera before anything is built there
  for (const s of sites) paintUnder(s.x, s.z, s.r - 3, TEX_SAND)

  // Micro-relief: render-only, but it stops the ground reading as a flat sheet.
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x
      const h = ((Math.imul((x + 1) ^ ((z + 1) << 8), 0x9e3779b1) >>> 20) / 4096 - 0.5) * 0.5
      heightJitter[i] = cliffLevel[i] === 1 && ramp[i] === 0 ? h * 1.8 : h
    }
  }

  const regions: MapRegion[] = [
    { id: 'ridge', name: 'The Ridge', x0: 0, z0: 0, x1: SIZE, z1: SIZE },
    { id: 'north-pass', name: 'North Pass', x0: GATES[0].x - 12, z0: GATES[0].z - 12, x1: GATES[0].x + 12, z1: GATES[0].z + 12 },
    { id: 'south-pass', name: 'South Pass', x0: GATES[1].x - 12, z0: GATES[1].z - 12, x1: GATES[1].x + 12, z1: GATES[1].z + 12 },
  ]

  const triggers: TriggerDef[] = [
    {
      id: 'intro', name: 'intro', once: true,
      events: [{ type: 'mapInit' }],
      conditions: [],
      actions: [
        {
          type: 'message',
          to: 'all',
          text: 'Build on your fortress plots. Farms pay less when crowded. Take the settlements — and the outpost, camp and castle sites, where you can raise a base of your own.',
        },
        { type: 'panCamera', player: 0, x: BASE_A.x, z: BASE_A.z },
        { type: 'panCamera', player: 1, x: BASE_B.x, z: BASE_B.z },
      ],
    },
  ]
  for (const side of [0, 1] as const) {
    triggers.push({
      id: `fortress-${side}-falls`,
      name: `Fortress ${side + 1} destroyed`,
      once: true,
      events: [{ type: 'unitDies', owner: side, def: 'fortress' }],
      // His LAST fortress. A castle site lets a player raise a second one, so
      // losing the first is a setback rather than the end — without this
      // condition, razing the expansion would win the game outright.
      conditions: [
        { type: 'unitCountInRegion', region: 'ridge', owner: side, def: 'fortress', op: '<=', count: 0 },
      ],
      actions: [
        { type: 'message', text: `The last fortress of Player ${side + 1} has fallen!`, to: 'all' },
        { type: 'victory', player: side === 0 ? 1 : 0 },
      ],
    })
  }

  return {
    version: 2,
    name: 'dunhollow',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    fog: 'full',
    startLocations: [
      { x: BASE_A.x, z: BASE_A.z },
      { x: BASE_B.x, z: BASE_B.z },
    ],
    slotTeams: [0, 1, 0, 1],
    placed,
    doodads,
    regions,
    triggers,
    gameDef: DUNHOLLOW_DEF,
  }
}
