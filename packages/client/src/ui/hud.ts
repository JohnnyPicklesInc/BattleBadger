import * as THREE from 'three'
import {
  TICK_MS,
  type FogState,
  type FormationDef,
  type GameDefCompiled,
  type RtsMapDoc,
  type SimState,
} from '@battlebadger/sim'
import { PLAYER_COLORS, modelGeometry } from '../render/unitMeshes.ts'
import { resolveModel } from '../render/assets.ts'
import type { RtsCamera } from '../render/camera.ts'
import { terrainImage } from './mapPreview.ts'
import { VERSION_LABEL } from '../version.ts'

// WC3-style bottom HUD: menu + minimap on the left, unit portrait bottom
// center, command card lower right. All buttons also work under pointer-lock
// capture via Hud.virtualClick (hit-testing the software cursor).

export interface HudActions {
  armAttack(): void
  armMove(): void
  armPatrol(): void
  hold(): void
  selectOnly(id: number): void
  deselectOne(id: number): void
  selectSameType(id: number): void
  armAbility(abIdx: number): void
  armBuild(defIdx: number): void
  train(defIdx: number): void
  stop(): void
  minimapOrder(x: number, z: number): void
  surrender(): void
  selectedAbilities(): number[]
  buildOptions(): number[]
  selectedBuilding(): number
  // BFME: build plots and battalion stances
  plotOptions(): number[]
  buildOnPlot(defIdx: number): void
  hordeFormations(): FormationDef[]
  setFormation(index: number): void
  setMuted(on: boolean): void
  researchOptions(): number[]
  researchReady(up: number): boolean
  research(up: number): void
  selectedGates(): number[]
  gateMode(): number
  setGateMode(mode: number): void
  // ticks until the selection can cast this ability; 0 = ready
  abilityCooldown(abIdx: number): number
  // jump the camera to a unit (portrait click)
  centerOn(id: number): void
}

interface CardButton {
  key: string
  label: string
  sub: string
  cls: string
  title: string
  onClick: () => void
  disabled?: boolean
}

const MM_SIZE = 176
// Yaw the portrait models sit at, in radians. Purely cosmetic.
const PORTRAIT_YAW = 0.5

export class Hud {
  private root: HTMLElement
  private mmCanvas: HTMLCanvasElement
  private mmCtx: CanvasRenderingContext2D
  private mmBg: HTMLCanvasElement
  private mmFog: HTMLCanvasElement | null = null
  private mmFogCtx: CanvasRenderingContext2D | null = null
  private mmFogData: ImageData | null = null
  private mmFogRev = -1
  private portraitCanvas: HTMLCanvasElement
  private portraitRenderer: THREE.WebGLRenderer
  private portraitScene = new THREE.Scene()
  private portraitCam = new THREE.PerspectiveCamera(30, 1, 0.1, 20)
  private portraitMeshes: THREE.Mesh[]
  private portraitShown = -1 // typeId currently visible, -1 none
  // What the portrait currently depicts, as "type:owner". The portrait is a
  // still, so it is redrawn only when this changes rather than every frame —
  // a WebGL canvas keeps its last frame on its own.
  private portraitKey = ''
  private portraitUnit = -1 // entity id the portrait depicts, -1 none
  private mmDragging = false // left button held on the minimap: scrub the view
  private nameEl: HTMLElement
  private hpEl: HTMLElement
  private countEl: HTMLElement
  private queueEl: HTMLElement
  private groupEl: HTMLElement
  private groupKey = '' // cached signature of the rendered group slots
  private groupBars: { id: number; fill: HTMLElement; pct: number }[] = []
  private supplyEl: HTMLElement | null = null
  private cardEl: HTMLElement
  private menuOverlay: HTMLElement
  private resBar: HTMLElement | null = null
  private resValueEls: HTMLElement[] = []
  private doc: RtsMapDoc
  private def: GameDefCompiled
  private cam: RtsCamera
  private mySlot: number
  private actions: HudActions
  private abilityKey = '' // cached signature of rendered ability buttons
  private raycaster = new THREE.Raycaster()
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private onMenuOpenChange: (open: boolean) => void
  private ownerColors: THREE.Color[]

