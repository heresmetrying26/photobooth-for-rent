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
const MAX_SELECTED_PRINTERS = 120;
const MAX_TEST_SIZES = 16;
const fails = new Map();
const jobLog = [];

export const DEFAULT_STATION_TEST_SIZES = Object.freeze([
  Object.freeze({ id: '4x6', label: '4\u00d76', widthMm: 101.6, heightMm: 152.4, twoUp: false, builtin: true }),
  Object.freeze({ id: '2x6-cut', label: '2\u00d76 Cut', widthMm: 101.6, heightMm: 152.4, twoUp: true, builtin: true })
]);

export const PRESET_STATION_TEST_SIZES = Object.freeze([
  Object.freeze({ id: '3.5x5', label: '3.5\u00d75 (3R)', widthMm: 88.9, heightMm: 127, twoUp: false }),
  Object.freeze({ id: '5x7', label: '5\u00d77 (5R)', widthMm: 127, heightMm: 177.8, twoUp: false }),
  Object.freeze({ id: '6x8', label: '6\u00d78 (6R)', widthMm: 152.4, heightMm: 203.2, twoUp: false }),
  Object.freeze({ id: '8x10', label: '8\u00d710 (8R)', widthMm: 203.2, heightMm: 254, twoUp: false }),
  Object.freeze({ id: 'selphy', label: 'Postcard 100\u00d7148', widthMm: 100, heightMm: 148, twoUp: false }),
  Object.freeze({ id: '2.5x7.5', label: 'Keychain 2.5\u00d77.5', widthMm: 63.5, heightMm: 190.5, twoUp: false }),
  Object.freeze({ id: 'a6', label: 'A6', widthMm: 105, heightMm: 148, twoUp: false }),
  Object.freeze({ id: 'a5', label: 'A5', widthMm: 148, heightMm: 210, twoUp: false }),
  Object.freeze({ id: 'a4', label: 'A4', widthMm: 210, heightMm: 297, twoUp: false }),
  Object.freeze({ id: 'letter', label: 'Letter', widthMm: 215.9, heightMm: 279.4, twoUp: false })
]);

let cfg = {
  getPort: () => 0,
  isEnabled: () => true,
  getPrinters: async () => [],
  getPaper: async () => ({ ok: false, error: 'Unsupported' }),
  printJob: async () => ({ ok: false, error: 'Unsupported' }),
  onJob: () => { },
  pinFile: '',
  appKind: 'print-helper',
  version: '',
  logger: () => { }
};

let stationPin = '';
let selectedPrinters = null;      // null = not filtered yet (all available); string[] = explicit allowlist
let hideUnusedPrinters = false;
let customTestSizes = null;       // null = defaults (4x6, 2x6 Cut); array = user-customized list

function newPin() {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

export function validStationPin(p) {
  return /^\d{6}$/.test(String(p || '').trim());
}

function clampMm(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10 || n > 1220) return fallback;
  return Math.round(n * 100) / 100;
}

function formatAutoSizeLabel(widthMm, heightMm, twoUp) {
  const inW = Math.round((widthMm / 25.4) * 100) / 100;
  const inH = Math.round((heightMm / 25.4) * 100) / 100;
  const closeIn = (x) => Math.abs(x * 2 - Math.round(x * 2)) < 0.04;
  const base = closeIn(inW) && closeIn(inH)
    ? (inW + '\u00d7' + inH)
    : (Math.round(widthMm) + '\u00d7' + Math.round(heightMm) + ' mm');
  return twoUp ? (base + ' Cut') : base;
}

export function sanitizeSelectedPrinters(list) {
  if (list === null || list === undefined) return null;
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_SELECTED_PRINTERS) break;
  }
  return out;
}

export function sanitizeStationTestSizes(list) {
  if (list === null || list === undefined) return null;
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const widthMm = clampMm(raw.widthMm, 0);
    const heightMm = clampMm(raw.heightMm, 0);
    if (!(widthMm >= 10 && heightMm >= 10)) continue;
    const twoUp = !!raw.twoUp;
    const paperName = typeof raw.paperName === 'string' ? raw.paperName.trim().slice(0, 120) : '';
    const rawLabel = typeof raw.label === 'string' ? raw.label.trim().slice(0, 40) : '';
    const label = rawLabel || formatAutoSizeLabel(widthMm, heightMm, twoUp);
    const sig = [Math.round(widthMm * 10), Math.round(heightMm * 10), twoUp ? '1' : '0', paperName].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const cleanId = String(raw.id || '').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40)
      || ('sz-' + Math.round(widthMm) + 'x' + Math.round(heightMm) + (twoUp ? '-2up' : '') + (out.length ? '-' + out.length : ''));
    const entry = {
      id: cleanId,
      label,
      widthMm,
      heightMm,
      twoUp,
      ...(paperName ? { paperName } : {}),
      ...(raw.builtin ? { builtin: true } : {})
    };
    out.push(entry);
    if (out.length >= MAX_TEST_SIZES) break;
  }
  return out.length ? out : null;
}

