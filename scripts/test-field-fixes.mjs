// Comprehensive unit + live integration test suite for the 4 field fixes:
// 1. Photo Mirror: live view mirrored while saved/printed photos stay normal by default (opt-in output mirror + Rush ID guard)
// 2. Canon SELPHY wireless borderless across Web/Booth UI, Desktop Direct IPP (live mock IPP server), Windows OS queues, Android IPP, iPad IPP/AirPrint
// 3. Offline QR & iPhone reliability across Desktop hotspot/share server (live HTTP server + concurrent thumbs + Range + abort), Android & iOS share servers
// 4. Videobook HD without lag across DSLR (live bundled FFmpeg 1080p +faststart + hflip + laptop mic mux), iOS/iPad, and Android/mobile web (live JS behavior)
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const booth = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
const netPrintKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
const androidShareKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'LocalShareServer.kt'), 'utf8');
const androidGallery = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'share', 'gallery.html'), 'utf8');
const iosVc = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'ViewController.swift'), 'utf8');
const iosShare = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'LocalShareServer.swift'), 'utf8');
const iosCam = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'NativeCameraBridge.swift'), 'utf8');
const hotspotSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'hotspot.mjs'), 'utf8');
const winPrintWorkerSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'winprint-worker.mjs'), 'utf8');
const photosSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'photos.mjs'), 'utf8');

const netprinters = await import('../desktop/lib/netprinters.mjs');
const helper = await import('../desktop/lib/helper.mjs');
const photos = await import('../desktop/lib/photos.mjs');
const spin = await import('../desktop/lib/spin.mjs');

