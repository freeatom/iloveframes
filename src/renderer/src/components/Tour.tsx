import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { cn, modKey } from '@/lib/utils'
import { track } from '@/lib/telemetry'
import { LogoMark } from './Brand'

/**
 * A short, skippable walkthrough. Each step points at an element marked with
 * data-tour="…"; steps whose element isn't on screen are skipped, so the tour
 * never points at nothing. Esc skips, the arrow keys move between cards.
 */
export type PanelTour = 'tab-clips' | 'tab-background' | 'tab-frame' | 'tab-cursor' | 'tab-zoom' | 'tab-text' | 'tab-camera' | 'tab-audio'
export type TourName = 'home' | 'editor' | PanelTour
interface Step {
  target?: string
  /** editor tab to open while this card is showing */
  tab?: 'clips' | 'background' | 'frame' | 'cursor' | 'zoom' | 'text' | 'camera' | 'audio'
  title: string
  body: React.ReactNode
}

export const TOURS: Record<TourName, Step[]> = {
  home: [
    { title: 'Welcome to iloveframes', body: 'A quick look around. It takes about 30 seconds, and you can skip anytime.' },
    { target: 'screen', title: 'Pick a screen', body: 'Choose the display to record. The preview here is live.' },
    { target: 'devices', title: 'Camera & mic', body: 'Add a selfie bubble or a voice-over. Both stay off until you switch them on.' },
    { target: 'mode', title: 'Automatic or manual', body: 'Automatic zooms in on your clicks and typing for you. Manual starts clean.' },
    { target: 'record', title: 'Hit record', body: <>Talk it through like you would on a call. Stop with <kbd className="tour-kbd">{modKey}</kbd> <kbd className="tour-kbd">Shift</kbd> <kbd className="tour-kbd">2</kbd> or the floating bar.</> },
    { target: 'video-project', title: 'Edit your own videos', body: 'Start a project from videos you already have, or drop them anywhere on this window. Trim, add text, music and transitions.' },
    { target: 'recent', title: 'Your projects', body: 'Every recording lands here, ready to edit and export.' },
    { target: 'account', title: 'Account & help', body: 'Your license lives here, and the ? button replays this tour whenever you like.' }
  ],
  editor: [
    { target: 'preview', title: 'Your video, already polished', body: 'This is exactly what you’ll export: zooms, cursor, background and all. Click it to play or pause.' },
    { target: 'transport', title: 'Play and navigate', body: <><kbd className="tour-kbd">Space</kbd> plays. <kbd className="tour-kbd">←</kbd> <kbd className="tour-kbd">→</kbd> step a frame, add <kbd className="tour-kbd">Shift</kbd> to jump a second.</> },
    { target: 'tools', title: 'Quick tools', body: <>Split at the playhead <kbd className="tour-kbd">S</kbd>, delete a clip, add a zoom <kbd className="tour-kbd">Z</kbd>, hide the cursor, import a clip, crop <kbd className="tour-kbd">C</kbd>, or preview full screen <kbd className="tour-kbd">F</kbd>.</> },
    { target: 'lane-clips', title: 'Clips', body: 'Drag a clip to reorder it, drag its edges to trim. The round button between two clips adds a transition.' },
    { target: 'lane-zoom', title: 'Zooms', body: 'Each purple block is a zoom. Drag to move, pull the edges to stretch, double-click empty space to add one.' },
    { target: 'lane-hide', title: 'Cursor', body: 'Double-click this lane to hide the cursor for a stretch, like while you type a password.' },
    { target: 'lane-audio', title: 'Sounds & music', body: 'Drop music or a voice-over here from the Audio tab or straight from your computer.' },
    { target: 'inspector', tab: 'clips', title: 'Clips panel', body: 'Import videos, add earlier recordings with their smart data, and pick transitions.' },
    { target: 'inspector', tab: 'background', title: 'Background', body: 'Wallpapers, studio backgrounds, gradients, or your own photo.' },
    { target: 'inspector', tab: 'frame', title: 'Frame', body: 'Aspect ratio for every platform, crop, padding, rounded corners and shadow.' },
    { target: 'inspector', tab: 'cursor', title: 'Cursor', body: 'Style, size and smoothing, click effects, and hiding it while you type.' },
    { target: 'inspector', tab: 'zoom', title: 'Zoom', body: 'Regenerate smart zooms, set the speed, choose follow-cursor or a fixed point.' },
    { target: 'inspector', tab: 'camera', title: 'Camera', body: 'Your webcam bubble: shape, corner and size.' },
    { target: 'inspector', tab: 'audio', title: 'Audio', body: 'Mic volume, click, typing and zoom sounds, and your own audio.' },
    { target: 'export', title: 'Share it', body: 'Export an MP4 up to 4K at 60fps, or a GIF. Tap ? on any panel later for a closer look.' }
  ],
  // one short guide per editor tab, shown the first time each tab is opened
  'tab-clips': [
    { target: 'clips-media', title: 'Your clips', body: 'Everything in this project. Import more videos, or press + to add one to the end of the timeline.' },
    { target: 'clips-recordings', title: 'Earlier recordings', body: 'Bring in a past take with one click. Its clicks, typing and cursor come along, so smart zoom works on it too.' },
    { target: 'clips-transitions', title: 'Transitions', body: 'Pick how one clip flows into the next, or click the round button on any cut in the timeline.' }
  ],
  'tab-background': [
    { target: 'bg-studio', title: 'Pick a backdrop', body: 'Wallpapers, studio backgrounds and gradients. Click one and the preview updates instantly.' },
    { target: 'bg-library', title: 'Use your own', body: 'Add any photo as a background. Pick it and a blur slider appears to soften it.' }
  ],
  'tab-frame': [
    { target: 'frame-crop', title: 'Crop', body: 'Trim the edges of a recording. Nothing is lost: the file and its smart data stay intact.' },
    { target: 'frame-aspect', title: 'Fit the platform', body: '16:9 for YouTube, 9:16 for Reels and Shorts, 1:1 or 4:5 for feeds.' },
    { target: 'frame-style', title: 'Give it depth', body: 'Padding, rounded corners and a soft shadow make your screen feel like a product shot.' }
  ],
  'tab-cursor': [
    { target: 'cursor-main', title: 'Cinematic cursor', body: 'Dynamic switches between arrow and hand like macOS. Size and smoothing set the feel.' },
    { target: 'cursor-clicks', title: 'Click effects', body: 'A ripple or highlight on every click so viewers never miss one.' },
    { target: 'cursor-hide', title: 'Hide it anywhere', body: 'Add a hide range for moments the cursor would distract.' }
  ],
  'tab-zoom': [
    { target: 'zoom-main', title: 'Smart zoom', body: 'Zooms are placed on your clicks and typing. Regenerate them any time after edits.' },
    { target: 'zoom-motion', title: 'How it moves', body: 'Choose slow, normal or snappy ease, and how closely the camera follows the cursor.' },
    { target: 'zoom-list', title: 'Every zoom', body: 'Click one to jump to it. Each can follow the cursor or lock on a fixed point.' }
  ],
  'tab-text': [
    { target: 'text-add', title: 'Titles and captions', body: 'Pick a style to drop it at the playhead. Change the words, spot, colour and animation on the right, and its timing on the Text lane.' }
  ],
  'tab-camera': [
    { target: 'camera-main', title: 'Your webcam bubble', body: 'Pick a shape, corner and size. It shrinks politely while the screen zooms in.' }
  ],
  'tab-audio': [
    { target: 'audio-voice', title: 'Your voice', body: 'Mic volume, or mute it. Recorded with noise suppression.' },
    { target: 'audio-click', title: 'Sound design', body: 'Click, typing and zoom sounds bring a silent demo to life. Tap a sound to preview it.' },
    { target: 'audio-library', title: 'Your own audio', body: 'Upload music or voice-overs, then drag them onto the Audio lane of the timeline.' }
  ]
}

