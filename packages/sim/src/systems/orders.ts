import type { PlayerCommand } from '../commands.ts'
import {
  Harv,
  Kind,
  Order,
  abStride,
  allied,
  releaseHarvest,
  resolveHandle,
  type SimState,
  type UnitPath,
  TICK_S,
} from '../state.ts'
import { findPath, stringPull } from '../path/astar.ts'
import type { WalkGrid } from '../path/walkgrid.ts'
import { nodeUsable } from './harvest.ts'
import {
  canAfford,
  deduct,
  freePlotAt,
  plotClaimable,
  requiresMet,
  spawnBuilding,
  supplyRoom,
  validPlacement,
} from './economy.ts'
import {
  activeFormation,
  formationSlot,
  formationWorld,
  hordeFootprint,
  hordeSpacing,
  unitSpeed,
} from './hordes.ts'

// Square-spiral formation offsets (integer grid — no trig, deterministic).
// Slot 0 is (0,0); subsequent slots spiral outward.
export function formationOffset(slot: number, spacing: number): [number, number] {
  if (slot === 0) return [0, 0]
  let x = 0
  let y = 0
  let dx = 1
  let dy = 0
  let segLen = 1
  let seg = 0
  let turns = 0
  for (let i = 0; i < slot; i++) {
    x += dx
    y += dy
    seg++
    if (seg === segLen) {
      seg = 0
      const t = dx
      dx = -dy
      dy = t
      turns++
      if (turns % 2 === 0) segLen++
    }
  }
  return [x * spacing, y * spacing]
}

export function planPath(
  grid: WalkGrid,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): UnitPath | null {
  if (grid.lineWalkable(fromX, fromZ, toX, toZ)) {
    return { pts: [toX, toZ], i: 0 }
  }
  let scx = grid.cellX(fromX)
  let scy = grid.cellZ(fromZ)
  if (!grid.isWalkable(scx, scy)) {
    const near = grid.nearestWalkable(scx, scy)
    if (!near) return null
    scx = near[0]
    scy = near[1]
  }
  let tcx = grid.cellX(toX)
  let tcy = grid.cellZ(toZ)
  if (!grid.isWalkable(tcx, tcy)) {
    const near = grid.nearestWalkable(tcx, tcy)
    if (!near) return null
    tcx = near[0]
    tcy = near[1]
    toX = grid.centerX(tcx)
    toZ = grid.centerZ(tcy)
  }
  const cells = findPath(grid, scx, scy, tcx, tcy)
  if (!cells) return null
  const pts = stringPull(grid, cells, fromX, fromZ)
  // Snap the final waypoint to the exact requested destination when visible.
  if (pts.length >= 2) {
    const lx = pts[pts.length - 2]
    const lz = pts[pts.length - 1]
    if (grid.lineWalkable(lx, lz, toX, toZ)) {
      pts[pts.length - 2] = toX
      pts[pts.length - 1] = toZ
    }
  }
  return pts.length > 0 ? { pts, i: 0 } : null
}

// Resolve a command's unit handles to live, owned, mobile entity ids.
// Ordering one soldier orders his whole horde — the battalion is the unit of
// play, so a stray click never splits a formation.
function resolveUnits(s: SimState, c: PlayerCommand): number[] {
  const seen = new Set<number>()
  const ids: number[] = []
  const add = (id: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const raw of c.units) {
    const id = resolveHandle(s, raw | 0)
    if (id < 0 || s.owner[id] !== c.player) continue
    const horde = s.hordeOf[id]
    if (horde >= 0) for (const m of s.hordes.members[horde]) add(m)
    else add(id)
  }
  ids.sort((a, b) => a - b)
  return ids
}

// Group ids into their hordes (in member order) plus everything unattached.
function partitionHordes(s: SimState, ids: number[]): { hordes: number[]; loose: number[] } {
  const hordes: number[] = []
  const loose: number[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    const h = s.hordeOf[id]
    if (h < 0) loose.push(id)
    else if (!seen.has(h)) {
      seen.add(h)
      hordes.push(h)
    }
  }
  return { hordes, loose }
}

