import { expansionRings, validateGameDef, type EntityDef, type GameDef } from './defs/schema.ts'
import { mapSlotCount, type PlacedEntity, type RtsMapDoc } from './mapdoc.ts'
import { baseOf, checkModuleFits, installModule, type RulesetModule } from './ruleset.ts'

// Seating: who plays which race, and on whose team.
//
// There is still no engine concept of a "faction" — a player's race IS the keep
// they start with and the battalions standing next to it (see fourCorners).
// So a lobby race pick is a MAP TRANSFORM, applied before the match: the
// authored start positions are kept exactly as the map laid them out, and the
// entity defs sitting on them are swapped for the chosen faction's. A map
// therefore does not have to anticipate the factions played on it.
//
// This runs on the HOST only. The result is the doc that is shipped to guests
// through the normal map transfer, so every client plays the host's bytes —
// the same rule that keeps generated maps honest. Two players whose local copy
// of "the Horde" differs cannot desync over it, because only one of the two
// copies is ever used.

/** One slot's lobby choices. Every part is optional — absent = the map's own. */
export interface SlotSeat {
  /** The faction module to seat. Absent/null keeps whatever the map placed. */
  faction?: RulesetModule | null
  /** Team id. Absent keeps the map's own slotTeams (or free-for-all). */
  team?: number
  /** Which authored start position to play. Absent = the slot's own (start N
   * for slot N), which is how every map reads until somebody moves. */
  start?: number
  /** Computer difficulty for this slot: 0 = none, 1..3 = easy/normal/hard.
   * Absent keeps the level the MAP asked for — a scenario built around a
   * scripted attacker is not playable without it. */
  ai?: number
  /** False when nobody — human or computer — is playing this slot. Its
   * authored keep and army are dropped, so an empty seat leaves empty ground
   * instead of a base standing there with nobody home. Absent = active. */
  active?: boolean
}

export interface SeatResult {
  doc: RtsMapDoc
  /** What was changed, and what was refused. Shown in the lobby status line. */
  notes: string[]
}

/** A keep is a building that spawns its own expansion plots — that is what
 * gates which structures its owner can raise, and so what a race IS here. */
export function isKeep(e: EntityDef | undefined): boolean {
  return e !== undefined && e.kind === 'building' && expansionRings(e).length > 0
}

/**
 * What a faction musters with. Declared order matters: it is matched against
 * the map's authored start positions in order, so the first entry lands where
 * the map put the slot's first unit.
 */
export function factionStartArmy(m: RulesetModule): string[] {
  if (m.startArmy && m.startArmy.length > 0) return m.startArmy
  // A faction that never said: its own battalions, in declaration order. Better
  // than leaving the previous owner's units standing under a new banner.
  return m.entities.filter((e) => e.horde).map((e) => e.id)
}

/**
 * Why this faction cannot be seated on this map, or [] if it can. The lobby
 * greys out a race with this rather than letting a player pick something that
 * would silently be ignored at start.
 */
export function seatingProblems(doc: RtsMapDoc, m: RulesetModule): string[] {
  if (!doc.gameDef) return ['this map uses the built-in skirmish rules, which seat no factions']
  if (!m.keep) return [`"${m.name}" is a content pack, not a faction — it seats no keep`]
  // A map with a roster has decided which game it is. Rules-fit is not the
  // question there: an army can slot into the damage matrix perfectly and
  // still belong to a different war.
  if (doc.races && !doc.races.includes(m.id)) return [`"${m.name}" is not one of this map's races`]
  return checkModuleFits(m, baseOf(doc.gameDef))
}

/** The faction a slot starts as, by the keep the map placed for it. */
export function slotKeep(doc: RtsMapDoc, slot: number): string | null {
  const def = doc.gameDef
  if (!def) return null
  const byId = new Map(def.entities.map((e) => [e.id, e]))
  for (const p of doc.placed ?? []) {
    if (p.owner === slot && isKeep(byId.get(p.def))) return p.def
  }
  return null
}

/** Name of the faction a slot plays by default, for the "Map default" label. */
export function defaultFactionName(doc: RtsMapDoc, slot: number, modules: RulesetModule[]): string | null {
  const keep = slotKeep(doc, slot)
  if (!keep) return null
  return modules.find((m) => m.keep === keep)?.name ?? null
}

/**
 * Settle the lobby's start-position picks into a permutation: order[slot] is
 * the authored start position that slot plays. Picks are honoured in slot
 * order; a repeat, an out-of-range one or a slot that never asked keeps its
 * own position when it is still free, and otherwise takes the lowest free one.
 * The result is always a permutation, so no two slots can share a base.
 */
