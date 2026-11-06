import { create } from 'zustand'
import type { EditState, MediaSource, Project, TextOverlay, TextStyle, Transition, ZoomSegment } from '@/engine/types'
import { makeText } from '@/engine/overlays'
import { clipLen, rippleInsert, rippleRemove, seqDuration, seqStarts, splitClips } from '@/engine/sequence'
import { uid } from '@/engine/types'
import { track, trackOncePerSession } from '@/lib/telemetry'
import { autoZoomSegments } from '@/engine/motion'

interface EditorState {
  project: Project | null
  edit: EditState | null
  time: number
  playing: boolean
  selected: string | null
  exporting: boolean
  past: EditState[]
  future: EditState[]
  load: (p: Project, e: EditState) => void
  /** apply a change; pass history=false for continuous drags (commit once at the end) */
  update: (fn: (e: EditState) => EditState, history?: boolean) => void
  checkpoint: () => void
  undo: () => void
  redo: () => void
  setTime: (t: number) => void
  setPlaying: (p: boolean) => void
  select: (id: string | null) => void
  setProject: (fn: (p: Project) => Project) => void
}

let pendingBase: EditState | null = null

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  edit: null,
  time: 0,
  playing: false,
  selected: null,
  exporting: false,
  past: [],
  future: [],
  load: (project, edit) => set({ project, edit, past: [], future: [], time: 0, playing: false, selected: null }),
  update: (fn, history = true) => {
    const cur = get().edit
    if (!cur) return
    const next = fn(cur)
    if (history) {
      const base = pendingBase ?? cur
      pendingBase = null
      set({ edit: next, past: [...get().past.slice(-80), base], future: [] })
    } else {
      if (!pendingBase) pendingBase = cur
      set({ edit: next })
    }
  },
  checkpoint: () => {
    if (!pendingBase) return
    const base = pendingBase
    pendingBase = null
    set({ past: [...get().past.slice(-80), base], future: [] })
  },
  undo: () => {
    const { past, edit, future } = get()
    if (!past.length || !edit) return
    set({ edit: past[past.length - 1], past: past.slice(0, -1), future: [edit, ...future] })
  },
  redo: () => {
    const { past, edit, future } = get()
    if (!future.length || !edit) return
    set({ edit: future[0], future: future.slice(1), past: [...past, edit] })
  },
  setTime: (t) => set({ time: t }),
  setPlaying: (p) => set({ playing: p }),
  select: (id) => set({ selected: id }),
  setProject: (fn) => {
    const p = get().project
    if (p) set({ project: fn(p) })
  }
}))

export const updateEdit = (fn: (e: EditState) => EditState, history = true) => useEditor.getState().update(fn, history)

export function patchSegment(id: string, patch: Partial<ZoomSegment>, history = true) {
  updateEdit((e) => ({ ...e, zoom: { ...e.zoom, segments: e.zoom.segments.map((s) => (s.id === id ? { ...s, ...patch, auto: false } : s)) } }), history)
}

export function addSegmentAt(t: number, len = 3) {
  const { edit, project } = useEditor.getState()
  if (!edit || !project) return
  const dur = seqDuration(edit.clips)
  let start = Math.max(0, Math.min(t - 0.3, dur - len))
  let end = Math.min(dur, start + len)
  // avoid overlaps: shrink into the free gap
  for (const s of edit.zoom.segments) {
    if (s.start <= start && s.end > start) start = s.end + 0.05
    if (s.start > start && s.start < end) end = s.start - 0.05
  }
  if (end - start < 0.8) return
  const seg: ZoomSegment = { id: uid(), start, end, scale: 1.5, follow: true, x: 0.5, y: 0.5 }
  track('zoom_added')
  updateEdit((e) => ({ ...e, zoom: { ...e.zoom, segments: [...e.zoom.segments, seg].sort((a, b) => a.start - b.start) } }))
  useEditor.getState().select(seg.id)
}

export function removeSegment(id: string) {
  updateEdit((e) => ({ ...e, zoom: { ...e.zoom, segments: e.zoom.segments.filter((s) => s.id !== id) } }))
  if (useEditor.getState().selected === id) useEditor.getState().select(null)
}

// ---- cursor hide ranges ----
type HideRange = EditState['cursor']['hidden'][number]

export function addHideAt(t: number, len = 2) {
  const { edit, project } = useEditor.getState()
  if (!edit || !project) return
  const dur = seqDuration(edit.clips)
  let start = Math.max(0, Math.min(t, dur - len))
  let end = Math.min(dur, start + len)
  for (const r of edit.cursor.hidden) {
    if (r.start <= start && r.end > start) start = r.end + 0.05
    if (r.start > start && r.start < end) end = r.start - 0.05
  }
  if (end - start < 0.4) return
  const r: HideRange = { id: uid(), start, end }
  updateEdit((e) => ({ ...e, cursor: { ...e.cursor, hidden: [...e.cursor.hidden, r].sort((a, b) => a.start - b.start) } }))
  useEditor.getState().select(r.id)
}

