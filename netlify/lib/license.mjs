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
import { meta, normPrint, LIFETIME_EXP, maxDevicesOf, devicesOf, addDevice, setDevices, displayCode } from './core.mjs';

export const LIC_PREFIX = 'PB4U-LIC1';
export const CHECK_DAYS = 75;          // a lifetime laptop checks in this often (when it has internet)
export const GRACE_DAYS = 30;          // …and keeps working this long past it without one
const DAY = 86400000;
export const MID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const APP_KINDS = { win: 'Windows app', mac: 'Mac app', android: 'Android app' };

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
export function featuresOf(rec, deviceNo) {
  return {
    print: normPrint(rec.print && rec.print.enabled, rec.print && rec.print.sizes, rec.print),
    traditional: !!rec.traditional, retakeOpt: !!rec.retakeOpt, lockOpt: !!rec.lockOpt,
    gifOpt: rec.gifOpt !== false,
    vouchers: !!rec.payOpt,                       // offline: vouchers only (QR payments need internet)
    folderKey: rec.lifetime ? null : ((rec.folderName || rec.label || '').trim() || null),
    folderPrefix: rec.lifetime ? ((rec.folderName || rec.label || rec.code || '').trim() || null) : null,
    defaultTheme: rec.defaultTheme || null,
    deviceNo: deviceNo || 1, multiDevice: maxDevicesOf(rec) > 1, pinResetAt: rec.pinResetAt || 0
  };
}
const maskCode = (key) => { const c = displayCode(key); return c.slice(0, 3) + '••••-••••-' + c.slice(-4); };

// A fresh licence for one activation (device entry with .app).
export function licenceFor(key, rec, dev, now) {
  const exp = rec.lifetime || rec.expiresAt >= LIFETIME_EXP ? null : rec.expiresAt;
  const chk = now + CHECK_DAYS * DAY;
  // Lifetime: must check in now and then. A code with an end date (event, 6-Month
  // Pass) works offline right up to that date; Admin changes reach it if it goes online.
  const hard = exp || chk + GRACE_DAYS * DAY;
  return signLicence({
    v: 1, typ: 'pb4u-desktop', lid: dev.app.lid, mid: dev.app.mid, os: dev.app.os, name: dev.app.name || '',
    renter: rec.label || rec.folderName || '', code: maskCode(key), lifetime: !!rec.lifetime,
    exp, iat: now, chk, hard, feat: featuresOf(rec, dev.no)
  });
}

const mapKey = (lid) => 'applic-' + lid;
export async function saveMap(lid, key, mid) { await meta().setJSON(mapKey(lid), { key, mid, at: Date.now() }); }
export async function readMap(lid) { return /^[a-f0-9]{16,40}$/.test(String(lid || '')) ? meta().get(mapKey(lid), { type: 'json' }) : null; }
export async function dropMap(lid) { try { await meta().delete(mapKey(lid)); } catch { /* gone */ } }

export const appDevice = (rec, pred) => devicesOf(rec).find((d) => d.app && pred(d.app));

// Adds (or refreshes) this laptop's activation on the code. Returns
// { dev } or { error, status }. The caller saves rec.
export function activateOn(rec, { mid, name, os, ver }, now) {
  const osKey = os === 'mac' ? 'mac' : os === 'android' ? 'android' : 'win';
  const clean = (v, n) => String(v || '').replace(/[<>"\u0000-\u001f]/g, '').trim().slice(0, n);
  let dev = appDevice(rec, (a) => a.mid === mid);
  if (dev) {
    dev.app = { ...dev.app, name: clean(name, 60) || dev.app.name, os: osKey, ver: clean(ver, 20), seen: now };
    dev.kind = APP_KINDS[osKey];
    setDevices(rec, devicesOf(rec).map((d) => (d.id === dev.id ? dev : d)));
    return { dev };
  }
  const devs = devicesOf(rec);
  if (devs.length >= maxDevicesOf(rec)) {
    const max = maxDevicesOf(rec);
    return { status: 403, error: 'All ' + max + ' device slot' + (max === 1 ? ' is' : 's are') + ' in use on this code. Remove a device in My Events (or ask us), then activate again.' };
  }
  const lid = randomBytes(10).toString('hex');
  addDevice(rec, 'app:' + lid, now, APP_KINDS[osKey]);
  const list = devicesOf(rec);
  dev = list[list.length - 1];
  dev.app = { lid, mid, name: clean(name, 60), os: osKey, ver: clean(ver, 20), seen: now };
  setDevices(rec, list.map((d) => (d.id === dev.id ? dev : d)));
  return { dev, isNew: true };
}
