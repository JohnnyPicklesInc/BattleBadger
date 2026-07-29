import type { GenBlueprint, GenPart, Vec3 } from './blueprint.ts'

// Structure blueprints. All parts stay in the default 'body' group so the
// renderer's under-construction rise (y-scale on the whole matrix) just works.
// Two families: badger stonework (stone + timber, player-colored roofs and
// banners) and the organic MOBA set (hide + membrane in the owner color).
//
// Authored in world units, y=0 at the ground, sized for their def's radius at
// visual.scale 1 unless noted.

const STONE = {
  stone: '#8d8f96',
  stoneDark: '#6c6e76',
  wood: '#6b4a2f',
  woodDark: '#523823',
  thatch: '#c2a25a',
}

// A round stone tower with a player-colored cone roof, optional banner.
function tower(x: number, z: number, r: number, h: number, banner = false): GenPart[] {
  const parts: GenPart[] = [
    { shape: 'cylinder', color: 'stone', radius: r, radiusTop: r * 0.88, height: h, at: [x, h / 2, z], segments: 8 },
    { shape: 'cone', color: 'player', radius: r * 1.18, height: r * 1.6, at: [x, h + r * 0.8, z], segments: 8 },
  ]
  if (banner) {
    parts.push(
      { shape: 'cylinder', color: 'woodDark', radius: 0.05, height: 1.4, at: [x, h + r * 1.6 + 0.5, z] },
      { shape: 'box', color: 'player', size: [0.06, 0.5, 0.7], at: [x, h + r * 1.6 + 1.0, z + 0.38] },
    )
  }
  return parts
}

// Crenellated parapet: merlons ringed around a square top.
function merlons(cx: number, y: number, half: number, n: number): GenPart[] {
  const parts: GenPart[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    parts.push({
      shape: 'box', color: 'stoneDark', size: [0.3, 0.34, 0.3],
      at: [cx + Math.cos(t) * half, y, Math.sin(t) * half],
    })
  }
  return parts
}

// A gabled long-house: timber walls, player ridge roof (two leaned slabs).
function longhouse(w: number, d: number, wallH: number, at: Vec3 = [0, 0, 0]): GenPart[] {
  const [x, , z] = at
  const roofH = w * 0.42
  const slope = Math.atan2(roofH, w / 2)
  const slab = Math.hypot(w / 2, roofH) + 0.15
  return [
    { shape: 'box', color: 'wood', size: [w, wallH, d], at: [x, wallH / 2, z] },
    { shape: 'box', color: 'stoneDark', size: [w * 1.06, 0.25, d * 1.06], at: [x, 0.12, z] },
    { shape: 'box', color: 'player', size: [slab, 0.12, d * 1.04], at: [x - w / 4, wallH + roofH / 2, z], rot: [0, 0, slope] },
    { shape: 'box', color: 'player', size: [slab, 0.12, d * 1.04], at: [x + w / 4, wallH + roofH / 2, z], rot: [0, 0, -slope] },
    { shape: 'box', color: 'woodDark', size: [0.18, 0.18, d * 1.08], at: [x, wallH + roofH, z] },
  ]
}

// ---- badger stonework ----

const fortress: GenBlueprint = {
  id: 'fortress',
  seed: 0xf047,
  palette: STONE,
  parts: [
    // curtain wall block + parapet
    { shape: 'box', color: 'stone', size: [6.4, 1.9, 6.4], at: [0, 0.95, 0] },
    ...merlons(0, 2.05, 3.0, 12),
    // central keep with banner
    { shape: 'box', color: 'stoneDark', size: [3.2, 2.2, 3.2], at: [0, 3.0, 0] },
    { shape: 'cone', color: 'player', radius: 2.4, height: 1.8, at: [0, 5.0, 0], segments: 4, rot: [0, 0.785, 0] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.06, height: 1.6, at: [0, 6.4, 0] },
    { shape: 'box', color: 'player', size: [0.07, 0.55, 0.85], at: [0, 6.9, 0.45] },
    // corner towers
    ...tower(-2.9, -2.9, 0.85, 3.1),
    ...tower(2.9, -2.9, 0.85, 3.1),
    ...tower(-2.9, 2.9, 0.85, 3.1),
    ...tower(2.9, 2.9, 0.85, 3.1),
    // gate
    { shape: 'box', color: 'woodDark', size: [1.7, 1.5, 0.3], at: [0, 0.75, 3.25] },
  ],
}