export function patchHide(id: string, patch: Partial<HideRange>, history = true) {
  updateEdit((e) => ({ ...e, cursor: { ...e.cursor, hidden: e.cursor.hidden.map((r) => (r.id === id ? { ...r, ...patch } : r)) } }), history)
}

export function removeHide(id: string) {
  updateEdit((e) => ({ ...e, cursor: { ...e.cursor, hidden: e.cursor.hidden.filter((r) => r.id !== id) } }))
  if (useEditor.getState().selected === id) useEditor.getState().select(null)
}

/** Delete whatever is selected (zoom or hide range). */
export function removeSelected() {
  const { selected, edit } = useEditor.getState()
  if (!selected || !edit) return
  if (edit.clips.some((c) => c.id === selected)) deleteSeqClip(selected)
  else if (edit.zoom.segments.some((s) => s.id === selected)) removeSegment(selected)
  else if (edit.audio.clips.some((c) => c.id === selected)) removeClip(selected)
  else if (edit.texts.some((t) => t.id === selected)) removeText(selected)
  else removeHide(selected)
}

/** Raw recorded cursor position at time t (normalized). */
export function cursorPosAt(project: { events: { cursor: [number, number, number][] } }, t: number) {
  const pts = project.events.cursor
  if (!pts.length) return { x: 0.5, y: 0.5 }
  let best = pts[0]
  for (const p of pts) {
    if (p[0] > t) break
    best = p
  }
  return { x: best[1], y: best[2] }
}

// ---- user audio clips ----
type Clip = EditState['audio']['clips'][number]

export function addClipAt(sound: { name: string; file: string; duration: number }, t: number, src: string) {
  const { project, edit } = useEditor.getState()
  if (!project || !edit) return
  const total = seqDuration(edit.clips)
  const start = Math.max(0, Math.min(t, total - 0.2))
  track('audio_added')
  const clip: Clip = { id: uid(), name: sound.name, src, start, offset: 0, duration: Math.min(sound.duration, Math.max(0.2, total - start)), sourceDuration: sound.duration, volume: 1 }
  updateEdit((e) => ({ ...e, audio: { ...e.audio, clips: [...e.audio.clips, clip] } }))
  useEditor.getState().select(clip.id)
}

export function patchClip(id: string, patch: Partial<Clip>, history = true) {
  updateEdit((e) => ({ ...e, audio: { ...e.audio, clips: e.audio.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) } }), history)
}

export function removeClip(id: string) {
  updateEdit((e) => ({ ...e, audio: { ...e.audio, clips: e.audio.clips.filter((c) => c.id !== id) } }))
  if (useEditor.getState().selected === id) useEditor.getState().select(null)
}

// ---- sequence clips (cut / delete / trim / reorder / add) ----
export function splitAtPlayhead() {
  const { edit, time } = useEditor.getState()
  if (!edit) return false
  const next = splitClips(edit.clips, time)
  if (next === edit.clips) return false
  track('clip_split')
  updateEdit((e) => ({ ...e, clips: next }))
  return true
}

export function deleteSeqClip(id: string) {
  const { edit } = useEditor.getState()
  if (!edit || edit.clips.length <= 1) return
  const i = edit.clips.findIndex((c) => c.id === id)
  if (i < 0) return
  const start = seqStarts(edit.clips)[i]
  const len = clipLen(edit.clips[i])
  updateEdit((e) => ({ ...rippleRemove(e, start, start + len), clips: e.clips.filter((c) => c.id !== id) }))
  const s = useEditor.getState()
  s.select(null)
  if (s.time > seqDuration(useEditor.getState().edit!.clips)) s.setTime(Math.max(0, seqDuration(useEditor.getState().edit!.clips) - 0.05))
}

/** Trim one edge of a clip, rippling later zooms / hides / sounds. Computed from `base` so drags are stable. */
export function trimSeqClip(base: EditState, id: string, edge: 'in' | 'out', value: number, sourceDuration: number): EditState {
  const i = base.clips.findIndex((c) => c.id === id)
  if (i < 0) return base
  const c = base.clips[i]
  const start = seqStarts(base.clips)[i]
  if (edge === 'in') {
    const v = Math.max(0, Math.min(value, c.out - 0.2))
    const d = v - c.in
    const rippled = d > 0 ? rippleRemove(base, start, start + d) : rippleInsert(base, start, -d)
    return { ...rippled, clips: base.clips.map((x) => (x.id === id ? { ...x, in: v } : x)) }
  }
  const v = Math.min(sourceDuration, Math.max(value, c.in + 0.2))
  const d = v - c.out
  const end = start + clipLen(c)
  const rippled = d < 0 ? rippleRemove(base, end + d, end) : rippleInsert(base, end, d)
  return { ...rippled, clips: base.clips.map((x) => (x.id === id ? { ...x, out: v } : x)) }
}

