import { generateMap, type RtsMapDoc } from '@battlebadger/sim'
import { WsTransport } from '../net/transport.ts'
import { listLibrary, loadLibraryMap, saveToLibrary } from '../mapLibrary.ts'

export interface MatchStart {
  slot: number
  transport: WsTransport | null // null → practice (LocalLoopback)
  players: string[]
  // Always a concrete map: the host's library pick, the host-generated
  // skirmish, or the doc transferred to a guest. Never regenerated per client —
  // the doc carries its own seed.
  doc: RtsMapDoc
  // Per-slot computer-opponent difficulty (0 = human). Every client in a match
  // must agree — it is folded into stateHash, so a mismatch desyncs at tick 0.
  aiLevels?: number[]
}

const BUILTIN = '__skirmish'
const SLOT_COLORS = ['#4aa3ff', '#ff5a4a', '#59d98c', '#c678dd', '#ffc46b', '#6be1e8', '#f567b8', '#bfd35c']
const TEAM_NAMES = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6', 'Team 7', 'Team 8']

interface MapMeta {
  slots: number
  slotTeams?: number[]
  label: string
}

// Lobby: pick any map from your local library, see the player slots fill in,
// and start — alone or with up to 8 players. Guests download the host's map
// through the relay automatically.
export function showLobby(onStart: (m: MatchStart) => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = `
    <div class="panel lobby-panel">
      <h1>Battle<span>Badger</span></h1>
      <div class="sub">browser lockstep RTS — data-driven, up to 8 players</div>
      <div class="lobby-grid">
        <div class="lobby-left">
          <label>Commander name</label>
          <input id="lb-name" maxlength="16" spellcheck="false" />
          <label>Map</label>
          <select id="lb-map"></select>
          <div class="mapinfo" id="lb-mapinfo"></div>
          <div class="row">
            <button id="lb-import">Import map…</button>
            <button id="lb-starters">Starter maps…</button>
          </div>
          <hr class="lobby-hr" />
          <div class="row">
            <button id="lb-create" class="primary">Create room</button>
            <button id="lb-join">Join room</button>
          </div>
          <div id="lb-joinrow" style="display:none">
            <label>Room code</label>
            <input id="lb-code" maxlength="4" spellcheck="false" style="text-transform:uppercase" />
          </div>
          <button id="lb-practice">Practice (offline)</button>
          <button id="lb-editor">Map editor</button>
        </div>
        <div class="lobby-right">
          <div id="lb-codeshow" class="code" style="display:none"></div>
          <label>Players</label>
          <ul id="lb-players"></ul>
          <button id="lb-start" class="primary" style="display:none" disabled>Start match</button>
          <div class="status" id="lb-status"></div>
        </div>
      </div>
      <input type="file" id="lb-file" accept=".json,.bbmap" style="display:none" />
    </div>`
  document.body.appendChild(overlay)

  const $ = <T extends HTMLElement>(id: string): T => overlay.querySelector<T>(`#${id}`)!
  const nameInput = $<HTMLInputElement>('lb-name')
  const status = $('lb-status')
  const startBtn = $<HTMLButtonElement>('lb-start')
  const mapSel = $<HTMLSelectElement>('lb-map')
  const mapInfo = $('lb-mapinfo')
  const playersEl = $('lb-players')
  nameInput.value = localStorage.getItem('bb-name') ?? `Badger${Math.floor(Math.random() * 900 + 100)}`

  let transport: WsTransport | null = null
  let inRoom = false
  let mySlot = 0
  let hostDoc: RtsMapDoc | null = null // host's selected map, resolved before start
  let builtinDoc: RtsMapDoc | null = null // generated skirmish, stable for this lobby
  let hostJson = ''
  let mapSentTo = -1 // guest count the map was last sent for
  const ackSlots = new Set<number>()
  let receivedDoc: RtsMapDoc | null = null // guest side
  let lastPlayers: (string | null)[] = []
  let mapMeta: MapMeta = { slots: 2, label: 'Skirmish Valley · 2 players · free-for-all' }

  const metaOf = (doc: RtsMapDoc | null): MapMeta => {
    if (!doc) return { slots: 2, label: 'Skirmish Valley · generated · 2 players · 1v1' }
    const slots = Math.max(1, Math.min(8, doc.startLocations.length))
    const teams = doc.slotTeams
    const teamCount = teams ? new Set(teams.slice(0, slots)).size : slots
    const label = `${doc.name} · ${slots} player slots · ${teams ? `${teamCount} teams` : 'free-for-all'}`
    return { slots, slotTeams: teams, label }
  }

  const playerName = (): string => {
    const n = nameInput.value.trim() || 'Badger'
    localStorage.setItem('bb-name', n)
    return n
  }

  // ---- players panel (always visible, empty slots included) ----
  const renderPlayers = (): void => {
    const players = inRoom ? lastPlayers : [playerName()]
    // guests describe the map they were sent; the host describes their pick
    const meta = metaOf(inRoom && mySlot !== 0 ? receivedDoc : hostDoc)
    const slots = Math.max(meta.slots, players.filter(Boolean).length)
    let html = ''
    for (let i = 0; i < slots; i++) {
      const name = players[i]
      const you = inRoom ? i === mySlot : i === 0
      const team = meta.slotTeams ? TEAM_NAMES[meta.slotTeams[i] ?? i] : `Team ${i + 1}`
      html += `<li class="${name ? 'filled' : 'open'}">
        <i style="background:${SLOT_COLORS[i]}"></i>
        <span class="pname">${name ?? 'Open slot'}</span>
        <span class="pteam">${team}${you ? ' · you' : i === 0 && name ? ' · host' : ''}</span>
      </li>`
    }
    playersEl.innerHTML = html
  }

  // ---- map picker ----
  const refreshMaps = async (): Promise<void> => {
    const lib = await listLibrary().catch(() => [])
    const prev = mapSel.value
    mapSel.innerHTML =
      `<option value="${BUILTIN}">Skirmish Valley (generated)</option>` +
      lib.map((e) => `<option value="${e.key}">${e.name}</option>`).join('')
    const remembered = prev || localStorage.getItem('bb-map')
    if (remembered && [...mapSel.options].some((o) => o.value === remembered)) mapSel.value = remembered
    await resolveSelectedMap()
  }

  const resolveSelectedMap = async (): Promise<boolean> => {
    hostDoc = null
    hostJson = ''
    if (mapSel.value === BUILTIN) {
      // Generate on the host only, then ship the bytes to guests through the
      // normal map transfer. Keeps the per-match terrain variety without making
      // generator source determinism-critical: a guest on a different client
      // build plays the host's map rather than re-deriving its own from a seed.
      // Memoized so a lobby refresh can't swap the map out from under guests
      // who already received it — switching the picker away and back rerolls.
      builtinDoc ??= generateMap(Math.floor(Math.random() * 0xffffffff))
      hostDoc = builtinDoc
      hostJson = JSON.stringify(builtinDoc)
    } else {
      const entry = await loadLibraryMap(mapSel.value)
      if (!entry) {
        status.textContent = 'could not load the selected map'
        mapInfo.textContent = ''
        return false
      }
      hostDoc = entry.doc
      hostJson = entry.json
    }
    mapMeta = metaOf(hostDoc)
    mapInfo.textContent = mapMeta.label
    renderPlayers()
    return true
  }

  mapSel.addEventListener('change', () => {
    localStorage.setItem('bb-map', mapSel.value)
    builtinDoc = null // explicit pick rerolls the generated skirmish
    void resolveSelectedMap().then(() => {
      // host may switch maps while the room is open — resend to guests
      if (inRoom && mySlot === 0) {
        mapSentTo = -1
        updateLobby(lastPlayers)
      }
    })
  })
  nameInput.addEventListener('input', renderPlayers)
  void refreshMaps()

  const guestsCount = (): number => Math.max(0, lastPlayers.filter(Boolean).length - 1)

  const updateLobby = (players: (string | null)[]): void => {
    lastPlayers = players
    renderPlayers()
    const n = players.filter(Boolean).length
    if (mySlot !== 0) {
      startBtn.style.display = 'none'
      status.textContent = receivedDoc
        ? `map received: ${receivedDoc.name} — waiting for the host to start`
        : 'waiting for the host…'
      return
    }
    startBtn.style.display = 'block'
    if (hostDoc && guestsCount() > 0) {
      if (mapSentTo !== guestsCount()) {
        mapSentTo = guestsCount()
        ackSlots.clear()
        status.textContent = `sending map "${hostDoc.name}"…`
        transport?.sendMapDoc(hostJson)
        startBtn.disabled = true
        return
      }
      const ready = ackSlots.size >= guestsCount()
      startBtn.disabled = !ready
      status.textContent = ready
        ? `map delivered — ready with ${n} player${n > 1 ? 's' : ''}`
        : `waiting for map delivery (${ackSlots.size}/${guestsCount()})…`
      return
    }
    startBtn.disabled = false
    status.textContent =
      n <= 1 ? 'share the room code — or start solo to explore the map' : `ready with ${n} players`
  }

  const connect = (code: string, created: boolean): void => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/rooms/${code}/ws?name=${encodeURIComponent(playerName())}`
    status.textContent = 'connecting…'
    transport = new WsTransport(url, {
      onJoined: (slot, players) => {
        mySlot = slot
        inRoom = true
        nameInput.disabled = true
        // in a room these no longer apply — say so visually
        for (const id of ['lb-create', 'lb-join', 'lb-practice', 'lb-editor']) {
          $(id).setAttribute('disabled', '')
        }
        $('lb-joinrow').style.display = 'none'
        if (slot !== 0) {
          mapSel.disabled = true
          $('lb-import').setAttribute('disabled', '')
          $('lb-starters').setAttribute('disabled', '')
        }
        $('lb-codeshow').style.display = 'block'
        $('lb-codeshow').textContent = code
        if (!created) status.textContent = `joined room ${code}`
        updateLobby(players)
      },
      onLobby: (players) => updateLobby(players),
      onStart: (_seed, players) => {
        // The doc is authoritative and always transferred; a guest without one
        // must not fall back to generating its own, which would desync.
        const doc = mySlot === 0 ? hostDoc : receivedDoc
        if (!doc) {
          status.textContent = 'the host’s map never arrived — rejoin the room'
          return
        }
        overlay.remove()
        onStart({ slot: mySlot, transport, players, doc })
      },
      onMapDoc: (json) => {
        try {
          receivedDoc = JSON.parse(json) as RtsMapDoc
        } catch {
          receivedDoc = null
        }
        updateLobby(lastPlayers)
      },
      onMapAck: (ok, slot) => {
        if (ok) ackSlots.add(slot)
        updateLobby(lastPlayers)
      },
      onError: (m) => {
        status.textContent = `error: ${m}`
        transport = null
      },
      onClose: () => {
        if (document.body.contains(overlay)) {
          status.textContent = 'disconnected'
          startBtn.disabled = true
        }
      },
    })
  }

  $('lb-practice').addEventListener('click', () => {
    void resolveSelectedMap().then((ok) => {
      if (!ok || !hostDoc) return
      overlay.remove()
      // Practice: slot 0 is you, slot 1 is a level-2 computer opponent.
      const aiLevels = [0, 2]
      onStart({ slot: 0, transport: null, players: [playerName(), 'Practice AI'], doc: hostDoc, aiLevels })
    })
  })

  $('lb-create').addEventListener('click', () => {
    void (async () => {
      if (inRoom) return
      if (!(await resolveSelectedMap())) return
      try {
        const res = await fetch('/api/rooms', { method: 'POST' })
        if (!res.ok) throw new Error(String(res.status))
        const { code } = (await res.json()) as { code: string }
        connect(code, true)
      } catch {
        status.textContent = 'could not create room — is the relay running?'
      }
    })()
  })

  $('lb-import').addEventListener('click', () => $('lb-file').click())
  $<HTMLInputElement>('lb-file').addEventListener('change', () => {
    const f = $<HTMLInputElement>('lb-file').files?.[0]
    if (!f) return
    void f.text().then(async (text) => {
      try {
        const parsed = JSON.parse(text) as RtsMapDoc
        if (!parsed.cols || !parsed.rows || !parsed.startLocations) throw new Error('not a map file')
        const key = await saveToLibrary(parsed, text)
        mapSel.value = key
        localStorage.setItem('bb-map', key)
        await refreshMaps()
        status.textContent = `imported to library: ${parsed.name}`
      } catch (err) {
        status.textContent = `could not import map: ${String(err)}`
      }
    })
  })

  $('lb-starters').addEventListener('click', () => {
    void (async () => {
      status.textContent = 'fetching starter maps…'
      try {
        const res = await fetch('/maps/index.json')
        if (!res.ok) throw new Error(String(res.status))
        const index = (await res.json()) as { file: string; name: string; mapName: string }[]
        const sub = document.createElement('div')
        sub.className = 'overlay'
        sub.innerHTML = `<div class="panel"><h1>Starter <span>maps</span></h1>
          <div class="sub">Downloaded maps go into your local library.</div>
          ${index.map((m, i) => `<button data-i="${i}" class="starter">${m.name}</button>`).join('')}
          <button id="st-close">Close</button><div class="status" id="st-status"></div></div>`
        document.body.appendChild(sub)
        sub.querySelector('#st-close')!.addEventListener('click', () => sub.remove())
        sub.querySelectorAll<HTMLButtonElement>('button.starter').forEach((btn) => {
          btn.addEventListener('click', () => {
            const m = index[Number(btn.dataset.i)]
            void (async () => {
              const mapRes = await fetch(`/maps/${m.file}`)
              const json = await mapRes.text()
              const doc = JSON.parse(json) as RtsMapDoc
              const key = await saveToLibrary(doc, json)
              mapSel.value = key
              localStorage.setItem('bb-map', key)
              await refreshMaps()
              sub.querySelector('#st-status')!.textContent = `downloaded: ${doc.name}`
            })()
          })
        })
        status.textContent = ''
      } catch {
        status.textContent = 'could not fetch starter maps'
      }
    })()
  })

  $('lb-editor').addEventListener('click', () => {
    location.hash = '#editor'
    location.reload()
  })

  $('lb-join').addEventListener('click', () => {
    if (inRoom) return
    const row = $('lb-joinrow')
    if (row.style.display === 'none') {
      row.style.display = 'block'
      $<HTMLInputElement>('lb-code').focus()
      return
    }
    const code = $<HTMLInputElement>('lb-code').value.trim().toUpperCase()
    if (code.length === 4) connect(code, false)
    else status.textContent = 'enter the 4-letter room code'
  })

  startBtn.addEventListener('click', () => {
    // guard the join/deliver race: never start while a guest is still missing
    // the custom map (they would boot the wrong map and desync at tick 0)
    if (hostDoc && guestsCount() > 0 && ackSlots.size < guestsCount()) {
      updateLobby(lastPlayers)
      return
    }
    transport?.requestStart()
  })
}
