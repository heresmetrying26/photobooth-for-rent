// photobooth4u for Windows and Mac (offline).
//
// The booth itself is the same page as photobooth4u.netlify.app (protected/booth.html),
// served from inside the app at app://booth/ together with the web app's own
// server code (setup, vouchers, print counts) running on this laptop. Photos are
// saved in Pictures/photobooth4u and guests get them by QR over the booth Wi-Fi.
// The internet is only needed to activate (or paste an offline key) and, for a
// lifetime code, once every few weeks to renew the licence.
import { app, BrowserWindow, protocol, session, ipcMain, shell, dialog, Menu, net, nativeImage, powerSaveBlocker, powerMonitor, screen, clipboard } from 'electron';
import { readFileSync, existsSync, statSync, createReadStream, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, normalize, extname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import * as L from './lib/licence.mjs';
import { initServer, setBoothHtml, syncRecord, handleApi, boothPage } from './lib/server.mjs';
import { initSetupSync, handleSetupRequest, syncAllNow } from './lib/setup-sync.mjs';
import { allowBoothRequest } from './lib/netguard.mjs';
import { createLanHandler, newPin, validPin } from './lib/lan.mjs';
import { initPhotos, setLanHandler, driveRequest, startShareServer, stopShareServer, shareBase, lanAddress, sharePortNow, photosRoot, setPhotosRoot, folderPathOf, setSpinDir, spinDirNow, spinEditedDir, spinSendUrl, spinPreviewBase, spinList, spinShare, spinSaveVideo, spinConnectInfo, spinLookOfferSet, spinSendCfgSet, spinClipsSet, spinSendTake, spinArmStateNow, spinArmCmdPush, spinLookPicksTake, spinStatsFor, setWallCue, roveDirNow, roveSendUrl, rovePreviewBase, roveList, roveTake, roveStateSet, roveCmdTake, setGuestPrint, setGuestView, printReqList, printReqDone, printReqRead, printNowTake, printNowDone, setPrintNowConfig, studioFolders, studioList, studioRead, setExternalWifi, getHotspotTrafficState } from './lib/photos.mjs';
import { initBridge, getBridgeInfo, renewBridgeToken, pushBridgeState, sendBridgeEvent, sendCamCommand } from './lib/guest-bridge.mjs';
import { initLanStation, getLanStationInfo, rotateLanStationPin, setStationPrinterFilter, setStationTestSizes, setStationMode, getPendingStationJobPages, approvePendingStationJob, dismissPendingStationJob, printAllPendingStationJobs, dismissAllPendingStationJobs, buildStationTestJob, recordStationJob } from './lib/lan-print-station.mjs';
import { initHelper, handleHelper, stopHelper } from './lib/helper.mjs';
import { probeSensor, startSensor, stopSensor, latestSensor } from './lib/winsensor.mjs';
import { makeShrinkPage, makePngToJpeg } from './lib/pageshrink.mjs';
import { makeSelphyJobBuilder } from './lib/selphyusb.mjs';
import { makeDnpJobBuilder } from './lib/dnpusb.mjs';
import * as SPIN from './lib/spin.mjs';
import { detectWifi } from './lib/wifi.mjs';
import { initHotspot, hotspotInfo, hotspotStart, hotspotStop, hotspotStopOnQuit, hotspotSetAuto, hotspotSetAutoRecycle, hotspotRecycle, hotspotRaiseLimit, hotspotSetup, hotspotFixFirewall, hotspotSetCreds, hotspotWake, hotspotTouch, hotspotSuspend, hotspotResume } from './lib/hotspot.mjs';
import { freeCamera, guardCamera, stopGuardCamera } from './lib/camfree.mjs';
import { scanUsb } from './lib/usbscan.mjs';
import { stopUsbEnum } from './lib/usb-enum.mjs';
import { evaluateGraphicsMode, buildChromiumSwitches, markStartupBegin, markStartupReady, recordGpuCrash, recordUnresponsive, markAutoRelaunch, setManualSafeGraphics, graphicsStatusSummary } from './lib/stability.mjs';
import * as U from './lib/updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build');
const PAGES = join(HERE, 'pages');
const ORIGIN = 'app://booth';
const VERSION = app.getVersion();
const KEY_A = 'pb4u·desk·7f3c1e9a';
const DRIVE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxv0WfF9rxFY9QlseCoSjrA7vePwHE-Uc8QTURZYyN6yIzcTj4SIlktEWT6Xnaw6Pv9OA/exec';
const CLOUD_API_PATHS = new Set(['/api/ticket', '/api/guestview', '/api/events', '/api/printreq', '/api/pay', '/api/gallery']);

// Graphics & hang protection (see lib/stability.mjs).
// On Windows, disable SkiaGraphite (stay on Ganesh + ANGLE D3D11) and never force enable-gpu-rasterization:
// Intel UHD / Iris Xe and AMD Radeon drivers (e.g. ASUS VivoBook) can deadlock under Graphite/Dawn or forced
// rasterization and freeze the window as "(Not Responding)". Safe Graphics turns hardware acceleration off
// automatically after sustained freezes, repeated startup hangs, or GPU crashes (and clears stale shader caches).
const gfxEval = evaluateGraphicsMode({ dataDir: app.getPath('userData'), argv: process.argv });
const SAFE_GFX = gfxEval.safe;
const GFX_REASON = gfxEval.reason;
const gfxCfg = buildChromiumSwitches({ platform: process.platform, safe: SAFE_GFX });
if (gfxEval.clearedCaches.length) console.log('[graphics] cleared stale GPU cache(s): ' + gfxEval.clearedCaches.join(', '));
if (gfxEval.sawStartupHang) console.log('[graphics] previous start did not finish cleanly');
if (gfxCfg.disableHardwareAcceleration) {
  app.disableHardwareAcceleration();
  console.log('[graphics] safe graphics (' + GFX_REASON + '): acceleration is off on this laptop');
}
for (const [sw, val] of gfxCfg.switches) app.commandLine.appendSwitch(sw, val);

let logQueue = Promise.resolve();
function writeCamLogAsync(m) {
  let camLog = '';
  try { camLog = join(app.getPath('userData'), 'camera.log'); } catch { return; }
  const line = new Date().toISOString() + ' ' + m + '\n';
  logQueue = logQueue.then(async () => {
    try {
      await appendFile(camLog, line, 'utf8');
      const st = await stat(camLog);
      if (st.size > 512 * 1024) await writeFile(camLog, line, 'utf8');
    } catch { /* the log is a convenience */ }
  });
}

app.on('child-process-gone', (e, d) => {
  if (!d || d.type !== 'GPU' || d.reason === 'clean-exit' || d.reason === 'killed') return;
  console.log('[graphics] the graphics process stopped: ' + d.reason);
  writeCamLogAsync('[graphics] GPU process stopped: ' + d.reason);
  const res = recordGpuCrash({ dataDir: app.getPath('userData'), reason: d.reason, safe: SAFE_GFX });
  if (res.switchedToSafe) {
    console.log('[graphics] switched to safe graphics from the next start');
    writeCamLogAsync('[graphics] switched to safe graphics from the next start');
  }
});

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true, allowServiceWorkers: false }
}]);

let win = null, photomanWin = null, blocker = null, settings = {};
let isQuitting = false, clockTimer = null, checkinTimer = null;
function broadcastWin(channel, data) {
  [win, photomanWin].forEach((w) => {
    try { if (w && !w.isDestroyed()) w.webContents.send(channel, data); } catch { /* ignore */ }
  });
}
const dataDir = () => app.getPath('userData');
const settingsFile = () => join(dataDir(), 'settings.json');
function loadSettings() { try { settings = JSON.parse(readFileSync(settingsFile(), 'utf8')) || {}; } catch { settings = {}; } }
function saveSettings() { try { writeFileSync(settingsFile(), JSON.stringify(settings, null, 1)); } catch { /* ignore */ } }

