// The app's licence: activation, the signed licence file, check-ins and the
// checks that run before the booth opens.
//
// A licence is "PB4U-LIC1.<payload>.<signature>", signed on photobooth4u.netlify.app
// with an Ed25519 key that never leaves Netlify. This app only has the PUBLIC key
// (build/license-pubkey.txt), so it can check a licence but never make one.
// The licence names this computer (machine id), so it doesn't work when copied
// to another laptop.
//
// What stops the booth:
//  - a rental code's end date (exp)
//  - "hard": a lifetime laptop must reach the internet now and then (every
//    ~75 days, with a 30-day grace); each check-in gives it a fresh licence
//  - the computer clock being set back (we remember the latest time we've seen,
//    and compare with the internet's time whenever we're online)
//  - Admin removing the laptop / disabling the code / taking the add-on away
//    (applies at the next check-in)
import { createPublicKey, verify as edVerify, createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, hostname, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

export const SERVER = (process.env.PB4U_SERVER || 'https://photobooth4u.netlify.app').replace(/\/+$/, '');
const PREFIX = 'PB4U-LIC1';
const HOUR = 3600000, DAY = 24 * HOUR;
const CLOCK_SLACK = 6 * HOUR;          // time zones / small clock fixes are fine
const CHECK_EVERY = 12 * HOUR;         // check in at most this often when online

let PUB = null, DIR = null, SECRET = null, state = null, ver = '0';
const stateFile = () => join(DIR, 'licence.json');
// A second copy of "latest time seen" outside the app's folder, so deleting the
// app data doesn't wind the clock check back.
const seenFile = () => join(homedir(), platform() === 'win32' ? 'AppData/Local/.pb4u-ts' : '.pb4u-ts');

export function initLicence({ dataDir, pubKeyB64, version }) {
  DIR = dataDir; ver = version || '0';
  mkdirSync(DIR, { recursive: true });
  if (pubKeyB64) PUB = createPublicKey({ key: Buffer.from(pubKeyB64.trim(), 'base64'), format: 'der', type: 'spki' });
  SECRET = createHash('sha256').update('pb4u-state|' + machineId()).digest();
  state = load();
}
export const hasPublicKey = () => !!PUB;

// ---------- this computer ----------
let MID = null;
export function machineId() {
  if (MID) return MID;
  let raw = '', pre = 'WIN';
  const os = platform();
  try {
    if (os === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      raw = (/MachineGuid\s+REG_\w+\s+([^\s]+)/.exec(out) || [])[1] || '';
    } else if (os === 'darwin') {
      pre = 'MAC';
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      raw = (/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out) || [])[1] || '';
    } else {
      // Linux is only used for testing; it acts like a Windows laptop.
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) { try { raw = readFileSync(f, 'utf8').trim(); if (raw) break; } catch { /* next */ } }
    }
  } catch { /* fall through */ }
  if (!raw) {
    // No hardware id: keep a random one for this laptop (still unique per laptop).
    const f = join(DIR || homedir(), 'machine.id');
    try { raw = readFileSync(f, 'utf8').trim(); } catch { raw = randomBytes(16).toString('hex'); try { writeFileSync(f, raw); } catch { /* ignore */ } }
  }
  const h = createHash('sha256').update('pb4u-mid|' + raw.toUpperCase()).digest();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += A[h[i] % 32];
  MID = pre + '-' + s.match(/.{4}/g).join('-');
  return MID;
}
export const osKey = () => (platform() === 'darwin' ? 'mac' : 'win');
export const computerName = () => {
  const n = String(hostname() || '').replace(/\.local$/i, '').trim();
  return (n || (osKey() === 'mac' ? 'Mac' : 'Windows laptop')).slice(0, 60);
};