export function getStationTestSizes() {
  const src = Array.isArray(customTestSizes) && customTestSizes.length
    ? customTestSizes
    : DEFAULT_STATION_TEST_SIZES;
  return src.map((x) => ({ ...x }));
}

function loadStationState(pinFile) {
  let pin = '';
  let sel = null;
  let hideUnused = false;
  let sizes = null;
  let existedValidPin = false;
  if (pinFile && existsSync(pinFile)) {
    try {
      const saved = JSON.parse(readFileSync(pinFile, 'utf8'));
      if (saved && validStationPin(saved.pin)) {
        pin = String(saved.pin);
        existedValidPin = true;
      }
      if (saved && Object.prototype.hasOwnProperty.call(saved, 'selectedPrinters')) {
        sel = sanitizeSelectedPrinters(saved.selectedPrinters);
      }
      if (saved && typeof saved.hideUnusedPrinters === 'boolean') {
        hideUnused = saved.hideUnusedPrinters;
      }
      if (saved && Object.prototype.hasOwnProperty.call(saved, 'testSizes')) {
        sizes = sanitizeStationTestSizes(saved.testSizes);
      }
    } catch { /* fall through to generate */ }
  }
  if (!pin) pin = newPin();
  stationPin = pin;
  selectedPrinters = sel;
  hideUnusedPrinters = !!(hideUnused && sel !== null);
  customTestSizes = sizes;
  if (!existedValidPin) persistStationState(pinFile);
}

function persistStationState(pinFile) {
  if (!pinFile) return;
  try {
    mkdirSync(dirname(pinFile), { recursive: true });
    writeFileSync(pinFile, JSON.stringify({
      pin: stationPin,
      updatedAt: Date.now(),
      selectedPrinters,
      hideUnusedPrinters: !!hideUnusedPrinters,
      testSizes: customTestSizes
    }), 'utf8');
  } catch { /* ignore disk write errors */ }
}

function log(msg) {
  try { cfg.logger('[LAN Print Station] ' + msg); } catch { /* ignore */ }
}

/** Initialise shared LAN Print Station state and callbacks. */
export function initLanStation(options = {}) {
  cfg = {
    getPort: typeof options.getPort === 'function' ? options.getPort : () => 0,
    isEnabled: typeof options.isEnabled === 'function' ? options.isEnabled : () => true,
    getPrinters: typeof options.getPrinters === 'function' ? options.getPrinters : async () => [],
    getPaper: typeof options.getPaper === 'function' ? options.getPaper : async () => ({ ok: false, error: 'Unsupported' }),
    printJob: typeof options.printJob === 'function' ? options.printJob : async () => ({ ok: false, error: 'Unsupported' }),
    onJob: typeof options.onJob === 'function' ? options.onJob : () => { },
    pinFile: typeof options.pinFile === 'string' ? options.pinFile : '',
    appKind: typeof options.appKind === 'string' ? options.appKind : 'print-helper',
    version: typeof options.version === 'string' ? options.version : '',
    logger: typeof options.logger === 'function' ? options.logger : () => { }
  };
  loadStationState(cfg.pinFile);
  return getLanStationInfo();
}

/** Generate a fresh 6-digit pairing PIN and reset failed-attempt lockouts. */
export function rotateLanStationPin() {
  stationPin = newPin();
  fails.clear();
  persistStationState(cfg.pinFile);
  log('Rotated LAN Print Station PIN to ' + stationPin);
  return stationPin;
}

/** Update allowed printers + "hide unused printers" visibility and persist to disk. */
export function setStationPrinterFilter(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'selectedPrinters')) {
    selectedPrinters = sanitizeSelectedPrinters(opts.selectedPrinters);
  }
  if (typeof opts.hideUnusedPrinters === 'boolean') {
    hideUnusedPrinters = opts.hideUnusedPrinters;
  }
  if (selectedPrinters === null) hideUnusedPrinters = false;
  persistStationState(cfg.pinFile);
  return getLanStationInfo();
}

/** Update dynamic Test Print paper sizes (pass null to restore defaults). */
export function setStationTestSizes(sizes) {
  customTestSizes = sizes === null ? null : sanitizeStationTestSizes(sizes);
  persistStationState(cfg.pinFile);
  return getLanStationInfo();
}

