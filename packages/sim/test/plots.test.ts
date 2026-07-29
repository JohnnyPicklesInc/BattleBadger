import { describe, expect, it } from 'vitest'
import {
  PLOT_CLAIM_RANGE,
  plotClaimable,
  setupMatch,
  spawnUnit,
  step,
  walkGridFromDoc,
  type SimState,
} from '@battlebadger/sim'
import { generateDunhollow } from '../src/mapgen/dunhollow.ts'

function world(): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } {
  const doc = generateDunhollow(5)
  const grid = walkGridFromDoc(doc)
  return { s: setupMatch(doc, grid, 2), grid }
}

/** Plots owned by `slot` (the ring a fortress spawns), and neutral settlements. */
function plots(s: SimState, neutral: boolean, slot = 0): number[] {
  const out: number[] = []
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || !s.def.stats.isPlot[s.type[i]]) continue
    const p = s.def.entities[s.type[i]].plot!
    if (!!p.neutral !== neutral) continue
    if (!neutral && s.owner[i] !== slot) continue
    out.push(i)
  }
  return out
}

const build = (s: SimState, grid: ReturnType<typeof walkGridFromDoc>, slot: number, plot: number, defId: string): void => {
  step(s, grid, [
    { kind: 'build', player: slot, units: [], x: s.posX[plot], z: s.posZ[plot], def: s.def.entIndex.get(defId)! },
  ])
}

describe('build plots need presence', () => {
  it('your own base plots are always buildable — the fortress is the presence', () => {
    const { s } = world()
    const own = plots(s, false, 0)
    expect(own.length).toBeGreaterThan(0)
    for (const p of own) expect(plotClaimable(s, 0, p), 'own plot unclaimable').toBe(true)
  })

  it('a base plot stays buildable even with an enemy standing on it', () => {
    const { s } = world()
    const p = plots(s, false, 0)[0]
    spawnUnit(s, s.def.entIndex.get('swordsman')!, 1, s.posX[p] + 1, s.posZ[p])
    expect(plotClaimable(s, 0, p), 'own base plot became unbuildable').toBe(true)
  })

  it('a distant neutral settlement is not claimable until you march over', () => {
    const { s, grid } = world()
    // pick a settlement nobody is standing near
    const far = plots(s, true).find((p) => !plotClaimable(s, 0, p))
    expect(far, 'expected at least one unheld settlement').toBeDefined()

    const before = s.plotHost[far!]
    build(s, grid, 0, far!, 'farm')
    expect(s.plotHost[far!], 'built on a settlement with nothing nearby').toBe(before)

    // walk a soldier over and it becomes claimable
    spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, s.posX[far!] + 2, s.posZ[far!])
    expect(plotClaimable(s, 0, far!)).toBe(true)
    build(s, grid, 0, far!, 'farm')
    expect(s.plotHost[far!], 'holding the ground did not allow the build').toBeGreaterThanOrEqual(0)
  })

  it('a plot never vouches for another plot', () => {
    const { s } = world()
    // strip everything that is not a plot; the remaining pads must not
    // authorise each other, or a captured settlement would spread on its own
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && !s.def.stats.isPlot[s.type[i]]) s.alive[i] = 0
    }
    for (const p of plots(s, true)) expect(plotClaimable(s, 0, p)).toBe(false)
  })

  it('presence is measured to the entity edge, so big buildings reach further', () => {
    const { s } = world()
    const p = plots(s, true)[0]
    // a lone swordsman just inside the range claims it
    const near = spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, s.posX[p] + PLOT_CLAIM_RANGE - 1, s.posZ[p])
    expect(plotClaimable(s, 0, p)).toBe(true)
    // ...and well outside it does not
    s.posX[near] = s.posX[p] + PLOT_CLAIM_RANGE + 5
    expect(plotClaimable(s, 0, p)).toBe(false)
  })
})

