import { contextBridge, ipcRenderer, webUtils } from 'electron'
import * as pipe from './exportPipe'

const on = (channel: string, cb: (...args: any[]) => void) => {
  const fn = (_e: unknown, ...args: any[]) => cb(...args)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

type Launch = { command: string; args: string[] }
export type AgentStatus = { enabled: boolean; port: number | null; lastCall: { tool: string; at: number } | null; launch: { app: Launch; node: Launch; script: string } }

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  displays: () => ipcRenderer.invoke('displays:list'),
  displayThumbs: (): Promise<Record<string, string>> => ipcRenderer.invoke('displays:thumbs'),
  permStatus: () => ipcRenderer.invoke('perm:status'),
  permRequest: (k: string) => ipcRenderer.invoke('perm:request', k),
  permOpenSettings: (k: 'screen' | 'camera' | 'microphone') => ipcRenderer.invoke('perm:open-settings', k),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onProjectsChanged: (cb: () => void) => on('projects:changed', cb),
  rec: {
    prepare: (o: any) => ipcRenderer.invoke('rec:prepare', o),
    chunk: (kind: string, data: ArrayBuffer) => ipcRenderer.send('rec:chunk', kind, data),
    requestStop: () => ipcRenderer.send('rec:request-stop'),
    cancel: () => ipcRenderer.send('rec:cancel'),
    finalize: (m: any) => ipcRenderer.invoke('rec:finalize', m),
    onStop: (cb: () => void) => on('rec:stop', cb),
    onCancelled: (cb: () => void) => on('rec:cancelled', cb),
    onProcessing: (cb: (msg: string) => void) => on('rec:processing', cb)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    load: (id: string) => ipcRenderer.invoke('project:load', id),
    save: (id: string, patch: any) => ipcRenderer.invoke('project:save', id, patch),
    remove: (id: string) => ipcRenderer.invoke('project:delete', id)
  },
  export: {
    choose: (name: string, ext: string) => ipcRenderer.invoke('export:choose', name, ext),
    start: (o: pipe.StartOptions) => pipe.start(o),
    frame: (token: string, data: ArrayBuffer | Uint8Array) => pipe.frame(token, data),
    audio: (token: string, wav: ArrayBuffer) => pipe.audio(token, wav),
    finish: (token: string, o: { format: 'mp4' | 'gif'; gifWidth?: number; gifFps?: number }) => pipe.finish(token, o),
    cancel: (token: string) => pipe.cancel(token),
    onMuxProgress: (cb: (s: number) => void) => on('export:mux-progress', cb)
  },
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  open: (p: string) => ipcRenderer.invoke('shell:open', p),
  mail: (url: string) => ipcRenderer.invoke('shell:mail', url),
  pickImage: () => ipcRenderer.invoke('file:pick-image'),
  recordings: {
    list: (exceptId?: string) => ipcRenderer.invoke('recordings:list', exceptId)
  },
  media: {
    import: (projectId: string, paths?: string[]): Promise<import('../renderer/src/engine/types').MediaSource[]> => ipcRenderer.invoke('media:import', projectId, paths),
    importAsProject: (paths?: string[]): Promise<string | null> => ipcRenderer.invoke('project:import-video', paths),
    onProgress: (cb: (p: { label: string; p: number } | null) => void) => on('media:progress', cb)
  },
  shot: {
    open: (): Promise<{ dataUrl: string; name: string } | null> => ipcRenderer.invoke('shot:open'),
    load: (path: string): Promise<{ dataUrl: string; name: string } | null> => ipcRenderer.invoke('shot:load', path),
    paste: (): Promise<{ dataUrl: string; name: string } | null> => ipcRenderer.invoke('shot:paste'),
    save: (data: ArrayBuffer, name: string, ext: 'png' | 'jpg'): Promise<string | null> => ipcRenderer.invoke('shot:save', data, name, ext),
    copy: (png: ArrayBuffer) => ipcRenderer.invoke('shot:copy', png)
  },
  updates: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    onState: (cb: (s: any) => void) => on('update:state', cb)
  },
  telemetry: {
    track: (name: string, props?: Record<string, unknown>) => ipcRenderer.send('telemetry:track', name, props),
    get: (): Promise<{ optOut: boolean }> => ipcRenderer.invoke('telemetry:get'),
    set: (optOut: boolean): Promise<{ optOut: boolean }> => ipcRenderer.invoke('telemetry:set', optOut)
  },
  agent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
    setEnabled: (on: boolean): Promise<AgentStatus> => ipcRenderer.invoke('agent:set-enabled', on),
    onCall: (cb: (c: { id: string; tool: string; args: any }) => void) => on('agent:call', cb),
    onActivity: (cb: (a: { tool: string; at: number }) => void) => on('agent:activity', cb),
    result: (id: string, r: unknown) => ipcRenderer.send('agent:result', id, r),
    exportTarget: (ext: 'mp4' | 'gif'): Promise<string> => ipcRenderer.invoke('agent:export-target', ext)
  },
  license: {
    status: () => ipcRenderer.invoke('license:status'),
    activate: (key: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('license:activate', key, name),
    deactivate: (): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('license:deactivate'),
    setName: (name: string) => ipcRenderer.invoke('license:set-name', name),
    buy: () => ipcRenderer.invoke('license:buy'),
    onChange: (cb: (s: any) => void) => on('license:changed', cb)
  },
  sounds: {
    list: (): Promise<{ id: string; name: string; file: string; duration: number }[]> => ipcRenderer.invoke('sounds:list'),
    import: (paths?: string[]): Promise<{ id: string; name: string; file: string; duration: number }[]> => ipcRenderer.invoke('sounds:import', paths),
    remove: (id: string) => ipcRenderer.invoke('sounds:remove', id)
  },
  feedback: (f: { kind: string; message: string; email: string; name: string }): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('feedback:send', f),
  area: {
    /** open the area picker on a display; resolves to the area (DIPs, relative to the display) or null */
    pick: (displayId: string, current?: { x: number; y: number; w: number; h: number } | null): Promise<{ x: number; y: number; w: number; h: number; W: number; H: number } | null> => ipcRenderer.invoke('area:pick', displayId, current),
    done: (area: { x: number; y: number; w: number; h: number } | null) => ipcRenderer.send('area:done', area)
  },
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  wallpapers: {
    list: (): Promise<{ id: string; name: string; group: string; file: string; thumb: string; width: number; height: number; url?: string; thumbUrl?: string }[]> => ipcRenderer.invoke('wallpapers:list'),
    import: (group?: string, paths?: string[], names?: Record<string, string>) => ipcRenderer.invoke('wallpapers:import', group, paths, names),
    remove: (id: string) => ipcRenderer.invoke('wallpapers:remove', id)
  }
}

contextBridge.exposeInMainWorld('ilf', api)
export type IlfApi = typeof api
