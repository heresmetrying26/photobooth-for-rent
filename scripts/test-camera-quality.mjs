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
  const lines = page.split('\n'), a = lines.findIndex(l => l.startsWith('      function ' + name + '(') || l.startsWith('      async function ' + name + '('));
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

// ---- a photo enlarged into a bigger box: sharpen only, never the grain average (that only softens it) ----
test('an enlarged photo is sharpened but not denoised; a shrunk one is both', () => {
  const sb = makeSandbox(); let seen = [];
  sb.pbCleanPixels = (d, w, h, mode, denoise) => { seen.push(denoise); };
  const run = (srcW, srcH, boxW, boxH) => { seen = []; tileCall(sb, 'canon', srcW, srcH, boxW, boxH); return seen; };
  // a 1280x720 shot cropped to a tall box is the 480x720 middle of it, drawn into a 1000x1500 box
  assert.deepEqual(run(480, 720, 1000, 1500), [false], '720p photo into a 4R box (enlarged)');
  assert.deepEqual(run(3000, 2000, 600, 400), [true], '3000 px photo into a small box (shrunk)');
  assert.deepEqual(run(6000, 4000, 2400, 1600), [false], 'a shrunk photo in a box too big for a quick denoise still gets the sharpen');
});
test('the clean-up pixel cap is lower for a tablet than for a laptop', () => {
  const sbT = makeSandbox(); let ranT = 0; sbT.pbCleanPixels = () => { ranT++; };
  tileCall(sbT, 'canon', 6000, 4000, 2800, 1800);   // 5.0 MP box
  assert.equal(ranT, 0, 'tablet: 5 MP box is over the cap, so no per-pixel pass');
  const sbD = makeSandbox(); let ranD = 0; sbD.pbCleanPixels = () => { ranD++; };
  vm.runInContext('var DESKTOP = true;', sbD);
  tileCall(sbD, 'canon', 6000, 4000, 2800, 1800);
  assert.equal(ranD, 1, 'laptop: the same box is under its cap');
});

// ---- grain removal follows the ISO: a clean photo is only sharpened, so fine low-contrast detail (skin, lashes) survives ----
// (measured with the real code on a chart: a +-8 level texture kept 7-48% of its detail through the full denoise, 100%+ without it)
function isoTile(sb, iso, mode) {
  if (mode) sb.store.set('pb_canon_clean', mode);
  const seen = []; sb.pbCleanPixels = (d, w, h, m, denoise, tune) => seen.push({ denoise, T: tune.denoise[0], strongT: tune.denoise[1] });
  const ctx = { getTransform: () => ({ a: 1, b: 0 }) }, img = { width: 3000, height: 2000 };
  if (iso !== undefined) img._cqIso = iso;
  sb.get('(function (ctx, img) { return camQTile(CAM_Q.canon, ctx, img, 0, 0, 3000, 2000, 600, 400); })')(ctx, img);
  return seen;
}
test('ISO tiers: up to ISO 1250 no grain removal (sharpen only), 1600-2500 light, 3200+ full, no EXIF ISO full as before', () => {
  const T = sb => sb.get('CAM_Q.canon.tune.denoise[0]');
  let sb = makeSandbox(), full = T(sb);
  assert.deepEqual(isoTile(sb, 100).map(x => x.denoise), [false], 'ISO 100');
  assert.deepEqual(isoTile(makeSandbox(), 1250).map(x => x.denoise), [false], 'ISO 1250');
  const mid = isoTile(makeSandbox(), 2000)[0];
  assert.equal(mid.denoise, true); assert(Math.abs(mid.T - full * 0.6) < 1e-9, 'light: ' + mid.T + ' vs full ' + full);
  const hi = isoTile(makeSandbox(), 3200)[0];
  assert.equal(hi.denoise, true); assert.equal(hi.T, full);
  const none = isoTile(makeSandbox(), undefined)[0];
  assert.equal(none.denoise, true); assert.equal(none.T, full, 'no EXIF: unchanged');
});
test('Strong (dim rooms) removes grain fully whatever the ISO; Off never runs the pass', () => {
  const sbS = makeSandbox(), s = isoTile(sbS, 100, 'strong')[0], full = sbS.get('CAM_Q.canon.tune.denoise[1]');
  assert.equal(s.denoise, true); assert.equal(s.strongT, full);
  assert.deepEqual(isoTile(makeSandbox(), 100, 'off'), []);
});
test('a box drawn for a low ISO is not reused for a high one (cached per grain setting)', () => {
  const sb = makeSandbox(); const seen = []; sb.pbCleanPixels = (d, w, h, m, dn) => seen.push(dn);
  const ctx = { getTransform: () => ({ a: 1, b: 0 }) }, img = { width: 3000, height: 2000, _cqIso: 100 };
  const draw = () => sb.get('(function (ctx, img) { return camQTile(CAM_Q.canon, ctx, img, 0, 0, 3000, 2000, 600, 400); })')(ctx, img);
  draw(); draw(); img._cqIso = 3200; draw();
  assert.deepEqual(seen, [false, true], 'second draw cached; the new ISO is cleaned again');
});
await testAsync('the ISO is read from the photo EXIF block and kept on the shot (and its drawn boxes are dropped)', async () => {
  const sb = makeSandbox(), u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, valOrOff) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(valOrOff), 0, 0] : u32(valOrOff))];
  const tiff = [0x49, 0x49, 0x2A, 0, ...u32(8), ...u16(1), ...entry(0x8769, 4, 26), ...u32(0),
    ...u16(3), ...entry(0x829A, 5, 68), ...entry(0x829D, 5, 76), ...entry(0x8827, 3, 200), ...u32(0), ...u32(1), ...u32(100), ...u32(28), ...u32(10)];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, 0xFF, 0xD9]);
  withCamera(sb, 'Canon EOS 60D', 'canon');
  sb.previewCanvas = { _renderedForLayout: 'strip' };
  const canvas = { _cqCache: new Map([['old', 1]]) };
  sb.get('camQOnShot')({ slice: () => ({ arrayBuffer: async () => jpeg.buffer }) }, canvas);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(canvas._cqIso, 200); assert.equal(canvas._cqCache, null);
  assert.equal(sb.previewCanvas._renderedForLayout, '', 'late ISO invalidates cached previewCanvas so uploadLayoutForQR redraws without full denoise');
});
test('prefetched EXIF sets _cqIso synchronously in camQOnShot so the last shot cannot race renderComposite', () => {
  const sb = makeSandbox();
  withCamera(sb, 'Canon EOS 60D', 'canon');
  const cv = { _cqCache: new Map([['old', 1]]) };
  sb.get('camQOnShot')({}, cv, { iso: 100, shutter: 1 / 200, f: 4, orientation: 1 });
  assert.equal(cv._cqIso, 100, 'ISO is set immediately before any async tick');
  assert.equal(cv._cqCache, null);
  assert(page.includes('const [bmp, exif] = await Promise.all([createImageBitmap(file), pbReadExif(file).catch(() => null)]);'), 'captureShot reads EXIF in parallel with decode');
  assert(page.includes('const qp = camQOnShot(file, c, exif);'), 'captureShot passes prefetched EXIF into camQOnShot');
});

