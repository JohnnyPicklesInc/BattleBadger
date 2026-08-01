import type { AbilityDef, EntityDef, GameDef, UpgradeDef, VictoryDef } from './defs/schema.ts'
import { expansionRings, validateGameDef } from './defs/schema.ts'
import { validateBlueprints, type GenBlueprint } from './blueprint.ts'
import type { AssetRef } from './mapdoc.ts'

// Rulesets: rules you can save once and drop into any map.
//
// A map carries its own rules, which is what makes balance per-map — but it
// also meant every map was an island. Fixing a unit meant editing it in each
// map that used it, and moving a unit to another map left its model behind.
//
// The unit of exchange is deliberately NOT "a GameDef". A GameDef is a whole
// game; you cannot combine two of them. What composes is a MODULE: a bundle of
// entities, the abilities they cast and the models they wear, layered onto a
// base. Factions are modules that name a keep. So are neutral scenery, a siege
// pack, or one imported unit.
//
// Two hard rules hold the whole thing together:
//
//   1. A module travels with its models. An entity whose visual says
//      'gen:orc-warrior' is useless without that blueprint, so extraction
//      collects them and import copies them in. This is the difference between
//      sharing rules and sharing a game.
//
//   2. Import COPIES into the map. Nothing here is a live reference or a URL.
//      A map that pointed at a ruleset by name would have exactly the problem
//      map content hashes were introduced to kill: two players agreeing on the
//      name and disagreeing about the bytes. Modules are an authoring-time
//      convenience; the shipped map is self-contained, and the version stamps
//      below exist only so an editor can OFFER to re-import.

/**
 * The physics half of a ruleset: what damage means, what armor means, what you
 * spend. Entities are meaningless without it — a unit dealing 'kinetic' damage
 * against a base with no kinetic row silently does full damage to everything,
 * which is a balance change nobody authored. Hence `checkModuleFits`.
 */
export type RulesetBase = Omit<GameDef, 'id' | 'name' | 'entities' | 'victory'>

/** A bundle of content that layers onto a base. The thing you save and share. */
export interface RulesetModule {
  id: string
  name: string
  /** Bumped by the author. Only used to offer a re-import; never read at match time. */
  version?: number
  /** A faction names the fortress it seats. Content packs leave it out. */
  keep?: string
  /**
   * What this faction musters with, in order. Read when a player picks it in
   * the lobby: the map's authored start positions are kept and the defs sitting
   * on them are swapped for these, so seating a faction never needs the map to
   * have anticipated it. Absent = its battalions in declaration order.
   */
  startArmy?: string[]
  entities: EntityDef[]
  /**
   * Abilities its units reference. They travel WITH the module — leaving them
   * behind produced a captain whose abilities were not there.
   */
  abilities?: AbilityDef[]
  /** Research its buildings sell. Travels with the module for the same reason
   * abilities do: an upgrade left behind is a building offering nothing. */
  upgrades?: UpgradeDef[]
  /** Procedural models its entities wear, by 'gen:<id>'. */
  blueprints?: GenBlueprint[]
  /** Uploaded .glb models its entities wear, by 'asset:<id>'. */
  assets?: AssetRef[]
}

/**
 * The shareable file. One format with optional parts, so "the whole MOBA
 * ruleset" and "just the Horde" are the same kind of thing:
 *   - `base` present  → a complete ruleset; can seed an empty map
 *   - `base` absent   → content that layers onto whatever the map already has
 */
export interface RulesetPack {
  kind: 'bb-ruleset'
  schema: 1
  id: string
  name: string
  version?: number
  base?: RulesetBase
  modules: RulesetModule[]
}

/**
 * Per-entity overrides, keyed by entity id. Shallow-merged over the module's
 * own numbers, so a map says what it changes and nothing else.
 *
 * Nested blocks merge one level deep, which is what you want for
 * `{ combat: { damage: 12 } }` — the rest of the weapon survives.
 */
export type Tuning = Record<string, Record<string, unknown>>

const MERGE_DEEP = new Set(['combat', 'horde', 'income', 'visual', 'mover', 'plot', 'trainer'])

