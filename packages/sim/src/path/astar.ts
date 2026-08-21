import type { WalkGrid } from './walkgrid.ts'
import { Components } from './components.ts'

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

/**
 * The same ceiling, for a goal the component labelling has already shown to be
 * out of reach.
 *
 * Nearly half the searches that hit MAX_EXPANSIONS on Middle-earth are an army
 * ordered at something behind a shut gate. There is no route, so the search can
 * only end one way: expand the entire region the unit is standing in, twenty-
 * four thousand cells of it, and fall back to the closest cell it saw. That one
 * case was measured at a third of the whole simulation tick.
 *
 * Knowing up front that it is hopeless does not change what the unit should DO
 * — it still marches at the gate, which is what makes it start breaking the
 * thing down. It changes how long we are willing to look. A* orders its queue
 * by distance-to-goal, so it walks at the goal first and has found the closest
 * cell it will ever find long before it has finished touring the rest of the
 * map; the remaining expansions buy nothing.
 *
 * 4,000 is measured the only way this number CAN be measured honestly. Sweeping
 * it in a live match tells you nothing — change how long a search looks and you
 * change which units get stuck, so every arm drifts into a different battle and
 * the totals compare battles rather than budgets. Instead: capture every query
 * 600 ticks of a real Middle-earth match makes (7,077 of them) and replay that
 * one fixed workload against each candidate.
 *
 *      budget    A* time     queries that pick a different spot to walk to
 *      24,000    baseline    —
 *       8,000    -30%        1.7%
 *       4,000    -36%        2.0%
 *       2,000    -41%        2.8%
 *         500    -43%        3.5%
 *
 * The saving flattens out because what is left is the REACHABLE searches, which
 * still get the full budget and should. So the choice is really about fidelity,
 * and 4,000 buys most of the speed while 98% of searches still walk to exactly
 * the spot they walk to today.
 */
const UNREACHABLE_EXPANSIONS = 4000

/** Cached reachability labelling; rebuilt only when the terrain changes. */
const components = new Components()

/**
 * Memo of recent searches, keyed on the exact pair of cells.
 *
 * A stuck unit re-plans the same journey every twelve ticks, and on the big map
 * those journeys are long enough to hit the expansion ceiling — so the same
 * hopeless-length search gets run, at full price, over and over. Measured on
 * Middle-earth: of the 865 searches that burned the whole budget on a REACHABLE
 * goal in 600 ticks, 228 were an exact repeat of a pair already asked for.
 *
 * This is a memo, not a heuristic: a hit returns precisely what the search would
 * have returned, so it cannot change a single unit's route. Cleared outright
 * whenever the terrain moves, because a gate swinging open is exactly the case
 * where yesterday's answer is wrong.
 *
 * The returned array is shared, never copied. Every caller treats it as read
 * only — `stringPull` walks it and builds its own output — and a caller that
 * ever wanted to mutate one would have to copy it first.
 */
const MEMO_MAX = 512
const memo = new Map<number, number[] | null>()
let memoAt = -1
let memoFor: WalkGrid | null = null

/**
 * Keep a result only if finding it actually cost something. A short hop is
 * cheaper to redo than to remember, and letting thousands of them through would
 * evict the cross-map marches that are the entire point of the cache.
 */
const MEMO_WORTH_IT = 1000

function remember(key: number, path: number[] | null, expanded: number): void {
  if (key < 0 || expanded < MEMO_WORTH_IT) return
  // Oldest out first — Map iterates in insertion order, so the front key is the
  // least recently ADDED. Good enough: what matters is bounding the thing.
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next()
    if (!oldest.done) memo.delete(oldest.value)
  }
  memo.set(key, path)
}

function memoReset(grid: WalkGrid): void {
  if (memoFor === grid && memoAt === grid.revision) return
  memo.clear()
  memoAt = grid.revision
  memoFor = grid
}

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
  // Ask the cheap question first. Two integers decide whether this search can
  // possibly succeed, and a hopeless one gets a much shorter leash.
  const reachable = components.connected(grid, start, goal)
  // A caller that wants reachability rather than movement has its answer.
  if (!reachable && exact) return null
  const budget = reachable ? MAX_EXPANSIONS : UNREACHABLE_EXPANSIONS

  // `exact` changes what a failed search returns, so it never shares a memo
  // slot with a movement query. It is the map editor's one-off, not a hot path.
  memoReset(grid)
  const key = exact ? -1 : start * n + goal
  if (!exact) {
    const hit = memo.get(key)
    if (hit !== undefined) return hit
  }

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
    if (++expanded > budget) break
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
      remember(key, out, expanded)
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
  if (exact || nearest === start) {
    if (!exact) remember(key, null, expanded)
    return null
  }
  const out: number[] = []
  for (let c = nearest; c !== -1; c = parent[c]) out.push(c)
  out.reverse()
  remember(key, out, expanded)
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
