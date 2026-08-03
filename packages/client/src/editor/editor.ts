import * as THREE from 'three'
import {
  ECON_DEMO_DEF,
  compileGameDef,
  baseOf,
  compileTriggers,
  deriveTerrain,
  extractModule,
  mapOwners,
  mapSlotCount,
  resizeMap,
  findPath,
  toPack,
  validateBlueprints,
  validateGameDef,
  validateRulesetPack,
  walkGridFromDoc,
  type FogMode,
  type GameDef,
  type GenBlueprint,
  type RtsMapDoc,
} from '@battlebadger/sim'
import { RtsCamera } from '../render/camera.ts'
import { buildTerrainMesh } from '../render/terrainMesh.ts'
import { modelGeometry, PLAYER_COLORS } from '../render/unitMeshes.ts'
import { buildGenGroups } from '../gen/build.ts'
import { MouseCursor } from '../input/cursor.ts'

// BattleBadger world editor (#editor). One in-memory RtsMapDoc is the source
// of truth; every stroke snapshots for undo; terrain/doodads rebuild on edit.

type ToolId =
  | 'raise'
  | 'lower'
  | 'ramp'
  | 'unramp'
  | 'texture'
  | 'doodad'
  | 'entity'
  | 'start'
  | 'region'
  | 'erase'

const AUTOSAVE_KEY = 'bb-editor-current'
const TEX_NAMES = ['Grass', 'Dirt', 'Rock', 'Sand', 'Snow', 'Dark grass', 'Water', 'Ash']

function blankDoc(size = 64): RtsMapDoc {
  const n = size * size
  return {
    version: 2,
    name: 'untitled-map',
    seed: 42,
    cols: size,
    rows: size,
    cellSize: 1,
    originX: 0,
    originZ: 0,
    walkable: Array.from({ length: n }, () => 1),
    cliffLevel: Array.from({ length: n }, () => 0),
    ramp: Array.from({ length: n }, () => 0),
    texture: Array.from({ length: n }, () => 0),
    heightJitter: Array.from({ length: n }, () => 0),
    startLocations: [],
    placed: [],
    doodads: [],
    regions: [],
    gameDef: JSON.parse(JSON.stringify(ECON_DEMO_DEF)) as GameDef,
  }
}

import { idbGet, idbPut, saveToLibrary } from '../mapLibrary.ts'
import { GEN_BLUEPRINTS, useMapBlueprints } from '../gen/registry.ts'
import { renderFields } from './forms.ts'
import {
  cleanTriggers,
  entityFields,
  entityToForm,
  formToEntity,
  partFields,
  triggerFields,
  PART_VECTORS,
  type FormContext,
} from './schemaForms.ts'
import {
  deleteRuleset,
  describeRuleset,
  exportRuleset,
  installRuleset,
  listRulesets,
  saveRuleset,
} from '../rulesetLibrary.ts'
import { listFactions } from '../ui/factions.ts'

export function validateMap(doc: RtsMapDoc): string[] {
  const errs: string[] = []
  if (!doc.gameDef) errs.push('map has no GameDef')
  else errs.push(...validateGameDef(doc.gameDef))
  if (doc.startLocations.length < 2) errs.push('need at least 2 start locations')
  const grid = walkGridFromDoc(doc)
  for (const [i, st] of doc.startLocations.entries()) {
    if (!grid.isWalkableWorld(st.x, st.z)) errs.push(`start ${i + 1} is on unwalkable ground`)
  }
  if (doc.startLocations.length >= 2) {
    const [a, b] = doc.startLocations
    if (grid.isWalkableWorld(a.x, a.z) && grid.isWalkableWorld(b.x, b.z)) {
      // `exact`: this is a reachability question. The default best-effort mode
      // returns a partial path to the closest point, which would answer "yes"
      // for two starts with a mountain between them.
      const p = findPath(grid, grid.cellX(a.x), grid.cellZ(a.z), grid.cellX(b.x), grid.cellZ(b.z), true)
      if (!p) errs.push('start locations are not reachable from each other')
    }
  }
  if (doc.gameDef) {
    const ent = new Set(doc.gameDef.entities.map((e) => e.id))
    for (const d of doc.doodads ?? []) if (!ent.has(d.def)) errs.push(`unknown doodad def "${d.def}"`)
    for (const pl of doc.placed ?? []) if (!ent.has(pl.def)) errs.push(`unknown placed def "${pl.def}"`)
    // A 'gen:' typo renders a placeholder box rather than failing, so it is
    // otherwise only findable by squinting at the map.
    const authored = new Set((doc.blueprints ?? []).map((b) => b.id))
    for (const e of doc.gameDef.entities) {
      const model = e.visual?.model ?? ''
      if (!model.startsWith('gen:')) continue
      const id = model.slice(4)
      if (!authored.has(id) && !GEN_BLUEPRINTS[id]) errs.push(`"${e.id}" uses unknown model "gen:${id}"`)
    }
  }
  return errs
}

