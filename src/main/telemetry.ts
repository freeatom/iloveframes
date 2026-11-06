/**
 * Anonymous usage stats (Pulse). Helps see what's working: installs, active use,
 * which features get used, export success, errors.
 *
 *  - anonymous: a random install id made on first launch; no names, emails, file names,
 *    recordings, paths or license keys are ever sent
 *  - light: events are queued on disk and sent as one small batch ~30s after launch, a tiny
 *    "still here" ping every 15 minutes while the app is open, and a goodbye when it quits
 *  - installs that turned it off in 1.0.5 / 1.0.6 (optOut) stay off
 */
import { app, ipcMain, net } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CONFIG } from './config'

type Ev = { n: string; t: number; p?: Record<string, unknown>; eid?: string }
interface State {
  id: string
  optOut: boolean
  lastActiveDay: string
  lastVersion: string
  flags: Record<string, true>
  queue: Ev[]
}

const MAX_QUEUE = 400
const BATCH = 200
const file = () => join(app.getPath('userData'), 'telemetry.json')
let s: State
let licenseState: () => string = () => 'unknown'
let saveTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false
const startedAt = Date.now()

function load(): State {
  try {
    if (existsSync(file())) {
      const j = JSON.parse(readFileSync(file(), 'utf8'))
      if (j && typeof j.id === 'string') return { lastActiveDay: '', lastVersion: '', flags: {}, queue: [], optOut: false, ...j }
    }
  } catch {}
  return { id: randomUUID(), optOut: false, lastActiveDay: '', lastVersion: '', flags: {}, queue: [] }
}
function saveSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 2000)
}
function saveNow() {
  try {
    writeFileSync(file(), JSON.stringify(s))
  } catch {}
}

const NAME = /^[a-z0-9_.:-]{1,48}$/
/** Keep props small and free of anything that could identify a person or a file. */
function clean(p?: Record<string, unknown>) {
  if (!p) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(p).slice(0, 12)) {
    if (!/^[a-zA-Z0-9_]{1,24}$/.test(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (typeof v === 'string') out[k] = v.replace(/[A-Za-z]:\\[^\s]*|\/(Users|home)\/[^\s]*/g, '<path>').slice(0, 120)
  }
  return out
}

// only real (packaged) installs report; dev builds and test runs stay out of the stats unless asked
const ENABLED = () => (app.isPackaged || process.env.ILF_TELEMETRY === '1') && !process.env.ILF_SMOKE

export function track(name: string, props?: Record<string, unknown>) {
  if (!s || s.optOut || !ENABLED() || !NAME.test(name)) return
  // a stable id per event lets the server drop duplicates when a batch is retried
  s.queue.push({ n: name, t: Date.now(), p: clean(props), eid: randomUUID() })
  if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE)
  saveSoon()
}

/** Record a one-off milestone only the first time it happens on this install. */
export function trackOnce(flag: string, name: string, props?: Record<string, unknown>) {
  if (!s || s.flags[flag]) return
  s.flags[flag] = true
  track(name, props)
}

function markActiveDay() {
  const day = new Date().toISOString().slice(0, 10)
  if (s.lastActiveDay === day) return
  s.lastActiveDay = day
  track('app_active')
}

export async function flush(o: { timeoutMs?: number; heartbeat?: boolean; bye?: boolean } = {}) {
  const timeoutMs = o.timeoutMs ?? 15000
  if (!s || s.optOut || !ENABLED() || flushing || (!s.queue.length && !o.heartbeat && !o.bye)) return
  flushing = true
  const batch = s.queue.slice(0, BATCH)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await net.fetch(CONFIG.telemetryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        a: CONFIG.telemetryApp,
        i: s.id,
        v: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        lic: licenseState(),
        loc: app.getLocale(),
        ev: batch,
        ...(o.bye ? { bye: 1 } : {})
      }),
      signal: ctrl.signal
    })
    clearTimeout(timer)
    // drop what was delivered (or rejected as invalid, so a bad event can't block the queue forever)
    if (res.ok || (res.status >= 400 && res.status < 500)) s.queue.splice(0, batch.length)
  } catch {
    // offline: keep the queue for next time
  } finally {
    flushing = false
    saveNow()
  }
}

/** macOS keeps the app running with no windows: count that as closed until a window opens again. */
let away = false
export function setAway(v: boolean) {
  if (away === v) return
  away = v
  flush(v ? { bye: true } : { heartbeat: true })
}

export function setOptOut(off: boolean) {
  s.optOut = off
  if (off) s.queue = []
  saveNow()
  return { optOut: s.optOut }
}

export function initTelemetry(o: { license: () => string }) {
  s = load()
  licenseState = o.license
  const fresh = !existsSync(file())
  if (fresh) track('first_run', { os: process.platform })
  const version = app.getVersion()
  if (s.lastVersion && s.lastVersion !== version) track('update_installed', { from: s.lastVersion, to: version })
  s.lastVersion = version
  track('app_open')
  markActiveDay()
  saveNow()

  ipcMain.on('telemetry:track', (_e, name: unknown, props: unknown) => {
    if (typeof name === 'string') track(name, props && typeof props === 'object' ? (props as Record<string, unknown>) : undefined)
  })
  ipcMain.handle('telemetry:get', () => ({ optOut: s.optOut }))
  ipcMain.handle('telemetry:set', (_e, optOut: boolean) => setOptOut(!!optOut))

  // first report ~30s after launch; while the app stays open, a tiny "still here" ping every
  // 15 minutes (it carries any queued events), so live counts know who's actually using it
  setTimeout(() => flush(), process.env.ILF_TELEMETRY === '1' ? 4000 : 30_000)
  setInterval(() => {
    if (away) return
    markActiveDay()
    flush({ heartbeat: true })
  }, 15 * 60_000)
  app.on('browser-window-created', () => setAway(false))

  process.on('uncaughtException', (err) => track('error', { msg: String(err?.message || err).slice(0, 120), where: 'main' }))
  process.on('unhandledRejection', (err: any) => track('error', { msg: String(err?.message || err).slice(0, 120), where: 'main-promise' }))
  app.on('render-process-gone', (_e, _wc, d) => track('crash', { msg: d.reason, code: d.exitCode }))
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit' && d.reason !== 'killed') track('crash', { msg: `${d.type}: ${d.reason}`, code: d.exitCode })
  })

  // on quit: note the session length and send what's left (briefly; quitting never waits long)
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || s.optOut || !ENABLED()) return
    quitting = true
    track('app_session', { ms: Date.now() - startedAt })
    e.preventDefault()
    flush({ timeoutMs: 2500, bye: true }).finally(() => app.quit())
  })
}
