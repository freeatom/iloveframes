import { playSfx } from '@/engine/sounds'

export interface RecordOptions {
  displayId: string
  cameraId: string | null
  micId: string | null
  countdown: number
  mode: 'auto' | 'manual'
  fps: number
  /** area of the display to record (DIPs, relative to the display), or null for the full screen */
  area?: { x: number; y: number; w: number; h: number } | null
}

interface Active {
  recorders: { kind: string; rec: MediaRecorder; start: number; done: Promise<void> }[]
  streams: MediaStream[]
  hasCamera: boolean
  hasMic: boolean
}

let active: Active | null = null

function pickMime(cands: string[]) {
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

/** `gate`: chunks are held until it resolves (the main process only takes them once the session exists). */
function record(kind: string, stream: MediaStream, mime: string, bps: number, gate: Promise<unknown> = Promise.resolve()) {
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: 192000 })
  const entry = { kind, rec, start: 0, done: Promise.resolve() }
  let pending: Promise<unknown> = gate.catch(() => {})
  rec.ondataavailable = (e) => {
    if (!e.data.size) return
    pending = pending.then(async () => window.ilf.rec.chunk(kind, await e.data.arrayBuffer()))
  }
  entry.done = new Promise<void>((resolve) => {
    rec.onstop = () => pending.then(() => resolve())
  })
  rec.onstart = () => (entry.start = Date.now())
  rec.start(1000)
  return entry
}

export async function startRecording(o: RecordOptions) {
  const streams: MediaStream[] = []
  let cam: MediaStream | null = null
  let mic: MediaStream | null = null
  // acquire devices before the countdown so permission prompts don't eat the take
  if (o.cameraId) {
    cam = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: o.cameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false
    })
    streams.push(cam)
  }
  if (o.micId) {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: o.micId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 }
    })
    streams.push(mic)
  }
  if (o.countdown > 0) {
    // countdown ticks are played by the countdown overlay
  } else playSfx('start', 0.8)
  // Camera and mic start *before* the screen capture: getting the capture going (hooks,
  // ffmpeg's first frame, the control bar) takes up to a second or so, and anything said
  // in that time used to be lost. The extra lead-in is trimmed off by its offset when the
  // recording is packed, so the audio starts exactly with the screen.
  let ready!: () => void
  const gate = new Promise<void>((r) => (ready = r))
  const recorders: Active['recorders'] = []
  if (cam) recorders.push(record('camera', cam, pickMime(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']), 10_000_000, gate))
  if (mic) recorders.push(record('mic', mic, pickMime(['audio/webm;codecs=opus', 'audio/webm']), 0, gate))
  let res: Awaited<ReturnType<typeof window.ilf.rec.prepare>>
  try {
    res = await window.ilf.rec.prepare({ displayId: o.displayId, countdown: o.countdown, mode: o.mode, fps: o.fps, area: o.area ?? null })
  } catch (err) {
    for (const r of recorders) if (r.rec.state !== 'inactive') r.rec.stop()
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    throw err
  } finally {
    ready()
  }
  if (res.engine === 'browser' && res.sourceId) {
    const scr = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: res.sourceId, maxFrameRate: o.fps, maxWidth: 7680, maxHeight: 4320 } } as any
    })
    streams.push(scr)
    recorders.push(record('screen', scr, pickMime(['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']), 40_000_000))
  }
  active = { recorders, streams, hasCamera: !!cam, hasMic: !!mic }
  return res
}

export async function stopRecording() {
  if (!active) throw new Error('not recording')
  const a = active
  active = null
  for (const r of a.recorders) if (r.rec.state !== 'inactive') r.rec.stop()
  await Promise.all(a.recorders.map((r) => r.done))
  a.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  const startOf = (k: string) => a.recorders.find((r) => r.kind === k)?.start || undefined
  return window.ilf.rec.finalize({ hasCamera: a.hasCamera, hasMic: a.hasMic, cameraStart: startOf('camera'), micStart: startOf('mic'), screenStart: startOf('screen') })
}

export function abortLocal() {
  if (!active) return
  for (const r of active.recorders) if (r.rec.state !== 'inactive') r.rec.stop()
  active.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
  active = null
}
