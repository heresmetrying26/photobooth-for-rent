// Photos on this laptop + the guests' QR pages.
//
// The booth "uploads" each photo exactly like it uploads to Google Drive on the
// web, but to /local/drive (handled here), which saves it in
//   Pictures/photobooth4u/<event folder>/<n>_<layout>.jpg
// Every event folder gets a random id (slug). Guests' phones on the same Wi-Fi
// open http://<this laptop's address>:47777/e/<slug>/ (all photos) or
// /e/<slug>/p/<file> (one photo). Nothing goes to the internet.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream, createWriteStream, renameSync, copyFileSync, unlinkSync, linkSync, statfsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

let ROOT = null, INDEX_FILE = null, index = { folders: {} }, thumbFn = null, CODES_FILE = null;
export const SHARE_PORTS = [47777, 47778, 47779, 47787, 47797];
let sharePort = 0;

// ---------- stats tracking (views, downloads, shares, captured, rendered) ----------
let STATS_FILE = null;
let stats = { totals: { captured: 0, rendered: 0, views: 0, downloads: 0, shares: 0 }, events: {} };
let statsTimer = null;
function saveStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    try {
      if (!STATS_FILE) return;
      const t = STATS_FILE + '.tmp'; writeFileSync(t, JSON.stringify(stats, null, 1)); renameSync(t, STATS_FILE);
    } catch { /* ignore */ }
  }, 300);
}
export function recordStat(slug, action, file) {
  if (!action) return;
  let a = String(action).toLowerCase();
  if (a === 'share') a = 'shares';
  if (a === 'view') a = 'views';
  if (a === 'download') a = 'downloads';
  if (!stats.totals[a]) stats.totals[a] = 0;
  stats.totals[a]++;
  if (slug) {
    if (!stats.events[slug]) {
      const ev = index.folders && index.folders[slug];
      stats.events[slug] = {
        name: ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : slug,
        captured: 0, rendered: 0, views: 0, downloads: 0, shares: 0,
        byFile: {}
      };
    }
    const e = stats.events[slug];
    if (!e[a]) e[a] = 0;
    e[a]++;
    if (file) {
      if (!e.byFile) e.byFile = {};
      if (!e.byFile[file]) e.byFile[file] = { views: 0, downloads: 0, shares: 0 };
      if (e.byFile[file][a] != null) e.byFile[file][a]++;
    }
  }
  saveStats();
}
export function getStats(slug) {
  if (slug) {
    return stats.events[slug] || { captured: 0, rendered: 0, views: 0, downloads: 0, shares: 0, byFile: {} };
  }
  return stats;
}

export function initPhotos({ root, dataDir, makeThumb }) {
  ROOT = root; INDEX_FILE = join(dataDir, 'folders.json'); thumbFn = makeThumb || null;
  CODES_FILE = join(dataDir, 'guestcodes.json');
  STATS_FILE = join(dataDir, 'spin-stats.json');
  mkdirSync(ROOT, { recursive: true });
  try { index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) || { folders: {} }; } catch { index = { folders: {} }; }
  if (!index.folders) index.folders = {};
  try { codes = JSON.parse(readFileSync(CODES_FILE, 'utf8')) || {}; } catch { codes = {}; }
  try { stats = JSON.parse(readFileSync(STATS_FILE, 'utf8')) || { totals: {}, events: {} }; } catch { stats = { totals: {}, events: {} }; }
  if (!stats.totals) stats.totals = { captured: 0, rendered: 0, views: 0, downloads: 0, shares: 0 };
  if (!stats.events) stats.events = {};
}
export const photosRoot = () => ROOT;
export function setPhotosRoot(dir) { ROOT = dir; mkdirSync(ROOT, { recursive: true }); }
function saveIndex() { const t = INDEX_FILE + '.tmp'; writeFileSync(t, JSON.stringify(index, null, 1)); renameSync(t, INDEX_FILE); }

export function resolveSlug(slug) {
  if (slug && index.folders && index.folders[slug]) return slug;
  const keys = Object.keys((index && index.folders) || {});
  if (!keys.length) return null;
  keys.sort((a, b) => (index.folders[b].at || 0) - (index.folders[a].at || 0));
  return keys[0];
}
export function stationUrl(slug) {
  const b = shareBase(), s = resolveSlug(slug);
  return b && s ? b + '/station/' + s : (b ? b + '/station' : null);
}
export function wallUrl(slug) {
  const b = shareBase(), s = resolveSlug(slug);
  return b && s ? b + '/wall/' + s : (b ? b + '/wall' : null);
}

let wallCue = { action: 'idle', text: '', expiresAt: 0 };
export function setWallCue(action, text = '', durationMs = 4000) {
  wallCue = { action: String(action || 'idle'), text: String(text || ''), expiresAt: Date.now() + Math.max(500, durationMs || 4000) };
}
export function getWallCue() {
  if (wallCue.expiresAt && Date.now() > wallCue.expiresAt) {
    wallCue = { action: 'idle', text: '', expiresAt: 0 };
  }
  return wallCue;
}

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
export function isLocalReq(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  for (const list of Object.values(networkInterfaces())) for (const x of list || []) if (x.address === a) return true;
  return false;
}

