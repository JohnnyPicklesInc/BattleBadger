import type { PlacedEntity, RtsMapDoc } from '../mapdoc.ts'
import { rngFloat, rngFromSeed, rngInt, rngNext } from '../math/sfc32.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as BADGERS } from './factions/badgers.ts'

// The lobby's generated map. It seats a real faction on a fortress rather than
// a loose bag of soldiers, which is what makes the race pickers live here: a
// slot's race is the keep it starts with, so a map with no keep has no race to
// change. Composing on the shared BFME base is also what lets the Horde or the
// Compact be seated onto it at start — a faction can only be installed into
// rules whose damage and armor types it was balanced against.
export const SKIRMISH_VALLEY_DEF = composeDef({
  id: 'skirmish-valley',
  name: 'Skirmish Valley',
  factions: [BADGERS],
  victory: { mode: 'annihilation' },
})

// Both sides open as Badgers — a mirror. Pick something else in the lobby and
// the seating swaps this muster for that faction's, position for position.
const ARMY = BADGERS.startArmy!

// Room for a fortress and its rings: build plots sit 15 out from the keep and
// tower pads as far as 30, so a base needs far more ground than the loose
// skirmish army this map used to seat. Matches Ridge Crossing's proportions.
const COLS = 160
const ROWS = 160
const CELL = 1
const MID = COLS / 2
const BASE_R = 21 // start plateau: holds the keep and its ring of build plots
const MESA_R = 13

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

  const startA = { x: 33.5, z: ROWS / 2 + 0.5 }
  const startB = { x: COLS - 33.5, z: ROWS / 2 + 0.5 }
  // Neutral settlements out on the shoulders of the valley: the build plots
  // nobody owns, and the reason to leave your plateau at all.
  const settlements = [
    { x: MID - 34, z: MID - 36 },
    { x: MID - 34, z: MID + 36 },
    { x: MID + 34, z: MID - 36 },
    { x: MID + 34, z: MID + 36 },
  ]

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
  raiseCircle(startA.x, startA.z, BASE_R, 1)
  raiseCircle(startB.x, startB.z, BASE_R, 1)
  rampRect(42, midZ - 3, 56, midZ + 3) // A: east ramp
  rampRect(COLS - 57, midZ - 3, COLS - 43, midZ + 3) // B: west ramp
  rampRect(23, midZ - 29, 30, midZ - 17) // A: north flank ramp
  rampRect(COLS - 31, midZ + 17, COLS - 24, midZ + 29) // B: south flank ramp (mirrored)

  // central mesa with north+south ramps
  const cx = COLS / 2
  raiseCircle(cx, midZ, MESA_R, 1)
  rampRect(Math.floor(cx) - 3, midZ - 20, Math.floor(cx) + 2, midZ - 10)
  rampRect(Math.floor(cx) - 3, midZ + 10, Math.floor(cx) + 2, midZ + 20)

  // mirrored rock blobs on open ground (explicit blocking)
  const blobs = 8
  for (let b = 0; b < blobs; b++) {
    const bx = 13 + rngInt(rng, Math.floor(COLS / 2) - 24)
    const by = 10 + rngInt(rng, ROWS - 20)
    const r = 3 + rngFloat(rng) * 4
    const mirror = COLS - 1 - bx
    for (const rx of [bx, mirror]) {
      const dax = rx + 0.5 - startA.x
      const daz = by + 0.5 - startA.z
      const dbx = rx + 0.5 - startB.x
      const dbz = by + 0.5 - startB.z
      // Clear of a whole base, not just the keep: rock inside the plot rings
      // would cost that player build slots the mirrored side still has.
      const clear = r + 33
      if (dax * dax + daz * daz < clear * clear) continue
      if (dbx * dbx + dbz * dbz < clear * clear) continue
      const dcx = rx + 0.5 - cx
      const dcz = by + 0.5 - midZ
      if (dcx * dcx + dcz * dcz < (r + 16) * (r + 16)) continue
      // ...and clear of the settlements, which are the same kind of prize
      let onPrize = false
      for (const st of settlements) {
        const sdx = rx + 0.5 - st.x
        const sdz = by + 0.5 - st.z
        if (sdx * sdx + sdz * sdz < (r + 8) * (r + 8)) onPrize = true
      }
      if (onPrize) continue
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
        if (d < 20) h *= smooth(Math.max(0, Math.min(1, (d - 7) / 13)))
      }
      if (walkable[i] === 0) h += 1.2 + valueNoise(noiseSeed ^ 13, x * 0.5, y * 0.5) * 0.9
      heightJitter[i] = h
    }
  }

  // Each side opens with a fortress and its muster, formed up on the flank
  // facing the valley. The battalions stand OUTSIDE the keep's build ring so
  // its plots have room to appear.
  const placed: PlacedEntity[] = []
  for (let owner = 0; owner < 2; owner++) {
    const st = owner === 0 ? startA : startB
    placed.push({ def: BADGERS.keep, owner, x: st.x, z: st.z })
    const toward = st.x < MID ? 1 : -1
    ARMY.forEach((def, k) => {
      placed.push({
        def,
        owner,
        x: st.x + toward * (17 + (k % 2) * 5),
        z: st.z - 9 + Math.floor(k / 2) * 9,
      })
    })
  }
  for (const st of settlements) placed.push({ def: 'settlement', owner: 0, x: st.x, z: st.z })

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
    // BFME is a two-race game: these are the armies a lobby may seat here.
    races: ['badgers', 'horde'],
    startLocations: [startA, startB],
    placed,
    gameDef: SKIRMISH_VALLEY_DEF,
  }
}
