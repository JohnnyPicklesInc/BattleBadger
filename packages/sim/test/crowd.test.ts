import { describe, expect, it } from 'vitest'
import { MIDDLE_EARTH_DEF } from '../src/mapgen/middleEarth.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { setupMatch } from '../src/setup.ts'
import { step } from '../src/step.ts'
import { spawnHorde } from '../src/systems/economy.ts'
import { handleOf, type SimState } from '../src/state.ts'
import type { PlayerCommand, RtsMapDoc } from '../src/index.ts'

// Getting an army from one place to another, through its own side and through
// the enemy's. Every case here was a thing the player saw and called broken:
// battalions walking into a fight without drawing a sword, men wedged against
// each other and giving up in the middle of the map, a rank that had to march
// through itself to about-face.
//
// Flat open ground on purpose. Nothing here is about terrain — it is about
// bodies, which is the part that used to jam.

const SIZE = 140
const flatDoc = (): RtsMapDoc => ({
  version: 1,
  name: 'crowd',
  seed: 7,
  cols: SIZE,
  rows: SIZE,
  cellSize: 1,
  originX: 0,
  originZ: 0,
  walkable: Array.from({ length: SIZE * SIZE }, () => 1),
  heights: Array.from({ length: SIZE * SIZE }, () => 0),
  startLocations: [{ x: 10, z: 10 }, { x: SIZE - 10, z: SIZE - 10 }],
  placed: [],
  gameDef: MIDDLE_EARTH_DEF,
})

const mk = (): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } => {
  const doc = flatDoc()
  const grid = walkGridFromDoc(doc)
  return { s: setupMatch(doc, grid, 8), grid }
}

const run = (s: SimState, grid: ReturnType<typeof walkGridFromDoc>, ticks: number): void => {
  for (let t = 0; t < ticks; t++) step(s, grid, [])
}

const alive = (s: SimState, ids: number[]): number => ids.filter((i) => s.alive[i]).length

/** How many of these men ended up where the order actually put them. */
const atPost = (s: SimState, ids: number[], slack = 2): number =>
  ids.filter((i) => s.alive[i] && Math.hypot(s.posX[i] - s.destX[i], s.posZ[i] - s.destZ[i]) <= slack).length

describe('a battalion on the march fights what it walks into', () => {
  it('does not get butchered carrying out a move order', () => {
    const { s, grid } = mk()
    const tk = s.def.entIndex.get('h-swordsmen')!
    const mine = spawnHorde(s, grid, tk, 0, 40, 60, 1, 0)
    const foe = spawnHorde(s, grid, tk, 1, 64, 60, -1, 0)
    // A plain right-click straight through the enemy line. It used to walk
    // them into it with their swords sheathed: nine dead for two.
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, mine[0])], x: 64, z: 60 }] as PlayerCommand[])
    run(s, grid, 300)
    expect(alive(s, foe), 'the enemy took no real losses — nobody fought back').toBeLessThan(4)
  })

  it('still leaves when it is ordered away from one', () => {
    const { s, grid } = mk()
    const tk = s.def.entIndex.get('h-swordsmen')!
    const mine = spawnHorde(s, grid, tk, 0, 60, 60, 1, 0)
    const foe = spawnHorde(s, grid, tk, 1, 64, 60, -1, 0)
    // Toe to toe with a line that holds its ground, then told to break off.
    // Swinging on the way out is fine; standing there trading blows because
    // something happens to be in reach is not — a retreat you cannot order is
    // not a retreat, and fighting back must not cost you the ability to leave.
    step(s, grid, [{ kind: 'hold', player: 1, units: [handleOf(s, foe[0])], x: 0, z: 0 }] as PlayerCommand[])
    run(s, grid, 20)
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, mine[0])], x: 25, z: 60 }] as PlayerCommand[])
    run(s, grid, 200)
    const live = mine.filter((i) => s.alive[i])
    expect(live.length, 'the whole battalion died breaking off').toBeGreaterThan(4)
    const away = live.filter((i) => s.posX[i] < 40).length
    expect(away, 'nobody actually withdrew').toBe(live.length)
  })
})

