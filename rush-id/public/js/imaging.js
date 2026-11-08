// Photo decoding, AI background removal, face finding and ID cropping. Everything runs on the device.
// The gated /rush version sets window.__RUSH.vendor; the standalone app uses /vendor/.
const BASE = (window.__RUSH && window.__RUSH.vendor) || '/vendor/';

export async function decodeFile(blob, maxSide = 2400) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (e) { throw new Error('This photo cannot be opened. Use JPG or PNG (iPhone HEIC photos: send them with the QR option).'); }
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

export const canvasToBlob = (c, type = 'image/jpeg', q = 0.95) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save image'))), type, q));

export async function thumbURL(blob, side = 360) {
  const c = await decodeFile(blob, side);
  return URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.8));
}

// ---------- MediaPipe (self-hosted in /vendor) ----------
let visionP = null;
function vision() {
  if (!visionP) {
    visionP = (async () => {
      const mod = await import(BASE + 'vision_bundle.mjs');
      const simd = await mod.FilesetResolver.isSimdSupported();
      const name = BASE + 'wasm/vision_wasm_' + (simd ? '' : 'nosimd_') + 'internal';
      return { mod, fileset: { wasmLoaderPath: name + '.js', wasmBinaryPath: name + '.wasm' } };
    })();
    visionP.catch(() => { visionP = null; });
  }
  return visionP;
}

let segP = null;
function segmenter() {
  if (!segP) {
    segP = vision().then(({ mod, fileset }) => mod.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: BASE + 'selfie_segmenter.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
    }));
    segP.catch(() => { segP = null; });
  }
  return segP;
}

let faceP = null;
function faceDetector() {
  if (!faceP) {
    faceP = vision().then(({ mod, fileset }) => mod.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: BASE + 'blaze_face_short_range.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE', minDetectionConfidence: 0.5,
    }));
    faceP.catch(() => { faceP = null; });
  }
  return faceP;
}

// Warm both up while the customer is choosing, so the editor opens fast.
export function preload() { segmenter().catch(() => {}); faceDetector().catch(() => {}); }

// Person confidence mask: { w, h, data: Float32Array } (0..1)
export async function personConfidence(canvas) {
  const seg = await segmenter();
  const res = seg.segment(canvas);
  try {
    const m = res.confidenceMasks[0];
    return { w: m.width, h: m.height, data: new Float32Array(m.getAsFloat32Array()) };
  } finally { res.close && res.close(); }
}

// Biggest face as { x, y, w, h } in canvas pixels, or null.
export async function findFace(canvas) {
  const fd = await faceDetector();
  const res = fd.detect(canvas);
  let best = null;
  for (const d of res.detections || []) {
    const b = d.boundingBox; if (!b) continue;
    if (!best || b.width * b.height > best.w * best.h) best = { x: b.originX, y: b.originY, w: b.width, h: b.height };
  }
  return best;
}

// edge: -1 (softer / keeps more) .. +1 (tighter / removes more)
export function makeCutout(work, conf, edge = 0) {
  const lo = 0.3 + edge * 0.15, hi = 0.7 + edge * 0.15;
  const mc = document.createElement('canvas'); mc.width = conf.w; mc.height = conf.h;
  const mx = mc.getContext('2d'), id = mx.createImageData(conf.w, conf.h), d = id.data;
  for (let i = 0, j = 3; i < conf.data.length; i++, j += 4) {
    let v = (conf.data[i] - lo) / (hi - lo);
    v = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    d[j] = v * 255;
  }
  mx.putImageData(id, 0, 0);
  const out = document.createElement('canvas'); out.width = work.width; out.height = work.height;
  const ox = out.getContext('2d');
  ox.drawImage(work, 0, 0);
  ox.globalCompositeOperation = 'destination-in';
  ox.imageSmoothingQuality = 'high';
  try { ox.filter = 'blur(1px)'; } catch (e) { /* not supported: edges are still soft from scaling */ }
  ox.drawImage(mc, 0, 0, out.width, out.height);
  return out;
}

