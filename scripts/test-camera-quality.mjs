// Behaviour tests for the camera photo-quality code (protected/src/camera/*).
// Run: node scripts/test-camera-quality.mjs      (no camera, browser or network needed)
//
// These RUN the code (in a sandbox with a fake canvas / localStorage), they do not just look for words in it:
//   - each brand is picked by the connected camera, and its settings never touch another brand's
//   - the denoise reduces noise but keeps an edge, the sharpen raises edge contrast
//   - a big photo is shrunk in halving steps, once per box (cached), and "classic" skips all of it
//   - the EXIF reader finds ISO / shutter / aperture in a real JPEG header
//   - the page assembled from protected/src is the page that is committed
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const part = n => readFileSync(join(ROOT, 'protected', 'src', 'camera', n), 'utf8');
const page = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.message)); process.exitCode = 1; } };
const testAsync = async (name, fn) => { try { await fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.message)); process.exitCode = 1; } };

// The real camIsCanon / camIsSony from the page (they decide which brand is connected), not copies.
function pageFunction(name) {
  const lines = page.split('\n'), a = lines.findIndex(l => l.startsWith('      function ' + name + '('));
  assert(a >= 0, name + ' not found in booth.html');
  let b = a; while (!/^      }\s*$/.test(lines[b])) b++;
  return lines.slice(a, b + 1).join('\n');
}

