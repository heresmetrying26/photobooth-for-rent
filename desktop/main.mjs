// photobooth4u for Windows and Mac (offline).
//
// The booth itself is the same page as photobooth4u.netlify.app (protected/booth.html),
// served from inside the app at app://booth/ together with the web app's own
// server code (setup, vouchers, print counts) running on this laptop. Photos are
// saved in Pictures/photobooth4u and guests get them by QR over the booth Wi-Fi.
// The internet is only needed to activate (or paste an offline key) and, for a
// lifetime code, once every few weeks to renew the licence.
import { app, BrowserWindow, protocol, session, ipcMain, shell, dialog, Menu, net, nativeImage, powerSaveBlocker, screen, clipboard } from 'electron';
import { readFileSync, existsSync, statSync, createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import * as L from './lib/licence.mjs';
import { initServer, setBoothHtml, syncRecord, handleApi, boothPage } from './lib/server.mjs';
import { initPhotos, driveRequest, startShareServer, stopShareServer, shareBase, lanAddress, sharePortNow, photosRoot, setPhotosRoot, folderPathOf } from './lib/photos.mjs';
import { initHelper, handleHelper, stopHelper } from './lib/helper.mjs';
import { freeCamera, guardCamera } from './lib/camfree.mjs';
import * as U from './lib/updater.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build');
const PAGES = join(HERE, 'pages');
const ORIGIN = 'app://booth';
const VERSION = app.getVersion();
const KEY_A = 'pb4u·desk·7f3c1e9a';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true, allowServiceWorkers: false }
}]);

let win = null, blocker = null, settings = {};
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
async function refreshRecord() {
  const s = L.status();
  if (s.p) await syncRecord(s.p, L.deviceId(), s.ok);
  return s;
}
async function checkinNow(force) {
  const r = await L.checkin(net.fetch.bind(net), force);
  if (r === 'ok' || r === 'revoked') await refreshRecord();
  if (r === 'revoked' && win && !win.isDestroyed()) win.webContents.send('pb4u:licence', L.info());
  return r;
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.tflite': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain' };
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
  const d = { v: VERSION, os: L.osKey(), server: L.SERVER };
  return '<script>window.__PB=window.__PB||{};window.__PB.desktop=' + JSON.stringify(d).replace(/</g, '\\u003c') + ';' +
    // Everything the booth needs is on this laptop, so "offline" never blocks saving.
    'try{Object.defineProperty(Navigator.prototype,"onLine",{get:function(){return true;},configurable:true});}catch(e){}' +
    'try{sessionStorage.removeItem("pb_open_tries");}catch(e){}</script>';
}

