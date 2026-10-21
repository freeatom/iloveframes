import {
  app, BrowserWindow, ipcMain, screen, desktopCapturer, protocol, dialog, shell,
  systemPreferences, globalShortcut, session, Display, nativeImage, clipboard, net
} from 'electron'
import { join, extname, basename, resolve, relative, isAbsolute } from 'path'
import { CONFIG } from './config'
import { projectName } from '../shared/naming'
import { checkForUpdates, installNow, startAutoUpdates, updateState } from './updater'
import { promises as fsp, createReadStream, existsSync, statSync, mkdirSync } from 'fs'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { InputTracker, startNativeCapture } from './recorder'
import { runFfmpeg, LiveCapture, captureOutput, cropFilter, type CropFrac } from './ffmpeg'
import { initLicense, status as licenseStatus, isUnlocked, activate as licenseActivate, deactivate as licenseDeactivate, setName as licenseSetName } from './license'
import { importWallpapers, listWallpapers, removeWallpaper, importSounds, listSounds, removeSound, bundledWallpaperDir } from './library'
import { appendRecData, readRecData, readSiblingProject, nextNumber, peekName, commitName, pad3 } from './ilfdata'
import { initAgentBridge } from './agent'
import { initTelemetry, setAway, track, trackOnce } from './telemetry'

const isMac = process.platform === 'darwin'
const devUrl = process.env['ELECTRON_RENDERER_URL']

protocol.registerSchemesAsPrivileged([
  { scheme: 'ilf', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
])

let mainWin: BrowserWindow | null = null
let controlWin: BrowserWindow | null = null

const projectsRoot = () => {
  const dir = join(app.getPath('videos'), 'iloveframes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function loadRoute(win: BrowserWindow, route: string) {
  if (devUrl) win.loadURL(devUrl + '#' + route)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route })
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#07070a',
    title: 'iloveframes',
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: isMac ? undefined : { color: '#07070a', symbolColor: '#a1a1aa', height: 44 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged
    }
  })
  mainWin.once('ready-to-show', () => mainWin?.show())
  mainWin.webContents.on('render-process-gone', (_e, d) => {
    console.error('[iloveframes] renderer gone', d.reason, d.exitCode)
    if (d.reason !== 'clean-exit') setTimeout(() => mainWin && loadRoute(mainWin, '/'), 500)
  })
  mainWin.on('closed', () => {
    mainWin = null
    controlWin?.close()
  })
  loadRoute(mainWin, '/')
}

// ---------------------------------------------------------------------------
// Media protocol with Range support (smooth seeking in <video>)
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav' }

/** True if `file` is inside `root` (after resolving `..`). Case-insensitive on Windows. */
function isInside(root: string, file: string) {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  const rel = relative(norm(root), norm(file))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Folders ilf://media may serve from: projects, imported wallpapers/sounds, bundled wallpapers. */
const mediaRoots = () => [projectsRoot(), app.getPath('userData'), bundledWallpaperDir()]

function registerMediaProtocol() {
  protocol.handle('ilf', async (req) => {
    const url = new URL(req.url)
    // ilf://media/<abs path encoded>, or ilf://wallpaper/<file> for the wallpapers that ship with the app
    const rest = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const file = url.hostname === 'wallpaper' ? join(bundledWallpaperDir(), basename(rest)) : rest
    // only media files from the app's own folders: never an arbitrary file on disk
    if (!MIME[extname(file).toLowerCase()] || !mediaRoots().some((r) => isInside(r, file))) return new Response('forbidden', { status: 403 })
    if (!existsSync(file)) return new Response('not found', { status: 404 })
    const size = statSync(file).size
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)!
      const start = m[1] ? parseInt(m[1]) : 0
      const end = m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as any
      return new Response(stream, {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) }
      })
    }
    const stream = Readable.toWeb(createReadStream(file)) as any
    return new Response(stream, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  })
}

// ---------------------------------------------------------------------------
// Recording session
// ---------------------------------------------------------------------------
interface Session {
  id: string
  dir: string
  display: Display
  tracker: InputTracker
  capture: LiveCapture | null
  engine: 'native' | 'browser'
  mode: 'auto' | 'manual'
  stopping: boolean
  stopWall: number
  captureStopped: Promise<void>
  name: string
  /** recorded area as fractions of the display, or null for the full screen */
  area: CropFrac | null
}
let rec: Session | null = null
let areaWin: BrowserWindow | null = null

/** Area in DIPs relative to the display -> fractions, clamped and at least 64 px. */
function toFrac(display: Display, a?: { x: number; y: number; w: number; h: number } | null): CropFrac | null {
  if (!a) return null
  const W = display.size.width
  const H = display.size.height
  const x = Math.max(0, Math.min(a.x, W - 64))
  const y = Math.max(0, Math.min(a.y, H - 64))
  const w = Math.max(64, Math.min(a.w, W - x))
  const h = Math.max(64, Math.min(a.h, H - y))
  if (w >= W - 2 && h >= H - 2) return null // the whole screen is just "full screen"
  return { x: x / W, y: y / H, w: w / W, h: h / H }
}

