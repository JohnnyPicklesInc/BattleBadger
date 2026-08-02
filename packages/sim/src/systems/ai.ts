import type { PlayerCommand } from '../commands.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { Harv, Kind, Order, handleOf, type SimState } from '../state.ts'
import { plotClaimable, requiresMet, supplyRoom, validPlacement } from './economy.ts'
import { hasUpgrade, upgradeInProgress, upgradeRequiresMet } from './upgrades.ts'

// Computer opponents.
//
// The AI is a set of capability-gated JOBS, not a per-map script. Each job
// declares a structural precondition read off the compiled GameDef — "is there
// an entity with a harvester block?", "is there a building with a plot?" — and
// emits nothing when the def does not meet it. Map style therefore falls out of
// the data: Dunhollow lights up plot-building and never asks about harvesters,
// Econ Demo does the reverse, and Skirmish Valley (which has no economy at all)
// runs only the army job. No job ever branches on which map it is.
//
// Two rules keep this safe in lockstep:
//
//   1. Jobs emit PlayerCommands and nothing else. Every decision goes through
//      the same applyCommands path a human's click does, so the AI physically
//      cannot do anything a player could not — no cheating, and the existing
//      command tests already cover its execution path.
//
//   2. Jobs are STATELESS. Intent is re-derived from SimState every pass
//      ("supply headroom < 2 → fix that"), so there is no AI memory to fold
//      into stateHash and no way for two clients to drift apart.
//
// Known limitation, deliberate for v1: the AI reads the whole board rather than
// its own FogState. Per-team fog would have to accumulate `explored` inside the
// hashed sim, which is a desync surface; the honest difficulty dial is the
// think period and an economy handicap, which is what shipped RTS use anyway.

/** Ticks between thinks at each level; slot offsets stagger the work. */
const THINK_PERIOD = [0, 20, 12, 6]


// Twelve compass directions as literal unit vectors. Authored rather than
// computed because trigonometry is banned in the sim (check-sim-purity.mjs).
const OFFSETS_X = [1, 0.87, 0.5, 0, -0.5, -0.87, -1, -0.87, -0.5, 0, 0.5, 0.87]
const OFFSETS_Z = [0, 0.5, 0.87, 1, 0.87, 0.5, 0, -0.5, -0.87, -1, -0.87, -0.5]

/** Income buildings to aim for before branching into production. */
const INCOME_TARGET = 4

/** Idle soldiers needed before the army job commits to an attack. */
const ATTACK_AT = [0, 12, 9, 6]

// ---- capability lookups (structural facts about the def) ----

interface Caps {
  harvesters: number[] // entity indices that gather
  trainers: number[] // building indices that train
  plotHosts: boolean // any def is placed on a plot
  supplyDefs: number[] // defs that add supply
  incomeDefs: number[] // defs that pay passively
}

function caps(s: SimState): Caps {
  const ents = s.def.entities
  const harvesters: number[] = []
  const trainers: number[] = []
  const supplyDefs: number[] = []
  const incomeDefs: number[] = []
  let plotHosts = false
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]
    if (e.harvester) harvesters.push(i)
    if (e.trainer) trainers.push(i)
    if (e.placement === 'plot') plotHosts = true
    if ((e.supplyProvided ?? 0) > 0) supplyDefs.push(i)
    if (e.income) incomeDefs.push(i)
  }
  return { harvesters, trainers, plotHosts, supplyDefs, incomeDefs }
}

// ---- shared helpers (all id-ordered, so every client agrees) ----

function isEnemy(s: SimState, slot: number, i: number): boolean {
  return s.playerTeam[s.owner[i]] !== s.playerTeam[slot]
}

/** Nearest enemy entity to (x, z) that is worth walking at, or -1. */
function nearestEnemy(s: SimState, slot: number, x: number, z: number): number {
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i]) continue
    if (!isEnemy(s, slot, i)) continue
    if (s.def.stats.untargetable[s.type[i]]) continue
    const dx = s.posX[i] - x
    const dz = s.posZ[i] - z
    const d = dx * dx + dz * dz
    // strict < keeps the lowest id on ties — deterministic
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Crude combat worth per unit of cost; the fallback when no damage table exists. */
function militaryValue(s: SimState, defIdx: number): number {
  const st = s.def.stats
  const dmg = st.damage[defIdx]
  if (dmg <= 0) return 0
  let cost = 0
  for (const c of s.def.entities[defIdx].cost ?? []) cost += c.amount
  return (dmg * st.maxHp[defIdx]) / Math.max(1, cost)
}

