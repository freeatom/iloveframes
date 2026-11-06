const path = require('path')
module.exports = {
  async home(app, win, out) {
    await win.screenshot({ path: path.join(out, 'home.png') })
  },
  async debug(app, win, out) {
    const r = await win.evaluate(async () => {
      const res = {}
      try { res.displays = (await window.ilf.displays()).map(d => ({...d, thumbnail: d.thumbnail ? d.thumbnail.length : null})) } catch (e) { res.dErr = String(e) }
      try { res.devices = (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind + ':' + d.label + ':' + d.deviceId.slice(0,8)) } catch (e) { res.devErr = String(e) }
      return res
    })
    console.log(JSON.stringify(r, null, 1))
  }
}
module.exports.dom = async (app, win, out) => {
  const r = await win.evaluate(() => ({ ls: Object.fromEntries(Object.entries(localStorage)), trig: [...document.querySelectorAll('button[role=combobox]')].map(b => b.outerHTML.slice(0, 600)), h1: getComputedStyle(document.querySelector('h1').parentElement).opacity }))
  console.log(JSON.stringify(r, null, 1))
}
module.exports.record = async (app, win, out) => {
  const { spawn } = require('child_process')
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'true'); location.reload() }).catch(() => {})
  await win.waitForTimeout(4000)
  await win.screenshot({ path: path.join(out, 'home2.png') })
  await win.getByText('Start recording').click()
  spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mouse.ps1')], { stdio: 'inherit' })
  await win.waitForTimeout(7000)
  await win.evaluate(() => window.ilf.rec.requestStop())
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000)
    if ((await win.evaluate(() => location.hash)).includes('editor')) break
  }
  await win.waitForTimeout(4000)
  await win.screenshot({ path: path.join(out, 'editor.png') })
  const info = await win.evaluate(async () => {
    const id = decodeURIComponent(location.hash.split('/editor/')[1])
    const p = await window.ilf.projects.load(id)
    return { id, dir: p.dir, duration: p.duration, cursor: p.events.cursor.length, clicks: p.events.clicks.length, keys: p.events.keys.length, camera: p.camera, mic: p.mic, engine: p.engine }
  })
  console.log('PROJECT', JSON.stringify(info))
}
module.exports.full = async (app, win, out) => {
  await module.exports.record(app, win, out)
  // inject synthetic clicks at cursor positions, reset edit so auto mode regenerates
  const id = await win.evaluate(() => decodeURIComponent(location.hash.split('/editor/')[1]))
  await win.evaluate(async (id) => {
    const p = await window.ilf.projects.load(id)
    const cur = p.events.cursor.filter((c) => c[0] > 0.5 && c[0] < p.duration - 1)
    const picks = [0.15, 0.22, 0.6, 0.85].map((f) => cur[Math.floor(f * (cur.length - 1))]).filter(Boolean)
    const clicks = picks.map(([t, x, y]) => [t, x, y, 1])
    await window.ilf.projects.save(id, { events: { ...p.events, clicks }, edit: null, mode: 'auto' })
  }, id)
  await win.evaluate(() => { location.hash = '/'; })
  await win.waitForTimeout(800)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3500)
  const segs = await win.evaluate(async (id) => (await window.ilf.projects.load(id)).edit?.zoom.segments, id)
  console.log('SEGMENTS', JSON.stringify(segs))
  // seek into the first zoom and screenshot
  if (segs && segs[0]) {
    await win.keyboard.press('Space'); await win.waitForTimeout(Math.min(4000, (segs[0].start + 1.2) * 1000)); await win.keyboard.press('Space')
  }
  await win.waitForTimeout(600)
  await win.screenshot({ path: path.join(out, 'editor-zoom.png') })
  // export
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(out, 'export-dialog.png') })
  const t0 = Date.now()
  await win.getByRole('button', { name: /Export MP4/ }).click()
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'export-progress.png') })
  await win.getByText('Your video is ready').waitFor({ timeout: 180000 }).catch(async (e) => { await win.screenshot({ path: path.join(out, 'export-fail.png') }); throw e })
  console.log('EXPORT took', (Date.now() - t0) / 1000, 's')
  await win.screenshot({ path: path.join(out, 'export-done.png') })
}
module.exports.exportonly = async (app, win, out) => {
  await win.evaluate((t) => t ? localStorage.setItem('ilf.testTrim', t) : localStorage.removeItem('ilf.testTrim'), process.env.TRIM || '')
  await win.evaluate(([m, q]) => { localStorage.setItem('ilf.readMode', m); localStorage.setItem('ilf.smooth', q) }, [process.env.READ || 'gpu', process.env.SMOOTH || 'high'])
  const list = await win.evaluate(() => window.ilf.projects.list())
  const id = process.env.PID || list[0].id
  if (process.env.BG) await win.evaluate(async ([id, bg]) => { const p = await window.ilf.projects.load(id); if (p.edit) { p.edit.background = JSON.parse(bg); if (window.__trim) {} ; const tr = localStorage.getItem("ilf.testTrim"); if (tr) p.edit.trim = JSON.parse(tr); await window.ilf.projects.save(id, { edit: p.edit }) } }, [id, process.env.BG])
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3000)
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(400)
  const t0 = Date.now()
  if (process.env.GIF) { await win.getByText('GIF', { exact: true }).click(); await win.waitForTimeout(300) }
  await win.getByRole('button', { name: /Export (MP4|GIF)/ }).click()
  await win.waitForTimeout(4000)
  await win.screenshot({ path: path.join(out, 'export-running.png') })
  await win.getByText('Your video is ready').waitFor({ timeout: 300000 })
  console.log('EXPORT took', (Date.now() - t0) / 1000, 's')
  await win.screenshot({ path: path.join(out, 'export-done.png') })
}
module.exports.probe = async (app, win, out) => {
  const r = await win.evaluate(async () => {
    const res = []
    for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E01F', 'avc1.42001f'])
      for (const extra of [{}, { latencyMode: 'quality' }, { bitrateMode: 'variable' }, { latencyMode: 'realtime' }]) {
        const cfg = { codec, width: 1920, height: 1080, bitrate: 20e6, framerate: 60, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' }, ...extra }
        try { const s = await VideoEncoder.isConfigSupported(cfg); res.push(codec + ' ' + JSON.stringify(extra) + ' ' + s.supported) } catch (e) { res.push(codec + ' err ' + e.message) }
      }
    for (const codec of ['vp09.00.40.08', 'av01.0.08M.08', 'hev1.1.6.L120.90']) {
      const s = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 20e6, framerate: 60, hardwareAcceleration: 'prefer-hardware' }).catch(e => ({ supported: 'err' }))
      res.push(codec + ' hw ' + s.supported)
    }
    return res
  })
  console.log(r.join('\n'))
}
module.exports.enctest = async (app, win, out) => {
  const r = await win.evaluate(async () => {
            window.__cfg = {hardwareAcceleration:'no-preference'};
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
    const ctx = c.getContext('2d')
    let n = 0
    const enc = new VideoEncoder({ output: () => n++, error: (e) => console.log(e) })
    enc.configure({ codec: 'avc1.640034', width: 1920, height: 1080, bitrate: 20e6, framerate: 60, avc: { format: 'avc' }, ...(window.__cfg || {}) })
    const t0 = performance.now()
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = `hsl(${i * 3},70%,50%)`; ctx.fillRect(0, 0, 1920, 1080); ctx.fillStyle = '#fff'; ctx.font = '200px sans-serif'; ctx.fillText(String(i), 200 + i * 5, 500)
      const f = new VideoFrame(c, { timestamp: i * 16666 }); enc.encode(f); f.close()
    }
    const tq = performance.now() - t0
    await enc.flush()
    const t1 = performance.now() - t0
    // timer throttling check
    const ts = performance.now(); for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 2)); const tt = performance.now() - ts
    return { queueMs: tq, totalMs: t1, outputs: n, timer50x2ms: tt }
  })
  console.log(JSON.stringify(r))
}
module.exports.pipetest = async (app, win, out) => {
  const list = await win.evaluate(() => window.ilf.projects.list())
  const dir = list[0].dir
  const r = await win.evaluate(async (dir) => {
    const { demux, FrameSource } = window.__ilfDebug
    const url = 'ilf://media/' + encodeURIComponent(dir + String.fromCharCode(92) + 'screen.mp4')
    const d = await demux(url)
    const res = {}
    for (const mode of ['decode-only', 'draw-solid', 'draw-video', 'close-before-encode']) {
      const src = new FrameSource(d)
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
      const ctx = c.getContext('2d', { alpha: false })
      let n = 0
      const enc = new VideoEncoder({ output: () => n++, error: (e) => console.log(e) })
      enc.configure({ codec: 'avc1.640034', width: 1920, height: 1080, bitrate: 17e6, framerate: 60, avc: { format: 'avc' }, ...(mode === 'draw-video' ? { latencyMode: 'quality', bitrateMode: 'variable', hardwareAcceleration: 'no-preference' } : mode === 'close-before-encode' ? { latencyMode: 'quality' } : {}) })
      const t0 = performance.now()
      for (let i = 0; i < 120; i++) {
        const f = await src.frameAt(i / 60)
        if (mode === 'decode-only') continue
        if (mode === 'draw-solid') { ctx.fillStyle = `hsl(${i * 3},70%,50%)`; ctx.fillRect(0, 0, 1920, 1080) }
        else ctx.drawImage(f, 0, 0, 1920, 1080)
        const vf = new VideoFrame(c, { timestamp: i * 16666 }); enc.encode(vf); vf.close()
        while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2))
      }
      await enc.flush()
      res[mode] = Math.round(performance.now() - t0)
      src.close(); enc.close()
    }
    return res
  }, dir)
  console.log(JSON.stringify(r))
}
module.exports.partest = async (app, win, out) => {
  const list = await win.evaluate(() => window.ilf.projects.list())
  const dir = list[0].dir
  const r = await win.evaluate(async (dir) => {
    const { demux, FrameSource } = window.__ilfDebug
    const url = 'ilf://media/' + encodeURIComponent(dir + String.fromCharCode(92) + 'screen.mp4')
    const d = await demux(url)
    const job = async (off) => {
      const src = new FrameSource(d); src.seek(off)
      const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
      const ctx = c.getContext('2d', { alpha: false })
      const enc = new VideoEncoder({ output: () => {}, error: (e) => console.log(e) })
      enc.configure({ codec: 'avc1.640034', width: 1920, height: 1080, bitrate: 17e6, framerate: 60, avc: { format: 'avc' } })
      for (let i = 0; i < 90; i++) {
        const f = await src.frameAt(off + i / 60)
        ctx.fillStyle = '#c4b'; ctx.fillRect(0, 0, 1920, 1080)
        ctx.drawImage(f, 200, 100, 1520, 855)
        const vf = new VideoFrame(c, { timestamp: i * 16666 }); enc.encode(vf); vf.close()
        while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2))
      }
      await enc.flush(); src.close(); enc.close()
    }
    const res = {}
    let t = performance.now(); await job(0); res.one = Math.round(performance.now() - t)
    t = performance.now(); await Promise.all([job(0), job(1.5), job(3)]); res.three = Math.round(performance.now() - t)
    t = performance.now(); await Promise.all([job(0), job(1), job(2), job(3), job(3.5), job(0.5)]); res.six = Math.round(performance.now() - t)
    res.cores = navigator.hardwareConcurrency
    return res
  }, dir)
  console.log(JSON.stringify(r))
}
module.exports.rawexport = async (app, win, out) => {
  const list = await win.evaluate(() => window.ilf.projects.list())
  const r = await win.evaluate(async ([id, target]) => {
    const p = await window.ilf.projects.load(id)
    const e = p.edit || window.__ilfDefaultEdit(p)
    e.camera.enabled = false
    const t = performance.now()
    await window.__ilfDebug.exportProject(p, e, { format: 'mp4', height: 1080, fps: 60, quality: 'high', target }, () => {}, { cancelled: false })
    return performance.now() - t
  }, [list[0].id, process.env.ILF_EXPORT_DIR + '\raw.mp4']).catch(e => 'ERR ' + e.message)
  console.log('RAW', r)
}
module.exports.keys = async (app, win, out) => {
  const { execSync } = require('child_process')
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micOn', 'false'); location.reload() })
  await win.waitForTimeout(3000)
  await win.getByText('Start recording').click()
  await win.waitForTimeout(3000)
  for (let i = 0; i < 4; i++) execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('+')"`)
  await win.waitForTimeout(1000)
  await win.evaluate(() => window.ilf.rec.requestStop())
  for (let i = 0; i < 30; i++) { await win.waitForTimeout(1000); if ((await win.evaluate(() => location.hash)).includes('editor')) break }
  const info = await win.evaluate(async () => { const p = await window.ilf.projects.load(decodeURIComponent(location.hash.split('/editor/')[1])); return { keys: p.events.keys, clicks: p.events.clicks.length, dur: p.duration } })
  console.log('KEYS', JSON.stringify(info))
  await win.evaluate(() => { localStorage.setItem('ilf.micOn', 'true') })
}
module.exports.editorui = async (app, win, out) => {
  const id = process.env.PID
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3500)
  await win.keyboard.press('h')
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'editor-cursor.png') })
  await win.keyboard.press('Control+z')
}
module.exports.seekshot = async (app, win, out) => {
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(3500)
  for (const t of (process.env.TS || '2.834').split(',')) {
    await win.keyboard.press('Home').catch(() => {})
    await win.evaluate((t) => { const v = document.querySelector('video'); v.currentTime = Number(t) }, t)
    await win.waitForTimeout(900)
    const ct = await win.evaluate(() => document.querySelector('video').currentTime)
    console.log('video time', ct)
    await win.screenshot({ path: path.join(out, 'seek-' + t + '.png'), clip: { x: 0, y: 40, width: 1280, height: 720 } })
  }
}
module.exports.etacheck = async (app, win, out) => {
  await win.waitForTimeout(1500)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(3000)
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(400)
  await win.getByRole('button', { name: /Export MP4/ }).click()
  const seen = []
  for (let i = 0; i < 400; i++) {
    const txt = await win.evaluate(() => [...document.querySelectorAll('div')].map(d => d.textContent).find(t => /left$|elapsed$/.test(t || '') && (t || '').length < 30) || '')
    if (txt && seen[seen.length - 1] !== txt) seen.push(txt)
    if (await win.getByText('Your video is ready').isVisible().catch(() => false)) break
    await win.waitForTimeout(300)
  }
  console.log('ETA sequence:', seen.join(' | '))
  await win.keyboard.press('Escape')
  await win.mouse.click(5, 5)
  await win.evaluate(() => { location.hash = '/' })
  await win.waitForTimeout(150)
  await win.screenshot({ path: path.join(out, 'home-back.png') })
}
module.exports.homelayout = async (app, win, out) => {
  await win.evaluate(() => { localStorage.setItem('ilf.camOn', 'true'); localStorage.setItem('ilf.micOn', 'true'); location.reload() })
  await win.waitForTimeout(4500)
  await win.screenshot({ path: path.join(out, 'home-new.png') })
  const over = await win.evaluate(() => { const el = document.querySelector('.overflow-y-auto'); return [el.scrollHeight, el.clientHeight] })
  console.log('scroll vs client (default):', over)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700))
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'home-min.png') })
  console.log('scroll vs client (min):', await win.evaluate(() => { const el = document.querySelector('.overflow-y-auto'); return [el.scrollHeight, el.clientHeight] }))
  await win.evaluate(() => { localStorage.setItem('ilf.camOn', 'false') })
}
module.exports.polish = async (app, win, out) => {
  const id = process.env.PID
  await win.evaluate(async (id) => { const p = await window.ilf.projects.load(id); p.edit.background = { kind: 'wallpaper', value: 's-silk-ocean', blur: 0 }; await window.ilf.projects.save(id, { edit: p.edit }) }, id)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(4000)
  await win.screenshot({ path: path.join(out, 'polish-editor.png') })
  // frame pacing during playback
  const stats = await win.evaluate(async () => {
    const times = []
    let last = performance.now()
    let run = true
    const loop = (t) => { times.push(t - last); last = t; if (run) requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }))
    await new Promise((r) => setTimeout(r, 4000))
    run = false
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }))
    const t = times.slice(5)
    t.sort((a, b) => a - b)
    return { frames: t.length, median: t[Math.floor(t.length / 2)].toFixed(1), p95: t[Math.floor(t.length * 0.95)].toFixed(1), over33: t.filter((x) => x > 33).length }
  })
  console.log('PLAYBACK FRAMES', JSON.stringify(stats))
  await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-palette')); b && b.click() })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'polish-bg.png') })
}
module.exports.importmac = async (app, win, out) => {
  const D = 'C:/Users/ABHINAY/Downloads/wallps/'
  const order = [
    ['26-Tahoe-Light-6K-thumb.jpeg', 'Tahoe Light'], ['26-Tahoe-Dark-6K-thumb.jpeg', 'Tahoe Dark'],
    ['15-Sequoia-Light-thumbnail.jpg', 'Sequoia Light'], ['15-Sequoia-Dark-thumbnail.jpg', 'Sequoia Dark'],
    ['14-Sonoma-Light-thumb.jpg', 'Sonoma Light'], ['14-Sonoma-Dark-thumb.jpg', 'Sonoma Dark'],
    ['13-Ventura-Light-thumb.jpg', 'Ventura Light'], ['13-Ventura-Dark-thumb.jpg', 'Ventura Dark'],
    ['12-Light-thumbnail.jpg', 'Monterey Light'], ['12-Dark-thumbnail.jpg', 'Monterey Dark'],
    ['11-0-Color-Day-thumbnails.jpg', 'Big Sur Light'], ['11-0-Color-Night-thumbnails.jpg', 'Big Sur Dark']
  ]
  const existing = await win.evaluate(() => window.ilf.wallpapers.list())
  if (existing.some((w) => w.group === 'macOS')) return console.log('already imported', existing.length)
  const added = await win.evaluate(([paths, names]) => window.ilf.wallpapers.import('macOS', paths, names), [order.map((o) => D + o[0]), Object.fromEntries(order)])
  console.log('IMPORTED', added.map((w) => `${w.name} ${w.width}x${w.height}`).join(' | '))
}
module.exports.macbg = async (app, win, out) => {
  const id = process.env.PID
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3500)
  await win.locator('[title="Tahoe Dark"]').click()
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'mac-169.png') })
  await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-layout-template')); b && b.click() })
  await win.waitForTimeout(500)
  await win.getByText('9:16').click()
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'mac-916.png') })
  await win.keyboard.press('Control+z'); await win.waitForTimeout(200); await win.keyboard.press('Control+z')
  await win.waitForTimeout(1200)
}
module.exports.audiotest = async (app, win, out) => {
  const id = process.env.PID
  const tone = require('path').resolve(__dirname, '../.tmp/test-tone.mp3')
  await win.evaluate((p) => window.ilf.sounds.import([p]), tone)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3500)
  await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-volume2, svg.lucide-volume-2')); b && b.click() })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'audio-tab.png') })
  // place clip at 3.0s via "Add at playhead"
  await win.evaluate(() => { const v = document.querySelector('video'); v.currentTime = 3 })
  await win.keyboard.press('ArrowRight'); await win.keyboard.press('ArrowLeft')
  await win.waitForTimeout(400)
  const addBtns = win.locator('button:has(svg.lucide-plus)')
  const n = await addBtns.count()
  await addBtns.nth(n - 1).click()
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'audio-clip.png') })
  const clips = await win.evaluate(async (id) => (await window.ilf.projects.load(id)).edit.audio.clips, id)
  console.log('CLIPS', JSON.stringify(clips.map((c) => [c.name, c.start.toFixed(2), c.duration.toFixed(2)])))
}
module.exports.seqtest = async (app, win, out) => {
  const id = 'zz-seq-test'
  const clipPath = require('path').resolve(__dirname, '../.tmp/test-clip.mov')
  const added = await win.evaluate(([id, p]) => window.ilf.media.import(id, [p]), [id, clipPath])
  console.log('IMPORTED', JSON.stringify(added.map((a) => [a.name, a.duration.toFixed(2), a.width, a.height, a.hasAudio])))
  // sequence: recording 5..9s, then the imported clip 0..4s
  await win.evaluate(async ([id, src]) => {
    const p = await window.ilf.projects.load(id)
    const e = p.edit
    e.clips = [{ id: 'a', source: 'main', in: 5, out: 9 }, { id: 'b', source: src, in: 0, out: 4 }]
    e.zoom.segments = []
    await window.ilf.projects.save(id, { edit: e })
  }, [id, added[0].id])
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(4500)
  await win.screenshot({ path: path.join(out, 'seq-editor.png') })
  // seek into the imported clip and screenshot the preview
  await win.evaluate(() => document.querySelector('canvas') && 0)
  await win.keyboard.press('Shift+ArrowRight'); for (let i = 0; i < 5; i++) await win.keyboard.press('Shift+ArrowRight')
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'seq-at6.png') })
  // split at 6s with S
  await win.keyboard.press('s')
  await win.waitForTimeout(800)
  const clips = await win.evaluate(async (id) => (await window.ilf.projects.load(id)).edit.clips, id)
  console.log('AFTER SPLIT', JSON.stringify(clips.map((c) => [c.source.slice(0, 6), c.in.toFixed(2), c.out.toFixed(2)])))
  await win.screenshot({ path: path.join(out, 'seq-split.png') })
}
module.exports.license = async (app, win, out) => {
  const st = await win.evaluate(() => window.ilf.license.status())
  console.log('STATUS', JSON.stringify({ state: st.state, hoursLeft: (st.remainingMs / 3600000).toFixed(2), online: st.online, tampered: st.tampered }))
  await win.screenshot({ path: path.join(out, 'lic-home.png') })
  const r = await win.evaluate(() => window.ilf.license.activate('ILF-FAKE-0000-1111-2222', 'Abhinay'))
  console.log('FAKE KEY', JSON.stringify(r))
  await win.evaluate(() => { location.hash = '/account' })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'lic-account.png') })
}
module.exports.licensegate = async (app, win, out) => {
  const st = await win.evaluate(() => window.ilf.license.status())
  console.log('STATUS', JSON.stringify({ state: st.state, tampered: st.tampered }))
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'lic-gate.png') })
  const rec = await win.evaluate(() => window.ilf.rec.prepare({ displayId: 'x', countdown: 0, mode: 'auto', fps: 30 }).then(() => 'ALLOWED', (e) => 'BLOCKED: ' + e.message))
  console.log('RECORD', rec)
}
module.exports.finalui = async (app, win, out) => {
  await win.evaluate(() => { location.hash = '/editor/zz-seq-test' })
  await win.waitForTimeout(4000)
  await win.evaluate(() => { const b = [...document.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-clapperboard')); b && b.click() })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'clips-panel.png') })
  await win.keyboard.press('f')
  await win.waitForTimeout(1500)
  console.log('FULLSCREEN', await win.evaluate(() => !!document.fullscreenElement))
  await win.screenshot({ path: path.join(out, 'fullscreen.png') })
  await win.keyboard.press('Escape')
}
module.exports.homev2 = async (app, win, out) => {
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'home-v2.png') })
  console.log('scroll', await win.evaluate(() => { const m = document.querySelector('main'); return [m.scrollHeight, m.clientHeight] }))
  await win.evaluate(() => { location.hash = '/shot' })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'shot-empty.png') })
  // load a screenshot through the main process from disk
  const img = require('path').resolve(__dirname, '../.shots/clicks.png')
  await win.evaluate(async (p) => {
    const r = await window.ilf.shot.load(p)
    window.dispatchEvent(new CustomEvent('ilf-test-load', { detail: r }))
  }, img)
  await win.waitForTimeout(400)
}
module.exports.shottest = async (app, win, out) => {
  const img = require('path').resolve(__dirname, '../.shots/seq-export.jpg')
  await app.evaluate(({ clipboard, nativeImage }, p) => clipboard.writeImage(nativeImage.createFromPath(p)), img)
  await win.evaluate(() => { location.hash = '/shot' })
  await win.waitForTimeout(1200)
  await win.keyboard.press('Control+v')
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'shot-loaded.png') })
  await win.getByRole('button', { name: /^Crop$/ }).click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: '1:1' }).first().click()
  await win.waitForTimeout(600)
  await win.screenshot({ path: path.join(out, 'shot-crop.png') })
  await win.getByRole('button', { name: /Done cropping/ }).click()
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'shot-cropped.png') })
  await win.getByRole('button', { name: /^Export$/ }).click()
  await win.waitForTimeout(2500)
}
// Smart recordings + transitions: record a take, import it (embedded data) and an
// older take (project-folder data) into another project, add transitions, export.
module.exports.smart = async (app, win, out) => {
  const fs = require('fs')
  const prefs = await win.evaluate(() => ['countdown', 'camOn', 'micEnabled'].map((k) => [k, localStorage.getItem('ilf.' + k)]))
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'true'); localStorage.setItem('ilf.micEnabled', 'true'); location.reload() })
  await win.waitForTimeout(4000)
  let A
  try {
    await module.exports.record(app, win, out)
    A = await win.evaluate(() => decodeURIComponent(location.hash.split('/editor/')[1]))
  } finally {
    await win.evaluate((prefs) => prefs.forEach(([k, v]) => (v === null ? localStorage.removeItem('ilf.' + k) : localStorage.setItem('ilf.' + k, v))), prefs)
  }
  const pa = await win.evaluate((id) => window.ilf.projects.load(id), A)
  console.log('REC FILES', fs.readdirSync(pa.dir).join(' '), 'screenFile=', pa.screenFile)
  // copy the take somewhere with no project.json, so only the embedded data can help
  const loose = path.join(require('os').tmpdir(), 'ilf-loose')
  fs.mkdirSync(loose, { recursive: true })
  const looseFile = path.join(loose, pa.screenFile)
  fs.copyFileSync(path.join(pa.dir, pa.screenFile), looseFile)
  const B = await win.evaluate((p) => window.ilf.media.importAsProject([p]), path.resolve(__dirname, '../.tmp/test-clip.mov'))
  const old = process.env.OLD
  const added = await win.evaluate(([id, paths]) => window.ilf.media.import(id, paths), [B, [looseFile, ...(old ? [old] : [])]])
  console.log('IMPORTED', JSON.stringify(added.map((a) => ({ name: a.name, dur: +a.duration.toFixed(2), audio: a.hasAudio, cam: a.camera, cursor: a.track?.events.cursor.length, clicks: a.track?.events.clicks.length, keys: a.track?.events.keys.length }))))
  await win.evaluate(async ([id, srcs]) => {
    const p = await window.ilf.projects.load(id)
    const e = p.edit ?? null
    const clips = [{ id: 'm', source: 'main', in: 0, out: 3 }]
    srcs.forEach((s, i) => clips.push({ id: 's' + i, source: s.id, in: 0.5, out: Math.min(s.duration, 4.5), tIn: { kind: i === 0 ? 'zoom' : 'wipe', duration: 1 } }))
    await window.ilf.projects.save(id, { edit: e ? { ...e, clips } : null, pendingClips: clips })
  }, [B, added])
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, B)
  await win.waitForTimeout(4000)
  // first open creates the edit; apply our clip layout through the store-backed save
  await win.evaluate(async (id) => {
    const p = await window.ilf.projects.load(id)
    if (p.pendingClips && p.edit) await window.ilf.projects.save(id, { edit: { ...p.edit, clips: p.pendingClips, cursor: { ...p.edit.cursor, enabled: true } } })
  }, B)
  await win.evaluate(() => { location.hash = '/' })
  await win.waitForTimeout(600)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, B)
  await win.waitForTimeout(4500)
  await win.screenshot({ path: path.join(out, 'smart-editor.png') })
  // clips tab
  await win.locator('button:has(svg.lucide-clapperboard)').first().click().catch(() => {})
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'smart-clips.png') })
  // open the transition popover on the first cut
  await win.locator('button[title^="Zoom"]').first().click().catch((e) => console.log('no handle', e.message))
  await win.waitForTimeout(900)
  await win.screenshot({ path: path.join(out, 'smart-popover.png') })
  await win.keyboard.press('Escape')
  console.log('PROJECTS', JSON.stringify({ A, B }))
  if (process.env.NOEXPORT) return
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: path.join(out, 'smart-export.png') })
  await win.getByRole('button', { name: /Export MP4/ }).click()
  await win.getByText('Your video is ready').waitFor({ timeout: 300000 })
  await win.screenshot({ path: path.join(out, 'smart-done.png') })
}
// Preview of transitions + imported webcam: PID=<project> KIND=push
module.exports.trprev = async (app, win, out) => {
  const id = process.env.PID
  await win.evaluate(async ([id, kind]) => {
    const p = await window.ilf.projects.load(id)
    const e = p.edit
    e.clips = e.clips.map((c, i) => (i === 0 ? c : { ...c, tIn: { kind, duration: 1 } }))
    e.camera.enabled = true
    await window.ilf.projects.save(id, { edit: e })
  }, [id, process.env.KIND || 'push'])
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(4500)
  const cut = await win.evaluate(async (id) => { const p = await window.ilf.projects.load(id); return p.edit.clips[0].out - p.edit.clips[0].in }, id)
  for (const dt of [-0.3, -0.1, 0.1, 0.3, 1.5]) {
    await win.evaluate((t) => window.__ilfPlayer.seek(t), cut + dt)
    await win.waitForTimeout(1200)
    await win.locator('canvas').first().screenshot({ path: path.join(out, `trprev_${dt}.png`) })
  }
}
module.exports.brandui = async (app, win, out) => {
  await win.screenshot({ path: path.join(out, 'b-home.png') })
  await win.evaluate(() => { location.hash = '/shot' })
  await win.waitForTimeout(1200)
  await win.evaluate(async (p) => window.dispatchEvent(new CustomEvent('ilf-test-load', { detail: await window.ilf.shot.load(p) })), require('path').resolve(__dirname, '../.shots/clicks.png'))
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'b-shot.png') })
  await win.getByRole('button', { name: /^Crop$/ }).click().catch(() => {})
  await win.waitForTimeout(600)
  await win.screenshot({ path: path.join(out, 'b-shot-crop.png') })
  if (process.env.PID) {
    await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
    await win.waitForTimeout(4000)
    await win.getByRole('button', { name: 'Export' }).first().click()
    await win.waitForTimeout(700)
    await win.screenshot({ path: path.join(out, 'b-export.png') })
    await win.keyboard.press('Escape')
  }
  await win.evaluate(() => { location.hash = '/account' })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'b-account.png') })
}
// License flow against Dodo test mode. STEP=activate|restart|after; keys via env.
module.exports.lic = async (app, win, out) => {
  const st = () => win.evaluate(() => window.ilf.license.status())
  const show = (label, s) => console.log('STATUS', label, JSON.stringify({ state: s.state, key: s.license?.keyMasked, email: s.license?.customerEmail, name: s.name }))
  const step = process.env.STEP
  show('start', await st())
  if (step === 'activate') {
    for (const [label, key] of [['fake', 'ILF-FAKE0-FAKE0-FAKE0-FAKE0'], ['tooShort', 'abc'], ['otherProduct', process.env.K_OTHER], ['limitReached', process.env.K_LIMIT], ['disabled', process.env.K_DISABLED]].filter(([, k]) => k)) {
      const r = await win.evaluate(([k]) => window.ilf.license.activate(k, 'Abhi'), [key])
      console.log('ACTIVATE', label, JSON.stringify(r))
    }
    show('afterBad', await st())
    const r = await win.evaluate(([k]) => window.ilf.license.activate(k, 'Abhi'), [process.env.K_MAIN])
    console.log('ACTIVATE main', JSON.stringify(r))
    show('afterMain', await st())
  }
  if (step === 'deactivate') {
    const r = await win.evaluate(() => window.ilf.license.deactivate())
    console.log('DEACTIVATE', JSON.stringify(r))
    show('afterDeactivate', await st())
  }
  await win.evaluate(() => { location.hash = '/account' })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, `lic-${step}.png`) })
}
// Pro polish: first-run tour, account page, activation celebration, feedback, editor tour.
module.exports.pro = async (app, win, out) => {
  const shot = (n) => win.screenshot({ path: path.join(out, n + '.png') })
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.removeItem(`ilf.tour.${n}.v1`)); location.hash = '/'; location.reload() })
  await win.waitForTimeout(3500)
  // home tour runs on its own
  for (let k = 0; k < 9; k++) {
    const card = win.locator('[role=dialog]')
    if (!(await card.count())) break
    console.log('TOUR home', k, await card.getAttribute('aria-label'))
    await shot('tour-home-' + k)
    await win.getByRole('button', { name: /^(Next|Show me|Done)$/ }).click()
    await win.waitForTimeout(700)
  }
  console.log('home tour seen flag:', await win.evaluate(() => localStorage.getItem('ilf.tour.home.v1')))
  await win.waitForTimeout(800)
  await shot('home-alive')
  // replay + skip from the help menu
  await win.locator('[data-tour=help]').click()
  await win.waitForTimeout(400)
  await shot('help-menu')
  await win.getByText('Replay walkthrough').click()
  await win.waitForTimeout(1000)
  console.log('replay visible:', await win.locator('[role=dialog]').count())
  await win.getByRole('button', { name: 'Show me' }).click()
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: 'Skip' }).click()
  await win.waitForTimeout(600)
  console.log('after skip visible:', await win.locator('[role=dialog]').count())
  // account page (trial)
  await win.locator('[data-tour=account]').click()
  await win.waitForTimeout(1200)
  await shot('account-trial')
  // feedback sheet through the real path
  await win.getByText('Send feedback').click()
  await win.waitForTimeout(500)
  await win.locator('textarea').fill('UI test from Claude: in-app feedback works end to end. Safe to delete.')
  await shot('feedback')
  await win.getByRole('button', { name: /^Send$/ }).click()
  await win.waitForTimeout(1500)
  await shot('feedback-sent')
  await win.waitForTimeout(1500)
  // real activation against Dodo test mode -> celebration
  if (process.env.K_MAIN) {
    await win.locator('input[placeholder="Paste your license key"]').fill(process.env.K_MAIN)
    await win.getByRole('button', { name: /Activate Pro/ }).click()
    await win.getByText("You're").first().waitFor({ timeout: 20000 })
    await win.waitForTimeout(700)
    await shot('celebrate')
    await win.getByRole('button', { name: 'Start creating' }).click()
    await win.waitForTimeout(800)
    await shot('account-pro')
    await win.evaluate(() => { location.hash = '/' })
    await win.waitForTimeout(1500)
    await shot('home-pro')
  }
  // editor tour on an existing project
  const list = await win.evaluate(() => window.ilf.projects.list())
  if (list[0]) {
    await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, list[0].id)
    await win.waitForTimeout(4500)
    for (let k = 0; k < 5; k++) {
      const card = win.locator('[role=dialog]')
      if (!(await card.count())) break
      console.log('TOUR editor', k, await card.getAttribute('aria-label'))
      await shot('tour-editor-' + k)
      await win.getByRole('button', { name: /^(Next|Done)$/ }).click()
      await win.waitForTimeout(700)
    }
  }
  if (process.env.K_MAIN) console.log('DEACTIVATE', JSON.stringify(await win.evaluate(() => window.ilf.license.deactivate())))
  // leave the first-run tours for the real user
  await win.evaluate(() => ['home', 'editor'].forEach((n) => localStorage.removeItem(`ilf.tour.${n}.v1`)))
}
// Per-tab editor guides: each tab shows its guide the first time it opens; ? replays it.
module.exports.panels = async (app, win, out) => {
  const tabs = ['clips', 'frame', 'cursor', 'zoom', 'camera', 'audio', 'background']
  await win.evaluate((tabs) => { localStorage.setItem('ilf.tour.editor.v1', 'done'); localStorage.setItem('ilf.tour.home.v1', 'done'); tabs.forEach((t) => localStorage.removeItem(`ilf.tour.tab-${t}.v1`)) }, tabs)
  const list = await win.evaluate(() => window.ilf.projects.list())
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, list[0].id)
  await win.waitForTimeout(4000)
  const labels = { clips: 'Clips', background: 'Background', frame: 'Frame', cursor: 'Cursor', zoom: 'Zoom', camera: 'Camera', audio: 'Audio' }
  for (const t of tabs) {
    // the tab buttons are icon-only; their tooltips carry the names, so click by order
    await win.locator(`[data-tab=${t}]`).click()
    await win.waitForTimeout(1100)
    const seen = []
    for (let k = 0; k < 5; k++) {
      const card = win.locator('[role=dialog]')
      if (!(await card.count())) break
      seen.push(await card.getAttribute('aria-label'))
      if (k === 0 && (t === 'cursor' || t === 'audio')) await win.screenshot({ path: path.join(out, `panel-${t}.png`) })
      await win.getByRole('button', { name: /^(Next|Done)$/ }).click()
      await win.waitForTimeout(650)
    }
    console.log('TAB', labels[t], '->', JSON.stringify(seen))
  }
  // reopening a tab doesn't repeat it, the ? button does
  await win.locator('[data-tab=cursor]').click()
  await win.waitForTimeout(1000)
  console.log('reopen cursor shows tour:', await win.locator('[role=dialog]').count())
  await win.locator('button:has(svg.lucide-circle-help)').last().click()
  await win.waitForTimeout(900)
  console.log('? replays:', await win.locator('[role=dialog]').getAttribute('aria-label').catch(() => null))
  await win.getByRole('button', { name: 'Skip' }).click()
  await win.waitForTimeout(500)
  console.log('after skip:', await win.locator('[role=dialog]').count())
  // hand the first-run guides back to the real user
  await win.evaluate((tabs) => { ['editor', 'home', ...tabs.map((t) => 'tab-' + t)].forEach((n) => localStorage.removeItem(`ilf.tour.${n}.v1`)) }, tabs)
}
// Area picker + area recording + vertical control bar.
module.exports.area = async (app, win, out) => {
  const shot = (p, n) => p.screenshot({ path: path.join(out, n + '.png') })
  const d = await app.evaluate(({ screen }) => { const p = screen.getPrimaryDisplay(); return { id: String(p.id), W: p.size.width, H: p.size.height, sf: p.scaleFactor } })
  console.log('display', JSON.stringify(d))
  // 1) the picker: draw a rectangle and confirm with Enter
  const res = win.evaluate((id) => window.ilf.area.pick(id, null), d.id)
  let pw = null
  for (let i = 0; i < 40 && !pw; i++) { await win.waitForTimeout(200); pw = app.windows().find((w) => w.url().includes('/area')) }
  await pw.waitForTimeout(900)
  await shot(pw, 'area-empty')
  await pw.mouse.move(260, 180); await pw.mouse.down(); await pw.mouse.move(900, 500, { steps: 12 }); await pw.mouse.move(1160, 690, { steps: 12 }); await pw.mouse.up()
  await pw.waitForTimeout(500)
  await shot(pw, 'area-drawn')
  await pw.keyboard.press('Enter').catch(() => {}) // the picker closes itself on Enter
  const picked = await res
  console.log('picked', JSON.stringify(picked))
  // 2) record that area
  const prefs = await win.evaluate(() => ['countdown', 'camOn', 'micEnabled', 'captureMode', 'areas'].map((k) => [k, localStorage.getItem('ilf.' + k)]))
  await win.evaluate(([id, a]) => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micEnabled', 'false'); localStorage.setItem('ilf.captureMode', '"area"'); localStorage.setItem('ilf.areas', JSON.stringify({ [id]: a })); location.reload() }, [d.id, picked])
  await win.waitForTimeout(4000)
  await shot(win, 'home-area')
  try {
    await win.getByText('Start recording').click()
    const { spawn } = require('child_process')
    spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mouse.ps1')], { stdio: 'ignore' })
    let cb = null
    for (let i = 0; i < 40 && !cb; i++) { await win.waitForTimeout(200); cb = app.windows().find((w) => w.url().includes('/controlbar')) }
    await cb.waitForTimeout(1500)
    await shot(cb, 'controlbar')
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL().split('#')[1] || w.webContents.getURL().slice(0, 30), b: w.getBounds() })))
    console.log('windows', JSON.stringify(bounds))
    await win.waitForTimeout(5000)
    await win.evaluate(() => window.ilf.rec.requestStop())
    for (let i = 0; i < 60; i++) { await win.waitForTimeout(1000); if ((await win.evaluate(() => location.hash)).includes('editor')) break }
    await win.waitForTimeout(3500)
    await shot(win, 'area-editor')
    const p = await win.evaluate(async () => { const id = decodeURIComponent(location.hash.split('/editor/')[1]); return window.ilf.projects.load(id) })
    const xs = p.events.cursor.map((c) => c[1]), ys = p.events.cursor.map((c) => c[2])
    console.log('PROJECT', JSON.stringify({ id: p.id, display: p.display, area: p.area, file: p.screenFile, cursorX: [Math.min(...xs).toFixed(2), Math.max(...xs).toFixed(2)], cursorY: [Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2)], clicks: p.events.clicks.length }))
  } finally {
    await win.evaluate((prefs) => prefs.forEach(([k, v]) => (v === null ? localStorage.removeItem('ilf.' + k) : localStorage.setItem('ilf.' + k, v))), prefs)
  }
}
// Crop after recording: C opens the editor, drag a handle, apply, export.
module.exports.crop = async (app, win, out) => {
  const shot = (n) => win.screenshot({ path: path.join(out, n + '.png') })
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4500)
  await win.evaluate(() => window.__ilfPlayer.seek(2))
  await win.waitForTimeout(500)
  await win.keyboard.press('c')
  await win.waitForTimeout(1800)
  await shot('crop-open')
  const se = win.locator('span.cursor-nwse-resize, span[style*="nwse-resize"]').last()
  const b = await se.boundingBox()
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await win.mouse.down(); await win.mouse.move(b.x - 220, b.y - 140, { steps: 10 }); await win.mouse.up()
  const nw = win.locator('span[style*="nwse-resize"]').first()
  const a = await nw.boundingBox()
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await win.mouse.down(); await win.mouse.move(a.x + 90, a.y + 60, { steps: 10 }); await win.mouse.up()
  await win.waitForTimeout(400)
  await shot('crop-dragged')
  await win.getByRole('button', { name: /Apply crop/ }).click()
  await win.waitForTimeout(1500)
  await shot('crop-applied')
  await win.waitForTimeout(800)
  const p = await win.evaluate((id) => window.ilf.projects.load(id), process.env.PID)
  console.log('CROPS', JSON.stringify(p.edit?.crops))
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: /Export MP4/ }).click()
  await win.getByText('Your video is ready').waitFor({ timeout: 300000 })
  console.log('EXPORTED')
  await win.evaluate(() => ['home', 'editor', 'tab-clips', 'tab-background', 'tab-frame', 'tab-cursor', 'tab-zoom', 'tab-camera', 'tab-audio'].forEach((n) => localStorage.removeItem(`ilf.tour.${n}.v1`)))
}
// webcam bubble during playback and scrubbing: counts frames drawn with a live / held / missing webcam
module.exports.camplay = async (app, win, out) => {
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4000)
  const reset = () => win.evaluate(() => Object.assign(window.__ilfCamStats, { live: 0, held: 0, missing: 0 }))
  const stats = () => win.evaluate(() => ({ ...window.__ilfCamStats }))
  await win.evaluate(() => window.__ilfPlayer.seek(0))
  await win.waitForTimeout(600)
  await reset()
  await win.evaluate(() => window.__ilfPlayer.play())
  await win.waitForTimeout(4500)
  await win.evaluate(() => window.__ilfPlayer.pause())
  console.log('PLAY', JSON.stringify(await stats()))
  await win.screenshot({ path: path.join(out, 'camplay.png') })
  await reset()
  for (const t of [3.9, 1.2, 4.6, 0.8, 2.7, 4.1, 1.9, 3.3, 0.9, 4.8, 2.2, 3.6]) {
    await win.evaluate((t) => window.__ilfPlayer.seek(t), t)
    await win.waitForTimeout(90)
  }
  await win.waitForTimeout(800)
  console.log('SCRUB', JSON.stringify(await stats()))
  // play across a scrub: seek while playing
  await reset()
  await win.evaluate(() => { window.__ilfPlayer.seek(0.6); window.__ilfPlayer.play() })
  await win.waitForTimeout(1200)
  await win.evaluate(() => window.__ilfPlayer.seek(3.2))
  await win.waitForTimeout(1500)
  await win.evaluate(() => window.__ilfPlayer.pause())
  console.log('PLAYSEEK', JSON.stringify(await stats()))
}
// device frames: pick each laptop + finish from the Frame panel and screenshot the preview
module.exports.devices = async (app, win, out) => {
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4000)
  await win.evaluate(() => window.__ilfPlayer.seek(3))
  await win.locator('[data-tab="frame"]').first().click()
  await win.waitForTimeout(500)
  const pick = async (label, finish, name) => {
    await win.getByRole('button', { name: label, exact: true }).click()
    if (finish) await win.getByRole('button', { name: finish }).click()
    await win.waitForTimeout(700)
    await win.locator('canvas').first().screenshot({ path: path.join(out, name + '.png') })
  }
  await pick('MacBook', 'Space black', 'dev-mac-dark')
  await pick('MacBook', 'Silver', 'dev-mac-light')
  await pick('Windows laptop', 'Graphite', 'dev-win-dark')
  await pick('Windows laptop', 'Platinum', 'dev-win-light')
  await win.screenshot({ path: path.join(out, 'dev-panel.png') })
  await pick('None', null, 'dev-none')
}