export function resolveStartOrder(seats: { start?: number }[], slots: number): number[] {
  const order = Array.from({ length: slots }, () => -1)
  const taken = new Set<number>()
  for (let slot = 0; slot < slots; slot++) {
    const want = seats[slot]?.start
    if (want === undefined || !Number.isInteger(want) || want < 0 || want >= slots) continue
    if (taken.has(want)) continue
    order[slot] = want
    taken.add(want)
  }
  for (let slot = 0; slot < slots; slot++) {
    if (order[slot] !== -1 || taken.has(slot)) continue
    order[slot] = slot
    taken.add(slot)
  }
  let free = 0
  for (let slot = 0; slot < slots; slot++) {
    if (order[slot] !== -1) continue
    while (taken.has(free)) free++
    order[slot] = free
    taken.add(free)
  }
  return order
}

// Slot numbers appear all over a map: on placed entities, and inside triggers
// as `owner`/`player`/`to`. Moving players between bases relabels ALL of them —
// a scripted map whose triggers name slot 2 must keep naming whoever is now
// standing on slot 2's ground.
function remapSlotFields<T>(obj: T, owner: (o: number) => number): T {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
  for (const key of ['owner', 'player', 'to']) {
    const v = out[key]
    if (typeof v === 'number') out[key] = owner(v)
  }
  return out as T
}

/**
 * Move each slot onto the start position it picked. The map is rewritten, not
 * the sim: after this, slot N owns start position N again — which is what the
 * whole engine (bases, camera, fog, minimap) already assumes.
 */
function applyStartOrder(doc: RtsMapDoc, order: number[]): RtsMapDoc {
  const slots = order.length
  // Per-position arrays follow their position. They can be short — a map may
  // list teams for two slots and stop — so a missing entry falls back to what
  // that position meant before the move, never to a hole.
  const bySlot = <T>(arr: T[] | undefined, dflt: (pos: number) => T): T[] | undefined =>
    arr === undefined ? undefined : [...order.map((pos) => arr[pos] ?? dflt(pos)), ...arr.slice(slots)]
  // order maps slot → position; the doc's content is authored per position, so
  // relabelling it needs the inverse.
  const playerAt: number[] = []
  order.forEach((pos, slot) => {
    playerAt[pos] = slot
  })
  const owner = (o: number): number => (Number.isInteger(o) && o >= 0 && o < slots ? playerAt[o] : o)

  const out: RtsMapDoc = { ...doc, startLocations: bySlot(doc.startLocations, (pos) => doc.startLocations[pos])! }
  if (doc.slotTeams) out.slotTeams = bySlot(doc.slotTeams, (pos) => pos)
  if (doc.aiLevels) out.aiLevels = bySlot(doc.aiLevels, () => 0)
  if (doc.placed) out.placed = doc.placed.map((p) => ({ ...p, owner: owner(p.owner) }))
  if (doc.triggers) {
    out.triggers = doc.triggers.map((t) => ({
      ...t,
      events: t.events.map((e) => remapSlotFields(e, owner)),
      conditions: t.conditions.map((c) => remapSlotFields(c, owner)),
      actions: t.actions.map((a) => remapSlotFields(a, owner)),
    }))
  }
  return out
}

// Swap one slot's start kit to a faction, keeping every authored position.
function reseat(placed: PlacedEntity[], def: GameDef, slot: number, m: RulesetModule): PlacedEntity[] {
  const byId = new Map(def.entities.map((e) => [e.id, e]))
  const army = factionStartArmy(m)
  let next = 0
  return placed.map((p) => {
    if (p.owner !== slot) return p
    const e = byId.get(p.def)
    if (isKeep(e)) return { ...p, def: m.keep! }
    // Units cycle through the faction's muster; a map that seats six units for
    // a faction that names three gets that faction's three, twice.
    if (e?.kind === 'unit' && army.length > 0) return { ...p, def: army[next++ % army.length] }
    // Everything else — settlements, plots, pre-built neutral structures —
    // belongs to the map rather than to a race, and is left alone.
    return p
  })
}

/**
 * Apply the lobby's seating to a map. Returns a NEW doc; the input is never
 * touched, so a refused pick cannot leave a half-seated map behind.
 */
