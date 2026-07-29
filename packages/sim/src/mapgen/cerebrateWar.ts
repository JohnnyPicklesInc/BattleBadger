import type { MapRegion, PlacedDoodad, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { GameDef } from '../defs/schema.ts'

// "Cerebrate War" — a full-scale Aeon-of-Strife MOBA, expressed entirely as
// data. Two Cerebrates in opposite corners, three lanes (top / mid / bot) with
// three Bastion towers apiece, a Spire per lane whose fall unleashes elite
// creeps in that lane, tree-choked jungle pockets, waves that escalate on a
// clock, and an Essence economy. Each player summons a levelling Champion at
// their Hatchery and re-summons it when it falls — the price and the wait are
// the death penalty. Destroy the enemy Cerebrate to win.
//
// Six player slots on alternating teams, so the same map plays 1v1, 2v2 or
// 3v3 — setupMatch drops content owned by absent slots. Slots 6 and 7 are
// reserved AI "war slots" (teams 0 and 1): they own the Cerebrates, towers,
// Spires and every lane creep, marked `always` so they exist regardless of
// player count. Players own exactly their Champion, the mercenaries they buy,
// and their Hatchery.
//
// Everything here is map data: no sim changes. Design notes:
//   * Lanes are enforced by *terrain*, not waypoint triggers. The three lanes
//     only connect at the two bases, and jungle is dead-end pockets, so A* has
//     no shortcut and creeps stay in their lane. (Routing them with
//     `orderUnits` waypoints would also yank any hero crossing the region —
//     that action has an owner filter but no def filter.)
//   * Nobody can select or command the war itself: creeps and lane
//     structures belong to the AI slots, so the stage-march triggers below
//     (which filter by owner) can never sweep up a player's Champion.
//   * The Champion is a horde-of-one *trained* at the Hatchery, never
//     pre-placed: only the trainer path binds a horde, and only hordes hold
//     experience. That constraint becomes the respawn mechanic.
//   * The damage/armor matrix is what makes it feel like a MOBA: towers shred
//     creeps but only dent Champions, creeps barely scratch structures, and
//     Ravagers (siege) are the real tower-killers — so pushing a lane needs
//     the wave, not just a fed hero.

const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_SAND = 3
const TEX_JUNGLE = 5

const SIZE = 176
const BASE_A = { x: 26, z: 150 } // team 0, south-west
const BASE_B = { x: 150, z: 26 } // team 1, north-east
const LANE_HALF = 5.5 // lane corridors are ~11 wide — towers don't wall them off
const PLAZA_R = 15 // base plazas sit on tier-1 high ground behind ramps
const WAVE_PERIOD = 20 // seconds between waves
const AI = (side: 0 | 1): number => 6 + side // reserved war slots, teams 0/1
const TIER_AT = [0, 180, 360, 600] // seconds each wave tier joins in

interface Pt {
  x: number
  z: number
}

const MOBA_DEF: GameDef = {
  schema: 1,
  id: 'cerebrate-war',
  name: 'Cerebrate War',
  resources: [{ id: 'essence', name: 'Essence', startAmount: 2000, uiColor: '#b98cff' }],

  // ---- the rock-paper-scissors that makes lanes work ----
  // arcane = tower fire, swarm = melee creeps, pierce = ranged creeps,
  // strike = champions, siege = ravagers/brutes vs walls.
  damageTypes: ['swarm', 'pierce', 'strike', 'siege', 'arcane'],
  armorTypes: ['light', 'medium', 'hero', 'fortified'],
  damageTable: [
    // structures only really fall to siege — a bare hero can't raze a lane
    { damage: 'swarm', armor: 'fortified', pct: 35 },
    { damage: 'pierce', armor: 'fortified', pct: 30 },
    { damage: 'strike', armor: 'fortified', pct: 50 },
    { damage: 'siege', armor: 'fortified', pct: 250 },
    // tower fire clears waves fast but only dents a champion — dives are
    // survivable, farming under tower is not
    { damage: 'arcane', armor: 'light', pct: 175 },
    { damage: 'arcane', armor: 'medium', pct: 130 },
    { damage: 'arcane', armor: 'hero', pct: 80 },
    // champions carve up creeps; siege engines are terrible in a brawl
    { damage: 'strike', armor: 'light', pct: 140 },
    { damage: 'siege', armor: 'light', pct: 70 },
    { damage: 'siege', armor: 'hero', pct: 50 },
  ],

  // Veterancy ladder shared by every horde — which here means champions and
  // mercenary bands; loose lane creeps only ever *give* experience.
  hordeLevels: [
    { xp: 0, damagePct: 100, damageTakenPct: 100 },
    { xp: 120, damagePct: 110, damageTakenPct: 96 },
    { xp: 320, damagePct: 122, damageTakenPct: 92 },
    { xp: 650, damagePct: 135, damageTakenPct: 86 },
    { xp: 1100, damagePct: 150, damageTakenPct: 80 },
    { xp: 1700, damagePct: 170, damageTakenPct: 72 },
  ],

  entities: [
    // ---- structures ----
    {
      id: 'cerebrate', name: 'Cerebrate', kind: 'building', radius: 2.6, hp: 5000,
      armorType: 'fortified',
      visual: { model: 'gen:cerebrate', tint: 'owner' },
      combat: { damage: 34, range: 10, acquire: 11, periodTicks: 8, damageType: 'arcane' },
    },
    {
      id: 'core-bastion', name: 'Core Bastion', kind: 'building', radius: 1.5, hp: 2200,
      armorType: 'fortified', xpValue: 180,
      visual: { model: 'gen:bastion', scale: 1.15, tint: 'owner' },
      combat: { damage: 60, range: 9, acquire: 10, periodTicks: 10, damageType: 'arcane' },
    },
    {
      id: 'bastion', name: 'Bastion', kind: 'building', radius: 1.4, hp: 1500,
      armorType: 'fortified', xpValue: 120,
      visual: { model: 'gen:bastion', tint: 'owner' },
      combat: { damage: 46, range: 8.5, acquire: 9.5, periodTicks: 11, damageType: 'arcane' },
    },
    // One Spire def per lane so `unitDies` can tell which lane fell.
    {
      id: 'spire-top', name: 'Top Spire', kind: 'building', radius: 1.6, hp: 2000,
      armorType: 'fortified', xpValue: 200,
      visual: { model: 'gen:spire', tint: 'owner' },
    },
    {
      id: 'spire-mid', name: 'Mid Spire', kind: 'building', radius: 1.6, hp: 2000,
      armorType: 'fortified', xpValue: 200,
      visual: { model: 'gen:spire', tint: 'owner' },
    },
    {
      id: 'spire-bot', name: 'Bot Spire', kind: 'building', radius: 1.6, hp: 2000,
      armorType: 'fortified', xpValue: 200,
      visual: { model: 'gen:spire', tint: 'owner' },
    },
    {
      // The MOBA "shop + fountain": passive income, summons your champion and
      // mercenaries, and its rally point aims them at a lane. Lose it and that
      // income — and your re-summon point — are gone for good.
      id: 'hatchery', name: 'Hatchery', kind: 'building', radius: 1.8, hp: 1600,
      armorType: 'fortified', xpValue: 100,
      visual: { model: 'gen:hatchery', scale: 0.9, tint: 'owner' },
      trainer: { trains: ['champion', 'brute-pack', 'seer'], queueSize: 2 },
      income: { resource: 'essence', amount: 8, perTicks: 50 },
    },

    // ---- the champion: a horde of one, so it levels ----
    {
      id: 'hero', name: 'Champion', kind: 'unit', radius: 0.55, hp: 950,
      armorType: 'hero', xpValue: 350,
      visual: { model: 'gen:badger-hero', scale: 1.35, tint: 'owner' },
      mover: { speed: 4.2 },
      combat: { damage: 38, range: 1.5, acquire: 8, periodTicks: 7, damageType: 'strike' },
      abilities: [{ ability: 'siphon' }, { ability: 'blizzard' }, { ability: 'fan-of-knives' }],
    },
    {
      // Trainer ticket — never itself an entity in the world (hp 0).
      id: 'champion', name: 'Champion', kind: 'unit', radius: 0.55, hp: 0,
      cost: [{ resource: 'essence', amount: 250 }], buildTimeTicks: 60,
      visual: { model: 'gen:badger-hero', scale: 1.35, tint: 'owner' },
      horde: { unit: 'hero', count: 1, spacing: 2 }, // a hero is a horde of one
    },

    // ---- lane creeps (loose units — they feed XP, never gain it) ----
    {
      id: 'swarmling', name: 'Swarmling', kind: 'unit', radius: 0.34, hp: 40,
      armorType: 'light', xpValue: 12,
      visual: { model: 'gen:gnasher', scale: 0.8, tint: 'owner' },
      mover: { speed: 3.8 },
      combat: { damage: 6, range: 0.45, acquire: 9, periodTicks: 8, damageType: 'swarm' },
    },
    {
      id: 'spitter', name: 'Spitter', kind: 'unit', radius: 0.38, hp: 50,
      armorType: 'light', xpValue: 16,
      visual: { model: 'placeholder:cone', tint: 'owner' },
      mover: { speed: 3.2 },
      combat: { damage: 9, range: 5.5, acquire: 10, periodTicks: 12, damageType: 'pierce' },
    },
    {
      id: 'hunter', name: 'Hunter', kind: 'unit', radius: 0.5, hp: 170,
      armorType: 'medium', xpValue: 30,
      visual: { model: 'gen:gnasher', scale: 1.25, tint: 'owner' },
      mover: { speed: 3.0 },
      combat: { damage: 15, range: 0.7, acquire: 9, periodTicks: 10, damageType: 'swarm' },
    },
    {
      id: 'mender', name: 'Mender', kind: 'unit', radius: 0.36, hp: 60,
      armorType: 'light', xpValue: 20,
      visual: { model: 'gen:badger-staff', tint: 'owner' },
      mover: { speed: 3.2 },
      abilities: [{ ability: 'mend', autocast: true }],
    },
    {
      // The wave's tower-killer. Siege damage: monstrous vs structures,
      // feeble vs anything that moves.
      id: 'ravager', name: 'Ravager', kind: 'unit', radius: 0.6, hp: 260,
      armorType: 'medium', xpValue: 50,
      visual: { model: 'placeholder:box', scale: 1.5, tint: 'owner' },
      mover: { speed: 2.6 },
      combat: { damage: 40, range: 6.5, acquire: 9, periodTicks: 22, damageType: 'siege' },
    },
    // ---- elite creeps: unlocked in a lane when the enemy Spire there falls ----
    {
      id: 'swarmling-elite', name: 'Elite Swarmling', kind: 'unit', radius: 0.38, hp: 95,
      armorType: 'medium', xpValue: 30,
      visual: { model: 'gen:gnasher', scale: 1, tint: 'owner' },
      mover: { speed: 4 },
      combat: { damage: 13, range: 0.5, acquire: 9, periodTicks: 8, damageType: 'swarm' },
    },
    {
      id: 'hunter-elite', name: 'Elite Hunter', kind: 'unit', radius: 0.55, hp: 340,
      armorType: 'medium', xpValue: 60,
      visual: { model: 'gen:gnasher', scale: 1.45, tint: 'owner' },
      mover: { speed: 3.2 },
      combat: { damage: 28, range: 0.8, acquire: 9, periodTicks: 10, damageType: 'swarm' },
    },

    // ---- mercenaries: essence sinks, trained as hordes so they level too ----
    {
      id: 'brute', name: 'Brute', kind: 'unit', radius: 0.55, hp: 400,
      armorType: 'medium', xpValue: 40,
      visual: { model: 'gen:gnasher', scale: 1.55, tint: 'owner' },
      mover: { speed: 3.2 },
      combat: { damage: 26, range: 0.8, acquire: 8, periodTicks: 9, damageType: 'swarm' },
    },
    {
      id: 'brute-pack', name: 'Brute Pack', kind: 'unit', radius: 0.55, hp: 0,
      cost: [{ resource: 'essence', amount: 350 }], buildTimeTicks: 120,
      visual: { model: 'gen:gnasher', scale: 1.55, tint: 'owner' },
      horde: { unit: 'brute', count: 3, spacing: 1.3 },
    },
    {
      id: 'seer-unit', name: 'Seer', kind: 'unit', radius: 0.4, hp: 180,
      armorType: 'light', xpValue: 45,
      visual: { model: 'gen:badger-staff', scale: 1.2, tint: 'owner' },
      mover: { speed: 3.2 },
      combat: { damage: 20, range: 6.5, acquire: 8, periodTicks: 14, damageType: 'pierce' },
      abilities: [{ ability: 'mend', autocast: true }],
    },
    {
      id: 'seer', name: 'Seer', kind: 'unit', radius: 0.4, hp: 0,
      cost: [{ resource: 'essence', amount: 200 }], buildTimeTicks: 90,
      visual: { model: 'gen:badger-staff', scale: 1.2, tint: 'owner' },
      horde: { unit: 'seer-unit', count: 1, spacing: 2 },
    },

    // ---- scenery ----
    {
      id: 'gloomtree', name: 'Gloomtree', kind: 'doodad', radius: 0.55, hp: 0, // indestructible
      visual: { model: 'gen:gloomtree', scale: 1.3, tint: 'none' },
    },
  ],
  abilities: [
    {
      id: 'mend', name: 'Mend', hotkey: 'Q', target: 'ally',
      hpDelta: 6, range: 4.5, periodTicks: 8, autoAcquire: 'injuredAlly',
    },
    {
      id: 'siphon', name: 'Siphon', hotkey: 'W', target: 'enemy',
      hpDelta: -70, range: 5.5, periodTicks: 40,
    },
    {
      // WC3 Blizzard: a ground-targeted storm. Long cooldown, wide circle —
      // the wave-clear button, not a duelling tool.
      id: 'blizzard', name: 'Blizzard', hotkey: 'C', target: 'point',
      hpDelta: -45, range: 9, periodTicks: 90,
      area: { shape: 'circle', radius: 3.2 },
    },
    {
      // Fan of Knives: instant burst centred on the champion, for when the
      // wave has already collapsed on top of you.
      id: 'fan-of-knives', name: 'Fan of Knives', hotkey: 'V', target: 'self',
      hpDelta: -40, range: 0, periodTicks: 75,
      area: { shape: 'circle', radius: 3.6 },
    },
  ],
  victory: { mode: 'triggersOnly' }, // only a fallen Cerebrate ends the game
}

// ---- lane geometry -------------------------------------------------------
// Three polylines from base A to base B. Top hugs the west then north edge,
// bot the south then east, mid runs the diagonal.
const LANES: { id: 'top' | 'mid' | 'bot'; path: Pt[] }[] = [
  { id: 'top', path: [BASE_A, { x: BASE_A.x, z: BASE_B.z }, BASE_B] },
  { id: 'mid', path: [BASE_A, BASE_B] },
  { id: 'bot', path: [BASE_A, { x: BASE_B.x, z: BASE_A.z }, BASE_B] },
]

// Explicit sqrt of a sum of squares. The single-call hypotenuse helper is not
// bit-exact across engines, so check-sim-purity.mjs bans it.
const dist = (a: Pt, b: Pt): number => {
  const dx = b.x - a.x
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dz * dz)
}