export async function bootEditor(app: HTMLElement): Promise<void> {
  let doc: RtsMapDoc
  const saved = await idbGet(AUTOSAVE_KEY).catch(() => null)
  try {
    doc = saved ? (JSON.parse(saved) as RtsMapDoc) : blankDoc()
  } catch {
    doc = blankDoc()
  }

  // ---- three.js scene ----
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  app.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0c0f14)
  scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x3a4a30, 0.95))
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.5)
  sun.position.set(40, 60, 20)
  scene.add(sun)

  const cursor = new MouseCursor(app) // never enabled → plain OS cursor
  const cam = new RtsCamera(
    cursor,
    window.innerWidth / window.innerHeight,
    doc.cols / 2,
    doc.rows / 2,
    2,
    doc.cols - 2,
    2,
    doc.rows - 2,
  )
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight)
    cam.resize(window.innerWidth / window.innerHeight)
  })

  let terrain: THREE.Mesh = buildTerrainMesh(doc)
  scene.add(terrain)
  const markerGroup = new THREE.Group() // doodads, entities, starts
  scene.add(markerGroup)
  const brushRing = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7ee787, transparent: true, opacity: 0.8 }),
  )
  scene.add(brushRing)

  const rebuildTerrain = (): void => {
    scene.remove(terrain)
    terrain.geometry.dispose()
    terrain = buildTerrainMesh(doc)
    scene.add(terrain)
  }

  const rebuildMarkers = (): void => {
    markerGroup.clear()
    // Runs on every doc swap (new / import / undo), so authored models show up
    // the moment they are edited.
    useMapBlueprints(doc)
    const def = doc.gameDef!
    const { heights } = deriveTerrain(doc)
    const hAt = (x: number, z: number): number => {
      const cx = Math.max(0, Math.min(doc.cols - 1, Math.floor(x)))
      const cz = Math.max(0, Math.min(doc.rows - 1, Math.floor(z)))
      return heights[cz * doc.cols + cx]
    }
    for (const d of doc.doodads ?? []) {
      const e = def.entities.find((en) => en.id === d.def)
      if (!e?.visual) continue // half-authored def: skip rather than throw
      const m = new THREE.Mesh(
        modelGeometry(e.visual.model, e.radius, (e.visual.scale ?? 1) * (d.scale ?? 1)),
        new THREE.MeshLambertMaterial({
          color: e.visual.model.includes('tree') ? 0x3f7d3a : e.visual.model.includes('crystal') ? 0x64d8e8 : e.visual.model.includes('dome') ? 0xc9a54a : 0x8a8f96,
        }),
      )
      m.position.set(d.x, hAt(d.x, d.z), d.z)
      markerGroup.add(m)
    }
    for (const pl of doc.placed ?? []) {
      const e = def.entities.find((en) => en.id === pl.def)
      if (!e?.visual) continue
      const m = new THREE.Mesh(
        modelGeometry(e.visual.model, e.radius, e.visual.scale ?? 1),
        new THREE.MeshLambertMaterial({ color: PLAYER_COLORS[pl.owner] ?? 0xffffff }),
      )
      m.position.set(pl.x, hAt(pl.x, pl.z), pl.z)
      markerGroup.add(m)
    }
    doc.startLocations.forEach((st, i) => {
      const flag = new THREE.Mesh(
        new THREE.ConeGeometry(0.7, 2.4, 4),
        new THREE.MeshLambertMaterial({ color: PLAYER_COLORS[i] ?? 0xffe27a }),
      )
      flag.position.set(st.x, hAt(st.x, st.z) + 1.2, st.z)
      markerGroup.add(flag)
    })
    for (const rg of doc.regions ?? []) {
      const w = Math.max(0.5, rg.x1 - rg.x0)
      const d = Math.max(0.5, rg.z1 - rg.z0)
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(w, 0.4, d),
        new THREE.MeshBasicMaterial({ color: 0xba6bff, transparent: true, opacity: 0.22 }),
      )
      const cx = (rg.x0 + rg.x1) / 2
      const cz = (rg.z0 + rg.z1) / 2
      box.position.set(cx, hAt(cx, cz) + 0.3, cz)
      markerGroup.add(box)
    }
  }
  rebuildMarkers()

  // ---- undo/redo (full-doc snapshots, capped) ----
  const undoStack: string[] = []
  const redoStack: string[] = []
  const snapshot = (): void => {
    undoStack.push(JSON.stringify(doc))
    if (undoStack.length > 30) undoStack.shift()
    redoStack.length = 0
  }
  const applyState = (json: string): void => {
    doc = JSON.parse(json) as RtsMapDoc
    rebuildTerrain()
    rebuildMarkers()
    syncPickers()
  }
  const undo = (): void => {
    const s = undoStack.pop()
    if (!s) return
    redoStack.push(JSON.stringify(doc))
    applyState(s)
  }
  const redo = (): void => {
    const s = redoStack.pop()
    if (!s) return
    undoStack.push(JSON.stringify(doc))
    applyState(s)
  }

  // The forms commit on every keystroke, and a rebuild walks every placed
  // entity on the map. Coalescing them keeps typing in a numeric field smooth
  // on a map with hundreds of units, where the per-character cost is felt.
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRebuild = (): void => {
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      rebuildMarkers()
    }, 150)
  }

  let autosaveTimer: ReturnType<typeof setTimeout> | null = null
  const autosave = (): void => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => {
      void idbPut(AUTOSAVE_KEY, JSON.stringify(doc))
    }, 800)
  }

  // ---- toolbar UI ----
  const ui = document.createElement('div')
  ui.id = 'ed-ui'
  ui.innerHTML = `
    <div id="ed-top">
      <b>BattleBadger Editor</b>
      <input id="ed-name" spellcheck="false" />
      <button id="ed-new">New</button>
      <button id="ed-import">Import</button>
      <button id="ed-export">Export</button>
      <button id="ed-library">Save to library</button>
      <button id="ed-gamedef">Game rules</button>
      <button id="ed-rulesets">Rulesets</button>
      <button id="ed-players">Players</button>
      <button id="ed-triggers">Triggers</button>
      <button id="ed-assets">Assets</button>
      <button id="ed-playtest" class="primary">▶ Playtest</button>
      <a href="#" id="ed-exit">Exit</a>
      <input type="file" id="ed-file" accept=".json,.bbmap" style="display:none" />
    </div>
    <div id="ed-side">
      <div class="ed-group" id="ed-tools"></div>
      <div class="ed-group">
        <label>Brush <span id="ed-brushv">2</span></label>
        <input id="ed-brush" type="range" min="1" max="6" value="2" />
      </div>
      <div class="ed-group"><label>Fog of war</label><select id="ed-fog">
        <option value="off">Off — everything visible</option>
        <option value="units">On — show map, hide units</option>
        <option value="full">On — hide everything</option>
      </select></div>
      <div class="ed-group"><label>Races the lobby may seat</label>
        <select id="ed-races" multiple size="4"></select>
        <div class="ed-hint">none selected = any faction whose rules fit</div></div>
      <div class="ed-group"><label>Texture</label><select id="ed-tex"></select></div>
      <div class="ed-group"><label>Doodad</label><select id="ed-doodad"></select></div>
      <div class="ed-group"><label>Entity</label><select id="ed-entity"></select>
        <label>Owner</label><select id="ed-owner"></select></div>
      <div class="ed-status" id="ed-status"></div>
    </div>`
  document.body.appendChild(ui)
  const $ = <T extends HTMLElement>(id: string): T => ui.querySelector<T>(`#${id}`)!

  const TOOLS: { id: ToolId; label: string }[] = [
    { id: 'raise', label: '⬆ Raise cliff' },
    { id: 'lower', label: '⬇ Lower cliff' },
    { id: 'ramp', label: '⤴ Ramp' },
    { id: 'unramp', label: '⤵ Clear ramp' },
    { id: 'texture', label: '🖌 Texture' },
    { id: 'doodad', label: '🌲 Doodad' },
    { id: 'entity', label: '♟ Unit/Building' },
    { id: 'start', label: '⚑ Start point' },
    { id: 'region', label: '▭ Region' },
    { id: 'erase', label: '✖ Erase' },
  ]
  let tool: ToolId = 'raise'
  const toolsEl = $('ed-tools')
  for (const t of TOOLS) {
    const b = document.createElement('button')
    b.textContent = t.label
    b.dataset.tool = t.id
    if (t.id === tool) b.classList.add('active')
    b.addEventListener('click', () => {
      tool = t.id
      toolsEl.querySelectorAll('button').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
    })
    toolsEl.appendChild(b)
  }

  const nameInput = $<HTMLInputElement>('ed-name')
  const texSel = $<HTMLSelectElement>('ed-tex')
  const fogSel = $<HTMLSelectElement>('ed-fog')
  fogSel.addEventListener('change', () => {
    doc.fog = fogSel.value as FogMode
  })
  // A map's roster: which races a lobby may swap onto its start positions.
  // Selecting none leaves it open, which is what an unopinionated map wants.
  const racesSel = $<HTMLSelectElement>('ed-races')
  let editorFactions: { id: string; name: string }[] = []
  void listFactions().then((f) => {
    editorFactions = f
    syncPickers()
  })
  racesSel.addEventListener('change', () => {
    const picked = [...racesSel.selectedOptions].map((o) => o.value)
    doc.races = picked.length > 0 ? picked : undefined
  })
  const doodadSel = $<HTMLSelectElement>('ed-doodad')
  const entitySel = $<HTMLSelectElement>('ed-entity')
  const ownerSel = $<HTMLSelectElement>('ed-owner')
  const statusEl = $('ed-status')
  const brushInput = $<HTMLInputElement>('ed-brush')
  brushInput.addEventListener('input', () => ($('ed-brushv').textContent = brushInput.value))

  const syncPickers = (): void => {
    nameInput.value = doc.name
    fogSel.value = doc.fog ?? 'off'
    // Every faction on the local ruleset shelf is offerable — including one
    // the author imported themselves, the same list the lobby picks from.
    const chosen = new Set(doc.races ?? [])
    racesSel.innerHTML = editorFactions
      .map((f) => `<option value="${f.id}"${chosen.has(f.id) ? ' selected' : ''}>${f.name}</option>`)
      .join('')
    // Owners come from the map, not from a hardcoded pair. Start locations are
    // the player slots; anything beyond them is a war slot the map owns content
    // in but no human ever occupies (MOBA creeps, scripted attackers). Two
    // spares are always offered so a new one can be introduced.
    const slots = mapSlotCount(doc)
    const used = mapOwners(doc)
    const spare = [used[used.length - 1] + 1, used[used.length - 1] + 2].filter((o) => o < 8)
    const owners = [...new Set([...used, ...spare])].sort((a, b) => a - b)
    const keep = ownerSel.value
    ownerSel.innerHTML = owners
      .map((o) => `<option value="${o}">${o < slots ? `Player ${o + 1}` : `AI slot ${o + 1}`}</option>`)
      .join('')
    if (owners.some((o) => String(o) === keep)) ownerSel.value = keep
    texSel.innerHTML = TEX_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')
    const def = doc.gameDef!
    doodadSel.innerHTML = def.entities
      .filter((e) => e.kind === 'doodad')
      .map((e) => `<option value="${e.id}">${e.name}</option>`)
      .join('')
    entitySel.innerHTML = def.entities
      .filter((e) => e.kind !== 'doodad')
      .map((e) => `<option value="${e.id}">${e.name}</option>`)
      .join('')
  }
  syncPickers()
  nameInput.addEventListener('input', () => {
    doc.name = nameInput.value
    autosave()
  })

  // ---- painting ----
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const groundPoint = (cx: number, cy: number): { x: number; z: number } | null => {
    ndc.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1)
    raycaster.setFromCamera(ndc, cam.camera)
    const hits = raycaster.intersectObject(terrain, false)
    return hits.length ? { x: hits[0].point.x, z: hits[0].point.z } : null
  }

  let painting = false
  let strokeChangedTerrain = false
  const cellsInBrush = (wx: number, wz: number): number[] => {
    const r = Number(brushInput.value)
    const out: number[] = []
    const cx0 = Math.floor(wx - r)
    const cx1 = Math.floor(wx + r)
    const cz0 = Math.floor(wz - r)
    const cz1 = Math.floor(wz + r)
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 1 || cz < 1 || cx >= doc.cols - 1 || cz >= doc.rows - 1) continue
        const dx = cx + 0.5 - wx
        const dz = cz + 0.5 - wz
        if (dx * dx + dz * dz <= r * r) out.push(cz * doc.cols + cx)
      }
    }
    return out
  }

  const applyBrush = (wx: number, wz: number): void => {
    const cells = cellsInBrush(wx, wz)
    const lvl = doc.cliffLevel!
    const ramp = doc.ramp!
    const tex = doc.texture!
    let dirty = false
    if (tool === 'raise' || tool === 'lower') {
      // plateau semantics: set brushed cells to (level under cursor ±1)
      const centerIdx = Math.floor(wz) * doc.cols + Math.floor(wx)
      const target = Math.max(0, Math.min(7, (lvl[centerIdx] ?? 0) + (tool === 'raise' ? 1 : -1)))
      for (const i of cells) {
        if (lvl[i] !== target) {
          lvl[i] = target
          dirty = true
        }
      }
    } else if (tool === 'ramp' || tool === 'unramp') {
      const v = tool === 'ramp' ? 1 : 0
      for (const i of cells) {
        if (ramp[i] !== v) {
          ramp[i] = v
          if (v === 1) tex[i] = 1
          dirty = true
        }
      }
    } else if (tool === 'texture') {
      const v = Number(texSel.value)
      for (const i of cells) {
        if (tex[i] !== v) {
          tex[i] = v
          dirty = true
        }
      }
    }
    if (dirty) {
      strokeChangedTerrain = true
      rebuildTerrain()
      autosave()
    }
  }

  const placeAt = (wx: number, wz: number): void => {
    if (tool === 'doodad' && doodadSel.value) {
      doc.doodads!.push({ def: doodadSel.value, x: wx, z: wz })
    } else if (tool === 'entity' && entitySel.value) {
      doc.placed!.push({ def: entitySel.value, owner: Number(ownerSel.value), x: wx, z: wz })
    } else if (tool === 'start') {
      // Eight is the sim's slot limit. Dropping a ninth used to silently evict
      // the first, which is why every editor-made map was two players.
      if (doc.startLocations.length >= 8) {
        statusEl.textContent = 'eight start points is the limit — erase one first'
        return
      }
      doc.startLocations.push({ x: wx, z: wz })
      syncPickers()
    } else if (tool === 'erase') {
      const near = <T extends { x: number; z: number }>(arr: T[]): number => {
        let best = -1
        let bestD = 2.5 * 2.5
        arr.forEach((o, i) => {
          const d = (o.x - wx) * (o.x - wx) + (o.z - wz) * (o.z - wz)
          if (d < bestD) {
            best = i
            bestD = d
          }
        })
        return best
      }
      const di = near(doc.doodads!)
      const pi = near(doc.placed!)
      const si = near(doc.startLocations)
      const ri = (doc.regions ?? []).findIndex(
        (rg) => wx >= rg.x0 && wx <= rg.x1 && wz >= rg.z0 && wz <= rg.z1,
      )
      if (di >= 0) doc.doodads!.splice(di, 1)
      else if (pi >= 0) doc.placed!.splice(pi, 1)
      else if (si >= 0) {
        doc.startLocations.splice(si, 1)
        syncPickers() // one fewer slot to own things
      } else if (ri >= 0) doc.regions!.splice(ri, 1)
    }
    rebuildMarkers()
    autosave()
  }

  let regionStart: { x: number; z: number } | null = null
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const p = groundPoint(e.clientX, e.clientY)
    if (!p) return
    snapshot()
    if (tool === 'raise' || tool === 'lower' || tool === 'ramp' || tool === 'unramp' || tool === 'texture') {
      painting = true
      strokeChangedTerrain = false
      applyBrush(p.x, p.z)
    } else if (tool === 'region') {
      regionStart = p
    } else {
      placeAt(p.x, p.z)
    }
  })
  window.addEventListener('pointermove', (e) => {
    const p = groundPoint(e.clientX, e.clientY)
    if (p) {
      const r = Number(brushInput.value)
      brushRing.scale.set(r, 1, r)
      brushRing.position.set(p.x, 0.1, p.z)
      if (painting) applyBrush(p.x, p.z)
    }
  })
  window.addEventListener('pointerup', (e) => {
    if (painting && !strokeChangedTerrain) undoStack.pop() // no-op stroke
    painting = false
    if (regionStart) {
      const p = groundPoint(e.clientX, e.clientY)
      const start = regionStart
      regionStart = null
      if (p) {
        const name = prompt('Region name?', `region${(doc.regions?.length ?? 0) + 1}`)
        if (name) {
          doc.regions ??= []
          doc.regions.push({
            id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            name,
            x0: Math.min(start.x, p.x),
            z0: Math.min(start.z, p.z),
            x1: Math.max(start.x, p.x),
            z1: Math.max(start.z, p.z),
          })
          rebuildMarkers()
          autosave()
        } else {
          undoStack.pop()
        }
      } else {
        undoStack.pop()
      }
    }
  })
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
      e.preventDefault()
      redo()
    }
  })

  // ---- top bar actions ----
  $('ed-new').addEventListener('click', () => {
    if (!confirm('Start a new blank map? (current map stays in autosave until you edit)')) return
    snapshot()
    doc = blankDoc()
    rebuildTerrain()
    rebuildMarkers()
    syncPickers()
    autosave()
  })
  $('ed-export').addEventListener('click', () => {
    const errs = validateMap(doc)
    if (errs.length > 0 && !confirm(`Map has issues:\n- ${errs.join('\n- ')}\n\nExport anyway?`)) return
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${doc.name || 'map'}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  })
  $('ed-library').addEventListener('click', () => {
    const errs = validateMap(doc)
    if (errs.length > 0 && !confirm(`Map has issues:\n- ${errs.join('\n- ')}\n\nSave anyway?`)) return
    void saveToLibrary(doc).then((key) => {
      statusEl.textContent = `saved to library as "${key.slice(4)}" — pick it in the lobby`
    })
  })
  $('ed-import').addEventListener('click', () => $('ed-file').click())
  $<HTMLInputElement>('ed-file').addEventListener('change', () => {
    const f = $<HTMLInputElement>('ed-file').files?.[0]
    if (!f) return
    void f.text().then((text) => {
      try {
        const next = JSON.parse(text) as RtsMapDoc
        if (!next.cols || !next.rows) throw new Error('not a map')
        snapshot()
        doc = next
        rebuildTerrain()
        rebuildMarkers()
        syncPickers()
        autosave()
        statusEl.textContent = `imported ${doc.name}`
      } catch (err) {
        statusEl.textContent = `import failed: ${String(err)}`
      }
    })
  })
  // A model list the forms can offer: this map's own blueprints first, then
  // every built-in, plus the placeholders that need no blueprint at all.
  const modelOptions = (): { value: string; label: string }[] => {
    const mine = (doc.blueprints ?? []).map((b) => ({ value: `gen:${b.id}`, label: `${b.id} (this map)` }))
    const assets = (doc.assets ?? []).map((a) => ({ value: `asset:${a.id}`, label: `${a.id} (uploaded)` }))
    const builtIn = Object.keys(GEN_BLUEPRINTS)
      .sort()
      .map((id) => ({ value: `gen:${id}`, label: id }))
    const placeholders = [
      'placeholder:capsule', 'placeholder:cone', 'placeholder:lathe',
      'placeholder:box', 'placeholder:tree', 'placeholder:crystal',
    ].map((m) => ({ value: m, label: m }))
    return [...mine, ...assets, ...builtIn, ...placeholders]
  }
  const formCtx = (): FormContext => ({ doc, def: doc.gameDef!, modelIds: modelOptions })

  // ---- game rules: a form per entity, with the raw JSON alongside ---------
  $('ed-gamedef').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:860px">
      <h1>Game <span>rules</span></h1>
      <div class="sub">Units, buildings and doodads. The form covers what you reach for;
        Raw JSON edits the whole def for the long tail — crush levels, projectiles,
        expansion rings.</div>
      <div class="row" style="margin-bottom:8px">
        <button id="gd-add">+ New entity</button>
        <button id="gd-dup">Duplicate</button>
        <button id="gd-del">Delete</button>
        <button id="gd-raw">Raw JSON…</button>
      </div>
      <div class="fm-cols">
        <div class="fm-list" id="gd-list"></div>
        <div class="fm-body" id="gd-form"></div>
      </div>
      <div class="row"><button id="gd-close" class="primary">Done</button></div>
      <div class="status" id="gd-status" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const status = overlay.querySelector('#gd-status')!
    const listEl = overlay.querySelector<HTMLElement>('#gd-list')!
    const formEl = overlay.querySelector<HTMLElement>('#gd-form')!
    let selected = 0
    let working = doc.gameDef!.entities.map((e) => entityToForm(e as unknown as Record<string, unknown>))

    // Every keystroke is validated against the whole def before it lands. An
    // edit that breaks it is reported instead of leaving the map in a state the
    // compiler will refuse later, somewhere far from the field that caused it.
    const commit = (entities: Record<string, unknown>[]): boolean => {
      const next = { ...doc.gameDef!, entities: entities.map((e) => formToEntity(e)) } as unknown as GameDef
      const errs = validateGameDef(next)
      if (errs.length > 0) {
        status.textContent = errs.join('\n')
        return false
      }
      doc.gameDef = next
      status.textContent = ''
      syncPickers()
      scheduleRebuild()
      autosave()
      return true
    }

    const drawList = (): void => {
      listEl.innerHTML = ''
      working.forEach((e, i) => {
        const b = document.createElement('button')
        b.textContent = String(e.name ?? e.id ?? '?')
        b.title = String(e.id ?? '')
        if (i === selected) b.classList.add('active')
        b.addEventListener('click', () => {
          selected = i
          drawList()
          drawForm()
        })
        listEl.append(b)
      })
    }
    const drawForm = (): void => {
      formEl.innerHTML = ''
      const e = working[selected]
      if (!e) return
      renderFields(formEl, entityFields(formCtx()), e, () => {
        if (commit(working)) drawList()
      })
    }
    drawList()
    drawForm()

    overlay.querySelector('#gd-add')!.addEventListener('click', () => {
      snapshot()
      working.push({
        id: `unit-${working.length + 1}`,
        name: 'New unit',
        kind: 'unit',
        hp: 100,
        radius: 0.4,
        visual: { model: 'placeholder:capsule', tint: 'owner' },
      })
      selected = working.length - 1
      commit(working)
      drawList()
      drawForm()
    })
    overlay.querySelector('#gd-dup')!.addEventListener('click', () => {
      const src = working[selected]
      if (!src) return
      snapshot()
      const copy = JSON.parse(JSON.stringify(src)) as Record<string, unknown>
      copy.id = `${String(copy.id)}-copy`
      copy.name = `${String(copy.name)} copy`
      working.splice(selected + 1, 0, copy)
      selected++
      commit(working)
      drawList()
      drawForm()
    })
    overlay.querySelector('#gd-del')!.addEventListener('click', () => {
      const victim = working[selected]
      if (!victim) return
      if (!confirm(`Delete "${String(victim.name)}"?`)) return
      snapshot()
      const kept = working.filter((_, i) => i !== selected)
      // Refusing is the useful behaviour here: something still references it,
      // and validateGameDef says what.
      if (!commit(kept)) {
        status.textContent = `cannot delete — ${status.textContent}`
        return
      }
      working = kept
      selected = Math.max(0, selected - 1)
      drawList()
      drawForm()
    })
    overlay.querySelector('#gd-close')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#gd-raw')!.addEventListener('click', () => {
      const raw = document.createElement('div')
      raw.className = 'overlay'
      raw.innerHTML = `<div class="panel" style="width:640px">
        <h1>Raw <span>JSON</span></h1>
        <div class="sub">The map's whole GameDef — resources, damage matrix, abilities,
          victory, and every entity field the form does not show.</div>
        <textarea id="gd-json" spellcheck="false" style="width:100%;height:340px;background:#0e1218;color:#dfe6ee;border:1px solid #2a3342;border-radius:6px;font-family:monospace;font-size:12px;padding:8px"></textarea>
        <div class="row"><button id="gd-apply" class="primary">Apply</button><button id="gd-cancel">Cancel</button></div>
        <div class="status" id="gd-rawstatus"></div></div>`
      document.body.appendChild(raw)
      const ta = raw.querySelector<HTMLTextAreaElement>('#gd-json')!
      ta.value = JSON.stringify(doc.gameDef, null, 2)
      raw.querySelector('#gd-cancel')!.addEventListener('click', () => raw.remove())
      raw.querySelector('#gd-apply')!.addEventListener('click', () => {
        try {
          const gd = JSON.parse(ta.value) as GameDef
          compileGameDef(gd) // throws with a useful message when invalid
          snapshot()
          doc.gameDef = gd
          working = gd.entities.map((e) => entityToForm(e as unknown as Record<string, unknown>))
          selected = Math.min(selected, working.length - 1)
          syncPickers()
          rebuildMarkers()
          autosave()
          raw.remove()
          drawList()
          drawForm()
        } catch (err) {
          raw.querySelector('#gd-rawstatus')!.textContent = String(err)
        }
      })
    })
  })
  // ---- triggers: one form per trigger, raw JSON alongside ----------------
  $('ed-triggers').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:860px">
      <h1>Trig<span>gers</span></h1>
      <div class="sub">When something happens, and conditions hold, do these things.
        Regions come from the ▭ Region tool — draw some first if the list is empty.</div>
      <div class="row" style="margin-bottom:8px">
        <button id="tr-add">+ New trigger</button>
        <button id="tr-dup">Duplicate</button>
        <button id="tr-del">Delete</button>
        <button id="tr-raw">Raw JSON…</button>
      </div>
      <div class="fm-cols">
        <div class="fm-list" id="tr-list"></div>
        <div class="fm-body" id="tr-form"></div>
      </div>
      <div class="row"><button id="tr-close" class="primary">Done</button></div>
      <div class="status" id="tr-status" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const status = overlay.querySelector('#tr-status')!
    const listEl = overlay.querySelector<HTMLElement>('#tr-list')!
    const formEl = overlay.querySelector<HTMLElement>('#tr-form')!
    let selected = 0
    let working = JSON.parse(JSON.stringify(doc.triggers ?? [])) as Record<string, unknown>[]

    // compileTriggers is the same check the sim runs at match start, so a
    // trigger naming a region that does not exist fails here rather than
    // silently never firing.
    const commit = (): boolean => {
      const triggers = cleanTriggers(working) as unknown as RtsMapDoc['triggers']
      try {
        compileTriggers({ ...doc, triggers })
      } catch (err) {
        status.textContent = String(err instanceof Error ? err.message : err)
        return false
      }
      doc.triggers = triggers
      status.textContent = ''
      autosave()
      return true
    }

    const drawList = (): void => {
      listEl.innerHTML = ''
      if (working.length === 0) listEl.innerHTML = '<div class="fm-hint">No triggers yet.</div>'
      working.forEach((t, i) => {
        const b = document.createElement('button')
        const events = ((t.events as Record<string, unknown>[] | undefined) ?? []).map((e) => String(e.type))
        b.textContent = String(t.name ?? t.id ?? '?')
        b.title = events.join(', ')
        if (i === selected) b.classList.add('active')
        b.addEventListener('click', () => {
          selected = i
          drawList()
          drawForm()
        })
        listEl.append(b)
      })
    }
    const drawForm = (): void => {
      formEl.innerHTML = ''
      const t = working[selected]
      if (!t) return
      renderFields(formEl, triggerFields(formCtx()), t, () => {
        if (commit()) drawList()
      })
    }
    drawList()
    drawForm()

    overlay.querySelector('#tr-add')!.addEventListener('click', () => {
      snapshot()
      const n = working.length + 1
      working.push({
        id: `trigger-${n}`,
        name: `Trigger ${n}`,
        events: [{ type: 'mapInit' }],
        conditions: [],
        actions: [{ type: 'message', text: 'Hello', to: 'all' }],
      })
      selected = working.length - 1
      commit()
      drawList()
      drawForm()
    })
    overlay.querySelector('#tr-dup')!.addEventListener('click', () => {
      const src = working[selected]
      if (!src) return
      snapshot()
      const copy = JSON.parse(JSON.stringify(src)) as Record<string, unknown>
      copy.id = `${String(copy.id)}-copy`
      copy.name = `${String(copy.name)} copy`
      working.splice(selected + 1, 0, copy)
      selected++
      commit()
      drawList()
      drawForm()
    })
    overlay.querySelector('#tr-del')!.addEventListener('click', () => {
      if (!working[selected]) return
      snapshot()
      working = working.filter((_, i) => i !== selected)
      selected = Math.max(0, selected - 1)
      commit()
      drawList()
      drawForm()
    })
    overlay.querySelector('#tr-close')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#tr-raw')!.addEventListener('click', () => {
      const raw = document.createElement('div')
      raw.className = 'overlay'
      raw.innerHTML = `<div class="panel" style="width:680px">
        <h1>Raw <span>JSON</span></h1>
        <div class="sub">Events: mapInit, timer, unitDies, unitEntersRegion, resourceReached.
          Actions: spawnUnits, orderUnits, victory, defeat, message, modifyResource, panCamera, setTrigger.
          Regions: ${(doc.regions ?? []).map((r) => r.id).join(', ') || '(none)'}</div>
        <textarea id="tr-json" spellcheck="false" style="width:100%;height:320px;background:#0e1218;color:#dfe6ee;border:1px solid #2a3342;border-radius:6px;font-family:monospace;font-size:12px;padding:8px"></textarea>
        <div class="row"><button id="tr-apply" class="primary">Apply</button><button id="tr-cancel">Cancel</button></div>
        <div class="status" id="tr-rawstatus"></div></div>`
      document.body.appendChild(raw)
      const ta = raw.querySelector<HTMLTextAreaElement>('#tr-json')!
      ta.value = JSON.stringify(doc.triggers ?? [], null, 2)
      raw.querySelector('#tr-cancel')!.addEventListener('click', () => raw.remove())
      raw.querySelector('#tr-apply')!.addEventListener('click', () => {
        try {
          const trigs = JSON.parse(ta.value) as RtsMapDoc['triggers']
          compileTriggers({ ...doc, triggers: trigs }) // validates region names etc.
          snapshot()
          doc.triggers = trigs
          working = JSON.parse(JSON.stringify(trigs ?? [])) as Record<string, unknown>[]
          selected = Math.min(selected, Math.max(0, working.length - 1))
          autosave()
          raw.remove()
          drawList()
          drawForm()
        } catch (err) {
          raw.querySelector('#tr-rawstatus')!.textContent = String(err)
        }
      })
    })
  })

  // ---- players: slots, teams, computer opponents, map size ---------------
  $('ed-players').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:560px">
      <h1>Players <span>and size</span></h1>
      <div class="sub">One slot per start point — drop more with the ⚑ Start point tool.
        Teams decide who is allied and who shares vision. A slot set to a computer
        difficulty plays itself, which is also how a map can own scripted armies.</div>
      <div class="fm-slots" id="pl-slots"></div>
      <hr class="lobby-hr" />
      <div class="sub">Resizing anchors at the top-left corner. Growing adds open ground;
        shrinking crops, and anything left outside is removed rather than shoved to the edge.</div>
      <div class="row">
        <label>Width<input id="pl-cols" type="number" min="4" max="512" /></label>
        <label>Height<input id="pl-rows" type="number" min="4" max="512" /></label>
        <button id="pl-resize">Resize</button>
      </div>
      <div class="row"><button id="pl-close">Close</button></div>
      <div class="status" id="pl-status" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const status = overlay.querySelector('#pl-status')!
    overlay.querySelector('#pl-close')!.addEventListener('click', () => overlay.remove())

    const AI_LABELS = ['Human', 'Computer — easy', 'Computer — normal', 'Computer — hard']
    const drawSlots = (): void => {
      const slots = mapSlotCount(doc)
      const host = overlay.querySelector('#pl-slots')!
      if (doc.startLocations.length === 0) {
        host.innerHTML = '<div class="fm-hint">No start points yet — place some with the ⚑ tool.</div>'
        return
      }
      host.innerHTML = ''
      for (let i = 0; i < slots; i++) {
        const row = document.createElement('div')
        row.className = 'fm-slot'
        const team = doc.slotTeams?.[i] ?? i
        row.innerHTML = `
          <span class="fm-swatch" style="background:#${PLAYER_COLORS[i].getHexString()}"></span>
          <span class="n">Player ${i + 1}</span>
          <select data-team="${i}">${[0, 1, 2, 3, 4, 5, 6, 7]
            .map((t) => `<option value="${t}"${t === team ? ' selected' : ''}>Team ${t + 1}</option>`)
            .join('')}</select>
          <select data-ai="${i}">${AI_LABELS.map(
            (l, lv) => `<option value="${lv}"${lv === (doc.aiLevels?.[i] ?? 0) ? ' selected' : ''}>${l}</option>`,
          ).join('')}</select>`
        host.append(row)
      }
      host.querySelectorAll<HTMLSelectElement>('select[data-team]').forEach((sel) => {
        sel.addEventListener('change', () => {
          snapshot()
          // Written for every slot, not just the edited one: a partial array
          // would leave the rest defaulting to free-for-all, which reads as the
          // teams silently un-setting themselves.
          doc.slotTeams = Array.from({ length: mapSlotCount(doc) }, (_, i) => doc.slotTeams?.[i] ?? i)
          doc.slotTeams[Number(sel.dataset.team)] = Number(sel.value)
          autosave()
          status.textContent = 'teams updated'
        })
      })
      host.querySelectorAll<HTMLSelectElement>('select[data-ai]').forEach((sel) => {
        sel.addEventListener('change', () => {
          snapshot()
          doc.aiLevels = Array.from({ length: mapSlotCount(doc) }, (_, i) => doc.aiLevels?.[i] ?? 0)
          doc.aiLevels[Number(sel.dataset.ai)] = Number(sel.value)
          if (doc.aiLevels.every((v) => v === 0)) doc.aiLevels = undefined
          autosave()
          status.textContent = 'computer opponents updated'
        })
      })
    }
    drawSlots()

    const colsEl = overlay.querySelector<HTMLInputElement>('#pl-cols')!
    const rowsEl = overlay.querySelector<HTMLInputElement>('#pl-rows')!
    colsEl.value = String(doc.cols)
    rowsEl.value = String(doc.rows)
    overlay.querySelector('#pl-resize')!.addEventListener('click', () => {
      const r = resizeMap(doc, Number(colsEl.value), Number(rowsEl.value))
      const lost = [
        r.droppedPlaced && `${r.droppedPlaced} placed unit(s)`,
        r.droppedDoodads && `${r.droppedDoodads} doodad(s)`,
        r.droppedStarts && `${r.droppedStarts} start point(s)`,
        r.droppedRegions && `${r.droppedRegions} region(s)`,
        r.clampedRegions && `${r.clampedRegions} region(s) clipped`,
      ].filter(Boolean)
      if (lost.length > 0 && !confirm(`Resizing loses:\n- ${lost.join('\n- ')}\n\nContinue?`)) return
      snapshot()
      doc = r.doc
      colsEl.value = String(doc.cols)
      rowsEl.value = String(doc.rows)
      cam.setBounds(2, doc.cols - 2, 2, doc.rows - 2)
      rebuildTerrain()
      rebuildMarkers()
      syncPickers()
      drawSlots()
      autosave()
      status.textContent = `resized to ${doc.cols}×${doc.rows}${lost.length ? ` — lost ${lost.join(', ')}` : ''}`
    })
  })

  // ---- rulesets: rules saved once, dropped into any map -------------------
  $('ed-rulesets').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:720px">
      <h1>Rule<span>sets</span></h1>
      <div class="sub">A ruleset is units, their abilities and their models, saved as one file.
        Adding one COPIES it into this map — maps stay self-contained, so nothing here can
        change a map somebody else already balanced.</div>
      <div id="rs-list" style="max-height:280px;overflow:auto;margin:8px 0"></div>
      <div class="row">
        <button id="rs-save">Save this map\u2019s rules\u2026</button>
        <button id="rs-import">Import file\u2026</button>
        <button id="rs-close">Close</button>
      </div>
      <input type="file" id="rs-file" accept=".json" style="display:none" />
      <div class="status" id="rs-status" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const status = overlay.querySelector('#rs-status')!
    const close = (): void => overlay.remove()
    overlay.querySelector('#rs-close')!.addEventListener('click', close)

    const refresh = (): void => {
      void listRulesets().then((installed) => {
        const rows = installed
          .map(
            (r, i) => `<div class="row" style="align-items:baseline;gap:8px;padding:4px 0;border-bottom:1px solid #1d2531">
              <div style="flex:1">
                <b>${r.pack.name}</b>
                <span style="color:#7f8fa2;font-size:12px"> — ${describeRuleset(r.pack)}</span>
              </div>
              <button data-add="${i}" class="primary">Add to map</button>
              <button data-export="${i}">Export</button>
              ${r.builtIn ? '' : `<button data-del="${i}">Delete</button>`}
            </div>`,
          )
          .join('')
        const listEl = overlay.querySelector('#rs-list')!
        listEl.innerHTML = rows || '<div style="color:#7f8fa2">(none saved yet)</div>'
        listEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
          btn.addEventListener('click', () => {
            const add = btn.dataset.add
            const exp = btn.dataset.export
            const del = btn.dataset.del
            if (exp !== undefined) return exportRuleset(installed[Number(exp)].pack)
            if (del !== undefined) {
              const r = installed[Number(del)]
              if (!confirm(`Delete the saved ruleset "${r.pack.name}"?`)) return
              return void deleteRuleset(r.key).then(refresh)
            }
            if (add === undefined) return
            const r = installed[Number(add)]
            try {
              const result = installRuleset(doc, r.pack)
              snapshot()
              doc.gameDef = result.gameDef
              doc.blueprints = result.blueprints
              doc.assets = result.assets
              syncPickers()
              rebuildMarkers()
              autosave()
              status.textContent = `${r.pack.name} added.\n- ${result.notes.join('\n- ')}`
            } catch (err) {
              status.textContent = String(err instanceof Error ? err.message : err)
            }
          })
        })
      })
    }
    refresh()

    overlay.querySelector('#rs-import')!.addEventListener('click', () =>
      overlay.querySelector<HTMLInputElement>('#rs-file')!.click(),
    )
    overlay.querySelector<HTMLInputElement>('#rs-file')!.addEventListener('change', function () {
      const f = this.files?.[0]
      if (!f) return
      void f.text().then((text) => {
        try {
          // Validated before it reaches the shelf, so a bad file fails here
          // rather than halfway through being added to a map.
          const pack = validateRulesetPack(JSON.parse(text))
          void saveRuleset(pack).then(() => {
            status.textContent = `imported "${pack.name}"`
            refresh()
          })
        } catch (err) {
          status.textContent = `import failed: ${String(err instanceof Error ? err.message : err)}`
        }
      })
    })

    overlay.querySelector('#rs-save')!.addEventListener('click', () => {
      if (!doc.gameDef) {
        status.textContent = 'this map has no rules to save yet'
        return
      }
      close()
      openSaveRuleset()
    })
  })

  // Saving picks which entities go in, because "the archers" is a more useful
  // thing to share than "everything on this map". Whatever is ticked brings
  // what it references — a horde ticket brings its soldier — so the result
  // stands up on its own wherever it lands.
  const openSaveRuleset = (): void => {
    const def = doc.gameDef!
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:600px">
      <h1>Save as <span>ruleset</span></h1>
      <div class="sub">Ticked entities bring whatever they reference, plus their abilities
        and their <code>gen:</code> models. Include the rules to make this a complete game
        somebody can start a blank map from; leave it off for an add-on that layers onto
        a map that already has rules.</div>
      <div class="row">
        <input id="rs-id" spellcheck="false" placeholder="id (file name)" style="flex:1" />
        <input id="rs-name" spellcheck="false" placeholder="display name" style="flex:1" />
      </div>
      <div class="row" style="margin:6px 0">
        <label><input type="checkbox" id="rs-base" checked /> include this map\u2019s damage/economy rules</label>
        <button id="rs-all">Tick all</button>
        <button id="rs-none">Tick none</button>
      </div>
      <div id="rs-ents" style="max-height:260px;overflow:auto;border:1px solid #2a3342;border-radius:6px;padding:6px;font-size:13px">
        ${def.entities
          .map(
            (e, i) =>
              `<label style="display:block"><input type="checkbox" data-ent="${i}" checked /> ${e.name}
               <span style="color:#7f8fa2">(${e.id}, ${e.kind})</span></label>`,
          )
          .join('')}
      </div>
      <div class="row"><button id="rs-do" class="primary">Save to shelf</button><button id="rs-cancel">Cancel</button></div>
      <div class="status" id="rs-savestatus" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const idEl = overlay.querySelector<HTMLInputElement>('#rs-id')!
    const nameEl = overlay.querySelector<HTMLInputElement>('#rs-name')!
    idEl.value = `${doc.name || 'map'}-rules`
    nameEl.value = doc.gameDef!.name || doc.name || 'My ruleset'
    const boxes = (): HTMLInputElement[] => [...overlay.querySelectorAll<HTMLInputElement>('input[data-ent]')]
    const setAll = (on: boolean) => (): void => boxes().forEach((b) => (b.checked = on))
    overlay.querySelector('#rs-all')!.addEventListener('click', setAll(true))
    overlay.querySelector('#rs-none')!.addEventListener('click', setAll(false))
    overlay.querySelector('#rs-cancel')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#rs-do')!.addEventListener('click', () => {
      const saveStatus = overlay.querySelector('#rs-savestatus')!
      try {
        const picked = boxes()
          .filter((b) => b.checked)
          .map((b) => def.entities[Number(b.dataset.ent)].id)
        if (picked.length === 0) throw new Error('tick at least one entity')
        const id = idEl.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
        if (!id) throw new Error('give it an id')
        const mod = extractModule({
          id,
          name: nameEl.value.trim() || id,
          version: 1,
          gameDef: def,
          entityIds: picked,
          blueprints: doc.blueprints,
          assets: doc.assets,
        })
        const withBase = overlay.querySelector<HTMLInputElement>('#rs-base')!.checked
        const pack = toPack({ id, name: mod.name, version: 1, base: withBase ? baseOf(def) : undefined }, [mod])
        void saveRuleset(pack).then(() => {
          overlay.remove()
          statusEl.textContent = `saved ruleset "${pack.name}" — ${describeRuleset(pack)}`
        })
      } catch (err) {
        saveStatus.textContent = String(err instanceof Error ? err.message : err)
      }
    })
  }

  // ---- models: visual blueprint editor with a live preview ---------------
  $('ed-assets').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    const starters = Object.keys(GEN_BLUEPRINTS)
      .sort()
      .map((id) => `<option value="${id}">${id}</option>`)
      .join('')
    overlay.innerHTML = `<div class="panel" style="width:940px">
      <h1>Custom <span>models</span></h1>
      <div class="sub">A blueprint is a handful of shapes. It travels inside the map file
        at a few hundred bytes, and can animate its arms and weapon — which uploaded .glb
        models cannot. An id matching a built-in replaces it for this map only. Reference
        one from Game rules as <code>gen:&lt;id&gt;</code>.</div>
      <div class="row" style="margin-bottom:8px">
        <select id="bp-pick" style="flex:2"></select>
        <button id="bp-new">+ New</button>
        <select id="bp-starter" style="flex:1">${starters}</select>
        <button id="bp-copy">Copy built-in</button>
        <button id="bp-del">Delete</button>
        <button id="bp-raw">Raw JSON…</button>
      </div>
      <div class="fm-cols">
        <div class="fm-list" id="bp-parts" style="width:170px"></div>
        <div class="fm-body" id="bp-form"></div>
        <div style="width:250px;flex:none">
          <canvas id="bp-view" width="250" height="250"
            style="width:250px;height:250px;background:#0e1218;border:1px solid #232c39;border-radius:8px"></canvas>
          <div class="fm-group" id="bp-palette"></div>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <button id="as-upload">Upload .glb…</button>
        <button id="as-close" class="primary">Done</button>
      </div>
      <input type="file" id="as-file" accept=".glb" style="display:none" />
      <div class="status" id="as-status" style="white-space:pre-wrap"></div></div>`
    document.body.appendChild(overlay)
    const status = overlay.querySelector('#as-status')!
    const pickEl = overlay.querySelector<HTMLSelectElement>('#bp-pick')!
    const partsEl = overlay.querySelector<HTMLElement>('#bp-parts')!
    const formEl = overlay.querySelector<HTMLElement>('#bp-form')!
    const paletteEl = overlay.querySelector<HTMLElement>('#bp-palette')!

    let working = JSON.parse(JSON.stringify(doc.blueprints ?? [])) as GenBlueprint[]
    let current = 0
    let part = 0

    // ---- preview: a real render of the blueprint, rebuilt on every edit ----
    const canvas = overlay.querySelector<HTMLCanvasElement>('#bp-view')!
    const view = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    view.setPixelRatio(Math.min(2, window.devicePixelRatio))
    const vScene = new THREE.Scene()
    vScene.add(new THREE.HemisphereLight(0xbcd2ff, 0x3a4a30, 1.1))
    const vSun = new THREE.DirectionalLight(0xfff2d9, 1.4)
    vSun.position.set(3, 6, 4)
    vScene.add(vSun)
    const vCam = new THREE.PerspectiveCamera(38, 1, 0.1, 200)
    const vGroup = new THREE.Group()
    vScene.add(vGroup)
    let spin = 0
    let alive = true

    const drawPreview = (): void => {
      vGroup.clear()
      const bp = working[current]
      if (!bp) return
      try {
        for (const g of buildGenGroups(bp, PLAYER_COLORS[0])) {
          vGroup.add(new THREE.Mesh(g.geometry, new THREE.MeshLambertMaterial({ vertexColors: true })))
        }
        // Frame whatever was built, so a two-metre ogre and a half-metre rock
        // both fill the box without the author touching a camera.
        const box = new THREE.Box3().setFromObject(vGroup)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        const reach = Math.max(0.5, Math.max(size.x, size.y, size.z))
        vGroup.position.set(-centre.x, -centre.y, -centre.z)
        vCam.position.set(reach * 1.6, reach * 1.1, reach * 1.6)
        vCam.lookAt(0, 0, 0)
        status.textContent = ''
      } catch (err) {
        status.textContent = `preview failed: ${String(err instanceof Error ? err.message : err)}`
      }
    }
    const spinFrame = (): void => {
      if (!alive) return
      spin += 0.012
      vGroup.rotation.y = spin
      view.render(vScene, vCam)
      requestAnimationFrame(spinFrame)
    }
    spinFrame()

    const commit = (): boolean => {
      try {
        validateBlueprints(working)
      } catch (err) {
        status.textContent = String(err instanceof Error ? err.message : err)
        return false
      }
      doc.blueprints = working.length > 0 ? (JSON.parse(JSON.stringify(working)) as GenBlueprint[]) : undefined
      useMapBlueprints(doc)
      scheduleRebuild()
      autosave()
      return true
    }

    const onEdit = (): void => {
      drawPreview()
      commit()
    }

    const drawPicker = (): void => {
      pickEl.innerHTML = working.map((b, i) => `<option value="${i}">${b.id}</option>`).join('')
      if (working.length === 0) pickEl.innerHTML = '<option value="-1">(no blueprints yet)</option>'
      pickEl.value = String(working.length === 0 ? -1 : current)
    }

    const drawParts = (): void => {
      partsEl.innerHTML = ''
      const bp = working[current]
      if (!bp) return
      const idField = document.createElement('div')
      idField.className = 'fm-field'
      idField.innerHTML = '<span class="fm-label">Blueprint id</span>'
      const idInput = document.createElement('input')
      idInput.value = bp.id
      idInput.addEventListener('input', () => {
        bp.id = idInput.value
        drawPicker()
        onEdit()
      })
      idField.append(idInput)
      partsEl.append(idField)

      bp.parts.forEach((p, i) => {
        const b = document.createElement('button')
        b.textContent = `${i + 1}. ${p.shape} · ${p.color}`
        if (i === part) b.classList.add('active')
        b.addEventListener('click', () => {
          part = i
          drawParts()
          drawPartForm()
        })
        partsEl.append(b)
      })
      const add = document.createElement('button')
      add.textContent = '+ add part'
      add.addEventListener('click', () => {
        snapshot()
        const slot = Object.keys(bp.palette)[0] ?? 'player'
        bp.parts.push({ shape: 'box', color: slot, size: [0.5, 0.5, 0.5], at: [0, 0.5, 0] })
        part = bp.parts.length - 1
        drawParts()
        drawPartForm()
        onEdit()
      })
      partsEl.append(add)
    }

    // The vec3 fields get three inline number boxes rather than a JSON array,
    // which is the difference between nudging a shoulder and typing brackets.
    const vectorRow = (host: HTMLElement, obj: Record<string, unknown>, key: string, label: string): void => {
      const box = document.createElement('div')
      box.className = 'fm-field'
      const head = document.createElement('span')
      head.className = 'fm-label'
      head.textContent = label
      const row = document.createElement('div')
      row.className = 'fm-vec'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = Array.isArray(obj[key])
      toggle.style.width = 'auto'
      const draw = (): void => {
        row.innerHTML = ''
        row.append(toggle)
        const vec = obj[key] as number[] | undefined
        if (!vec) return
        ;[0, 1, 2].forEach((axis) => {
          const n = document.createElement('input')
          n.type = 'number'
          n.step = '0.05'
          n.value = String(vec[axis] ?? 0)
          n.addEventListener('input', () => {
            vec[axis] = Number(n.value)
            onEdit()
          })
          row.append(n)
        })
      }
      toggle.addEventListener('change', () => {
        if (toggle.checked) obj[key] = [0, 0, 0]
        else delete obj[key]
        draw()
        onEdit()
      })
      draw()
      box.append(head, row)
      host.append(box)
    }

    const drawPartForm = (): void => {
      formEl.innerHTML = ''
      const bp = working[current]
      const p = bp?.parts[part] as unknown as Record<string, unknown> | undefined
      if (!bp || !p) return
      const del = document.createElement('button')
      del.textContent = 'Delete this part'
      del.addEventListener('click', () => {
        if (bp.parts.length === 1) {
          status.textContent = 'a blueprint needs at least one part'
          return
        }
        snapshot()
        bp.parts.splice(part, 1)
        part = Math.max(0, part - 1)
        drawParts()
        drawPartForm()
        onEdit()
      })
      formEl.append(del)
      const slots = (): { value: string; label: string }[] => [
        ...Object.keys(bp.palette).map((k) => ({ value: k, label: k })),
        { value: 'player', label: 'player (owner colour)' },
      ]
      renderFields(formEl, partFields(slots), p, () => {
        drawParts()
        onEdit()
      })
      for (const v of PART_VECTORS) vectorRow(formEl, p, v.key, v.label)
    }

    const drawPalette = (): void => {
      paletteEl.innerHTML = '<div class="fm-grouphead"><b>Palette</b></div>'
      const bp = working[current]
      if (!bp) return
      for (const [slot, hex] of Object.entries(bp.palette)) {
        const row = document.createElement('div')
        row.className = 'fm-row'
        const name = document.createElement('input')
        name.value = slot
        const colour = document.createElement('input')
        colour.type = 'color'
        colour.value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#999999'
        name.addEventListener('change', () => {
          const next: Record<string, string> = {}
          for (const [k, v] of Object.entries(bp.palette)) next[k === slot ? name.value : k] = v
          bp.palette = next
          // Parts referencing the old slot name would fail validation, so they
          // follow the rename rather than being orphaned by it.
          for (const pt of bp.parts) if (pt.color === slot) pt.color = name.value
          drawPalette()
          drawParts()
          drawPartForm()
          onEdit()
        })
        colour.addEventListener('input', () => {
          bp.palette[name.value] = colour.value
          onEdit()
        })
        row.append(name, colour)
        paletteEl.append(row)
      }
      const add = document.createElement('button')
      add.textContent = '+ colour'
      add.addEventListener('click', () => {
        bp.palette[`colour${Object.keys(bp.palette).length + 1}`] = '#999999'
        drawPalette()
        onEdit()
      })
      paletteEl.append(add)
    }

    const drawAll = (): void => {
      drawPicker()
      drawParts()
      drawPartForm()
      drawPalette()
      drawPreview()
    }
    drawAll()

    pickEl.addEventListener('change', () => {
      current = Math.max(0, Number(pickEl.value))
      part = 0
      drawAll()
    })
    overlay.querySelector('#bp-new')!.addEventListener('click', () => {
      snapshot()
      working.push({
        id: `model-${working.length + 1}`,
        seed: 1 + working.length,
        palette: { main: '#8a8f96' },
        parts: [{ shape: 'box', color: 'main', size: [0.6, 1.2, 0.6], at: [0, 0.6, 0] }],
      })
      current = working.length - 1
      part = 0
      drawAll()
      commit()
    })
    overlay.querySelector('#bp-copy')!.addEventListener('click', () => {
      const id = overlay.querySelector<HTMLSelectElement>('#bp-starter')!.value
      const src = GEN_BLUEPRINTS[id]
      if (!src) return
      snapshot()
      const copy = JSON.parse(JSON.stringify(src)) as GenBlueprint
      copy.id = working.some((b) => b.id === id) ? `${id}-copy` : id
      working.push(copy)
      current = working.length - 1
      part = 0
      drawAll()
      commit()
      status.textContent = `copied "${id}" as "${copy.id}" — edit it here`
    })
    overlay.querySelector('#bp-del')!.addEventListener('click', () => {
      const bp = working[current]
      if (!bp) return
      if (!confirm(`Delete the model "${bp.id}"?`)) return
      snapshot()
      working = working.filter((_, i) => i !== current)
      current = Math.max(0, current - 1)
      part = 0
      drawAll()
      commit()
    })
    overlay.querySelector('#bp-raw')!.addEventListener('click', () => {
      const raw = document.createElement('div')
      raw.className = 'overlay'
      raw.innerHTML = `<div class="panel" style="width:640px">
        <h1>Raw <span>JSON</span></h1>
        <div class="sub">Every blueprint this map carries.</div>
        <textarea id="bp-json" spellcheck="false" style="width:100%;height:340px;background:#0e1218;color:#dfe6ee;border:1px solid #2a3342;border-radius:6px;font-family:monospace;font-size:12px;padding:8px"></textarea>
        <div class="row"><button id="bp-apply" class="primary">Apply</button><button id="bp-cancel">Cancel</button></div>
        <div class="status" id="bp-rawstatus"></div></div>`
      document.body.appendChild(raw)
      const ta = raw.querySelector<HTMLTextAreaElement>('#bp-json')!
      ta.value = JSON.stringify(working, null, 2)
      raw.querySelector('#bp-cancel')!.addEventListener('click', () => raw.remove())
      raw.querySelector('#bp-apply')!.addEventListener('click', () => {
        try {
          const next = validateBlueprints(JSON.parse(ta.value))
          snapshot()
          working = next
          current = Math.min(current, Math.max(0, working.length - 1))
          part = 0
          raw.remove()
          drawAll()
          commit()
        } catch (err) {
          raw.querySelector('#bp-rawstatus')!.textContent = String(err instanceof Error ? err.message : err)
        }
      })
    })

    overlay.querySelector('#as-close')!.addEventListener('click', () => {
      alive = false // stop the preview loop with the panel
      view.dispose()
      overlay.remove()
    })
    overlay.querySelector('#as-upload')!.addEventListener('click', () =>
      overlay.querySelector<HTMLInputElement>('#as-file')!.click(),
    )
    overlay.querySelector<HTMLInputElement>('#as-file')!.addEventListener('change', function () {
      const f = this.files?.[0]
      if (!f) return
      void f.arrayBuffer().then((buf) => {
        if (buf.byteLength > 4 * 1024 * 1024) {
          status.textContent = 'model too large (4 MB max)'
          return
        }
        const bytes = new Uint8Array(buf)
        let bin = ''
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
        }
        const id = f.name.replace(/\.glb$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
        snapshot()
        doc.assets ??= []
        doc.assets = doc.assets.filter((a) => a.id !== id)
        doc.assets.push({ id, kind: 'glb', bytes: buf.byteLength, sha1: '', data: btoa(bin) })
        autosave()
        status.textContent = `uploaded asset:${id} — assign it in Game rules`
      })
    })
  })

  $('ed-playtest').addEventListener('click', () => {
    const errs = validateMap(doc)
    if (errs.length > 0) {
      statusEl.textContent = `cannot playtest:\n${errs.join('; ')}`
      return
    }
    void idbPut(AUTOSAVE_KEY, JSON.stringify(doc)).then(() => {
      sessionStorage.setItem('bb-playtest', JSON.stringify(doc))
      location.hash = ''
      location.reload()
    })
  })
  $('ed-exit').addEventListener('click', (e) => {
    e.preventDefault()
    location.hash = ''
    location.reload()
  })

  // ---- frame loop ----
  let last = 0
  const frame = (now: number): void => {
    const dt = last === 0 ? 16 : Math.min(100, now - last)
    last = now
    cam.update(dt)
    renderer.render(scene, cam.camera)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  statusEl.textContent = 'left-drag paints · MMB/arrows pan · wheel zoom · Ctrl+Z undo'
}
