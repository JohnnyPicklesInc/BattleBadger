// Wire protocol between client and relay. JSON envelopes; tiny by design.
// The relay understands only these shapes — it never runs the sim.
import type { Command, PlayerCommand } from './commands.ts'

export interface TickBundle {
  tick: number
  cmds: PlayerCommand[]
}

// What a player asked for in the lobby: their race and their team. Requests,
// not facts — the host owns the seating and answers with 'seats'.
export interface SeatPick {
  /** Faction module id, or null for whatever the map seats this slot as. */
  faction?: string | null
  team?: number
  /** Which of the map's start positions this slot wants. Absent = its own. */
  start?: number
  /** Computer opponent difficulty for an unoccupied slot: 0/absent = open,
   * 1..3 = easy/normal/hard. The host decides these; a guest cannot seat one. */
  ai?: number
}

export type ClientMsg =
  | { t: 'startReq' }
  | { t: 'cmd'; c: Command }
  | { t: 'hash'; tick: number; h: number }
  // custom-map transfer: host (slot 0) → relay → guest; guest acks
  | { t: 'mapBegin'; chunks: number; bytes: number }
  | { t: 'mapChunk'; i: number; data: string }
  | { t: 'mapAck'; ok: boolean }
  // lobby seating: a player asks (guest → host), the host publishes ('seats')
  | { t: 'pick'; pick: SeatPick }
  | { t: 'seats'; seats: SeatPick[] }

export type ServerMsg =
  // `versions` is the client build each player is on, by slot. Lockstep only
  // works if everyone runs the same code, so the lobby says so out loud rather
  // than letting a stale cache surface as a desync ten seconds into the match.
  | { t: 'joined'; slot: number; players: (string | null)[]; versions?: (string | null)[] }
  | { t: 'lobby'; players: (string | null)[]; versions?: (string | null)[] }
  // Padded by slot, nulls for empty seats: which slot a name sits in decides
  // which base it owns, and a compacted list loses exactly that.
  | { t: 'start'; seed: number; players: (string | null)[] }
  | { t: 'bundle'; tick: number; cmds: PlayerCommand[] }
  | { t: 'desync'; tick: number }
  | { t: 'forfeit'; winner: number } // slot of the last remaining player
  | { t: 'playerLeft'; slot: number; name: string }
  | { t: 'error'; message: string }
  | { t: 'mapBegin'; chunks: number; bytes: number }
  | { t: 'mapChunk'; i: number; data: string }
  | { t: 'mapAck'; ok: boolean; slot?: number }
  | { t: 'pick'; pick: SeatPick; slot: number } // guest's request, stamped by the relay
  | { t: 'seats'; seats: SeatPick[] } // the host's answer: the seating everyone plays

export const HASH_EVERY_TICKS = 20
export const MAP_CHUNK_CHARS = 131072
export const MAP_MAX_BYTES = 8 * 1024 * 1024
