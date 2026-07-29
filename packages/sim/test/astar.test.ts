import { describe, expect, it } from 'vitest'
import { WalkGrid, findPath, stringPull } from '@battlebadger/sim'

function makeGrid(rows: string[]): WalkGrid {
  const h = rows.length
  const w = rows[0].length
  const walkable = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) walkable[y * w + x] = rows[y][x] === '.' ? 1 : 0
  }
  return new WalkGrid(w, h, 1, 0, 0, walkable, new Float64Array(w * h))
}

describe('grid A*', () => {
  it('routes around a wall', () => {
    const g = makeGrid([
      '..........',
      '..........',
      '####..####',
      '..........',
      '..........',
    ])
    const path = findPath(g, 1, 0, 1, 4)
    expect(path).not.toBeNull()
    // must pass through the gap at x∈{4,5}, y=2
    const gapCells = path!.filter((c) => Math.floor(c / 10) === 2)
    for (const c of gapCells) {
      const x = c % 10
      expect(x === 4 || x === 5).toBe(true)
    }
  })

  it('returns null when unreachable', () => {
    const g = makeGrid(['.....', '#####', '.....'])
    expect(findPath(g, 2, 0, 2, 2)).toBeNull()
  })

  it('never cuts corners diagonally', () => {
    const g = makeGrid(['..#', '.#.', '...'])
    const path = findPath(g, 0, 0, 2, 2)
    expect(path).not.toBeNull()
    for (let i = 1; i < path!.length; i++) {
      const a = path![i - 1]
      const b = path![i]
      const ax = a % 3
      const ay = (a - ax) / 3
      const bx = b % 3
      const by = (b - bx) / 3
      if (ax !== bx && ay !== by) {
        // diagonal step: both orthogonal cells must be walkable
        expect(g.isWalkable(bx, ay)).toBe(true)
        expect(g.isWalkable(ax, by)).toBe(true)
      }
    }
  })

  it('is stable: identical inputs produce identical paths', () => {
    const g = makeGrid([
      '........',
      '..##....',
      '..##....',
      '........',
      '....##..',
      '........',
    ])
    const p1 = findPath(g, 0, 0, 7, 5)
    const p2 = findPath(g, 0, 0, 7, 5)
    expect(p1).toEqual(p2)
    const s1 = stringPull(g, p1!, 0.5, 0.5)
    const s2 = stringPull(g, p2!, 0.5, 0.5)
    expect(s1).toEqual(s2)
  })
})
