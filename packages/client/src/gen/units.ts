import type { GenBlueprint, GenPart, Vec3 } from './blueprint.ts'

// Unit blueprints: stout battle badgers. Shared anatomy comes from helpers so
// a new troop type is a palette + gear list, not a re-sculpt. The 'player'
// color slot is resolved per owner at build time (tunic, trim, plates).
//
// Anatomy is authored for radius ~0.4 defs: feet at y=0, eyeline ~1.05, total
// height ~1.3 before visual.scale. Arms live in armL/armR groups pivoted at
// the shoulder so the renderer can swing them (walk cycle, attack chop).

const FUR = {
  fur: '#4d4e57',
  furDark: '#35363d',
  stripe: '#e8e6df',
  snout: '#26262b',
  leather: '#6d5236',
  wood: '#6b4a2f',
  metal: '#aab1ba',
  metalDark: '#7c828c',
}

// Torso, legs, head with the badger stripe — everything except arms and gear.
function badgerCore(): GenPart[] {
  return [
    // legs
    { shape: 'capsule', color: 'furDark', radius: 0.09, height: 0.16, at: [-0.14, 0.18, 0] },
    { shape: 'capsule', color: 'furDark', radius: 0.09, height: 0.16, at: [0.14, 0.18, 0] },
    // torso: fur under a player-colored tunic
    { shape: 'capsule', color: 'fur', radius: 0.26, height: 0.34, at: [0, 0.58, 0] },
    { shape: 'cylinder', color: 'player', radius: 0.29, radiusTop: 0.24, height: 0.3, at: [0, 0.52, 0] },
    // head: sphere + snout cone + nose, stripe running snout-to-crown, ears
    { shape: 'sphere', color: 'fur', radius: 0.22, at: [0, 1.02, 0.02] },
    { shape: 'cone', color: 'fur', radius: 0.13, height: 0.24, at: [0, 0.98, 0.22], rot: [1.35, 0, 0] },
    { shape: 'sphere', color: 'snout', radius: 0.05, at: [0, 0.96, 0.34] },
    { shape: 'box', color: 'stripe', size: [0.08, 0.05, 0.42], at: [0, 1.13, 0.1], rot: [-0.35, 0, 0] },
    { shape: 'box', color: 'snout', size: [0.2, 0.045, 0.2], at: [0, 1.05, 0.16], rot: [-0.3, 0, 0] },
    { shape: 'sphere', color: 'furDark', radius: 0.055, at: [-0.13, 1.2, -0.02] },
    { shape: 'sphere', color: 'furDark', radius: 0.055, at: [0.13, 1.2, -0.02] },
    // stubby tail
    { shape: 'sphere', color: 'furDark', radius: 0.1, at: [0, 0.42, -0.26], scale: [1, 0.8, 1.3] },
  ]
}

// A furry arm in the given group, hinged at the shoulder.
function arm(side: 'armL' | 'armR', drop = 0): GenPart {
  const x = side === 'armL' ? -0.32 : 0.32
  return {
    shape: 'capsule', color: 'fur', radius: 0.08, height: 0.26,
    at: [x, 0.6 - drop, 0.04], rot: [0, 0, side === 'armL' ? 0.25 : -0.25],
    group: side, pivot: [x * 0.82, 0.82, 0],
  }
}

