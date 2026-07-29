// Wire protocol between client and relay. JSON envelopes; tiny by design.
// The relay understands only these shapes — it never runs the sim.
import type { Command, PlayerCommand } from './commands.ts'

export interface TickBundle {
  tick: number
  cmds: PlayerCommand[]
}

export type ClientMsg =
  | { t: 'startReq' }
  | { t: 'cmd'; c: Command }
  | { t: 'hash'; tick: number; h: number }
  // custom-map transfer: host (slot 0) → relay → guest; guest acks
  | { t: 'mapBegin'; chunks: number; bytes: number }
  | { t: 'mapChunk'; i: number; data: string }
  | { t: 'mapAck'; ok: boolean }

export type ServerMsg =
  | { t: 'joined'; slot: number; players: (string | null)[] }
  | { t: 'lobby'; players: (string | null)[] }
  | { t: 'start'; seed: number; players: string[] }
  | { t: 'bundle'; tick: number; cmds: PlayerCommand[] }
  | { t: 'desync'; tick: number }
  | { t: 'forfeit'; winner: number } // slot of the last remaining player
  | { t: 'playerLeft'; slot: number; name: string }
  | { t: 'error'; message: string }
  | { t: 'mapBegin'; chunks: number; bytes: number }
  | { t: 'mapChunk'; i: number; data: string }
  | { t: 'mapAck'; ok: boolean; slot?: number }

export const HASH_EVERY_TICKS = 20
export const MAP_CHUNK_CHARS = 131072
export const MAP_MAX_BYTES = 8 * 1024 * 1024
