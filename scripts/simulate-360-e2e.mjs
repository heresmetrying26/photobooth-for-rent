// Full start-to-end live simulation for Standalone 360 Arm Cam (iOS + Android),
// PNG Overlay compositing, Connected-to-Laptop 360 Desk protocol, and Sharing Station (scan QR + type URL/WhatsApp/Email).
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FFMPEG = join(ROOT, 'desktop', 'build', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BROWSER_BIN = CHROME_PATHS.find((p) => existsSync(p));

let totalChecks = 0;
async function step(label, fn) {
  const t0 = Date.now();
  const res = await fn();
  console.log(`PASS [${Date.now() - t0}ms]: ${label}`);
  totalChecks++;
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Minimal Headless Chrome CDP Driver (Node 24 built-in WebSocket) ----------
async function launchHeadlessBrowser() {
  assert.ok(BROWSER_BIN, 'Chrome or Edge is required for live DOM simulation');
  const userDataDir = mkdtempSync(join(tmpdir(), 'pb360-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(BROWSER_BIN, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) { targets = await r.json(); if (targets.length) break; }
    } catch { /* wait */ }
    await sleep(150);
  }
  assert.ok(targets && targets.length, 'Headless browser failed to start CDP');

  async function openPage(url) {
    const createRes = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
      .catch(() => fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`));
    const tab = await createRes.json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let mid = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params?.exceptionDetails?.text || 'Runtime exception');
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++mid;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    // Wait for document readyState === complete
    for (let i = 0; i < 40; i++) {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      if (r.result?.value === 'complete') break;
      await sleep(100);
    }
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error('Browser JS error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result?.value;
    };
    const close = async () => {
      try { ws.close(); } catch { /* ignore */ }
      try { await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`); } catch { /* ignore */ }
    };
    return { evalJs, consoleErrors, close };
  }

  const shutdown = async () => {
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { openPage, shutdown };
}

// ---------- Start Simulation ----------
const workDir = mkdtempSync(join(tmpdir(), 'pb360-e2e-'));
const photosRootDir = join(workDir, 'photos');
const dataDir = join(workDir, 'data');
const spinTempDir = join(workDir, 'spin-temp');
mkdirSync(photosRootDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(spinTempDir, { recursive: true });

let PHOTOS = null;
let browser = null;
let mobileStationServer = null;

try {
  // =========================================================================
  // 1. NATIVE BUTTON & SELECTOR WIRING AUDIT (ALL iOS + ANDROID 360 SCREENS)
  // =========================================================================
  await step('Audit every native UIButton/control target on iOS & Android 360 Arm Cam', () => {
    const iosFiles = [
      'ios/spinarm/SpinArmGateViewController.swift',
      'ios/photobooth4u/SpinArmViewController.swift',
      'ios/photobooth4u/SpinQuickShareViewController.swift',
    ];
    let iosActionsChecked = 0;
    for (const rel of iosFiles) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const selectors = [...src.matchAll(/#selector\(([A-Za-z0-9_]+)(?::\))?/g)].map((m) => m[1]);
      assert.ok(selectors.length > 0, `${rel} should have wired selectors`);
      for (const sel of selectors) {
        const re = new RegExp(`@objc\\s+(?:private\\s+)?func\\s+${sel}\\b`);
        assert.match(src, re, `${rel}: missing @objc func ${sel} for wired button/control`);
        iosActionsChecked++;
      }
    }

    // Verify key iOS buttons exist and are wired
    const iosArm = readFileSync(join(ROOT, 'ios/photobooth4u/SpinArmViewController.swift'), 'utf8');
    for (const expectedSel of [
      'didTapClose', 'didChangeLens', 'didTapAeAfLock', 'didTapCalibrate', 'didTapRecord',
      'didTapLock', 'didTapPairQR', 'didTapQuickLook', 'didTapSettings', 'didTapCloseSettings',
      'didTapPickOverlayPhotos', 'didTapPickOverlayFiles', 'didTapClearOverlay',
      'didTapPickMusic', 'didTapClearMusic', 'didChangeOperatingMode', 'didChangeAspect',
      'didChangeSaTrigger', 'didChangeSaStopMode', 'didChangeSaFps', 'didToggleSkipShare',
      'didSlideThreshold', 'didToggleSavePhotos', 'didTapManualUrl', 'didTapRetryPending',
      'didTapCopyStationUrl', 'didTapOpenStationSafari', 'didTapCloseStationModal'
    ]) {
      assert.match(iosArm, new RegExp(`#selector\\(${expectedSel}\\)`), `iOS SpinArm missing button selector ${expectedSel}`);
    }

    const iosGate = readFileSync(join(ROOT, 'ios/spinarm/SpinArmGateViewController.swift'), 'utf8');
    for (const expectedSel of ['didTapSuffixChip', 'didTapActivate', 'didTapOpenActiveCamera', 'didTapDeskCompanion', 'didTapDeactivate']) {
      assert.match(iosGate, new RegExp(`#selector\\(${expectedSel}\\)`), `iOS Gate missing button selector ${expectedSel}`);
    }

    const iosShare = readFileSync(join(ROOT, 'ios/photobooth4u/SpinQuickShareViewController.swift'), 'utf8');
    for (const expectedSel of ['didTapCopyShareLink', 'didTapMute', 'didTapAirDrop', 'didTapWhatsApp', 'didTapSendEmail', 'didTapDone']) {
      assert.match(iosShare, new RegExp(`#selector\\(${expectedSel}`), `iOS QuickShare missing button selector ${expectedSel}`);
    }

    // Verify key Android buttons & handlers exist
    const andGate = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/SpinArmGateActivity.kt'), 'utf8');
    assert.match(andGate, /submitActivation\(\)/);
    assert.match(andGate, /confirmDeactivate\(\)/);
    assert.match(andGate, /openSpinArmCamera\(standaloneAllowed = false/);
    assert.match(andGate, /"-360"/);

    const andArm = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/SpinArmActivity.kt'), 'utf8');
    for (const token of [
      'startCalibration()', 'beginRecording("manual")', 'stopRecording("manual")',
      'openStationModal()', 'promptPairMethod()', 'launchQrScanner()', 'promptManualUrl()',
      'overlayPickerLauncher.launch("image/*")', 'musicPickerLauncher.launch("audio/*")',
      'cycleMotionPreset()', 'cycleColorLook()', 'setMode(true)', 'setMode(false)',
      'setStandaloneStop("follow"', 'setTargetFps(60)', 'setTargetFps(120)', 'processNextUploadIfNeeded()'
    ]) {
      assert.ok(andArm.includes(token), `Android SpinArm missing wired button action: ${token}`);
    }

    const andShare = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/SpinQuickShareActivity.kt'), 'utf8');
    for (const token of ['openAndroidShareSheet()', 'sendWhatsApp()', 'sendEmail()', 'linkCopyBtn', 'ClipboardManager']) {
      assert.ok(andShare.includes(token), `Android QuickShare missing wired action: ${token}`);
    }
    console.log(`   Verified ${iosActionsChecked} iOS @objc selectors + all Android HUD/Settings/Gate/QuickShare handlers`);
  });

  // =========================================================================
  // 2. SIMULATE URL NORMALIZATION (TYPING WITH & WITHOUT http://)
  // =========================================================================
  await step('Simulate manual Laptop Desk URL typing (with and without http://)', () => {
    const normLikeMobile = (raw) => {
      let s = String(raw || '').trim();
      if (!s) return null;
      if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
      const m = /^(https?:\/\/[^/\s]+\/send\/[A-Za-z0-9]+)/.exec(s);
      return m ? m[1] : null;
    };
    assert.equal(normLikeMobile('http://192.168.1.25:47777/send/AbC123456'), 'http://192.168.1.25:47777/send/AbC123456');
    assert.equal(normLikeMobile('192.168.1.25:47777/send/AbC123456'), 'http://192.168.1.25:47777/send/AbC123456');
    assert.equal(normLikeMobile('  192.168.1.25:47777/send/AbC123456/  '), 'http://192.168.1.25:47777/send/AbC123456');
    assert.equal(normLikeMobile('http://192.168.1.25:47777/wrong'), null);
  });

  // =========================================================================
  // 3. GENERATE REAL TRANSPARENT PNG OVERLAY + REAL 60FPS TEST 360 VIDEO
  // =========================================================================
  const overlayPngPath = join(workDir, 'wedding-overlay-1080x1920.png');
  const rawClipPath = join(workDir, 'raw-arm-spin-60fps.mp4');

  await step('Create real transparent RGBA 1080x1920 PNG overlay & 60fps test spin video', () => {
    assert.ok(existsSync(FFMPEG), `FFmpeg missing at ${FFMPEG}`);
    const pyOverlay = `
from PIL import Image, ImageDraw
W, H = 1080, 1920
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# Thick vermilion red outer border (#C93D27, fully opaque) leaving transparent center cutout
bw = 48
d.rectangle((0, 0, W - 1, bw), fill=(0xC9, 0x3D, 0x27, 255))
d.rectangle((0, H - 180, W - 1, H - 1), fill=(0xC9, 0x3D, 0x27, 255))
d.rectangle((0, 0, bw, H - 1), fill=(0xC9, 0x3D, 0x27, 255))
d.rectangle((W - bw, 0, W - 1, H - 1), fill=(0xC9, 0x3D, 0x27, 255))
# Warm cream inner trim line
d.rectangle((bw + 8, bw + 8, W - bw - 8, H - 188), outline=(0xF5, 0xF1, 0xEA, 255), width=8)
img.save(${JSON.stringify(overlayPngPath)}, 'PNG')
assert img.getpixel((W // 2, H // 2)) == (0, 0, 0, 0), 'Center must be fully transparent'
assert img.getpixel((20, 20)) == (0xC9, 0x3D, 0x27, 255), 'Border must be opaque vermilion'
`;
    execFileSync('python', ['-c', pyOverlay], { stdio: 'pipe' });

    // Generate a real 3-second 60fps portrait MP4 with moving motion bar + bright-cyan center (#1890FF)
    // so H.264 output is >20KB (passes spinList 10KB minimum) and center pixel is cleanly verifiable.
    execFileSync(FFMPEG, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=60:d=3',
      '-vf', 'drawbox=x=200:y=460:w=320:h=360:color=#1890FF@1.0:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', rawClipPath
    ], { stdio: 'pipe' });
    assert.ok(statSync(rawClipPath).size > 15000, 'Generated MP4 clip should be >15KB');
  });

  // =========================================================================
  // 4. CONNECTED-TO-LAPTOP 360 DESK START-TO-END SIMULATION
  // =========================================================================
  PHOTOS = await import('../desktop/lib/photos.mjs');
  const SPIN = await import('../desktop/lib/spin.mjs');

  let sharePort = 0;
  let sendBase = '';
  let editedRel = '';
  let sharedInfo = null;

  await step('Boot real Desktop Local Share Server & pair Arm Cam phone via /hello + /arm-state', async () => {
    PHOTOS.initPhotos({ root: photosRootDir, dataDir });
    SPIN.configure({ buildDir: join(ROOT, 'desktop', 'build'), temp: spinTempDir });
    sharePort = await PHOTOS.startShareServer();
    assert.ok(sharePort > 0, 'Desktop share server must bind a port');

    // Use loopback equivalent of spinSendUrl()
    const rawPreview = PHOTOS.spinPreviewBase();
    assert.match(rawPreview, /^http:\/\/127\.0\.0\.1:\d+\/send\/[A-Za-z0-9]+$/);
    sendBase = rawPreview;

    // 4a. Laptop configures Arm settings & queues a remote Start command
    PHOTOS.spinSendCfgSet({
      laptop: 'Studio Laptop',
      guide: { spinSec: 8, spins: 1, recordSec: 8, trigger: 'Auto gyro', note: 'Hold steady!' },
      choices: { look: true, music: false, speed: true, text: true, gif: true },
      speeds: [{ key: 'ramp', title: 'Speed Ramp' }, { key: 'slow', title: 'Slow-Mo' }],
      arm: { trigger: 'arm', stopMode: 'follow', fixedSec: 8, tailSec: 1.5, maxSec: 30, cooldownSec: 4, fps: 60 }
    });
    const cmdRes = PHOTOS.spinArmCmdPush('start');
    assert.equal(cmdRes.ok, true);

    // 4b. Phone pairs via GET /send/<token>/hello?r=1 (same call as SpinArmViewController.swift)
    const helloRes = await fetch(`${sendBase}/hello?r=1`);
    assert.equal(helloRes.status, 200);
    const helloJson = await helloRes.json();
    assert.equal(helloJson.ok, true);
    assert.equal(helloJson.kind, 'laptop');

    // 4c. Phone sends heartbeat POST /send/<token>/arm-state and receives config + remote 'start' cmd
    const hb1 = await fetch(`${sendBase}/arm-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device: 'iPhone 15 Pro Max',
        state: 'idle',
        gyroDps: 1.8,
        thresholdDps: 25,
        battery: 92,
        fps: 60,
        recSec: 0,
        uploadPct: 0,
        lens: '0.5×'
      })
    });
    assert.equal(hb1.status, 200);
    const hb1Json = await hb1.json();
    assert.equal(hb1Json.ok, true);
    assert.equal(hb1Json.config.laptop, 'Studio Laptop');
    assert.equal(hb1Json.config.arm.fps, 60);
    assert.ok(hb1Json.cmds.some((c) => c.cmd === 'start'), 'Phone must receive queued start command from Laptop Desk');

    // 4d. Phone enters recording state while arm spins at 88 deg/s
    const hb2 = await fetch(`${sendBase}/arm-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'iPhone 15 Pro Max', state: 'recording', gyroDps: 88.4, fps: 60, recSec: 2.4, lens: '0.5×' })
    });
    assert.equal(hb2.status, 200);
    const liveArm = PHOTOS.spinArmStateNow();
    assert.equal(liveArm.connected, true);
    assert.equal(liveArm.state, 'recording');
    assert.equal(liveArm.gyroDps, 88.4);
  });

  await step('Upload recorded 60fps MP4 clip from Arm Cam to Laptop 360 Desk inbox', async () => {
    const clipBytes = readFileSync(rawClipPath);
    const upRes = await fetch(`${sendBase}/upload?name=${encodeURIComponent('spin_001.mp4')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: clipBytes
    });
    assert.equal(upRes.status, 200);
    const upJson = await upRes.json();
    assert.equal(upJson.ok, true);
    assert.equal(upJson.name, 'spin_001.mp4');

    const inbox = PHOTOS.spinList({ minAgeMs: 0 });
    assert.ok(inbox.some((f) => f.name === 'spin_001.mp4'), 'Uploaded clip must appear in Laptop 360 inbox');
  });

  await step('Render clip on Laptop 360 Desk WITH transparent PNG overlay + Speed Ramp & pixel-verify frame', async () => {
    const ovBytes = readFileSync(overlayPngPath);
    const ovToken = SPIN.saveOverlay(ovBytes);
    assert.ok(ovToken, 'saveOverlay must return a valid overlay filename');
    const ovPath = SPIN.overlayPath(ovToken);
    assert.ok(ovPath && existsSync(ovPath));

    const inputPath = join(PHOTOS.spinDirNow(), 'spin_001.mp4');
    const outDir = PHOTOS.spinEditedDir();
    const { id } = SPIN.enqueue({
      inputPath,
      outDir,
      label: 'Glam',
      overlay: ovPath,
      options: { speed: 'ramp', orientation: 'portrait', quality: 720, audio: 'none', zoom: false, flash: false }
    });

    let info = null;
    for (let i = 0; i < 120; i++) {
      info = SPIN.jobInfo(id);
      if (info && (info.state === 'done' || info.state === 'error')) break;
      await sleep(250);
    }
    assert.equal(info?.state, 'done', `FFmpeg render failed: ${info?.error}`);
    editedRel = info.out;
    const editedFull = join(outDir, editedRel.replace(/^edited\//, ''));
    const probed = await SPIN.probe(editedFull);
    assert.equal(probed.width, 720);
    assert.equal(probed.height, 1280);
    assert.ok(probed.duration > 2.0, `Expected ramped video duration >2s, got ${probed.duration}`);

    // Extract middle frame and pixel-verify BOTH PNG overlay border AND transparent center cutout!
    const framePng = join(workDir, 'rendered-frame.png');
    execFileSync(FFMPEG, ['-hide_banner', '-y', '-ss', '1.0', '-i', editedFull, '-vframes', '1', framePng], { stdio: 'pipe' });
    const pyVerify = `
from PIL import Image
im = Image.open(${JSON.stringify(framePng)}).convert('RGB')
w, h = im.size
# Border pixel (10, 10) should be vermilion red (#C93D27 -> ~201,61,39 after H.264 YUV420p)
br = im.getpixel((10, 10))
assert br[0] > 170 and br[1] < 90 and br[2] < 75, f'Expected red PNG overlay at border, got {br}'
# Center pixel (w//2, h//2) should show the bright cyan-blue video (#1890FF -> low R, high B) proving alpha cutout worked!
ct = im.getpixel((w // 2, h // 2))
assert ct[2] > 200 and ct[0] < 70, f'Expected transparent center showing blue video, got {ct}'
print(f'PIXEL_OK border={br} center={ct}')
`;
    const pxOut = execFileSync('python', ['-c', pyVerify], { encoding: 'utf8' }).trim();
    console.log('   ' + pxOut);
  });

  await step('Publish rendered 360 video to Event & Sharing Station and verify direct download', async () => {
    sharedInfo = PHOTOS.spinShare(editedRel, 'Anna and Mark Wedding', null, '360_001.mp4', 'Glam Gold');
    assert.equal(sharedInfo.ok, true);
    const [slug, fname] = sharedInfo.fileId.split('/');

    // Verify Sharing Station JSON feed returns the 360 video
    const listRes = await fetch(`http://127.0.0.1:${sharePort}/station/${slug}/list`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.ok, true);
    assert.equal(listJson.files.length, 1);
    assert.equal(listJson.files[0].kind, 'video');
    assert.equal(listJson.files[0].name, fname);

    // Simulate guest scanning QR -> opening guest page + tapping Download
    const pageRes = await fetch(`http://127.0.0.1:${sharePort}${listJson.files[0].pageUrl}`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    assert.match(pageHtml, /360_001\.mp4/);

    const dlRes = await fetch(`http://127.0.0.1:${sharePort}${listJson.files[0].url}?dl=1`);
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get('content-type') || '', /video\/mp4/);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.ok(dlBuf.length > 10000, 'Downloaded 360 video bytes must be non-empty');
  });

  // =========================================================================
  // 5. LIVE HEADLESS CHROME DOM SIMULATION — EVERY BUTTON & TYPING INPUT
  // =========================================================================
  browser = await launchHeadlessBrowser();

  async function simulateSharingStationDom(url, label, { withOnlineMail = false, onTriggerArrival = null } = {}) {
    const page = await browser.openPage(url);
    try {
      // Intercept window.open & navigation checks so WhatsApp/mailto clicks can be asserted cleanly
      await page.evalJs(`
        window.__openedTargets = [];
        window.open = function(u) { window.__openedTargets.push(String(u)); return null; };
      `);

      if (onTriggerArrival) {
        // Verify Standby screen appears before first video arrives
        const standbyVisible = await page.evalJs(`getComputedStyle(document.getElementById('standbyView')).display !== 'none'`);
        assert.equal(standbyVisible, true, `${label}: Standby screen should be visible before video arrives`);
        await onTriggerArrival();
        // Wait for polling (1.6s interval) to pick up the new 360 video and auto-pop modal
        let opened = false;
        for (let i = 0; i < 30; i++) {
          opened = await page.evalJs(`document.getElementById('modal').classList.contains('open')`);
          if (opened) break;
          await sleep(200);
        }
        assert.equal(opened, true, `${label}: Modal must auto-open when new 360 video arrives`);
      } else {
        // Wait for fresh clip auto-open on initial load
        let opened = false;
        for (let i = 0; i < 30; i++) {
          opened = await page.evalJs(`document.getElementById('modal').classList.contains('open')`);
          if (opened) break;
          await sleep(150);
        }
        assert.equal(opened, true, `${label}: Modal must auto-open for fresh 360 video`);
      }

      // 1) Verify video player + Save button + QR code image generated!
      const modalState = await page.evalJs(`({
        hasVideo: !!document.querySelector('#mMedia video'),
        dlText: document.getElementById('mDl').textContent,
        dlHref: document.getElementById('mDl').getAttribute('href'),
        qrSrc: document.getElementById('mQr').getAttribute('src') || '',
        linkVal: document.getElementById('mLinkInput').value,
        waVisible: getComputedStyle(document.getElementById('mOnlineShare')).display !== 'none'
      })`);
      assert.equal(modalState.hasVideo, true, `${label}: <video> must be rendered in modal`);
      assert.equal(modalState.dlText, 'Save Video', `${label}: Download button text`);
      assert.match(modalState.qrSrc, /^data:image\//, `${label}: QR code data URL must be rendered`);
      assert.ok(modalState.linkVal.includes('/e/') || modalState.linkVal.includes('photobooth4u'), `${label}: Typable link must be populated, got ${modalState.linkVal}`);
      assert.equal(modalState.waVisible, true, `${label}: WhatsApp & Email typing box must be visible`);

      // 2) Click Copy Link button -> verify feedback
      await page.evalJs(`document.getElementById('mCopyLink').click()`);
      await sleep(150);
      const copyMsg = await page.evalJs(`document.getElementById('mShareMsg').textContent`);
      assert.match(copyMsg, /copied|Select/i, `${label}: Copy button should show feedback, got "${copyMsg}"`);

      // 3) Type invalid WhatsApp -> verify validation error, then type valid PH number 09171234567 -> verify 639171234567!
      await page.evalJs(`
        var w = document.getElementById('mWaInput');
        w.focus(); w.value = '123';
        document.getElementById('mWaBtn').click();
      `);
      const badWaMsg = await page.evalJs(`document.getElementById('mShareMsg').textContent`);
      assert.match(badWaMsg, /valid WhatsApp/i, `${label}: Invalid phone must show error`);

      // Verify auto-close timer pauses while input is focused!
      const tBefore = await page.evalJs(`document.getElementById('mSec').textContent`);
      await sleep(1250);
      const tAfter = await page.evalJs(`document.getElementById('mSec').textContent`);
      assert.equal(tAfter, tBefore, `${label}: Auto-close timer must pause while typing in WhatsApp input`);

      await page.evalJs(`
        var w = document.getElementById('mWaInput');
        w.value = '09171234567';
        w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      `);
      await sleep(100);
      const waOk = await page.evalJs(`({ msg: document.getElementById('mShareMsg').textContent, targets: window.__openedTargets })`);
      assert.match(waOk.msg, /Opening WhatsApp/i, `${label}: Valid WhatsApp should trigger send`);
      assert.ok(waOk.targets.some((u) => u.includes('639171234567')), `${label}: WhatsApp URL must normalize 09171234567 -> 639171234567`);

      // 4) Type invalid email -> verify validation error, then type valid email!
      await page.evalJs(`
        var m = document.getElementById('mMailInput');
        m.focus(); m.value = 'not-an-email';
        document.getElementById('mMailBtn').click();
      `);
      const badMailMsg = await page.evalJs(`document.getElementById('mShareMsg').textContent`);
      assert.match(badMailMsg, /valid email/i, `${label}: Invalid email must show error`);

      if (withOnlineMail) {
        await page.evalJs(`
          var m = document.getElementById('mMailInput');
          m.value = 'guest@example.com';
          m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        `);
        await sleep(350);
        const mailOk = await page.evalJs(`document.getElementById('mShareMsg').textContent`);
        assert.match(mailOk, /Email sent to guest@example\.com/i, `${label}: Online email POST /station-mail must succeed, got "${mailOk}"`);
      }

      // 5) Click Done (Next guest) -> modal closes cleanly
      await page.evalJs(`document.getElementById('mDone').click()`);
      const closed = await page.evalJs(`!document.getElementById('modal').classList.contains('open')`);
      assert.equal(closed, true, `${label}: Done button must close modal`);

      // 6) Click Gallery toggle button -> verify grid + 360 Videos filter tab + card re-opens modal + Standby toggle!
      await page.evalJs(`document.getElementById('stModeBtn').click()`);
      const galleryCheck = await page.evalJs(`({
        btnText: document.getElementById('stModeBtn').textContent,
        gridVis: getComputedStyle(document.getElementById('stGrid')).display,
        cardCount: document.querySelectorAll('#stGrid .card').length
      })`);
      assert.equal(galleryCheck.btnText, 'Standby');
      assert.equal(galleryCheck.gridVis, 'grid');
      assert.equal(galleryCheck.cardCount, 1);

      // Click 'Prints' tab -> 0 items; click '360 Videos' tab -> 1 item; click card -> modal opens; click X -> closes!
      await page.evalJs(`document.querySelector('.tab[data-filter="photo"]').click()`);
      assert.equal(await page.evalJs(`document.querySelectorAll('#stGrid .card').length`), 0);
      await page.evalJs(`document.querySelector('.tab[data-filter="video"]').click()`);
      assert.equal(await page.evalJs(`document.querySelectorAll('#stGrid .card').length`), 1);
      await page.evalJs(`document.querySelector('#stGrid .card').click()`);
      assert.equal(await page.evalJs(`document.getElementById('modal').classList.contains('open')`), true);
      await page.evalJs(`document.getElementById('mClose').click()`);
      assert.equal(await page.evalJs(`!document.getElementById('modal').classList.contains('open')`), true);
      await page.evalJs(`document.getElementById('stModeBtn').click()`);
      assert.equal(await page.evalJs(`document.getElementById('stModeBtn').textContent`), 'Gallery');

      assert.equal(page.consoleErrors.length, 0, `${label}: JS runtime errors: ${page.consoleErrors.join('; ')}`);
    } finally {
      await page.close();
    }
  }

  // 5a. Simulate Desktop Connected-to-Laptop Sharing Station
  await step('Live Chrome DOM simulation: Connected-to-Laptop Sharing Station (scan QR + copy + type WhatsApp/Email + Gallery tabs)', async () => {
    await simulateSharingStationDom(`http://127.0.0.1:${sharePort}/station`, 'Desktop Sharing Station');
  });

  // 5b. Simulate Connected-to-Laptop Web Send Page (/send/<token>)
  await step('Live Chrome DOM simulation: Connected-to-Laptop Web Send Page (/send/<token>)', async () => {
    const page = await browser.openPage(sendBase);
    try {
      await sleep(500);
      const state = await page.evalJs(`({
        conn: document.getElementById('conn').textContent,
        guideVisible: !document.getElementById('guide').hidden,
        choicesVisible: !document.getElementById('choices').hidden,
        cdText: document.getElementById('cd').textContent
      })`);
      assert.match(state.conn, /Connected to Studio Laptop/);
      assert.equal(state.guideVisible, true);
      assert.equal(state.choicesVisible, true);

      // Click "Start the countdown on the laptop" button and verify laptop receives it
      await page.evalJs(`document.getElementById('cd').click()`);
      await sleep(300);
      const taken = PHOTOS.spinSendTake();
      assert.ok(taken.some((x) => x.type === 'cmd' && x.do === 'countdown'), 'Countdown button must queue command on laptop');
      assert.equal(page.consoleErrors.length, 0, `Send page JS errors: ${page.consoleErrors.join('; ')}`);
    } finally {
      await page.close();
    }
  });

  // 5c. Simulate BOTH iOS & Android Standalone Sharing Stations (opening BEFORE first clip arrives, then clip arrives + cloud email!)
  let mobileFiles = [];
  let mobileMailPayloads = [];
  const qrJs = readFileSync(join(ROOT, 'ios/photobooth4u/qr.js'), 'utf8');
  const iosStationTpl = readFileSync(join(ROOT, 'ios/photobooth4u/station.html'), 'utf8');
  const andStationTpl = readFileSync(join(ROOT, 'android/app/src/main/assets/share/station.html'), 'utf8');
  const editedVideoBytes = readFileSync(join(PHOTOS.spinEditedDir(), editedRel.replace(/^edited\//, '')));

  mobileStationServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/qr.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(qrJs);
      return;
    }
    if (u.pathname === '/ios-station') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(iosStationTpl.replace(/__TITLE__/g, 'Sharing Station').replace(/__SLUG__/g, ''));
      return;
    }
    if (u.pathname === '/android-station') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(andStationTpl.replace(/__TITLE__/g, 'Sharing Station').replace(/__SLUG__/g, ''));
      return;
    }
    if (u.pathname === '/station/list' || u.pathname === '/station/evt360/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        slug: mobileFiles.length ? 'evt360' : null,
        name: 'Anna & Mark 360',
        files: mobileFiles
      }));
      return;
    }
    if (u.pathname === '/station-mail' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        mobileMailPayloads.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (u.pathname === '/e/evt360/f/360_001.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(editedVideoBytes);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  await new Promise((r) => mobileStationServer.listen(0, '127.0.0.1', r));
  const mobPort = mobileStationServer.address().port;

  const pushNewMobileClip = () => {
    mobileFiles = [{
      name: '360_001.mp4',
      kind: 'video',
      url: '/e/evt360/f/360_001.mp4',
      thumbUrl: '/e/evt360/t/360_001.mp4',
      pageUrl: '/e/evt360/p/360_001.mp4',
      sessionUrl: '/e/evt360/s/360',
      onlineUrl: 'https://photobooth4u.netlify.app/g/folder123#file456',
      mtime: Date.now()
    }];
  };

  await step('Live Chrome DOM simulation: iOS Standalone Sharing Station (open BEFORE spin -> auto-pop -> scan QR + type WhatsApp/Email)', async () => {
    mobileFiles = [];
    mobileMailPayloads = [];
    await simulateSharingStationDom(`http://127.0.0.1:${mobPort}/ios-station`, 'iOS Standalone Station', {
      withOnlineMail: true,
      onTriggerArrival: async () => { await sleep(300); pushNewMobileClip(); }
    });
    assert.equal(mobileMailPayloads.length, 1);
    assert.equal(mobileMailPayloads[0].to, 'guest@example.com');
  });

  await step('Live Chrome DOM simulation: Android Standalone Sharing Station (empty SLUG -> auto-pop -> scan QR + type WhatsApp/Email)', async () => {
    mobileFiles = [];
    mobileMailPayloads = [];
    await simulateSharingStationDom(`http://127.0.0.1:${mobPort}/android-station`, 'Android Standalone Station', {
      withOnlineMail: true,
      onTriggerArrival: async () => { await sleep(300); pushNewMobileClip(); }
    });
    assert.equal(mobileMailPayloads.length, 1);
    assert.equal(mobileMailPayloads[0].to, 'guest@example.com');
  });

  // =========================================================================
  // 6. FULL SLOT-FREE -360 ACTIVATION / CHECK-IN / DEACTIVATE LIFECYCLE
  // =========================================================================
  await step('Simulate full -360 slot-free activation lifecycle (even with 1/1 booth slots full)', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.PB_LICENSE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const LIC = await import('../netlify/lib/license.mjs');
    const CORE = await import('../netlify/lib/core.mjs');

    const now = Date.now();
    const rec = {
      key: 'PBTEST360ABCD2',
      code: 'PB-TEST-360A-BCD2',
      label: 'Client 360 Test',
      status: 'active',
      lifetime: true,
      expiresAt: CORE.LIFETIME_EXP,
      maxDevices: 1,
      devices: [{ id: 'app:booth1', no: 1, at: now - 5000, kind: 'iPad app', app: { lid: '11112222333344445555', mid: 'IPD-MAIN-BOOTH-0001' } }],
      extras: { spin360: true }
    };

    // Normal booth activation should fail because 1/1 slot is full
    const fullCheck = LIC.activateOn(structuredClone(rec), { mid: 'IPD-PHONE-360-9999', name: 'iPhone 15 Pro Max', os: 'ios', ver: '1.0.0' }, now);
    assert.equal(fullCheck.status, 403, 'Regular activation must be blocked when 1/1 device slot is full');

    // -360 suffix activation parses cleanly and issues a valid Ed25519 spin360Only licence WITHOUT touching rec.devices!
    const parsed = LIC.parseSpin360Code('PB-TEST-360A-BCD2-360');
    assert.equal(parsed.isSpin360Suffix, true);
    assert.equal(CORE.normCode(parsed.baseCode), rec.key);
    assert.equal(CORE.extrasOf(rec).spin360, true);

    const issued = LIC.spin360CompanionLicence(rec.key, rec, { mid: 'IPD-PHONE-360-9999', name: 'iPhone 15 Pro Max', os: 'ios', ver: '1.0.0' }, now, false);
    const verified = LIC.readLicence(issued.licence);
    assert.ok(verified);
    assert.equal(verified.feat.spin360Only, true);
    assert.equal(verified.feat.extras.spin360, true);
    assert.equal(rec.devices.length, 1, 'Parent account must still have exactly 1/1 booth device occupied (0 slots added)');
  });

  console.log(`\nALL ${totalChecks} END-TO-END 360 ARM CAM & SHARING STATION SIMULATIONS PASSED!`);
} finally {
  if (browser) await browser.shutdown();
  if (mobileStationServer) await new Promise((r) => mobileStationServer.close(r));
  if (PHOTOS) PHOTOS.stopShareServer();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
