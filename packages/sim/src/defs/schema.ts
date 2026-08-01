// GameDef: the authored, JSON-serializable definition of a game's rules.
// Human-diffable strings ids here; compile.ts turns it into dense int-indexed
// tables for the sim's hot loops. All economy numbers are integers; rates are
// "amount per N ticks" — never per-second floats.

export interface ResourceDef {
  id: string
  name: string
  startAmount: number
  uiColor?: string
}

export type EntityKind = 'unit' | 'building' | 'doodad'

export type OccupancyModel = 'surround' | 'inside' | 'exclusive'

// Passive building income (BFME farms/mills): no harvester ever walks anywhere.
// A building pays `amount` every `perTicks`. Crowding models BFME's
// diminishing returns — each same-group building of the same owner inside
// `crowdRadius` cuts this building's payout by `crowdPenaltyPct`, never below
// `crowdFloorPct`. All integer percentages; the payout floors.
export interface IncomeDef {
  resource: string
  amount: number
  perTicks: number
  group?: string // default: the entity's own id (only identical buildings crowd)
  crowdRadius?: number
  crowdPenaltyPct?: number
  crowdFloorPct?: number
}

// A build plot: the pad a structure goes on. BFME has no free base building —
// plots are authored into the map (or spawned around a fortress) and a plot
// holds exactly one structure at a time. Plots don't collide, can't be
// attacked, and don't count as buildings for victory.
export interface PlotDef {
  accepts: string[] // entity ids that may be built here
  neutral?: boolean // any player may claim it (outer-map settlements)
}

// Structures a building spawns plots for when it appears — the expansion slots
// around a fortress. Offsets are relative to the building.
//
// A keep needs more than one KIND of slot: a wide ring of full build plots for
// its economy and barracks, and a further ring of small pads that take nothing
// but a tower. So an entity may declare several rings, each with its own plot
// type and its own offsets.
export interface ExpansionDef {
  plot: string // plot entity id
  offsets: { dx: number; dz: number }[]
}

// Hordes: the BFME battalion. A horde ticket is a def that is trained and
// paid for as one thing but spawns `count` soldiers of `unit` bound into one
// formation. The ticket is never itself an entity in the world.
export type FormationKind = 'block' | 'line' | 'wedge' | 'ring'

export interface FormationDef {
  id: string
  name: string
  kind: FormationKind
  hotkey?: string
  damagePct?: number // damage dealt, default 100
  damageTakenPct?: number // damage received, default 100 (porcupine < 100)
  speedPct?: number // default 100
  // Bracing. While a horde holds this stance its members use this crushable
  // level instead of their own, so a spear wall set to receive cavalry cannot
  // be ridden down at all. Absent = no override.
  crushableLevel?: number
}

export interface HordeDef {
  unit: string
  count: number
  spacing: number
  formations?: FormationDef[] // first entry is the default stance
}

// Veterancy ladder, shared by every horde and hero. Index 0 is level 1 and
// must be the 100/100 baseline; thresholds ascend.
export interface HordeLevelDef {
  xp: number
  damagePct: number
  damageTakenPct: number
}

// damage type × armor type → percent multiplier. Missing pairs are 100%.
// This is the whole rock-paper-scissors language: pikes vs cavalry, siege vs
// structures, fire vs wood.
export interface DamageMultiplier {
  damage: string
  armor: string
  pct: number
}

