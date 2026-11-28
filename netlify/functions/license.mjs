// /api/license — the Windows / Mac app's activation, check-in and deactivation.
//   POST { action: 'activate',   code, mid, name, os: 'win'|'mac', ver }  -> { ok, licence }
//   POST { action: 'checkin',    licence, mid, ver }                     -> { ok, licence } | { ok: false, revoked, reason, error }
//   POST { action: 'deactivate', licence, mid }                          -> { ok }   (frees this laptop's device slot)
//   GET  /api/license?pub=1                                              -> the public key the app checks licences with
import { safe, json, licenses, normCode, throttle, recordFail, clearFail, DAY, MIN, fmtWhen, LIFETIME_EXP, devicesOf, setDevices, putLicense, windowEnd, getShutdown, swapBlocked, logSwap, SWAP_MSG, alertDeviceFreed, getSettings, cleanDeviceLabel, extrasOf } from '../lib/core.mjs';
import { readLicence, licenceFor, activateOn, saveMap, readMap, dropMap, appDevice, publicKeyInfo, MID_RE, isTrialCode, trialLicence, effectiveDeviceMode, deviceAllowsOffline, parseSpin360Code, spin360CompanionLicence } from '../lib/license.mjs';
import { liveApp } from '../lib/updates.mjs';

