# Esmeringhoy

A standalone music player for Windows. It is the desktop version of the
Esmeringhoy web player: same catalogue, same account, same queue — but it runs
as its own program, with no browser tab and no Electron shell. Rust owns the
audio, WebView2 draws the interface.

The app talks to `esmeringhoy.pages.dev`, which stays the source of truth for
accounts, playlists, taste, the queue and lyrics. The desktop is registered as
its own device, so its queue and history never collide with the browser's.

## What it does

- Search, home picks, your mix, playlists, queue, lyrics, artist and album pages.
- Streams audio through the local machine, with a cache that makes replays
  instant and works offline.
- Video mode: for tracks that have a music video, the picture plays muted
  against the audio clock.
- Frameless window, 1180×740, rounded corners, fixed size. Fullscreen from the
  title bar.
- Queue keeps itself topped up — five more tracks are added when it runs low,
  so playback does not stop between songs.

## Install

Two installers are produced from the same build:

| Installer | Scope | Location |
|---|---|---|
| `Esmeringhoy_<version>_x64-setup.exe` (NSIS) | current user, no admin | `%LOCALAPPDATA%\Esmeringhoy` |
| `Esmeringhoy_<version>_x64_en-US.msi` | all users, needs admin | `Program Files\Esmeringhoy` |

Requirements: Windows 10 or 11, 64-bit, and the WebView2 runtime (preinstalled
on Windows 11; the installer downloads it if it is missing).

The builds are not code-signed, so SmartScreen will warn on first run —
**More info → Run anyway**.

## First run

Sign in with your Esmeringhoy account. If the server allows registration, you
can create one from the same screen. After signing in, pick a few artists for
your mix (or skip it); the app then restores whatever was playing.

## Using it

- `/` focuses the search box. `Space` toggles play/pause. `Esc` closes dialogs.
- The title bar holds minimize, fullscreen and close; drag anywhere on the bar
  to move the window.
- Click your username → **Settings** for playback and storage:
  - **Queue pre-downloading** — when the current track has about 40 seconds left, the next tracks download in the background (2 at a time, in queue order, respecting the cache limit) so continuous playback has no gap. Statuses (**Waiting… / Downloading… / Downloaded / Cached / Failed / Cache full**) show on queue rows.
  - **Discord RPC** — show the track in your own Discord status; works with the built-in Esmeringhoy application, no setup required. The large image switches to each track's own artwork as songs change.
  - cache limit: **5 GB** (default) or **10 GB**
  - how much is used and how many tracks are cached
  - **Clear cache** — playback keeps going; the track that is playing stays.

## Storage

Everything the app writes lives in `%LOCALAPPDATA%\dev.esmeringhoy.desktop`:

```
cache\          one .m4a (AAC) per track, plus index.json
web.log         interface errors, capped
```

The cache is never inside the install folder, so updating or reinstalling does
not touch it. When the chosen limit is reached, the least recently played
tracks are removed first. Clearing the cache does not delete a track that is
currently playing.

## Updating

Run the newer installer over the installed version. Settings and cache are
kept — they live outside the program files. The version shown in
**Settings → Apps → Esmeringhoy** comes from the installer, so use the new
setup rather than replacing the `.exe` by hand.

## Uninstall

**Settings → Apps → Installed apps → Esmeringhoy → Uninstall**, or run
`uninstall.exe` in the install folder. Your settings and cached tracks are
kept unless you tick the "delete application data" box.

## Requirements and limits

- Windows 10/11 x64, WebView2 runtime.
- The Esmeringhoy backend must be reachable for sign-in, search and the queue.
  If it is down, the app says so and keeps retrying.
- Audio comes from YouTube; it is meant for personal listening.
- No automatic updates yet — install the new release when it appears.

## Troubleshooting

**"Server not reachable"** — the backend is down or the connection dropped.
The app retries by itself; if it persists, check `esmeringhoy.pages.dev`.

**A track skips the moment it starts** — the stream could not be resolved.
Play it again; if it keeps happening, the track may be region-locked.

**No sound** — check the volume in the player bar and the output device in
Windows. The engine uses the system default device.

**The shortcut still shows the old icon** — Windows caches icons. Press `F5`
on the desktop, or sign out and back in.

## Development

Rust + Tauri 2. The interface is plain HTML/CSS/JS in `public/`; all network
calls go through Rust, so the session token never reaches the webview.

```powershell
cd desktop
npm install
npx tauri build        # exe + NSIS + MSI in src-tauri\target\release\bundle
```

```powershell
cd desktop\src-tauri
cargo check            # type-check
cargo test             # cache eviction tests
```

Set `ESM_API_BASE` to point the app at a local backend instead of production:

```powershell
$env:ESM_API_BASE = "http://127.0.0.1:8788"
npm run dev
```

The web player and its API server live in a separate repository
(`Esmeringhoy-main`), deployed to `esmeringhoy.pages.dev`.