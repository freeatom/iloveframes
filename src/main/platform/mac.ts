import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { join, dirname } from 'path'
import { homedir, tmpdir } from 'os'
import { promises as fsp } from 'fs'
import type { Platform } from './types'
import { avfoundationScreens, cropFilter, hasEncoder } from '../ffmpeg'

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => execFile(cmd, args, (_e, out) => resolve(String(out ?? ''))))

const MIRROR = join(homedir(), 'Library', 'Application Support', '.com.iloveframes.state')

export const mac: Platform = {
  id: 'mac',
  stopShortcutLabel: '⌘ + Shift + 2',

  async captureAttempts(_display, idx, out, fps, crop) {
    // an optional area crop runs first, then the frame is kept to even dimensions
    const even = (crop ? cropFilter(crop) + ',' : '') + 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    // fragmented MP4: if the app or the machine dies mid-take, everything up to the last second still plays
    const common = ['-g', String(fps), '-stats_period', '0.05', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-t', '14400']
    const screens = await avfoundationScreens()
    const dev = screens[idx] ?? screens[0]
    if (dev === undefined) throw new Error('No capturable screen found (allow Screen Recording in System Settings)')
    const input = ['-f', 'avfoundation', '-capture_cursor', '0', '-capture_mouse_clicks', '0', '-framerate', String(fps), '-pixel_format', 'nv12', '-i', `${dev}:none`]
    const attempts: string[][] = []
    if (await hasEncoder('h264_videotoolbox')) attempts.push([...input, '-vf', even, '-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '40M', '-maxrate', '60M', '-pix_fmt', 'yuv420p', ...common, out])
    attempts.push([...input, '-vf', even, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '16', '-pix_fmt', 'yuv420p', ...common, out])
    return attempts
  },

  cursorWatcher(nativeDir) {
    return { cmd: 'osascript', args: ['-l', 'JavaScript', join(nativeDir, 'cursor-mac.js')] }
  },

  async machineId() {
    const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const m = /"IOPlatformUUID"\s*=\s*"([\w-]+)"/.exec(out)
    return m ? m[1] : ''
  },

  async mirrorRead() {
    try {
      return (await fsp.readFile(MIRROR, 'utf8')).trim() || null
    } catch {
      return null
    }
  },

  async mirrorWrite(data) {
    await fsp.mkdir(dirname(MIRROR), { recursive: true })
    await fsp.writeFile(MIRROR, data)
  },

  updateAsset: () => (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'),

  async installUpdate(file, relaunch = true) {
    // file is a .zip of iloveframes.app. Swap the bundle after we quit, then relaunch.
    const appBundle = join(process.execPath, '..', '..', '..')
    const stage = await fsp.mkdtemp(join(tmpdir(), 'ilf-update-'))
    await run('ditto', ['-x', '-k', file, stage])
    const script = [
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
      `NEW=$(ls -d "${stage}"/*.app | head -n 1)`,
      `rm -rf "${appBundle}"`,
      `ditto "$NEW" "${appBundle}"`,
      `xattr -dr com.apple.quarantine "${appBundle}" 2>/dev/null`,
      relaunch ? `open "${appBundle}"` : '',
      `rm -rf "${stage}"`
    ].join('\n')
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.exit(0), 300)
  }
}
