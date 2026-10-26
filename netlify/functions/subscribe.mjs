import {
  safe, json, licenses, newCode, displayCode, normCode, DAY, putLicense, sendMail, codeEmail, EMAIL_RE, getSettings
} from '../lib/core.mjs';
import { payStore, pm } from '../lib/pay.mjs';

const PLANS = {
  online: {
    id: 'online',
    title: 'Monthly Online',
    price: 799,
    description: 'iPad, tablet or laptop browser · online · unlimited events',
    offlineOpt: false,
    offlineOnly: false
  },
  offline: {
    id: 'offline',
    title: 'Monthly Offline (Laptop app only)',
    price: 999,
    description: 'Windows / Mac offline desktop app · zero internet needed',
    offlineOpt: true,
    offlineOnly: true
  },
  both: {
    id: 'both',
    title: 'Monthly Online + Offline',
    price: 1299,
    description: 'Both: online booth & offline desktop app',
    offlineOpt: true,
    offlineOnly: false
  }
};

const memOrders = new Map();
function getPayStore() {
  let real = null;
  try { real = payStore(); } catch {}
  return {
    get: async (k, opts) => {
      try { if (real) return await real.get(k, opts); } catch {}
      return memOrders.get(k) || null;
    },
    setJSON: async (k, v) => {
      try { if (real) return await real.setJSON(k, v); } catch {}
      return memOrders.set(k, v);
    }
  };
}

const memLicenses = new Map();
function getLicensesStore() {
  let real = null;
  try { real = licenses(); } catch {}
  return {
    get: async (k, opts) => {
      try { if (real) return await real.get(k, opts); } catch {}
      return memLicenses.get(k) || null;
    },
    setJSON: async (k, v) => {
      try { if (real) return await real.setJSON(k, v); } catch {}
      return memLicenses.set(k, v);
    }
  };
}

async function freshKey(store) {
  let key;
  do { key = newCode(); } while (await store.get(key));
  return key;
}



// Fulfill the subscription: activates or extends license in Netlify Blobs Admin
async function fulfillOrder(order, origin) {
  const store = getLicensesStore();
  const now = Date.now();
  let code = null;
  let renewed = false;

  if (order.renewCode) {
    const key = normCode(order.renewCode);
    const existing = key ? await store.get(key, { type: 'json' }) : null;
    if (existing && !existing.lifetime && existing.kind !== 'bonus') {
      existing.expiresAt = Math.max(existing.expiresAt || 0, now) + 30 * DAY;
      existing.status = 'active';
      if (order.plan === 'offline' || order.plan === 'both') existing.offlineOpt = true;
      if (order.plan === 'offline') existing.offlineOnly = true;
      if (order.plan === 'both') existing.offlineOnly = false;
      try {
        await putLicense(store, existing.key, existing);
      } catch {
        await store.setJSON(existing.key, existing);
      }
      code = existing.code;
      renewed = true;
    }
  }

  if (!code) {
    const key = await freshKey(store);
    const cleanLabel = (order.name || '').trim().slice(0, 80);
    const planCfg = PLANS[order.plan] || PLANS.online;
    const rec = {
      key,
      code: displayCode(key),
      kind: 'rental',
      label: cleanLabel ? `${cleanLabel} · ${planCfg.title}` : `Monthly · ${displayCode(key)}`,
      folderName: cleanLabel ? `${cleanLabel} · ${displayCode(key)}` : displayCode(key),
      days: 30,
      lifetime: false,
      maxDevices: 1,
      defaultTheme: null,
      startsAt: null, // Starts counting upon first unlock on device
      print: { enabled: true, sizes: ['2x6', '4x6'], eventLimit: 0, sessionLimit: 0 },
      traditional: true,
      offlineOpt: planCfg.offlineOpt,
      offlineOnly: planCfg.offlineOnly,
      status: 'unused',
      createdAt: now,
      redeemedAt: null,
      expiresAt: null,
      deviceId: null,
      email: order.email || null
    };
    try {
      await putLicense(store, key, rec);
    } catch {
      await store.setJSON(key, rec);
    }
    code = rec.code;
    renewed = false;

    // Send code by email if email relay is active
    if (order.email) {
      try {
        const mail = codeEmail([rec], origin);
        await sendMail({ to: order.email, ...mail });
      } catch (err) {
        console.warn('Subscription email notice error (non-fatal):', err.message);
      }
    }
  }

  order.status = 'paid';
  order.paidAt = now;
  order.code = code;
  order.renewed = renewed;
  await getPayStore().setJSON('sub/' + order.id, order);

  return { code, renewed };
}

