import type { EntityDef, FormationDef } from '../../defs/schema.ts'
import type { RulesetBase, RulesetModule } from '../../ruleset.ts'

// The rules every faction plays by: one resource, one damage matrix, one
// veterancy ladder, one set of stances, and the handful of structures that
// belong to nobody in particular.
//
// Factions contribute ENTITIES only. The vocabulary lives here so a map that
// seats two factions can never end up with two incompatible damage tables.

// Crush hierarchy: a charge flattens anything strictly below its own level.
export const CRUSH_FOOT = 1
export const CRUSH_MOUNTED = 2
export const CRUSH_ENGINE = 3

// Twelve compass points as literal unit vectors, and the four cardinals.
// Authored rather than computed because trigonometry is banned in this package
// (scripts/check-sim-purity.mjs) — the same reason the AI carries its own copy.
export const COMPASS: [number, number][] = [
  [1, 0], [0.87, 0.5], [0.5, 0.87],
  [0, 1], [-0.5, 0.87], [-0.87, 0.5],
  [-1, 0], [-0.87, -0.5], [-0.5, -0.87],
  [0, -1], [0.5, -0.87], [0.87, -0.5],
]
export const CARDINALS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
export const DIAGONALS: [number, number][] = [[0.71, 0.71], [-0.71, 0.71], [-0.71, -0.71], [0.71, -0.71]]

/** Place `dirs` on a circle of `radius`, rounded to whole cells. */
export function ring(dirs: [number, number][], radius: number): { dx: number; dz: number }[] {
  // floor(+0.5) rather than rounding — see the purity check.
  const snap = (v: number): number => Math.floor(v * radius + (v < 0 ? -0.5 : 0.5))
  return dirs.map(([x, z]) => ({ dx: snap(x), dz: snap(z) }))
}

// The build plots ringing a keep: a genuine circle, twelve slots evenly spaced
// on one radius.
//
// It used to be three arcs at three different distances, which read as a
// cluster rather than a ring and left the diagonals crowded against the keep
// while the cardinals sat out on their own. Held well off the citadel either
// way: plots pressed against it made a base one solid blob, with no lanes
// between the buildings and a single catapult shot landing on four things.
export const KEEP_SLOTS = ring(COMPASS, 15)

// Towers. Four out on the approaches, one to each quarter of the compass, and
// four more drawn in toward the keep — a picket you can see from, and a closer
// ring you fall back to. They take a tower and nothing else, so pushing the
// perimeter out is about seeing and shooting rather than earning.
export const KEEP_TOWER_SLOTS = [...ring(CARDINALS, 30), ...ring(DIAGONALS, 22)]

// The smaller bases you raise out on the map. Same idea as the keep's ring,
// scaled down: three slots drawn in tight for an outpost, six at a comfortable
// spacing for a camp. Radii shrink with the count so a camp is a place rather
// than a spray of pads — six slots on the keep's radius would enclose more
// empty grass than base.
export const OUTPOST_SLOTS = ring([COMPASS[0], COMPASS[4], COMPASS[8]], 8)
export const CAMP_SLOTS = ring([COMPASS[0], COMPASS[2], COMPASS[4], COMPASS[6], COMPASS[8], COMPASS[10]], 12)
// A camp gets a picket too, or an expansion is simply free ground for whoever
// walks over. Half the keep's, and only the outer ring.
export const CAMP_TOWER_SLOTS = ring(CARDINALS, 18)

// What a site asks for, and what a faction's own bases answer with. The three
// tiers ARE the design: how much base a piece of ground is worth is the map's
// decision, made once when the site is placed.
export const TAG_OUTPOST = 'outpost'
export const TAG_CAMP = 'camp'
export const TAG_CASTLE = 'castle'

export const STANCES: FormationDef[] = [
  { id: 'block', name: 'Block', kind: 'block', hotkey: 'B' },
  { id: 'line', name: 'Line', kind: 'line', hotkey: 'L', damagePct: 110, speedPct: 115 },
  {
    id: 'porcupine',
    name: 'Porcupine',
    kind: 'ring',
    hotkey: 'O',
    // Set to receive cavalry: braced men are as hard to ride down as a horse,
    // so a charge into them is refused outright and breaks on the spears.
    crushableLevel: CRUSH_MOUNTED,
    damageTakenPct: 55,
    speedPct: 45,
  },
]

export const DAMAGE_TYPES = ['sword', 'arrow', 'spear', 'siege', 'trample', 'kinetic']
export const ARMOR_TYPES = ['infantry', 'archer', 'cavalry', 'structure', 'engine']

