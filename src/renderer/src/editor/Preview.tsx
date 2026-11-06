import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Minimize2, Pause, Play } from 'lucide-react'
import { useEditor } from './store'
import { MotionTracks } from '@/engine/motion'
import { drawFrame, drawTransition, outputSize, type FrameSources } from '@/engine/compositor'
import { projectFile } from '@/engine/types'
import { playSfx, keyVariant, zoomCues, liveCtx, loadUserSound } from '@/engine/sounds'
import { loadBgImage } from '@/engine/backgrounds'
import { paintOverlays } from '@/engine/overlays'
import { MAIN, cameraOf, clipAt, cropOf, seqDuration, seqEvents, sourceInfo, transitionAt, transitionCuts } from '@/engine/sequence'
import { fmtTime } from '@/lib/utils'

/** Imperative player shared by preview, timeline and keyboard shortcuts. */
export const player = {
  seek: (_t: number) => {},
  play: () => {},
  pause: () => {},
  toggle: () => {},
  redraw: () => {},
  restartClips: () => {},
  fullscreen: () => {},
  /** render the edited video at t and return it as a JPEG data URL (for AI agents) */
  snapshot: async (_t: number): Promise<string | null> => null
}
;(window as any).__ilfPlayer = player // test harness hook
/** How each drawn frame got its webcam picture (test harness hook). */
const camStats = { live: 0, held: 0, missing: 0 }
;(window as any).__ilfCamStats = camStats

/** The frame a held side of a transition shows: last frame of the outgoing clip, first of the incoming. */
const holdTimeA = (out: number) => Math.max(0, out - 1 / 60)

/**
 * Plays the edited sequence: each clip is a range of a source video, played
 * back to back. Sequence time is the single clock everything else follows.
 */