export interface ComposeRulesetOptions {
  id: string
  name: string
  base: RulesetBase
  modules: RulesetModule[]
  victory: VictoryDef
  /** Per-map balance changes, keyed by entity id. */
  tune?: Tuning
  /** Resource each player opens with; absent = the base's own. */
  startAmount?: number
}

export interface ComposedRuleset {
  gameDef: GameDef
  blueprints: GenBlueprint[]
  assets: AssetRef[]
}

function applyTuning(e: EntityDef, patch: Record<string, unknown>): EntityDef {
  const out = { ...e } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (MERGE_DEEP.has(k) && typeof v === 'object' && v !== null && typeof out[k] === 'object') {
      out[k] = { ...(out[k] as object), ...(v as object) }
    } else {
      out[k] = v
    }
  }
  return out as unknown as EntityDef
}

/** Flatten a base plus its modules into the GameDef and models a map inlines. */
export function composeRuleset(opts: ComposeRulesetOptions): ComposedRuleset {
  const seen = new Map<string, EntityDef>()
  for (const m of opts.modules) {
    for (const e of m.entities) {
      const prev = seen.get(e.id)
      // Two modules bringing the SAME entity is normal — every faction pack
      // ships the neutral structures its plots accept. Two modules bringing
      // DIFFERENT entities under one id is not: one would silently shadow the
      // other and the loser's stats would vanish with no error anywhere.
      if (prev !== undefined) {
        if (canonical(prev) !== canonical(e)) {
          throw new Error(`composeRuleset("${opts.id}"): "${m.id}" redefines entity "${e.id}"`)
        }
        continue
      }
      seen.set(e.id, e)
    }
  }

  const tune = opts.tune ?? {}
  for (const id of Object.keys(tune)) {
    // A typo'd id would otherwise be a balance change that silently did nothing
    if (!seen.has(id)) throw new Error(`composeRuleset("${opts.id}"): tuning unknown entity "${id}"`)
    seen.set(id, applyTuning(seen.get(id)!, tune[id]))
  }

  const resources =
    opts.startAmount === undefined
      ? opts.base.resources
      : opts.base.resources.map((r) => ({ ...r, startAmount: opts.startAmount! }))

  const gameDef: GameDef = {
    ...opts.base,
    abilities: opts.modules.flatMap((m) => m.abilities ?? []),
    upgrades: opts.modules.flatMap((m) => m.upgrades ?? []),
    resources,
    id: opts.id,
    name: opts.name,
    entities: [...seen.values()],
    victory: opts.victory,
  }
  return {
    gameDef,
    blueprints: dedupeById(opts.modules.flatMap((m) => m.blueprints ?? [])),
    assets: dedupeById(opts.modules.flatMap((m) => m.assets ?? [])),
  }
}

// Key-order-independent comparison, so a def that has been through a JSON file
// still matches the one held in memory.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as object)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  )
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const by = new Map<string, T>()
  for (const it of items) if (!by.has(it.id)) by.set(it.id, it)
  return [...by.values()]
}

// ---- what a module needs, and whether it has it ------------------------

export interface ModuleRequirements {
  damageTypes: string[]
  armorTypes: string[]
  resources: string[]
  /** Entity ids referenced but not defined by this module. */
  entities: string[]
  /** Ability ids referenced but not carried by this module. */
  abilities: string[]
  /** 'gen:<id>' models it wears that it does not carry a blueprint for. */
  models: string[]
  /** Resource-node tags its harvesters look for but it defines no node with. */
  nodeTags: string[]
}

function entityRefs(e: EntityDef): string[] {
  return [
    ...(e.requires ?? []),
    ...(e.builder?.builds ?? []),
    ...(e.trainer?.trains ?? []),
    ...(e.dropoff?.accepts ?? []),
    ...(e.plot?.accepts ?? []),
    ...expansionRings(e).map((r) => r.plot),
    ...(e.horde ? [e.horde.unit] : []),
    ...(e.extractorOn ? [e.extractorOn] : []),
  ]
}

/**
 * Everything a module names but does not define, derived from its entities
 * rather than declared by hand — a hand-written list drifts the first time
 * somebody edits a unit, and drifts silently.
 */
