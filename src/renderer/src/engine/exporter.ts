import type { EditState, Project } from './types'
import { projectFile } from './types'
import { MotionTracks } from './motion'
import { drawFrame, drawTransition, outputSize, type FrameSources } from './compositor'
import { encodeWav, renderAudioMix } from './sounds'
import { loadBgImage } from './backgrounds'
import { loadOverlayFonts, paintOverlays } from './overlays'
import { demux, FrameSource, type Demuxed } from './decode'
import { MAIN, cameraOf, clipAt, cropOf, seqDuration, sourceInfo, transitionAt, transitionCuts, type SourceInfo } from './sequence'

export interface ExportOptions {
  format: 'mp4' | 'gif'
  height: number
  fps: number
  quality: 'standard' | 'high' | 'ultra'
  target: string
}

export interface ExportProgress {
  p: number
  stage: string
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * Renders every frame with the same compositor as the preview and streams raw
 * pixels into ffmpeg (multi-threaded x264) through the preload bridge.
 */
export async function exportProject(
  project: Project,
  edit: EditState,
  opts: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal: { cancelled: boolean }
): Promise<string> {
  onProgress({ p: 0, stage: 'Preparing' })
  if (edit.background.kind === 'image') await loadBgImage(edit.background.value).decode().catch(() => {})
  await loadOverlayFonts(edit)
  const clips = edit.clips
  const used = [...new Set(clips.map((c) => c.source))].map((id) => sourceInfo(project, id)).filter(Boolean) as SourceInfo[]
  const demuxed = new Map<string, Demuxed>()
  for (const src of used) demuxed.set(src.id, await demux(await (await fetch(src.url)).arrayBuffer()))
  const usesMain = clips.some((c) => c.source === MAIN)
  // webcam footage of every source that has one (the main take or imported recordings)
  const camDemuxed = new Map<string, Demuxed>()
  if (edit.camera.enabled)
    for (const src of used) {
      const cam = cameraOf(project, src.id)
      if (cam) camDemuxed.set(src.id, await demux(await (await fetch(projectFile(project, cam.file))).arrayBuffer()))
    }

  const first = demuxed.get(clips[0].source)!
  const fc = cropOf(edit.crops, clips[0].source)
  const [W, H] = outputSize(edit.aspect, first.width * fc.w, first.height * fc.h, opts.format === 'gif' ? Math.min(opts.height, 1080) : opts.height)
  const fps = opts.format === 'gif' ? Math.min(opts.fps, 30) : opts.fps

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  // CPU-backed canvas + getImageData benchmarked fastest end-to-end (GPU readback stalls)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const tracks = new MotionTracks(project, edit)
  const decoders = new Map<string, FrameSource>()
  for (const [id, d] of demuxed) decoders.set(id, new FrameSource(d))
  const camDecoders = new Map<string, FrameSource>()
  for (const [id, d] of camDemuxed) camDecoders.set(id, new FrameSource(d))
  // last decoded source time per decoder, to detect cuts that need a hard jump
  const lastT = new Map<string, number>()
  const lastCamT = new Map<string, number>()

  // transitions show a held frame of the neighbouring clip: decode those up front
  const holds = new Map<string, ImageBitmap>()
  const holdKey = (source: string, t: number) => source + '@' + t.toFixed(4)
  const holdA = (out: number) => Math.max(0, out - 0.5 / fps)
  for (const c of transitionCuts(clips)) {
    for (const [source, t] of [[clips[c.a].source, holdA(clips[c.a].out)], [clips[c.b].source, clips[c.b].in]] as [string, number][]) {
      const key = holdKey(source, t)
      if (holds.has(key)) continue
      const dec = decoders.get(source)!
      dec.jump(t)
      const f = await dec.frameAt(t)
      if (f) holds.set(key, await createImageBitmap(f))
    }
  }
  if (holds.size) for (const id of decoders.keys()) lastT.delete(id)
  const total = Math.max(1, Math.round(seqDuration(clips) * fps))

  const token: string = window.ilf.export.start({ target: opts.target, width: W, height: H, fps, quality: opts.quality, format: opts.format, pixFmt: 'rgba' })
  const inflight: Promise<void>[] = []
  const t0 = performance.now()
  let lastUi = 0

  try {
    for (let i = 0; i < total; i++) {
      if (signal.cancelled) throw new Error('cancelled')
      const T = i / fps
      const hit = clipAt(clips, T)!
      const dec = decoders.get(hit.clip.source)!
      const prev = lastT.get(hit.clip.source)
      if (prev === undefined || hit.srcT < prev - 1e-3 || hit.srcT - prev > 1.0) dec.jump(hit.srcT)
      lastT.set(hit.clip.source, hit.srcT)
      const sf = await dec.frameAt(hit.srcT)
      const d = demuxed.get(hit.clip.source)!
      let cf: VideoFrame | null = null
      const camInfo = cameraOf(project, hit.clip.source)
      const camDec = camDecoders.get(hit.clip.source)
      if (camDec && camInfo) {
        const ct = hit.srcT - camInfo.offset
        if (ct >= 0) {
          const prevCam = lastCamT.get(hit.clip.source) ?? -1
          if (ct < prevCam - 1e-3 || ct - prevCam > 1.0) camDec.jump(ct)
          lastCamT.set(hit.clip.source, ct)
          cf = await camDec.frameAt(ct)
        }
      }
      const liveSrc: FrameSources = {
        screen: sf,
        screenW: sf?.displayWidth ?? d.width,
        screenH: sf?.displayHeight ?? d.height,
        crop: cropOf(edit.crops, hit.clip.source),
        cam: cf,
        camW: cf?.displayWidth ?? 0,
        camH: cf?.displayHeight ?? 0
      }
      const trn = transitionAt(clips, T)
      const held = trn
        ? hit.index === trn.a
          ? holds.get(holdKey(clips[trn.b].source, clips[trn.b].in))
          : holds.get(holdKey(clips[trn.a].source, holdA(clips[trn.a].out)))
        : undefined
      if (trn && held) {
        const liveIsA = hit.index === trn.a
        const heldSrc: FrameSources = { screen: held, screenW: held.width, screenH: held.height, crop: cropOf(edit.crops, liveIsA ? clips[trn.b].source : clips[trn.a].source), cam: null, camW: 0, camH: 0 }
        drawTransition(
          ctx, W, H, trn.kind, trn.p,
          { t: Math.min(T, trn.cut - 1e-4), src: liveIsA ? liveSrc : heldSrc },
          { t: Math.max(T, trn.cut), src: liveIsA ? heldSrc : liveSrc },
          edit, tracks, 'medium'
        )
      } else drawFrame(ctx, W, H, T, project, edit, tracks, liveSrc, 'medium')
      paintOverlays(ctx, W, H, T, edit)
      inflight.push(window.ilf.export.frame(token, ctx.getImageData(0, 0, W, H).data.buffer as ArrayBuffer))
      if (inflight.length >= 3) await inflight.shift()
      const now = performance.now()
      if (now - lastUi > 32) {
        lastUi = now
        onProgress({ p: ((i + 1) / total) * 0.94, stage: 'Rendering frames' })
        await nextFrame() // let the UI paint so progress stays smooth
      }
    }
    await Promise.all(inflight)
    console.log('[export]', total, 'frames in', Math.round(performance.now() - t0), 'ms')
  } catch (e) {
    await Promise.allSettled(inflight)
    await window.ilf.export.cancel(token)
    throw e
  } finally {
    decoders.forEach((x) => x.close())
    camDecoders.forEach((x) => x.close())
    holds.forEach((b) => b.close())
  }

  if (opts.format === 'mp4') {
    onProgress({ p: 0.95, stage: 'Mixing audio' })
    const ac = new AudioContext({ sampleRate: 48000 })
    const decodeUrl = async (url: string) => {
      try {
        return await ac.decodeAudioData(await (await fetch(url)).arrayBuffer())
      } catch {
        return null
      }
    }
    const mic = usesMain && project.mic && !edit.audio.muted ? await decodeUrl(projectFile(project, project.mic.file)) : null
    const sourceAudio = new Map<string, AudioBuffer>()
    for (const src of used) {
      if (!src.hasAudio) continue
      const b = await decodeUrl(src.url)
      if (b) sourceAudio.set(src.id, b)
    }
    ac.close()
    const mix = await renderAudioMix(project, edit, mic, sourceAudio)
    if (mix) await window.ilf.export.audio(token, encodeWav(mix))
  }
  onProgress({ p: 0.97, stage: opts.format === 'gif' ? 'Encoding GIF' : 'Finalizing' })
  const out = await window.ilf.export.finish(token, { format: opts.format, gifWidth: Math.min(W, 1280), gifFps: Math.min(fps, 24) })
  onProgress({ p: 1, stage: 'Done' })
  return out
}
