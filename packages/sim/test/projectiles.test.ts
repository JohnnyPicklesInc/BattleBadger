import { describe, expect, it } from 'vitest'
import {
  compileGameDef,
  handleOf,
  createSim,
  spawnUnit,
  stateHash,
  step,
  walkGridFromDoc,
  type GameDef,
  type SimState,
} from '@battlebadger/sim'

// A siege piece and a target dummy. The engine has a long reach and a slow
// shell so travel time is observable in whole ticks.
const DEF: GameDef = {
  schema: 1,
  id: 'proj-test',
  name: 'Projectile Test',
  resources: [{ id: 'gold', name: 'Gold', startAmount: 0 }],
  entities: [
    {
      id: 'engine', name: 'Engine', kind: 'unit', radius: 0.7, hp: 300,
      visual: { model: 'placeholder:box' },
      mover: { speed: 1.4 },
      combat: {
        damage: 60, range: 16, acquire: 17, periodTicks: 50,
        projectile: { speed: 10, splashRadius: 3, edgePct: 40 },
      },
    },
    {
      id: 'sniper', name: 'Sniper', kind: 'unit', radius: 0.4, hp: 300,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 3 },
      // same reach, no projectile block: resolves instantly
      combat: { damage: 60, range: 16, acquire: 17, periodTicks: 50 },
    },
    {
      id: 'dummy', name: 'Dummy', kind: 'unit', radius: 0.4, hp: 400,
      visual: { model: 'placeholder:capsule' },
      mover: { speed: 4 },
    },
  ],
  abilities: [],
  victory: { mode: 'triggersOnly' },
}

const FLAT = {
  version: 1 as const, name: 'flat', seed: 1, cols: 80, rows: 80, cellSize: 1,
  originX: 0, originZ: 0,
  walkable: Array.from({ length: 80 * 80 }, () => 1),
  startLocations: [{ x: 8, z: 8 }],
}

function world(): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } {
  const s = createSim(1, compileGameDef(DEF))
  s.playerCount = 2
  s.playerTeam[0] = 0
  s.playerTeam[1] = 1
  return { s, grid: walkGridFromDoc(FLAT) }
}

const spawn = (s: SimState, id: string, owner: number, x: number, z: number): number =>
  spawnUnit(s, s.def.entIndex.get(id)!, owner, x, z)

const liveShells = (s: SimState): number => {
  let n = 0
  for (let k = 0; k < s.projectiles.count; k++) if (s.projectiles.alive[k]) n++
  return n
}

