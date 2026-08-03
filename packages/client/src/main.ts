import { registerSW } from 'virtual:pwa-register'
import { mapSlotCount, type RtsMapDoc } from '@battlebadger/sim'
import { Game, type GameEndInfo } from './game/game.ts'
import { LocalLoopback, WsTransport } from './net/transport.ts'
import { loadAssetGeometries } from './render/assets.ts'
import { showLobby } from './ui/lobby.ts'
import { roomFromUrl } from './ui/invite.ts'
import { banner as showBanner } from './ui/diag.ts'
import { clearStash, readStash, stashMatch, stashedDoc, type MatchStash } from './matchStash.ts'
import { VERSION } from './version.ts'

registerSW({ immediate: true })

const app = document.getElementById('app')!
const endscreen = document.getElementById('endscreen')!

// Anything thrown outside the frame loop — an input handler, a HUD click, a
// rejected asset load — leaves the game apparently frozen with the error
// buried in a console nobody opened. Surface it instead.
window.addEventListener('error', (e) => {
  console.error(`[bb] uncaught error — v${VERSION}`, e.error ?? e.message)
  showBanner(`Uncaught error: ${e.message} — see the console (F12). Build v${VERSION}.`)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error(`[bb] unhandled rejection — v${VERSION}`, e.reason)
  showBanner(`Unhandled error: ${String(e.reason)} — see the console (F12). Build v${VERSION}.`)
})

function showEnd(info: GameEndInfo): void {
  // However it ended, it ended: a stash left behind would offer a rejoin into
  // a match that is over.
  clearStash()
  const title = document.getElementById('end-title')!
  const sub = document.getElementById('end-sub')!
  if (info.reason === 'desync') {
    title.textContent = 'Desync'
    sub.textContent = 'The simulations diverged — replay dumped to console.'
  } else if (info.reason === 'crash') {
    title.textContent = 'Client error'
    sub.textContent = `This client hit a bug and stopped. The console (F12) has the error and the tick it happened on — v${VERSION}.`
  } else {
    title.textContent = info.won ? 'Victory!' : 'Defeat'
    sub.textContent =
      info.reason === 'surrender'
        ? 'You surrendered.'
        : info.reason === 'forfeit'
          ? info.won
            ? 'The opposing team left the battle.'
            : 'The match ended.'
          : info.won
            ? 'The enemy team was defeated.'
            : 'Your team was defeated.'
  }
  endscreen.style.display = 'flex'
}

// Served map file → doc. Falls back to the lobby's own pick rather than
// generating anything: a locally generated substitute would carry a different
// defHash and desync every other client.
async function fetchMap(url: string, fallback: RtsMapDoc): Promise<RtsMapDoc> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as RtsMapDoc
  } catch (err) {
    console.warn(`could not load ${url} — using the lobby map instead`, err)
    return fallback
  }
}

const playtestJson = sessionStorage.getItem('bb-playtest')

if (location.hash === '#editor') {
  void import('./editor/editor.ts').then((m) => m.bootEditor(app))
} else if (playtestJson) {
  // Editor playtest: run the map in practice mode with a way back.
  sessionStorage.removeItem('bb-playtest')
  const doc = JSON.parse(playtestJson) as RtsMapDoc
  const back = document.createElement('button')
  back.id = 'playtest-back'
  back.textContent = '◀ Back to editor'
  back.addEventListener('click', () => {
    location.hash = '#editor'
    location.reload()
  })
  document.body.appendChild(back)
  void loadAssetGeometries(doc).then((assets) => {
    // The map says how many slots it seats and which of them are computers.
    // Hardcoding two meant playtesting a four-player map ran it as a duel with
    // half the bases inert.
    const slots = mapSlotCount(doc)
    const ai = Array.from({ length: slots }, (_, i) => doc.aiLevels?.[i] ?? (i === 0 ? 0 : 2))
    ai[0] = 0 // you are always slot 0 in a playtest
    new Game(app, doc, 0, new LocalLoopback(), showEnd, assets, slots, ai)
  })
} else {
  void rejoinOrLobby()
}

