import * as THREE from 'three'
import { hasUpgrade, upgradeInProgress, upgradeRequiresMet } from '@battlebadger/sim'
import type { Command, FormationDef, SimState } from '@battlebadger/sim'
import type { GameRenderer } from '../render/renderer.ts'
import type { MouseCursor } from './cursor.ts'
import type { Hud } from '../ui/hud.ts'

import { abStride, handleOf, validPlacement, type FogState, type WalkGrid } from '@battlebadger/sim'

type TargetMode = 'none' | 'attack' | 'move' | 'patrol' | { ab: number } | { build: number }

// What the cursor is currently over — drives the contextual cursor + smart click.
export type HoverKind = 'ground' | 'enemy' | 'ally' | 'resource'

const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0']

// WC3 gives the base commands fixed mnemonics and leaves the rest of the
// keyboard to abilities. Ability hotkeys are matched only after these, so a
// GameDef reusing one would silently lose its ability — warn the author.
const RESERVED_KEYS = ['A', 'M', 'S', 'H', 'P', 'F']

// WC3-style selection + commands: box/click select (enemies clickable, single
// only), right-click move, command card / A / M targeting modes, S stop,
// control groups (Ctrl+# assign, Shift+# add, # select, ## center camera),
// double-click / Ctrl+click selects all of a type on screen.
// All coordinates come from the virtual cursor so everything works under
// pointer-lock capture; clicks landing on HUD elements are routed to the Hud.
export class InputController {
  selection = new Set<number>()
  hud: Hud | null = null
  // Set by Game once built. Enemies the local team cannot see are not
  // clickable, not box-selectable and not valid ability/attack targets —
  // otherwise fog would be a costume rather than a rule.
  fog: FogState | null = null
  private mode: TargetMode = 'none'
  private boxStart: { x: number; y: number } | null = null
  private groups: number[][] = Array.from({ length: 10 }, () => [])
  private lastGroupKey = -1
  private lastGroupAt = 0
  private lastClickAt = 0
  private lastClickX = 0
  private lastClickY = 0
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private renderer3d: GameRenderer
  private sim: SimState
  private grid: WalkGrid
  private mySlot: number
  private cursor: MouseCursor
  private sendCmd: (c: Command) => void
  private boxEl = document.getElementById('boxsel')!
  private modeEl = document.getElementById('mode')!