let passed = 0;
async function check(name, fn) {
  await fn();
  console.log('PASS:', name);
  passed++;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

// ---------- 1. Mirror live view vs final output ----------
await check('Mirror live JS behavior: Live View mirrored while outputs & Rush ID stay normal by default, opt-in output mirror works, #gbMirror stays ON', () => {
  assert.match(booth, /id="gbMirror"[\s\S]{0,20}checked/);
  const start = booth.indexOf("var MIRROR_KEY = 'pb4u.mirror';");
  const end = booth.indexOf('function isFrontCamera()', start);
  assert.ok(start > 0 && end > start, 'mirror block found in booth.html');
  const block = booth.slice(start, end);

  const mem = {};
  const els = {
    surroundVideo: { style: {} },
    mirrorToggle: { checked: false, addEventListener() {} },
    mirrorOutputRow: { style: {} },
    mirrorOutputHint: { style: {} },
    mirrorOutputToggle: { checked: false, addEventListener() {} }
  };
  const video = { style: {} };
  const api = new Function('localStorage', 'document', 'video', 'isFrontCamera', 'guestCall',
    block + '; return { mirrorPref, mirrorPreview, mirrorOutputPref, mirrorOutput, applyMirror };'
  )(
    { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    { getElementById: (id) => els[id] || null },
    video,
    () => true,
    () => {}
  );

  // Case A: Default (mirror=auto on front cam -> preview ON, output OFF)
  api.applyMirror();
  assert.equal(api.mirrorPreview(), true);
  assert.equal(api.mirrorOutput(), false);
  assert.equal(video.style.transform, 'scaleX(-1)');
  assert.equal(els.mirrorOutputRow.style.display, '');
  assert.equal(els.mirrorOutputToggle.checked, false);

  // Case B: Mirror ON, mirrorOutput OFF -> live preview mirrored, capture NOT mirrored, Rush ID NOT double-flipped
  mem['pb4u.mirror'] = 'on';
  mem['pb4u.mirrorOutput'] = 'off';
  api.applyMirror();
  assert.equal(api.mirrorPreview(), true);
  assert.equal(api.mirrorOutput(), false);

  // Case C: Mirror ON, mirrorOutput ON -> both live preview and output mirrored
  mem['pb4u.mirrorOutput'] = 'on';
  api.applyMirror();
  assert.equal(api.mirrorPreview(), true);
  assert.equal(api.mirrorOutput(), true);
  assert.equal(els.mirrorOutputToggle.checked, true);

  // Case D: Mirror OFF, even if mirrorOutput was previously ON -> neither preview nor output mirrored, sub-row hidden
  mem['pb4u.mirror'] = 'off';
  api.applyMirror();
  assert.equal(api.mirrorPreview(), false);
  assert.equal(api.mirrorOutput(), false);
  assert.equal(video.style.transform, 'scaleX(1)');
  assert.equal(els.mirrorOutputRow.style.display, 'none');

  // Verify every capture path + Rush ID guard
  assert.match(booth, /function grabFrameCanvas\(\)[\s\S]{0,600}if \(mirrorOutput\(\)\)/);
  assert.match(booth, /async function webcamMaxShot[\s\S]{0,1400}const mir = mirrorOutput\(\);/);
  assert.match(booth, /async function tabletStillUpgrade[\s\S]{0,6000}mirrorOutput/);
  assert.match(booth, /async function captureShot[\s\S]{0,1600}const mir = mirrorOutput\(\);/);
  assert.match(booth, /captureTabletShot[\s\S]{0,1500}mirrorOutput/);
  assert.match(booth, /function webcamPushFrame[\s\S]{0,1200}mirrorOutput/);
  assert.match(booth, /if \(mirrorOutput\(\)\) \{ x\.translate\(out\.width, 0\); x\.scale\(-1, 1\); \}\s*\/\/ only un-flip if captureShot mirrored/);
});

// ---------- 2. Canon SELPHY wireless borderless ----------
await check('Live mock Canon CP1500 IPP server: tries zero-margin media-col (fill -> none -> default) without quality/mediaType before bordered named media', async () => {
  const ippStr = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
  const ippAttr = (tag, name, val) => Buffer.concat([Buffer.from([tag]), ippStr(name), ippStr(val)]);
  const capsReply = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x04]),
    ippAttr(0x41, 'printer-make-and-model', 'Canon CP1500'),
    ippAttr(0x49, 'document-format-supported', 'image/jpeg'),
    ippAttr(0x44, 'media-ready', 'jpn_hagaki_100x148mm'),
    ippAttr(0x44, 'media-supported', 'jpn_hagaki_100x148mm'),
    ippAttr(0x44, 'media-type-supported', 'photographic-glossy'),
    Buffer.from([0x03])
  ]);

  let mode = 'accept-first';
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (req.url !== '/ipp/print') return res.writeHead(404).end();
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const op = body.readUInt16BE(2);
      if (op === 0x000b) return res.writeHead(200, { 'content-type': 'application/ipp' }).end(capsReply);
      seen.push(body);
      const hasCol = body.includes(Buffer.from('media-col'));
      const hasFill = body.includes(Buffer.from('print-scaling')) && body.includes(Buffer.from('fill'));
      const hasNone = body.includes(Buffer.from('print-scaling')) && body.includes(Buffer.from('none'));
      const reject = (mode === 'accept-none' && hasFill)
        || (mode === 'accept-empty-scaling' && (hasFill || hasNone))
        || (mode === 'accept-named' && hasCol);
      const status = reject ? [0x02, 0x00, 0x04, 0x0b, 0, 0, 0, 1, 0x03] : [0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x03];
      res.writeHead(200, { 'content-type': 'application/ipp' }).end(Buffer.from(status));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

  try {
    // Attempt 1: zero-margin media-col + fill, no quality/mediaType even when caller passes quality=best, mediaType=photo
    mode = 'accept-first'; seen.length = 0;
    const r1 = await netprinters.ippPrintDirect({ ip: '127.0.0.1', port, jpeg, widthMm: 101.6, heightMm: 152.4, quality: 'best', mediaType: 'photo', borderless: true });
    assert.equal(seen.length, 1);
    assert.equal(r1.scaling, 'fill');
    assert.ok(seen[0].includes(Buffer.from('media-col')) && seen[0].includes(Buffer.from('media-top-margin')));
    assert.ok(!seen[0].includes(Buffer.from('print-quality')), 'SELPHY must not send print-quality');
    assert.ok(!seen[0].includes(Buffer.from('media-type')), 'SELPHY must not send media-type');

    // Attempt 2: printer rejects scaling=fill -> tries zero-margin media-col + scaling=none
    mode = 'accept-none'; seen.length = 0;
    const r2 = await netprinters.ippPrintDirect({ ip: '127.0.0.1', port, jpeg, widthMm: 100, heightMm: 148, borderless: true });
    assert.equal(seen.length, 2);
    assert.equal(r2.scaling, 'none');
    assert.ok(seen[1].includes(Buffer.from('media-col')));

    // Attempt 3: printer rejects fill & none -> tries zero-margin media-col with no print-scaling
    mode = 'accept-empty-scaling'; seen.length = 0;
    const r3 = await netprinters.ippPrintDirect({ ip: '127.0.0.1', port, jpeg, widthMm: 100, heightMm: 148, borderless: true });
    assert.equal(seen.length, 3);
    assert.equal(r3.scaling, '');
    assert.ok(seen[2].includes(Buffer.from('media-col')));

    // Attempt 4: printer rejects all media-col -> falls back to named media
    mode = 'accept-named'; seen.length = 0;
    const r4 = await netprinters.ippPrintDirect({ ip: '127.0.0.1', port, jpeg, widthMm: 100, heightMm: 148, borderless: true });
    assert.equal(seen.length, 4);
    assert.equal(r4.media, 'jpn_hagaki_100x148mm');

    // Explicit borderless=false -> sends named media first
    mode = 'accept-first'; seen.length = 0;
    const r5 = await netprinters.ippPrintDirect({ ip: '127.0.0.1', port, jpeg, widthMm: 100, heightMm: 148, borderless: false });
    assert.equal(seen.length, 1);
    assert.equal(r5.media, 'jpn_hagaki_100x148mm');
  } finally {
    srv.close();
  }
});

