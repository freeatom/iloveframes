export type Vec = { x: number; y: number }

export interface ZoomSegment {
  id: string
  start: number
  end: number
  scale: number
  /** follow the cursor, or lock onto a fixed point (x,y normalized) */
  follow: boolean
  x: number
  y: number
  auto?: boolean
}

export type BackgroundKind = 'wallpaper' | 'gradient' | 'solid' | 'image'
export type Aspect = 'auto' | '16:9' | '9:16' | '1:1' | '4:3' | '4:5'
export type CursorStyle = 'auto' | 'mac' | 'light' | 'dot' | 'ring'
export type CamPos = 'br' | 'bl' | 'tr' | 'tl'
export type DeviceKind = 'none' | 'macbook' | 'laptop'
export type DeviceColor = 'dark' | 'light'

export interface SfxSetting {
  enabled: boolean
  id: string
  volume: number
}

/** A user sound placed on the timeline. */
export interface AudioClip {
  id: string
  name: string
  src: string
  /** timeline position (s) */
  start: number
  /** trim-in inside the source file (s) */
  offset: number
  /** played length (s) */
  duration: number
  /** full length of the source file (s) */
  sourceDuration: number
  volume: number
}

/** Tracking data that came with an iloveframes recording (cursor, clicks, keys). */
export interface SourceTrack {
  events: ProjectEvents
  display: { width: number; height: number; scaleFactor: number }
  cursorBaked: boolean
}

/** A video file usable as a clip source (besides the main recording). */
export interface MediaSource {
  id: string
  name: string
  file: string
  duration: number
  width: number
  height: number
  hasAudio: boolean
  /** set when the file is an iloveframes recording: smart zoom + cursor work on it */
  recId?: string
  track?: SourceTrack
  /** that recording's webcam, if it had one */
  camera?: { file: string; offset: number } | null
}

export type TransitionKind = 'fade' | 'blur' | 'zoom' | 'push' | 'wipe' | 'dip'
export interface Transition {
  kind: TransitionKind
  duration: number
}

/** One clip in the edited sequence: a range [in, out) of a source. */
export interface SeqClip {
  id: string
  source: string
  in: number
  out: number
  /** transition from the previous clip into this one */
  tIn?: Transition
  /** loudness of this clip's own sound (0..2, default 1) */
  volume?: number
}

export type TextStyle = 'title' | 'subtitle' | 'caption' | 'lower' | 'badge'
export type TextAnim = 'fade' | 'rise' | 'pop' | 'type' | 'none'
export type TextBg = 'none' | 'shadow' | 'pill' | 'box'

/** A text overlay (title, caption, lower third...) placed on the timeline. */
export interface TextOverlay {
  id: string
  start: number
  end: number
  text: string
  style: TextStyle
  /** anchor position as fractions of the output frame */
  x: number
  y: number
  /** size multiplier on the style's base size */
  size: number
  color: string
  bg: TextBg
  anim: TextAnim
}

export interface EditState {
  background: { kind: BackgroundKind; value: string; blur: number }
  padding: number
  radius: number
  shadow: number
  inset: boolean
  /** show the recording on a laptop (no logos) */
  device?: { kind: DeviceKind; color: DeviceColor }
  aspect: Aspect
  cursor: {
    enabled: boolean
    style: CursorStyle
    size: number
    smoothing: number
    clickEffect: 'ripple' | 'pulse' | 'none'
    hideIdle: boolean
    /** fade the cursor out while typing, back in when the mouse moves */
    hideTyping: boolean
    hidden: { id: string; start: number; end: number }[]
  }
  zoom: {
    segments: ZoomSegment[]
    speed: 'slow' | 'normal' | 'fast'
    followSmoothness: number
  }
  camera: {
    enabled: boolean
    shape: 'circle' | 'rounded' | 'portrait'
    size: number
    position: CamPos
    mirror: boolean
    border: boolean
    shrinkOnZoom: boolean
  }
  audio: { micVolume: number; muted: boolean; clips: AudioClip[] }
  sfx: {
    click: SfxSetting
    zoom: SfxSetting
    typing: SfxSetting
  }
  /** the edited sequence: clips played back to back */
  clips: SeqClip[]
  /** non-destructive crop per source (fractions of the source frame); missing = whole frame */
  crops?: Record<string, CropRect>
  /** titles, captions and labels drawn over the video */
  texts: TextOverlay[]
}

