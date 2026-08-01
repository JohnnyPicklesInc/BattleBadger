import { seatingProblems, type RtsMapDoc, type RulesetModule } from '@battlebadger/sim'
import { listRulesets } from '../rulesetLibrary.ts'

// The races a lobby can offer: every faction module on the local ruleset shelf,
// built-in or imported. A faction is a module that names a keep, so this is the
// same list the editor imports from — there is no second registry to keep in
// step, and a race somebody authored themselves shows up here for free.

export interface FactionChoice {
  /** Module id — what travels on the wire when a player picks it. */
  id: string
  name: string
  module: RulesetModule
}

export async function listFactions(): Promise<FactionChoice[]> {
  const by = new Map<string, FactionChoice>()
  for (const installed of await listRulesets().catch(() => [])) {
    for (const m of installed.pack.modules) {
      // A module with no keep is scenery or a siege pack — content, not a race.
      if (!m.keep || by.has(m.id)) continue
      by.set(m.id, { id: m.id, name: m.name, module: m })
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Which of them this map can actually seat. A map's rules are its own, so a
 * faction whose damage types the map has never heard of is offered nowhere —
 * picking it would silently do nothing at start.
 */
export function factionsFor(doc: RtsMapDoc | null, all: FactionChoice[]): FactionChoice[] {
  if (!doc) return []
  return all.filter((f) => seatingProblems(doc, f.module).length === 0)
}
