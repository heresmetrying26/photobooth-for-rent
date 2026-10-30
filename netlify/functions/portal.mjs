import {
  safe, json, licenses, verifyToken, normCode, throttle, recordFail, clearFail,
  devicesOf, maxDevicesOf, eventsStore, isDriveUrl, DAY, EVENT_KEEP_DAYS, BONUS_KEEP_DAYS, getSettings,
  normPrint, putLicense, readIndex, sendMail, codeEmail, EMAIL_RE, setDevices,
  swapBlocked, logSwap, swapsLimited, swapsThisMonth, SWAP_LIMIT, SWAP_MSG,
  emailChangeBlocked, logEmailChange, emailChangesThisYear, EMAIL_CHANGE_LIMIT, EMAIL_MSG
} from '../lib/core.mjs';

// Backs the /lifetime customer page: sign in with the rental code (or, on a
// booth device, the booth's own saved token) and get every event folder this
// code has used, with links and roughly when Drive cleanup removes them.
// Opening this page never uses up a device slot.
// One email per lifetime code: an address can belong to only one lifetime booking.
async function emailTaken(email, ownKey) {
  return Object.values((await readIndex()).rows).some((r) => r.lifetime && r.kind !== 'bonus' && r.key !== ownKey && String(r.email || '').toLowerCase() === email);
}