export interface EntityDef {
  id: string
  name: string
  kind: EntityKind
  radius: number
  hp: number // doodads: 0 = indestructible
  cost?: { resource: string; amount: number }[]
  buildTimeTicks?: number
  requires?: string[] // entity ids the owner must have alive & complete
  supplyCost?: number
  supplyProvided?: number
  powerCost?: number
  powerProvided?: number
  visual: {
    model: string // 'placeholder:capsule'|'placeholder:cone'|'placeholder:lathe'|'placeholder:box'|'placeholder:tree'|'placeholder:crystal'|'gen:<blueprint>'|'asset:<id>'
    scale?: number
    tint?: 'owner' | 'none'
  }
  // ---- optional component blocks ----
  armorType?: string // key into GameDef.armorTypes; absent = no multiplier
  xpValue?: number // experience awarded to the killer's horde
  horde?: HordeDef // this def is a horde ticket, not a world entity
  placement?: 'free' | 'plot' // 'plot' = must be built on a matching build plot
  plot?: PlotDef // this entity IS a build plot
  expansion?: ExpansionDef | ExpansionDef[] // plots this building spawns around itself
  untargetable?: boolean // never auto-acquired, never attackable (plots, markers)
  // ---- crush hierarchy (SAGE's crusher/crushable levels) ----
  // A charge flattens anything whose crushableLevel is STRICTLY BELOW its
  // crusherLevel. One number per unit expresses the whole ordering — foot <
  // mounted < engine < wall — so a new unit only has to declare its own
  // weight rather than every charger being taught about it.
  //
  // Defaults are deliberately safe: nothing crushes (0) and buildings are
  // effectively uncrushable, so an unauthored def can never be trampled by
  // accident.
  crusherLevel?: number
  crushableLevel?: number
  // Damage dealt back to anything that lands a charge on this unit — the
  // spear the horse ran onto. Independent of the crush hierarchy: a pike hurts
  // a charger whether or not it was braced to refuse one, which is why cavalry
  // does not simply farm loose spearmen.
  //
  // Braced units refuse the charge outright and deal the charger's own recoil
  // instead, so the two never stack on one impact.
  chargeGuard?: number
  mover?: { speed: number } // world units / second
  // Flight. A flyer ignores the walkgrid entirely: no pathing, no cliffs, no
  // buildings in the way, and nothing on the ground can shove or crush it. It
  // still collides with other flyers, so formations behave.
  //
  // Whether anything can SHOOT it is a separate question — see combat.hits.
  // That split is the whole point: air is only interesting because most ground
  // weapons cannot answer it.
  flying?: boolean
  // A flyer that must come down to strike. It dives, hits, and climbs out,
  // and for the whole of that it counts as a GROUND target — so spears and
  // swords can answer it in the moment it is committed.
  //
  // This is what stops air being a unit that hovers out of reach and grinds an
  // army down: the damage is real, but so is the window it opens.
  swoopTicks?: number
  // Sight radius for fog of war. Defaults to the larger of the unit's acquire
  // range and a floor, so a unit can always see whatever it auto-engages —
  // otherwise it would shoot at things its owner cannot see.
  vision?: number
  combat?: {
    damage: number
    range: number
    acquire: number
    periodTicks: number
    damageType?: string
    // What this weapon can reach. Absent = 'ground'.
    //
    // Ground-only is the right default because the alternative is absurd: with
    // 'both' a swordsman swats a gunship with his sword, which makes flight
    // worthless. Anti-air has to be opted INTO, per weapon — that opt-in IS
    // the counter web. Existing maps are unaffected, since nothing on them
    // flies for a ground-only weapon to miss.
    hits?: 'ground' | 'air' | 'both'
    // A shot that FLIES instead of landing instantly. The shell is aimed at
    // wherever the target stood when it left the barrel, so a slow round can
    // be dodged — that is the point of a siege weapon rather than a bug.
    projectile?: {
      speed: number // world units per second
      splashRadius?: number // 0/absent = the impact point only
      // fraction of full damage at the very edge of the splash (0..100).
      // Absent = 50, so a near miss still hurts but a direct hit is better.
      edgePct?: number
      // How far off the aim point a shot may land. Siege is artillery, not a
      // rifle: without scatter a battery all detonates on the same spot,
      // overkilling one soldier while the formation beside him walks on.
      // Absent = 0 (perfectly accurate).
      scatterRadius?: number
    }
    // A swing that SWEEPS. Everything within this radius of the struck target
    // takes the blow too, falling off toward the rim. Absent = 0, a single
    // target. This is what makes a big two-handed weapon worth its cost
    // against a mob: without it a slow heavy hitter is simply out-DPSed by
    // the ring of men surrounding it.
    splashRadius?: number
    splashEdgePct?: number // damage at the rim, 0..100; absent = 50
    // How far an ordinary swing throws what it hits. Unlike a charge this
    // needs no momentum — it is the weapon, not the wielder, doing the work,
    // which is how a troll's club sends bodies flying from a standstill.
    // Absent = 0, so a normal attack shoves nobody.
    knockback?: number
    // Ticks the shoved victim spends on the floor: no moving, no attacking,
    // no casting. Absent = 0, a shove with no stagger.
    knockdownTicks?: number
    // Cavalry impact. A unit travelling at least `minSpeed` that runs INTO an
    // enemy bowls it over: heavy one-off damage plus a shove, then a wind-down
    // before it can do it again. This is momentum, not a swing — it bypasses
    // the attack cooldown and reach entirely, so a charge has to be ridden in
    // and cannot be delivered from a standstill.
    charge?: {
      minSpeed: number // world units/sec below which no impact happens
      damage: number // replaces the weapon's damage for this hit
      knockback?: number // world units the victim is shoved; absent = 0
      cooldownTicks?: number // wind-down before another impact; absent = 30
      knockdownTicks?: number // ticks the victim spends getting back up
      // What the charger takes when its impact is REFUSED — when it runs into
      // something it cannot crush, such as braced pikes. Percentage of the
      // charge's own damage. Absent = 0, so bouncing off is merely wasted.
      recoilPct?: number
    }
  }
  // A gate: a wall section that stands open for its owners and barred to
  // everyone else. There is no team-aware pathing here and there does not need
  // to be — the gate simply unblocks its own footprint while friends are close
  // and no enemy is, which is what a gate looks like from the outside anyway.
  //
  // The result is that an attacker finds it shut and has to break it, while the
  // defenders walk through, and a sally port lets infantry out without opening
  // the wall to whoever is standing outside it.
  gate?: {
    openRadius: number // how close a friendly must be for it to swing open
    // A great gate is a decision, not a door sensor: it starts BARRED and its
    // owners work it by hand. A postern is the opposite — nobody wants to click
    // a sally port open every time a battalion files out, so it stays automatic.
    //
    // This only sets the STARTING mode. Either kind can be put on any of the
    // three settings at runtime, so a team that wants their gate on the sensor
    // may have it.
    manual?: boolean
  }
  income?: IncomeDef
  harvester?: {
    carryCapacity: number
    gatherAmount: number
    gatherPeriodTicks: number
    nodeTags: string[]
  }
  builder?: { builds: string[] }
  trainer?: { trains: string[]; queueSize: number }
  dropoff?: { accepts: string[] }
  resourceNode?: {
    tag: string
    resource: string
    amount: number // -1 = infinite
    occupancy: OccupancyModel
    maxOccupants?: number // inside/exclusive; default 1
    insideTicks?: number // inside: hidden duration per trip
    requiresExtractorOn?: boolean // node only harvestable via a building placed on it
  }
  extractorOn?: string // building must be placed on a node of this entity id
  abilities?: { ability: string; autocast?: boolean }[]
}