  constructor(
    doc: RtsMapDoc,
    def: GameDefCompiled,
    cam: RtsCamera,
    mySlot: number,
    actions: HudActions,
    onMenuOpenChange: (open: boolean) => void,
    ownerColors: THREE.Color[] = PLAYER_COLORS,
  ) {
    this.doc = doc
    this.def = def
    this.cam = cam
    this.mySlot = mySlot
    this.actions = actions
    this.onMenuOpenChange = onMenuOpenChange
    this.ownerColors = ownerColors

    this.root = document.createElement('div')
    this.root.id = 'bhud'
    this.root.innerHTML = `
      <div id="bhud-left">
        <button id="menu-btn">☰ Menu <span>F10</span></button>
        <button id="sound-btn" title="Mute battle sound">🔊 Sound</button>
        <canvas id="mm-canvas" width="${MM_SIZE}" height="${MM_SIZE}"></canvas>
      </div>
      <div id="bhud-center">
        <button id="portrait-btn" title="Click to centre the camera on this unit"><canvas id="portrait-canvas" width="150" height="150"></canvas></button>
        <div id="sel-info">
          <div id="sel-name">—</div>
          <div id="sel-hp"></div>
          <div><span id="sel-count">0</span> <span id="sel-count-label">selected</span></div>
          <div id="sel-queue"></div>
        </div>
        <div id="sel-group"></div>
      </div>
      <div id="bhud-right">
        <button class="cmd" id="cmd-move">Move<span>M</span></button>
        <button class="cmd" id="cmd-stop">Stop<span>S</span></button>
        <button class="cmd" id="cmd-attack">Attack<span>A</span></button>
        <button class="cmd" id="cmd-hold">Hold<span>H</span></button>
        <button class="cmd" id="cmd-patrol">Patrol<span>P</span></button>
      </div>`
    document.body.appendChild(this.root)
    // Battle sound is synthesised, so muting is a gain of zero rather than a
    // download that never happens — the toggle costs nothing either way.
    const soundBtn = this.root.querySelector<HTMLButtonElement>('#sound-btn')!
    let muted = localStorage.getItem('bb-muted') === '1'
    const applyMute = (): void => {
      this.actions.setMuted(muted)
      soundBtn.textContent = muted ? '🔇 Sound' : '🔊 Sound'
      localStorage.setItem('bb-muted', muted ? '1' : '0')
    }
    soundBtn.addEventListener('click', () => {
      muted = !muted
      applyMute()
    })
    applyMute()

    this.menuOverlay = document.createElement('div')
    this.menuOverlay.className = 'overlay'
    this.menuOverlay.id = 'menu-overlay'
    this.menuOverlay.style.display = 'none'
    this.menuOverlay.innerHTML = `
      <div class="panel">
        <h1>Battle<span>Badger</span></h1>
        <div class="sub">right-click move · A attack-move · M move · S stop · H hold position ·
          P patrol · ability hotkeys sit on the command card (Q heal/mend) ·
          Ctrl+1–9 assign group, 1–9 select, double-tap centers, Shift+1–9 adds ·
          double-click selects all of a type on screen · selection slots: click
          picks that unit alone, Shift+click removes it, Ctrl+click keeps only
          its type · F fullscreen · F10 menu ·
          click captures mouse, Esc frees it · minimap: click or drag pans, right-click orders</div>
        <button id="menu-resume" class="primary">Resume</button>
        <button id="menu-fullscreen">Toggle fullscreen</button>
        <button id="menu-surrender">Surrender &amp; leave</button>
        <div class="sub" style="margin-top:10px">${VERSION_LABEL}</div>
      </div>`
    document.body.appendChild(this.menuOverlay)

    // resource bar (top right) — only when the GameDef has resources
    if (def.resources.length > 0) {
      this.resBar = document.createElement('div')
      this.resBar.id = 'resbar'
      for (const r of def.resources) {
        const item = document.createElement('span')
        item.className = 'res'
        const dot = document.createElement('i')
        dot.style.background = r.uiColor ?? '#cfd8e3'
        const val = document.createElement('b')
        val.textContent = '0'
        item.append(dot, `${r.name} `, val)
        this.resBar.appendChild(item)
        this.resValueEls.push(val)
      }
      if (def.supplyName !== '') {
        const item = document.createElement('span')
        item.className = 'res'
        const val = document.createElement('b')
        val.textContent = '0/0'
        item.append(`${def.supplyName} `, val)
        this.resBar.appendChild(item)
        this.supplyEl = val
      }
      document.body.appendChild(this.resBar)
    }

    this.mmCanvas = this.root.querySelector('#mm-canvas')!
    this.mmCtx = this.mmCanvas.getContext('2d')!
    this.nameEl = this.root.querySelector('#sel-name')!
    this.hpEl = this.root.querySelector('#sel-hp')!
    this.countEl = this.root.querySelector('#sel-count')!
    this.queueEl = this.root.querySelector('#sel-queue')!
    this.groupEl = this.root.querySelector('#sel-group')!
    this.cardEl = this.root.querySelector('#bhud-right')!
    this.portraitCanvas = this.root.querySelector('#portrait-canvas')!
    this.mmBg = this.buildMinimapBackground()

    // portrait mini-scene
    this.portraitRenderer = new THREE.WebGLRenderer({ canvas: this.portraitCanvas, antialias: true, alpha: true })
    this.portraitRenderer.setSize(150, 150, false)
    this.portraitCam.position.set(0, 1.4, 3.2)
    this.portraitCam.lookAt(0, 0.75, 0)
    this.portraitScene.add(new THREE.HemisphereLight(0xbcd2ff, 0x3a4a30, 1.1))
    const key = new THREE.DirectionalLight(0xfff2d9, 2.2)
    key.position.set(2, 3, 2)
    this.portraitScene.add(key)
    this.portraitMeshes = def.entities.map((e) => {
      // resolveModel, not modelGeometry: otherwise every 'gen:' unit shows as
      // a placeholder box in the portrait while looking right in the world.
      const gen = e.visual.model.startsWith('gen:')
      const m = new THREE.Mesh(
        resolveModel(e.visual.model, e.radius, e.visual.scale ?? 1, new Map(), modelGeometry),
        new THREE.MeshLambertMaterial(gen ? { vertexColors: true } : {}),
      )
      m.visible = false
      // Fixed three-quarter view. The portrait is a still — turning it a
      // little off dead-on shows the silhouette better than a front-on shot.
      m.rotation.y = PORTRAIT_YAW
      this.portraitScene.add(m)
      return m
    })

    // Native listeners (work when NOT pointer-locked; virtualClick covers locked).
    this.root.querySelector('#menu-btn')!.addEventListener('click', () => this.toggleMenu(true))
    this.root.querySelector('#cmd-move')!.addEventListener('click', () => this.actions.armMove())
    this.root.querySelector('#cmd-stop')!.addEventListener('click', () => this.actions.stop())
    this.root.querySelector('#cmd-attack')!.addEventListener('click', () => this.actions.armAttack())
    this.root.querySelector('#cmd-hold')!.addEventListener('click', () => this.actions.hold())
    this.root.querySelector('#cmd-patrol')!.addEventListener('click', () => this.actions.armPatrol())
    this.menuOverlay.querySelector('#menu-resume')!.addEventListener('click', () => this.toggleMenu(false))
    this.menuOverlay.querySelector('#menu-fullscreen')!.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => {})
    })
    this.menuOverlay.querySelector('#menu-surrender')!.addEventListener('click', () => this.actions.surrender())
    this.mmCanvas.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const r = this.mmCanvas.getBoundingClientRect()
      this.minimapPoint(e.clientX - r.left, e.clientY - r.top, e.button)
      // Hold and drag to scrub the view across the map. This is the one way to
      // move the camera that needs neither the keyboard nor a captured mouse,
      // so it has to work on its own.
      if (e.button === 0) this.mmDragging = true
    })
    window.addEventListener('mousemove', (e) => {
      if (!this.mmDragging) return
      const r = this.mmCanvas.getBoundingClientRect()
      this.minimapPoint(e.clientX - r.left, e.clientY - r.top, 0)
    })
    window.addEventListener('mouseup', () => {
      this.mmDragging = false
    })
    this.root.querySelector('#portrait-btn')!.addEventListener('click', () => {
      if (this.portraitUnit >= 0) this.actions.centerOn(this.portraitUnit)
    })
    this.mmCanvas.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F10') {
        e.preventDefault()
        this.toggleMenu(this.menuOverlay.style.display === 'none')
      }
    })
  }

  get menuOpen(): boolean {
    return this.menuOverlay.style.display !== 'none'
  }

  toggleMenu(open: boolean): void {
    this.menuOverlay.style.display = open ? 'flex' : 'none'
    this.onMenuOpenChange(open)
  }

  // Is this element part of the HUD (bar or menu)?
  owns(el: Element): boolean {
    return this.root.contains(el) || this.menuOverlay.contains(el)
  }

  // Route a click that happened under pointer lock (DOM events can't reach
  // the buttons then — we hit-test the virtual cursor instead).
  virtualClick(el: Element, x: number, y: number, button: number, mods?: { shift: boolean; ctrl: boolean }): void {
    if (el === this.mmCanvas) {
      const r = this.mmCanvas.getBoundingClientRect()
      this.minimapPoint(x - r.left, y - r.top, button)
      return
    }
    if (button !== 0) return
    const btn = el.closest('button')
    // Re-dispatch rather than .click(): that drops modifier state, and the
    // selection slots need Shift/Ctrl to tell their three actions apart.
    if (btn) {
      btn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: mods?.shift ?? false, ctrlKey: mods?.ctrl ?? false }),
      )
    }
  }

  private minimapPoint(mx: number, my: number, button: number): void {
    const wx = this.doc.originX + (mx / MM_SIZE) * this.doc.cols * this.doc.cellSize
    const wz = this.doc.originZ + (my / MM_SIZE) * this.doc.rows * this.doc.cellSize
    if (button === 2) this.actions.minimapOrder(wx, wz)
    else this.cam.moveTo(wx, wz)
  }

  // One pixel per map cell; rebuilt only when the fog's revision changes, so
  // this is tick-rate work rather than frame-rate work.
  private updateFogMask(fog: FogState): void {
    if (!this.mmFog) {
      this.mmFog = document.createElement('canvas')
      this.mmFog.width = fog.cols
      this.mmFog.height = fog.rows
      this.mmFogCtx = this.mmFog.getContext('2d')!
      this.mmFogData = this.mmFogCtx.createImageData(fog.cols, fog.rows)
    }
    if (fog.revision === this.mmFogRev) return
    this.mmFogRev = fog.revision
    const img = this.mmFogData!
    const d = img.data
    for (let k = 0; k < fog.visible.length; k++) {
      const o = k * 4
      d[o] = 6
      d[o + 1] = 9
      d[o + 2] = 14
      // in sight → clear, remembered → dim veil, never seen → solid black
      d[o + 3] = fog.visible[k] === 1 ? 0 : fog.explored[k] === 1 ? 115 : 255
    }
    this.mmFogCtx!.putImageData(img, 0, 0)
  }

  // Shared with the lobby's map shot, so the map you picked and the minimap you
  // play with are painted by the same code.
  private buildMinimapBackground(): HTMLCanvasElement {
    return terrainImage(this.doc)
  }

  update(
    sim: SimState,
    selection: Set<number>,
    camera: THREE.PerspectiveCamera,
    fog: FogState | null = null,
  ): void {
    this.drawMinimap(sim, camera, fog)
    this.updateSelectionPanel(sim, selection)
    if (this.resBar) {
      const n = this.def.resources.length
      for (let r = 0; r < n; r++) {
        this.resValueEls[r].textContent = String(sim.resources[this.mySlot * n + r])
      }
      if (this.supplyEl) {
        this.supplyEl.textContent = `${sim.supplyUsed[this.mySlot]}/${sim.supplyCap[this.mySlot]}`
      }
    }
  }

  private updateSelectionPanel(sim: SimState, selection: Set<number>): void {
    const n = selection.size
    this.countEl.textContent = String(n)
    this.renderGroup(sim, selection)
    if (n === 0) {
      if (this.portraitShown !== -1) {
        this.portraitMeshes.forEach((m) => (m.visible = false))
        this.portraitRenderer.clear()
        this.portraitShown = -1
        this.portraitKey = ''
      }
      this.portraitUnit = -1
      this.nameEl.textContent = '—'
      this.hpEl.textContent = ''
      this.queueEl.textContent = ''
      this.cardEl.classList.add('disabled')
      this.renderDynamicButtons([])
      return
    }
    // primary unit: lowest id, preferring own units
    let primary = -1
    for (const i of selection) {
      if (primary === -1) primary = i
      else {
        const iOwn = sim.owner[i] === this.mySlot
        const pOwn = sim.owner[primary] === this.mySlot
        if ((iOwn && !pOwn) || (iOwn === pOwn && i < primary)) primary = i
      }
    }
    const ty = sim.type[primary]
    const own = sim.owner[primary] === this.mySlot
    const e = this.def.entities[ty]
    const constructing = sim.kind[primary] === 1 && sim.buildTicks[primary] > 0
    // battalions read as one unit: the horde's name, strength and veterancy
    const horde = sim.hordeOf[primary]
    const hordeTag =
      horde >= 0
        ? ` ×${sim.hordes.members[horde].length}${sim.hordes.level[horde] > 1 ? ` · Lv ${sim.hordes.level[horde]}` : ''}`
        : ''
    this.nameEl.textContent = `${e.name}${hordeTag}${own ? '' : ' (enemy)'}${constructing ? ' (constructing)' : ''}`
    this.nameEl.style.color = own ? '#dfe6ee' : '#ff8a7a'
    this.hpEl.textContent = `${Math.max(0, sim.hp[primary])} / ${this.def.stats.maxHp[ty]} HP`
    this.cardEl.classList.toggle('disabled', !own)

    // production queue readout + dynamic card buttons
    const buttons: CardButton[] = []
    const costTitle = (defIdx: number): string => {
      const cost = this.def.entities[defIdx].cost ?? []
      return cost.map((c) => `${c.amount} ${c.resource}`).join(', ') || 'free'
    }
    // Compact cost for the button face: "80g 10l". Reading a price should not
    // require hovering for a tooltip.
    const costTag = (defIdx: number): string => {
      const cost = this.def.entities[defIdx].cost ?? []
      return cost.map((c) => `${c.amount}${(c.resource[0] ?? '').toLowerCase()}`).join(' ')
    }
    const affordable = (defIdx: number): boolean => {
      const n = this.def.resources.length
      return (this.def.entities[defIdx].cost ?? []).every((c) => {
        const ri = this.def.resIndex.get(c.resource)
        return ri === undefined || sim.resources[this.mySlot * n + ri] >= c.amount
      })
    }
    this.queueEl.textContent = ''
    if (own) {
      for (const abIdx of this.actions.selectedAbilities()) {
        const ab = this.def.abilities[abIdx]
        const cd = this.actions.abilityCooldown(abIdx)
        const secs = Math.ceil((cd * TICK_MS) / 1000)
        const shape = ab.area ? ` · ${ab.area.shape === 'cone' ? 'cone' : 'area'} ${ab.area.radius}` : ''
        buttons.push({
          key: `ab${abIdx}`,
          label: ab.name,
          sub: cd > 0 ? `${secs}s` : (ab.hotkey ?? ''),
          cls: cd > 0 ? 'ability cooling' : 'ability',
          title: `${ab.name} — ${ab.hpDelta < 0 ? `${-ab.hpDelta} damage` : `${ab.hpDelta} healing`}, range ${ab.range}${shape}, every ${Math.ceil((ab.periodTicks * TICK_MS) / 1000)}s`,
          disabled: cd > 0,
          onClick: () => this.actions.armAbility(abIdx),
        })
      }
      for (const defIdx of this.actions.buildOptions()) {
        buttons.push({
          key: `bd${defIdx}`, label: this.def.entities[defIdx].name,
          sub: costTag(defIdx) || '🔨', cls: 'build', disabled: !affordable(defIdx),
          title: costTitle(defIdx), onClick: () => this.actions.armBuild(defIdx),
        })
      }
      // A selected build plot buys its structure outright — no ghost, no worker.
      for (const defIdx of this.actions.plotOptions()) {
        buttons.push({
          key: `pl${defIdx}`, label: this.def.entities[defIdx].name,
          sub: costTag(defIdx) || '🏗', cls: 'build', disabled: !affordable(defIdx),
          title: `${costTitle(defIdx)} — built on this plot`,
          onClick: () => this.actions.buildOnPlot(defIdx),
        })
      }
      // Research the selected building sells. Shown greyed when its
      // prerequisite is missing rather than hidden, so a player can see what a
      // building will eventually offer.
      for (const up of this.actions.researchOptions()) {
        const u = this.def.upgrades?.[up]
        if (!u) continue
        const ready = this.actions.researchReady(up)
        const n = this.def.resources.length
        const afford = u.cost.every((c) => {
          const ri = this.def.resIndex.get(c.resource)
          return ri === undefined || sim.resources[this.mySlot * n + ri] >= c.amount
        })
        const price = u.cost.map((c) => `${c.amount}${(c.resource[0] ?? '').toLowerCase()}`).join(' ')
        const bits: string[] = []
        if (u.damagePct) bits.push(`+${u.damagePct}% damage`)
        if (u.armorPct) bits.push(`-${u.armorPct}% damage taken`)
        if (u.rangePct) bits.push(`+${u.rangePct}% range`)
        if (u.speedPct) bits.push(`+${u.speedPct}% speed`)
        buttons.push({
          key: `up${up}`,
          label: u.name,
          sub: price,
          cls: 'train',
          disabled: !ready || !afford,
          title: `${bits.join(', ')} — ${u.appliesTo.join(', ')}${ready ? '' : ' (needs its prerequisite)'}`,
          onClick: () => this.actions.research(up),
        })
      }
      // A gate is worked by hand: the whole question a siege asks is when to
      // open the front of your fortress, so it is a decision rather than a
      // sensor. Sally ports are on Auto and can be left there.
      if (this.actions.selectedGates().length > 0) {
        const mode = this.actions.gateMode()
        const GATE_MODES: { m: number; label: string; sub: string; title: string }[] = [
          { m: 1, label: 'Open', sub: 'O', title: 'Hold the gate open' },
          { m: 2, label: 'Shut', sub: 'C', title: 'Bar the gate' },
          { m: 0, label: 'Auto', sub: 'U', title: 'Open for nearby allies, bar it when an enemy is close' },
        ]
        for (const g of GATE_MODES) {
          buttons.push({
            key: `gt${g.m}`,
            label: g.label,
            sub: g.sub,
            cls: mode === g.m ? 'ability cooling' : 'ability',
            title: g.title,
            onClick: () => this.actions.setGateMode(g.m),
          })
        }
      }
      // Formation stances for the selected battalions.
      this.actions.hordeFormations().forEach((f, i) => {
        buttons.push({
          key: `fm${i}`, label: f.name, sub: f.hotkey ?? '', cls: 'ability',
          title: `${f.name} formation`, onClick: () => this.actions.setFormation(i),
        })
      })
      const b = this.actions.selectedBuilding()
      if (b >= 0 && sim.buildTicks[b] === 0) {
        for (const defIdx of this.def.trainsIdx[sim.type[b]]) {
          buttons.push({
            key: `tr${defIdx}`, label: this.def.entities[defIdx].name,
            sub: costTag(defIdx) || '+', cls: 'train', disabled: !affordable(defIdx),
            title: costTitle(defIdx), onClick: () => this.actions.train(defIdx),
          })
        }
        const q = sim.queue[b]
        if (q.length > 0) {
          const total = Math.max(1, this.def.entities[q[0]].buildTimeTicks ?? 10)
          const pct = Math.floor((sim.queueTicks[b] / total) * 100)
          this.queueEl.textContent = `Training ${this.def.entities[q[0]].name} ${pct}%${q.length > 1 ? ` (+${q.length - 1} queued)` : ''}`
        } else if (this.def.entities[sim.type[b]].trainer) {
          this.queueEl.textContent = 'Idle — right-click sets rally'
        }
      }
    }
    this.renderDynamicButtons(buttons)

    // Portrait: a still of the primary unit's type, tinted by owner. Redrawn
    // only when the subject changes.
    this.portraitUnit = primary
    const key = `${ty}:${sim.owner[primary]}`
    if (key !== this.portraitKey) {
      this.portraitKey = key
      for (let k = 0; k < this.portraitMeshes.length; k++) this.portraitMeshes[k].visible = k === ty
      const mesh = this.portraitMeshes[ty]
      const pm = mesh.material as THREE.MeshLambertMaterial
      // generated meshes already carry their palette (incl. owner color) in
      // vertex colors — tinting them again would wash the whole model out
      if (!pm.vertexColors) pm.color.copy(this.ownerColors[sim.owner[primary]])
      this.portraitShown = ty
      this.portraitRenderer.render(this.portraitScene, this.portraitCam)
    }
  }

  // WC3 selection-group strip: one clickable slot per selected unit, grouped by
  // type so like units sit together and the order stays stable as the army
  // moves. Every selected unit gets a slot — the panel scrolls rather than
  // truncating. A lone selection gets the portrait instead.
  //
  // Click isolates that unit, Shift+click drops it, Ctrl+click keeps only its
  // type. Slots rebuild only when membership changes; HP bars refresh per frame
  // but only write styles that actually changed.
  private renderGroup(sim: SimState, selection: Set<number>): void {
    const ids = selection.size > 1 ? [...selection].sort((a, b) => sim.type[a] - sim.type[b] || a - b) : []
    const key = ids.join(',')
    if (key !== this.groupKey) {
      this.groupKey = key
      this.groupEl.textContent = ''
      this.groupBars = []
      for (const id of ids) {
        const name = this.def.entities[sim.type[id]].name
        const btn = document.createElement('button')
        btn.className = 'selslot'
        btn.title = `${name} — click: only this · Shift+click: remove · Ctrl+click: all ${name}`
        const label = document.createElement('span')
        label.textContent = name.slice(0, 3)
        const track = document.createElement('i')
        const fill = document.createElement('b')
        track.appendChild(fill)
        btn.append(label, track)
        btn.addEventListener('click', (e) => {
          if (e.shiftKey) this.actions.deselectOne(id)
          else if (e.ctrlKey || e.metaKey) this.actions.selectSameType(id)
          else this.actions.selectOnly(id)
        })
        this.groupEl.appendChild(btn)
        this.groupBars.push({ id, fill, pct: -1 })
      }
    }
    for (const bar of this.groupBars) {
      const frac = Math.max(0, Math.min(1, sim.hp[bar.id] / Math.max(1, this.def.stats.maxHp[sim.type[bar.id]])))
      const pct = Math.round(frac * 100)
      if (pct === bar.pct) continue
      bar.pct = pct
      bar.fill.style.width = `${pct}%`
      bar.fill.style.background = frac > 0.6 ? '#62d26f' : frac > 0.3 ? '#ffc46b' : '#ff6a5a'
    }
  }

  // Rebuild the dynamic button set only when it changes.
  private renderDynamicButtons(buttons: CardButton[]): void {
    // the signature includes sub/disabled so a cooldown ticking or a price
    // becoming affordable actually repaints the card
    const key = buttons.map((b) => `${b.key}|${b.sub}|${b.disabled ? 1 : 0}`).join(',')
    if (key === this.abilityKey) return
    this.abilityKey = key
    for (const old of this.cardEl.querySelectorAll('button.cmd.dyn')) old.remove()
    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.className = `cmd dyn ${b.cls}${b.disabled ? ' unaffordable' : ''}`
      btn.title = b.title
      btn.innerHTML = `${b.label}<span>${b.sub}</span>`
      if (!b.disabled) btn.addEventListener('click', b.onClick)
      this.cardEl.appendChild(btn)
    }
  }

  private drawMinimap(sim: SimState, camera: THREE.PerspectiveCamera, fog: FogState | null): void {
    const ctx = this.mmCtx
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.mmBg, 0, 0, MM_SIZE, MM_SIZE)
    // Unexplored ground is blacked out, remembered ground dimmed. Painted as
    // a cached one-pixel-per-cell mask and blitted in a single drawImage:
    // filling a rect per cell was ~25k fillRect calls (each with a fillStyle
    // string parse) EVERY frame, which on its own tanked the frame rate.
    if (fog?.enabled && fog.mode === 'full') {
      this.updateFogMask(fog)
      ctx.drawImage(this.mmFog!, 0, 0, MM_SIZE, MM_SIZE)
    }

    const sx = MM_SIZE / (this.doc.cols * this.doc.cellSize)
    const sz = MM_SIZE / (this.doc.rows * this.doc.cellSize)
    const d = sim.doodads
    for (let n = 0; n < d.count; n++) {
      if (d.alive[n] !== 1) continue
      if (fog && !fog.canSeeDoodad(d.x[n], d.z[n])) continue
      const isNode = !!this.def.entities[d.defIdx[n]].resourceNode
      ctx.fillStyle = isNode ? '#e8c86a' : '#7d8590'
      ctx.fillRect((d.x[n] - this.doc.originX) * sx - 1, (d.z[n] - this.doc.originZ) * sz - 1, 2, 2)
    }
    for (let i = 0; i < sim.count; i++) {
      if (!sim.alive[i] || sim.hidden[i]) continue
      if (fog && !fog.canSeeEntity(sim, i)) continue
      if (this.def.stats.isPlot[sim.type[i]] && sim.plotHost[i] >= 0) continue
      ctx.fillStyle =
        sim.owner[i] === this.mySlot
          ? '#5ab1ff'
          : sim.playerTeam[sim.owner[i]] === sim.playerTeam[this.mySlot]
            ? '#8fd0ff'
            : '#ff6a5a'
      ctx.fillRect(
        (sim.posX[i] - this.doc.originX) * sx - 1.5,
        (sim.posZ[i] - this.doc.originZ) * sz - 1.5,
        3,
        3,
      )
    }

    // camera view trapezoid: intersect rays through the 4 screen corners with
    // the ground plane
    ctx.strokeStyle = 'rgba(240, 245, 250, 0.85)'
    ctx.lineWidth = 1
    ctx.beginPath()
    const corners: [number, number][] = [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
    ]
    const hit = new THREE.Vector3()
    let started = false
    for (const [nx, ny] of corners) {
      this.raycaster.setFromCamera({ x: nx, y: ny } as THREE.Vector2, camera)
      if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) continue
      const px = (hit.x - this.doc.originX) * sx
      const py = (hit.z - this.doc.originZ) * sz
      if (started) ctx.lineTo(px, py)
      else {
        ctx.moveTo(px, py)
        started = true
      }
    }
    ctx.closePath()
    ctx.stroke()
  }

  destroy(): void {
    this.root.remove()
    this.menuOverlay.remove()
    this.resBar?.remove()
    this.portraitRenderer.dispose()
  }
}
