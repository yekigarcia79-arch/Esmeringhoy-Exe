import { parsePlaylistExport } from './spotify.js';

// ---- desktop bridge ---------------------------------------------------------
// The webview talks to Rust, never to the network directly. All /api calls
// go over IPC; the session token lives in the OS credential manager.
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

/// Response-compatible wrapper over the IPC api_call command.
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

let S = null;
let me = null;
let pollTimer = null;
let viewList = [];
let viewCtx = {};
let plDetail = null;
let artistDetail = null;
let lastRev = -1;
let lastViewSig = '';

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

// The server owns the view, so a click both moves the URL and asks for it.
function go(view) {
  if (!me) {
    showAuth('login');
    return;
  }
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

const thumbUrl = (name) => `/api/thumb?name=${encodeURIComponent(name)}`;

// YouTube hands out =w120-h120 thumbnails, which is a three-fold upscale in the
// Now view. The same asset is served at any size, so ask for one that matches
// where it lands — rows stay cheap, the big art does not turn to mush.
const thumbAt = (url, size) =>
  String(url || '').replace(/=w\d+-h\d+/, `=w${size}-h${size}`);

function art(url, seed, cls = '', size = 0) {
  const src = url ? (size ? thumbAt(url, size) : url) : letterTile(seed);
  return `<img class="${cls}" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy" decoding="async" data-seed="${esc(seed || '')}">`;
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

// ---- engine bridge -----------------------------------------------------------
// Rust owns the audio (download → decode → cpal output). `audio` is a
// read-mostly shim that keeps the ported UI's clock semantics; mutations
// (seek, volume) are forwarded to the engine.
const audio = {
  _pos: 0, _dur: 0, _paused: true, _ended: false,
  get currentTime() { return this._pos; },
  set currentTime(t) { this._pos = Math.max(0, Number(t) || 0); invoke('engine_seek', { secs: this._pos }).catch(() => {}); },
  get duration() { return this._dur; },
  get paused() { return this._paused; },
  get ended() { return this._ended; },
  set volume(v) { invoke('engine_set_volume', { volume: v }).catch(() => {}); },
  play() { this._paused = false; },
  pause() { this._paused = true; },
  load() {},
  removeAttribute() {},
};

let engineTrackId = '';
let engineSeq = -1;
let pendingSeek = null;

function applyVolume(s) {
  const gain = Math.min(1, Number(s.gain) || 1);
  const target = Math.max(0, Math.min(1, (Number(s.volume) || 0) / 100 * gain));
  invoke('engine_set_volume', { volume: target }).catch(() => {});
}

async function loadEngineTrack(track, transport) {
  try {
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
  }
}

// The server owns playback; the engine follows the snapshot. A track loads
// when it is new, or when playSeq moved (repeat-one replays the same one).
function reconcileEngine(s) {
  if (!s) return;
  const cur = s.current;
  const id = cur?.videoId || '';
  const seq = Number(s.playSeq) || 0;
  if (id) {
    const fresh = id !== engineTrackId;
    const restarted = !fresh && seq !== engineSeq;
    engineTrackId = id;
    engineSeq = seq;
    if (fresh || restarted) loadEngineTrack(cur, s.transport);
    else invoke('engine_set_transport', { transport: s.transport || 'idle' }).catch(() => {});
  } else if (engineTrackId) {
    engineTrackId = '';
    engineSeq = -1;
    invoke('engine_stop').catch(() => {});
  }
  applyVolume(s);
}

// Explicit transport change from the UI (video frame play/pause, lyric click).
function setTransport(state) {
  if (S) S.transport = state;
  invoke('engine_set_transport', { transport: state }).catch(() => {});
  send('transport', { state }, { silent: true });
}

const videoSrcCache = new Map();

// <video> cannot carry an Authorization header, so it plays from a signed
// (5-minute, single-video) URL minted through the session.
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

// Engine → the UI (position for the lyric highlighter, body class, errors).
listen('player:position', (e) => {
  const p = e?.payload || {};
  audio._pos = Number(p.pos) || 0;
  audio._dur = Number(p.duration) || 0;
  audio._paused = p.state !== 'playing';
  document.body.classList.toggle('is-playing', p.state === 'playing');
});
listen('player:loading', (e) => {
  const p = e?.payload || {};
  if (S && p.videoId && S.current?.videoId === p.videoId && p.progress >= 0) {
    S.status = `Buffering ${Math.round(p.progress * 100)}%`;
    try { renderChrome(); } catch {}
  }
});
listen('player:track-changed', () => { try { renderPlayer(); } catch {} });
listen('player:error', (e) => toast(e?.payload?.message || 'Playback failed'));
listen('player:idle', () => { if (S) { S.transport = 'idle'; try { renderPlayer(); } catch {} } });

let scrubbing = false;

// Video is the same track, different picture: a muted video stream played
// against the audio element, which stays the clock and the sound.
let videoMode = false;
let videoEl = null;
let barVideoEl = null;
let videoBusy = false;
// The track the frame was last mounted for. The bar tile has to follow the
// track on every view, but renderView() only rebuilds when the view's own
// signature changes — so the mount is also driven from apply().
let videoMountedFor = '';
// True while the native bar is being dragged: the drift correction has to stand
// down, or it snaps the picture back to the audio clock mid-scrub.
let videoSeeking = false;

// Mode switches (Audio↔Video) carry the position to the new upload of the
// same song — the pending seek is applied by the loader once the track
// starts.
let carryTo = ''; // kept for setVideoMode's stale-carry check

function carryPosition(videoId) {
  const at = audio.currentTime || 0;
  if (!videoId || !Number.isFinite(at) || at <= 1) return;
  carryTo = videoId;
  pendingSeek = { id: videoId, t: at };
}

async function findVideo(t) {
  try {
    // The id rules out the track's own art track (the cover encoded as a
    // still); the duration tells a real video from the same recording.
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

// Which song a music video was swapped in for, so Audio can put it back. Kept
// in the tab so a reload mid-video still knows what to return to.
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

    // Back to the song, not just back to the artwork: the video's audio is a
    // different edit, so leaving it playing is not "audio mode".
    const cur = S?.current;
    if (cur && cur.video && !videoBusy) {
      let back = pairedAudio(cur.videoId);

      // A video opened straight from an artist's shelf has no song recorded,
      // so go and find one.
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

  // A song search returns an art track — the album cover encoded as a still —
  // so its "video" is a photo. Find the real music video and play that, which
  // also keeps picture and sound on one timeline.
  if (!cur.video) {
    videoBusy = true;
    toast('Finding the video…');
    try {
      const mv = await findVideo(cur);

      // Nothing ranked above the song itself: its "video" is the cover as a
      // still. Switching would put a frozen picture in the frame, which is the
      // thing this button exists to avoid, so say why and stay put.
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

// The video element only exists while the Now view is on screen, so it is
// mounted after each render and dropped when the view goes away. The bar keeps
// a second, low-quality one so the thumbnail is live without pulling a second
// 1080p stream.
//
// Called from renderView() and from apply() on every track change, so it has
// to be idempotent: re-assigning the same src reloads the stream from zero,
// which would stutter once per poll.
function mountVideo() {
  const id = S?.current?.videoId;
  const now = $('#npVideo');
  const bar = $('#npBarVideo');

  // The view is rebuilt from HTML, so the previous track's frame is a detached
  // element rather than a reused one — and a detached <video> keeps its stream
  // open until it is told to stop.
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

        // A hidden tab drops this stream all the time — the decoder is
        // throttled and the relayed response times out. That is not a track
        // without a video, so nothing is decided until the tab is looked at.
        if (document.hidden) return;

        // One quiet reopen first: a stale stream usually clears.
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

      // The native bar seeks the video, but the audio is the clock — so a seek
      // here has to move the audio, or the next frame drags the video back.
      // Our own drift correction lands within milliseconds of the audio, so
      // anything further apart is a real seek.
      now.addEventListener('seeking', () => { videoSeeking = true; });
      now.addEventListener('seeked', () => {
        videoSeeking = false;
        if (Math.abs(now.currentTime - audio.currentTime) < 0.5) return;
        audio.currentTime = now.currentTime;
      });

      // Full screen exposes play/pause too; mirror them so the sound follows
      // the picture instead of carrying on underneath a frozen frame.
      let wasPlaying = false;
      now.addEventListener('playing', () => { wasPlaying = true; });
      now.addEventListener('play', () => {
        if (audio.paused) setTransport('playing');
      });
      now.addEventListener('pause', () => {
        // Tearing the frame down calls pause() on an element that is already
        // out of the document; that is not the listener pausing the song.
        if (!wasPlaying || !now.isConnected) return;
        wasPlaying = false;
        if (!audio.paused && !now.ended) setTransport('paused');
      });
    }).catch((e) => { try { invoke('web_log', { message: `[video] mount failed: ${e}` }); } catch {} });
    videoEl = now;
  }

  if (bar) {
    if (!videoMode || !id) {
      // Off means no stream at all, not a hidden one still downloading.
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

// A hidden tab does not keep a relayed stream alive: the decoder is throttled
// and the Worker's response can time out, leaving an element that play() just
// rejects on. The audio is untouched, so the picture is reopened at the audio's
// position instead of being dropped.
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

// The audio element is the clock. The video is muted and nudged back into
// line when it drifts, rather than being seeked every frame.
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

  S = snap;

  // Video mode belongs to the track that has a video. When the queue moves on
  // to a song, the frame would show that song's cover as a still — a video
  // frame whose picture does not move, and does not match what you hear.
  // Dropping back to artwork is the honest thing.
  if (videoMode && S.current && !S.current.video) {
    videoMode = false;
    lastViewSig = '';
  }

  if ($('#sug') && !$('#sug').hidden) renderSuggestions();

  reconcileEngine(snap);
  renderChrome();
  renderGate();
  // The bar is always on screen and the only thing showing what is playing, so
  // it is painted before the view. A view renderer that throws used to leave it
  // on the previous track's artwork while the new track played.
  renderPlayer();
  renderView();

  // renderView() only rebuilds when the view's own signature changes, so on
  // Home or Search the bar's video tile would keep the previous track's stream
  // while the next track plays — the picture and the sound drift apart. Mount
  // on a track change whatever the view did.
  const curId = snap.current?.videoId || '';
  if (curId !== videoMountedFor) {
    videoMountedFor = curId;
    mountVideo();
  }

  // A command can change the view server-side (skip the gate, start a
  // playlist), so the URL follows the snapshot rather than the other way round.
  if (routingReady && !authOpen) {
    const p = pathForView(S.view);
    if (location.pathname + location.search !== p) setPath(p, { replace: true });
  }
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

  // The bar thumbnail becomes the video itself while video mode is on, and the
  // button goes 16:9 so the picture fills it rather than shrinking inside a
  // square.
  const barVid = $('#npBarVideo');
  const barImg = $('#npImg');
  const barArt = $('#npArt');
  if (barVid) barVid.hidden = !(videoMode && has);
  if (barImg) barImg.hidden = videoMode && has;
  if (barArt) barArt.classList.toggle('is-video', videoMode && has);

  $('#npArt').classList.toggle('playing', S.transport === 'playing');

  const playing = S.transport === 'playing';
  const wantsPlay = playing || S.transport === 'loading';
  const btn = $('#btnPlay');
  btn.classList.toggle('is-playing', wantsPlay);
  btn.classList.toggle('is-loading', S.transport === 'loading');
  btn.title = wantsPlay ? 'Pause' : 'Play';
  btn.setAttribute('aria-label', wantsPlay ? 'Pause' : 'Play');

  $('#btnShuffle').classList.toggle('on', !!S.shuffle);
  $('#btnShuffle').setAttribute('aria-pressed', S.shuffle ? 'true' : 'false');

  const rep = $('#btnRepeat');
  rep.classList.toggle('on', S.repeat !== 0);
  rep.classList.toggle('is-one', S.repeat === 2);
  rep.title = ['Repeat off', 'Repeat all', 'Repeat one'][S.repeat];
  rep.setAttribute('aria-pressed', S.repeat !== 0 ? 'true' : 'false');

  $('#btnNext').disabled = !(S.queueCount > 0);

  $('#volume').value = S.volume;
  setFill($('#volume'), S.volume);
  $('#volNum').textContent = S.volume;

  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : has ? cur.durationSec : 0;
  $('#tDur').textContent = fmt(dur);
}

function setFill(input, pct) {
  if (!input) return;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct || 0))}%`);
}

function viewSignature() {
  if (!S) return '';
  switch (S.view) {
    case 'search': return `search:${S.results.length}:${S.status}:${S.artistHit?.browseId || ''}`;
    case 'artist': return `ar:${artistDetail?.id || ''}:${artistDetail?.loading ? 1 : 0}:${artistDetail?.tracks?.length ?? -1}:${(S.selectedArtists || []).includes(artistDetail?.name) ? 1 : 0}`;
    case 'mix': return `mix:${S.mix?.length}:${S.mixLoading}:${S.selectedArtists.join(',')}`;
    case 'playlists': return `pl:${plDetail?.id || ''}:${plDetail?.tracks?.length ?? -1}:${S.playlists.length}`;
    case 'queue': return `q:${S.queueCount}:${S.current?.videoId || ''}:${S.transport}`;
    case 'lyrics': return `ly:${S.current?.videoId || ''}:${S.lyrics?.source || ''}:${S.lyrics?.lines?.length || 0}:${videoMode ? 1 : 0}`;
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

  switch (S.view) {
    case 'search': view.innerHTML = renderSearchView(); break;
    case 'artist': view.innerHTML = renderArtistView(); break;
    case 'mix': view.innerHTML = renderMixView(); break;
    case 'playlists': view.innerHTML = renderPlaylistsView(); break;
    case 'queue': view.innerHTML = renderQueueView(); break;
    case 'lyrics': view.innerHTML = renderLyricsView(); break;
    case 'now': view.innerHTML = renderNowView(); break;
    default: view.innerHTML = renderHomeView(); break;
  }


  $('#content').scrollTop = scroll;
  mountVideo();
  refreshLiveBits();
}

function refreshLiveBits() {
  if (S.view === 'lyrics') updateLyricHighlight(true);
  if (S.view === 'queue') {
    const bar = $('.now-card .mini-bar i');
    if (bar && audio.duration) bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
  }
}

function trackRow(t, i, opts = {}) {
  const isCurrent = S.current && S.current.videoId === t.videoId;
  const actions = [];
  const playAct = opts.queueMode ? 'queueplay' : 'play';

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
    <div class="row ${isCurrent ? 'on is-current' : ''}" style="--i:${i}" data-act="${playAct}" data-i="${i}" tabindex="0" role="button" aria-label="Play ${esc(t.title)}">
      <div class="r-idx">${isCurrent ? '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' : i + 1}</div>
      <div class="r-art">${art(t.thumb, t.title, '', 120)}<span class="play-hint">${icon('play')}</span></div>
      <div class="r-main">
        <div class="r-title">${esc(t.title)}</div>
        <div class="r-sub">${esc(t.artist || 'Unknown artist')}</div>
      </div>
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

  // Video cards index into the same list as the song rows, so one click
  // handler plays either.
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
  // Following an artist is what puts their tracks in the mix, so the button
  // reads the same list the mix is built from.
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

// --- loading a playlist out of a file --------------------------------------

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
  if (bar) bar.style.width = `${pct}%`;
}

// A playlist file is matched ten rows at a time: every request stays short
// enough to finish, and the page can show how far along it is.
async function importPlaylistFile(file) {
  if (!file || importBusy) return;

  const text = await file.text().catch(() => '');
  const { rows, skipped } = parsePlaylistExport(text);
  if (!rows.length) {
    toast('No tracks found in that file');
    return;
  }

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
      toast('Nothing in that file could be matched');
      return;
    }

    importProgress(rows.length, rows.length, 'Saving…');

    // A CSV carries no playlist name of its own; Exportify saves the file under
    // the playlist's name, so the file name is the best guess.
    const name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 60) || 'From Spotify';
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
    if (bar) bar.style.width = '0%';
    const input = $('#plFile');
    if (input) input.value = '';
  }
}

// The drop zone is rebuilt with the view, so the picker and the drag target are
// handled at the document rather than bound per render.
document.addEventListener('change', (e) => {
  if (e.target?.id === 'plFile') importPlaylistFile(e.target.files?.[0]);
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
      <p class="sub">Export any playlist with <a class="link" href="https://exportify.net" target="_blank" rel="noopener">Exportify</a>, then drop the CSV here. Each track is matched to something this player can stream.</p>
    </div></div>
    <div class="pl-load" id="plLoad">
      <input type="file" id="plFile" accept=".csv,text/csv,.json,application/json,.txt" hidden>
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

function renderLyricsView() {
  const lyr = S.lyrics || {};
  const cur = S.current;
  viewList = [];
  viewCtx = {};

  if (!cur) {
    return `<div class="lyrics-wrap single"><div class="lyrics-head"><div><p class="eyebrow">Lyrics</p><h2>Nothing playing</h2></div></div>
      <div class="lyr-empty">Play something and the lyrics arrive on their own.</div></div>`;
  }

  // Watching the video means watching, not reading. Nothing here, and nothing
  // on the Now view either.
  if (videoMode) {
    return `<div class="lyrics-wrap single">
      <div class="lyrics-head"><div><p class="eyebrow">Lyrics</p><h2>${esc(cur.title)}</h2></div></div>
      <div class="lyr-empty">Lyrics are off while the video is on. Switch back to Audio to read them.</div>
    </div>`;
  }

  let body = '';
  if (S.lyricsPending) {
    body = `<div class="lyr-empty">Looking for lyrics…</div>`;
  } else if (lyr.synced && lyr.lines?.length) {
    body = lyr.lines.map((l, i) => `<button class="lyr-line" tabindex="-1" title="Jump to this line" data-t="${l.t}" data-i="${i}">${esc(l.text)}</button>`).join('');
  } else if (lyr.plain) {
    body = lyr.plain.split('\n').filter((x) => x.trim()).map((x) => `<div class="lyr-line plain">${esc(x)}</div>`).join('');
  } else if (lyr.instrumental) {
    body = `<div class="lyr-empty">Instrumental — no lyrics to show.</div>`;
  } else if (lyr.notFound) {
    body = `<div class="lyr-empty">No lyrics found for this track.</div>`;
  } else {
    body = `<div class="lyr-empty">Looking for lyrics…</div>`;
  }

  return `
    <div class="lyrics-wrap">
      <aside class="lyr-side">
        <div class="lyr-art">${art(cur.thumb, cur.title, '', 640)}</div>
        <p class="eyebrow">${esc(lyr.sourceName || 'Lyrics')}</p>
        <h2>${esc(cur.title)}</h2>
        <p class="lyr-by">${esc(cur.artist || '')}${cur.album ? ` <em>·</em> ${esc(cur.album)}` : ''}</p>
        <div class="lyr-actions">
          <button class="btn ghost" data-act="lyrcycle">Try another source</button>
          <button class="btn ghost" data-act="lyrSources">Sources</button>
        </div>
      </aside>
      <section class="lyr-main">
        <div class="lyrics-body" id="lyrBody">${body}</div>
        <div class="lyr-tools">
          <span class="offset">
            Offset
            <button data-act="lyrminus" aria-label="Lyrics earlier">−0.5</button>
            <span id="lyrOffset">${(S.lyOffset || 0).toFixed(1)}s</span>
            <button data-act="lyrplus" aria-label="Lyrics later">+0.5</button>
          </span>
          <span style="margin-left:auto">${lyr.synced ? 'Synced' : lyr.plain ? 'Plain text' : '—'}</span>
        </div>
      </section>
    </div>`;
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

// Scroll the lyric column ourselves instead of asking for behavior:'smooth'.
// The native version is a fixed ~300ms no matter how far the line has to
// travel, so a line that jumps half a page lurches; and with reduced motion
// on, `scroll-behavior: auto !important` in the stylesheet can override it
// into an instant snap. This eases over a distance-scaled duration and can be
// cancelled the moment the reader takes over.
function glideTo(box, top) {
  cancelAnimationFrame(glideRaf);
  const from = box.scrollTop;
  const to = Math.max(0, top);
  const dist = to - from;
  if (Math.abs(dist) < 1) return;

  const ms = Math.min(950, 420 + Math.abs(dist) * 0.6);
  const t0 = performance.now();
  // Ease in and out: a pure ease-out front-loads the movement, which reads as
  // a lurch on the first frame.
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    box.scrollTop = from + dist * ease(p);
    if (p < 1) glideRaf = requestAnimationFrame(step);
  };
  glideRaf = requestAnimationFrame(step);
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
  const nodes = document.querySelectorAll('.lyr-line');

  if (idx !== lastLyricIdx || force) {
    lastLyricIdx = idx;
    nodes.forEach((n, i) => {
      n.classList.toggle('now', i === idx);
      n.classList.toggle('past', i < idx);
      if (i !== idx) n.style.removeProperty('--p');
    });

    const active = nodes[idx];
    if (active && Date.now() - userScrolledAt > 4000) {
      const box = $('#content');
      const r = active.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      const delta = r.top - br.top - box.clientHeight / 2 + r.height / 2;
      glideTo(box, box.scrollTop + delta);
    }
  }

  // How far through the active line the song is. This runs every frame, not only
  // when the line changes, so the white edge sweeps with the vocal instead of
  // the whole line snapping to white.
  if (idx >= 0) {
    const line = lyr.lines[idx];
    const next = lyr.lines[idx + 1];
    const span = next ? Math.max(0.5, next.t - line.t) : 4;
    const p = Math.max(0, Math.min(1, (pos - line.t) / span));
    nodes[idx]?.style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
  }
}

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
        <span class="tile-art">${art(a.thumb || thumbUrl(a.name), a.name, '', 240)}<span class="tile-tick">${icon('check')}</span></span>
        <span class="tile-name">${esc(a.name)}</span>
      </button>`).join('')
    : CAT.ready
      ? `<p class="gate-empty">No artists in this list right now. Try the other tab, or skip and search for anything.</p>`
      : skeletonTiles(12);

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

$('#btnPlay').addEventListener('click', () => send('togglePlay'));
$('#btnNext').addEventListener('click', () =>
  send('next', { pos: audio.currentTime || 0, dur: audio.duration || 0 }));
$('#btnPrev').addEventListener('click', () => {
  if (audio.currentTime > 3) audio.currentTime = 0;
  else send('prev');
});
$('#btnShuffle').addEventListener('click', () => send('shuffle'));
$('#btnRepeat').addEventListener('click', () => send('repeat'));

// The two views worth reaching without leaving the bar.
$('#btnQueue').addEventListener('click', () => go('queue'));
$('#btnLyrics').addEventListener('click', () => go('lyrics'));

$('#npArt').addEventListener('click', () => {
  if (S?.hasCurrent) go('now');
});
$('#npAdd').addEventListener('click', () => openPlaylistModal(S?.current));

$('#volume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  setFill(e.target, v);
  $('#volNum').textContent = v;
  audio.volume = Math.max(0, Math.min(1, v / 100));
});
$('#volume').addEventListener('change', (e) => send('volume', { pct: Number(e.target.value) }, { silent: true }));

$('#btnMute').addEventListener('click', () => {
  const v = S?.volume > 0 ? 0 : 70;
  send('volume', { pct: v });
});

$('#seek').addEventListener('input', (e) => {
  scrubbing = true;
  const dur = audio.duration || 0;
  if (!dur) return;
  const want = Math.min(dur, Math.max(0, Number(e.target.value) || 0));
  audio.currentTime = want;
  setFill(e.target, (want / dur) * 100);
});
$('#seek').addEventListener('change', () => { scrubbing = false; });

$('#view').addEventListener('click', (e) => {
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
});

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

$('#view').addEventListener('click', async (e) => {
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
      break;
    }
    case 'plpick':
      $('#plFile')?.click();
      break;
    case 'plcancel':
      if (importBusy) {
        importAbort = true;
        toast('Stopping…');
      }
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
      send('lyricsCycle', { from: S?.lyrics?.source || '' });
      break;
    case 'lyrSources':
      openSourceModal();
      break;
    default:
      break;
  }
});

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
    if (!$('#acctModal').hidden) closeAcctModal();
    else if (!$('#srcModal').hidden) closeSourceModal();
    else if (!$('#plModal').hidden) closePlaylistModal();
    else if (!$('#sug').hidden) hideSuggestions();
    else if (document.activeElement === $('#q')) $('#q').blur();
  }
  if (e.code === 'Space' && !typing && $('#plModal').hidden) {
    e.preventDefault();
    send('togglePlay');
  }
});

