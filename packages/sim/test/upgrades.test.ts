import { describe, expect, it } from 'vitest'
import {
  grantUpgrade,
  handleOf,
  hasUpgrade,
  refreshUpgrades,
  setupMatch,
  spawnUnit,
  stateHash,
  step,
  validateGameDef,
  walkGridFromDoc,
  type GameDef,
} from '@battlebadger/sim'
import { generateFourCorners } from '../src/mapgen/fourCorners.ts'

// Research: bought once, owned for the match, felt by units you already have.
// The property that matters is that it is PER PLAYER — the compiled stat tables
// are per entity type, so the whole point is that two armies of the same unit
// can hit differently.

const doc = generateFourCorners()
const DEF = doc.gameDef!

const fresh = () => {
  const grid = walkGridFromDoc(doc)
  return { grid, s: setupMatch(doc, grid, 4) }
}
const up = (id: string): number => DEF.upgrades!.findIndex((u) => u.id === id)

// Hit `victim` with `attacker` once and report the damage dealt.
function oneBlow(owner: number, foeOwner: number, grant?: string): number {
  const { grid, s } = fresh()
  if (grant) {
    const idx = up(grant)
    s.upgradeOwned[owner * DEF.upgrades!.length + idx] = 1
    // refresh happens through the public grant path in play; here we poke the
    // store directly and rebuild, which is what grantUpgrade does internally.
    refreshUpgrades(s, owner)
  }
  const a = spawnUnit(s, s.def.entIndex.get('swordsman')!, owner, 88, 88)
  const v = spawnUnit(s, s.def.entIndex.get('orc')!, foeOwner, 88.6, 88)
  const hp0 = s.hp[v]
  for (let t = 0; t < 40 && s.hp[v] === hp0; t++) step(s, grid, [])
  void a
  return hp0 - s.hp[v]
}

describe('the shipped research is well formed', () => {
  it('validates, and every upgrade actually does something', () => {
    expect(validateGameDef(DEF)).toEqual([])
    expect(DEF.upgrades!.length).toBeGreaterThan(0)
    for (const u of DEF.upgrades!) {
      const effects = [u.damagePct, u.armorPct, u.rangePct, u.speedPct].filter((v) => v !== undefined)
      expect(effects.length, `${u.id} has no effect`).toBeGreaterThan(0)
      expect(u.appliesTo.length, `${u.id} improves nothing`).toBeGreaterThan(0)
      expect(u.soldBy.length, `${u.id} is not sold anywhere`).toBeGreaterThan(0)
    }
  })

  it('is caught when it names something that does not exist', () => {
    const broken = JSON.parse(JSON.stringify(DEF)) as GameDef
    broken.upgrades![0].appliesTo = ['no-such-unit']
    expect(validateGameDef(broken).join(' ')).toMatch(/applies to unknown "no-such-unit"/)
    const empty = JSON.parse(JSON.stringify(DEF)) as GameDef
    delete empty.upgrades![0].damagePct
    delete empty.upgrades![0].armorPct
    delete empty.upgrades![0].rangePct
    delete empty.upgrades![0].speedPct
    expect(validateGameDef(empty).join(' ')).toMatch(/has no effect/)
  })
})

describe('an upgrade changes what a unit does', () => {
  it('forged blades make the same swordsman hit harder', () => {
    const plain = oneBlow(0, 1)
    const forged = oneBlow(0, 1, 'forged-blades')
    expect(plain).toBeGreaterThan(0)
    expect(forged).toBeGreaterThan(plain)
  })

  it('and it is the OWNER who has it, not the unit type', () => {
    // The whole reason upgrades are not baked into the compiled stat tables:
    // player 0's swordsmen and player 2's are the same type.
    const mine = oneBlow(0, 1, 'forged-blades')
    const theirs = oneBlow(2, 1)
    expect(mine).toBeGreaterThan(theirs)
  })

  it('heavy armour makes the same swordsman harder to kill', () => {
    const { grid, s } = fresh()
    const measure = (defender: number): number => {
      const a = spawnUnit(s, s.def.entIndex.get('orc')!, 1, 60 + defender * 10, 60)
      const v = spawnUnit(s, s.def.entIndex.get('swordsman')!, defender, 60.6 + defender * 10, 60)
      const hp0 = s.hp[v]
      for (let t = 0; t < 60 && s.hp[v] === hp0; t++) step(s, grid, [])
      void a
      return hp0 - s.hp[v]
    }
    const bare = measure(0)
    s.upgradeOwned[2 * DEF.upgrades!.length + up('heavy-armour')] = 1
    refreshUpgrades(s, 2)
    const armoured = measure(2)
    expect(bare).toBeGreaterThan(0)
    expect(armoured).toBeLessThan(bare)
  })
})