export function moduleRequirements(m: RulesetModule): ModuleRequirements {
  const own = new Set(m.entities.map((e) => e.id))
  const ownAbilities = new Set((m.abilities ?? []).map((a) => a.id))
  const ownModels = new Set((m.blueprints ?? []).map((b) => b.id))
  const ownAssets = new Set((m.assets ?? []).map((a) => a.id))
  const ownTags = new Set(m.entities.flatMap((e) => (e.resourceNode ? [e.resourceNode.tag] : [])))

  const damageTypes = new Set<string>()
  const armorTypes = new Set<string>()
  const resources = new Set<string>()
  const entities = new Set<string>()
  const abilities = new Set<string>()
  const models = new Set<string>()
  const nodeTags = new Set<string>()

  for (const e of m.entities) {
    if (e.combat?.damageType) damageTypes.add(e.combat.damageType)
    if (e.armorType) armorTypes.add(e.armorType)
    for (const c of e.cost ?? []) resources.add(c.resource)
    if (e.income) resources.add(e.income.resource)
    if (e.resourceNode) resources.add(e.resourceNode.resource)
    for (const tag of e.harvester?.nodeTags ?? []) if (!ownTags.has(tag)) nodeTags.add(tag)
    for (const ref of entityRefs(e)) if (!own.has(ref)) entities.add(ref)
    for (const a of e.abilities ?? []) if (!ownAbilities.has(a.ability)) abilities.add(a.ability)
    const model = e.visual?.model ?? ''
    if (model.startsWith('gen:') && !ownModels.has(model.slice(4))) models.add(model)
    if (model.startsWith('asset:') && !ownAssets.has(model.slice(6))) models.add(model)
  }
  return {
    damageTypes: [...damageTypes],
    armorTypes: [...armorTypes],
    resources: [...resources],
    entities: [...entities],
    abilities: [...abilities],
    models: [...models],
    nodeTags: [...nodeTags],
  }
}

/**
 * Whether a module can be dropped onto a base at all. Returns problems in the
 * order an author should fix them; empty means it fits.
 *
 * The damage/armor checks are the important ones. A missing type is not a
 * crash — the matrix simply has no row, so the multiplier defaults to 100% and
 * the unit quietly ignores every counter it was designed around.
 */
export function checkModuleFits(m: RulesetModule, base: RulesetBase): string[] {
  const req = moduleRequirements(m)
  const errs: string[] = []
  const has = (list: string[] | undefined, v: string): boolean => (list ?? []).includes(v)
  for (const d of req.damageTypes) {
    if (!has(base.damageTypes, d)) errs.push(`damage type "${d}" is not in this map's rules`)
  }
  for (const a of req.armorTypes) {
    if (!has(base.armorTypes, a)) errs.push(`armor type "${a}" is not in this map's rules`)
  }
  for (const r of req.resources) {
    if (!base.resources.some((x) => x.id === r)) errs.push(`resource "${r}" is not in this map's rules`)
  }
  return errs
}

// ---- extraction: turn part of a map's rules back into a module ---------

export interface ExtractOptions {
  id: string
  name: string
  version?: number
  keep?: string
  /** The def to pull from. */
  gameDef: GameDef
  /** Entity ids to take. Anything they reference comes along. */
  entityIds: string[]
  /** Models available to draw from — usually the map's own blueprints. */
  blueprints?: GenBlueprint[]
  assets?: AssetRef[]
}

/**
 * Pull entities out of a map's rules as a saveable module, following their
 * references so the result actually stands up on its own: a horde ticket
 * brings its soldier, a barracks brings what it trains, and everything brings
 * its abilities and its models.
 *
 * The closure is the whole point. Saving "the archers" and getting a ticket
 * that spawns a unit id which no longer exists is worse than not saving at
 * all, because it fails at match time rather than at save time.
 */
