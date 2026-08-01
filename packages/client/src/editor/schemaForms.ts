import type { GameDef, RtsMapDoc } from '@battlebadger/sim'
import { idOptions, type Field, type Option } from './forms.ts'

// Field descriptors for the game's authored shapes. These ARE the visual
// editors — forms.ts renders whatever it is given, so adding a field to an
// entity means adding a line here, not writing a screen.
//
// They cover what an author reaches for, not every key in the schema. The raw
// JSON escape hatch stays next to each one for the long tail (crush levels,
// projectile scatter, expansion rings), so nothing is unreachable — it just
// takes one more click than the common case.

const opt = (values: readonly string[]): Option[] => values.map((v) => ({ value: v, label: v }))

export interface FormContext {
  doc: RtsMapDoc
  def: GameDef
  /** Blueprint ids available for a `gen:` model — the map's plus the built-ins. */
  modelIds: () => Option[]
}

// ---- entities ----------------------------------------------------------

export function entityFields(ctx: FormContext): Field[] {
  const entityOptions = (): Option[] => idOptions(ctx.def.entities)
  const resourceOptions = (): Option[] => ctx.def.resources.map((r) => ({ value: r.id, label: r.name }))

  return [
    { key: 'id', label: 'ID', kind: 'text', hint: 'referenced by triggers, plots and trainers' },
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'kind', label: 'Kind', kind: 'select', options: () => opt(['unit', 'building', 'doodad']) },
    { key: 'hp', label: 'Hit points', kind: 'number', min: 0, hint: 'doodads: 0 = indestructible' },
    { key: 'radius', label: 'Radius', kind: 'number', min: 0, step: 0.05 },
    {
      key: 'visual',
      label: 'Appearance',
      kind: 'group',
      required: true,
      fields: [
        { key: 'model', label: 'Model', kind: 'select', options: ctx.modelIds },
        { key: 'scale', label: 'Scale', kind: 'number', min: 0.1, step: 0.05 },
        { key: 'tint', label: 'Tint', kind: 'select', options: () => opt(['owner', 'none']), allowEmpty: true },
      ],
    },
    {
      key: 'cost',
      label: 'Cost',
      kind: 'list',
      make: () => ({ resource: ctx.def.resources[0]?.id ?? 'res', amount: 100 }),
      fields: [
        { key: 'resource', label: 'Resource', kind: 'select', options: resourceOptions },
        { key: 'amount', label: 'Amount', kind: 'number', min: 0 },
      ],
    },
    { key: 'buildTimeTicks', label: 'Build time (ticks)', kind: 'number', min: 0 },
    { key: 'supplyCost', label: 'Supply cost', kind: 'number', min: 0 },
    { key: 'supplyProvided', label: 'Supply provided', kind: 'number', min: 0 },
    { key: 'armorType', label: 'Armor type', kind: 'select', options: () => opt(ctx.def.armorTypes ?? []), allowEmpty: true },
    { key: 'xpValue', label: 'XP when killed', kind: 'number', min: 0 },
    { key: 'vision', label: 'Vision', kind: 'number', min: 0, step: 0.5 },
    { key: 'flying', label: 'Flying', kind: 'checkbox', hint: 'ignores terrain; only anti-air weapons reach it' },
    {
      key: 'mover',
      label: 'Movement',
      kind: 'group',
      fields: [{ key: 'speed', label: 'Speed (units/sec)', kind: 'number', min: 0, step: 0.1 }],
    },
    {
      key: 'combat',
      label: 'Weapon',
      kind: 'group',
      fields: [
        { key: 'damage', label: 'Damage', kind: 'number', min: 0 },
        { key: 'range', label: 'Range', kind: 'number', min: 0, step: 0.1 },
        { key: 'acquire', label: 'Acquire range', kind: 'number', min: 0, step: 0.5 },
        { key: 'periodTicks', label: 'Cooldown (ticks)', kind: 'number', min: 1 },
        { key: 'damageType', label: 'Damage type', kind: 'select', options: () => opt(ctx.def.damageTypes ?? []), allowEmpty: true },
        {
          key: 'hits',
          label: 'Can hit',
          kind: 'select',
          options: () => opt(['ground', 'air', 'both']),
          allowEmpty: true,
          hint: 'default ground — anti-air is opted into',
        },
        { key: 'splashRadius', label: 'Swing splash', kind: 'number', min: 0, step: 0.1 },
        { key: 'knockback', label: 'Knockback', kind: 'number', min: 0, step: 0.1 },
        { key: 'knockdownTicks', label: 'Knockdown (ticks)', kind: 'number', min: 0 },
      ],
    },
    {
      key: 'horde',
      label: 'Battalion ticket',
      kind: 'group',
      hint: 'trains as one thing, spawns many',
      fields: [
        { key: 'unit', label: 'Soldier', kind: 'select', options: entityOptions },
        { key: 'count', label: 'Count', kind: 'number', min: 1 },
        { key: 'spacing', label: 'Spacing', kind: 'number', min: 0.1, step: 0.1 },
      ],
    },
    {
      key: 'income',
      label: 'Passive income',
      kind: 'group',
      fields: [
        { key: 'resource', label: 'Resource', kind: 'select', options: resourceOptions },
        { key: 'amount', label: 'Amount', kind: 'number', min: 0 },
        { key: 'perTicks', label: 'Every N ticks', kind: 'number', min: 1 },
        { key: 'crowdRadius', label: 'Crowding radius', kind: 'number', min: 0, step: 0.5 },
        { key: 'crowdPenaltyPct', label: 'Crowding penalty %', kind: 'number', min: 0, max: 100 },
      ],
    },
    {
      key: 'trainer',
      label: 'Trains units',
      kind: 'group',
      fields: [
        { key: 'queueSize', label: 'Queue size', kind: 'number', min: 1 },
        { key: 'trains', label: 'Trains (comma-separated ids)', kind: 'text' },
      ],
      // `trains` is a string[] in the schema; the panel converts it — see
      // entityToForm/formToEntity below.
    },
    {
      key: 'plot',
      label: 'Is a build plot',
      kind: 'group',
      fields: [
        { key: 'accepts', label: 'Accepts (comma-separated ids)', kind: 'text' },
        { key: 'neutral', label: 'Any player may claim it', kind: 'checkbox' },
      ],
    },
    {
      key: 'placement',
      label: 'Placement',
      kind: 'select',
      options: () => opt(['free', 'plot']),
      allowEmpty: true,
      hint: 'plot = must be built on a matching build plot',
    },
  ]
}

