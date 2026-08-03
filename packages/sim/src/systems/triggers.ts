import { Kind, MAX_UNITS, Order, spawnUnit, type SimState } from '../state.ts'
import type { MapRegion, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { TICK_MS } from '../state.ts'
import { spawnHorde } from './economy.ts'
import { formationOffset, planPath } from './orders.ts'

// Deterministic trigger runtime. Compiled once at setup; evaluated in one
// pass per tick, trigger order then action order. All runtime flags are part
// of the hashed state.

export interface TriggerRuntime {
  defs: TriggerDef[]
  regions: MapRegion[]
  regionIdx: Map<string, number>
  trigIdx: Map<string, number>
  enabled: Uint8Array
  armed: Uint8Array // level-events (resourceReached) re-arm when false again
  timerNext: Int32Array // absolute tick, -1 = no timer event
  prevRegionMask: Int32Array // per entity, bit r = inside region r (≤ 30 regions)
  watchesRegions: boolean // any trigger actually listens for region entry?
  fired: Int32Array
}

export function compileTriggers(doc: RtsMapDoc): TriggerRuntime {
  const defs = doc.triggers ?? []
  const regions = doc.regions ?? []
  if (regions.length > 30) throw new Error('at most 30 regions supported')
  const regionIdx = new Map(regions.map((r, i) => [r.id, i]))
  const trigIdx = new Map(defs.map((t, i) => [t.id, i]))
  const enabled = new Uint8Array(defs.length)
  const timerNext = new Int32Array(defs.length).fill(-1)
  defs.forEach((t, i) => {
    enabled[i] = t.initiallyOn === false ? 0 : 1
    for (const ev of t.events) {
      if (ev.type === 'timer') {
        timerNext[i] = Math.max(1, Math.floor((ev.seconds * 1000) / TICK_MS))
      }
    }
  })
  return {
    defs,
    regions,
    regionIdx,
    trigIdx,
    enabled,
    armed: new Uint8Array(defs.length).fill(1),
    timerNext,
    // Indexed by ENTITY ID, so it has to cover every slot the sim can hand
    // out. At 1024 an entity above that id read undefined, which makes
    // `cur & ~undefined` collapse to `cur` — every such unit standing in a
    // region re-fired its enter event on every tick, forever.
    prevRegionMask: new Int32Array(MAX_UNITS),
    // A region is also just a query box for unitCountInRegion conditions. If
    // nothing listens for entry, skip the per-entity scan entirely rather
    // than walk every unit on the map each tick to build a list nobody reads.
    watchesRegions: defs.some((t) => t.events.some((ev) => ev.type === 'unitEntersRegion')),
    fired: new Int32Array(defs.length),
  }
}

function regionMaskOf(rt: TriggerRuntime, x: number, z: number): number {
  let m = 0
  for (let r = 0; r < rt.regions.length; r++) {
    const rg = rt.regions[r]
    if (x >= rg.x0 && x <= rg.x1 && z >= rg.z0 && z <= rg.z1) m |= 1 << r
  }
  return m
}

function unitsInRegion(
  s: SimState,
  rt: TriggerRuntime,
  region: number,
  owner: number | undefined,
  defIdx?: number,
): number[] {
  const rg = rt.regions[region]
  const out: number[] = []
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.hidden[i]) continue
    if (owner !== undefined && s.owner[i] !== owner) continue
    if (defIdx !== undefined && s.type[i] !== defIdx) continue
    if (s.posX[i] >= rg.x0 && s.posX[i] <= rg.x1 && s.posZ[i] >= rg.z0 && s.posZ[i] <= rg.z1) out.push(i)
  }
  return out
}