/**
 * How well `defIdx` answers what the enemy actually fields, read straight off
 * the damage table the human plays by. Falls back to raw value when the def
 * declares no table (Econ Demo, Skirmish), which is right — those games have
 * nothing to counter.
 */
function counterScore(s: SimState, slot: number, defIdx: number): number {
  const base = militaryValue(s, defIdx)
  const table = s.def.damageTable
  if (base <= 0 || table.length === 0) return base
  const st = s.def.stats
  // the horde ticket fights through its member unit
  const fightIdx = hordeMemberDef(s, defIdx)
  const d = st.dmgType[fightIdx]
  if (d < 0) return base
  let weighted = 0
  let seen = 0
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || !isEnemy(s, slot, i)) continue
    const a = st.armorType[s.type[i]]
    const pct = a < 0 ? 100 : table[d * s.def.armorTypeCount + a]
    weighted += pct
    seen++
  }
  if (seen === 0) return base
  return (base * weighted) / (100 * seen)
}

/** A horde ticket's fighting unit, or the def itself when it is not a ticket. */
function hordeMemberDef(s: SimState, defIdx: number): number {
  const h = s.def.entities[defIdx].horde
  if (!h) return defIdx
  return s.def.entIndex.get(h.unit) ?? defIdx
}

function supplyTight(s: SimState, slot: number): boolean {
  return s.supplyCap[slot] > 0 && s.supplyUsed[slot] >= s.supplyCap[slot] - 2
}

// ---- jobs ----

/**
 * Idle gatherers go back to work. Gate: the def has harvesters and nodes.
 *
 * Workers are balanced ACROSS RESOURCES rather than all sent to the nearest
 * node — otherwise whichever resource happens to sit closest to the base gets
 * every worker and the other one starves, which on Econ Demo meant a forest
 * full of lumberjacks and a gold mine nobody ever visited.
 */
function jobHarvest(s: SimState, slot: number, c: Caps, out: PlayerCommand[]): void {
  if (c.harvesters.length === 0) return
  const d = s.doodads
  const numRes = s.def.resources.length
  const nodeRes = (n: number): number => {
    const node = s.def.entities[d.defIdx[n]].resourceNode
    if (!node) return -1
    return s.def.resIndex.get(node.resource) ?? -1
  }

  // how many of our workers are already committed to each resource
  const assigned = new Array<number>(numRes).fill(0)
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.owner[i] !== slot) continue
    const n = s.harvNode[i]
    if (n < 0 || d.alive[n] !== 1) continue
    const r = nodeRes(n)
    if (r >= 0) assigned[r]++
  }

  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || s.owner[i] !== slot) continue
    const h = s.def.entities[s.type[i]].harvester
    if (!h) continue
    if (s.harvState[i] !== Harv.None) continue // already working

    // Pick the reachable resource this slot has fewest workers on, then the
    // nearest node of it. Ties break on the lower resource index, then id.
    let best = -1
    let bestAssigned = Infinity
    let bestD = Infinity
    for (let n = 0; n < d.count; n++) {
      if (d.alive[n] !== 1 || d.amount[n] === 0) continue
      const node = s.def.entities[d.defIdx[n]].resourceNode
      if (!node || !h.nodeTags.includes(node.tag)) continue
      const r = nodeRes(n)
      const a = r >= 0 ? assigned[r] : 0
      const dx = d.x[n] - s.posX[i]
      const dz = d.z[n] - s.posZ[i]
      const dist = dx * dx + dz * dz
      if (a < bestAssigned || (a === bestAssigned && dist < bestD)) {
        bestAssigned = a
        bestD = dist
        best = n
      }
    }
    if (best >= 0) {
      const r = nodeRes(best)
      if (r >= 0) assigned[r]++ // count it now so the next worker balances against it
      out.push({
        kind: 'harvest', player: slot, units: [handleOf(s, i)],
        x: d.x[best], z: d.z[best], target: -1 - best,
      })
    }
  }
}

