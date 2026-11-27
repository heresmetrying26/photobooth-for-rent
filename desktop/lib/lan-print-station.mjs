// Offline Wi-Fi / LAN Laptop Print Station handler (port 47777-47797).
//
// Shared by both tools/print-helper/ (0 license slots used) and desktop/lib/photos.mjs
// so an offline iPad / Android booth on the same Wi-Fi router or Windows Mobile Hotspot
// can print straight to USB / Windows-driver printers (Mitsubishi CP-D80DW, DNP, HiTi, etc.)
// with zero internet and zero OS print dialogs.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, platform } from 'node:os';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { allBridgeUrls } from './guest-bridge.mjs';

const FAIL_MAX = 10;
const FAIL_MS = 10 * 60_000;
const MAX_BODY = 80 * 1024 * 1024;
const MAX_LOGS = 30;
const MAX_PENDING_JOBS = 40;
const MAX_COPIES = 20;
const MAX_SELECTED_PRINTERS = 120;
const MAX_TEST_SIZES = 16;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;
const fails = new Map();
const jobLog = [];
const pendingQueue = [];

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
  getCaps: null,
  printJob: async () => ({ ok: false, error: 'Unsupported' }),
  makeThumb: null,
  onJob: () => { },
  onActivity: () => { },
  getHotspotWifi: null,
  pinFile: '',
  appKind: 'print-helper',
  version: '',
  logger: () => { }
};

let stationPin = '';
let selectedPrinters = null;      // null = not filtered yet (all available); string[] = explicit allowlist
let hideUnusedPrinters = false;
let customTestSizes = null;       // null = defaults (4x6, 2x6 Cut); array = user-customized list
let stationMode = 'auto';         // 'auto' = print immediately, 'queue' = hold in review queue before printing

export function normalizeStationMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'queue' ? 'queue' : 'auto';
}

function clampCopies(v, fallback = 1) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_COPIES, n);
}

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
  let mode = 'auto';
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
      if (saved && Object.prototype.hasOwnProperty.call(saved, 'stationMode')) {
        mode = normalizeStationMode(saved.stationMode);
      }
    } catch { /* fall through to generate */ }
  }
  if (!pin) pin = newPin();
  stationPin = pin;
  selectedPrinters = sel;
  hideUnusedPrinters = !!(hideUnused && sel !== null);
  customTestSizes = sizes;
  stationMode = mode;
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
      testSizes: customTestSizes,
      stationMode
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
    getCaps: typeof options.getCaps === 'function' ? options.getCaps : null,
    printJob: typeof options.printJob === 'function' ? options.printJob : async () => ({ ok: false, error: 'Unsupported' }),
    makeThumb: typeof options.makeThumb === 'function' ? options.makeThumb : null,
    onJob: typeof options.onJob === 'function' ? options.onJob : () => { },
    onActivity: typeof options.onActivity === 'function' ? options.onActivity : () => { },
    getHotspotWifi: typeof options.getHotspotWifi === 'function' ? options.getHotspotWifi : null,
    pinFile: typeof options.pinFile === 'string' ? options.pinFile : '',
    appKind: typeof options.appKind === 'string' ? options.appKind : 'print-helper',
    version: typeof options.version === 'string' ? options.version : '',
    logger: typeof options.logger === 'function' ? options.logger : () => { }
  };
  loadStationState(cfg.pinFile);
  return getLanStationInfo();
}

/** Update incoming job mode ('auto' | 'queue') and notify local + connected clients. */
export function setStationMode(mode) {
  stationMode = normalizeStationMode(mode);
  persistStationState(cfg.pinFile);
  log('Incoming print mode set to ' + stationMode);
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
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

function summarizePendingJob(j) {
  return {
    id: j.id,
    at: j.at,
    from: j.from,
    fromName: j.fromName || '',
    printer: j.printer,
    paper: j.paper,
    paperName: j.paperName || '',
    widthMm: j.widthMm,
    heightMm: j.heightMm,
    twoUp: !!j.twoUp,
    copies: j.copies,
    pageCount: j.pages.length,
    thumb: j.thumb || '',
    printing: !!j.printing,
    lastError: j.lastError || ''
  };
}

/** Build a compact, fast-scanning QR URI containing all active laptop IPs, port, 6-digit PIN, host name, and optional Booth Hotspot creds. */
export function buildLanStationQrPayload({ addresses = [], port = 47777, pin = '', host = '', wifiSsid = '', wifiPass = '' } = {}) {
  const cleanPin = String(pin || '').trim();
  if (!validStationPin(cleanPin)) return '';
  const ips = [];
  const seen = new Set();
  for (const a of (Array.isArray(addresses) ? addresses : [])) {
    const ip = String(typeof a === 'string' ? a : (a && a.ip) || '').trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) || seen.has(ip)) continue;
    const octs = ip.split('.').map(Number);
    if (octs.some((n) => n < 0 || n > 255) || octs[0] === 0 || octs[0] === 127) continue;
    seen.add(ip);
    ips.push(ip);
    if (ips.length >= 6) break;
  }
  if (!ips.length) return '';
  const p = Number(port) || 47777;
  const qs = new URLSearchParams();
  qs.set('ips', ips.join(','));
  if (p !== 47777) qs.set('port', String(p));
  qs.set('pin', cleanPin);
  const cleanHost = String(host || '').trim().slice(0, 48);
  if (cleanHost) qs.set('host', cleanHost);
  const cleanSsid = String(wifiSsid || '').trim().slice(0, 32);
  if (cleanSsid) {
    qs.set('ws', cleanSsid);
    const cleanPass = String(wifiPass || '').slice(0, 63);
    if (cleanPass) qs.set('wp', cleanPass);
  }
  return 'pb4u://lan-station?' + qs.toString();
}

