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
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { hotspotInfo } from './hotspot.mjs';
import { attachBridgeUpgrade, handleBridgeHttp } from './guest-bridge.mjs';

const QR_JS_PATH = fileURLToPath(new URL('qr.js', import.meta.url));
let QR_JS_CODE = '';
try {
  QR_JS_CODE = readFileSync(QR_JS_PATH, 'utf8');
} catch (e) {
  console.warn('[photos] Failed to read qr.js:', e.message);
}

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
  loadSpinToken(dataDir);
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
const SUBDIRS = ['Prints', 'Solo Shots', 'GIFs', '360 Videos'];

const GB_ZIP_JS = String.raw`function gbSave(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
}
var gbCRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function gbCrc(u) { var c = 0xFFFFFFFF; for (var i = 0; i < u.length; i++) c = gbCRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function gbBuildZip(entries) {
  var parts = [], central = [], offset = 0, enc = new TextEncoder();
  var d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  entries.forEach(function (e) {
    var name = enc.encode(e.name), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, e.crc, true);
    h.setUint32(18, e.size, true); h.setUint32(22, e.size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, e.blob);
    var c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.size, true); c.setUint32(24, e.size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + e.size;
  });
  var cdSize = central.reduce(function (n, b) { return n + (b.byteLength || b.length); }, 0);
  var end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [end.buffer]), { type: 'application/zip' });
}
// items: [{ name, url }]. A few videos per zip (they are big); the button shows the progress.
var gbBusy = false;
async function gbDownloadAll(items, btn, base) {
  if (gbBusy || !items.length) return;
  gbBusy = true;
  var label = btn.textContent, chunkSize = 3, parts = Math.ceil(items.length / chunkSize), failed = 0;
  btn.disabled = true;
  try {
    for (var p = 0; p < parts; p++) {
      var chunk = items.slice(p * chunkSize, (p + 1) * chunkSize), entries = [];
      for (var i = 0; i < chunk.length; i++) {
        btn.textContent = 'Preparing ' + (p * chunkSize + i + 1) + ' of ' + items.length + '...';
        try {
          var r = await fetch(chunk[i].url); if (!r.ok) throw new Error('HTTP ' + r.status);
          var blob = await r.blob(), u8 = new Uint8Array(await blob.arrayBuffer());
          entries.push({ name: chunk[i].name, blob: blob, size: u8.length, crc: gbCrc(u8) });
        } catch (e) { failed++; }
      }
      if (entries.length) gbSave(gbBuildZip(entries), base + ' - Guestbook' + (parts > 1 ? ' (part ' + (p + 1) + ' of ' + parts + ')' : '') + '.zip');
      if (p < parts - 1) await new Promise(function (r) { setTimeout(r, 800); });
    }
    btn.textContent = failed ? 'Done (' + failed + ' could not load)' : 'Done';
    setTimeout(function () { btn.textContent = label; }, 4000);
  } finally { btn.disabled = false; gbBusy = false; }
}
`;

// A lossless PNG master of a finished picture (<n>_<layout>_master.png): kept in its own "Masters" folder for the operator only.
// "Masters" is deliberately not in SUBDIRS, so the gallery, the guest pages, the station list and the session numbering never see it,
// and findFileInDir will not hand it to any route: nothing about it is ever served over the booth Wi-Fi.
const MASTER_RE = /_master\.png$/i;
function categoryOf(name) {
  const n = String(name || '');
  if (MASTER_RE.test(n)) return 'Masters';
  if (VIDEO_RE.test(n) || /^360_|_360\./i.test(n)) return '360 Videos';
  if (/\.gif$/i.test(n) || /_gif\./i.test(n)) return 'GIFs';
  if (/_solo_\d+/i.test(n) || /_solo\./i.test(n)) return 'Solo Shots';
  return 'Prints';
}

