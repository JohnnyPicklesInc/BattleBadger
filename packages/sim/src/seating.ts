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

/** One slot's lobby choices. Both parts are optional — absent = the map's own. */
export interface SlotSeat {
  /** The faction module to seat. Absent/null keeps whatever the map placed. */
  faction?: RulesetModule | null
  /** Team id. Absent keeps the map's own slotTeams (or free-for-all). */
  team?: number
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
  let def = doc.gameDef
  let placed = [...(doc.placed ?? [])]
  const blueprints = [...(doc.blueprints ?? [])]
  const assets = [...(doc.assets ?? [])]
  let changed = false

  if (seats.some((s) => s?.team !== undefined)) {
    changed = true
  }
  const slotTeams = seats.some((s) => s?.team !== undefined)
    ? Array.from({ length: slots }, (_, i) => seats[i]?.team ?? doc.slotTeams?.[i] ?? i)
    : doc.slotTeams

  for (let slot = 0; slot < slots; slot++) {
    const m = seats[slot]?.faction
    if (!m) continue
    const problems = seatingProblems(doc, m)
    if (problems.length > 0) {
      notes.push(`slot ${slot + 1}: ${problems[0]} — kept the map's own army`)
      continue
    }
    // Already the map's own faction: nothing to swap, and installing it again
    // is a no-op. Skipping keeps a scripted start exactly as authored.
    if (slotKeep(doc, slot) === m.keep) continue
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

  const out: RtsMapDoc = { ...doc, placed }
  if (slotTeams) out.slotTeams = slotTeams
  if (def) out.gameDef = def
  if (blueprints.length > 0) out.blueprints = blueprints
  if (assets.length > 0) out.assets = assets

  // A seated map that does not compile must never reach a match: the sim would
  // throw at tick 0 on every client at once. Fall back to the untouched map and
  // say so, which is a fair game of the wrong race rather than no game at all.
  if (out.gameDef) {
    const errs = validateGameDef(out.gameDef)
    if (errs.length > 0) {
      return { doc, notes: [...notes, `seating produced invalid rules (${errs[0]}) — played the map as authored`] }
    }
  }
  return { doc: out, notes }
}
