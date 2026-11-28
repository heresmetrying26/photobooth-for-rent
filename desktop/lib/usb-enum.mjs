// Non-blocking off-process USB scanner for Electron (uses utilityProcess.fork -> usb-enum-child.mjs).
//
// Guarantees Electron's main UI thread never calls libusb_get_device_list() synchronously during
// background camera polling or printer discovery. Coalesces concurrent callers, caches recent scans
// briefly, kills hung utility processes after a hard timeout, and applies exponential backoff if
// a laptop's USB controller stalls.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = join(HERE, 'usb-enum-child.mjs');
const CACHE_TTL_MS = 4000;
const BASE_BACKOFF_MS = 30000;
const MAX_BACKOFF_MS = 120000;

let customRunner = null;
let electronModP = null;
let inFlight = null;
let activeChild = null;
let cache = { at: 0, readDescriptors: false, result: null };
let backoffUntil = 0;
let consecutiveTimeouts = 0;

export function setUsbEnumRunner(fn) {
  customRunner = typeof fn === 'function' ? fn : null;
  resetUsbEnumState();
}

export function resetUsbEnumState() {
  inFlight = null;
  cache = { at: 0, readDescriptors: false, result: null };
  backoffUntil = 0;
  consecutiveTimeouts = 0;
  stopUsbEnum();
}

export function canScanUsbOffProcess() {
  return Boolean(customRunner || (process.versions && process.versions.electron));
}

export function stopUsbEnum() {
  const c = activeChild;
  activeChild = null;
  if (c) {
    try { c.kill(); } catch { /* gone */ }
  }
}

async function getElectronUtilityProcess() {
  if (!electronModP) {
    electronModP = import('electron').then((m) => m.utilityProcess || (m.default && m.default.utilityProcess) || null).catch(() => null);
  }
  return electronModP;
}

async function runInUtilityProcess({ platform, readDescriptors, timeoutMs }) {
  const up = await getElectronUtilityProcess();
  if (!up || typeof up.fork !== 'function') {
    return { ok: false, unavailable: true, timedOut: false, ptp: [], printers: [] };
  }
  return await new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      resolve(res);
    };
    const ms = Math.max(500, Number(timeoutMs) || 3500);
    const timer = setTimeout(() => {
      if (child) { try { child.kill(); } catch { /* ignore */ } }
      finish({ ok: false, timedOut: true, ptp: [], printers: [] });
    }, ms);
    if (timer.unref) timer.unref();
    try {
      child = up.fork(CHILD_PATH, [], {
        env: {
          ...process.env,
          PB4U_USB_SCAN_OPTS: JSON.stringify({ platform: platform || process.platform, readDescriptors: readDescriptors !== false })
        },
        stdio: 'ignore',
        serviceName: 'photobooth4u USB scanner'
      });
      activeChild = child;
    } catch (e) {
      finish({ ok: false, timedOut: false, error: String((e && e.message) || e), ptp: [], printers: [] });
      return;
    }
    child.on('message', (msg) => {
      try { child.kill(); } catch { /* ignore */ }
      if (msg && typeof msg === 'object') {
        finish({
          ok: !!msg.ok,
          timedOut: false,
          error: msg.error || '',
          ptp: Array.isArray(msg.ptp) ? msg.ptp : [],
          printers: Array.isArray(msg.printers) ? msg.printers : []
        });
      } else {
        finish({ ok: false, timedOut: false, ptp: [], printers: [] });
      }
    });
    child.on('exit', () => {
      finish({ ok: false, timedOut: false, ptp: [], printers: [] });
    });
  });
}

/**
 * Runs a single off-process USB scan (or returns a recent cached / coalesced result).
 * Never throws; returns `{ ok, timedOut, skipped, ptp, printers }`.
 */
export async function scanUsbOffProcess({
  platform = process.platform,
  readDescriptors = true,
  timeoutMs = 3500,
  force = false,
  logger = null,
  now = () => Date.now()
} = {}) {
  const ts = now();
  if (!force && cache.result && ts - cache.at < CACHE_TTL_MS && (!readDescriptors || cache.readDescriptors)) {
    return cache.result;
  }
  if (!force && backoffUntil && ts < backoffUntil) {
    return { ok: false, timedOut: false, skipped: true, ptp: [], printers: [] };
  }
  if (inFlight) return inFlight;

  const runner = customRunner || runInUtilityProcess;
  inFlight = (async () => {
    try {
      const res = await runner({ platform, readDescriptors, timeoutMs });
      const out = {
        ok: Boolean(res && res.ok),
        timedOut: Boolean(res && res.timedOut),
        skipped: false,
        unavailable: Boolean(res && res.unavailable),
        error: (res && res.error) || '',
        ptp: Array.isArray(res && res.ptp) ? res.ptp : [],
        printers: Array.isArray(res && res.printers) ? res.printers : []
      };
      const doneAt = now();
      if (out.timedOut) {
        consecutiveTimeouts++;
        const waitMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, consecutiveTimeouts - 1));
        backoffUntil = doneAt + waitMs;
        if (typeof logger === 'function') {
          logger(`USB scan timed out after ${timeoutMs} ms (pausing background USB scans for ${Math.round(waitMs / 1000)} s so the app stays responsive).`);
        }
      } else if (out.ok) {
        consecutiveTimeouts = 0;
        backoffUntil = 0;
        cache = { at: doneAt, readDescriptors: !!readDescriptors, result: out };
      }
      return out;
    } catch (e) {
      return { ok: false, timedOut: false, skipped: false, error: String((e && e.message) || e), ptp: [], printers: [] };
    }
  })().finally(() => { inFlight = null; });

  return inFlight;
}
