#!/usr/bin/env node
// Move the build version on by one thousandth: 0.0.7 → 0.0.8, and 0.0.999 →
// 0.1.0 rather than 0.0.1000.
//
// Writes both the root package.json and packages/client/src/version.ts, which
// is what the client shows and what the lobby compares between players — so
// two people on different builds find out while reloading is still free,
// instead of ten seconds into a match as a desync.
import { readFileSync, writeFileSync } from 'node:fs'

const pkgPath = new URL('../package.json', import.meta.url)
const verPath = new URL('../packages/client/src/version.ts', import.meta.url)

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [major, minor, patch] = String(pkg.version).split('.').map(Number)
if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
  console.error(`version "${pkg.version}" is not x.y.z — fix it by hand`)
  process.exit(1)
}

const next = patch + 1 > 999 ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

const src = readFileSync(verPath, 'utf8')
const bumped = src.replace(/export const VERSION = '[^']*'/, `export const VERSION = '${next}'`)
if (bumped === src) {
  console.error(`could not find the VERSION constant in ${verPath.pathname}`)
  process.exit(1)
}
writeFileSync(verPath, bumped)

console.log(next)
