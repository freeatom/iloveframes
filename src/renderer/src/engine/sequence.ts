import type { CropRect, EditState, MediaSource, Project, SeqClip, SourceTrack, TransitionKind } from './types'
import { projectFile, uid } from './types'

/**
 * The edited video is a sequence of clips played back to back. "Sequence
 * time" (T) is time in the final video; each clip maps T to a time inside its
 * source file. Zooms, cursor-hide ranges and sounds all live in sequence time.
 */
export const MAIN = 'main'

export interface SourceInfo {
  id: string
  name: string
  url: string
  duration: number
  width: number
  height: number
  hasAudio: boolean
  isMain: boolean
}

export function sourceInfo(project: Project, id: string): SourceInfo | null {
  if (id === MAIN)
    return {
      id: MAIN,
      name: project.mainName || (project.imported ? 'Video' : 'Recording'),
      url: projectFile(project, project.screenFile ?? 'screen.mp4'),
      duration: project.duration,
      width: Math.round(project.display.width * project.display.scaleFactor),
      height: Math.round(project.display.height * project.display.scaleFactor),
      hasAudio: !!project.screenAudio,
      isMain: true
    }
  const s = project.sources?.find((x) => x.id === id)
  return s ? { ...s, url: projectFile(project, s.file), isMain: false } : null
}

export const clipLen = (c: SeqClip) => Math.max(0, c.out - c.in)
export const seqDuration = (clips: SeqClip[]) => clips.reduce((a, c) => a + clipLen(c), 0)

export function seqStarts(clips: SeqClip[]) {
  const out: number[] = []
  let acc = 0
  for (const c of clips) {
    out.push(acc)
    acc += clipLen(c)
  }
  return out
}

export interface ClipHit {
  clip: SeqClip
  index: number
  start: number
  srcT: number
}

/** Which clip is playing at sequence time T (a boundary belongs to the next clip). */
export function clipAt(clips: SeqClip[], T: number): ClipHit | null {
  if (!clips.length) return null
  let acc = 0
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    const len = clipLen(c)
    if (T < acc + len || i === clips.length - 1) {
      const local = Math.min(Math.max(0, T - acc), len)
      return { clip: c, index: i, start: acc, srcT: c.in + local }
    }
    acc += len
  }
  return null
}

/** Every sequence time where source time `srcT` of `source` is shown. */
export function srcToSeq(clips: SeqClip[], source: string, srcT: number): number[] {
  const out: number[] = []
  let acc = 0
  for (const c of clips) {
    if (c.source === source && srcT >= c.in && srcT < c.out) out.push(acc + (srcT - c.in))
    acc += clipLen(c)
  }
  return out
}

/**
 * Tracking data for a source: the main recording's own events, or the events
 * that came along with an imported iloveframes recording. Null for plain videos.
 */
export function trackOf(project: Project, id: string): SourceTrack | null {
  if (id === MAIN) {
    const e = project.events
    if (!e || (!e.cursor.length && !e.clicks.length && !e.keys.length)) return null
    return { events: e, display: project.display, cursorBaked: project.cursorBaked }
  }
  return project.sources?.find((s) => s.id === id)?.track ?? null
}

/** Webcam footage that belongs to a source, if any. */
export function cameraOf(project: Project, id: string): { file: string; offset: number } | null {
  if (id === MAIN) return project.camera
  return project.sources?.find((s) => s.id === id)?.camera ?? null
}

export const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }
type Crops = Record<string, CropRect> | undefined

/** The crop for a source (whole frame when none). */
export const cropOf = (crops: Crops, id: string): CropRect => {
  const c = crops?.[id]
  return c && c.w > 0 && c.h > 0 ? c : FULL
}

/** A point in the full frame -> the same point inside the cropped view. */
export const toCrop = (c: CropRect, x: number, y: number) => ({ x: (x - c.x) / c.w, y: (y - c.y) / c.h })

