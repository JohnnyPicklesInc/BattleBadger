import type { GenBlueprint } from './blueprint.ts'

// Built-in doodad blueprints, keyed by the id in a def's 'gen:<id>' model.
// Authored in world units with y=0 at the ground; visual.scale still applies
// on top. Recolors are new palettes, reshapes are new part lists — no code.

const oak: GenBlueprint = {
  id: 'oak',
  seed: 0xa11ce,
  palette: { bark: '#6b4a2f', leaf: '#3f7d3a', leafLight: '#4f9448' },
  parts: [
    { shape: 'cylinder', color: 'bark', radius: 0.16, radiusTop: 0.11, height: 1.0, at: [0, 0.5, 0], jitter: 0.02 },
    { shape: 'sphere', color: 'leaf', radius: 0.62, at: [0, 1.5, 0], jitter: 0.09, count: 3, spread: [0.32, 0.14, 0.32], sizeJitter: 0.25 },
    { shape: 'sphere', color: 'leafLight', radius: 0.4, at: [0.1, 1.85, 0.05], jitter: 0.08 },
  ],
}

const pine: GenBlueprint = {
  id: 'pine',
  seed: 0xb0071,
  palette: { bark: '#5d4229', needle: '#2e5d33', needleDark: '#255029' },
  parts: [
    { shape: 'cylinder', color: 'bark', radius: 0.13, radiusTop: 0.09, height: 0.8, at: [0, 0.4, 0], jitter: 0.015 },
    { shape: 'cone', color: 'needleDark', radius: 0.78, height: 1.0, at: [0, 1.15, 0], jitter: 0.05 },
    { shape: 'cone', color: 'needle', radius: 0.58, height: 0.9, at: [0, 1.8, 0], jitter: 0.05 },
    { shape: 'cone', color: 'needle', radius: 0.36, height: 0.75, at: [0, 2.4, 0], jitter: 0.04 },
  ],
}

// Cerebrate-war ambience: an oak silhouette in a bruised, unhealthy palette.
const gloomtree: GenBlueprint = {
  id: 'gloomtree',
  seed: 0x610011,
  palette: { bark: '#41344c', leaf: '#39434f', leafLight: '#46545c' },
  parts: [
    { shape: 'cylinder', color: 'bark', radius: 0.17, radiusTop: 0.1, height: 1.15, at: [0, 0.58, 0], rot: [0, 0, 0.08], jitter: 0.03 },
    { shape: 'sphere', color: 'leaf', radius: 0.58, at: [0, 1.65, 0], jitter: 0.12, count: 3, spread: [0.34, 0.18, 0.34], sizeJitter: 0.3 },
    { shape: 'sphere', color: 'leafLight', radius: 0.34, at: [-0.12, 2.0, 0.08], jitter: 0.1 },
  ],
}

const boulder: GenBlueprint = {
  id: 'boulder',
  seed: 0xb0111d,
  palette: { rock: '#8a8f96', rockDark: '#6f747c', moss: '#5c6e46' },
  parts: [
    { shape: 'sphere', color: 'rock', radius: 0.62, at: [0, 0.3, 0], scale: [1.15, 0.72, 1], jitter: 0.13, count: 3, spread: [0.42, 0.08, 0.42], sizeJitter: 0.35 },
    { shape: 'sphere', color: 'rockDark', radius: 0.4, at: [0.35, 0.2, -0.3], scale: [1, 0.7, 1.1], jitter: 0.11 },
    { shape: 'sphere', color: 'moss', radius: 0.3, at: [-0.25, 0.52, 0.2], scale: [1.2, 0.45, 1.2], jitter: 0.09 },
  ],
}

const crystal: GenBlueprint = {
  id: 'crystal',
  seed: 0xc757a1,
  palette: { rock: '#6f747c', gem: '#64d8e8', gemBright: '#a8ecf4' },
  parts: [
    { shape: 'sphere', color: 'rock', radius: 0.55, at: [0, 0.12, 0], scale: [1.2, 0.4, 1.2], jitter: 0.1 },
    { shape: 'cone', color: 'gem', radius: 0.2, height: 1.35, segments: 5, at: [0, 0.75, 0], count: 5, spread: [0.34, 0.12, 0.34], tilt: 0.38, sizeJitter: 0.35 },
    { shape: 'cone', color: 'gemBright', radius: 0.11, height: 0.8, segments: 5, at: [0.05, 0.5, 0.1], rot: [0, 0, 0.25] },
  ],
}

// Half-buried sandstone dome with a dark adit and surface gold.
const mine: GenBlueprint = {
  id: 'mine',
  seed: 0x901d,
  palette: { sand: '#c9a54a', sandDark: '#a9873c', dark: '#3a3126', gold: '#ffd75e' },
  parts: [
    { shape: 'sphere', color: 'sand', radius: 1.25, at: [0, 0.1, 0], scale: [1, 0.62, 1], segments: 10, jitter: 0.06 },
    { shape: 'sphere', color: 'sandDark', radius: 0.5, at: [-0.7, 0.25, 0.55], scale: [1, 0.6, 1], jitter: 0.08 },
    { shape: 'box', color: 'dark', size: [0.72, 0.6, 0.5], at: [0, 0.28, 1.02], rot: [0, 0, 0] },
    { shape: 'sphere', color: 'gold', radius: 0.14, at: [0, 0.75, 0.35], count: 4, spread: [0.5, 0.18, 0.4], sizeJitter: 0.4 },
  ],
}

export const DOODAD_BLUEPRINTS: Record<string, GenBlueprint> = {
  oak, pine, gloomtree, boulder, crystal, mine,
}
