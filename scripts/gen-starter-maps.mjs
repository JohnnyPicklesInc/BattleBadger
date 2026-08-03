// Generates the starter maps served from /maps/ (client/public/maps/).
// Run: node scripts/gen-starter-maps.mjs   (Node 24 strips TS types natively)
import { mkdirSync, writeFileSync } from 'node:fs'
import { generateCerebrateWar } from '../packages/sim/src/mapgen/cerebrateWar.ts'
import { generateDunhollow } from '../packages/sim/src/mapgen/dunhollow.ts'
import { generateEconDemo } from '../packages/sim/src/mapgen/econDemo.ts'
import { generateChargeField } from '../packages/sim/src/mapgen/chargeField.ts'
import { generateTrollPit } from '../packages/sim/src/mapgen/trollPit.ts'
import { generateFourCorners } from '../packages/sim/src/mapgen/fourCorners.ts'
import { generateRidgeCrossing } from '../packages/sim/src/mapgen/skirmishRidge.ts'
import { generateLastAlliance } from '../packages/sim/src/mapgen/lastAlliance.ts'
import { generateMiddleEarth } from '../packages/sim/src/mapgen/middleEarth.ts'
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
    file: 'cerebrate-war.json',
    name: 'Cerebrate War (3-lane MOBA, 2–8 players)',
    doc: generateCerebrateWar(20260726),
  },
  {
    file: 'dunhollow.json',
    name: 'Siege of Dunhollow (plots, hordes & formations, 2–4 players)',
    doc: generateDunhollow(20260727),
  },
  {
    file: 'four-corners.json',
    name: 'Four Corners (4-player FFA, mountains & a contested centre)',
    doc: generateFourCorners(20260729),
  },
  {
    file: 'last-alliance.json',
    name: 'The Last Alliance (4v4 siege — west vs east, fortress at each end)',
    doc: generateLastAlliance(20260731),
  },
  {
    file: 'ridge-crossing.json',
    name: 'Ridge Crossing (Badgers vs the Compact — air, 2 players)',
    doc: generateRidgeCrossing(20260730),
  },
  {
    file: 'charge-field.json',
    name: 'The Charge (50 horse vs a shield wall — battle test)',
    doc: generateChargeField(20260729),
  },
  {
    file: 'troll-pit.json',
    name: 'The Pit (one ogre vs a mob — battle test)',
    doc: generateTrollPit(20260729),
  },
  {
    file: 'econ-demo.json',
    name: 'Economy Demo (gold & lumber)',
    doc: generateEconDemo(20260726),
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