export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const store = licenses();
  let rec = null;

  // "Forgot your code?": emails the codes registered to that address. The answer
  // is the same whether or not the address is known, so it can't be used to find accounts.
  if (b.action === 'recover') {
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ error: 'Please type a valid email address.' }, 400);
    const t = await throttle('recover', context.ip, 5, 60 * 60000);
    if (t.blocked) return json({ error: 'Too many requests. Please try again in an hour, or message us.' }, 429);
    await recordFail(t);                      // counts requests, not just misses
    const te = await throttle('recover-mail', email, 3, 60 * 60000);
    if (!te.blocked) {
      const rows = Object.values((await readIndex()).rows).filter((r) => r.kind !== 'bonus' && r.status !== 'revoked' && String(r.email || '').toLowerCase() === email);
      if (rows.length) {
        await recordFail(te);
        try { await sendMail(Object.assign({ to: email }, codeEmail(rows.slice(0, 10), process.env.URL || new URL(req.url).origin))); }
        catch (e) { console.error('recover mail', e.message); }
      }
    }
    return json({ ok: true, message: 'If that email is registered, your code is on its way. Check your inbox (and spam) in a few minutes.' });
  }

  if (b.code) {
    const t = await throttle('portal', context.ip, 10);
    if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
    const key = normCode(b.code);
    rec = key ? await store.get(key, { type: 'json' }) : null;
    if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
    await clearFail(t);
  } else if (b.token) {
    const p = verifyToken(b.token);
    if (!p || p.t !== 'rental') return json({ error: 'signin' }, 401);
    rec = await store.get(p.k, { type: 'json' });
    if (!rec || !devicesOf(rec).some((d) => d.id === p.d) || p.d !== String(b.deviceId || '')) return json({ error: 'signin' }, 401);
  } else {
    return json({ error: 'signin' }, 401);
  }

  const meDevice = b.token ? String(b.deviceId || '') : '';
  // A bonus code shows the booking it belongs to.
  if (rec.kind === 'bonus' && rec.parent) rec = (await store.get(rec.parent, { type: 'json' })) || rec;
  if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact the owner.' }, 403);

  const now = Date.now();

  // Name + email on My Events. The Drive folder name is frozen first, so a new
  // name never moves the photos to a new folder.
  if (b.action === 'account.save') {
    const name = String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 60);
    const email = String(b.email || '').trim().toLowerCase();
    if (!name) return json({ error: 'Please type a name.', field: 'name' }, 400);
    if (email && !EMAIL_RE.test(email)) return json({ error: 'That email address doesn’t look right.', field: 'email' }, 400);
    if (email && rec.lifetime && await emailTaken(email, rec.key)) return json({ error: 'That email is already used by another lifetime code. Please use a different email, or message us.', field: 'email' }, 409);
    if (!rec.folderName) rec.folderName = rec.label || rec.code;
    const emailChanged = (rec.email || '') !== email;
    if (emailChanged && emailChangeBlocked(rec, now)) return json({ error: EMAIL_MSG, field: 'email', code: 'email-limit' }, 429);
    rec.label = name;
    if (emailChanged) logEmailChange(rec, email, now, 'renter');
    rec.email = email || null;
    await putLicense(store, rec.key, rec);
    return json({ ok: true, label: rec.label, email: rec.email || '' });
  }

  // Remove one device (by its number) so its slot is free for a new one. That
  // booth locks at its next check (within ~5 minutes).
  if (b.action === 'device.remove') {
    const no = Math.floor(Number(b.no) || 0);
    const list = devicesOf(rec);
    if (!list.some((d) => d.no === no)) return json({ error: 'That device isn’t on your code any more.' }, 404);
    if (swapBlocked(rec, now)) return json({ error: SWAP_MSG, code: 'swap-limit' }, 429);
    setDevices(rec, list.filter((d) => d.no !== no));
    logSwap(rec, now);
    await putLicense(store, rec.key, rec);
    return json({ ok: true });
  }

  // Lifetime codes manage their own paper sizes and print limits (once Admin
  // has switched printing on for them). Booths pick it up within ~5 minutes.
  if (b.action === 'print.save') {
    if (!rec.lifetime) return json({ error: 'Only lifetime codes can change their print settings here. Please message us.' }, 403);
    if (!(rec.print && rec.print.enabled)) return json({ error: 'Printing isn’t part of your package yet. Please message us to add it.' }, 403);
    const next = normPrint(true, b.sizes, { eventLimit: b.eventLimit, sessionLimit: b.sessionLimit });
    if (!next.enabled) return json({ error: 'Pick at least one paper size.' }, 400);
    rec.print = next;
    await putLicense(store, rec.key, rec);
    if (rec.bonusKey) {
      const bonus = await store.get(rec.bonusKey, { type: 'json' });
      if (bonus) await putLicense(store, rec.bonusKey, { ...bonus, print: next });
    }
    return json({ ok: true, print: next });
  }

  const doc = (await eventsStore().get(rec.key, { type: 'json' })) || { events: [] };
  const events = doc.events
    .filter((e) => isDriveUrl(e.folderUrl))
    .map((e) => {
      const from = e.bonus ? e.firstAt : (e.lastAt || e.firstAt);
      const deleteAfter = from + (e.bonus ? BONUS_KEEP_DAYS : EVENT_KEEP_DAYS) * DAY;
      return { name: e.name, folderUrl: e.folderUrl, bonus: !!e.bonus, firstAt: e.firstAt, lastAt: e.lastAt, sessions: e.sessions || 0, deleteAfter, deleted: !!e.deletedAt || deleteAfter <= now };
    })
    .sort((a, b) => (b.lastAt || b.firstAt) - (a.lastAt || a.firstAt));

  const expired = rec.status === 'active' && !rec.lifetime && rec.expiresAt <= now;
  return json({
    ok: true,
    code: rec.code,
    label: rec.label || rec.code,
    lifetime: !!rec.lifetime,
    status: expired ? 'expired' : rec.status,
    expiresAt: rec.lifetime ? null : rec.expiresAt,
    startsAt: rec.startsAt || null,
    traditional: !!rec.traditional,
    offlineOpt: !!rec.offlineOpt,
    offlineOnly: !!rec.offlineOnly,
    print: rec.print && rec.print.enabled ? normPrint(true, rec.print.sizes, rec.print) : { enabled: false, sizes: [] },
    folderPrefix: rec.lifetime ? (rec.folderName || rec.label || rec.code) : null,
    devices: { used: devicesOf(rec).length, max: maxDevicesOf(rec),
      swaps: swapsLimited(rec) ? { used: swapsThisMonth(rec, now), limit: SWAP_LIMIT } : null,
      list: devicesOf(rec).map((d) => ({ no: d.no || 1, kind: d.kind || null, at: d.at || null, seen: d.seen || null, me: !!(meDevice && d.id === meDevice) })) },
    email: rec.email || '',
    emailChanges: swapsLimited(rec) ? { used: emailChangesThisYear(rec, now), limit: EMAIL_CHANGE_LIMIT } : null,
    keepDays: EVENT_KEEP_DAYS,
    qrTarget: (await getSettings()).qrTarget === 'drive' ? 'drive' : 'gallery',
    events,
    now
  });
});

export const config = { path: '/api/portal' };
