import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Camera, Check, CircleHelp, Type, AlignCenter, Copy, Clapperboard, Crop, Crosshair, FilePlus2, Scissors, EyeOff, ImagePlus, X, Upload, Music, GripVertical, Play, Square, Plus, LayoutTemplate, MousePointer2, MousePointerClick, Palette, RotateCcw, Sparkles, Trash2, Volume2, ZoomIn
} from 'lucide-react'
import { useEditor, updateEdit, addTextAt, patchText, removeText, setClipVolume, patchSegment, removeSegment, addSegmentAt, addHideAt, removeHide, cursorPosAt, addClipAt, patchClip, removeClip, splitAtPlayhead, deleteSeqClip, appendSources, setTransition, setAllTransitions } from './store'
import { player } from './Preview'
import { GRADIENTS, SOLIDS, WALLPAPERS, backgroundThumb } from '@/engine/backgrounds'
import { STUDIO } from '@/engine/studio'
import { autoZoomSegments } from '@/engine/motion'
import { playSfx, keyVariant, CLICK_SOUNDS, ZOOM_SOUNDS, TYPING_SOUNDS } from '@/engine/sounds'
import type { Aspect, CamPos, CursorStyle, DeviceColor, DeviceKind, EditState, TextOverlay, TextStyle } from '@/engine/types'
import { TEXT_COLORS, TEXT_PRESETS } from '@/engine/overlays'
import { LabeledSlider, Slider } from '@/components/ui/slider'
import { SwitchRow } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { cn, fmtTime } from '@/lib/utils'
import { mediaUrl, defaultEdit, uid } from '@/engine/types'
import { MAIN, clipAt, cropOf, seqDuration, seqEvents, sourceInfo, toCrop, trackOf, type SourceInfo } from '@/engine/sequence'
import { TransitionIcon, TransitionPicker } from './Transitions'
import { openCrop } from './CropEditor'
import { offerTour, replayTour } from '@/components/Tour'
import { DEVICE_FRAMES_ENABLED } from '@/engine/devices'
import { trackOncePerSession } from '@/lib/telemetry'
import { useSourceThumbs } from './Timeline'

type Tab = 'clips' | 'background' | 'frame' | 'cursor' | 'zoom' | 'text' | 'camera' | 'audio'

const TABS: { id: Tab; icon: any; label: string }[] = [
  { id: 'clips', icon: Clapperboard, label: 'Clips' },
  { id: 'background', icon: Palette, label: 'Background' },
  { id: 'frame', icon: LayoutTemplate, label: 'Frame' },
  { id: 'cursor', icon: MousePointer2, label: 'Cursor' },
  { id: 'zoom', icon: ZoomIn, label: 'Zoom' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'camera', icon: Camera, label: 'Camera' },
  { id: 'audio', icon: Volume2, label: 'Audio' }
]

const set = (fn: (e: EditState) => EditState, history = true) => updateEdit(fn, history)
const live = (fn: (e: EditState) => EditState) => updateEdit(fn, false)

export function Section({ title, children, action, tour }: { title: string; children: React.ReactNode; action?: React.ReactNode; tour?: string }) {
  return (
    <div data-tour={tour} className="border-b border-white/[0.05] px-5 py-5 last:border-0">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{title}</h3>
        {action}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function Swatch({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'relative aspect-[16/10] overflow-hidden rounded-[10px] transition-all duration-150 hover:scale-[1.04]',
        active ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0e0e13]' : 'ring-1 ring-white/10 hover:ring-white/25'
      )}
    >
      {children}
    </button>
  )
}

/** Thumbnails are painted one per frame so opening the panel never stutters. */
let thumbQueue: (() => void)[] = []
let thumbBusy = false
function pumpThumbs() {
  if (thumbBusy) return
  thumbBusy = true
  requestAnimationFrame(function step() {
    const job = thumbQueue.shift()
    job?.()
    if (thumbQueue.length) requestAnimationFrame(step)
    else thumbBusy = false
  })
}
function LazyThumb({ bg }: { bg: EditState['background'] }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    thumbQueue.push(() => alive && setSrc(backgroundThumb(bg)))
    pumpThumbs()
    return () => {
      alive = false
    }
  }, [bg.kind, bg.value])
  return src ? <img src={src} className="h-full w-full animate-[fadein_.35s_ease] object-cover" /> : <div className="h-full w-full animate-pulse bg-white/[0.04]" />
}

type LibWall = Awaited<ReturnType<typeof window.ilf.wallpapers.list>>[number]
let libCache: LibWall[] = []

function useLibrary() {
  const [list, setList] = useState<LibWall[]>(libCache)
  const refresh = async () => {
    libCache = await window.ilf.wallpapers.list()
    setList(libCache)
    return libCache
  }
  useEffect(() => {
    refresh()
  }, [])
  return { list, refresh }
}