export async function driveRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Bad request' };
  const f = folderFor(body.folderKey, body.subfolder);
  const folderUrl = 'pb4u-local:' + f.slug;
  if (body.resolveOnly) return { ok: true, folderUrl, folderName: f.name, nextSessionNumber: nextSession(f.dir), folderPath: f.dir };
  const m = /^[A-Za-z0-9+/=\s]+$/.test(String(body.imageBase64 || '')) ? body.imageBase64 : null;
  if (!m) return { ok: false, error: 'No photo' };
  let name = basename(safeName(body.filename) || ('photo-' + Date.now() + '.jpg'));
  if (!IMG_RE.test(name)) name += '.jpg';
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
      if (/^192\.168\.137\./.test(a.address)) score += 3;
      if (VIRTUAL.test(name)) {
        if (/^bridge100$/i.test(name) || (/^192\.168\.[23]\./.test(a.address) && /^bridge/i.test(name))) score += 5;
        else score -= 10;
      }
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
.btn{display:inline-block;margin:16px 6px 0;padding:14px 22px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:15px;border:0;cursor:pointer;font-family:inherit}
.btn.alt{background:#fff;color:#1C1A1E;border:1.5px solid #E4DCCF}.tip{color:#6B666C;font-size:13px;line-height:1.5;margin:14px auto 0;max-width:420px;text-align:left}.empty{text-align:center;color:#6B666C;padding:40px 16px}
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

const HOLO = String.raw`<script>(function(){
var imgs=[].filter.call(document.querySelectorAll('.one img'),function(i){return /_card(_|\.)/i.test(decodeURIComponent(i.getAttribute('src')||''));});
if(!imgs.length)return;
try{if(window.DeviceOrientationEvent&&DeviceOrientationEvent.requestPermission){document.addEventListener('click',function f(){DeviceOrientationEvent.requestPermission().catch(function(){});document.removeEventListener('click',f);});}}catch(e){}
var cards=imgs.map(function(im){
var w=document.createElement('div');w.style.cssText='position:relative;display:inline-block;perspective:900px;line-height:0';
im.parentNode.insertBefore(w,im);w.appendChild(im);
var s=document.createElement('div');s.style.cssText='position:absolute;inset:0;pointer-events:none;border-radius:12px;mix-blend-mode:color-dodge;opacity:.5;background:linear-gradient(115deg,transparent 18%,rgba(255,90,170,.65) 34%,rgba(255,220,80,.65) 44%,rgba(90,255,180,.65) 54%,rgba(80,170,255,.65) 64%,transparent 80%);background-size:260% 260%';
w.appendChild(s);return {w:w,s:s,im:im};});
var last=0;
function clamp(v){return Math.max(-1,Math.min(1,v));}
function apply(c,nx,ny){var t='rotateY('+(nx*14)+'deg) rotateX('+(-ny*14)+'deg)';c.im.style.transform=t;c.s.style.transform=t;c.s.backgroundPosition=(50+nx*45)+'% '+(50+ny*45)+'%';}
cards.forEach(function(c){c.w.addEventListener('pointermove',function(e){var r=c.w.getBoundingClientRect();last=performance.now();apply(c,clamp((e.clientX-r.left-r.width/2)/(r.width/2)),clamp((e.clientY-r.top-r.height/2)/(r.height/2)));});});
window.addEventListener('deviceorientation',function(e){if(e.gamma==null)return;last=performance.now();cards.forEach(function(c){apply(c,clamp(e.gamma/25),clamp(((e.beta||0)-50)/25));});});
(function loop(n){if(n-last>1800)cards.forEach(function(c){apply(c,Math.sin(n/900)*.6,Math.cos(n/1300)*.3);});requestAnimationFrame(loop);})(0);
})();</script>`;
const holoFor = (names) => (names || []).some((n) => /_card(_|\.)/i.test(n)) ? HOLO : '';

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

let spinDir = null;
const spinToken = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
const SPIN_MAX = 1024 * 1024 * 1024;
export function setSpinDir(dir) { spinDir = dir || null; }
export function spinDirNow() {
  const d = spinDir || (ROOT ? join(ROOT, '360 inbox') : null);
  if (d) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
  return d;
}
export function spinSendUrl() { const b = shareBase(); return b ? b + '/send/' + spinToken : null; }
export function spinPreviewBase() { return sharePort ? 'http://127.0.0.1:' + sharePort + '/send/' + spinToken : null; }
export const spinEditedDir = () => { const d = spinDirNow(); return d ? join(d, 'edited') : null; };
export function spinList(opts = {}) {
  const d = spinDirNow(); if (!d) return [];
  let names = []; try { names = readdirSync(d); } catch { return []; }
  const now = Date.now();
  const minAgeMs = typeof opts.minAgeMs === 'number' ? opts.minAgeMs : 600;
  const minSize = typeof opts.minSize === 'number' ? opts.minSize : 10240; // 10KB minimum
  return names
    .filter((n) => VIDEO_RE.test(n) && !n.startsWith('.') && !/\.(tmp|part|crdownload)$/i.test(n))
    .map((n) => {
      try {
        const st = statSync(join(d, n));
        if (!st.isFile()) return null;
        // Smart Inbox Watcher: ignore empty and actively writing files from slow transfers
        if (!opts.includePending) {
          if (st.size < minSize) return null;
          if (now - st.mtimeMs < minAgeMs) return null;
        }
        return { name: n, size: st.size, mtime: st.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 300);
}
export function spinShare(name, folderKey, subfolder, outName) {
  const rel = String(name || '');
  const d = /^edited\//.test(rel) ? spinEditedDir() : spinDirNow();
  const n = basename(rel);
  if (!d || !VIDEO_RE.test(n)) return { ok: false, error: 'No video' };
  const src = join(d, n);
  if (!existsSync(src)) return { ok: false, error: 'That video is no longer in the inbox' };
  const f = folderFor(folderKey, subfolder);
  let base = basename(safeName(outName) || n); if (!VIDEO_RE.test(base)) base += (/\.[a-z0-9]+$/i.exec(n) || ['.mp4'])[0].toLowerCase();
  let out = base, i = 2;
  while (existsSync(join(f.dir, out))) { out = base.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  try {
    linkSync(src, join(f.dir, out));
  } catch {
    copyFileSync(src, join(f.dir, out));
  }
  recordStat(f.slug, 'rendered', out);
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
  if (!ROVE_RE.test(name)) name = name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.jpg';
  name = Date.now().toString(36) + '_' + name;
  const len = Number(req.headers['content-length'] || 0);
  if (len > ROVE_MAX) return send(res, 413, 'application/json', JSON.stringify({ ok: false, error: 'Too big' }), cors);
  let out = name, i = 2; while (existsSync(join(d, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  const part = join(d, '.' + out + '.part');
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

function sweepPartFiles(dir) {
  if (!dir || !existsSync(dir)) return;
  try {
    const now = Date.now();
    for (const n of readdirSync(dir)) {
      if (n.startsWith('.') && n.endsWith('.part')) {
        const full = join(dir, n);
        try {
          const st = statSync(full);
          if (now - st.mtimeMs > 10 * 60 * 1000) unlinkSync(full);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function handleSend(req, res, url, sm) {
  const cors = { 'access-control-allow-origin': '*' };
  if (sm[1] !== spinToken) return send(res, 404, 'text/plain', 'Not found');
  if (sm[2] === 'photos') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'text/html; charset=utf-8', ROVE_PAGE);
  }
  if (sm[2] === 'photo') return handleRovePhoto(req, res, url);
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
  try {
    const st = statfsSync(d);
    if (st && st.bavail && st.bsize && (st.bavail * st.bsize < 100 * 1024 * 1024)) {
      return send(res, 507, 'application/json', JSON.stringify({ ok: false, error: 'Insufficient disk space on booth station' }), cors);
    }
  } catch { /* ignore */ }
  sweepPartFiles(d);
  const want = safeName(url.searchParams.get('name')) || ('clip-' + Date.now() + '.mp4');
  let name = basename(want); if (!VIDEO_RE.test(name)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'Only video files' }), cors);
  const len = Number(req.headers['content-length'] || 0);
  if (len > SPIN_MAX) return send(res, 413, 'application/json', JSON.stringify({ ok: false, error: 'Too big' }), cors);
  let out = name, i = 2;
  while (existsSync(join(d, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  const part = join(d, '.' + out + '.part');
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
    recordStat(null, 'captured', out);
    send(res, 200, 'application/json', JSON.stringify({ ok: true, name: out }), cors);
  });
  req.pipe(ws);
}

let guestPrintOn = false;
const printReqs = [];
const askedBefore = new Set();
const reqHits = new Map();
const REQ_MAX = 200, REQ_RATE_N = 8, REQ_RATE_MS = 10 * 60000;
export function setGuestPrint(on) { guestPrintOn = !!on; return guestPrintOn; }
export const guestPrintNow = () => guestPrintOn;
export const printReqList = () => printReqs.map((r) => ({ ...r }));
export function printReqDone(id) { const i = printReqs.findIndex((r) => r.id === String(id)); if (i >= 0) printReqs.splice(i, 1); return i >= 0; }
export function printReqRead(id) {
  const r = printReqs.find((x) => x.id === String(id)); if (!r) return null;
  const dir = dirOf(r.slug); if (!dir) return null;
  try { return readFileSync(join(dir, r.file)); } catch { return null; }
}

const printNowJobs = new Map();
const PRINTNOW_MAX = 20, PRINTNOW_KEEP_MS = 120000;
export function printNowTake() {
  const out = [];
  for (const [id, j] of printNowJobs) {
    if (Date.now() - j.t > PRINTNOW_KEEP_MS) { printNowJobs.delete(id); continue; }
    if (j.state !== 'wait') continue;
    const dir = dirOf(j.slug); let bytes = null;
    try { bytes = dir ? readFileSync(join(dir, j.file)) : null; } catch { /* gone */ }
    if (!bytes) { j.state = 'fail'; j.msg = 'That photo is no longer on this laptop.'; continue; }
    j.state = 'taken'; out.push({ id, file: j.file, bytes });
  }
  return out;
}
export function printNowDone(id, ok, msg) {
  const j = printNowJobs.get(String(id)); if (!j) return false;
  j.state = ok ? 'ok' : 'fail'; j.msg = String(msg || '').slice(0, 200);
  return true;
}
function handlePrintNow(req, res, pm) {
  const reply = (code, o) => send(res, code, 'application/json', JSON.stringify(o));
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!isLocalReq(req)) return reply(403, { ok: false, error: 'Only the booth laptop can print from here.' });
  let file; try { file = decodeURIComponent(pm[2]); } catch { file = ''; }
  const dir = dirOf(pm[1]);
  if (!dir || !file || file !== basename(file) || file.startsWith('.') || !/\.(jpe?g|png|webp)$/i.test(file) || !existsSync(join(dir, file))) return reply(404, { ok: false, error: 'Photo not found' });
  let live = 0; for (const j of printNowJobs.values()) if (j.state === 'wait' || j.state === 'taken') live++;
  if (live >= PRINTNOW_MAX) return reply(429, { ok: false, error: 'The booth is busy printing. Try again in a moment.' });
  const id = randomBytes(6).toString('hex');
  printNowJobs.set(id, { slug: pm[1], file, state: 'wait', msg: '', t: Date.now() });
  return reply(200, { ok: true, id });
}
function handlePrintNowStatus(req, res, pm) {
  const reply = (code, o) => send(res, code, 'application/json', JSON.stringify(o));
  if (!isLocalReq(req)) return reply(403, { ok: false });
  const j = printNowJobs.get(pm[1]);
  return j ? reply(200, { ok: true, state: j.state, msg: j.msg }) : reply(404, { ok: false, state: 'gone' });
}
function opPrintButtonHtml(slug, file) {
  return '<button class="btn alt" id="opPrint" type="button">Print photo</button>' +
    '<script>(function(){var b=document.getElementById("opPrint");' +
    'function end(m,ok){b.textContent=m;setTimeout(function(){b.disabled=false;b.textContent="Print photo"},ok?2500:4500)}' +
    'b.addEventListener("click",function(){b.disabled=true;b.textContent="Sending…";' +
    'fetch("/e/' + slug + '/printnow/' + encodeURIComponent(file) + '",{method:"POST"}).then(function(r){return r.json()}).then(function(j){' +
    'if(!j.ok){end(j.error||"Could not print",0);return}' +
    'var n=0;(function poll(){fetch("/printnow/"+j.id).then(function(r){return r.json()}).then(function(s){' +
    'if(s.state==="ok")return end("Printing ✓",1);if(s.state==="fail")return end(s.msg||"Could not print",0);' +
    'if(++n>40)return end("The booth did not answer",0);setTimeout(poll,700)}).catch(function(){end("Could not print",0)})})()' +
    '}).catch(function(){end("Could not print",0)})})})()</script>';
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
  if (only && !only.includes(file)) return fail(404, 'photo');
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

function handleOwn(req, res, url, om) {
  const code = om[1], c = codes[code];
  if (!c) {
    if (om[2]) return send(res, 404, om[2] === 'print' ? 'application/json' : 'text/plain', om[2] === 'print' ? JSON.stringify({ ok: false, error: 'photo' }) : 'Not found');
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
    if (url.searchParams.get('dl')) {
      recordStat(c.slug, 'downloads', file);
      extra['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
    }
    return serveFile(req, res, join(dir, file), TYPES[extname(file).toLowerCase()] || 'application/octet-stream', extra);
  }
  const ev = index.folders[c.slug];
  const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : 'Your photos';
  const mine = c.files.filter((n) => existsSync(join(dir, n)));
  mine.forEach((f) => recordStat(c.slug, 'views', f));
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
    (items.length ? items.join('') + savingTipHtml(null, null, evName) : '<p class="empty">This photo isn’t here yet. Wait a moment and refresh.</p><script>setTimeout(function(){location.reload()},5000)</script>') + others;
  return send(res, 200, 'text/html; charset=utf-8', page('Your photos', body + holoFor(mine)));
}

// ---------- dual online / offline saving tips & share script ----------
function savingTipHtml(slug, file, evName) {
  return '<div class="tip" id="iosTip" style="display:none"><b>How to save on iPhone / iPad:</b><br>1. Tap <b>Save video</b> (or <b>Save photo</b>).<br>2. Tap the blue download arrow ⬇️ in Safari’s address bar, then tap the clip.<br>3. Tap the Share icon (square with arrow) &gt; <b>Save Video</b> to keep it in your Photos app.</div>' +
    '<div class="tip" id="androidTip" style="display:none"><b>How to save on Android:</b><br>Tap <b>Save video</b> (or <b>Save photo</b>). It saves directly to your Downloads and shows in Google Photos or Gallery.</div>' +
    '<div class="tip" id="genTip">Tap <b>Save video</b> (or <b>Save photo</b>) to download directly to your device.</div>' +
    '<script>(function(){' +
    'var isIos=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;' +
    'var isAndroid=/Android/.test(navigator.userAgent);' +
    'var it=document.getElementById("iosTip"),at=document.getElementById("androidTip"),gt=document.getElementById("genTip");' +
    'if(isIos&&it){it.style.display="block";if(gt)gt.style.display="none"}' +
    'else if(isAndroid&&at){at.style.display="block";if(gt)gt.style.display="none"}' +
    '})()</script>';
}

function guestButtonsHtml(slug, file, isVid, isGif, type, req) {
  const src = '/e/' + slug + '/f/' + encodeURIComponent(file);
  const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : 'Save photo';
  const printPart = (!/^video\//.test(type) && !isGif ? (isLocalReq(req) ? opPrintButtonHtml(slug, file) : '<button class="btn alt" type="button" onclick="window.print()">Print photo</button>') : '');
  const reqPart = (guestPrintOn && !isVid && !isGif ? reqButtonHtml(slug, file) : '');
  return '<div>' +
    '<button class="btn" id="btnShare" type="button" style="display:none">Share / AirDrop ↗</button>' +
    '<a class="btn" id="btnDl" href="' + src + '?dl=1" download="' + esc(file) + '">' + dlText + '</a>' +
    '<button class="btn alt" id="btnCopy" type="button">Copy link 📋</button>' +
    printPart + reqPart +
    '<a class="btn alt" href="/e/' + slug + '/">All photos</a>' +
    '</div>' +
    savingTipHtml(slug, file) +
    '<script>(function(){' +
    'var slug=' + JSON.stringify(slug) + ',file=' + JSON.stringify(file) + ';' +
    'function track(act){try{if(navigator.sendBeacon)navigator.sendBeacon("/e/"+slug+"/track",JSON.stringify({action:act,file:file}));else fetch("/e/"+slug+"/track",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:act,file:file})}).catch(function(){})}catch(e){}}' +
    'var bDl=document.getElementById("btnDl");if(bDl)bDl.addEventListener("click",function(){track("download")});' +
    'var bSh=document.getElementById("btnShare"),bCp=document.getElementById("btnCopy");' +
    'var canNative=!!(navigator.share&&window.isSecureContext);' +
    'if(canNative&&bSh){bSh.style.display="inline-block";bSh.addEventListener("click",function(){navigator.share({title:document.title,url:location.href}).then(function(){track("share")}).catch(function(){})})}' +
    'if(bCp){bCp.addEventListener("click",function(){var u=location.href.split("?")[0];function ok(){bCp.textContent="Copied ✓";track("share");setTimeout(function(){bCp.textContent="Copy link 📋"},2500)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(ok).catch(fb)}else{fb()}function fb(){var ta=document.createElement("textarea");ta.value=u;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");ok()}catch(e){}document.body.removeChild(ta)}})}' +
    '})()</script>';
}

// ---------- 4.1 Sharing Station Page HTML ----------
function stationHtml(slug, evName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${esc(evName)} - Sharing Station</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#0F0E13;color:#F0EEF5;min-height:100vh;-webkit-tap-highlight-color:transparent}
header{padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(15,14,19,0.94);backdrop-filter:blur(10px);position:sticky;top:0;z-index:20}
.brand{font-size:14px;font-weight:800;letter-spacing:-.01em;color:#fff;display:flex;align-items:center;gap:6px}
.brand-dot{width:10px;height:10px;background:#C93D27;border-radius:2px}
.title-wrap{text-align:center;flex:1;padding:0 12px}
h1{margin:0;font-size:19px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(201,61,39,0.18);color:#FF6B55;font-size:11px;font-weight:800;padding:2px 8px;border-radius:10px;margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.stat{display:flex;align-items:center;gap:8px;font-size:13px;color:#A49FA9;font-weight:600}
.pulse{width:8px;height:8px;background:#2EA66B;border-radius:50%;box-shadow:0 0 8px #2EA66B;animation:pbPulse 2s infinite}
@keyframes pbPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.85)}}

.controls{display:flex;align-items:center;justify-content:center;padding:12px 16px 4px}
.tabs{display:inline-flex;background:rgba(255,255,255,0.06);border-radius:20px;padding:3px;gap:2px}
.tab{background:transparent;border:0;border-radius:18px;padding:6px 16px;font-size:13px;font-weight:700;color:#A49FA9;cursor:pointer}
.tab.active{background:#fff;color:#0F0E13;box-shadow:0 2px 8px rgba(0,0,0,0.3)}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;padding:16px 20px 60px;max-width:1300px;margin:0 auto}
.card{background:rgba(255,255,255,0.05);border-radius:14px;overflow:hidden;aspect-ratio:9/16;position:relative;cursor:pointer;border:1px solid rgba(255,255,255,0.08);transition:transform .15s}
.card:active{transform:scale(0.97)}
.card img,.card video{width:100%;height:100%;object-fit:cover;display:block}
.card .play-pill{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);color:#fff;border-radius:18px;padding:4px 10px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px}
.card .time{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);color:#eee;border-radius:6px;padding:3px 7px;font-size:10px;font-weight:600}
.empty{text-align:center;color:#8E8994;padding:80px 20px;font-size:15px;grid-column:1/-1}

.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px;opacity:0;pointer-events:none;transition:opacity .2s}
.modal-overlay.open{opacity:1;pointer-events:auto}
.modal{background:#18161D;border:1px solid rgba(255,255,255,0.12);border-radius:24px;width:100%;max-width:920px;max-height:92vh;display:flex;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,0.7);position:relative}
.modal-media{flex:1.2;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;min-height:360px}
.modal-media video,.modal-media img{max-width:100%;max-height:86vh;object-fit:contain}
.modal-share{flex:1;padding:32px 28px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:#18161D;border-left:1px solid rgba(255,255,255,0.08)}
.modal-share h2{margin:0 0 6px;font-size:24px;font-weight:800;letter-spacing:-.02em}
.modal-share p{color:#A49FA9;font-size:13px;line-height:1.45;margin:0 0 20px;max-width:280px}
.qr-frame{background:#fff;padding:14px;border-radius:18px;box-shadow:0 12px 36px rgba(0,0,0,0.4);display:inline-block;margin-bottom:20px}
.qr-frame img{display:block;width:200px;height:200px}
.btn{display:inline-block;padding:13px 24px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;text-decoration:none;font-size:14px;border:0;cursor:pointer;width:100%;max-width:260px;margin-bottom:8px;text-align:center;font-family:inherit}
.btn.alt{background:rgba(255,255,255,0.08);color:#fff}
.timer-bar{width:100%;max-width:260px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin-top:16px}
.timer-bar i{display:block;height:100%;width:100%;background:#C93D27;transition:width .2s linear}
.timer-text{font-size:11px;color:#7A7580;margin-top:6px}
.close-btn{position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.1);border:0;color:#fff;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:10}

@media (max-width:768px){
  .modal{flex-direction:column;max-height:96vh;overflow-y:auto}
  .modal-share{border-left:0;border-top:1px solid rgba(255,255,255,0.08);padding:20px 16px}
  .modal-media{min-height:240px;max-height:45vh}
  .qr-frame img{width:160px;height:160px}
}
</style>
<script src="/qr.js"></script>
</head>
<body>
<header>
  <div class="brand"><div class="brand-dot"></div>photobooth4u</div>
  <div class="title-wrap">
    <h1>${esc(evName)}</h1>
    <div class="badge">📱 Sharing Station</div>
  </div>
  <div class="stat"><span class="pulse"></span><span id="stCount">0 clips</span></div>
</header>

<div class="controls">
  <div class="tabs">
    <button type="button" class="tab active" data-filter="all">All</button>
    <button type="button" class="tab" data-filter="video">360 Videos</button>
    <button type="button" class="tab" data-filter="photo">Photos</button>
  </div>
</div>

<div class="grid" id="stGrid"><div class="empty">Loading clips…</div></div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button type="button" class="close-btn" id="mClose">✕</button>
    <div class="modal-media" id="mMedia"></div>
    <div class="modal-share">
      <h2>Scan to save</h2>
      <p>Point your phone’s camera at the QR code to open and save your video.</p>
      <div class="qr-frame"><img id="mQr" alt="QR Code"></div>
      <a class="btn" id="mDl" download>Save Video</a>
      <button type="button" class="btn alt" id="mDone">Done (Next guest)</button>
      <div class="timer-bar"><i id="mBar"></i></div>
      <div class="timer-text">Auto-closing in <span id="mSec">35</span>s</div>
    </div>
  </div>
</div>

<script>
var SLUG = ${JSON.stringify(slug)};
var files = [], currentFilter = 'all', activeItem = null, timerId = null, timeLeft = 35;

function timeAgo(mtime) {
  var s = Math.floor((Date.now() - mtime) / 1000);
  if (s < 60) return 'Just now';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  return h + 'h ago';
}

function makeQr(url) {
  try {
    var q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    return q.createDataURL(6, 2);
  } catch(e) {
    return '';
  }
}

function render() {
  var g = document.getElementById('stGrid');
  var list = files.filter(function(f){ return currentFilter === 'all' || f.kind === currentFilter; });
  if (!list.length) {
    g.innerHTML = '<div class="empty">No ' + (currentFilter === 'all' ? 'clips' : currentFilter + 's') + ' yet. Take a spin on the booth to get started!</div>';
    return;
  }
  g.innerHTML = list.map(function(f){
    var isVid = f.kind === 'video';
    var thumb = isVid
      ? '<video src="' + f.url + '#t=0.1" preload="metadata" muted playsinline></video><div class="play-pill"><i>▶</i> 360</div>'
      : '<img src="' + f.thumbUrl + '" loading="lazy" alt="">';
    return '<div class="card" data-name="' + f.name + '">' + thumb + '<div class="time">' + timeAgo(f.mtime) + '</div></div>';
  }).join('');

  g.querySelectorAll('.card').forEach(function(card){
    card.addEventListener('click', function(){
      var it = files.find(function(x){ return x.name === card.dataset.name; });
      if (it) openModal(it);
    });
  });
}

function openModal(it) {
  activeItem = it;
  var m = document.getElementById('modal');
  var med = document.getElementById('mMedia');
  var qr = document.getElementById('mQr');
  var dl = document.getElementById('mDl');
  var pageUrl = location.origin + it.pageUrl;
  
  if (it.kind === 'video') {
    med.innerHTML = '<video src="' + it.url + '" controls autoplay loop playsinline></video>';
    dl.textContent = 'Save Video';
  } else {
    med.innerHTML = '<img src="' + it.url + '" alt="">';
    dl.textContent = 'Save Photo';
  }
  dl.href = it.url + '?dl=1';
  dl.setAttribute('download', it.name);
  qr.src = makeQr(pageUrl);
  
  m.classList.add('open');
  resetTimer();
}

function closeModal() {
  var m = document.getElementById('modal');
  m.classList.remove('open');
  var med = document.getElementById('mMedia');
  med.innerHTML = '';
  activeItem = null;
  clearInterval(timerId);
}

function resetTimer() {
  clearInterval(timerId);
  timeLeft = 35;
  var bar = document.getElementById('mBar');
  var sec = document.getElementById('mSec');
  bar.style.width = '100%';
  sec.textContent = '35';
  timerId = setInterval(function(){
    timeLeft--;
    sec.textContent = String(timeLeft);
    bar.style.width = Math.round((timeLeft / 35) * 100) + '%';
    if (timeLeft <= 0) {
      clearInterval(timerId);
      closeModal();
    }
  }, 1000);
}

document.getElementById('mClose').addEventListener('click', closeModal);
document.getElementById('mDone').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', function(e){
  if (e.target === this) closeModal();
});
document.getElementById('modal').addEventListener('touchstart', resetTimer, { passive: true });

document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active'); });
    t.classList.add('active');
    currentFilter = t.dataset.filter;
    render();
  });
});

async function poll() {
  try {
    var r = await fetch('/station/' + SLUG + '/list');
    var j = await r.json();
    if (j && j.ok && Array.isArray(j.files)) {
      var changed = j.files.length !== files.length || (j.files[0] && files[0] && j.files[0].name !== files[0].name);
      files = j.files;
      document.getElementById('stCount').textContent = files.length + (files.length === 1 ? ' clip' : ' clips');
      if (changed && !activeItem) render();
    }
  } catch(e) {}
}

poll();
setInterval(poll, 3500);
</script>
</body>
</html>`;
}

// ---------- 4.2 Live Wall Page HTML ----------
function wallHtml(slug, evName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(evName)} - 360 Live Wall</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#080709;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;height:100vh;overflow:hidden;display:flex;align-items:center;justify-content:center;user-select:none}
#wallVid{max-width:96vw;max-height:94vh;object-fit:contain;border-radius:14px;box-shadow:0 30px 100px rgba(0,0,0,0.9);opacity:0;transition:opacity .4s ease}
#wallVid.visible{opacity:1}
.top-bar{position:fixed;top:20px;left:24px;right:24px;display:flex;align-items:center;justify-content:space-between;z-index:20;pointer-events:none;transition:opacity .6s ease}
.top-bar.faded{opacity:0}
.wall-title{background:rgba(18,16,22,0.75);backdrop-filter:blur(12px);padding:8px 18px;border-radius:30px;font-size:15px;font-weight:800;border:1px solid rgba(255,255,255,0.1);letter-spacing:-.01em}
.wall-title span{color:#FF6B55;margin-left:6px;font-size:12px;font-weight:700;text-transform:uppercase}
.wall-acts{display:flex;gap:10px;pointer-events:auto}
.act-btn{background:rgba(18,16,22,0.75);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer}

.qr-card{position:fixed;bottom:24px;right:24px;background:rgba(18,16,22,0.85);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.12);padding:12px 14px;border-radius:18px;display:flex;align-items:center;gap:12px;box-shadow:0 16px 40px rgba(0,0,0,0.6);z-index:20}
.qr-card img{width:80px;height:80px;border-radius:8px;background:#fff;padding:4px}
.qr-text{text-align:left}
.qr-text b{display:block;font-size:13px;margin-bottom:2px}
.qr-text span{font-size:11px;color:#A49FA9}

.new-badge{position:fixed;top:70px;background:#C93D27;color:#fff;padding:10px 24px;border-radius:30px;font-weight:800;font-size:16px;box-shadow:0 10px 30px rgba(201,61,39,0.5);z-index:30;animation:badgeIn .4s cubic-bezier(0.175,0.885,0.32,1.275);letter-spacing:.02em}
@keyframes badgeIn{from{opacity:0;transform:translateY(-20px) scale(0.9)}to{opacity:1;transform:translateY(0) scale(1)}}

.waiting{text-align:center;color:#8E8994}
.waiting h1{font-size:32px;color:#fff;margin:0 0 10px}

.cue-overlay{position:fixed;inset:0;background:rgba(8,7,9,0.85);backdrop-filter:blur(24px);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:50;transition:opacity .25s ease;pointer-events:none}
.cue-pulse-ring{position:absolute;width:300px;height:300px;border-radius:50%;border:4px solid rgba(255,107,85,0.7);animation:cueRing 1.2s infinite ease-out}
@keyframes cueRing{0%{transform:scale(0.7);opacity:1}100%{transform:scale(1.7);opacity:0}}
.cue-text{font-size:120px;font-weight:900;letter-spacing:-.03em;color:#fff;text-shadow:0 0 50px rgba(255,107,85,0.9),0 10px 40px rgba(0,0,0,0.9);animation:cuePop .35s cubic-bezier(0.175,0.885,0.32,1.275)}
@keyframes cuePop{from{transform:scale(0.5);opacity:0}to{transform:scale(1);opacity:1}}
.cue-sub{font-size:24px;font-weight:800;color:#FF6B55;text-transform:uppercase;letter-spacing:.15em;margin-top:14px;text-shadow:0 2px 12px rgba(0,0,0,0.8)}
.celebrate-glow{box-shadow:0 0 120px rgba(255,107,85,0.85),0 0 60px rgba(255,215,0,0.7) !important;border:3px solid rgba(255,215,0,0.9) !important}
</style>
<script src="/qr.js"></script>
</head>
<body>
<div class="top-bar" id="topBar">
  <div class="wall-title">${esc(evName)} <span>360 Live Wall</span></div>
  <div class="wall-acts">
    <button type="button" class="act-btn" id="muteBtn">🔊 Unmute</button>
    <button type="button" class="act-btn" id="fsBtn">⛶ Fullscreen</button>
  </div>
</div>

<video id="wallVid" autoplay playsinline muted></video>
<div class="waiting" id="waitMsg"><h1>📺 360 Live Wall</h1><p>Waiting for the first 360 spin…<br>Clips will appear here automatically.</p></div>
<div class="new-badge" id="newBadge" style="display:none">✨ New 360 Spin!</div>

<div class="cue-overlay" id="cueOverlay" style="display:none">
  <div class="cue-pulse-ring"></div>
  <div class="cue-text" id="cueText">3</div>
  <div class="cue-sub" id="cueSub">GET READY TO JUMP!</div>
</div>

<div class="qr-card">
  <img id="wallQr" alt="QR Code">
  <div class="qr-text">
    <b>Scan with phone</b>
    <span>View all event clips</span>
  </div>
</div>

<script>
var SLUG = ${JSON.stringify(slug)};
var playlist = [], curIdx = 0, fadeTimer = null, seenNames = new Set();
var vid = document.getElementById('wallVid');
var wait = document.getElementById('waitMsg');
var badge = document.getElementById('newBadge');
var topBar = document.getElementById('topBar');
var muteBtn = document.getElementById('muteBtn');
var cueOverlay = document.getElementById('cueOverlay');
var cueText = document.getElementById('cueText');
var cueSub = document.getElementById('cueSub');

function renderCue(cue) {
  if (!cue || !cue.action || cue.action === 'idle') {
    cueOverlay.style.display = 'none';
    return;
  }
  cueOverlay.style.display = 'flex';
  cueText.textContent = cue.text || '3';
  cueSub.textContent = cue.action === 'recording' ? 'RECORDING 🌀' : (cue.action === 'celebrate' ? 'NEW 360 CLIP READY! 🎉' : 'GET READY! 🚀');
}

function makeQr(url) {
  try {
    var q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    return q.createDataURL(4, 2);
  } catch(e) {
    return '';
  }
}
document.getElementById('wallQr').src = makeQr(location.origin + '/e/' + SLUG + '/');

function playIndex(idx) {
  if (!playlist.length) return;
  curIdx = (idx + playlist.length) % playlist.length;
  var item = playlist[curIdx];
  vid.classList.remove('visible');
  setTimeout(function(){
    vid.src = item.url;
    vid.play().catch(function(){});
    vid.classList.add('visible');
    wait.style.display = 'none';
  }, 200);
}

vid.addEventListener('ended', function(){
  playIndex(curIdx + 1);
});

async function pollFeed() {
  try {
    var r = await fetch('/wall/' + SLUG + '/feed');
    var j = await r.json();
    if (j && j.cue) renderCue(j.cue);
    if (j && j.ok && Array.isArray(j.videos) && j.videos.length > 0) {
      var isFirst = playlist.length === 0;
      var newVideos = j.videos.filter(function(v){ return !seenNames.has(v.name); });
      j.videos.forEach(function(v){ seenNames.add(v.name); });
      playlist = j.videos;
      if (isFirst) {
        playIndex(0);
      } else if (newVideos.length > 0) {
        // A brand new spin arrived: celebrate & play immediately!
        badge.textContent = '✨ New 360 Spin Ready!';
        badge.style.display = 'block';
        vid.classList.add('celebrate-glow');
        setTimeout(function(){
          badge.style.display = 'none';
          vid.classList.remove('celebrate-glow');
        }, 6000);
        curIdx = 0;
        playIndex(0);
      }
    }
  } catch(e) {}
}

async function pollCue() {
  try {
    var r = await fetch('/wall/' + SLUG + '/cue');
    var j = await r.json();
    if (j && j.ok && j.cue) renderCue(j.cue);
  } catch(e) {}
}

function wakeTop() {
  topBar.classList.remove('faded');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(function(){ topBar.classList.add('faded'); }, 3500);
}
window.addEventListener('mousemove', wakeTop);
window.addEventListener('touchstart', wakeTop);
wakeTop();

muteBtn.addEventListener('click', function(){
  vid.muted = !vid.muted;
  muteBtn.textContent = vid.muted ? '🔊 Unmute' : '🔇 Mute';
});

document.getElementById('fsBtn').addEventListener('click', function(){
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function(){});
  else document.exitFullscreen().catch(function(){});
});

window.addEventListener('keydown', function(e){
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function(){});
    else document.exitFullscreen().catch(function(){});
  } else if (e.key === 'm' || e.key === 'M') {
    vid.muted = !vid.muted;
    muteBtn.textContent = vid.muted ? '🔊 Unmute' : '🔇 Mute';
  } else if (e.key === ' ' || e.key === 'ArrowRight') {
    playIndex(curIdx + 1);
  }
});

pollFeed();
setInterval(pollFeed, 3000);
setInterval(pollCue, 700);
</script>
</body>
</html>`;
}

function handleTrack(req, res, url, slug) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}');
      if (j && j.action) recordStat(slug, j.action, j.file);
      send(res, 200, 'application/json', JSON.stringify({ ok: true }), cors);
    } catch {
      send(res, 400, 'application/json', JSON.stringify({ ok: false }), cors);
    }
  });
}

function handleStation(req, res, url, stm) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  const rawSlug = stm[1] || null;
  const slug = resolveSlug(rawSlug);
  const sub = stm[2] || '';
  if (sub === 'stats') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug, stats: getStats(slug) }), cors);
  }
  if (sub === 'list') {
    if (!slug) return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug: null, name: '', files: [] }), cors);
    const dir = dirOf(slug);
    if (!dir || !existsSync(dir)) return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug, name: '', files: [] }), cors);
    const ev = index.folders[slug];
    const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : '360 Booth';
    const list = photosIn(dir);
    const files = list.map(({ n, t }) => ({
      name: n,
      kind: VIDEO_RE.test(n) ? 'video' : /\.gif$/i.test(n) ? 'gif' : 'photo',
      url: '/e/' + slug + '/f/' + encodeURIComponent(n),
      thumbUrl: '/e/' + slug + '/t/' + encodeURIComponent(n),
      pageUrl: '/e/' + slug + '/p/' + encodeURIComponent(n),
      mtime: t
    }));
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug, name: evName, count: files.length, files }), cors);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  if (!slug) {
    return send(res, 200, 'text/html; charset=utf-8', page('Sharing Station', '<div class="one" style="max-width:600px;margin:60px auto;text-align:center"><h1>📱 Sharing Station</h1><p class="sub">Waiting for your first photo or 360 clip…</p><p class="tip">Start a session on the booth laptop or tablet. Once finished, clips will appear here automatically for guests to scan and save.</p></div><script>setTimeout(function(){location.reload()},4000)</script>'));
  }
  const ev = index.folders[slug];
  const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : '360 Booth';
  return send(res, 200, 'text/html; charset=utf-8', stationHtml(slug, evName));
}

