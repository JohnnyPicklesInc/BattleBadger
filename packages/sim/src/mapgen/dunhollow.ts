import type { MapRegion, PlacedDoodad, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { GameDef } from '../defs/schema.ts'

// "Siege of Dunhollow" — a Battle for Middle-earth style skirmish, expressed
// entirely as GameDef + map data. What makes it play like BFME rather than
// like a StarCraft clone:
//
//   * No harvesters. Farms pay a passive trickle, and farms crowded together
//     pay less each — expansion is spatial, not a worker-count problem.
//   * No free base building. Structures only go on plots: six around each
//     fortress, plus neutral settlements out on the map worth fighting over.
//   * Battalions, not soldiers. A barracks trains a *horde*: nine men, one
//     command-point charge, one selection, one XP track, one formation.
//   * Rock-paper-scissors lives in the damage/armor matrix: spears gut cavalry,
//     cavalry runs down archers, archers shred infantry, catapults level walls
//     and are useless against anything that moves.
//   * Heroes are hordes of one, so veterancy works on them for free.
//
// Everything above is data. The only engine features it leans on are income,
// plots, hordes/formations and veterancy.

const SIZE = 160
const BASE_A = { x: 30, z: 128 } // player 0, south-west
const BASE_B = { x: 128, z: 30 } // player 1, north-east
const RIDGE_HALF = 9 // the ridge runs along x ≈ z, dividing the two corners
const GATES = [
  { x: 44, z: 44 }, // north pass
  { x: 116, z: 116 }, // south pass
]
const GATE_R = 13

// Crush hierarchy: a charge flattens anything strictly below its own level.
// Foot troops go down under hooves; horses do not ride over other horses, a
// siege engine, or a wall. Buildings default to uncrushable in compile.ts.
const CRUSH_FOOT = 1
const CRUSH_MOUNTED = 2
const CRUSH_ENGINE = 3

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_SAND = 3
const TEX_FOREST = 5

// The six expansion slots ringing a fortress.
const FORTRESS_SLOTS = [
  { dx: 9, dz: 0 },
  { dx: -9, dz: 0 },
  { dx: 0, dz: 9 },
  { dx: 0, dz: -9 },
  { dx: 7, dz: 7 },
  { dx: -7, dz: -7 },
]

const STANCES = [
  { id: 'block', name: 'Block', kind: 'block' as const, hotkey: 'B' },
  { id: 'line', name: 'Line', kind: 'line' as const, hotkey: 'L', damagePct: 110, speedPct: 115 },
  {
    id: 'porcupine',
    name: 'Porcupine',
    kind: 'ring' as const,
    hotkey: 'O',
    // Set to receive cavalry: braced men are as hard to ride down as a horse,
    // so a charge into them is refused outright and breaks on the spears.
    crushableLevel: CRUSH_MOUNTED,
    damageTakenPct: 55,
    speedPct: 45,
  },
]

export const DUNHOLLOW_DEF: GameDef = {
  schema: 1,
  id: 'dunhollow',
  name: 'Siege of Dunhollow',
  resources: [{ id: 'res', name: 'Resources', startAmount: 4000, uiColor: '#ffd75e' }],
  supplyName: 'Command Points',
  supplyHardCap: 120,

  damageTypes: ['sword', 'arrow', 'spear', 'siege', 'trample'],
  armorTypes: ['infantry', 'archer', 'cavalry', 'structure', 'engine'],
  // Only the interesting pairs are listed; everything else is 100%.
  damageTable: [
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
  ],

  // Shared by hordes and heroes. Index 0 is level 1 and must be the baseline.
  hordeLevels: [
    { xp: 0, damagePct: 100, damageTakenPct: 100 },
    { xp: 40, damagePct: 115, damageTakenPct: 94 },
    { xp: 120, damagePct: 132, damageTakenPct: 88 },
    { xp: 280, damagePct: 152, damageTakenPct: 80 },
    { xp: 600, damagePct: 175, damageTakenPct: 70 },
  ],

  entities: [
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
      combat: { damage: 18, range: 13, acquire: 15, periodTicks: 14, damageType: 'arrow' },
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
    {
      id: 'settlement', name: 'Settlement', kind: 'building', radius: 2.6, hp: 100,
      // 'none': a neutral pad belongs to nobody. Its owner field is only a
      // placement slot, and tinting it would paint it as player 0's property.
      visual: { model: 'gen:plot', tint: 'none' },
      plot: { accepts: ['farm', 'watchtower'], neutral: true },
    },

    // ---- structures (plot-placed) ----
    {
      id: 'fortress', name: 'Fortress', kind: 'building', radius: 3.6, hp: 9000,
      armorType: 'structure', xpValue: 200, supplyProvided: 90,
      visual: { model: 'gen:fortress', tint: 'owner' },
      combat: { damage: 40, range: 12, acquire: 13, periodTicks: 16, damageType: 'arrow' },
      trainer: { trains: ['h-captain'], queueSize: 2 },
      expansion: { plot: 'fortress-plot', offsets: FORTRESS_SLOTS },
    },
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
      trainer: { trains: ['h-catapult', 'h-ogre'], queueSize: 2 },
    },
    {
      id: 'watchtower', name: 'Watchtower', kind: 'building', radius: 1.4, hp: 1200,
      armorType: 'structure', xpValue: 20, placement: 'plot', buildTimeTicks: 90,
      cost: [{ resource: 'res', amount: 250 }],
      visual: { model: 'gen:watchtower', tint: 'owner' },
      combat: { damage: 30, range: 14, acquire: 15, periodTicks: 18, damageType: 'arrow' },
    },

    // ---- scenery ----
    {
      id: 'boulder', name: 'Boulder', kind: 'doodad', radius: 1.1, hp: 0,
      visual: { model: 'gen:boulder', scale: 1.1 },
    },
    {
      id: 'pine', name: 'Pine', kind: 'doodad', radius: 0.8, hp: 0,
      visual: { model: 'gen:pine', scale: 1.3 },
    },
  ],

  abilities: [
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
  ],

  victory: { mode: 'triggersOnly' },
}

