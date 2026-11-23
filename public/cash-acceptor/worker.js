// Self-hosted PayMongo QR Ph API & Webhook Worker for photobooth4u.
// Deploy this to YOUR OWN Cloudflare account so your PayMongo secret key and
// webhook signing secret never leave Cloudflare.
//
// Required Worker secret:
//   PAYMONGO_SECRET_KEY      sk_live_... or sk_test_...
// Optional Worker secrets:
//   PAYMONGO_WEBHOOK_SECRET  whsk_... (from PayMongo -> Developers -> Webhooks)
//   BOOTH_TOKEN              shared secret pasted into the booth's Setup panel
// Optional KV binding (for instant webhook confirmation):
//   PAY_KV                   Cloudflare KV namespace
// Optional plain env vars:
//   ALLOWED_ORIGIN           default "*" (or "https://photobooth4u.netlify.app")
//   PAYMONGO_API_BASE        default "https://api.paymongo.com/v1"

const QR_SECONDS = 300;
const PRICE_MIN = 20;
const PRICE_MAX = 20000;
const PI_RE = /^pi_[A-Za-z0-9]{6,60}$/;

function corsHeaders(env) {
  return {
    'access-control-allow-origin': (env && env.ALLOWED_ORIGIN) || '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...corsHeaders(env)
    }
  });
}

function timingSafeEqualStr(a, b) {
  const ea = new TextEncoder().encode(String(a || ''));
  const eb = new TextEncoder().encode(String(b || ''));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// PayMongo-Signature: t=<ts>,te=<test sig>,li=<live sig>; HMAC-SHA256 of "<t>.<raw body>".
export async function signatureOk(header, raw, secret, live) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    String(header).split(',').map((s) => s.trim().split('=')).filter((x) => x.length === 2)
  );
  const want = live ? parts.li : parts.te;
  if (!parts.t || !want) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) >= 3 * 86400) return false;
  const mine = await hmacSha256Hex(secret, parts.t + '.' + raw);
  return timingSafeEqualStr(mine, want);
}

