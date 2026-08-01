import {
  BUILTIN_RULESETS,
  checkModuleFits,
  installModule,
  validateRulesetPack,
  type GameDef,
  type RtsMapDoc,
  type RulesetModule,
  type RulesetPack,
} from '@battlebadger/sim'
import { idbDelete, idbKeys, idbGet, idbPut } from './mapLibrary.ts'

// The local ruleset shelf: rules saved once and dropped into any map.
//
// Shares the map library's IndexedDB store under its own key prefix, because
// the two have identical needs (list, save, delete, survive a reload) and a
// second database would only be a second thing to open.

const PREFIX = 'rules:'

export interface InstalledRuleset {
  key: string
  pack: RulesetPack
  /** Ships with the game: always present, cannot be deleted. */
  builtIn: boolean
}

export async function listRulesets(): Promise<InstalledRuleset[]> {
  const saved: InstalledRuleset[] = []
  for (const key of await idbKeys(PREFIX)) {
    const json = await idbGet(key)
    if (!json) continue
    try {
      saved.push({ key, pack: validateRulesetPack(JSON.parse(json)), builtIn: false })
    } catch (err) {
      // A shelf entry that no longer parses should not hide the rest of them.
      console.warn(`ruleset ${key} is unreadable — skipping`, err)
    }
  }
  saved.sort((a, b) => a.pack.name.localeCompare(b.pack.name))
  const builtIn = BUILTIN_RULESETS.map((pack) => ({ key: `builtin:${pack.id}`, pack, builtIn: true }))
  return [...builtIn, ...saved]
}

export async function saveRuleset(pack: RulesetPack): Promise<string> {
  const key = `${PREFIX}${pack.id}`
  await idbPut(key, JSON.stringify(validateRulesetPack(pack)))
  return key
}

export async function deleteRuleset(key: string): Promise<void> {
  if (!key.startsWith(PREFIX)) throw new Error('built-in rulesets cannot be deleted')
  await idbDelete(key)
}

/** Download a pack as a self-contained file somebody else can import. */
export function exportRuleset(pack: RulesetPack): void {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${pack.id}.bbrules.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

export interface InstallResult {
  gameDef: GameDef
  blueprints: RtsMapDoc['blueprints']
  assets: RtsMapDoc['assets']
  /** What the author should know: adopted a base, skipped a duplicate model… */
  notes: string[]
}

function fitProblems(pack: RulesetPack, def: GameDef): string[] {
  const errs: string[] = []
  for (const m of pack.modules) {
    for (const problem of checkModuleFits(m, def)) errs.push(`${m.name}: ${problem}`)
  }
  return errs
}

/**
 * Work out what a map would look like with this ruleset added, WITHOUT
 * touching it. The caller applies the result or discards it, so a rejected
 * import can never leave a half-installed map behind.
 *
 * Everything is copied in. Nothing links back to the shelf: a map that
 * referenced a ruleset by name would be two players agreeing on a name and
 * disagreeing about the bytes, which is the failure map content hashes exist
 * to make impossible.
 */
export function installRuleset(doc: RtsMapDoc, pack: RulesetPack): InstallResult {
  const notes: string[] = []
  let def = doc.gameDef

  if (!def) {
    if (!pack.base) {
      throw new Error(`"${pack.name}" is an add-on and needs a map that already has rules`)
    }
    // An empty map adopts the pack's physics wholesale — this is the path that
    // makes "start a map from a ruleset" work at all.
    def = { ...pack.base, id: pack.id, name: pack.name, entities: [], abilities: [], victory: { mode: 'annihilation' } }
    notes.push(`adopted the damage and economy rules from "${pack.name}"`)
  } else {
    // The map already has physics, so the pack's base is ignored and its
    // modules have to live with what is here. Saying so beats a silent
    // mismatch where a unit's counters quietly stop applying.
    const problems = fitProblems(pack, def)
    if (problems.length > 0) {
      throw new Error(`"${pack.name}" does not fit this map's rules:\n- ${problems.join('\n- ')}`)
    }
    if (pack.base) notes.push(`kept this map's own damage and economy rules`)
  }

  for (const m of pack.modules) def = installModule(def, m) // throws on an entity id clash

  const blueprints = [...(doc.blueprints ?? [])]
  const have = new Set(blueprints.map((b) => b.id))
  for (const m of pack.modules) {
    for (const bp of m.blueprints ?? []) {
      // The map's own model wins: an author who edited a shape should not have
      // it silently reverted by importing the pack it came from.
      if (have.has(bp.id)) notes.push(`kept this map's version of the model "${bp.id}"`)
      else {
        blueprints.push(bp)
        have.add(bp.id)
      }
    }
  }

  const assets = [...(doc.assets ?? [])]
  const haveAsset = new Set(assets.map((a) => a.id))
  for (const m of pack.modules) {
    for (const a of m.assets ?? []) {
      if (!haveAsset.has(a.id)) {
        assets.push(a)
        haveAsset.add(a.id)
      }
    }
  }

  const units = pack.modules.reduce((n, m) => n + m.entities.length, 0)
  notes.push(`added ${units} entit${units === 1 ? 'y' : 'ies'} and ${blueprints.length - (doc.blueprints?.length ?? 0)} model(s)`)

  return {
    gameDef: def,
    blueprints: blueprints.length > 0 ? blueprints : undefined,
    assets: assets.length > 0 ? assets : undefined,
    notes,
  }
}

/** A one-line summary for the shelf. */
export function describeRuleset(pack: RulesetPack): string {
  const units = pack.modules.reduce((n: number, m: RulesetModule) => n + m.entities.length, 0)
  const models = pack.modules.reduce((n: number, m: RulesetModule) => n + (m.blueprints?.length ?? 0), 0)
  const bits = [`${units} entities`]
  if (models > 0) bits.push(`${models} models`)
  if (pack.base) bits.push('full rules')
  else bits.push('add-on')
  if (pack.version !== undefined) bits.push(`v${pack.version}`)
  return bits.join(' · ')
}
