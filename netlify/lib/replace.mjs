import { setupKeyFor, cleanEventName, displayCode, LIFETIME_EXP } from './core.mjs';

// Replace a leaked Lifetime code with a new one (Lifetime Access Agreement s.7): the renter keeps their
// events, saved booth setups, frames/logos/sounds, themes and lock PIN, and the old code is disabled.
// Guest-payment accounts (PayMongo key, vouchers) are sealed to the old code and are NOT copied: the
// renter reconnects them from the booth with a new payments PIN.
//   deps = { licenses, events, setups, putLicense, newKey }   (stores are injected so this can be tested)
export async function replaceLifetimeCode({ licenses, events, setups, putLicense, newKey }, oldKey, reason, now) {
  const old = await licenses.get(oldKey, { type: 'json' });
  if (!old || old.kind === 'bonus') return { error: 'Code not found.', status: 404 };
  if (!old.lifetime) return { error: 'Only Lifetime codes are replaced this way.', status: 400 };
  if (old.bonusKey) return { error: 'This code has a bonus code attached; replace it by hand.', status: 400 };
  if (old.status === 'revoked' && old.replacedBy) return { error: 'This code was already replaced by ' + displayCode(old.replacedBy) + '.', status: 409 };

  const key = await newKey(licenses);
  const fresh = {
    ...old,
    key,
    code: displayCode(key),
    // A new code the renter has not entered yet; it starts the same way any Lifetime code does.
    status: old.redeemedAt ? 'active' : 'unused',
    expiresAt: old.redeemedAt ? LIFETIME_EXP : null,
    devices: [],
    deviceId: null,
    replacedFrom: oldKey,
    replacedAt: now,
    createdAt: now,
    revokeReason: undefined, revokedAt: undefined, replacedBy: undefined, emailWas: undefined
  };
  for (const k of Object.keys(fresh)) if (fresh[k] === undefined) delete fresh[k];

  // Events list (Drive folder links) is stored per code.
  const doc = await events.get(oldKey, { type: 'json' });
  if (doc) await events.setJSON(key, doc);

  // Booth setups: one per event name, plus one for the code itself.
  const copied = { setups: 0, assets: 0 };
  const names = new Set(['_']);
  for (const e of (doc && doc.events) || []) names.add(cleanEventName(e.name || '').toLowerCase() || '_');
  for (const n of names) {
    const from = setupKeyFor(oldKey + '|' + n), to = setupKeyFor(key + '|' + n);
    const s = await setups.get(from);
    if (s != null) { await setups.set(to, s); copied.setups++; }
    const img = await setups.get(from + '_img');
    if (img != null) await setups.set(to + '_img', img);
  }
  // Uploaded frames/logos/sounds, saved themes and the lock PIN live under the code's owner id.
  const fromOwner = setupKeyFor('own|' + oldKey), toOwner = setupKeyFor('own|' + key);
  const listing = await setups.list({ prefix: fromOwner + '_' });
  for (const b of (listing && listing.blobs) || []) {
    const v = await setups.get(b.key);
    if (v != null) { await setups.set(toOwner + b.key.slice(fromOwner.length), v); copied.assets++; }
  }

  await putLicense(licenses, key, fresh);

  // The old code is disabled. Its email moves to the new code so "one email per Lifetime code" still holds.
  old.status = 'revoked';
  old.revokeReason = reason;
  old.revokedAt = now;
  old.replacedBy = key;
  old.emailWas = old.email || null;
  old.email = null;
  await putLicense(licenses, oldKey, old);

  return { ok: true, key, code: fresh.code, copied, paymentsNeedReconnect: !!old.payOpt };
}
