import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  MAX_UNITS,
  type AbilityDef,
  type FogState,
  type GameDefCompiled,
  type RtsMapDoc,
  type SimState,
  type WalkGrid,
} from '@battlebadger/sim'
import { RtsCamera } from './camera.ts'
import { BattleAudio } from './audio.ts'
import type { MouseCursor } from '../input/cursor.ts'
import { PLAYER_COLORS, modelGeometry } from './unitMeshes.ts'
import { buildTerrainMesh, shadeTerrainFog } from './terrainMesh.ts'
import { resolveModel } from './assets.ts'
import { genGroups } from '../gen/build.ts'
import type { GenGroupRole } from '../gen/blueprint.ts'

// One drawable piece of a unit type: gen: units get a mesh per animation
// group (body, arms hinged at `pivot`); everything else is a single 'body'.
interface UnitPart {
  im: THREE.InstancedMesh
  role: GenGroupRole
  pivot: [number, number, number]
}

const RING_OWN = new THREE.Color(0x7ee787)
const RING_ALLY = new THREE.Color(0xffe27a)
const RING_ENEMY = new THREE.Color(0xff6a5a)
const MAX_RENDER_PLAYERS = 8
// Half-width of the sun's shadow box, in world units. Big enough to cover the
// visible ground at normal zoom with room for tall things just off-screen.
const SHADOW_HALF = 70
// How high a flyer rides above the ground it is over.
const FLY_HEIGHT = 4.2
// Arrows live about a fifth of a second each, so this is a ceiling on how many
// can be in the air at once, not on how many may be fired.
const MAX_ARROWS = 512
const ARROW_LIFE_MS = 200
const BLAST_COLOR = new THREE.Color(0xffa33a) // burning shell
const DUST_COLOR = new THREE.Color(0xd8cfc0) // hooves

// Bodies thrown by a charge or a shell. Purely cosmetic: the sim has already
// killed and removed these units, so nothing here can affect the match. The
// launch is inferred by correlating this tick's 'died' events against its
// 'trample'/'impact' events, which means no sim change was needed at all.
const MAX_CORPSES = 48
const CORPSE_LIFE = 2.4 // seconds before it is recycled
const CORPSE_SINK_AT = 1.9 // starts sinking through the ground here
const CORPSE_GRAVITY = 20

interface Corpse {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  spinX: number
  spinZ: number
  age: number
  ground: number
}

/**
 * Screen-space HP bars, drawn as pooled DOM elements.
 *
 * These are the one part of the frame that scales with the size of the battle
 * AND touches the DOM, so it is written to do as little as possible: every
 * style is cached and only rewritten when it actually changes, off-screen
 * units are dropped before they cost anything, and the total is capped. In a
 * four-way brawl the naive version wrote six inline styles per damaged unit
 * per frame — thousands of style mutations a second, most of them setting a
 * value to what it already was.
 */
const MAX_HP_BARS = 120

interface BarEntry {
  root: HTMLDivElement
  fill: HTMLDivElement
  left: number
  top: number
  pct: number
  friendly: boolean
  shown: boolean
}

class HealthBars {
  private pool: BarEntry[] = []
  private used = 0

  private acquire(): BarEntry {
    if (this.used < this.pool.length) return this.pool[this.used++]
    const root = document.createElement('div')
    root.className = 'hpbar'
    const fill = document.createElement('i') as unknown as HTMLDivElement
    root.appendChild(fill)
    document.body.appendChild(root)
    const entry: BarEntry = {
      root,
      fill,
      left: NaN,
      top: NaN,
      pct: -1,
      friendly: false,
      shown: false,
    }
    this.pool.push(entry)
    this.used++
    return entry
  }

  begin(): void {
    this.used = 0
  }

  get full(): boolean {
    return this.used >= MAX_HP_BARS
  }

  show(x: number, y: number, frac: number, friendly: boolean): void {
    if (this.used >= MAX_HP_BARS) return
    const e = this.acquire()
    // Round to whole pixels: sub-pixel jitter would otherwise dirty the style
    // on every frame a unit moves even slightly.
    const left = Math.round(x - 13)
    const top = Math.round(y)
    if (!e.shown) {
      e.root.style.display = 'block'
      e.shown = true
    }
    if (left !== e.left) {
      e.left = left
      e.root.style.left = `${left}px`
    }
    if (top !== e.top) {
      e.top = top
      e.root.style.top = `${top}px`
    }
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100)
    if (pct !== e.pct) {
      e.pct = pct
      e.fill.style.width = `${pct}%`
    }
    if (friendly !== e.friendly) {
      e.friendly = friendly
      e.fill.style.background = friendly ? '#62d26f' : '#e0564a'
    }
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      const e = this.pool[i]
      if (!e.shown) continue // already hidden: do not touch the DOM again
      e.root.style.display = 'none'
      e.shown = false
    }
  }
}