function makeSandbox() {
  const store = new Map(), log = [], drawn = [];
  const mkCanvas = () => {
    const cv = { width: 0, height: 0 };
    cv.getContext = () => ({
      imageSmoothingEnabled: false, imageSmoothingQuality: '',
      drawImage: (src, ...a) => drawn.push({ to: cv, src, args: a }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => { },
    });
    return cv;
  };
  const sb = {
    console, Math, Object, Array, Map, Uint8Array, Uint8ClampedArray, Promise, Date, String, Number,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: { createElement: () => mkCanvas(), getElementById: () => null },
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => 0,
    USB_CAM_ID: 'usb-remote',
    currentDeviceId: 'webcam-1',
    usbCam: { name: '', camera: { info: {} } },
    usbLog: (kind, info) => log.push([kind, info]),
    showToast: () => { },
    shotCanvases: [],
    state: 'capturing', renderComposite: () => { }, composeCanvas: () => { }, currentLayout: 'x',
  };
  vm.createContext(sb);
  vm.runInContext(pageFunction('camIsCanon') + '\n' + pageFunction('camIsSony'), sb);
  for (const f of ['photo-quality.js', 'brand-nikon.js', 'brand-canon.js', 'brand-sony.js', 'webcam-pro.js']) vm.runInContext(part(f), sb, { filename: f });
  // const bindings from the parts are not properties of the sandbox: read them through the context
  sb.get = expr => vm.runInContext(expr, sb);
  sb.store = store; sb.log = log; sb.drawn = drawn; sb.mkCanvas = mkCanvas;
  return sb;
}
const withCamera = (sb, name, brand) => { sb.usbCam.name = name; sb.usbCam.camera = { info: brand ? { brand } : {} }; };

// ---- which brand is connected ----
test('the connected camera picks its own brand profile', () => {
  const sb = makeSandbox(), id = () => sb.get('(camQProfile() || {}).id');
  withCamera(sb, 'Nikon D5600', 'nikon'); assert.equal(id(), 'nikon');
  withCamera(sb, 'Canon EOS 60D', 'canon'); assert.equal(id(), 'canon');
  withCamera(sb, 'Sony ILCE-7M3', 'sony'); assert.equal(id(), 'sony');
  withCamera(sb, 'Sony ILCE-7M3', ''); assert.equal(id(), 'sony', 'brand found from the name alone');
  withCamera(sb, 'Logitech BRIO', ''); assert.equal(id(), undefined, 'a webcam has no brand profile');
});

// ---- settings stay inside their brand ----
test('defaults: clean-up Auto, tips off, classic off, for every brand', () => {
  const sb = makeSandbox();
  for (const b of ['nikon', 'canon', 'sony']) {
    assert.equal(sb.get(`CAM_Q.${b}.cleanMode()`), 'auto', b + ' clean-up');
    assert.equal(sb.get(`CAM_Q.${b}.tips()`), false, b + ' tips');
    assert.equal(sb.get(`CAM_Q.${b}.classic()`), false, b + ' classic');
  }
});
test("changing one brand's settings never changes another brand's", () => {
  const sb = makeSandbox();
  sb.store.set('pb_canon_clean', 'off'); sb.store.set('pb_sony_clean', 'strong'); sb.store.set('pb_nikon_tips', '1');
  assert.equal(sb.get('CAM_Q.canon.cleanMode()'), 'off');
  assert.equal(sb.get('CAM_Q.sony.cleanMode()'), 'strong');
  assert.equal(sb.get('CAM_Q.nikon.cleanMode()'), 'auto');
  assert.equal(sb.get('CAM_Q.nikon.tips()'), true);
  assert.equal(sb.get('CAM_Q.canon.tips()'), false);
  assert.equal(sb.get('CAM_Q.sony.tips()'), false);
});
test('classic switches that brand\'s clean-up and tips off, and only that brand', () => {
  const sb = makeSandbox();
  sb.store.set('pb_canon_tips', '1'); sb.store.set('pb_canon_classic', '1');
  assert.equal(sb.get('CAM_Q.canon.cleanMode()'), 'off');
  assert.equal(sb.get('CAM_Q.canon.tips()'), false);
  assert.equal(sb.get('CAM_Q.sony.cleanMode()'), 'auto');
  assert.equal(sb.get('CAM_Q.nikon.cleanMode()'), 'auto');
});
test('a clean-up that is too slow turns itself off for that brand only', () => {
  const sb = makeSandbox();
  sb.get('CAM_Q.sony.tooSlow = true');
  assert.equal(sb.get('CAM_Q.sony.cleanMode()'), 'off');
  assert.equal(sb.get('CAM_Q.canon.cleanMode()'), 'auto');
});
test("each brand has its own tuning object (editing Canon's numbers cannot change Sony's)", () => {
  const sb = makeSandbox();
  sb.get('CAM_Q.canon.tune.denoise[0] = 99');
  assert.equal(sb.get('CAM_Q.sony.tune.denoise[0]'), 16);
  assert.equal(sb.get('CAM_Q.nikon.tune.denoise[0]'), 16);
});

// ---- the pixel work ----
function noisyFlat(w, h, base, amp, seed) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { for (let c = 0; c < 3; c++) d[i * 4 + c] = base + (rnd() - 0.5) * 2 * amp; d[i * 4 + 3] = 255; }
  return d;
}
const variance = (d, w, h) => { let n = 0, m = 0, v = 0; for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { m += d[(y * w + x) * 4]; n++; } m /= n; for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const q = d[(y * w + x) * 4] - m; v += q * q; } return v / n; };
test('clean-up lowers grain on a noisy flat area', () => {
  const sb = makeSandbox(), w = 60, h = 60, d = noisyFlat(w, h, 128, 24, 7), before = variance(d, w, h);
  sb.get('pbCleanPixels').call(null, d, w, h, 'auto', true, sb.get('CAM_Q.canon.tune'));
  // the sharpen step adds a little back, so ask for a clear drop, not a perfect one
  assert(variance(d, w, h) < before * 0.7, 'variance ' + before.toFixed(1) + ' -> ' + variance(d, w, h).toFixed(1));
});
test('Strong averages noise away harder than Auto (denoise step alone)', () => {
  const sb = makeSandbox(), w = 60, h = 60, a = noisyFlat(w, h, 128, 24, 9), s = noisyFlat(w, h, 128, 24, 9);
  const t = { denoise: sb.get('CAM_Q.nikon.tune.denoise'), sharpen: [0, 0] };   // no sharpen, so only the denoise is measured
  sb.get('pbCleanPixels')(a, w, h, 'auto', true, t); sb.get('pbCleanPixels')(s, w, h, 'strong', true, t);
  assert(variance(s, w, h) < variance(a, w, h), 'strong ' + variance(s, w, h).toFixed(1) + ' vs auto ' + variance(a, w, h).toFixed(1));
});
test('clean-up keeps a hard edge (no smearing a dark area into a bright one)', () => {
  const sb = makeSandbox(), w = 40, h = 40, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 20 ? 40 : 210, i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  sb.get('pbCleanPixels')(d, w, h, 'strong', true, sb.get('CAM_Q.sony.tune'));
  const at = x => d[(20 * w + x) * 4];
  assert(at(18) <= 45 && at(21) >= 205, 'edge pixels ' + at(18) + ' / ' + at(21));
});
test('the page sharpen raises contrast across an edge', () => {
  const sb = makeSandbox(), w = 30, h = 30, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 15 ? 100 : 150, i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  sb.get('pbSharpenPage')(d, w, h, 0.5);
  assert(d[(15 * w + 14) * 4] < 100 && d[(15 * w + 15) * 4] > 150, 'dark side ' + d[(15 * w + 14) * 4] + ', bright side ' + d[(15 * w + 15) * 4]);
});

