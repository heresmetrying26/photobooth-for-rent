import { safe, json, licenses, getSettings, sign, normCode, throttle, recordFail, clearFail, shortId, DAY, MIN, fmtWhen, windowEnd, LIFETIME_EXP, devicesOf, maxDevicesOf, addDevice, setDevices, STALE_DEVICE_DAYS , putLicense, delLicense } from '../lib/core.mjs';

export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'Bad request' }, 400);

  const input = String(body.code || '').trim();
  const deviceId = String(body.deviceId || '').slice(0, 80);
  if (!input || !deviceId) return json({ error: 'Please enter your password.' }, 400);

  const t = await throttle('redeem', context.ip, 10);
  if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);

  const now = Date.now();
  const key = normCode(input);
  const store = licenses();
  const rec = key ? await store.get(key, { type: 'json' }) : null;

  // ---- Rental code ----
  if (rec) {
    if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact the owner.' }, 403);

    if (rec.status === 'active') {
      if (rec.expiresAt <= now) return json({ error: rec.kind === 'bonus' ? 'This bonus code has been used up.' : 'This code has expired.' }, 403);
      // Same device coming back, or a free device slot (a multi-device code,
      // or the owner released a device in Admin).
      const devs = devicesOf(rec);
      let mine = devs.find((d) => d.id === deviceId);
      // All slots taken: a device unused for STALE_DEVICE_DAYS gives up its
      // slot (e.g. Safari wiped the iPad's saved data after a week unused,
      // so the same iPad now looks like a new device).
      if (!mine && devs.length >= maxDevicesOf(rec)) {
        const stale = devs
          .filter((d) => now - (d.seen || d.at || 0) > STALE_DEVICE_DAYS * DAY)
          .sort((a, b) => (a.seen || a.at || 0) - (b.seen || b.at || 0))[0];
        if (stale) setDevices(rec, devs.filter((d) => d !== stale));
      }
      if (!mine && devicesOf(rec).length < maxDevicesOf(rec)) {
        addDevice(rec, deviceId, now);
        await putLicense(store, key, rec);
        mine = true;
      }
      if (mine) {
        await clearFail(t);
        return json({ ok: true, type: 'rental', kind: rec.kind || 'rental', lifetime: !!rec.lifetime, exp: rec.expiresAt, token: sign({ t: 'rental', k: key, d: deviceId, exp: rec.expiresAt }) });
      }
      const max = maxDevicesOf(rec);
      return json({ error: max > 1 ? 'This code is already in use on ' + max + ' devices (its limit). Please contact the owner to add or switch a device.' : 'This code has already been used on another device.' }, 403);
    }

    // Unused -> redeem (one time only).
    let exp;
    if (rec.kind === 'bonus') {
      // Bonus: N minutes from first entry, usable any time until the
      // event booking it belongs to has ended.
      const parent = rec.parent ? await store.get(rec.parent, { type: 'json' }) : null;
      const end = windowEnd(parent);
      if (end && end <= now) return json({ error: 'This bonus code has expired because the event booking has ended.' }, 403);
      exp = now + rec.minutes * MIN;
    } else if (rec.startsAt) {
      // Booked for a date: it opens at startsAt and runs a fixed window.
      // A correct code that is simply too early is not a failed attempt.
      if (now < rec.startsAt) return json({ error: 'This code opens on ' + fmtWhen(rec.startsAt) + '. See you then!' }, 403);
      exp = rec.lifetime ? LIFETIME_EXP : rec.startsAt + rec.days * DAY;
      if (exp <= now) return json({ error: 'This code has expired.' }, 403);
    } else {
      exp = rec.lifetime ? LIFETIME_EXP : now + rec.days * DAY; // no date set: the clock starts now
    }
    rec.status = 'active';
    rec.redeemedAt = now;
    rec.expiresAt = exp;
    addDevice(rec, deviceId, now);
    await putLicense(store, key, rec);
    await clearFail(t);
    return json({ ok: true, type: 'rental', kind: rec.kind || 'rental', lifetime: !!rec.lifetime, exp, days: rec.days, minutes: rec.minutes || null, scheduled: !!rec.startsAt, token: sign({ t: 'rental', k: key, d: deviceId, exp }) });
  }

  // ---- Trial password ----
  const settings = await getSettings();
  if (settings.trialEnabled && input.toLowerCase() === String(settings.trialPassword).trim().toLowerCase()) {
    const exp = now + settings.trialMinutes * 60000;
    // Each trial redemption gets its own throwaway Drive folder, so two people
    // trialling it at once never land in the same folder or see each other's shots.
    const folderKey = (settings.trialFolderPrefix || 'Trial') + ' ' + shortId();
    await clearFail(t);
    return json({ ok: true, type: 'trial', exp, minutes: settings.trialMinutes, folderKey, token: sign({ t: 'trial', d: deviceId, exp, f: folderKey }) });
  }

  await recordFail(t);
  return json({ error: 'That password is not valid.' }, 401);
});

export const config = { path: '/api/redeem' };
