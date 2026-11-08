// Phone -> kiosk photo transfer (the QR code).
//
//   Kiosk (knows the secret, JSON POST to /api/session):
//     { action:'create' }                          -> { code, secret, expires }
//     { action:'list',  code, secret }             -> { ids:[...] }   photos waiting
//     { action:'get',   code, secret, id }         -> the image bytes (x-name header = file name)
//     { action:'del',   code, secret, id }         -> deleted from the server once the kiosk has it
//     { action:'close', code, secret }             -> session and all its photos deleted
//   Phone (only knows the 6-letter code from the QR):
//     GET  /api/session?code=ABC123                -> { ok:true }  (is the code still valid?)
//     POST /api/session?code=ABC123&name=a.jpg     -> body = the image (jpeg/png/webp), added to the session
//
// A phone can only ADD photos to a session. Only the kiosk (secret) can read or delete them.
// Photos are removed as soon as the kiosk has downloaded them, and everything older than 3 hours is swept.
import { createHash, randomBytes } from 'node:crypto';

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';           // no 0/O/1/I
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const TTL = 3 * 3600 * 1000;
const MAX_PHOTOS = 40;
const MAX_BYTES = 5.5 * 1024 * 1024;                          // Netlify functions accept ~6 MB bodies

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const makeCode = () => [...randomBytes(6)].map((b) => ALPHA[b % ALPHA.length]).join('');

function sniff(buf) {
  const u = new Uint8Array(buf.slice(0, 12));
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg';
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png';
  if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 && u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return 'image/webp';
  return '';
}

async function getSession(db, code) {
  if (!CODE_RE.test(code || '')) return null;
  const s = await db().get('s/' + code, { type: 'json' }).catch(() => null);
  if (!s || s.created + TTL < Date.now()) return null;
  return s;
}

async function wipe(db, code) {
  const st = db();
  const { blobs: pBlobs } = await st.list({ prefix: 'p/' + code + '/' });
  await Promise.all(pBlobs.map((b) => st.delete(b.key)));
  const { blobs: dlBlobs } = await st.list({ prefix: 'dl/' + code + '/' });
  await Promise.all(dlBlobs.map((b) => st.delete(b.key)));
  await st.delete('s/' + code);
}

// Remove sessions nobody closed (a customer walked away).
async function sweep(db) {
  const st = db();
  const { blobs } = await st.list({ prefix: 's/' });
  let n = 0;
  for (const b of blobs) {
    if (n >= 15) break;
    const s = await st.get(b.key, { type: 'json' }).catch(() => null);
    if (!s || s.created + TTL < Date.now()) { await wipe(db, b.key.slice(2)); n++; }
  }
}

// db(): the blob store. authorize(req): true, or a Response to refuse creating a session (used for the licence check).
export const makeHandler = ({ db, authorize = async () => true }) => async (req) => {
  const url = new URL(req.url);
  const qcode = (url.searchParams.get('code') || '').toUpperCase();

  // ---------- phone ----------
  if (req.method === 'GET') {
    const s = await getSession(db, qcode);
    if (!s) return json({ error: 'expired' }, 404);
    const dlId = url.searchParams.get('dl');
    if (dlId) {
      if (!/^[a-z0-9-]{6,40}$/.test(dlId)) return json({ error: 'Bad request' }, 400);
      const st = db();
      const r = await st.getWithMetadata('dl/' + qcode + '/' + dlId, { type: 'arrayBuffer' });
      if (!r) return json({ error: 'gone' }, 404);
      return new Response(r.data, {
        headers: {
          'content-type': r.metadata?.type || 'image/jpeg',
          'content-disposition': 'attachment; filename="' + encodeURIComponent(r.metadata?.name || 'id-photo.jpg') + '"',
          'cache-control': 'no-store'
        }
      });
    }
    const st = db();
    const { blobs } = await st.list({ prefix: 'dl/' + qcode + '/' });
    const downloads = blobs.map((x) => ({
      id: x.key.split('/')[2],
      name: x.metadata?.name || 'id-photo.jpg'
    }));
    return json({ ok: true, downloads });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (qcode && !(req.headers.get('content-type') || '').includes('json')) {
    const s = await getSession(db, qcode);
    if (!s) return json({ error: 'expired' }, 404);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return json({ error: 'empty' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'too big' }, 413);
    const type = sniff(buf);
    if (!type) return json({ error: 'Only JPG, PNG or WebP photos.' }, 415);
    const st = db();
    const { blobs } = await st.list({ prefix: 'p/' + qcode + '/' });
    if (blobs.length >= MAX_PHOTOS) return json({ error: 'Too many photos for one session.' }, 429);
    const id = Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
    const name = (url.searchParams.get('name') || 'photo').slice(0, 80);
    await st.set('p/' + qcode + '/' + id, buf, { metadata: { type, name } });
    return json({ ok: true, id });
  }

  // ---------- kiosk ----------
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  if (b.action === 'create') {
    const ok = await authorize(req);
    if (ok !== true) return ok;
    await sweep(db).catch(() => {});
    const secret = randomBytes(20).toString('hex');
    let code = '';
    for (let i = 0; i < 6; i++) { const c = makeCode(); if (!(await getSession(db, c))) { code = c; break; } }
    if (!code) return json({ error: 'Try again' }, 503);
    await db().setJSON('s/' + code, { created: Date.now(), h: sha(secret) });
    return json({ code, secret, expires: Date.now() + TTL });
  }

  const code = String(b.code || '').toUpperCase();
  const s = await getSession(db, code);
  if (!s || s.h !== sha(b.secret || '')) return json({ error: 'expired' }, 404);
  const st = db();

  if (b.action === 'list') {
    const { blobs } = await st.list({ prefix: 'p/' + code + '/' });
    return json({ ids: blobs.map((x) => x.key.split('/')[2]).sort() });
  }
  if (b.action === 'get') {
    const id = String(b.id || '');
    if (!/^[a-z0-9-]{6,40}$/.test(id)) return json({ error: 'Bad request' }, 400);
    const r = await st.getWithMetadata('p/' + code + '/' + id, { type: 'arrayBuffer' });
    if (!r) return json({ error: 'gone' }, 404);
    return new Response(r.data, { headers: { 'content-type': r.metadata?.type || 'image/jpeg', 'x-name': encodeURIComponent(r.metadata?.name || ''), 'cache-control': 'no-store' } });
  }
  if (b.action === 'del') {
    const id = String(b.id || '');
    if (/^[a-z0-9-]{6,40}$/.test(id)) await st.delete('p/' + code + '/' + id);
    return json({ ok: true });
  }
  if (b.action === 'put_dl') {
    const name = String(b.name || 'id-photo.jpg').slice(0, 80);
    const dataBase64 = String(b.data || '');
    if (!dataBase64) return json({ error: 'No data' }, 400);
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.byteLength > MAX_BYTES) return json({ error: 'too big' }, 413);
    const id = Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
    await st.set('dl/' + code + '/' + id, buf, { metadata: { type: 'image/jpeg', name } });
    return json({ ok: true, id });
  }
  if (b.action === 'close') { await wipe(db, code); return json({ ok: true }); }
  return json({ error: 'Bad request' }, 400);
};
