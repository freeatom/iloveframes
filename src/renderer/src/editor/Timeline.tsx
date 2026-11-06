import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, EyeOff, Film, MousePointerClick, Plus, Type, ZoomIn } from 'lucide-react'
import { addClipAt, addHideAt, addSegmentAt, addTextAt, appendSources, moveSeqClip, patchClip, patchHide, patchSegment, patchText, trimSeqClip, useEditor, updateEdit } from './store'
import { player } from './Preview'
import { mediaUrl, type EditState, type SeqClip } from '@/engine/types'
import { clipLen, seqDuration, seqEvents, seqStarts, sourceInfo, transitionHalf, type SourceInfo } from '@/engine/sequence'
import { TransitionHandle } from './Transitions'
import { cn, fmtTime } from '@/lib/utils'
import { transitionFor } from '@/engine/motion'
import { Tip } from '@/components/ui/tooltip'

const TRACK_X = 76 // left gutter for labels
/** vertical spot of each lane (px from the top of the timeline) */
const L = { zoom: { top: 102, h: 34 }, hide: { top: 142, h: 28 }, text: { top: 176, h: 30 }, audio: { top: 212, h: 34 } }

const THUMBS_PER_SOURCE = 48
const thumbCache = new Map<string, { list: string[]; listeners: Set<() => void>; started: boolean }>()

/** Evenly spaced thumbnails across a whole source video, generated once and shared. */
export function useSourceThumbs(src: string, duration: number) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!duration) return
    let entry = thumbCache.get(src)
    if (!entry) {
      entry = { list: [], listeners: new Set(), started: false }
      thumbCache.set(src, entry)
    }
    const e = entry
    const on = () => force((n) => n + 1)
    e.listeners.add(on)
    if (!e.started) {
      e.started = true
      const v = document.createElement('video')
      v.src = src
      v.muted = true
      v.preload = 'auto'
      const c = document.createElement('canvas')
      v.addEventListener('loadeddata', async () => {
        c.height = 72
        c.width = Math.round((72 * v.videoWidth) / v.videoHeight)
        const ctx = c.getContext('2d')!
        for (let i = 0; i < THUMBS_PER_SOURCE; i++) {
          v.currentTime = Math.min(duration - 0.05, ((i + 0.5) / THUMBS_PER_SOURCE) * duration)
          await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
          ctx.drawImage(v, 0, 0, c.width, c.height)
          e.list.push(c.toDataURL('image/jpeg', 0.6))
          if (i % 6 === 5 || i === THUMBS_PER_SOURCE - 1) e.listeners.forEach((l) => l())
        }
        v.removeAttribute('src')
        v.load()
      })
    }
    return () => {
      e.listeners.delete(on)
    }
  }, [src, duration])
  return thumbCache.get(src)?.list ?? []
}

function ClipBlock({ clip, src, x, w, pps, selected, onDown, onEdge, label, showLabel }: { clip: SeqClip; src: SourceInfo; x: number; w: number; pps: number; selected: boolean; onDown: (e: React.PointerEvent) => void; onEdge: (edge: 'in' | 'out') => (e: React.PointerEvent) => void; label: string; showLabel: boolean }) {
  const thumbs = useSourceThumbs(src.url, src.duration)
  const step = src.duration / THUMBS_PER_SOURCE
  return (
    <div
      className={cn('group absolute top-10 h-14 cursor-grab overflow-hidden rounded-xl bg-white/[0.03] ring-1 transition-shadow active:cursor-grabbing', selected ? 'z-10 ring-2 ring-brand-orchid shadow-[0_0_0_4px_rgba(192,132,252,.18)]' : 'ring-white/[0.08] hover:ring-white/25')}
      style={{ left: x, width: Math.max(6, w) }}
      onPointerDown={onDown}
    >
      {thumbs.map((t, i) => {
        const at = i * step
        if (at + step < clip.in || at > clip.out) return null
        return <img key={i} src={t} draggable={false} className="pointer-events-none absolute top-0 h-full object-cover opacity-80" style={{ left: (at - clip.in) * pps, width: step * pps + 1 }} />
      })}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/50" />
      {showLabel && w > 70 && <div className="pointer-events-none absolute left-2 top-1.5 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur">{label}</div>}
      <div className={cn('absolute inset-y-0 left-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center transition-colors', selected ? 'bg-brand-orchid' : 'bg-white/0 group-hover:bg-white/25')} onPointerDown={onEdge('in')}>
        <div className={cn('h-5 w-0.5 rounded-full', selected ? 'bg-black/50' : 'bg-white/70 opacity-0 group-hover:opacity-100')} />
      </div>
      <div className={cn('absolute inset-y-0 right-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center transition-colors', selected ? 'bg-brand-orchid' : 'bg-white/0 group-hover:bg-white/25')} onPointerDown={onEdge('out')}>
        <div className={cn('h-5 w-0.5 rounded-full', selected ? 'bg-black/50' : 'bg-white/70 opacity-0 group-hover:opacity-100')} />
      </div>
    </div>
  )
}

