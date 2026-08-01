import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { RtsMapDoc } from '@battlebadger/sim'
import { genGeometry } from '../gen/build.ts'
import { useMapBlueprints } from '../gen/registry.ts'

// Loads the map's own visuals: its procedural blueprints, and its embedded
// .glb assets as geometries keyed by asset id. Any failure logs and falls back
// to placeholders — visuals never enter the sim, so a broken model can never
// desync or break a match.
//
// Blueprint registration lives here, on the one path every game start takes,
// so a new caller cannot forget it and silently render the built-in model
// where the map meant its own.
export async function loadAssetGeometries(doc: RtsMapDoc): Promise<Map<string, THREE.BufferGeometry>> {
  useMapBlueprints(doc)
  const out = new Map<string, THREE.BufferGeometry>()
  const assets = (doc.assets ?? []).filter((a) => a.kind === 'glb' && a.data)
  if (assets.length === 0) return out
  const loader = new GLTFLoader()
  for (const a of assets) {
    try {
      const bin = atob(a.data!)
      const buf = new ArrayBuffer(bin.length)
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const gltf = await loader.parseAsync(buf, '')
      let geo: THREE.BufferGeometry | null = null
      gltf.scene.traverse((obj) => {
        if (!geo && obj instanceof THREE.Mesh) {
          const g = (obj.geometry as THREE.BufferGeometry).clone()
          g.applyMatrix4(obj.matrixWorld)
          geo = g
        }
      })
      if (geo) out.set(a.id, geo)
      else console.warn(`asset:${a.id} has no mesh — using placeholder`)
    } catch (err) {
      console.warn(`asset:${a.id} failed to load — using placeholder`, err)
    }
  }
  return out
}

// Resolve an EntityDef.visual.model to a geometry, preferring loaded assets.
export function resolveModel(
  model: string,
  radius: number,
  scale: number,
  assets: Map<string, THREE.BufferGeometry>,
  fallback: (model: string, radius: number, scale: number) => THREE.BufferGeometry,
): THREE.BufferGeometry {
  if (model.startsWith('gen:')) {
    const geo = genGeometry(model.slice(4))
    if (geo) {
      if (scale !== 1) geo.scale(scale, scale, scale)
      return geo
    }
    return fallback('placeholder:box', radius, scale)
  }
  if (model.startsWith('asset:')) {
    const geo = assets.get(model.slice(6))
    if (geo) {
      const scaled = geo.clone()
      if (scale !== 1) scaled.scale(scale, scale, scale)
      return scaled
    }
    return fallback('placeholder:box', radius, scale)
  }
  return fallback(model, radius, scale)
}