/** A thin outline around the recorded area. Excluded from the capture, ignores the mouse. */
function showAreaOutline(display: Display, f: CropFrac) {
  const b = display.bounds
  const pad = 3
  const r = { x: Math.round(b.x + f.x * b.width) - pad, y: Math.round(b.y + f.y * b.height) - pad, width: Math.round(f.w * b.width) + pad * 2, height: Math.round(f.h * b.height) + pad * 2 }
  areaWin = new BrowserWindow({
    ...r, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { sandbox: true }
  })
  areaWin.setIgnoreMouseEvents(true)
  areaWin.setAlwaysOnTop(true, 'screen-saver')
  areaWin.setContentProtection(true)
  areaWin.loadURL('data:text/html,' + encodeURIComponent(
    '<html><body style="margin:0;background:transparent;overflow:hidden"><div style="position:fixed;inset:0;border:2px dashed rgba(255,77,141,.9);border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></div></body></html>'
  ))
  areaWin.once('ready-to-show', () => {
    areaWin?.showInactive()
    areaWin?.setContentProtection(true)
  })
  areaWin.on('closed', () => (areaWin = null))
}

function displayFor(id: string | number): Display {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) ?? screen.getPrimaryDisplay()
}

async function showCountdown(display: Display, seconds: number) {
  if (seconds <= 0) return
  const b = display.bounds
  const w = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
    resizable: false, hasShadow: false, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, devTools: !app.isPackaged }
  })
  w.setContentProtection(true)
  w.setIgnoreMouseEvents(true)
  w.setAlwaysOnTop(true, 'screen-saver')
  loadRoute(w, `/countdown?n=${seconds}`)
  await new Promise<void>((r) => w.once('ready-to-show', () => r()))
  w.showInactive()
  w.setContentProtection(true) // must be applied after show on Windows to exclude from capture
  await new Promise((r) => setTimeout(r, seconds * 1000 + 150))
  w.destroy()
  await new Promise((r) => setTimeout(r, 120))
}

function openControlBar(display: Display, startWall: number) {
  // a slim vertical pill on the right edge, out of the way of what you're showing
  const W = 84
  const H = 324
  const b = display.workArea
  controlWin = new BrowserWindow({
    x: Math.round(b.x + b.width - W - 12),
    y: Math.round(b.y + b.height / 2 - H / 2),
    width: W, height: H, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, devTools: !app.isPackaged }
  })
  controlWin.setContentProtection(true)
  controlWin.setAlwaysOnTop(true, 'screen-saver')
  controlWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  loadRoute(controlWin, `/controlbar?start=${startWall}`)
  controlWin.once('ready-to-show', () => {
    controlWin?.showInactive()
    controlWin?.setContentProtection(true) // after show, or Windows still captures it
  })
  controlWin.on('closed', () => (controlWin = null))
  if (rec) rec.tracker.ignoreRects = [controlWin.getBounds()]
}

async function beginStop() {
  if (!rec || rec.stopping) return
  rec.stopping = true
  rec.stopWall = Date.now()
  rec.tracker.stop()
  globalShortcut.unregister('CommandOrControl+Shift+2')
  controlWin?.close()
  areaWin?.close()
  // stop the screen capture right away, before any iloveframes window comes back
  rec.captureStopped = rec.capture ? rec.capture.stop() : Promise.resolve()
  // tell the main renderer to flush camera/mic recorders, it then calls rec:finalize
  mainWin?.webContents.send('rec:stop')
}

ipcMain.handle('rec:prepare', async (_e, opts: { displayId: string; countdown: number; mode: 'auto' | 'manual'; fps: number; area?: { x: number; y: number; w: number; h: number } | null }) => {
  requireUnlocked()
  if (rec) throw new Error('Already recording')
  const display = displayFor(opts.displayId)
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomUUID().slice(0, 4)
  const dir = join(projectsRoot(), id)
  await fsp.mkdir(dir, { recursive: true })
  const name = projectName(id)

  track('recording_started', { fps: opts.fps, area: !!opts.area, mode: opts.mode, countdown: opts.countdown })
  mainWin?.hide()
  await showCountdown(display, opts.countdown)

  const tracker = new InputTracker(display)
  const area = toFrac(display, opts.area)
  rec = { id, dir, display, tracker, capture: null, engine: 'native', mode: opts.mode, stopping: false, stopWall: 0, name, captureStopped: Promise.resolve(), area }
  tracker.start()

  let sourceId: string | null = null
  try {
    rec.capture = await startNativeCapture(display, dir, opts.fps || 60, area ?? undefined)
  } catch (err) {
    console.warn('[iloveframes] native capture failed, falling back to browser capture', err)
    rec.engine = 'browser'
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    sourceId = src?.id ?? null
  }
  const startWall = rec.capture?.startWall() ?? Date.now()
  openControlBar(display, startWall)
  if (area) showAreaOutline(display, area)
  globalShortcut.register('CommandOrControl+Shift+2', () => beginStop())
  rec.capture?.exited.then(() => {
    if (rec && !rec.stopping) beginStop() // capture died unexpectedly
  })
  return { id, dir, engine: rec.engine, sourceId, startWall, display: { width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor } }
})

const writeChains = new Map<string, Promise<void>>()
const CHUNK_KINDS = new Set(['screen', 'camera', 'mic'])
ipcMain.on('rec:chunk', (_e, kind: string, data: ArrayBuffer) => {
  // `kind` becomes a file name: only the known streams, never a path
  if (!rec || !CHUNK_KINDS.has(kind)) return
  const file = join(rec.dir, kind + '.webm')
  const next = (writeChains.get(file) ?? Promise.resolve()).then(() => fsp.appendFile(file, Buffer.from(data))).catch(() => {})
  writeChains.set(file, next)
})

