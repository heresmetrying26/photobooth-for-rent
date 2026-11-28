// Automated verification for Booth Wi-Fi 15-20 phone capacity & never-fail crowd protection:
//  1. Windows icssvc\Settings\WifiMaxPeers=20 + PeerlessTimeoutEnabled=0 + PowerShell parser syntax check
//  2. Hardware P2P Max Mobile AP Clients parsing & effectiveCap calculation
//  3. Smart auto-recycle decision state machine across all safety guards
//  4. Live 20-phone concurrent HTTP download + bounded thumbnail worker concurrency (<= 3)
//  5. Hotspot traffic & station protection tracker + sticky IP during recycle
//  6. Desktop IPC, preload, and built Booth UI wiring checks
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS:', name);
  } catch (e) {
    failed++;
    console.error('FAIL:', name, '\n  ', e && e.stack ? e.stack : e);
  }
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

const hotspot = await import('../desktop/lib/hotspot.mjs');
const photos = await import('../desktop/lib/photos.mjs');
const hotspotSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'hotspot.mjs'), 'utf8');
const mainSrc = readFileSync(join(ROOT, 'desktop', 'main.mjs'), 'utf8');
const preloadSrc = readFileSync(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');

await check('Hardware P2P Max Mobile AP Clients parser & effectiveCap math', async () => {
  const intelOut = [
    'Interface name: Wi-Fi',
    '    Wi-Fi Direct GO                             : Supported',
    '    P2P Max Mobile AP Clients                   : 8'
  ].join('\r\n');
  assert.equal(hotspot.parseHwMaxClients(intelOut), 8);
  assert.equal(hotspot.parseHwMaxClients('    P2P Max Mobile AP Clients : 32'), 32);
  assert.equal(hotspot.parseHwMaxClients('P2P Max Mobile AP Clients : 8\nP2P Max Mobile AP Clients : 20'), 20);
  assert.equal(hotspot.parseHwMaxClients('No wireless interface'), 0);

  assert.equal(hotspot.computeEffectiveCap(20, 8), 8);
  assert.equal(hotspot.computeEffectiveCap(20, 32), 20);
  assert.equal(hotspot.computeEffectiveCap(20, 0), 20);
  assert.equal(hotspot.computeEffectiveCap(8, 0), 8);
});

await check('Auto-recycle decision engine protects active downloads, fresh joins, booth stations & flaky drivers while clearing stale full slots', async () => {
  const T = 10_000_000;
  // 8/20 on an Intel 8-client hardware card, idle for 35 s -> clears cleanly
  const rFull = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 20, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 35_000, lastClientJoinAt: T - 50_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rFull.shouldRecycle, true);
  assert.equal(rFull.reason, 'full-idle');

  // Active download in flight -> NEVER interrupts
  const rActive = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 1, lastGuestActivityAt: T - 60_000, lastClientJoinAt: T - 90_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rActive.shouldRecycle, false);
  assert.equal(rActive.reason, 'active-transfer');

  // Guest loaded photo 15 s ago (< 30 s grace) -> NEVER interrupts
  const rRecentHttp = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 15_000, lastClientJoinAt: T - 90_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rRecentHttp.shouldRecycle, false);
  assert.equal(rRecentHttp.reason, 'recent-activity');

  // Brand-new guest just joined Wi-Fi 25 s ago (< 40 s grace) -> gives them time to scan Photo QR
  const rRecentJoin = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 120_000, lastClientJoinAt: T - 25_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rRecentJoin.shouldRecycle, false);
  assert.equal(rRecentJoin.reason, 'recent-join');

  // Booth Sharing Station / iPad camera connected on Booth Wi-Fi -> blocked & surfaced
  const rStation = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 120_000, lastClientJoinAt: T - 120_000,
    lastRecycleAt: 0, stationOnHotspot: true, now: T
  });
  assert.equal(rStation.shouldRecycle, false);
  assert.equal(rStation.blockedByStation, true);
  assert.equal(rStation.reason, 'station-connected');

  // Crash-history laptop -> NEVER auto-cycles flaky Wi-Fi driver
  const rCrash = hotspot.evaluateAutoRecycle({
    enabled: true, hadCrash: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rCrash.shouldRecycle, false);
  assert.equal(rCrash.reason, 'crash-guard');

  // Auto-recycle paused after a driver error -> stays paused
  const rPaused = hotspot.evaluateAutoRecycle({
    enabled: true, paused: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rPaused.shouldRecycle, false);
  assert.equal(rPaused.reason, 'paused');

  // Cooldown (< 180 s since last recycle) -> protects Wi-Fi driver from flapping
  const rCool = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: T - 100_000, stationOnHotspot: false, now: T
  });
  assert.equal(rCool.shouldRecycle, false);
  assert.equal(rCool.reason, 'cooldown');

  // Hourly circuit breaker (>= 10 recycles in last hour) -> stops cycling
  const rHourly = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: T - 300_000, recyclesLastHour: 10, stationOnHotspot: false, now: T
  });
  assert.equal(rHourly.shouldRecycle, false);
  assert.equal(rHourly.reason, 'hourly-limit');

  // Near-full (7/8 on 8-client card) waits until 120 s idle, then proactively clears BEFORE phone #8/#9 hits a wall
  const rNearWait = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 7, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 90_000, lastClientJoinAt: T - 140_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rNearWait.shouldRecycle, false);
  const rNearGo = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 7, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 130_000, lastClientJoinAt: T - 140_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rNearGo.shouldRecycle, true);
  assert.equal(rNearGo.reason, 'near-full-idle');

  // 20-client hardware at 19/20 -> does NOT prematurely cycle (waits until truly full at 20/20)
  const r19 = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 19, maxClients: 20, hwMaxClients: 20,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(r19.shouldRecycle, false);
  assert.equal(r19.reason, 'below-threshold');

  // 20/20 on 20-client hardware idle 35 s -> recycles
  const r20 = hotspot.evaluateAutoRecycle({
    enabled: true, clients: 20, maxClients: 20, hwMaxClients: 20,
    activeTransfers: 0, lastGuestActivityAt: T - 35_000, lastClientJoinAt: T - 60_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(r20.shouldRecycle, true);
  assert.equal(r20.reason, 'full-idle');

  // Disabled -> never recycles
  const rOff = hotspot.evaluateAutoRecycle({
    enabled: false, clients: 8, maxClients: 8, hwMaxClients: 8,
    activeTransfers: 0, lastGuestActivityAt: T - 180_000, lastClientJoinAt: T - 180_000,
    lastRecycleAt: 0, stationOnHotspot: false, now: T
  });
  assert.equal(rOff.shouldRecycle, false);
});

