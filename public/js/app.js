import { parsePlaylistExport } from './spotify.js';

const invoke = (...a) => {
  const t = window.__TAURI__;
  if (!t?.core?.invoke) throw new Error('Tauri IPC unavailable');
  return t.core.invoke(...a);
};
const listen = (...a) => window.__TAURI__?.event?.listen?.(...a) ?? Promise.resolve(() => {});
let API_BASE = '';

window.addEventListener('error', (e) => {
  try { invoke('web_log', { message: `[error] ${e.message} @ ${e.filename}:${e.lineno}` }); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { invoke('web_log', { message: `[rejection] ${e.reason}` }); } catch {}
});

async function netFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  let body = null;
  if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
  let r;
  try {
    r = await invoke('api_call', { method, path, body });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 0 });
  }
  return new Response(JSON.stringify(r?.data ?? {}), {
    status: r?.status ?? 0,
    headers: { 'content-type': 'application/json' },
  });
}

const $ = (sel, root = document) => root.querySelector(sel);

const DEFAULT_SETTINGS = {
  autoUpdateCheck: true,
  ambientArtwork: true,
  reduceMotion: false,
  draggableWaveforms: false,
  discord: {
    enabled: false,
    status: 'Disabled',
  },
};
let settingsState = { ...DEFAULT_SETTINGS, discord: { ...DEFAULT_SETTINGS.discord } };
let settingsTab = 'cache';
let preloadSig = '';
const preloadStatus = new Map();
const downloadedIds = new Set();
let dlAllBusy = false;
const PRELOAD_WINDOW_SECS = 40;

let S = null;
let me = null;
let pollTimer = null;
let viewList = [];
let viewCtx = {};
let plDetail = null;
let artistDetail = null;
let lastRev = -1;
let lastViewSig = '';

// Lyrics survive a source switch. Cycling drops the cached answer server-side,
// so the snapshot that answers the click arrives with nothing in it; holding
// the previous source here means the pane never blanks for a spinner.
let lyricsHold = { videoId: '', data: null };
let lyricsSwitching = false;

// The Lyrics view is a layer of its own, so it needs its own open state, the
// view to return to, and a scrubbing flag for its seek bar.
let lyrFocusOpen = false;
let lyrReturnView = 'home';
let lfScrubbing = false;
let waveformsActive = false;
let waveformCache = new Map();
let waveformTrackId = '';
let waveformLoadingId = '';
let waveformData = [];
let waveformLastDraw = 0;
let lfWaveDragging = false;
let lyrAutoTry = { videoId: '', count: 0 };
let lyrAutoPending = false;

let regMode = 'open';

let CAT = { country: [], global: [], trending: [], countryName: 'Worldwide', ready: false };
let activeTab = 'country';

const VIEW_PATH = {
  home: '/home',
  mix: '/mix',
  playlists: '/playlists',
  queue: '/queue',
  lyrics: '/lyrics',
  now: '/now',
  search: '/search',
  artist: '/artist',
};
const AUTH_PATH = { login: '/login', register: '/register', code: '/code' };

const PATH_VIEW = Object.fromEntries(Object.entries(VIEW_PATH).map(([v, p]) => [p, v]));
const PATH_AUTH = Object.fromEntries(Object.entries(AUTH_PATH).map(([m, p]) => [p, m]));

let authOpen = false;
let routingReady = false;

const trimPath = (p) => '/' + String(p || '').split('/').filter(Boolean).join('/');

const viewForPath = (pathname) => {
  const p = trimPath(pathname);
  if (p.startsWith('/artist/')) return 'artist';
  return PATH_VIEW[p] || null;
};

const artistIdFromPath = (pathname) => {
  const m = /^\/artist\/([A-Za-z0-9_-]{5,40})$/.exec(trimPath(pathname));
  return m ? m[1] : '';
};

const authModeForPath = (pathname) => PATH_AUTH[trimPath(pathname)] || null;

function pathForView(view) {
  if (view === 'artist' && artistDetail?.id) return `/artist/${artistDetail.id}`;
  const p = VIEW_PATH[view] || VIEW_PATH.home;
  return view === 'search' && location.search ? p + location.search : p;
}

function setPath(path, { replace = false } = {}) {
  if (location.pathname + location.search === path) return;
  if (replace) history.replaceState({ path }, '', path);
  else history.pushState({ path }, '', path);
}

function go(view) {
  if (!me) {
    showAuth('login');
    return;
  }
  // Lyrics open as a layer, so remember what was underneath to go back to.
  if (view === 'lyrics' && S?.view && S.view !== 'lyrics') lyrReturnView = S.view;
  setPath(pathForView(view));
  if (!S || S.view !== view) send('setView', { view });
}

window.addEventListener('popstate', () => {
  if (!routingReady) return;

  const mode = authModeForPath(location.pathname);
  if (mode) {
    if (me) {
      setPath(pathForView(S?.view || 'home'), { replace: true });
      return;
    }
    showAuth(mode);
    return;
  }

  const view = viewForPath(location.pathname);
  if (!view) {
    setPath(me ? pathForView(S?.view || 'home') : '/login', { replace: true });
    return;
  }
  if (!me) {
    showAuth('login');
    return;
  }
  if (!S || S.view !== view) send('setView', { view });
});

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function totalDuration(tracks) {
  return (tracks || []).reduce((n, t) => n + (t.durationSec || 0), 0);
}

function letterTile(seed) {
  const c = String(seed || '?').trim().charAt(0).toUpperCase() || '?';
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'>` +
    `<rect width='300' height='300' fill='#141414'/>` +
    `<text x='150' y='196' font-family='Georgia,serif' font-size='132' fill='#6d6d6d' text-anchor='middle'>${c}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const artistThumbs = new Map();
const thumbInflight = new Set();
const thumbQueue = [];
let thumbRunning = 0;
const THUMB_PARALLEL = 3;

async function loadArtistThumb(name) {
  if (artistThumbs.has(name)) return artistThumbs.get(name);
  if (thumbInflight.has(name)) return '';
  thumbInflight.add(name);
  try {
    const url = (await invoke('artist_thumb', { name })) || '';
    if (url) artistThumbs.set(name, url);
    return url;
  } catch {
    return '';
  } finally {
    thumbInflight.delete(name);
  }
}

function pumpThumbs() {
  while (thumbRunning < THUMB_PARALLEL && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbRunning++;
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => { thumbRunning--; pumpThumbs(); });
  }
}

function hydrateArtistThumbs(root) {
  for (const img of root.querySelectorAll('img[data-thumb]')) {
    const name = img.dataset.thumb;
    if (!name) continue;
    if (artistThumbs.has(name)) {
      img.src = artistThumbs.get(name);
      img.removeAttribute('data-thumb');
      continue;
    }
    thumbQueue.push(async () => {
      const url = await loadArtistThumb(name);
      if (url && img.isConnected) {
        img.src = url;
        img.removeAttribute('data-thumb');
      }
    });
  }
  pumpThumbs();
}

const thumbAt = (url, size) =>
  String(url || '').replace(/=w\d+-h\d+/, `=w${size}-h${size}`);

function art(url, seed, cls = '', size = 0, thumbName = '') {
  const src = url ? (size ? thumbAt(url, size) : url) : letterTile(seed);
  const thumb = thumbName ? ` data-thumb="${esc(thumbName)}"` : '';
  return `<img class="${cls}" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async" data-seed="${esc(seed || '')}"${thumb}>`;
}

document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || img.dataset.failed) return;
    img.dataset.failed = '1';
    img.src = letterTile(img.dataset.seed || '');
  },
  true,
);

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let inflight = null;

async function send(cmd, extra = {}, opts = {}) {
  try {
    const res = await netFetch('/api/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, ...extra }),
    });
    if (res.status === 401) {
      signOutLocally();
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    const snap = await res.json();
    if (!opts.silent) apply(snap);
    return snap;
  } catch (e) {
    if (!opts.silent) toast('Server unreachable');
    return null;
  }
}

const SEEK_EMIT_MS = 120;
const SEEK_END_GUARD_SECS = 0.5;
let seekTimer = null;
let seekTarget = null;
let lastSeekErrorAt = 0;

function logSeekError(e) {
  try {
    invoke('web_log', { message: `[seek] ${e}` });
  } catch {}
  const now = Date.now();
  if (now - lastSeekErrorAt > 2000) {
    lastSeekErrorAt = now;
    toast('Could not seek');
  }
}

function queueSeek(secs) {
  seekTarget = Math.max(0, Number(secs) || 0);
  if (seekTimer) return;
  seekTimer = setTimeout(() => {
    const target = seekTarget;
    seekTimer = null;
    seekTarget = null;
    invoke('engine_seek', { secs: target }).catch(logSeekError);
  }, SEEK_EMIT_MS);
}

function flushPendingSeek() {
  if (!seekTimer) return;
  clearTimeout(seekTimer);
  seekTimer = null;
  const target = seekTarget;
  seekTarget = null;
  invoke('engine_seek', { secs: target }).catch(logSeekError);
}

const audio = {
  _pos: 0, _dur: 0, _paused: true, _ended: false,
  _at: 0,
  get currentTime() {
    if (this._paused || !this._at) return this._pos;
    const t = this._pos + (performance.now() - this._at) / 1000;
    return this._dur > 0 ? Math.min(t, this._dur) : t;
  },
  set currentTime(t) {
    this._pos = Math.max(0, Number(t) || 0);
    this._at = performance.now();
    queueSeek(this._pos);
  },
  get duration() { return this._dur; },
  get paused() { return this._paused; },
  get ended() { return this._ended; },
  set volume(v) {
    lastVolumeSent = v;
    invoke('engine_set_volume', { volume: v }).catch(() => {});
  },
  play() { this._paused = false; this._at = performance.now(); return Promise.resolve(); },
  pause() { this._paused = true; return Promise.resolve(); },
  load() {},
  removeAttribute() {},
};

let engineTrackId = '';
let engineSeq = -1;
let pendingSeek = null;
let lastLoadStartedAt = 0;
let lastVolumeSent = NaN;

let enginePlayingId = '';
let engineState = 'idle';
let claimedId = '';
let claimedAt = 0;

function applyVolume(s) {
  const gain = Math.min(1, Number(s.gain) || 1);
  const target = Math.max(0, Math.min(1, (Number(s.volume) || 0) / 100 * gain));
  if (Number.isFinite(lastVolumeSent) && Math.abs(lastVolumeSent - target) < 0.005) return;
  lastVolumeSent = target;
  invoke('engine_set_volume', { volume: target }).catch(() => {});
}

async function loadEngineTrack(track, transport) {
  try {
    lastLoadStartedAt = Date.now();
    await invoke('engine_load', { track });
    if (pendingSeek && pendingSeek.id === track.videoId) {
      const t = pendingSeek.t;
      pendingSeek = null;
      await invoke('engine_seek', { secs: t }).catch(() => {});
    }
    if (transport && transport !== 'playing' && transport !== 'loading') {
      invoke('engine_set_transport', { transport }).catch(() => {});
    }
  } catch (e) {
    try { invoke('web_log', { message: `[engine] load failed: ${e}` }); } catch {}
    toast(`Could not play that track: ${e}`);
    enginePlayingId = '';
    engineState = 'idle';
    if (S && S.transport === 'loading') {
      S.transport = 'paused';
      send('transport', { state: 'paused' }, { silent: true });
      try { renderPlayer(); } catch {}
    }
  }
}

function reconcileEngine(s) {
  if (!s) return;
  const cur = s.current;
  const id = cur?.videoId || '';
  const seq = Number(s.playSeq) || 0;
  if (id) {
    const fresh = id !== engineTrackId;
    const restarted = !fresh && seq !== engineSeq;
    // Never call engine_load for a track the engine has already adopted
    // through player:track-changed — that is the double-intro.
    const engineAdopted = enginePlayingId === id && engineState === 'playing';
    // A seq bump right after we just started this track is the server echoing
    // our own advance, not a real restart — don't reload inside the window.
    const justLoaded = id === engineTrackId && Date.now() - lastLoadStartedAt < 3000;
    engineTrackId = id;
    engineSeq = seq;
    if ((fresh || (restarted && s.transport === 'loading' && !justLoaded)) && !engineAdopted) loadEngineTrack(cur, s.transport);
    else invoke('engine_set_transport', { transport: s.transport || 'idle' }).catch(() => {});
  } else if (engineTrackId) {
    engineTrackId = '';
    engineSeq = -1;
    invoke('engine_stop').catch(() => {});
  }
  applyVolume(s);
}

function setTransport(state) {
  if (S) S.transport = state;
  invoke('engine_set_transport', { transport: state }).catch(() => {});
  send('transport', { state }, { silent: true });
}

const videoSrcCache = new Map();

async function videoSrc(id, low) {
  const key = `${id}:${low ? 'low' : ''}`;
  const hit = videoSrcCache.get(key);
  if (hit && Date.now() - hit.at < 4.5 * 60 * 1000) return hit.url;
  const r = await invoke('api_call', {
    method: 'POST',
    path: `/api/v1/stream-url/${encodeURIComponent(id)}`,
    body: {},
  });
  if (!r?.ok || !r?.data?.videoUrl) return '';
  const url = API_BASE + r.data.videoUrl + (low ? '&q=low' : '');
  videoSrcCache.set(key, { url, at: Date.now() });
  return url;
}

function engineIsPlayingCurrent() {
  return engineState === 'playing'
    && !!S?.current?.videoId
    && enginePlayingId === S.current.videoId;
}

function claimPlaying(videoId) {
  if (!S || !videoId || S.current?.videoId !== videoId) return;
  if (S.transport !== 'loading' && S.transport !== 'idle') return;
  S.transport = 'playing';
  const now = Date.now();
  if (claimedId !== videoId || now - claimedAt >= 4000) {
    claimedId = videoId;
    claimedAt = now;
    send('transport', { state: 'playing' }, { silent: true });
  }
  try { renderPlayer(); } catch {}
}

listen('player:position', (e) => {
  const p = e?.payload || {};
  if (enginePlayingId && S?.current?.videoId && enginePlayingId !== S.current.videoId) return;
  audio._pos = Number(p.pos) || 0;
  audio._dur = Number(p.duration) || 0;
  audio._paused = p.state !== 'playing';
  audio._at = audio._paused ? 0 : performance.now();
  if (p.state === 'paused') engineState = 'paused';
  else if (p.state === 'playing') engineState = 'playing';
  document.body.classList.toggle('is-playing', p.state === 'playing');
  if (p.state === 'playing' && enginePlayingId) claimPlaying(enginePlayingId);
});
listen('player:loading', (e) => {
  const p = e?.payload || {};
  if (S && p.videoId && S.current?.videoId === p.videoId && p.progress >= 0) {
    S.status = `Buffering ${Math.round(p.progress * 100)}%`;
    try { renderChrome(); } catch {}
  }
});
listen('player:track-changed', (e) => {
  try {
    const id = e?.payload?.track?.videoId || engineTrackId;
    enginePlayingId = id;
    engineTrackId = id;
    engineSeq = Number(S?.playSeq) || engineSeq;
    engineState = 'playing';
    audio._pos = 0;
    audio._at = performance.now();
    preloadSig = '';
    claimPlaying(id);
    renderPlayer();
    invoke('discord_rpc_sync').catch(() => {});
    topUpQueue();
  } catch {}
});
listen('preload:status', (e) => {
  const p = e?.payload || {};
  if (!p.videoId || !p.status) return;
  preloadStatus.set(p.videoId, p.status);
  paintPreloadStatus(p.videoId, p.status);
});
listen('cache:download', (e) => {
  const p = e?.payload || {};
  if (!p.videoId) return;
  if (p.status === 'done' || p.status === 'cached') {
    downloadedIds.add(p.videoId);
    document.querySelectorAll(`[data-dlcheck="${CSS.escape(p.videoId)}"]`).forEach((el) => {
      el.classList.remove('is-hidden');
    });
  }
});
listen('discord:status', (e) => {
  const d = e?.payload || {};
  settingsState.discord = {
    enabled: d.enabled === true,
    status: d.status || 'Disabled',
  };
  setSwitch('#discordEnabled', settingsState.discord.enabled);
  paintDiscordStatus();
});
listen('tray:lyrics', () => {
  if (!me) {
    showAuth('login');
    return;
  }
  if (!S) return;
  if (S.view !== 'lyrics') go('lyrics');
  else openLyricsFocus();
});
listen('tray:settings', () => {
  if (!me) {
    showAuth('login');
    return;
  }
  openSettings();
});

async function refreshDownloadedBadges() {
  if (!plDetail?.tracks?.length) return;
  try {
    const ids = plDetail.tracks.map((t) => t.videoId).filter(Boolean);
    const cached = await invoke('cached_tracks', { ids });
    (cached || []).forEach((id) => downloadedIds.add(id));
    downloadedIds.forEach((id) => {
      document.querySelectorAll(`[data-dlcheck="${CSS.escape(id)}"]`).forEach((el) => {
        el.classList.remove('is-hidden');
      });
    });
  } catch {}
}

function paintPreloadStatus(videoId, status) {  const labels = {
    waiting: 'Waiting…',
    downloading: 'Downloading…',
    done: 'Downloaded',
    cached: 'Cached',
    failed: 'Failed',
    full: 'Cache full',
  };
  const label = labels[status] || status;
  document.querySelectorAll(`[data-qstat="${CSS.escape(videoId)}"]`).forEach((el) => {
    el.textContent = label;
    el.dataset.status = status;
  });
}

function maybePreload() {
  if (!S || !S.current || !S.queue?.length) return;
  const dur = audio.duration;
  if (!dur || !isFinite(dur) || dur <= 0) return;
  const remaining = dur - (audio.currentTime || 0);
  if (remaining > PRELOAD_WINDOW_SECS) return;
  const sig = S.current.videoId + '|' + S.queue.map((t) => t.videoId).join(',');
  if (sig === preloadSig) return;
  preloadSig = sig;
  invoke('cache_preload', { tracks: S.queue.slice(0, 8) }).catch(() => {});
}
const QUEUE_LOW = 2;
const QUEUE_TOPUP = 5;
let toppingUp = false;
const appendedIds = new Set();

async function topUpQueue() {
  if (toppingUp || !S?.current) return;
  if ((Number(S.queueCount) || 0) > QUEUE_LOW) return;
  const seed = S.current;
  const q = [seed.artist, seed.title].filter(Boolean).join(' ').trim();
  if (!q) return;
  toppingUp = true;
  try {
    const res = await netFetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
    const known = new Set([seed.videoId, ...(S.recent || []).map((t) => t.videoId), ...appendedIds]);
    let added = 0;
    for (const t of tracks) {
      if (added >= QUEUE_TOPUP) break;
      if (!t?.videoId || known.has(t.videoId)) continue;
      known.add(t.videoId);
      appendedIds.add(t.videoId);
      await send('queueAppend', { track: t }, { silent: true });
      added += 1;
    }
    if (added) send('transport', { state: 'playing' }, { silent: true });
  } catch {
  } finally {
    toppingUp = false;
  }
}

