import type { GameDef } from './defs/schema.ts'
import type { GenBlueprint } from './blueprint.ts'

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
  // Which way it points, as a direction rather than an angle — the sim has no
  // trigonometry available to turn one into the other. A model's local +Z is
  // laid along this, so a wall section that runs east-west and one that runs
  // north-south are the same entity placed two ways. Absent = the default
  // spawn facing.
  facing?: { x: number; z: number }
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
  // `def` narrows the count to one kind of thing, which is what makes "his
  // LAST fortress has fallen" expressible now that a fortress can be rebuilt.
  | { type: 'unitCountInRegion'; region: string; owner?: number; def?: string; op: '>=' | '<='; count: number }
  | { type: 'elapsed'; seconds: number } // game time >= seconds

export type TriggerAction =
  // `always` spawns even when the owning slot has no human player (AI slots).
  // A horde TICKET spawns its whole battalion, bound as one horde — the same
  // rule setup.ts applies to pre-placed armies. `count` is then battalions,
  // not soldiers. `facing` is a direction vector (no trigonometry in the sim);
  // absent = south, so a wave that wants to form up looking at the enemy says so.
  | {
      type: 'spawnUnits'
      def: string
      owner: number
      count: number
      at: { x: number; z: number } | { region: string }
      always?: boolean
      facing?: { x: number; z: number }
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
  // The races this map offers, by faction module id. Absent = any faction whose
  // rules fit, which is the right default for a map that was authored without
  // a roster in mind. Present, it is the map's own answer to "what game is
  // this": a BFME map seats Badgers and the Horde, and a StarCraft-shaped army
  // has no business turning up in the picker on it. The map still PLAYS
  // whatever its own content places — a roster narrows what a lobby may swap
  // in, not what the author put on the ground.
  races?: string[]
  startLocations: { x: number; z: number }[]
  /**
   * What to call each start position, parallel to `startLocations`. An
   * authored scenario names its ground — a lobby seat reads "Gondor", not
   * "Start 1" — which is also how a map with no swappable races still tells
   * you what you are about to play. Absent = numbered.
   */
  startNames?: string[]
  // team id per player slot (index = slot). Absent = free-for-all (slot = team).
  // Alternating sides (e.g. [0,1,0,1]) keeps 2-player games 1v1 on team maps.
  slotTeams?: number[]
  placed?: PlacedEntity[] // pre-placed units/buildings
  doodads?: PlacedDoodad[] // scenery + resource nodes
  regions?: MapRegion[] // named rects for triggers
  triggers?: TriggerDef[]
  assets?: AssetRef[] // custom model manifest (payload travels beside the doc)
  // Procedural models authored into the map, resolved by a def's
  // 'gen:<id>' visual. Checked BEFORE the client's built-ins, so a map may add
  // its own models or replace a stock one. Render-only, and a few hundred
  // bytes each rather than the megabytes an embedded .glb costs.
  blueprints?: GenBlueprint[]
  // Computer opponents the MAP asks for, by slot: 0 = human/none, 1..3 = the
  // AI difficulty. Authored here rather than only in the lobby because a map
  // built around AI-owned content (lane creeps, a scripted attacker) is not
  // playable without them. aiLevel is hashed sim state, so carrying it on the
  // doc is also the surest way for two clients to agree about it.
  aiLevels?: number[]
  gameDef?: GameDef // inline rules; absent = skirmish preset
}

/**
 * How many player slots this map seats. Start locations ARE the slot list —
 * there is no separate count to keep in step with them.
 */
export function mapSlotCount(doc: RtsMapDoc): number {
  return Math.max(1, Math.min(8, doc.startLocations.length))
}

/**
 * Every owner index the map actually uses, in order. Beyond the player slots
 * this includes the "war slots" a MOBA-style map parks its neutral armies in —
 * content owned by a slot no human ever occupies.
 */