const watchtower: GenBlueprint = {
  id: 'watchtower',
  seed: 0x707e4,
  palette: STONE,
  parts: [
    { shape: 'cylinder', color: 'stone', radius: 1.05, radiusTop: 0.8, height: 3.6, at: [0, 1.8, 0], segments: 8 },
    { shape: 'cylinder', color: 'stoneDark', radius: 1.0, height: 0.3, at: [0, 3.75, 0], segments: 8 },
    ...merlons(0, 4.05, 0.8, 6),
    { shape: 'cylinder', color: 'woodDark', radius: 0.05, height: 1.3, at: [0, 4.6, 0] },
    { shape: 'box', color: 'player', size: [0.06, 0.45, 0.65], at: [0, 5.05, 0.34] },
  ],
}

const hall: GenBlueprint = {
  id: 'hall',
  seed: 0x4a11,
  palette: STONE,
  parts: [
    ...longhouse(3.4, 4.2, 1.6),
    // porch + chimney
    { shape: 'box', color: 'woodDark', size: [1.3, 1.1, 0.6], at: [0, 0.55, 2.3] },
    { shape: 'box', color: 'stoneDark', size: [0.5, 2.9, 0.5], at: [1.2, 1.45, -1.2] },
  ],
}

const farm: GenBlueprint = {
  id: 'farm',
  seed: 0xfa43,
  palette: { ...STONE, field: '#7f9c4c', fieldDark: '#67853c' },
  parts: [
    ...longhouse(1.7, 2.0, 1.1, [-0.9, 0, -0.7]),
    // crop rows
    { shape: 'box', color: 'field', size: [0.5, 0.18, 2.6], at: [0.7, 0.09, 0.2] },
    { shape: 'box', color: 'fieldDark', size: [0.5, 0.18, 2.6], at: [1.4, 0.09, 0.2] },
    { shape: 'box', color: 'field', size: [0.5, 0.18, 1.4], at: [-0.9, 0.09, 1.3] },
    // haystack
    { shape: 'cone', color: 'thatch', radius: 0.55, height: 0.9, at: [-1.9, 0.45, 0.9], jitter: 0.05 },
  ],
}

const barracks: GenBlueprint = {
  id: 'barracks',
  seed: 0xba44,
  palette: STONE,
  parts: [
    ...longhouse(3.0, 3.8, 1.5),
    // training post outside the door
    { shape: 'cylinder', color: 'woodDark', radius: 0.12, height: 1.2, at: [1.9, 0.6, 1.4] },
    { shape: 'sphere', color: 'thatch', radius: 0.22, at: [1.9, 1.35, 1.4] },
    { shape: 'box', color: 'player', size: [0.06, 0.5, 0.6], at: [0, 2.9, 1.6] },
  ],
}

const archeryRange: GenBlueprint = {
  id: 'archery-range',
  seed: 0xa4c4e4,
  palette: { ...STONE, targetRed: '#c8564a', targetWhite: '#e6e2d6' },
  parts: [
    ...longhouse(2.4, 3.0, 1.3, [-1.0, 0, 0]),
    // target butt downrange
    { shape: 'cylinder', color: 'targetWhite', radius: 0.55, height: 0.18, at: [1.7, 0.85, 0.9], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'targetRed', radius: 0.34, height: 0.2, at: [1.7, 0.85, 0.91], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'targetRed', radius: 0.12, height: 0.22, at: [1.7, 0.85, 0.92], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.07, height: 0.9, at: [1.7, 0.4, 0.55], rot: [0.3, 0, 0] },
  ],
}

