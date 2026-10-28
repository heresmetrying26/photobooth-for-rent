// Keeps the app up to date.
// photobooth4u.netlify.app/api/updates says which version is out (it only changes
// after the release's installers are on GitHub). The installer always comes from
// this repo's GitHub release for that version, over HTTPS, never from anywhere else.
//   Windows: downloads the new installer in the background, then the booth asks
//            "Restart now / Later". Later = it installs when the app is closed.
//   Mac:     the booth asks "Download"; the app downloads the right .dmg into
//            Downloads and opens it, and the renter drags the app into Applications.
// Nothing happens while offline, and the app never restarts by itself.
import { app, net, shell } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'heresmetrying26/photobooth-for-rent';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
let cfg = { server: '', version: '', log: () => {}, notify: () => {} };
let st = { latest: '', notes: '', date: '', state: 'idle', progress: 0, error: '', file: '' };
let launched = false, timer = null;

const parse = (v) => String(v || '').split('.').map((n) => Number(n) || 0);
export function newer(a, b) { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; }
function assetName(v) {
  if (IS_WIN) return 'photobooth4u-' + v + '-windows-x64.exe';
  return 'photobooth4u-' + v + '-mac-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '.dmg';
}
export function assetUrl(v) { return 'https://github.com/' + REPO + '/releases/download/desktop-v' + v + '/' + assetName(v); }
function updDir() { const d = IS_MAC ? app.getPath('downloads') : join(app.getPath('userData'), 'updates'); try { mkdirSync(d, { recursive: true }); } catch { /* exists */ } return d; }
function tell() { try { cfg.notify(info()); } catch { /* window gone */ } }

export function info() {
  return { latest: st.latest, date: st.date, state: st.state, progress: st.progress, error: st.error, os: IS_WIN ? 'win' : IS_MAC ? 'mac' : 'other', current: cfg.version };
}

// A finished download really is an installer (Windows: an .exe; Mac: a disk image).
function looksOk(f) {
  try {
    const size = statSync(f).size;
    if (size < 5e6) return false;
    const fd = openSync(f, 'r');
    try {
      const b = Buffer.alloc(512);
      if (IS_WIN) { readSync(fd, b, 0, 2, 0); return b.toString('latin1', 0, 2) === 'MZ'; }
      readSync(fd, b, 0, 512, size - 512); return b.toString('latin1', 0, 4) === 'koly';
    } finally { closeSync(fd); }
  } catch { return false; }
}

export function initUpdater({ server, version, log, notify }) {
  cfg = { server, version, log: log || (() => {}), notify: notify || (() => {}) };
  // Installers of this version or older, left from earlier updates (a newer one is kept: it's reused).
  if (IS_WIN) {
    try {
      for (const f of readdirSync(updDir())) {
        const m = /^photobooth4u-(\d+\.\d+\.\d+)-/.exec(f);
        if (f.endsWith('.part') || !m || !newer(m[1], version)) { try { unlinkSync(join(updDir(), f)); } catch { /* in use */ } }
      }
    } catch { /* none */ }
  }
  setTimeout(() => check().catch(() => {}), 20000);
  // Every few minutes: a new version is offered shortly after its installers are on GitHub (one small request each time).
  timer = setInterval(() => check().catch(() => {}), 5 * 60000);
}

export async function check() {
  if (!IS_WIN && !IS_MAC) return info();
  let v = '', date = '';
  try {
    const r = await net.fetch(cfg.server + '/api/updates', { cache: 'no-store' });
    const j = await r.json();
    v = String(j && j.app && j.app.version || ''); date = String(j && j.app && j.app.date || '');
  } catch { return info(); }   // offline
  if (!/^\d+\.\d+\.\d+$/.test(v) || !newer(v, cfg.version)) return info();
  if (st.latest !== v) st = { latest: v, date, state: 'available', progress: 0, error: '', file: '' };
  // Windows downloads by itself, but only starts once per version (a failed download retries on its own timer).
  if (IS_WIN) { if (st.state === 'available') download().catch(() => {}); }
  else tell();
  return info();
}