async function pm(env, method, path, body) {
  const base = ((env && env.PAYMONGO_API_BASE) || 'https://api.paymongo.com/v1').replace(/\/+$/, '');
  const key = String((env && env.PAYMONGO_SECRET_KEY) || '').trim();
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: 'Basic ' + btoa(key + ':'),
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e0 = (j && j.errors && j.errors[0]) || {};
    const err = new Error(String(e0.detail || e0.code || ('PayMongo error ' + r.status)).slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return j;
}

async function createQr(env, { amount, description }) {
  const pi = await pm(env, 'POST', '/payment_intents', {
    data: {
      attributes: {
        amount: Math.round(amount * 100),
        currency: 'PHP',
        payment_method_allowed: ['qrph'],
        capture_type: 'automatic',
        description: String(description || 'Photo booth session').slice(0, 120),
        metadata: { booth: 'photobooth4u', self_hosted: 'cloudflare' }
      }
    }
  });
  let method = null;
  for (const extra of [{}, { billing: { name: 'Photo booth guest', email: 'guest@photobooth4u.app' } }]) {
    try {
      method = await pm(env, 'POST', '/payment_methods', {
        data: { attributes: { type: 'qrph', expiry_seconds: QR_SECONDS, ...extra } }
      });
      break;
    } catch (e) {
      if (Object.keys(extra).length) throw e;
    }
  }
  const at = await pm(env, 'POST', '/payment_intents/' + pi.data.id + '/attach', {
    data: {
      attributes: {
        payment_method: method.data.id,
        client_key: pi.data.attributes.client_key
      }
    }
  });
  const code = at && at.data && at.data.attributes && at.data.attributes.next_action && at.data.attributes.next_action.code;
  const image = code && (code.image_url || code.image);
  if (!image) throw new Error('PayMongo did not return a QR code. Is QR Ph enabled on your PayMongo account?');
  return {
    id: pi.data.id,
    image: /^data:image\//.test(image) ? image : 'data:image/png;base64,' + image
  };
}

async function kvGet(env, key) {
  if (!env || !env.PAY_KV) return null;
  const raw = await env.PAY_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function kvPut(env, key, val) {
  if (!env || !env.PAY_KV) return;
  await env.PAY_KV.put(key, JSON.stringify(val), { expirationTtl: 1800 });
}

async function handleWebhook(req, env) {
  if (req.method !== 'POST') return new Response('ok');
  const raw = await req.text();
  if (!env.PAYMONGO_WEBHOOK_SECRET) return new Response('webhook secret not configured', { status: 503 });
  let ev;
  try { ev = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const attrs = ev && ev.data && ev.data.attributes;
  const live = !!(attrs && attrs.livemode);
  const ok = await signatureOk(req.headers.get('paymongo-signature'), raw, env.PAYMONGO_WEBHOOK_SECRET, live);
  if (!ok) return new Response('bad signature', { status: 401 });

  if (attrs && attrs.type === 'payment.paid') {
    const pay = attrs.data || {};
    const pa = pay.attributes || {};
    const piId = pa.payment_intent_id;
    if (piId && PI_RE.test(piId) && env.PAY_KV) {
      const k = 'pi:' + piId;
      const prev = await kvGet(env, k);
      if (prev) {
        if (prev.status !== 'paid' && Math.round(prev.amount * 100) === Number(pa.amount)) {
          prev.status = 'paid';
          prev.paidAt = Date.now();
          prev.payId = pay.id || null;
          prev.hook = true;
          await kvPut(env, k, prev);
        }
      } else {
        await kvPut(env, k, {
          id: piId,
          amount: Math.round(Number(pa.amount) || 0) / 100,
          status: 'paid',
          paidAt: Date.now(),
          payId: pay.id || null,
          hook: true
        });
      }
    }
  }
  return new Response('ok');
}

function authOk(req, env) {
  const want = String((env && env.BOOTH_TOKEN) || '').trim();
  if (!want) return true;
  const got = String(req.headers.get('authorization') || '');
  if (!got.startsWith('Bearer ')) return false;
  return timingSafeEqualStr(got.slice(7).trim(), want);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (path === '/webhook' || path === '/api/pay/hook') {
      return handleWebhook(req, env);
    }
    if (req.method !== 'POST') {
      return json({ ok: true, service: 'photobooth4u-paymongo-worker' }, 200, env);
    }
    if (!authOk(req, env)) {
      return json({ error: 'Unauthorized: check your Booth access token.' }, 401, env);
    }

    const key = String((env && env.PAYMONGO_SECRET_KEY) || '').trim();
    if (!/^sk_(test|live)_[A-Za-z0-9]{10,100}$/.test(key)) {
      return json({ error: 'PAYMONGO_SECRET_KEY secret is not configured on this Cloudflare Worker.' }, 503, env);
    }
    const isLive = key.startsWith('sk_live_');

    let b;
    try { b = await req.json(); } catch { return json({ error: 'Bad request' }, 400, env); }
    if (!b || typeof b.action !== 'string') return json({ error: 'Bad request' }, 400, env);

    if (b.action === 'config') {
      return json({
        ok: true,
        acct: {
          connected: true,
          mode: isLive ? 'live' : 'test',
          last4: key.slice(-4),
          webhook: !!env.PAYMONGO_WEBHOOK_SECRET,
          kv: !!env.PAY_KV,
          selfHosted: true
        }
      }, 200, env);
    }

    if (b.action === 'qr') {
      const amount = Math.floor(Number(b.amount) || 0);
      if (amount < PRICE_MIN || amount > PRICE_MAX) {
        return json({ error: 'Amount must be between ₱' + PRICE_MIN + ' and ₱' + PRICE_MAX + '.' }, 400, env);
      }
      const prints = Math.max(0, Math.min(10, Math.floor(Number(b.prints) || 0)));
      const tier = (b.tier === 'receipt' || b.tier === 'photo') ? b.tier : 'all';
      const now = Date.now();
      const exp = now + QR_SECONDS * 1000;
      try {
        const qr = await createQr(env, {
          amount,
          description: (String(b.label || '').slice(0, 60) || 'Photo booth') + ' · photo session'
        });
        await kvPut(env, 'pi:' + qr.id, { id: qr.id, amount, prints, tier, status: 'awaiting', at: now, exp, live: isLive });
        return json({ ok: true, id: qr.id, image: qr.image, expiresAt: exp, tier, test: !isLive }, 200, env);
      } catch (e) {
        return json({ error: 'PayMongo: ' + e.message }, 502, env);
      }
    }

    if (b.action === 'simulate') {
      if (isLive) return json({ error: 'Simulate only works with a PayMongo sk_test_ key.' }, 403, env);
      const id = String(b.id || '');
      if (!PI_RE.test(id)) return json({ error: 'Bad id' }, 400, env);
      const prev = (await kvGet(env, 'pi:' + id)) || { id, prints: 0, tier: 'all' };
      prev.status = 'paid';
      prev.paidAt = Date.now();
      prev.sim = true;
      await kvPut(env, 'pi:' + id, prev);
      return json({ ok: true, status: 'paid', prints: prev.prints || 0, tier: prev.tier || 'all' }, 200, env);
    }

    if (b.action === 'status') {
      const id = String(b.id || '');
      if (!PI_RE.test(id)) return json({ error: 'Bad id' }, 400, env);
      const prev = await kvGet(env, 'pi:' + id);
      if (prev && prev.status === 'paid') {
        return json({ ok: true, status: 'paid', prints: prev.prints || 0, tier: prev.tier || 'all' }, 200, env);
      }
      // Check PayMongo directly (works both as backup to the webhook and when KV is not bound).
      try {
        const pi = await pm(env, 'GET', '/payment_intents/' + id);
        const a = pi && pi.data && pi.data.attributes;
        if (a && a.status === 'succeeded') {
          if (prev) {
            prev.status = 'paid';
            prev.paidAt = Date.now();
            await kvPut(env, 'pi:' + id, prev);
          }
          return json({ ok: true, status: 'paid', prints: (prev && prev.prints) || 0, tier: (prev && prev.tier) || 'all' }, 200, env);
        }
      } catch { /* keep waiting */ }
      const expired = prev && prev.exp && Date.now() > prev.exp + 15000;
      return json({ ok: true, status: expired ? 'expired' : 'awaiting', prints: (prev && prev.prints) || 0, tier: (prev && prev.tier) || 'all' }, 200, env);
    }

    return json({ error: 'Unknown action.' }, 400, env);
  }
};
