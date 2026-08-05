import type { WalkGrid } from './walkgrid.ts'

// Grid A*, 8-connected, integer costs 10/14, no diagonal corner cutting.
// Tie-breaks: lower f, then lower h, then lower node index — fully stable.

/**
 * Scratch, reused across every search instead of allocated per call.
 *
 * This used to allocate six full-grid typed arrays inside findPath — g, f, h,
 * parent, closed and the heap. On a 160² map that is ~410 KB a call and merely
 * wasteful; at 480 x 384 it is ~3.9 MB, and the AI hands `applyCommands` one
 * order containing every idle unit it owns, so a single tick could plan seven
 * hundred paths and allocate nearly three gigabytes. That showed up as sim
 * steps of 1.3 SECONDS against a 7 ms median, and frames of over two.
 *
 * `stamp` is what makes reuse safe without clearing 184k cells each call: a
 * cell counts as unvisited unless it was stamped with the current generation,
 * so the buffers never need zeroing and results are identical to the
 * freshly-allocated version — same tie-breaks, same path, same everything.
 */
let cap = 0
let g = new Int32Array(0)
let f = new Int32Array(0)
let h = new Int32Array(0)
let parent = new Int32Array(0)
let heap = new Int32Array(0)
let seen = new Int32Array(0) // generation that last touched this cell
let closedAt = new Int32Array(0) // generation this cell was closed in
let gen = 0

function reserve(n: number): void {
  if (cap >= n) return
  cap = n
  g = new Int32Array(n)
  f = new Int32Array(n)
  h = new Int32Array(n)
  parent = new Int32Array(n)
  heap = new Int32Array(n + 1)
  seen = new Int32Array(n)
  closedAt = new Int32Array(n)
  gen = 0 // fresh buffers: no stamp may alias a previous generation
}

/**
 * Most nodes one search may expand before it gives up and returns the best it
 * found. A fixed integer, so every client expands the same nodes and stops at
 * the same one — bounded and still bit-identical across machines.
 *
 * Without it a single cross-map search on a 480 x 384 grid can expand tens of
 * thousands of cells and cost milliseconds, and the systems that path are
 * plural: a battalion order, a stuck-unit repath, an AI attack-move. Sixteen
 * unbounded searches in one tick measured 53 ms on their own.
 *
 * Truncating is not a failure mode here — findPath already returns the closest
 * cell it reached when a goal is unreachable, and the caller walks that way and
 * asks again. A long march becomes a few hops rather than one perfect route.
 *
 * 24,000 is measured, not chosen: at 6,000 a battalion could no longer march
 * the length of Dunhollow, and Last Alliance's citadel test failed with it.
 * Both pass from 20,000 up, so this is that with margin.
 */
const MAX_EXPANSIONS = 24000

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]
const COST = [10, 10, 10, 10, 14, 14, 14, 14]

/**
 * Grid A* from (sx,sy) to (tx,ty).
 *
 * When the goal cannot be reached at all, returns the best-effort path to the
 * closest cell the search DID reach, rather than nothing. "Get as close as you
 * can" is what an army ordered at a walled fortress should do: it marches up to
 * the gate and, being in acquire range of it, starts breaking it down. Refusing
 * to move at all reads as the order having been ignored.
 *
 * Pass `exact` to opt out, for callers that genuinely need reachability rather
 * than movement.
 */
