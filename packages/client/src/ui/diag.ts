import { VERSION } from '../version.ts'

// Why a match froze is otherwise unanswerable from the outside: every cause
// looks identical from the sofa ("it just stopped"). These are the four, and
// they need different fixes, so the client has to say which one it hit.
//
//   stalled  — no tick bundles arriving: the relay or the connection stopped.
//              Everyone in the room freezes together.
//   behind   — bundles arriving faster than this machine can simulate them.
//              One player freezes; the others play on.
//   crash    — an exception in the frame loop. Without a catch this kills
//              requestAnimationFrame outright and the page dies in silence.
//   desync   — states diverged; already reported and already fatal.

// The top banner is shared with the match-over notices in main.ts. Those are
// final, so once one lands it holds: a stall message must not paint over
// "Connection lost."
let sticky = false

export function banner(text: string | null, opts: { sticky?: boolean } = {}): void {
  const el = document.getElementById('banner')
  if (!el) return
  if (sticky && !opts.sticky) return
  if (opts.sticky) sticky = true
  el.textContent = text ?? ''
  el.style.display = text ? 'block' : 'none'
}

export interface DiagSample {
  slot: number
  tick: number
  /** Bundles waiting to be simulated. Climbing = this machine is losing. */
  queue: number
  /** Time since the last bundle arrived. Climbing = nothing is arriving. */
  bundleAgeMs: number
  fps: number
  frameMs: number
  /** Time spent inside sim steps this frame — the cost that causes `queue`. */
  stepMs: number
  entities: number
  note: string
}

// A few numbers, updated a few times a second. Hidden until F9 — or until
// something goes wrong, because a player watching a frozen screen will not
// think to press a key they were never told about.
export class DiagOverlay {
  private el: HTMLDivElement
  private shown = false
  private forced = false
  private lastPaint = 0

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'diag'
    this.el.style.display = 'none'
    document.body.appendChild(this.el)
    window.addEventListener('keydown', this.onKey)
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'F9') return
    e.preventDefault()
    this.shown = !this.shown
    this.apply()
  }

  private apply(): void {
    this.el.style.display = this.shown || this.forced ? 'block' : 'none'
  }

  /** Trouble shows the panel whether or not the player asked for it. */
  force(on: boolean): void {
    if (this.forced === on) return
    this.forced = on
    this.apply()
  }

  update(now: number, s: DiagSample): void {
    if (!this.shown && !this.forced) return
    if (now - this.lastPaint < 250) return
    this.lastPaint = now
    this.el.textContent =
      `v${VERSION} · slot ${s.slot + 1}\n` +
      `fps ${s.fps.toFixed(0)} · frame ${s.frameMs.toFixed(1)}ms · sim ${s.stepMs.toFixed(1)}ms\n` +
      `tick ${s.tick} · queue ${s.queue} · last bundle ${(s.bundleAgeMs / 1000).toFixed(1)}s ago\n` +
      `entities ${s.entities}` +
      (s.note ? `\n${s.note}` : '')
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey)
    this.el.remove()
  }
}
