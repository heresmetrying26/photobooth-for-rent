import { safe, json, checkLicense, verifyToken, printsStore, printScope, cleanEventName } from '../lib/core.mjs';

// Counts the sheets each event prints, so Admin's "prints per event" limit
// holds across reloads and across every device on the same code.
//   status -> { used, eventLimit, sessionLimit, left }
//   use    -> { n } adds n sheets if the limit allows it (all or nothing)
// left = null means no event limit.
export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
  if (!lic.print || !lic.print.enabled) return json({ error: 'Printing is off for this code.' }, 403);

  const p = verifyToken(b.token);
  const id = printScope(lic, p, b.event);
  const store = printsStore();
  const doc = (await store.get(id, { type: 'json' })) || { used: 0 };
  const limit = lic.print.eventLimit || 0;
  const out = (extra) => json({
    ok: true, used: doc.used, eventLimit: limit, sessionLimit: lic.print.sessionLimit || 0,
    left: limit ? Math.max(0, limit - doc.used) : null, ...extra
  });

  if (b.action === 'status') return out();
  if (b.action === 'use') {
    const n = Math.floor(Number(b.n));
    if (!(n >= 1 && n <= 200)) return json({ error: 'Bad count' }, 400);
    if (limit && doc.used + n > limit) return out({ ok: false, error: 'limit' });
    doc.used += n;
    doc.updatedAt = Date.now();
    if (lic.folderPrefix) doc.event = cleanEventName(b.event || '');
    await store.setJSON(id, doc);
    return out();
  }
  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/prints' };
