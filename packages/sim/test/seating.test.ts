import { describe, expect, it } from 'vitest'
import {
  BUILTIN_RULESETS,
  defaultFactionName,
  factionStartArmy,
  mapContentHash,
  resolveStartOrder,
  seatPlayers,
  seatingProblems,
  setupMatch,
  stateHash,
  slotKeep,
  validateGameDef,
  walkGridFromDoc,
  type RulesetModule,
} from '@battlebadger/sim'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'
import { generateMap } from '../src/mapgen/simpleMap.ts'

// Seating rewrites the map before the match: it must move a player's race
// without disturbing anyone else's start, and must never hand the sim a doc
// that fails to compile.

const factionOf = (id: string): RulesetModule =>
  BUILTIN_RULESETS.find((p) => p.id === id)!.modules.find((m) => m.keep !== undefined)!

const BADGERS = factionOf('badgers')
const HORDE = factionOf('horde')
const COMPACT = factionOf('compact')

const doc = (): ReturnType<typeof generateFourCorners> => generateFourCorners(1234)

describe('slot inspection', () => {
  it('reads the faction a map seats a slot as', () => {
    const d = doc()
    // four-corners alternates badgers and horde around the plaza
    expect(slotKeep(d, 0)).toBe(BADGERS.keep)
    expect(defaultFactionName(d, 0, [BADGERS, HORDE])).toBe('Badgers')
    expect(defaultFactionName(d, 1, [BADGERS, HORDE])).toBe('The Horde')
  })

  it('offers the shipped factions on a BFME map and refuses content packs', () => {
    const d = doc()
    for (const m of [BADGERS, HORDE, COMPACT]) expect(seatingProblems(d, m), m.name).toEqual([])
    const pack: RulesetModule = { id: 'x', name: 'Scenery', entities: BADGERS.entities.slice(0, 1) }
    expect(seatingProblems(d, pack)[0]).toMatch(/content pack/)
  })

  it('falls back to a faction’s own battalions when it names no muster', () => {
    const { startArmy: _drop, ...noMuster } = HORDE
    expect(factionStartArmy(noMuster).length).toBeGreaterThan(0)
    expect(factionStartArmy(HORDE)).toEqual(HORDE.startArmy)
  })
})

describe('the lobby’s generated map', () => {
  // The generated map is what the lobby opens on, so if race choice is dead
  // there it is dead for most players. It seats a fortress per side precisely
  // so the pickers work.
  it('offers every shipped faction and seats it', () => {
    const valley = generateMap(2026)
    expect(slotKeep(valley, 0)).toBe(BADGERS.keep)
    for (const m of [BADGERS, HORDE, COMPACT]) expect(seatingProblems(valley, m), m.name).toEqual([])

    const seated = seatPlayers(valley, [{ faction: HORDE, team: 0 }, { faction: COMPACT, team: 1 }]).doc
    expect(slotKeep(seated, 0)).toBe(HORDE.keep)
    expect(slotKeep(seated, 1)).toBe(COMPACT.keep)
    const s = setupMatch(seated, walkGridFromDoc(seated), 2)
    const fielded = (slot: number): string[] => {
      const out = new Set<string>()
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot) out.add(s.def.entities[s.type[i]].id)
      return [...out]
    }
    // each side fields its own faction's content and none of the other's
    expect(fielded(0)).toContain(HORDE.keep)
    expect(fielded(1)).toContain(COMPACT.keep)
    expect(fielded(0)).not.toContain(BADGERS.keep)
  })

  it('gives both sides the same opening, so a mirror stays a mirror', () => {
    const valley = generateMap(77)
    // Neutral content is parked on slot 0 by convention, so compare the kit
    // each side is actually given.
    const kit = (slot: number): string[] =>
      (valley.placed ?? []).filter((p) => p.owner === slot && p.def !== 'settlement').map((p) => p.def)
    expect(kit(1)).toEqual(kit(0))
    expect(kit(0)).toContain(BADGERS.keep)
  })
})

