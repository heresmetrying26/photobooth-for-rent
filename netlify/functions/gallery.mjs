import { safe, json, hmac, DRIVE_SCRIPT_URL, getSettings } from '../lib/core.mjs';

// Backs the online gallery (/g/<Drive folder id>).
//   GET /api/gallery?f=<folder id>        -> the folder's photos (via the Apps Script relay)
//   GET /api/gallery?img=<file id>&s=<sig> -> one listed photo's bytes as a fallback
// Only files listed by the relay get a signature, so this can't be used to fetch any other
// Drive file. Listings are cached on Netlify's CDN for a few seconds, so a crowd scanning the
// same QR at once costs one Drive lookup.
const ID_RE = /^[A-Za-z0-9_-]{10,80}$/;
const MAX_BYTES = 15 * 1024 * 1024;
const sigOf = (id) => hmac('gallery|' + id).slice(0, 22);

const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

async function serveImage(id, sig) {
  if (!ID_RE.test(id) || sig !== sigOf(id)) return notFound();
  let r;
  try { r = await fetch('https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id), { redirect: 'follow' }); }
  catch { return notFound(); }
  const type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok || !/^image\/(png|jpeg|webp)$/.test(type)) return notFound();
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return notFound();
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=86400',
      'netlify-cdn-cache-control': 'public, durable, max-age=604800',
      'netlify-vary': 'query=img'
    }
  });
}

export default safe(async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const u = new URL(req.url);
  const img = u.searchParams.get('img');
  if (img) return serveImage(img, u.searchParams.get('s') || '');

  const f = u.searchParams.get('f') || '';
  if (!ID_RE.test(f)) return json({ ok: false, error: 'not-found' }, 404);
  let data = null;
  try {
    const r = await fetch(DRIVE_SCRIPT_URL + '?action=list&folder=' + encodeURIComponent(f), { redirect: 'follow' });
    data = await r.json();
  } catch {
    return json({ ok: false, error: 'busy' }, 502);
  }
  // An Apps Script without the gallery code answers {ok:true, message} with no files.
  if (!data || !data.ok || !Array.isArray(data.files)) {
    return json({ ok: false, error: data && data.ok ? 'not-ready' : 'not-found' }, data && data.ok ? 503 : 404);
  }
  const files = data.files.filter((x) => x && ID_RE.test(x.id) && /^image\/(png|jpeg|webp)$/.test(x.mime || '')).slice(0, 2000).map((x) => ({
    id: x.id,
    name: String(x.name || '').slice(0, 120),
    t: Number(x.t) || 0,
    src: '/api/gallery?img=' + x.id + '&s=' + sigOf(x.id)
  }));
  return new Response(JSON.stringify({
    ok: true,
    name: String(data.name || 'Photos').slice(0, 120),
    folderUrl: /^https:\/\/drive\.google\.com\//.test(data.folderUrl || '') ? data.folderUrl : 'https://drive.google.com/drive/folders/' + f,
    until: Number(data.until) || null,
    qr: (await getSettings().catch(() => ({}))).galleryQr !== false,   // Admin → Guest QR codes
    files
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': 'public, max-age=15, stale-while-revalidate=45',
      'netlify-vary': 'query=f|v'
    }
  });
});

export const config = { path: '/api/gallery' };
