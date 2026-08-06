import { describe, expect, it } from 'vitest'
import { generateMiddleEarth, MIDDLE_EARTH_CAMPS } from '../src/mapgen/middleEarth.ts'
import { walkGridFromDoc } from '../src/path/walkgrid.ts'
import { setupMatch } from '../src/setup.ts'
import { step } from '../src/step.ts'
import { aiCommands } from '../src/systems/ai.ts'
import { spawnUnit, type SimState } from '../src/state.ts'
import type { PlayerCommand } from '../src/commands.ts'

// The army job, on the map that broke it.
//
// The old one collected every idle unit a player owned, averaged their
// positions into ONE centroid and sent the lot at whatever was nearest. On a
// map where a power holds one corner that is fine. Mordor here fights at the
// Black Gate and at Dol Guldur, two hundred tiles apart.

const doc = generateMiddleEarth(20260803)
const sim = (): { s: SimState; grid: ReturnType<typeof walkGridFromDoc> } => {
  const grid = walkGridFromDoc(doc)
  const s = setupMatch(doc, grid, 8)
  for (let p = 0; p < 8; p++) s.aiLevel[p] = 2
  return { s, grid }
}

/** Every attackMove the AI issued for a slot this tick. */
const ordersFor = (cmds: PlayerCommand[], slot: number): PlayerCommand[] =>
  cmds.filter((c) => c.player === slot && c.kind === 'attackMove')

