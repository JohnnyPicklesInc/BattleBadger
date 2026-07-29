import type { SimState } from './state.ts'

// Uniform spatial hash rebuilt every tick. Buckets fill in ascending entity
// index and queries scan cells in fixed (cy, cx) order → deterministic.
const CELL = 2
const OFFSET = 4096

export class SpatialHash {
  private map = new Map<number, number[]>()

  build(s: SimState): void {
    this.map.clear()
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      const key = this.key(s.posX[i], s.posZ[i])
      const bucket = this.map.get(key)
      if (bucket) bucket.push(i)
      else this.map.set(key, [i])
    }
  }

  private key(x: number, z: number): number {
    const cx = Math.floor(x / CELL) + OFFSET
    const cz = Math.floor(z / CELL) + OFFSET
    return cz * 16384 + cx
  }

  // Visits candidate ids near (x, z) within radius r (cell-granular; caller
  // must do the exact distance test).
  forNeighbors(x: number, z: number, r: number, cb: (id: number) => void): void {
    const cx0 = Math.floor((x - r) / CELL) + OFFSET
    const cx1 = Math.floor((x + r) / CELL) + OFFSET
    const cz0 = Math.floor((z - r) / CELL) + OFFSET
    const cz1 = Math.floor((z + r) / CELL) + OFFSET
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = this.map.get(cz * 16384 + cx)
        if (!bucket) continue
        for (let k = 0; k < bucket.length; k++) cb(bucket[k])
      }
    }
  }
}