// AI agent bridge end to end: enable it, start the MCP server like an agent would, call tools over stdio
module.exports.agent = async (app, win, out) => {
  const { spawn } = require('child_process')
  const fs = require('fs')
  const http = require('http')
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  const st = await win.evaluate(() => window.ilf.agent.setEnabled(true))
  console.log('ENABLED', st.enabled, 'port', st.port)
  const launch = process.env.MCP_VIA === 'node' ? st.launch.node : st.launch.app
  console.log('LAUNCH', JSON.stringify(launch))
  const mcp = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  mcp.stderr.on('data', () => {})
  let buf = ''
  const waiting = new Map()
  mcp.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const m = JSON.parse(line)
        const w = waiting.get(m.id)
        if (w) w(m)
      } catch { console.log('NONJSON-STDOUT', line.slice(0, 120)) }
    }
  })
  let n = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++n
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 600000)
    waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args })
    const c = r.result.content
    const txt = c.filter((x) => x.type === 'text').map((x) => x.text).join(' ')
    return { err: !!r.result.isError, txt, img: c.find((x) => x.type === 'image') }
  }
  const short = (s, k = 160) => s.replace(/\s+/g, ' ').slice(0, k)
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  console.log('INIT', init.result.serverInfo.name, init.result.protocolVersion)
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tl = await rpc('tools/list', {})
  console.log('TOOLS', tl.result.tools.length, tl.result.tools.map((t) => t.name).join(','))
  let r = await call('get_status'); console.log('get_status', r.err, short(r.txt))
  r = await call('list_projects', { limit: 3 }); console.log('list_projects', r.err, short(r.txt, 200))
  r = await call('get_project'); console.log('get_project(before open)', r.err, short(r.txt))
  r = await call('open_project', { id: process.env.PID }); console.log('open_project', r.err, short(r.txt, 120))
  const proj = JSON.parse((await call('get_project')).txt)
  console.log('project', proj.seconds, 's clips', proj.clips.length, 'zooms', proj.zooms.length, 'clicks', proj.click_count)
  r = await call('set_frame', { device: 'macbook', device_color: 'light', padding: 0.1 }); console.log('set_frame', r.err, r.txt)
  r = await call('set_background', { kind: 'gradient', value: 'g-dusk' }); console.log('set_background', r.err, r.txt)
  r = await call('set_background', { kind: 'solid', value: 'red' }); console.log('set_background(bad)', r.err, r.txt)
  r = await call('remove_zoom', { all: true }); console.log('remove_zoom', r.err, r.txt)
  r = await call('add_zoom', { start: 2, end: 6, scale: 2.2 }); console.log('add_zoom', r.err, r.txt)
  r = await call('add_zoom', { start: 4, end: 7 }); console.log('add_zoom(overlap)', r.err, r.txt)
  r = await call('add_zoom', { start: 1, end: 2, scale: 99 }); console.log('add_zoom(scale 99)', r.err, r.txt)
  r = await call('remove_range', { start: 20, end: 24 }); console.log('remove_range', r.err, short(r.txt, 120))
  r = await call('set_transition', { all: true, kind: 'blur', duration: 0.5 }); console.log('set_transition', r.err, r.txt)
  r = await call('preview_frame', { time: 3 }); console.log('preview_frame', r.err, r.img ? r.img.mimeType + ' ' + r.img.data.length + ' b64 chars' : r.txt)
  if (r.img) fs.writeFileSync(path.join(out, 'agent-frame.jpg'), Buffer.from(r.img.data, 'base64'))
  const after = JSON.parse((await call('get_project')).txt)
  console.log('after', after.seconds, 's clips', after.clips.length, 'zooms', JSON.stringify(after.zooms.map((z) => [z.start, z.end, z.scale])), 'frame', JSON.stringify(after.frame), 'bg', JSON.stringify(after.background))
  r = await call('undo', { steps: 2 }); console.log('undo', r.err, r.txt)
  r = await call('redo', { steps: 2 }); console.log('redo', r.err, r.txt)
  r = await call('unlock_pro', {}); console.log('unknown tool via MCP', r.err, r.txt)
  // straight at the bridge, bypassing the MCP server
  const b = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'iloveframes', 'agent-bridge.json'), 'utf8'))
  const post = (headers, body) => new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: b.port, path: '/call', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => res(rs.statusCode + ' ' + d)) })
    req.end(JSON.stringify(body))
  })
  console.log('bridge no key', await post({}, { tool: 'get_status' }))
  console.log('bridge wrong key', await post({ Authorization: 'Bearer ' + 'x'.repeat(64) }, { tool: 'get_status' }))
  console.log('bridge from a web page', await post({ Authorization: 'Bearer ' + b.token, Origin: 'https://evil.example' }, { tool: 'get_status' }))
  console.log('bridge license tool', await post({ Authorization: 'Bearer ' + b.token }, { tool: 'license:activate', args: { key: 'x' } }))
  if (process.env.AGENT_EXPORT) {
    const t0 = Date.now()
    r = await call('export_video', { resolution: '720', fps: '30', quality: 'standard' })
    console.log('export_video', r.err, short(r.txt), ((Date.now() - t0) / 1000).toFixed(1) + 's')
  }
  await win.screenshot({ path: path.join(out, 'agent-editor.png') })
  mcp.stdin.end()
  await win.evaluate(() => { location.hash = '/account' })
  await win.waitForTimeout(1200)
  await win.screenshot({ path: path.join(out, 'agent-account.png') })
  const off = await win.evaluate(() => window.ilf.agent.setEnabled(false))
  console.log('DISABLED', !off.enabled, 'bridge file gone', !fs.existsSync(path.join(process.env.APPDATA, 'iloveframes', 'agent-bridge.json')))
}

