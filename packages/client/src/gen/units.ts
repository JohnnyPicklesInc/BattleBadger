import type { GenBlueprint, GenPart } from './blueprint.ts'

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

export const UNIT_BLUEPRINTS: Record<string, GenBlueprint> = {
  'badger-sword': swordsman,
  'badger-spear': spearman,
  'badger-bow': archer,
  'badger-staff': priest,
  'badger-worker': worker,
  'badger-hero': hero,
  'badger-rider': rider,
  'badger-ogre': ogre,
  catapult,
  gnasher,
}
