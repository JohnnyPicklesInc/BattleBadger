# BattleBadger

Browser multiplayer RTS **platform** — deterministic lockstep, data-driven game rules, a
WC3-style world editor, three.js rendering, Cloudflare Workers hosting.

## What it is

- **Deterministic lockstep**: clients exchange only commands; every client runs an identical
  simulation. The Cloudflare Durable Object (`packages/relay`) is a dumb relay + metronome —
  it broadcasts a `TickBundle` every 100 ms and never runs the sim. It also streams custom
  maps host → guest (chunked, size-capped) and compares state hashes for desync detection.
- **Data-driven rules (GameDef)**: resources, units, buildings, doodads, abilities, harvesting,
  production, tech requirements, supply, power, passive income, damage/armor matrices, build
  plots, hordes/formations and veterancy are all JSON (`packages/sim/src/defs/`).
  One schema expresses all the classic economies — SC minerals+gas (exclusive patches,
  geyser + extractor), WC3 gold+lumber (workers vanish inside the mine, choppable trees
  that unblock pathing), C&C ore+power (big-carry harvester, power deficit halves production),
  AoE multi-resource dropoffs. Proven by `packages/sim/test/economy.test.ts`.
- **Determinism discipline**: f64 math restricted to bit-exact ops, seeded sfc32 PRNG, SoA
  typed arrays, fixed system order, integer economy. Enforced by `scripts/check-sim-purity.mjs`
  and a 2000-tick two-sim hash-equality suite. GameDef+map JSON folds into the state hash, so
  a def mismatch desyncs at tick 0 instead of drifting.
- **Maps (`RtsMapDoc` v2)**: WC3-style cliff tiers + ramps; walkability/heights derive from
  the doc via one shared function (`deriveTerrain`). Doodads (scenery + resource nodes),
  pre-placed entities, start locations, named regions, triggers, and embedded custom models.
- **BFME rules layer**: everything a Battle for Middle-earth style game needs on top of the
  classic RTS economies, all as GameDef data — **passive building income** with BFME's
  farm-crowding penalty (no harvesters at all), a **damage type × armor type matrix**
  (spears gut cavalry, catapults level walls and whiff on everything else), **build plots**
  (structures only go on pads; a fortress spawns its own ring of expansion slots and razing
  it takes the ring with it; neutral settlements anyone can claim), **outer bases** — sites
  out on the map you raise a whole new base on, sized by the map: an outpost worth three
  buildings, a camp worth six plus its own tower pads, or a castle site that takes a second
  fortress with the full ring. A site accepts a *kind* of base rather than a named building,
  so any faction claims any site with its own architecture — **hordes** — the
  battalion is the unit of play: one purchase, one command-point charge, one selection, one
  XP track, with block/line/wedge/porcupine **formations** that trade speed for damage or
  toughness — and **veterancy** shared by hordes and heroes (a hero is a horde of one).
  Proven by `packages/sim/test/bfme.test.ts`.
- **Siege of Dunhollow (starter map)**: the BFME loop end to end — two fortresses with a ring
  of plots each, farms that pay less when crowded, barracks/range/stable/siege-works selling
  battalions, a contested ridge with two ramps, ten neutral settlements, an outpost, camp and
  castle site per side to expand onto, and a captain hero. Mirrored across the diagonal, so
  both players get the same ground.
- **The War of the Ring (starter map)**: the StarCraft-era LOTR scenario, on the BFME rules
  layer. Eight realms on one 256² continent — Mordor behind its mountain walls in the
  south-east, Gondor across the Anduin to its left, Rohan's open horse country above, then
  Isengard, Moria, Lothlórien, Dol Guldur and Erebor up the north. Every realm owns **three
  muster camps** that produce a battalion wave on their own clock, forever, for free; you win
  by throwing down every camp the other team holds, and nothing else ends the match. A razed
  camp is **gone for good** — the map's production only ever falls. **Ages** pass on a global
  clock and thicken every wave at once (soldiers and archers → pikemen → horse → siege; the
  Shadow gets numbers and ogres instead), so there is no build order and no research. A camp
  holds its wave while its owner is at the **army cap** (700 entities), so a hoarded host
  starves its own production — spend it or stop growing. Waves
  are never ordered anywhere: they muster and wait, and the army is yours to command. Each
  realm's table is its own — Rohan fields horse an age early, Erebor never fields it, Moria
  swarms, Lothlórien is all Galadhrim archers. Slot order follows the fronts, so every lobby
  size is a real matchup: 1v1 is Gondor vs Mordor, 2v2 adds Rohan vs Isengard, and so on.