// device frame inside the app: zoomed + unzoomed preview, then a real MP4 export with the MacBook frame
module.exports.devexport = async (app, win, out) => {
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4000)
  await win.locator('[data-tab="frame"]').first().click()
  await win.waitForTimeout(400)
  await win.getByRole('button', { name: 'MacBook', exact: true }).click()
  await win.getByRole('button', { name: 'Silver' }).click()
  for (const [t, n] of [[0.5, 'app-mac-wide'], [4, 'app-mac-zoom']]) {
    await win.evaluate((t) => window.__ilfPlayer.seek(t), t)
    await win.waitForTimeout(900)
    await win.locator('canvas').first().screenshot({ path: path.join(out, n + '.png') })
  }
  await win.getByRole('button', { name: 'Windows laptop', exact: true }).click()
  await win.getByRole('button', { name: 'Graphite' }).click()
  await win.waitForTimeout(700)
  await win.locator('canvas').first().screenshot({ path: path.join(out, 'app-win.png') })
  await win.getByRole('button', { name: 'MacBook', exact: true }).click()
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: /Export MP4/ }).click()
  await win.getByText('Your video is ready').waitFor({ timeout: 300000 })
  console.log('EXPORTED')
  // leave the test project as it was
  await win.keyboard.press('Escape').catch(() => {})
}

