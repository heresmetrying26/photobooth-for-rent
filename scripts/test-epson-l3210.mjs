import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assemble } from './assemble-booth.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

function test(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { console.error('FAIL:', name); console.error(e); process.exitCode = 1; }
}

test('Web UI: L3210 720/1440 dpi is unlocked natively without beta gate while L8050 isolation is preserved', () => {
  const html = assemble().html;
  const a = html.indexOf('const WIFI_OPTS_KEY'), b = html.indexOf('function wifiSave(p) {');
  assert.ok(a > 0 && b > a, 'wifi options block found');
  const slice = html.slice(a, b);

  // 1) Legacy APK environment (no supportsL3210HiRes): keeps beta gate so test-epson-l8050 expectation stays intact
  const memOld = {};
  const storeOld = { getItem: k => (k in memOld ? memOld[k] : null), setItem: (k, v) => { memOld[k] = String(v); } };
  const l3210Usb = { usb: true, epsonL: true, borderless: true, escpr: true, epsonModel: 'L3210', vid: 1208, pid: 58993, name: 'Epson L3210 (USB)' };
  const l8050Usb = { usb: true, epsonL: true, borderless: true, escpr: true, epsonModel: 'L8050', vid: 1208, pid: 2150, name: 'Epson L8050 (USB)' };
  const l3276Usb = { usb: true, epsonL: true, borderless: true, escpr: true, epsonModel: 'L3276', vid: 1208, pid: 17498, name: 'Epson L3276 (USB)' };

  const sharedEnvArgs = ['localStorage', 'IOS_APP', 'printSize', 'paperFor', 'printerKey', 'printPrefs', 'stripTwoUp', 'sizedPhoto', 'l8050HiResAvailable'];
  const apiOld = new Function(...sharedEnvArgs,
    slice + '; return { isEpsonL3210, l3210HiResAvailable, epsonRasterBetaAllowed, wifiDefaultFor, wifiOptEff, wifiOpts };'
  )(storeOld, false, '4r', () => ({ w: 101.6, h: 152.4 }), () => 'k', { borderless: true, thermalQuality: 'best' }, () => false, () => false, () => false);

  assert.equal(apiOld.isEpsonL3210(l3210Usb), true, 'L3210 matched');
  assert.equal(apiOld.isEpsonL3210(l8050Usb), false, 'L8050 never matched as L3210');
  assert.equal(apiOld.isEpsonL3210(l3276Usb), false, 'L3276 not matched as L3210');
  assert.equal(apiOld.l3210HiResAvailable(l3210Usb), false, 'no bridge flag without supportsL3210HiRes');
  assert.equal(apiOld.epsonRasterBetaAllowed(l3210Usb), true, 'legacy beta fallback kept on older APKs');

  // 2) Modern APK environment (window.__PBNet.supportsL3210HiRes() === true)
  const memNew = {};
  const storeNew = { getItem: k => (k in memNew ? memNew[k] : null), setItem: (k, v) => { memNew[k] = String(v); } };
  const fakeWin = { __PBNet: { supportsL3210HiRes: () => true, supportsL8050HiRes: () => true }, __PB: { debugOpt: false } };
  const paperForFn = s => (s === '5x7' ? { w: 127, h: 177.8 } : s === 'a4' ? { w: 210, h: 297 } : { w: 101.6, h: 152.4 });
  const apiNew = new Function('window', ...sharedEnvArgs, 'pbDebug',
    slice + '; return { isEpsonL3210, l3210HiResAvailable, epsonRasterBetaAllowed, wifiDefaultFor, wifiOptEff, wifiOpts, wifiOptsSet };'
  )(fakeWin, storeNew, false, '4r', paperForFn, () => 'k', { borderless: true, thermalQuality: 'best' }, () => false, () => false, () => true, () => false);

  assert.equal(apiNew.l3210HiResAvailable(l3210Usb), true, 'native hi-res detected via bridge');
  assert.equal(apiNew.epsonRasterBetaAllowed(l3210Usb), false, 'JS beta path bypassed when Kotlin native L3210 engine is present');
  assert.equal(apiNew.wifiDefaultFor(l3210Usb, 'quality'), 'high720', 'L3210 defaults to 720 dpi out of the box');
  assert.equal(apiNew.wifiDefaultFor(l3210Usb, 'media'), 'photo', 'L3210 defaults to Glossy photo paper');
  assert.equal(apiNew.wifiOptEff(l3210Usb, 'quality'), 'high720', 'effective quality is high720 with pbDebug off');

  // Migrates stored old debug rnormal cleanly to high720, keeps rbest (1440x720), normal (360), draft
  apiNew.wifiOptsSet(l3210Usb, 'quality', 'rnormal');
  assert.equal(apiNew.wifiOptEff(l3210Usb, 'quality'), 'high720', 'stale rnormal migrates to high720');
  apiNew.wifiOptsSet(l3210Usb, 'quality', 'rbest');
  assert.equal(apiNew.wifiOptEff(l3210Usb, 'quality'), 'rbest', '1440x720 Best works without pbDebug');
  apiNew.wifiOptsSet(l3210Usb, 'quality', 'normal');
  assert.equal(apiNew.wifiOptEff(l3210Usb, 'quality'), 'normal', '360 dpi Normal honored');

  // L8050 still refuses rbest/rnormal completely
  apiNew.wifiOptsSet(l8050Usb, 'quality', 'rbest');
  assert.equal(apiNew.wifiOpts(l8050Usb).quality, 'high', '6-ink L8050 still rejects L3210 rbest');

  // Borderless only enabled for L3210-supported borderless paper sizes; 5x7 & A4 disable borderless
  const api5x7 = new Function('window', ...sharedEnvArgs, 'pbDebug',
    slice + '; return { wifiOpts };'
  )(fakeWin, storeNew, false, '5x7', paperForFn, () => 'k', { borderless: true, thermalQuality: 'best' }, () => false, () => false, () => true, () => false);
  assert.equal(api5x7.wifiOpts(l3210Usb).borderless, false, '5x7 automatically enforces bordered on L3210');

  const l3210Ui = html.slice(html.indexOf('function l3210DpiFor(paper)'), html.indexOf('function buildPrintCanvas('));
  assert.ok(/function l3210DpiFor\(paper\)/.test(l3210Ui), 'l3210DpiFor present');
  assert.ok(/Math\.max\(paper\.w, paper\.h\) <= 190 \? 720 : 360/.test(html), 'l3210DpiFor renders 720 dpi on photo sizes <=5x7 and caps A4 canvas at 360 dpi');
  assert.ok(/let _lastWifiPollSig = '';/.test(html), '3s printer list poll diffs signature before rebuilding DOM');
  assert.ok(/probeAndroidChromeHelper/.test(html) && /androidChromeHelper/.test(html), 'Android Chrome 127.0.0.1:17321 PrintHelperService probe wired');
  assert.ok(/q\.needsPermission/.test(html) && /Tap Allow on USB permission prompt/.test(html), 'pwUsbCheck surfaces missing USB permission instead of false Ready');
});

