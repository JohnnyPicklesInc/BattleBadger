import { fnv1aInit, fnv1aInt } from '../hash.ts'
import {
  expansionRings as ringsOf,
  validateGameDef,
  type AbilityDef,
  type EntityDef,
  type GameDef,
  type ResourceDef,
  type UpgradeDef,
} from './schema.ts'

// Compiled form: dense arrays + id→index maps + precomputed tables. The sim's
// hot loops index these by int and never touch strings.
export interface GameDefCompiled {
  raw: GameDef
  defHash: number // FNV-1a over the serialized JSON; folded into stateHash
  resources: ResourceDef[]
  resIndex: Map<string, number>
  entities: EntityDef[]
  entIndex: Map<string, number>
  abilities: AbilityDef[]
  abIndex: Map<string, number>
  // per-entity precomputed:
  costVec: Int32Array[] // [entIdx] → Int32Array(numResources)
  // ---- upgrades ----
  upgrades: UpgradeDef[]
  upgradeIndex: Map<string, number>
  upgradeCost: Int32Array[] // [upIdx] → Int32Array(numResources)
  upgradeApplies: number[][] // [upIdx] → entity type indices it improves
  upgradeRequires: number[][] // [upIdx] → entity type indices the owner needs
  upgradeSoldBy: number[][] // [entIdx] → upgrade indices this building researches
  entAbilities: number[][] // [entIdx] → ability indices
  entAutocast: boolean[][] // parallel to entAbilities
  requiresIdx: number[][] // [entIdx] → entity indices
  buildsIdx: number[][]
  trainsIdx: number[][]
  dropoffMask: Int32Array // [entIdx] → bitmask of accepted resource indices (≤32 resources)
  // hordes: per horde-ticket def
  hordeUnit: Int32Array // [entIdx] → member entity index, -1 = not a ticket
  hordeCount: Int32Array
  hordeSpacing: Float64Array
  hordeFormations: {
    kind: number
    damagePct: number
    damageTakenPct: number
    speedPct: number
    crushableLevel: number // 0 = keep the unit's own level
  }[][]
  hordeLevels: { xp: number; damagePct: number; damageTakenPct: number }[]
  plotAcceptsIdx: number[][] // [plot entIdx] → entity indices it hosts
  // [entIdx] → the rings of plots this building brings with it. Each ring has
  // its own plot type, so a keep can ring itself with build plots and then with
  // tower pads further out.
  expansionRings: { plot: number; offsets: number[] }[][]
  supplyName: string
  supplyHardCap: number // 0 = uncapped
  powerEnabled: boolean
  // damage type × armor type percent table, row-major [dmg * armorCount + armor].
  // Empty when the def declares no types — combat then skips the lookup.
  damageTable: Int32Array
  armorTypeCount: number
  anyIncome: boolean
  // per-entity income (resIdx -1 = none)
  income: {
    resIdx: Int32Array
    amount: Int32Array
    period: Int32Array
    group: Int32Array
    crowdRadius: Float64Array
    crowdPenaltyPct: Int32Array
    crowdFloorPct: Int32Array
  }
  // flat per-entity stat arrays for hot loops (0 where a block is absent)
  stats: {
    radius: Float64Array
    speed: Float64Array
    maxHp: Int32Array
    damage: Int32Array
    atkRange: Float64Array
    acquire: Float64Array
    vision: Float64Array
    atkPeriod: Int32Array
    atkKnockback: Float64Array
    atkKnockdown: Int32Array
    atkSplash: Float64Array
    atkSplashEdge: Int32Array
    projSpeed: Float64Array // 0 = hitscan
    projSplash: Float64Array
    projEdgePct: Int32Array
    projScatter: Float64Array
    chgMinSpeed: Float64Array // 0 = cannot charge
    chgDamage: Int32Array
    chgKnockback: Float64Array
    chgCooldown: Int32Array
    chgKnockdown: Int32Array
    chgRecoilPct: Int32Array
    gateRadius: Float64Array // >0 = a gate that opens for its owners
    gateManual: Uint8Array // 1 = starts barred and is worked by hand
    crusherLevel: Int32Array // what this unit can flatten; 0 = nothing
    crushableLevel: Int32Array // how easily it is flattened
    chargeGuard: Int32Array // damage returned to a charger that connects
    allyAb: Int32Array // first ally-target ability index, -1 none
    autoAcquire: Int8Array // 0 none, 1 enemy, 2 injuredAlly
    flying: Uint8Array
    // 1 = can hit ground, 2 = can hit air, 3 = both
    hitMask: Uint8Array
    isUnit: Uint8Array
    isBuilding: Uint8Array
    dmgType: Int32Array // -1 = untyped
    armorType: Int32Array // -1 = untyped
    xpValue: Int32Array
    isPlot: Uint8Array
    plotPlaced: Uint8Array // must be built on a plot
    untargetable: Uint8Array // plots + markers: no collision, no targeting
  }
}