// Frame panel without the parked Device picker
module.exports.framepanel = async (app, win, out) => {
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4000)
  await win.locator('[data-tab="frame"]').first().click()
  await win.waitForTimeout(600)
  console.log('DEVICE SECTION VISIBLE', await win.getByText('Device', { exact: true }).count())
  await win.screenshot({ path: path.join(out, 'framepanel.png') })
}

// anonymous usage stats: open a project + screenshot studio, let the app send its batch
module.exports.telemetry = async (app, win, out) => {
  await win.evaluate(() => { ['home', 'editor'].forEach((n) => localStorage.setItem(`ilf.tour.${n}.v1`, 'done')); ['clips', 'background', 'frame', 'cursor', 'zoom', 'camera', 'audio'].forEach((t) => localStorage.setItem(`ilf.tour.tab-${t}.v1`, 'done')) })
  console.log('opt-in state:', JSON.stringify(await win.evaluate(() => window.ilf.telemetry.get())))
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, process.env.PID)
  await win.waitForTimeout(4000)
  await win.evaluate(() => { location.hash = '/shot' })
  await win.waitForTimeout(2000)
  await win.evaluate(() => { location.hash = '/account' })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(out, 'telemetry-account.png') })
  await win.waitForTimeout(3000) // first batch goes out ~4s after launch in this mode
}