export function extractModule(opts: ExtractOptions): RulesetModule {
  const byId = new Map(opts.gameDef.entities.map((e) => [e.id, e]))
  const missing = opts.entityIds.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new Error(`extractModule: unknown entity ${missing.map((m) => `"${m}"`).join(', ')}`)

  const taken = new Map<string, EntityDef>()
  const queue = [...opts.entityIds]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (taken.has(id)) continue
    const e = byId.get(id)
    if (!e) continue // a dangling reference in the source def is its problem, not ours
    taken.set(id, e)
    for (const ref of entityRefs(e)) if (!taken.has(ref)) queue.push(ref)
  }

  // Keep the def's own ordering rather than discovery order, so extracting the
  // same units twice produces the same module.
  const entities = opts.gameDef.entities.filter((e) => taken.has(e.id))
  const wantedAbilities = new Set(entities.flatMap((e) => (e.abilities ?? []).map((a) => a.ability)))
  const abilities = opts.gameDef.abilities.filter((a) => wantedAbilities.has(a.id))

  const taken2 = new Set(entities.map((e) => e.id))
  const upgrades = (opts.gameDef.upgrades ?? []).filter(
    (u) => u.appliesTo.some((a) => taken2.has(a)) && u.soldBy.some((b) => taken2.has(b)),
  )
  const models = new Set(entities.map((e) => e.visual?.model ?? ''))
  const blueprints = (opts.blueprints ?? []).filter((b) => models.has(`gen:${b.id}`))
  const assets = (opts.assets ?? []).filter((a) => models.has(`asset:${a.id}`))

  const mod: RulesetModule = { id: opts.id, name: opts.name, entities }
  if (opts.version !== undefined) mod.version = opts.version
  if (opts.keep !== undefined) mod.keep = opts.keep
  if (abilities.length > 0) mod.abilities = abilities
  if (upgrades.length > 0) mod.upgrades = upgrades
  if (blueprints.length > 0) mod.blueprints = blueprints
  if (assets.length > 0) mod.assets = assets
  return mod
}

/**
 * Add a module's content to an existing def. Returns a new def — the caller
 * decides whether to keep it, so a rejected import leaves the map untouched.
 *
 * Shared content is idempotent. Two faction packs both carrying the neutral
 * farm is normal and must not be an error; two DIFFERENT units under one id
 * is the thing worth stopping, because one would silently shadow the other.
 */
export function installModule(def: GameDef, m: RulesetModule): GameDef {
  const existing = new Map(def.entities.map((e) => [e.id, e]))
  const add: EntityDef[] = []
  const clash: string[] = []
  for (const e of m.entities) {
    const prev = existing.get(e.id)
    if (prev === undefined) add.push(e)
    else if (canonical(prev) !== canonical(e)) clash.push(e.id)
  }
  if (clash.length > 0) {
    throw new Error(`"${m.name}" redefines entities this map already has: ${clash.join(', ')}`)
  }
  const haveAbility = new Set(def.abilities.map((a) => a.id))
  // Upgrades merge by id alongside abilities: a faction whose research was
  // left behind is a barracks offering nothing, which is the same failure the
  // abilities merge exists to prevent.
  const haveUpgrade = new Set((def.upgrades ?? []).map((u) => u.id))
  const upgrades = [...(def.upgrades ?? []), ...(m.upgrades ?? []).filter((u) => !haveUpgrade.has(u.id))]
  return {
    ...def,
    entities: [...def.entities, ...add],
    // Abilities merge by id for the same reason.
    abilities: [...def.abilities, ...(m.abilities ?? []).filter((a) => !haveAbility.has(a.id))],
    ...(upgrades.length > 0 ? { upgrades } : {}),
  }
}

// ---- validation --------------------------------------------------------

const MAX_MODULES = 64

