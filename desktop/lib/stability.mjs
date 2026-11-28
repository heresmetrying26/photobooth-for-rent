// Graphics stability, GPU cache recovery and "Not Responding" self-healing for the Desktop app.
//
// Why this exists:
//   On Windows laptops with Intel UHD / Iris Xe or AMD Radeon integrated graphics (e.g. ASUS VivoBook),
//   Chromium's Skia Graphite / Dawn backend or forced GPU rasterization can deadlock the GPU process or
//   compositor, leaving Windows showing "photobooth4u (Not Responding)" without emitting a clean GPU crash.
//   If the operator closes the frozen window via Task Manager, crash-only counters stay at 0 and every next
//   launch hangs the same way.
//
// How this protects the laptop:
//   1. Windows startup flags disable SkiaGraphite (staying on proven Ganesh + ANGLE D3D11) and never force
//      enable-gpu-rasterization over Chromium's driver allowlist.
//   2. A startup-probe marker file detects repeated interrupted/hung starts before the window became ready.
//   3. Sustained "unresponsive" window events or repeated GPU crashes record safeAt + clearCache in
//      graphics.json, clear corrupted GPU/Dawn shader caches before Chromium opens them on the next run,
//      and switch automatically to Safe Graphics (hardware acceleration off) for 30 days.
//   4. Operators can also toggle Safe Graphics manually in Setup -> licence & diagnostics, or pass
//      --safe-graphics / --disable-gpu on the command line.
import { readFileSync, writeFileSync, rmSync, existsSync, openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SAFE_GFX_DAYS = 30;
export const CRASH_WINDOW_MS = 7 * DAY_MS;
export const STARTUP_HANG_WINDOW_MS = DAY_MS;
export const AUTO_RELAUNCH_COOLDOWN_MS = 5 * 60 * 1000;
export const GPU_CACHE_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache'];

const gfxPath = (dataDir) => join(dataDir, 'graphics.json');
const probePath = (dataDir) => join(dataDir, 'startup-probe');

function cleanTsList(arr, now, windowMs) {
  return (Array.isArray(arr) ? arr : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > 0 && now - t >= 0 && now - t < windowMs);
}

export function readGraphicsState(dataDir) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(gfxPath(dataDir), 'utf8')) || {}; } catch { raw = {}; }
  return {
    crashes: Array.isArray(raw.crashes) ? raw.crashes : [],
    hangs: Array.isArray(raw.hangs) ? raw.hangs : [],
    startupHangs: Array.isArray(raw.startupHangs) ? raw.startupHangs : [],
    safeAt: Number(raw.safeAt) || 0,
    manualSafe: typeof raw.manualSafe === 'boolean' ? raw.manualSafe : null,
    clearCache: !!raw.clearCache,
    lastAutoRelaunchAt: Number(raw.lastAutoRelaunchAt) || 0,
    lastReason: typeof raw.lastReason === 'string' ? raw.lastReason : ''
  };
}

