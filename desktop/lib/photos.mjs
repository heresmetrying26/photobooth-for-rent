// Photos on this laptop + the guests' QR pages.
//
// The booth "uploads" each photo exactly like it uploads to Google Drive on the
// web, but to /local/drive (handled here), which saves it in
//   Pictures/photobooth4u/<event folder>/<n>_<layout>.jpg
// Every event folder gets a random id (slug). Guests' phones on the same Wi-Fi
// open http://<this laptop's address>:47777/e/<slug>/ (all photos) or
// /e/<slug>/p/<file> (one photo). Nothing goes to the internet.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream, createWriteStream, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

let ROOT = null, INDEX_FILE = null, index = { folders: {} }, thumbFn = null, CODES_FILE = null;
export const SHARE_PORTS = [47777, 47778, 47779, 47787, 47797];
let sharePort = 0;

export function initPhotos({ root, dataDir, makeThumb }) {
  ROOT = root; INDEX_FILE = join(dataDir, 'folders.json'); thumbFn = makeThumb || null;
  CODES_FILE = join(dataDir, 'guestcodes.json');
  mkdirSync(ROOT, { recursive: true });
  try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) || { folders: {} }; } catch { index = { folders: {} }; }
  if (!index.folders) index.folders = {};
  try { codes = JSON.parse(readFileSync(CODES_FILE, 'utf8')) || {}; } catch { codes = {}; }
}
export const photosRoot = () => ROOT;
export function setPhotosRoot(dir) { ROOT = dir; mkdirSync(ROOT, { recursive: true }); }
function saveIndex() { const t = INDEX_FILE + '.tmp'; writeFileSync(t, JSON.stringify(index, null, 1)); renameSync(t, INDEX_FILE); }

const safeName = (v) => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 80);
const IMG_RE = /\.(jpe?g|png|webp|gif|mp4|webm|mov|m4v)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
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