/** Non-sensitive info + local dashboard summary (PIN included for local machine UI only). */
export function getLanStationInfo() {
  const port = Number(cfg.getPort()) || 0;
  const host = hostname();
  const addresses = lanStationAddresses();
  let hs = null;
  try { hs = typeof cfg.getHotspotWifi === 'function' ? cfg.getHotspotWifi() : null; } catch { hs = null; }
  const wifiSsid = hs && hs.ssid ? String(hs.ssid) : '';
  const wifiPass = hs && hs.pass ? String(hs.pass) : '';
  return {
    enabled: true,
    isWin: platform() === 'win32',
    kind: cfg.appKind,
    version: cfg.version,
    host,
    port,
    pin: stationPin,
    pairQr: buildLanStationQrPayload({ addresses, port, pin: stationPin, host, wifiSsid, wifiPass }),
    stationMode,
    addresses,
    pendingCount: pendingQueue.length,
    pendingJobs: pendingQueue.map(summarizePendingJob),
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
  // Always close /lan-station/* sockets cleanly after each response so iOS WKWebView / URLSession
  // can never reuse a half-closed Node 5s keep-alive socket on Print #2 or after multi-hour idle gaps.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'connection': 'close',
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
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    req.on('data', (c) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        finish(reject, new Error('Request body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        finish(reject, new Error('Bad JSON body'));
      }
    });
    req.on('aborted', () => finish(reject, new Error('Client disconnected mid-upload')));
    req.on('close', () => { if (!req.complete) finish(reject, new Error('Connection closed early')); });
    req.on('error', (err) => finish(reject, err));
  });
}

export function recordStationJob(entry) {
  jobLog.unshift({
    at: Date.now(),
    printer: String(entry.printer || ''),
    pages: Number(entry.pages) || 1,
    copies: clampCopies(entry.copies, 1),
    paper: String(entry.paper || ''),
    from: String(entry.from || ''),
    ok: !!entry.ok,
    error: entry.error ? String(entry.error) : ''
  });
  if (jobLog.length > MAX_LOGS) jobLog.length = MAX_LOGS;
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
}

function paperLabelForBody(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.paperLabel === 'string' && body.paperLabel.trim()) return body.paperLabel.trim().slice(0, 60);
  if (typeof body.paperName === 'string' && body.paperName.trim()) return body.paperName.trim().slice(0, 60);
  if (body.widthMm && body.heightMm) {
    const base = formatAutoSizeLabel(clampMm(body.widthMm, 101.6), clampMm(body.heightMm, 152.4), !!body.twoUp);
    return base;
  }
  return '';
}

function normalizePagesArray(rawPages) {
  if (!Array.isArray(rawPages) || !rawPages.length || rawPages.length > 20) return null;
  const out = [];
  for (const p of rawPages) {
    const s = String(p || '');
    if (!DATA_URL_RE.test(s)) return null;
    out.push(s);
  }
  return out;
}

async function dispatchPrintPayload(basePayload, targetPrinter, copies) {
  const basePages = Array.isArray(basePayload.pages) ? basePayload.pages : [];
  if (!basePages.length) return { ok: false, error: 'No pages to print.', totalPages: 0 };
  const c = clampCopies(copies, 1);
  const printer = String(targetPrinter || basePayload.printer || '').trim();
  if (!printer) return { ok: false, error: 'Choose a printer first.', totalPages: 0 };
  const warnings = [];
  if (c === 1 && basePages.length <= 20) {
    const resPrint = await cfg.printJob({ ...basePayload, printer, pages: basePages });
    if (resPrint && resPrint.ok) {
      if (Array.isArray(resPrint.warnings)) warnings.push(...resPrint.warnings);
      return { ok: true, totalPages: basePages.length, warnings, raw: resPrint };
    }
    return { ok: false, error: (resPrint && resPrint.error) || 'Print failed.', totalPages: basePages.length };
  }
  const expanded = [];
  for (let i = 0; i < c; i++) expanded.push(...basePages);
  for (let i = 0; i < expanded.length; i += 20) {
    const chunk = expanded.slice(i, i + 20);
    const resPrint = await cfg.printJob({ ...basePayload, printer, pages: chunk });
    if (!resPrint || !resPrint.ok) {
      return { ok: false, error: (resPrint && resPrint.error) || 'Print failed.', totalPages: expanded.length };
    }
    if (Array.isArray(resPrint.warnings)) warnings.push(...resPrint.warnings);
  }
  return { ok: true, totalPages: expanded.length, warnings: Array.from(new Set(warnings)) };
}

export function getPendingStationJobPages(id) {
  const cleanId = String(id || '').trim();
  const job = pendingQueue.find((j) => j.id === cleanId);
  if (!job) return { ok: false, error: 'Queued print was not found.' };
  return {
    ok: true,
    id: job.id,
    printer: job.printer,
    paper: job.paper,
    copies: job.copies,
    pages: job.pages.slice()
  };
}

export function getPendingStationJobImage(id, pageIdx = 0) {
  const cleanId = String(id || '').trim();
  const job = pendingQueue.find((j) => j.id === cleanId);
  if (!job) return null;
  const idx = Math.max(0, Math.min(job.pages.length - 1, Math.floor(Number(pageIdx) || 0)));
  const m = DATA_URL_RE.exec(String(job.pages[idx] || ''));
  if (!m) return null;
  return {
    mime: m[1] === 'jpeg' ? 'image/jpeg' : 'image/png',
    buf: Buffer.from(m[2], 'base64')
  };
}

export function clearPendingStationJobs() {
  pendingQueue.length = 0;
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
}

