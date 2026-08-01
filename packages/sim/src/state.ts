import { type Rng, rngFromSeed } from './math/sfc32.ts'
import type { GameDefCompiled } from './defs/compile.ts'
import type { TriggerRuntime } from './systems/triggers.ts'

export const TICK_MS = 100
export const TICK_S = 0.1
// BFME-scale: a 4v4 fields thousands of soldiers, since a single battalion is
// already nine entities. Handles pack id | gen<<16, so this must stay < 2^16.
export const MAX_UNITS = 4096

// WC3-style order set. Move ignores enemies; AttackMove engages along the way;
// Hold never moves; Patrol walks a leg and returns; Follow shadows an ally;
// Attack chases one specific target until it dies.
export const Order = {
  Idle: 0,
  Move: 1,
  AttackMove: 2,
  Hold: 3,
  Patrol: 4,
  Follow: 5,
  Attack: 6,
} as const
export type OrderKind = (typeof Order)[keyof typeof Order]

export const Kind = { Unit: 0, Building: 1 } as const

/**
 * How a gate decides whether to stand open.
 *   Auto — opens for a nearby friendly when no enemy is close (sally ports)
 *   Open — held open regardless, because a player said so
 *   Shut — barred regardless, ditto
 * A manual gate starts Shut; an automatic one starts Auto. Either can be put
 * on any setting at runtime.
 */
export const GateMode = { Auto: 0, Open: 1, Shut: 2 } as const

// Waypoints as flat [x0, z0, x1, z1, ...]; i = current waypoint index.
export interface UnitPath {
  pts: number[]
  i: number
}

// Deterministic per-tick output for the client (messages, FX hooks).
// Derived data — NOT part of the hashed state.
export type SimEvent =
  | { t: 'died'; id: number; type: number; owner: number; x: number; z: number }
  | { t: 'spawned'; id: number; type: number; owner: number }
  | { t: 'doodadDied'; idx: number; type: number; x: number; z: number }
  | { t: 'message'; text: string; player: number } // player -1 = all
  | { t: 'panCamera'; player: number; x: number; z: number }
  | { t: 'impact'; x: number; z: number; radius: number }
  | { t: 'trample'; x: number; z: number }
  | { t: 'gateOpened'; idx: number; x: number; z: number }
  | { t: 'gateClosed'; idx: number; x: number; z: number }
  | { t: 'upgradeDone'; player: number; upgrade: number }

export const Harv = { None: 0, ToNode: 1, Gathering: 2, Inside: 3, ToDropoff: 4 } as const

// Static scenery + resource nodes. Doodads never move; blocking ones mark
// walkgrid cells at setup and restore them when destroyed.
export interface DoodadStore {
  count: number
  defIdx: Int32Array
  x: Float64Array
  z: Float64Array
  hp: Int32Array
  amount: Int32Array // remaining resource; -1 = infinite; 0+dead for depleted
  alive: Uint8Array
  occupants: Int32Array // harvesters currently claiming (inside/exclusive)
  blockedCells: number[][] // walkgrid cell indices this doodad blocks
}

export const MAX_PROJECTILES = 1024

// Shots in flight. Aimed at a fixed ground point chosen when the shot is
// fired, so a slow shell can be walked out of — that is what makes a siege
// weapon feel like one. Hashed: these decide who takes damage.
export interface ProjectileStore {
  count: number // high-water mark
  freeList: number[]
  alive: Uint8Array
  x: Float64Array
  z: Float64Array
  startX: Float64Array // launch point, so the client can arc the shot
  startZ: Float64Array
  tgtX: Float64Array // impact point, fixed at launch
  tgtZ: Float64Array
  speed: Float64Array
  damage: Int32Array
  splash: Float64Array
  edgePct: Int32Array
  owner: Int32Array
  srcType: Int32Array // shooter's def index, for the damage/armor table
  srcHorde: Int32Array // credits the kill, so siege earns veterancy
}

export function createProjectileStore(): ProjectileStore {
  return {
    count: 0,
    freeList: [],
    alive: new Uint8Array(MAX_PROJECTILES),
    x: new Float64Array(MAX_PROJECTILES),
    z: new Float64Array(MAX_PROJECTILES),
    startX: new Float64Array(MAX_PROJECTILES),
    startZ: new Float64Array(MAX_PROJECTILES),
    tgtX: new Float64Array(MAX_PROJECTILES),
    tgtZ: new Float64Array(MAX_PROJECTILES),
    speed: new Float64Array(MAX_PROJECTILES),
    damage: new Int32Array(MAX_PROJECTILES),
    splash: new Float64Array(MAX_PROJECTILES),
    edgePct: new Int32Array(MAX_PROJECTILES).fill(50),
    owner: new Int32Array(MAX_PROJECTILES),
    srcType: new Int32Array(MAX_PROJECTILES),
    srcHorde: new Int32Array(MAX_PROJECTILES).fill(-1),
  }
}

