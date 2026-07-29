import { describe, expect, it } from 'vitest'
import {
  generateMap,
  setupMatch,
  step,
  stateHash,
  walkGridFromDoc,
  rngFromSeed,
  rngInt,
  rngFloat,
  type PlayerCommand,
  type SimState,
} from '@battlebadger/sim'

// Scripted pseudo-random command stream (own RNG — not the sim's).
function scriptedCommands(seed: number, ticks: number): Map<number, PlayerCommand[]> {
  const rng = rngFromSeed(seed)
  const byTick = new Map<number, PlayerCommand[]>()
  for (let t = 0; t < ticks; t += 3 + rngInt(rng, 12)) {
    const player = rngInt(rng, 2)
    const kinds = ['move', 'attackMove', 'stop'] as const
    const kind = kinds[rngInt(rng, 3)]
    const base = player === 0 ? 0 : 21
    const units: number[] = []
    const n = 1 + rngInt(rng, 10)
    for (let k = 0; k < n; k++) units.push(base + rngInt(rng, 21))
    const cmd: PlayerCommand = {
      kind,
      player,
      units,
      x: 8 + rngFloat(rng) * 80,
      z: 8 + rngFloat(rng) * 80,
    }
    const arr = byTick.get(t) ?? []
    arr.push(cmd)
    byTick.set(t, arr)
  }
  return byTick
}

function runSim(seed: number, ticks: number, hashEvery: number): { hashes: number[]; final: SimState } {
  const doc = generateMap(seed)
  const grid = walkGridFromDoc(doc)
  const sim = setupMatch(doc, grid)
  const cmds = scriptedCommands(seed ^ 0xabcdef, ticks)
  const hashes: number[] = []
  for (let t = 0; t < ticks; t++) {
    step(sim, grid, cmds.get(t) ?? [])
    if (t % hashEvery === 0) hashes.push(stateHash(sim))
  }
  return { hashes, final: sim }
}

describe('lockstep determinism', () => {
  it('two independent sims with the same seed + commands stay hash-identical for 2000 ticks', () => {
    const a = runSim(42, 2000, 1)
    const b = runSim(42, 2000, 1)
    expect(a.hashes.length).toBe(2000)
    for (let i = 0; i < a.hashes.length; i++) {
      expect(b.hashes[i], `tick ${i}`).toBe(a.hashes[i])
    }
  })

  it('different seeds diverge', () => {
    const a = runSim(1, 200, 199)
    const b = runSim(2, 200, 199)
    expect(a.hashes[0]).not.toBe(b.hashes[0])
  })

  it('scripted battle actually causes combat and deaths (gameplay sanity)', () => {
    const doc = generateMap(7)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    const all0: number[] = []
    const all1: number[] = []
    for (let i = 0; i < sim.count; i++) (sim.owner[i] === 0 ? all0 : all1).push(i)
    // Send both armies at each other's start, re-ordering periodically (ramp
    // chokepoints on the v2 map can strand stragglers otherwise).
    const attack = (): PlayerCommand[] => [
      { kind: 'attackMove', player: 0, units: all0, x: doc.startLocations[1].x, z: doc.startLocations[1].z },
      { kind: 'attackMove', player: 1, units: all1, x: doc.startLocations[0].x, z: doc.startLocations[0].z },
    ]
    for (let t = 0; t < 4000 && sim.winner < 0; t++) {
      step(sim, grid, t % 400 === 0 ? attack() : [])
    }
    let deadCount = 0
    for (let i = 0; i < sim.count; i++) if (!sim.alive[i]) deadCount++
    // decisive battle: either annihilation or mass casualties (surviving
    // priests can legitimately out-heal a lone attacker into a stalemate)
    expect(deadCount).toBeGreaterThan(25)
  })

  it('units actually move when ordered', () => {
    const doc = generateMap(3)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    // Pick a destination on a known-walkable cell ~10 units away.
    const near = grid.nearestWalkable(grid.cellX(sim.posX[0] + 10), grid.cellZ(sim.posZ[0]))!
    const dx = grid.centerX(near[0])
    const dz = grid.centerZ(near[1])
    step(sim, grid, [{ kind: 'move', player: 0, units: [0], x: dx, z: dz }])
    for (let t = 0; t < 100; t++) step(sim, grid, [])
    const err = Math.sqrt((sim.posX[0] - dx) ** 2 + (sim.posZ[0] - dz) ** 2)
    expect(err).toBeLessThan(1.0)
  })

  it('malicious command (wrong owner / bogus ids) is ignored', () => {
    const doc = generateMap(3)
    const grid = walkGridFromDoc(doc)
    const sim = setupMatch(doc, grid)
    // player 1 tries to command player 0's unit 0, plus out-of-range ids
    const h0 = stateHash(sim)
    step(sim, grid, [{ kind: 'move', player: 1, units: [0, -5, 9999], x: 50, z: 50 }])
    // run a few ticks; unit 0 must not have an order
    for (let t = 0; t < 10; t++) step(sim, grid, [])
    expect(sim.order[0]).toBe(0)
    // and nothing else changed materially (units idle at spawn)
    const doc2 = generateMap(3)
    const grid2 = walkGridFromDoc(doc2)
    const sim2 = setupMatch(doc2, grid2)
    for (let t = 0; t < 11; t++) step(sim2, grid2, [])
    expect(stateHash(sim)).toBe(stateHash(sim2))
    expect(h0).not.toBe(0)
  })
})