/** Keep training queues fed. Gate: the def has a trainer building. */
function jobProduce(s: SimState, slot: number, c: Caps, reserve: Reserve, out: PlayerCommand[]): void {
  if (c.trainers.length === 0) return
  const tight = supplyTight(s, slot)
  for (let b = 0; b < s.count; b++) {
    if (!s.alive[b] || s.owner[b] !== slot || s.kind[b] !== Kind.Building) continue
    if (s.buildTicks[b] > 0) continue
    const trains = s.def.trainsIdx[s.type[b]]
    if (!trains || trains.length === 0) continue
    const cap = s.def.entities[s.type[b]].trainer?.queueSize ?? 1
    if (s.queue[b].length >= Math.min(cap, 2)) continue // keep it shallow, stay reactive

    let pick = -1
    let pickScore = -Infinity
    for (const t of trains) {
      if (!requiresMet(s, slot, t) || !affordableAfter(s, slot, t, reserve) || !supplyRoom(s, slot, t)) continue
      // A supply crunch outranks everything a barracks could make.
      const providesSupply = (s.def.entities[t].supplyProvided ?? 0) > 0
      const score = tight && providesSupply ? 1e6 : counterScore(s, slot, t)
      if (score > pickScore) {
        pickScore = score
        pick = t
      }
    }
    // Nothing scored (all non-combat, e.g. a hall that only makes workers):
    // fall back to the first affordable option so economy still ticks over.
    if (pick < 0 || pickScore <= 0) {
      for (const t of trains) {
        if (requiresMet(s, slot, t) && affordableAfter(s, slot, t, reserve) && supplyRoom(s, slot, t)) {
          pick = t
          break
        }
      }
    }
    if (pick >= 0) {
      out.push({ kind: 'train', player: slot, units: [handleOf(s, b)], x: 0, z: 0, def: pick })
      reserveCost(s, pick, reserve) // two buildings must not spend the same coin
    }
  }
}

/** Per-resource savings the build job has earmarked; production must not spend it. */
type Reserve = number[]

function affordableAfter(s: SimState, slot: number, defIdx: number, reserve: Reserve): boolean {
  const n = s.def.resources.length
  for (const c of s.def.entities[defIdx].cost ?? []) {
    const ri = s.def.resIndex.get(c.resource)
    if (ri === undefined) continue
    if (s.resources[slot * n + ri] - reserve[ri] < c.amount) return false
  }
  return true
}

function reserveCost(s: SimState, defIdx: number, reserve: Reserve): void {
  for (const c of s.def.entities[defIdx].cost ?? []) {
    const ri = s.def.resIndex.get(c.resource)
    if (ri !== undefined) reserve[ri] += c.amount
  }
}

const THREAT_R = 26

/**
 * Where this slot is being attacked, or null.
 *
 * A single point rather than a per-plot test, because a per-plot test is
 * plots x units and a big siege map has a hundred plots and hundreds of units.
 * The nearest enemy to the base centroid is a good enough answer to "which end
 * of my base is on fire", and it costs one pass.
 */
function threatPoint(s: SimState, slot: number): { x: number; z: number } | null {
  let bx = 0
  let bz = 0
  let n = 0
  for (let b = 0; b < s.count; b++) {
    if (!s.alive[b] || s.owner[b] !== slot || s.kind[b] !== Kind.Building) continue
    bx += s.posX[b]
    bz += s.posZ[b]
    n++
  }
  if (n === 0) return null
  bx /= n
  bz /= n
  let best = -1
  let bestD = Infinity
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || s.kind[i] !== Kind.Unit) continue
    if (!isEnemy(s, slot, i)) continue
    if (s.def.stats.damage[s.type[i]] <= 0) continue
    const dx = s.posX[i] - bx
    const dz = s.posZ[i] - bz
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  if (best < 0) return null
  return { x: s.posX[best], z: s.posZ[best] }
}

