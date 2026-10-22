// Photos on this laptop + the guests' QR pages.
//
// The booth "uploads" each photo exactly like it uploads to Google Drive on the
// web, but to /local/drive (handled here), which saves it in
//   Pictures/photobooth4u/<event folder>/<n>_<layout>.jpg
// Every event folder gets a random id (slug). Guests' phones on the same Wi-Fi
// open http://<this laptop's address>:47777/e/<slug>/ (all photos) or
// /e/<slug>/p/<file> (one photo). Nothing goes to the internet.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream, renameSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

let ROOT = null, INDEX_FILE = null, index = { folders: {} }, thumbFn = null;
export const SHARE_PORTS = [47777, 47778, 47779, 47787, 47797];
let sharePort = 0;

export function initPhotos({ root, dataDir, makeThumb }) {
  ROOT = root; INDEX_FILE = join(dataDir, 'folders.json'); thumbFn = makeThumb || null;
  mkdirSync(ROOT, { recursive: true });
  try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) || { folders: {} }; } catch { index = { folders: {} }; }
  if (!index.folders) index.folders = {};
}
export const photosRoot = () => ROOT;
export function setPhotosRoot(dir) { ROOT = dir; mkdirSync(ROOT, { recursive: true }); }
function saveIndex() { const t = INDEX_FILE + '.tmp'; writeFileSync(t, JSON.stringify(index, null, 1)); renameSync(t, INDEX_FILE); }

const safeName = (v) => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 80);
const IMG_RE = /\.(jpe?g|png|webp|gif|mp4|webm)$/i;
const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };

// folderKey (+ subfolder) -> { slug, dir, name }
function folderFor(folderKey, subfolder) {
  const name = safeName(folderKey) || ('Photobooth ' + today());
  const sub = safeName(subfolder);
  const id = (name + (sub ? '/' + sub : '')).toLowerCase();
  let slug = Object.keys(index.folders).find((s) => index.folders[s].id === id && index.folders[s].root === ROOT);
  if (!slug) {
    slug = randomBytes(8).toString('base64url').replace(/[-_]/g, 'x');
    index.folders[slug] = { id, name, sub, root: ROOT, at: Date.now() };
    saveIndex();
  }
  const f = index.folders[slug];
  const dir = f.sub ? join(f.root, f.name, f.sub) : join(f.root, f.name);
  mkdirSync(dir, { recursive: true });
  return { slug, dir, name: f.sub ? f.name + ' / ' + f.sub : f.name };
}
function dirOf(slug) {
  const f = index.folders[slug];
  if (!f) return null;
  return f.sub ? join(f.root, f.name, f.sub) : join(f.root, f.name);
}
function photosIn(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => IMG_RE.test(n) && !n.startsWith('.')).map((n) => {
    let t = 0; try { t = statSync(join(dir, n)).mtimeMs; } catch { /* gone */ }
    return { n, t };
  }).sort((a, b) => b.t - a.t);
}
function nextSession(dir) {
  let max = 0;
  for (const { n } of photosIn(dir)) { const m = /^(?:BONUS_)?(\d+)_/.exec(n); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

// The booth's "Drive script" call (same request + reply shape as the Apps Script relay).
export async function driveRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Bad request' };
  const f = folderFor(body.folderKey, body.subfolder);
  const folderUrl = 'pb4u-local:' + f.slug;
  if (body.resolveOnly) return { ok: true, folderUrl, folderName: f.name, nextSessionNumber: nextSession(f.dir), folderPath: f.dir };
  const m = /^[A-Za-z0-9+/=\s]+$/.test(String(body.imageBase64 || '')) ? body.imageBase64 : null;
  if (!m) return { ok: false, error: 'No photo' };
  let name = basename(safeName(body.filename) || ('photo-' + Date.now() + '.jpg'));
  if (!IMG_RE.test(name)) name += '.jpg';
  // Never overwrite an earlier photo with the same name.
  let out = name, i = 2;
  while (existsSync(join(f.dir, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  writeFileSync(join(f.dir, out), Buffer.from(m, 'base64'));
  return { ok: true, fileId: f.slug + '/' + out, downloadUrl: 'pb4u-local:' + f.slug + '/' + out, folderUrl, folderName: f.name, folderPath: f.dir };
}
export function folderPathOf(folderUrl) {
  const m = /^pb4u-local:([A-Za-z0-9]+)/.exec(String(folderUrl || ''));
  return m ? dirOf(m[1]) : null;
}

// ---------- this laptop's address on the booth Wi-Fi ----------
const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|docker|br-|veth|utun|awdl|llw|bridge|ZeroTier|Tailscale|Loopback|vboxnet|WSL)/i;
export function lanAddress() {
  const nets = networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (/^169\.254\./.test(a.address)) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/^(wi-?fi|wlan|en0|en1|wireless|local area connection\*)/i.test(name)) score += 2;
      if (/^192\.168\.137\./.test(a.address)) score += 3;   // Windows mobile hotspot
      if (VIRTUAL.test(name)) score -= 10;
      cands.push({ ip: a.address, name, score });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.length && cands[0].score > -5 ? cands[0].ip : null;
}
export function shareBase() {
  const ip = lanAddress();
  return ip && sharePort ? 'http://' + ip + ':' + sharePort : null;
}
export const sharePortNow = () => sharePort;

// ---------- the guests' pages ----------
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const CSS = `*{box-sizing:border-box}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#F5F1EA;color:#1C1A1E;min-height:100vh}
header{padding:22px 16px 6px;text-align:center}.brand{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:15px;letter-spacing:-.01em;color:#1C1A1E;text-decoration:none}
.mk{display:grid;grid-template-columns:1fr 1fr;gap:2px;width:18px;height:18px}.mk i{background:#1C1A1E;border-radius:3px}.mk i:nth-child(2){background:#C93D27}
h1{font-size:24px;line-height:1.2;margin:10px 0 2px;font-weight:800;letter-spacing:-.02em}.sub{color:#6B666C;font-size:13px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:8px 12px 40px;max-width:1100px;margin:0 auto}
.grid a{display:block;background:#fff;border-radius:10px;overflow:hidden;aspect-ratio:3/4;box-shadow:0 2px 8px rgba(60,40,20,.08)}
.grid img{width:100%;height:100%;object-fit:cover;display:block}
.one{max-width:560px;margin:0 auto;padding:6px 16px 40px;text-align:center}.one img,.one video{max-width:100%;max-height:72vh;border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(60,40,20,.15)}
.btn{display:inline-block;margin:16px 6px 0;padding:14px 22px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:15px}
.btn.alt{background:#fff;color:#1C1A1E;border:1.5px solid #E4DCCF}.tip{color:#6B666C;font-size:13px;line-height:1.5;margin:14px auto 0;max-width:420px}.empty{text-align:center;color:#6B666C;padding:40px 16px}`;
function page(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><header><span class="brand"><span class="mk"><i></i><i></i><i></i><i></i></span>photobooth4u</span></header>' + body + '</body></html>';
}
function send(res, status, type, body, extra) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(extra || {}) });
  res.end(body);
}
const savingTip = '<p class="tip">iPhone: tap <b>Save photo</b>, then <b>Save to Photos</b> (or press and hold the picture). Android: tap <b>Save photo</b>.</p>';