describe('seatPlayers', () => {
  it('swaps one slot to another race and leaves every other slot alone', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ faction: HORDE }])

    const mine = (d: typeof before, slot: number): string[] =>
      (d.placed ?? []).filter((p) => p.owner === slot).map((p) => p.def)

    // slot 0 now fields the Horde: its keep and its battalions
    expect(mine(after, 0)).not.toEqual(mine(before, 0))
    expect(mine(after, 0)).toContain(HORDE.keep)
    expect(mine(after, 0)).not.toContain(BADGERS.keep)
    for (const slot of [1, 2, 3]) expect(mine(after, slot)).toEqual(mine(before, slot))
    // and the input is untouched
    expect(mine(before, 0)).toContain(BADGERS.keep)
  })

  it('keeps every authored start position — only the defs change', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ faction: COMPACT }])
    const pos = (d: typeof before): string[] =>
      (d.placed ?? []).map((p) => `${p.owner}@${p.x},${p.z}`)
    expect(pos(after)).toEqual(pos(before))
  })

  it('is a no-op when a slot picks the faction the map already seats', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ faction: BADGERS }])
    expect(after).toBe(before)
  })

  it('writes teams without touching armies', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ team: 0 }, { team: 1 }, { team: 0 }, { team: 1 }])
    expect(after.slotTeams).toEqual([0, 1, 0, 1])
    expect(after.placed).toEqual(before.placed)
  })

  it('installs the seated faction’s rules, research and models', () => {
    const before = doc()
    // four-corners seats badgers + horde, so the Compact is genuinely new content
    const { doc: after } = seatPlayers(before, [{ faction: COMPACT }])
    const ids = new Set((after.gameDef?.entities ?? []).map((e) => e.id))
    for (const e of COMPACT.entities) expect(ids.has(e.id), e.id).toBe(true)
    for (const bp of COMPACT.blueprints ?? []) {
      expect((after.blueprints ?? []).some((b) => b.id === bp.id), bp.id).toBe(true)
    }
    expect(validateGameDef(after.gameDef!)).toEqual([])
  })

  it('produces a doc the sim actually starts', () => {
    const seated = seatPlayers(doc(), [
      { faction: COMPACT, team: 0 },
      { faction: HORDE, team: 1 },
      { faction: HORDE, team: 0 },
      { faction: BADGERS, team: 1 },
    ]).doc
    const s = setupMatch(seated, walkGridFromDoc(seated), 4)
    expect(s.count).toBeGreaterThan(0)
    expect(Array.from(s.playerTeam.slice(0, 4))).toEqual([0, 1, 0, 1])
    // every seated slot fielded something
    for (const slot of [0, 1, 2, 3]) {
      let own = 0
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot) own++
      expect(own, `slot ${slot}`).toBeGreaterThan(0)
    }
  })

  it('survives the transfer to a guest byte for byte', () => {
    // The host bakes the seating and ships the result; the guest plays the
    // JSON it received. If those two states differ at all they desync at the
    // first hash, so this is the check that matters most about seating.
    const host = seatPlayers(doc(), [{ faction: COMPACT, team: 0 }, { faction: HORDE, team: 1 }]).doc
    const guest = JSON.parse(JSON.stringify(host)) as typeof host
    expect(mapContentHash(guest)).toBe(mapContentHash(host))
    const a = setupMatch(host, walkGridFromDoc(host), 4)
    const b = setupMatch(guest, walkGridFromDoc(guest), 4)
    expect(stateHash(b)).toBe(stateHash(a))
  })

  it('changes the map hash, so a client on the unseated doc cannot join quietly', () => {
    const before = doc()
    const after = seatPlayers(before, [{ faction: HORDE }]).doc
    expect(mapContentHash(after)).not.toBe(mapContentHash(before))
  })

  it('refuses a faction whose rules do not fit and keeps the map as authored', () => {
    const before = doc()
    const alien: RulesetModule = {
      ...HORDE,
      id: 'alien',
      name: 'Alien',
      entities: HORDE.entities.map((e) =>
        e.combat ? { ...e, combat: { ...e.combat, damageType: 'plasma' } } : e,
      ),
    }
    const { doc: after, notes } = seatPlayers(before, [{ faction: alien }])
    expect(after).toBe(before)
    expect(notes.join(' ')).toMatch(/damage type "plasma"/)
  })
})

