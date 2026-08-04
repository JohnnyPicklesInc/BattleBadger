import type { EntityDef, GameDef } from '../defs/schema.ts'
import type { MapRegion, PlacedDoodad, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { RulesetModule } from '../ruleset.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'
import { FACTION as HORDE } from './factions/horde.ts'
import { FORTIFICATIONS } from './factions/fortifications.ts'

// "The War of the Ring" — the StarCraft-era LOTR scenario map, rebuilt on the
// BFME rules layer. EIGHT powers on one continent, each holding scattered
// ground rather than one corner:
//
//   Gondor     Minas Tirith, Osgiliath, Pelargir, Dol Amroth — heavily walled
//   Mordor     Barad-dûr, Minas Morgul, Durthang, Mount Doom, and Dol Guldur
//              four-fifths of the map north, fighting a second war in Mirkwood
//   Rohan      Edoras, Helm's Deep, Aldburg — horse from the first minute
//   Isengard   Orthanc, Nan Curunír, Dunland — walled, and the only roster
//              that fields men and orcs in the same battle line
//   The Elves  Rivendell, Lindon, Lothlórien, Thranduil's Halls — three of the
//              four deliberately small; archers that outrange everything
//   Harad      Umbar, Harondor, Near Harad — the south, which is to say BEHIND
//              Gondor; Umbar sits across the river mouth from Dol Amroth
//   The Dwarves Erebor, the Iron Hills, Lake-town, and the Blue Mountains alone
//              at the far west edge — heavy foot, and slow to reach anywhere
//   Moria      Khazad-dûm, the East-gate, Dimrill Dale — cut into the Misty
//              Mountains between Isengard and the elven havens; pure swarm
//
// The loop it recreates:
//
//   * Every power owns three to five muster camps. Each musters a battalion
//     wave on its own clock, forever, for free. Armies are something you are
//     given and must spend, not something you buy.
//   * From the THIRD age a power's capital musters its heroes too — one place,
//     one clock, so a hero stays something you go and collect.
//   * Kill every one of a team's camps to win. Nothing else ends the match —
//     killing their army costs them the field, not the game.
//   * A camp pays its owner every time it musters — so a power's income IS
//     its camps, and the side losing ground is the side that can least afford
//     to take it back. At the army cap the wave is held but the tithe is not:
//     you stop growing, you do not stop earning.
//   * A razed camp leaves its ground. Every camp and every tower stands on a
//     pad that survives it, so both can be bought back — and the map's few
//     chokepoints carry neutral pads anyone holding them may raise a tower on.
//     That is the only ground a player may add anything to.
//   * Ages pass on a global clock and thicken every wave at once: soldiers and
//     archers, then pikemen, then horse, then siege — and for the Shadow,
//     ogres. No research, no build order. The age is the tech tree.
//   * NO KEEPS and no build tree. The age is the only escalation — what money
//     buys is what was already there: a tower back on its pad, a camp back on
//     its ruins, a tower on a crossing you are holding. Nothing else.
//
// Everything here is map data. The one engine dependency the wave loop needs
// is that a trigger spawning a horde TICKET spawns the battalion (systems/
// triggers.ts) — otherwise waves arrive as loose soldiers with no formation,
// no veterancy and no command-point cost, which on a battalion map means the
// free army plays by different rules than the one the map hands you at tick 0.
//
// Design notes:
//   * ONE ENTITY DEF PER CAMP. `unitDies` filters by owner and def, not by
//     instance, so twenty-nine camps need twenty-nine defs for a death to say
//     WHICH camp fell. Same reason Cerebrate War has three Spire defs.
//   * The army cap is a gameplay rule, not just a safety valve. A camp holds
//     its wave while its owner is at cap, so a hoarded army starves your own
//     production and the map pushes you to spend it. It also keeps eight
//     realms of free troops under MAX_UNITS, which nothing else would.
//   * Waves are NOT ordered anywhere. They muster at the camp and wait — they
//     are the player's army, not creeps. That is the whole difference between
//     this and a MOBA lane.
//   * Slot order is by front, so a small lobby is still a real matchup: 1v1 is
//     Gondor vs Mordor across the Anduin, 2v2 adds Rohan against Isengard at
//     the Gap, 3v3 the Elves against Harad, 4v4 the Dwarves against Moria.
//     Four powers a side, and the Shadow holds the extra camps.

// Landscape, and half again as big as it was. Two things forced the size: two
// fortified camps need ~40 tiles between them or their curtains interleave,
// and Barad-dûr's ring used to run off the east edge of the map entirely.
// Wider than tall because Middle-earth is — Lindon to the Iron Hills is a
// longer journey than the North Downs to Harad.
const COLS = 480
const ROWS = 384

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
/**
 * What a razed camp costs to raise again, and how long it stands half-built.
 * Priced against the muster income below: about three minutes of a healthy
 * four-camp realm's whole take, so losing one is a real wound and rebuilding
 * it under pressure is a decision rather than a formality.
 */
const CAMP_COST = 3000
/** What a claimable hold costs to raise, and what its militia is worth. */
const HOLD_COST = 900
const HOLD_PAY = 25
const CAMP_BUILD_TICKS = 600 // 60 s
/** Resources a single camp's muster pays its owner, per wave trigger. */
const MUSTER_PAY = 60

const CLEARING = 20
const TOWER_R = 9 // watchtowers, on the cardinals
const MUSTER_R = 11 // age musters, on the diagonals between them

type Pt = { x: number; z: number }

const D = 0.7071067811865476 // unit diagonal; no trigonometry in the sim
/**
 * The curtain, as a COMPLETE ring rather than an arc.
 *
 * The previous version placed seven pieces on a 15-tile arc — a gate, four
 * wall sections and two towers — spaced 9.4 tiles apart for a wall three tiles
 * wide. It read as a fortress in a screenshot and was two thirds holes in
 * practice: an army walked between the stones without touching them.
 *
 * A ring is built by repeatedly rotating a unit vector by one step, because
 * the sim bans trigonometry (not bit-exact across engines — see
 * scripts/check-sim-purity.mjs) and a 32-entry table of hand-written sines is
 * worse than two constants and a multiply. The error accumulated over 32
 * rotations is deterministic and identical on every client, which is the only
 * property that matters here.
 */
const RING_SLOTS = 32
const RING_COS = 0.9807852804032304 // cos(2π/32)
const RING_SIN = 0.19509032201612825 // sin(2π/32)
/**
 * Ring radius. RING_SLOTS pieces at this radius sit 2.95 tiles apart, and a
 * wall section is 3.0 wide — so the stones touch, which is the entire point.
 * Outside the age musters (MUSTER_R) and inside the cleared ground (CLEARING).
 */
const RING_R = 15

/** What stands in each slot of the ring, by index from dead ahead. */
function ringPiece(slot: number): string | null {
  if (slot === 0) return 'gate'
  // The gate is 8.4 wide and swallows its neighbours; anything placed there
  // would be inside the gatehouse.
  if (slot === 1 || slot === RING_SLOTS - 1) return null
  // Towers on both flanks and at the back.
  if (slot === 8 || slot === 16 || slot === 24) return 'wall-tower'
  // Two automatic posterns at the rear quarters. Without them a sealed ring
  // traps its own garrison behind a great gate that starts barred.
  if (slot === 12 || slot === 20) return 'sally-port'
  return 'wall'
}

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
  /**
   * Which way this camp looks, when that is not the realm's own front. A power
   * with two wars needs it: Dol Guldur faces the Elves in the north while the
   * rest of Mordor faces Gondor, and Dol Amroth faces the sea Umbar comes from
   * rather than east at Mordor. Unit length.
   */
  face?: Pt
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
  /**
   * Heroes, mustered from the CAPITAL only and only from the third age.
   *
   * Capital-only because every camp is on the same clock: put a hero in the
   * shared wave table and a four-camp realm fields four of them a minute, and
   * within an age the map is heroes with an escort of soldiers rather than an
   * army with a hero in it. One a minute, from one place, keeps a hero the
   * thing you go and collect.
   */
  heroes: string[]
  /** The host it opens with, drawn up at the capital. */
  army: string[]
}