await check('Windows SELPHY OS queue pickPaper prefers borderless over bordered default, while DNP keeps dyeSub DEVMODE protection', async () => {
  const { pickPaper, PAPER_CACHE, IS_SELPHY, DYE_SUB } = helper._helperTest;
  assert.equal(IS_SELPHY.test('Canon SELPHY CP1500'), true);
  assert.equal(IS_SELPHY.test('Canon CP1300'), true);
  assert.equal(IS_SELPHY.test('DNP DS-RX1HS'), false);
  assert.equal(DYE_SUB.test('DNP DS-RX1HS'), true);

  const key = 'Canon SELPHY CP1500 Wireless Test';
  PAPER_CACHE.set(key, {
    at: Date.now(),
    def: 'Postcard 100x148mm',
    sizes: [
      { key: 'Postcard 100x148mm', name: 'Postcard 100x148mm', w: 100, h: 148, borderless: false },
      { key: 'Postcard 100x148mm Borderless', name: 'Postcard 100x148mm Borderless', w: 100, h: 148, borderless: true }
    ]
  });
  const picked = await pickPaper(key, 101.6, 152.4, false);
  PAPER_CACHE.delete(key);
  assert.ok(picked, 'pickPaper should return a paper');
  assert.equal(picked.borderless, true, 'SELPHY should pick borderless paper over bordered default');
  assert.equal(picked.keep, false, 'SELPHY should switch off bordered default');

  assert.match(winPrintWorkerSrc, /if \(\$Borderless -and -not \$DyeSub\)/);
  assert.match(winPrintWorkerSrc, /elseif \(\$Borderless -and \$Selphy\)/);
  assert.match(booth, /function isSelphyName\(s\)/);
  assert.match(booth, /const selphyDirect = !!\(p\.ipp && isSelphyName\(p\.name\)\);/);
  assert.match(netPrintKt, /val zeroMargin = if \(selphy && ns != null\) listOf\([\s\S]{0,300}"fill"[\s\S]{0,120}"none"[\s\S]{0,120}""/);
  assert.match(iosVc, /scaling:\s*"none",\s*marginMm100:\s*0/);
  assert.match(iosVc, /gap\(\$0\) <= minGap \+ 6\.0/);
});

// ---------- 3. Offline QR & iPhone reliability (live local HTTP share server) ----------
await check('Live Desktop Share Server: atomic writes, deduplicated concurrent thumbs with Content-Length, Range 206, 200 auto-reload waiting pages, iPhone tips & sticky hotspot IP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-qr-test-'));
  let thumbCalls = 0;
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 0x42), Buffer.from([0xff, 0xd9])]);
  const fakeThumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 0x24), Buffer.from([0xff, 0xd9])]);

  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    photos.initPhotos({
      root: join(dir, 'photos'),
      dataDir: join(dir, 'data'),
      makeThumb: async () => {
        thumbCalls++;
        await new Promise((r) => setTimeout(r, 60));
        return fakeThumb;
      }
    });
    const port = await photos.startShareServer();
    assert.ok(port > 0, 'share server started on valid port');

    // Save photo via driveRequest (atomic write)
    const saved = await photos.driveRequest({
      folderKey: 'Test Wedding',
      filename: '1_strip.jpg',
      guestCode: 'ABC123456789012345',
      buffer: fakeJpeg
    });
    assert.equal(saved.ok, true);
    const slug = saved.fileId.split('/')[0];
    const printsDir = join(saved.folderPath, 'Prints');
    const dirFiles = readdirSync(printsDir);
    assert.ok(dirFiles.includes('1_strip.jpg'));
    assert.ok(!dirFiles.some((f) => f.includes('.tmp.')), 'no leftover .tmp files after atomic write');

    // Photo page /e/<slug>/p/<file> and personal page /o/<code> include iPhone resilience & post-save disconnect notice
    const pRes = await httpGet(`http://127.0.0.1:${port}/e/${slug}/p/1_strip.jpg`);
    assert.equal(pRes.status, 200);
    const pHtml = pRes.body.toString('utf8');
    assert.ok(pHtml.includes('pbSavedNote'), 'photo page includes post-save disconnect banner');
    assert.ok(pHtml.includes('Mobile Data (4G/5G) OFF'), 'photo page includes iPhone Mobile Data tip');
    assert.ok(pHtml.includes('Reload photo'), 'photo page includes image auto-retry recovery');

    const oRes = await httpGet(`http://127.0.0.1:${port}/o/ABC123456789012345`);
    assert.equal(oRes.status, 200);
    assert.ok(oRes.body.toString('utf8').includes('pbSavedNote'));

    // Missing photo on /p/ & unknown /o/ return 200 auto-reload waiting page (not hard 404)
    const waitP = await httpGet(`http://127.0.0.1:${port}/e/${slug}/p/not_saved_yet.jpg`);
    assert.equal(waitP.status, 200);
    assert.ok(waitP.body.toString('utf8').includes('location.reload()'));
    const waitO = await httpGet(`http://127.0.0.1:${port}/o/PENDING99123456789`);
    assert.equal(waitO.status, 200);
    assert.ok(waitO.body.toString('utf8').includes('location.reload()'));

    // 10 concurrent thumbnail requests -> thumbFn called ONCE, all return 200 with exact Content-Length
    const thumbResults = await Promise.all(
      Array.from({ length: 10 }, () => httpGet(`http://127.0.0.1:${port}/e/${slug}/t/1_strip.jpg`))
    );
    assert.equal(thumbCalls, 1, 'concurrent thumbnail requests must deduplicate to 1 thumbFn call');
    for (const tr of thumbResults) {
      assert.equal(tr.status, 200);
      assert.equal(Number(tr.headers['content-length']), fakeThumb.length);
      assert.deepEqual(tr.body, fakeThumb);
    }
    const thumbDirFiles = readdirSync(join(saved.folderPath, '.thumbs'));
    assert.ok(!thumbDirFiles.some((f) => f.includes('.tmp.')), 'no leftover .tmp files in .thumbs');

    // HTTP Range 206 partial streaming
    const rangeRes = await httpGet(`http://127.0.0.1:${port}/e/${slug}/f/1_strip.jpg`, { Range: 'bytes=0-63' });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.body.length, 64);
    assert.equal(rangeRes.headers['content-range'], `bytes 0-63/${fakeJpeg.length}`);

    // Sticky hotspot IP test
    const hsNets = {
      'Wi-Fi': [{ address: '192.168.1.55', family: 'IPv4', internal: false }],
      'Local Area Connection* 10': [{ address: '192.168.137.1', family: 'IPv4', internal: false }]
    };
    assert.equal(photos.lanAddress(hsNets, { wanted: true, on: true }), '192.168.137.1');
    assert.equal(photos.lanAddress({ 'Wi-Fi': [{ address: '192.168.1.55', family: 'IPv4', internal: false }] }, { wanted: true, on: true }), '192.168.137.1');
  } finally {
    photos.stopShareServer();
    rmSync(dir, { recursive: true, force: true });
  }

  // Static checks for hotspot, iOS & Android share servers + gallery.html JS parse
  assert.match(hotspotSrc, /\[switch\]\$PreferOffline/);
  assert.match(hotspotSrc, /KM-TEST Loopback/);
  assert.match(hotspotSrc, /MaxClientCount/);
  assert.match(hotspotSrc, /15000\);/);
  assert.match(photosSrc, /s\.keepAliveTimeout = 65_000/);
  assert.match(photosSrc, /s\.headersTimeout = 70_000/);
  assert.match(iosShare, /DispatchSemaphore\(value: 32\)/);
  assert.match(iosShare, /while reqBytes\.count < 16384/);
  assert.match(iosShare, /func renderWaitingHtml\(/);
  assert.match(iosShare, /\/e\/\\\(folder\.slug\)\/t\/\\\(encName\)/);
  assert.match(androidShareKt, /s\.soTimeout = 30000/);
  assert.match(androidShareKt, /tmp\.renameTo\(tf\)/);
  const gScripts = [...androidGallery.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(gScripts.length >= 2, 'gallery.html script blocks found');
  for (const s of gScripts) new Function(s[1]); // every script block parses cleanly in V8!
  assert.match(androidGallery, /setTimeout\(loadGallery, 3000\)/);
  assert.match(androidGallery, /media\.onerror = function/);
});