/** Part of a source frame to show, as fractions (0..1). */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ProjectEvents {
  cursor: [number, number, number][]
  /** OS cursor shape changes: [t, 'arrow' | 'hand' | 'text'] */
  cursorTypes?: [number, string][]
  clicks: [number, number, number, number][]
  keys: number[]
}

export interface Project {
  id: string
  name: string
  createdAt: number
  mode: 'auto' | 'manual'
  engine: 'native' | 'browser'
  cursorBaked: boolean
  display: { width: number; height: number; scaleFactor: number }
  duration: number
  camera: { file: string; offset: number } | null
  mic: { file: string; offset: number } | null
  events: ProjectEvents
  edit: EditState | null
  dir: string
  /** extra imported videos usable as clips */
  sources?: MediaSource[]
  /** true when screen.mp4 carries its own audio (imported-video projects) */
  screenAudio?: boolean
  /** file name of the main recording (ilfsrec_NNN.mp4); older projects use screen.mp4 */
  screenFile?: string
  recId?: string
  /** made from the user's own videos (not a screen recording) */
  imported?: boolean
  /** original file name of the first video in a video project */
  mainName?: string
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  duration: number
  mode: 'auto' | 'manual'
  dir: string
  thumb: string | null
}

export const mediaUrl = (abs: string) => 'ilf://media/' + encodeURIComponent(abs)
export const projectFile = (p: { dir: string }, f: string) => mediaUrl(p.dir.replace(/[\\/]+$/, '') + (p.dir.includes('\\') ? '\\' : '/') + f)

export function defaultEdit(p: Pick<Project, 'cursorBaked' | 'camera' | 'duration'> & { mode?: 'auto' | 'manual' }): EditState {
  return {
    background: { kind: 'wallpaper', value: 'iris', blur: 0 },
    padding: 0.08,
    radius: 18,
    shadow: 0.7,
    inset: true,
    device: { kind: 'none', color: 'dark' },
    aspect: '16:9',
    cursor: {
      enabled: !p.cursorBaked,
      style: 'auto',
      size: 1.6,
      smoothing: 0.5,
      clickEffect: 'ripple',
      hideIdle: true,
      hideTyping: true,
      hidden: []
    },
    zoom: { segments: [], speed: 'normal', followSmoothness: 0.55 },
    camera: { enabled: !!p.camera, shape: 'circle', size: 0.24, position: 'br', mirror: true, border: true, shrinkOnZoom: true },
    audio: { micVolume: 1, muted: false, clips: [] },
    sfx: {
      click: { enabled: true, id: 'soft', volume: 0.6 },
      zoom: { enabled: false, id: 'deep', volume: 0.4 },
      typing: { enabled: true, id: 'thock', volume: 0.35 }
    },
    clips: [{ id: 'c-main', source: 'main', in: 0, out: p.duration }],
    texts: []
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10)

/** Bring older saved projects up to the current shape. */
export function migrateEdit(p: Project, e: any): EditState {
  const d = defaultEdit(p)
  const old = e ?? {}
  const sfx = old.sfx ?? {
    click: { enabled: old.cursor?.clickSound ?? true, id: old.cursor?.sound ?? 'soft', volume: old.cursor?.volume ?? 0.6 },
    zoom: { enabled: !!old.zoom?.whoosh, id: 'whoosh', volume: 0.4 },
    typing: d.sfx.typing
  }
  return {
    ...d,
    ...old,
    cursor: { ...d.cursor, ...old.cursor, style: old.cursor?.style === 'dot' ? 'auto' : old.cursor?.style ?? d.cursor.style, hidden: old.cursor?.hidden ?? [] },
    zoom: { ...d.zoom, ...old.zoom },
    camera: { ...d.camera, ...old.camera },
    device: { ...d.device!, ...old.device },
    audio: { ...d.audio, ...old.audio, clips: old.audio?.clips ?? [] },
    clips: old.clips?.length ? old.clips : [{ id: 'c-main', source: 'main', in: old.trim?.start ?? 0, out: old.trim?.end ?? p.duration }],
    crops: old.crops ?? {},
    texts: Array.isArray(old.texts) ? old.texts : [],
    sfx: { click: { ...d.sfx.click, ...sfx.click }, zoom: { ...d.sfx.zoom, ...sfx.zoom }, typing: { ...d.sfx.typing, ...sfx.typing } }
  }
}
