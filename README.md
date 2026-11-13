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
- **Draggable waveform** — enable it under **Settings → Appearance**, then
  use the waveform button in fullscreen lyrics. Drag the decoded track
  waveform to seek; its playhead follows playback.
- **Discord Rich Presence** — show what's playing in your Discord status,
  with the track artwork and a live progress bar.
- **Dynamic Island** — an always-on-top now-playing pill at the top-center of
  the screen. It stays hidden until you move the cursor over it, then shows
  the artwork, a draggable seek bar, previous/play/next and volume. Switch it
  off from the tray menu; it is on by default.
- **In-app updates** — checks GitHub Releases shortly after launch, downloads
  with pause and resume, verifies the package and installs it silently. See
  [Updating](#updating).
- **Native window** — frameless, rounded corners, fixed size, fullscreen from
  the title bar.

## Install

Download the latest build from
[Releases](https://github.com/yekigarcia79-arch/Esmeringhoy-Exe/releases):

| Installer | Scope | Location |
|---|---|---|
| `Esmeringhoy_1.0.2_x64-setup.exe` (NSIS) | Current user, no admin | `%LOCALAPPDATA%\Esmeringhoy` |
| `Esmeringhoy_1.0.2_x64_en-US.msi` | All users, requires admin | `Program Files\Esmeringhoy` |

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
| Show the Dynamic Island | Move the cursor to the top-center of the screen |
| Open the tray menu | Right-click the tray icon |

The tray menu also controls playback (play/pause, previous, next, mute),
Discord RPC, the **Dynamic Island**, lyrics, Settings, and quitting the app.

**Settings** (click your username) covers playback, storage and appearance:

- **Cache limit** — 5 GB (default) or 10 GB, with live usage and track count.
- **Clear cache** — frees space; playback continues and the playing track is
  kept.
- **Draggable audio waveforms** — under **Appearance**, reveal the waveform
  button in fullscreen lyrics. Activating it hides the volume indicator and
  shows the current track's waveform; drag or use the arrow keys to seek.
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
- The Dynamic Island is a second frameless, always-on-top window with no
  taskbar entry. Rust watches the cursor and reveals it only while you are in
  its top-center area, with a short grace period while you use its controls.
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
updates\         downloaded setup packages while an update is in progress
web.log          interface errors, capped
```

## Updating

Open **Settings → General → Check for updates**, or wait for the automatic
check a few seconds after launch. Esmeringhoy downloads the new setup into
`updates\` in the app data folder, verifies it against the SHA-256 digest
published with the GitHub release, installs it silently, and reopens.
Downloads can be paused and resumed, and a partial file continues from the
bytes already saved.

Releases are not Authenticode-signed yet; the update sheet says so and shows
the SHA-256 check instead. Settings and cached tracks are kept throughout.

You can still run a newer setup by hand. Use the new setup rather than
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
| Dynamic Island never appears | It only shows while the cursor is over the top-center of the primary screen, and it can be switched off in the tray menu. |
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
