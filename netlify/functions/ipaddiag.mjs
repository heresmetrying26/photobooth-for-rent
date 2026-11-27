import { safe, ipadDiagStore } from '../lib/core.mjs';

// Live iPad / tablet hang debugger telemetry endpoint (/api/ipaddiag).
// Accepts beacon / fetch posts from both https://photobooth4u.netlify.app/ipad-debug/
// and the iPad offline app (http://localhost:17321/booth) via CORS + text/plain.
// Stores ONLY technical timing breadcrumbs, canvas counts/MP, stall ms, and errors
// (never photos, base64 image payloads, IP addresses, or guest personal info).

const MAX_EVENTS = 450;
const KEEP_HEAD = 25;
const MAX_SESSIONS = 30;
const SESSION_TTL_MS = 7 * 86400000;
const SID_RE = /^[A-Z0-9_-]{4,24}$/;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'cache-control': 'no-store'
};

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

const cleanStr = (v, max = 180) => {
  const s = String(v == null ? '' : v)
    .replace(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[img-stripped]')
    .replace(/[A-Za-z0-9+/]{160,}={0,2}/g, '[b64-stripped]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
};

function cleanObj(obj, depth = 0) {
  if (obj == null) return null;
  if (typeof obj === 'boolean') return obj;
  if (typeof obj === 'number') return Number.isFinite(obj) ? Math.round(obj * 100) / 100 : null;
  if (typeof obj === 'string') return cleanStr(obj, 180);
  if (depth >= 2) return cleanStr(String(obj), 100);
  if (Array.isArray(obj)) return obj.slice(0, 12).map((x) => cleanObj(x, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(obj)) {
      if (n >= 16) break;
      const ck = cleanStr(k, 32);
      if (!ck) continue;
      out[ck] = cleanObj(obj[k], depth + 1);
      n++;
    }
    return out;
  }
  return null;
}

export function cleanSid(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  return SID_RE.test(s) ? s : '';
}

function summarizeEvents(doc, incoming, now) {
  const events = Array.isArray(doc.events) ? doc.events.slice() : [];
  let maxLagMs = Number(doc.maxLagMs) || 0;
  let stallCount = Number(doc.stallCount) || 0;
  let errorCount = Number(doc.errorCount) || 0;
  let lastStep = doc.lastStep || '';
  let lastPhase = doc.lastPhase || '';
  let inFlight = doc.inFlight || '';
  let lastCanvasCount = doc.lastCanvasCount || 0;
  let lastCanvasMp = doc.lastCanvasMp || 0;
  let lastHb = doc.lastHb || doc.updatedAt || now;

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const tag = cleanStr(raw.tag || 'INFO', 16).toUpperCase();
    const msg = cleanStr(raw.msg || '', 220);
    const t = Number(raw.t) > 0 && Number(raw.t) <= now + 60000 ? Math.trunc(Number(raw.t)) : now;
    const dt = Number.isFinite(Number(raw.dt)) ? Math.max(0, Math.min(600000, Math.round(Number(raw.dt)))) : null;
    const data = raw.data != null ? cleanObj(raw.data, 0) : null;
    const ev = { t, tag, msg };
    if (dt !== null) ev.dt = dt;
    if (data !== null) ev.data = data;
    events.push(ev);

    if (tag === 'HB' || tag === 'BOOT' || tag === 'STEP' || tag === 'PRINT' || tag === 'SAVE' || tag === 'CAM') {
      lastHb = Math.max(lastHb, now);
    }
    if (tag === 'LAG') {
      stallCount++;
      const lag = Number((data && data.lagMs) || dt || 0);
      if (lag > maxLagMs) maxLagMs = Math.round(lag);
    }
    if (tag === 'ERR' || tag === 'CRASH') {
      errorCount++;
    }
    if (data && typeof data === 'object') {
      if (typeof data.canvases === 'number') lastCanvasCount = data.canvases;
      if (typeof data.canvasMp === 'number') lastCanvasMp = data.canvasMp;
      if (typeof data.lagMs === 'number' && data.lagMs > maxLagMs) maxLagMs = Math.round(data.lagMs);
      if (data.state === 'start' && msg) inFlight = tag + ': ' + msg;
      else if (data.state === 'end' || data.state === 'error' || data.state === 'done') inFlight = '';
    }
    if (tag !== 'HB') {
      lastStep = tag + ': ' + msg;
      if (tag === 'PRINT' || tag === 'SAVE' || tag === 'CAM' || tag === 'MEM' || tag === 'TEST') lastPhase = tag;
    }
  }

  let trimmed = events;
  if (events.length > MAX_EVENTS) {
    trimmed = events.slice(0, KEEP_HEAD).concat(events.slice(events.length - (MAX_EVENTS - KEEP_HEAD)));
  }

  return {
    events: trimmed,
    maxLagMs,
    stallCount,
    errorCount,
    lastStep,
    lastPhase,
    inFlight,
    lastCanvasCount,
    lastCanvasMp,
    lastHb
  };
}

async function parseBody(req) {
  const raw = await req.text().catch(() => '');
  if (!raw || raw.length > 180000) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function handleIpadDiag(req, storeOverride = null) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const store = storeOverride || ipadDiagStore();
  const url = new URL(req.url);
  const now = Date.now();

  if (req.method === 'GET') {
    if (url.searchParams.get('list') === '1') {
      const idx = (await store.get('_index', { type: 'json' })) || { sessions: [] };
      const list = (Array.isArray(idx.sessions) ? idx.sessions : [])
        .filter((s) => s && s.sid && (!s.updatedAt || now - s.updatedAt < SESSION_TTL_MS))
        .slice(0, MAX_SESSIONS)
        .map((s) => ({
          ...s,
          agoMs: Math.max(0, now - (s.updatedAt || now))
        }));
      return corsJson({ ok: true, now, sessions: list });
    }

    const sid = cleanSid(url.searchParams.get('sid'));
    if (!sid) return corsJson({ ok: false, error: 'Missing or invalid session code.' }, 400);
    const doc = await store.get('s:' + sid, { type: 'json' });
    if (!doc) return corsJson({ ok: true, found: false, sid, now });
    const aliveAgoMs = Math.max(0, now - (doc.lastHb || doc.updatedAt || now));
    return corsJson({
      ok: true,
      found: true,
      now,
      aliveAgoMs,
      likelyFrozen: !!(doc.inFlight && aliveAgoMs > 7000),
      session: doc
    });
  }

  if (req.method !== 'POST') return corsJson({ error: 'Method not allowed' }, 405);

  const b = await parseBody(req);
  if (!b) return corsJson({ ok: false, error: 'Invalid JSON payload' }, 400);

  const sid = cleanSid(b.sid);
  if (!sid) return corsJson({ ok: false, error: 'Invalid session code' }, 400);

  if (b.action === 'clear') {
    await store.delete('s:' + sid).catch(() => { });
    const idx = (await store.get('_index', { type: 'json' })) || { sessions: [] };
    const next = (Array.isArray(idx.sessions) ? idx.sessions : []).filter((s) => s && s.sid !== sid);
    await store.setJSON('_index', { sessions: next.slice(0, MAX_SESSIONS) });
    return corsJson({ ok: true, cleared: true, sid });
  }

  const key = 's:' + sid;
  const existing = (await store.get(key, { type: 'json' })) || {
    sid,
    createdAt: now,
    updatedAt: now,
    lastHb: now,
    source: 'unknown',
    device: {},
    events: []
  };

  if (b.source) existing.source = cleanStr(b.source, 32);
  if (b.device && typeof b.device === 'object') {
    existing.device = { ...(existing.device || {}), ...(cleanObj(b.device, 0) || {}) };
  }
  if (b.crashedPrev) {
    existing.crashedPrev = cleanObj(b.crashedPrev, 0);
  }

  const incoming = Array.isArray(b.events) ? b.events.slice(0, 80) : [];
  const merged = summarizeEvents(existing, incoming, now);
  const updated = {
    ...existing,
    ...merged,
    updatedAt: now
  };

  await store.setJSON(key, updated);

  // Keep lightweight recent-sessions index so the developer viewer can pick the client session in 1 click.
  try {
    const idx = (await store.get('_index', { type: 'json' })) || { sessions: [] };
    const cur = (Array.isArray(idx.sessions) ? idx.sessions : []).filter(
      (s) => s && s.sid && s.sid !== sid && (!s.updatedAt || now - s.updatedAt < SESSION_TTL_MS)
    );
    const dev = updated.device || {};
    cur.unshift({
      sid,
      source: updated.source || 'unknown',
      appVer: dev.appVer || '',
      iosApp: !!dev.iosApp,
      iosLowRam: dev.iosLowRam == null ? null : !!dev.iosLowRam,
      uaShort: cleanStr(dev.uaShort || dev.ua || '', 90),
      updatedAt: now,
      eventCount: updated.events.length,
      stallCount: updated.stallCount || 0,
      maxLagMs: updated.maxLagMs || 0,
      errorCount: updated.errorCount || 0,
      inFlight: updated.inFlight || '',
      lastStep: updated.lastStep || ''
    });
    await store.setJSON('_index', { sessions: cur.slice(0, MAX_SESSIONS) });
  } catch { /* non-fatal */ }

  return corsJson({ ok: true, sid, count: updated.events.length, now });
}

export default safe(async (req) => handleIpadDiag(req));

export const config = { path: '/api/ipaddiag' };
