// Invite links: a room code lives in the URL so "send a friend the link" is
// the whole join flow. Kept free of DOM/globals so the parsing rules — the part
// that decides whether a stranger lands in your lobby — are unit-testable.

export const ROOM_PARAM = 'room'

const CODE_RE = /^[A-Za-z]{4}$/

// The relay only routes 4-letter codes (worker.ts), so anything else is not a
// room and must not start a connection attempt.
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim()
  return CODE_RE.test(code) ? code.toUpperCase() : null
}

// Accepts ?room=ABCD and #room=ABCD alike: the hash form survives static hosts
// that rewrite query strings, and people paste both.
export function roomFromUrl(href: string): string | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const fromQuery = normalizeRoomCode(url.searchParams.get(ROOM_PARAM))
  if (fromQuery) return fromQuery
  const hash = url.hash.replace(/^#/, '')
  if (!hash) return null
  const fromHash = new URLSearchParams(hash).get(ROOM_PARAM)
  return normalizeRoomCode(fromHash)
}

// Link to hand out. Drops the current query/hash rather than carrying it: a
// host who arrived on ?demo=econ or #editor should not send that along.
export function inviteLink(href: string, code: string): string {
  const url = new URL(href)
  url.search = `?${ROOM_PARAM}=${code}`
  url.hash = ''
  return url.toString()
}