const stable: GenBlueprint = {
  id: 'stable',
  seed: 0x57ab1e,
  palette: STONE,
  parts: [
    ...longhouse(3.6, 3.4, 1.3),
    // paddock fence
    { shape: 'cylinder', color: 'woodDark', radius: 0.06, height: 0.7, at: [2.2, 0.35, 1.4], count: 5, spread: [0.15, 0, 1.1] },
    { shape: 'box', color: 'wood', size: [0.08, 0.08, 2.6], at: [2.25, 0.6, 0.6] },
    { shape: 'sphere', color: 'thatch', radius: 0.4, at: [-2.1, 0.3, 1.3], scale: [1.2, 0.7, 1], jitter: 0.06 },
  ],
}

const siegeWorks: GenBlueprint = {
  id: 'siege-works',
  seed: 0x51e9e,
  palette: STONE,
  parts: [
    // open scaffold: four posts, beam deck
    { shape: 'cylinder', color: 'woodDark', radius: 0.12, height: 1.9, at: [-1.7, 0.95, -1.4] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.12, height: 1.9, at: [1.7, 0.95, -1.4] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.12, height: 1.9, at: [-1.7, 0.95, 1.4] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.12, height: 1.9, at: [1.7, 0.95, 1.4] },
    { shape: 'box', color: 'player', size: [4.0, 0.14, 3.3], at: [0, 1.95, 0] },
    // catapult under assembly: base, arm, counterweight
    { shape: 'box', color: 'wood', size: [1.5, 0.4, 1.0], at: [0, 0.35, 0] },
    { shape: 'cylinder', color: 'woodDark', radius: 0.09, height: 2.0, at: [0, 1.0, 0.3], rot: [-0.9, 0, 0] },
    { shape: 'sphere', color: 'stoneDark', radius: 0.3, at: [0, 0.35, -0.75] },
    // stone pile
    { shape: 'sphere', color: 'stone', radius: 0.24, at: [1.3, 0.2, 0.9], count: 4, spread: [0.3, 0.06, 0.25], sizeJitter: 0.3, jitter: 0.04 },
  ],
}

// Build plot: a low flagstone pad with survey pegs — reads as "buildable here".
const plot: GenBlueprint = {
  id: 'plot',
  seed: 0x9107,
  palette: STONE,
  parts: [
    { shape: 'cylinder', color: 'stoneDark', radius: 2.3, height: 0.12, at: [0, 0.06, 0], segments: 10 },
    { shape: 'cylinder', color: 'stone', radius: 1.9, height: 0.14, at: [0, 0.08, 0], segments: 10 },
    { shape: 'cylinder', color: 'woodDark', radius: 0.06, height: 0.5, at: [0, 0.25, -1.5], count: 4, spread: [1.5, 0, 0.4], tilt: 0.12 },
    { shape: 'box', color: 'player', size: [0.05, 0.2, 0.3], at: [0, 0.5, -1.5] },
  ],
}

// ---- the organic MOBA set ----

const FLESH = {
  hide: '#6b4f66',
  hideDark: '#4c3849',
  bone: '#cfc7b4',
}

const cerebrate: GenBlueprint = {
  id: 'cerebrate',
  seed: 0xce4eb,
  palette: FLESH,
  parts: [
    // brain mass: lobed spheres over a hide skirt
    { shape: 'sphere', color: 'hide', radius: 2.3, at: [0, 1.1, 0], scale: [1.15, 0.75, 1.05], jitter: 0.14, segments: 10 },
    { shape: 'sphere', color: 'player', radius: 1.2, at: [0, 2.2, 0], jitter: 0.16, count: 4, spread: [1.0, 0.25, 0.9], sizeJitter: 0.3 },
    { shape: 'lathe', color: 'hideDark', profile: [[3.0, 0], [2.6, 0.5], [1.9, 0.9]], at: [0, 0, 0], segments: 10, jitter: 0.1 },
    // tentacles splayed around the base
    { shape: 'capsule', color: 'hideDark', radius: 0.22, height: 1.6, at: [0, 0.3, 2.9], rot: [1.35, 0, 0], count: 5, spread: [2.6, 0.1, 0.5], tilt: 0.3, sizeJitter: 0.25 },
    // bone spurs
    { shape: 'cone', color: 'bone', radius: 0.18, height: 0.9, at: [0, 2.9, -0.6], rot: [-0.4, 0, 0], count: 3, spread: [0.9, 0.2, 0.4], tilt: 0.3 },
  ],
}