describe('projectiles', () => {
  it('a shot takes time to arrive: a shell exists before any damage lands', () => {
    const { s, grid } = world()
    spawn(s, 'engine', 0, 20, 20)
    const target = spawn(s, 'dummy', 1, 32, 20) // 12 away, shell speed 10 → ~1.2s
    const hp0 = s.hp[target]
    step(s, grid, [])
    expect(liveShells(s), 'nothing was launched').toBeGreaterThan(0)
    expect(s.hp[target], 'damage landed on the firing tick').toBe(hp0)
    for (let t = 0; t < 40 && s.hp[target] === hp0; t++) step(s, grid, [])
    expect(s.hp[target], 'the shell never landed').toBeLessThan(hp0)
    expect(liveShells(s), 'the shell was not cleaned up').toBe(0)
  })

  it('a hitscan weapon of the same reach lands immediately, for contrast', () => {
    const { s, grid } = world()
    spawn(s, 'sniper', 0, 20, 20)
    const target = spawn(s, 'dummy', 1, 32, 20)
    const hp0 = s.hp[target]
    step(s, grid, [])
    expect(s.hp[target]).toBeLessThan(hp0)
    expect(liveShells(s)).toBe(0)
  })

  it('the shell is aimed at the ground, so a target can walk out of it', () => {
    const { s, grid } = world()
    spawn(s, 'engine', 0, 20, 20)
    const target = spawn(s, 'dummy', 1, 34, 20)
    const hp0 = s.hp[target]
    step(s, grid, []) // engine fires at (34, 20)
    expect(liveShells(s)).toBe(1)
    // teleport the target well clear of the blast before the shell arrives
    s.posX[target] = 60
    s.posZ[target] = 60
    for (let t = 0; t < 40 && liveShells(s) > 0; t++) step(s, grid, [])
    expect(liveShells(s), 'shell never resolved').toBe(0)
    expect(s.hp[target], 'a dodged shell still hit').toBe(hp0)
  })

  it('splash hits a cluster, and hurts less toward the rim', () => {
    const { s, grid } = world()
    spawn(s, 'engine', 0, 20, 20)
    const bullseye = spawn(s, 'dummy', 1, 34, 20)
    const nearRim = spawn(s, 'dummy', 1, 34, 22.6) // ~2.6 out, splash 3
    const clear = spawn(s, 'dummy', 1, 34, 30)
    const hp = [s.hp[bullseye], s.hp[nearRim], s.hp[clear]]
    for (let t = 0; t < 40 && liveShells(s) === 0; t++) step(s, grid, [])
    for (let t = 0; t < 40 && liveShells(s) > 0; t++) step(s, grid, [])
    const dmgCentre = hp[0] - s.hp[bullseye]
    const dmgRim = hp[1] - s.hp[nearRim]
    expect(dmgCentre, 'centre took nothing').toBeGreaterThan(0)
    expect(dmgRim, 'rim took nothing').toBeGreaterThan(0)
    expect(dmgRim, 'falloff not applied').toBeLessThan(dmgCentre)
    expect(s.hp[clear], 'something outside the blast was hit').toBe(hp[2])
  })

  it('a blast never harms the shooter or its allies', () => {
    const { s, grid } = world()
    const engine = spawn(s, 'engine', 0, 20, 20)
    const friend = spawn(s, 'dummy', 0, 33.5, 20) // right beside the impact
    const foe = spawn(s, 'dummy', 1, 34, 20)
    const friendHp = s.hp[friend]
    const engineHp = s.hp[engine]
    for (let t = 0; t < 60 && s.hp[foe] === 400; t++) step(s, grid, [])
    expect(s.hp[foe]).toBeLessThan(400)
    expect(s.hp[friend], 'friendly fire').toBe(friendHp)
    expect(s.hp[engine], 'the shooter shelled itself').toBe(engineHp)
  })

  it('an impact raises a client FX event carrying the blast radius', () => {
    const { s, grid } = world()
    spawn(s, 'engine', 0, 20, 20)
    spawn(s, 'dummy', 1, 32, 20)
    let seen: { x: number; z: number; radius: number } | null = null
    for (let t = 0; t < 60 && !seen; t++) {
      step(s, grid, [])
      for (const ev of s.events) if (ev.t === 'impact') seen = ev
    }
    expect(seen, 'no impact event').not.toBeNull()
    expect(seen!.radius).toBeCloseTo(3)
  })

  it('shells are lockstep-deterministic and their slots recycle', () => {
    const run = (): number[] => {
      const { s, grid } = world()
      spawn(s, 'engine', 0, 20, 20)
      for (let k = 0; k < 5; k++) spawn(s, 'dummy', 1, 32 + k * 0.9, 19 + (k % 3))
      const out: number[] = []
      for (let t = 0; t < 200; t++) {
        step(s, grid, [])
        out.push(stateHash(s))
      }
      return out
    }
    expect(run()).toEqual(run())

    // firing many volleys must not grow the store without bound
    const { s, grid } = world()
    spawn(s, 'engine', 0, 20, 20)
    spawn(s, 'dummy', 1, 32, 20)
    for (let t = 0; t < 600; t++) step(s, grid, [])
    expect(s.projectiles.count).toBeLessThan(12)
  })

  it('a shell already in flight still lands after its shooter dies', () => {
    const { s, grid } = world()
    const engine = spawn(s, 'engine', 0, 20, 20)
    const target = spawn(s, 'dummy', 1, 34, 20)
    const hp0 = s.hp[target]
    step(s, grid, [])
    expect(liveShells(s)).toBe(1)
    s.hp[engine] = 0
    for (let t = 0; t < 40 && liveShells(s) > 0; t++) step(s, grid, [])
    expect(s.alive[engine]).toBe(0)
    expect(s.hp[target], 'the shot died with the shooter').toBeLessThan(hp0)
  })
})

// Ranged units must engage from maximum range rather than closing first.
describe('shooters stop at range', () => {
  it('acquire is floored to firing range, so nothing walks inside its own reach', () => {
    const def = compileGameDef({
      ...DEF,
      entities: [
        {
          id: 'shortsighted', name: 'Shortsighted', kind: 'unit', radius: 0.4, hp: 100,
          visual: { model: 'placeholder:capsule' },
          mover: { speed: 3 },
          // authored badly: it can shoot 12 but only notices at 4
          combat: { damage: 10, range: 12, acquire: 4, periodTicks: 10 },
        },
      ],
    })
    expect(def.stats.acquire[0]).toBeGreaterThanOrEqual(def.stats.atkRange[0])
  })

  it('an archer plants at max range and never closes further', () => {
    const { s, grid } = world()
    const archer = spawn(s, 'sniper', 0, 20, 20) // range 16, hitscan
    const foe = spawn(s, 'dummy', 1, 50, 20)
    step(s, grid, [{ kind: 'attackMove', player: 0, units: [handleOf(s, archer)], x: 50, z: 20 }])
    for (let t = 0; t < 200 && s.target[archer] < 0; t++) step(s, grid, [])
    expect(s.target[archer], 'never engaged').toBeGreaterThanOrEqual(0)
    const gapAtEngage = Math.hypot(s.posX[foe] - s.posX[archer], s.posZ[foe] - s.posZ[archer])
    // it should have stopped out near its reach, not walked into contact
    const reach = s.def.stats.atkRange[s.type[archer]]
    expect(gapAtEngage).toBeGreaterThan(reach - 1)
    // and it must hold that ground while shooting
    for (let t = 0; t < 60; t++) step(s, grid, [])
    if (s.alive[foe]) {
      const gapNow = Math.hypot(s.posX[foe] - s.posX[archer], s.posZ[foe] - s.posZ[archer])
      expect(Math.abs(gapNow - gapAtEngage), 'drifted while firing').toBeLessThan(1)
    }
  })
})

