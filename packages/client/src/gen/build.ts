import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rngFloat, rngFromSeed } from '@battlebadger/sim'
import type { GenBlueprint, GenGroupRole, GenPart, Vec3 } from './blueprint.ts'
import { GEN_BLUEPRINTS } from './registry.ts'

// One animation group of a built blueprint: merged geometry plus the hinge the
// renderer rotates it around (world units, already visual.scale-adjusted).
export interface GenGroup {
  role: GenGroupRole
  pivot: Vec3
  geometry: THREE.BufferGeometry
}

const NEUTRAL = new THREE.Color('#9aa4ae') // 'player' slot when the def has no owner tint

// Integer-hash on quantized position → [-1, 1). Shared vertices hash alike, so
// jittered surfaces stay watertight (same trick as mapgen's cellHash).
function posHash(seed: number, x: number, y: number, z: number, axis: number): number {
  let h = (seed ^ Math.imul(axis + 1, 0x9e3779b1)) | 0
  h = Math.imul(h ^ Math.round(x * 200), 0x27d4eb2f)
  h = (h ^ (h >>> 15)) | 0
  h = Math.imul(h ^ Math.round(y * 200), 0x165667b1)
  h = (h ^ (h >>> 13)) | 0
  h = Math.imul(h ^ Math.round(z * 200), 0x85ebca6b)
  h = (h ^ (h >>> 16)) | 0
  return ((h >>> 0) / 4294967296) * 2 - 1
}

function partGeometry(p: GenPart): THREE.BufferGeometry {
  const seg = p.segments ?? 7
  switch (p.shape) {
    case 'box': {
      const [w, h, d] = p.size ?? [1, 1, 1]
      return new THREE.BoxGeometry(w, h, d)
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(p.radiusTop ?? p.radius ?? 0.5, p.radius ?? 0.5, p.height ?? 1, seg)
    case 'cone':
      return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, seg)
    case 'sphere':
      return new THREE.SphereGeometry(p.radius ?? 0.5, seg, Math.max(4, seg - 2))
    case 'capsule':
      return new THREE.CapsuleGeometry(p.radius ?? 0.5, p.height ?? 1, 3, seg)
    case 'lathe': {
      const pts = (p.profile ?? [[0.5, 0], [0.3, 1]]).map(([r, y]) => new THREE.Vector2(r, y))
      return new THREE.LatheGeometry(pts, seg)
    }
  }
}

// Interpret a blueprint into per-group flat-shaded, vertex-colored triangle
// soups. Parts are walked in authored order whatever their group, so the RNG
// stream — and therefore the mesh — never depends on how parts are grouped.
export function buildGenGroups(bp: GenBlueprint, playerColor: THREE.Color | null = null): GenGroup[] {
  const rng = rngFromSeed(bp.seed >>> 0)
  const buckets = new Map<GenGroupRole, { pivot: Vec3; pieces: THREE.BufferGeometry[] }>()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  for (const p of bp.parts) {
    const slot = p.color === 'player' ? undefined : bp.palette[p.color]
    const color = p.color === 'player' ? (playerColor ?? NEUTRAL) : new THREE.Color(slot ?? '#999a9e')
    const copies = p.count ?? 1
    for (let c = 0; c < copies; c++) {
      // non-indexed = flat facets once normals are computed on the merged soup
      const g = partGeometry(p).toNonIndexed()
      g.deleteAttribute('normal')
      g.deleteAttribute('uv')

      const at = p.at ?? [0, 0, 0]
      const spread: Vec3 = p.spread ?? [0, 0, 0]
      const off = (axis: number): number =>
        copies > 1 || p.spread ? (rngFloat(rng) * 2 - 1) * spread[axis] : 0
      pos.set(at[0] + off(0), at[1] + off(1), at[2] + off(2))
      const rot = p.rot ?? [0, 0, 0]
      const lean = (): number => (p.tilt ? (rngFloat(rng) * 2 - 1) * p.tilt : 0)
      const yaw = copies > 1 ? rngFloat(rng) * Math.PI * 2 : 0
      quat.setFromEuler(new THREE.Euler(rot[0] + lean(), rot[1] + yaw, rot[2] + lean()))
      const s = 1 + (p.sizeJitter ? (rngFloat(rng) * 2 - 1) * p.sizeJitter : 0)
      const ps = p.scale ?? [1, 1, 1]
      scl.set(ps[0] * s, ps[1] * s, ps[2] * s)
      g.applyMatrix4(new THREE.Matrix4().compose(pos, quat, scl))

      const positions = g.getAttribute('position') as THREE.BufferAttribute
      if (p.jitter) {
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i)
          const y = positions.getY(i)
          const z = positions.getZ(i)
          positions.setXYZ(
            i,
            x + posHash(bp.seed, x, y, z, 0) * p.jitter,
            y + posHash(bp.seed, x, y, z, 1) * p.jitter,
            z + posHash(bp.seed, x, y, z, 2) * p.jitter,
          )
        }
      }
      const colors = new Float32Array(positions.count * 3)
      for (let i = 0; i < positions.count; i++) {
        colors[i * 3] = color.r
        colors[i * 3 + 1] = color.g
        colors[i * 3 + 2] = color.b
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3))

      const role = p.group ?? 'body'
      let bucket = buckets.get(role)
      if (!bucket) {
        bucket = { pivot: [0, 0, 0], pieces: [] }
        buckets.set(role, bucket)
      }
      if (p.pivot) bucket.pivot = p.pivot
      bucket.pieces.push(g)
    }
  }
  const groups: GenGroup[] = []
  for (const [role, b] of buckets) {
    const merged = mergeGeometries(b.pieces, false) ?? new THREE.BufferGeometry()
    merged.computeVertexNormals()
    groups.push({ role, pivot: b.pivot, geometry: merged })
  }
  return groups
}

// Interpret a blueprint into one static merged geometry (doodads, ghosts).
export function buildGenGeometry(bp: GenBlueprint, playerColor: THREE.Color | null = null): THREE.BufferGeometry {
  const groups = buildGenGroups(bp, playerColor)
  if (groups.length === 1) return groups[0].geometry
  const merged = mergeGeometries(groups.map((g) => g.geometry), false) ?? new THREE.BufferGeometry()
  merged.computeVertexNormals()
  return merged
}

// Resolve a 'gen:<id>' model id to fresh geometry, or null when unregistered
// (callers fall back to a placeholder, same contract as broken glTF assets).
export function genGeometry(id: string): THREE.BufferGeometry | null {
  const bp = GEN_BLUEPRINTS[id]
  return bp ? buildGenGeometry(bp) : null
}

// Resolve a 'gen:<id>' model to animation groups with an owner color baked
// into 'player' palette slots. Geometry AND pivots are scaled by `scale`.
export function genGroups(id: string, playerColor: THREE.Color | null, scale: number): GenGroup[] | null {
  const bp = GEN_BLUEPRINTS[id]
  if (!bp) return null
  const groups = buildGenGroups(bp, playerColor)
  if (scale !== 1) {
    for (const g of groups) {
      g.geometry.scale(scale, scale, scale)
      g.pivot = [g.pivot[0] * scale, g.pivot[1] * scale, g.pivot[2] * scale]
    }
  }
  return groups
}