const swordsman: GenBlueprint = {
  id: 'badger-sword',
  seed: 0xbad9e51,
  palette: FUR,
  parts: [
    ...badgerCore(),
    arm('armR'),
    // sword: blade + guard + grip, held forward-down so the chop reads
    { shape: 'box', color: 'metal', size: [0.045, 0.5, 0.1], at: [0.36, 0.42, 0.3], rot: [-1.15, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    { shape: 'box', color: 'metalDark', size: [0.16, 0.04, 0.06], at: [0.36, 0.5, 0.12], rot: [-1.15, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    arm('armL'),
    // round shield on the left forearm
    { shape: 'cylinder', color: 'player', radius: 0.2, height: 0.05, at: [-0.42, 0.55, 0.08], rot: [0, 0, 1.57], group: 'armL', pivot: [-0.26, 0.82, 0] },
    { shape: 'sphere', color: 'metal', radius: 0.06, at: [-0.46, 0.55, 0.08], group: 'armL', pivot: [-0.26, 0.82, 0] },
  ],
}

const spearman: GenBlueprint = {
  id: 'badger-spear',
  seed: 0xbad95ea,
  palette: FUR,
  parts: [
    ...badgerCore(),
    arm('armR'),
    // long spear angled forward; tip well above the head
    { shape: 'cylinder', color: 'wood', radius: 0.03, height: 1.5, at: [0.38, 0.7, 0.1], rot: [-0.4, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    { shape: 'cone', color: 'metal', radius: 0.06, height: 0.22, at: [0.38, 1.39, 0.39], rot: [-0.4, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    arm('armL'),
    // small buckler
    { shape: 'cylinder', color: 'player', radius: 0.15, height: 0.05, at: [-0.4, 0.55, 0.08], rot: [0, 0, 1.57], group: 'armL', pivot: [-0.26, 0.82, 0] },
  ],
}

const archer: GenBlueprint = {
  id: 'badger-bow',
  seed: 0xbad9b0b,
  palette: { ...FUR, string: '#d8d5c8' },
  parts: [
    ...badgerCore(),
    // quiver across the back
    { shape: 'cylinder', color: 'leather', radius: 0.07, height: 0.4, at: [-0.12, 0.78, -0.22], rot: [0.25, 0, 0.35] },
    { shape: 'cone', color: 'player', radius: 0.045, height: 0.12, at: [-0.2, 1.0, -0.28], rot: [0.25, 0, 0.35], count: 3, spread: [0.045, 0.02, 0.03] },
    // bow held out in the left hand: two limbs + string
    arm('armL', 0.05),
    { shape: 'cylinder', color: 'wood', radius: 0.028, height: 0.5, at: [-0.42, 0.82, 0.14], rot: [0.5, 0, 0], group: 'armL', pivot: [-0.26, 0.82, 0] },
    { shape: 'cylinder', color: 'wood', radius: 0.028, height: 0.5, at: [-0.42, 0.4, 0.14], rot: [-0.5, 0, 0], group: 'armL', pivot: [-0.26, 0.82, 0] },
    { shape: 'box', color: 'string', size: [0.015, 0.62, 0.015], at: [-0.42, 0.61, 0.02], group: 'armL', pivot: [-0.26, 0.82, 0] },
    // draw arm
    arm('armR'),
  ],
}

const priest: GenBlueprint = {
  id: 'badger-staff',
  seed: 0xbad9057,
  palette: { ...FUR, gem: '#8ff0e2' },
  parts: [
    // robe instead of legs+tunic: a lathe skirt in the player color
    { shape: 'lathe', color: 'player', profile: [[0.3, 0], [0.28, 0.3], [0.2, 0.7], [0.14, 0.9]], at: [0, 0, 0] },
    { shape: 'capsule', color: 'fur', radius: 0.24, height: 0.28, at: [0, 0.72, 0] },
    // head (slightly higher than the core helper puts it)
    { shape: 'sphere', color: 'fur', radius: 0.22, at: [0, 1.1, 0.02] },
    { shape: 'cone', color: 'fur', radius: 0.13, height: 0.24, at: [0, 1.06, 0.22], rot: [1.35, 0, 0] },
    { shape: 'sphere', color: 'snout', radius: 0.05, at: [0, 1.04, 0.34] },
    { shape: 'box', color: 'stripe', size: [0.08, 0.05, 0.42], at: [0, 1.21, 0.1], rot: [-0.35, 0, 0] },
    { shape: 'sphere', color: 'furDark', radius: 0.055, at: [-0.13, 1.28, -0.02] },
    { shape: 'sphere', color: 'furDark', radius: 0.055, at: [0.13, 1.28, -0.02] },
    // hood collar
    { shape: 'cylinder', color: 'player', radius: 0.2, radiusTop: 0.26, height: 0.14, at: [0, 0.95, 0] },
    // staff with a floating gem, held upright in the right hand
    arm('armR', -0.05),
    { shape: 'cylinder', color: 'wood', radius: 0.032, height: 1.35, at: [0.38, 0.75, 0.08], group: 'armR', pivot: [0.26, 0.9, 0] },
    { shape: 'sphere', color: 'gem', radius: 0.09, at: [0.38, 1.5, 0.08], segments: 6, group: 'armR', pivot: [0.26, 0.9, 0] },
    arm('armL', -0.02),
  ],
}

const worker: GenBlueprint = {
  id: 'badger-worker',
  seed: 0xbad90e0,
  palette: FUR,
  parts: [
    ...badgerCore(),
    // rucksack
    { shape: 'box', color: 'leather', size: [0.28, 0.3, 0.16], at: [0, 0.68, -0.26], rot: [0.1, 0, 0] },
    // pickaxe over the right shoulder
    arm('armR', -0.03),
    { shape: 'cylinder', color: 'wood', radius: 0.035, height: 0.7, at: [0.36, 0.85, -0.05], rot: [0.5, 0, -0.15], group: 'armR', pivot: [0.26, 0.85, 0] },
    { shape: 'cone', color: 'metalDark', radius: 0.05, height: 0.3, at: [0.4, 1.12, 0.14], rot: [0, 0, -1.57], group: 'armR', pivot: [0.26, 0.85, 0] },
    { shape: 'cone', color: 'metalDark', radius: 0.05, height: 0.3, at: [0.16, 1.12, 0.14], rot: [0, 0, 1.57], group: 'armR', pivot: [0.26, 0.85, 0] },
    arm('armL'),
  ],
}

const hero: GenBlueprint = {
  id: 'badger-hero',
  seed: 0xbad4e40,
  palette: { ...FUR, cape: '#3a2f4a' },
  parts: [
    ...badgerCore(),
    // pauldrons, crested helm, cape — a head taller than the rank and file
    { shape: 'sphere', color: 'player', radius: 0.13, at: [-0.3, 0.82, 0], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'player', radius: 0.13, at: [0.3, 0.82, 0], scale: [1.1, 0.8, 1.1] },
    { shape: 'cone', color: 'metal', radius: 0.2, height: 0.26, at: [0, 1.32, 0], segments: 8 },
    { shape: 'box', color: 'player', size: [0.05, 0.16, 0.3], at: [0, 1.42, -0.02], rot: [-0.15, 0, 0] },
    { shape: 'box', color: 'cape', size: [0.4, 0.72, 0.05], at: [0, 0.62, -0.3], rot: [0.12, 0, 0] },
    // greatsword
    arm('armR'),
    { shape: 'box', color: 'metal', size: [0.06, 0.72, 0.13], at: [0.38, 0.45, 0.36], rot: [-1.05, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    { shape: 'box', color: 'metalDark', size: [0.22, 0.05, 0.07], at: [0.38, 0.58, 0.14], rot: [-1.05, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    arm('armL'),
    { shape: 'cylinder', color: 'player', radius: 0.22, height: 0.06, at: [-0.44, 0.55, 0.08], rot: [0, 0, 1.57], group: 'armL', pivot: [-0.26, 0.82, 0] },
  ],
}

// Four-legged creep for the MOBA lanes: low chitinous gnasher. No arm groups —
// it reads through the whole-body bob/lunge the renderer already applies.
const gnasher: GenBlueprint = {
  id: 'gnasher',
  seed: 0x94a54e4,
  palette: { hide: '#4a4038', hideDark: '#332c26', jaw: '#d8d0c2' },
  parts: [
    { shape: 'sphere', color: 'hide', radius: 0.36, at: [0, 0.38, -0.05], scale: [1, 0.78, 1.45], jitter: 0.03 },
    // carapace plates along the spine in the owner color
    { shape: 'sphere', color: 'player', radius: 0.16, at: [0, 0.58, -0.05], scale: [1.1, 0.5, 1.2], count: 3, spread: [0, 0.02, 0.28], sizeJitter: 0.25 },
    // head + underslung jaw + teeth
    { shape: 'sphere', color: 'hide', radius: 0.22, at: [0, 0.42, 0.48], scale: [1, 0.9, 1.1] },
    { shape: 'box', color: 'jaw', size: [0.26, 0.07, 0.24], at: [0, 0.3, 0.56] },
    { shape: 'cone', color: 'jaw', radius: 0.035, height: 0.1, at: [-0.09, 0.4, 0.66], rot: [3.1, 0, 0] },
    { shape: 'cone', color: 'jaw', radius: 0.035, height: 0.1, at: [0.09, 0.4, 0.66], rot: [3.1, 0, 0] },
    // four stubby legs
    { shape: 'capsule', color: 'hideDark', radius: 0.07, height: 0.14, at: [-0.24, 0.16, 0.26] },
    { shape: 'capsule', color: 'hideDark', radius: 0.07, height: 0.14, at: [0.24, 0.16, 0.26] },
    { shape: 'capsule', color: 'hideDark', radius: 0.07, height: 0.14, at: [-0.24, 0.16, -0.3] },
    { shape: 'capsule', color: 'hideDark', radius: 0.07, height: 0.14, at: [0.24, 0.16, -0.3] },
    // tail spike
    { shape: 'cone', color: 'hideDark', radius: 0.09, height: 0.4, at: [0, 0.4, -0.62], rot: [-1.9, 0, 0] },
  ],
}


// Cavalry: a badger riding a stout boar-like steed. Deliberately ONE body
// group — the ±0.45 rad walk swing that suits infantry arms reads as flailing
// on a couched lance, and the whole-unit bob plus the attack lunge already
// sell a charge.
const rider: GenBlueprint = {
  id: 'badger-rider',
  seed: 0xb1de7,
  palette: { ...FUR, hide: '#6a5648', hideDark: '#4b3d33', tusk: '#ded6c4' },
  parts: [
    // steed: barrel body, four legs, low head with tusks
    { shape: 'sphere', color: 'hide', radius: 0.44, at: [0, 0.62, 0], scale: [1, 0.88, 1.5], jitter: 0.03 },
    { shape: 'sphere', color: 'hide', radius: 0.26, at: [0, 0.66, 0.72], scale: [1, 0.9, 1.1] },
    { shape: 'cone', color: 'hideDark', radius: 0.15, height: 0.3, at: [0, 0.6, 0.95], rot: [1.4, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.04, height: 0.16, at: [-0.11, 0.58, 1.0], rot: [-0.5, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.04, height: 0.16, at: [0.11, 0.58, 1.0], rot: [-0.5, 0, 0] },
    { shape: 'capsule', color: 'hideDark', radius: 0.1, height: 0.3, at: [-0.28, 0.3, 0.42] },
    { shape: 'capsule', color: 'hideDark', radius: 0.1, height: 0.3, at: [0.28, 0.3, 0.42] },
    { shape: 'capsule', color: 'hideDark', radius: 0.1, height: 0.3, at: [-0.28, 0.3, -0.42] },
    { shape: 'capsule', color: 'hideDark', radius: 0.1, height: 0.3, at: [0.28, 0.3, -0.42] },
    { shape: 'sphere', color: 'hideDark', radius: 0.09, at: [0, 0.66, -0.72], scale: [1, 1, 1.5] },
    // caparison in the owner's colours
    { shape: 'box', color: 'player', size: [0.86, 0.42, 0.7], at: [0, 0.6, -0.06] },
    // rider: a compact badger seated above the withers
    { shape: 'capsule', color: 'fur', radius: 0.2, height: 0.22, at: [0, 1.1, -0.08] },
    { shape: 'cylinder', color: 'player', radius: 0.22, radiusTop: 0.18, height: 0.22, at: [0, 1.06, -0.08] },
    { shape: 'sphere', color: 'fur', radius: 0.17, at: [0, 1.42, -0.04] },
    { shape: 'cone', color: 'fur', radius: 0.1, height: 0.18, at: [0, 1.39, 0.13], rot: [1.35, 0, 0] },
    { shape: 'sphere', color: 'snout', radius: 0.04, at: [0, 1.37, 0.22] },
    { shape: 'box', color: 'stripe', size: [0.06, 0.04, 0.32], at: [0, 1.5, 0.02], rot: [-0.35, 0, 0] },
    { shape: 'sphere', color: 'furDark', radius: 0.045, at: [-0.1, 1.55, -0.07] },
    { shape: 'sphere', color: 'furDark', radius: 0.045, at: [0.1, 1.55, -0.07] },
    // couched lance with a pennant, angled past the steed's shoulder
    { shape: 'cylinder', color: 'wood', radius: 0.028, height: 1.9, at: [0.3, 1.08, 0.35], rot: [-1.42, 0, 0] },
    { shape: 'cone', color: 'metal', radius: 0.05, height: 0.2, at: [0.3, 1.02, 1.28], rot: [-1.42, 0, 0] },
    { shape: 'box', color: 'player', size: [0.04, 0.22, 0.3], at: [0.3, 1.16, 0.62] },
  ],
}

// Siege engine: frame, wheels and a counterweighted throwing arm. The arm is a
// 'weapon' group so it hurls on the attack tick and stays put while rolling.
const catapult: GenBlueprint = {
  id: 'catapult',
  seed: 0xca7a,
  palette: { ...FUR, frame: '#6b4a2f', frameDark: '#4c331f', iron: '#7c828c', stone: '#8d8f96' },
  parts: [
    // chassis + axle-mounted wheels (cylinders laid on their sides)
    { shape: 'box', color: 'frame', size: [1.0, 0.22, 1.7], at: [0, 0.5, 0] },
    { shape: 'cylinder', color: 'frameDark', radius: 0.44, height: 0.15, segments: 9, at: [-0.62, 0.46, 0.35], rot: [0, 0, 1.5708] },
    { shape: 'cylinder', color: 'frameDark', radius: 0.44, height: 0.15, segments: 9, at: [0.62, 0.46, 0.35], rot: [0, 0, 1.5708] },
    { shape: 'cylinder', color: 'frameDark', radius: 0.34, height: 0.14, segments: 9, at: [-0.6, 0.36, -0.6], rot: [0, 0, 1.5708] },
    { shape: 'cylinder', color: 'frameDark', radius: 0.34, height: 0.14, segments: 9, at: [0.6, 0.36, -0.6], rot: [0, 0, 1.5708] },
    // A-frame uprights carrying the axle
    { shape: 'box', color: 'frame', size: [0.13, 0.85, 0.13], at: [-0.34, 0.95, -0.15], rot: [0.22, 0, 0] },
    { shape: 'box', color: 'frame', size: [0.13, 0.85, 0.13], at: [0.34, 0.95, -0.15], rot: [0.22, 0, 0] },
    { shape: 'cylinder', color: 'iron', radius: 0.07, height: 0.8, at: [0, 1.3, -0.05], rot: [0, 0, 1.5708] },
    // ammunition stacked on the bed
    { shape: 'sphere', color: 'stone', radius: 0.15, at: [0, 0.68, -0.62], count: 3, spread: [0.24, 0.04, 0.16], sizeJitter: 0.25, jitter: 0.03 },
    // ---- throwing arm (hinged at the axle) ----
    { shape: 'box', color: 'frame', size: [0.14, 1.7, 0.14], at: [0, 2.0, -0.5], rot: [-0.42, 0, 0], group: 'weapon', pivot: [0, 1.3, -0.05] },
    { shape: 'sphere', color: 'stone', radius: 0.2, at: [0, 2.75, -0.83], group: 'weapon', pivot: [0, 1.3, -0.05] },
    { shape: 'cylinder', color: 'player', radius: 0.19, radiusTop: 0.24, height: 0.2, at: [0, 2.72, -0.82], group: 'weapon', pivot: [0, 1.3, -0.05] },
    // counterweight on the short end, below the axle
    { shape: 'box', color: 'iron', size: [0.3, 0.3, 0.3], at: [0, 0.98, 0.22], group: 'weapon', pivot: [0, 1.3, -0.05] },
  ],
}


// The ogre: a badger grown wrong. Hunched, top-heavy and built around the
// club, which lives in armR so it swings on the attack tick. Authored large —
// roughly twice a swordsman — since its silhouette is the whole read.
const ogre: GenBlueprint = {
  id: 'badger-ogre',
  seed: 0x09e,
  palette: { ...FUR, hide: '#5a5147', hideDark: '#3d3730', gut: '#6b6255', club: '#5c3f26' },
  parts: [
    // squat legs and a heavy gut
    { shape: 'capsule', color: 'hideDark', radius: 0.17, height: 0.3, at: [-0.26, 0.32, 0] },
    { shape: 'capsule', color: 'hideDark', radius: 0.17, height: 0.3, at: [0.26, 0.32, 0] },
    { shape: 'sphere', color: 'gut', radius: 0.44, at: [0, 0.86, 0.06], scale: [1.05, 0.95, 0.9], jitter: 0.04 },
    // hunched shoulders, wider than the hips
    { shape: 'sphere', color: 'hide', radius: 0.46, at: [0, 1.24, -0.08], scale: [1.35, 0.85, 1], jitter: 0.05 },
    { shape: 'sphere', color: 'player', radius: 0.2, at: [-0.52, 1.36, -0.06], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'player', radius: 0.2, at: [0.52, 1.36, -0.06], scale: [1.1, 0.8, 1.1] },
    // small mean head sunk between the shoulders, badger stripe intact
    { shape: 'sphere', color: 'fur', radius: 0.21, at: [0, 1.52, 0.16] },
    { shape: 'cone', color: 'fur', radius: 0.12, height: 0.22, at: [0, 1.47, 0.36], rot: [1.35, 0, 0] },
    { shape: 'sphere', color: 'snout', radius: 0.05, at: [0, 1.45, 0.47] },
    { shape: 'box', color: 'stripe', size: [0.07, 0.045, 0.38], at: [0, 1.62, 0.24], rot: [-0.35, 0, 0] },
    { shape: 'sphere', color: 'furDark', radius: 0.05, at: [-0.12, 1.68, 0.1] },
    { shape: 'sphere', color: 'furDark', radius: 0.05, at: [0.12, 1.68, 0.1] },
    // loincloth in the owner's colours
    { shape: 'cylinder', color: 'player', radius: 0.42, radiusTop: 0.38, height: 0.26, at: [0, 0.62, 0] },
    // left arm: long, knuckles near the ground
    { shape: 'capsule', color: 'hide', radius: 0.15, height: 0.5, at: [-0.62, 0.96, 0.02], rot: [0, 0, 0.2], group: 'armL', pivot: [-0.5, 1.34, 0] },
    { shape: 'sphere', color: 'hideDark', radius: 0.18, at: [-0.7, 0.6, 0.04], group: 'armL', pivot: [-0.5, 1.34, 0] },
    // right arm and the club: a tree trunk with iron studs
    { shape: 'capsule', color: 'hide', radius: 0.16, height: 0.5, at: [0.62, 0.96, 0.02], rot: [0, 0, -0.2], group: 'armR', pivot: [0.5, 1.34, 0] },
    { shape: 'cylinder', color: 'club', radius: 0.08, radiusTop: 0.17, height: 1.5, at: [0.74, 0.62, 0.42], rot: [-1.1, 0, 0], group: 'armR', pivot: [0.5, 1.34, 0] },
    { shape: 'sphere', color: 'club', radius: 0.24, at: [0.74, 0.34, 1.02], jitter: 0.05, group: 'armR', pivot: [0.5, 1.34, 0] },
    { shape: 'cone', color: 'metalDark', radius: 0.05, height: 0.16, at: [0.74, 0.34, 1.02], rot: [-1.1, 0, 0], count: 4, spread: [0.18, 0.16, 0.14], tilt: 0.6 },
  ],
}


// ---- The Horde ----
// Orcs are read against badgers at a glance: smaller, hunched, sickly green
// hide instead of fur, no white face stripe, crude iron instead of steel. They
// share the arm-group rig so they animate identically — only the silhouette
// and palette differ, which is exactly what the blueprint format is for.
const ORC = {
  hide: '#6b7a4a',
  hideDark: '#4d5834',
  snout: '#2a2f22',
  tusk: '#ded6c4',
  rag: '#5a4a38',
  iron: '#7f8288',
  ironDark: '#5c5f64',
  wood: '#5c4126',
}

// Hunched torso, jutting jaw, no stripe — everything but arms and gear.
function orcCore(): GenPart[] {
  return [
    { shape: 'capsule', color: 'hideDark', radius: 0.075, height: 0.13, at: [-0.12, 0.15, 0] },
    { shape: 'capsule', color: 'hideDark', radius: 0.075, height: 0.13, at: [0.12, 0.15, 0] },
    // torso leans forward; rag tunic in the owner's colours
    { shape: 'capsule', color: 'hide', radius: 0.21, height: 0.26, at: [0, 0.48, 0.03], rot: [0.18, 0, 0] },
    { shape: 'cylinder', color: 'player', radius: 0.23, radiusTop: 0.19, height: 0.24, at: [0, 0.44, 0.02] },
    { shape: 'box', color: 'rag', size: [0.3, 0.16, 0.26], at: [0, 0.3, 0.02] },
    // small head thrust forward, underbite with tusks
    { shape: 'sphere', color: 'hide', radius: 0.17, at: [0, 0.8, 0.1] },
    { shape: 'cone', color: 'hide', radius: 0.1, height: 0.2, at: [0, 0.76, 0.27], rot: [1.4, 0, 0] },
    { shape: 'box', color: 'snout', size: [0.15, 0.05, 0.13], at: [0, 0.71, 0.28] },
    { shape: 'cone', color: 'tusk', radius: 0.025, height: 0.08, at: [-0.05, 0.75, 0.32], rot: [3.1, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.025, height: 0.08, at: [0.05, 0.75, 0.32], rot: [3.1, 0, 0] },
    // ragged ears out to the sides, not badger ears on top
    { shape: 'cone', color: 'hideDark', radius: 0.05, height: 0.14, at: [-0.17, 0.84, 0.06], rot: [0, 0, 1.3] },
    { shape: 'cone', color: 'hideDark', radius: 0.05, height: 0.14, at: [0.17, 0.84, 0.06], rot: [0, 0, -1.3] },
  ]
}

function orcArm(side: 'armL' | 'armR', drop = 0): GenPart {
  const x = side === 'armL' ? -0.26 : 0.26
  return {
    shape: 'capsule', color: 'hide', radius: 0.065, height: 0.24,
    at: [x, 0.48 - drop, 0.04], rot: [0, 0, side === 'armL' ? 0.28 : -0.28],
    group: side, pivot: [x * 0.82, 0.68, 0],
  }
}

const orcSword: GenBlueprint = {
  id: 'orc-sword',
  seed: 0x04c5,
  palette: ORC,
  parts: [
    ...orcCore(),
    orcArm('armR'),
    // a notched cleaver, not a sword
    { shape: 'box', color: 'iron', size: [0.04, 0.36, 0.13], at: [0.3, 0.34, 0.24], rot: [-1.15, 0, 0], group: 'armR', pivot: [0.21, 0.68, 0] },
    { shape: 'box', color: 'ironDark', size: [0.11, 0.035, 0.05], at: [0.3, 0.42, 0.1], rot: [-1.15, 0, 0], group: 'armR', pivot: [0.21, 0.68, 0] },
    orcArm('armL'),
    { shape: 'box', color: 'wood', size: [0.03, 0.26, 0.22], at: [-0.34, 0.44, 0.06], group: 'armL', pivot: [-0.21, 0.68, 0] },
  ],
}

const orcSpear: GenBlueprint = {
  id: 'orc-spear',
  seed: 0x04c59,
  palette: ORC,
  parts: [
    ...orcCore(),
    orcArm('armR'),
    { shape: 'cylinder', color: 'wood', radius: 0.025, height: 1.35, at: [0.31, 0.56, 0.08], rot: [-0.35, 0, 0], group: 'armR', pivot: [0.21, 0.68, 0] },
    { shape: 'cone', color: 'iron', radius: 0.05, height: 0.2, at: [0.31, 1.16, 0.32], rot: [-0.35, 0, 0], group: 'armR', pivot: [0.21, 0.68, 0] },
    orcArm('armL'),
  ],
}

const orcBow: GenBlueprint = {
  id: 'orc-bow',
  seed: 0x04cb0,
  palette: { ...ORC, string: '#cfc7b0' },
  parts: [
    ...orcCore(),
    { shape: 'cylinder', color: 'rag', radius: 0.06, height: 0.32, at: [-0.1, 0.64, -0.18], rot: [0.25, 0, 0.35] },
    orcArm('armL', 0.04),
    { shape: 'cylinder', color: 'wood', radius: 0.024, height: 0.42, at: [-0.34, 0.66, 0.12], rot: [0.5, 0, 0], group: 'armL', pivot: [-0.21, 0.68, 0] },
    { shape: 'cylinder', color: 'wood', radius: 0.024, height: 0.42, at: [-0.34, 0.32, 0.12], rot: [-0.5, 0, 0], group: 'armL', pivot: [-0.21, 0.68, 0] },
    { shape: 'box', color: 'string', size: [0.012, 0.52, 0.012], at: [-0.34, 0.49, 0.02], group: 'armL', pivot: [-0.21, 0.68, 0] },
    orcArm('armR'),
  ],
}


// ---- The Compact ----
// Sleek where badgers are furry and orcs are ragged: pale composite plate,
// visored helms, no snouts on show. The flyers are the read — hulls with no
// legs at all, drawn riding above the ground by the renderer.
const TECH = {
  plate: '#b9c0c8',
  plateDark: '#7c848d',
  visor: '#3fd0e0',
  hull: '#8e979f',
  hullDark: '#5d666e',
  vent: '#ff8a3a',
  gun: '#4a5058',
}

function trooperCore(): GenPart[] {
  return [
    { shape: 'capsule', color: 'plateDark', radius: 0.085, height: 0.16, at: [-0.13, 0.19, 0] },
    { shape: 'capsule', color: 'plateDark', radius: 0.085, height: 0.16, at: [0.13, 0.19, 0] },
    { shape: 'capsule', color: 'plate', radius: 0.24, height: 0.3, at: [0, 0.56, 0] },
    { shape: 'cylinder', color: 'player', radius: 0.26, radiusTop: 0.22, height: 0.26, at: [0, 0.52, 0] },
    // sealed helm, visor instead of a face
    { shape: 'sphere', color: 'plate', radius: 0.19, at: [0, 0.94, 0] },
    { shape: 'box', color: 'visor', size: [0.24, 0.07, 0.1], at: [0, 0.94, 0.17] },
    { shape: 'box', color: 'plateDark', size: [0.1, 0.16, 0.1], at: [0, 1.1, -0.06] },
    { shape: 'box', color: 'plateDark', size: [0.44, 0.2, 0.16], at: [0, 0.72, -0.16] },
  ]
}

function techArm(side: 'armL' | 'armR', drop = 0): GenPart {
  const x = side === 'armL' ? -0.3 : 0.3
  return {
    shape: 'capsule', color: 'plate', radius: 0.075, height: 0.24,
    at: [x, 0.58 - drop, 0.04], rot: [0, 0, side === 'armL' ? 0.22 : -0.22],
    group: side, pivot: [x * 0.82, 0.78, 0],
  }
}

const trooper: GenBlueprint = {
  id: 'trooper',
  seed: 0x7200,
  palette: TECH,
  parts: [
    ...trooperCore(),
    techArm('armR'),
    // rifle held across the body, barrel forward
    { shape: 'box', color: 'gun', size: [0.07, 0.1, 0.62], at: [0.26, 0.62, 0.3], group: 'armR', pivot: [0.24, 0.78, 0] },
    { shape: 'cylinder', color: 'plateDark', radius: 0.035, height: 0.2, at: [0.26, 0.62, 0.66], rot: [1.57, 0, 0], group: 'armR', pivot: [0.24, 0.78, 0] },
    techArm('armL', 0.04),
  ],
}

const lancerTrooper: GenBlueprint = {
  id: 'lancer-trooper',
  seed: 0x7201,
  palette: TECH,
  parts: [
    ...trooperCore(),
    // shoulder-mounted launcher, angled up: it only shoots at the sky
    { shape: 'box', color: 'gun', size: [0.16, 0.16, 0.7], at: [0.2, 1.0, -0.05], rot: [-0.55, 0, 0] },
    { shape: 'cylinder', color: 'plateDark', radius: 0.05, height: 0.24, at: [0.2, 1.28, 0.24], rot: [-0.55, 0, 0] },
    { shape: 'cone', color: 'vent', radius: 0.06, height: 0.14, at: [0.2, 0.78, -0.34], rot: [2.6, 0, 0] },
    techArm('armR', -0.06),
    techArm('armL', 0.04),
  ],
}

const skiff: GenBlueprint = {
  id: 'skiff',
  seed: 0x5417,
  palette: TECH,
  parts: [
    // no legs: a hull. Reads as airborne even before the altitude offset.
    { shape: 'sphere', color: 'hull', radius: 0.42, at: [0, 0.5, 0.05], scale: [1, 0.5, 1.5] },
    { shape: 'box', color: 'visor', size: [0.3, 0.08, 0.24], at: [0, 0.52, 0.6] },
    { shape: 'box', color: 'player', size: [1.5, 0.07, 0.34], at: [0, 0.5, -0.1] },
    { shape: 'cylinder', color: 'hullDark', radius: 0.11, height: 0.34, at: [-0.66, 0.5, -0.14], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'hullDark', radius: 0.11, height: 0.34, at: [0.66, 0.5, -0.14], rot: [1.57, 0, 0] },
    { shape: 'cone', color: 'vent', radius: 0.09, height: 0.24, at: [-0.66, 0.5, -0.4], rot: [-1.57, 0, 0] },
    { shape: 'cone', color: 'vent', radius: 0.09, height: 0.24, at: [0.66, 0.5, -0.4], rot: [-1.57, 0, 0] },
    { shape: 'box', color: 'gun', size: [0.06, 0.06, 0.4], at: [0, 0.36, 0.5] },
  ],
}

const gunship: GenBlueprint = {
  id: 'gunship',
  seed: 0x9457,
  palette: TECH,
  parts: [
    { shape: 'sphere', color: 'hull', radius: 0.62, at: [0, 0.6, 0], scale: [1.05, 0.55, 1.55], jitter: 0.03 },
    { shape: 'box', color: 'hullDark', size: [0.5, 0.22, 1.1], at: [0, 0.34, 0.1] },
    { shape: 'box', color: 'visor', size: [0.4, 0.1, 0.3], at: [0, 0.66, 0.86] },
    // stub wings with pods, in the owner's colours
    { shape: 'box', color: 'player', size: [2.4, 0.09, 0.5], at: [0, 0.6, -0.16] },
    { shape: 'cylinder', color: 'gun', radius: 0.13, height: 0.6, at: [-0.95, 0.48, 0.1], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'gun', radius: 0.13, height: 0.6, at: [0.95, 0.48, 0.1], rot: [1.57, 0, 0] },
    // engines and exhaust
    { shape: 'cylinder', color: 'hullDark', radius: 0.19, height: 0.5, at: [-0.5, 0.62, -0.8], rot: [1.57, 0, 0] },
    { shape: 'cylinder', color: 'hullDark', radius: 0.19, height: 0.5, at: [0.5, 0.62, -0.8], rot: [1.57, 0, 0] },
    { shape: 'cone', color: 'vent', radius: 0.15, height: 0.4, at: [-0.5, 0.62, -1.2], rot: [-1.57, 0, 0] },
    { shape: 'cone', color: 'vent', radius: 0.15, height: 0.4, at: [0.5, 0.62, -1.2], rot: [-1.57, 0, 0] },
  ],
}


// ---- eagles, beasts and heroes -------------------------------------------
// Flyers hang at y ~2.5 so they read as airborne from a top-down camera; the
// wings are armL/armR so the renderer's stride beat becomes a wingbeat.

const EAGLE = { feather: '#a8925f', feathDark: '#6f5930', feathLight: '#cbb888', beak: '#e8c65a', talon: '#3b3730' }

// Wings are built in two segments — an inner arm and a swept outer hand — with
// separate primaries, so the silhouette is a wing rather than a plank. Both
// segments live in the same group, so the whole wing beats as one piece.
function wing(side: 'armL' | 'armR', palette: 'feather' | 'membrane', dark: string): GenPart[] {
  const dir = side === 'armL' ? -1 : 1
  const pivot: Vec3 = [dir * 0.34, 2.55, 0]
  return [
    // inner: thick at the shoulder, thinning outboard
    {
      shape: 'box', color: palette, size: [1.25, 0.13, 1.15],
      at: [dir * 1.0, 2.56, -0.05], rot: [0, 0, dir * -0.06],
      group: side, pivot, hinge: 'z', jitter: 0.04,
    },
    // outer: swept back and tapered, the part that reads as a wing tip
    {
      shape: 'box', color: palette, size: [1.35, 0.09, 0.78],
      at: [dir * 2.28, 2.62, -0.34], rot: [0, dir * 0.26, dir * -0.16],
      group: side, hinge: 'z', jitter: 0.05,
    },
    // primaries: three long feathers fanning off the trailing edge
    {
      shape: 'box', color: dark, size: [0.9, 0.05, 0.2],
      at: [dir * 2.75, 2.6, -0.72], rot: [0, dir * 0.5, dir * -0.2],
      count: 3, spread: [0.32, 0.02, 0.26], tilt: 0.14, group: side, hinge: 'z',
    },
    // a band of owner colour along the leading edge, visible from above
    {
      shape: 'box', color: 'player', size: [2.1, 0.06, 0.22],
      at: [dir * 1.5, 2.63, 0.42], rot: [0, 0, dir * -0.1], group: side, hinge: 'z',
    },
  ]
}

const eagle: GenBlueprint = {
  id: 'eagle',
  seed: 0x51a1,
  palette: EAGLE,
  parts: [
    // body: a tapered spindle rather than a ball, so it has a direction
    { shape: 'sphere', color: 'feather', radius: 0.42, at: [0, 2.5, -0.1], scale: [1.0, 0.92, 2.0], jitter: 0.05 },
    { shape: 'sphere', color: 'feathLight', radius: 0.3, at: [0, 2.4, 0.35], scale: [0.9, 0.8, 1.4], jitter: 0.04 },
    // neck and head, held forward
    { shape: 'capsule', color: 'feathLight', radius: 0.16, height: 0.22, at: [0, 2.62, 0.92], rot: [1.2, 0, 0] },
    { shape: 'sphere', color: 'feathLight', radius: 0.21, at: [0, 2.66, 1.18], jitter: 0.03 },
    { shape: 'cone', color: 'beak', radius: 0.1, height: 0.36, at: [0, 2.62, 1.44], rot: [1.45, 0, 0] },
    { shape: 'sphere', color: 'feathDark', radius: 0.045, at: [-0.1, 2.74, 1.26] },
    { shape: 'sphere', color: 'feathDark', radius: 0.045, at: [0.1, 2.74, 1.26] },
    // tail: a fan of three, not a paddle
    { shape: 'box', color: 'feathDark', size: [0.26, 0.05, 0.95], at: [0, 2.42, -1.35], count: 3, spread: [0.3, 0.02, 0.1], tilt: 0.12, jitter: 0.03 },
    // legs tucked up under the body, talons forward
    { shape: 'capsule', color: 'talon', radius: 0.06, height: 0.2, at: [-0.2, 2.26, 0.28], rot: [0.7, 0, 0] },
    { shape: 'capsule', color: 'talon', radius: 0.06, height: 0.2, at: [0.2, 2.26, 0.28], rot: [0.7, 0, 0] },
    { shape: 'cone', color: 'talon', radius: 0.05, height: 0.17, at: [-0.2, 2.14, 0.44], rot: [2.2, 0, 0] },
    { shape: 'cone', color: 'talon', radius: 0.05, height: 0.17, at: [0.2, 2.14, 0.44], rot: [2.2, 0, 0] },
    ...wing('armL', 'feather', 'feathDark'),
    ...wing('armR', 'feather', 'feathDark'),
  ],
}

const FELL = { membrane: '#4a4550', hide: '#332f3a', hideLight: '#5d5566', horn: '#c9c2ae' }

const fellBeast: GenBlueprint = {
  id: 'fell-beast',
  seed: 0x51a2,
  palette: FELL,
  parts: [
    // leaner and longer than the eagle, and it leads with a neck rather than a head
    { shape: 'sphere', color: 'hide', radius: 0.38, at: [0, 2.5, -0.2], scale: [0.95, 0.85, 2.1], jitter: 0.06 },
    { shape: 'cylinder', color: 'hide', radius: 0.16, radiusTop: 0.1, height: 1.2, at: [0, 2.66, 0.75], rot: [1.25, 0, 0], jitter: 0.04 },
    { shape: 'cone', color: 'hideLight', radius: 0.17, height: 0.62, at: [0, 2.82, 1.42], rot: [1.5, 0, 0], jitter: 0.04 },
    { shape: 'cone', color: 'horn', radius: 0.05, height: 0.28, at: [-0.08, 2.95, 1.22], rot: [-0.6, 0, 0] },
    { shape: 'cone', color: 'horn', radius: 0.05, height: 0.28, at: [0.08, 2.95, 1.22], rot: [-0.6, 0, 0] },
    // a long barbed tail, the thing that distinguishes it at a glance
    { shape: 'cylinder', color: 'hide', radius: 0.11, radiusTop: 0.03, height: 2.0, at: [0, 2.42, -1.6], rot: [1.5, 0, 0], jitter: 0.04 },
    { shape: 'cone', color: 'horn', radius: 0.08, height: 0.34, at: [0, 2.4, -2.65], rot: [-1.5, 0, 0] },
    { shape: 'capsule', color: 'hide', radius: 0.06, height: 0.24, at: [-0.18, 2.28, 0.1], rot: [0.8, 0, 0] },
    { shape: 'capsule', color: 'hide', radius: 0.06, height: 0.24, at: [0.18, 2.28, 0.1], rot: [0.8, 0, 0] },
    ...wing('armL', 'membrane', 'hide'),
    ...wing('armR', 'membrane', 'hide'),
    { shape: 'box', color: 'player', size: [0.3, 0.42, 0.3], at: [0, 2.86, -0.5] },
  ],
}

// The mounted hero: the rider's steed carrying a crested, caped figure. Built
// on the same anatomy as the rank and file so he reads as one of them, only
// grander — a hero is a very good unit, not a different species.
const marshal: GenBlueprint = {
  id: 'badger-marshal',
  seed: 0x51a3,
  palette: { ...FUR, hide: '#7a6252', hideDark: '#54443a', tusk: '#ded6c4', cape: '#3a2f4a', gold: '#d8b45a' },
  parts: [
    // the steed, a hand larger than a rider's
    { shape: 'sphere', color: 'hide', radius: 0.48, at: [0, 0.66, 0], scale: [1, 0.88, 1.55], jitter: 0.03 },
    { shape: 'sphere', color: 'hide', radius: 0.28, at: [0, 0.72, 0.78], scale: [1, 0.9, 1.1] },
    { shape: 'cone', color: 'hideDark', radius: 0.16, height: 0.32, at: [0, 0.66, 1.02], rot: [1.4, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.045, height: 0.18, at: [-0.12, 0.63, 1.08], rot: [-0.5, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.045, height: 0.18, at: [0.12, 0.63, 1.08], rot: [-0.5, 0, 0] },
    { shape: 'capsule', color: 'hideDark', radius: 0.11, height: 0.32, at: [-0.3, 0.32, 0.46], count: 2, spread: [0.6, 0, 0] },
    { shape: 'capsule', color: 'hideDark', radius: 0.11, height: 0.32, at: [-0.3, 0.32, -0.46], count: 2, spread: [0.6, 0, 0] },
    { shape: 'box', color: 'player', size: [0.94, 0.46, 0.76], at: [0, 0.64, -0.06] },
    { shape: 'box', color: 'gold', size: [0.96, 0.06, 0.2], at: [0, 0.86, -0.06] },
    // the Marshal himself
    { shape: 'capsule', color: 'fur', radius: 0.21, height: 0.24, at: [0, 1.18, -0.08] },
    { shape: 'cylinder', color: 'player', radius: 0.24, radiusTop: 0.19, height: 0.24, at: [0, 1.14, -0.08] },
    { shape: 'sphere', color: 'player', radius: 0.12, at: [-0.26, 1.3, -0.06], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'player', radius: 0.12, at: [0.26, 1.3, -0.06], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'fur', radius: 0.18, at: [0, 1.52, -0.04] },
    { shape: 'cone', color: 'fur', radius: 0.1, height: 0.18, at: [0, 1.49, 0.14], rot: [1.35, 0, 0] },
    { shape: 'sphere', color: 'snout', radius: 0.04, at: [0, 1.47, 0.23] },
    { shape: 'cone', color: 'metal', radius: 0.19, height: 0.24, at: [0, 1.66, -0.04], segments: 8 },
    { shape: 'box', color: 'gold', size: [0.05, 0.18, 0.3], at: [0, 1.8, -0.06], rot: [-0.15, 0, 0] },
    { shape: 'box', color: 'cape', size: [0.44, 0.8, 0.05], at: [0, 1.0, -0.36], rot: [0.14, 0, 0] },
    // raised sword rather than a couched lance: he leads, then fights
    { shape: 'cylinder', color: 'wood', radius: 0.03, height: 0.22, at: [0.34, 1.2, 0.1] },
    { shape: 'box', color: 'metal', size: [0.07, 0.86, 0.14], at: [0.34, 1.68, 0.06], rot: [0.2, 0, 0] },
    { shape: 'box', color: 'gold', size: [0.24, 0.06, 0.08], at: [0.34, 1.3, 0.08] },
  ],
}

// The archer hero: taller and hooded, with a longbow that visibly outreaches
// the line archer's.
const ranger: GenBlueprint = {
  id: 'badger-ranger',
  seed: 0x51a4,
  palette: { ...FUR, cloak: '#3d4a38', gold: '#d8b45a' },
  parts: [
    ...badgerCore(),
    { shape: 'box', color: 'cloak', size: [0.46, 0.8, 0.06], at: [0, 0.62, -0.28], rot: [0.12, 0, 0] },
    { shape: 'cone', color: 'cloak', radius: 0.22, height: 0.3, at: [0, 1.16, -0.02], segments: 8 },
    { shape: 'sphere', color: 'player', radius: 0.12, at: [-0.3, 0.82, 0], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'player', radius: 0.12, at: [0.3, 0.82, 0], scale: [1.1, 0.8, 1.1] },
    arm('armL'),
    // longbow, held out and drawn
    { shape: 'lathe', color: 'wood', profile: [[0.02, 0], [0.3, 0.55], [0.02, 1.1]], at: [-0.42, 0.36, 0.16], rot: [0, 1.57, 0], segments: 6, group: 'armL', pivot: [-0.26, 0.82, 0] },
    { shape: 'box', color: 'gold', size: [0.05, 0.05, 0.16], at: [-0.42, 0.9, 0.16], group: 'armL', pivot: [-0.26, 0.82, 0] },
    arm('armR'),
    { shape: 'cylinder', color: 'wood', radius: 0.016, height: 0.62, at: [0.3, 0.68, 0.3], rot: [-1.5, 0, 0], group: 'armR', pivot: [0.26, 0.82, 0] },
    // quiver
    { shape: 'cylinder', color: 'leather', radius: 0.09, height: 0.42, at: [-0.2, 0.66, -0.22], rot: [0.3, 0, 0.35] },
  ],
}

// The Horde's mounted hero: a warg, lower and longer than a badger steed, with
// a chieftain crouched over its shoulders.
const wargChief: GenBlueprint = {
  id: 'warg-chief',
  seed: 0x51a5,
  palette: { ...ORC, pelt: '#4a443c', peltDark: '#332f29', fang: '#e2dac6' },
  parts: [
    { shape: 'sphere', color: 'pelt', radius: 0.44, at: [0, 0.58, 0], scale: [0.95, 0.82, 1.7], jitter: 0.05 },
    { shape: 'sphere', color: 'pelt', radius: 0.24, at: [0, 0.6, 0.8], scale: [1, 0.9, 1.1], jitter: 0.04 },
    { shape: 'cone', color: 'peltDark', radius: 0.15, height: 0.34, at: [0, 0.54, 1.06], rot: [1.45, 0, 0] },
    { shape: 'cone', color: 'fang', radius: 0.03, height: 0.12, at: [-0.07, 0.5, 1.14], rot: [3.0, 0, 0], count: 2, spread: [0.14, 0, 0] },
    { shape: 'cone', color: 'peltDark', radius: 0.06, height: 0.18, at: [-0.15, 0.76, 0.72], rot: [0, 0, 0.5] },
    { shape: 'cone', color: 'peltDark', radius: 0.06, height: 0.18, at: [0.15, 0.76, 0.72], rot: [0, 0, -0.5] },
    { shape: 'capsule', color: 'peltDark', radius: 0.1, height: 0.26, at: [-0.28, 0.26, 0.48], count: 2, spread: [0.56, 0, 0] },
    { shape: 'capsule', color: 'peltDark', radius: 0.1, height: 0.26, at: [-0.28, 0.26, -0.48], count: 2, spread: [0.56, 0, 0] },
    { shape: 'cylinder', color: 'peltDark', radius: 0.07, radiusTop: 0.02, height: 0.7, at: [0, 0.62, -0.95], rot: [1.35, 0, 0] },
    { shape: 'box', color: 'player', size: [0.78, 0.36, 0.62], at: [0, 0.58, -0.1] },
    // the chieftain, hunched forward over the withers
    { shape: 'capsule', color: 'hide', radius: 0.2, height: 0.24, at: [0, 1.02, -0.1], rot: [0.3, 0, 0] },
    { shape: 'cylinder', color: 'player', radius: 0.22, radiusTop: 0.18, height: 0.22, at: [0, 0.98, -0.1] },
    { shape: 'sphere', color: 'hide', radius: 0.17, at: [0, 1.32, 0.02] },
    { shape: 'cone', color: 'hide', radius: 0.1, height: 0.2, at: [0, 1.28, 0.19], rot: [1.4, 0, 0] },
    { shape: 'cone', color: 'tusk', radius: 0.025, height: 0.08, at: [-0.05, 1.27, 0.24], rot: [3.1, 0, 0], count: 2, spread: [0.1, 0, 0] },
    { shape: 'cone', color: 'iron', radius: 0.2, height: 0.22, at: [0, 1.46, 0.0], segments: 6 },
    { shape: 'cone', color: 'ironDark', radius: 0.04, height: 0.26, at: [-0.16, 1.56, 0], rot: [0, 0, 0.6] },
    { shape: 'cone', color: 'ironDark', radius: 0.04, height: 0.26, at: [0.16, 1.56, 0], rot: [0, 0, -0.6] },
    // jagged cleaver held out to the side
    { shape: 'box', color: 'iron', size: [0.1, 0.66, 0.2], at: [0.34, 1.12, 0.1], rot: [0.4, 0, -0.4], jitter: 0.03 },
  ],
}

// The Horde's archer hero: a heavy crossbow rather than a longbow — one shot,
// aimed at one thing.
const marksman: GenBlueprint = {
  id: 'orc-marksman',
  seed: 0x51a6,
  palette: { ...ORC, hood: '#3a3a34' },
  parts: [
    ...orcCore(),
    { shape: 'box', color: 'hood', size: [0.42, 0.66, 0.06], at: [0, 0.5, -0.24], rot: [0.15, 0, 0] },
    { shape: 'cone', color: 'hood', radius: 0.2, height: 0.26, at: [0, 0.88, 0.06], segments: 7 },
    { shape: 'sphere', color: 'player', radius: 0.11, at: [-0.26, 0.5, 0.02], scale: [1.1, 0.8, 1.1] },
    { shape: 'sphere', color: 'player', radius: 0.11, at: [0.26, 0.5, 0.02], scale: [1.1, 0.8, 1.1] },
    orcArm('armL'),
    orcArm('armR'),
    // crossbow: a heavy stock across the body with a wide steel prod
    { shape: 'box', color: 'wood', size: [0.07, 0.07, 0.72], at: [0.1, 0.52, 0.3], group: 'armR', pivot: [0.26, 0.48, 0] },
    { shape: 'box', color: 'iron', size: [0.66, 0.05, 0.06], at: [0.1, 0.53, 0.56], group: 'armR', pivot: [0.26, 0.48, 0], jitter: 0.02 },
    { shape: 'cylinder', color: 'ironDark', radius: 0.03, height: 0.2, at: [0.1, 0.45, 0.18], rot: [0.5, 0, 0], group: 'armR', pivot: [0.26, 0.48, 0] },
    { shape: 'cylinder', color: 'rag', radius: 0.09, height: 0.4, at: [-0.2, 0.42, -0.2], rot: [0.3, 0, 0.35] },
  ],
}

export const UNIT_BLUEPRINTS: Record<string, GenBlueprint> = {
  'badger-sword': swordsman,
  'badger-spear': spearman,
  'badger-bow': archer,
  'badger-staff': priest,
  'badger-worker': worker,
  'badger-hero': hero,
  'badger-rider': rider,
  'badger-ogre': ogre,
  'orc-sword': orcSword,
  'orc-spear': orcSpear,
  'orc-bow': orcBow,
  trooper,
  'lancer-trooper': lancerTrooper,
  skiff,
  gunship,
  catapult,
  gnasher,
  eagle,
  'fell-beast': fellBeast,
  'badger-marshal': marshal,
  'badger-ranger': ranger,
  'warg-chief': wargChief,
  'orc-marksman': marksman,
}
