// Comprehensive verification for all printer phases:
// - Android PrintBridge MediaSizes (JPN_HAGAKI, ISO_A5, ISO_A6, NA_GOVT_LETTER, PWG 5x7 & 3.5x5)
// - DNP & Citizen USB matching, sheet geometry, and 8-inch (CX-02W/DS80/DS820) + 4.5-inch (CZ-01/QW410) guards
// - Epson / Canon / Brother USB & Wi-Fi Direct safety guards (no L130 ESC/P2 hijack, no LPD-only Brother trap, no USB flag leak)
// - iPad printEscpr immediate error reply
// - Byte-level runtime execution of bt-thermal.mjs (serpentine Atkinson, highlight roll-off, EscPosEncoder, CatPrinterEncoder)
// - Byte-identical parity between protected/src/bt-thermal.mjs and public/src/bt-thermal.mjs, plus ReceiptRaster.kt parity
// Run: node desktop/test/test-printer-phases.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ippPrintDirect, waitIppIdle, pickMediaName, parseIppGrouped } from '../lib/netprinters.mjs';
import { initHelper, handleHelper, stopHelper } from '../lib/helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const asyncTests = [];
function test(name, fn) {
  asyncTests.push({ name, fn });
}

function checkBalancedBraces(relPath) {
  const s = rd(relPath);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
  }
  assert.equal(depth, 0, relPath + ' unbalanced braces: depth=' + depth);
}

test('All modified Kotlin and Swift printer files have balanced braces', () => {
  for (const f of [
    'android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt',
    'android/app/src/main/java/com/photobooth4u/booth/BTBridge.kt',
    'android/app/src/main/java/com/photobooth4u/booth/PrintBridge.kt',
    'android/app/src/main/java/com/photobooth4u/booth/DnpJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/CanonJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/CanonSelphyJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/EscP2Job.kt',
    'android/app/src/main/java/com/photobooth4u/booth/EscprJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/ReceiptRaster.kt',
    'android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt',
    'ios/photobooth4u/ViewController.swift',
    'ios/photobooth4u/BtPrinterBridge.swift'
  ]) checkBalancedBraces(f);
});

test('PrintBridge maps postcard / A5 / A6 / 8x10 / 5x7 / 3.5x5 cleanly without overlap', () => {
  const kt = rd('android/app/src/main/java/com/photobooth4u/booth/PrintBridge.kt');
  for (const c of ['JPN_HAGAKI', 'ISO_A5', 'ISO_A6', 'NA_GOVT_LETTER', 'NA_INDEX_4X6', 'ISO_A4', 'NA_LETTER']) {
    assert.ok(kt.includes('MediaSize.' + c), 'missing ' + c);
  }
  assert.ok(kt.includes('"na_5x7_5x7in"') && kt.includes('"oe_photo-l_3.5x5in"'), 'PWG 5R and 3R IDs present');
});