export interface AbilityDef {
  id: string
  name: string
  hotkey?: string // single letter, used by the client command card
  // 'ally' heals/buffs a clicked friendly (sustained, via the combat loop).
  // 'enemy' nukes a clicked foe, 'point' casts at ground, 'self' at the caster
  // — those three are one-shot casts on their own cooldown (systems/casts.ts).
  target: 'ally' | 'enemy' | 'self' | 'point'
  hpDelta: number // + heals, - damages
  range: number // cast range, caster edge to target
  periodTicks: number // cooldown between casts
  autoAcquire?: 'injuredAlly' | 'enemy'
  // Area of effect. Absent = just the clicked entity ('enemy') or the caster
  // ('self'). 'circle' centers on the cast point ('point') or the caster
  // ('self'); 'cone' opens from the caster toward the cast point.
  //
  // Cone width is a COSINE threshold rather than an angle: trigonometry is
  // banned in the sim (not bit-exact across engines — see
  // scripts/check-sim-purity.mjs), so the author supplies the cosine directly
  // and the test is a dot product. 0.87 ≈ 30° half-angle, 0.71 ≈ 45°,
  // 0.5 ≈ 60°, 0 = a 180° half-disc.
  area?: { shape: 'circle'; radius: number } | { shape: 'cone'; radius: number; halfAngleCos: number }
  // Who an area cast hits. Default: enemies when hpDelta < 0, allies when > 0.
  affects?: 'enemies' | 'allies' | 'all'
}