// ---- lossless PNG master copy (laptop app): operator-only, never delays or fails the guest's session ----
function masterSandbox(o) {
  o = o || {};
  const calls = { uploads: [], logs: [] }, store = new Map(o.store || []);
  const sb = {
    String, Math, Promise, Number, Error, DESKTOP: !!o.desktop, MASTER_PNG_KEY: 'x',
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    pbCanvasBlob: async (c, type) => { calls.type = type; return o.noBlob ? null : { size: 8192 * 1024, type }; },
    uploadToDrive: async (blob, name, dest) => { calls.uploads.push([name, dest]); if (o.fail && calls.uploads.length <= o.fail) throw new Error('boom'); return {}; },
    isPermanentUploadError: () => !!o.permanent, wait: () => Promise.resolve(), usbLog: (k, i) => calls.logs.push([k, i]),
  };
  vm.createContext(sb);
  const lines = page.split('\n'), a = lines.findIndex(l => l.includes('---- Lossless master copy (laptop app only) ----')), b = lines.findIndex(l => l.includes('---- What guests see after scanning their QR'));
  assert(a > 0 && b > a, 'master block not found');
  const body = lines.slice(a, b).join('\n').replace(/const MASTER_PNG_KEY = 'pb4u.masterPng';/, "var MASTER_PNG_KEY = 'pb4u.masterPng';").replace(/\(function \(\) \{[\s\S]*$/, '');
  vm.runInContext(body, sb);
  sb.calls = calls; sb.store = store; sb.get = e => vm.runInContext(e, sb);
  return sb;
}
test('master PNG: on by default on the laptop app only, and the per-laptop setting turns it off', () => {
  assert.equal(masterSandbox({ desktop: false }).get('masterPngOn()'), false, 'tablet / web booth: never');
  assert.equal(masterSandbox({ desktop: true }).get('masterPngOn()'), true, 'laptop: default on');
  assert.equal(masterSandbox({ desktop: true, store: [['pb4u.masterPng', '0']] }).get('masterPngOn()'), false, 'turned off');
  assert.equal(masterSandbox({ desktop: true, store: [['pb4u.masterPng', '1']] }).get('masterPngOn()'), true);
});
await testAsync('master PNG: saved as <name>_master.png into the same event folder, lossless PNG, retried once, never throws', async () => {
  let sb = masterSandbox({ desktop: true });
  await sb.get('saveMasterPng')({}, '3_strip_cam2.jpg', { folderKey: 'Event', subfolder: 'A' });
  assert.deepEqual(sb.calls.uploads, [['3_strip_cam2_master.png', { folderKey: 'Event', subfolder: 'A' }]]); assert.equal(sb.calls.type, 'image/png');
  assert.equal(sb.calls.logs[0][1].ok, true); assert.equal(sb.calls.logs[0][1].kb, 8192);
  sb = masterSandbox({ desktop: true, fail: 1 });
  await sb.get('saveMasterPng')({}, '4_grid.jpg', {}); assert.equal(sb.calls.uploads.length, 2, 'one retry'); assert.equal(sb.calls.logs[0][1].ok, true);
  sb = masterSandbox({ desktop: true, fail: 9 });
  await sb.get('saveMasterPng')({}, '5_strip.jpg', {}); assert.equal(sb.calls.uploads.length, 2); assert.equal(sb.calls.logs[0][1].ok, false, 'gives up quietly');
  sb = masterSandbox({ desktop: true, fail: 9, permanent: true });
  await sb.get('saveMasterPng')({}, '6_strip.jpg', {}); assert.equal(sb.calls.uploads.length, 1, 'a permanent error is not retried');
  sb = masterSandbox({ desktop: true, noBlob: true });
  await sb.get('saveMasterPng')({}, '7_strip.jpg', {}); assert.equal(sb.calls.uploads.length, 0, 'no PNG made: nothing uploaded');
});
test('master PNG: wired into the save flow without waiting, the guest-link code skips it, and the toggle exists on the laptop app only', () => {
  assert(page.includes("if (masterPngOn()) saveMasterPng(flat, filename, dest);"), 'hook missing (it must not be awaited)');
  assert(!/await saveMasterPng/.test(page), 'the master must never be awaited');
  assert(page.includes('const isMaster = /_master\\.png$/i.test(filename'), 'upload must recognise a master');
  assert(page.includes('(!isMaster && (LOCALSHARE ||'), 'a master gets no guest code'); assert(page.includes('if (!isMaster) { try { gvAfterUpload('), 'a master skips the guest-link step');
  assert(page.includes("flat.getContext('2d', { alpha: false })"), 'opaque canvas keeps the PNG 24-bit');
  assert(/id="masterPngToggle"/.test(page) && /id="masterBox" style="margin-top:12px; display:none;"/.test(page), 'toggle hidden until the laptop app shows it');
});

// ---- the saved picture's size follows the camera: base for any camera, more only when the camera has the detail ----
test('output scale follows the camera: webcam / tablet photos keep the base size (2.5x laptop), a DSLR photo earns more (3x laptop, 2.5x tablet), within a memory limit', () => {
  const mk = mode => {
    const prev = { width: 1 }, sb = { previewCanvas: prev, DESKTOP: mode === 'desktop', LANREMOTE: false, TABLET_LOCAL: mode === 'tablet', LOCALSHARE: mode !== 'web', USB_SHOT_MAX: 3000, shotCanvases: [] };
    vm.createContext(sb);
    vm.runInContext(['isOutputTarget', 'cameraDetailScale', 'offlineOutputScale'].map(pageFunction).join('\n'), sb);
    const shot = (w, h) => { sb.shotCanvases.length = 0; sb.shotCanvases.push({ width: w, height: h, _isShot: true }); };
    return { sb, prev, shot, sc: kind => Math.round(sb.offlineOutputScale(prev, kind) * 1000) / 1000 };
  };
  let m = mk('desktop');
  assert.equal(m.sc('strip'), 2.5, 'no shot yet: base'); assert.equal(m.sc('sheet'), 2.5);
  m.shot(1280, 720); assert.equal(m.sc('strip'), 2.5, '720p webcam'); assert.equal(m.sc('sheet'), 2.5);
  m.shot(1920, 1080); assert.equal(m.sc('strip'), 2.5, '1080p webcam'); assert.equal(m.sc('sheet'), 2.5);
  m.shot(3840, 2160); assert.equal(m.sc('strip'), 3, '4K webcam: strip boxes are small, so it earns the cap'); assert.equal(m.sc('sheet'), 2.5, 'but a 4R box is too big for it');
  m.shot(4500, 3000); assert.equal(m.sc('strip'), 3, 'DSLR strip: capped at 3x'); assert.equal(m.sc('sheet'), 2.727, 'DSLR 4R: 3000 / 1100');
  m.shot(8000, 8000); assert.equal(m.sc('strip'), 3); assert.equal(m.sc('sheet'), 3);
  m.sb.shotCanvases.length = 0; m.sb.shotCanvases.push({ width: 6000, height: 4000 });   // not a shot (no _isShot): ignored
  assert.equal(m.sc('sheet'), 2.5);
  m.shot(4500, 3000);
  assert.equal(m.sb.offlineOutputScale({ width: 1 }, 'strip'), 1, 'a Setup thumbnail stays 1x'); assert.equal(m.sb.offlineOutputScale(m.prev, 'receipt'), 1, 'receipt stays 1x');
  m = mk('tablet');
  m.shot(1920, 1080); assert.equal(m.sc('strip'), 2.25); assert.equal(m.sc('sheet'), 2);
  m.shot(3600, 2400); assert.equal(m.sc('strip'), 2.5, 'tablet cap 2.5x'); assert.equal(m.sc('sheet'), 2.182, 'tablet 4R: 2400 / 1100');
  m.shot(8000, 8000); assert.equal(m.sc('strip'), 2.5); assert.equal(m.sc('sheet'), 2.357, '12 million pixel limit: sqrt(12e6 / 2.16e6)');
  m = mk('web');
  assert.equal(m.sc('strip'), 2); m.shot(1920, 1080); assert.equal(m.sc('sheet'), 2);
  m.shot(4500, 3000); assert.equal(m.sc('strip'), 2.5); assert.equal(m.sc('sheet'), 2.357);
});
// ---- the resolution tag: a saved photo says what it is (Windows showed 96 dpi for every file) ----
import { crc32 } from 'node:zlib';
function dpiSandbox() {
  const sb = { Uint8Array, Uint32Array, Blob, Math, Promise, Number };
  vm.createContext(sb);
  // The whole "Resolution tag" block of the page (it holds one-line functions, which pageFunction cannot cut out).
  const lines = page.split('\n'), i0 = lines.findIndex(l => l.includes('---- Resolution tag for saved photos ----')), i1 = lines.findIndex(l => l.includes('---- Signed upload ticket ----'));
  assert(i0 > 0 && i1 > i0, 'resolution-tag block not found in booth.html');
  vm.runInContext(lines.slice(i0, i1).join('\n'), sb);
  return sb;
}
const bytesOf = async b => new Uint8Array(await b.arrayBuffer());
const jfifJpeg = () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xDB, 0, 4, 1, 2, 0xFF, 0xD9]);
const exifJpeg = () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0, 0xFF, 0xDB, 0, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0xFF, 0xD9]);
function tinyPng(extra) {
  const chunk = (type, data) => { const t = Buffer.from(type), d = Buffer.from(data), out = Buffer.alloc(12 + d.length); out.writeUInt32BE(d.length, 0); t.copy(out, 4); d.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, d])), 8 + d.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), ...(extra || []), chunk('IDAT', [0x78, 0x9c, 0x63, 0, 0, 0, 4, 0, 1]), chunk('IEND', [])]));
}
test('dpi: nominal resolution is the long side over 6 inches (600x1800 strip = 300, 1350x4050 = 675, 4R 2400x3600 = 600)', () => {
  const f = dpiSandbox().pbNominalDpi;
  assert.equal(f({ width: 600, height: 1800 }), 300); assert.equal(f({ width: 1350, height: 4050 }), 675);
  assert.equal(f({ width: 2400, height: 3600 }), 600); assert.equal(f({ width: 3000, height: 2000 }), 500);
  assert.equal(f({ width: 0, height: 0 }), 300); assert.equal(f({ width: 9000, height: 9000 }), 1200, 'capped');
});
await testAsync('dpi: a JPEG with a JFIF header gets units = dots per inch and the dpi; the picture bytes are untouched', async () => {
  const sb = dpiSandbox(), src = jfifJpeg(), out = await bytesOf(await sb.pbStampDpi(new Blob([src], { type: 'image/jpeg' }), 675));
  assert.equal(out.length, src.length);
  assert.equal(out[13], 1, 'units'); assert.equal((out[14] << 8) | out[15], 675); assert.equal((out[16] << 8) | out[17], 675);
  assert.deepEqual([...out.slice(0, 13)], [...src.slice(0, 13)]); assert.deepEqual([...out.slice(18)], [...src.slice(18)]);
});
await testAsync('dpi: a JPEG that starts with Exif instead gets a JFIF header inserted, the rest kept', async () => {
  const sb = dpiSandbox(), src = exifJpeg(), res = await sb.pbStampDpi(new Blob([src], { type: 'image/jpeg' }), 300), out = await bytesOf(res);
  assert.equal(out.length, src.length + 18); assert.equal(res.type, 'image/jpeg');
  assert.deepEqual([...out.slice(0, 4)], [0xFF, 0xD8, 0xFF, 0xE0]); assert.equal(out[13], 1); assert.equal((out[14] << 8) | out[15], 300);
  assert.deepEqual([...out.slice(20)], [...src.slice(2)], 'original data follows the new segment');
});
await testAsync('dpi: a PNG gets a correct pHYs chunk (pixels per metre, valid CRC) right after IHDR; the rest is byte-identical', async () => {
  const sb = dpiSandbox(), src = tinyPng(), res = await sb.pbStampDpi(new Blob([src], { type: 'image/png' }), 300), out = await bytesOf(res);
  assert.equal(out.length, src.length + 21); assert.equal(res.type, 'image/png');
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint32(33), 9); assert.equal(String.fromCharCode(...out.slice(37, 41)), 'pHYs');
  assert.equal(dv.getUint32(41), 11811, '300 dpi = 11811 px/m'); assert.equal(dv.getUint32(45), 11811); assert.equal(out[49], 1);
  assert.equal(dv.getUint32(50), crc32(Buffer.from(out.slice(37, 50))) >>> 0, 'CRC');
  assert.deepEqual([...out.slice(0, 33)], [...src.slice(0, 33)]); assert.deepEqual([...out.slice(54)], [...src.slice(33)]);
});
await testAsync('dpi: a PNG that already has a resolution, or something that is not an image, is returned as it is', async () => {
  const sb = dpiSandbox(), withP = tinyPng([Buffer.from([0, 0, 0, 9, 0x70, 0x48, 0x59, 0x73, 0, 0, 0x0B, 0x13, 0, 0, 0x0B, 0x13, 1, 0, 0, 0, 0])]);
  const b1 = new Blob([withP], { type: 'image/png' }); assert.equal(await sb.pbStampDpi(b1, 600), b1);
  const b2 = new Blob([new Uint8Array(40)], { type: 'image/gif' }); assert.equal(await sb.pbStampDpi(b2, 600), b2);
  assert.equal(await sb.pbStampDpi(null, 300), null);
});
await testAsync('dpi: pbCanvasBlob stamps the canvas\'s own nominal dpi unless one is given', async () => {
  const sb = dpiSandbox(), cv = { width: 1350, height: 4050, toBlob: (cb) => cb(new Blob([jfifJpeg()], { type: 'image/jpeg' })) };
  let o = await bytesOf(await sb.pbCanvasBlob(cv, 'image/jpeg', 0.95)); assert.equal((o[14] << 8) | o[15], 675);
  o = await bytesOf(await sb.pbCanvasBlob(cv, 'image/jpeg', 0.95, 300)); assert.equal((o[14] << 8) | o[15], 300);
});
test('dpi: every place a finished photo is saved or shared stamps its resolution', () => {
  for (const needle of ["pbCanvasBlob(flat, 'image/jpeg', offlineJpegQuality('print'))", "pbCanvasBlob(flat, 'image/jpeg', offlineJpegQuality('solo'), 300)", "pbCanvasBlob(previewCanvas, 'image/png')", 'pbStampDpi(rawBlob, pbNominalDpi(previewCanvas))'])
    assert(page.includes(needle), 'missing: ' + needle);
  assert(!/previewCanvas\.toBlob\(res, 'image\/png'\)/.test(page), 'a plain PNG save is left');
});

