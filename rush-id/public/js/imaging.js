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
export function preload() { segmenter().catch(() => { }); faceDetector().catch(() => { }); }

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
export function preloadMatting() { modnet().catch(() => { }); }
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

export function autoCrop(face, w, h, aspect, headTarget = HEAD_TARGET) {
  const target = headTarget || HEAD_TARGET;
  if (!face) {
    const fh = Math.min(h, w / aspect);
    return { cx: w / 2, cy: h / 2, h: fh };
  }
  const headH = face.h * 1.42;                                   // detector box is brow-to-chin; add hair
  const H = headH / (target.chin - target.top);
  const chinY = face.y + face.h * 1.02;
  const top = chinY - headH - target.top * H;
  return { cx: face.x + face.w / 2, cy: top + H / 2, h: H };
}

// Draw the framed photo into ctx at (0,0,outW,outH).
export const ATTIRES = [
  { id: 'none', label: 'None (Original)', desc: 'Keep your own clothes', notchY: 0.12 },
  { id: 'suit-black', label: 'Black Suit', desc: 'Formal black suit, white shirt & dark tie', notchY: 0.117 },
  { id: 'suit-navy', label: 'Navy Blazer', desc: 'Navy blue blazer, white shirt & burgundy tie', notchY: 0.119 },
  { id: 'barong', label: 'Barong Tagalog', desc: 'Authentic Philippine embroidered Barong', notchY: 0.138 },
  { id: 'blazer-women', label: "Women's Blazer", desc: 'Tailored dark blazer & white scoop blouse', notchY: 0.180 },
  { id: 'polo-white', label: 'White Polo', desc: 'Crisp white collared pique polo', notchY: 0.120 },
];

const ATTIRE_CACHE = new Map();

export function getAttireImage(id, onReady = null) {
  if (!id || id === 'none') return null;
  if (ATTIRE_CACHE.has(id)) {
    const cached = ATTIRE_CACHE.get(id);
    if (onReady && !cached.complete) cached.addEventListener('load', onReady, { once: true });
    return cached;
  }
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  const basePath = typeof window !== 'undefined' && window.location && window.location.pathname.startsWith('/rush') ? '/rush/attire/' : 'attire/';
  img.src = basePath + id + '.png';
  img.onerror = () => {
    if (!img.src.includes('/rush/attire/')) {
      img.src = '/rush/attire/' + id + '.png';
    } else {
      img.src = 'attire/' + id + '.png';
    }
  };
  if (onReady) img.addEventListener('load', onReady, { once: true });
  ATTIRE_CACHE.set(id, img);
  return img;
}

export function preloadAttires(onAnyReady = null) {
  if (typeof window === 'undefined') return;
  for (const a of ATTIRES) {
    if (a.id !== 'none') getAttireImage(a.id, onAnyReady);
  }
}

export function applySkinEnhance(ctx, outW, outH, { smoothing = 0 } = {}) {
  if (!smoothing || smoothing <= 0) return;
  const k = Math.min(1, Math.max(0, smoothing / 100));
  const rad = Math.max(2, Math.round(outH * 0.012 * k));
  const tmp = document.createElement('canvas');
  tmp.width = outW;
  tmp.height = outH;
  const tx = tmp.getContext('2d');
  try {
    tx.filter = 'blur(' + rad + 'px)';
  } catch (e) {
    return;
  }
  tx.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.38 * k;
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

export function drawNameTag(ctx, nameTag, outW, outH) {
  if (!nameTag || !nameTag.on || !nameTag.text) return;
  const tagH = Math.max(24, Math.round(outH * 0.16));
  const tagY = outH - tagH;
  const text = String(nameTag.text).trim().toUpperCase();
  const sub = String(nameTag.sub || '').trim().toUpperCase();
  if (!text) return;

  ctx.save();
  // Solid white banner with crisp border
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, tagY, outW, tagH);
  ctx.lineWidth = Math.max(1, Math.round(outH * 0.005));
  ctx.strokeStyle = '#1e293b';
  ctx.strokeRect(0, tagY, outW, tagH);

  // Auto-measure text size
  const pad = Math.round(outW * 0.04);
  const maxW = outW - pad * 2;
  let fontSize = Math.round(tagH * (sub ? 0.44 : 0.58));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = 'bold ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  while (ctx.measureText(text).width > maxW && fontSize > 8) {
    fontSize--;
    ctx.font = 'bold ' + fontSize + 'px system-ui, -apple-system, sans-serif';
  }

  ctx.fillStyle = '#0f172a';
  if (sub) {
    ctx.fillText(text, outW / 2, tagY + tagH * 0.36);
    let subSize = Math.max(7, Math.round(fontSize * 0.65));
    ctx.font = '600 ' + subSize + 'px system-ui, -apple-system, sans-serif';
    while (ctx.measureText(sub).width > maxW && subSize > 6) {
      subSize--;
      ctx.font = '600 ' + subSize + 'px system-ui, -apple-system, sans-serif';
    }
    ctx.fillStyle = '#475569';
    ctx.fillText(sub, outW / 2, tagY + tagH * 0.74);
  } else {
    ctx.fillText(text, outW / 2, tagY + tagH * 0.52);
  }
  ctx.restore();
}