// ---------- 4. Videobook HD without lag (live JS behavior + live FFmpeg 1080p transcode) ----------
await check('Videobook JS behavior: uncommented mimeType, hardware H.264 priority, smart vgLowPower, vgTuneCamera raises sub-HD to HD & caps 4K', async () => {
  assert.doesNotMatch(booth, /\/\/[^\n]*if \(mime\) opts\.mimeType = mime;/);
  assert.match(booth, /\n\s*if \(mime\) opts\.mimeType = mime;/);
  assert.match(booth, /captureStream\(canManual \? 0 : 30\)/);
  assert.match(booth, /getContext\('2d',\s*\{\s*alpha:\s*false,\s*desynchronized:\s*true\s*\}\)/);
  assert.match(booth, /function vgRecordDslr\(\)/);
  assert.match(booth, /PBX\.vgFinalize\(/);

  // Extract and execute vgMime()
  const mimeM = booth.match(/function vgMime\(\) \{[\s\S]*?\n      \}/);
  assert.ok(mimeM, 'vgMime found');
  const runMime = (supported) => new Function('MediaRecorder', mimeM[0] + '; return vgMime();')({
    isTypeSupported: (t) => supported.includes(t)
  });
  assert.equal(runMime(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus']), 'video/mp4;codecs=avc1.640028,mp4a.40.2');
  assert.equal(runMime(['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus']), 'video/webm;codecs=h264,opus', 'prefers hardware H.264 WebM over software VP9 on Android');
  assert.equal(runMime(['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']), 'video/webm;codecs=vp8,opus', 'prefers lighter VP8 over heavy software VP9');

  // Extract and execute vgLowPower()
  const lpM = booth.match(/function vgLowPower\(\) \{[\s\S]*?\n      \}/);
  assert.ok(lpM, 'vgLowPower found');
  const runLp = (nav) => new Function('navigator', lpM[0] + '; return vgLowPower();')(nav);
  assert.equal(runLp({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', hardwareConcurrency: 8, deviceMemory: 8 }), false, 'flagship 8-core Android is NOT low-power');
  assert.equal(runLp({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', hardwareConcurrency: 4, deviceMemory: 3 }), false, 'iPhone/iPad is NOT low-power');
  assert.equal(runLp({ userAgent: 'Mozilla/5.0 (Linux; Android 11; BudgetTab)', hardwareConcurrency: 4, deviceMemory: 2 }), true, 'budget 2GB/4-core tablet IS low-power');

  // Extract and execute vgTuneCamera()
  const tuneM = booth.match(/async function vgTuneCamera\(\) \{[\s\S]*?\n      \}/);
  assert.ok(tuneM, 'vgTuneCamera found');
  const testTune = async (settings, lowPower, quality = 'auto') => {
    let applied = null;
    const track = { getSettings: () => settings, applyConstraints: async (c) => { applied = c; } };
    const VG_Q = { smooth: { w: 854, h: 480, cap: 854, br: 1500000 }, sd: { w: 1280, h: 720, cap: 1280, br: 3200000 }, hd: { w: 1920, h: 1080, cap: 1920, br: 6000000 } };
    await new Function('currentDeviceId', 'USB_CAM_ID', 'currentStream', 'video', 'VG_Q', 'vgQuality', 'vgLowPower',
      'var vgCamSaved = null; ' + tuneM[0] + '; return vgTuneCamera();'
    )('cam1', '__usb__', { getVideoTracks: () => [track] }, {}, VG_Q, () => quality, () => lowPower);
    return applied;
  };
  const raisedStrong = await testTune({ width: 640, height: 480, frameRate: 30 }, false, 'auto');
  assert.equal(raisedStrong.width.ideal, 1920, 'sub-HD 480p stream raises to 1080p on strong device');
  assert.equal(raisedStrong.height.ideal, 1080);
  const raisedBudget = await testTune({ width: 640, height: 480, frameRate: 30 }, true, 'auto');
  assert.equal(raisedBudget.width.ideal, 1280, 'sub-HD 480p stream raises to 720p HD on budget device');
  assert.equal(raisedBudget.height.ideal, 720);
  const capped4k = await testTune({ width: 3840, height: 2160, frameRate: 60 }, false, 'auto');
  assert.equal(capped4k.width.ideal, 1920, '4K 60fps stream caps to 1080p @ 30fps');
  assert.equal(capped4k.frameRate.max, 30);
});

await check('Live bundled FFmpeg execution: finalizeGuestbookVideo transcodes 1080p DSLR MOV -> yuv420p H.264 +faststart MP4 (mirror + laptop mic mux + temp cleanup)', async () => {
  spin.configure({ buildDir: join(ROOT, 'desktop', 'build') });
  const ffmpegBin = await spin.findFfmpeg();
  assert.ok(ffmpegBin, 'bundled or system FFmpeg must be available for live transcode test');

  const work = join(tmpdir(), 'pb4u-vg-movie');
  mkdirSync(work, { recursive: true });
  const rawMov = join(work, 'test-dslr-' + Date.now() + '.mov');
  const rawMov2 = join(work, 'test-dslr-mic-' + Date.now() + '.mov');
  const micFile = join(work, 'test-mic-' + Date.now() + '.webm');

  try {
    // Synthesize a real 1920x1080 1.2s MOV clip with audio (simulating Canon/Nikon DSLR output)
    execFileSync(ffmpegBin, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le', '-f', 'mov', rawMov
    ], { stdio: 'pipe', timeout: 30000 });

    // 1. Test mirror=true with DSLR audio
    const res1 = await spin.finalizeGuestbookVideo({ moviePath: rawMov, mirror: true, maxWidth: 1920, bitrate: 5000000 });
    assert.equal(res1.ok, true, 'finalizeGuestbookVideo (mirror) failed: ' + res1.error);
    assert.equal(res1.width, 1920);
    assert.equal(res1.height, 1080);
    assert.ok(res1.bytes && res1.bytes.byteLength > 8000, 'valid non-empty MP4 output');
    const buf1 = Buffer.from(res1.bytes);
    const moovIdx = buf1.indexOf(Buffer.from('moov'));
    const mdatIdx = buf1.indexOf(Buffer.from('mdat'));
    assert.ok(moovIdx > 0 && mdatIdx > 0 && moovIdx < mdatIdx, `MP4 must be +faststart (moov=${moovIdx} < mdat=${mdatIdx})`);
    assert.equal(existsSync(rawMov), false, 'temporary DSLR .mov inside pb4u-vg-movie must be cleaned up automatically');

    // 2. Test laptop microphone muxing (video-only DSLR + external WebM/Opus mic)
    execFileSync(ffmpegBin, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=1.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-f', 'mov', rawMov2
    ], { stdio: 'pipe', timeout: 30000 });
    execFileSync(ffmpegBin, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2',
      '-c:a', 'libopus', '-f', 'webm', micFile
    ], { stdio: 'pipe', timeout: 30000 });
    const micBytes = new Uint8Array(readFileSync(micFile));
    const res2 = await spin.finalizeGuestbookVideo({ moviePath: rawMov2, audioBytes: micBytes, audioExt: '.webm', mirror: false, maxWidth: 1920, bitrate: 5000000 });
    assert.equal(res2.ok, true, 'finalizeGuestbookVideo (laptop mic mux) failed: ' + res2.error);
    assert.equal(res2.width, 1920);
    assert.equal(res2.height, 1080);
    const outProbeFile = join(work, 'probe-out-' + Date.now() + '.mp4');
    writeFileSync(outProbeFile, Buffer.from(res2.bytes));
    const info2 = await spin.probe(outProbeFile);
    rmSync(outProbeFile, { force: true });
    assert.equal(info2.hasAudio, true, 'muxed MP4 must contain the laptop microphone audio stream');
    assert.equal(existsSync(rawMov2), false, 'temporary DSLR .mov must be cleaned up after mic mux');
  } finally {
    try { rmSync(rawMov, { force: true }); } catch {}
    try { rmSync(rawMov2, { force: true }); } catch {}
    try { rmSync(micFile, { force: true }); } catch {}
  }
});

await check('iOS NativeCameraBridge.swift offloads recording to async recordingQueue with High Profile CABAC, faststart, and zero-copy passthrough', () => {
  assert.match(iosCam, /com\.photobooth4u\.avcam\.record/);
  assert.match(iosCam, /writer\.shouldOptimizeForNetworkUse = true/);
  assert.match(iosCam, /AVVideoProfileLevelH264HighAutoLevel/);
  assert.match(iosCam, /AVVideoH264EntropyModeCABAC/);
  assert.match(iosCam, /recDirectPassthrough/);
  assert.match(iosCam, /recordingQueue\.sync/);
});

await check('All modified Kotlin and Swift source files have balanced {}, (), [] delimiters (full lexer)', () => {
  const checkBalanced = (label, s, isKt) => {
    let i = 0, bc = 0, pc = 0, sc = 0;
    while (i < s.length) {
      const c = s[i], n = s[i + 1];
      if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      if (c === '"' && n === '"' && s[i + 2] === '"') { i += 3; while (i < s.length && !(s[i] === '"' && s[i + 1] === '"' && s[i + 2] === '"')) i++; i += 3; continue; }
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } i++; continue; }
      if (c === "'" && isKt) { i++; while (i < s.length && s[i] !== "'") { if (s[i] === '\\') i++; i++; } i++; continue; }
      if (c === '{') bc++; else if (c === '}') bc--;
      else if (c === '(') pc++; else if (c === ')') pc--;
      else if (c === '[') sc++; else if (c === ']') sc--;
      i++;
    }
    assert.equal(bc, 0, `${label}: unbalanced {} (delta ${bc})`);
    assert.equal(pc, 0, `${label}: unbalanced () (delta ${pc})`);
    assert.equal(sc, 0, `${label}: unbalanced [] (delta ${sc})`);
  };
  checkBalanced('NetPrintBridge.kt', netPrintKt, true);
  checkBalanced('LocalShareServer.kt', androidShareKt, true);
  checkBalanced('ViewController.swift', iosVc, false);
  checkBalanced('LocalShareServer.swift', iosShare, false);
  checkBalanced('NativeCameraBridge.swift', iosCam, false);
});

console.log(`\nALL ${passed} UNIT & LIVE INTEGRATION CHECKS PASSED!`);
