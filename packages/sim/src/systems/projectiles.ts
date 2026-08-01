import { MAX_PROJECTILES, TICK_S, allied, type SimState } from '../state.ts'
import { rngFloat } from '../math/sfc32.ts'
import type { SpatialHash } from '../spatial.ts'
import { applyDamageTable, canHit } from './combat.ts'
import { addXp, crushableOf, incomingPct } from './hordes.ts'

// Shots that FLY. A weapon with a `projectile` block does not resolve on the
// tick it fires: it launches a shell at the ground where the target stood, the
// shell travels at a fixed speed, and whatever is standing there when it lands
// takes the hit. A slow round can therefore be walked out of, which is exactly
// what makes a catapult a siege weapon rather than a long-ranged rifle.
//
// The sim keeps shells strictly 2D. The arc a player sees is the client's
// business — it interpolates height from launch/impact points, so the shape of
// the trajectory can never affect who takes damage.

/** Launch a shell. Called by combat() in place of applying damage directly. */
export function launchProjectile(s: SimState, shooter: number, tgtX: number, tgtZ: number, damage: number): void {
  const pr = s.projectiles
  const ty = s.type[shooter]
  const st = s.def.stats

  // Scatter the aim point. Rejection sampling gives an even spread over the
  // disc without trigonometry, which the sim bans; the loop consumes the same
  // draws from the same shared RNG on every client, so it stays lockstep.
  const scatter = st.projScatter[ty]
  if (scatter > 0) {
    for (let tries = 0; tries < 8; tries++) {
      const ox = (rngFloat(s.rng) * 2 - 1) * scatter
      const oz = (rngFloat(s.rng) * 2 - 1) * scatter
      if (ox * ox + oz * oz <= scatter * scatter) {
        tgtX += ox
        tgtZ += oz
        break
      }
    }
  }
  let k = pr.freeList.pop() ?? -1
  if (k < 0) {
    if (pr.count >= MAX_PROJECTILES) return // saturated; drop the shot
    k = pr.count++
  }
  pr.alive[k] = 1
  pr.x[k] = s.posX[shooter]
  pr.z[k] = s.posZ[shooter]
  pr.startX[k] = pr.x[k]
  pr.startZ[k] = pr.z[k]
  pr.tgtX[k] = tgtX
  pr.tgtZ[k] = tgtZ
  pr.speed[k] = st.projSpeed[ty]
  pr.damage[k] = damage
  pr.splash[k] = st.projSplash[ty]
  pr.edgePct[k] = st.projEdgePct[ty]
  pr.owner[k] = s.owner[shooter]
  pr.srcType[k] = ty
  pr.srcHorde[k] = s.hordeOf[shooter]
}

function release(s: SimState, k: number): void {
  const pr = s.projectiles
  pr.alive[k] = 0
  pr.srcHorde[k] = -1
  pr.freeList.push(k)
}

// Damage one victim from a shell, falling off toward the edge of the blast.
function hit(s: SimState, k: number, victim: number, distSq: number): void {
  const pr = s.projectiles
  const st = s.def.stats

  // A boulder that lands ON somebody flattens them, if it outweighs them.
  // Uses the same crusher/crushable hierarchy as a cavalry impact, so a shell
  // can no more squash a wall or another engine than a horse can. With scatter
  // in play a bullseye is luck, which is what makes it a moment rather than a
  // tactic.
  const crusher = st.crusherLevel[pr.srcType[k]]
  if (crusher > 0 && crusher > crushableOf(s, victim)) {
    const rv = st.radius[s.type[victim]]
    if (distSq <= rv * rv) {
      const wasAlive = s.hp[victim] > 0
      s.hp[victim] = 0
      if (wasAlive) addXp(s, pr.srcHorde[k], st.xpValue[s.type[victim]])
      s.events.push({ t: 'trample', x: s.posX[victim], z: s.posZ[victim] })
      return
    }
  }

  let dmg = pr.damage[k]
  const splash = pr.splash[k]
  if (splash > 0) {
    // linear falloff from full at the centre to edgePct at the rim
    const d = Math.sqrt(distSq)
    const t = Math.min(1, d / splash)
    const pct = 100 - Math.floor(t * (100 - pr.edgePct[k]))
    dmg = Math.floor((dmg * pct) / 100)
  }
  dmg = applyDamageTable(s, pr.srcType[k], s.type[victim], dmg)
  dmg = Math.floor((dmg * incomingPct(s, victim)) / 100)
  if (dmg < 1) dmg = 1
  const wasAlive = s.hp[victim] > 0
  s.hp[victim] -= dmg
  if (wasAlive && s.hp[victim] <= 0) addXp(s, pr.srcHorde[k], st.xpValue[s.type[victim]])
}

function detonate(s: SimState, hash: SpatialHash, k: number): void {
  const pr = s.projectiles
  const st = s.def.stats
  const cx = pr.tgtX[k]
  const cz = pr.tgtZ[k]
  const splash = pr.splash[k]

  if (splash <= 0) {
    // point impact: the nearest enemy standing on the spot eats it
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i] || st.untargetable[s.type[i]]) continue
      if (allied(s, s.owner[i], pr.owner[k])) continue
      if (!canHit(s, pr.srcType[k], i)) continue
      const dx = s.posX[i] - cx
      const dz = s.posZ[i] - cz
      const r = st.radius[s.type[i]]
      const d = dx * dx + dz * dz
      if (d <= r * r && d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) hit(s, k, best, 0)
  } else {
    // Collect first, then apply in id order: spatial-hash bucket order is not
    // id-stable, and kill credit must not depend on it.
    const victims: number[] = []
    const dists: number[] = []
    hash.forNeighbors(cx, cz, splash, (i) => {
      if (!s.alive[i] || s.hidden[i] || st.untargetable[s.type[i]]) return
      if (allied(s, s.owner[i], pr.owner[k])) return
      // a ground-only shell blows up under a gunship, not on it
      if (!canHit(s, pr.srcType[k], i)) return
      const dx = s.posX[i] - cx
      const dz = s.posZ[i] - cz
      const reach = splash + st.radius[s.type[i]]
      const d = dx * dx + dz * dz
      if (d <= reach * reach) {
        victims.push(i)
        dists.push(d)
      }
    })
    const order = victims.map((_, n) => n).sort((a, b) => victims[a] - victims[b])
    for (const n of order) hit(s, k, victims[n], dists[n])
  }

  s.events.push({ t: 'impact', x: cx, z: cz, radius: splash })
  release(s, k)
}

/** Advance every shell; detonate the ones that arrive this tick. */
export function projectiles(s: SimState, hash: SpatialHash): void {
  const pr = s.projectiles
  for (let k = 0; k < pr.count; k++) {
    if (!pr.alive[k]) continue
    const dx = pr.tgtX[k] - pr.x[k]
    const dz = pr.tgtZ[k] - pr.z[k]
    const dist = Math.sqrt(dx * dx + dz * dz)
    const step = pr.speed[k] * TICK_S
    if (dist <= step || dist < 1e-9) {
      pr.x[k] = pr.tgtX[k]
      pr.z[k] = pr.tgtZ[k]
      detonate(s, hash, k)
      continue
    }
    pr.x[k] += (dx / dist) * step
    pr.z[k] += (dz / dist) * step
  }
}
