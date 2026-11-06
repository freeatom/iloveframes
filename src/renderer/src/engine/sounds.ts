import type { EditState, Project } from './types'
import { transitionFor } from './motion'
import { MAIN, seqDuration, seqEvents, seqStarts, transitionHalf } from './sequence'

/**
 * Every sound effect is synthesized: crisp at any volume, royalty-free and
 * zero bytes of assets. Buffers are context-independent so the live preview
 * and the offline export mix share them.
 */
const SR = 48000
const TAU = Math.PI * 2

export const CLICK_SOUNDS = [
  { id: 'soft', name: 'Soft' },
  { id: 'trackpad', name: 'Trackpad' },
  { id: 'velvet', name: 'Velvet' },
  { id: 'glass', name: 'Glass' },
  { id: 'bubble', name: 'Bubble' },
  { id: 'wood', name: 'Wood' },
  { id: 'chime', name: 'Chime' },
  { id: 'pop', name: 'Pop' },
  { id: 'tap', name: 'Tap' },
  { id: 'mechanical', name: 'Mech' }
] as const

export const ZOOM_SOUNDS = [
  { id: 'deep', name: 'Deep' },
  { id: 'whoosh', name: 'Whoosh' },
  { id: 'airy', name: 'Airy' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'swipe', name: 'Swipe' },
  { id: 'rise', name: 'Rise' }
] as const

export const TYPING_SOUNDS = [
  { id: 'thock', name: 'Thock' },
  { id: 'membrane', name: 'Membrane' },
  { id: 'clicky', name: 'Clicky' },
  { id: 'typewriter', name: 'Typewriter' }
] as const

type UiSound = 'start' | 'stop' | 'done' | 'tick'

function rng(seed: number) {
  let s = (seed * 7919 + 12345) % 2147483647 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1
}

/** one-pole low-pass state machine; k in (0,1], higher = brighter */
function lowpass() {
  let y = 0
  return (x: number, k: number) => (y += (x - y) * k)
}

function build(seconds: number, fill: (t: number) => number): AudioBuffer {
  const n = Math.ceil(seconds * SR)
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR })
  const L = buf.getChannelData(0)
  for (let i = 0; i < n; i++) L[i] = fill(i / SR)
  // gentle fade-out on the tail so nothing ever clicks at the end
  const fade = Math.min(n, Math.round(SR * 0.004))
  for (let i = 0; i < fade; i++) L[n - 1 - i] *= i / fade
  buf.getChannelData(1).set(L)
  return buf
}

const atk = (t: number, a: number) => Math.min(1, t / a)

