// Deterministic PRNG (sfc32). Integer-only state; safe for lockstep.
export interface Rng {
  a: number
  b: number
  c: number
  d: number
}

// splitmix32 used only to expand a seed into sfc32 state.
export function rngFromSeed(seed: number): Rng {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }
  const r: Rng = { a: next(), b: next(), c: next(), d: next() }
  for (let i = 0; i < 12; i++) rngNext(r)
  return r
}

export function rngNext(r: Rng): number {
  const t = (((r.a + r.b) | 0) + r.d) | 0
  r.d = (r.d + 1) | 0
  r.a = r.b ^ (r.b >>> 9)
  r.b = (r.c + (r.c << 3)) | 0
  r.c = (r.c << 21) | (r.c >>> 11)
  r.c = (r.c + t) | 0
  return t >>> 0
}

export function rngFloat(r: Rng): number {
  return rngNext(r) / 4294967296
}

export function rngInt(r: Rng, n: number): number {
  return rngNext(r) % n
}