describe('start positions', () => {
  it('settles picks into a permutation, whatever the lobby sends', () => {
    // plain swap
    expect(resolveStartOrder([{ start: 1 }, { start: 0 }], 2)).toEqual([1, 0])
    // one player moves; the slot they displaced takes the base they left
    expect(resolveStartOrder([{}, { start: 0 }, {}, {}], 4)).toEqual([1, 0, 2, 3])
    // a repeat, an out-of-range pick and junk are all dropped rather than
    // trusted — this arrives over the wire from another client
    // slot 1's repeat and slot 2's nonsense are dropped: 1 keeps its own base,
    // 2 cannot (slot 0 took it) and falls to the lowest free one
    expect(resolveStartOrder([{ start: 2 }, { start: 2 }, { start: 9 }, { start: -1 }], 4)).toEqual([2, 1, 0, 3])
    expect(resolveStartOrder([{ start: 1.5 }], 2)).toEqual([0, 1])
    // nobody asked: the map's own order
    expect(resolveStartOrder([{}, {}, {}, {}], 4)).toEqual([0, 1, 2, 3])
  })

  it('moves a player’s whole base to the position they picked', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ start: 1 }, { start: 0 }])

    const kit = (d: typeof before, slot: number): string[] =>
      (d.placed ?? []).filter((p) => p.owner === slot).map((p) => `${p.def}@${p.x},${p.z}`)
    // slot 0 now fields what stood on start 1, and vice versa
    expect(kit(after, 0)).toEqual(kit(before, 1))
    expect(kit(after, 1)).toEqual(kit(before, 0))
    // slot N's start location IS start N again — the rest of the engine (fog,
    // camera, minimap) reads it that way and must not have to learn otherwise
    expect(after.startLocations[0]).toEqual(before.startLocations[1])
    expect(after.startLocations[1]).toEqual(before.startLocations[0])
    for (const slot of [2, 3]) expect(kit(after, slot)).toEqual(kit(before, slot))
    expect(kit(before, 0)).toContain(`${BADGERS.keep}@34,34`)
  })

  it('carries the position’s team and AI level with it', () => {
    const before = { ...doc(), slotTeams: [0, 1, 0, 1], aiLevels: [0, 2, 3, 0] }
    const { doc: after } = seatPlayers(before, [{ start: 3 }])
    // slot 0 took start 3, so start 3's owner (slot 3) took start 0
    expect(after.slotTeams).toEqual([1, 1, 0, 0])
    expect(after.aiLevels).toEqual([0, 2, 3, 0])
  })

  it('relabels the slot numbers scripted triggers name', () => {
    const before = {
      ...doc(),
      triggers: [
        {
          id: 't',
          name: 'ambush',
          events: [{ type: 'unitDies' as const, owner: 1 }],
          conditions: [{ type: 'resourceCmp' as const, owner: 1, resource: 'gold', op: '>=' as const, amount: 5 }],
          actions: [
            { type: 'spawnUnits' as const, def: 'h-orcs', owner: 1, count: 2, at: { x: 1, z: 1 } },
            { type: 'message' as const, text: 'hi', to: 1 },
            { type: 'victory' as const, player: 1 },
          ],
        },
      ],
    }
    const { doc: after } = seatPlayers(before, [{ start: 1 }])
    const t = after.triggers![0]
    // slot 1 was pushed onto start 0, so everything the map said about "the
    // player on start 1" now names slot 0
    expect(t.events[0]).toMatchObject({ owner: 0 })
    expect(t.conditions[0]).toMatchObject({ owner: 0 })
    expect(t.actions[0]).toMatchObject({ owner: 0 })
    expect(t.actions[1]).toMatchObject({ to: 0 })
    expect(t.actions[2]).toMatchObject({ player: 0 })
    // and the trigger the map ships is untouched
    expect(before.triggers[0].actions[2].player).toBe(1)
  })

  it('combines with a race pick: the mover’s new base is their own race', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [{ start: 1, faction: COMPACT }, { start: 0 }])
    expect(slotKeep(after, 0)).toBe(COMPACT.keep)
    // the Compact keep stands on the ground slot 0 moved to
    const keep = (after.placed ?? []).find((p) => p.def === COMPACT.keep)!
    expect({ x: keep.x, z: keep.z }).toEqual(before.startLocations[1])
    expect(keep.owner).toBe(0)
    expect(validateGameDef(after.gameDef!)).toEqual([])
  })

  it('starts a match where every slot owns the base it chose', () => {
    const before = doc()
    const host = seatPlayers(before, [{ start: 2 }, { start: 3 }, { start: 0 }, { start: 1 }]).doc
    const guest = JSON.parse(JSON.stringify(host)) as typeof host
    expect(mapContentHash(guest)).toBe(mapContentHash(host))
    const s = setupMatch(host, walkGridFromDoc(host), 4)
    expect(stateHash(setupMatch(guest, walkGridFromDoc(guest), 4))).toBe(stateHash(s))
    for (const slot of [0, 1, 2, 3]) {
      const start = host.startLocations[slot]
      let near = 0
      for (let i = 0; i < s.count; i++) {
        if (!s.alive[i] || s.owner[i] !== slot) continue
        if (Math.abs(s.posX[i] - start.x) < 40 && Math.abs(s.posZ[i] - start.z) < 40) near++
      }
      expect(near, `slot ${slot} musters at its own start`).toBeGreaterThan(0)
    }
  })

  it('leaves the map alone when nobody moves', () => {
    const before = doc()
    expect(seatPlayers(before, [{ start: 0 }, { start: 1 }]).doc).toBe(before)
  })
})

