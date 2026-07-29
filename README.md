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
  it takes the ring with it; neutral settlements anyone can claim), **hordes** — the
  battalion is the unit of play: one purchase, one command-point charge, one selection, one
  XP track, with block/line/wedge/porcupine **formations** that trade speed for damage or
  toughness — and **veterancy** shared by hordes and heroes (a hero is a horde of one).
  Proven by `packages/sim/test/bfme.test.ts`.
- **Siege of Dunhollow (starter map)**: the BFME loop end to end — two fortresses with six
  plots each, farms that pay less when crowded, barracks/range/stable/siege-works selling
  battalions, a contested ridge with two ramps, five neutral settlements, and a captain hero.
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
- **Triggers**: GUI-less-but-GUI-ready event–condition–action JSON (mapInit, timers,
  unit-dies, unit-enters-region, resource-reached → spawn/order/victory/defeat/message/
  modify-resource/pan-camera/set-trigger), executed deterministically in the sim; messages
  and camera pans surface through a per-tick event log the client renders.
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
| `packages/relay` | Cloudflare Worker: static assets + `GameRoom` Durable Object (rooms, tick bundles, hash compare, forfeit, map transfer). |

## Develop

```sh
npm install
npm run dev:relay   # wrangler dev on :8788 (serves built client + API)
npm run dev         # vite on :5173, proxies /api → :8788
```

- Play: `http://localhost:5173` → pick a map, then Create room (start solo or with
  up to 8 players), Join room, or Practice. **Starter maps…** downloads maps from the
  server into your local library; **Import map…** adds a `.json` you were sent.
- Editor: `http://localhost:5173/#editor`.
- Economy demo map: `http://localhost:5173/?demo=econ` → Practice.

Controls (WC3 mnemonics): drag box-select · right-click move/harvest/rally · A attack-move ·
M move · S stop · H hold position · P patrol · ability hotkeys come from the GameDef and must
avoid the reserved A/M/S/H/P (heal is Q) · Ctrl+1–9 groups (double-tap centers) · double-click
selects type · selection-group slots: click picks that unit alone, Shift+click removes it,
Ctrl+click keeps only its type · touching one soldier selects his whole battalion, and
formation stances sit on the command card with their own hotkeys (Dunhollow: B block,
L line, O porcupine) · a selected build plot buys its structure straight off the card ·
F fullscreen · F10 menu ·
click captures mouse (Esc frees) · minimap: click pans, right-click orders.

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
npm run deploy      # vite build + wrangler deploy (client served by the worker)
```

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
map. Scale note: `MAX_UNITS` is 4096 and ~1800 soldiers in 200 hordes tick in ~20 ms against
the 100 ms budget, but `construction`, `income` crowding and the death cascade are still
O(n²) over entities and will need attention past that.

**Platform**: `.bbmap` zip packaging (assets outside the JSON) · cloud map gallery (R2) ·
trigger GUI builder (dropdowns over the same JSON) · flow-field pathfinding · fog of war
(render-side only, can't desync) · procedural model generators ported from MeekoQuest ·
replay viewer over command logs (a desync dump already IS a replay).