const laneLength = (path: Pt[]): number => path.slice(1).reduce((sum, p, i) => sum + dist(path[i], p), 0)

// Point at fraction t (0..1) along a polyline.
function along(path: Pt[], t: number): Pt {
  const segs = path.slice(1).map((p, i) => dist(path[i], p))
  const total = segs.reduce((a, b) => a + b, 0)
  let want = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const f = segs[i] === 0 ? 0 : want / segs[i]
      return { x: path[i].x + (path[i + 1].x - path[i].x) * f, z: path[i].z + (path[i + 1].z - path[i].z) * f }
    }
    want -= segs[i]
  }
  return path[path.length - 1]
}

// Integer-hash value noise for terrain detail. Whitelisted ops only.
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

export function generateCerebrateWar(seed: number): RtsMapDoc {
  const n = SIZE * SIZE
  // WC3-style cliff terrain: the world is a tier-2 rock highland; lanes and
  // jungle are canyons carved down to tier 0, and each base plaza is a tier-1
  // island reached by three ramps — MOBA high ground. deriveTerrain turns the
  // tier borders into crisp cliff walls; the explicit walkable layer then
  // blanks the highland top so nothing ever paths up there.
  const cliffLevel = Array.from({ length: n }, () => 2)
  const ramp = Array.from({ length: n }, () => 0)
  const texture = Array.from({ length: n }, () => TEX_ROCK)
  const heightJitter = Array.from({ length: n }, () => 0)
  const idx = (x: number, z: number): number => z * SIZE + x
  const noiseSeed = (seed ^ 0xc3b3) | 0

  const carveDisc = (c: Pt, r: number, tex: number, level: number): void => {
    const x0 = Math.max(2, Math.floor(c.x - r))
    const x1 = Math.min(SIZE - 3, Math.ceil(c.x + r))
    const z0 = Math.max(2, Math.floor(c.z - r))
    const z1 = Math.min(SIZE - 3, Math.ceil(c.z + r))
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - c.x
        const dz = z + 0.5 - c.z
        if (dx * dx + dz * dz > r * r) continue
        cliffLevel[idx(x, z)] = level
        texture[idx(x, z)] = tex
      }
    }
  }

  const carvePath = (path: Pt[], half: number, tex: number): void => {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]
      const b = path[i + 1]
      const steps = Math.max(1, Math.ceil(dist(a, b) * 2))
      for (let s = 0; s <= steps; s++) {
        const f = s / steps
        carveDisc({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }, half, tex, 0)
      }
    }
  }

  // Lanes first with a grass fringe, then a narrower dirt road down the middle
  // so the corridors read as roads through grassland rather than flat stripes.
  for (const lane of LANES) carvePath(lane.path, LANE_HALF, TEX_GRASS)
  for (const lane of LANES) carvePath(lane.path, 3.2, TEX_DIRT)

  // Jungle pockets. Each connects to exactly ONE lane by a short spur, so it is
  // a dead end — heroes can lurk there, but no creep ever finds a shortcut.
  // Two mirrored triangles of four pockets each.
  const pockets: { at: Pt; to: Pt }[] = [
    { at: { x: 48, z: 48 }, to: along(LANES[0].path, 0.45) }, // NW triangle
    { at: { x: 38, z: 92 }, to: along(LANES[0].path, 0.2) },
    { at: { x: 92, z: 38 }, to: along(LANES[0].path, 0.75) },
    { at: { x: 70, z: 70 }, to: along(LANES[1].path, 0.5) },
    { at: { x: 128, z: 128 }, to: along(LANES[2].path, 0.45) }, // SE triangle
    { at: { x: 138, z: 84 }, to: along(LANES[2].path, 0.8) },
    { at: { x: 84, z: 138 }, to: along(LANES[2].path, 0.25) },
    { at: { x: 106, z: 106 }, to: along(LANES[1].path, 0.5) },
  ]
  for (const p of pockets) {
    carvePath([p.at, p.to], 2.6, TEX_JUNGLE)
    carveDisc(p.at, 8.5, TEX_JUNGLE, 0)
  }

  // Base plazas: tier-1 high ground with a sand floor…
  carveDisc(BASE_A, PLAZA_R, TEX_SAND, 1)
  carveDisc(BASE_B, PLAZA_R, TEX_SAND, 1)
  // …reached by a dirt ramp where each lane meets the plaza rim.
  for (const base of [BASE_A, BASE_B]) {
    for (const lane of LANES) {
      const t = base === BASE_A ? PLAZA_R / laneLength(lane.path) : 1 - PLAZA_R / laneLength(lane.path)
      const mouth = along(lane.path, t)
      const x0 = Math.max(2, Math.floor(mouth.x - 6))
      const x1 = Math.min(SIZE - 3, Math.ceil(mouth.x + 6))
      const z0 = Math.max(2, Math.floor(mouth.z - 6))
      const z1 = Math.min(SIZE - 3, Math.ceil(mouth.z + 6))
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - mouth.x
          const dz = z + 0.5 - mouth.z
          if (dx * dx + dz * dz > 6 * 6) continue
          if (cliffLevel[idx(x, z)] === 2) continue // never ramp into the highland
          ramp[idx(x, z)] = 1
          texture[idx(x, z)] = TEX_DIRT
        }
      }
    }
  }

  // The explicit walkable layer: everything still on the tier-2 highland is
  // solid rock — walls, not walkable mesa top.
  const walkable = cliffLevel.map((l) => (l === 2 ? 0 : 1))

  // Rolling value-noise relief: gentle on the canyon floors, flattened around
  // each base, strong and craggy on the highland so the walls read as massif.
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = idx(x, z)
      if (cliffLevel[i] === 2) {
        heightJitter[i] = 0.6 + valueNoise(noiseSeed, x * 0.11, z * 0.11) * 2.4 + valueNoise(noiseSeed ^ 7, x * 0.31, z * 0.31) * 0.7
        continue
      }
      let h = valueNoise(noiseSeed, x * 0.08, z * 0.08) * 0.55 + valueNoise(noiseSeed ^ 13, x * 0.27, z * 0.27) * 0.2
      for (const base of [BASE_A, BASE_B]) {
        const dx = x + 0.5 - base.x
        const dz = z + 0.5 - base.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < PLAZA_R + 3) h *= smooth(Math.max(0, Math.min(1, (d - 6) / (PLAZA_R - 4))))
      }
      if (ramp[i] === 1) h *= 0.3 // ramps stay clean
      heightJitter[i] = h
    }
  }

  // Gloomtrees: blocking scenery scattered through the pocket floors (never on
  // the spur mouths, which stay dirt-free by the hash). Deterministic pattern —
  // no RNG on the map-build path.
  const doodads: PlacedDoodad[] = []
  for (let z = 2; z < SIZE - 2; z++) {
    for (let x = 2; x < SIZE - 2; x++) {
      if (texture[idx(x, z)] !== TEX_JUNGLE || walkable[idx(x, z)] !== 1) continue
      if ((x * 31 + z * 17 + ((x * z) % 7)) % 13 !== 0) continue // ~8% of jungle floor
      doodads.push({ def: 'gloomtree', x: x + 0.5, z: z + 0.5, rot: ((x * 5 + z * 3) % 8) / 8 })
    }
  }

  // ---- structures ----------------------------------------------------------
  const placed: PlacedEntity[] = [
    { def: 'cerebrate', owner: AI(0), x: BASE_A.x, z: BASE_A.z, always: true },
    { def: 'cerebrate', owner: AI(1), x: BASE_B.x, z: BASE_B.z, always: true },
  ]

  // Towers march outward from each base: t=.20/.31/.42 for team 0, mirrored for
  // team 1. Spires sit just outside the plaza at t=.13 / .87.
  for (const lane of LANES) {
    for (const t of [0.2, 0.31, 0.42]) {
      const a = along(lane.path, t)
      const b = along(lane.path, 1 - t)
      placed.push({ def: 'bastion', owner: AI(0), x: a.x, z: a.z, always: true })
      placed.push({ def: 'bastion', owner: AI(1), x: b.x, z: b.z, always: true })
    }
    const sa = along(lane.path, 0.13)
    const sb = along(lane.path, 0.87)
    placed.push({ def: `spire-${lane.id}`, owner: AI(0), x: sa.x, z: sa.z, always: true })
    placed.push({ def: `spire-${lane.id}`, owner: AI(1), x: sb.x, z: sb.z, always: true })
  }

  // two core bastions flanking each Cerebrate
  for (const [side, base, sign] of [
    [0, BASE_A, 1],
    [1, BASE_B, -1],
  ] as const) {
    placed.push({ def: 'core-bastion', owner: AI(side), x: base.x + 6 * sign, z: base.z - 4 * sign, always: true })
    placed.push({ def: 'core-bastion', owner: AI(side), x: base.x + 4 * sign, z: base.z - 6.5 * sign, always: true })
  }

  // Per-player Hatchery, fanned around the owning team's plaza. Champions are
  // NOT pre-placed — each player summons theirs at the Hatchery (and re-summons
  // after death; the essence cost and build time are the death penalty).
  // setupMatch drops any slot the match doesn't have.
  const startLocations: Pt[] = []
  for (let slot = 0; slot < 6; slot++) {
    const team = slot % 2
    const base = team === 0 ? BASE_A : BASE_B
    const sign = team === 0 ? 1 : -1
    const k = Math.floor(slot / 2) // 0..2 within the team
    startLocations.push({ x: base.x + sign * (5 + k * 2.2), z: base.z - sign * (7.5 - k * 2.2) })
    placed.push({ def: 'hatchery', owner: slot, x: base.x - sign * (2 + k * 3), z: base.z + sign * (7 + k * 0.6) })
  }

  // ---- regions -------------------------------------------------------------
  // One spawn box per lane per side, set just outside the plaza so a wave order
  // can't sweep up a hero sitting on the Cerebrate.
  const regions: MapRegion[] = []
  const box = (id: string, name: string, c: Pt, r: number): void => {
    regions.push({ id, name, x0: c.x - r, z0: c.z - r, x1: c.x + r, z1: c.z + r })
  }
  // Waves march in three trigger-driven stages — spawn box → own lane's
  // corner → enemy lane mouth → up the ramp — because each leg must be
  // LOCALLY shortest inside its own lane. A single order to anywhere near the
  // far base lets A* discover that the mid diagonal beats an L-shaped lane by
  // ~15% and funnels every wave through mid. The boxes double as re-animation
  // zones: each stage's periodic trigger re-orders anything idling there.
  for (const lane of LANES) {
    box(`s0-${lane.id}`, `Team 1 ${lane.id} spawn`, along(lane.path, 0.1), 4.5)
    box(`s1-${lane.id}`, `Team 2 ${lane.id} spawn`, along(lane.path, 0.9), 4.5)
    box(`c-${lane.id}`, `${lane.id} corner`, along(lane.path, 0.5), 4.5)
  }

  // ---- triggers ------------------------------------------------------------
  const triggers: TriggerDef[] = []
  const enemyBase = (side: 0 | 1): Pt => (side === 0 ? BASE_B : BASE_A)

  // Wave tiers. Every tier shares the same 20 s clock and stacks on top of the
  // ones before it, so lanes thicken as the match runs long.
  const TIERS: { def: string; count: number }[][] = [
    [{ def: 'swarmling', count: 3 }, { def: 'spitter', count: 1 }],
    [{ def: 'hunter', count: 2 }],
    [{ def: 'mender', count: 1 }],
    [{ def: 'ravager', count: 1 }],
  ]
  for (const lane of LANES) {
    for (const side of [0, 1] as const) {
      const region = `s${side}-${lane.id}`
      // Stage-one target: this lane's own corner. Near enough that no
      // cross-lane route can beat the in-lane leg.
      const goal = along(lane.path, 0.5)
      TIERS.forEach((units, tier) => {
        triggers.push({
          id: `${region}-t${tier}`,
          name: `${lane.id} wave t${tier} (team ${side + 1})`,
          events: [{ type: 'timer', seconds: WAVE_PERIOD, periodic: true }],
          conditions: tier === 0 ? [] : [{ type: 'elapsed', seconds: TIER_AT[tier] }],
          actions: [
            ...units.map((u) => ({
              type: 'spawnUnits' as const, def: u.def, owner: AI(side), count: u.count, at: { region }, always: true,
            })),
            { type: 'orderUnits', region, owner: AI(side), order: 'attackMove', x: goal.x, z: goal.z },
          ],
        })
      })

      // Elite wave — off until the enemy Spire in this lane falls.
      triggers.push({
        id: `${region}-elite`,
        name: `${lane.id} elite wave (team ${side + 1})`,
        initiallyOn: false,
        events: [{ type: 'timer', seconds: WAVE_PERIOD, periodic: true }],
        conditions: [],
        actions: [
          { type: 'spawnUnits', def: 'swarmling-elite', owner: AI(side), count: 2, at: { region }, always: true },
          { type: 'spawnUnits', def: 'hunter-elite', owner: AI(side), count: 1, at: { region }, always: true },
          { type: 'orderUnits', region, owner: AI(side), order: 'attackMove', x: goal.x, z: goal.z },
        ],
      })

      // Losing your Spire upgrades the *other* side's wave in this lane: their
      // elite wave switches on and their basic tier-0 wave switches off. Elites
      // replace rather than stack — the lane gets stronger, not bigger, so a
      // long game escalates in quality without snowballing the unit count.
      const other = side === 0 ? 1 : 0
      triggers.push({
        id: `spire-${lane.id}-${side}-falls`,
        name: `${lane.id} Spire falls (team ${side + 1})`,
        once: true,
        events: [{ type: 'unitDies', owner: AI(side), def: `spire-${lane.id}` }],
        conditions: [],
        actions: [
          { type: 'setTrigger', trigger: `s${other}-${lane.id}-elite`, on: true },
          { type: 'setTrigger', trigger: `s${other}-${lane.id}-t0`, on: false },
          { type: 'message', text: `The ${lane.id} Spire of Team ${side + 1} has fallen — elite broods march!`, to: 'all' },
        ],
      })
    }
  }

  // Stages two and three of the march. Corner box → enemy lane mouth; mouth
  // box → up the ramp at the Cerebrate. Both re-fire every 10 s, which also
  // re-animates any wave that stalled and went idle in a crowd. The owner
  // filter is the AI slot, so no player unit is ever swept into these orders.
  for (const lane of LANES) {
    for (const side of [0, 1] as const) {
      const mouth = along(lane.path, side === 0 ? 0.9 : 0.1)
      const goal = enemyBase(side)
      triggers.push({
        id: `advance-${side}-${lane.id}`,
        name: `${lane.id} advance (team ${side + 1})`,
        events: [{ type: 'timer', seconds: 10, periodic: true }],
        conditions: [],
        actions: [
          { type: 'orderUnits', region: `c-${lane.id}`, owner: AI(side), order: 'attackMove', x: mouth.x, z: mouth.z },
        ],
      })
      triggers.push({
        id: `assault-${side}-${lane.id}`,
        name: `${lane.id} assault (team ${side + 1})`,
        events: [{ type: 'timer', seconds: 10, periodic: true }],
        conditions: [],
        actions: [
          {
            type: 'orderUnits',
            region: `s${side === 0 ? 1 : 0}-${lane.id}`,
            owner: AI(side),
            order: 'attackMove',
            x: goal.x,
            z: goal.z,
          },
        ],
      })
    }
  }

  // Kill bounty: essence whenever the other team loses something. It fires
  // once per tick in which any enemy died, not once per corpse — the Hatchery's
  // passive income is what keeps the economy honest.
  for (const side of [0, 1] as const) {
    const other = side === 0 ? 1 : 0
    const losses = [side, side + 2, side + 4, AI(side)] // team's players + its war slot
    const paid = [other, other + 2, other + 4] // enemy humans only
    triggers.push({
      id: `bounty-${side}`, name: `bounty for team ${other + 1}`,
      events: losses.map((owner) => ({ type: 'unitDies' as const, owner })),
      conditions: [],
      actions: paid.map((owner) => ({
        type: 'modifyResource' as const, owner, resource: 'essence', delta: 15,
      })),
    })
  }

  // A fallen champion is re-summoned by its player, not by a trigger — tell
  // them where to go.
  for (let slot = 0; slot < 6; slot++) {
    triggers.push({
      id: `fallen-${slot}`,
      name: `champion down p${slot + 1}`,
      events: [{ type: 'unitDies', owner: slot, def: 'hero' }],
      conditions: [],
      actions: [
        { type: 'message', text: 'Your Champion has fallen — re-summon it at your Hatchery.', to: slot },
      ],
    })
  }

  // Win condition: the Cerebrate, and nothing else. victory.mode is
  // 'triggersOnly', so razing every tower does not end the match.
  for (const side of [0, 1] as const) {
    triggers.push({
      id: `cerebrate-${side}-falls`,
      name: `Cerebrate ${side + 1} destroyed`,
      once: true,
      events: [{ type: 'unitDies', owner: AI(side), def: 'cerebrate' }],
      conditions: [],
      actions: [
        { type: 'message', text: `The Cerebrate of Team ${side + 1} is dead!`, to: 'all' },
        { type: 'victory', player: side === 0 ? 1 : 0 },
      ],
    })
  }

  triggers.push({
    id: 'intro', name: 'intro', once: true,
    events: [{ type: 'mapInit' }],
    conditions: [],
    actions: [
      { type: 'message', text: 'Summon your Champion at the Hatchery. Push the lanes, break the Spires, kill the Cerebrate.', to: 'all' },
      ...Array.from({ length: 6 }, (_, slot) => {
        const b = slot % 2 === 0 ? BASE_A : BASE_B
        return { type: 'panCamera' as const, player: slot, x: b.x, z: b.z }
      }),
    ],
  })

  return {
    version: 2,
    name: 'cerebrate-war',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    fog: 'full',
    startLocations,
    slotTeams: [0, 1, 0, 1, 0, 1, 0, 1],
    regions,
    triggers,
    placed,
    doodads,
    gameDef: MOBA_DEF,
  }
}