type Lane = 'zoom' | 'hide' | 'text'
type Span = { id: string; start: number; end: number }

type Drag =
  | { kind: 'seg-move'; lane: Lane; id: string; offset: number; len: number }
  | { kind: 'seg-start' | 'seg-end'; lane: Lane; id: string }
  | { kind: 'seq-move'; id: string; startX: number }
  | { kind: 'seq-in' | 'seq-out'; id: string; startX: number; base: EditState; pps: number; value: number; srcDur: number }
  | { kind: 'scrub' }
  | { kind: 'clip-move'; id: string; offset: number }
  | { kind: 'clip-start' | 'clip-end'; id: string }

/** Moves with the playback clock via direct style writes: zero React work per frame. */
function Playhead({ pps, zoomed, scrollRef, onGrab }: { pps: number; zoomed: boolean; scrollRef: React.RefObject<HTMLDivElement>; onGrab: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const apply = (t: number) => {
      const x = TRACK_X + t * pps
      if (ref.current) ref.current.style.transform = `translate3d(${x}px,0,0)`
      const el = scrollRef.current
      if (el && zoomed && (x < el.scrollLeft + TRACK_X || x > el.scrollLeft + el.clientWidth - 40)) el.scrollLeft = x - TRACK_X - 40
    }
    apply(useEditor.getState().time)
    return useEditor.subscribe((s, prev) => {
      if (s.time !== prev.time) apply(s.time)
    })
  }, [pps, zoomed, scrollRef])
  return (
    <div ref={ref} className="pointer-events-none absolute bottom-0 left-0 top-0 z-30 will-change-transform">
      <div className="pointer-events-auto absolute -left-[7px] top-1 h-4 w-[14px] cursor-ew-resize rounded-[4px] bg-white shadow-[0_2px_8px_rgba(0,0,0,.6)]" onPointerDown={onGrab} />
      <div className="absolute -left-px bottom-2 top-4 w-[2px] rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,.4)]" />
    </div>
  )
}

