import type { FogMode, RtsMapDoc } from './mapdoc.ts'
import type { SimState } from './state.ts'

// Fog of war.
//
// Vision is DERIVED state, not simulation state: every client already holds
// the whole world (lockstep), so each one computes only what its own team can
// see and uses it to decide what to draw and what the player may click. That
// keeps it out of stateHash entirely — the same category as the spatial hash —
// so fog can never cause a desync, and turning it on or off changes not one
// simulated byte.
//
// It is deterministic and slot-parameterised all the same, so an AI can ask
// exactly the same question about its own team and get an honest answer
// instead of omniscience.
//
// Vision is shared across a TEAM: allies see through each other's eyes.

export class FogState {
  readonly cols: number
  readonly rows: number
  readonly cellSize: number
  readonly originX: number
  readonly originZ: number
  mode: FogMode
  team: number
  /** 1 = in sight this instant. */
  readonly visible: Uint8Array
  /** 1 = has been in sight at some point (never cleared). */
  readonly explored: Uint8Array
  /**
   * Bumped every time sight is actually recomputed. Consumers that rebuild
   * something expensive from the fog (terrain shading, the minimap mask) can
   * compare against it and skip the work on frames where nothing moved —
   * without this they redo an O(map) pass at frame rate instead of tick rate.
   */
  revision = 0
  private lastTick = -1

  constructor(doc: RtsMapDoc, team: number) {
    this.cols = doc.cols
    this.rows = doc.rows
    this.cellSize = doc.cellSize
    this.originX = doc.originX
    this.originZ = doc.originZ
    this.mode = doc.fog ?? 'off'
    this.team = team
    const n = doc.cols * doc.rows
    this.visible = new Uint8Array(n)
    this.explored = new Uint8Array(n)
    if (this.mode === 'off') {
      this.visible.fill(1)
      this.explored.fill(1)
    } else if (this.mode === 'units') {
      // terrain is common knowledge; only occupancy is secret
      this.explored.fill(1)
    }
  }

  get enabled(): boolean {
    return this.mode !== 'off'
  }

  private cellX(wx: number): number {
    return Math.floor((wx - this.originX) / this.cellSize)
  }

  private cellZ(wz: number): number {
    return Math.floor((wz - this.originZ) / this.cellSize)
  }

  /** Recompute current sight. Cheap enough to call every tick; no-ops when off. */
  update(s: SimState): void {
    if (this.mode === 'off' || s.tick === this.lastTick) return
    this.lastTick = s.tick
    this.revision++
    this.visible.fill(0)
    const st = s.def.stats
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (s.playerTeam[s.owner[i]] !== this.team) continue
      const r = st.vision[s.type[i]]
      if (r <= 0) continue
      this.stamp(s.posX[i], s.posZ[i], r)
    }
    // everything currently lit becomes permanently remembered
    for (let k = 0; k < this.visible.length; k++) if (this.visible[k] === 1) this.explored[k] = 1
  }

  // Filled circle in cell space. Squared distances only — no sqrt, no trig.
  private stamp(wx: number, wz: number, radius: number): void {
    const cx0 = this.cellX(wx - radius)
    const cx1 = this.cellX(wx + radius)
    const cz0 = this.cellZ(wz - radius)
    const cz1 = this.cellZ(wz + radius)
    const rSq = radius * radius
    for (let cy = cz0; cy <= cz1; cy++) {
      if (cy < 0 || cy >= this.rows) continue
      const wzc = this.originZ + (cy + 0.5) * this.cellSize
      const dz = wzc - wz
      const row = cy * this.cols
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 0 || cx >= this.cols) continue
        const wxc = this.originX + (cx + 0.5) * this.cellSize
        const dx = wxc - wx
        if (dx * dx + dz * dz <= rSq) this.visible[row + cx] = 1
      }
    }
  }

  cellIndexAtWorld(wx: number, wz: number): number {
    const cx = this.cellX(wx)
    const cy = this.cellZ(wz)
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1
    return cy * this.cols + cx
  }

  visibleAtWorld(wx: number, wz: number): boolean {
    if (this.mode === 'off') return true
    const i = this.cellIndexAtWorld(wx, wz)
    return i < 0 ? false : this.visible[i] === 1
  }

  exploredAtWorld(wx: number, wz: number): boolean {
    if (this.mode !== 'full') return true
    const i = this.cellIndexAtWorld(wx, wz)
    return i < 0 ? false : this.explored[i] === 1
  }

  /**
   * May this team see entity `i` right now? Own-team entities always qualify
   * (they are their own observers); enemies need live sight, so a building
   * that has moved out of vision is NOT remembered — v1 keeps no last-known
   * snapshot.
   */
  canSeeEntity(s: SimState, i: number): boolean {
    if (this.mode === 'off') return true
    if (!s.alive[i]) return false
    // A plot is terrain furniture, not something anyone owns in the field.
    // Its nominal owner is only a placement slot, so it must NOT inherit the
    // "my own things are always visible" rule — it is remembered like scenery.
    if (s.def.stats.isPlot[s.type[i]]) return this.exploredAtWorld(s.posX[i], s.posZ[i])
    if (s.playerTeam[s.owner[i]] === this.team) return true
    return this.visibleAtWorld(s.posX[i], s.posZ[i])
  }

  /** Static scenery stays drawn once seen — it cannot have moved. */
  canSeeDoodad(wx: number, wz: number): boolean {
    if (this.mode !== 'full') return true
    return this.exploredAtWorld(wx, wz)
  }
}
