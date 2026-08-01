import { describe, expect, it } from 'vitest'
import { GateMode, findPath, handleOf, setupMatch, spawnUnit, step, validateGameDef, walkGridFromDoc } from '@battlebadger/sim'
import { generateLastAlliance } from '../src/mapgen/lastAlliance.ts'

// The siege map. What has to be true for it to be a siege rather than a field
// battle with scenery: the wall genuinely seals, the gate is genuinely the way
// through, and an army sent at a shut gate goes and breaks it.

const doc = generateLastAlliance()
const grid = (): ReturnType<typeof walkGridFromDoc> => walkGridFromDoc(doc)

// Derived from the map rather than written down, so re-proportioning the
// fortress does not quietly turn these into assertions about empty ground.
const westGate = (doc.placed ?? []).find((p) => p.def === 'gate' && p.x < doc.cols / 2)!
const GATE_Z = Math.floor(westGate.z)
const FRONT_X = Math.floor(westGate.x)
// Open ground just inside the west gate. Deliberately NOT a start location: a
// start location sits inside its keep's own footprint, so pathing to it always
// fails and would make every seal test pass for the wrong reason.
const WEST_COURTYARD: [number, number] = [FRONT_X - 12, GATE_Z]
const FIELD: [number, number] = [Math.floor(doc.cols / 2), GATE_Z]

describe('the map is well formed', () => {
  it('seats eight players on two teams', () => {
    expect(doc.startLocations).toHaveLength(8)
    expect(doc.slotTeams).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
    // West starts on the left half, east on the right — allies together, which
    // is the one arrangement a two-fortress map cannot do without.
    for (let i = 0; i < 4; i++) expect(doc.startLocations[i].x, `slot ${i}`).toBeLessThan(doc.cols / 2)
    for (let i = 4; i < 8; i++) expect(doc.startLocations[i].x, `slot ${i}`).toBeGreaterThan(doc.cols / 2)
  })

  it('has valid rules, including the fortification module', () => {
    expect(validateGameDef(doc.gameDef!)).toEqual([])
    const ids = new Set(doc.gameDef!.entities.map((e) => e.id))
    for (const id of ['wall', 'gate', 'sally-port', 'wall-tower', 'siege-emplacement', 'wall-catapult']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('gives each fortress a gate, sally ports and empty siege emplacements', () => {
    const count = (def: string): number => (doc.placed ?? []).filter((p) => p.def === def).length
    expect(count('gate')).toBe(2) // one per fortress
    expect(count('sally-port')).toBe(4)
    expect(count('siege-emplacement')).toBe(12)
    expect(count('wall')).toBeGreaterThan(60)
    // The emplacements start EMPTY: the slot is the map's, the engine is the
    // player's decision.
    expect(count('wall-catapult')).toBe(0)
  })

  it('keeps the fortress standing even when its slots are empty', () => {
    // A 2-player game on an 8-slot map must not dissolve six players' masonry.
    const masonry = (doc.placed ?? []).filter((p) => ['wall', 'gate', 'wall-tower', 'sally-port'].includes(p.def))
    expect(masonry.every((p) => p.always === true)).toBe(true)
  })
})

describe('the wall is a wall', () => {
  it('seals: with the gates shut there is no way in from the field', () => {
    const g = grid()
    setupMatch(doc, g, 8)
    expect(findPath(g, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true)).toBeNull()
    // ...and the same is true of the east fortress, which is the mirror.
    expect(findPath(g, FIELD[0], FIELD[1], doc.cols - 1 - WEST_COURTYARD[0], GATE_Z, true)).toBeNull()
  })

  it('has no way round the back either', () => {
    // The bug this caught: the north and south walls stopped at the fortress
    // box rather than the map edge, leaving a lane behind them wide enough to
    // walk an army through, which made the gate decoration.
    const g = grid()
    setupMatch(doc, g, 8)
    for (const z of [20, doc.rows - 20]) {
      expect(findPath(g, FIELD[0], z, WEST_COURTYARD[0], WEST_COURTYARD[1], true), `round the z=${z} edge`).toBeNull()
    }
  })

  it('and the seal is the masonry, not the terrain', () => {
    // If the wall were decorative over a cliff, removing it would change
    // nothing and the gate would be pointless.
    const bare = walkGridFromDoc(doc) // no buildings spawned
    expect(findPath(bare, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true)).not.toBeNull()
  })
})

describe('a great gate is worked by hand', () => {
  it('starts barred, and ignores troops walking up to it', () => {
    // The difference from a sally port: a great gate is a decision. Opening the
    // front of your fortress because somebody wandered near it is not one.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    expect(s.gateMode[gateIdx]).toBe(GateMode.Shut)
    spawn(s, g, 'swordsman', 0, s.posX[gateIdx] - 3, s.posZ[gateIdx])
    for (let t = 0; t < 20; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx]).toBe(0)
  })

  it('opens and shuts on command, and an ally may work it too', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    const cmd = (player: number, mode: number): void => {
      step(s, g, [{ kind: 'gate', player, units: [handleOf(s, gateIdx)], x: 0, z: 0, def: mode }])
    }
    cmd(0, GateMode.Open)
    expect(s.gateOpen[gateIdx]).toBe(1)
    // ...and the way in is genuinely open, not just a flag
    expect(findPath(g, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true)).not.toBeNull()

    // slot 3 shares the fortress but does not own the masonry
    cmd(3, GateMode.Shut)
    expect(s.gateOpen[gateIdx]).toBe(0)
    expect(findPath(g, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true)).toBeNull()
  })

  it('will not be worked by the enemy', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    step(s, g, [{ kind: 'gate', player: 4, units: [handleOf(s, gateIdx)], x: 0, z: 0, def: GateMode.Open }])
    expect(s.gateMode[gateIdx]).toBe(GateMode.Shut)
    expect(s.gateOpen[gateIdx]).toBe(0)
  })

  it('can be put on the sensor by a team that wants it there', () => {
    // Manual is the STARTING mode, not a permanent property — a team defending
    // a quiet flank should be able to stop babysitting the door.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    step(s, g, [{ kind: 'gate', player: 0, units: [handleOf(s, gateIdx)], x: 0, z: 0, def: GateMode.Auto }])
    spawn(s, g, 'swordsman', 0, s.posX[gateIdx] - 3, s.posZ[gateIdx])
    for (let t = 0; t < 5; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx]).toBe(1)
  })
})