export function seatPlayers(doc: RtsMapDoc, seats: SlotSeat[]): SeatResult {
  const notes: string[] = []
  const slots = mapSlotCount(doc)
  // Start positions move first: everything below — races, teams, the doc that
  // ships — is expressed per SLOT, and after the move slot N is the player on
  // start N again.
  const order = resolveStartOrder(seats, slots)
  const moved = order.some((pos, slot) => pos !== slot)
  const base = moved ? applyStartOrder(doc, order) : doc
  for (let slot = 0; slot < slots; slot++) {
    if (order[slot] !== slot) notes.push(`slot ${slot + 1} starts at position ${order[slot] + 1}`)
  }

  let def = base.gameDef
  let placed = [...(base.placed ?? [])]
  const blueprints = [...(base.blueprints ?? [])]
  const assets = [...(base.assets ?? [])]
  let changed = moved

  if (seats.some((s) => s?.team !== undefined)) {
    changed = true
  }
  const slotTeams = seats.some((s) => s?.team !== undefined)
    ? Array.from({ length: slots }, (_, i) => seats[i]?.team ?? base.slotTeams?.[i] ?? i)
    : base.slotTeams

  // Computer opponents. The lobby's pick wins over the map's, and the result
  // travels ON THE DOC: aiLevel is hashed sim state, so the surest way for
  // every client to agree about it is to ship the same bytes.
  const aiLevels = seats.some((s) => s?.ai !== undefined)
    ? Array.from({ length: slots }, (_, i) => Math.max(0, Math.min(3, (seats[i]?.ai ?? base.aiLevels?.[i] ?? 0) | 0)))
    : base.aiLevels
  if (aiLevels !== undefined && aiLevels !== base.aiLevels) {
    changed = true
    aiLevels.forEach((lvl, i) => {
      if (lvl > 0 && (base.aiLevels?.[i] ?? 0) !== lvl) notes.push(`slot ${i + 1} is a computer (level ${lvl})`)
    })
  }

  // An unplayed seat leaves empty ground. Without this the map's authored keep
  // and battalions stand on it with nobody home — free kills, and a "team" the
  // victory check would have to reason about.
  if (seats.some((s) => s?.active === false)) {
    const empty = (slot: number): boolean => slot < slots && seats[slot]?.active === false
    const kept = placed.filter((p) => p.always === true || !empty(p.owner))
    if (kept.length !== placed.length) {
      placed = kept
      changed = true
      for (let slot = 0; slot < slots; slot++) if (empty(slot)) notes.push(`slot ${slot + 1} is empty`)
    }
  }

  for (let slot = 0; slot < slots; slot++) {
    const m = seats[slot]?.faction
    if (!m) continue
    const problems = seatingProblems(base, m)
    if (problems.length > 0) {
      notes.push(`slot ${slot + 1}: ${problems[0]} — kept the map's own army`)
      continue
    }
    // Already the map's own faction: nothing to swap, and installing it again
    // is a no-op. Skipping keeps a scripted start exactly as authored.
    if (slotKeep(base, slot) === m.keep) continue
    let installed: GameDef
    try {
      installed = installModule(def!, m)
    } catch (err) {
      notes.push(`slot ${slot + 1}: could not seat "${m.name}" — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    def = installed
    placed = reseat(placed, def, slot, m)
    for (const bp of m.blueprints ?? []) if (!blueprints.some((b) => b.id === bp.id)) blueprints.push(bp)
    for (const a of m.assets ?? []) if (!assets.some((x) => x.id === a.id)) assets.push(a)
    changed = true
    notes.push(`slot ${slot + 1} plays ${m.name}`)
  }

  if (!changed) return { doc, notes }

  const out: RtsMapDoc = { ...base, placed }
  if (slotTeams) out.slotTeams = slotTeams
  if (aiLevels) out.aiLevels = aiLevels
  if (def) out.gameDef = def
  if (blueprints.length > 0) out.blueprints = blueprints
  if (assets.length > 0) out.assets = assets

  // A seated map that does not compile must never reach a match: the sim would
  // throw at tick 0 on every client at once. Fall back to the untouched map and
  // say so, which is a fair game of the wrong race rather than no game at all.
  if (out.gameDef) {
    const errs = validateGameDef(out.gameDef)
    if (errs.length > 0) {
      // Drop the race swap, but keep the start positions: moving players
      // between authored bases cannot invalidate rules, and the lobby showed
      // everyone where they would be standing.
      return { doc: base, notes: [...notes, `seating produced invalid rules (${errs[0]}) — played the map as authored`] }
    }
  }
  return { doc: out, notes }
}
