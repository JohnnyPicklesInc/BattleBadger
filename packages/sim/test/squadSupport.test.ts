import { t10 } from './_rate.ts'
import { describe, expect, it } from 'vitest'
import { generateSquadSupport } from '../src/mapgen/squadSupport.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { setupMatch } from '../src/setup.ts'
import { step } from '../src/step.ts'
import { Kind, handleOf, type SimState } from '../src/state.ts'
import type { PlayerCommand } from '../src/commands.ts'
import { validateGameDef } from '../src/defs/schema.ts'
import { findPath } from '../src/path/astar.ts'

// The map is mostly triggers, and a trigger that never fires fails silently —
// the match simply stays empty and nobody can tell why. So these play it.

/** Ticks per second AS THIS FILE'S DURATIONS WERE AUTHORED (10 Hz). t10()
 *  converts them to whatever the clock actually runs at. */
const TPS = 10
/** Comfortably north of the defended base, south of the lane mouths. */
/** North of the commander's keep (z 168), south of the nearest hold. */
const BASE_Z_GUARD = 150

// setupMatch does NOT read doc.aiLevels — the client applies them itself
// (game.ts / simWorker.ts) right after setup. A test that skips that step runs
// the map with every computer switched off, which silently passes anything
// that only checks the map's own content.
const sim = (): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } => {
  const doc = generateSquadSupport()
  const grid = walkGridFromDoc(doc)
  const s = setupMatch(doc, grid, 8)
  doc.aiLevels!.forEach((lvl, i) => {
    if (i < 8) s.aiLevel[i] = lvl
  })
  return { s, grid }
}

const run = (s: SimState, grid: ReturnType<typeof walkGridFromDoc>, ticks: number): void => {
  for (let t = 0; t < t10(ticks); t++) step(s, grid, [])
}

const owned = (s: SimState, slot: number): number[] => {
  const out: number[] = []
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === slot) out.push(i)
  return out
}

const defName = (s: SimState, id: number): string => s.def.entities[s.type[id]].id

describe('the Squad Support rules', () => {
  it('describes a legal game', () => {
    const doc = generateSquadSupport()
    expect(validateGameDef(doc.gameDef!)).toEqual([])
  })

  it('stays inside the trigger runtime’s region ceiling', () => {
    // 30 is a hard throw in compileTriggers, and the pads are per-KIND rather
    // than per-player precisely to fit. A future squad type must not quietly
    // blow it.
    expect(generateSquadSupport().regions!.length).toBeLessThanOrEqual(30)
  })

  it('lets the company actually walk to every hold', () => {
    // The one failure that would make the map unplayable and that no other
    // test here would notice: cliff walls or the central massif sealing a hold
    // off. Asked of the pathfinder with `exact`, so a best-effort walk-towards
    // does not count as a route.
    const doc = generateSquadSupport()
    const grid = walkGridFromDoc(doc)
    const muster = doc.startLocations[0]
    const holds = (doc.placed ?? []).filter((p) => p.def === 'command-post' && p.owner === 7)
    expect(holds).toHaveLength(3)
    for (const h of holds) {
      const route = findPath(grid, grid.cellX(muster.x), grid.cellZ(muster.z), grid.cellX(h.x), grid.cellZ(h.z), true)
      expect(route, `no route from the muster to the hold at ${h.x},${h.z}`).not.toBeNull()
    }
    // And the forward base sites have to be standable, or the commander can
    // never advance onto them.
    for (const c of (doc.placed ?? []).filter((p) => p.def.endsWith('-site'))) {
      expect(grid.isWalkableWorld(c.x, c.z), `site at ${c.x},${c.z} is inside a cliff`).toBe(true)
    }
  })

  it('seats a commander, six squads and the attacker', () => {
    const doc = generateSquadSupport()
    expect(doc.startLocations).toHaveLength(8)
    expect(doc.slotTeams).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    // The map cannot be played without both computers, so it asks for them
    // itself rather than hoping the lobby does.
    expect(doc.aiLevels![6], 'the commander must be a computer').toBeGreaterThan(0)
    expect(doc.aiLevels![7], 'the attacker must be a computer').toBeGreaterThan(0)
    // The squad seats must be humanly available. A lobby seats players from
    // slot 0 up and a human name overrides aiLevels for that slot, so an AI
    // parked on a low slot gets handed to the first person who joins AND
    // driven by the computer at the same time.
    for (const slot of [0, 1, 2, 3, 4, 5]) expect(doc.aiLevels![slot]).toBe(0)
  })
})

