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

// opts (for tests): { platform, killall }
export async function freeCamera(opts = {}) {
  const platform = opts.platform || process.platform;
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
