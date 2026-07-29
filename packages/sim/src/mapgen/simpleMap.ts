import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import { rngFloat, rngFromSeed, rngInt, rngNext } from '../math/sfc32.ts'
import { formationOffset } from '../systems/orders.ts'

const ARMY: { def: string; count: number }[] = [
  { def: 'grunt', count: 12 },
  { def: 'archer', count: 6 },
  { def: 'priest', count: 3 },
]

const COLS = 96
const ROWS = 96
const CELL = 1

// Texture palette indices (see client terrain palette)
const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2

// Integer-hash value noise. Whitelisted ops only — deterministic.
function cellHash(seed: number, x: number, y: number): number {
  let h = seed | 0
  h = Math.imul(h ^ x, 0x27d4eb2f)
  h = (h ^ (h >>> 15)) | 0
  h = Math.imul(h ^ y, 0x165667b1)
  h = (h ^ (h >>> 13)) | 0
  return (h >>> 0) / 4294967296
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smooth(x - x0)
  const ty = smooth(y - y0)
  const a = cellHash(seed, x0, y0)
  const b = cellHash(seed, x0 + 1, y0)
  const c = cellHash(seed, x0, y0 + 1)
  const d = cellHash(seed, x0 + 1, y0 + 1)
  const ab = a + (b - a) * tx
  const cd = c + (d - c) * tx
  return ab + (cd - ab) * ty
}

// WC3-style skirmish valley: start plateaus (tier 1) with ramps, a central
// high-ground mesa, mirrored rock formations, rolling detail on tier 0.
export function generateMap(seed: number): RtsMapDoc {
  const rng = rngFromSeed((seed ^ 0x5eed1234) >>> 0)
  const noiseSeed = rngNext(rng) | 0
  const n = COLS * ROWS
  const cliffLevel = Array.from({ length: n }, () => 0)
  const ramp = Array.from({ length: n }, () => 0)
  const texture = Array.from({ length: n }, () => TEX_GRASS)
  const heightJitter = Array.from({ length: n }, () => 0)
  const walkable = Array.from({ length: n }, () => 1)
  const idx = (x: number, y: number): number => y * COLS + x

  const startA = { x: 16.5, z: ROWS / 2 + 0.5 }
  const startB = { x: COLS - 16.5, z: ROWS / 2 + 0.5 }

  // border ring unwalkable
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (x < 2 || y < 2 || x >= COLS - 2 || y >= ROWS - 2) {
        walkable[idx(x, y)] = 0
        texture[idx(x, y)] = TEX_ROCK
      }
    }
  }

  const raiseCircle = (cx: number, cy: number, r: number, level: number): void => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy <= r * r) cliffLevel[idx(x, y)] = level
      }
    }
  }
  const rampRect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue
        ramp[idx(x, y)] = 1
        texture[idx(x, y)] = TEX_DIRT
      }
    }
  }

  // start plateaus with a ramp toward the center and one flank ramp
  const midZ = Math.floor(ROWS / 2)
  raiseCircle(startA.x, startA.z, 13, 1)
  raiseCircle(startB.x, startB.z, 13, 1)
  rampRect(25, midZ - 2, 33, midZ + 2) // A: east ramp
  rampRect(COLS - 34, midZ - 2, COLS - 26, midZ + 2) // B: west ramp
  rampRect(14, midZ - 17, 18, midZ - 10) // A: north flank ramp
  rampRect(COLS - 19, midZ + 9, COLS - 15, midZ + 16) // B: south flank ramp (mirrored)

  // central mesa with north+south ramps
  const cx = COLS / 2
  raiseCircle(cx, midZ, 8, 1)
  rampRect(Math.floor(cx) - 2, midZ - 12, Math.floor(cx) + 1, midZ - 6)
  rampRect(Math.floor(cx) - 2, midZ + 5, Math.floor(cx) + 1, midZ + 11)

  // mirrored rock blobs on open ground (explicit blocking)
  const blobs = 6
  for (let b = 0; b < blobs; b++) {
    const bx = 8 + rngInt(rng, Math.floor(COLS / 2) - 14)
    const by = 6 + rngInt(rng, ROWS - 12)
    const r = 2 + rngFloat(rng) * 2.5
    const mirror = COLS - 1 - bx
    for (const rx of [bx, mirror]) {
      const dax = rx + 0.5 - startA.x
      const daz = by + 0.5 - startA.z
      const dbx = rx + 0.5 - startB.x
      const dbz = by + 0.5 - startB.z
      const clear = r + 15
      if (dax * dax + daz * daz < clear * clear) continue
      if (dbx * dbx + dbz * dbz < clear * clear) continue
      const dcx = rx + 0.5 - cx
      const dcz = by + 0.5 - midZ
      if (dcx * dcx + dcz * dcz < (r + 10) * (r + 10)) continue
      for (let y = Math.floor(by - r); y <= Math.floor(by + r) + 1; y++) {
        for (let x = Math.floor(rx - r); x <= Math.floor(rx + r) + 1; x++) {
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue
          const dx = x + 0.5 - (rx + 0.5)
          const dy = y + 0.5 - (by + 0.5)
          const wob = valueNoise(noiseSeed, x * 0.35, y * 0.35) * 1.2
          if (dx * dx + dy * dy < (r - 0.4 + wob) * (r - 0.4 + wob)) {
            walkable[idx(x, y)] = 0
            texture[idx(x, y)] = TEX_ROCK
          }
        }
      }
    }
  }

  // rolling render-only detail, flattened near the starts
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = idx(x, y)
      let h = valueNoise(noiseSeed, x * 0.07, y * 0.07) * 0.9 + valueNoise(noiseSeed ^ 7, x * 0.23, y * 0.23) * 0.25
      for (const st of [startA, startB]) {
        const dx = x + 0.5 - st.x
        const dz = y + 0.5 - st.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d < 12) h *= smooth(Math.max(0, Math.min(1, (d - 4) / 8)))
      }
      if (walkable[i] === 0) h += 1.2 + valueNoise(noiseSeed ^ 13, x * 0.5, y * 0.5) * 0.9
      heightJitter[i] = h
    }
  }

  // Pre-placed starting armies (spiral formation around each start).
  const placed: PlacedEntity[] = []
  for (let owner = 0; owner < 2; owner++) {
    const st = owner === 0 ? startA : startB
    let slot = 0
    for (const group of ARMY) {
      for (let k = 0; k < group.count; k++) {
        const [ox, oz] = formationOffset(slot++, 1.15)
        placed.push({ def: group.def, owner, x: st.x + ox, z: st.z + oz })
      }
    }
  }

  return {
    version: 2,
    name: 'skirmish-valley',
    seed,
    cols: COLS,
    rows: ROWS,
    cellSize: CELL,
    originX: 0,
    originZ: 0,
    walkable,
    cliffLevel,
    ramp,
    texture,
    heightJitter,
    startLocations: [startA, startB],
    placed,
  }
}