- **Cerebrate War (starter map)**: a full 3-lane MOBA built purely as map data — Cerebrates in
  opposite corners, three Bastion towers per lane, a Spire per lane whose fall swaps the
  enemy's creeps in that lane for elites (replace, not stack), tree-choked dead-end jungle
  pockets, waves that escalate on a clock (hunters at 3 min, menders at 6, ravagers at 10),
  and a damage/armor matrix that makes it play like a MOBA: tower fire shreds creeps but only
  dents Champions, creeps barely scratch structures, siege Ravagers are the real tower-killers.
  Each player summons a levelling Champion (a horde of one — XP off `hordeLevels`) at their
  Hatchery, which also pays passive Essence and sells mercenary hordes; re-summoning after
  death is the death penalty. 8 alternating slots, so it plays 1v1 through 4v4. Lanes are
  enforced by terrain, not waypoint triggers: they meet only at the bases, so A* has no
  shortcut and creeps stay in lane.
- **Races are per map**: a map lists the factions its lobby may seat (`races`, by module id).
  BFME is a two-race game — Badgers and the Horde — and that is what its maps offer. Ridge
  Crossing lists the Compact instead, the air faction it was built around. A map with no
  roster stays open to any faction whose rules fit, which is the right default for one
  authored without a lineup in mind; the editor's **Races the lobby may seat** picker sets it.
  A roster narrows what a lobby may swap in, never what the author placed on the ground.
- **Rejoin**: a player who drops does not lose the match. The room pauses, everyone else sees
  who it is waiting for and a countdown (45s) with a **Kick and play on** button, and the
  seat is held against a per-seat token. Coming back — a wifi blip, F5, a crash, a closed
  tab — replays the orders since tick 0 at full speed behind a progress bar, then the room
  resumes on the exact tick it stopped. Deterministic lockstep is what makes this cheap: the
  relay keeps the ORDERS (sparse — only ticks that carry any) and the client keeps the map,
  so nothing has to serialize a running sim.
- **Triggers**: GUI-less-but-GUI-ready event–condition–action JSON (mapInit, timers,
  unit-dies, unit-enters-region, resource-reached → spawn/order/victory/defeat/message/
  modify-resource/pan-camera/set-trigger), executed deterministically in the sim; messages
  and camera pans surface through a per-tick event log the client renders. `spawnUnits`
  spawns a **battalion** when handed a horde ticket — the same rule pre-placed armies follow —
  so a timed wave on a battalion map arrives formed up, with a veterancy track and a
  command-point cost, instead of as loose soldiers playing by different rules.
- **World editor** (`/#editor`): cliff raise/lower, ramp, texture painting, doodad/entity/
  start/region placement, erase, undo/redo, GameDef + trigger JSON panels, `.glb` model
  uploads (fallback to placeholders if broken), IndexedDB autosave, JSON export/import, and
  one-click **Playtest**. Exported maps can be hosted from the lobby — the map (rules,
  terrain, triggers, models) transfers to the guest through the relay.

## Packages

| Package | What |
|---|---|
| `packages/sim` | Deterministic core: GameDef schema/compiler, state, tick step, systems (orders, motion, combat, harvest, economy/income, hordes, triggers, victory), A* + string-pulling, spatial hash, map docs + terrain derivation, generators, wire protocol. Zero platform deps. |
| `packages/client` | Vite + three.js + PWA: terrain/cliff mesh, instanced units + doodads, WC3-style HUD (minimap, portrait, command card, resource/supply bar), pointer-lock mouse capture, control groups, build-ghost placement, lobby, editor. |
| `packages/relay` | Cloudflare Worker: static assets + `GameRoom` Durable Object (rooms, tick bundles, hash compare, forfeit, map transfer). Survives eviction: the tick counter is persisted per bundle and a watchdog alarm revives the metronome, because hibernatable sockets outlive the object's memory and a room that stops ticking freezes every client in it. `GET /api/rooms/<code>/state` reports whether a room is still ticking. |

## Develop

```sh
npm install
npm run dev:relay   # wrangler dev on :8788 (serves built client + API)
npm run dev         # vite on :5173, proxies /api → :8788
```

- Play: `http://localhost:5173` → pick a map, then Create room (start solo or with
  up to 8 players), Join room, or Practice. **Starter maps…** downloads maps from the
  server into your local library; **Import map…** adds a `.json` you were sent.
  In the room, every player picks their race, team and **start position** — click a base
  on the map shot (or the Start dropdown) and you trade places with whoever holds it.
  The host fills any empty seat with a **computer** (easy/normal/hard) and picks its race,
  team and base too; seats left Open are dropped from the map, so a 4-player map plays as a
  clean 1v1 instead of leaving two unmanned keeps standing. All of it — races, teams,
  positions, AI levels — is baked into the map bytes the host ships, so every client plays
  the same doc. (A heavily authored scenario like **The War of the Ring** lists no races: its
  realms are the map, so the lobby seats them rather than swapping them.)