export function Preview() {
  const project = useEditor((s) => s.project)!
  const edit = useEditor((s) => s.edit)!
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const micRef = useRef<HTMLAudioElement>(null)
  const videos = useRef(new Map<string, HTMLVideoElement>())
  const cams = useRef(new Map<string, HTMLVideoElement>())
  const [box, setBox] = useState({ w: 800, h: 450 })
  const [fs, setFs] = useState(false)
  const dirty = useRef(true)

  const motionKey = JSON.stringify([edit.zoom, edit.clips, edit.cursor.smoothing, edit.cursor.hideIdle, edit.cursor.hideTyping, edit.cursor.hidden, edit.crops])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tracks = useMemo(() => new MotionTracks(project, edit), [project, motionKey])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => seqEvents(project, edit.clips), [project, JSON.stringify(edit.clips)])
  const live = useRef({ edit, tracks, project, events })
  live.current = { edit, tracks, project, events }
  useEffect(() => {
    dirty.current = true
  }, [edit, tracks])

  // one hidden <video> per source (main recording + imported clips), plus each one's webcam
  useEffect(() => {
    const ids = [MAIN, ...(project.sources ?? []).map((s) => s.id)]
    for (const id of ids) {
      const cam = cameraOf(project, id)
      if (cam && !cams.current.has(id)) {
        const c = document.createElement('video')
        c.src = projectFile(project, cam.file)
        c.preload = 'auto'
        c.muted = true
        c.playsInline = true
        c.addEventListener('seeked', () => (dirty.current = true))
        c.addEventListener('loadeddata', () => (dirty.current = true))
        cams.current.set(id, c)
      }
      if (videos.current.has(id)) continue
      const info = sourceInfo(project, id)
      if (!info) continue
      const v = document.createElement('video')
      v.src = info.url
      v.preload = 'auto'
      v.playsInline = true
      v.muted = !info.hasAudio
      v.addEventListener('seeked', () => (dirty.current = true))
      v.addEventListener('loadeddata', () => (dirty.current = true))
      if (id === MAIN)
        v.addEventListener('loadedmetadata', () => {
          // trust the real file length over the recorder's estimate
          const d = v.duration
          if (!isFinite(d) || Math.abs(d - live.current.project.duration) < 0.05) return
          useEditor.getState().setProject((p) => ({ ...p, duration: d }))
          useEditor.setState((s) =>
            s.edit ? { edit: { ...s.edit, clips: s.edit.clips.map((c) => (c.source === MAIN ? { ...c, out: Math.min(c.out >= live.current.project.duration - 0.05 ? d : c.out, d) } : c)) } } : s
          )
        })
      videos.current.set(id, v)
    }
  }, [project])

  // fit canvas into the available area keeping the output aspect
  const firstSrc = sourceInfo(project, edit.clips[0]?.source ?? MAIN)
  const firstCrop = cropOf(edit.crops, edit.clips[0]?.source ?? MAIN)
  const [ow, oh] = outputSize(edit.aspect, (firstSrc?.width || 1920) * firstCrop.w, (firstSrc?.height || 1080) * firstCrop.h, 1080)
  useEffect(() => {
    const el = stageRef.current!
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const s = Math.min(r.width / ow, r.height / oh)
      setBox({ w: Math.floor(ow * s), h: Math.floor(oh * s) })
      dirty.current = true
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ow, oh])

  useEffect(() => {
    edit.audio.clips.forEach((c) => loadUserSound(c.src))
    player.restartClips()
  }, [edit.audio.clips])

  // custom background images need a redraw once decoded
  useEffect(() => {
    if (edit.background.kind !== 'image') return
    const img = loadBgImage(edit.background.value)
    img.onload = () => (dirty.current = true)
  }, [edit.background])

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onFs)
    player.fullscreen = () => {
      if (document.fullscreenElement) document.exitFullscreen()
      else stageRef.current?.requestFullscreen()
    }
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    const mic = micRef.current
    let T = useEditor.getState().time // sequence clock
    let lastT = T
    let playing = false
    let activeId: string | null = null
    let activeClip: string | null = null
    let switching = false

    const total = () => seqDuration(live.current.edit.clips)
    const vid = (id: string) => videos.current.get(id) ?? null

    // ---- held frames for transitions (a separate decoder per source, snapshots cached) ----
    const holdVids = new Map<string, HTMLVideoElement>()
    const holdCache = new Map<string, HTMLCanvasElement>()
    const holdQueue: { source: string; t: number; key: string }[] = []
    let holdBusy = false
    const pumpHolds = () => {
      if (holdBusy || !holdQueue.length) return
      const job = holdQueue.shift()!
      const info = sourceInfo(live.current.project, job.source)
      if (!info) return pumpHolds()
      let v = holdVids.get(job.source)
      if (!v) {
        v = document.createElement('video')
        v.src = info.url
        v.muted = true
        v.preload = 'auto'
        holdVids.set(job.source, v)
      }
      const hv = v
      holdBusy = true
      const done = () => {
        holdBusy = false
        dirty.current = true
        pumpHolds()
      }
      const grab = () => {
        if (hv.videoWidth) {
          const s = Math.min(1, 1920 / hv.videoWidth)
          const c = document.createElement('canvas')
          c.width = Math.round(hv.videoWidth * s)
          c.height = Math.round(hv.videoHeight * s)
          c.getContext('2d')!.drawImage(hv, 0, 0, c.width, c.height)
          holdCache.set(job.key, c)
          if (holdCache.size > 12) holdCache.delete(holdCache.keys().next().value!)
        }
        done()
      }
      const seekTo = () => {
        hv.addEventListener('seeked', grab, { once: true })
        hv.currentTime = Math.max(0, Math.min(job.t, (isFinite(hv.duration) ? hv.duration : job.t + 1) - 0.001))
      }
      if (hv.readyState >= 1) seekTo()
      else {
        hv.addEventListener('loadedmetadata', seekTo, { once: true })
        hv.addEventListener('error', done, { once: true })
      }
    }
    const hold = (source: string, t: number) => {
      const key = source + '@' + t.toFixed(3)
      const c = holdCache.get(key)
      if (c) return c
      if (!holdQueue.some((q) => q.key === key)) {
        holdQueue.push({ source, t, key })
        pumpHolds()
      }
      return null
    }
    /** Warm up the held frames for transitions near T so playback never waits. */
    const prefetch = (t: number) => {
      const clips = live.current.edit.clips
      for (const c of transitionCuts(clips)) {
        if (t < c.cut - c.half - 3 || t > c.cut + c.half) continue
        hold(clips[c.a].source, holdTimeA(clips[c.a].out))
        hold(clips[c.b].source, clips[c.b].in)
      }
    }

    const pauseAllExcept = (keep: string | null) => videos.current.forEach((v, id) => id !== keep && !v.paused && v.pause())

    /**
     * Keep a follower (webcam / mic) in step with the playing source. Seeking a
     * video is slow (it decodes from the previous keyframe), so while playing we
     * steer small drift with a gentle speed change and only jump when far off;
     * re-seeking on every small drift used to keep the webcam permanently
     * mid-seek, so it vanished for seconds.
     */
    // how long a seek takes on each follower, learned as we go (long-GOP files can take seconds)
    const seekCost = new WeakMap<HTMLMediaElement, number>()
    const seekTo = (m: HTMLMediaElement, at: number) => {
      const t0 = performance.now()
      m.addEventListener('seeked', () => seekCost.set(m, Math.min(3, (performance.now() - t0) / 1000)), { once: true })
      m.currentTime = at
    }
    const follow = (m: HTMLMediaElement, target: number, force: boolean) => {
      const at = Math.max(0, target)
      if (force || !playing) {
        m.playbackRate = 1
        if (Math.abs(m.currentTime - at) > 0.03) seekTo(m, at + (playing ? seekCost.get(m) ?? 0 : 0))
        return
      }
      if (m.seeking) return
      const drift = at - m.currentTime
      if (drift > 3 || drift < -0.6) {
        // far off: jump, landing ahead by what a seek costs here so we don't land behind again
        m.playbackRate = 1
        seekTo(m, at + (drift > 0 ? seekCost.get(m) ?? 0.15 : 0))
      } else if (drift > 0.04) m.playbackRate = Math.min(3, 1 + drift * 1.5) // behind: catch up by playing faster
      else if (drift < -0.04) m.playbackRate = Math.max(0.75, 1 + drift) // ahead: ease off
      else if (m.playbackRate !== 1) m.playbackRate = 1
    }

    /** Keep the webcam (of whichever source is playing) and the mic in step. */
    const syncAux = (source: string | null, srcT: number, force = false) => {
      const p = live.current.project
      cams.current.forEach((c, id) => id !== source && !c.paused && c.pause())
      const camInfo = source ? cameraOf(p, source) : null
      const cam = source ? cams.current.get(source) : undefined
      if (cam && camInfo) {
        const ct = srcT - camInfo.offset
        follow(cam, ct, force)
        if (playing && cam.paused && ct >= 0) cam.play().catch(() => {})
      }
      if (mic && p.mic && source === MAIN) {
        const mt = srcT - p.mic.offset
        follow(mic, mt, force)
        if (playing && mic.paused && mt >= 0) mic.play().catch(() => {})
      } else if (mic && !mic.paused) mic.pause()
    }

    // last good webcam frame per source: shown while the webcam seeks or buffers, so it never blinks out
    const camHeld = new Map<string, { canvas: HTMLCanvasElement; t: number }>()
    const camFrame = (source: string, cam: HTMLVideoElement): CanvasImageSource | null => {
      const ready = cam.readyState >= 2 && !cam.seeking && cam.videoWidth > 0
      let h = camHeld.get(source)
      if (ready) {
        if (!h) {
          h = { canvas: document.createElement('canvas'), t: -1 }
          camHeld.set(source, h)
        }
        if (h.t !== cam.currentTime || h.canvas.width !== cam.videoWidth) {
          if (h.canvas.width !== cam.videoWidth) h.canvas.width = cam.videoWidth
          if (h.canvas.height !== cam.videoHeight) h.canvas.height = cam.videoHeight
          h.canvas.getContext('2d')!.drawImage(cam, 0, 0)
          h.t = cam.currentTime
        }
        return cam
      }
      return h && h.t >= 0 ? h.canvas : null
    }

    /** Point the right source video at sequence time T. */
    const cue = (t: number, force: boolean) => {
      const hit = clipAt(live.current.edit.clips, t)
      if (!hit) return
      const v = vid(hit.clip.source)
      activeId = hit.clip.source
      activeClip = hit.clip.id
      pauseAllExcept(activeId)
      if (v && (force || Math.abs(v.currentTime - hit.srcT) > 0.08)) v.currentTime = hit.srcT
      syncAux(hit.clip.source, hit.srcT, true)
      if (playing && v) {
        switching = true
        const go = () => {
          switching = false
          if (playing) v.play().catch(() => {})
        }
        if (v.seeking) v.addEventListener('seeked', go, { once: true })
        else go()
      }
    }

    // user audio clips are scheduled on Web Audio from the current playhead
    let clipNodes: AudioBufferSourceNode[] = []
    let clipGen = 0
    const stopClips = () => {
      clipGen++
      clipNodes.forEach((n) => {
        try {
          n.stop()
        } catch {}
      })
      clipNodes = []
    }
    const startClips = async () => {
      stopClips()
      const gen = clipGen
      const ctx = liveCtx()
      for (const c of live.current.edit.audio.clips) {
        const buf = await loadUserSound(c.src)
        if (gen !== clipGen || !playing || !buf) continue
        const into = Math.max(0, T - c.start)
        if (into >= c.duration) continue
        const src = ctx.createBufferSource()
        src.buffer = buf
        const g = ctx.createGain()
        g.gain.value = c.volume
        src.connect(g).connect(ctx.destination)
        src.start(ctx.currentTime + Math.max(0, c.start - T), c.offset + into, c.duration - into)
        clipNodes.push(src)
      }
    }
    player.restartClips = () => {
      if (playing) startClips()
    }

    player.seek = (t: number) => {
      T = Math.max(0, Math.min(t, Math.max(0, total() - 0.001)))
      lastT = T
      cue(T, true)
      useEditor.getState().setTime(T)
      dirty.current = true
      if (playing) startClips()
    }
    player.play = () => {
      if (T >= total() - 0.05) T = 0
      playing = true
      lastT = T
      cue(T, true)
      startClips()
      useEditor.getState().setPlaying(true)
    }
    player.pause = () => {
      playing = false
      stopClips()
      videos.current.forEach((v) => v.pause())
      cams.current.forEach((c) => c.pause())
      mic?.pause()
      useEditor.getState().setPlaying(false)
    }
    player.toggle = () => (playing ? player.pause() : player.play())
    player.redraw = () => (dirty.current = true)
    player.snapshot = async (t: number) => {
      player.pause()
      player.seek(t)
      const settled = () => {
        const hit = clipAt(live.current.edit.clips, T)
        const v = hit ? vid(hit.clip.source) : null
        const cam = hit ? cams.current.get(hit.clip.source) : null
        return !!v && !v.seeking && v.readyState >= 2 && (!cam || !cam.seeking) && !holdBusy && !holdQueue.length
      }
      const until = Date.now() + 5000
      while (!settled() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      dirty.current = true
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const c = canvasRef.current
      if (!c) return null
      const s = Math.min(1, 1280 / c.width)
      const out = document.createElement('canvas')
      out.width = Math.round(c.width * s)
      out.height = Math.round(c.height * s)
      out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height)
      return out.toDataURL('image/jpeg', 0.85)
    }
    cue(T, true)

    let raf = 0
    let frame = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const { edit: e, tracks: tr, project: p, events: ev } = live.current
      let hit = clipAt(e.clips, T)
      if (!hit) return
      // the clip list changed under us (split / delete / reorder): re-cue
      if (hit.clip.id !== activeClip && !switching) {
        cue(T, false)
        hit = clipAt(e.clips, T)!
      }
      prefetch(T)
      const v = vid(hit.clip.source)
      if (playing && v && !switching) {
        // advance the sequence clock from the active video
        T = hit.start + (v.currentTime - hit.clip.in)
        if (v.currentTime >= hit.clip.out - 1 / 120 || v.ended) {
          const next = e.clips[hit.index + 1]
          if (!next) {
            T = total()
            player.pause()
          } else {
            T = hit.start + (hit.clip.out - hit.clip.in)
            // seamless when the next clip continues the same footage
            if (next.source === hit.clip.source && Math.abs(next.in - hit.clip.out) < 0.05) activeClip = next.id
            else cue(T + 1e-4, true)
          }
        }
        // sound effects between the previous and current frame
        const from = lastT
        if (T > from && T - from < 0.5) {
          if (e.cursor.enabled && e.sfx.click.enabled) for (const c of tr.clicks) if (c.t > from && c.t <= T) playSfx(e.sfx.click.id, e.sfx.click.volume)
          if (e.sfx.typing.enabled)
            for (const k of ev.keys)
              if (k.t > from && k.t <= T) {
                const kv = keyVariant(k.i)
                playSfx(e.sfx.typing.id, e.sfx.typing.volume * kv.gain, kv.variant)
              }
          if (e.sfx.zoom.enabled) for (const c of zoomCues(e)) if (c.t > from && c.t <= T) playSfx(e.sfx.zoom.id, e.sfx.zoom.volume, 0, c.reversed)
        }
        lastT = T
        if (++frame % 8 === 0) syncAux(hit.clip.source, hit.srcT)
        useEditor.getState().setTime(T)
      }
      if (!playing && !dirty.current) return
      dirty.current = false
      const c = canvasRef.current
      if (!c || !v) return
      const ctx = c.getContext('2d')!
      if (mic) mic.volume = e.audio.muted ? 0 : Math.min(1, e.audio.micVolume)
      if (v) v.volume = Math.max(0, Math.min(1, hit.clip.volume ?? 1))
      const camInfo = cameraOf(p, hit.clip.source)
      const cam = cams.current.get(hit.clip.source)
      const camImg = cam ? camFrame(hit.clip.source, cam) : null
      const liveSrc: FrameSources = {
        screen: v.readyState >= 2 ? v : null,
        screenW: v.videoWidth,
        screenH: v.videoHeight,
        crop: cropOf(e.crops, hit.clip.source),
        cam: e.camera.enabled && camImg && camInfo && hit.srcT >= camInfo.offset ? camImg : null,
        camW: cam?.videoWidth ?? 0,
        camH: cam?.videoHeight ?? 0
      }
      // the webcam is still seeking: keep drawing until its fresh frame arrives
      if (cam && cam.seeking) dirty.current = true
      if (cam && camInfo && e.camera.enabled && hit.srcT >= camInfo.offset + 0.1) {
        const k = camImg === cam ? 'live' : camImg ? 'held' : 'missing'
        camStats[k]++
      }
      const trn = transitionAt(e.clips, T)
      if (trn) {
        const a = e.clips[trn.a]
        const b = e.clips[trn.b]
        const liveIsA = hit.index === trn.a
        const held = liveIsA ? hold(b.source, b.in) : hold(a.source, holdTimeA(a.out))
        if (held) {
          const heldSrc: FrameSources = { screen: held, screenW: held.width, screenH: held.height, crop: cropOf(e.crops, liveIsA ? b.source : a.source), cam: null, camW: 0, camH: 0 }
          const TA = Math.min(T, trn.cut - 1e-4)
          const TB = Math.max(T, trn.cut)
          drawTransition(ctx, c.width, c.height, trn.kind, trn.p, { t: TA, src: liveIsA ? liveSrc : heldSrc }, { t: TB, src: liveIsA ? heldSrc : liveSrc }, e, tr)
          paintOverlays(ctx, c.width, c.height, T, e)
          return
        }
      }
      drawFrame(ctx, c.width, c.height, T, p, e, tr, liveSrc)
      paintOverlays(ctx, c.width, c.height, T, e)
    }
    loop()
    return () => {
      playing = false
      stopClips()
      cancelAnimationFrame(raf)
      videos.current.forEach((v) => v.pause())
      cams.current.forEach((c) => c.pause())
      holdVids.forEach((v) => {
        v.removeAttribute('src')
        v.load()
      })
    }
  }, [])

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cw = Math.min(Math.round(box.w * dpr), fs ? 3840 : 2560)
  const ch = Math.round((cw / box.w) * box.h)

  return (
    <div ref={stageRef} className="relative grid h-full w-full place-items-center bg-transparent [&:fullscreen]:bg-black">
      <canvas
        ref={canvasRef}
        width={cw}
        height={ch}
        style={{ width: box.w, height: box.h }}
        className={fs ? '' : 'rounded-xl shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)] ring-1 ring-white/[0.06]'}
        onClick={() => player.toggle()}
      />
      {fs && <FullscreenControls />}
      {project.mic && <audio ref={micRef} src={projectFile(project, project.mic.file)} preload="auto" />}
    </div>
  )
}