export class GameRenderer {
  readonly scene = new THREE.Scene()
  readonly cam: RtsCamera
  readonly audio = new BattleAudio()
  private renderer: THREE.WebGLRenderer
  private units: UnitPart[][][] = [] // [owner][type][part]
  private rings: THREE.InstancedMesh
  // Arrows in flight. Render-only: the sim resolved the hit the instant the
  // bow was loosed, so these are a picture of a shot that has already landed.
  // They cannot miss, cannot be dodged, and cannot change who died.
  private arrows: THREE.InstancedMesh
  private arrowFx: {
    x0: number; y0: number; z0: number
    x1: number; y1: number; z1: number
    age: number
  }[] = []
  // Last attack tick we drew an arrow for, per entity — the render loop runs
  // at frame rate, so without this a single volley would spawn a dozen.
  private lastShotDrawn = new Int32Array(MAX_UNITS).fill(-1)
  private healBeams: THREE.LineSegments
  private healBeamPositions: Float32Array
  private marker: THREE.Mesh
  private markerAge = 1
  private doodadMeshes = new Map<number, THREE.InstancedMesh>()
  private carryMesh: THREE.InstancedMesh
  private ghost: THREE.Mesh | null = null
  private ghostDef = -1
  private abIndicator: THREE.Mesh | null = null
  private abIndicatorKey = ''
  private fogShadedRev = -1
  private shells: THREE.InstancedMesh
  private blasts: THREE.InstancedMesh
  // live impact flashes: world position, radius and age in seconds
  private blastFx: { x: number; z: number; r: number; age: number; dust: boolean }[] = []
  private corpses: Corpse[] = []
  private lastFxTick = -1
  private hpbars = new HealthBars()
  private terrain: THREE.Mesh
  private sun: THREE.DirectionalLight
  private sunShadowAt = { x: NaN, z: NaN }
  private grid: WalkGrid
  private mySlot: number
  private m4 = new THREE.Matrix4()
  private m4b = new THREE.Matrix4()
  private m4c = new THREE.Matrix4()
  private m4d = new THREE.Matrix4()
  private animTime = 0 // seconds of wall clock, drives render-only unit motion
  private doorOpen = new Float32Array(4096) // per entity, eased gate door angle
  private v3 = new THREE.Vector3()

  private def: GameDefCompiled
  private assets: Map<string, THREE.BufferGeometry>

  constructor(
    container: HTMLElement,
    doc: RtsMapDoc,
    grid: WalkGrid,
    mySlot: number,
    cursor: MouseCursor,
    def: GameDefCompiled,
    assets: Map<string, THREE.BufferGeometry> = new Map(),
    ownerColors: THREE.Color[] = PLAYER_COLORS,
  ) {
    this.grid = grid
    this.mySlot = mySlot
    this.def = def
    this.assets = assets
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(0x0c0f14)
    this.scene.fog = new THREE.Fog(0x0c0f14, 90, 220)

    const hemi = new THREE.HemisphereLight(0xbcd2ff, 0x3a4a30, 0.9)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2d9, 1.6)
    sun.position.set(40, 60, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    // The shadow frustum follows the view instead of covering the whole map.
    // Spanning a 176-unit map meant every unit on it was rendered into the
    // shadow pass every frame, however far off-screen — and it spread a 2048²
    // map over the entire board, so shadows were coarse as well as expensive.
    // A tight box around what the player is looking at is both cheaper and
    // sharper; it scales with the camera, not the map.
    sun.shadow.camera.left = -SHADOW_HALF
    sun.shadow.camera.right = SHADOW_HALF
    sun.shadow.camera.top = SHADOW_HALF
    sun.shadow.camera.bottom = -SHADOW_HALF
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 260
    sun.target.position.set(doc.cols * 0.5, 0, doc.rows * 0.5)
    this.sun = sun
    this.scene.add(sun)
    this.scene.add(sun.target)

    this.terrain = buildTerrainMesh(doc)
    this.scene.add(this.terrain)

    // unit instances per (owner, type); gen: models split into animation groups
    for (let owner = 0; owner < MAX_RENDER_PLAYERS; owner++) {
      this.units[owner] = []
      for (let ty = 0; ty < def.entities.length; ty++) {
        const e = def.entities[ty]
        const parts: UnitPart[] = []
        if (e.visual.model.startsWith('gen:')) {
          const groups = genGroups(
            e.visual.model.slice(4),
            e.visual.tint === 'none' ? null : ownerColors[owner],
            e.visual.scale ?? 1,
          )
          if (groups) {
            for (const g of groups) {
              const im = new THREE.InstancedMesh(
                g.geometry,
                new THREE.MeshLambertMaterial({ vertexColors: true }),
                256,
              )
              parts.push({ im, role: g.role, pivot: g.pivot })
            }
          }
        }
        if (parts.length === 0) {
          const geo = resolveModel(e.visual.model, e.radius, e.visual.scale ?? 1, assets, modelGeometry)
          const mat = new THREE.MeshLambertMaterial({
            color: e.visual.tint === 'none' ? new THREE.Color(0x9aa4ae) : ownerColors[owner],
          })
          parts.push({ im: new THREE.InstancedMesh(geo, mat, 256), role: 'body', pivot: [0, 0, 0] })
        }
        for (const p of parts) {
          p.im.castShadow = true
          p.im.count = 0
          p.im.frustumCulled = false
          this.scene.add(p.im)
        }
        this.units[owner][ty] = parts
      }
    }

    // doodad instances per doodad-kind def
    const doodadCap = Math.max(4, doc.doodads?.length ?? 0)
    const doodadColor = (model: string): number => {
      if (model.includes('tree')) return 0x3f7d3a
      if (model.includes('crystal')) return 0x64d8e8
      if (model.includes('dome')) return 0xc9a54a
      return 0x8a8f96
    }
    def.entities.forEach((e, idx) => {
      if (e.kind !== 'doodad') return
      // gen: models carry their palette as vertex colors; others get a flat tint
      const mat = e.visual.model.startsWith('gen:')
        ? new THREE.MeshLambertMaterial({ vertexColors: true })
        : new THREE.MeshLambertMaterial({ color: doodadColor(e.visual.model) })
      const im = new THREE.InstancedMesh(
        resolveModel(e.visual.model, e.radius, e.visual.scale ?? 1, assets, modelGeometry),
        mat,
        doodadCap,
      )
      im.castShadow = true
      im.count = 0
      im.frustumCulled = false
      this.scene.add(im)
      this.doodadMeshes.set(idx, im)
    })

    // carry indicator: small gold cube above harvesters with a full/partial load
    const carryGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28)
    this.carryMesh = new THREE.InstancedMesh(
      carryGeo,
      new THREE.MeshLambertMaterial({ color: 0xffd75e }),
      256,
    )
    this.carryMesh.count = 0
    this.carryMesh.frustumCulled = false
    this.scene.add(this.carryMesh)

