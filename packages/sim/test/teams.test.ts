import { describe, expect, it } from 'vitest'
import {
  deriveTerrain,
  findPath,
  handleOf,
  setupMatch,
  spawnUnit,
  stateHash,
  step,
  walkGridFromDoc,
  type SimState,
} from '@battlebadger/sim'
import { applyDamageTable } from '../src/systems/combat.ts'
// Authoring-time generator, not part of the runtime API — imported by path,
// the same way scripts/gen-starter-maps.mjs does.
import { generateCerebrateWar } from '../src/mapgen/cerebrateWar.ts'

const bySlot = (s: SimState, owner: number, defId: string): number => {
  const ty = s.def.entIndex.get(defId)!
  for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === owner && s.type[i] === ty) return i
  return -1
}

// Summon a champion at the slot's hatchery and step until it walks out.
const summon = (s: SimState, grid: ReturnType<typeof walkGridFromDoc>, slot: number): number => {
  const hatch = bySlot(s, slot, 'hatchery')
  expect(hatch).toBeGreaterThanOrEqual(0)
  const ticket = s.def.entIndex.get('champion')!
  step(s, grid, [{ kind: 'train', player: slot, units: [handleOf(s, hatch)], x: 0, z: 0, def: ticket }])
  for (let t = 0; t < 80 && bySlot(s, slot, 'hero') < 0; t++) step(s, grid, [])
  return bySlot(s, slot, 'hero')
}

