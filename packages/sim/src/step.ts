import type { PlayerCommand } from './commands.ts'
import type { SimState } from './state.ts'
import { SpatialHash } from './spatial.ts'
import type { WalkGrid } from './path/walkgrid.ts'
import { applyCommands, updateOrders, updateStuck } from './systems/orders.ts'
import { integrate, resolveOverlaps, separation } from './systems/motion.ts'
import { acquireTargets, combat, deaths, victory } from './systems/combat.ts'
import { casts } from './systems/casts.ts'
import { projectiles } from './systems/projectiles.ts'
import { charges } from './systems/charge.ts'
import { aiCommands } from './systems/ai.ts'
import { harvest } from './systems/harvest.ts'
import { construction, income, production, supplyPower } from './systems/economy.ts'
import { triggers } from './systems/triggers.ts'
import { gates, swoops } from './systems/gates.ts'

// Scratch spatial hash — transient within one step, never part of hashed state.
const hash = new SpatialHash()

// One deterministic simulation tick. System order is fixed and must only
// change deliberately (it changes gameplay and invalidates replay goldens).
export function step(s: SimState, grid: WalkGrid, cmds: PlayerCommand[]): void {
  s.events.length = 0
  applyCommands(s, grid, cmds)
  // Computer opponents issue orders through the same path a human does, right
  // after the humans, so a contested resource goes to the player who clicked.
  // Recomputed identically on every client — nothing crosses the network.
  const ai = aiCommands(s, grid)
  if (ai.length > 0) applyCommands(s, grid, ai)
  income(s)
  production(s, grid)
  construction(s)
  hash.build(s)
  // Before pathing, so a path planned this tick meets the gate state the unit
  // will actually arrive at rather than last tick's.
  gates(s, grid, hash)
  // Dives tick down before targeting, so a flyer that has climbed out is out
  // of a spearman's reach on the same tick it regains its altitude.
  swoops(s)
  acquireTargets(s, hash)
  harvest(s, grid)
  updateOrders(s, grid)
  separation(s, hash)
  integrate(s, grid)
  resolveOverlaps(s, grid, hash)
  updateStuck(s, grid)
  // momentum is read from the movement that just happened
  charges(s, grid)
  casts(s, hash)
  projectiles(s, hash)
  combat(s, grid)
  deaths(s, grid)
  supplyPower(s)
  triggers(s, grid)
  victory(s)
  s.tick++
}