    // burning boulders in flight — emissive so they read against dark terrain
    const shellGeo = new THREE.IcosahedronGeometry(0.34, 0)
    this.shells = new THREE.InstancedMesh(
      shellGeo,
      new THREE.MeshBasicMaterial({ color: 0xff7a2a }),
      256,
    )
    this.shells.count = 0
    this.shells.frustumCulled = false
    this.scene.add(this.shells)

    // impact flashes: flat rings that expand to the blast radius and fade
    const blastGeo = new THREE.RingGeometry(0.55, 1, 28)
    blastGeo.rotateX(-Math.PI / 2)
    this.blasts = new THREE.InstancedMesh(
      blastGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: false, transparent: true, opacity: 0.85, depthWrite: false }),
      64,
    )
    this.blasts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3)
    this.blasts.count = 0
    this.blasts.frustumCulled = false
    this.scene.add(this.blasts)

    // Corpse pool. Geometry and material are swapped in from the dying unit's
    // own instanced mesh at fling time, so a thrown body looks like what died.
    for (let k = 0; k < MAX_CORPSES; k++) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial())
      m.visible = false
      m.castShadow = true
      m.frustumCulled = false
      this.scene.add(m)
      this.corpses.push({ mesh: m, vx: 0, vy: 0, vz: 0, spinX: 0, spinZ: 0, age: CORPSE_LIFE, ground: 0 })
    }

    const ringGeo = new THREE.RingGeometry(0.55, 0.72, 24)
    ringGeo.rotateX(-Math.PI / 2)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    this.rings = new THREE.InstancedMesh(ringGeo, ringMat, 256)
    this.rings.count = 0
    this.rings.frustumCulled = false
    this.scene.add(this.rings)

    // A shaft and a head, modelled pointing along +Z so the flight basis
    // orients it the same way a unit's facing does.
    const shaft = new THREE.CylinderGeometry(0.035, 0.035, 1.0, 5)
    shaft.rotateX(Math.PI / 2)
    const head = new THREE.ConeGeometry(0.08, 0.26, 5)
    head.rotateX(Math.PI / 2)
    head.translate(0, 0, 0.6)
    const fletch = new THREE.BoxGeometry(0.02, 0.16, 0.22)
    fletch.translate(0, 0, -0.42)
    const arrowGeo = mergeGeometries([shaft, head, fletch], false)!
    this.arrows = new THREE.InstancedMesh(
      arrowGeo,
      new THREE.MeshBasicMaterial({ color: 0xe8d9a8 }),
      MAX_ARROWS,
    )
    this.arrows.count = 0
    this.arrows.frustumCulled = false
    this.scene.add(this.arrows)

    this.healBeamPositions = new Float32Array(MAX_UNITS * 6)
    const healGeo = new THREE.BufferGeometry()
    healGeo.setAttribute('position', new THREE.BufferAttribute(this.healBeamPositions, 3))
    this.healBeams = new THREE.LineSegments(
      healGeo,
      new THREE.LineBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0.9 }),
    )
    this.healBeams.frustumCulled = false
    this.scene.add(this.healBeams)

    const markerGeo = new THREE.RingGeometry(0.3, 0.5, 24)
    markerGeo.rotateX(-Math.PI / 2)
    this.marker = new THREE.Mesh(
      markerGeo,
      new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0 }),
    )
    this.scene.add(this.marker)

    const cx = doc.originX + doc.cols * doc.cellSize * 0.5
    const cz = doc.originZ + doc.rows * doc.cellSize * 0.5
    const start = doc.startLocations[Math.min(mySlot, doc.startLocations.length - 1)]
    this.cam = new RtsCamera(
      cursor,
      window.innerWidth / window.innerHeight,
      start ? start.x : cx,
      (start ? start.z : cz) + 6,
      doc.originX + 6,
      doc.originX + doc.cols * doc.cellSize - 6,
      doc.originZ + 6,
      doc.originZ + doc.rows * doc.cellSize - 6,
    )

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight)
      this.cam.resize(window.innerWidth / window.innerHeight)
    })
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  get terrainMesh(): THREE.Mesh {
    return this.terrain
  }

  get camera(): THREE.PerspectiveCamera {
    return this.cam.camera
  }

  groundHeight(x: number, z: number): number {
    return this.grid.heightAtWorld(x, z)
  }

  // Build-placement ghost: follows the cursor, green when valid.
  showGhost(defIdx: number, x: number, z: number, valid: boolean): void {
    if (this.ghostDef !== defIdx) {
      this.hideGhost()
      const e = this.def.entities[defIdx]
      this.ghost = new THREE.Mesh(
        resolveModel(e.visual.model, e.radius, e.visual.scale ?? 1, this.assets, modelGeometry),
        new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.55 }),
      )
      this.ghostDef = defIdx
      this.scene.add(this.ghost)
    }
    const mat = this.ghost!.material as THREE.MeshLambertMaterial
    mat.color.set(valid ? 0x5fdc74 : 0xe0564a)
    this.ghost!.position.set(x, this.grid.heightAtWorld(x, z), z)
  }

  hideGhost(): void {
    if (this.ghost) {
      this.scene.remove(this.ghost)
      this.ghost = null
      this.ghostDef = -1
    }
  }

  /**
   * Throw a body. Borrows the geometry and material of whatever just died so
   * the corpse reads as that unit, then gives it a ballistic arc and a tumble.
   * Silently does nothing when the pool is exhausted — a dropped corpse is a
   * missing flourish, never a missing death.
   */
  private fling(
    owner: number,
    ty: number,
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    power: number,
    seed: number,
  ): void {
    const parts = this.units[owner]?.[ty]
    if (!parts || parts.length === 0) return
    let slot: Corpse | null = null
    for (const c of this.corpses) {
      if (c.age >= CORPSE_LIFE) {
        slot = c
        break
      }
    }
    if (!slot) return
    // the torso, not whichever animation group happens to be first
    const body = (parts.find((pt) => pt.role === 'body') ?? parts[0]).im
    slot.mesh.geometry = body.geometry
    slot.mesh.material = body.material as THREE.Material
    const ground = this.grid.heightAtWorld(x, z)
    slot.ground = ground
    slot.mesh.position.set(x, ground + 0.4, z)
    slot.mesh.rotation.set(0, 0, 0)
    slot.mesh.visible = true
    // Vary the throw per victim so a wiped rank does not fly in lockstep.
    // Cosmetic only, so a cheap integer hash beats touching the sim's RNG.
    const h = (Math.imul(seed | 0, 0x9e3779b1) >>> 8) / 0xffffff
    const h2 = (Math.imul(seed | 0, 0x85ebca6b) >>> 8) / 0xffffff
    const spread = (h - 0.5) * 0.5
    slot.vx = (dirX + spread) * power
    slot.vz = (dirZ - spread) * power
    slot.vy = 5.5 + h2 * 4
    slot.spinX = (h - 0.5) * 14
    slot.spinZ = (h2 - 0.5) * 14
    slot.age = 0
  }

  /** Advance thrown bodies: arc, tumble, then sink out of sight. */
  private updateCorpses(dtMs: number): void {
    const dt = dtMs / 1000
    for (const c of this.corpses) {
      if (c.age >= CORPSE_LIFE) continue
      c.age += dt
      if (c.age >= CORPSE_LIFE) {
        c.mesh.visible = false
        continue
      }
      const p = c.mesh.position
      if (p.y > c.ground) {
        c.vy -= CORPSE_GRAVITY * dt
        p.x += c.vx * dt
        p.y += c.vy * dt
        p.z += c.vz * dt
        c.mesh.rotation.x += c.spinX * dt
        c.mesh.rotation.z += c.spinZ * dt
        if (p.y <= c.ground) {
          // landed: stop dead and lie over rather than bouncing
          p.y = c.ground
          c.vx = 0
          c.vy = 0
          c.vz = 0
          c.mesh.rotation.x = Math.PI / 2
        }
      } else if (c.age > CORPSE_SINK_AT) {
        // no per-corpse fade available (the material is shared with the live
        // instanced mesh), so sink it through the ground instead
        p.y = c.ground - ((c.age - CORPSE_SINK_AT) / (CORPSE_LIFE - CORPSE_SINK_AT)) * 1.4
      }
    }
  }

  /**
   * Turn this tick's events into thrown bodies. A death is treated as violent
   * when it happened next to a blast or a hoof-fall in the same tick, which is
   * why no extra sim state was needed to carry "how did this one die".
   */
  private flingFromEvents(s: SimState, fog: FogState | null): void {
    if (s.tick === this.lastFxTick) return // events persist across frames
    this.lastFxTick = s.tick
    for (const ev of s.events) {
      if (ev.t !== 'died') continue
      if (fog && !fog.visibleAtWorld(ev.x, ev.z)) continue
      let bestD = Infinity
      let sx = 0
      let sz = 0
      let power = 0
      for (const src of s.events) {
        let r = 0
        if (src.t === 'impact') r = src.radius + 1.2
        else if (src.t === 'trample') r = 2.2
        else continue
        const dx = ev.x - src.x
        const dz = ev.z - src.z
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > r || d >= bestD) continue
        bestD = d
        sx = src.x
        sz = src.z
        // closer to the centre is thrown harder
        power = 7 + (1 - d / Math.max(0.001, r)) * 7
      }
      if (power <= 0) continue // an ordinary death: it just disappears
      let dx = ev.x - sx
      let dz = ev.z - sz
      const len = Math.sqrt(dx * dx + dz * dz)
      if (len < 0.01) {
        dx = 1
        dz = 0
      } else {
        dx /= len
        dz /= len
      }
      this.fling(ev.owner, ev.type, ev.x, ev.z, dx, dz, power, ev.id)
    }
  }

  // Ground preview for an armed ability: a ring at the cast point, or the
  // actual arc for a cone (opening at the caster, aimed at the cursor). Built
  // from the same numbers the sim uses, so what you see is what it hits.
  showAbilityIndicator(ab: AbilityDef, casterX: number, casterZ: number, x: number, z: number): void {
    const area = ab.area
    const key = area ? `${ab.id}:${area.shape}` : `${ab.id}:point`
    if (key !== this.abIndicatorKey) {
      this.clearAbilityIndicator()
      this.abIndicatorKey = key
      let geo: THREE.BufferGeometry
      if (area?.shape === 'cone') {
        // CircleGeometry is a sector when given thetaStart/thetaLength. acos is
        // fine here — the client never has to match the sim bit for bit.
        const half = Math.acos(Math.max(-1, Math.min(1, area.halfAngleCos)))
        geo = new THREE.CircleGeometry(area.radius, 40, -half, half * 2)
      } else {
        const r = area?.radius ?? Math.max(0.6, ab.range * 0.12)
        geo = new THREE.CircleGeometry(r, 44)
      }
      geo.rotateX(-Math.PI / 2)
      this.abIndicator = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: ab.hpDelta >= 0 ? 0x7ee787 : 0xff8f5a,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      )
      this.abIndicator.renderOrder = 2
      this.scene.add(this.abIndicator)
    }
    const m = this.abIndicator!
    if (area?.shape === 'cone') {
      m.position.set(casterX, this.grid.heightAtWorld(casterX, casterZ) + 0.08, casterZ)
      // geometry opens along +X; rotating by this yaw aims it at the cursor
      m.rotation.y = Math.atan2(-(z - casterZ), x - casterX)
    } else {
      m.position.set(x, this.grid.heightAtWorld(x, z) + 0.08, z)
    }
  }

  clearAbilityIndicator(): void {
    if (!this.abIndicator) return
    this.scene.remove(this.abIndicator)
    this.abIndicator.geometry.dispose()
    ;(this.abIndicator.material as THREE.Material).dispose()
    this.abIndicator = null
    this.abIndicatorKey = ''
  }

  flashMarker(x: number, z: number, attack: boolean): void {
    this.marker.position.set(x, this.groundHeight(x, z) + 0.06, z)
    ;(this.marker.material as THREE.MeshBasicMaterial).color.set(attack ? 0xff8f5a : 0x7ee787)
    this.markerAge = 0
  }

  // Interpolated render position for entity i.
  lerpPos(s: SimState, prevX: Float64Array, prevZ: Float64Array, i: number, alpha: number, out: THREE.Vector3): void {
    const x = prevX[i] + (s.posX[i] - prevX[i]) * alpha
    const z = prevZ[i] + (s.posZ[i] - prevZ[i]) * alpha
    // The sim is 2D; altitude is drawn here, so a flyer riding over a mountain
    // clears it visually without the simulation knowing about height at all.
    const lift = this.def.stats.flying[s.type[i]] === 1 ? FLY_HEIGHT : 0
    out.set(x, this.grid.heightAtWorld(x, z) + lift, z)
  }

  render(
    s: SimState,
    prevX: Float64Array,
    prevZ: Float64Array,
    alpha: number,
    selection: Set<number>,
    dtMs: number,
    fog: FogState | null = null,
  ): void {
    this.cam.update(dtMs)
    this.animTime += dtMs / 1000

    // Track the camera, but only re-aim when it has actually travelled —
    // moving a directional light dirties its shadow map.
    const focusX = this.cam.targetX
    const focusZ = this.cam.targetZ
    if (
      !(Math.abs(focusX - this.sunShadowAt.x) < 4 && Math.abs(focusZ - this.sunShadowAt.z) < 4)
    ) {
      this.sunShadowAt.x = focusX
      this.sunShadowAt.z = focusZ
      this.sun.position.set(focusX + 40, 60, focusZ + 20)
      this.sun.target.position.set(focusX, 0, focusZ)
      this.sun.target.updateMatrixWorld()
      this.sun.shadow.camera.updateProjectionMatrix()
    }
    if (fog?.enabled) {
      fog.update(s)
      // Re-shading walks every terrain vertex and re-uploads the whole colour
      // buffer, so it must follow the fog's revision (tick rate) and not the
      // frame rate — otherwise it is ~25k writes and a 300KB upload per frame.
      if (fog.revision !== this.fogShadedRev) {
        this.fogShadedRev = fog.revision
        shadeTerrainFog(this.terrain, fog)
      }
    }

    // units
    const counts: number[][] = Array.from({ length: MAX_RENDER_PLAYERS }, () =>
      this.def.entities.map(() => 0),
    )
    const right = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    const fwd = new THREE.Vector3()
    const pos = this.v3
    let ringCount = 0
    let healVerts = 0
    let carryCount = 0

    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (fog && !fog.canSeeEntity(s, i)) continue
      // a built-on plot is replaced by its structure — drawing both leaves the
      // pad's rim poking out around the building
      if (this.def.stats.isPlot[s.type[i]] && s.plotHost[i] >= 0) continue
      const owner = s.owner[i]
      const ty = s.type[i]
      const parts = this.units[owner][ty]
      const slot = counts[owner][ty]++
      this.lerpPos(s, prevX, prevZ, i, alpha, pos)
      fwd.set(s.faceX[i], 0, s.faceZ[i]).normalize()
      if (fwd.lengthSq() < 0.5) fwd.set(0, 0, 1)
      right.set(fwd.z, 0, -fwd.x)
      this.m4.makeBasis(right, up, fwd)
      // Render-only life: marching units bob and lean, arms swing in stride,
      // and a unit that just swung lunges and chops. Never touches the sim.
      let armSwing = 0 // walk-cycle arm angle; armL leads, armR trails
      let armChop = 0 // attack wind: armR chops forward
      // Knocked down: tip the whole body over and let it rise as the stun
      // runs out, so "still getting up" is readable at a glance.
      const stun = s.stun[i]
      if (stun > 0) {
        this.m4.multiply(this.m4b.makeRotationX(-Math.min(1.15, stun * 0.12)))
      }
      if (s.kind[i] === 0) {
        const speed = Math.hypot(s.velX[i], s.velZ[i])
        if (speed > 0.004) {
          // per-unit phase so a battalion's stride is staggered, not lockstep
          const phase = this.animTime * 9 + (i % 8) * 0.79
          const bob = Math.sin(phase) * Math.min(0.09, speed * 1.6)
          const roll = Math.cos(phase) * 0.06
          this.m4.multiply(this.m4b.makeRotationZ(roll))
          this.m4.multiply(this.m4b.makeRotationX(-0.07))
          pos.y += Math.abs(bob)
          armSwing = Math.sin(phase) * 0.45
        }
        const sinceSwing = s.tick - s.lastAttackTick[i]
        if (sinceSwing >= 0 && sinceSwing < 3) {
          const lunge = (3 - sinceSwing - alpha) / 3
          this.m4.multiply(this.m4b.makeRotationX(-0.35 * lunge))
          armChop = lunge
        }
      }
      // Gates swing their doors on the sim's open/closed state. Eased here
      // rather than in the sim because how fast a door LOOKS like it moves is
      // not something two clients have to agree about.
      let doorSwing = 0 // gates only: doors turn about the vertical, not the walk axis
      if (this.def.stats.gateRadius[ty] > 0) {
        const want = s.gateOpen[i] === 1 ? 1 : 0
        const held = this.doorOpen[i] ?? 0
        const next = held + Math.max(-0.06, Math.min(0.06, want - held))
        this.doorOpen[i] = next
        doorSwing = next * 1.5
      }
      if (s.kind[i] === 1 && s.buildTicks[i] > 0) {
        // under construction: rise out of the ground
        const total = Math.max(1, this.def.entities[ty].buildTimeTicks ?? 1)
        const p = 1 - s.buildTicks[i] / total
        this.m4.multiply(this.m4b.makeScale(1, 0.15 + 0.85 * p, 1))
      }
      this.m4.setPosition(pos)
      for (const part of parts) {
        if (part.role === 'body') {
          part.im.setMatrixAt(slot, this.m4)
          continue
        }
        // hinged group: rotate around its pivot, riding the base matrix.
        // A 'weapon' ignores the walk cycle and only fires — a catapult arm
        // must not flap while the engine rolls.
        const rx =
          part.role === 'weapon'
            ? armChop * 1.7
            : part.role === 'armL'
              ? armSwing
              : -armSwing - armChop * 1.4
        const [px, py, pz] = part.pivot
        this.m4c.makeTranslation(px, py, pz)
        // A door turns on a vertical jamb. Everything else — arms in a stride,
        // a catapult throwing — hinges on the walk axis, so gates are the one
        // case that rotates about Y instead of X.
        this.m4c.multiply(
          doorSwing !== 0
            ? this.m4b.makeRotationY(part.role === 'armL' ? doorSwing : -doorSwing)
            : this.m4b.makeRotationX(rx),
        )
        this.m4c.multiply(this.m4d.makeTranslation(-px, -py, -pz))
        this.m4d.multiplyMatrices(this.m4, this.m4c)
        part.im.setMatrixAt(slot, this.m4d)
      }

      if (selection.has(i)) {
        this.m4.makeScale(1, 1, 1)
        this.m4.setPosition(pos.x, pos.y + 0.05, pos.z)
        this.rings.setColorAt(
          ringCount,
          owner === this.mySlot
            ? RING_OWN
            : s.playerTeam[owner] === s.playerTeam[this.mySlot]
              ? RING_ALLY
              : RING_ENEMY,
        )
        this.rings.setMatrixAt(ringCount++, this.m4)
      }

      if (s.carryAmt[i] > 0 && carryCount < 256) {
        this.m4.makeScale(1, 1, 1)
        this.m4.setPosition(pos.x, pos.y + 1.7, pos.z)
        this.carryMesh.setMatrixAt(carryCount++, this.m4)
      }

      // A shot or a cast in the last couple of ticks: a bow looses an arrow,
      // a healer draws a beam.
      const tgtOk = s.target[i] >= 0 && s.alive[s.target[i]]
      const isHealer = tgtOk && s.playerTeam[s.owner[s.target[i]]] === s.playerTeam[s.owner[i]]
      // a projectile weapon draws a flying shell instead of an instant tracer
      const isRanged = this.def.stats.atkRange[ty] > 2 && this.def.stats.projSpeed[ty] <= 0
      if (tgtOk && s.tick - s.lastAttackTick[i] < 2) {
        const t = s.target[i]
        const tx = prevX[t] + (s.posX[t] - prevX[t]) * alpha
        const tz = prevZ[t] + (s.posZ[t] - prevZ[t]) * alpha
        if (isHealer) {
          // A cast stays a beam — it is magic, not ballistics.
          const arr = this.healBeamPositions
          arr[healVerts * 3] = pos.x
          arr[healVerts * 3 + 1] = pos.y + 1.2
          arr[healVerts * 3 + 2] = pos.z
          healVerts++
          arr[healVerts * 3] = tx
          arr[healVerts * 3 + 1] = this.grid.heightAtWorld(tx, tz) + 0.8
          arr[healVerts * 3 + 2] = tz
          healVerts++
        } else if (!isRanged && this.lastShotDrawn[i] !== s.lastAttackTick[i]) {
          this.lastShotDrawn[i] = s.lastAttackTick[i]
          this.audio.emit('melee', pos.x, pos.z)
        } else if (isRanged && this.lastShotDrawn[i] !== s.lastAttackTick[i]) {
          // One arrow per loosing, however many frames the tick spans.
          this.lastShotDrawn[i] = s.lastAttackTick[i]
          if (this.arrowFx.length < MAX_ARROWS) {
            const tLift = this.def.stats.flying[s.type[t]] === 1 ? FLY_HEIGHT : 0
            this.arrowFx.push({
              x0: pos.x, y0: pos.y + 1.15, z0: pos.z,
              x1: tx, y1: this.grid.heightAtWorld(tx, tz) + tLift + 0.85, z1: tz,
              age: 0,
            })
            this.audio.emit('bow', pos.x, pos.z)
          }
        }
      }
    }

    for (let owner = 0; owner < MAX_RENDER_PLAYERS; owner++) {
      for (let ty = 0; ty < this.def.entities.length; ty++) {
        const n = counts[owner][ty]
        for (const part of this.units[owner][ty]) {
          part.im.count = n
          // An InstancedMesh with count 0 still draws nothing, but three.js
          // keeps submitting it: frustumCulled is off, so it stays in the
          // render list AND the shadow pass every frame. This def builds 304
          // of them (8 owners x 38 parts) and a 4-player match populates a
          // fraction, so hiding the empties removes hundreds of no-op
          // submissions per frame from two passes.
          part.im.visible = n > 0
          if (n > 0) part.im.instanceMatrix.needsUpdate = true
        }
      }
    }
    this.rings.count = ringCount
    this.rings.instanceMatrix.needsUpdate = true
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true
    this.carryMesh.count = carryCount
    this.carryMesh.instanceMatrix.needsUpdate = true

    // Shells in flight. The sim keeps them strictly 2D; the lob is drawn here
    // from how far along the flight each one is, so the arc can never change
    // who gets hit.
    const pr = s.projectiles
    let shellCount = 0
    for (let k = 0; k < pr.count && shellCount < 256; k++) {
      if (!pr.alive[k]) continue
      const px = pr.x[k]
      const pz = pr.z[k]
      if (fog && !fog.visibleAtWorld(px, pz)) continue
      const dxTotal = pr.tgtX[k] - pr.startX[k]
      const dzTotal = pr.tgtZ[k] - pr.startZ[k]
      const total = Math.hypot(dxTotal, dzTotal)
      const remain = Math.hypot(pr.tgtX[k] - px, pr.tgtZ[k] - pz)
      const t = total < 1e-6 ? 1 : Math.min(1, Math.max(0, 1 - remain / total))
      const ground = this.grid.heightAtWorld(px, pz)
      // parabola: peaks mid-flight, scaled by how far the shot is travelling
      const lob = Math.min(7, total * 0.32) * 4 * t * (1 - t)
      this.m4.makeScale(1, 1, 1)
      this.m4.setPosition(px, ground + 0.5 + lob, pz)
      this.shells.setMatrixAt(shellCount++, this.m4)
    }
    this.shells.count = shellCount
    this.shells.instanceMatrix.needsUpdate = true

    // Arrows in flight: advance, arc, and point along the way they are going.
    // Removed by age rather than by arrival, so a shot at something that dies
    // mid-flight still completes instead of vanishing.
    {
      let n = 0
      const fwd = new THREE.Vector3()
      const up = new THREE.Vector3(0, 1, 0)
      const right = new THREE.Vector3()
      const trueUp = new THREE.Vector3()
      for (let k = this.arrowFx.length - 1; k >= 0; k--) {
        const a = this.arrowFx[k]
        a.age += dtMs
        if (a.age >= ARROW_LIFE_MS) {
          this.arrowFx.splice(k, 1)
          continue
        }
        const t = a.age / ARROW_LIFE_MS
        const x = a.x0 + (a.x1 - a.x0) * t
        const z = a.z0 + (a.z1 - a.z0) * t
        const span = Math.hypot(a.x1 - a.x0, a.z1 - a.z0)
        // A shallow lob, scaled by range: a point-blank shot flies flat.
        const lob = Math.min(1.6, span * 0.09) * 4 * t * (1 - t)
        const y = a.y0 + (a.y1 - a.y0) * t + lob
        if (fog && !fog.visibleAtWorld(x, z)) continue
        // Point it along its own velocity, lob included, so it noses over.
        const dLob = Math.min(1.6, span * 0.09) * 4 * (1 - 2 * t)
        fwd.set(a.x1 - a.x0, a.y1 - a.y0 + dLob, a.z1 - a.z0)
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1)
        fwd.normalize()
        right.crossVectors(up, fwd)
        if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
        right.normalize()
        trueUp.crossVectors(fwd, right)
        this.m4.makeBasis(right, trueUp, fwd)
        this.m4.setPosition(x, y, z)
        this.arrows.setMatrixAt(n++, this.m4)
        if (n >= MAX_ARROWS) break
      }
      this.arrows.count = n
      this.arrows.visible = n > 0
      if (n > 0) this.arrows.instanceMatrix.needsUpdate = true
    }

    this.flingFromEvents(s, fog)
    this.updateCorpses(dtMs)

    // Effects and sound raised by the sim this tick. Both are read off the
    // same event list, so anything the sim says happened is seen and heard.
    for (const ev of s.events) {
      if (ev.t === 'impact' && this.blastFx.length < 64) {
        this.blastFx.push({ x: ev.x, z: ev.z, r: Math.max(0.8, ev.radius), age: 0, dust: false })
        this.audio.emit('siege', ev.x, ev.z)
      } else if (ev.t === 'trample' && this.blastFx.length < 64) {
        // hooves kick up dust, not fire
        this.blastFx.push({ x: ev.x, z: ev.z, r: 1.1, age: 0, dust: true })
      } else if (ev.t === 'died') {
        this.audio.emit('death', ev.x, ev.z)
      } else if (ev.t === 'gateOpened' || ev.t === 'gateClosed') {
        this.audio.emit('gate', ev.x, ev.z)
      } else if (ev.t === 'upgradeDone' && ev.player === this.mySlot) {
        // Only your own research chimes — eight players' worth would be noise.
        this.audio.emit('chime', this.cam.targetX, this.cam.targetZ)
      }
    }
    this.audio.flush(this.cam.targetX, this.cam.targetZ)
    let blastCount = 0
    for (let n = this.blastFx.length - 1; n >= 0; n--) {
      const fx = this.blastFx[n]
      fx.age += dtMs / 1000
      if (fx.age > 0.45) {
        this.blastFx.splice(n, 1)
        continue
      }
      const k = fx.age / 0.45
      const sc = fx.r * (0.35 + k * 0.9)
      this.m4.makeScale(sc, 1, sc)
      this.m4.setPosition(fx.x, this.grid.heightAtWorld(fx.x, fx.z) + 0.12, fx.z)
      this.blasts.setColorAt(blastCount, fx.dust ? DUST_COLOR : BLAST_COLOR)
      this.blasts.setMatrixAt(blastCount++, this.m4)
    }
    this.blasts.count = blastCount
    this.blasts.instanceMatrix.needsUpdate = true
    if (this.blasts.instanceColor) this.blasts.instanceColor.needsUpdate = true
    ;(this.blasts.material as THREE.MeshBasicMaterial).opacity =
      blastCount > 0 ? 0.75 : 0

    // doodads (positions static; alive-set changes on chop/depletion)
    for (const [defIdx, im] of this.doodadMeshes) {
      let c = 0
      const d = s.doodads
      for (let n = 0; n < d.count; n++) {
        if (d.alive[n] !== 1 || d.defIdx[n] !== defIdx) continue
        if (fog && !fog.canSeeDoodad(d.x[n], d.z[n])) continue
        this.m4.makeScale(1, 1, 1)
        this.m4.setPosition(d.x[n], this.grid.heightAtWorld(d.x[n], d.z[n]), d.z[n])
        im.setMatrixAt(c++, this.m4)
      }
      im.count = c
      im.visible = c > 0
      if (c > 0) im.instanceMatrix.needsUpdate = true
    }
    const healGeo = this.healBeams.geometry
    healGeo.setDrawRange(0, healVerts)
    ;(healGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true

    // command marker fade
    if (this.markerAge < 1) {
      this.markerAge = Math.min(1, this.markerAge + dtMs / 450)
      const m = this.marker.material as THREE.MeshBasicMaterial
      m.opacity = 0.9 * (1 - this.markerAge)
      const sc = 1 + this.markerAge * 1.6
      this.marker.scale.set(sc, 1, sc)
    }

    // health bars (screen-space), for damaged or selected units
    this.hpbars.begin()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    for (let i = 0; i < s.count; i++) {
      if (!s.alive[i] || s.hidden[i]) continue
      if (fog && !fog.canSeeEntity(s, i)) continue
      if (this.def.stats.isPlot[s.type[i]] && s.plotHost[i] >= 0) continue
      const maxHp = this.def.stats.maxHp[s.type[i]]
      if (s.hp[i] >= maxHp && !selection.has(i)) continue
      if (this.hpbars.full) break // capped: a wall of bars reads as noise anyway
      this.lerpPos(s, prevX, prevZ, i, alpha, pos)
      pos.y += 1.9
      pos.project(this.camera)
      // behind the camera, or off the edge of the screen
      if (pos.z > 1 || pos.x < -1.05 || pos.x > 1.05 || pos.y < -1.05 || pos.y > 1.05) continue
      this.hpbars.show(
        pos.x * w2 + w2,
        -pos.y * h2 + h2,
        s.hp[i] / maxHp,
        s.playerTeam[s.owner[i]] === s.playerTeam[this.mySlot],
      )
    }
    this.hpbars.end()

    this.renderer.render(this.scene, this.camera)
  }
}
