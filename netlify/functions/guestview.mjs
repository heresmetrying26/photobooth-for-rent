import { safe, json, checkLicense, verifyToken, hmac, cleanEventName, guestViewStore, guestViewMode, opKeyOf, printReqOn, printReqGuest, clientIp } from '../lib/core.mjs';

// What a guest sees after scanning their QR: their own photos, GIFs and flipbook, with (only when the booth allows it)
// a button to the whole event gallery.
//
//   Guest (the page at /p/<code>, nothing to sign in):
//     GET  /api/guestview?c=<code>                  -> { files, canAll, folder? ... } (folder only when canAll)
//     POST { action: 'print', code, file }          -> ask for a print of one of their photos (folder never leaves the server)
//   Booth (signed in with its code, like /api/printreq):
//     { action: 'mode', token, deviceId, folderKey, folder, mode }          -> 'all' | 'mine' | 'only' for this event
//     { action: 'link', token, deviceId, folderKey, folder, code, name, files: [{ id, name, mime }] }
//                                                                           -> adds saved files to a guest's page
//
// The guest's code is made by the booth and is unguessable. An unknown code looks like "still saving" (so nobody can
// tell which codes exist). In 'only' mode the event's folder is never sent to a guest, and /api/gallery refuses the
// event list without the booth's own key.
const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,40}$/;
const MAX_FILES = 40;
const MODE_TTL = 30 * 86400000;      // renewed every time the booth sets it
const PAGE_LIFE = 8 * 86400000;      // a guest's page lives as long as the gallery (7 days) plus a day
const sigOf = (id) => hmac('gallery|' + id).slice(0, 22);
const cKey = (c) => 'c:' + c;

async function boothAuth(b) {
  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return { res: json({ error: 'locked', reason: lic.reason }, 401) };
  const p = verifyToken(b.token);
  const owner = String(p.k || ('trial:' + p.d));
  // The booth may only use its own event's folder (same rule as /api/ticket).
  const asked = String(b.folderKey || '').trim();
  if (lic.folderPrefix) {
    const pre = lic.folderPrefix + ' · ', ev = asked.startsWith(pre) ? asked.slice(pre.length) : '';
    if (!ev || cleanEventName(ev) !== ev) return { res: json({ error: 'Type an event name using letters and numbers.' }, 400) };
  } else if (!lic.folderKey || asked !== lic.folderKey) return { res: json({ error: 'This booth can only use its own event folder.' }, 403) };
  return { lic, owner };
}

export default safe(async (req) => {
  const s = guestViewStore();
  const now = Date.now();

  // ---------- a guest opens their page ----------
  if (req.method === 'GET') {
    const c = new URL(req.url).searchParams.get('c') || '';
    if (!CODE_RE.test(c)) return json({ ok: false, error: 'not-found' }, 404);
    const doc = await s.get(cKey(c), { type: 'json' });
    if (!doc) return json({ ok: true, pending: true, files: [] });
    if (doc.exp <= now) return json({ ok: false, error: 'expired' }, 410);
    const mode = await guestViewMode(doc.folder);
    const canAll = mode !== 'only';
    const files = (doc.files || []).filter((x) => ID_RE.test(x.id)).map((x) => ({
      id: x.id, name: x.name, mime: x.mime, t: x.t,
      src: /^video\//.test(x.mime || '') ? '' : '/api/gallery?img=' + x.id + '&s=' + sigOf(x.id)
    })).sort((a, b) => b.t - a.t);
    return json({
      ok: true, name: doc.name || 'Your photos', files, canAll,
      folder: canAll ? doc.folder : undefined,
      until: (doc.first || now) + 7 * 86400000,
      printReq: await printReqOn(doc.folder)
    });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  // ---------- a guest asks for a print ----------
  if (b.action === 'print') {
    const code = String(b.code || ''), file = String(b.file || '');
    if (!CODE_RE.test(code) || !ID_RE.test(file)) return json({ error: 'Bad request' }, 400);
    const doc = await s.get(cKey(code), { type: 'json' });
    if (!doc || doc.exp <= now || !(doc.files || []).some((x) => x.id === file)) return json({ error: 'Bad request' }, 400);
    const r = await printReqGuest(doc.folder, file, clientIp(req));
    return json(r.body, r.status);
  }

  // ---------- the booth ----------
  const folder = String(b.folder || '');
  if (!ID_RE.test(folder)) return json({ error: 'Bad request' }, 400);
  const a = await boothAuth(b);
  if (a.res) return a.res;
  const { owner } = a;

  if (b.action === 'mode') {
    const mode = b.mode === 'mine' || b.mode === 'only' ? b.mode : 'all';
    const d = await s.get('f:' + folder, { type: 'json' });
    if (d && d.owner !== owner && d.exp > now) return json({ error: 'This gallery already belongs to another booth.' }, 403);
    await s.setJSON('f:' + folder, { owner, mode, exp: now + MODE_TTL });
    return json({ ok: true, mode, opKey: opKeyOf(folder) });
  }

  if (b.action === 'link') {
    const code = String(b.code || '');
    if (!CODE_RE.test(code)) return json({ error: 'Bad request' }, 400);
    const add = (Array.isArray(b.files) ? b.files : []).slice(0, 20)
      .filter((x) => x && ID_RE.test(String(x.id || '')))
      .map((x) => ({ id: String(x.id), name: String(x.name || '').slice(0, 120), mime: String(x.mime || '').slice(0, 40), t: now }));
    let d = await s.get(cKey(code), { type: 'json' });
    if (d && (d.owner !== owner || d.folder !== folder)) return json({ error: 'Bad request' }, 403);
    d = d || { owner, folder, files: [], first: now };
    for (const f of add) if (!d.files.some((x) => x.id === f.id) && d.files.length < MAX_FILES) d.files.push(f);
    d.name = String(b.name || d.name || 'Your photos').slice(0, 80);
    d.exp = now + PAGE_LIFE;
    await s.setJSON(cKey(code), d);
    return json({ ok: true, files: d.files.length });
  }
  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/guestview' };
