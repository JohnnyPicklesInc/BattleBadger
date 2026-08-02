import type { AbilityDef, EntityDef, UpgradeDef } from '../../defs/schema.ts'
import {
  CRUSH_ENGINE, CRUSH_FOOT, CRUSH_MOUNTED, KEEP_SLOTS, KEEP_TOWER_SLOTS, STANCES, TAG_CASTLE,
  outerBases, type Faction,
} from './shared.ts'

// The Badgers — the BFME baseline. Expensive, durable, well-drilled: nine-man
// battalions, cavalry that rides men down, pikes that stop it, and the only
// siege engine in the game. Everything else is measured against this.

const ENTITIES: EntityDef[] = [
    // ---- soldiers (spawned only as horde members; never bought directly) ----
    {
      crushableLevel: CRUSH_FOOT,
      id: 'swordsman', name: 'Swordsman', kind: 'unit', radius: 0.38, hp: 130,
      armorType: 'infantry', xpValue: 6,
      visual: { model: 'gen:badger-sword', tint: 'owner' },
      mover: { speed: 4.2 },
      combat: { damage: 16, range: 0.6, acquire: 9, periodTicks: 9, damageType: 'sword' },
    },
    {
      crushableLevel: CRUSH_FOOT,
      // The spear the horse runs onto. Pikes bite a charger whether or not
      // they were braced for it — without this, cavalry farms loose spearmen
      // and the counter only exists for a player who saw the horses coming.
      chargeGuard: 25,
      id: 'spearman', name: 'Spearman', kind: 'unit', radius: 0.38, hp: 115,
      armorType: 'infantry', xpValue: 6,
      visual: { model: 'gen:badger-spear', scale: 0.95, tint: 'owner' },
      mover: { speed: 4.0 },
      combat: { damage: 13, range: 1.4, acquire: 9, periodTicks: 10, damageType: 'spear' },
    },
    {
      crushableLevel: CRUSH_FOOT,
      id: 'archer', name: 'Archer', kind: 'unit', radius: 0.36, hp: 85,
      armorType: 'archer', xpValue: 7,
      visual: { model: 'gen:badger-bow', scale: 0.9, tint: 'owner' },
      mover: { speed: 4.0 },
      // Long reach is the archer's whole identity: it engages and plants well
      // outside a swordsman's acquire (9), so it shoots before it is reached.
      combat: { damage: 18, range: 13, acquire: 15, periodTicks: 14, damageType: 'arrow', hits: 'both' },
    },
    {
      crushableLevel: CRUSH_MOUNTED, crusherLevel: CRUSH_MOUNTED,
      id: 'rider', name: 'Rider', kind: 'unit', radius: 0.5, hp: 220,
      armorType: 'cavalry', xpValue: 12,
      visual: { model: 'gen:badger-rider', scale: 1.15, tint: 'owner' },
      mover: { speed: 7.6 },
      combat: {
        damage: 26, range: 0.8, acquire: 10, periodTicks: 11, damageType: 'trample',
        // At a gallop the rider rides men down instead of fencing with them:
        // ~3x a swing, a real shove, then a wind-down that forces it to pull
        // out and come round again rather than blending a formation on the spot.
        // What it can flatten comes from crusherLevel, not a list here.
        // Archers are the prize: the damage matrix already multiplies trample
        // by 300% against them, so the impact lands hardest exactly where
        // cavalry is supposed to be terrifying.
        charge: { minSpeed: 5, damage: 55, knockback: 1.8, cooldownTicks: 28, recoilPct: 100,
          // Only 3 ticks. A charge that leaves men down longer stops pikes
          // answering, and the even-cost pike trade is a deliberate design
          // point — measured, 5 ticks already flips it to cavalry.
          knockdownTicks: 3 },
      },
    },
    {
      // A siege engine, not a rifle: it is big, it is slow, and its burning
      // boulder takes a visible moment to arrive — troops can walk out from
      // under it, so it is at its best against walls and packed formations.
      crushableLevel: CRUSH_ENGINE, crusherLevel: CRUSH_ENGINE,
      id: 'catapult', name: 'Catapult', kind: 'unit', radius: 1.15, hp: 320,
      armorType: 'engine', xpValue: 20,
      visual: { model: 'gen:catapult', scale: 1.5, tint: 'owner' },
      mover: { speed: 1.4 },
      combat: {
        damage: 70, range: 16, acquire: 17, periodTicks: 55, damageType: 'siege',
        projectile: { speed: 11, splashRadius: 3.2, edgePct: 40, scatterRadius: 2.4 },
      },
    },
    {
      crushableLevel: CRUSH_FOOT,
      id: 'captain', name: 'Captain', kind: 'unit', radius: 0.5, hp: 900,
      armorType: 'infantry', xpValue: 40,
      visual: { model: 'gen:badger-hero', scale: 1.25, tint: 'owner' },
      mover: { speed: 4.8 },
      combat: { damage: 55, range: 0.9, acquire: 12, periodTicks: 10, damageType: 'sword' },
      abilities: [{ ability: 'rally-cry', autocast: true }, { ability: 'word-of-power' }],
    },
    {
      // A Great Eagle. Air on this ruleset is not a separate game — it is a
      // way past the wall. An eagle ignores the gate entirely, which is
      // exactly why archers on the battlement matter and why it wears cavalry
      // armour: arrows hit it at full rate and nothing else can reach it.
      id: 'eagle', name: 'Great Eagle', kind: 'unit', radius: 0.85, hp: 430,
      armorType: 'cavalry', xpValue: 45,
      flying: true,
      vision: 24,
      // It has to come down to kill. For 26 ticks either side of the strike it
      // is a GROUND target, which is what turns air from a unit that hovers
      // out of reach and grinds an army down into one that commits, hurts, and
      // has to survive the answer.
      swoopTicks: 16,
      visual: { model: 'gen:eagle', scale: 1.2, tint: 'owner' },
      mover: { speed: 7.0 },
      combat: {
        // A heavy blow on a long cycle rather than a fast grinder: the whole
        // unit is now one stoop at a time.
        damage: 82, range: 1.5, acquire: 13, periodTicks: 40, damageType: 'sword', hits: 'both',
        // It snatches and drops. Knockdown is gone — a stoop that also
        // stunlocked the men it landed among left them nothing to answer with.
        splashRadius: 1.2, splashEdgePct: 40, knockback: 3.0,
      },
    },
    {
      // The mounted hero. Rides like cavalry and charges like cavalry, so the
      // pikes that answer riders answer him too — a hero is a very good unit,
      // not an exception to the counter web.
      crushableLevel: CRUSH_MOUNTED, crusherLevel: CRUSH_MOUNTED,
      id: 'marshal', name: 'Marshal', kind: 'unit', radius: 0.55, hp: 1150,
      armorType: 'cavalry', xpValue: 60,
      visual: { model: 'gen:badger-marshal', scale: 1.3, tint: 'owner' },
      mover: { speed: 6.2 },
      vision: 18,
      combat: {
        damage: 72, range: 1.0, acquire: 12, periodTicks: 11, damageType: 'sword',
        charge: { minSpeed: 4.6, damage: 190, knockback: 5.5, cooldownTicks: 70, knockdownTicks: 4, recoilPct: 40 },
      },
      abilities: [{ ability: 'heroic-charge' }, { ability: 'rally-cry', autocast: true }],
    },
    {
      // The archer hero. Outranges everything on foot and can answer a flyer,
      // which is what makes him the counter to the other side's beasts.
      id: 'ranger', name: 'Ranger Captain', kind: 'unit', radius: 0.4, hp: 700,
      armorType: 'archer', xpValue: 55,
      visual: { model: 'gen:badger-ranger', scale: 1.2, tint: 'owner' },
      mover: { speed: 4.8 },
      vision: 22,
      combat: { damage: 58, range: 17, acquire: 18, periodTicks: 13, damageType: 'arrow', hits: 'both' },
      abilities: [{ ability: 'arrow-storm' }],
    },

    // ---- horde tickets: what a barracks actually sells ----
    {
      id: 'h-swordsmen', name: 'Swordsmen', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 90,
      cost: [{ resource: 'res', amount: 300 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'swordsman', count: 9, spacing: 1.15, formations: STANCES },
    },
    {
      id: 'h-spearmen', name: 'Spearmen', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 90,
      cost: [{ resource: 'res', amount: 300 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'spearman', count: 9, spacing: 1.15, formations: STANCES },
    },
    {
      id: 'h-archers', name: 'Archers', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 8, buildTimeTicks: 100,
      cost: [{ resource: 'res', amount: 350 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'archer', count: 8, spacing: 1.25, formations: STANCES },
    },
    {
      id: 'h-riders', name: 'Riders', kind: 'unit', radius: 0.5, hp: 0,
      supplyCost: 12, buildTimeTicks: 140,
      cost: [{ resource: 'res', amount: 500 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: {
        unit: 'rider', count: 5, spacing: 1.8,
        formations: [STANCES[1], STANCES[0]], // cavalry rides in line by default
      },
    },
    {
      id: 'h-catapult', name: 'Catapult', kind: 'unit', radius: 0.7, hp: 0,
      supplyCost: 10, buildTimeTicks: 180,
      cost: [{ resource: 'res', amount: 600 }],
      visual: { model: 'placeholder:box', tint: 'owner' },
      horde: { unit: 'catapult', count: 1, spacing: 2 },
    },
    {
      id: 'h-captain', name: 'Captain', kind: 'unit', radius: 0.5, hp: 0,
      supplyCost: 15, buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 800 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'captain', count: 1, spacing: 2 }, // a hero is a horde of one
    },
    {
      id: 'h-eagles', name: 'Great Eagles', kind: 'unit', radius: 0.85, hp: 0,
      supplyCost: 16, buildTimeTicks: 260,
      cost: [{ resource: 'res', amount: 1000 }],
      visual: { model: 'gen:eagle', scale: 1.2, tint: 'owner' },
      horde: { unit: 'eagle', count: 2, spacing: 3.2 },
    },
    {
      id: 'h-marshal', name: 'Marshal', kind: 'unit', radius: 0.55, hp: 0,
      supplyCost: 18, buildTimeTicks: 240,
      cost: [{ resource: 'res', amount: 1200 }],
      visual: { model: 'gen:badger-marshal', scale: 1.3, tint: 'owner' },
      horde: { unit: 'marshal', count: 1, spacing: 2 }, // a hero is a horde of one
    },
    {
      id: 'h-ranger', name: 'Ranger Captain', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 15, buildTimeTicks: 220,
      cost: [{ resource: 'res', amount: 1000 }],
      visual: { model: 'gen:badger-ranger', scale: 1.2, tint: 'owner' },
      horde: { unit: 'ranger', count: 1, spacing: 2 },
    },
    // ---- plots ----
    {
      id: 'fortress-plot', name: 'Build Plot', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:plot', tint: 'owner' },
      plot: {
        accepts: ['farm', 'barracks', 'archery-range', 'stable', 'siege-works', 'eyrie', 'watchtower'],
      },
    },
    // ---- structures (plot-placed) ----
    {
      id: 'fortress', name: 'Fortress', kind: 'building', radius: 3.6, hp: 9000,
      armorType: 'structure', xpValue: 200, supplyProvided: 90,
      visual: { model: 'gen:fortress', tint: 'owner' },
      combat: { damage: 40, range: 12, acquire: 13, periodTicks: 16, damageType: 'arrow', hits: 'both' },
      trainer: { trains: ['h-captain'], queueSize: 2 },
      // The castle tier is the keep itself, raised again on ground worth it.
      // A price and a tag are the whole of it: a second fortress should be the
      // fortress, not a copy of it that drifts the first time this one is
      // balanced. Pre-placed keeps ignore both — the map spawns them directly.
      placement: 'plot',
      buildTags: [TAG_CASTLE],
      buildTimeTicks: 520,
      cost: [{ resource: 'res', amount: 2800 }],
      expansion: [
        { plot: 'fortress-plot', offsets: KEEP_SLOTS },
        { plot: 'tower-plot', offsets: KEEP_TOWER_SLOTS },
      ],
    },
    ...outerBases({ id: 'badger', name: 'Badger', plot: 'fortress-plot' }),
    {
      id: 'barracks', name: 'Barracks', kind: 'building', radius: 2.2, hp: 1600,
      armorType: 'structure', xpValue: 25, placement: 'plot', buildTimeTicks: 150,
      cost: [{ resource: 'res', amount: 400 }],
      visual: { model: 'gen:barracks', tint: 'owner' },
      trainer: { trains: ['h-swordsmen', 'h-spearmen'], queueSize: 5 },
    },
    {
      id: 'archery-range', name: 'Archery Range', kind: 'building', radius: 2.2, hp: 1400,
      armorType: 'structure', xpValue: 25, placement: 'plot', buildTimeTicks: 150,
      cost: [{ resource: 'res', amount: 450 }],
      visual: { model: 'gen:archery-range', tint: 'owner' },
      trainer: { trains: ['h-archers', 'h-ranger'], queueSize: 5 },
    },
    {
      id: 'stable', name: 'Stable', kind: 'building', radius: 2.4, hp: 1500,
      armorType: 'structure', xpValue: 30, placement: 'plot', buildTimeTicks: 180,
      cost: [{ resource: 'res', amount: 600 }],
      requires: ['barracks'],
      visual: { model: 'gen:stable', tint: 'owner' },
      trainer: { trains: ['h-riders', 'h-marshal'], queueSize: 3 },
    },
    {
      // Where the eagles are called from. Gated behind the archery range: a
      // side that can field air should already have the answer to it.
      id: 'eyrie', name: 'Eyrie', kind: 'building', radius: 2.4, hp: 1400,
      armorType: 'structure', xpValue: 30, placement: 'plot', buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 750 }],
      requires: ['archery-range'],
      visual: { model: 'gen:eyrie', tint: 'owner' },
      trainer: { trains: ['h-eagles'], queueSize: 2 },
    },
    {
      id: 'siege-works', name: 'Siege Works', kind: 'building', radius: 2.4, hp: 1500,
      armorType: 'structure', xpValue: 30, placement: 'plot', buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 700 }],
      requires: ['barracks'],
      visual: { model: 'gen:siege-works', tint: 'owner' },
      trainer: { trains: ['h-catapult'], queueSize: 2 },
    },
]