export async function approvePendingStationJob(id, opts = {}) {
  const cleanId = String(id || '').trim();
  const idx = pendingQueue.findIndex((j) => j.id === cleanId);
  if (idx < 0) return { ok: false, error: 'Queued print was already printed or removed.' };
  const job = pendingQueue[idx];
  if (job.printing) return { ok: false, error: 'Already printing this photo.' };
  const targetPrinter = String((opts && opts.printer !== undefined) ? opts.printer : job.printer).trim();
  if (!targetPrinter) return { ok: false, error: 'Choose a target printer first.' };
  const targetCopies = clampCopies(opts && opts.copies !== undefined ? opts.copies : job.copies, job.copies);

  job.printer = targetPrinter;
  job.copies = targetCopies;
  job.printing = true;
  job.lastError = '';
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }

  try {
    const res = await dispatchPrintPayload(job.printPayload, targetPrinter, targetCopies);
    if (res.ok) {
      const curIdx = pendingQueue.findIndex((j) => j.id === cleanId);
      if (curIdx >= 0) pendingQueue.splice(curIdx, 1);
      recordStationJob({
        printer: targetPrinter,
        pages: res.totalPages,
        copies: targetCopies,
        paper: job.paper,
        from: job.from,
        ok: true
      });
      log('Approved & printed ' + res.totalPages + ' page(s) (' + targetCopies + 'x) on "' + targetPrinter + '" from ' + job.from);
      return {
        ok: true,
        ...getLanStationInfo(),
        ...(res.warnings && res.warnings.length ? { warnings: res.warnings } : {})
      };
    }
    job.printing = false;
    job.lastError = res.error || 'Print failed.';
    recordStationJob({
      printer: targetPrinter,
      pages: job.pages.length * targetCopies,
      copies: targetCopies,
      paper: job.paper,
      from: job.from,
      ok: false,
      error: job.lastError
    });
    return { ok: false, error: job.lastError, ...getLanStationInfo() };
  } catch (e) {
    const errMsg = (e && e.message) || 'Print failed.';
    job.printing = false;
    job.lastError = errMsg;
    recordStationJob({
      printer: targetPrinter,
      pages: job.pages.length * targetCopies,
      copies: targetCopies,
      paper: job.paper,
      from: job.from,
      ok: false,
      error: errMsg
    });
    return { ok: false, error: errMsg, ...getLanStationInfo() };
  }
}

export function dismissPendingStationJob(id) {
  const cleanId = String(id || '').trim();
  const idx = pendingQueue.findIndex((j) => j.id === cleanId);
  if (idx < 0) return { ok: false, error: 'Queued print was not found.', ...getLanStationInfo() };
  if (pendingQueue[idx].printing) return { ok: false, error: 'Cannot dismiss while printing.', ...getLanStationInfo() };
  pendingQueue.splice(idx, 1);
  log('Dismissed queued print ' + cleanId);
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
  return { ok: true, ...getLanStationInfo() };
}

export async function printAllPendingStationJobs() {
  const snapshot = pendingQueue.slice().reverse(); // oldest first
  let printedCount = 0;
  let failedCount = 0;
  let lastError = '';
  for (const job of snapshot) {
    const r = await approvePendingStationJob(job.id, { printer: job.printer, copies: job.copies });
    if (r && r.ok) printedCount++;
    else { failedCount++; lastError = (r && r.error) || 'Print failed.'; }
  }
  return {
    ok: failedCount === 0,
    printedCount,
    failedCount,
    ...(lastError ? { error: lastError } : {}),
    ...getLanStationInfo()
  };
}