export async function download() {
  if (!st.latest || st.state === 'downloading') return info();
  const dir = updDir(), file = join(dir, assetName(st.latest)), part = file + '.part';
  if (existsSync(file) && looksOk(file)) { st.state = 'ready'; st.file = file; st.progress = 100; tell(); return info(); }
  st.state = 'downloading'; st.progress = 0; st.error = ''; tell();
  cfg.log('Update ' + st.latest + ': downloading ' + assetName(st.latest));
  try {
    const r = await net.fetch(assetUrl(st.latest), { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error('The download isn’t ready yet (' + r.status + ').');
    const total = Number(r.headers.get('content-length')) || 0;
    let got = 0, lastTell = 0;
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        got += chunk.length;
        if (total) {
          st.progress = Math.min(99, Math.floor(got / total * 100));
          if (Date.now() - lastTell > 1000) { lastTell = Date.now(); tell(); }
        }
        callback(null, chunk);
      }
    });
    // pipeline forwards both network and disk errors into this try/catch. A raw
    // write stream can emit an unhandled 'error' and crash Electron's main process.
    await pipeline(Readable.fromWeb(r.body), progress, createWriteStream(part));
    if (total && got !== total) throw new Error('The download stopped early.');
    if (!looksOk(part)) throw new Error('The download isn’t an installer.');
    try { unlinkSync(file); } catch { /* none */ }
    renameSync(part, file);
    st.state = 'ready'; st.file = file; st.progress = 100;
    cfg.log('Update ' + st.latest + ': downloaded');
    tell();
    if (IS_MAC) {
      const openError = await shell.openPath(file);
      if (openError) { st.error = openError; cfg.log('Update ' + st.latest + ': downloaded, but could not open installer: ' + openError); tell(); }
    }
  } catch (e) {
    try { unlinkSync(part); } catch { /* none */ }
    st.state = 'error'; st.error = String(e && e.message || e);
    cfg.log('Update ' + st.latest + ' failed: ' + st.error);
    tell();
    // Try again later (Windows downloads by itself; on a Mac the renter taps Download again).
    if (IS_WIN) setTimeout(() => { if (st.state === 'error') { st.state = 'available'; download().catch(() => {}); } }, 30 * 60000);
  }
  return info();
}

// Mac: open the downloaded disk image again.
export function openDownloaded() { if (st.file && existsSync(st.file)) { shell.openPath(st.file); return true; } return false; }

// Windows: run the installer silently and close the app. It asks once for
// permission (the app is installed for all users), then reopens the app.
function runInstaller(reopen) {
  if (!IS_WIN || launched || st.state !== 'ready' || !st.file || !existsSync(st.file)) return false;
  launched = true;
  const args = ['/S', '--updated', ...(reopen ? ['--force-run'] : [])];
  cfg.log('Update ' + st.latest + ': installing');
  const viaElevate = () => {
    const el = join(process.resourcesPath || '', 'elevate.exe');
    if (existsSync(el)) { const c = spawn(el, [st.file, ...args], { detached: true, stdio: 'ignore', windowsHide: true }); c.on('error', (e) => cfg.log('elevate: ' + e.message)); c.unref(); return; }
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const c = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process -FilePath ' + q(st.file) + ' -ArgumentList ' + args.map(q).join(',') + ' -Verb RunAs'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', (e) => cfg.log('install: ' + e.message));
    c.unref();
  };
  try {
    const p = spawn(st.file, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => viaElevate());
    p.unref();
  } catch { viaElevate(); }
  return true;
}
export function installNow() {
  if (!runInstaller(true)) return false;
  setTimeout(() => app.quit(), 600);
  return true;
}
// Called when the app closes: a downloaded update installs then (no reopening).
export function installOnQuit() {
  if (timer) clearInterval(timer);
  return runInstaller(false);
}
