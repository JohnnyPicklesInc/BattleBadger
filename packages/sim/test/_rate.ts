import { TICK_MS } from '../src/state.ts'

/**
 * A duration these tests were authored in, converted to the running tick rate.
 *
 * Every test here was written against a 10 Hz clock and counts TICKS — "run 300
 * ticks" meaning thirty seconds of game time. Raising the tick rate made that
 * arithmetic wrong everywhere at once: 300 ticks became ten seconds, farms paid
 * out a third as often, and riders never crossed the ground to their target.
 * Thirty-seven tests failed and not one of them had found a bug.
 *
 * So durations go through here. The number at the call site still reads as the
 * tick count the test was written with; what it means is a length of GAME TIME,
 * and the suite stops caring what the tick rate is.
 */
export const t10 = (ticks: number): number => Math.round((ticks * 100) / TICK_MS)

/** The same thing said in seconds, for new tests. Prefer this one. */
export const secs = (seconds: number): number => Math.round((seconds * 1000) / TICK_MS)