/** Recording events (clicks / keys) of every tracked source, remapped into sequence time (and into each source's crop). */
export function seqEvents(project: Project, clips: SeqClip[], crops?: Crops) {
  const clicks: { t: number; x: number; y: number }[] = []
  const keys: { t: number; i: number }[] = []
  for (const id of new Set(clips.map((c) => c.source))) {
    const tr = trackOf(project, id)
    if (!tr) continue
    const c = cropOf(crops, id)
    for (const [t, x, y] of tr.events.clicks) {
      // a click outside the cropped view can't be seen, so it shouldn't pull a zoom
      if (x < c.x || x > c.x + c.w || y < c.y || y > c.y + c.h) continue
      const p = toCrop(c, x, y)
      for (const T of srcToSeq(clips, id, t)) clicks.push({ t: T, x: p.x, y: p.y })
    }
    tr.events.keys.forEach((t, i) => {
      for (const T of srcToSeq(clips, id, t)) keys.push({ t: T, i })
    })
  }
  clicks.sort((a, b) => a.t - b.t)
  keys.sort((a, b) => a.t - b.t)
  return { clicks, keys }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------
/**
 * A transition sits centred on a cut and never changes the sequence length:
 * for the first half the outgoing clip keeps playing while the incoming clip
 * holds its first frame, then the incoming clip plays while the outgoing one
 * holds its last frame. Everything else (zooms, sounds) keeps its timing.
 */
export interface TransitionHit {
  kind: TransitionKind
  /** linear progress 0..1 across the transition */
  p: number
  cut: number
  half: number
  a: number
  b: number
}

/** Half-length actually used: never more than half of either neighbour. */
export function transitionHalf(clips: SeqClip[], i: number) {
  const c = clips[i]
  if (!c?.tIn || i === 0) return 0
  return Math.max(0, Math.min(c.tIn.duration / 2, clipLen(clips[i - 1]) / 2, clipLen(c) / 2))
}

export function transitionAt(clips: SeqClip[], T: number): TransitionHit | null {
  let acc = 0
  for (let i = 0; i < clips.length; i++) {
    if (i > 0 && clips[i].tIn) {
      const h = transitionHalf(clips, i)
      if (h > 0.01 && T >= acc - h && T < acc + h) return { kind: clips[i].tIn!.kind, p: (T - (acc - h)) / (2 * h), cut: acc, half: h, a: i - 1, b: i }
    }
    acc += clipLen(clips[i])
    if (acc - 2 > T) break
  }
  return null
}

/** Every cut that has a transition, in sequence time (for prefetching held frames). */
export function transitionCuts(clips: SeqClip[]) {
  const out: { cut: number; half: number; a: number; b: number }[] = []
  let acc = 0
  clips.forEach((c, i) => {
    const h = transitionHalf(clips, i)
    if (h > 0.01) out.push({ cut: acc, half: h, a: i - 1, b: i })
    acc += clipLen(c)
  })
  return out
}

/** Split the clip under T into two. Returns the new clips, or the same array if T is on an edge. */
export function splitClips(clips: SeqClip[], T: number): SeqClip[] {
  const hit = clipAt(clips, T)
  if (!hit) return clips
  const { clip, index, srcT } = hit
  if (srcT - clip.in < 0.05 || clip.out - srcT < 0.05) return clips
  const a: SeqClip = { ...clip, out: srcT }
  const b: SeqClip = { ...clip, id: uid(), in: srcT, tIn: undefined }
  return [...clips.slice(0, index), a, b, ...clips.slice(index + 1)]
}

type Span = { start: number; end: number }

/** Remove sequence range [a, b): items after shift left, items inside are cut. */
export function rippleRemove(edit: EditState, a: number, b: number): EditState {
  const d = b - a
  if (d <= 0) return edit
  const span = <T extends Span>(s: T): T | null => {
    if (s.end <= a) return s
    if (s.start >= b) return { ...s, start: s.start - d, end: s.end - d }
    const start = s.start < a ? s.start : a
    const end = s.end > b ? s.end - d : a
    return end - start > 0.2 ? { ...s, start, end } : null
  }
  return {
    ...edit,
    zoom: { ...edit.zoom, segments: edit.zoom.segments.map(span).filter(Boolean) as EditState['zoom']['segments'] },
    cursor: { ...edit.cursor, hidden: edit.cursor.hidden.map(span).filter(Boolean) as EditState['cursor']['hidden'] },
    texts: (edit.texts ?? []).map(span).filter(Boolean) as EditState['texts'],
    audio: {
      ...edit.audio,
      clips: edit.audio.clips
        .filter((c) => !(c.start >= a && c.start + c.duration <= b))
        .map((c) => (c.start >= b ? { ...c, start: c.start - d } : c))
    }
  }
}

/** Open a gap of length d at sequence time `at`: items after shift right. */
export function rippleInsert(edit: EditState, at: number, d: number): EditState {
  if (d <= 0) return edit
  const span = <T extends Span>(s: T): T => (s.start >= at ? { ...s, start: s.start + d, end: s.end + d } : s.end > at ? { ...s, end: s.end + d } : s)
  return {
    ...edit,
    zoom: { ...edit.zoom, segments: edit.zoom.segments.map(span) },
    cursor: { ...edit.cursor, hidden: edit.cursor.hidden.map(span) },
    texts: (edit.texts ?? []).map(span),
    audio: { ...edit.audio, clips: edit.audio.clips.map((c) => (c.start >= at ? { ...c, start: c.start + d } : c)) }
  }
}

export function sourceList(project: Project): MediaSource[] {
  return project.sources ?? []
}
