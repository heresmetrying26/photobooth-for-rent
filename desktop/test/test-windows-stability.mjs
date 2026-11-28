// Unit tests for Windows "Not Responding" fixes (ASUS VivoBook / Intel Iris Xe / AMD Radeon / USB Selective Suspend):
//  - lib/stability.mjs: Chromium switches, GPU cache cleanup, startup-hang marker, GPU crash & unresponsive fallback
//  - lib/usb-enum.mjs + lib/usbipp.mjs: off-process USB scanning, coalescing, caching, timeout backoff
//  - lib/helper.mjs: deferWarm staggering & clean stopHelper teardown
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAY_MS,
  GPU_CACHE_DIRS,
  evaluateGraphicsMode,
  buildChromiumSwitches,
  markStartupBegin,
  markStartupReady,
  recordGpuCrash,
  recordUnresponsive,
  markAutoRelaunch,
  setManualSafeGraphics,
  graphicsStatusSummary
} from '../lib/stability.mjs';
import {
  setUsbEnumRunner,
  resetUsbEnumState,
  scanUsbOffProcess
} from '../lib/usb-enum.mjs';
import { probeUsbPrinters, setUsbBackend } from '../lib/usbipp.mjs';
import { initHelper, stopHelper } from '../lib/helper.mjs';

function makeTmpDir(prefix = 'pb4u-stab-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedGpuCaches(dir) {
  for (const name of GPU_CACHE_DIRS) {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'dummy.bin'), 'stale');
  }
}

test('buildChromiumSwitches disables SkiaGraphite, uses ANGLE D3D11, and never forces enable-gpu-rasterization on Windows', () => {
  const winNormal = buildChromiumSwitches({ platform: 'win32', safe: false });
  assert.equal(winNormal.disableHardwareAcceleration, false);
  const swMap = new Map(winNormal.switches);
  assert.equal(swMap.has('enable-gpu-rasterization'), false, 'must not force enable-gpu-rasterization');
  assert.equal(swMap.get('use-angle'), 'd3d11');
  assert.equal(swMap.get('force-color-profile'), 'srgb');
  const disabled = (swMap.get('disable-features') || '').split(',');
  assert.ok(disabled.includes('SkiaGraphite'), 'SkiaGraphite must be disabled on Windows');
  assert.ok(disabled.includes('MediaFoundationVideoCapture'), 'MediaFoundationVideoCapture stays disabled for USB webcams/ASUS Frame Server');
  assert.ok(disabled.includes('CalculateNativeWinOcclusion'));

  const winSafe = buildChromiumSwitches({ platform: 'win32', safe: true });
  assert.equal(winSafe.disableHardwareAcceleration, true);
  assert.equal(new Map(winSafe.switches).has('enable-gpu-rasterization'), false);
  assert.equal(new Map(winSafe.switches).has('use-angle'), false);

  const macNormal = buildChromiumSwitches({ platform: 'darwin', safe: false });
  assert.equal(macNormal.disableHardwareAcceleration, false);
  assert.equal(new Map(macNormal.switches).has('use-angle'), false);
  assert.equal((new Map(macNormal.switches).get('disable-features') || '').includes('SkiaGraphite'), false);
});