export const MAX_HORDES = 512

// A horde (BFME battalion): the real unit of play. Soldiers are entities, but
// selection, orders, formation, veterancy and command points all live here.
// A hero is just a horde of one, so levelling works uniformly.
export interface HordeStore {
  count: number // high-water mark
  freeList: number[]
  alive: Uint8Array
  owner: Int32Array
  defIdx: Int32Array // the horde ticket def (never spawned as an entity itself)
  formation: Int32Array // index into the ticket's formations
  level: Int32Array // 1-based
  xp: Int32Array
  faceX: Float64Array // formation facing (unit vector)
  faceZ: Float64Array
  destX: Float64Array // where the formation was last told to form up
  destZ: Float64Array
  members: number[][] // entity ids, in join order — slot order is this order
}

export function createHordeStore(): HordeStore {
  return {
    count: 0,
    freeList: [],
    alive: new Uint8Array(MAX_HORDES),
    owner: new Int32Array(MAX_HORDES),
    defIdx: new Int32Array(MAX_HORDES).fill(-1),
    formation: new Int32Array(MAX_HORDES),
    level: new Int32Array(MAX_HORDES).fill(1),
    xp: new Int32Array(MAX_HORDES),
    faceX: new Float64Array(MAX_HORDES),
    faceZ: new Float64Array(MAX_HORDES),
    destX: new Float64Array(MAX_HORDES),
    destZ: new Float64Array(MAX_HORDES),
    members: Array.from({ length: MAX_HORDES }, () => []),
  }
}

// SoA state. Entity id == array index. Slots recycle through a free list;
// `gen` bumps on despawn so stale external handles (id | gen<<16) are void.
export interface SimState {
  tick: number
  rng: Rng
  def: GameDefCompiled
  // Identity of the map this match is playing, from hash.mapContentHash.
  // setupMatch stamps it; 0 for a sim built without a doc (unit tests).
  mapHash: number
  count: number // high-water mark of used slots
  winner: number // -1 = none, else winning TEAM id
  playerCount: number // active player slots this match
  playerTeam: Int32Array // slot → team id
  // Per slot: 0 = human, 1..3 = computer opponent difficulty. Gameplay-
  // affecting and therefore hashed — clients that disagree about who is a bot
  // desync at tick 0 rather than diverging silently.
  aiLevel: Int32Array
  events: SimEvent[]
  freeList: number[]
  teamHadAny: Uint8Array // per team: ever had an entity
  hadBuilding: Uint8Array // per team: ever owned a building
  resources: Int32Array // [player * numResources + resIdx]
  supplyUsed: Int32Array // per player, recomputed each tick
  supplyCap: Int32Array
  powerUsed: Int32Array
  powerProvided: Int32Array
  doodads: DoodadStore
  projectiles: ProjectileStore
  hordes: HordeStore
  hordeOf: Int32Array // entity → horde index, -1 = loose unit
  trig: TriggerRuntime
  entityBlocked: number[][] // per entity: walkgrid cells blocked (buildings)
  // Upgrades a player has finished, [player * upgradeCount + upIdx].
  upgradeOwned: Uint8Array
  // Derived from upgradeOwned: integer percentages by [player * types + type].
  // Rebuilt when research completes rather than looked up per blow, because
  // these are read in the innermost combat and movement loops.
  upgDamagePct: Int32Array
  upgTakenPct: Int32Array
  upgRangePct: Int32Array
  upgSpeedPct: Int32Array
  gateOpen: Uint8Array // gates only: 1 while the footprint is standing open
  gateMode: Uint8Array // gates only: how it decides — see GateMode
  alive: Uint8Array
  hidden: Uint8Array // 1 = inside a node (WC3 mine); skipped by motion/combat/render
  gen: Uint16Array
  kind: Uint8Array
  posX: Float64Array
  posZ: Float64Array
  velX: Float64Array
  velZ: Float64Array
  faceX: Float64Array
  faceZ: Float64Array
  type: Int32Array
  owner: Int32Array
  hp: Int32Array
  order: Int32Array
  destX: Float64Array
  destZ: Float64Array
  target: Int32Array
  forced: Uint8Array // target was player-ordered: chase it, ignore distractions
  chased: Uint8Array // left its post to engage — walk back when done
  followTarget: Int32Array // ally being shadowed (Follow order)
  homeX: Float64Array // guard post: where an auto-engaging unit returns to
  homeZ: Float64Array
  patrolX: Float64Array // far end of the patrol leg
  patrolZ: Float64Array
  cooldown: Int32Array
  chargeCd: Int32Array // wind-down after a cavalry impact
  // Ticks a unit is still picking itself up after being knocked flying. It
  // cannot move, attack or cast while this is running — the pause is what
  // makes a knockback worth more than the shove itself.
  stun: Int32Array
  chargeRun: Int32Array // consecutive ticks at charge speed — the run-up
  carryRes: Int32Array // -1 = empty
  carryAmt: Int32Array
  // build plots: a plot holds one structure; a structure remembers its plot;
  // plots spawned by a fortress remember it so they die with it.
  plotHost: Int32Array // plot → building on it, -1 free
  plotOf: Int32Array // building → the plot it stands on, -1
  plotParent: Int32Array // plot → the building that spawned it, -1
  buildTicks: Int32Array // >0 = under construction
  queue: number[][] // per building: queued unit def indices
  queueTicks: Int32Array // progress on queue[0]
  rallyX: Float64Array
  rallyZ: Float64Array
  harvState: Uint8Array
  harvNode: Int32Array // doodad index, -1 none
  harvTimer: Int32Array // absolute tick when the current gather/inside completes
  stuck: Int32Array
  repathed: Uint8Array
  progress: Float64Array
  lastAttackTick: Int32Array
  // ---- one-shot ability casts (systems/casts.ts) ----
  castAb: Int32Array // pending ability index, -1 = none
  castX: Float64Array // cast point ('point'/cone aim)
  castZ: Float64Array
  castTarget: Int32Array // 'enemy' single-target cast, -1 = ground cast
  // per-ability cooldown, [id * def.abilities.length + abilityIdx]
  abCd: Int32Array
  paths: (UnitPath | null)[]
}