// ---------- Better cut-out: MODNet portrait matting (ONNX Runtime web, on the device) ----------
// MODNet gives a soft alpha matte (hair, shoulders), much finer than the small segmentation model above.
// Steps: matte at ~512 px -> blown up to a 1280 px grid -> guided filter (edges snap to the real photo edges, hair strands stay)
// -> levels -> applied to the full-size photo. A touch-up brush keeps its strokes in `edits` (erase / restore) on the same grid.
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
let modnetP = null;
function modnet() {
  if (!modnetP) {
    modnetP = (async () => {
      await loadScript(BASE + 'ort/ort.wasm.min.js');
      const ort = window.ort;
      ort.env.wasm.wasmPaths = BASE + 'ort/'; ort.env.wasm.numThreads = 1;      // (more threads barely help this model)
      const session = await ort.InferenceSession.create(BASE + 'modnet.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { ort, session };
    })();
    modnetP.catch(() => { modnetP = null; });
  }
  return modnetP;
}
export function preloadMatting() { modnet().catch(() => {}); }
export const mattingReady = () => { let r = false; modnetP && modnetP.then(() => { r = true; }); return r; };

// Running mean over a (2r+1) box, edges averaged over what exists. In: Float32Array w*h.
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), P = new Float64Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w; P[0] = 0; for (let x = 0; x < w; x++) P[x + 1] = P[x] + src[o + x];
    for (let x = 0; x < w; x++) { const a = Math.max(0, x - r), b = Math.min(w, x + r + 1); tmp[o + x] = (P[b] - P[a]) / (b - a); }
  }
  for (let x = 0; x < w; x++) {
    P[0] = 0; for (let y = 0; y < h; y++) P[y + 1] = P[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) { const a = Math.max(0, y - r), b = Math.min(h, y + r + 1); out[y * w + x] = (P[b] - P[a]) / (b - a); }
  }
  return out;
}
// Guided filter (He et al.): q follows p, but its edges follow the guide I.
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mP = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], c = mIp[i] - mI[i] * mP[i]; a[i] = c / (v + eps); b[i] = mP[i] - a[i] * mI[i]; }
  const mA = boxMean(a, w, h, r), mB = boxMean(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mA[i] * I[i] + mB[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
}

// Returns { gw, gh, alpha: Float32Array(gw*gh) in 0..1 } for the photo `img` (a canvas).
export async function computeMatte(img, ref = 384) {
  const T = { t0: performance.now() };
  const { ort, session } = await modnet(); T.load = performance.now() - T.t0;
  const k = ref / Math.min(img.width, img.height);
  const iw = Math.max(32, Math.round(img.width * k / 32) * 32), ih = Math.max(32, Math.round(img.height * k / 32) * 32);
  const c = document.createElement('canvas'); c.width = iw; c.height = ih;
  const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, iw, ih);
  const d = x.getImageData(0, 0, iw, ih).data, n = iw * ih, t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { t[i] = d[i * 4] / 127.5 - 1; t[n + i] = d[i * 4 + 1] / 127.5 - 1; t[2 * n + i] = d[i * 4 + 2] / 127.5 - 1; }
  T.prep = performance.now() - T.t0 - T.load; const tr = performance.now();
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, ih, iw]) });
  const a = out[session.outputNames[0]].data; T.model = performance.now() - tr;
  // matte -> 1280 px grid (smooth blow-up through a canvas)
  const G = Math.min(1, 1280 / Math.max(img.width, img.height)), gw = Math.max(8, Math.round(img.width * G)), gh = Math.max(8, Math.round(img.height * G));
  const mc = document.createElement('canvas'); mc.width = iw; mc.height = ih;
  const mx = mc.getContext('2d'), mid = mx.createImageData(iw, ih);
  for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(1, a[i])) * 255; mid.data[i * 4] = v; mid.data[i * 4 + 1] = v; mid.data[i * 4 + 2] = v; mid.data[i * 4 + 3] = 255; }
  mx.putImageData(mid, 0, 0);
  const gc = document.createElement('canvas'); gc.width = gw; gc.height = gh;
  const gx = gc.getContext('2d', { willReadFrequently: true }); gx.imageSmoothingQuality = 'high';
  gx.drawImage(mc, 0, 0, gw, gh); const up = gx.getImageData(0, 0, gw, gh).data;
  const P = new Float32Array(gw * gh); for (let i = 0; i < P.length; i++) P[i] = up[i * 4] / 255;
  gx.drawImage(img, 0, 0, gw, gh); const im = gx.getImageData(0, 0, gw, gh).data;       // the photo itself, as the guide
  const I = new Float32Array(gw * gh); for (let i = 0; i < I.length; i++) I[i] = (0.299 * im[i * 4] + 0.587 * im[i * 4 + 1] + 0.114 * im[i * 4 + 2]) / 255;
  const r = Math.max(4, Math.round(gw / 150)), tg = performance.now();
  const alpha = guidedFilter(I, P, gw, gh, r, 4e-4); T.guided = performance.now() - tg;
  return { gw, gh, alpha, raw: P, timing: T };
}