function frame() {
  requestAnimationFrame(frame);
  if (!S) return;

  const dur = audio.duration && isFinite(audio.duration) ? audio.duration : (S.current?.durationSec || 0);
  const pos = audio.currentTime || 0;

  if (!scrubbing) {
    const seek = $('#seek');
    seek.max = Math.max(1, Math.floor(dur || 1));
    seek.value = Math.floor(pos);
    setFill(seek, dur ? (pos / dur) * 100 : 0);
  }

  $('#tCur').textContent = fmt(pos);
  if (dur) $('#tDur').textContent = fmt(dur);

  if (S.view === 'lyrics') updateLyricHighlight();
  syncVideo();
  if (S.view === 'queue') {
    const bar = $('.now-card .mini-bar i');
    if (bar && dur) bar.style.width = `${(pos / dur) * 100}%`;
  }
}

let authMode = 'login';

function authError(msg) {
  const el = $('#authError');
  el.textContent = msg || '';
  el.classList.toggle('bad', Boolean(msg));
}

let codeSent = false;
let codeEmail = '';

function renderAuthFields() {
  const isCode = authMode === 'code';
  const isRegister = authMode === 'register';
  const sent = isCode && codeSent;

  $('#fieldUser').hidden = isCode;
  $('#fieldPass').hidden = isCode;
  $('#authConfirmField').hidden = !isRegister;
  $('#fieldInvite').hidden = !isRegister || regMode !== 'invite';

  $('#fieldEmail').hidden = !(isRegister || (isCode && !sent));
  $('#fieldCode').hidden = !sent;
  $('#resendCode').hidden = !sent;
  $('#hintCode').textContent = sent && codeEmail
    ? `Sent to ${codeEmail}. It expires in 10 minutes.`
    : 'It expires in 10 minutes.';

  $('#hintUser').hidden = !isRegister;
  $('#hintPass').hidden = !isRegister;
  $('#authNote').hidden = !isRegister;
  $('#hintEmail').hidden = isCode;

  $('#authSubmit .btn-label').textContent = isCode
    ? (sent ? 'Sign in' : 'Email me a code')
    : (isRegister ? 'Create account' : 'Sign in');

  $('#authPass').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
}

