import { idbDelete, idbGet, idbPut } from './mapLibrary.ts'

// What a client needs to walk back into a match it was thrown out of.
//
// The relay keeps the match's ORDERS — replaying those is how a returning
// client reaches the present. It does not keep the map: it never has, and a
// doc is up to 8 MB of rules, terrain and models that the client already
// holds. So the two halves live where they are cheapest. The relay remembers
// what happened; the client remembers what it was playing.

const META_KEY = 'bb-match'
const DOC_KEY = 'match:doc'

export interface MatchStash {
  code: string
  slot: number
  /** Seat secret from the relay — without it the seat cannot be reclaimed. */
  token: string
  playerCount: number
  aiLevels: number[]
  /** Names by slot, for the HUD and the "waiting for…" notice. */
  players: (string | null)[]
}

export async function stashMatch(stash: MatchStash, docJson: string): Promise<void> {
  try {
    // Doc first: metadata without a map is a rejoin that cannot boot.
    await idbPut(DOC_KEY, docJson)
    localStorage.setItem(META_KEY, JSON.stringify(stash))
  } catch (err) {
    // Private-mode storage, a full quota — rejoin is a nicety, not a
    // requirement, and losing it must never take the live match with it.
    console.warn('[bb] could not stash the match for rejoin', err)
  }
}

export function readStash(): MatchStash | null {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as MatchStash
    return s.code && typeof s.slot === 'number' && s.token ? s : null
  } catch {
    return null
  }
}

export async function stashedDoc(): Promise<string | null> {
  try {
    return await idbGet(DOC_KEY)
  } catch {
    return null
  }
}

/** Drop it the moment the match is genuinely over — a stale stash would offer
 * a rejoin into a room that no longer exists. */
export function clearStash(): void {
  try {
    localStorage.removeItem(META_KEY)
    void idbDelete(DOC_KEY)
  } catch {
    // nothing to clean up
  }
}
