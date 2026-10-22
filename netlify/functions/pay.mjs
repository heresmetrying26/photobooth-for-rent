import {
  safe, json, licenses, verifyToken, normCode, throttle, recordFail, clearFail, checkLicense, devicesOf, cleanEventName
} from '../lib/core.mjs';
import {
  payStore, ownerId, eventKeyOf, vaultReady, seal, unseal, PIN_RE, pinRecord, pinOk, KEY_RE, pm, acctKey, getAcct, acctPublic,
  hookUrl, setupWebhook, QR_SECONDS, PRICE_MIN, PRICE_MAX, payKey, createQr, VOUCHER_RE, batchKey, voucherHash,
  listJSON, usedMap, batchView, createBatch, redeemVoucher, usedKey
} from '../lib/pay.mjs';

// Guest payments (an add-on Admin switches on per code: "payOpt").
//
// Booth (license token + deviceId + event):
//   config                      -> { payOpt, acct (connected, test/live, …last4 — never the key), vault }
//   redeem   { code }           -> { ok, prints } | { error: bad|used|void|other-event }
//   offline                     -> hashes of this event's unused vouchers (checked on the tablet when offline)
//   sync     { used:[{code,at}] } vouchers used while offline
//   batches / batch.create { count, prints, price, label } / batch.void { id }
//   qr       { amount, prints, label } -> { id, image, expiresAt, test }   (QR Ph from the renter's PayMongo)
//   status   { id }             -> { status: awaiting|paid|expired }
//   simulate { id }             test keys only: pretend the guest paid
// My Events (code, or the booth's token on that device):
//   my.status / my.connect { key, pin, newPin } / my.disconnect { pin } / my.payments / my.batches
export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.action !== 'string') return json({ error: 'Bad request' }, 400);
  const store = payStore();
  const now = Date.now();
  const ip = context.ip || 'unknown';

  // ---------------- My Events (renter) ----------------
  if (b.action.startsWith('my.')) {
    const L = licenses();
    let rec = null;
    if (b.code) {
      const t = await throttle('portal', ip, 10);
      if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
      const key = normCode(b.code);
      rec = key ? await L.get(key, { type: 'json' }) : null;
      if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
      await clearFail(t);
    } else if (b.token) {
      const p = verifyToken(b.token);
      if (!p || p.t !== 'rental') return json({ error: 'signin' }, 401);
      rec = await L.get(p.k, { type: 'json' });
      if (!rec || !devicesOf(rec).some((d) => d.id === p.d) || p.d !== String(b.deviceId || '')) return json({ error: 'signin' }, 401);
    } else return json({ error: 'signin' }, 401);
    if (rec.kind === 'bonus' && rec.parent) rec = (await L.get(rec.parent, { type: 'json' })) || rec;
    if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact the owner.' }, 403);
    const oid = ownerId(rec.key);
    const acct = await getAcct(oid);

    if (b.action === 'my.status') return json({ ok: true, payOpt: !!rec.payOpt, lifetime: !!rec.lifetime, vault: vaultReady(), acct: acctPublic(acct) });
    if (!rec.payOpt) return json({ error: 'Guest payments aren’t switched on for this code. Please contact photobooth4u.' }, 403);

    if (b.action === 'my.connect') {
      if (!vaultReady()) return json({ error: 'Payments aren’t set up on the server yet (PB_VAULT_KEY). Please contact photobooth4u.' }, 503);
      const t = await throttle('paypin', ip + '|' + oid, 6);
      if (t.blocked) return json({ error: 'Too many wrong PINs. Please wait 15 minutes.' }, 429);
      let pinRec;
      if (acct && acct.pinHash) {
        if (!pinOk(acct, b.pin)) { await recordFail(t); return json({ error: 'Wrong payments PIN.', field: 'pin' }, 401); }
        pinRec = { pinSalt: acct.pinSalt, pinHash: acct.pinHash };
      } else {
        if (!PIN_RE.test(String(b.newPin || ''))) return json({ error: 'Choose a payments PIN of 4 to 8 digits.', field: 'newPin' }, 400);
        pinRec = pinRecord(b.newPin);
      }
      await clearFail(t);
      const key = String(b.key || '').trim();
      if (!KEY_RE.test(key)) return json({ error: 'That doesn’t look like a PayMongo secret key. It starts with sk_live_ or sk_test_.', field: 'key' }, 400);
      try { await pm(key, 'GET', '/webhooks'); }
      catch (e) { return json({ error: e.status === 401 ? 'PayMongo didn’t accept that key. Copy the Secret key again from PayMongo → Developers → API keys.' : 'Couldn’t reach PayMongo: ' + e.message, field: 'key' }, 400); }
      if (acct && acct.whId && acct.enc) { try { await pm(unseal(acct.enc, oid), 'POST', '/webhooks/' + acct.whId + '/disable'); } catch (e) {} }
      const base = process.env.URL || new URL(req.url).origin;
      const hook = await setupWebhook(key, hookUrl(base, oid));
      const next = Object.assign({}, pinRec, {
        enc: seal(key, oid), mode: key.startsWith('sk_live_') ? 'live' : 'test', last4: key.slice(-4),
        whId: hook ? hook.id : null, whEnc: hook ? seal(hook.secret, oid) : null, connectedAt: now, booking: rec.key
      });
      await store.setJSON(acctKey(oid), next);
      return json({ ok: true, acct: acctPublic(next) });
    }

    if (b.action === 'my.disconnect') {
      if (!acct || !acct.enc) return json({ ok: true, acct: acctPublic(acct) });
      const t = await throttle('paypin', ip + '|' + oid, 6);
      if (t.blocked) return json({ error: 'Too many wrong PINs. Please wait 15 minutes.' }, 429);
      if (!pinOk(acct, b.pin)) { await recordFail(t); return json({ error: 'Wrong payments PIN.', field: 'pin' }, 401); }
      await clearFail(t);
      if (acct.whId) { try { await pm(unseal(acct.enc, oid), 'POST', '/webhooks/' + acct.whId + '/disable'); } catch (e) {} }
      const next = { pinSalt: acct.pinSalt, pinHash: acct.pinHash, booking: rec.key };   // keep the PIN for next time
      await store.setJSON(acctKey(oid), next);
      return json({ ok: true, acct: acctPublic(next) });
    }

    if (b.action === 'my.payments') {
      const all = (await listJSON('pp/' + oid + '/', 1000)).filter((x) => x.status === 'paid').sort((x, y) => (y.paidAt || y.at) - (x.paidAt || x.at));
      const byEvent = {};
      all.forEach((x) => { const k = x.evName || '—'; byEvent[k] = byEvent[k] || { name: k, count: 0, total: 0 }; byEvent[k].count++; byEvent[k].total += x.amount; });
      return json({ ok: true, payments: all.slice(0, 300).map((x) => ({ at: x.paidAt || x.at, amount: x.amount, ev: x.evName || '', ref: x.payId || x.id, live: !!x.live, sim: !!x.sim })),
        events: Object.values(byEvent), total: all.reduce((s, x) => s + x.amount, 0) });
    }

    if (b.action === 'my.batches') {
      const used = await usedMap(oid);
      const list = (await listJSON('vb/' + oid + '/', 200)).sort((x, y) => y.at - x.at).map((bt) => batchView(bt, used));
      return json({ ok: true, batches: list });
    }
    return json({ error: 'Unknown action.' }, 400);
  }

  // ---------------- booth ----------------
  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
  if (lic.type !== 'rental') return json({ error: 'Guest payments work with rental codes, not trials.' }, 403);
  const p = verifyToken(b.token);
  const L = licenses();
  let rec = await L.get(p.k, { type: 'json' });
  if (rec && rec.kind === 'bonus' && rec.parent) rec = (await L.get(rec.parent, { type: 'json' })) || rec;
  if (!rec) return json({ error: 'locked' }, 401);
  const oid = ownerId(rec.key);
  const ev = eventKeyOf(!!rec.lifetime, b.event);
  const evName = rec.lifetime ? cleanEventName(b.event || '') : (rec.folderName || rec.label || '');
  const dev = lic.deviceNo || 1;

  if (b.action === 'config') {
    return json({ ok: true, payOpt: !!rec.payOpt, vault: vaultReady(), acct: acctPublic(rec.payOpt ? await getAcct(oid) : null) });
  }
  if (!rec.payOpt) return json({ error: 'Guest payments aren’t switched on for this code.', off: true }, 403);

  if (b.action === 'redeem') {
    const t = await throttle('voucher', ip + '|' + oid + '|' + dev, 40);   // wrong codes only
    if (t.blocked) return json({ error: 'wait' }, 429);
    const code = String(b.code || '').replace(/\D/g, '');
    const r = await redeemVoucher(oid, ev, code, dev);
    if (r.error) { if (r.error === 'bad') await recordFail(t); return json(r, 200); }
    return json(r);
  }
  if (b.action === 'offline') {
    const used = await usedMap(oid);
    const list = (await listJSON('vb/' + oid + '/', 1000)).filter((bt) => bt.ev === ev);
    const out = [];
    list.forEach((bt) => { const voided = new Set(bt.voided || []); bt.codes.forEach((c) => { if (!used[c] && !voided.has(c)) out.push([voucherHash(oid, c), bt.prints || 0]); }); });
    return json({ ok: true, oid, ev, at: now, list: out });
  }
  if (b.action === 'sync') {
    const items = Array.isArray(b.used) ? b.used.slice(0, 200) : [];
    const res = [];
    for (const it of items) {
      const code = String((it && it.code) || '').replace(/\D/g, '');
      const at = Math.min(now, Math.max(now - 30 * 86400000, Number(it && it.at) || now));
      const r = await redeemVoucher(oid, ev, code, dev, at);
      res.push({ code, ok: !!r.ok, error: r.error || null });
    }
    return json({ ok: true, results: res });
  }
  if (b.action === 'batches') {
    const used = await usedMap(oid);
    const list = (await listJSON('vb/' + oid + '/', 200)).filter((bt) => bt.ev === ev).sort((x, y) => y.at - x.at).map((bt) => batchView(bt, used));
    return json({ ok: true, batches: list });
  }
  if (b.action === 'batch.create') {
    const t = await throttle('vbatch', ip + '|' + oid, 30);
    if (t.blocked) return json({ error: 'Too many batches. Please wait a few minutes.' }, 429);
    await recordFail(t);   // counts batches made
    const bt = await createBatch(oid, { ev, evName, count: b.count, prints: b.prints, price: b.price, label: b.label, by: 'renter' });
    return json({ ok: true, batch: batchView(bt, {}) });
  }
  if (b.action === 'batch.void') {
    const bt = await store.get(batchKey(oid, String(b.id || '')), { type: 'json' });
    if (!bt || bt.ev !== ev) return json({ error: 'Batch not found.' }, 404);
    const used = await usedMap(oid);
    bt.voided = bt.codes.filter((c) => !used[c]);
    await store.setJSON(batchKey(oid, bt.id), bt);
    return json({ ok: true, batch: batchView(bt, used) });
  }

  if (b.action === 'qr') {
    const acct = await getAcct(oid);
    if (!acct || !acct.enc) return json({ error: 'PayMongo isn’t connected. Connect it on the My Events page.', notConnected: true }, 409);
    if (!vaultReady()) return json({ error: 'Payments aren’t set up on the server yet.' }, 503);
    const amount = Math.floor(Number(b.amount) || 0);
    if (amount < PRICE_MIN || amount > PRICE_MAX) return json({ error: 'Set a price between ₱' + PRICE_MIN + ' and ₱' + PRICE_MAX + ' in Setup.' }, 400);
    const t = await throttle('payqr', ip + '|' + oid, 200);
    if (t.blocked) return json({ error: 'Too many payment codes in a short time. Please wait a few minutes.' }, 429);
    await recordFail(t);
    let qr;
    try {
      qr = await createQr(unseal(acct.enc, oid), { amount, description: (String(b.label || '').slice(0, 60) || evName || 'Photo booth') + ' · photo session',
        metadata: { booth: 'photobooth4u', event: String(evName || '').slice(0, 60), device: String(dev) } });
    } catch (e) {
      return json({ error: e.status === 401 ? 'PayMongo rejected the saved key. Reconnect PayMongo on My Events.' : 'PayMongo: ' + e.message }, 502);
    }
    const prints = Math.max(0, Math.min(10, Math.floor(Number(b.prints) || 0)));
    const exp = now + QR_SECONDS * 1000;
    await store.setJSON(payKey(oid, qr.id), { id: qr.id, oid, ev, evName, amount, prints, status: 'awaiting', at: now, exp, dev, live: acct.mode === 'live', checked: now });
    return json({ ok: true, id: qr.id, image: qr.image, expiresAt: exp, test: acct.mode !== 'live' });
  }
  if (b.action === 'status' || b.action === 'simulate') {
    const id = String(b.id || '');
    if (!/^pi_[A-Za-z0-9]{6,60}$/.test(id)) return json({ error: 'Bad id' }, 400);
    const k = payKey(oid, id);
    const r = await store.get(k, { type: 'json' });
    if (!r) return json({ error: 'Not found' }, 404);
    if (b.action === 'simulate') {
      const acct = await getAcct(oid);
      if (!acct || acct.mode !== 'test') return json({ error: 'Simulate only works with a PayMongo test key.' }, 403);
      if (r.status !== 'paid') { r.status = 'paid'; r.paidAt = now; r.sim = true; await store.setJSON(k, r); }
      return json({ ok: true, status: 'paid', prints: r.prints || 0 });
    }
    if (r.status === 'awaiting' && now - (r.checked || 0) > 4000) {
      // Backup to the webhook: ask PayMongo directly (at most every 4 s per QR).
      r.checked = now;
      try {
        const acct = await getAcct(oid);
        const pi = acct && acct.enc ? await pm(unseal(acct.enc, oid), 'GET', '/payment_intents/' + id) : null;
        const a = pi && pi.data && pi.data.attributes;
        if (a && a.status === 'succeeded') { r.status = 'paid'; r.paidAt = now; r.payId = (a.payments && a.payments[0] && a.payments[0].id) || null; }
      } catch (e) { /* keep waiting */ }
      await store.setJSON(k, r);
    }
    const status = r.status === 'paid' ? 'paid' : (now > r.exp + 15000 ? 'expired' : 'awaiting');
    return json({ ok: true, status, prints: r.prints || 0 });
  }
  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/pay' };
