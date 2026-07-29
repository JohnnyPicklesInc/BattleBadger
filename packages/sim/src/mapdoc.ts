import type { GameDef } from './defs/schema.ts'

// Versioned, engine-neutral map document (ZoneDocument lineage from MeekoQuest).
// The sim and renderer consume only this doc — never the generator — so the
// map editor just needs to emit RtsMapDoc JSON.
export interface PlacedEntity {
  def: string // entity id in the map's GameDef
  owner: number
  x: number
  z: number
  // Spawn even when the owning slot has no human player. This is how a map
  // gives content to reserved AI slots (MOBA lane creeps, neutral garrisons):
  // pair the slot with a team via slotTeams and mark its content `always`.
  always?: boolean
}

export interface PlacedDoodad {
  def: string
  x: number
  z: number
  rot?: number
  scale?: number
}

export interface MapRegion {
  id: string
  name: string
  x0: number
  z0: number
  x1: number
  z1: number
}

export interface AssetRef {
  id: string
  kind: 'glb'
  bytes: number
  sha1: string
  data?: string // base64 payload (v1: embedded; a zip package may replace this)
}

// World height per cliff tier.
export const CLIFF_STEP = 2.0

// ---- triggers: GUI event–condition–action, stored in the map ----
export type TriggerEvent =
  | { type: 'mapInit' }
  | { type: 'timer'; seconds: number; periodic?: boolean }
  | { type: 'unitDies'; owner?: number; def?: string }
  | { type: 'unitEntersRegion'; region: string; owner?: number; def?: string }
  | { type: 'resourceReached'; owner: number; resource: string; amount: number }

export type TriggerCondition =
  | { type: 'resourceCmp'; owner: number; resource: string; op: '>=' | '<='; amount: number }
  | { type: 'unitCountInRegion'; region: string; owner?: number; op: '>=' | '<='; count: number }
  | { type: 'elapsed'; seconds: number } // game time >= seconds

export type TriggerAction =
  // `always` spawns even when the owning slot has no human player (AI slots).
  | {
      type: 'spawnUnits'
      def: string
      owner: number
      count: number
      at: { x: number; z: number } | { region: string }
      always?: boolean
    }
  | { type: 'orderUnits'; region: string; owner?: number; order: 'move' | 'attackMove'; x: number; z: number }
  | { type: 'victory'; player: number }
  | { type: 'defeat'; player: number }
  | { type: 'message'; text: string; to: number | 'all' }
  | { type: 'modifyResource'; owner: number; resource: string; delta: number }
  | { type: 'panCamera'; player: number; x: number; z: number }
  | { type: 'setTrigger'; trigger: string; on: boolean }

export interface TriggerDef {
  id: string
  name: string
  initiallyOn?: boolean // default true
  once?: boolean
  events: TriggerEvent[] // ANY-of
  conditions: TriggerCondition[] // ALL-of
  actions: TriggerAction[] // in order
}

// How much of the world a player can see.
//   'off'   — everything visible (no fog); the historical behaviour.
//   'units' — terrain is always drawn, but enemies are hidden unless in sight.
//             ("show the map": you know the ground, not who is on it.)
//   'full'  — classic three-state fog. Ground you have never visited is black;
//             ground you have left is remembered but dimmed and holds no live
//             enemy information; only ground in sight right now is current.
export type FogMode = 'off' | 'units' | 'full'

export interface RtsMapDoc {
  version: 1 | 2
  name: string
  seed: number
  cols: number
  rows: number
  cellSize: number
  originX: number
  originZ: number
  // v1 layers (also usable in v2 as explicit extra blocking / base heights)
  walkable?: number[] // row-major, 0|1
  heights?: number[] // row-major, world Y per cell (render-only; sim is 2D)
  // v2 cliff terrain: discrete tiers with ramps; walkable/heights derive
  cliffLevel?: number[] // 0..7 per cell
  ramp?: number[] // 0|1 per cell — walkable slope bridging two tiers
  texture?: number[] // palette index per cell (render-only)
  heightJitter?: number[] // small render-only height detail per cell
  fog?: FogMode // absent = 'off'
  startLocations: { x: number; z: number }[]
  // team id per player slot (index = slot). Absent = free-for-all (slot = team).
  // Alternating sides (e.g. [0,1,0,1]) keeps 2-player games 1v1 on team maps.
  slotTeams?: number[]
  placed?: PlacedEntity[] // pre-placed units/buildings
  doodads?: PlacedDoodad[] // scenery + resource nodes
  regions?: MapRegion[] // named rects for triggers
  triggers?: TriggerDef[]
  assets?: AssetRef[] // custom model manifest (payload travels beside the doc)
  gameDef?: GameDef // inline rules; absent = skirmish preset
}

// Single source of truth for terrain derivation — sim and renderer both use
// this, so every client derives identical walkability/heights.
export function deriveTerrain(doc: RtsMapDoc): { walkable: Uint8Array; heights: Float64Array } {
  const n = doc.cols * doc.rows
  const walkable = new Uint8Array(n).fill(1)
  const heights = new Float64Array(n)

  if (doc.cliffLevel) {
    const lvl = doc.cliffLevel
    const ramp = doc.ramp
    const isRamp = (i: number): boolean => ramp !== undefined && ramp[i] === 1
    for (let y = 0; y < doc.rows; y++) {
      for (let x = 0; x < doc.cols; x++) {
        const i = y * doc.cols + x
        let h = lvl[i] * CLIFF_STEP
        if (isRamp(i)) {
          // ramp cells sit halfway between the tiers they bridge
          let lo = lvl[i]
          let hi = lvl[i]
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= doc.cols || ny >= doc.rows) continue
              const l = lvl[ny * doc.cols + nx]
              if (l < lo) lo = l
              if (l > hi) hi = l
            }
          }
          h = ((lo + hi) / 2) * CLIFF_STEP
        } else {
          // carve the cliff band: a non-ramp cell bordering a LOWER tier is
          // the cliff edge and is unwalkable
          for (let dy = -1; dy <= 1 && walkable[i] === 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx
              const ny = y + dy
              if (nx < 0 || ny < 0 || nx >= doc.cols || ny >= doc.rows) continue
              const ni = ny * doc.cols + nx
              if (lvl[ni] < lvl[i] && !isRamp(ni)) {
                walkable[i] = 0
                break
              }
            }
          }
        }
        heights[i] = h + (doc.heightJitter?.[i] ?? 0)
      }
    }
  } else if (doc.heights) {
    for (let i = 0; i < n; i++) heights[i] = doc.heights[i]
  }

  // explicit blocking layer (v1 maps; v2 extra rocks) ANDs in
  if (doc.walkable) {
    for (let i = 0; i < n; i++) if (doc.walkable[i] === 0) walkable[i] = 0
  }
  return { walkable, heights }
}