describe('teams + Cerebrate War (MOBA map as data)', () => {
  it('2-player setup: slot content for absent players is skipped; teams alternate', () => {
    const doc = generateCerebrateWar(1)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    expect(s.playerTeam[0]).toBe(0)
    expect(s.playerTeam[1]).toBe(1)
    expect(bySlot(s, 0, 'hatchery')).toBeGreaterThanOrEqual(0)
    expect(bySlot(s, 2, 'hatchery')).toBe(-1) // absent slot skipped
    // the war belongs to the reserved AI slots and exists at any player count
    expect(bySlot(s, 6, 'cerebrate')).toBeGreaterThanOrEqual(0)
    expect(bySlot(s, 7, 'cerebrate')).toBeGreaterThanOrEqual(0)
    expect(s.playerTeam[6]).toBe(0)
    expect(s.playerTeam[7]).toBe(1)
    // champions are summoned, never pre-placed; players own no towers/creeps
    expect(bySlot(s, 0, 'hero')).toBe(-1)
    expect(bySlot(s, 0, 'cerebrate')).toBe(-1)
    expect(bySlot(s, 0, 'bastion')).toBe(-1)
  })

  it('a summoned champion is a horde of one and levels off creep kills', () => {
    const doc = generateCerebrateWar(2)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const hero = summon(s, grid, 0)
    expect(hero).toBeGreaterThanOrEqual(0)
    const horde = s.hordeOf[hero]
    expect(horde).toBeGreaterThanOrEqual(0) // trained through the horde path
    expect(s.hordes.level[horde]).toBe(1)
    // the summon bill, plus one hatchery income payment that lands during the
    // ~60-tick build (deterministic, so exact)
    // opening bank, minus the champion's price, plus one income payment
    expect(s.resources[0]).toBe(s.def.resources[0].startAmount - 250 + 8)

    // feed it a dying enemy creep → the killing blow lands XP on the horde.
    // Fight at mid-lane (map centre): inside the plaza the base towers steal
    // the kill (they out-range the champion), and towers are not hordes — no XP.
    s.posX[hero] = 88
    s.posZ[hero] = 88
    const sw = s.def.entIndex.get('swarmling')!
    const victim = spawnUnit(s, sw, 7, s.posX[hero] + 1, s.posZ[hero])
    s.hp[victim] = 1
    for (let t = 0; t < 40 && s.alive[victim]; t++) step(s, grid, [])
    expect(s.alive[victim]).toBe(0)
    expect(s.hordes.xp[horde]).toBeGreaterThan(0)
  })

  it('4-player 2v2: teammates never auto-attack each other; enemies do fight', () => {
    const doc = generateCerebrateWar(2)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 4)
    const h0 = summon(s, grid, 0)
    const h2 = summon(s, grid, 2)
    expect(h0).toBeGreaterThanOrEqual(0)
    expect(h2).toBeGreaterThanOrEqual(0)
    for (let t = 0; t < 60; t++) step(s, grid, [])
    expect(s.target[h0]).toBe(-1) // no friendly fire acquisition
    expect(s.hp[h2]).toBe(s.def.stats.maxHp[s.type[h2]])
  })

  it('waves spawn periodically and march; a fallen champion can be re-summoned', () => {
    const doc = generateCerebrateWar(3)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const countOwner = (o: number): number => {
      let c = 0
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === o) c++
      return c
    }
    const start6 = countOwner(6)
    for (let t = 0; t < 250; t++) step(s, grid, []) // 25s → past the 20s wave clock
    expect(countOwner(6)).toBeGreaterThan(start6) // creeps spawn for the AI slot…
    expect(countOwner(7)).toBeGreaterThan(2)
    expect(countOwner(0)).toBe(1) // …while a player still owns only their hatchery

    // summon → die → the death notice fires → summon again works
    const h = summon(s, grid, 0)
    s.hp[h] = 0
    step(s, grid, [])
    expect(s.events.some((e) => e.t === 'message' && e.player === 0)).toBe(true)
    expect(bySlot(s, 0, 'hero')).toBe(-1)
    s.resources[0] = 400 // refill the purse (bounties would normally have)
    expect(summon(s, grid, 0)).toBeGreaterThanOrEqual(0)
  })

  it('the damage matrix: siege razes forts, towers shred creeps but not heroes', () => {
    const doc = generateCerebrateWar(4)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const ty = (id: string): number => s.def.entIndex.get(id)!
    // ravager (siege 40) vs bastion (fortified): 250%
    expect(applyDamageTable(s, ty('ravager'), ty('bastion'), 40)).toBe(100)
    // swarmling (swarm 6) vs bastion: 35% → floors to 2
    expect(applyDamageTable(s, ty('swarmling'), ty('bastion'), 6)).toBe(2)
    // bastion (arcane 46) vs swarmling (light): 175%
    expect(applyDamageTable(s, ty('bastion'), ty('swarmling'), 46)).toBe(80)
    // bastion vs champion (hero): 80% — dives are survivable
    expect(applyDamageTable(s, ty('bastion'), ty('hero'), 46)).toBe(36)
    // champion (strike 38) vs bastion: 50% — a bare hero can't raze a lane
    expect(applyDamageTable(s, ty('hero'), ty('bastion'), 38)).toBe(19)
  })

  it('killing a cerebrate wins the match for the other TEAM', () => {
    const doc = generateCerebrateWar(4)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 4)
    const cRight = bySlot(s, 7, 'cerebrate')
    s.hp[cRight] = 0
    step(s, grid, [])
    expect(s.winner).toBe(0) // team 0 (slots 0+2) wins
  })

  it('long MOBA run stays deterministic across two sims', () => {
    const play = (): number => {
      const doc = generateCerebrateWar(9)
      const grid = walkGridFromDoc(doc)
      const s = setupMatch(doc, grid, 2)
      for (let t = 0; t < 1200; t++) step(s, grid, [])
      return stateHash(s)
    }
    expect(play()).toBe(play())
  })

  it('each side fields a Cerebrate, 3 Spires, 9 Bastions and 2 Core Bastions', () => {
    const doc = generateCerebrateWar(6)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const count = (owner: number, defId: string): number => {
      const ty = s.def.entIndex.get(defId)!
      let c = 0
      for (let i = 0; i < s.count; i++) if (s.alive[i] && s.owner[i] === owner && s.type[i] === ty) c++
      return c
    }
    for (const owner of [6, 7]) {
      expect(count(owner, 'cerebrate')).toBe(1)
      expect(count(owner, 'bastion')).toBe(9) // 3 lanes x 3 tiers
      expect(count(owner, 'core-bastion')).toBe(2)
      for (const lane of ['top', 'mid', 'bot']) expect(count(owner, `spire-${lane}`)).toBe(1)
      expect(count(owner, 'hatchery')).toBe(0) // hatcheries belong to players
    }
    for (const owner of [0, 1]) expect(count(owner, 'hatchery')).toBe(1)
    // the jungle grew trees
    expect(doc.doodads!.filter((d) => d.def === 'gloomtree').length).toBeGreaterThan(20)
  })

  it('terrain alone keeps lanes apart: the top route never touches mid', () => {
    const doc = generateCerebrateWar(7)
    const grid = walkGridFromDoc(doc)
    // Walk the top lane from outside team 0's plaza to a point on team 1's leg
    // and confirm A* never cuts across the map's centre, where mid lane runs.
    // This is the property that lets waves stay in lane without waypoints.
    const path = findPath(grid, 26, 120, 120, 26)
    expect(path).not.toBeNull()
    const mid = { x: doc.cols / 2, z: doc.rows / 2 }
    let nearMid = 0
    for (const cell of path!) {
      const cx = cell % doc.cols
      const cz = Math.floor(cell / doc.cols)
      if (Math.abs(cx - mid.x) < 14 && Math.abs(cz - mid.z) < 14) nearMid++
    }
    expect(nearMid).toBe(0)
  })

  it('base plazas are high ground but every lane ramps into them', () => {
    const doc = generateCerebrateWar(11)
    const grid = walkGridFromDoc(doc)
    // Waves must be able to march from mid-lane onto the enemy plaza — if the
    // ramp carving ever seals a base, matches can no longer end.
    for (const [bx, bz] of [
      [26, 150],
      [150, 26],
    ]) {
      const path = findPath(grid, 88, 88, bx, bz)
      expect(path).not.toBeNull()
    }
    // …and the high ground is real: the plaza is tier 1, the lanes tier 0,
    // and the rendered height difference survives the surface noise.
    expect(doc.cliffLevel![150 * doc.cols + 26]).toBe(1)
    expect(doc.cliffLevel![88 * doc.cols + 88]).toBe(0)
    const { heights } = deriveTerrain(doc)
    const at = (x: number, z: number): number => heights[z * doc.cols + x]
    expect(at(26, 150) - at(88, 88)).toBeGreaterThanOrEqual(1.0)
  })

  it('a fallen Spire arms the enemy elite wave in that lane only', () => {
    const doc = generateCerebrateWar(8)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const trig = s.trig
    const eliteOf = (side: number, lane: string): number => trig.trigIdx.get(`s${side}-${lane}-elite`)!
    // team 0's elite waves are all dormant until team 1 loses a Spire
    for (const lane of ['top', 'mid', 'bot']) expect(trig.enabled[eliteOf(0, lane)]).toBe(0)

    const spire = bySlot(s, 7, 'spire-mid')
    expect(spire).toBeGreaterThanOrEqual(0)
    s.hp[spire] = 0
    step(s, grid, [])
    expect(trig.enabled[eliteOf(0, 'mid')]).toBe(1) // mid armed…
    expect(trig.enabled[eliteOf(0, 'top')]).toBe(0) // …but only mid
    expect(trig.enabled[eliteOf(0, 'bot')]).toBe(0)
    expect(trig.enabled[eliteOf(1, 'mid')]).toBe(0) // and only for the other side
    // elites REPLACE the basic wave in that lane — it doesn't stack
    expect(trig.enabled[trig.trigIdx.get('s0-mid-t0')!]).toBe(0)
    expect(trig.enabled[trig.trigIdx.get('s0-top-t0')!]).toBe(1)

    const eliteTy = s.def.entIndex.get('swarmling-elite')!
    for (let t = 0; t < 250; t++) step(s, grid, [])
    let elites = 0
    for (let i = 0; i < s.count; i++) if (s.alive[i] && s.type[i] === eliteTy && s.owner[i] === 6) elites++
    expect(elites).toBeGreaterThan(0)
  })

  it('the Hatchery pays passive essence; bounties stack once waves clash', () => {
    const doc = generateCerebrateWar(10)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    const r = s.def.resIndex.get('essence')!
    const at = (owner: number): number => s.resources[owner * s.def.resources.length + r]
    // read the opening bank off the def so a balance change never breaks this
    const start = s.def.resources[r].startAmount
    expect(at(0)).toBe(start)
    for (let t = 0; t < 300; t++) step(s, grid, [])
    const passive = at(0) - start
    // income pays 8 essence every 50 ticks per hatchery — 5 or 6 payments in
    // 300 ticks depending on phase; nothing has died yet, so no bounty noise
    expect(passive).toBeGreaterThanOrEqual(5 * 8)
    expect(passive).toBeLessThanOrEqual(6 * 8)

    // once the waves meet, the 15-essence kill bounty stacks on the income
    for (let t = 0; t < 300; t++) step(s, grid, [])
    expect(at(0) - start - passive).toBeGreaterThan(6 * 8)
  })

  it('waves eventually clash mid-lane and take losses', () => {
    const doc = generateCerebrateWar(5)
    const grid = walkGridFromDoc(doc)
    const s = setupMatch(doc, grid, 2)
    for (let t = 0; t < 1200; t++) step(s, grid, [])
    let dead = 0
    for (let i = 0; i < s.count; i++) if (!s.alive[i]) dead++
    expect(dead).toBeGreaterThan(5)
    expect(s.winner).toBe(-1) // cerebrates defended by symmetric waves
  })
})