function gen(id: string, v: number): AudioBuffer {
  const nz = rng(v + id.length * 31)
  const lp = lowpass()
  const lp2 = lowpass()
  const f = 1 + (v - 2.5) * 0.028 // per-variant pitch
  switch (id) {
    // ---------- clicks ----------
    case 'soft':
      return build(0.07, (t) => {
        const n = nz()
        const l = lp(n, 0.35)
        return (Math.sin(TAU * 2600 * t) * Math.exp(-t * 180) * 0.35 + (n - l) * Math.exp(-t * 700) * 0.5) * 0.9
      })
    case 'mechanical':
      return build(0.12, (t) => {
        const l = lp(nz(), 0.5)
        const a = Math.exp(-t * 900) * (l * 0.9 + Math.sin(TAU * 1800 * t) * 0.4)
        const t2 = t - 0.055
        const b = t2 > 0 ? Math.exp(-t2 * 1100) * (l * 0.6 + Math.sin(TAU * 2400 * t2) * 0.25) : 0
        return (a + b) * 0.8
      })
    case 'pop':
      return build(0.09, (t) => Math.sin(TAU * (280 * t + (1100 / 30) * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 55) * 0.55 * atk(t, 0.0015))
    case 'tap':
      return build(0.08, (t) => (Math.sin(TAU * 190 * t) * Math.exp(-t * 70) * 0.7 + nz() * Math.exp(-t * 1200) * 0.25) * 0.9)
    case 'glass':
      return build(0.22, (t) => {
        const ring = Math.sin(TAU * 3150 * t) * 0.5 + Math.sin(TAU * 4730 * t) * 0.28 + Math.sin(TAU * 6290 * t) * 0.12
        return (ring * Math.exp(-t * 32) * atk(t, 0.0006) + nz() * Math.exp(-t * 2500) * 0.15) * 0.32
      })
    case 'bubble': {
      let ph = 0
      return build(0.12, (t) => {
        const fr = 380 + 950 * (1 - Math.exp(-t * 42))
        ph += (TAU * fr) / SR
        return Math.sin(ph) * Math.exp(-t * 36) * atk(t, 0.002) * 0.5
      })
    }
    case 'wood':
      return build(0.12, (t) => {
        const n = nz()
        const body = Math.sin(TAU * 780 * t) * 0.6 + Math.sin(TAU * 1565 * t) * 0.22 + Math.sin(TAU * 2900 * t) * 0.08
        return (body * Math.exp(-t * 55) * atk(t, 0.0008) + (n - lp(n, 0.2)) * Math.exp(-t * 600) * 0.25) * 0.55
      })
    case 'velvet':
      return build(0.12, (t) => {
        const n = lp(nz(), 0.08)
        return (n * Math.exp(-t * 110) * 1.6 + Math.sin(TAU * 140 * t) * Math.exp(-t * 45) * 0.55 * atk(t, 0.002)) * 0.75
      })
    case 'trackpad':
      return build(0.12, (t) => {
        const n = nz()
        const hp = n - lp(n, 0.25)
        const down = hp * Math.exp(-t * 900) * 0.55 + Math.sin(TAU * 260 * t) * Math.exp(-t * 90) * 0.3 * atk(t, 0.001)
        const t2 = t - 0.065
        const up = t2 > 0 ? hp * Math.exp(-t2 * 1300) * 0.25 : 0
        return (down + up) * 0.85
      })
    case 'chime':
      return build(0.55, (t) => (Math.sin(TAU * 1320 * t) + 0.5 * Math.sin(TAU * 1980 * t) + 0.22 * Math.sin(TAU * 2640 * t)) * Math.exp(-t * 9) * atk(t, 0.003) * 0.15)

    // ---------- zoom ----------
    case 'whoosh': {
      const d = 0.55
      return build(d, (t) => {
        const p = t / d
        const env = Math.sin(Math.PI * Math.pow(p, 0.8)) ** 2
        const cut = 0.02 + 0.18 * Math.sin(Math.PI * p)
        return lp2(lp(nz(), cut), cut) * env * 1.4
      })
    }
    case 'airy': {
      const d = 0.6
      return build(d, (t) => {
        const p = t / d
        const env = Math.sin(Math.PI * Math.pow(p, 0.7)) ** 2
        const n = nz()
        const band = lp(n, 0.06 + 0.4 * Math.sin(Math.PI * p)) - lp2(n, 0.02)
        return band * env * 0.9
      })
    }
    case 'deep': {
      const d = 0.7
      return build(d, (t) => {
        const p = t / d
        const env = Math.sin(Math.PI * Math.pow(p, 0.75)) ** 2
        const cut = 0.008 + 0.05 * Math.sin(Math.PI * p)
        return (lp2(lp(nz(), cut), cut) * 2.6 + Math.sin(TAU * 68 * t) * 0.22) * env
      })
    }
    case 'shimmer': {
      const d = 0.75
      return build(d, (t) => {
        const p = t / d
        const env = Math.sin(Math.PI * Math.pow(p, 0.8)) ** 2
        const cut = 0.02 + 0.16 * Math.sin(Math.PI * p)
        let v = lp2(lp(nz(), cut), cut) * env * 1.1
        ;[2093, 2637, 3136].forEach((fr, i) => {
          const s = t - (0.18 + i * 0.09)
          if (s > 0) v += Math.sin(TAU * fr * s) * Math.exp(-s * 9) * atk(s, 0.004) * 0.05
        })
        return v
      })
    }
    case 'swipe': {
      const d = 0.28
      return build(d, (t) => {
        const p = t / d
        const env = Math.sin(Math.PI * p) ** 3
        const n = nz()
        return (lp(n, 0.05 + 0.5 * p) - lp2(n, 0.03)) * env * 1.1
      })
    }
    case 'rise': {
      const d = 0.42
      let ph = 0
      return build(d, (t) => {
        const p = t / d
        const fr = 440 * Math.pow(1.5, Math.min(1, p * 1.4))
        ph += (TAU * fr) / SR
        const env = Math.sin(Math.PI * Math.pow(p, 0.6)) ** 2
        return (Math.sin(ph) + 0.18 * Math.sin(2 * ph)) * env * 0.13
      })
    }

    // ---------- typing (variants = natural key-to-key differences) ----------
    case 'thock':
      return build(0.1, (t) => {
        const body = Math.sin(TAU * 210 * f * t) * Math.exp(-t * 60) * 0.5 * atk(t, 0.0008)
        const n = lp(nz(), 0.18)
        const t2 = t - 0.011
        const bottom = t2 > 0 ? Math.sin(TAU * 340 * f * t2) * Math.exp(-t2 * 120) * 0.18 : 0
        return (body + n * Math.exp(-t * 260) * 0.9 + bottom) * 0.8
      })
    case 'membrane':
      return build(0.07, (t) => (lp(nz(), 0.14) * Math.exp(-t * 170) * 1.1 + Math.sin(TAU * 350 * f * t) * Math.exp(-t * 120) * 0.14) * 0.75)
    case 'clicky':
      return build(0.08, (t) => {
        const n = nz()
        const hp = n - lp(n, 0.3)
        const t2 = t - 0.026
        return (hp * Math.exp(-t * 1200) * 0.6 + Math.sin(TAU * 3200 * f * t) * Math.exp(-t * 300) * 0.12 + (t2 > 0 ? hp * Math.exp(-t2 * 1500) * 0.35 : 0)) * 0.75
      })
    case 'typewriter':
      return build(0.2, (t) => (nz() * Math.exp(-t * 500) * 0.55 + (Math.sin(TAU * 1850 * f * t) * 0.6 + Math.sin(TAU * 2770 * f * t) * 0.4) * Math.exp(-t * 32) * 0.1) * 0.8)

    // ---------- app UI ----------
    case 'start':
    case 'stop':
    case 'done': {
      const notes = id === 'start' ? [660, 990] : id === 'stop' ? [990, 660] : [784, 988, 1318]
      const step = 0.09
      return build(step * notes.length + 0.5, (t) => {
        let s = 0
        notes.forEach((fr, i) => {
          const tt = t - i * step
          if (tt > 0) s += (Math.sin(TAU * fr * tt) + 0.25 * Math.sin(2 * TAU * fr * tt)) * Math.exp(-tt * 7) * atk(tt, 0.0025)
        })
        return s * 0.16
      })
    }
    case 'tick':
      return build(0.25, (t) => Math.sin(TAU * 1320 * t) * Math.exp(-t * 22) * atk(t, 0.0016) * 0.18)
  }
  return build(0.01, () => 0)
}

// consistent perceived loudness: bright/ringing sounds sit a little lower
const PEAK: Record<string, number> = { glass: 0.42, chime: 0.4, rise: 0.42, shimmer: 0.55, thock: 0.5, membrane: 0.5, clicky: 0.45, typewriter: 0.45, start: 0.5, stop: 0.5, done: 0.5, tick: 0.4 }
function normalize(b: AudioBuffer, id: string) {
  const target = PEAK[id] ?? 0.6
  let pk = 0
  for (const v of b.getChannelData(0)) pk = Math.max(pk, Math.abs(v))
  if (pk < 1e-4) return b
  const k = target / pk
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c)
    for (let i = 0; i < d.length; i++) d[i] *= k
  }
  return b
}