describe('drawing a squad', () => {
  const postOf = (s: SimState, slot: number): number =>
    owned(s, slot).find((i) => defName(s, i) === 'muster-post')!

  const train = (s: SimState, grid: ReturnType<typeof walkGridFromDoc>, slot: number, def: string): void => {
    step(s, grid, [
      { kind: 'train', player: slot, units: [handleOf(s, postOf(s, slot))], x: 0, z: 0, def: s.def.entIndex.get(def)! },
    ] as PlayerCommand[])
  }

  it('gives every squad seat a Muster Post and nothing else', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    for (const slot of [0, 1, 2, 3, 4, 5]) {
      expect(owned(s, slot).map((i) => defName(s, i)), `seat ${slot}`).toEqual(['muster-post'])
    }
  })

  it('is furniture, not a target — it cannot be shot out from under a player', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    expect(s.def.stats.untargetable[s.type[postOf(s, 0)]]).toBe(1)
  })

  it('trains individual soldiers from the command card', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    train(s, grid, 0, 'sq-rifleman')
    run(s, grid, 20 * TPS)
    const men = owned(s, 0).filter((i) => defName(s, i) === 'sq-rifleman')
    expect(men.length, 'no rifleman arrived').toBeGreaterThan(0)
    // Loose, not bound: the difference between a squad you pull apart and a
    // battalion that moves as one shape.
    for (const i of men) expect(s.hordeOf[i], 'a squad member was bound into a horde').toBe(-1)
  })

  it('lets a player choose the composition, and stops at the command points', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    const cap = s.supplyCap[0]
    expect(cap, 'a squad seat has no command points to spend').toBeGreaterThan(0)
    // Queue far more than the budget allows; supplyRoom must refuse the excess.
    for (let k = 0; k < 20; k++) {
      train(s, grid, 0, 'sq-rifleman')
      run(s, grid, 12 * TPS)
    }
    const used = s.supplyUsed[0]
    expect(used, 'trained past the command point cap').toBeLessThanOrEqual(cap)
    expect(used, 'trained nothing at all').toBeGreaterThan(0)
  })

  it('gives the points back when the squad dies, so you can pick again', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    train(s, grid, 0, 'sq-gunship')
    run(s, grid, 30 * TPS)
    const gunships = owned(s, 0).filter((i) => defName(s, i) === 'sq-gunship')
    expect(gunships.length, 'no gunship arrived').toBeGreaterThan(0)
    const spent = s.supplyUsed[0]
    expect(spent).toBeGreaterThan(0)
    for (const i of gunships) s.hp[i] = 0
    run(s, grid, 3 * TPS)
    expect(s.supplyUsed[0], 'the points did not come back').toBeLessThan(spent)
    // And a different kind this time — the whole point of re-picking.
    train(s, grid, 0, 'sq-siege')
    run(s, grid, 25 * TPS)
    expect(owned(s, 0).map((i) => defName(s, i))).toContain('sq-siege')
  })
})

