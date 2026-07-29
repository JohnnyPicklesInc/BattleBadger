import { deriveTerrain, type RtsMapDoc } from '../mapdoc.ts'

export class WalkGrid {
  cols: number
  rows: number
  cellSize: number
  originX: number
  originZ: number
  walkable: Uint8Array
  heights: Float64Array

  constructor(
    cols: number,
    rows: number,
    cellSize: number,
    originX: number,
    originZ: number,
    walkable: Uint8Array,
    heights: Float64Array,
  ) {
    this.cols = cols
    this.rows = rows
    this.cellSize = cellSize
    this.originX = originX
    this.originZ = originZ
    this.walkable = walkable
    this.heights = heights
  }

  idx(cx: number, cy: number): number {
    return cy * this.cols + cx
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows
  }

  cellX(wx: number): number {
    return Math.floor((wx - this.originX) / this.cellSize)
  }

  cellZ(wz: number): number {
    return Math.floor((wz - this.originZ) / this.cellSize)
  }

  centerX(cx: number): number {
    return this.originX + (cx + 0.5) * this.cellSize
  }

  centerZ(cy: number): number {
    return this.originZ + (cy + 0.5) * this.cellSize
  }

  isWalkable(cx: number, cy: number): boolean {
    return this.inBounds(cx, cy) && this.walkable[this.idx(cx, cy)] === 1
  }

  isWalkableWorld(wx: number, wz: number): boolean {
    return this.isWalkable(this.cellX(wx), this.cellZ(wz))
  }

  // Render helper (sim never reads heights): bilinear over cell centers.
  heightAtWorld(wx: number, wz: number): number {
    const fx = (wx - this.originX) / this.cellSize - 0.5
    const fz = (wz - this.originZ) / this.cellSize - 0.5
    const x0 = Math.max(0, Math.min(this.cols - 1, Math.floor(fx)))
    const z0 = Math.max(0, Math.min(this.rows - 1, Math.floor(fz)))
    const x1 = Math.min(this.cols - 1, x0 + 1)
    const z1 = Math.min(this.rows - 1, z0 + 1)
    const tx = Math.max(0, Math.min(1, fx - x0))
    const tz = Math.max(0, Math.min(1, fz - z0))
    const h00 = this.heights[this.idx(x0, z0)]
    const h10 = this.heights[this.idx(x1, z0)]
    const h01 = this.heights[this.idx(x0, z1)]
    const h11 = this.heights[this.idx(x1, z1)]
    const a = h00 + (h10 - h00) * tx
    const b = h01 + (h11 - h01) * tx
    return a + (b - a) * tz
  }

  // Walkability along a segment, sampled at sub-cell steps. Used for
  // string-pulling and direct-path checks. Deterministic (whitelisted ops).
  lineWalkable(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0
    const dz = z1 - z0
    const dist = Math.sqrt(dx * dx + dz * dz)
    const stepLen = this.cellSize * 0.35
    const n = Math.max(1, Math.floor(dist / stepLen) + 1)
    for (let i = 0; i <= n; i++) {
      const t = i / n
      if (!this.isWalkableWorld(x0 + dx * t, z0 + dz * t)) return false
    }
    return true
  }

  // Nearest walkable cell via expanding square rings (deterministic scan order).
  nearestWalkable(cx: number, cy: number, maxR = 12): [number, number] | null {
    if (this.isWalkable(cx, cy)) return [cx, cy]
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          if (this.isWalkable(cx + dx, cy + dy)) return [cx + dx, cy + dy]
        }
      }
    }
    return null
  }
}

export function walkGridFromDoc(doc: RtsMapDoc): WalkGrid {
  const { walkable, heights } = deriveTerrain(doc)
  return new WalkGrid(doc.cols, doc.rows, doc.cellSize, doc.originX, doc.originZ, walkable, heights)
}