function handleWall(req, res, url, wlm) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  const rawSlug = wlm[1] || null;
  const slug = resolveSlug(rawSlug);
  const sub = wlm[2] || '';
  if (sub === 'cue') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, cue: getWallCue() }), cors);
  }
  if (sub === 'feed') {
    if (!slug) return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug: null, name: '', cue: getWallCue(), videos: [] }), cors);
    const dir = dirOf(slug);
    if (!dir || !existsSync(dir)) return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug, name: '', cue: getWallCue(), videos: [] }), cors);
    const ev = index.folders[slug];
    const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : '360 Booth';
    const list = photosIn(dir).filter(({ n }) => VIDEO_RE.test(n));
    const videos = list.map(({ n, t }) => ({
      name: n,
      url: '/e/' + slug + '/f/' + encodeURIComponent(n),
      pageUrl: '/e/' + slug + '/p/' + encodeURIComponent(n),
      mtime: t
    }));
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, slug, name: evName, cue: getWallCue(), count: videos.length, videos }), cors);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  if (!slug) {
    return send(res, 200, 'text/html; charset=utf-8', '<!doctype html><html><head><meta charset="utf-8"><title>Live Wall</title><style>body{background:#0b0a0e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h1>📺 360 Live Wall</h1><p style="color:#aaa">Waiting for the first 360 spin…<br>Clips will play and loop on this screen automatically.</p></div><script>setTimeout(function(){location.reload()},4000)</script></body></html>');
  }
  const ev = index.folders[slug];
  const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : '360 Booth';
  return send(res, 200, 'text/html; charset=utf-8', wallHtml(slug, evName));
}

