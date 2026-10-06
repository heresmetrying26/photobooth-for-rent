import { createHmac, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const DAY = 86400000;

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

// ---------- settings ----------
export async function getSettings() {
  const saved = await meta().get('settings', { type: 'json' });
  return {
    trialEnabled: true,
    trialPassword: process.env.TRIAL_PASSWORD || 'TRIAL',
    trialMinutes: 15,
    trialFolderPrefix: 'Trial test shots',
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
    return { valid: true, type: 'trial', exp: p.exp, token, folderKey: p.f || null };
  }

  const rec = await licenses().get(p.k, { type: 'json' });
  if (!rec || rec.status === 'revoked') return { valid: false, reason: 'revoked' };
  if (rec.status !== 'active' || rec.deviceId !== p.d) return { valid: false, reason: 'invalid' };
  if (rec.expiresAt <= now) return { valid: false, reason: 'expired' };
  // Expiry always comes from the server record, so an admin "extend" applies instantly.
  const exp = rec.expiresAt;
  const fresh = exp === p.exp ? token : sign({ t: 'rental', k: p.k, d: p.d, exp });
  return { valid: true, type: 'rental', exp, token: fresh, folderKey: (rec.folderName || rec.label || '').trim() || null };
}
