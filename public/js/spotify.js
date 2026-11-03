const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const TITLE_KEYS = ['trackname', 'title', 'name', 'song', 'songname', 'track'];
const ARTIST_KEYS = ['artistnames', 'artistname', 'artists', 'artist'];
const ALBUM_KEYS = ['albumname', 'album'];
const DUR_KEYS = ['durationms', 'trackdurationms', 'duration', 'length'];

function toSeconds(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 0;

  if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) {
    return s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  }

  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n > 10000 ? n / 1000 : n);
}

export function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let touched = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { quoted = true; touched = true; continue; }
    if (c === ',') { row.push(field); field = ''; touched = true; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      touched = false;
      continue;
    }
    field += c;
    touched = true;
  }

  if (touched || field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function pick(header, keys) {
  for (const k of keys) {
    const i = header.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

const HEADER_WORDS = new Set(['artist', 'artists', 'title', 'song', 'track', 'name', 'album', 'duration', 'length']);

function isHeaderLine(line) {
  const parts = String(line || '')
    .split(/\s+[-\u2013\u2014]\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => HEADER_WORDS.has(p));
}

function fromRows(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(norm);
  const ti = pick(header, TITLE_KEYS);
  const ai = pick(header, ARTIST_KEYS);
  const li = pick(header, ALBUM_KEYS);
  const di = pick(header, DUR_KEYS);

  if (ti < 0) {
    const lines = rows.map((r) => String(r[0] || '').trim()).filter(Boolean);
    if (lines.length > 1 && isHeaderLine(lines[0])) lines.shift();

    return lines.map((line) => {
      const m = line.split(/\s+[-\u2013\u2014]\s+/);
      return m.length > 1
        ? { title: m.slice(1).join(' - '), artist: m[0], album: '', dur: 0 }
        : { title: line, artist: '', album: '', dur: 0 };
    });
  }

  const out = [];
  for (const r of rows.slice(1)) {
    const title = String(r[ti] || '').trim();
    if (!title) continue;
    out.push({
      title,
      artist: ai >= 0 ? String(r[ai] || '').trim() : '',
      album: li >= 0 ? String(r[li] || '').trim() : '',
      dur: di >= 0 ? toSeconds(r[di]) : 0,
    });
  }
  return out;
}

function fromJson(parsed) {
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tracks) ? parsed.tracks : null;
  if (!list) return null;

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title ?? item.name ?? item.track ?? '').trim();
    if (!title) continue;

    let artist = item.artist ?? item.artists ?? item.artistName ?? '';
    if (Array.isArray(artist)) artist = artist.map((a) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).join(', ');
    else if (artist && typeof artist === 'object') artist = artist.name || '';

    let album = item.album ?? item.albumName ?? '';
    if (album && typeof album === 'object') album = album.name || '';

    const dur = toSeconds(item.duration_ms ?? item.durationMs ?? item.duration ?? item.dur ?? 0);
    out.push({ title, artist: String(artist || '').trim(), album: String(album || '').trim(), dur });
  }
  return out;
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${norm(r.title)}|${norm(r.artist)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function parsePlaylistExport(text, limit = 500) {
  const raw = String(text || '').trim();
  if (!raw) return { rows: [], skipped: 0 };

  let rows = null;
  if (raw[0] === '[' || raw[0] === '{') {
    try {
      rows = fromJson(JSON.parse(raw));
    } catch {
      rows = null;
    }
  }
  if (!rows) rows = fromRows(parseCsv(raw));

  const clean = dedupe(rows.filter((r) => r.title)).slice(0, limit);
  return { rows: clean, skipped: Math.max(0, rows.length - clean.length) };
}
