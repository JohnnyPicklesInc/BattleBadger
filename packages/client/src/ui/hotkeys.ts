// Command-card hotkeys.
//
// Every action a selection can take gets a key, so the card is never the only
// way to give an order. Authored keys (abilities, upgrades, formations) are
// honoured when they are free; everything else takes the first free letter of
// its own name. Two factions' upgrades are free to ask for the same letter —
// whichever is on the card first keeps it and the other is re-lettered, so the
// key printed on a button is always the key that works.

/** Keys the game keeps for itself; a card action never takes one. */
export const RESERVED_KEYS = ['A', 'M', 'S', 'H', 'P', 'F']

// Last resort, when a name's own letters are all spoken for. Home row first:
// a key you have to be told about should at least be an easy one to hold.
const FALLBACK_ORDER = 'QWERTYUIOPASDFGHJKLZXCVBNM'

export interface KeyedAction {
  /** Stable identity of the action — what the returned map is keyed by. */
  key: string
  /** What the button says; its letters are the pool this draws from. */
  label: string
  /** The key the GameDef asked for, if any. */
  hotkey?: string
}

/** A single A–Z letter, or ''. */
function letterOf(hotkey: string | undefined): string {
  if (!hotkey) return ''
  const c = hotkey.trim().toUpperCase()
  return c.length === 1 && c >= 'A' && c <= 'Z' ? c : ''
}

/**
 * Letter per action, keyed by `action.key`. Order matters: earlier actions win
 * a contested letter, and the card lists abilities before build/train, so a
 * hero's spell is not re-lettered by a barracks that happens to share an
 * initial. An action can come back without a key only if all 26 are taken.
 */
export function assignHotkeys(actions: KeyedAction[]): Map<string, string> {
  const used = new Set<string>(RESERVED_KEYS)
  const out = new Map<string, string>()
  // Authored keys first, and across the whole card: a def that named a key
  // must not lose it to a build button that got there first.
  for (const a of actions) {
    const want = letterOf(a.hotkey)
    if (want === '' || used.has(want) || out.has(a.key)) continue
    used.add(want)
    out.set(a.key, want)
  }
  for (const a of actions) {
    if (out.has(a.key)) continue
    const pool = a.label.toUpperCase().replace(/[^A-Z]/g, '') + FALLBACK_ORDER
    for (const c of pool) {
      if (used.has(c)) continue
      used.add(c)
      out.set(a.key, c)
      break
    }
  }
  return out
}