// Touch-up strokes: E = erased, R = restored (0..255 per matte pixel).
export const newEdits = (m) => ({ E: new Uint8Array(m.gw * m.gh), R: new Uint8Array(m.gw * m.gh), undo: [] });
export function snapshotEdits(ed) { ed.undo.push([ed.E.slice(), ed.R.slice()]); if (ed.undo.length > 12) ed.undo.shift(); }
export function undoEdits(ed) { const s = ed.undo.pop(); if (!s) return false; ed.E.set(s[0]); ed.R.set(s[1]); return true; }
export function clearEdits(ed) { ed.E.fill(0); ed.R.fill(0); ed.undo.length = 0; }
// One soft round dab at (gx, gy) with radius rad (matte pixels). mode 'erase' | 'restore'.
export function paintDab(ed, gw, gh, gx, gy, rad, mode) {
  const x0 = Math.max(0, Math.floor(gx - rad)), x1 = Math.min(gw - 1, Math.ceil(gx + rad)), y0 = Math.max(0, Math.floor(gy - rad)), y1 = Math.min(gh - 1, Math.ceil(gy + rad));
  const own = mode === 'erase' ? ed.E : ed.R, other = mode === 'erase' ? ed.R : ed.E;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dd = Math.hypot(x - gx, y - gy); if (dd > rad) continue;
    const w = Math.min(1, (1 - dd / rad) * 2.2), i = y * gw + x, v = w * 255;
    if (v > own[i]) own[i] = v;
    other[i] = other[i] * (1 - w);
  }
}

// The photo with the background removed, same size as the photo. edge: -1 (keeps more) .. +1 (removes more).
export function buildCutout(work, edge = 0, edits = null) {
  const M = work.matte, gw = M.gw, gh = M.gh, lo = 0.10 + 0.2 * edge, hi = 0.90 + 0.05 * edge;
  const ac = document.createElement('canvas'); ac.width = gw; ac.height = gh;
  const ax = ac.getContext('2d'), id = ax.createImageData(gw, gh), d = id.data, E = edits && edits.E, R = edits && edits.R;
  for (let i = 0, n = gw * gh; i < n; i++) {
    let v = (M.alpha[i] - lo) / (hi - lo); v = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    if (E) { if (E[i]) v *= 1 - E[i] / 255; if (R[i]) v += (1 - v) * R[i] / 255; }
    d[i * 4 + 3] = v * 255;
  }
  ax.putImageData(id, 0, 0);
  const out = document.createElement('canvas'); out.width = work.img.width; out.height = work.img.height;
  const ox = out.getContext('2d');
  ox.drawImage(work.img, 0, 0);
  ox.globalCompositeOperation = 'destination-in'; ox.imageSmoothingQuality = 'high';
  ox.drawImage(ac, 0, 0, out.width, out.height);
  return out;
}

// ---------- ID cropping ----------
// crop = { cx, cy, h } : centre of the frame and frame height, in work-image pixels.
// The frame width follows the size being drawn, so every size of a package keeps the head the same height.
export const HEAD_TARGET = { top: 0.10, chin: 0.78 };   // head fills 10% .. 78% of the photo height

export function autoCrop(face, w, h, aspect) {
  if (!face) {
    const fh = Math.min(h, w / aspect);
    return { cx: w / 2, cy: h / 2, h: fh };
  }
  const headH = face.h * 1.42;                                   // detector box is brow-to-chin; add hair
  const H = headH / (HEAD_TARGET.chin - HEAD_TARGET.top);
  const chinY = face.y + face.h * 1.02;
  const top = chinY - headH - HEAD_TARGET.top * H;
  return { cx: face.x + face.w / 2, cy: top + H / 2, h: H };
}

// Draw the framed photo into ctx at (0,0,outW,outH).
export function drawId(ctx, work, o, outW, outH) {
  ctx.save();
  ctx.fillStyle = o.bg === 'checker' ? '#ffffff' : (o.bg || '#ffffff');
  ctx.fillRect(0, 0, outW, outH);
  if (o.bg === 'checker') { const q = Math.max(8, Math.round(outW / 28)); ctx.fillStyle = '#c9c9c9'; for (let y = 0; y * q < outH; y++) for (let x = (y % 2); x * q < outW; x += 2) ctx.fillRect(x * q, y * q, q, q); }
  const src = o.bg && work.cut ? work.cut : work.img;
  const H = o.crop.h, W = H * outW / outH;
  ctx.imageSmoothingQuality = 'high';
  const f = [];
  if (o.brightness) f.push('brightness(' + (1 + o.brightness / 100) + ')');
  if (o.contrast) f.push('contrast(' + (1 + o.contrast / 100) + ')');
  if (f.length) { try { ctx.filter = f.join(' '); } catch (e) { /* unsupported browser: no adjustment */ } }
  if (o.flip) { ctx.translate(outW, 0); ctx.scale(-1, 1); }                    // mirror the photo (about the middle of the frame)
  ctx.drawImage(src, o.crop.cx - W / 2, o.crop.cy - H / 2, W, H, 0, 0, outW, outH);
  ctx.restore();
}
