import { GameRoom } from './gameRoom.ts'

export { GameRoom }

interface Env {
  GAME_ROOM: DurableObjectNamespace
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

    if (url.pathname.startsWith('/api/')) {
      return new Response('not found', { status: 404 })
    }

    return env.ASSETS.fetch(request)
  },
}