export function applyCommands(s: SimState, grid: WalkGrid, cmds: PlayerCommand[]): void {
  for (const c of cmds) {
    // Plot placement (BFME): no worker walks anywhere and nothing needs to be
    // selected — the plot's accepts list, tech and cost are the whole gate.
    // Handled before selection resolution so neutral plots work for everyone.
    if (c.kind === 'build' && s.def.stats.plotPlaced[(c.def ?? -1) | 0]) {
      const defIdx = (c.def ?? -1) | 0
      if (!requiresMet(s, c.player, defIdx)) continue
      if (!canAfford(s, c.player, defIdx)) continue
      if (!validPlacement(s, grid, defIdx, c.x, c.z, c.player)) continue
      // A plot is not a licence to build: you must hold the ground around it.
      const pad = freePlotAt(s, defIdx, c.player, c.x, c.z)
      if (pad < 0 || !plotClaimable(s, c.player, pad)) continue
      deduct(s, c.player, defIdx, 1)
      spawnBuilding(s, grid, defIdx, c.player, c.x, c.z, true)
      continue
    }

    const ids = resolveUnits(s, c)
    if (ids.length === 0) continue

    if (c.kind === 'stop') {
      for (const id of ids) {
        if (s.hidden[id]) continue
        releaseHarvest(s, id)
        s.order[id] = Order.Idle
        s.paths[id] = null
        s.target[id] = -1
        s.forced[id] = 0
        s.followTarget[id] = -1
        s.homeX[id] = s.posX[id]
        s.homeZ[id] = s.posZ[id]
        s.stuck[id] = 0
      }
      continue
    }

    if (c.kind === 'hold') {
      for (const id of ids) {
        if (s.hidden[id] || s.kind[id] !== Kind.Unit) continue
        releaseHarvest(s, id)
        s.order[id] = Order.Hold
        s.paths[id] = null
        s.forced[id] = 0
        s.followTarget[id] = -1
        s.homeX[id] = s.posX[id]
        s.homeZ[id] = s.posZ[id]
        s.stuck[id] = 0
      }
      continue
    }

    // Attack / follow: lock onto one specific entity.
    if (c.kind === 'attack' || c.kind === 'follow') {
      const tgt = resolveHandle(s, (c.target ?? -1) | 0)
      if (tgt < 0) continue
      const isAlly = allied(s, s.owner[tgt], c.player)
      if (c.kind === 'attack' && (isAlly || s.def.stats.untargetable[s.type[tgt]])) continue
      if (c.kind === 'follow' && !isAlly) continue
      for (const id of ids) {
        if (s.hidden[id] || s.kind[id] !== Kind.Unit || id === tgt) continue
        releaseHarvest(s, id)
        s.paths[id] = null
        s.stuck[id] = 0
        s.repathed[id] = 0
        s.progress[id] = 1000000
        if (c.kind === 'attack') {
          s.order[id] = Order.Attack
          s.target[id] = tgt
          s.forced[id] = 1
          s.followTarget[id] = -1
        } else {
          s.order[id] = Order.Follow
          s.followTarget[id] = tgt
          s.target[id] = -1
          s.forced[id] = 0
        }
      }
      continue
    }

    if (c.kind === 'patrol') {
      for (const id of ids) {
        if (s.hidden[id] || s.kind[id] !== Kind.Unit) continue
        releaseHarvest(s, id)
        // patrol runs between where the unit stands and the clicked point
        s.order[id] = Order.Patrol
        s.patrolX[id] = s.posX[id]
        s.patrolZ[id] = s.posZ[id]
        s.destX[id] = c.x
        s.destZ[id] = c.z
        s.homeX[id] = s.posX[id]
        s.homeZ[id] = s.posZ[id]
        s.target[id] = -1
        s.forced[id] = 0
        s.followTarget[id] = -1
        s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], c.x, c.z)
        s.stuck[id] = 0
        s.repathed[id] = 0
        s.progress[id] = 1000000
      }
      continue
    }

    if (c.kind === 'harvest') {
      const nodeRef = (c.target ?? 0) | 0
      const n = -1 - nodeRef
      if (n < 0 || n >= s.doodads.count || s.doodads.alive[n] !== 1) continue
      const nd = s.def.entities[s.doodads.defIdx[n]].resourceNode
      if (!nd || s.doodads.amount[n] === 0 || !nodeUsable(s, c.player, n)) continue
      for (const id of ids) {
        if (s.hidden[id]) continue
        const h = s.def.entities[s.type[id]].harvester
        if (!h || !h.nodeTags.includes(nd.tag)) continue
        releaseHarvest(s, id)
        s.harvState[id] = Harv.ToNode
        s.harvNode[id] = n
        s.target[id] = -1
        s.order[id] = Order.Idle
        s.paths[id] = null
      }
      continue
    }

    if (c.kind === 'ability') {
      const abIdx = (c.ability ?? -1) | 0
      const ab = s.def.abilities[abIdx]
      if (!ab) continue
      const nAb = abStride(s.def)
      // Sustained ally buffs/heals ride the combat loop: point the caster at
      // the ally and let reach + allyAb do the rest.
      if (ab.target === 'ally') {
        const tgt = resolveHandle(s, (c.target ?? -1) | 0)
        if (tgt < 0 || !allied(s, s.owner[tgt], c.player)) continue
        for (const id of ids) {
          if (id === tgt) continue
          if (!s.def.entAbilities[s.type[id]].includes(abIdx)) continue
          s.order[id] = Order.AttackMove
          s.target[id] = tgt
          s.paths[id] = null
          s.stuck[id] = 0
        }
        continue
      }

      // 'enemy' / 'point' / 'self' are one-shot casts — arm the caster and let
      // systems/casts.ts walk it into range and fire.
      let tgt = -1
      if (ab.target === 'enemy') {
        tgt = resolveHandle(s, (c.target ?? -1) | 0)
        if (tgt < 0 || allied(s, s.owner[tgt], c.player)) continue
        if (s.def.stats.untargetable[s.type[tgt]]) continue
      }
      for (const id of ids) {
        if (id === tgt) continue
        if (!s.def.entAbilities[s.type[id]].includes(abIdx)) continue
        if (s.abCd[id * nAb + abIdx] > 0) continue // still cooling down
        s.castAb[id] = abIdx
        s.castTarget[id] = tgt
        s.castX[id] = c.x
        s.castZ[id] = c.z
        s.paths[id] = null
        s.stuck[id] = 0
      }
      continue
    }

    if (c.kind === 'build') {
      const defIdx = (c.def ?? -1) | 0
      const e = s.def.entities[defIdx]
      if (!e || e.kind !== 'building') continue
      const builders = ids.filter(
        (id) => s.kind[id] === Kind.Unit && !s.hidden[id] && s.def.buildsIdx[s.type[id]].includes(defIdx),
      )
      if (builders.length === 0) continue
      if (!requiresMet(s, c.player, defIdx)) continue
      if (!canAfford(s, c.player, defIdx)) continue
      if (!validPlacement(s, grid, defIdx, c.x, c.z, c.player)) continue
      deduct(s, c.player, defIdx, 1)
      const b = spawnBuilding(s, grid, defIdx, c.player, c.x, c.z, true)
      // send the builders to the site edge
      for (const id of builders) {
        releaseHarvest(s, id)
        s.order[id] = Order.Move
        s.destX[id] = s.posX[b]
        s.destZ[id] = s.posZ[b]
        s.target[id] = -1
        s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], s.posX[b], s.posZ[b])
        s.stuck[id] = 0
        s.repathed[id] = 0
        s.progress[id] = 1000000
      }
      continue
    }

    if (c.kind === 'train') {
      const defIdx = (c.def ?? -1) | 0
      const e = s.def.entities[defIdx]
      if (!e || e.kind !== 'unit') continue
      for (const b of ids) {
        if (s.kind[b] !== Kind.Building || s.buildTicks[b] > 0) continue
        const trainer = s.def.entities[s.type[b]].trainer
        if (!trainer || !s.def.trainsIdx[s.type[b]].includes(defIdx)) continue
        if (s.queue[b].length >= trainer.queueSize) continue
        if (!requiresMet(s, c.player, defIdx)) continue
        if (!supplyRoom(s, c.player, defIdx)) continue
        if (!canAfford(s, c.player, defIdx)) continue
        deduct(s, c.player, defIdx, 1)
        s.queue[b].push(defIdx)
        break // one command queues one unit at one building
      }
      continue
    }

    if (c.kind === 'cancel') {
      const qi = (c.target ?? -1) | 0
      for (const b of ids) {
        if (s.kind[b] !== Kind.Building) continue
        if (qi < 0 || qi >= s.queue[b].length) continue
        deduct(s, c.player, s.queue[b][qi], -1) // refund
        s.queue[b].splice(qi, 1)
        if (qi === 0) s.queueTicks[b] = 0
        break
      }
      continue
    }

    // Formation stance: re-forms in place so the change is immediately visible.
    if (c.kind === 'formation') {
      const want = (c.def ?? 0) | 0
      for (const h of partitionHordes(s, ids).hordes) {
        const forms = s.def.hordeFormations[s.hordes.defIdx[h]]
        if (forms.length === 0 || want < 0 || want >= forms.length) continue
        s.hordes.formation[h] = want
        const members = s.hordes.members[h].filter((id) => s.alive[id] && !s.hidden[id])
        if (members.length === 0) continue
        let cx = 0
        let cz = 0
        for (const id of members) {
          cx += s.posX[id]
          cz += s.posZ[id]
        }
        cx /= members.length
        cz /= members.length
        const fx = s.hordes.faceX[h]
        const fz = s.hordes.faceZ[h]
        const spacing = hordeSpacing(s, h)
        members.forEach((id, slot) => {
          const [ox, oz] = formationSlot(forms[want].kind, slot, members.length, spacing)
          const [wx, wz] = formationWorld(cx, cz, fx, fz, ox, oz)
          if (!grid.isWalkableWorld(wx, wz)) return
          releaseHarvest(s, id)
          s.order[id] = Order.Move
          s.destX[id] = wx
          s.destZ[id] = wz
          s.homeX[id] = wx
          s.homeZ[id] = wz
          s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], wx, wz)
          s.stuck[id] = 0
          s.repathed[id] = 0
          s.progress[id] = 1000000
        })
      }
      continue
    }

    if (c.kind === 'rally') {
      for (const b of ids) {
        if (s.kind[b] !== Kind.Building) continue
        s.rallyX[b] = c.x
        s.rallyZ[b] = c.z
      }
      continue
    }

    // move / attackMove
    const order = c.kind === 'move' ? Order.Move : Order.AttackMove
    const sendTo = (id: number, dx: number, dz: number): void => {
      releaseHarvest(s, id)
      let tx = dx
      let tz = dz
      if (!grid.isWalkableWorld(tx, tz)) {
        tx = c.x
        tz = c.z
      }
      s.order[id] = order
      s.destX[id] = tx
      s.destZ[id] = tz
      s.homeX[id] = tx
      s.homeZ[id] = tz
      s.paths[id] = planPath(grid, s.posX[id], s.posZ[id], tx, tz)
      s.target[id] = -1
      s.forced[id] = 0
      s.followTarget[id] = -1
      s.stuck[id] = 0
      s.repathed[id] = 0
      s.progress[id] = 1000000
    }

    const parts = partitionHordes(s, ids)
    // Each horde forms up in its stance, facing the way it is being sent.
    // Several hordes ordered to one point stagger by footprint so they don't
    // pile into each other.
    parts.hordes.forEach((h, hi) => {
      const members = s.hordes.members[h].filter((id) => s.alive[id] && !s.hidden[id])
      if (members.length === 0) return
      let cx = 0
      let cz = 0
      for (const id of members) {
        cx += s.posX[id]
        cz += s.posZ[id]
      }
      cx /= members.length
      cz /= members.length
      const [gx, gz] = formationOffset(hi, hordeFootprint(s, h))
      const aimX = c.x + gx
      const aimZ = c.z + gz
      let fx = aimX - cx
      let fz = aimZ - cz
      const d = Math.sqrt(fx * fx + fz * fz)
      if (d > 0.001) {
        fx /= d
        fz /= d
      } else {
        fx = s.hordes.faceX[h]
        fz = s.hordes.faceZ[h]
      }
      s.hordes.faceX[h] = fx
      s.hordes.faceZ[h] = fz
      s.hordes.destX[h] = aimX
      s.hordes.destZ[h] = aimZ
      const kind = activeFormation(s, h)?.kind ?? 0
      const spacing = hordeSpacing(s, h)
      members.forEach((id, slot) => {
        const [ox, oz] = formationSlot(kind, slot, members.length, spacing)
        const [wx, wz] = formationWorld(aimX, aimZ, fx, fz, ox, oz)
        sendTo(id, wx, wz)
      })
    })

    // loose units keep the old spiral packing
    let slot = 0
    for (const id of parts.loose) {
      if (s.kind[id] !== Kind.Unit || s.hidden[id]) continue
      const [ox, oz] = formationOffset(slot++, 1.1)
      sendTo(id, c.x + ox, c.z + oz)
    }
  }
}