export default safe(async (req, context) => {
  const url = new URL(req.url);
  const origin = process.env.URL || url.origin;

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.action !== 'string') return json({ error: 'Bad request' }, 400);

  let rawSettings = {};
  try { rawSettings = await getSettings(); } catch {}
  const pmKey = rawSettings.paymongoSecretKey || process.env.PAYMONGO_SECRET_KEY || '';
  const isLive = pmKey.startsWith('sk_live_');
  const isTest = !isLive;

  // 1. Get available plans
  if (b.action === 'plans') {
    return json({ ok: true, plans: Object.values(PLANS), isTest });
  }

  // 2. Create QR Ph Payment Intent
  if (b.action === 'create') {
    const planKey = String(b.plan || '').toLowerCase();
    const plan = PLANS[planKey];
    if (!plan) return json({ error: 'Please choose a valid plan.' }, 400);

    const name = String(b.name || '').trim().slice(0, 80);
    const email = String(b.email || '').trim().toLowerCase();
    if (!name) return json({ error: 'Please enter your name.' }, 400);
    if (!email || !EMAIL_RE.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);

    const renewCode = b.renewCode ? normCode(b.renewCode) : null;
    if (renewCode) {
      const rec = await getLicensesStore().get(renewCode, { type: 'json' });
      if (!rec) return json({ error: 'That code to renew was not found. Please check and try again.' }, 404);
      if (rec.lifetime) return json({ error: 'That is a Lifetime code — it never expires and does not need renewal!' }, 400);
    }

    if (!pmKey) {
      return json({ error: 'Online payment is currently being updated. Please message us on Messenger to book directly!' }, 503);
    }

    let paymentId;
    let qrImage = null;

    try {
      const pi = await pm(pmKey, 'POST', '/payment_intents', {
        data: {
          attributes: {
            amount: Math.round(plan.price * 100),
            currency: 'PHP',
            payment_method_allowed: ['qrph'],
            capture_type: 'automatic',
            description: `photobooth4u - ${plan.title}`,
            statement_descriptor: 'photobooth4u',
            metadata: {
              plan: plan.id,
              name,
              email,
              renewCode: renewCode || ''
            }
          }
        }
      });

      paymentId = pi.data.id;
      const pmMethod = await pm(pmKey, 'POST', '/payment_methods', {
        data: {
          attributes: {
            type: 'qrph',
            expiry_seconds: 600,
            billing: { name, email }
          }
        }
      });

      const attached = await pm(pmKey, 'POST', `/payment_intents/${paymentId}/attach`, {
        data: {
          attributes: {
            payment_method: pmMethod.data.id,
            client_key: pi.data.attributes.client_key
          }
        }
      });

      const nextActionCode = attached?.data?.attributes?.next_action?.code;
      const img = nextActionCode?.image_url || nextActionCode?.image;
      if (img) {
        qrImage = /^data:image\//.test(img) ? img : 'data:image/png;base64,' + img;
      }
    } catch (err) {
      console.warn('PayMongo API call error:', err.message);
      return json({ error: 'Payment gateway error: ' + (err.message || 'Unable to generate QR Ph code') }, 502);
    }

    if (!qrImage) {
      return json({ error: 'Unable to load QR Ph code from PayMongo. Please try again or message us.' }, 502);
    }

    const order = {
      id: paymentId,
      plan: plan.id,
      amount: plan.price,
      name,
      email,
      renewCode,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      isTest
    };

    await getPayStore().setJSON('sub/' + paymentId, order);

    return json({
      ok: true,
      id: paymentId,
      amount: plan.price,
      planTitle: plan.title,
      qrImage,
      isTest,
      expiresAt: order.expiresAt
    });
  }

  // 3. Status check (polled by the modal)
  if (b.action === 'status') {
    const id = String(b.id || '').trim();
    if (!id) return json({ error: 'Missing payment id.' }, 400);

    const store = getPayStore();
    const order = await store.get('sub/' + id, { type: 'json' });
    if (!order) return json({ error: 'Order not found or expired.' }, 404);

    if (order.status === 'paid') {
      return json({
        ok: true,
        status: 'paid',
        code: order.code,
        renewed: !!order.renewed,
        plan: order.plan,
        guideUrl: '/lifetime/photobooth4u-setup-guide.pdf',
        tabletGuideUrl: '/lifetime/photobooth4u-tablet-guide.pdf',
        offlineGuideUrl: '/lifetime/photobooth4u-offline-app-guide.pdf',
        messengerUrl: 'https://m.me/roktetnachi'
      });
    }

    // Check with PayMongo if live/test secret key is set
    if (pmKey && !order.id.startsWith('test_pi_')) {
      try {
        const check = await pm(pmKey, 'GET', `/payment_intents/${order.id}`);
        const st = check?.data?.attributes?.status;
        if (st === 'succeeded') {
          const res = await fulfillOrder(order, origin);
          return json({
            ok: true,
            status: 'paid',
            code: res.code,
            renewed: res.renewed,
            plan: order.plan,
            guideUrl: '/lifetime/photobooth4u-setup-guide.pdf',
            tabletGuideUrl: '/lifetime/photobooth4u-tablet-guide.pdf',
            offlineGuideUrl: '/lifetime/photobooth4u-offline-app-guide.pdf',
            messengerUrl: 'https://m.me/roktetnachi'
          });
        }
      } catch (e) {
        /* non-fatal check error */
      }
    }

    return json({ ok: true, status: order.status || 'pending', isTest: order.isTest });
  }



  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/subscribe' };