// ---------- the booth page (kept scrambled inside the installer) ----------
function decryptBooth() {
  const meta = JSON.parse(readFileSync(join(BUILD, 'meta.json'), 'utf8'));
  const buf = readFileSync(join(BUILD, 'booth.bin'));
  const key = createHash('sha256').update(KEY_A + '|' + meta.k).digest();
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---------- licence state -> local code record ----------
function allowedAppMode() {
  const s = L.status();
  const m = s.p && s.p.feat && s.p.feat.appMode;
  return (m === 'online' || m === 'both' || m === 'offline') ? m : 'offline';
}
function isOnlineMode() {
  const m = allowedAppMode();
  if (m === 'online') return true;
  if (m === 'both') return settings.boothMode === 'online';
  return false;
}
const printStationAllowed = () => { const s = L.status(); return !!(s.p && s.p.feat && s.p.feat.printStationOpt === true); };
const arrangePrintAllowed = () => { const s = L.status(); return !!(s.p && s.p.feat && s.p.feat.arrangePrintOpt === true); };
async function refreshRecord() {
  const s = L.status();
  if (s.p) await syncRecord(s.p, L.deviceId(), s.ok);
  return s;
}
async function checkinNow(force) {
  const prevOnline = isOnlineMode();
  const prevMode = allowedAppMode();
  const prevPs = printStationAllowed();
  const prevAp = arrangePrintAllowed();
  const r = await L.checkin(net.fetch.bind(net), force);
  if (r === 'ok' || r === 'revoked') await refreshRecord();
  if (r === 'ok') syncAllNow().catch(() => { });
  const nextOnline = isOnlineMode();
  const nextMode = allowedAppMode();
  const nextPs = printStationAllowed();
  const nextAp = arrangePrintAllowed();
  if (!prevOnline && nextOnline) { try { hotspotStop().catch(() => { }); } catch { } }
  if (r === 'revoked' || prevOnline !== nextOnline || prevMode !== nextMode || prevPs !== nextPs || prevAp !== nextAp) {
    broadcastWin('pb4u:licence', { ...L.info(), appMode: nextMode, online: nextOnline, modeChanged: prevOnline !== nextOnline, printStationOpt: nextPs, printStationChanged: prevPs !== nextPs, arrangePrintOpt: nextAp, arrangePrintChanged: prevAp !== nextAp });
  }
  return r;
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.tflite': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf' };
const LOCAL_STATIC = ['/bg/', '/camera-test/build/', '/pay/', '/fonts/', '/img/'];
function fileResponse(base, rel, extra) {
  const f = normalize(join(base, rel));
  if (!f.startsWith(normalize(base) + sep) || !existsSync(f) || statSync(f).isDirectory()) return new Response('Not found', { status: 404 });
  return new Response(Readable.toWeb(createReadStream(f)), {
    status: 200,
    headers: { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'cross-origin-resource-policy': 'same-origin', ...(extra || {}) }
  });
}
const ISOLATE = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' };
const htmlRes = (html, extra) => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...ISOLATE, ...(extra || {}) } });
const jsonRes = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function desktopHead() {
  const s = L.status();
  const feat = (s.p && s.p.feat) || {};
  const onlineNow = isOnlineMode();
  const d = {
    v: VERSION,
    os: L.osKey(),
    server: L.SERVER,
    appMode: allowedAppMode(),
    online: onlineNow,
    printStationOpt: !!feat.printStationOpt,
    deviceNo: feat.deviceNo || 1,
    deviceLabel: feat.deviceLabel || (s.p && s.p.label) || ''
  };
  const trialWm = !!(feat.trial && feat.watermark !== false);
  return '<script>window.__PB=window.__PB||{};window.__PB.desktop=' + JSON.stringify(d).replace(/</g, '\\u003c') + ';' +
    (trialWm ? 'window.__PB.watermark=true;' : '') +
    // In Offline Mode, everything the booth needs is on this laptop so "offline" never blocks saving.
    // In Online Mode, keep real navigator.onLine so temporary Wi-Fi drops queue uploads to Google Drive cleanly.
    (onlineNow ? '' : 'try{Object.defineProperty(Navigator.prototype,"onLine",{get:function(){return true;},configurable:true});}catch(e){}') +
    'try{sessionStorage.removeItem("pb_open_tries");}catch(e){}</script>';
}

async function serveRoot() {
  const s = await refreshRecord();
  if (!s.ok) return fileResponse(PAGES, 'activate.html', ISOLATE);
  const r = await boothPage({ deviceId: L.deviceId(), extraHead: desktopHead() });
  if (r.locked) return fileResponse(PAGES, 'activate.html', ISOLATE);
  return htmlRes(r.html);
}

// Camera diagnostics: the booth reports a photo the camera didn't take (Setup > Camera switch, on by default). It is sent
// to photobooth4u with this laptop's licence, together with the end of camera.log (the camera's own answers). With no
// internet the answer says so and hands the log lines back, so the booth can keep the report and send it later.
async function camDiagForward(req) {
  let b = null;
  try { b = JSON.parse(await req.text()); } catch { b = null; }
  if (!b || typeof b !== 'object') return jsonRes({ error: 'Bad request' }, 400);
  let workerLog = typeof b.workerLog === 'string' ? b.workerLog : '';
  if (!workerLog) {
    try { const t = readFileSync(join(dataDir(), 'camera.log'), 'utf8'); workerLog = t.slice(-6000); } catch { workerLog = ''; }
  }
  const report = { camera: b.camera, error: b.error, at: b.at, log: b.log, workerLog };
  try {
    const r = await L.sendCamDiag(net.fetch.bind(net), report);
    if (r.status === 200) return jsonRes({ ok: true });
    if (r.status >= 500) return jsonRes({ ok: false, offline: true, workerLog }, 503);
    return jsonRes({ ok: false }, r.status);
  } catch { return jsonRes({ ok: false, offline: true, workerLog }, 503); }
}

// Online Mode proxy: forwards cloud API calls (/api/ticket, /api/pay, /api/guestview, /api/events, /api/printreq,
// /api/gallery) to photobooth4u.netlify.app authenticated with this laptop's signed PB4U-LIC1 licence + machine ID.
async function cloudApiForward(req, pathWithQuery) {
  const lic = L.currentLicence();
  if (!lic || !L.status().ok) return jsonRes({ error: 'locked', reason: 'invalid' }, 401);
  if (!isOnlineMode()) return jsonRes({ error: 'Online mode is not active on this device.' }, 403);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const init = { method: req.method, headers: {}, signal: ctl.signal };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let bodyObj = {};
      try { bodyObj = JSON.parse(await req.text()) || {}; } catch { bodyObj = {}; }
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify({ ...bodyObj, licence: lic, mid: L.machineId() });
    }
    const r = await net.fetch(L.SERVER + pathWithQuery, init);
    const ct = r.headers.get('content-type') || 'application/json';
    const buf = Buffer.from(await r.arrayBuffer());
    return new Response(buf, { status: r.status, headers: { 'content-type': ct, 'cache-control': 'no-store' } });
  } catch (e) {
    return jsonRes({ ok: false, error: 'No internet connection right now.' }, 503);
  } finally { clearTimeout(t); }
}

// Online Mode proxy for Google Drive Apps Script relay (avoids CORS / redirect issues from app://booth).
async function cloudDriveForward(req) {
  if (!L.status().ok) return jsonRes({ ok: false, error: 'This laptop’s licence isn’t active.' }, 401);
  if (!isOnlineMode()) return jsonRes({ ok: false, error: 'Online mode is not active on this device.' }, 403);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 65000);
  try {
    const raw = await req.text();
    const r = await net.fetch(DRIVE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: raw,
      redirect: 'follow',
      signal: ctl.signal
    });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (e) {
    return jsonRes({ ok: false, error: 'Failed to reach Google Drive. Check the internet and try again.' }, 503);
  } finally { clearTimeout(t); }
}

async function handle(req) {
  const url = new URL(req.url);
  if (url.host !== 'booth') return new Response('Not found', { status: 404 });
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/' || p === '/index.html') return await serveRoot();
    if (p === '/activate') return fileResponse(PAGES, 'activate.html', ISOLATE);
    if (p.startsWith('/app/')) return fileResponse(PAGES, p.slice(5));
    if (p.startsWith('/api/')) {
      if (!L.status().ok) return jsonRes({ error: 'locked', reason: 'invalid' }, 401);
      if (p === '/api/camdiag' && req.method === 'POST') return await camDiagForward(req);
      if (p === '/api/setup' && req.method === 'POST') return await handleSetupRequest(req);
      if (isOnlineMode() && CLOUD_API_PATHS.has(p)) return await cloudApiForward(req, p + url.search);
      return await handleApi(req, p);
    }
    if (p === '/cloud/drive' && req.method === 'POST') return await cloudDriveForward(req);
    if (p === '/local/drive' && req.method === 'POST') {
      if (!L.status().ok) return jsonRes({ ok: false, error: 'This laptop’s licence isn’t active.' }, 401);
      if (!isOnlineMode()) hotspotWake();   // Option 1: photo saved = session active, wake hotspot if idle
      const ct = String(req.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.startsWith('text/plain') && !ct.startsWith('application/json')) {
        const sp = url.searchParams;
        const buf = Buffer.from(await req.arrayBuffer());
        return jsonRes(await driveRequest({
          filename: sp.get('filename') || '',
          folderKey: sp.get('folderKey') || '',
          subfolder: sp.get('subfolder') || '',
          guestCode: sp.get('guestCode') || '',
          photoman: sp.get('photoman') === '1' || sp.get('photoman') === 'true',
          buffer: buf
        }));
      }
      const body = JSON.parse(await req.text());
      return jsonRes(await driveRequest(body));
    }
    if (p === '/local/spin-save' && req.method === 'POST') {
      if (!L.status().ok) return jsonRes({ ok: false, error: 'This laptop’s licence isn’t active.' }, 401);
      if (!isOnlineMode()) hotspotWake();
      const buf = Buffer.from(await req.arrayBuffer());
      const r = await spinSaveVideo({ filename: url.searchParams.get('filename') || '', buffer: buf });
      return jsonRes(r, r.ok ? 200 : 400);
    }
    if (p.startsWith('/helper/') || p === '/helper') return await handleHelper(req, p.slice(7) || '/', url.searchParams);
    if (p.startsWith('/spin-fx/')) {
      const fxDir = SPIN.getFxDir() || (existsSync(join(HERE, 'resources', 'spin-fx')) ? join(HERE, 'resources', 'spin-fx') : join(BUILD, 'spin-fx'));
      return fileResponse(fxDir, p.slice(9));
    }
    if (LOCAL_STATIC.some((x) => p.startsWith(x)) || p.endsWith('.pdf')) return fileResponse(join(BUILD, 'public'), p.slice(1));
  } catch (e) {
    console.error(e);
    return jsonRes({ ok: false, error: String(e && e.message || e) }, 500);
  }
  return new Response('Not found', { status: 404 });
}