// Reach distance for unit i against its current target (ability vs weapon).
export function targetReach(s: SimState, i: number, tgt: number): number {
  const st = s.def.stats
  const ally = allied(s, s.owner[tgt], s.owner[i])
  const range = ally && st.allyAb[s.type[i]] >= 0 ? s.def.abilities[st.allyAb[s.type[i]]].range : st.atkRange[s.type[i]]
  return range + st.radius[s.type[i]] + st.radius[s.type[tgt]]
}

// Sets desired velocity for this tick from current order/target/path.
export function updateOrders(s: SimState, grid: WalkGrid): void {
  const st = s.def.stats
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Unit) continue
    const maxStep = unitSpeed(s, i) * TICK_S
    let desX = 0
    let desZ = 0

    // Knocked down: no stepping until it is back on its feet.
    if (s.stun[i] > 0) {
      s.velX[i] = 0
      s.velZ[i] = 0
      continue
    }

    // Hold position: fight from where you stand, never step.
    if (s.order[i] === Order.Hold) {
      s.velX[i] = 0
      s.velZ[i] = 0
      continue
    }

    // Follow: keep station near the ally; drop the order when they die.
    if (s.order[i] === Order.Follow) {
      const f = s.followTarget[i]
      if (f < 0 || !s.alive[f]) {
        s.order[i] = Order.Idle
        s.followTarget[i] = -1
      } else if (s.target[i] < 0) {
        const keep = st.radius[s.type[i]] + st.radius[s.type[f]] + 1.6
        const dx = s.posX[f] - s.posX[i]
        const dz = s.posZ[f] - s.posZ[i]
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > keep) {
          const step = Math.min(maxStep, d - keep)
          desX = (dx / d) * step
          desZ = (dz / d) * step
          s.faceX[i] = dx / d
          s.faceZ[i] = dz / d
        }
        s.homeX[i] = s.posX[i]
        s.homeZ[i] = s.posZ[i]
        s.velX[i] = desX
        s.velZ[i] = desZ
        continue
      }
    }

    const tgt = s.target[i]
    if (tgt >= 0) {
      // Chase target until within reach (edge to edge).
      const dx = s.posX[tgt] - s.posX[i]
      const dz = s.posZ[tgt] - s.posZ[i]
      const d = Math.sqrt(dx * dx + dz * dz)
      // Cavalry with an impact ready rides all the way in: stopping politely
      // at weapon reach is exactly why a horse never ran anybody over.
      const st2 = s.def.stats
      const canCharge = st2.chgMinSpeed[s.type[i]] > 0 && s.chargeCd[i] === 0
      const reach = canCharge
        ? st2.radius[s.type[i]] + st2.radius[s.type[tgt]]
        : targetReach(s, i, tgt)
      if (d > reach && d > 0.0001) {
        const step = Math.min(maxStep, d - reach)
        desX = (dx / d) * step
        desZ = (dz / d) * step
      }
      if (d > 0.0001) {
        s.faceX[i] = dx / d
        s.faceZ[i] = dz / d
      }
    } else {
      let p = s.paths[i]
      if (!p) {
        // an attack/follow order ends when its subject is gone
        if (s.order[i] === Order.Attack || s.order[i] === Order.Follow) {
          s.order[i] = Order.Idle
          s.followTarget[i] = -1
        }
        // Guard return: only a unit that actually left its post to fight walks
        // back. Units merely jostled by the crowd stay put (no march-back churn).
        if (s.order[i] === Order.Idle && s.chased[i] === 1) {
          const dxh = s.homeX[i] - s.posX[i]
          const dzh = s.homeZ[i] - s.posZ[i]
          if (dxh * dxh + dzh * dzh > 2.5 * 2.5) {
            p = planPath(grid, s.posX[i], s.posZ[i], s.homeX[i], s.homeZ[i])
            s.paths[i] = p
            s.destX[i] = s.homeX[i]
            s.destZ[i] = s.homeZ[i]
            s.repathed[i] = 0
            s.progress[i] = 1000000
          }
          if (!p) s.chased[i] = 0
        }
      }
      if (p) {
        // Advance waypoints.
        for (;;) {
          const wx = p.pts[p.i * 2]
          const wz = p.pts[p.i * 2 + 1]
          const dx = wx - s.posX[i]
          const dz = wz - s.posZ[i]
          const d = Math.sqrt(dx * dx + dz * dz)
          const last = p.i * 2 + 2 >= p.pts.length
          const arrive = last ? 0.28 : 0.55
          if (d <= arrive) {
            if (last) {
              s.paths[i] = null
              if (s.order[i] === Order.Patrol) {
                // swap ends and walk back — patrol never finishes
                const bx = s.patrolX[i]
                const bz = s.patrolZ[i]
                s.patrolX[i] = s.destX[i]
                s.patrolZ[i] = s.destZ[i]
                s.destX[i] = bx
                s.destZ[i] = bz
                s.homeX[i] = s.posX[i]
                s.homeZ[i] = s.posZ[i]
                s.paths[i] = planPath(grid, s.posX[i], s.posZ[i], bx, bz)
                s.progress[i] = 1000000
              } else {
                s.order[i] = Order.Idle
                s.homeX[i] = s.posX[i]
                s.homeZ[i] = s.posZ[i]
                s.chased[i] = 0 // back at the post
              }
              break
            }
            p.i++
            continue
          }
          const step = Math.min(maxStep, d)
          desX = (dx / d) * step
          desZ = (dz / d) * step
          break
        }
      }
    }

    s.velX[i] = desX
    s.velZ[i] = desZ
  }
}

