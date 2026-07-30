import type { EntityDef } from '../../defs/schema.ts'
import { CRUSH_FOOT, CRUSH_MOUNTED, KEEP_SLOTS, STANCES, type Faction } from './shared.ts'

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

    // ---- Horde tickets: big, cheap battalions ----
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
      id: 'horde-plot', name: 'Horde Plot', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:plot', tint: 'owner' },
      plot: { accepts: ['farm', 'orc-pit', 'ogre-pen', 'watchtower'] },
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
      expansion: { plot: 'horde-plot', offsets: KEEP_SLOTS },
    },
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
      id: 'ogre-pen', name: 'Ogre Pen', kind: 'building', radius: 2.4, hp: 1500,
      armorType: 'structure', xpValue: 32, placement: 'plot', buildTimeTicks: 190,
      cost: [{ resource: 'res', amount: 620 }],
      requires: ['orc-pit'],
      visual: { model: 'gen:ogre-pen', tint: 'owner' },
      trainer: { trains: ['h-ogre'], queueSize: 2 },
    },
]

export const FACTION: Faction = {
  id: 'horde',
  name: 'The Horde',
  keep: 'dark-fortress',
  entities: ENTITIES,
}
