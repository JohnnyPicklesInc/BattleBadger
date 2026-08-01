// A tiny schema-driven form builder.
//
// The editor needs visual editors for three unrelated shapes — entity defs,
// triggers, and blueprint parts — and hand-writing three of them would mean
// three places to update every time a field is added to the schema. So the
// forms are DATA too: a descriptor says what the fields are, and one renderer
// turns any descriptor into inputs bound to a plain object.
//
// Deliberately small. It handles the shapes the game's schemas actually use —
// scalars, nested blocks, arrays, and tagged unions — and nothing else.

export type FieldValue = string | number | boolean | undefined

export interface Option {
  value: string
  label: string
}

export type Field =
  | { key: string; label: string; kind: 'text'; placeholder?: string; hint?: string }
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; step?: number; hint?: string }
  | { key: string; label: string; kind: 'checkbox'; hint?: string }
  | { key: string; label: string; kind: 'select'; options: () => Option[]; allowEmpty?: boolean; hint?: string }
  /**
   * A nested object, e.g. an entity's `combat` block. Absent until edited —
   * unless `required`, which drops the remove toggle for blocks the schema
   * insists on, such as an entity's appearance.
   */
  | { key: string; label: string; kind: 'group'; fields: Field[]; required?: boolean; hint?: string }
  /** An array of objects, e.g. `cost`. `make` builds a new element. */
  | { key: string; label: string; kind: 'list'; fields: Field[]; make: () => Record<string, unknown>; hint?: string }
  /**
   * A tagged union: one `tag` property picks which field set applies. This is
   * what trigger events and actions are, and what makes them editable at all
   * without a bespoke screen per variant.
   *
   * An empty `key` means the union IS the object being edited, which is the
   * case for list elements — a trigger's actions are a list OF unions, not a
   * list of objects each holding one.
   */
  | {
      key: string
      label: string
      kind: 'union'
      tag: string
      variants: { value: string; label: string; fields: Field[]; make: () => Record<string, unknown> }[]
      hint?: string
    }

type Obj = Record<string, unknown>

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  return n
}

function labelled(text: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', 'fm-field')
  const name = el('span', 'fm-label')
  name.textContent = text
  wrap.append(name, control)
  if (hint) {
    const h = el('span', 'fm-hint')
    h.textContent = hint
    wrap.append(h)
  }
  return wrap
}