// ---------- licence text ----------
export function readLicence(lic) {
  if (!PUB || typeof lic !== 'string') return null;
  const parts = lic.replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    if (!edVerify(null, Buffer.from(parts[0] + '.' + parts[1]), PUB, Buffer.from(parts[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return p && p.typ === 'pb4u-desktop' ? p : null;
  } catch { return null; }
}
const cleanLic = (lic) => String(lic || '').replace(/\s+/g, '');

// ---------- saved state (signed so it can't be edited by hand) ----------
function sealState(s) { const body = JSON.stringify(s); return JSON.stringify({ body, mac: createHmac('sha256', SECRET).update(body).digest('hex') }); }
function load() {
  let s = null;
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
    if (raw && raw.body && createHmac('sha256', SECRET).update(raw.body).digest('hex') === raw.mac) s = JSON.parse(raw.body);
  } catch { /* none yet / damaged */ }
  s = s || {};
  s.seen = Math.max(s.seen || 0, readSeen());
  return s;
}
function readSeen() {
  try {
    const raw = readFileSync(seenFile(), 'utf8').trim().split('.');
    if (raw.length === 2 && createHmac('sha256', SECRET).update(raw[0]).digest('hex').slice(0, 24) === raw[1]) return Number(raw[0]) || 0;
  } catch { /* none */ }
  return 0;
}
function save() {
  try {
    const f = stateFile(), tmp = f + '.tmp';
    writeFileSync(tmp, sealState(state));
    renameSync(tmp, f);
  } catch (e) { console.error('licence save', e); }
  try {
    mkdirSync(dirname(seenFile()), { recursive: true });
    const t = String(state.seen || 0);
    writeFileSync(seenFile(), t + '.' + createHmac('sha256', SECRET).update(t).digest('hex').slice(0, 24));
  } catch { /* best effort */ }
}
// Remember the latest time seen (call often while the app runs).
export function touchClock() {
  const now = Date.now();
  if (now > (state.seen || 0)) { state.seen = now; save(); }
}

// ---------- status ----------
// { ok, reason, message, p (payload), warn }
export function status() {
  const now = Date.now();
  if (!PUB) return { ok: false, reason: 'nokey', message: 'This copy of the app is missing its licence key. Please download the app again.' };
  if (!state.lic) return { ok: false, reason: 'none' };
  const p = readLicence(state.lic);
  if (!p || p.mid !== machineId()) return { ok: false, reason: 'invalid', message: 'This licence isn’t for this computer. Activate with your code.' };
  if (state.revoked) return { ok: false, reason: 'revoked', p, message: state.revoked.error || 'This laptop’s licence was cancelled. Activate it again with your code.' };
  if (state.skew) return { ok: false, reason: 'clock', p, message: 'This computer’s date and time are wrong. Set them to automatic in the computer’s settings, then open the app again.' };
  if (now < (state.seen || 0) - CLOCK_SLACK || now < (p.iat || 0) - CLOCK_SLACK) {
    return { ok: false, reason: 'clock', p, message: 'This computer’s clock was set back. Set the date and time to automatic, then open the app again.' };
  }
  if (p.exp && now >= p.exp) return { ok: false, reason: 'expired', p, message: 'Your code ended on ' + new Date(p.exp).toLocaleString() + '. Message us to book again.' };
  if (now >= p.hard) {
    return { ok: false, reason: 'checkin', p, message: 'Connect this laptop to the internet once so it can renew its licence (it needs to every few weeks).' };
  }
  let warn = '';
  if (!p.exp && now >= p.chk) warn = 'Connect to the internet soon: this laptop needs to renew its licence by ' + new Date(p.hard).toLocaleDateString() + '.';
  return { ok: true, p, warn };
}
export const deviceId = () => { if (!state.dev) { state.dev = 'dsk-' + randomBytes(9).toString('hex'); save(); } return state.dev; };
export const lastCheck = () => state.lastCheck || 0;

// ---------- talking to photobooth4u.netlify.app ----------
async function post(fetchFn, body, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 15000);
  try {
    const r = await fetchFn(SERVER + '/api/license', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j, date: Date.parse(r.headers.get('date') || '') || 0 };
  } finally { clearTimeout(t); }
}
// The internet's clock (from the server's reply) vs this computer's.
function clockFrom(date) {
  if (!date) return;
  const off = Date.now() - date;
  state.skew = Math.abs(off) > 36 * HOUR ? off : 0;
  state.seen = Math.max(state.seen || 0, Math.min(Date.now(), date + HOUR));
}

function store(lic) {
  state.lic = cleanLic(lic); state.revoked = null; state.lastCheck = Date.now(); state.skew = 0;
  touchClock(); save();
}

export async function activate(fetchFn, code) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, error: 'Type your code first.' };
  let r;
  try { r = await post(fetchFn, { action: 'activate', code: c, mid: machineId(), name: computerName(), os: osKey(), ver }, 20000); }
  catch { return { ok: false, offline: true, error: 'Can’t reach photobooth4u. Check the internet, or use “Activate without internet”.' }; }
  if (r.status !== 200 || !r.j.ok || !readLicence(r.j.licence)) return { ok: false, error: r.j.error || ('Activation failed (' + r.status + ').'), code: r.j.code };
  clockFrom(r.date);
  store(r.j.licence);
  return { ok: true };
}
// Pasted licence from Admin ("Offline activation key").
export function activateOffline(text) {
  const lic = cleanLic(text);
  const p = readLicence(lic);
  if (!p) return { ok: false, error: 'That isn’t a valid licence. Copy the whole text from photobooth4u (it starts with PB4U-LIC1).' };
  if (p.mid !== machineId()) return { ok: false, error: 'This licence was made for another computer (' + p.mid + '). This one is ' + machineId() + '.' };
  if (Date.now() < (state.seen || 0) - CLOCK_SLACK) return { ok: false, error: 'This computer’s clock was set back. Fix the date and time first.' };
  if (p.exp && Date.now() >= p.exp) return { ok: false, error: 'This licence has already ended.' };
  if (Date.now() >= p.hard) return { ok: false, error: 'This licence is too old. Ask for a new one.' };
  store(lic);
  state.lastCheck = 0; save();          // check in properly the next time we're online
  return { ok: true };
}