// The two list-of-ids fields are edited as comma-separated text, because a
// full picker for each would dominate the form. These convert at the edges.
const LIST_FIELDS: [string, string][] = [
  ['trainer', 'trains'],
  ['plot', 'accepts'],
]

type Obj = Record<string, unknown>

/** Copy an entity into a form-shaped object (id lists flattened to text). */
export function entityToForm(e: Obj): Obj {
  const out = JSON.parse(JSON.stringify(e)) as Obj
  for (const [block, key] of LIST_FIELDS) {
    const inner = out[block] as Obj | undefined
    if (inner && Array.isArray(inner[key])) inner[key] = (inner[key] as string[]).join(', ')
  }
  return out
}

/** Convert a form-shaped object back into a real entity def. */
export function formToEntity(form: Obj): Obj {
  const out = JSON.parse(JSON.stringify(form)) as Obj
  for (const [block, key] of LIST_FIELDS) {
    const inner = out[block] as Obj | undefined
    if (!inner) continue
    const raw = inner[key]
    inner[key] = typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : (raw ?? [])
  }
  return out
}

// ---- triggers ----------------------------------------------------------

const ownerField = (label = 'Owner (slot)'): Field => ({ key: 'owner', label, kind: 'number', min: 0, max: 7 })

export function triggerFields(ctx: FormContext): Field[] {
  const regionOptions = (): Option[] => (ctx.doc.regions ?? []).map((r) => ({ value: r.id, label: r.name }))
  const defOptions = (): Option[] => idOptions(ctx.def.entities)
  const resourceOptions = (): Option[] => ctx.def.resources.map((r) => ({ value: r.id, label: r.name }))
  const cmp = (): Option[] => [
    { value: '>=', label: 'at least' },
    { value: '<=', label: 'at most' },
  ]

  return [
    { key: 'id', label: 'ID', kind: 'text' },
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'once', label: 'Fire only once', kind: 'checkbox' },
    {
      key: 'initiallyOn',
      label: 'Starts enabled',
      kind: 'checkbox',
      hint: 'leave ticked unless another trigger switches it on',
    },
    {
      key: 'events',
      label: 'When (any of)',
      kind: 'list',
      make: () => ({ type: 'mapInit' }),
      fields: [{
      key: '',
      label: 'Event',
      kind: 'union',
      tag: 'type',
      variants: [
        { value: 'mapInit', label: 'the map starts', fields: [], make: () => ({}) },
        {
          value: 'timer',
          label: 'a timer fires',
          make: () => ({ seconds: 60 }),
          fields: [
            { key: 'seconds', label: 'Seconds', kind: 'number', min: 0 },
            { key: 'periodic', label: 'Repeat', kind: 'checkbox' },
          ],
        },
        {
          value: 'unitDies',
          label: 'a unit dies',
          make: () => ({}),
          fields: [
            { key: 'def', label: 'Which unit', kind: 'select', options: defOptions, allowEmpty: true },
            ownerField('Belonging to slot (blank = any)'),
          ],
        },
        {
          value: 'unitEntersRegion',
          label: 'a unit enters a region',
          make: () => ({ region: ctx.doc.regions?.[0]?.id ?? '' }),
          fields: [
            { key: 'region', label: 'Region', kind: 'select', options: regionOptions },
            { key: 'def', label: 'Which unit', kind: 'select', options: defOptions, allowEmpty: true },
            ownerField('Belonging to slot (blank = any)'),
          ],
        },
        {
          value: 'resourceReached',
          label: 'a player reaches a resource total',
          make: () => ({ owner: 0, resource: ctx.def.resources[0]?.id ?? 'res', amount: 1000 }),
          fields: [
            ownerField(),
            { key: 'resource', label: 'Resource', kind: 'select', options: resourceOptions },
            { key: 'amount', label: 'Amount', kind: 'number', min: 0 },
          ],
        },
      ],
      }],
    },
    {
      key: 'conditions',
      label: 'Only if',
      kind: 'list',
      make: () => ({ type: 'elapsed', seconds: 60 }),
      fields: [
        {
          key: '',
          label: 'Condition',
          kind: 'union',
          tag: 'type',
          variants: [
            {
              value: 'elapsed',
              label: 'game time has passed',
              make: () => ({ seconds: 60 }),
              fields: [{ key: 'seconds', label: 'Seconds', kind: 'number', min: 0 }],
            },
            {
              value: 'resourceCmp',
              label: 'a player has resources',
              make: () => ({ owner: 0, resource: ctx.def.resources[0]?.id ?? 'res', op: '>=', amount: 500 }),
              fields: [
                ownerField(),
                { key: 'resource', label: 'Resource', kind: 'select', options: resourceOptions },
                { key: 'op', label: 'Comparison', kind: 'select', options: cmp },
                { key: 'amount', label: 'Amount', kind: 'number', min: 0 },
              ],
            },
            {
              value: 'unitCountInRegion',
              label: 'units are in a region',
              make: () => ({ region: ctx.doc.regions?.[0]?.id ?? '', op: '>=', count: 1 }),
              fields: [
                { key: 'region', label: 'Region', kind: 'select', options: regionOptions },
                ownerField('Belonging to slot (blank = any)'),
                { key: 'op', label: 'Comparison', kind: 'select', options: cmp },
                { key: 'count', label: 'Count', kind: 'number', min: 0 },
              ],
            },
          ],
        },
      ],
    },
    {
      key: 'actions',
      label: 'Then',
      kind: 'list',
      make: () => ({ type: 'message', text: 'Hello', to: 'all' }),
      fields: [
        {
          key: '',
          label: 'Action',
          kind: 'union',
          tag: 'type',
          variants: [
            {
              value: 'spawnUnits',
              label: 'spawn units',
              make: () => ({ def: ctx.def.entities[0]?.id ?? '', owner: 0, count: 1, at: { x: 0, z: 0 } }),
              fields: [
                { key: 'def', label: 'Unit', kind: 'select', options: defOptions },
                ownerField(),
                { key: 'count', label: 'Count', kind: 'number', min: 1 },
                {
                  key: 'always',
                  label: 'Even with no human in that slot',
                  kind: 'checkbox',
                  hint: 'needed for AI-owned content such as lane creeps',
                },
                {
                  key: 'at',
                  label: 'Where',
                  kind: 'group',
                  hint: 'set x/z, or a region name instead',
                  fields: [
                    { key: 'x', label: 'X', kind: 'number', step: 0.5 },
                    { key: 'z', label: 'Z', kind: 'number', step: 0.5 },
                    { key: 'region', label: 'Region', kind: 'select', options: regionOptions, allowEmpty: true },
                  ],
                },
              ],
            },
            {
              value: 'orderUnits',
              label: 'order units in a region',
              make: () => ({ region: ctx.doc.regions?.[0]?.id ?? '', order: 'attackMove', x: 0, z: 0 }),
              fields: [
                { key: 'region', label: 'Region', kind: 'select', options: regionOptions },
                ownerField('Belonging to slot (blank = any)'),
                { key: 'order', label: 'Order', kind: 'select', options: () => opt(['move', 'attackMove']) },
                { key: 'x', label: 'Target X', kind: 'number', step: 0.5 },
                { key: 'z', label: 'Target Z', kind: 'number', step: 0.5 },
              ],
            },
            {
              value: 'message',
              label: 'show a message',
              make: () => ({ text: '', to: 'all' }),
              fields: [
                { key: 'text', label: 'Text', kind: 'text' },
                { key: 'to', label: 'To (slot or "all")', kind: 'text' },
              ],
            },
            {
              value: 'modifyResource',
              label: 'give or take resources',
              make: () => ({ owner: 0, resource: ctx.def.resources[0]?.id ?? 'res', delta: 100 }),
              fields: [
                ownerField(),
                { key: 'resource', label: 'Resource', kind: 'select', options: resourceOptions },
                { key: 'delta', label: 'Change', kind: 'number', hint: 'negative takes it away' },
              ],
            },
            {
              value: 'victory',
              label: 'a player wins',
              make: () => ({ player: 0 }),
              fields: [{ key: 'player', label: 'Slot', kind: 'number', min: 0, max: 7 }],
            },
            {
              value: 'defeat',
              label: 'a player loses',
              make: () => ({ player: 0 }),
              fields: [{ key: 'player', label: 'Slot', kind: 'number', min: 0, max: 7 }],
            },
            {
              value: 'panCamera',
              label: 'pan a player’s camera',
              make: () => ({ player: 0, x: 0, z: 0 }),
              fields: [
                { key: 'player', label: 'Slot', kind: 'number', min: 0, max: 7 },
                { key: 'x', label: 'X', kind: 'number', step: 0.5 },
                { key: 'z', label: 'Z', kind: 'number', step: 0.5 },
              ],
            },
            {
              value: 'setTrigger',
              label: 'enable or disable another trigger',
              make: () => ({ trigger: '', on: true }),
              fields: [
                { key: 'trigger', label: 'Trigger id', kind: 'text' },
                { key: 'on', label: 'Enabled', kind: 'checkbox' },
              ],
            },
          ],
        },
      ],
    },
  ]
}

