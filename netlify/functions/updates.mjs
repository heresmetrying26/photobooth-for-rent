import { safe, json, licenses, normCode, throttle, recordFail, clearFail, devicesOf, maxDevicesOf } from '../lib/core.mjs';
import { HELPER, ANDROID, NOTES, appDownloads, liveApp } from '../lib/updates.mjs';

// GET  /api/updates            -> { ok, app, helper, notes }   (public: the What's new page)
// POST /api/updates { code }   -> the laptop app downloads for that code (if it includes the app)
export default safe(async (req, context) => {
  if (req.method === 'GET') return json({ ok: true, app: await liveApp(), helper: HELPER, android: ANDROID, notes: NOTES });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || !b.code) return json({ error: 'Type your code.' }, 400);
  const t = await throttle('appdl', context.ip, 10);
  if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
  const store = licenses();
  const key = normCode(b.code);
  let rec = key ? await store.get(key, { type: 'json' }) : null;
  if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
  await clearFail(t);
  if (rec.kind === 'bonus' && rec.parent) rec = (await store.get(rec.parent, { type: 'json' })) || rec;
  if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact us.' }, 403);
  const now = Date.now();
  const expired = !rec.lifetime && rec.expiresAt && rec.expiresAt <= now;
  const out = {
    ok: true, code: rec.code, label: rec.label || rec.code, lifetime: !!rec.lifetime,
    expiresAt: rec.lifetime ? null : rec.expiresAt || null, expired: !!expired,
    hasApp: !!rec.offlineOpt, offlineOnly: !!rec.offlineOnly,
    devices: { used: devicesOf(rec).length, max: maxDevicesOf(rec), apps: devicesOf(rec).filter((d) => /app$/.test(d.kind || '')).length },
    app: await liveApp()
  };
  if (rec.offlineOpt) out.downloads = appDownloads(out.app.version);
  return json(out);
});

export const config = { path: '/api/updates' };
