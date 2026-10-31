import { payStore, pm, signatureOk } from '../lib/pay.mjs';
import { licenses, meta, getSettings, putLicense, normCode, notifyOwner, SUBHOOK_EVENTS } from '../lib/core.mjs';

// PayMongo → us, for payments made to PHOTOBOOTH4U itself (Lifetime, monthly and event plans): a refund or a
// failed payment on an order that was already paid. It never disables a code. It FLAGS the code for review
// (Admin shows "Payment reversed", and you get an email at ALERT_EMAIL) so you decide.
// Set up with Admin → PayMongo → "Set up payment alerts" (it creates the webhook and keeps its secret), or set
// PAYMONGO_WEBHOOK_SECRET by hand. The renters' own guest-payment webhook is /api/pay/hook, a different thing.
export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const raw = await req.text();
  try {
    const hook = (await meta().get('subhook', { type: 'json' })) || {};
    const secret = hook.secret || process.env.PAYMONGO_WEBHOOK_SECRET || '';
    if (!secret) return new Response('payment alerts are not set up', { status: 200 });
    const ev = JSON.parse(raw);
    const attrs = ev && ev.data && ev.data.attributes;
    const live = !!(attrs && attrs.livemode);
    if (!signatureOk(req.headers.get('paymongo-signature'), raw, secret, live)) return new Response('bad signature', { status: 401 });
    const type = attrs && attrs.type;
    if (!SUBHOOK_EVENTS.includes(type)) return new Response('ok');

    const res = attrs.data || {};
    const pa = res.attributes || {};
    // A refund that did not go through is not a reversal.
    if (type === 'payment.refund.updated' && String(pa.status || '').toLowerCase() === 'failed') return new Response('ok');

    // Find which of our orders this is about (payment_intent_id; a refund event only carries the payment id).
    let piId = pa.payment_intent_id || null;
    const payId = type === 'payment.refund.updated' ? pa.payment_id : res.id;
    if (!piId && payId) {
      const key = (await getSettings().catch(() => ({}))).paymongoSecretKey || process.env.PAYMONGO_SECRET_KEY || '';
      if (key) { try { piId = (((await pm(key, 'GET', '/payments/' + payId)).data || {}).attributes || {}).payment_intent_id || null; } catch (e) { console.error('subhook lookup', e.message); } }
    }
    if (!piId) return new Response('ok');
    const order = await payStore().get('sub/' + piId, { type: 'json' });
    if (!order || order.status !== 'paid' || !order.code) return new Response('ok');   // not ours, or never fulfilled

    const store = licenses();
    const key = normCode(order.code);
    const rec = key ? await store.get(key, { type: 'json' }) : null;
    if (!rec) return new Response('ok');
    const evId = ev.data.id || '';
    if (rec.paymentReview && rec.paymentReview.eventId === evId) return new Response('ok');   // a repeated delivery

    const reason = type === 'payment.failed' ? 'failed' : 'refunded';
    const now = Date.now();
    rec.paymentReview = { reason, eventType: type, eventId: evId, at: now, paymentId: payId || null, orderId: piId, plan: order.plan || null, amount: order.amount || null };
    await putLicense(store, key, rec);
    await notifyOwner('Payment ' + (reason === 'refunded' ? 'REFUNDED' : 'FAILED') + ' on code ' + rec.code + ' (' + (rec.label || order.name || 'renter') + ')',
      ['A payment to photobooth4u was ' + (reason === 'refunded' ? 'refunded or reversed' : 'reported as failed') + ' after the code was issued.', '',
        'Renter: ' + (rec.label || order.name || '(no name)'), 'Code: ' + rec.code, 'Plan: ' + (order.plan || '?') + ' · ₱' + (order.amount || '?'),
        'Order: ' + piId, 'Event: ' + type, '',
        'Nothing was disabled. Open Admin and look at this code: use Disable (reason: payment) if the money was not kept, or "Clear payment flag" if it is fine.'].join('\n'));
  } catch (e) { console.error('subscription hook', e.message); }
  return new Response('ok');
};

export const config = { path: '/api/subscribe/hook' };
