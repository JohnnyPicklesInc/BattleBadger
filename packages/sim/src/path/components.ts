import type { WalkGrid } from './walkgrid.ts'

/**
 * Which cells can reach which, as a flat label per cell.
 *
 * A* spends its whole expansion budget before it can tell you a goal is
 * unreachable — it has to exhaust the component the unit is standing in to
 * prove nothing in it touches the goal. On the big maps that is where the
 * simulation's time goes: a third of all searches hit the cap, and between
 * them they cost more than everything else in the tick put together. Nearly
 * all of them are an army ordered at something behind a shut gate.
 *
 * Two cells carry the same label exactly when a unit can walk between them.
 * So the question A* answers in twenty-four thousand expansions is answered
 * here by comparing two integers.
 *
 * CONNECTIVITY MUST MATCH findPath EXACTLY. It steps eight ways but refuses to
 * cut a corner past blocked ground, so a diagonal needs both of its orthogonal
 * neighbours open. Label more loosely than that and this promises a route the
 * search cannot find — which costs only the search we were trying to avoid.
 * Label more tightly and it denies a route that exists, which strands an army.
 * The corner test is symmetric in the two cells, so "can step between" is a
 * genuine equivalence relation and the flood fill is well defined.
 */
const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

export class Components {
  /** Component id per cell; -1 for blocked ground. */
  private label = new Int32Array(0)
  /** Grid revision this labelling was built from; -1 = never built. */
  private builtAt = -1
  /**
   * The grid it was built for. Revision alone is not enough to spot staleness:
   * a process can hold several grids at once (the tests routinely do), and two
   * of the same size sitting on the same revision number would otherwise read
   * each other's labels.
   */
  private builtFor: WalkGrid | null = null
  private stack = new Int32Array(0)
  /** How many distinct regions the map is in. Diagnostic only. */
  count = 0

  /**
   * Can a unit standing on cell `a` walk to cell `b`?
   *
   * Blocked ground is never connected to anything, including itself — a caller
   * asking about a cell under a building gets `false`, which is the truthful
   * answer for a unit that cannot stand there in the first place.
   */
  connected(grid: WalkGrid, a: number, b: number): boolean {
    this.sync(grid)
    const la = this.label[a]
    return la >= 0 && la === this.label[b]
  }

  /** Rebuild if the terrain has changed since the last labelling. */
  private sync(grid: WalkGrid): void {
    if (this.builtFor === grid && this.builtAt === grid.revision) return
    this.build(grid)
  }

  private build(grid: WalkGrid): void {
    const n = grid.cols * grid.rows
    if (this.label.length !== n) {
      this.label = new Int32Array(n)
      this.stack = new Int32Array(n)
    }
    this.label.fill(-1)
    const cols = grid.cols
    const rows = grid.rows
    const walkable = grid.walkable
    const label = this.label
    const stack = this.stack
    let next = 0

    // Seeds are taken in ascending cell index and each region is flooded to
    // exhaustion before the next is seeded, so the labelling is a pure function
    // of the grid — same numbers on every client, every time.
    for (let seed = 0; seed < n; seed++) {
      if (walkable[seed] !== 1 || label[seed] !== -1) continue
      const id = next++
      label[seed] = id
      let top = 0
      stack[top++] = seed
      while (top > 0) {
        const cur = stack[--top]
        const cx = cur % cols
        const cy = (cur - cx) / cols
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX[k]
          const ny = cy + DY[k]
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const nid = ny * cols + nx
          if (walkable[nid] !== 1 || label[nid] !== -1) continue
          // no cutting corners diagonally past blocked cells — findPath's rule
          if (k >= 4 && (walkable[cy * cols + nx] !== 1 || walkable[ny * cols + cx] !== 1)) continue
          label[nid] = id
          stack[top++] = nid
        }
      }
    }
    this.count = next
    this.builtAt = grid.revision
    this.builtFor = grid
  }
}
