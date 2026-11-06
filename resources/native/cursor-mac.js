// JXA helper for recordings on macOS. Runs in its own process (osascript), so nothing
// here can take the app down. Prints one line per change:
//   arrow | hand | text        the system cursor shape
//   down <button> <agoMs>      a mouse button went down <agoMs> ms ago (1 left, 2 right, 3 other)
//   key <agoMs>                a key was pressed <agoMs> ms ago
//   caps <clicks> <keys>       which detectors work on this Mac (sent once at start)
// Clicks and keys are read from the window server's "seconds since last event" counters,
// which need no Accessibility or Input Monitoring permission, so there is no global
// event hook (the old in-process hook could crash the app on newer macOS).
ObjC.import('AppKit')
ObjC.import('CoreGraphics')
ObjC.import('stdlib')

const out = $.NSFileHandle.fileHandleWithStandardOutput
const emit = (s) => {
  try {
    out.writeData($.NSString.alloc.initWithUTF8String(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  } catch (e) {
    // the app went away: stop
    $.exit(0)
  }
}

function sig(c) {
  try { const h = c.hotSpot, s = c.image.size; return [h.x, h.y, s.width, s.height].join(',') } catch (e) { return '' }
}
const handSig = sig($.NSCursor.pointingHandCursor)
const textSig = sig($.NSCursor.IBeamCursor)

// CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState = 0, type)
const LEFT = 1, RIGHT = 3, OTHER = 25, KEY = 10
function sinceFn() {
  try {
    const v = $.CGEventSourceSecondsSinceLastEventType(0, LEFT)
    if (typeof v === 'number' && isFinite(v)) return (type) => $.CGEventSourceSecondsSinceLastEventType(0, type)
  } catch (e) {}
  return null
}
const since = sinceFn()
let keysOk = false
if (since) {
  try { keysOk = typeof since(KEY) === 'number' } catch (e) {}
}
emit('ready')
emit('caps ' + (since ? 'counter' : 'buttons') + ' ' + (keysOk ? 'counter' : 'none'))

// last seen "seconds since" per event type: when it drops, a new event happened
const last = {}
function fresh(type) {
  let s
  try { s = since(type) } catch (e) { return -1 }
  const prev = last[type]
  last[type] = s
  // first sample only sets the baseline; afterwards a smaller value means a new event
  if (prev === undefined) return -1
  return s + 0.002 < prev ? s : -1
}
if (since) [LEFT, RIGHT, OTHER, KEY].forEach((t) => fresh(t))

let lastShape = ''
let buttons = 0
let tick = 0
while (true) {
  if (since) {
    const l = fresh(LEFT), r = fresh(RIGHT), o = fresh(OTHER)
    if (l >= 0) emit('down 1 ' + Math.round(l * 1000))
    if (r >= 0) emit('down 2 ' + Math.round(r * 1000))
    if (o >= 0) emit('down 3 ' + Math.round(o * 1000))
    if (keysOk) {
      const k = fresh(KEY)
      if (k >= 0) emit('key ' + Math.round(k * 1000))
    }
  } else {
    // fallback: watch the pressed-buttons mask (misses only the very quickest taps)
    let b = 0
    try { b = Number($.NSEvent.pressedMouseButtons) } catch (e) {}
    if ((b & 1) && !(buttons & 1)) emit('down 1 0')
    if ((b & 2) && !(buttons & 2)) emit('down 2 0')
    buttons = b
  }
  // cursor shape at ~33 Hz, input counters at ~100 Hz
  if (tick++ % 3 === 0) {
    let t = 'arrow'
    try {
      const cur = $.NSCursor.currentSystemCursor
      const s = cur ? sig(cur) : ''
      if (s && s === handSig) t = 'hand'
      else if (s && s === textSig) t = 'text'
    } catch (e) {}
    if (t !== lastShape) { emit(t); lastShape = t }
  }
  delay(0.01)
}
