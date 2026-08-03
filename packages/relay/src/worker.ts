import { GameRoom } from './gameRoom.ts'

export { GameRoom }

interface Env {
  // Typed with the class so the room's RPC methods (roomState) are callable
  // through the stub rather than only over fetch.
  GAME_ROOM: DurableObjectNamespace<GameRoom>
  ASSETS: Fetcher
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ' // no I/L/O — unambiguous

function makeCode(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return Response.json({ code: makeCode() })
    }

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z]{4})\/ws$/)
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase()
      const id = env.GAME_ROOM.idFromName(code)
      return env.GAME_ROOM.get(id).fetch(request)
    }

    // "Is the room still ticking?" — the question you actually have when a
    // player reports a freeze. Needs the room code, which is the only secret a
    // room has, and reports no player data.
    const stateMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z]{4})\/state$/)
    if (stateMatch) {
      const code = stateMatch[1].toUpperCase()
      const id = env.GAME_ROOM.idFromName(code)
      return Response.json(await env.GAME_ROOM.get(id).roomState())
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response('not found', { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
}
