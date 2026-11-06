import { app, screen, Display, Rectangle } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { LiveCapture, startLiveCapture, type CropFrac } from './ffmpeg'
import { platform } from './platform'

export interface RecordedEvents {
  cursor: [number, number, number][] // [tMs(wall), x, y] normalized to display
  cursorTypes: [number, string][] // [tMs(wall), 'arrow'|'hand'|'text'] on change
  clicks: [number, number, number, number][] // [tMs(wall), x, y, button]
  keys: number[] // tMs(wall)
}

/** Polls the global cursor + listens to global mouse/keyboard hooks while recording. */
export class InputTracker {
  events: RecordedEvents = { cursor: [], cursorTypes: [], clicks: [], keys: [] }
  private typeProc: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private hook: any = null
  private lastX = -1
  private lastY = -1
  ignoreRects: Rectangle[] = []
  /** what the macOS helper said it can detect ('counter' | 'buttons' | 'none'), for diagnostics */
  caps: { clicks: string; keys: string } | null = null
  /** where input events come from on this platform */
  source: 'hook' | 'helper' | 'none' = 'none'

  constructor(private display: Display) {}

  private norm(p: Electron.Point) {
    const b = this.display.bounds
    return [(p.x - b.x) / b.width, (p.y - b.y) / b.height] as const
  }

  /** Watches the OS cursor shape (arrow / hand / text) via a tiny helper script. */
  private startTypeWatcher() {
    const res = app.isPackaged ? join(process.resourcesPath, 'native') : join(app.getAppPath(), 'resources', 'native')
    try {
      const w = platform.cursorWatcher(res)
      this.typeProc = w ? spawn(w.cmd, w.args, { windowsHide: true }) : null
    } catch {
      this.typeProc = null
    }
    if (!this.typeProc) return
    let buf = ''
    this.typeProc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line === 'arrow' || line === 'hand' || line === 'text') this.events.cursorTypes.push([Date.now(), line])
        else if (line.startsWith('down ')) {
          // macOS helper: "down <button> <agoMs>"
          const [, b, ago] = line.split(' ')
          this.addClick(Date.now() - Math.max(0, Math.min(500, +ago || 0)), +b || 1)
        } else if (line.startsWith('key ')) {
          const ago = +line.split(' ')[1] || 0
          this.events.keys.push(Date.now() - Math.max(0, Math.min(500, ago)))
        } else if (line.startsWith('caps ')) {
          const [, clicks, keys] = line.split(' ')
          this.caps = { clicks, keys }
        }
      }
    })
    this.typeProc.on('error', () => {})
  }

  private addClick(t: number, button: number) {
    const p = screen.getCursorScreenPoint()
    if (this.ignoreRects.some((r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height)) return
    const [x, y] = this.norm(p)
    if (x < 0 || y < 0 || x > 1 || y > 1) return
    this.events.clicks.push([t, x, y, button])
  }

  start() {
    this.startTypeWatcher()
    const sample = () => {
      const p = screen.getCursorScreenPoint()
      if (p.x !== this.lastX || p.y !== this.lastY || this.events.cursor.length === 0) {
        this.lastX = p.x
        this.lastY = p.y
        const [x, y] = this.norm(p)
        this.events.cursor.push([Date.now(), x, y])
      }
    }
    sample()
    this.timer = setInterval(sample, 1000 / 120)

    // macOS: clicks and keys come from the helper process above (no in-process hook:
    // libuiohook's keyboard path can abort the whole app on recent macOS versions)
    if (process.platform === 'darwin') {
      this.source = this.typeProc ? 'helper' : 'none'
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { uIOhook } = require('uiohook-napi')
      this.hook = uIOhook
      uIOhook.removeAllListeners()
      uIOhook.on('mousedown', (e: any) => this.addClick(Date.now(), e.button ?? 1))
      uIOhook.on('keydown', () => this.events.keys.push(Date.now()))
      uIOhook.start()
      this.source = 'hook'
    } catch (err) {
      console.warn('[iloveframes] global input hook unavailable', err)
      this.hook = null
    }
  }

  stop() {
    try {
      this.typeProc?.kill()
    } catch {}
    this.typeProc = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.hook) {
      try {
        this.hook.removeAllListeners()
        this.hook.stop()
      } catch {}
      this.hook = null
    }
  }
}

/** Order displays the way the OS capture APIs enumerate them: primary first. */
export function orderedDisplays(): Display[] {
  const all = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  return [primary, ...all.filter((d) => d.id !== primary.id)]
}

export async function startNativeCapture(display: Display, outDir: string, fps: number, crop?: CropFrac): Promise<LiveCapture> {
  const out = join(outDir, 'screen.mp4')
  const idx = Math.max(0, orderedDisplays().findIndex((d) => d.id === display.id))
  const attempts = await platform.captureAttempts(display, idx, out, fps, crop)
  let lastErr = ''
  for (const args of attempts) {
    const cap = startLiveCapture(args)
    // wait until frames flow or the process dies
    const ok = await new Promise<boolean>((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (cap.startWall() !== null) {
          clearInterval(iv)
          resolve(true)
        } else if (Date.now() - t0 > 6000) {
          clearInterval(iv)
          resolve(false)
        }
      }, 30)
      cap.exited.then(() => {
        clearInterval(iv)
        resolve(cap.startWall() !== null)
      })
    })
    if (ok) return cap
    lastErr = cap.log()
    cap.kill()
    await cap.exited
  }
  throw new Error('Native capture failed: ' + lastErr.slice(-600))
}