await check('Live 20-phone concurrent share server load, bounded thumbnail concurrency (<=2), ETag 304, cache invalidation, traffic tracking & sticky recycle IP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-hs20-'));
  let runningThumbs = 0;
  let peakThumbs = 0;
  let totalThumbs = 0;
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16384, 0x55), Buffer.from([0xff, 0xd9])]);
  const fakeThumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0xff, 0xd9]);

  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    photos.initPhotos({
      root: join(dir, 'photos'),
      dataDir: join(dir, 'data'),
      makeThumb: async () => {
        runningThumbs++;
        totalThumbs++;
        if (runningThumbs > peakThumbs) peakThumbs = runningThumbs;
        await new Promise((r) => setTimeout(r, 35));
        runningThumbs--;
        return fakeThumb;
      }
    });

    const files = [];
    let slug = '';
    for (let i = 1; i <= 12; i++) {
      const saved = await photos.driveRequest({
        folderKey: 'BigWedding20',
        filename: `${i}_strip.jpg`,
        buffer: fakeJpeg
      });
      assert.equal(saved.ok, true);
      slug = saved.fileId.split('/')[0];
      files.push(`${i}_strip.jpg`);
    }

    const port = await photos.startShareServer();
    assert.ok(port > 0, 'share server started');

    // Simulate 20 concurrent guest phones opening gallery, photo pages, full downloads & 12 uncached thumbnails
    const reqs = [];
    for (let p = 0; p < 20; p++) {
      const f = files[p % files.length];
      reqs.push(httpGet(`http://127.0.0.1:${port}/e/${slug}/`));
      reqs.push(httpGet(`http://127.0.0.1:${port}/e/${slug}/p/${encodeURIComponent(f)}`));
      reqs.push(httpGet(`http://127.0.0.1:${port}/e/${slug}/t/${encodeURIComponent(f)}`));
      reqs.push(httpGet(`http://127.0.0.1:${port}/e/${slug}/f/${encodeURIComponent(f)}?dl=1`));
    }
    const results = await Promise.all(reqs);
    assert.equal(results.length, 80);
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].status, 200, `request #${i} succeeded`);
    }
    // Verify file payload integrity on downloads (every 4th request)
    for (let i = 3; i < results.length; i += 4) {
      assert.equal(results[i].body.length, fakeJpeg.length);
    }
    // Verify thumbnail worker queue bounded parallel decodes to <= 2 and deduplicated to exactly 12 unique files
    assert.equal(totalThumbs, 12, '12 unique thumbnails generated across 20 concurrent phones');
    assert.ok(peakThumbs <= 2, `peak concurrent thumbFn calls (${peakThumbs}) stayed <= 2`);

    // ETag + 304 Not Modified transfers 0 bytes on phone gallery/photo revisit
    const tFirst = await httpGet(`http://127.0.0.1:${port}/e/${slug}/t/1_strip.jpg`);
    assert.equal(tFirst.status, 200);
    assert.ok(tFirst.headers.etag, 'thumbnail response includes ETag');
    const t304 = await httpGet(`http://127.0.0.1:${port}/e/${slug}/t/1_strip.jpg`, { 'if-none-match': tFirst.headers.etag });
    assert.equal(t304.status, 304, 'matching If-None-Match returns 304 Not Modified');
    assert.equal(t304.body.length, 0);

    // photosIn cache immediately invalidates when a new 13th photo is saved
    await photos.driveRequest({ folderKey: 'BigWedding20', filename: '13_strip.jpg', buffer: fakeJpeg });
    const gAfter = await httpGet(`http://127.0.0.1:${port}/e/${slug}/list.json`);
    assert.equal(gAfter.status, 200);
    const parsedList = JSON.parse(gAfter.body.toString('utf8'));
    assert.equal(parsedList.files.length, 13, 'new 13th photo appears immediately despite gallery TTL cache');

    // Hotspot traffic tracker unit checks
    photos.resetHotspotTrafficForTest();
    assert.equal(photos.isHotspotClientIp('192.168.137.42'), true);
    assert.equal(photos.isHotspotClientIp('::ffff:192.168.137.42'), true);
    assert.equal(photos.isHotspotClientIp('192.168.137.1'), false);
    assert.equal(photos.isHotspotClientIp('192.168.1.50'), false);

    assert.equal(photos.noteHotspotTraffic('192.168.137.42', '/e/abc/f/1.jpg', 5000), 'guest');
    let tr = photos.getHotspotTrafficState(5500);
    assert.equal(tr.lastGuestActivityAt, 5000);
    assert.equal(tr.stationOnHotspot, false);

    assert.equal(photos.noteHotspotTraffic('192.168.137.19', '/station/abc/list', 6000), 'station');
    tr = photos.getHotspotTrafficState(6500);
    assert.equal(tr.stationOnHotspot, true);
    // Station flag expires cleanly after TTL
    tr = photos.getHotspotTrafficState(6000 + 70_000);
    assert.equal(tr.stationOnHotspot, false);

    // Sticky hotspot IP stays pinned to 192.168.137.1 during a 3 s recycle
    const hsNets = {
      'Wi-Fi': [{ address: '192.168.1.55', family: 'IPv4', internal: false }],
      'Local Area Connection* 10': [{ address: '192.168.137.1', family: 'IPv4', internal: false }]
    };
    assert.equal(photos.lanAddress(hsNets, { wanted: true, on: true }), '192.168.137.1');
    assert.equal(photos.lanAddress({ 'Wi-Fi': [{ address: '192.168.1.55', family: 'IPv4', internal: false }] }, { wanted: true, on: false, recycling: true }), '192.168.137.1');
  } finally {
    photos.stopShareServer();
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('Embedded Windows PowerShell scripts parse cleanly and avoid heavy WMI polling / abrupt driver kills', async () => {
  const names = ['TETHER_PS', 'SETUP_PS', 'FIX_FIREWALL_PS', 'BOOST_LIMIT_PS'];
  assert.match(hotspotSrc, /icssvc\\Settings/);
  assert.match(hotspotSrc, /WifiMaxPeers/);
  assert.match(hotspotSrc, /PeerlessTimeoutEnabled/);
  assert.match(hotspotSrc, /\$Mode -eq 'recycle'/);
  assert.match(hotspotSrc, /PRIORITY_BELOW_NORMAL/);
  const tetherBody = /const TETHER_PS = String\.raw`([\s\S]*?)`;/.exec(hotspotSrc)[1];
  assert.doesNotMatch(tetherBody, /Get-NetAdapter/, 'TETHER_PS avoids slow 8 s WMI Get-NetAdapter module load');
  assert.match(tetherBody, /NetworkInterface\]::GetAllNetworkInterfaces\(\)/);
  const boostBody = /const BOOST_LIMIT_PS = String\.raw`([\s\S]*?)`;/.exec(hotspotSrc)[1];
  assert.doesNotMatch(boostBody, /Stop-Service[^;\n]*-Force/, 'BOOST_LIMIT_PS stops icssvc gracefully after SoftAP teardown');

  if (process.platform === 'win32') {
    for (const nm of names) {
      const m = new RegExp(`const ${nm} = String\\.raw\`([\\s\\S]*?)\`;`).exec(hotspotSrc);
      assert.ok(m, `found ${nm}`);
      const psCode = m[1].replace(/@OUT@/g, 'C:\\temp\\out.json').replace(/@EXE@/g, 'C:\\temp\\app.exe').replace(/@MAX@/g, '20');
      const b64 = Buffer.from(psCode, 'utf8').toString('base64');
      const verifyScript = `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $tok=$null; $err=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$tok, [ref]$err); if ($err.Count -gt 0) { $err | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verifyScript], { encoding: 'utf8', windowsHide: true });
    }
  }
});

await check('Desktop main.mjs, preload.cjs, and built protected/booth.html wire boost, recycle & auto-recycle cleanly', async () => {
  assert.match(mainSrc, /getHotspotTrafficState/);
  assert.match(mainSrc, /ipcMain\.handle\('pb4u:hotspotRaiseLimit'/);
  assert.match(mainSrc, /ipcMain\.handle\('pb4u:hotspotRecycle'/);
  assert.match(mainSrc, /ipcMain\.handle\('pb4u:hotspotAutoRecycle'/);
  assert.match(preloadSrc, /hotspotRaiseLimit:/);
  assert.match(preloadSrc, /hotspotRecycle:/);
  assert.match(preloadSrc, /hotspotAutoRecycle:/);
  assert.match(boothHtml, /id="deskHotspotBoost"/);
  assert.match(boothHtml, /id="deskHotspotRecycle"/);
  assert.match(boothHtml, /id="deskHotspotAutoRecycle"/);
  assert.match(boothHtml, /api\.hotspotRaiseLimit\(20\)/);
  assert.match(boothHtml, /api\.hotspotRecycle\(\)/);
  assert.match(boothHtml, /api\.hotspotAutoRecycle\(/);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