// Row stride of the per-unit `abCd` cooldown table. Every reader/writer must
// use this — a mismatch would silently alias one ability's cooldown onto
// another and desync clients that disagree.
export function abStride(def: GameDefCompiled): number {
  return Math.max(1, def.abilities.length)
}

export function createSim(seed: number, def: GameDefCompiled): SimState {
  const resources = new Int32Array(8 * Math.max(1, def.resources.length))
  for (let p = 0; p < 8; p++) {
    def.resources.forEach((r, ri) => {
      resources[p * def.resources.length + ri] = r.startAmount
    })
  }
  return {
    tick: 0,
    rng: rngFromSeed(seed),
    def,
    mapHash: 0,
    count: 0,
    winner: -1,
    playerCount: 2,
    playerTeam: Int32Array.from({ length: 8 }, (_, i) => i),
    aiLevel: new Int32Array(8),
    events: [],
    freeList: [],
    teamHadAny: new Uint8Array(8),
    hadBuilding: new Uint8Array(8),
    resources,
    supplyUsed: new Int32Array(8),
    supplyCap: new Int32Array(8),
    powerUsed: new Int32Array(8),
    powerProvided: new Int32Array(8),
    entityBlocked: Array.from({ length: MAX_UNITS }, () => []),
    upgradeOwned: new Uint8Array(8 * Math.max(1, def.upgrades.length)),
    upgDamagePct: new Int32Array(8 * def.entities.length).fill(100),
    upgTakenPct: new Int32Array(8 * def.entities.length).fill(100),
    upgRangePct: new Int32Array(8 * def.entities.length).fill(100),
    upgSpeedPct: new Int32Array(8 * def.entities.length).fill(100),
    gateOpen: new Uint8Array(MAX_UNITS),
    gateMode: new Uint8Array(MAX_UNITS),
    projectiles: createProjectileStore(),
    hordes: createHordeStore(),
    hordeOf: new Int32Array(MAX_UNITS).fill(-1),
    trig: {
      defs: [],
      regions: [],
      regionIdx: new Map(),
      trigIdx: new Map(),
      enabled: new Uint8Array(0),
      armed: new Uint8Array(0),
      timerNext: new Int32Array(0),
      prevRegionMask: new Int32Array(0),
      fired: new Int32Array(0),
    },
    doodads: {
      count: 0,
      defIdx: new Int32Array(0),
      x: new Float64Array(0),
      z: new Float64Array(0),
      hp: new Int32Array(0),
      amount: new Int32Array(0),
      alive: new Uint8Array(0),
      occupants: new Int32Array(0),
      blockedCells: [],
    },
    alive: new Uint8Array(MAX_UNITS),
    hidden: new Uint8Array(MAX_UNITS),
    gen: new Uint16Array(MAX_UNITS),
    kind: new Uint8Array(MAX_UNITS),
    posX: new Float64Array(MAX_UNITS),
    posZ: new Float64Array(MAX_UNITS),
    velX: new Float64Array(MAX_UNITS),
    velZ: new Float64Array(MAX_UNITS),
    faceX: new Float64Array(MAX_UNITS),
    faceZ: new Float64Array(MAX_UNITS),
    type: new Int32Array(MAX_UNITS),
    owner: new Int32Array(MAX_UNITS),
    hp: new Int32Array(MAX_UNITS),
    order: new Int32Array(MAX_UNITS),
    destX: new Float64Array(MAX_UNITS),
    destZ: new Float64Array(MAX_UNITS),
    target: new Int32Array(MAX_UNITS).fill(-1),
    forced: new Uint8Array(MAX_UNITS),
    chased: new Uint8Array(MAX_UNITS),
    followTarget: new Int32Array(MAX_UNITS).fill(-1),
    homeX: new Float64Array(MAX_UNITS),
    homeZ: new Float64Array(MAX_UNITS),
    patrolX: new Float64Array(MAX_UNITS),
    patrolZ: new Float64Array(MAX_UNITS),
    cooldown: new Int32Array(MAX_UNITS),
    chargeCd: new Int32Array(MAX_UNITS),
    stun: new Int32Array(MAX_UNITS),
    chargeRun: new Int32Array(MAX_UNITS),
    carryRes: new Int32Array(MAX_UNITS).fill(-1),
    carryAmt: new Int32Array(MAX_UNITS),
    plotHost: new Int32Array(MAX_UNITS).fill(-1),
    plotOf: new Int32Array(MAX_UNITS).fill(-1),
    plotParent: new Int32Array(MAX_UNITS).fill(-1),
    buildTicks: new Int32Array(MAX_UNITS),
    queue: Array.from({ length: MAX_UNITS }, () => []),
    queueTicks: new Int32Array(MAX_UNITS),
    rallyX: new Float64Array(MAX_UNITS),
    rallyZ: new Float64Array(MAX_UNITS),
    harvState: new Uint8Array(MAX_UNITS),
    harvNode: new Int32Array(MAX_UNITS).fill(-1),
    harvTimer: new Int32Array(MAX_UNITS),
    stuck: new Int32Array(MAX_UNITS),
    repathed: new Uint8Array(MAX_UNITS),
    progress: new Float64Array(MAX_UNITS),
    lastAttackTick: new Int32Array(MAX_UNITS).fill(-1000),
    castAb: new Int32Array(MAX_UNITS).fill(-1),
    castX: new Float64Array(MAX_UNITS),
    castZ: new Float64Array(MAX_UNITS),
    castTarget: new Int32Array(MAX_UNITS).fill(-1),
    abCd: new Int32Array(MAX_UNITS * abStride(def)),
    paths: Array.from({ length: MAX_UNITS }, () => null),
  }
}