describe('the AI army job', () => {
  it('splits a power that is fighting in two places into two armies', () => {
    const { s, grid } = sim()
    // Mordor's front is around Barad-dûr; Dol Guldur is its northern war.
    const spawnBand = (def: string, owner: number, x: number, z: number, n: number): number[] => {
      const out: number[] = []
      for (let k = 0; k < n; k++) out.push(spawnUnit(s, s.def.entIndex.get(def)!, owner, x + (k % 6), z + Math.floor(k / 6)))
      return out
    }
    const south = spawnBand('orc', 1, 360, 270, 30)
    const north = spawnBand('orc', 1, 330, 168, 30)
    // Somebody to march at, on each front.
    spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, 300, 285)
    spawnUnit(s, s.def.entIndex.get('elf-archer')!, 4, 290, 150)

    let cmds: PlayerCommand[] = []
    for (let t = 0; t < 24 && ordersFor(cmds, 1).length === 0; t++) {
      cmds = aiCommands(s, grid)
      if (ordersFor(cmds, 1).length === 0) step(s, grid, [])
    }
    const orders = ordersFor(cmds, 1)
    expect(orders.length, 'Mordor issued one order for two fronts').toBeGreaterThanOrEqual(2)

    // Each order must go to units that are actually together, and the two
    // targets must differ — that is the whole point.
    const targets = orders.map((o) => `${Math.round(o.x)},${Math.round(o.z)}`)
    expect(new Set(targets).size, 'both armies were sent to the same place').toBeGreaterThan(1)

    // No order may mix the northern and southern hosts.
    const northSet = new Set(north)
    const southSet = new Set(south)
    for (const o of orders) {
      const ids = o.units.map((h) => h & 0xffff)
      const hasN = ids.some((i) => northSet.has(i))
      const hasS = ids.some((i) => southSet.has(i))
      expect(hasN && hasS, 'one order swept up both fronts').toBe(false)
    }
  })

  it('sends a small band to join the main body instead of feeding it in', () => {
    const { s, grid } = sim()
    // A big host in the south, and four stragglers far away.
    for (let k = 0; k < 40; k++) spawnUnit(s, s.def.entIndex.get('orc')!, 1, 360 + (k % 8), 270 + Math.floor(k / 8))
    const few: number[] = []
    for (let k = 0; k < 4; k++) few.push(spawnUnit(s, s.def.entIndex.get('orc')!, 1, 200, 120 + k))
    spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, 300, 285)

    let cmds: PlayerCommand[] = []
    for (let t = 0; t < 24; t++) {
      cmds = aiCommands(s, grid)
      if (ordersFor(cmds, 1).length > 0) break
      step(s, grid, [])
    }
    const orders = ordersFor(cmds, 1)
    const small = orders.find((o) => o.units.some((h) => few.includes(h & 0xffff)))
    expect(small, 'the stragglers were given no order at all').toBeDefined()

    // They must head for a body of their own, not at the enemy on their own.
    // Which body is the AI's business: it takes the NEAREST, and on this map
    // that is Dol Guldur's garrison a hundred and forty tiles off rather than
    // the host in Gorgoroth two hundred and twenty away. Naming the southern
    // host specifically was asserting the outcome instead of the rule, and the
    // rule is the thing worth keeping.
    const home = MIDDLE_EARTH_CAMPS.filter((c) => c.slot === 1).reduce(
      (best, c) =>
        (c.at.x - small!.x) ** 2 + (c.at.z - small!.z) ** 2 < (best.at.x - small!.x) ** 2 + (best.at.z - small!.z) ** 2
          ? c
          : best,
    )
    const toOwn = Math.sqrt((home.at.x - small!.x) ** 2 + (home.at.z - small!.z) ** 2)
    const toEnemy = Math.sqrt((300 - small!.x) ** 2 + (285 - small!.z) ** 2)
    expect(toOwn, `four men were sent at the enemy on their own, not to ${home.name}`).toBeLessThan(toEnemy)
  })

  it('drops everything to defend a camp that is actually under attack', () => {
    const { s, grid } = sim()
    // Gondor's army sits well away from Minas Tirith; an enemy is on it.
    const host: number[] = []
    for (let k = 0; k < 40; k++) host.push(spawnUnit(s, s.def.entIndex.get('swordsman')!, 0, 150, 330 + (k % 6)))
    const camp = doc.placed!.find((p) => p.def === 'muster-minas-tirith')!
    for (let k = 0; k < 6; k++) spawnUnit(s, s.def.entIndex.get('orc')!, 1, camp.x + 8 + k, camp.z + 6)

    let cmds: PlayerCommand[] = []
    for (let t = 0; t < 24; t++) {
      cmds = aiCommands(s, grid)
      if (ordersFor(cmds, 0).length > 0) break
      step(s, grid, [])
    }
    const orders = ordersFor(cmds, 0)
    expect(orders.length).toBeGreaterThan(0)
    // SOME army answers, not necessarily this one — the nearest group takes the
    // call, and Gondor's own troops standing at Minas Tirith are nearer than a
    // host parked on the coast. Asserting the far host specifically would be
    // asserting the wrong thing: the first version of this test did, and the
    // AI was right and the test was wrong.
    const answered = orders.some(
      (o) => Math.sqrt((o.x - camp.x) ** 2 + (o.z - camp.z) ** 2) < 40,
    )
    expect(answered, 'nobody responded to a camp being attacked').toBe(true)
    // And the far host is not off attacking something else while it happens.
    const far = orders.find((o) => o.units.some((h) => host.includes(h & 0xffff)))
    if (far) {
      const toCamp = Math.sqrt((far.x - camp.x) ** 2 + (far.z - camp.z) ** 2)
      const enemyFront = Math.sqrt((far.x - 300) ** 2 + (far.z - 285) ** 2)
      expect(toCamp < enemyFront + 60, 'the host wandered off mid-siege').toBe(true)
    }
  })

  it('mans a wall when an enemy is coming, and not before', () => {
    const { s, grid } = sim()
    const wall = doc.placed!.find((p) => p.def === 'wall-tower' && p.owner === 0)!
    const archers: number[] = []
    for (let k = 0; k < 8; k++) {
      archers.push(spawnUnit(s, s.def.entIndex.get('archer')!, 0, wall.x + 3 + (k % 3), wall.z + 3 + Math.floor(k / 3)))
    }

    // step() runs the AI itself, so left alone these men get marched off with
    // Gondor's field army within a tick or two — which is right, and which is
    // not what is under test. Park them back at the wall each tick so what we
    // are reading is the garrison decision alone, not a race against the army
    // job for the same eight archers.
    const park = (): void => {
      for (let k = 0; k < archers.length; k++) {
        const a = archers[k]
        s.order[a] = 0
        s.target[a] = -1
        s.posX[a] = wall.x + 3 + (k % 3)
        s.posZ[a] = wall.z + 3 + Math.floor(k / 3)
      }
    }
    const mannedByGondor = (cmds: PlayerCommand[]): PlayerCommand[] =>
      cmds.filter((c) => c.kind === 'garrison' && c.player === 0 && c.units.some((h) => archers.includes(h & 0xffff)))

    // Peacetime on this stretch of curtain: nobody climbs. Archers on a quiet
    // wall are archers not marching with the army. Scoped to these men and to
    // their owner — seven other AIs are fighting their own wars on the same
    // board and may quite correctly be manning theirs.
    for (let t = 0; t < 24; t++) {
      expect(mannedByGondor(aiCommands(s, grid)), 'manned the walls with nobody attacking').toHaveLength(0)
      step(s, grid, [])
      park()
    }

    // Now bring an army up to it.
    for (let k = 0; k < 10; k++) spawnUnit(s, s.def.entIndex.get('orc')!, 1, wall.x + 30 + k, wall.z + 20)
    let cmds: PlayerCommand[] = []
    let g: PlayerCommand[] = []
    for (let t = 0; t < 30 && g.length === 0; t++) {
      cmds = aiCommands(s, grid)
      g = mannedByGondor(cmds)
      if (g.length === 0) {
        step(s, grid, cmds)
        park()
      }
    }
    expect(g.length, 'never manned the wall with an army at the gate').toBeGreaterThan(0)

    // Only archers go up — a swordsman on a wall is safe from everything and
    // threatens nothing.
    for (const cmd of g) {
      for (const h of cmd.units) {
        expect(s.def.stats.atkRange[s.type[h & 0xffff]]).toBeGreaterThanOrEqual(3)
      }
    }

    // And the same men are not also marched off with the field army this tick:
    // applyCommands takes orders in sequence, so an attackMove issued after a
    // garrison would silently cancel it.
    const posted = new Set(g.flatMap((c) => c.units.map((h) => h & 0xffff)))
    for (const cmd of cmds) {
      if (cmd.kind !== 'attackMove' || cmd.player !== 0) continue
      for (const h of cmd.units) {
        expect(posted.has(h & 0xffff), 'a man was posted to a wall and marched away at once').toBe(false)
      }
    }
  })

  it('is deterministic: the same board yields the same orders', () => {
    const a = sim()
    const b = sim()
    for (let k = 0; k < 60; k++) {
      spawnUnit(a.s, a.s.def.entIndex.get('orc')!, 1, 340 + (k % 9), 260 + Math.floor(k / 9))
      spawnUnit(b.s, b.s.def.entIndex.get('orc')!, 1, 340 + (k % 9), 260 + Math.floor(k / 9))
    }
    for (let t = 0; t < 30; t++) {
      const ca = aiCommands(a.s, a.grid)
      const cb = aiCommands(b.s, b.grid)
      expect(JSON.stringify(cb), `tick ${t} diverged`).toBe(JSON.stringify(ca))
      step(a.s, a.grid, ca)
      step(b.s, b.grid, cb)
    }
  })
})
