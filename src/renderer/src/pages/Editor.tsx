import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, Crop, Download, FilePlus2, Film, Type, Maximize2, Pause, Play, Redo2, Scissors, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Trash2, Undo2, ZoomIn } from 'lucide-react'
import { Titlebar, LogoMark } from '@/components/Brand'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useEditor, addSegmentAt, removeSelected, addHideAt, addTextAt, splitAtPlayhead, deleteSeqClip, appendSources } from '@/editor/store'
import { Preview, player } from '@/editor/Preview'
import { Timeline } from '@/editor/Timeline'
import { Inspector } from '@/editor/Inspector'
import { ExportDialog } from '@/editor/ExportDialog'
import { migrateEdit, uid, type Project } from '@/engine/types'
import { autoZoomSegments } from '@/engine/motion'
import { cn, fmtTime, modKey } from '@/lib/utils'
import { seqDuration } from '@/engine/sequence'
import { AccountBadge } from '@/components/Account'
import { AccountOrb, HelpMenu } from '@/components/Pro'
import { CropEditor, openCrop } from '@/editor/CropEditor'
import { useFirstRunTour } from '@/components/Tour'
import { track, trackOncePerSession } from '@/lib/telemetry'
import { navigate } from '@/App'

function ToolBtn({ tip, onClick, disabled, children, active }: { tip: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean }) {
  return (
    <Tip content={tip}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition-all duration-150 hover:bg-white/[0.08] hover:text-white active:scale-95 disabled:pointer-events-none disabled:opacity-30',
          active && 'bg-white/[0.08] text-white'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

/** Imports videos into this project (converted in the background) and appends them as clips. */
export async function importClips(projectId: string, paths?: string[]) {
  const added = await window.ilf.media.import(projectId, paths)
  appendSources(added)
  return added
}

function Transport({ onToast }: { onToast: (m: string) => void }) {
  const time = useEditor((s) => s.time)
  const playing = useEditor((s) => s.playing)
  const edit = useEditor((s) => s.edit)!
  const project = useEditor((s) => s.project)!
  const selected = useEditor((s) => s.selected)
  const total = seqDuration(edit.clips)
  const clipSelected = edit.clips.some((c) => c.id === selected)
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 px-8">
      <div className="flex w-[240px] items-center">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-3.5 py-1.5 text-[13px] tabular-nums">
          <span className="font-medium text-white">{fmtTime(time, true)}</span>
          <span className="text-zinc-500"> / {fmtTime(total, true)}</span>
        </div>
      </div>
      <div data-tour="transport" className="flex flex-1 items-center justify-center gap-2">
        <Tip content="Back to start">
          <Button variant="ghost" size="icon" onClick={() => player.seek(0)}><SkipBack className="h-4 w-4" /></Button>
        </Tip>
        <button onClick={() => player.toggle()} className="grid h-11 w-11 place-items-center rounded-full bg-white text-black shadow-[0_8px_24px_-6px_rgba(255,255,255,.35)] transition-transform hover:scale-105 active:scale-95">
          {playing ? <Pause className="h-[18px] w-[18px]" fill="currentColor" /> : <Play className="ml-0.5 h-[18px] w-[18px]" fill="currentColor" />}
        </button>
        <Tip content="Jump to end">
          <Button variant="ghost" size="icon" onClick={() => player.seek(total - 0.05)}><SkipForward className="h-4 w-4" /></Button>
        </Tip>
      </div>
      <div className="flex w-[240px] items-center justify-end">
        <div data-tour="tools" className="flex items-center gap-0.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-1">
          <ToolBtn tip="Split at playhead (S)" onClick={() => onToast(splitAtPlayhead() ? 'Clip split at ' + fmtTime(useEditor.getState().time, true) : 'Move the playhead inside a clip to split')}>
            <Scissors className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn tip="Delete selected clip (Del)" disabled={!clipSelected || edit.clips.length < 2} onClick={() => selected && deleteSeqClip(selected)}>
            <Trash2 className="h-4 w-4" />
          </ToolBtn>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <ToolBtn tip="Add zoom at playhead (Z)" onClick={() => addSegmentAt(useEditor.getState().time)}>
            <ZoomIn className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn tip="Add text at playhead (T)" onClick={() => { if (addTextAt(useEditor.getState().time, 'title')) onToast('Title added. Type your text on the right') }}>
            <Type className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn
            tip="Import video clips"
            onClick={async () => {
              const added = await importClips(project.id)
              if (added.length) onToast('Added ' + added.length + ' clip' + (added.length > 1 ? 's' : '') + ' to the end')
            }}
          >
            <FilePlus2 className="h-4 w-4" />
          </ToolBtn>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <ToolBtn tip="Crop video (C)" onClick={() => openCrop()}>
            <Crop className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn tip="Full screen preview (F)" onClick={() => player.fullscreen()}>
            <Maximize2 className="h-4 w-4" />
          </ToolBtn>
        </div>
      </div>
    </div>
  )
}

/** Progress card while videos are being imported / converted. */
export function ImportProgress() {
  const [st, setSt] = useState<{ label: string; p: number } | null>(null)
  useEffect(() => {
    const off = window.ilf.media.onProgress(setSt)
    return () => {
      off()
    }
  }, [])
  return (
    <AnimatePresence>
      {st && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="fixed bottom-6 left-1/2 z-50 w-[360px] -translate-x-1/2 rounded-2xl border border-white/10 bg-ink-850/95 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="truncate text-zinc-200">Importing {st.label}</span>
            <span className="tabular-nums text-zinc-400">{Math.round(st.p * 100)}%</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="bg-brand h-full rounded-full transition-[width] duration-300" style={{ width: st.p * 100 + '%' }} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default function Editor({ id }: { id: string }) {
  const project = useEditor((s) => s.project)
  const edit = useEditor((s) => s.edit)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const [exportOpen, setExportOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const loadedId = useRef<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const flashRef = useRef((m: string) => {
    setToast(m)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1800)
  })
  const flash = flashRef.current
  // changes made by an AI agent show up as a short note
  useEffect(() => {
    const on = (e: Event) => flash((e as CustomEvent<string>).detail)
    window.addEventListener('ilf:toast', on)
    return () => window.removeEventListener('ilf:toast', on)
  }, [flash])

  useEffect(() => {
    let dead = false
    window.ilf.projects
      .load(id)
      .then((p: Project) => {
        if (dead) return
        const fresh = !p.edit
        const e = migrateEdit(p, p.edit)
        // a project made from several of your own videos opens with all of them on the timeline
        if (fresh && p.imported && p.sources?.length) e.clips = [...e.clips, ...p.sources.map((s) => ({ id: uid(), source: s.id, in: 0, out: s.duration }))]
        if (fresh && (p.mode === 'auto' || p.imported)) e.zoom.segments = autoZoomSegments(p, e.clips)
        if (fresh && p.imported && p.sources?.some((s) => s.track && !s.track.cursorBaked)) e.cursor.enabled = true
        loadedId.current = p.id
        setName(p.name)
        useEditor.getState().load(p, e)
        track('project_opened', { fresh, clips: e.clips.length, camera: !!p.camera, mic: !!p.mic, len: Math.round(p.duration), imported: !p.recId, videoProject: !!p.imported, texts: e.texts.length })
      })
      .catch((err) => setError(String(err?.message ?? err)))
    return () => {
      dead = true
      useEditor.setState({ project: null, edit: null })
    }
  }, [id])

  // autosave
  useEffect(() => {
    if (!edit || !project || loadedId.current !== project.id) return
    const t = setTimeout(() => window.ilf.projects.save(project.id, { edit, name, duration: project.duration }), 500)
    return () => clearTimeout(t)
  }, [edit, name, project])

  // keyboard shortcuts + commit continuous drags
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const s = useEditor.getState()
      const mod = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        e.preventDefault()
        player.toggle()
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? s.redo() : s.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (e.key.toLowerCase() === 's' && !mod) {
        flash(splitAtPlayhead() ? 'Clip split at ' + fmtTime(s.time, true) : 'Move the playhead inside a clip to split')
      } else if (e.key.toLowerCase() === 'f' && !mod) {
        player.fullscreen()
      } else if (e.key.toLowerCase() === 'c' && !mod) {
        player.pause()
        openCrop()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected) {
        removeSelected()
      } else if (e.key.toLowerCase() === 'h' && !mod) {
        addHideAt(s.time)
      } else if (e.key.toLowerCase() === 't' && !mod) {
        if (addTextAt(s.time, 'title')) flash('Title added. Type your text on the right')
      } else if (e.key.toLowerCase() === 'z' && !mod) {
        addSegmentAt(s.time)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const d = (e.shiftKey ? 1 : 1 / 30) * (e.key === 'ArrowLeft' ? -1 : 1)
        player.seek(s.time + d)
      } else if (e.key === 'Escape') s.select(null)
    }
    const up = () => useEditor.getState().checkpoint()
    window.addEventListener('keydown', key)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  // first time in the editor: a four-card tour once the project is on screen
  useFirstRunTour('editor', !!project && !!edit)

  if (error)
    return (
      <div className="grid h-full place-items-center bg-ink-950 text-center">
        <div>
          <div className="text-[14px] text-zinc-300">Couldn't open this project</div>
          <div className="mt-1 text-[12px] text-zinc-500">{error}</div>
          <Button className="mt-4" onClick={() => navigate('/')}>Back home</Button>
        </div>
      </div>
    )

  if (!project || !edit)
    return (
      <div className="grid h-full place-items-center bg-ink-950">
        <LogoMark className="h-10 w-10 animate-pulse" />
      </div>
    )

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <Titlebar className="bg-[#0a0a0e]">
        <Button variant="ghost" size="sm" className="no-drag -ml-1" onClick={() => { player.pause(); navigate('/') }}>
          <ChevronLeft className="h-4 w-4" /> Home
        </Button>
        <div className="h-4 w-px bg-white/10" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="no-drag w-[260px] truncate rounded-md bg-transparent px-2 py-1 text-[13px] font-medium text-zinc-100 outline-none transition-colors hover:bg-white/[0.04] focus:bg-white/[0.06]"
        />
        <span className="flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[10.5px] font-medium text-zinc-400">
          {project.imported ? <><Film className="h-3 w-3 text-amber-300" /> Video project</> : project.mode === 'auto' ? <><Sparkles className="h-3 w-3 text-brand-lilac" /> Auto</> : <><SlidersHorizontal className="h-3 w-3" /> Manual</>}
        </span>
        <div className="flex-1" />
        <div className="no-drag flex items-center gap-1">
          <AccountBadge onClick={() => { player.pause(); navigate('/account') }} />
          <HelpMenu tour="editor" />
          <AccountOrb onClick={() => { player.pause(); navigate('/account') }} />
          <div className="mx-1 h-4 w-px bg-white/10" />
          <Tip content={`Undo (${modKey}+Z)`} side="bottom">
            <Button variant="ghost" size="icon-sm" disabled={!canUndo} onClick={() => useEditor.getState().undo()}><Undo2 className="h-4 w-4" /></Button>
          </Tip>
          <Tip content={`Redo (${modKey}+Shift+Z)`} side="bottom">
            <Button variant="ghost" size="icon-sm" disabled={!canRedo} onClick={() => useEditor.getState().redo()}><Redo2 className="h-4 w-4" /></Button>
          </Tip>
          <Button data-tour="export" variant="primary" size="sm" className="ml-2" onClick={() => setExportOpen(true)}>
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </Titlebar>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <motion.div initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }} data-tour="preview" className="relative min-h-0 flex-1 px-8 pt-6">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,.06),transparent_60%)]" />
            <Preview />
          </motion.div>
          <Transport onToast={flash} />
          <div data-tour="timeline" className="h-[290px] shrink-0">
            <Timeline />
          </div>
        </div>
        <div data-tour="inspector" className="w-[408px] shrink-0 border-l border-white/[0.05] bg-[#0e0e13]">
          <Inspector />
        </div>
      </div>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <CropEditor />
      <ImportProgress />
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-ink-800/95 px-4 py-2 text-[12.5px] text-zinc-100 shadow-xl backdrop-blur"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
