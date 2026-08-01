import { describe, expect, it } from 'vitest'
import {
  BUILTIN_RULESETS,
  defaultFactionName,
  factionStartArmy,
  mapContentHash,
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
