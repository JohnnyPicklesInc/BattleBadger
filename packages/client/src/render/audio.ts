// Battle sound, synthesised rather than sampled.
//
// Everything else in this game is generated — the meshes, the maps, the models
// — and audio has no reason to be the exception. A bow is a filtered noise
// burst with a fast decay; a catapult impact is a low sine that slides down
// under a noise transient. That is a few hundred bytes of code instead of a few
// megabytes of samples, and it means a new sound is a new function rather than
// a new asset pipeline.
//
// Render-only, like every other effect: the sim has already decided who died.

export type Sfx =
  | 'bow' // an arrow loosed
  | 'melee' // blades meeting
  | 'siege' // a shell landing
  | 'death' // a body hitting the ground
  | 'gate' // the great gate working
  | 'chime' // research finished

interface Voice {
  kind: Sfx
  x: number
  z: number
}

// Rough ceilings, per frame. A siege with two hundred archers would otherwise
// try to start a hundred voices in one frame, which crackles and pins a core.
const PER_FRAME: Record<Sfx, number> = {
  bow: 4,
  melee: 3,
  siege: 3,
  death: 3,
  gate: 2,
  chime: 1,
}

// How far away a sound is still worth starting at all.
const EARSHOT = 90

export class BattleAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private queue: Voice[] = []
  private muted = false
  private volume = 0.5

  /**
   * Browsers refuse to start audio without a gesture, so the context is created
   * on the first click or key and never before. Until then every request is
   * dropped rather than queued — a battle that happened while the tab was
   * silent should not all arrive at once when it wakes.
   */
  constructor() {
    const unlock = (): void => {
      if (this.ctx) return
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : this.volume
      this.master.connect(this.ctx.destination)
      // One second of white noise, reused by every percussive sound.
      const len = this.ctx.sampleRate
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = buf.getChannelData(0)
      let seed = 22222
      for (let i = 0; i < len; i++) {
        // A fixed generator, so the grain of the noise is the same every run.
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        data[i] = (seed / 2147483648 - 1) * 0.7
      }
      this.noise = buf
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
  }

  setMuted(on: boolean): void {
    this.muted = on
    if (this.master) this.master.gain.value = on ? 0 : this.volume
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.master && !this.muted) this.master.gain.value = this.volume
  }

  get enabled(): boolean {
    return this.ctx !== null && !this.muted
  }

  /** Ask for a sound at a world position. Cheap; the mixing happens in flush. */
  emit(kind: Sfx, x: number, z: number): void {
    if (!this.ctx || this.muted) return
    if (this.queue.length > 64) return
    this.queue.push({ kind, x, z })
  }

  /**
   * Start the frame's sounds, nearest first and capped per kind. Called once
   * per rendered frame with wherever the camera is looking, which is the only
   * sensible listener position for a game with no avatar.
   */
  flush(listenerX: number, listenerZ: number): void {
    const ctx = this.ctx
    if (!ctx || this.muted || this.queue.length === 0) {
      this.queue.length = 0
      return
    }
    const budget: Record<string, number> = {}
    // Nearest first, so when the cap bites it drops the distant half of a
    // battle rather than an arbitrary half.
    this.queue.sort(
      (a, b) =>
        (a.x - listenerX) ** 2 + (a.z - listenerZ) ** 2 - ((b.x - listenerX) ** 2 + (b.z - listenerZ) ** 2),
    )
    for (const v of this.queue) {
      const dx = v.x - listenerX
      const dz = v.z - listenerZ
      const dist = Math.hypot(dx, dz)
      if (dist > EARSHOT) continue
      budget[v.kind] = (budget[v.kind] ?? 0) + 1
      if (budget[v.kind] > PER_FRAME[v.kind]) continue
      // Linear falloff is wrong physics and right for a game: it keeps the
      // far edge of a battle audible instead of inaudible.
      const gain = 1 - dist / EARSHOT
      this.strike(v.kind, gain * gain, Math.max(-1, Math.min(1, dx / 40)))
    }
    this.queue.length = 0
  }

  // ---- the synth ------------------------------------------------------

  private strike(kind: Sfx, gain: number, pan: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const out = ctx.createGain()
    out.gain.value = gain
    const panner = ctx.createStereoPanner?.()
    if (panner) {
      panner.pan.value = pan
      out.connect(panner)
      panner.connect(this.master!)
    } else {
      out.connect(this.master!)
    }

    switch (kind) {
      case 'bow': {
        // A short, bright hiss that falls away: the string, not the flight.
        this.burst(out, t, 0.09, 2600, 'bandpass', 0.5)
        break
      }
      case 'melee': {
        // Two metallic transients a hair apart, so it reads as a clash rather
        // than a click.
        this.burst(out, t, 0.05, 3800, 'bandpass', 0.45)
        this.burst(out, t + 0.02, 0.07, 2200, 'bandpass', 0.35)
        break
      }
      case 'siege': {
        // A body: low sine sliding down, with a noise transient over the top.
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(140, t)
        osc.frequency.exponentialRampToValueAtTime(38, t + 0.45)
        g.gain.setValueAtTime(0.9, t)
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
        osc.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 0.5)
        this.burst(out, t, 0.16, 900, 'lowpass', 0.6)
        break
      }
      case 'death': {
        this.burst(out, t, 0.13, 420, 'lowpass', 0.45)
        break
      }
      case 'gate': {
        // Timber and iron: a slow low grind rather than a hit.
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(70, t)
        osc.frequency.linearRampToValueAtTime(48, t + 0.7)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 320
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.12)
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.8)
        osc.connect(lp)
        lp.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 0.8)
        break
      }
      case 'chime': {
        // Research done. Two notes, so it is unmistakably not a weapon.
        for (const [i, f] of [523.25, 783.99].entries()) {
          const osc = ctx.createOscillator()
          const g = ctx.createGain()
          osc.type = 'triangle'
          osc.frequency.value = f
          const at = t + i * 0.12
          g.gain.setValueAtTime(0.0001, at)
          g.gain.exponentialRampToValueAtTime(0.3, at + 0.02)
          g.gain.exponentialRampToValueAtTime(0.001, at + 0.4)
          osc.connect(g)
          g.connect(out)
          osc.start(at)
          osc.stop(at + 0.42)
        }
        break
      }
    }
  }

  /** A filtered noise burst with an exponential decay — the percussive base. */
  private burst(
    dest: AudioNode,
    at: number,
    decay: number,
    freq: number,
    type: BiquadFilterType,
    peak: number,
  ): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    // Start at a varying offset so repeated shots do not phase into a tone.
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = type === 'bandpass' ? 1.4 : 0.7
    const g = ctx.createGain()
    g.gain.setValueAtTime(peak, at)
    g.gain.exponentialRampToValueAtTime(0.001, at + decay)
    src.connect(filter)
    filter.connect(g)
    g.connect(dest)
    src.start(at, (at * 7.13) % 0.9)
    src.stop(at + decay + 0.02)
  }
}
