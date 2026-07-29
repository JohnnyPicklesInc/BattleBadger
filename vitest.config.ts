import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // These are simulation tests: several run two full sims for thousands of
    // ticks with standing armies, siege shells and cavalry charges in flight.
    // Vitest's 5s default is far too tight for that and made whichever test
    // happened to be slowest under parallel load flake — always a timeout,
    // never a failed assertion.
    testTimeout: 30_000,
  },
})
