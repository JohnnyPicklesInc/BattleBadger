// Software cursor + Pointer Lock mouse capture. While captured, the OS cursor
// is hidden/confined and we track a virtual cursor from movement deltas —
// so edge scrolling works like a native RTS and the mouse can't leave the
// window. All input reads cursor.x/y instead of event clientX/Y.
const cursorSvg = (fill: string): string =>
  `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
  <path d="M2 1 L2 16 L6.2 12.6 L9 19 L11.6 17.9 L8.8 11.7 L14 11.2 Z"
    fill="${fill}" stroke="#10141a" stroke-width="1.4" stroke-linejoin="round"/></svg>`

// WC3-style contextual cursor tints.
const HINT_COLORS: Record<string, string> = {
  ground: '#f2f5f9',
  ally: '#7ee787',
  enemy: '#ff6a5a',
  resource: '#ffd75e',
  target: '#ffe27a',
  build: '#6fb7ff',
}

// When the OS cursor is showing (not pointer-locked) we can still signal
// context through the native cursor shape.
function nativeCursor(hint: string): string {
  if (hint === 'enemy' || hint === 'target') return 'crosshair'
  if (hint === 'ally' || hint === 'resource' || hint === 'build') return 'pointer'
  return 'default'
}

export class MouseCursor {
  x = window.innerWidth / 2
  y = window.innerHeight / 2
  inWindow = true
  // Capture is only requested while a match is running.
  enabled = false
  private target: HTMLElement
  private el: HTMLDivElement

  private hint = 'ground'

  // Tint the cursor by what it's over (ally green, enemy red, resource gold…).
  setHint(hint: string): void {
    if (hint === this.hint) return
    this.hint = hint
    this.el.innerHTML = cursorSvg(HINT_COLORS[hint] ?? HINT_COLORS.ground)
    this.target.style.cursor = this.locked ? 'none' : nativeCursor(hint)
  }

  constructor(target: HTMLElement) {
    this.target = target
    this.el = document.createElement('div')
    this.el.id = 'swcursor'
    this.el.innerHTML = cursorSvg(HINT_COLORS.ground)
    document.body.appendChild(this.el)

    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.x = Math.max(0, Math.min(window.innerWidth - 1, this.x + e.movementX))
        this.y = Math.max(0, Math.min(window.innerHeight - 1, this.y + e.movementY))
      } else {
        this.x = e.clientX
        this.y = e.clientY
      }
      this.el.style.transform = `translate(${this.x}px, ${this.y}px)`
    })
    document.addEventListener('mouseleave', () => {
      this.inWindow = false
    })
    document.addEventListener('mouseenter', () => {
      this.inWindow = true
    })
    document.addEventListener('pointerlockchange', () => {
      this.el.style.display = this.locked ? 'block' : 'none'
      this.el.style.transform = `translate(${this.x}px, ${this.y}px)`
    })
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target
  }

  // Edge scrolling is meaningful when captured, or when the OS cursor is
  // inside the window.
  get active(): boolean {
    return this.locked || this.inWindow
  }

  capture(): void {
    if (!this.enabled || this.locked) return
    try {
      // Returns a promise in modern browsers; rejection (e.g. right after an
      // Esc exit) is expected and harmless — the next click re-captures.
      const p = this.target.requestPointerLock() as unknown as Promise<void> | undefined
      p?.catch(() => {})
    } catch {
      // unsupported browser — game still works with a normal cursor
    }
  }

  release(): void {
    if (this.locked) document.exitPointerLock()
  }

  destroy(): void {
    this.release()
    this.el.remove()
  }
}
