import { describe, expect, it } from 'vitest'
import { deriveTerrain, findPath, setupMatch, walkGridFromDoc } from '@battlebadger/sim'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'

const doc = generateFourCorners()
const MID = doc.cols / 2
const PLAZA_R = 26
const KEEPS = new Set(['fortress', 'dark-fortress'])

// Muster points just outside each fortress — a fortress blocks its own
// footprint, so pathing from the exact start location always fails.
const outside = doc.startLocations.map((b) => ({
  x: b.x + (b.x < MID ? 12 : -12),
  z: b.z + (b.z < MID ? 12 : -12),
}))

describe('Four Corners (4-player, mountains and a shared middle)', () => {
  it('seats four players, each with a fortress and an army', () => {
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 4)
    expect(doc.startLocations.length).toBe(4)
    const units: number[] = [0, 0, 0, 0]
    let forts = 0
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i]) continue
      if (s.kind[i] === 0) units[s.owner[i]]++
      // either faction's keep counts — the map now seats both
      else if (KEEPS.has(s.def.entities[s.type[i]].id)) forts++
    }
    expect(forts).toBe(4)
    for (const slot of [0, 1, 2, 3]) {
      expect(units[slot], `slot ${slot} fielded nothing`).toBeGreaterThan(0)
    }
    // and it is a free-for-all: no slot shares a team
    expect(new Set([0, 1, 2, 3].map((p) => s.playerTeam[p])).size).toBe(4)
  })

  it('mountains seal the corners: the only way across is the middle', () => {
    const { walkable } = deriveTerrain(doc)
    const S = doc.cols
    let furthest = 0
    for (let k = 2; k < S - 2; k++) {
      for (const [x, z] of [
        [MID, k],
        [k, MID],
      ] as const) {
        if (walkable[Math.floor(z) * S + Math.floor(x)] !== 1) continue
        furthest = Math.max(furthest, Math.hypot(x - MID, z - MID))
      }
    }
    // every gap in the dividing arms lies inside the plaza
    expect(furthest, 'a corner-to-corner crossing exists outside the plaza').toBeLessThanOrEqual(
      PLAZA_R,
    )
  })

  it('every corner can still reach every other corner', () => {
    const grid = walkGridFromDoc(doc)
    setupMatch(doc, grid, 4)
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const p = findPath(grid, outside[a].x, outside[a].z, outside[b].x, outside[b].z)
        expect(p, `no route from corner ${a} to ${b}`).not.toBeNull()
      }
    }
  })

  it('neighbouring corners cannot see straight across — the ridge is in the way', () => {
    const grid = walkGridFromDoc(doc)
    // 0/3 and 1/2 are diagonal pairs and DO line up through the plaza; the
    // neighbours either side of a mountain arm must not.
    expect(grid.lineWalkable(outside[0].x, outside[0].z, outside[1].x, outside[1].z)).toBe(false)
    expect(grid.lineWalkable(outside[0].x, outside[0].z, outside[2].x, outside[2].z)).toBe(false)
  })

  it('the plaza itself is open ground', () => {
    const grid = walkGridFromDoc(doc)
    expect(grid.isWalkableWorld(MID, MID)).toBe(true)
  })
})