// send feedback through the real app path and report what comes back
module.exports.feedbackcheck = async (app, win, out) => {
  const r = await win.evaluate(async () => {
    try { return await window.ilf.feedback({ kind: 'bug', message: '[test] in-app feedback check from Claude, please ignore', email: '', name: 'test' }) } catch (e) { return { thrown: String(e) } }
  })
  console.log('FEEDBACK RESULT', JSON.stringify(r))
}

// bring-your-own-video project: two videos -> one project, a title, per-clip volume, export
module.exports.vproj = async (app, win, out) => {
  const { execFileSync } = require('child_process')
  const ff = require('ffmpeg-static')
  const fs = require('fs')
  const dir = path.join(out, 'vproj-src')
  fs.mkdirSync(dir, { recursive: true })
  const a = path.join(dir, 'phone clip.mp4') // H.264/AAC: takes the lossless fast path
  const b = path.join(dir, 'old camera.avi') // MPEG-4 part 2: gets converted
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', a])
  execFileSync(ff, ['-y', '-f', 'lavfi', '-i', 'smptebars=size=960x540:rate=25:duration=3', '-c:v', 'mpeg4', '-q:v', '4', b])
  const t0 = Date.now()
  const id = await win.evaluate(([a, b]) => window.ilf.media.importAsProject([a, b]), [a, b])
  console.log('IMPORT took', (Date.now() - t0) / 1000, 's, id', id)
  await win.evaluate((id) => { location.hash = '/editor/' + encodeURIComponent(id) }, id)
  await win.waitForTimeout(3500)
  const p = await win.evaluate(async (id) => {
    const p = await window.ilf.projects.load(id)
    return { name: p.name, imported: p.imported, duration: p.duration, sources: (p.sources || []).map((s) => ({ name: s.name, duration: s.duration, w: s.width, h: s.height, audio: s.hasAudio })), screenAudio: p.screenAudio }
  }, id)
  console.log('PROJECT', JSON.stringify(p))
  // add a title with T at 1s, then type into it
  await win.evaluate(() => window.__ilfPlayer.seek(1))
  await win.waitForTimeout(300)
  await win.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {})
  await win.keyboard.press('t')
  await win.waitForTimeout(500)
  const ta = win.locator('textarea').first()
  await ta.fill('Hello from iloveframes')
  await win.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {})
  await win.evaluate(() => window.__ilfPlayer.seek(2))
  await win.waitForTimeout(800)
  await win.screenshot({ path: path.join(out, 'vproj-editor.png') })
  await win.waitForTimeout(1200) // autosave
  const saved = await win.evaluate(async (id) => {
    const p = await window.ilf.projects.load(id)
    return { clips: p.edit.clips.length, texts: p.edit.texts }
  }, id)
  console.log('SAVED', JSON.stringify(saved))
  // export
  await win.getByRole('button', { name: 'Export' }).first().click()
  await win.waitForTimeout(500)
  await win.getByRole('button', { name: /Export MP4/ }).click()
  await win.getByText('Your video is ready').waitFor({ timeout: 180000 }).catch(async (e) => { await win.screenshot({ path: path.join(out, 'vproj-export-fail.png') }); throw e })
  await win.screenshot({ path: path.join(out, 'vproj-done.png') })
  const exported = fs.readdirSync(process.env.ILF_EXPORT_DIR).filter((f) => f.endsWith('.mp4')).map((f) => path.join(process.env.ILF_EXPORT_DIR, f)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0]
  console.log('EXPORTED', exported)
  execFileSync(ff, ['-y', '-ss', '2', '-i', exported, '-frames:v', '1', path.join(out, 'vproj-frame-2s.png')])
  execFileSync(ff, ['-y', '-ss', '5.5', '-i', exported, '-frames:v', '1', path.join(out, 'vproj-frame-5s.png')])
  let probe = ''
  try { execFileSync(ff, ['-i', exported]) } catch (e) { probe = String(e.stderr) }
  console.log('PROBE', (probe.match(/Duration: [^,]+|Stream[^\n]+/g) || []).join(' | '))
}