/** How badly this slot wants `defIdx` on a plot, ignoring whether it can pay. */
function plotPriority(
  s: SimState,
  slot: number,
  defIdx: number,
  incomeCount: number,
  threatened: boolean,
  freeOwnPlots: number,
): number {
  const e = s.def.entities[defIdx]
  // A camp or a second castle is not one building so much as three, six or
  // twelve: it pays for itself only through the ring it opens. So it is worth
  // the price exactly when there is nowhere left to build — which is also the
  // moment the AI would otherwise sit on a growing pile of money.
  if (s.def.expansionRings[defIdx].length > 0) return freeOwnPlots === 0 ? 350 : 40
  // Something that shoots, on a plot the enemy is actually near, outranks the
  // economy — this is what puts an engine on a siege emplacement while the wall
  // is being hit rather than four hundred ticks later. Gated on already having
  // an income, because an AI that fortifies before it earns never does either.
  if (threatened && incomeCount > 0 && (e.combat?.damage ?? 0) > 0) return 900
  if (e.income) return incomeCount < INCOME_TARGET ? 400 : 200
  if (e.trainer) {
    // the first of each production building matters far more than the second
    let have = 0
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === slot && s.type[i] === defIdx) have++
    }
    return have === 0 ? 300 : 100
  }
  return 50 // towers and other odds and ends, only once the base works
}

/**
 * Claim empty build plots. Gate: the def places structures on plots.
 *
 * Crucially this SAVES: it decides what it wants most and waits for the price
 * rather than spending the difference on whatever happens to be affordable.
 * Without that the cheapest option wins every pass — the AI paved Dunhollow
 * with watchtowers and never once reached a barracks.
 */
function jobBuildPlot(s: SimState, slot: number, c: Caps, reserve: Reserve, out: PlayerCommand[]): void {
  if (!c.plotHosts) return
  let incomeCount = 0
  // Free pads inside its own base — the ring a keep or a camp opened. Neutral
  // sites out on the map are deliberately not counted: an unclaimed settlement
  // is ground to take, not somewhere the AI can already build.
  let freeOwnPlots = 0
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i]) continue
    if (s.owner[i] === slot && s.def.entities[s.type[i]].income) incomeCount++
    const plot = s.def.entities[s.type[i]].plot
    if (plot && !plot.neutral && s.owner[i] === slot && s.plotHost[i] < 0) freeOwnPlots++
  }
  const threat = threatPoint(s, slot)

  let bestPlot = -1
  let bestDef = -1
  let bestPri = -1
  for (let p = 0; p < s.count; p++) {
    if (!s.alive[p] || s.kind[p] !== Kind.Building) continue
    const plot = s.def.entities[s.type[p]].plot
    if (!plot) continue
    if (s.plotHost[p] >= 0) continue // occupied
    if (s.owner[p] !== slot && !plot.neutral) continue
    // same proximity rule the command path enforces — without this the AI
    // would earmark resources for a settlement it has no presence near and
    // save for it forever
    if (!plotClaimable(s, slot, p)) continue
    for (const t of s.def.plotAcceptsIdx[s.type[p]]) {
      if (!requiresMet(s, slot, t)) continue
      // A camp is bought out of surplus, never saved for. Everything else on a
      // plot is finite — build it and the want is gone — but there is always
      // one more site on the map, so an AI that earmarked a camp's price
      // earmarked it forever: it stopped researching entirely, which is how
      // this rule was found.
      if (s.def.expansionRings[t].length > 0 && !affordableAfter(s, slot, t, reserve)) continue
      const nearThreat =
        threat !== null &&
        (threat.x - s.posX[p]) * (threat.x - s.posX[p]) + (threat.z - s.posZ[p]) * (threat.z - s.posZ[p]) <
          THREAT_R * THREAT_R
      const pri = plotPriority(s, slot, t, incomeCount, nearThreat, freeOwnPlots)
      if (pri > bestPri) {
        bestPri = pri
        bestDef = t
        bestPlot = p
      }
    }
  }
  if (bestDef < 0) return
  if (affordableAfter(s, slot, bestDef, reserve)) {
    out.push({ kind: 'build', player: slot, units: [], x: s.posX[bestPlot], z: s.posZ[bestPlot], def: bestDef })
    reserveCost(s, bestDef, reserve) // do not let production spend it too
  } else {
    // save up: earmark the price so jobProduce cannot fritter it away
    reserveCost(s, bestDef, reserve)
  }
}


