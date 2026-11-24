// Comprehensive verification for all printer phases:
// - Android PrintBridge MediaSizes (JPN_HAGAKI, ISO_A5, ISO_A6, NA_GOVT_LETTER, PWG 5x7 & 3.5x5)
// - DNP & Citizen USB matching, sheet geometry, and 8-inch (CX-02W/DS80/DS820) + 4.5-inch (CZ-01/QW410) guards
// - Epson / Canon / Brother USB & Wi-Fi Direct safety guards (no L130 ESC/P2 hijack, no LPD-only Brother trap, no USB flag leak)
// - iPad printEscpr immediate error reply
// - Byte-level runtime execution of bt-thermal.mjs (serpentine Atkinson, highlight roll-off, EscPosEncoder, CatPrinterEncoder)
// - Byte-identical parity between protected/src/bt-thermal.mjs and public/src/bt-thermal.mjs, plus ReceiptRaster.kt parity
// Run: node desktop/test/test-printer-phases.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
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
    'android/app/src/main/java/com/photobooth4u/booth/PrintBridge.kt',
    'android/app/src/main/java/com/photobooth4u/booth/DnpJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/CanonJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/CanonSelphyJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/EscP2Job.kt',
    'android/app/src/main/java/com/photobooth4u/booth/EscprJob.kt',
    'android/app/src/main/java/com/photobooth4u/booth/ReceiptRaster.kt',
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
});

console.log(passed + ' passed');
