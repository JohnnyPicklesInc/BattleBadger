import { describe, expect, it } from 'vitest'
import { abStride, setupMatch, step, walkGridFromDoc, type SimState } from '@battlebadger/sim'
import { generateMiddleEarth } from '../../sim/src/mapgen/middleEarth.ts'
import { applySnapshot, snapshotBytes, writeSnapshot } from '../src/sim/snapshot.ts'

// The sim itself cannot desync by moving to a worker: the worker runs the same
// step() on the same state. The risk is entirely in the SNAPSHOT — a field the
// client reads that nobody remembered to carry across, or carried at the wrong
// offset. That kind of bug does not throw. It draws a unit at the origin, or
// leaves a dead battalion on the minimap, or makes a build queue look empty,
// and it does it only once the battle is big enough to have that field matter.
//
// So: run one sim, mirror it through the wire format into a second, and demand
// the two agree on every field the client is known to read.

const CLIENT_READS_F64 = ['posX', 'posZ', 'velX', 'velZ', 'faceX', 'faceZ'] as const
const CLIENT_READS_I32 = [
  'type', 'owner', 'hp', 'target', 'hordeOf', 'plotHost', 'buildTicks',
  'lastAttackTick', 'swooping', 'onWall', 'stun', 'carryAmt', 'queueTicks',
] as const
const CLIENT_READS_U8 = ['alive', 'hidden', 'kind', 'gateMode', 'gateOpen'] as const

/** Two sims from one map: one played, one only ever fed snapshots. */
function pair(): { live: SimState; view: SimState; grid: ReturnType<typeof walkGridFromDoc>; stride: number } {
  const doc = generateMiddleEarth(20260803)
  const grid = walkGridFromDoc(doc)
  const live = setupMatch(doc, grid, 8)
  const view = setupMatch(doc, walkGridFromDoc(doc), 8)
  for (let p = 0; p < 8; p++) live.aiLevel[p] = 2
  return { live, view, grid, stride: abStride(live.def) }
}

function mirror(live: SimState, view: SimState, stride: number): void {
  const buf = new ArrayBuffer(snapshotBytes(live, stride))
  const sides = writeSnapshot(live, stride, buf)
  applySnapshot(view, stride, { sides, buf })
}