function setAuthMode(mode) {
  if (mode !== authMode) {
    codeSent = false;
    codeEmail = '';
    stopResendCountdown();
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
  $('#userName').textContent = me ? me.username : '—';
  $('#userWrap').hidden = !me;
}

function showAuth(mode = 'login') {
  disconnectStream();
  authOpen = true;
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

  // The picture does not reliably survive a hidden tab: the stream stalls while
  // the audio keeps going. Pick it up again at the audio's position rather than
  // leaving a dead frame behind the title.
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
    const res = await netFetch('/api/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: codeEmail }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const wait = /Wait (\d+)s/.exec(data.error || '');
      authError(data.error || 'Could not resend the code.');
      if (wait) startResendCountdown(Number(wait[1]));
      else renderResend();
      return;
    }

    authError('');
    $('#hintCode').textContent = `New code sent to ${codeEmail}. It expires in 10 minutes.`;
    $('#authCode').value = '';
    $('#authCode').focus();
    startResendCountdown(45);
  } catch {
    authError('Cannot reach the server.');
    renderResend();
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
      const res = await netFetch('/api/auth/email/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        authError(data.error || 'Could not send the code.');
        return;
      }
      codeSent = true;
      codeEmail = email;
      authError('');
      renderAuthFields();
      startResendCountdown(45);
      $('#authCode').focus();
    } catch {
      authError('Cannot reach the server.');
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

  btn.disabled = true;
  btn.classList.add('is-loading');
  $('#authSubmit .btn-label').textContent = 'Signing in…';
  try {
    const res = await netFetch('/api/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: codeEmail, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      authError(data.error || 'That code did not work.');
      return;
    }

    setUser(data.user);
    hideAuth();
    resetClientState();
    apply(data.state);
    connectStream();
    loadCatalog();
    if (data.created) toast('New account created for that address');
    $('#authCode').value = '';
    codeSent = false;
  } catch {
    authError('Cannot reach the server.');
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
      const r = await invoke('auth_sign_in', { username, password });
      user = r?.user || null;
    } else {
      const r = await invoke('auth_register', {
        username,
        password,
        email: $('#authEmail').value.trim() || undefined,
        invite: $('#authInvite').value.trim() || undefined,
      });
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
    btn.disabled = false;
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

$('#logoutBtn').addEventListener('click', async () => {
  try { await invoke('auth_sign_out'); } catch {}
  signOutLocally();
  $('#authUser').value = '';
  $('#authPass').value = '';
  $('#authPass2').value = '';
});

// The desktop is a first-party app: no anti-bot challenge, only the
// registration mode (invite/closed) the server advertises, so the auth
// screen can show the invite field before it is needed.
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
  try {
    await runGate();

    // Silent sign-in: the OS keychain holds the session token; Rust validates it.
    const restored = await invoke('auth_restore').catch(() => null);
    if (!restored?.signedIn) {
      setUser(null);
      showAuth(authModeForPath(location.pathname) || 'login');
      return;
    }
    setUser(restored.user || { username: '' });

    const res = await netFetch('/api/state');
    if (res.status === 401) {
      showAuth(authModeForPath(location.pathname) || 'login');
      return;
    }
    if (res.ok) apply(await res.json());
    routingReady = true;

    // A deep link outranks whatever view was left in the player document.
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
  } catch {
    $('#view').innerHTML = `<div class="empty"><div class="big">Server not reachable</div><div>Check your connection — the app could not reach the Esmeringhoy server.</div></div>`;
  } finally {
    document.documentElement.classList.remove('booting');
  }
}

setUser(null);
requestAnimationFrame(frame);
boot();