test('DnpJob: Citizen CX/CY/CZ matched, Citizen usbName prefix, and CX-02W / CZ-01 unsupported guards', () => {
  const kt = rd('android/app/src/main/java/com/photobooth4u/booth/DnpJob.kt');
  const netKt = rd('android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt');
  const rx = /NAME_RX = Regex\("\(\?i\)([^"]+)"\)/.exec(kt);
  assert.ok(rx, 'NAME_RX found');
  const re = new RegExp(rx[1].replace(/\\\\/g, '\\'), 'i');
  for (const n of ['DS-RX1', 'DS620', 'DS-620A', 'DS40', 'DS820', 'QW410', 'CX-02', 'CX-02W', 'CY-02', 'CZ-01']) {
    assert.ok(re.test(n), 'matches ' + n);
  }
  assert.ok(!re.test('EPSON L8050'));
  assert.ok(kt.includes('m.endsWith("W")') && kt.includes('m.startsWith("CZ")'), 'CX-02W (8-inch) and CZ-01 (4.5-inch) guarded in unsupportedReason');
  assert.ok(netKt.includes('"Citizen $it"'), 'Citizen models named Citizen rather than DNP');
  assert.ok(/SHEET_4X6 = Sheet\("02", 1920, 1240, 1844/.test(kt), '4x6 sheet 1920x1240, 1844 printed');
  assert.ok(/SHEET_6X8 = Sheet\("04", 1920, 2436, 1844/.test(kt), '6x8 sheet');
  assert.ok(/SHEET_5X7 = Sheet\("03", 1920, 2138, 1548/.test(kt), '5x7 sheet');
});

test('Epson / Canon / Brother tables: no unverified PIDs, L130 not forced to ESC/P2, Brother LPD-only excluded', () => {
  const kt = rd('android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt');
  const epsonBlock = kt.slice(kt.indexOf('object EpsonLModels'), kt.indexOf('object EpsonEscp2Models'));
  assert.ok(!/0x1186|0x009A|0x0867/.test(epsonBlock), 'unverified Epson PIDs not hardcoded');
  const escp2Block = kt.slice(kt.indexOf('object EpsonEscp2Models'), kt.indexOf('object CanonGModels'));
  assert.ok(!/L130|L210|L220/.test(escp2Block.replace(/\/\/[^\n]*/g, '')), 'L130/L210/L220 not hijacked by EpsonEscp2Models');
  const canonBlock = kt.slice(kt.indexOf('object CanonGModels'), kt.indexOf('private object BrotherUsbModels'));
  assert.ok(!/G620|G650|G570|G6020|G7020/.test(canonBlock.replace(/\/\/[^\n]*/g, '')), '6-ink G models not forced onto 4-ink IVEC');
  const filterBlock = kt.slice(kt.indexOf('fun list(): String'), kt.indexOf('.sortedWith('));
  assert.ok(!filterBlock.includes('192.168.118.1') && !filterBlock.includes('192.168.0.1'), 'LPD-only filter is strictly Epson');
});

test('iPad: printEscpr answers immediately with a clear error instead of hanging', () => {
  const sw = rd('ios/photobooth4u/ViewController.swift');
  assert.ok(/printEscpr: function\(jobId\)/.test(sw) && /__PBNetResult/.test(sw));
});

test('Thermal raster: protected/src/bt-thermal.mjs === public/src/bt-thermal.mjs, ReceiptRaster.kt parity, and byte-level encode', () => {
  const protBt = rd('protected/src/bt-thermal.mjs');
  const pubBt = rd('public/src/bt-thermal.mjs');
  assert.equal(protBt, pubBt, 'protected/src/bt-thermal.mjs and public/src/bt-thermal.mjs must stay byte-identical');

  const rrKt = rd('android/app/src/main/java/com/photobooth4u/booth/ReceiptRaster.kt');
  assert.ok(rrKt.includes('toneLift = true') && rrKt.includes('val lift = if (w <= 384) 0.78f else 0.82f'), 'ReceiptRaster.kt applies bilateral denoise + lift on both best and normal');

  // Execute bt-thermal.mjs in a minimal canvas mock and verify ESC/POS + Cat raster bytes
  function makeCanvas(w, h, fillLum = 255) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fillLum; data[i * 4 + 1] = fillLum; data[i * 4 + 2] = fillLum; data[i * 4 + 3] = 255;
    }
    return {
      width: w, height: h, _data: data,
      getContext() {
        return {
          fillStyle: '#fff', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
          fillRect() {},
          drawImage(src, _x, _y, dw, dh) {
            for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
              const sx = Math.min(src.width - 1, Math.floor(x * src.width / dw));
              const sy = Math.min(src.height - 1, Math.floor(y * src.height / dh));
              const si = (sy * src.width + sx) * 4, di = (y * dw + x) * 4;
              data[di] = src._data[si]; data[di + 1] = src._data[si + 1]; data[di + 2] = src._data[si + 2]; data[di + 3] = 255;
            }
          },
          getImageData(_x, _y, iw, ih) { return { width: iw, height: ih, data }; },
          putImageData(id) { data.set(id.data); }
        };
      }
    };
  }
  const sandbox = {
    window: {}, navigator: {},
    document: { createElement: () => makeCanvas(1, 1) }
  };
  sandbox.document.createElement = () => {
    let w = 1, h = 1, c = makeCanvas(1, 1);
    return {
      get width() { return w; }, set width(v) { w = v; c = makeCanvas(w, h); },
      get height() { return h; }, set height(v) { h = v; c = makeCanvas(w, h); },
      get _data() { return c._data; },
      getContext: () => c.getContext()
    };
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(pubBt, sandbox);
  const T = sandbox._btThermal;
  assert.ok(T && T.toReceiptCanvas && T.EscPosEncoder && T.CatPrinterEncoder, '_btThermal exports present');

  // Near-white wall (lum=246) must roll off to pure white (zero pepper dots) in both 'best' and 'normal'
  const wall = makeCanvas(64, 32, 246);
  for (const q of ['best', 'normal']) {
    const mono = T.toReceiptCanvas(wall, 384, 0, q);
    assert.equal(mono.width, 384);
    let blackDots = 0;
    for (let i = 0; i < mono._data.length; i += 4) if (mono._data[i] === 0) blackDots++;
    assert.equal(blackDots, 0, 'highlight roll-off keeps lum=246 pure white on ' + q);
  }

  // Gradient frame encodes valid GS v 0 ESC/POS raster on 80mm (576 dots = 72 bytes/row) and 58mm (384 dots = 48 bytes/row)
  const grad = makeCanvas(96, 24, 128);
  for (let i = 0; i < 96 * 24; i++) { const v = i % 256; grad._data[i * 4] = grad._data[i * 4 + 1] = grad._data[i * 4 + 2] = v; }
  const m80 = T.toReceiptCanvas(grad, 576, 0, 'best');
  const esc = new T.EscPosEncoder(576).initialize().image(m80, 64).cut().getBuffer();
  assert.equal(esc[0], 0x1b); assert.equal(esc[1], 0x40); // ESC @
  assert.equal(esc[2], 0x1d); assert.equal(esc[3], 0x76); assert.equal(esc[4], 0x30); // GS v 0
  assert.equal(esc[6], 72); assert.equal(esc[7], 0); // 576 / 8 = 72 bytes per row

  const m58 = T.toReceiptCanvas(grad, 384, 0, 'normal');
  const cat = new T.CatPrinterEncoder().encode(m58, 2).getBuffer();
  assert.ok(cat.length > 100 && cat[0] === 0x51 && cat[1] === 0x78, 'CatPrinterEncoder emits 0x51 0x78 frames');

  // toReceiptGray (Windows/Mac Print Helper non-receipt thermal path) rolls near-white wall to pure 255 and sets _pbToneDone
  assert.equal(typeof T.toReceiptGray, 'function', 'toReceiptGray exported');
  const gWall = T.toReceiptGray(wall, 576, 'best');
  assert.equal(gWall.width, 576);
  assert.equal(gWall._pbToneDone, true);
  let nonWhite = 0;
  for (let i = 0; i < gWall._data.length; i += 4) if (gWall._data[i] !== 255) nonWhite++;
  assert.equal(nonWhite, 0, 'toReceiptGray rolls lum=246 backdrop to pure 255 white');
});