describe('battalions moving past each other', () => {
  it('two allied hosts swap ends without stranding each other', () => {
    const { s, grid } = mk()
    const mix = ['h-swordsmen', 'h-spearmen', 'h-archers'].map((n) => s.def.entIndex.get(n)!)
    const west: number[][] = []
    const east: number[][] = []
    for (let k = 0; k < 8; k++) {
      west.push(spawnHorde(s, grid, mix[k % 3], 0, 35, 50 + k * 3.5, 1, 0))
      east.push(spawnHorde(s, grid, mix[(k + 1) % 3], 0, 100, 50 + k * 3.5, -1, 0))
    }
    step(s, grid, [
      { kind: 'move', player: 0, units: west.map((g) => handleOf(s, g[0])), x: 100, z: 62 },
      { kind: 'move', player: 0, units: east.map((g) => handleOf(s, g[0])), x: 35, z: 62 },
    ] as PlayerCommand[])
    run(s, grid, 700)
    const all = [...west.flat(), ...east.flat()]
    expect(alive(s, all), 'allies killed each other somehow').toBe(all.length)
    // Two mixed hosts of seventy walking straight through each other. Nobody
    // is entitled to wedge against a friend and stand there for the match.
    expect(atPost(s, all)).toBeGreaterThan(all.length * 0.8)
  })

  it('marches through a friendly crowd standing in the way', () => {
    const { s, grid } = mk()
    const tk = s.def.entIndex.get('h-swordsmen')!
    for (let k = 0; k < 7; k++) spawnHorde(s, grid, tk, 0, 70, 45 + k * 3.5, 1, 0)
    const marcher = spawnHorde(s, grid, tk, 0, 45, 55, 1, 0)
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, marcher[0])], x: 95, z: 55 }] as PlayerCommand[])
    run(s, grid, 500)
    expect(atPost(s, marcher)).toBe(marcher.length)
  })
})

describe('a battalion re-forming', () => {
  it('about-faces without every rank walking through the others', () => {
    const { s, grid } = mk()
    const tk = s.def.entIndex.get('h-swordsmen')!
    const host: number[][] = []
    for (let k = 0; k < 4; k++) host.push(spawnHorde(s, grid, tk, 0, 70, 50 + k * 6, 1, 0))
    // sent back the way they came: with slots handed out in spawn order the
    // front rank had to cross its own battalion to reach the back one
    step(s, grid, [{ kind: 'move', player: 0, units: host.map((g) => handleOf(s, g[0])), x: 55, z: 60 }] as PlayerCommand[])
    run(s, grid, 400)
    const all = host.flat()
    expect(atPost(s, all)).toBeGreaterThan(all.length * 0.85)
  })

  it('picks itself up after being shoved off its ground', () => {
    const { s, grid } = mk()
    const tk = s.def.entIndex.get('h-swordsmen')!
    const holding = spawnHorde(s, grid, tk, 0, 70, 60, 1, 0)
    step(s, grid, [{ kind: 'move', player: 0, units: [handleOf(s, holding[0])], x: 70, z: 60 }] as PlayerCommand[])
    run(s, grid, 60)
    expect(atPost(s, holding, 2.5), 'the battalion never formed up in the first place').toBe(holding.length)
    // Scattered off their ground the way a cavalry impact or an ogre's club
    // scatters them — bodily, with no change of orders.
    for (const i of holding) {
      s.posX[i] += 6
      s.posZ[i] -= 4
    }
    expect(atPost(s, holding, 2.5), 'the shove did nothing').toBe(0)
    run(s, grid, 200)
    expect(atPost(s, holding, 2.5), 'the battalion stayed where it was thrown').toBe(holding.length)
  })
})