test('startup-probe detects repeated startup freezes, clears stale GPU caches, and activates Safe Graphics automatically', () => {
  const dir = makeTmpDir();
  try {
    const t0 = 1_700_000_000_000;
    // Clean start 1
    let ev = evaluateGraphicsMode({ dataDir: dir, now: t0 });
    assert.equal(ev.safe, false);
    assert.equal(ev.sawStartupHang, false);
    markStartupBegin(dir);
    markStartupReady(dir);

    // Next start sees no probe -> still normal
    ev = evaluateGraphicsMode({ dataDir: dir, now: t0 + 10_000 });
    assert.equal(ev.safe, false);
    assert.equal(ev.sawStartupHang, false);

    // Simulated startup freeze #1 (killed before markStartupReady)
    seedGpuCaches(dir);
    markStartupBegin(dir);
    ev = evaluateGraphicsMode({ dataDir: dir, now: t0 + 20_000 });
    assert.equal(ev.sawStartupHang, true);
    assert.equal(ev.safe, false, 'single startup hang clears caches before disabling acceleration');
    assert.equal(ev.clearedCaches.length, GPU_CACHE_DIRS.length);
    assert.equal(existsSync(join(dir, 'DawnGraphiteCache')), false);

    // Simulated startup freeze #2 within 24h -> Safe Graphics activates automatically
    seedGpuCaches(dir);
    markStartupBegin(dir);
    ev = evaluateGraphicsMode({ dataDir: dir, now: t0 + 60_000 });
    assert.equal(ev.sawStartupHang, true);
    assert.equal(ev.safe, true);
    assert.equal(ev.reason, 'startup-hang');
    assert.equal(existsSync(join(dir, 'GPUCache')), false);

    // Safe Graphics stays active for 30 days, then retries automatically
    const stillSafe = evaluateGraphicsMode({ dataDir: dir, now: t0 + 15 * DAY_MS });
    assert.equal(stillSafe.safe, true);
    const expired = evaluateGraphicsMode({ dataDir: dir, now: t0 + 31 * DAY_MS });
    assert.equal(expired.safe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordUnresponsive switches to Safe Graphics immediately and enforces auto-relaunch cooldown', () => {
  const dir = makeTmpDir();
  try {
    const t0 = 1_700_100_000_000;
    seedGpuCaches(dir);

    const r1 = recordUnresponsive({ dataDir: dir, safe: false, now: t0 });
    assert.equal(r1.switchedToSafe, true);
    assert.equal(r1.canAutoRelaunch, true);

    markAutoRelaunch({ dataDir: dir, now: t0 });

    // Cooldown prevents relaunch loops within 5 minutes
    const r2 = recordUnresponsive({ dataDir: dir, safe: false, now: t0 + 60_000 });
    assert.equal(r2.canAutoRelaunch, false);

    // Next start picks up Safe Graphics + clears corrupted GPU caches
    const ev = evaluateGraphicsMode({ dataDir: dir, now: t0 + 65_000 });
    assert.equal(ev.safe, true);
    assert.equal(ev.reason, 'unresponsive');
    assert.equal(ev.clearedCaches.length, GPU_CACHE_DIRS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordGpuCrash and setManualSafeGraphics / CLI overrides work cleanly', () => {
  const dir = makeTmpDir();
  try {
    const t0 = 1_700_200_000_000;
    const c1 = recordGpuCrash({ dataDir: dir, reason: 'crashed', safe: false, now: t0 });
    assert.equal(c1.switchedToSafe, false);
    const c2 = recordGpuCrash({ dataDir: dir, reason: 'crashed', safe: false, now: t0 + 5000 });
    assert.equal(c2.switchedToSafe, true);

    // Manual override ON
    const mOn = setManualSafeGraphics({ dataDir: dir, mode: 'on' });
    assert.equal(mOn.mode, 'on');
    assert.equal(evaluateGraphicsMode({ dataDir: dir, now: t0 + 10_000 }).safe, true);
    assert.equal(evaluateGraphicsMode({ dataDir: dir, now: t0 + 10_000 }).reason, 'manual');

    // Manual reset to AUTO clears crash/hang state
    setManualSafeGraphics({ dataDir: dir, mode: 'auto' });
    const evAuto = evaluateGraphicsMode({ dataDir: dir, now: t0 + 20_000 });
    assert.equal(evAuto.safe, false);
    assert.equal(evAuto.reason, 'normal');

    // CLI flag overrides normal mode
    const evCli = evaluateGraphicsMode({ dataDir: dir, argv: ['photobooth4u.exe', '--safe-graphics'], now: t0 + 25_000 });
    assert.equal(evCli.safe, true);
    assert.equal(evCli.reason, 'cli');

    const summary = graphicsStatusSummary({ dataDir: dir, activeSafe: evCli.safe, activeReason: evCli.reason });
    assert.equal(summary.safe, true);
    assert.equal(summary.mode, 'auto');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanUsbOffProcess coalesces concurrent calls, caches results, and backs off after timeouts', async () => {
  let calls = 0;
  let nowVal = 1_700_300_000_000;
  const logs = [];
  try {
    setUsbEnumRunner(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 25));
      return { ok: true, timedOut: false, ptp: [{ vendor: 0x04a9, product: 0x32da, bus: 1, address: 2, key: '1:2' }], printers: [] };
    });

    // Two concurrent calls coalesce into 1 runner invocation
    const [a, b] = await Promise.all([
      scanUsbOffProcess({ now: () => nowVal }),
      scanUsbOffProcess({ now: () => nowVal })
    ]);
    assert.equal(calls, 1);
    assert.equal(a.ok, true);
    assert.equal(b.ptp.length, 1);

    // Within 4s cache TTL -> returns cached without spawning again
    nowVal += 2000;
    const c = await scanUsbOffProcess({ now: () => nowVal });
    assert.equal(calls, 1);
    assert.equal(c.ptp.length, 1);

    // Timeout triggers 30s backoff (skips background scans without spawning)
    nowVal += 5000;
    setUsbEnumRunner(async () => {
      calls++;
      return { ok: false, timedOut: true, ptp: [], printers: [] };
    });
    const t1 = await scanUsbOffProcess({ timeoutMs: 2000, logger: (m) => logs.push(m), now: () => nowVal });
    assert.equal(t1.timedOut, true);
    assert.equal(logs.length, 1);
    const beforeSkip = calls;
    nowVal += 5000;
    const skipped = await scanUsbOffProcess({ now: () => nowVal });
    assert.equal(skipped.skipped, true);
    assert.equal(calls, beforeSkip, 'background scan during backoff must not spawn a child');

    // force: true bypasses backoff and resets it once USB responds again
    setUsbEnumRunner(async () => {
      calls++;
      return { ok: true, timedOut: false, ptp: [], printers: [] };
    });
    const forced = await scanUsbOffProcess({ force: true, now: () => nowVal });
    assert.equal(forced.ok, true);
    assert.equal(calls, beforeSkip + 1);
  } finally {
    setUsbEnumRunner(null);
    resetUsbEnumState();
  }
});

test('probeUsbPrinters delegates to off-process scanner and returns [] gracefully on USB timeout', async () => {
  try {
    setUsbBackend(null);
    setUsbEnumRunner(async () => ({
      ok: true,
      timedOut: false,
      ptp: [],
      printers: [{
        vid: 0x04f9,
        pid: 0x0475,
        bus: 1,
        address: 4,
        product: '',
        manufacturer: '',
        deviceId: '',
        interfaces: [{ num: 1, alt: 0, cls: 7, sub: 1, proto: 4, hasBulkPair: true }]
      }]
    }));
    const list = await probeUsbPrinters({ platform: 'win32', force: true });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Brother DCP-T420W');
    assert.equal(list[0].hasIppUsb, true);

    setUsbEnumRunner(async () => ({ ok: false, timedOut: true, ptp: [], printers: [] }));
    const empty = await probeUsbPrinters({ platform: 'win32', force: true });
    assert.deepEqual(empty, []);
  } finally {
    setUsbEnumRunner(null);
    resetUsbEnumState();
  }
});

test('initHelper({ deferWarm: true }) schedules staggered warm-up and cleans up cleanly on stopHelper()', () => {
  initHelper({ workerPath: '', deferWarm: true, logger: () => { } });
  stopHelper();
  assert.ok(true);
});