// crash safety: start a real take, kill the app hard mid-recording (run `recovercheck` next)
module.exports.crashrec = async (app, win, out) => {
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micEnabled', 'false'); localStorage.setItem('ilf.captureMode', '"full"'); location.reload() }).catch(() => {})
  await win.waitForTimeout(3500)
  await win.getByText('Start recording').click()
  await win.waitForTimeout(6000)
  console.log('KILLING app pid', app.process().pid)
  require('child_process').execSync(`taskkill /F /PID ${app.process().pid}`)
  await new Promise((r) => setTimeout(r, 1500))
  process.exit(0)
}
module.exports.recovercheck = async (app, win, out) => {
  await win.waitForTimeout(9000)
  const list = await win.evaluate(() => window.ilf.projects.list())
  const hit = list.find((p) => /\(recovered\)/.test(p.name))
  console.log('RECOVERED', hit ? JSON.stringify({ name: hit.name, duration: hit.duration }) : 'none', 'of', list.length)
  if (hit) {
    const p = await win.evaluate((id) => window.ilf.projects.load(id), hit.id)
    console.log('RECOVERED DETAIL', JSON.stringify({ file: p.screenFile, cursor: p.events.cursor.length, recovered: p.recovered }))
  }
  await win.screenshot({ path: path.join(out, 'recovered-home.png') })
}

