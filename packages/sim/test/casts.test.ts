import { describe, expect, it } from 'vitest'
import {
  MAX_UNITS,
  abStride,
  compileGameDef,
  createSim,
  handleOf,
  spawnUnit,
  stateHash,
  step,
  walkGridFromDoc,
  type GameDef,
  type SimState,
} from '@battlebadger/sim'

// A minimal two-player def carrying one ability of every cast shape, so the
// cast system is tested without dragging a whole map's balance in.
const DEF: GameDef = {
  schema: 1,
  id: 'cast-test',
  name: 'Cast Test',
  resources: [{ id: 'gold', name: 'Gold', startAmount: 0 }],
  entities: [
    {
      id: 'caster', name: 'Caster', kind: 'unit', radius: 0.4, hp: 500,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 3 },
      abilities: [
        { ability: 'nuke' }, { ability: 'storm' }, { ability: 'burst' }, { ability: 'wave' },
      ],
    },
    {
      // no combat block: dummies never shoot back, so only the cast moves HP
      id: 'dummy', name: 'Dummy', kind: 'unit', radius: 0.4, hp: 400,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 1 },
    },
  ],
  abilities: [
    { id: 'nuke', name: 'Nuke', target: 'enemy', hpDelta: -70, range: 6, periodTicks: 40 },
    {
      id: 'storm', name: 'Storm', target: 'point', hpDelta: -45, range: 9, periodTicks: 90,
      area: { shape: 'circle', radius: 3 },
    },
    {
      id: 'burst', name: 'Burst', target: 'self', hpDelta: -40, range: 0, periodTicks: 75,
      area: { shape: 'circle', radius: 3.5 },
    },
    {
      id: 'wave', name: 'Wave', target: 'point', hpDelta: -110, range: 9, periodTicks: 140,
      area: { shape: 'cone', radius: 9, halfAngleCos: 0.71 }, // 45° half-angle
    },
  ],
  victory: { mode: 'triggersOnly' },
}

const FLAT = {
  version: 1 as const, name: 'flat', seed: 1, cols: 64, rows: 64, cellSize: 1,
  originX: 0, originZ: 0,
  walkable: Array.from({ length: 64 * 64 }, () => 1),
  startLocations: [{ x: 8, z: 8 }],
}

function world(): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } {
  const s = createSim(1, compileGameDef(DEF))
  s.playerCount = 2
  s.playerTeam[0] = 0
  s.playerTeam[1] = 1
  return { s, grid: walkGridFromDoc(FLAT) }
}

const ab = (s: SimState, id: string): number => s.def.abIndex.get(id)!
const spawn = (s: SimState, defId: string, owner: number, x: number, z: number): number =>
  spawnUnit(s, s.def.entIndex.get(defId)!, owner, x, z)