  constructor(
    renderer3d: GameRenderer,
    sim: SimState,
    grid: WalkGrid,
    mySlot: number,
    cursor: MouseCursor,
    sendCmd: (c: Command) => void,
  ) {
    this.renderer3d = renderer3d
    this.sim = sim
    this.grid = grid
    this.mySlot = mySlot
    this.cursor = cursor
    this.sendCmd = sendCmd
    const canvas = renderer3d.domElement

    const shadowed = sim.def.abilities.filter((a) => a.hotkey && RESERVED_KEYS.includes(a.hotkey.toUpperCase()))
    if (shadowed.length > 0) {
      console.warn(
        `Abilities shadowed by reserved command keys (${RESERVED_KEYS.join('/')}): ` +
          `${shadowed.map((a) => `${a.name} [${a.hotkey}]`).join(', ')} — the command card still works, but pick another hotkey.`,
      )
    }

    window.addEventListener('contextmenu', (e) => {
      if (!this.hud?.menuOpen) e.preventDefault()
    })
    window.addEventListener('pointerdown', (e) => {
      const cx = this.cursor.x
      const cy = this.cursor.y
      const el = document.elementFromPoint(cx, cy)
      if (el && this.hud?.owns(el)) {
        // HUD click. Under pointer lock DOM buttons never get real events —
        // deliver it ourselves. Unlocked, the native listener handles it.
        if (this.cursor.locked) {
          this.hud.virtualClick(el, cx, cy, e.button, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
        }
        return
      }
      if (this.hud?.menuOpen) return
      if (el !== canvas) return // some other overlay (end screen, lobby)
      this.cursor.capture()

      if (e.button === 0) {
        if (typeof this.mode === 'object' && 'build' in this.mode) {
          this.issueBuildCommand(this.mode.build, cx, cy)
          this.disarm()
          return
        }
        if (typeof this.mode === 'object') {
          this.issueAbilityCommand(this.mode.ab, cx, cy)
          this.disarm()
          return
        }
        if (this.mode === 'patrol') {
          this.issuePointCommand(cx, cy, 'patrol')
          this.disarm()
          return
        }
        if (this.mode !== 'none') {
          // A-click directly on an enemy targets it specifically
          if (this.mode === 'attack') {
            const id = this.entityAt(cx, cy)
            if (id >= 0 && this.sim.playerTeam[this.sim.owner[id]] !== this.sim.playerTeam[this.mySlot]) {
              const units = this.ownedSelection()
              if (units.length > 0) {
                this.sendCmd({
                  kind: 'attack',
                  units: this.handles(units),
                  x: this.sim.posX[id],
                  z: this.sim.posZ[id],
                  target: handleOf(this.sim, id),
                })
                this.renderer3d.flashMarker(this.sim.posX[id], this.sim.posZ[id], true)
              }
              this.disarm()
              return
            }
          }
          this.issuePointCommand(cx, cy, this.mode === 'attack' ? 'attackMove' : 'move')
          this.disarm()
          return
        }
        this.boxStart = { x: cx, y: cy }
      } else if (e.button === 2) {
        this.disarm()
        this.smartRightClick(cx, cy)
      }
    })
    window.addEventListener('pointermove', () => {
      if (!this.boxStart) return
      const x0 = Math.min(this.boxStart.x, this.cursor.x)
      const y0 = Math.min(this.boxStart.y, this.cursor.y)
      const w = Math.abs(this.cursor.x - this.boxStart.x)
      const h = Math.abs(this.cursor.y - this.boxStart.y)
      Object.assign(this.boxEl.style, {
        display: 'block',
        left: `${x0}px`,
        top: `${y0}px`,
        width: `${w}px`,
        height: `${h}px`,
      })
    })
    window.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.boxStart) return
      const start = this.boxStart
      this.boxStart = null
      this.boxEl.style.display = 'none'
      const dx = Math.abs(this.cursor.x - start.x)
      const dy = Math.abs(this.cursor.y - start.y)
      if (dx < 5 && dy < 5) this.clickSelect(this.cursor.x, this.cursor.y, e.shiftKey, e.ctrlKey || e.metaKey)
      else this.boxSelect(start.x, start.y, this.cursor.x, this.cursor.y, e.shiftKey)
    })
    window.addEventListener('keydown', (e) => {
      if (this.hud?.menuOpen) return
      const digit = DIGIT_CODES.indexOf(e.code)
      if (digit !== -1) {
        e.preventDefault()
        this.handleGroupKey(digit, e.ctrlKey || e.metaKey, e.shiftKey)
        return
      }
      if (e.code === 'KeyA') this.armAttack()
      else if (e.code === 'KeyM') this.armMove()
      else if (e.code === 'KeyP') this.armPatrol()
      else if (e.code === 'KeyH') this.holdCmd()
      else if (e.code === 'KeyS') this.stopCmd()
      else if (this.matchAbilityHotkey(e.code)) {
        // handled by matchAbilityHotkey
      } else if (this.matchFormationHotkey(e.code)) {
        // handled by matchFormationHotkey
      } else if (e.code === 'KeyF') {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen().catch(() => {})
      } else if (e.code === 'Escape') this.disarm()
    })
  }

  ownedSelection(): number[] {
    const out: number[] = []
    for (const i of this.selection) if (this.sim.owner[i] === this.mySlot) out.push(i)
    return out
  }

  armAttack(): void {
    if (this.ownedSelection().length === 0) return
    this.mode = 'attack'
    this.modeEl.textContent = 'ATTACK — click a target or location (Esc to cancel)'
    this.modeEl.style.display = 'block'
  }

  armMove(): void {
    if (this.ownedSelection().length === 0) return
    this.mode = 'move'
    this.modeEl.textContent = 'MOVE — click a target location (Esc to cancel)'
    this.modeEl.style.display = 'block'
  }

  armPatrol(): void {
    if (this.ownedSelection().length === 0) return
    this.mode = 'patrol'
    this.modeEl.textContent = 'PATROL — click the far end of the route (Esc to cancel)'
    this.modeEl.style.display = 'block'
  }

  holdCmd(): void {
    const units = this.ownedSelection()
    if (units.length > 0) this.sendCmd({ kind: 'hold', units: this.handles(units), x: 0, z: 0 })
  }

  private handles(ids: number[]): number[] {
    return ids.map((id) => handleOf(this.sim, id))
  }

  stopCmd(): void {
    const units = this.ownedSelection()
    if (units.length > 0) this.sendCmd({ kind: 'stop', units: this.handles(units), x: 0, z: 0 })
  }

  // WC3 selection-group actions. Plain click isolates one unit, Shift+click
  // drops it from the group, Ctrl+click keeps only its type — so you can peel
  // the casters out of a mixed army and order them on their own.
  selectOnly(id: number): void {
    if (!this.sim.alive[id] || this.sim.hidden[id]) return
    this.disarm()
    this.selection.clear()
    for (const m of this.expandHordes([id])) this.selection.add(m)
  }

  deselectOne(id: number): void {
    if (this.selection.size <= 1) return
    this.disarm()
    for (const m of this.expandHordes([id])) {
      if (this.selection.size > 1) this.selection.delete(m)
    }
  }

  selectSameType(id: number): void {
    const ty = this.sim.type[id]
    const keep = [...this.selection].filter((i) => this.sim.type[i] === ty)
    if (keep.length === 0) return
    this.disarm()
    this.selection.clear()
    for (const i of keep) this.selection.add(i)
  }

  // Ability indices available across the owned selection (sorted, deduped).
  selectedAbilities(): number[] {
    const out = new Set<number>()
    for (const i of this.ownedSelection()) {
      for (const ab of this.sim.def.entAbilities[this.sim.type[i]]) out.add(ab)
    }
    return [...out].sort((a, b) => a - b)
  }

  // The selected unit that will actually cast this ability (lowest id), or -1.
  // The cone preview has to open from a real caster, not the selection centre.
  private casterFor(abIdx: number): number {
    for (const id of this.ownedSelection()) {
      if (this.sim.def.entAbilities[this.sim.type[id]].includes(abIdx)) return id
    }
    return -1
  }

  armAbility(abIdx: number): void {
    const ab = this.sim.def.abilities[abIdx]
    if (!ab || !this.selectedAbilities().includes(abIdx)) return
    // Still cooling down on every unit that could cast it: refuse to arm.
    if (this.abilityCooldown(abIdx) > 0) return
    // A self-cast has nothing to aim at — fire it immediately.
    if (ab.target === 'self') {
      this.disarm()
      this.issueAbilityCommand(abIdx, this.cursor.x, this.cursor.y)
      return
    }
    this.mode = { ab: abIdx }
    const what =
      ab.target === 'ally'
        ? 'a friendly unit'
        : ab.target === 'enemy'
          ? 'an enemy'
          : ab.area?.shape === 'cone'
            ? 'a direction'
            : 'a location'
    this.modeEl.textContent = `${ab.name.toUpperCase()} — click ${what} (Esc to cancel)`
    this.modeEl.style.display = 'block'
  }

  // Ticks remaining before any selected unit can cast this — 0 when ready.
  // The HUD greys the button and counts this down.
  abilityCooldown(abIdx: number): number {
    const stride = abStride(this.sim.def)
    let best = -1
    for (const id of this.ownedSelection()) {
      if (!this.sim.def.entAbilities[this.sim.type[id]].includes(abIdx)) continue
      const cd = this.sim.abCd[id * stride + abIdx]
      if (best === -1 || cd < best) best = cd
    }
    return best === -1 ? 0 : best
  }

  private matchAbilityHotkey(code: string): boolean {
    for (let i = 0; i < this.sim.def.abilities.length; i++) {
      const hk = this.sim.def.abilities[i].hotkey
      if (hk && code === `Key${hk.toUpperCase()}` && this.selectedAbilities().includes(i)) {
        this.armAbility(i)
        return true
      }
    }
    return false
  }

  // Ability cast: resolve the click per the ability's target rule.
  private issueAbilityCommand(abIdx: number, cx: number, cy: number): void {
    const ab = this.sim.def.abilities[abIdx]
    const units = this.ownedSelection()
    if (!ab || units.length === 0) return
    const handles = units.map((id) => handleOf(this.sim, id))
    if (ab.target === 'point') {
      const p = this.groundPoint(cx, cy)
      if (!p) return
      this.sendCmd({ kind: 'ability', ability: abIdx, units: handles, x: p.x, z: p.z })
      this.renderer3d.flashMarker(p.x, p.z, ab.hpDelta < 0)
      return
    }
    if (ab.target === 'self') {
      // the sim centres a self-cast on each caster; x/z are unused
      this.sendCmd({ kind: 'ability', ability: abIdx, units: handles, x: 0, z: 0 })
      const caster = this.casterFor(abIdx)
      if (caster >= 0) this.renderer3d.flashMarker(this.sim.posX[caster], this.sim.posZ[caster], ab.hpDelta < 0)
      return
    }
    const wantAlly = ab.target === 'ally'
    const v = new THREE.Vector3()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    let best = -1
    let bestD = 26 * 26
    for (let i = 0; i < this.sim.count; i++) {
      if (!this.interactable(i)) continue
      if ((this.sim.owner[i] === this.mySlot) !== wantAlly) continue
      if (!this.projectUnit(i, v)) continue
      const sx = v.x * w2 + w2
      const sy = -v.y * h2 + h2
      const d = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)
      if (d < bestD) {
        best = i
        bestD = d
      }
    }
    if (best === -1) return
    this.sendCmd({
      kind: 'ability',
      ability: abIdx,
      units: handles,
      x: 0,
      z: 0,
      target: handleOf(this.sim, best),
    })
    this.renderer3d.flashMarker(this.sim.posX[best], this.sim.posZ[best], !wantAlly)
  }

  // Ctrl+# assign, Shift+# add selection to group, # select, ## center camera.
  private handleGroupKey(n: number, assign: boolean, add: boolean): void {
    if (assign) {
      this.groups[n] = this.ownedSelection()
      return
    }
    if (add) {
      const merged = new Set(this.groups[n])
      for (const i of this.ownedSelection()) merged.add(i)
      this.groups[n] = [...merged].sort((a, b) => a - b)
      return
    }
    const alive = this.groups[n].filter((i) => this.sim.alive[i] === 1)
    this.groups[n] = alive
    if (alive.length === 0) return
    this.selection.clear()
    for (const i of alive) this.selection.add(i)
    // double-tap: center the camera on the group
    const now = performance.now()
    if (this.lastGroupKey === n && now - this.lastGroupAt < 450) {
      let cx = 0
      let cz = 0
      for (const i of alive) {
        cx += this.sim.posX[i]
        cz += this.sim.posZ[i]
      }
      this.renderer3d.cam.moveTo(cx / alive.length, cz / alive.length)
    }
    this.lastGroupKey = n
    this.lastGroupAt = now
  }

  // Select every own unit of this type currently on screen.
  private selectAllOfTypeOnScreen(ty: number): void {
    this.selection.clear()
    const v = new THREE.Vector3()
    const w = window.innerWidth
    const h = window.innerHeight
    for (let i = 0; i < this.sim.count; i++) {
      if (!this.sim.alive[i] || this.sim.owner[i] !== this.mySlot || this.sim.type[i] !== ty) continue
      if (!this.projectUnit(i, v)) continue
      const sx = (v.x * w) / 2 + w / 2
      const sy = (-v.y * h) / 2 + h / 2
      if (sx >= 0 && sx <= w && sy >= 0 && sy <= h) this.selection.add(i)
    }
  }

  // Portrait click: jump the camera to that unit without touching selection.
  centerOn(id: number): void {
    if (!this.sim.alive[id]) return
    this.renderer3d.cam.moveTo(this.sim.posX[id], this.sim.posZ[id])
  }

  minimapOrder(x: number, z: number): void {
    const units = this.ownedSelection()
    if (units.length === 0) return
    this.sendCmd({ kind: 'move', units: this.handles(units), x, z })
    this.renderer3d.flashMarker(x, z, false)
  }

  private disarm(): void {
    this.mode = 'none'
    this.modeEl.style.display = 'none'
  }

  private groundPoint(cx: number, cy: number): { x: number; z: number } | null {
    this.ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.renderer3d.camera)
    const hits = this.raycaster.intersectObject(this.renderer3d.terrainMesh, false)
    if (hits.length === 0) return null
    return { x: hits[0].point.x, z: hits[0].point.z }
  }

  private issuePointCommand(cx: number, cy: number, kind: 'move' | 'attackMove' | 'patrol'): void {
    const units = this.ownedSelection()
    if (units.length === 0) return
    const p = this.groundPoint(cx, cy)
    if (!p) return
    this.sendCmd({ kind, units: this.handles(units), x: p.x, z: p.z })
    this.renderer3d.flashMarker(p.x, p.z, kind === 'attackMove')
  }

  // ---- build / train / rally ----

  // Building def indices constructible by the current selection's workers.
  buildOptions(): number[] {
    const out = new Set<number>()
    for (const i of this.ownedSelection()) {
      for (const b of this.sim.def.buildsIdx[this.sim.type[i]]) out.add(b)
    }
    return [...out].sort((a, b) => a - b)
  }

  // ---- build plots (BFME) ----

  // The single selected free build plot the local player may use, or -1.
  // Neutral plots (outer settlements) are usable by anyone.
  selectedPlot(): number {
    if (this.selection.size !== 1) return -1
    const [only] = this.selection
    if (!this.sim.alive[only] || !this.sim.def.stats.isPlot[this.sim.type[only]]) return -1
    if (this.sim.plotHost[only] >= 0) return -1
    const plot = this.sim.def.entities[this.sim.type[only]].plot
    if (!plot?.neutral && this.sim.owner[only] !== this.mySlot) return -1
    return only
  }

  // What the selected plot can host. No worker walks anywhere and no ghost is
  // armed: the plot is the site, so the click buys the structure outright.
  plotOptions(): number[] {
    const p = this.selectedPlot()
    return p < 0 ? [] : this.sim.def.plotAcceptsIdx[this.sim.type[p]]
  }

  buildOnPlot(defIdx: number): void {
    const p = this.selectedPlot()
    if (p < 0 || !this.plotOptions().includes(defIdx)) return
    this.sendCmd({ kind: 'build', units: [], x: this.sim.posX[p], z: this.sim.posZ[p], def: defIdx })
    this.renderer3d.flashMarker(this.sim.posX[p], this.sim.posZ[p], false)
  }

  // ---- hordes ----

  // Formation stances offered by the selected hordes, when they agree on a set.
  hordeFormations(): FormationDef[] {
    const hordes = new Set<number>()
    for (const i of this.ownedSelection()) {
      if (this.sim.hordeOf[i] >= 0) hordes.add(this.sim.hordeOf[i])
    }
    if (hordes.size === 0) return []
    let common: FormationDef[] | null = null
    for (const h of hordes) {
      const forms = this.sim.def.entities[this.sim.hordes.defIdx[h]].horde?.formations ?? []
      if (common === null) common = forms
      else if (common.length !== forms.length || common.some((f, k) => f.id !== forms[k].id)) return []
    }
    return common ?? []
  }

  /** Research the selected building sells and this player can still start. */
  researchOptions(): number[] {
    const b = this.selectedBuilding()
    if (b < 0 || this.sim.buildTicks[b] > 0) return []
    return this.sim.def.upgradeSoldBy[this.sim.type[b]].filter(
      (u) => !hasUpgrade(this.sim, this.mySlot, u) && !upgradeInProgress(this.sim, this.mySlot, u),
    )
  }

  /** Requirements met? Used to grey the button rather than hide it, so a
   * player can see what a building will offer once its prerequisite is up. */
  researchReady(up: number): boolean {
    return upgradeRequiresMet(this.sim, this.mySlot, up)
  }

  research(up: number): void {
    const b = this.selectedBuilding()
    if (b < 0) return
    this.sendCmd({ kind: 'research', units: this.handles([b]), x: 0, z: 0, def: up })
  }

  /**
   * Selected gates this player may work. Allied rather than owned: four players
   * share a fortress and its walls belong to one of them, so a gate only its
   * owner could open would strand the other three outside their own keep.
   */
  selectedGates(): number[] {
    const myTeam = this.sim.playerTeam[this.mySlot]
    const out: number[] = []
    for (const i of this.selection) {
      if (!this.sim.alive[i]) continue
      if (this.sim.def.stats.gateRadius[this.sim.type[i]] <= 0) continue
      if (this.sim.playerTeam[this.sim.owner[i]] !== myTeam) continue
      out.push(i)
    }
    return out
  }

  /** The mode the selected gates share, or -1 when they disagree. */
  gateMode(): number {
    const gates = this.selectedGates()
    if (gates.length === 0) return -1
    const first = this.sim.gateMode[gates[0]]
    return gates.every((i) => this.sim.gateMode[i] === first) ? first : -1
  }

  setGateMode(mode: number): void {
    const gates = this.selectedGates()
    if (gates.length === 0) return
    this.sendCmd({ kind: 'gate', units: this.handles(gates), x: 0, z: 0, def: mode })
  }

  setFormation(index: number): void {
    const units = this.ownedSelection().filter((i) => this.sim.hordeOf[i] >= 0)
    if (units.length === 0) return
    this.sendCmd({ kind: 'formation', units: this.handles(units), x: 0, z: 0, def: index })
  }

  private matchFormationHotkey(code: string): boolean {
    const forms = this.hordeFormations()
    for (let i = 0; i < forms.length; i++) {
      const hk = forms[i].hotkey
      if (hk && code === `Key${hk.toUpperCase()}`) {
        this.setFormation(i)
        return true
      }
    }
    return false
  }

  // A battalion answers as one: touching any soldier selects his whole horde.
  private expandHordes(ids: Iterable<number>): number[] {
    const out = new Set<number>()
    for (const id of ids) {
      const h = this.sim.hordeOf[id]
      if (h >= 0) for (const m of this.sim.hordes.members[h]) out.add(m)
      else out.add(id)
    }
    return [...out]
  }

  // The single selected own completed building (or -1) — drives the train card.
  selectedBuilding(): number {
    if (this.selection.size !== 1) return -1
    const [only] = this.selection
    if (this.sim.owner[only] !== this.mySlot || this.sim.kind[only] !== 1) return -1
    return only
  }

  armBuild(defIdx: number): void {
    if (!this.buildOptions().includes(defIdx)) return
    this.mode = { build: defIdx }
    this.modeEl.textContent = `BUILD ${this.sim.def.entities[defIdx].name.toUpperCase()} — click a location (Esc to cancel)`
    this.modeEl.style.display = 'block'
  }

  train(defIdx: number): void {
    const b = this.selectedBuilding()
    if (b < 0) return
    this.sendCmd({ kind: 'train', units: [handleOf(this.sim, b)], x: 0, z: 0, def: defIdx })
  }

  cancelQueued(queueIndex: number): void {
    const b = this.selectedBuilding()
    if (b < 0) return
    this.sendCmd({ kind: 'cancel', units: [handleOf(this.sim, b)], x: 0, z: 0, target: queueIndex })
  }

  private issueBuildCommand(defIdx: number, cx: number, cy: number): void {
    const workers = this.ownedSelection().filter((id) =>
      this.sim.def.buildsIdx[this.sim.type[id]].includes(defIdx),
    )
    if (workers.length === 0) return
    const p = this.groundPoint(cx, cy)
    if (!p) return
    this.sendCmd({ kind: 'build', units: this.handles(workers), x: p.x, z: p.z, def: defIdx })
    this.renderer3d.flashMarker(p.x, p.z, false)
  }

  private tryRallyClick(cx: number, cy: number): boolean {
    const b = this.selectedBuilding()
    if (b < 0 || !this.sim.def.entities[this.sim.type[b]].trainer) return false
    const p = this.groundPoint(cx, cy)
    if (!p) return false
    this.sendCmd({ kind: 'rally', units: [handleOf(this.sim, b)], x: p.x, z: p.z })
    this.renderer3d.flashMarker(p.x, p.z, false)
    return true
  }

  // Can the local player interact with this entity at all right now?
  private interactable(i: number): boolean {
    if (!this.sim.alive[i] || this.sim.hidden[i]) return false
    // an occupied plot is not drawn, so it must not swallow clicks either —
    // they belong to the structure standing on it
    if (this.sim.def.stats.isPlot[this.sim.type[i]] && this.sim.plotHost[i] >= 0) return false
    return this.fog === null || this.fog.canSeeEntity(this.sim, i)
  }

  // Entity under the cursor (any owner), or -1. Hitbox scales with the
  // entity's on-screen radius so buildings are easy to click.
  entityAt(cx: number, cy: number, pad = 1.4): number {
    const v = new THREE.Vector3()
    const vr = new THREE.Vector3()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    let best = -1
    let bestScore = 1
    for (let i = 0; i < this.sim.count; i++) {
      if (!this.interactable(i)) continue
      if (!this.projectUnit(i, v)) continue
      const sx = v.x * w2 + w2
      const sy = -v.y * h2 + h2
      const r = this.sim.def.stats.radius[this.sim.type[i]]
      vr.set(
        this.sim.posX[i] + r,
        this.renderer3d.groundHeight(this.sim.posX[i], this.sim.posZ[i]) + 0.8,
        this.sim.posZ[i],
      )
      vr.project(this.renderer3d.camera)
      const rPx = Math.abs(vr.x * w2 + w2 - sx)
      const thresh = Math.max(22, rPx * pad)
      const score = Math.sqrt((sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)) / thresh
      if (score < bestScore) {
        best = i
        bestScore = score
      }
    }
    return best
  }

  // What's under the cursor right now — used for the contextual cursor.
  hoverKind(cx: number, cy: number): HoverKind {
    const id = this.entityAt(cx, cy)
    if (id >= 0) {
      return this.sim.playerTeam[this.sim.owner[id]] === this.sim.playerTeam[this.mySlot]
        ? 'ally'
        : 'enemy'
    }
    if (this.nodeAt(cx, cy) >= 0) return 'resource'
    return 'ground'
  }

  // WC3 right-click: enemy → attack it, ally → follow it, resource → harvest,
  // own building (with a trainer) → set rally, ground → move.
  private smartRightClick(cx: number, cy: number): void {
    const units = this.ownedSelection()
    if (units.length === 0) return
    const id = this.entityAt(cx, cy)
    // build plots are pads, not targets: right-clicking one means "go there"
    if (id >= 0 && !this.sim.def.stats.untargetable[this.sim.type[id]]) {
      const isAlly = this.sim.playerTeam[this.sim.owner[id]] === this.sim.playerTeam[this.mySlot]
      if (!isAlly) {
        this.sendCmd({
          kind: 'attack',
          units: this.handles(units),
          x: this.sim.posX[id],
          z: this.sim.posZ[id],
          target: handleOf(this.sim, id),
        })
        this.renderer3d.flashMarker(this.sim.posX[id], this.sim.posZ[id], true)
        return
      }
      // Your own wall, with troops selected: man it. Checked before the
      // follow branch, because "follow that wall" is never what anybody meant.
      if (this.sim.def.stats.rampartSlots[this.sim.type[id]] > 0) {
        this.sendCmd({
          kind: 'garrison',
          units: this.handles(units),
          x: this.sim.posX[id],
          z: this.sim.posZ[id],
          target: handleOf(this.sim, id),
        })
        this.renderer3d.flashMarker(this.sim.posX[id], this.sim.posZ[id], false)
        return
      }
      // clicking your own selected building sets its rally instead
      if (!(units.length === 1 && units[0] === id)) {
        this.sendCmd({
          kind: 'follow',
          units: this.handles(units),
          x: this.sim.posX[id],
          z: this.sim.posZ[id],
          target: handleOf(this.sim, id),
        })
        this.renderer3d.flashMarker(this.sim.posX[id], this.sim.posZ[id], false)
        return
      }
    }
    if (this.tryRallyClick(cx, cy)) return
    if (this.tryHarvestClick(cx, cy)) return
    this.issuePointCommand(cx, cy, 'move')
  }

  // Nearest harvestable node under the cursor, or -1.
  private nodeAt(cx: number, cy: number): number {
    const d = this.sim.doodads
    const v = new THREE.Vector3()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    let best = -1
    let bestD = 34 * 34
    for (let n = 0; n < d.count; n++) {
      if (d.alive[n] !== 1 || d.amount[n] === 0) continue
      const nd = this.sim.def.entities[d.defIdx[n]].resourceNode
      if (!nd) continue
      v.set(d.x[n], this.renderer3d.groundHeight(d.x[n], d.z[n]) + 0.8, d.z[n])
      v.project(this.renderer3d.camera)
      if (v.z > 1) continue
      const sx = v.x * w2 + w2
      const sy = -v.y * h2 + h2
      const dist = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)
      if (dist < bestD) {
        best = n
        bestD = dist
      }
    }
    return best
  }

  // Smart right-click: clicking a resource node with harvesters selected
  // issues a harvest order instead of a move.
  private tryHarvestClick(cx: number, cy: number): boolean {
    const owned = this.ownedSelection()
    const harvesters = owned.filter((id) => this.sim.def.entities[this.sim.type[id]].harvester)
    if (harvesters.length === 0) return false
    const d = this.sim.doodads
    const v = new THREE.Vector3()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    let best = -1
    let bestD = 34 * 34
    for (let n = 0; n < d.count; n++) {
      if (d.alive[n] !== 1 || d.amount[n] === 0) continue
      const nd = this.sim.def.entities[d.defIdx[n]].resourceNode
      if (!nd || nd.requiresExtractorOn) continue
      const canWork = harvesters.some((id) =>
        this.sim.def.entities[this.sim.type[id]].harvester!.nodeTags.includes(nd.tag),
      )
      if (!canWork) continue
      v.set(d.x[n], this.renderer3d.groundHeight(d.x[n], d.z[n]) + 0.8, d.z[n])
      v.project(this.renderer3d.camera)
      if (v.z > 1) continue
      const sx = v.x * w2 + w2
      const sy = -v.y * h2 + h2
      const dist = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)
      if (dist < bestD) {
        best = n
        bestD = dist
      }
    }
    if (best === -1) return false
    this.sendCmd({ kind: 'harvest', units: this.handles(owned), x: 0, z: 0, target: -1 - best })
    this.renderer3d.flashMarker(d.x[best], d.z[best], false)
    return true
  }

  private projectUnit(i: number, out: THREE.Vector3): boolean {
    if (this.sim.hidden[i]) return false
    out.set(this.sim.posX[i], this.renderer3d.groundHeight(this.sim.posX[i], this.sim.posZ[i]) + 0.8, this.sim.posZ[i])
    out.project(this.renderer3d.camera)
    return out.z < 1
  }

  // Click: nearest unit of ANY owner. Own units join multi-selection with
  // shift; an enemy is always a lone selection (WC3 rules). Double-click or
  // Ctrl+click on an own unit selects all of its type on screen.
  private clickSelect(cx: number, cy: number, additive: boolean, typeSelect: boolean): void {
    const best = this.entityAt(cx, cy)
    const now = performance.now()
    const isDouble =
      now - this.lastClickAt < 380 &&
      Math.abs(cx - this.lastClickX) < 10 &&
      Math.abs(cy - this.lastClickY) < 10
    this.lastClickAt = now
    this.lastClickX = cx
    this.lastClickY = cy

    if (best === -1) {
      if (!additive) this.selection.clear()
      return
    }
    if (this.sim.owner[best] === this.mySlot) {
      if (typeSelect || isDouble) {
        this.selectAllOfTypeOnScreen(this.sim.type[best])
        return
      }
      if (!additive) this.selection.clear()
      else if (this.hasEnemySelected()) this.selection.clear()
      if (additive && this.selection.has(best)) {
        for (const id of this.expandHordes([best])) this.selection.delete(id)
      } else {
        for (const id of this.expandHordes([best])) this.selection.add(id)
      }
    } else {
      this.selection.clear()
      for (const id of this.expandHordes([best])) this.selection.add(id)
    }
  }

  private hasEnemySelected(): boolean {
    for (const i of this.selection) if (this.sim.owner[i] !== this.mySlot) return true
    return false
  }

  // Box: own units preferred; if the box holds none of mine, select one enemy.
  private boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const minX = Math.min(x0, x1)
    const maxX = Math.max(x0, x1)
    const minY = Math.min(y0, y1)
    const maxY = Math.max(y0, y1)
    const v = new THREE.Vector3()
    const w2 = window.innerWidth / 2
    const h2 = window.innerHeight / 2
    const mine: number[] = []
    let firstEnemy = -1
    for (let i = 0; i < this.sim.count; i++) {
      if (!this.interactable(i)) continue
      if (!this.projectUnit(i, v)) continue
      const sx = v.x * w2 + w2
      const sy = -v.y * h2 + h2
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue
      if (this.sim.owner[i] === this.mySlot) mine.push(i)
      else if (firstEnemy === -1) firstEnemy = i
    }
    if (mine.length > 0) {
      if (!additive || this.hasEnemySelected()) this.selection.clear()
      // a box that clips one soldier takes his whole battalion
      for (const i of this.expandHordes(mine)) this.selection.add(i)
    } else if (firstEnemy !== -1) {
      this.selection.clear()
      for (const i of this.expandHordes([firstEnemy])) this.selection.add(i)
    } else if (!additive) {
      this.selection.clear()
    }
  }

  // Called each frame: drop dead/hidden units, keep targeting mode honest,
  // drive the build-placement ghost, and update the contextual cursor.
  prune(): void {
    if (typeof this.mode === 'object' && 'build' in this.mode) {
      const p = this.groundPoint(this.cursor.x, this.cursor.y)
      if (p) {
        const valid = validPlacement(this.sim, this.grid, this.mode.build, p.x, p.z, this.mySlot)
        this.renderer3d.showGhost(this.mode.build, p.x, p.z, valid)
      }
      this.cursor.setHint('build')
    } else {
      this.renderer3d.hideGhost()
      const targeting = this.mode !== 'none'
      this.cursor.setHint(
        targeting ? (this.mode === 'attack' ? 'enemy' : 'target') : this.hoverKind(this.cursor.x, this.cursor.y),
      )
    }
    // Armed ability: preview exactly what the cast will cover.
    if (typeof this.mode === 'object' && 'ab' in this.mode) {
      const abIdx = this.mode.ab
      const ab = this.sim.def.abilities[abIdx]
      const p = this.groundPoint(this.cursor.x, this.cursor.y)
      const caster = this.casterFor(abIdx)
      if (ab && p && caster >= 0) {
        this.renderer3d.showAbilityIndicator(ab, this.sim.posX[caster], this.sim.posZ[caster], p.x, p.z)
      }
    } else {
      this.renderer3d.clearAbilityIndicator()
    }
    for (const i of this.selection) {
      // also drops an enemy that just walked into the fog
      if (!this.interactable(i)) this.selection.delete(i)
    }
    if (this.mode !== 'none' && this.ownedSelection().length === 0) this.disarm()
  }
}
