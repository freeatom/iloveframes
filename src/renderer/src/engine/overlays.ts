import type { EditState, TextOverlay, TextStyle } from './types'
import { uid } from './types'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const FONT = '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif'

/** Look of each preset: base size (fraction of the frame's short side), weight, default spot and backdrop. */
export const TEXT_PRESETS: Record<TextStyle, { label: string; hint: string; size: number; weight: number; x: number; y: number; bg: TextOverlay['bg']; anim: TextOverlay['anim']; text: string; track: number }> = {
  title: { label: 'Title', hint: 'Big and bold, centre stage', size: 0.085, weight: 760, x: 0.5, y: 0.5, bg: 'shadow', anim: 'rise', text: 'Your title', track: -0.02 },
  subtitle: { label: 'Subtitle', hint: 'A softer second line', size: 0.05, weight: 560, x: 0.5, y: 0.6, bg: 'shadow', anim: 'fade', text: 'A short subtitle', track: -0.01 },
  caption: { label: 'Caption', hint: 'Readable words at the bottom', size: 0.042, weight: 620, x: 0.5, y: 0.86, bg: 'box', anim: 'fade', text: 'Say what is happening here', track: 0 },
  lower: { label: 'Lower third', hint: 'Name tag with an accent bar', size: 0.04, weight: 680, x: 0.07, y: 0.8, bg: 'pill', anim: 'rise', text: 'Your name\nWhat you do', track: -0.005 },
  badge: { label: 'Badge', hint: 'Small label in a corner', size: 0.03, weight: 700, x: 0.12, y: 0.1, bg: 'pill', anim: 'pop', text: 'NEW', track: 0.04 }
}

export const TEXT_COLORS = ['#ffffff', '#0b0b10', '#ffd166', '#ff4d8d', '#c084fc', '#5eead4', '#60a5fa']

export function makeText(style: TextStyle, start: number, total: number, len = 3): TextOverlay {
  const p = TEXT_PRESETS[style]
  const s = Math.max(0, Math.min(start, Math.max(0, total - 0.5)))
  return { id: uid(), start: s, end: Math.min(Math.max(total, s + 0.5), s + len), text: p.text, style, x: p.x, y: p.y, size: 1, color: style === 'badge' ? '#ffffff' : '#ffffff', bg: p.bg, anim: p.anim }
}

const IN = 0.4
const OUT = 0.3
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const easeBack = (t: number) => {
  const c = 1.6
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

/** Lines that fit the given width: explicit line breaks first, then word wrap. */
function wrap(ctx: Ctx, text: string, maxW: number) {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = words[0]
    for (const w of words.slice(1)) {
      const test = line + ' ' + w
      if (ctx.measureText(test).width > maxW) {
        out.push(line)
        line = w
      } else line = test
    }
    out.push(line)
  }
  return out.slice(0, 8)
}

function luminance(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 1
  const n = parseInt(m[1], 16)
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
}

