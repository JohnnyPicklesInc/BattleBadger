import type { SimState } from '../state.ts'
import { speedPct } from './upgrades.ts'

// Hordes (BFME battalions). A horde ticket def is what a barracks trains and
// what a command point is spent on; training it spawns N soldier entities and
// binds them into one horde. Everything the player interacts with — selection,
// orders, formation, veterancy — is horde-level. The store and its lifecycle
// live in state.ts beside spawnUnit/despawn; the rules live here.

export const FormationKindId = { Block: 0, Line: 1, Wedge: 2, Ring: 3 } as const

// ---- formations ----

// Local-space slot offsets: +x is the formation's right, +z its forward.
// Integer/sqrt math only — no trig anywhere on the determinism path.
export function formationSlot(
  kind: number,
  slot: number,
  total: number,
  spacing: number,
): [number, number] {
  if (total <= 1) return [0, 0]
  if (kind === FormationKindId.Line) {
    // two ranks, wide frontage — the marching/charging shape
    const rows = total >= 4 ? 2 : 1
    const cols = Math.ceil(total / rows)
    const row = Math.floor(slot / cols)
    const col = slot % cols
    return [(col - (cols - 1) / 2) * spacing, ((rows - 1) / 2 - row) * spacing]
  }
  if (kind === FormationKindId.Wedge) {
    // rank r holds r+1 soldiers; the point leads
    let r = 0
    let first = 0
    while (first + r + 1 <= slot) {
      first += r + 1
      r++
    }
    const i = slot - first
    return [(i - r / 2) * spacing, -r * spacing]
  }
  if (kind === FormationKindId.Ring) {
    // porcupine: soldiers stand on a square perimeter facing outward
    const side = Math.max(1, Math.ceil(total / 4))
    const edge = Math.floor(slot / side)
    const along = slot % side
    const half = (side * spacing) / 2
    const t = along * spacing - half + spacing / 2
    if (edge === 0) return [t, half]
    if (edge === 1) return [half, -t]
    if (edge === 2) return [-t, -half]
    return [-half, t]
  }
  // block: the default packed square
  const cols = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / cols)
  const row = Math.floor(slot / cols)
  const col = slot % cols
  return [(col - (cols - 1) / 2) * spacing, ((rows - 1) / 2 - row) * spacing]
}

// Rotate a local slot offset into world space around (cx, cz) for a formation
// facing (fx, fz). right = (fz, -fx) — a rotation built from the facing vector,
// so no sin/cos is involved.
export function formationWorld(
  cx: number,
  cz: number,
  fx: number,
  fz: number,
  ox: number,
  oz: number,
): [number, number] {
  return [cx + fz * ox + fx * oz, cz - fx * ox + fz * oz]
}

// The horde's active formation entry, or null when the def declares none.
export function activeFormation(
  s: SimState,
  horde: number,
): { kind: number; damagePct: number; damageTakenPct: number; speedPct: number; crushableLevel: number } | null {
  const f = s.def.hordeFormations[s.hordes.defIdx[horde]]
  if (!f || f.length === 0) return null
  return f[Math.min(s.hordes.formation[horde], f.length - 1)]
}

/**
 * How hard this unit is to ride down right now. Normally its def's level, but
 * a horde holding a bracing stance (Porcupine) overrides it — that is what
 * turns "set to receive cavalry" from a cosmetic stance into a real answer.
 */
export function crushableOf(s: SimState, id: number): number {
  const base = s.def.stats.crushableLevel[s.type[id]]
  const h = s.hordeOf[id]
  if (h < 0) return base
  const f = activeFormation(s, h)
  if (!f || f.crushableLevel <= 0) return base
  return Math.max(base, f.crushableLevel)
}

export function hordeSpacing(s: SimState, horde: number): number {
  return s.def.hordeSpacing[s.hordes.defIdx[horde]]
}

// The footprint a formed-up horde occupies — used to keep several hordes
// ordered to the same point from stacking on top of each other.
export function hordeFootprint(s: SimState, horde: number): number {
  const n = Math.max(1, s.hordes.members[horde].length)
  return hordeSpacing(s, horde) * (Math.ceil(Math.sqrt(n)) + 1)
}

// ---- veterancy ----

// Percent multipliers a horde's level contributes. Level 1 is always 100/100.
export function levelMods(s: SimState, horde: number): { damagePct: number; damageTakenPct: number } {
  const levels = s.def.hordeLevels
  if (levels.length === 0) return { damagePct: 100, damageTakenPct: 100 }
  const i = Math.min(Math.max(0, s.hordes.level[horde] - 1), levels.length - 1)
  return { damagePct: levels[i].damagePct, damageTakenPct: levels[i].damageTakenPct }
}

// Award experience and promote. Thresholds are ascending and cumulative.
export function addXp(s: SimState, horde: number, amount: number): void {
  if (horde < 0 || s.hordes.alive[horde] !== 1 || amount <= 0) return
  const levels = s.def.hordeLevels
  if (levels.length === 0) return
  const h = s.hordes
  h.xp[horde] += amount
  let lvl = 1
  for (let i = 0; i < levels.length; i++) {
    if (h.xp[horde] >= levels[i].xp) lvl = i + 1
  }
  h.level[horde] = lvl
}

// ---- combat modifiers ----

// Damage a unit deals after its horde's level and formation, as a percentage.
export function outgoingPct(s: SimState, id: number): number {
  const horde = s.hordeOf[id]
  if (horde < 0) return 100
  const lvl = levelMods(s, horde)
  const f = activeFormation(s, horde)
  return Math.floor((lvl.damagePct * (f ? f.damagePct : 100)) / 100)
}

// Damage a unit receives after its horde's level and formation, as a percentage.
export function incomingPct(s: SimState, id: number): number {
  const horde = s.hordeOf[id]
  if (horde < 0) return 100
  const lvl = levelMods(s, horde)
  const f = activeFormation(s, horde)
  return Math.floor((lvl.damageTakenPct * (f ? f.damageTakenPct : 100)) / 100)
}

// Movement speed after the formation's speed modifier (porcupine is slow).
export function unitSpeed(s: SimState, id: number): number {
  const base = (s.def.stats.speed[s.type[id]] * speedPct(s, id)) / 100
  const horde = s.hordeOf[id]
  if (horde < 0) return base
  const f = activeFormation(s, horde)
  return f ? (base * f.speedPct) / 100 : base
}
