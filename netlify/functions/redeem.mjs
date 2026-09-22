import { safe, json, licenses, getSettings, sign, normCode, throttle, recordFail, clearFail, shortId, DAY } from '../lib/core.mjs';

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
      if (rec.expiresAt <= now) return json({ error: 'This code has expired.' }, 403);
      // Same device coming back, or the owner released it for a new device.
      if (rec.deviceId === deviceId || !rec.deviceId) {
        if (!rec.deviceId) {
          rec.deviceId = deviceId;
          await store.setJSON(key, rec);
        }
        await clearFail(t);
        return json({ ok: true, type: 'rental', exp: rec.expiresAt, token: sign({ t: 'rental', k: key, d: deviceId, exp: rec.expiresAt }) });
      }
      return json({ error: 'This code has already been used on another device.' }, 403);
    }

    // Unused -> redeem (one time only). The clock starts now.
    const exp = now + rec.days * DAY;
    rec.status = 'active';
    rec.redeemedAt = now;
    rec.expiresAt = exp;
    rec.deviceId = deviceId;
    await store.setJSON(key, rec);
    await clearFail(t);
    return json({ ok: true, type: 'rental', exp, days: rec.days, token: sign({ t: 'rental', k: key, d: deviceId, exp }) });
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