// Returns 'ok' | 'revoked' | 'offline' | 'skip'.
export async function checkin(fetchFn, force) {
  if (!state.lic) return 'skip';
  if (!force && Date.now() - (state.lastTry || 0) < CHECK_EVERY && !state.skew) return 'skip';
  state.lastTry = Date.now(); save();
  let r;
  try { r = await post(fetchFn, { action: 'checkin', licence: state.lic, mid: machineId(), ver }, 15000); }
  catch { return 'offline'; }
  clockFrom(r.date);
  if (r.status === 200 && r.j.ok && readLicence(r.j.licence)) { store(r.j.licence); return 'ok'; }
  if (r.j && r.j.revoked) { state.revoked = { reason: r.j.reason || 'removed', error: r.j.error || '' }; state.lastCheck = Date.now(); save(); return 'revoked'; }
  save();
  return 'offline';
}

export async function deactivate(fetchFn) {
  if (!state.lic) return { ok: true };
  try {
    const r = await post(fetchFn, { action: 'deactivate', licence: state.lic, mid: machineId() }, 15000);
    if (r.status !== 200 || !r.j.ok) return { ok: false, error: r.j.error || 'Couldn’t reach photobooth4u to free this laptop’s slot.' };
  } catch { return { ok: false, offline: true, error: 'Connect to the internet to deactivate, so this laptop’s slot is freed for another one.' }; }
  state.lic = null; state.revoked = null; save();
  return { ok: true };
}
export function forget() { state.lic = null; state.revoked = null; save(); }
export function info() {
  const s = status();
  const p = s.p || (state.lic ? readLicence(state.lic) : null);
  return {
    ok: s.ok, reason: s.reason || '', message: s.message || '', warn: s.warn || '',
    mid: machineId(), name: computerName(), os: osKey(),
    renter: p ? p.renter : '', code: p ? p.code : '', lifetime: p ? !!p.lifetime : false,
    exp: p ? p.exp : null, hard: p ? p.hard : null, chk: p ? p.chk : null, lastCheck: state.lastCheck || 0, feat: p ? p.feat : null
  };
}