// ---- the powers ----------------------------------------------------------
// No two of these share a wave table, and none is another's mirror. Rohan
// opens on horse and never builds an engine; the Dwarves never field a rider;
// the Elves win by being allowed to stand still; Isengard takes what works
// from everybody. Age tables ADD to the ones before them.

const REALMS: Realm[] = [
  {
    slot: 0, name: 'Gondor', team: 0, side: 'free',
    facing: { x: 1, z: 0 },
    // The most fortified realm on the map, and the widest. Four camps strung
    // from Belfalas to the far bank of the Anduin: Gondor cannot hold all of
    // it, which is the point — it has more to lose than anyone.
    camps: [
      { id: 'muster-minas-tirith', name: 'Minas Tirith', at: { x: 200, z: 292 }, fort: true },
      // ACROSS the Anduin, with the Pelennor — forty tiles of open field — between
      // it and Minas Tirith. Gondor's ground is wide on purpose: its three camps
      // used to sit close enough to cover each other with tower fire, which is
      // most of why it beat Mordor from a standing start.
      { id: 'muster-osgiliath', name: 'Osgiliath', at: { x: 254, z: 282 }, fort: true },
      { id: 'muster-pelargir', name: 'Pelargir', at: { x: 206, z: 336 } },
      // Belfalas, on the west coast — and the only thing between Umbar's landing
      // and the back of Gondor. Facing south rather than east: its war is with
      // the Corsairs, not with Mordor.
      { id: 'muster-dol-amroth', name: 'Dol Amroth', at: { x: 122, z: 322 }, face: { x: 0, z: 1 } },
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
    heroes: ['h-gondor-captain'],
    army: ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-archers', 'h-riders', 'h-gondor-captain'],
  },
  {
    slot: 1, name: 'Mordor', team: 1, side: 'shadow',
    facing: { x: -1, z: 0 },
    // FIVE camps, and the only realm with a second front of its own: Dol Guldur
    // sits four-fifths of the map north of Barad-dûr, in Mirkwood, where it
    // fights the Elves and the Dwarves while the Black Gate fights Gondor. The
    // black land is meant to out-produce everyone; what it cannot do is be in
    // two places at once.
    camps: [
      // North-east of the vale, not south of it: the home camp's opening army
      // forms up fifteen tiles toward the enemy, and from the old spot that put
      // Mordor's whole starting host on Minas Morgul's cliff edge.
      { id: 'muster-barad-dur', name: 'Barad-dûr', at: { x: 392, z: 278 }, fort: true },
      // Raised above the vale on its own shelf, well BEHIND Cirith Ungol. Sited
      // by arithmetic, not by the map: two fortresses whose engines reach each
      // other are a siege line from tick zero, and the front is supposed to be
      // a march. 41 tiles from Osgiliath keeps every stone of each out of the
      // other's range (see the engines' placement below).
      { id: 'muster-minas-morgul', name: 'Minas Morgul', at: { x: 300, z: 280 }, fort: true },
      { id: 'muster-durthang', name: 'Durthang', at: { x: 315, z: 238 } },
      // Tucked against the mountain's skirt, so its clearing is cut short rather
      // than flattening Mount Doom itself.
      { id: 'muster-mount-doom', name: 'Mount Doom', at: { x: 350, z: 300 } },
      // The northern war, in southern Mirkwood. Faces north-west at the wood
      // the Elves hold rather than back at Gondor.
      { id: 'muster-dol-guldur', name: 'Dol Guldur', at: { x: 337, z: 162 }, face: { x: -D, z: -D } },
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
    heroes: ['h-black-captain'],
    army: ['h-orcs', 'h-orcs', 'h-orc-pikemen', 'h-orc-archers', 'h-orc-archers', 'h-black-captain'],
  },
  {
    slot: 2, name: 'Rohan', team: 0, side: 'free',
    facing: { x: -D, z: -D },
    camps: [
      { id: 'muster-edoras', name: 'Edoras', at: { x: 172, z: 236 } },
      { id: 'muster-helms-deep', name: "Helm's Deep", at: { x: 132, z: 232 } },
      { id: 'muster-aldburg', name: 'Aldburg', at: { x: 212, z: 230 } },
    ],
    // Horse from the first minute and horse forever. No siege, thin infantry,
    // and the only realm whose opening wave can already run something down —
    // Rohan is fast or it is nothing.
    waves: [
      ['h-riders', 'h-riders'],
      ['h-riders', 'h-archers'],
      ['h-riders'],
      ['h-riders', 'h-riders', 'h-swordsmen'],
    ],
    heroes: ['h-mark-marshal'],
    army: ['h-riders', 'h-riders', 'h-riders', 'h-archers', 'h-swordsmen', 'h-mark-marshal'],
  },
  {
    slot: 3, name: 'Isengard', team: 1, side: 'shadow',
    facing: { x: D, z: D },
    // Fortified like the two great powers, because Isengard is a fortress with
    // a realm attached rather than the other way round.
    camps: [
      { id: 'muster-orthanc', name: 'Orthanc', at: { x: 150, z: 190 }, fort: true },
      { id: 'muster-nan-curunir', name: 'Nan Curunír', at: { x: 192, z: 204 }, fort: true },
      { id: 'muster-dunland', name: 'Dunland', at: { x: 140, z: 226 } },
    ],
    // The only roster on the map that fields BOTH: men and orcs in the same
    // battle line, swords and pikes beside orc bows, horse and engines. Saruman
    // has no tradition to keep — he took what worked from everybody.
    waves: [
      ['h-orcs', 'h-swordsmen'],
      ['h-orc-archers', 'h-spearmen'],
      ['h-riders'],
      ['h-orcs', 'h-swordsmen', 'h-catapult'],
    ],
    // Both kinds of hero, for the same reason.
    heroes: ['h-uruk-captain', 'h-warg-rider'],
    army: ['h-orcs', 'h-swordsmen', 'h-spearmen', 'h-orc-archers', 'h-riders', 'h-uruk-captain'],
  },
  {
    slot: 4, name: 'The Elves', team: 0, side: 'free',
    facing: { x: 1, z: 0 },
    // Four havens, and only Rivendell is a real one. The other three are small
    // on purpose: the Elves are the widest-spread power on the map and the
    // least able to defend any single piece of it.
    camps: [
      { id: 'muster-rivendell', name: 'Rivendell', at: { x: 113, z: 61 } },
      { id: 'muster-lindon', name: 'Lindon', at: { x: 33, z: 63 } },
      { id: 'muster-lothlorien', name: 'Lothlórien', at: { x: 283, z: 157 } },
      { id: 'muster-thranduil', name: "Thranduil's Halls", at: { x: 210, z: 74 } },
    ],
    // Archers, and archers, and then some archers. Seventeen tiles of range
    // against everyone else's thirteen: an elven line that is allowed to stand
    // still wins on its own, and every other realm's job is to not allow it.
    waves: [
      ['h-elf-archers', 'h-elf-archers'],
      ['h-elf-archers', 'h-elf-swordsmen'],
      ['h-elf-archers'],
      ['h-elf-archers', 'h-elf-archers', 'h-elf-spearmen'],
    ],
    heroes: ['h-elf-lord'],
    army: ['h-elf-archers', 'h-elf-archers', 'h-elf-archers', 'h-elf-swordsmen', 'h-elf-spearmen', 'h-elf-lord'],
  },
  {
    slot: 5, name: 'Harad', team: 1, side: 'shadow',
    facing: { x: 0, z: -1 },
    // The south, which on this map means BEHIND Gondor. Umbar sits across the
    // river mouth from Dol Amroth and Near Harad under Mordor's skirt, so
    // Harad's two ends threaten opposite flanks of the same war.
    camps: [
      { id: 'muster-umbar', name: 'Umbar', at: { x: 104, z: 354 } },
      { id: 'muster-harondor', name: 'Harondor', at: { x: 286, z: 342 } },
      { id: 'muster-near-harad', name: 'Near Harad', at: { x: 339, z: 347 } },
    ],
    // Men of the south: the same trades Gondor makes, in a different order.
    // Bows first rather than second, and no engines until the last age.
    waves: [
      ['h-swordsmen', 'h-archers'],
      ['h-archers', 'h-spearmen'],
      ['h-riders'],
      ['h-swordsmen', 'h-archers', 'h-catapult'],
    ],
    heroes: ['h-serpent-lord'],
    army: ['h-swordsmen', 'h-swordsmen', 'h-archers', 'h-archers', 'h-spearmen', 'h-serpent-lord'],
  },
  {
    slot: 6, name: 'The Dwarves', team: 0, side: 'free',
    facing: { x: -D, z: D },
    // Erebor, the Iron Hills and Lake-town in the north-east, and the Blue
    // Mountains alone at the far west edge — the longest reach on the map, and
    // the slowest army on it to walk between them.
    camps: [
      { id: 'muster-erebor', name: 'Erebor', at: { x: 337, z: 90 } },
      { id: 'muster-iron-hills', name: 'The Iron Hills', at: { x: 379, z: 74 } },
      { id: 'muster-lake-town', name: 'Lake-town', at: { x: 244, z: 174 } },
      { id: 'muster-blue-mountains', name: 'The Blue Mountains', at: { x: 46, z: 58 } },
    ],
    // Heavy foot that arrives late and cannot be moved once it is somewhere.
    // Two hundred and forty hit points a man against a Gondorian's hundred and
    // thirty, at two thirds the speed and six bowmen to a battalion.
    waves: [
      ['h-dwarf-warriors', 'h-dwarf-warriors'],
      ['h-dwarf-warriors', 'h-iron-guard'],
      ['h-dwarf-warriors'],
      ['h-dwarf-warriors', 'h-dwarf-bowmen', 'h-catapult'],
    ],
    heroes: ['h-dwarf-lord'],
    army: ['h-dwarf-warriors', 'h-dwarf-warriors', 'h-iron-guard', 'h-dwarf-bowmen', 'h-dwarf-warriors', 'h-dwarf-lord'],
  },
  {
    slot: 7, name: 'Moria', team: 1, side: 'shadow',
    facing: { x: 1, z: 0 },
    // Khazad-dûm and its approaches, cut INTO the Misty Mountains — small
    // clearings, because a goblin hold is a hole in a mountain rather than a
    // field with a wall round it. It borders Isengard (an ally) to the south
    // and both elven havens across the range, which is the whole of its war:
    // Moria is the power the Free Peoples cannot go around.
    camps: [
      { id: 'muster-khazad-dum', name: 'Khazad-dûm', at: { x: 150, z: 146 } },
      { id: 'muster-east-gate', name: 'The East-gate', at: { x: 185, z: 156 } },
      { id: 'muster-dimrill-dale', name: 'Dimrill Dale', at: { x: 158, z: 184 } },
    ],
    // The swarm: the most bodies on the map and the worst of them. No engines,
    // no horse, nothing clever — goblins arrive in numbers or not at all, and
    // the cave-troll at the last age is the only thing here that hits hard.
    waves: [
      ['h-orcs', 'h-orcs'],
      ['h-orcs', 'h-orc-archers'],
      ['h-orcs', 'h-orc-pikemen'],
      ['h-orcs', 'h-orcs', 'h-ogre'],
    ],
    // The Marksman rather than Mordor's Warg Chieftain: the two shadow powers
    // that share a roster do not share a hero.
    heroes: ['h-goblin-king'],
    army: ['h-orcs', 'h-orcs', 'h-orcs', 'h-orc-archers', 'h-orc-pikemen', 'h-goblin-king'],
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
    // Plot-placed, so it can only ever stand on its own ground — and so the
    // ground SURVIVES it. Razing a camp now costs its owner the production and
    // the income, but leaves the foundation to raise again if they can pay.
    placement: 'plot',
    cost: [{ resource: 'res', amount: CAMP_COST }],
    buildTimeTicks: CAMP_BUILD_TICKS,
    visual: { model: free ? 'gen:hall' : 'gen:orc-pit', scale: 1.25, tint: 'owner' },
    combat: { damage: 42, range: 12, acquire: 13, periodTicks: 14, damageType: 'arrow', hits: 'both' },
  }
}

/**
 * The foundation a camp stands on. One per camp rather than one shared type,
 * because a pad names what it accepts: Minas Tirith's ground takes Minas
 * Tirith and nothing else, so a razed capital comes back as itself instead of
 * as whichever camp its owner felt like putting there.
 */
function padDef(camp: Camp): EntityDef {
  return {
    id: `pad-${camp.id}`,
    name: `${camp.name} (ruins)`,
    kind: 'building',
    radius: 3.2,
    hp: 100,
    visual: { model: 'gen:castle-site', tint: 'none' },
    plot: { accepts: [camp.id] },
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

// ---- the two rosters the shipped factions do not cover --------------------
// Badgers and the Horde between them supply Gondor, Rohan, Isengard, Mordor,
// Moria and Harad. Elves and Dwarves are the map's own, because their whole
// identity is a stat the existing units do not have: the Galadhrim outrange
// everything on the field, and a dwarf is worth two men and walks like it.
//
// Written as plain entities in the map's module rather than as new faction
// modules — nobody can pick them in a lobby (this map seats no races at all),
// so a `keep`, a start army and a build tree would be scaffolding around
// nothing. They are units the camps muster, and that is all they need to be.

/** A battalion ticket plus the soldier it musters, as one pair of defs. */
function battalion(opts: {
  id: string
  /** Ticket id, written out: deriving it would give "h-elf-swordsmans". */
  ticket: string
  name: string
  unitName: string
  count: number
  spacing?: number
  hp: number
  radius?: number
  speed: number
  armorType: string
  visual: EntityDef['visual']
  combat: EntityDef['combat']
  crushable?: number
  crusher?: number
  chargeGuard?: number
  xpValue?: number
  aura?: EntityDef['aura']
  abilities?: EntityDef['abilities']
}): EntityDef[] {
  const unit: EntityDef = {
    id: opts.id,
    name: opts.unitName,
    kind: 'unit',
    radius: opts.radius ?? 0.4,
    hp: opts.hp,
    armorType: opts.armorType,
    xpValue: opts.xpValue ?? 12,
    visual: opts.visual,
    mover: { speed: opts.speed },
    combat: opts.combat,
    crushableLevel: opts.crushable,
    crusherLevel: opts.crusher,
    chargeGuard: opts.chargeGuard,
    aura: opts.aura,
    abilities: opts.abilities,
  }
  const ticket: EntityDef = {
    id: opts.ticket,
    name: opts.name,
    kind: 'unit',
    radius: opts.radius ?? 0.4,
    hp: 0,
    visual: opts.visual,
    horde: { unit: opts.id, count: opts.count, spacing: opts.spacing ?? 1.2 },
  }
  return [unit, ticket]
}

const ELVES: EntityDef[] = [
  // The Galadhrim. Range 17 against the Badger archer's 13 — four tiles is the
  // difference between shooting first and shooting back, and it is the whole
  // faction. Paid for in bodies: they fold the moment anything reaches them.
  ...battalion({
    id: 'elf-archer', ticket: 'h-elf-archers', name: 'Galadhrim Archers', unitName: 'Galadhrim Archer',
    count: 10, hp: 80, speed: 5.6, armorType: 'archer', xpValue: 16,
    visual: { model: 'gen:badger-bow', tint: 'owner', scale: 1.05 },
    combat: { damage: 15, range: 17, acquire: 18, periodTicks: 16, damageType: 'arrow', hits: 'both' },
  }),
  ...battalion({
    id: 'elf-swordsman', ticket: 'h-elf-swordsmen', name: 'Elven Swordsmen', unitName: 'Elven Swordsman',
    count: 8, hp: 145, speed: 5.4, armorType: 'infantry', xpValue: 14,
    visual: { model: 'gen:badger-sword', tint: 'owner', scale: 1.05 },
    combat: { damage: 18, range: 0.55, acquire: 8, periodTicks: 13, damageType: 'sword' },
    crushable: 1,
  }),
  ...battalion({
    id: 'elf-spearman', ticket: 'h-elf-spearmen', name: 'Elven Spearmen', unitName: 'Elven Spearman',
    count: 8, hp: 135, speed: 5.2, armorType: 'infantry', xpValue: 14,
    visual: { model: 'gen:badger-spear', tint: 'owner', scale: 1.05 },
    combat: { damage: 16, range: 1.1, acquire: 8, periodTicks: 14, damageType: 'spear' },
    crushable: 1, chargeGuard: 25,
  }),
]

const DWARVES: EntityDef[] = [
  // Worth two men apiece and slower than everything else on the field. The
  // trade is deliberate: dwarves cannot choose their battles, so they have to
  // win the one they are standing in.
  ...battalion({
    id: 'dwarf-warrior', ticket: 'h-dwarf-warriors', name: 'Dwarven Warriors', unitName: 'Dwarven Warrior',
    count: 9, hp: 240, speed: 4.0, armorType: 'infantry', xpValue: 20, radius: 0.42,
    visual: { model: 'gen:badger-sword', tint: 'owner', scale: 0.85 },
    combat: { damage: 26, range: 0.6, acquire: 8, periodTicks: 13, damageType: 'sword' },
    crushable: 1,
  }),
  ...battalion({
    id: 'dwarf-guard', ticket: 'h-iron-guard', name: 'Iron Guard', unitName: 'Iron Guard',
    count: 8, hp: 210, speed: 3.9, armorType: 'infantry', xpValue: 18, radius: 0.42,
    visual: { model: 'gen:badger-spear', tint: 'owner', scale: 0.85 },
    combat: { damage: 18, range: 1.1, acquire: 8, periodTicks: 14, damageType: 'spear' },
    crushable: 1, chargeGuard: 30,
  }),
  // Six to a battalion where everyone else fields eight or ten: dwarves shoot
  // because the wall needs covering, not because they intend to win that way.
  ...battalion({
    id: 'dwarf-bowman', ticket: 'h-dwarf-bowmen', name: 'Dwarven Bowmen', unitName: 'Dwarven Bowman',
    count: 6, hp: 110, speed: 4.0, armorType: 'archer', xpValue: 14, radius: 0.42,
    visual: { model: 'gen:badger-bow', tint: 'owner', scale: 0.85 },
    combat: { damage: 13, range: 12, acquire: 13, periodTicks: 17, damageType: 'arrow', hits: 'both' },
  }),
]

// ---- the heroes ----------------------------------------------------------
// One per power, and each is DEFINED by the aura it carries rather than by its
// own sword. That is the whole point of leadership: a hero that only fights is
// a tough soldier, and a tough soldier in a game of nine-man battalions is not
// worth the walk. What makes you escort a captain into the line is that the
// line is better while he stands in it.
//
// Read them as a set — no two do the same thing to the ground around them:
//
//   Gondor      +damage, wide          the classic banner: everyone hits harder
//   Rohan       +speed, widest         a host that arrives before it is expected
//   The Elves   +damage and +armour    small radius; a knot of quality, not a host
//   The Dwarves +armour, heavy         a shield wall that does not break
//   Mordor      DREAD, on the enemy    the men in front of it get worse
//   Isengard    +damage AND +speed     two heroes, because Saruman took both
//   Harad       +speed, +some damage   raiders: the charge is the plan
//   Moria       +damage, huge radius   weak per man, and there are so many men
//
// Radius is the balancing lever, not the percentage: a 26-tile goblin aura over
// forty bodies is worth more than a 14-tile elven one over eight, at half the
// per-unit strength.
const LORDS: EntityDef[] = [
  ...battalion({
    id: 'gondor-captain', ticket: 'h-gondor-captain',
    name: 'Captain of the White Tower', unitName: 'Captain of the White Tower',
    count: 1, spacing: 2, hp: 980, speed: 5.0, armorType: 'infantry', xpValue: 300, radius: 0.5,
    visual: { model: 'gen:badger-hero', tint: 'owner', scale: 1.2 },
    combat: { damage: 54, range: 1.0, acquire: 9, periodTicks: 12, damageType: 'sword' },
    aura: { radius: 18, damagePct: 25 },
    abilities: [{ ability: 'rally-cry' }],
  }),
  ...battalion({
    id: 'mark-marshal', ticket: 'h-mark-marshal',
    name: 'Marshal of the Mark', unitName: 'Marshal of the Mark',
    count: 1, spacing: 2, hp: 1180, speed: 7.8, armorType: 'cavalry', xpValue: 320, radius: 0.55,
    visual: { model: 'gen:badger-marshal', tint: 'owner', scale: 1.15 },
    combat: {
      damage: 48, range: 1.1, acquire: 9, periodTicks: 12, damageType: 'sword',
      charge: { minSpeed: 5, damage: 190, knockback: 2.2, recoilPct: 100 },
    },
    crusher: 2, // CRUSH_MOUNTED: hooves go over foot troops, not over engines
    // The widest aura on the map, and speed rather than damage: Rohan's army is
    // not better than yours, it is simply somewhere else by the time you look.
    aura: { radius: 22, speedPct: 18 },
    abilities: [{ ability: 'heroic-charge' }],
  }),
  ...battalion({
    id: 'elf-lord', ticket: 'h-elf-lord', name: 'Elven Lord', unitName: 'Elven Lord',
    count: 1, spacing: 2, hp: 860, speed: 6.0, armorType: 'infantry', xpValue: 300, radius: 0.45,
    visual: { model: 'gen:badger-ranger', tint: 'owner', scale: 1.2 },
    combat: { damage: 46, range: 15, acquire: 16, periodTicks: 12, damageType: 'arrow', hits: 'both' },
    // Both halves, over a small circle. The Galadhrim are already the best
    // troops on the field and there are never enough of them — this makes a
    // knot of them very hard to break rather than making an army of them.
    aura: { radius: 14, damagePct: 18, armorPct: 15 },
    abilities: [{ ability: 'arrow-storm' }],
  }),
  ...battalion({
    id: 'dwarf-lord', ticket: 'h-dwarf-lord', name: 'Dwarf Lord', unitName: 'Dwarf Lord',
    count: 1, spacing: 2, hp: 1400, speed: 4.2, armorType: 'infantry', xpValue: 320, radius: 0.5,
    visual: { model: 'gen:badger-hero', tint: 'owner', scale: 1.05 },
    combat: { damage: 66, range: 0.9, acquire: 9, periodTicks: 12, damageType: 'sword' },
    // Armour, and a lot of it. A dwarven line already takes two hits to kill a
    // man; under this it takes three, and it still cannot chase anybody.
    aura: { radius: 15, armorPct: 30 },
    abilities: [{ ability: 'word-of-power' }],
  }),
  ...battalion({
    id: 'black-captain', ticket: 'h-black-captain',
    name: 'The Black Captain', unitName: 'The Black Captain',
    count: 1, spacing: 2, hp: 1250, speed: 5.4, armorType: 'infantry', xpValue: 340, radius: 0.55,
    visual: { model: 'gen:warg-chief', tint: 'owner', scale: 1.25 },
    combat: { damage: 60, range: 1.1, acquire: 9, periodTicks: 13, damageType: 'sword' },
    // DREAD. The only aura on the map pointed at the enemy: it does not make
    // orcs better, it makes the men opposite them worse. Mordor never needed
    // help hitting — it needed the other line to stop hitting back.
    aura: { radius: 17, damagePct: -22, affects: 'enemies' },
    abilities: [{ ability: 'dread-howl' }],
  }),
  ...battalion({
    id: 'uruk-captain', ticket: 'h-uruk-captain',
    name: 'Uruk Captain', unitName: 'Uruk Captain',
    count: 1, spacing: 2, hp: 1100, speed: 5.6, armorType: 'infantry', xpValue: 300, radius: 0.5,
    visual: { model: 'gen:orc-sword', tint: 'owner', scale: 1.35 },
    combat: { damage: 52, range: 1.0, acquire: 9, periodTicks: 12, damageType: 'sword' },
    aura: { radius: 16, damagePct: 20 },
  }),
  ...battalion({
    id: 'warg-rider', ticket: 'h-warg-rider',
    name: 'Warg Chieftain', unitName: 'Warg Chieftain',
    count: 1, spacing: 2, hp: 1020, speed: 7.4, armorType: 'cavalry', xpValue: 300, radius: 0.55,
    visual: { model: 'gen:warg-chief', tint: 'owner', scale: 1.1 },
    combat: {
      damage: 46, range: 1.0, acquire: 9, periodTicks: 12, damageType: 'sword',
      charge: { minSpeed: 5, damage: 160, knockback: 2, recoilPct: 100 },
    },
    crusher: 2,
    aura: { radius: 16, speedPct: 14 },
  }),
  ...battalion({
    id: 'serpent-lord', ticket: 'h-serpent-lord',
    name: 'Serpent Lord', unitName: 'Serpent Lord',
    count: 1, spacing: 2, hp: 1050, speed: 7.0, armorType: 'cavalry', xpValue: 300, radius: 0.55,
    visual: { model: 'gen:badger-marshal', tint: 'owner', scale: 1.1 },
    combat: {
      damage: 50, range: 1.0, acquire: 9, periodTicks: 12, damageType: 'sword',
      charge: { minSpeed: 5, damage: 150, knockback: 2, recoilPct: 100 },
    },
    crusher: 2,
    // Harad fields Gondor's troops in a different order and its hero says the
    // same thing: a little of both, and the raid gets there first.
    aura: { radius: 16, damagePct: 12, speedPct: 12 },
  }),
  ...battalion({
    id: 'goblin-king', ticket: 'h-goblin-king',
    name: 'The Goblin King', unitName: 'The Goblin King',
    count: 1, spacing: 2, hp: 1150, speed: 4.8, armorType: 'infantry', xpValue: 300, radius: 0.6,
    visual: { model: 'gen:badger-ogre', tint: 'owner', scale: 1.0 },
    combat: { damage: 44, range: 1.2, acquire: 9, periodTicks: 14, damageType: 'sword' },
    // The largest radius on the map at the smallest per-man bonus. Moria's
    // whole argument is arithmetic: 12% over forty goblins beats 25% over nine
    // men, and this is the hero that makes that argument out loud.
    aura: { radius: 26, damagePct: 12 },
  }),
]

/**
 * A tower pad on contested ground: neutral, so whoever holds the place may
 * fortify it. These are the map's chokepoints — the fords, the Gap, the two
 * gates of Mordor — and they are the only ground on the map where a player
 * can add something that was not authored there.
 */
const TOWER_SITE: EntityDef = {
  id: 'tower-site',
  name: 'Tower Site',
  kind: 'building',
  radius: 2.2,
  hp: 100,
  visual: { model: 'gen:tower-plot', tint: 'none' },
  plot: { accepts: ['watchtower'], neutral: true },
}

// ---- the free peoples of the map ------------------------------------------
// Small holds nobody starts with and anybody may take: a claimable site, a
// garrison you raise on it for a modest price, three pads around it for towers
// and engines, and a trickle of soldiers you cannot recruit anywhere else.
//
// The point is that the militia is LOCAL. A Woses camp gives you Woses and
// nothing else does; take the Druadan forest or do without them. That turns a
// side objective into a reason to send an army somewhere the war was not
// already happening — which is what a claimable point is for, and what a
// generic "+income node" never manages.
//
// Whoever holds it musters it: the wave triggers below are written once per
// PLAYER per garrison, each gated on that player being the one standing there.
// A trigger's owner is fixed at authoring time and a claimable building's is
// not, so eight cheap conditions is the price of the thing changing hands.

interface Garrison {
  id: string // the building; one def per site so `unitDies` and the muster can name it
  name: string
  at: Pt
  /** The militia only this place produces. */
  militia: { unit: EntityDef; ticket: string }
}

/** A militia soldier plus his battalion ticket, in the local flavour. */
function militia(opts: {
  id: string
  ticket: string
  name: string
  unitName: string
  count: number
  hp: number
  speed: number
  armorType: string
  visual: EntityDef['visual']
  combat: EntityDef['combat']
  chargeGuard?: number
}): { unit: EntityDef; ticket: string; defs: EntityDef[] } {
  const defs = battalion({
    id: opts.id,
    ticket: opts.ticket,
    name: opts.name,
    unitName: opts.unitName,
    count: opts.count,
    hp: opts.hp,
    speed: opts.speed,
    armorType: opts.armorType,
    xpValue: 14,
    visual: opts.visual,
    combat: opts.combat,
    crushable: 1,
    chargeGuard: opts.chargeGuard,
  })
  return { unit: defs[0], ticket: opts.ticket, defs }
}

const MILITIA = [
  militia({
    id: 'wose', ticket: 'h-woses', name: 'Wild Men of Drúadan', unitName: 'Wild Man',
    count: 10, hp: 120, speed: 6.2, armorType: 'infantry',
    visual: { model: 'gen:badger-spear', tint: 'owner', scale: 0.9 },
    // Fast, fragile, and hits like something that has been hunting all its
    // life. Woses are an ambush, not a line.
    combat: { damage: 20, range: 0.6, acquire: 8, periodTicks: 11, damageType: 'sword' },
  }),
  militia({
    id: 'dunlending', ticket: 'h-dunlendings', name: 'Dunlending Axemen', unitName: 'Dunlending Axeman',
    count: 9, hp: 165, speed: 5.0, armorType: 'infantry',
    visual: { model: 'gen:orc-sword', tint: 'owner', scale: 1.1 },
    combat: { damage: 24, range: 0.6, acquire: 8, periodTicks: 14, damageType: 'sword' },
  }),
  militia({
    id: 'lossarnach-axeman', ticket: 'h-lossarnach', name: 'Axemen of Lossarnach', unitName: 'Axeman of Lossarnach',
    count: 8, hp: 190, speed: 4.6, armorType: 'infantry',
    visual: { model: 'gen:badger-sword', tint: 'owner', scale: 1.1 },
    combat: { damage: 27, range: 0.65, acquire: 8, periodTicks: 15, damageType: 'sword' },
  }),
  militia({
    id: 'dale-bowman', ticket: 'h-dale-bowmen', name: 'Bowmen of Dale', unitName: 'Bowman of Dale',
    count: 9, hp: 95, speed: 5.2, armorType: 'archer',
    visual: { model: 'gen:badger-bow', tint: 'owner', scale: 0.95 },
    combat: { damage: 14, range: 14, acquire: 15, periodTicks: 16, damageType: 'arrow', hits: 'both' },
  }),
  militia({
    id: 'corsair', ticket: 'h-corsairs', name: 'Corsairs of Umbar', unitName: 'Corsair',
    count: 10, hp: 130, speed: 5.8, armorType: 'infantry',
    visual: { model: 'gen:orc-sword', tint: 'owner', scale: 0.95 },
    combat: { damage: 19, range: 0.55, acquire: 8, periodTicks: 11, damageType: 'sword' },
  }),
  militia({
    id: 'easterling', ticket: 'h-easterlings', name: 'Easterling Spearmen', unitName: 'Easterling Spearman',
    count: 9, hp: 175, speed: 4.8, armorType: 'infantry',
    visual: { model: 'gen:orc-spear', tint: 'owner', scale: 1.05 },
    combat: { damage: 17, range: 1.2, acquire: 8, periodTicks: 14, damageType: 'spear' },
    chargeGuard: 30, // the one militia that can stand in front of horse
  }),
  militia({
    id: 'beorning', ticket: 'h-beornings', name: 'Beornings', unitName: 'Beorning',
    count: 5, hp: 340, speed: 5.4, armorType: 'infantry',
    visual: { model: 'gen:badger-ogre', tint: 'owner', scale: 0.8 },
    // Five of them, and each worth three of anything else here.
    combat: { damage: 40, range: 0.8, acquire: 8, periodTicks: 14, damageType: 'sword' },
  }),
  militia({
    id: 'lorien-warden', ticket: 'h-wardens', name: 'Wardens of the Wood', unitName: 'Warden',
    count: 8, hp: 110, speed: 5.6, armorType: 'archer',
    visual: { model: 'gen:badger-bow', tint: 'owner', scale: 1.0 },
    combat: { damage: 15, range: 15, acquire: 16, periodTicks: 15, damageType: 'arrow', hits: 'both' },
  }),
]

const GARRISONS: Garrison[] = [
  { id: 'hold-druadan', name: 'The Drúadan Forest', at: { x: 218, z: 268 }, militia: MILITIA[0] },
  { id: 'hold-dunland', name: 'The Dunland Hills', at: { x: 96, z: 254 }, militia: MILITIA[1] },
  { id: 'hold-lossarnach', name: 'Lossarnach', at: { x: 158, z: 300 }, militia: MILITIA[2] },
  { id: 'hold-dale', name: 'Dale', at: { x: 358, z: 120 }, militia: MILITIA[3] },
  { id: 'hold-pelargir', name: 'The Havens', at: { x: 168, z: 348 }, militia: MILITIA[4] },
  { id: 'hold-rhun', name: 'The Marches of Rhûn', at: { x: 412, z: 176 }, militia: MILITIA[5] },
  { id: 'hold-carrock', name: 'The Carrock', at: { x: 238, z: 112 }, militia: MILITIA[6] },
  { id: 'hold-eaves', name: 'The Eaves of Lórien', at: { x: 252, z: 200 }, militia: MILITIA[7] },
]

/** The claimable pad. Neutral: this is ground, and ground changes hands. */
const GARRISON_SITE: EntityDef = {
  id: 'garrison-site',
  name: 'Undefended Hold',
  kind: 'building',
  radius: 3.0,
  hp: 100,
  visual: { model: 'gen:camp-site', tint: 'none' },
  plot: { accepts: GARRISONS.map((g) => g.id), neutral: true },
}

/** The three pads a garrison brings with it: towers, or engines. */
const GARRISON_PAD: EntityDef = {
  id: 'garrison-pad',
  name: 'Hold Emplacement',
  kind: 'building',
  radius: 1.6,
  hp: 100,
  visual: { model: 'gen:tower-plot', tint: 'owner' },
  plot: { accepts: ['watchtower', 'wall-catapult'] },
}

/** Three pads at the points of a triangle around the hold. */
const HOLD_SLOTS = [
  { dx: 0, dz: -7 },
  { dx: 6.1, dz: 3.5 },
  { dx: -6.1, dz: 3.5 },
]

function garrisonDef(g: Garrison): EntityDef {
  return {
    id: g.id,
    name: g.name,
    kind: 'building',
    radius: 2.4,
    hp: 2600,
    armorType: 'structure',
    xpValue: 140,
    placement: 'plot',
    cost: [{ resource: 'res', amount: HOLD_COST }],
    buildTimeTicks: 400,
    // Raising it brings its own three emplacements — and razing it takes them
    // with it, so taking a hold off somebody is taking the whole position and
    // not just the building in the middle of it.
    expansion: [{ plot: 'garrison-pad', offsets: HOLD_SLOTS }],
    visual: { model: 'gen:hall', scale: 0.95, tint: 'owner' },
    combat: { damage: 26, range: 11, acquire: 12, periodTicks: 18, damageType: 'arrow', hits: 'both' },
  }
}

const WAR_MODULE: RulesetModule = {
  id: 'war-of-the-ring',
  name: 'War of the Ring',
  entities: [
    ...SCENERY,
    ...ELVES,
    ...DWARVES,
    ...LORDS,
    TOWER_SITE,
    GARRISON_SITE,
    GARRISON_PAD,
    ...MILITIA.flatMap((m) => m.defs),
    ...GARRISONS.map(garrisonDef),
    ...ALL_CAMPS.map(({ realm, camp }) => campDef(realm, camp)),
    ...ALL_CAMPS.map(({ camp }) => padDef(camp)),
  ],
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
  // Enough for two towers and no more. Everything past that is paid for by
  // the muster: a realm's income IS its camps, so the side that is losing
  // ground is also the side that cannot afford to take it back.
  startAmount: 800,
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
  const n = COLS * ROWS
  const idx = (x: number, z: number): number => z * COLS + x
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
    const x1 = Math.min(COLS - 1, Math.floor(c.x + r) + 1)
    const z0 = Math.max(0, Math.floor(c.z - r))
    const z1 = Math.min(ROWS - 1, Math.floor(c.z + r) + 1)
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
      const x = i % COLS
      const z = (i / COLS) | 0
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
  // Ered Luin, the Blue Mountains: the far west, and the only range on the map
  // with nobody's war on either side of it. The dwarven halls are cut INTO it
  // and Lindon sits on the coast beyond, so the Elves and the Dwarves each hold
  // one end of a corner Mordor has to cross everything else to reach.
  range(
    [
      { x: 60, z: 30 },
      { x: 68, z: 76 },
      { x: 62, z: 122 },
      { x: 66, z: 160 },
    ],
    12,
    true,
  )
  // The Great Sea, down the west edge. Cosmetic — the map border already stops
  // anyone — but a coast is what tells you Lindon is the end of the world.
  water(
    [
      { x: 6, z: 0 },
      { x: 12, z: 190 },
      { x: 8, z: 384 },
    ],
    7,
  )

  const MISTY: Pt[] = [
    { x: 122, z: 20 },
    { x: 128, z: 78 },
    { x: 146, z: 130 },
    { x: 163, z: 178 },
    { x: 178, z: 232 },
  ]
  range(MISTY, 18, true)

  // Ered Nimrais, the White Mountains: Rohan above, Gondor below.
  const WHITE: Pt[] = [
    { x: 84, z: 264 },
    { x: 146, z: 252 },
    { x: 204, z: 256 },
    { x: 248, z: 270 },
  ]
  range(WHITE, 12, true)

  // Mordor's two walls meet at the Morannon in the north-west corner.
  range(
    [
      { x: 283, z: 220 },
      { x: 278, z: 262 },
      { x: 286, z: 304 },
      { x: 294, z: 348 },
    ],
    10,
    false,
  )
  range(
    [
      { x: 283, z: 220 },
      { x: 345, z: 213 },
      { x: 410, z: 219 },
      { x: 470, z: 228 },
    ],
    10,
    false,
  )

  // The Lonely Mountain and the Iron Hills.
  disc({ x: 352, z: 62 }, 16, (i, d) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = d < 6 ? TEX_SNOW : TEX_ROCK
  })
  disc({ x: 404, z: 46 }, 13, (i) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = TEX_ROCK
  })
  // Mount Doom, alone on the plain of Gorgoroth. Smaller than it was, and set
  // west of the camp that musters at its foot: a clearing flattens whatever it
  // covers, so the mountain has to stand clear of one by its own radius.
  disc({ x: 372, z: 268 }, 11, (i) => {
    cliffLevel[i] = 3
    blocked[i] = 1
    texture[i] = TEX_ROCK
  })

  // ---- passes ------------------------------------------------------------
  pass({ x: 150, z: 146 }, 15, TEX_ROCK) // Moria's hall, opening east
  pass({ x: 136, z: 108 }, 10, TEX_ROCK) // the High Pass
  pass({ x: 150, z: 262 }, 12, TEX_DIRT) // the road from Rohan down to Gondor
  pass({ x: 283, z: 222 }, 10, TEX_ASH) // the Black Gate
  pass({ x: 280, z: 284 }, 8, TEX_ASH) // Cirith Ungol
  pass({ x: 150, z: 190 }, 14, TEX_ROCK) // Nan Curunír, Isengard's valley

  // ---- Mordor's floor ----------------------------------------------------
  disc({ x: 352, z: 278 }, 66, (i) => {
    if (blocked[i] === 1) return
    texture[i] = TEX_ASH
  })

  // ---- clearings ---------------------------------------------------------
  // Every camp is guaranteed a disc of flat, walkable, scenery-free ground
  // wide enough for its towers and all four age musters. Done BEFORE the
  // water so a clearing can never carve a ford through the Anduin — the river
  // is drawn last and wins, and any muster point it drowns walks itself back
  // to dry land (see `anchor` below).
  // Holds are carved too, and smaller: a claimable site in the middle of a
  // wood or against a cliff is a site nobody can build on, which is a silent
  // way for an objective to simply not exist.
  const flatten: { at: Pt; r: number }[] = [
    ...ALL_CAMPS.map(({ camp }) => ({ at: camp.at, r: camp.clearing ?? CLEARING })),
    ...GARRISONS.map((g) => ({ at: g.at, r: 13 })),
  ]
  const clearings: Pt[] = flatten.map((c) => c.at)
  for (const c of flatten) {
    disc(c.at, c.r, (i) => {
      cliffLevel[i] = 0
      blocked[i] = 0
      ramp[i] = 0
      if (texture[i] === TEX_ROCK || texture[i] === TEX_SNOW) texture[i] = TEX_DIRT
    })
  }

  // ---- the Anduin --------------------------------------------------------
  // From the north down to the sea, dividing east from west the whole way.
  const ANDUIN: Pt[] = [
    { x: 235, z: 0 },
    { x: 239, z: 88 },
    { x: 305, z: 150 },
    { x: 310, z: 196 },
    { x: 262, z: 256 },
    { x: 250, z: 286 },
    // The mouth turns WEST and runs the width of the map. This is the water
    // Umbar's corsairs cross to reach Dol Amroth, and the reason Harad's west
    // end threatens Gondor's back rather than its front.
    { x: 204, z: 317 },
    { x: 117, z: 341 },
    { x: 40, z: 352 },
  ]
  water(ANDUIN, 5)

  // Standing water: the Long Lake under Erebor, and the Sea of Núrnen.
  disc({ x: 306, z: 108 }, 12, (i) => {
    blocked[i] = 1
    texture[i] = TEX_WATER
  })
  // The Sea of Núrnen, pushed into Mordor's south-east corner. It used to lap
  // the Morgul vale, and a lake is drawn AFTER the clearings — so it took a
  // bite out of the fortress's own ground and stood one of its towers in water.
  disc({ x: 372, z: 330 }, 16, (i) => {
    blocked[i] = 1
    texture[i] = TEX_WATER
  })
  // The Dead Marshes, scattered in front of the Black Gate — you pick your way
  // to the Morannon rather than march at it.
  disc({ x: 276, z: 232 }, 26, (i, d) => {
    if (blocked[i] === 1) return
    const x = i % COLS
    const z = (i / COLS) | 0
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
    { at: { x: 283, z: 157 }, r: 26 }, // Lothlórien, around Caras Galadhon
    { at: { x: 300, z: 130 }, r: 52 }, // Mirkwood, the great wood of the east
    { at: { x: 190, z: 212 }, r: 26 }, // Fangorn, under the Mistys
    { at: { x: 118, z: 96 }, r: 30 }, // the Trollshaws
    { at: { x: 272, z: 262 }, r: 22 }, // Ithilien, east of the Anduin
    { at: { x: 216, z: 264 }, r: 18 }, // the Drúadan forest
    { at: { x: 106, z: 244 }, r: 24 }, // the eaves of Dunland
  ]
  for (const w of WOODS) {
    disc(w.at, w.r, (i) => {
      if (blocked[i] === 1 || texture[i] === TEX_ASH) return
      texture[i] = TEX_FOREST
    })
  }
  paint({ x: 190, z: 330 }, 30, TEX_SAND) // the coast below Gondor
  // Harad. Everything below the river mouth goes to sand, which is the one
  // stretch of this map that reads as somewhere else entirely — and the reason
  // Umbar and Near Harad look like one realm despite being 140 tiles apart.
  for (const dune of [
    { at: { x: 150, z: 362 }, r: 80 },
    { at: { x: 300, z: 356 }, r: 74 },
    { at: { x: 400, z: 336 }, r: 50 },
  ]) {
    disc(dune.at, dune.r, (i) => {
      if (blocked[i] === 1 || texture[i] === TEX_ASH) return
      texture[i] = TEX_SAND
    })
  }
  // The Pelennor: the field between Minas Tirith and Osgiliath, kept as open
  // grass end to end. It is the widest clear ground on the map, and it is where
  // the 1v1 is decided — a wood across it would break the fight into skirmishes.
  disc({ x: 228, z: 288 }, 40, (i) => {
    if (blocked[i] === 1 || texture[i] === TEX_ASH) return
    texture[i] = TEX_GRASS
  })
  paint({ x: 176, z: 234 }, 38, TEX_GRASS) // the plains of Rohan, kept open

  // Three crossings, and only three. Cut LAST, after the marshes, the lakes
  // and the paint, so nothing can silently drown a ford and seal the two
  // halves of the map apart — and so their dirt keeps trees off the approach.
  for (const at of [
    { x: 292, z: 131 }, // the upper ford
    { x: 308, z: 176 }, // Cair Andros
    { x: 251, z: 282 }, // the bridge of Osgiliath
    { x: 178, z: 322 }, // the lower crossing, above the Havens
  ]) {
    disc(at, 9, (i) => {
      blocked[i] = 0
      texture[i] = TEX_DIRT
    })
  }

  // The camp itself always stands on dry land, whatever the river just did —
  // and a FORTIFIED one needs its whole curtain on dry land, or the river
  // pushes the pieces that land in it back toward the camp and leaves a hole
  // in the ring an army walks through. A fortress on a riverbank has a dry
  // apron; this is that apron.
  const dryRadius = new Map<string, number>()
  for (const { camp } of ALL_CAMPS) dryRadius.set(`${camp.at.x},${camp.at.z}`, camp.fort ? RING_R + 2 : 7)
  for (const c of clearings) {
    disc(c, dryRadius.get(`${c.x},${c.z}`) ?? 7, (i) => {
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

  // The Morgul shelf is gone. It raised Minas Morgul a tier so that one ramp
  // was the only way up — which was the right idea when the fortress was a
  // camp with a broken arc of wall around it. Now that a fortified camp is a
  // CLOSED ring with one great gate, the shelf did that job twice, and its
  // unwalkable rim sat inside the curtain where it trapped the garrison.

  // ---- relief ------------------------------------------------------------
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < COLS; x++) {
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

  for (let z = 3; z < ROWS - 3; z++) {
    for (let x = 3; x < COLS - 3; x++) {
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
      if (cx < 0 || cz < 0 || cx >= COLS || cz >= ROWS) continue
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
      // A camp on a second front looks its own way; everything it carries —
      // towers, curtain, engines — is placed off THIS vector, not the realm's.
      const face = c.face ?? r.facing
      // The pad goes down FIRST. setup.ts spawns buildings before units and
      // sorts stably, so by the time the camp spawns its foundation exists and
      // spawnBuilding binds the two — which is what leaves a rebuildable ruin
      // behind when the camp falls.
      placed.push({ def: `pad-${c.id}`, owner: r.slot, x: c.at.x, z: c.at.z })
      placed.push({ def: c.id, owner: r.slot, x: c.at.x, z: c.at.z, facing: face })

      // "The spawns were well defended" — three towers apiece on the cardinals,
      // two facing the enemy and one covering a flank, so a camp has a front.
      const perp = { x: -face.z, z: face.x }
      const towers: Pt[] = [
        { x: c.at.x + face.x * TOWER_R, z: c.at.z + face.z * TOWER_R },
        { x: c.at.x + perp.x * TOWER_R, z: c.at.z + perp.z * TOWER_R },
        { x: c.at.x - perp.x * TOWER_R, z: c.at.z - perp.z * TOWER_R },
      ]
      for (const t of towers) {
        const p = nudge(c.at, t)
        // Same trick: a pad under every tower, so a camp's ring of towers can
        // be rebuilt piece by piece instead of being a one-time gift.
        placed.push({ def: 'tower-plot', owner: r.slot, x: p.x, z: p.z })
        placed.push({ def: 'watchtower', owner: r.slot, x: p.x, z: p.z })
      }

      // A fortified camp adds a curtain across its front: wall sections on an
      // arc with a gate at the middle, a wall-tower at each shoulder and
      // catapults behind the stone. Everything sits OUTSIDE the age musters
      // (MUSTER_R) and inside the clearing, so the fort never walls a camp off
      // from its own production.
      if (c.fort) {
        // A closed curtain. Start dead ahead and walk the ring one rotation at
        // a time, so every piece is 2.95 tiles from the last and the stones
        // actually meet — the old arc left six-tile gaps between them.
        let dx = face.x
        let dz = face.z
        for (let slot = 0; slot < RING_SLOTS; slot++) {
          const piece = ringPiece(slot)
          if (piece !== null) {
            const dir = { x: dx, z: dz }
            const at = nudge(c.at, { x: c.at.x + dx * RING_R, z: c.at.z + dz * RING_R })
            placed.push({ def: piece, owner: r.slot, x: at.x, z: at.z, facing: dir })
          }
          // Rotate by one slot. Repeated multiplication rather than a lookup:
          // see RING_COS.
          const nx = dx * RING_COS - dz * RING_SIN
          const nz = dx * RING_SIN + dz * RING_COS
          dx = nx
          dz = nz
        }
        // Engines BEHIND the camp, not in front of it. A wall-catapult ranges 30
        // — enough to cover its own curtain (15 out) and the ground an attacker
        // forms up on, and, set back like this, not enough to reach the enemy
        // fortress across the front. Put them forward instead and the two forts
        // shell each other from tick zero, which turns the march across Ithilien
        // into a stalemate nobody ordered.
        for (const sgn of [1, -1]) {
          const at = nudge(c.at, {
            x: c.at.x - face.x * 9 + perp.x * sgn * 5,
            z: c.at.z - face.z * 9 + perp.z * sgn * 5,
          })
          placed.push({ def: 'wall-catapult', owner: r.slot, x: at.x, z: at.z, facing: face })
        }
      }

      // The four age musters go on the diagonals, between the towers: 7.9
      // apart from the nearest one, which clears a battalion's footprint.
      musters.set(
        c.id,
        MUSTER_DIRS.map((d) => nudge(c.at, { x: c.at.x + d.x * MUSTER_R, z: c.at.z + d.z * MUSTER_R })),
      )
    }

    // The opening army, drawn up at the capital facing the enemy. Per power
    // rather than per side: a Rohirrim host that opens with three battalions of
    // horse and a dwarven one that cannot field a single rider are the whole
    // difference between them, and it has to be true at tick 0 as much as at
    // the fourth age.
    const perp = { x: -r.facing.z, z: r.facing.x }
    r.army.forEach((def, k) => {
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

  // ---- contested tower sites ---------------------------------------------
  // The only ground on the map a player may add anything to. Every one is a
  // place the terrain already forces armies through — the three fords, the two
  // gates of Mordor, the Gap of Rohan, Moria's east door, the Harad crossing —
  // so a tower here is worth an army and taking one back costs one. Neutral:
  // whoever is standing there when they can afford it gets to build.
  for (const site of [
    { x: 292, z: 131 }, // the upper ford
    { x: 308, z: 176 }, // Cair Andros
    { x: 251, z: 282 }, // the bridge of Osgiliath
    { x: 178, z: 322 }, // the lower crossing
    { x: 283, z: 222 }, // the Black Gate
    { x: 280, z: 284 }, // Cirith Ungol
    { x: 190, z: 244 }, // the Gap of Rohan
    { x: 181, z: 148 }, // Moria's east door
    { x: 150, z: 262 }, // the road from Rohan down to Gondor
    { x: 132, z: 344 }, // the Belfalas shore, Dol Amroth's side
  ]) {
    // Two pads a site, set either side of the line of march, so holding a
    // crossing is a pair of towers rather than a single one that a catapult
    // answers on its own.
    for (const off of [
      { x: 5, z: -5 },
      { x: -5, z: 5 },
    ]) {
      const want = { x: site.x + off.x, z: site.z + off.z }
      const cx = Math.floor(want.x)
      const cz = Math.floor(want.z)
      if (cx < 0 || cz < 0 || cx >= COLS || cz >= ROWS) continue
      if (blocked[idx(cx, cz)] === 1) continue
      placed.push({ def: 'tower-site', owner: 0, x: want.x, z: want.z, always: true })
    }
  }

  // ---- the claimable holds -----------------------------------------------
  // Neutral ground, and `always` so they exist whatever the player count. Each
  // is somewhere nobody's camps already reach — a hold inside a realm's own
  // clearing would be a gift rather than an objective.
  for (const g of GARRISONS) {
    placed.push({ def: 'garrison-site', owner: 0, x: g.at.x, z: g.at.z, always: true })
  }

  // ---- regions -----------------------------------------------------------
  // One, covering everything. Camp waves and the win check both ask questions
  // about the whole map ("how much does this player own", "has this realm any
  // camp left"), and the region cap is 30 — spending it on twenty-four camp
  // boxes would buy nothing that a per-camp entity def does not already give.
  const regions: MapRegion[] = [{ id: 'world', name: 'Middle-earth', x0: 0, z0: 0, x1: COLS, z1: ROWS }]

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
    realm.waves.forEach((wave, age) => {
      // Heroes ride out from the capital, and only from the third age. `nth`
      // is the camp's index in its power, so 0 is the capital — every other
      // camp musters the same wave without them.
      const tickets = age === 2 && nth === 0 ? [...wave, ...realm.heroes] : wave
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
          // The camp has to be STANDING. Asked as a condition rather than
          // switched off when it dies, because a camp can be rebuilt now — a
          // one-way `setTrigger` would leave the raised camp mute forever.
          { type: 'unitCountInRegion', region: 'world', owner: realm.slot, def: camp.id, op: '>=', count: 1 },
          // Hold the wave while this realm is at its cap. A hoarded army
          // starves its own production — spend it or stop growing.
          { type: 'unitCountInRegion', region: 'world', owner: realm.slot, op: '<=', count: ARMY_CAP },
        ],
        actions: [
          ...tickets.map((def) => ({
            type: 'spawnUnits' as const,
            def,
            owner: realm.slot,
            count: 1,
            at: { x: at.x, z: at.z },
            facing: camp.face ?? realm.facing,
          })),
        ],
      })
    })

    // What a camp PAYS, on the same clock as what it musters — one income
    // trigger per age, so a realm's take rises with the ages exactly as its
    // waves do. By the fourth age a camp is firing all four and paying four
    // times over.
    //
    // Deliberately NOT gated on the army cap, unlike the waves. A realm at its
    // cap has stopped mustering, and if it had also stopped earning then the
    // moment a power is losing camps — army intact, nothing to spend it on but
    // rebuilding — is exactly the moment it could no longer afford to. The cap
    // governs how many troops you may hold, not whether your camps work.
    realm.waves.forEach((_, age) => {
      triggers.push({
        id: `income-${camp.id}-a${age}`,
        name: `${camp.name} — age ${age + 1} tithe`,
        events: [{ type: 'timer', seconds: period, periodic: true }],
        conditions: [
          ...(age === 0 ? [] : [{ type: 'elapsed' as const, seconds: AGE_AT[age] }]),
          { type: 'unitCountInRegion', region: 'world', owner: realm.slot, def: camp.id, op: '>=', count: 1 },
        ],
        actions: [{ type: 'modifyResource', owner: realm.slot, resource: 'res', delta: MUSTER_PAY }],
      })
    })

    // A razed camp goes quiet — and says so every time, because it can be
    // raised again and lost again.
    triggers.push({
      id: `fallen-${camp.id}`,
      name: `${camp.name} falls`,
      events: [{ type: 'unitDies', owner: realm.slot, def: camp.id }],
      conditions: [],
      actions: [
        {
          type: 'message',
          text: `${camp.name} has fallen — ${realm.name} musters there no more.`,
          to: 'all',
        },
      ],
    })
  }

  // What a hold gives whoever took it: a trickle of the local militia, and a
  // little coin. Written once per PLAYER because a trigger's owner is fixed
  // when the map is authored and a claimable building's owner is not — so the
  // condition, not the action, is what decides who is standing there.
  for (const g of GARRISONS) {
    for (let p = 0; p < REALMS.length; p++) {
      triggers.push({
        id: `hold-${g.id}-p${p}`,
        name: `${g.name} musters (player ${p + 1})`,
        events: [{ type: 'timer', seconds: 70, periodic: true }],
        conditions: [
          // Whoever holds it. One hold, one owner: the other seven triggers
          // fail this and cost nothing but the check.
          { type: 'unitCountInRegion', region: 'world', owner: p, def: g.id, op: '>=', count: 1 },
          { type: 'unitCountInRegion', region: 'world', owner: p, op: '<=', count: ARMY_CAP },
        ],
        actions: [
          {
            type: 'spawnUnits',
            def: g.militia.ticket,
            owner: p,
            count: 1,
            at: { x: g.at.x, z: g.at.z + 6 },
            facing: { x: 0, z: 1 },
          },
          { type: 'modifyResource', owner: p, resource: 'res', delta: HOLD_PAY },
        ],
      })
    }
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
    cols: COLS,
    rows: ROWS,
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
