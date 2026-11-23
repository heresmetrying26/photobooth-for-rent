// Self-hosted Cloudflare PayMongo Worker tests: CORS, auth, QR creation, webhook HMAC-SHA256,
// status polling, and test-mode simulate. Run from repo root: node scripts/test-cloudflare-pay-worker.mjs
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const repo = process.argv[2] || process.cwd();
const worker = (await import(pathToFileURL(join(repo, 'tools/cloudflare-paymongo-worker/worker.js')).href)).default;

// Minimal in-memory KV mock matching Cloudflare KV get/put.
function makeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    _map: m
  };
}

// Mock PayMongo API v1 responses.
let piStatus = 'awaiting_next_action';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (!url.startsWith('https://mock.paymongo.test/v1')) return realFetch(u, opts);
  const p = url.slice('https://mock.paymongo.test/v1'.length);
  if (p === '/payment_intents' && opts.method === 'POST') {
    return new Response(JSON.stringify({ data: { id: 'pi_test1234567890', attributes: { client_key: 'ck_123' } } }), { status: 200 });
  }
  if (p === '/payment_methods' && opts.method === 'POST') {
    return new Response(JSON.stringify({ data: { id: 'pm_test1234567890' } }), { status: 200 });
  }
  if (p === '/payment_intents/pi_test1234567890/attach' && opts.method === 'POST') {
    return new Response(JSON.stringify({ data: { attributes: { next_action: { code: { image_url: 'data:image/png;base64,AAA=' } } } } }), { status: 200 });
  }
  if (p === '/payment_intents/pi_test1234567890' && opts.method === 'GET') {
    return new Response(JSON.stringify({ data: { attributes: { status: piStatus } } }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const kv = makeKv();
const env = {
  PAYMONGO_API_BASE: 'https://mock.paymongo.test/v1',
  PAYMONGO_SECRET_KEY: 'sk_test_1234567890abcdef',
  PAYMONGO_WEBHOOK_SECRET: 'whsk_test_secret_key_999',
  BOOTH_TOKEN: 'booth-secret-123',
  ALLOWED_ORIGIN: '*',
  PAY_KV: kv
};

const call = (path, body, headers = {}, method = 'POST') =>
  worker.fetch(new Request('https://worker.test' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  }), env);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); } else console.log('ok   ' + m); };

// 1. CORS preflight
let r = await call('/', null, {}, 'OPTIONS');
ok(r.status === 204 && r.headers.get('access-control-allow-origin') === '*', 'OPTIONS CORS preflight works');

// 2. Bearer token enforcement
r = await call('/', { action: 'config' });
ok(r.status === 401, 'missing BOOTH_TOKEN is rejected (401)');
r = await call('/', { action: 'config' }, { authorization: 'Bearer wrong' });
ok(r.status === 401, 'wrong BOOTH_TOKEN is rejected (401)');

// 3. Config check
r = await call('/', { action: 'config' }, { authorization: 'Bearer booth-secret-123' });
let j = await r.json();
ok(r.status === 200 && j.ok && j.acct.connected && j.acct.mode === 'test' && j.acct.webhook && j.acct.kv && j.acct.selfHosted, 'config reports connected test mode + webhook + KV');

// 4. Create QR Ph
r = await call('/', { action: 'qr', amount: 100, prints: 2, tier: 'photo', label: 'Coloured' }, { authorization: 'Bearer booth-secret-123' });
j = await r.json();
ok(r.status === 200 && j.ok && j.id === 'pi_test1234567890' && j.image.startsWith('data:image/png') && j.test === true, 'creates PayMongo QR Ph payment intent');

// 5. Status is awaiting before payment
r = await call('/', { action: 'status', id: 'pi_test1234567890' }, { authorization: 'Bearer booth-secret-123' });
j = await r.json();
ok(r.status === 200 && j.status === 'awaiting', 'status is awaiting before payment');

// 6. Webhook rejects forged signature
const hookBody = JSON.stringify({
  data: { attributes: { type: 'payment.paid', livemode: false, data: { id: 'pay_1', attributes: { payment_intent_id: 'pi_test1234567890', amount: 10000 } } } }
});
const ts = Math.floor(Date.now() / 1000);
r = await call('/webhook', hookBody, { 'paymongo-signature': `t=${ts},te=deadbeef,li=` });
ok(r.status === 401, 'forged webhook signature is rejected (401)');

// 7. Webhook ignores mismatched amount
const badAmtBody = JSON.stringify({
  data: { attributes: { type: 'payment.paid', livemode: false, data: { id: 'pay_2', attributes: { payment_intent_id: 'pi_test1234567890', amount: 5000 } } } }
});
const badAmtSig = createHmac('sha256', env.PAYMONGO_WEBHOOK_SECRET).update(`${ts}.${badAmtBody}`).digest('hex');
r = await call('/webhook', badAmtBody, { 'paymongo-signature': `t=${ts},te=${badAmtSig},li=` });
ok(r.status === 200, 'mismatched amount webhook returns 200 without marking paid');
j = await (await call('/', { action: 'status', id: 'pi_test1234567890' }, { authorization: 'Bearer booth-secret-123' })).json();
ok(j.status === 'awaiting', 'mismatched amount did NOT mark session paid');

// 8. Valid webhook marks paid in KV instantaneously
const goodSig = createHmac('sha256', env.PAYMONGO_WEBHOOK_SECRET).update(`${ts}.${hookBody}`).digest('hex');
r = await call('/webhook', hookBody, { 'paymongo-signature': `t=${ts},te=${goodSig},li=` });
ok(r.status === 200, 'valid HMAC-SHA256 webhook accepted');
j = await (await call('/', { action: 'status', id: 'pi_test1234567890' }, { authorization: 'Bearer booth-secret-123' })).json();
ok(j.status === 'paid' && j.prints === 2 && j.tier === 'photo', 'status immediately returns paid from KV after webhook');

// 9. Polling fallback works even WITHOUT KV bound
piStatus = 'succeeded';
const noKvEnv = { ...env, PAY_KV: undefined };
r = await worker.fetch(new Request('https://worker.test/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer booth-secret-123' },
  body: JSON.stringify({ action: 'status', id: 'pi_test1234567890' })
}), noKvEnv);
j = await r.json();
ok(r.status === 200 && j.status === 'paid', 'status polling fallback works without KV');

// 10. Simulate blocked in live mode, allowed in test mode
r = await worker.fetch(new Request('https://worker.test/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer booth-secret-123' },
  body: JSON.stringify({ action: 'simulate', id: 'pi_test1234567890' })
}), { ...env, PAYMONGO_SECRET_KEY: 'sk_live_1234567890abcdef' });
ok(r.status === 403, 'simulate is blocked with sk_live_ key');

if (fails) { console.error(fails + ' check(s) failed'); process.exit(1); }
console.log('OK: cloudflare paymongo worker');
