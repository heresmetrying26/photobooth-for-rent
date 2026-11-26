// Desktop app (offline) licences.
//
// The Windows / Mac app is activated once with the renter's normal PB code.
// The server then hands it a LICENCE: a small text signed with an Ed25519
// private key that only lives in Netlify (env PB_LICENSE_KEY). The app checks
// the signature with the matching public key built into it, so nobody can make
// or extend a licence without that private key.
//
//   PB4U-LIC1.<payload base64url>.<signature base64url>
//
// payload: { v, typ, lid, mid, os, name, code, lifetime, exp, iat, chk, hard, feat }
//   lid  = this activation's id (one per laptop)        mid = the laptop's machine id
//   exp  = when a rental / trial code ends (null = lifetime)
//   chk  = check in after this (when online)            hard = without a check-in, the app stops here
//   feat = the same add-ons the web booth gets (printing, vouchers, retakes, lock, mode…)
//
// Each activation also takes one of the code's device slots (kind "Windows app"
// / "Mac app"), so removing that device in Admin or My Events cancels it at the
// laptop's next check-in.
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomBytes } from 'node:crypto';
import { meta, licenses, normPrint, extrasOf, LIFETIME_EXP, FINAL_EXP, maxDevicesOf, devicesOf, addDevice, setDevices, displayCode, cleanDeviceLabel } from './core.mjs';

export const LIC_PREFIX = 'PB4U-LIC1';
export const CHECK_DAYS = 75;          // a lifetime laptop checks in this often (when it has internet)
export const GRACE_DAYS = 30;          // …and keeps working this long past it without one
const DAY = 86400000;
export const MID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const APP_KINDS = { win: 'Windows app', mac: 'Mac app', android: 'Android app', ios: 'iPad app' };
export const DEVICE_MODES = ['offline', 'online', 'both'];

// Per-device booth mode: dev.mode overrides the code default without affecting other devices on the same code.
// Defaults keep existing behaviour: offlineOpt / offlineOnly codes default to 'offline', while online-only codes
// running on the Windows / Mac Desktop app default to 'online'.
export function effectiveDeviceMode(rec, dev) {
  if (dev && DEVICE_MODES.includes(dev.mode)) return dev.mode;
  if (rec && (rec.offlineOnly || rec.offlineOpt)) return 'offline';
  return 'online';
}
export function deviceAllowsOnline(rec, dev) {
  const m = effectiveDeviceMode(rec, dev);
  return m === 'online' || m === 'both';
}
export function deviceAllowsOffline(rec, dev) {
  const m = effectiveDeviceMode(rec, dev);
  return m === 'offline' || m === 'both';
}

function privateKey() {
  const s = process.env.PB_LICENSE_KEY;
  if (!s) throw new Error('PB_LICENSE_KEY env var is not set in Netlify (run scripts/make-license-key.mjs once).');
  return createPrivateKey({ key: Buffer.from(s.trim(), 'base64'), format: 'der', type: 'pkcs8' });
}
export function licenceReady() { try { privateKey(); return true; } catch { return false; } }
// The public key the app has built in (base64 SPKI DER, and raw 32 bytes in hex).
export function publicKeyInfo() {
  const pub = createPublicKey(privateKey());
  const der = pub.export({ format: 'der', type: 'spki' });
  return { spki: der.toString('base64'), raw: der.subarray(der.length - 32).toString('hex') };
}

export function signLicence(payload) {
  const body = LIC_PREFIX + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = edSign(null, Buffer.from(body), privateKey()).toString('base64url');
  return body + '.' + sig;
}
// Returns the payload when the licence was signed by our key, else null.
export function readLicence(lic) {
  if (typeof lic !== 'string' || lic.length > 8000) return null;
  const parts = lic.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LIC_PREFIX) return null;
  try {
    const pub = createPublicKey(privateKey());
    if (!edVerify(null, Buffer.from(parts[0] + '.' + parts[1]), pub, Buffer.from(parts[2], 'base64url'))) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
}

