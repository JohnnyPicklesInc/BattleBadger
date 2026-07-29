import { describe, expect, it } from 'vitest'
import { rngFromSeed, rngNext, rngFloat, fnv1aInit, fnv1aInt } from '@battlebadger/sim'

describe('sfc32', () => {
  it('same seed → same sequence', () => {
    const a = rngFromSeed(123)
    const b = rngFromSeed(123)
    for (let i = 0; i < 1000; i++) expect(rngNext(a)).toBe(rngNext(b))
  })

  it('different seeds → different sequences', () => {
    const a = rngFromSeed(1)
    const b = rngFromSeed(2)
    const av = [rngNext(a), rngNext(a), rngNext(a)]
    const bv = [rngNext(b), rngNext(b), rngNext(b)]
    expect(av).not.toEqual(bv)
  })

  it('floats stay in [0, 1)', () => {
    const r = rngFromSeed(99)
    for (let i = 0; i < 1000; i++) {
      const f = rngFloat(r)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
    }
  })
})

describe('fnv1a', () => {
  it('is order-sensitive and stable', () => {
    let h1 = fnv1aInit()
    h1 = fnv1aInt(h1, 1)
    h1 = fnv1aInt(h1, 2)
    let h2 = fnv1aInit()
    h2 = fnv1aInt(h2, 2)
    h2 = fnv1aInt(h2, 1)
    expect(h1).not.toBe(h2)
    let h3 = fnv1aInit()
    h3 = fnv1aInt(h3, 1)
    h3 = fnv1aInt(h3, 2)
    expect(h3).toBe(h1)
  })
})