listen('player:error', (e) => toast(e?.payload?.message || 'Playback failed'));
listen('player:idle', () => {
  enginePlayingId = '';
  engineState = 'idle';
  if (S) { S.transport = 'idle'; try { renderPlayer(); } catch {} }
  invoke('discord_rpc_sync').catch(() => {});
});

let scrubbing = false;
let volumeDragging = false;

let videoMode = false;
let videoEl = null;
let barVideoEl = null;
let videoBusy = false;
let videoMountedFor = '';
let videoSeeking = false;

let carryTo = '';

function carryPosition(videoId) {
  const at = audio.currentTime || 0;
  if (!videoId || !Number.isFinite(at) || at <= 1) return;
  carryTo = videoId;
  pendingSeek = { id: videoId, t: at };
}

async function findVideo(t) {
  try {
    const q = new URLSearchParams({
      title: t.title || '',
      artist: t.artist || '',
      id: t.videoId || '',
      dur: t.durationSec || '',
    });
    const res = await netFetch(`/api/videofind?${q}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.track || null;
  } catch {
    return null;
  }
}

async function findSong(t) {
  try {
    const q = new URLSearchParams({ title: t.title || '', artist: t.artist || '' });
    const res = await netFetch(`/api/songfind?${q}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.track || null;
  } catch {
    return null;
  }
}

const PAIR_KEY = 'esmVideoPair';

function rememberPair(videoId, track) {
  try {
    sessionStorage.setItem(PAIR_KEY, JSON.stringify({ video: videoId, track }));
  } catch {}
}

function pairedAudio(videoId) {
  try {
    const p = JSON.parse(sessionStorage.getItem(PAIR_KEY) || 'null');
    return p && p.video === videoId && p.track ? p.track : null;
  } catch {
    return null;
  }
}

async function setVideoMode(on) {
  if (!on) {
    videoMode = false;

    const cur = S?.current;
    if (cur && cur.video && !videoBusy) {
      let back = pairedAudio(cur.videoId);

      if (!back) {
        videoBusy = true;
        toast('Finding the track…');
        try {
          back = await findSong(cur);
        } finally {
          videoBusy = false;
        }
        if (!back) toast('No separate track for this video');
      }

      if (back && back.videoId !== cur.videoId) {
        rememberPair(cur.videoId, back);
        carryPosition(back.videoId);
        await send('play', { track: back });
        if (S?.current?.videoId !== back.videoId) carryTo = '';
      }
    }

    lastViewSig = '';
    renderView();
    renderPlayer();
    return;
  }

  const cur = S?.current;
  if (!cur || videoBusy) return;

  if (!cur.video) {
    videoBusy = true;
    toast('Finding the video…');
    try {
      const mv = await findVideo(cur);

      if (!mv || mv.videoId === cur.videoId) {
        toast('Could not find a music video for this track');
        return;
      }

      rememberPair(mv.videoId, cur);
      carryPosition(mv.videoId);
      await send('play', { track: mv });
      if (S?.current?.videoId !== mv.videoId) carryTo = '';
    } finally {
      videoBusy = false;
    }
  }

  videoMode = true;
  lastViewSig = '';
  if (S.view !== 'now') {
    go('now');
    return;
  }
  renderView();
  renderPlayer();
}

function mountVideo() {
  const id = S?.current?.videoId;
  const now = $('#npVideo');
  const bar = $('#npBarVideo');

  if (videoEl && videoEl !== now) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl = null;
  }

  if (now && id) {
    videoSrc(id, false).then((want) => {
      if (!want || !now.isConnected) return;
      if (now.getAttribute('src') === want) return;
      now.setAttribute('src', want);
      now.addEventListener('error', () => {
        if (!videoMode) return;

        if (document.hidden) return;

        if (!now.dataset.retried) {
          now.dataset.retried = '1';
          reopenVideo(now);
          return;
        }

        toast('No video for this track');
        setVideoMode(false);
      });
      now.addEventListener('click', () => {
        if (now.requestFullscreen) now.requestFullscreen().catch(() => {});
        else if (now.webkitEnterFullscreen) now.webkitEnterFullscreen();
      });

      now.addEventListener('seeking', () => { videoSeeking = true; });
      now.addEventListener('seeked', () => {
        videoSeeking = false;
        if (Math.abs(now.currentTime - audio.currentTime) < 0.5) return;
        audio.currentTime = now.currentTime;
      });

      let wasPlaying = false;
      now.addEventListener('playing', () => { wasPlaying = true; });
      now.addEventListener('play', () => {
        if (audio.paused) setTransport('playing');
      });
      now.addEventListener('pause', () => {
        if (!wasPlaying || !now.isConnected) return;
        wasPlaying = false;
        if (!audio.paused && !now.ended) setTransport('paused');
      });
    }).catch((e) => { try { invoke('web_log', { message: `[video] mount failed: ${e}` }); } catch {} });
    videoEl = now;
  }

  if (bar) {
    if (!videoMode || !id) {
      if (barVideoEl) barVideoEl.pause();
      if (bar.hasAttribute('src')) {
        bar.removeAttribute('src');
        bar.load();
      }
      barVideoEl = null;
    } else {
      videoSrc(id, true).then((wantBar) => {
        if (!wantBar || !bar.isConnected) return;
        if (bar.getAttribute('src') !== wantBar) bar.setAttribute('src', wantBar);
        barVideoEl = bar;
        syncVideo();
      }).catch(() => {});
    }
  }

  syncVideo();
}

function reopenVideo(el) {
  if (!el || !el.getAttribute('src')) return;
  const at = audio.currentTime || 0;

  el.load();
  const seek = () => {
    try { el.currentTime = at; } catch {}
  };
  if (el.readyState >= 1) seek();
  else el.addEventListener('loadedmetadata', seek, { once: true });

  el.play().catch(() => {});
}

function reviveVideo() {
  if (!videoMode) return;

  for (const el of [videoEl, barVideoEl]) {
    if (!el || !el.getAttribute('src')) continue;
    if (el.error || el.readyState === 0) reopenVideo(el);
    else if (el.paused) el.play().catch(() => {});
  }

  syncVideo(true);
}

function syncVideo(force = false) {
  if (!videoMode || videoSeeking) return;
  for (const el of [videoEl, barVideoEl]) {
    if (!el || !el.getAttribute('src')) continue;

    if (force || Math.abs(el.currentTime - audio.currentTime) > 0.45) {
      el.currentTime = audio.currentTime || 0;
    }

    if (audio.paused) {
      if (!el.paused) el.pause();
    } else if (el.paused) {
      el.play().catch(() => {});
    }
  }
}

$('#btnVideo').addEventListener('click', () => setVideoMode(!videoMode));

let ambientLayer = 0;
let ambientId = null;

function setAmbient(url) {
  if (!url) return;
  const a = $('#ambientA');
  const b = $('#ambientB');
  const next = ambientLayer === 0 ? b : a;
  const prev = ambientLayer === 0 ? a : b;
  next.style.setProperty('--art', `url("${url}")`);
  next.classList.add('on');
  prev.classList.remove('on');
  ambientLayer = ambientLayer === 0 ? 1 : 0;
}

function clearAmbient() {
  ambientId = null;
  $('#ambientA').classList.remove('on');
  $('#ambientB').classList.remove('on');
}

function apply(snap) {
  if (!snap) return;

  if (Number.isFinite(snap.rev)) {
    if (snap.rev < lastRev) return;
    lastRev = snap.rev;
  }

  // A snapshot with `loaded: false` is the server saying "the chain is still
  // running". Keep the source that is already on screen for this track rather
  // than replacing it with an empty object — the new one swaps in when it
  // lands, which after the per-source cache is usually this same response.
  const snapVid = snap.current?.videoId || '';
  if (snap.lyrics?.loaded) {
    const hasText = !!(snap.lyrics.lines?.length || snap.lyrics.plain);
    lyricsHold = hasText ? { videoId: snapVid, data: snap.lyrics } : { videoId: '', data: null };
  } else if (snap.lyricsPending && snapVid && snapVid === lyricsHold.videoId) {
    snap.lyrics = lyricsHold.data;
  }
  lyricsSwitching = false;

  S = snap;

  if (videoMode && S.current && !S.current.video) {
    videoMode = false;
    lastViewSig = '';
  }

  if ($('#sug') && !$('#sug').hidden) renderSuggestions();

  reconcileEngine(snap);

  audio._paused = S.transport !== 'playing';
  if (audio._paused) audio._at = 0;
  else if (!audio._at) audio._at = performance.now();

  if (engineIsPlayingCurrent()) claimPlaying(S.current.videoId);

  if (S.transport === 'paused' && S.current?.videoId && enginePlayingId === S.current.videoId) {
    engineState = 'paused';
  }

  renderChrome();
  renderGate();
  renderPlayer();
  renderView();

  const curId = snap.current?.videoId || '';
  if (curId !== videoMountedFor) {
    videoMountedFor = curId;
    mountVideo();
  }

  if (routingReady && !authOpen) {
    const p = pathForView(S.view);
    if (location.pathname + location.search !== p) setPath(p, { replace: true });
  }

  maybeAutoAdvanceLyrics();
}

function renderChrome() {
  $('#status').textContent = S.status || 'Ready';

  document.querySelectorAll('.nav-item').forEach((b) => {
    const v = b.dataset.nav;
    const on = v === S.view || (v === 'home' && S.view === 'search');
    b.classList.toggle('on', on);
  });

  $('#btnQueue').classList.toggle('on', S.view === 'queue');
  $('#btnLyrics').classList.toggle('on', S.view === 'lyrics');

  $('#badgeQ').textContent = S.queueCount > 0 ? S.queueCount : '';
  $('#badgePl').textContent = S.playlists.length ? S.playlists.length : '';
  $('#badgeL').textContent = S.lyricsPending && !videoMode ? '…' : '';

  $('#mixCount').textContent = S.mixCount ? `${S.mixCount} tracks` : '— tracks';
  $('#region').textContent = CAT.countryName || 'Worldwide';
}

function renderPlayer() {
  const cur = S.current;
  const has = S.hasCurrent && cur;

  const img = $('#npImg');
  const src = has ? (cur.thumb ? thumbAt(cur.thumb, 120) : letterTile(cur.title)) : '';
  if (src) {
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  } else if (img.hasAttribute('src')) {
    img.removeAttribute('src');
  }
  img.dataset.seed = has ? cur.title : '';

  if (has && cur.thumb && cur.videoId !== ambientId) {
    ambientId = cur.videoId;
    setAmbient(thumbAt(cur.thumb, 640));
  }

  $('#npTitle').textContent = has ? cur.title : 'Nothing playing';
  $('#npSub').textContent = has
    ? [cur.artist, cur.album].filter(Boolean).join('  ·  ') || '—'
    : 'Pick a track to begin';

  const vb = $('#btnVideo');
  vb.hidden = !has;
  vb.classList.toggle('on', videoMode);
  vb.setAttribute('aria-pressed', videoMode ? 'true' : 'false');
  vb.textContent = videoMode ? 'Audio' : 'Video';
  vb.title = videoMode ? 'Back to the artwork' : 'Watch the video';

  const barVid = $('#npBarVideo');
  const barImg = $('#npImg');
  const barArt = $('#npArt');
  if (barVid) barVid.hidden = !(videoMode && has);
  if (barImg) barImg.hidden = videoMode && has;
  if (barArt) barArt.classList.toggle('is-video', videoMode && has);

  $('#npArt').classList.toggle('playing', S.transport === 'playing' || engineIsPlayingCurrent());

  const playing = S.transport === 'playing';
  const live = engineIsPlayingCurrent();
  const loading = S.transport === 'loading' && !live;
  const wantsPlay = playing || loading || live;
  const btn = $('#btnPlay');
  btn.classList.toggle('is-playing', wantsPlay);
  btn.classList.toggle('is-loading', loading);
  btn.title = wantsPlay ? 'Pause' : 'Play';
  btn.setAttribute('aria-label', wantsPlay ? 'Pause' : 'Play');

  $('#btnShuffle').classList.toggle('on', !!S.shuffle);
  $('#btnShuffle').setAttribute('aria-pressed', S.shuffle ? 'true' : 'false');

  const rep = $('#btnRepeat');
  rep.classList.toggle('on', S.repeat !== 0);
  rep.classList.toggle('is-one', S.repeat === 2);
  rep.title = ['Repeat off', 'Repeat all', 'Repeat one'][S.repeat];
  rep.setAttribute('aria-pressed', S.repeat !== 0 ? 'true' : 'false');

  $('#btnNext').disabled = !(S.queueCount > 0 || S.playlistActive);

  if (!volumeDragging) {
    $('#volume').value = S.volume;
    setFill($('#volume'), S.volume);
    $('#volNum').textContent = S.volume;
  }

  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : has ? cur.durationSec : 0;
  $('#tDur').textContent = fmt(dur);
}

function setScaleX(el, pct) {
  if (!el) return;
  const value = Math.max(0, Math.min(100, pct || 0)) / 100;
  el.style.transform = `scaleX(${value})`;
}