// ---- horde lifecycle (rules live in systems/hordes.ts) ----

export function createHorde(s: SimState, ticketDefIdx: number, owner: number): number {
  const h = s.hordes
  const idx = h.freeList.length > 0 ? h.freeList.pop()! : h.count++
  if (idx >= MAX_HORDES) throw new Error('horde capacity exceeded')
  h.alive[idx] = 1
  h.owner[idx] = owner
  h.defIdx[idx] = ticketDefIdx
  h.formation[idx] = 0
  h.level[idx] = 1
  h.xp[idx] = 0
  h.faceX[idx] = owner === 0 ? 1 : -1
  h.faceZ[idx] = 0
  h.destX[idx] = 0
  h.destZ[idx] = 0
  h.members[idx] = []
  return idx
}

export function addMember(s: SimState, horde: number, id: number): void {
  s.hordes.members[horde].push(id)
  s.hordeOf[id] = horde
}

// A fallen soldier leaves the horde; the last one out dissolves it. Surviving
// members keep their order, so formation slots stay stable through casualties.
export function removeMember(s: SimState, id: number): void {
  const horde = s.hordeOf[id]
  if (horde < 0) return
  s.hordeOf[id] = -1
  const members = s.hordes.members[horde]
  const at = members.indexOf(id)
  if (at >= 0) members.splice(at, 1)
  if (members.length === 0) {
    s.hordes.alive[horde] = 0
    s.hordes.defIdx[horde] = -1
    s.hordes.freeList.push(horde)
  }
}