describe('ability casts', () => {
  it('an enemy-target nuke deals its own hpDelta, not a weapon swing', () => {
    // The bug this pins: the caster has NO combat block, so before casts.ts
    // existed a "cast" just walked at the victim and did precisely nothing.
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const victim = spawn(s, 'dummy', 1, 23, 20)
    const hp0 = s.hp[victim]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0,
        ability: ab(s, 'nuke'), target: handleOf(s, victim) },
    ])
    expect(s.hp[victim]).toBe(hp0 - 70)
  })

  it('the cast goes on its own cooldown and a second cast is refused', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const victim = spawn(s, 'dummy', 1, 23, 20)
    const nuke = ab(s, 'nuke')
    const cast = (): void => {
      step(s, grid, [
        { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0,
          ability: nuke, target: handleOf(s, victim) },
      ])
    }
    cast()
    const afterFirst = s.hp[victim]
    expect(s.abCd[caster * abStride(s.def) + nuke]).toBeGreaterThan(0)
    cast() // still cooling down
    expect(s.hp[victim]).toBe(afterFirst)
  })

  it('an out-of-range caster walks in and fires on arrival', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const victim = spawn(s, 'dummy', 1, 34, 20) // 14 away, range 6
    const hp0 = s.hp[victim]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0,
        ability: ab(s, 'nuke'), target: handleOf(s, victim) },
    ])
    expect(s.hp[victim]).toBe(hp0) // too far on the first tick
    for (let t = 0; t < 120 && s.hp[victim] === hp0; t++) step(s, grid, [])
    expect(s.hp[victim]).toBe(hp0 - 70)
  })

  it('a point circle hits everything inside it and nothing outside', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const inside = spawn(s, 'dummy', 1, 25, 20)
    const edge = spawn(s, 'dummy', 1, 26.5, 20) // 1.5 from centre, radius 3
    const outside = spawn(s, 'dummy', 1, 32, 20)
    const hp = [s.hp[inside], s.hp[edge], s.hp[outside]]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 25, z: 20, ability: ab(s, 'storm') },
    ])
    expect(s.hp[inside]).toBe(hp[0] - 45)
    expect(s.hp[edge]).toBe(hp[1] - 45)
    expect(s.hp[outside]).toBe(hp[2])
  })

  it('a self burst hits enemies around the caster but never the caster', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const near = spawn(s, 'dummy', 1, 22, 20)
    const far = spawn(s, 'dummy', 1, 27, 20)
    const casterHp = s.hp[caster]
    const nearHp = s.hp[near]
    const farHp = s.hp[far]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0, ability: ab(s, 'burst') },
    ])
    expect(s.hp[near]).toBe(nearHp - 40)
    expect(s.hp[far]).toBe(farHp)
    expect(s.hp[caster]).toBe(casterHp) // 'enemies' default spares the caster
  })

  it('a cone only hits what is inside the arc it was aimed at', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const ahead = spawn(s, 'dummy', 1, 26, 20) // dead ahead (+x)
    const offAxis = spawn(s, 'dummy', 1, 24, 23.2) // ~39° off axis: inside 45°
    const behind = spawn(s, 'dummy', 1, 15, 20) // opposite direction
    const flank = spawn(s, 'dummy', 1, 20, 26) // 90° off axis: outside
    const hp = [s.hp[ahead], s.hp[offAxis], s.hp[behind], s.hp[flank]]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 28, z: 20, ability: ab(s, 'wave') },
    ])
    expect(s.hp[ahead]).toBe(hp[0] - 110)
    expect(s.hp[offAxis]).toBe(hp[1] - 110)
    expect(s.hp[behind]).toBe(hp[2])
    expect(s.hp[flank]).toBe(hp[3])
  })

  it('an area cast spares allies by default', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const friend = spawn(s, 'dummy', 0, 25, 20)
    const foe = spawn(s, 'dummy', 1, 25.5, 20)
    const friendHp = s.hp[friend]
    const foeHp = s.hp[foe]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 25, z: 20, ability: ab(s, 'storm') },
    ])
    expect(s.hp[friend]).toBe(friendHp)
    expect(s.hp[foe]).toBe(foeHp - 45)
  })

  it('casting is lockstep-deterministic: identical inputs, identical hashes', () => {
    const run = (): number[] => {
      const { s, grid } = world()
      const caster = spawn(s, 'caster', 0, 20, 20)
      for (let k = 0; k < 6; k++) spawn(s, 'dummy', 1, 23 + k * 0.8, 19 + (k % 3))
      const hashes: number[] = []
      for (let t = 0; t < 40; t++) {
        const cmds =
          t === 2
            ? [{ kind: 'ability' as const, player: 0, units: [handleOf(s, caster)], x: 25, z: 20, ability: ab(s, 'storm') }]
            : t === 10
              ? [{ kind: 'ability' as const, player: 0, units: [handleOf(s, caster)], x: 0, z: 0, ability: ab(s, 'burst') }]
              : []
        step(s, grid, cmds)
        hashes.push(stateHash(s))
      }
      return hashes
    }
    expect(run()).toEqual(run())
  })

  it('a pending cast dies with its caster and never fires', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const victim = spawn(s, 'dummy', 1, 40, 20) // far: cast stays pending
    const hp0 = s.hp[victim]
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0,
        ability: ab(s, 'nuke'), target: handleOf(s, victim) },
    ])
    expect(s.castAb[caster]).toBeGreaterThanOrEqual(0)
    s.hp[caster] = 0
    step(s, grid, [])
    expect(s.alive[caster]).toBe(0)
    expect(s.castAb[caster]).toBe(-1)
    for (let t = 0; t < 40; t++) step(s, grid, [])
    expect(s.hp[victim]).toBe(hp0)
  })

  it('the cooldown table never aliases one ability onto another', () => {
    const { s, grid } = world()
    const caster = spawn(s, 'caster', 0, 20, 20)
    const victim = spawn(s, 'dummy', 1, 23, 20)
    const stride = abStride(s.def)
    expect(stride).toBe(DEF.abilities.length)
    expect(s.abCd.length).toBe(MAX_UNITS * stride)
    step(s, grid, [
      { kind: 'ability', player: 0, units: [handleOf(s, caster)], x: 0, z: 0,
        ability: ab(s, 'nuke'), target: handleOf(s, victim) },
    ])
    expect(s.abCd[caster * stride + ab(s, 'nuke')]).toBeGreaterThan(0)
    // the other three abilities are untouched and still castable
    for (const other of ['storm', 'burst', 'wave']) {
      expect(s.abCd[caster * stride + ab(s, other)]).toBe(0)
    }
  })
})

// Regression: a resource node that blocks walkgrid cells could not be reached.
// nodeReach used the node's geometric radius, but its blocked footprint is
// cell-quantised, so for a large node (Econ Demo's radius-1.5 gold mine) the
// nearest standable point lay outside reach and harvesters queued forever.
describe('blocking resource nodes are reachable', () => {
  it('a harvester sent to a large blocking node actually delivers', async () => {
    const { generateEconDemo } = await import('../src/mapgen/econDemo.ts')
    const { setupMatch, walkGridFromDoc: wg } = await import('@battlebadger/sim')
    const d = generateEconDemo(3)
    const grid = wg(d)
    const s = setupMatch(d, grid, 2)
    const n = s.def.resources.length
    const goldIdx = s.def.resIndex.get('gold')!
    let peon = -1
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] && s.owner[i] === 0 && s.def.entities[s.type[i]].harvester) { peon = i; break }
    }
    let mine = -1
    for (let m = 0; m < s.doodads.count; m++) {
      if (s.def.entities[s.doodads.defIdx[m]].resourceNode?.resource === 'gold') { mine = m; break }
    }
    expect(peon).toBeGreaterThanOrEqual(0)
    expect(mine).toBeGreaterThanOrEqual(0)
    expect(s.doodads.blockedCells[mine].length, 'mine should block cells').toBeGreaterThan(0)
    const before = s.resources[0 * n + goldIdx]
    step(s, grid, [{
      kind: 'harvest', player: 0, units: [handleOf(s, peon)],
      x: s.doodads.x[mine], z: s.doodads.z[mine], target: -1 - mine,
    }])
    for (let t = 0; t < 400; t++) step(s, grid, [])
    expect(s.resources[0 * n + goldIdx], 'harvester never delivered from the mine').toBeGreaterThan(before)
  })
})