/**
 * Free-placement construction (Econ Demo and any custom map with builders).
 * Gate: something this slot owns has a builder block.
 *
 * Only two things are ever worth building here, and both are structural
 * signals rather than authored knowledge: supply when the cap is binding, and
 * the first of a production building when there is none. Without this the AI
 * harvests happily and then plateaus the moment supply fills up.
 */
function jobBuildFree(
  s: SimState,
  grid: WalkGrid,
  slot: number,
  reserve: Reserve,
  out: PlayerCommand[],
): void {
  // a builder to do the work, and an anchor to build near
  let builder = -1
  let anchorX = 0
  let anchorZ = 0
  let anchor = -1
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || s.owner[i] !== slot) continue
    if (builder < 0 && s.def.buildsIdx[s.type[i]].length > 0 && s.kind[i] === Kind.Unit) builder = i
    if (anchor < 0 && s.kind[i] === Kind.Building) {
      anchor = i
      anchorX = s.posX[i]
      anchorZ = s.posZ[i]
    }
  }
  if (builder < 0) return
  if (anchor < 0) {
    anchorX = s.posX[builder]
    anchorZ = s.posZ[builder]
  }

  const options = s.def.buildsIdx[s.type[builder]]
  const tight = supplyTight(s, slot)
  let pick = -1
  let pickPri = -1
  for (const t of options) {
    if (!requiresMet(s, slot, t)) continue
    const e = s.def.entities[t]
    let pri = -1
    if (tight && (e.supplyProvided ?? 0) > 0) pri = 400
    else if (e.trainer) {
      let have = 0
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot && s.type[i] === t) have++
      if (have === 0) pri = 300
    }
    if (pri > pickPri) {
      pickPri = pri
      pick = t
    }
  }
  if (pick < 0 || pickPri < 0) return
  if (!affordableAfter(s, slot, pick, reserve)) {
    reserveCost(s, pick, reserve) // save for it
    return
  }

  // Deterministic outward spiral from the anchor: fixed ring order, fixed
  // angular steps, first valid cell wins. No RNG, so every client agrees.
  const r = s.def.stats.radius[pick]
  for (let ring = 1; ring <= 8; ring++) {
    const dist = r * 2 + ring * 2.5
    for (let k = 0; k < 12; k++) {
      // 12 fixed compass points, unrolled as integer offsets (no trigonometry)
      const ox = OFFSETS_X[k] * dist
      const oz = OFFSETS_Z[k] * dist
      const x = anchorX + ox
      const z = anchorZ + oz
      if (!validPlacement(s, grid, pick, x, z, slot)) continue
      out.push({ kind: 'build', player: slot, units: [handleOf(s, builder)], x, z, def: pick })
      reserveCost(s, pick, reserve)
      return
    }
  }
}

/**
 * Gather idle soldiers and throw them at the nearest enemy once there are
 * enough. Gate: owning anything with a weapon — true on every map.
 */
/**
 * Buy research. Gate: the def has upgrades and this slot owns a building that
 * sells one.
 *
 * Scored by what the slot ACTUALLY FIELDS, not by what the upgrade claims: an
 * armour upgrade for cavalry is worth nothing to an army with no horses, and
 * the AI has no business paying for it. That keeps this structural — no job
 * knows what "forged blades" means, only how many of its units an upgrade
 * touches and by how much.
 */
