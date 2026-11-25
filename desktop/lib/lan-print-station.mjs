// Offline Wi-Fi / LAN Laptop Print Station handler (port 47777-47797).
//
// Shared by both tools/print-helper/ (0 license slots used) and desktop/lib/photos.mjs
// so an offline iPad / Android booth on the same Wi-Fi router or Windows Mobile Hotspot
// can print straight to USB / Windows-driver printers (Mitsubishi CP-D80DW, DNP, HiTi, etc.)
// with zero internet and zero OS print dialogs.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { allBridgeUrls } from './guest-bridge.mjs';

const FAIL_MAX = 10;
const FAIL_MS = 10 * 60_000;
const MAX_BODY = 80 * 1024 * 1024;
const MAX_LOGS = 30;
const fails = new Map();
const jobLog = [];

let cfg = {
  getPort: () => 0,
  getPrinters: async () => [],
  getPaper: async () => ({ ok: false, error: 'Unsupported' }),
  printJob: async () => ({ ok: false, error: 'Unsupported' }),
  pinFile: '',
  appKind: 'print-helper',
  version: '',
  logger: () => { }
};

let stationPin = '';

function newPin() {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

export function validStationPin(p) {
  return /^\d{6}$/.test(String(p || '').trim());
}

function loadOrCreatePin(pinFile) {
  if (pinFile && existsSync(pinFile)) {
    try {
      const saved = JSON.parse(readFileSync(pinFile, 'utf8'));
      if (saved && validStationPin(saved.pin)) return String(saved.pin);
    } catch { /* fall through to generate */ }
  }
  const pin = newPin();
  persistPin(pinFile, pin);
  return pin;
}

function persistPin(pinFile, pin) {
  if (!pinFile) return;
  try {
    mkdirSync(dirname(pinFile), { recursive: true });
    writeFileSync(pinFile, JSON.stringify({ pin, updatedAt: Date.now() }), 'utf8');
  } catch { /* ignore disk write errors */ }
}

function log(msg) {
  try { cfg.logger('[LAN Print Station] ' + msg); } catch { /* ignore */ }
}

/** Initialise shared LAN Print Station state and callbacks. */
export function initLanStation(options = {}) {
  cfg = {
    getPort: typeof options.getPort === 'function' ? options.getPort : () => 0,
    getPrinters: typeof options.getPrinters === 'function' ? options.getPrinters : async () => [],
    getPaper: typeof options.getPaper === 'function' ? options.getPaper : async () => ({ ok: false, error: 'Unsupported' }),
    printJob: typeof options.printJob === 'function' ? options.printJob : async () => ({ ok: false, error: 'Unsupported' }),
    pinFile: typeof options.pinFile === 'string' ? options.pinFile : '',
    appKind: typeof options.appKind === 'string' ? options.appKind : 'print-helper',
    version: typeof options.version === 'string' ? options.version : '',
    logger: typeof options.logger === 'function' ? options.logger : () => { }
  };
  stationPin = loadOrCreatePin(cfg.pinFile);
  return getLanStationInfo();
}

/** Generate a fresh 6-digit pairing PIN and reset failed-attempt lockouts. */
export function rotateLanStationPin() {
  stationPin = newPin();
  fails.clear();
  persistPin(cfg.pinFile, stationPin);
  log('Rotated LAN Print Station PIN to ' + stationPin);
  return stationPin;
}

/** Return scored LAN IPv4 addresses bound to this laptop's active share port. */
export function lanStationAddresses(nets = networkInterfaces()) {
  const port = Number(cfg.getPort()) || 0;
  if (!port) return [];
  // Reuse the network scoring from guest-bridge by stripping the /bridge/<token> suffix.
  return allBridgeUrls(nets).map((x) => ({
    ip: x.ip,
    name: x.name,
    kind: x.kind,
    score: x.score,
    port,
    baseUrl: 'http://' + x.ip + ':' + port + '/lan-station'
  }));
}

/** Non-sensitive info + local dashboard summary (PIN included for local machine UI only). */
export function getLanStationInfo() {
  const port = Number(cfg.getPort()) || 0;
  return {
    enabled: true,
    kind: cfg.appKind,
    version: cfg.version,
    host: hostname(),
    port,
    pin: stationPin,
    addresses: lanStationAddresses(),
    jobs: jobLog.slice(0, MAX_LOGS)
  };
}

export function isLoopbackAddress(req) {
  const addr = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1';
}

function corsHeaders(extra) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-pb-pin',
    'access-control-allow-private-network': 'true',
    'cross-origin-resource-policy': 'cross-origin',
    'access-control-max-age': '600',
    ...(extra || {})
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders()
  });
  res.end(JSON.stringify(obj));
  return true;
}