// The Captain's kit. Owned by the faction, so any map that seats the Badgers
// gets a Captain whose abilities actually exist.
const ABILITIES: AbilityDef[] = [

    {
      id: 'rally-cry', name: 'Rally Cry', hotkey: 'Q', target: 'ally',
      hpDelta: 40, range: 7, periodTicks: 60, autoAcquire: 'injuredAlly',
    },
    {
      // The hero's charge, aimed rather than ridden: a wedge of force out in
      // front of him. Shorter than Word of Power and on a longer leash, so it
      // is the opener for a charge rather than a substitute for one.
      id: 'heroic-charge', name: 'Heroic Charge', hotkey: 'C', target: 'point',
      hpDelta: -130, range: 9, periodTicks: 180,
      area: { shape: 'cone', radius: 9, halfAngleCos: 0.71 },
    },
    {
      // A volley dropped on a spot. The reason to keep an archer hero behind
      // the line rather than in it.
      id: 'arrow-storm', name: 'Arrow Storm', hotkey: 'R', target: 'point',
      hpDelta: -150, range: 20, periodTicks: 220,
      area: { shape: 'circle', radius: 7 },
    },
    {
      // BFME "Word of Power": a wave that sweeps everything in a 45° arc
      // ahead of the Captain. Aimed by clicking — the cone opens from the
      // caster toward the click.
      id: 'word-of-power', name: 'Word of Power', hotkey: 'W', target: 'point',
      hpDelta: -110, range: 9, periodTicks: 140,
      area: { shape: 'cone', radius: 9, halfAngleCos: 0.71 },
    },
]