async function serveRoot() {
  const s = await refreshRecord();
  if (!s.ok) return fileResponse(PAGES, 'activate.html', ISOLATE);
  const r = await boothPage({ deviceId: L.deviceId(), extraHead: desktopHead() });
  if (r.locked) return fileResponse(PAGES, 'activate.html', ISOLATE);
  return htmlRes(r.html);
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
      return await handleApi(req, p);
    }
    if (p === '/local/drive' && req.method === 'POST') {
      if (!L.status().ok) return jsonRes({ ok: false, error: 'This laptop’s licence isn’t active.' }, 401);
      const body = JSON.parse(await req.text());
      return jsonRes(await driveRequest(body));
    }
    if (p.startsWith('/helper/') || p === '/helper') return await handleHelper(req, p.slice(7) || '/', url.searchParams);
    if (LOCAL_STATIC.some((x) => p.startsWith(x))) return fileResponse(join(BUILD, 'public'), p.slice(1));
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
    if (url.protocol === 'app:') { shell.openExternal(L.SERVER + url.pathname + url.search + url.hash); return; }
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') shell.openExternal(url.href);
  } catch { /* ignore */ }
}
// (new URL('app://booth/').origin is "null" for custom schemes, so compare protocol + host.)
const isOurs = (u) => { try { const x = new URL(u); return x.protocol === 'app:' && x.host === 'booth'; } catch { return false; } };
const isLocalPage = (u) => { try { const x = new URL(u); return isOurs(u) && (x.pathname === '/' || x.pathname.startsWith('/pay/') || x.pathname.startsWith('/app/') || x.pathname === '/activate'); } catch { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#F5F1EA',
    title: 'photobooth4u', icon: existsSync(join(HERE, 'resources', 'icon.png')) ? join(HERE, 'resources', 'icon.png') : undefined,
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  wireContents(win.webContents);
  win.loadURL(ORIGIN + '/');
  win.on('closed', () => { win = null; });
}

function wireContents(wc) {
  wc.on('will-navigate', (e, u) => { if (!isLocalPage(u)) { e.preventDefault(); openOutside(u); } });
  wc.setWindowOpenHandler(({ url, frameName }) => {
    // The guest screen (opened empty, then filled by the booth) and printable voucher tickets.
    if (!url || url === 'about:blank' || frameName === 'pb4uGuest') {
      const other = screen.getAllDisplays().find((d) => d.id !== screen.getDisplayMatching(win.getBounds()).id);
      const b = other ? other.workArea : null;
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#000000', title: 'photobooth4u – guest screen', ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : {}), webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } } };
    }
    if (isLocalPage(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 900, height: 1000 } };
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
  ses.setDevicePermissionHandler((d) => (d.deviceType === 'usb' || d.deviceType === 'hid') && (!d.origin || isOurs(d.origin) || d.origin === 'null'));
  ses.setUSBProtectedClassesHandler(() => []);
  // Chrome would show a USB picker; the booth camera is the device we want.
  ses.on('select-usb-device', (event, details, cb) => {
    event.preventDefault();
    guardCamera(10000);   // Mac: stop macOS holding the camera while the booth connects
    const list = details.deviceList || [];
    const cam = list.find((d) => /nikon|canon|sony|fuji|olympus|panasonic|camera|eos|pentax|leica|ricoh/i.test((d.manufacturerName || '') + ' ' + (d.productName || ''))) || list[0];
    cb(cam ? cam.deviceId : '');
  });
  // Block anything leaving the laptop from the booth page except our own server.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
    const fromBooth = d.webContents && !d.webContents.isDestroyed() && ours(d.webContents.getURL());
    if (!fromBooth) return cb({});
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(d.url)) return cb({});
    if (/^http:\/\/(127\.0\.0\.1|localhost):17321\//.test(d.url)) return cb({});
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

// ---------- IPC (preload.cjs) ----------
function wireIpc() {
  ipcMain.on('pb4u:lan', (e) => { e.returnValue = shareBase(); });
  ipcMain.handle('pb4u:info', async () => ({
    licence: L.info(), version: VERSION, update: U.info(), photos: photosRoot(), share: shareBase(), lanIp: lanAddress(), port: sharePortNow(), server: L.SERVER
  }));
  ipcMain.handle('pb4u:activate', async (e, code) => {
    const r = await L.activate(net.fetch.bind(net), code);
    if (r.ok) await refreshRecord();
    return r;
  });
  ipcMain.handle('pb4u:activateOffline', async (e, text) => {
    const r = L.activateOffline(text);
    if (r.ok) await refreshRecord();
    return r;
  });
  ipcMain.handle('pb4u:checkin', async () => { const r = await checkinNow(true); return { result: r, licence: L.info() }; });
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
  ipcMain.handle('pb4u:copy', (e, t) => { clipboard.writeText(String(t || '')); return true; });
  ipcMain.handle('pb4u:openUrl', (e, u) => { openOutside(String(u || '')); return true; });
  ipcMain.handle('pb4u:quit', () => { app.quit(); return true; });
  // Mac: let go of the camera macOS grabbed (its camera service, Image Capture) so the booth can use it.
  ipcMain.handle('pb4u:freeCamera', async () => { const r = await freeCamera(); guardCamera(15000); return r; });
  // Updates (see lib/updater.mjs)
  ipcMain.handle('pb4u:update', () => U.info());
  ipcMain.handle('pb4u:updateCheck', () => U.check());
  ipcMain.handle('pb4u:updateDownload', () => U.download());
  ipcMain.handle('pb4u:updateOpen', () => U.openDownloaded());
  ipcMain.handle('pb4u:updateInstall', () => U.installNow());
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { U.installOnQuit(); } catch { /* ignore */ } stopHelper(); stopShareServer(); try { L.touchClock(); } catch { /* ignore */ } });

app.whenReady().then(async () => {
  loadSettings();
  let pub = '';
  try { pub = readFileSync(join(BUILD, 'license-pubkey.txt'), 'utf8').trim(); } catch { pub = ''; }
  L.initLicence({ dataDir: dataDir(), pubKeyB64: pub, version: VERSION });
  L.touchClock();
  initServer({ buildDir: BUILD, dataDir: dataDir() });
  try { setBoothHtml(decryptBooth()); } catch (e) { console.error('booth', e); dialog.showErrorBox('photobooth4u', 'This copy of the app is damaged. Please download it again.'); app.quit(); return; }
  initPhotos({
    root: settings.photos || join(app.getPath('pictures'), 'photobooth4u'), dataDir: dataDir(),
    makeThumb: async (f) => { const im = nativeImage.createFromPath(f); if (im.isEmpty()) return null; const s = im.getSize(); return im.resize(s.width > s.height ? { height: 360, quality: 'good' } : { width: 360, quality: 'good' }).toJPEG(72); }
  });
  initHelper({ workerPath: join(BUILD, 'camera-worker.ps1') });
  await startShareServer();
  protocol.handle('app', handle);
  setupSession();
  buildMenu();
  wireIpc();
  await refreshRecord();
  createWindow();
  blocker = powerSaveBlocker.start('prevent-display-sleep');
  // Renew / pick up Admin changes in the background, and keep the clock check fresh.
  checkinNow(true).catch(() => {});                      // every start-up, when online
  U.initUpdater({ server: L.SERVER, version: VERSION, log: (m) => console.log('[update] ' + m),
    notify: (i) => { if (win && !win.isDestroyed()) win.webContents.send('pb4u:update', i); } });
  setInterval(() => { L.touchClock(); refreshRecord().catch(() => {}); }, 5 * 60000);
  setInterval(() => { checkinNow(false).catch(() => {}); }, 2 * 60000);   // checks in every 10 min (see licence.mjs)
});