// Bind the live match to its transport. Shared by a normal start and a rejoin,
// because after the first bundle there is no difference between them.
function runMatch(
  doc: RtsMapDoc,
  slot: number,
  transport: WsTransport | null,
  playerCount: number,
  aiLevels: number[] | undefined,
  assets: Map<string, import('three').BufferGeometry>,
): Game {
  const game = new Game(app, doc, slot, transport ?? new LocalLoopback(), showEnd, assets, playerCount, aiLevels)
  if (!transport) return game

  // Rebind post-start server events to the running game.
  // These are final, so they hold the banner against the live stall
  // notices the game loop paints there.
  transport.cb.onDesync = (tick) => {
    showBanner(`Desync detected at tick ${tick} — match frozen. Replay dumped to console.`, { sticky: true })
    game.end({ won: false, reason: 'desync' })
  }
  transport.cb.onForfeit = (winnerSlot) => {
    clearStash()
    game.endForfeit(winnerSlot)
  }
  // Mid-match the lobby's error handler is talking to a removed overlay,
  // so the relay's own explanation would never reach anyone.
  transport.cb.onError = (m) => showBanner(`Relay: ${m}`, { sticky: true })
  transport.cb.onPlayerLeft = (leftSlot, name) => {
    if (leftSlot === slot) clearStash() // we were the one dropped: no way back
    game.notify(`${name} left the game`)
  }
  transport.cb.onClose = () => showBanner('Connection lost.', { sticky: true })
  // ---- rejoin ----
  transport.cb.onReconnecting = (attempt) => game.reconnecting(attempt)
  transport.cb.onCatchup = (from, to, cmds) => game.catchUp(from, to, cmds)
  transport.cb.onPaused = (slots, names, untilMs) => game.heldFor(slots, names, untilMs)
  transport.cb.onResumed = () => game.released()
  // A reconnected socket lands back in the room knowing nothing about where
  // the match got to. Ask for the gap; the room stays paused until we say we
  // have it.
  transport.cb.onJoined = (_slot, _players, _versions, seat) => {
    if (seat?.resumed) transport.sendResume(game.tick)
  }
  return game
}

async function rejoinOrLobby(): Promise<void> {
  // A stash only exists when a match ended abnormally — a reload, a crash, a
  // closed tab. Take the seat back before offering a lobby the player did not
  // ask for.
  const stash = readStash()
  if (stash && (await roomIsLive(stash.code))) {
    try {
      await rejoin(stash)
      return
    } catch (err) {
      console.warn('[bb] rejoin failed — falling back to the lobby', err)
      showBanner(`Could not rejoin match ${stash.code}: ${String(err)}`)
    }
  }
  clearStash()

  showLobby(({ slot, transport, playerCount, doc: lobbyDoc, aiLevels, players }) => {
    // Dev hook: ?demo=econ boots the economy demo map in practice mode. It
    // loads the served file — the same bytes "Starter maps…" hands out — so
    // that map exists in exactly one place.
    const demo = !transport && new URLSearchParams(location.search).get('demo')
    const pick = demo === 'econ' ? fetchMap('/maps/econ-demo.json', lobbyDoc) : Promise.resolve(lobbyDoc)
    void pick.then((doc) => loadAssetGeometries(doc).then((assets) => {
      runMatch(doc, slot, transport, playerCount, aiLevels, assets)
      // Everything a rejoin needs that the relay does not keep. Written after
      // the match is up, so a doc that cannot even boot is never stashed.
      const seat = transport?.seat
      if (transport && seat?.token) {
        void stashMatch(
          { code: roomFromUrl(location.href) ?? '', slot, token: seat.token, playerCount, aiLevels: aiLevels ?? [], players },
          JSON.stringify(doc),
        )
      }
    }))
  })
}

/** Is there still a match in that room to go back to? */
async function roomIsLive(code: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/rooms/${code}/state`)
    if (!res.ok) return false
    const s = (await res.json()) as { started: boolean; ended: boolean }
    return s.started && !s.ended
  } catch {
    return false
  }
}

async function rejoin(stash: MatchStash): Promise<void> {
  const docJson = await stashedDoc()
  if (!docJson) throw new Error('the map for that match is no longer on this device')
  const doc = JSON.parse(docJson) as RtsMapDoc
  const assets = await loadAssetGeometries(doc)
  showBanner(`Rejoining match ${stash.code}…`)

  await new Promise<void>((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url =
      `${proto}//${location.host}/api/rooms/${stash.code}/ws` +
      `?name=${encodeURIComponent(stash.players[stash.slot] ?? 'Badger')}&ver=${encodeURIComponent(VERSION)}` +
      `&slot=${stash.slot}&token=${encodeURIComponent(stash.token)}`
    let game: Game | null = null
    const transport = new WsTransport(url, {
      onJoined: () => {
        // The sim starts at tick 0 and the relay sends everything since, which
        // the game replays at speed. Same code path as a live match — a rejoin
        // is just the same simulation, run faster.
        game = runMatch(doc, stash.slot, transport, stash.playerCount, stash.aiLevels, assets)
        transport.sendResume(0)
        showBanner(null)
        resolve()
      },
      onError: (m) => {
        if (!game) reject(new Error(m))
      },
      onClose: () => {
        if (!game) reject(new Error('the room refused the connection'))
      },
    })
    setTimeout(() => {
      if (!game) reject(new Error('timed out'))
    }, 8000)
  })
}
