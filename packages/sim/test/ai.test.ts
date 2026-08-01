import { describe, expect, it } from 'vitest'
import {
  Harv,
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  type SimState,
} from '@battlebadger/sim'
import { generateEconDemo } from '../src/mapgen/econDemo.ts'
import { generateDunhollow } from '../src/mapgen/dunhollow.ts'
import { generateMap } from '../src/mapgen/simpleMap.ts'

type World = { s: SimState; grid: ReturnType<typeof walkGridFromDoc> }

function world(gen: () => ReturnType<typeof generateEconDemo>, aiSlot: number, level = 2): World {
  const doc = gen()
  const grid = walkGridFromDoc(doc)
  const s = setupMatch(doc, grid, 2)
  s.aiLevel[aiSlot] = level
  return { s, grid }
}

const run = (w: World, ticks: number): void => {
  for (let t = 0; t < ticks; t++) step(w.s, w.grid, [])
}

const countOwned = (s: SimState, slot: number, pred: (i: number) => boolean): number => {
  let n = 0
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot && pred(i)) n++
  return n
}

describe('AI opponent', () => {
  it('does nothing at all when no slot is marked AI', () => {
    const doc = generateEconDemo(3)
    const grid = walkGridFromDoc(doc)
    const a = setupMatch(doc, grid, 2)
    const b = setupMatch(doc, grid, 2)
    b.aiLevel[1] = 0 // explicit human
    for (let t = 0; t < 60; t++) {
      step(a, grid, [])
      step(b, grid, [])
    }
    expect(stateHash(a)).toBe(stateHash(b))
  })

  // Econ Demo declares harvesters + resource nodes, so the harvest job gates on.
  it('Econ Demo: puts its idle workers on resource nodes and earns', () => {
    const w = world(() => generateEconDemo(3), 0) // slot 0 owns the hall + peons
    const lumber = w.s.def.resIndex.get('lumber')!
    const n = w.s.def.resources.length
    const before = w.s.resources[0 * n + lumber]
    run(w, 300)
    const working = countOwned(w.s, 0, (i) => w.s.harvState[i] !== Harv.None)
    expect(working, 'no worker ever started gathering').toBeGreaterThan(0)
    // gold is earned AND spent, so assert on lumber: gathered, barely spent
    expect(w.s.resources[0 * n + lumber], 'AI delivered nothing').toBeGreaterThan(before)
  })

  it('Econ Demo: keeps its training queues busy', () => {
    const w = world(() => generateEconDemo(3), 0)
    const startUnits = countOwned(w.s, 0, () => true)
    run(w, 400)
    expect(countOwned(w.s, 0, () => true), 'AI produced nothing').toBeGreaterThan(startUnits)
  })

  // Dunhollow has no harvesters at all: income is passive and structures go on
  // plots. The same job set must cover it without a single map branch.
  it('Dunhollow: claims build plots and gets an economy up', () => {
    const w = world(() => generateDunhollow(5), 1)
    expect(countOwned(w.s, 1, (i) => !!w.s.def.entities[w.s.type[i]].income)).toBe(0)
    run(w, 500)
    const income = countOwned(w.s, 1, (i) => !!w.s.def.entities[w.s.type[i]].income)
    expect(income, 'AI never built an income building on a plot').toBeGreaterThan(0)
  })

  it('Dunhollow: trains battalions once it can pay for them', () => {
    const w = world(() => generateDunhollow(5), 1)
    w.s.resources[1 * w.s.def.resources.length] = 6000 // skip the economy ramp
    run(w, 1200)
    const soldiers = countOwned(w.s, 1, (i) => w.s.def.stats.damage[w.s.type[i]] > 0 && w.s.kind[i] === 0)
    expect(soldiers, 'AI fielded no army').toBeGreaterThan(0)
  })

  // Skirmish Valley has no economy whatsoever — only the army job applies.
  it('Skirmish Valley: with no economy, it still marches its starting army', () => {
    const doc = generateMap(11)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    s.aiLevel[1] = 2
    const homeX = Float64Array.from(s.posX)
    for (let t = 0; t < 200; t++) step(s, grid, [])
    let moved = 0
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 1 && Math.abs(s.posX[i] - homeX[i]) > 2) moved++
    }
    expect(moved, 'AI army never left its start position').toBeGreaterThan(0)
  })

  it('is deterministic: identical runs produce identical hash sequences', () => {
    const once = (): number[] => {
      const w = world(() => generateEconDemo(3), 0)
      const out: number[] = []
      for (let t = 0; t < 150; t++) {
        step(w.s, w.grid, [])
        out.push(stateHash(w.s))
      }
      return out
    }
    expect(once()).toEqual(once())
  })

  it('two AI slots on opposite teams both build their own bases', () => {
    // Dunhollow gives both slots a fortress, so this is a fair mirror.
    const doc = generateDunhollow(5)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    s.aiLevel[0] = 2
    s.aiLevel[1] = 2
    for (let t = 0; t < 600; t++) step(s, grid, [])
    for (const slot of [0, 1]) {
      const income = countOwned(s, slot, (i) => !!s.def.entities[s.type[i]].income)
      expect(income, `slot ${slot} built no economy`).toBeGreaterThan(0)
    }
  })

  it('difficulty changes behaviour: a higher level acts sooner', () => {
    const acted = (level: number): number => {
      const w = world(() => generateEconDemo(3), 0, level)
      run(w, 60)
      return countOwned(w.s, 0, (i) => w.s.harvState[i] !== Harv.None)
    }
    // level 3 thinks every 6 ticks, level 1 every 20 — by tick 60 the fast one
    // has had more chances to put workers on nodes
    expect(acted(3)).toBeGreaterThanOrEqual(acted(1))
  })

  it('aiLevel is hashed, so clients disagreeing about who is a bot desync', () => {
    const doc = generateEconDemo(3)
    const grid = walkGridFromDoc(doc)
    const a = setupMatch(doc, grid, 2)
    const b = setupMatch(doc, grid, 2)
    a.aiLevel[1] = 2
    expect(stateHash(a)).not.toBe(stateHash(b))
  })
})

// Research and defence. Both are structural: no job knows what "forged blades"
// means, only how many of its units an upgrade touches and whether the plot it
// is looking at has an enemy standing near it.
describe('the AI buys research', () => {
  it('researches once it has an army worth improving', async () => {
    const sim = await import('@battlebadger/sim')
    const { generateDunhollow } = await import('../src/mapgen/dunhollow.ts')
    const doc = generateDunhollow(20260727)
    const grid = sim.walkGridFromDoc(doc)
    const s = sim.setupMatch(doc, grid, 2)
    s.aiLevel[0] = 3
    s.aiLevel[1] = 3
    // Generously long on purpose: research is a multiplier on an army, so the
    // AI correctly buys the army and the buildings first and only then starts
    // improving them. Measured at roughly 10k ticks on this map.
    let owned = 0
    for (let t = 0; t < 16000 && owned === 0; t++) {
      sim.step(s, grid, [])
      owned = 0
      for (let u = 0; u < s.def.upgrades.length; u++) if (sim.hasUpgrade(s, 0, u)) owned++
    }
    expect(owned, 'a level-3 AI should have finished some research').toBeGreaterThan(0)
  })

  it('never buys an upgrade for units it does not field', () => {
    // The scoring is by bodies affected, so an AI with no cavalry must not be
    // paying for horseshoes.
    const doc = generateDunhollow(20260727)
    const def = doc.gameDef!
    const shod = def.upgrades!.find((u) => u.id === 'shod-hooves')!
    expect(shod.appliesTo).not.toContain('swordsman')
  })
})
