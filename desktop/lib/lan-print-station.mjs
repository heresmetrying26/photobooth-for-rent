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
import { deflateSync } from 'node:zlib';
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

export function recordStationJob(entry) {
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

const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  let c = 0xffffffff;
  for (let i = 0; i < 4; i++) c = PNG_CRC_TABLE[(c ^ tb[i]) & 0xff] ^ (c >>> 8);
  for (let i = 0; i < data.length; i++) c = PNG_CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, tb, data, crc]);
}

/** Generate a pure-JS RGBA PNG test print image (no native canvas/sharp dependency). */
export function createStationTestPngDataUrl({ twoUp = false } = {}) {
  const w = twoUp ? 300 : 600;
  const h = 900;
  const stride = 1 + w * 4;
  const raw = Buffer.allocUnsafe(stride * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const isBorder = xBorderBand(y, h);
    for (let x = 0; x < w; x++) {
      const p = rowStart + 1 + x * 4;
      let r = 248, g = 244, b = 237;
      if (x < 18 || x >= w - 18 || isBorder) { r = 201; g = 61; b = 39; }
      else if (y >= 90 && y < 380 && x >= 36 && x < w - 36) { r = 28; g = 26; b = 30; }
      else if (y >= 420 && y < 740 && x >= 36 && x < w - 36) { r = 31; g = 111; b = 98; }
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

function xBorderBand(y, h) {
  return y < 18 || y >= h - 18;
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
        recordStationJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: true });
        log('Printed ' + pagesCount + ' page(s) on "' + printer + '" from iPad/tablet ' + fromIp);
        return sendJson(res, 200, resPrint);
      }
      const errMsg = (resPrint && resPrint.error) || 'Print failed.';
      recordStationJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
      return sendJson(res, 500, { ok: false, error: errMsg });
    } catch (e) {
      const errMsg = (e && e.message) || 'Print failed.';
      recordStationJob({ printer, pages: pagesCount, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
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
  .wrap{max-width:820px;margin:0 auto;}
  h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em;}
  .sub{margin:0 0 18px;color:var(--dim);}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px;}
  .pinbox{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;background:#1c1a1e;color:#fff;border-radius:14px;padding:16px 20px;}
  .pin{font:800 36px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#ffd166;}
  .ip{font:700 17px/1.4 ui-monospace,Consolas,monospace;color:#7ee787;}
  .btn{border:1px solid var(--line);background:#fff;color:var(--ink);font:700 13px inherit;padding:8px 13px;border-radius:999px;cursor:pointer;}
  .btn:hover:not(:disabled){border-color:var(--red);color:var(--red);}
  .btn:disabled{opacity:.55;cursor:default;}
  .btn.dark{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff;}
  .msg{display:none;margin:10px 0 0;padding:10px 13px;border-radius:10px;background:var(--okbg);color:var(--ok);font-size:13.5px;font-weight:700;}
  .msg.err{background:#fdecea;color:#9b2c1f;}
  ul.pr{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:8px;}
  ul.pr li{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#faf8f4;}
  .pr-acts{display:flex;gap:6px;flex-wrap:wrap;}
  ol.steps{margin:8px 0 0;padding-left:20px;color:var(--dim);font-size:14px;line-height:1.65;}
  ol.steps b{color:var(--ink);}
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
  <p class="sub">Keep Print Helper open on the laptop plugged into your printer (zero internet and zero extra device slots needed). Pair the iPad app using the Wi-Fi address and PIN below.</p>
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
    <div class="msg" id="dashMsg" role="status"></div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
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
  <div class="card">
    <b>Where to Click on the iPad App</b>
    <ol class="steps">
      <li>Join the <b>same Wi-Fi router</b> or <b>Windows Mobile Hotspot</b> on both this laptop and your iPad.</li>
      <li>If using a DSLR on the iPad (e.g. Canon 550D), plug it into the iPad via USB and choose it in <b>Setup &rarr; Camera</b>.</li>
      <li>Open <b>Setup &rarr; Printer</b> on the iPad app, pick <b>4&times;6</b> or <b>2&times;6 strips</b>, and switch on <b>Laptop Print Station (Wi-Fi &middot; Offline USB printer)</b>.</li>
      <li>Tap <b>Find Laptop on Wi-Fi</b> (or type the IP above), enter the <b>6-Digit PIN</b>, and tap <b>Connect</b>.</li>
      <li>Under <b>Printer 1</b>, pick your Mitsubishi / DNP / HiTi printer and turn on <b>Auto-print</b> if desired.</li>
    </ol>
  </div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function say(msg,isErr){const el=document.getElementById('dashMsg');el.textContent=msg;el.className='msg'+(isErr?' err':'');el.style.display=msg?'block':'none';}
async function load(refresh){
  try{
    const r = await fetch('/station/info' + (refresh ? '?refresh=1' : ''), { cache:'no-store' });
    const j = await r.json();
    document.getElementById('pinTxt').textContent = j.pin || '------';
    const ips = (j.addresses || []).map(a => a.ip + (a.port && a.port !== 47777 ? ':' + a.port : '') + ' (' + a.kind + ')');
    document.getElementById('ipList').innerHTML = ips.length ? ips.map(esc).join('<br>') : ('Port ' + (j.port || 47777) + ' (join Wi-Fi or Hotspot)');
    const prs = j.printers || [];
    document.getElementById('prList').innerHTML = prs.length ? prs.map(p =>
      '<li><span><b>'+esc(p)+'</b></span><span class="pr-acts">' +
      '<button class="btn" data-cfg="'+esc(p)+'" type="button">Driver Preferences</button>' +
      '<button class="btn" data-test="'+esc(p)+'" data-twoup="0" type="button">Test 4\u00d76</button>' +
      '<button class="btn" data-test="'+esc(p)+'" data-twoup="1" type="button">Test 2\u00d76 Cut</button>' +
      '</span></li>'
    ).join('') : '<li>No printers found. Connect the printer via USB and install its Windows/Mac driver, then click Refresh Printers.</li>';
    const jobs = j.jobs || [];
    document.getElementById('jobBody').innerHTML = jobs.length ? jobs.map(x => '<tr><td>'+new Date(x.at).toLocaleTimeString()+'</td><td>'+esc(x.from)+'</td><td>'+esc(x.printer)+'</td><td>'+esc(x.paper)+'</td><td><span class="tag '+(x.ok?'':'err')+'">'+(x.ok?'Printed':esc(x.error||'Error'))+'</span></td></tr>').join('') : '<tr><td colspan="5" style="color:var(--dim)">Waiting for prints…</td></tr>';
  }catch(e){}
}
document.getElementById('newPinBtn').onclick = async () => {
  const r = await fetch('/station/new-pin', { method:'POST' });
  const j = await r.json().catch(() => ({}));
  say(r.ok && j.ok ? ('New 6-digit PIN generated: ' + j.pin) : (j.error || 'Could not update PIN.'), !(r.ok && j.ok));
  load(false);
};
document.getElementById('refPrBtn').onclick = async () => {
  say('Refreshing printers…');
  await load(true);
  say('Printer list refreshed.');
};
document.getElementById('prList').onclick = async (e) => {
  const cfgBtn = e.target.closest('[data-cfg]');
  if (cfgBtn) {
    cfgBtn.disabled = true;
    say('Opening Driver Preferences for ' + cfgBtn.dataset.cfg + '…');
    try {
      const r = await fetch('/printer/configure', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ printer: cfgBtn.dataset.cfg }) });
      const j = await r.json().catch(() => ({}));
      say(r.ok && j.ok ? (j.message || 'Driver Preferences opened.') : (j.error || 'Could not open Driver Preferences.'), !(r.ok && j.ok));
    } finally { cfgBtn.disabled = false; }
    return;
  }
  const tstBtn = e.target.closest('[data-test]');
  if (tstBtn) {
    const twoUp = tstBtn.dataset.twoup === '1';
    tstBtn.disabled = true;
    say('Sending ' + (twoUp ? '2\u00d76 cut' : '4\u00d76') + ' test print to ' + tstBtn.dataset.test + '…');
    try {
      const r = await fetch('/station/test-print', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ printer: tstBtn.dataset.test, twoUp }) });
      const j = await r.json().catch(() => ({}));
      say(r.ok && j.ok ? ('Test print sent to ' + tstBtn.dataset.test + ' \u2713') : (j.error || 'Test print failed.'), !(r.ok && j.ok));
      await load(false);
    } finally { tstBtn.disabled = false; }
  }
};
load(true);
setInterval(() => load(false), 3000);
</script>
</body>
</html>`;
}