describe('a sally port is automatic', () => {
  it('a garrison walking out opens the gate, and it shuts behind them', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findPort(s, 0)
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(s.gateMode[gateIdx]).toBe(GateMode.Auto)
    expect(s.gateOpen[gateIdx]).toBe(0) // nobody near it yet

    // March the west garrison at its own gate.
    const mine = unitsOf(s, 0)
    expect(mine.length).toBeGreaterThan(0)
    order(s, g, mine, s.posX[gateIdx] + 3, s.posZ[gateIdx])
    for (let t = 0; t < 400 && s.gateOpen[gateIdx] === 0; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx], 'friendly approach should open it').toBe(1)

    // Send them back inside and it closes again.
    order(s, g, mine, s.posX[gateIdx] - 30, s.posZ[gateIdx])
    for (let t = 0; t < 600 && s.gateOpen[gateIdx] === 1; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx], 'it should bar itself once they are away').toBe(0)
  })

  it('opens for an ALLY, not just for the slot that owns the masonry', () => {
    // Four players share each fortress and the walls belong to one of them.
    // A postern that only its owner could use would strand the other three.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findPort(s, 0)
    expect(s.owner[gateIdx]).toBe(0)
    spawn(s, g, 'swordsman', 3, s.posX[gateIdx] - 3, s.posZ[gateIdx]) // slot 3, same team
    for (let t = 0; t < 5; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx]).toBe(1)
  })

  it('an enemy at the port keeps it shut, even with defenders right there', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findPort(s, 0)
    const gx = s.posX[gateIdx]
    const gz = s.posZ[gateIdx]
    // A defender inside and an attacker outside, both within the open radius.
    spawn(s, g, 'swordsman', 0, gx - 3, gz)
    spawn(s, g, 'orc', 4, gx + 3, gz)
    for (let t = 0; t < 5; t++) step(s, g, [])
    expect(s.gateOpen[gateIdx]).toBe(0)
  })
})

describe('the battlements are usable', () => {
  it('the siege emplacements survive, and are empty plots waiting for an engine', () => {
    // The bug: hp 0 means "indestructible" for a doodad but "already dead" for
    // a building, so deaths() reaped all twelve on the first tick and the walls
    // had nowhere to put a catapult.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    for (let t = 0; t < 30; t++) step(s, g, [])
    const type = s.def.entIndex.get('siege-emplacement')!
    let alive = 0
    let free = 0
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.type[i] !== type) continue
      alive++
      if (s.plotHost[i] < 0) free++
    }
    expect(alive).toBe(12)
    expect(free, 'they start empty — the engine is the player\'s decision').toBe(12)
  })

  it('accepts a catapult, and every player sharing the fortress may crew one', () => {
    const emp = doc.gameDef!.entities.find((e) => e.id === 'siege-emplacement')!
    expect(emp.plot!.accepts).toContain('wall-catapult')
    expect(doc.gameDef!.entities.find((e) => e.id === 'wall-catapult')!.placement).toBe('plot')
    // The emplacements belong to the team's lowest slot, and plots are open to
    // allies — otherwise three of the four players in each fortress could not
    // touch their own battlements.
    const owners = new Set((doc.placed ?? []).filter((p) => p.def === 'siege-emplacement').map((p) => p.owner))
    expect([...owners].sort()).toEqual([0, 4])
    expect(doc.slotTeams![1]).toBe(doc.slotTeams![0])
  })
})