// Siege is artillery, not a rifle. Two behaviours BFME had that a plain
// splash weapon does not: shots land NEAR the aim point, and a boulder that
// lands on somebody flattens them outright.
describe('scatter and direct hits', () => {
  // crushableLevel is explicit: this def declares none, so it would otherwise
  // default to 0 and every shell would count as a flattening direct hit.
  const scatterDef = (scatterRadius: number, crusherLevel = 0, crushableLevel = 0): GameDef => ({
    ...DEF,
    entities: DEF.entities.map((e) =>
      e.id === 'engine'
        ? {
            ...e,
            crusherLevel,
            crushableLevel,
            combat: { ...e.combat!, projectile: { speed: 10, splashRadius: 3, edgePct: 40, scatterRadius } },
          }
        : e,
    ),
  })

  const impacts = (def: GameDef, shots: number): { x: number; z: number }[] => {
    const s = createSim(1, compileGameDef(def))
    s.playerCount = 2
    s.playerTeam[0] = 0
    s.playerTeam[1] = 1
    const grid = walkGridFromDoc(FLAT)
    spawnUnit(s, s.def.entIndex.get('engine')!, 0, 20, 20)
    // a target that cannot die, so the battery keeps firing
    const dummy = spawnUnit(s, s.def.entIndex.get('dummy')!, 1, 34, 20)
    const out: { x: number; z: number }[] = []
    for (let t = 0; t < 900 && out.length < shots; t++) {
      s.hp[dummy] = 400 // top it up; we are measuring aim, not attrition
      step(s, grid, [])
      for (const ev of s.events) if (ev.t === 'impact') out.push({ x: ev.x, z: ev.z })
    }
    return out
  }

  it('without scatter every shell lands on the same spot', () => {
    const pts = impacts(scatterDef(0), 4)
    expect(pts.length).toBeGreaterThan(1)
    for (const p of pts) {
      expect(Math.abs(p.x - pts[0].x)).toBeLessThan(1e-6)
      expect(Math.abs(p.z - pts[0].z)).toBeLessThan(1e-6)
    }
  })

  it('with scatter shells spread around the aim point, and stay inside it', () => {
    const R = 3
    const pts = impacts(scatterDef(R), 6)
    expect(pts.length).toBeGreaterThan(3)
    const spread = Math.max(...pts.map((p) => Math.abs(p.x - pts[0].x) + Math.abs(p.z - pts[0].z)))
    expect(spread, 'shells all landed on the same spot').toBeGreaterThan(0.2)
    // every shot still lands within the scatter disc of the aim point
    for (const p of pts) {
      const d = Math.hypot(p.x - 34, p.z - 20)
      expect(d, 'a shell landed outside its scatter radius').toBeLessThanOrEqual(R + 1e-6)
    }
  })

  it('scatter is lockstep-deterministic despite drawing on the shared RNG', () => {
    const a = impacts(scatterDef(3), 6)
    const b = impacts(scatterDef(3), 6)
    expect(a).toEqual(b)
  })

  it('a direct hit flattens what the shell outweighs, whatever its HP', () => {
    // engine crusher 3 vs dummy (crushable 0): a bullseye kills outright
    const def = compileGameDef(scatterDef(0, 3))
    const s = createSim(1, def)
    s.playerCount = 2
    s.playerTeam[0] = 0
    s.playerTeam[1] = 1
    const grid = walkGridFromDoc(FLAT)
    spawnUnit(s, s.def.entIndex.get('engine')!, 0, 20, 20)
    const victim = spawnUnit(s, s.def.entIndex.get('dummy')!, 1, 34, 20)
    for (let t = 0; t < 100 && s.alive[victim]; t++) step(s, grid, [])
    expect(s.alive[victim], 'a bullseye should flatten it').toBe(0)
  })

  it('a shell cannot flatten something its own weight or heavier', () => {
    // engine crusher 3 vs another engine (crushable 3) — not strictly greater
    const def = compileGameDef(scatterDef(0, 3, 3))
    const s = createSim(1, def)
    s.playerCount = 2
    s.playerTeam[0] = 0
    s.playerTeam[1] = 1
    const grid = walkGridFromDoc(FLAT)
    spawnUnit(s, s.def.entIndex.get('engine')!, 0, 20, 20)
    const victim = spawnUnit(s, s.def.entIndex.get('engine')!, 1, 34, 20)
    step(s, grid, [])
    for (let t = 0; t < 30; t++) step(s, grid, [])
    // it takes splash damage, but is not simply deleted
    expect(s.alive[victim], 'flattened something of its own weight').toBe(1)
  })
})