// ---- Android tablet camera: full-size photo swapped in behind the instant frame ----
function tabletSandbox(opts) {
  opts = opts || {};
  const calls = { finalized: [], takePhoto: 0, logs: [] };
  const inst = { width: 1280, height: 720 };
  const bmp = { width: opts.photoW || 4000, height: opts.photoH || 3000, close() { } };
  const sb = {
    console, Math, Object, Array, Map, Set, Promise, Date, String, Number, Error, Uint8Array,
    IS_ANDROID_APP: !opts.desktop, DESKTOP: !!opts.desktop, USB_CAM_ID: 'usb-remote', UVC_ID: 'pb-uvc-webcam', currentDeviceId: 'cam0',
    webcamRes: { photo: opts.photo || 'hd' }, tabletStill: { jobs: new Set(), fails: 0, off: false, why: '', offDevice: '', maxW: 0, lastW: 0, lastH: 0, lastMs: 0, caps: null, capsTrack: null },
    ImageCapture: opts.noImageCapture ? undefined : function () { return { getPhotoCapabilities: async () => (opts.noCaps ? {} : { imageWidth: { max: opts.capMax || 4000 }, imageHeight: { max: Math.round((opts.capMax || 4000) * 0.75) }, fillLightMode: ['off', 'auto'] }), takePhoto: async o => { calls.takePhoto++; calls.opts = o; if (opts.slow) await new Promise(r => setTimeout(r, 40)); if (opts.reject) throw new Error('boom'); return { size: 999999 }; } }; },
    bgRep: { mode: opts.bgMode || 'off' },
    navigator: { deviceMemory: opts.mem === undefined ? 4 : opts.mem },
    isBuiltInCamera: () => opts.builtIn !== false,
    currentStream: { getVideoTracks: () => [opts.track || (opts.track = {})] },
    isJpegTruncated: async () => !!opts.truncated,
    createImageBitmap: async () => bmp,
    mirrorPreview: () => !!opts.mirror,
    document: { createElement: () => { const cv = { width: 0, height: 0 }; cv.getContext = () => ({ imageSmoothingEnabled: false, imageSmoothingQuality: '', translate() { }, scale() { }, drawImage: (...a) => { cv._draw = a; }, setTransform() { } }); return cv; } },
    inst, shotCanvases: [inst], sess: null, previewCanvas: { _renderedForLayout: 'strip' },
    TABLET_STILL_MAX_MS: opts.maxMs || 4500,
    finalizeShotCanvas: (c, i) => { calls.finalized.push([c, i]); sb.shotCanvases[i] = c; },
    usbLog: (k, i) => calls.logs.push([k, i]),
    popNum: () => { }, guestCall: () => { }, cdShot: { textContent: '' }, wait: ms => new Promise(r => setTimeout(r, ms)),
    setTimeout, clearTimeout,
  };
  vm.createContext(sb);
  const names = ['tabletStillEligible', 'tabletStillMaxPx', 'tabletStillUpgrade', 'tabletStillStart', 'tabletStillSettle'];
  vm.runInContext('const TABLET_STILL_MAX_MS = ' + (opts.maxMs || 4500) + ';\n' + names.map(pageFunction).join('\n'), sb);
  sb.calls = calls; sb.bmp = bmp; sb.get = expr => vm.runInContext(expr, sb);
  return sb;
}
const settle = sb => sb.get('tabletStillSettle')();
await testAsync('tablet still: the full-size photo replaces the instant frame, trimmed to the live view shape (4:3 -> 16:9), at most 3000 px', async () => {
  const sb = tabletSandbox(); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 1);
  assert.equal(sb.calls.opts.imageWidth, 4000, 'asks for the camera\'s biggest size');
  assert.equal(sb.calls.opts.fillLightMode, 'off', 'never fires the torch');
  const [c, i] = sb.calls.finalized[0]; assert.equal(i, 0);
  assert.equal(c.width, 3000); assert.equal(c.height, 1688, '16:9 like the live view, not 4:3');
  assert.deepEqual(c._draw.slice(1, 5), [0, 375, 4000, 2250], 'centre crop of the 4000x3000 photo');
  assert.equal(sb.previewCanvas._renderedForLayout, '', 'a strip drawn with the small frame is drawn again');
  assert.equal(sb.tabletStill.lastW, 3000);
});
await testAsync('tablet still: a 2 GB tablet gets a smaller photo and the camera\'s usual size', async () => {
  const sb = tabletSandbox({ mem: 2 }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.opts.imageWidth, undefined);
  assert.equal(sb.calls.finalized[0][0].width, 2200);
});
await testAsync('tablet still: not tried on a USB webcam, with background swap on, on a 1 GB tablet, in "preview" mode, or without ImageCapture', async () => {
  for (const o of [{ builtIn: false }, { bgMode: 'green' }, { mem: 1 }, { photo: 'preview' }, { photo: 'max' }, { noImageCapture: true }]) {
    const sb = tabletSandbox(o); sb.get('tabletStillStart')(0); await settle(sb);
    assert.equal(sb.calls.takePhoto, 0, JSON.stringify(o));
  }
  const sb = tabletSandbox(); sb.currentDeviceId = 'usb-remote'; sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 0, 'DSLR over USB');
});
await testAsync('laptop app: a built-in webcam on "Full camera resolution" also gets the full-size photo in the background; a USB webcam keeps its own path', async () => {
  let sb = tabletSandbox({ desktop: true, photo: 'max' }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 1); assert.equal(sb.calls.finalized.length, 1);
  sb = tabletSandbox({ desktop: true, photo: 'max', builtIn: false }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 0, 'USB webcam: handled by the full-resolution path');
  sb = tabletSandbox({ desktop: true, photo: 'preview' }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 0, 'operator chose the instant frame');
});
await testAsync('tablet still: a camera whose biggest photo is no bigger than its live view (720p laptop webcam) is skipped without taking a photo, and a different camera gets its own try', async () => {
  const sb = tabletSandbox({ desktop: true, photo: 'max', capMax: 1280 }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 0, 'no photo taken for nothing'); assert.equal(sb.tabletStill.off, true); assert.equal(sb.tabletStill.why, 'small'); assert.equal(sb.tabletStill.maxW, 1280);
  assert(sb.calls.logs.some(l => l[0] === 'tablet-still-skip'), 'logged');
  sb.get('tabletStillStart')(0); await settle(sb); assert.equal(sb.calls.takePhoto, 0, 'stays off for the same camera');
  sb.currentDeviceId = 'cam-two'; sb.webcamRes.photo = 'max';
  assert.equal(sb.get('tabletStillEligible')(), true, 'another camera is tried again');
});
await testAsync('tablet still: a camera that reports no photo sizes is still tried once (the Android WebView often reports none)', async () => {
  const sb = tabletSandbox({ noCaps: true }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 1); assert.equal(sb.calls.finalized.length, 1);
});
await testAsync('tablet still: a photo turned the other way, or not bigger than the live view, keeps the instant frame', async () => {
  let sb = tabletSandbox({ photoW: 3000, photoH: 4000 }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.finalized.length, 0, 'portrait photo vs landscape live view'); assert.equal(sb.tabletStill.fails, 1);
  sb = tabletSandbox({ photoW: 1280, photoH: 960 }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.finalized.length, 0, 'no bigger than the live view');
});
await testAsync('tablet still: a failure keeps the frame; a second failure switches it off for the day', async () => {
  const sb = tabletSandbox({ reject: true });
  sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.tabletStill.fails, 1); assert.equal(sb.tabletStill.off, false);
  sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.tabletStill.off, true); assert.equal(sb.calls.finalized.length, 0);
  assert(sb.calls.logs.some(l => l[0] === 'tablet-still-fail'), 'logged for "Copy camera log"');
  sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.calls.takePhoto, 2, 'no more attempts once off');
});
await testAsync('tablet still: a camera that is too slow is dropped at once (guests never wait twice)', async () => {
  const sb = tabletSandbox({ slow: true, maxMs: 10 }); sb.get('tabletStillStart')(0); await settle(sb);
  assert.equal(sb.tabletStill.off, true); assert.equal(sb.calls.finalized.length, 0);
});
await testAsync('tablet still: a photo retaken or a session cancelled meanwhile is not replaced and not counted as a failure', async () => {
  let sb = tabletSandbox(); sb.get('tabletStillStart')(0); sb.shotCanvases[0] = { width: 1280, height: 720 };   // retaken
  await settle(sb); assert.equal(sb.calls.finalized.length, 0);
  sb = tabletSandbox({ reject: true }); sb.get('tabletStillStart')(0); sb.sess = { cancelled: true };
  await settle(sb); assert.equal(sb.tabletStill.fails, 0, 'camera closed by Cancel');
});
test('tablet still: the "hd" mode exists only in the Android app and is the Android default', () => {
  assert(/value="hd"/.test(page), 'option in the page');
  assert(/IS_ANDROID_APP \? 'hd'/.test(page), 'Android default');
  assert(/option\[value="hd"\]/.test(page) && /hdOpt\.remove\(\)/.test(page), 'removed on every other platform');
  assert(/pb4u\.androidHdStillV1/.test(page), 'tablets left on the instant-only mode are moved once');
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
  assert.equal(ex.flash, -1, 'a photo with no Flash tag reports -1');
});

