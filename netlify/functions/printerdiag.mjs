import { safe, json, licenses, verifyToken, devicesOf, printerDiagStore } from '../lib/core.mjs';

// Printer diagnostics from the Android app (on by default; the renter can switch it off under Setup > Printer, and the
// Agreement describes it). The booth sends the printer's name, USB ids, which print method the app picked, the paper
// and options, and whether the print worked. No photos, no guest details, no IP addresses. Admin > Printer reports
// shows what came in, so an unknown printer (its USB id) or a failing one can be fixed.
//
// POST { token, deviceId, kind: 'detect' | 'print', printer: { name, vid, pid, info, model, flags }, paper, opts, ok, error, app }
// One document per printer model (not per booth), with counts, the codes that use it and the last few results.

const MAX_RECENT = 12;
const MAX_CODES = 25;

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.max(0, Math.min(65535, Math.trunc(x))) : 0; };
// An IEEE-1284 device id can carry the printer's serial number: never keep it.
const cleanInfo = (v) => str(v, 400).replace(/\b(SN|SERIAL|SERIALNUMBER|UUID):[^;]*;?/gi, '').slice(0, 300);
const slug = (s) => str(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'Bad request' }, 400);

  // Only a signed-in booth (rental code on one of its devices, or a running trial) can report.
  const p = verifyToken(b.token);
  if (!p || (p.t !== 'rental' && p.t !== 'trial') || p.d !== String(b.deviceId || '')) return json({ error: 'locked' }, 401);
  const now = Date.now();
  let codeKey = 'trial';
  if (p.t === 'trial') {
    if (!p.exp || p.exp <= now) return json({ error: 'locked' }, 401);
  } else {
    const rec = await licenses().get(p.k, { type: 'json' });
    if (!rec || rec.status !== 'active' || rec.expiresAt <= now) return json({ error: 'locked' }, 401);
    if (!devicesOf(rec).some((d) => d.id === p.d)) return json({ error: 'locked' }, 401);
    codeKey = p.k;
  }

  const kind = b.kind === 'print' ? 'print' : b.kind === 'detect' ? 'detect' : null;
  const pr = b.printer && typeof b.printer === 'object' ? b.printer : null;
  if (!kind || !pr) return json({ error: 'Bad request' }, 400);

  const name = str(pr.name, 120);
  const vid = num(pr.vid), pid = num(pr.pid);
  if (!name && !(vid && pid)) return json({ error: 'Bad request' }, 400);
  const flags = {};
  if (pr.flags && typeof pr.flags === 'object') {
    for (const k of ['usb', 'ipp', 'raw', 'escpr', 'epsonL', 'escp2', 'canon', 'selphy', 'dnp', 'noDriver', 'needsPermission', 'borderless']) if (pr.flags[k]) flags[k] = true;
  }
  // USB printers are told apart by their ids, others by their name (never an address).
  const key = vid && pid ? 'usb-' + vid.toString(16).padStart(4, '0') + '-' + pid.toString(16).padStart(4, '0') : 'net-' + slug(name);

  const store = printerDiagStore();
  const doc = (await store.get(key, { type: 'json' })) || { key, firstAt: now, detect: 0, ok: 0, fail: 0, codes: {}, apps: {}, recent: [] };
  doc.name = name || doc.name || '';
  doc.vid = vid; doc.pid = pid;
  doc.model = str(pr.model, 40) || doc.model || '';
  const info = cleanInfo(pr.info);
  if (info) doc.info = info;
  doc.flags = flags;                  // the way the app classified it the last time: tells "recognised" from "no driver"
  doc.lastAt = now;
  doc.codes = doc.codes || {}; doc.apps = doc.apps || {};
  if (kind === 'detect') doc.detect = (doc.detect || 0) + 1;
  else if (b.ok) doc.ok = (doc.ok || 0) + 1;
  else { doc.fail = (doc.fail || 0) + 1; doc.lastError = str(b.error, 200); doc.lastErrorAt = now; }
  doc.codes[codeKey] = now;
  const codeKeys = Object.keys(doc.codes);
  if (codeKeys.length > MAX_CODES) codeKeys.sort((a, c) => doc.codes[a] - doc.codes[c]).slice(0, codeKeys.length - MAX_CODES).forEach((k) => delete doc.codes[k]);
  const app = str(b.app, 20).replace(/[^0-9.]/g, '');
  if (app) doc.apps[app] = (doc.apps[app] || 0) + 1;

  const o = b.opts && typeof b.opts === 'object' ? b.opts : {};
  const pa = b.paper && typeof b.paper === 'object' ? b.paper : {};
  doc.recent = Array.isArray(doc.recent) ? doc.recent : [];
  doc.recent.unshift({
    at: now, kind, ok: kind === 'print' ? !!b.ok : null, error: kind === 'print' && !b.ok ? str(b.error, 200) : '',
    paper: { name: str(pa.name, 40), w: Math.round(Number(pa.w) || 0), h: Math.round(Number(pa.h) || 0) },
    opts: { quality: str(o.quality, 20), color: str(o.color, 20), media: str(o.media, 20), borderless: o.borderless == null ? null : !!o.borderless },
    app, code: codeKey
  });
  doc.recent.length = Math.min(doc.recent.length, MAX_RECENT);

  await store.setJSON(key, doc);
  return json({ ok: true });
});

export const config = { path: '/api/printerdiag' };
