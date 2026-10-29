import { safe, json, checkLicense, verifyToken, hmac, cleanEventName, printReqStore, printReqGuest, clientIp } from '../lib/core.mjs';

// Guests asking for a print from the online gallery. Off until the booth turns it on for its own event.
//
//   Guest (the gallery page, nothing to sign in):
//     { action: 'request', folder, file }   -> adds the photo to the booth's list of print requests
//   Booth (signed in with its code, like /api/ticket):
//     { action: 'enable', token, deviceId, folderKey, folder, on }   -> switch it on / off for this event's gallery
//     { action: 'poll',   token, deviceId, folder }                  -> the requests waiting to be printed
//     { action: 'done',   token, deviceId, folder, ids: [...] }      -> printed or dismissed
//
// One document per gallery folder. It belongs to the booth that switched it on; another booth cannot read or
// change it. Guests are limited per phone, a photo can only be waiting once, and the list is capped, so a
// bored guest cannot flood the booth.
const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const TTL = 3 * 86400000;            // switched on for 3 days at a time; the booth renews it while it is open
const key = (folder) => 'f:' + folder;

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const folder = String(b.folder || '');
  if (!ID_RE.test(folder)) return json({ error: 'Bad request' }, 400);
  const now = Date.now();
  const s = printReqStore();

  // ---------- a guest ----------
  if (b.action === 'request') {
    const r = await printReqGuest(folder, String(b.file || ''), clientIp(req));
    return json(r.body, r.status);
  }

  // ---------- the booth ----------
  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
  const p = verifyToken(b.token);
  const owner = String(p.k || ('trial:' + p.d));
  // The booth may only use its own event's folder (same rule as /api/ticket).
  const asked = String(b.folderKey || '').trim();
  if (lic.folderPrefix) {
    const pre = lic.folderPrefix + ' · ', ev = asked.startsWith(pre) ? asked.slice(pre.length) : '';
    if (!ev || cleanEventName(ev) !== ev) return json({ error: 'Type an event name using letters and numbers.' }, 400);
  } else if (!lic.folderKey || asked !== lic.folderKey) return json({ error: 'This booth can only use its own event folder.' }, 403);

  let d = await s.get(key(folder), { type: 'json' });
  if (d && d.owner !== owner && d.exp > now) return json({ error: 'This gallery already belongs to another booth.' }, 403);
  if (d && d.owner !== owner) d = null;

  if (b.action === 'enable') {
    if (!b.on) { if (d) { d.on = false; await s.setJSON(key(folder), d); } return json({ ok: true, on: false }); }
    d = d || { owner, reqs: [], done: {}, hits: {} };
    d.on = true; d.exp = Math.min(lic.exp, now + TTL);
    await s.setJSON(key(folder), d);
    return json({ ok: true, on: true, exp: d.exp });
  }
  if (b.action === 'poll') {
    if (!d) return json({ ok: true, on: false, reqs: [] });
    if (d.on && d.exp - now < TTL - 3600000) { d.exp = Math.min(lic.exp, now + TTL); await s.setJSON(key(folder), d); }     // renewed while the booth is open
    return json({ ok: true, on: !!d.on, reqs: d.reqs.map((r) => ({ id: r.id, file: r.file, t: r.t })) });
  }
  if (b.action === 'done') {
    if (!d) return json({ ok: true });
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    d.done = d.done || {};
    for (const r of d.reqs) if (ids.has(r.id)) d.done[r.file] = now;
    d.reqs = d.reqs.filter((r) => !ids.has(r.id));
    const keys = Object.keys(d.done); if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete d.done[k];
    await s.setJSON(key(folder), d);
    return json({ ok: true });
  }
  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/printreq' };