/** Filter installed printers against Print Station's active allowlist (when customized). */
export function filterStationPrinters(allPrinters) {
  const all = Array.isArray(allPrinters) ? allPrinters.map((p) => String(p || '').trim()).filter(Boolean) : [];
  if (selectedPrinters === null) return all;
  const allow = new Set(selectedPrinters);
  return all.filter((p) => allow.has(p));
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
    jobs: jobLog.slice(0, MAX_LOGS),
    selectedPrinters: selectedPrinters ? selectedPrinters.slice() : null,
    hideUnusedPrinters: !!hideUnusedPrinters,
    testSizes: getStationTestSizes(),
    testSizesCustomized: Array.isArray(customTestSizes) && customTestSizes.length > 0
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
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
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

/** Generate a pure-JS RGBA PNG test print image proportionally sized to any widthMm x heightMm. */
export function createStationTestPngDataUrl({ widthMm = 101.6, heightMm = 152.4, twoUp = false } = {}) {
  const rawW = clampMm(widthMm, 101.6);
  const rawH = clampMm(heightMm, 152.4);
  const landscape = rawW > rawH + 0.5;
  const shortMm = Math.min(rawW, rawH);
  const longMm = Math.max(rawW, rawH);
  const stripHalf = twoUp && shortMm / longMm >= 0.45;
  const effW = stripHalf ? shortMm / 2 : (landscape ? rawW : shortMm);
  const effH = landscape && !stripHalf ? rawH : longMm;
  const maxPx = 900;
  let w, h;
  if (effW >= effH) {
    w = maxPx;
    h = Math.max(120, Math.round(maxPx * (effH / effW)));
  } else {
    h = maxPx;
    w = Math.max(120, Math.round(maxPx * (effW / effH)));
  }
  const border = Math.max(8, Math.round(Math.min(w, h) * 0.03));
  const padX = Math.max(border + 6, Math.round(w * 0.06));
  const topA = Math.round(h * 0.10), botA = Math.round(h * 0.42);
  const topB = Math.round(h * 0.47), botB = Math.round(h * 0.82);
  const stride = 1 + w * 4;
  const raw = Buffer.allocUnsafe(stride * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    const isBorder = y < border || y >= h - border;
    const inA = y >= topA && y < botA;
    const inB = y >= topB && y < botB;
    for (let x = 0; x < w; x++) {
      const p = rowStart + 1 + x * 4;
      let r = 248, g = 244, b = 237;
      if (isBorder || x < border || x >= w - border) { r = 201; g = 61; b = 39; }
      else if (x >= padX && x < w - padX && inA) { r = 28; g = 26; b = 30; }
      else if (x >= padX && x < w - padX && inB) { r = 31; g = 111; b = 98; }
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

/** Build a ready-to-print helper payload + readable log label for any test print spec or legacy boolean twoUp. */
export function buildStationTestJob(printer, specOrTwoUp) {
  const name = String(printer || '').trim();
  if (!name) return { ok: false, error: 'Choose a printer first.' };
  const isObj = !!specOrTwoUp && typeof specOrTwoUp === 'object';
  const twoUp = isObj ? !!specOrTwoUp.twoUp : !!specOrTwoUp;
  const widthMm = isObj ? clampMm(specOrTwoUp.widthMm, 101.6) : 101.6;
  const heightMm = isObj ? clampMm(specOrTwoUp.heightMm, 152.4) : 152.4;
  const paperName = isObj && typeof specOrTwoUp.paperName === 'string' ? specOrTwoUp.paperName.trim().slice(0, 120) : '';
  const rawLabel = isObj && typeof specOrTwoUp.label === 'string' ? specOrTwoUp.label.trim().slice(0, 40) : '';
  const baseLabel = rawLabel || (twoUp ? '2x6 strips (cut)' : (widthMm === 101.6 && heightMm === 152.4 ? '4x6 test' : formatAutoSizeLabel(widthMm, heightMm, twoUp)));
  const jobLabel = baseLabel + (twoUp && !/cut|2\s*[x\u00d7]\s*6/i.test(baseLabel) ? ' (2-up cut)' : '');
  return {
    ok: true,
    printer: name,
    jobLabel,
    printBody: {
      printer: name,
      quality: 'best',
      twoUp,
      widthMm,
      heightMm,
      ...(paperName ? { paperName } : {}),
      pages: [createStationTestPngDataUrl({ widthMm, heightMm, twoUp })]
    }
  };
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

  if (!cfg.isEnabled()) {
    return sendJson(res, 403, { ok: false, reason: 'disabled', error: 'Print Station is not enabled on this laptop licence. Ask your admin to turn it on.' });
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
      const rawList = await cfg.getPrinters(refresh);
      const allList = Array.isArray(rawList) ? rawList.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const visible = filterStationPrinters(allList);
      return sendJson(res, 200, {
        ok: true,
        app: 'photobooth4u-lan-station',
        kind: cfg.appKind,
        version: cfg.version,
        host: hostname(),
        port: Number(cfg.getPort()) || 0,
        printers: visible,
        allPrintersCount: allList.length,
        filtered: selectedPrinters !== null
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
  const presetsJson = JSON.stringify(PRESET_STATION_TEST_SIZES).replace(/</g, '\\u003c');
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
  .wrap{max-width:860px;margin:0 auto;}
  h1{margin:0 0 6px;font-size:28px;letter-spacing:-.02em;}
  .sub{margin:0 0 18px;color:var(--dim);}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px;}
  .pinbox{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;background:#1c1a1e;color:#fff;border-radius:14px;padding:16px 20px;}
  .pin{font:800 36px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#ffd166;}
  .ip{font:700 17px/1.4 ui-monospace,Consolas,monospace;color:#7ee787;}
  .btn{border:1px solid var(--line);background:#fff;color:var(--ink);font:700 13px inherit;padding:7px 12px;border-radius:999px;cursor:pointer;}
  .btn:hover:not(:disabled){border-color:var(--red);color:var(--red);}
  .btn:disabled{opacity:.55;cursor:default;}
  .btn.active{background:var(--red);border-color:var(--red);color:#fff;}
  .btn.active:hover:not(:disabled){color:#fff;opacity:.92;}
  .btn.dark{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff;}
  .msg{display:none;margin:10px 0 0;padding:10px 13px;border-radius:10px;background:var(--okbg);color:var(--ok);font-size:13.5px;font-weight:700;}
  .msg.err{background:#fdecea;color:#9b2c1f;}
  .pr-head,.toolbar,.sizes-bar,.row-in{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .pr-head{justify-content:space-between;margin-bottom:10px;}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;background:#efe7dd;color:var(--dim);}
  .badge.ok{background:var(--okbg);color:var(--ok);}
  .toolbar{margin-bottom:10px;padding:8px 10px;background:#faf8f4;border:1px solid var(--line);border-radius:12px;}
  .inp,select.inp{border:1px solid var(--line);border-radius:9px;padding:6px 10px;font:13.5px inherit;background:#fff;color:var(--ink);}
  .inp.grow{flex:1;min-width:170px;}
  ul.pr{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:7px;}
  ul.pr li{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#faf8f4;}
  ul.pr li.dim{padding:7px 12px;background:#fff;opacity:.82;}
  .pr-chk{display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:700;min-width:180px;flex:1;}
  .pr-chk input{width:17px;height:17px;accent-color:var(--red);cursor:pointer;flex:none;}
  .pr-acts{display:flex;gap:6px;flex-wrap:wrap;}
  .sizes-box{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#efe7dd;font-size:12.5px;font-weight:700;}
  .chip button{border:0;background:none;padding:0 2px;font:800 14px inherit;line-height:1;color:var(--dim);cursor:pointer;}
  .chip button:hover{color:var(--red);}
  .addbox{display:none;margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#faf8f4;gap:10px;}
  .addbox.open{display:grid;}
  .subttl{font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 5px;}
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
  <h1>Offline Print Station</h1>
  <p class="sub">Keep Print Helper open on the laptop plugged into your printer (zero internet and zero extra device slots needed). Pair the iPad or Android app using the Wi-Fi address and PIN below.</p>
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
    <div class="pr-head">
      <div class="row-in">
        <b>Printers for Print Station</b>
        <span class="badge" id="prCountBadge">Loading…</span>
      </div>
      <div class="row-in">
        <button class="btn" id="hideUnusedBtn" type="button">Hide unused</button>
        <button class="btn" id="refPrBtn" type="button">Refresh Printers</button>
      </div>
    </div>
    <div class="toolbar" id="prToolbar">
      <input class="inp grow" id="prSearch" type="search" placeholder="Search printers… (e.g. Mitsubishi, Epson, DNP)" autocomplete="off">
      <button class="btn" id="untickAllBtn" type="button">Untick all</button>
      <button class="btn" id="tickAllBtn" type="button">Tick all</button>
    </div>
    <ul class="pr" id="prList"><li>Loading…</li></ul>
    <div class="sizes-box">
      <div class="pr-head" style="margin-bottom:6px;">
        <div class="row-in">
          <b style="font-size:13.5px;">Test paper sizes</b>
          <div class="sizes-bar" id="sizeChips"></div>
        </div>
        <div class="row-in">
          <button class="btn" id="resetSizesBtn" type="button" style="display:none;">Reset defaults</button>
          <button class="btn" id="toggleAddSizeBtn" type="button">+ Add paper size</button>
        </div>
      </div>
      <div class="addbox" id="addSizeBox">
        <div>
          <div class="subttl">Quick photo &amp; booth presets</div>
          <div class="sizes-bar" id="presetRow"></div>
        </div>
        <div>
          <div class="subttl">Or pick directly from a printer’s driver</div>
          <div class="row-in">
            <select class="inp grow" id="drvPrSel" aria-label="Printer for driver paper list"></select>
            <button class="btn" id="drvLoadBtn" type="button">Load driver sizes</button>
            <select class="inp grow" id="drvSzSel" aria-label="Driver paper size" style="display:none;"></select>
            <button class="btn" id="drvAddBtn" type="button" style="display:none;">Add size</button>
          </div>
        </div>
        <div>
          <div class="subttl">Or enter any custom size</div>
          <div class="row-in">
            <input class="inp" id="csLabel" type="text" placeholder="Name (optional, e.g. 5×7)" maxlength="32" style="width:165px;">
            <input class="inp" id="csW" type="number" min="0.5" max="1220" step="0.1" placeholder="W" style="width:76px;">
            <span>&times;</span>
            <input class="inp" id="csH" type="number" min="0.5" max="1220" step="0.1" placeholder="H" style="width:76px;">
            <select class="inp" id="csU" aria-label="Unit"><option value="in">in</option><option value="mm">mm</option></select>
            <label style="display:inline-flex;align-items:center;gap:5px;font-size:13px;"><input type="checkbox" id="csTwoUp"> 2-up cut</label>
            <button class="btn active" id="csAddBtn" type="button">Add</button>
          </div>
        </div>
      </div>
    </div>
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
      <li>Open <b>Setup &rarr; Printer</b> on the iPad app, pick your paper size (e.g. <b>4&times;6</b>, <b>2&times;6 strips</b>, <b>5&times;7</b>, <b>6&times;8</b>, <b>A4</b>, or <b>More paper sizes &rarr; Own size</b>), and switch on <b>Laptop Print Station (Wi-Fi &middot; Offline USB printer)</b>.</li>
      <li>Tap <b>Find Laptop on Wi-Fi</b> (or type the IP above), enter the <b>6-Digit PIN</b>, and tap <b>Connect</b>.</li>
      <li>Under <b>Printer 1</b>, pick your Mitsubishi / DNP / HiTi printer and turn on <b>Auto-print</b> if desired.</li>
    </ol>
  </div>
</div>
<script>
const PRESETS = ${presetsJson};
let state = { printers: [], selectedPrinters: null, hideUnusedPrinters: false, testSizes: [], testSizesCustomized: false, jobs: [], addresses: [] };
let lastPrSig = '', lastSzSig = '', lastJobSig = '';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function say(msg,isErr){const el=document.getElementById('dashMsg');el.textContent=msg;el.className='msg'+(isErr?' err':'');el.style.display=msg?'block':'none';}
function isSplitLabel(s){const lc=String(s||'').toLowerCase();return lc.indexOf('split')>=0||lc.indexOf('2-up')>=0||lc.indexOf('2up')>=0||lc.indexOf('2x6')>=0||lc.indexOf('div2')>=0;}
function isTicked(p){return state.selectedPrinters===null||state.selectedPrinters.indexOf(p)>=0;}
function effectiveSelected(){return state.selectedPrinters===null?state.printers.slice():state.selectedPrinters.slice();}
function sizeSig(s){return Math.round(Number(s.widthMm)*10)+'|'+Math.round(Number(s.heightMm)*10)+'|'+(s.twoUp?'1':'0')+'|'+(s.paperName||'');}
function sortedVisiblePrinters(){
  const q=String((document.getElementById('prSearch')||{}).value||'').trim().toLowerCase();
  const list=state.printers||[];
  const ordered=list.slice().sort(function(a,b){
    const sa=isTicked(a)?0:1,sb=isTicked(b)?0:1;
    return sa!==sb?sa-sb:list.indexOf(a)-list.indexOf(b);
  });
  return ordered.filter(function(p){
    if(state.hideUnusedPrinters&&!isTicked(p))return false;
    if(!state.hideUnusedPrinters&&q&&p.toLowerCase().indexOf(q)<0)return false;
    return true;
  });
}
function renderSizes(){
  const sizes=state.testSizes||[];
  const sig=JSON.stringify(sizes)+'|'+!!state.testSizesCustomized;
  if(sig===lastSzSig)return;
  lastSzSig=sig;
  document.getElementById('resetSizesBtn').style.display=state.testSizesCustomized?'':'none';
  document.getElementById('sizeChips').innerHTML=sizes.map(function(s,idx){
    const x=sizes.length>1?'<button type="button" data-rm-size="'+idx+'" title="Remove '+esc(s.label)+'">&times;</button>':'';
    return '<span class="chip">'+esc(s.label)+x+'</span>';
  }).join('');
  const have=new Set(sizes.map(sizeSig));
  document.getElementById('presetRow').innerHTML=PRESETS.map(function(p,idx){
    const has=have.has(sizeSig(p));
    return '<button class="btn" type="button" data-add-preset="'+idx+'"'+(has?' disabled':'')+'>'+(has?'\u2713 ':'+ ')+esc(p.label)+'</button>';
  }).join('');
}
function renderPrinters(force){
  const all=state.printers||[];
  const q=String((document.getElementById('prSearch')||{}).value||'').trim().toLowerCase();
  const vis=sortedVisiblePrinters();
  const sig=JSON.stringify([all,state.selectedPrinters,state.hideUnusedPrinters,state.testSizes,q]);
  const tickedCount=all.filter(isTicked).length;
  const hiddenCount=Math.max(0,all.length-tickedCount);
  const badge=document.getElementById('prCountBadge');
  badge.textContent=all.length?(tickedCount+' of '+all.length+' ticked'+(state.hideUnusedPrinters&&hiddenCount?' ('+hiddenCount+' hidden)':'')):'0 found';
  badge.className='badge'+(tickedCount>0?' ok':'');
  const hBtn=document.getElementById('hideUnusedBtn');
  hBtn.textContent=state.hideUnusedPrinters?('Show all ('+all.length+')'):'Hide unused';
  hBtn.className='btn'+(state.hideUnusedPrinters?' active':'');
  document.getElementById('prToolbar').style.display=all.length&&!state.hideUnusedPrinters?'flex':'none';
  if(!force&&sig===lastPrSig)return;
  lastPrSig=sig;
  const drvSel=document.getElementById('drvPrSel');
  if(drvSel&&document.activeElement!==drvSel){
    const cur=drvSel.value;
    const drvList=tickedCount?all.filter(isTicked):all;
    drvSel.innerHTML=drvList.length?drvList.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>';}).join(''):'<option value="">No printers found</option>';
    if(cur&&drvList.indexOf(cur)>=0)drvSel.value=cur;
  }
  const prEl=document.getElementById('prList');
  if(!all.length){
    prEl.innerHTML='<li>No printers found. Connect the printer via USB and install its Windows/Mac driver, then click Refresh Printers.</li>';
    return;
  }
  if(!vis.length){
    prEl.innerHTML=state.hideUnusedPrinters&&tickedCount===0
      ?'<li><span>No printers are ticked yet.</span><button class="btn active" type="button" id="inlineShowAllBtn">Show all ('+all.length+')</button></li>'
      :'<li><span>No printers match that filter.</span>'+(state.hideUnusedPrinters?'<button class="btn" type="button" id="inlineShowAllBtn">Show all ('+all.length+')</button>':'')+'</li>';
    return;
  }
  const sizes=state.testSizes||[];
  prEl.innerHTML=vis.map(function(p){
    const on=isTicked(p);
    const btns=on?('<span class="pr-acts"><button class="btn" data-cfg="'+esc(p)+'" type="button">Driver Preferences</button>'+sizes.map(function(s,idx){
      return '<button class="btn" data-test="'+esc(p)+'" data-sidx="'+idx+'" type="button">Test '+esc(s.label)+'</button>';
    }).join('')+'</span>'):'';
    return '<li class="'+(on?'':'dim')+'"><label class="pr-chk"><input type="checkbox" data-sel="'+esc(p)+'"'+(on?' checked':'')+'><span>'+esc(p)+'</span></label>'+btns+'</li>';
  }).join('');
}
function renderAll(force){
  document.getElementById('pinTxt').textContent=state.pin||'------';
  const ips=(state.addresses||[]).map(function(a){return a.ip+(a.port&&a.port!==47777?':'+a.port:'')+' ('+a.kind+')';});
  document.getElementById('ipList').innerHTML=ips.length?ips.map(esc).join('<br>'):('Port '+(state.port||47777)+' (join Wi-Fi or Hotspot)');
  renderSizes();
  renderPrinters(force);
  const jobs=state.jobs||[];
  const jSig=JSON.stringify(jobs);
  if(force||jSig!==lastJobSig){
    lastJobSig=jSig;
    document.getElementById('jobBody').innerHTML=jobs.length?jobs.map(function(x){
      return '<tr><td>'+new Date(x.at).toLocaleTimeString()+'</td><td>'+esc(x.from)+'</td><td>'+esc(x.printer)+'</td><td>'+esc(x.paper)+'</td><td><span class="tag '+(x.ok?'':'err')+'">'+(x.ok?'Printed':esc(x.error||'Error'))+'</span></td></tr>';
    }).join(''):'<tr><td colspan="5" style="color:var(--dim)">Waiting for prints…</td></tr>';
  }
}
let prSaveSeq=0,szSaveSeq=0,prBusy=0,szBusy=0;
async function load(refresh){
  try{
    const r=await fetch('/station/info'+(refresh?'?refresh=1':''),{cache:'no-store'});
    const j=await r.json();
    const keepPr=prBusy>0?{selectedPrinters:state.selectedPrinters,hideUnusedPrinters:state.hideUnusedPrinters}:{};
    const keepSz=szBusy>0?{testSizes:state.testSizes,testSizesCustomized:state.testSizesCustomized}:{};
    state=Object.assign(state,j||{},keepPr,keepSz);
    renderAll(false);
  }catch(e){}
}
async function savePrinterFilter(nextSel,nextHide){
  const body={};
  if(nextSel!==undefined){body.selectedPrinters=nextSel;state.selectedPrinters=nextSel;}
  if(typeof nextHide==='boolean'){body.hideUnusedPrinters=nextHide;state.hideUnusedPrinters=nextHide;}
  if(state.selectedPrinters===null)state.hideUnusedPrinters=false;
  renderAll(true);
  const seq=++prSaveSeq;
  prBusy++;
  try{
    const r=await fetch('/station/printers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json().catch(function(){return{};});
    if(seq!==prSaveSeq)return;
    if(r.ok&&j.ok){state=Object.assign(state,j);renderAll(true);}
    else say(j.error||'Could not update printers.',true);
  }finally{prBusy--;}
}
async function saveTestSizes(nextSizes){
  if(Array.isArray(nextSizes)){state.testSizes=nextSizes;state.testSizesCustomized=true;renderAll(true);}
  const seq=++szSaveSeq;
  szBusy++;
  try{
    const r=await fetch('/station/test-sizes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({testSizes:nextSizes})});
    const j=await r.json().catch(function(){return{};});
    if(seq!==szSaveSeq)return;
    if(r.ok&&j.ok){state=Object.assign(state,j);renderAll(true);}
    else say(j.error||'Could not update paper sizes.',true);
  }finally{szBusy--;}
}
document.getElementById('newPinBtn').onclick=async function(){
  const r=await fetch('/station/new-pin',{method:'POST'});
  const j=await r.json().catch(function(){return{};});
  say(r.ok&&j.ok?('New 6-digit PIN generated: '+j.pin):(j.error||'Could not update PIN.'),!(r.ok&&j.ok));
  load(false);
};
document.getElementById('refPrBtn').onclick=async function(){say('Refreshing printers…');await load(true);say('Printer list refreshed.');};
document.getElementById('prSearch').oninput=function(){renderPrinters(true);};
document.getElementById('untickAllBtn').onclick=function(){say('Unticked all printers. Tick only the printer(s) you use below.');savePrinterFilter([],false).then(function(){const s=document.getElementById('prSearch');if(s)s.focus();});};
document.getElementById('tickAllBtn').onclick=function(){say('Ticked all printers.');savePrinterFilter((state.printers||[]).slice(),state.hideUnusedPrinters);};
document.getElementById('hideUnusedBtn').onclick=function(){
  const nextHide=!state.hideUnusedPrinters;
  const nextSel=effectiveSelected();
  if(nextHide){const s=document.getElementById('prSearch');if(s)s.value='';}
  if(nextHide&&(state.printers||[]).length>1&&nextSel.length===(state.printers||[]).length){say('All printers are ticked. Click Untick all or untick unused printers first so only your used printer(s) stay visible.');}
  savePrinterFilter(nextSel,nextHide);
};
document.getElementById('drvPrSel').onchange=function(){
  const szSel=document.getElementById('drvSzSel'),addBtn=document.getElementById('drvAddBtn');
  if(szSel){szSel.style.display='none';szSel._items=[];szSel.innerHTML='';}
  if(addBtn)addBtn.style.display='none';
};
document.getElementById('toggleAddSizeBtn').onclick=function(){document.getElementById('addSizeBox').classList.toggle('open');};
document.getElementById('resetSizesBtn').onclick=function(){saveTestSizes(null).then(function(){say('Restored default test sizes (4×6 & 2×6 Cut).');});};
document.getElementById('sizeChips').onclick=function(e){
  const b=e.target.closest('[data-rm-size]');
  if(!b)return;
  const idx=Number(b.dataset.rmSize);
  const next=(state.testSizes||[]).filter(function(_,i){return i!==idx;});
  if(next.length)saveTestSizes(next);
};
document.getElementById('presetRow').onclick=function(e){
  const b=e.target.closest('[data-add-preset]');
  if(!b)return;
  const p=PRESETS[Number(b.dataset.addPreset)];
  if(!p)return;
  saveTestSizes((state.testSizes||[]).concat([p])).then(function(){say('Added Test '+p.label+'.');});
};
document.getElementById('drvLoadBtn').onclick=async function(){
  const p=(document.getElementById('drvPrSel')||{}).value||'';
  if(!p)return say('Select a printer first.',true);
  const b=this;b.disabled=true;b.textContent='Loading…';
  try{
    const r=await fetch('/paper?printer='+encodeURIComponent(p),{cache:'no-store'});
    const j=await r.json().catch(function(){return{};});
    const list=Array.isArray(j.paperList)?j.paperList:[];
    const szSel=document.getElementById('drvSzSel'),addBtn=document.getElementById('drvAddBtn');
    if(!list.length){say('No paper list returned by '+p+' driver. Enter dimensions manually below.',true);szSel.style.display='none';addBtn.style.display='none';return;}
    szSel.innerHTML=list.map(function(it,idx){return '<option value="'+idx+'">'+esc(it.name)+' ('+Math.round(it.w)+'\u00d7'+Math.round(it.h)+' mm)</option>';}).join('');
    szSel._items=list;
    szSel.style.display='';addBtn.style.display='';
    say('Loaded '+list.length+' paper sizes from '+p+'.');
  }finally{b.disabled=false;b.textContent='Load driver sizes';}
};
document.getElementById('drvAddBtn').onclick=function(){
  const szSel=document.getElementById('drvSzSel');
  const it=szSel&&szSel._items&&szSel._items[Number(szSel.value)];
  if(!it)return;
  const spec={label:String(it.name||'').slice(0,32),widthMm:Number(it.w)||101.6,heightMm:Number(it.h)||152.4,twoUp:isSplitLabel(it.name),paperName:String(it.name||'')};
  saveTestSizes((state.testSizes||[]).concat([spec])).then(function(){say('Added driver size '+spec.label+'.');});
};
document.getElementById('csAddBtn').onclick=function(){
  const w=Number(document.getElementById('csW').value),h=Number(document.getElementById('csH').value),u=document.getElementById('csU').value;
  const lo=u==='in'?0.5:10,hi=u==='in'?48:1220;
  if(!(w>=lo&&w<=hi&&h>=lo&&h<=hi))return say('Size must be '+lo+'–'+hi+' '+u+' on each side.',true);
  const k=u==='in'?25.4:1;
  const labelRaw=document.getElementById('csLabel').value.trim();
  const twoUp=!!document.getElementById('csTwoUp').checked;
  const wMm=Math.round(w*k*100)/100,hMm=Math.round(h*k*100)/100;
  const autoLbl=w+'\u00d7'+h+(u==='mm'?' mm':'')+(twoUp?' Cut':'');
  saveTestSizes((state.testSizes||[]).concat([{label:(labelRaw||autoLbl).slice(0,40),widthMm:wMm,heightMm:hMm,twoUp:twoUp}])).then(function(){
    document.getElementById('csW').value='';document.getElementById('csH').value='';document.getElementById('csLabel').value='';document.getElementById('csTwoUp').checked=false;
    say('Added Test '+(labelRaw||autoLbl)+'.');
  });
};
document.getElementById('prList').onchange=function(e){
  const cb=e.target.closest('input[data-sel]');
  if(!cb)return;
  const p=cb.dataset.sel;
  const cur=new Set(effectiveSelected());
  if(cb.checked)cur.add(p);else cur.delete(p);
  savePrinterFilter(Array.from(cur),state.hideUnusedPrinters);
};
document.getElementById('prList').onclick=async function(e){
  if(e.target.closest('#inlineShowAllBtn')){savePrinterFilter(state.selectedPrinters||[],false);return;}
  const cfgBtn=e.target.closest('[data-cfg]');
  if(cfgBtn){
    cfgBtn.disabled=true;say('Opening Driver Preferences for '+cfgBtn.dataset.cfg+'…');
    try{
      const r=await fetch('/printer/configure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({printer:cfgBtn.dataset.cfg})});
      const j=await r.json().catch(function(){return{};});
      say(r.ok&&j.ok?(j.message||'Driver Preferences opened.'):(j.error||'Could not open Driver Preferences.'),!(r.ok&&j.ok));
    }finally{cfgBtn.disabled=false;}
    return;
  }
  const tstBtn=e.target.closest('[data-test]');
  if(tstBtn){
    const spec=(state.testSizes||[])[Number(tstBtn.dataset.sidx)]||{label:'4\u00d76',widthMm:101.6,heightMm:152.4,twoUp:false};
    tstBtn.disabled=true;say('Sending '+spec.label+' test print to '+tstBtn.dataset.test+'…');
    try{
      const r=await fetch('/station/test-print',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({printer:tstBtn.dataset.test},spec))});
      const j=await r.json().catch(function(){return{};});
      say(r.ok&&j.ok?('Test print ('+spec.label+') sent to '+tstBtn.dataset.test+' \u2713'):(j.error||'Test print failed.'),!(r.ok&&j.ok));
      await load(false);
    }finally{tstBtn.disabled=false;}
  }
};
load(true);
setInterval(function(){load(false);},3000);
</script>
</body>
</html>`;
}
