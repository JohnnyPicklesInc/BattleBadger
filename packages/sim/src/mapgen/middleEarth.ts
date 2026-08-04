import type { EntityDef, GameDef } from '../defs/schema.ts'
import type { MapRegion, PlacedDoodad, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { RulesetModule } from '../ruleset.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'
import { FACTION as HORDE } from './factions/horde.ts'
import { FORTIFICATIONS } from './factions/fortifications.ts'

// "The War of the Ring" — the StarCraft-era LOTR scenario map, rebuilt on the
// BFME rules layer. Eight realms laid out as one continent: Mordor in the
// south-east behind its mountain walls, Gondor across the Anduin to its left,
// Rohan's open horse country above Gondor, Isengard at the foot of the Misty
// Mountains, and Moria, Lothlórien, Dol Guldur and Erebor strung up the north.
//
// The loop it recreates:
//
//   * Every realm owns THREE spawn camps. Each camp musters a battalion wave
//     on its own clock, forever, for free. Armies are something you are given
//     and must spend, not something you buy.
//   * Kill every one of a team's camps to win. Nothing else ends the match —
//     killing their army costs them the field, not the game.
//   * A razed camp is gone for good. There is no plot under it and nothing to
//     rebuild; the map's production capacity only ever falls.
//   * Ages pass on a global clock and thicken every wave at once: soldiers and
//     archers, then pikemen, then horse, then siege — and for the Shadow,
//     ogres. No research, no build order. The age is the tech tree.
//   * NO KEEPS, and nothing to build. The age is the only escalation and the
//     camps are the only economy, so there is no fortress, no plot ring and no
//     resource to spend. A realm is its camps, its ground and its army.
//
// Everything here is map data. The one engine dependency the wave loop needs
// is that a trigger spawning a horde TICKET spawns the battalion (systems/
// triggers.ts) — otherwise waves arrive as loose soldiers with no formation,
// no veterancy and no command-point cost, which on a battalion map means the
// free army plays by different rules than the one the map hands you at tick 0.
//
// Design notes:
//   * ONE ENTITY DEF PER CAMP. `unitDies` filters by owner and def, not by
//     instance, so twenty-four camps need twenty-four defs for a death to say
//     WHICH camp fell. Same reason Cerebrate War has three Spire defs.
//   * The army cap is a gameplay rule, not just a safety valve. A camp holds
//     its wave while its owner is at cap, so a hoarded army starves your own
//     production and the map pushes you to spend it. It also keeps eight
//     realms of free troops under MAX_UNITS, which nothing else would.
//   * Waves are NOT ordered anywhere. They muster at the camp and wait — they
//     are the player's army, not creeps. That is the whole difference between
//     this and a MOBA lane.
//   * Slot order is by front, so every prefix of the lobby is a real matchup:
//     1v1 is Gondor vs Mordor, 2v2 adds Rohan vs Isengard, and so on.

const SIZE = 256

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_SAND = 3
const TEX_SNOW = 4
const TEX_FOREST = 5
const TEX_WATER = 6
const TEX_ASH = 7

// ---- the clock -----------------------------------------------------------
// Each age STACKS on the ones before it (the trigger stays on and its own
// `elapsed` condition opens), so an age's table below is what that age ADDS.
// Age 4 fires all four, which is what "more of everything" means.
const AGE_AT = [0, 300, 660, 1080] // seconds: 0:00 / 5:00 / 11:00 / 18:00
const WAVE_BASE = 48 // seconds between waves, + realm index to stagger them
/**
 * Entities one player may own before their camps stop mustering. Counts the
 * camps and towers too — it is a total, which is what keeps eight realms of
 * free battalions clear of MAX_UNITS, where spawnUnit throws rather than
 * degrading.
 *
 * 700 is set from measurement, not taste: eight realms at this cap settle at
 * ~5,400 soldiers in ~610 battalions and tick in 13 ms against the 100 ms
 * budget, using two thirds of the entity pool — the rest is room for a full
 * round of waves landing at once. It is also about as much as three camps can
 * actually produce inside twenty minutes, so the cap shapes the endgame
 * rather than the opening.
 */
const ARMY_CAP = 700

/**
 * Ground kept flat, walkable and clear of scenery around every camp. Big
 * enough to hold the camp, its towers and all four age musters, so no range,
 * river or bog can ever strand a realm's production on blocked terrain.
 */
const CLEARING = 20
const TOWER_R = 9 // watchtowers, on the cardinals
const MUSTER_R = 11 // age musters, on the diagonals between them

type Pt = { x: number; z: number }

const D = 0.7071067811865476 // unit diagonal; no trigonometry in the sim
/**
 * A fortified camp's curtain, as unit vectors off its facing: a great gate dead
 * ahead, two wall sections either side of it, and a tower on each shoulder.
 * Sines and cosines are written out because the sim bans trigonometry — see
 * scripts/check-sim-purity.mjs.
 */
const ARC: { c: number; s: number; def: string }[] = [
  { c: 1, s: 0, def: 'gate' }, // dead ahead
  { c: 0.8139, s: 0.581, def: 'wall' }, // ±36°
  { c: 0.5978, s: 0.8016, def: 'wall' }, // ±53°
  { c: 0.3248, s: 0.9458, def: 'wall-tower' }, // ±71°, the shoulders
]

/** The four diagonals, one per age, so ages never stack on one point. */
const MUSTER_DIRS: Pt[] = [
  { x: D, z: D },
  { x: -D, z: D },
  { x: -D, z: -D },
  { x: D, z: -D },
]

interface Camp {
  id: string // entity def id, unique per camp
  name: string
  at: Pt
  /**
   * A fortified camp: a curtain arc facing the enemy with towers and catapults
   * on it, instead of the three bare watchtowers every other camp gets. The two
   * fortresses of the Gondor–Mordor front (Osgiliath and Minas Morgul) are the
   * only ones, because that front is the map's 1v1 and it is supposed to be a
   * siege rather than a field battle.
   */
  fort?: boolean
  /** Flat ground carved around the camp. Defaults to CLEARING; smaller where a
   * camp sits deliberately close to terrain worth keeping (Mount Doom). */
  clearing?: number
}

interface Realm {
  slot: number
  name: string
  team: 0 | 1
  side: 'free' | 'shadow'
  /** Which way this realm's camps and armies look — at the enemy. Unit length. */
  facing: Pt
  camps: Camp[]
  /** Battalion tickets this realm's camps ADD at each age. */
  waves: string[][]
}

// ---- rosters -------------------------------------------------------------
// The Free Peoples tech into horse and siege; the Shadow techs into numbers
// and ogres. Neither is the other's mirror, and no realm is another's mirror
// either — Rohan fields horse an age early and Erebor never fields it at all.

const REALMS: Realm[] = [
  {
    slot: 0, name: 'Gondor', team: 0, side: 'free',
    facing: { x: 1, z: 0 },
    camps: [
      { id: 'muster-minas-tirith', name: 'Minas Tirith', at: { x: 140, z: 206 } },
      // ACROSS the Anduin, with the Pelennor — forty tiles of open field — between
      // it and Minas Tirith. Gondor's ground is wide on purpose: its three camps
      // used to sit close enough to cover each other with tower fire, which is
      // most of why it beat Mordor from a standing start.
      { id: 'muster-osgiliath', name: 'Osgiliath', at: { x: 180, z: 198 }, fort: true },
      { id: 'muster-pelargir', name: 'Pelargir', at: { x: 139, z: 233 } },
    ],
    // The tower of the west: the siege realm. Catapults an age early, and two.
    // Horse from the second age — Gondor's answer to a shadow that simply
    // out-bodies it, and the reason Mordor techs into pikes at the same age.
    waves: [
      ['h-swordsmen', 'h-archers'],
      ['h-swordsmen', 'h-spearmen', 'h-riders'],
      ['h-catapult'],
      ['h-swordsmen', 'h-archers', 'h-riders', 'h-catapult'],
    ],
  },
  {
    slot: 1, name: 'Mordor', team: 1, side: 'shadow',
    facing: { x: -1, z: 0 },
    // FOUR camps, alone on the map. The black land is bigger than anyone else's
    // and it is meant to out-produce them — the fourth is Mount Doom, out on
    // Gorgoroth where an attacker has to cross the whole plain to reach it.
    camps: [
      // North-east of the vale, not south of it: the home camp's opening army
      // forms up fifteen tiles toward the enemy, and from the old spot that put
      // Mordor's whole starting host on Minas Morgul's cliff edge.
      { id: 'muster-barad-dur', name: 'Barad-dûr', at: { x: 242, z: 196 } },
      // Raised above the vale on its own shelf, well BEHIND Cirith Ungol. Sited
      // by arithmetic, not by the map: two fortresses whose engines reach each
      // other are a siege line from tick zero, and the front is supposed to be
      // a march. 41 tiles from Osgiliath keeps every stone of each out of the
      // other's range (see the engines' placement below).
      { id: 'muster-minas-morgul', name: 'Minas Morgul', at: { x: 216, z: 216 }, fort: true },
      { id: 'muster-durthang', name: 'Durthang', at: { x: 204, z: 163 } },
      // Tucked against the mountain's skirt, so its clearing is cut short rather
      // than flattening Mount Doom itself.
      { id: 'muster-mount-doom', name: 'Mount Doom', at: { x: 224, z: 184 }, clearing: 13 },
    ],
    // Bodies, not quality: more swordsmen than Gondor at every age and almost
    // no bows to go with them — an orc horde wins by reaching you. Pikes at the
    // second age are the answer to Gondor's horse, and the trolls come at the
    // third, which is the age this realm is actually waiting for.
    waves: [
      ['h-orcs', 'h-orcs'],
      // ONE battalion of bows, and not before the second age. The shadow shoots
      // because it has to, not because it is good at it — everything else on
      // this line is a body walking at you.
      ['h-orcs', 'h-orcs', 'h-orc-pikemen', 'h-orc-archers'],
      ['h-orcs', 'h-ogre'],
      ['h-orcs', 'h-orcs', 'h-orc-archers', 'h-ogre'],
    ],
  },
  {
    slot: 2, name: 'Rohan', team: 0, side: 'free',
    facing: { x: -D, z: -D },
    camps: [
      { id: 'muster-edoras', name: 'Edoras', at: { x: 124, z: 157 } },
      { id: 'muster-helms-deep', name: "Helm's Deep", at: { x: 104, z: 148 } },
      { id: 'muster-aldburg', name: 'Aldburg', at: { x: 144, z: 164 } },
    ],
    // Horse country: riders an age early and doubled, at the cost of siege.
    waves: [
      ['h-swordsmen', 'h-archers'],
      ['h-riders'],
      ['h-riders', 'h-spearmen'],
      ['h-riders', 'h-swordsmen', 'h-archers'],
    ],
  },
  {
    slot: 3, name: 'Isengard', team: 1, side: 'shadow',
    facing: { x: D, z: D },
    camps: [
      { id: 'muster-orthanc', name: 'Orthanc', at: { x: 96, z: 116 } },
      { id: 'muster-nan-curunir', name: 'Nan Curunír', at: { x: 110, z: 132 } },
      { id: 'muster-dunland', name: 'Dunland', at: { x: 82, z: 136 } },
    ],
    // Bred for war: pikes early to blunt Rohan's horse, ogres early too.
    waves: [
      ['h-orcs', 'h-orc-pikemen'],
      ['h-orc-pikemen', 'h-orc-archers'],
      ['h-ogre'],
      ['h-orcs', 'h-orcs', 'h-ogre'],
    ],
  },
  {
    slot: 4, name: 'Lothlórien', team: 0, side: 'free',
    facing: { x: 1, z: 0 },
    camps: [
      { id: 'muster-caras-galadhon', name: 'Caras Galadhon', at: { x: 151, z: 90 } },
      { id: 'muster-nimrodel', name: 'Nimrodel', at: { x: 130, z: 98 } },
      { id: 'muster-egladil', name: 'Egladil', at: { x: 157, z: 110 } },
    ],
    // The Galadhrim: archers, and more archers. Fights on two fronts and has
    // the range to hold both.
    waves: [
      ['h-archers', 'h-swordsmen'],
      ['h-archers', 'h-spearmen'],
      ['h-archers'],
      ['h-archers', 'h-archers', 'h-riders'],
    ],
  },
  {
    slot: 5, name: 'Moria', team: 1, side: 'shadow',
    facing: { x: 1, z: 0 },
    camps: [
      { id: 'muster-khazad-dum', name: 'Khazad-dûm', at: { x: 101, z: 80 } },
      { id: 'muster-east-gate', name: 'The East-gate', at: { x: 120, z: 88 } },
      { id: 'muster-dimrill-dale', name: 'Dimrill Dale', at: { x: 112, z: 106 } },
    ],
    // The swarm. Most bodies on the map, worst quality, no ogres until last.
    waves: [
      ['h-orcs', 'h-orcs'],
      ['h-orcs', 'h-orc-archers'],
      ['h-orcs', 'h-orc-pikemen'],
      ['h-orcs', 'h-orcs', 'h-ogre'],
    ],
  },
  {
    slot: 6, name: 'Erebor', team: 0, side: 'free',
    facing: { x: -D, z: D },
    camps: [
      { id: 'muster-erebor', name: 'Erebor', at: { x: 224, z: 38 } },
      { id: 'muster-dale', name: 'Dale', at: { x: 210, z: 53 } },
      { id: 'muster-esgaroth', name: 'Esgaroth', at: { x: 200, z: 70 } },
    ],
    // Under the Mountain: heavy foot and siege, never a horse.
    waves: [
      ['h-swordsmen', 'h-archers'],
      ['h-swordsmen', 'h-spearmen'],
      ['h-swordsmen', 'h-spearmen'],
      ['h-swordsmen', 'h-archers', 'h-catapult'],
    ],
  },
  {
    slot: 7, name: 'Dol Guldur', team: 1, side: 'shadow',
    facing: { x: D, z: -D },
    camps: [
      { id: 'muster-dol-guldur', name: 'Dol Guldur', at: { x: 182, z: 64 } },
      { id: 'muster-amon-lanc', name: 'Amon Lanc', at: { x: 197, z: 51 } },
      { id: 'muster-narrows', name: 'The Narrows', at: { x: 176, z: 86 } },
    ],
    // The Necromancer's hold: archers under the trees, and the only realm on
    // the map whose waves can fly.
    waves: [
      ['h-orcs', 'h-orc-archers'],
      ['h-orc-archers', 'h-orc-pikemen'],
      ['h-fell-beasts'],
      ['h-orcs', 'h-orc-archers', 'h-ogre'],
    ],
  },
]

const ALL_CAMPS: { realm: Realm; camp: Camp; nth: number }[] = REALMS.flatMap((r) =>
  r.camps.map((camp, nth) => ({ realm: r, camp, nth })),
)

// ---- the rules -----------------------------------------------------------

/**
 * A muster camp: the thing this map is about. Tough, hits back, cannot be
 * rebuilt, and pays nothing — its output is the wave triggers, not income.
 * One def per camp so a death names which one fell.
 */
function campDef(realm: Realm, camp: Camp): EntityDef {
  const free = realm.side === 'free'
  return {
    id: camp.id,
    name: camp.name,
    kind: 'building',
    radius: 2.8,
    hp: 4200,
    armorType: 'structure',
    xpValue: 260,
    visual: { model: free ? 'gen:hall' : 'gen:orc-pit', scale: 1.25, tint: 'owner' },
    combat: { damage: 42, range: 12, acquire: 13, periodTicks: 14, damageType: 'arrow', hits: 'both' },
  }
}

/**
 * Scenery. Defined here rather than pulled from the neutral module because
 * doodads are filtered against the composed def at setup — a doodad the rules
 * do not define is silently dropped, trees and all.
 */
const SCENERY: EntityDef[] = [
  { id: 'pine', name: 'Pine', kind: 'doodad', radius: 0.5, hp: 0, visual: { model: 'gen:pine', tint: 'none' } },
  { id: 'oak', name: 'Oak', kind: 'doodad', radius: 0.6, hp: 0, visual: { model: 'gen:oak', tint: 'none' } },
  {
    id: 'mallorn', name: 'Mallorn', kind: 'doodad', radius: 0.7, hp: 0,
    visual: { model: 'gen:oak', scale: 1.6, tint: 'none' },
  },
  {
    id: 'dead-tree', name: 'Dead Tree', kind: 'doodad', radius: 0.5, hp: 0,
    visual: { model: 'gen:gloomtree', tint: 'none' },
  },
  { id: 'boulder', name: 'Boulder', kind: 'doodad', radius: 0.8, hp: 0, visual: { model: 'gen:boulder', tint: 'none' } },
]

const WAR_MODULE: RulesetModule = {
  id: 'war-of-the-ring',
  name: 'War of the Ring',
  entities: [...SCENERY, ...ALL_CAMPS.map(({ realm, camp }) => campDef(realm, camp))],
}

export const MIDDLE_EARTH_DEF: GameDef = composeDef({
  id: 'middle-earth',
  name: 'The War of the Ring',
  factions: [BADGERS, HORDE],
  // Walls, gates and wall-engines. The two fortresses of the Gondor–Mordor
  // front are built out of these rather than out of bespoke map entities.
  modules: [WAR_MODULE, FORTIFICATIONS],
  // Only a team's last muster camp ends the match. Keeps and armies are worth
  // nothing on their own.
  victory: { mode: 'triggersOnly' },
  // Nothing is for sale. The age is the tech tree and the camps are the
  // economy, so a resource count would only be a number that never moves.
  startAmount: 0,
})
// Free battalions fill command points nobody paid for. The cap is not a limit
// on this map — ARMY_CAP is — so lift it clear of an eight-realm muster rather
// than let the HUD read permanently maxed.
MIDDLE_EARTH_DEF.supplyHardCap = 400

// ---- deterministic noise -------------------------------------------------
// Whitelisted math only — see scripts/check-sim-purity.mjs for the ban list.
// The same seed lays out the same continent on every client.

function cellHash(seed: number, x: number, y: number): number {
  let h = seed | 0
  h = Math.imul(h ^ x, 0x27d4eb2f)
  h = (h ^ (h >>> 15)) | 0
  h = Math.imul(h ^ y, 0x165667b1)
  h = (h ^ (h >>> 13)) | 0
  return (h >>> 0) / 4294967296
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smooth(x - x0)
  const ty = smooth(y - y0)
  const a = cellHash(seed, x0, y0)
  const b = cellHash(seed, x0 + 1, y0)
  const c = cellHash(seed, x0, y0 + 1)
  const d = cellHash(seed, x0 + 1, y0 + 1)
  const ab = a + (b - a) * tx
  const cd = c + (d - c) * tx
  return ab + (cd - ab) * ty
}

// The single-call hypotenuse is not bit-exact across engines; purity bans it.
const dist = (a: Pt, b: Pt): number => {
  const dx = b.x - a.x
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dz * dz)
}