// ---- the camera's own record of its flash (EXIF Flash 0x9209) ----
await testAsync('flash: reads whether the flash fired, and warns when the shutter is faster than flash sync', async () => {
  const sb = makeSandbox(), u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, valOrOff) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(valOrOff), 0, 0] : u32(valOrOff))];
  // flash undefined = the photo has no Flash tag. The shutter is 1/<den> s.
  const jpegWith = (flash, den) => {
    const entries = [entry(0x829A, 5, flash === undefined ? 44 : 56)];
    if (flash !== undefined) entries.push(entry(0x9209, 3, flash));
    const tiff = [0x49, 0x49, 0x2A, 0, ...u32(8),
      ...u16(1), ...entry(0x8769, 4, 26), ...u32(0),                       // IFD0 -> Exif IFD at 26
      ...u16(entries.length), ...entries.flat(), ...u32(0),                // Exif IFD
      ...u32(1), ...u32(den)];                                             // the shutter: 1/den s
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, 0xFF, 0xD9]);
    return { slice: () => ({ arrayBuffer: async () => jpeg.buffer }) };
  };
  const read = (flash, den) => sb.get('pbReadExif')(jpegWith(flash, den));
  const text = sb.get('pbFlashText'), warn = sb.get('pbFlashWarnings');
  const fired = await read(0x19, 500), skipped = await read(0x10, 500), noTag = await read(undefined, 500);
  assert.equal(fired.flash, 0x19); assert.equal(skipped.flash, 0x10); assert.equal(noTag.flash, -1);
  assert.equal(text(fired), 'Flash fired');
  assert.equal(text(skipped), 'Flash did not fire');
  assert.equal(text(noTag), '', 'no record: say nothing rather than guess');
  assert.equal(text(null), '');
  assert.equal(await read(0, 500).then(text), 'Flash did not fire', 'Flash = 0 (no flash) is a record, not a missing tag');
  assert(/1\/500 s/.test(warn(fired)[0]), 'fired at 1/500: faster than sync, warned');
  assert.equal(warn(await read(0x19, 200)).length, 0, 'fired at 1/200: fine');
  assert.equal(warn(await read(0x19, 250)).length, 0, 'fired at 1/250: fine (the 60D syncs at 1/250)');
  assert.equal(warn(skipped).length, 0, 'no flash fired: nothing to warn about');
  assert.equal(warn(noTag).length, 0); assert.equal(warn(null).length, 0);

  // Per-model sync (Canon 6D = 1/180 s) & manual strobe mode ("Flash or strobe" selected even when EXIF flash=0).
  withCamera(sb, 'Canon EOS 6D', 'canon');
  const pCanon = sb.get('CAM_Q.canon');
  assert(/1\/200 s/.test(warn(await read(0x19, 200), 'Canon EOS 6D', 'flash', pCanon)[0]), '6D syncs at 1/180: 1/200 warns');
  assert(/1\/400 s/.test(warn(await read(0x10, 400), 'Canon EOS 6D', 'flash', pCanon)[0]), 'manual strobe/trigger (EXIF flash=0) still warns at 1/400 in flash mode');
  assert.equal(warn(await read(0x10, 160), 'Canon EOS 6D', 'flash', pCanon).length, 0, '1/160 is safe on 6D');
  assert.equal(warn(await read(0x10, 400), 'Canon EOS 6D', 'steady', pCanon).length, 0, 'steady light mode does not warn on 1/400');
});