// Pages that only exist on the website (My Events, guides, downloads) open in the browser.
function openOutside(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'app:' && url.pathname.endsWith('.pdf')) {
      const localPdf = join(BUILD, 'public', url.pathname.slice(1));
      if (existsSync(localPdf)) { shell.openPath(localPdf); return; }
    }
    if (url.protocol === 'app:') { shell.openExternal(L.SERVER + url.pathname + url.search + url.hash); return; }
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') shell.openExternal(url.href);
  } catch { /* ignore */ }
}
// (new URL('app://booth/').origin is "null" for custom schemes, so compare protocol + host.)
const isOurs = (u) => { try { const x = new URL(u); return x.protocol === 'app:' && x.host === 'booth'; } catch { return false; } };
const isLocalPage = (u) => { try { const x = new URL(u); return isOurs(u) && (x.pathname === '/' || x.pathname.startsWith('/pay/') || x.pathname.startsWith('/app/') || x.pathname === '/activate'); } catch { return false; } };

function relaunchArgs(extra = []) {
  const base = process.argv.slice(1).filter((a) => a !== '--safe-graphics' && a !== '--disable-gpu');
  return base.concat(Array.isArray(extra) ? extra : []);
}

function cleanupForExit() {
  if (blocker !== null) {
    try { if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker); } catch { /* ignore */ }
    blocker = null;
  }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (checkinTimer) { clearInterval(checkinTimer); checkinTimer = null; }
  try { markStartupReady(dataDir()); } catch { /* ignore */ }
  try { stopSensor(); } catch { /* ignore */ }
  try { stopUsbEnum(); } catch { /* ignore */ }
  try { stopHelper(); } catch { /* ignore */ }
  try { stopShareServer(); } catch { /* ignore */ }
  try { hotspotStopOnQuit(); } catch { /* ignore */ }
  try { stopGuardCamera(); } catch { /* ignore */ }
  try { L.touchClock(); } catch { /* ignore */ }
}

function attachStabilityWatchdogs(targetWin, { primary = false, reloadUrl = ORIGIN + '/' } = {}) {
  let unrespTimer = null;
  let reloadHits = [];
  const allowReload = (maxCount, windowMs) => {
    const now = Date.now();
    reloadHits = reloadHits.filter((t) => now - t < windowMs);
    if (reloadHits.length >= maxCount) return false;
    reloadHits.push(now);
    return true;
  };
  const clearUnresp = () => { if (unrespTimer) { clearTimeout(unrespTimer); unrespTimer = null; } };

  targetWin.on('unresponsive', () => {
    if (isQuitting || targetWin.isDestroyed()) return;
    console.log('[stability] window became unresponsive');
    writeCamLogAsync('[stability] window became unresponsive (safeGfx=' + SAFE_GFX + ')');
    clearUnresp();
    unrespTimer = setTimeout(() => {
      unrespTimer = null;
      if (isQuitting || targetWin.isDestroyed()) return;
      console.log('[stability] window stayed unresponsive for 12 s');
      writeCamLogAsync('[stability] window stayed unresponsive for 12 s');
      const res = recordUnresponsive({ dataDir: dataDir(), safe: SAFE_GFX });
      if (primary && res.canAutoRelaunch) {
        console.log('[stability] switching to safe graphics and restarting automatically');
        writeCamLogAsync('[stability] auto-relaunching in safe graphics mode');
        markAutoRelaunch({ dataDir: dataDir() });
        isQuitting = true;
        cleanupForExit();
        app.relaunch({ args: relaunchArgs(['--safe-graphics']) });
        app.exit(0);
        return;
      }
      if (allowReload(2, 5 * 60 * 1000)) {
        try { targetWin.webContents.reloadIgnoringCache(); } catch { /* ignore */ }
      }
    }, 12000);
  });

  targetWin.on('responsive', () => {
    if (unrespTimer) {
      clearUnresp();
      console.log('[stability] window became responsive again');
      writeCamLogAsync('[stability] window became responsive again');
    }
  });

  targetWin.webContents.on('render-process-gone', (e, d) => {
    if (isQuitting || targetWin.isDestroyed()) return;
    const reason = (d && d.reason) || 'unknown';
    if (reason === 'clean-exit') return;
    console.log('[stability] renderer stopped: ' + reason);
    writeCamLogAsync('[stability] renderer stopped: ' + reason);
    if (reason === 'crashed' || reason === 'oom') {
      recordGpuCrash({ dataDir: dataDir(), reason: 'renderer-' + reason, safe: SAFE_GFX });
    }
    if (allowReload(3, 60000)) {
      setTimeout(() => {
        if (!isQuitting && !targetWin.isDestroyed()) {
          try { targetWin.loadURL(reloadUrl); } catch { /* ignore */ }
        }
      }, 600);
    }
  });

  targetWin.on('closed', () => { clearUnresp(); });
}

function createWindow() {
  if (!SAFE_GFX) markStartupBegin(dataDir());
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#F5F1EA',
    title: 'photobooth4u', icon: existsSync(join(HERE, 'resources', 'icon.png')) ? join(HERE, 'resources', 'icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  let shown = false;
  const showNow = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    clearTimeout(showFallback);
    win.maximize();
    win.show();
  };
  const showFallback = setTimeout(showNow, 6000);
  if (showFallback.unref) showFallback.unref();
  win.once('ready-to-show', showNow);
  win.webContents.once('did-finish-load', () => {
    const t = setTimeout(() => {
      if (isQuitting || !win || win.isDestroyed()) return;
      win.webContents.executeJavaScript('1', false).then(() => { markStartupReady(dataDir()); }, () => { /* still wedged */ });
    }, 5000);
    if (t.unref) t.unref();
  });
  attachStabilityWatchdogs(win, { primary: true, reloadUrl: ORIGIN + '/' });
  wireContents(win.webContents);
  win.loadURL(ORIGIN + '/');
  win.on('closed', () => {
    clearTimeout(showFallback);
    markStartupReady(dataDir());
    win = null;
    if (photomanWin && !photomanWin.isDestroyed()) { try { photomanWin.close(); } catch { /* ignore */ } }
  });
}