// Only the interesting pairs are listed; everything else is 100%.
export const DAMAGE_TABLE = [
  { damage: 'sword', armor: 'archer', pct: 150 },
  { damage: 'sword', armor: 'cavalry', pct: 75 },
  { damage: 'sword', armor: 'structure', pct: 25 },
  { damage: 'sword', armor: 'engine', pct: 60 },

  { damage: 'arrow', armor: 'infantry', pct: 60 },
  { damage: 'arrow', armor: 'archer', pct: 80 },
  { damage: 'arrow', armor: 'structure', pct: 10 },
  { damage: 'arrow', armor: 'engine', pct: 40 },

  { damage: 'spear', armor: 'cavalry', pct: 300 },
  { damage: 'spear', armor: 'infantry', pct: 70 },
  { damage: 'spear', armor: 'archer', pct: 70 },
  { damage: 'spear', armor: 'structure', pct: 15 },

  { damage: 'siege', armor: 'structure', pct: 400 },
  { damage: 'siege', armor: 'infantry', pct: 35 },
  { damage: 'siege', armor: 'archer', pct: 35 },
  { damage: 'siege', armor: 'cavalry', pct: 25 },

  { damage: 'trample', armor: 'archer', pct: 300 },
  { damage: 'trample', armor: 'infantry', pct: 180 },
  { damage: 'trample', armor: 'structure', pct: 5 },

  // Gunfire: reliable against anything soft, hopeless against masonry.
  { damage: 'kinetic', armor: 'archer', pct: 120 },
  { damage: 'kinetic', armor: 'cavalry', pct: 110 },
  { damage: 'kinetic', armor: 'engine', pct: 90 },
  { damage: 'kinetic', armor: 'structure', pct: 20 },
]

// Shared by every horde and hero. Index 0 is level 1 and must be the baseline.
export const HORDE_LEVELS = [
  { xp: 0, damagePct: 100, damageTakenPct: 100 },
  { xp: 40, damagePct: 115, damageTakenPct: 94 },
  { xp: 120, damagePct: 132, damageTakenPct: 88 },
  { xp: 280, damagePct: 152, damageTakenPct: 80 },
  { xp: 600, damagePct: 175, damageTakenPct: 70 },
]

// Structures every faction can raise, plus the neutral settlement pad.
export const NEUTRAL_ENTITIES: EntityDef[] = [
    {
      id: 'farm', name: 'Farm', kind: 'building', radius: 1.8, hp: 600,
      armorType: 'structure', xpValue: 15, placement: 'plot', buildTimeTicks: 100,
      cost: [{ resource: 'res', amount: 300 }],
      visual: { model: 'gen:farm', tint: 'owner' },
      // ~4/s alone; a tight cluster of four is worth barely two spread farms
      income: {
        resource: 'res', amount: 8, perTicks: 20,
        crowdRadius: 16, crowdPenaltyPct: 20, crowdFloorPct: 40,
      },
    },
    {
      id: 'watchtower', name: 'Watchtower', kind: 'building', radius: 1.4, hp: 1200,
      armorType: 'structure', xpValue: 20, placement: 'plot', buildTimeTicks: 90,
      cost: [{ resource: 'res', amount: 250 }],
      visual: { model: 'gen:watchtower', tint: 'owner' },
      combat: { damage: 30, range: 14, acquire: 15, periodTicks: 18, damageType: 'arrow', hits: 'both' },
    },
    {
      // A small pad on the approaches. Takes a tower and nothing else.
      id: 'tower-plot', name: 'Tower Pad', kind: 'building', radius: 1.5, hp: 100,
      visual: { model: 'gen:tower-plot', tint: 'owner' },
      plot: { accepts: ['watchtower'] },
    },
    {
      // An expansion players fight over. Neutral, so either side may claim it,
      // and it takes a real base rather than a farm — which is what makes
      // holding ground away from your keep worth the army it costs.
      id: 'expansion-plot', name: 'Expansion', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:expansion-plot', tint: 'none' },
      plot: { accepts: ['farm', 'watchtower'], neutral: true },
    },
    {
      id: 'settlement', name: 'Settlement', kind: 'building', radius: 2.6, hp: 100,
      // 'none': a neutral pad belongs to nobody. Its owner field is only a
      // placement slot, and tinting it would paint it as player 0's property.
      visual: { model: 'gen:plot', tint: 'none' },
      plot: { accepts: ['farm', 'watchtower'], neutral: true },
    },
    // ---- the three sites you can raise a NEW BASE on --------------------
    //
    // A settlement is a slot for one building. These are slots for a base: put
    // a camp on one and it brings its own ring of build plots, exactly the way
    // the keep does. How much base the ground is worth is the map's call, made
    // once when it places the site — three buildings here, six there, a whole
    // second castle on the ground worth a battle.
    //
    // Each site takes a KIND of base rather than a named building, so any
    // faction can claim any site with its own architecture. A bigger site takes
    // anything smaller: raising a cheap outpost on castle ground is a real
    // choice — you hold the place now and give up what it could have been.
    {
      id: 'outpost-site', name: 'Outpost Site', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:outpost-site', tint: 'none' },
      plot: { accepts: [], acceptsTags: [TAG_OUTPOST], neutral: true },
    },
    {
      id: 'camp-site', name: 'Camp Site', kind: 'building', radius: 3.0, hp: 100,
      visual: { model: 'gen:camp-site', tint: 'none' },
      plot: { accepts: [], acceptsTags: [TAG_CAMP, TAG_OUTPOST], neutral: true },
    },
    {
      id: 'castle-site', name: 'Castle Site', kind: 'building', radius: 3.6, hp: 100,
      visual: { model: 'gen:castle-site', tint: 'none' },
      plot: { accepts: [], acceptsTags: [TAG_CASTLE, TAG_CAMP, TAG_OUTPOST], neutral: true },
    },
]