function setFill(input, pct) {
  if (!input) return;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct || 0))}%`);
}

function viewSignature() {
  if (!S) return '';
  switch (S.view) {
    case 'search': return `search:${S.results.length}:${S.searching ? 1 : 0}:${S.artistHit?.browseId || ''}`;
    case 'artist': return `ar:${artistDetail?.id || ''}:${artistDetail?.loading ? 1 : 0}:${artistDetail?.tracks?.length ?? -1}:${(S.selectedArtists || []).includes(artistDetail?.name) ? 1 : 0}`;
    case 'mix': return `mix:${S.mix?.length}:${S.mixLoading}:${S.selectedArtists.join(',')}`;
    case 'playlists': return `pl:${plDetail?.id || ''}:${plDetail?.tracks?.length ?? -1}:${S.playlists.length}`;
    case 'queue': return `q:${S.queueCount}:${S.current?.videoId || ''}`;
    case 'lyrics': return `ly:${S.current?.videoId || ''}:${S.lyrics?.source || ''}:${S.lyrics?.lines?.length || 0}:${videoMode ? 1 : 0}:${S.lyricsPending || lyricsSwitching ? 1 : 0}`;
    case 'now': return `now:${S.current?.videoId || ''}:${videoMode ? 1 : 0}`;
    default: return `home:${S.picks.length}:${S.jump.length}:${CAT.trending.length}:${S.mixCount}`;
  }
}

function renderView() {
  const sig = viewSignature();
  if (sig === lastViewSig) {
    refreshLiveBits();
    return;
  }
  lastViewSig = sig;

  const view = $('#view');
  const scroll = $('#content').scrollTop;

  if (S.view === 'lyrics') {
    view.innerHTML = '';
    viewList = [];
    viewCtx = {};
    openLyricsFocus();
  } else {
    closeLyricsFocus();
    switch (S.view) {
      case 'search': view.innerHTML = renderSearchView(); break;
      case 'artist': view.innerHTML = renderArtistView(); break;
      case 'mix': view.innerHTML = renderMixView(); break;
      case 'playlists': view.innerHTML = renderPlaylistsView(); break;
      case 'queue': view.innerHTML = renderQueueView(); break;
      case 'now': view.innerHTML = renderNowView(); break;
      default: view.innerHTML = renderHomeView(); break;
    }
  }

  $('#content').scrollTop = scroll;
  lyrLineNodes = S.view === 'lyrics' ? [...document.querySelectorAll('.lyr-line')] : [];
  mountVideo();
  refreshLiveBits();
}

function refreshLiveBits() {
  if (S.view === 'lyrics') updateLyricHighlight(true);
  if (S.view === 'queue') paintQueueProgress(audio.currentTime, audio.duration);
}

function trackRow(t, i, opts = {}) {
  const isCurrent = S.current && S.current.videoId === t.videoId;
  const actions = [];
  const playAct = opts.playlistId ? 'plplayat' : opts.queueMode ? 'queueplay' : 'play';

  if (opts.playlistId) {
    actions.push(
      `<button class="icon-btn act-move" data-act="plup" data-i="${i}" title="Move up" aria-label="Move up">${icon('up')}</button>`,
      `<button class="icon-btn act-move" data-act="pldown" data-i="${i}" title="Move down" aria-label="Move down">${icon('down')}</button>`,
      `<button class="icon-btn" data-act="plremove" data-i="${i}" title="Remove" aria-label="Remove from playlist">${icon('close')}</button>`,
    );
  } else {
    actions.push(
      `<button class="icon-btn" data-act="queue" data-i="${i}" title="Add to queue" aria-label="Add to queue">${icon('plus')}</button>`,
      `<button class="icon-btn" data-act="addpl" data-i="${i}" title="Add to playlist" aria-label="Add to playlist">${icon('list')}</button>`,
    );
  }

  return `
    <div class="row ${isCurrent ? 'on is-current' : ''}" style="--i:${i}" data-act="${playAct}" data-i="${i}" data-vid="${esc(t.videoId || '')}" tabindex="0" role="button" aria-label="Play ${esc(t.title)}">
      <div class="r-idx">${isCurrent ? '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' : i + 1}</div>
      <div class="r-art">${art(t.thumb, t.title, '', 120)}<span class="play-hint">${icon('play')}</span></div>
      <div class="r-main">
        <div class="r-title">${esc(t.title)}</div>
        <div class="r-sub">${esc(t.artist || 'Unknown artist')}</div>
      </div>
      <span class="dl-ok${downloadedIds.has(t.videoId) ? '' : ' is-hidden'}" data-dlcheck="${esc(t.videoId || '')}" title="Downloaded">${icon('check')}</span>
      <div class="r-album">${esc(t.album || t.plays || '')}</div>
      <div class="r-dur">${t.durationSec ? fmt(t.durationSec) : '—'}</div>
      <div class="r-act">${actions.join('')}</div>
    </div>`;
}

function trackCard(t, i) {
  return `
    <button class="card" style="--i:${i}" data-act="play" data-i="${i}">
      <div class="card-art">${art(t.thumb, t.title, '', 320)}<span class="card-play">${icon('play')}</span></div>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-sub">${esc(t.artist || '')}</div>
    </button>`;
}

function mosaic(p) {
  const thumbs = (p.thumbs || []).filter(Boolean);
  if (!thumbs.length) return `<div class="mosaic one"><img src="${letterTile(p.name)}" alt=""></div>`;
  if (thumbs.length === 1) return `<div class="mosaic one">${art(thumbs[0], p.name, '', 320)}</div>`;
  const cells = [];
  for (let i = 0; i < 4; i++) {
    cells.push(thumbs[i] ? art(thumbs[i], p.name, '', 320) : '<div class="blank"></div>');
  }
  return `<div class="mosaic">${cells.join('')}</div>`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderHomeView() {
  const picks = S.picks || [];
  const jump = S.jump || [];
  const trend = CAT.trending || [];

  viewList = [...picks, ...jump, ...trend];
  viewCtx = {};

  const pickBase = 0;
  const jumpBase = picks.length;
  const trendBase = picks.length + jump.length;

  const heroLine = S.mixCount
    ? `${S.selectedArtists.length} artists, ${S.mixCount} tracks, interleaved so no two neighbours repeat.`
    : 'Pick a few artists and Esmeringhoy builds a mix — one search each, then interleaved.';

  let featureIdx = -1;
  if (picks.length) featureIdx = 0;
  else if (trend.length) featureIdx = trendBase;
  const feature = featureIdx >= 0 ? viewList[featureIdx] : null;

  let html = `
    <header class="hero ${feature ? 'has-feature' : ''}">
      <div class="hero-copy">
        <p class="eyebrow">${esc(CAT.countryName || 'Worldwide')}</p>
        <h1>${greeting()}.</h1>
        <p>${esc(heroLine)}</p>
        <div class="pl-actions">
          <button class="btn primary" data-act="view" data-v="mix">${S.mixCount ? 'Open your mix' : 'Build a mix'}</button>
          <button class="btn" data-act="view" data-v="queue">Queue${S.queueCount ? ` · ${S.queueCount}` : ''}</button>
        </div>
      </div>
      ${feature ? `
        <button class="hero-art" data-act="play" data-i="${featureIdx}" aria-label="Play ${esc(feature.title)}">
          <span class="ha-frame">
            ${art(feature.thumb, feature.title, '', 640)}
            <span class="ha-play">${icon('play')}</span>
          </span>
          <span class="ha-cap">${esc(feature.title)} — ${esc(feature.artist || '')}</span>
        </button>` : ''}
    </header>`;

  if (picks.length) {
    html += `
      <div class="sec"><div><h2>Made for you</h2><p class="sub">Ordered by what you actually finish.</p></div><span class="sec-meta">${picks.length}</span></div>
      <div class="cards">${picks.map((t, i) => trackCard(t, pickBase + i)).join('')}</div>`;
  }

  if (jump.length) {
    html += `
      <div class="sec"><div><h2>Jump back in</h2></div><span class="sec-meta">recent</span></div>
      <div class="cards">${jump.map((t, i) => trackCard(t, jumpBase + i)).join('')}</div>`;
  }

  if (trend.length) {
    html += `
      <div class="sec"><div><h2>Quick picks</h2><p class="sub">${esc(CAT.countryName || 'Worldwide')} · refreshed per session</p></div><span class="sec-meta">${trend.length}</span></div>
      <div class="rows">${trend.map((t, i) => trackRow(t, trendBase + i)).join('')}</div>`;
  }

  if (!picks.length && !trend.length) {
    html += `<div class="empty" style="margin-top:34px"><div class="big">Nothing loaded yet</div><div>Search for something above, or build a mix from artists.</div></div>`;
  }

  return html;
}

function renderSearchView() {
  viewList = S.results || [];
  viewCtx = {};

  const hit = S.artistHit;
  const card = hit ? `
    <button class="artist-hit" data-act="artist" data-id="${esc(hit.browseId)}">
      <span class="artist-hit-art">${art(hit.thumb, hit.name, '', 160)}</span>
      <span class="artist-hit-main">
        <span class="artist-hit-kicker">Artist</span>
        <span class="artist-hit-name">${esc(hit.name)}</span>
        ${hit.note ? `<span class="artist-hit-note">${esc(hit.note)}</span>` : ''}
      </span>
      <span class="artist-hit-go">Open</span>
    </button>` : '';

  if (S.searching && !viewList.length) {
    return `<div class="sec"><div><h2>Results</h2><p class="sub">Searching…</p></div></div>
      <div class="rows">${skeletonRows(8)}</div>`;
  }

  if (!viewList.length) {
    return `${card}
      <div class="sec"><div><h2>Search</h2><p class="sub">Nothing here yet.</p></div></div>
      <div class="empty"><div class="big">No results</div><div>Try a song title, an artist, or an album.</div></div>`;
  }
  return `
    ${card}
    <div class="sec"><div><h2>Results</h2><p class="sub">${esc(S.searching ? 'Searching…' : S.status)}</p></div><span class="sec-meta">${viewList.length}</span></div>
    <div class="rows">${viewList.map((t, i) => trackRow(t, i)).join('')}</div>`;
}

function renderArtistView() {
  const a = artistDetail;
  const tracks = a?.tracks || [];
  const videos = a?.videos || [];

  viewList = [...tracks, ...videos];
  viewCtx = {};

  if (!a || a.loading) {
    return `<div class="sec"><div><h2>Artist</h2><p class="sub">Loading…</p></div></div>
      <div class="rows">${skeletonRows(6)}</div>`;
  }

  if (a.error) {
    return `<button class="btn ghost" data-act="artistback" style="margin-bottom:20px">${icon('back')} Back</button>
      <div class="empty"><div class="big">${esc(a.error)}</div><div>Try the search again.</div></div>`;
  }

  const albums = a.albums || [];
  const followed = (S?.selectedArtists || []).includes(a.name);

  return `
    <button class="btn ghost" data-act="artistback" style="margin-bottom:22px">${icon('back')} Back to search</button>
    <header class="artist-hero">
      <div class="artist-portrait">${art(a.thumb, a.name, '', 400)}</div>
      <div class="artist-info">
        <p class="eyebrow">Artist</p>
        <h1>${esc(a.name)}</h1>
        ${a.description ? `<p class="artist-desc">${esc(a.description)}</p>` : ''}
        <div class="chips">
          ${tracks.length ? `<span class="chip solid">${tracks.length} top tracks</span>` : ''}
          ${videos.length ? `<span class="chip">${videos.length} videos</span>` : ''}
          ${albums.length ? `<span class="chip">${albums.length} releases</span>` : ''}
        </div>
        <div class="pl-actions">
          ${tracks.length ? `<button class="btn primary" data-act="artistplay">Play top songs</button>` : ''}
          <button class="btn ${followed ? 'on' : ''}" data-act="artistfollow"
            aria-pressed="${followed ? 'true' : 'false'}"
            title="${followed ? 'Stop following' : 'Add to your mix'}">${followed ? 'Following' : 'Follow'}</button>
        </div>
      </div>
    </header>
    ${tracks.length ? `
      <div class="sec"><div><h2>Top songs</h2></div><span class="sec-meta">${tracks.length}</span></div>
      <div class="rows">${tracks.map((t, i) => trackRow(t, i)).join('')}</div>` : ''}
    ${videos.length ? `
      <div class="sec"><div><h2>Music videos</h2><p class="sub">The video's own artwork — audio plays here</p></div><span class="sec-meta">${videos.length}</span></div>
      <div class="videos">${videos.map((v, i) => `
        <button class="video-card" style="--i:${i}" data-act="play" data-i="${tracks.length + i}" aria-label="Play ${esc(v.title)}">
          <span class="video-thumb">${art(v.thumb, v.title, '', 480)}<span class="video-play">${icon('play')}</span></span>
          <span class="video-title">${esc(v.title)}</span>
          <span class="video-sub">${esc(v.plays || v.artist || '')}</span>
        </button>`).join('')}</div>` : ''}
    ${albums.length ? `
      <div class="sec"><div><h2>Albums &amp; singles</h2><p class="sub">Tap one to play it</p></div><span class="sec-meta">${albums.length}</span></div>
      <div class="cards">${albums.map((al, i) => `
        <button class="card" style="--i:${i}" data-act="album" data-id="${esc(al.id)}">
          <div class="card-art">${art(al.thumb, al.title, '', 320)}<span class="card-play">${icon('play')}</span></div>
          <div class="card-title">${esc(al.title)}</div>
          <div class="card-sub">${esc(al.year || al.section || '')}</div>
        </button>`).join('')}</div>` : ''}
  `;
}

async function openArtist(id) {
  artistDetail = { id, loading: true, tracks: [], albums: [] };
  if (S) S.view = 'artist';
  setPath(`/artist/${encodeURIComponent(id)}`);
  lastViewSig = '';
  renderView();
  send('setView', { view: 'artist' }, { silent: true });

  try {
    const res = await netFetch(`/api/artist/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error('failed');
    artistDetail = data;
  } catch {
    artistDetail = { id, error: 'Could not load that artist.', tracks: [], albums: [] };
  }

  lastViewSig = '';
  if (S?.view === 'artist') renderView();
}

async function openAlbum(id) {
  try {
    const res = await netFetch(`/api/album/${encodeURIComponent(id)}`);
    const alb = await res.json().catch(() => null);
    if (!res.ok || !alb?.tracks?.length) throw new Error('empty');
    toast(`Playing ${alb.title || 'album'}`);
    send('playList', { tracks: alb.tracks });
  } catch {
    toast('Could not load that album');
  }
}

function renderMixView() {
  const mix = S.mix || [];
  viewList = mix;
  viewCtx = {};

  const chips = S.selectedArtists.map((a) => `<span class="chip">${esc(a)}</span>`).join('');

  if (S.artistGate) {
    return `<div class="sec"><div><h2>Your mix</h2><p class="sub">Choose the artists this is built from.</p></div></div>
      <div class="empty"><div class="big">No artists picked</div><div>Use “Change artists” to choose some.</div>
      <div style="margin-top:18px"><button class="btn primary" data-act="changeArtists">Pick artists</button></div></div>`;
  }

  let html = `
    <header class="hero">
      <p class="eyebrow">Your mix</p>
      <h1>${S.selectedArtists.length || 0} artists, interleaved</h1>
      <div class="chips">${chips || '<span class="chip">none yet</span>'}</div>
      <div class="pl-actions">
        <button class="btn primary" data-act="playMix" ${mix.length ? '' : 'disabled'}>Play mix</button>
        <button class="btn" data-act="changeArtists">Change artists</button>
        <button class="btn ghost" data-act="rebuildMix" ${S.mixLoading ? 'disabled' : ''}>${S.mixLoading ? 'Rebuilding…' : 'Rebuild'}</button>
      </div>
    </header>`;

  if (S.mixLoading) {
    html += `<div class="sec"><div><h2>${esc(S.status)}</h2></div></div><div class="rows">${skeletonRows(6)}</div>`;
    return html;
  }

  if (!mix.length) {
    html += `<div class="empty" style="margin-top:30px"><div class="big">Mix is empty</div><div>Nothing came back for that selection. Try rebuilding.</div></div>`;
    return html;
  }

  html += `
    <div class="sec"><div><h2>Tracks</h2><p class="sub">${S.mixLoading ? esc(S.status) : `${S.selectedArtists.length} artists × ${S.perArtist} tracks, round-robin`}</p></div><span class="sec-meta">${mix.length}</span></div>
    <div class="rows">${mix.map((t, i) => trackRow(t, i)).join('')}</div>`;
  return html;
}

function skeletonRows(n) {
  return Array.from({ length: n }, () =>
    `<div class="row"><div class="r-idx"></div><div class="r-art sk"></div>
     <div class="r-main"><div class="sk" style="height:11px;width:46%"></div>
     <div class="sk" style="height:9px;width:28%;margin-top:7px"></div></div></div>`).join('');
}

let importBusy = false;
let importAbort = false;

function importProgress(done, total, label) {
  const run = $('#plLoadRun');
  if (!run) return;
  run.hidden = false;

  const pct = total ? Math.round((done / total) * 100) : 0;
  const text = $('#plLoadText');
  const num = $('#plLoadPct');
  const bar = $('#plLoadBar');
  if (text) text.textContent = label || `Matching ${done} of ${total}…`;
  if (num) num.textContent = `${pct}%`;
  if (bar) setScaleX(bar, pct);
}

async function matchAndSave(rows, name, skipped = 0) {
  importBusy = true;
  importAbort = false;
  importProgress(0, rows.length, `Matching 0 of ${rows.length}…`);

  const tracks = [];
  const misses = [];
  const BATCH = 10;

  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      if (importAbort) break;

      const chunk = rows.slice(i, i + BATCH).map((r) => ({ t: r.title, a: r.artist, d: r.dur }));
      const res = await netFetch('/api/import/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: chunk }),
      });

      if (!res.ok) {
        const why = await res.json().catch(() => ({}));
        throw new Error(why.error || `Lookup failed (${res.status})`);
      }

      const data = await res.json();
      tracks.push(...(data.tracks || []));
      misses.push(...(data.misses || []));
      importProgress(Math.min(rows.length, i + BATCH), rows.length);
    }

    if (importAbort) {
      toast('Import cancelled');
      return;
    }
    if (!tracks.length) {
      toast('Nothing could be matched');
      return;
    }

    importProgress(rows.length, rows.length, 'Saving…');

    const snap = await send('playlistImport', { name, tracks });
    const id = snap?.lastPlaylistId;

    const lost = misses.length + skipped;
    toast(`Loaded ${tracks.length} track${tracks.length === 1 ? '' : 's'}${lost ? ` · ${lost} not found` : ''}`);

    if (id) {
      const res = await netFetch(`/api/playlist/${encodeURIComponent(id)}`);
      plDetail = res.ok ? await res.json() : null;
      lastViewSig = '';
      renderView();
    }
  } catch (err) {
    toast(err?.message || 'Import failed');
  } finally {
    importBusy = false;
    const run = $('#plLoadRun');
    if (run) run.hidden = true;
    const bar = $('#plLoadBar');
    if (bar) setScaleX(bar, 0);
    const input = $('#plFile');
    if (input) input.value = '';
  }
}

async function importPlaylistFile(file) {
  if (!file || importBusy) return;

  const text = await file.text().catch(() => '');
  const { rows, skipped } = parsePlaylistExport(text);
  if (!rows.length) {
    toast('No tracks found in that file');
    return;
  }

  const name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 60) || 'From Spotify';
  await matchAndSave(rows, name, skipped);
}

async function importPlaylistUrl(url) {
  if (importBusy) return;
  const link = String(url || '').trim();
  if (!link) {
    toast('Paste a Spotify playlist link first');
    return;
  }

  importBusy = true;
  try {
    importProgress(0, 1, 'Reading playlist…');
    const res = await netFetch('/api/import/spotify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || `Could not read that playlist (${res.status})`);
      return;
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      toast('No tracks found in that playlist');
      return;
    }
    importBusy = false;
    await matchAndSave(rows, data.name || 'From Spotify');
  } catch {
    toast('Could not read that playlist');
  } finally {
    importBusy = false;
    const run = $('#plLoadRun');
    if (run) run.hidden = true;
  }
}

document.addEventListener('change', (e) => {
  if (e.target?.id === 'plFile') importPlaylistFile(e.target.files?.[0]);
});

document.addEventListener('keydown', (e) => {
  if (e.target?.id === 'plUrl' && e.key === 'Enter') {
    e.preventDefault();
    importPlaylistUrl(e.target.value || '');
  }
});

