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

const connect = (code, name) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/rooms/${code}/ws?name=${name}`)
    const client = { ws, name, slot: -1, bundles: [], msgs: [], started: null }
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      client.msgs.push(m)
      if (m.t === 'joined') {
        client.slot = m.slot
        resolve(client)
      } else if (m.t === 'bundle') client.bundles.push(m)
      else if (m.t === 'start') client.started = m
    }
    ws.onerror = () => reject(new Error('ws error'))
    setTimeout(() => reject(new Error('join timeout')), 5000)
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

// --- scenario 2: forfeit on disconnect ---
console.log('scenario 2: forfeit on disconnect')
const { code: code2 } = await jfetch('/api/rooms', { method: 'POST' })
const c = await connect(code2, 'Carol')
const d = await connect(code2, 'Dave')
send(c, { t: 'startReq' })
await sleep(300)
d.ws.close()
await sleep(400)
const forfeit = c.msgs.find((m) => m.t === 'forfeit')
check(!!forfeit, 'forfeit received by survivor')
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
// one guest leaves → playerLeft but no forfeit (2 remain)
g1.ws.close()
await sleep(400)
check(h3.msgs.some((m) => m.t === 'playerLeft' && m.slot === 1), 'playerLeft broadcast')
check(!h3.msgs.some((m) => m.t === 'forfeit'), 'no forfeit while 2 remain')
// second guest leaves → forfeit for the survivor
g2.ws.close()
await sleep(400)
const ff = h3.msgs.find((m) => m.t === 'forfeit')
check(ff && ff.winner === 0, 'last player standing gets the forfeit win')
h3.ws.close()

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
