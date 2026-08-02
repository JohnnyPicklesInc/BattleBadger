import type { AbilityDef, EntityDef, UpgradeDef } from '../../defs/schema.ts'
import {
  CRUSH_ENGINE, CRUSH_FOOT, CRUSH_MOUNTED, KEEP_SLOTS, KEEP_TOWER_SLOTS, STANCES, TAG_CASTLE,
  outerBases, type Faction,
} from './shared.ts'

// The Horde — quantity over quality. Battalions of 12-15 against the badgers'
// 8-9, at roughly 40% the cost per body and built faster, but each body is
// weaker. Its answer to good troops is not better troops: it is the Ogre,
// bought whole from a pen gated behind a pit.

const ENTITIES: EntityDef[] = [
    // Tuned so an equal SPEND of orcs roughly annihilates an equal spend of
    // badgers rather than beating them: measured, 45 orcs and 18 swordsmen
    // wipe each other out. Their real advantage is that a battalion is cheaper
    // in absolute terms and builds faster, so they are back on the field first.
    // The first pass had orcs winning outright — more bodies means more of them
    // reach the front, so quantity beats stats by more than the maths suggests.
    // Mordor's shape: quantity over quality. Its infantry is the cheapest on
    // the field and dies in droves, but a battalion is nearly twice the size
    // of a badger one, so it wins by frontage and by trading bodies it can
    // afford to lose. Its answer to good troops is not better troops — it is
    // the Ogre, bought whole rather than upgraded into.
    {
      crushableLevel: CRUSH_FOOT,
      id: 'orc', name: 'Orc', kind: 'unit', radius: 0.34, hp: 50,
      armorType: 'infantry', xpValue: 3,
      visual: { model: 'gen:orc-sword', tint: 'owner' },
      mover: { speed: 4.4 },
      combat: { damage: 8, range: 0.6, acquire: 9, periodTicks: 9, damageType: 'sword' },
    },
    {
      crushableLevel: CRUSH_FOOT,
      id: 'orc-archer', name: 'Orc Archer', kind: 'unit', radius: 0.33, hp: 42,
      armorType: 'archer', xpValue: 4,
      visual: { model: 'gen:orc-bow', scale: 0.95, tint: 'owner' },
      mover: { speed: 4.2 },
      combat: { damage: 9, range: 11, acquire: 13, periodTicks: 15, damageType: 'arrow', hits: 'both' },
    },
    {
      crushableLevel: CRUSH_MOUNTED,
      id: 'orc-pikeman', name: 'Orc Pikeman', kind: 'unit', radius: 0.34, hp: 48,
      armorType: 'infantry', xpValue: 4,
      chargeGuard: 25, // every faction needs an answer to cavalry
      visual: { model: 'gen:orc-spear', tint: 'owner' },
      mover: { speed: 4.2 },
      combat: { damage: 8, range: 1.4, acquire: 9, periodTicks: 10, damageType: 'spear' },
    },

    {
      // A fell beast. The Horde's answer to an eagle and the mirror of it:
      // faster and cheaper, but thinner — the same trade the rest of this
      // faction makes. Cavalry armour, so archers are the answer to it.
      id: 'fell-beast', name: 'Fell Beast', kind: 'unit', radius: 0.8, hp: 350,
      armorType: 'cavalry', xpValue: 40,
      flying: true,
      vision: 24,
      // A shorter dive than the eagle's: it is in and out faster, and thinner
      // for it. The same trade this faction makes everywhere.
      swoopTicks: 13,
      visual: { model: 'gen:fell-beast', scale: 1.2, tint: 'owner' },
      mover: { speed: 7.8 },
      combat: {
        damage: 66, range: 1.4, acquire: 13, periodTicks: 36, damageType: 'sword', hits: 'both',
        splashRadius: 1.1, splashEdgePct: 40, knockback: 3.2,
      },
    },
    {
      // The mounted hero, on a warg. Charges like the riders that answer to
      // pikes, because a hero is a very good unit rather than an exception.
      crushableLevel: CRUSH_MOUNTED, crusherLevel: CRUSH_MOUNTED,
      id: 'warg-chief', name: 'Warg Chieftain', kind: 'unit', radius: 0.55, hp: 980,
      armorType: 'cavalry', xpValue: 55,
      visual: { model: 'gen:warg-chief', scale: 1.25, tint: 'owner' },
      mover: { speed: 6.6 },
      vision: 18,
      combat: {
        damage: 64, range: 1.0, acquire: 12, periodTicks: 10, damageType: 'sword',
        charge: { minSpeed: 4.8, damage: 170, knockback: 5.0, cooldownTicks: 70, knockdownTicks: 4, recoilPct: 40 },
      },
      abilities: [{ ability: 'dread-howl' }],
    },
    {
      // The archer hero. One shot, aimed at one thing — where the Ranger
      // Captain drops a volley on a place, this kills something specific.
      id: 'marksman', name: 'Orc Marksman', kind: 'unit', radius: 0.38, hp: 580,
      armorType: 'archer', xpValue: 50,
      visual: { model: 'gen:orc-marksman', scale: 1.15, tint: 'owner' },
      mover: { speed: 4.6 },
      vision: 20,
      combat: { damage: 46, range: 15, acquire: 17, periodTicks: 14, damageType: 'arrow', hits: 'both' },
      abilities: [{ ability: 'black-arrow' }],
    },

    // ---- Horde tickets: big, cheap battalions ----
    {
      // A BFME troll: huge, slow, and swinging a club that throws whatever it
      // connects with. Too heavy to be ridden down, heavy enough to flatten
      // foot it walks over, but it is not siege — a wall shrugs it off.
      crushableLevel: CRUSH_ENGINE, crusherLevel: CRUSH_FOOT,
      id: 'ogre', name: 'Ogre', kind: 'unit', radius: 0.95, hp: 900,
      armorType: 'cavalry', xpValue: 45,
      visual: { model: 'gen:badger-ogre', scale: 1.1, tint: 'owner' },
      mover: { speed: 3.2 },
      combat: {
        damage: 85, range: 1.6, acquire: 10, periodTicks: 22, damageType: 'sword',
        // The club SWEEPS: a slow single-target hitter is simply out-DPSed by
        // the ring of men it is standing in. Hitting the whole ring, and
        // scattering it, is what makes the ogre worth its price.
        splashRadius: 1.8, splashEdgePct: 40,
        knockback: 3.2, // the whole point: bodies go flying
        // 6 ticks, against a 22-tick swing. Longer and the sweep stunlocks
        // everything adjacent to it — at 14 the ogre beat spearmen at even
        // cost, which is exactly the counter it is supposed to lose to.
        knockdownTicks: 6,
      },
    },
    {
      id: 'h-orcs', name: 'Orc Horde', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 75,
      cost: [{ resource: 'res', amount: 190 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'orc', count: 15, spacing: 1.0, formations: STANCES },
    },
    {
      id: 'h-orc-archers', name: 'Orc Archers', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 85,
      cost: [{ resource: 'res', amount: 230 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'orc-archer', count: 12, spacing: 1.15, formations: STANCES },
    },
    {
      id: 'h-orc-pikemen', name: 'Orc Pikemen', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 80,
      cost: [{ resource: 'res', amount: 210 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'orc-pikeman', count: 14, spacing: 1.05, formations: STANCES },
    },
    {
      id: 'h-fell-beasts', name: 'Fell Beasts', kind: 'unit', radius: 0.8, hp: 0,
      supplyCost: 15, buildTimeTicks: 240,
      cost: [{ resource: 'res', amount: 880 }],
      visual: { model: 'gen:fell-beast', scale: 1.2, tint: 'owner' },
      horde: { unit: 'fell-beast', count: 2, spacing: 3.0 },
    },
    {
      id: 'h-warg-chief', name: 'Warg Chieftain', kind: 'unit', radius: 0.55, hp: 0,
      supplyCost: 17, buildTimeTicks: 230,
      cost: [{ resource: 'res', amount: 1050 }],
      visual: { model: 'gen:warg-chief', scale: 1.25, tint: 'owner' },
      horde: { unit: 'warg-chief', count: 1, spacing: 2 }, // a hero is a horde of one
    },
    {
      id: 'h-marksman', name: 'Orc Marksman', kind: 'unit', radius: 0.38, hp: 0,
      supplyCost: 13, buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 850 }],
      visual: { model: 'gen:orc-marksman', scale: 1.15, tint: 'owner' },
      horde: { unit: 'marksman', count: 1, spacing: 2 },
    },
    {
      id: 'horde-plot', name: 'Horde Plot', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:plot', tint: 'owner' },
      plot: { accepts: ['farm', 'orc-pit', 'ogre-pen', 'fell-roost', 'watchtower'] },
    },
    {
      // The Horde's keep. Same job as a Fortress, and deliberately a shade
      // weaker in the wall for a shade cheaper an army — this faction is not
      // supposed to win a siege, it is supposed to already be inside.
      id: 'dark-fortress', name: 'Dark Fortress', kind: 'building', radius: 3.6, hp: 7800,
      armorType: 'structure', xpValue: 200, supplyProvided: 90,
      visual: { model: 'gen:dark-fortress', tint: 'owner' },
      combat: { damage: 34, range: 12, acquire: 13, periodTicks: 16, damageType: 'arrow', hits: 'both' },
      trainer: { trains: ['h-orcs'], queueSize: 3 },
      // Buildable again on castle ground — see the Badger fortress for why the
      // castle tier is the keep itself rather than a second building.
      placement: 'plot',
      buildTags: [TAG_CASTLE],
      buildTimeTicks: 480,
      cost: [{ resource: 'res', amount: 2500 }],
      expansion: [
        { plot: 'horde-plot', offsets: KEEP_SLOTS },
        { plot: 'tower-plot', offsets: KEEP_TOWER_SLOTS },
      ],
    },
    ...outerBases({ id: 'orc', name: 'Orc', plot: 'horde-plot' }),
    {
      // Cheap and fast: the Horde's whole economy is turning resources into
      // bodies quicker than the enemy can turn them into better bodies.
      id: 'orc-pit', name: 'Orc Pit', kind: 'building', radius: 2.2, hp: 1300,
      armorType: 'structure', xpValue: 22, placement: 'plot', buildTimeTicks: 110,
      cost: [{ resource: 'res', amount: 300 }],
      visual: { model: 'gen:orc-pit', tint: 'owner' },
      trainer: { trains: ['h-orcs', 'h-orc-pikemen', 'h-orc-archers'], queueSize: 6 },
    },
    {
      // The other half of the faction: one expensive thing that cheap troops
      // cannot answer, gated behind a pit so it is never the opening move.
      id: 'fell-roost', name: 'Fell Roost', kind: 'building', radius: 2.4, hp: 1300,
      armorType: 'structure', xpValue: 30, placement: 'plot', buildTimeTicks: 190,
      cost: [{ resource: 'res', amount: 700 }],
      requires: ['orc-pit'],
      visual: { model: 'gen:fell-roost', tint: 'owner' },
      trainer: { trains: ['h-fell-beasts'], queueSize: 2 },
    },
    {
      id: 'ogre-pen', name: 'Ogre Pen', kind: 'building', radius: 2.4, hp: 1500,
      armorType: 'structure', xpValue: 32, placement: 'plot', buildTimeTicks: 190,
      cost: [{ resource: 'res', amount: 620 }],
      requires: ['orc-pit'],
      visual: { model: 'gen:ogre-pen', tint: 'owner' },
      trainer: { trains: ['h-ogre', 'h-warg-chief', 'h-marksman'], queueSize: 3 },
    },
    {
      id: 'h-ogre', name: 'Ogre', kind: 'unit', radius: 0.95, hp: 0,
      supplyCost: 12, buildTimeTicks: 170,
      cost: [{ resource: 'res', amount: 650 }],
      visual: { model: 'gen:badger-ogre', scale: 1.1, tint: 'owner' },
      horde: { unit: 'ogre', count: 2, spacing: 2.6 },
    },
]

const ABILITIES: AbilityDef[] = [
  {
    // A shout that staggers whatever is around him. Self-centred rather than
    // aimed: the Chieftain's job is to be in the middle of the fight.
    id: 'dread-howl', name: 'Dread Howl', hotkey: 'H', target: 'self',
    hpDelta: -100, range: 0, periodTicks: 170,
    area: { shape: 'circle', radius: 8 },
  },
  {
    // One arrow at one target. Enough to take a hero or a siege engine off the
    // board, which is what the Horde otherwise struggles to do at range.
    id: 'black-arrow', name: 'Black Arrow', hotkey: 'B', target: 'enemy',
    hpDelta: -280, range: 19, periodTicks: 230,
  },
]

// The Horde researches breadth rather than depth: their upgrades touch whole
// mobs at once, which is worth more to fifteen orcs than to nine badgers, and
// is the same trade the faction makes everywhere else.
const UPGRADES: UpgradeDef[] = [
  {
    id: 'crude-blades', name: 'Crude Blades', hotkey: 'F',
    cost: [{ resource: 'res', amount: 650 }], buildTimeTicks: 280,
    soldBy: ['orc-pit'], requires: ['orc-pit'],
    appliesTo: ['orc', 'orc-pikeman', 'warg-chief'],
    damagePct: 22,
  },
  {
    id: 'scavenged-mail', name: 'Scavenged Mail', hotkey: 'V',
    cost: [{ resource: 'res', amount: 750 }], buildTimeTicks: 320,
    soldBy: ['orc-pit'], requires: ['ogre-pen'],
    appliesTo: ['orc', 'orc-archer', 'orc-pikeman'],
    armorPct: 20,
  },
  {
    id: 'barbed-arrows', name: 'Barbed Arrows', hotkey: 'G',
    cost: [{ resource: 'res', amount: 700 }], buildTimeTicks: 300,
    soldBy: ['orc-pit'], requires: ['orc-pit'],
    appliesTo: ['orc-archer', 'marksman'],
    damagePct: 25,
  },
  {
    id: 'goad', name: 'The Goad', hotkey: 'H',
    cost: [{ resource: 'res', amount: 800 }], buildTimeTicks: 300,
    soldBy: ['ogre-pen'], requires: ['ogre-pen'],
    appliesTo: ['ogre', 'fell-beast'],
    damagePct: 20, speedPct: 10,
  },
]

export const FACTION: Faction = {
  id: 'horde',
  name: 'The Horde',
  keep: 'dark-fortress',
  // Cheaper and far more numerous than the badger line it stands opposite —
  // the same muster the shipped maps place for an orc slot.
  startArmy: ['h-orcs', 'h-orc-pikemen', 'h-orc-archers', 'h-orcs', 'h-ogre'],
  entities: ENTITIES,
  abilities: ABILITIES,
  upgrades: UPGRADES,
}
