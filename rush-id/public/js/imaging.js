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
  ctx.fillStyle = o.bg || '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
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