// normal take, no mouse automation: record ~4 s, stop, land in the editor with a saved project
module.exports.recordquick = async (app, win, out) => {
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micEnabled', 'false'); localStorage.setItem('ilf.captureMode', '"full"'); location.reload() }).catch(() => {})
  await win.waitForTimeout(3500)
  await win.screenshot({ path: path.join(out, 'home-110.png') })
  await win.getByText('Start recording').click()
  await win.waitForTimeout(4500)
  await win.evaluate(() => window.ilf.rec.requestStop())
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000)
    if ((await win.evaluate(() => location.hash)).includes('editor')) break
  }
  await win.waitForTimeout(3000)
  const info = await win.evaluate(async () => {
    const id = decodeURIComponent(location.hash.split('/editor/')[1])
    const p = await window.ilf.projects.load(id)
    return { id, file: p.screenFile, duration: p.duration, cursor: p.events.cursor.length, engine: p.engine, texts: p.edit?.texts?.length }
  })
  console.log('PROJECT', JSON.stringify(info))
  const fs = require('fs')
  console.log('FILES', fs.readdirSync(info.id ? require('path').join(require('os').homedir(), 'Videos', 'iloveframes', info.id) : '.').join(','))
  await win.screenshot({ path: path.join(out, 'editor-110.png') })
}