/** Minimal controls over the fullscreen preview; they fade away when the mouse rests. */
function FullscreenControls() {
  const playing = useEditor((s) => s.playing)
  const time = useEditor((s) => s.time)
  const clips = useEditor((s) => s.edit!.clips)
  const [show, setShow] = useState(true)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const poke = () => {
      setShow(true)
      clearTimeout(t)
      t = setTimeout(() => setShow(false), 2200)
    }
    poke()
    window.addEventListener('pointermove', poke)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointermove', poke)
    }
  }, [])
  const total = seqDuration(clips)
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          className="absolute bottom-8 left-1/2 flex w-[min(640px,80vw)] -translate-x-1/2 items-center gap-4 rounded-2xl border border-white/10 bg-black/60 px-4 py-3 backdrop-blur-xl"
        >
          <button onClick={() => player.toggle()} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-black transition-transform hover:scale-105">
            {playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
          </button>
          <span className="w-[92px] shrink-0 text-[12px] tabular-nums text-white/80">
            {fmtTime(time)} / {fmtTime(total)}
          </span>
          <div
            className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/15"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              player.seek(((e.clientX - r.left) / r.width) * total)
            }}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${(time / Math.max(0.01, total)) * 100}%` }} />
          </div>
          <button onClick={() => player.fullscreen()} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white" title="Exit full screen (Esc)">
            <Minimize2 className="h-4 w-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
