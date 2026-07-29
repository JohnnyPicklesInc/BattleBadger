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
      // carved cliff-band cells render as rock even if painted grass
      if (walkable[i] === 0 && cliff) tex = 2
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
  return mesh
}

// Fog shading, applied to the terrain's vertex colors:
//   visible          → full colour
//   explored, unseen → dimmed (you remember the ground, not who is on it)
//   never explored   → near-black ('full' mode only)
// 'units' mode marks everything explored, so terrain just stays lit.
export function shadeTerrainFog(mesh: THREE.Mesh, fog: FogState): void {
  if (!fog.enabled) return
  const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
  const base = mesh.userData.baseColors as Float32Array
  const arr = attr.array as Float32Array
  for (let i = 0; i < fog.visible.length; i++) {
    const k = i * 3
    const mul = fog.visible[i] === 1 ? 1 : fog.explored[i] === 1 ? 0.42 : 0.05
    arr[k] = base[k] * mul
    arr[k + 1] = base[k + 1] * mul
    arr[k + 2] = base[k + 2] * mul
  }
  attr.needsUpdate = true
}
