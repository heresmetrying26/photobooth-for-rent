import {
  safe, json, licenses, meta, getSettings, sign, verifyToken, sha,
  newCode, displayCode, normCode, throttle, recordFail, clearFail, DAY
} from '../lib/core.mjs';
import { timingSafeEqual } from 'node:crypto';

function passwordOk(input) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) throw new Error('ADMIN_PASSWORD env var is not set in Netlify.');
  return timingSafeEqual(sha(input), sha(real));
}

async function allLicenses() {
  const store = licenses();
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return rows.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

const intIn = (v, min, max) => {
  const n = Math.floor(Number(v));
  return n >= min && n <= max ? n : null;
};

export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  if (b.action === 'login') {
    const t = await throttle('admin', context.ip, 6);
    if (t.blocked) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
    if (!passwordOk(b.password || '')) {
      await recordFail(t);
      return json({ error: 'Wrong admin password.' }, 401);
    }
    await clearFail(t);
    return json({ token: sign({ t: 'admin', exp: Date.now() + 8 * 3600000 }) });
  }

  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const p = verifyToken(auth);
  if (!p || p.t !== 'admin' || p.exp <= Date.now()) return json({ error: 'Session expired. Please log in again.' }, 401);

  const store = licenses();
  const getRec = async () => {
    const key = normCode(b.code);
    const rec = key ? await store.get(key, { type: 'json' }) : null;
    return { key, rec };
  };

  switch (b.action) {
    case 'list':
      return json({ licenses: await allLicenses(), settings: await getSettings(), now: Date.now() });

    case 'create': {
      const days = intIn(b.days, 1, 365);
      const count = intIn(b.count || 1, 1, 20);
      if (!days) return json({ error: 'Days must be between 1 and 365.' }, 400);
      if (!count) return json({ error: 'Count must be between 1 and 20.' }, 400);
      const label = String(b.label || '').trim().slice(0, 80);
      const created = [];
      for (let i = 0; i < count; i++) {
        let key;
        do { key = newCode(); } while (await store.get(key));
        const rec = { key, code: displayCode(key), label, days, status: 'unused', createdAt: Date.now(), redeemedAt: null, expiresAt: null, deviceId: null };
        await store.setJSON(key, rec);
        created.push(rec);
      }
      return json({ created });
    }

    case 'revoke': {
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.status = 'revoked';
      await store.setJSON(key, rec);
      return json({ ok: true });
    }

    case 'restore': {
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.status = rec.redeemedAt ? 'active' : 'unused';
      await store.setJSON(key, rec);
      return json({ ok: true });
    }

    case 'unbind': { // let the renter enter the code once more on a different device
      const { key, rec } = await getRec();
      if (!rec || rec.status !== 'active') return json({ error: 'Only an active code can be moved to a new device.' }, 400);
      rec.deviceId = null;
      await store.setJSON(key, rec);
      return json({ ok: true });
    }

    case 'extend': {
      const add = intIn(b.days, 1, 365);
      if (!add) return json({ error: 'Days must be between 1 and 365.' }, 400);
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      if (rec.status === 'active') rec.expiresAt = Math.max(rec.expiresAt, Date.now()) + add * DAY;
      else if (rec.status === 'unused') rec.days += add;
      else return json({ error: 'Restore this code before extending it.' }, 400);
      await store.setJSON(key, rec);
      return json({ ok: true });
    }

    case 'delete': {
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      await store.delete(key);
      return json({ ok: true });
    }

    case 'settings': {
      const pw = String(b.trialPassword || '').trim();
      const minutes = intIn(b.trialMinutes, 1, 240);
      if (pw.length < 3 || pw.length > 40) return json({ error: 'Trial password must be 3-40 characters.' }, 400);
      if (!minutes) return json({ error: 'Trial length must be 1-240 minutes.' }, 400);
      const settings = { trialEnabled: !!b.trialEnabled, trialPassword: pw, trialMinutes: minutes };
      await meta().setJSON('settings', settings);
      return json({ settings });
    }

    default:
      return json({ error: 'Unknown action.' }, 400);
  }
});

export const config = { path: '/api/admin' };