document.addEventListener('dragover', (e) => {
  if (!e.target.closest?.('#plLoad')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('drop', (e) => {
  if (!e.target.closest?.('#plLoad')) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) importPlaylistFile(file);
});

function renderPlaylistsView() {
  if (plDetail) {
    viewList = plDetail.tracks || [];
    viewCtx = { playlistId: plDetail.id };

    const dur = totalDuration(viewList);
    const created = plDetail.createdAt
      ? new Date(plDetail.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    let html = `
      <button class="btn ghost" data-act="plback" style="margin-bottom:22px">${icon('back')} All playlists</button>
      <header class="pl-hero">
        <div class="pl-cover">${mosaic({ thumbs: (plDetail.tracks || []).slice(0, 4).map((t) => t.thumb), name: plDetail.name })}</div>
        <div class="pl-info">
          <p class="eyebrow">Playlist</p>
          <h1>${esc(plDetail.name)}</h1>
          <div class="chips">
            <span class="chip solid">${viewList.length} tracks</span>
            ${dur ? `<span class="chip">${fmt(dur)}</span>` : ''}
            ${created ? `<span class="chip">${esc(created)}</span>` : ''}
          </div>
          <div class="pl-actions">
            <button class="btn primary" data-act="plplay" ${viewList.length ? '' : 'disabled'}>Play</button>
            <button class="btn" data-act="plshuffle" ${viewList.length ? '' : 'disabled'}>Shuffle &amp; play</button>
            <button class="btn" data-act="pldownload" ${viewList.length && !dlAllBusy ? '' : 'disabled'} title="Download every track in this playlist">${icon('download')} Download all</button>
            <button class="btn ghost" data-act="plrename">Rename</button>
            <button class="btn ghost" data-act="pldelete">Delete</button>
          </div>
        </div>
      </header>`;

    if (!viewList.length) {
      html += `<div class="empty" style="margin-top:30px"><div class="big">No tracks yet</div><div>Add songs with the playlist button on any track.</div></div>`;
    } else {
      html += `<div class="sec"><div><h2>Tracks</h2></div><span class="sec-meta">${viewList.length}</span></div>
        <div class="rows">${viewList.map((t, i) => trackRow(t, i, { playlistId: plDetail.id })).join('')}</div>`;
    }
    return html;
  }

  const lists = S.playlists || [];
  viewList = [];
  viewCtx = {};

  let html = `
    <header class="hero">
      <p class="eyebrow">Collections</p>
      <h1>Playlists</h1>
      <p>Kept on the machine that runs the server. Deleting a playlist never touches playback or the queue.</p>
    </header>
    <div class="sec"><div><h2>New playlist</h2></div></div>
    <form class="pl-new" id="plNewForm" style="display:flex;gap:8px;max-width:460px">
      <input id="plNewName" placeholder="Name it" maxlength="60" aria-label="New playlist name"
        style="flex:1;min-width:0;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:9px 16px;font-size:13px">
      <button class="btn primary" type="submit">Create</button>
    </form>

    <div class="sec" style="margin-top:34px"><div>
      <h2>Load from Spotify</h2>
      <p class="sub">Paste a public playlist link, or export any playlist with <a class="link" href="https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" target="_blank" rel="noopener">Spotify</a> and drop the file on the box below.</p>
    </div></div>
    <div class="pl-load" id="plLoad">
      <input type="file" id="plFile" accept=".csv,text/csv,.json,application/json,.txt" hidden>
      <div class="pl-url-row">
        <input id="plUrl" type="url" placeholder="Paste a Spotify playlist link…" autocomplete="off" spellcheck="false" aria-label="Spotify playlist link">
        <button type="button" class="btn sm" data-act="plurl">Load link</button>
      </div>
      <div class="pl-drop-sep">or</div>
      <button type="button" class="pl-drop" data-act="plpick">
        <span class="pl-drop-big">Choose a CSV</span>
        <span class="pl-drop-sub">or drop the file on this box</span>
      </button>
      <div class="pl-load-run" id="plLoadRun" hidden>
        <div class="pl-load-line"><span id="plLoadText">Matching…</span><span id="plLoadPct">0%</span></div>
        <div class="pl-load-bar"><i id="plLoadBar"></i></div>
        <button type="button" class="link" data-act="plcancel">Cancel</button>
      </div>
    </div>`;

  if (!lists.length) {
    html += `<div class="empty" style="margin-top:34px"><div class="big">No playlists yet</div><div>Name one above, then add tracks with the playlist button on any song.</div></div>`;
  } else {
    html += `<div class="sec"><div><h2>All playlists</h2></div><span class="sec-meta">${lists.length}</span></div>
      <div class="cards">${lists.map((p, i) => `
        <button class="card" style="--i:${i}" data-act="plopen" data-id="${esc(p.id)}">
          <div class="card-art">${mosaic(p)}</div>
          <div class="card-title">${esc(p.name)}</div>
          <div class="card-sub">${p.count} track${p.count === 1 ? '' : 's'}${p.duration ? ' · ' + fmt(p.duration) : ''}</div>
        </button>`).join('')}</div>`;
  }
  return html;
}

function renderQueueView() {
  const q = S.queue || [];
  viewList = q;
  viewCtx = {};

  const cur = S.current;
  let now;
  if (cur) {
    now = `
      <div class="now-card">
        <div class="now-card-art">${art(cur.thumb, cur.title, '', 480)}</div>
        <div class="now-card-body">
          <div class="now-card-label">${S.transport === 'playing' ? 'Now playing' : S.transport === 'paused' ? 'Paused' : 'Up next'}</div>
          <div class="now-card-title">${esc(cur.title)}</div>
          <div class="now-card-sub">${esc([cur.artist, cur.album].filter(Boolean).join(' · '))}</div>
          <div class="mini-bar"><i></i></div>
          <div class="pl-actions" style="margin-top:14px">
            <button class="btn primary" data-act="togglePlay">${S.transport === 'playing' ? 'Pause' : 'Play'}</button>
            <button class="btn" data-act="next">Next</button>
          </div>
        </div>
      </div>`;
  } else {
    now = `<div class="now-card"><div class="now-card-body">
      <div class="now-card-label">Nothing playing</div>
      <div class="now-card-title">Your queue starts here</div>
      <div class="now-card-sub">Pick anything from Home or your mix.</div>
      <div class="pl-actions" style="margin-top:14px"><button class="btn primary" data-act="view" data-v="mix">Browse your mix</button></div>
    </div></div>`;
  }

  return `
    <div class="sec"><div><h2>Queue</h2><p class="sub">${q.length} track${q.length === 1 ? '' : 's'}${q.length ? ' · radio continues after these' : ''}</p></div>
      <span class="sec-meta">${q.length ? `<button class="link" data-act="qclear">Clear</button>` : ''}</span></div>
    <div class="q-layout">
      <div>${now}</div>
      <div>
        ${q.length
          ? `<div class="rows">${q.map((t, i) => trackRow(t, i, { queueMode: true })).join('')}</div>`
          : `<div class="empty"><div class="big">Queue is empty</div><div>Play a song and the radio fills it automatically.</div></div>`}
      </div>
    </div>`;
}

function lyricsBodyHtml(lyr, busy, hasText) {
  if (busy && !hasText) return `<div class="lyr-empty">Looking for lyrics…</div>`;
  if (lyr.synced && lyr.lines?.length) {
    return lyr.lines.map((l, i) => `<button class="lyr-line" tabindex="-1" title="Jump to this line" data-t="${l.t}" data-i="${i}">${esc(l.text)}</button>`).join('');
  }
  if (lyr.plain) {
    return lyr.plain.split('\n').filter((x) => x.trim()).map((x) => `<div class="lyr-line plain">${esc(x)}</div>`).join('');
  }
  if (lyr.instrumental) return `<div class="lyr-empty">Instrumental — no lyrics to show.</div>`;
  if (lyr.notFound) return `<div class="lyr-empty">No lyrics found for this track.</div>`;
  return `<div class="lyr-empty">Looking for lyrics…</div>`;
}

function lyricsToolsHtml(lyr) {
  return `
    <span class="offset">
      Offset
      <button data-act="lyrminus" aria-label="Lyrics earlier">−0.5</button>
      <span id="lyrOffset">${(S.lyOffset || 0).toFixed(1)}s</span>
      <button data-act="lyrplus" aria-label="Lyrics later">+0.5</button>
    </span>
    <span style="margin-left:auto">${lyr.synced ? 'Synced' : lyr.plain ? 'Plain text' : '—'}</span>`;
}

// The Lyrics view is its own layer over the window, not a page inside it:
// artwork, title and a seek bar on the left, the words on the right.
function renderLyricsFocus() {
  const el = $('#lyrFocus');
  if (!el) return;

  const cur = S.current;
  const lyr = S.lyrics || {};
  const hasText = !!(lyr.synced && lyr.lines?.length) || !!lyr.plain;
  const busy = !!S.lyricsPending || lyricsSwitching;
  const scroller = $('#lfScroll');
  const keep = scroller ? scroller.scrollTop : 0;

  el.classList.toggle('is-idle', !cur);

  $('#lfArt').innerHTML = cur ? art(cur.thumb, cur.title, '', 640) : '';

  const bg = cur?.thumb ? thumbAt(cur.thumb, 640) : '';
  const bgEl = $('#lfBg');
  if (bg) {
    if (bgEl.getAttribute('src') !== bg) bgEl.src = bg;
  } else {
    bgEl.removeAttribute('src');
  }

  $('#lfSource').textContent = `${lyr.sourceName || 'Lyrics'}${busy && hasText ? ' · switching…' : ''}`;
  $('#lfTitle').textContent = cur ? cur.title : 'Nothing playing';
  $('#lfBy').textContent = cur
    ? [cur.artist, cur.album].filter(Boolean).join(' · ')
    : 'Play something and the lyrics arrive on their own.';

  $('#lfBody').innerHTML = !cur
    ? ''
    : videoMode
      ? `<div class="lyr-empty">Lyrics are off while the video is on. Switch back to Audio to read them.</div>`
      : lyricsBodyHtml(lyr, busy, hasText);

  $('#lfTools').innerHTML = cur && !videoMode ? lyricsToolsHtml(lyr) : '';

  if (scroller) scroller.scrollTop = keep;
  if (waveformsActive && lyrFocusOpen) ensureWaveform();
  paintLyricsFocus();
}

function paintLyricsFocus() {
  if (!lyrFocusOpen || !S) return;

  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (S.current?.durationSec || 0);
  const pos = audio.currentTime || 0;
  const seek = $('#lfSeek');

  if (seek) {
    const max = Math.max(1, Math.floor(dur || 1));
    if (Number(seek.max) !== max) {
      // A new track resets the bar even while the position is still 0: without
      // this the fill keeps the previous track's width until the first second.
      seek.max = max;
      setFill(seek, dur ? (pos / dur) * 100 : 0);
    }
    if (!lfScrubbing) {
      const value = Math.floor(pos);
      if (Number(seek.value) !== value) {
        seek.value = value;
        setFill(seek, dur ? (pos / dur) * 100 : 0);
      }
    }
  }

  const curEl = $('#lfCur');
  const curText = fmt(pos);
  if (curEl && curEl.textContent !== curText) curEl.textContent = curText;

  const durEl = $('#lfDur');
  const durText = dur ? fmt(dur) : '--:--';
  if (durEl && durEl.textContent !== durText) durEl.textContent = durText;

  if (!volumeDragging) {
    const vol = Math.max(0, Math.min(100, Math.round(Number(S.volume) || 0)));
    const volume = $('#lfVolume');
    if (volume && Number(volume.value) !== vol) {
      volume.value = String(vol);
      setFill(volume, vol);
    }
    const volNum = $('#lfVolNum');
    if (volNum && volNum.textContent !== String(vol)) volNum.textContent = vol;
  }

  const play = $('#lfPlay');
  if (play) {
    const on = S.transport === 'playing';
    if (play.classList.contains('is-playing') !== on) {
      play.classList.toggle('is-playing', on);
      play.title = on ? 'Pause' : 'Play';
      play.setAttribute('aria-label', play.title);
    }
  }

  // The player bar is covered while this is open, so its state has to be
  // mirrored here or the buttons would lie about shuffle and repeat.
  const shuffle = $('#lfShuffle');
  if (shuffle) {
    const on = !!S.shuffle;
    if (shuffle.classList.contains('on') !== on) {
      shuffle.classList.toggle('on', on);
      shuffle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  const repeat = $('#lfRepeat');
  if (repeat) {
    const on = S.repeat !== 0;
    const one = S.repeat === 2;
    if (repeat.classList.contains('on') !== on) {
      repeat.classList.toggle('on', on);
      repeat.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (repeat.classList.contains('is-one') !== one) repeat.classList.toggle('is-one', one);
    const title = ['Repeat off', 'Repeat all', 'Repeat one'][S.repeat] || 'Repeat off';
    if (repeat.title !== title) {
      repeat.title = title;
      repeat.setAttribute('aria-label', title);
    }
  }

  const next = $('#lfNext');
  if (next) {
    const off = !(S.queueCount > 0 || S.playlistActive);
    if (next.disabled !== off) next.disabled = off;
  }

  if (waveformsActive && lyrFocusOpen) updateWaveformUi();
}

function waveformDuration() {
  const value = audio.duration && isFinite(audio.duration) ? audio.duration : Number(S?.current?.durationSec) || 0;
  return Math.max(0, value);
}

function setWaveformStatus(text) {
  const el = $('#lfWaveState');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function drawWaveform() {
  const wave = $('#lfWave');
  const canvas = $('#lfWaveCanvas');
  if (!wave || !canvas || !wave.classList.contains('is-open')) return;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 2 || height < 2) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pxWidth = Math.round(width * dpr);
  const pxHeight = Math.round(height * dpr);
  if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
    canvas.width = pxWidth;
    canvas.height = pxHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const padX = 12;
  const innerWidth = Math.max(1, width - padX * 2);
  const top = 18;
  const bottom = 8;
  const mid = (height + top - bottom) / 2;
  const maxAmp = Math.max(1, (height - top - bottom) / 2);
  const duration = waveformDuration();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  for (let i = 0; i <= 4; i++) {
    const x = Math.round(padX + (innerWidth * i) / 4);
    ctx.fillRect(x, top - 4, 1, height - top - bottom + 8);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.11)';
  ctx.fillRect(padX, mid, innerWidth, 1);

  ctx.font = '500 9px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = 'rgba(247, 247, 247, 0.44)';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const x = padX + (innerWidth * i) / 4;
    const time = i === 4 ? duration : duration * (i / 4);
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
    ctx.fillText(duration ? fmt(time) : '--:--', x, 4);
  }

  if (!waveformData.length) return;

  const progress = duration > 0 ? Math.max(0, Math.min(1, (audio.currentTime || 0) / duration)) : 0;
  const columns = Math.max(96, Math.floor(innerWidth / 1.3));
  const slot = innerWidth / columns;
  const topPoints = [];
  const bottomPoints = [];

  for (let i = 0; i < columns; i++) {
    const from = Math.floor((i / columns) * waveformData.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / columns) * waveformData.length));
    let peak = 0;
    let sum = 0;
    let count = 0;
    for (let j = from; j < to && j < waveformData.length; j++) {
      const value = Number(waveformData[j]) || 0;
      peak = Math.max(peak, value);
      sum += value;
      count += 1;
    }
    const energy = count ? sum / count : 0;
    const level = Math.max(0, Math.min(1, (0.62 * energy + 0.38 * peak - 0.1) / 0.9));
    const half = Math.max(0.7, Math.pow(level, 1.08) * maxAmp);
    const x = padX + i * slot;
    topPoints.push([x, mid - half]);
    bottomPoints.push([x, mid + half]);
  }

  const path = new Path2D();
  path.moveTo(topPoints[0][0], topPoints[0][1]);
  for (let i = 1; i < topPoints.length; i++) path.lineTo(topPoints[i][0], topPoints[i][1]);
  for (let i = bottomPoints.length - 1; i >= 0; i--) path.lineTo(bottomPoints[i][0], bottomPoints[i][1]);
  path.closePath();

  const baseFill = ctx.createLinearGradient(0, top, 0, height - bottom);
  baseFill.addColorStop(0, 'rgba(247, 247, 247, 0.18)');
  baseFill.addColorStop(0.5, 'rgba(247, 247, 247, 0.28)');
  baseFill.addColorStop(1, 'rgba(247, 247, 247, 0.18)');
  ctx.fillStyle = baseFill;
  ctx.fill(path);
  ctx.strokeStyle = 'rgba(247, 247, 247, 0.30)';
  ctx.lineWidth = 0.8;
  ctx.stroke(path);

  const playheadX = Math.max(padX, Math.min(width - padX, padX + innerWidth * progress));
  if (progress > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playheadX, height);
    ctx.clip();
    ctx.fillStyle = 'rgba(247, 247, 247, 0.42)';
    ctx.fill(path);
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(247, 247, 247, 0.82)';
  ctx.fillRect(playheadX - 0.5, 2, 1.5, height - 4);
  ctx.beginPath();
  ctx.arc(playheadX, 4, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function updateWaveformUi() {
  const wave = $('#lfWave');
  if (!wave || !wave.classList.contains('is-open')) return;

  const duration = waveformDuration();
  const position = Math.max(0, Math.min(duration || 0, audio.currentTime || 0));
  const max = Math.max(1, Math.round(duration || 1));
  const now = Math.max(0, Math.min(max, Math.round(position)));
  if (wave.getAttribute('aria-valuemax') !== String(max)) wave.setAttribute('aria-valuemax', String(max));
  if (wave.getAttribute('aria-valuenow') !== String(now)) wave.setAttribute('aria-valuenow', String(now));
  const text = `${fmt(position)} of ${fmt(duration)}`;
  if (wave.getAttribute('aria-valuetext') !== text) wave.setAttribute('aria-valuetext', text);

  const stamp = performance.now();
  if (stamp - waveformLastDraw < 80) return;
  waveformLastDraw = stamp;
  drawWaveform();
}

async function ensureWaveform() {
  if (!waveformsActive || !lyrFocusOpen) return;
  const id = S?.current?.videoId || '';
  if (!id) return;

  if (waveformTrackId === id && (waveformData.length || waveformLoadingId === id)) {
    if (waveformData.length) requestAnimationFrame(drawWaveform);
    return;
  }

  waveformTrackId = id;
  if (waveformCache.has(id)) {
    waveformData = waveformCache.get(id);
    waveformLoadingId = '';
    setWaveformStatus('');
    drawWaveform();
    requestAnimationFrame(drawWaveform);
    return;
  }

  waveformData = [];
  waveformLoadingId = id;
  setWaveformStatus('Preparing waveform…');
  drawWaveform();

  try {
    const peaks = await invoke('waveform_peaks', { videoId: id });
    if (!Array.isArray(peaks) || !peaks.length) throw new Error('no waveform returned');
    waveformCache.set(id, peaks);
    if (S?.current?.videoId !== id) return;
    waveformData = peaks;
    if (waveformsActive && lyrFocusOpen) {
      setWaveformStatus('');
      drawWaveform();
      requestAnimationFrame(drawWaveform);
    }
  } catch (e) {
    if (S?.current?.videoId === id) {
      waveformData = [];
      setWaveformStatus('Waveform unavailable');
      drawWaveform();
    }
    try { invoke('web_log', { message: `[waveform] ${e}` }); } catch {}
  } finally {
    if (waveformLoadingId === id) waveformLoadingId = '';
  }
}

function seekWaveform(clientX) {
  const wave = $('#lfWave');
  const duration = waveformDuration();
  if (!wave || duration <= 0) return;
  const rect = wave.getBoundingClientRect();
  if (!rect.width) return;
  const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const target = Math.min(duration - SEEK_END_GUARD_SECS, Math.max(0, fraction * duration));
  audio.currentTime = target;
  updateWaveformUi();
}

function seekWaveformBy(seconds) {
  const duration = waveformDuration();
  if (duration <= 0) return;
  const target = Math.max(0, Math.min(duration - SEEK_END_GUARD_SECS, seconds));
  audio.currentTime = target;
  updateWaveformUi();
  flushPendingSeek();
}

$('#lfWave').addEventListener('pointerdown', (e) => {
  if (!waveformsActive) return;
  e.preventDefault();
  lfWaveDragging = true;
  e.currentTarget.focus({ preventScroll: true });
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  seekWaveform(e.clientX);
});
$('#lfWave').addEventListener('pointermove', (e) => {
  if (!lfWaveDragging) return;
  e.preventDefault();
  seekWaveform(e.clientX);
});
const finishWaveformDrag = (e) => {
  if (!lfWaveDragging) return;
  lfWaveDragging = false;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  flushPendingSeek();
};
$('#lfWave').addEventListener('pointerup', finishWaveformDrag);
$('#lfWave').addEventListener('pointercancel', finishWaveformDrag);
$('#lfWave').addEventListener('keydown', (e) => {
  const duration = waveformDuration();
  if (duration <= 0) return;
  const current = audio.currentTime || 0;
  let target = null;
  if (e.key === 'ArrowLeft') target = current - (e.shiftKey ? 15 : 5);
  if (e.key === 'ArrowRight') target = current + (e.shiftKey ? 15 : 5);
  if (e.key === 'Home') target = 0;
  if (e.key === 'End') target = duration - SEEK_END_GUARD_SECS;
  if (target === null) return;
  e.preventDefault();
  seekWaveformBy(target);
});

if (window.ResizeObserver) {
  new ResizeObserver(() => {
    if (waveformsActive) drawWaveform();
  }).observe($('#lfWave'));
}

function openLyricsFocus() {
  const el = $('#lyrFocus');
  if (!el) return;
  renderLyricsFocus();
  if (lyrFocusOpen) return;

  lyrFocusOpen = true;
  el.hidden = false;
  // Read layout between "displayed" and "opened" so the transition has a
  // state to come from. Setting both in one tick is what makes it snap.
  void el.offsetWidth;
  requestAnimationFrame(() => el.classList.add('in'));
  if (waveformsActive && settingsState.draggableWaveforms) ensureWaveform();
}

function closeLyricsFocus() {
  const el = $('#lyrFocus');
  if (!el || !lyrFocusOpen) return;

  lyrFocusOpen = false;
  el.classList.remove('in');
  setTimeout(() => {
    if (!lyrFocusOpen) el.hidden = true;
  }, 360);
}

function leaveLyricsFocus() {
  const back = lyrReturnView && lyrReturnView !== 'lyrics' ? lyrReturnView : 'now';
  go(back);
}

// "Try another source" without the click: a track whose chain came back empty
// gets a couple of retries on its own. Each one only re-asks the providers
// that never answered — the ones that did are on file — so this is cheap, and
// it is capped so a track with no lyrics anywhere settles instead of looping.
function maybeAutoAdvanceLyrics() {
  if (!S || !lyrFocusOpen || S.view !== 'lyrics' || videoMode) return;

  const cur = S.current;
  if (!cur?.videoId) return;
  if (lyrAutoTry.videoId !== cur.videoId) lyrAutoTry = { videoId: cur.videoId, count: 0 };

  const lyr = S.lyrics || {};
  if (lyr.lines?.length || lyr.plain || lyr.instrumental) {
    lyrAutoTry.count = 0;
    return;
  }
  if (!lyr.notFound || S.lyricsPending || lyricsSwitching) return;
  if (lyrAutoPending || lyrAutoTry.count >= 2) return;

  lyrAutoTry.count += 1;
  lyrAutoPending = true;
  setTimeout(() => {
    lyrAutoPending = false;
    if (!S || !lyrFocusOpen || S.view !== 'lyrics' || lyricsSwitching) return;
    if (S.current?.videoId !== cur.videoId) return;
    lyricsSwitching = true;
    lastViewSig = '';
    renderView();
    send('lyricsCycle', { from: S?.lyrics?.source || '' });
  }, 800);
}

function renderNowView() {
  const cur = S.current;
  viewList = [];
  viewCtx = {};

  if (!cur) {
    return `<div class="empty" style="margin-top:40px"><div class="big">Nothing playing</div><div>Choose a track to see it here.</div></div>`;
  }

  const lyr = S.lyrics || {};
  const teaser = videoMode
    ? 'Lyrics are off while the video is on.'
    : lyr.synced && lyr.lines?.length
      ? lyr.lines.slice(0, 3).map((l) => esc(l.text)).join('<br>')
      : lyr.plain
        ? esc(lyr.plain.split('\n').slice(0, 3).join('\n'))
        : 'No lyrics yet.';

  const big = videoMode
    ? `<div class="np-big np-video-wrap"><video id="npVideo" muted playsinline preload="metadata"></video><span class="np-video-hint">Click for full screen</span></div>`
    : `<div class="np-big">${art(cur.thumb, cur.title, '', 640)}</div>`;

  return `
    <div class="np-view">
      ${big}
      <div class="np-info">
        <p class="eyebrow">${S.transport === 'playing' ? 'Now playing' : S.transport === 'paused' ? 'Paused' : 'Loaded'}</p>
        <h1>${esc(cur.title)}</h1>
        <p class="by">${esc(cur.artist || 'Unknown artist')}${cur.album ? `<em>·</em>${esc(cur.album)}` : ''}</p>
        <div class="pl-actions">
          <button class="btn primary" data-act="togglePlay">${S.transport === 'playing' ? 'Pause' : 'Play'}</button>
          <button class="btn" data-act="addplCur">Add to playlist</button>
          <button class="btn ghost" data-act="view" data-v="lyrics">Full lyrics</button>
        </div>
        <div class="np-lyric-teaser">${teaser}</div>
      </div>
    </div>`;
}

let lastLyricIdx = -2;
let userScrolledAt = 0;
let glideRaf = 0;

function glideTo(box, top) {
  cancelAnimationFrame(glideRaf);
  const from = box.scrollTop;
  const to = Math.max(0, top);
  const dist = to - from;
  if (Math.abs(dist) < 1) return;

  const ms = Math.min(950, 420 + Math.abs(dist) * 0.6);
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    box.scrollTop = from + dist * ease(p);
    if (p < 1) glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
}

function resetSplitLyricLine(el) {
  if (!el || !el.dataset.layout) return;
  el.textContent = el.dataset.raw || el.textContent;
  el.classList.remove('split');
  delete el.dataset.layout;
  delete el.dataset.raw;
}

function resetSplitLyricLines() {
  document.querySelectorAll('.lyr-line[data-layout]').forEach(resetSplitLyricLine);
}

function splitLyricLine(el) {
  if (!el) return null;
  if (el.dataset.layout === 'single') return null;
  if (el.dataset.layout === 'split') {
    return [...el.querySelectorAll('.lyr-vline')];
  }

  const raw = el.textContent || '';
  el.dataset.raw = raw;
  const tokens = raw.split(/(\s+)/).filter(Boolean);
  if (!tokens.length) {
    el.dataset.layout = 'single';
    delete el.dataset.raw;
    return null;
  }

  el.innerHTML = tokens.map((token) => `<span class="lyr-word">${esc(token)}</span>`).join('');
  const words = [...el.querySelectorAll('.lyr-word')];
  const groups = [];
  let line = [];
  let currentTop = null;

  for (const word of words) {
    const top = word.offsetTop;
    if (currentTop === null || Math.abs(top - currentTop) < 4) {
      line.push(word.textContent || '');
      currentTop = currentTop ?? top;
    } else {
      groups.push(line.join(''));
      line = [word.textContent || ''];
      currentTop = top;
    }
  }
  if (line.length) groups.push(line.join(''));

  if (groups.length <= 1) {
    el.textContent = raw;
    el.dataset.layout = 'single';
    delete el.dataset.raw;
    return null;
  }

  el.innerHTML = groups
    .map((group) => `<span class="lyr-vline">${esc(group)}</span>`)
    .join('');
  el.dataset.layout = 'split';
  el.classList.add('split');
  return [...el.querySelectorAll('.lyr-vline')];
}

function setLyricLineProgress(el, p) {
  if (!el) return;
  const vlines = splitLyricLine(el);
  if (!vlines) {
    el.style.setProperty('--p', `${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%`);
    return;
  }

  const weights = vlines.map((vline) => Math.max(1, (vline.textContent || '').trim().length));
  let remaining = Math.max(0, Math.min(1, p)) * weights.reduce((total, weight) => total + weight, 0);
  vlines.forEach((vline, i) => {
    const local = Math.max(0, Math.min(1, remaining / weights[i]));
    vline.style.setProperty('--p', `${(local * 100).toFixed(1)}%`);
    remaining -= weights[i];
  });
}

function updateLyricHighlight(force = false) {
  if (!S || S.view !== 'lyrics' || videoMode) return;
  const lyr = S.lyrics;
  if (!lyr?.synced || !lyr.lines?.length) return;

  const pos = audio.currentTime + (S.lyOffset || 0);
  let idx = -1;
  for (let i = 0; i < lyr.lines.length; i++) {
    if (lyr.lines[i].t <= pos) idx = i;
    else break;
  }
  const nodes = lyrLineNodes;
  if (!nodes.length) return;

  if (idx !== lastLyricIdx || force) {
    lastLyricIdx = idx;
    nodes.forEach((n, i) => {
      n.classList.toggle('now', i === idx);
      n.classList.toggle('past', i < idx);
      if (i !== idx) {
        n.style.removeProperty('--p');
        n.querySelectorAll('.lyr-vline').forEach((vline) => vline.style.removeProperty('--p'));
      }
    });

    const active = nodes[idx];
    if (active && Date.now() - userScrolledAt > 4000) {
      const box = lyrFocusOpen ? $('#lfScroll') : $('#content');
      if (box) {
        const r = active.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const delta = r.top - br.top - box.clientHeight / 2 + r.height / 2;
        glideTo(box, box.scrollTop + delta);
      }
    }
  }

  if (idx >= 0) {
    const line = lyr.lines[idx];
    const next = lyr.lines[idx + 1];
    const span = next ? Math.max(0.5, next.t - line.t) : 4;
    const p = Math.max(0, Math.min(1, (pos - line.t) / span));
    setLyricLineProgress(nodes[idx], p);
  }
}

window.addEventListener('resize', () => {
  resetSplitLyricLines();
  lastLyricIdx = -2;
  if (S?.view === 'lyrics') updateLyricHighlight(true);
});

let gateSig = '';

function renderGate() {
  const gate = $('#gate');
  if (!S) return;

  if (!S.artistGate) {
    gate.hidden = true;
    gateSig = '';
    return;
  }
  gate.hidden = false;

  if (activeTab !== 'country' && activeTab !== 'global') activeTab = 'country';
  document.querySelectorAll('.gate-tabs .tab').forEach((t) => {
    const on = t.dataset.tab === activeTab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const list = activeTab === 'country' ? CAT.country : CAT.global;
  const sig = `${activeTab}:${list.length}:${S.selectedArtists.join(',')}:${CAT.ready}`;
  if (sig === gateSig) return;
  gateSig = sig;

  $('#gateMeta').textContent = CAT.ready ? `${list.length} artists` : 'loading…';

  const sel = new Set(S.selectedArtists);
  $('#gateGrid').innerHTML = list.length
    ? list.map((a, i) => `
      <button class="tile ${sel.has(a.name) ? 'sel' : ''}" style="--i:${i}" data-artist="${esc(a.name)}" aria-pressed="${sel.has(a.name)}">
        <span class="tile-art">${art(a.thumb || artistThumbs.get(a.name) || '', a.name, '', 240, a.name)}<span class="tile-tick">${icon('check')}</span></span>
        <span class="tile-name">${esc(a.name)}</span>
      </button>`).join('')
    : CAT.ready
      ? `<p class="gate-empty">No artists in this list right now. Try the other tab, or skip and search for anything.</p>`
      : skeletonTiles(12);

  hydrateArtistThumbs($('#gateGrid'));

  $('#gateSum').textContent = S.selectedArtists.length
    ? `${S.selectedArtists.length} selected · ${S.perArtist} tracks each`
    : 'Nothing selected';
  $('#gateBuild').disabled = S.selectedArtists.length === 0;
  $('#gateBuild').textContent = S.selectedArtists.length
    ? `Build my mix · ${S.mixTotal} tracks`
    : 'Build my mix';
}

function skeletonTiles(n) {
  return Array.from({ length: n }, () => `
    <div class="tile"><span class="tile-art sk" style="border-radius:50%"></span>
    <span class="sk" style="width:64px;height:9px"></span></div>`).join('');
}

let modalTrack = null;

function openPlaylistModal(track) {
  if (!track) return;
  modalTrack = track;
  $('#plModal').hidden = false;

  $('#plTrack').innerHTML = `${art(track.thumb, track.title, '', 120)}<span>${esc(track.title)} — ${esc(track.artist || '')}</span>`;

  const lists = S.playlists || [];
  $('#plList').innerHTML = lists.length
    ? lists.map((p) => `
      <button class="sheet-row" data-plid="${esc(p.id)}">
        ${icon('list')}<span>${esc(p.name)}</span><em>${p.count}</em>
      </button>`).join('')
    : `<p style="color:var(--ink-3);font-size:12.5px;padding:8px 10px">No playlists yet — name one below.</p>`;

  $('#plName').value = '';
  setTimeout(() => $('#plName').focus(), 40);
}

function closePlaylistModal() {
  $('#plModal').hidden = true;
  modalTrack = null;
}

function renderSourceModal() {
  if (!S) return;
  const meta = S.lyricSourceMeta || [];
  const on = S.lyricSources || [];
  const byId = new Map(meta.map((m) => [m.id, m]));
  const rows = [];

  on.forEach((id, i) => {
    const m = byId.get(id) || { id, name: id, note: '' };
    rows.push(`
      <div class="src-row on">
        <button class="src-toggle" data-src-toggle="${esc(id)}" aria-pressed="true" aria-label="Disable ${esc(m.name)}">${icon('check')}</button>
        <div class="src-main"><span>${esc(m.name)}</span><em>${esc(m.note || '')}</em></div>
        <button class="icon-btn" data-src-move="${esc(id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} up">${icon('up')}</button>
        <button class="icon-btn" data-src-move="${esc(id)}" data-dir="1" ${i === on.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} down">${icon('down')}</button>
      </div>`);
  });

  for (const m of meta) {
    if (on.includes(m.id)) continue;
    rows.push(`
      <div class="src-row">
        <button class="src-toggle" data-src-toggle="${esc(m.id)}" aria-pressed="false" aria-label="Enable ${esc(m.name)}"></button>
        <div class="src-main"><span>${esc(m.name)}</span><em>${esc(m.note || '')}</em></div>
      </div>`);
  }

  $('#srcList').innerHTML = rows.join('');
}

function openSourceModal() {
  if (!S) return;
  renderSourceModal();
  $('#srcModal').hidden = false;
}

function closeSourceModal() {
  $('#srcModal').hidden = true;
}

async function saveSources(next) {
  if (!next.length) {
    toast('Keep at least one source');
    return;
  }
  const snap = await send('setLyricSources', { sources: next });
  if (snap) renderSourceModal();
}

$('#srcClose').addEventListener('click', closeSourceModal);
$('#srcBackdrop').addEventListener('click', closeSourceModal);

$('#srcList').addEventListener('click', (e) => {
  if (!S) return;
  const on = (S.lyricSources || []).slice();

  const toggle = e.target.closest('[data-src-toggle]');
  if (toggle) {
    const id = toggle.dataset.srcToggle;
    const i = on.indexOf(id);
    if (i >= 0) on.splice(i, 1);
    else on.push(id);
    saveSources(on);
    return;
  }

  const move = e.target.closest('[data-src-move]');
  if (move) {
    const id = move.dataset.srcMove;
    const dir = Number(move.dataset.dir);
    const i = on.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= on.length) return;
    [on[i], on[j]] = [on[j], on[i]];
    saveSources(on);
  }
});

function openAcctModal() {
  const email = me?.email || '';
  $('#acctEmail').value = email;
  $('#acctNote').textContent = email
    ? 'Signing in with a code uses this address. You can change it here.'
    : 'Add an email so you can sign in with a 6-digit code instead of your password.';
  $('#acctSave').textContent = email ? 'Update email' : 'Save email';
  $('#acctError').textContent = '';
  $('#acctError').classList.remove('bad');
  $('#acctModal').hidden = false;
  setTimeout(() => $('#acctEmail').focus(), 60);
}

function closeAcctModal() {
  $('#acctModal').hidden = true;
}

async function saveAcctEmail() {
  const email = $('#acctEmail').value.trim();
  const err = $('#acctError');
  err.textContent = '';
  err.classList.remove('bad');

  if (!email) {
    err.textContent = 'Enter an email address.';
    err.classList.add('bad');
    return;
  }

  const btn = $('#acctSave');
  btn.disabled = true;
  try {
    const res = await netFetch('/api/account/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || 'Could not save it.';
      err.classList.add('bad');
      return;
    }
    me = { ...me, ...data.user };
    closeAcctModal();
    toast('Email saved — you can sign in with a code now');
  } catch {
    err.textContent = 'Cannot reach the server.';
    err.classList.add('bad');
  } finally {
    btn.disabled = false;
  }
}

$('#accountBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#userMenu').classList.remove('on');
  openAcctModal();
});
$('#acctClose').addEventListener('click', closeAcctModal);
$('#acctBackdrop').addEventListener('click', closeAcctModal);

$('#acctSave').addEventListener('click', saveAcctEmail);
$('#acctEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveAcctEmail();
  }
});

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1900);
}

