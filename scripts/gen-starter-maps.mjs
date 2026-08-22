// Generates the starter maps served from /maps/ (client/public/maps/).
// Run: node scripts/gen-starter-maps.mjs   (Node 24 strips TS types natively)
import { mkdirSync, writeFileSync } from 'node:fs'
import { generateMiddleEarth } from '../packages/sim/src/mapgen/middleEarth.ts'
import { generateSquadSupport } from '../packages/sim/src/mapgen/squadSupport.ts'
import { mapContentHash } from '../packages/sim/src/hash.ts'

const OUT = new URL('../packages/client/public/maps/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const maps = [
  {
    file: 'middle-earth.json',
    name: 'The War of the Ring (muster camps & ages, 2–8 players)',
    doc: generateMiddleEarth(20260803),
  },
  {
    file: 'squad-support.json',
    name: 'Squad Support (co-op — a CPU commander, six squads, 1–6 players)',
    doc: generateSquadSupport(20260809),
  },
]

// The manifest records each map's CONTENT hash, not just its filename. A
// client can verify what it loaded is what was baked, and packages/sim's
// mapIdentity test fails the build when a def changed without a re-bake.
const index = []
for (const m of maps) {
  writeFileSync(OUT + m.file, JSON.stringify(m.doc))
  const hash = mapContentHash(m.doc)
  index.push({ file: m.file, name: m.name, mapName: m.doc.name, hash })
  console.log('wrote', m.file, '\thash', hash.toString(16).padStart(8, '0'))
}
writeFileSync(OUT + 'index.json', JSON.stringify(index, null, 2))
console.log('wrote index.json')