// ---------- what guests see after scanning (Setup -> Share: "After guests scan their QR") ----------
//   'all'  the whole event (today's behaviour)     'mine' their own photos first, with a button for everyone's
//   'only' their own photos and nothing else: the event pages answer only this laptop itself
// A guest's own page is /o/<code>. The booth makes the code for each session and sends it with every file it saves
// (guestCode), so the page knows which files are theirs. The code is unguessable, and the page never shows the
// event's address, so nobody can step to the next guest's photo.
const GCODE_RE = /^[A-Za-z0-9_-]{16,40}$/;
let guestView = 'all', codes = {}, codesTimer = null;
export function setGuestView(mode) { guestView = mode === 'mine' || mode === 'only' ? mode : 'all'; return guestView; }
export const guestViewNow = () => guestView;
function saveCodes() {
  clearTimeout(codesTimer);
  codesTimer = setTimeout(() => {
    try {
      const keys = Object.keys(codes);
      if (keys.length > 2000) keys.sort((a, b) => codes[a].first - codes[b].first).slice(0, keys.length - 2000).forEach((k) => delete codes[k]);
      const t = CODES_FILE + '.tmp'; writeFileSync(t, JSON.stringify(codes)); renameSync(t, CODES_FILE);
    } catch { /* the photos are safe; the guest's page just won't survive a restart */ }
  }, 300);
}
function noteGuestFile(code, slug, file) {
  if (!GCODE_RE.test(String(code || ''))) return;
  const c = codes[code] || (codes[code] = { slug, files: [], first: Date.now() });
  if (c.slug === slug && !c.files.includes(file) && c.files.length < 40) c.files.push(file);
  saveCodes();
}
// Is this request from the laptop itself (the operator), not a guest's phone?
export function isLocalReq(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  for (const list of Object.values(networkInterfaces())) for (const x of list || []) if (x.address === a) return true;
  return false;
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
  noteGuestFile(body.guestCode, f.slug, out);
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
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const CSS = `*{box-sizing:border-box}html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#F5F1EA;color:#1C1A1E;min-height:100vh}
header{padding:22px 16px 6px;text-align:center}.brand{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:15px;letter-spacing:-.01em;color:#1C1A1E;text-decoration:none}
.mk{display:grid;grid-template-columns:1fr 1fr;gap:2px;width:18px;height:18px}.mk i{background:#1C1A1E;border-radius:3px}.mk i:nth-child(2){background:#C93D27}
h1{font-size:24px;line-height:1.2;margin:10px 0 2px;font-weight:800;letter-spacing:-.02em}.sub{color:#6B666C;font-size:13px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:8px 12px 40px;max-width:1100px;margin:0 auto}
.grid a{display:block;background:#fff;border-radius:10px;overflow:hidden;aspect-ratio:3/4;box-shadow:0 2px 8px rgba(60,40,20,.08)}
.grid img{width:100%;height:100%;object-fit:cover;display:block}
.one{max-width:560px;margin:0 auto;padding:6px 16px 40px;text-align:center}.one img,.one video{max-width:100%;max-height:72vh;border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(60,40,20,.15)}
@media print{@page{margin:0}html,body{width:100%;height:100%;margin:0!important;background:#fff!important}body *{visibility:hidden!important}.one{position:absolute!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;max-width:none!important;margin:0!important;padding:0!important}.one img{position:absolute!important;visibility:visible!important;display:block!important;max-width:100vw!important;max-height:100vh!important;width:auto!important;height:auto!important;object-fit:contain!important;border:0!important;border-radius:0!important;box-shadow:none!important}.one h1,.one .sub,.one video,.one div,.one .tip{display:none!important}}
.btn{display:inline-block;margin:16px 6px 0;padding:14px 22px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:15px}
.btn.alt{background:#fff;color:#1C1A1E;border:1.5px solid #E4DCCF}.tip{color:#6B666C;font-size:13px;line-height:1.5;margin:14px auto 0;max-width:420px}.empty{text-align:center;color:#6B666C;padding:40px 16px}
.tabs{display:inline-flex;background:#EAE4D9;border-radius:24px;padding:3px;margin:0 auto 16px;gap:2px}
.tab{background:transparent;border:0;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:700;color:#6B666C;cursor:pointer}
.tab.active{background:#fff;color:#1C1A1E;box-shadow:0 1px 4px rgba(60,40,20,.1)}
.grid.filter-photo [data-kind="gif"]{display:none!important}
.grid.filter-gif [data-kind="photo"]{display:none!important}
.grid a{position:relative}
.grid [data-kind="gif"]::after{content:'GIF';position:absolute;bottom:6px;right:6px;background:rgba(28,26,30,.8);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:4px;letter-spacing:.5px;pointer-events:none}`;
function page(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><header><span class="brand"><span class="mk"><i></i><i></i><i></i><i></i></span>photobooth4u</span></header>' + body + '</body></html>';
}
function send(res, status, type, body, extra) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(extra || {}) });
  res.end(body);
}
const savingTip = '<p class="tip">iPhone: tap <b>Save photo</b>, then <b>Save to Photos</b> (or press and hold the picture). Android: tap <b>Save photo</b>.</p>';

