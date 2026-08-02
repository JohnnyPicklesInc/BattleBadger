import { deriveTerrain, mapSlotCount, type RtsMapDoc } from '@battlebadger/sim'

// Player slot colours — shared by the lobby list, the map preview markers and
// anything else that has to agree about "who is blue".
export const SLOT_COLORS = ['#4aa3ff', '#ff5a4a', '#59d98c', '#c678dd', '#ffc46b', '#6be1e8', '#f567b8', '#bfd35c']

// Terrain painted one pixel per cell. Same shading as the in-game minimap, so
// the lobby preview and the minimap you play with read as the same map.
export function terrainImage(doc: RtsMapDoc): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = doc.cols
  c.height = doc.rows
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(doc.cols, doc.rows)
  const { walkable, heights } = deriveTerrain(doc)
  for (let i = 0; i < doc.cols * doc.rows; i++) {
    const walk = walkable[i] === 1
    const t = Math.min(1, Math.max(0, heights[i] / 4))
    const [r, g, b] = walk ? [40 + t * 40, 84 + t * 40, 36 + t * 22] : [92 + t * 26, 82 + t * 22, 72 + t * 18]
    img.data[i * 4] = r
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export interface PreviewOptions {
  // Lobby occupancy by slot: a name, or null for an open slot. Occupied starts
  // are drawn solid, open ones hollow — the WC3 read of "who is where".
  players?: (string | null)[]
  mySlot?: number
  // Which start position each slot plays (starts[slot] = position). Absent =
  // the map's own order, slot N on start N.
  starts?: number[]
}

// Where the map sits inside the canvas, in CSS pixels. Shared by the drawing
// and the click hit-test so a marker is picked exactly where it is painted.
function layout(canvas: HTMLCanvasElement, doc: RtsMapDoc): {
  ox: number
  oy: number
  w: number
  h: number
  cssW: number
  cssH: number
} {
  const cssW = canvas.clientWidth || Number(canvas.dataset.w ?? 260)
  const cssH = canvas.clientHeight || Number(canvas.dataset.h ?? 260)
  const scale = Math.min(cssW / doc.cols, cssH / doc.rows)
  const w = doc.cols * scale
  const h = doc.rows * scale
  return { ox: (cssW - w) / 2, oy: (cssH - h) / 2, w, h, cssW, cssH }
}

/**
 * The start position under a click, or -1. Coordinates are relative to the
 * canvas (clientX - rect.left), so the lobby can let a player pick their base
 * off the map shot instead of a dropdown.
 */
export function startLocationAt(canvas: HTMLCanvasElement, doc: RtsMapDoc, x: number, y: number): number {
  const { ox, oy, w, h } = layout(canvas, doc)
  const slots = mapSlotCount(doc)
  const r = Math.max(9, Math.min(14, (w / doc.cols) * 7))
  let best = -1
  let bestD = r * r
  for (let i = 0; i < slots; i++) {
    const s = doc.startLocations[i]
    if (!s) continue
    const dx = x - (ox + ((s.x - doc.originX) / (doc.cols * doc.cellSize)) * w)
    const dy = y - (oy + ((s.z - doc.originZ) / (doc.rows * doc.cellSize)) * h)
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

// Draws the map into a canvas sized in CSS pixels: terrain, scenery, pre-placed
// content and the numbered start locations. Aspect ratio is preserved and the
// leftover space is letterboxed, so a wide map is not stretched square.
export function drawMapPreview(canvas: HTMLCanvasElement, doc: RtsMapDoc, opts: PreviewOptions = {}): void {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
  const { ox, oy, w, h, cssW, cssH } = layout(canvas, doc)
  const scale = w / doc.cols
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(terrainImage(doc), ox, oy, w, h)
  ctx.imageSmoothingEnabled = true

  // world → preview pixel
  const px = (x: number): number => ox + ((x - doc.originX) / (doc.cols * doc.cellSize)) * w
  const py = (z: number): number => oy + ((z - doc.originZ) / (doc.rows * doc.cellSize)) * h

  const slots = mapSlotCount(doc)
  // The doc is authored per POSITION; the lobby shows it per PLAYER. With
  // start-position picks in play those differ, so everything owner-coloured
  // here is drawn in the colour of whoever is standing there.
  const playerAt = Array.from({ length: slots }, (_, p) => opts.starts?.indexOf(p) ?? p)
  const slotOf = (pos: number): number => (pos < slots && playerAt[pos] >= 0 ? playerAt[pos] : pos)

  ctx.fillStyle = 'rgba(125, 133, 144, 0.8)'
  for (const d of doc.doodads ?? []) ctx.fillRect(px(d.x) - 1, py(d.z) - 1, 2, 2)

  for (const p of doc.placed ?? []) {
    ctx.fillStyle = SLOT_COLORS[slotOf(p.owner) % SLOT_COLORS.length]
    ctx.globalAlpha = 0.75
    ctx.fillRect(px(p.x) - 1.5, py(p.z) - 1.5, 3, 3)
    ctx.globalAlpha = 1
  }

  const r = Math.max(7, Math.min(11, scale * 6))
  ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let pos = 0; pos < slots; pos++) {
    const s = doc.startLocations[pos]
    if (!s) continue
    const slot = slotOf(pos)
    const taken = opts.players ? Boolean(opts.players[slot]) : false
    const color = SLOT_COLORS[slot % SLOT_COLORS.length]
    const x = px(s.x)
    const y = py(s.z)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = taken ? color : 'rgba(10, 14, 20, 0.55)'
    ctx.fill()
    ctx.lineWidth = opts.mySlot === slot ? 3 : 2
    ctx.strokeStyle = opts.mySlot === slot ? '#ffffff' : color
    ctx.stroke()
    ctx.fillStyle = taken ? '#0b0f16' : color
    ctx.fillText(String(slot + 1), x, y + 0.5)
  }

  // frame: makes the letterboxed area read as "this is the map", not a gap
  ctx.strokeStyle = '#2a3342'
  ctx.lineWidth = 1
  ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1)
}
