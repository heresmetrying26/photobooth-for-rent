import { createHmac, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const DAY = 86400000;
export const MIN = 60000;

// ---------- bonus codes ----------
// A booking can come with a short bonus code (e.g. 1 hour to test the booth
// before the event). Its photos go into a subfolder of the event's Drive
// folder, and every file name starts with BONUS_ so they never mix with the
// event-day photos.
export const BONUS_SUBFOLDER = 'Bonus';
export const BONUS_PREFIX = 'BONUS_';

// Dates shown to renters/admin are written in the business's time zone
// (Netlify servers run on UTC). Override with the BOOTH_TZ env var.
export function fmtWhen(ms) {
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: process.env.BOOTH_TZ || 'Asia/Manila',
      dateStyle: 'medium', timeStyle: 'short'
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

// ---------- lifetime + multi-device ----------
// Lifetime codes never expire (stored as 31 Dec 9999 so every "expiresAt <= now"
// check keeps working). They ask for an event name in the booth, and each event
// gets its own Drive folder: "<Drive folder name> · <event name>".
export const LIFETIME_EXP = 253402300799000;
export const MAX_DEVICES = 50;

// Devices a code is bound to: [{ id, no, at }]. "no" is the device number shown
// in admin and added to file names (…_cam2.png) when a code allows several
// devices. Older records only have a single deviceId.
export function devicesOf(rec) {
  if (Array.isArray(rec.devices)) return rec.devices;
  return rec.deviceId ? [{ id: rec.deviceId, no: 1, at: rec.redeemedAt || null }] : [];
}
export function maxDevicesOf(rec) {
  const n = Math.floor(Number(rec.maxDevices) || 1);
  return Math.max(1, Math.min(MAX_DEVICES, n));
}
// Numbers only ever go up, so a replaced device never reuses an old number
// (its photos already in Drive keep a unique name).
export function addDevice(rec, id, now) {
  const list = devicesOf(rec).slice();
  const used = list.reduce((m, d) => Math.max(m, d.no || 0), 0);
  const no = Math.max(rec.nextDeviceNo || 1, used + 1);
  list.push({ id, no, at: now });
  rec.devices = list;
  rec.nextDeviceNo = no + 1;
  rec.deviceId = list[0].id; // kept for older code paths / display
  return no;
}
export function setDevices(rec, list) {
  rec.devices = list;
  rec.deviceId = list.length ? list[0].id : null;
}

// ---------- event folders (for the /lifetime customer page) ----------
// The booth reports every Drive folder it uses, so customers can find their
// event links again later from any device. Stored per code:
// { events: [{ folderKey, name, folderUrl, bonus, firstAt, lastAt, sessions }] }
export const eventsStore = () => getStore({ name: 'events', consistency: 'strong' });
export const EVENT_KEEP_DAYS = 7;   // must match EVENT_DAYS in apps-script/cleanup.gs
export const BONUS_KEEP_DAYS = 1;   // must match BONUS_DAYS
export const MAX_EVENTS = 300;
export const isDriveUrl = (u) => typeof u === 'string' && u.length < 300 && /^https:\/\/drive\.google\.com\/[A-Za-z0-9_\-\/?=&.%]+$/.test(u);

// ---------- signed Drive upload tickets ----------
// The Apps Script that writes to Google Drive only accepts uploads carrying a
// ticket signed with UPLOAD_SECRET (the same value is saved in the script's
// Script Properties). The ticket names the ONE folder (and optional subfolder)
// this booth may use, so nobody can point the script at another folder.
function uploadSecret() {
  const s = process.env.UPLOAD_SECRET;
  if (!s || s.length < 16) throw new Error('UPLOAD_SECRET env var is missing or too short (use 32+ random characters).');
  return s;
}
export function signTicket(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + createHmac('sha256', uploadSecret()).update(body).digest('base64url');
}
export const TICKET_MS = 12 * 3600000;

// Same rule as the booth: letters, numbers, spaces and basic punctuation only,
// and no long unbroken runs (so a Drive folder ID can't sneak through).
export function cleanEventName(v) {
  return String(v || '').replace(/[^\p{L}\p{N} '\u2019&().,!_-]/gu, '').replace(/[\p{L}\p{N}_.-]{20,}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// A device not seen for this long can be replaced by a new device entering
// the code (e.g. Safari cleared the iPad's saved data after a week unused).
export const STALE_DEVICE_DAYS = 7;

// When an unused code's booking window ends (null = no fixed window yet).
// Scheduled codes run from their opening time for `days` days, no matter
// when the renter first types the code in.
export function windowEnd(rec) {
  if (!rec) return null;
  if (rec.expiresAt) return rec.expiresAt;
  if (rec.lifetime) return null;
  if (rec.kind !== 'bonus' && rec.startsAt) return rec.startsAt + rec.days * DAY;
  return null;
}

// Strong consistency so a code can't be redeemed twice by two quick requests.
export const licenses = () => getStore({ name: 'licenses', consistency: 'strong' });
export const meta = () => getStore({ name: 'meta', consistency: 'strong' });

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export const safe = (fn) => async (req, ctx) => {
  try {
    return await fn(req, ctx);
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error: ' + e.message }, 500);
  }
};

// ---------- signed tokens (HMAC-SHA256) ----------
function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 16) throw new Error('TOKEN_SECRET env var is missing or too short (use 32+ random characters).');
  return s;
}
const hmac = (body) => createHmac('sha256', secret()).update(body).digest('base64url');

export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body);
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

export const sha = (s) => createHash('sha256').update(String(s)).digest();

// ---------- rental codes ----------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function newCode() {
  let s = 'PB';
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
// Short random suffix so every trial session gets its own Drive folder,
// even when several people are trialling it at the same time.
export function shortId() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
export const displayCode = (key) => key.replace(/^(PB)(.{4})(.{4})(.{4})$/, '$1-$2-$3-$4');
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- printing ----------
// Paper sizes the admin can allow per rental. Keys are stored in license data;
// the booth has its own table with the physical dimensions.
export const PAPER_SIZES = ['2x6', '3.5x5', '4x6', '5x7', '6x8', '8x10', 'A6', 'A5', 'A4', 'Letter'];
// Custom sizes are stored as "<width>x<height><unit>", e.g. "4x4in" or "100x148mm".
const CUSTOM_RE = /^(\d{1,3}(?:\.\d{1,2})?)x(\d{1,3}(?:\.\d{1,2})?)(in|mm)$/;
export function customPaperOk(key) {
  const m = CUSTOM_RE.exec(String(key));
  if (!m) return false;
  const [lo, hi] = m[3] === 'in' ? [1, 20] : [25, 500];
  const w = Number(m[1]), h = Number(m[2]);
  return w >= lo && w <= hi && h >= lo && h <= hi;
}
// Cleans whatever was stored/sent into { enabled, sizes }: built-in sizes in a
// fixed order, then up to 6 valid custom sizes. Printing counts as on only when
// at least one size is allowed. Older codes have no print data -> printing off.
export function normPrint(enabled, sizes) {
  const given = Array.isArray(sizes) ? sizes.map(String) : [];
  const custom = [...new Set(given.filter((s) => !PAPER_SIZES.includes(s) && customPaperOk(s)))].slice(0, 6);
  const list = PAPER_SIZES.filter((s) => given.includes(s)).concat(custom);
  return { enabled: !!enabled && list.length > 0, sizes: list };
}

// ---------- settings ----------
export async function getSettings() {
  const saved = await meta().get('settings', { type: 'json' });
  return {
    trialEnabled: true,
    trialPassword: process.env.TRIAL_PASSWORD || 'TRIAL',
    trialMinutes: 15,
    trialFolderPrefix: 'Trial test shots',
    trialPrintEnabled: false,
    trialPrintSizes: ['4x6'],
    trialTraditional: false,
    ...(saved || {})
  };
}

// ---------- brute-force throttle (per IP) ----------
export async function throttle(kind, ip, limit = 8, windowMs = 15 * 60000) {
  const key = 'fail-' + kind + '-' + String(ip || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_');
  let rec = await meta().get(key, { type: 'json' });
  if (!rec || Date.now() - rec.start > windowMs) rec = { count: 0, start: Date.now() };
  return { blocked: rec.count >= limit, rec, key };
}
export async function recordFail(t) {
  t.rec.count++;
  await meta().setJSON(t.key, t.rec);
}
export async function clearFail(t) {
  if (t.rec.count) await meta().delete(t.key);
}

// ---------- license check used by /api/app and /api/verify ----------
export async function checkLicense(token, deviceId) {
  const p = verifyToken(token);
  if (!p || (p.t !== 'rental' && p.t !== 'trial')) return { valid: false, reason: 'invalid' };
  if (!deviceId || p.d !== deviceId) return { valid: false, reason: 'invalid' };
  const now = Date.now();

  if (p.t === 'trial') {
    if (p.exp <= now) return { valid: false, reason: 'trial-ended' };
    const s = await getSettings();
    if (!s.trialEnabled) return { valid: false, reason: 'trial-disabled' };
    return { valid: true, type: 'trial', exp: p.exp, token, folderKey: p.f || null, print: normPrint(s.trialPrintEnabled, s.trialPrintSizes), traditional: !!s.trialTraditional };
  }

  const rec = await licenses().get(p.k, { type: 'json' });
  if (!rec || rec.status === 'revoked') return { valid: false, reason: 'revoked' };
  if (rec.status !== 'active') return { valid: false, reason: 'invalid' };
  const me = devicesOf(rec).find((d) => d.id === p.d);
  if (!me) return { valid: false, reason: 'device-removed' };
  // Remember when each device was last used (at most every 6 hours).
  if (now - (me.seen || me.at || 0) > 6 * 3600000) {
    me.seen = now;
    setDevices(rec, devicesOf(rec).map((d) => (d.id === me.id ? me : d)));
    await licenses().setJSON(p.k, rec);
  }
  const bonus = rec.kind === 'bonus';
  if (rec.expiresAt <= now) return { valid: false, reason: bonus ? 'bonus-ended' : 'expired' };
  // Expiry always comes from the server record, so an admin "extend" applies instantly.
  const exp = rec.expiresAt;
  const fresh = exp === p.exp ? token : sign({ t: 'rental', k: p.k, d: p.d, exp });
  return {
    valid: true, type: 'rental', exp, token: fresh,
    // Lifetime: no fixed folder; the booth asks for an event name and uses
    // "<folderPrefix> · <event name>".
    folderKey: rec.lifetime ? null : ((rec.folderName || rec.label || '').trim() || null),
    folderPrefix: rec.lifetime ? ((rec.folderName || rec.label || rec.code || '').trim() || null) : null,
    lifetime: !!rec.lifetime,
    deviceNo: me.no || 1,
    multiDevice: maxDevicesOf(rec) > 1,
    print: normPrint(rec.print && rec.print.enabled, rec.print && rec.print.sizes),
    traditional: !!rec.traditional,
    bonus,
    subfolder: bonus ? (rec.subfolder || BONUS_SUBFOLDER) : null,
    filePrefix: bonus ? BONUS_PREFIX : ''
  };
}