/** Crushable level given to buildings by default: nothing reaches it. */
export const UNCRUSHABLE = 1_000_000

function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) | 0
  return h
}

export function compileGameDef(def: GameDef): GameDefCompiled {
  const errs = validateGameDef(def)
  if (errs.length > 0) throw new Error(`invalid GameDef "${def.id}": ${errs.join('; ')}`)
  if (def.resources.length > 32) throw new Error('at most 32 resources supported')
  if ((def.armorTypes ?? []).length > 32) throw new Error('at most 32 armor types supported')

  const resIndex = new Map(def.resources.map((r, i) => [r.id, i]))
  const entIndex = new Map(def.entities.map((e, i) => [e.id, i]))
  const abIndex = new Map(def.abilities.map((a, i) => [a.id, i]))

  const costVec = def.entities.map((e) => {
    const v = new Int32Array(def.resources.length)
    for (const c of e.cost ?? []) v[resIndex.get(c.resource)!] = c.amount
    return v
  })
  const upgrades = def.upgrades ?? []
  const upgradeIndex = new Map(upgrades.map((u, i) => [u.id, i]))
  const upgradeCost = upgrades.map((u) => {
    const v = new Int32Array(def.resources.length)
    for (const c of u.cost) v[resIndex.get(c.resource)!] = c.amount
    return v
  })
  const upgradeApplies = upgrades.map((u) => u.appliesTo.map((a) => entIndex.get(a)!))
  const upgradeRequires = upgrades.map((u) => (u.requires ?? []).map((r) => entIndex.get(r)!))
  const upgradeSoldBy = def.entities.map((e) =>
    upgrades.map((u, i) => (u.soldBy.includes(e.id) ? i : -1)).filter((i) => i >= 0),
  )

  const entAbilities = def.entities.map((e) => (e.abilities ?? []).map((a) => abIndex.get(a.ability)!))
  const entAutocast = def.entities.map((e) => (e.abilities ?? []).map((a) => a.autocast === true))
  const requiresIdx = def.entities.map((e) => (e.requires ?? []).map((r) => entIndex.get(r)!))
  const buildsIdx = def.entities.map((e) => (e.builder?.builds ?? []).map((b) => entIndex.get(b)!))
  const trainsIdx = def.entities.map((e) => (e.trainer?.trains ?? []).map((t) => entIndex.get(t)!))
  const dropoffMask = new Int32Array(def.entities.length)
  def.entities.forEach((e, i) => {
    for (const r of e.dropoff?.accepts ?? []) dropoffMask[i] |= 1 << resIndex.get(r)!
  })
  const FORMATION_KIND = { block: 0, line: 1, wedge: 2, ring: 3 } as const
  const hordeUnit = new Int32Array(def.entities.length).fill(-1)
  const hordeCount = new Int32Array(def.entities.length)
  const hordeSpacing = new Float64Array(def.entities.length)
  const hordeFormations = def.entities.map((e) =>
    (e.horde?.formations ?? []).map((f) => ({
      kind: FORMATION_KIND[f.kind],
      damagePct: f.damagePct ?? 100,
      damageTakenPct: f.damageTakenPct ?? 100,
      speedPct: f.speedPct ?? 100,
      crushableLevel: f.crushableLevel ?? 0,
    })),
  )
  def.entities.forEach((e, i) => {
    if (!e.horde) return
    hordeUnit[i] = entIndex.get(e.horde.unit)!
    hordeCount[i] = e.horde.count
    hordeSpacing[i] = e.horde.spacing
  })
  const hordeLevels = (def.hordeLevels ?? []).map((l) => ({
    xp: l.xp,
    damagePct: l.damagePct,
    damageTakenPct: l.damageTakenPct,
  }))

  const plotAcceptsIdx = def.entities.map((e) => (e.plot?.accepts ?? []).map((a) => entIndex.get(a)!))
  const expansionRings = def.entities.map((e) =>
    ringsOf(e).map((r) => {
      const offsets: number[] = []
      for (const o of r.offsets) offsets.push(o.dx, o.dz)
      return { plot: entIndex.get(r.plot)!, offsets }
    }),
  )

  // damage/armor matrix: default 100% everywhere, overridden per authored pair
  const dmgTypeIndex = new Map((def.damageTypes ?? []).map((t, i) => [t, i]))
  const armTypeIndex = new Map((def.armorTypes ?? []).map((t, i) => [t, i]))
  const armorTypeCount = armTypeIndex.size
  const damageTable = new Int32Array(dmgTypeIndex.size * armorTypeCount).fill(100)
  for (const m of def.damageTable ?? []) {
    damageTable[dmgTypeIndex.get(m.damage)! * armorTypeCount + armTypeIndex.get(m.armor)!] = m.pct
  }

  // income groups: buildings crowd only within the same group key
  const incomeGroupIndex = new Map<string, number>()
  const income = {
    resIdx: new Int32Array(def.entities.length).fill(-1),
    amount: new Int32Array(def.entities.length),
    period: new Int32Array(def.entities.length).fill(1),
    group: new Int32Array(def.entities.length).fill(-1),
    crowdRadius: new Float64Array(def.entities.length),
    crowdPenaltyPct: new Int32Array(def.entities.length),
    crowdFloorPct: new Int32Array(def.entities.length),
  }
  let anyIncome = false
  def.entities.forEach((e, i) => {
    if (!e.income) return
    anyIncome = true
    const key = e.income.group ?? e.id
    if (!incomeGroupIndex.has(key)) incomeGroupIndex.set(key, incomeGroupIndex.size)
    income.resIdx[i] = resIndex.get(e.income.resource)!
    income.amount[i] = e.income.amount
    income.period[i] = e.income.perTicks
    income.group[i] = incomeGroupIndex.get(key)!
    income.crowdRadius[i] = e.income.crowdRadius ?? 0
    income.crowdPenaltyPct[i] = e.income.crowdPenaltyPct ?? 0
    income.crowdFloorPct[i] = e.income.crowdFloorPct ?? 0
  })

  const n = def.entities.length
  const stats = {
    radius: new Float64Array(n),
    speed: new Float64Array(n),
    maxHp: new Int32Array(n),
    damage: new Int32Array(n),
    atkRange: new Float64Array(n),
    acquire: new Float64Array(n),
    vision: new Float64Array(n),
    atkPeriod: new Int32Array(n),
    atkKnockback: new Float64Array(n),
    atkKnockdown: new Int32Array(n),
    atkSplash: new Float64Array(n),
    atkSplashEdge: new Int32Array(n).fill(50),
    projSpeed: new Float64Array(n),
    projSplash: new Float64Array(n),
    projEdgePct: new Int32Array(n).fill(50),
    projScatter: new Float64Array(n),
    chgMinSpeed: new Float64Array(n),
    chgDamage: new Int32Array(n),
    chgKnockback: new Float64Array(n),
    chgCooldown: new Int32Array(n).fill(30),
    chgKnockdown: new Int32Array(n),
    chgRecoilPct: new Int32Array(n),
    gateRadius: new Float64Array(n),
    gateManual: new Uint8Array(n),
    crusherLevel: new Int32Array(n),
    crushableLevel: new Int32Array(n),
    chargeGuard: new Int32Array(n),
    allyAb: new Int32Array(n).fill(-1),
    autoAcquire: new Int8Array(n),
    flying: new Uint8Array(n),
    hitMask: new Uint8Array(n).fill(1), // ground only unless the def opts in
    isUnit: new Uint8Array(n),
    isBuilding: new Uint8Array(n),
    dmgType: new Int32Array(n).fill(-1),
    armorType: new Int32Array(n).fill(-1),
    xpValue: new Int32Array(n),
    isPlot: new Uint8Array(n),
    plotPlaced: new Uint8Array(n),
    untargetable: new Uint8Array(n),
  }
  def.entities.forEach((e, i) => {
    stats.radius[i] = e.radius
    stats.speed[i] = e.mover?.speed ?? 0
    stats.maxHp[i] = e.hp
    stats.isUnit[i] = e.kind === 'unit' ? 1 : 0
    stats.isBuilding[i] = e.kind === 'building' ? 1 : 0
    stats.xpValue[i] = e.xpValue ?? 0
    stats.isPlot[i] = e.plot ? 1 : 0
    stats.plotPlaced[i] = e.placement === 'plot' ? 1 : 0
    // plots are pads, not structures: nothing collides with them or shoots them
    stats.untargetable[i] = e.untargetable === true || e.plot !== undefined ? 1 : 0
    if (e.armorType !== undefined) stats.armorType[i] = armTypeIndex.get(e.armorType) ?? -1
    if (e.combat?.damageType !== undefined) stats.dmgType[i] = dmgTypeIndex.get(e.combat.damageType) ?? -1
    if (e.combat) {
      stats.damage[i] = e.combat.damage
      stats.atkRange[i] = e.combat.range
      stats.acquire[i] = e.combat.acquire
      stats.atkPeriod[i] = e.combat.periodTicks
      stats.atkKnockback[i] = e.combat.knockback ?? 0
      stats.atkKnockdown[i] = e.combat.knockdownTicks ?? 0
      stats.atkSplash[i] = e.combat.splashRadius ?? 0
      stats.atkSplashEdge[i] = e.combat.splashEdgePct ?? 50
      if (e.combat.damage > 0) stats.autoAcquire[i] = 1
      // A unit must notice a target at least as far away as it can shoot it.
      // With acquire below atkRange it walks INSIDE its own range before
      // engaging, which reads as "refuses to stop and shoot"; floored here so
      // every shooter plants at maximum range instead.
      if (stats.damage[i] > 0) stats.acquire[i] = Math.max(stats.acquire[i], stats.atkRange[i] + 0.5)
      const chg = e.combat.charge
      if (chg) {
        stats.chgMinSpeed[i] = chg.minSpeed
        stats.chgDamage[i] = chg.damage
        stats.chgKnockback[i] = chg.knockback ?? 0
        stats.chgCooldown[i] = chg.cooldownTicks ?? 30
        stats.chgRecoilPct[i] = chg.recoilPct ?? 0
        stats.chgKnockdown[i] = chg.knockdownTicks ?? 0
      }
      const proj = e.combat.projectile
      if (proj) {
        stats.projSpeed[i] = proj.speed
        stats.projSplash[i] = proj.splashRadius ?? 0
        stats.projEdgePct[i] = proj.edgePct ?? 50
        stats.projScatter[i] = proj.scatterRadius ?? 0
      }
    }
    // Sight must cover everything this entity can auto-engage, or it would
    // shoot at enemies its own player cannot see. Buildings get a wider base
    // so a base is not blind; doodads see nothing.
    if (e.kind !== 'doodad' && !e.plot) {
      const base = e.kind === 'building' ? 12 : 9
      stats.vision[i] = Math.max(e.vision ?? 0, base, stats.acquire[i] + 1, stats.atkRange[i] + 1)
    }
    stats.flying[i] = e.flying ? 1 : 0
    if (e.combat?.hits === 'air') stats.hitMask[i] = 2
    else if (e.combat?.hits === 'both') stats.hitMask[i] = 3
    stats.gateRadius[i] = e.gate?.openRadius ?? 0
    stats.gateManual[i] = e.gate?.manual ? 1 : 0
    stats.crusherLevel[i] = e.crusherLevel ?? 0
    stats.chargeGuard[i] = e.chargeGuard ?? 0
    // Buildings are uncrushable unless an author deliberately says otherwise —
    // a stray crusherLevel must never let cavalry flatten a fortress.
    stats.crushableLevel[i] =
      e.crushableLevel ?? (e.kind === 'building' || e.flying ? UNCRUSHABLE : 0)
    // A build plot is a surveyed pad, not a garrison: it sees nothing. Left
    // sighted, the ring of neutral settlements would light up half the map for
    // whichever slot happens to hold their placement ownership.
    for (const a of e.abilities ?? []) {
      const abIdx = abIndex.get(a.ability)!
      const ab = def.abilities[abIdx]
      if (ab.target === 'ally' && stats.allyAb[i] === -1) stats.allyAb[i] = abIdx
      if (a.autocast && ab.autoAcquire === 'injuredAlly') {
        stats.autoAcquire[i] = 2
        if (stats.acquire[i] === 0) stats.acquire[i] = ab.range * 2
      }
      if (a.autocast && ab.autoAcquire === 'enemy' && stats.autoAcquire[i] === 0) {
        stats.autoAcquire[i] = 1
        if (stats.acquire[i] === 0) stats.acquire[i] = ab.range * 2
      }
    }
  })

  let h = fnv1aInit()
  h = hashString(h, JSON.stringify(def))
  h = fnv1aInt(h, def.entities.length)

  return {
    raw: def,
    defHash: h >>> 0,
    resources: def.resources,
    resIndex,
    entities: def.entities,
    entIndex,
    abilities: def.abilities,
    abIndex,
    costVec,
    upgrades,
    upgradeIndex,
    upgradeCost,
    upgradeApplies,
    upgradeRequires,
    upgradeSoldBy,
    entAbilities,
    entAutocast,
    requiresIdx,
    buildsIdx,
    trainsIdx,
    dropoffMask,
    hordeUnit,
    hordeCount,
    hordeSpacing,
    hordeFormations,
    hordeLevels,
    plotAcceptsIdx,
    expansionRings,
    supplyName: def.supplyName ?? '',
    supplyHardCap: def.supplyHardCap ?? 0,
    powerEnabled: def.powerEnabled === true,
    damageTable,
    armorTypeCount,
    anyIncome,
    income,
    stats,
  }
}