function createPhotomanWindow() {
  if (photomanWin && !photomanWin.isDestroyed()) {
    if (photomanWin.isMinimized()) photomanWin.restore();
    photomanWin.show();
    photomanWin.focus();
    return photomanWin;
  }
  let b = null;
  try {
    if (win && !win.isDestroyed()) {
      const other = screen.getAllDisplays().find((d) => d.id !== screen.getDisplayMatching(win.getBounds()).id);
      if (other) b = other.workArea;
    }
  } catch { /* ignore */ }
  photomanWin = new BrowserWindow({
    width: b ? b.width : 1280, height: b ? b.height : 840, minWidth: 900, minHeight: 600,
    ...(b ? { x: b.x, y: b.y } : {}),
    show: false, backgroundColor: '#FAF7F2',
    title: 'photobooth4u – Photographer Studio',
    icon: existsSync(join(HERE, 'resources', 'icon.png')) ? join(HERE, 'resources', 'icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  photomanWin.once('ready-to-show', () => {
    if (b) photomanWin.maximize();
    photomanWin.show();
    if (win && !win.isDestroyed()) win.webContents.send('pb4u:photomanState', { open: true });
  });
  attachStabilityWatchdogs(photomanWin, { primary: false, reloadUrl: ORIGIN + '/?desk=photoman' });
  wireContents(photomanWin.webContents);
  photomanWin.loadURL(ORIGIN + '/?desk=photoman');
  photomanWin.on('closed', () => {
    photomanWin = null;
    if (win && !win.isDestroyed()) win.webContents.send('pb4u:photomanState', { open: false });
  });
  return photomanWin;
}

let btAuto = null;                   // an Instax printer being reconnected by name: { name, cb, timer }
function wireContents(wc) {
  // Instax Link printers (Web Bluetooth). Electron shows no picker of its own, so the booth's request is answered here:
  // the printers nearby are collected for about 3 seconds, one is taken at once, several are offered in a small dialog.
  // Only devices named INSTAX are ever offered.
  // The page asks for Instax printers by name, or (when it says "show all") for every device, so what arrives here is what
  // the page asked for. One printer nearby is taken at once; if anything that is not an Instax is in the list, the operator chooses.
  // A printer set up before is reconnected by name with no question (see pb4u:bluetoothReconnect).
  let btSel = null;
  wc.on('select-bluetooth-device', (event, devices, cb) => {
    event.preventDefault();
    if (btAuto) {
      btAuto.cb = cb;
      const hit = (devices || []).find((d) => d.deviceName === btAuto.name);
      if (hit) { cb(hit.deviceId); return; }
      if (!btAuto.timer) btAuto.timer = setTimeout(() => { try { if (btAuto && btAuto.cb) btAuto.cb(''); } catch { /* ignore */ } }, 8000);
      return;
    }
    if (btSel) { btSel.cb = cb; btSel.devices = devices; return; }
    btSel = { cb, devices, start: Date.now() };
    const tick = async () => {
      const s = btSel; if (!s) return;
      const list = (s.devices || []).filter((d) => d.deviceName);
      if (!list.length && Date.now() - s.start < 15000) { setTimeout(tick, 1000); return; }
      btSel = null;
      if (!list.length) { s.cb(''); return; }
      if (list.length === 1 && /instax/i.test(list[0].deviceName)) { s.cb(list[0].deviceId); return; }
      try {
        const shown = list.slice(0, 10), opts = { type: 'question', title: 'Bluetooth device', message: 'Select the Bluetooth printer to connect:', buttons: shown.map((d) => d.deviceName).concat('Cancel'), defaultId: 0, cancelId: shown.length, noLink: true };
        const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        s.cb(r.response < shown.length ? shown[r.response].deviceId : '');
      } catch { s.cb(''); }
    };
    setTimeout(tick, 3000);
  });
  wc.on('will-navigate', (e, u) => { if (!isLocalPage(u)) { e.preventDefault(); openOutside(u); } });
  wc.setWindowOpenHandler(({ url, frameName }) => {
    // Dedicated Photographer Studio window (single-instance, preload bridge included).
    if (frameName === 'pb4uPhotoman' || (isLocalPage(url) && /(?:\?|&)desk=photoman\b/.test(url))) {
      createPhotomanWindow();
      return { action: 'deny' };
    }
    // The guest screen (opened empty, then filled by the booth) and printable voucher tickets.
    if (!url || url === 'about:blank' || frameName === 'pb4uGuest') {
      const other = screen.getAllDisplays().find((d) => d.id !== screen.getDisplayMatching(win.getBounds()).id);
      const b = other ? other.workArea : null;
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#000000', title: 'photobooth4u – guest screen', ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : {}), webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } } };
    }
    if (isLocalPage(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 900, height: 1000, webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false } } };
    openOutside(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => { wireContents(child.webContents); });
}

function setupSession() {
  const ses = session.defaultSession;
  const ours = (u) => isOurs(u) || u === 'about:blank' || u === '';
  const ALLOW = new Set(['media', 'fullscreen', 'window-management', 'clipboard-sanitized-write', 'clipboard-read', 'usb', 'hid', 'serial', 'pointerLock', 'notifications', 'speaker-selection', 'keyboardLock']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(ALLOW.has(perm) && ours(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => ALLOW.has(perm) && (!origin || isOurs(origin) || origin === 'null' || (wc && isOurs(wc.getURL()))));
  // The booth only needs the camera. Left open to every USB device, the page also saw the laptop's own camera, keyboard,
  // Bluetooth and any hub, and the camera library failed with "Unknown model". The handler is only told the device's vendor and
  // class (not its interfaces), so a camera is recognised by its maker (Sony, Nikon, Canon, Fujifilm, Olympus, Panasonic, Pentax).
  const CAM_VENDORS = [0x054c, 0x04b0, 0x04a9, 0x04cb, 0x07b4, 0x04da, 0x0a17, 0x2e1a];
  const pickedVendors = new Set();                  // a camera of another maker that was chosen in the picker
  const camLike = (dev) => !dev || CAM_VENDORS.includes(dev.vendorId) || pickedVendors.has(dev.vendorId) || dev.deviceClass === 6;
  ses.setDevicePermissionHandler((d) => ((d.deviceType === 'usb' && camLike(d.device)) || d.deviceType === 'hid') && (!d.origin || isOurs(d.origin) || d.origin === 'null'));
  ses.setUSBProtectedClassesHandler(() => []);
  // Chrome would show a USB picker; the booth camera is the device we want.
  ses.on('select-usb-device', (event, details, cb) => {
    event.preventDefault();
    guardCamera(10000);   // Mac: stop macOS holding the camera while the booth connects
    const list = details.deviceList || [];
    const cam = list.find((d) => /nikon|canon|sony|fuji|olympus|panasonic|camera|eos|pentax|leica|ricoh|insta\s*360/i.test((d.manufacturerName || '') + ' ' + (d.productName || ''))) || list[0];
    if (cam && cam.vendorId) pickedVendors.add(cam.vendorId);
    cb(cam ? cam.deviceId : '');
  });
  // Block anything leaving the laptop from the booth page except our own server.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
    const fromBooth = d.webContents && !d.webContents.isDestroyed() && ours(d.webContents.getURL());
    if (!fromBooth) return cb({});
    // The booth page plays the 360 videos from, and sends clips to, this laptop's own share server (see lib/netguard.mjs).
    if (allowBoothRequest(d.url, sharePortNow())) return cb({});
    cb({ cancel: true });
  });
}

function buildMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' }
  ]));
}

// iPad using this laptop's camera over the booth Wi-Fi (see lib/lan.mjs)
// Off by default; Admin can turn this on per code (the licence's feat.ipadOpt === true).
const ipadAllowed = () => { const s = L.status(); return !!(s.p && s.p.feat && s.p.feat.ipadOpt === true); };

// ---------- IPC (preload.cjs) ----------
let lanBaseCache = { at: 0, value: null };
function shareBaseCached() {
  const now = Date.now();
  if (now - lanBaseCache.at < 2000) return lanBaseCache.value;
  lanBaseCache = { at: now, value: shareBase() };
  return lanBaseCache.value;
}
function invalidateLanCache() { lanBaseCache.at = 0; }