test('ArcticBreeze / Rongta RP30: grainy-texture fixes across ditherRegion, Windows/Mac Print Helper, Print Station, and Android LAN /print', () => {
  const boothSrc = rd('protected/src/booth.src.html');
  const rrKt = rd('android/app/src/main/java/com/photobooth4u/booth/ReceiptRaster.kt');
  const camKt = rd('android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt');
  const netKt = rd('android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt');
  const stHtml = rd('public/print-station/index.html');

  // 1. ditherRegion protects rolled-off highlights (>= 242) and deep shadows (<= 12) from sharpen/clarity halos
  const ditherBlock = boothSrc.slice(boothSrc.indexOf('function ditherRegion('), boothSrc.indexOf('var receiptCustomNote'));
  assert.ok(ditherBlock.includes('if (tj <= 12 || tj >= 242)'), 'ditherRegion skips sharpen/clarity on highlights >= 242 and shadows <= 12');

  // 2. printViaHelper & sendToStation pre-tone non-receipt thermal layouts via toReceiptGray and pass receipt { quality, band, toneDone }
  assert.ok(boothSrc.includes('Tbt.toReceiptGray(c, receiptW, receiptQ)'), 'printViaHelper applies toReceiptGray to non-receipt thermal pages');
  assert.ok(boothSrc.includes('receipt: paper.receipt ? { quality: receiptQ, band: receiptW <= 384 ? 32 : 256, toneDone: true } : undefined'), 'printViaHelper passes receipt tuning + toneDone to /print');
  assert.ok(stHtml.includes('receipt: isRec ? { quality: \'best\', band: (paper.w && paper.w <= 55) ? 32 : 256, toneDone: !!paper.toneDone } : undefined'), 'print-station passes receipt tuning to /print');

  // 3. Android LAN /print server defaults missing receipt JSON to Serpentine Atkinson + blank-row bands (never hard threshold)
  assert.ok(camKt.includes('val receiptObj = req.optJSONObject("receipt") ?: if (fit == "width")'), 'UsbCameraHelper synthesizes Atkinson receipt options when receipt JSON omitted');
  assert.ok(rrKt.includes('if (o == null) return DEFAULT_THERMAL'), 'ReceiptRaster.fromJson(null) defaults to Serpentine Atkinson instead of THRESHOLD');
  assert.ok(rrKt.includes('if ((opt.toneLift || opt.sharpen) && !opt.toneDone) sharpenAndLift'), 'ReceiptRaster skips double gamma lift when toneDone=true');
  assert.ok(rrKt.includes('if (targetW > 384)'), 'ReceiptRaster suppresses GS V cutter command on 58mm rolls');
  assert.ok(netKt.includes('isKnown58mmName(usbName(d))') && netKt.includes('isKnown58mmName(netMatch.name)'), 'printFromHelper clamps 58mm width & 32-row bands');
});