ipcMain.on('rec:request-stop', () => beginStop())

/**
 * Let the user drag out the area to record on a display. The picker is a
 * transparent window over that display; the main window steps aside meanwhile.
 * Resolves to the area in DIPs relative to the display, or null if cancelled.
 */
let picking: ((v: any) => void) | null = null
ipcMain.handle('area:pick', async (_e, displayId: string, current?: { x: number; y: number; w: number; h: number } | null) => {
  if (picking || rec) return null
  const display = displayFor(displayId)
  const b = display.bounds
  const wasVisible = !!mainWin?.isVisible()
  mainWin?.hide()
  await new Promise((r) => setTimeout(r, 180))
  const w = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, fullscreenable: false, show: false, enableLargerThanScreen: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, devTools: !app.isPackaged }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  const q = new URLSearchParams({ w: String(b.width), h: String(b.height), sf: String(display.scaleFactor) })
  if (current) q.set('cur', JSON.stringify(current))
  loadRoute(w, '/area?' + q.toString())
  const result = await new Promise<any>((resolve) => {
    picking = resolve
    w.once('ready-to-show', () => {
      w.show()
      w.focus()
    })
    w.on('closed', () => resolve(null))
  })
  picking = null
  if (!w.isDestroyed()) w.destroy()
  if (wasVisible) mainWin?.show()
  if (!result) return null
  const x = Math.round(result.x), y = Math.round(result.y)
  return { x, y, w: Math.round(Math.min(result.w, b.width - x)), h: Math.round(Math.min(result.h, b.height - y)), W: b.width, H: b.height }
})
ipcMain.on('area:done', (_e, area: { x: number; y: number; w: number; h: number } | null) => picking?.(area && [area.x, area.y, area.w, area.h].every(Number.isFinite) ? area : null))

ipcMain.on('rec:cancel', async () => {
  if (!rec) return
  track('recording_cancelled')
  const r = rec
  r.stopping = true
  r.tracker.stop()
  globalShortcut.unregister('CommandOrControl+Shift+2')
  controlWin?.close()
  areaWin?.close()
  r.capture?.kill()
  await r.capture?.exited
  rec = null
  mainWin?.webContents.send('rec:cancelled')
  mainWin?.show()
  setTimeout(() => fsp.rm(r.dir, { recursive: true, force: true }).catch(() => {}), 1500)
})