export function dismissAllPendingStationJobs() {
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (!pendingQueue[i].printing) pendingQueue.splice(i, 1);
  }
  try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
  return { ok: true, ...getLanStationInfo() };
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
    res.writeHead(204, corsHeaders({ 'cache-control': 'no-store', 'connection': 'close' }));
    res.end();
    return true;
  }

  if (!cfg.isEnabled()) {
    return sendJson(res, 403, { ok: false, reason: 'disabled', error: 'Print Station is not enabled on this laptop licence. Ask your admin to turn it on.' });
  }

  try { cfg.onActivity(); } catch { /* ignore */ }

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
        filtered: selectedPrinters !== null,
        stationMode,
        pendingCount: pendingQueue.length
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: (e && e.message) || 'Could not list printers.' });
    }
  }

  if (req.method === 'POST' && p === '/lan-station/mode') {
    let body;
    try {
      body = await readJsonBody(req, 8192);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: (e && e.message) || 'Bad request' });
    }
    const rawMode = String((body && body.mode) || '').trim().toLowerCase();
    if (rawMode !== 'auto' && rawMode !== 'queue') {
      return sendJson(res, 400, { ok: false, error: 'Mode must be "auto" or "queue".' });
    }
    const info = setStationMode(rawMode);
    return sendJson(res, 200, {
      ok: true,
      stationMode: info.stationMode,
      pendingCount: info.pendingCount
    });
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

  if (req.method === 'GET' && p === '/lan-station/printer/caps') {
    const name = String(url.searchParams.get('printer') || '').trim();
    if (!name) return sendJson(res, 400, { ok: false, error: 'Missing printer name.' });
    if (typeof cfg.getCaps !== 'function') {
      return sendJson(res, 200, { ok: true, known: false, mediaTypes: [], mediaLabels: {}, mediaDefault: '', autoMedia: '' });
    }
    try {
      const out = await cfg.getCaps({ printer: name });
      return sendJson(res, out && out.ok === false && /No printer called/i.test(out.error || '') ? 404 : 200, out || { ok: true, known: false, mediaTypes: [], mediaLabels: {}, mediaDefault: '', autoMedia: '' });
    } catch (e) {
      return sendJson(res, 200, { ok: true, known: false, mediaTypes: [], mediaLabels: {}, mediaDefault: '', autoMedia: '' });
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
    const pages = normalizePagesArray(body && body.pages);
    const paperLabel = paperLabelForBody(body);
    const fromIp = clientKey(req);

    if (stationMode === 'queue') {
      if (!pages) {
        return sendJson(res, 400, { ok: false, error: 'Pages must be 1 to 20 PNG or JPEG images.' });
      }
      if (pendingQueue.length >= MAX_PENDING_JOBS) {
        return sendJson(res, 429, {
          ok: false,
          error: 'Laptop Print Station queue is full (' + MAX_PENDING_JOBS + '). Print or dismiss queued photos on the laptop first.'
        });
      }
      const hasExplicitCopies = body && body.copies !== undefined && body.copies !== null && body.copies !== '';
      const allSame = pages.length > 1 && pages.every((pg) => pg === pages[0]);
      const basePages = (!hasExplicitCopies && allSame) ? [pages[0]] : pages;
      const copies = (!hasExplicitCopies && allSame) ? clampCopies(pages.length, 1) : clampCopies(body && body.copies, 1);
      let thumb = '';
      try {
        if (typeof cfg.makeThumb === 'function') thumb = String((await cfg.makeThumb(basePages[0])) || '');
      } catch { thumb = ''; }
      if (!thumb && basePages[0].length <= 64000) thumb = basePages[0];
      const id = Date.now().toString(36) + '-' + randomInt(36 ** 4).toString(36).padStart(4, '0');
      const job = {
        id,
        at: Date.now(),
        from: fromIp,
        fromName: String((body && (body.fromName || body.deviceName)) || '').trim().slice(0, 60),
        printer,
        paper: paperLabel || '4×6',
        paperName: typeof (body && body.paperName) === 'string' ? body.paperName.trim().slice(0, 120) : '',
        widthMm: Number(body && body.widthMm) || 101.6,
        heightMm: Number(body && body.heightMm) || 152.4,
        twoUp: !!(body && body.twoUp),
        copies,
        pages: basePages,
        thumb,
        printing: false,
        lastError: '',
        printPayload: {
          ...(body || {}),
          printer,
          pages: basePages
        }
      };
      delete job.printPayload.copies;
      delete job.printPayload.fromName;
      delete job.printPayload.deviceName;
      pendingQueue.unshift(job);
      log('Queued ' + basePages.length + ' page(s) x' + copies + ' from iPad/tablet ' + fromIp + ' (awaiting review)');
      try { cfg.onJob(getLanStationInfo()); } catch { /* ignore */ }
      return sendJson(res, 200, {
        ok: true,
        queued: true,
        id,
        stationMode: 'queue',
        pendingCount: pendingQueue.length
      });
    }

    const rawCopies = body && body.copies !== undefined ? clampCopies(body.copies, 1) : 1;
    const rawCount = Array.isArray(body && body.pages) ? body.pages.length : 0;
    try {
      if (body && body.copies !== undefined && pages) {
        const cleanBody = { ...(body || {}) };
        delete cleanBody.copies;
        delete cleanBody.fromName;
        delete cleanBody.deviceName;
        const resPrint = await dispatchPrintPayload({ ...cleanBody, pages }, printer, rawCopies);
        if (resPrint.ok) {
          recordStationJob({ printer, pages: resPrint.totalPages, copies: rawCopies, paper: paperLabel, from: fromIp, ok: true });
          log('Printed ' + resPrint.totalPages + ' page(s) (' + rawCopies + 'x) on "' + printer + '" from iPad/tablet ' + fromIp);
          return sendJson(res, 200, {
            ok: true,
            queued: false,
            stationMode: 'auto',
            ...(resPrint.warnings && resPrint.warnings.length ? { warnings: resPrint.warnings } : {})
          });
        }
        const errMsg = resPrint.error || 'Print failed.';
        recordStationJob({ printer, pages: resPrint.totalPages || rawCount, copies: rawCopies, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
        return sendJson(res, 500, { ok: false, error: errMsg });
      }
      const resPrint = await cfg.printJob(body || {});
      if (resPrint && resPrint.ok) {
        recordStationJob({ printer, pages: rawCount, copies: rawCopies, paper: paperLabel, from: fromIp, ok: true });
        log('Printed ' + rawCount + ' page(s) on "' + printer + '" from iPad/tablet ' + fromIp);
        return sendJson(res, 200, { ...resPrint, queued: false, stationMode: 'auto' });
      }
      const errMsg = (resPrint && resPrint.error) || 'Print failed.';
      recordStationJob({ printer, pages: rawCount, copies: rawCopies, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
      return sendJson(res, 500, { ok: false, error: errMsg });
    } catch (e) {
      const errMsg = (e && e.message) || 'Print failed.';
      recordStationJob({ printer, pages: rawCount * rawCopies, copies: rawCopies, paper: paperLabel, from: fromIp, ok: false, error: errMsg });
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
<script src="/station/qr.js"></script>
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
  .qrwrap{display:none;flex-direction:column;align-items:center;gap:4px;background:#fff;color:#1c1a1e;border-radius:12px;padding:7px;flex:none;}
  .qrwrap img{width:108px;height:108px;display:block;image-rendering:pixelated;}
  .qrwrap small{font:800 10.5px/1.15 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#5d555b;}
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
  .modebar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#faf8f4;}
  .seg{display:inline-flex;gap:6px;flex-wrap:wrap;}
  .q-list{display:grid;gap:10px;margin-top:10px;}
  .q-item{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;padding:12px;border:1px solid var(--line);border-radius:12px;background:#faf8f4;}
  .q-thumb-btn{position:relative;border:1px solid var(--line);border-radius:10px;background:#fff;padding:4px;cursor:pointer;flex:none;width:104px;height:128px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
  .q-thumb-btn:hover{border-color:var(--red);}
  .q-thumb-btn img{max-width:100%;max-height:100%;object-fit:contain;display:block;}
  .q-pg{position:absolute;bottom:4px;right:4px;background:rgba(28,26,30,.82);color:#fff;font:700 10.5px inherit;padding:2px 6px;border-radius:999px;}
  .q-info{flex:1;min-width:220px;display:grid;gap:8px;}
  .q-meta{font-size:12.5px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .q-meta b{color:var(--ink);font-size:13.5px;}
  .q-ctrl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;background:#fff;overflow:hidden;}
  .stepper button{border:0;background:none;padding:4px 10px;font:800 14px inherit;cursor:pointer;color:var(--ink);}
  .stepper button:hover:not(:disabled){color:var(--red);}
  .stepper span{min-width:26px;text-align:center;font:800 13px inherit;}
  .pv-ov{position:fixed;inset:0;background:rgba(16,14,18,.82);display:none;align-items:center;justify-content:center;padding:20px;z-index:99;}
  .pv-ov.open{display:flex;}
  .pv-card{background:#fff;border-radius:16px;padding:16px;max-width:min(92vw,680px);max-height:92vh;display:grid;gap:10px;justify-items:center;}
  .pv-card img{max-width:100%;max-height:70vh;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#faf8f4;}
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
      <div class="qrwrap" id="pairQrWrap"><img id="pairQrImg" alt="Scan in iPad app to pair"><small>Scan in iPad App</small></div>
      <div style="display:flex;flex-direction:column;gap:7px;">
        <button class="btn dark" id="newPinBtn" type="button">New PIN</button>
        <button class="btn dark" id="fixFwBtn" type="button" style="display:none;">Fix Hotspot Firewall</button>
      </div>
    </div>
    <div class="modebar">
      <div>
        <b>Incoming print handling</b>
        <div id="modeHint" style="font-size:12.5px;color:var(--dim);">Incoming prints from iPad / tablet print immediately.</div>
      </div>
      <div class="seg" role="group" aria-label="Incoming print handling">
        <button class="btn active" id="modeAutoBtn" type="button">Auto-print</button>
        <button class="btn" id="modeQueueBtn" type="button">Queue &amp; view first</button>
      </div>
    </div>
    <div class="msg" id="dashMsg" role="status"></div>
  </div>
  <div class="card" id="pendingCard" style="display:none;">
    <div class="pr-head">
      <div class="row-in">
        <b>Pending Queue (View Before Printing)</b>
        <span class="badge" id="pendingBadge">0 waiting</span>
      </div>
      <div class="row-in">
        <button class="btn active" id="printAllBtn" type="button" style="display:none;">Print all</button>
        <button class="btn" id="clearAllBtn" type="button" style="display:none;">Dismiss all</button>
      </div>
    </div>
    <div class="q-list" id="pendingList"></div>
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
    <b>Where to Click on the iPad App (Hotspot &amp; Multi-Hour Guide)</b>
    <ol class="steps">
      <li><b>Using this laptop&rsquo;s Mobile Hotspot (offline):</b> On the iPad, turn <b>Cellular Data OFF</b> (or Airplane Mode ON, then Wi-Fi ON), turn <b>Auto-Join OFF</b> on any venue/home Wi-Fi so the iPad stays locked to the hotspot, join the hotspot (tap <b>Use Without Internet</b>), and confirm <b>Settings &rarr; photobooth4u &rarr; Local Network</b> is <b>ON</b>. On Windows, click <b>Fix Hotspot Firewall</b> once above.</li>
      <li><b>Using a shared Wi-Fi router:</b> Connect both this laptop and the iPad to the same Wi-Fi network (avoid Guest Wi-Fi).</li>
      <li>If using a DSLR on the iPad (e.g. Canon 550D), plug it into the iPad via USB and choose it in <b>Setup &rarr; Camera</b>.</li>
      <li>Open <b>Setup &rarr; Printer</b> on the iPad app, pick your paper size (e.g. <b>4&times;6</b>, <b>2&times;6 strips</b>, <b>5&times;7</b>, <b>6&times;8</b>, <b>A4</b>, or <b>More paper sizes &rarr; Own size</b>), and switch on <b>Laptop Print Station (Wi-Fi &middot; Offline USB printer)</b>.</li>
      <li>Tap <b>Scan Laptop QR</b> (instant 1-scan connect) or tap <b>Find Laptop on Wi-Fi</b> / type the IP + <b>6-Digit PIN</b> above and tap <b>Connect</b>.</li>
      <li>Under <b>Printer 1</b>, pick your Mitsubishi / DNP / HiTi printer and turn on <b>Auto-print</b> if desired.</li>
      <li><b>For multi-hour events:</b> Plug this laptop into power and keep Print Helper open (it keeps Windows awake automatically; set lid-close action to &ldquo;Do nothing&rdquo; if you close the lid).</li>
    </ol>
  </div>
</div>
<div class="pv-ov" id="pvModal" role="dialog" aria-modal="true" aria-label="Queued photo preview">
  <div class="pv-card">
    <div class="pr-head" style="width:100%;margin-bottom:0;">
      <b id="pvTitle">Queued Photo Preview</b>
      <button class="btn" id="pvCloseBtn" type="button">Close</button>
    </div>
    <img id="pvImg" alt="Queued photo preview">
    <div class="row-in" id="pvNav" style="display:none;">
      <button class="btn" id="pvPrevBtn" type="button">&lsaquo; Prev</button>
      <span id="pvPageTxt" style="font-size:13px;font-weight:700;"></span>
      <button class="btn" id="pvNextBtn" type="button">Next &rsaquo;</button>
    </div>
    <div id="pvMeta" style="font-size:12.5px;color:var(--dim);text-align:center;"></div>
  </div>
</div>
<script>
const PRESETS = ${presetsJson};
let state = { printers: [], selectedPrinters: null, hideUnusedPrinters: false, testSizes: [], testSizesCustomized: false, stationMode: 'auto', pendingJobs: [], jobs: [], addresses: [] };
let lastPrSig = '', lastSzSig = '', lastJobSig = '', lastPendingSig = '', lastPairQr = '';
let jobEdits = {};
let pvState = { job: null, page: 0 };
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function say(msg,isErr){const el=document.getElementById('dashMsg');el.textContent=msg;el.className='msg'+(isErr?' err':'');el.style.display=msg?'block':'none';}
function isSplitLabel(s){const lc=String(s||'').toLowerCase();return lc.indexOf('split')>=0||lc.indexOf('2-up')>=0||lc.indexOf('2up')>=0||lc.indexOf('2x6')>=0||lc.indexOf('div2')>=0;}
function isTicked(p){return state.selectedPrinters===null||state.selectedPrinters.indexOf(p)>=0;}
function effectiveSelected(){return state.selectedPrinters===null?state.printers.slice():state.selectedPrinters.slice();}
function availableTargetPrinters(){
  const all=state.printers||[];
  const ticked=all.filter(isTicked);
  return ticked.length?ticked:all;
}
function editForJob(j){
  const cur=jobEdits[j.id];
  if(cur)return cur;
  const list=availableTargetPrinters();
  const defPrinter=j.printer||(list[0]||'');
  return{printer:defPrinter,copies:Math.max(1,Math.min(20,Number(j.copies)||1))};
}
function jobThumbSrc(j,pageIdx){
  if((pageIdx||0)===0&&j.thumb)return j.thumb;
  return '/station/job-image?id='+encodeURIComponent(j.id)+'&page='+(pageIdx||0);
}
function renderMode(){
  const qMode=state.stationMode==='queue';
  const bA=document.getElementById('modeAutoBtn'),bQ=document.getElementById('modeQueueBtn'),mh=document.getElementById('modeHint');
  if(bA)bA.className='btn'+(qMode?'':' active');
  if(bQ)bQ.className='btn'+(qMode?' active':'');
  if(mh)mh.textContent=qMode
    ?'Incoming photos wait in the review queue below so you can inspect them, change printer or copies, and click Print.'
    :'Incoming prints from iPad / tablet print immediately.';
}
function renderPending(force){
  const list=Array.isArray(state.pendingJobs)?state.pendingJobs:[];
  const card=document.getElementById('pendingCard'),box=document.getElementById('pendingList'),badge=document.getElementById('pendingBadge');
  const pAll=document.getElementById('printAllBtn'),cAll=document.getElementById('clearAllBtn');
  if(!card||!box)return;
  const show=state.stationMode==='queue'||list.length>0;
  card.style.display=show?'':'none';
  if(badge){badge.textContent=list.length+(list.length===1?' waiting':' waiting');badge.className='badge'+(list.length?' ok':'');}
  if(pAll)pAll.style.display=list.length>1?'':'none';
  if(cAll)cAll.style.display=list.length>1?'':'none';
  if(!show)return;
  const active=document.activeElement;
  if(!force&&active&&active.dataset&&(active.dataset.jobPrinter||active.dataset.jobCopies))return;
  const targets=availableTargetPrinters();
  const liveIds={};
  list.forEach(function(j){liveIds[j.id]=1;});
  Object.keys(jobEdits).forEach(function(id){if(!liveIds[id])delete jobEdits[id];});
  const sig=JSON.stringify([list.map(function(j){return[j.id,j.printer,j.copies,j.printing,j.lastError,j.pageCount];}),targets,jobEdits]);
  if(!force&&sig===lastPendingSig)return;
  lastPendingSig=sig;
  if(!list.length){
    box.innerHTML='<div style="color:var(--dim);font-size:13.5px;padding:6px 2px;">Queue is empty. Photos sent from iPad / tablet will wait here for your preview before printing.</div>';
    return;
  }
  box.innerHTML=list.map(function(j){
    const ed=editForJob(j);
    const prList=targets.slice();
    if(ed.printer&&prList.indexOf(ed.printer)<0)prList.unshift(ed.printer);
    const opts=prList.length
      ?prList.map(function(p){return '<option value="'+esc(p)+'"'+(p===ed.printer?' selected':'')+'>'+esc(p)+'</option>';}).join('')
      :'<option value="">No printer available</option>';
    const fromLabel=j.fromName?(j.fromName+' ('+j.from+')'):j.from;
    const pgBadge=j.pageCount>1?'<span class="q-pg">'+j.pageCount+' pages</span>':'';
    const errHtml=j.lastError?'<div class="tag err">'+esc(j.lastError)+'</div>':'';
    return '<div class="q-item">'
      +'<button type="button" class="q-thumb-btn" data-view-job="'+esc(j.id)+'" title="Click to preview full photo">'
      +'<img src="'+esc(jobThumbSrc(j,0))+'" alt="Queued photo preview">'+pgBadge+'</button>'
      +'<div class="q-info">'
      +'<div class="q-meta"><b>'+esc(j.paper||'Photo')+'</b><span>'+new Date(j.at).toLocaleTimeString()+'</span><span>From '+esc(fromLabel||'iPad/tablet')+'</span></div>'
      +errHtml
      +'<div class="q-ctrl">'
      +'<select class="inp grow" data-job-printer="'+esc(j.id)+'" aria-label="Target printer"'+((j.printing)?' disabled':'')+'>'+opts+'</select>'
      +'<span class="stepper"><button type="button" data-job-cdec="'+esc(j.id)+'"'+(j.printing||ed.copies<=1?' disabled':'')+'>&minus;</button><span>'+ed.copies+'</span><button type="button" data-job-cinc="'+esc(j.id)+'"'+(j.printing||ed.copies>=20?' disabled':'')+'>+</button></span>'
      +'<button type="button" class="btn" data-view-job="'+esc(j.id)+'">View</button>'
      +'<button type="button" class="btn active" data-approve-job="'+esc(j.id)+'"'+(j.printing?' disabled':'')+'>'+(j.printing?'Printing…':'Print')+'</button>'
      +'<button type="button" class="btn" data-dismiss-job="'+esc(j.id)+'"'+(j.printing?' disabled':'')+'>Dismiss</button>'
      +'</div></div></div>';
  }).join('');
}
function openPvModal(job,pageIdx){
  if(!job)return;
  pvState={job:job,page:Math.max(0,Math.min((job.pageCount||1)-1,pageIdx||0))};
  const m=document.getElementById('pvModal');
  if(!m)return;
  document.getElementById('pvTitle').textContent=(job.paper||'Queued Photo')+(job.pageCount>1?' ('+job.pageCount+' pages)':'');
  document.getElementById('pvImg').src=jobThumbSrc(job,pvState.page);
  const nav=document.getElementById('pvNav');
  if(nav)nav.style.display=job.pageCount>1?'flex':'none';
  const pt=document.getElementById('pvPageTxt');
  if(pt)pt.textContent='Page '+(pvState.page+1)+' of '+job.pageCount;
  const pBtn=document.getElementById('pvPrevBtn'),nBtn=document.getElementById('pvNextBtn');
  if(pBtn)pBtn.disabled=pvState.page<=0;
  if(nBtn)nBtn.disabled=pvState.page>=(job.pageCount||1)-1;
  const ed=editForJob(job);
  document.getElementById('pvMeta').textContent='Target printer: '+(ed.printer||'Not chosen')+' · Copies: '+ed.copies+' · From '+(job.fromName||job.from||'tablet');
  m.className='pv-ov open';
}
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
function renderPairQr(){
  const wrap=document.getElementById('pairQrWrap'),img=document.getElementById('pairQrImg');
  if(!wrap||!img)return;
  const payload=String(state.pairQr||'');
  if(payload===lastPairQr)return;
  lastPairQr=payload;
  const qrFn=typeof qrcode==='function'?qrcode:null;
  if(!payload||!qrFn){wrap.style.display='none';return;}
  try{
    const q=qrFn(0,'M');q.addData(payload);q.make();
    img.src=q.createDataURL(4,2);
    wrap.style.display='flex';
  }catch(e){wrap.style.display='none';}
}
function renderAll(force){
  document.getElementById('pinTxt').textContent=state.pin||'------';
  const ips=(state.addresses||[]).map(function(a){return a.ip+(a.port&&a.port!==47777?':'+a.port:'')+' ('+a.kind+')';});
  document.getElementById('ipList').innerHTML=ips.length?ips.map(esc).join('<br>'):('Port '+(state.port||47777)+' (join Wi-Fi or Hotspot)');
  const fwBtn=document.getElementById('fixFwBtn');
  if(fwBtn)fwBtn.style.display=state.isWin?'':'none';
  renderPairQr();
  renderMode();
  renderPending(force);
  renderSizes();
  renderPrinters(force);
  const jobs=state.jobs||[];
  const jSig=JSON.stringify(jobs);
  if(force||jSig!==lastJobSig){
    lastJobSig=jSig;
    document.getElementById('jobBody').innerHTML=jobs.length?jobs.map(function(x){
      const cp=x.copies>1?(' ('+x.copies+'x)'):'';
      return '<tr><td>'+new Date(x.at).toLocaleTimeString()+'</td><td>'+esc(x.from)+'</td><td>'+esc(x.printer)+'</td><td>'+esc(x.paper)+cp+'</td><td><span class="tag '+(x.ok?'':'err')+'">'+(x.ok?'Printed':esc(x.error||'Error'))+'</span></td></tr>';
    }).join(''):'<tr><td colspan="5" style="color:var(--dim)">Waiting for prints…</td></tr>';
  }
}
let prSaveSeq=0,szSaveSeq=0,modeSaveSeq=0,prBusy=0,szBusy=0,modeBusy=0;
async function load(refresh){
  try{
    const r=await fetch('/station/info'+(refresh?'?refresh=1':''),{cache:'no-store'});
    const j=await r.json();
    const keepPr=prBusy>0?{selectedPrinters:state.selectedPrinters,hideUnusedPrinters:state.hideUnusedPrinters}:{};
    const keepSz=szBusy>0?{testSizes:state.testSizes,testSizesCustomized:state.testSizesCustomized}:{};
    const keepMd=modeBusy>0?{stationMode:state.stationMode}:{};
    state=Object.assign(state,j||{},keepPr,keepSz,keepMd);
    renderAll(false);
  }catch(e){}
}
async function saveMode(nextMode){
  state.stationMode=nextMode==='queue'?'queue':'auto';
  renderAll(true);
  const seq=++modeSaveSeq;
  modeBusy++;
  try{
    const r=await fetch('/station/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:state.stationMode})});
    const j=await r.json().catch(function(){return{};});
    if(seq!==modeSaveSeq)return;
    if(r.ok&&j.ok){state=Object.assign(state,j);renderAll(true);say(state.stationMode==='queue'?'Queue & view first is ON. Incoming photos wait below for review before printing.':'Auto-print is ON. Incoming photos print immediately.');}
    else say(j.error||'Could not update print mode.',true);
  }finally{modeBusy--;}
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
document.getElementById('fixFwBtn').onclick=async function(){
  const b=this;b.disabled=true;say('Allowing Print Station through Windows Firewall (Hotspot / Public)… Click Yes if Windows asks.');
  try{
    const r=await fetch('/station/fix-firewall',{method:'POST'});
    const j=await r.json().catch(function(){return{};});
    say(r.ok&&j.ok?('Windows Firewall updated \u2713'+(j.removedBlocks?(' (cleared '+j.removedBlocks+' block rule'+(j.removedBlocks===1?'':'s')+')'):'')+' — iPad can now connect over Hotspot or Wi-Fi.'):(j.error||'Could not update Windows Firewall.'),!(r.ok&&j.ok));
  }catch(e){say('Could not update Windows Firewall.',true);}
  finally{b.disabled=false;}
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
document.getElementById('modeAutoBtn').onclick=function(){saveMode('auto');};
document.getElementById('modeQueueBtn').onclick=function(){saveMode('queue');};
document.getElementById('pendingList').onchange=function(e){
  const sel=e.target.closest('select[data-job-printer]');
  if(!sel)return;
  const id=sel.dataset.jobPrinter;
  const job=(state.pendingJobs||[]).find(function(x){return x.id===id;});
  if(!job)return;
  const cur=editForJob(job);
  jobEdits[id]={printer:sel.value,copies:cur.copies};
};
document.getElementById('pendingList').onclick=async function(e){
  const dec=e.target.closest('[data-job-cdec]'),inc=e.target.closest('[data-job-cinc]');
  if(dec||inc){
    const id=(dec||inc).dataset[dec?'jobCdec':'jobCinc'];
    const job=(state.pendingJobs||[]).find(function(x){return x.id===id;});
    if(!job)return;
    const cur=editForJob(job);
    const next=Math.max(1,Math.min(20,cur.copies+(dec?-1:1)));
    jobEdits[id]={printer:cur.printer,copies:next};
    renderPending(true);
    return;
  }
  const vBtn=e.target.closest('[data-view-job]');
  if(vBtn){
    const id=vBtn.dataset.viewJob;
    const job=(state.pendingJobs||[]).find(function(x){return x.id===id;});
    if(job)openPvModal(job,0);
    return;
  }
  const apBtn=e.target.closest('[data-approve-job]');
  if(apBtn){
    const id=apBtn.dataset.approveJob;
    const job=(state.pendingJobs||[]).find(function(x){return x.id===id;});
    if(!job)return;
    const ed=editForJob(job);
    if(!ed.printer)return say('Choose a target printer first.',true);
    apBtn.disabled=true;apBtn.textContent='Printing…';
    say('Printing '+ed.copies+'x on '+ed.printer+'…');
    try{
      const r=await fetch('/station/job-approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,printer:ed.printer,copies:ed.copies})});
      const j=await r.json().catch(function(){return{};});
      state=Object.assign(state,j);
      if(r.ok&&j.ok){delete jobEdits[id];say('Printed '+ed.copies+'x on '+ed.printer+' \u2713');}
      else say(j.error||'Could not print queued photo.',true);
      renderAll(true);
    }finally{apBtn.disabled=false;}
    return;
  }
  const dmBtn=e.target.closest('[data-dismiss-job]');
  if(dmBtn){
    const id=dmBtn.dataset.dismissJob;
    dmBtn.disabled=true;
    const r=await fetch('/station/job-dismiss',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})});
    const j=await r.json().catch(function(){return{};});
    state=Object.assign(state,j);
    delete jobEdits[id];
    renderAll(true);
    say('Dismissed queued photo.');
  }
};
document.getElementById('printAllBtn').onclick=async function(){
  const btn=this;btn.disabled=true;say('Printing all queued photos…');
  try{
    const items=(state.pendingJobs||[]).slice().reverse();
    let okN=0,failN=0,lastErr='';
    for(let i=0;i<items.length;i++){
      const job=items[i],ed=editForJob(job);
      if(!ed.printer){failN++;lastErr='Choose a printer for '+job.paper;continue;}
      const r=await fetch('/station/job-approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:job.id,printer:ed.printer,copies:ed.copies})});
      const j=await r.json().catch(function(){return{};});
      state=Object.assign(state,j);
      if(r.ok&&j.ok){okN++;delete jobEdits[job.id];}
      else{failN++;lastErr=j.error||'Print failed';}
    }
    renderAll(true);
    say(failN?('Printed '+okN+', '+failN+' failed: '+lastErr):('Printed all '+okN+' queued photos \u2713'),failN>0);
  }finally{btn.disabled=false;}
};
document.getElementById('clearAllBtn').onclick=async function(){
  const r=await fetch('/station/jobs-dismiss-all',{method:'POST'});
  const j=await r.json().catch(function(){return{};});
  state=Object.assign(state,j);
  jobEdits={};
  renderAll(true);
  say('Dismissed all queued photos.');
};
document.getElementById('pvCloseBtn').onclick=function(){document.getElementById('pvModal').className='pv-ov';};
document.getElementById('pvModal').onclick=function(e){if(e.target===this)this.className='pv-ov';};
document.getElementById('pvPrevBtn').onclick=function(){if(pvState.job)openPvModal(pvState.job,pvState.page-1);};
document.getElementById('pvNextBtn').onclick=function(){if(pvState.job)openPvModal(pvState.job,pvState.page+1);};
load(true);
setInterval(function(){load(false);},3000);
</script>
</body>
</html>`;
}
