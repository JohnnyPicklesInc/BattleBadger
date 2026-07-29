import type { GenBlueprint } from './blueprint.ts'
import { DOODAD_BLUEPRINTS } from './doodads.ts'
import { UNIT_BLUEPRINTS } from './units.ts'
import { STRUCTURE_BLUEPRINTS } from './structures.ts'

// Every blueprint reachable through a def's 'gen:<id>' model.
export const GEN_BLUEPRINTS: Record<string, GenBlueprint> = {
  ...DOODAD_BLUEPRINTS,
  ...UNIT_BLUEPRINTS,
  ...STRUCTURE_BLUEPRINTS,
}
