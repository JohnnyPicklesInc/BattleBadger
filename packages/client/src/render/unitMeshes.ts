import * as THREE from 'three'

export const PLAYER_COLORS = [
  new THREE.Color(0x4aa3ff), // blue
  new THREE.Color(0xff5a4a), // red
  new THREE.Color(0x59d98c), // teal-green
  new THREE.Color(0xc678dd), // purple
  new THREE.Color(0xffc46b), // orange
  new THREE.Color(0x6be1e8), // cyan
  new THREE.Color(0xf567b8), // pink
  new THREE.Color(0xbfd35c), // olive
]

// Shades within one team's colour, applied to its members in slot order. The
// first member wears the team colour itself; the rest are lightened or
// darkened off it and turned a few degrees, which is enough to tell four
// allies apart while never being mistaken for the other side.
const TEAM_SHADES: { hue: number; light: number; sat: number }[] = [
  { hue: 0, light: 0, sat: 0 },
  { hue: -0.035, light: 0.16, sat: -0.12 },
  { hue: 0.04, light: -0.14, sat: 0.05 },
  { hue: -0.075, light: 0.3, sat: -0.25 },
]

/**
 * Owner colours by TEAM rather than by slot: a war between two alliances has
 * to read as two colours from across the map, not as eight strangers. Each
 * team takes one entry from PLAYER_COLORS (in team-id order) and its members
 * wear shades of it.
 *
 * In a free-for-all every player is their own team, so this is exactly
 * PLAYER_COLORS again — the palette only bends when there are sides.
 */
export function teamOwnerColors(playerTeam: ArrayLike<number>, slots = 8): THREE.Color[] {
  const teams = [...new Set(Array.from({ length: slots }, (_, i) => playerTeam[i]))].sort((a, b) => a - b)
  const hsl = { h: 0, s: 0, l: 0 }
  return Array.from({ length: slots }, (_, slot) => {
    const team = playerTeam[slot]
    const base = PLAYER_COLORS[teams.indexOf(team) % PLAYER_COLORS.length]
    // Rank within the team, by slot — the same on every client, so two players
    // never describe the same army by different colours.
    let rank = 0
    for (let i = 0; i < slot; i++) if (playerTeam[i] === team) rank++
    const shade = TEAM_SHADES[rank % TEAM_SHADES.length]
    if (rank === 0) return base.clone()
    base.getHSL(hsl)
    return new THREE.Color().setHSL(
      (hsl.h + shade.hue + 1) % 1,
      Math.max(0.2, Math.min(1, hsl.s + shade.sat)),
      Math.max(0.2, Math.min(0.86, hsl.l + shade.light)),
    )
  })
}

// Placeholder geometry library, keyed by EntityDef.visual.model.
// 'asset:<id>' models resolve elsewhere (custom glTF); unknown ids fall back
// to a box so a bad def can never break rendering.
export function modelGeometry(model: string, radius: number, scale = 1): THREE.BufferGeometry {
  const r = radius * scale
  switch (model) {
    case 'placeholder:capsule': {
      const g = new THREE.CapsuleGeometry(r * 0.8, 0.7 * scale, 4, 10)
      g.translate(0, r * 0.8 + 0.35 * scale, 0)
      return g
    }
    case 'placeholder:cone': {
      const g = new THREE.ConeGeometry(r * 0.85, 1.5 * scale, 8)
      g.translate(0, 0.75 * scale, 0)
      return g
    }
    case 'placeholder:lathe': {
      const profile = [
        new THREE.Vector2(0.42, 0),
        new THREE.Vector2(0.36, 0.55),
        new THREE.Vector2(0.28, 0.95),
        new THREE.Vector2(0.12, 1.02),
        new THREE.Vector2(0.2, 1.12),
        new THREE.Vector2(0.2, 1.3),
        new THREE.Vector2(0.1, 1.42),
        new THREE.Vector2(0, 1.45),
      ]
      const g = new THREE.LatheGeometry(profile, 10)
      g.scale(scale, scale, scale)
      return g
    }
    case 'placeholder:tree': {
      const g = new THREE.ConeGeometry(r * 1.4, 2.6 * scale, 7)
      g.translate(0, 1.3 * scale, 0)
      return g
    }
    case 'placeholder:crystal': {
      const g = new THREE.OctahedronGeometry(r * 1.1)
      g.translate(0, r * 1.0, 0)
      g.scale(1, 1.5, 1)
      return g
    }
    case 'placeholder:dome': {
      const g = new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
      return g
    }
    case 'placeholder:box':
    default: {
      const g = new THREE.BoxGeometry(r * 1.6, Math.max(1, r) * scale, r * 1.6)
      g.translate(0, (Math.max(1, r) * scale) / 2, 0)
      return g
    }
  }
}