- Editor: `http://localhost:5173/#editor`.
- Economy demo map: `http://localhost:5173/?demo=econ` → Practice.

Controls (WC3 mnemonics): drag box-select · right-click move/harvest/rally · A attack-move ·
M move · S stop · H hold position · P patrol · ability hotkeys come from the GameDef and must
avoid the reserved A/M/S/H/P (heal is Q) · Ctrl+1–9 groups (double-tap centers) · double-click
selects type · selection-group slots: click picks that unit alone, Shift+click removes it,
Ctrl+click keeps only its type · touching one soldier selects his whole battalion, and
formation stances sit on the command card with their own hotkeys (Dunhollow: B block,
L line, O porcupine) · a selected build plot buys its structure straight off the card ·
F fullscreen · F10 menu · F9 diagnostics ·
click captures mouse (Esc frees) · minimap: click or drag pans, right-click orders.

**When a match freezes**, F9 shows fps, sim tick, queued bundles, time since the last bundle
and entity count — and it appears on its own, with a banner naming the cause, whenever one of
the four goes wrong: the relay stopped sending ticks (everyone freezes), this machine cannot
simulate as fast as the match runs (one player freezes, queue climbing), an exception in the
frame loop (console has the error and the tick), or a desync. The console keeps a timeline:
`[bb]` lines mark when trouble started and when it cleared.

From outside, `curl /api/rooms/<code>/state` answers the same question for the room:
`{started, ended, tick, players, ticking, alarmInMs}`. A climbing `tick` means the relay is
healthy and the freeze belongs to a client; a stuck one with players still connected means the
room is. `[relay] room revived at tick N` in the Worker log means an eviction happened and was
repaired.

## Verify

```sh
npm test            # vitest: determinism, economy archetypes, BFME rules (income, armor matrix,
                    # plots, hordes, veterancy), production, triggers, terrain, A*, rng
npm run typecheck
npm run lint        # oxlint + sim purity guard
node scripts/e2e-relay.mjs   # scripted WS clients vs a running relay (incl. map transfer)
```

## Deploy

```sh
npm run bump        # 0.0.7 → 0.0.8: root package.json + packages/client/src/version.ts
npm run deploy      # vite build + wrangler deploy (client served by the worker)
```

Bump before every deploy. A lockstep match requires identical code on every client, and the
usual way that breaks is one player holding a cached build. Clients report their version when
they join a room; the lobby shows yours under the title and warns — in the room, before the
match — when somebody else is on a different one. The version also rides along in the desync
replay dump, so "were they even on the same build?" is answerable after the fact.

## Roadmap

**Toward a full BFME clone** (the rules layer above is in; these are the remaining pieces,
roughly in dependency order): horde **reinforcement** (buy losses back at the barracks) ·
**auras and status effects** (hero leadership, banner carriers, fear, burning) ·
**projectiles as entities** (arrow flight time, arcing catapult shots with impact AoE, fire
arrows that ignite) · **melee pairing, cavalry charge and crush** (collision that kills
rather than avoids) · **siege**: destruction states, garrisoned towers, walls with gates and
wall-top units (needs a second walkability layer) · the **spellbook** (player-scoped power
points, a tier-gated tree, map-targeted global spells) · **skirmish AI** (must run inside the
sim to stay deterministic) · **asymmetric factions** (one GameDef currently serves both
sides) · skinned/animated unit rendering at battalion scale · audio · campaign + Living World
map. Scale note: `MAX_UNITS` is 8192 (`MAX_HORDES` 2048) and **~5400 soldiers in 610 hordes
tick in ~13 ms** against the 100 ms budget — 8 realms of The War of the Ring at its 700-entity
army cap. Two fixes bought that: the spatial grid is a counting sort into flat typed arrays
rather than a `Map` of buckets (a 13-unit acquire radius spans ~200 cells, and every empty one
used to cost a hash lookup), and it is **partitioned by team**, so target acquisition asks only
the side that can answer instead of walking every friendly soldier in reach. Together those
took `acquireTargets` from 81% of the tick to 25%, and the same workload from 36 ms to 7 ms.
Scaling is near-linear now; `construction`, `income` crowding and the death cascade are still
O(n²) over entities and are the next things to hit.

**Platform**: `.bbmap` zip packaging (assets outside the JSON) · cloud map gallery (R2) ·
trigger GUI builder (dropdowns over the same JSON) · flow-field pathfinding · fog of war
(render-side only, can't desync) · procedural model generators ported from MeekoQuest ·
replay viewer over command logs (a desync dump already IS a replay).
