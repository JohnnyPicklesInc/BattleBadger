import { Kind, type SimState } from '../state.ts'
import type { WalkGrid } from '../path/walkgrid.ts'

// Wall tops: soldiers standing on a curtain wall.
//
// This is NOT a second walkability layer. Units path to a wall on the ordinary
// ground grid and then MOUNT it — they stop being things that walk and become
// things that occupy a slot on a structure. Up there they are out of reach of
// anything swinging a sword from the ground, they shoot further for the height,
// and they come down with the wall if it falls.
//
// The cheap version of this feature would teleport a unit onto a wall from
// anywhere on the map. The reason it does not is that the walk is the whole
// tactical content: an archer battalion crossing open ground to reach the wall
// is a battalion you can catch in the open, and a wall whose garrison is
// already dead is a wall you can take.

/**
 * How far a soldier may be from a wall and still climb it. Generous, because
 * the wall's own footprint blocks pathing — a unit ordered onto a wall stops
 * against its side, which is already a couple of tiles from the centre.
 */
const MOUNT_RANGE = 4.5
/** Spacing between men along the wall's top. */
const SLOT_SPACING = 0.9
/**
 * An attacker needs at least this much reach to touch a man on a wall. Below
 * it you are swinging a sword at someone standing above you, which is the
 * entire point of a wall.
 */
export const WALL_REACH = 3

/** Is this unit standing on a wall top? */
export function onRampart(s: SimState, id: number): boolean {
  return s.onWall[id] >= 0
}

/**
 * Can `attacker` reach `victim`, given where the victim is standing? A ground
 * melee unit cannot touch a wall top; archers, engines and other wall tops can.
 */
export function canReachRampart(s: SimState, attacker: number, victim: number): boolean {
  if (s.onWall[victim] < 0) return true
  if (s.onWall[attacker] >= 0) return true
  return s.def.stats.atkRange[s.type[attacker]] >= WALL_REACH
}

/** Extra attack range a soldier gets from the wall he is standing on. */
export function rampartRangeBonus(s: SimState, id: number): number {
  const w = s.onWall[id]
  if (w < 0 || !s.alive[w]) return 0
  return s.def.stats.rampartRange[s.type[w]]
}

/**
 * Step off. Idempotent.
 *
 * The relocation is not cosmetic: a wall BLOCKS the cells it stands on, so a
 * man left at his slot position after dismounting is standing inside masonry —
 * he accepts orders and then cannot walk anywhere, which looks exactly like a
 * hung unit. Put him on the nearest ground that exists.
 */
export function dismount(s: SimState, id: number, grid?: WalkGrid): void {
  const wall = s.onWall[id]
  if (wall < 0) return
  s.onWall[id] = -1
  if (!grid) return
  if (grid.isWalkableWorld(s.posX[id], s.posZ[id])) return
  const near = grid.nearestWalkable(grid.cellX(s.posX[id]), grid.cellZ(s.posZ[id]))
  if (!near) return
  s.posX[id] = grid.centerX(near[0])
  s.posZ[id] = grid.centerZ(near[1])
}

function occupants(s: SimState, wall: number): number {
  let n = 0
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.onWall[i] === wall) n++
  return n
}

/**
 * Mount whoever has arrived, pin whoever is up there, and throw off whoever no
 * longer has a wall under them.
 *
 * Runs after movement has settled, so "has he arrived yet" is asked of this
 * tick's position rather than last tick's.
 */
export function ramparts(s: SimState, grid: WalkGrid): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Unit) continue

    // Already up: hold the slot, or fall if the wall is gone.
    const wall = s.onWall[i]
    if (wall >= 0) {
      if (!s.alive[wall] || st.rampartSlots[s.type[wall]] <= 0) {
        // The wall came down. So does everyone who was standing on it — a
        // garrison that survived its own wall by stepping neatly onto the
        // rubble would make breaching one pointless. The grid is passed so the
        // corpse is not left inside a footprint that has yet to be freed.
        s.hp[i] = 0
        dismount(s, i, grid)
        continue
      }
      // Pinned. Nothing that moves units may move a man on a wall.
      s.velX[i] = 0
      s.velZ[i] = 0
      continue
    }

    // Walking to one: mount if in reach and there is room.
    const want = s.wantWall[i]
    if (want < 0) continue
    if (!s.alive[want] || st.rampartSlots[s.type[want]] <= 0) {
      s.wantWall[i] = -1
      continue
    }
    const dx = s.posX[want] - s.posX[i]
    const dz = s.posZ[want] - s.posZ[i]
    const reach = MOUNT_RANGE + st.radius[s.type[want]]
    if (dx * dx + dz * dz > reach * reach) continue
    const slots = st.rampartSlots[s.type[want]]
    const taken = occupants(s, want)
    if (taken >= slots) {
      // Full. Give up rather than mill about at the foot of it forever.
      s.wantWall[i] = -1
      continue
    }
    // Stand him along the wall's length, evenly, so a manned wall reads as a
    // line of men rather than a pile on the middle.
    const fx = s.faceX[want]
    const fz = s.faceZ[want]
    const perpX = -fz
    const perpZ = fx
    const off = (taken - (slots - 1) / 2) * SLOT_SPACING
    s.posX[i] = s.posX[want] + perpX * off
    s.posZ[i] = s.posZ[want] + perpZ * off
    s.faceX[i] = fx
    s.faceZ[i] = fz
    s.onWall[i] = want
    s.wantWall[i] = -1
    s.velX[i] = 0
    s.velZ[i] = 0
  }
}