// Stuck handling based on net progress toward the destination — tolerant of
// slow shoving through crowds. A stuck unit repaths once, then settles.
export function updateStuck(s: SimState, grid: WalkGrid): void {
  for (let i = 0; i < s.count; i++) {
    if (!s.alive[i] || s.kind[i] !== Kind.Unit) continue
    // idle-without-a-path (or chasing) units aren't "stuck"; idle units walking
    // home still are
    if ((s.order[i] === Order.Idle && !s.paths[i]) || s.order[i] === Order.Hold || s.target[i] >= 0) {
      s.stuck[i] = 0
      continue
    }
    const maxStep = unitSpeed(s, i) * TICK_S
    const dx = s.destX[i] - s.posX[i]
    const dz = s.destZ[i] - s.posZ[i]
    const remaining = Math.sqrt(dx * dx + dz * dz)
    if (s.progress[i] - remaining < maxStep * 0.1) s.stuck[i]++
    else s.stuck[i] = 0
    s.progress[i] = remaining

    if (s.stuck[i] >= 12) {
      if (remaining < 2.0 || s.repathed[i] === 1) {
        // Close enough / already retried — settle here and make this the post
        // (otherwise guard-return would keep re-planning the same blocked path)
        s.order[i] = Order.Idle
        s.paths[i] = null
        s.homeX[i] = s.posX[i]
        s.homeZ[i] = s.posZ[i]
        s.chased[i] = 0
        s.stuck[i] = 0
      } else {
        s.paths[i] = planPath(grid, s.posX[i], s.posZ[i], s.destX[i], s.destZ[i])
        s.repathed[i] = 1
        s.stuck[i] = 0
      }
    }
  }
}