// `spawnUnits.at` is `{x,z} | {region}` in the schema but one group in the
// form, so the unused half is stripped on the way out.
export function cleanTriggers(triggers: Obj[]): Obj[] {
  const out = JSON.parse(JSON.stringify(triggers)) as Obj[]
  for (const t of out) {
    for (const a of (t.actions as Obj[] | undefined) ?? []) {
      if (a.type !== 'spawnUnits') continue
      const at = a.at as Obj | undefined
      if (!at) continue
      if (typeof at.region === 'string' && at.region !== '') a.at = { region: at.region }
      else a.at = { x: Number(at.x ?? 0), z: Number(at.z ?? 0) }
    }
    t.conditions ??= []
    t.actions ??= []
    t.events ??= []
    if (t.initiallyOn === undefined) t.initiallyOn = true
  }
  return out
}

// ---- blueprint parts ---------------------------------------------------

export function partFields(paletteSlots: () => Option[]): Field[] {
  return [
    {
      key: 'shape',
      label: 'Shape',
      kind: 'select',
      options: () => opt(['box', 'cylinder', 'cone', 'sphere', 'capsule', 'lathe']),
    },
    { key: 'color', label: 'Colour', kind: 'select', options: paletteSlots },
    {
      key: 'group',
      label: 'Animation group',
      kind: 'select',
      options: () => opt(['body', 'armL', 'armR', 'weapon']),
      allowEmpty: true,
      hint: 'body is the default; arms swing, weapon fires',
    },
    { key: 'radius', label: 'Radius', kind: 'number', min: 0, step: 0.05 },
    { key: 'radiusTop', label: 'Top radius (cylinder taper)', kind: 'number', min: 0, step: 0.05 },
    { key: 'height', label: 'Height', kind: 'number', min: 0, step: 0.05 },
    { key: 'segments', label: 'Segments', kind: 'number', min: 3, max: 64 },
    { key: 'jitter', label: 'Surface wobble', kind: 'number', min: 0, step: 0.01 },
    { key: 'count', label: 'Copies', kind: 'number', min: 1, hint: 'scatter N seeded copies' },
    { key: 'tilt', label: 'Random lean per copy', kind: 'number', min: 0, step: 0.05 },
    { key: 'sizeJitter', label: 'Size variation per copy', kind: 'number', min: 0, step: 0.05 },
  ]
}

/** The vec3 fields, edited as three numbers each rather than a JSON array. */
export const PART_VECTORS: { key: string; label: string }[] = [
  { key: 'size', label: 'Size (box)' },
  { key: 'at', label: 'Position' },
  { key: 'rot', label: 'Rotation (radians)' },
  { key: 'scale', label: 'Scale' },
  { key: 'spread', label: 'Scatter spread' },
  { key: 'pivot', label: 'Hinge (animation groups)' },
]