describe('the sim snapshot', () => {
  it('carries every field the client reads, through a real battle', () => {
    const { live, view, grid, stride } = pair()
    // Far enough in that hordes have died, shells are in the air, buildings are
    // queueing and the ability cooldown table is not all zeroes.
    for (let t = 0; t < 900; t++) {
      step(live, grid, [])
      if (t % 100 === 0) mirror(live, view, stride)
    }
    mirror(live, view, stride)

    expect(view.tick, 'tick').toBe(live.tick)
    expect(view.count, 'count').toBe(live.count)
    expect(view.winner, 'winner').toBe(live.winner)
    expect(view.count, 'the battle never got big enough to be worth testing').toBeGreaterThan(300)

    const n = live.count
    for (const f of [...CLIENT_READS_F64, ...CLIENT_READS_I32, ...CLIENT_READS_U8]) {
      for (let i = 0; i < n; i++) {
        if (view[f][i] !== live[f][i]) {
          expect.fail(`${f}[${i}] is ${view[f][i]} on the view and ${live[f][i]} in the sim`)
        }
      }
    }
    // Ability cooldowns are a strided table; a stride mismatch aliases one
    // ability's cooldown onto another and shows up as a greyed-out button.
    for (let i = 0; i < n * stride; i++) {
      if (view.abCd[i] !== live.abCd[i]) expect.fail(`abCd[${i}] disagrees`)
    }
  })

  it('carries the horde store, which is what the HUD counts and input selects by', () => {
    const { live, view, grid, stride } = pair()
    for (let t = 0; t < 600; t++) step(live, grid, [])
    mirror(live, view, stride)

    expect(view.hordes.count).toBe(live.hordes.count)
    let checked = 0
    for (let h = 0; h < live.hordes.count; h++) {
      expect(view.hordes.alive[h], `horde ${h} alive`).toBe(live.hordes.alive[h])
      if (live.hordes.alive[h] !== 1) continue
      checked++
      expect(view.hordes.defIdx[h], `horde ${h} defIdx`).toBe(live.hordes.defIdx[h])
      expect(view.hordes.level[h], `horde ${h} level`).toBe(live.hordes.level[h])
      expect(view.hordes.owner[h], `horde ${h} owner`).toBe(live.hordes.owner[h])
      expect(view.hordes.members[h], `horde ${h} members`).toEqual(live.hordes.members[h])
    }
    expect(checked, 'no live hordes to check').toBeGreaterThan(20)
  })

  it('carries shells in flight and the doodads harvesting eats', () => {
    const { live, view, grid, stride } = pair()
    let sawShell = false
    for (let t = 0; t < 900; t++) {
      step(live, grid, [])
      if (live.projectiles.count > 0) sawShell = true
    }
    mirror(live, view, stride)
    expect(sawShell, 'nothing ever shot at anything').toBe(true)
    expect(view.projectiles.count).toBe(live.projectiles.count)
    for (let p = 0; p < live.projectiles.count; p++) {
      expect(view.projectiles.alive[p], `shell ${p} alive`).toBe(live.projectiles.alive[p])
      if (live.projectiles.alive[p] !== 1) continue
      expect(view.projectiles.x[p]).toBe(live.projectiles.x[p])
      expect(view.projectiles.tgtX[p]).toBe(live.projectiles.tgtX[p])
      expect(view.projectiles.srcType[p]).toBe(live.projectiles.srcType[p])
    }
    expect(view.doodads.count).toBe(live.doodads.count)
    for (let d = 0; d < live.doodads.count; d++) {
      expect(view.doodads.amount[d], `doodad ${d} amount`).toBe(live.doodads.amount[d])
      expect(view.doodads.alive[d], `doodad ${d} alive`).toBe(live.doodads.alive[d])
    }
  })

  it('does not leave last tick’s dead lying around when the count shrinks', () => {
    // `count` is a high-water mark that only grows, so a shrinking population
    // leaves stale slots behind. A view that keeps a corpse's `alive` from two
    // ticks ago draws it — the classic ghost-unit bug, and the reason the
    // apply pass clears before it fills.
    const { live, view, grid, stride } = pair()
    for (let t = 0; t < 400; t++) step(live, grid, [])
    mirror(live, view, stride)

    // Kill a battalion outright and mirror again.
    let killed = 0
    for (let h = 0; h < live.hordes.count && killed === 0; h++) {
      if (live.hordes.alive[h] !== 1) continue
      for (const id of live.hordes.members[h]) live.hp[id] = 0
      killed = live.hordes.members[h].length
    }
    expect(killed, 'found no battalion to kill').toBeGreaterThan(0)
    for (let t = 0; t < 3; t++) step(live, grid, [])
    mirror(live, view, stride)

    for (let i = 0; i < live.count; i++) {
      expect(view.alive[i], `entity ${i} outlived the sim`).toBe(live.alive[i])
    }
    for (let h = 0; h < live.hordes.count; h++) {
      expect(view.hordes.alive[h], `horde ${h} outlived the sim`).toBe(live.hordes.alive[h])
    }
  })

  it('costs the main thread almost nothing to apply', () => {
    // The one cost the worker ADDS to the main thread. If this is not small,
    // the whole exercise is moving work from one place on the critical path to
    // another place on the critical path.
    const { live, view, grid, stride } = pair()
    for (let t = 0; t < 900; t++) step(live, grid, [])
    const buf = new ArrayBuffer(snapshotBytes(live, stride))
    const sides = writeSnapshot(live, stride, buf)

    const N = 40
    const t0 = performance.now()
    for (let k = 0; k < N; k++) applySnapshot(view, stride, { sides, buf })
    const perApply = (performance.now() - t0) / N

    // A tick is 100 ms and a frame is 16. Anything approaching a millisecond
    // here would be worth knowing about; the real figure is well under it.
    expect(perApply, `applySnapshot took ${perApply.toFixed(2)} ms at ${live.count} entities`).toBeLessThan(3)
  })
})