ipcMain.handle('rec:finalize', async (_e, meta: { cameraStart?: number; micStart?: number; screenStart?: number; hasCamera: boolean; hasMic: boolean }) => {
  if (!rec) throw new Error('No recording')
  const r = rec
  await Promise.all(writeChains.values())
  writeChains.clear()
  mainWin?.webContents.send('rec:processing', 'Finishing capture')
  await r.captureStopped
  mainWin?.show()
  const screenStart = r.engine === 'native' ? r.capture!.startWall() ?? r.stopWall : meta.screenStart ?? r.stopWall

  if (r.engine === 'browser') {
    mainWin?.webContents.send('rec:processing', 'Converting screen capture')
    await runFfmpeg(['-i', join(r.dir, 'screen.webm'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-vf', (r.area ? cropFilter(r.area) + ',' : '') + 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-g', '60', '-an', '-movflags', '+faststart', join(r.dir, 'screen.mp4')])
    await fsp.rm(join(r.dir, 'screen.webm'), { force: true })
  }
  if (meta.hasCamera && existsSync(join(r.dir, 'camera.webm'))) {
    mainWin?.webContents.send('rec:processing', 'Processing camera')
    await runFfmpeg(['-i', join(r.dir, 'camera.webm'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-g', '10', '-an', '-movflags', '+faststart', join(r.dir, 'camera.mp4')])
  }
  if (meta.hasMic && existsSync(join(r.dir, 'mic.webm'))) {
    mainWin?.webContents.send('rec:processing', 'Processing audio')
    await runFfmpeg(['-i', join(r.dir, 'mic.webm'), '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', join(r.dir, 'mic.wav')])
  }
  mainWin?.webContents.send('rec:processing', 'Generating preview')
  await runFfmpeg(['-ss', '0.5', '-i', join(r.dir, 'screen.mp4'), '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', join(r.dir, 'thumb.jpg')]).catch(() => {})

  const rel = (t: number) => +((t - screenStart) / 1000).toFixed(4)
  const ev = r.tracker.events
  const duration = +((r.stopWall - screenStart) / 1000).toFixed(3)
  const camera = meta.hasCamera && existsSync(join(r.dir, 'camera.mp4')) ? { file: 'camera.mp4', offset: rel(meta.cameraStart ?? screenStart) } : null
  const mic = meta.hasMic && existsSync(join(r.dir, 'mic.wav')) ? { file: 'mic.wav', offset: rel(meta.micStart ?? screenStart) } : null
  // with an area, positions are re-expressed inside that area (0..1 = its edges), so
  // smart zoom and the cinematic cursor work exactly as for a full-screen take
  const A = r.area ?? { x: 0, y: 0, w: 1, h: 1 }
  const ax = (x: number) => +((x - A.x) / A.w).toFixed(5)
  const ay = (y: number) => +((y - A.y) / A.h).toFixed(5)
  const inside = (x: number, y: number) => x >= A.x && x <= A.x + A.w && y >= A.y && y <= A.y + A.h
  const events = {
    cursor: ev.cursor.map(([t, x, y]) => [rel(t), ax(x), ay(y)]),
    cursorTypes: ev.cursorTypes.map(([t, k]) => [rel(t), k] as [number, string]),
    // clicks outside the area weren't recorded, so they shouldn't pull a zoom there
    clicks: ev.clicks.filter(([, x, y]) => inside(x, y)).map(([t, x, y, b]) => [rel(t), ax(x), ay(y), b]),
    keys: ev.keys.map(rel)
  }
  const display = {
    width: Math.round(r.display.size.width * A.w),
    height: Math.round(r.display.size.height * A.h),
    scaleFactor: r.display.scaleFactor
  }

  // one self-contained file: screen + webcam track + mic audio + all tracking data
  mainWin?.webContents.send('rec:processing', 'Saving recording')
  const screenFile = `ilfsrec_${pad3(await nextNumber('rec', [projectsRoot()], true))}.mp4`
  await packRecording(r.dir, screenFile, duration, camera, mic)
  await appendRecData(join(r.dir, screenFile), {
    v: 1, recId: r.id, name: r.name, createdAt: Date.now(), duration, display, cursorBaked: r.engine === 'browser', events,
    camera: camera ? { offset: camera.offset } : null, mic: !!mic
  }).catch((e) => console.warn('[iloveframes] could not embed recording data', e))

  const project = {
    id: r.id,
    recId: r.id,
    screenFile,
    area: r.area,
    name: r.name,
    createdAt: Date.now(),
    mode: r.mode,
    engine: r.engine,
    cursorBaked: r.engine === 'browser',
    display,
    duration,
    camera,
    mic,
    events,
    edit: null
  }
  await fsp.writeFile(join(r.dir, 'project.json'), JSON.stringify(project))
  for (const f of ['camera.webm', 'mic.webm']) await fsp.rm(join(r.dir, f), { force: true }).catch(() => {})
  rec = null
  track('recording_finished', { dur: duration, camera: !!camera, mic: !!mic, area: !!r.area, engine: r.engine, mode: r.mode })
  return { ...project, dir: r.dir }
})

/** Audio filter that lines a separately recorded track up with the screen (starts at 0). */
const alignAudio = (input: number, offset: number, duration: number) =>
  (offset >= 0 ? `[${input}:a]adelay=${Math.round(offset * 1000)}:all=1` : `[${input}:a]atrim=start=${(-offset).toFixed(4)},asetpts=PTS-STARTPTS`) +
  `,apad=whole_dur=${duration.toFixed(3)},atrim=end=${duration.toFixed(3)}[a]`

/**
 * Turn the raw capture into the final `ilfsrec_NNN.mp4`: the screen as the main
 * video track, the webcam as a second (non-default) video track and the mic,
 * already aligned, as the audio track. Streams are copied, only the mic is
 * encoded, so this takes a second or two. Falls back to a plain rename.
 */
async function packRecording(dir: string, screenFile: string, duration: number, camera: { file: string } | null, mic: { file: string; offset: number } | null) {
  const src = join(dir, 'screen.mp4')
  const out = join(dir, screenFile)
  const args = ['-i', src]
  const maps = ['-map', '0:v:0']
  let n = 1
  let camIdx = -1
  if (camera) {
    args.push('-i', join(dir, camera.file))
    maps.push('-map', `${n}:v:0`)
    camIdx = n++
  }
  if (mic) {
    args.push('-i', join(dir, mic.file))
    args.push('-filter_complex', alignAudio(n, mic.offset, duration))
    maps.push('-map', '[a]')
    n++
  }
  try {
    await runFfmpeg([
      ...args, ...maps, '-c:v', 'copy', ...(mic ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
      '-disposition:v:0', 'default', ...(camIdx > 0 ? ['-disposition:v:1', '0'] : []),
      '-movflags', '+faststart', out
    ])
    await fsp.rm(src, { force: true })
  } catch (err) {
    console.warn('[iloveframes] packing failed, keeping the plain capture', err)
    await fsp.rm(out, { force: true }).catch(() => {})
    await fsp.rename(src, out)
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
ipcMain.handle('projects:list', () => listProjects())
async function listProjects() {
  const root = projectsRoot()
  const out: any[] = []
  for (const id of await fsp.readdir(root).catch(() => [] as string[])) {
    const pj = join(root, id, 'project.json')
    if (!existsSync(pj)) continue
    try {
      const p = JSON.parse(await fsp.readFile(pj, 'utf8'))
      // give older generic names ("Recording 8 Oct, 7:41 pm") a unique, memorable one
      if (/^Recording \d/.test(p.name)) {
        p.name = projectName(p.id, new Date(p.createdAt))
        await fsp.writeFile(pj, JSON.stringify(p))
      }
      out.push({ id: p.id, name: p.name, createdAt: p.createdAt, duration: p.duration, mode: p.mode, dir: join(root, id), thumb: existsSync(join(root, id, 'thumb.jpg')) ? join(root, id, 'thumb.jpg') : null })
    } catch {}
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

ipcMain.handle('project:load', async (_e, id: string) => {
  const dir = join(projectsRoot(), basename(id))
  const p = JSON.parse(await fsp.readFile(join(dir, 'project.json'), 'utf8'))
  return { ...p, dir }
})

let saveChain: Promise<unknown> = Promise.resolve()
ipcMain.handle('project:save', (_e, id: string, patch: any) => {
  const run = async () => {
    const file = join(projectsRoot(), basename(id), 'project.json')
    const p = JSON.parse(await fsp.readFile(file, 'utf8'))
    Object.assign(p, patch)
    await fsp.writeFile(file + '.tmp', JSON.stringify(p))
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(file + '.tmp', file)
        break
      } catch (err) {
        if (i > 8) throw err
        await new Promise((r) => setTimeout(r, 40))
      }
    }
    return true
  }
  const next = saveChain.then(run, run)
  saveChain = next.catch(() => {})
  return next
})

ipcMain.handle('project:delete', async (_e, id: string) => {
  await fsp.rm(join(projectsRoot(), basename(id)), { recursive: true, force: true })
  return true
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
ipcMain.handle('export:choose', async (_e, _hint: string, ext: 'mp4' | 'gif') => {
  requireUnlocked()
  const dir = process.env.ILF_EXPORT_DIR || app.getPath('downloads')
  const defaultName = await peekName('vid', [dir])
  if (process.env.ILF_EXPORT_DIR) {
    await commitName('vid', defaultName)
    return join(dir, defaultName + '.' + ext) // test harness
  }
  const r = await dialog.showSaveDialog(mainWin!, {
    title: 'Export video',
    defaultPath: join(dir, defaultName + '.' + ext),
    filters: [ext === 'gif' ? { name: 'GIF', extensions: ['gif'] } : { name: 'MP4 Video', extensions: ['mp4'] }]
  })
  if (r.canceled || !r.filePath) return null
  await commitName('vid', basename(r.filePath, extname(r.filePath)))
  return r.filePath
})

/** Where an agent's export goes: Downloads, next ilfvid_NNN. Same license rule as the export dialog. */
ipcMain.handle('agent:export-target', async (_e, ext: 'mp4' | 'gif') => {
  requireUnlocked()
  const dir = process.env.ILF_EXPORT_DIR || app.getPath('downloads')
  const name = await peekName('vid', [dir])
  await commitName('vid', name)
  return join(dir, name + '.' + (ext === 'gif' ? 'gif' : 'mp4'))
})

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
const thumbCache = new Map<string, string>()

// instant: display info + last known thumbnails
ipcMain.handle('displays:list', () => {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    name: d.id === primary.id ? 'Main display' : `Display ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    primary: d.id === primary.id,
    thumbnail: thumbCache.get(String(d.id)) ?? null
  }))
})

// slow (screen grab): fresh thumbnails keyed by display id
ipcMain.handle('displays:thumbs', async () => {
  const displays = screen.getAllDisplays()
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 400 } })
    displays.forEach((d, i) => {
      const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[i]
      if (src && !src.thumbnail.isEmpty()) thumbCache.set(String(d.id), src.thumbnail.toDataURL())
    })
  } catch {}
  return Object.fromEntries(thumbCache)
})

ipcMain.handle('perm:status', async () => {
  if (!isMac) return { screen: 'granted', camera: 'granted', microphone: 'granted', accessibility: true }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
  }
})

ipcMain.handle('perm:request', async (_e, kind: 'camera' | 'microphone' | 'accessibility' | 'screen') => {
  if (!isMac) return true
  if (kind === 'accessibility') return systemPreferences.isTrustedAccessibilityClient(true)
  if (kind === 'screen') {
    // triggers the OS prompt the first time, then deep-link to settings
    await desktopCapturer.getSources({ types: ['screen'] }).catch(() => {})
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted')
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    return systemPreferences.getMediaAccessStatus('screen') === 'granted'
  }
  return systemPreferences.askForMediaAccess(kind)
})

ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
// opens a folder, or an exported video/image in its default app; never anything executable
const OPENABLE_EXT = ['.mp4', '.gif', '.png', '.jpg', '.jpeg', '.webm', '.mov']
ipcMain.handle('shell:open', async (_e, p: string) => {
  if (typeof p !== 'string' || !isAbsolute(p)) return 'Not allowed'
  const st = await fsp.stat(p).catch(() => null)
  const ext = extname(p).toLowerCase()
  // (a macOS .app is a folder too, and opening it launches it)
  if (!st || !((st.isDirectory() && ext !== '.app') || (st.isFile() && OPENABLE_EXT.includes(ext)))) return 'Not allowed'
  return shell.openPath(p)
})
ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), projectsDir: projectsRoot() }))
ipcMain.handle('file:pick-image', async () => {
  const r = await dialog.showOpenDialog(mainWin!, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
  if (r.canceled || !r.filePaths[0]) return null
  const img = nativeImage.createFromPath(r.filePaths[0])
  const s = img.getSize()
  const scaled = s.width > 3840 ? img.resize({ width: 3840 }) : img
  return scaled.toDataURL()
})

ipcMain.handle('wallpapers:list', () => listWallpapers())
ipcMain.handle('wallpapers:remove', (_e, id: string) => removeWallpaper(id))
ipcMain.handle('wallpapers:import', async (_e, group?: string, paths?: string[], names?: Record<string, string>) => {
  if (!paths) {
    const r = await dialog.showOpenDialog(mainWin!, { title: 'Add wallpapers', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (r.canceled) return []
    paths = r.filePaths
  }
  return importWallpapers(paths, group ?? 'Library', names)
})

// ---------------------------------------------------------------------------
// Video import (as clips, or as a brand new project)
// ---------------------------------------------------------------------------
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']

async function probeMedia(file: string) {
  const out = await captureOutput(['-i', file])
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
  const v = /Stream[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(out)
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
    width: v ? +v[1] : 0,
    height: v ? +v[2] : 0,
    hasAudio: /Stream[^\n]*Audio:/.test(out)
  }
}

/** Normalise any video to H.264/AAC MP4 so it scrubs smoothly and exports frame-accurately. */
async function transcodeVideo(input: string, output: string, label: string) {
  const info = await probeMedia(input)
  if (!info.duration || !info.width) throw new Error(`Couldn't read video: ${basename(input)}`)
  await runFfmpeg(
    ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-g', '30', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', output],
    (sec) => mainWin?.webContents.send('media:progress', { label, p: Math.min(1, sec / info.duration) })
  )
  const res = await probeMedia(output)
  return { ...res, duration: res.duration || info.duration }
}

async function pickVideos(multi: boolean) {
  const r = await dialog.showOpenDialog(mainWin!, { title: 'Import video', properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'Video', extensions: VIDEO_EXT }] })
  return r.canceled ? [] : r.filePaths
}

/**
 * An iloveframes recording brings its tracking data along: embedded in the
 * file, or (older takes) from the project folder it lives in. Streams are
 * copied, not re-encoded, so this is quick and lossless.
 */
async function importRecording(p: string, dir: string, id: string, label: string) {
  const progress = (x: number) => mainWin?.webContents.send('media:progress', { label, p: x })
  const data = await readRecData(p)
  const sib = data ? null : await readSiblingProject(p)
  if (!data && !sib) return null
  progress(0.1)
  const file = `src-${id}.mp4`
  let camera: { file: string; offset: number } | null = null
  if (data) {
    await runFfmpeg(['-i', p, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', join(dir, file)])
    if (data.camera) {
      progress(0.6)
      const cam = `cam-${id}.mp4`
      const off = Number(data.camera.offset) || 0
      await runFfmpeg(['-i', p, '-map', '0:v:1', '-c', 'copy', '-movflags', '+faststart', join(dir, cam)])
        .then(() => (camera = { file: cam, offset: off }))
        .catch(() => {})
    }
  } else {
    // project.json next to an imported file is untrusted: plain file names and numbers only
    const local = (f: unknown) => (typeof f === 'string' && f ? join(sib.dir, basename(f)) : '')
    const micFile = local(sib.mic?.file)
    const mic = micFile && existsSync(micFile) ? { offset: Number(sib.mic.offset) || 0 } : null
    await runFfmpeg([
      '-i', p,
      ...(mic ? ['-i', micFile, '-filter_complex', alignAudio(1, mic.offset, Number(sib.duration) || 0), '-map', '0:v:0', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : ['-map', '0:v:0']),
      '-c:v', 'copy', '-movflags', '+faststart', join(dir, file)
    ])
    const camFile = local(sib.camera?.file)
    if (camFile && existsSync(camFile)) {
      progress(0.6)
      await fsp.copyFile(camFile, join(dir, `cam-${id}.mp4`))
      camera = { file: `cam-${id}.mp4`, offset: Number(sib.camera.offset) || 0 }
    }
  }
  progress(0.95)
  const info = await probeMedia(join(dir, file))
  const src: any = data ?? sib
  return {
    file,
    ...info,
    duration: info.duration || src.duration,
    recId: (data?.recId ?? sib.recId ?? sib.id) as string,
    track: { events: src.events, display: src.display, cursorBaked: !!src.cursorBaked },
    camera: camera as { file: string; offset: number } | null
  }
}

/** Run a read-modify-write of project.json on the shared save chain. */
function patchProjectFile(projectId: string, fn: (p: any) => void) {
  const run = async () => {
    const file = join(projectsRoot(), basename(projectId), 'project.json')
    const p = JSON.parse(await fsp.readFile(file, 'utf8'))
    fn(p)
    await fsp.writeFile(file + '.tmp', JSON.stringify(p))
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(file + '.tmp', file)
        break
      } catch (err) {
        if (i > 8) throw err
        await new Promise((r) => setTimeout(r, 40))
      }
    }
  }
  const next = saveChain.then(run, run)
  saveChain = next.catch(() => {})
  return next
}

ipcMain.handle('media:import', async (_e, projectId: string, paths?: string[]) => {
  requireUnlocked()
  paths = (paths ?? (await pickVideos(true))).filter((p) => VIDEO_EXT.includes(extname(p).slice(1).toLowerCase()))
  if (!paths.length) return []
  const dir = join(projectsRoot(), basename(projectId))
  const added: any[] = []
  try {
    for (const p of paths) {
      const id = randomUUID().slice(0, 8)
      const base = basename(p, extname(p))
      const rec = await importRecording(p, dir, id, base)
      if (rec) {
        // older takes are all called "screen.mp4": name them after their project
        const name = /^screen$/i.test(base) ? ((await readSiblingProject(p))?.name?.split(' · ')[0] ?? base) : base
        added.push({ id, name, ...rec })
        continue
      }
      const info = await transcodeVideo(p, join(dir, `src-${id}.mp4`), base)
      added.push({ id, name: base, file: `src-${id}.mp4`, ...info })
    }
    await patchProjectFile(projectId, (pj) => (pj.sources = [...(pj.sources ?? []), ...added]))
  } finally {
    mainWin?.webContents.send('media:progress', null)
  }
  return added
})

/** Previous recordings, for "add from your recordings" in the editor. */
ipcMain.handle('recordings:list', async (_e, exceptId?: string) => {
  const root = projectsRoot()
  const out: any[] = []
  for (const id of await fsp.readdir(root).catch(() => [] as string[])) {
    if (id === exceptId) continue
    const pj = join(root, id, 'project.json')
    if (!existsSync(pj)) continue
    try {
      const p = JSON.parse(await fsp.readFile(pj, 'utf8'))
      const file = join(root, id, p.screenFile ?? 'screen.mp4')
      if (!existsSync(file)) continue
      const tracked = !!(p.events?.cursor?.length || p.events?.clicks?.length)
      out.push({ id: p.id, name: p.name, file, fileName: basename(file), duration: p.duration, createdAt: p.createdAt, tracked, thumb: existsSync(join(root, id, 'thumb.jpg')) ? join(root, id, 'thumb.jpg') : null })
    } catch {}
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
})

ipcMain.handle('project:import-video', async (_e, paths?: string[]) => {
  requireUnlocked()
  const p = (paths ?? (await pickVideos(false)))[0]
  if (!p) return null
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomUUID().slice(0, 4)
  const dir = join(projectsRoot(), id)
  await fsp.mkdir(dir, { recursive: true })
  try {
    const name = basename(p, extname(p))
    // an iloveframes recording opens as a full project, tracking data included
    const rec = await importRecording(p, dir, 'main', name)
    let project: any
    if (rec) {
      await fsp.rename(join(dir, rec.file), join(dir, 'screen.mp4'))
      if (rec.camera) await fsp.rename(join(dir, rec.camera.file), join(dir, 'camera.mp4'))
      project = {
        id, recId: rec.recId, name: projectName(id), createdAt: Date.now(), mode: 'auto', engine: 'native', cursorBaked: rec.track.cursorBaked,
        screenAudio: rec.hasAudio, display: rec.track.display, duration: rec.duration,
        camera: rec.camera ? { file: 'camera.mp4', offset: rec.camera.offset } : null, mic: null, events: rec.track.events, edit: null, sources: []
      }
    } else {
      const info = await transcodeVideo(p, join(dir, 'screen.mp4'), name)
      project = {
        id, name, createdAt: Date.now(), mode: 'manual', engine: 'import', cursorBaked: true, screenAudio: info.hasAudio,
        display: { width: info.width, height: info.height, scaleFactor: 1 },
        duration: info.duration, camera: null, mic: null, events: { cursor: [], cursorTypes: [], clicks: [], keys: [] }, edit: null, sources: []
      }
    }
    await runFfmpeg(['-ss', String(Math.min(0.5, project.duration / 2)), '-i', join(dir, 'screen.mp4'), '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', join(dir, 'thumb.jpg')]).catch(() => {})
    await fsp.writeFile(join(dir, 'project.json'), JSON.stringify(project))
    return id
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true })
    throw err
  } finally {
    mainWin?.webContents.send('media:progress', null)
  }
})

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm']
async function probeDuration(file: string) {
  const out = await captureOutput(['-i', file])
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0
}
ipcMain.handle('sounds:list', () => listSounds())
ipcMain.handle('sounds:remove', (_e, id: string) => removeSound(id))
ipcMain.handle('sounds:import', async (_e, paths?: string[]) => {
  if (!paths) {
    const r = await dialog.showOpenDialog(mainWin!, { title: 'Add sounds', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }] })
    if (r.canceled) return []
    paths = r.filePaths
  }
  return importSounds(paths.filter((p) => AUDIO_EXT.includes(extname(p).slice(1).toLowerCase())), probeDuration)
})

// ---------------------------------------------------------------------------
// Licensing
// ---------------------------------------------------------------------------
ipcMain.handle('license:status', () => {
  const st = licenseStatus()
  if (st.state === 'expired') trackOnce('trial_expired', 'trial_expired')
  return st
})
ipcMain.handle('license:activate', async (_e, key: string, name: string) => {
  const r = await licenseActivate(String(key ?? ''), String(name ?? ''))
  track(r.ok ? 'license_activated' : 'license_activate_failed', r.ok ? undefined : { msg: (r as any).error })
  return r
})
ipcMain.handle('license:deactivate', async () => {
  const r = await licenseDeactivate()
  if (r.ok) track('license_deactivated')
  return r
})
ipcMain.handle('license:set-name', (_e, name: string) => licenseSetName(String(name ?? '')))
ipcMain.on('license:allowed', (e) => (e.returnValue = isUnlocked()))
ipcMain.handle('license:buy', () => {
  track('buy_click')
  return shell.openExternal(CONFIG.buyUrl)
})

// In-app feedback: posted from main so it isn't subject to page CORS rules.
ipcMain.handle('feedback:send', async (_e, f: { kind?: string; message?: string; email?: string; name?: string }) => {
  const message = String(f?.message ?? '').trim().slice(0, 4000)
  if (message.length < 3) return { ok: false, error: 'Please write a little more.' }
  track('feedback_sent', { kind: String(f?.kind ?? 'idea').slice(0, 20) })
  const body = {
    kind: String(f?.kind ?? 'idea').slice(0, 20),
    message,
    email: String(f?.email ?? '').trim().slice(0, 200),
    name: String(f?.name ?? '').trim().slice(0, 80),
    version: app.getVersion(),
    os: `${process.platform} ${process.getSystemVersion?.() ?? ''} ${process.arch}`.trim(),
    plan: licenseStatus().state
  }
  // two tries, a moment apart; failures are reported (status only) so we can see what goes wrong
  let status = 0
  let why = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await net.fetch(CONFIG.feedbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ilf-app': app.getVersion() }, body: JSON.stringify(body) })
      if (res.ok) return { ok: true }
      status = res.status
      why = 'http'
      if (status === 429) break
    } catch (e: any) {
      why = String(e?.message || e).slice(0, 80)
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
  track('feedback_failed', { status, why })
  return { ok: false, error: status === 429 ? 'That’s a lot of messages at once. Try again in a minute, or email it instead.' : status ? `Couldn’t send it (error ${status}). You can email it instead.` : 'Couldn’t reach our server. You can email it instead.' }
})

// open the user's mail app (only mailto: links)
ipcMain.handle('shell:mail', (_e, url: string) => {
  if (typeof url === 'string' && url.startsWith('mailto:')) return shell.openExternal(url)
})

ipcMain.handle('update:state', () => updateState())
ipcMain.handle('update:check', () => checkForUpdates(true))
ipcMain.handle('update:install', () => installNow())
ipcMain.handle('app:version', () => app.getVersion())

// ---------------------------------------------------------------------------
// Screenshot studio
// ---------------------------------------------------------------------------
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']
function imageFile(p: string) {
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) throw new Error('Couldn’t open that image.')
  return { dataUrl: img.toDataURL(), name: basename(p, extname(p)) }
}
ipcMain.handle('shot:open', async () => {
  const r = await dialog.showOpenDialog(mainWin!, { title: 'Open screenshot', properties: ['openFile'], filters: [{ name: 'Images', extensions: IMAGE_EXT }] })
  return r.canceled || !r.filePaths[0] ? null : imageFile(r.filePaths[0])
})
ipcMain.handle('shot:load', (_e, p: string) => (IMAGE_EXT.includes(extname(p).slice(1).toLowerCase()) ? imageFile(p) : null))
ipcMain.handle('shot:paste', () => {
  const img = clipboard.readImage()
  return img.isEmpty() ? null : { dataUrl: img.toDataURL(), name: 'Pasted screenshot' }
})
ipcMain.handle('shot:save', async (_e, data: ArrayBuffer, _hint: string, ext: 'png' | 'jpg') => {
  requireUnlocked()
  const dir = process.env.ILF_EXPORT_DIR || app.getPath('downloads')
  const name = await peekName('shot', [dir])
  if (process.env.ILF_EXPORT_DIR) {
    // test harness: skip the dialog
    const f = join(dir, `${name}.${ext}`)
    await fsp.writeFile(f, Buffer.from(data))
    await commitName('shot', name)
    return f
  }
  const r = await dialog.showSaveDialog(mainWin!, {
    title: 'Export image',
    defaultPath: join(dir, `${name}.${ext}`),
    filters: [ext === 'png' ? { name: 'PNG image', extensions: ['png'] } : { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }]
  })
  if (r.canceled || !r.filePath) return null
  await fsp.writeFile(r.filePath, Buffer.from(data))
  await commitName('shot', basename(r.filePath, extname(r.filePath)))
  return r.filePath
})
ipcMain.handle('shot:copy', (_e, png: ArrayBuffer) => {
  requireUnlocked()
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)))
  return true
})

const LOCKED = 'Your free trial has ended. Activate a license to keep using iloveframes.'
function requireUnlocked() {
  if (!isUnlocked()) throw new Error(LOCKED)
}

app.whenReady().then(async () => {
  initAgentBridge({ window: () => mainWin, listProjects })
  await initLicense()
  initTelemetry({ license: () => { const st = licenseStatus().state; return st === 'licensed' ? 'pro' : st } })
  startAutoUpdates()
  registerMediaProtocol()
  // camera, mic, screen etc. only for the app's own pages, never for a web page
  session.defaultSession.setPermissionRequestHandler((wc, _perm, cb) => cb(isAppUrl(wc.getURL())))
  session.defaultSession.setPermissionCheckHandler((wc) => !!wc && isAppUrl(wc.getURL()))
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

/** The app's own renderer: the bundled index.html (file://), or the dev server while developing. */
function isAppUrl(u: string) {
  try {
    const url = new URL(u)
    if (devUrl) return url.origin === new URL(devUrl).origin
    return url.protocol === 'file:' && isInside(join(__dirname, '..'), fileURLToPath(url))
  } catch {
    return false
  }
}

// Every window (incl. ones a page opens) gets the preload with the full `window.ilf` API, so
// no window may ever show a remote page: links open in the browser, navigation stays in the app.
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (rec) rec.capture?.kill()
  if (!isMac) app.quit()
  else setAway(true)
})
