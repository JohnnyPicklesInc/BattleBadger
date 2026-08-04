export type CommandKind =
  | 'move'
  | 'attackMove'
  | 'attack' // target a specific entity (handle in `target`)
  | 'follow' // shadow a specific ally (handle in `target`)
  | 'hold'
  | 'patrol'
  | 'stop'
  | 'ability'
  | 'harvest'
  | 'build'
  | 'train'
  | 'cancel'
  | 'rally'
  | 'formation' // switch a horde's stance (index in `def`)
  | 'gate' // work a gate: open / shut / auto (GateMode in `def`)
  | 'research' // start an upgrade at a building (upgrade index in `def`)
  | 'garrison' // man a wall top (structure handle in `target`)

// What a client sends. `player` is never trusted from the payload — the relay
// stamps it from the connection. `units`/`target` are entity HANDLES
// (id | gen<<16); the sim resolves and silently drops stale ones.
export interface Command {
  kind: CommandKind
  units: number[]
  x: number
  z: number
  // ability only:
  ability?: number // ability index in the GameDef
  // ability: handle of the targeted entity (ally/enemy abilities)
  // attack/follow: handle of the targeted entity
  // harvest: node reference — doodad nodes encode as -1-doodadIndex
  // cancel: index into the building's production queue
  target?: number
  // build/train: entity def index to construct/produce
  // formation: stance index. gate: a GateMode.
  def?: number
}

export interface PlayerCommand extends Command {
  player: number
}