/**
 * The two lesser bases a faction can raise on an outer site: an outpost worth
 * three buildings and a camp worth six.
 *
 * A factory rather than three hand-written copies, because what differs between
 * the Badgers' camp and the Horde's is one string — the plot its ring is made
 * of, which is what makes the ring accept ORC buildings rather than badger
 * ones. Everything else is the same shape of thing, and three copies of it
 * would drift the first time one was balanced.
 *
 * The third tier is deliberately not here: a castle IS the faction's keep, so
 * a faction earns that tier by pricing its own fortress rather than by
 * declaring a second, near-identical building that would then have to be kept
 * in step with it.
 */
export function outerBases(opts: { id: string; name: string; plot: string }): EntityDef[] {
  return [
    {
      id: `${opts.id}-outpost`,
      name: `${opts.name} Outpost`,
      kind: 'building',
      radius: 2.8,
      hp: 2600,
      armorType: 'structure',
      xpValue: 60,
      placement: 'plot',
      buildTags: [TAG_OUTPOST],
      buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 500 }],
      vision: 20,
      visual: { model: 'gen:outpost', tint: 'owner' },
      expansion: [{ plot: opts.plot, offsets: OUTPOST_SLOTS }],
    },
    {
      id: `${opts.id}-camp`,
      name: `${opts.name} Camp`,
      kind: 'building',
      radius: 3.2,
      hp: 4200,
      armorType: 'structure',
      xpValue: 110,
      placement: 'plot',
      buildTags: [TAG_CAMP],
      buildTimeTicks: 320,
      cost: [{ resource: 'res', amount: 1100 }],
      // Command points of its own: an expansion has to be worth holding for
      // something other than the farms, or nobody defends it.
      supplyProvided: 15,
      vision: 24,
      visual: { model: 'gen:camp', tint: 'owner' },
      expansion: [
        { plot: opts.plot, offsets: CAMP_SLOTS },
        { plot: 'tower-plot', offsets: CAMP_TOWER_SLOTS },
      ],
    },
  ]
}

/** A faction: the keep you start with, its plot, and everything it fields. */
// The farm/watchtower/settlement that belong to nobody in particular. A
// module like any other, so the neutral content and a faction go through one
// code path — and so a faction pack can ship the plot targets its fortress
// accepts, without which it would not be a complete game.
export const NEUTRAL_MODULE: RulesetModule = {
  id: 'neutral',
  name: 'Neutral structures',
  entities: NEUTRAL_ENTITIES,
}

/**
 * A faction is just a module that names a keep — there is deliberately no
 * separate type for it. Anything that can be saved and imported as a ruleset
 * module can be seated on a map as a faction, and vice versa.
 */
export type Faction = RulesetModule & { keep: string }

// The physics every BFME-lineage map here shares: what damage means, what
// armor means, what you spend. Modules are checked against it on import.
export const BASE_RULES: RulesetBase = {
  schema: 1,
  resources: [{ id: 'res', name: 'Resources', startAmount: 4000, uiColor: '#ffd75e' }],
  supplyName: 'Command Points',
  supplyHardCap: 120,
  damageTypes: DAMAGE_TYPES,
  armorTypes: ARMOR_TYPES,
  damageTable: DAMAGE_TABLE,
  hordeLevels: HORDE_LEVELS,
  abilities: [],
}