const cache = new Map<string, AudioBuffer>()
export function sfxBuffer(id: string, variant = 0, reversed = false): AudioBuffer {
  const key = `${id}|${variant}|${reversed ? 1 : 0}`
  let b = cache.get(key)
  if (!b) {
    b = normalize(gen(id, variant), id)
    if (reversed) {
      const r = new AudioBuffer({ length: b.length, numberOfChannels: 2, sampleRate: SR })
      for (let c = 0; c < 2; c++) r.getChannelData(c).set(b.getChannelData(c).slice().reverse())
      b = r
    }
    cache.set(key, b)
  }
  return b
}

/** Deterministic per-key variation so preview and export sound identical. */
export const keyVariant = (i: number) => ({ variant: (i * 7 + 3) % 6, gain: 0.82 + 0.18 * (((i * 13) % 7) / 6) })

let live: AudioContext | null = null
export function liveCtx() {
  if (!live) live = new AudioContext({ sampleRate: SR })
  if (live.state === 'suspended') live.resume()
  return live
}

export function playSfx(id: string | UiSound, volume = 1, variant = 0, reversed = false) {
  const ctx = liveCtx()
  const src = ctx.createBufferSource()
  src.buffer = sfxBuffer(id, variant, reversed)
  const g = ctx.createGain()
  g.gain.value = volume
  src.connect(g).connect(ctx.destination)
  src.start()
}

/** Times (timeline seconds) of zoom in/out sound cues. */
export function zoomCues(edit: EditState) {
  const T = transitionFor(edit.zoom.speed)
  const out: { t: number; reversed: boolean }[] = []
  for (const s of edit.zoom.segments) {
    const tr = Math.min(T, (s.end - s.start) / 2)
    out.push({ t: s.start, reversed: false })
    out.push({ t: Math.max(s.start + 0.05, s.end - tr - 0.08), reversed: true })
  }
  return out
}

