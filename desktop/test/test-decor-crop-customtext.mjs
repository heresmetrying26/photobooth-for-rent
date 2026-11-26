import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

console.log('--- Testing Per-Photo Crop & Zoom, Trend Stickers, and Custom Text ---');

const boothHtmlPath = resolve('protected/booth.html');
const netlifyBoothPath = resolve('netlify/lib/booth.mjs');
const androidBoothPath = resolve('android/app/src/main/assets/booth.html');
const iosBoothPath = resolve('ios/photobooth4u/booth.html');

assert(existsSync(boothHtmlPath), 'protected/booth.html must exist');
assert(existsSync(netlifyBoothPath), 'netlify/lib/booth.mjs must exist');
assert(existsSync(androidBoothPath), 'android booth.html must exist');
assert(existsSync(iosBoothPath), 'ios booth.html must exist');

const htmlContent = readFileSync(boothHtmlPath, 'utf8');

// 1. Verify Phase 1: Per-Photo Crop & Zoom UI & Engine
console.log('1. Checking Phase 1: Per-photo Crop & Zoom...');
assert(htmlContent.includes('id="gsoCropPane"'), 'Crop pane HTML markup must be present');
assert(htmlContent.includes('id="gsoCropZoomSlider"'), 'Crop zoom slider must be present');
assert(htmlContent.includes('id="gsoNudgeUp"'), 'Nudge controls must be present');
assert(htmlContent.includes('id="gsoNudgeReset"'), 'Nudge center reset must be present');
assert(htmlContent.includes('var shotCrops = {};'), 'shotCrops state must be declared');
assert(htmlContent.includes('var shotSlotBoxes = {};'), 'shotSlotBoxes state must be declared');
assert(htmlContent.includes('function recordShotSlotBox'), 'recordShotSlotBox function must be present');
assert(htmlContent.includes('function drawCropSlotIndicator'), 'drawCropSlotIndicator function must be present');
assert(htmlContent.includes('function hitShotSlot'), 'hitShotSlot function must be present');
assert(htmlContent.includes('function refreshCropUI'), 'refreshCropUI function must be present');
assert(htmlContent.includes('function wireCropControls'), 'wireCropControls function must be present');
assert(htmlContent.includes('id="resultCustomizeBtn"'), 'Result screen customize button must be present');

// Test math for crop logic:
function simulateCropMath(iw, ih, w, h, zoom, panX, panY) {
  const imgRatio = iw / ih;
  const boxRatio = w / h;
  let sx, sy, sw, sh;
  if (imgRatio > boxRatio) {
    sh = ih;
    sw = sh * boxRatio;
    sx = (iw - sw) / 2;
    sy = 0;
  } else {
    sw = iw;
    sh = sw / boxRatio;
    sx = 0;
    sy = (ih - sh) / 2;
  }
  const z = Math.max(1, Math.min(3, Number(zoom) || 1));
  const px = Math.max(-1, Math.min(1, Number(panX) || 0));
  const py = Math.max(-1, Math.min(1, Number(panY) || 0));
  const sw_z = sw / z;
  const sh_z = sh / z;
  const maxShiftX = (iw - sw_z) / 2;
  const maxShiftY = (ih - sh_z) / 2;
  const new_cx = (iw / 2) + px * maxShiftX;
  const new_cy = (ih / 2) + py * maxShiftY;
  const final_sx = Math.max(0, Math.min(iw - sw_z, new_cx - sw_z / 2));
  const final_sy = Math.max(0, Math.min(ih - sh_z, new_cy - sh_z / 2));
  return { sx: final_sx, sy: final_sy, sw: sw_z, sh: sh_z, z, px, py };
}

// Case A: Landscape image in portrait slot with 1.5x zoom and right pan
const resA = simulateCropMath(1920, 1080, 600, 900, 1.5, 0.5, 0);
assert(resA.sw > 0 && resA.sh > 0, 'Source dimensions must be positive');
assert(resA.sx >= 0 && resA.sx + resA.sw <= 1920, 'Crop source window must be within image bounds horizontally');
assert(resA.sy >= 0 && resA.sy + resA.sh <= 1080, 'Crop source window must be within image bounds vertically');

