import type { AbilityDef, EntityDef } from '../../defs/schema.ts'
import { CRUSH_ENGINE, CRUSH_FOOT, CRUSH_MOUNTED, KEEP_SLOTS, STANCES, type Faction } from './shared.ts'

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
      // A BFME troll in badger form: huge, slow, and swinging a club that
      // throws whatever it connects with. Too heavy to be ridden down, heavy
      // enough to flatten foot it walks over, but it is not siege — a wall
      // shrugs it off.
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
      id: 'h-ogre', name: 'Ogre', kind: 'unit', radius: 0.95, hp: 0,
      supplyCost: 12, buildTimeTicks: 170,
      cost: [{ resource: 'res', amount: 650 }],
      visual: { model: 'gen:badger-ogre', scale: 1.1, tint: 'owner' },
      horde: { unit: 'ogre', count: 2, spacing: 2.6 },
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
    // ---- plots ----
    {
      id: 'fortress-plot', name: 'Build Plot', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:plot', tint: 'owner' },
      plot: {
        accepts: ['farm', 'barracks', 'archery-range', 'stable', 'siege-works', 'watchtower'],
      },
    },
    // ---- structures (plot-placed) ----
    {
      id: 'fortress', name: 'Fortress', kind: 'building', radius: 3.6, hp: 9000,
      armorType: 'structure', xpValue: 200, supplyProvided: 90,
      visual: { model: 'gen:fortress', tint: 'owner' },
      combat: { damage: 40, range: 12, acquire: 13, periodTicks: 16, damageType: 'arrow', hits: 'both' },
      trainer: { trains: ['h-captain'], queueSize: 2 },
      expansion: { plot: 'fortress-plot', offsets: KEEP_SLOTS },
    },
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
      trainer: { trains: ['h-archers'], queueSize: 5 },
    },
    {
      id: 'stable', name: 'Stable', kind: 'building', radius: 2.4, hp: 1500,
      armorType: 'structure', xpValue: 30, placement: 'plot', buildTimeTicks: 180,
      cost: [{ resource: 'res', amount: 600 }],
      requires: ['barracks'],
      visual: { model: 'gen:stable', tint: 'owner' },
      trainer: { trains: ['h-riders'], queueSize: 3 },
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
      // BFME "Word of Power": a wave that sweeps everything in a 45° arc
      // ahead of the Captain. Aimed by clicking — the cone opens from the
      // caster toward the click.
      id: 'word-of-power', name: 'Word of Power', hotkey: 'W', target: 'point',
      hpDelta: -110, range: 9, periodTicks: 140,
      area: { shape: 'cone', radius: 9, halfAngleCos: 0.71 },
    },
]

export const FACTION: Faction = {
  id: 'badgers',
  name: 'Badgers',
  keep: 'fortress',
  entities: ENTITIES,
  abilities: ABILITIES,
}
