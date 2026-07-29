import { describe, expect, it } from 'vitest'
import {
  FogState,
  compileGameDef,
  createSim,
  spawnUnit,
  stateHash,
  step,
  walkGridFromDoc,
  type GameDef,
  type RtsMapDoc,
  type SimState,
} from '@battlebadger/sim'

const DEF: GameDef = {
  schema: 1,
  id: 'fog-test',
  name: 'Fog Test',
  resources: [{ id: 'gold', name: 'Gold', startAmount: 0 }],
  entities: [
    {
      id: 'scout', name: 'Scout', kind: 'unit', radius: 0.4, hp: 100,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 3 },
      vision: 8,
    },
    {
      id: 'blind', name: 'Blind', kind: 'unit', radius: 0.4, hp: 100,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 3 },
      vision: 0.01, // effectively sees only itself
    },
  ],
  abilities: [],
  victory: { mode: 'triggersOnly' },
}

const doc = (fog: RtsMapDoc['fog']): RtsMapDoc => ({
  version: 1,
  name: 'flat',
  seed: 1,
  cols: 64,
  rows: 64,
  cellSize: 1,
  originX: 0,
  originZ: 0,
  walkable: Array.from({ length: 64 * 64 }, () => 1),
  fog,
  startLocations: [{ x: 8, z: 8 }],
})

function world(fog: RtsMapDoc['fog']): { s: SimState; grid: ReturnType<typeof walkGridFromDoc>; d: RtsMapDoc } {
  const d = doc(fog)
  const s = createSim(1, compileGameDef(DEF))
  s.playerCount = 2
  s.playerTeam[0] = 0
  s.playerTeam[1] = 1
  return { s, grid: walkGridFromDoc(d), d }
}

const spawn = (s: SimState, id: string, owner: number, x: number, z: number): number =>
  spawnUnit(s, s.def.entIndex.get(id)!, owner, x, z)

describe('fog of war', () => {
  it('off: everything is visible from the start', () => {
    const { s, d } = world('off')
    const far = spawn(s, 'scout', 1, 60, 60)
    const fog = new FogState(d, 0)
    fog.update(s)
    expect(fog.enabled).toBe(false)
    expect(fog.canSeeEntity(s, far)).toBe(true)
    expect(fog.visibleAtWorld(60, 60)).toBe(true)
  })

  it('full: unexplored ground starts hidden and stays remembered once seen', () => {
    const { s, d } = world('full')
    const scout = spawn(s, 'scout', 0, 10, 10)
    const fog = new FogState(d, 0)
    expect(fog.exploredAtWorld(10, 10)).toBe(false)
    fog.update(s)
    expect(fog.visibleAtWorld(10, 10)).toBe(true)
    expect(fog.exploredAtWorld(10, 10)).toBe(true)
    // walk away; the ground is remembered but no longer lit
    s.posX[scout] = 50
    s.posZ[scout] = 50
    s.tick++
    fog.update(s)
    expect(fog.visibleAtWorld(10, 10)).toBe(false)
    expect(fog.exploredAtWorld(10, 10)).toBe(true)
  })

  it('units mode: terrain is common knowledge but enemies still hide', () => {
    const { s, d } = world('units')
    spawn(s, 'scout', 0, 10, 10)
    const enemy = spawn(s, 'scout', 1, 55, 55)
    const fog = new FogState(d, 0)
    fog.update(s)
    expect(fog.exploredAtWorld(55, 55)).toBe(true) // map is known
    expect(fog.canSeeEntity(s, enemy)).toBe(false) // the enemy on it is not
  })

  it('enemies are seen only within sight, own units always', () => {
    const { s, d } = world('full')
    const mine = spawn(s, 'scout', 0, 10, 10)
    const near = spawn(s, 'scout', 1, 14, 10) // within vision 8
    const far = spawn(s, 'scout', 1, 40, 10)
    const fog = new FogState(d, 0)
    fog.update(s)
    expect(fog.canSeeEntity(s, mine)).toBe(true)
    expect(fog.canSeeEntity(s, near)).toBe(true)
    expect(fog.canSeeEntity(s, far)).toBe(false)
  })

  it('vision is shared across a team', () => {
    const { s, d } = world('full')
    s.playerTeam[2] = 0 // slot 2 is our ally
    spawn(s, 'scout', 2, 40, 40)
    const enemyNearAlly = spawn(s, 'scout', 1, 43, 40)
    const fog = new FogState(d, 0)
    fog.update(s)
    expect(fog.canSeeEntity(s, enemyNearAlly)).toBe(true)
  })

  it('a unit always sees at least what it can auto-engage', () => {
    // vision is floored to acquire+1 at compile time, so a unit can never
    // shoot at something its owner cannot see
    const def = compileGameDef({
      ...DEF,
      entities: [
        {
          id: 'sniper', name: 'Sniper', kind: 'unit', radius: 0.4, hp: 100,
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 3 },
          vision: 1, // deliberately smaller than acquire
          combat: { damage: 5, range: 20, acquire: 22, periodTicks: 10 },
        },
      ],
    })
    expect(def.stats.vision[0]).toBeGreaterThan(def.stats.acquire[0])
  })

  it('fog never touches the simulation: identical hashes with fog on and off', () => {
    // The whole design rests on this — fog is derived, per-viewer state.
    const run = (mode: RtsMapDoc['fog']): number[] => {
      const { s, grid } = world(mode)
      spawn(s, 'scout', 0, 10, 10)
      spawn(s, 'scout', 1, 40, 40)
      const out: number[] = []
      for (let t = 0; t < 20; t++) {
        step(s, grid, [])
        out.push(stateHash(s))
      }
      return out
    }
    expect(run('full')).toEqual(run('off'))
    expect(run('units')).toEqual(run('off'))
  })

  it('two viewers on the same match see different things', () => {
    const { s, d } = world('full')
    spawn(s, 'scout', 0, 10, 10)
    spawn(s, 'scout', 1, 50, 50)
    const mine = new FogState(d, 0)
    const theirs = new FogState(d, 1)
    mine.update(s)
    theirs.update(s)
    expect(mine.visibleAtWorld(10, 10)).toBe(true)
    expect(theirs.visibleAtWorld(10, 10)).toBe(false)
    expect(theirs.visibleAtWorld(50, 50)).toBe(true)
    expect(mine.visibleAtWorld(50, 50)).toBe(false)
  })

  it('static scenery stays drawn once explored, unlike units', () => {
    const { s, d } = world('full')
    const scout = spawn(s, 'scout', 0, 10, 10)
    const fog = new FogState(d, 0)
    fog.update(s)
    expect(fog.canSeeDoodad(10, 10)).toBe(true)
    s.posX[scout] = 55
    s.tick++
    fog.update(s)
    expect(fog.canSeeDoodad(10, 10)).toBe(true) // a tree cannot have moved
    expect(fog.visibleAtWorld(10, 10)).toBe(false)
  })
})