/**
 * A researched improvement, bought once and owned by the player for the match.
 *
 * Percentages, not flat numbers, and applied where the stat is USED rather than
 * baked into the compiled tables — the tables are per entity TYPE and an
 * upgrade is per player, so two armies of the same unit have to be able to hit
 * differently. Everything is integer percent, like formation stances, so it
 * cannot drift between clients.
 *
 * Hit points are deliberately absent: raising a maximum retroactively means
 * deciding what happens to the wounded, and that is a design question rather
 * than an arithmetic one.
 */
export interface UpgradeDef {
  id: string
  name: string
  hotkey?: string
  cost: { resource: string; amount: number }[]
  buildTimeTicks: number
  requires?: string[] // entity ids the owner must have alive & complete
  soldBy: string[] // buildings that research it
  appliesTo: string[] // entity ids it improves
  damagePct?: number // +25 = deals 125%
  armorPct?: number // +25 = takes 75%
  rangePct?: number // +20 = reaches 120%
  speedPct?: number // +10 = moves 110%
}

export interface VictoryDef {
  mode: 'annihilation' | 'buildingsDestroyed' | 'triggersOnly'
}

export interface GameDef {
  schema: 1
  id: string
  name: string
  resources: ResourceDef[]
  supplyName?: string
  supplyHardCap?: number
  powerEnabled?: boolean
  damageTypes?: string[]
  armorTypes?: string[]
  damageTable?: DamageMultiplier[]
  hordeLevels?: HordeLevelDef[]
  entities: EntityDef[]
  abilities: AbilityDef[]
  upgrades?: UpgradeDef[]
  victory: VictoryDef
}

/** An entity's expansion rings, however the author wrote them (one or many). */
export function expansionRings(e: EntityDef): ExpansionDef[] {
  if (!e.expansion) return []
  return Array.isArray(e.expansion) ? e.expansion : [e.expansion]
}