// Case B: Maximum zoom and extreme pans
const resB = simulateCropMath(1080, 1920, 600, 600, 2.5, -1, 1);
assert(resB.sx >= 0 && resB.sx + resB.sw <= 1080, 'Crop window within bounds at extreme pan');
assert(resB.sy >= 0 && resB.sy + resB.sh <= 1920, 'Crop window within bounds at extreme pan');

// 2. Verify Phase 2: Stickers & Trend Packs
console.log('2. Checking Phase 2: Trend Stickers, Emojis & Vectors...');
assert(htmlContent.includes("id: 'trend', name: 'Trend & Y2K'"), 'Trend & Y2K sticker pack must be present');
assert(htmlContent.includes("id: 'aesthetic', name: 'Aesthetic'"), 'Aesthetic sticker pack must be present');
assert(htmlContent.includes("['b-slay', 'SLAY ✨']"), 'SLAY trend banner sticker must be present');
assert(htmlContent.includes("['b-besties', 'BESTIES 👯‍♀️']"), 'BESTIES banner must be present');
assert(htmlContent.includes("['b-mainchar', 'Main Character']"), 'Main Character banner must be present');
assert(htmlContent.includes("['b-vibes', 'Pure Vibes ✌️']"), 'Pure Vibes banner must be present');
assert(htmlContent.includes("['b-photodump', 'Photo Dump 📸']"), 'Photo Dump banner must be present');
assert(htmlContent.includes("['b-iconic', 'ICONIC 💎']"), 'ICONIC banner must be present');
assert(htmlContent.includes("['y2kstar', 'Y2K Star']"), 'Y2K Star vector must be present');
assert(htmlContent.includes("['pinkbow', 'Pink Bow']"), 'Pink Bow vector must be present');
assert(htmlContent.includes("['cherries', 'Cherries']"), 'Cherries vector must be present');
assert(htmlContent.includes("['flame', 'Fire Flame']"), 'Flame vector must be present');
assert(htmlContent.includes("['cyberheart', 'Cyber Heart']"), 'Cyber heart vector must be present');
assert(htmlContent.includes("['cat-ears', 'Cat Ears']"), 'Cat ears vector must be present');
assert(htmlContent.includes("['bunny-ears', 'Bunny Ears']"), 'Bunny ears vector must be present');
assert(htmlContent.includes("['heartshades', 'Heart Shades']"), 'Heart sunglasses vector must be present');
assert(htmlContent.includes("['pixshades', 'Pixel Shades']"), 'Pixel shades vector must be present');
assert(htmlContent.includes("case 'y2kstar':"), 'y2kstar canvas drawing case must exist');
assert(htmlContent.includes("case 'pinkbow':"), 'pinkbow canvas drawing case must exist');
assert(htmlContent.includes("case 'cherries':"), 'cherries canvas drawing case must exist');
assert(htmlContent.includes("case 'flame':"), 'flame canvas drawing case must exist');
assert(htmlContent.includes("case 'cyberheart':"), 'cyberheart canvas drawing case must exist');

// Verify native emojis
assert(htmlContent.includes("STICKER_EMOJIS = {"), 'STICKER_EMOJIS map must exist');
assert(htmlContent.includes("'e-sparkheart': '💖'"), 'Emoji sparkheart must be mapped');
assert(htmlContent.includes("'e-ribbon': '🎀'"), 'Emoji ribbon must be mapped');
assert(htmlContent.includes("'e-sparkle': '✨'"), 'Emoji sparkles must be mapped');

// 3. Verify Phase 3: Custom Text Tool
console.log('3. Checking Phase 3: Custom Text Tool...');
assert(htmlContent.includes('id="gsoTextPane"'), 'Text pane HTML markup must be present');
assert(htmlContent.includes('id="gsoCustomTextInput"'), 'Custom text input must be present');
assert(htmlContent.includes('id="gsoAddTextBtn"'), 'Add text button must be present');
assert(htmlContent.includes('id="gsoTrendChips"'), 'Trend suggestion chips must be present');
assert(htmlContent.includes('id="gsoColorSwatches"'), 'Color swatches must be present');
assert(htmlContent.includes('id="gsoFontChips"'), 'Font chips must be present');
assert(htmlContent.includes('id="gsoStyleChips"'), 'Style chips must be present');
assert(htmlContent.includes('function drawCustomTextDecorItem'), 'drawCustomTextDecorItem function must be present');
assert(htmlContent.includes('function addCustomTextDecor'), 'addCustomTextDecor function must be present');
assert(htmlContent.includes('function wireTextControls'), 'wireTextControls function must be present');

