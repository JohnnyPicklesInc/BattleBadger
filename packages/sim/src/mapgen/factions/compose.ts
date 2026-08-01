import type { GameDef, VictoryDef } from '../../defs/schema.ts'
import { composeRuleset, type RulesetModule, type Tuning } from '../../ruleset.ts'
import { BASE_RULES, NEUTRAL_MODULE, type Faction } from './shared.ts'

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
//
// The composition itself lives in ruleset.ts, because a faction and an
// imported ruleset module are the same thing. This is the code-authored door
// into it; the editor's import panel is the other one.

export type { Tuning }

export interface ComposeOptions {
  id: string
  name: string
  factions: Faction[]
  /**
   * Extra content that is not a faction — shared fortifications, scenery, a
   * siege pack. Seated after the factions, so a map takes only what it uses.
   */
  modules?: RulesetModule[]
  victory: VictoryDef
  /** Per-map balance changes, keyed by entity id. */
  tune?: Tuning
  /** Resource each player opens with; absent = the shared default. */
  startAmount?: number
}

export function composeDef(opts: ComposeOptions): GameDef {
  return composeRuleset({
    id: opts.id,
    name: opts.name,
    base: BASE_RULES,
    modules: [NEUTRAL_MODULE, ...opts.factions, ...(opts.modules ?? [])],
    victory: opts.victory,
    tune: opts.tune,
    startAmount: opts.startAmount,
  }).gameDef
}