// Structural + referential validation. Returns a list of problems (empty = ok).
export function validateGameDef(def: GameDef): string[] {
  const errs: string[] = []
  const push = (m: string): void => {
    errs.push(m)
  }
  if (def.schema !== 1) push(`unsupported schema ${def.schema}`)
  const resIds = new Set<string>()
  for (const r of def.resources) {
    if (resIds.has(r.id)) push(`duplicate resource id "${r.id}"`)
    resIds.add(r.id)
    if (!Number.isInteger(r.startAmount) || r.startAmount < 0) push(`resource "${r.id}" bad startAmount`)
  }
  const entIds = new Set<string>()
  for (const e of def.entities) {
    if (entIds.has(e.id)) push(`duplicate entity id "${e.id}"`)
    entIds.add(e.id)
    // The type says visual is required, but a def can arrive from a JSON file
    // or an editor form where nothing enforced that. Without a model the
    // renderer dereferences undefined rather than falling back, so this is the
    // difference between a message and a broken editor.
    if (!e.visual || typeof e.visual.model !== 'string' || e.visual.model === '') {
      push(`entity "${e.id}": needs a visual model`)
    }
  }
  const dmgTypes = new Set(def.damageTypes ?? [])
  const armTypes = new Set(def.armorTypes ?? [])
  for (const m of def.damageTable ?? []) {
    if (!dmgTypes.has(m.damage)) push(`damageTable: unknown damage type "${m.damage}"`)
    if (!armTypes.has(m.armor)) push(`damageTable: unknown armor type "${m.armor}"`)
    if (!Number.isInteger(m.pct) || m.pct < 0) push(`damageTable: bad pct for ${m.damage}/${m.armor}`)
  }
  const abIds = new Set<string>()
  for (const a of def.abilities) {
    if (abIds.has(a.id)) push(`duplicate ability id "${a.id}"`)
    abIds.add(a.id)
    if (a.range < 0 || a.periodTicks < 1) push(`ability "${a.id}" bad range/period`)
    if (a.area) {
      if (!(a.area.radius > 0)) push(`ability "${a.id}": area radius must be > 0`)
      if (a.area.shape === 'cone') {
        if (!(a.area.halfAngleCos >= -1 && a.area.halfAngleCos <= 1))
          push(`ability "${a.id}": cone halfAngleCos must be within [-1, 1]`)
        if (a.target !== 'point') push(`ability "${a.id}": a cone needs target 'point' to aim at`)
      }
      if (a.target === 'ally') push(`ability "${a.id}": area casts cannot use target 'ally'`)
    }
  }
  for (const e of def.entities) {
    const where = `entity "${e.id}"`
    if (!(e.radius > 0)) push(`${where}: radius must be > 0`)
    if (!Number.isInteger(e.hp) || e.hp < 0) push(`${where}: hp must be a non-negative integer`)
    for (const c of e.cost ?? []) {
      if (!resIds.has(c.resource)) push(`${where}: unknown cost resource "${c.resource}"`)
      if (!Number.isInteger(c.amount) || c.amount < 0) push(`${where}: bad cost amount`)
    }
    for (const r of e.requires ?? []) if (!entIds.has(r)) push(`${where}: unknown requires "${r}"`)
    for (const b of e.builder?.builds ?? []) if (!entIds.has(b)) push(`${where}: unknown builds "${b}"`)
    for (const t of e.trainer?.trains ?? []) if (!entIds.has(t)) push(`${where}: unknown trains "${t}"`)
    for (const d of e.dropoff?.accepts ?? []) if (!resIds.has(d)) push(`${where}: unknown dropoff resource "${d}"`)
    if (e.resourceNode && !resIds.has(e.resourceNode.resource))
      push(`${where}: unknown node resource "${e.resourceNode.resource}"`)
    if (e.extractorOn && !entIds.has(e.extractorOn)) push(`${where}: unknown extractorOn "${e.extractorOn}"`)
    for (const a of e.abilities ?? []) if (!abIds.has(a.ability)) push(`${where}: unknown ability "${a.ability}"`)
    if (e.harvester) {
      const h = e.harvester
      if (h.carryCapacity < 1 || h.gatherAmount < 1 || h.gatherPeriodTicks < 1)
        push(`${where}: harvester numbers must be >= 1`)
    }
    if (e.flying && e.kind === 'building') push(`${where}: buildings cannot fly`)
    if (e.flying && !e.mover) push(`${where}: a flyer needs a mover`)
    if (e.combat?.knockback !== undefined && e.combat.knockback < 0)
      push(`${where}: combat knockback must be >= 0`)
    if (e.combat?.splashRadius !== undefined && e.combat.splashRadius < 0)
      push(`${where}: combat splashRadius must be >= 0`)
    if (
      e.combat?.splashEdgePct !== undefined &&
      (e.combat.splashEdgePct < 0 || e.combat.splashEdgePct > 100)
    )
      push(`${where}: combat splashEdgePct must be within 0..100`)
    const chg = e.combat?.charge
    if (chg) {
      if (!(chg.minSpeed > 0)) push(`${where}: charge minSpeed must be > 0`)
      if (!(chg.damage > 0)) push(`${where}: charge damage must be > 0`)
      if (chg.knockback !== undefined && chg.knockback < 0) push(`${where}: charge knockback must be >= 0`)
      if (chg.cooldownTicks !== undefined && chg.cooldownTicks < 1)
        push(`${where}: charge cooldownTicks must be >= 1`)
      if (!e.mover) push(`${where}: a charge needs a mover — it is delivered by momentum`)
      if (!((e.crusherLevel ?? 0) > 0))
        push(`${where}: a charge needs crusherLevel > 0 or it can flatten nothing`)
    }
    const proj = e.combat?.projectile
    if (proj) {
      if (!(proj.speed > 0)) push(`${where}: projectile speed must be > 0`)
      if (proj.splashRadius !== undefined && proj.splashRadius < 0)
        push(`${where}: projectile splashRadius must be >= 0`)
      if (proj.edgePct !== undefined && (proj.edgePct < 0 || proj.edgePct > 100))
        push(`${where}: projectile edgePct must be within 0..100`)
      if (proj.scatterRadius !== undefined && proj.scatterRadius < 0)
        push(`${where}: projectile scatterRadius must be >= 0`)
    }
    if (e.chargeGuard !== undefined && e.chargeGuard < 0) push(`${where}: chargeGuard must be >= 0`)
    if (e.crusherLevel !== undefined && e.crusherLevel < 0) push(`${where}: crusherLevel must be >= 0`)
    if (e.crushableLevel !== undefined && e.crushableLevel < 0) push(`${where}: crushableLevel must be >= 0`)
    if (e.armorType && !armTypes.has(e.armorType)) push(`${where}: unknown armorType "${e.armorType}"`)
    for (const a of e.plot?.accepts ?? []) if (!entIds.has(a)) push(`${where}: plot accepts unknown "${a}"`)
    if (e.plot && e.kind !== 'building') push(`${where}: plots must be buildings`)
    for (const ring of expansionRings(e)) {
      if (!entIds.has(ring.plot)) push(`${where}: unknown expansion plot "${ring.plot}"`)
      else if (!def.entities.find((x) => x.id === ring.plot)?.plot)
        push(`${where}: expansion "${ring.plot}" is not a plot`)
    }
    if (e.placement === 'plot' && e.kind !== 'building') push(`${where}: only buildings use plot placement`)
    if (e.combat?.damageType && !dmgTypes.has(e.combat.damageType))
      push(`${where}: unknown damageType "${e.combat.damageType}"`)
    if (e.income) {
      const inc = e.income
      if (!resIds.has(inc.resource)) push(`${where}: unknown income resource "${inc.resource}"`)
      if (!Number.isInteger(inc.amount) || inc.amount < 1) push(`${where}: income amount must be >= 1`)
      if (!Number.isInteger(inc.perTicks) || inc.perTicks < 1) push(`${where}: income perTicks must be >= 1`)
      for (const p of [inc.crowdPenaltyPct, inc.crowdFloorPct]) {
        if (p !== undefined && (!Number.isInteger(p) || p < 0 || p > 100))
          push(`${where}: income percentages must be integers in 0..100`)
      }
    }
    if (e.horde) {
      const h = e.horde
      if (e.kind !== 'unit') push(`${where}: horde tickets must be kind "unit"`)
      const member = def.entities.find((x) => x.id === h.unit)
      if (!member) push(`${where}: unknown horde unit "${h.unit}"`)
      else if (member.kind !== 'unit' || !member.mover) push(`${where}: horde unit "${h.unit}" must be a mobile unit`)
      else if (member.horde) push(`${where}: horde unit "${h.unit}" cannot itself be a horde ticket`)
      if (!Number.isInteger(h.count) || h.count < 1) push(`${where}: horde count must be >= 1`)
      if (!(h.spacing > 0)) push(`${where}: horde spacing must be > 0`)
      const fIds = new Set<string>()
      for (const f of h.formations ?? []) {
        if (fIds.has(f.id)) push(`${where}: duplicate formation "${f.id}"`)
        fIds.add(f.id)
        if (!['block', 'line', 'wedge', 'ring'].includes(f.kind)) push(`${where}: bad formation kind "${f.kind}"`)
      }
    }
    // a horde ticket is never spawned, so it needs no mover of its own
    if (e.kind === 'unit' && !e.mover && !e.horde) push(`${where}: units need a mover block`)
  }
  if (!['annihilation', 'buildingsDestroyed', 'triggersOnly'].includes(def.victory.mode))
    push(`bad victory mode`)
  const upIds = new Set<string>()
  for (const u of def.upgrades ?? []) {
    const where = `upgrade "${u.id}"`
    if (upIds.has(u.id)) push(`duplicate upgrade id "${u.id}"`)
    upIds.add(u.id)
    if (u.appliesTo.length === 0) push(`${where}: improves nothing`)
    for (const a of u.appliesTo) if (!entIds.has(a)) push(`${where}: applies to unknown "${a}"`)
    if (u.soldBy.length === 0) push(`${where}: is not sold anywhere`)
    for (const b of u.soldBy) {
      const seller = def.entities.find((x) => x.id === b)
      if (!seller) push(`${where}: sold by unknown "${b}"`)
      else if (seller.kind !== 'building') push(`${where}: "${b}" is not a building`)
    }
    for (const r of u.requires ?? []) if (!entIds.has(r)) push(`${where}: requires unknown "${r}"`)
    for (const c of u.cost) if (!resIds.has(c.resource)) push(`${where}: unknown resource "${c.resource}"`)
    // An upgrade that changes nothing is almost always a typo in the field name
    if (
      u.damagePct === undefined && u.armorPct === undefined &&
      u.rangePct === undefined && u.speedPct === undefined
    ) {
      push(`${where}: has no effect`)
    }
  }
  return errs
}