function LibrarySection({ title, items, bg, onPick, onRemove, action }: { title: string; items: LibWall[]; bg: EditState['background']; onPick: (w: LibWall) => void; onRemove?: (w: LibWall) => void; action?: React.ReactNode }) {
  return (
    <Section title={title} action={action}>
      <div className="grid grid-cols-3 gap-2">
        {items.map((w) => (
          <div key={w.id} className="group/w relative">
            <Swatch title={w.name} active={bg.kind === 'image' && bg.value === (w.url ?? mediaUrl(w.file))} onClick={() => onPick(w)}>
              <img src={w.thumbUrl ?? mediaUrl(w.thumb)} className="h-full w-full animate-[fadein_.35s_ease] object-cover" draggable={false} />
            </Swatch>
            {onRemove && (
              <button
                title="Remove from library"
                onClick={() => onRemove(w)}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-700 text-zinc-300 opacity-0 shadow ring-1 ring-white/10 transition-opacity hover:bg-red-500 hover:text-white group-hover/w:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}

function BackgroundPanel({ edit }: { edit: EditState }) {
  return (
    <BackgroundPicker
      bg={edit.background}
      onChange={(b, history = true) => {
        trackOncePerSession('bg:' + b.kind, 'background_changed', { kind: b.kind })
        updateEdit((e) => ({ ...e, background: b }), history)
      }}
      onCommit={() => useEditor.getState().checkpoint()}
    />
  )
}

/** All background choices (macOS, Studio, mesh, gradients, solids, your photos). Shared by the video and screenshot studios. */
export function BackgroundPicker({ bg, onChange, onCommit }: { bg: EditState['background']; onChange: (bg: EditState['background'], history?: boolean) => void; onCommit?: () => void }) {
  const choose = (kind: EditState['background']['kind'], value: string) => onChange({ ...bg, kind, value })
  const { list, refresh } = useLibrary()
  const pick = (w: LibWall) => choose('image', w.url ?? mediaUrl(w.file))
  const groups = [...new Set(list.map((w) => w.group))].sort((a, b) => (a === 'macOS' ? -1 : b === 'macOS' ? 1 : a === 'Library' ? 1 : b === 'Library' ? -1 : a.localeCompare(b)))
  const importMore = async () => {
    const added = await window.ilf.wallpapers.import('Library')
    await refresh()
    if (added?.[0]) pick(added[0])
  }
  return (
    <>
      {groups.filter((g) => g !== 'Library').map((g) => (
        <LibrarySection key={g} title={g} items={list.filter((w) => w.group === g)} bg={bg} onPick={pick} />
      ))}
      <Section title="Studio" tour="bg-studio">
        <div className="grid grid-cols-3 gap-2">
          {STUDIO.map((w) => (
            <Swatch key={w.id} title={w.name} active={bg.kind === 'wallpaper' && bg.value === w.id} onClick={() => choose('wallpaper', w.id)}>
              <LazyThumb bg={{ kind: 'wallpaper', value: w.id, blur: 0 }} />
            </Swatch>
          ))}
        </div>
      </Section>
      <Section title="Mesh gradients">
        <div className="grid grid-cols-4 gap-2">
          {WALLPAPERS.map((w) => (
            <Swatch key={w.id} title={w.name} active={bg.kind === 'wallpaper' && bg.value === w.id} onClick={() => choose('wallpaper', w.id)}>
              <LazyThumb bg={{ kind: 'wallpaper', value: w.id, blur: 0 }} />
            </Swatch>
          ))}
        </div>
      </Section>
      <Section title="Gradients">
        <div className="grid grid-cols-5 gap-2">
          {GRADIENTS.map((g) => (
            <Swatch key={g.id} title={g.name} active={bg.kind === 'gradient' && bg.value === g.id} onClick={() => choose('gradient', g.id)}>
              <div className="h-full w-full" style={{ background: `linear-gradient(${g.angle}deg, ${g.stops.join(',')})` }} />
            </Swatch>
          ))}
        </div>
      </Section>
      <Section title="Solid">
        <div className="grid grid-cols-5 gap-2">
          {SOLIDS.map((c) => (
            <Swatch key={c} active={bg.kind === 'solid' && bg.value === c} onClick={() => choose('solid', c)}>
              <div className="h-full w-full" style={{ background: c }} />
            </Swatch>
          ))}
        </div>
        <label className="flex items-center gap-3 text-[12px] text-zinc-400">
          Custom color
          <input type="color" value={bg.kind === 'solid' ? bg.value : '#ff4d8d'} onChange={(e) => onChange({ ...bg, kind: 'solid', value: e.target.value }, false)} onBlur={() => onCommit?.()} className="h-7 w-12 cursor-pointer rounded border-0 bg-transparent" />
        </label>
      </Section>
      <div data-tour="bg-library">
      <LibrarySection
        title="Your library"
        items={list.filter((w) => w.group === 'Library')}
        bg={bg}
        onPick={pick}
        onRemove={async (w) => {
          await window.ilf.wallpapers.remove(w.id)
          refresh()
        }}
        action={
          <Button variant="ghost" size="sm" onClick={importMore}>
            <ImagePlus className="h-3.5 w-3.5" /> Add
          </Button>
        }
      />
      {list.every((w) => w.group !== 'Library') && (
        <div className="-mt-3 px-5 pb-5">
          <button onClick={importMore} className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-white/10 py-5 text-[12px] text-zinc-400 transition-colors hover:border-white/25 hover:bg-white/[0.02] hover:text-zinc-200">
            <ImagePlus className="h-5 w-5" />
            Add your own photos
            <span className="text-[10.5px] text-zinc-600">4K landscape looks best · any aspect ratio works</span>
          </button>
        </div>
      )}
      </div>
      {bg.kind === 'image' && (
        <Section title="Photo" tour="bg-photo">
          <LabeledSlider label="Blur" value={bg.blur} min={0} max={6} step={0.1} onChange={(v) => onChange({ ...bg, blur: v }, false)} format={(v) => v.toFixed(1)} />
        </Section>
      )}
    </>
  )
}

/** Crop status for the recording under the playhead, with a way into the crop editor. */
function CropSection({ edit }: { edit: EditState }) {
  const project = useEditor((s) => s.project)!
  const time = useEditor((s) => s.time)
  const hit = clipAt(edit.clips, time)
  const id = hit?.clip.source ?? MAIN
  const info = sourceInfo(project, id)
  const c = cropOf(edit.crops, id)
  const cropped = c.w < 0.999 || c.h < 0.999
  const W = info?.width ?? 0
  const H = info?.height ?? 0
  return (
    <Section title="Crop" tour="frame-crop">
      <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
        <div className="relative h-11 w-16 shrink-0 overflow-hidden rounded-md bg-white/[0.06] ring-1 ring-white/[0.08]">
          <div className="absolute rounded-[2px] bg-brand-orchid/30 ring-1 ring-brand-orchid" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-zinc-200">{cropped ? 'Cropped' : 'Full frame'}</div>
          <div className="truncate text-[11px] tabular-nums text-zinc-500">
            {cropped ? `${Math.round(c.w * W)} × ${Math.round(c.h * H)} of ${W} × ${H}` : `${W} × ${H} · ${info?.name ?? ''}`}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => openCrop()}><Crop className="h-3.5 w-3.5" /> {cropped ? 'Edit crop' : 'Crop video'}</Button>
        <Button variant="ghost" size="sm" disabled={!cropped} onClick={() => set((e) => { const crops = { ...(e.crops ?? {}) }; delete crops[id]; return { ...e, crops } })}>
          <RotateCcw className="h-3.5 w-3.5" /> Remove crop
        </Button>
      </div>
      <div className="text-[11px] leading-relaxed text-zinc-500">Cropping never changes your recording or its smart data. Zooms and the cursor follow the new framing.</div>
    </Section>
  )
}

/** Tiny laptop drawings for the device picker. */
function DeviceGlyph({ kind, color, on }: { kind: DeviceKind; color: DeviceColor; on: boolean }) {
  const stroke = on ? '#e9d5ff' : '#71717a'
  if (kind === 'none')
    return (
      <svg viewBox="0 0 44 28" className="h-7 w-11">
        <rect x="6" y="4" width="32" height="20" rx="3.5" fill="none" stroke={stroke} strokeWidth="1.5" />
      </svg>
    )
  const body = color === 'light' ? '#d4d4d8' : '#3f3f46'
  const mac = kind === 'macbook'
  return (
    <svg viewBox="0 0 44 28" className="h-7 w-11">
      <rect x="8" y="3" width="28" height="19" rx={mac ? 2.6 : 1.2} fill={body} stroke={stroke} strokeWidth="1.2" />
      <rect x="9.6" y="4.6" width="24.8" height="15.2" rx={mac ? 1.2 : 0.4} fill="#0a0a0c" />
      <circle cx="22" cy="3.9" r="0.45" fill="#52525b" />
      {mac ? (
        <path d="M3.5 22.2h37c0 1.4-1.3 2.3-3.2 2.3H6.7c-1.9 0-3.2-.9-3.2-2.3Z" fill={body} stroke={stroke} strokeWidth="1.1" />
      ) : (
        <>
          <rect x="11" y="21.3" width="22" height="1.3" rx=".6" fill="#18181b" />
          <rect x="6" y="22.2" width="32" height="2.4" rx=".7" fill={body} stroke={stroke} strokeWidth="1.1" />
        </>
      )}
    </svg>
  )
}

/** Put the recording on a laptop. */
function DeviceSection({ edit }: { edit: EditState }) {
  const d = edit.device ?? { kind: 'none' as DeviceKind, color: 'dark' as DeviceColor }
  const setD = (patch: Partial<NonNullable<EditState['device']>>) => set((e) => ({ ...e, device: { ...d, ...e.device, ...patch } }))
  return (
    <Section title="Device" tour="frame-device">
      <div className="grid grid-cols-3 gap-2">
        {([
          { v: 'none', label: 'None' },
          { v: 'macbook', label: 'MacBook' },
          { v: 'laptop', label: 'Windows laptop' }
        ] as { v: DeviceKind; label: string }[]).map(({ v, label }) => (
          <button
            key={v}
            onClick={() => setD({ kind: v })}
            className={cn('flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border text-[11px] transition-all', d.kind === v ? 'border-brand-orchid/60 bg-brand-soft text-white' : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-white/15')}
          >
            <DeviceGlyph kind={v} color={d.color} on={d.kind === v} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        ))}
      </div>
      {d.kind !== 'none' && (
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-zinc-400">Finish</span>
          <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
            {([
              { v: 'dark', label: d.kind === 'macbook' ? 'Space black' : 'Graphite', sw: '#2a2b30' },
              { v: 'light', label: d.kind === 'macbook' ? 'Silver' : 'Platinum', sw: '#d9dadf' }
            ] as { v: DeviceColor; label: string; sw: string }[]).map(({ v, label, sw }) => (
              <button
                key={v}
                onClick={() => setD({ color: v })}
                className={cn('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] transition-colors', d.color === v ? 'bg-white/[0.1] text-white' : 'text-zinc-400 hover:text-white')}
              >
                <span className="h-3 w-3 rounded-full ring-1 ring-white/25" style={{ background: sw }} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Section>
  )
}

function FramePanel({ edit }: { edit: EditState }) {
  const onDevice = DEVICE_FRAMES_ENABLED && !!edit.device && edit.device.kind !== 'none'
  return (
    <>
      <CropSection edit={edit} />
      {DEVICE_FRAMES_ENABLED && <DeviceSection edit={edit} />}
      <Section title="Aspect ratio" tour="frame-aspect">
        <div className="grid grid-cols-3 gap-2">
          {(['16:9', '9:16', '1:1', '4:3', '4:5', 'auto'] as Aspect[]).map((a) => {
            const [w, h] = a === 'auto' ? [16, 10] : a.split(':').map(Number)
            const s = 22 / Math.max(w, h)
            return (
              <button
                key={a}
                onClick={() => set((e) => ({ ...e, aspect: a }))}
                className={cn('flex h-16 flex-col items-center justify-center gap-1.5 rounded-xl border text-[11px] transition-all', edit.aspect === a ? 'border-brand-orchid/60 bg-brand-soft text-white' : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-white/15')}
              >
                <div className={cn('rounded-[3px] border-[1.5px]', edit.aspect === a ? 'border-brand-lilac' : 'border-zinc-500', a === 'auto' && 'border-dashed')} style={{ width: w * s, height: h * s }} />
                {a === 'auto' ? 'Source' : a}
              </button>
            )
          })}
        </div>
      </Section>
      <Section title="Style" tour="frame-style">
        <LabeledSlider label="Padding" value={edit.padding} min={0} max={0.22} step={0.005} onChange={(v) => live((e) => ({ ...e, padding: v }))} format={(v) => Math.round((v / 0.22) * 100) + '%'} />
        <div className={cn('space-y-4', onDevice && 'pointer-events-none opacity-40')}>
          <LabeledSlider label="Corner radius" value={edit.radius} min={0} max={48} step={1} onChange={(v) => live((e) => ({ ...e, radius: v }))} format={(v) => v + 'px'} />
        </div>
        <LabeledSlider label="Shadow" value={edit.shadow} min={0} max={1} step={0.01} onChange={(v) => live((e) => ({ ...e, shadow: v }))} format={(v) => Math.round(v * 100) + '%'} />
        {onDevice ? (
          <div className="text-[11px] leading-snug text-zinc-500">The laptop sets its own corners and glass. Padding and shadow still apply.</div>
        ) : (
          <SwitchRow label="Glass edge" hint="Subtle inner highlight around the frame" checked={edit.inset} onChange={(v) => set((e) => ({ ...e, inset: v }))} />
        )}
      </Section>
    </>
  )
}

function CursorPanel({ edit }: { edit: EditState }) {
  const c = edit.cursor
  const project = useEditor((s) => s.project)!
  const setC = (patch: Partial<EditState['cursor']>, history = true) => updateEdit((e) => ({ ...e, cursor: { ...e.cursor, ...patch } }), history)
  return (
    <>
      <Section title="Cursor" tour="cursor-main">
        <SwitchRow label="Cinematic cursor" hint={project.cursorBaked ? 'This take was captured with the system cursor baked in. Enabling adds a second, smoothed cursor on top.' : 'Smoothed, high-res cursor drawn over your recording'} checked={c.enabled} onChange={(v) => setC({ enabled: v })} />
        <div className={cn('space-y-4', !c.enabled && 'pointer-events-none opacity-40')}>
          <div className="grid grid-cols-4 gap-2">
            {([
              { v: 'auto', label: 'Dynamic' },
              { v: 'mac', label: 'Dark' },
              { v: 'light', label: 'Light' },
              { v: 'ring', label: 'Ring' }
            ] as { v: CursorStyle; label: string }[]).map(({ v: s, label }) => (
              <button
                key={s}
                onClick={() => setC({ style: s })}
                className={cn('flex h-[68px] flex-col items-center justify-center gap-1.5 rounded-xl border text-[10.5px] transition-all', c.style === s ? 'border-brand-orchid/60 bg-brand-soft text-white' : 'border-white/[0.07] bg-white/[0.02] text-zinc-500 hover:border-white/15 hover:text-zinc-300')}
              >
                <div className="grid h-6 place-items-center">
                  {s === 'auto' ? (
                    <div className="flex items-end gap-0.5">
                      <svg viewBox="0 0 24 24" className="h-5 w-5"><path d="M4 2.5 L4 20.2 L8.6 16 L11.7 22.8 L14.9 21.4 L11.9 14.8 L18 14.8 Z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                      <svg viewBox="0 0 32 32" className="h-5 w-5"><path d="M10.2 20.4 V8 A2.3 2.3 0 0 1 14.8 8 V13.4 A1.95 1.95 0 0 1 18.7 13.5 V13.8 A1.9 1.9 0 0 1 22.5 14 V14.4 A1.6 1.6 0 0 1 25.7 14.6 V21.5 C25.7 25.6 23.2 28.6 19.8 28.6 H15.6 C13.7 28.6 12.3 27.8 11.3 26.5 L7.3 21.1 A1.75 1.75 0 0 1 9.9 18.8 Z" fill="#fff" stroke="#111" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                    </div>
                  ) : s === 'mac' || s === 'light' ? (
                    <svg viewBox="0 0 24 24" className="h-6 w-6"><path d="M4 2.5 L4 20.2 L8.6 16 L11.7 22.8 L14.9 21.4 L11.9 14.8 L18 14.8 Z" fill={s === 'mac' ? '#111' : '#fff'} stroke={s === 'mac' ? '#fff' : '#111'} strokeWidth="1.6" strokeLinejoin="round" /></svg>
                  ) : s === 'dot' ? (
                    <div className="h-5 w-5 rounded-full border-2 border-white bg-black/50" />
                  ) : (
                    <div className="h-5 w-5 rounded-full border-[3px] border-brand-orchid" />
                  )}
                </div>
                {label}
              </button>
            ))}
          </div>
          {c.style === 'auto' && (
            <div className="-mt-1 text-[11px] leading-snug text-zinc-500">Normal arrow everywhere, switching to the pointing hand over buttons and links, just like your real cursor did while recording.</div>
          )}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-zinc-400">Size</span>
              <span className="tabular-nums text-zinc-500">{c.size.toFixed(1)}×</span>
            </div>
            <Segmented
              layoutId="csz"
              size="sm"
              value={(c.size <= 1.35 ? 's' : c.size <= 1.85 ? 'm' : c.size <= 2.4 ? 'l' : 'xl') as 's' | 'm' | 'l' | 'xl'}
              onChange={(v) => setC({ size: { s: 1.2, m: 1.6, l: 2.1, xl: 2.7 }[v] })}
              options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }, { value: 'xl', label: 'XL' }]}
            />
            <Slider value={[c.size]} min={0.8} max={3.5} step={0.05} onValueChange={(v) => setC({ size: v[0] }, false)} />
          </div>
          <LabeledSlider label="Smoothing" value={c.smoothing} min={0} max={1} step={0.01} onChange={(v) => setC({ smoothing: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
          <SwitchRow label="Hide when idle" hint="Fades out after 2s without movement" checked={c.hideIdle} onChange={(v) => setC({ hideIdle: v })} />
          <SwitchRow label="Hide while typing" hint="Fades out as you type, comes back when you move the mouse" checked={c.hideTyping} onChange={(v) => setC({ hideTyping: v })} />
        </div>
      </Section>
      <Section title="Clicks" tour="cursor-clicks">
        <div className={cn('space-y-4', !c.enabled && 'pointer-events-none opacity-40')}>
          <Segmented layoutId="ce" size="sm" value={c.clickEffect} onChange={(v) => setC({ clickEffect: v })} options={[{ value: 'ripple', label: 'Ripple' }, { value: 'pulse', label: 'Highlight' }, { value: 'none', label: 'None' }]} />
          <div className="text-[11px] text-zinc-500">{seqEvents(project, edit.clips, edit.crops).clicks.length} clicks in this video. Click sounds live in the Audio tab.</div>
        </div>
      </Section>
      <HiddenRanges edit={edit} />
    </>
  )
}

function HiddenRanges({ edit }: { edit: EditState }) {
  const selected = useEditor((s) => s.selected)
  const ranges = edit.cursor.hidden
  return (
    <Section title={`Hide cursor · ${ranges.length}`} tour="cursor-hide">
      <p className="-mt-1 text-[11.5px] leading-relaxed text-zinc-500">Hide the cursor during messy moments. It fades out and back in smoothly. Tip: double-click the Cursor lane or press H.</p>
      <Button variant="outline" size="sm" className="w-full" onClick={() => addHideAt(useEditor.getState().time)}>
        <EyeOff className="h-3.5 w-3.5" /> Hide cursor at playhead
      </Button>
      {ranges.length > 0 && (
        <div className="space-y-1.5">
          {ranges.map((r) => (
            <div key={r.id} className={cn('flex items-center gap-3 rounded-lg px-3 py-2 text-[11.5px] transition-colors', r.id === selected ? 'bg-brand-deep/[0.2] text-white' : 'text-zinc-400 hover:bg-white/[0.04]')}>
              <button className="flex flex-1 items-center gap-3 text-left" onClick={() => { useEditor.getState().select(r.id); player.seek(r.start) }}>
                <EyeOff className="h-3.5 w-3.5 text-brand-lilac/80" />
                <span className="tabular-nums">{fmtTime(r.start, true)} → {fmtTime(r.end, true)}</span>
              </button>
              <button className="grid h-6 w-6 place-items-center rounded-md text-zinc-500 hover:bg-red-500/15 hover:text-red-300" onClick={() => removeHide(r.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function ZoomPanel({ edit }: { edit: EditState }) {
  const project = useEditor((s) => s.project)!
  const selected = useEditor((s) => s.selected)
  const seg = edit.zoom.segments.find((s) => s.id === selected)
  const fresh = useMemo(() => autoZoomSegments(project, edit.clips, 1.5, edit.crops), [project, edit.clips, edit.crops])
  const sig = (l: { start: number; end: number; scale: number; follow: boolean }[]) => l.map((z) => [z.start.toFixed(2), z.end.toFixed(2), z.scale, z.follow].join(':')).join('|')
  const upToDate = fresh.length > 0 && sig(fresh) === sig(edit.zoom.segments)
  const regen = () => {
    set((e) => ({ ...e, zoom: { ...e.zoom, segments: autoZoomSegments(project, e.clips, 1.5, e.crops) } }))
    useEditor.getState().select(null)
  }
  return (
    <>
      {seg ? (
        <Section
          title="Selected zoom"
          action={
            <Button variant="danger" size="icon-sm" onClick={() => removeSegment(seg.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-[11.5px] tabular-nums text-zinc-400">
            <span>{fmtTime(seg.start, true)} → {fmtTime(seg.end, true)}</span>
            <span className="text-zinc-500">{(seg.end - seg.start).toFixed(1)}s</span>
          </div>
          <LabeledSlider label="Zoom level" value={seg.scale} min={1.1} max={4} step={0.05} onChange={(v) => patchSegment(seg.id, { scale: v }, false)} format={(v) => v.toFixed(2) + '×'} />
          <Segmented
            layoutId="zf"
            size="sm"
            value={seg.follow ? 'follow' : 'fixed'}
            onChange={(v) => {
              if (v === 'fixed') {
                const hit = clipAt(edit.clips, seg.start + Math.min(0.8, (seg.end - seg.start) / 2))
                const tk = hit ? trackOf(project, hit.clip.source) : null
                const raw = hit && tk ? cursorPosAt(tk, hit.srcT) : null
                const p = hit && raw ? toCrop(cropOf(edit.crops, hit.clip.source), raw.x, raw.y) : { x: 0.5, y: 0.5 }
                patchSegment(seg.id, { follow: false, x: p.x, y: p.y })
              } else patchSegment(seg.id, { follow: true })
            }}
            options={[{ value: 'follow', label: <><MousePointerClick className="h-3.5 w-3.5" /> Follow cursor</> }, { value: 'fixed', label: <><Crosshair className="h-3.5 w-3.5" /> Fixed point</> }]}
          />
          {!seg.follow && <FocusPicker x={seg.x} y={seg.y} onChange={(x, y, h) => patchSegment(seg.id, { x, y }, h)} />}
          <Button variant="outline" size="sm" className="w-full" onClick={() => { player.seek(seg.start); player.play() }}>Preview this zoom</Button>
        </Section>
      ) : (
        <Section title="Zoom" tour="zoom-main">
          <div className="rounded-xl border border-white/[0.06] bg-gradient-to-br from-brand-pink/[0.07] to-brand-violet/[0.06] p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-200"><Sparkles className="h-4 w-4 text-brand-lilac" /> Auto zoom</div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-400">Generates smooth zoom-ins around your clicks and typing, following the cursor.</p>
            {upToDate ? (
              <div className="mt-3 flex h-8 items-center justify-center gap-1.5 rounded-lg border border-brand-orchid/25 bg-brand-orchid/[0.08] text-[12px] font-medium text-brand-lilac">
                <Check className="h-3.5 w-3.5" /> Auto zooms are up to date
              </div>
            ) : fresh.length === 0 ? (
              <div className="mt-3 flex h-8 items-center justify-center rounded-lg bg-white/[0.03] text-[11.5px] text-zinc-500">No clicks or typing found to zoom into</div>
            ) : (
              <Button variant="primary" size="sm" className="mt-3 w-full" onClick={regen}>
                <Sparkles className="h-3.5 w-3.5" /> {edit.zoom.segments.some((s) => s.auto) ? 'Regenerate' : 'Generate'} auto zooms
              </Button>
            )}
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => addSegmentAt(useEditor.getState().time)}>
            <ZoomIn className="h-3.5 w-3.5" /> Add zoom at playhead
          </Button>
          {edit.zoom.segments.length > 0 && (
            <Button variant="ghost" size="sm" className="w-full" onClick={() => set((e) => ({ ...e, zoom: { ...e.zoom, segments: [] } }))}>
              <RotateCcw className="h-3.5 w-3.5" /> Clear all zooms
            </Button>
          )}
        </Section>
      )}
      <Section title="Motion" tour="zoom-motion">
        <div className="space-y-2">
          <div className="text-[12px] text-zinc-400">Transition speed</div>
          <Segmented layoutId="zs" size="sm" value={edit.zoom.speed} onChange={(v) => set((e) => ({ ...e, zoom: { ...e.zoom, speed: v } }))} options={[{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Smooth' }, { value: 'fast', label: 'Snappy' }]} />
        </div>
        <LabeledSlider label="Camera follow smoothness" value={edit.zoom.followSmoothness} min={0} max={1} step={0.01} onChange={(v) => updateEdit((e) => ({ ...e, zoom: { ...e.zoom, followSmoothness: v } }), false)} format={(v) => Math.round(v * 100) + '%'} />
      </Section>
      <Section title={`Segments · ${edit.zoom.segments.length}`} tour="zoom-list">
        <div className="space-y-1.5">
          {edit.zoom.segments.length === 0 && <div className="text-[11.5px] text-zinc-500">No zooms yet.</div>}
          {edit.zoom.segments.map((s, i) => (
            <button key={s.id} onClick={() => { useEditor.getState().select(s.id); player.seek(s.start) }} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[11.5px] transition-colors', s.id === selected ? 'bg-brand-soft text-white' : 'text-zinc-400 hover:bg-white/[0.04]')}>
              <span className="grid h-5 w-5 place-items-center rounded-md bg-white/[0.06] text-[10px] tabular-nums">{i + 1}</span>
              <span className="tabular-nums">{fmtTime(s.start, true)}</span>
              <span className="flex-1" />
              <span className="tabular-nums text-zinc-500">{s.scale.toFixed(1)}×</span>
              {s.auto && <Sparkles className="h-3 w-3 text-brand-lilac/70" />}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}

function FocusPicker({ x, y, onChange }: { x: number; y: number; onChange: (x: number, y: number, history: boolean) => void }) {
  const project = useEditor((s) => s.project)!
  const thumb = project.dir ? `ilf://media/${encodeURIComponent(project.dir + (project.dir.includes('\\') ? '\\' : '/') + 'thumb.jpg')}` : ''
  const handle = (e: React.PointerEvent<HTMLDivElement>, history: boolean) => {
    const r = e.currentTarget.getBoundingClientRect()
    onChange(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), history)
  }
  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-zinc-500">Click where the camera should focus</div>
      <div
        className="relative aspect-video cursor-crosshair overflow-hidden rounded-lg ring-1 ring-white/10"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          handle(e, false)
        }}
        onPointerMove={(e) => e.buttons && handle(e, false)}
        onPointerUp={() => useEditor.getState().checkpoint()}
      >
        <img src={thumb} className="h-full w-full object-cover opacity-70" draggable={false} />
        <div className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_4px_rgba(139,92,246,.35)]" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} />
      </div>
    </div>
  )
}

function CameraPanel({ edit }: { edit: EditState }) {
  const project = useEditor((s) => s.project)!
  const c = edit.camera
  const setC = (patch: Partial<EditState['camera']>, history = true) => updateEdit((e) => ({ ...e, camera: { ...e.camera, ...patch } }), history)
  const anyCam = !!project.camera || (project.sources ?? []).some((x) => x.camera && edit.clips.some((c) => c.source === x.id))
  if (!anyCam)
    return (
      <Section title="Camera" tour="camera-main">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-[12px] leading-relaxed text-zinc-400">
          This take has no camera footage. Turn on <span className="text-zinc-200">Camera</span> before recording to add a selfie bubble.
        </div>
      </Section>
    )
  return (
    <>
      <Section title="Camera" tour="camera-main">
        <SwitchRow label="Show camera" checked={c.enabled} onChange={(v) => setC({ enabled: v })} />
        <div className={cn('space-y-4', !c.enabled && 'pointer-events-none opacity-40')}>
          <Segmented layoutId="cs" size="sm" value={c.shape} onChange={(v) => setC({ shape: v })} options={[{ value: 'circle', label: 'Circle' }, { value: 'rounded', label: 'Rounded' }, { value: 'portrait', label: 'Portrait' }]} />
          <LabeledSlider label="Size" value={c.size} min={0.12} max={0.45} step={0.005} onChange={(v) => setC({ size: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
          <div className="space-y-2">
            <div className="text-[12px] text-zinc-400">Position</div>
            <div className="relative grid aspect-video grid-cols-2 grid-rows-2 gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
              {(['tl', 'tr', 'bl', 'br'] as CamPos[]).map((p) => (
                <button key={p} onClick={() => setC({ position: p })} className={cn('flex p-2 transition-all', p[0] === 't' ? 'items-start' : 'items-end', p[1] === 'l' ? 'justify-start' : 'justify-end', 'rounded-lg hover:bg-white/[0.04]')}>
                  <div className={cn('h-6 w-6 rounded-full border-2 transition-all', c.position === p ? 'border-brand-lilac bg-brand-orchid/40 shadow-[0_0_12px_rgba(139,92,246,.5)]' : 'border-zinc-600 bg-white/5')} />
                </button>
              ))}
            </div>
          </div>
          <SwitchRow label="Mirror" checked={c.mirror} onChange={(v) => setC({ mirror: v })} />
          <SwitchRow label="White border" checked={c.border} onChange={(v) => setC({ border: v })} />
          <SwitchRow label="Shrink while zoomed" hint="Gets out of the way during zoom-ins" checked={c.shrinkOnZoom} onChange={(v) => setC({ shrinkOnZoom: v })} />
        </div>
      </Section>
    </>
  )
}

type SfxKey = 'click' | 'zoom' | 'typing'

function SfxPicker({ edit, k, title, hint, options, preview }: { edit: EditState; k: SfxKey; title: string; hint: string; options: readonly { id: string; name: string }[]; preview: (id: string, vol: number) => void }) {
  const cfg = edit.sfx[k]
  const setS = (patch: Partial<EditState['sfx'][SfxKey]>, history = true) => updateEdit((e) => ({ ...e, sfx: { ...e.sfx, [k]: { ...e.sfx[k], ...patch } } }), history)
  return (
    <Section title={title} tour={'audio-' + k}>
      <SwitchRow label={`Play ${title.toLowerCase()}`} hint={hint} checked={cfg.enabled} onChange={(v) => setS({ enabled: v })} />
      <div className={cn('space-y-4 transition-opacity', !cfg.enabled && 'pointer-events-none opacity-40')}>
        <div className="grid grid-cols-3 gap-2">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setS({ id: o.id })
                preview(o.id, cfg.volume)
              }}
              className={cn(
                'group/s flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[11.5px] transition-all duration-150 active:scale-[0.97]',
                cfg.id === o.id ? 'border-brand-orchid/60 bg-brand-soft text-white' : 'border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-white/15 hover:text-zinc-200'
              )}
            >
              <Volume2 className={cn('h-3 w-3 transition-opacity', cfg.id === o.id ? 'opacity-90' : 'opacity-0 group-hover/s:opacity-60')} />
              {o.name}
            </button>
          ))}
        </div>
        <LabeledSlider label="Volume" value={cfg.volume} min={0} max={1} step={0.01} onChange={(v) => setS({ volume: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
      </div>
    </Section>
  )
}

type UserSnd = Awaited<ReturnType<typeof window.ilf.sounds.list>>[number]
let soundCache: UserSnd[] = []
let previewEl: HTMLAudioElement | null = null

function YourSounds() {
  const [list, setList] = useState<UserSnd[]>(soundCache)
  const [playing, setPlaying] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const refresh = async () => {
    soundCache = await window.ilf.sounds.list()
    setList(soundCache)
  }
  useEffect(() => {
    refresh()
    const on = () => refresh()
    window.addEventListener('ilf:sounds-changed', on)
    return () => {
      window.removeEventListener('ilf:sounds-changed', on)
      previewEl?.pause()
    }
  }, [])
  const togglePreview = (s: UserSnd) => {
    if (playing === s.id) {
      previewEl?.pause()
      setPlaying(null)
      return
    }
    previewEl?.pause()
    previewEl = new Audio(mediaUrl(s.file))
    previewEl.onended = () => setPlaying(null)
    previewEl.play()
    setPlaying(s.id)
  }
  const importFrom = async (paths?: string[]) => {
    const added = await window.ilf.sounds.import(paths)
    await refresh()
    return added
  }
  return (
    <Section
      tour="audio-library"
      title="Your sounds"
      action={
        <Button variant="ghost" size="sm" onClick={() => importFrom()}>
          <Upload className="h-3.5 w-3.5" /> Upload
        </Button>
      }
    >
      <div
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const paths = [...e.dataTransfer.files].map((f) => window.ilf.pathForFile(f)).filter(Boolean)
          if (paths.length) importFrom(paths)
        }}
        className={cn('space-y-1.5 rounded-xl transition-colors', over && 'bg-brand-rose/[0.06] ring-1 ring-brand-rose/40')}
      >
        {list.length === 0 && (
          <button onClick={() => importFrom()} className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-white/10 py-5 text-[12px] text-zinc-400 transition-colors hover:border-white/25 hover:bg-white/[0.02] hover:text-zinc-200">
            <Music className="h-5 w-5" />
            Upload music or sound effects
            <span className="text-[10.5px] text-zinc-600">MP3, WAV, M4A, OGG · or drop files here</span>
          </button>
        )}
        {list.map((s) => (
          <div
            key={s.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-ilf-sound', JSON.stringify(s))
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className="group/snd flex cursor-grab items-center gap-2.5 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2 py-1.5 transition-colors hover:border-white/10 hover:bg-white/[0.04] active:cursor-grabbing"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
            <button onClick={() => togglePreview(s)} className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors', playing === s.id ? 'bg-brand text-white' : 'bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]')}>
              {playing === s.id ? <Square className="h-2.5 w-2.5" fill="currentColor" /> : <Play className="ml-0.5 h-3 w-3" fill="currentColor" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-zinc-200">{s.name}</div>
              <div className="text-[10.5px] tabular-nums text-zinc-500">{fmtTime(s.duration, true)}</div>
            </div>
            <Tip content="Add at playhead">
              <button onClick={() => addClipAt(s, useEditor.getState().time, mediaUrl(s.file))} className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-white/10 hover:text-white">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tip>
            <Tip content="Remove from library">
              <button
                onClick={async () => {
                  await window.ilf.sounds.remove(s.id)
                  refresh()
                }}
                className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-300 group-hover/snd:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
        ))}
        {list.length > 0 && <div className="pt-1 text-[11px] text-zinc-500">Drag a sound onto the timeline's Audio lane to place it.</div>}
      </div>
    </Section>
  )
}

function AudioPanel({ edit }: { edit: EditState }) {
  const project = useEditor((s) => s.project)!
  const selected = useEditor((s) => s.selected)
  const clip = edit.audio.clips.find((c) => c.id === selected)
  return (
    <>
      {clip && (
        <Section
          title="Selected sound"
          action={
            <Button variant="danger" size="icon-sm" onClick={() => removeClip(clip.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          }
        >
          <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-[11.5px]">
            <span className="truncate text-zinc-200">{clip.name}</span>
            <span className="shrink-0 tabular-nums text-zinc-500">{fmtTime(clip.start, true)} · {clip.duration.toFixed(1)}s</span>
          </div>
          <LabeledSlider label="Volume" value={clip.volume} min={0} max={2} step={0.01} onChange={(v) => patchClip(clip.id, { volume: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
        </Section>
      )}
      <Section title="Voice" tour="audio-voice">
        {project.mic ? (
          <>
            <SwitchRow label="Mute microphone" checked={edit.audio.muted} onChange={(v) => set((e) => ({ ...e, audio: { ...e.audio, muted: v } }))} />
            <LabeledSlider label="Mic volume" value={edit.audio.micVolume} min={0} max={2} step={0.01} onChange={(v) => updateEdit((e) => ({ ...e, audio: { ...e.audio, micVolume: v } }), false)} format={(v) => Math.round(v * 100) + '%'} />
          </>
        ) : (
          <div className="text-[12px] text-zinc-500">No microphone audio in this take.</div>
        )}
      </Section>
      <SfxPicker edit={edit} k="click" title="Click sounds" hint={`${seqEvents(project, edit.clips, edit.crops).clicks.length} clicks in this video`} options={CLICK_SOUNDS} preview={(id, v) => playSfx(id, v)} />
      <SfxPicker
        edit={edit}
        k="zoom"
        title="Zoom sounds"
        hint="Plays on zoom in, reversed on zoom out"
        options={ZOOM_SOUNDS}
        preview={(id, v) => {
          playSfx(id, v)
          setTimeout(() => playSfx(id, v, 0, true), 700)
        }}
      />
      <SfxPicker
        edit={edit}
        k="typing"
        title="Typing sounds"
        hint={`${seqEvents(project, edit.clips).keys.length} keystrokes in this video`}
        options={TYPING_SOUNDS}
        preview={(id, v) => {
          ;[0, 110, 190, 300, 380, 470].forEach((ms, i) =>
            setTimeout(() => {
              const kv = keyVariant(i)
              playSfx(id, v * kv.gain, kv.variant)
            }, ms)
          )
        }}
      />
      <YourSounds />
    </>
  )
}

function SourceCard({ src, uses, smart, onAdd, onRemove }: { src: SourceInfo; uses: number; smart: boolean; onAdd: () => void; onRemove?: () => void }) {
  const thumbs = useSourceThumbs(src.url, src.duration)
  const cover = thumbs[Math.min(thumbs.length - 1, 2)]
  return (
    <div className="group/src flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 transition-colors hover:border-white/12 hover:bg-white/[0.04]">
      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-black">
        {cover && <img src={cover} className="h-full w-full animate-[fadein_.35s_ease] object-cover" draggable={false} />}
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9.5px] tabular-nums text-white/90">{fmtTime(src.duration)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-zinc-200">{src.name}</div>
        {smart && (
          <Tip content="iloveframes recording: its clicks, typing and cursor data came with it, so smart zoom and the cinematic cursor work">
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-soft px-1.5 py-px text-[9.5px] font-semibold text-brand-lilac ring-1 ring-brand-orchid/30">
              <Sparkles className="h-2.5 w-2.5" /> Smart data
            </span>
          </Tip>
        )}
        <div className="mt-0.5 text-[10.5px] text-zinc-500">
          {src.width}×{src.height}
          {src.hasAudio ? ' · audio' : ''} · {uses ? 'in timeline' + (uses > 1 ? ' ×' + uses : '') : 'not used'}
        </div>
      </div>
      <Tip content="Add to the end of the timeline">
        <button onClick={onAdd} className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white">
          <Plus className="h-4 w-4" />
        </button>
      </Tip>
      {onRemove && (
        <Tip content={uses ? 'Remove it from the timeline first' : 'Remove from project'}>
          <button disabled={uses > 0} onClick={onRemove} className="grid h-8 w-8 place-items-center rounded-lg text-zinc-500 opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-300 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-600 group-hover/src:opacity-100">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </Tip>
      )}
    </div>
  )
}

const POSITIONS: { x: number; y: number; label: string }[] = [
  { x: 0.12, y: 0.1, label: 'Top left' }, { x: 0.5, y: 0.1, label: 'Top' }, { x: 0.88, y: 0.1, label: 'Top right' },
  { x: 0.12, y: 0.5, label: 'Left' }, { x: 0.5, y: 0.5, label: 'Centre' }, { x: 0.88, y: 0.5, label: 'Right' },
  { x: 0.12, y: 0.86, label: 'Bottom left' }, { x: 0.5, y: 0.86, label: 'Bottom' }, { x: 0.88, y: 0.86, label: 'Bottom right' }
]

function TextPanel({ edit }: { edit: EditState }) {
  const selected = useEditor((s) => s.selected)
  const time = useEditor((s) => s.time)
  const o = edit.texts.find((t) => t.id === selected)
  const add = (style: TextStyle) => {
    const made = addTextAt(useEditor.getState().time, style)
    if (made) player.seek(made.start + 0.45)
  }
  return (
    <>
      <Section title="Add text" tour="text-add">
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(TEXT_PRESETS) as TextStyle[]).map((k) => (
            <button
              key={k}
              onClick={() => add(k)}
              className="group rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-amber-300/40 hover:bg-amber-300/[0.05]"
            >
              <div className={cn('truncate text-zinc-100', k === 'title' ? 'text-[15px] font-bold' : k === 'badge' ? 'text-[10.5px] font-bold uppercase tracking-wider' : 'text-[12.5px] font-semibold')}>{TEXT_PRESETS[k].label}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-zinc-500">{TEXT_PRESETS[k].hint}</div>
            </button>
          ))}
        </div>
        <div className="text-[11px] leading-relaxed text-zinc-500">Added at the playhead ({fmtTime(time, true)}). Drag it on the Text lane to move it, drag its edges to change how long it shows. Press T to add a title.</div>
      </Section>
      {o ? <TextEditor key={o.id} o={o} /> : null}
      <Section title={'In this video · ' + edit.texts.length}>
        {edit.texts.length === 0 ? (
          <div className="text-[12px] text-zinc-500">No text yet. Titles, captions and name tags show up here.</div>
        ) : (
          <div className="space-y-1.5">
            {edit.texts.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  useEditor.getState().select(t.id)
                  player.seek(t.start + Math.min(0.45, (t.end - t.start) / 2))
                }}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors', t.id === selected ? 'bg-amber-300/[0.12] text-white ring-1 ring-amber-300/40' : 'bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]')}
              >
                <Type className="h-3.5 w-3.5 shrink-0 text-amber-300/80" />
                <span className="min-w-0 flex-1 truncate">{t.text.split('\n')[0] || 'Empty text'}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-500">{fmtTime(t.start, true)}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

function TextEditor({ o }: { o: TextOverlay }) {
  const total = useEditor((s) => seqDuration(s.edit!.clips))
  const p = (patch: Partial<TextOverlay>, history = true) => patchText(o.id, patch, history)
  return (
    <Section
      title="Selected text"
      action={
        <div className="flex items-center gap-1">
          <Tip content="Duplicate after this one">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                const made = addTextAt(o.end + 0.05, o.style, o.end - o.start)
                if (made) patchText(made.id, { text: o.text, x: o.x, y: o.y, size: o.size, color: o.color, bg: o.bg, anim: o.anim })
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Button variant="danger" size="icon-sm" onClick={() => removeText(o.id)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      }
    >
      <textarea
        autoFocus
        value={o.text}
        rows={Math.min(4, Math.max(2, o.text.split('\n').length))}
        onChange={(e) => p({ text: e.target.value.slice(0, 280) }, false)}
        onBlur={() => useEditor.getState().checkpoint()}
        placeholder="Type your text"
        className="w-full resize-none rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-[13px] text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-amber-300/50"
      />
      <div>
        <div className="mb-2 text-[11.5px] text-zinc-400">Style</div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TEXT_PRESETS) as TextStyle[]).map((k) => (
            <button
              key={k}
              onClick={() => {
                const d = TEXT_PRESETS[k]
                p({ style: k, bg: d.bg, anim: d.anim, ...(o.style === 'lower' || k === 'lower' ? { x: d.x, y: d.y } : {}) })
              }}
              className={cn('rounded-lg px-2.5 py-1 text-[11.5px] transition-colors', o.style === k ? 'bg-amber-300 font-semibold text-black' : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.09]')}
            >
              {TEXT_PRESETS[k].label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-4">
        <div>
          <div className="mb-2 text-[11.5px] text-zinc-400">Position</div>
          <div className="grid w-[96px] grid-cols-3 gap-1 rounded-lg bg-black/30 p-1 ring-1 ring-white/[0.06]">
            {POSITIONS.map((q) => {
              // a lower third is left-aligned: its anchor is its left edge
              const qx = o.style === 'lower' ? (q.x < 0.3 ? 0.07 : q.x < 0.7 ? 0.36 : 0.6) : q.x
              const on = Math.abs(qx - o.x) < 0.05 && Math.abs(q.y - o.y) < 0.05
              return (
                <Tip key={q.label} content={q.label}>
                  <button onClick={() => p({ x: qx, y: q.y })} className={cn('grid h-[26px] place-items-center rounded-md transition-colors', on ? 'bg-amber-300' : 'hover:bg-white/10')}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', on ? 'bg-black' : 'bg-white/40')} />
                  </button>
                </Tip>
              )
            })}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <LabeledSlider label="Left / right" value={o.x} min={0} max={1} step={0.005} onChange={(v) => p({ x: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
          <LabeledSlider label="Up / down" value={o.y} min={0} max={1} step={0.005} onChange={(v) => p({ y: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
        </div>
      </div>
      <LabeledSlider label="Size" value={o.size} min={0.4} max={2.5} step={0.01} onChange={(v) => p({ size: v }, false)} format={(v) => Math.round(v * 100) + '%'} />
      <div>
        <div className="mb-2 text-[11.5px] text-zinc-400">Colour</div>
        <div className="flex flex-wrap gap-2">
          {TEXT_COLORS.map((c) => (
            <button key={c} onClick={() => p({ color: c })} title={c} className={cn('h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-[#0e0e13] transition-transform hover:scale-110', o.color === c ? 'ring-amber-300' : 'ring-white/10')} style={{ background: c }} />
          ))}
          <label className="relative grid h-7 w-7 cursor-pointer place-items-center overflow-hidden rounded-full bg-[conic-gradient(#ff4d8d,#ffd166,#5eead4,#60a5fa,#c084fc,#ff4d8d)] ring-2 ring-white/10 ring-offset-2 ring-offset-[#0e0e13]" title="Pick any colour">
            <input type="color" value={o.color} onChange={(e) => p({ color: e.target.value }, false)} onBlur={() => useEditor.getState().checkpoint()} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11.5px] text-zinc-400">Backdrop</div>
        <Segmented size="sm" layoutId="txt-bg" value={o.bg} onChange={(v) => p({ bg: v as TextOverlay['bg'] })} options={[{ value: 'none', label: 'None' }, { value: 'shadow', label: 'Glow' }, { value: 'pill', label: 'Pill' }, { value: 'box', label: 'Box' }]} />
      </div>
      <div>
        <div className="mb-2 text-[11.5px] text-zinc-400">Animation</div>
        <Segmented size="sm" layoutId="txt-anim" value={o.anim} onChange={(v) => p({ anim: v as TextOverlay['anim'] })} options={[{ value: 'fade', label: 'Fade' }, { value: 'rise', label: 'Rise' }, { value: 'pop', label: 'Pop' }, { value: 'type', label: 'Type' }, { value: 'none', label: 'Cut' }]} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="sm" onClick={() => p({ start: Math.max(0, Math.min(useEditor.getState().time, o.end - 0.4)) })}>
          <AlignCenter className="h-3.5 w-3.5" /> Start here
        </Button>
        <Button variant="outline" size="sm" onClick={() => p({ end: Math.min(total, Math.max(useEditor.getState().time, o.start + 0.4)) })}>
          <AlignCenter className="h-3.5 w-3.5" /> End here
        </Button>
      </div>
      <div className="text-[11px] tabular-nums text-zinc-500">Shows {fmtTime(o.start, true)} → {fmtTime(o.end, true)} · {(o.end - o.start).toFixed(1)}s</div>
    </Section>
  )
}

function ClipsPanel({ edit }: { edit: EditState }) {
  const project = useEditor((s) => s.project)!
  const selected = useEditor((s) => s.selected)
  const [over, setOver] = useState(false)
  const all = [MAIN, ...(project.sources ?? []).map((x) => x.id)].map((id) => sourceInfo(project, id)).filter(Boolean) as SourceInfo[]
  const uses = (id: string) => edit.clips.filter((c) => c.source === id).length
  const addToEnd = (src: SourceInfo) => updateEdit((e) => ({ ...e, clips: [...e.clips, { id: uid(), source: src.id, in: 0, out: src.duration }] }))
  const sel = edit.clips.find((c) => c.id === selected)
  const selSrc = sel ? sourceInfo(project, sel.source) : null
  return (
    <>
      {sel && selSrc && (
        <Section title="Selected clip">
          <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-[11.5px] tabular-nums">
            <span className="truncate text-zinc-200">{selSrc.name}</span>
            <span className="shrink-0 text-zinc-500">{fmtTime(sel.in, true)} → {fmtTime(sel.out, true)} · {(sel.out - sel.in).toFixed(1)}s</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={() => splitAtPlayhead()}><Scissors className="h-3.5 w-3.5" /> Split at playhead</Button>
            <Button variant="danger" size="sm" disabled={edit.clips.length < 2} onClick={() => deleteSeqClip(sel.id)}><Trash2 className="h-3.5 w-3.5" /> Delete clip</Button>
          </div>
          {selSrc.hasAudio && (
            <LabeledSlider label="Clip volume" value={sel.volume ?? 1} min={0} max={2} step={0.01} onChange={(v) => setClipVolume(sel.id, v, false)} format={(v) => (v === 0 ? 'Muted' : Math.round(v * 100) + '%')} />
          )}
        </Section>
      )}
      <Section
        tour="clips-media"
        title={'Project media · ' + all.length}
        action={
          <Button variant="ghost" size="sm" onClick={() => window.ilf.media.import(project.id).then(appendSources)}>
            <FilePlus2 className="h-3.5 w-3.5" /> Import
          </Button>
        }
      >
        <div
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const paths = [...e.dataTransfer.files].map((f) => window.ilf.pathForFile(f)).filter((x) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(x))
            if (paths.length) window.ilf.media.import(project.id, paths).then(appendSources)
          }}
          className={cn('space-y-2 rounded-xl transition-colors', over && 'bg-brand-orchid/[0.06] ring-1 ring-brand-orchid/40')}
        >
          {all.map((src) => (
            <SourceCard
              key={src.id}
              src={src}
              uses={uses(src.id)}
              smart={!!trackOf(project, src.id)}
              onAdd={() => addToEnd(src)}
              onRemove={
                src.isMain
                  ? undefined
                  : () => {
                      useEditor.getState().setProject((pp) => ({ ...pp, sources: (pp.sources ?? []).filter((x) => x.id !== src.id) }))
                      window.ilf.projects.save(project.id, { sources: (project.sources ?? []).filter((x) => x.id !== src.id) })
                    }
              }
            />
          ))}
          <button onClick={() => window.ilf.media.import(project.id).then(appendSources)} className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-white/10 py-4 text-[12px] text-zinc-400 transition-colors hover:border-white/25 hover:bg-white/[0.02] hover:text-zinc-200">
            <FilePlus2 className="h-5 w-5" />
            Import videos
            <span className="text-[10.5px] text-zinc-600">MP4, MOV, WebM, MKV · or drop files here</span>
          </button>
        </div>
        <div className="text-[11px] leading-relaxed text-zinc-500">Imported clips are added to the end of the timeline. Drag clips on the timeline to reorder, drag their edges to trim, press S to split.</div>
      </Section>
      <RecordingsSection />
      {edit.clips.length > 1 && <TransitionsSection edit={edit} />}
    </>
  )
}

/** Transition into the selected clip, or one look for every cut. */
function TransitionsSection({ edit }: { edit: EditState }) {
  const selected = useEditor((s) => s.selected)
  const idx = edit.clips.findIndex((c) => c.id === selected)
  const target = idx > 0 ? edit.clips[idx] : null
  const cuts = edit.clips.slice(1)
  const first = cuts[0]?.tIn
  const uniform = cuts.every((c) => (c.tIn?.kind ?? null) === (first?.kind ?? null) && (c.tIn?.duration ?? 0) === (first?.duration ?? 0))
  const value = target ? target.tIn : uniform ? first : undefined
  const change = (t: EditState['clips'][number]['tIn'] | null, history = true) => {
    if (target) {
      if (history) setTransition(target.id, t ?? null)
      else updateEdit((e) => ({ ...e, clips: e.clips.map((c) => (c.id === target.id ? { ...c, tIn: t ?? undefined } : c)) }), false)
    } else if (history) setAllTransitions(t ?? null)
    else updateEdit((e) => ({ ...e, clips: e.clips.map((c, i) => (i === 0 ? c : { ...c, tIn: t ?? undefined })) }), false)
  }
  return (
    <Section title={target ? `Transition into clip ${idx + 1}` : 'Transitions · every cut'} tour="clips-transitions">
      <TransitionPicker value={value} onChange={change} onApplyAll={target ? () => setAllTransitions(target.tIn ?? null) : undefined} />
      <div className="flex items-start gap-2 text-[11px] leading-relaxed text-zinc-500">
        <TransitionIcon className="mt-0.5 h-3 w-3 shrink-0 text-brand-orchid" />
        {target ? 'Or click the round button on any cut in the timeline.' : 'Select a clip to set its own transition, or click the round button on a cut in the timeline.'}
      </div>
    </Section>
  )
}

interface RecordingItem {
  id: string
  name: string
  file: string
  fileName: string
  duration: number
  createdAt: number
  tracked: boolean
  thumb: string | null
}

/** Earlier iloveframes recordings, one click to add, smart data included. */
function RecordingsSection() {
  const project = useEditor((s) => s.project)!
  const [list, setList] = useState<RecordingItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    window.ilf.recordings.list(project.id).then(setList)
  }, [project.id])
  if (!list?.length) return null
  const shown = all ? list : list.slice(0, 4)
  const add = async (r: RecordingItem) => {
    setBusy(r.id)
    try {
      appendSources(await window.ilf.media.import(project.id, [r.file]))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section title={'Your recordings · ' + list.length} tour="clips-recordings">
      <div className="space-y-1.5">
        {shown.map((r) => (
          <div key={r.id} className="group/rec flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-white/[0.04]">
            <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-black ring-1 ring-white/[0.06]">
              {r.thumb && <img src={mediaUrl(r.thumb)} className="h-full w-full object-cover" draggable={false} />}
              <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white/90">{fmtTime(r.duration)}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-zinc-200">{r.name.split(' · ')[0]}</div>
              <div className="flex items-center gap-1.5 text-[10.5px] text-zinc-500">
                <span className="truncate">{/^screen\.mp4$/i.test(r.fileName) ? 'Earlier take' : r.fileName.replace(/\.mp4$/i, '')}</span>
                {r.tracked && <Sparkles className="h-2.5 w-2.5 shrink-0 text-brand-orchid" />}
              </div>
            </div>
            <Tip content={r.tracked ? 'Add to the timeline with its clicks, typing and cursor data' : 'Add to the timeline'}>
              <button
                disabled={!!busy}
                onClick={() => add(r)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-brand hover:text-white disabled:opacity-40"
              >
                {busy === r.id ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Plus className="h-4 w-4" />}
              </button>
            </Tip>
          </div>
        ))}
      </div>
      {list.length > 4 && (
        <button onClick={() => setAll((v) => !v)} className="w-full rounded-lg py-1.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200">
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
      <div className="text-[11px] leading-relaxed text-zinc-500">Recordings marked <Sparkles className="inline h-2.5 w-2.5 text-brand-orchid" /> bring their clicks, typing and cursor movement, so smart zoom and the cinematic cursor work on them too.</div>
    </Section>
  )
}

/** What "Reset" restores per tab (content like zooms, clips and sounds you placed is kept). */
const RESETS: Partial<Record<Tab, (e: EditState, d: EditState) => EditState>> = {
  background: (e, d) => ({ ...e, background: d.background }),
  frame: (e, d) => ({ ...e, aspect: d.aspect, padding: d.padding, radius: d.radius, shadow: d.shadow, inset: d.inset }),
  cursor: (e, d) => ({ ...e, cursor: { ...d.cursor, hidden: e.cursor.hidden } }),
  zoom: (e, d) => ({ ...e, zoom: { ...e.zoom, speed: d.zoom.speed, followSmoothness: d.zoom.followSmoothness } }),
  camera: (e, d) => ({ ...e, camera: { ...d.camera, enabled: e.camera.enabled } }),
  audio: (e, d) => ({ ...e, audio: { ...e.audio, micVolume: d.audio.micVolume, muted: d.audio.muted }, sfx: d.sfx })
}

export function Inspector() {
  const edit = useEditor((s) => s.edit)!
  const selected = useEditor((s) => s.selected)
  const [tab, setTab] = useState<Tab>('background')
  const active: Tab = selected && tab !== 'zoom' ? tab : tab
  const Panel = { clips: ClipsPanel, background: BackgroundPanel, frame: FramePanel, cursor: CursorPanel, zoom: ZoomPanel, text: TextPanel, camera: CameraPanel, audio: AudioPanel }[active]

  // the editor walkthrough opens each tab as it explains it
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<Tab>).detail
      if (TABS.some((t) => t.id === id)) setTab(id)
    }
    window.addEventListener('ilf:tab', on)
    return () => window.removeEventListener('ilf:tab', on)
  }, [])

  // jump to zoom tab when a segment gets selected
  const [lastSel, setLastSel] = useState<string | null>(null)
  if (selected !== lastSel) {
    setLastSel(selected)
    if (selected) setTab(edit.clips.some((c) => c.id === selected) ? 'clips' : edit.cursor.hidden.some((r) => r.id === selected) ? 'cursor' : edit.audio.clips.some((c) => c.id === selected) ? 'audio' : edit.texts.some((t) => t.id === selected) ? 'text' : 'zoom')
  }

  return (
    <div className="flex h-full">
      <div className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-white/[0.05] py-3">
        {TABS.map((t) => (
          <Tip key={t.id} content={t.label} side="left">
            <button
              data-tab={t.id}
              aria-label={t.label}
              onClick={() => {
                setTab(t.id)
                offerTour(`tab-${t.id}`)
              }}
              className={cn('relative grid h-10 w-10 place-items-center rounded-xl transition-colors', tab === t.id ? 'text-white' : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300')}
            >
              {tab === t.id && <motion.span layoutId="tab-bg" className="absolute inset-0 rounded-xl bg-white/[0.08] ring-1 ring-white/[0.08]" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
              <t.icon className="relative h-[18px] w-[18px]" />
            </button>
          </Tip>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.05] bg-[#0e0e13]/90 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-1.5">
            <div className="text-[13px] font-semibold text-zinc-100">{TABS.find((t) => t.id === active)!.label}</div>
            <Tip content="Quick guide to this panel" side="bottom">
              <button onClick={() => replayTour(`tab-${active}`)} className="grid h-6 w-6 place-items-center rounded-md text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                <CircleHelp className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          {RESETS[active] && (
            <Tip content="Reset this tab to default settings" side="left">
              <button
                onClick={() => {
                  const p = useEditor.getState().project!
                  set((e) => RESETS[active]!(e, defaultEdit(p)))
                }}
                className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reset
              </button>
            </Tip>
          )}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={active} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.15 }}>
            <Panel edit={edit} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
