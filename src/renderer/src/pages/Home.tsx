import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Camera, CameraOff, Check, ChevronRight, Clapperboard, UploadCloud, Crop as CropIcon, Maximize, Clock, Film, FolderOpen, Image as ImageIcon, Mic, MicOff, Monitor, RefreshCw, ShieldAlert, SlidersHorizontal, Sparkles, Trash2, Wand2, Zap
} from 'lucide-react'
import { Titlebar, LogoMark, Wordmark } from '@/components/Brand'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import { Tip } from '@/components/ui/tooltip'
import { cn, fmtTime, modKey, timeAgo } from '@/lib/utils'
import { abortLocal, startRecording, stopRecording } from '@/lib/recording'
import { mediaUrl, type ProjectSummary } from '@/engine/types'
import { playSfx } from '@/engine/sounds'
import { navigate } from '@/App'
import { AccountBadge } from '@/components/Account'
import { AccountOrb, HelpMenu, ProTag } from '@/components/Pro'
import { useFirstRunTour } from '@/components/Tour'
import { useLicense } from '@/lib/license'

const TIPS = [
  'Press S in the editor to split a clip at the playhead.',
  'Double-click the zoom lane to add a zoom anywhere.',
  'Drop an old iloveframes recording into a project: its smart zooms come along.',
  'Click the round button between two clips to add a transition.',
  'Paste a screenshot with Ctrl+V in Screenshot Studio to beautify it.',
  'Space plays and pauses the preview.',
  'Export a GIF for READMEs and help docs.',
  'Drop your own videos on this window to start a video project.',
  'Press T in the editor to add a title at the playhead.'
]

function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Working late'
}

/** A gentle rotating tip: one line, fades between hints. */
function Tips() {
  const [i, setI] = useState(() => Math.floor(Math.random() * TIPS.length))
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % TIPS.length), 7000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="flex h-5 items-center gap-2 text-[11.5px] text-zinc-500">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-lilac/70" />
      <AnimatePresence mode="wait">
        <motion.span key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.35 }} className="truncate">
          {TIPS[i]}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

interface DisplayInfo { id: string; name: string; width: number; height: number; primary: boolean; thumbnail: string | null }
/** a chosen area in DIPs relative to its display, plus that display's DIP size */
interface AreaSel { x: number; y: number; w: number; h: number; W: number; H: number }

// survives navigation: coming back Home shows everything instantly, then refreshes quietly
const cache: { displays: DisplayInfo[]; projects: ProjectSummary[]; visited: boolean } = { displays: [], projects: [], visited: false }

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('ilf.' + k)
      return v === null ? d : JSON.parse(v)
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('ilf.' + k, JSON.stringify(v))
    } catch {}
  }
}

function usePersist<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => store.get(key, init))
  useEffect(() => store.set(key, v), [key, v])
  return [v, setV] as const
}

function MicMeter({ stream }: { stream: MediaStream | null }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!stream) return
    const ctx = new AudioContext()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    const data = new Float32Array(an.fftSize)
    let raf = 0
    let smooth = 0
    const loop = () => {
      an.getFloatTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      smooth = Math.max(peak, smooth * 0.9)
      setLevel(Math.min(1, smooth * 2.2))
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => {
      cancelAnimationFrame(raf)
      ctx.close()
    }
  }, [stream])
  return (
    <div className="flex h-6 items-end gap-[2px]">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className={cn('w-[3px] rounded-full transition-all duration-75', i / 12 < level ? (i > 9 ? 'bg-brand-pink' : 'bg-brand-orchid') : 'bg-white/10')}
          style={{ height: `${30 + (i / 12) * 70}%` }}
        />
      ))}
    </div>
  )
}

