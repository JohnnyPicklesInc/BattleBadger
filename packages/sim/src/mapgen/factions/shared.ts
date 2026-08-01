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

// The build plots ringing a keep.
//
// Held well off the keep rather than hugging it. Plots pressed against the
// citadel made a base one solid blob: no lanes between the buildings, nowhere
// for a defender to stand, and a single catapult shot landing on four things
// at once. At this radius a base is somewhere you fight rather than a wall of
// masonry, and there is room to walk between the halls.
const R = 15
const D = 11 // the diagonals, held to roughly the same distance
export const KEEP_SLOTS = [
  { dx: R, dz: 0 },
  { dx: -R, dz: 0 },
  { dx: 0, dz: R },
  { dx: 0, dz: -R },
  { dx: D, dz: D },
  { dx: -D, dz: D },
  { dx: D, dz: -D },
  { dx: -D, dz: -D },
  // a second, wider arc — a keep is worth building a real base around
  { dx: 22, dz: 8 },
  { dx: 22, dz: -8 },
  { dx: -22, dz: 8 },
  { dx: -22, dz: -8 },
]

// Small pads further out, on the approaches. They take a tower and nothing
// else, so the outer ring is defence rather than more economy — the reason to
// push your perimeter out is to see and shoot, not to earn.
const T = 30
const TD = 22
export const KEEP_TOWER_SLOTS = [
  { dx: T, dz: 0 },
  { dx: -T, dz: 0 },
  { dx: 0, dz: T },
  { dx: 0, dz: -T },
  { dx: TD, dz: TD },
  { dx: -TD, dz: TD },
  { dx: TD, dz: -TD },
  { dx: -TD, dz: -TD },
]

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
]

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