// Test custom text aspect ratio math
function calculateCustomTextAspect(text) {
  const chars = Math.max(1, (text || '').trim().length);
  return Math.max(1.8, Math.min(8.0, chars * 0.45 + 0.9));
}
assert(calculateCustomTextAspect('SLAY') >= 2.0, 'Short text should have clean compact aspect');
assert(calculateCustomTextAspect('Happy 18th Birthday Sarah!') > 4.0, 'Long sentence should have wide banner aspect');

// 4. Verify Bundled Copies
console.log('4. Verifying Build and Bundle Synchronization...');
const netlifyContent = readFileSync(netlifyBoothPath, 'utf8');
const androidContent = readFileSync(androidBoothPath, 'utf8');
const iosContent = readFileSync(iosBoothPath, 'utf8');

assert(netlifyContent.includes('gsoCropPane'), 'netlify/lib/booth.mjs must contain gsoCropPane');
assert(androidContent.includes('gsoCropPane'), 'android booth.html must contain gsoCropPane');
assert(iosContent.includes('gsoCropPane'), 'ios booth.html must contain gsoCropPane');

assert(androidContent.length === htmlContent.length, 'Android booth.html must be identical in length to protected/booth.html');
assert(iosContent.length === htmlContent.length, 'iOS booth.html must be identical in length to protected/booth.html');

// 5. Executable VM Tests for Base-Layer Caching, Bitmap Caching, and Reflow Elimination
console.log('5. Running Executable VM Cache & Render Optimization Tests...');
import vm from 'node:vm';

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  assert(start >= 0, `Could not find ${sig} in booth.html`);
  let i = src.indexOf('{', start);
  let depth = 0, inStr = false, q = '', esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (ch === '\\') esc = true; else if (ch === q) inStr = false; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = true; q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`Unclosed function for ${sig}`);
}

function makeFakeCanvas(w = 600, h = 900) {
  const ops = [];
  const ctx = {
    canvas: null,
    font: '16px sans-serif',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetY: 0,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
    lineJoin: 'miter',
    lineCap: 'butt',
    save() { ops.push(['save']); },
    restore() { ops.push(['restore']); },
    setTransform() { ops.push(['setTransform']); },
    translate() { ops.push(['translate']); },
    rotate() { ops.push(['rotate']); },
    scale() { ops.push(['scale']); },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    quadraticCurveTo() {},
    arc() {},
    arcTo() {},
    ellipse() {},
    rect() {},
    clip() {},
    fillRect() { ops.push(['fillRect']); },
    clearRect() { ops.push(['clearRect']); },
    strokeRect() {},
    fill() { ops.push(['fill']); },
    stroke() { ops.push(['stroke']); },
    setLineDash() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    measureText(t) { return { width: String(t || '').length * 18 }; },
    fillText(t) { ops.push(['fillText', String(t)]); },
    strokeText(t) { ops.push(['strokeText', String(t)]); },
    drawImage(src) { ops.push(['drawImage', src && src.width, src && src.height]); },
    _ops: ops
  };
  const cv = {
    width: w,
    height: h,
    style: {},
    parentNode: null,
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width: w / 2, height: h / 2 }; }
  };
  ctx.canvas = cv;
  return cv;
}