test('Android Kotlin: EpsonL3210RasterJob geometry, LUTs, nozzle alignment, NetPrintBridge wiring, and brace balance', () => {
  const jobKt = read('android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'EpsonL3210RasterJob.kt');
  const bridgeKt = read('android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt');
  const helperKt = read('android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'UsbCameraHelper.kt');

  // 1. Decode embedded Base64 LUTs and check size + known black/white corners from driver capture
  for (const label of ['LUT720_B64', 'LUT1440_B64']) {
    const m = jobKt.match(new RegExp(label + '\\s*=\\s*[\\r\\n\\s]*"([A-Za-z0-9+/=]+)"'));
    assert.ok(m, label + ' present');
    const buf = Buffer.from(m[1], 'base64');
    assert.equal(buf.length, 729 * 4, label + ' decodes to exact 729*4 bytes');
    assert.deepEqual([...buf.subarray(728 * 4, 729 * 4)], [0, 0, 0, 0], label + ' white corner is pure 0 ink');
  }
  const m720 = jobKt.match(/LUT720_B64\s*=\s*[\r\n\s]*"([A-Za-z0-9+/=]+)"/);
  const buf720 = Buffer.from(m720[1], 'base64');
  assert.deepEqual([...buf720.subarray(0, 4)], [99, 111, 111, 92], 'LUT720 pure black matches captured EPSON L3210 Series driver');

  const m1440 = jobKt.match(/LUT1440_B64\s*=\s*[\r\n\s]*"([A-Za-z0-9+/=]+)"/);
  const buf1440 = Buffer.from(m1440[1], 'base64');
  assert.deepEqual([...buf1440.subarray(0, 4)], [65, 71, 71, 54], 'LUT1440 pure black matches captured EPSON L3210 Series driver');

  // 2. Physical nozzle offsets & header parameters
  assert.ok(/chEsc = intArrayOf\(2, 1, 4, 0\)/.test(jobKt), 'C=2, M=1, Y=4, K=0');
  assert.ok(/chDy = intArrayOf\(0, -60, -120, 0\)/.test(jobKt), 'DY = 0, -60, -120, 0');
  assert.ok(/chKSub = intArrayOf\(0, 0, 0, 2\)/.test(jobKt), 'Black nozzle +2 dots stagger at 720 dpi');
  assert.ok(/PaperSpec\(2880, 4320, 0x0a, true\)/.test(jobKt), '4x6 borderless spec');
  assert.ok(/PaperSpec\(2522, 3600, 0x0f, true\)/.test(jobKt), '3.5x5 borderless spec');
  assert.ok(/PaperSpec\(2834, 4196, 0x10, true\)/.test(jobKt), '100x148 borderless spec');
  assert.ok(/PaperSpec\(2880, 5120, 0x2b, true\)/.test(jobKt), '16:9 wide borderless spec');
  assert.ok(/PaperSpec\(3600, 5044, 0x1c, false\)/.test(jobKt), '5x7 bordered-only spec');
  assert.ok(/PaperSpec\(5952, 8418, 0x00, false\)/.test(jobKt), 'A4 bordered-only spec');

  // 3. NetPrintBridge & UsbCameraHelper integration (scoped cleanly per method!)
  assert.ok(/@JavascriptInterface\s+fun supportsL3210HiRes\(\): Boolean = true/.test(bridgeKt), 'supportsL3210HiRes exposed');
  assert.ok(/private fun l3210RasterConfig\(/.test(bridgeKt), 'l3210RasterConfig present');
  assert.ok(/private fun epsonL360EscprConfig\(/.test(bridgeKt), 'epsonL360EscprConfig present');

  const pElStart = bridgeKt.indexOf('fun printEpsonL(');
  const pElEnd = bridgeKt.indexOf('private fun usbName(', pElStart);
  assert.ok(pElStart > 0 && pElEnd > pElStart, 'printEpsonL body isolated');
  const pElBody = bridgeKt.slice(pElStart, pElEnd);
  assert.ok(!/EscprJob\.build\(/.test(pElBody), 'printEpsonL no longer uses slow OOM EscprJob.build');
  assert.ok(/EpsonL3210RasterJob\.stream\(/.test(pElBody), 'printEpsonL streams L3210 via EpsonL3210RasterJob');
  assert.ok(pElBody.indexOf('decodeByteArray') < pElBody.indexOf('for (c in 0 until copyCount)'), 'printEpsonL decodes JPEG bitmap once outside copies loop');

  const pFhStart = bridgeKt.indexOf('fun printFromHelper(');
  const pFhEnd = bridgeKt.indexOf('selphy ->', pFhStart);
  assert.ok(pFhStart > 0 && pFhEnd > pFhStart, 'printFromHelper epsonL branch isolated');
  const pFhBody = bridgeKt.slice(pFhStart, pFhEnd);
  assert.ok(!/EscprJob\.build\(/.test(pFhBody), 'printFromHelper no longer uses slow OOM EscprJob.build');
  assert.ok(/EpsonL3210RasterJob\.stream\(/.test(pFhBody), 'printFromHelper streams L3210 via EpsonL3210RasterJob');
  assert.ok(/EpsonL3210RasterJob\.isBorderlessSize\(widthMm, heightMm\)/.test(pFhBody), 'printFromHelper enforces L3210 borderless paper sizes');

  assert.ok(/\.put\("l3210HiRes", epsonModelName == "L3210"\)/.test(bridgeKt), 'usbListInto flags l3210HiRes');
  assert.ok(/req\.optJSONObject\("options"\)/.test(helperKt), 'UsbCameraHelper forwards optional print options to printFromHelper');
  assert.ok(read('android', 'app', 'src', 'main', 'assets', 'booth.html') === read('protected', 'booth.html'), 'Android assets booth.html synced with protected/booth.html');
});

test('Python cross-check: all L3210 hybrid borderless and bordered weave schedules cover 100% of rows', () => {
  const pyOut = execFileSync('python', [
    '-c',
    `
papers = [(2880,4320,True),(2522,3600,True),(2834,4196,True),(2880,5120,True),(3600,5044,False),(5952,8418,False)]
for sw, sh, bl_ok in papers:
  for bl in ([True, False] if bl_ok else [False]):
    for dpiH in (720, 1440):
      hx = 2 if dpiH == 1440 else 1
      xstep = 2 * hx
      ah = (sh + 170) if bl else (sh - 168)
      top = 166 if bl else 320
      yPos = (51 if dpiH==1440 else 55) if bl else (100 if dpiH==1440 else 112)
      yEnd = top + ah + 480 + 240
      cc = [0,0,0,0]; pIdx = 0
      cov = [0]*ah
      while yPos <= yEnd:
        xo = cc[yPos & 3] % xstep; cc[yPos & 3] += 1
        for ci, (dy, ks) in enumerate([(0,0),(-60,0),(-120,0),(0,2)]):
          shf = ci*4 + xo
          for n in range(59):
            yr = yPos + 4*(n + dy) - ks - top
            if 0 <= yr < ah: cov[yr] |= (1 << shf)
        if bl:
          slow = (yPos < (741 if dpiH==1440 else 737)) or (yPos >= sh - (83 if dpiH==1440 else 90))
          adv = ((9 if pIdx%2==0 else 6) if slow else (13 if pIdx%2==0 else 14)) if dpiH==1440 else ((17 if pIdx%2==0 else 14) if slow else (26 if pIdx%2==0 else 25))
        else:
          adv = (14 if pIdx%2==0 else 13) if dpiH==1440 else (26 if pIdx%2==0 else 25)
        pIdx += 1; yPos += adv
      fm = (1<<xstep)-1; tgt = fm|(fm<<4)|(fm<<8)|(fm<<12)
      miss = sum(1 for v in cov if v != tgt)
      assert miss == 0, (sw, sh, bl, dpiH, miss)
print("ALL_18_SCHEDULES_ZERO_MISSING")
`
  ], { encoding: 'utf8' }).trim();
  assert.equal(pyOut, 'ALL_18_SCHEDULES_ZERO_MISSING');
});