describe('research is bought at a building', () => {
  const research = (s: ReturnType<typeof setupMatch>, grid: ReturnType<typeof walkGridFromDoc>, b: number, id: string): void => {
    step(s, grid, [{ kind: 'research', player: s.owner[b], units: [handleOf(s, b)], x: 0, z: 0, def: up(id) }])
  }

  it('takes time, costs resources, and then it is yours', () => {
    const { grid, s } = fresh()
    // Give player 0 a barracks to research at.
    const b = spawnUnit(s, s.def.entIndex.get('barracks')!, 0, 40, 40)
    const before = s.resources[0]
    research(s, grid, b, 'forged-blades')
    expect(s.resources[0], 'it should have been paid for').toBeLessThan(before)
    expect(hasUpgrade(s, 0, up('forged-blades')), 'and not granted instantly').toBe(false)
    for (let t = 0; t < 400 && !hasUpgrade(s, 0, up('forged-blades')); t++) step(s, grid, [])
    expect(hasUpgrade(s, 0, up('forged-blades'))).toBe(true)
  })

  it('cannot be bought twice, at one building or two', () => {
    const { grid, s } = fresh()
    const b1 = spawnUnit(s, s.def.entIndex.get('barracks')!, 0, 40, 40)
    const b2 = spawnUnit(s, s.def.entIndex.get('barracks')!, 0, 50, 40)
    const before = s.resources[0]
    research(s, grid, b1, 'forged-blades')
    const afterFirst = s.resources[0]
    research(s, grid, b2, 'forged-blades') // already in progress elsewhere
    expect(s.resources[0], 'the second order should be free because it is refused').toBe(afterFirst)
    expect(before).toBeGreaterThan(afterFirst)

    for (let t = 0; t < 400 && !hasUpgrade(s, 0, up('forged-blades')); t++) step(s, grid, [])
    const owned = s.resources[0]
    research(s, grid, b1, 'forged-blades') // already owned
    expect(s.resources[0]).toBe(owned)
  })

  it('is refused at a building that does not sell it', () => {
    const { grid, s } = fresh()
    const b = spawnUnit(s, s.def.entIndex.get('barracks')!, 0, 40, 40)
    const before = s.resources[0]
    research(s, grid, b, 'fire-arrows') // sold at the archery range
    expect(s.resources[0]).toBe(before)
  })

  it('is refused when the prerequisite is missing', () => {
    const { grid, s } = fresh()
    const b = spawnUnit(s, s.def.entIndex.get('barracks')!, 0, 40, 40)
    const before = s.resources[0]
    research(s, grid, b, 'heavy-armour') // needs a stable
    expect(s.resources[0]).toBe(before)
    spawnUnit(s, s.def.entIndex.get('stable')!, 0, 44, 40)
    research(s, grid, b, 'heavy-armour')
    expect(s.resources[0]).toBeLessThan(before)
  })
})

describe('research is part of the match fingerprint', () => {
  it('two states differing only in an upgrade hash differently', () => {
    const a = fresh()
    const b = fresh()
    expect(stateHash(a.s)).toBe(stateHash(b.s))
    grantUpgrade(b.s, 0, up('forged-blades'))
    // Otherwise two clients disagreeing about research would diverge in damage
    // rather than desyncing at the tick it happened.
    expect(stateHash(a.s)).not.toBe(stateHash(b.s))
  })
})
