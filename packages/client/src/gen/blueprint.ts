// Blueprint-driven procedural meshes (MeekoQuest Generation lineage: authored
// data interpreted by a generic builder, so a new doodad is a new blueprint,
// not new code). Render-only — the sim never sees generated geometry, so a bad
// blueprint can degrade visuals but never desync a match.

export type Vec3 = [number, number, number]

// One primitive part of a blueprint. Parts are authored in world units around
// the entity origin (y=0 is the ground) and merged into a single flat-shaded
// vertex-colored geometry.
// Animation group a part belongs to. Groups become separate instanced meshes
// so the renderer can swing them around `pivot` without skinning.
//   'body'   — moves only with the whole-unit matrix (the default)
//   'armL'/'armR' — counter-swing in the walk cycle; armR also chops on attack
//   'weapon' — fires on attack ONLY, never bobs while moving. For siege arms
//              and anything else that would look absurd flapping as it rolls.
export type GenGroupRole = 'body' | 'armL' | 'armR' | 'weapon'

export interface GenPart {
  shape: 'box' | 'cylinder' | 'cone' | 'sphere' | 'capsule' | 'lathe'
  color: string // palette slot name; 'player' is reserved for the owner color
  group?: GenGroupRole
  pivot?: Vec3 // rotation hinge for a non-body group (e.g. the shoulder)
  // shape dimensions (each shape reads the ones it needs)
  size?: Vec3 // box: width, height, depth
  radius?: number
  radiusTop?: number // cylinder taper; defaults to radius
  height?: number
  profile?: [number, number][] // lathe: [radius, y] pairs, bottom to top
  segments?: number // radial segments; low-poly default 7
  // placement (THREE primitives are origin-centered; `at` positions the part)
  at?: Vec3
  rot?: Vec3 // euler XYZ, radians
  scale?: Vec3 // per-axis squash/stretch (ellipsoid rocks, domes)
  // organic wobble: per-vertex displacement, hashed on quantized position so
  // vertices that share a position move together and the surface stays sealed
  jitter?: number
  // scatter: stamp `count` seeded copies with per-copy variation
  count?: number
  spread?: Vec3 // max |offset| per axis per copy
  tilt?: number // max random lean (radians) per copy
  sizeJitter?: number // ± proportional scale per copy
}

export interface GenBlueprint {
  id: string
  seed: number // all randomness derives from this — identical mesh on every client
  palette: Record<string, string> // slot -> '#rrggbb'; the 'player' slot is implicit
  parts: GenPart[]
}