/** Draw one overlay at sequence time T (no-op outside its range). */
export function paintText(ctx: Ctx, W: number, H: number, T: number, o: TextOverlay) {
  if (T < o.start || T >= o.end || !o.text.trim()) return
  const p = TEXT_PRESETS[o.style] ?? TEXT_PRESETS.caption
  const len = o.end - o.start
  const local = T - o.start
  const kin = o.anim === 'none' ? 1 : Math.min(1, local / Math.min(IN, len / 3))
  const kout = o.anim === 'none' ? 1 : Math.min(1, (o.end - T) / Math.min(OUT, len / 3))
  const k = Math.min(kin, kout)
  if (k <= 0) return
  const short = Math.min(W, H)
  const fs = Math.max(8, p.size * short * Math.max(0.3, Math.min(3, o.size)))
  ctx.save()
  ctx.font = `${p.weight} ${fs}px ${FONT}`
  try {
    ;(ctx as any).letterSpacing = `${p.track * fs}px`
  } catch {}
  ctx.textBaseline = 'middle'
  const left = o.style === 'lower'
  ctx.textAlign = left ? 'left' : 'center'
  let shown = o.text
  if (o.anim === 'type') {
    const chars = [...o.text]
    const dur = Math.min(len * 0.6, Math.max(0.4, chars.length * 0.045))
    shown = chars.slice(0, Math.ceil(chars.length * Math.min(1, local / dur))).join('')
  }
  const maxW = W * (left ? 0.6 : 0.86)
  const lines = wrap(ctx, shown, maxW)
  const full = wrap(ctx, o.text, maxW) // box size stays put while typing
  const lh = fs * 1.22
  const widths = full.map((l) => ctx.measureText(l).width)
  const bw = Math.max(1, ...widths)
  const bh = lh * full.length
  const cx = o.x * W
  const cy = o.y * H
  // animation: alpha plus a small move / scale
  ctx.globalAlpha *= o.anim === 'pop' ? Math.min(1, k * 1.6) : easeOut(k)
  const dy = o.anim === 'rise' ? (1 - easeOut(kin)) * fs * 0.55 : 0
  const sc = o.anim === 'pop' ? 0.82 + 0.18 * easeBack(Math.min(1, kin)) : 1
  ctx.translate(cx, cy + dy)
  if (sc !== 1) ctx.scale(sc, sc)

  const padX = fs * (o.bg === 'box' ? 0.5 : 0.62)
  const padY = fs * (o.bg === 'box' ? 0.28 : 0.3)
  const bx = left ? -padX : -bw / 2 - padX
  const by = -bh / 2 - padY
  const dark = luminance(o.color) < 0.45
  if (o.bg === 'box' || o.bg === 'pill') {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = fs * 0.6
    ctx.shadowOffsetY = fs * 0.12
    ctx.beginPath()
    const r = o.bg === 'pill' ? Math.min(bh / 2 + padY, fs * 0.9) : fs * 0.22
    ctx.roundRect(bx, by, bw + padX * 2, bh + padY * 2, r)
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : o.bg === 'box' ? 'rgba(8,8,12,0.72)' : 'rgba(14,12,22,0.82)'
    ctx.fill()
    ctx.restore()
    if (o.style === 'lower') {
      // accent bar on the left edge
      const g = ctx.createLinearGradient(0, by, 0, by + bh + padY * 2)
      g.addColorStop(0, '#ff4d8d')
      g.addColorStop(1, '#8b5cf6')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.roundRect(bx - fs * 0.32, by, fs * 0.14, bh + padY * 2, fs * 0.07)
      ctx.fill()
    }
  }
  if (o.bg === 'shadow') {
    ctx.shadowColor = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = fs * 0.35
    ctx.shadowOffsetY = fs * 0.06
  }
  ctx.fillStyle = o.color
  lines.forEach((l, i) => {
    const y = -bh / 2 + lh * (i + 0.5)
    // second line of a lower third is the smaller, softer role line
    if (o.style === 'lower' && i > 0) {
      ctx.save()
      ctx.font = `500 ${fs * 0.78}px ${FONT}`
      ctx.globalAlpha *= 0.78
      ctx.fillText(l, 0, y)
      ctx.restore()
    } else ctx.fillText(l, 0, y)
  })
  ctx.restore()
}

/** Every visible overlay at sequence time T, in timeline order. */
export function paintOverlays(ctx: Ctx, W: number, H: number, T: number, edit: EditState) {
  const list = edit.texts
  if (!list?.length) return
  for (const o of list) paintText(ctx, W, H, T, o)
}

/** Make sure the overlay font is ready before frames are rendered (export). */
export async function loadOverlayFonts(edit: EditState) {
  if (!edit.texts?.length || typeof document === 'undefined') return
  try {
    await Promise.all([document.fonts.load(`700 48px ${FONT}`), document.fonts.load(`500 48px ${FONT}`)])
  } catch {}
}
