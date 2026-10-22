import { payStore, getAcct, unseal, signatureOk, payKey } from '../lib/pay.mjs';

// PayMongo → us: "payment.paid" for a renter's QR Ph payment. The URL carries
// the booking's short id (?o=…); the signature is checked with that renter's
// webhook secret (kept encrypted), so nobody else can mark a payment as paid.
export default async (req) => {
  if (req.method !== 'POST') return new Response('ok');
  const oid = new URL(req.url).searchParams.get('o') || '';
  const raw = await req.text();
  try {
    if (!/^[0-9a-f]{24}$/.test(oid)) return new Response('ok');
    const acct = await getAcct(oid);
    if (!acct || !acct.whEnc) return new Response('ok');
    const ev = JSON.parse(raw);
    const attrs = ev && ev.data && ev.data.attributes;
    const live = !!(attrs && attrs.livemode);
    if (!signatureOk(req.headers.get('paymongo-signature'), raw, unseal(acct.whEnc, oid), live)) return new Response('bad signature', { status: 401 });
    if (attrs && attrs.type === 'payment.paid') {
      const pay = attrs.data || {};
      const pa = pay.attributes || {};
      const piId = pa.payment_intent_id;
      if (piId) {
        const st = payStore(), k = payKey(oid, piId);
        const r = await st.get(k, { type: 'json' });
        if (r && r.status !== 'paid' && Math.round(r.amount * 100) === Number(pa.amount)) {
          r.status = 'paid'; r.paidAt = Date.now(); r.payId = pay.id || null; r.hook = true;
          await st.setJSON(k, r);
        }
      }
    }
  } catch (e) { console.error('pay hook', e.message); }
  return new Response('ok');
};

export const config = { path: '/api/pay/hook' };
