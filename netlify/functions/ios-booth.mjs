// /api/ios-booth — OTA booth bundle check & download for the iPad offline app.
//   POST { licence, mid, hash, checkOnly } -> { ok, upToDate, hash, ios, html? }
import crypto from 'node:crypto';
import booth from '../lib/booth.mjs';
import { safe, json, licenses, getShutdown } from '../lib/core.mjs';
import { readLicence, readMap, appDevice } from '../lib/license.mjs';
import { liveIos } from '../lib/updates.mjs';

const CURRENT_HASH = crypto.createHash('sha256').update(String(booth || ''), 'utf8').digest('hex').slice(0, 16);

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || !b.licence || !b.mid) return json({ ok: false, error: 'Missing licence.' }, 400);

  const p = readLicence(b.licence);
  const mid = String(b.mid || '').trim().toUpperCase();
  if (!p || p.typ !== 'pb4u-desktop' || p.mid !== mid) {
    return json({ ok: false, error: 'This licence is not valid on this iPad.' }, 403);
  }

  const now = Date.now();
  const store = licenses();
  const map = await readMap(p.lid);
  const rec = map ? await store.get(map.key, { type: 'json' }) : null;
  const dev = rec && appDevice(rec, (a) => a.lid === p.lid && a.mid === mid);
  if (!rec || !dev) return json({ ok: false, error: 'This iPad was removed from your code.' }, 403);
  if (rec.status === 'revoked') return json({ ok: false, error: 'This code has been disabled.' }, 403);

  const sd = await getShutdown();
  if (!rec.offlineOpt && !(sd.on && rec.lifetime)) {
    return json({ ok: false, error: 'Offline app add-on is not enabled on this code.' }, 403);
  }
  if (!rec.lifetime && rec.expiresAt && rec.expiresAt <= now) {
    return json({ ok: false, error: 'This code has expired.' }, 403);
  }

  const clientHash = String(b.hash || '').trim().toLowerCase();
  const upToDate = !!clientHash && clientHash === CURRENT_HASH;
  const ios = await liveIos();

  if (b.checkOnly) {
    return json({ ok: true, upToDate, hash: CURRENT_HASH, ios });
  }
  return json({ ok: true, upToDate, hash: CURRENT_HASH, ios, html: booth });
});

export const config = { path: '/api/ios-booth' };