describe('the night', () => {
  it('leaves squad players with no resource counter to misread', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    const n = s.def.resources.length
    const ri = s.def.resIndex.get('res')!
    for (const slot of [0, 1, 2, 3, 4, 5]) {
      expect(s.resources[slot * n + ri], `squad ${slot} still holds a balance`).toBe(0)
    }
    // The commander is the one that spends, and must keep its opening purse.
    expect(s.resources[6 * n + ri]).toBeGreaterThan(0)
  })

  it('sends the first wave down the lanes on time', () => {
    const { s, grid } = sim()
    const mobiles = (): number[] => owned(s, 7).filter((i) => s.kind[i] === Kind.Unit)
    // The enemy owns a BASE from tick 0, but no soldiers until a wave lands.
    run(s, grid, 5)
    expect(mobiles(), 'the attack started before it was called').toHaveLength(0)
    run(s, grid, 34 * TPS) // the nearest hold wakes at 0:30 and sends at once
    const foe = mobiles()
    expect(foe.length, 'no attackers arrived').toBeGreaterThan(0)
    // It forms up at the nearest hold's lane mouth, well north of the keep.
    for (const i of foe) expect(s.posZ[i]).toBeLessThan(BASE_Z_GUARD)
  })

  it('gives the commander an economy it actually spends', () => {
    const { s, grid } = sim()
    // Sampled, not snapshotted. The commander's garrison fights the waves, so
    // whether it happens to have anybody alive at one particular second says
    // more about when the last wave landed than about whether it is training.
    // What is being claimed is that it SPENDS — so watch the whole window and
    // ask whether it ever put a soldier on the field.
    let everTrained = 0
    for (let k = 0; k < 18; k++) {
      run(s, grid, 10 * TPS)
      everTrained = Math.max(everTrained, owned(s, 6).filter((i) => s.kind[i] === Kind.Unit).length)
    }
    // Counting BUILDINGS is not enough: a Command Post arrives with a ring of
    // twelve empty build plots, and those are buildings too — an earlier
    // version of this test passed on plots alone while the commander sat there
    // doing nothing at all. Name what it must actually have raised.
    const raised = owned(s, 6).map((i) => defName(s, i))
    expect(raised.filter((d) => d === 'farm').length, 'no farms — the economy never started').toBeGreaterThan(0)
    expect(raised, 'nothing that can train a soldier').toContain('barrack-block')
    // And it must be spending them on troops.
    expect(everTrained, 'the commander trained nobody in three minutes').toBeGreaterThan(0)
  })

  it('gives the enemy a real base to break, not just a spawn point', () => {
    const { s, grid } = sim()
    run(s, grid, 5)
    const posts = owned(s, 7).filter((i) => defName(s, i) === 'command-post')
    // Three holds, stacked up the valley — the map is a campaign, not a siege
    // of one yard, and each one has to be taken in turn.
    expect(posts, 'the enemy should hold three keeps').toHaveLength(3)
    // All of them north of the commander, at increasing depth.
    const depths = posts.map((i) => s.posZ[i]).sort((a, b) => b - a)
    for (const z of depths) expect(z).toBeLessThan(150)
    expect(new Set(depths).size, 'the holds should be at different depths').toBe(3)
  })

  it('is won by putting the enemy Command Post down, not by the clock', () => {
    const { s, grid } = sim()
    run(s, grid, 40)
    expect(s.winner).toBe(-1)
    const posts = () => owned(s, 7).filter((i) => defName(s, i) === 'command-post')
    // Killing ONE is not enough — that is the whole point of three holds.
    s.hp[posts()[0]] = 0
    run(s, grid, 60)
    expect(s.winner, 'one hold should not end it').toBe(-1)
    for (const i of posts()) s.hp[i] = 0
    run(s, grid, 60) // the check is on a 3s timer
    expect(s.winner, 'clearing every hold did not win it').toBe(0)
  })

  it('is lost when the commander’s own Command Post falls', () => {
    const { s, grid } = sim()
    run(s, grid, 40)
    const post = owned(s, 6).find((i) => defName(s, i) === 'command-post')!
    s.hp[post] = 0
    run(s, grid, 40)
    expect(s.winner, 'losing the base did not end it').toBe(1)
  })

  it('seeds neutral ground the commander can take once it is cleared', () => {
    const doc = generateSquadSupport()
    const sites = (doc.placed ?? []).filter((p) => p.def.endsWith('-site'))
    expect(sites.length, 'no forward base sites').toBeGreaterThan(3)
    // Not on a squad seat. A squad's respawn is detected by "owns nothing",
    // and a neutral pad on its ledger means it never counts as wiped out.
    for (const c of sites) expect([0, 1, 2, 3, 4, 5]).not.toContain(c.owner)
    // And they must be forward of the keep, or there is nothing to advance to.
    expect(sites.some((c) => c.z < 100), 'nothing to take deep in the valley').toBe(true)
  })

  it('shuts a hold’s waves off when the hold falls', () => {
    const { s, grid } = sim()
    // Let the nearest hold wake (0:30) and send at least one wave.
    run(s, grid, 80 * TPS)
    const mobiles = () => owned(s, 7).filter((i) => s.kind[i] === Kind.Unit).length
    expect(mobiles(), 'the near hold never attacked').toBeGreaterThan(0)
    // Raze every keep and clear the field: nothing more may arrive.
    for (const i of owned(s, 7)) s.hp[i] = 0
    run(s, grid, 10 * TPS)
    const after = mobiles()
    run(s, grid, 90 * TPS) // well past the near hold's 42s cadence
    expect(mobiles(), 'a dead hold kept sending waves').toBeLessThanOrEqual(after)
  })

  it('is not decided by annihilation either way', () => {
    // triggersOnly: squads die constantly and the attacker is wiped between
    // waves, and neither may end the match.
    const { s, grid } = sim()
    run(s, grid, 60 * TPS)
    expect(s.winner).toBe(-1)
  })
})
