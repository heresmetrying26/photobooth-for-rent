// macOS grabs every USB camera the moment it is plugged in: its camera service (ptpcamerad), and
// Image Capture / Photos through it, hold the camera, so the booth's own USB connection is refused
// ("Another app is using the camera"). The booth asks the app to let go before it connects.
// Mac only; on other systems every call does nothing.
import { execFile } from 'node:child_process';

const DAEMONS = ['ptpcamerad', 'PTPCamera'];   // macOS camera services (launchd restarts them when a camera appears)
const APPS = ['Image Capture'];                // opens by itself when a camera is plugged in; asked to quit

let timer = null, until = 0;

// killall exit 0 = stopped something; 1 = nothing of that name was running (fine);
// "Operation not permitted" = it is running but we may not stop it.
function killall(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000 }, (err, stdout, stderr) => {
      const text = String(stderr || '') + String(stdout || '');
      resolve({ stopped: !err, denied: /not permitted|permission denied/i.test(text) });
    });
  });
}

const WIN_APPS = ['Insta360 Studio.exe', 'Insta360LinkController.exe', 'WindowsCamera.exe', 'LogiCapture.exe'];

function runOut(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeout || 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

// Windows keeps, for every app that has used the camera, when it started and stopped (Settings > Privacy > Camera shows the same).
// An app with a start time and a stop time of 0 is using the camera right now. This names it, so the booth can say
// "close X" instead of "the camera is busy in another app". An entry left over from an app that crashed is dropped by
// checking that the app is still running.
// opts (for tests): { regOut: text of `reg query ... /s`, running: async (exeName) => boolean, selfPath }
export async function cameraHolders(opts = {}) {
  if ((opts.platform || process.platform) !== 'win32') return [];
  const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';
  const text = opts.regOut != null ? String(opts.regOut) : await runOut('reg.exe', ['query', root, '/s'], 6000);
  const self = String(opts.selfPath || process.execPath || '').toLowerCase();
  const found = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const head = lines.find((l) => /^HKEY_/i.test(l));
    if (!head) continue;
    const start = /LastUsedTimeStart\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(block), stop = /LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(block);
    if (!start || !stop) continue;
    if (BigInt(start[1]) === 0n || BigInt(stop[1]) !== 0n) continue;                      // never used, or finished
    const raw = head.split('\\').pop().replace(/#/g, '\\');                                // C:#Program Files#OBS#obs64.exe -> C:\Program Files\OBS\obs64.exe
    const isExe = /\.exe$/i.test(raw);
    if (isExe && raw.toLowerCase() === self) continue;                                    // this booth itself
    found.push({ path: raw, name: isExe ? raw.split('\\').pop().replace(/\.exe$/i, '') : raw.split('_')[0].replace(/^[^.]+\./, '') || raw, exe: isExe ? raw.split('\\').pop() : '' });
  }
  const running = opts.running || (async (exe) => /\.exe/i.test(await runOut('tasklist.exe', ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq ' + exe], 4000)));
  const out = [];
  for (const h of found.slice(0, 12)) {
    if (h.exe && !(await running(h.exe))) continue;                                       // stale entry: the app is gone
    out.push({ name: h.name, path: h.path });
  }
  return out;
}

// opts (for tests): { platform, killall }
export async function freeCamera(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    const stopped = [];
    for (const app of WIN_APPS) {
      const r = await killall('taskkill.exe', ['/F', '/IM', app]);
      if (r.stopped) stopped.push(app);
    }
    if (stopped.length && !opts.quiet) console.log('[camera] Freed the camera: stopped ' + stopped.join(', '));
    let holders = [];
    try { holders = (await cameraHolders(opts)).map((h) => h.name); } catch { /* the list is only a hint */ }
    if (holders.length && !opts.quiet) console.log('[camera] Windows says the camera is in use by: ' + holders.join(', '));
    return { ok: true, mac: false, win: true, stopped, denied: [], holders };
  }
  const bin = opts.killall || '/usr/bin/killall';
  if (platform !== 'darwin') return { ok: true, mac: false, stopped: [], denied: [] };
  const stopped = [], denied = [];
  for (const d of DAEMONS) {
    const r = await killall(bin, ['-9', d]);
    if (r.stopped) stopped.push(d);
    if (r.denied) denied.push(d);
  }
  if (opts.apps !== false) {
    for (const a of APPS) {
      const r = await killall(bin, [a]);
      if (r.stopped) stopped.push(a);
    }
  }
  if (stopped.length && !opts.quiet) console.log('[camera] Freed the camera: stopped ' + stopped.join(', '));
  if (denied.length && !opts.quiet) console.log('[camera] macOS did not allow stopping ' + denied.join(', '));
  return { ok: denied.length === 0, mac: true, stopped, denied };
}

// For a while after a camera appears or the booth connects, keep stopping the camera
// service, because macOS starts it again the moment it sees the camera.
export function guardCamera(ms, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin') return;
  until = Math.max(until, Date.now() + (ms || 10000));
  if (timer) return;
  timer = setInterval(() => {
    if (Date.now() > until) { clearInterval(timer); timer = null; return; }
    freeCamera({ ...opts, apps: false, quiet: true }).catch(() => {});
  }, opts.every || 400);
  if (timer.unref) timer.unref();
}

export function stopGuardCamera() {
  if (timer) { clearInterval(timer); timer = null; }
  until = 0;
}
