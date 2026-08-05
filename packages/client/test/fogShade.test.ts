import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildTerrainMesh, shadeTerrainFog } from '../src/render/terrainMesh.ts'
import type { FogState, RtsMapDoc } from '@battlebadger/sim'

// The fog re-shade writes only the cells that changed and uploads only the rows
// that changed. That is a correctness risk as much as a speed win: an
// incremental painter that misses a cell leaves stale terrain on screen, and
// nothing else in the app would ever notice.

const COLS = 24
const ROWS = 16
const N = COLS * ROWS

const doc = (): RtsMapDoc => ({
  version: 2,
  name: 'fog-test',
  seed: 1,
  cols: COLS,
  rows: ROWS,
  cellSize: 1,
  originX: 0,
  originZ: 0,
  texture: Array.from({ length: N }, (_, i) => i % 6),
  heightJitter: Array.from({ length: N }, () => 0),
  startLocations: [{ x: 2, z: 2 }],
})

/** A FogState stub: the shader only reads these three fields. */
const fogOf = (visible: Uint8Array, explored: Uint8Array): FogState =>
  ({ enabled: true, visible, explored }) as unknown as FogState

/** What the colours SHOULD be, computed the naive way. */
function expected(mesh: THREE.Mesh, visible: Uint8Array, explored: Uint8Array): Float32Array {
  const base = mesh.userData.baseColors as Float32Array
  const want = new Float32Array(base.length)
  for (let i = 0; i < N; i++) {
    const mul = visible[i] === 1 ? 1 : explored[i] === 1 ? 0.42 : 0.05
    for (let c = 0; c < 3; c++) want[i * 3 + c] = base[i * 3 + c] * mul
  }
  return want
}

const colours = (mesh: THREE.Mesh): Float32Array =>
  (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array

describe('incremental fog shading', () => {
  it('paints every cell on the first pass', () => {
    const mesh = buildTerrainMesh(doc())
    const visible = new Uint8Array(N)
    const explored = new Uint8Array(N)
    for (let i = 0; i < 40; i++) {
      visible[i] = 1
      explored[i] = 1
    }
    shadeTerrainFog(mesh, fogOf(visible, explored))
    expect([...colours(mesh)]).toEqual([...expected(mesh, visible, explored)])
  })

  it('stays exactly right as the fog moves, over many revisions', () => {
    const mesh = buildTerrainMesh(doc())
    const visible = new Uint8Array(N)
    const explored = new Uint8Array(N)
    // A disc wandering around, which is what an army's vision actually is.
    for (let t = 0; t < 30; t++) {
      visible.fill(0)
      const cx = 4 + ((t * 5) % (COLS - 8))
      const cz = 3 + ((t * 3) % (ROWS - 6))
      for (let z = 0; z < ROWS; z++) {
        for (let x = 0; x < COLS; x++) {
          if ((x - cx) ** 2 + (z - cz) ** 2 <= 9) {
            visible[z * COLS + x] = 1
            explored[z * COLS + x] = 1
          }
        }
      }
      shadeTerrainFog(mesh, fogOf(visible, explored))
      // The whole point: incremental output must equal the naive output every
      // single time, or the screen keeps a patch of stale ground forever.
      expect([...colours(mesh)], `revision ${t} drifted`).toEqual([...expected(mesh, visible, explored)])
    }
  })

  it('uploads only the rows that changed, and nothing when nothing moves', () => {
    const mesh = buildTerrainMesh(doc())
    const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const visible = new Uint8Array(N)
    const explored = new Uint8Array(N)
    shadeTerrainFog(mesh, fogOf(visible, explored))

    // `needsUpdate` is a write-only setter in three.js — reading it gives
    // undefined. What it actually does is bump `version`, so that is what an
    // upload looks like from outside.
    const before = attr.version

    // Light one cell on one row.
    visible[5 * COLS + 7] = 1
    explored[5 * COLS + 7] = 1
    shadeTerrainFog(mesh, fogOf(visible, explored))
    expect(attr.version, 'a changed cell did not mark an upload').toBeGreaterThan(before)
    expect(attr.updateRanges).toHaveLength(1)
    // One row, one cell: the range must not span the whole buffer. Before this
    // was row-bounded it was a single min/max span across the map, which on a
    // real map covered almost everything.
    expect(attr.updateRanges[0].count).toBeLessThanOrEqual(3)

    // Same fog again: nothing to say to the GPU.
    const settled = attr.version
    shadeTerrainFog(mesh, fogOf(visible, explored))
    expect(attr.version, 'an unchanged fog still uploaded').toBe(settled)
  })
})