export default function Home() {
  const [displays, setDisplays] = useState<DisplayInfo[]>(cache.displays)
  const [firstVisit] = useState(() => !cache.visited)
  const [displayId, setDisplayId] = usePersist<string>('display', '')
  const [camOn, setCamOn] = usePersist('camOn', false)
  const [micOn, setMicOn] = usePersist('micEnabled', false) // off until the user explicitly turns it on
  const [camId, setCamId] = usePersist('camId', '')
  const [micId, setMicId] = usePersist('micId', '')
  const [mode, setMode] = usePersist<'auto' | 'manual'>('mode', 'auto')
  const [countdown, setCountdown] = usePersist<'0' | '3' | '5'>('countdown', '3')
  const [fps, setFps] = usePersist<'30' | '60'>('fps', '60')
  // record the whole screen, or just an area of it (remembered per display)
  const [captureMode, setCaptureMode] = usePersist<'full' | 'area'>('captureMode', 'full')
  const [areas, setAreas] = usePersist<Record<string, AreaSel>>('areas', {})
  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [camStream, setCamStream] = useState<MediaStream | null>(null)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>(cache.projects)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'processing'>('idle')
  const [stage, setStage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [perms, setPerms] = useState<any>(null)
  // bring-your-own-video projects: import progress and the drop target
  const [importing, setImporting] = useState<{ label: string; p: number } | null>(null)
  const [dropping, setDropping] = useState(false)
  const busyImport = useRef(false)

  const refreshDisplays = useCallback(async () => {
    const keep = (list: DisplayInfo[]) => list.map((x) => ({ ...x, thumbnail: x.thumbnail ?? cache.displays.find((c) => c.id === x.id)?.thumbnail ?? null }))
    const d: DisplayInfo[] = keep(await window.ilf.displays())
    cache.displays = d
    setDisplays(d)
    window.ilf.displayThumbs().then((thumbs) => {
      const withThumbs = cache.displays.map((x) => ({ ...x, thumbnail: thumbs[x.id] ?? x.thumbnail }))
      cache.displays = withThumbs
      setDisplays(withThumbs)
    })
    setDisplayId((cur) => (d.some((x) => x.id === cur) ? cur : d.find((x) => x.primary)?.id ?? d[0]?.id ?? ''))
  }, [setDisplayId])

  const refreshProjects = useCallback(async () => {
    const list: ProjectSummary[] = await window.ilf.projects.list()
    cache.projects = list
    setProjects(list)
  }, [])
  useEffect(() => {
    cache.visited = true
  }, [])

  const refreshDevices = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices()
    const c = all.filter((d) => d.kind === 'videoinput' && d.deviceId)
    const m = all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
    setCams(c)
    setMics(m)
    setCamId((cur) => (c.some((d) => d.deviceId === cur) ? cur : c[0]?.deviceId ?? ''))
    setMicId((cur) => (m.some((d) => d.deviceId === cur) ? cur : m.find((d) => d.deviceId === 'default')?.deviceId ?? m[0]?.deviceId ?? ''))
  }, [setCamId, setMicId])

  useEffect(() => {
    refreshDisplays()
    refreshProjects()
    refreshDevices()
    window.ilf.permStatus().then(setPerms)
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    const onFocus = () => {
      refreshDisplays()
      window.ilf.permStatus().then(setPerms)
    }
    window.addEventListener('focus', onFocus)
    const offChanged = window.ilf.onProjectsChanged(() => refreshProjects())
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
      window.removeEventListener('focus', onFocus)
      offChanged()
    }
  }, [refreshDisplays, refreshProjects, refreshDevices])

  // camera preview
  useEffect(() => {
    if (!camOn || phase !== 'idle') return
    let stream: MediaStream | null = null
    let dead = false
    navigator.mediaDevices
      .getUserMedia({ video: camId ? { deviceId: { exact: camId }, width: 640, height: 360 } : { width: 640, height: 360 } })
      .then((s) => {
        if (dead) return s.getTracks().forEach((t) => t.stop())
        stream = s
        setCamStream(s)
        refreshDevices()
      })
      .catch(() => setError('Could not access the camera. Check permissions.'))
    return () => {
      dead = true
      stream?.getTracks().forEach((t) => t.stop())
      setCamStream(null)
    }
  }, [camOn, camId, phase, refreshDevices])


  // mic preview
  useEffect(() => {
    if (!micOn || phase !== 'idle') return
    let stream: MediaStream | null = null
    let dead = false
    navigator.mediaDevices
      .getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true })
      .then((s) => {
        if (dead) return s.getTracks().forEach((t) => t.stop())
        stream = s
        setMicStream(s)
        refreshDevices()
      })
      .catch(() => setError('Could not access the microphone. Check permissions.'))
    return () => {
      dead = true
      stream?.getTracks().forEach((t) => t.stop())
      setMicStream(null)
    }
  }, [micOn, micId, phase, refreshDevices])

  // recording lifecycle events from main
  useEffect(() => {
    const offStop = window.ilf.rec.onStop(async () => {
      setPhase('processing')
      setStage('Finishing capture')
      playSfx('stop', 0.8)
      try {
        const project = await stopRecording()
        playSfx('done', 0.7)
        navigate('/editor/' + encodeURIComponent(project.id))
      } catch (e: any) {
        setError(e?.message ?? String(e))
        setPhase('idle')
      }
    })
    const offCancel = window.ilf.rec.onCancelled(() => {
      abortLocal()
      setPhase('idle')
      refreshProjects()
    })
    const offProc = window.ilf.rec.onProcessing((m) => setStage(m))
    return () => {
      offStop()
      offCancel()
      offProc()
    }
  }, [refreshProjects])

  const area = captureMode === 'area' ? areas[displayId] ?? null : null

  /** Open the on-screen picker. Returns the area, 'full' if they chose full screen, or null if cancelled. */
  const pickArea = async (): Promise<AreaSel | 'full' | null> => {
    const cur = areas[displayId]
    const r = await window.ilf.area.pick(displayId, cur ? { x: cur.x, y: cur.y, w: cur.w, h: cur.h } : null)
    if (!r) return null
    if (r.w >= r.W - 2 && r.h >= r.H - 2) {
      setCaptureMode('full')
      return 'full'
    }
    setAreas((m) => ({ ...m, [displayId]: r }))
    setCaptureMode('area')
    return r
  }

  const start = async () => {
    setError(null)
    let rect: AreaSel | null = null
    if (captureMode === 'area') {
      const picked = area ?? (await pickArea())
      if (!picked) return
      rect = picked === 'full' ? null : picked
    }
    setPhase('starting')
    // free preview devices
    camStream?.getTracks().forEach((t) => t.stop())
    micStream?.getTracks().forEach((t) => t.stop())
    try {
      await startRecording({
        displayId,
        cameraId: camOn ? camId || null : null,
        micId: micOn ? micId || 'default' : null,
        countdown: Number(countdown),
        mode,
        fps: Number(fps),
        area: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null
      })
      setPhase('recording')
    } catch (e: any) {
      abortLocal()
      const msg = String(e?.message ?? e)
      if (msg.includes('MAC_SCREEN_PERMISSION')) {
        setAskedScreen(true)
        setPerms((p: any) => ({ ...(p ?? {}), screen: 'denied' }))
        setError('macOS hasn’t given iloveframes Screen Recording access yet. Allow it in System Settings, then restart the app.')
      } else setError(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setPhase('idle')
    }
  }

  useEffect(() => {
    const off = window.ilf.media.onProgress((st) => st && setImporting(st))
    return () => {
      off()
    }
  }, [])

  /** Make a new project from your own videos (picked, or dropped on the window). */
  const newVideoProject = async (paths?: string[]) => {
    if (busyImport.current || phase !== 'idle') return
    busyImport.current = true
    setError(null)
    setImporting({ label: paths?.length ? `${paths.length} video${paths.length > 1 ? 's' : ''}` : 'your video', p: 0 })
    try {
      const id = await window.ilf.media.importAsProject(paths)
      if (id) navigate('/editor/' + encodeURIComponent(id))
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      busyImport.current = false
      setImporting(null)
    }
  }
  const isVideo = (p: string) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(p)

  const needsPerms = perms && perms.screen !== 'granted'
  // macOS only applies a new Screen Recording permission after a restart
  const [askedScreen, setAskedScreen] = useState(false)
  const lic = useLicense()
  const firstName = (lic?.name || lic?.license?.customerName || '').split(' ')[0]
  const [hello, setHello] = useState(() => greeting())
  useEffect(() => {
    const t = setInterval(() => setHello(greeting()), 60_000)
    return () => clearInterval(t)
  }, [])

  // a near-live preview of the screens while you're on Home
  useEffect(() => {
    if (phase !== 'idle') return
    let busy = false
    const t = setInterval(async () => {
      if (busy || document.visibilityState !== 'visible' || !document.hasFocus()) return
      busy = true
      try {
        const thumbs = await window.ilf.displayThumbs()
        const next = cache.displays.map((x) => ({ ...x, thumbnail: thumbs[x.id] ?? x.thumbnail }))
        cache.displays = next
        setDisplays(next)
      } finally {
        busy = false
      }
    }, 2500)
    return () => clearInterval(t)
  }, [phase])

  // first launch: a short, skippable tour once the screen is ready
  useFirstRunTour('home', phase === 'idle' && displays.length > 0 && !!lic && lic.state !== 'expired')

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-ink-950"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files') || phase !== 'idle') return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        const paths = [...e.dataTransfer.files].map((f) => window.ilf.pathForFile(f)).filter(Boolean)
        const vids = paths.filter(isVideo)
        if (vids.length) newVideoProject(vids)
        else if (paths.length) setError('Drop video files (MP4, MOV, WebM, MKV or AVI) to start a video project.')
      }}
    >
      <div className="pointer-events-none absolute -top-48 left-1/2 h-[520px] w-[980px] -translate-x-1/2">
        <div className="aurora-a h-full w-full rounded-full bg-[radial-gradient(closest-side,rgba(255,77,141,.13),transparent)]" />
      </div>
      <div className="aurora-b pointer-events-none absolute -top-24 right-0 h-[420px] w-[620px] rounded-full bg-[radial-gradient(closest-side,rgba(139,92,246,.12),transparent)]" />
      <div className="aurora-a pointer-events-none absolute -bottom-40 -left-24 h-[380px] w-[560px] rounded-full bg-[radial-gradient(closest-side,rgba(192,132,252,.06),transparent)]" />
      <Titlebar>
        <span className="logo-beat inline-flex"><LogoMark className="h-[22px] w-[22px]" /></span>
        <Wordmark className="text-[14px]" />
        <ProTag className="-ml-1" />
        <div className="flex-1" />
        <AccountBadge onClick={() => navigate('/account')} />
        <HelpMenu tour="home" />
        <AccountOrb onClick={() => navigate('/account')} />
        <Tip content="Open recordings folder" side="bottom">
          <Button variant="ghost" size="icon-sm" className="no-drag" onClick={async () => window.ilf.open((await window.ilf.info()).projectsDir)}>
            <FolderOpen className="h-4 w-4" />
          </Button>
        </Tip>
      </Titlebar>

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-5 px-8 pb-8 pt-7">
          {/* header */}
          <motion.div initial={firstVisit ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} className="flex items-end justify-between gap-6">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-[12px] text-zinc-500">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inset-0 animate-ping rounded-full bg-brand-pink/60 [animation-duration:2.4s]" />
                  <span className="relative h-2 w-2 rounded-full bg-brand-pink" />
                </span>
                {hello}{firstName ? `, ${firstName}` : ''}. Ready when you are.
              </div>
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.03em] text-white">
                Record a walkthrough <span className="text-gradient">people actually watch.</span>
              </h1>
              <p className="mt-1.5 text-[13px] text-zinc-400">Smooth zooms, a cinematic cursor and polished backgrounds, added for you.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
            <button
              data-tour="video-project"
              onClick={() => newVideoProject()}
              disabled={phase !== 'idle' || !!importing}
              className="group flex shrink-0 items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] py-2.5 pl-2.5 pr-4 text-left transition-all hover:border-amber-300/40 hover:bg-amber-300/[0.05] disabled:opacity-50"
            >
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-300/15 text-amber-200 transition-colors group-hover:bg-amber-300 group-hover:text-black">
                <Clapperboard className="h-4 w-4" />
              </div>
              <div>
                <div className="text-[12.5px] font-semibold text-zinc-100">Video project</div>
                <div className="text-[11px] text-zinc-500">Edit your own videos</div>
              </div>
              <ChevronRight className="ml-1 h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
            </button>
            <button
              onClick={() => navigate('/shot')}
              className="group flex shrink-0 items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] py-2.5 pl-2.5 pr-4 text-left transition-all hover:border-brand-orchid/40 hover:bg-brand-orchid/[0.06]"
            >
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-orchid/15 text-brand-lilac transition-colors group-hover:bg-brand group-hover:text-white">
                <ImageIcon className="h-4 w-4" />
              </div>
              <div>
                <div className="text-[12.5px] font-semibold text-zinc-100">Screenshot Studio</div>
                <div className="text-[11px] text-zinc-500">Beautify an image</div>
              </div>
              <ChevronRight className="ml-1 h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
            </button>
            </div>
          </motion.div>

          {needsPerms && (
            <div className="flex items-center gap-3 rounded-xl border border-brand-rose/25 bg-brand-rose/[0.06] px-4 py-2.5 text-[12.5px] text-rose-100">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">Allow Screen Recording to record on this Mac</div>
                <div className="mt-0.5 text-[11.5px] text-rose-100/70">
                  {askedScreen
                    ? 'Turn on iloveframes in System Settings → Privacy & Security → Screen Recording, then restart iloveframes. Already on after an update? Remove it with − and add it again.'
                    : 'macOS asks once. After you allow it, iloveframes needs a quick restart.'}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  setAskedScreen(true)
                  await window.ilf.permRequest('screen')
                  window.ilf.permOpenSettings('screen')
                }}
              >
                Open Settings
              </Button>
              <Button size="sm" variant="primary" onClick={() => window.ilf.relaunch()}>Restart iloveframes</Button>
            </div>
          )}

          {/* recording setup: screen on the left, options on the right */}
          <div className="glass overflow-hidden rounded-2xl">
            <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
              <div data-tour="screen" className="border-r border-white/[0.05] p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-200">
                    <Monitor className="h-4 w-4 text-zinc-500" /> Screen
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Segmented
                      layoutId="capmode"
                      size="sm"
                      value={captureMode}
                      onChange={setCaptureMode}
                      className="w-[206px]"
                      options={[
                        { value: 'full', label: <><Maximize className="h-3 w-3" /> Full screen</> },
                        { value: 'area', label: <><CropIcon className="h-3 w-3" /> Area</> }
                      ]}
                    />
                    <Tip content="Refresh screens">
                      <Button variant="ghost" size="icon-sm" onClick={refreshDisplays}><RefreshCw className="h-3.5 w-3.5" /></Button>
                    </Tip>
                  </div>
                </div>
                <div className={cn('grid gap-3', displays.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
                  {displays.map((d) => {
                    const sel = d.id === displayId
                    return (
                      <button
                        key={d.id}
                        onClick={() => setDisplayId(d.id)}
                        className={cn('group relative overflow-hidden rounded-xl border p-1.5 text-left transition-all duration-200', sel ? 'border-brand-orchid/60 bg-brand-soft shadow-[0_0_0_3px_rgba(139,92,246,.14)]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15')}
                      >
                        <div className="checker relative aspect-video overflow-hidden rounded-lg">
                          {d.thumbnail ? <img src={d.thumbnail} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-zinc-600"><Monitor className="h-5 w-5" /></div>}
                          {sel && area && (
                            <div
                              className="pointer-events-none absolute rounded-[3px] border-2 border-white/90 transition-all duration-300"
                              style={{ left: `${(area.x / area.W) * 100}%`, top: `${(area.y / area.H) * 100}%`, width: `${(area.w / area.W) * 100}%`, height: `${(area.h / area.H) * 100}%`, boxShadow: '0 0 0 999px rgba(4,3,8,.72), 0 0 0 1px rgba(192,132,252,.9), 0 0 22px 2px rgba(214,77,170,.6)' }}
                            >
                              <span className="bg-brand absolute -top-px left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[.1em] text-white shadow">Area</span>
                            </div>
                          )}
                          {sel && phase === 'idle' && (
                            <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-semibold tracking-[.12em] text-white/90 backdrop-blur">
                              <span className="live-dot h-1.5 w-1.5 rounded-full bg-brand-pink" /> LIVE
                            </div>
                          )}
                          {sel && displays.length > 1 && (
                            <div className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand shadow-lg"><Check className="h-3 w-3 text-white" strokeWidth={3} /></div>
                          )}
                        </div>
                        <div className="flex items-center justify-between px-1 pb-0.5 pt-2">
                          <span className="text-[12px] font-medium text-zinc-200">{d.name}</span>
                          <span className="text-[10.5px] tabular-nums text-zinc-500">{d.width}×{d.height}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <AnimatePresence initial={false}>
                  {captureMode === 'area' && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-orchid/15 text-brand-lilac"><CropIcon className="h-4 w-4" /></div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] font-medium text-zinc-200">{area ? 'Recording an area' : 'Choose an area'}</div>
                          <div className="truncate text-[11px] tabular-nums text-zinc-500">
                            {area ? (() => {
                              const d = displays.find((x) => x.id === displayId)
                              const k = d ? d.width / area.W : 1
                              return `${Math.round(area.w * k)} × ${Math.round(area.h * k)} px · only this part is saved`
                            })() : 'Drag a rectangle on your screen'}
                          </div>
                        </div>
                        <Button size="sm" variant={area ? 'secondary' : 'primary'} disabled={phase !== 'idle' || !displayId} onClick={() => pickArea()}>
                          {area ? 'Change' : 'Select area'}
                        </Button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex flex-col divide-y divide-white/[0.05]">
                <div data-tour="devices" className="divide-y divide-white/[0.05]">
                {/* camera */}
                <div className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors', camOn ? 'bg-brand-pink/15 text-brand-rose' : 'bg-white/[0.05] text-zinc-500')}>
                      {camOn ? <Camera className="h-4 w-4" /> : <CameraOff className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-zinc-200">Camera</div>
                      <div className="text-[11.5px] text-zinc-500">Selfie bubble in your video</div>
                    </div>
                    <Switch checked={camOn} onCheckedChange={setCamOn} />
                  </div>
                  <AnimatePresence initial={false}>
                    {camOn && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        <div className="flex items-center gap-3 pt-3">
                          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-black ring-2 ring-white/15">
                            <video ref={(el) => { if (el && el.srcObject !== camStream) el.srcObject = camStream }} autoPlay muted playsInline className="h-full w-full scale-x-[-1] object-cover" />
                          </div>
                          <Select value={camId} onChange={setCamId} options={cams.map((c, i) => ({ value: c.deviceId, label: c.label || `Camera ${i + 1}` }))} placeholder="Choose camera" />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {/* microphone */}
                <div className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors', micOn ? 'bg-brand-orchid/15 text-brand-lilac' : 'bg-white/[0.05] text-zinc-500')}>
                      {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-zinc-200">Microphone</div>
                      <div className="text-[11.5px] text-zinc-500">Voice-over with noise suppression</div>
                    </div>
                    <Switch checked={micOn} onCheckedChange={setMicOn} />
                  </div>
                  <AnimatePresence initial={false}>
                    {micOn && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                        <div className="flex items-center gap-3 pt-3">
                          <div className="flex h-9 shrink-0 items-center rounded-lg bg-black/25 px-2.5 ring-1 ring-white/[0.06]">
                            <MicMeter stream={micStream} />
                          </div>
                          <Select value={micId} onChange={setMicId} options={mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Microphone ${i + 1}` }))} placeholder="Choose microphone" />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                </div>
                {/* mode */}
                <div data-tour="mode" className="px-5 py-4">
                  <div className="mb-3 flex items-center gap-3">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-zinc-400"><Wand2 className="h-4 w-4" /></div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-zinc-200">Editing mode</div>
                      <div className="truncate text-[11.5px] text-zinc-500">{mode === 'auto' ? 'Auto-zooms on clicks and typing. Tweak anything after.' : 'Clean recording. You place every zoom yourself.'}</div>
                    </div>
                  </div>
                  <Segmented layoutId="mode" size="sm" value={mode} onChange={setMode} options={[{ value: 'auto', label: <><Sparkles className="h-3.5 w-3.5" /> Automatic</> }, { value: 'manual', label: <><SlidersHorizontal className="h-3.5 w-3.5" /> Manual</> }]} />
                </div>
              </div>
            </div>

            {/* action bar */}
            <div className="flex items-center gap-3 border-t border-white/[0.05] bg-black/20 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400"><Clock className="h-3.5 w-3.5 text-zinc-500" /> Countdown</span>
                <Segmented layoutId="cd" size="sm" value={countdown} onChange={setCountdown} options={[{ value: '0', label: 'Off' }, { value: '3', label: '3s' }, { value: '5', label: '5s' }]} className="w-[132px]" />
              </div>
              <div className="ml-2 flex items-center gap-2.5">
                <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400"><Zap className="h-3.5 w-3.5 text-zinc-500" /> Frame rate</span>
                <Segmented layoutId="fps" size="sm" value={fps} onChange={setFps} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} className="w-[132px]" />
              </div>
              <div className="flex-1" />
              <div className="hidden text-right text-[11px] leading-tight text-zinc-500 lg:block">
                Stop anytime
                <div className="mt-0.5 font-medium text-zinc-400">{modKey} + Shift + 2</div>
              </div>
              <Button data-tour="record" variant="record" size="lg" onClick={start} disabled={!displayId || phase !== 'idle'} className={cn('min-w-[190px]', phase === 'idle' && displayId && 'breathe')}>
                <span className="relative flex h-3 w-3">
                  <span className="absolute inset-0 animate-pulse-ring rounded-full bg-white/70" />
                  <span className="relative h-3 w-3 rounded-full bg-white" />
                </span>
                Start recording
              </Button>
            </div>
          </div>
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-2.5 text-[12.5px] text-red-300">{error}</div>}

          {/* recent projects: compact row */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-300">
                <Film className="h-4 w-4 text-zinc-500" /> Recent projects
                <span className="text-[11px] tabular-nums text-zinc-600">{projects.length}</span>
              </div>
            </div>
            {projects.length === 0 ? (
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-white/[0.08] px-4 py-4 text-[12px] text-zinc-500">
                <Film className="h-4 w-4 text-zinc-600" /> Your recordings and video projects will show up here, ready to edit and export.
              </div>
            ) : (
              <div data-tour="recent" className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
                {projects.map((p, i) => (
                  <motion.div
                    key={p.id}
                    initial={firstVisit ? { opacity: 0, y: 6 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 8) * 0.03 }}
                    className="group relative w-[188px] shrink-0 cursor-pointer overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5 transition-all hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.04]"
                    onClick={() => navigate('/editor/' + encodeURIComponent(p.id))}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                      {p.thumb && <img src={mediaUrl(p.thumb)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />}
                      <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white/90">{fmtTime(p.duration)}</span>
                      <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button title="Show in folder" className="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-zinc-300 backdrop-blur hover:text-white" onClick={(e) => { e.stopPropagation(); window.ilf.open(p.dir) }}>
                          <FolderOpen className="h-3 w-3" />
                        </button>
                        <button
                          title="Delete"
                          className="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-zinc-300 backdrop-blur hover:bg-red-500/80 hover:text-white"
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (!confirm(`Delete "${p.name}"? This can't be undone.`)) return
                            await window.ilf.projects.remove(p.id)
                            refreshProjects()
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <div className="px-1 pb-0.5 pt-1.5">
                      <div className="truncate text-[12px] font-medium text-zinc-200">{p.name.split(' · ')[0]}</div>
                      <div className="truncate text-[10.5px] text-zinc-500">{timeAgo(p.createdAt)}{p.mode === 'auto' ? ' · Auto' : ''}</div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </section>
          <Tips />
        </div>
      </main>

      {/* drop your own videos anywhere */}
      <AnimatePresence>
        {dropping && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-3 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-amber-300/60 bg-ink-950/80 backdrop-blur-md">
            <div className="flex flex-col items-center text-center">
              <div className="grid h-14 w-14 place-items-center rounded-2xl bg-amber-300/15 text-amber-200"><UploadCloud className="h-7 w-7" /></div>
              <div className="mt-4 text-[16px] font-semibold text-white">Drop to start a video project</div>
              <div className="mt-1 text-[12.5px] text-zinc-400">Every video becomes a clip on the timeline, in the order you dropped them</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {importing && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-xl">
            <div className="flex w-[360px] flex-col items-center text-center">
              <div className="relative h-16 w-16">
                <div className="absolute inset-0 animate-spin rounded-[22px] bg-[conic-gradient(from_0deg,transparent,#ffd166,#ff4d8d,transparent)] [animation-duration:1.6s]" />
                <div className="absolute inset-[3px] grid place-items-center rounded-[19px] bg-ink-950"><Clapperboard className="h-6 w-6 text-amber-200" /></div>
              </div>
              <div className="mt-5 text-[15px] font-semibold text-white">Preparing your video project</div>
              <div className="mt-1 w-full truncate text-[12px] text-zinc-400">Importing {importing.label}</div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-brand-pink transition-[width] duration-300" style={{ width: Math.max(4, importing.p * 100) + '%' }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* processing overlay */}
      <AnimatePresence>
        {(phase === 'processing' || phase === 'starting') && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-50 grid place-items-center bg-ink-950/85 backdrop-blur-xl">
            <div className="flex flex-col items-center">
              <div className="relative h-20 w-20">
                <div className="absolute inset-0 animate-spin rounded-[26px] bg-[conic-gradient(from_0deg,transparent,#ff4d8d,#8b5cf6,transparent)] [animation-duration:1.6s]" />
                <div className="absolute inset-[3px] grid place-items-center rounded-[23px] bg-ink-950">
                  <LogoMark className="h-10 w-10" />
                </div>
              </div>
              <div className="mt-6 text-[16px] font-semibold text-white">{phase === 'starting' ? 'Get ready…' : 'Polishing your recording'}</div>
              <div className="mt-1.5 text-[12.5px] text-zinc-400">{phase === 'starting' ? 'Recording starts after the countdown' : stage + '…'}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