export function writeGraphicsState(dataDir, state) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(gfxPath(dataDir), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearGpuCaches(dataDir) {
  const removed = [];
  if (!dataDir) return removed;
  for (const name of GPU_CACHE_DIRS) {
    const dir = join(dataDir, name);
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch { /* best effort: locked cache will be overwritten next time */ }
  }
  return removed;
}

/**
 * Evaluates whether this launch should run in Safe Graphics mode (hardware acceleration off).
 * Must be called BEFORE app.whenReady() and before Chromium creates any GPU/shader cache files.
 */
export function evaluateGraphicsMode({ dataDir, argv = [], now = Date.now() }) {
  const args = Array.isArray(argv) ? argv : [];
  const cliSafe = args.some((a) => a === '--safe-graphics' || a === '--disable-gpu');
  const st = readGraphicsState(dataDir);
  let dirty = false;

  // Check if the previous accelerated launch never reached a responsive ready window (e.g. hung at startup & force-closed).
  const pFile = probePath(dataDir);
  let sawStartupHang = false;
  if (existsSync(pFile)) {
    sawStartupHang = true;
    try { rmSync(pFile, { force: true }); } catch { /* ignore */ }
    st.startupHangs = cleanTsList(st.startupHangs, now, STARTUP_HANG_WINDOW_MS).concat(now);
    st.crashes = cleanTsList(st.crashes, now, CRASH_WINDOW_MS);
    st.hangs = cleanTsList(st.hangs, now, CRASH_WINDOW_MS);
    st.clearCache = true;
    if (st.manualSafe !== false && (st.startupHangs.length >= 2 || st.crashes.length >= 1 || st.hangs.length >= 1)) {
      st.safeAt = now;
      st.lastReason = 'startup-hang';
      st.startupHangs = [];
      st.crashes = [];
    }
    dirty = true;
  }

  let safe = false;
  let reason = 'normal';
  if (cliSafe) {
    safe = true;
    reason = 'cli';
  } else if (st.manualSafe === true) {
    safe = true;
    reason = 'manual';
  } else if (st.manualSafe === false) {
    safe = false;
    reason = 'manual-off';
  } else if (st.safeAt && now - st.safeAt < SAFE_GFX_DAYS * DAY_MS) {
    safe = true;
    reason = st.lastReason || 'auto';
  }

  let clearedCaches = [];
  if (st.clearCache) {
    clearedCaches = clearGpuCaches(dataDir);
    st.clearCache = false;
    dirty = true;
  }

  if (dirty) writeGraphicsState(dataDir, st);

  return {
    safe,
    reason,
    sawStartupHang,
    clearedCaches,
    manualSafe: st.manualSafe,
    safeAt: st.safeAt,
    state: st
  };
}

/**
 * Computes Chromium command-line switches for the given OS and graphics mode.
 * Pure function so unit tests can assert exact flags across Windows and macOS.
 */
export function buildChromiumSwitches({ platform = process.platform, safe = false } = {}) {
  const isWin = platform === 'win32';
  const switches = [['force-color-profile', 'srgb']];
  if (safe) {
    switches.push([
      'disable-features',
      isWin ? 'CalculateNativeWinOcclusion,MediaFoundationVideoCapture,SkiaGraphite' : 'CalculateNativeWinOcclusion'
    ]);
    return { disableHardwareAcceleration: true, switches };
  }
  if (isWin) {
    // Keep DirectShow (MediaFoundationVideoCapture off for USB webcams/ASUS Frame Server),
    // disable SkiaGraphite (Dawn/Graphite hangs Intel UHD/Iris Xe & AMD Radeon on Windows 11),
    // stay on battle-tested Ganesh + ANGLE D3D11, and do NOT force enable-gpu-rasterization.
    switches.push(['use-angle', 'd3d11']);
    switches.push(['disable-features', 'CalculateNativeWinOcclusion,MediaFoundationVideoCapture,SkiaGraphite']);
  } else {
    switches.push(['disable-features', 'CalculateNativeWinOcclusion,MediaFoundationVideoCapture']);
  }
  return { disableHardwareAcceleration: false, switches };
}

/** Marks the start of an accelerated window launch; cleared once the window loads & responds. */
export function markStartupBegin(dataDir) {
  if (!dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const fd = openSync(probePath(dataDir), 'w');
    writeSync(fd, String(Date.now()));
    fsyncSync(fd);
    closeSync(fd);
  } catch { /* ignore */ }
}

/** Clears the startup marker after the window finishes loading and proves responsive (or on normal quit). */
export function markStartupReady(dataDir) {
  if (!dataDir) return;
  try { rmSync(probePath(dataDir), { force: true }); } catch { /* ignore */ }
}

/** Records a GPU child-process crash; activates Safe Graphics on 2nd crash in 7 days (or 1st after a hang). */
export function recordGpuCrash({ dataDir, reason = '', safe = false, now = Date.now() }) {
  const st = readGraphicsState(dataDir);
  st.clearCache = true;
  if (safe || st.manualSafe === false) {
    writeGraphicsState(dataDir, st);
    return { switchedToSafe: false, count: st.crashes.length, state: st };
  }
  st.crashes = cleanTsList(st.crashes, now, CRASH_WINDOW_MS).concat(now);
  st.hangs = cleanTsList(st.hangs, now, CRASH_WINDOW_MS);
  st.startupHangs = cleanTsList(st.startupHangs, now, STARTUP_HANG_WINDOW_MS);
  let switchedToSafe = false;
  if (st.crashes.length >= 2 || st.hangs.length >= 1 || st.startupHangs.length >= 1) {
    st.safeAt = now;
    st.lastReason = 'gpu-crash' + (reason ? ':' + String(reason).slice(0, 32) : '');
    st.crashes = [];
    switchedToSafe = true;
  }
  writeGraphicsState(dataDir, st);
  return { switchedToSafe, count: st.crashes.length, state: st };
}

/**
 * Records a sustained BrowserWindow "unresponsive" freeze ("Not Responding").
 * When hardware acceleration was active, switches to Safe Graphics immediately so the laptop
 * heals itself instead of hanging on every subsequent launch.
 */
export function recordUnresponsive({ dataDir, safe = false, now = Date.now() }) {
  const st = readGraphicsState(dataDir);
  st.clearCache = true;
  st.hangs = cleanTsList(st.hangs, now, CRASH_WINDOW_MS).concat(now);
  let switchedToSafe = false;
  if (!safe && st.manualSafe !== false) {
    st.safeAt = now;
    st.lastReason = 'unresponsive';
    switchedToSafe = true;
  }
  const canAutoRelaunch = switchedToSafe && (!st.lastAutoRelaunchAt || now - st.lastAutoRelaunchAt >= AUTO_RELAUNCH_COOLDOWN_MS);
  writeGraphicsState(dataDir, st);
  return { switchedToSafe, canAutoRelaunch, state: st };
}

export function markAutoRelaunch({ dataDir, now = Date.now() }) {
  const st = readGraphicsState(dataDir);
  st.lastAutoRelaunchAt = now;
  writeGraphicsState(dataDir, st);
}

/** Manual operator override from Setup -> licence & diagnostics: mode = 'on' | 'off' | 'auto'. */
export function setManualSafeGraphics({ dataDir, mode = 'auto' }) {
  const st = readGraphicsState(dataDir);
  st.clearCache = true;
  if (mode === 'on') {
    st.manualSafe = true;
    st.lastReason = 'manual';
  } else if (mode === 'off') {
    st.manualSafe = false;
    st.safeAt = 0;
    st.crashes = [];
    st.hangs = [];
    st.startupHangs = [];
    st.lastReason = '';
  } else {
    st.manualSafe = null;
    st.safeAt = 0;
    st.crashes = [];
    st.hangs = [];
    st.startupHangs = [];
    st.lastReason = '';
  }
  writeGraphicsState(dataDir, st);
  return {
    manualSafe: st.manualSafe,
    safeNextLaunch: st.manualSafe === true,
    mode: st.manualSafe === true ? 'on' : st.manualSafe === false ? 'off' : 'auto'
  };
}

/** Plain summary for the booth's Diagnostics drawer. */
export function graphicsStatusSummary({ dataDir, activeSafe, activeReason }) {
  const st = readGraphicsState(dataDir);
  const mode = st.manualSafe === true ? 'on' : st.manualSafe === false ? 'off' : 'auto';
  return {
    safe: !!activeSafe,
    reason: String(activeReason || 'normal'),
    mode,
    manualSafe: st.manualSafe,
    safeAt: st.safeAt || 0,
    lastReason: st.lastReason || ''
  };
}
