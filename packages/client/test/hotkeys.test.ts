import { describe, expect, it } from 'vitest'
import { assignHotkeys, RESERVED_KEYS, type KeyedAction } from '../src/ui/hotkeys.ts'
import { BUILTIN_RULESETS } from '@battlebadger/sim'

const BADGERS = BUILTIN_RULESETS.find((p) => p.id === 'badgers')!.modules.find((m) => m.keep)!

// Hotkeys are a promise the card makes: the letter printed on a button is the
// letter that presses it. These pin the two ways that promise can break — a
// key handed to two buttons, and a key handed to a button that the game had
// already spoken for.

const card = (...actions: KeyedAction[]): Map<string, string> => assignHotkeys(actions)

describe('command-card hotkeys', () => {
  it('honours the key a def asked for', () => {
    const keys = card({ key: 'ab0', label: 'Rally Cry', hotkey: 'Q' })
    expect(keys.get('ab0')).toBe('Q')
  })

  it('never hands out a key the game reserved', () => {
    // 'Forged Blades' asks for F, which is fullscreen. It gets a letter of its
    // own name instead — and the button will say so.
    const keys = card({ key: 'up0', label: 'Forged Blades', hotkey: 'F' })
    expect(RESERVED_KEYS).not.toContain(keys.get('up0'))
    expect(keys.get('up0')).toBe('O') // F,R,G,E,D → F reserved, so R... 'O' after
  })

  it('gives an unlettered action the first free letter of its own name', () => {
    const keys = card({ key: 'bd0', label: 'Barracks' }, { key: 'bd1', label: 'Blacksmith' })
    expect(keys.get('bd0')).toBe('B')
    expect(keys.get('bd1')).toBe('L') // B taken, then L
  })

  it('lets the first claimant keep a contested key and re-letters the rest', () => {
    const keys = card(
      { key: 'ab0', label: 'Black Arrow', hotkey: 'B' },
      { key: 'fm0', label: 'Block', hotkey: 'B' },
    )
    expect(keys.get('ab0')).toBe('B')
    expect(keys.get('fm0')).not.toBe('B')
  })

  it('gives an authored key priority over a name that merely starts with it', () => {
    // The barracks is listed first, but the hero's spell named the key.
    const keys = card({ key: 'bd0', label: 'Quarry' }, { key: 'ab0', label: 'Mend', hotkey: 'Q' })
    expect(keys.get('ab0')).toBe('Q')
    expect(keys.get('bd0')).not.toBe('Q')
  })

  it('never repeats a letter, however crowded the card', () => {
    // Everything a shipped faction can put on one card at once, plus a card's
    // worth of same-initial buildings to squeeze the pool.
    const actions: KeyedAction[] = [
      ...(BADGERS.abilities ?? []).map((a, i) => ({ key: `ab${i}`, label: a.name, hotkey: a.hotkey })),
      ...(BADGERS.upgrades ?? []).map((u, i) => ({ key: `up${i}`, label: u.name, hotkey: u.hotkey })),
      ...BADGERS.entities.map((e, i) => ({ key: `bd${i}`, label: e.name })),
    ]
    const keys = assignHotkeys(actions)
    const letters = [...keys.values()]
    expect(new Set(letters).size, 'two buttons share a letter').toBe(letters.length)
    for (const l of letters) expect(RESERVED_KEYS).not.toContain(l)
  })

  it('is deterministic — the same card always gets the same letters', () => {
    const actions: KeyedAction[] = [
      { key: 'ab0', label: 'Word of Power', hotkey: 'W' },
      { key: 'bd0', label: 'Barracks' },
      { key: 'tr0', label: 'Warrior Band' },
    ]
    expect([...assignHotkeys(actions)]).toEqual([...assignHotkeys(actions)])
  })

  it('runs out of letters rather than repeating one', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: 'Zzz' }))
    const keys = assignHotkeys(many)
    // 26 letters less the 6 the game reserves.
    expect(keys.size).toBe(26 - RESERVED_KEYS.length)
    expect(new Set(keys.values()).size).toBe(keys.size)
  })
})