// control bar look: start a take, screenshot the bar window with transparency, stop + discard
module.exports.controlbar = async (app, win, out) => {
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micEnabled', 'false'); localStorage.setItem('ilf.captureMode', '"full"'); location.reload() }).catch(() => {})
  await win.waitForTimeout(3500)
  await win.getByText('Start recording').click()
  let bar = null
  for (let i = 0; i < 40 && !bar; i++) {
    await win.waitForTimeout(250)
    bar = app.windows().find((w) => w.url().includes('controlbar'))
  }
  await bar.waitForTimeout(1200)
  const size = await bar.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }))
  console.log('BAR', JSON.stringify(size))
  await bar.screenshot({ path: path.join(out, 'controlbar.png'), omitBackground: true })
  await win.evaluate(() => window.ilf.rec.cancel())
  await win.waitForTimeout(2500)
}

// real OS click on the control bar's Stop button (checks click-through doesn't swallow it)
module.exports.barclick = async (app, win, out) => {
  await win.evaluate(() => { localStorage.setItem('ilf.countdown', '"0"'); localStorage.setItem('ilf.camOn', 'false'); localStorage.setItem('ilf.micEnabled', 'false'); localStorage.setItem('ilf.captureMode', '"full"'); location.reload() }).catch(() => {})
  await win.waitForTimeout(3500)
  await win.getByText('Start recording').click()
  await win.waitForTimeout(2500)
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), b: w.getBounds() })).find((x) => x.url.includes('controlbar')).b)
  const stop = await app.windows().find((w) => w.url().includes('controlbar')).evaluate(() => { const r = [...document.querySelectorAll('button')][0].getBoundingClientRect(); const z = 1; return { x: (r.left + r.width / 2) * z, y: (r.top + r.height / 2) * z } })
  const sx = Math.round(b.x + stop.x), sy = Math.round(b.y + stop.y)
  console.log('BOUNDS', JSON.stringify(b), 'STOP AT', sx, sy)
  require('child_process').execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'click.ps1'), String(sx), String(sy)])
  for (let i = 0; i < 40; i++) {
    await win.waitForTimeout(1000)
    if ((await win.evaluate(() => location.hash)).includes('editor')) break
  }
  const hash = await win.evaluate(() => location.hash)
  console.log('AFTER CLICK', hash.includes('editor') ? 'STOPPED -> editor' : 'still recording: ' + hash)
  if (!hash.includes('editor')) await win.evaluate(() => window.ilf.rec.cancel())
  else { const id = decodeURIComponent(hash.split('/editor/')[1]); await win.evaluate(() => { location.hash = '/' }); await win.waitForTimeout(800); await win.evaluate((id) => window.ilf.projects.remove(id), id) }
}
