import type { MapRegion, PlacedEntity, RtsMapDoc, TriggerDef } from '../mapdoc.ts'
import type { RulesetModule } from '../ruleset.ts'
import { composeDef } from './factions/compose.ts'
import { FACTION as COMPACT } from './factions/compact.ts'

// "Squad Support" — a corridor with three enemy holds in it.
//
// The shape is borrowed from the StarCraft co-op custom maps: a commander runs
// an economy behind the line while everyone else fields a handful of units and
// no buildings at all. What is different here is who commands. The base is run
// by the COMPUTER, which makes the players purely a fighting force — nobody is
// sitting in a build menu while the wave lands, and a lobby of six all get the
// same job.
//
// Each player owns a Muster Post and nothing else. Select it and the command
// card offers six soldiers; command points are the entire budget, so what you
// have is what you chose to spend them on — six riflemen, or two gunships, or
// three siege guns behind a medic. Lose them and the points come back, so a
// company that opened with rifles finishes the night with flak and artillery
// because that is what kept dying. Choosing under pressure, with what the last
// wave did to you still on screen, is the whole game.
//
// A squad is loose men, not a battalion. The rest of this game is built on
// battalions — nine bound soldiers ordered as one shape, which is the right
// object when you command an army and the wrong one when you command six men:
// the whole point of a squad is pulling it apart. So the post trains soldiers,
// one at a time. The armies either side of you still muster in battalions,
// which is also the difference between you and them.
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

// ---- geography -------------------------------------------------------------
// A valley running south to north. The company musters at the bottom, the
// commander's keep sits behind it, and three enemy holds are stacked up the
// corridor. Everything below is expressed against these.
const MID_X = SIZE / 2
const BASE_X = MID_X
const BASE_Z = 142
/**
 * The muster ground, and how far it sits from the keep.
 *
 * Both were further south and the two ran into each other: a Command Post
 * brings a ring of build plots fifteen units wide, and the posts were inside
 * it, so a player opened on a confused pile of buildings unable to tell which
 * were his. There is a clear gap between them now, and enough ground south of
 * the muster that the opening camera is looking at the map rather than at the
 * void past its edge.
 */
const MUSTER_X = MID_X
const MUSTER_Z = 166

/**
 * The three enemy holds, near to far. Each is a keep with its own plot ring,
 * so what you march into is a base the computer has been building all match,
 * not a lone building on bare ground.
 *
 * `lane` is where its waves form up — in front of the hold, so a wave visibly
 * comes OUT of the place you are going to have to take.
 */
