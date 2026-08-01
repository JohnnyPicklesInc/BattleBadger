// The blueprint format now lives in the sim package, because a map document
// can carry its own blueprints (see RtsMapDoc.blueprints). Re-exported here so
// the client's gen/ modules keep importing from their natural home.
export type { GenBlueprint, GenGroupRole, GenPart, Vec3 } from '@battlebadger/sim'