// Deterministic LCG — the same seed lays out the same world on every client.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Circle {
  x: number
  z: number
  r: number
}

const inside = (c: Circle, x: number, z: number): boolean => {
  const dx = x - c.x
  const dz = z - c.z
  return dx * dx + dz * dz <= c.r * c.r
}

// Points along a polyline, used to paint roads and to keep them clear.
function alongPath(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = []
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]
    const b = pts[k + 1]
    const len = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z))
    const n = Math.max(1, Math.ceil(len / step))
    for (let i = 0; i <= n; i++) {
      out.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n })
    }
  }
  return out
}

export function generateDunhollow(seed = 20260727): RtsMapDoc {
  const n = SIZE * SIZE
  const cliffLevel = Array.from<number>({ length: n }).fill(0)
  const ramp = Array.from<number>({ length: n }).fill(0)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)
  const next = rng(seed)

  // The bases sit in opposite corners (south-west and north-east), so the
  // ground that divides them is the x ≈ z diagonal. Getting this wrong puts
  // both fortresses on the same plateau with cliff bands around their bases —
  // the map-sanity test below exists because that is exactly what happened.
  const onRidge = (x: number, z: number): boolean => Math.abs(x - z) < RIDGE_HALF
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      if (!onRidge(x, z)) continue
      const i = z * SIZE + x
      cliffLevel[i] = 1
      texture[i] = TEX_ROCK
    }
  }
  // Two passes through the ridge. Wider than the band, so each is a real
  // corridor rather than a notch a formation can't fit through.
  for (const gate of GATES) {
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        const i = z * SIZE + x
        if (cliffLevel[i] !== 1 || !inside({ ...gate, r: GATE_R }, x, z)) continue
        ramp[i] = 1
        texture[i] = TEX_DIRT
      }
    }
  }

  // Settlements: four per side plus one on each pass, all worth fighting for.
  const settlements = [
    { x: 30, z: 92 }, { x: 62, z: 126 }, { x: 18, z: 74 }, { x: 76, z: 142 },
    { x: 130, z: 68 }, { x: 98, z: 34 }, { x: 142, z: 86 }, { x: 84, z: 18 },
    { x: GATES[0].x - 14, z: GATES[0].z + 14 }, { x: GATES[1].x + 14, z: GATES[1].z - 14 },
  ]

  // A standing army at each fortress, mustered as BATTALIONS rather than
  // loose men: these are horde tickets, so setupMatch spawns each as a bound
  // horde with its formation, veterancy track and command-point cost intact.
  // Riders in particular need this — cavalry fights as a pack.
  const STARTING_ARMY = ['h-swordsmen', 'h-spearmen', 'h-archers', 'h-riders', 'h-catapult', 'h-captain']

  // Spread the battalions along the flank of each fortress, clear of its ring
  // of build plots. Laid out inline rather than via systems/orders: this file
  // is imported by scripts/gen-starter-maps.mjs under plain Node, so it must
  // not reach the sim's runtime import chain.
  const muster = (owner: number, base: { x: number; z: number }, sign: number): PlacedEntity[] =>
    STARTING_ARMY.map((def, k) => ({
      def,
      owner,
      x: base.x + sign * 15 + (k - 2.5) * 5.5,
      z: base.z + sign * 15,
    }))

  const placed: PlacedEntity[] = [
    { def: 'fortress', owner: 0, x: BASE_A.x, z: BASE_A.z },
    { def: 'fortress', owner: 1, x: BASE_B.x, z: BASE_B.z },
    ...muster(0, BASE_A, 1),
    ...muster(1, BASE_B, -1),
    // Neutral settlements: outer plots worth pushing for. Owner 0 is only a
    // placement slot — `neutral` is what decides who may build.
    ...settlements.map((s) => ({ def: 'settlement', owner: 0, x: s.x, z: s.z })),
  ]

  // ---- roads: base → each pass → enemy base, painted dirt and kept clear ----
  const roads = [
    alongPath([BASE_A, { x: GATES[0].x - 10, z: GATES[0].z + 10 }, GATES[0], { x: GATES[0].x + 10, z: GATES[0].z - 10 }, BASE_B], 2),
    alongPath([BASE_A, { x: GATES[1].x - 10, z: GATES[1].z + 10 }, GATES[1], { x: GATES[1].x + 10, z: GATES[1].z - 10 }, BASE_B], 2),
  ].flat()
  for (const p of roads) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.floor(p.x) + dx
        const z = Math.floor(p.z) + dz
        if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) continue
        const i = z * SIZE + x
        if (texture[i] === TEX_GRASS) texture[i] = TEX_DIRT
      }
    }
  }

  // ---- keep-out list: bases and their plot rings, settlements, passes, roads
  const clear: Circle[] = [
    { x: BASE_A.x, z: BASE_A.z, r: 20 },
    { x: BASE_B.x, z: BASE_B.z, r: 20 },
    ...settlements.map((s) => ({ x: s.x, z: s.z, r: 9 })),
    ...GATES.map((g) => ({ x: g.x, z: g.z, r: GATE_R + 3 })),
    ...roads.map((p) => ({ x: p.x, z: p.z, r: 4 })),
  ]
  const isClear = (x: number, z: number): boolean => !clear.some((c) => inside(c, x, z))

  // ---- doodads: clumped, not sprinkled. Woods block movement, so they shape
  // the fight as much as the ridge does — hence the clearings above.
  const doodads: PlacedDoodad[] = []
  const paintUnder = (x: number, z: number, r: number, tex: number): void => {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = Math.floor(x) + dx
        const cz = Math.floor(z) + dz
        if (cx < 0 || cz < 0 || cx >= SIZE || cz >= SIZE) continue
        if (dx * dx + dz * dz > r * r) continue
        const i = cz * SIZE + cx
        if (texture[i] === TEX_GRASS) texture[i] = tex
      }
    }
  }
  // woods
  for (let attempt = 0, made = 0; attempt < 400 && made < 26; attempt++) {
    const cx = 8 + next() * (SIZE - 16)
    const cz = 8 + next() * (SIZE - 16)
    if (!isClear(cx, cz) || onRidge(cx, cz)) continue
    made++
    const spread = 5 + next() * 5
    paintUnder(cx, cz, Math.ceil(spread) + 1, TEX_FOREST)
    const trees = 7 + Math.floor(next() * 9)
    for (let t = 0; t < trees; t++) {
      const x = cx + (next() - 0.5) * spread * 2
      const z = cz + (next() - 0.5) * spread * 2
      if (x < 3 || z < 3 || x > SIZE - 3 || z > SIZE - 3 || !isClear(x, z)) continue
      doodads.push({ def: 'pine', x, z, rot: next() * 6.28, scale: 0.9 + next() * 0.7 })
    }
  }
  // rock outcrops, hugging the ridge where the ground is already stone
  for (let attempt = 0, made = 0; attempt < 300 && made < 18; attempt++) {
    const cx = 6 + next() * (SIZE - 12)
    const cz = 6 + next() * (SIZE - 12)
    if (!isClear(cx, cz) || Math.abs(cx - cz) > RIDGE_HALF + 16) continue
    made++
    paintUnder(cx, cz, 4, TEX_ROCK)
    const rocks = 2 + Math.floor(next() * 4)
    for (let t = 0; t < rocks; t++) {
      const x = cx + (next() - 0.5) * 7
      const z = cz + (next() - 0.5) * 7
      if (x < 3 || z < 3 || x > SIZE - 3 || z > SIZE - 3 || !isClear(x, z)) continue
      doodads.push({ def: 'boulder', x, z, rot: next() * 6.28, scale: 0.8 + next() * 0.9 })
    }
  }
  // sandy clearings around every settlement so they read as places
  for (const s of settlements) paintUnder(s.x, s.z, 7, TEX_SAND)

  // Micro-relief: render-only, but it stops the ground reading as a flat sheet.
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x
      const h = ((Math.imul((x + 1) ^ ((z + 1) << 8), 0x9e3779b1) >>> 20) / 4096 - 0.5) * 0.5
      heightJitter[i] = cliffLevel[i] === 1 && ramp[i] === 0 ? h * 1.8 : h
    }
  }

  const regions: MapRegion[] = [
    { id: 'ridge', name: 'The Ridge', x0: 0, z0: 0, x1: SIZE, z1: SIZE },
    { id: 'north-pass', name: 'North Pass', x0: GATES[0].x - 12, z0: GATES[0].z - 12, x1: GATES[0].x + 12, z1: GATES[0].z + 12 },
    { id: 'south-pass', name: 'South Pass', x0: GATES[1].x - 12, z0: GATES[1].z - 12, x1: GATES[1].x + 12, z1: GATES[1].z + 12 },
  ]

  const triggers: TriggerDef[] = [
    {
      id: 'intro', name: 'intro', once: true,
      events: [{ type: 'mapInit' }],
      conditions: [],
      actions: [
        {
          type: 'message',
          to: 'all',
          text: 'Build on your fortress plots. Farms pay less when crowded. Take the settlements.',
        },
        { type: 'panCamera', player: 0, x: BASE_A.x, z: BASE_A.z },
        { type: 'panCamera', player: 1, x: BASE_B.x, z: BASE_B.z },
      ],
    },
  ]
  for (const side of [0, 1] as const) {
    triggers.push({
      id: `fortress-${side}-falls`,
      name: `Fortress ${side + 1} destroyed`,
      once: true,
      events: [{ type: 'unitDies', owner: side, def: 'fortress' }],
      conditions: [],
      actions: [
        { type: 'message', text: `The fortress of Player ${side + 1} has fallen!`, to: 'all' },
        { type: 'victory', player: side === 0 ? 1 : 0 },
      ],
    })
  }

  return {
    version: 2,
    name: 'dunhollow',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    fog: 'full',
    startLocations: [
      { x: BASE_A.x, z: BASE_A.z },
      { x: BASE_B.x, z: BASE_B.z },
    ],
    slotTeams: [0, 1, 0, 1],
    placed,
    doodads,
    regions,
    triggers,
    gameDef: DUNHOLLOW_DEF,
  }
}