// Same add-ons the web booth gets from checkLicense().
export function featuresOf(rec, deviceNo, dev) {
  const devLabel = dev ? cleanDeviceLabel(dev.label || (dev.app && dev.app.name) || '') : '';
  return {
    print: normPrint(rec.print && rec.print.enabled, rec.print && rec.print.sizes, rec.print),
    traditional: rec.traditional !== false, retakeOpt: !!rec.retakeOpt, typesOpt: !!rec.typesOpt, lockOpt: !!rec.lockOpt, debugOpt: !!rec.debugOpt,
    orientation: (rec.orientation && rec.orientation !== 'landscape') ? rec.orientation : 'either',
    gifOpt: rec.gifOpt !== false,
    ipadOpt: !!rec.ipadOpt,                      // an iPad may use this laptop's camera over Wi-Fi (off by default unless Admin turns it on)
    printStationOpt: !!rec.printStationOpt,      // built-in Tools -> Print Station in Desktop App (off by default unless Admin turns it on)
    arrangePrintOpt: !!rec.arrangePrintOpt,      // Arrange & Print tool in Setup ⋯ & Photo Session Tools (off by default unless Admin turns it on)
    extras: extrasOf(rec),
    vouchers: !!rec.payOpt,                       // offline: vouchers only; online mode also enables PayMongo QR
    folderKey: rec.lifetime ? null : ((rec.folderName || rec.label || '').trim() || null),
    folderPrefix: rec.lifetime ? ((rec.folderName || rec.label || rec.code || '').trim() || null) : null,
    defaultTheme: rec.defaultTheme || null,
    deviceNo: deviceNo || 1, multiDevice: maxDevicesOf(rec) > 1, pinResetAt: rec.pinResetAt || 0,
    appMode: effectiveDeviceMode(rec, dev),
    deviceLabel: devLabel
  };
}
const maskCode = (key) => { const c = displayCode(key); return c.slice(0, 3) + '••••-••••-' + c.slice(-4); };

// A fresh licence for one activation (device entry with .app).
// final = shutdown mode is on: a Lifetime licence never asks to check in again.
export function licenceFor(key, rec, dev, now, final) {
  const isFinal = !!final && !!rec.lifetime;
  const exp = rec.lifetime || rec.expiresAt >= LIFETIME_EXP ? null : rec.expiresAt;
  const chk = isFinal ? FINAL_EXP : now + CHECK_DAYS * DAY;
  // Lifetime: must check in now and then. A code with an end date (event, 6-Month
  // Pass) works offline right up to that date; Admin changes reach it if it goes online.
  const hard = isFinal ? FINAL_EXP : (exp || chk + GRACE_DAYS * DAY);
  const feat = { ...featuresOf(rec, dev.no, dev), final: isFinal };
  if (isFinal) feat.appMode = 'offline';
  return signLicence({
    v: 1, typ: 'pb4u-desktop', lid: dev.app.lid, mid: dev.app.mid, os: dev.app.os, name: dev.app.name || '',
    label: dev.label || '',
    renter: rec.label || rec.folderName || '', code: maskCode(key), lifetime: !!rec.lifetime,
    exp, iat: now, chk, hard, feat
  });
}

