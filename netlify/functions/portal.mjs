import {
  safe, json, licenses, verifyToken, normCode, throttle, recordFail, clearFail,
  devicesOf, maxDevicesOf, eventsStore, isDriveUrl, DAY, EVENT_KEEP_DAYS, BONUS_KEEP_DAYS, getSettings,
  normPrint, putLicense
} from '../lib/core.mjs';

// Backs the /lifetime customer page: sign in with the rental code (or, on a
// booth device, the booth's own saved token) and get every event folder this
// code has used, with links and roughly when Drive cleanup removes them.
// Opening this page never uses up a device slot.
export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const store = licenses();
  let rec = null;

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

  // A bonus code shows the booking it belongs to.
  if (rec.kind === 'bonus' && rec.parent) rec = (await store.get(rec.parent, { type: 'json' })) || rec;
  if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact the owner.' }, 403);

  const now = Date.now();

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
      return { name: e.name, folderUrl: e.folderUrl, bonus: !!e.bonus, firstAt: e.firstAt, lastAt: e.lastAt, sessions: e.sessions || 0, deleteAfter, deleted: deleteAfter <= now };
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
    print: rec.print && rec.print.enabled ? normPrint(true, rec.print.sizes, rec.print) : { enabled: false, sizes: [] },
    folderPrefix: rec.lifetime ? (rec.folderName || rec.label || rec.code) : null,
    devices: { used: devicesOf(rec).length, max: maxDevicesOf(rec) },
    keepDays: EVENT_KEEP_DAYS,
    qrTarget: (await getSettings()).qrTarget === 'drive' ? 'drive' : 'gallery',
    events,
    now
  });
});

export const config = { path: '/api/portal' };