export function generateMiddleEarth(seed: number): RtsMapDoc {
  const n = SIZE * SIZE
  const idx = (x: number, z: number): number => z * SIZE + x
  const noiseSeed = (seed ^ 0x10ad) | 0

  // The continent starts as walkable grass at tier 0. Mountains are raised to
  // tier 3 and then explicitly blocked, so deriveTerrain draws crisp cliff
  // walls around them and nothing ever paths over a range.
  const cliffLevel = Array.from({ length: n }, () => 0)
  const ramp = Array.from({ length: n }, () => 0)
  const texture = Array.from({ length: n }, () => TEX_GRASS)
  const heightJitter = Array.from({ length: n }, () => 0)
  const blocked = Array.from({ length: n }, () => 0) // 1 = author-blocked (rock face, river)

  const disc = (c: Pt, r: number, fn: (i: number, d: number) => void): void => {
    const x0 = Math.max(0, Math.floor(c.x - r))
    const x1 = Math.min(SIZE - 1, Math.floor(c.x + r) + 1)
    const z0 = Math.max(0, Math.floor(c.z - r))
    const z1 = Math.min(SIZE - 1, Math.floor(c.z + r) + 1)
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - c.x
        const dz = z + 0.5 - c.z
        const d2 = dx * dx + dz * dz
        if (d2 > r * r) continue
        fn(idx(x, z), Math.sqrt(d2))
      }
    }
  }

  const band = (path: Pt[], half: number, fn: (i: number, d: number) => void): void => {
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k]
      const b = path[k + 1]
      const steps = Math.max(1, Math.floor(dist(a, b) * 2) + 1)
      for (let s = 0; s <= steps; s++) {
        const f = s / steps
        disc({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }, half, fn)
      }
    }
  }

  // A mountain range: tier-3 rock, blocked, with a wobbling edge so it never
  // reads as an extruded polyline.
  const range = (path: Pt[], half: number, snow: boolean): void => {
    band(path, half, (i, d) => {
      const x = i % SIZE
      const z = (i / SIZE) | 0
      const wob = valueNoise(noiseSeed ^ 0x5f, x * 0.06, z * 0.06) * 5 - 1.5
      if (d > half - wob) return
      cliffLevel[i] = 3
      blocked[i] = 1
      texture[i] = snow && d < half * 0.45 ? TEX_SNOW : TEX_ROCK
    })
  }

  const paint = (c: Pt, r: number, tex: number): void => {
    disc(c, r, (i) => {
      texture[i] = tex
    })
  }

  // Carve a pass back out of a range: walkable ground at tier 0 again.
  const pass = (c: Pt, r: number, tex: number): void => {
    disc(c, r, (i) => {
      cliffLevel[i] = 0
      blocked[i] = 0
      ramp[i] = 0
      texture[i] = tex
    })
  }

  const water = (path: Pt[], half: number): void => {
    band(path, half, (i) => {
      blocked[i] = 1
      texture[i] = TEX_WATER
      cliffLevel[i] = 0
    })
  }

  // ---- mountains ---------------------------------------------------------
  // The Misty Mountains run the length of the north and stop short of the
  // White Mountains — the gap between them is the Gap of Rohan, and it is the
  // only way west of the Anduin from Isengard to Rohan.
  const MISTY: Pt[] = [
    { x: 98, z: 2 },
    { x: 100, z: 38 },
    { x: 95, z: 68 },
    { x: 104, z: 100 },
    { x: 110, z: 132 },
    { x: 114, z: 150 },
  ]
  range(MISTY, 14, true)

  // Ered Nimrais, the White Mountains: Rohan above, Gondor below.
  const WHITE: Pt[] = [
    { x: 106, z: 177 },
    { x: 140, z: 170 },
    { x: 170, z: 176 },
    { x: 198, z: 187 },
  ]
  range(WHITE, 11, true)

  // Mordor's two walls meet at the Morannon in the north-west corner.
  range(
    [
      { x: 192, z: 150 },
      { x: 189, z: 182 },
      { x: 193, z: 216 },
      { x: 199, z: 246 },
    ],
    8,
    false,
  )
  range(
    [
      { x: 192, z: 150 },
      { x: 222, z: 146 },
      { x: 254, z: 151 },
    ],
    8,
    false,
  )

  // The Lonely Mountain and the Iron Hills.
  disc({ x: 228, z: 27 }, 14, (i, d) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = d < 6 ? TEX_SNOW : TEX_ROCK
  })
  disc({ x: 250, z: 52 }, 12, (i) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = TEX_ROCK
  })
  // Mount Doom, alone on the plain of Gorgoroth. Smaller than it was, and set
  // west of the camp that musters at its foot: a clearing flattens whatever it
  // covers, so the mountain has to stand clear of one by its own radius.
  disc({ x: 205, z: 188 }, 8, (i) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = TEX_ROCK
  })

  // ---- passes ------------------------------------------------------------
  pass({ x: 103, z: 82 }, 13, TEX_ROCK) // Moria's hall, opening east
  pass({ x: 99, z: 47 }, 8, TEX_ROCK) // the High Pass
  pass({ x: 150, z: 174 }, 10, TEX_DIRT) // the road from Rohan down to Gondor
  pass({ x: 193, z: 153 }, 8, TEX_ASH) // the Black Gate
  pass({ x: 190, z: 200 }, 6, TEX_ASH) // Cirith Ungol
  pass({ x: 96, z: 116 }, 12, TEX_ROCK) // Nan Curunír, Isengard's valley

  // ---- Mordor's floor ----------------------------------------------------
  disc({ x: 220, z: 200 }, 42, (i) => {
    if (blocked[i] === 1) return
    texture[i] = TEX_ASH
  })

  // ---- clearings ---------------------------------------------------------
  // Every camp is guaranteed a disc of flat, walkable, scenery-free ground
  // wide enough for its towers and all four age musters. Done BEFORE the
  // water so a clearing can never carve a ford through the Anduin — the river
  // is drawn last and wins, and any muster point it drowns walks itself back
  // to dry land (see `anchor` below).
  const clearings: Pt[] = ALL_CAMPS.map(({ camp }) => camp.at)
  for (const { camp } of ALL_CAMPS) {
    const c = camp.at
    disc(c, camp.clearing ?? CLEARING, (i) => {
      cliffLevel[i] = 0
      blocked[i] = 0
      ramp[i] = 0
      if (texture[i] === TEX_ROCK || texture[i] === TEX_SNOW) texture[i] = TEX_DIRT
    })
  }

  // ---- the Anduin --------------------------------------------------------
  // From the north down to the sea, dividing east from west the whole way.
  const ANDUIN: Pt[] = [
    { x: 170, z: 0 },
    { x: 167, z: 55 },
    { x: 162, z: 96 },
    { x: 165, z: 135 },
    { x: 171, z: 165 },
    { x: 167, z: 212 },
    { x: 163, z: 256 },
  ]
  water(ANDUIN, 4)

  // Standing water: the Long Lake under Erebor, and the Sea of Núrnen.
  disc({ x: 202, z: 78 }, 9, (i) => {
    blocked[i] = 1
    texture[i] = TEX_WATER
  })
  // The Sea of Núrnen, pushed into Mordor's south-east corner. It used to lap
  // the Morgul vale, and a lake is drawn AFTER the clearings — so it took a
  // bite out of the fortress's own ground and stood one of its towers in water.
  disc({ x: 230, z: 242 }, 12, (i) => {
    blocked[i] = 1
    texture[i] = TEX_WATER
  })
  // The Dead Marshes, scattered in front of the Black Gate — you pick your way
  // to the Morannon rather than march at it.
  disc({ x: 181, z: 158 }, 20, (i, d) => {
    if (blocked[i] === 1) return
    const x = i % SIZE
    const z = (i / SIZE) | 0
    const bog = valueNoise(noiseSeed ^ 0x9d, x * 0.14, z * 0.14)
    if (bog > 0.58 - d * 0.006) {
      blocked[i] = 1
      texture[i] = TEX_WATER
    } else texture[i] = TEX_FOREST
  })

  // ---- regional paint ----------------------------------------------------
  // The woods. Deliberately placed BETWEEN realms rather than on top of them:
  // forest is cover on the approach, and a wood centred on a camp would just
  // be a clearing with a fringe.
  const WOODS: { at: Pt; r: number }[] = [
    { at: { x: 150, z: 88 }, r: 19 }, // Lothlórien, around Caras Galadhon
    { at: { x: 193, z: 74 }, r: 38 }, // Mirkwood, the great wood of the east
    { at: { x: 122, z: 130 }, r: 19 }, // Fangorn, under the Mistys
    { at: { x: 131, z: 56 }, r: 22 }, // the Trollshaws
    { at: { x: 188, z: 176 }, r: 15 }, // Ithilien, north of the Osgiliath road
    { at: { x: 163, z: 176 }, r: 13 }, // the Drúadan forest
    { at: { x: 88, z: 168 }, r: 17 }, // the eaves of Dunland
  ]
  for (const w of WOODS) {
    disc(w.at, w.r, (i) => {
      if (blocked[i] === 1 || texture[i] === TEX_ASH) return
      texture[i] = TEX_FOREST
    })
  }
  paint({ x: 150, z: 218 }, 22, TEX_SAND) // the coast below Gondor
  // The Pelennor: the field between Minas Tirith and Osgiliath, kept as open
  // grass end to end. It is the widest clear ground on the map, and it is where
  // the 1v1 is decided — a wood across it would break the fight into skirmishes.
  disc({ x: 160, z: 202 }, 30, (i) => {
    if (blocked[i] === 1 || texture[i] === TEX_ASH) return
    texture[i] = TEX_GRASS
  })
  paint({ x: 132, z: 158 }, 26, TEX_GRASS) // the plains of Rohan, kept open

  // Three crossings, and only three. Cut LAST, after the marshes, the lakes
  // and the paint, so nothing can silently drown a ford and seal the two
  // halves of the map apart — and so their dirt keeps trees off the approach.
  for (const at of [
    { x: 163, z: 96 }, // the Nimrodel ford
    { x: 170, z: 165 }, // Cair Andros
    { x: 168, z: 199 }, // the bridge of Osgiliath
  ]) {
    disc(at, 7, (i) => {
      blocked[i] = 0
      texture[i] = TEX_DIRT
    })
  }

  // The camp itself always stands on dry land, whatever the river just did.
  for (const c of clearings) {
    disc(c, 7, (i) => {
      blocked[i] = 0
      if (texture[i] === TEX_WATER) texture[i] = TEX_DIRT
    })
  }

  // ---- the Morannon ------------------------------------------------------
  // Dry ground for the Black Gate to stand on. Cut AFTER the Dead Marshes for
  // the same reason the fords are: the bog is scattered by noise and would
  // otherwise swallow half the gate line, leaving masonry standing in a swamp.
  disc({ x: 193, z: 153 }, 9, (i) => {
    blocked[i] = 0
    cliffLevel[i] = 0
    texture[i] = TEX_ASH
  })

  // ---- the Morgul shelf --------------------------------------------------
  // Minas Morgul stands a tier above the vale. A raised disc is walled by its
  // own rim everywhere deriveTerrain finds a lower neighbour, so the ONE ramp
  // is the only way up — an attacker who breaks into the vale still has to
  // climb, under the towers, on a front the width of the ramp.
  const MORGUL: Pt = { x: 216, z: 216 }
  // 13, not 15: the rim of a raised disc is unwalkable, so the shelf has to
  // stop short of anything else's ground — at 15 it put Barad-dûr's own
  // watchtower on a cliff edge.
  disc(MORGUL, 13, (i) => {
    if (blocked[i] === 1) return
    cliffLevel[i] = 1
  })
  // The ramp faces Cirith Ungol — the way Gondor comes. Wide enough for a
  // battalion in line and no wider.
  band(
    [
      { x: MORGUL.x - 19, z: MORGUL.z },
      { x: MORGUL.x - 9, z: MORGUL.z },
    ],
    4,
    (i) => {
      if (blocked[i] === 1) return
      ramp[i] = 1
      texture[i] = TEX_ASH
    },
  )

  // ---- relief ------------------------------------------------------------
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = idx(x, z)
      if (cliffLevel[i] === 3) {
        const peak =
          1.2 + valueNoise(noiseSeed, x * 0.09, z * 0.09) * 3.4 + valueNoise(noiseSeed ^ 7, x * 0.3, z * 0.3) * 0.9
        heightJitter[i] = peak
        // Snow caps the high ground. Decided HERE rather than while carving the
        // range: a range is drawn as an overlapping run of discs, so distance
        // from any one of them says nothing about how high the cell ended up.
        if (peak > 3.4 && texture[i] === TEX_ROCK) texture[i] = TEX_SNOW
        continue
      }
      if (texture[i] === TEX_WATER) {
        heightJitter[i] = -0.85
        continue
      }
      let h = valueNoise(noiseSeed, x * 0.07, z * 0.07) * 0.7 + valueNoise(noiseSeed ^ 13, x * 0.26, z * 0.26) * 0.25
      for (const c of clearings) {
        const d = dist({ x: x + 0.5, z: z + 0.5 }, c)
        if (d < CLEARING + 3) h *= smooth(Math.max(0, Math.min(1, (d - 5) / (CLEARING - 4))))
      }
      heightJitter[i] = h
    }
  }

  const walkable = blocked.map((b) => (b === 1 ? 0 : 1))

  // ---- scenery -----------------------------------------------------------
  // Forest is thick enough to shape a fight and thin enough to walk through.
  // Nothing is placed inside a clearing, so no camp is ever walled in by trees.
  const doodads: PlacedDoodad[] = []
  // Scenery keeps clear of the musters (MUSTER_R plus a battalion's own
  // footprint) but is allowed inside the outer clearing, so a camp sits in a
  // glade rather than a bald circle.
  const SCENERY_KEEPOUT = MUSTER_R + 6
  const nearCamp = (x: number, z: number): boolean => clearings.some((c) => dist({ x, z }, c) < SCENERY_KEEPOUT)

  for (let z = 3; z < SIZE - 3; z++) {
    for (let x = 3; x < SIZE - 3; x++) {
      const i = idx(x, z)
      if (walkable[i] !== 1) continue
      const tex = texture[i]
      const wx = x + 0.5
      const wz = z + 0.5
      if (nearCamp(wx, wz)) continue
      const h = cellHash(noiseSeed ^ 0x2b, x, z)
      if (tex === TEX_FOREST) {
        if (h > 0.26) continue
        // Lothlórien's wood is mallorn; everywhere else is pine and oak.
        const golden = dist({ x: wx, z: wz }, { x: 150, z: 88 }) < 20
        const def = golden ? 'mallorn' : h < 0.09 ? 'pine' : 'oak'
        doodads.push({ def, x: wx, z: wz, rot: ((x * 7 + z * 3) % 16) / 16, scale: 0.85 + h * 2.2 })
      } else if (tex === TEX_ASH) {
        if (h > 0.05) continue
        doodads.push({ def: 'dead-tree', x: wx, z: wz, rot: ((x * 5 + z * 11) % 16) / 16, scale: 0.8 + h * 4 })
      } else if (tex === TEX_ROCK || tex === TEX_SNOW) {
        if (h > 0.06) continue
        doodads.push({ def: 'boulder', x: wx, z: wz, rot: ((x * 3 + z * 13) % 16) / 16, scale: 0.7 + h * 8 })
      } else if (tex === TEX_GRASS) {
        // A thin scatter over open country, so the plains read as land rather
        // than as a green sheet — but sparse enough that horse still runs.
        if (h > 0.012) continue
        const def = h < 0.005 ? 'boulder' : 'oak'
        doodads.push({ def, x: wx, z: wz, rot: ((x * 11 + z * 5) % 16) / 16, scale: 0.8 + h * 20 })
      }
    }
  }

  // ---- entities ----------------------------------------------------------
  // Everything below sits inside some camp's clearing, which was carved
  // walkable above — so nothing here can land on a cliff, in the river or in
  // a bog. `nudge` is the one exception handler: the river is drawn after the
  // clearings, so a muster point on a bank walks itself back toward its camp
  // until it finds dry ground.
  const nudge = (from: Pt, to: Pt): Pt => {
    for (let step = 0; step <= 10; step++) {
      const f = step / 10
      const p = { x: from.x + (to.x - from.x) * (1 - f), z: from.z + (to.z - from.z) * (1 - f) }
      const cx = Math.floor(p.x)
      const cz = Math.floor(p.z)
      if (cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE) continue
      if (blocked[idx(cx, cz)] === 0) return p
    }
    return to
  }

  const placed: PlacedEntity[] = []
  const startLocations: Pt[] = []
  const slotTeams: number[] = []
  // Where each camp's four ages form up, resolved once and shared with the
  // wave triggers below so placement and spawning can never disagree.
  const musters = new Map<string, Pt[]>()

  for (const r of REALMS) {
    slotTeams[r.slot] = r.team
    const home = r.camps[0].at
    startLocations[r.slot] = nudge(home, { x: home.x - r.facing.x * 14, z: home.z - r.facing.z * 14 })

    for (const c of r.camps) {
      placed.push({ def: c.id, owner: r.slot, x: c.at.x, z: c.at.z, facing: r.facing })

      // "The spawns were well defended" — three towers apiece on the cardinals,
      // two facing the enemy and one covering a flank, so a camp has a front.
      const perp = { x: -r.facing.z, z: r.facing.x }
      const towers: Pt[] = [
        { x: c.at.x + r.facing.x * TOWER_R, z: c.at.z + r.facing.z * TOWER_R },
        { x: c.at.x + perp.x * TOWER_R, z: c.at.z + perp.z * TOWER_R },
        { x: c.at.x - perp.x * TOWER_R, z: c.at.z - perp.z * TOWER_R },
      ]
      for (const t of towers) {
        const p = nudge(c.at, t)
        placed.push({ def: 'watchtower', owner: r.slot, x: p.x, z: p.z })
      }

      // A fortified camp adds a curtain across its front: wall sections on an
      // arc with a gate at the middle, a wall-tower at each shoulder and
      // catapults behind the stone. Everything sits OUTSIDE the age musters
      // (MUSTER_R) and inside the clearing, so the fort never walls a camp off
      // from its own production.
      if (c.fort) {
        const FRONT = MUSTER_R + 4 // the arc, clear of the musters
        // The curtain, placed by rotating `facing` through a table of unit
        // vectors. Written out rather than computed: trigonometry is banned in
        // the sim (it is not bit-exact across engines), which is the same reason
        // the muster diagonals are a hand-written constant.
        for (const arc of ARC) {
          for (const sgn of arc.s === 0 ? [1] : [1, -1]) {
            const sn = arc.s * sgn
            const dir = { x: r.facing.x * arc.c - r.facing.z * sn, z: r.facing.x * sn + r.facing.z * arc.c }
            const at = nudge(c.at, { x: c.at.x + dir.x * FRONT, z: c.at.z + dir.z * FRONT })
            placed.push({ def: arc.def, owner: r.slot, x: at.x, z: at.z, facing: dir })
          }
        }
        // Engines BEHIND the camp, not in front of it. A wall-catapult ranges 30
        // — enough to cover its own curtain (15 out) and the ground an attacker
        // forms up on, and, set back like this, not enough to reach the enemy
        // fortress across the front. Put them forward instead and the two forts
        // shell each other from tick zero, which turns the march across Ithilien
        // into a stalemate nobody ordered.
        for (const sgn of [1, -1]) {
          const at = nudge(c.at, {
            x: c.at.x - r.facing.x * 9 + perp.x * sgn * 5,
            z: c.at.z - r.facing.z * 9 + perp.z * sgn * 5,
          })
          placed.push({ def: 'wall-catapult', owner: r.slot, x: at.x, z: at.z, facing: r.facing })
        }
      }

      // The four age musters go on the diagonals, between the towers: 7.9
      // apart from the nearest one, which clears a battalion's footprint.
      musters.set(
        c.id,
        MUSTER_DIRS.map((d) => nudge(c.at, { x: c.at.x + d.x * MUSTER_R, z: c.at.z + d.z * MUSTER_R })),
      )
    }

    // The opening army: five battalions and a hero, drawn up at the home camp
    // facing the enemy.
    const army =
      r.side === 'free'
        ? ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-archers', 'h-riders', 'h-captain']
        : ['h-orcs', 'h-orcs', 'h-orc-pikemen', 'h-orc-archers', 'h-orc-archers', 'h-warg-chief']
    const perp = { x: -r.facing.z, z: r.facing.x }
    army.forEach((def, k) => {
      const want = {
        x: home.x + r.facing.x * 15 + perp.x * (k - 2.5) * 4.5,
        z: home.z + r.facing.z * 15 + perp.z * (k - 2.5) * 4.5,
      }
      const p = nudge(home, want)
      placed.push({ def, owner: r.slot, x: p.x, z: p.z, facing: r.facing })
    })
  }

  // ---- the Black Gate ----------------------------------------------------
  // Mordor's only northern door, and the reason the Morannon is a place rather
  // than a gap. The wall runs north-south across the pass with the gate at its
  // middle: Mordor's own hordes walk out through it, and an attacker coming off
  // the Dead Marshes arrives to find it shut and has to break it.
  //
  // Owned by Mordor's slot, like the camps — it is terrain that belongs to a
  // realm, not neutral scenery, and it dies to siege like anything else.
  const MORANNON: Pt = { x: 193, z: 153 }
  const ACROSS = { x: 0, z: 1 } // sections stack north-south
  for (const dz of [-8, -5, 5, 8]) {
    const at = nudge(MORANNON, { x: MORANNON.x, z: MORANNON.z + dz })
    placed.push({ def: 'wall', owner: 1, x: at.x, z: at.z, facing: ACROSS })
  }
  placed.push({ def: 'gate', owner: 1, x: MORANNON.x, z: MORANNON.z, facing: ACROSS })
  for (const dz of [-11, 11]) {
    const at = nudge(MORANNON, { x: MORANNON.x, z: MORANNON.z + dz })
    placed.push({ def: 'wall-tower', owner: 1, x: at.x, z: at.z, facing: ACROSS })
  }
  // Two engines behind the gate, inside Mordor, covering the ground an army
  // has to stand on while it works at the door.
  for (const dz of [-6, 6]) {
    const at = nudge(MORANNON, { x: MORANNON.x + 11, z: MORANNON.z + dz })
    placed.push({ def: 'wall-catapult', owner: 1, x: at.x, z: at.z, facing: { x: -1, z: 0 } })
  }

  // ---- regions -----------------------------------------------------------
  // One, covering everything. Camp waves and the win check both ask questions
  // about the whole map ("how much does this player own", "has this realm any
  // camp left"), and the region cap is 30 — spending it on twenty-four camp
  // boxes would buy nothing that a per-camp entity def does not already give.
  const regions: MapRegion[] = [{ id: 'world', name: 'Middle-earth', x0: 0, z0: 0, x1: SIZE, z1: SIZE }]

  // ---- triggers ----------------------------------------------------------
  const triggers: TriggerDef[] = []

  for (const { realm, camp, nth } of ALL_CAMPS) {
    // Every camp gets its own period, so no two ever stay in phase. Realms
    // drift apart from each other (+slot) and a realm's own three camps drift
    // apart from each other (+7 each). Without that, a realm's entire
    // production — three camps times four ages — landed on one tick, which
    // both looks like a glitch and makes the army cap overshoot by a whole
    // round instead of a single camp's worth.
    const period = WAVE_BASE + realm.slot + nth * 7
    realm.waves.forEach((tickets, age) => {
      if (tickets.length === 0) return
      // Each age musters on its own diagonal, so four ages firing on the same
      // tick don't pile four battalions onto one point.
      const at = musters.get(camp.id)![age]
      triggers.push({
        id: `wave-${camp.id}-a${age}`,
        name: `${camp.name} — age ${age + 1} muster`,
        events: [{ type: 'timer', seconds: period, periodic: true }],
        conditions: [
          ...(age === 0 ? [] : [{ type: 'elapsed' as const, seconds: AGE_AT[age] }]),
          // Hold the wave while this realm is at its cap. A hoarded army
          // starves its own production — spend it or stop growing.
          { type: 'unitCountInRegion', region: 'world', owner: realm.slot, op: '<=', count: ARMY_CAP },
        ],
        actions: tickets.map((def) => ({
          type: 'spawnUnits' as const,
          def,
          owner: realm.slot,
          count: 1,
          at: { x: at.x, z: at.z },
          facing: realm.facing,
        })),
      })
    })

    // A razed camp stops mustering, for good — there is no plot under it and
    // nothing anyone can raise in its place.
    triggers.push({
      id: `fallen-${camp.id}`,
      name: `${camp.name} falls`,
      once: true,
      events: [{ type: 'unitDies', owner: realm.slot, def: camp.id }],
      conditions: [],
      actions: [
        ...realm.waves.map((_, age) => ({
          type: 'setTrigger' as const,
          trigger: `wave-${camp.id}-a${age}`,
          on: false,
        })),
        { type: 'message', text: `${camp.name} has fallen — ${realm.name} musters there no more.`, to: 'all' },
      ],
    })
  }

  // Win: a team is out when it has no muster camp anywhere on the map. Every
  // camp of the team is its own def, so this is one condition per camp — and
  // a realm nobody is playing contributes zero of them, which reads as
  // "already gone" and is exactly right.
  for (const team of [0, 1] as const) {
    const ours = ALL_CAMPS.filter(({ realm }) => realm.team === team)
    triggers.push({
      id: `team-${team}-broken`,
      name: `${team === 0 ? 'The Free Peoples' : 'The Shadow'} has no camps left`,
      once: true,
      events: ours.map(({ realm, camp }) => ({ type: 'unitDies' as const, owner: realm.slot, def: camp.id })),
      conditions: ours.map(({ realm, camp }) => ({
        type: 'unitCountInRegion' as const,
        region: 'world',
        owner: realm.slot,
        def: camp.id,
        op: '<=' as const,
        count: 0,
      })),
      actions: [
        {
          type: 'message',
          text:
            team === 0
              ? 'The last camp of the Free Peoples is thrown down. The Shadow covers all.'
              : 'The last camp of the Shadow is broken. The War of the Ring is won.',
          to: 'all',
        },
        { type: 'victory', player: team === 0 ? 1 : 0 },
      ],
    })
  }

  // The passing of the ages, announced to everyone.
  const AGE_NAMES = ['', 'The muster of the realms', 'The riding of the hosts', 'The last debate']
  for (let age = 1; age < AGE_AT.length; age++) {
    triggers.push({
      id: `age-${age}`,
      name: `Age ${age + 1} begins`,
      once: true,
      events: [{ type: 'timer', seconds: AGE_AT[age] }],
      conditions: [],
      actions: [{ type: 'message', text: `${AGE_NAMES[age]} — every camp musters more.`, to: 'all' }],
    })
  }

  triggers.push({
    id: 'intro',
    name: 'intro',
    once: true,
    events: [{ type: 'mapInit' }],
    conditions: [],
    actions: [
      {
        type: 'message',
        text: 'Your camps muster armies on their own. Throw down every camp the enemy holds — nothing else wins.',
        to: 'all',
      },
      ...REALMS.map((r) => ({ type: 'panCamera' as const, player: r.slot, x: r.camps[0].at.x, z: r.camps[0].at.z })),
    ],
  })

  return {
    version: 2,
    name: 'middle-earth',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    fog: 'full',
    // An EMPTY roster, which is not the same as no roster: absent means "any
    // faction whose rules fit", and this map must seat none at all. The realms
    // are the map — Gondor is Gondor because of the camps, army and ground it
    // was authored with, and its muster tables name that side's battalions by
    // id, so swapping a race in would leave Gondor's camps spawning orcs.
    // What you pick here is a realm, not a race; the lobby drops the race
    // control entirely and names the start positions instead.
    races: [],
    startLocations,
    startNames: REALMS.map((r) => r.name),
    slotTeams,
    regions,
    triggers,
    placed,
    doodads,
    gameDef: MIDDLE_EARTH_DEF,
  }
}