const HOLDS = [
  { id: 'south', x: MID_X, z: 104, laneZ: 118, first: 30, every: 42 },
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

/**
 * Where each squad player's Muster Post stands, left to right across the
 * muster ground.
 *
 * Well south of the commander's keep and its ring of build plots. The first
 * version put the pick area on top of the base, and the two read as one
 * confused pile of buildings — you could not tell what was yours.
 */
const POST_X = (slot: number): number => MUSTER_X - 33 + slot * 13

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
    /**
     * Where a squad comes from.
     *
     * The first version made you walk an officer onto a coloured square on the
     * ground. That was not a design choice, it was a limit of having built the
     * whole map inside the trigger runtime, which has no way to draw a button.
     * The engine has had one all along: select a building and the command card
     * renders its trainable units with hotkeys, a queue, costs and cancel. So
     * this is a building, and picking a squad is the same gesture as picking
     * anything else in the game.
     *
     * `untargetable` because it is furniture, not a target — losing it would
     * put a player out of the match with nothing they could have done about it,
     * and there is no rebuilding it.
     */
    {
      id: 'muster-post',
      name: 'Muster Post',
      kind: 'building',
      radius: 2.2,
      hp: 500,
      untargetable: true,
      armorType: 'structure',
      visual: { model: 'gen:barrack-block', tint: 'owner' },
      // Command points are the whole economy of a squad player: no resources,
      // no buildings to raise, just how many bodies you may have at once and
      // what you spend them on. Twelve buys six riflemen, or two gunships, or
      // three siege guns and a medic.
      supplyProvided: 12,
      trainer: {
        trains: ['sq-rifleman', 'sq-flak', 'sq-skiff', 'sq-gunship', 'sq-medic', 'sq-siege'],
        queueSize: 4,
      },
    },

    // ---- the six squad units -------------------------------------------
    //
    // Map-local rather than the Compact's own troopers and lancers, and
    // deliberately so: supply here is charged PER BODY, and the faction charges
    // it per battalion (the ticket carries the cost, its members are authored
    // at zero — see supplyPower). Putting a supply cost on `trooper` would have
    // billed the commander twice for every battalion it trained. These are the
    // same soldiers priced for a different kind of player.
    {
      id: 'sq-rifleman', name: 'Rifleman', kind: 'unit', radius: 0.36, hp: 110,
      armorType: 'infantry', xpValue: 8,
      supplyCost: 2, buildTimeTicks: 60, cost: [],
      visual: { model: 'gen:trooper', tint: 'owner' },
      mover: { speed: 4.0 },
      combat: { damage: 13, range: 8.5, acquire: 11, periodTicks: 12, damageType: 'arrow', hits: 'both' },
    },
    {
      id: 'sq-flak', name: 'Flak Lancer', kind: 'unit', radius: 0.4, hp: 150,
      armorType: 'infantry', xpValue: 14,
      supplyCost: 3, buildTimeTicks: 75, cost: [],
      visual: { model: 'gen:lancer-trooper', tint: 'owner' },
      mover: { speed: 3.6 },
      combat: { damage: 34, range: 12, acquire: 14, periodTicks: 20, damageType: 'kinetic', hits: 'air' },
    },
    {
      id: 'sq-skiff', name: 'Skiff', kind: 'unit', radius: 0.5, hp: 130,
      armorType: 'archer', xpValue: 16, flying: true,
      supplyCost: 3, buildTimeTicks: 80, cost: [],
      visual: { model: 'gen:skiff', tint: 'owner' },
      mover: { speed: 6.6 },
      combat: { damage: 16, range: 6.5, acquire: 9, periodTicks: 11, damageType: 'kinetic', hits: 'ground' },
    },
    {
      id: 'sq-gunship', name: 'Gunship', kind: 'unit', radius: 0.7, hp: 340,
      armorType: 'engine', xpValue: 38, flying: true,
      supplyCost: 6, buildTimeTicks: 140, cost: [],
      visual: { model: 'gen:gunship', scale: 1.15, tint: 'owner' },
      mover: { speed: 4.6 },
      combat: { damage: 30, range: 9, acquire: 12, periodTicks: 16, damageType: 'kinetic', hits: 'both' },
    },
    {
      // No weapon at all. A medic left alone dies without landing a blow,
      // which is the point: it is a thing the others have to cover.
      id: 'sq-medic', name: 'Medic', kind: 'unit', radius: 0.34, hp: 95,
      armorType: 'infantry', xpValue: 10,
      supplyCost: 2, buildTimeTicks: 55, cost: [],
      visual: { model: 'gen:trooper', tint: 'owner' },
      mover: { speed: 4.2 },
      abilities: [{ ability: 'field-dressing', autocast: true }],
    },
    {
      // Artillery: outranges everything on the field, cannot defend itself,
      // and cannot elevate. Park it behind the line or lose it.
      id: 'sq-siege', name: 'Siege Gun', kind: 'unit', radius: 0.62, hp: 210,
      armorType: 'engine', xpValue: 30,
      supplyCost: 4, buildTimeTicks: 110, cost: [],
      visual: { model: 'gen:lancer-trooper', scale: 1.2, tint: 'owner' },
      mover: { speed: 2.6 },
      combat: {
        damage: 46, range: 19, acquire: 21, periodTicks: 34,
        damageType: 'siege', hits: 'ground',
        splashRadius: 3.2, splashEdgePct: 45,
        projectile: { speed: 13, splashRadius: 3.2, edgePct: 45 },
      },
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

  // ---- what stands on the ground at tick 0 ----
  // Keeps and neutral ground, nothing else. Both computers build their own out
  // from these, so the holds you march on are bases the enemy raised over the
  // match — how hard they are to crack depends on how long you left them.
  const placed: PlacedEntity[] = [
    { def: 'command-post', owner: CMDR, x: BASE_X, z: BASE_Z, always: true },
    ...HOLDS.map((h) => ({ def: 'command-post', owner: FOE, x: h.x, z: h.z, always: true })),
    // One post per squad seat. Not `always`: an unfilled seat should not get
    // furniture, and spawnBuilding-at-setup already skips owners the match is
    // not running.
    ...SQUADS.map((slot) => ({ def: 'muster-post', owner: slot, x: POST_X(slot), z: MUSTER_Z })),
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
    rect('core', 'Command Post', BASE_X, BASE_Z, 18, 18),
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
      { type: 'message', text: 'Select your Muster Post and train a squad — command points are your only budget.', to: 'all' },
      { type: 'message', text: 'Three enemy holds up the valley. Put all three Command Posts down to win.', to: 'all' },
      ...SQUADS.map((slot) => ({
        type: 'modifyResource' as const,
        owner: slot,
        resource: 'res',
        delta: -100000,
      })),
    ],
  })

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
      ...SQUADS.map((slot) => ({ x: POST_X(slot), z: MUSTER_Z })),
      { x: BASE_X, z: BASE_Z - 8 },
      { x: HOLDS[0].x, z: HOLDS[0].z },
    ],
    startNames: [
      ...SQUADS.map((_, i) => `Squad ${i + 1}`),
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