// ---- shrinking a big photo into its box ----
function tileCall(sb, brand, srcW, srcH, boxW, boxH) {
  const ctx = { getTransform: () => ({ a: 1, b: 0 }) };
  const img = { width: srcW, height: srcH };
  sb.drawn.length = 0;
  const out = sb.get(`(function (ctx, img) { return camQTile(CAM_Q.${brand}, ctx, img, 0, 0, ${srcW}, ${srcH}, ${boxW}, ${boxH}); })`)(ctx, img);
  return { out, img, ctx, steps: sb.drawn.length };
}
test('a 3000x2000 photo into a 600x400 box is shrunk in halving steps, not one jump', () => {
  const sb = makeSandbox(), r = tileCall(sb, 'canon', 3000, 2000, 600, 400);
  assert(r.out && r.out.width === 600 && r.out.height === 400, 'output size');
  const sizes = sb.drawn.map(d => d.to.width);
  assert.deepEqual(sizes, [1500, 750, 600], 'sizes drawn: ' + sizes.join(', '));
});
test('the shrunk box is cached per photo (a second draw does no new work)', () => {
  const sb = makeSandbox(), r = tileCall(sb, 'sony', 3000, 2000, 600, 400);
  const again = sb.get('(function (ctx, img) { return camQTile(CAM_Q.sony, ctx, img, 0, 0, 3000, 2000, 600, 400); })')(r.ctx, r.img);
  assert.equal(again, r.out);
});
test('classic mode draws the photo the ordinary way (no shrink, no clean-up)', () => {
  const sb = makeSandbox(); sb.store.set('pb_sony_classic', '1');
  assert.equal(tileCall(sb, 'sony', 3000, 2000, 600, 400).out, null);
});
test('clean-up Off still shrinks in steps when the photo is much bigger than its box', () => {
  const sb = makeSandbox(); sb.store.set('pb_canon_clean', 'off');
  const r = tileCall(sb, 'canon', 3000, 2000, 600, 400);
  assert(r.out && r.steps >= 3);
});
test('clean-up Off with a photo about the box size leaves it alone', () => {
  const sb = makeSandbox(); sb.store.set('pb_canon_clean', 'off');
  assert.equal(tileCall(sb, 'canon', 700, 466, 600, 400).out, null);
});

