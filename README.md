# iloveframes

Beautiful product walkthrough recordings for Windows and macOS: cursor-free capture, smooth auto-zoom, cinematic cursor, premium backgrounds, multi-clip editing and fast MP4/GIF export.

## Develop
```bash
npm install
npm run dev
```

## Build installers
- **Windows** (on Windows): `npm run dist:win` → `release/<version>/iloveframes-<version>-Setup.exe` and `-Portable.exe`
- **macOS** (needs a Mac): push this repo to GitHub, open **Actions → Build macOS → Run workflow**, download the `.dmg`/`.zip` artifacts. Or run `npm run dist:mac` on a Mac.

## Before shipping
Edit `src/main/config.ts`:
- `dodoEnv` – `'live'` for real customers (`'test'` while testing with test-mode keys)
- `dodoProductId` – optional, only accept keys for your iloveframes product
- `buyUrl` – your Dodo checkout / payment link
- `updateUrl` – where `latest.json` will be hosted

## Ship an update (OTA)
1. Bump `version` in `package.json`.
2. Build Windows (`npm run dist:win`) and macOS (GitHub Action), put the Mac `.zip` files into `release/<version>/`.
3. `npm run release -- --notes "What's new"` → writes a signed `release/<version>/latest.json`.
4. Upload `latest.json` to `updateUrl` and the installers to the folder printed by the script.

Installed apps check every 4 hours, download in the background, verify the Ed25519 signature + SHA-512, then install on restart.

**Keep `keys/update-private.pem` secret and backed up.** Without it you can't sign updates; if it leaks, someone could sign one.

## Platform code (Windows vs macOS)
One codebase, two platforms. About 95% of the app is shared; everything that differs sits behind one interface so the two builds never drift apart.

| Area | Windows | macOS | Shared |
|---|---|---|---|
| OS plumbing (capture devices, cursor watcher, machine id, licence mirror, update install) | `src/main/platform/win.ts` | `src/main/platform/mac.ts` | contract in `src/main/platform/types.ts`, picked in `platform/index.ts` |
| Cursor-shape helper | `resources/native/cursor-win.ps1` | `resources/native/cursor-mac.js` | |
| Screen capture backend | ffmpeg `ddagrab` / `gdigrab` | ffmpeg `avfoundation` | `src/main/recorder.ts`, `src/main/ffmpeg.ts` |
| Installer | NSIS `.exe` + portable `.exe` (`electron-builder.yml` → `win`, `nsis`, `portable`) | `.dmg` + `.zip`, ad-hoc signed (`mac`, `dmg`, `scripts/adhoc-sign.cjs`) | |
| CI build | `.github/workflows/build-windows.yml` | `.github/workflows/build-mac.yml` | |
| In-app update asset | `win` (Setup.exe, run silently) | `mac-arm64` / `mac-x64` (.zip, bundle swap) | signed `latest.json`, `src/main/updater.ts` |

Editor, engine, UI, licensing, recording data and export (`src/renderer`, `src/main/index.ts`, `src/main/license.ts`, `src/main/ilfdata.ts`) are identical on both.

Releases: every version is tagged `vX.Y.Z` and has a GitHub Release with the Windows and macOS files grouped separately.

## Video projects (bring your own videos)
Home → **Video project** (or drop video files anywhere on the Home window). Every video becomes a clip on the timeline in the order picked. H.264/AAC files (most phone, screen and web videos) are repackaged losslessly in seconds; anything else (HEVC, ProRes, MPEG-4, rotated phone clips) is converted to H.264 once. iloveframes recordings keep their smart-zoom data. Editing: trim / split / reorder, transitions, per-clip volume, crop, backgrounds, music and **text** (title, subtitle, caption, lower third, badge; T adds a title at the playhead), all rendered into the export.

## Crash safety and monitoring
- The screen is captured as fragmented MP4 with tracking data snapshots every 4 s (`rec.json` + `events.json` in the take folder). If the app or machine dies mid-take, the next launch stops any orphaned ffmpeg, then rebuilds the take as "… (recovered)".
- `userData/run.json` marks a running session; if it is still there at the next launch, an `unclean_exit` is reported.
- Anonymous telemetry (Pulse app `293a040b4d17`) reports lifecycle and failures: `recording_failed` (with stage), `capture_died`, `capture_fallback`, `recording_recovered` / `recording_lost`, `unclean_exit`, `perm_missing`, `video_project_created`, `video_import_failed`, renderer errors with the screen they happened on. Every event carries an `eid` so retried batches are de-duplicated.
- Pulse → iloveframes app → **Health** shows recording success, crash-free launches, Mac input detection, per-version health and the latest problems; **Status** / Health also list the uptime monitors (site, update feed, installers, pricing, buy link) that run every 10 minutes and alert via ntfy.

## macOS notes
- Clicks and keystrokes on macOS come from `resources/native/cursor-mac.js` (osascript, reads the window server's "seconds since last event" counters). No Accessibility permission, no in-process global hook (libuiohook's keyboard path could abort the app on recent macOS). Windows still uses uiohook-napi.
- Only Screen Recording permission is needed. The Home banner opens the right Settings pane and restarts the app (macOS applies the permission only after a restart).
- The app offers to move itself to /Applications (running from the DMG or Downloads breaks updates and permissions).
- Signing: with repo secrets `MAC_CERT_P12` + `MAC_CERT_PASSWORD` (the self-signed identity in `keys/mac-signing.p12`, password in `keys/mac-signing-password.txt`, both gitignored), every build is signed by the same key so macOS keeps permissions across updates. Without the secrets builds are ad-hoc signed.
- CI (`build-mac.yml`) smoke-tests every Mac build: signature, the click/key helper starts, and the packaged app launches with `ILF_SMOKE=1` (prints `ILF_SMOKE_OK` with ffmpeg / screen device / VideoToolbox checks; telemetry is off in this mode).

## macOS first launch
The app is ad-hoc signed (no Apple Developer certificate). First launch: right-click the app → **Open**, or System Settings → Privacy & Security → **Open Anyway**. Then allow **Screen Recording** when asked and restart the app once (macOS applies it after a restart). Accessibility is no longer needed.
