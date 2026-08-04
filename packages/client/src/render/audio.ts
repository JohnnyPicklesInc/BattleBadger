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
// Nothing in here may feed back into the sim, which is also why it is free to
// use Math.random — every client hears a slightly different battle and they
// stay in perfect lockstep regardless.
//
// What makes a synthesised battle sound cheap is sameness. Four archers loosing
// in one frame through one identical voice reads as a machine gun, not a volley,
// so every voice here is detuned, retimed and re-seeded against its neighbours,
// and distance takes the treble out rather than just turning the knob down.

export type Sfx =
  | 'bow' // an arrow loosed
  | 'melee' // blades meeting
  | 'siege' // a shell landing
  | 'charge' // cavalry going through a line
  | 'death' // a body hitting the ground
  | 'collapse' // a building coming down
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
  bow: 5,
  melee: 4,
  siege: 3,
  charge: 2,
  death: 4,
  collapse: 2,
  gate: 2,
  chime: 1,
}

/**
 * Per-kind output trim, measured rather than guessed.
 *
 * The layers that make each voice are wildly different in how much level they
 * survive with: a hard-Q bandpassed noise burst (a bow, a body) loses most of
 * itself in the filter, while a raw sine (a collapse, a siege boom) passes at
 * full amplitude. Rendered offline and measured, the untrimmed set spanned
 * peak 0.018 for a death against 0.346 for a collapse — nineteen to one, which
 * in a battle means the two commonest sounds on the map are inaudible under
 * the rarest. These bring them to within about 3:1, loudest to quietest, with
 * the common sounds sitting under the dramatic ones rather than beneath them.
 */
const TRIM: Record<Sfx, number> = {
  bow: 4.5,
  melee: 3.2,
  siege: 1.3,
  charge: 2.1,
  death: 12,
  collapse: 0.85,
  gate: 1.1,
  chime: 1.0,
}

// How far away a sound is still worth starting at all.
const EARSHOT = 90
// Voices allowed to be sounding at once, across every kind. The per-frame caps
// above stop one frame stampeding; this stops thirty consecutive frames doing
// it more politely.
const MAX_VOICES = 28

/** Uniform in [c-s, c+s). Audio only — never reachable from the sim. */
const vary = (c: number, s: number): number => c + (Math.random() * 2 - 1) * s
/** Exponential ramps cannot reach zero; this is the floor they aim at. */
const SILENT = 0.0008