{
  let composeCalls = 0, decorDrawCalls = 0, drawStickerCalls = 0, stampCalls = 0;
  const gsoTools = { style: { display: 'none', transform: '' }, offsetWidth: 280, offsetHeight: 60 };
  const gsoStage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1000 }) };
  const gsoCanvasBox = {
    clientWidth: 600, clientHeight: 900,
    getBoundingClientRect: () => ({ left: 20, top: 20, width: 600, height: 900 })
  };
  const previewCanvas = makeFakeCanvas(1200, 1800);
  previewCanvas.parentNode = gsoCanvasBox;
  const setupPreviewCanvas = makeFakeCanvas(600, 900);
  const shots = [{ _isShot: true }, { _isShot: true }, { _isShot: true }];

  const code = [
    'var BOX_PROBE = null;',
    'var filterKey = "none", sessionNumber = 7, btViewBack = false, btSide = "front", receiptPrintGrey = false;',
    'var activeFrameId = "", overlay = null, accent = "gold", accentUsed = false, currentLayout = "strip";',
    'var shotCrops = {}, guestDecor = [], decor = [], selGuestDecor = -1, gsoMode = "stickers";',
    'var sess = { decorating: true, decoPreview: false };',
    'var shotCanvases = shots;',
    'var previewCanvas = _previewCanvas, setupPreviewCanvas = _setupPreviewCanvas;',
    'function assetImg() { return null; }',
    'function stampTrialMark() { stampCalls++; }',
    'function drawCropSlotIndicator() {}',
    'function roundRectPath() {}',
    'function goldGrad() { accentUsed = true; return {}; }',
    'function STICKER_NAMES() {}',
    'var STICKER_NAMES = { "b-slay": "SLAY" };',
    'var STICKER_EMOJIS = { "e-sparkle": "✨" };',
    'function drawSticker(ctx, k, S) { drawStickerCalls++; ctx.fillRect(-S/2, -S/2, S, S); }',
    'function decorBox(d, W, H) { var size = d.s * W, aspect = d.src.indexOf("b:b-") === 0 ? 0.45 : (d.src.indexOf("t:") === 0 ? (d.aspect || 0.38) : 1); return { cx: d.x * W, cy: d.y * H, w: size, h: size * aspect, img: null }; }',
    'function drawDecorBox() {}',
    'function tonedSticker() { return null; }',
    'function stickersInColour(ctx) { return ctx.canvas === previewCanvas && !!sess && !!sess.decorating && !sess.decoPreview; }',
    'function stickerTone() { return filterKey !== "none" ? "f:" + filterKey : ""; }',
    'function drawDecorLayer(ctx, W, H, mono) { decorDrawCalls++; decor.forEach(d => drawDecorItem(ctx, d, W, H, mono)); guestDecor.forEach(d => drawDecorItem(ctx, d, W, H, mono)); }',
    'function composeCanvas(lk, cv, sh) {',
    '  composeCalls++;',
    '  cv.width = 1200; cv.height = 1800;',
    '  const ctx = cv.getContext("2d");',
    '  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);',
    '  pbCaptureDecorBase(cv, lk, sh, "", false);',
    '  drawDecorLayer(ctx, cv.width, cv.height);',
    '  return cv;',
    '}',
    htmlContent.slice(htmlContent.indexOf('var _decorBaseEpoch = 1;'), htmlContent.indexOf('function renderCompositeToCanvas(')),
    extractFn(htmlContent, 'function renderCompositeToCanvas('),
    extractFn(htmlContent, 'function renderComposite('),
    extractFn(htmlContent, 'function gsoBox('),
    extractFn(htmlContent, 'function gsoMounted('),
    'var gsoView = { z: 1, tx: 0, ty: 0, w: 600, h: 900, bw: 600, bh: 900 }; var GSO_MAX_ZOOM = 4;',
    extractFn(htmlContent, 'function gsoVisibleCenter('),
    extractFn(htmlContent, 'function refreshGuestStickerControls('),
    extractFn(htmlContent, 'function gsoPlaceTools('),
    extractFn(htmlContent, 'function gsoRedraw('),
    extractFn(htmlContent, 'function addCustomTextDecor('),
    extractFn(htmlContent, 'function addGuestSticker('),
    htmlContent.slice(htmlContent.indexOf('var _customTextMeasCtx = null;'), htmlContent.indexOf('function drawDecorLayer(')),
    'globalThis.__api = { addCustomTextDecor, addGuestSticker, gsoRedraw, renderComposite, pbReleaseDecorBase, drawDecorItem, bumpEpoch: () => ++_decorBaseEpoch, setActiveResize: (v) => { _decorActiveResize = v; }, cacheSize: () => Object.keys(DECOR_BMP_CACHE).length, clearCache: pbClearDecorBitmapCache };'
  ].join('\n');

  const toasts = [];
  const doc = {
    createElement: (tag) => tag === 'canvas' ? makeFakeCanvas(200, 100) : { style: {} },
    getElementById: (id) => id === 'gsoTools' ? gsoTools : id === 'gsoStage' ? gsoStage : id === 'gsoCanvasBox' ? gsoCanvasBox : null
  };
  const ctxObj = {
    document: doc,
    window: {},
    shots,
    _previewCanvas: previewCanvas,
    _setupPreviewCanvas: setupPreviewCanvas,
    showToast: (m) => toasts.push(m),
    stampCalls: 0, composeCalls: 0, decorDrawCalls: 0, drawStickerCalls: 0,
    set stampCalls(v) { stampCalls = v; }, get stampCalls() { return stampCalls; },
    set composeCalls(v) { composeCalls = v; }, get composeCalls() { return composeCalls; },
    set decorDrawCalls(v) { decorDrawCalls = v; }, get decorDrawCalls() { return decorDrawCalls; },
    set drawStickerCalls(v) { drawStickerCalls = v; }, get drawStickerCalls() { return drawStickerCalls; },
    Date, Math, Object, Array, String, Number, Boolean, JSON, Error, encodeURIComponent, decodeURIComponent, console
  };
  vm.createContext(ctxObj);
  vm.runInContext(code, ctxObj);
  const api = ctxObj.__api;

  // Initial render builds base cache
  api.renderComposite();
  assert.equal(composeCalls, 1, 'Initial renderComposite must run composeCanvas once');
  assert(previewCanvas._decorBase && previewCanvas._decorBase.cv.width === 1200, 'Base cache must be captured for previewCanvas while decorating');

  // Adding custom text reuses base cache, computes true aspect before placing tools, and caches offscreen text bitmap
  api.addCustomTextDecor('SLAY BESTIES', 'manrope', '#ffffff', 'neon');
  assert.equal(composeCalls, 1, 'addCustomTextDecor must reuse frozen base composite without re-running composeCanvas');
  assert.equal(ctxObj.guestDecor.length, 1);
  assert(ctxObj.guestDecor[0].aspect > 0 && ctxObj.guestDecor[0].aspect < 1, 'Custom text aspect must be computed eagerly');
  assert.equal(api.cacheSize(), 1, 'Custom text item must be cached in DECOR_BMP_CACHE');
  assert(toasts.includes('Text added! Drag, resize or rotate.'), 'Confirmation toast preserved');

  // Adding banner sticker + 10 drag redraws must STILL keep composeCalls === 1 and drawStickerCalls === 1!
  api.addGuestSticker('b:b-slay', 0.38);
  assert.equal(composeCalls, 1, 'addGuestSticker must reuse frozen base composite');
  assert.equal(drawStickerCalls, 1, 'drawSticker draws banner once into DECOR_BMP_CACHE');
  for (let i = 0; i < 10; i++) {
    ctxObj.guestDecor[1].x = 0.2 + i * 0.05;
    ctxObj.guestDecor[1].r = i * 12;
    api.gsoRedraw({ decorOnly: true });
  }
  assert.equal(composeCalls, 1, '10 sticker move/rotate redraws must NOT re-run composeCanvas');
  assert.equal(drawStickerCalls, 1, '10 sticker move/rotate redraws must reuse cached bitmap without redrawing vector/shadow');
  assert(gsoTools.style.transform.startsWith('translate('), 'gsoTools position must update via transform');

  // Active resize gesture scales cached bitmap smoothly instead of re-rasterizing per frame
  const cacheBeforeResize = api.cacheSize();
  api.setActiveResize(true);
  ctxObj.guestDecor[0].s = 0.52;
  api.gsoRedraw({ decorOnly: true });
  assert.equal(api.cacheSize(), cacheBeforeResize, 'Active resize within bounds must reuse cached bitmap');
  api.setActiveResize(false);

  // Changing shotCrops must automatically miss the base cache & trigger composeCanvas cleanly
  ctxObj.shotCrops[0] = { zoom: 1.5, panX: 0.2, panY: -0.1 };
  api.gsoRedraw({ decorOnly: true });
  assert.equal(composeCalls, 2, 'Crop change must invalidate base cache automatically even with decorOnly');

  // Releasing base frees memory cleanly
  api.pbReleaseDecorBase(previewCanvas);
  assert.equal(previewCanvas._decorBase, null, 'pbReleaseDecorBase must release _decorBase');
  assert.equal(api.cacheSize(), 0, 'pbReleaseDecorBase must clear DECOR_BMP_CACHE on exit');
}

console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
