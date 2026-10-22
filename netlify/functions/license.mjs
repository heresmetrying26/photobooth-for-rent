// /api/license — the Windows / Mac app's activation, check-in and deactivation.
//   POST { action: 'activate',   code, mid, name, os: 'win'|'mac', ver }  -> { ok, licence }
//   POST { action: 'checkin',    licence, mid, ver }                     -> { ok, licence } | { ok: false, revoked, reason, error }
//   POST { action: 'deactivate', licence, mid }                          -> { ok }   (frees this laptop's device slot)
//   GET  /api/license?pub=1                                              -> the public key the app checks licences with
import { safe, json, licenses, normCode, throttle, recordFail, clearFail, DAY, MIN, fmtWhen, LIFETIME_EXP, devicesOf, setDevices, putLicense, windowEnd } from '../lib/core.mjs';
import { readLicence, licenceFor, activateOn, saveMap, readMap, dropMap, appDevice, publicKeyInfo, MID_RE } from '../lib/license.mjs';

const NO_ADDON = 'The offline app isn’t included in your plan yet. Message us to add it to your code.';

// First use of a code from the app starts it, the same way /api/redeem does.
function startCode(rec, now) {
  if (rec.startsAt && now < rec.startsAt) return 'This code opens on ' + fmtWhen(rec.startsAt) + '. See you then!';
  let exp;
  if (rec.startsAt) exp = rec.lifetime ? LIFETIME_EXP : rec.startsAt + rec.days * DAY;
  else exp = rec.lifetime ? LIFETIME_EXP : now + rec.days * DAY;
  if (exp <= now) return 'This code has expired.';
  rec.status = 'active'; rec.redeemedAt = now; rec.expiresAt = exp;
  return null;
}

export default safe(async (req, context) => {
  if (req.method === 'GET') {
    const u = new URL(req.url);
    if (u.searchParams.get('pub')) return json({ ok: true, ...publicKeyInfo() });
    return json({ error: 'Not found' }, 404);
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const now = Date.now();
  const store = licenses();

  if (b.action === 'activate') {
    const mid = String(b.mid || '').trim().toUpperCase();
    if (!MID_RE.test(mid)) return json({ error: 'This computer’s ID is missing. Please reinstall the app.' }, 400);
    const t = await throttle('appact', context.ip, 10);
    if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
    const key = normCode(b.code);
    const rec = key ? await store.get(key, { type: 'json' }) : null;
    if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
    await clearFail(t);
    if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact us.' }, 403);
    if (rec.kind === 'bonus') return json({ error: 'Bonus codes work in the web booth only. Use your main booking code.' }, 400);
    if (!rec.offlineOpt) return json({ error: NO_ADDON, code: 'no-addon' }, 403);
    if (rec.status !== 'active') {
      const why = startCode(rec, now);
      if (why) return json({ error: why }, 403);
    } else if (rec.expiresAt <= now) return json({ error: 'This code has expired.' }, 403);
    const r = activateOn(rec, { mid, name: b.name, os: b.os, ver: b.ver }, now);
    if (r.error) return json({ error: r.error }, r.status || 400);
    await putLicense(store, key, rec);
    if (r.isNew) await saveMap(r.dev.app.lid, key, mid);
    return json({ ok: true, licence: licenceFor(key, rec, r.dev, now), deviceNo: r.dev.no });
  }

  if (b.action === 'checkin' || b.action === 'deactivate') {
    const p = readLicence(b.licence);
    const mid = String(b.mid || '').trim().toUpperCase();
    if (!p || p.typ !== 'pb4u-desktop' || p.mid !== mid) return json({ ok: false, revoked: true, reason: 'invalid', error: 'This licence isn’t valid on this computer.' }, 403);
    const map = await readMap(p.lid);
    const rec = map ? await store.get(map.key, { type: 'json' }) : null;
    const dev = rec && appDevice(rec, (a) => a.lid === p.lid && a.mid === mid);
    if (b.action === 'deactivate') {
      if (rec && dev) { setDevices(rec, devicesOf(rec).filter((d) => d.id !== dev.id)); await putLicense(store, map.key, rec); }
      await dropMap(p.lid);
      return json({ ok: true });
    }
    if (!rec || !dev) return json({ ok: false, revoked: true, reason: 'removed', error: 'This computer was removed from your code. Activate it again with your code.' });
    if (rec.status === 'revoked') return json({ ok: false, revoked: true, reason: 'disabled', error: 'This code has been disabled. Please contact us.' });
    if (!rec.offlineOpt) return json({ ok: false, revoked: true, reason: 'no-addon', error: NO_ADDON });
    if (rec.expiresAt <= now) return json({ ok: false, revoked: true, reason: 'expired', error: 'This code has expired.' });
    dev.app.seen = now; dev.seen = now;
    if (b.ver) dev.app.ver = String(b.ver).slice(0, 20);
    setDevices(rec, devicesOf(rec).map((d) => (d.id === dev.id ? dev : d)));
    await putLicense(store, map.key, rec);
    return json({ ok: true, licence: licenceFor(map.key, rec, dev, now) });
  }

  return json({ error: 'Unknown action' }, 400);
});

export const config = { path: '/api/license' };