document.querySelectorAll('[data-nav]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (b.dataset.nav === 'playlists' && S?.view !== 'playlists') plDetail = null;
    go(b.dataset.nav);
  });
});

let searchSeq = 0;
let searchPending = false;

async function runSearch(q) {
  const seq = ++searchSeq;
  searchPending = true;
  if (routingReady && !authOpen) setPath('/search?q=' + encodeURIComponent(q));

  if (S) {
    S.view = 'search';
    S.searching = true;
    S.status = 'Searching…';
    lastViewSig = '';
    renderView();
    renderChrome();
  }

  try {
    const snap = await send('search', { q }, { silent: true });
    if (seq !== searchSeq) return;
    if (snap) apply(snap);
  } finally {
    if (seq === searchSeq) {
      searchPending = false;
      if (S) {
        S.searching = false;
        renderView();
      }
    }
  }
}

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (q) {
    clearTimeout(searchTimer);
    hideSuggestions();
    runSearch(q);
  }
});

let searchTimer = null;
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length) hideSuggestions();
  else renderSuggestions();
  if (q.length < 2) return;
  searchTimer = setTimeout(() => runSearch(q), 380);
});

let sugSig = '';

function renderSuggestions() {
  const panel = $('#sug');
  const list = $('#sugList');
  if (!panel || !list || !S) return;

  const searches = S.searches || [];
  const recent = S.recent || [];
  const sig = searches.join('|') + '::' + recent.map((t) => t.videoId).join(',');

  if (sig === sugSig && !panel.hidden) return;
  sugSig = sig;

  if (!searches.length && !recent.length) {
    panel.hidden = true;
    return;
  }

  const parts = [];

  if (searches.length) {
    parts.push(`<div class="sug-sec">
      <div class="sug-head">
        <span>Recent searches</span>
        <button type="button" class="link" data-sug-clear="searches">Clear</button>
      </div>
      ${searches.map((q) => `<button class="sug-row" type="button" data-sug-q="${esc(q)}">
        <span class="sug-ic">${icon('search')}</span>
        <span class="sug-main"><span class="sug-title">${esc(q)}</span></span>
      </button>`).join('')}
    </div>`);
  }

  if (recent.length) {
    parts.push(`<div class="sug-sec">
      <div class="sug-head">
        <span>Recently played</span>
        <button type="button" class="link" data-sug-clear="played">Clear</button>
      </div>
      ${recent.map((t, i) => `<button class="sug-row" type="button" data-sug="${i}">
        <span class="sug-art">${art(t.thumb, t.title, '', 120)}</span>
        <span class="sug-main">
          <span class="sug-title">${esc(t.title)}</span>
          <span class="sug-sub">${esc(t.artist || '')}</span>
        </span>
      </button>`).join('')}
    </div>`);
  }

  list.innerHTML = parts.join('');
  panel.hidden = false;
}

function hideSuggestions() {
  const panel = $('#sug');
  if (panel) panel.hidden = true;
}

$('#q').addEventListener('focus', () => {
  if (!$('#q').value.trim()) renderSuggestions();
});

$('#q').addEventListener('blur', () => setTimeout(hideSuggestions, 140));