// ---- the Camera check table (current settings against what suits the lighting) ----
test('camera check: rows for each lighting choice, per-model flash sync, brand mode names, and what to change', () => {
  const sb = makeSandbox();
  const rows = (brand, ex, light, name) => sb.get(`(function(){ return camGuideRows(${brand ? 'CAM_Q.' + brand : 'null'}, ${JSON.stringify(ex)}, ${JSON.stringify(light)}, ${JSON.stringify(name || '')}); })`)();
  const row = (r, k) => r.find(x => x.key === k);
  const status = r => r.map(x => x.key + ':' + x.status).join(' ');

  // Before any test shot: nothing to compare yet, but the suggestion is already there.
  const none = rows('canon', null, 'flash', 'Canon EOS 6D');
  assert.equal(status(none), 'mode:unknown shutter:unknown aperture:unknown iso:unknown flash:unknown');
  assert.deepEqual([row(none, 'mode').suggested, row(none, 'shutter').suggested, row(none, 'aperture').suggested, row(none, 'iso').suggested], ['M', '1/160 s', 'f/5.6', '400']);

  // The client's case: a Canon on aperture priority at f/2.8, ISO 1250, a slow shutter, and the flash did not fire.
  const bad = rows('canon', { program: 3, shutter: 1 / 60, f: 2.8, iso: 1250, flash: 0x10 }, 'flash', 'Canon EOS 60D');
  assert.equal(status(bad), 'mode:change shutter:change aperture:change iso:change flash:change');
  assert.equal(row(bad, 'mode').current, 'Av');
  assert(/mode dial/.test(row(bad, 'mode').how) && /M\.$/.test(row(bad, 'mode').how));
  assert(/Flash firing/.test(row(bad, 'flash').how) && /Silent LV shoot/.test(row(bad, 'flash').how), 'Canon advice names its own live view settings');
  assert.equal(row(bad, 'flash').current, 'Did not fire');

  // Good flash settings: nothing to change.
  const good = rows('canon', { program: 1, shutter: 1 / 160, f: 5.6, iso: 400, flash: 0x09 }, 'flash', 'Canon EOS 60D');
  assert.equal(status(good), 'mode:ok shutter:ok aperture:ok iso:ok flash:ok');
  assert.equal(good.filter(x => x.how).length, 0, 'only a row to change carries advice');

  // Flash sync differs per model: 1/200 s is fine on a 60D (1/250) and a D5600 (1/200), too fast on a 6D (1/180).
  const at200 = (brand, name) => row(rows(brand, { program: 1, shutter: 1 / 200, f: 5.6, iso: 400, flash: 1 }, 'flash', name), 'shutter');
  assert.equal(at200('canon', 'Canon EOS 60D').status, 'ok');
  assert.equal(at200('canon', 'Canon EOS 6D').status, 'change');
  assert(/sync/.test(at200('canon', 'Canon EOS 6D').how));
  assert.equal(at200('nikon', 'Nikon Corporation D5600').status, 'ok');
  assert.equal(row(rows('nikon', { program: 1, shutter: 1 / 250, f: 5.6, iso: 400, flash: 1 }, 'flash', 'Nikon D5600'), 'shutter').status, 'change');
  assert.equal(row(rows('canon', { program: 1, shutter: 1 / 200, f: 5.6, iso: 400, flash: 1 }, 'flash', 'Canon EOS 600D'), 'shutter').status, 'ok', '600D is not a 60D');

  // Brand names for the same EXIF mode: a Nikon calls aperture priority "A", a Canon "Av".
  assert.equal(row(rows('nikon', { program: 3, shutter: 1 / 100, f: 4, iso: 400, flash: 0 }, 'room', 'Nikon D5600'), 'mode').current, 'A');
  assert.equal(row(rows('canon', { program: 3, shutter: 1 / 100, f: 4, iso: 400, flash: 0 }, 'room', 'Canon EOS 6D'), 'mode').current, 'Av');
  assert.equal(row(rows(null, { program: 3, shutter: 1 / 100, f: 4, iso: 400, flash: 0 }, 'room', ''), 'mode').current, 'Av', 'a brand without a profile still gets a table');

  // Steady lights: the flash is not wanted. A flash that fired is shown, not flagged; a slow shutter is.
  const steady = rows('canon', { program: 1, shutter: 1 / 30, f: 4, iso: 800, flash: 1 }, 'steady', 'Canon EOS 6D');
  assert.equal(row(steady, 'flash').status, 'info');
  assert.equal(row(steady, 'shutter').status, 'change');
  assert(/blur/.test(row(steady, 'shutter').how));
  assert.equal(row(rows('canon', { program: 1, shutter: 1 / 125, f: 4, iso: 800, flash: 16 }, 'steady', 'Canon EOS 6D'), 'flash').status, 'ok');

  // Room light only: aperture priority and program are both fine; manual is not what the suggestion asks for.
  const roomMode = p => row(rows('canon', { program: p, shutter: 1 / 100, f: 4, iso: 800, flash: 16 }, 'room', 'Canon EOS 6D'), 'mode').status;
  assert.deepEqual([roomMode(3), roomMode(2), roomMode(1)], ['ok', 'ok', 'change']);
  const g = sb.get('camGuideNote');
  assert(/flash or steady lights/.test(g('room', { iso: 1 })), 'room light only: a flash or steady lights are recommended');
  assert(/test shot/.test(g('flash', null)) && g('flash', { iso: 1 }) === '');

  // Missing numbers never crash and are shown as a dash.
  const part = rows('sony', { program: 0, shutter: 0, f: 0, iso: 0, flash: -1 }, 'flash', 'Sony ILCE-7M3');
  assert.equal(status(part), 'mode:unknown shutter:unknown aperture:unknown iso:unknown flash:unknown');
  assert(part.every(x => x.current === '—'));
});

// ---- the EXIF reader returns the exposure mode ----
await testAsync('reads the exposure mode (ExposureProgram) from a JPEG\'s EXIF block', async () => {
  const sb = makeSandbox(), u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, valOrOff) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(valOrOff), 0, 0] : u32(valOrOff))];
  const jpegWith = program => {
    const entries = program === undefined ? [entry(0x8827, 3, 400)] : [entry(0x8822, 3, program), entry(0x8827, 3, 400)];
    const tiff = [0x49, 0x49, 0x2A, 0, ...u32(8), ...u16(1), ...entry(0x8769, 4, 26), ...u32(0), ...u16(entries.length), ...entries.flat(), ...u32(0)];
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, 0xFF, 0xD9]);
    return { slice: () => ({ arrayBuffer: async () => jpeg.buffer }) };
  };
  const read = p => sb.get('pbReadExif')(jpegWith(p));
  assert.equal((await read(1)).program, 1);
  assert.equal((await read(3)).program, 3);
  assert.equal((await read(undefined)).program, 0, 'no tag: 0 = not recorded');
  assert.equal((await read(3)).iso, 400, 'the other numbers still read with the extra tag present');
});