test('VOZY G80/V80 (80mm) & VOZY P50 (58mm): wired USB, LAN :9100, and Bluetooth clamping + cutter safety', async () => {
  const netKt = rd('android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt');
  const btKt = rd('android/app/src/main/java/com/photobooth4u/booth/BTBridge.kt');
  const btSw = rd('ios/photobooth4u/BtPrinterBridge.swift');
  const boothSrc = rd('protected/src/booth.src.html');
  const pubBt = rd('public/src/bt-thermal.mjs');

  // 1. Android & iPad Bluetooth discovery prefixes cover VOZY, VOXY, G80, V80, P50
  for (const pfx of ['"VOZY"', '"VOXY"', '"G80"', '"V80"', '"P50"']) {
    assert.ok(btKt.includes(pfx), 'BTBridge.kt missing prefix ' + pfx);
    assert.ok(btSw.includes(pfx), 'BtPrinterBridge.swift missing prefix ' + pfx);
  }

  // 2. Android USB VozyReceiptModels guards UsbDevice.productName against SecurityException and recognizes V80/G80/P50/MP210
  const vozyStart = netKt.indexOf('private object VozyReceiptModels');
  const vozyBlock = netKt.slice(vozyStart, netKt.indexOf('init {', vozyStart));
  assert.ok(vozyBlock.includes('try { (d.productName ?: "").uppercase() } catch'), 'VozyReceiptModels guards productName before USB permission');
  assert.ok(vozyBlock.includes('"VOZY V80"') && vozyBlock.includes('"VOZY G80"') && vozyBlock.includes('"VOZY P50"'));
  assert.ok(netKt.includes('vo[zx]y|(?<![a-z0-9])(?:g80|v80|p50|mp[- ]?210)(?![0-9])'), 'receiptNameRx matches VOZY/VOXY G80/V80/P50');

  // 3. Wired USB / Wi-Fi :9100 in booth.src.html clamps 58mm printers (VOZY P50) to 384 dots, paced USB, and no cutter
  assert.ok(
    boothSrc.includes('const dotW = ((paper.receipt && paper.w <= 55) || (T.isKnown58mmPrinter && T.isKnown58mmPrinter(p && p.name))) ? 384 : 576;'),
    'printViaWifiRaw clamps dotW=384 for known 58mm printers even when 4R or 80mm paper is selected'
  );

  // 4. Runtime execution of BtThermal for VOXY V80 (80mm -> 576 dots + GS V cut) vs VOXY P50 (58mm -> 384 dots + NO GS V cut even when '80mm' requested)
  const sentPayloads = [];
  function makeCanvas(w, h) {
    const data = new Uint8ClampedArray(w * h * 4).fill(200);
    return {
      width: w, height: h, _data: data,
      getContext: () => ({
        fillStyle: '#fff', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
        fillRect() {}, drawImage() {},
        getImageData: () => ({ width: w, height: h, data }),
        putImageData(id) { data.set(id.data); }
      })
    };
  }
  let nextBridgeName = 'VOXY P50';
  const sandbox = {
    window: {}, navigator: {},
    btoa: (bin) => Buffer.from(bin, 'binary').toString('base64'),
    __BTBridge: {
      connect: () => JSON.stringify({ ok: true, name: nextBridgeName }),
      write: (b64) => { sentPayloads.push(Buffer.from(b64, 'base64')); return JSON.stringify({ ok: true }); }
    },
    document: {
      createElement: () => {
        let w = 1, h = 1, c = makeCanvas(1, 1);
        return {
          get width() { return w; }, set width(v) { w = v; c = makeCanvas(w, h); },
          get height() { return h; }, set height(v) { h = v; c = makeCanvas(w, h); },
          get _data() { return c._data; }, getContext: () => c.getContext()
        };
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(pubBt, sandbox);
  const T = sandbox._btThermal;

  for (const n of ['VOZY P50', 'VOXY P50', 'Vozy 50', 'VOZY P50 (USB)', 'VOZY_P50_BLE', 'P50-1234', 'VOZY MP210', 'XP-58IIH', 'POS-5890K']) {
    assert.equal(T.isKnown58mmPrinter(n), true, 'must detect 58mm printer: ' + n);
  }
  for (const n of ['VOZY G80', 'VOZY V80', 'VOXY V80', 'VOZY G80 (USB)', 'Xprinter XP-T80Q', 'Canon SELPHY CP1500', 'Canon SELPHY CP1300', 'Epson L8050', 'HP DeskJet 5820']) {
    assert.equal(T.isKnown58mmPrinter(n), false, 'must NOT misclassify as 58mm: ' + n);
  }

  function hasCutCmd(buf) {
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] === 0x1d && buf[i + 1] === 0x56 && (buf[i + 2] === 0x41 || buf[i + 2] === 0x42)) return true;
    }
    return false;
  }

  // Test A: VOXY P50 connected on first print while caller passes '80mm' -> must clamp to 384 dots (48 B/row) & NO cutter bytes
  sentPayloads.length = 0;
  nextBridgeName = 'VOXY P50';
  await T.printViaBluetooth(makeCanvas(400, 16), '80mm', { cut: true, quality: 'normal' });
  const p50Bytes = Buffer.concat(sentPayloads);
  assert.equal(p50Bytes[0], 0x1b); assert.equal(p50Bytes[1], 0x40);
  assert.equal(p50Bytes[6], 48, 'VOXY P50 forced to 48 bytes/row (384 dots) even when 80mm passed');
  assert.equal(hasCutCmd(p50Bytes), false, 'VOXY P50 never receives GS V cutter command');

  // Test B: VOXY V80 connected on '80mm' -> must keep 576 dots (72 B/row) & emit GS V cutter command
  T.btPrinter.disconnect();
  sentPayloads.length = 0;
  nextBridgeName = 'VOXY V80';
  await T.printViaBluetooth(makeCanvas(400, 16), '80mm', { cut: true, quality: 'normal' });
  const v80Bytes = Buffer.concat(sentPayloads);
  assert.equal(v80Bytes[6], 72, 'VOXY V80 uses 72 bytes/row (576 dots)');
  assert.equal(hasCutCmd(v80Bytes), true, 'VOXY V80 receives GS V auto-cutter command');
});

