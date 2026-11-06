<div align="center">

<img src="desktop/src-tauri/icons/icon.png" alt="Esmeringhoy" width="120" height="120">

# Esmeringhoy for Windows

The standalone desktop music player. Same catalogue, same account, same queue
as the web player — running as its own program, with no browser tab and no
Electron shell.

[Main site](https://esmeringhoy.pages.dev) · [Releases](https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases)

</div>

---

## About

Esmeringhoy for Windows is the native companion to the
[Esmeringhoy web player](https://esmeringhoy.pages.dev). Your Esmeringhoy
account, playlists, taste, queue and lyrics are shared between the two — the
desktop registers as its own device, so its queue and history never collide
with the browser's. The server is always the source of truth; the app is a
native shell with a Rust audio engine and a WebView2 interface.

## Features

- **Full library** — search, home picks, your mix, playlists, queue, synced
  lyrics, artist and album pages.
- **Fast, offline-friendly playback** — audio is streamed through the app and
  cached locally, so replays are instant and recent tracks play offline.
- **Queue pre-downloading** — when the current track has about 40 seconds
  left, the next tracks download in the background, in queue order, so
  playback continues without a gap.
- **Download all** — download every track in a playlist in one click; cached
  tracks are marked with a green check.
- **Spotify playlist import** — paste a public Spotify playlist link to turn
  it into an Esmeringhoy playlist, or import an exported CSV. No Spotify
  login required.
- **Video mode** — for tracks with a music video, the picture plays muted
  against the audio clock.
- **Discord Rich Presence** — show what's playing in your Discord status,
  with the track artwork and a live progress bar.
- **Native window** — frameless, rounded corners, fixed size, fullscreen from
  the title bar.

## Install

Download the latest build from
[Releases](https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases):

| Installer | Scope | Location |
|---|---|---|
| `Esmeringhoy_1.0.0_x64-setup.exe` (NSIS) | Current user, no admin | `%LOCALAPPDATA%\Esmeringhoy` |
| `Esmeringhoy_1.0.0_x64_en-US.msi` | All users, requires admin | `Program Files\Esmeringhoy` |
| `Esmeringhoy_1.0.0_portable.exe` | No installation | Runs from any folder |

**Requirements:** Windows 10 or 11 (64-bit) and the WebView2 runtime
(preinstalled on Windows 11; the installer downloads it if missing).

The builds are not code-signed, so Windows SmartScreen may warn on first
run — choose **More info → Run anyway**.

### First run

Sign in with your Esmeringhoy account (or create one if registration is
open). Pick a few artists for your mix, or skip them — the app restores
whatever was playing.

## Using it

| Action | How |
|---|---|
| Focus search | `/` |
| Play / pause | `Space` |
| Close a dialog | `Esc` |
| Move the window | Drag anywhere on the title bar |
| Minimize / fullscreen / close | Title-bar buttons |

**Settings** (click your username) covers playback and storage:

- **Cache limit** — 5 GB (default) or 10 GB, with live usage and track count.
- **Clear cache** — frees space; playback continues and the playing track is
  kept.
- **Discord RPC** — toggle Rich Presence on or off.
- **Check for updates** — see the installed version and check for a release.

## How it works

```
┌──────────────────────── Esmeringhoy.exe ────────────────────────┐
│  Interface (WebView2)        Rust core                           │
│  search · playlists · lyrics │  audio engine (rodio)            │
│  queue · settings            │  cache + pre-downloading         │
│                              │  Discord Rich Presence           │
└───────────────┬──────────────┴───────────────┬──────────────────┘
                └────────── HTTPS ─────────────┘
                          esmeringhoy.pages.dev
```

- The interface is plain HTML/CSS/JS rendered in WebView2.
- All network calls go through Rust, so your session token never reaches the
  webview; it is stored in Windows Credential Manager.
- Audio resolves per track and downloads into the cache; downloads are
  range-based, header-validated, and only committed once complete.
- The cache lives outside the install folder, so updates and reinstalls
  never touch it. At the limit, the least recently played tracks are
  removed first.

## Storage

Everything the app writes lives in `%LOCALAPPDATA%\dev.esmeringhoy.desktop`:

```
settings.json    volume, cache limit, presence settings
cache\           one .m4a (AAC) per track, plus index.json
web.log          interface errors, capped
```

## Updating

Run the newer installer over the installed version. Settings and cache are
kept — they live outside the program files. Use the new setup rather than
replacing the `.exe` by hand, so the version in **Settings → Apps →
Esmeringhoy** stays correct.

## Uninstall

**Settings → Apps → Installed apps → Esmeringhoy → Uninstall**, or run
`uninstall.exe` in the install folder. Settings and cached tracks are kept
unless you tick the "delete application data" box.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "Server not reachable" | The backend is down or the connection dropped. The app retries by itself; check [esmeringhoy.pages.dev](https://esmeringhoy.pages.dev). |
| A track skips when it starts | The stream couldn't be resolved — play it again. If it keeps happening, the track may be region-locked. |
| No sound | Check the volume in the player bar and the default output device in Windows. |
| Old icon on the shortcut | Windows caches icons — press `F5` on the desktop or sign out and back in. |

## Development

Built with Tauri 2 and Rust; the interface lives in `public/`.

```powershell
cd desktop
npm install
npx tauri build        # exe + NSIS + MSI into src-tauri\target\release\bundle

cd desktop\src-tauri
cargo check            # type-check
cargo test             # cache + parser tests
```

The web player and API server live in a separate repository and are deployed
at [esmeringhoy.pages.dev](https://esmeringhoy.pages.dev).
