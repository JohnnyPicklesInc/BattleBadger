// Lockstep guard: the sim package must not use nondeterministic or
// non-bit-exact APIs. Whitelisted math: + - * / Math.sqrt/abs/min/max/floor/imul.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../packages/sim/src', import.meta.url).pathname
const BANNED = [
  'Math.random',
  'Date.now',
  'new Date',
  'performance.now',
  'Math.sin',
  'Math.cos',
  'Math.tan',
  'Math.atan',
  'Math.asin',
  'Math.acos',
  'Math.pow',
  'Math.exp',
  'Math.log',
  'Math.hypot',
  'Math.cbrt',
  'Math.round', // round-half-to-even hazards; use floor
  'toLocale',
]

const failures = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.ts')) {
      const src = readFileSync(p, 'utf8')
      for (const token of BANNED) {
        let idx = src.indexOf(token)
        while (idx !== -1) {
          const line = src.slice(0, idx).split('\n').length
          failures.push(`${p}:${line} uses banned "${token}"`)
          idx = src.indexOf(token, idx + 1)
        }
      }
    }
  }
}
walk(ROOT)

if (failures.length > 0) {
  console.error('sim purity check FAILED:')
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log('sim purity check passed')