function scalarInput(f: Field, obj: Obj, onChange: () => void): HTMLElement {
  if (f.kind === 'select') {
    const sel = el('select')
    const opts = f.allowEmpty ? [{ value: '', label: '(none)' }, ...f.options()] : f.options()
    sel.innerHTML = opts.map((o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join('')
    sel.value = obj[f.key] === undefined ? '' : String(obj[f.key])
    sel.addEventListener('change', () => {
      if (sel.value === '') delete obj[f.key]
      else obj[f.key] = sel.value
      onChange()
    })
    return sel
  }
  if (f.kind === 'checkbox') {
    const box = el('input')
    box.type = 'checkbox'
    box.checked = obj[f.key] === true
    box.addEventListener('change', () => {
      if (box.checked) obj[f.key] = true
      else delete obj[f.key]
      onChange()
    })
    return box
  }
  const input = el('input')
  input.type = f.kind === 'number' ? 'number' : 'text'
  if (f.kind === 'number') {
    if (f.min !== undefined) input.min = String(f.min)
    if (f.max !== undefined) input.max = String(f.max)
    input.step = String(f.step ?? 1)
  } else if (f.kind === 'text' && f.placeholder !== undefined) {
    input.placeholder = f.placeholder
  }
  input.value = obj[f.key] === undefined ? '' : String(obj[f.key])
  input.addEventListener('input', () => {
    if (input.value === '') {
      // An emptied optional field is REMOVED rather than stored as 0 or "".
      // A stray `damage: 0` reads as a deliberate balance choice; an absent
      // one reads as what it is.
      delete obj[f.key]
    } else {
      obj[f.key] = f.kind === 'number' ? Number(input.value) : input.value
    }
    onChange()
  })
  return input
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;')

/**
 * Render `fields` bound to `obj`, appending into `host`. Edits write straight
 * through to `obj` and then call `onChange` — the caller owns undo snapshots
 * and persistence, because only it knows what a meaningful edit is.
 */
export function renderFields(host: HTMLElement, fields: Field[], obj: Obj, onChange: () => void): void {
  for (const f of fields) {
    if (f.kind === 'group') {
      const box = el('div', 'fm-group')
      const head = el('div', 'fm-grouphead')
      const toggle = el('input')
      toggle.type = 'checkbox'
      toggle.checked = obj[f.key] !== undefined
      const title = el('b')
      title.textContent = f.label
      if (f.required) {
        obj[f.key] ??= {}
        toggle.checked = true
        head.append(title)
      } else {
        head.append(toggle, title)
      }
      if (f.hint) {
        const h = el('span', 'fm-hint')
        h.textContent = f.hint
        head.append(h)
      }
      const body = el('div', 'fm-groupbody')
      const draw = (): void => {
        body.innerHTML = ''
        const inner = obj[f.key] as Obj | undefined
        body.style.display = inner ? '' : 'none'
        if (inner) renderFields(body, f.fields, inner, onChange)
      }
      toggle.addEventListener('change', () => {
        if (toggle.checked) obj[f.key] ??= {}
        else delete obj[f.key]
        draw()
        onChange()
      })
      draw()
      box.append(head, body)
      host.append(box)
      continue
    }

    if (f.kind === 'list') {
      const box = el('div', 'fm-group')
      const head = el('div', 'fm-grouphead')
      const title = el('b')
      title.textContent = f.label
      const add = el('button')
      add.type = 'button'
      add.textContent = '+ add'
      head.append(title, add)
      const body = el('div', 'fm-groupbody')
      const draw = (): void => {
        body.innerHTML = ''
        const arr = (obj[f.key] as Obj[] | undefined) ?? []
        arr.forEach((item, i) => {
          const row = el('div', 'fm-row')
          renderFields(row, f.fields, item, onChange)
          const del = el('button')
          del.type = 'button'
          del.textContent = '✕'
          del.addEventListener('click', () => {
            arr.splice(i, 1)
            if (arr.length === 0) delete obj[f.key]
            draw()
            onChange()
          })
          row.append(del)
          body.append(row)
        })
      }
      add.addEventListener('click', () => {
        const arr = (obj[f.key] as Obj[] | undefined) ?? []
        arr.push(f.make())
        obj[f.key] = arr
        draw()
        onChange()
      })
      draw()
      box.append(head, body)
      host.append(box)
      continue
    }

    if (f.kind === 'union') {
      const inline = f.key === ''
      const box = el('div', 'fm-group')
      const body = el('div', 'fm-groupbody')
      const sel = el('select')
      sel.innerHTML = f.variants.map((v) => `<option value="${escapeAttr(v.value)}">${escapeHtml(v.label)}</option>`).join('')
      const payload = (): Obj => {
        if (inline) return obj
        obj[f.key] ??= {}
        return obj[f.key] as Obj
      }
      const draw = (): void => {
        body.innerHTML = ''
        const tag = String(payload()[f.tag] ?? f.variants[0].value)
        const variant = f.variants.find((v) => v.value === tag) ?? f.variants[0]
        sel.value = variant.value
        payload()[f.tag] = variant.value
        renderFields(body, variant.fields, payload(), onChange)
      }
      sel.addEventListener('change', () => {
        // Switching variant replaces the payload rather than merging: leftover
        // keys from the old shape would ride along invisibly and fail
        // validation somewhere far from here.
        const variant = f.variants.find((v) => v.value === sel.value)!
        const next = { ...variant.make(), [f.tag]: variant.value }
        if (inline) {
          for (const k of Object.keys(obj)) delete obj[k]
          Object.assign(obj, next)
        } else {
          obj[f.key] = next
        }
        draw()
        onChange()
      })
      box.append(labelled(f.label, sel, f.hint), body)
      draw()
      host.append(box)
      continue
    }

    host.append(labelled(f.label, scalarInput(f, obj, onChange), f.hint))
  }
}

/** Options helper: entity ids of a given kind, for the many `def` fields. */
export function idOptions(items: { id: string; name?: string }[]): Option[] {
  return items.map((e) => ({ value: e.id, label: e.name ? `${e.name} (${e.id})` : e.id }))
}