export class BattleAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private queue: Voice[] = []
  private muted = false
  private volume = 0.5
  /** End times of voices already scheduled, for the concurrency cap. */
  private sounding: number[] = []

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

      // Master chain: gain → limiter → out. The limiter is what lets a big
      // battle stay loud without the sum of forty voices clipping into a buzz;
      // without it the only safe master volume is a quiet one.
      const limiter = this.ctx.createDynamicsCompressor()
      limiter.threshold.value = -12
      limiter.knee.value = 8
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.18
      limiter.connect(this.ctx.destination)

      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : this.volume
      this.master.connect(limiter)

      // Two seconds of white noise, reused by every percussive sound. Longer
      // than one so that the random start offsets below rarely repeat a grain.
      const len = this.ctx.sampleRate * 2
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
    const now = ctx.currentTime
    // Retire voices that have finished, so the concurrency cap reflects what is
    // actually sounding rather than everything ever started.
    this.sounding = this.sounding.filter((end) => end > now)

    const budget: Record<string, number> = {}
    // Nearest first, so when the cap bites it drops the distant half of a
    // battle rather than an arbitrary half.
    this.queue.sort(
      (a, b) =>
        (a.x - listenerX) ** 2 + (a.z - listenerZ) ** 2 - ((b.x - listenerX) ** 2 + (b.z - listenerZ) ** 2),
    )
    for (const v of this.queue) {
      if (this.sounding.length >= MAX_VOICES) break
      const dx = v.x - listenerX
      const dz = v.z - listenerZ
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > EARSHOT) continue
      budget[v.kind] = (budget[v.kind] ?? 0) + 1
      if (budget[v.kind] > PER_FRAME[v.kind]) continue
      const near = 1 - dist / EARSHOT
      // Linear falloff is wrong physics and right for a game: it keeps the far
      // edge of a battle audible instead of inaudible.
      this.strike(v.kind, near * near, Math.max(-1, Math.min(1, dx / 40)) * vary(1, 0.06), near)
    }
    this.queue.length = 0
  }

  // ---- the synth ------------------------------------------------------

  /**
   * @param near 1 at the listener, 0 at the edge of earshot. Drives the low-pass
   *   as well as the gain: distance eats treble long before it eats volume, and
   *   a far-off clash that is merely quiet still sounds like it is in the room.
   */
  private strike(kind: Sfx, gain: number, pan: number, near: number): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const out = ctx.createGain()
    out.gain.value = gain * TRIM[kind]

    // Air absorption. 20 kHz right on top of the listener down to ~1.6 kHz at
    // the edge of earshot, which is the difference between "over there" and
    // "quieter".
    const air = ctx.createBiquadFilter()
    air.type = 'lowpass'
    air.frequency.value = 1600 + near * near * 18000
    out.connect(air)

    const panner = ctx.createStereoPanner?.()
    if (panner) {
      panner.pan.value = pan
      air.connect(panner)
      panner.connect(this.master!)
    } else {
      air.connect(this.master!)
    }

    let until = t + 0.5
    switch (kind) {
      case 'bow': {
        // Two parts, because a bow is two events: the string letting go, and
        // the shaft leaving. The string is a bright noise crack; the shaft is a
        // falling whistle. Detuned hard per shot — a volley of eight identical
        // bows is the most obviously synthetic sound a game can make.
        const bright = vary(2900, 700)
        this.burst(out, t, vary(0.075, 0.02), bright, 'bandpass', 0.5, 2.2)
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(vary(1500, 250), t)
        osc.frequency.exponentialRampToValueAtTime(vary(520, 90), t + 0.1)
        g.gain.setValueAtTime(0.16, t)
        g.gain.exponentialRampToValueAtTime(SILENT, t + 0.12)
        osc.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 0.14)
        until = t + 0.16
        break
      }
      case 'melee': {
        // Metal. What makes a clash read as steel rather than as a click is
        // INHARMONIC partials — ratios that are not whole numbers, so the ring
        // never resolves into a pitch. Three of them over a scrape of noise.
        const root = vary(1700, 380)
        this.burst(out, t, 0.035, vary(4200, 800), 'bandpass', 0.4, 2.6)
        for (const [i, ratio] of [1, 2.41, 3.77].entries()) {
          const osc = ctx.createOscillator()
          const g = ctx.createGain()
          osc.type = 'triangle'
          osc.frequency.value = root * ratio * vary(1, 0.02)
          const peak = 0.2 / (i + 1)
          const at = t + i * 0.004
          g.gain.setValueAtTime(peak, at)
          g.gain.exponentialRampToValueAtTime(SILENT, at + vary(0.19, 0.05))
          osc.connect(g)
          g.connect(out)
          osc.start(at)
          osc.stop(at + 0.26)
        }
        this.burst(out, t + vary(0.022, 0.008), 0.06, vary(2100, 400), 'bandpass', 0.3, 1.6)
        until = t + 0.3
        break
      }
      case 'siege': {
        // Three layers, near to far in time: the crack of the strike, the body
        // of the thing that landed, and the rumble rolling away after it.
        this.burst(out, t, 0.05, 5200, 'highpass', 0.5, 0.9)
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(vary(150, 25), t)
        osc.frequency.exponentialRampToValueAtTime(vary(36, 6), t + 0.45)
        g.gain.setValueAtTime(0.9, t)
        g.gain.exponentialRampToValueAtTime(SILENT, t + 0.5)
        osc.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 0.52)
        this.burst(out, t, 0.18, vary(850, 150), 'lowpass', 0.6, 0.7)
        // The tail: quiet, long, and the reason a catapult sounds heavy rather
        // than merely loud.
        this.burst(out, t + 0.05, vary(0.75, 0.15), 300, 'lowpass', 0.22, 0.5)
        until = t + 0.9
        break
      }
      case 'charge': {
        // Horse into a shield wall: a soft heavy thud with hooves scuffling
        // over it. No metallic ring — nothing here is a blade.
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(vary(110, 18), t)
        osc.frequency.exponentialRampToValueAtTime(vary(48, 8), t + 0.22)
        g.gain.setValueAtTime(0.7, t)
        g.gain.exponentialRampToValueAtTime(SILENT, t + 0.26)
        osc.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 0.28)
        // Four irregular hoof taps — irregular because a rhythm would read as
        // a machine.
        for (let i = 0; i < 4; i++) {
          this.burst(out, t + i * vary(0.045, 0.018), 0.05, vary(700, 200), 'bandpass', 0.3, 1.2)
        }
        until = t + 0.35
        break
      }
      case 'death': {
        // A body going down: a dull thud with a little kit rattling on it.
        this.burst(out, t, vary(0.14, 0.03), vary(400, 90), 'lowpass', 0.6, 0.8)
        if (Math.random() < 0.5) {
          this.burst(out, t + vary(0.05, 0.02), 0.07, vary(2600, 600), 'bandpass', 0.12, 2.4)
        }
        until = t + 0.25
        break
      }
      case 'collapse': {
        // Masonry. A long fall of rubble with a boom underneath it — this is a
        // camp or a tower going down, and it should be audible across a field
        // that a dying man is not.
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(vary(90, 12), t)
        osc.frequency.exponentialRampToValueAtTime(28, t + 0.9)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.85, t + 0.05)
        g.gain.exponentialRampToValueAtTime(SILENT, t + 1.0)
        osc.connect(g)
        g.connect(out)
        osc.start(t)
        osc.stop(t + 1.05)
        // Rubble: a scatter of short bursts thinning out over a second, so the
        // building keeps falling after the boom instead of stopping dead.
        for (let i = 0; i < 7; i++) {
          const at = t + vary(0.08, 0.06) + i * vary(0.1, 0.05)
          this.burst(out, at, vary(0.11, 0.04), vary(1100, 500), 'bandpass', 0.3 * (1 - i / 8), 1.1)
        }
        until = t + 1.2
        break
      }
      case 'gate': {
        // Timber and iron. The creak is a sawtooth whose amplitude is chewed by
        // a slow LFO — stick-slip, the way a heavy hinge actually sounds — and
        // then the leaf comes to rest with a thud.
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(vary(72, 8), t)
        osc.frequency.linearRampToValueAtTime(vary(46, 6), t + 0.7)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 340
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.12)
        g.gain.exponentialRampToValueAtTime(SILENT, t + 0.8)
        const lfo = ctx.createOscillator()
        const lfoGain = ctx.createGain()
        lfo.type = 'square'
        lfo.frequency.value = vary(11, 3)
        lfoGain.gain.value = 0.12
        lfo.connect(lfoGain)
        lfoGain.connect(g.gain)
        osc.connect(lp)
        lp.connect(g)
        g.connect(out)
        osc.start(t)
        lfo.start(t)
        osc.stop(t + 0.82)
        lfo.stop(t + 0.82)
        this.burst(out, t + 0.72, 0.2, 220, 'lowpass', 0.4, 0.7)
        until = t + 0.95
        break
      }
      case 'chime': {
        // Research done. A rising triad, and bell-like rather than pure: each
        // note carries a detuned partial a fifth-and-a-bit above so it shimmers
        // instead of beeping. Unmistakably not a weapon.
        for (const [i, f] of [523.25, 659.25, 783.99].entries()) {
          const at = t + i * 0.1
          for (const [p, mul] of [1, 2.76].entries()) {
            const osc = ctx.createOscillator()
            const g = ctx.createGain()
            osc.type = 'triangle'
            osc.frequency.value = f * mul
            const peak = p === 0 ? 0.28 : 0.06
            g.gain.setValueAtTime(0.0001, at)
            g.gain.exponentialRampToValueAtTime(peak, at + 0.015)
            g.gain.exponentialRampToValueAtTime(SILENT, at + (p === 0 ? 0.55 : 0.3))
            osc.connect(g)
            g.connect(out)
            osc.start(at)
            osc.stop(at + 0.6)
          }
        }
        until = t + 0.85
        break
      }
    }
    this.sounding.push(until)
  }

  /** A filtered noise burst with an exponential decay — the percussive base. */
  private burst(
    dest: AudioNode,
    at: number,
    decay: number,
    freq: number,
    type: BiquadFilterType,
    peak: number,
    q = 1.4,
  ): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    // Detune the noise itself. Resampling the same grain shifts its spectrum,
    // which is a second axis of variation the filter alone cannot give.
    src.playbackRate.value = vary(1, 0.14)
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(Math.max(SILENT, peak), at)
    g.gain.exponentialRampToValueAtTime(SILENT, at + decay)
    src.connect(filter)
    filter.connect(g)
    g.connect(dest)
    // A random start offset, so repeated shots never phase into a tone.
    src.start(at, Math.random() * 1.8)
    src.stop(at + decay + 0.02)
  }
}