describe('computers and empty seats', () => {
  it('writes the lobby’s AI levels onto the doc, so every client agrees', () => {
    const before = doc()
    const { doc: after, notes } = seatPlayers(before, [{}, { ai: 2 }, { ai: 3 }, { ai: 0 }])
    // aiLevel is hashed sim state — it has to travel as map bytes rather than
    // as something each client works out for itself
    expect(after.aiLevels).toEqual([0, 2, 3, 0])
    expect(before.aiLevels).toBeUndefined()
    expect(notes.join(' ')).toMatch(/slot 2 is a computer/)
    const s = setupMatch(after, walkGridFromDoc(after), 4)
    expect(mapContentHash(JSON.parse(JSON.stringify(after)))).toBe(mapContentHash(after))
    expect(s.count).toBeGreaterThan(0)
  })

  it('clamps a nonsense level and keeps the map’s own where the lobby is silent', () => {
    const before = { ...doc(), aiLevels: [0, 0, 3, 0] }
    const { doc: after } = seatPlayers(before, [{ ai: 9 }, { ai: -4 }, {}, {}])
    expect(after.aiLevels).toEqual([3, 0, 3, 0])
  })

  it('leaves empty ground where nobody is playing', () => {
    const before = doc()
    const owners = (d: typeof before): number[] => [...new Set((d.placed ?? []).map((p) => p.owner))].sort()
    expect(owners(before)).toContain(2)

    // two humans on a four-slot map: slots 2 and 3 are nobody's
    const { doc: after } = seatPlayers(before, [
      { active: true },
      { active: true },
      { active: false },
      { active: false },
    ])
    expect(owners(after)).toEqual([0, 1])
    // and a base with nobody home never stood there to be farmed for kills
    const s = setupMatch(after, walkGridFromDoc(after), 4)
    for (let i = 0; i < s.count; i++) if (s.alive[i]) expect(s.owner[i]).toBeLessThan(2)
  })

  it('keeps `always` content on an empty slot — that is how a map seats creeps', () => {
    const before = doc()
    const placed = [...(before.placed ?? []), { def: 'h-orcs', owner: 3, x: 90, z: 90, always: true }]
    const { doc: after } = seatPlayers({ ...before, placed }, [{}, {}, { active: false }, { active: false }])
    expect((after.placed ?? []).some((p) => p.owner === 3 && p.always === true)).toBe(true)
    expect((after.placed ?? []).some((p) => p.owner === 3 && !p.always)).toBe(false)
  })

  it('a computer plays the race and base the lobby gave it', () => {
    const before = doc()
    const { doc: after } = seatPlayers(before, [
      { active: true },
      { ai: 2, faction: COMPACT, start: 2, active: true },
      { active: false },
      { active: false },
    ])
    expect(after.aiLevels?.[1]).toBe(2)
    expect(slotKeep(after, 1)).toBe(COMPACT.keep)
    expect(after.startLocations[1]).toEqual(before.startLocations[2])
    expect(validateGameDef(after.gameDef!)).toEqual([])
    const s = setupMatch(after, walkGridFromDoc(after), 2)
    expect(stateHash(s)).toBe(stateHash(setupMatch(JSON.parse(JSON.stringify(after)), walkGridFromDoc(after), 2)))
  })
})