const KEY = (n: TourName) => `ilf.tour.${n}.v1`
const seen = (n: TourName) => {
  try {
    return localStorage.getItem(KEY(n)) === 'done'
  } catch {
    return true
  }
}
const markSeen = (n: TourName) => {
  try {
    localStorage.setItem(KEY(n), 'done')
  } catch {}
}

const useTourStore = create<{ name: TourName | null; run: number }>(() => ({ name: null, run: 0 }))

/** Start a tour now (from the help menu); the other tour shows again next time too. */
export function replayTour(name: TourName) {
  try {
    if (name === 'home' || name === 'editor') localStorage.removeItem(KEY(name === 'home' ? 'editor' : 'home'))
  } catch {}
  useTourStore.setState((s) => ({ name, run: s.run + 1 }))
}

/** Offer a tour once (e.g. the first time a tab opens), unless another one is showing. */
export function offerTour(name: TourName, delay = 450) {
  if (seen(name)) return
  setTimeout(() => {
    if (seen(name) || useTourStore.getState().name) return
    markSeen(name) // shown once: quitting mid-tour doesn't bring it back next launch
    useTourStore.setState((s) => ({ name, run: s.run + 1 }))
  }, delay)
}

/** Show a tour once, the first time this screen is ready. */
export function useFirstRunTour(name: TourName, ready: boolean) {
  useEffect(() => {
    if (!ready || seen(name)) return
    const t = setTimeout(() => {
      if (seen(name) || useTourStore.getState().name) return
      markSeen(name) // shown once: quitting mid-tour doesn't bring it back next launch
      useTourStore.setState((s) => ({ name, run: s.run + 1 }))
    }, 700)
    return () => clearTimeout(t)
  }, [name, ready])
}

