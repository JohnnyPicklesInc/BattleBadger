import type { MapRegion, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { RulesetModule } from '../ruleset.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as COMPACT } from './factions/compact.ts'
import { STANCES } from './factions/shared.ts'

// "Squad Support" — a corridor with three enemy holds in it.
//
// The shape is borrowed from the StarCraft co-op custom maps: a commander runs
// an economy behind the line while everyone else fields a handful of units and
// no buildings at all. What is different here is who commands. The base is run
// by the COMPUTER, which makes the players purely a fighting force — nobody is
// sitting in a build menu while the wave lands, and a lobby of six all get the
// same job.
//
// The squads are not assigned. A player who loses his last man walks a Field
// Officer onto one of six pads and picks again, so a company that opened with
// three lots of riflemen finishes the night with flak and artillery because
// that is what kept dying. Choosing under pressure, with what the wave just
// did to you still on screen, is the whole game.
//
// It is a campaign up a valley, not a siege of one yard. Three enemy holds sit
// at increasing depth behind cliff walls, each with its own keep and its own
// wave schedule, and killing one shuts its waves off for good — so the map
// gets quieter as you win, which is the only pacing that makes an assault feel
// like progress rather than a treadmill.
//
// And the commander follows you up it. Neutral base sites are seeded in the
// ground between the holds; a site can only be claimed while somebody friendly
// stands near it and no enemy does, so clearing a hold literally hands the
// commander the ground to build on. Nothing scripts that — it falls out of
// plotClaimable. Take the middle and its camp becomes a Compact camp, with its
// own ring of plots, a barracks closer to the front and a shorter walk for
// every reinforcement after.

const SIZE = 192
// Palette indices, matching TERRAIN_PALETTE in the renderer.
const TEX_GRASS = 0
const TEX_DIRT = 1
const TEX_ROCK = 2
const TEX_ASH = 7

/**
 * Pad footprint, in cells. The region and the paint are both derived from this
 * so they cannot drift apart — a pad you can see but not trigger, or trigger
 * but not see, is the worst bug this map could have.
 */
const PAD_W = 7
const PAD_H = 5

// ---- geography -------------------------------------------------------------
// A valley running south to north. The company musters at the bottom, the
// commander's keep sits behind it, and three enemy holds are stacked up the
// corridor. Everything below is expressed against these.
const MID_X = SIZE / 2
const BASE_X = MID_X
const BASE_Z = 168
/** Where a squad-less player is put, and where the six pads stand. */
const MUSTER_X = MID_X
const MUSTER_Z = 182

/**
 * The three enemy holds, near to far. Each is a keep with its own plot ring,
 * so what you march into is a base the computer has been building all match,
 * not a lone building on bare ground.
 *
 * `lane` is where its waves form up — in front of the hold, so a wave visibly
 * comes OUT of the place you are going to have to take.
 */
const HOLDS = [
  { id: 'south', x: MID_X, z: 118, laneZ: 130, first: 30, every: 42 },
  { id: 'east', x: MID_X + 44, z: 62, laneZ: 76, first: 150, every: 50 },
  { id: 'north', x: MID_X - 40, z: 26, laneZ: 40, first: 270, every: 58 },
]

/**
 * Neutral ground the commander can take once you have cleared it. A camp is
 * worth six buildings and an outpost three, so the middle of the map is worth
 * more than its edges and taking it forward is worth doing.
 */
const SITES: { def: string; x: number; z: number }[] = [
  { def: 'camp-site', x: MID_X, z: 146 },
  { def: 'outpost-site', x: MID_X - 34, z: 150 },
  { def: 'outpost-site', x: MID_X + 34, z: 150 },
  // Off the centre line at this depth: the massif owns the middle from z 70
  // to 104, and the first draft put a camp inside it. One site each side, so
  // whichever road the company takes has ground the commander can follow onto.
  { def: 'camp-site', x: MID_X - 26, z: 92 },
  { def: 'outpost-site', x: MID_X + 30, z: 96 },
  // Tucked well inside the neck below the far hold, which is the narrowest
  // ground on the map.
  { def: 'camp-site', x: MID_X - 15, z: 56 },
]

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

// ---- generation ------------------------------------------------------------

/** A rect region, named for triggers. */
function rect(id: string, name: string, x: number, z: number, w: number, h: number): MapRegion {
  return { id, name, x0: x - w / 2, z0: z - h / 2, x1: x + w / 2, z1: z + h / 2 }
}

/** Trigger ids are referenced by `setTrigger`, so they are built one way only. */
const padTrigId = (slot: number, kind: string): string => `pick-${slot}-${kind}`

/**
 * Deterministic craggy variation. Integer hash, no RNG state — this file is
 * imported by scripts/gen-starter-maps.mjs under plain Node, so it must not
 * reach the sim's runtime chain.
 */
function crag(x: number, z: number): number {
  let h = Math.imul(x * 374761393 + z * 668265263, 1274126177)
  h = (h ^ (h >>> 13)) >>> 0
  return h / 4294967296
}

export function generateSquadSupport(seed = 20260809): RtsMapDoc {
  const n = SIZE * SIZE
  const walkable = Array.from<number>({ length: n }).fill(1)
  const cliffLevel = Array.from<number>({ length: n }).fill(0)
  const texture = Array.from<number>({ length: n }).fill(TEX_GRASS)
  const heightJitter = Array.from<number>({ length: n }).fill(0)

  const at = (x: number, z: number): number => z * SIZE + x
  const rock = (x: number, z: number): void => {
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return
    const i = at(x, z)
    // Blocked explicitly as well as raised: deriveTerrain only carves the cliff
    // EDGE, so a wide plateau would otherwise be walkable on top of itself.
    walkable[i] = 0
    cliffLevel[i] = 2
    texture[i] = TEX_ROCK
    heightJitter[i] = 1.2 + crag(x, z) * 2.6
  }

  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) rock(x, z)
    }
  }

  /**
   * The valley walls, as a half-width that varies with depth.
   *
   * Control points interpolated rather than stepped. Written as bands first,
   * and it looked like it was built out of rectangles — because it was. What
   * makes the corridor worth fighting up is where it PINCHES, and a pinch has
   * to be a slope you can see coming, not a wall that appears in one row.
   *
   * The necks sit just south of each hold: the ground a defence actually forms
   * on, where a battalion of flak in a narrow gap is doing something the same
   * battalion on open grass is not.
   */
  const WALL: [number, number][] = [
    [0, 46], [26, 40], [40, 30], [56, 26], // the far hold and its neck
    [70, 40], [84, 48], [96, 44],          // the middle, around the massif
    [110, 30], [122, 18], [130, 16],       // the neck below the near hold
    [140, 34], [152, 50], [162, 62], [SIZE, 66],
  ]
  const halfWidthAt = (z: number): number => {
    for (let k = 1; k < WALL.length; k++) {
      const [z1, w1] = WALL[k]
      if (z > z1) continue
      const [z0, w0] = WALL[k - 1]
      const t = (z - z0) / (z1 - z0)
      return w0 + (w1 - w0) * t
    }
    return WALL[WALL.length - 1][1]
  }

  for (let z = 2; z < SIZE - 2; z++) {
    // A ragged edge, so the wall reads as rock rather than as a drawn line.
    // Hashed on the row alone, so both walls of a row breathe together and the
    // corridor never pinches to nothing by accident.
    const half = halfWidthAt(z) + (crag(z, 7) - 0.5) * 5
    for (let x = 2; x < SIZE - 2; x++) {
      if (Math.abs(x + 0.5 - MID_X) > half) rock(x, z)
    }
  }

  // A massif in the middle of the corridor, splitting the approach to the two
  // far holds into two roads. Neither is a back door — both are watched — but
  // a company can commit to one and be somewhere the other lane is not.
  //
  // An ellipse with a ragged skin rather than a block: as a rectangle it read
  // as a wall somebody had dropped on the map, and the two roads past it want
  // to open and close like the valley does.
  const MASSIF_Z = 87
  const MASSIF_HALF_Z = 17
  const MASSIF_HALF_X = 13
  for (let z = MASSIF_Z - MASSIF_HALF_Z; z <= MASSIF_Z + MASSIF_HALF_Z; z++) {
    for (let x = MID_X - MASSIF_HALF_X - 3; x <= MID_X + MASSIF_HALF_X + 3; x++) {
      if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) continue
      const ux = (x + 0.5 - MID_X) / MASSIF_HALF_X
      const uz = (z + 0.5 - MASSIF_Z) / MASSIF_HALF_Z
      if (ux * ux + uz * uz <= 1 + (crag(x, z) - 0.5) * 0.25) rock(x, z)
    }
  }

  // Ground each hold stands on, cleared of rock so its plot ring has room.
  for (const h of HOLDS) {
    for (let z = h.z - 20; z <= h.z + 20; z++) {
      for (let x = h.x - 20; x <= h.x + 20; x++) {
        if (x < 2 || z < 2 || x >= SIZE - 2 || z >= SIZE - 2) continue
        const dx = x + 0.5 - h.x
        const dz = z + 0.5 - h.z
        if (dx * dx + dz * dz > 20 * 20) continue
        const i = at(x, z)
        walkable[i] = 1
        cliffLevel[i] = 0
        heightJitter[i] = 0
        texture[i] = TEX_ASH
      }
    }
  }

  // The commander's ground, likewise clear.
  for (let z = BASE_Z - 22; z < SIZE - 2; z++) {
    for (let x = 2; x < SIZE - 2; x++) {
      const i = at(x, z)
      walkable[i] = 1
      cliffLevel[i] = 0
      heightJitter[i] = 0
    }
  }

  // The road up the valley, so a player can read where the pressure comes from.
  for (let z = 8; z < BASE_Z; z++) {
    for (let d = -4; d <= 4; d++) {
      const x = MID_X + d
      if (x < 2 || x >= SIZE - 2) continue
      const i = at(x, z)
      if (walkable[i] === 1) texture[i] = TEX_DIRT
    }
  }

  // The muster yard: bare dirt, well behind the keep, so a respawning player
  // picks his next squad without something shooting at him while he decides.
  for (let z = MUSTER_Z - 11; z < SIZE - 2; z++) {
    for (let x = MUSTER_X - 40; x < MUSTER_X + 40; x++) {
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
        walkable[at(x, z)] = 1
      }
    }
  }

  // ---- what stands on the ground at tick 0 ----
  // Keeps and neutral ground, nothing else. Both computers build their own out
  // from these, so the holds you march on are bases the enemy raised over the
  // match — how hard they are to crack depends on how long you left them.
  const placed: PlacedEntity[] = [
    { def: 'command-post', owner: CMDR, x: BASE_X, z: BASE_Z, always: true },
    ...HOLDS.map((h) => ({ def: 'command-post', owner: FOE, x: h.x, z: h.z, always: true })),
    // Neutral base ground. Nobody owns these — `plot.neutral` short-circuits
    // the owner check in freePlotAt, so the field is only a placement slot,
    // and plotClaimable is what actually decides: yes while somebody friendly
    // stands near and no enemy does. They become the commander's exactly as
    // fast as the company takes the ground.
    //
    // Parked on the COMMANDER's slot rather than the conventional 0. Other
    // maps use 0 because slot 0 is an ordinary player there; here it is a
    // squad seat, and a squad's respawn is detected by "owns nothing at all".
    // Six neutral pads sitting on his ledger meant squad one never counted as
    // wiped out, so he was never handed another officer for the rest of the
    // match.
    ...SITES.map((c) => ({ def: c.def, owner: CMDR, x: c.x, z: c.z, always: true })),
  ]

  // ---- regions ----
  // The 30-region ceiling in the trigger runtime is the real budget here, so
  // the pads are SHARED: six of them, not six per player. Which player a pad
  // answers to is decided by the `owner` on the entry event instead.
  const regions: MapRegion[] = [
    rect('field', 'The whole map', SIZE / 2, SIZE / 2, SIZE, SIZE),
    rect('muster', 'Muster yard', MUSTER_X, MUSTER_Z, 26, 8),
    // A wide apron in front of the pad row. Stepping into it is what prints
    // the list of what is on offer — the pads are coloured, but a colour does
    // not tell you it is a button.
    rect('approach', 'The pad row', MUSTER_X, MUSTER_Z - 10, 74, 12),
    rect('core', 'Command Post', BASE_X, BASE_Z, 18, 18),
    ...SQUAD_KINDS.map((k) => {
      const b = padBox(k)
      return { id: `pad-${k.id}`, name: `${k.name} pad`, ...b }
    }),
    ...HOLDS.map((h) => rect(`hold-${h.id}`, `${h.id} hold`, h.x, h.z, 24, 24)),
    ...HOLDS.map((h) => rect(`lane-${h.id}`, `${h.id} lane`, h.x, h.laneZ, 20, 8)),
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
      { type: 'message', text: 'The Command Post builds itself. You are the guns.', to: 'all' },
      { type: 'message', text: 'Three enemy holds up the valley. Put all three Command Posts down to win.', to: 'all' },
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
        { type: 'panCamera', player: slot, x: MUSTER_X, z: MUSTER_Z - 4 },
        // Said EVERY time, not once at map init. A player wiped out twenty
        // minutes in never saw the briefing — it scrolled away with the first
        // wave — and "walk onto a pad" is not a thing anyone guesses.
        { type: 'message', text: 'Squad lost. Walk your Field Officer NORTH onto a coloured pad to draw another.', to: slot },
        ...SQUAD_KINDS.map((k) => ({ type: 'setTrigger' as const, trigger: padTrigId(slot, k.id), on: true })),
      ],
    })

    // Standing in front of the row prints what is on it. The colours tell you
    // the pads are different; only this tells you which is which, and it is
    // said at the moment you are looking at them rather than at map init.
    triggers.push({
      id: `menu-${slot}`,
      name: `Player ${slot} reads the pad row`,
      events: [{ type: 'unitEntersRegion', region: 'approach', owner: slot }],
      conditions: [],
      actions: [
        { type: 'message', text: `Pads, left to right — ${SQUAD_KINDS.map((k) => k.name).join(' · ')}. Step on one.`, to: slot },
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

  // Each hold runs its OWN wave schedule, and killing the hold switches that
  // schedule off. That is what makes taking one feel like progress: the map
  // gets quieter as you win, instead of grinding on regardless.
  for (const h of HOLDS) {
    const spawn = (def: string, count: number) => ({
      type: 'spawnUnits' as const,
      def,
      owner: FOE,
      count,
      at: { region: `lane-${h.id}` },
      always: true,
      facing: { x: 0, z: 1 },
    })
    triggers.push({
      id: `wave-${h.id}`,
      name: `${h.id} hold sends a wave`,
      initiallyOn: false,
      events: [{ type: 'timer', seconds: h.every, periodic: true }],
      // A dead hold sends nothing. Belt and braces with the setTrigger below:
      // the condition is what makes it true the instant the keep falls rather
      // than at the next tick the death trigger happens to run.
      conditions: [
        { type: 'unitCountInRegion', region: `hold-${h.id}`, owner: FOE, def: 'command-post', op: '>=', count: 1 },
      ],
      actions: [
        spawn('h-troopers', 2),
        spawn('h-skiffs', 1),
        { type: 'orderUnits', region: `lane-${h.id}`, owner: FOE, order: 'attackMove', x: BASE_X, z: BASE_Z },
      ],
    })
    // Held back until its opening beat, so the far holds are not attacking
    // from minute one — the valley wakes up as you walk into it.
    triggers.push({
      id: `wake-${h.id}`,
      name: `${h.id} hold wakes`,
      once: true,
      events: [{ type: 'timer', seconds: h.first }],
      conditions: [],
      actions: [
        { type: 'message', text: `Movement from the ${h.id} hold.`, to: 'all' },
        { type: 'setTrigger', trigger: `wave-${h.id}`, on: true },
      ],
    })
    triggers.push({
      id: `fell-${h.id}`,
      name: `${h.id} hold has fallen`,
      once: true,
      events: [{ type: 'timer', seconds: 3, periodic: true }],
      conditions: [
        { type: 'unitCountInRegion', region: `hold-${h.id}`, owner: FOE, def: 'command-post', op: '<=', count: 0 },
      ],
      actions: [
        { type: 'message', text: `The ${h.id} hold is down. Its waves have stopped — take the ground.`, to: 'all' },
        { type: 'setTrigger', trigger: `wave-${h.id}`, on: false },
      ],
    })
  }

  // Holding is not winning. All three keeps have to come down, which means the
  // company has to stop defending and go north — and that is a decision about
  // when, made against a wave clock that only stops when you stop it.
  triggers.push({
    id: 'won',
    name: 'The valley is clear',
    once: true,
    events: [{ type: 'timer', seconds: 3, periodic: true }],
    conditions: HOLDS.map((h) => ({
      type: 'unitCountInRegion' as const,
      region: `hold-${h.id}`,
      owner: FOE,
      def: 'command-post',
      op: '<=' as const,
      count: 0,
    })),
    actions: [
      { type: 'message', text: 'Every hold is down. The valley is yours.', to: 'all' },
      // Any squad seat will do — victory resolves to that player's TEAM, and
      // every squad and the commander share one.
      { type: 'victory', player: SQUADS[0] },
    ],
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
    // The cliff layer is what makes this a valley rather than a field:
    // deriveTerrain reads it for the walls, and the renderer for their height.
    cliffLevel,
    texture,
    heightJitter,
    fog: 'off', // a defence map: you are meant to see the wave forming
    races: ['compact'],
    // Eight seats: six squads, then the commander, then the thing outside.
    // Order matters — see the slot constants.
    startLocations: [
      ...SQUAD_KINDS.map((k) => ({ x: k.padX, z: MUSTER_Z })),
      { x: BASE_X, z: BASE_Z - 8 },
      { x: HOLDS[0].x, z: HOLDS[0].z },
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