// ---------- free trial for the offline apps (Android / Windows / Mac) ----------
// The shared trial password also activates an app, for the trial length set in Admin
// (Trial password → minutes). No code record and no device slot is used: the licence is
// bound to this device's id (mid), ends at `exp` and never asks to check in (chk = hard = exp),
// so after one online activation the trial runs fully offline. Vouchers and the cash
// acceptor are switched on so the renter can try them too. Only the app trial uses this;
// the web trial is unchanged.
export const isTrialCode = (settings, code) => {
  const pw = String((settings && settings.trialPassword) || '').trim().toLowerCase();
  return !!(settings && settings.trialEnabled && pw && String(code || '').trim().toLowerCase() === pw);
};
export function trialLicence(settings, { mid, name, os, ver }, now) {
  const clean = (v, n) => String(v || '').replace(/[<>"\u0000-\u001f]/g, '').trim().slice(0, n);
  const osKey = os === 'mac' ? 'mac' : os === 'android' ? 'android' : os === 'ios' ? 'ios' : 'win';
  const minutes = Math.max(1, Math.min(240, Math.floor(Number(settings.trialMinutes) || 15)));
  const exp = now + minutes * 60000;
  const folder = String(settings.trialFolderPrefix || 'Trial test shots').trim() || 'Trial test shots';
  return signLicence({
    v: 1, typ: 'pb4u-desktop', lid: randomBytes(10).toString('hex'), mid, os: osKey, name: clean(name, 60), ver: clean(ver, 20),
    renter: 'Free trial', code: 'TRIAL', lifetime: false, exp, iat: now, chk: exp, hard: exp,
    feat: {
      trial: true, watermark: settings.trialWatermark !== false, minutes,
      print: normPrint(settings.trialPrintEnabled, settings.trialPrintSizes, { eventLimit: settings.trialPrintEventLimit, sessionLimit: settings.trialPrintSessionLimit }),
      traditional: !!settings.trialTraditional, retakeOpt: !!settings.trialRetakeOpt, typesOpt: !!settings.trialTypesOpt, lockOpt: !!settings.trialLockOpt, debugOpt: false,
      orientation: 'either', gifOpt: settings.trialGifOpt !== false, ipadOpt: false, printStationOpt: false, arrangePrintOpt: !!settings.trialArrangePrintOpt,
      extras: extrasOf({}), vouchers: true,
      folderKey: folder, folderPrefix: null, defaultTheme: null, deviceNo: 1, multiDevice: false, pinResetAt: 0, final: false,
      appMode: 'offline', deviceLabel: clean(name, 40)
    }
  });
}

const mapKey = (lid) => 'applic-' + lid;
export async function saveMap(lid, key, mid) { await meta().setJSON(mapKey(lid), { key, mid, at: Date.now() }); }
export async function readMap(lid) { return /^[a-f0-9]{16,40}$/.test(String(lid || '')) ? meta().get(mapKey(lid), { type: 'json' }) : null; }
export async function dropMap(lid) { try { await meta().delete(mapKey(lid)); } catch { /* gone */ } }

export const appDevice = (rec, pred) => devicesOf(rec).find((d) => d.app && pred(d.app));

// Verifies a Desktop / App cloud request carrying { licence, mid }.
// Returns null when no Desktop licence was provided (caller falls back to web token auth).
export async function verifyDesktopAppAuth(b, { requireOnline = false } = {}) {
  if (!(b && b.licence && b.mid && process.env.PB_LICENSE_KEY)) return null;
  const lp = readLicence(b.licence);
  const mid = String(b.mid || '').trim().toUpperCase();
  if (!lp || lp.typ !== 'pb4u-desktop' || lp.mid !== mid) {
    return { ok: false, status: 401, error: 'locked', reason: 'invalid' };
  }
  const map = await readMap(lp.lid);
  const rec = map ? await licenses().get(map.key, { type: 'json' }) : null;
  const dev = rec && appDevice(rec, (a) => a.lid === lp.lid && a.mid === mid);
  if (!rec || !dev) return { ok: false, status: 401, error: 'locked', reason: 'device-removed' };
  if (rec.status === 'revoked') return { ok: false, status: 401, error: 'locked', reason: 'revoked' };
  if (rec.status !== 'active' || rec.expiresAt <= Date.now()) return { ok: false, status: 401, error: 'locked', reason: 'expired' };
  const mode = effectiveDeviceMode(rec, dev);
  if (requireOnline && !deviceAllowsOnline(rec, dev)) {
    return { ok: false, status: 403, error: 'Online mode isn’t enabled for this device. Ask Admin to switch this device to Online or Both.', reason: 'offline-only' };
  }
  const parentRec = (rec.kind === 'bonus' && rec.parent) ? ((await licenses().get(rec.parent, { type: 'json' })) || rec) : rec;
  const owner = (rec.kind === 'bonus' && rec.parent) ? rec.parent : map.key;
  return {
    ok: true,
    key: map.key,
    owner,
    rec,
    parentRec,
    dev,
    mode,
    allowsOnline: deviceAllowsOnline(rec, dev),
    allowsOffline: deviceAllowsOffline(rec, dev),
    deviceNo: dev.no || 1,
    folderKey: rec.lifetime ? null : ((rec.folderName || rec.label || '').trim() || null),
    folderPrefix: rec.lifetime ? ((rec.folderName || rec.label || rec.code || '').trim() || null) : null,
    subfolder: rec.kind === 'bonus' ? (rec.subfolder || 'Bonus') : null,
    exp: rec.expiresAt
  };
}

// Adds (or refreshes) this laptop's activation on the code. Returns
// { dev } or { error, status }. The caller saves rec.
export function activateOn(rec, { mid, name, os, ver, label }, now) {
  const osKey = os === 'mac' ? 'mac' : os === 'android' ? 'android' : os === 'ios' ? 'ios' : 'win';
  const clean = (v, n) => String(v || '').replace(/[<>"\u0000-\u001f]/g, '').trim().slice(0, n);
  const cleanLbl = cleanDeviceLabel(label);
  let dev = appDevice(rec, (a) => a.mid === mid);
  if (dev) {
    dev.app = { ...dev.app, name: clean(name, 60) || dev.app.name, os: osKey, ver: clean(ver, 20), seen: now };
    dev.kind = APP_KINDS[osKey];
    if (cleanLbl) dev.label = cleanLbl;
    setDevices(rec, devicesOf(rec).map((d) => (d.id === dev.id ? dev : d)));
    return { dev };
  }
  const devs = devicesOf(rec);
  if (devs.length >= maxDevicesOf(rec)) {
    const max = maxDevicesOf(rec);
    return { status: 403, error: 'All ' + max + ' device slot' + (max === 1 ? ' is' : 's are') + ' in use on this code. Remove a device in My Events (or ask us), then activate again.' };
  }
  const lid = randomBytes(10).toString('hex');
  addDevice(rec, 'app:' + lid, now, APP_KINDS[osKey], cleanLbl);
  const list = devicesOf(rec);
  dev = list[list.length - 1];
  dev.app = { lid, mid, name: clean(name, 60), os: osKey, ver: clean(ver, 20), seen: now };
  setDevices(rec, list.map((d) => (d.id === dev.id ? dev : d)));
  return { dev, isNew: true };
}
