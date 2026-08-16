import type { MapRegion, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { RulesetModule } from '../ruleset.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as COMPACT } from './factions/compact.ts'
import { STANCES } from './factions/shared.ts'

// "Squad Support" — one base, six squads, and a night that keeps getting worse.
//
// The shape is borrowed from the StarCraft co-op custom maps: a commander runs
// an economy behind the line while everyone else fields a handful of units and
// no buildings at all. What is different here is who commands. The base is run
// by the COMPUTER, which makes the players purely a defence force — nobody is
// sitting in a build menu while the wave lands, and a lobby of six all get the
// same job.
//
// The squads are not assigned. A player who loses his last man walks a Field
// Officer onto one of six pads and picks again, so a company that opened with
// three lots of riflemen finishes the night with flak and artillery because
// that is what kept dying. Choosing under pressure, with what the wave just
// did to you still on screen, is the whole game.

const SIZE = 128
// Palette indices, matching TERRAIN_PALETTE in the renderer.
const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROAD = 2 // rock

/**
 * Pad footprint, in cells. The region and the paint are both derived from this
 * so they cannot drift apart — a pad you can see but not trigger, or trigger
 * but not see, is the worst bug this map could have.
 */
const PAD_W = 7
const PAD_H = 5

// ---- geography -------------------------------------------------------------
// Everything below is expressed against these, so the layout can be moved
// without hunting for numbers in the trigger tables.
const BASE_X = 64
const BASE_Z = 84
/** Where a squad-less player is put, and where the six pads stand. */
const MUSTER_X = 64
const MUSTER_Z = 108
/**
 * The enemy seat. Far enough from the top edge that the ring of build plots a
 * Command Post brings with it (radius 15) lands on the map instead of off it —
 * otherwise half the enemy's build slots silently fail to place and the base
 * you march on is a bare keep.
 */
const FOE_BASE_X = 64
const FOE_BASE_Z = 20
/** The three mouths the attack comes out of, just south of the enemy base. */
const LANE_Z = 38
const LANE_X = [26, 64, 102]
/** The ridges that split the middle ground into three lanes. */
const RIDGE_Z0 = 44
const RIDGE_Z1 = 74

// ---- slots -----------------------------------------------------------------
//
// The humans take the LOW slots and the two computers sit above them, which is
// not cosmetic. A lobby seats players from slot 0 upward and a human name beats
// `aiLevels` for the same slot, so a commander parked on slot 0 is handed to
// the first person who joins — and then driven by the AI at the same time. Put
// the squads first and a solo practice player is squad one, which is the seat
// the map is about.
/** Human squad seats. */
const SQUADS = [0, 1, 2, 3, 4, 5]
/** The computer that owns the economy. Never a human seat. */
const CMDR = 6
/** The attacker. Its army is trigger-spawned, then its own AI throws it in. */
const FOE = 7

/**
 * When the authored wave schedule runs out and the endless one takes over.
 * A little past the last scripted wave, so its arrival is not doubled up.
 */
const HOLD_SECONDS = 12 * 45 + 60

// ---- the six squads --------------------------------------------------------
/**
 * What each pad hands out. `def` is a horde ticket, so a pick spawns a bound
 * battalion with a formation and a veterancy track rather than loose bodies.
 *
 * The roster is deliberately holed. Flak cannot touch the ground and Strike
 * cannot touch the air, so two players who both grabbed the shiny thing will
 * watch the other half of the wave walk past them. That is the cooperation the
 * map is about, and it is enforced by what the units cannot do rather than by
 * a rule.
 */
interface SquadKind {
  id: string
  name: string
  /** Ticket spawned, and how many battalions of it. */
  def: string
  count: number
  /** Pad position, laid out left to right across the muster. */
  padX: number
  /**
   * The pad's own ground colour. Six identical white squares would mean
   * guessing, and a squad you did not mean to draw is unrecoverable until it
   * dies — so each one is a different palette index and the briefing reads the
   * yard out left to right.
   */
  tex: number
  blurb: string
}

const SQUAD_KINDS: SquadKind[] = [
  { id: 'rifle', name: 'Rifles', def: 'h-troopers', count: 2, padX: MUSTER_X - 25, tex: 4, blurb: 'Rifles — reaches both layers. Never wrong, never decisive.' },
  { id: 'flak', name: 'Flak', def: 'h-lancers', count: 2, padX: MUSTER_X - 15, tex: 3, blurb: 'Flak — tears down anything airborne, helpless against boots.' },
  { id: 'strike', name: 'Strike', def: 'h-skiffs', count: 2, padX: MUSTER_X - 5, tex: 6, blurb: 'Strike — fast skiffs, murder on the ground, blind to the air.' },
  { id: 'gunship', name: 'Gunship', def: 'h-gunship', count: 1, padX: MUSTER_X + 5, tex: 7, blurb: 'Gunship — hits everything, and there are only two of them.' },
  { id: 'medic', name: 'Field Aid', def: 'h-medics', count: 1, padX: MUSTER_X + 15, tex: 5, blurb: 'Field Aid — keeps other squads standing. Cannot kill anything.' },
  { id: 'siege', name: 'Siege', def: 'h-siege', count: 1, padX: MUSTER_X + 25, tex: 2, blurb: 'Siege — lobbed shells, wide splash, useless up close or upward.' },
]

/** The pad's rect in world units. The single source both the paint and the
 *  trigger region are cut from. */
function padBox(k: SquadKind): { x0: number; z0: number; x1: number; z1: number } {
  return {
    x0: k.padX - PAD_W / 2,
    z0: MUSTER_Z - 6 - PAD_H / 2,
    x1: k.padX + PAD_W / 2,
    z1: MUSTER_Z - 6 + PAD_H / 2,
  }
}

// ---- map-local content -----------------------------------------------------
/**
 * The two roles the Compact does not field.
 *
 * Kept as a map module rather than pushed into the faction: they exist because
 * six pads need six genuinely different answers, which is this map's problem
 * and nobody else's. A skirmish on another map should not suddenly have a
 * medic in the barracks because this one wanted a support squad.
 */
const SUPPORT_MODULE: RulesetModule = {
  id: 'squad-support-pack',
  name: 'Squad Support pack',
  abilities: [
    {
      id: 'field-dressing',
      name: 'Field Dressing',
      target: 'ally',
      hpDelta: 14,
      range: 7,
      periodTicks: 14,
      autoAcquire: 'injuredAlly',
    },
  ],
  entities: [
    {
      // No weapon at all. A medic squad left alone dies without landing a
      // blow, which is the point: it is a thing the others have to cover.
      id: 'medic',
      name: 'Medic',
      kind: 'unit',
      radius: 0.34,
      hp: 95,
      armorType: 'infantry',
      xpValue: 10,
      visual: { model: 'gen:trooper', tint: 'owner' },
      mover: { speed: 4.2 },
      abilities: [{ ability: 'field-dressing', autocast: true }],
    },
    {
      // Artillery: outranges everything on the field, cannot defend itself,
      // and cannot elevate. Park it behind the line or lose it.
      id: 'siege-gun',
      name: 'Siege Gun',
      kind: 'unit',
      radius: 0.62,
      hp: 210,
      armorType: 'engine',
      xpValue: 30,
      visual: { model: 'gen:lancer-trooper', scale: 1.2, tint: 'owner' },
      mover: { speed: 2.6 },
      combat: {
        damage: 46,
        range: 19,
        acquire: 21,
        periodTicks: 34,
        damageType: 'siege',
        hits: 'ground',
        splashRadius: 3.2,
        splashEdgePct: 45,
        projectile: { speed: 13, splashRadius: 3.2, edgePct: 45 },
      },
    },
    {
      // The thing a player actually respawns as. Cheap, quick, and armed just
      // well enough to not be a liability while it walks to a pad.
      id: 'field-officer',
      name: 'Field Officer',
      kind: 'unit',
      radius: 0.36,
      hp: 140,
      armorType: 'infantry',
      xpValue: 5,
      visual: { model: 'gen:trooper', scale: 1.1, tint: 'owner' },
      mover: { speed: 5.2 },
      combat: { damage: 9, range: 7, acquire: 9, periodTicks: 14, damageType: 'arrow', hits: 'both' },
    },
    {
      id: 'h-medics',
      name: 'Field Aid',
      kind: 'unit',
      radius: 0.34,
      hp: 0,
      supplyCost: 6,
      visual: { model: 'placeholder:capsule', tint: 'owner' },
      horde: { unit: 'medic', count: 4, spacing: 1.3, formations: STANCES },
    },
    {
      id: 'h-siege',
      name: 'Siege Battery',
      kind: 'unit',
      radius: 0.62,
      hp: 0,
      supplyCost: 10,
      visual: { model: 'placeholder:box', tint: 'owner' },
      horde: { unit: 'siege-gun', count: 3, spacing: 2.2, formations: STANCES },
    },
  ],
}

const SQUAD_DEF = composeDef({
  id: 'squad-support',
  name: 'Squad Support',
  factions: [COMPACT],
  modules: [SUPPORT_MODULE],
  // Neither side can be wiped out in the ordinary way — the attacker respawns
  // by trigger and the players respawn by pad — so the match is decided only
  // by the two triggers that end it: the Command Post falling, or the clock.
  victory: { mode: 'triggersOnly' },
  // The commander is the only one who spends, and it has a lot to build.
  startAmount: 3000,
})

// ---- waves -----------------------------------------------------------------
/**
 * One line per wave: when it lands, and what comes.
 *
 * Authored as a table rather than generated from a curve because the SHAPE
 * matters more than the size. Wave 3 is the first air, which is the moment the
 * company finds out whether anybody took Flak; wave 7 is armour-heavy and
 * punishes a company that over-invested in it. A curve cannot say that.
 */
interface Wave {
  at: number // seconds
  ground: number // h-troopers battalions
  air: number // h-skiffs battalions
  heavy: number // h-gunship battalions
  say: string
}

const WAVES: Wave[] = [
  { at: 30, ground: 1, air: 0, heavy: 0, say: 'Contact — light infantry on the west road.' },
  { at: 75, ground: 2, air: 0, heavy: 0, say: 'Second wave. Still boots.' },
  { at: 120, ground: 1, air: 1, heavy: 0, say: 'Air contact. Somebody had better have flak.' },
  { at: 165, ground: 2, air: 1, heavy: 0, say: 'Mixed wave inbound.' },
  { at: 210, ground: 3, air: 1, heavy: 0, say: 'They are committing now.' },
  { at: 255, ground: 2, air: 2, heavy: 0, say: 'Heavy air. Keep the guns pointed up.' },
  { at: 300, ground: 4, air: 1, heavy: 1, say: 'Gunship in the formation — hit it before it settles.' },
  { at: 345, ground: 3, air: 2, heavy: 1, say: 'All three lanes.' },
  { at: 390, ground: 5, air: 2, heavy: 1, say: 'They want the Command Post this time.' },
  { at: 435, ground: 4, air: 3, heavy: 2, say: 'Everything they have left is moving.' },
  { at: 480, ground: 6, air: 3, heavy: 2, say: 'Hold. Just hold.' },
  { at: 525, ground: 6, air: 4, heavy: 3, say: 'Last wave. All of it.' },
]

// ---- generation ------------------------------------------------------------

/** A rect region, named for triggers. */
function rect(id: string, name: string, x: number, z: number, w: number, h: number): MapRegion {
  return { id, name, x0: x - w / 2, z0: z - h / 2, x1: x + w / 2, z1: z + h / 2 }
}

/** Trigger ids are referenced by `setTrigger`, so they are built one way only. */
const padTrigId = (slot: number, kind: string): string => `pick-${slot}-${kind}`

export function generateSquadSupport(seed = 20260809): RtsMapDoc {
  const n = SIZE * SIZE
  const walkable = Array.from<number>({ length: n }).fill(1)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)

  const at = (x: number, z: number): number => z * SIZE + x

  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const i = at(x, z)
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) walkable[i] = 0
    }
  }

  // Two ridges running north-south, splitting the approach into three lanes.
  // They stop short of the base so the lanes converge on it — a defender can
  // hold a lane, but not all three, which is what forces the company to split.
  // Integer cell columns rather than rounded floats — rounding is banned in
  // the sim, and a generator that drifts by a cell between engines is a desync
  // at tick 0 rather than a cosmetic difference.
  for (const ridgeX of [SIZE / 2 - 21, SIZE / 2 + 21]) {
    for (let z = RIDGE_Z0; z < RIDGE_Z1; z++) {
      for (let d = -2; d <= 2; d++) {
        const x = ridgeX + d
        if (x < 2 || x >= SIZE - 2) continue
        walkable[at(x, z)] = 0
        heightJitter[at(x, z)] = 1.4
      }
    }
  }

  // The roads the waves walk, drawn so a player can read where they come from.
  for (const lx of LANE_X) {
    for (let z = LANE_Z; z < BASE_Z; z++) {
      for (let d = -3; d <= 3; d++) {
        const x = lx + d
        if (x < 2 || x >= SIZE - 2) continue
        if (walkable[at(x, z)] === 1) texture[at(x, z)] = TEX_ROAD
      }
    }
  }

  // The muster yard: bare dirt, well behind the base, so a respawning player
  // picks his next squad without something shooting at him while he decides.
  for (let z = MUSTER_Z - 11; z < MUSTER_Z + 8; z++) {
    for (let x = MUSTER_X - 32; x < MUSTER_X + 32; x++) {
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) continue
      texture[at(x, z)] = TEX_DIRT
    }
  }

  // The pads themselves, painted from the same box the trigger region is cut
  // from. Walking onto the colour IS the pick — there is nothing standing on
  // a pad to bump into, because a marker you cannot walk through is a marker
  // you cannot use.
  for (const kind of SQUAD_KINDS) {
    const b = padBox(kind)
    for (let z = Math.floor(b.z0); z < Math.floor(b.z1); z++) {
      for (let x = Math.floor(b.x0); x < Math.floor(b.x1); x++) {
        if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) continue
        texture[at(x, z)] = kind.tex
      }
    }
  }

  // ---- what stands on the ground at tick 0 ----
  // Only the commander's seat. Everything else it owns, it builds — which is
  // the point of handing it the economy in the first place.
  // Two seats, and nothing else. Both sides' computers build their own out
  // from these — the enemy base you eventually have to break is one the enemy
  // raised, so how hard it is to crack depends on how long you left it.
  const placed: PlacedEntity[] = [
    { def: 'command-post', owner: CMDR, x: BASE_X, z: BASE_Z, always: true },
    { def: 'command-post', owner: FOE, x: FOE_BASE_X, z: FOE_BASE_Z, always: true },
  ]

  // ---- regions ----
  // The 30-region ceiling in the trigger runtime is the real budget here, so
  // the pads are SHARED: six of them, not six per player. Which player a pad
  // answers to is decided by the `owner` on the entry event instead.
  const regions: MapRegion[] = [
    rect('field', 'The whole map', SIZE / 2, SIZE / 2, SIZE, SIZE),
    rect('muster', 'Muster yard', MUSTER_X, MUSTER_Z, 26, 8),
    rect('core', 'Command Post', BASE_X, BASE_Z, 16, 16),
    rect('foe-core', 'Enemy Command Post', FOE_BASE_X, FOE_BASE_Z, 16, 16),
    ...SQUAD_KINDS.map((k) => {
      const b = padBox(k)
      return { id: `pad-${k.id}`, name: `${k.name} pad`, ...b }
    }),
    ...LANE_X.map((x, i) => rect(`lane-${i}`, `Lane ${i + 1}`, x, LANE_Z, 12, 8)),
  ]

  // ---- triggers ----
  const triggers: TriggerDef[] = []

  triggers.push({
    id: 'intro',
    name: 'Briefing',
    once: true,
    events: [{ type: 'mapInit' }],
    conditions: [],
    actions: [
      { type: 'message', text: 'The Command Post builds itself. You are the guns. Walk your Field Officer onto a coloured pad to draw a squad.', to: 'all' },
      { type: 'message', text: 'Hold the line — then break it. You win by putting THEIR Command Post down, north of the ridges.', to: 'all' },
      { type: 'message', text: `Pads, left to right: ${SQUAD_KINDS.map((k) => k.name).join(' · ')}`, to: 'all' },
      { type: 'message', text: 'Lose your last man and you pick again — so pick what the last wave killed you with.', to: 'all' },
      // A squad player has nothing to spend and no way to spend it, so the
      // opening balance is a number that can only mislead. The commander keeps
      // its own — startAmount is per-map, not per-slot, so this is the only
      // place the difference can be made.
      ...SQUADS.map((slot) => ({
        type: 'modifyResource' as const,
        owner: slot,
        resource: 'res',
        delta: -100000,
      })),
    ],
  })

  // A player with nothing left gets an officer back, and the pads open to him
  // again. Checked on a timer rather than on death, because "his last man" is
  // a fact about the board, not about any one casualty — and at tick 0 it is
  // already true, which is exactly how everyone gets their first pick.
  for (const slot of SQUADS) {
    triggers.push({
      id: `respawn-${slot}`,
      name: `Player ${slot} has nothing left`,
      events: [{ type: 'timer', seconds: 2, periodic: true }],
      conditions: [{ type: 'unitCountInRegion', region: 'field', owner: slot, op: '<=', count: 0 }],
      actions: [
        { type: 'spawnUnits', def: 'field-officer', owner: slot, count: 1, at: { region: 'muster' }, facing: { x: 0, z: -1 } },
        { type: 'panCamera', player: slot, x: MUSTER_X, z: MUSTER_Z },
        { type: 'message', text: 'Squad lost. Draw another.', to: slot },
        // Re-open every pad to this player alone.
        ...SQUAD_KINDS.map((k) => ({ type: 'setTrigger' as const, trigger: padTrigId(slot, k.id), on: true })),
      ],
    })
  }

  // One trigger per (pad, player). Six regions, thirty-six triggers — the
  // runtime caps regions, not triggers, so this is the cheap way round.
  //
  // Each pick shuts ALL of that player's pads, including the one he just used.
  // Without that he could stand on the pad and draw a fresh battalion every
  // time he stepped off and back on, which is a base-builder's economy with
  // none of the base.
  for (const slot of SQUADS) {
    for (const kind of SQUAD_KINDS) {
      triggers.push({
        id: padTrigId(slot, kind.id),
        name: `Player ${slot} takes ${kind.name}`,
        // Off until the player has nothing: the officer is spawned INTO the
        // muster yard, and an armed pad would hand him a squad before he had
        // chosen one.
        initiallyOn: false,
        events: [{ type: 'unitEntersRegion', region: `pad-${kind.id}`, owner: slot }],
        conditions: [],
        actions: [
          { type: 'spawnUnits', def: kind.def, owner: slot, count: kind.count, at: { region: 'muster' }, facing: { x: 0, z: -1 } },
          { type: 'message', text: kind.blurb, to: slot },
          ...SQUAD_KINDS.map((k) => ({ type: 'setTrigger' as const, trigger: padTrigId(slot, k.id), on: false })),
        ],
      })
    }
  }

  // The waves. Each lands split across the three lanes, then is ordered at the
  // Command Post — the attacker's own army job takes over from there, so it
  // fights what it meets on the way instead of walking past it.
  WAVES.forEach((w, wi) => {
    const actions: TriggerDef['actions'] = [{ type: 'message', text: `Wave ${wi + 1}. ${w.say}`, to: 'all' }]
    const spread = (def: string, total: number): void => {
      for (let k = 0; k < total; k++) {
        actions.push({
          type: 'spawnUnits',
          def,
          owner: FOE,
          count: 1,
          at: { region: `lane-${k % LANE_X.length}` },
          always: true, // the attacker is a reserved slot, not a seat anyone takes
          facing: { x: 0, z: 1 },
        })
      }
    }
    spread('h-troopers', w.ground)
    spread('h-skiffs', w.air)
    spread('h-gunship', w.heavy)
    for (let i = 0; i < LANE_X.length; i++) {
      actions.push({ type: 'orderUnits', region: `lane-${i}`, owner: FOE, order: 'attackMove', x: BASE_X, z: BASE_Z })
    }
    triggers.push({
      id: `wave-${wi}`,
      name: `Wave ${wi + 1}`,
      once: true,
      events: [{ type: 'timer', seconds: w.at }],
      conditions: [],
      actions,
    })
  })

  triggers.push({
    id: 'lost',
    name: 'The Command Post has fallen',
    once: true,
    events: [{ type: 'timer', seconds: 3, periodic: true }],
    conditions: [{ type: 'unitCountInRegion', region: 'core', owner: CMDR, def: 'command-post', op: '<=', count: 0 }],
    actions: [
      { type: 'message', text: 'The Command Post is gone. Nothing left to support.', to: 'all' },
      { type: 'defeat', player: CMDR },
    ],
  })

  // Holding is not winning. The night ends when their Command Post does, which
  // means the company has to stop defending at some point and go north — and
  // that is a decision about when, made against a wave clock that never stops.
  triggers.push({
    id: 'won',
    name: 'The enemy Command Post has fallen',
    once: true,
    events: [{ type: 'timer', seconds: 3, periodic: true }],
    conditions: [
      { type: 'unitCountInRegion', region: 'foe-core', owner: FOE, def: 'command-post', op: '<=', count: 0 },
    ],
    actions: [
      { type: 'message', text: 'Their Command Post is down. It is over.', to: 'all' },
      // Any squad seat will do — victory resolves to that player's TEAM, and
      // every squad and the commander share one.
      { type: 'victory', player: SQUADS[0] },
    ],
  })

  // Once the authored waves run out the pressure must not: a company that has
  // survived to here would otherwise stroll north unopposed, and the assault
  // is supposed to be a thing you pay for. Endless from the last wave on, at
  // its strength, so the cost of waiting keeps climbing.
  const last = WAVES[WAVES.length - 1]
  triggers.push({
    id: 'wave-endless',
    name: 'Reinforcements, forever',
    initiallyOn: false,
    events: [{ type: 'timer', seconds: 60, periodic: true }],
    conditions: [],
    actions: [
      ...Array.from({ length: last.ground }, (_, k) => ({
        type: 'spawnUnits' as const,
        def: 'h-troopers',
        owner: FOE,
        count: 1,
        at: { region: `lane-${k % LANE_X.length}` },
        always: true,
        facing: { x: 0, z: 1 },
      })),
      ...Array.from({ length: last.air }, (_, k) => ({
        type: 'spawnUnits' as const,
        def: 'h-skiffs',
        owner: FOE,
        count: 1,
        at: { region: `lane-${k % LANE_X.length}` },
        always: true,
        facing: { x: 0, z: 1 },
      })),
      ...LANE_X.map((_, i) => ({
        type: 'orderUnits' as const,
        region: `lane-${i}`,
        owner: FOE,
        order: 'attackMove' as const,
        x: BASE_X,
        z: BASE_Z,
      })),
    ],
  })

  // Switched on by the last authored wave rather than at map init, so the two
  // schedules never overlap.
  triggers.push({
    id: 'endless-on',
    name: 'Hand over to the endless schedule',
    once: true,
    events: [{ type: 'timer', seconds: HOLD_SECONDS }],
    conditions: [],
    actions: [
      { type: 'message', text: 'No more scheduled waves — they are just coming now. Take their base.', to: 'all' },
      { type: 'setTrigger', trigger: 'wave-endless', on: true },
    ],
  })

  return {
    version: 2,
    name: 'squad-support',
    seed,
    cols: SIZE,
    rows: SIZE,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable,
    texture,
    heightJitter,
    fog: 'off', // a defence map: you are meant to see the wave forming
    races: ['compact'],
    // Eight seats: six squads, then the commander, then the thing outside.
    // Order matters — see the slot constants.
    startLocations: [
      ...SQUAD_KINDS.map((k) => ({ x: k.padX, z: MUSTER_Z })),
      { x: BASE_X, z: BASE_Z - 8 },
      { x: FOE_BASE_X, z: FOE_BASE_Z },
    ],
    startNames: [
      ...SQUAD_KINDS.map((_, i) => `Squad ${i + 1}`),
      'Commander (CPU)',
      'The attack (CPU)',
    ],
    // Everyone but the attacker is on one side.
    slotTeams: [0, 0, 0, 0, 0, 0, 0, 1],
    // The commander builds; the attacker throws what the triggers give it.
    // Both are the map's own, not a lobby choice — the map does not work
    // without them.
    //
    // A consequence worth knowing: naming the top two slots puts every slot
    // below them "in play", so an unfilled squad seat still gets its Field
    // Officer. He stands in the muster yard doing nothing, a long way behind
    // the base — by the time anything reaches him the match is already lost —
    // so he is untidy rather than a free defender.
    aiLevels: [0, 0, 0, 0, 0, 0, 2, 3],
    placed,
    regions,
    triggers,
    gameDef: SQUAD_DEF,
  }
}
