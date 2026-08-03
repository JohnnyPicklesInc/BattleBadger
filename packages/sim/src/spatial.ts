import type { SimState } from './state.ts'

// Uniform spatial grid rebuilt every tick, as a counting sort into flat typed
// arrays. Cells fill in ascending entity index and queries scan cells in fixed
// (cz, cx) order → deterministic.
//
// Why not a Map of buckets: an acquire query with a 13-unit radius spans ~200
// cells at CELL 2, and every one of them cost a Map.get whether or not
// anything was in it. Indexing a flat array costs nothing per empty cell.
const CELL = 2

/** One counting-sorted grid over some subset of the entities. */
class Grid {
  // Occupied bounding box, in cells. Queries clamp to it; anything outside is
  // empty by construction.
  private minCx = 0
  private minCz = 0
  private cols = 0
  private rows = 0
  /** start[c] .. start[c+1] is cell c's slice of `items`. */
  private start = new Int32Array(0)
  private fill = new Int32Array(0)
  private items = new Int32Array(0)

  /** Rebuild from every live entity whose team is `team` (-1 = all teams). */
  build(s: SimState, team: number): void {
    let minCx = 0x7fffffff
    let maxCx = -0x7fffffff
    let minCz = 0x7fffffff
    let maxCz = -0x7fffffff
    let n = 0
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (team >= 0 && s.playerTeam[s.owner[i]] !== team) continue
      const cx = Math.floor(s.posX[i] / CELL)
      const cz = Math.floor(s.posZ[i] / CELL)
      if (cx < minCx) minCx = cx
      if (cx > maxCx) maxCx = cx
      if (cz < minCz) minCz = cz
      if (cz > maxCz) maxCz = cz
      n++
    }
    if (n === 0) {
      this.cols = 0
      this.rows = 0
      return
    }
    this.minCx = minCx
    this.minCz = minCz
    this.cols = maxCx - minCx + 1
    this.rows = maxCz - minCz + 1
    const cells = this.cols * this.rows

    if (this.start.length < cells + 1) {
      this.start = new Int32Array(cells + 1)
      this.fill = new Int32Array(cells + 1)
    } else {
      this.start.fill(0, 0, cells + 1)
      this.fill.fill(0, 0, cells + 1)
    }
    if (this.items.length < n) this.items = new Int32Array(n)

    // pass 1: count per cell, offset by one so the prefix sum lands on starts
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (team >= 0 && s.playerTeam[s.owner[i]] !== team) continue
      this.start[this.cellOf(s.posX[i], s.posZ[i]) + 1]++
    }
    for (let c = 0; c < cells; c++) this.start[c + 1] += this.start[c]
    // pass 2: scatter in ascending entity index, so each cell's slice stays
    // sorted by id — the tie-break callers rely on
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (team >= 0 && s.playerTeam[s.owner[i]] !== team) continue
      const c = this.cellOf(s.posX[i], s.posZ[i])
      this.items[this.start[c] + this.fill[c]++] = i
    }
  }

  private cellOf(x: number, z: number): number {
    return (Math.floor(z / CELL) - this.minCz) * this.cols + (Math.floor(x / CELL) - this.minCx)
  }

  forNeighbors(x: number, z: number, r: number, cb: (id: number) => void): void {
    if (this.cols === 0) return
    let cx0 = Math.floor((x - r) / CELL) - this.minCx
    let cx1 = Math.floor((x + r) / CELL) - this.minCx
    let cz0 = Math.floor((z - r) / CELL) - this.minCz
    let cz1 = Math.floor((z + r) / CELL) - this.minCz
    if (cx0 < 0) cx0 = 0
    if (cz0 < 0) cz0 = 0
    if (cx1 > this.cols - 1) cx1 = this.cols - 1
    if (cz1 > this.rows - 1) cz1 = this.rows - 1
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * this.cols
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = row + cx
        const end = this.start[c + 1]
        for (let k = this.start[c]; k < end; k++) cb(this.items[k])
      }
    }
  }
}

export class SpatialHash {
  private all = new Grid()
  /** One grid per team that has anything on the field. */
  private byTeam: Grid[] = Array.from({ length: 8 }, () => new Grid())
  private present: number[] = []

  build(s: SimState): void {
    this.all.build(s, -1)
    // Which teams are actually on the field — recomputed every tick, because a
    // team can be wiped out mid-match and an empty grid must stop being asked.
    const seen = [false, false, false, false, false, false, false, false]
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && !s.hidden[i]) seen[s.playerTeam[s.owner[i]]] = true
    }
    this.present.length = 0
    for (let t = 0; t < 8; t++) {
      if (!seen[t]) continue
      this.present.push(t)
      this.byTeam[t].build(s, t)
    }
  }

  /** Only entities on `team`. */
  forTeamNeighbors(team: number, x: number, z: number, r: number, cb: (id: number) => void): void {
    this.byTeam[team].forNeighbors(x, z, r, cb)
  }

  // Visits candidate ids near (x, z) within radius r (cell-granular; caller
  // must do the exact distance test).
  forNeighbors(x: number, z: number, r: number, cb: (id: number) => void): void {
    this.all.forNeighbors(x, z, r, cb)
  }

  /**
   * Same, but only entities on a team other than `myTeam`.
   *
   * Target acquisition is the one query with a big radius, and an army massed
   * among its own ranks would otherwise scan every friendly soldier in reach —
   * every tick, per unit — only to reject them all on the team test. Partitioned
   * by team, the cells around your own camp are simply empty.
   *
   * Candidates differ from `forNeighbors` only by the team filter the caller
   * would have applied anyway; teams are visited in ascending order, and every
   * caller resolves ties explicitly by id, so the outcome is order-independent.
   */
  forEnemyNeighbors(myTeam: number, x: number, z: number, r: number, cb: (id: number) => void): void {
    for (let k = 0; k < this.present.length; k++) {
      const t = this.present[k]
      if (t !== myTeam) this.byTeam[t].forNeighbors(x, z, r, cb)
    }
  }
}
