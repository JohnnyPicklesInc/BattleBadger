import type { EntityDef, GameDef, VictoryDef } from '../../defs/schema.ts'
import { BASE_RULES, NEUTRAL_ENTITIES, type Faction } from './shared.ts'

// Build a GameDef from the factions a map actually seats.
//
// A map carries its own rules, so this is where "balance is per-map" lives: a
// map includes only the factions it uses, and may patch any number on them
// without touching anyone else's map. Two maps can seat the same faction at
// different strengths, and neither has to agree with the other.
//
// It also keeps maps honest about size. Folding every faction into one shared
// def meant a two-player badger map shipped orc and gunship definitions it
// could never spawn — 47 entity defs where 8 were reachable.

/**
 * Per-entity overrides, keyed by entity id. Shallow-merged over the faction's
 * own numbers, so a map says what it changes and nothing else.
 *
 * Nested blocks (combat, horde, income) merge one level deep, which is what
 * you want for `{ combat: { damage: 12 } }` — the rest of the weapon survives.
 */
export type Tuning = Record<string, Record<string, unknown>>

export interface ComposeOptions {
  id: string
  name: string
  factions: Faction[]
  victory: VictoryDef
  /** Per-map balance changes, keyed by entity id. */
  tune?: Tuning
  /** Resource each player opens with; absent = the shared default. */
  startAmount?: number
}

const MERGE_DEEP = new Set(['combat', 'horde', 'income', 'visual', 'mover', 'plot', 'trainer'])

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

export function composeDef(opts: ComposeOptions): GameDef {
  const seen = new Map<string, EntityDef>()
  for (const e of [...NEUTRAL_ENTITIES, ...opts.factions.flatMap((f) => f.entities)]) {
    // Two factions sharing an entity id would silently shadow each other, and
    // the loser's stats would vanish with no error anywhere.
    if (seen.has(e.id)) throw new Error(`composeDef("${opts.id}"): duplicate entity id "${e.id}"`)
    seen.set(e.id, e)
  }

  const tune = opts.tune ?? {}
  for (const id of Object.keys(tune)) {
    // A typo'd id would otherwise be a balance change that silently did nothing
    if (!seen.has(id)) throw new Error(`composeDef("${opts.id}"): tuning unknown entity "${id}"`)
    seen.set(id, applyTuning(seen.get(id)!, tune[id]))
  }

  const resources =
    opts.startAmount === undefined
      ? BASE_RULES.resources
      : BASE_RULES.resources.map((r) => ({ ...r, startAmount: opts.startAmount! }))

  return {
    ...BASE_RULES,
    abilities: opts.factions.flatMap((f) => f.abilities ?? []),
    resources,
    id: opts.id,
    name: opts.name,
    entities: [...seen.values()],
    victory: opts.victory,
  }
}