// ---- what a shot does ----
test('a shot is marked with the brand that took it, so drawing and printing use that brand\'s profile', () => {
  const sb = makeSandbox(); withCamera(sb, 'Canon EOS 60D', 'canon');
  const cv = {}; const p = sb.get('camQOnShot')({ slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }, cv);
  assert.equal(cv._cq, 'canon'); assert.equal(p.id, 'canon');
  const web = {}; withCamera(sb, 'Logitech BRIO', ''); assert.equal(sb.get('camQOnShot')({}, web), null); assert.equal(web._cq, undefined);
});
test('printing sharpens the page only when a shot on it came from one of these cameras', () => {
  const sb = makeSandbox(); let sharpened = 0;
  const page = { width: 1000, height: 1000, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(1000 * 1000 * 4) }), putImageData: () => { sharpened++; } }) };
  sb.shotCanvases.push({ _cq: 'sony' });
  sb.get('camQPrintSharpen')(page); assert.equal(sharpened, 1);
  const page2 = Object.assign({}, page, { _pbSharp: false }); sb.shotCanvases.length = 0; sb.shotCanvases.push({});
  sb.get('camQPrintSharpen')(page2); assert.equal(sharpened, 1, 'webcam photos are not sharpened');
});

// ---- warnings ----
test('warnings: high ISO, slow shutter, no focus lock', () => {
  const sb = makeSandbox(), w = (b, ex, f) => sb.get(`(function(){ return camQWarnings(CAM_Q.${b}, ${JSON.stringify(ex)}, ${f}); })`)();
  assert.equal(w('canon', { iso: 100, shutter: 1 / 250 }, false).length, 0);
  assert(/ISO 3200/.test(w('canon', { iso: 3200, shutter: 1 / 250 }, false)[0]));
  assert(/slow/.test(w('sony', { iso: 100, shutter: 1 / 15 }, false)[0]));
  assert(/focus/.test(w('nikon', null, true)[0]));
});

// ---- the EXIF reader, on a real JPEG header ----
await testAsync('reads ISO, shutter and aperture from a JPEG\'s EXIF block', async () => {
  const sb = makeSandbox(), u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, valOrOff) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(valOrOff), 0, 0] : u32(valOrOff))];
  const tiff = [0x49, 0x49, 0x2A, 0, ...u32(8),
    ...u16(1), ...entry(0x8769, 4, 26), ...u32(0),                                     // IFD0 -> Exif IFD at 26
    ...u16(3), ...entry(0x829A, 5, 68), ...entry(0x829D, 5, 76), ...entry(0x8827, 3, 800), ...u32(0),   // shutter, f-number, ISO
    ...u32(1), ...u32(100), ...u32(28), ...u32(10)];                                  // 1/100 s, f/2.8
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, 0xFF, 0xD9]);
  const blob = { slice: () => ({ arrayBuffer: async () => jpeg.buffer }) };
  const ex = await sb.get('pbReadExif')(blob);
  assert.deepEqual([ex.iso, Math.round(ex.f * 10) / 10, ex.shutter], [800, 2.8, 0.01]);
  assert.equal(await sb.get('pbReadExif')({ slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }), null, 'not a JPEG');
  assert.equal(sb.get('pbShutterText')(1 / 125), '1/125 s');
});

// ---- the brand files stay separate ----
test('each brand file mentions only its own brand, and the shared file mentions none', () => {
  const brands = { 'brand-nikon.js': /\b(canon|sony)\b/i, 'brand-canon.js': /\b(nikon|sony)\b/i, 'brand-sony.js': /\b(nikon|canon)\b/i, 'photo-quality.js': /\b(nikon|canon|sony)\b/i };
  for (const [f, bad] of Object.entries(brands)) { const m = bad.exec(part(f)); assert(!m, f + ' mentions "' + (m && m[0]) + '"'); }
});

