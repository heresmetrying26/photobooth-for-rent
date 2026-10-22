// Guest payments: vouchers (an attendant sells them) and the renter's own
// PayMongo account (QR Ph, fully automatic).
//
// Security of a renter's PayMongo secret key:
//  - encrypted (AES-256-GCM) with PB_VAULT_KEY, a Netlify environment variable
//    that never lives in the code or the database; the ciphertext is bound to
//    the renter's account id (AAD), so it can't be moved to another account
//  - write-only: no endpoint ever returns it (only "…last4" and test/live)
//  - only decrypted in memory for the one PayMongo call that needs it
//  - connect / replace / disconnect need the renter's payments PIN
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual, scryptSync, randomInt } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { cleanEventName } from './core.mjs';

export const payStore = () => getStore({ name: 'pay', consistency: 'strong' });

// Short, non-reversible id for a booking (used in keys and the webhook URL).
export const ownerId = (bookingKey) => createHash('sha256').update('pay|' + String(bookingKey)).digest('hex').slice(0, 24);
// Lifetime codes keep payments and vouchers per event; other codes have one event.
export const eventKeyOf = (lifetime, ev) => (lifetime ? (cleanEventName(ev || '').toLowerCase() || '_') : '_');

// ---------- vault ----------
function vaultKey() {
  const s = process.env.PB_VAULT_KEY;
  if (!s || s.length < 32) return null;
  return createHash('sha256').update('pb4u-vault|' + s).digest();
}
export const vaultReady = () => !!vaultKey();
export function seal(plain, aad) {
  const k = vaultKey();
  if (!k) throw new Error('vault');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
export function unseal(sealed, aad) {
  const k = vaultKey();
  if (!k || typeof sealed !== 'string') throw new Error('vault');
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('vault');
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------- payments PIN ----------
export const PIN_RE = /^\d{4,8}$/;
export function pinRecord(pin) {
  const salt = randomBytes(16).toString('base64url');
  return { pinSalt: salt, pinHash: scryptSync(String(pin), salt, 32).toString('base64url') };
}
export function pinOk(acct, pin) {
  if (!acct || !acct.pinHash || !PIN_RE.test(String(pin || ''))) return false;
  const a = scryptSync(String(pin), acct.pinSalt, 32), b = Buffer.from(acct.pinHash, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- PayMongo ----------
export const KEY_RE = /^sk_(test|live)_[A-Za-z0-9]{10,100}$/;
const API = () => (process.env.PAYMONGO_API_BASE || 'https://api.paymongo.com/v1').replace(/\/+$/, '');
export async function pm(key, method, path, body) {
  const r = await fetch(API() + path, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e0 = (j && j.errors && j.errors[0]) || {};
    const err = new Error(String(e0.detail || e0.code || ('PayMongo error ' + r.status)).slice(0, 200));
    err.status = r.status; err.code = e0.code || '';
    throw err;
  }
  return j;
}
export const acctKey = (oid) => 'acct/' + oid;
export async function getAcct(oid) { return payStore().get(acctKey(oid), { type: 'json' }); }
// What anyone (renter, admin, booth) may see about a connection. Never the key.
export function acctPublic(a) {
  if (!a || !a.enc) return { connected: false, pinSet: !!(a && a.pinHash) };
  return { connected: true, mode: a.mode, last4: a.last4, connectedAt: a.connectedAt, webhook: !!a.whId, pinSet: !!a.pinHash };
}
export function hookUrl(base, oid) { return String(base).replace(/\/+$/, '') + '/api/pay/hook?o=' + oid; }

// Sets up PayMongo's "payment paid" notifications on the renter's account.
// Old ones pointing at this booking are switched off first. Never fatal: the
// booth also asks PayMongo directly while a QR is on screen.
export async function setupWebhook(key, url) {
  try {
    const list = await pm(key, 'GET', '/webhooks');
    for (const w of (list.data || [])) {
      const a = w.attributes || {};
      if (a.url === url && a.status !== 'disabled') { try { await pm(key, 'POST', '/webhooks/' + w.id + '/disable'); } catch (e) {} }
    }
  } catch (e) { /* listing isn't essential */ }
  for (const events of [['payment.paid', 'payment.failed', 'qrph.expired'], ['payment.paid']]) {
    try {
      const w = await pm(key, 'POST', '/webhooks', { data: { attributes: { url, events } } });
      const secret = w && w.data && w.data.attributes && w.data.attributes.secret_key;
      if (w && w.data && w.data.id && secret) return { id: w.data.id, secret };
    } catch (e) { /* try the shorter event list, then give up */ }
  }
  return null;
}

// PayMongo-Signature: t=<ts>,te=<test sig>,li=<live sig>; HMAC-SHA256 of "<t>.<raw body>".
export function signatureOk(header, raw, secret, live) {
  const parts = Object.fromEntries(String(header || '').split(',').map((s) => s.trim().split('=')).filter((x) => x.length === 2));
  const want = live ? parts.li : parts.te;
  if (!parts.t || !want) return false;
  const mine = createHmac('sha256', secret).update(parts.t + '.' + raw).digest('hex');
  const a = Buffer.from(mine), b = Buffer.from(String(want));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Math.abs(Date.now() / 1000 - Number(parts.t)) < 3 * 86400;   // not an old replay
}

// ---------- QR Ph payments ----------
export const QR_SECONDS = 300;            // a guest has 5 minutes to pay
export const PRICE_MIN = 20, PRICE_MAX = 20000;
export const payKey = (oid, id) => 'pp/' + oid + '/' + id;
export async function createQr(key, { amount, description, metadata }) {
  const pi = await pm(key, 'POST', '/payment_intents', { data: { attributes: {
    amount: Math.round(amount * 100), currency: 'PHP', payment_method_allowed: ['qrph'], capture_type: 'automatic',
    description: String(description || 'Photo booth session').slice(0, 120), metadata
  } } });
  let method = null;
  for (const extra of [{}, { billing: { name: 'Photo booth guest', email: 'guest@photobooth4u.app' } }]) {
    try { method = await pm(key, 'POST', '/payment_methods', { data: { attributes: Object.assign({ type: 'qrph', expiry_seconds: QR_SECONDS }, extra) } }); break; }
    catch (e) { if (Object.keys(extra).length) throw e; }
  }
  const at = await pm(key, 'POST', '/payment_intents/' + pi.data.id + '/attach', { data: { attributes: { payment_method: method.data.id, client_key: pi.data.attributes.client_key } } });
  const code = at && at.data && at.data.attributes && at.data.attributes.next_action && at.data.attributes.next_action.code;
  const image = code && (code.image_url || code.image);
  if (!image) throw new Error('PayMongo did not return a QR code. Is QR Ph switched on for this PayMongo account?');
  return { id: pi.data.id, image: /^data:image\//.test(image) ? image : 'data:image/png;base64,' + image };
}

// ---------- vouchers ----------
// 8 digits, typed on a number pad. One voucher = one session.
export const VOUCHER_RE = /^\d{8}$/;
export const batchKey = (oid, id) => 'vb/' + oid + '/' + id;
export const usedKey = (oid, code) => 'vu/' + oid + '/' + code;
export const voucherHash = (oid, code) => createHash('sha256').update('v|' + oid + '|' + code).digest('hex').slice(0, 20);
export const newBatchId = () => Date.now().toString(36) + randomInt(36 ** 4).toString(36).padStart(4, '0');
export function newVoucherCodes(n, taken) {
  const out = [];
  while (out.length < n) {
    const c = String(randomInt(10000000, 100000000));
    if (!taken.has(c)) { taken.add(c); out.push(c); }
  }
  return out;
}
export async function listJSON(prefix, max = 400) {
  const st = payStore();
  const { blobs } = await st.list({ prefix });
  const keys = blobs.map((x) => x.key).sort().reverse().slice(0, max);
  const out = [];
  for (let i = 0; i < keys.length; i += 25) {
    const part = await Promise.all(keys.slice(i, i + 25).map((k) => st.get(k, { type: 'json' })));
    part.forEach((v) => { if (v) out.push(v); });
  }
  return out;
}
export async function usedMap(oid) {
  const { blobs } = await payStore().list({ prefix: 'vu/' + oid + '/' });
  const m = {};
  blobs.forEach((x) => { m[x.key.slice(('vu/' + oid + '/').length)] = true; });
  return m;
}
// A batch as the renter / admin sees it (codes included: they print the tickets).
export function batchView(bt, used) {
  const voided = new Set(bt.voided || []);
  const codes = bt.codes.map((c) => ({ c, used: !!used[c], voided: voided.has(c) }));
  return { id: bt.id, ev: bt.ev, evName: bt.evName || '', at: bt.at, by: bt.by, price: bt.price || 0, prints: bt.prints || 0, label: bt.label || '',
    total: codes.length, usedCount: codes.filter((x) => x.used).length, voidCount: codes.filter((x) => x.voided && !x.used).length, codes };
}
export async function createBatch(oid, { ev, evName, count, prints, price, label, by }) {
  const n = Math.max(1, Math.min(200, Math.floor(Number(count) || 0)));
  const existing = await listJSON('vb/' + oid + '/', 1000);
  const taken = new Set(); existing.forEach((b) => b.codes.forEach((c) => taken.add(c)));
  const bt = { id: newBatchId(), ev, evName: String(evName || '').slice(0, 80), at: Date.now(), by: by === 'admin' ? 'admin' : 'renter',
    prints: Math.max(0, Math.min(10, Math.floor(Number(prints) || 0))), price: Math.max(0, Math.min(PRICE_MAX, Math.floor(Number(price) || 0))),
    label: String(label || '').replace(/[<>]/g, '').slice(0, 40), codes: newVoucherCodes(n, taken), voided: [] };
  await payStore().setJSON(batchKey(oid, bt.id), bt);
  return bt;
}
// Marks one voucher used. Returns { ok, prints } or { error }.
export async function redeemVoucher(oid, ev, code, dev, at) {
  if (!VOUCHER_RE.test(code)) return { error: 'bad' };
  const batches = await listJSON('vb/' + oid + '/', 1000);
  const bt = batches.find((b) => b.codes.includes(code));
  if (!bt) return { error: 'bad' };
  if (bt.ev !== ev) return { error: 'other-event', evName: bt.evName };
  if ((bt.voided || []).includes(code)) return { error: 'void' };
  const st = payStore(), uk = usedKey(oid, code);
  const prev = await st.get(uk, { type: 'json' });
  if (prev) return { error: 'used', at: prev.at };
  await st.setJSON(uk, { at: at || Date.now(), dev: dev || 0, b: bt.id });
  return { ok: true, prints: bt.prints || 0, batch: bt.id };
}