// ---- "Read from camera" and "Apply suggested settings" (the camera program answers; this is the booth's side of it) ----
await testAsync('camera check apply: reads the camera, sets only what differs, reports what the camera would not take', async () => {
  const sb = makeSandbox();
  const els = { camGuideApplyMsg: { style: {}, textContent: '' }, camGuideApplyRow: { style: { display: 'none' } } };
  sb.document.getElementById = id => els[id] || null;
  const asked = [];
  withCamera(sb, 'Nikon Corporation D5600', 'nikon');
  const now = { ok: true, supported: true, program: 3, shutter: 1 / 60, f: 2.8, iso: 1250, set: { shutter: false, f: true, iso: true } };
  sb.usbCam.camera.getExposure = async () => now;
  sb.usbCam.camera.setExposure = async want => { asked.push(JSON.stringify(want)); return { ok: true, supported: true, program: 3, shutter: 1 / 60, f: 5.6, iso: 400, results: { shutter: 'locked', f: 'set', iso: 'set' } }; };
  const ex = () => JSON.parse(JSON.stringify(sb.get('camGuideEx')));

  // Probe: the camera answers, so the buttons show and "Current" is filled before any photo (the flash is unknown until a photo).
  await sb.get('camGuideProbe')();
  assert.equal(sb.get('camGuideCan'), true);
  assert.equal(els.camGuideApplyRow.style.display, 'block');
  assert.deepEqual(ex(), { program: 3, shutter: 1 / 60, f: 2.8, iso: 1250, flash: -1 });

  // Apply (flash lighting): asks for 1/160 s, f/5.6, ISO 400 (numbers, in seconds / f-number / ISO), nothing about the mode.
  await sb.get('camGuideApply')();
  assert.deepEqual(asked, ['{"shutter":0.00625,"f":5.6,"iso":400}']);
  assert(/^Done, except: Shutter is set by the camera in its current mode/.test(els.camGuideApplyMsg.textContent), els.camGuideApplyMsg.textContent);
  assert(!/Aperture|ISO/.test(els.camGuideApplyMsg.textContent), 'the settings that were set are not listed as problems');
  assert.deepEqual(ex(), { program: 3, shutter: 1 / 60, f: 5.6, iso: 400, flash: -1 }, 'Current follows what the camera now says');

  // A camera reports its shutter in 0.0001 s counts: 1/160 s arrives as 0.0063 and is shown as 1/160, not 1/159.
  const snap = sb.get('pbSnapShutter');
  assert.deepEqual([0.0063, 0.0167, 0.01, 0.004, 0.0125, 0.0005, 0.5, 2, 0].map(snap), [1 / 160, 1 / 60, 1 / 100, 1 / 250, 1 / 80, 1 / 2000, 0.5, 2, 0]);

  // Everything already matches: nothing is sent.
  asked.length = 0;
  sb.get('camGuideSetExif')({ program: 1, shutter: 1 / 160, f: 5.6, iso: 400, flash: 1 });
  await sb.get('camGuideApply')();
  assert.equal(asked.length, 0);
  assert.equal(els.camGuideApplyMsg.textContent, 'Nothing to change: the settings already match.');

  // A camera that cannot be read from here: no buttons, nothing sent.
  sb.usbCam.camera.getExposure = async () => null;
  await sb.get('camGuideProbe')();
  assert.equal(sb.get('camGuideCan'), false);
  assert.equal(els.camGuideApplyRow.style.display, 'none');

  // A camera program without the feature (an older helper, or a camera made by libraries in the page): no crash, nothing to apply.
  sb.usbCam.camera = { info: {} };
  await sb.get('camGuideProbe')();
  await sb.get('camGuideApply')();
  assert.equal(sb.get('camGuideCan'), false);
  assert.equal(asked.length, 0);

  // The camera program's side of it exists in the page's client and in all three programs that answer it.
  assert(page.includes("'/camera/props'") && page.includes("'/camera/setprops?'"), 'the booth asks for /camera/props and /camera/setprops');
  for (const f of ['tools/print-helper/print-helper.js', 'desktop/lib/helper.mjs', 'android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert(src.includes('/camera/props') && src.includes('/camera/setprops'), f + ' answers /camera/props and /camera/setprops');
  }
  assert(readFileSync(join(ROOT, 'tools/print-helper/camera-worker.ps1'), 'utf8').includes('case "setprops"'), 'the Windows camera program has the setprops command');
});

// ---- solo shots on the laptop app: the camera's own file when the booth didn't change the picture ----
function rotJpeg(orientation) {
  const u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, val) => [...u16(tag), ...u16(type), ...u32(1), ...(type === 3 ? [...u16(val), 0, 0] : u32(val))];
  const ifd0 = orientation ? [...u16(2), ...entry(0x0112, 3, orientation), ...entry(0x8769, 4, 38), ...u32(0)]   // IFD0 at 8, 30 bytes: Exif IFD at 38
    : [...u16(1), ...entry(0x8769, 4, 26), ...u32(0)];                                                            // IFD0 at 8, 18 bytes: Exif IFD at 26
  const tiff = [0x49, 0x49, 0x2A, 0, ...u32(8), ...ifd0, ...u16(1), ...entry(0x8827, 3, 400), ...u32(0)];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, 0xFF, 0xD9]);
}
function soloSandbox(desktop) {
  const sb = { DESKTOP: desktop !== false, Blob, Uint8Array };
  vm.createContext(sb);
  vm.runInContext(['pbReadExif', 'soloOriginal'].map(pageFunction).join('\n'), sb);
  return sb;
}
await testAsync("solo shot: the camera's own file is kept untouched when it is an upright JPEG (laptop app)", async () => {
  const sb = soloSandbox();
  const up = new Blob([rotJpeg(1)], { type: 'image/jpeg' }), plain = new Blob([rotJpeg(0)], { type: 'image/jpeg' });
  assert.equal(await sb.soloOriginal({ _orig: up }), up, 'upright: the very same file');
  assert.equal(await sb.soloOriginal({ _orig: plain }), plain, 'no rotation mark: the very same file');
  const untyped = new Blob([rotJpeg(1)]);
  const out = await sb.soloOriginal({ _orig: untyped });
  assert.equal(out.type, 'image/jpeg'); assert.equal(out.size, untyped.size, 'same bytes, labelled as a JPEG');
  assert.equal((await sb.pbReadExif(new Blob([rotJpeg(6)]))).orientation, 6, 'the EXIF reader returns the rotation mark');
  assert.equal((await sb.pbReadExif(up)).iso, 400);
});
await testAsync("solo shot: the booth's own copy is used for a turned photo, a non-JPEG, no original, or off the laptop", async () => {
  const sb = soloSandbox();
  assert.equal(await sb.soloOriginal({ _orig: new Blob([rotJpeg(6)], { type: 'image/jpeg' }) }), null, 'portrait mark: would show sideways in thumbnails');
  // EXIF APP1 with IFD0 Orientation (0x0112 = 6) and NO Exif SubIFD (0x8769): must still detect rotation and reject.
  const u16 = v => [v & 255, v >> 8], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  const entry = (tag, type, val) => [...u16(tag), ...u16(type), ...u32(1), ...u16(val), 0, 0];
  const tiffNoSub = [0x49, 0x49, 0x2A, 0, ...u32(8), ...u16(1), ...entry(0x0112, 3, 6), ...u32(0)];
  const exifNoSub = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiffNoSub];
  const noSubJpeg = new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, (exifNoSub.length + 2) >> 8, (exifNoSub.length + 2) & 255, ...exifNoSub, 0xFF, 0xD9])], { type: 'image/jpeg' });
  assert.equal((await sb.pbReadExif(noSubJpeg)).orientation, 6, 'reads Orientation from IFD0 even without Exif SubIFD');
  assert.equal(await sb.soloOriginal({ _orig: noSubJpeg }), null, 'turned JPEG without Exif SubIFD uses booth copy');
  assert.equal(await sb.soloOriginal({ _orig: new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], { type: 'image/png' }) }), null, 'not a JPEG');
  assert.equal(await sb.soloOriginal({}), null); assert.equal(await sb.soloOriginal(null), null);
  assert.equal(await soloSandbox(false).soloOriginal({ _orig: new Blob([rotJpeg(1)], { type: 'image/jpeg' }) }), null, 'tablets / web booth keep their copy');
});
test('solo shot: the original is only kept when no mirror, background swap or look changed the picture (date stamp is omitted on solo shots)', () => {
  for (const needle of [
    'if (DESKTOP && !mir && !bgSwapped) c._orig = file;',                                   // DSLR
    'if (DESKTOP && !mir && !bgSwapped) c._orig = blob;',                                   // webcam full-size still
    "var soloLookFree = (typeof filterKey === 'undefined' || filterKey === 'none') && !softSkin;",
    'clone._orig = (soloLookFree && c._orig) || null;',
    'applyFilterToCanvas(clone, { noDateStamp: true });',
    'var blob = await soloOriginal(sc);',
    'var wantDate = !!(dateStamp && !(opts && opts.noDateStamp));',
    "if (filterKey === 'none' && !softSkin && !wantDate) return;",                           // applyFilterToCanvas: the same test for "no look"
    'var dateStamp = false;',
    'dateStampToggle.checked = false;'
  ]) assert(page.includes(needle), 'missing: ' + needle);
});