let lanHandler = null;
export function setLanHandler(fn) { lanHandler = fn; }

async function handleShare(req, res) {
  if (lanHandler && await lanHandler(req, res)) return;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  if (url.pathname === '/qr.js') {
    const qrf = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'qr.js');
    if (existsSync(qrf)) {
      return send(res, 200, 'application/javascript; charset=utf-8', readFileSync(qrf, 'utf8'), { 'cache-control': 'public, max-age=86400' });
    }
  }
  if (url.pathname === '/stats' || url.pathname === '/api/stats') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, stats: getStats() }), { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  }
  const sm = /^\/send\/([A-Za-z0-9]+)(?:\/(upload|file|edited|photos|photo|hello)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
  if (sm) return handleSend(req, res, url, sm);
  const om = /^\/o\/([A-Za-z0-9_-]{16,40})(?:\/(f|print)\/([^/]+))?\/?$/.exec(url.pathname);
  if (om) return handleOwn(req, res, url, om);
  const stm = /^\/station(?:\/([A-Za-z0-9_-]{6,30}))?(?:\/(list|stats))?\/?$/.exec(url.pathname);
  if (stm) return handleStation(req, res, url, stm);
  const wlm = /^\/wall(?:\/([A-Za-z0-9_-]{6,30}))?(?:\/(feed|cue))?\/?$/.exec(url.pathname);
  if (wlm) return handleWall(req, res, url, wlm);
  const trm = /^\/e\/([A-Za-z0-9]{6,20})\/track\/?$/.exec(url.pathname);
  if (trm) return handleTrack(req, res, url, trm[1]);
  const stm2 = /^\/e\/([A-Za-z0-9]{6,20})\/stats\/?$/.exec(url.pathname);
  if (stm2) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, slug: stm2[1], stats: getStats(stm2[1]) }), { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });

  if (guestView === 'only' && /^\/e\//.test(url.pathname) && !isLocalReq(req)) {
    return send(res, 403, 'text/html; charset=utf-8', page('Private', '<p class="empty">Guests of this event see only their own photos. Scan your own QR code at the booth to open yours.</p>'));
  }
  const pnm = /^\/e\/([A-Za-z0-9]{6,20})\/printnow\/([^/]+)\/?$/.exec(url.pathname);
  if (pnm) return handlePrintNow(req, res, pnm);
  const pns = /^\/printnow\/([a-f0-9]{12})\/?$/.exec(url.pathname);
  if (pns) return handlePrintNowStatus(req, res, pns);
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
    if (m[2] === 'p') {
      const isVid = VIDEO_RE.test(file);
      const title = isVid ? 'Your 360 video is on its way' : 'Your photo is on its way';
      const msg = isVid ? 'We’re applying the effects, speed ramps and music. It appears here in a few seconds. You can keep this page open.' : 'This photo isn’t here yet. Wait a moment and refresh.';
      const body = '<div class="one"><h1>' + title + '</h1><p class="sub">' + esc(evName) + '</p>' +
        '<div style="margin:28px auto;width:44px;height:44px;border:4px solid #E4DCCF;border-top-color:#C93D27;border-radius:50%;animation:pbSpin 1s linear infinite"></div>' +
        '<style>@keyframes pbSpin{to{transform:rotate(360deg)}}</style>' +
        '<p class="empty" style="padding:10px 0 20px">' + msg + '</p>' +
        '<a class="btn alt" href="/e/' + m[1] + '/">All photos</a></div>' +
        '<script>setTimeout(function(){location.reload()},3000)</script>';
      return send(res, 200, 'text/html; charset=utf-8', page(title, body), { 'cache-control': 'no-store' });
    }
    return send(res, 404, 'text/plain', 'Not found');
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  if (m[2] === 'p') {
    recordStat(m[1], 'views', file);
    const isGif = /\.gif$/i.test(file);
    const isVid = VIDEO_RE.test(file);
    const src = '/e/' + m[1] + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : 'Your photo') + '">';
    const itemTitle = isVid ? 'Your video' : isGif ? 'Your GIF' : 'Your photo';
    const body = '<div class="one"><h1>' + itemTitle + '</h1><p class="sub">' + esc(evName) + '</p>' + media +
      guestButtonsHtml(m[1], file, isVid, isGif, type, req) + '</div>';
    return send(res, 200, 'text/html; charset=utf-8', page(itemTitle, body + holoFor([file])));
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
  if (url.searchParams.get('dl')) {
    recordStat(m[1], 'downloads', file);
    extra['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
  }
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
