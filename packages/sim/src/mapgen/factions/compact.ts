import type { EntityDef } from '../../defs/schema.ts'
import { CRUSH_FOOT, CRUSH_MOUNTED, KEEP_SLOTS, STANCES, TAG_CASTLE, outerBases, type Faction } from './shared.ts'

// The Compact — the only faction that flies, and the only one that can shoot
// at something that does. Expensive per body; it cannot out-mass the Horde or
// out-brawl the Badgers, and its gunfire is useless against masonry, so it
// wins by being somewhere the others cannot reach.

const ENTITIES: EntityDef[] = [
    // The archetypes a StarCraft-shaped army is built from, under their own
    // names — mechanics are not ownable, but somebody else's creature names
    // and designs are. What makes this faction distinct is the third axis the
    // other two do not have: it flies, and it is the only one that can shoot
    // back at something that does.
    //
    // Deliberately expensive per body. It cannot out-mass the Horde or
    // out-brawl the badgers; it wins by being somewhere they cannot reach.
    {
      crushableLevel: CRUSH_FOOT,
      id: 'trooper', name: 'Trooper', kind: 'unit', radius: 0.36, hp: 110,
      armorType: 'infantry', xpValue: 8,
      visual: { model: 'gen:trooper', tint: 'owner' },
      mover: { speed: 4.0 },
      // The line infantry's rifle reaches both layers — the faction's whole
      // point is that it is never helpless against air.
      combat: { damage: 13, range: 8.5, acquire: 11, periodTicks: 12, damageType: 'arrow', hits: 'both' },
    },
    {
      crushableLevel: CRUSH_MOUNTED,
      id: 'lancer', name: 'Lancer', kind: 'unit', radius: 0.4, hp: 150,
      armorType: 'infantry', xpValue: 14,
      chargeGuard: 25,
      visual: { model: 'gen:lancer-trooper', tint: 'owner' },
      mover: { speed: 3.6 },
      // Dedicated anti-air: long reach, useless on the ground.
      combat: { damage: 34, range: 12, acquire: 14, periodTicks: 20, damageType: 'kinetic', hits: 'air' },
    },
    {
      id: 'skiff', name: 'Skiff', kind: 'unit', radius: 0.5, hp: 130,
      armorType: 'archer', xpValue: 16,
      flying: true,
      visual: { model: 'gen:skiff', tint: 'owner' },
      mover: { speed: 6.6 },
      // Fast air harasser. Hits ground only, so two skiff flights cannot
      // contest each other — you need Lancers or a Gunship for that.
      combat: { damage: 16, range: 6.5, acquire: 9, periodTicks: 11, damageType: 'kinetic', hits: 'ground' },
    },
    {
      id: 'gunship', name: 'Gunship', kind: 'unit', radius: 0.7, hp: 340,
      armorType: 'engine', xpValue: 38,
      flying: true,
      visual: { model: 'gen:gunship', scale: 1.15, tint: 'owner' },
      mover: { speed: 4.6 },
      // The premium unit: reaches everything, and nothing on the ground
      // without a rifle can answer it.
      combat: { damage: 30, range: 9, acquire: 12, periodTicks: 16, damageType: 'kinetic', hits: 'both' },
    },

    // ---- Compact tickets: small, expensive squads ----
    {
      id: 'h-troopers', name: 'Troopers', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 9, buildTimeTicks: 110,
      cost: [{ resource: 'res', amount: 420 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'trooper', count: 7, spacing: 1.3, formations: STANCES },
    },
    {
      id: 'h-lancers', name: 'Lancers', kind: 'unit', radius: 0.4, hp: 0,
      supplyCost: 9, buildTimeTicks: 120,
      cost: [{ resource: 'res', amount: 460 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'lancer', count: 5, spacing: 1.4, formations: STANCES },
    },
    {
      id: 'h-skiffs', name: 'Skiff Flight', kind: 'unit', radius: 0.5, hp: 0,
      supplyCost: 10, buildTimeTicks: 130,
      cost: [{ resource: 'res', amount: 520 }],
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'skiff', count: 4, spacing: 2.0, formations: [STANCES[1], STANCES[0]] },
    },
    {
      id: 'h-gunship', name: 'Gunship', kind: 'unit', radius: 0.7, hp: 0,
      supplyCost: 14, buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 780 }],
      visual: { model: 'placeholder:box', tint: 'owner' },
      horde: { unit: 'gunship', count: 2, spacing: 2.6 },
    },
    {
      id: 'compact-plot', name: 'Compact Pad', kind: 'building', radius: 2.6, hp: 100,
      visual: { model: 'gen:plot', tint: 'owner' },
      plot: { accepts: ['farm', 'barrack-block', 'landing-pad', 'watchtower'] },
    },
    {
      // The Compact's seat. Thinner walls than either rival — it expects to
      // hold ground with gunships, not masonry.
      id: 'command-post', name: 'Command Post', kind: 'building', radius: 3.6, hp: 7200,
      armorType: 'structure', xpValue: 200, supplyProvided: 90,
      visual: { model: 'gen:command-post', tint: 'owner' },
      // Its own guns reach both layers, like everything else it fields.
      combat: { damage: 32, range: 13, acquire: 14, periodTicks: 15, damageType: 'kinetic', hits: 'both' },
      trainer: { trains: ['h-troopers'], queueSize: 3 },
      placement: 'plot',
      buildTags: [TAG_CASTLE],
      buildTimeTicks: 460,
      cost: [{ resource: 'res', amount: 2400 }],
      expansion: { plot: 'compact-plot', offsets: KEEP_SLOTS },
    },
    ...outerBases({ id: 'compact', name: 'Compact', plot: 'compact-plot' }),
    {
      id: 'barrack-block', name: 'Barrack Block', kind: 'building', radius: 2.2, hp: 1500,
      armorType: 'structure', xpValue: 26, placement: 'plot', buildTimeTicks: 150,
      cost: [{ resource: 'res', amount: 420 }],
      visual: { model: 'gen:barrack-block', tint: 'owner' },
      trainer: { trains: ['h-troopers', 'h-lancers'], queueSize: 5 },
    },
    {
      id: 'landing-pad', name: 'Landing Pad', kind: 'building', radius: 2.6, hp: 1400,
      armorType: 'structure', xpValue: 34, placement: 'plot', buildTimeTicks: 200,
      cost: [{ resource: 'res', amount: 700 }],
      requires: ['barrack-block'],
      visual: { model: 'gen:landing-pad', tint: 'owner' },
      trainer: { trains: ['h-skiffs', 'h-gunship'], queueSize: 3 },
    },
]

export const FACTION: Faction = {
  id: 'compact',
  name: 'The Compact',
  keep: 'command-post',
  // Fewer bodies, and one of them flies — the Compact opens with air the other
  // two factions have to build towards.
  startArmy: ['h-troopers', 'h-lancers', 'h-skiffs', 'h-troopers'],
  entities: ENTITIES,
}