function wireIpc() {
  ipcMain.on('pb4u:lan', (e) => { e.returnValue = shareBaseCached(); });
  ipcMain.on('pb4u:localBase', (e) => { const p = sharePortNow(); e.returnValue = p ? ('http://127.0.0.1:' + p) : null; });
  ipcMain.handle('pb4u:graphicsInfo', () => graphicsStatusSummary({ dataDir: dataDir(), activeSafe: SAFE_GFX, activeReason: GFX_REASON }));
  ipcMain.handle('pb4u:setSafeGraphics', (e, mode, restart) => {
    const cleanMode = mode === 'on' ? 'on' : mode === 'off' ? 'off' : 'auto';
    const r = setManualSafeGraphics({ dataDir: dataDir(), mode: cleanMode });
    const out = { ok: true, ...r, ...graphicsStatusSummary({ dataDir: dataDir(), activeSafe: SAFE_GFX, activeReason: GFX_REASON }) };
    if (restart) {
      setTimeout(() => {
        isQuitting = true;
        cleanupForExit();
        app.relaunch({ args: relaunchArgs(cleanMode === 'on' ? ['--safe-graphics'] : []) });
        app.exit(0);
      }, 150);
    }
    return out;
  });
  // Reconnect an Instax printer that was set up before. Chromium only opens the Bluetooth chooser for a tap, so the booth
  // asks here and the app runs the request "as a tap" itself; the printer is taken by its name and the operator is not asked.
  let btQueue = Promise.resolve();
  ipcMain.handle('pb4u:bluetoothReconnect', (e, name) => {
    name = String(name || '').slice(0, 80);
    if (!name) return Promise.resolve({ ok: false, error: 'No printer name.' });
    const run = async () => {
      btAuto = { name, cb: null, timer: null };
      try {
        const code = 'window._instax && window._instax._autoPair ? window._instax._autoPair(' + JSON.stringify(name) + ').then(function (n) { return { ok: true, name: n }; }, function (x) { return { ok: false, error: String((x && x.message) || x) }; }) : { ok: false, error: "The Instax driver is not loaded." }';
        return await e.sender.executeJavaScript(code, true);
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      } finally {
        if (btAuto && btAuto.timer) clearTimeout(btAuto.timer);
        btAuto = null;
      }
    };
    const next = btQueue.then(run, run);
    btQueue = next.catch(() => { });
    return next;
  });
  ipcMain.handle('pb4u:wifi', async (e, force) => {
    const w = await detectWifi(!!force);
    if (w && w.ssid) setExternalWifi(w.ssid, w.pass);
    return w;
  });
  // The booth's own Wi-Fi (Windows' Mobile hotspot, see lib/hotspot.mjs)
  ipcMain.handle('pb4u:hotspot', () => hotspotInfo());
  ipcMain.handle('pb4u:hotspotWake', () => { if (!isOnlineMode()) hotspotWake(); return hotspotInfo(); });   // Option 1: UI signals session start
  ipcMain.handle('pb4u:hotspotSet', (e, on) => (on ? hotspotStart() : hotspotStop()));
  ipcMain.handle('pb4u:hotspotAuto', (e, on) => hotspotSetAuto(!!on));
  ipcMain.handle('pb4u:hotspotAutoRecycle', (e, on) => hotspotSetAutoRecycle(!!on));
  ipcMain.handle('pb4u:hotspotRecycle', async () => hotspotRecycle({ auto: false }));
  ipcMain.handle('pb4u:hotspotRaiseLimit', async (e, target) => hotspotRaiseLimit(target));
  ipcMain.handle('pb4u:hotspotCreds', (e, ssid, pass) => {
    setExternalWifi(ssid, pass);
    return hotspotSetCreds(String(ssid || ''), String(pass || ''));
  });
  ipcMain.handle('pb4u:hotspotSetup', async () => { const r = await hotspotSetup(); return { ...r, info: hotspotInfo() }; });
  ipcMain.handle('pb4u:hotspotFixFirewall', async () => { const r = await hotspotFixFirewall(); return { ...r, info: hotspotInfo() }; });
  ipcMain.handle('pb4u:vgFinalize', async (e, req) => SPIN.finalizeGuestbookVideo(req || {}));
  ipcMain.handle('pb4u:info', async () => ({
    licence: L.info(), version: VERSION, update: U.info(), photos: photosRoot(), share: shareBase(), lanIp: lanAddress(), port: sharePortNow(), server: L.SERVER,
    appMode: allowedAppMode(), onlineMode: isOnlineMode()
  }));
  ipcMain.handle('pb4u:activate', async (e, code, label) => {
    const r = await L.activate(net.fetch.bind(net), code, label);
    if (r.ok) await refreshRecord();
    return r;
  });
  ipcMain.handle('pb4u:activateOffline', async (e, text) => {
    const r = L.activateOffline(text);
    if (r.ok) await refreshRecord();
    return r;
  });
  ipcMain.handle('pb4u:renameDevice', async (e, label) => {
    const r = await L.renameDevice(net.fetch.bind(net), label);
    if (r.ok) await refreshRecord();
    return { ...r, licence: L.info() };
  });
  ipcMain.handle('pb4u:setMode', async (e, mode) => {
    const allowed = allowedAppMode();
    if (allowed !== 'both') return { ok: false, error: 'This device’s mode is set to ' + allowed + ' in Admin.', appMode: allowed, online: isOnlineMode() };
    const next = mode === 'online' ? 'online' : 'offline';
    const prevOnline = isOnlineMode();
    settings.boothMode = next;
    saveSettings();
    if (next === 'online') { try { hotspotStop().catch(() => { }); } catch { } }
    return { ok: true, appMode: allowed, online: isOnlineMode(), changed: prevOnline !== isOnlineMode() };
  });
  ipcMain.handle('pb4u:checkin', async () => {
    const prevOnline = isOnlineMode();
    const r = await checkinNow(true);
    return { result: r, licence: L.info(), appMode: allowedAppMode(), online: isOnlineMode(), modeChanged: prevOnline !== isOnlineMode() };
  });
  ipcMain.handle('pb4u:syncNow', () => syncAllNow());
  ipcMain.handle('pb4u:deactivate', async () => {
    const r = await L.deactivate(net.fetch.bind(net));
    if (r.ok) await syncRecord(null, L.deviceId(), false);
    return r;
  });
  ipcMain.handle('pb4u:openPhotos', async (e, folderUrl) => {
    const p = (folderUrl && folderPathOf(folderUrl)) || photosRoot();
    mkdirSync(p, { recursive: true });
    return shell.openPath(p);
  });
  ipcMain.handle('pb4u:choosePhotos', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Where to save the booth photos', defaultPath: photosRoot(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = join(r.filePaths[0], /photobooth4u$/i.test(r.filePaths[0]) ? '' : 'photobooth4u');
    setPhotosRoot(dir); settings.photos = dir; saveSettings();
    return dir;
  });
  // Printable signs (Wi-Fi sign...): always ask where to save, starting in the folder used last time.
  ipcMain.handle('pb4u:saveFile', async (e, name, bytes) => {
    const SAVE_EXT = { png: 'PNG image', jpg: 'JPG image', jpeg: 'JPG image', pdf: 'PDF document' };
    const clean = basename(String(name || 'file.png')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 120) || 'file.png';
    const ext = extname(clean).slice(1).toLowerCase();
    if (!SAVE_EXT[ext]) return { ok: false, error: 'That file type can’t be saved here.' };
    let data; try { data = Buffer.from(bytes); } catch { return { ok: false, error: 'Nothing to save.' }; }
    if (!data.length || data.length > 60 * 1024 * 1024) return { ok: false, error: 'Nothing to save.' };
    let start; try { start = (settings.saveDir && existsSync(settings.saveDir)) ? settings.saveDir : app.getPath('downloads'); } catch { start = photosRoot(); }
    const r = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: join(start, clean), filters: [{ name: SAVE_EXT[ext], extensions: [ext] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePath) return null;
    try {
      writeFileSync(r.filePath, data);
      settings.saveDir = dirname(r.filePath); saveSettings();
      return { ok: true, path: r.filePath, dir: dirname(r.filePath) };
    } catch (err) { return { ok: false, error: 'Couldn’t save there: ' + String((err && err.message) || err).slice(0, 120) }; }
  });
  // Photographer desk: a folder the photographer's photos arrive in (camera software, FTP or Wi-Fi tool saves there).
  // The page only ever reads image files directly inside the folder the operator picked.
  const DESK_EXT = /\.(jpe?g|png|webp)$/i;
  ipcMain.handle('pb4u:deskFolder', () => settings.deskDir || null);
  ipcMain.handle('pb4u:deskChoose', async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender) || win;
    const r = await dialog.showOpenDialog(owner, { title: 'Folder the photographer\u2019s photos arrive in', defaultPath: settings.deskDir || photosRoot(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.deskDir = r.filePaths[0]; saveSettings();
    return settings.deskDir;
  });
  ipcMain.handle('pb4u:openPhotomanWindow', () => {
    createPhotomanWindow();
    return { ok: true };
  });
  ipcMain.handle('pb4u:focusBoothWindow', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return { ok: true };
  });
  ipcMain.handle('pb4u:deskScan', () => {
    const dir = settings.deskDir; if (!dir || !existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((n) => DESK_EXT.test(n)).map((n) => { try { const st = statSync(join(dir, n)); return st.isFile() ? { name: n, size: st.size, mtime: st.mtimeMs } : null; } catch { return null; } })
        .filter(Boolean).sort((x, y) => y.mtime - x.mtime).slice(0, 300);
    } catch { return []; }
  });
  ipcMain.handle('pb4u:deskRead', (e, name) => {
    const dir = settings.deskDir; const n = basename(String(name || ''));
    if (!dir || !DESK_EXT.test(n)) return null;
    try { return readFileSync(join(dir, n)); } catch { return null; }
  });
  // 360 videos: the inbox folder, the phone send page, and sharing a clip into the event
  const spinInfo = () => ({ dir: spinDirNow(), sendUrl: spinSendUrl(), previewBase: spinPreviewBase() });
  ipcMain.handle('pb4u:spinInfo', () => spinInfo());
  // Roving photos: phones send photos to an inbox; the booth takes each one, frames it and gives it a QR
  ipcMain.handle('pb4u:roveInfo', () => ({ dir: roveDirNow(), sendUrl: roveSendUrl(), previewBase: rovePreviewBase() }));
  ipcMain.handle('pb4u:roveScan', () => roveList());
  ipcMain.handle('pb4u:roveTake', (e, name) => roveTake(name));
  ipcMain.handle('pb4u:roveStateSet', (e, st) => { try { return roveStateSet(st); } catch { return false; } });
  ipcMain.handle('pb4u:roveCmdTake', () => { try { return roveCmdTake(); } catch { return []; } });
  // Guests asking for a print from their phone: switched on from the booth's Print settings; requests wait here
  ipcMain.handle('pb4u:printNowTake', () => printNowTake());
  ipcMain.handle('pb4u:printNowDone', (e, id, ok, msg) => printNowDone(id, !!ok, msg));
  ipcMain.handle('pb4u:printConfigSet', (e, cfg) => setPrintNowConfig(cfg));
  ipcMain.handle('pb4u:guestPrintSet', (e, on) => setGuestPrint(!!on));
  ipcMain.handle('pb4u:guestViewSet', (e, mode) => setGuestView(String(mode || '')));
  ipcMain.handle('pb4u:printReqList', () => printReqList());
  ipcMain.handle('pb4u:printReqDone', (e, id) => printReqDone(id));
  ipcMain.handle('pb4u:printReqRead', (e, id) => printReqRead(id));
  // Arrange & Print: browse and read the pictures saved on this laptop
  ipcMain.handle('pb4u:studioFolders', (e, key, sub) => studioFolders(String(key || ''), String(sub || '')));
  ipcMain.handle('pb4u:studioList', (e, slug) => studioList(slug));
  ipcMain.handle('pb4u:studioRead', (e, slug, name) => studioRead(slug, name));
  ipcMain.handle('pb4u:spinChoose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Folder the 360 videos are saved to', defaultPath: spinDirNow() || photosRoot(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.spinDir = r.filePaths[0]; saveSettings(); setSpinDir(settings.spinDir);
    return spinInfo();
  });
  ipcMain.handle('pb4u:spinScan', () => spinList());
  ipcMain.handle('pb4u:spinShare', (e, name, folderKey, subfolder, outName, look) => spinShare(name, folderKey, subfolder, outName, look));
  // Editing (ffmpeg): environment, one job per clip, progress, cancel, the music file, the overlay picture
  ipcMain.handle('pb4u:spinEnv', async () => ({ ffmpeg: await SPIN.hasFfmpeg(), gpu: !!(await SPIN.findHwEncoder()), music: settings.spinMusic ? basename(settings.spinMusic) : '', musicList: musicLib().map((p) => basename(p)), stingerList: stingerLib().map((p) => basename(p)) }));
  // More tracks than the one default: a look can use its own song. The page only ever names a track; the file is found here in the list.
  const musicLib = () => (Array.isArray(settings.spinMusicLib) ? settings.spinMusicLib : []).filter((p) => typeof p === 'string' && existsSync(p));
  // The same for short branded clips that open or close a look's video (stingers).
  const stingerLib = () => (Array.isArray(settings.spinStingerLib) ? settings.spinStingerLib : []).filter((p) => typeof p === 'string' && existsSync(p));
  ipcMain.handle('pb4u:spinStingerAdd', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add short clips to open or close a look', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const lib = stingerLib();
    for (const p of r.filePaths) { if (!lib.some((x) => basename(x) === basename(p))) lib.push(p); }
    settings.spinStingerLib = lib.slice(0, 30); saveSettings();
    return { list: stingerLib().map((p) => basename(p)) };
  });
  ipcMain.handle('pb4u:spinStingerRemove', (e, name) => {
    settings.spinStingerLib = stingerLib().filter((p) => basename(p) !== String(name || '')); saveSettings();
    return { list: stingerLib().map((p) => basename(p)) };
  });
  ipcMain.handle('pb4u:spinConnect', (e, test) => { try { return spinConnectInfo(!!test); } catch { return null; } });
  ipcMain.handle('pb4u:spinLookOffer', (e, offer) => spinLookOfferSet(offer));
  ipcMain.handle('pb4u:spinPicks', () => spinLookPicksTake());
  // The phone page: what the desk tells it (what to record, which choices), how each clip is doing, and what the phone asked for.
  ipcMain.handle('pb4u:spinSendSet', (e, cfg) => { try { return spinSendCfgSet(cfg); } catch { return false; } });
  ipcMain.handle('pb4u:spinClipsSet', (e, list) => { try { return spinClipsSet(list); } catch { return 0; } });
  ipcMain.handle('pb4u:spinSendTake', () => { try { return spinSendTake(); } catch { return []; } });
  ipcMain.handle('pb4u:spinArmState', () => { try { return spinArmStateNow(); } catch { return null; } });
  ipcMain.handle('pb4u:spinArmCmd', (e, cmd) => { try { return spinArmCmdPush(String(cmd || '')); } catch { return { ok: false }; } });
  ipcMain.handle('pb4u:spinStats', (e, folderKey, subfolder) => { try { return spinStatsFor(String(folderKey || ''), String(subfolder || '')); } catch { return null; } });
  const onWinSensorSample = (sample) => { broadcastWin('pb4u:sensorData', sample); };
  ipcMain.handle('pb4u:sensorProbe', async () => { try { return await probeSensor(); } catch (err) { return { ok: false, available: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('pb4u:sensorStart', async () => { try { return await startSensor(onWinSensorSample); } catch (err) { return { ok: false, available: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('pb4u:sensorStop', () => { try { return stopSensor(); } catch { return { ok: true }; } });
  ipcMain.handle('pb4u:sensorRead', () => { try { return latestSensor(); } catch { return { running: false, available: false, dps: 0, gDelta: 0 }; } });
  ipcMain.handle('pb4u:spinMusicAdd', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add music tracks for the 360 looks', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const lib = musicLib();
    for (const p of r.filePaths) { if (!lib.some((x) => basename(x) === basename(p))) lib.push(p); }
    settings.spinMusicLib = lib.slice(0, 40); saveSettings();
    return { list: musicLib().map((p) => basename(p)) };
  });
  ipcMain.handle('pb4u:spinMusicRemove', (e, name) => {
    settings.spinMusicLib = musicLib().filter((p) => basename(p) !== String(name || '')); saveSettings();
    return { list: musicLib().map((p) => basename(p)) };
  });
  ipcMain.handle('pb4u:spinMusic', async (e, clear) => {
    if (clear) { delete settings.spinMusic; saveSettings(); return { music: '' }; }
    const r = await dialog.showOpenDialog(win, { title: 'Music for the 360 videos', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.spinMusic = r.filePaths[0]; saveSettings();
    return { music: basename(settings.spinMusic) };
  });
  ipcMain.handle('pb4u:spinFxList', () => SPIN.listFx());
  ipcMain.handle('pb4u:spinOverlay', (e, bytes) => SPIN.saveOverlay(bytes));
  ipcMain.handle('pb4u:spinFxBake', (e, bytes) => SPIN.saveFxBake(bytes));
  // A preview-only H.264 copy of an inbox clip the preview cannot play (iPhone HEVC .mov). Answers its name under /send/<token>/proxy/.
  ipcMain.handle('pb4u:spinProxy', async (e, name) => {
    try {
      const d = spinDirNow(); const n = basename(String(name || ''));
      if (!d || !n || n.startsWith('.') || !existsSync(join(d, n))) return { error: 'Video not found' };
      const out = n.replace(/\.[^.]+$/, '') + '.mp4';
      await SPIN.makeProxy(join(d, n), join(d, '.proxy', out));
      return { name: out };
    } catch (err) { return { error: (err && err.message) || 'Could not make a preview' }; }
  });
  // A GIF or square clip from a finished video (written into the edited folder; the page then shares it like any clip).
  ipcMain.handle('pb4u:spinExtra', async (e, req) => {
    try {
      const kind = req && req.kind === 'square' ? 'square' : 'gif';
      const rel = String((req && req.name) || ''), n = basename(rel);
      const ed = spinEditedDir(), d = spinDirNow();
      const src = /^edited\//.test(rel) ? (ed && join(ed, n)) : (d && join(d, n));
      if (!n || n.startsWith('.') || !src || !existsSync(src) || !/\.(mp4|webm|mov|m4v)$/i.test(n)) return { error: 'Video not found' };
      const out = n.replace(/\.[^.]+$/, '') + (kind === 'gif' ? ' GIF.gif' : ' square.mp4');
      await SPIN.makeExtra(src, join(ed, out), kind);
      return { name: 'edited/' + out };
    } catch (err) { return { error: (err && err.message) || 'Could not make it' }; }
  });
  ipcMain.handle('pb4u:spinProcess', (e, req) => {
    const d = spinDirNow(); const n = basename(String((req && req.name) || ''));
    if (!d || !n || !/\.(mp4|webm|mov|m4v)$/i.test(n)) return { error: 'No video' };
    const wantMusic = String((req && req.musicName) || '');
    const music = (wantMusic && musicLib().find((p) => basename(p) === wantMusic)) || (settings.spinMusic && existsSync(settings.spinMusic) ? settings.spinMusic : null);
    const options = { ...((req && req.options) || {}) };
    if (typeof options.lutCube === 'string' && options.lutCube) {
      const savedLut = SPIN.saveLutCube(options.lutCube);
      if (savedLut) options.lutFile = savedLut;
    }
    delete options.lutCube;
    options.fxBakeDir = SPIN.fxBakePath(options.fxBake);     // only a folder this app made (by name), never a path from the page
    delete options.fxBake;
    const fx = SPIN.resolveFx((options && options.fx) || (options && options.fxId) || (req && req.fx), options.orientation);
    return SPIN.enqueue({
      inputPath: join(d, n),
      outDir: spinEditedDir(),
      label: String((req && req.label) || ''),
      overlay: SPIN.overlayPath(req && req.overlay),
      textOverlay: SPIN.overlayPath(req && req.textOverlay),
      fx,
      music,
      intro: (req && req.introName && stingerLib().find((p) => basename(p) === String(req.introName))) || null,
      outro: (req && req.outroName && stingerLib().find((p) => basename(p) === String(req.outroName))) || null,
      options
    });
  });
  ipcMain.handle('pb4u:spinJob', (e, id) => SPIN.jobInfo(id));
  ipcMain.handle('pb4u:spinCancel', (e, id) => SPIN.cancelJob(id));
  ipcMain.handle('pb4u:spinExtractFrames', async (e, req) => {
    const d = spinDirNow(); const ed = spinEditedDir();
    const n = basename(String((req && req.name) || ''));
    if (!d || !n) return { ok: false, error: 'No video name' };
    const useEdited = req && req.edited;
    const targetFile = (useEdited && existsSync(join(ed, n))) ? join(ed, n) : join(d, n);
    if (!existsSync(targetFile)) return { ok: false, error: 'Video file not found' };
    try {
      const frames = await SPIN.extractFrames({ inputPath: targetFile, times: req.times });
      return { ok: true, frames };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle('pb4u:spinDelete', (e, name) => {
    const d = spinDirNow(); const n = basename(String(name || ''));
    if (!d || !n) return { ok: false, error: 'No video name' };
    const p = join(d, n);
    if (existsSync(p)) { try { unlinkSync(p); } catch (err) { return { ok: false, error: String(err) }; } }
    const ed = join(spinEditedDir(), n);
    if (existsSync(ed)) { try { unlinkSync(ed); } catch { } }
    return { ok: true };
  });
  ipcMain.handle('pb4u:setWallCue', (e, action, text, durationMs) => {
    setWallCue(action, text, durationMs);
    return { ok: true };
  });
  // What's new, shown inside the app: the notes come from the website (online only).
  ipcMain.handle('pb4u:news', async () => {
    try { const r = await net.fetch(L.SERVER + '/api/updates', { cache: 'no-store' }); const j = await r.json(); return { ok: true, notes: j.notes || [], app: j.app || null }; }
    catch { return { ok: false, notes: [] }; }
  });
  // iPad using this laptop's camera over the booth Wi-Fi (see lib/lan.mjs)
  // Admin can turn this off per code (the licence's feat.ipadOpt === false); it is on for every other code.
  const ipadAllowed = () => { const s = L.status(); return !(s.p && s.p.feat && s.p.feat.ipadOpt === false); };
  const ipadInfo = () => { const b = shareBase(); return { allowed: ipadAllowed(), on: !!settings.ipadOn && ipadAllowed(), pin: settings.ipadPin, url: b ? b + '/ipad' : null, urlWithPin: b ? b + '/ipad/' + settings.ipadPin : null, camera: process.platform === 'win32' }; };
  ipcMain.handle('pb4u:ipadInfo', () => ipadInfo());
  ipcMain.handle('pb4u:ipadSet', (e, on, renewPin) => {
    settings.ipadOn = !!on;
    if (renewPin || !validPin(settings.ipadPin)) settings.ipadPin = newPin();
    saveSettings();
    return ipadInfo();
  });
  ipcMain.handle('pb4u:copy', (e, t) => { clipboard.writeText(String(t || '')); return true; });
  ipcMain.handle('pb4u:openUrl', (e, u) => { openOutside(String(u || '')); return true; });
  ipcMain.handle('pb4u:quit', () => { app.quit(); return true; });
  // Mac: let go of the camera macOS grabbed (its camera service, Image Capture) so the booth can use it.
  ipcMain.handle('pb4u:freeCamera', async () => { const r = await freeCamera(); guardCamera(15000); return r; });
  ipcMain.handle('pb4u:usbScan', async () => { try { return await scanUsb(); } catch { return { ok: false, mac: false, count: 0, cameras: [] }; } });
  // Updates (see lib/updater.mjs)
  ipcMain.handle('pb4u:update', () => U.info());
  ipcMain.handle('pb4u:updateCheck', () => U.check());
  ipcMain.handle('pb4u:updateDownload', () => U.download());
  ipcMain.handle('pb4u:updateOpen', () => U.openDownloaded());
  ipcMain.handle('pb4u:updateInstall', () => U.installNow());
  ipcMain.handle('pb4u:bridgeInfo', () => getBridgeInfo());
  ipcMain.handle('pb4u:bridgeRenew', () => renewBridgeToken());
  ipcMain.handle('pb4u:bridgeState', (e, state) => pushBridgeState(state));
  ipcMain.handle('pb4u:bridgeEvent', (e, ev) => sendBridgeEvent(ev));
  ipcMain.handle('pb4u:bridgeCamCmd', (e, cmd) => sendCamCommand(cmd));
  ipcMain.handle('pb4u:lanStationInfo', async (e, refresh) => {
    hotspotTouch();
    const allowed = printStationAllowed();
    let pr = [];
    if (allowed) {
      const r = await handleHelper(new Request('app://booth/helper/status' + (refresh ? '?refresh=1' : '')), '/status', new URLSearchParams(refresh ? 'refresh=1' : ''));
      const j = await r.json().catch(() => ({}));
      pr = Array.isArray(j.printers) ? j.printers : [];
    }
    return { ...getLanStationInfo(), allowed, printers: pr };
  });
  ipcMain.handle('pb4u:lanStationNewPin', () => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    const pin = rotateLanStationPin();
    return { ok: true, pin, ...getLanStationInfo() };
  });
  ipcMain.handle('pb4u:lanStationSetPrinters', (e, opts) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    const info = setStationPrinterFilter(opts || {});
    return { ok: true, ...info };
  });
  ipcMain.handle('pb4u:lanStationSetTestSizes', (e, sizes) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    const info = setStationTestSizes(sizes === undefined ? null : sizes);
    return { ok: true, ...info };
  });
  ipcMain.handle('pb4u:lanStationSetMode', (e, mode) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    const info = setStationMode(mode);
    return { ok: true, ...info };
  });
  ipcMain.handle('pb4u:lanStationJobPages', (e, id) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    return getPendingStationJobPages(id);
  });
  ipcMain.handle('pb4u:lanStationApproveJob', async (e, id, opts) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    return await approvePendingStationJob(id, opts || {});
  });
  ipcMain.handle('pb4u:lanStationDismissJob', (e, id) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    return dismissPendingStationJob(id);
  });
  ipcMain.handle('pb4u:lanStationPrintAll', async () => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    return await printAllPendingStationJobs();
  });
  ipcMain.handle('pb4u:lanStationDismissAll', () => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    return dismissAllPendingStationJobs();
  });
  ipcMain.handle('pb4u:lanStationTestPrint', async (e, printer, specOrTwoUp) => {
    if (!printStationAllowed()) return { ok: false, error: 'Print Station is not enabled on this licence.' };
    const built = buildStationTestJob(printer, specOrTwoUp);
    if (!built.ok) return { ok: false, error: built.error };
    const r = await handleHelper(new Request('app://booth/helper/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(built.printBody) }), '/print', new URLSearchParams());
    const j = await r.json().catch(() => ({ ok: false, error: 'Print error' }));
    recordStationJob({
      printer: built.printer,
      pages: 1,
      paper: built.jobLabel,
      from: 'Laptop Test',
      ok: !!j.ok,
      error: j.error || ''
    });
    return j;
  });
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (isQuitting) return;
  isQuitting = true;
  try { U.installOnQuit(); } catch { /* ignore */ }
  cleanupForExit();
});

app.whenReady().then(async () => {
  loadSettings();
  let pub = '';
  try { pub = readFileSync(join(BUILD, 'license-pubkey.txt'), 'utf8').trim(); } catch { pub = ''; }
  L.initLicence({ dataDir: dataDir(), pubKeyB64: pub, version: VERSION });
  L.touchClock();
  initServer({ buildDir: BUILD, dataDir: dataDir() });
  initSetupSync({
    dataDir: dataDir(),
    fetchFn: net.fetch.bind(net),
    onSynced: (info) => { broadcastWin('pb4u:setupSynced', info); }
  });
  try { setBoothHtml(decryptBooth()); } catch (e) { console.error('booth', e); dialog.showErrorBox('photobooth4u', 'This copy of the app is damaged. Please download it again.'); app.quit(); return; }
  initPhotos({
    root: settings.photos || join(app.getPath('pictures'), 'photobooth4u'), dataDir: dataDir(),
    makeThumb: async (f) => { const im = nativeImage.createFromPath(f); if (im.isEmpty()) return null; const s = im.getSize(); return im.resize(s.width > s.height ? { height: 360, quality: 'good' } : { width: 360, quality: 'good' }).toJPEG(72); }
  });
  setSpinDir(settings.spinDir || null);
  const userFxDir = join(dataDir(), 'spin-fx');
  // a copy in the data folder wins over the bundled one; bring its built-in loops up to date when this release has newer ones
  try { SPIN.refreshUserFx(userFxDir, [SPIN.bundledFxDir(BUILD), join(HERE, 'resources', 'spin-fx')].find((d) => d && existsSync(join(d, 'catalog.json')))); } catch (e) { console.error('spin-fx refresh', e); }
  const fxResDir = (existsSync(userFxDir) && existsSync(join(userFxDir, 'catalog.json'))) ? userFxDir : (existsSync(join(HERE, 'resources', 'spin-fx')) ? join(HERE, 'resources', 'spin-fx') : null);
  SPIN.configure({ buildDir: BUILD, temp: join(app.getPath('temp'), 'photobooth4u'), fxDir: fxResDir, resume: true });
  // Camera and printer messages also go to camera.log in the app's data folder (%APPDATA%\photobooth4u), so a camera that
  // hangs can be diagnosed afterwards. Written asynchronously so disk/AV scanning never blocks the main UI thread.
  initHelper({
    workerPath: join(BUILD, 'camera-worker.ps1'),
    deferWarm: true,
    shrinkPage: makeShrinkPage(nativeImage),
    toJpeg: makePngToJpeg(nativeImage),
    selphyJob: makeSelphyJobBuilder(nativeImage),
    dnpJob: makeDnpJobBuilder(nativeImage),
    hotFoldersFile: join(dataDir(), 'hot-folders.json'),
    pickHotFolder: async () => {
      const r = await dialog.showOpenDialog(win || undefined, {
        title: 'Choose DNP Hot Folder Print watch folder (e.g. 4x6 or 2x6)',
        properties: ['openDirectory', 'createDirectory']
      });
      return (!r.canceled && r.filePaths && r.filePaths[0]) ? r.filePaths[0] : '';
    },
    directPrintersFile: join(dataDir(), 'direct-printers.json'),
    spinInboxDir: () => spinDirNow() || '',
    logger: (m) => {
      console.log('[helper] ' + m);
      writeCamLogAsync(m);
    }
  });
  if (!validPin(settings.ipadPin)) { settings.ipadPin = newPin(); saveSettings(); }
  setLanHandler(createLanHandler({
    state: () => { const s = L.status(); return { on: !!settings.ipadOn && s.ok && !(s.p && s.p.feat && s.p.feat.ipadOpt === false), pin: settings.ipadPin }; },
    state: () => { const s = L.status(); return { on: !!settings.ipadOn && s.ok && ipadAllowed(), pin: settings.ipadPin }; },
    boothPage: ({ extraHead }) => boothPage({ deviceId: L.deviceId(), extraHead }),
    handleWeb: (webReq) => handle(webReq),
    setGuestView
  }));
  initBridge({
    getPort: sharePortNow,
    logger: (m) => console.log(m),
    onStatus: (info) => { if (win && !win.isDestroyed()) win.webContents.send('pb4u:bridgeStatus', info); },
    onAction: (act) => { if (win && !win.isDestroyed()) win.webContents.send('pb4u:bridgeAction', act); }
  });
  initLanStation({
    getPort: sharePortNow,
    isEnabled: printStationAllowed,
    pinFile: join(dataDir(), 'lan-station.json'),
    appKind: 'desktop',
    version: app.getVersion(),
    logger: (m) => console.log(m),
    onActivity: () => { hotspotTouch(); },
    getHotspotWifi: () => {
      const h = hotspotInfo();
      return (h && h.on && !h.external && h.ssid) ? { ssid: h.ssid, pass: h.pass || '' } : null;
    },
    onJob: (info) => { hotspotTouch(); broadcastWin('pb4u:lanStationJob', info); },
    makeThumb: (dataUrl) => {
      try {
        const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
        if (!m) return '';
        const im = nativeImage.createFromBuffer(Buffer.from(m[2], 'base64'));
        if (im.isEmpty()) return '';
        const s = im.getSize();
        const r = im.resize(s.width > s.height ? { height: 280, quality: 'good' } : { width: 280, quality: 'good' });
        return 'data:image/jpeg;base64,' + r.toJPEG(74).toString('base64');
      } catch { return ''; }
    },
    getPrinters: async (refresh) => {
      const r = await handleHelper(new Request('app://booth/helper/status' + (refresh ? '?refresh=1' : '')), '/status', new URLSearchParams(refresh ? 'refresh=1' : ''));
      const j = await r.json().catch(() => ({}));
      return Array.isArray(j.printers) ? j.printers : [];
    },
    getPaper: async ({ printer, widthMm, heightMm, twoUp }) => {
      const qs = new URLSearchParams({ printer: printer || '', w: String(widthMm || 0), h: String(heightMm || 0) });
      if (typeof twoUp === 'boolean') qs.set('twoUp', twoUp ? '1' : '0');
      const r = await handleHelper(new Request('app://booth/helper/paper?' + qs.toString()), '/paper', qs);
      return await r.json().catch(() => ({ ok: false }));
    },
    getCaps: async ({ printer }) => {
      const qs = new URLSearchParams({ printer: printer || '' });
      const r = await handleHelper(new Request('app://booth/helper/printer/caps?' + qs.toString()), '/printer/caps', qs);
      return await r.json().catch(() => ({ ok: false }));
    },
    printJob: async (body) => {
      const r = await handleHelper(new Request('app://booth/helper/print', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }), '/print', new URLSearchParams());
      return await r.json().catch(() => ({ ok: false, error: 'Print error' }));
    }
  });
  await startShareServer();
  const lanInfo = getLanStationInfo();
  if (lanInfo && lanInfo.port) console.log('[LAN Print Station] port ' + lanInfo.port + ' PIN: ' + lanInfo.pin);
  initHotspot({
    get: () => (settings.hotspot = settings.hotspot || {}), save: saveSettings, logger: (m) => console.log('[hotspot] ' + m),
    dir: app.getPath('userData'),   // where the "hotspot is starting" crash marker lives
    skipAuto: isOnlineMode(),
    isOffline: () => !isOnlineMode(),
    getTraffic: getHotspotTrafficState,
    // The page hears about every change (on, off, locked), so its Join QR stays right without polling.
    onChange: (i) => { invalidateLanCache(); broadcastWin('pb4u:hotspotChanged', i); }
  });
  if (settings.hotspot && settings.hotspot.ssid) setExternalWifi(settings.hotspot.ssid, settings.hotspot.pass);
  // Never sleep with the hotspot running (a common cause of Wi-Fi driver crashes on wake); it comes back after wake.
  powerMonitor.on('suspend', () => { try { hotspotSuspend(); } catch { /* ignore */ } });
  powerMonitor.on('resume', () => { try { hotspotResume(); } catch { /* ignore */ } });
  protocol.handle('app', handle);
  setupSession();
  buildMenu();
  wireIpc();
  await refreshRecord();
  createWindow();
  blocker = powerSaveBlocker.start('prevent-display-sleep');
  // Renew / pick up Admin changes in the background, and keep the clock check fresh.
  checkinNow(true).catch(() => { });                      // every start-up, when online
  U.initUpdater({
    server: L.SERVER, version: VERSION, log: (m) => console.log('[update] ' + m),
    notify: (i) => { broadcastWin('pb4u:update', i); }
  });
  clockTimer = setInterval(() => { L.touchClock(); refreshRecord().catch(() => { }); }, 5 * 60000);
  checkinTimer = setInterval(() => { checkinNow(false).catch(() => { }); syncAllNow().catch(() => { }); }, 2 * 60000);   // checks in every 10 min (see licence.mjs) & syncs setups/profiles when online
});