describe('every player gets the same base', () => {
  it('deals each of the eight an identical block of plots and pads', () => {
    // Four keeps share one enclosure, so their expansion rings would overlap
    // and the guard that drops a colliding pad handed one ally twelve plots
    // and another nine. The plots are authored instead, in per-player lanes.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const own: Record<number, Record<string, number>> = {}
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i]) continue
      const id = s.def.entities[s.type[i]].id
      if (!id.endsWith('-plot')) continue
      own[s.owner[i]] ??= {}
      own[s.owner[i]][id] = (own[s.owner[i]][id] ?? 0) + 1
    }
    // Slots 1..3 and 5..7 hold nothing but their own lane; the team's lowest
    // slot additionally holds the shared courtyard and battlement pads.
    const OWN_PLOTS = 8
    const OWN_PADS = 8
    for (const slot of [1, 2, 3]) {
      expect(own[slot], `slot ${slot}`).toEqual({ 'fortress-plot': OWN_PLOTS, 'tower-plot': OWN_PADS })
    }
    for (const slot of [5, 6, 7]) {
      expect(own[slot], `slot ${slot}`).toEqual({ 'horde-plot': OWN_PLOTS, 'tower-plot': OWN_PADS })
    }
    // The team's lowest slot additionally holds the shared ground, and holds
    // exactly as much of it as its opposite number does.
    expect(own[0]['fortress-plot']).toBeGreaterThan(OWN_PLOTS)
    expect(own[0]['fortress-plot']).toBe(own[4]['horde-plot'])
    expect(own[0]['tower-plot']).toBe(own[4]['tower-plot'])
  })

  it('gives each side its own faction\'s plots, not the other\'s', () => {
    // The shared courtyard plots were hardcoded to the badger pad, which would
    // have offered the Horde a barracks and a stable.
    const west = (doc.placed ?? []).filter((p) => p.def === 'fortress-plot')
    const east = (doc.placed ?? []).filter((p) => p.def === 'horde-plot')
    expect(west.length).toBe(east.length)
    expect(west.every((p) => p.x < doc.cols / 2)).toBe(true)
    expect(east.every((p) => p.x > doc.cols / 2)).toBe(true)
  })

  it('puts tower pads outside the wall as well as behind it', () => {
    const pads = (doc.placed ?? []).filter((p) => p.def === 'tower-plot')
    const outside = pads.filter((p) => p.x > FRONT_X && p.x < doc.cols / 2)
    expect(outside.length, 'forward pads on the gate approach').toBeGreaterThan(0)
    // ...and they only take a tower, so the outer ring is defence not economy
    expect(doc.gameDef!.entities.find((e) => e.id === 'tower-plot')!.plot!.accepts).toEqual(['watchtower'])
  })

  it('every authored plot actually has somewhere to stand', () => {
    // spawnBuilding now skips an expansion slot that lands in a cliff or on a
    // neighbour. A plot the map placed by hand should never need that.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const authored = (doc.placed ?? []).filter((p) => p.def.endsWith('-plot')).length
    let alive = 0
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.def.entities[s.type[i]].id.endsWith('-plot')) alive++
    }
    expect(alive).toBe(authored)
  })
})