$('#sugList').addEventListener('click', (e) => {
  const clear = e.target.closest('[data-sug-clear]');
  if (clear) {
    send(clear.dataset.sugClear === 'searches' ? 'clearSearches' : 'clearHistory');
    return;
  }

  const past = e.target.closest('[data-sug-q]');
  if (past) {
    const q = past.dataset.sugQ;
    hideSuggestions();
    $('#q').value = q;
    runSearch(q);
    return;
  }

  const row = e.target.closest('[data-sug]');
  if (!row || !S) return;
  const t = (S.recent || [])[Number(row.dataset.sug)];
  if (!t) return;
  hideSuggestions();
  $('#q').value = '';
  send('play', { track: t });
});

const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
$('#winMin')?.addEventListener('click', () => { try { appWindow?.minimize?.(); } catch {} });
$('#winClose')?.addEventListener('click', () => { try { appWindow?.close?.(); } catch {} });

async function setFullscreen(on) {
  try {
    await appWindow?.setFullscreen?.(on);
    document.body.classList.toggle('is-fullscreen', on);
    const btn = $('#winFull');
    btn?.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (btn) btn.title = on ? 'Leave fullscreen' : 'Fullscreen';
  } catch {}
}

$('#winFull')?.addEventListener('click', async () => {
  let on = false;
  try { on = !(await appWindow?.isFullscreen?.()); } catch {}
  setFullscreen(on);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.body.classList.contains('is-fullscreen')) return;
  setFullscreen(false);
});

for (const el of document.querySelectorAll('.topbar, .auth, .gate, .lyr-focus')) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea, label, .search, .user, .sug, .lf-wave')) return;
    try { appWindow?.startDragging?.(); } catch {}
  });
}

$('#btnPlay').addEventListener('click', () => send('togglePlay'));
$('#btnNext').addEventListener('click', () =>
  send('next', { pos: audio.currentTime || 0, dur: audio.duration || 0 }));
$('#btnPrev').addEventListener('click', () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else send('prev');
});
$('#btnShuffle').addEventListener('click', () => send('shuffle'));
$('#btnRepeat').addEventListener('click', () => send('repeat'));

$('#btnQueue').addEventListener('click', () => go('queue'));
$('#btnLyrics').addEventListener('click', () => go('lyrics'));

$('#npArt').addEventListener('click', () => {
  if (S?.hasCurrent) go('now');
});
$('#npAdd').addEventListener('click', () => openPlaylistModal(S?.current));

$('#volume').addEventListener('input', (e) => {
  volumeDragging = true;
  const v = Number(e.target.value);
  setFill(e.target, v);
  $('#volNum').textContent = v;
  audio.volume = Math.max(0, Math.min(1, v / 100));
});
$('#volume').addEventListener('change', (e) => {
  volumeDragging = false;
  send('volume', { pct: Number(e.target.value) }, { silent: true });
});

$('#lfVolume').addEventListener('input', (e) => {
  volumeDragging = true;
  const v = Number(e.target.value);
  if (S) S.volume = v;
  setFill(e.target, v);
  $('#lfVolNum').textContent = v;
  audio.volume = Math.max(0, Math.min(1, v / 100));
});
$('#lfVolume').addEventListener('change', (e) => {
  volumeDragging = false;
  send('volume', { pct: Number(e.target.value) });
});

$('#lfWaveToggle').addEventListener('click', () => {
  if (!settingsState.draggableWaveforms) return;
  waveformsActive = !waveformsActive;
  syncWaveformsUi();
});

$('#btnMute').addEventListener('click', () => {
  const v = S?.volume > 0 ? 0 : 70;
  send('volume', { pct: v });
});

$('#seek').addEventListener('input', (e) => {
  scrubbing = true;
  const dur = audio.duration || 0;
  if (!dur) return;
  const safeEnd = Math.max(0, dur - SEEK_END_GUARD_SECS);
  const want = Math.min(safeEnd, Math.max(0, Number(e.target.value) || 0));
  audio.currentTime = want;
  setFill(e.target, (want / dur) * 100);
});
$('#seek').addEventListener('change', () => {
  flushPendingSeek();
  scrubbing = false;
});

$('#lfSeek').addEventListener('input', (e) => {
  lfScrubbing = true;
  const dur = audio.duration || 0;
  if (!dur) return;
  const safeEnd = Math.max(0, dur - SEEK_END_GUARD_SECS);
  const want = Math.min(safeEnd, Math.max(0, Number(e.target.value) || 0));
  audio.currentTime = want;
  setFill(e.target, (want / dur) * 100);
  const curEl = $('#lfCur');
  if (curEl) curEl.textContent = fmt(want);
});

$('#lfSeek').addEventListener('change', () => {
  flushPendingSeek();
  lfScrubbing = false;
});

$('#lfPlay').addEventListener('click', () => send('togglePlay'));
$('#lfShuffle').addEventListener('click', () => send('shuffle'));
$('#lfRepeat').addEventListener('click', () => send('repeat'));
$('#lfNext').addEventListener('click', () =>
  send('next', { pos: audio.currentTime || 0, dur: audio.duration || 0 }));
$('#lfPrev').addEventListener('click', () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else send('prev');
});
$('#lfClose').addEventListener('click', leaveLyricsFocus);

// The lyrics overlay lives outside #view, so both containers get the same two
// listeners: one for jumping to a line, one for the data-act buttons.
function onLyricLineClick(e) {
  const line = e.target.closest('.lyr-line[data-t]');
  if (!line) return;
  const t = Number(line.dataset.t);
  if (!Number.isFinite(t)) return;

  const offset = Number(S?.lyOffset) || 0;
  const dur = audio.duration;
  const want = Math.max(0, t - offset);
  audio.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(want, dur - 0.15) : want;

  if (audio.paused) {
    audio.play().catch(() => {
      if (S && S.transport === 'playing') send('transport', { state: 'paused' }, { silent: true });
    });
  }
}

$('#openMix').addEventListener('click', () => go('mix'));
$('#changeArtists').addEventListener('click', () => send('changeArtists'));

document.querySelectorAll('.gate-tabs .tab').forEach((t) => {
  t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    gateSig = '';
    renderGate();
  });
});

$('#gateGrid').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile?.dataset.artist) return;
  send('toggleArtist', { name: tile.dataset.artist });
});

$('#gateBuild').addEventListener('click', () => {
  send('buildMix');
  gateSig = '';
});

$('#gateSkip').addEventListener('click', () => {
  send('skipGate');
});

$('#plClose').addEventListener('click', closePlaylistModal);
$('#plBackdrop').addEventListener('click', closePlaylistModal);

$('#plList').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-plid]');
  if (!row || !modalTrack) return;
  await send('playlistAdd', { id: row.dataset.plid, track: modalTrack });
  toast('Added to playlist');
  closePlaylistModal();
});

$('#plCreate').addEventListener('click', async () => {
  const name = $('#plName').value.trim();
  if (!name || !modalTrack) return;
  await send('playlistAdd', { newName: name, track: modalTrack });
  toast('Playlist created');
  closePlaylistModal();
});

$('#plName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#plCreate').click(); }
});

async function onViewAction(e) {
  const node = e.target.closest('[data-act]');
  if (!node) return;
  const act = node.dataset.act;
  const i = Number(node.dataset.i);
  const t = viewList[i];

  switch (act) {
    case 'play':
      if (t) send('play', { track: t });
      break;
    case 'queueplay':
      send('queuePlayAt', { index: i });
      break;
    case 'queue':
      if (t) { send('queueAppend', { track: t }); toast('Added to queue'); }
      break;
    case 'addpl':
      if (t) openPlaylistModal(t);
      break;
    case 'addplCur':
      openPlaylistModal(S?.current);
      break;
    case 'view':
      go(node.dataset.v);
      break;
    case 'togglePlay':
      send('togglePlay');
      break;
    case 'next':
      send('next', { pos: audio.currentTime || 0, dur: audio.duration || 0 });
      break;
    case 'qclear':
      send('queueClear');
      break;
    case 'changeArtists':
      send('changeArtists');
      break;
    case 'playMix':
      if (S.mix?.length) send('play', { track: S.mix[0] });
      break;
    case 'rebuildMix':
      send('buildMix', { force: true });
      break;

    case 'artist':
      if (node.dataset.id) openArtist(node.dataset.id);
      break;
    case 'album':
      if (node.dataset.id) openAlbum(node.dataset.id);
      break;
    case 'artistback':
      go('search');
      break;
    case 'artistplay':
      if (artistDetail?.tracks?.length) send('playList', { tracks: artistDetail.tracks });
      break;
    case 'artistfollow': {
      const name = artistDetail?.name;
      if (!name) break;
      const on = !(S?.selectedArtists || []).includes(name);
      send('followArtist', { name, on });
      toast(on ? `Following ${name} — added to your mix` : `Unfollowed ${name}`);
      break;
    }

    case 'plopen': {
      const id = node.dataset.id;
      const res = await netFetch(`/api/playlist/${encodeURIComponent(id)}`);
      plDetail = res.ok ? await res.json() : null;
      lastViewSig = '';
      renderView();
      refreshDownloadedBadges();
      break;
    }
    case 'plpick':
      $('#plFile')?.click();
      break;
    case 'plurl':
      importPlaylistUrl($('#plUrl')?.value || '');
      break;
    case 'plcancel':
      if (importBusy) {
        importAbort = true;
        toast('Stopping…');
      }
      break;
    case 'plplayat':
      if (plDetail?.tracks?.length) send('playlistPlay', { id: plDetail.id, index: i });
      break;
    case 'pldownload':
      if (dlAllBusy || !plDetail?.tracks?.length) break;
      dlAllBusy = true;
      lastViewSig = '';
      renderView();
      toast('Downloading playlist in the background…');
      invoke('cache_download_all', { tracks: plDetail.tracks }).then(() => {
        dlAllBusy = false; lastViewSig = ''; renderView(); refreshDownloadedBadges();
      }).catch(() => { dlAllBusy = false; toast('Could not start downloads'); });
      break;
    case 'plback':
      plDetail = null;
      lastViewSig = '';
      renderView();
      break;
    case 'plplay':
      if (plDetail?.tracks?.length) send('playlistPlay', { id: plDetail.id, index: 0 });
      break;
    case 'plshuffle':
      if (plDetail?.tracks?.length) {
        if (!S.shuffle) await send('shuffle');
        send('playlistPlay', { id: plDetail.id, index: 0 });
      }
      break;
    case 'plrename': {
      const name = prompt('Rename playlist', plDetail?.name || '');
      if (name && plDetail) {
        await send('playlistRename', { id: plDetail.id, name });
        plDetail.name = name;
        lastViewSig = '';
        renderView();
      }
      break;
    }
    case 'pldelete':
      if (plDetail && confirm(`Delete “${plDetail.name}”?`)) {
        await send('playlistDelete', { id: plDetail.id });
        plDetail = null;
        lastViewSig = '';
        renderView();
      }
      break;
    case 'plup':
      if (plDetail) {
        await send('playlistMove', { id: plDetail.id, index: i, delta: -1 });
        await reloadDetail(plDetail.id);
      }
      break;
    case 'pldown':
      if (plDetail) {
        await send('playlistMove', { id: plDetail.id, index: i, delta: 1 });
        await reloadDetail(plDetail.id);
      }
      break;
    case 'plremove':
      if (plDetail) {
        await send('playlistRemove', { id: plDetail.id, index: i });
        await reloadDetail(plDetail.id);
      }
      break;

    case 'lyrplus':
      send('lyricsOffset', { sec: (S.lyOffset || 0) + 0.5 });
      break;
    case 'lyrminus':
      send('lyricsOffset', { sec: (S.lyOffset || 0) - 0.5 });
      break;
    case 'lyrcycle':
      // Say "switching" before the round trip, not after it: the request can
      // take a moment on a cold provider, and a button that does nothing for
      // a second reads as broken.
      lyricsSwitching = true;
      lastViewSig = '';
      renderView();
      send('lyricsCycle', { from: S?.lyrics?.source || '' });
      break;
    case 'lyrSources':
      openSourceModal();
      break;
    default:
      break;
  }
}

$('#view').addEventListener('click', onLyricLineClick);
$('#view').addEventListener('click', onViewAction);
$('#lyrFocus').addEventListener('click', onLyricLineClick);
$('#lyrFocus').addEventListener('click', onViewAction);

$('#view').addEventListener('submit', (e) => {
  if (e.target.id !== 'plNewForm') return;
  e.preventDefault();
  const input = $('#plNewName');
  const name = input.value.trim();
  if (!name) return;
  send('playlistCreate', { name });
  input.value = '';
  toast('Playlist created');
});

const tookOver = () => { userScrolledAt = Date.now(); cancelAnimationFrame(glideRaf); };
$('#content').addEventListener('wheel', tookOver, { passive: true });
$('#content').addEventListener('touchmove', tookOver, { passive: true });

async function reloadDetail(id) {
  const res = await netFetch(`/api/playlist/${encodeURIComponent(id)}`);
  if (res.ok) plDetail = await res.json();
  lastViewSig = '';
  renderView();
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('#q').focus();
  }
  if (e.key === 'Escape') {
    if (!$('#updModal').hidden) closeUpdate();
    else if (!$('#setModal').hidden) closeSettings();
    else if (!$('#acctModal').hidden) closeAcctModal();
    else if (!$('#srcModal').hidden) closeSourceModal();
    else if (!$('#plModal').hidden) closePlaylistModal();
    else if (!$('#sug').hidden) hideSuggestions();
    else if (lyrFocusOpen) leaveLyricsFocus();
    else if (document.activeElement === $('#q')) $('#q').blur();
  }
  if (e.code === 'Space' && !typing && $('#plModal').hidden) {
    e.preventDefault();
    send('togglePlay');
  }
});

let lastSeekMax = -1;
let lastSeekVal = -1;
let lastCurText = '';
let lastDurText = '';
let lyrLineNodes = [];

function paintQueueProgress(pos, dur) {
  const bar = $('.now-card .mini-bar i');
  if (bar && dur) setScaleX(bar, (pos / dur) * 100);
  const label = $('.now-card-label');
  if (label) {
    label.textContent = S.transport === 'playing' ? 'Now playing' : S.transport === 'paused' ? 'Paused' : 'Up next';
  }
  const toggle = $('.now-card .pl-actions .btn.primary');
  if (toggle) toggle.textContent = S.transport === 'playing' ? 'Pause' : 'Play';
}

function frame() {
  requestAnimationFrame(frame);
  if (!S) return;

  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (S.current?.durationSec || 0);
  const pos = audio.currentTime || 0;

  if (!scrubbing) {
    const seek = $('#seek');
    const max = Math.max(1, Math.floor(dur || 1));
    const value = Math.floor(pos);
    if (max !== lastSeekMax) {
      seek.max = max;
      lastSeekMax = max;
    }
    if (value !== lastSeekVal) {
      seek.value = value;
      lastSeekVal = value;
      setFill(seek, dur ? (pos / dur) * 100 : 0);
    }
  }

  const curText = fmt(pos);
  if (curText !== lastCurText) {
    $('#tCur').textContent = curText;
    lastCurText = curText;
  }
  if (dur) {
    const durText = fmt(dur);
    if (durText !== lastDurText) {
      $('#tDur').textContent = durText;
      lastDurText = durText;
    }
  }

  if (S.view === 'lyrics') updateLyricHighlight();
  if (lyrFocusOpen) paintLyricsFocus();
  syncVideo();
  if (S.view === 'queue') paintQueueProgress(pos, dur);
  maybePreload();
}

let authMode = 'login';

function authError(msg) {
  const el = $('#authError');
  el.textContent = msg || '';
  el.classList.toggle('bad', Boolean(msg));
}

// Same slot, without the red rule — for "this worked, but read the next step".
function authNotice(msg) {
  const el = $('#authError');
  el.textContent = msg || '';
  el.classList.remove('bad');
}

let codeSent = false;
let codeEmail = '';

// The button stays grey until the box is ticked, and goes grey again if it is
// unticked — the loading state wins while a request is in flight.
function syncTermsGate() {
  const btn = $('#authSubmit');
  if (!btn || btn.classList.contains('is-loading')) return;
  btn.disabled = authMode === 'register' && !$('#termsAgree').checked;
}

$('#termsAgree').addEventListener('change', () => {
  $('#termsRow').classList.remove('bad');
  syncTermsGate();
});

// The terms live on the site; opening them here would replace the app with a
// web page and no way back. Hand it to the system browser instead.
$('#termsLink').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  invoke('open_url', { url: 'https://esmeringhoy.pages.dev/terms' }).catch(() => {});
});

// ── Cloudflare Turnstile ───────────────────────────────────────────────
// The widget is framed from the site, not drawn here. Turnstile only issues
// tokens to a page served from a hostname the site key lists, and this
// document's origin is http://tauri.localhost — a hostname no site key can
// list. So the frame loads /captcha on the real domain, where the widget is
// first-party, and posts the token up. The CSP allows exactly that origin.
let captchaCfg = { required: false, siteKey: '' };
let captchaConfigLoad = null;
let captchaToken = '';
let captchaError = '';

function captchaOrigin() {
  try { return new URL(API_BASE).origin; } catch { return 'https://esmeringhoy.pages.dev'; }
}

function captchaNeeded() {
  return captchaCfg.required
    && (authMode === 'login' || authMode === 'register' || authMode === 'code');
}

function loadCaptchaConfig() {
  if (captchaConfigLoad) return captchaConfigLoad;
  captchaConfigLoad = invoke('captcha_status')
    .then((cfg) => {
      captchaCfg = {
        required: cfg?.required === true,
        siteKey: String(cfg?.siteKey || ''),
      };
      mountCaptcha();
      return captchaCfg;
    })
    .catch(() => {
      // Do not cache a failed lookup: the next submit retries instead of
      // silently skipping a check the server would still enforce.
      captchaConfigLoad = null;
      return captchaCfg;
    });
  return captchaConfigLoad;
}

function renderCaptchaHint() {
  const hint = $('#captchaHint');
  if (!hint) return;
  hint.textContent = captchaError || '';
  hint.hidden = !captchaError;
  hint.classList.toggle('bad', Boolean(captchaError));
}

// Mounted once per origin; the frame is only pointed at the page when the
// current tab actually needs it, so signing in never loads Cloudflare.
function mountCaptcha() {
  const box = $('#captchaSlot');
  const frame = $('#captchaFrame');
  if (!box || !frame) return;

  box.hidden = !captchaNeeded();
  if (box.hidden) return;

  const src = `${captchaOrigin()}/captcha?embed=1&theme=dark`;
  if (frame.dataset.mounted === src) return;
  frame.dataset.mounted = src;
  captchaToken = '';
  captchaError = '';
  renderCaptchaHint();
  frame.src = src;
}

function resetCaptcha() {
  captchaToken = '';
  captchaError = '';
  renderCaptchaHint();
  const frame = $('#captchaFrame');
  try {
    frame?.contentWindow?.postMessage({ source: 'esmeringhoy-iframe', type: 'reset' }, captchaOrigin());
  } catch {}
}

