// Procedural mesh blueprints: authored data interpreted by a generic builder,
// so a new model is a new blueprint rather than new code.
//
// These types live in the sim package NOT because the simulation uses them —
// it never does — but because a map document can carry its own blueprints, so
// the format is part of the map schema. The sim treats them as opaque payload,
// exactly like the embedded glTF in AssetRef, and they ride the map content
// hash for free.

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

// ---- validation -------------------------------------------------------

// Blueprints arrive from map files other people wrote, so they are checked the
// same way triggers and game rules are: reject with a message an author can act
// on, rather than letting a typo become a silent placeholder box at match time.
//
// The caps exist because a blueprint is a geometry program. Nothing here is a
// balance decision — they are the point past which a shared map would stall the
// machine of whoever opened it.
const MAX_BLUEPRINTS = 256
const MAX_PARTS = 256
const MAX_COPIES = 512 // per part
const MAX_TOTAL_COPIES = 4096 // per blueprint

const SHAPES = new Set(['box', 'cylinder', 'cone', 'sphere', 'capsule', 'lathe'])
const ROLES = new Set(['body', 'armL', 'armR', 'weapon'])
const NUMBERS = ['radius', 'radiusTop', 'height', 'segments', 'jitter', 'count', 'tilt', 'sizeJitter'] as const
const VECTORS = ['pivot', 'size', 'at', 'rot', 'scale', 'spread'] as const

function checkVec3(where: string, key: string, v: unknown): void {
  if (v === undefined) return
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`${where}: "${key}" must be three finite numbers`)
  }
}

function checkPart(where: string, p: unknown, palette: Record<string, string>): number {
  if (typeof p !== 'object' || p === null) throw new Error(`${where}: part must be an object`)
  const part = p as Record<string, unknown>
  if (!SHAPES.has(part.shape as string)) {
    throw new Error(`${where}: unknown shape "${String(part.shape)}" (${[...SHAPES].join(', ')})`)
  }
  if (typeof part.color !== 'string') throw new Error(`${where}: "color" must be a palette slot name`)
  // A missing slot renders grey and looks like a lighting bug, so name it now.
  if (part.color !== 'player' && palette[part.color] === undefined) {
    throw new Error(`${where}: color "${part.color}" is not in the palette`)
  }
  if (part.group !== undefined && !ROLES.has(part.group as string)) {
    throw new Error(`${where}: unknown group "${String(part.group)}" (${[...ROLES].join(', ')})`)
  }
  for (const key of NUMBERS) {
    const v = part[key]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error(`${where}: "${key}" must be a finite number`)
    }
  }
  for (const key of VECTORS) checkVec3(where, key, part[key])
  if (part.profile !== undefined) {
    if (!Array.isArray(part.profile) || part.profile.length < 2) {
      throw new Error(`${where}: "profile" needs at least two [radius, y] pairs`)
    }
    for (const pt of part.profile) {
      if (!Array.isArray(pt) || pt.length !== 2 || pt.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        throw new Error(`${where}: "profile" entries must be [radius, y] number pairs`)
      }
    }
  }
  const copies = (part.count as number) ?? 1
  if (copies < 1 || copies > MAX_COPIES) throw new Error(`${where}: "count" must be 1..${MAX_COPIES}`)
  const segments = part.segments as number | undefined
  if (segments !== undefined && (segments < 3 || segments > 64)) {
    throw new Error(`${where}: "segments" must be 3..64`)
  }
  return copies
}

/**
 * Check a map's authored blueprints, throwing on the first problem. Returns the
 * same list typed, so a caller can validate and assign in one step.
 */
export function validateBlueprints(list: unknown): GenBlueprint[] {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new Error('blueprints must be an array')
  if (list.length > MAX_BLUEPRINTS) throw new Error(`too many blueprints (${list.length} > ${MAX_BLUEPRINTS})`)
  const seen = new Set<string>()
  for (const bp of list as Record<string, unknown>[]) {
    if (typeof bp !== 'object' || bp === null) throw new Error('blueprint must be an object')
    const id = bp.id
    if (typeof id !== 'string' || id.length === 0) throw new Error('blueprint needs a string "id"')
    // Duplicates would shadow each other with no error, and which one won would
    // depend on array order — the same trap composeDef guards for entity ids.
    if (seen.has(id)) throw new Error(`duplicate blueprint id "${id}"`)
    seen.add(id)
    const where = `blueprint "${id}"`
    if (typeof bp.seed !== 'number' || !Number.isFinite(bp.seed)) throw new Error(`${where}: "seed" must be a number`)
    if (typeof bp.palette !== 'object' || bp.palette === null || Array.isArray(bp.palette)) {
      throw new Error(`${where}: "palette" must be an object of slot -> color`)
    }
    const palette = bp.palette as Record<string, string>
    for (const [slot, color] of Object.entries(palette)) {
      if (typeof color !== 'string') throw new Error(`${where}: palette slot "${slot}" must be a color string`)
    }
    if (!Array.isArray(bp.parts) || bp.parts.length === 0) throw new Error(`${where}: "parts" must be a non-empty array`)
    if (bp.parts.length > MAX_PARTS) throw new Error(`${where}: too many parts (${bp.parts.length} > ${MAX_PARTS})`)
    let total = 0
    bp.parts.forEach((p, i) => {
      total += checkPart(`${where} part ${i}`, p, palette)
    })
    if (total > MAX_TOTAL_COPIES) throw new Error(`${where}: too many shapes (${total} > ${MAX_TOTAL_COPIES})`)
  }
  return list as GenBlueprint[]
}