const NO_ADDON = 'The offline app isn’t included in your plan yet. Message us to add it to your code.';
const NO_SPIN360 = '360 Video Booth isn’t enabled on this code yet. Message us to add 360 Arm Cam to your code.';
const SPIN360_CODE_WRONG_APP = 'Codes ending in -360 are for the standalone 360 Arm Cam app only. Enter your code without -360 here.';

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
    const { isSpin360Suffix, baseCode } = parseSpin360Code(b.code);
    const isSpin360App = b.spin360Companion === true;
    if (isSpin360Suffix && !isSpin360App) {
      return json({ error: SPIN360_CODE_WRONG_APP, code: 'spin360-only-code' }, 403);
    }
    // The shared free-trial password: a short, device-bound licence that works offline (no code record, no device slot).
    const tset = await getSettings();
    if (!isSpin360Suffix && isTrialCode(tset, baseCode)) {
      if (isSpin360App) {
        return json({ error: 'Standalone 360 requires a code with 360 Video Booth enabled. You can still tap “Pair to Laptop 360 Desk” below without a code.', code: 'no-spin360' }, 403);
      }
      return json({ ok: true, trial: true, minutes: tset.trialMinutes, licence: trialLicence(tset, { mid, name: b.name, os: b.os, ver: b.ver }, now), app: await liveApp() });
    }
    const t = await throttle('appact', context.ip, 10);
    if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
    const key = normCode(baseCode);
    const rec = key ? await store.get(key, { type: 'json' }) : null;
    if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
    await clearFail(t);
    if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact us.' }, 403);
    if (rec.kind === 'bonus') return json({ error: 'Bonus codes work in the web booth only. Use your main booking code.' }, 400);
    const sd = await getShutdown();
    // Slot-free 360 Arm Cam activation from the standalone 360 Arm Cam app (plain code or optional -360 suffix):
    // Validates the parent code and extras.spin360, then issues a 360-only licence WITHOUT occupying any device slot.
    if (isSpin360App) {
      if (!extrasOf(rec).spin360) return json({ error: NO_SPIN360, code: 'no-spin360' }, 403);
      if (rec.status !== 'active') {
        const why = startCode(rec, now);
        if (why) return json({ error: why }, 403);
        await putLicense(store, key, rec);
      } else if (rec.expiresAt <= now) {
        return json({ error: 'This code has expired.' }, 403);
      }
      const issued = spin360CompanionLicence(key, rec, { mid, name: b.name, os: b.os, ver: b.ver }, now, sd.on);
      await saveMap(issued.lid, key, mid);
      return json({ ok: true, licence: issued.licence, spin360Only: true, slotFree: true, appMode: 'offline', app: await liveApp() });
    }
    // In shutdown mode every Lifetime code gets the Offline App (agreement s.6).
    // Online-capable Windows / Mac Desktop apps (onlineCapable: true) can also activate Online-only codes
    // (running in Online Mode with Google Drive & PayMongo). Older offline-only desktop builds and Android / iPad
    // apps still require offlineOpt (or an Admin per-device Offline/Both override on this device).
    const isDesktopOs = b.os === 'win' || b.os === 'mac';
    const existingDev = appDevice(rec, (a) => a.mid === mid);
    const allowsOff = !!(rec.offlineOpt || (existingDev && deviceAllowsOffline(rec, existingDev)));
    const canOnlineDesktop = isDesktopOs && b.onlineCapable === true;
    if (!allowsOff && !(sd.on && rec.lifetime) && !canOnlineDesktop) return json({ error: NO_ADDON, code: 'no-addon' }, 403);
    if (rec.status !== 'active') {
      const why = startCode(rec, now);
      if (why) return json({ error: why }, 403);
    } else if (rec.expiresAt <= now) return json({ error: 'This code has expired.' }, 403);
    if (rec.traditional !== true) rec.traditional = true;
    if (!rec.orientation || rec.orientation === 'landscape') rec.orientation = 'either';
    const r = activateOn(rec, { mid, name: b.name, os: b.os, ver: b.ver, label: b.label }, now);
    if (r.error) return json({ error: r.error }, r.status || 400);
    await putLicense(store, key, rec);
    if (r.isNew) await saveMap(r.dev.app.lid, key, mid);
    const appMode = (sd.on && rec.lifetime) ? 'offline' : effectiveDeviceMode(rec, r.dev);
    return json({ ok: true, licence: licenceFor(key, rec, r.dev, now, sd.on), deviceNo: r.dev.no, deviceLabel: r.dev.label || '', appMode, app: await liveApp() });
  }

  if (b.action === 'checkin' || b.action === 'deactivate' || b.action === 'rename') {
    const p = readLicence(b.licence);
    const mid = String(b.mid || '').trim().toUpperCase();
    if (!p || p.typ !== 'pb4u-desktop' || p.mid !== mid) return json({ ok: false, revoked: true, reason: 'invalid', error: 'This licence isn’t valid on this computer.' }, 403);
    // A free-trial licence has no code record: it just runs to its own end date (and stops if the trial is switched off).
    if (p.feat && p.feat.trial) {
      if (b.action === 'deactivate') return json({ ok: true });
      if (b.action === 'rename') return json({ ok: false, error: 'Device labels work with rental and lifetime codes.' }, 400);
      const ts = await getSettings();
      if (!ts.trialEnabled) return json({ ok: false, revoked: true, reason: 'disabled', error: 'The free trial has been switched off. Message us for a rental code.' });
      if (!p.exp || p.exp <= now) return json({ ok: false, revoked: true, reason: 'expired', error: 'Your free trial has ended. Message us to book.' });
      return json({ ok: true, licence: b.licence, app: await liveApp() });
    }
    // Slot-free 360 Arm Cam companion licence (<CODE>-360): never occupies rec.devices,
    // but still enforces live parent code validity, revocation, expiry, and spin360 entitlement.
    if (p.feat && p.feat.spin360Only) {
      if (b.action === 'deactivate') {
        await dropMap(p.lid);
        return json({ ok: true, slotFree: true });
      }
      if (b.action === 'rename') {
        return json({ ok: false, error: '360 Arm Cam (-360) activations don’t occupy a device slot.' }, 400);
      }
      const map = await readMap(p.lid);
      const rec = (map && map.mid === mid) ? await store.get(map.key, { type: 'json' }) : null;
      if (!rec) return json({ ok: false, revoked: true, reason: 'removed', error: 'This 360 Arm Cam activation is no longer valid. Activate it again with your code.' });
      if (rec.status === 'revoked') return json({ ok: false, revoked: true, reason: 'disabled', error: 'This code has been disabled. Please contact us.' });
      if (rec.status !== 'active' || rec.expiresAt <= now) return json({ ok: false, revoked: true, reason: 'expired', error: 'This code has expired.' });
      if (!extrasOf(rec).spin360) return json({ ok: false, revoked: true, reason: 'no-spin360', error: NO_SPIN360 });
      const sd = await getShutdown();
      const issued = spin360CompanionLicence(map.key, rec, { lid: p.lid, mid, name: p.name, os: p.os, ver: b.ver || p.ver }, now, sd.on);
      return json({ ok: true, licence: issued.licence, spin360Only: true, slotFree: true, appMode: 'offline', app: await liveApp() });
    }
    const map = await readMap(p.lid);
    const rec = map ? await store.get(map.key, { type: 'json' }) : null;
    const dev = rec && appDevice(rec, (a) => a.lid === p.lid && a.mid === mid);
    if (b.action === 'deactivate') {
      if (rec && dev) {
        if (swapBlocked(rec, now)) return json({ ok: false, error: SWAP_MSG, code: 'swap-limit' }, 429);
        setDevices(rec, devicesOf(rec).filter((d) => d.id !== dev.id));
        logSwap(rec, now);
        await putLicense(store, map.key, rec);
        await alertDeviceFreed(rec, dev, 'deactivated', now);   // email to the owner (ALERT_EMAIL); never blocks or suspends
      }
      await dropMap(p.lid);
      return json({ ok: true });
    }
    if (!rec || !dev) return json({ ok: false, revoked: true, reason: 'removed', error: 'This computer was removed from your code. Activate it again with your code.' });
    if (rec.status === 'revoked') return json({ ok: false, revoked: true, reason: 'disabled', error: 'This code has been disabled. Please contact us.' });
    const sd = await getShutdown();
    const isDesktopOs = p.os === 'win' || p.os === 'mac';
    const allowsOff = !!(rec.offlineOpt || deviceAllowsOffline(rec, dev));
    const canOnlineDesktop = isDesktopOs && b.onlineCapable === true;
    if (!allowsOff && !(sd.on && rec.lifetime) && !canOnlineDesktop) return json({ ok: false, revoked: true, reason: 'no-addon', error: NO_ADDON });
    if (rec.expiresAt <= now) return json({ ok: false, revoked: true, reason: 'expired', error: 'This code has expired.' });
    dev.app.seen = now; dev.seen = now;
    if (b.ver) dev.app.ver = String(b.ver).slice(0, 20);
    if (b.action === 'rename' || typeof b.label === 'string') {
      const cleanLbl = cleanDeviceLabel(b.label);
      if (cleanLbl) dev.label = cleanLbl;
      else if (b.action === 'rename') delete dev.label;
    }
    if (rec.traditional !== true) rec.traditional = true;
    if (!rec.orientation || rec.orientation === 'landscape') rec.orientation = 'either';
    setDevices(rec, devicesOf(rec).map((d) => (d.id === dev.id ? dev : d)));
    await putLicense(store, map.key, rec);
    const appMode = (sd.on && rec.lifetime) ? 'offline' : effectiveDeviceMode(rec, dev);
    return json({ ok: true, licence: licenceFor(map.key, rec, dev, now, sd.on), deviceNo: dev.no, deviceLabel: dev.label || '', appMode, app: await liveApp() });
  }

  return json({ error: 'Unknown action' }, 400);
});

export const config = { path: '/api/license' };