// ---- webcam improvements ----
test('isUsbWebcamOption identifies external USB webcams and rejects built-in, IR and virtual cameras', () => {
  const sb = makeSandbox();
  sb.UVC_ID = 'pb-uvc-webcam'; sb.IS_ANDROID_APP = false; sb.window = {};
  vm.runInContext(pageFunction('isUsbWebcamOption'), sb);
  const check = (id, label) => sb.get('isUsbWebcamOption')(id, label);
  for (const ext of ['Logitech BRIO', 'HD Pro Webcam C920', 'Razer Kiyo Pro', 'Elgato Facecam', 'OBSBOT Tiny 2', 'Anker PowerConf C200', 'USB Video Capture HDMI']) {
    assert.equal(check('dev-1', ext), true, 'expected external webcam: ' + ext);
  }
  for (const skip of ['Microsoft Camera Front', 'Surface Camera Rear', 'Microsoft IR Camera Front', 'Windows Hello IR', 'Integrated Webcam', 'FaceTime HD Camera', 'OBS Virtual Camera']) {
    assert.equal(check('dev-2', skip), false, 'expected built-in/IR/virtual rejected: ' + skip);
  }
});
test('CAM_Q.webcam + webcamMarkShot marks webcam shots for clean-up and print sharpen while keeping camQProfile null', () => {
  const sb = makeSandbox();
  withCamera(sb, 'Logitech BRIO', '');
  assert.equal(sb.get('camQProfile()'), null, 'camQProfile stays null for webcams');
  const cvAuto = {};
  assert.equal(sb.get('webcamMarkShot')(cvAuto).id, 'webcam');
  assert.equal(cvAuto._cq, 'webcam');
  const tile = sb.get('(function(ctx, img){ return camQTile(CAM_Q.webcam, ctx, img, 0, 0, 1280, 720, 640, 360); })')({ getTransform: () => ({ a: 1, b: 0 }) }, { width: 1280, height: 720 });
  assert(tile && tile.width === 640 && tile.height === 360, 'webcam shot runs through camQTile');
  let sharpened = 0;
  const pageCv = { width: 1000, height: 1000, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(1000 * 1000 * 4) }), putImageData: () => { sharpened++; } }) };
  sb.shotCanvases.push(cvAuto);
  sb.get('camQPrintSharpen')(pageCv);
  assert.equal(sharpened, 1, 'marked webcam shot triggers camQPrintSharpen');
  sb.store.set('pb_webcam_clean', 'off');
  const cvOff = {};
  assert.equal(sb.get('webcamMarkShot')(cvOff), null);
  assert.equal(cvOff._cq, undefined);
  sb.store.set('pb_webcam_clean', 'auto');
  sb.currentDeviceId = 'usb-remote';
  const cvUsb = {};
  assert.equal(sb.get('webcamMarkShot')(cvUsb), null, 'webcamMarkShot skips USB DSLR mode');
  assert.equal(cvUsb._cq, undefined);
});
test('webcamBlendFrames lowers stationary noise without ghosting moving pixels', () => {
  const sb = makeSandbox(), w = 32, h = 32;
  const cur = noisyFlat(w, h, 120, 8, 11);
  const p1 = noisyFlat(w, h, 120, 8, 22);
  const p2 = noisyFlat(w, h, 120, 8, 33);
  const beforeVar = variance(cur, w, h);
  // Put a high-contrast moving pixel on row 0 (outside flat interior variance) with diff >= 38 vs p1/p2
  const moveIdx = 4 * 4;
  cur[moveIdx] = 240; cur[moveIdx + 1] = 240; cur[moveIdx + 2] = 240;
  const did = sb.get('webcamBlendFrames')(cur, [p1, p2], w, h);
  assert.equal(did, true);
  assert(variance(cur, w, h) < beforeVar * 0.7, 'stationary noise variance dropped: ' + beforeVar.toFixed(1) + ' -> ' + variance(cur, w, h).toFixed(1));
  assert.deepEqual([cur[moveIdx], cur[moveIdx + 1], cur[moveIdx + 2]], [240, 240, 240], 'moving pixel stayed 100% intact');
});

// ---- the committed page is what the sources make ----
test('protected/booth.html is exactly what protected/src builds (run npm run build if this fails)', () => {
  const built = assemble();
  assert(built, 'no protected/src');
  assert.equal(built.html, page);
  assert(built.used.length >= 4, 'part files used: ' + built.used.join(', '));
});
test('the page no longer carries the old Nikon-only names', () => {
  for (const old of ['nikonTile(', 'nikonUiSync', 'nikonCleanMode', '_nkCache', 'nikonWarnNote', 'nikonCleanSel'])
    assert(!page.includes(old), 'still mentions ' + old);
  assert(!/(?<![A-Za-z0-9])_nikon/.test(page), 'still uses the old _nikon flag');
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : ''));
