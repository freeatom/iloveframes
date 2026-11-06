import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { promises as fsp } from 'fs'
import type { Platform } from './types'
import { cropFilter } from '../ffmpeg'

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { windowsHide: true }, (_e, out) => resolve(String(out ?? ''))))

const REG_KEY = 'HKCU\\Software\\iloveframes'

export const win: Platform = {
  id: 'win',
  stopShortcutLabel: 'Ctrl + Shift + 2',

  async captureAttempts(display, idx, out, fps, crop) {
    // an optional area crop runs first, then the frame is kept to even dimensions
    const even = (crop ? cropFilter(crop) + ',' : '') + 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '16', '-pix_fmt', 'yuv420p']
    // fragmented MP4: if the app or the machine dies mid-take, everything up to the last second still plays
    const common = ['-g', String(fps), '-stats_period', '0.05', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-t', '14400']
    const b = display.bounds
    const s = display.scaleFactor
    return [
      // Desktop Duplication (GPU, fast), cursor excluded
      ['-f', 'lavfi', '-i', `ddagrab=output_idx=${idx}:framerate=${fps}:draw_mouse=0`, '-vf', `hwdownload,format=bgra,${even}`, ...enc, ...common, out],
      // GDI fallback for older systems / remote sessions
      [
        '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0',
        '-offset_x', String(Math.round(b.x * s)), '-offset_y', String(Math.round(b.y * s)),
        '-video_size', `${Math.round(b.width * s)}x${Math.round(b.height * s)}`,
        '-i', 'desktop', '-vf', even, ...enc, ...common, out
      ]
    ]
  },

  cursorWatcher(nativeDir) {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(nativeDir, 'cursor-win.ps1')] }
  },

  async machineId() {
    const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
    const m = /MachineGuid\s+REG_SZ\s+([\w-]+)/i.exec(out)
    return m ? m[1] : ''
  },

  async mirrorRead() {
    const out = await run('reg', ['query', REG_KEY, '/v', 'Data'])
    const m = /Data\s+REG_SZ\s+(\S+)/.exec(out)
    return m ? m[1] : null
  },

  async mirrorWrite(data) {
    await run('reg', ['add', REG_KEY, '/v', 'Data', '/t', 'REG_SZ', '/d', data, '/f'])
  },

  updateAsset: () => 'win',

  async installUpdate(file, relaunch = true) {
    // Same approach as electron-updater: hand straight to the NSIS installer.
    // --updated: it waits for this app to close; /S: silent; --force-run: relaunch after;
    // /D=: install over the current folder.
    const args = ['--updated', '/S']
    if (relaunch) args.push('--force-run')
    args.push(`/D=${dirname(process.execPath)}`)
    spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    setTimeout(() => app.quit(), 200)
  }
}