async function handleShare(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  const m = /^\/e\/([A-Za-z0-9]{6,20})(?:\/(p|f|t)\/([^/]+))?\/?$/.exec(url.pathname);
  if (!m) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This link isn’t on this booth.</p>'));
  const dir = dirOf(m[1]);
  if (!dir || !existsSync(dir)) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This event isn’t on this booth anymore.</p>'));
  const ev = index.folders[m[1]];
  const evName = ev.sub ? ev.name + ' · ' + ev.sub : ev.name;
  if (!m[2]) {
    const list = photosIn(dir);
    const body = '<div style="text-align:center;padding:0 16px"><h1>' + esc(evName) + '</h1><p class="sub">' + list.length + ' photo' + (list.length === 1 ? '' : 's') + ' · tap one to save it</p></div>' +
      (list.length ? '<div class="grid">' + list.map(({ n }) => '<a href="/e/' + m[1] + '/p/' + encodeURIComponent(n) + '"><img loading="lazy" alt="" src="/e/' + m[1] + '/t/' + encodeURIComponent(n) + '"></a>').join('') + '</div>'
        : '<p class="empty">No photos yet. Pull down to refresh after your session.</p>');
    return send(res, 200, 'text/html; charset=utf-8', page(evName + ' photos', body));
  }
  let file;
  try { file = decodeURIComponent(m[3]); } catch { file = ''; }
  if (!file || file !== basename(file) || file.startsWith('.') || !IMG_RE.test(file)) return send(res, 404, 'text/plain', 'Not found');
  const full = join(dir, file);
  if (!existsSync(full)) {
    if (m[2] === 'p') return send(res, 404, 'text/html; charset=utf-8', page('Not ready', '<div class="one"><p class="empty">This photo isn’t here yet. Wait a moment and refresh.</p><a class="btn alt" href="/e/' + m[1] + '/">All photos</a></div>'));
    return send(res, 404, 'text/plain', 'Not found');
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  if (m[2] === 'p') {
    const src = '/e/' + m[1] + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="Your photo">';
    const body = '<div class="one"><h1>Your photo</h1><p class="sub">' + esc(evName) + '</p>' + media +
      '<div><a class="btn" href="' + src + '?dl=1" download="' + esc(file) + '">Save photo</a><a class="btn alt" href="/e/' + m[1] + '/">All photos</a></div>' + savingTip + '</div>';
    return send(res, 200, 'text/html; charset=utf-8', page('Your photo', body));
  }
  if (m[2] === 't' && thumbFn && /^image\/(jpeg|png|webp)$/.test(type)) {
    try {
      const tdir = join(dir, '.thumbs');
      const tf = join(tdir, file.replace(/\.[a-z0-9]+$/i, '') + '.jpg');
      if (!existsSync(tf) || statSync(tf).mtimeMs < statSync(full).mtimeMs) {
        const buf = await thumbFn(full);
        if (buf) { mkdirSync(tdir, { recursive: true }); writeFileSync(tf, buf); }
      }
      if (existsSync(tf)) { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=600' }); return createReadStream(tf).pipe(res); }
    } catch { /* fall back to the full photo */ }
  }
  const headers = { 'content-type': type, 'cache-control': 'max-age=600', 'x-content-type-options': 'nosniff' };
  if (url.searchParams.get('dl')) headers['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
  try { headers['content-length'] = statSync(full).size; } catch { /* ignore */ }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}

let server = null;
export function startShareServer() {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= SHARE_PORTS.length) { sharePort = 0; resolve(0); return; }
      const port = SHARE_PORTS[i++];
      const s = http.createServer((req, res) => { handleShare(req, res).catch(() => { try { send(res, 500, 'text/plain', 'Error'); } catch { /* closed */ } }); });
      s.once('error', () => { try { s.close(); } catch { /* ignore */ } tryNext(); });
      s.listen(port, '0.0.0.0', () => { server = s; sharePort = port; resolve(port); });
    };
    tryNext();
  });
}
export function stopShareServer() { try { server && server.close(); } catch { /* ignore */ } }