test('Canon SELPHY CP1500 & CP1300 (wired USB + wireless IPP): model IDs, 0x0507 busy retry, and multi-sheet idle polling', async () => {
  const selphyKt = rd('android/app/src/main/java/com/photobooth4u/booth/CanonSelphyJob.kt');
  const netKt = rd('android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt');
  const iosSw = rd('ios/photobooth4u/ViewController.swift');

  // 1. Android USB immediate PID -> model mapping for CP1500 (0x3302) & CP1300 (0x32db), plus IPP-over-USB isSelphy check
  assert.ok(selphyKt.includes('0x3302 to "CP1500"') && selphyKt.includes('0x32db to "CP1300"'), 'CanonSelphyJob.kt maps CP1500 & CP1300 PIDs');
  assert.ok(netKt.includes('CanonSelphyJob.modelName(d.vendorId, d.productId)?.let { return "Canon SELPHY $it" }'), 'usbName names SELPHY before USB permission');
  assert.ok(netKt.includes('e.usbDev?.let { usbIsSelphy(it) } == true'), 'isSelphy detects CP1500 on IPP-over-USB via usbDev');
  assert.ok(netKt.includes('val maxBusyRetries = if (selphy) 24 else 8') && netKt.includes('r.http == 200 && r.ipp == 0x0507 && busyRetries < maxBusyRetries'), 'Android sendIppJob retries 0x0507 server-error-busy (24x SELPHY, 8x inkjet)');
  assert.ok(netKt.includes('awaitSelphyIppIdle(e, jpath, jid)'), 'Android printIpp waits between multi-copy SELPHY sheets');

  // 2. iPad direct IPP SELPHY 100x148mm matching + 0x0507 busy retry + waitJobIdle
  assert.ok(iosSw.includes('static func selphyMedia(') && iosSw.includes('"jpn_hagaki_100x148mm"'), 'iPad IppNet matches 4x6 to jpn_hagaki_100x148mm');
  assert.ok(iosSw.includes('let maxBusyTries = selphy ? 24 : 8') && iosSw.includes('r.http == 200 && r.ipp == 0x0507 && busyTries < maxBusyTries'), 'iPad IppNet retries 0x0507 server-error-busy (24x SELPHY, 8x inkjet)');
  assert.ok(iosSw.includes('IppNet.waitJobIdle('), 'iPad sendIppPrint waits between multi-copy SELPHY sheets');

  // 3. Fallback media name when SELPHY omits media-supported on Wi-Fi Direct
  assert.equal(pickMediaName({ model: 'Canon SELPHY CP1300', mediaReady: [], mediaSupported: [] }, 101.6, 152.4), 'jpn_hagaki_100x148mm');
  assert.equal(pickMediaName({ model: 'Canon SELPHY CP1500', mediaReady: [], mediaSupported: [] }, 54, 86), 'om_card_54x86mm');
  assert.equal(pickMediaName({ model: 'Canon SELPHY CP1500', mediaReady: [], mediaSupported: [] }, 89, 119), 'oe_photo-l_3.5x5in');

  // 4. Live mock IPP server impersonating Canon SELPHY CP1500:
  //    - Returns 0x0507 (server-error-busy) twice on Print-Job, then 0x0000 with job-id=77 on try 3
  //    - Verifies ippPrintDirect keeps exact 100x148mm zero-margin borderless attributes across busy retries
  //    - Returns job-state=5 (processing) twice on Get-Job-Attributes, then job-state=9 (completed), verifying waitIppIdle
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const str = (s) => { const v = Buffer.from(s, 'utf8'); return Buffer.concat([u16(v.length), v]); };
  const attr = (tag, name, val) => Buffer.concat([Buffer.from([tag]), str(name), str(val)]);
  const intAttr = (tag, name, v) => Buffer.concat([Buffer.from([tag]), str(name), u16(4), u32(v)]);

  let printCalls = 0;
  let jobPolls = 0;
  const printBodies = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBuf = Buffer.concat(chunks);
      const op = reqBuf.readUInt16BE(2);
      res.writeHead(200, { 'content-type': 'application/ipp' });
      if (op === 0x000b) {
        // Get-Printer-Attributes
        res.end(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01]),
          attr(0x47, 'attributes-charset', 'utf-8'),
          attr(0x48, 'attributes-natural-language', 'en'),
          Buffer.from([0x04]),
          attr(0x41, 'printer-make-and-model', 'Canon SELPHY CP1500'),
          attr(0x49, 'document-format-supported', 'image/jpeg'),
          attr(0x44, 'media-ready', 'jpn_hagaki_100x148mm'),
          attr(0x44, 'media-supported', 'jpn_hagaki_100x148mm'),
          attr(0x44, '', 'om_card_54x86mm'),
          intAttr(0x23, 'printer-state', 3),
          Buffer.from([0x03])
        ]));
      } else if (op === 0x0002) {
        // Print-Job
        printCalls++;
        printBodies.push(reqBuf);
        if (printCalls <= 2) {
          res.end(Buffer.concat([
            Buffer.from([0x02, 0x00, 0x05, 0x07, 0, 0, 0, 1, 0x01]), // 0x0507 server-error-busy
            attr(0x47, 'attributes-charset', 'utf-8'),
            attr(0x48, 'attributes-natural-language', 'en'),
            Buffer.from([0x03])
          ]));
        } else {
          res.end(Buffer.concat([
            Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01]),
            attr(0x47, 'attributes-charset', 'utf-8'),
            attr(0x48, 'attributes-natural-language', 'en'),
            Buffer.from([0x02]),
            intAttr(0x21, 'job-id', 77),
            intAttr(0x23, 'job-state', 5),
            Buffer.from([0x03])
          ]));
        }
      } else if (op === 0x0009) {
        // Get-Job-Attributes
        jobPolls++;
        const st = jobPolls < 3 ? 5 : 9;
        res.end(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 2, 0x01]),
          attr(0x47, 'attributes-charset', 'utf-8'),
          attr(0x48, 'attributes-natural-language', 'en'),
          Buffer.from([0x02]),
          intAttr(0x21, 'job-id', 77),
          intAttr(0x23, 'job-state', st),
          Buffer.from([0x03])
        ]));
      } else {
        res.end(Buffer.from([0x02, 0x00, 0x05, 0x01, 0, 0, 0, 1, 0x03]));
      }
    });
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    // Minimal JFIF JPEG header + EOI
    const fakeJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
    ]);
    const res = await ippPrintDirect({
      ip: '127.0.0.1', port, path: '/ipp/print',
      jpeg: fakeJpeg, widthMm: 101.6, heightMm: 152.4,
      borderless: true, busyWaitMs: 5, maxBusyRetries: 5
    });
    assert.equal(printCalls, 3, 'retried Print-Job twice on 0x0507 and succeeded on 3rd attempt');
    assert.equal(res.media, 'page 100x148 mm, zero margins');
    assert.equal(res.scaling, 'fill');
    assert.equal(res.jobId, 77);
    assert.ok(printBodies[0].equals(printBodies[2]), '3rd attempt sent byte-identical zero-margin 100x148mm Print-Job request');

    // Verify JFIF DPI was rewritten to 300 (0x012c) inside the sent payload
    const jfifIdx = printBodies[2].indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    assert.ok(jfifIdx > 0);
    assert.equal(printBodies[2].readUInt16BE(jfifIdx + 14), 300);

    // Verify waitIppIdle polls Get-Job-Attributes until job-state=9 (completed)
    await waitIppIdle({ ip: '127.0.0.1', port, path: res.path, jobId: res.jobId, pollMs: 5, maxWaitMs: 1000 });
    assert.equal(jobPolls, 3, 'waitIppIdle polled Get-Job-Attributes until job-state reached 9 (completed)');
  } finally {
    srv.close();
  }
});