// ---- the brand files stay separate ----
test('each brand file mentions only its own brand, and the shared file mentions none', () => {
  const brands = { 'brand-nikon.js': /\b(canon|sony)\b/i, 'brand-canon.js': /\b(nikon|sony)\b/i, 'brand-sony.js': /\b(nikon|canon)\b/i, 'photo-quality.js': /\b(nikon|canon|sony)\b/i };
  for (const [f, bad] of Object.entries(brands)) { const m = bad.exec(part(f)); assert(!m, f + ' mentions "' + (m && m[0]) + '"'); }
});

// ---- webcam improvements ----
test('isUsbWebcamOption identifies external USB webcams (incl. DJI Osmo / iPad external) and rejects built-in, IR and virtual cameras', () => {
  const sb = makeSandbox();
  sb.UVC_ID = 'pb-uvc-webcam'; sb.IS_ANDROID_APP = false; sb.window = {};
  sb.nativeCam = { devicesById: { 'ipad-ext': { isExternal: true }, 'ipad-front': { isExternal: false } } };
  vm.runInContext(pageFunction('isUsbWebcamOption'), sb);
  const check = (id, label) => sb.get('isUsbWebcamOption')(id, label);
  for (const ext of ['Logitech BRIO', 'HD Pro Webcam C920', 'Razer Kiyo Pro', 'Elgato Facecam', 'OBSBOT Tiny 2', 'Anker PowerConf C200', 'USB Video Capture HDMI', 'Osmo Pocket 3', 'DJI Osmo Pocket 3', 'DJI Osmo Action 4', 'Pocket 3 (2ca3:0023)']) {
    assert.equal(check('dev-1', ext), true, 'expected external webcam: ' + ext);
  }
  assert.equal(check('ipad-ext', 'Unlisted External Cam'), true, 'iPad native external UVC camera is always external');
  assert.equal(check('ipad-front', 'Front Camera'), false, 'iPad front camera stays built-in');
  for (const skip of ['Microsoft Camera Front', 'Surface Camera Rear', 'Microsoft IR Camera Front', 'Windows Hello IR', 'Integrated Webcam', 'FaceTime HD Camera', 'OBS Virtual Camera']) {
    assert.equal(check('dev-2', skip), false, 'expected built-in/IR/virtual rejected: ' + skip);
  }
});
test('usbActionCamWhy gives plain-language hints for DJI Osmo and Insta360 USB modes on Android', () => {
  const sb = makeSandbox();
  vm.runInContext(pageFunction('usbActionCamWhy'), sb);
  const why = j => sb.get('usbActionCamWhy')(j);
  const djiStorage = why({ usb: [{ vid: 0x2ca3, pid: 0x0020, name: 'Osmo Pocket 3', ifaces: [8], perm: false }] });
  assert(djiStorage.includes('USB drive (storage) mode') && djiStorage.includes('tap Webcam'), 'DJI storage hint: ' + djiStorage);
  const djiPtp = why({ usb: [{ vid: 0x2ca3, pid: 0x0020, name: 'Osmo Pocket 3', ifaces: [6], perm: false }] });
  assert(djiPtp.includes('picture-transfer mode') && djiPtp.includes('tap Webcam'), 'DJI PTP hint: ' + djiPtp);
  const djiUvc = why({ native: false, usb: [{ vid: 0x2ca3, pid: 0x0023, name: 'Osmo Pocket 3', ifaces: [14], perm: true }] });
  assert(djiUvc.includes('plugged in as a webcam') && djiUvc.includes('powered USB-C hub'), 'DJI UVC hint: ' + djiUvc);
  const djiNative = why({ native: true, usb: [{ vid: 0x2ca3, pid: 0x0023, name: 'Osmo Pocket 3', ifaces: [14], perm: true }] });
  assert(djiNative.includes('already offering it'), 'DJI native UVC hint: ' + djiNative);
  const instaStorage = why({ usb: [{ vid: 0x2e1a, pid: 0x0001, name: 'Insta360 Ace Pro', ifaces: [8], perm: false }] });
  assert(instaStorage.includes('Settings > USB mode'), 'Insta360 hint preserved: ' + instaStorage);
  assert.equal(why({ usb: [{ vid: 0x046d, pid: 0x085e, name: 'Logitech BRIO', ifaces: [14], perm: true }] }), '');
});
test('isFrontCamera defaults to mirrored (true) for iPad external UVC cameras like DJI Osmo Pocket 3, while keeping back camera un-mirrored', () => {
  const sb = makeSandbox();
  sb.hasNativeCamBridge = () => true;
  sb.nativeCam = {
    active: true,
    meta: { isFront: false, isExternal: true, position: 'external' },
    devicesById: {
      'dji-ext': { isFront: false, isExternal: true, position: 'external', label: 'Osmo Pocket 3' },
      'ipad-back': { isFront: false, isExternal: false, position: 'back', label: 'Back Camera' },
      'ipad-front': { isFront: true, isExternal: false, position: 'front', label: 'Front Camera' },
    },
  };
  sb.cameraSelect = { selectedIndex: 0, options: [{ text: 'Osmo Pocket 3' }] };
  vm.runInContext(pageFunction('isFrontCamera'), sb);
  sb.currentDeviceId = 'dji-ext';
  assert.equal(sb.get('isFrontCamera()'), true, 'external Osmo Pocket 3 mirrors by default');
  sb.currentDeviceId = 'ipad-back';
  assert.equal(sb.get('isFrontCamera()'), false, 'iPad back camera stays un-mirrored');
  sb.currentDeviceId = 'ipad-front';
  assert.equal(sb.get('isFrontCamera()'), true, 'iPad front camera mirrors by default');
});
await testAsync('handleNativeCamEvent auto-switches to hot-plugged DJI Osmo Pocket 3 on iPad, recovers from disconnects, and never interrupts mid-capture', async () => {
  const sb = makeSandbox();
  const opened = [], toasts = [];
  let lostCalls = 0, layoutSyncs = 0;
  sb.hasNativeCamBridge = () => true;
  sb.nativeCam = { active: true, deviceId: 'ipad-front' };
  sb.currentDeviceId = 'ipad-front';
  sb.USB_CAM_ID = 'usb-remote';
  sb.camSleeping = false;
  sb.reconnectTimer = null;
  sb.streamActive = true;
  sb.state = 'ready';
  sb.cameraSelect = { value: 'ipad-front', options: [{ value: 'ipad-front' }] };
  sb.enumerateCameras = async () => {
    sb.cameraSelect.options = [{ value: 'ipad-front' }, { value: 'dji-ext' }];
  };
  sb.initCamera = async (id) => { opened.push(id); sb.currentDeviceId = id; sb.nativeCam.active = true; sb.nativeCam.deviceId = id; sb.streamActive = true; return true; };
  sb.showToast = (m) => toasts.push(m);
  sb.syncNativeCamLayout = () => { layoutSyncs++; };
  sb.cameraLost = () => { lostCalls++; sb.streamActive = false; sb.reconnectTimer = 123; };
  vm.runInContext(pageFunction('handleNativeCamEvent'), sb);

  // 1. Hot-plug DJI Osmo Pocket 3 while idle on iPad Front Camera -> switches automatically
  await sb.get('handleNativeCamEvent')({ type: 'connected', id: 'dji-ext', label: 'Osmo Pocket 3', isExternal: true });
  assert.deepEqual(opened, ['dji-ext'], 'auto-switched to Osmo Pocket 3');
  assert(toasts.some(t => t.includes('Osmo Pocket 3')), 'showed switch toast');

  // 2. Unplug Osmo Pocket 3 mid-event -> hides native layer and triggers cameraLost()
  await sb.get('handleNativeCamEvent')({ type: 'disconnected', id: 'dji-ext', label: 'Osmo Pocket 3', isExternal: true });
  assert.equal(sb.nativeCam.active, false);
  assert.equal(lostCalls, 1, 'triggered cameraLost on active external disconnect');
  assert.equal(layoutSyncs, 1, 'synced native layout on disconnect');

  // 3. Replug Osmo Pocket 3 while reconnecting -> cancels timer and reopens immediately
  await sb.get('handleNativeCamEvent')({ type: 'connected', id: 'dji-ext', label: 'Osmo Pocket 3', isExternal: true });
  assert.deepEqual(opened, ['dji-ext', 'dji-ext'], 'reconnected immediately on replug');
  assert.equal(sb.reconnectTimer, null, 'cleared reconnectTimer on reconnect');

  // 4. Plugging in another external camera mid-capture must NOT interrupt active shots
  sb.state = 'capturing';
  sb.enumerateCameras = async () => { sb.cameraSelect.options = [{ value: 'ipad-front' }, { value: 'dji-ext' }, { value: 'dji-2' }]; };
  await sb.get('handleNativeCamEvent')({ type: 'connected', id: 'dji-2', label: 'Osmo Pocket 3 #2', isExternal: true });
  assert.equal(opened.length, 2, 'did not switch cameras mid-capture');
});
test('iOS NativeCameraBridge & ViewController include retained external UVC discovery, hot-plug events, format picker, orientation & mirror guards', () => {
  const bridgeSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'NativeCameraBridge.swift'), 'utf8');
  const vcSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'ViewController.swift'), 'utf8');
  for (const needle of [
    'private var discoverySession: AVCaptureDevice.DiscoverySession?',
    '.AVCaptureDeviceWasConnected',
    '.AVCaptureDeviceWasDisconnected',
    'private func pickExternalFormat(for dev: AVCaptureDevice, presetName: String)',
    'effectivePreviewDimensions(rawW: rawW, rawH: rawH, isExternal: ext)',
    'private func applyPreviewMirror(_ mirror: Bool)',
    'previewLayer.bounds = bounds',
  ]) assert(bridgeSwift.includes(needle), 'NativeCameraBridge.swift missing: ' + needle);
  assert(vcSwift.includes('NativeCameraBridge.shared.onDeviceEvent'), 'ViewController.swift missing onDeviceEvent bridge');
  assert(vcSwift.includes('window.__pbCamEvent'), 'ViewController.swift missing window.__pbCamEvent dispatch');
  assert(vcSwift.includes('let askAudioThenBoot'), 'ViewController.swift serializes .video -> .audio permissions before booting');
  const licSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'AppLicence.swift'), 'utf8');
  assert(licSwift.includes('static let appVersion = "1.1.44"'), 'AppLicence.swift fallback version matches Xcode MARKETING_VERSION');
});
await testAsync('openCameraStream maps iPad external UVC camera for Greenscreen even after unlocking blank WebKit labels', async () => {
  const sb = makeSandbox();
  let gumCalls = [], unlocked = false, stoppedTracks = 0;
  sb.hasNativeCamBridge = () => true;
  sb.nativeCam = {
    devicesById: {
      'av-ext-1': { isFront: false, isExternal: true, position: 'external', label: 'DJI Osmo Pocket 3' }
    }
  };
  sb.cameraSelect = { options: [{ value: 'av-ext-1', textContent: 'DJI Osmo Pocket 3' }] };
  sb.webcamGumSize = () => ({ width: { ideal: 1280 }, height: { ideal: 720 } });
  sb.wait = async () => { };
  sb.navigator = {
    mediaDevices: {
      enumerateDevices: async () => unlocked
        ? [
          { kind: 'videoinput', deviceId: 'wk-front', label: 'Front Camera' },
          { kind: 'videoinput', deviceId: 'wk-osmo', label: 'Osmo Pocket 3 UVC' }
        ]
        : [{ kind: 'videoinput', deviceId: 'wk-1', label: '' }],
      getUserMedia: async (constraints) => {
        gumCalls.push(constraints);
        if (constraints.video === true && !unlocked) {
          unlocked = true;
          return { getTracks: () => [{ stop: () => { stoppedTracks++; } }] };
        }
        return { id: 'stream-for-' + (constraints.video && constraints.video.deviceId && constraints.video.deviceId.exact) };
      }
    }
  };
  vm.runInContext(pageFunction('openCameraStream'), sb);
  const stream = await sb.get('openCameraStream')('av-ext-1');
  assert.equal(stoppedTracks, 1, 'stopped temporary label-unlock stream cleanly');
  assert.equal(stream.id, 'stream-for-wk-osmo', 'mapped NativeCameraBridge external UVC camera to WebKit UVC deviceId');
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

// ---- offline high-res output scaling & prewarm ----
test('camQPrewarm runs without requiring tips() and marks _hiRes canvas', () => {
  const sb = makeSandbox();
  let composed = null;
  sb.setTimeout = fn => { fn(); return 0; };
  sb.composeCanvas = (lay, cv) => { composed = cv; };
  withCamera(sb, 'Canon EOS 60D', 'canon');
  assert.equal(sb.get('CAM_Q.canon.tips()'), false);
  sb.shotCanvases.push({ _cq: 'canon' });
  sb.get('camQPrewarm(CAM_Q.canon, false)');
  assert(composed && composed._hiRes === true, 'prewarm ran without tips() on a _hiRes canvas');
  composed = null;
  sb.get('camQPrewarm(CAM_Q.canon, true)');
  assert.equal(composed, null, 'finalShot skips prewarm');
});
test('offlineOutputScale, offlineShotMaxPx, and offlineJpegQuality enforce ~5x desktop quality without scaling UI thumbnails or online mode', () => {
  const mkOfflineSb = (mode) => {
    const prev = { width: 1 }, thumb = { width: 1 }, hi = { _hiRes: true };
    const sb = {
      previewCanvas: prev,
      DESKTOP: mode === 'desktop',
      LANREMOTE: mode === 'lan',
      TABLET_LOCAL: mode === 'tablet',
      LOCALSHARE: mode !== 'online',
      USB_SHOT_MAX: 3000,
      shotCanvases: [],
    };
    vm.createContext(sb);
    vm.runInContext(['isOutputTarget', 'cameraDetailScale', 'offlineOutputScale', 'offlineShotMaxPx', 'offlineJpegQuality'].map(pageFunction).join('\n'), sb);
    return { sb, prev, thumb, hi };
  };
  const d = mkOfflineSb('desktop');
  assert.equal(d.sb.offlineOutputScale(d.prev, 'strip'), 2.5);
  assert.equal(d.sb.offlineOutputScale(d.hi, 'sheet'), 2.5);
  assert.equal(d.sb.offlineOutputScale(d.hi, 'receipt'), 1);
  assert.equal(d.sb.offlineOutputScale(d.thumb, 'strip'), 1, 'UI thumbnails stay 1x');
  assert.equal(d.sb.offlineShotMaxPx(), 4500);
  assert.equal(d.sb.offlineJpegQuality('print'), 1, 'laptop prints: 100% JPEG (3-7 MB)');
  assert.equal(d.sb.offlineJpegQuality('solo'), 1, 'laptop solo shots drawn by the booth: 100% JPEG');
  assert.equal(d.sb.offlineJpegQuality('gif'), 0.96, 'anything else on the laptop keeps 96%');
  const t = mkOfflineSb('tablet');
  assert.equal(t.sb.offlineOutputScale(t.prev, 'strip'), 2.25);
  assert.equal(t.sb.offlineOutputScale(t.hi, 'sheet'), 2);
  assert.equal(t.sb.offlineShotMaxPx(), 3600);
  assert.equal(t.sb.offlineJpegQuality('print'), 0.95);
  const o = mkOfflineSb('online');
  assert.equal(o.sb.offlineOutputScale(o.prev, 'strip'), 2, 'web booth: 2x');
  assert.equal(o.sb.offlineOutputScale(o.thumb, 'strip'), 1, 'web booth thumbnails stay 1x');
  assert.equal(o.sb.offlineOutputScale(o.hi, 'receipt'), 1);
  assert.equal(o.sb.offlineShotMaxPx(), 3000);
  assert.equal(o.sb.offlineJpegQuality('print'), 0.95);
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