describe('the masonry is oriented', () => {
  // A section belongs to the front run if it stands on the front column — the
  // one the gates stand in. The corners sit there too, so classifying by z
  // would mislabel them.
  const FRONT_COLUMNS = (doc.placed ?? []).filter((p) => p.def === 'gate').map((p) => p.x)
  const onFront = (x: number): boolean => FRONT_COLUMNS.some((c) => Math.abs(x - c) < 0.01)

  it('side walls run east-west and the front wall runs north-south', () => {
    // Without a facing every section pointed the same way, so one of the two
    // runs rendered as a row of loose blocks lying across the wall line.
    const walls = (doc.placed ?? []).filter((p) => p.def === 'wall')
    const front = walls.filter((p) => onFront(p.x))
    const sides = walls.filter((p) => !onFront(p.x))
    expect(sides.length).toBeGreaterThan(20)
    expect(front.length).toBeGreaterThan(20)
    for (const w of sides) expect(w.facing, `side wall at ${w.x},${w.z}`).toEqual({ x: 0, z: 1 })
    for (const w of front) expect(w.facing, `front wall at ${w.x},${w.z}`).toEqual({ x: 1, z: 0 })
  })

  it('a placed facing actually reaches the entity', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const type = s.def.entIndex.get('wall')!
    let checked = 0
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.type[i] !== type || onFront(s.posX[i])) continue
      expect(s.faceZ[i], `wall at ${s.posX[i]},${s.posZ[i]}`).toBeCloseTo(1)
      expect(s.faceX[i]).toBeCloseTo(0)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('a shut gate is something to break', () => {
  it('an army ordered into the fortress marches to the gate and attacks it', () => {
    // This is the behaviour the A* fallback exists for. Ordered at ground it
    // cannot reach, an army must close on the obstacle rather than stand still.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    const hp0 = s.hp[gateIdx]

    const attackers: number[] = []
    for (let k = 0; k < 12; k++) {
      attackers.push(spawn(s, g, 'orc', 4, s.posX[gateIdx] + 26, s.posZ[gateIdx] - 6 + k))
    }
    // Aim at the courtyard — inside, sealed, unreachable while the gate holds.
    order(s, g, attackers, WEST_COURTYARD[0], WEST_COURTYARD[1], 'attackMove')

    let closed = false
    for (let t = 0; t < 900; t++) {
      step(s, g, [])
      const d = Math.abs(s.posX[attackers[0]] - s.posX[gateIdx])
      if (d < 8) closed = true
      if (s.hp[gateIdx] < hp0) break
    }
    expect(closed, 'they should march up to the gate').toBe(true)
    expect(s.hp[gateIdx], 'and start breaking it down').toBeLessThan(hp0)
  })

  it('breaking the gate opens the way in', () => {
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    expect(findPath(g, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true)).toBeNull()

    s.hp[gateIdx] = 0
    step(s, g, []) // deaths() frees the footprint
    expect(s.alive[gateIdx]).toBe(0)
    expect(
      findPath(g, FIELD[0], FIELD[1], WEST_COURTYARD[0], WEST_COURTYARD[1], true),
      'the breach is a way in',
    ).not.toBeNull()
  })

  it('and the courtyard is not the fortress — the citadel is still above you', () => {
    // Losing the wall must not lose the map. The ramps are the next fight.
    const g = grid()
    const s = setupMatch(doc, g, 8)
    const gateIdx = findGate(s, 0)
    s.hp[gateIdx] = 0
    step(s, g, [])
    const CITADEL: [number, number] = [22, GATE_Z]
    expect(findPath(g, FIELD[0], FIELD[1], CITADEL[0], CITADEL[1], true), 'reachable at all').not.toBeNull()

    // ...but only the long way round. Measured against the straight line rather
    // than a fixed length, so the assertion survives the fortress being
    // re-proportioned: a clear run would cost about one cell per step, and the
    // ramps make it cost half as much again.
    const direct = findPath(g, WEST_COURTYARD[0], WEST_COURTYARD[1], CITADEL[0], CITADEL[1], true)!
    const straight = Math.max(
      Math.abs(WEST_COURTYARD[0] - CITADEL[0]),
      Math.abs(WEST_COURTYARD[1] - CITADEL[1]),
    )
    expect(direct.length / straight, 'the ward should force a detour').toBeGreaterThan(1.25)
  })
})

// ---- helpers ----------------------------------------------------------

type S = ReturnType<typeof setupMatch>
type G = ReturnType<typeof walkGridFromDoc>

function byDef(s: S, def: string, owner: number): number {
  const type = s.def.entIndex.get(def)!
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.type[i] === type && s.owner[i] === owner) return i
  return -1
}
const findGate = (s: S, owner: number): number => byDef(s, 'gate', owner)
const findPort = (s: S, owner: number): number => byDef(s, 'sally-port', owner)

function unitsOf(s: S, owner: number): number[] {
  const out: number[] = []
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === owner && s.kind[i] === 0) out.push(i)
  return out
}

function spawn(s: S, _g: G, def: string, owner: number, x: number, z: number): number {
  return spawnUnit(s, s.def.entIndex.get(def)!, owner, x, z)
}

function order(s: S, g: G, ids: number[], x: number, z: number, kind: 'move' | 'attackMove' = 'move'): void {
  step(s, g, [{ kind, player: s.owner[ids[0]], units: ids.map((i) => handleOf(s, i)), x, z }])
}
