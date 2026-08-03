// The screen a match shows when it is not running: waiting for someone who
// dropped, replaying the backlog after coming back, or fighting to reconnect.
//
// A frozen picture with no explanation is the thing this whole area of the
// code exists to prevent, so every one of these states says what it is waiting
// for and — where the player has a choice — offers it.

export interface HoldActions {
  kick(slot: number): void
}

export class HoldOverlay {
  private el: HTMLDivElement
  private body: HTMLDivElement
  private actions: HoldActions
  private countdownTo = 0
  private slots: number[] = []
  private names: (string | null)[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(actions: HoldActions) {
    this.actions = actions
    this.el = document.createElement('div')
    this.el.className = 'overlay'
    this.el.id = 'hold-overlay'
    this.el.style.display = 'none'
    this.el.innerHTML = `<div class="panel hold-panel"><div id="hold-body"></div></div>`
    document.body.appendChild(this.el)
    this.body = this.el.querySelector<HTMLDivElement>('#hold-body')!
    this.el.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button[data-kick]')
      if (!btn) return
      this.actions.kick(Number((btn as HTMLElement).dataset.kick))
    })
  }

  private show(html: string): void {
    this.body.innerHTML = html
    this.el.style.display = 'flex'
  }

  hide(): void {
    this.el.style.display = 'none'
    this.stopCountdown()
  }

  /** Players the room is holding for, with the option to stop holding. */
  waitingFor(slots: number[], names: (string | null)[], untilMs: number): void {
    this.slots = slots
    this.names = names
    this.countdownTo = Date.now() + untilMs
    this.paint()
    this.startCountdown()
  }

  private paint(): void {
    const left = Math.max(0, Math.round((this.countdownTo - Date.now()) / 1000))
    const who = this.slots.map((s, i) => this.names[i] ?? `Player ${s + 1}`)
    const label = who.length === 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`
    this.show(
      `<h1>Waiting for ${esc(label)}</h1>
       <div class="sub">They dropped out and have <b>${left}s</b> to get back in. The match is
         paused for everyone — nobody is losing units while they are away.</div>
       ${this.slots
         .map(
           (s, i) =>
             `<button data-kick="${s}">Kick ${esc(this.names[i] ?? `Player ${s + 1}`)} and play on</button>`,
         )
         .join('')}`,
    )
  }

  private startCountdown(): void {
    this.stopCountdown()
    this.timer = setInterval(() => this.paint(), 1000)
  }

  private stopCountdown(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Replaying the match to reach the present. */
  catchingUp(done: number, total: number): void {
    this.stopCountdown()
    const pct = total <= 0 ? 100 : Math.min(100, Math.round((done / total) * 100))
    this.show(
      `<h1>Catching up…</h1>
       <div class="sub">Replaying the match from the start — ${pct}% (tick ${done} of ${total}).
         Everyone else is paused until this finishes.</div>
       <div class="holdbar"><i style="width:${pct}%"></i></div>`,
    )
  }

  reconnecting(attempt: number): void {
    this.stopCountdown()
    this.show(
      `<h1>Reconnecting…</h1>
       <div class="sub">Lost the connection to the room — trying to get your seat back
         (attempt ${attempt}). The match is holding for you.</div>`,
    )
  }

  destroy(): void {
    this.stopCountdown()
    this.el.remove()
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