const bastion: GenBlueprint = {
  id: 'bastion',
  seed: 0xba57,
  palette: FLESH,
  parts: [
    { shape: 'lathe', color: 'hideDark', profile: [[1.5, 0], [1.2, 0.5], [0.9, 1.2]], at: [0, 0, 0], segments: 9, jitter: 0.08 },
    { shape: 'cone', color: 'hide', radius: 0.85, height: 3.0, at: [0, 2.6, 0], segments: 7, jitter: 0.07 },
    // glowing player-colored eye near the tip and spur ring
    { shape: 'sphere', color: 'player', radius: 0.3, at: [0, 3.4, 0.35], segments: 6 },
    { shape: 'cone', color: 'bone', radius: 0.12, height: 0.7, at: [0, 1.4, 0], count: 4, spread: [0.8, 0.15, 0.8], tilt: 0.5, sizeJitter: 0.3 },
  ],
}

const spire: GenBlueprint = {
  id: 'spire',
  seed: 0x5914e,
  palette: { ...FLESH, gem: '#b98cff', gemBright: '#dcc5ff' },
  parts: [
    { shape: 'lathe', color: 'hideDark', profile: [[1.6, 0], [1.3, 0.4], [0.8, 0.9]], at: [0, 0, 0], segments: 9, jitter: 0.09 },
    // essence crystals — the map's resource color, not the owner's
    { shape: 'cone', color: 'gem', radius: 0.45, height: 3.6, segments: 5, at: [0, 2.4, 0], count: 3, spread: [0.5, 0.3, 0.5], tilt: 0.16, sizeJitter: 0.25 },
    { shape: 'cone', color: 'gemBright', radius: 0.22, height: 1.8, segments: 5, at: [0.4, 1.7, 0.4], rot: [0, 0, -0.3] },
    { shape: 'sphere', color: 'player', radius: 0.28, at: [0, 0.9, 1.2], segments: 6 },
  ],
}

const hatchery: GenBlueprint = {
  id: 'hatchery',
  seed: 0x4a7c4,
  palette: FLESH,
  parts: [
    { shape: 'sphere', color: 'hide', radius: 1.7, at: [0, 0.55, 0], scale: [1.1, 0.7, 1.1], jitter: 0.11, segments: 9 },
    { shape: 'sphere', color: 'player', radius: 0.65, at: [0, 1.55, 0], scale: [1, 0.75, 1], jitter: 0.09 },
    { shape: 'lathe', color: 'hideDark', profile: [[2.2, 0], [1.9, 0.35], [1.4, 0.6]], at: [0, 0, 0], segments: 10, jitter: 0.09 },
    // egg clutch by the mouth
    { shape: 'sphere', color: 'bone', radius: 0.28, at: [1.6, 0.25, 1.3], scale: [1, 1.25, 1], count: 3, spread: [0.4, 0.05, 0.35], sizeJitter: 0.3 },
    { shape: 'capsule', color: 'hideDark', radius: 0.16, height: 1.0, at: [-1.6, 0.25, 1.4], rot: [1.3, 0, 0], count: 3, spread: [0.7, 0.1, 0.3], tilt: 0.35 },
  ],
}

export const STRUCTURE_BLUEPRINTS: Record<string, GenBlueprint> = {
  fortress,
  watchtower,
  hall,
  farm,
  barracks,
  'archery-range': archeryRange,
  stable,
  'siege-works': siegeWorks,
  plot,
  cerebrate,
  bastion,
  spire,
  hatchery,
}