export function triggers(s: SimState, grid: WalkGrid): void {
  const rt = s.trig
  if (rt.defs.length === 0) return

  // current region masks + enter detection
  const entered: number[] = [] // packed (entity << 5) | region
  if (rt.watchesRegions && rt.regions.length > 0) {
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i]) {
        rt.prevRegionMask[i] = 0
        continue
      }
      const cur = regionMaskOf(rt, s.posX[i], s.posZ[i])
      const fresh = cur & ~rt.prevRegionMask[i]
      if (fresh !== 0) {
        for (let r = 0; r < rt.regions.length; r++) {
          if (fresh & (1 << r)) entered.push((i << 5) | r)
        }
      }
      rt.prevRegionMask[i] = cur
    }
  }

  const deaths = s.events.filter((e) => e.t === 'died')

  for (let ti = 0; ti < rt.defs.length; ti++) {
    if (rt.enabled[ti] !== 1) continue
    const t = rt.defs[ti]

    // ---- events (ANY-of) ----
    let firing = false
    let levelActive = false // for arming semantics
    for (const ev of t.events) {
      if (ev.type === 'mapInit') {
        if (s.tick === 0) firing = true
      } else if (ev.type === 'timer') {
        if (rt.timerNext[ti] >= 0 && s.tick >= rt.timerNext[ti]) {
          firing = true
          rt.timerNext[ti] = ev.periodic
            ? rt.timerNext[ti] + Math.max(1, Math.floor((ev.seconds * 1000) / TICK_MS))
            : -1
        }
      } else if (ev.type === 'unitDies') {
        for (const d of deaths) {
          if (d.t !== 'died') continue
          if (ev.owner !== undefined && d.owner !== ev.owner) continue
          if (ev.def !== undefined && s.def.entIndex.get(ev.def) !== d.type) continue
          firing = true
        }
      } else if (ev.type === 'unitEntersRegion') {
        const r = rt.regionIdx.get(ev.region)
        if (r === undefined) continue
        for (const packed of entered) {
          if ((packed & 31) !== r) continue
          const id = packed >> 5
          if (ev.owner !== undefined && s.owner[id] !== ev.owner) continue
          if (ev.def !== undefined && s.def.entIndex.get(ev.def) !== s.type[id]) continue
          firing = true
        }
      } else if (ev.type === 'resourceReached') {
        const r = s.def.resIndex.get(ev.resource)
        if (r === undefined) continue
        const have = s.resources[ev.owner * s.def.resources.length + r]
        if (have >= ev.amount) {
          levelActive = true
          if (rt.armed[ti] === 1) firing = true
        }
      }
    }
    // re-arm level events once inactive
    if (!levelActive && rt.armed[ti] === 0) rt.armed[ti] = 1
    if (!firing) continue
    if (levelActive) rt.armed[ti] = 0

    // ---- conditions (ALL-of) ----
    let pass = true
    for (const c of t.conditions) {
      if (c.type === 'resourceCmp') {
        const r = s.def.resIndex.get(c.resource)
        if (r === undefined) {
          pass = false
          break
        }
        const have = s.resources[c.owner * s.def.resources.length + r]
        if (c.op === '>=' ? have < c.amount : have > c.amount) pass = false
      } else if (c.type === 'unitCountInRegion') {
        const r = rt.regionIdx.get(c.region)
        if (r === undefined) {
          pass = false
          break
        }
        // An unknown def counts nothing rather than everything: a typo must not
        // quietly turn "no fortress left" into "no entity left".
        const dIdx = c.def === undefined ? undefined : (s.def.entIndex.get(c.def) ?? -1)
        const n = unitsInRegion(s, rt, r, c.owner, dIdx).length
        if (c.op === '>=' ? n < c.count : n > c.count) pass = false
      } else if (c.type === 'elapsed') {
        if (s.tick * TICK_MS < c.seconds * 1000) pass = false
      }
      if (!pass) break
    }
    if (!pass) continue

    // ---- actions (in order) ----
    rt.fired[ti]++
    for (const a of t.actions) {
      if (a.type === 'spawnUnits') {
        const defIdx = s.def.entIndex.get(a.def)
        if (defIdx === undefined || a.owner < 0 || a.owner > 7) continue
        // absent-player content is skipped unless the map marks it `always`
        // (reserved AI slots — lane creeps, neutral garrisons)
        if (a.owner >= s.playerCount && a.always !== true) continue
        let ax: number
        let az: number
        if ('region' in a.at) {
          const r = rt.regionIdx.get(a.at.region)
          if (r === undefined) continue
          const rg = rt.regions[r]
          ax = (rg.x0 + rg.x1) / 2
          az = (rg.z0 + rg.z1) / 2
        } else {
          ax = a.at.x
          az = a.at.z
        }
        // A horde ticket spawns the whole battalion, bound as one horde —
        // the same rule setup.ts applies to a pre-placed army. Without it a
        // timed wave on a battalion-centric map would arrive as loose
        // soldiers with no formation, no veterancy track and no command-point
        // cost, playing by different rules than anything trained at a keep.
        const isHorde = s.def.hordeUnit[defIdx] >= 0
        // Battalions need room to form up; loose units pack tight.
        const spread = isHorde ? 6 : 1.15
        let dirX = a.facing?.x ?? 0
        let dirZ = a.facing?.z ?? 1
        const dl = Math.sqrt(dirX * dirX + dirZ * dirZ)
        if (dl < 1e-9) {
          dirX = 0
          dirZ = 1
        } else {
          dirX /= dl
          dirZ /= dl
        }
        for (let k = 0; k < Math.min(a.count, 64); k++) {
          const [ox, oz] = formationOffset(k, spread)
          let x = ax + ox
          let z = az + oz
          if (!grid.isWalkableWorld(x, z)) {
            const near = grid.nearestWalkable(grid.cellX(x), grid.cellZ(z))
            if (!near) continue
            x = grid.centerX(near[0])
            z = grid.centerZ(near[1])
          }
          if (isHorde) spawnHorde(s, grid, defIdx, a.owner, x, z, dirX, dirZ)
          else spawnUnit(s, defIdx, a.owner, x, z)
        }
      } else if (a.type === 'orderUnits') {
        const r = rt.regionIdx.get(a.region)
        if (r === undefined) continue
        for (const id of unitsInRegion(s, rt, r, a.owner)) {
          if (s.kind[id] !== Kind.Unit) continue
          s.order[id] = a.order === 'move' ? Order.Move : Order.AttackMove
          s.destX[id] = a.x
          s.destZ[id] = a.z
          s.target[id] = -1
          s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], a.x, a.z)
          s.progress[id] = 1000000
        }
      } else if (a.type === 'victory') {
        if (s.winner < 0) s.winner = s.playerTeam[a.player & 7]
      } else if (a.type === 'defeat') {
        // the losing player's team is out; with two teams the other team wins
        if (s.winner < 0) {
          const losing = s.playerTeam[a.player & 7]
          for (let t = 0; t < 8; t++) {
            if (t !== losing && s.teamHadAny[t]) {
              s.winner = t
              break
            }
          }
        }
      } else if (a.type === 'message') {
        s.events.push({ t: 'message', text: a.text, player: a.to === 'all' ? -1 : a.to })
      } else if (a.type === 'modifyResource') {
        const r = s.def.resIndex.get(a.resource)
        if (r === undefined) continue
        const k = a.owner * s.def.resources.length + r
        s.resources[k] = Math.max(0, s.resources[k] + a.delta)
      } else if (a.type === 'panCamera') {
        s.events.push({ t: 'panCamera', player: a.player, x: a.x, z: a.z })
      } else if (a.type === 'setTrigger') {
        const other = rt.trigIdx.get(a.trigger)
        if (other !== undefined) rt.enabled[other] = a.on ? 1 : 0
      }
    }
    if (t.once) rt.enabled[ti] = 0
  }
}