window.addEventListener('message', (event) => {
  if (event.origin !== captchaOrigin()) return;
  const data = event.data;
  if (!data || data.source !== 'esmeringhoy-captcha') return;

  if (data.type === 'token') {
    captchaToken = String(data.token || '');
    captchaError = '';
  } else if (data.type === 'expired') {
    captchaToken = '';
    captchaError = 'The check expired — complete it again.';
  } else if (data.type === 'error') {
    captchaToken = '';
    captchaError = 'The verification check could not load.';
  } else if (data.type === 'disabled') {
    captchaToken = '';
    captchaError = '';
  }
  renderCaptchaHint();
});

// Called from the submit handlers. Returns the token, or throws the sentence
// the form shows — by then the widget is already on screen, so the user is
// being told what to do rather than being handed a popup.
async function captchaForSubmit() {
  await loadCaptchaConfig();
  if (!captchaCfg.required) return null;
  mountCaptcha();
  if (!captchaToken) throw new Error('Complete the verification check above to continue.');
  const token = captchaToken;
  resetCaptcha(); // single use: any retry needs a fresh challenge
  return token;
}

function renderAuthFields() {
  const isCode = authMode === 'code';
  const isRegister = authMode === 'register';
  const sent = isCode && codeSent;

  $('#fieldUser').hidden = isCode;
  $('#fieldPass').hidden = isCode;
  $('#authConfirmField').hidden = !isRegister;
  $('#fieldInvite').hidden = !isRegister || regMode !== 'invite';

  // Consent is asked for once, where an account is made — never on sign-in.
  $('#termsRow').hidden = !isRegister;
  syncTermsGate();

  // A "copy code" link carries the code but not necessarily the address, so
  // the email field stays available until we know which mailbox it belongs to.
  $('#fieldEmail').hidden = !(isRegister || (isCode && (!sent || !codeEmail)));
  $('#fieldCode').hidden = !sent;
  $('#resendCode').hidden = !sent;
  $('#hintCode').textContent = sent && codeEmail
    ? `Check ${codeEmail} — a sign-in code, or a link to create an account.`
    : 'It expires in 10 minutes.';

  $('#hintUser').hidden = !isRegister;
  $('#hintPass').hidden = !isRegister;
  $('#authNote').hidden = !isRegister;
  $('#hintEmail').hidden = isCode;

  $('#authSubmit .btn-label').textContent = isCode
    ? (sent ? 'Sign in' : 'Email me a code')
    : (isRegister ? 'Create account' : 'Sign in');

  $('#authPass').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  mountCaptcha();
}

function setAuthMode(mode) {
  if (mode !== authMode) {
    codeSent = false;
    codeEmail = '';
    stopResendCountdown();
    // Every tab gets its own challenge. A token is single use and was issued
    // for the form it was solved on, so carrying one across a tab switch would
    // either fail on the server or hand the next form a stale answer.
    resetCaptcha();
  }
  authMode = mode;
  if (authOpen) setPath(AUTH_PATH[mode] || '/login', { replace: true });
  document.querySelectorAll('[data-auth]').forEach((t) => {
    const on = t.dataset.auth === mode;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  $('#authNote').textContent = 'Hashed with PBKDF2 — the plain password is never stored.';
  renderAuthFields();
  authError('');
}

function setUser(user) {
  me = user || null;
  let name = me?.username || '';
  if (me && !name) {
    try { name = localStorage.getItem('esm.username') || ''; } catch {}
  }
  if (me && name) {
    try { localStorage.setItem('esm.username', name); } catch {}
  }
  $('#userName').textContent = me ? (name || '—') : '—';
  $('#userWrap').hidden = !me;
}

function showAuth(mode = 'login') {
  disconnectStream();
  authOpen = true;
  loadCaptchaConfig();

  // Arriving from the "no account on this address" email: the address is
  // already known, so the form should not make them retype it.
  if (mode === 'register') {
    const invited = new URLSearchParams(location.search).get('email');
    if (invited) {
      const el = $('#authEmail');
      if (el) el.value = invited;
    }
  }

  setAuthMode(mode);
  $('#authPass').type = 'password';
  $('#peekPass').setAttribute('aria-pressed', 'false');
  $('#peekPass').setAttribute('aria-label', 'Show password');
  $('#capsHint').hidden = true;
  $('#auth').hidden = false;
  $('#auth').classList.remove('leaving');
  authError('');
  setTimeout(() => $('#authUser').focus(), 60);
}

function signOutLocally(mode = 'login') {
  stopPolling();
  setUser(null);
  resetClientState();
  showAuth(mode);
}

function hideAuth() {
  authOpen = false;
  const el = $('#auth');
  if (el.hidden) return;
  el.classList.add('leaving');
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove('leaving');
  }, 240);
}

$('#peekPass').addEventListener('click', (e) => {
  e.preventDefault();
  const input = $('#authPass');
  const btn = $('#peekPass');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  input.focus({ preventScroll: true });
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch {}
});

function syncCaps(e) {
  let on = false;
  try { on = e.getModifierState && e.getModifierState('CapsLock'); } catch {}
  $('#capsHint').hidden = !on;
}
$('#authPass').addEventListener('keydown', syncCaps);
$('#authPass').addEventListener('keyup', syncCaps);
$('#authPass').addEventListener('blur', () => { $('#capsHint').hidden = true; });

const POLL_MS = 1500;

async function pollOnce() {
  if (searchPending) return;
  try {
    const res = await netFetch('/api/state');
    if (res.status === 401) {
      signOutLocally();
      return;
    }
    if (res.ok) apply(await res.json());
  } catch {
  }
}

function connectStream() {
  stopPolling();
  pollOnce();
  pollTimer = setInterval(() => {
    if (!document.hidden) pollOnce();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (pollTimer) pollOnce();

  reviveVideo();
});

function disconnectStream() {
  stopPolling();
}

async function loadCatalog() {
  try {
    const res = await netFetch('/api/catalog');
    if (res.status === 401) return;
    if (!res.ok) return;
    CAT = await res.json();
    gateSig = '';
    lastViewSig = '';
    if (S) {
      renderChrome();
      renderGate();
      renderView();
    }
    if (!CAT.ready) setTimeout(loadCatalog, 4000);
  } catch {
  }
}

function resetClientState() {
  S = null;
  viewList = [];
  viewCtx = {};
  plDetail = null;
  lastViewSig = '';
  lastLyricIdx = -2;
  lastRev = -1;
  activeTab = 'country';
  gateSig = '';
  CAT = { country: [], global: [], trending: [], countryName: 'Worldwide', ready: false };
  clearAmbient();
  engineTrackId = '';
  engineSeq = -1;
  invoke('engine_stop').catch(() => {});
  document.body.classList.remove('is-playing');
}

document.querySelectorAll('[data-auth]').forEach((t) => {
  t.addEventListener('click', () => setAuthMode(t.dataset.auth));
});

['#authUser', '#authPass'].forEach((sel) => {
  $(sel).addEventListener('input', () => {
    $('#hintUser').classList.remove('bad');
    $('#hintPass').classList.remove('bad');
  });
});

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
const MIN_PASSWORD = 8;

let resendTimer = null;
let resendLeft = 0;

function renderResend() {
  const btn = $('#resendCode');
  if (!btn) return;
  btn.disabled = resendLeft > 0;
  btn.textContent = resendLeft > 0 ? `Resend in ${resendLeft}s` : 'Resend code';
}

function startResendCountdown(seconds = 45) {
  clearInterval(resendTimer);
  resendLeft = Math.max(0, Math.floor(seconds));
  renderResend();
  if (resendLeft === 0) return;

  resendTimer = setInterval(() => {
    resendLeft = Math.max(0, resendLeft - 1);
    renderResend();
    if (resendLeft === 0) {
      clearInterval(resendTimer);
      resendTimer = null;
    }
  }, 1000);
}

function stopResendCountdown() {
  clearInterval(resendTimer);
  resendTimer = null;
  resendLeft = 0;
  renderResend();
}

async function resendCode() {
  if (!codeEmail) return;
  const btn = $('#resendCode');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const captcha = await captchaForSubmit();
    await invoke('auth_email_start', { email: codeEmail, captcha: captcha || undefined });

    authError('');
    $('#hintCode').textContent = `Check ${codeEmail} — a sign-in code, or a link to create an account.`;
    $('#authCode').value = '';
    $('#authCode').focus();
    startResendCountdown(45);
  } catch (e) {
    const msg = String(e || '').replace(/^.*Error:\s*/i, '');
    const wait = /Wait (\d+)s/.exec(msg || '');
    authError(msg || 'Could not resend the code.');
    if (wait) startResendCountdown(Number(wait[1]));
    else renderResend();
  }
}

$('#resendCode').addEventListener('click', resendCode);

async function submitCode() {
  const btn = $('#authSubmit');
  const done = () => {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    renderAuthFields();
  };

  if (!codeSent) {
    const email = $('#authEmail').value.trim();
    if (!email) {
      $('#authEmail').focus();
      return authError('Enter your email address.');
    }

    btn.disabled = true;
    btn.classList.add('is-loading');
    $('#authSubmit .btn-label').textContent = 'Sending…';
    try {
      const captcha = await captchaForSubmit();
      await invoke('auth_email_start', { email, captcha: captcha || undefined });
      codeSent = true;
      codeEmail = email;
      authError('');
      renderAuthFields();
      startResendCountdown(45);
      $('#authCode').focus();
    } catch (e) {
      const msg = String(e || '').replace(/^.*Error:\s*/i, '');
      authError(msg || 'Could not send the code.');
    } finally {
      done();
    }
    return;
  }

  const code = $('#authCode').value.replace(/\D/g, '');
  if (code.length !== 6) {
    $('#authCode').focus();
    return authError('Enter the 6-digit code.');
  }

  // Opened from a link that had a code but no address: ask for it rather than
  // sending an empty string, which the server would rightly call malformed.
  let email = codeEmail;
  if (!email) {
    email = $('#authEmail').value.trim();
    if (!email) {
      $('#authEmail').focus();
      return authError('Enter your email address.');
    }
    codeEmail = email;
    renderAuthFields();
  }

  btn.disabled = true;
  btn.classList.add('is-loading');
  $('#authSubmit .btn-label').textContent = 'Signing in…';
  try {
    const r = await invoke('auth_email_verify', { email, code });
    const user = r?.user || null;
    let snap = r?.state && r.state !== null && r.state !== undefined ? r.state : null;
    if (!snap) {
      const sRes = await netFetch('/api/state');
      if (sRes.ok) snap = await sRes.json();
    }
    setUser(user);
    hideAuth();
    resetClientState();
    if (snap) apply(snap);
    connectStream();
    loadCatalog();
    if (r?.created) toast('New account created for that address');
    $('#authCode').value = '';
    codeSent = false;
  } catch (e) {
    const msg = String(e || '').replace(/^.*Error:\s*/i, '');
    authError(msg || 'That code did not work.');
  } finally {
    done();
  }
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (authMode === 'code') return submitCode();

  const username = $('#authUser').value.trim();
  const password = $('#authPass').value;

  $('#hintUser').classList.remove('bad');
  $('#hintPass').classList.remove('bad');

  if (!username || !password) {
    if (!username) $('#hintUser').classList.add('bad');
    else $('#hintPass').classList.add('bad');
    return authError('Enter a username and password.');
  }

  if (!USERNAME_RE.test(username)) {
    $('#hintUser').classList.add('bad');
    $('#authUser').focus();
    return authError('Username must be 3–24 characters: letters, numbers, dot, dash or underscore. No spaces, no @.');
  }

  if (password.length < MIN_PASSWORD) {
    $('#hintPass').classList.add('bad');
    $('#authPass').focus();
    return authError(`Password must be at least ${MIN_PASSWORD} characters.`);
  }

  if (authMode === 'register' && !$('#termsAgree').checked) {
    $('#termsRow').classList.add('bad');
    $('#termsAgree').focus();
    return authError('Agree to the Terms of Service to create an account.');
  }
  $('#termsRow').classList.remove('bad');

  if (authMode === 'register' && password !== $('#authPass2').value) {
    return authError('The two passwords do not match.');
  }

  const btn = $('#authSubmit');
  const label = $("#authSubmit .btn-label").textContent;
  btn.disabled = true;
  btn.classList.add("is-loading");
  $("#authSubmit .btn-label").textContent = authMode === "register" ? "Creating…" : "Signing in…";

  try {
    let user = null;
    let snap = null;
    if (authMode === 'login') {
      const captcha = await captchaForSubmit();
      const r = await invoke('auth_sign_in', { username, password, captcha: captcha || undefined });
      user = r?.user || null;
    } else {
      const captcha = await captchaForSubmit();
      const r = await invoke('auth_register', {
        username,
        password,
        email: $('#authEmail').value.trim() || undefined,
        invite: $('#authInvite').value.trim() || undefined,
        terms: $('#termsAgree').checked,
        captcha: captcha || undefined,
      });

      // The account exists but is not signed in: it stays inert until the
      // emailed activation link is opened. Showing this as a success, not a
      // failure, is the whole point of the pending state.
      if (r?.pending) {
        setAuthMode('login');
        authNotice(
          r?.warning
          || `Account created. Check ${r?.email || 'your inbox'} for the activation link.`,
        );
        $('#authPass').value = '';
        $('#authPass2').value = '';
        return;
      }

      user = r?.user || null;
    }
    const sRes = await netFetch('/api/state');
    if (sRes.ok) snap = await sRes.json();

    setUser(user);
    hideAuth();
    resetClientState();
    if (snap) apply(snap);
    connectStream();
    loadCatalog();
    $('#authPass').value = '';
    $('#authPass2').value = '';
    $('#authEmail').value = '';
  } catch (e) {
    const msg = String(e || '').replace(/^.*Error:\s*/i, '');
    if (/invite/i.test(msg)) {
      regMode = 'invite';
      renderAuthFields();
      setTimeout(() => $('#authInvite').focus(), 40);
    }
    authError(msg || 'Something went wrong.');
  } finally {
    btn.disabled = authMode === 'register' && !$('#termsAgree').checked;
    btn.classList.remove("is-loading");
    $("#authSubmit .btn-label").textContent = label;
  }
});

$('#userBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#userMenu');
  const open = !menu.classList.contains('on');
  menu.classList.toggle('on', open);
  $('#userBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
});

document.addEventListener('click', () => {
  $('#userMenu').classList.remove('on');
  $('#userBtn').setAttribute('aria-expanded', 'false');
});

function fmtBytes(n) {
  const bytes = Math.max(0, Number(n) || 0);
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function setSwitch(id, checked) {
  const button = $(id);
  if (!button) return;
  button.setAttribute('aria-checked', checked ? 'true' : 'false');
}

function applySettingsState(settings) {
  if (!settings) return;
  const discord = settings.discord || {};
  settingsState = {
    autoUpdateCheck: settings.autoUpdateCheck !== false,
    ambientArtwork: settings.ambientArtwork !== false,
    reduceMotion: settings.reduceMotion === true,
    draggableWaveforms: settings.draggableWaveforms === true,
    discord: {
      enabled: discord.enabled === true,
      status: discord.status || 'Disabled',
    },
  };

  document.body.classList.toggle('ambient-off', !settingsState.ambientArtwork);
  document.body.classList.toggle('reduce-motion', settingsState.reduceMotion);
  setSwitch('#autoUpdateToggle', settingsState.autoUpdateCheck);
  setSwitch('#ambientToggle', settingsState.ambientArtwork);
  setSwitch('#reduceMotionToggle', settingsState.reduceMotion);
  setSwitch('#waveformsToggle', settingsState.draggableWaveforms);
  setSwitch('#discordEnabled', settingsState.discord.enabled);

  paintDiscordStatus();
  syncWaveformsUi();
}

function syncWaveformsUi() {
  const available = settingsState.draggableWaveforms === true;
  if (!available) waveformsActive = false;

  const button = $('#lfWaveToggle');
  if (button) {
    button.hidden = !available;
    button.classList.toggle('is-on', available && waveformsActive);
    button.setAttribute('aria-pressed', available && waveformsActive ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      available && waveformsActive
        ? 'Disable draggable audio waveforms'
        : 'Enable draggable audio waveforms',
    );
    button.title = available && waveformsActive
      ? 'Draggable audio waveforms: on'
      : 'Draggable audio waveforms: off';
  }

  const volume = $('.lf-volume');
  if (volume) {
    const hidden = available && waveformsActive;
    volume.classList.toggle('is-hidden', hidden);
    if (hidden) volume.setAttribute('aria-hidden', 'true');
    else volume.removeAttribute('aria-hidden');
  }

  const wave = $('#lfWave');
  const showWave = available && waveformsActive;
  if (wave) {
    wave.classList.toggle('is-open', showWave);
    wave.setAttribute('aria-hidden', showWave ? 'false' : 'true');
    wave.tabIndex = showWave ? 0 : -1;
    if (!showWave) lfWaveDragging = false;
  }
  const layer = $('#lyrFocus');
  if (layer) layer.classList.toggle('is-waveforming', showWave);
  if (showWave && lyrFocusOpen) ensureWaveform();
}

function paintDiscordStatus() {
  const status = $('#discordStatus');
  if (!status) return;
  status.textContent = settingsState.discord.status;
  status.classList.toggle('is-connected', /^(connected|paused)$/i.test(settingsState.discord.status));
  status.classList.toggle(
    'is-error',
    /(could not|not available|enter your|add a discord)/i.test(settingsState.discord.status),
  );
}

async function loadSettingsState() {
  const settings = await invoke('settings_get').catch(() => null);
  applySettingsState(settings);
  return settings;
}

async function saveDiscordSettings(enabledOverride) {
  const enabled = typeof enabledOverride === 'boolean'
    ? enabledOverride
    : settingsState.discord.enabled;
  try {
    const settings = await invoke('discord_rpc_set', { enabled });
    applySettingsState(settings);
    toast(enabled ? 'Discord Rich Presence on' : 'Discord Rich Presence off');
    return true;
  } catch (e) {
    const message = String(e || 'Could not update that setting')
      .replace(/^Error:\s*/i, '')
      .trim();
    toast(message || 'Could not update that setting');
    setSwitch('#discordEnabled', settingsState.discord.enabled);
    return false;
  }
}

const SETTINGS_TABS = ['cache', 'discord', 'general', 'appearance'];

function activateSettingsTab(tab, persist = true) {
  const selected = SETTINGS_TABS.includes(tab) ? tab : 'cache';
  settingsTab = selected;
  if (persist) {
    try { localStorage.setItem('esm.settingsTab', selected); } catch {}
  }
  document.querySelectorAll('[data-setting-tab]').forEach((button) => {
    const active = button.dataset.settingTab === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-setting-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.settingPanel !== selected;
    panel.classList.toggle('is-active', panel.dataset.settingPanel === selected);
  });
}

async function refreshCacheStats() {
  try {
    const s = await invoke('cache_stats');
    const used = Number(s?.usedBytes) || 0;
    const limit = Number(s?.limitBytes) || 0;
    const tracks = Number(s?.tracks) || 0;
    const usage = $('#cacheUsage');
    if (usage) usage.textContent = `${fmtBytes(used)} of ${fmtBytes(limit)} used · ${tracks} track${tracks === 1 ? '' : 's'} cached`;
    const bar = $('#cacheBar');
    if (bar) setScaleX(bar, limit ? Math.min(100, (used / limit) * 100) : 0);
    const gb = limit ? Math.round(limit / (1024 * 1024 * 1024)) : 5;
    document.querySelectorAll('#cacheLimit .seg-item').forEach((b) => {
      const on = Number(b.dataset.gb) === gb;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  } catch (e) {
    try { invoke('web_log', { message: `[cache] stats failed: ${e}` }); } catch {}
    const usage = $('#cacheUsage');
    if (usage) usage.textContent = 'Cache status unavailable';
  }
}

function openSettings() {
  $('#userMenu').classList.remove('on');
  $('#userBtn').setAttribute('aria-expanded', 'false');
  let saved = 'cache';
  try { saved = localStorage.getItem('esm.settingsTab') || 'cache'; } catch {}
  activateSettingsTab(saved, false);
  $('#setModal').hidden = false;
  refreshCacheStats();
  refreshVersion();
  loadSettingsState();
  setTimeout(() => $('[data-setting-tab].is-active')?.focus(), 30);
}

function closeSettings() {
  $('#setModal').hidden = true;
}

$('#settingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  openSettings();
});
$('#setClose').addEventListener('click', closeSettings);
$('#setBackdrop').addEventListener('click', closeSettings);

document.querySelectorAll('[data-setting-tab]').forEach((button) => {
  button.addEventListener('click', () => activateSettingsTab(button.dataset.settingTab));
  button.addEventListener('keydown', (e) => {
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const tabs = [...document.querySelectorAll('[data-setting-tab]')];
    const current = tabs.indexOf(e.currentTarget);
    let next = current;
    if (e.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
    if (e.key === 'ArrowDown') next = (current + 1) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    tabs[next].focus();
    activateSettingsTab(tabs[next].dataset.settingTab);
  });
});

$('#autoUpdateToggle')?.addEventListener('click', async () => {
  const next = !settingsState.autoUpdateCheck;
  try {
    const settings = await invoke('general_set', { autoUpdateCheck: next });
    applySettingsState(settings);
    toast(next ? 'Automatic update checks on' : 'Automatic update checks off');
  } catch {
    toast('Could not update that setting');
  }
});

$('#ambientToggle')?.addEventListener('click', async () => {
  const settings = await invoke('appearance_set', {
    ambientArtwork: !settingsState.ambientArtwork,
    reduceMotion: settingsState.reduceMotion,
  }).catch(() => null);
  if (settings) applySettingsState(settings);
  else toast('Could not update that setting');
});

$('#reduceMotionToggle')?.addEventListener('click', async () => {
  const settings = await invoke('appearance_set', {
    ambientArtwork: settingsState.ambientArtwork,
    reduceMotion: !settingsState.reduceMotion,
  }).catch(() => null);
  if (settings) applySettingsState(settings);
  else toast('Could not update that setting');
});

$('#waveformsToggle')?.addEventListener('click', async () => {
  const settings = await invoke('waveforms_set', {
    enabled: !settingsState.draggableWaveforms,
  }).catch(() => null);
  if (settings) applySettingsState(settings);
  else toast('Could not update that setting');
});

$('#discordEnabled')?.addEventListener('click', () => {
  saveDiscordSettings(!settingsState.discord.enabled);
});

$('#cacheLimit').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-gb]');
  if (!b) return;
  try { await invoke('cache_set_limit', { gb: Number(b.dataset.gb) }); } catch {}
  refreshCacheStats();
});