// Team relation: allied players never auto-target each other, can heal each
// other, and win/lose together.
export function allied(s: SimState, playerA: number, playerB: number): boolean {
  return s.playerTeam[playerA] === s.playerTeam[playerB]
}

// External command references: handle = id | (gen << 16). MAX_UNITS < 2^16.
export function handleOf(s: SimState, id: number): number {
  return id | (s.gen[id] << 16)
}

// Returns the live entity id for a handle, or -1 if stale/invalid.
export function resolveHandle(s: SimState, handle: number): number {
  const id = handle & 0xffff
  if (id >= s.count || s.alive[id] !== 1) return -1
  if (s.gen[id] !== handle >>> 16) return -1
  return id
}

// Cancel any harvest activity, releasing node occupancy claims.
export function releaseHarvest(s: SimState, id: number): void {
  if (s.harvState[id] === 0) return
  const n = s.harvNode[id]
  if (n >= 0 && (s.harvState[id] === Harv.Inside || s.harvState[id] === Harv.Gathering)) {
    const nd = s.def.entities[s.doodads.defIdx[n]].resourceNode
    if (nd && (nd.occupancy === 'inside' || nd.occupancy === 'exclusive')) {
      s.doodads.occupants[n] = Math.max(0, s.doodads.occupants[n] - 1)
    }
  }
  s.harvState[id] = Harv.None
  s.harvNode[id] = -1
  s.hidden[id] = 0
}

export function spawnUnit(s: SimState, typeIdx: number, owner: number, x: number, z: number): number {
  const id = s.freeList.length > 0 ? s.freeList.pop()! : s.count++
  if (id >= MAX_UNITS) throw new Error('entity capacity exceeded')
  const def = s.def.entities[typeIdx]
  s.alive[id] = 1
  s.hidden[id] = 0
  s.carryRes[id] = -1
  s.carryAmt[id] = 0
  s.harvState[id] = 0
  s.harvNode[id] = -1
  s.plotHost[id] = -1
  s.plotOf[id] = -1
  s.plotParent[id] = -1
  s.buildTicks[id] = 0
  s.queue[id] = []
  s.queueTicks[id] = 0
  s.rallyX[id] = 0
  s.rallyZ[id] = 0
  s.entityBlocked[id] = []
  // A great gate starts barred and is worked by hand; a sally port opens for
  // whoever walks up to it.
  s.gateOpen[id] = 0
  s.gateMode[id] = s.def.stats.gateManual[typeIdx] ? GateMode.Shut : GateMode.Auto
  s.kind[id] = def.kind === 'building' ? Kind.Building : Kind.Unit
  s.posX[id] = x
  s.posZ[id] = z
  s.velX[id] = 0
  s.velZ[id] = 0
  s.faceX[id] = owner === 0 ? 1 : -1
  s.faceZ[id] = 0
  s.type[id] = typeIdx
  s.owner[id] = owner
  s.hp[id] = s.def.stats.maxHp[typeIdx]
  s.order[id] = Order.Idle
  s.target[id] = -1
  s.forced[id] = 0
  s.chased[id] = 0
  s.followTarget[id] = -1
  s.homeX[id] = x
  s.homeZ[id] = z
  s.cooldown[id] = 0
  s.chargeCd[id] = 0
  s.stun[id] = 0
  s.chargeRun[id] = 0
  s.stuck[id] = 0
  s.repathed[id] = 0
  s.lastAttackTick[id] = -1000
  s.castAb[id] = -1
  s.castTarget[id] = -1
  const nAb = abStride(s.def)
  for (let a = 0; a < nAb; a++) s.abCd[id * nAb + a] = 0
  s.paths[id] = null
  s.teamHadAny[s.playerTeam[owner]] = 1
  // an empty plot is not a base: it must not put a team "in play" for victory
  if (def.kind === 'building' && !def.plot) s.hadBuilding[s.playerTeam[owner]] = 1
  s.events.push({ t: 'spawned', id, type: typeIdx, owner })
  return id
}

export function despawn(s: SimState, id: number): void {
  if (s.alive[id] !== 1) return
  releaseHarvest(s, id)
  removeMember(s, id)
  s.events.push({ t: 'died', id, type: s.type[id], owner: s.owner[id], x: s.posX[id], z: s.posZ[id] })
  s.alive[id] = 0
  s.hidden[id] = 0
  s.paths[id] = null
  s.castAb[id] = -1
  s.castTarget[id] = -1
  s.target[id] = -1
  s.forced[id] = 0
  s.followTarget[id] = -1
  s.gen[id] = (s.gen[id] + 1) & 0xffff
  s.freeList.push(id)
}