export function findPath(
  grid: WalkGrid,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  exact = false,
): number[] | null {
  const cols = grid.cols
  const rows = grid.rows
  const n = cols * rows
  const start = sy * cols + sx
  const goal = ty * cols + tx
  if (!grid.isWalkable(sx, sy) || !grid.isWalkable(tx, ty)) return null
  if (start === goal) return [start]

  reserve(n)
  // A new generation invalidates every stamp at once. `seen` starts zeroed, so
  // generation 0 would read as "already visited" — hence the pre-increment.
  gen++
  if (gen === 0x7fffffff) {
    seen.fill(0)
    closedAt.fill(0)
    gen = 1
  }
  const visited = (id: number): boolean => seen[id] === gen
  const isClosed = (id: number): boolean => closedAt[id] === gen
  let heapSize = 0

  const less = (a: number, b: number): boolean => {
    if (f[a] !== f[b]) return f[a] < f[b]
    if (h[a] !== h[b]) return h[a] < h[b]
    return a < b
  }
  const push = (id: number): void => {
    let i = ++heapSize
    heap[i] = id
    while (i > 1) {
      const p = i >> 1
      if (less(heap[i], heap[p])) {
        const t = heap[i]
        heap[i] = heap[p]
        heap[p] = t
        i = p
      } else break
    }
  }
  const pop = (): number => {
    const top = heap[1]
    heap[1] = heap[heapSize--]
    let i = 1
    for (;;) {
      const l = i * 2
      const r = l + 1
      let m = i
      if (l <= heapSize && less(heap[l], heap[m])) m = l
      if (r <= heapSize && less(heap[r], heap[m])) m = r
      if (m === i) break
      const t = heap[i]
      heap[i] = heap[m]
      heap[m] = t
      i = m
    }
    return top
  }

  const hOf = (id: number): number => {
    const cx = id % cols
    const cy = (id - cx) / cols
    const adx = Math.abs(cx - tx)
    const ady = Math.abs(cy - ty)
    return 10 * Math.max(adx, ady) + 4 * Math.min(adx, ady)
  }

  seen[start] = gen
  parent[start] = -1
  g[start] = 0
  h[start] = hOf(start)
  f[start] = h[start]
  push(start)

  // Closest node the search reached, by heuristic distance to the goal. Tie
  // broken on lower g then lower index, so the fallback is as deterministic as
  // the path itself.
  let nearest = start
  let nearestH = h[start]

  let expanded = 0
  while (heapSize > 0) {
    if (++expanded > MAX_EXPANSIONS) break
    const cur = pop()
    if (isClosed(cur)) continue
    closedAt[cur] = gen
    if (h[cur] < nearestH || (h[cur] === nearestH && (g[cur] < g[nearest] || (g[cur] === g[nearest] && cur < nearest)))) {
      nearest = cur
      nearestH = h[cur]
    }
    if (cur === goal) {
      const out: number[] = []
      for (let c = goal; c !== -1; c = parent[c]) out.push(c)
      out.reverse()
      return out
    }
    const cx = cur % cols
    const cy = (cur - cx) / cols
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k]
      const ny = cy + DY[k]
      if (!grid.isWalkable(nx, ny)) continue
      // no cutting corners diagonally past blocked cells
      if (k >= 4 && (!grid.isWalkable(cx + DX[k], cy) || !grid.isWalkable(cx, cy + DY[k]))) continue
      const nid = ny * cols + nx
      if (isClosed(nid)) continue
      const ng = g[cur] + COST[k]
      if (!visited(nid) || ng < g[nid]) {
        seen[nid] = gen
        g[nid] = ng
        h[nid] = hOf(nid)
        f[nid] = ng + h[nid]
        parent[nid] = cur
        push(nid)
      }
    }
  }
  // Unreachable. Walk out to whatever we got closest to.
  if (exact || nearest === start) return null
  const out: number[] = []
  for (let c = nearest; c !== -1; c = parent[c]) out.push(c)
  out.reverse()
  return out
}

// Greedy string-pull: from each point, jump to the furthest visible cell center.
// Returns flat world waypoints [x0, z0, x1, z1, ...].
export function stringPull(
  grid: WalkGrid,
  cells: number[],
  fromX: number,
  fromZ: number,
): number[] {
  const out: number[] = []
  let px = fromX
  let pz = fromZ
  let i = 0
  while (i < cells.length) {
    let best = i
    for (let j = cells.length - 1; j > i; j--) {
      const c = cells[j]
      const cx = c % grid.cols
      const cy = (c - cx) / grid.cols
      if (grid.lineWalkable(px, pz, grid.centerX(cx), grid.centerZ(cy))) {
        best = j
        break
      }
    }
    const c = cells[best]
    const cx = c % grid.cols
    const cy = (c - cx) / grid.cols
    px = grid.centerX(cx)
    pz = grid.centerZ(cy)
    out.push(px, pz)
    if (best === cells.length - 1) break
    i = best + 1
  }
  return out
}
