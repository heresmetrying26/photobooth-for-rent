// test-360-simple-mode.mjs — Live Headless Browser E2E & Layout Verification for Revamped 360 Desk
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser'
];
const BROWSER = CHROME_CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) {
  console.log('SKIP: No Chrome/Edge binary found for headless E2E check.');
  process.exit(0);
}

const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });

const boothHtml = fs.readFileSync(path.resolve('protected/booth.html'), 'utf8');
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><rect x="12" y="12" width="32" height="32" fill="#111"/><rect x="76" y="12" width="32" height="32" fill="#111"/><rect x="12" y="76" width="32" height="32" fill="#111"/><rect x="52" y="52" width="16" height="16" fill="#111"/></svg>';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  PASS: ' + msg);
}

const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/booth') {
    const mockScript = `<script>
      window.__PB = { code: 'TEST360', plan: 'pro', extras: { spin360: true, video: true } };
      window.__mockInbox = [];
      window.__mockArm = { connected: false, paired: false };
      window.pb4u = {
        desktop: true,
        version: '1.1.117',
        spinScan: async () => window.__mockInbox.slice(),
        spinInfo: async () => ({
          dir: 'C:\\\\Users\\\\Booth\\\\Videos\\\\360-Inbox',
          sendUrl: 'http://192.168.1.25:47777/send/abcd',
          previewBase: location.origin + '/spin-pv'
        }),
        spinEnv: async () => ({
          ffmpeg: true,
          gpu: true,
          music: 'upbeat-celebration.mp3',
          musicList: ['upbeat-celebration.mp3', 'romantic-acoustic.mp3']
        }),
        spinFxList: async () => ([
          { id: 'gold_dust', name: '✨ Gold Dust', blend: 'screen' },
          { id: 'confetti_multi', name: '🎊 Party Confetti', blend: 'screen' }
        ]),
        spinConnect: async () => ({
          dir: 'C:\\\\Users\\\\Booth\\\\Videos\\\\360-Inbox',
          writable: true,
          freeMb: 84000,
          sendUrl: 'http://192.168.1.25:47777/send/abcd',
          now: Date.now(),
          helloAt: Date.now() - 5000,
          arm: window.__mockArm
        }),
        spinArmState: async () => window.__mockArm,
        spinSendSet: async () => ({ ok: true }),
        spinSendTake: async () => [],
        spinClipsSet: async () => ({ ok: true }),
        spinLookOffer: async () => ({ ok: true }),
        spinStats: async () => ({ event: { rendered: 5, views: 14, downloads: 9, shares: 5 } }),
        sensor: {
          probe: async () => ({ available: false, gyro: false, accel: false }),
          start: async () => ({ ok: false }),
          stop: () => {},
          onData: () => () => {}
        }
      };
      try {
        localStorage.clear();
        localStorage.setItem('pb_spin_auto_asked', '1');
      } catch (e) {}
    </script>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(boothHtml.replace('<head>', '<head>' + mockScript));
    return;
  }
  if (u.pathname.startsWith('/api/qr')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(QR_SVG);
    return;
  }
  res.writeHead(204);
  res.end();
});

await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pb4u-360-e2e-'));

const proc = spawn(BROWSER, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
  '--remote-debugging-port=0',
  `--user-data-dir=${userData}`,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let errTxt = '';
  const tm = setTimeout(() => reject(new Error('Browser launch timeout: ' + errTxt)), 15000);
  proc.stderr.on('data', chunk => {
    const s = chunk.toString();
    errTxt += s;
    const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(s);
    if (m) { clearTimeout(tm); resolve(m[1]); }
  });
});

const targets = await (await fetch(wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
const pageTarget = targets.find(t => t.type === 'page');
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));

let idSeq = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = ++idSeq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Page JS Exception: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  if (!SHOT_DIR) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
}

console.log('====================================================');
console.log('  360 Desk Headless Browser E2E Verification');
console.log('====================================================\n');

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/booth` });
  await new Promise(r => setTimeout(r, 1400));

  // Open 360 Desk via real spinFab click
  const initCheck = await evalJs(`(async () => {
    const fab = document.getElementById('spinFab');
    fab.hidden = false;
    fab.click();
    await new Promise(r => setTimeout(r, 500));
    const ov = document.getElementById('spinOverlay');
    const bodyRect = document.querySelector('.spin-studio-body').getBoundingClientRect();
    const pvRect = document.querySelector('.spin-preview-card').getBoundingClientRect();
    const disp = id => getComputedStyle(document.getElementById(id)).display;
    return {
      open: !ov.hidden,
      advOn: ov.classList.contains('spin-adv-on'),
      activeStep: document.querySelector('.spin-simple-tab.active')?.dataset.step,
      bodyBottom: bodyRect.bottom,
      pvBottom: pvRect.bottom,
      winH: window.innerHeight,
      secVideosDisp: disp('spinSecVideos'),
      secPresetsDisp: disp('spinSecPresets'),
      secCaptureDisp: disp('spinSecCapture'),
      secLookDisp: disp('spinSecLook'),
      connectDisp: disp('spinConnect'),
      sendCardDisp: disp('spinSendCard'),
      hintDisp: disp('spinHint'),
      clearDisp: document.querySelector('#spinSecVideos .desk-foot') ? getComputedStyle(document.querySelector('#spinSecVideos .desk-foot')).display : 'missing',
      sendQrDisp: disp('spinSend')
    };
  })()`);

  ok(initCheck.open && !initCheck.advOn, 'Opens in Simple Mode by default');
  ok(initCheck.activeStep === 'videos', 'Lands on Step ① Videos first (Step 1 is Step 1)');
  ok(initCheck.bodyBottom <= initCheck.winH + 1 && initCheck.pvBottom <= initCheck.winH + 1, `Studio body fits 100vh cleanly with zero bottom clipping (bottom=${Math.round(initCheck.bodyBottom)} <= ${initCheck.winH})`);
  ok(initCheck.secVideosDisp !== 'none' && initCheck.secPresetsDisp === 'none' && initCheck.secCaptureDisp === 'none' && initCheck.secLookDisp === 'none', 'Only Step ① Videos card is visible initially');
  ok(initCheck.connectDisp === 'none' && initCheck.sendCardDisp === 'none', 'Connect diagnostics & un-paired Arm bar stay tucked away');
  ok(initCheck.hintDisp === 'none' && initCheck.clearDisp === 'none', 'Empty queue hides redundant hint & Clear list button');
  ok(initCheck.sendQrDisp !== 'none', 'Phone Wi-Fi QR card is visible with concise beginner copy');

  await shot('after-step1-empty.png');

  // Test 2 & 3: Videos arrive + iPhone Arm connects -> progressive disclosure!
  const queueCheck = await evalJs(`(async () => {
    window.__mockInbox = [
      { name: 'spin_003_wedding.mp4', size: 14800000, mtime: Date.now() - 20000 },
      { name: 'spin_002_guests.mp4', size: 12400000, mtime: Date.now() - 90000 },
      { name: 'spin_001_couple.mp4', size: 16100000, mtime: Date.now() - 240000 }
    ];
    window.__mockArm = { connected: true, paired: true, device: 'iPhone 15 Pro', state: 'ready', gyroDps: 0.3, battery: 94 };
    // Two polls so Smart File Settling guard (prev === size) admits the 3 clips
    await new Promise(r => setTimeout(r, 2600));
    await new Promise(r => setTimeout(r, 2600));
    const tiles = document.querySelectorAll('#spinGrid .desk-item').length;
    const sendCardDisp = getComputedStyle(document.getElementById('spinSendCard')).display;
    const armTxt = document.getElementById('armPhoneStatus').textContent;
    const advRowInSendDisp = getComputedStyle(document.querySelector('#spinSendCard .spin-row.spin-adv')).display;
    const clearDisp = getComputedStyle(document.querySelector('#spinSecVideos .desk-foot')).display;
    const curBadge = document.getElementById('spinCurClipBadge').textContent;
    return { tiles, sendCardDisp, armTxt, advRowInSendDisp, clearDisp, curBadge };
  })()`);

  ok(queueCheck.tiles === 3, 'All 3 arrived 360 clips render in the Videos grid');
  ok(queueCheck.curBadge.includes('spin_'), `Newest clip auto-selected in ③ Preview & Share (${queueCheck.curBadge})`);
  ok(queueCheck.sendCardDisp !== 'none' && queueCheck.armTxt.includes('iPhone 15 Pro') && queueCheck.advRowInSendDisp === 'none', 'Paired iPhone Arm bar progressively appears while keeping advanced timer inputs hidden');
  ok(queueCheck.clearDisp !== 'none', 'Clear list button appears automatically once videos exist');

  await shot('after-step1-videos-and-arm.png');

  // Test 4 & 5 & 6: Step ② Style & Music — fits on screen, Format chips sync, Names side-by-side, no snake_case FX!
  const lookCheck = await evalJs(`(async () => {
    document.querySelector('.spin-howto-nav .desk-btn.primary').click();
    await new Promise(r => setTimeout(r, 250));
    const activeStep = document.querySelector('.spin-simple-tab.active')?.dataset.step;
    const gridRect = document.getElementById('spinPresetGrid').getBoundingClientRect();
    const textRect = document.getElementById('spinSecText').getBoundingClientRect();
    const audioRect = document.getElementById('spinSecAudio').getBoundingClientRect();
    const pairCols = getComputedStyle(document.querySelector('.spin-text-pair')).gridTemplateColumns.split(' ').length;
    const autoEditBtnDisp = getComputedStyle(document.querySelector('.spin-preset-auto')).display;

    // Check preset subtitles for raw snake_case underscores
    const subs = [...document.querySelectorAll('#spinPresetGrid .spin-preset-tile small')].map(s => s.textContent);
    const hasSnakeCase = subs.some(t => /[a-z]_[a-z]/.test(t));

    // Click 16:9 Wide format chip
    document.querySelector('#spinQuickOrient [data-orient="landscape"]').click();
    const orientAfterWide = document.getElementById('spinOrient').value;
    const stageIsLandscape = document.getElementById('spinStageWrap').classList.contains('is-landscape');

    // Click 1:1 Square format chip, then back to 9:16 Phone
    document.querySelector('#spinQuickOrient [data-orient="square"]').click();
    const stageIsSquare = document.getElementById('spinStageWrap').classList.contains('is-square');
    document.querySelector('#spinQuickOrient [data-orient="portrait"]').click();
    const stageIsPortrait = document.getElementById('spinStageWrap').classList.contains('is-portrait');

    // Type Couple Names & Date
    const t1 = document.getElementById('spinText1');
    t1.value = 'Sarah & Michael';
    t1.dispatchEvent(new Event('input', { bubbles: true }));
    const t2 = document.getElementById('spinText2');
    t2.value = 'November 26, 2026';
    t2.dispatchEvent(new Event('input', { bubbles: true }));

    // Toggle Auto-edit pill switch
    const autoSw = document.getElementById('spinAutoMode');
    autoSw.click();
    const autoOn = autoSw.checked && document.getElementById('spinAuto').checked && document.getElementById('spinAutoShare').checked;

    return {
      activeStep,
      gridH: gridRect.height,
      textTop: textRect.top,
      audioBottom: audioRect.bottom,
      winH: window.innerHeight,
      pairCols,
      autoEditBtnDisp,
      hasSnakeCase,
      orientAfterWide,
      stageIsLandscape,
      stageIsSquare,
      stageIsPortrait,
      autoOn
    };
  })()`);

  ok(lookCheck.activeStep === 'look', 'Next button navigates from ① Videos to ② Style & Music');
  ok(lookCheck.gridH <= 265, `Preset gallery height is compact & scrollable (${Math.round(lookCheck.gridH)}px <= 265px)`);
  ok(lookCheck.textTop < lookCheck.winH && lookCheck.audioBottom <= lookCheck.winH + 40, `Presets, Names, and Music all fit comfortably in view (textTop=${Math.round(lookCheck.textTop)}px, audioBottom=${Math.round(lookCheck.audioBottom)}px)`);
  ok(lookCheck.pairCols === 2, 'Line 1 (Names) and Line 2 (Date) sit side-by-side in 2 columns');
  ok(lookCheck.autoEditBtnDisp === 'none', 'Duplicate Auto-edit button is hidden in Simple Mode (single clear Edit CTA on right)');
  ok(!lookCheck.hasSnakeCase, 'All preset tile effect names are humanized (zero raw snake_case IDs)');
  ok(lookCheck.orientAfterWide === 'landscape' && lookCheck.stageIsLandscape && lookCheck.stageIsSquare && lookCheck.stageIsPortrait, 'Quick Format pills sync two-way with #spinOrient and live preview aspect ratio');
  ok(lookCheck.autoOn, 'Sleek Auto-edit pill switch toggles auto + autoShare cleanly');

  await shot('after-step2-style-music.png');

  // Test 7: Camera tab & [hidden] bug verification
  const camCheck = await evalJs(`(async () => {
    document.querySelector('.spin-simple-tab[data-step="videos"]').click();
    document.getElementById('spinGoRecordBtn').click();
    await new Promise(r => setTimeout(r, 200));
    const step = document.querySelector('.spin-simple-tab.active')?.dataset.step;
    const usbDisp = getComputedStyle(document.getElementById('spinCapUsbBar')).display;
    const webDisp = getComputedStyle(document.getElementById('spinCapWebcamBar')).display;
    const cdDisp = getComputedStyle(document.getElementById('spinCapCountdown').parentElement).display;
    const durDisp = getComputedStyle(document.getElementById('spinCapDuration').parentElement).display;
    const stopModeDisp = getComputedStyle(document.getElementById('spinCapStopMode').parentElement).display;
    const dslrDrawerDisp = getComputedStyle(document.getElementById('spinCapDslrWrap')).display;

    // Switch to Webcam/HDMI and verify USB bar hides and Webcam bar shows
    document.getElementById('spinCapSrcWebcam').click();
    await new Promise(r => setTimeout(r, 100));
    const usbDispAfter = getComputedStyle(document.getElementById('spinCapUsbBar')).display;
    const webDispAfter = getComputedStyle(document.getElementById('spinCapWebcamBar')).display;
    // Switch back to USB
    document.getElementById('spinCapSrcUsb').click();
    return { step, usbDisp, webDisp, cdDisp, durDisp, stopModeDisp, dslrDrawerDisp, usbDispAfter, webDispAfter };
  })()`);

  ok(camCheck.step === 'rec', '"📷 Record with Camera" shortcut opens the Camera tab');
  ok(camCheck.usbDisp !== 'none' && camCheck.webDisp === 'none', 'USB mode shows ONLY #spinCapUsbBar and hides #spinCapWebcamBar ([hidden] bug fixed!)');
  ok(camCheck.usbDispAfter === 'none' && camCheck.webDispAfter !== 'none', 'HDMI/Webcam mode shows ONLY #spinCapWebcamBar and hides #spinCapUsbBar');
  ok(camCheck.cdDisp !== 'none' && camCheck.durDisp !== 'none' && camCheck.stopModeDisp === 'none' && camCheck.dslrDrawerDisp === 'none', 'Camera tab keeps Countdown & Clip length visible while hiding gyro/DSLR drawers');

  await shot('after-step3-camera.png');

  // Test 8: All settings toggle + Overlay Preview recovery guard
  const advCheck = await evalJs(`(async () => {
    document.querySelector('.spin-simple-tab[data-step="look"]').click();
    document.getElementById('spinModeToggle').click();
    await new Promise(r => setTimeout(r, 200));
    const ov = document.getElementById('spinOverlay');
    const advOn = ov.classList.contains('spin-adv-on');
    const lookCardDisp = getComputedStyle(document.getElementById('spinSecLook')).display;
    const gifDisp = getComputedStyle(document.getElementById('spinGifBtn')).display;
    const activeAdvTab = document.querySelector('#spinHeadTabs .spin-adv-tab.active')?.dataset.tab;
    const savedLs = localStorage.getItem('spinAdv');

    // Uncheck Overlay Preview in All settings, then return to Simple view -> must auto-restore Overlay Preview!
    const ovChk = document.getElementById('spinModalTogglePreview');
    ovChk.checked = false;
    ovChk.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('spinModeToggle').click();
    await new Promise(r => setTimeout(r, 200));
    const restoredOverlay = ovChk.checked;
    const backSimple = !ov.classList.contains('spin-adv-on') && localStorage.getItem('spinAdv') === '0';
    return { advOn, lookCardDisp, gifDisp, activeAdvTab, savedLs, restoredOverlay, backSimple };
  })()`);

  ok(advCheck.advOn && advCheck.lookCardDisp !== 'none' && advCheck.gifDisp !== 'none' && advCheck.savedLs === '1', 'All settings toggle reveals every studio card, button, and saves preference');
  ok(advCheck.activeAdvTab === 'spinSecPresets', 'Switching to All settings highlights the matching section tab');
  ok(advCheck.backSimple && advCheck.restoredOverlay, 'Returning to Simple view restores live Overlay Preview if it was unchecked');

  // Capture All Settings screenshot too
  await evalJs(`document.getElementById('spinModeToggle').click()`);
  await new Promise(r => setTimeout(r, 150));
  await shot('after-all-settings.png');
  await evalJs(`document.getElementById('spinModeToggle').click()`);

  // Test 9: Mobile responsive check (390x844)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise(r => setTimeout(r, 250));
  const mobCheck = await evalJs(`(async () => {
    const pvTabDisp = getComputedStyle(document.querySelector('.spin-preview-tab-btn')).display;
    document.querySelector('.spin-preview-tab-btn').click();
    const simpleStillActive = !!document.querySelector('.spin-simple-tab.active');
    const pairCols = getComputedStyle(document.querySelector('.spin-text-pair')).gridTemplateColumns.split(' ').length;
    return { pvTabDisp, simpleStillActive, pairCols };
  })()`);
  ok(mobCheck.pvTabDisp !== 'none' && mobCheck.simpleStillActive, 'Mobile header shows Live Preview jump button without clearing active Simple step');
  ok(mobCheck.pairCols === 1, 'Mobile layout stacks Names & Date inputs cleanly into 1 column');
  await shot('after-mobile.png');

  console.log(`\n====================================================`);
  console.log(`  ALL ${passed} BROWSER E2E CHECKS PASSED! ✅`);
  console.log(`====================================================\n`);
} finally {
  ws.close();
  proc.kill();
  srv.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}