export function Timeline() {
  const project = useEditor((s) => s.project)!
  const edit = useEditor((s) => s.edit)!
  const selected = useEditor((s) => s.selected)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [zoom, setZoom] = useState(1)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [hoverLane, setHoverLane] = useState<Lane | null>(null)
  const [dropT, setDropT] = useState<number | null>(null)
  const drag = useRef<Drag | null>(null)
  const [frozen, setFrozen] = useState<number | null>(null)
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const seqDur = seqDuration(edit.clips)
  const dur = Math.max(0.1, frozen ?? seqDur)
  const starts = seqStarts(edit.clips)
  const seqClicks = useMemo(() => seqEvents(project, edit.clips, edit.crops).clicks, [project, edit.clips, edit.crops])

  useEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const inner = Math.max(200, (width - TRACK_X - 24) * zoom)
  const pps = inner / dur
  const xOf = (t: number) => TRACK_X + t * pps
  const tOf = (clientX: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(dur, (clientX - r.left + el.scrollLeft - TRACK_X) / pps))
  }


  const ticks = useMemo(() => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]
    const step = steps.find((s) => s * pps >= 70) ?? 300
    const arr: number[] = []
    for (let t = 0; t <= dur + 1e-6; t += step) arr.push(t)
    return { arr, step }
  }, [pps, dur])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const t = tOf(e.clientX)
      if (d.kind === 'scrub') player.seek(t)
      else if (d.kind === 'seq-in' || d.kind === 'seq-out') {
        const v = d.value + (e.clientX - d.startX) / d.pps
        updateEdit(() => trimSeqClip(d.base, d.id, d.kind === 'seq-in' ? 'in' : 'out', v, d.srcDur), false)
      } else if (d.kind === 'seq-move') {
        if (Math.abs(e.clientX - d.startX) < 4) return
        const clips = useEditor.getState().edit!.clips
        const st = seqStarts(clips)
        let idx = clips.length
        for (let k = 0; k < clips.length; k++) if (t < st[k] + clipLen(clips[k]) / 2) { idx = k; break }
        setInsertAt(idx)
      }
      else if (d.kind === 'clip-move' || d.kind === 'clip-start' || d.kind === 'clip-end') {
        const c = useEditor.getState().edit!.audio.clips.find((x) => x.id === d.id)
        if (!c) return
        if (d.kind === 'clip-move') patchClip(c.id, { start: Math.max(0, Math.min(t - d.offset, dur - 0.1)) }, false)
        else if (d.kind === 'clip-end') patchClip(c.id, { duration: Math.max(0.2, Math.min(t - c.start, c.sourceDuration - c.offset)) }, false)
        else {
          // trimming the head moves start and the in-point together
          const end = c.start + c.duration
          let ns = Math.min(t, end - 0.2)
          ns = Math.max(ns, c.start - c.offset, 0)
          const delta = ns - c.start
          patchClip(c.id, { start: ns, offset: c.offset + delta, duration: c.duration - delta }, false)
        }
      }
      else if ('lane' in d) {
        const ed = useEditor.getState().edit!
        const segs: Span[] = d.lane === 'zoom' ? ed.zoom.segments : d.lane === 'hide' ? ed.cursor.hidden : ed.texts
        const patch = d.lane === 'zoom' ? patchSegment : d.lane === 'hide' ? patchHide : patchText
        const minLen = d.lane === 'zoom' ? 0.6 : d.lane === 'hide' ? 0.3 : 0.4
        const s = segs.find((x) => x.id === d.id)
        if (!s) return
        const others = segs.filter((x) => x.id !== d.id)
        const prevEnd = Math.max(0, ...others.filter((o) => o.end <= s.start + 1e-3).map((o) => o.end))
        const nextStart = Math.min(dur, ...others.filter((o) => o.start >= s.end - 1e-3).map((o) => o.start))
        if (d.kind === 'seg-move') {
          const start = Math.max(prevEnd, Math.min(t - d.offset, nextStart - d.len))
          patch(d.id, { start, end: start + d.len }, false)
        } else if (d.kind === 'seg-start') patch(d.id, { start: Math.max(prevEnd, Math.min(t, s.end - minLen)) }, false)
        else patch(d.id, { end: Math.min(nextStart, Math.max(t, s.start + minLen)) }, false)
      }
    }
    const up = () => {
      const d = drag.current
      if (d && d.kind === 'seq-move' && insertRef.current !== null) moveSeqClip(d.id, insertRef.current)
      else if (d && d.kind !== 'scrub') useEditor.getState().checkpoint()
      drag.current = null
      document.body.style.cursor = ''
      setFrozen(null)
      setInsertAt(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  })

  const insertRef = useRef<number | null>(null)
  insertRef.current = insertAt

  const startDrag = (d: Drag, cursor = 'grabbing') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    drag.current = d
    document.body.style.cursor = cursor
    if (d.kind === 'scrub') player.seek(tOf(e.clientX))
  }

  function renderLane(o: {
    lane: Lane
    top: number
    height: number
    items: Span[]
    hint: string
    onAdd: (t: number) => void
    minW: number
    style: (selected: boolean) => string
    label: (s: Span) => React.ReactNode
    keyframes?: (s: Span) => { t: number; tip: string }[]
  }) {
    const free = hoverT !== null && hoverLane === o.lane && !o.items.some((s) => hoverT >= s.start - 0.3 && hoverT <= s.end + 0.3)
    return (
      <div
        data-tour={`lane-${o.lane}`}
        className="absolute rounded-xl bg-white/[0.02] ring-1 ring-white/[0.05]"
        style={{ left: xOf(0), width: inner, top: o.top, height: o.height }}
        onPointerEnter={() => setHoverLane(o.lane)}
        onPointerLeave={() => setHoverLane(null)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) useEditor.getState().select(null)
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) o.onAdd(tOf(e.clientX))
        }}
      >
        {free && (
          <div className="pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-zinc-600" style={{ left: hoverT! * pps + 6 }}>
            <Plus className="h-3 w-3" /> {o.hint}
          </div>
        )}
        {o.items.flatMap((s) =>
          (o.keyframes?.(s) ?? []).map((k, i) => (
                <Tip key={s.id + i} content={k.tip}>
                  <button
                    className="group/kf absolute z-20 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center"
                    style={{ left: k.t * pps, top: o.height - 4 }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      useEditor.getState().select(s.id)
                      player.seek(k.t)
                    }}
                  >
                    <span className="block h-[9px] w-[9px] rotate-45 rounded-[2px] bg-white shadow-[0_0_0_2px_rgba(0,0,0,.35),0_0_8px_rgba(255,255,255,.6)] transition-transform duration-150 group-hover/kf:scale-[1.45]" />
                  </button>
                </Tip>
          ))
        )}
        {o.items.map((s) => {
          const sel = s.id === selected
          const w = (s.end - s.start) * pps
          return (
            <div
              key={s.id}
              className={cn('absolute top-1 flex cursor-grab items-center overflow-hidden rounded-lg border text-[11px] font-medium transition-[box-shadow,background] active:cursor-grabbing', o.style(sel))}
              style={{ left: s.start * pps, width: Math.max(8, w), height: o.height - 8 }}
              onPointerDown={(e) => {
                useEditor.getState().select(s.id)
                startDrag({ kind: 'seg-move', lane: o.lane, id: s.id, offset: tOf(e.clientX) - s.start, len: s.end - s.start })(e)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                player.seek(s.start)
              }}
            >
              <div className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => { useEditor.getState().select(s.id); startDrag({ kind: 'seg-start', lane: o.lane, id: s.id }, 'ew-resize')(e) }} />
              {w > o.minW && <span className="pointer-events-none flex items-center gap-1 truncate px-3">{o.label(s)}</span>}

              <div className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => { useEditor.getState().select(s.id); startDrag({ kind: 'seg-end', lane: o.lane, id: s.id }, 'ew-resize')(e) }} />
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-t border-white/[0.05] bg-[#0a0a0e]">
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            setZoom((z) => Math.max(1, Math.min(20, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
          }
        }}
        onPointerMove={(e) => setHoverT(tOf(e.clientX))}
        onPointerLeave={() => setHoverT(null)}
        onDragOver={(e) => {
          const types = [...e.dataTransfer.types]
          if (!types.includes('application/x-ilf-sound') && !types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropT(tOf(e.clientX))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropT(null)
        }}
        onDrop={async (e) => {
          e.preventDefault()
          const t = tOf(e.clientX)
          setDropT(null)
          const data = e.dataTransfer.getData('application/x-ilf-sound')
          if (data) {
            const snd = JSON.parse(data)
            addClipAt(snd, t, mediaUrl(snd.file))
            return
          }
          const all = [...e.dataTransfer.files].map((f) => window.ilf.pathForFile(f)).filter(Boolean)
          const isVideo = (p: string) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(p)
          const videoPaths = all.filter(isVideo)
          if (videoPaths.length) appendSources(await window.ilf.media.import(project.id, videoPaths))
          const paths = all.filter((p) => !isVideo(p))
          if (!paths.length) return
          const added = await window.ilf.sounds.import(paths)
          let at = t
          for (const snd of added) {
            addClipAt(snd, at, mediaUrl(snd.file))
            at += snd.duration
          }
          window.dispatchEvent(new Event('ilf:sounds-changed'))
        }}
      >
        <div className="relative h-full" style={{ width: TRACK_X + inner + 24 }}>
          {/* ruler */}
          <div className="absolute left-0 right-0 top-0 h-7 cursor-text border-b border-white/[0.04]" onPointerDown={startDrag({ kind: 'scrub' }, 'ew-resize')}>
            {ticks.arr.map((t) => (
              <div key={t} className="absolute top-0 h-full" style={{ left: xOf(t) }}>
                <div className="h-2 w-px bg-white/15" />
                <span className="absolute left-1.5 top-[9px] text-[10px] tabular-nums text-zinc-500">{ticks.step < 1 ? t.toFixed(1) + 's' : fmtTime(t)}</span>
              </div>
            ))}
          </div>

          {/* labels */}
          <div className="pointer-events-none absolute left-0 top-0 z-20 w-[68px] pl-3 text-[11px] font-medium text-zinc-500">
            {[
              { top: 40, h: 56, icon: Film, label: 'Clip' },
              { top: L.zoom.top, h: L.zoom.h, icon: ZoomIn, label: 'Zoom' },
              { top: L.hide.top, h: L.hide.h, icon: EyeOff, label: 'Cursor' },
              { top: L.text.top, h: L.text.h, icon: Type, label: 'Text' },
              { top: L.audio.top, h: L.audio.h, icon: AudioLines, label: 'Audio' }
            ].map((r) => (
              <div key={r.label} className="absolute flex items-center gap-1.5" style={{ top: r.top, height: r.h }}>
                <r.icon className="h-3.5 w-3.5" /> {r.label}
              </div>
            ))}
          </div>

          {/* sequence: clips back to back (the anchor lets the walkthrough point at the whole row) */}
          <div data-tour="lane-clips" className="pointer-events-none absolute top-10 h-14 rounded-xl" style={{ left: xOf(0), width: inner }} />
          {edit.clips.map((c, i) => {
            const src = sourceInfo(project, c.source)
            if (!src) return null
            return (
              <ClipBlock
                key={c.id}
                clip={c}
                src={src}
                x={xOf(starts[i])}
                w={clipLen(c) * pps - (i < edit.clips.length - 1 ? 2 : 0)}
                pps={pps}
                selected={selected === c.id}
                label={src.name}
                showLabel={edit.clips.length > 1}
                onDown={(e) => {
                  if (e.button !== 0) return
                  useEditor.getState().select(c.id)
                  player.seek(tOf(e.clientX))
                  setFrozen(seqDur)
                  startDrag({ kind: 'seq-move', id: c.id, startX: e.clientX }, 'grabbing')(e)
                }}
                onEdge={(edge) => (e) => {
                  useEditor.getState().select(c.id)
                  setFrozen(seqDur)
                  startDrag({ kind: edge === 'in' ? 'seq-in' : 'seq-out', id: c.id, startX: e.clientX, base: edit, pps, value: edge === 'in' ? c.in : c.out, srcDur: src.duration }, 'ew-resize')(e)
                }}
              />
            )
          })}
          {/* transitions: the blended span, and a button on every cut */}
          {edit.clips.map((c, i) => {
            const h = transitionHalf(edit.clips, i)
            if (h <= 0.01) return null
            return (
              <div
                key={'tr' + c.id}
                className="pointer-events-none absolute top-10 z-[5] h-14 rounded-lg border border-brand-orchid/50 bg-brand-soft [background-size:200%_100%]"
                style={{ left: xOf(starts[i] - h), width: Math.max(4, 2 * h * pps) }}
              >
                <div className="absolute inset-0 rounded-lg opacity-40 [background:repeating-linear-gradient(115deg,transparent_0_5px,rgba(255,255,255,.18)_5px_6px)]" />
              </div>
            )
          })}
          {insertAt === null &&
            edit.clips.map((c, i) => (i === 0 ? null : <TransitionHandle key={'th' + c.id} clipId={c.id} value={c.tIn} x={xOf(starts[i]) - 1} top={68} />))}
          {seqClicks.map((c, i) => (
            <div key={i} className="pointer-events-none absolute top-[90px] z-10 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-brand-rose shadow-[0_0_6px_rgba(255,107,157,.8)]" style={{ left: xOf(c.t) }} />
          ))}
          {insertAt !== null && (
            <div className="pointer-events-none absolute top-9 z-20 h-16 w-1 -translate-x-1/2 rounded-full bg-brand-orchid shadow-[0_0_10px_rgba(192,132,252,.9)]" style={{ left: xOf(insertAt >= edit.clips.length ? seqDur : starts[insertAt]) }} />
          )}

          {/* zoom lane */}
          {renderLane({
            lane: 'zoom',
            top: L.zoom.top,
            height: L.zoom.h,
            items: edit.zoom.segments,
            hint: 'double-click to add zoom',
            onAdd: addSegmentAt,
            minW: 60,
            style: (sel) =>
              sel
                ? 'border-white/70 bg-gradient-to-r from-brand-pink via-brand-orchid to-brand-violet text-white shadow-[0_0_0_3px_rgba(192,132,252,.25),0_8px_20px_-6px_rgba(214,77,170,.6)]'
                : 'border-white/10 bg-gradient-to-r from-brand-pink/55 via-brand-orchid/50 to-brand-violet/55 text-white/90 hover:from-brand-pink/75 hover:via-brand-orchid/70 hover:to-brand-violet/75',
            keyframes: (sp) => {
              const T = transitionFor(edit.zoom.speed)
              const tr = Math.min(T, (sp.end - sp.start) / 2)
              if (sp.end - sp.start - 2 * tr < 0.6) return [{ t: (sp.start + sp.end) / 2, tip: 'Peak zoom. Click to jump here and edit' }]
              return [
                { t: sp.start + tr, tip: 'Fully zoomed in. Click to jump here and edit' },
                { t: sp.end - tr, tip: 'Zoom out starts. Click to jump here and edit' }
              ]
            },
            label: (sp) => {
              const z = sp as (typeof edit.zoom.segments)[number]
              return (
                <>
                  {z.follow ? <MousePointerClick className="h-3 w-3 shrink-0" /> : <ZoomIn className="h-3 w-3 shrink-0" />}
                  {z.scale.toFixed(1)}×
                </>
              )
            }
          })}

          {/* cursor-hide lane */}
          {renderLane({
            lane: 'hide',
            top: L.hide.top,
            height: L.hide.h,
            items: edit.cursor.hidden,
            hint: 'double-click to hide cursor here',
            onAdd: addHideAt,
            minW: 70,
            style: (sel) =>
              sel
                ? 'border-white/70 bg-brand-deep/90 text-white shadow-[0_0_0_3px_rgba(124,58,237,.3)]'
                : 'border-white/10 bg-brand-deep/40 text-white/90 hover:bg-brand-deep/60',
            label: () => (
              <>
                <EyeOff className="h-3 w-3 shrink-0" /> Hidden
              </>
            )
          })}

          {/* text lane: titles, captions, lower thirds */}
          {renderLane({
            lane: 'text',
            top: L.text.top,
            height: L.text.h,
            items: edit.texts,
            hint: 'double-click to add text (T)',
            onAdd: (t) => addTextAt(t, 'title'),
            minW: 44,
            style: (sel) =>
              sel
                ? 'border-white/70 bg-amber-400/85 text-black shadow-[0_0_0_3px_rgba(251,191,36,.28)]'
                : 'border-white/10 bg-amber-400/30 text-amber-50 hover:bg-amber-400/45',
            label: (sp) => (
              <>
                <Type className="h-3 w-3 shrink-0" /> <span className="truncate">{(sp as (typeof edit.texts)[number]).text.split(/\r?\n/)[0] || 'Text'}</span>
              </>
            )
          })}

          {/* audio lane: drop sounds here */}
          <div
            data-tour="lane-audio"
            className={cn('absolute rounded-xl ring-1 transition-colors', dropT !== null ? 'bg-brand-rose/[0.08] ring-brand-rose/50' : 'bg-white/[0.02] ring-white/[0.05]')}
            style={{ left: xOf(0), width: inner, top: L.audio.top, height: L.audio.h }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) useEditor.getState().select(null)
            }}
          >
            {edit.audio.clips.length === 0 && dropT === null && (
              <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-[10.5px] text-zinc-600">Drag sounds here from the Audio tab, or drop audio files from your computer</div>
            )}
            {dropT !== null && <div className="pointer-events-none absolute inset-y-1 w-0.5 rounded bg-brand-rose shadow-[0_0_8px_rgba(255,107,157,.8)]" style={{ left: dropT * pps }} />}
            {edit.audio.clips.map((c) => {
              const sel = c.id === selected
              const w = c.duration * pps
              return (
                <div
                  key={c.id}
                  className={cn(
                    'absolute top-1 flex h-[26px] cursor-grab items-center overflow-hidden rounded-lg border text-[11px] font-medium active:cursor-grabbing',
                    sel ? 'border-white/70 bg-brand-rose/85 text-white shadow-[0_0_0_3px_rgba(255,107,157,.25)]' : 'border-white/10 bg-brand-rose/35 text-white/90 hover:bg-brand-rose/50'
                  )}
                  style={{ left: c.start * pps, width: Math.max(8, w) }}
                  onPointerDown={(e) => {
                    useEditor.getState().select(c.id)
                    startDrag({ kind: 'clip-move', id: c.id, offset: tOf(e.clientX) - c.start })(e)
                  }}
                >
                  <div className="pointer-events-none absolute inset-0 opacity-30 [background:repeating-linear-gradient(90deg,transparent_0_3px,rgba(255,255,255,.5)_3px_4px)] [mask-image:linear-gradient(transparent_20%,#000_50%,transparent_80%)]" />
                  <div className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => { useEditor.getState().select(c.id); startDrag({ kind: 'clip-start', id: c.id }, 'ew-resize')(e) }} />
                  {w > 50 && <span className="pointer-events-none relative truncate px-3">{c.name}</span>}
                  <div className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => { useEditor.getState().select(c.id); startDrag({ kind: 'clip-end', id: c.id }, 'ew-resize')(e) }} />
                </div>
              )
            })}
          </div>

          {/* playhead */}
          <Playhead pps={pps} zoomed={zoom > 1} scrollRef={scrollRef} onGrab={startDrag({ kind: 'scrub' }, 'ew-resize')} />
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-white/[0.04] px-4 text-[10.5px] text-zinc-600">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-brand-rose" /> clicks</span>
        <span className="min-w-0 truncate">Drag edges to trim · drag clips to reorder · S split · T text · double-click a lane to add · round button on a cut for transitions · {navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'}+scroll to zoom</span>
        <div className="flex-1" />
        <input type="range" min={1} max={20} step={0.1} value={zoom} onChange={(e) => setZoom(+e.target.value)} className="w-28 accent-brand-orchid" />
      </div>
    </div>
  )
}
