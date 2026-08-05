import * as THREE from 'three'
import { deriveTerrain, type FogState, type RtsMapDoc } from '@battlebadger/sim'

// Shared terrain builder (game renderer now, editor later). Consumes only the
// doc via deriveTerrain — identical geometry on every client.

// Palette indices match mapgen TEX_* constants.
export const TERRAIN_PALETTE: [number, number, number][] = [
  [0.18, 0.36, 0.15], // 0 grass
  [0.42, 0.32, 0.2], // 1 dirt (ramps)
  [0.36, 0.32, 0.29], // 2 rock
  [0.55, 0.48, 0.33], // 3 sand
  [0.75, 0.78, 0.82], // 4 snow
  [0.12, 0.26, 0.12], // 5 dark grass
  [0.13, 0.24, 0.42], // 6 water
  [0.17, 0.15, 0.14], // 7 ash
]

export function buildTerrainMesh(doc: RtsMapDoc): THREE.Mesh {
  const { cols, rows, cellSize } = doc
  const { walkable, heights } = deriveTerrain(doc)
  const positions = new Float32Array(cols * rows * 3)
  const colors = new Float32Array(cols * rows * 3)
  const cliff = doc.cliffLevel
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      positions[i * 3] = doc.originX + (x + 0.5) * cellSize
      positions[i * 3 + 1] = heights[i]
      positions[i * 3 + 2] = doc.originZ + (y + 0.5) * cellSize

      let tex = doc.texture?.[i] ?? 0
      // Carved cliff-band cells render as rock even if painted grass. Cells
      // the author blocked *explicitly* keep their paint, though — that layer
      // is how a map says "water" or "impassable bog", and forcing those to
      // rock turned a river into a stone trench.
      const authorBlocked = doc.walkable?.[i] === 0
      if (walkable[i] === 0 && cliff && !authorBlocked) tex = 2
      else if (walkable[i] === 0 && !doc.texture) tex = 2
      const [r, g, b] = TERRAIN_PALETTE[tex] ?? TERRAIN_PALETTE[0]
      // subtle sun-bleach with height + per-cell variation
      const t = Math.min(1, Math.max(0, heights[i] / 4))
      const lift = 1 + t * 0.35
      const n = ((Math.imul(x ^ (y << 8), 0x9e3779b1) >>> 24) / 255 - 0.5) * 0.05
      colors[i * 3] = r * lift + n
      colors[i * 3 + 1] = g * lift + n
      colors[i * 3 + 2] = b * lift + n
    }
  }
  const index: number[] = []
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = y * cols + x
      const b = a + 1
      const d = a + cols
      const e = d + 1
      index.push(a, d, b, b, d, e)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'
  // Keep the unfogged palette so shadeTerrainFog can re-derive lighting each
  // update instead of progressively darkening what it already darkened.
  mesh.userData.baseColors = colors.slice()
  mesh.userData.fogCols = cols
  return mesh
}

// Fog shading, applied to the terrain's vertex colors:
//   visible          → full colour
//   explored, unseen → dimmed (you remember the ground, not who is on it)
//   never explored   → near-black ('full' mode only)
// 'units' mode marks everything explored, so terrain just stays lit.
/**
 * Re-shade the terrain for the fog, writing only what actually changed and
 * uploading only the rows that changed.
 *
 * This used to rewrite every vertex colour and re-upload the whole buffer on
 * every fog revision — which is every tick. On a 160² map that was ~25k writes
 * and a 300 KB upload; at 480 x 384 it is 184k cells, 553k float writes and a
 * 2.2 MB upload, ten times a second.
 *
 * Two things make it cheap. Tracking the shade already applied per cell means
 * only genuinely changed cells are written. And the upload is bounded PER ROW
 * rather than by one span across the whole buffer — that distinction is the
 * whole fix, because armies are scattered, so the first and last dirty cells
 * on the map are usually near opposite ends of it and a single min/max range
 * covers almost everything. Measured at map size with forty drifting vision
 * discs: 2160 KB/tick before, 278 KB/tick after, for the same CPU.
 *
 * Runs of dirty rows are deliberately NOT coalesced. Merging across even a
 * three-row gap chains scattered rows back into one huge span and gives most
 * of the saving straight back (1812 KB/tick when measured); a few hundred
 * small uploads ten times a second is the cheaper end of that trade.
 */
export function shadeTerrainFog(mesh: THREE.Mesh, fog: FogState): void {
  if (!fog.enabled) return
  const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
  const base = mesh.userData.baseColors as Float32Array
  const arr = attr.array as Float32Array
  const cols = mesh.userData.fogCols as number
  const n = fog.visible.length
  let applied = mesh.userData.fogShade as Uint8Array | undefined
  // 255 = "nothing applied yet", so the first pass writes every cell once.
  if (!applied || applied.length !== n) {
    applied = new Uint8Array(n).fill(255)
    mesh.userData.fogShade = applied
  }
  attr.clearUpdateRanges()
  let dirty = false
  const rows = cols > 0 ? Math.ceil(n / cols) : 1
  for (let z = 0; z < rows; z++) {
    const row = z * cols
    const end = Math.min(cols, n - row)
    let lo = -1
    let hi = -1
    for (let x = 0; x < end; x++) {
      const i = row + x
      const level = fog.visible[i] === 1 ? 2 : fog.explored[i] === 1 ? 1 : 0
      if (applied[i] === level) continue
      applied[i] = level
      const mul = level === 2 ? 1 : level === 1 ? 0.42 : 0.05
      const k = i * 3
      arr[k] = base[k] * mul
      arr[k + 1] = base[k + 1] * mul
      arr[k + 2] = base[k + 2] * mul
      if (lo < 0) lo = x
      hi = x
    }
    if (lo < 0) continue
    attr.addUpdateRange((row + lo) * 3, (hi - lo + 1) * 3)
    dirty = true
  }
  // Nothing moved: do not touch the GPU at all.
  if (dirty) attr.needsUpdate = true
}