function jobResearch(s: SimState, slot: number, reserve: Reserve, out: PlayerCommand[]): void {
  const ups = s.def.upgrades
  if (ups.length === 0) return

  // How many of this slot's units each entity type accounts for, so an upgrade
  // can be priced against the army that exists.
  const owned = new Int32Array(s.def.entities.length)
  for (let i = 0; i < s.count; i++) {
    if (s.alive[i] && s.owner[i] === slot && s.kind[i] === Kind.Unit) owned[s.type[i]]++
  }

  let bestB = -1
  let bestUp = -1
  let bestScore = 0
  for (let b = 0; b < s.count; b++) {
    if (!s.alive[b] || s.owner[b] !== slot || s.kind[b] !== Kind.Building) continue
    if (s.buildTicks[b] > 0) continue
    for (const u of s.def.upgradeSoldBy[s.type[b]]) {
      if (hasUpgrade(s, slot, u) || upgradeInProgress(s, slot, u)) continue
      if (!upgradeRequiresMet(s, slot, u)) continue
      const def = ups[u]
      const weight =
        (def.damagePct ?? 0) + (def.armorPct ?? 0) + (def.rangePct ?? 0) + (def.speedPct ?? 0)
      let bodies = 0
      for (const t of s.def.upgradeApplies[u]) bodies += owned[t]
      const score = bodies * weight
      // Nothing to improve yet: skip rather than save for it, or an AI with a
      // barracks and no soldiers would sit on its money.
      if (score <= 0) continue
      if (score > bestScore) {
        bestScore = score
        bestUp = u
        bestB = b
      }
    }
  }
  if (bestUp < 0) return
  const n = s.def.resources.length
  const cost = s.def.upgradeCost[bestUp]
  for (let r = 0; r < n; r++) {
    // Research waits its turn behind buildings and troops: it is a multiplier
    // on an army, so it is worth nothing to a player who has neither.
    if (s.resources[slot * n + r] - reserve[r] < cost[r]) return
  }
  for (let r = 0; r < n; r++) reserve[r] += cost[r]
  out.push({ kind: 'research', player: slot, units: [handleOf(s, bestB)], x: 0, z: 0, def: bestUp })
}

function jobArmy(s: SimState, slot: number, level: number, out: PlayerCommand[]): void {
  const st = s.def.stats
  const idle: number[] = []
  let cx = 0
  let cz = 0
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i] || s.owner[i] !== slot) continue
    if (s.kind[i] !== Kind.Unit || st.damage[s.type[i]] <= 0) continue
    if (s.harvState[i] !== Harv.None) continue // workers keep working
    if (s.order[i] !== Order.Idle) continue // already marching
    if (s.target[i] >= 0) continue // already fighting
    idle.push(i)
    cx += s.posX[i]
    cz += s.posZ[i]
  }
  if (idle.length < ATTACK_AT[level]) return
  cx /= idle.length
  cz /= idle.length
  const target = nearestEnemy(s, slot, cx, cz)
  if (target < 0) return
  out.push({
    kind: 'attackMove', player: slot,
    units: idle.map((i) => handleOf(s, i)),
    x: s.posX[target], z: s.posZ[target],
  })
}

/**
 * Every AI slot's commands for this tick. Deterministic and side-effect free:
 * it reads SimState and returns commands, so calling it on every client
 * produces the same orders without a byte crossing the network.
 */
export function aiCommands(s: SimState, grid: WalkGrid): PlayerCommand[] {
  const out: PlayerCommand[] = []
  let c: Caps | null = null
  for (let slot = 0; slot < 8; slot++) {
    const level = s.aiLevel[slot]
    if (level <= 0 || slot >= s.playerCount) continue
    const period = THINK_PERIOD[Math.min(level, THINK_PERIOD.length - 1)]
    // stagger by slot so eight AIs never think on the same tick
    if (period <= 0 || (s.tick + slot) % period !== 0) continue
    if (c === null) c = caps(s)
    const lvl = Math.min(level, ATTACK_AT.length - 1)
    // One shared ledger per slot per think, so two jobs cannot both spend the
    // same resources and have the second silently rejected at apply time.
    const reserve: Reserve = new Array(s.def.resources.length).fill(0)
    jobHarvest(s, slot, c, out)
    jobBuildPlot(s, slot, c, reserve, out)
    jobBuildFree(s, grid, slot, reserve, out)
    jobProduce(s, slot, c, reserve, out)
    jobResearch(s, slot, reserve, out)
    jobArmy(s, slot, lvl, out)
  }
  return out
}