test('Assembled booth.html _btThermal runtime: bilateral denoise, blank-row band breaks, and RP30/P50/V80 pacing', async () => {
  const boothHtml = rd('protected/booth.html');
  const startMarker = 'bt-thermal.mjs — Bluetooth thermal receipt printer';
  const startIdx = boothHtml.lastIndexOf('(function (global) {', boothHtml.indexOf(startMarker) + 600);
  const endMarker = '}(typeof globalThis !== \'undefined\' ? globalThis : window));';
  const endIdx = boothHtml.indexOf(endMarker, startIdx) + endMarker.length;
  assert.ok(startIdx > 0 && endIdx > startIdx, 'located inline _btThermal IIFE in assembled protected/booth.html');
  const inlineCode = boothHtml.slice(startIdx, endIdx);

  function makeCanvas(w, h, fillLum = 255) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fillLum; data[i * 4 + 1] = fillLum; data[i * 4 + 2] = fillLum; data[i * 4 + 3] = 255;
    }
    return {
      width: w, height: h, _data: data,
      getContext() {
        return {
          fillStyle: '#fff', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
          fillRect() {},
          drawImage(src, _x, _y, dw, dh) {
            for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
              const sx = Math.min(src.width - 1, Math.floor(x * src.width / dw));
              const sy = Math.min(src.height - 1, Math.floor(y * src.height / dh));
              const si = (sy * src.width + sx) * 4, di = (y * dw + x) * 4;
              data[di] = src._data[si]; data[di + 1] = src._data[si + 1]; data[di + 2] = src._data[si + 2]; data[di + 3] = 255;
            }
          },
          getImageData(_x, _y, iw, ih) { return { width: iw, height: ih, data }; },
          putImageData(id) { data.set(id.data); }
        };
      }
    };
  }

  const store = new Map();
  const writes = [];
  let nextName = 'ArcticBreeze RP30';
  const sandbox = {
    window: {}, navigator: {}, console, setTimeout, clearTimeout, Date,
    btoa: (bin) => Buffer.from(bin, 'binary').toString('base64'),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    },
    __BTBridge: {
      connect: () => JSON.stringify({ ok: true, name: nextName }),
      write: (b64) => { writes.push({ bytes: Buffer.from(b64, 'base64'), chunk: 0 }); return JSON.stringify({ ok: true }); },
      writePaced: (b64, chunk, delay) => { writes.push({ bytes: Buffer.from(b64, 'base64'), chunk, delay }); return JSON.stringify({ ok: true }); }
    },
    document: {
      createElement: () => {
        let w = 1, h = 1, c = makeCanvas(1, 1);
        return {
          get width() { return w; }, set width(v) { w = v; c = makeCanvas(w, h); },
          get height() { return h; }, set height(v) { h = v; c = makeCanvas(w, h); },
          get _data() { return c._data; }, getContext: () => c.getContext()
        };
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(inlineCode, sandbox);
  const T = sandbox._btThermal;

  // 1. Bilateral denoise lowers sensor noise on skin midtones while rolling near-white (245) backdrop to pure 255 and keeping black text #000
  const noisy = makeCanvas(64, 32, 245);
  for (let y = 4; y < 28; y++) for (let x = 4; x < 32; x++) {
    const v = ((x + y) & 1) ? 138 : 118; // noisy midtone patch (variance = 100)
    const i = (y * 64 + x) * 4;
    noisy._data[i] = noisy._data[i + 1] = noisy._data[i + 2] = v;
  }
  for (let y = 10; y < 20; y++) for (let x = 40; x < 50; x++) {
    const i = (y * 64 + x) * 4;
    noisy._data[i] = noisy._data[i + 1] = noisy._data[i + 2] = 0; // pure black text block
  }
  const gray = T.toReceiptGray(noisy, 64, 'best');
  assert.equal(gray._pbToneDone, true);
  // Backdrop region x=54..62, y=4..28 must be pure 255
  for (let y = 4; y < 28; y++) for (let x = 54; x < 62; x++) {
    assert.equal(gray._data[(y * 64 + x) * 4], 255, 'near-white backdrop rolled to pure 255');
  }
  // Black text interior x=42..48, y=12..18 must stay pure 0
  for (let y = 12; y < 18; y++) for (let x = 42; x < 48; x++) {
    assert.equal(gray._data[(y * 64 + x) * 4], 0, 'pure black text preserved');
  }
  // Noisy midtone interior variance must drop dramatically from bilateral denoise
  let vals = [];
  for (let y = 8; y < 24; y++) for (let x = 8; x < 28; x++) vals.push(gray._data[(y * 64 + x) * 4]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
  assert.ok(variance < 40, 'bilateral denoise reduces high-frequency sensor grain (variance=' + variance.toFixed(1) + ')');

  // Feeding _pbToneDone gray into toReceiptCanvas keeps backdrop 100% pure white (zero pepper dots)
  const mono = T.toReceiptCanvas(gray, 64, 0, 'best');
  for (let y = 4; y < 28; y++) for (let x = 54; x < 62; x++) {
    assert.equal(mono._data[(y * 64 + x) * 4], 255, 'Atkinson leaves zero pepper dots on rolled-off backdrop');
  }

  // 2. Blank-row band alignment: 2-photo strip with a white gap at rows 130..145 breaks inside the gap instead of across photo 2
  const strip = makeCanvas(576, 300, 255);
  for (let y = 0; y < 130; y++) for (let x = 20; x < 556; x++) {
    const i = (y * 576 + x) * 4; strip._data[i] = strip._data[i + 1] = strip._data[i + 2] = 0;
  }
  for (let y = 146; y < 300; y++) for (let x = 20; x < 556; x++) {
    const i = (y * 576 + x) * 4; strip._data[i] = strip._data[i + 1] = strip._data[i + 2] = 0;
  }
  const encGap = new T.EscPosEncoder(576).image(strip, 200);
  const marks = encGap.getMarks();
  assert.ok(marks.length >= 2, 'split into multiple bands');
  assert.ok(marks[0].rows >= 131 && marks[0].rows <= 146, 'band 1 ended cleanly in the white gap between photos (rows=' + marks[0].rows + ')');

  // 3. Even with speed='safe', 80mm ArcticBreeze RP30 & VOXY V80 keep 512B chunks + 72 B/row + auto-cut, while VOZY P50 uses 48B chunks + 48 B/row + NO cut
  T.btSetProfile({ speed: 'safe' });
  const hasCut = (buf) => { for (let i = 0; i < buf.length - 3; i++) if (buf[i] === 0x1d && buf[i + 1] === 0x56) return true; return false; };

  writes.length = 0; nextName = 'ArcticBreeze RP30';
  await T.printViaBluetooth(makeCanvas(400, 16, 128), '80mm', { cut: true, quality: 'best' });
  assert.equal(writes[0].chunk, 512, 'RP30 80mm overrides safe speed to 512B chunks');
  assert.equal(writes[0].bytes[6], 72, 'RP30 uses 72 B/row (576 dots)');
  assert.equal(hasCut(Buffer.concat(writes.map(w => w.bytes))), true, 'RP30 emits auto-cut');

  T.btPrinter.disconnect();
  writes.length = 0; nextName = 'VOZY P50';
  await T.printViaBluetooth(makeCanvas(400, 16, 128), '80mm', { cut: true, quality: 'best' });
  assert.equal(writes[0].chunk, 48, 'VOZY P50 uses safe 58mm 48B chunks');
  assert.equal(writes[0].bytes[6], 48, 'VOZY P50 clamped to 48 B/row (384 dots)');
  assert.equal(hasCut(Buffer.concat(writes.map(w => w.bytes))), false, 'VOZY P50 suppresses auto-cut');

  T.btPrinter.disconnect();
  writes.length = 0; nextName = 'VOXY V80';
  await T.printViaBluetooth(makeCanvas(400, 16, 128), '80mm', { cut: true, quality: 'best' });
  assert.equal(writes[0].chunk, 512, 'VOXY V80 restores 512B chunks after switching from P50');
  assert.equal(writes[0].bytes[6], 72, 'VOXY V80 restores 72 B/row after switching from P50');
  assert.equal(hasCut(Buffer.concat(writes.map(w => w.bytes))), true, 'VOXY V80 restores auto-cut');
});

test('End-to-end Desktop helper.mjs multi-page Canon SELPHY CP1500 IPP: waitIppIdle between pages + exhausted 0x0507 error', async () => {
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const str = (s) => { const v = Buffer.from(s, 'utf8'); return Buffer.concat([u16(v.length), v]); };
  const attr = (tag, name, val) => Buffer.concat([Buffer.from([tag]), str(name), str(val)]);
  const intAttr = (tag, name, v) => Buffer.concat([Buffer.from([tag]), str(name), u16(4), u32(v)]);

  const events = [];
  let page2BusyOnce = true;
  let stuckBusy = false;
  let job1Polls = 0;
  let printSeq = 0;

  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reqBuf = Buffer.concat(chunks);
      const op = reqBuf.readUInt16BE(2);
      res.writeHead(200, { 'content-type': 'application/ipp' });
      if (op === 0x000b) {
        res.end(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01]),
          attr(0x47, 'attributes-charset', 'utf-8'),
          attr(0x48, 'attributes-natural-language', 'en'),
          Buffer.from([0x04]),
          attr(0x41, 'printer-make-and-model', 'Canon SELPHY CP1500'),
          attr(0x49, 'document-format-supported', 'image/jpeg'),
          attr(0x44, 'media-ready', 'jpn_hagaki_100x148mm'),
          attr(0x44, 'media-supported', 'jpn_hagaki_100x148mm'),
          intAttr(0x23, 'printer-state', 3),
          Buffer.from([0x03])
        ]));
      } else if (op === 0x0002) {
        if (stuckBusy) {
          events.push('print-busy-stuck');
          res.end(Buffer.concat([
            Buffer.from([0x02, 0x00, 0x05, 0x07, 0, 0, 0, 1, 0x01]),
            attr(0x47, 'attributes-charset', 'utf-8'),
            attr(0x48, 'attributes-natural-language', 'en'),
            Buffer.from([0x03])
          ]));
          return;
        }
        if (printSeq === 1 && page2BusyOnce) {
          page2BusyOnce = false;
          events.push('print-2-busy');
          res.end(Buffer.concat([
            Buffer.from([0x02, 0x00, 0x05, 0x07, 0, 0, 0, 1, 0x01]),
            attr(0x47, 'attributes-charset', 'utf-8'),
            attr(0x48, 'attributes-natural-language', 'en'),
            Buffer.from([0x03])
          ]));
          return;
        }
        printSeq++;
        events.push('print-' + printSeq + '-ok');
        res.end(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01]),
          attr(0x47, 'attributes-charset', 'utf-8'),
          attr(0x48, 'attributes-natural-language', 'en'),
          Buffer.from([0x02]),
          intAttr(0x21, 'job-id', 100 + printSeq),
          intAttr(0x23, 'job-state', 5),
          Buffer.from([0x03])
        ]));
      } else if (op === 0x0009) {
        job1Polls++;
        const st = job1Polls < 3 ? 5 : 9;
        events.push('poll-job1-state-' + st);
        res.end(Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 2, 0x01]),
          attr(0x47, 'attributes-charset', 'utf-8'),
          attr(0x48, 'attributes-natural-language', 'en'),
          Buffer.from([0x02]),
          intAttr(0x21, 'job-id', 101),
          intAttr(0x23, 'job-state', st),
          Buffer.from([0x03])
        ]));
      } else {
        res.end(Buffer.from([0x02, 0x00, 0x05, 0x01, 0, 0, 0, 1, 0x03]));
      }
    });
  });

  const dir = mkdtempSync(join(tmpdir(), 'pb4u-selphy-ipp-'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    initHelper({
      workerPath: join(dir, 'none.ps1'),
      logger: () => {},
      directPrintersFile: join(dir, 'direct.json'),
      ippWaitOpts: { pollMs: 5, maxWaitMs: 1000, busyWaitMs: 5, maxBusyRetries: 3 }
    });
    const post = (p, body) => handleHelper(
      new Request('http://127.0.0.1:17321' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      p, new URLSearchParams()
    );
    const added = await (await post('/printer/add', { ip: '127.0.0.1', port, path: '/ipp/print', name: 'Canon SELPHY CP1500', direct: true })).json();
    assert.equal(added.ok, true, JSON.stringify(added));

    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9]);
    const jpgDataUrl = 'data:image/jpeg;base64,' + fakeJpeg.toString('base64');
    const printed = await (await post('/print', { printer: added.printer, pages: [jpgDataUrl, jpgDataUrl], widthMm: 101.6, heightMm: 152.4, borderless: true })).json();
    assert.equal(printed.ok, true, JSON.stringify(printed));
    assert.deepEqual(events, [
      'print-1-ok',
      'poll-job1-state-5',
      'poll-job1-state-5',
      'poll-job1-state-9',
      'print-2-busy',
      'print-2-ok'
    ], 'helper.mjs waited for job 101 completion before sending page 2, and retried page 2 cleanly on 0x0507');

    // Exhausted 0x0507 fails immediately with clear busy message after maxBusyRetries (no bordered fallback storm)
    events.length = 0;
    stuckBusy = true;
    await assert.rejects(
      () => ippPrintDirect({ ip: '127.0.0.1', port, path: '/ipp/print', jpeg: fakeJpeg, widthMm: 101.6, heightMm: 152.4, busyWaitMs: 5, maxBusyRetries: 2 }),
      /still busy.*0x507/i
    );
    assert.equal(events.length, 3, 'stopped immediately after 1 initial + 2 busy retries without looping fallback attempts');
  } finally {
    stopHelper();
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const { name, fn } of asyncTests) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e));
    process.exitCode = 1;
  }
}
console.log(passed + ' passed');
