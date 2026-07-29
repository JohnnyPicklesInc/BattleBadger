import * as THREE from 'three'
import {
  ECON_DEMO_DEF,
  compileGameDef,
  compileTriggers,
  deriveTerrain,
  findPath,
  validateGameDef,
  walkGridFromDoc,
  type FogMode,
  type GameDef,
  type RtsMapDoc,
} from '@battlebadger/sim'
import { RtsCamera } from '../render/camera.ts'
import { buildTerrainMesh } from '../render/terrainMesh.ts'
import { modelGeometry, PLAYER_COLORS } from '../render/unitMeshes.ts'
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
const TEX_NAMES = ['Grass', 'Dirt', 'Rock', 'Sand', 'Snow', 'Dark grass']

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
      const p = findPath(grid, grid.cellX(a.x), grid.cellZ(a.z), grid.cellX(b.x), grid.cellZ(b.z))
      if (!p) errs.push('start locations are not reachable from each other')
    }
  }
  if (doc.gameDef) {
    const ent = new Set(doc.gameDef.entities.map((e) => e.id))
    for (const d of doc.doodads ?? []) if (!ent.has(d.def)) errs.push(`unknown doodad def "${d.def}"`)
    for (const pl of doc.placed ?? []) if (!ent.has(pl.def)) errs.push(`unknown placed def "${pl.def}"`)
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
    const def = doc.gameDef!
    const { heights } = deriveTerrain(doc)
    const hAt = (x: number, z: number): number => {
      const cx = Math.max(0, Math.min(doc.cols - 1, Math.floor(x)))
      const cz = Math.max(0, Math.min(doc.rows - 1, Math.floor(z)))
      return heights[cz * doc.cols + cx]
    }
    for (const d of doc.doodads ?? []) {
      const e = def.entities.find((en) => en.id === d.def)
      if (!e) continue
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
      if (!e) continue
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
      <div class="ed-group"><label>Texture</label><select id="ed-tex"></select></div>
      <div class="ed-group"><label>Doodad</label><select id="ed-doodad"></select></div>
      <div class="ed-group"><label>Entity</label><select id="ed-entity"></select>
        <label>Owner</label><select id="ed-owner"><option value="0">Player 1</option><option value="1">Player 2</option></select></div>
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
  const doodadSel = $<HTMLSelectElement>('ed-doodad')
  const entitySel = $<HTMLSelectElement>('ed-entity')
  const ownerSel = $<HTMLSelectElement>('ed-owner')
  const statusEl = $('ed-status')
  const brushInput = $<HTMLInputElement>('ed-brush')
  brushInput.addEventListener('input', () => ($('ed-brushv').textContent = brushInput.value))

  const syncPickers = (): void => {
    nameInput.value = doc.name
    fogSel.value = doc.fog ?? 'off'
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
      if (doc.startLocations.length >= 2) doc.startLocations.shift()
      doc.startLocations.push({ x: wx, z: wz })
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
      else if (si >= 0) doc.startLocations.splice(si, 1)
      else if (ri >= 0) doc.regions!.splice(ri, 1)
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
  $('ed-gamedef').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:640px">
      <h1>Game <span>rules</span></h1>
      <div class="sub">The map's GameDef as JSON — resources, units, buildings, abilities, victory.</div>
      <textarea id="gd-json" spellcheck="false" style="width:100%;height:340px;background:#0e1218;color:#dfe6ee;border:1px solid #2a3342;border-radius:6px;font-family:monospace;font-size:12px;padding:8px"></textarea>
      <div class="row"><button id="gd-apply" class="primary">Apply</button><button id="gd-cancel">Cancel</button></div>
      <div class="status" id="gd-status"></div></div>`
    document.body.appendChild(overlay)
    const ta = overlay.querySelector<HTMLTextAreaElement>('#gd-json')!
    ta.value = JSON.stringify(doc.gameDef, null, 2)
    overlay.querySelector('#gd-cancel')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#gd-apply')!.addEventListener('click', () => {
      try {
        const gd = JSON.parse(ta.value) as GameDef
        compileGameDef(gd) // throws with a useful message when invalid
        snapshot()
        doc.gameDef = gd
        syncPickers()
        rebuildMarkers()
        autosave()
        overlay.remove()
      } catch (err) {
        overlay.querySelector('#gd-status')!.textContent = String(err)
      }
    })
  })
  $('ed-triggers').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="panel" style="width:680px">
      <h1>Triggers</h1>
      <div class="sub">Event–condition–action JSON. Events: mapInit, timer{seconds,periodic},
        unitDies{owner?,def?}, unitEntersRegion{region,owner?,def?}, resourceReached{owner,resource,amount}.
        Actions: spawnUnits, orderUnits, victory, defeat, message, modifyResource, panCamera, setTrigger.
        Regions: ${(doc.regions ?? []).map((r) => r.id).join(', ') || '(none — draw some with the Region tool)'}</div>
      <textarea id="tr-json" spellcheck="false" style="width:100%;height:320px;background:#0e1218;color:#dfe6ee;border:1px solid #2a3342;border-radius:6px;font-family:monospace;font-size:12px;padding:8px"></textarea>
      <div class="row"><button id="tr-apply" class="primary">Apply</button><button id="tr-cancel">Cancel</button></div>
      <div class="status" id="tr-status"></div></div>`
    document.body.appendChild(overlay)
    const ta = overlay.querySelector<HTMLTextAreaElement>('#tr-json')!
    ta.value = JSON.stringify(doc.triggers ?? [], null, 2)
    overlay.querySelector('#tr-cancel')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#tr-apply')!.addEventListener('click', () => {
      try {
        const trigs = JSON.parse(ta.value) as RtsMapDoc['triggers']
        compileTriggers({ ...doc, triggers: trigs }) // validates region count etc.
        snapshot()
        doc.triggers = trigs
        autosave()
        overlay.remove()
      } catch (err) {
        overlay.querySelector('#tr-status')!.textContent = String(err)
      }
    })
  })

  $('ed-assets').addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    const list = (doc.assets ?? [])
      .map((a) => `<li><code>asset:${a.id}</code> — ${(a.bytes / 1024).toFixed(0)} KB</li>`)
      .join('')
    overlay.innerHTML = `<div class="panel" style="width:520px">
      <h1>Custom <span>models</span></h1>
      <div class="sub">Upload .glb models, then reference them from Game rules as
        <code>"visual": { "model": "asset:&lt;id&gt;" }</code>. Bad or missing models
        fall back to placeholders and can never break a match.</div>
      <ul style="font-size:13px;color:#9fb0c3">${list || '<li>(none)</li>'}</ul>
      <button id="as-upload" class="primary">Upload .glb…</button>
      <button id="as-close">Close</button>
      <input type="file" id="as-file" accept=".glb" style="display:none" />
      <div class="status" id="as-status"></div></div>`
    document.body.appendChild(overlay)
    overlay.querySelector('#as-close')!.addEventListener('click', () => overlay.remove())
    overlay.querySelector('#as-upload')!.addEventListener('click', () =>
      overlay.querySelector<HTMLInputElement>('#as-file')!.click(),
    )
    overlay.querySelector<HTMLInputElement>('#as-file')!.addEventListener('change', function () {
      const f = this.files?.[0]
      if (!f) return
      void f.arrayBuffer().then((buf) => {
        if (buf.byteLength > 4 * 1024 * 1024) {
          overlay.querySelector('#as-status')!.textContent = 'model too large (4 MB max)'
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
        overlay.remove()
        statusEl.textContent = `uploaded asset:${id} — assign it in Game rules`
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