export function drawAttire(ctx, attireId, outW, outH, {
  yOffset = 0,
  xOffset = 0,
  scale = 1,
  angle = 0,
  collarSpread = 1,
  cleanNeck = true
} = {}, work = null, o = null) {
  if (!attireId || attireId === 'none') return;

  const attireMeta = ATTIRES.find((a) => a.id === attireId) || ATTIRES[1];

  // 1. Calculate dynamic chin and neck anchor
  let chinCanvasX = outW / 2;
  let chinCanvasY = outH * 0.69;
  let faceCanvasW = outW * 0.38;

  if (work && work.face && o && o.crop) {
    const H = o.crop.h;
    const W = (H * outW) / outH;
    const scaleRatio = outH / H;
    const cropLeft = o.crop.cx - W / 2;
    const cropTop = o.crop.cy - H / 2;

    let faceCenterX = work.face.x + work.face.w / 2;
    if (o.flip) {
      faceCenterX = (work.img ? work.img.width : outW) - faceCenterX;
    }
    const chinY = work.face.y + work.face.h * 1.02;

    chinCanvasX = (faceCenterX - cropLeft) * scaleRatio;
    chinCanvasY = (chinY - cropTop) * scaleRatio;
    faceCanvasW = work.face.w * scaleRatio;
  }

  // Anchor position adjusted by user X and Y nudges
  const anchorX = chinCanvasX + (xOffset || 0) * outW * 0.15;
  const anchorY = chinCanvasY + (yOffset || 0) * outH * 0.15;
  const angleRad = ((angle || 0) * Math.PI) / 180;

  // 2. Try drawing high-resolution photographic studio template
  const img = getAttireImage(attireId);
  if (img && img.complete && img.naturalWidth > 0) {
    // Proportional shoulder width based on detected face width or frame width
    const baseW = Math.max(outW * 0.88, Math.min(outW * 1.35, faceCanvasW * 2.85));
    const drawW = baseW * (scale || 1) * (collarSpread || 1);
    const drawH = (drawW / img.naturalWidth) * img.naturalHeight;
    const notchX = drawW / 2;
    const notchY = drawH * (attireMeta.notchY || 0.12);

    // 2a. Under-collar clean neck backing (covers casual t-shirt collars)
    if (cleanNeck) {
      ctx.save();
      ctx.translate(anchorX, anchorY);
      ctx.rotate(angleRad);
      const shieldW = drawW * 0.22;
      const shieldH = outH * 0.12;
      ctx.beginPath();
      ctx.moveTo(-shieldW / 2, -outH * 0.015);
      ctx.quadraticCurveTo(0, shieldH * 0.85, shieldW / 2, -outH * 0.015);
      ctx.lineTo(shieldW / 2, shieldH);
      ctx.lineTo(-shieldW / 2, shieldH);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }

    // 2b. Soft ambient contact shadow on the neck
    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.rotate(angleRad);
    const shadowH = outH * 0.04 * (scale || 1);
    const shadowW = outW * 0.20 * (scale || 1);
    const sGrad = ctx.createRadialGradient(0, shadowH * 0.25, outH * 0.005, 0, shadowH * 0.25, shadowW);
    sGrad.addColorStop(0, 'rgba(0,0,0,0.26)');
    sGrad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
    sGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sGrad;
    ctx.beginPath();
    ctx.ellipse(0, shadowH * 0.25, shadowW, shadowH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2c. Photographic attire with lighting harmonization
    ctx.save();
    ctx.translate(anchorX, anchorY);
    ctx.rotate(angleRad);
    if (o && (o.brightness || o.contrast || o.autoEnhance)) {
      const b = 1 + (o.brightness || 0) / 180 + (o.autoEnhance ? 0.03 : 0);
      const c = 1 + (o.contrast || 0) / 220 + (o.autoEnhance ? 0.04 : 0);
      try { ctx.filter = 'brightness(' + b.toFixed(2) + ') contrast(' + c.toFixed(2) + ')'; } catch (e) {}
    }
    ctx.drawImage(img, -notchX, -notchY, drawW, drawH);
    ctx.restore();
    return;
  }

  // 3. Fallback: Procedural vector drawing with chin anchoring and tilt
  const baseY = anchorY;
  const cx = anchorX;

  ctx.save();
  ctx.translate(cx, baseY);
  ctx.rotate(angleRad);
  ctx.scale(scale * (collarSpread || 1), scale);
  ctx.translate(-cx, -baseY);

  if (attireId === 'suit-black' || attireId === 'suit-navy') {
    const isNavy = attireId === 'suit-navy';
    const coatColor = isNavy ? '#0f172a' : '#18181b';
    const lapelColor = isNavy ? '#1e293b' : '#27272a';
    const lapelHighlight = isNavy ? '#334155' : 'rgba(255,255,255,0.12)';
    const tieColor = isNavy ? '#881337' : '#1c1917';
    const tieKnot = isNavy ? '#9f1239' : '#292524';

    // 1. Inner white dress shirt collar base
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.12, baseY);
    ctx.lineTo(cx, baseY + outH * 0.04);
    ctx.lineTo(cx + outW * 0.12, baseY);
    ctx.lineTo(cx + outW * 0.07, baseY + outH * 0.10);
    ctx.lineTo(cx - outW * 0.07, baseY + outH * 0.10);
    ctx.closePath();
    ctx.fill();

    // 2. Left collar flap
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.13, baseY);
    ctx.lineTo(cx - outW * 0.04, baseY + outH * 0.095);
    ctx.lineTo(cx - outW * 0.01, baseY + outH * 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = Math.max(1, outW * 0.003);
    ctx.stroke();

    // 3. Right collar flap
    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.13, baseY);
    ctx.lineTo(cx + outW * 0.04, baseY + outH * 0.095);
    ctx.lineTo(cx + outW * 0.01, baseY + outH * 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 4. Necktie knot & tie body
    ctx.fillStyle = tieKnot;
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.035, baseY + outH * 0.04);
    ctx.lineTo(cx + outW * 0.035, baseY + outH * 0.04);
    ctx.lineTo(cx + outW * 0.025, baseY + outH * 0.088);
    ctx.lineTo(cx - outW * 0.025, baseY + outH * 0.088);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = tieColor;
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.025, baseY + outH * 0.088);
    ctx.lineTo(cx + outW * 0.025, baseY + outH * 0.088);
    ctx.lineTo(cx + outW * 0.07, outH + 15);
    ctx.lineTo(cx - outW * 0.07, outH + 15);
    ctx.closePath();
    ctx.fill();

    // Tie center highlight / stripes
    ctx.fillStyle = isNavy ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)';
    ctx.fillRect(cx - outW * 0.008, baseY + outH * 0.088, outW * 0.016, outH);

    // 5. Suit coat body & shoulders
    ctx.fillStyle = coatColor;
    // Left shoulder
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.13, baseY);
    ctx.lineTo(-outW * 0.1, baseY + outH * 0.14);
    ctx.lineTo(-outW * 0.1, outH + 15);
    ctx.lineTo(cx - outW * 0.02, outH + 15);
    ctx.lineTo(cx - outW * 0.02, baseY + outH * 0.22);
    ctx.lineTo(cx - outW * 0.07, baseY + outH * 0.09);
    ctx.closePath();
    ctx.fill();

    // Right shoulder
    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.13, baseY);
    ctx.lineTo(outW * 1.1, baseY + outH * 0.14);
    ctx.lineTo(outW * 1.1, outH + 15);
    ctx.lineTo(cx + outW * 0.02, outH + 15);
    ctx.lineTo(cx + outW * 0.02, baseY + outH * 0.22);
    ctx.lineTo(cx + outW * 0.07, baseY + outH * 0.09);
    ctx.closePath();
    ctx.fill();

    // 6. Notched Lapels
    ctx.fillStyle = lapelColor;
    // Left lapel
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.13, baseY);
    ctx.lineTo(cx - outW * 0.18, baseY + outH * 0.07);
    ctx.lineTo(cx - outW * 0.14, baseY + outH * 0.08);
    ctx.lineTo(cx - outW * 0.02, baseY + outH * 0.22);
    ctx.lineTo(cx - outW * 0.07, baseY + outH * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lapelHighlight;
    ctx.lineWidth = Math.max(1, outW * 0.002);
    ctx.stroke();

    // Right lapel
    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.13, baseY);
    ctx.lineTo(cx + outW * 0.18, baseY + outH * 0.07);
    ctx.lineTo(cx + outW * 0.14, baseY + outH * 0.08);
    ctx.lineTo(cx + outW * 0.02, baseY + outH * 0.22);
    ctx.lineTo(cx + outW * 0.07, baseY + outH * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Single suit coat button closure
    ctx.fillStyle = '#09090b';
    ctx.beginPath();
    ctx.arc(cx, baseY + outH * 0.25, Math.max(2, outW * 0.012), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#52525b';
    ctx.stroke();
  } else if (attireId === 'barong') {
    // 1. Base cream piña/jusi fabric
    ctx.fillStyle = '#faf6ee';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.12, baseY);
    ctx.lineTo(-outW * 0.1, baseY + outH * 0.14);
    ctx.lineTo(-outW * 0.1, outH + 15);
    ctx.lineTo(outW * 1.1, outH + 15);
    ctx.lineTo(outW * 1.1, baseY + outH * 0.14);
    ctx.lineTo(cx + outW * 0.12, baseY);
    ctx.closePath();
    ctx.fill();

    // 2. Traditional Mandarin collar
    ctx.fillStyle = '#f3ebe0';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.13, baseY);
    ctx.quadraticCurveTo(cx, baseY + outH * 0.03, cx + outW * 0.13, baseY);
    ctx.lineTo(cx + outW * 0.12, baseY + outH * 0.045);
    ctx.quadraticCurveTo(cx, baseY + outH * 0.075, cx - outW * 0.12, baseY + outH * 0.045);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c4a675';
    ctx.lineWidth = Math.max(1, outW * 0.004);
    ctx.stroke();

    // 3. Embroidered U-shaped Pechera
    ctx.fillStyle = '#f5ede0';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.11, baseY + outH * 0.05);
    ctx.lineTo(cx - outW * 0.11, baseY + outH * 0.22);
    ctx.quadraticCurveTo(cx - outW * 0.11, baseY + outH * 0.28, cx, baseY + outH * 0.28);
    ctx.quadraticCurveTo(cx + outW * 0.11, baseY + outH * 0.28, cx + outW * 0.11, baseY + outH * 0.22);
    ctx.lineTo(cx + outW * 0.11, baseY + outH * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner embroidery border
    ctx.strokeStyle = '#d7bea0';
    ctx.lineWidth = Math.max(1, outW * 0.002);
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.085, baseY + outH * 0.06);
    ctx.lineTo(cx - outW * 0.085, baseY + outH * 0.21);
    ctx.quadraticCurveTo(cx - outW * 0.085, baseY + outH * 0.25, cx, baseY + outH * 0.25);
    ctx.quadraticCurveTo(cx + outW * 0.085, baseY + outH * 0.25, cx + outW * 0.085, baseY + outH * 0.21);
    ctx.lineTo(cx + outW * 0.085, baseY + outH * 0.06);
    ctx.stroke();

    // 4. Center placket
    ctx.fillStyle = '#ece3d2';
    ctx.fillRect(cx - outW * 0.02, baseY + outH * 0.05, outW * 0.04, outH);
    ctx.strokeStyle = '#c4a675';
    ctx.strokeRect(cx - outW * 0.02, baseY + outH * 0.05, outW * 0.04, outH);

    // 5. Pearl buttons
    for (let i = 0; i < 4; i++) {
      const by = baseY + outH * (0.08 + i * 0.055);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, by, Math.max(2, outW * 0.012), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#b89968';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 6. Vertical decorative pin-tucks
    ctx.strokeStyle = 'rgba(196,166,117,0.35)';
    ctx.lineWidth = 1;
    for (const dx of [-0.06, -0.04, 0.04, 0.06]) {
      ctx.beginPath();
      ctx.moveTo(cx + outW * dx, baseY + outH * 0.07);
      ctx.lineTo(cx + outW * dx, baseY + outH * 0.23);
      ctx.stroke();
    }
  } else if (attireId === 'blazer-women') {
    // 1. Inner blouse scoop neckline
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.12, baseY);
    ctx.quadraticCurveTo(cx, baseY + outH * 0.16, cx + outW * 0.12, baseY);
    ctx.lineTo(cx + outW * 0.12, outH + 15);
    ctx.lineTo(cx - outW * 0.12, outH + 15);
    ctx.closePath();
    ctx.fill();

    // 2. Blazer shoulders & coat
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.11, baseY);
    ctx.lineTo(-outW * 0.1, baseY + outH * 0.14);
    ctx.lineTo(-outW * 0.1, outH + 15);
    ctx.lineTo(cx - outW * 0.01, outH + 15);
    ctx.lineTo(cx - outW * 0.01, baseY + outH * 0.24);
    ctx.quadraticCurveTo(cx - outW * 0.10, baseY + outH * 0.14, cx - outW * 0.11, baseY);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.11, baseY);
    ctx.lineTo(outW * 1.1, baseY + outH * 0.14);
    ctx.lineTo(outW * 1.1, outH + 15);
    ctx.lineTo(cx + outW * 0.01, outH + 15);
    ctx.lineTo(cx + outW * 0.01, baseY + outH * 0.24);
    ctx.quadraticCurveTo(cx + outW * 0.10, baseY + outH * 0.14, cx + outW * 0.11, baseY);
    ctx.closePath();
    ctx.fill();

    // 3. Curved shawl lapels
    ctx.fillStyle = '#334155';
    // Left shawl
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.11, baseY);
    ctx.quadraticCurveTo(cx - outW * 0.15, baseY + outH * 0.10, cx - outW * 0.01, baseY + outH * 0.24);
    ctx.quadraticCurveTo(cx - outW * 0.08, baseY + outH * 0.14, cx - outW * 0.11, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = Math.max(1, outW * 0.003);
    ctx.stroke();

    // Right shawl
    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.11, baseY);
    ctx.quadraticCurveTo(cx + outW * 0.15, baseY + outH * 0.10, cx + outW * 0.01, baseY + outH * 0.24);
    ctx.quadraticCurveTo(cx + outW * 0.08, baseY + outH * 0.14, cx + outW * 0.11, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Button
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(cx, baseY + outH * 0.27, Math.max(2, outW * 0.014), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#64748b';
    ctx.stroke();
  } else if (attireId === 'polo-white') {
    // 1. Shirt body
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.12, baseY);
    ctx.lineTo(-outW * 0.1, baseY + outH * 0.14);
    ctx.lineTo(-outW * 0.1, outH + 15);
    ctx.lineTo(outW * 1.1, outH + 15);
    ctx.lineTo(outW * 1.1, baseY + outH * 0.14);
    ctx.lineTo(cx + outW * 0.12, baseY);
    ctx.closePath();
    ctx.fill();

    // 2. Center placket
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - outW * 0.035, baseY + outH * 0.05, outW * 0.07, outH);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = Math.max(1, outW * 0.003);
    ctx.strokeRect(cx - outW * 0.035, baseY + outH * 0.05, outW * 0.07, outH);

    // 3. Collar wings
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - outW * 0.13, baseY);
    ctx.lineTo(cx - outW * 0.05, baseY + outH * 0.11);
    ctx.lineTo(cx - outW * 0.01, baseY + outH * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + outW * 0.13, baseY);
    ctx.lineTo(cx + outW * 0.05, baseY + outH * 0.11);
    ctx.lineTo(cx + outW * 0.01, baseY + outH * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 4. Buttons
    for (let i = 0; i < 3; i++) {
      const by = baseY + outH * (0.09 + i * 0.06);
      ctx.fillStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.arc(cx, by, Math.max(2, outW * 0.012), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
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
  if (o.autoEnhance) {
    f.push('brightness(1.04)');
    f.push('contrast(1.05)');
    f.push('saturate(1.08)');
  }
  if (f.length) { try { ctx.filter = f.join(' '); } catch (e) { /* unsupported browser: no adjustment */ } }
  if (o.flip) { ctx.translate(outW, 0); ctx.scale(-1, 1); }                    // mirror the photo (about the middle of the frame)
  ctx.drawImage(src, o.crop.cx - W / 2, o.crop.cy - H / 2, W, H, 0, 0, outW, outH);
  ctx.restore();

  // Skin smoothing pass
  if (o.skinSmooth) {
    applySkinEnhance(ctx, outW, outH, { smoothing: o.skinSmooth });
  }

  // Formal attire overlay
  if (o.attire && o.attire !== 'none') {
    drawAttire(ctx, o.attire, outW, outH, {
      yOffset: o.attireY || 0,
      xOffset: o.attireX || 0,
      scale: o.attireScale || 1,
      angle: o.attireAngle || 0,
      collarSpread: o.attireCollar || 1,
      cleanNeck: o.attireCleanNeck !== false
    }, work, o);
  }

  // Name Tag banner overlay
  if (o.nameTag && o.nameTag.on) {
    drawNameTag(ctx, o.nameTag, outW, outH);
  }
}
