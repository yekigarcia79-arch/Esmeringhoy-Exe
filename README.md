# Esmeringhoy — desktop

A standalone Windows music player: **Rust** owns the audio (download →
Symphonia decode → cpal output) and **WebView2** renders the interface,
ported from the open-source web player. It talks to the existing
`esmeringhoy.pages.dev` backend over HTTPS — the web player's server and
D1 database are the source of truth for accounts, playlists, taste, the
queue and lyrics.

This repository is the desktop app **only**. The web player and its API
server live in a separate repository (`Esmeringhoy-main`, deployed to
`esmeringhoy.pages.dev`).

## Status

| Area | State |
|---|---|
| Rust audio engine (download → decode → cpal, LRU cache, seek, end-of-track cascade) | Built; engine flow verified end-to-end against local backend |
| Direct InnerTube resolution from this machine (Workers egress is bot-flagged; home egress is not) | Built & live-tested (itag 140, OK) |
| IPC bridge (all API calls route through Rust; token in Windows Credential Manager) | Built & verified |
| Password sign-in / register / silent relaunch / sign-out | Built & verified against a local backend |
| Full web UI port (home, search, mix, playlists, queue, lyrics, art/album pages, import) | Ported; module + DOM verified error-free in Chromium |
| Video mode (muted `<video>` slaved to the engine clock) | Ported; **not yet field-tested** |
| NSIS + MSI installers, clean-machine install test | **Not built yet** (`tauri build` not run) |
| Resume points, tray minimize, auto-update | Not built yet |

## Requirements

- Windows 10/11 with **WebView2 Runtime** (preinstalled on Windows 11; the
  installers bundle a bootstrapper)
- **Rust** (stable) — `rustup`
- **Visual Studio 2022** with the **"Desktop development with C++"**
  workload + Windows 10/11 SDK (linker + libs; `cargo build` needs them)
- Node.js 20+ (only for the Tauri CLI, not for the app itself)

## Run (development)

```powershell
# 1. Backend must be reachable. For a local backend:
cd ..\Esmeringhoy-main
npm start                 # http://127.0.0.1:8788  (local D1)

# 2. Point the app at it (defaults to https://esmeringhoy.pages.dev)
cd ..\"Esmeringhoy Application"\desktop
$env:ESM_API_BASE = "http://127.0.0.1:8788"
npm run dev               # cargo run + the WebView window
```

Without `ESM_API_BASE`, the app talks to the production backend
(`https://esmeringhoy.pages.dev`).

## Backend deployment (required once)

The desktop is a **first-party client authenticated by the session token**
(`login { token: true }` → `Authorization: Bearer …`). The backend was
adapted to accept session bearers everywhere, and the stream relay gained an
`?codec=aac` preference (Symphonia has no Opus decoder; itag 140 AAC is used
instead). **None of that is live until the backend changes are deployed.**

Files changed in `Esmeringhoy-main` (already edited in this environment):

- `functions/api/[[path]].js` — accept session bearers; `?codec=aac`;
  signed-URL minting remembers the codec choice
- `functions/_lib/stream.js` — `preferOpus` plumbing + separate cache keys
- `functions/_lib/keys.js` — signed stream URLs carry the codec claim
- `test-auth.mjs` — regression coverage for the bearer gate (35/35 green)

Deploy either way:

```powershell
# A. push Esmeringhoy-main to its GitHub repo — your existing CI redeploys
# B. or direct-upload with wrangler:
cd Esmeringhoy-main
npx wrangler login   # once
npm run deploy
```

Until that deploy happens, production refuses desktop API calls (401) and
serves only Opus audio the engine cannot decode.

## Verify

```powershell
cd "Esmeringhoy Application"\desktop\src-tauri
cargo test              # cache LRU eviction unit tests
cargo check             # zero-warning build
```

## Architecture

```
Esmeringhoy Application/
├── public/                 the UI — ported from the web player (same mono design)
│   ├── index.html          shell (gate/captcha removed; password-only auth)
│   ├── css/styles.css
│   └── js/app.js           all network over IPC via netFetch(); Rust owns audio
└── desktop/src-tauri/
    ├── tauri.conf.json     window, CSP, bundle (nsis + msi)
    ├── capabilities/       permissions
    └── src/
        ├── main.rs         app setup, plugin-free
        ├── commands.rs     the IPC surface (auth_*, engine_*, api_call, web_log)
        ├── api.rs          reqwest client; token never reaches the webview
        ├── keystore.rs     Windows Credential Manager
        ├── youtube.rs      Direct InnerTube resolution (visitorData + VISIONOS itag 140/139)
        ├── cache.rs        1 GB LRU track cache (%LOCALAPPDATA%\dev.esmeringhoy.desktop\cache)
        ├── engine/player.rs download → Symphonia decode → cpal output;
        │                   end-of-track → POST /api/cmd "ended" (server cascade)
        └── state.rs        AppState, persisted volume
```

Design rules:

- **The server decides what plays next** (queue → repeat-all → radio); the
  desktop only renders the snapshot and plays the bytes.
- **Last click wins, always** — a track requested while another is loading
  waits in the pending slot and supersedes it when it settles; clicks are
  never dropped and never error.
- **Streams resolve from this machine** — YouTube answers Cloudflare Workers'
  datacenter IPs with `playabilityStatus=LOGIN_REQUIRED`, so audio is
  resolved directly (`youtube.rs`) and downloads go Google → this machine.
  The backend relay (`/api/stream?codec=aac`) is the fallback.
- **Downloads are ranged in 1 MiB chunks** — Google paces the byte-0 stream
  to playback rate, but `Range` requests from later offsets are served full
  speed; a track fetches in under a second instead of timing out at ~1 MB.
- **Tracks are cached locally** (~1 GB LRU) — seeks are file seeks, replays
  are offline.
- **All `/api` traffic goes through Rust**; the webview never sees the
  token, and `<video>` uses a single-video, 5-minute signed URL.
- The desktop is its **own device** ("a device is a login"), so its queue
  and history never collide with your browser's.

## Known limitations / honest caveats

- **Video mode not field-tested** — the 1080p relay through `<video>` may
  need tuning (reopen logic, drift correction are ported verbatim).
- **No code signing** — Windows SmartScreen will warn until an EV cert is
  added to `bundle.windows` (thumbprint) in `tauri.conf.json`.
- **Registration** on the shared backend is `open` — flip it to `invite`
  (and later `closed`) in `wrangler.toml` once your accounts exist.
- **4 GB/day per-account streaming budget is shared** with the web app;
  video burns it ~30× faster than audio.
- YouTube streams are served for personal use; publishing or redistributing
  them is your call (see the web repo's README).

## Git

This repository is fresh. First commit is on `main`; releases are tagged
`v*` and built by `.github/workflows/desktop.yml`.