// ---------- a file with Range support (phones need it to play and skip through a video) ----------
function serveFile(req, res, full, type, extra) {
  let size;
  try { size = statSync(full).size; } catch { return send(res, 404, 'text/plain', 'Not found'); }
  const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'max-age=600', 'x-content-type-options': 'nosniff', ...(extra || {}) };
  const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (rg && (rg[1] !== '' || rg[2] !== '')) {
    let a, b;
    if (rg[1] === '') { a = Math.max(0, size - Number(rg[2])); b = size - 1; }
    else { a = Number(rg[1]); b = rg[2] === '' ? size - 1 : Math.min(Number(rg[2]), size - 1); }
    if (!(a >= 0 && a <= b && a < size)) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
    res.writeHead(206, { ...h, 'content-range': 'bytes ' + a + '-' + b + '/' + size, 'content-length': b - a + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(full, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}

// ---------- 360 videos: an inbox folder, the operator's phone send page, and sharing into an event ----------
// The camera on the arm records with its own app. The clip reaches this laptop by being saved in the inbox
// folder (AirDrop, USB, a cloud folder, a camera's FTP...) or sent from the phone's browser (page below).
let spinDir = null;
const spinToken = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
const SPIN_MAX = 1024 * 1024 * 1024;           // 1 GB per clip is far more than a 15 s video needs
export function setSpinDir(dir) { spinDir = dir || null; }
export function spinDirNow() {
  const d = spinDir || (ROOT ? join(ROOT, '360 inbox') : null);
  if (d) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
  return d;
}
export function spinSendUrl() { const b = shareBase(); return b ? b + '/send/' + spinToken : null; }
export function spinPreviewBase() { return sharePort ? 'http://127.0.0.1:' + sharePort + '/send/' + spinToken : null; }
export const spinEditedDir = () => { const d = spinDirNow(); return d ? join(d, 'edited') : null; };
export function spinList() {
  const d = spinDirNow(); if (!d) return [];
  let names = []; try { names = readdirSync(d); } catch { return []; }
  return names.filter((n) => VIDEO_RE.test(n) && !n.startsWith('.')).map((n) => {
    try { const st = statSync(join(d, n)); return st.isFile() ? { name: n, size: st.size, mtime: st.mtimeMs } : null; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, 300);
}
// Copies a clip from the inbox into an event folder, in the same reply shape as driveRequest().
export function spinShare(name, folderKey, subfolder, outName) {
  const rel = String(name || '');
  const d = /^edited\//.test(rel) ? spinEditedDir() : spinDirNow();     // "edited/<file>" = a finished edit
  const n = basename(rel);
  if (!d || !VIDEO_RE.test(n)) return { ok: false, error: 'No video' };
  const src = join(d, n);
  if (!existsSync(src)) return { ok: false, error: 'That video is no longer in the inbox' };
  const f = folderFor(folderKey, subfolder);
  let base = basename(safeName(outName) || n); if (!VIDEO_RE.test(base)) base += (/\.[a-z0-9]+$/i.exec(n) || ['.mp4'])[0].toLowerCase();
  let out = base, i = 2;
  while (existsSync(join(f.dir, out))) { out = base.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  copyFileSync(src, join(f.dir, out));
  return { ok: true, fileId: f.slug + '/' + out, downloadUrl: 'pb4u-local:' + f.slug + '/' + out, folderUrl: 'pb4u-local:' + f.slug, folderName: f.name, folderPath: f.dir };
}
const SEND_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send a video</title>' +
  '<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1EA;color:#1C1A1E;padding:24px 18px;text-align:center}h1{font-size:22px;margin:6px 0}p{color:#6B666C}' +
  'label.pick{display:inline-block;margin:18px 0 8px;padding:16px 26px;border-radius:14px;background:#C93D27;color:#fff;font-weight:800;font-size:17px}input{display:none}' +
  '.bar{height:10px;border-radius:6px;background:#E4DCCF;overflow:hidden;margin:14px auto;max-width:420px}.bar i{display:block;height:100%;width:0;background:#2EA66B}.row{margin:6px auto;max-width:420px;text-align:left;font-size:14px}</style></head><body>' +
  '<h1>Send a 360 video</h1><p>Pick the clip you just recorded. It goes straight to the booth laptop.</p>' +
  '<label class="pick" for="f">Choose a video</label><input id="f" type="file" accept="video/*" multiple><div id="list"></div>' +
  '<script>var T=location.pathname.replace(/[/]+$/,"");document.getElementById("f").addEventListener("change",function(e){Array.prototype.forEach.call(e.target.files,send);e.target.value=""});' +
  'function send(file){var row=document.createElement("div");row.className="row";row.innerHTML="<b></b><div class=bar><i></i></div><span></span>";row.querySelector("b").textContent=file.name;document.getElementById("list").appendChild(row);' +
  'var x=new XMLHttpRequest();x.open("POST",T+"/upload?name="+encodeURIComponent(file.name));x.setRequestHeader("content-type","application/octet-stream");' +
  'x.upload.onprogress=function(p){if(p.lengthComputable)row.querySelector("i").style.width=Math.round(p.loaded/p.total*100)+"%"};' +
  'x.onload=function(){var ok=x.status===200;row.querySelector("span").textContent=ok?"Sent. It is on the laptop now.":"Could not send ("+x.status+"). Try again.";if(ok)row.querySelector("i").style.width="100%"};' +
  'x.onerror=function(){row.querySelector("span").textContent="No connection to the laptop. Are you on the booth Wi-Fi?"};x.send(file)}</script></body></html>';
// ---------- Roving photos: a phone sends photos to this laptop; the booth picks them up from the inbox ----------
// The photographer scans a QR code, picks or takes photos on the phone, and they land in "Roving inbox".
// The booth page takes each one (moves it to done/), puts it in the frame and gives it a QR code.
const ROVE_MAX = 80 * 1024 * 1024;
const ROVE_RE = /\.(jpe?g|png|webp)$/i;
export function roveDirNow() {
  const d = ROOT ? join(ROOT, 'Roving inbox') : null;
  if (d) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
  return d;
}
export function roveSendUrl() { const b = shareBase(); return b ? b + '/send/' + spinToken + '/photos' : null; }
export function rovePreviewBase() { return sharePort ? 'http://127.0.0.1:' + sharePort + '/send/' + spinToken + '/photos' : null; }
export function roveList() {
  const d = roveDirNow(); if (!d) return [];
  let names = []; try { names = readdirSync(d); } catch { return []; }
  return names.filter((n) => ROVE_RE.test(n) && !n.startsWith('.')).map((n) => {
    try { const st = statSync(join(d, n)); return st.isFile() ? { name: n, size: st.size, mtime: st.mtimeMs } : null; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.mtime - b.mtime).slice(0, 200);
}
// Hands one photo to the booth page and moves it to done/ so it is never taken twice.
export function roveTake(name) {
  const d = roveDirNow(); const n = basename(String(name || ''));
  if (!d || !n || n.startsWith('.') || !ROVE_RE.test(n)) return null;
  const src = join(d, n); if (!existsSync(src)) return null;
  let bytes; try { bytes = readFileSync(src); } catch { return null; }
  try {
    const done = join(d, 'done'); mkdirSync(done, { recursive: true });
    let out = n, i = 2; while (existsSync(join(done, out))) { out = n.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
    renameSync(src, join(done, out));
  } catch { try { unlinkSync(src); } catch { /* ignore */ } }
  return bytes;
}
const ROVE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send photos</title>
<style>body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1EA;color:#1C1A1E;padding:24px 18px;text-align:center}h1{font-size:22px;margin:6px 0}p{color:#6B666C;margin:6px 0}
label.pick{display:block;max-width:360px;margin:14px auto 0;padding:18px 26px;border-radius:14px;background:#C93D27;color:#fff;font-weight:800;font-size:18px}label.alt{background:#1C1A1E}input{display:none}
.bar{height:10px;border-radius:6px;background:#E4DCCF;overflow:hidden;margin:6px auto 2px;max-width:420px}.bar i{display:block;height:100%;width:0;background:#2EA66B}.row{margin:14px auto 0;max-width:420px;text-align:left;font-size:14px}#list{margin-top:18px}</style></head><body>
<h1>Send photos to the booth</h1><p>Each photo goes straight to the booth laptop, into the event frame, ready to print.</p>
<label class="pick" for="cam">Take a photo</label><input id="cam" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
<label class="pick alt" for="f">Choose photos</label><input id="f" type="file" accept="image/jpeg,image/png,image/webp" multiple><div id="list"></div>
<script>var T=location.pathname.replace(/[/]+$/,"").replace(/[/]photos$/,"");
function pick(e){Array.prototype.forEach.call(e.target.files,send);e.target.value=""}
document.getElementById("f").addEventListener("change",pick);document.getElementById("cam").addEventListener("change",pick);
function send(file){var row=document.createElement("div");row.className="row";row.innerHTML="<b></b><div class=bar><i></i></div><span></span>";row.querySelector("b").textContent=file.name||"photo";document.getElementById("list").insertBefore(row,document.getElementById("list").firstChild);
var x=new XMLHttpRequest();x.open("POST",T+"/photo?name="+encodeURIComponent(file.name||"photo.jpg"));x.setRequestHeader("content-type","application/octet-stream");
x.upload.onprogress=function(p){if(p.lengthComputable)row.querySelector("i").style.width=Math.round(p.loaded/p.total*100)+"%"};
x.onload=function(){var ok=x.status===200;row.querySelector("span").textContent=ok?"Sent. It is on the laptop now.":"Could not send ("+x.status+"). Try again.";if(ok)row.querySelector("i").style.width="100%"};
x.onerror=function(){row.querySelector("span").textContent="No connection to the laptop. Are you on the booth Wi-Fi?"};x.send(file)}</script></body></html>`;
function handleRovePhoto(req, res, url) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
  const d = roveDirNow(); if (!d) return send(res, 503, 'text/plain', 'Not ready', cors);
  let name = basename(safeName(url.searchParams.get('name')) || ('photo-' + Date.now() + '.jpg'));
  if (!ROVE_RE.test(name)) name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.jpg';     // phones sometimes send IMG_1234.HEIC-style or no extension
  name = Date.now().toString(36) + '_' + name;
  const len = Number(req.headers['content-length'] || 0);
  if (len > ROVE_MAX) return send(res, 413, 'application/json', JSON.stringify({ ok: false, error: 'Too big' }), cors);
  let out = name, i = 2; while (existsSync(join(d, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  const part = join(d, '.' + out + '.part');                     // not listed until it is complete
  const ws = createWriteStream(part);
  let got = 0, dead = false;
  const fail = (code, msg) => { if (dead) return; dead = true; try { ws.destroy(); unlinkSync(part); } catch { /* ignore */ } try { send(res, code, 'application/json', JSON.stringify({ ok: false, error: msg }), cors); } catch { /* closed */ } };
  req.on('data', (c) => { got += c.length; if (got > ROVE_MAX) { req.destroy(); fail(413, 'Too big'); } });
  req.on('error', () => fail(400, 'Interrupted'));
  req.on('aborted', () => fail(400, 'Interrupted'));
  ws.on('error', () => fail(500, 'Could not save'));
  ws.on('finish', () => {
    if (dead) return;
    try { renameSync(part, join(d, out)); } catch { return fail(500, 'Could not save'); }
    send(res, 200, 'application/json', JSON.stringify({ ok: true, name: out }), cors);
  });
  req.pipe(ws);
}
function handleSend(req, res, url, sm) {
  const cors = { 'access-control-allow-origin': '*' };
  if (sm[1] !== spinToken) return send(res, 404, 'text/plain', 'Not found');
  if (sm[2] === 'photos') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'text/html; charset=utf-8', ROVE_PAGE);
  }
  if (sm[2] === 'photo') return handleRovePhoto(req, res, url);
  // The 360 recording tablet checks it can reach this laptop (and the link is right) before it records.
  if (sm[2] === 'hello') {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, app: 'photobooth4u', kind: 'laptop' }), cors);
  }
  const d = spinDirNow(); if (!d) return send(res, 503, 'text/plain', 'Not ready');
  if (!sm[2]) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'text/html; charset=utf-8', SEND_PAGE);
  }
  if (sm[2] === 'file' || sm[2] === 'edited') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    const base = sm[2] === 'edited' ? join(d, 'edited') : d;
    let n; try { n = decodeURIComponent(sm[3] || ''); } catch { n = ''; }
    if (!n || n !== basename(n) || n.startsWith('.') || !VIDEO_RE.test(n) || !existsSync(join(base, n))) return send(res, 404, 'text/plain', 'Not found');
    return serveFile(req, res, join(base, n), TYPES[extname(n).toLowerCase()] || 'video/mp4', cors);
  }
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
  const want = safeName(url.searchParams.get('name')) || ('clip-' + Date.now() + '.mp4');
  let name = basename(want); if (!VIDEO_RE.test(name)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'Only video files' }), cors);
  const len = Number(req.headers['content-length'] || 0);
  if (len > SPIN_MAX) return send(res, 413, 'application/json', JSON.stringify({ ok: false, error: 'Too big' }), cors);
  let out = name, i = 2;
  while (existsSync(join(d, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  const part = join(d, '.' + out + '.part');                      // not listed until it is complete
  const ws = createWriteStream(part);
  let got = 0, dead = false;
  const fail = (code, msg) => { if (dead) return; dead = true; try { ws.destroy(); unlinkSync(part); } catch { /* ignore */ } try { send(res, code, 'application/json', JSON.stringify({ ok: false, error: msg }), cors); } catch { /* closed */ } };
  req.on('data', (c) => { got += c.length; if (got > SPIN_MAX) { req.destroy(); fail(413, 'Too big'); } });
  req.on('error', () => fail(400, 'Interrupted'));
  req.on('aborted', () => fail(400, 'Interrupted'));
  ws.on('error', () => fail(500, 'Could not save'));
  ws.on('finish', () => {
    if (dead) return;
    try { renameSync(part, join(d, out)); } catch { return fail(500, 'Could not save'); }
    send(res, 200, 'application/json', JSON.stringify({ ok: true, name: out }), cors);
  });
  req.pipe(ws);
}

// ---------- guests ask for a print ----------
// The booth turns this on (Setup -> Print). A guest who opened their photo from the QR code can then tap "Ask for a
// print at the booth"; the request waits here until the attendant prints or dismisses it on the booth screen.
let guestPrintOn = false;
const printReqs = [];                        // { id, slug, file, event, t }
const askedBefore = new Set();               // slug/file already asked for (a photo is only asked for once)
const reqHits = new Map();                   // phone address -> times of its recent requests
const REQ_MAX = 200, REQ_RATE_N = 8, REQ_RATE_MS = 10 * 60000;
export function setGuestPrint(on) { guestPrintOn = !!on; return guestPrintOn; }
export const guestPrintNow = () => guestPrintOn;
export const printReqList = () => printReqs.map((r) => ({ ...r }));
export function printReqDone(id) { const i = printReqs.findIndex((r) => r.id === String(id)); if (i >= 0) printReqs.splice(i, 1); return i >= 0; }
// The photo of a request, for the booth to print.
export function printReqRead(id) {
  const r = printReqs.find((x) => x.id === String(id)); if (!r) return null;
  const dir = dirOf(r.slug); if (!dir) return null;
  try { return readFileSync(join(dir, r.file)); } catch { return null; }
}
function reqButtonHtml(slug, file, postUrl, idn) {
  const id = 'askPrint' + (idn || '');
  return '<button class="btn alt" id="' + id + '" type="button">Ask for a print at the booth</button>' +
    '<script>(function(){var b=document.getElementById("' + id + '"),k="pb_asked_' + slug + '_' + String(file).replace(/[^\w.-]/g, '_') + '";if(sessionStorage.getItem(k)){b.disabled=true;b.textContent="Requested \u2713"}' +
    'b.addEventListener("click",function(){b.disabled=true;b.textContent="Sending\u2026";fetch("' + (postUrl || '/e/' + slug + '/print/' + encodeURIComponent(file)) + '",{method:"POST"}).then(function(r){return r.json()}).then(function(j){' +
    'if(j.ok){sessionStorage.setItem(k,"1");b.textContent=j.done?"Already printed \u2713":"Requested \u2713"}else{b.disabled=false;b.textContent=j.error==="rate"?"Please wait a little, then try again":j.error==="off"?"Print requests are off":"Could not send. Try again"}' +
    '}).catch(function(){b.disabled=false;b.textContent="Could not send. Try again"})})})()</script>';
}
function handlePrintReq(req, res, pm, only) {
  if (req.method !== 'POST') return send(res, 405, 'application/json', JSON.stringify({ ok: false, error: 'Method not allowed' }));
  const fail = (code, error) => send(res, code, 'application/json', JSON.stringify({ ok: false, error }));
  if (!guestPrintOn) return fail(403, 'off');
  let file; try { file = decodeURIComponent(pm[2]); } catch { file = ''; }
  if (only && !only.includes(file)) return fail(404, 'photo');       // a guest's own page: only that guest's files
  const dir = dirOf(pm[1]);
  if (!dir || !existsSync(dir)) return fail(404, 'event');
  if (!file || file !== basename(file) || file.startsWith('.') || !/\.(jpe?g|png|webp)$/i.test(file) || !existsSync(join(dir, file))) return fail(404, 'photo');
  const key = pm[1] + '/' + file;
  if (printReqs.some((r) => r.slug === pm[1] && r.file === file)) return send(res, 200, 'application/json', JSON.stringify({ ok: true, waiting: true }));
  if (askedBefore.has(key)) return send(res, 200, 'application/json', JSON.stringify({ ok: true, done: true }));
  if (printReqs.length >= REQ_MAX) return fail(429, 'busy');
  const who = String((req.socket && req.socket.remoteAddress) || 'x'), now = Date.now();
  const recent = (reqHits.get(who) || []).filter((t) => now - t < REQ_RATE_MS);
  if (recent.length >= REQ_RATE_N) return fail(429, 'rate');
  recent.push(now); reqHits.set(who, recent);
  const ev = index.folders[pm[1]];
  printReqs.push({ id: randomBytes(6).toString('hex'), slug: pm[1], file, event: ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : '', t: now });
  askedBefore.add(key);
  return send(res, 200, 'application/json', JSON.stringify({ ok: true, waiting: true }));
}

// A guest's own page: only the files the booth saved for their session (see noteGuestFile).
function handleOwn(req, res, url, om) {
  const code = om[1], c = codes[code];
  if (!c) {
    if (om[2]) return send(res, 404, om[2] === 'print' ? 'application/json' : 'text/plain', om[2] === 'print' ? JSON.stringify({ ok: false, error: 'photo' }) : 'Not found');
    // Not saved yet (or not a code of ours): the page checks again by itself, and says nothing about which codes exist.
    return send(res, 200, 'text/html; charset=utf-8', page('Your photos', '<div class="one"><h1>Your photos are on their way</h1><p class="sub">They appear here in a few seconds. You can keep this page open.</p></div><script>setTimeout(function(){location.reload()},4000)</script>'));
  }
  const dir = dirOf(c.slug);
  if (!dir || !existsSync(dir)) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This event isn’t on this booth anymore.</p>'));
  if (om[2] === 'print') return handlePrintReq(req, res, [null, c.slug, om[3]], c.files);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  if (om[2] === 'f') {
    let file; try { file = decodeURIComponent(om[3]); } catch { file = ''; }
    if (!c.files.includes(file) || !existsSync(join(dir, file))) return send(res, 404, 'text/plain', 'Not found');
    const extra = {};
    if (url.searchParams.get('dl')) extra['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
    return serveFile(req, res, join(dir, file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream', extra);
  }
  const ev = index.folders[c.slug];
  const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : 'Your photos';
  const mine = c.files.filter((n) => existsSync(join(dir, n)));
  const items = mine.map((file, i) => {
    const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    const isGif = /\.gif$/i.test(file), isVid = VIDEO_RE.test(file);
    const src = '/o/' + code + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : 'Your photo') + '">';
    const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : 'Save photo';
    return '<div class="one" style="padding-bottom:6px">' + media + '<div><a class="btn" href="' + src + '?dl=1" download="' + esc(file) + '">' + dlText + '</a>' +
      (guestPrintOn && !isVid && !isGif ? reqButtonHtml(c.slug, file, '/o/' + code + '/print/' + encodeURIComponent(file), String(i)) : '') + '</div></div>';
  });
  const others = guestView !== 'only' ? '<div class="one" style="padding-top:0"><a class="btn alt" href="/e/' + c.slug + '/">Show photos with other guests</a></div>' : '';
  const body = '<div style="text-align:center;padding:0 16px"><h1>Your photos</h1><p class="sub">' + esc(evName) + '</p></div>' +
    (items.length ? items.join('') + savingTip : '<p class="empty">This photo isn’t here yet. Wait a moment and refresh.</p><script>setTimeout(function(){location.reload()},5000)</script>') + others;
  return send(res, 200, 'text/html; charset=utf-8', page('Your photos', body));
}

// The iPad-uses-this-laptop pages (lib/lan.mjs) answer first; they return false for everything else.
let lanHandler = null;
export function setLanHandler(fn) { lanHandler = fn; }

async function handleShare(req, res) {
  if (lanHandler && await lanHandler(req, res)) return;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  const sm = /^\/send\/([A-Za-z0-9]+)(?:\/(upload|file|edited|photos|photo|hello)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
  if (sm) return handleSend(req, res, url, sm);
  const om = /^\/o\/([A-Za-z0-9_-]{16,40})(?:\/(f|print)\/([^/]+))?\/?$/.exec(url.pathname);
  if (om) return handleOwn(req, res, url, om);
  // "Guests see only their own photos": the event pages answer only this laptop itself (the operator), not a guest's phone.
  if (guestView === 'only' && /^\/e\//.test(url.pathname) && !isLocalReq(req)) {
    return send(res, 403, 'text/html; charset=utf-8', page('Private', '<p class="empty">Guests of this event see only their own photos. Scan your own QR code at the booth to open yours.</p>'));
  }
  const prm = /^\/e\/([A-Za-z0-9]{6,20})\/print\/([^/]+)\/?$/.exec(url.pathname);
  if (prm) return handlePrintReq(req, res, prm);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  const m = /^\/e\/([A-Za-z0-9]{6,20})(?:\/(p|f|t)\/([^/]+))?\/?$/.exec(url.pathname);
  if (!m) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This link isn’t on this booth.</p>'));
  const dir = dirOf(m[1]);
  if (!dir || !existsSync(dir)) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This event isn’t on this booth anymore.</p>'));
  const ev = index.folders[m[1]];
  const evName = ev.sub ? ev.name + ' · ' + ev.sub : ev.name;
  if (!m[2]) {
    const list = photosIn(dir);
    const kindOf = (n) => (VIDEO_RE.test(n) ? 'video' : /\.gif$/i.test(n) ? 'gif' : 'photo');
    const videoCount = list.filter(({ n }) => kindOf(n) === 'video').length;
    const gifCount = list.filter(({ n }) => kindOf(n) === 'gif').length;
    const photoCount = list.length - videoCount - gifCount;
    const kinds = [photoCount > 0, gifCount > 0, videoCount > 0].filter(Boolean).length;
    let tabsHtml = '';
    if (kinds > 1) {
      tabsHtml = '<div style="text-align:center"><div class="tabs">' +
        '<button type="button" class="tab active" onclick="setTab(\'all\',this)">All (' + list.length + ')</button>' +
        (photoCount ? '<button type="button" class="tab" onclick="setTab(\'photo\',this)">Photos (' + photoCount + ')</button>' : '') +
        (gifCount ? '<button type="button" class="tab" onclick="setTab(\'gif\',this)">GIFs (' + gifCount + ')</button>' : '') +
        (videoCount ? '<button type="button" class="tab" onclick="setTab(\'video\',this)">Videos (' + videoCount + ')</button>' : '') +
        '</div></div>';
    }
    const countSub = [photoCount && (photoCount + ' photo' + (photoCount === 1 ? '' : 's')), gifCount && (gifCount + ' GIF' + (gifCount === 1 ? '' : 's')), videoCount && (videoCount + ' video' + (videoCount === 1 ? '' : 's'))].filter(Boolean).join(' · ') || '0 photos';
    const tabScript = '<script>function setTab(k,b){document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")});b.classList.add("active");var g=document.querySelector(".grid");if(g)g.className="grid"+(k==="all"?"":" filter-"+k);}</script>';
    const body = '<div style="text-align:center;padding:0 16px"><h1>' + esc(evName) + '</h1><p class="sub">' + countSub + ' · tap one to save it</p></div>' +
      tabsHtml +
      (list.length ? '<div class="grid">' + list.map(({ n }) => {
        const k = kindOf(n);
        const thumb = k === 'video'
          ? '<video preload="metadata" muted playsinline src="/e/' + m[1] + '/f/' + encodeURIComponent(n) + '#t=0.1"></video><span style="position:absolute;right:8px;bottom:8px;width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px">&#9654;</span>'
          : '<img loading="lazy" alt="" src="/e/' + m[1] + '/t/' + encodeURIComponent(n) + '">';
        return '<a href="/e/' + m[1] + '/p/' + encodeURIComponent(n) + '" data-kind="' + k + '" style="position:relative">' + thumb + '</a>';
      }).join('') + '</div>'
        : '<p class="empty">No photos yet. Pull down to refresh after your session.</p>') + tabScript;
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
    const isGif = /\.gif$/i.test(file);
    const isVid = VIDEO_RE.test(file);
    const src = '/e/' + m[1] + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : 'Your photo') + '">';
    const itemTitle = isVid ? 'Your video' : isGif ? 'Your GIF' : 'Your photo';
    const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : 'Save photo';
    const body = '<div class="one"><h1>' + itemTitle + '</h1><p class="sub">' + esc(evName) + '</p>' + media +
      '<div><a class="btn" href="' + src + '?dl=1" download="' + esc(file) + '">' + dlText + '</a>' + (!/^video\//.test(type) && !isGif ? '<button class="btn alt" type="button" onclick="window.print()">Print photo</button>' : '') + (guestPrintOn && !isVid && !isGif ? reqButtonHtml(m[1], file) : '') + '<a class="btn alt" href="/e/' + m[1] + '/">All photos</a></div>' + savingTip + '</div>';
    return send(res, 200, 'text/html; charset=utf-8', page(itemTitle, body));
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
  const extra = {};
  if (url.searchParams.get('dl')) extra['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
  serveFile(req, res, full, type, extra);
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