type Rect = { x: number; y: number; w: number; h: number }
const PAD = 8
const CARD_W = 320

function findTarget(id?: string) {
  if (!id) return null
  const el = document.querySelector<HTMLElement>(`[data-tour="${id}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  return el
}

/** Every start mounts a fresh tour, so no step state can leak between runs. */
export function Tour() {
  const run = useTourStore((s) => s.run)
  return <TourRun key={run} />
}

function TourRun() {
  const name = useTourStore((s) => s.name)
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [cardH, setCardH] = useState(180)
  const cardRef = useRef<HTMLDivElement>(null)
  const steps = name ? TOURS[name] : []
  const step = steps[i]

  const end = useCallback((done?: unknown) => {
    if (name) {
      markSeen(name)
      track(done === true ? 'tour_finished' : 'tour_skipped', { tour: name, step: i })
    }
    useTourStore.setState({ name: null })
  }, [name, i])

  // skip over steps whose element isn't on screen
  const go = useCallback(
    (dir: 1 | -1, from = i) => {
      let j = from + dir
      while (j >= 0 && j < steps.length && steps[j].target && !findTarget(steps[j].target)) j += dir
      if (j >= steps.length) return end(true)
      if (j < 0) return
      setI(j)
    },
    [i, steps, end]
  )

  // open the tab this card talks about; its own deeper guide then isn't needed on first visit
  useEffect(() => {
    if (!step?.tab) return
    window.dispatchEvent(new CustomEvent('ilf:tab', { detail: step.tab }))
    markSeen(`tab-${step.tab}` as TourName)
  }, [step])

  // a tour belongs to the screen it started on
  useEffect(() => {
    if (!name) return
    const close = () => useTourStore.setState({ name: null })
    addEventListener('hashchange', close)
    return () => removeEventListener('hashchange', close)
  }, [name])

  // first step might itself be missing
  useEffect(() => {
    if (step?.target && !findTarget(step.target)) go(1, i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, i])

  // keep the spotlight glued to the element (resize, scroll, layout shifts)
  useLayoutEffect(() => {
    if (!step) return
    let raf = 0
    const el = findTarget(step.target)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const measure = () => {
      const e = findTarget(step.target)
      if (!e) return setRect(null)
      const r = e.getBoundingClientRect()
      setRect((p) => (p && Math.abs(p.x - r.left) < 0.5 && Math.abs(p.y - r.top) < 0.5 && Math.abs(p.w - r.width) < 0.5 && Math.abs(p.h - r.height) < 0.5 ? p : { x: r.left, y: r.top, w: r.width, h: r.height }))
    }
    const loop = () => {
      measure()
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [step])

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [i, name])

  useEffect(() => {
    if (!name) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [name, go, end])

  // place the card next to the spotlight, inside the window
  const vw = innerWidth
  const vh = innerHeight
  let cx = vw / 2 - CARD_W / 2
  let cy = vh / 2 - cardH / 2
  let hole: Rect | null = null
  if (step?.target && rect) {
    hole = { x: rect.x - PAD, y: rect.y - PAD, w: rect.w + PAD * 2, h: rect.h + PAD * 2 }
    const gap = 14
    const below = hole.y + hole.h + gap
    const above = hole.y - gap - cardH
    const right = hole.x + hole.w + gap
    const left = hole.x - gap - CARD_W
    if (below + cardH < vh - 12) {
      cy = below
      cx = hole.x + hole.w / 2 - CARD_W / 2
    } else if (above > 12) {
      cy = above
      cx = hole.x + hole.w / 2 - CARD_W / 2
    } else if (right + CARD_W < vw - 12) {
      cx = right
      cy = hole.y + hole.h / 2 - cardH / 2
    } else if (left > 12) {
      cx = left
      cy = hole.y + hole.h / 2 - cardH / 2
    } else {
      cy = vh - cardH - 20
    }
    cx = Math.max(12, Math.min(vw - CARD_W - 12, cx))
    cy = Math.max(12, Math.min(vh - cardH - 12, cy))
  }
  const visible = steps.filter((s) => !s.target || findTarget(s.target))
  const pos = Math.max(0, visible.indexOf(step!))
  const last = (() => {
    for (let j = i + 1; j < steps.length; j++) if (!steps[j].target || findTarget(steps[j].target)) return false
    return true
  })()
  const spring = { type: 'spring', stiffness: 380, damping: 36 } as const

  return (
    <AnimatePresence>
      {name && step && (
        <motion.div key="tour" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="fixed inset-0 z-[115]" onPointerDown={(e) => e.stopPropagation()}>
          {/* dim everything except the spotlight */}
          {hole ? (
            <motion.div
              className="tour-hole pointer-events-none absolute rounded-2xl"
              initial={false}
              animate={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
              transition={spring}
            />
          ) : (
            <div className="absolute inset-0 bg-[rgba(5,5,8,.66)] backdrop-blur-[2px]" />
          )}
          {/* eat clicks on the page underneath */}
          <div className="absolute inset-0" />

          <motion.div
            ref={cardRef}
            role="dialog"
            aria-label={step.title}
            className="absolute rounded-2xl border border-white/10 bg-ink-850/95 p-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,.9)] backdrop-blur-xl"
            style={{ width: CARD_W }}
            initial={{ left: cx, top: cy + 6, opacity: 0 }}
            animate={{ left: cx, top: cy, opacity: 1 }}
            transition={spring}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
                <div className="flex items-start gap-3">
                  {!step.target && <LogoMark className="mt-0.5 h-8 w-8 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold tracking-[-0.01em] text-white">{step.title}</div>
                    <div className="mt-1 text-[12.5px] leading-relaxed text-zinc-400">{step.body}</div>
                  </div>
                  <button onClick={end} title="Close (Esc)" className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-white/10 hover:text-white">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </motion.div>
            </AnimatePresence>
            <div className="mt-4 flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {visible.length > 8 ? (
                  // long tours: a calm counter plus a thin progress line instead of a row of dots
                  <div className="flex w-full items-center gap-2.5">
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-zinc-500">{pos + 1} / {visible.length}</span>
                    <span className="relative h-1 max-w-[90px] flex-1 overflow-hidden rounded-full bg-white/10">
                      <span className="bg-brand absolute inset-y-0 left-0 rounded-full transition-[width] duration-300" style={{ width: `${((pos + 1) / visible.length) * 100}%` }} />
                    </span>
                  </div>
                ) : (
                  visible.map((s, k) => (
                    <span key={s.title + k} className={cn('h-1.5 shrink-0 rounded-full transition-all duration-300', k === pos ? 'w-5 bg-brand' : k < pos ? 'w-1.5 bg-white/40' : 'w-1.5 bg-white/15')} />
                  ))
                )}
              </div>
              <button onClick={end} className="h-8 shrink-0 rounded-lg px-2.5 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                Skip
              </button>
              {pos > 0 && (
                <button onClick={() => go(-1)} title="Back" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-white">
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
              )}
              <button onClick={() => go(1)} className="bg-brand flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-semibold text-white shadow-glow transition-[filter] hover:brightness-110">
                {last ? 'Done' : pos === 0 && !step.target ? 'Show me' : 'Next'}
                {!last && <ArrowRight className="h-3.5 w-3.5" />}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