function findFileInDir(dir, name) {
  if (!dir || !name || name !== basename(name) || name.startsWith('.')) return null;
  if (MASTER_RE.test(name)) return null;   // operator-only master copies are never served
  const rootPath = join(dir, name);
  if (existsSync(rootPath)) return rootPath;
  const catPath = join(dir, categoryOf(name), name);
  if (existsSync(catPath)) return catPath;
  for (const sub of SUBDIRS) {
    const p = join(dir, sub, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function photosIn(dir) {
  const files = [];
  const seen = new Set();
  const scan = (d) => {
    let entries = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const n of entries) {
      if (n.startsWith('.') || n === 'done' || n === '.thumbs') continue;
      const full = join(d, n);
      let isD = false;
      try { isD = statSync(full).isDirectory(); } catch { continue; }
      if (isD) {
        if (d === dir && SUBDIRS.includes(n)) scan(full);
      } else if (IMG_RE.test(n)) {
        if (!seen.has(n)) {
          seen.add(n);
          let t = 0;
          try { t = statSync(full).mtimeMs; } catch { }
          files.push({ n, t });
        }
      }
    }
  };
  scan(dir);
  return files.sort((a, b) => b.t - a.t);
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
  let buf = Buffer.isBuffer(body.buffer) ? body.buffer : null;
  if (!buf) {
    const m = /^[A-Za-z0-9+/=\s]+$/.test(String(body.imageBase64 || '')) ? body.imageBase64 : null;
    if (!m) return { ok: false, error: 'No photo' };
    buf = Buffer.from(m, 'base64');
  }
  if (!buf.length) return { ok: false, error: 'No photo' };
  let name = basename(safeName(body.filename) || ('photo-' + Date.now() + '.jpg'));
  if (!IMG_RE.test(name)) name += '.jpg';
  const cat = categoryOf(name);
  const targetDir = join(f.dir, cat);
  mkdirSync(targetDir, { recursive: true });
  let out = name, i = 2;
  while (existsSync(join(targetDir, out)) || existsSync(join(f.dir, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  writeFileSync(join(targetDir, out), buf);
  if (cat !== 'Masters') noteGuestFile(body.guestCode, f.slug, out);   // a master belongs to no guest's page
  return { ok: true, fileId: f.slug + '/' + out, downloadUrl: 'pb4u-local:' + f.slug + '/' + out, folderUrl, folderName: f.name, folderPath: f.dir };
}
export function folderPathOf(folderUrl) {
  const m = /^pb4u-local:([A-Za-z0-9]+)/.exec(String(folderUrl || ''));
  return m ? dirOf(m[1]) : null;
}

const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|docker|br-|veth|utun|awdl|llw|bridge|ZeroTier|Tailscale|Loopback|vboxnet|WSL|WireGuard|NordLynx|OpenVPN|TAP-Windows|CloudflareWARP|ProtonVPN|\bwg\d+\b|\btun\d+\b)/i;
export function lanAddress(nets = networkInterfaces()) {
  const cands = [];
  for (const [name, list] of Object.entries(nets || {})) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (/^169\.254\./.test(a.address)) continue;
      // Dummy loopback subnet created by hotspot.mjs so Windows Mobile Hotspot can start offline.
      // Exclude by IP too in case Rename-NetAdapter failed and Windows left it as "Ethernet 2".
      if (/^10\.254\.254\./.test(a.address)) continue;
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
.grid.filter-photo > [data-kind]:not([data-kind="photo"]){display:none!important}
.grid.filter-solo > [data-kind]:not([data-kind="solo"]){display:none!important}
.grid.filter-gif > [data-kind]:not([data-kind="gif"]){display:none!important}
.grid.filter-video > [data-kind]:not([data-kind="video"]){display:none!important}
.grid.filter-guestbook > [data-kind]:not([data-kind="guestbook"]){display:none!important}
.grid a{position:relative}
.grid [data-kind="guestbook"]::after{content:'MESSAGE';position:absolute;top:6px;left:6px;background:rgba(0,0,0,.75);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:4px;letter-spacing:.5px;pointer-events:none}
.grid [data-kind="gif"]::after{content:'GIF';position:absolute;bottom:6px;right:6px;background:rgba(28,26,30,.8);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:4px;letter-spacing:.5px;pointer-events:none}
.grid [data-kind="solo"]::after{content:'SOLO';position:absolute;bottom:6px;right:6px;background:rgba(201,61,39,.85);color:#fff;font-size:10px;font-weight:800;padding:2px 5px;border-radius:4px;letter-spacing:.5px;pointer-events:none}`;

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
// The tablet / phone remembers "laptop-address/send/<token>". A token made fresh at every start broke that address each time the app
// was reopened, so it is kept in the data folder (loadSpinToken, called from initPhotos) and stays the same.
let spinToken = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
function loadSpinToken(dataDir) {
  try {
    const f = join(dataDir, 'spin-token.txt');
    let t = '';
    try { t = readFileSync(f, 'utf8').trim(); } catch { /* first start */ }
    if (/^[A-Za-z0-9]{8,40}$/.test(t)) { spinToken = t; return; }
    writeFileSync(f, spinToken);
  } catch { /* read-only data folder: keep the one made for this run */ }
}
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
// The name of the look a shared 360 clip was made with, kept beside the event's files (a hidden file, so it is never listed or shared)
// and handed to the Sharing Station, which shows it on the clip.
function readLooks(dir) { try { return JSON.parse(readFileSync(join(dir, '.looks.json'), 'utf8')) || {}; } catch { return {}; } }
function writeLook(dir, file, look) {
  const l = String(look || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  if (!l) return;
  try {
    const all = readLooks(dir); all[file] = l;
    const ks = Object.keys(all); if (ks.length > 600) ks.slice(0, ks.length - 600).forEach((k) => { delete all[k]; });
    writeFileSync(join(dir, '.looks.json'), JSON.stringify(all));
  } catch { /* the clip is shared anyway */ }
}
export function spinShare(name, folderKey, subfolder, outName, look) {
  const rel = String(name || '');
  const d = /^edited\//.test(rel) ? spinEditedDir() : spinDirNow();
  const n = basename(rel);
  if (!d || !(VIDEO_RE.test(n) || /\.gif$/i.test(n))) return { ok: false, error: 'No video' };       // a GIF made from a finished video is shared the same way
  const src = join(d, n);
  if (!existsSync(src)) return { ok: false, error: 'That video is no longer in the inbox' };
  const f = folderFor(folderKey, subfolder);
  let base = basename(safeName(outName) || n); if (!VIDEO_RE.test(base) && !/\.gif$/i.test(base)) base += (/\.[a-z0-9]+$/i.exec(n) || ['.mp4'])[0].toLowerCase();
  let out = base, i = 2;
  while (existsSync(join(f.dir, out))) { out = base.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
  try {
    linkSync(src, join(f.dir, out));
  } catch {
    copyFileSync(src, join(f.dir, out));
  }
  if (!/(\.gif|_square\.mp4)$/i.test(out)) recordStat(f.slug, 'rendered', out);       // the numbers count videos, not their GIFs or square clips
  writeLook(f.dir, out, look);
  return { ok: true, fileId: f.slug + '/' + out, downloadUrl: 'pb4u-local:' + f.slug + '/' + out, folderUrl: 'pb4u-local:' + f.slug, folderName: f.name, folderPath: f.dir };
}
// What the 360 desk's Connect panel shows: when a recorder last said hello, when a recording last started, when a video last arrived.
const conn = { helloAt: 0, recAt: 0, uploadAt: 0 };
export function spinConnectInfo(test) {
  const out = { dir: spinDirNow(), sendUrl: spinSendUrl(), port: sharePort || 0, helloAt: conn.helloAt, recAt: conn.recAt, uploadAt: conn.uploadAt, arm: spinArmStateNow(), now: Date.now() };
  if (test && out.dir) {
    try { const f = join(out.dir, '.pbtest-' + randomBytes(3).toString('hex')); writeFileSync(f, 'ok'); unlinkSync(f); out.writable = true; } catch { out.writable = false; }
    try { const st = statfsSync(out.dir); out.freeMb = Math.round(st.bavail * st.bsize / 1048576); } catch { /* unknown */ }
  }
  return out;
}
// The little picture a phone shows when the send page is saved to the home screen (a red tile with a white ring), made here, so no file is needed.
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const iconCache = new Map();
export function sendIconPng(size) {
  size = [180, 192, 512].includes(size) ? size : 192;
  if (iconCache.has(size)) return iconCache.get(size);
  const raw = Buffer.alloc((size * 4 + 1) * size), cx = size / 2, cy = size / 2;
  const smooth = (d, r) => Math.max(0, Math.min(1, r - d + 0.5));       // one pixel soft edge
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4, d = Math.hypot(x - cx, y - cy);
      const ring = Math.min(smooth(d, size * 0.36), smooth(size * 0.27, d));      // a white ring ...
      const dot = smooth(Math.hypot(x - (cx + size * 0.2), y - (cy - size * 0.2)), size * 0.06);       // ... and a dot on it (the arm)
      const w = Math.max(ring, dot);
      raw[i] = Math.round(201 + (255 - 201) * w); raw[i + 1] = Math.round(61 + (255 - 61) * w); raw[i + 2] = Math.round(39 + (255 - 39) * w); raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  iconCache.set(size, png);
  return png;
}

// Looks a guest may pick from their own phone (the page they sent the video from). The booth page sets the list; the picks wait here
// until the booth page collects them. Nothing from the phone is trusted: the clip must be in the inbox and the look must be on the list.
let lookOffer = { on: false, looks: [] };
const lookPicks = new Map();
const cleanText = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
export function spinLookOfferSet(o) {
  const looks = (Array.isArray(o && o.looks) ? o.looks : []).slice(0, 40).map((l) => ({
    key: cleanText(l && l.key, 80), title: cleanText(l && l.title, 40), icon: cleanText(l && l.icon, 8),
    c1: /^#[0-9a-f]{6}$/i.test(l && l.c1) ? l.c1 : '#2b282c', c2: /^#[0-9a-f]{6}$/i.test(l && l.c2) ? l.c2 : '#8a7f70'
  })).filter((l) => l.key && l.title);
  lookOffer = { on: !!(o && o.on) && looks.length > 0, looks };
  if (!lookOffer.on) lookPicks.clear();
  return lookOffer.on;
}
export function spinLookPicksTake() {
  const out = [...lookPicks.entries()].map(([name, p]) => ({ name, key: p.key, who: p.who }));
  lookPicks.clear();
  return out;
}
export function spinStatsFor(folderKey, subfolder) {
  const f = folderFor(folderKey, subfolder);
  return { event: getStats(f && f.slug), totals: (getStats() || {}).totals || {} };
}
/**
 * Persist a locally captured video buffer (e.g. HDMI capture card / webcam MediaRecorder) into the active 360 inbox folder atomically.
 * @param {{ filename?: string, buffer: Buffer|Uint8Array }} req
 */
export async function spinSaveVideo({ filename, buffer }) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = spinDirNow();
  if (!dir) return { ok: false, error: '360 inbox folder is not set yet.' };
  const buf = Buffer.isBuffer(buffer) ? buffer : (buffer ? Buffer.from(buffer) : null);
  if (!buf || buf.length < 16) return { ok: false, error: 'Recorded video buffer is empty.' };
  await fs.promises.mkdir(dir, { recursive: true });
  const rawName = path.basename(String(filename || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '-');
  const extMatch = rawName.match(/\.(mp4|webm|mov|m4v)$/i);
  const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '.webm';
  const base = (extMatch ? rawName.slice(0, -ext.length) : rawName).replace(/^\.+/, '') || ('capture-360-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17));
  const finalName = base + ext;
  const finalPath = path.join(dir, finalName);
  const partPath = path.join(dir, `.${finalName}.${Date.now()}.part`);
  try {
    await fs.promises.writeFile(partPath, buf);
    await fs.promises.rename(partPath, finalPath);
    return { ok: true, filename: finalName, path: finalPath, bytes: buf.length, dir };
  } catch (e) {
    await fs.promises.unlink(partPath).catch(() => {});
    return { ok: false, error: String((e && e.message) || e) };
  }
}
// ---- Send page v2: what to record, what to offer, how each clip is doing ----
// The desk tells the phone page what to record and which choices to offer. The booth page tells it how each clip is doing.
// What the phone asks for (a choice, a re-edit, a countdown) waits here until the booth page collects it. Nothing from the phone is
// trusted: the clip must be in the inbox, and every choice must be on the list the desk offered.
const SEND_CHOICES = ['look', 'music', 'speed', 'text', 'gif'];
const SEND_ACTS = ['reedit', 'share', 'print', 'delete'];
const SEND_STATES = ['new', 'editing', 'edited', 'sharing', 'ready', 'error'];
const SEND_Q_MAX = 100;
const ARM_TRIGGERS = ['arm', 'manual', 'desk'];
const ARM_STOP_MODES = ['follow', 'fixed'];
const ARM_STATES = ['idle', 'calibrating', 'countdown', 'recording', 'uploading', 'cooldown'];
const ARM_CMDS = ['start', 'stop', 'calibrate'];
const ARM_CMD_TTL = 15000;
const defaultArmCfg = () => ({ trigger: 'arm', stopMode: 'follow', fixedSec: 10, tailSec: 1.5, maxSec: 30, cooldownSec: 4, fps: 60 });
const defaultSendCfg = () => ({ guide: { spinSec: 0, spins: 1, recordSec: 0, trigger: '', note: '' }, choices: { look: false, music: false, speed: false, text: false, gif: false }, music: [], speeds: [], laptop: '', arm: defaultArmCfg() });
let sendCfg = defaultSendCfg();
let clipStatus = [];
let sendQueue = [];
let cmdAt = 0;
let armState = { at: 0, device: '', state: 'idle', gyroDps: 0, thresholdDps: 25, battery: -1, fps: 60, recSec: 0, uploadPct: 0, lens: '' };
let armCmdQueue = [];
let armCmdSeq = 0;
const numIn = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const optList = (a) => (Array.isArray(a) ? a : []).slice(0, 40).map((o) => ({ key: cleanText(o && o.key, 80), title: cleanText(o && o.title, 40) })).filter((o) => o.key && o.title);
export function spinArmStateNow() {
  const now = Date.now();
  return { ...armState, connected: !!(armState.at && now - armState.at < 10000), now };
}
export function spinArmCmdPush(cmd) {
  const c = String(cmd || '').trim();
  if (!ARM_CMDS.includes(c)) return { ok: false, error: 'Invalid command' };
  const now = Date.now();
  armCmdQueue = armCmdQueue.filter((x) => now - x.at <= ARM_CMD_TTL);
  if (armCmdQueue.length >= 20) armCmdQueue.shift();
  const id = ++armCmdSeq;
  armCmdQueue.push({ id, cmd: c, at: now });
  return { ok: true, id };
}
function takeArmCmds() {
  const now = Date.now();
  const out = armCmdQueue.filter((x) => now - x.at <= ARM_CMD_TTL);
  armCmdQueue = [];
  return out;
}
function readSmallJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0, done = false;
    const finish = (o) => { if (done) return; done = true; resolve(o); };
    req.on('data', (c) => {
      len += c.length;
      if (len > 4096) { finish({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = txt ? JSON.parse(txt) : {};
        finish(parsed && typeof parsed === 'object' ? parsed : {});
      } catch { finish({}); }
    });
    req.on('error', () => finish({}));
  });
}
export function spinSendCfgSet(c) {
  const g = (c && c.guide) || {}, ch = (c && c.choices) || {}, a = (c && c.arm) || {};
  sendCfg = {
    guide: { spinSec: numIn(g.spinSec, 0, 120, 0), spins: numIn(g.spins, 0.5, 10, 1), recordSec: numIn(g.recordSec, 0, 600, 0), trigger: cleanText(g.trigger, 80), note: cleanText(g.note, 200) },
    choices: Object.fromEntries(SEND_CHOICES.map((k) => [k, !!ch[k]])),
    music: optList(c && c.music), speeds: optList(c && c.speeds), laptop: cleanText(c && c.laptop, 40),
    arm: {
      trigger: ARM_TRIGGERS.includes(a.trigger) ? a.trigger : 'arm',
      stopMode: ARM_STOP_MODES.includes(a.stopMode) ? a.stopMode : 'follow',
      fixedSec: numIn(a.fixedSec, 3, 60, 10),
      tailSec: numIn(a.tailSec, 0, 10, 1.5),
      maxSec: numIn(a.maxSec, 5, 60, 30),
      cooldownSec: numIn(a.cooldownSec, 1, 20, 4),
      fps: [30, 60, 120].includes(Number(a.fps)) ? Number(a.fps) : 60
    }
  };
  return true;
}
export function spinClipsSet(list) {
  clipStatus = (Array.isArray(list) ? list : []).slice(0, 12).map((x) => ({
    name: cleanText(x && x.name, 120),
    status: SEND_STATES.includes(x && x.status) ? x.status : 'new',
    pct: numIn(x && x.pct, 0, 100, 0),
    url: /^https?:\/\/[^\s<>"']{1,300}$/.test(String((x && x.url) || '')) ? String(x.url) : '',
    look: cleanText(x && x.look, 40)
  })).filter((x) => x.name);
  return clipStatus.length;
}
export const spinSendCfgNow = () => sendCfg;
export const spinClipsNow = () => clipStatus;
export function spinSendTake() { const out = sendQueue; sendQueue = []; return out; }
function sendPush(item) {
  if (item.type === 'choice') sendQueue = sendQueue.filter((q) => !(q.type === 'choice' && q.name === item.name));      // the newest choice for a clip wins
  if (sendQueue.length >= SEND_Q_MAX) sendQueue.shift();
  sendQueue.push({ ...item, at: Date.now() });
}
// The clip a phone names must be a video that is in the inbox right now.
function inboxClip(raw) {
  const dd = spinDirNow(), n = basename(String(raw || ''));
  if (!dd || !n || n.startsWith('.') || !VIDEO_RE.test(n) || !existsSync(join(dd, n))) return '';
  return n;
}
async function handleSendV2(req, res, url, sm) {
  const cors = { 'access-control-allow-origin': '*' };
  const kind = sm[2];
  const isGet = kind === 'config' || kind === 'clips' || kind === 'arm-poll';
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': isGet ? 'GET' : 'POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
  const json = (code, o) => send(res, code, 'application/json', JSON.stringify(o), cors);
  if (kind === 'config') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', cors);
    return json(200, { ok: true, ...sendCfg, lookOffer: lookOffer.looks });
  }
  if (kind === 'clips') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', cors);
    return json(200, { ok: true, clips: clipStatus });
  }
  if (kind === 'arm-poll') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', cors);
    conn.helloAt = Date.now();
    return json(200, { ok: true, cmds: takeArmCmds(), config: sendCfg });
  }
  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
  const q = url.searchParams;
  if (kind === 'arm-state') {
    const b = await readSmallJson(req);
    const val = (k) => (b[k] !== undefined ? b[k] : q.get(k));
    const optNum = (k, lo, hi, d) => { const v = val(k); return v === null || v === undefined || v === '' ? d : numIn(v, lo, hi, d); };
    const prevState = armState.state;
    const rawState = String(val('state') || 'idle');
    const dev = cleanText(val('device'), 50);
    const lns = cleanText(val('lens'), 20);
    armState = {
      at: Date.now(),
      device: dev || armState.device,
      state: ARM_STATES.includes(rawState) ? rawState : 'idle',
      gyroDps: optNum('gyroDps', 0, 2000, 0),
      thresholdDps: optNum('thresholdDps', 5, 300, armState.thresholdDps),
      battery: optNum('battery', -1, 100, -1),
      fps: optNum('fps', 15, 240, armState.fps),
      recSec: optNum('recSec', 0, 600, 0),
      uploadPct: optNum('uploadPct', 0, 100, 0),
      lens: lns || armState.lens
    };
    conn.helloAt = armState.at;
    if (prevState !== 'recording' && armState.state === 'recording') {
      conn.recAt = armState.at;
      setWallCue('recording', '360 SPINNING 🌀', Math.max(4000, Math.round(((sendCfg.arm && sendCfg.arm.maxSec) || 30) * 1000) + 2000));
    } else if (armState.state === 'recording') {
      setWallCue('recording', '360 SPINNING 🌀', Math.max(4000, Math.round(((sendCfg.arm && sendCfg.arm.maxSec) || 30) * 1000) + 2000));
    } else if (prevState === 'recording' && armState.state !== 'recording') {
      setWallCue('idle', '', 0);
    }
    return json(200, { ok: true, cmds: takeArmCmds(), config: sendCfg });
  }
  if (kind === 'cmd') {
    if (q.get('do') !== 'countdown') return json(400, { ok: false });
    const now = Date.now();
    if (now - cmdAt < 2000) return json(429, { ok: false, error: 'Too fast' });
    cmdAt = now; sendPush({ type: 'cmd', do: 'countdown' });
    return json(200, { ok: true });
  }
  const name = inboxClip(q.get('name'));
  if (!name) return json(400, { ok: false, error: 'No such video' });
  if (kind === 'act') {
    const act = String(q.get('do') || '');
    if (!SEND_ACTS.includes(act)) return json(400, { ok: false });
    if (act === 'delete') {
      // Never really deleted: it moves to a "deleted" folder in the inbox.
      try {
        const dd = spinDirNow(), bin = join(dd, 'deleted'); mkdirSync(bin, { recursive: true });
        let out = name, i = 2; while (existsSync(join(bin, out))) { out = name.replace(/(\.[a-z0-9]+)$/i, ' (' + i + ')$1'); i++; }
        renameSync(join(dd, name), join(bin, out));
      } catch { return json(500, { ok: false, error: 'Could not delete' }); }
    }
    sendPush({ type: 'act', name, do: act });
    return json(200, { ok: true });
  }
  if (kind === 'choice') {
    const c = sendCfg.choices, pick = {};
    const look = String(q.get('look') || ''), music = String(q.get('music') || ''), speed = String(q.get('speed') || '');
    if (c.look && look && lookOffer.looks.some((l) => l.key === look)) pick.look = look;
    if (c.music && music && sendCfg.music.some((m) => m.key === music)) pick.music = music;
    if (c.speed && speed && sendCfg.speeds.some((s) => s.key === speed)) pick.speed = speed;
    if (c.text) { const t = cleanText(q.get('text'), 40); if (t) pick.text = t; }
    if (c.gif && q.get('gif') === '1') pick.gif = true;
    if (!Object.keys(pick).length) return json(200, { ok: true, queued: false });
    sendPush({ type: 'choice', name, ...pick });
    return json(200, { ok: true, queued: true });
  }
  return json(400, { ok: false });
}
const SEND_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#C93D27"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="360 Send"><link rel="manifest" href="/send/__T__/manifest"><link rel="apple-touch-icon" href="/send/__T__/icon/180"><title>360 Arm Phone</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1EA;color:#1C1A1E;padding:20px 16px 40px;text-align:center}
h1{font-size:22px;margin:4px 0}p{color:#6B666C;margin:4px 0}
.st{display:inline-block;font-size:13px;font-weight:700;border-radius:99px;padding:3px 12px;background:#E4DCCF;color:#444;margin:6px 0 10px}.st.ok{background:#d6f1e2;color:#16683f}.st.bad{background:#f9d8d2;color:#8e2312}
.card{max-width:420px;margin:10px auto;background:#fff;border-radius:14px;padding:12px 14px;text-align:left;font-size:14px}
.card .h{display:block;margin-bottom:4px;font-weight:800}
label.pick,button.pick{display:block;width:100%;max-width:420px;margin:12px auto;padding:22px 20px;border-radius:18px;background:#C93D27;color:#fff;font-weight:800;font-size:21px;border:0;font-family:inherit;cursor:pointer;box-sizing:border-box}
label.alt{background:#1F3A52}button.ghost{background:#1C1A1E;font-size:16px;padding:14px 20px}button.pick:disabled{opacity:.6}
input[type=file]{display:none}
.row{margin:6px auto;max-width:420px;text-align:left;font-size:14px}
.bar{height:10px;border-radius:6px;background:#E4DCCF;overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;width:0;background:#2EA66B}
.looks{margin-top:10px;padding:10px;border-radius:12px;background:#fff;text-align:center}
.card select,.card input[type=text]{width:100%;box-sizing:border-box;margin:3px 0 8px;padding:10px;border-radius:10px;border:1px solid #ccc;font-size:16px;font-family:inherit;background:#fff}
.chk{display:flex;gap:8px;align-items:center;font-size:15px}
.clip{border-top:1px solid #eee;padding:8px 0}.clip:first-child{border-top:0}
.clip .nm{font-weight:700;font-size:13px;word-break:break-all}.clip .qr{margin:6px 0}.clip .qr img{width:150px;height:150px;image-rendering:pixelated}
.clip button{font:inherit;font-size:13px;font-weight:700;border:1px solid #ccc;background:#fff;border-radius:9px;padding:6px 10px;margin:4px 4px 0 0}
.hint{display:none;margin:20px auto 0;max-width:420px;font-size:13px;color:#6B666C;background:#fff;border-radius:12px;padding:10px 12px;text-align:left}
</style></head><body>
<h1>360 Arm Phone</h1>
<div class="st" id="conn">Connecting to the laptop…</div>
<div class="card" id="guide" hidden></div>
<div class="card" id="choices" hidden></div>
<label class="alt pick" for="r">🎥 Record now</label><input id="r" type="file" accept="video/*" capture="environment">
<label class="pick" for="f">Choose a video</label><input id="f" type="file" accept="video/*" multiple>
<button class="pick ghost" id="cd" type="button">⏱ Start the countdown on the laptop</button>
<div id="list"></div>
<div class="card" id="recent" hidden><b class="h">Recent videos</b><div id="clips"></div></div>
<div id="hint" class="hint"></div>
<script>
var T=location.pathname.replace(/[/]+$/,""),cfg=null,cfgSig="",lastSig="",KEY="pb360send",sel={look:"",music:"",speed:"",text:"",gif:false},qrLoaded=false;
function $(i){return document.getElementById(i)}
function jget(p){return fetch(T+p,{cache:"no-store"}).then(function(r){return r.json()})}
function jpost(p){return fetch(T+p,{method:"POST"}).then(function(r){return r.json().catch(function(){return{}})})}
function esc(t){var d=document.createElement("div");d.textContent=t;return d.innerHTML}
function loadSel(){try{var s=JSON.parse(localStorage.getItem(KEY)||"{}");for(var k in sel)if(s[k]!=null)sel[k]=s[k]}catch(e){}}
function saveSel(){try{localStorage.setItem(KEY,JSON.stringify(sel))}catch(e){}}
function ping(){fetch(T+"/hello?r=1",{cache:"no-store"}).then(function(r){return r.json()}).then(function(){var c=$("conn");c.className="st ok";c.textContent="✓ Connected to "+((cfg&&cfg.laptop)||"the laptop")}).catch(function(){var c=$("conn");c.className="st bad";c.textContent="No connection to the laptop. Are you on the booth Wi-Fi?"})}
function drawGuide(){var g=cfg.guide||{},b=[];if(g.recordSec)b.push("Record about <b>"+g.recordSec+" s</b>.");if(g.spinSec)b.push("The arm turns "+g.spins+" × "+g.spinSec+" s.");if(g.trigger)b.push(esc(g.trigger));if(g.note)b.push(esc(g.note));var el=$("guide");el.hidden=!b.length;el.innerHTML=b.length?"<b class=h>Set on the laptop</b>"+b.join("<br>"):""}
function mkSel(label,list,cur,onch){var l=document.createElement("label");l.textContent=label;var s=document.createElement("select");var o0=document.createElement("option");o0.value="";o0.textContent="Desk's choice";s.appendChild(o0);list.forEach(function(o){var op=document.createElement("option");op.value=o.key;op.textContent=o.title;if(o.key===cur)op.selected=true;s.appendChild(op)});s.onchange=function(){onch(s.value);saveSel()};l.appendChild(s);return l}
function drawChoices(){var c=cfg.choices||{},box=$("choices"),n=0;box.innerHTML="";var h=document.createElement("b");h.className="h";h.textContent="Your choices (optional)";box.appendChild(h);
 if(c.look&&cfg.lookOffer&&cfg.lookOffer.length){n++;box.appendChild(mkSel("Look",cfg.lookOffer.map(function(l){return{key:l.key,title:(l.icon||"")+" "+l.title}}),sel.look,function(v){sel.look=v}))}
 if(c.music&&cfg.music&&cfg.music.length){n++;box.appendChild(mkSel("Music",cfg.music,sel.music,function(v){sel.music=v}))}
 if(c.speed&&cfg.speeds&&cfg.speeds.length){n++;box.appendChild(mkSel("Speed",cfg.speeds,sel.speed,function(v){sel.speed=v}))}
 if(c.text){n++;var l=document.createElement("label");l.textContent="Name on the video";var i=document.createElement("input");i.type="text";i.maxLength=40;i.value=sel.text;i.oninput=function(){sel.text=i.value;saveSel()};l.appendChild(i);box.appendChild(l)}
 if(c.gif){n++;var g=document.createElement("label");g.className="chk";var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!sel.gif;cb.onchange=function(){sel.gif=cb.checked;saveSel()};g.appendChild(cb);g.appendChild(document.createTextNode(" Also make a GIF"));box.appendChild(g)}
 box.hidden=!n}
function loadCfg(){jget("/config").then(function(j){if(!j||!j.ok)return;var s=JSON.stringify(j);if(s===cfgSig)return;cfgSig=s;cfg=j;drawGuide();drawChoices()}).catch(function(){})}
function qrImg(u){try{if(typeof qrcode!=="function"){if(!qrLoaded){qrLoaded=true;var s=document.createElement("script");s.src="/qr.js";s.onload=function(){lastSig="";poll()};document.head.appendChild(s)}return null}var q=qrcode(0,"M");q.addData(u);q.make();var im=new Image();im.src=q.createDataURL(4,2);return im}catch(e){return null}}
var STX={"new":"Waiting…",editing:"Editing…",edited:"Edited",sharing:"Making the link…",ready:"Ready ✓",error:"Problem"};
function poll(){jget("/clips").then(function(j){drawClips(j.clips||[])}).catch(function(){})}
function drawClips(list){var box=$("clips"),card=$("recent");if(!list.length){card.hidden=true;return}card.hidden=false;var sig=JSON.stringify(list);if(sig===lastSig)return;lastSig=sig;box.innerHTML="";
 list.forEach(function(c){var d=document.createElement("div");d.className="clip";var n=document.createElement("div");n.className="nm";n.textContent=c.name;d.appendChild(n);
  var s=document.createElement("div");s.textContent=(STX[c.status]||c.status)+(c.status==="editing"&&c.pct?" "+c.pct+"%":"")+(c.look?" · "+c.look:"");d.appendChild(s);
  if(c.url){var q=document.createElement("div");q.className="qr";var img=qrImg(c.url);if(img)q.appendChild(img);var lk=document.createElement("a");lk.href=c.url;lk.textContent=c.url.replace(/^https?:[/][/]/,"");lk.style.fontSize="12px";q.appendChild(document.createElement("br"));q.appendChild(lk);d.appendChild(q)}
  [["reedit","Re-edit"],["share","Share"],["print","Print"],["delete","Delete"]].forEach(function(a){var b=document.createElement("button");b.type="button";b.textContent=a[1];b.onclick=function(){if(a[0]==="delete"&&!confirm("Delete this video from the inbox? It is kept in the deleted folder."))return;jpost("/act?name="+encodeURIComponent(c.name)+"&do="+a[0]).then(function(){poll()})};d.appendChild(b)});
  box.appendChild(d)})}
function offer(row,name){fetch(T+"/looks").then(function(r){return r.json()}).then(function(j){if(!j.on)return;var box=document.createElement("div");box.className="looks";var h=document.createElement("b");h.textContent="Choose your look";box.appendChild(h);var inp=document.createElement("input");inp.type="text";inp.placeholder="Your name (optional)";inp.maxLength=40;inp.style.cssText="display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:10px;border-radius:10px;border:1px solid #ccc;font-size:16px";box.appendChild(inp);j.looks.forEach(function(l){var b=document.createElement("button");b.type="button";b.textContent=l.icon+" "+l.title;b.style.cssText="margin:3px;padding:10px 14px;border-radius:12px;border:0;color:#fff;font-weight:700;font-size:14px;background:linear-gradient(135deg,"+l.c1+","+l.c2+")";b.onclick=function(){fetch(T+"/look?name="+encodeURIComponent(name)+"&key="+encodeURIComponent(l.key)+"&who="+encodeURIComponent(inp.value),{method:"POST"}).then(function(r){box.textContent=r.ok?"Look chosen. Your video is being made!":"Could not send your choice."})};box.appendChild(b)});row.appendChild(box)}).catch(function(){})}
function after(row,nm){var q="/choice?name="+encodeURIComponent(nm),any=false;["look","music","speed","text"].forEach(function(k){if(sel[k]){q+="&"+k+"="+encodeURIComponent(sel[k]);any=true}});if(sel.gif){q+="&gif=1";any=true}
 if(any)jpost(q).catch(function(){});if(!sel.look)offer(row,nm);setTimeout(poll,800)}
function attempt(file,row,n){var x=new XMLHttpRequest();x.open("POST",T+"/upload?name="+encodeURIComponent(file.name));x.setRequestHeader("content-type","application/octet-stream");
 var sp=row.querySelector("span");
 x.upload.onprogress=function(p){if(p.lengthComputable)row.querySelector("i").style.width=Math.round(p.loaded/p.total*100)+"%"};
 function again(msg){if(n<3){sp.textContent=msg+" Trying again ("+(n+1)+"/3)…";setTimeout(function(){attempt(file,row,n+1)},[2000,5000,10000][n])}else sp.textContent=msg+" Tap Choose a video to try again."}
 x.onload=function(){if(x.status===200){row.querySelector("i").style.width="100%";sp.textContent="Sent. It is on the laptop now.";var nm="";try{nm=JSON.parse(x.responseText).name}catch(e){}if(nm)after(row,nm)}else if(x.status>=500)again("Could not send ("+x.status+").");else sp.textContent="Could not send ("+x.status+")."};
 x.onerror=function(){again("No connection to the laptop.")};x.send(file)}
function send(file){var row=document.createElement("div");row.className="row";row.innerHTML="<b></b><div class=bar><i></i></div><span></span>";row.querySelector("b").textContent=file.name;$("list").insertBefore(row,$("list").firstChild);attempt(file,row,0)}
["f","r"].forEach(function(id){$(id).addEventListener("change",function(e){Array.prototype.forEach.call(e.target.files,send);e.target.value=""})});
$("cd").onclick=function(){var b=$("cd");b.disabled=true;jpost("/cmd?do=countdown").then(function(j){b.textContent=j&&j.ok?"✓ Countdown started on the laptop":"Could not start it"}).catch(function(){b.textContent="No connection to the laptop"}).then(function(){setTimeout(function(){b.disabled=false;b.textContent="⏱ Start the countdown on the laptop"},3000)})};
loadSel();loadCfg();ping();poll();
setInterval(function(){if(!document.hidden){ping();loadCfg()}},15000);setInterval(function(){if(!document.hidden)poll()},2500);
(function(){var h=$("hint");var sa=navigator.standalone||(window.matchMedia&&matchMedia("(display-mode: standalone)").matches);if(sa)return;var ios=/iPhone|iPad|iPod/.test(navigator.userAgent);h.textContent=ios?"Tip: tap the Share button, then Add to Home Screen. Next time you are two taps from sending: open it, tap Record now.":"Tip: open the browser menu, then Add to Home screen. Next time you are two taps from sending: open it, tap Record now.";h.style.display="block"})();
</script></body></html>`;

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

// ---- Photoman / Photographer Desk Live State & Remote Mobile Control ----
let roveDeskState = {
  layoutMode: 'match',
  fillMode: 'multi',
  autoOn: false,
  need: 1,
  rawShots: 1,
  activeLabel: 'Solo (1 shot)',
  layouts: [],
  queue: [],
  lastResult: null,
  updatedAt: 0
};
let roveCmdQueue = [];
export function roveStateSet(st) {
  if (!st || typeof st !== 'object') return false;
  const layouts = (Array.isArray(st.layouts) ? st.layouts : []).slice(0, 60).map((l) => ({
    key: cleanText(l && l.key, 80),
    label: cleanText(l && l.label, 80),
    shots: numIn(l && l.shots, 1, 12, 1),
    group: cleanText(l && l.group, 40)
  })).filter((l) => l.key && l.label);
  const queue = (Array.isArray(st.queue) ? st.queue : []).slice(0, 40).map((q) => ({
    id: Number.isInteger(Number(q && q.id)) && Number(q.id) >= 1 && Number(q.id) <= 9999999 ? Number(q.id) : 0,    // not numIn(): that would turn a bad id into 1, a real photo's id
    name: cleanText(q && q.name, 80),
    thumb: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{10,160000}$/.test(String((q && q.thumb) || '')) ? String(q.thumb) : '',
    used: !!(q && q.used),
    phone: !!(q && q.phone),
    edited: !!(q && q.edited),
    selOrder: numIn(q && q.selOrder, 0, 12, 0)
  })).filter((q) => q.id > 0);
  let lastResult = null;
  if (st.lastResult && typeof st.lastResult === 'object') {
    const lr = st.lastResult;
    lastResult = {
      sessionNumber: numIn(lr.sessionNumber, 1, 999999, 1),
      qrUrl: cleanText(lr.qrUrl, 300),
      thumb: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{10,250000}$/.test(String(lr.thumb || '')) ? String(lr.thumb) : '',
      label: cleanText(lr.label, 80),
      printing: !!lr.printing,
      at: numIn(lr.at, 0, Number.MAX_SAFE_INTEGER, Date.now())
    };
  }
  const next = {
    layoutMode: cleanText(st.layoutMode, 80) || 'match',
    fillMode: st.fillMode === 'repeat1' ? 'repeat1' : 'multi',
    autoOn: !!st.autoOn,
    need: numIn(st.need, 1, 12, 1),
    rawShots: numIn(st.rawShots, 1, 12, 1),
    activeLabel: cleanText(st.activeLabel, 80) || 'Solo (1 shot)',
    layouts,
    queue,
    lastResult
  };
  // The phone asks "anything new since <updatedAt>?" and gets a tiny answer when nothing changed, so it does not pull every
  // thumbnail again every second and a half over the booth Wi-Fi. A push that changes nothing keeps the same updatedAt.
  const { updatedAt: _u, ...prev } = roveDeskState;
  if (JSON.stringify(prev) !== JSON.stringify(next) || !roveDeskState.updatedAt) roveDeskState = { ...next, updatedAt: Date.now() };
  return true;
}
export function roveCmdTake() {
  const out = roveCmdQueue;
  roveCmdQueue = [];
  return out;
}
function handleRoveControl(req, res, url, kind) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': kind === 'rove-state' ? 'GET' : 'POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
  const json = (code, o) => send(res, code, 'application/json', JSON.stringify(o), cors);
  if (kind === 'rove-state') {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', cors);
    if (roveDeskState.updatedAt && url.searchParams.get('since') === String(roveDeskState.updatedAt)) return json(200, { ok: true, same: true, updatedAt: roveDeskState.updatedAt });
    return json(200, { ok: true, ...roveDeskState });
  }
  if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
  const q = url.searchParams;
  const act = cleanText(q.get('do'), 30);
  if (!['make', 'config', 'print', 'next', 'clear'].includes(act)) return json(400, { ok: false, error: 'Invalid command' });
  const cmd = { do: act, at: Date.now() };
  if (act === 'make') {
    const ids = String(q.get('ids') || '').split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 12);
    if (!ids.length) return json(400, { ok: false, error: 'Pick at least 1 photo' });
    cmd.ids = ids;
    cmd.original = q.get('original') === '1';
  } else if (act === 'config') {
    if (q.has('layoutMode')) cmd.layoutMode = cleanText(q.get('layoutMode'), 80);
    if (q.has('fillMode')) cmd.fillMode = q.get('fillMode') === 'repeat1' ? 'repeat1' : 'multi';
    if (q.has('autoOn')) cmd.autoOn = q.get('autoOn') === '1';
  }
  if (roveCmdQueue.length >= 60) roveCmdQueue.shift();
  roveCmdQueue.push(cmd);
  return json(200, { ok: true });
}

const ROVE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photoman Mobile Control &amp; Queue</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1EA;color:#1C1A1E;padding:16px 14px 40px;text-align:center}
h1{font-size:21px;margin:4px 0 2px;font-weight:800;letter-spacing:-.02em}
p{color:#6B666C;margin:4px 0}
.st{display:inline-block;font-size:12.5px;font-weight:700;border-radius:99px;padding:3px 12px;background:#E4DCCF;color:#444;margin:4px 0 10px}
.st.ok{background:#d6f1e2;color:#16683f}.st.bad{background:#f9d8d2;color:#8e2312}
.card{max-width:480px;margin:10px auto;background:#fff;border-radius:16px;padding:14px;text-align:left;box-shadow:0 2px 10px rgba(40,30,20,.06);border:1px solid #EAE3D5}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:800;font-size:14.5px}
.pill{font-size:11.5px;font-weight:700;padding:2px 9px;border-radius:99px;background:#F4EFE6;color:#5C565C}
.pill.brand{background:#FCE8E5;color:#C93D27}
.pill.auto{background:#DCF5E7;color:#16683F}
.field{margin-top:8px}
.field label{display:block;font-size:12px;font-weight:700;color:#6B666C;margin-bottom:3px}
.field select{width:100%;padding:9px 10px;border-radius:10px;border:1.5px solid #DED6C8;font:600 14px inherit;background:#fff;color:#1C1A1E}
.chk-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding:9px 11px;border-radius:11px;background:#FAF6F0;border:1px solid #EAE3D5;font-size:13.5px;font-weight:700;cursor:pointer}
.chk-row input{width:18px;height:18px;accent-color:#C93D27}
.q-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.q-item{position:relative;aspect-ratio:1;border-radius:11px;overflow:hidden;border:2.5px solid transparent;background:#F4EFE6;padding:0;cursor:pointer}
.q-item img{width:100%;height:100%;object-fit:cover;display:block}
.q-item.sel{border-color:#C93D27;box-shadow:0 0 0 2px rgba(201,61,39,.25)}
.q-item.used{opacity:.62}
.q-badge{position:absolute;top:5px;right:5px;min-width:22px;height:22px;border-radius:99px;background:#C93D27;color:#fff;font:800 12px/22px inherit;text-align:center;padding:0 5px;box-shadow:0 2px 5px rgba(0,0,0,.3)}
.q-done{position:absolute;bottom:4px;left:4px;right:4px;background:rgba(28,26,30,.75);color:#fff;font-size:10px;font-weight:700;padding:2px 4px;border-radius:5px;text-align:center}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btn{flex:1;min-width:120px;padding:12px 14px;border-radius:12px;border:0;font:800 14px inherit;cursor:pointer;text-align:center;text-decoration:none}
.btn.pri{background:#C93D27;color:#fff}
.btn.sec{background:#1C1A1E;color:#fff}
.btn.ghost{background:#F4EFE6;color:#1C1A1E;border:1px solid #DED6C8}
.btn:disabled{opacity:.45;cursor:default}
.res-box{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.res-pv{width:120px;max-height:160px;border-radius:10px;object-fit:contain;background:#1C1A1E;border:1px solid #DED6C8}
.res-qr{flex:1;min-width:150px;text-align:center}
.res-qr img{width:136px;height:136px;image-rendering:pixelated;border-radius:10px;border:1px solid #EAE3D5;padding:4px;background:#fff}
label.pick{display:inline-flex;align-items:center;justify-content:center;flex:1;min-width:135px;padding:13px 16px;border-radius:12px;background:#C93D27;color:#fff;font-weight:800;font-size:14.5px;cursor:pointer}
label.pick.alt{background:#1C1A1E}
input[type=file]{display:none}
.bar{height:8px;border-radius:5px;background:#E4DCCF;overflow:hidden;margin:5px 0 2px}.bar i{display:block;height:100%;width:0;background:#2EA66B}
.row{margin:8px 0 0;font-size:12.5px}
.hint{font-size:12px;color:#6B666C;line-height:1.4;margin-top:6px}
</style></head><body>
<h1>📷 Photoman Control &amp; Queue</h1>
<div class="st" id="conn">Connecting to laptop…</div>

<div class="card" id="resCard" hidden>
  <div class="card-h"><span>🎉 Latest Framed Print &amp; Guest QR</span><span class="pill auto" id="resMeta">Ready</span></div>
  <div class="res-box">
    <img id="resThumb" class="res-pv" alt="Framed print" hidden>
    <div class="res-qr">
      <div id="resQrBox"></div>
      <div id="resQrNote" class="hint" style="margin-top:4px;font-weight:700;color:#1C1A1E">Guest scans to download</div>
    </div>
  </div>
  <div class="btn-row">
    <button type="button" class="btn sec" id="resPrintBtn">🖨️ Print Copy</button>
    <button type="button" class="btn ghost" id="resNextBtn">⏭️ Next Guest</button>
  </div>
</div>

<div class="card">
  <div class="card-h"><span>🖼️ Photoman Template &amp; Flow</span><span class="pill brand" id="needPill">1 shot</span></div>
  <div class="field">
    <label for="laySel">Template / Frame for Photoman</label>
    <select id="laySel"><option value="match">Match Photobooth Layout</option><option value="solo">Solo (1 photo — built-in design)</option></select>
  </div>
  <div class="field" id="fillWrap" hidden>
    <label for="fillSel">When template has multiple photo spots</label>
    <select id="fillSel">
      <option value="multi">Require separate shots (e.g. 2 shots for 2 frames)</option>
      <option value="repeat1">Use 1 shot only (duplicate into all frames)</option>
    </select>
  </div>
  <label class="chk-row">
    <span>⚡ Auto-frame incoming DSLR / phone shots</span>
    <input type="checkbox" id="autoChk">
  </label>
  <div class="hint" id="flowHint">Shots from your DSLR or phone appear in the queue below.</div>
</div>

<div class="card">
  <div class="card-h"><span>📥 Laptop Photographer Queue</span><span class="pill" id="qCount">0 photos</span></div>
  <div class="hint" id="qHint">Tap photo(s) below in order, then tap Make Print + QR.</div>
  <div class="q-grid" id="qGrid"></div>
  <div class="btn-row">
    <button type="button" class="btn pri" id="makeBtn" disabled>🖼️ Make Print + QR</button>
    <button type="button" class="btn ghost" id="origBtn" disabled>🖨️ Print Original</button>
  </div>
</div>

<div class="card">
  <div class="card-h"><span>📱 Send Photos from This Phone</span></div>
  <div class="btn-row" style="margin-top:4px">
    <label class="pick" for="cam">📸 Take a Photo</label><input id="cam" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
    <label class="pick alt" for="f">🖼️ Choose Photos</label><input id="f" type="file" accept="image/jpeg,image/png,image/webp" multiple>
  </div>
  <div id="list"></div>
</div>

<script src="/qr.js"></script>
<script>
var T=location.pathname.replace(/[/]+$/,"").replace(/[/]photos$/,"");
var st=null,sel=[],lastLaySig="",lastResSig="";
function $(i){return document.getElementById(i)}
function cmd(q){return fetch(T+"/rove-cmd?"+q,{method:"POST"}).then(function(r){return r.json().catch(function(){return{}})}).then(function(j){setTimeout(poll,250);return j})}

function renderQr(url){
  var box=$("resQrBox");box.innerHTML="";
  if(!url){$("resQrNote").textContent="Preparing QR link on laptop…";return}
  if(typeof qrcode==="function"){
    try{var q=qrcode(0,"M");q.addData(url);q.make();var im=new Image();im.src=q.createDataURL(4,2);im.alt="Guest QR";box.appendChild(im)}catch(e){}
  }
  var a=document.createElement("a");a.href=url;a.target="_blank";a.style.cssText="display:block;font-size:11.5px;color:#C93D27;font-weight:700;margin-top:4px;word-break:break-all";
  a.textContent=url.replace(/^https?:[/][/]/,"");box.appendChild(a);
  $("resQrNote").textContent="Show to guest to scan & save";
}

function applyState(s){
  st=s;
  var need=Math.max(1,Number(s.need)||1),rawShots=Math.max(1,Number(s.rawShots)||need);
  $("needPill").textContent=need===1?"1 shot per print":(need+" shots per print");
  var lsig=JSON.stringify(s.layouts||[])+"|"+s.layoutMode;
  if(lsig!==lastLaySig){
    lastLaySig=lsig;
    var selEl=$("laySel");selEl.innerHTML="";
    var lays=(s.layouts&&s.layouts.length)?s.layouts:[{key:"match",label:"Match Photobooth Layout"},{key:"solo",label:"Solo (1 photo)"}];
    var curG=null,gEl=null;
    lays.forEach(function(l){
      var o=document.createElement("option");o.value=l.key;o.textContent=l.label+(l.shots>1?" · "+l.shots+" photos":"");if(l.key===s.layoutMode)o.selected=true;
      if(l.group){if(l.group!==curG){curG=l.group;gEl=document.createElement("optgroup");gEl.label=l.group;selEl.appendChild(gEl)}gEl.appendChild(o)}else selEl.appendChild(o);
    });
  }
  $("fillWrap").hidden=rawShots<=1;
  $("fillSel").value=s.fillMode==="repeat1"?"repeat1":"multi";
  $("autoChk").checked=!!s.autoOn;
  $("flowHint").textContent=s.autoOn
    ?("⚡ Auto-Frame is ON: Every "+(need===1?"1 new shot is":(need+" new shots are"))+" automatically placed into "+(s.activeLabel||"your template")+" with QR & print.")
    :("Manual mode: Tap up to "+need+" photo"+(need>1?"s":"")+" in the queue below (picking 1 photo fills all spots), then tap Make Print + QR.");

  var q=s.queue||[];
  var validIds={};q.forEach(function(it){validIds[it.id]=1});
  sel=sel.filter(function(id){return !!validIds[id]});
  if(sel.length>need)sel=sel.slice(-need);

  $("qCount").textContent=q.length+(q.length===1?" photo":" photos");
  $("qHint").textContent=q.length
    ?(need>1?"Tap up to "+need+" photos in order (1 photo repeats in all boxes), then Make Print + QR.":"Tap a photo below, then tap Make Print + QR.")
    :"No photos in queue yet. Shoot with your DSLR or use Take a Photo below.";

  var grid=$("qGrid");grid.innerHTML="";
  q.forEach(function(it){
    var b=document.createElement("button");b.type="button";
    var si=sel.indexOf(it.id);
    b.className="q-item"+(si>=0?" sel":"")+(it.used?" used":"");
    if(it.thumb){var im=new Image();im.src=it.thumb;im.alt=it.name||"photo";b.appendChild(im)}
    if(si>=0){var bd=document.createElement("span");bd.className="q-badge";bd.textContent=String(si+1);b.appendChild(bd)}
    if(it.used){var dn=document.createElement("span");dn.className="q-done";dn.textContent="Printed ✓";b.appendChild(dn)}
    b.onclick=function(){
      var idx=sel.indexOf(it.id);
      if(idx>=0)sel.splice(idx,1);
      else{sel.push(it.id);if(sel.length>need)sel.shift()}
      applyState(st);
    };
    grid.appendChild(b);
  });
  $("makeBtn").disabled=!sel.length;
  $("origBtn").disabled=!sel.length;

  var lr=s.lastResult;
  $("resCard").hidden=!lr;
  if(lr){
    $("resMeta").textContent=lr.printing?"Printing…":("Session #"+(lr.sessionNumber||1));
    var th=$("resThumb");
    if(lr.thumb){th.src=lr.thumb;th.hidden=false}else th.hidden=true;
    var rsig=(lr.sessionNumber||"")+"|"+(lr.qrUrl||"")+"|"+(lr.at||"");
    if(rsig!==lastResSig){lastResSig=rsig;renderQr(lr.qrUrl||"")}
  }
}

var since="";
function poll(){
  fetch(T+"/rove-state"+(since?"?since="+encodeURIComponent(since):""),{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
    if(j&&j.ok){
      var c=$("conn");c.className="st ok";c.textContent="✓ Connected · "+(j.activeLabel||(st&&st.activeLabel)||"Photoman Ready");
      if(j.same)return;
      since=String(j.updatedAt||"");
      applyState(j);
    }
  }).catch(function(){
    var c=$("conn");c.className="st bad";c.textContent="No connection to laptop. Join the Booth Wi-Fi.";
  });
}

$("laySel").onchange=function(){cmd("do=config&layoutMode="+encodeURIComponent(this.value))};
$("fillSel").onchange=function(){cmd("do=config&fillMode="+encodeURIComponent(this.value))};
$("autoChk").onchange=function(){cmd("do=config&autoOn="+(this.checked?"1":"0"))};
$("makeBtn").onclick=function(){
  if(!sel.length)return;
  var ids=sel.slice();sel=[];
  $("makeBtn").disabled=true;
  cmd("do=make&ids="+ids.join(","));
};
$("origBtn").onclick=function(){
  if(!sel.length)return;
  var ids=[sel[0]];sel=[];
  $("origBtn").disabled=true;
  cmd("do=make&original=1&ids="+ids.join(","));
};
$("resPrintBtn").onclick=function(){cmd("do=print")};
$("resNextBtn").onclick=function(){cmd("do=next")};

function pick(e){Array.prototype.forEach.call(e.target.files,send);e.target.value=""}
$("f").addEventListener("change",pick);$("cam").addEventListener("change",pick);
function send(file){
  var row=document.createElement("div");row.className="row";row.innerHTML="<b></b><div class=bar><i></i></div><span></span>";
  row.querySelector("b").textContent=file.name||"photo";$("list").insertBefore(row,$("list").firstChild);
  var x=new XMLHttpRequest();x.open("POST",T+"/photo?name="+encodeURIComponent(file.name||"photo.jpg"));
  x.setRequestHeader("content-type","application/octet-stream");
  x.upload.onprogress=function(p){if(p.lengthComputable)row.querySelector("i").style.width=Math.round(p.loaded/p.total*100)+"%"};
  x.onload=function(){var ok=x.status===200;row.querySelector("span").textContent=ok?"Sent ✓ Appearing in queue…":"Could not send ("+x.status+").";if(ok){row.querySelector("i").style.width="100%";setTimeout(poll,600)}};
  x.onerror=function(){row.querySelector("span").textContent="No connection to the laptop. Are you on the booth Wi-Fi?"};
  x.send(file);
}
poll();setInterval(function(){if(!document.hidden)poll()},1600);
</script></body></html>`;

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
  if (sm[2] === 'rove-state' || sm[2] === 'rove-cmd') return handleRoveControl(req, res, url, sm[2]);
  if (sm[2] === 'hello') {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
    const who = url.searchParams.get('r');                 // a recorder says hello (r=1) or that a recording just started (r=rec)
    if (who === 'rec') { conn.recAt = Date.now(); conn.helloAt = conn.recAt; } else if (who) conn.helloAt = Date.now();
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, app: 'photobooth4u', kind: 'laptop' }), cors);
  }
  if (sm[2] === 'manifest') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'application/manifest+json', JSON.stringify({
      name: 'Send a 360 video', short_name: '360 Send', start_url: '/send/' + spinToken, scope: '/send/' + spinToken, display: 'standalone',
      background_color: '#F6F1EA', theme_color: '#C93D27',
      icons: [{ src: '/send/' + spinToken + '/icon/192', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/send/' + spinToken + '/icon/512', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
    }));
  }
  if (sm[2] === 'icon') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'image/png', sendIconPng(Number(sm[3])), { 'cache-control': 'public, max-age=86400' });
  }
  if (sm[2] === 'looks') {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, on: lookOffer.on, looks: lookOffer.on ? lookOffer.looks : [] }), cors);
  }
  if (sm[2] === 'look') {
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
    const dd = spinDirNow(), n = basename(String(url.searchParams.get('name') || '')), key = String(url.searchParams.get('key') || '');
    if (!lookOffer.on || !dd || !n || n.startsWith('.') || !VIDEO_RE.test(n) || !existsSync(join(dd, n)) || !lookOffer.looks.some((l) => l.key === key)) return send(res, 400, 'application/json', JSON.stringify({ ok: false }), cors);
    if (lookPicks.size > 200) lookPicks.clear();
    lookPicks.set(n, { key, who: cleanText(url.searchParams.get('who'), 40) });
    return send(res, 200, 'application/json', JSON.stringify({ ok: true }), cors);
  }
  if (['config', 'clips', 'choice', 'act', 'cmd', 'arm-state', 'arm-poll'].includes(sm[2])) return handleSendV2(req, res, url, sm);
  const d = spinDirNow(); if (!d) return send(res, 503, 'text/plain', 'Not ready');
  if (!sm[2]) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, 'text/html; charset=utf-8', SEND_PAGE.replace(/__T__/g, spinToken));
  }
  if (sm[2] === 'file' || sm[2] === 'edited' || sm[2] === 'proxy') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    const base = sm[2] === 'edited' ? join(d, 'edited') : (sm[2] === 'proxy' ? join(d, '.proxy') : d);
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
    conn.uploadAt = Date.now();
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
  const p = findFileInDir(dir, r.file);
  try { return p ? readFileSync(p) : null; } catch { return null; }
}

// Arrange & Print: the operator browses the pictures already saved on this laptop (this event first, then older events).
const STUDIO_IMG_RE = /\.(jpe?g|png|webp)$/i;
export function studioFolders(folderKey, subfolder) {
  const name = safeName(folderKey) || ('Photobooth ' + today()), sub = safeName(subfolder);
  const curId = (name + (sub ? '/' + sub : '')).toLowerCase();
  const out = [];
  for (const slug of Object.keys(index.folders)) {
    const f = index.folders[slug], dir = dirOf(slug);
    if (!dir || !existsSync(dir)) continue;
    out.push({ slug, name: f.sub ? f.name + ' / ' + f.sub : f.name, at: f.at || 0, current: f.id === curId && f.root === ROOT });
  }
  return out.sort((a, b) => (b.current - a.current) || (b.at - a.at)).slice(0, 60);
}
export function studioList(slug) {
  const dir = dirOf(String(slug || '')); if (!dir) return [];
  return photosIn(dir).filter((p) => STUDIO_IMG_RE.test(p.n)).slice(0, 600).map((p) => ({ name: p.n, t: p.t }));
}
export function studioRead(slug, name) {
  const dir = dirOf(String(slug || '')), n = basename(String(name || ''));
  if (!dir || !STUDIO_IMG_RE.test(n) || n.startsWith('.')) return null;
  const p = findFileInDir(dir, n);
  try { return p ? readFileSync(p) : null; } catch { return null; }
}

const printNowJobs = new Map();
const PRINTNOW_MAX = 20, PRINTNOW_KEEP_MS = 120000;
let printNowConfig = null;
export function setPrintNowConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') { printNowConfig = null; return false; }
  const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, n);
  const sizes = (Array.isArray(cfg.sizes) ? cfg.sizes : []).slice(0, 30).map((s) => ({
    key: cleanStr(s && s.key, 40),
    name: cleanStr(s && s.name, 60),
    w: Number(s && s.w) || 0,
    h: Number(s && s.h) || 0,
    receipt: !!(s && s.receipt)
  })).filter((s) => s.key && s.name);
  const printers = (Array.isArray(cfg.printers) ? cfg.printers : []).slice(0, 60).map((p) => ({
    id: cleanStr(p && p.id, 180),
    label: cleanStr(p && p.label, 180),
    kind: cleanStr(p && p.kind, 24),
    receipt: !!(p && p.receipt)
  })).filter((p) => p.id && p.label);
  const sizePrinters = {};
  if (cfg.sizePrinters && typeof cfg.sizePrinters === 'object') {
    for (const [k, v] of Object.entries(cfg.sizePrinters)) {
      const ck = cleanStr(k, 40), cv = cleanStr(v, 180);
      if (ck && cv) sizePrinters[ck] = cv;
    }
  }
  printNowConfig = {
    printOn: !!cfg.printOn,
    autoPrint: !!cfg.autoPrint,
    sizes,
    printers,
    sizePrinters,
    defaultSize: cleanStr(cfg.defaultSize, 40),
    defaultPrinter: cleanStr(cfg.defaultPrinter, 180),
    defaultCopies: Math.max(1, Math.min(20, Math.floor(Number(cfg.defaultCopies) || 1))),
    singleStrip: !!cfg.singleStrip,
    thermalQuality: cleanStr(cfg.thermalQuality || 'best', 16),
    at: Date.now()
  };
  return true;
}
function handlePrintNowConfig(req, res) {
  const reply = (code, o) => send(res, code, 'application/json', JSON.stringify(o));
  if (!isLocalReq(req)) return reply(403, { ok: false, error: 'Only the booth laptop can read printer settings.' });
  return reply(200, { ok: true, config: printNowConfig });
}
export function printNowTake() {
  const out = [];
  for (const [id, j] of printNowJobs) {
    if (Date.now() - j.t > PRINTNOW_KEEP_MS) { printNowJobs.delete(id); continue; }
    if (j.state !== 'wait') continue;
    const dir = dirOf(j.slug); let bytes = null;
    const target = dir ? findFileInDir(dir, j.file) : null;
    try { bytes = target ? readFileSync(target) : null; } catch { /* gone */ }
    if (!bytes) { j.state = 'fail'; j.msg = 'That photo is no longer on this laptop.'; continue; }
    j.state = 'taken'; out.push({ id, file: j.file, bytes, opts: j.opts || null });
  }
  return out;
}
export function printNowDone(id, ok, msg) {
  const j = printNowJobs.get(String(id)); if (!j) return false;
  j.state = ok ? 'ok' : 'fail'; j.msg = String(msg || '').slice(0, 200);
  return true;
}
async function handlePrintNow(req, res, pm) {
  const reply = (code, o) => send(res, code, 'application/json', JSON.stringify(o));
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  if (!isLocalReq(req)) return reply(403, { ok: false, error: 'Only the booth laptop can print from here.' });
  let file; try { file = decodeURIComponent(pm[2]); } catch { file = ''; }
  const dir = dirOf(pm[1]);
  if (!dir || !file || file !== basename(file) || file.startsWith('.') || !/\.(jpe?g|png|webp)$/i.test(file) || !findFileInDir(dir, file)) return reply(404, { ok: false, error: 'Photo not found' });
  let live = 0; for (const j of printNowJobs.values()) if (j.state === 'wait' || j.state === 'taken') live++;
  if (live >= PRINTNOW_MAX) return reply(429, { ok: false, error: 'The booth is busy printing. Try again in a moment.' });
  const body = await readSmallJson(req);
  const opts = {};
  if (body && typeof body.size === 'string' && body.size.trim()) opts.size = body.size.trim().slice(0, 40);
  if (body && typeof body.printer === 'string' && body.printer.trim()) opts.printer = body.printer.trim().slice(0, 180);
  if (body && body.copies != null) opts.copies = Math.max(1, Math.min(20, Math.floor(Number(body.copies) || 1)));
  if (body && typeof body.singleStrip === 'boolean') opts.singleStrip = body.singleStrip;
  if (body && typeof body.thermalQuality === 'string' && body.thermalQuality.trim()) opts.thermalQuality = body.thermalQuality.trim().slice(0, 16);
  const id = randomBytes(6).toString('hex');
  printNowJobs.set(id, { slug: pm[1], file, state: 'wait', msg: '', opts: Object.keys(opts).length ? opts : null, t: Date.now() });
  return reply(200, { ok: true, id });
}
function handlePrintNowStatus(req, res, pm) {
  const reply = (code, o) => send(res, code, 'application/json', JSON.stringify(o));
  if (!isLocalReq(req)) return reply(403, { ok: false });
  const j = printNowJobs.get(pm[1]);
  return j ? reply(200, { ok: true, state: j.state, msg: j.msg }) : reply(404, { ok: false, state: 'gone' });
}
function opPrintButtonHtml(slug, file) {
  return '<button class="btn alt" id="opPrint" type="button">🖨️ Reprint</button>' +
    '<div id="opPrintModal" style="display:none;position:fixed;inset:0;z-index:99;background:rgba(28,26,30,.64);align-items:center;justify-content:center;padding:16px">' +
    '<div style="background:#fff;color:#1C1A1E;border-radius:18px;width:min(440px,100%);padding:20px;text-align:left;box-shadow:0 20px 60px rgba(0,0,0,.35)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><b style="font-size:18px;flex:1">🖨️ Reprint photo</b><button type="button" id="opPmClose" style="border:1.5px solid #E4DCCF;background:#fff;border-radius:999px;width:32px;height:32px;font-size:18px;cursor:pointer;color:#1C1A1E">×</button></div>' +
    '<label style="display:block;font-size:12px;font-weight:800;color:#6B666C;margin:8px 0 4px;text-transform:uppercase;letter-spacing:.04em">Printer</label>' +
    '<div style="display:flex;gap:6px;align-items:center">' +
    '<select id="opPmPrinter" style="flex:1;min-width:0;padding:10px 12px;border-radius:10px;border:1.5px solid #E4DCCF;font:600 14px inherit;background:#fff;color:#1C1A1E"></select>' +
    '<button type="button" id="opPmRefresh" title="Refresh printers" style="border:1.5px solid #E4DCCF;background:#fff;border-radius:10px;padding:10px 12px;font:700 14px inherit;cursor:pointer;color:#1C1A1E">↻</button>' +
    '</div>' +
    '<label id="opPmSizeLbl" style="display:block;font-size:12px;font-weight:800;color:#6B666C;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em">Paper size</label>' +
    '<select id="opPmSize" style="width:100%;padding:10px 12px;border-radius:10px;border:1.5px solid #E4DCCF;font:600 14px inherit;background:#fff;color:#1C1A1E"></select>' +
    '<div id="opPmCopiesWrap" style="display:flex;align-items:center;justify-content:space-between;margin:14px 0 6px">' +
    '<span style="font-size:13px;font-weight:800;color:#1C1A1E">Copies</span>' +
    '<div style="display:inline-flex;align-items:center;gap:10px">' +
    '<button type="button" id="opPmMinus" style="width:36px;height:36px;border-radius:10px;border:1.5px solid #E4DCCF;background:#fff;font:800 18px inherit;cursor:pointer">−</button>' +
    '<b id="opPmCopies" style="min-width:26px;text-align:center;font-size:16px">1</b>' +
    '<button type="button" id="opPmPlus" style="width:36px;height:36px;border-radius:10px;border:1.5px solid #E4DCCF;background:#fff;font:800 18px inherit;cursor:pointer">+</button>' +
    '</div></div>' +
    '<label id="opPmStripRow" style="display:none;align-items:center;gap:8px;margin:10px 0 4px;font-size:13px;font-weight:600;color:#1C1A1E"><input type="checkbox" id="opPmSingle"> 1 full strip per sheet (don’t pair 2 side-by-side)</label>' +
    '<p id="opPmHint" style="font-size:12.5px;color:#6B666C;line-height:1.45;margin:10px 0 14px"></p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" id="opPmGo" class="btn" style="flex:1;margin:0;text-align:center">🖨️ Reprint now</button>' +
    '</div></div></div>' +
    '<script>(function(){' +
    'var btn=document.getElementById("opPrint"),mo=document.getElementById("opPrintModal"),prSel=document.getElementById("opPmPrinter"),szSel=document.getElementById("opPmSize"),szLbl=document.getElementById("opPmSizeLbl"),cpWrap=document.getElementById("opPmCopiesWrap"),cpVal=document.getElementById("opPmCopies"),stRow=document.getElementById("opPmStripRow"),stChk=document.getElementById("opPmSingle"),hint=document.getElementById("opPmHint"),go=document.getElementById("opPmGo");' +
    'var cfg=null,copies=1,busy=false,userPickedPrinter=false;' +
    'function openM(){mo.style.display="flex";loadCfg()}' +
    'function closeM(){if(busy)return;mo.style.display="none"}' +
    'function isStripImg(){var im=document.querySelector(".one img");return !!(im&&im.naturalWidth&&im.naturalHeight&&im.naturalWidth/im.naturalHeight<0.45)}' +
    'function curSizeObj(){if(!cfg||!cfg.sizes)return null;for(var i=0;i<cfg.sizes.length;i++)if(cfg.sizes[i].key===szSel.value)return cfg.sizes[i];return null}' +
    'function updateUI(){var p=prSel.value,s=curSizeObj(),hasP=!!p;cpVal.textContent=String(copies);' +
    'szSel.style.display=(cfg&&cfg.sizes&&cfg.sizes.length)?"":"none";szLbl.style.display=szSel.style.display;' +
    'cpWrap.style.display=hasP?"flex":"none";' +
    'stRow.style.display=(hasP&&s&&!s.receipt&&s.w/s.h>=0.5&&isStripImg())?"flex":"none";' +
    'go.disabled=busy||!hasP;' +
    'go.textContent=busy?"Sending…":(copies>1?"🖨️ Reprint ("+copies+" copies)":"🖨️ Reprint now");' +
    'if(!busy){hint.textContent=hasP?"Pre-filled from your booth setup. Prints directly from photobooth4u without changing Auto-print.":"No printers found yet. Connect a printer in photobooth4u and tap ↻.";hint.style.color=hasP?"#6B666C":"#C93D27"}}' +
    'function fillCfg(c){cfg=c;userPickedPrinter=false;prSel.innerHTML="";szSel.innerHTML="";' +
    'var ps=(c&&c.printers)?c.printers.filter(function(x){return x&&x.id&&x.id!=="dialog"}):[];' +
    'if(!ps.length){var eo=document.createElement("option");eo.value="";eo.textContent="— No printer found —";prSel.appendChild(eo)}' +
    'else{ps.forEach(function(x){var o=document.createElement("option");o.value=x.id;o.textContent=x.label;prSel.appendChild(o)})}' +
    'var sz=(c&&c.sizes)?c.sizes:[];' +
    'sz.forEach(function(x){var o=document.createElement("option");o.value=x.key;o.textContent=x.name;szSel.appendChild(o)});' +
    'if(c&&c.defaultSize&&sz.some(function(x){return x.key===c.defaultSize}))szSel.value=c.defaultSize;' +
    'if(ps.length){prSel.value=(c&&c.defaultPrinter&&ps.some(function(x){return x.id===c.defaultPrinter}))?c.defaultPrinter:ps[0].id}' +
    'copies=Math.max(1,Math.min(20,(c&&c.defaultCopies)||1));stChk.checked=!!(c&&c.singleStrip);updateUI()}' +
    'function loadCfg(){hint.textContent="Loading printers…";hint.style.color="#6B666C";fetch("/printnow/config").then(function(r){return r.json()}).then(function(j){fillCfg(j&&j.ok?j.config:null)}).catch(function(){fillCfg(null)})}' +
    'document.getElementById("opPmRefresh").addEventListener("click",function(){if(!busy)loadCfg()});' +
    'szSel.addEventListener("change",function(){if(!userPickedPrinter&&cfg&&cfg.sizePrinters&&cfg.sizePrinters[szSel.value]&&cfg.sizePrinters[szSel.value]!=="dialog")prSel.value=cfg.sizePrinters[szSel.value];updateUI()});' +
    'prSel.addEventListener("change",function(){userPickedPrinter=true;if(prSel.value==="bt"&&cfg&&cfg.sizes){var s=curSizeObj();if(!s||!s.receipt){var r=cfg.sizes.find(function(x){return x.receipt});if(r)szSel.value=r.key}}updateUI()});' +
    'document.getElementById("opPmMinus").addEventListener("click",function(){copies=Math.max(1,copies-1);updateUI()});' +
    'document.getElementById("opPmPlus").addEventListener("click",function(){copies=Math.min(20,copies+1);updateUI()});' +
    'document.getElementById("opPmClose").addEventListener("click",closeM);' +
    'mo.addEventListener("click",function(e){if(e.target===mo)closeM()});' +
    'document.addEventListener("keydown",function(e){if(e.key==="Escape"&&mo.style.display==="flex")closeM()});' +
    'go.addEventListener("click",function(){if(busy||!prSel.value)return;' +
    'busy=true;go.disabled=true;updateUI();hint.textContent="Sending to printer…";hint.style.color="#6B666C";' +
    'var payload={size:szSel.value||"",printer:prSel.value||"",copies:copies};if(stRow.style.display!=="none")payload.singleStrip=!!stChk.checked;' +
    'fetch("/e/' + slug + '/printnow/' + encodeURIComponent(file) + '",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}).then(function(r){return r.json()}).then(function(j){' +
    'if(!j.ok){busy=false;go.disabled=false;updateUI();hint.textContent=j.error||"Could not print.";hint.style.color="#C93D27";return}' +
    'var n=0;(function poll(){fetch("/printnow/"+j.id).then(function(r){return r.json()}).then(function(s){' +
    'if(s.state==="ok"){busy=false;go.disabled=false;updateUI();hint.textContent=s.msg||"Sent to printer ✓";hint.style.color="#2E7D32";return}' +
    'if(s.state==="fail"){busy=false;go.disabled=false;updateUI();hint.textContent=s.msg||"Could not print. Check the printer or pick another one.";hint.style.color="#C93D27";return}' +
    'if(++n>50){busy=false;go.disabled=false;updateUI();hint.textContent="The booth did not answer. Check photobooth4u is open.";hint.style.color="#C93D27";return}' +
    'setTimeout(poll,600)}).catch(function(){busy=false;go.disabled=false;updateUI();hint.textContent="Could not reach photobooth4u.";hint.style.color="#C93D27"})})()' +
    '}).catch(function(){busy=false;go.disabled=false;updateUI();hint.textContent="Could not reach photobooth4u.";hint.style.color="#C93D27"})});' +
    'btn.addEventListener("click",openM)})()</script>';
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
  if (!file || file !== basename(file) || file.startsWith('.') || !/\.(jpe?g|png|webp)$/i.test(file) || !findFileInDir(dir, file)) return fail(404, 'photo');
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
    const target = findFileInDir(dir, file);
    if (!c.files.includes(file) || !target) return send(res, 404, 'text/plain', 'Not found');
    const extra = {};
    if (url.searchParams.get('dl')) {
      recordStat(c.slug, 'downloads', file);
      extra['content-disposition'] = 'attachment; filename="' + file.replace(/[^\w.() -]/g, '_') + '"';
    }
    return serveFile(req, res, target, TYPES[extname(file).toLowerCase()] || 'application/octet-stream', extra);
  }
  const ev = index.folders[c.slug];
  const evName = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : 'Your photos';
  const rankOf = (n) => {
    if (/_solo_\d+/i.test(n)) return 3;
    if (/\.gif$/i.test(n) || VIDEO_RE.test(n)) return 2;
    return 1;
  };
  const mine = c.files
    .filter((n) => findFileInDir(dir, n))
    .sort((a, b) => {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  mine.forEach((f) => recordStat(c.slug, 'views', f));
  const items = mine.map((file, i) => {
    const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    const isGif = /\.gif$/i.test(file), isVid = VIDEO_RE.test(file), isSoloPhoto = /_solo_\d+/i.test(file);
    const soloMatch = /_solo_(\d+)/i.exec(file);
    const badgeLabel = isVid ? (/_guestbook/i.test(file) ? 'Guestbook message' : '360 Video') : isGif ? 'GIF' : isSoloPhoto ? ('Solo Shot ' + (soloMatch ? soloMatch[1] : '')) : 'Template Print';
    const badgeStyle = 'display:inline-block;margin:0 auto 10px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;background:' + (isSoloPhoto ? 'rgba(201,61,39,0.12);color:#C93D27' : isGif ? 'rgba(28,26,30,0.08);color:#1C1A1E' : 'rgba(46,125,50,0.12);color:#2E7D32') + ';';
    const src = '/o/' + code + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : isSoloPhoto ? 'Your solo photo' : 'Your photo') + '">';
    const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : isSoloPhoto ? 'Save solo photo' : 'Save photo';
    return '<div class="one" style="padding-bottom:12px"><div style="text-align:center"><span style="' + badgeStyle + '">' + badgeLabel + '</span></div>' + media + '<div><a class="btn" href="' + src + '?dl=1" download="' + esc(file) + '">' + dlText + '</a>' +
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
  const isSoloPhoto = /_solo_\d+/i.test(file);
  const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : isSoloPhoto ? 'Save solo photo' : 'Save photo';
  const printPart = (!/^video\//.test(type) && !isGif ? (isLocalReq(req) ? opPrintButtonHtml(slug, file) : '<button class="btn alt" type="button" onclick="window.print()">Print photo</button>') : '');
  const reqPart = (guestPrintOn && !isVid && !isGif ? reqButtonHtml(slug, file) : '');
  const allPhotosPart = guestView !== 'only' ? '<a class="btn alt" href="/e/' + slug + '/">All photos</a>' : '';
  return '<div>' +
    '<button class="btn" id="btnShare" type="button" style="display:none">Share / AirDrop ↗</button>' +
    '<a class="btn" id="btnDl" href="' + src + '?dl=1" download="' + esc(file) + '">' + dlText + '</a>' +
    '<button class="btn alt" id="btnCopy" type="button">Copy link 📋</button>' +
    printPart + reqPart +
    allPhotosPart +
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

/* Default: LumaShare Session Mode (Standby / Current Session only). Grid is hidden by default. */
.controls{display:none;align-items:center;justify-content:center;padding:12px 16px 4px}
.tabs{display:inline-flex;background:rgba(255,255,255,0.06);border-radius:20px;padding:3px;gap:2px}
.tab{background:transparent;border:0;border-radius:18px;padding:6px 16px;font-size:13px;font-weight:700;color:#A49FA9;cursor:pointer}
.tab.active{background:#fff;color:#0F0E13;box-shadow:0 2px 8px rgba(0,0,0,0.3)}

.grid{display:none;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;padding:16px 20px 60px;max-width:1300px;margin:0 auto}
.card{background:rgba(255,255,255,0.05);border-radius:14px;overflow:hidden;aspect-ratio:9/16;position:relative;cursor:pointer;border:1px solid rgba(255,255,255,0.08);transition:transform .15s}
.card:active{transform:scale(0.97)}
.card img,.card video{width:100%;height:100%;object-fit:cover;display:block}
.card .play-pill{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);color:#fff;border-radius:18px;padding:4px 10px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:5px}
.card .time{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);color:#eee;border-radius:6px;padding:3px 7px;font-size:10px;font-weight:600}
.empty{text-align:center;color:#8E8994;padding:80px 20px;font-size:15px;grid-column:1/-1}

/* Standby screen (Clean kiosk standby - LumaShare style) */
.standby-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:75vh;padding:32px 20px;text-align:center}
.standby-card{max-width:460px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:24px;padding:38px 28px;box-shadow:0 20px 50px rgba(0,0,0,0.5)}
.standby-icon{font-size:48px;margin-bottom:12px;animation:stBounce 1.6s infinite alternate ease-in-out}
@keyframes stBounce{from{transform:translateY(0)}to{transform:translateY(-8px)}}
.standby-card h2{margin:0 0 10px;font-size:24px;font-weight:800;letter-spacing:-.02em;color:#fff}
.standby-card p{margin:0;color:#A49FA9;font-size:14.5px;line-height:1.55}
.standby-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#2EA66B;margin-top:16px;background:rgba(46,166,107,0.12);padding:5px 12px;border-radius:20px}
.wrong-event-bar{margin-top:20px}
.wrong-event-btn{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);color:#A49FA9;font-size:12px;font-weight:700;border-radius:10px;padding:7px 16px;cursor:pointer;font-family:inherit;transition:background .15s}
.wrong-event-btn:hover{background:rgba(255,255,255,0.14);color:#fff}

/* Active Session Display / Modal (LumaShare screen) */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.92);backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px;opacity:0;pointer-events:none;transition:opacity .2s}
.modal-overlay.open{opacity:1;pointer-events:auto}
.modal{background:#18161D;border:1px solid rgba(255,255,255,0.12);border-radius:24px;width:100%;max-width:940px;max-height:92vh;display:flex;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,0.8);position:relative}
.modal-media{flex:1.2;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;min-height:360px}
.modal-media video,.modal-media img{max-width:100%;max-height:86vh;object-fit:contain}
.modal-share{flex:1;padding:32px 28px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:#18161D;border-left:1px solid rgba(255,255,255,0.08)}
.modal-share h2{margin:0 0 6px;font-size:24px;font-weight:800;letter-spacing:-.02em}
.modal-share p{color:#A49FA9;font-size:13px;line-height:1.45;margin:0 0 16px;max-width:280px}
.session-pills{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:14px;max-width:280px}
.session-pill{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.14);color:#D2CED6;font-size:11.5px;font-weight:700;border-radius:12px;padding:4px 10px;cursor:pointer;transition:all .15s;font-family:inherit}
.session-pill.active{background:#C93D27;color:#fff;border-color:#C93D27;box-shadow:0 2px 8px rgba(201,61,39,0.3)}
.qr-frame{background:#fff;padding:14px;border-radius:18px;box-shadow:0 12px 36px rgba(0,0,0,0.4);display:inline-block;margin-bottom:18px}
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
  .qr-frame img{width:170px;height:170px}
}
</style>
${QR_JS_CODE ? `<script>${QR_JS_CODE}</script>` : `<script src="/qr.js"></script>`}
</head>
<body>
<header>
  <div class="brand"><div class="brand-dot"></div>photobooth4u</div>
  <div class="title-wrap">
    <h1>${esc(evName)}</h1>
    <div class="badge">📱 Sharing Station</div>
  </div>
  <div class="stat"><span class="pulse"></span><span id="stCount">Live</span></div>
</header>

<div class="controls" id="stControls">
  <div class="tabs">
    <button type="button" class="tab active" data-filter="all">All</button>
    <button type="button" class="tab" data-filter="photo">Prints</button>
    <button type="button" class="tab" data-filter="solo">Solo Photos</button>
    <button type="button" class="tab" data-filter="gif">GIFs</button>
    <button type="button" class="tab" data-filter="video">360 Videos</button>
    <button type="button" class="tab" data-filter="guestbook">Guestbook</button>
  </div>
</div>

<div class="grid" id="stGrid"><div class="empty">Loading items…</div></div>

<div class="standby-wrap" id="standbyView">
  <div class="standby-card">
    <div class="standby-icon">✨ 📸</div>
    <h2>Ready for your photos!</h2>
    <p>Step up to the booth to start your session. Your photos and QR code will appear here automatically.</p>
    <div class="standby-status"><span class="pulse"></span> Live Sync Active</div>
    <div class="wrong-event-bar" id="wrongEventBar" style="display:none">
      <button type="button" class="wrong-event-btn" onclick="location.reload()">⟳ Seeing wrong event? Reload to resync</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button type="button" class="close-btn" id="mClose">✕</button>
    <div class="modal-media" id="mMedia"></div>
    <div class="modal-share">
      <h2>Scan to save</h2>
      <p>Point your phone’s camera at the QR code to open and save your photo.</p>
      <div id="mSessionPills" class="session-pills" style="display:none"></div>
      <div class="qr-frame"><img id="mQr" alt="QR Code"></div>
      <div class="qr-session-note" id="mQrNote" style="display:none;font-size:11px;color:#8E8A93;margin:-6px 0 10px;text-align:center">1 QR saves all session photos (print, GIF & solos)</div>
      <a class="btn" id="mDl" download>Save Photo</a>
      <button type="button" class="btn alt" id="mDone">Done (Next guest)</button>
      <div class="timer-bar"><i id="mBar"></i></div>
      <div class="timer-text">Auto-closing in <span id="mSec">35</span>s</div>
    </div>
  </div>
</div>

<script>
var SLUG = ${JSON.stringify(slug)};
var files = [], currentFilter = 'all', activeItem = null, timerId = null, timeLeft = 35;
// Default mode is pure LumaShare Session Mode (Standby + auto-pop current session only).
// Only allow gallery grid if explicitly requested via ?gallery=1 or ?mode=gallery.
var isGalleryMode = /[?&](gallery=1|mode=gallery)\b/i.test(location.search);
var privacyOnly = !isGalleryMode;
var hasLoaded = false, lastKnownTop = null;
var emptyPollCount = 0;

if (isGalleryMode) {
  document.getElementById('stControls').style.display = 'flex';
  document.getElementById('stGrid').style.display = 'grid';
  document.getElementById('standbyView').style.display = 'none';
} else {
  document.getElementById('stControls').style.display = 'none';
  document.getElementById('stGrid').style.display = 'none';
  document.getElementById('standbyView').style.display = 'flex';
  setTimeout(function() {
    var b = document.getElementById('wrongEventBar');
    if (b && !hasLoaded) b.style.display = 'block';
  }, 15000);
}

function playChime() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    var notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach(function(freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.08);
      gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.08 + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.08);
      osc.stop(ctx.currentTime + i * 0.08 + 0.45);
    });
  } catch(e) {}
}

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
    var qrFn = (typeof qrcode !== 'undefined') ? qrcode : (window.qrcode || globalThis.qrcode);
    if (!qrFn) return '';
    var q = qrFn(0, 'M');
    q.addData(url);
    q.make();
    return q.createDataURL(6, 2);
  } catch(e) {
    return '';
  }
}

function getSessionPrefix(filename) {
  if (!filename) return '';
  var m = /^([A-Za-z0-9_-]+?)_(?:strip|grid|solo|clip|[0-9]+up)/i.exec(filename);
  if (m) return m[1];
  var m2 = /^(\d+)[._]/i.exec(filename);
  return m2 ? m2[1] : filename;
}

function render() {
  if (!isGalleryMode) return;
  var g = document.getElementById('stGrid');
  var list = files.filter(function(f){ return currentFilter === 'all' || f.kind === currentFilter; });
  if (!list.length) {
    g.innerHTML = '<div class="empty">No ' + (currentFilter === 'all' ? 'items' : currentFilter === 'guestbook' ? 'guestbook messages' : currentFilter + 's') + ' yet. Take a shot on the booth to get started!</div>';
    return;
  }
  function lk(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  g.innerHTML = list.map(function(f){
    var isVid = f.kind === 'video' || f.kind === 'guestbook';
    var thumb = isVid
      ? '<video src="' + f.url + '#t=0.1" preload="metadata" muted playsinline></video><div class="play-pill"><i>▶</i> ' + (f.kind === 'guestbook' ? 'Message' : '360') + '</div>' + (f.look ? '<div style="position:absolute;left:8px;bottom:10px;max-width:60%;background:rgba(212,175,55,.92);color:#000;border-radius:14px;padding:3px 9px;font-size:10.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">✨ ' + lk(f.look) + '</div>' : '')
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

function openModal(it, sessionItems) {
  activeItem = it;
  var m = document.getElementById('modal');
  var med = document.getElementById('mMedia');
  var qr = document.getElementById('mQr');
  var qrNote = document.getElementById('mQrNote');
  var dl = document.getElementById('mDl');
  var pillsBox = document.getElementById('mSessionPills');
  
  var items = sessionItems || (files && files.filter(function(f) {
    return getSessionPrefix(f.name) === getSessionPrefix(it.name) || Math.abs((f.mtime || 0) - (it.mtime || 0)) < 8000;
  })) || [it];

  var sessionPrefix = getSessionPrefix(it.name);
  var sessionUrl = it.sessionUrl ? (location.origin + it.sessionUrl) : (location.origin + '/e/' + SLUG + '/s/' + encodeURIComponent(sessionPrefix));
  var pageUrl = (items.length > 1) ? sessionUrl : (it.pageUrl ? (location.origin + it.pageUrl) : sessionUrl);
  if (qrNote) qrNote.style.display = (items.length > 1) ? 'block' : 'none';
  
  if (it.kind === 'video' || it.kind === 'guestbook') {
    med.innerHTML = '<video src="' + it.url + '" controls autoplay loop playsinline></video>';
    dl.textContent = it.kind === 'guestbook' ? 'Save Message' : 'Save Video';
    var oldCap = document.getElementById('lookCap'); if (oldCap) oldCap.remove();
    if (it.look) { var cap = document.createElement('div'); cap.id = 'lookCap'; cap.textContent = '✨ ' + it.look; cap.style.cssText = 'margin:0 0 8px;font-weight:800;font-size:14px;color:#D4AF37;text-align:center'; dl.parentNode.insertBefore(cap, dl); }
  } else if (it.kind === 'solo') {
    var capS = document.getElementById('lookCap'); if (capS) capS.remove();
    med.innerHTML = '<img src="' + it.url + '" alt="">';
    dl.textContent = 'Save Solo Photo';
  } else if (it.kind === 'gif') {
    med.innerHTML = '<img src="' + it.url + '" alt="">';
    dl.textContent = 'Save GIF';
  } else {
    med.innerHTML = '<img src="' + it.url + '" alt="">';
    dl.textContent = 'Save Photo';
  }
  dl.href = it.url + (it.url.indexOf('?') >= 0 ? '&dl=1' : '?dl=1');
  dl.setAttribute('download', it.name);
  var qrData = makeQr(pageUrl);
  if (qrData) {
    qr.src = qrData;
    qr.style.display = 'block';
  } else {
    setTimeout(function() {
      var retry = makeQr(pageUrl);
      if (retry) {
        qr.src = retry;
        qr.style.display = 'block';
      }
    }, 200);
  }

  // Multi-item session support (e.g. print strip + solo photos or GIF)
  if (pillsBox) {

    if (items.length > 1) {
      pillsBox.style.display = 'flex';
      pillsBox.innerHTML = items.map(function(item, idx) {
        var label = item.kind === 'guestbook' ? '🎥 Guestbook' : item.kind === 'video' ? '🎬 360 Video' :
                    item.kind === 'gif' ? '✨ GIF' :
                    item.kind === 'solo' ? ('📸 Solo ' + (idx)) : '🖨️ Print Strip';
        var isCur = item.name === it.name;
        return '<button type="button" class="session-pill' + (isCur ? ' active' : '') + '" data-name="' + item.name + '">' + label + '</button>';
      }).join('');

      pillsBox.querySelectorAll('.session-pill').forEach(function(pill) {
        pill.addEventListener('click', function(e) {
          e.stopPropagation();
          var targetItem = items.find(function(x) { return x.name === pill.dataset.name; });
          if (targetItem) openModal(targetItem, items);
        });
      });
    } else {
      pillsBox.style.display = 'none';
      pillsBox.innerHTML = '';
    }
  }
  
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
  if (!isGalleryMode) {
    document.getElementById('standbyView').style.display = 'flex';
    document.getElementById('stGrid').style.display = 'none';
    document.getElementById('stControls').style.display = 'none';
  }
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
      var isFirst = !hasLoaded;
      var newest = j.files[0];
      var changed = j.files.length !== files.length || (newest && files[0] && newest.name !== files[0].name);
      files = j.files;
      hasLoaded = true;
      document.getElementById('stCount').textContent = files.length ? (files.length + ' item' + (files.length === 1 ? '' : 's')) : 'Live';

      if (files.length === 0) {
        emptyPollCount++;
        if (emptyPollCount >= 5) {
          var b = document.getElementById('wrongEventBar');
          if (b) b.style.display = 'block';
        }
      } else {
        emptyPollCount = 0;
        var b2 = document.getElementById('wrongEventBar');
        if (b2) b2.style.display = 'none';
      }

      if (changed || isFirst) {
        if (isGalleryMode && !activeItem) render();
        if (newest) {
          var isFresh = newest.mtime && (Date.now() - newest.mtime < 120000); // taken within last 2 mins
          var isNewArrival = !lastKnownTop || newest.name !== lastKnownTop;

          if (isNewArrival) {
            lastKnownTop = newest.name;
            if (!isFirst) {
              playChime();
              openModal(newest);
            } else if (isFresh) {
              // Opened station right after session: auto-show current session!
              openModal(newest);
            }
          }
        }
      }
    }
  } catch(e) {}
}

poll();
setInterval(poll, 1600);
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
${QR_JS_CODE ? `<script>${QR_JS_CODE}</script>` : `<script src="/qr.js"></script>`}
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
    const isSolo = (n) => /_solo_\d+/i.test(n);
    const getPrefix = (filename) => {
      const pm = /^([A-Za-z0-9_-]+?)_(?:strip|grid|solo|clip|[0-9]+up)/i.exec(filename);
      if (pm) return pm[1];
      const pm2 = /^(\d+)[._]/i.exec(filename);
      return pm2 ? pm2[1] : filename;
    };
    const looks = readLooks(dir);
    const files = list.map(({ n, t }) => ({
      name: n,
      look: VIDEO_RE.test(n) && looks[n] ? looks[n] : undefined,
      kind: VIDEO_RE.test(n) && /_guestbook/i.test(n) ? 'guestbook' : VIDEO_RE.test(n) ? 'video' : /\.gif$/i.test(n) ? 'gif' : isSolo(n) ? 'solo' : 'photo',
      url: '/e/' + slug + '/f/' + encodeURIComponent(n),
      thumbUrl: '/e/' + slug + '/t/' + encodeURIComponent(n),
      pageUrl: '/e/' + slug + '/p/' + encodeURIComponent(n),
      sessionUrl: '/e/' + slug + '/s/' + encodeURIComponent(getPrefix(n)),
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
    const list = photosIn(dir).filter(({ n }) => VIDEO_RE.test(n) && !/_guestbook/i.test(n));
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

// The Wi-Fi the laptop is on (or hosts), told to us by main.mjs. Used by the /wifi page when the booth's own hotspot is not running.
let externalWifi = { ssid: '', pass: '' };
export function setExternalWifi(ssid, pass) {
  externalWifi = { ssid: String(ssid || '').slice(0, 64), pass: String(pass || '').slice(0, 128) };
}

// ---------- 4.3 Booth Wi-Fi Connect Page HTML (/wifi, /join, /connect) ----------
function wifiHtml(ssid, pass) {
  const safeSsid = esc(ssid || 'photobooth4u');
  const safePass = esc(pass || '');
  const wifiPayload = `WIFI:T:WPA;S:${ssid || ''};P:${pass || ''};;`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Connect to Booth Wi-Fi</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#0F0E13;color:#F0EEF5;min-height:100vh;-webkit-tap-highlight-color:transparent;display:flex;flex-direction:column;align-items:center;padding:24px 16px 40px}
.header{text-align:center;margin-bottom:20px}
.brand{font-size:13px;font-weight:800;letter-spacing:-.01em;color:#A49FA9;display:inline-flex;align-items:center;gap:6px;margin-bottom:8px}
.brand-dot{width:8px;height:8px;background:#C93D27;border-radius:2px}
h1{margin:0 0 6px;font-size:24px;font-weight:800;letter-spacing:-.02em;color:#fff}
.sub{margin:0;font-size:14px;color:#A49FA9}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:24px;width:100%;max-width:440px;text-align:center;box-shadow:0 12px 36px rgba(0,0,0,0.4);margin-bottom:18px}
.qr-frame{background:#fff;padding:14px;border-radius:16px;display:inline-block;box-shadow:0 8px 24px rgba(0,0,0,0.25);margin-bottom:18px}
.qr-frame img{display:block;width:200px;height:200px}
.net-info{background:rgba(0,0,0,0.3);border-radius:14px;padding:14px;border:1px solid rgba(255,255,255,0.08);margin-bottom:16px;text-align:left}
.net-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0}
.net-row:not(:last-child){border-bottom:1px solid rgba(255,255,255,0.06)}
.net-label{font-size:12px;color:#8E8994;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.net-val{font-size:14px;color:#fff;font-weight:700;font-family:monospace}
.copy-btn{background:rgba(255,255,255,0.12);color:#fff;border:0;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;transition:background .2s}
.copy-btn:hover{background:rgba(255,255,255,0.2)}
.steps{text-align:left;margin-top:8px}
.step-item{display:flex;gap:12px;margin-bottom:14px}
.step-num{width:24px;height:24px;border-radius:50%;background:#C93D27;color:#fff;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
.step-text{font-size:13.5px;color:#D8D5DE;line-height:1.45}
.step-text b{color:#fff}
.alert-box{background:rgba(201,61,39,0.15);border:1px solid rgba(201,61,39,0.35);border-radius:12px;padding:12px 14px;font-size:13px;color:#FFB4A8;line-height:1.4;margin-top:14px;text-align:left}
.nav-btns{display:flex;flex-direction:column;gap:10px;width:100%;max-width:440px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 20px;border-radius:12px;font-weight:800;font-size:14.5px;text-decoration:none;border:0;cursor:pointer;transition:transform .1s,opacity .2s}
.btn:active{transform:scale(0.98)}
.btn-primary{background:#C93D27;color:#fff}
.btn-secondary{background:rgba(255,255,255,0.08);color:#F0EEF5;border:1px solid rgba(255,255,255,0.12)}
</style>
${QR_JS_CODE ? `<script>${QR_JS_CODE}</script>` : `<script src="/qr.js"></script>`}
</head>
<body>
<div class="header">
  <div class="brand"><span class="brand-dot"></span>photobooth4u</div>
  <h1>📶 Join Booth Wi-Fi</h1>
  <p class="sub">Connect to download your photos &amp; videos</p>
</div>

<div class="card">
  <div class="qr-frame">
    <img id="wifiQr" alt="Wi-Fi QR Code">
  </div>
  <div class="net-info">
    <div class="net-row">
      <span class="net-label">Network (SSID)</span>
      <span class="net-val">${safeSsid}</span>
    </div>
    <div class="net-row">
      <span class="net-label">Password</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="net-val">${safePass ? safePass : '<i>None (Open)</i>'}</span>
        ${safePass ? `<button type="button" class="copy-btn" id="cpBtn" onclick="copyPw('${safePass}')">Copy</button>` : ''}
      </div>
    </div>
  </div>

  <div class="steps">
    <div class="step-item">
      <div class="step-num">1</div>
      <div class="step-text"><b>Scan or Join:</b> Point camera at QR code above, or join <b>${safeSsid}</b> in Wi-Fi settings.</div>
    </div>
    <div class="step-item">
      <div class="step-num">2</div>
      <div class="step-text"><b>Stay Connected:</b> If your phone alerts <i>“No internet access”</i>, tap <b>“Keep Connection / Stay Connected”</b>. (The booth operates offline).</div>
    </div>
    <div class="step-item">
      <div class="step-num">3</div>
      <div class="step-text"><b>Scan Photo QR:</b> Once connected, scan your session QR on the booth or Sharing Station!</div>
    </div>
  </div>

  <div class="alert-box">
    ⚠️ <b>Before scanning your photo QR:</b> Your phone must be on this booth Wi-Fi. Photos are hosted locally on this laptop and cannot be reached via mobile data (4G/5G).
  </div>
</div>

<div class="nav-btns">
  <a class="btn btn-primary" href="/station">📱 Open Sharing Station</a>
  <a class="btn btn-secondary" href="/guide">📖 View Booth &amp; Wi-Fi Guide</a>
  <a class="btn btn-secondary" href="/e">🖼️ View Event Gallery</a>
</div>

<script>
(function() {
  var payload = ${JSON.stringify(wifiPayload)};
  var qrEl = document.getElementById('wifiQr');
  if (qrEl && typeof qrcode === 'function') {
    try {
      var q = qrcode(0, 'M');
      q.addData(payload);
      q.make();
      qrEl.src = q.createDataURL(6, 2);
    } catch(e) {}
  }
})();
function copyPw(pw) {
  var btn = document.getElementById('cpBtn');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(pw).then(function() {
      if (btn) { btn.textContent = 'Copied ✓'; setTimeout(function(){ btn.textContent = 'Copy'; }, 2000); }
    });
  }
}
</script>
</body>
</html>`;
}

// ---------- 4.4 Operational Guide HTML (/guide, /help, /instructions) ----------
function guideHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Photobooth Wi-Fi &amp; Station Guide</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;background:#0F0E13;color:#F0EEF5;min-height:100vh;-webkit-tap-highlight-color:transparent;padding:24px 16px 50px}
.wrap{max-width:680px;margin:0 auto}
header{text-align:center;margin-bottom:28px}
.brand{font-size:13px;font-weight:800;letter-spacing:-.01em;color:#A49FA9;display:inline-flex;align-items:center;gap:6px;margin-bottom:8px}
.brand-dot{width:8px;height:8px;background:#C93D27;border-radius:2px}
h1{margin:0 0 6px;font-size:26px;font-weight:800;letter-spacing:-.02em;color:#fff}
.sub{margin:0;font-size:14.5px;color:#A49FA9}
.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:24px;margin-bottom:20px;box-shadow:0 8px 30px rgba(0,0,0,0.35)}
.card-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.card-icon{font-size:26px;width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.card-title{font-size:18px;font-weight:800;color:#fff;margin:0}
.tag{display:inline-block;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
.tag-red{background:rgba(201,61,39,0.2);color:#FF6B55}
.tag-green{background:rgba(46,166,107,0.2);color:#34D399}
.tag-blue{background:rgba(59,130,246,0.2);color:#60A5FA}
p{color:#D8D5DE;font-size:14px;line-height:1.6;margin:0 0 12px}
ul,ol{margin:0 0 14px;padding-left:20px;color:#D8D5DE;font-size:14px;line-height:1.6}
li{margin-bottom:6px}
code{background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:6px;font-family:monospace;font-size:13px;color:#FFB4A8}
.callout{background:rgba(201,61,39,0.12);border-left:4px solid #C93D27;padding:12px 14px;border-radius:0 12px 12px 0;margin:12px 0;font-size:13.5px;color:#FFB4A8;line-height:1.5}
.slug-table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px}
.slug-table th{text-align:left;padding:8px 10px;background:rgba(255,255,255,0.08);color:#fff;font-weight:700;border-radius:6px 6px 0 0}
.slug-table td{padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.06);color:#D8D5DE}
.slug-table td a{color:#FF6B55;text-decoration:none;font-weight:700}
.slug-table td a:hover{text-decoration:underline}
.nav-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:12px 18px;border-radius:12px;font-weight:800;font-size:14px;text-decoration:none;border:0;cursor:pointer}
.btn-primary{background:#C93D27;color:#fff}
.btn-secondary{background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.12)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="brand-dot"></span>photobooth4u</div>
    <h1>📖 Booth Wi-Fi &amp; Stations Guide</h1>
    <p class="sub">Operational steps for booth Wi-Fi, scanning, and separate QR stations</p>
  </header>

  <!-- Section 1 -->
  <div class="card">
    <div class="card-head">
      <div class="card-icon">💻</div>
      <div>
        <h2 class="card-title">1. Make This Laptop the Booth Wi-Fi</h2>
        <span class="tag tag-green">Zero Hardware Needed</span>
      </div>
    </div>
    <p>Turns the Windows laptop into its own Wi-Fi hotspot so guest phones can connect directly to download photos without an external router or pocket Wi-Fi.</p>
    <ul>
      <li><b>When to use:</b> Venues with no Wi-Fi or cellular service, remote/outdoor gigs, or minimalist single-bag setups.</li>
      <li><b>When NOT to use:</b> When you need live internet features (Google Drive live sync, online GCash/Maya QR payments) or massive crowd concurrency (50+ simultaneous users; use a router instead).</li>
      <li><b>How to enable:</b> In Setup &rarr; <b>Step 6: Share &amp; start</b> &rarr; check <code>Make this laptop the booth Wi-Fi (no router needed)</code>.</li>
      <li><b>One-time setup:</b> If shown, click <code>Set up (one time)</code> and grant Windows Admin permission once to configure the loopback adapter and firewall.</li>
      <li><b>Keep active:</b> Check <code>Turn it on whenever the app opens</code> to start hosting at launch.</li>
    </ul>
  </div>

  <!-- Section 2 -->
  <div class="card">
    <div class="card-head">
      <div class="card-icon">📱</div>
      <div>
        <h2 class="card-title">2. Before Scanning Guest QR: Golden Rule</h2>
        <span class="tag tag-red">Crucial Guest Step</span>
      </div>
    </div>
    <div class="callout">
      ⚠️ <b>Guest phones MUST join the Booth Wi-Fi FIRST before scanning their photo QR code.</b>
    </div>
    <p>Because photos are served locally from this laptop (<code>http://192.168.137.1:47777</code>), scanning on mobile data (4G/5G) or venue Wi-Fi will fail with <i>"Site unreachable"</i>.</p>
    <ol>
      <li><b>Connect:</b> Have guests scan the printed <b>WIFI QR Sign</b> or join the booth Wi-Fi network.</li>
      <li><b>Stay Connected:</b> When the phone alerts <i>“Wi-Fi has no internet access. Stay connected?”</i>, guests <b>MUST tap "Keep / Stay Connected"</b>.</li>
      <li><b>Scan Photo QR:</b> Now the guest scans the QR code on the booth screen to instantly view &amp; save their photos/videos.</li>
    </ol>
    <p><i>Operator Tip:</i> Tap the <b>Wi-Fi button</b> in the bottom dock of the booth anytime to pop up the Wi-Fi QR on screen for guests.</p>
  </div>

  <!-- Section 3 -->
  <div class="card">
    <div class="card-head">
      <div class="card-icon">🚀</div>
      <div>
        <h2 class="card-title">3. Using a Separate QR Station (Sharing Station)</h2>
        <span class="tag tag-blue">Eliminates Booth Lines</span>
      </div>
    </div>
    <p>Using a separate iPad or tablet as a Sharing Station lets guests step away to scan and download, immediately freeing the camera booth for the next group.</p>
    <ul>
      <li><b>Setup:</b> In Setup &rarr; Step 6, check <code>Show QR on a separate Sharing Station</code>.</li>
      <li><b>Tablet Connection:</b> Connect the tablet/iPad to the <b>Booth Wi-Fi</b>.</li>
      <li><b>Pairing:</b> Click <code>Pair Sharing Station</code> in setup, or open <code>/station</code> (or <code>/qr</code>) on the tablet browser.</li>
      <li><b>Handoff Flow:</b> When a guest session finishes at the booth, the main screen shows <i>"Photos Ready! 👉 Scan at Sharing Station"</i> and resets in 2s. The tablet chimes and auto-pops the photos with download QR!</li>
    </ul>
  </div>

  <!-- Section 4 -->
  <div class="card">
    <div class="card-head">
      <div class="card-icon">🔗</div>
      <div>
        <h2 class="card-title">Quick Booth URL Slugs</h2>
        <span class="tag tag-green">Direct Shortcuts</span>
      </div>
    </div>
    <table class="slug-table">
      <thead>
        <tr><th>URL Slug</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td><a href="/wifi"><code>/wifi</code></a>, <code>/join</code></td><td>Guest Wi-Fi connect page with live scannable QR code</td></tr>
        <tr><td><a href="/station"><code>/station</code></a>, <a href="/qr"><code>/qr</code></a>, <code>/share</code></td><td>Live Sharing Station (auto-pops latest session &amp; QR)</td></tr>
        <tr><td><a href="/guide"><code>/guide</code></a>, <code>/help</code></td><td>This operational guide &amp; instructions</td></tr>
        <tr><td><a href="/e"><code>/e</code></a>, <code>/gallery</code></td><td>Active event photo gallery (all prints &amp; videos)</td></tr>
        <tr><td><a href="/stats"><code>/stats</code></a></td><td>Live session, view, print, and download statistics</td></tr>
      </tbody>
    </table>
    <div class="nav-row">
      <a class="btn btn-primary" href="/wifi">📶 Open Wi-Fi Connect Page</a>
      <a class="btn btn-secondary" href="/station">📱 Open Sharing Station</a>
      <a class="btn btn-secondary" href="/e">🖼️ Open Gallery</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

function handleWifi(req, res, url) {
  const cors = {};   // no cross-site access: it carries the Wi-Fi password, and the page and its JSON are same-origin
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  let hs = null;
  try { hs = hotspotInfo(); } catch { }
  // The booth's own hotspot when it is running; otherwise the Wi-Fi this laptop is on; otherwise the saved hotspot name.
  const useHs = !!(hs && hs.on && hs.ssid);
  const ssid = useHs ? hs.ssid : (externalWifi.ssid || (hs && hs.ssid) || 'photobooth4u');
  const pass = useHs ? (hs.pass || '') : (externalWifi.ssid ? externalWifi.pass : (hs && hs.pass) || '');
  if (url.pathname === '/wifi/json' || url.pathname === '/api/wifi') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, ssid, pass, on: hs ? hs.on : false, lan: lanAddress() }), { ...cors, 'cache-control': 'no-store' });
  }
  return send(res, 200, 'text/html; charset=utf-8', wifiHtml(ssid, pass));
}

function handleGuide(req, res, url) {
  const cors = { 'access-control-allow-origin': '*' };
  if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  return send(res, 200, 'text/html; charset=utf-8', guideHtml());
}

let lanHandler = null;
export function setLanHandler(fn) { lanHandler = fn; }

async function handleShare(req, res) {
  if (lanHandler && await lanHandler(req, res)) return;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'text/plain', 'Bad request'); }
  if (await handleBridgeHttp(req, res, url)) return;
  if (url.pathname === '/qr.js') {
    if (QR_JS_CODE) {
      return send(res, 200, 'application/javascript; charset=utf-8', QR_JS_CODE, { 'cache-control': 'public, max-age=86400' });
    }
    const qrf = fileURLToPath(new URL('qr.js', import.meta.url));
    if (existsSync(qrf)) {
      return send(res, 200, 'application/javascript; charset=utf-8', readFileSync(qrf, 'utf8'), { 'cache-control': 'public, max-age=86400' });
    }
  }
  if (url.pathname === '/stats' || url.pathname === '/api/stats') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, stats: getStats() }), { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  }
  if (url.pathname === '/hello' || url.pathname === '/rove/hello') {
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true' });
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, app: 'photobooth4u', kind: 'laptop' }), cors);
  }
  if (url.pathname === '/photo' || url.pathname === '/rove/photo') {
    return handleRovePhoto(req, res, url);
  }
  if (url.pathname === '/wifi' || url.pathname === '/wifi/' || url.pathname === '/join' || url.pathname === '/join/' || url.pathname === '/connect' || url.pathname === '/connect/' || url.pathname === '/wifi/json' || url.pathname === '/api/wifi') {
    return handleWifi(req, res, url);
  }
  if (url.pathname === '/guide' || url.pathname === '/guide/' || url.pathname === '/help' || url.pathname === '/help/' || url.pathname === '/instructions' || url.pathname === '/instructions/') {
    return handleGuide(req, res, url);
  }
  if (url.pathname === '/e' || url.pathname === '/e/' || url.pathname === '/gallery' || url.pathname === '/gallery/' || url.pathname === '/photos' || url.pathname === '/photos/') {
    const s = resolveSlug();
    if (s) {
      res.writeHead(302, { 'location': '/e/' + s + '/', 'cache-control': 'no-store' });
      return res.end();
    }
  }
  const sm = /^\/send\/([A-Za-z0-9]+)(?:\/(upload|file|edited|proxy|photos|photo|rove-state|rove-cmd|hello|looks|look|manifest|icon|config|clips|choice|act|cmd|arm-state|arm-poll)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
  if (sm) return handleSend(req, res, url, sm);
  const om = /^\/o\/([A-Za-z0-9_-]{16,40})(?:\/(f|print)\/([^/]+))?\/?$/.exec(url.pathname);
  if (om) return handleOwn(req, res, url, om);
  const stm = /^\/(?:station|qr|share)(?:\/([A-Za-z0-9_-]{6,30}))?(?:\/(list|stats))?\/?$/.exec(url.pathname);
  if (stm) return handleStation(req, res, url, stm);
  const wlm = /^\/wall(?:\/([A-Za-z0-9_-]{6,30}))?(?:\/(feed|cue))?\/?$/.exec(url.pathname);
  if (wlm) return handleWall(req, res, url, wlm);
  const trm = /^\/e\/([A-Za-z0-9]{6,20})\/track\/?$/.exec(url.pathname);
  if (trm) return handleTrack(req, res, url, trm[1]);
  const stm2 = /^\/e\/([A-Za-z0-9]{6,20})\/stats\/?$/.exec(url.pathname);
  if (stm2) return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, slug: stm2[1], stats: getStats(stm2[1]) }), { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });

  if (guestView === 'only' && /^\/e\/[A-Za-z0-9]{6,20}\/?$/.test(url.pathname) && !isLocalReq(req)) {
    return send(res, 403, 'text/html; charset=utf-8', page('Private', '<p class="empty">Guests of this event see only their own photos. Scan your own QR code at the booth to open yours.</p>'));
  }
  if (url.pathname === '/printnow/config' || url.pathname === '/printnow/config/') return handlePrintNowConfig(req, res);
  const pnm = /^\/e\/([A-Za-z0-9]{6,20})\/printnow\/([^/]+)\/?$/.exec(url.pathname);
  if (pnm) return handlePrintNow(req, res, pnm);
  const pns = /^\/printnow\/([a-f0-9]{12})\/?$/.exec(url.pathname);
  if (pns) return handlePrintNowStatus(req, res, pns);
  const prm = /^\/e\/([A-Za-z0-9]{6,20})\/print\/([^/]+)\/?$/.exec(url.pathname);
  if (prm) return handlePrintReq(req, res, prm);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
  const ljm = /^\/e\/([A-Za-z0-9]{6,20})\/list\.json\/?$/.exec(url.pathname);
  if (ljm) {
    if (guestView === 'only' && !isLocalReq(req)) return send(res, 403, 'application/json', JSON.stringify({ ok: false, error: 'private' }), { 'access-control-allow-origin': '*' });
    const d = dirOf(ljm[1]);
    if (!d || !existsSync(d)) return send(res, 404, 'application/json', JSON.stringify({ ok: false, error: 'not-found' }), { 'access-control-allow-origin': '*' });
    const ev = index.folders[ljm[1]];
    const nm = ev ? (ev.sub ? ev.name + ' · ' + ev.sub : ev.name) : 'Event photos';
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, name: nm, files: photosIn(d).map(({ n, t }) => ({ n, t })), print: guestPrintOn }), { 'access-control-allow-origin': '*' });
  }
  const m = /^\/e\/([A-Za-z0-9]{6,20})(?:\/(p|f|t|s)\/([^/]+))?\/?$/.exec(url.pathname);
  if (!m) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This link isn’t on this booth.</p>'));
  const dir = dirOf(m[1]);
  if (!dir || !existsSync(dir)) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p class="empty">This event isn’t on this booth anymore.</p>'));
  const ev = index.folders[m[1]];
  const evName = ev.sub ? ev.name + ' · ' + ev.sub : ev.name;
  if (!m[2]) {
    const list = photosIn(dir);
    const isSolo = (n) => /_solo_\d+/i.test(n);
    const kindOf = (n) => (VIDEO_RE.test(n) && /_guestbook/i.test(n) ? 'guestbook' : VIDEO_RE.test(n) ? 'video' : /\.gif$/i.test(n) ? 'gif' : isSolo(n) ? 'solo' : 'photo');
    const videoCount = list.filter(({ n }) => kindOf(n) === 'video').length;
    const guestbookCount = list.filter(({ n }) => kindOf(n) === 'guestbook').length;
    const gifCount = list.filter(({ n }) => kindOf(n) === 'gif').length;
    const soloCount = list.filter(({ n }) => kindOf(n) === 'solo').length;
    const photoCount = list.filter(({ n }) => kindOf(n) === 'photo').length;
    const kinds = [photoCount > 0, soloCount > 0, gifCount > 0, videoCount > 0, guestbookCount > 0].filter(Boolean).length;
    let tabsHtml = '';
    if (kinds > 1) {
      tabsHtml = '<div style="text-align:center"><div class="tabs">' +
        '<button type="button" class="tab active" onclick="setTab(\'all\',this)">All (' + list.length + ')</button>' +
        (photoCount ? '<button type="button" class="tab" onclick="setTab(\'photo\',this)">' + (soloCount ? 'Prints (' + photoCount + ')' : 'Photos (' + photoCount + ')') + '</button>' : '') +
        (soloCount ? '<button type="button" class="tab" onclick="setTab(\'solo\',this)">Solo Photos (' + soloCount + ')</button>' : '') +
        (gifCount ? '<button type="button" class="tab" onclick="setTab(\'gif\',this)">GIFs (' + gifCount + ')</button>' : '') +
        (videoCount ? '<button type="button" class="tab" onclick="setTab(\'video\',this)">Videos (' + videoCount + ')</button>' : '') +
        (guestbookCount ? '<button type="button" class="tab" onclick="setTab(\'guestbook\',this)">Guestbook (' + guestbookCount + ')</button>' : '') +
        '</div></div>' +
        (guestbookCount ? '<div style="text-align:center"><button type="button" id="gbDl" class="btn" style="display:none;margin:0 auto 14px">Download all guestbook videos</button></div>' : '');
    }
    const countSub = [
      photoCount && (photoCount + (soloCount ? ' print' : ' photo') + (photoCount === 1 ? '' : 's')),
      soloCount && (soloCount + ' solo photo' + (soloCount === 1 ? '' : 's')),
      gifCount && (gifCount + ' GIF' + (gifCount === 1 ? '' : 's')),
      videoCount && (videoCount + ' video' + (videoCount === 1 ? '' : 's')),
      guestbookCount && (guestbookCount + ' guestbook message' + (guestbookCount === 1 ? '' : 's'))
    ].filter(Boolean).join(' · ') || '0 photos';
    const tabScript = '<script>function setTab(k,b){document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")});b.classList.add("active");var g=document.querySelector(".grid");if(g)g.className="grid"+(k==="all"?"":" filter-"+k);}</script>';
    const body = '<div style="text-align:center;padding:0 16px"><h1>' + esc(evName) + '</h1><p class="sub">' + countSub + ' · tap one to save it</p></div>' +
      tabsHtml +
      (list.length ? '<div class="grid">' + list.map(({ n }) => {
        const k = kindOf(n);
        const thumb = (k === 'video' || k === 'guestbook')
          ? '<video preload="metadata" muted playsinline src="/e/' + m[1] + '/f/' + encodeURIComponent(n) + '#t=0.1"></video><span style="position:absolute;right:8px;bottom:8px;width:32px;height:32px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px">&#9654;</span>'
          : '<img loading="lazy" alt="" src="/e/' + m[1] + '/t/' + encodeURIComponent(n) + '">';
        return '<a href="/e/' + m[1] + '/p/' + encodeURIComponent(n) + '" data-kind="' + k + '" style="position:relative">' + thumb + '</a>';
      }).join('') + '</div>'
        : '<p class="empty">No photos yet. Pull down to refresh after your session.</p>') + tabScript;
    const gbItems = list.filter(({ n }) => kindOf(n) === 'guestbook').map(({ n }) => ({ name: n, url: '/e/' + m[1] + '/f/' + encodeURIComponent(n) }));
    const gbScript = gbItems.length
      ? '<script>' + GB_ZIP_JS + 'var GB_ITEMS=' + JSON.stringify(gbItems).replace(/</g, '\\u003c') + ';var GB_BASE=' + JSON.stringify(evName).replace(/</g, '\\u003c') + '.replace(/[\\\\\\/:*?"<>|]+/g,"_");' +
        '(function(){var st=setTab;setTab=function(k,b){st(k,b);var d=document.getElementById("gbDl");if(d)d.style.display=k==="guestbook"?"":"none";};var d=document.getElementById("gbDl");if(d)d.onclick=function(){gbDownloadAll(GB_ITEMS,d,GB_BASE);};})();</script>'
      : '';
    return send(res, 200, 'text/html; charset=utf-8', page(evName + ' photos', body + gbScript));
  }
  if (m[2] === 's') {
    let prefix; try { prefix = decodeURIComponent(m[3]); } catch { prefix = ''; }
    const list = photosIn(dir);
    function getPrefix(name) {
      const pm = /^([A-Za-z0-9_-]+?)_(?:strip|grid|solo|clip|[0-9]+up)/i.exec(name);
      if (pm) return pm[1];
      const pm2 = /^(\d+)[._]/i.exec(name);
      return pm2 ? pm2[1] : name;
    }
    const targetPrefix = getPrefix(prefix);
    const sessionFiles = list.filter(({ n }) => getPrefix(n) === targetPrefix || n.startsWith(prefix));
    const rankOf = (n) => {
      if (/_solo_\d+/i.test(n)) return 3;
      if (/\.gif$/i.test(n) || VIDEO_RE.test(n)) return 2;
      return 1;
    };
    const mine = sessionFiles.map(x => x.n).sort((a, b) => {
      const ra = rankOf(a), rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    mine.forEach((f) => recordStat(m[1], 'views', f));
    const items = mine.map((f, i) => {
      const type = TYPES[extname(f).toLowerCase()] || 'application/octet-stream';
      const isGif = /\.gif$/i.test(f), isVid = VIDEO_RE.test(f), isSoloPhoto = /_solo_\d+/i.test(f);
      const soloMatch = /_solo_(\d+)/i.exec(f);
      const badgeLabel = isVid ? (/_guestbook/i.test(f) ? 'Guestbook message' : '360 Video') : isGif ? 'GIF' : isSoloPhoto ? ('Solo Shot ' + (soloMatch ? soloMatch[1] : '')) : 'Template Print';
      const badgeStyle = 'display:inline-block;margin:0 auto 10px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;background:' + (isSoloPhoto ? 'rgba(201,61,39,0.12);color:#C93D27' : isGif ? 'rgba(28,26,30,0.08);color:#1C1A1E' : 'rgba(46,125,50,0.12);color:#2E7D32') + ';';
      const src = '/e/' + m[1] + '/f/' + encodeURIComponent(f);
      const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : isSoloPhoto ? 'Your solo photo' : 'Your photo') + '">';
      const dlText = isVid ? 'Save video' : isGif ? 'Save GIF' : isSoloPhoto ? 'Save solo photo' : 'Save photo';
      return '<div class="one" style="padding-bottom:12px"><div style="text-align:center"><span style="' + badgeStyle + '">' + badgeLabel + '</span></div>' + media + '<div><a class="btn" href="' + src + '?dl=1" download="' + esc(f) + '">' + dlText + '</a>' +
        (guestPrintOn && !isVid && !isGif ? reqButtonHtml(m[1], f, '/e/' + m[1] + '/print/' + encodeURIComponent(f), String(i)) : '') + '</div></div>';
    });
    const others = guestView !== 'only' ? '<div class="one" style="padding-top:0"><a class="btn alt" href="/e/' + m[1] + '/">Show photos with other guests</a></div>' : '';
    const body = '<div style="text-align:center;padding:0 16px"><h1>Your photos</h1><p class="sub">' + esc(evName) + '</p></div>' +
      (items.length ? items.join('') + savingTipHtml(null, null, evName) : '<p class="empty">This photo isn’t here yet. Wait a moment and refresh.</p><script>setTimeout(function(){location.reload()},5000)</script>') + others;
    return send(res, 200, 'text/html; charset=utf-8', page('Your photos', body + holoFor(mine)));
  }
  let file;
  try { file = decodeURIComponent(m[3]); } catch { file = ''; }
  if (!file || file !== basename(file) || file.startsWith('.') || !IMG_RE.test(file)) return send(res, 404, 'text/plain', 'Not found');
  const full = findFileInDir(dir, file);
  if (!full) {
    if (m[2] === 'p') {
      const isVid = VIDEO_RE.test(file);
      const title = isVid ? 'Your 360 video is on its way' : 'Your photo is on its way';
      const msg = isVid ? 'We’re applying the effects, speed ramps and music. It appears here in a few seconds. You can keep this page open.' : 'This photo isn’t here yet. Wait a moment and refresh.';
      const body = '<div class="one"><h1>' + title + '</h1><p class="sub">' + esc(evName) + '</p>' +
        '<div style="margin:28px auto;width:44px;height:44px;border:4px solid #E4DCCF;border-top-color:#C93D27;border-radius:50%;animation:pbSpin 1s linear infinite"></div>' +
        '<style>@keyframes pbSpin{to{transform:rotate(360deg)}}</style>' +
        '<p class="empty" style="padding:10px 0 20px">' + msg + '</p>' +
        (guestView !== 'only' ? '<a class="btn alt" href="/e/' + m[1] + '/">All photos</a>' : '') + '</div>' +
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
    const isSoloPhoto = /_solo_\d+/i.test(file);
    const src = '/e/' + m[1] + '/f/' + encodeURIComponent(file);
    const media = /^video\//.test(type) ? '<video src="' + src + '" controls playsinline autoplay muted loop></video>' : '<img src="' + src + '" alt="' + (isGif ? 'Your GIF' : isSoloPhoto ? 'Solo photo' : 'Your photo') + '">';
    const itemTitle = isVid ? 'Your video' : isGif ? 'Your GIF' : isSoloPhoto ? 'Solo photo' : 'Your photo';
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
      s.listen(port, '0.0.0.0', () => { server = s; sharePort = port; attachBridgeUpgrade(s); resolve(port); });
    };
    tryNext();
  });
}
export function stopShareServer() { try { server && server.close(); } catch { /* ignore */ } }
