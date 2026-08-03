// End-to-end relay test: two scripted WebSocket clients play a full lockstep
// match against a locally running relay (wrangler dev on :8787).
// Each client runs the real sim (bundled via vite in the client build? no —
// we import the TS source directly via tsx-less node: instead we re-implement
// nothing and import the sim through a tiny esbuild-free path: node can't run
// TS, so this script drives the PROTOCOL only and cross-checks the relayed
// bundles + hash comparison logic with fake deterministic hashes.
const BASE = process.env.RELAY_URL ?? 'http://127.0.0.1:8787'

const jfetch = async (path, opts) => {
  const res = await fetch(BASE + path, opts)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

const connect = (code, name, seat) =>
  new Promise((resolve, reject) => {
    const q = seat ? `&slot=${seat.slot}&token=${seat.token}` : ''
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/rooms/${code}/ws?name=${name}${q}`)
    const client = { ws, name, slot: -1, token: null, bundles: [], msgs: [], started: null, catchup: null }
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      client.msgs.push(m)
      if (m.t === 'joined') {
        client.slot = m.slot
        client.token = m.token
        client.resumed = m.resumed === true
        resolve(client)
      } else if (m.t === 'bundle') client.bundles.push(m)
      else if (m.t === 'start') client.started = m
      else if (m.t === 'catchup') client.catchup = m
    }
    ws.onerror = () => reject(new Error('ws error'))
    setTimeout(() => reject(new Error('join timeout')), 5000)
  })

// True when the relay refuses the connection outright (bad token, closed seat).
// A plain fetch cannot ask: undici rejects an Upgrade header before it is sent.
const refused = (code, name, seat) =>
  new Promise((resolve) => {
    const q = seat ? `&slot=${seat.slot}&token=${seat.token}` : ''
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/rooms/${code}/ws?name=${name}${q}`)
    let joined = false
    ws.onmessage = (ev) => {
      if (JSON.parse(ev.data).t === 'joined') {
        joined = true
        ws.close()
      }
    }
    ws.onerror = () => resolve(true)
    ws.onclose = () => resolve(!joined)
    setTimeout(() => resolve(!joined), 2500)
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const send = (c, m) => c.ws.send(JSON.stringify(m))

let failures = 0
const check = (cond, label) => {
  if (cond) console.log(`  ok: ${label}`)
  else {
    console.error(`  FAIL: ${label}`)
    failures++
  }
}

// --- scenario 1: full match flow ---
console.log('scenario 1: lobby, start, bundles, command stamping')
const { code } = await jfetch('/api/rooms', { method: 'POST' })
check(/^[A-Z]{4}$/.test(code), `room code shape (${code})`)

const a = await connect(code, 'Alice')
const b = await connect(code, 'Bob')
check(a.slot !== b.slot, 'distinct slots assigned')

send(a, { t: 'startReq' })
await sleep(400)
check(a.started && b.started, 'both clients got start')
check(a.started?.seed === b.started?.seed, 'same seed for both')

// player B sends a command claiming to be player A — relay must stamp B's slot
send(b, { t: 'cmd', c: { kind: 'move', units: [1, 2], x: 10, z: 20, player: a.slot } })
await sleep(500)
check(a.bundles.length >= 3 && b.bundles.length >= 3, `bundles flowing (${a.bundles.length})`)
const withCmd = a.bundles.find((x) => x.cmds.length > 0)
check(!!withCmd, 'command relayed in a bundle')
check(withCmd?.cmds[0].player === b.slot, 'player stamped from connection, not payload')
const ticksA = a.bundles.map((x) => x.tick)
check(
  ticksA.every((t, i) => i === 0 || t === ticksA[i - 1] + 1),
  'bundle ticks are contiguous',
)

// matching hashes → no desync
send(a, { t: 'hash', tick: 20, h: 12345 })
send(b, { t: 'hash', tick: 20, h: 12345 })
await sleep(200)
check(!a.msgs.some((m) => m.t === 'desync'), 'no desync on matching hashes')

// mismatched hashes → desync broadcast
send(a, { t: 'hash', tick: 40, h: 111 })
send(b, { t: 'hash', tick: 40, h: 222 })
await sleep(300)
check(
  a.msgs.some((m) => m.t === 'desync') && b.msgs.some((m) => m.t === 'desync'),
  'desync broadcast on hash mismatch',
)
a.ws.close()
b.ws.close()

// --- scenario 2: a disconnect holds the match; the survivor decides ---
// Dropping out no longer hands the win over on the spot — it might be a tab
// reloading. The room holds, and the forfeit only lands once the survivor
// stops waiting (or the grace runs out, which is the same path).
console.log('scenario 2: disconnect holds, kick forfeits')
const { code: code2 } = await jfetch('/api/rooms', { method: 'POST' })
const c = await connect(code2, 'Carol')
const d = await connect(code2, 'Dave')
send(c, { t: 'startReq' })
await sleep(300)
d.ws.close()
await sleep(400)
check(
  c.msgs.some((m) => m.t === 'paused' && m.slots.includes(d.slot)),
  'survivor is told the match is holding, not over',
)
check(!c.msgs.some((m) => m.t === 'forfeit'), 'no forfeit while the seat is still open to them')
send(c, { t: 'kick', slot: d.slot })
await sleep(400)
const forfeit = c.msgs.find((m) => m.t === 'forfeit')
check(!!forfeit, 'forfeit received by survivor once they stop waiting')
check(forfeit?.winner === c.slot, 'survivor declared winner')
c.ws.close()

// --- scenario 3: room holds 8 players, rejects the 9th ---
console.log('scenario 3: room capacity is 8')
const { code: code3 } = await jfetch('/api/rooms', { method: 'POST' })
const eight = []
for (let i = 0; i < 8; i++) eight.push(await connect(code3, `P${i}`))
check(new Set(eight.map((c) => c.slot)).size === 8, 'eight distinct slots assigned')
let rejected = false
try {
  await connect(code3, 'Ninth')
} catch {
  rejected = true
}
check(rejected, 'ninth join rejected')
for (const c of eight) c.ws.close()

// --- scenario 3.5: custom map transfer pass-through ---
console.log('scenario 3.5: map transfer host → guest')
const { code: code4 } = await jfetch('/api/rooms', { method: 'POST' })
const host = await connect(code4, 'Host')
const guest = await connect(code4, 'Guest')
const mapJson = JSON.stringify({ version: 2, name: 'custom', payload: 'x'.repeat(300000) })
const CHUNK = 131072
const chunks = []
for (let i = 0; i < mapJson.length; i += CHUNK) chunks.push(mapJson.slice(i, i + CHUNK))
send(host, { t: 'mapBegin', chunks: chunks.length, bytes: mapJson.length })
chunks.forEach((data, i) => send(host, { t: 'mapChunk', i, data }))
await sleep(600)
const gBegin = guest.msgs.find((m) => m.t === 'mapBegin')
const gChunks = guest.msgs.filter((m) => m.t === 'mapChunk')
check(!!gBegin && gBegin.chunks === chunks.length, 'guest received mapBegin')
check(gChunks.length === chunks.length, `guest received all ${chunks.length} chunks`)
const reassembled = gChunks.sort((a, b) => a.i - b.i).map((c) => c.data).join('')
check(reassembled === mapJson, 'reassembled map matches exactly')
send(guest, { t: 'mapAck', ok: true })
await sleep(300)
check(host.msgs.some((m) => m.t === 'mapAck' && m.ok), 'host received guest ack')
// guest may NOT send map data
send(guest, { t: 'mapBegin', chunks: 1, bytes: 10 })
send(guest, { t: 'mapChunk', i: 0, data: 'evil' })
await sleep(300)
check(!host.msgs.some((m) => m.t === 'mapChunk'), 'guest-sent map data not forwarded')
host.ws.close()
guest.ws.close()

// --- scenario 3.8: 3-player room — fan-out, multi-hash, last-player forfeit ---
console.log('scenario 3.8: 3 players')
const { code: code5 } = await jfetch('/api/rooms', { method: 'POST' })
const h3 = await connect(code5, 'Host3')
const g1 = await connect(code5, 'GuestA')
const g2 = await connect(code5, 'GuestB')
check(h3.slot === 0 && g1.slot === 1 && g2.slot === 2, 'slots 0/1/2 assigned')
// map fan-out reaches both guests
send(h3, { t: 'mapBegin', chunks: 1, bytes: 20 })
send(h3, { t: 'mapChunk', i: 0, data: '{"version":2}' })
await sleep(400)
check(
  g1.msgs.some((m) => m.t === 'mapChunk') && g2.msgs.some((m) => m.t === 'mapChunk'),
  'map chunks fanned out to both guests',
)
send(g1, { t: 'mapAck', ok: true })
send(g2, { t: 'mapAck', ok: true })
await sleep(300)
const acks = h3.msgs.filter((m) => m.t === 'mapAck')
check(acks.length === 2 && new Set(acks.map((a) => a.slot)).size === 2, 'host got acks with slots')
send(h3, { t: 'startReq' })
await sleep(400)
check(h3.started && g1.started && g2.started, 'all three got start')
// matching hashes from all 3 → no desync
send(h3, { t: 'hash', tick: 20, h: 7 })
send(g1, { t: 'hash', tick: 20, h: 7 })
send(g2, { t: 'hash', tick: 20, h: 7 })
await sleep(300)
check(!h3.msgs.some((m) => m.t === 'desync'), 'no desync with 3 matching hashes')
// one guest leaves → the room holds; kicking them lets the other two play on
g1.ws.close()
await sleep(400)
check(h3.msgs.some((m) => m.t === 'paused' && m.slots.includes(1)), 'room holds for the guest who dropped')
send(h3, { t: 'kick', slot: 1 })
await sleep(400)
check(h3.msgs.some((m) => m.t === 'playerLeft' && m.slot === 1), 'kicked guest reported as left')
check(!h3.msgs.some((m) => m.t === 'forfeit'), 'no forfeit while 2 remain')
check((await jfetch(`/api/rooms/${code5}/state`)).ticking, 'match plays on with the remaining two')
// second guest leaves and is kicked → forfeit for the last player standing
g2.ws.close()
await sleep(400)
send(h3, { t: 'kick', slot: 2 })
await sleep(400)
const ff = h3.msgs.find((m) => m.t === 'forfeit')
check(ff && ff.winner === 0, 'last player standing gets the forfeit win')
h3.ws.close()

// --- scenario 3.9: the room's clock survives, and something watches it ---
// A relay that is evicted mid-match takes the tick counter, the metronome and
// every client's game with it. The room persists the counter and arms an alarm
// so it can pick the stream back up; this checks the two things that recovery
// depends on being true while a match runs.
console.log('scenario 3.9: room clock persisted + watchdog armed')
const { code: code6 } = await jfetch('/api/rooms', { method: 'POST' })
const idle = await jfetch(`/api/rooms/${code6}/state`)
check(idle.started === false && idle.tick === 0 && idle.alarmInMs === null, 'idle room: no clock, no alarm')

const h4 = await connect(code6, 'Host4')
const g4 = await connect(code6, 'GuestC')
send(h4, { t: 'startReq' })
await sleep(600)
// Count first, then read the room: bundles keep arriving, so a count taken
// after the snapshot could legitimately exceed it and prove nothing.
const delivered = h4.bundles.length
const live = await jfetch(`/api/rooms/${code6}/state`)
check(live.started && live.ticking && live.players === 2, 'running room reports itself ticking')
check(live.tick > 0, `tick counter persisted and climbing (${live.tick})`)
check(live.alarmInMs !== null && live.alarmInMs <= 10_000, 'watchdog alarm armed')
// What the relay would resume from must never lag what clients already have:
// resuming behind them replays ticks they consumed and desyncs the room.
check(
  live.tick >= delivered && live.tick - delivered <= 5,
  `stored tick tracks bundles delivered (stored ${live.tick}, delivered ${delivered})`,
)

// Everyone leaving no longer ends a match on the spot: both tabs may be
// reloading, and the room holds their seats for the grace window.
h4.ws.close()
g4.ws.close()
await sleep(400)
const over = await jfetch(`/api/rooms/${code6}/state`)
check(!over.ticking && over.paused, 'an emptied room stops ticking and holds')
check(over.alarmInMs !== null, 'grace deadline armed for the players to come back')

// --- scenario 3.95: rejoin ---
// A dropped player holds the match rather than ending it, comes back on their
// own token, replays the orders they missed, and the room plays on. Then a
// player who does not come back is kicked so the rest are not held hostage.
console.log('scenario 3.95: drop → hold → rejoin → kick')
const { code: code7 } = await jfetch('/api/rooms', { method: 'POST' })
const p1 = await connect(code7, 'One')
const p2 = await connect(code7, 'Two')
const p3 = await connect(code7, 'Three')
check(Boolean(p2.token) && p2.token !== p1.token, 'each seat gets its own token')
send(p1, { t: 'startReq' })
await sleep(300)
// an order, so the replay log has something in it that must survive
send(p2, { t: 'cmd', c: { kind: 'move', units: [1], x: 5, z: 6 } })
await sleep(500)
const beforeDrop = await jfetch(`/api/rooms/${code7}/state`)
check(beforeDrop.logged > 0, `orders logged for replay (${beforeDrop.logged})`)

// p2 drops: the match must hold, not end
const tickAtDrop = beforeDrop.tick
p2.ws.close()
await sleep(500)
const held = await jfetch(`/api/rooms/${code7}/state`)
check(held.paused && held.missing.includes(p2.slot), 'room holds for the dropped player')
check(!held.ticking && !held.ended, 'clock stopped, match not ended')
check(p1.msgs.some((m) => m.t === 'paused' && m.slots.includes(p2.slot)), 'others told who is missing')
const tickWhileHeld = held.tick
await sleep(600)
check((await jfetch(`/api/rooms/${code7}/state`)).tick === tickWhileHeld, 'no ticks pass while held')

// p2 comes back on its token and replays from scratch, as a reloaded tab would
const p2b = await connect(code7, 'Two', { slot: p2.slot, token: p2.token })
check(p2b.slot === p2.slot && p2b.resumed, 'returning player gets its own seat back')
send(p2b, { t: 'resume', tick: 0 })
await sleep(400)
check(p2b.catchup !== null, 'backlog delivered')
check(p2b.catchup?.from === 0 && p2b.catchup?.to === tickWhileHeld, 'backlog covers the whole match so far')
check(
  p2b.catchup?.cmds.some(([, cmds]) => cmds.some((c) => c.kind === 'move' && c.player === p2.slot)),
  'the order issued before the drop is in the replay',
)
check(!p2b.catchup?.cmds.some(([t]) => t >= tickWhileHeld), 'backlog stops at the paused tick')
// still paused until the returning client says it is level
check((await jfetch(`/api/rooms/${code7}/state`)).paused, 'room stays held until the rejoiner is ready')
send(p2b, { t: 'ready' })
await sleep(500)
const resumed = await jfetch(`/api/rooms/${code7}/state`)
check(!resumed.paused && resumed.ticking, 'room resumes once everyone is level')
check(resumed.tick > tickWhileHeld, 'the clock moves again')
check(p1.msgs.some((m) => m.t === 'resumed'), 'everyone told the match is live again')
check(resumed.tick >= tickAtDrop, 'no ticks were lost across the hold')

// a stranger with the room code but not the seat token is turned away
check(await refused(code7, 'Thief', { slot: p2.slot, token: 'deadbeef' }), 'a wrong token cannot claim a seat')

// p3 drops and never returns: p1 kicks, and the match plays on
p3.ws.close()
await sleep(400)
check((await jfetch(`/api/rooms/${code7}/state`)).paused, 'held again for the second dropout')
send(p1, { t: 'kick', slot: p3.slot })
await sleep(500)
const kicked = await jfetch(`/api/rooms/${code7}/state`)
check(!kicked.paused && kicked.ticking, 'kick releases the match')
check(p1.msgs.some((m) => m.t === 'playerLeft' && m.slot === p3.slot), 'kicked player reported as left')
// and their seat is closed for good
check(await refused(code7, 'Three', { slot: p3.slot, token: p3.token }), 'a kicked player cannot come back')
p1.ws.close()
p2b.ws.close()
await sleep(300)

// --- static assets ---
console.log('scenario 4: static assets served')
const html = await (await fetch(BASE + '/')).text()
check(html.includes('BattleBadger'), 'index.html served by worker assets')

await sleep(100)
if (failures > 0) {
  console.error(`\n${failures} E2E check(s) FAILED`)
  process.exit(1)
}
console.log('\nall relay E2E checks passed')
process.exit(0)