describe('structures go up at half strength', () => {
  it('a fresh plot structure starts near half HP and reaches full when done', () => {
    const { s, grid } = world()
    const p = plots(s, false, 0)[0]
    build(s, grid, 0, p, 'farm')
    const b = s.plotHost[p]
    expect(b).toBeGreaterThanOrEqual(0)
    const maxHp = s.def.stats.maxHp[s.type[b]]
    expect(s.buildTicks[b]).toBeGreaterThan(0)
    // one construction tick has already run, so allow a little headroom
    expect(s.hp[b]).toBeLessThan(maxHp * 0.6)
    expect(s.hp[b]).toBeGreaterThan(0)

    for (let t = 0; t < 400 && s.buildTicks[b] > 0; t++) step(s, grid, [])
    expect(s.buildTicks[b], 'never finished').toBe(0)
    expect(s.hp[b], 'a finished building should be at full HP').toBe(maxHp)
  })

  it('HP climbs monotonically while building', () => {
    const { s, grid } = world()
    const p = plots(s, false, 0)[0]
    build(s, grid, 0, p, 'barracks')
    const b = s.plotHost[p]
    let last = s.hp[b]
    for (let t = 0; t < 400 && s.buildTicks[b] > 0; t++) {
      step(s, grid, [])
      expect(s.hp[b]).toBeGreaterThanOrEqual(last)
      last = s.hp[b]
    }
  })

  it('damage taken mid-build is not undone by the next construction tick', () => {
    const { s, grid } = world()
    const p = plots(s, false, 0)[0]
    build(s, grid, 0, p, 'barracks')
    const b = s.plotHost[p]
    const maxHp = s.def.stats.maxHp[s.type[b]]
    s.hp[b] = 40 // heavily damaged while going up
    step(s, grid, [])
    // it ticks up a little, but nowhere near back to the half it started at
    expect(s.hp[b]).toBeLessThan(maxHp / 4)
  })
})

describe('a built-on plot is replaced by its structure', () => {
  it('the plot stays alive underneath so the slot can be rebuilt when razed', () => {
    const { s, grid } = world()
    const p = plots(s, false, 0)[0]
    build(s, grid, 0, p, 'farm')
    const b = s.plotHost[p]
    expect(b).toBeGreaterThanOrEqual(0)
    expect(s.alive[p], 'the pad must survive to be reusable').toBe(1)
    expect(s.plotOf[b]).toBe(p)

    // raze the structure: the pad frees up and can host again
    s.hp[b] = 0
    step(s, grid, [])
    expect(s.alive[b]).toBe(0)
    expect(s.plotHost[p], 'plot did not free up after its building died').toBe(-1)
    build(s, grid, 0, p, 'farm')
    expect(s.plotHost[p]).toBeGreaterThanOrEqual(0)
  })
})

describe('outer settlements are contested ground', () => {
  it('an enemy standing on a settlement blocks the build for everyone', () => {
    const { s, grid } = world()
    const far = plots(s, true).find((p) => !plotClaimable(s, 0, p))!
    // bring our own troops up: now it is held
    spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, s.posX[far] + 2, s.posZ[far])
    expect(plotClaimable(s, 0, far)).toBe(true)

    // an enemy warband arrives — nobody raises a farm under their nose
    const foe = spawnUnit(s, s.def.entIndex.get('swordsman')!, 1, s.posX[far] - 3, s.posZ[far])
    expect(plotClaimable(s, 0, far), 'built while contested').toBe(false)
    build(s, grid, 0, far, 'farm')
    expect(s.plotHost[far]).toBe(-1)

    // drive them off and it opens up again
    s.posX[foe] = s.posX[far] + 60
    expect(plotClaimable(s, 0, far)).toBe(true)
  })

  it('a settlement is neutral: it belongs to nobody and sees nothing', () => {
    const { s } = world()
    const settlement = plots(s, true)[0]
    expect(s.def.stats.vision[s.type[settlement]], 'a pad must not grant sight').toBe(0)
    // its owner field is a placement slot only — it never counts as presence
    const lone = plots(s, true)
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && !s.def.stats.isPlot[s.type[i]]) s.alive[i] = 0
    }
    for (const p of lone) expect(plotClaimable(s, 0, p)).toBe(false)
  })

  it('no building on a map grants sight through a plot', () => {
    const { s } = world()
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || !s.def.stats.isPlot[s.type[i]]) continue
      expect(s.def.stats.vision[s.type[i]], 'plot has vision').toBe(0)
    }
  })
})
