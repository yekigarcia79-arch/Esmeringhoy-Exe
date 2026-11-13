(() => {
  const tauri = window.__TAURI__;
  const invoke = (...a) => {
    if (!tauri?.core?.invoke) throw new Error('Tauri IPC unavailable');
    return tauri.core.invoke(...a);
  };
  const listen = (event, handler) => tauri?.event?.listen?.(event, handler) ?? Promise.resolve(() => {});
  const $ = (sel) => document.querySelector(sel);

  const PLACEHOLDER = $('#art').src;
  const el = {
    island: $('#island'),
    art: $('#art'),
    title: $('#title'),
    artist: $('#artist'),
    elapsed: $('#elapsed'),
    remaining: $('#remaining'),
    seek: $('#seek'),
    fill: $('#fill'),
    thumb: $('#thumb'),
    prev: $('#prev'),
    play: $('#play'),
    playUse: $('#playUse'),
    next: $('#next'),
    output: $('#output'),
    outUse: $('#outUse'),
    vol: $('#vol'),
  };

  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const failedArt = new Set();

  let track = null;
  let duration = 0;
  let position = 0;
  let playing = false;
  let visible = false;

  let volume = 0.7;
  let previousVolume = 0.7;
  let muted = false;

  let seeking = false;
  let seekPreview = 0;
  let seekPointer = null;
  let seekHoldUntil = 0;
  let pinTimer = null;

  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

  function fmt(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function artSrc(url) {
    const value = String(url || '');
    if (!value) return PLACEHOLDER;
    return value.replace(/=w\d+-h\d+/, '=w120-h120');
  }

  function renderTrack() {
    const title = track?.title?.trim() || (track ? 'Unknown track' : 'Nothing playing');
    const artist = track?.artist?.trim() || (track ? 'Unknown artist' : 'Esmeringhoy');

    setText(el.title, title);
    setText(el.artist, artist);
    el.island.setAttribute(
      'aria-label',
      track ? `Now playing: ${title} by ${artist}` : 'Now playing',
    );

    const thumb = track?.thumb || '';
    if (thumb && !failedArt.has(thumb)) {
      const src = artSrc(thumb);
      if (el.art.dataset.src !== src) {
        el.art.dataset.src = src;
        el.art.src = src;
      }
    } else if (el.art.dataset.src !== '') {
      el.art.dataset.src = '';
      el.art.src = PLACEHOLDER;
    }
  }

  function applyVolume(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    volume = clamp01(v);
    if (volume > 0.001) {
      previousVolume = volume;
      muted = false;
    } else {
      muted = true;
    }
    setText(el.vol, muted ? '0' : String(Math.round(volume * 100)));
    el.output.classList.toggle('is-muted', muted);
    el.outUse.setAttribute('href', muted ? '#i-mute' : '#i-volume');
    el.output.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  function updatePlay() {
    el.playUse.setAttribute('href', playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function updateActivity() {
    document.body.classList.toggle('playing', visible && playing);
  }

  function paint(reset = false) {
    const dur = Math.max(0, Number(duration) || 0);
    const pos = seeking ? seekPreview : Math.max(0, Number(position) || 0);
    const fraction = dur > 0 ? clamp01(pos / dur) : 0;

    if (reset) {
      el.fill.style.transition = 'none';
      el.thumb.style.transition = 'none';
    }
    el.fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    el.thumb.style.left = `${(fraction * 100).toFixed(2)}%`;
    if (reset) {
      requestAnimationFrame(() => {
        el.fill.style.transition = '';
        el.thumb.style.transition = '';
      });
    }

    setText(el.elapsed, fmt(pos));
    setText(el.remaining, dur > 0 ? `-${fmt(Math.max(0, dur - pos))}` : '-:--');
    el.seek.setAttribute('aria-valuemin', '0');
    el.seek.setAttribute('aria-valuemax', String(Math.floor(dur)));
    el.seek.setAttribute('aria-valuenow', String(Math.round(pos)));
    el.seek.setAttribute('aria-valuetext', dur > 0 ? `${fmt(pos)} of ${fmt(dur)}` : '0:00');
  }

  function setVisible(on) {
    visible = on;
    document.body.classList.toggle('shown', on);
    updateActivity();
    if (on) paint();
  }

  function applyReduceMotion(preference) {
    document.body.classList.toggle('reduce-motion', !!preference || media.matches);
  }

  async function refreshState() {
    try {
      const s = await invoke('engine_state');
      if (!s) return;
      if (s.track) track = s.track;
      else if (s.state === 'idle') track = null;
      if (Number(s.duration) > 0) duration = Number(s.duration);
      else if (track?.duration) duration = Number(track.duration);
      if (!seeking && performance.now() >= seekHoldUntil) position = Number(s.pos) || 0;
      playing = s.state === 'playing' || s.state === 'loading';
      applyVolume(s.volume);
      renderTrack();
      updatePlay();
      updateActivity();
      if (visible) paint();
    } catch (e) {
      logError('state', e);
    }
    try {
      const settings = await invoke('settings_get');
      applyReduceMotion(!!settings?.reduceMotion);
    } catch {}
  }

  function logError(where, e) {
    try {
      invoke('web_log', { message: `[island] ${where}: ${e}` });
    } catch {}
  }

  function nudge() {
    document.body.classList.remove('nudge');
    void document.body.offsetWidth;
    document.body.classList.add('nudge');
    setTimeout(() => document.body.classList.remove('nudge'), 340);
  }

  function pin(on) {
    invoke('island_pin', { pinned: on }).catch(() => {});
    if (on && !pinTimer) {
      pinTimer = setInterval(() => {
        invoke('island_pin', { pinned: true }).catch(() => {});
      }, 2000);
    } else if (!on && pinTimer) {
      clearInterval(pinTimer);
      pinTimer = null;
    }
  }

  async function playerCommand(cmd, optimistic) {
    if (optimistic) optimistic();
    try {
      await invoke('island_command', { cmd });
    } catch (e) {
      logError(cmd, e);
      nudge();
      refreshState();
    }
  }

  el.prev.addEventListener('click', () => playerCommand('prev'));
  el.next.addEventListener('click', () => playerCommand('next'));
  el.play.addEventListener('click', () =>
    playerCommand('togglePlay', () => {
      playing = !playing;
      updatePlay();
      updateActivity();
    }),
  );

  function toggleMute() {
    const target =
      muted || volume <= 0.001
        ? previousVolume > 0.01
          ? previousVolume
          : 0.7
        : 0;
    if (target === 0) previousVolume = volume;
    applyVolume(target);
    invoke('engine_set_volume', { volume: target }).catch((e) => {
      logError('volume', e);
      refreshState();
    });
  }

  el.output.addEventListener('click', toggleMute);

  function seekFraction(clientX) {
    const rect = el.seek.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }

  function commitSeek(target) {
    const dur = Math.max(0, Number(duration) || 0);
    const value = Math.max(0, Math.min(dur > 0 ? dur : target, Number(target) || 0));
    position = value;
    seekHoldUntil = performance.now() + 700;
    paint();
    invoke('engine_seek', { secs: value }).catch((e) => {
      logError('seek', e);
      refreshState();
    });
  }

  function finishSeek(cancelled) {
    if (!seeking) return;
    seeking = false;
    seekPointer = null;
    document.body.classList.remove('seeking');
    pin(false);
    if (cancelled) {
      paint();
      return;
    }
    commitSeek(seekPreview);
  }

  el.seek.addEventListener('pointerdown', (e) => {
    if (!(duration > 0) || e.button !== 0) return;
    seeking = true;
    seekPointer = e.pointerId;
    seekPreview = seekFraction(e.clientX) * duration;
    document.body.classList.add('seeking');
    try {
      el.seek.setPointerCapture(e.pointerId);
    } catch {}
    pin(true);
    paint();
    e.preventDefault();
  });

  el.seek.addEventListener('pointermove', (e) => {
    if (!seeking || e.pointerId !== seekPointer) return;
    seekPreview = seekFraction(e.clientX) * duration;
    paint();
  });

  el.seek.addEventListener('pointerup', (e) => {
    if (!seeking || e.pointerId !== seekPointer) return;
    seekPreview = seekFraction(e.clientX) * duration;
    try {
      el.seek.releasePointerCapture(e.pointerId);
    } catch {}
    finishSeek(false);
  });

  el.seek.addEventListener('pointercancel', (e) => {
    if (!seeking || e.pointerId !== seekPointer) return;
    finishSeek(true);
  });

  el.seek.addEventListener('lostpointercapture', () => finishSeek(true));

  el.seek.addEventListener('keydown', (e) => {
    if (!(duration > 0)) return;
    const step = e.shiftKey ? 15 : 5;
    let target = null;
    if (e.key === 'ArrowLeft') target = position - step;
    else if (e.key === 'ArrowRight') target = position + step;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = duration - 0.5;
    if (target === null) return;
    e.preventDefault();
    commitSeek(target);
  });

  el.art.addEventListener('error', () => {
    if (track?.thumb) failedArt.add(track.thumb);
    el.art.dataset.src = '';
    el.art.src = PLACEHOLDER;
  });

  listen('island:reveal', () => {
    setVisible(true);
    refreshState();
  });

  listen('island:hide', () => setVisible(false));

  listen('player:position', (e) => {
    const p = e?.payload || {};
    const state = p.state;
    if (Number(p.duration) > 0) duration = Number(p.duration);
    if (!seeking && performance.now() >= seekHoldUntil && !Number.isNaN(Number(p.pos))) {
      position = Number(p.pos) || 0;
    }
    const nowPlaying = state === 'playing' || state === 'loading';
    if (nowPlaying !== playing) {
      playing = nowPlaying;
      updatePlay();
      updateActivity();
    }
    if (visible && !seeking) paint();
  });

  listen('player:track-changed', (e) => {
    const p = e?.payload || {};
    track = p.track || null;
    duration = Number(p.duration) || Number(track?.duration) || 0;
    position = 0;
    seekHoldUntil = 0;
    playing = true;
    renderTrack();
    updatePlay();
    updateActivity();
    paint(true);
  });

  listen('player:loading', (e) => {
    const p = e?.payload || {};
    if (p.videoId && track?.videoId === p.videoId && playing !== true) {
      playing = true;
      updatePlay();
      updateActivity();
    }
  });

  listen('player:idle', () => {
    track = null;
    duration = 0;
    position = 0;
    playing = false;
    renderTrack();
    updatePlay();
    updateActivity();
    paint(true);
  });

  const onMotionChange = () => applyReduceMotion(undefined);
  if (media.addEventListener) media.addEventListener('change', onMotionChange);
  else media.addListener?.(onMotionChange);

  const boot = async () => {
    renderTrack();
    updatePlay();
    applyVolume(volume);
    paint();
    await refreshState();
    try {
      await invoke('island_ready');
    } catch (e) {
      logError('ready', e);
    }
  };

  boot();
})();
