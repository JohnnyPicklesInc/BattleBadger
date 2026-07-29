import * as THREE from 'three'
import type { MouseCursor } from '../input/cursor.ts'

// Classic RTS camera: fixed pitch, pan (edge scroll / arrows / MMB drag),
// wheel zoom, clamped to map bounds. Reads the virtual cursor so edge
// scrolling keeps working under pointer-lock mouse capture.
export class RtsCamera {
  camera: THREE.PerspectiveCamera
  private cursor: MouseCursor
  private tx: number
  private tz: number
  private dist = 34
  private keys = new Set<string>()
  private dragging = false
  private minX: number
  private maxX: number
  private minZ: number
  private maxZ: number

  constructor(
    cursor: MouseCursor,
    aspect: number,
    cx: number,
    cz: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ) {
    this.cursor = cursor
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.5, 500)
    this.tx = cx
    this.tz = cz
    this.minX = minX
    this.maxX = maxX
    this.minZ = minZ
    this.maxZ = maxZ
    this.apply()

    window.addEventListener('keydown', (e) => this.keys.add(e.code))
    window.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
    window.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const scale = this.dist / 700
        this.tx -= e.movementX * scale
        this.tz -= e.movementY * scale
      }
    })
    window.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.dragging = true
      }
    })
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.dragging = false
    })
    window.addEventListener(
      'wheel',
      (e) => {
        this.dist = Math.min(70, Math.max(14, this.dist * (1 + Math.sign(e.deltaY) * 0.12)))
      },
      { passive: true },
    )
  }

  update(dtMs: number): void {
    const speed = (this.dist * 0.9 * dtMs) / 1000
    const edge = 12
    // Arrow keys + edge scroll + MMB drag. (WASD is reserved for hotkeys.)
    let dx = 0
    let dz = 0
    if (this.keys.has('ArrowUp')) dz -= 1
    if (this.keys.has('ArrowDown')) dz += 1
    if (this.keys.has('ArrowLeft')) dx -= 1
    if (this.keys.has('ArrowRight')) dx += 1
    if (this.cursor.active) {
      const w = window.innerWidth
      const h = window.innerHeight
      if (this.cursor.x < edge) dx -= 1
      else if (this.cursor.x > w - edge) dx += 1
      if (this.cursor.y < edge) dz -= 1
      else if (this.cursor.y > h - edge) dz += 1
    }
    this.tx = Math.min(this.maxX, Math.max(this.minX, this.tx + dx * speed))
    this.tz = Math.min(this.maxZ, Math.max(this.minZ, this.tz + dz * speed))
    this.apply()
  }

  private apply(): void {
    // pitch ~56°: offset back along +Z, up along +Y
    this.camera.position.set(this.tx, this.dist * 0.87, this.tz + this.dist * 0.5)
    this.camera.lookAt(this.tx, 0, this.tz)
    this.camera.updateMatrixWorld()
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }

  // Jump the view to a world point (minimap click / portrait click).
  moveTo(x: number, z: number): void {
    this.tx = Math.min(this.maxX, Math.max(this.minX, x))
    this.tz = Math.min(this.maxZ, Math.max(this.minZ, z))
    this.apply()
  }

  get targetX(): number {
    return this.tx
  }

  get targetZ(): number {
    return this.tz
  }
}