export function moveSeqClip(id: string, toIndex: number) {
  updateEdit((e) => {
    const from = e.clips.findIndex((c) => c.id === id)
    if (from < 0) return e
    const clips = [...e.clips]
    const [c] = clips.splice(from, 1)
    clips.splice(Math.max(0, Math.min(toIndex > from ? toIndex - 1 : toIndex, clips.length)), 0, c)
    return clips.every((x, k) => x.id === e.clips[k].id) ? e : { ...e, clips }
  })
}

/**
 * Register freshly imported sources on the project and append them as clips.
 * iloveframes recordings arrive with their tracking data, so they get smart
 * zooms right away and the cinematic cursor is switched on for them.
 */
export function appendSources(sources: MediaSource[]) {
  if (!sources.length) return
  track('clip_imported', { n: sources.length, recordings: sources.filter((s) => s.track).length })
  useEditor.getState().setProject((p) => ({ ...p, sources: [...(p.sources ?? []), ...sources] }))
  const project = useEditor.getState().project!
  updateEdit((e) => {
    const from = seqDuration(e.clips)
    const clips = [...e.clips, ...sources.map((s) => ({ id: uid(), source: s.id, in: 0, out: s.duration }))]
    const next: EditState = { ...e, clips }
    if (sources.some((s) => s.track)) {
      const kept = e.zoom.segments
      const fresh = autoZoomSegments(project, clips, 1.5, e.crops).filter((z) => z.start >= from - 1e-3 && !kept.some((k) => z.start < k.end && z.end > k.start))
      next.zoom = { ...e.zoom, segments: [...kept, ...fresh].sort((a, b) => a.start - b.start) }
    }
    if (sources.some((s) => s.track && !s.track.cursorBaked)) next.cursor = { ...e.cursor, enabled: true }
    if (sources.some((s) => s.camera) && !project.camera) next.camera = { ...e.camera, enabled: true }
    return next
  })
}

// ---- transitions between clips ----
export const DEFAULT_TRANSITION: Transition = { kind: 'fade', duration: 0.6 }

/** Set (or clear with null) the transition into a clip. */
export function setTransition(clipId: string, t: Transition | null) {
  if (t) track('transition_set', { kind: t.kind })
  updateEdit((e) => ({ ...e, clips: e.clips.map((c) => (c.id === clipId ? { ...c, tIn: t ?? undefined } : c)) }))
}

/** Same transition on every cut. */
export function setAllTransitions(t: Transition | null) {
  if (t) track('transition_set', { kind: t.kind, all: true })
  updateEdit((e) => ({ ...e, clips: e.clips.map((c, i) => (i === 0 ? c : { ...c, tIn: t ?? undefined })) }))
}

// ---- text overlays ----
/** Add a text overlay at T, squeezed into the free gap of the text lane. */
export function addTextAt(t: number, style: TextStyle = 'title', len = 3) {
  const { edit } = useEditor.getState()
  if (!edit) return null
  const total = seqDuration(edit.clips)
  const o = makeText(style, t, total, len)
  for (const r of edit.texts) {
    if (r.start <= o.start && r.end > o.start) o.start = r.end + 0.05
    if (r.start > o.start && r.start < o.end) o.end = r.start - 0.05
  }
  if (o.end - o.start < 0.4) {
    // no room on the lane here: put it at the end of the video instead
    const last = Math.max(0, ...edit.texts.map((r) => r.end))
    if (total - last < 0.6) return null
    o.start = last + 0.05
    o.end = Math.min(total, o.start + len)
  }
  track('text_added', { style })
  updateEdit((e) => ({ ...e, texts: [...e.texts, o].sort((a, b) => a.start - b.start) }))
  useEditor.getState().select(o.id)
  return o
}

export function patchText(id: string, patch: Partial<TextOverlay>, history = true) {
  updateEdit((e) => ({ ...e, texts: e.texts.map((r) => (r.id === id ? { ...r, ...patch } : r)) }), history)
}

export function removeText(id: string) {
  updateEdit((e) => ({ ...e, texts: e.texts.filter((r) => r.id !== id) }))
  if (useEditor.getState().selected === id) useEditor.getState().select(null)
}

/** Loudness of a sequence clip's own sound. */
export function setClipVolume(id: string, volume: number, history = true) {
  updateEdit((e) => ({ ...e, clips: e.clips.map((c) => (c.id === id ? { ...c, volume } : c)) }), history)
}
