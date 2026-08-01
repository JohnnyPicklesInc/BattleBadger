import type { GenBlueprint, RtsMapDoc } from '@battlebadger/sim'
import { validateBlueprints } from '@battlebadger/sim'
import { DOODAD_BLUEPRINTS } from './doodads.ts'
import { UNIT_BLUEPRINTS } from './units.ts'
import { STRUCTURE_BLUEPRINTS } from './structures.ts'

// Every blueprint shipped with the client.
export const GEN_BLUEPRINTS: Record<string, GenBlueprint> = {
  ...DOODAD_BLUEPRINTS,
  ...UNIT_BLUEPRINTS,
  ...STRUCTURE_BLUEPRINTS,
}

// Blueprints authored into the map currently being played or edited.
//
// Module-level rather than threaded through every call site because the whole
// client renders exactly one map at a time, and both the renderer and the HUD
// portrait resolve models independently. Set it when a map loads; it is
// render-only, so a wrong value can never affect the simulation.
let mapBlueprints: Record<string, GenBlueprint> = {}

export function setMapBlueprints(list: readonly GenBlueprint[] | undefined): void {
  mapBlueprints = {}
  // Validated one at a time on purpose: a single bad blueprint should cost the
  // author that one model, not every custom model on the map.
  for (const bp of list ?? []) {
    try {
      validateBlueprints([bp])
      mapBlueprints[bp.id] = bp
    } catch (err) {
      console.warn('map blueprint rejected — using placeholder', err)
    }
  }
}

/** Load a doc's own models. Safe to call with any doc, including none. */
export function useMapBlueprints(doc: Pick<RtsMapDoc, 'blueprints'> | null | undefined): void {
  setMapBlueprints(doc?.blueprints)
}

/**
 * Resolve a 'gen:<id>' model. The MAP wins over the built-ins, so a map can
 * add models of its own or replace a stock one without touching the client.
 */
export function findBlueprint(id: string): GenBlueprint | undefined {
  return mapBlueprints[id] ?? GEN_BLUEPRINTS[id]
}