export function mapOwners(doc: RtsMapDoc): number[] {
  const used = new Set<number>()
  for (let i = 0; i < mapSlotCount(doc); i++) used.add(i)
  for (const p of doc.placed ?? []) used.add(p.owner)
  for (const t of doc.triggers ?? []) {
    for (const a of t.actions) if (a.type === 'spawnUnits') used.add(a.owner)
  }
  return [...used].filter((o) => o >= 0 && o < 8).sort((a, b) => a - b)
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

// ---- resize ------------------------------------------------------------

/** What a resize threw away, so the editor can say so rather than silently losing work. */
export interface ResizeReport {
  doc: RtsMapDoc
  droppedDoodads: number
  droppedPlaced: number
  droppedStarts: number
  droppedRegions: number
  clampedRegions: number
}

const LAYERS = ['walkable', 'heights', 'cliffLevel', 'ramp', 'texture', 'heightJitter'] as const

// Cells outside the old map need a value. Everything defaults to 0 except
// walkability, where 0 means "wall" — new ground should be walkable, or
// growing a map would ring the old one in an invisible barrier.
const OUTSIDE: Record<(typeof LAYERS)[number], number> = {
  walkable: 1,
  heights: 0,
  cliffLevel: 0,
  ramp: 0,
  texture: 0,
  heightJitter: 0,
}

/**
 * Change a map's dimensions, anchored at the origin corner.
 *
 * Growing adds open ground; shrinking crops. Anything left outside the new
 * bounds is REMOVED rather than clamped to the edge — a unit silently teleported
 * to the border is worse than one the author is told they lost. Regions are the
 * exception: they are areas, so a region that merely overhangs is clipped, and
 * only one entirely outside is dropped.
 */
export function resizeMap(doc: RtsMapDoc, cols: number, rows: number): ResizeReport {
  // A mechanical guard, not a design opinion: small duel arenas are legitimate,
  // but a map narrower than the brush border logic assumes is not a map.
  const nc = Math.max(4, Math.min(512, Math.floor(cols)))
  const nr = Math.max(4, Math.min(512, Math.floor(rows)))
  const out: RtsMapDoc = { ...doc, cols: nc, rows: nr }

  for (const layer of LAYERS) {
    const src = doc[layer]
    if (!src) continue
    const dst = Array.from<number>({ length: nc * nr }).fill(OUTSIDE[layer])
    const copyRows = Math.min(doc.rows, nr)
    const copyCols = Math.min(doc.cols, nc)
    for (let z = 0; z < copyRows; z++) {
      for (let x = 0; x < copyCols; x++) dst[z * nc + x] = src[z * doc.cols + x]
    }
    out[layer] = dst
  }

  const inside = (p: { x: number; z: number }): boolean =>
    p.x >= doc.originX && p.z >= doc.originZ && p.x < doc.originX + nc * doc.cellSize && p.z < doc.originZ + nr * doc.cellSize

  const doodads = (doc.doodads ?? []).filter(inside)
  const placed = (doc.placed ?? []).filter(inside)
  const starts = doc.startLocations.filter(inside)

  const maxX = doc.originX + nc * doc.cellSize
  const maxZ = doc.originZ + nr * doc.cellSize
  let clampedRegions = 0
  const regions = (doc.regions ?? [])
    .filter((r) => r.x0 < maxX && r.z0 < maxZ && r.x1 > doc.originX && r.z1 > doc.originZ)
    .map((r) => {
      const clipped = {
        ...r,
        x0: Math.max(doc.originX, r.x0),
        z0: Math.max(doc.originZ, r.z0),
        x1: Math.min(maxX, r.x1),
        z1: Math.min(maxZ, r.z1),
      }
      if (clipped.x0 !== r.x0 || clipped.z0 !== r.z0 || clipped.x1 !== r.x1 || clipped.z1 !== r.z1) clampedRegions++
      return clipped
    })

  if (doc.doodads) out.doodads = doodads
  if (doc.placed) out.placed = placed
  out.startLocations = starts
  if (doc.regions) out.regions = regions

  return {
    doc: out,
    droppedDoodads: (doc.doodads?.length ?? 0) - doodads.length,
    droppedPlaced: (doc.placed?.length ?? 0) - placed.length,
    droppedStarts: doc.startLocations.length - starts.length,
    droppedRegions: (doc.regions?.length ?? 0) - regions.length,
    clampedRegions,
  }
}
