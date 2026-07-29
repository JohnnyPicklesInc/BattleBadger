import { registerSW } from 'virtual:pwa-register'
import type { RtsMapDoc } from '@battlebadger/sim'
import { Game, type GameEndInfo } from './game/game.ts'
import { LocalLoopback } from './net/transport.ts'
import { loadAssetGeometries } from './render/assets.ts'
import { showLobby } from './ui/lobby.ts'

registerSW({ immediate: true })

const app = document.getElementById('app')!
const banner = document.getElementById('banner')!
const endscreen = document.getElementById('endscreen')!

function showEnd(info: GameEndInfo): void {
  const title = document.getElementById('end-title')!
  const sub = document.getElementById('end-sub')!
  if (info.reason === 'desync') {
    title.textContent = 'Desync'
    sub.textContent = 'The simulations diverged — replay dumped to console.'
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
    new Game(app, doc, 0, new LocalLoopback(), showEnd, assets, 2)
  })
} else {
  showLobby(({ slot, transport, players, doc: lobbyDoc, aiLevels }) => {
    // Dev hook: ?demo=econ boots the economy demo map in practice mode. It
    // loads the served file — the same bytes "Starter maps…" hands out — so
    // that map exists in exactly one place.
    const demo = !transport && new URLSearchParams(location.search).get('demo')
    const pick = demo === 'econ' ? fetchMap('/maps/econ-demo.json', lobbyDoc) : Promise.resolve(lobbyDoc)
    const playerCount = Math.max(2, players.length)
    void pick.then((doc) => loadAssetGeometries(doc).then((assets) => {
      const game = new Game(app, doc, slot, transport ?? new LocalLoopback(), showEnd, assets, playerCount, aiLevels)

      if (transport) {
        // Rebind post-start server events to the running game.
        transport.cb.onDesync = (tick) => {
          banner.textContent = `Desync detected at tick ${tick} — match frozen. Replay dumped to console.`
          banner.style.display = 'block'
          game.end({ won: false, reason: 'desync' })
        }
        transport.cb.onForfeit = (winnerSlot) => game.endForfeit(winnerSlot)
        transport.cb.onPlayerLeft = (_slot, name) => game.notify(`${name} left the game`)
        transport.cb.onClose = () => {
          banner.textContent = 'Connection lost.'
          banner.style.display = 'block'
        }
      }
    }))
  })
}
