import { safe, json, licenses, verifyToken, devicesOf, camDiagStore } from '../lib/core.mjs';
import { readLicence, readMap, appDevice } from '../lib/license.mjs';

// Camera diagnostics (on by default; the renter can switch it off under Setup > Camera, and the Agreement describes it).
// When a USB camera (DSLR / mirrorless) fails to take a guest's photo, the booth sends the camera's name, the error
// message and the last lines of its camera log (commands and the camera's answers, with times). No photos, no guest
// details, no IP addresses. Admin > Camera reports shows what came in, so a camera that misses shots can be fixed.
//
// POST { token, deviceId, ... }   from the web app and the Android app (the booth's own token)
// POST { licence, mid, ... }      from the Windows / Mac app (its signed licence, the same one /api/license checks)
//   ... = camera: { name, brand }, error, platform, app, at, log, workerLog
// One document per camera model (not per booth), with a count, the codes that use it and the last few failures.

const MAX_RECENT = 10;
const MAX_CODES = 25;
const LOG_MAX = 6000;

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const slug = (s) => str(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
// The log is text the app wrote itself; keep the end of it (the failure is the newest part) and drop anything that looks like an address.
const cleanLog = (v) => {
  const s = String(v == null ? '' : v).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]').replace(/[^\x09\x0A\x20-\x7E -￿]/g, '');
  return s.length > LOG_MAX ? s.slice(s.length - LOG_MAX) : s;
};

// Who is reporting: the code's key, or null when the sender isn't a signed-in booth.
async function whoIs(b, now) {
  if (b.licence) {
    const p = readLicence(b.licence);
    const mid = String(b.mid || '').trim().toUpperCase();
    if (!p || p.typ !== 'pb4u-desktop' || p.mid !== mid) return null;
    const map = await readMap(p.lid);
    const rec = map ? await licenses().get(map.key, { type: 'json' }) : null;
    if (!rec || rec.status !== 'active' || !appDevice(rec, (a) => a.lid === p.lid && a.mid === mid)) return null;
    return map.key;
  }
  const p = verifyToken(b.token);
  if (!p || (p.t !== 'rental' && p.t !== 'trial') || p.d !== String(b.deviceId || '')) return null;
  if (p.t === 'trial') return p.exp && p.exp > now ? 'trial' : null;
  const rec = await licenses().get(p.k, { type: 'json' });
  if (!rec || rec.status !== 'active' || rec.expiresAt <= now) return null;
  if (!devicesOf(rec).some((d) => d.id === p.d)) return null;
  return p.k;
}

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return json({ error: 'Bad request' }, 400);
  const now = Date.now();
  const codeKey = await whoIs(b, now);
  if (!codeKey) return json({ error: 'locked' }, 401);

  const cam = b.camera && typeof b.camera === 'object' ? b.camera : null;
  const name = cam ? str(cam.name, 120).trim() : '';
  const error = str(b.error, 300);
  if (!name || !error) return json({ error: 'Bad request' }, 400);
  const brand = str(cam.brand, 20).toLowerCase().replace(/[^a-z]/g, '');
  const key = 'cam-' + slug(name);

  const store = camDiagStore();
  const doc = (await store.get(key, { type: 'json' })) || { key, firstAt: now, fail: 0, codes: {}, apps: {}, recent: [] };
  doc.name = name;
  if (brand) doc.brand = brand;
  doc.fail = (doc.fail || 0) + 1;
  doc.lastAt = now;
  doc.lastError = error;
  doc.codes = doc.codes || {}; doc.apps = doc.apps || {};
  doc.codes[codeKey] = now;
  const codeKeys = Object.keys(doc.codes);
  if (codeKeys.length > MAX_CODES) codeKeys.sort((a, c) => doc.codes[a] - doc.codes[c]).slice(0, codeKeys.length - MAX_CODES).forEach((k) => delete doc.codes[k]);
  const app = str(b.app, 20).replace(/[^0-9.]/g, '');
  const platform = str(b.platform, 12).toLowerCase().replace(/[^a-z]/g, '');
  const appKey = (platform || 'app') + (app ? ' ' + app : '');
  doc.apps[appKey] = (doc.apps[appKey] || 0) + 1;

  // When it happened on the booth (a report held back while offline arrives later); never a time in the future.
  const at = Number(b.at) > 0 && Number(b.at) <= now ? Math.trunc(Number(b.at)) : now;
  doc.recent = Array.isArray(doc.recent) ? doc.recent : [];
  doc.recent.unshift({ at, got: now, error, app: appKey, code: codeKey, log: cleanLog(b.log), workerLog: cleanLog(b.workerLog) });
  doc.recent.length = Math.min(doc.recent.length, MAX_RECENT);

  await store.setJSON(key, doc);
  return json({ ok: true });
});

export const config = { path: '/api/camdiag' };
