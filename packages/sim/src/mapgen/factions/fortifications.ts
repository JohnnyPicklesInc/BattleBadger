import type { EntityDef, UpgradeDef } from '../../defs/schema.ts'
import type { RulesetModule } from '../../ruleset.ts'
import { CRUSH_ENGINE } from './shared.ts'

// The fortress itself, as pieces you place rather than one building.
//
// A BFME fortress is terrain, not a model: a curtain wall you fight along, a
// gate the attacker has to break, catapult emplacements already built into the
// battlements, and sally ports the defenders sortie from. All of that is
// authorable with what the engine already has — buildings block cells and free
// them when they die — except the gate, which needed the one new component in
// the sim (see systems/gates.ts).
//
// Shared by both sides. A wall is a wall; the two ends of the map differ in
// their armies and their colours, not in their masonry.

const WALL_ARMOR = 'structure'

// Walls are deliberately expensive to chew through with swords and soft to
// siege. Without that split an attacker just walks his infantry into the stone
// and the catapults he brought are decoration.
const ENTITIES: EntityDef[] = [
  {
    id: 'wall',
    name: 'Wall',
    kind: 'building',
    radius: 1.5,
    hp: 4000,
    armorType: WALL_ARMOR,
    xpValue: 10,
    crushableLevel: CRUSH_ENGINE + 1, // nothing rides through a curtain wall
    visual: { model: 'gen:wall', tint: 'owner' },
  },
  {
    id: 'wall-corner',
    name: 'Wall Corner',
    kind: 'building',
    radius: 1.7,
    hp: 5000,
    armorType: WALL_ARMOR,
    xpValue: 12,
    crushableLevel: CRUSH_ENGINE + 1,
    visual: { model: 'gen:wall-corner', tint: 'owner' },
  },
  {
    // The main gate. Wide, tough, and the thing an attacking army forms up in
    // front of — which is the whole point of building the map around one.
    id: 'gate',
    name: 'Great Gate',
    kind: 'building',
    // Wide enough to span the three wall sections it replaces, so the curtain
    // stays sealed while it is shut — and wide enough that an army pours
    // through rather than files, once it is open or broken.
    radius: 4.2,
    hp: 6500,
    armorType: WALL_ARMOR,
    xpValue: 40,
    crushableLevel: CRUSH_ENGINE + 1,
    gate: { openRadius: 7, manual: true },
    visual: { model: 'gen:gate', tint: 'owner' },
  },
  {
    // A postern. Narrow enough that a battalion files out rather than pouring,
    // which is what makes sallying a decision instead of a free attack.
    id: 'sally-port',
    name: 'Sally Port',
    kind: 'building',
    // Matches the wall it stands in. Anything narrower leaves a hole beside it.
    radius: 1.5,
    hp: 2200,
    armorType: WALL_ARMOR,
    xpValue: 15,
    crushableLevel: CRUSH_ENGINE + 1,
    gate: { openRadius: 4 },
    visual: { model: 'gen:sally-port', tint: 'owner' },
  },
  {
    // Fires over the wall on its own. Cheap in attention, which matters when
    // four players share one fortress and nobody owns "the north wall".
    id: 'wall-tower',
    name: 'Wall Tower',
    kind: 'building',
    radius: 1.8,
    hp: 3000,
    armorType: WALL_ARMOR,
    xpValue: 30,
    crushableLevel: CRUSH_ENGINE + 1,
    vision: 22,
    visual: { model: 'gen:wall-tower', tint: 'owner' },
    combat: { damage: 34, range: 20, acquire: 20, periodTicks: 26, damageType: 'arrow', hits: 'both' },
  },
  {
    // An emplacement, already cut into the battlement. It starts EMPTY: the
    // slot is the map's gift, the engine on it is the player's decision.
    id: 'siege-emplacement',
    name: 'Siege Emplacement',
    kind: 'building',
    radius: 1.6,
    // hp 0 means "indestructible" for a doodad but "already dead" for a
    // building — deaths() reaped all twelve of these on the first tick, which
    // is why the battlements had nowhere to put an engine. Plots carry real hp,
    // the same as the fortress plots do.
    hp: 100,
    visual: { model: 'gen:emplacement', tint: 'none' },
    plot: { accepts: ['wall-catapult'] },
  },
  {
    id: 'wall-catapult',
    name: 'Wall Catapult',
    kind: 'building',
    radius: 1.4,
    hp: 900,
    armorType: 'engine',
    xpValue: 45,
    placement: 'plot',
    buildTimeTicks: 200,
    cost: [{ resource: 'res', amount: 700 }],
    vision: 26,
    visual: { model: 'gen:wall-catapult', tint: 'owner' },
    combat: {
      damage: 150,
      range: 30,
      acquire: 30,
      periodTicks: 90,
      damageType: 'siege',
      // Artillery, not a rifle. The travel time is what lets a charging line
      // get under it, which is how a fortress falls at all.
      projectile: { speed: 22, splashRadius: 3.4, edgePct: 45, scatterRadius: 2.2 },
    },
  },
]

// Research for the walls themselves. It lives HERE rather than on a faction
// because it names wall pieces: an upgrade in the badger module that improved
// a wall tower broke every map that seats badgers without fortifications.
const UPGRADES: UpgradeDef[] = [
  {
    id: 'reinforced-battlements', name: 'Reinforced Battlements', hotkey: 'R',
    cost: [{ resource: 'res', amount: 900 }], buildTimeTicks: 360,
    soldBy: ['wall-tower'], requires: ['wall-tower'],
    appliesTo: ['wall', 'wall-corner', 'gate', 'sally-port', 'wall-tower'],
    armorPct: 30,
  },
  {
    id: 'ranging-shot', name: 'Ranging Shot', hotkey: 'T',
    cost: [{ resource: 'res', amount: 800 }], buildTimeTicks: 320,
    soldBy: ['wall-tower'], requires: ['wall-tower'],
    appliesTo: ['wall-catapult', 'wall-tower'],
    rangePct: 18, damagePct: 12,
  },
]

export const FORTIFICATIONS: RulesetModule = {
  id: 'fortifications',
  name: 'Fortifications',
  entities: ENTITIES,
  upgrades: UPGRADES,
}