function checkModule(m: unknown, where: string): RulesetModule {
  if (typeof m !== 'object' || m === null) throw new Error(`${where}: module must be an object`)
  const mod = m as Record<string, unknown>
  if (typeof mod.id !== 'string' || mod.id.length === 0) throw new Error(`${where}: module needs a string "id"`)
  const at = `module "${mod.id}"`
  if (typeof mod.name !== 'string' || mod.name.length === 0) throw new Error(`${at}: needs a string "name"`)
  if (!Array.isArray(mod.entities) || mod.entities.length === 0) {
    throw new Error(`${at}: "entities" must be a non-empty array`)
  }
  const ids = new Set<string>()
  for (const e of mod.entities as EntityDef[]) {
    if (typeof e?.id !== 'string' || e.id.length === 0) throw new Error(`${at}: every entity needs a string "id"`)
    if (ids.has(e.id)) throw new Error(`${at}: duplicate entity id "${e.id}"`)
    ids.add(e.id)
  }
  if (mod.abilities !== undefined && !Array.isArray(mod.abilities)) throw new Error(`${at}: "abilities" must be an array`)
  if (mod.keep !== undefined && !ids.has(mod.keep as string)) {
    throw new Error(`${at}: keep "${String(mod.keep)}" is not one of its entities`)
  }
  if (mod.startArmy !== undefined) {
    if (!Array.isArray(mod.startArmy)) throw new Error(`${at}: "startArmy" must be an array`)
    for (const u of mod.startArmy as string[]) {
      // A typo here is a faction that seats a short army with no error anywhere.
      if (!ids.has(u)) throw new Error(`${at}: startArmy "${u}" is not one of its entities`)
    }
  }
  validateBlueprints(mod.blueprints)
  return mod as unknown as RulesetModule
}

/**
 * Check a shareable ruleset file, throwing on the first problem. Packs come
 * from whoever made them, so this is the door: past it, the editor can treat a
 * pack as structurally sound and only has to reason about whether it FITS.
 */
export function validateRulesetPack(input: unknown): RulesetPack {
  if (typeof input !== 'object' || input === null) throw new Error('not a ruleset file')
  const pack = input as Record<string, unknown>
  if (pack.kind !== 'bb-ruleset') throw new Error('not a ruleset file (missing kind: "bb-ruleset")')
  if (pack.schema !== 1) throw new Error(`unsupported ruleset schema ${String(pack.schema)}`)
  if (typeof pack.id !== 'string' || pack.id.length === 0) throw new Error('ruleset needs a string "id"')
  if (typeof pack.name !== 'string' || pack.name.length === 0) throw new Error('ruleset needs a string "name"')
  if (!Array.isArray(pack.modules) || pack.modules.length === 0) throw new Error('ruleset has no modules')
  if (pack.modules.length > MAX_MODULES) throw new Error(`too many modules (${pack.modules.length} > ${MAX_MODULES})`)

  const seen = new Set<string>()
  const modules = pack.modules.map((m, i) => {
    const mod = checkModule(m, `module ${i}`)
    if (seen.has(mod.id)) throw new Error(`duplicate module id "${mod.id}"`)
    seen.add(mod.id)
    return mod
  })

  if (pack.base !== undefined) {
    const base = pack.base as RulesetBase
    if (typeof base !== 'object' || base === null) throw new Error('"base" must be an object')
    if (!Array.isArray(base.resources) || base.resources.length === 0) throw new Error('"base" needs resources')
    // The cheapest way to be sure a base is sound is to build a def out of it
    // and run the checker the sim already trusts.
    const errs = validateGameDef(
      composeRuleset({
        id: pack.id,
        name: pack.name,
        base,
        modules,
        victory: { mode: 'annihilation' },
      }).gameDef,
    )
    if (errs.length > 0) throw new Error(`ruleset "${pack.id}" is not a valid game: ${errs.join('; ')}`)
  }
  return { ...(pack as unknown as RulesetPack), modules }
}

/**
 * The physics out of a finished def, with the content left behind. A pack's
 * base should not also carry a copy of every entity — the modules are where
 * those live, and a second copy is a second thing that can disagree.
 */
export function baseOf(def: GameDef): RulesetBase {
  const { id: _id, name: _name, entities: _entities, victory: _victory, ...base } = def
  return { ...base, abilities: [] }
}

/** Wrap modules as a shareable file. */
export function toPack(
  opts: { id: string; name: string; version?: number; base?: RulesetBase },
  modules: RulesetModule[],
): RulesetPack {
  const pack: RulesetPack = { kind: 'bb-ruleset', schema: 1, id: opts.id, name: opts.name, modules }
  if (opts.version !== undefined) pack.version = opts.version
  if (opts.base !== undefined) pack.base = opts.base
  return pack
}
