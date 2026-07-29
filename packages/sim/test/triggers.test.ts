import { describe, expect, it } from 'vitest'
import {
  SKIRMISH_DEF,
  setupMatch,
  stateHash,
  step,
  walkGridFromDoc,
  type RtsMapDoc,
  type SimState,
  type TriggerDef,
} from '@battlebadger/sim'

function trigDoc(triggers: TriggerDef[], extra?: Partial<RtsMapDoc>): RtsMapDoc {
  const size = 32
  return {
    version: 1,
    name: 'trig-test',
    seed: 5,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable: Array.from({ length: size * size }, () => 1),
    heights: Array.from({ length: size * size }, () => 0),
    startLocations: [
      { x: 5, z: 5 },
      { x: 27, z: 27 },
    ],
    placed: [{ def: 'grunt', owner: 0, x: 5, z: 5 }],
    regions: [{ id: 'goal', name: 'Goal', x0: 20, z0: 20, x1: 30, z1: 30 }],
    triggers,
    gameDef: JSON.parse(JSON.stringify(SKIRMISH_DEF)) as RtsMapDoc['gameDef'],
    ...extra,
  }
}

const run = (doc: RtsMapDoc, ticks: number): SimState => {
  const grid = walkGridFromDoc(doc)
  const s = setupMatch(doc, grid)
  for (let t = 0; t < ticks; t++) step(s, grid, [])
  return s
}

describe('triggers', () => {
  it('mapInit fires once and emits a message event', () => {
    const doc = trigDoc([
      {
        id: 't1', name: 'welcome', once: true,
        events: [{ type: 'mapInit' }],
        conditions: [],
        actions: [{ type: 'message', text: 'Welcome!', to: 'all' }],
      },
    ])
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    step(s, grid, [])
    expect(s.events.some((e) => e.t === 'message' && e.text === 'Welcome!')).toBe(true)
    step(s, grid, [])
    expect(s.events.some((e) => e.t === 'message')).toBe(false) // once
  })

  it('periodic timer spawns waves', () => {
    const doc = trigDoc([
      {
        id: 'wave', name: 'wave',
        events: [{ type: 'timer', seconds: 2, periodic: true }],
        conditions: [],
        actions: [{ type: 'spawnUnits', def: 'grunt', owner: 1, count: 2, at: { x: 15, z: 15 } }],
      },
    ])
    const s = run(doc, 65) // 6.5s → waves at 2s/4s/6s
    let enemies = 0
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === 1) enemies++
    expect(enemies).toBe(6)
  })

  it('unitEntersRegion → victory', () => {
    const doc = trigDoc([
      {
        id: 'win', name: 'reach the goal', once: true,
        events: [{ type: 'unitEntersRegion', region: 'goal', owner: 0 }],
        conditions: [],
        actions: [{ type: 'victory', player: 0 }],
      },
    ])
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid)
    step(s, grid, [{ kind: 'move', player: 0, units: [0], x: 25, z: 25 }])
    for (let t = 0; t < 200 && s.winner < 0; t++) step(s, grid, [])
    expect(s.winner).toBe(0)
  })

  it('resourceReached is edge-triggered via arming', () => {
    const doc = trigDoc([
      {
        id: 'rich', name: 'rich',
        events: [{ type: 'resourceReached', owner: 0, resource: 'gold', amount: 50 }],
        conditions: [],
        actions: [{ type: 'modifyResource', owner: 0, resource: 'gold', delta: -50 }],
      },
    ])
    doc.gameDef!.resources = [{ id: 'gold', name: 'Gold', startAmount: 120 }]
    const s = run(doc, 10)
    // fires once at 120 → 70; still >= 50 but not re-armed (level held) → fires? No:
    // armed cleared while level active; 70 >= 50 keeps it active, so exactly one more
    // fire only after dropping below. 120-50=70 ≥ 50 → stays disarmed → total -50.
    expect(s.resources[0]).toBe(70)
  })

  it('setTrigger enables a dormant trigger', () => {
    const doc = trigDoc([
      {
        id: 'gate', name: 'gate', once: true,
        events: [{ type: 'timer', seconds: 1 }],
        conditions: [],
        actions: [{ type: 'setTrigger', trigger: 'payload', on: true }],
      },
      {
        id: 'payload', name: 'payload', initiallyOn: false, once: true,
        events: [{ type: 'timer', seconds: 2 }],
        conditions: [],
        actions: [{ type: 'modifyResource', owner: 0, resource: 'gold', delta: 99 }],
      },
    ])
    doc.gameDef!.resources = [{ id: 'gold', name: 'Gold', startAmount: 0 }]
    const s = run(doc, 40)
    expect(s.resources[0]).toBe(99)
  })

  it('trigger-heavy map stays deterministic across two sims', () => {
    const mk = (): number => {
      const doc = trigDoc([
        {
          id: 'wave', name: 'wave',
          events: [{ type: 'timer', seconds: 1, periodic: true }],
          conditions: [{ type: 'elapsed', seconds: 1 }],
          actions: [
            { type: 'spawnUnits', def: 'grunt', owner: 1, count: 1, at: { region: 'goal' } },
            { type: 'orderUnits', region: 'goal', owner: 1, order: 'attackMove', x: 5, z: 5 },
          ],
        },
      ])
      const s = run(doc, 300)
      return stateHash(s)
    }
    expect(mk()).toBe(mk())
  })
})