// Research. Percentages rather than flat numbers, so an upgrade is worth the
// same to a swordsman and to a hero, and so the counter web keeps its shape:
// forged blades make your infantry better at what it was already good at
// rather than papering over what it is bad at.
const UPGRADES: UpgradeDef[] = [
  {
    id: 'forged-blades', name: 'Forged Blades', hotkey: 'F',
    cost: [{ resource: 'res', amount: 800 }], buildTimeTicks: 320,
    soldBy: ['barracks'], requires: ['barracks'],
    appliesTo: ['swordsman', 'spearman', 'captain', 'marshal'],
    damagePct: 25,
  },
  {
    id: 'heavy-armour', name: 'Heavy Armour', hotkey: 'V',
    cost: [{ resource: 'res', amount: 900 }], buildTimeTicks: 360,
    soldBy: ['barracks'], requires: ['stable'],
    appliesTo: ['swordsman', 'spearman', 'rider', 'captain', 'marshal'],
    // Armour is a reduction, and it stacks multiplicatively with everything
    // else, so no pile of upgrades can reach immunity.
    armorPct: 25,
  },
  {
    id: 'fire-arrows', name: 'Fire Arrows', hotkey: 'F',
    cost: [{ resource: 'res', amount: 850 }], buildTimeTicks: 340,
    soldBy: ['archery-range'], requires: ['archery-range'],
    appliesTo: ['archer', 'ranger'],
    damagePct: 30,
  },
  {
    id: 'longbows', name: 'Longbows', hotkey: 'G',
    cost: [{ resource: 'res', amount: 700 }], buildTimeTicks: 300,
    soldBy: ['archery-range'], requires: ['archery-range'],
    appliesTo: ['archer', 'ranger'],
    // Reach, not damage: this is the upgrade that changes where a battle line
    // can stand rather than how hard it hits.
    rangePct: 20,
  },
  {
    id: 'shod-hooves', name: 'Shod Hooves', hotkey: 'H',
    cost: [{ resource: 'res', amount: 600 }], buildTimeTicks: 260,
    soldBy: ['stable'], requires: ['stable'],
    appliesTo: ['rider', 'marshal'],
    speedPct: 12,
  },
  {
    id: 'banded-frames', name: 'Banded Frames', hotkey: 'B',
    cost: [{ resource: 'res', amount: 750 }], buildTimeTicks: 300,
    soldBy: ['siege-works'], requires: ['siege-works'],
    appliesTo: ['catapult'],
    armorPct: 30, rangePct: 10,
  },
]

export const FACTION: Faction = {
  id: 'badgers',
  name: 'Badgers',
  keep: 'fortress',
  // What a badger player musters with when the lobby seats them. Mirrors what
  // the shipped maps place by hand: a line of swords, spears and bows with a
  // wing of cavalry and a captain to lead them.
  startArmy: ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-riders', 'h-captain'],
  entities: ENTITIES,
  abilities: ABILITIES,
  upgrades: UPGRADES,
}