const UPDATE_SKIP_KEY = 'esm.skipUpdate';
const UPDATE_BUSY = new Set(['preparing', 'downloading', 'verifying', 'installing']);
let updateState = null;
let lastUpdatePhase = null;

function updateErrText(err) {
  const raw = typeof err === 'string' ? err : err?.message || '';
  return String(raw).replace(/^Error:\s*/i, '').trim();
}

function fmtRate(bps) {
  const n = Number(bps) || 0;
  if (n < 1024) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB/s`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB/s`;
}

function fmtEta(secs) {
  const s = Math.round(Number(secs) || 0);
  if (s <= 0) return '';
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s left` : `${m}m left`;
}

function cleanNotes(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

const UPDATE_LABELS = {
  checking: 'Checking for updates…',
  preparing: 'Preparing download…',
  downloading: 'Downloading update…',
  paused: 'Download paused',
  verifying: 'Verifying package…',
  ready: 'Ready to install',
  installing: 'Installing update…',
  error: 'Update failed',
};

const UPDATE_LEADS = {
  checking: 'Looking for a newer release.',
  available: 'A newer version is available. Your settings and cached tracks are kept.',
  preparing: 'Getting the download ready. Your current version keeps working.',
  downloading: 'Downloading in the background. Your settings and cached tracks are kept.',
  paused: 'The download is paused. Your partial download is kept.',
  verifying: 'The download is complete. Checking it before anything is installed.',
  ready: 'The update is downloaded and verified. Esmeringhoy will close, install, and reopen itself.',
  installing: 'Esmeringhoy is closing to install the update. It reopens by itself when done.',
  error: 'The update could not be completed. Your current version keeps running.',
};

function renderUpdate(state) {
  if (!state || !state.phase) return;
  updateState = state;
  const phase = state.phase;
  const info = state.info || null;
  const total = Math.max(0, Number(state.total) || 0);
  const downloaded = Math.max(0, Number(state.downloaded) || 0);
  const rawPct = state.percent === null || state.percent === undefined ? null : Number(state.percent);
  const pct = rawPct === null || Number.isNaN(rawPct) ? null : Math.max(0, Math.min(100, Math.round(rawPct)));
  const complete = phase === 'ready' || phase === 'installing';

  $('#updCurrent').textContent = `v${state.currentVersion || ''}`;
  $('#updVersion').textContent = info ? `v${info.version || ''}` : '';
  $('#updVersions').hidden = !info;

  const notes = info ? cleanNotes(info.notes) : '';
  $('#updNotes').textContent = notes.slice(0, 900);
  $('#updNotes').hidden = !notes || phase !== 'available';

  const showProgress = Boolean(info) && (
    phase === 'preparing' || phase === 'downloading' || phase === 'paused'
    || phase === 'verifying' || phase === 'ready' || phase === 'installing' || phase === 'error'
  );
  const progress = $('#updProgress');
  const meter = $('#updMeter');
  progress.hidden = !showProgress;
  progress.classList.toggle('is-live', phase === 'preparing' || phase === 'downloading' || phase === 'verifying' || phase === 'installing');
  progress.classList.toggle('is-error', phase === 'error');
  progress.classList.toggle('is-done', phase === 'ready');

  const indeterminate = showProgress && phase === 'preparing'
    ? true
    : showProgress && !complete && phase !== 'error' && pct === null;

  $('#updProgressText').textContent = UPDATE_LABELS[phase] || '';
  $('#updProgressPct').textContent = phase === 'error'
    ? ''
    : complete
      ? '100%'
      : indeterminate || phase === 'preparing'
        ? ''
        : pct === null ? '' : `${pct}%`;

  setScaleX($('#updProgressBar'), complete ? 100 : phase === 'error' || indeterminate || pct === null ? 0 : pct);
  meter.classList.toggle('is-indeterminate', indeterminate);
  if (indeterminate) meter.removeAttribute('aria-valuenow');
  else meter.setAttribute('aria-valuenow', String(complete ? 100 : pct === null ? 0 : pct));
  meter.setAttribute('aria-valuetext', complete
    ? 'Update verified'
    : pct === null ? UPDATE_LABELS[phase] || 'Downloading' : `${UPDATE_LABELS[phase] || 'Downloading'}, ${pct}%`);

  const detail = $('#updProgressDetail');
  const rate = $('#updProgressRate');
  const hint = $('#updHint');
  hint.hidden = true;
  hint.textContent = '';
  rate.textContent = '';

  if (phase === 'preparing') {
    detail.textContent = total > 0 ? `Package size ${fmtBytes(total)}` : 'Contacting the release server…';
    hint.textContent = 'Checking free disk space before starting.';
    hint.hidden = false;
  } else if (phase === 'downloading') {
    detail.textContent = total > 0 ? `${fmtBytes(downloaded)} of ${fmtBytes(total)}` : `${fmtBytes(downloaded)} downloaded`;
    rate.textContent = [fmtRate(state.bytesPerSec), fmtEta(state.etaSecs)].filter(Boolean).join(' · ');
  } else if (phase === 'paused') {
    detail.textContent = `${fmtBytes(downloaded)} of ${fmtBytes(total)}`;
    hint.textContent = 'Resume continues from the bytes already saved — nothing restarts from zero.';
    hint.hidden = false;
  } else if (phase === 'verifying') {
    detail.textContent = `${fmtBytes(downloaded || total)} downloaded`;
    rate.textContent = 'SHA-256';
    hint.textContent = 'Comparing the package against the release digest. Installation stays blocked until it matches.';
    hint.hidden = false;
  } else if (phase === 'ready') {
    detail.textContent = `${fmtBytes(total)} · SHA-256 match`;
    rate.textContent = state.signature === 'authenticode' ? 'Signed' : state.signature === 'unsigned' ? 'Unsigned' : '';
    if (state.signature === 'unsigned') {
      hint.textContent = 'This release is not Authenticode-signed. The SHA-256 digest published with the GitHub release matched exactly.';
      hint.hidden = false;
    }
  } else if (phase === 'installing') {
    detail.textContent = 'Closing and running the installer…';
    hint.textContent = 'Esmeringhoy reopens by itself when the installation finishes.';
    hint.hidden = false;
  } else if (phase === 'error') {
    detail.textContent = state.error || 'The update could not be completed.';
    hint.textContent = 'Nothing was installed. Try again — a partial download resumes from where it stopped.';
    hint.hidden = false;
  }

  const now = $('#updNow');
  const pauseBtn = $('#updPause');
  const cancelBtn = $('#updCancel');
  const laterBtn = $('#updLater');
  now.disabled = false;
  pauseBtn.disabled = false;

  if (phase === 'downloading') {
    now.hidden = true;
    pauseBtn.hidden = false;
    pauseBtn.textContent = 'Pause';
    cancelBtn.hidden = false;
  } else if (phase === 'preparing') {
    now.hidden = true;
    pauseBtn.hidden = true;
    cancelBtn.hidden = false;
  } else if (phase === 'paused') {
    now.hidden = false;
    now.textContent = 'Resume download';
    pauseBtn.hidden = true;
    cancelBtn.hidden = false;
  } else if (phase === 'verifying') {
    now.hidden = true;
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else if (phase === 'installing') {
    now.hidden = true;
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else if (phase === 'ready') {
    now.hidden = false;
    now.textContent = state.canInstall ? 'Install & restart' : 'Open release page';
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else if (phase === 'error') {
    now.hidden = false;
    now.textContent = 'Try again';
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else if (phase === 'checking') {
    now.hidden = false;
    now.textContent = 'Checking…';
    now.disabled = true;
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else if (phase === 'available') {
    now.hidden = false;
    now.textContent = state.canInstall ? 'Download update' : 'Open release page';
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  } else {
    now.hidden = true;
    pauseBtn.hidden = true;
    cancelBtn.hidden = true;
  }

  laterBtn.hidden = UPDATE_BUSY.has(phase) || phase === 'checking';
  laterBtn.textContent = phase === 'error' ? 'Close' : 'Later';
  $('#updClose').disabled = phase === 'installing';
  if (UPDATE_LEADS[phase]) $('#updLead').textContent = UPDATE_LEADS[phase];
}

function openUpdateModal() {
  $('#updModal').hidden = false;
}

async function checkForUpdates(manual = false) {
  if (updateState && UPDATE_BUSY.has(updateState.phase)) {
    if (manual) toast('An update is already in progress');
    return;
  }
  try {
    const state = await invoke('check_update', { force: Boolean(manual) });
    renderUpdate(state);
    if (state?.available && state.info) {
      const version = state.info.version || '';
      if (manual || sessionStorage.getItem(UPDATE_SKIP_KEY) !== version) openUpdateModal();
    } else if (manual) {
      toast(`Esmeringhoy ${state?.currentVersion || ''} is up to date`);
    }
  } catch (err) {
    if (manual) toast(updateErrText(err) || 'Could not check for updates');
  }
}

function closeUpdate() {
  if (updateState?.phase === 'installing') return;
  $('#updModal').hidden = true;
}

listen('update:state', (event) => {
  const state = event?.payload;
  if (!state || !state.phase) return;
  const previous = lastUpdatePhase;
  lastUpdatePhase = state.phase;
  renderUpdate(state);
  if (state.phase === 'ready' && previous !== 'ready' && $('#updModal').hidden) {
    openUpdateModal();
    toast(`Esmeringhoy ${state.info?.version ? `v${state.info.version}` : 'update'} is verified and ready to install`);
  } else if (state.phase === 'error' && previous !== 'error' && $('#updModal').hidden) {
    toast(state.error || 'The update failed');
  }
});

$('#updClose').addEventListener('click', closeUpdate);
$('#updBackdrop').addEventListener('click', closeUpdate);
$('#updLater').addEventListener('click', () => {
  if (updateState?.phase === 'available' && updateState.info) {
    sessionStorage.setItem(UPDATE_SKIP_KEY, updateState.info.version || '');
  }
  closeUpdate();
});
$('#updNow').addEventListener('click', async () => {
  const phase = updateState?.phase;
  try {
    if (!updateState?.canInstall && (phase === 'available' || phase === 'ready')) {
      const url = updateState?.info?.htmlUrl;
      if (url) await invoke('open_url', { url });
      return;
    }
    if (phase === 'ready') await invoke('install_update');
    else if (phase === 'available' || phase === 'paused' || phase === 'error') await invoke('start_update_download');
  } catch (err) {
    toast(updateErrText(err) || 'The update could not be started');
  }
});
$('#updPause').addEventListener('click', async () => {
  try {
    if (updateState?.phase === 'paused') await invoke('start_update_download');
    else await invoke('pause_update');
  } catch (err) {
    toast(updateErrText(err) || 'The download could not be paused');
  }
});
$('#updCancel').addEventListener('click', async () => {
  try {
    await invoke('cancel_update');
    toast('Update download cancelled');
  } catch (err) {
    toast(updateErrText(err) || 'The download could not be cancelled');
  }
});

async function refreshVersion() {
  try {
    const h = await invoke('app_health');
    $('#setVersion').textContent = `Esmeringhoy ${h?.version || ''}`;
  } catch {}
}

async function announceUpdateResult() {
  try {
    const result = await invoke('update_take_result');
    if (!result) return;
    if (result.status === 'installed') {
      toast(`Esmeringhoy updated to v${result.version}`);
      refreshVersion();
    } else if (result.status === 'failed') {
      const why = result.code && result.code !== 'timeout'
        ? `installer exit code ${result.code}`
        : 'the installer did not finish';
      toast(`The update to v${result.version} did not complete (${why})`);
    }
  } catch {}
}

$('#setCheck').addEventListener('click', () => checkForUpdates(true));

$('#cacheClear').addEventListener('click', async () => {
  try {
    const freed = await invoke('cache_clear');
    toast(`Freed ${fmtBytes(freed || 0)}`);
  } catch {}
  refreshCacheStats();
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await invoke('auth_sign_out'); } catch {}
  signOutLocally();
  $('#authUser').value = '';
  $('#authPass').value = '';
  $('#authPass2').value = '';
});

async function runGate() {
  try {
    const res = await netFetch('/api/gate');
    if (res.ok) {
      const body = await res.json();
      regMode = body.registration || 'open';
    }
  } catch {}
  return true;
}

async function boot() {
  try {
    API_BASE = await invoke('api_base').catch(() => '');
  } catch {}
  announceUpdateResult();
  loadCaptchaConfig();
  invoke('update_state').then((state) => renderUpdate(state)).catch(() => {});
  const settings = await loadSettingsState().catch(() => null);
  try {
    await runGate();

    const restored = await invoke('auth_restore').catch(() => null);
    if (!restored?.signedIn) {
      setUser(null);
      showAuth(authModeForPath(location.pathname) || 'login');
      return;
    }
    setUser(restored.user || { username: '' });

    const st = await readInitialState();
    if (st?.auth) {
      showAuth(authModeForPath(location.pathname) || 'login');
      return;
    }
    if (st?.snap) apply(st.snap);
    else $('#view').innerHTML = `<div class="empty"><div class="big">Connecting…</div><div>Waiting for the Esmeringhoy server — retrying in the background.</div></div>`;
    routingReady = true;

    if (S) {
      const wanted = viewForPath(location.pathname);
      const artistId = artistIdFromPath(location.pathname);
      const q = new URLSearchParams(location.search).get('q');

      if (authModeForPath(location.pathname)) {
        setPath(pathForView(S.view), { replace: true });
      } else if (artistId) {
        await openArtist(artistId);
      } else if (wanted === 'search' && q) {
        await runSearch(q);
      } else if (wanted && wanted !== S.view) {
        await send('setView', { view: wanted });
      } else {
        setPath(pathForView(S.view), { replace: true });
      }
    } else {
      setPath('/home', { replace: true });
    }

    connectStream();
    loadCatalog();
    if (settings?.autoUpdateCheck !== false) {
      setTimeout(() => checkForUpdates(false), 5000);
    }
  } catch {
    $('#view').innerHTML = `<div class="empty"><div class="big">Server not reachable</div><div>Check your connection — the app could not reach the Esmeringhoy server.</div></div>`;
  } finally {
    document.documentElement.classList.remove('booting');
  }
}

async function readInitialState(attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await netFetch('/api/state');
      if (res.status === 401) return { auth: true };
      if (res.ok) return { snap: await res.json() };
    } catch {}
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
}

setUser(null);
requestAnimationFrame(frame);
// Refresh the Discord progress bar a few times per minute while playing;
// the engine dedupes by 5% bucket, so most ticks cost nothing.
setInterval(() => {
  if (engineIsPlayingCurrent()) invoke('discord_rpc_sync').catch(() => {});
}, 5000);
boot();