const userBufs = new Map<string, Promise<AudioBuffer | null>>()
export function loadUserSound(src: string): Promise<AudioBuffer | null> {
  let p = userBufs.get(src)
  if (!p) {
    p = fetch(src)
      .then((r) => r.arrayBuffer())
      .then((ab) => liveCtx().decodeAudioData(ab))
      .catch(() => null)
    userBufs.set(src, p)
  }
  return p
}

/** Offline mix of mic + sound effects + user audio clips for the trimmed range. */
export async function renderAudioMix(project: Project, edit: EditState, micBuffer: AudioBuffer | null, sourceAudio: Map<string, AudioBuffer> = new Map()): Promise<AudioBuffer | null> {
  const dur = Math.max(0.1, seqDuration(edit.clips))
  const sfx = edit.sfx
  const ev = seqEvents(project, edit.clips, edit.crops)
  const hasClicks = edit.cursor.enabled && sfx.click.enabled && ev.clicks.length > 0
  const hasZoom = sfx.zoom.enabled && edit.zoom.segments.length > 0
  const hasKeys = sfx.typing.enabled && ev.keys.length > 0
  const hasMic = !!micBuffer && !edit.audio.muted
  const clips = edit.audio.clips.filter((c) => c.start < dur)
  if (!hasClicks && !hasZoom && !hasKeys && !hasMic && !clips.length && !sourceAudio.size) return null
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR)
  const place = (buf: AudioBuffer, when: number, gain: number, offset = 0, length?: number, fade?: { in: number; out: number }) => {
    const s = ctx.createBufferSource()
    s.buffer = buf
    const g = ctx.createGain()
    g.gain.value = gain
    s.connect(g).connect(ctx.destination)
    if (offset < 0) {
      when -= offset
      if (length !== undefined) length += offset
      offset = 0
    }
    if (when < 0) {
      offset -= when
      if (length !== undefined) length += when
      when = 0
    }
    if (length !== undefined && length <= 0) return
    if (offset >= buf.duration) return
    if (fade && length !== undefined && (fade.in > 0 || fade.out > 0)) {
      // short ramps so audio eases across a transition instead of cutting hard
      const fi = Math.min(fade.in, length / 2)
      const fo = Math.min(fade.out, length / 2)
      g.gain.setValueAtTime(fi > 0 ? 0 : gain, when)
      if (fi > 0) g.gain.linearRampToValueAtTime(gain, when + fi)
      if (fo > 0) {
        g.gain.setValueAtTime(gain, when + length - fo)
        g.gain.linearRampToValueAtTime(0, when + length)
      }
    }
    s.start(when, offset, length)
  }
  // per clip: mic (recording clips) and the clip's own audio track
  const starts = seqStarts(edit.clips)
  edit.clips.forEach((c, i) => {
    const len = c.out - c.in
    const fade = { in: transitionHalf(edit.clips, i), out: transitionHalf(edit.clips, i + 1) }
    if (c.source === MAIN && hasMic && micBuffer && project.mic) place(micBuffer, starts[i], edit.audio.micVolume, c.in - project.mic.offset, len, fade)
    const own = sourceAudio.get(c.source)
    if (own && (c.volume ?? 1) > 0) place(own, starts[i], c.volume ?? 1, c.in, len, fade)
  })
  if (hasClicks) for (const c of ev.clicks) place(sfxBuffer(sfx.click.id), c.t, sfx.click.volume)
  if (hasKeys)
    for (const k of ev.keys) {
      const v = keyVariant(k.i)
      place(sfxBuffer(sfx.typing.id, v.variant), k.t, sfx.typing.volume * v.gain)
    }
  if (hasZoom) for (const c of zoomCues(edit)) if (c.t <= dur) place(sfxBuffer(sfx.zoom.id, 0, c.reversed), c.t, sfx.zoom.volume)
  for (const c of clips) {
    const buf = await loadUserSound(c.src)
    if (buf) place(buf, c.start, c.volume, c.offset, c.duration)
  }
  return ctx.startRendering()
}

export function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels
  const n = buf.length
  const out = new ArrayBuffer(44 + n * ch * 2)
  const v = new DataView(out)
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true)
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true)
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i))
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = chans[c][i]
      s = s > 1 ? 1 : s < -1 ? -1 : s
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return out
}