function clientKey(req) {
  return String((req && req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

function isRateLimited(req) {
  const now = Date.now();
  const k = clientKey(req);
  const recent = (fails.get(k) || []).filter((t) => now - t < FAIL_MS);
  fails.set(k, recent);
  return recent.length >= FAIL_MAX;
}

function noteFailedPin(req) {
  const k = clientKey(req);
  const recent = (fails.get(k) || []).filter((t) => Date.now() - t < FAIL_MS);
  recent.push(Date.now());
  fails.set(k, recent);
}

function checkPin(req, url) {
  if (!stationPin) stationPin = newPin();
  const supplied = String(req.headers['x-pb-pin'] || url.searchParams.get('pin') || '').trim();
  if (!validStationPin(supplied)) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(stationPin).digest();
  return timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Bad JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function recordJob(entry) {
  jobLog.unshift({
    at: Date.now(),
    printer: String(entry.printer || ''),
    pages: Number(entry.pages) || 1,
    paper: String(entry.paper || ''),
    from: String(entry.from || ''),
    ok: !!entry.ok,
    error: entry.error ? String(entry.error) : ''
  });
  if (jobLog.length > MAX_LOGS) jobLog.length = MAX_LOGS;
}

/**
 * Handle /lan-station/* HTTP requests on the shared LAN server (port 47777+).
 * Returns true if the request path started with /lan-station/, false otherwise.
 */
export async function handleLanStationHttp(req, res, url) {
  const p = url.pathname;
  if (p !== '/lan-station' && !p.startsWith('/lan-station/')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders({ 'cache-control': 'no-store' }));
    res.end();
    return true;
  }

  // Unauthenticated LAN discovery beacon: exposes no printers and no PIN.
  if (req.method === 'GET' && (p === '/lan-station/hello' || p === '/lan-station')) {
    return sendJson(res, 200, {
      ok: true,
      app: 'photobooth4u-lan-station',
      kind: cfg.appKind,
      version: cfg.version,
      host: hostname(),
      port: Number(cfg.getPort()) || 0
    });
  }

  if (isRateLimited(req)) {
    return sendJson(res, 429, { ok: false, reason: 'rate', error: 'Too many wrong PIN attempts. Wait a few minutes or generate a new PIN on the laptop.' });
  }
  if (!checkPin(req, url)) {
    noteFailedPin(req);
    return sendJson(res, 401, { ok: false, reason: 'pin', error: 'Wrong Print Station PIN. Check the 6-digit PIN shown on the laptop.' });
  }

  if (req.method === 'GET' && p === '/lan-station/status') {
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      const list = await cfg.getPrinters(refresh);
      return sendJson(res, 200, {
        ok: true,
        app: 'photobooth4u-lan-station',
        kind: cfg.appKind,
        version: cfg.version,
        host: hostname(),
        port: Number(cfg.getPort()) || 0,
        printers: Array.isArray(list) ? list : []
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || 'Could not list printers.' });
    }
  }

  if (req.method === 'GET' && p === '/lan-station/paper') {
    const name = String(url.searchParams.get('printer') || '').trim();
    const w = Number(url.searchParams.get('w')) || 0;
    const h = Number(url.searchParams.get('h')) || 0;
    const twoUpQ = url.searchParams.get('twoUp');
    const twoUp = twoUpQ === '1' ? true : twoUpQ === '0' ? false : undefined;
    try {
      const out = await cfg.getPaper({ printer: name, widthMm: w, heightMm: h, twoUp });
      return sendJson(res, out && out.ok === false && /No printer called/i.test(out.error || '') ? 404 : 200, out || { ok: false });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || 'Paper lookup failed.' });
    }
  }

  if (req.method === 'POST' && p === '/lan-station/print') {
    let body;
    try {
      body = await readJsonBody(req, MAX_BODY);
    } catch (e) {
      const tooBig = /too large/i.test((e && e.message) || '');
      return sendJson(res, tooBig ? 413 : 400, { ok: false, error: (e && e.message) || 'Bad request' });
    }
    const printer = String((body && body.printer) || '').trim();
    const pagesCount = Array.isArray(body && body.pages) ? body.pages.length : 0;
    const paperLabel = (body && (body.paperName || (body.widthMm && body.heightMm ? Math.round(body.widthMm) + 'x' + Math.round(body.heightMm) + 'mm' : ''))) || '';
    const fromIp = clientKey(req);
    try {
      const resPrint = await cfg.printJob(body || {});
      if (resPrint && resPrint.ok) {
        recordJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: true });
        log('Printed ' + pagesCount + ' page(s) on "' + printer + '" from iPad/tablet ' + fromIp);
        return sendJson(res, 200, resPrint);
      }
      const errMsg = (resPrint && resPrint.error) || 'Print failed.';
      recordJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
      return sendJson(res, 500, { ok: false, error: errMsg });
    } catch (e) {
      const errMsg = (e && e.message) || 'Print failed.';
      recordJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
      return sendJson(res, 500, { ok: false, error: errMsg });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

/** Render a clean loopback-only dashboard HTML page for Print Helper users at http://127.0.0.1:17321/ */
export function renderStationDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>photobooth4u · Offline Print Station</title>
<style>
  :root{--bg:#f5f1ea;--card:#fff;--ink:#1c1a1e;--dim:#6b666c;--line:#e4dccf;--red:#c93d27;--ok:#1f6f62;--okbg:#e6f4f1;}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  .wrap{max-width:780px;margin:0 auto;}
  h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em;}
  .sub{margin:0 0 18px;color:var(--dim);}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px;}
  .pinbox{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;background:#1c1a1e;color:#fff;border-radius:14px;padding:16px 20px;}
  .pin{font:800 36px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#ffd166;}
  .ip{font:700 17px/1.4 ui-monospace,Consolas,monospace;color:#7ee787;}
  .btn{border:1px solid var(--line);background:#fff;color:var(--ink);font:700 13.5px inherit;padding:9px 14px;border-radius:999px;cursor:pointer;}
  .btn:hover{border-color:var(--red);color:var(--red);}
  .btn.dark{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff;}
  ul.pr{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:8px;}
  ul.pr li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#faf8f4;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:8px;}
  th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--line);}
  th{border-top:0;font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);}
  .tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--okbg);color:var(--ok);}
  .tag.err{background:#fdecea;color:#9b2c1f;}
</style>
</head>
<body>
<div class="wrap">
  <h1>Offline iPad Print Station</h1>
  <p class="sub">Keep this helper open on the laptop plugged into your printer. On the iPad app, go to <b>Setup &rsaquo; Printer &rsaquo; Laptop Print Station (Offline Wi-Fi)</b> and connect with an address and PIN below.</p>
  <div class="card">
    <div class="pinbox">
      <div>
        <div style="font-size:12px;opacity:.75;text-transform:uppercase;letter-spacing:.12em;">Laptop Wi-Fi Address</div>
        <div class="ip" id="ipList">Detecting…</div>
      </div>
      <div>
        <div style="font-size:12px;opacity:.75;text-transform:uppercase;letter-spacing:.12em;">6-Digit PIN</div>
        <div class="pin" id="pinTxt">------</div>
      </div>
      <button class="btn dark" id="newPinBtn" type="button">New PIN</button>
    </div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <b>Installed Printers on This Laptop</b>
      <button class="btn" id="refPrBtn" type="button">Refresh Printers</button>
    </div>
    <ul class="pr" id="prList"><li>Loading…</li></ul>
  </div>
  <div class="card">
    <b>Recent Prints from iPad / Tablet</b>
    <table><thead><tr><th>Time</th><th>From</th><th>Printer</th><th>Size</th><th>Status</th></tr></thead>
    <tbody id="jobBody"><tr><td colspan="5" style="color:var(--dim)">Waiting for prints…</td></tr></tbody></table>
  </div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
async function load(refresh){
  try{
    const r = await fetch('/station/info' + (refresh ? '?refresh=1' : ''), { cache:'no-store' });
    const j = await r.json();
    document.getElementById('pinTxt').textContent = j.pin || '------';
    const ips = (j.addresses || []).map(a => a.ip + (a.port && a.port !== 47777 ? ':' + a.port : '') + ' (' + a.kind + ')');
    document.getElementById('ipList').innerHTML = ips.length ? ips.map(esc).join('<br>') : ('Port ' + (j.port || 47777) + ' (join Wi-Fi or Hotspot)');
    const prs = j.printers || [];
    document.getElementById('prList').innerHTML = prs.length ? prs.map(p => '<li><span>'+esc(p)+'</span><button class="btn" data-cfg="'+esc(p)+'" type="button">Driver Preferences</button></li>').join('') : '<li>No printers found.</li>';
    const jobs = j.jobs || [];
    document.getElementById('jobBody').innerHTML = jobs.length ? jobs.map(x => '<tr><td>'+new Date(x.at).toLocaleTimeString()+'</td><td>'+esc(x.from)+'</td><td>'+esc(x.printer)+'</td><td>'+esc(x.paper)+'</td><td><span class="tag '+(x.ok?'':'err')+'">'+(x.ok?'Printed':esc(x.error||'Error'))+'</span></td></tr>').join('') : '<tr><td colspan="5" style="color:var(--dim)">Waiting for prints…</td></tr>';
  }catch(e){}
}
document.getElementById('newPinBtn').onclick = async () => {
  await fetch('/station/new-pin', { method:'POST' });
  load(false);
};
document.getElementById('refPrBtn').onclick = () => load(true);
document.getElementById('prList').onclick = async (e) => {
  const b = e.target.closest('[data-cfg]'); if (!b) return;
  b.disabled = true;
  try { await fetch('/printer/configure', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ printer: b.dataset.cfg }) }); }
  finally { b.disabled = false; }
};
load(true);
setInterval(() => load(false), 3000);
</script>
</body>
</html>`;
}
