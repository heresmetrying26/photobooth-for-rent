import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const boothSrc = fs.readFileSync(path.join(rootDir, 'protected/src/booth.src.html'), 'utf8');
const boothBuilt = fs.readFileSync(path.join(rootDir, 'protected/booth.html'), 'utf8');
const androidBooth = fs.readFileSync(path.join(rootDir, 'android/app/src/main/assets/booth.html'), 'utf8');
const iosBooth = fs.readFileSync(path.join(rootDir, 'ios/photobooth4u/booth.html'), 'utf8');
const btThermalSrc = fs.readFileSync(path.join(rootDir, 'protected/src/bt-thermal.mjs'), 'utf8');

function extractFn(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `Function not found: ${signature}`);
  const brace = src.indexOf('{', start);
  let depth = 0, inStr = null, esc = false, inLine = false, inBlock = false;
  for (let i = brace; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function: ${signature}`);
}

const PAPER = {
  '2x6': { name: '2×6 strip', w: 50.8, h: 152.4 },
  '3.5x5': { name: '3R', w: 88.9, h: 127 },
  '4x6': { name: '4R (4×6)', w: 101.6, h: 152.4 },
  'selphy': { name: 'Selphy postcard', w: 100, h: 148 },
  'receipt80': { name: 'Receipt 80 mm', w: 72, h: 290, receipt: true },
  'receipt58': { name: 'Receipt 58 mm', w: 48, h: 195, receipt: true }
};

function makeLayoutDefs() {
  return {
    strip: { name: 'Classic strip', shots: 3, kind: 'strip', tier: 'photo', hint: '' },
    solo: { name: 'Solo', shots: 1, kind: 'sheet', tier: 'photo', hint: '' },
    receipt: { name: 'Receipt (3 shots)', shots: 3, kind: 'receipt', tier: 'receipt', twin: 'receiptc', hint: '' },
    receiptc: { name: 'Receipt colour (3 shots)', shots: 3, kind: 'receipt', color: true, tier: 'photo', hint: '' },
    receipt1: { name: 'Receipt Solo (1 shot)', shots: 1, kind: 'receipt', tier: 'receipt', twin: 'receipt1c', hint: '' },
    receipt1c: { name: 'Receipt Solo colour', shots: 1, kind: 'receipt', color: true, tier: 'photo', hint: '' },
    receipt2: { name: 'Receipt Duo (2 shots)', shots: 2, kind: 'receipt', tier: 'receipt', twin: 'receipt2c', hint: '' },
    receipt2c: { name: 'Receipt Duo colour', shots: 2, kind: 'receipt', color: true, tier: 'photo', hint: '' },
    receipt4: { name: 'Receipt Strip 4 (4 shots)', shots: 4, kind: 'receipt', tier: 'receipt', twin: 'receipt4c', hint: '' },
    receipt4c: { name: 'Receipt 4 colour', shots: 4, kind: 'receipt', color: true, tier: 'photo', hint: '' }
  };
}

// ---------------------------------------------------------------------------
// Real RGBA pixel-buffer 2D Canvas implementation for pixel-accurate print sim
// ---------------------------------------------------------------------------
function parseColor(col) {
  if (!col || typeof col !== 'string') return [0, 0, 0, 255];
  const s = col.trim();
  const h6 = /^#([0-9a-f]{6})$/i.exec(s);
  if (h6) {
    const n = parseInt(h6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const h3 = /^#([0-9a-f]{3})$/i.exec(s);
  if (h3) {
    return [
      parseInt(h3[1][0] + h3[1][0], 16),
      parseInt(h3[1][1] + h3[1][1], 16),
      parseInt(h3[1][2] + h3[1][2], 16),
      255
    ];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
  if (rgba) {
    return [
      Number(rgba[1]) & 255,
      Number(rgba[2]) & 255,
      Number(rgba[3]) & 255,
      rgba[4] != null ? Math.round(Number(rgba[4]) * 255) : 255
    ];
  }
  return [0, 0, 0, 255];
}

function createPixelCanvas(w = 1, h = 1) {
  let _w = Math.max(1, Math.round(w));
  let _h = Math.max(1, Math.round(h));
  let _data = new Uint8ClampedArray(_w * _h * 4);
  let _ctx = null;

  const cv = {
    get width() { return _w; },
    set width(v) {
      _w = Math.max(1, Math.round(Number(v) || 1));
      _data = new Uint8ClampedArray(_w * _h * 4);
    },
    get height() { return _h; },
    set height(v) {
      _h = Math.max(1, Math.round(Number(v) || 1));
      _data = new Uint8ClampedArray(_w * _h * 4);
    },
    get _pixels() { return _data; },
    getContext() {
      if (_ctx) return _ctx;
      let sx = 1, sy = 1, tx = 0, ty = 0, rot = 0;
      const stack = [];
      let fillStyle = '#000000';
      let strokeStyle = '#000000';
      let lineWidth = 1;
      let pathMinX = Infinity, pathMinY = Infinity, pathMaxX = -Infinity, pathMaxY = -Infinity;

      function mapPt(x, y) {
        if (rot) {
          const c = Math.cos(rot), s = Math.sin(rot);
          const rx = x * c - y * s, ry = x * s + y * c;
          return [rx * sx + tx, ry * sy + ty];
        }
        return [x * sx + tx, y * sy + ty];
      }

      function paintRect(x, y, rw, rh, colStr) {
        const [r, g, b, a] = parseColor(colStr);
        const [x0, y0] = mapPt(x, y);
        const [x1, y1] = mapPt(x + rw, y + rh);
        const minX = Math.max(0, Math.floor(Math.min(x0, x1)));
        const maxX = Math.min(_w, Math.ceil(Math.max(x0, x1)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1)));
        const maxY = Math.min(_h, Math.ceil(Math.max(y0, y1)));
        for (let py = minY; py < maxY; py++) {
          let idx = (py * _w + minX) * 4;
          for (let px = minX; px < maxX; px++, idx += 4) {
            _data[idx] = r; _data[idx + 1] = g; _data[idx + 2] = b; _data[idx + 3] = a;
          }
        }
      }

      function recordBounds(x, y) {
        if (x < pathMinX) pathMinX = x;
        if (y < pathMinY) pathMinY = y;
        if (x > pathMaxX) pathMaxX = x;
        if (y > pathMaxY) pathMaxY = y;
      }

      _ctx = {
        canvas: cv,
        get fillStyle() { return fillStyle; },
        set fillStyle(v) { fillStyle = v; },
        get strokeStyle() { return strokeStyle; },
        set strokeStyle(v) { strokeStyle = v; },
        get lineWidth() { return lineWidth; },
        set lineWidth(v) { lineWidth = v; },
        font: '400 16px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        lineCap: 'butt',
        lineJoin: 'miter',
        globalAlpha: 1,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        save() { stack.push({ sx, sy, tx, ty, rot, fillStyle, strokeStyle, lineWidth }); },
        restore() {
          const st = stack.pop();
          if (!st) return;
          sx = st.sx; sy = st.sy; tx = st.tx; ty = st.ty; rot = st.rot;
          fillStyle = st.fillStyle; strokeStyle = st.strokeStyle; lineWidth = st.lineWidth;
        },
        scale(a, b) { sx *= a; sy *= (b == null ? a : b); },
        translate(a, b) { tx += a * sx; ty += b * sy; },
        rotate(r) { rot += r; },
        beginPath() { pathMinX = Infinity; pathMinY = Infinity; pathMaxX = -Infinity; pathMaxY = -Infinity; },
        closePath() {},
        clip() {},
        moveTo(x, y) { recordBounds(x, y); },
        lineTo(x, y) { recordBounds(x, y); },
        quadraticCurveTo(cx, cy, x, y) { recordBounds(cx, cy); recordBounds(x, y); },
        bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { recordBounds(c1x, c1y); recordBounds(c2x, c2y); recordBounds(x, y); },
        arc(cx, cy, r) { recordBounds(cx - r, cy - r); recordBounds(cx + r, cy + r); },
        rect(x, y, rw, rh) { recordBounds(x, y); recordBounds(x + rw, y + rh); },
        fill() {
          if (Number.isFinite(pathMinX) && Number.isFinite(pathMaxX)) {
            paintRect(pathMinX, pathMinY, Math.max(1, pathMaxX - pathMinX), Math.max(1, pathMaxY - pathMinY), fillStyle);
          }
        },
        stroke() {
          if (Number.isFinite(pathMinX) && Number.isFinite(pathMaxX)) {
            const lw = Math.max(1, lineWidth);
            paintRect(pathMinX, pathMinY, Math.max(lw, pathMaxX - pathMinX), lw, strokeStyle);
          }
        },
        fillRect(x, y, rw, rh) { paintRect(x, y, rw, rh, fillStyle); },
        strokeRect(x, y, rw, rh) {
          const lw = Math.max(1, lineWidth);
          paintRect(x, y, rw, lw, strokeStyle);
          paintRect(x, y + rh - lw, rw, lw, strokeStyle);
          paintRect(x, y, lw, rh, strokeStyle);
          paintRect(x + rw - lw, y, lw, rh, strokeStyle);
        },
        fillText(txt, x, y) {
          // Stamp a small solid ink block at text origin so pixel inspection detects actual ink colour!
          const t = String(txt || '');
          const wEst = Math.max(4, Math.min(80, t.length * 4));
          const ox = this.textAlign === 'center' ? x - wEst / 2 : (this.textAlign === 'right' ? x - wEst : x);
          paintRect(ox, y - 6, wEst, 6, fillStyle);
        },
        strokeText(txt, x, y) {
          const t = String(txt || '');
          const wEst = Math.max(4, Math.min(80, t.length * 4));
          const ox = this.textAlign === 'center' ? x - wEst / 2 : (this.textAlign === 'right' ? x - wEst : x);
          paintRect(ox, y - 6, wEst, 6, strokeStyle);
        },
        setLineDash() {},
        measureText(txt) { return { width: String(txt || '').length * 9 }; },
        drawImage(src, ...args) {
          if (!src || !src._pixels) return;
          let srcX = 0, srcY = 0, srcW = src.width, srcH = src.height;
          let dstX = 0, dstY = 0, dstW = src.width, dstH = src.height;
          if (args.length === 2) {
            [dstX, dstY] = args;
          } else if (args.length === 4) {
            [dstX, dstY, dstW, dstH] = args;
          } else if (args.length === 8) {
            [srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH] = args;
          }
          const [dx0, dy0] = mapPt(dstX, dstY);
          const [dx1, dy1] = mapPt(dstX + dstW, dstY + dstH);
          const minX = Math.max(0, Math.floor(Math.min(dx0, dx1)));
          const maxX = Math.min(_w, Math.ceil(Math.max(dx0, dx1)));
          const minY = Math.max(0, Math.floor(Math.min(dy0, dy1)));
          const maxY = Math.min(_h, Math.ceil(Math.max(dy0, dy1)));
          const spanX = Math.max(1e-6, maxX - minX);
          const spanY = Math.max(1e-6, maxY - minY);
          const sp = src._pixels, sw = src.width, sh = src.height;
          for (let py = minY; py < maxY; py++) {
            const syi = Math.max(0, Math.min(sh - 1, Math.floor(srcY + ((py - minY) / spanY) * srcH)));
            const sRow = syi * sw;
            let dIdx = (py * _w + minX) * 4;
            for (let px = minX; px < maxX; px++, dIdx += 4) {
              const sxi = Math.max(0, Math.min(sw - 1, Math.floor(srcX + ((px - minX) / spanX) * srcW)));
              const sIdx = (sRow + sxi) * 4;
              _data[dIdx] = sp[sIdx];
              _data[dIdx + 1] = sp[sIdx + 1];
              _data[dIdx + 2] = sp[sIdx + 2];
              _data[dIdx + 3] = 255;
            }
          }
        },
        getImageData(x, y, rw, rh) {
          const x0 = Math.max(0, Math.floor(x));
          const y0 = Math.max(0, Math.floor(y));
          const w0 = Math.max(0, Math.min(_w - x0, Math.floor(rw)));
          const h0 = Math.max(0, Math.min(_h - y0, Math.floor(rh)));
          const out = new Uint8ClampedArray(w0 * h0 * 4);
          for (let row = 0; row < h0; row++) {
            const sOff = ((y0 + row) * _w + x0) * 4;
            out.set(_data.subarray(sOff, sOff + w0 * 4), row * w0 * 4);
          }
          return { width: w0, height: h0, data: out };
        },
        putImageData(im, x, y) {
          const x0 = Math.max(0, Math.floor(x));
          const y0 = Math.max(0, Math.floor(y));
          const w0 = Math.min(im.width, _w - x0);
          const h0 = Math.min(im.height, _h - y0);
          for (let row = 0; row < h0; row++) {
            const dOff = ((y0 + row) * _w + x0) * 4;
            const sOff = row * im.width * 4;
            _data.set(im.data.subarray(sOff, sOff + w0 * 4), dOff);
          }
        }
      };
      return _ctx;
    },
    toDataURL(mime) {
      const stats = analyzeCanvasPixels(cv);
      return `data:${mime || 'image/png'};sim,${JSON.stringify(stats)}`;
    },
    toBlob(cb, mime) {
      const stats = analyzeCanvasPixels(cv);
      cb({ type: mime || 'image/png', size: _data.length, _stats: stats, _canvas: cv });
    }
  };
  return cv;
}

// Create a rich, vibrant colour test photo (skin tone + bright red + green + blue quadrants)
function makeColorShotCanvas(w = 160, h = 160) {
  const cv = createPixelCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#e89678'; ctx.fillRect(0, 0, w / 2, h / 2);       // warm skin tone
  ctx.fillStyle = '#e62e2e'; ctx.fillRect(w / 2, 0, w / 2, h / 2);   // vibrant red
  ctx.fillStyle = '#22b54c'; ctx.fillRect(0, h / 2, w / 2, h / 2);   // vibrant green
  ctx.fillStyle = '#2463eb'; ctx.fillRect(w / 2, h / 2, w / 2, h / 2); // vibrant blue
  return cv;
}

// Measure colour vs grayscale pixels across the entire rendered canvas
function analyzeCanvasPixels(cv) {
  const d = cv._pixels;
  const total = cv.width * cv.height;
  let coloredPx = 0;
  let redInkPx = 0;
  let creamBgPx = 0;
  let pureWhitePx = 0;
  let pureBlackPx = 0;
  let maxChroma = 0;
  // Sample every 2nd pixel for speed on high-res 4R canvases (1200x1800)
  const step = total > 400000 ? 4 : 1;
  let sampled = 0;
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;
    if (chroma > maxChroma) maxChroma = chroma;
    if (chroma > 20) coloredPx++;
    if (r >= 135 && r <= 175 && g <= 45 && b <= 55) redInkPx++;           // #9b1c26 dark red ink
    if (r === 250 && g === 248 && b === 245) creamBgPx++;                  // #faf8f5 warm cream backdrop
    if (r === 255 && g === 255 && b === 255) pureWhitePx++;
    if (r === 0 && g === 0 && b === 0) pureBlackPx++;
    sampled++;
  }
  return {
    w: cv.width,
    h: cv.height,
    sampled,
    coloredPx,
    coloredRatio: sampled ? Number((coloredPx / sampled).toFixed(4)) : 0,
    redInkPx,
    creamBgPx,
    pureWhitePx,
    pureBlackPx,
    maxChroma
  };
}

function parseSimDataUrl(url) {
  const idx = String(url || '').indexOf(';sim,');
  assert.notEqual(idx, -1, `Expected simulated data URL, got: ${String(url).slice(0, 60)}`);
  return JSON.parse(String(url).slice(idx + 5));
}

// ---------------------------------------------------------------------------
// 1. Sync verification across built HTML bundles
// ---------------------------------------------------------------------------
test('built bundles stay in sync (protected/booth.html === Android === iOS)', () => {
  assert.equal(androidBooth, boothBuilt, 'Android booth.html must match protected/booth.html');
  assert.equal(iosBooth, boothBuilt, 'iOS booth.html must match protected/booth.html');
  assert.ok(boothBuilt.includes("d.kind === 'receipt' && !d.color ? 'receipt' : 'photo'"));
  assert.ok(boothBuilt.includes('function isThermalPrintTarget('));
  assert.ok(boothBuilt.includes('(size && k !== size && wifiSizeMap[size])'));
});

// ---------------------------------------------------------------------------
// 2. Unit test: layoutTier, setLayout, wifiForSize, Photoman deskApplyTemplate
// ---------------------------------------------------------------------------
test('layoutTier, setLayout, wifiForSize, and Photoman deskApplyTemplate: colour receipts stay on photo paper & photo printer', async () => {
  const storage = {};
  const ctx = {
    LAYOUT_DEFS: makeLayoutDefs(),
    PAPER,
    tierSplit: false,
    boothType: 'photo',
    currentLayout: 'strip',
    setupLayout: 'strip',
    activeFrameId: null,
    printSize: '4x6',
    layoutPaperMap: {},
    shotCanvases: [true, true, true],
    state: 'idle',
    guestPickedTier: null,
    sessionTier: null,
    plainResult: null,
    flipbookResult: null,
    sessionNumber: 1,
    soloPaper: null,
    deskKeepFrame: undefined,
    printPrefs: { singleStrip: false },
    window: {},
    wifiDefault: { name: 'Xprinter XP-80C', ip: 'usb://xp80', raw: true, ipp: false },
    wifiSizeMap: {
      '4x6': { name: 'EPSON L8050', ip: '192.168.1.50', ipp: true, escpr: true },
      'receipt80': { name: 'Xprinter XP-80C', ip: 'usb://xp80', raw: true, ipp: false }
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    },
    layoutDef(k) { return ctx.LAYOUT_DEFS[k || ctx.currentLayout] || ctx.LAYOUT_DEFS.strip; },
    layoutCardKey() { return ctx.currentLayout; },
    paperFor(k) { return PAPER[k] || null; },
    isReceiptPaper(k) { return !!(PAPER[k] && PAPER[k].receipt); },
    isStripLayout(k) { return ctx.layoutDef(k).kind === 'strip'; },
    printSettings() { return ['receipt80', 'receipt58', '4x6', '3.5x5', '2x6']; },
    shotsNeeded() { return ctx.layoutDef().shots; },
    activePrinterName() { return 'EPSON L8050'; },
    is58mmPrinterName: () => false,
    layoutGrid: { querySelectorAll: () => [] },
    layoutHint: { textContent: '' },
    applyStageAspect() {},
    pbReleaseShotList() {},
    updateFilmTrack() {},
    updateUI() {},
    setActivePresetBtn() {},
    updateBandPositionVisibility() {},
    updateReadySub() {},
    renderComposite() {},
    renderSetupPreview() {},
    refreshPrintUI() {},
    frameById: () => null,
    pmTplById: () => null,
    Object, Array, String, Number, Math, Boolean
  };

  const code = [
    extractFn(boothBuilt, 'function tierSplitOn('),
    extractFn(boothBuilt, 'function layoutTier('),
    extractFn(boothBuilt, 'function layoutFitsTier('),
    extractFn(boothBuilt, 'function effectiveLayoutTier('),
    extractFn(boothBuilt, 'function stripTwoUp('),
    extractFn(boothBuilt, 'function printerKey('),
    extractFn(boothBuilt, 'function wifiForSize('),
    extractFn(boothBuilt, 'function setLayout('),
    extractFn(boothBuilt, 'function enterSoloLayout('),
    extractFn(boothBuilt, 'function deskBoothLayoutBack('),
    extractFn(boothBuilt, 'function deskApplyTemplate('),
    extractFn(boothBuilt, 'async function deskRunWithBoothCtx('),
    'globalThis.__api = { tierSplitOn, layoutTier, layoutFitsTier, effectiveLayoutTier, stripTwoUp, printerKey, wifiForSize, setLayout, deskRunWithBoothCtx, getPrintSize: () => printSize, setPrintSize: (v) => { printSize = v; }, getCurrentLayout: () => currentLayout };'
  ].join('\n');

  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const api = ctx.__api;

  assert.equal(api.tierSplitOn(), false);

  for (const k of ['receiptc', 'receipt1c', 'receipt2c', 'receipt4c']) {
    assert.equal(api.layoutTier(k), 'photo', `${k} must be photo tier`);
    assert.equal(api.layoutFitsTier(k, 'photo'), true);
    assert.equal(api.layoutFitsTier(k, 'receipt'), false);
  }
  for (const k of ['receipt', 'receipt1', 'receipt2', 'receipt4']) {
    assert.equal(api.layoutTier(k), 'receipt', `${k} must be receipt tier`);
    assert.equal(api.layoutFitsTier(k, 'receipt'), true);
    assert.equal(api.layoutFitsTier(k, 'photo'), false);
  }

  // Selecting Receipt Solo colour on 4x6 keeps 4x6 and routes Android/iPad wifiForSize('4x6') to EPSON L8050 (NOT wifiDefault XP-80C!).
  api.setPrintSize('4x6');
  api.setLayout('receipt1c');
  assert.equal(api.getPrintSize(), '4x6');
  assert.equal(api.printerKey('4x6'), 'strip:4x6');
  assert.equal(api.wifiForSize('4x6').name, 'EPSON L8050', 'wifiForSize must fall back from strip:4x6 to 4x6 before wifiDefault');

  // B&W Receipt Solo switches to receipt80 and routes wifiForSize('receipt80') to Xprinter XP-80C.
  api.setLayout('receipt1');
  assert.equal(api.getPrintSize(), 'receipt80');
  assert.equal(api.wifiForSize('receipt80').name, 'Xprinter XP-80C');

  // Switching back to Receipt Solo colour switches paper back to 4x6 and printer back to EPSON L8050.
  api.setLayout('receipt1c');
  assert.equal(api.getPrintSize(), '4x6');
  assert.equal(api.wifiForSize('4x6').name, 'EPSON L8050');

  // Explicit per-layout paper override is preserved.
  ctx.layoutPaperMap.receipt1c = '3.5x5';
  api.setLayout('receipt1c');
  assert.equal(api.getPrintSize(), '3.5x5');
  delete ctx.layoutPaperMap.receipt1c;

  // Photoman: booth is on B&W receipt1 + receipt80, Photoman prints receipt1c -> switches to 4x6 during print, restores receipt80 after!
  ctx.setupLayout = 'receipt1';
  api.setLayout('receipt1');
  assert.equal(api.getPrintSize(), 'receipt80');
  let insideSize = null, insideLayout = null;
  await api.deskRunWithBoothCtx({ tpl: 'receipt1c', shots: [true], sessionNum: 9 }, async () => {
    insideSize = api.getPrintSize();
    insideLayout = api.getCurrentLayout();
  });
  assert.equal(insideLayout, 'receipt1c');
  assert.equal(insideSize, '4x6', 'Photoman printing colour receipt must switch off receipt80 to 4x6');
  assert.equal(api.getCurrentLayout(), 'receipt1', 'Booth layout restored after Photoman print');
  assert.equal(api.getPrintSize(), 'receipt80', 'Booth paper size restored after Photoman print');
});

// ---------------------------------------------------------------------------
// 3. Unit test: refreshPrintUI startup & reload self-healing
// ---------------------------------------------------------------------------
test('refreshPrintUI: startup/reload self-heals colour receipts from stale receipt80 to photo paper', () => {
  const storage = { pb_print_paper: 'receipt80' };
  const dummyEl = () => ({
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    checked: false,
    value: '',
    appendChild() {}
  });
  const elements = { customSizeRow: dummyEl(), xlPresetRow: dummyEl(), printerPick: dummyEl() };
  let allowedSizes = ['receipt80', 'receipt58', '4x6', '3.5x5', '2x6'];
  const ctx = {
    LAYOUT_DEFS: makeLayoutDefs(),
    PAPER,
    currentLayout: 'receipt1c',
    printSize: null,
    keychainOn: false,
    state: 'idle',
    shotCanvases: [null],
    printing: false,
    printQueued: 0,
    printerMap: {},
    helperOn: false,
    printSection: dummyEl(),
    keychainRow: dummyEl(),
    keychainToggle: dummyEl(),
    printSizeRow: dummyEl(),
    printBtn: dummyEl(),
    printHint: dummyEl(),
    printerNameInput: dummyEl(),
    document: { activeElement: null, getElementById: (id) => elements[id] || dummyEl(), createElement: () => dummyEl() },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    window: {},
    layoutDef(k) { return ctx.LAYOUT_DEFS[k || ctx.currentLayout]; },
    paperFor(k) { return PAPER[k] || null; },
    isReceiptPaper(k) { return !!(PAPER[k] && PAPER[k].receipt); },
    printSettings() { return allowedSizes; },
    sizeFitsLayout: () => true,
    updateAutoPrintUI() {},
    refreshPrintFab() {},
    keychainFrames: () => [],
    keychainFit: () => null,
    keychainMode: () => false,
    stripPagesMode: () => false,
    stripTwoUp: () => false,
    sizedPhoto: () => false,
    isMobileOS: () => false,
    isStripLayout: () => false,
    ownSizesAllowed: () => false,
    ownSizes: () => [],
    activePrinterName: () => 'EPSON L3210 Series',
    is58mmPrinterName: () => false,
    printerKey: (k) => k,
    fillPrinterSelect() {},
    refreshPrinterHint() {},
    refreshPrintExtras() {},
    paperMatchTip: () => '',
    printsLeft: () => 99,
    sheetsPerCopy: () => 1,
    Array, Object, String, Number, Math, Boolean
  };

  const code = [
    extractFn(boothBuilt, 'function refreshPrintUI('),
    'globalThis.__api = { refreshPrintUI, getPrintSize: () => printSize, setPrintSize: (v) => { printSize = v; } };'
  ].join('\n');

  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const api = ctx.__api;

  // Stale pb_print_paper='receipt80' -> self-heals to 4x6.
  api.setPrintSize(null); api.refreshPrintUI();
  assert.equal(api.getPrintSize(), '4x6');

  // No saved paper, receipt80 first in usable -> picks 4x6.
  delete storage.pb_print_paper;
  api.setPrintSize(null); api.refreshPrintUI();
  assert.equal(api.getPrintSize(), '4x6');

  // Saved 3R photo paper -> keeps 3.5x5.
  storage.pb_print_paper = '3.5x5';
  api.setPrintSize(null); api.refreshPrintUI();
  assert.equal(api.getPrintSize(), '3.5x5');

  // B&W receipt with saved 4x6 -> picks receipt80.
  ctx.currentLayout = 'receipt1';
  storage.pb_print_paper = '4x6';
  api.setPrintSize(null); api.refreshPrintUI();
  assert.equal(api.getPrintSize(), 'receipt80');

  // Colour receipt when ONLY thermal sizes exist -> falls back to receipt80.
  ctx.currentLayout = 'receipt1c';
  allowedSizes = ['receipt80', 'receipt58'];
  delete storage.pb_print_paper;
  api.setPrintSize(null); api.refreshPrintUI();
  assert.equal(api.getPrintSize(), 'receipt80');
});

// ---------------------------------------------------------------------------
// 4. FULL PIXEL-LEVEL END-TO-END PRINTING SIMULATION
//    Runs real composeReceipt + ditherRegion + buildPrintCanvas + printAdjust
//    + printPreviewPages + printViaHelper + sendToStation + printViaWifiRaw
//    + printExtraSheet + printCurrentPhoto + real bt-thermal.mjs
// ---------------------------------------------------------------------------
test('FULL PIXEL-LEVEL PRINT SIMULATION: all receipt styles, templates, printers, and print routes', async () => {
  const storage = {};
  const records = {
    helperPosts: [],
    stationPosts: [],
    btPrints: [],
    wifiIpp: [],
    wifiRaw: [],
    nativeDialog: [],
    browserPrintPages: [],
    browserPageCss: ''
  };
  let btRoute = false;
  let useOnlineStation = false;
  let helperEnabled = true;
  let activeWifiPrinter = null;
  let extraPrinters = [];
  let nativeDialogBridge = null;

  const shot1 = makeColorShotCanvas(160, 160);
  const shot2 = makeColorShotCanvas(160, 160);
  const shot3 = makeColorShotCanvas(160, 160);
  const shot4 = makeColorShotCanvas(160, 160);

  const printAreaEl = {
    children: [],
    set innerHTML(v) { if (v === '') this.children = []; },
    appendChild(pg) { this.children.push(pg); }
  };
  const printPageStyleEl = { textContent: '' };

  // Load real bt-thermal.mjs inside a VM context with our real pixel canvas
  const btEnv = {
    window: {},
    navigator: {},
    document: { createElement: (tag) => (tag === 'canvas' ? createPixelCanvas(1, 1) : {}) },
    Uint8Array, Uint8ClampedArray, Float32Array, Int32Array, Array, Object, Math, Number, String, Promise, Error, Date, setTimeout, clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64')
  };
  vm.createContext(btEnv);
  vm.runInContext(btThermalSrc, btEnv);
  const realBtThermal = btEnv._btThermal || btEnv.window._btThermal;
  assert.equal(typeof realBtThermal.toReceiptGray, 'function');
  assert.equal(typeof realBtThermal.toReceiptCanvas, 'function');

  // Attach mock printViaBluetooth that still runs real toReceiptCanvas + EscPosEncoder!
  realBtThermal.printViaBluetooth = async (cv, rollW, opts) => {
    const dotW = rollW === '58mm' ? 384 : 576;
    const mono = realBtThermal.toReceiptCanvas(cv, dotW, opts.brightness || 0, opts.quality || 'best');
    const esc = new realBtThermal.EscPosEncoder(dotW).initialize().image(mono, dotW <= 384 ? 32 : 256).cut().getBuffer();
    records.btPrints.push({ rollW, dotW, srcStats: analyzeCanvasPixels(cv), monoStats: analyzeCanvasPixels(mono), escBytes: esc.length });
  };

  const previewCv = createPixelCanvas(1, 1);

  const ctx = {
    LAYOUT_DEFS: makeLayoutDefs(),
    PAPER,
    RECEIPT_W: 576,
    RECEIPT_DPI: 203,
    PRINT_DPI: 300,
    MAX_COPIES: 10,
    DESKTOP: false,
    LAPTOP_PRINT: false,
    IOS_APP: false,
    IS_IOS_APP: false,
    LANREMOTE: false,
    tierSplit: false,
    boothType: 'photo',
    currentLayout: 'receipt1c',
    setupLayout: 'receipt1c',
    printSize: '4x6',
    layoutPaperMap: {},
    state: 'result',
    printing: false,
    printQueued: 0,
    printFirstHolding: false,
    sessPrinted: 0,
    plainResult: null,
    flipbookResult: null,
    btViewBack: false,
    sessionNumber: 7,
    guestPickedTier: null,
    sessionTier: null,
    receiptPrintGrey: false,
    receiptPrint58: false,
    receiptStyle: 'player',          // Exact "Now Playing" music player style from customer's photo!
    receiptCustomNote: '',
    backdropColor: '#faf8f5',        // Warm cream card backdrop (lum > 0.72)
    textColor: '#9b1c26',            // Deep crimson/red ink like customer's photo (lum ~0.22 < 0.35)
    kickerText: 'ON REPEAT · LIVE',
    labelInput: { value: '8pointstudios' },
    overlay: null,
    colorAdj: { brightness: 0, red: 0, green: 0, blue: 0, hue: 0, sat: 0 },
    printPrefs: { singleStrip: false, copies: 1, thermalQuality: 'best', preview: false, edges: { t: 0, b: 0, l: 0, r: 0 } },
    shotCanvases: [shot1],
    previewCanvas: previewCv,
    printerMap: { '4x6': 'EPSON L3210 Series', 'receipt80': 'Xprinter XP-80C' },
    helper: { ok: true, checked: Date.now(), version: '1.1.27', printers: ['EPSON L3210 Series', 'EPSON L8050', 'Xprinter XP-80C', 'Rongta RP30', 'Canon SELPHY CP1500'] },
    get helperOn() { return helperEnabled; },
    set helperOn(v) { helperEnabled = v; },
    get wifiPrinter() { return activeWifiPrinter; },
    set wifiPrinter(v) { activeWifiPrinter = v; },
    wifiDefault: null,
    wifiSizeMap: {},
    station: { online: true, mode: 'auto' },
    printArea: printAreaEl,
    printPageStyle: printPageStyleEl,
    _pbAutoPrintPendingUntil: 0,
    _pbLastPrintSentAt: 0,
    _pbActiveSavePromise: null,
    lastHelperPrintQueued: false,
    btThermalOn: false,
    pwAuto: false,
    pw: { bt: { state: 'ready' } },
    pwSet() {},
    console,
    navigator: { platform: 'Win32' },
    window: {
      _btThermal: realBtThermal,
      _colorAdj: null,
      print() {
        records.browserPageCss = printPageStyleEl.textContent;
        records.browserPrintPages = printAreaEl.children.map((pg) => ({
          wCss: pg.style.width,
          hCss: pg.style.height,
          stats: pg._img._blob._stats
        }));
      },
      get __PBPrint() { return nativeDialogBridge; },
      __PBNet: {
        scan() {},
        printIpp(id, ip, w, h, copies, picsJson, optsJson) {
          const pics = JSON.parse(picsJson).map(parseSimDataUrl);
          records.wifiIpp.push({ ip, w, h, copies, pics, opts: JSON.parse(optsJson) });
          setTimeout(() => ctx.window.__PBNetResult({ job: id, ok: true }), 0);
        },
        printRaw(id, ip, b64) {
          records.wifiRaw.push({ ip, bytes: Buffer.from(b64, 'base64').length });
          setTimeout(() => ctx.window.__PBNetResult({ job: id, ok: true }), 0);
        }
      }
    },
    URL: {
      _map: new Map(),
      _n: 0,
      createObjectURL(blob) { const u = 'blob:sim/' + (++this._n); this._map.set(u, blob); return u; },
      revokeObjectURL(u) { this._map.delete(u); }
    },
    Image: class SimImage {
      set src(u) { this._src = u; this._blob = ctx.URL._map.get(u); }
      get src() { return this._src; }
      decode() { return Promise.resolve(); }
    },
    document: {
      createElement(tag) {
        if (tag === 'canvas') return createPixelCanvas(1, 1);
        return { className: '', style: {}, appendChild(ch) { this._img = ch; } };
      }
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    },
    layoutDef(k) { return ctx.LAYOUT_DEFS[k || ctx.currentLayout] || ctx.LAYOUT_DEFS.strip; },
    layoutCardKey() { return ctx.currentLayout; },
    paperFor(k) { return PAPER[k] || null; },
    isReceiptPaper(k) { return !!(PAPER[k] && PAPER[k].receipt); },
    isStripLayout(k) { return ctx.layoutDef(k).kind === 'strip'; },
    printSettings() { return ['receipt80', 'receipt58', '4x6', '3.5x5', '2x6']; },
    shotsNeeded() { return ctx.layoutDef().shots; },
    currentDateLabel: () => '11/28/2026',
    roundRect(c, x, y, w, h) { c.beginPath(); c.rect(x, y, w, h); },
    drawImageCover(c, img, x, y, w, h) { c.drawImage(img, 0, 0, img.width, img.height, x, y, w, h); },
    drawFitted(c, img, x, y, w, h) {
      const s = Math.min(w / img.width, h / img.height);
      const dw = Math.round(img.width * s), dh = Math.round(img.height * s);
      c.drawImage(img, 0, 0, img.width, img.height, x + Math.round((w - dw) / 2), y + Math.round((h - dh) / 2), dw, dh);
    },
    drawPhotoOnSheet(c, img, w, h) { ctx.drawFitted(c, img, 0, 0, w, h); },
    btPrintCanvas: (src) => src,
    pbReleaseCanvas() {},
    pbReleaseCanvasList() {},
    pbReleaseShotList() {},
    applyStageAspect() {},
    updateFilmTrack() {},
    updateUI() {},
    setActivePresetBtn() {},
    updateBandPositionVisibility() {},
    updateReadySub() {},
    renderSetupPreview() {},
    refreshPrintUI() {},
    layoutGrid: { querySelectorAll: () => [] },
    layoutHint: { textContent: '' },
    activePrinterName() { return ctx.printerFor(ctx.printSize); },
    is58mmPrinterName: (n) => /58|\bp50\b/i.test(String(n || '')),
    isInstaxPrinter: () => false,
    isDyeSubPrinter: (n) => /selphy|dnp|hiti/i.test(String(n || '')),
    isMobileOS: () => false,
    isLowRamIos: () => false,
    androidQueueOn: () => false,
    lanStationActive: () => false,
    lanStationQueueNoPrinter: () => false,
    useStation: () => useOnlineStation,
    isBtThermalRoute: () => btRoute,
    btProfileName: () => 'Bluetooth Printer',
    forcedPrinterName: () => '',
    activeExtraPrinters: () => extraPrinters,
    optsOfPrinter: () => ({}),
    colorOfPrinter: () => ({ brightness: 0, red: 0, green: 0, blue: 0, hue: 0, sat: 0 }),
    driverPaperFor: () => '',
    helperMediaTypeFor: () => '',
    helperQualityFor: () => 'best',
    helperAtLeast: () => true,
    ownSizes: () => [],
    sizedPhoto: () => false,
    keychainMode: () => false,
    stripPagesMode: () => false,
    canonDpiFor: () => 0,
    l8050DpiFor: () => 0,
    l3210DpiFor: () => 0,
    isEpsonL8050: () => false,
    epsonRasterBetaAllowed: () => false,
    epsonLNetPrinter: () => false,
    needsPrintPreview: () => false,
    sheetsPerCopy: () => 1,
    maxCopies: () => 10,
    reservePrints: async () => ({ ok: true, left: 100 }),
    printLimits: () => ({ ev: 0, se: 0 }),
    printTxt: (k) => k,
    showPrintingNote() {},
    showToast() {},
    armAutoPrintAfterFirst() {},
    setPendingPrints() {},
    refreshStationHints() {},
    checkHelper: async () => ctx.helper,
    wifiOpts: () => ({ color: '', quality: 'high', media: '', borderless: false }),
    wifiPKey: (p) => String((p && (p.name || p.ip)) || ''),
    printOkMark() {},
    pdiagSend() {},
    hasColorAdj: () => false,
    camQPrintSharpen() {},
    edgeAdjust() {},
    cleanEdges: (e) => e || { t: 0, b: 0, l: 0, r: 0 },
    wifiNetAvailable: () => true,
    wifiBytesToB64: (u8) => Buffer.from(u8).toString('base64'),
    async helperFetch(url, init) {
      const body = JSON.parse(init.body);
      records.helperPosts.push({
        url,
        printer: body.printer,
        widthMm: body.widthMm,
        heightMm: body.heightMm,
        twoUp: body.twoUp,
        fit: body.fit,
        receipt: body.receipt,
        pages: body.pages.map(parseSimDataUrl)
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    async postApi(url, payload) {
      records.stationPosts.push({
        url,
        copies: payload.copies,
        twoUp: payload.twoUp,
        paper: payload.paper,
        page: parseSimDataUrl(payload.page)
      });
      return { status: 200, j: { ok: true, online: true, stationMode: 'auto' } };
    },
    renderCompositeToCanvas(layoutKey, target) {
      const ld = ctx.layoutDef(layoutKey);
      const shots = [shot1, shot2, shot3, shot4].slice(0, ld.shots);
      if (ld.kind === 'receipt') return ctx.composeReceipt(layoutKey, target, shots);
      // Simple colour photo composite for non-receipt layouts
      target.width = 600; target.height = 900;
      const g = target.getContext('2d');
      g.fillStyle = '#faf8f5'; g.fillRect(0, 0, 600, 900);
      g.drawImage(shot1, 0, 0, shot1.width, shot1.height, 40, 40, 520, 720);
      return target;
    },
    renderComposite() {
      ctx.renderCompositeToCanvas(ctx.currentLayout, ctx.previewCanvas);
      ctx.previewCanvas._renderedForLayout = ctx.currentLayout;
      ctx.previewCanvas._renderedSession = ctx.sessionNumber;
      ctx.previewCanvas._fastPreview = false;
    },
    canReusePreviewCanvas(lk) {
      return !!(lk === ctx.currentLayout && ctx.previewCanvas.width > 1 && ctx.previewCanvas._renderedForLayout === lk);
    },
    async printSheets(sheets, paper, name, opt) { return ctx.printViaHelper(sheets, paper, name, opt); },
    performance: { now: () => Date.now() },
    Date, Math, Number, String, Boolean, Array, Object, Set, Map, JSON, Promise, Error, Float32Array, Uint8Array, Uint8ClampedArray,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64')
  };

  // Extract REAL functions directly from the assembled protected/booth.html!
  const code = [
    'const receiptTimes = {};',
    'const wifiJobs = {};',
    'const wifiEscprFirst = {};',
    'var scopedPrinterName = "";',
    'var RECEIPT_STYLES = [["classic","Classic"],["player","Now Playing"],["mixtape","Mixtape"],["statcard","Stat"],["zine","Zine"],["gazette","Gazette"],["editorial","Editorial"],["wanted","Wanted"],["ticket","Ticket"],["wedding","Wedding"],["minimal","Minimal"]];',
    extractFn(boothBuilt, 'function isOutputTarget('),
    extractFn(boothBuilt, 'function tierSplitOn('),
    extractFn(boothBuilt, 'function layoutTier('),
    extractFn(boothBuilt, 'function effectiveLayoutTier('),
    extractFn(boothBuilt, 'function hexToRgb('),
    extractFn(boothBuilt, 'function lumOf('),
    extractFn(boothBuilt, 'function setLayout('),
    extractFn(boothBuilt, 'function receiptTime('),
    extractFn(boothBuilt, 'function receiptBoxBlur('),
    extractFn(boothBuilt, 'function ditherRegion('),
    extractFn(boothBuilt, 'function composeReceipt('),
    extractFn(boothBuilt, 'function stripTwoUp('),
    extractFn(boothBuilt, 'function printerKey('),
    extractFn(boothBuilt, 'function printerFor('),
    extractFn(boothBuilt, 'function withPrinterContext('),
    extractFn(boothBuilt, 'async function printExtraSheet('),
    extractFn(boothBuilt, 'function printExtraPrinters('),
    extractFn(boothBuilt, 'async function printViaHelper('),
    extractFn(boothBuilt, 'function isThermalPrinterName('),
    extractFn(boothBuilt, 'function isThermalPrintTarget('),
    extractFn(boothBuilt, 'function buildPrintCanvas('),
    extractFn(boothBuilt, 'async function sendToStation('),
    extractFn(boothBuilt, 'function printPreviewPages('),
    extractFn(boothBuilt, 'function wifiJob('),
    extractFn(boothBuilt, 'function wifiPackPages('),
    extractFn(boothBuilt, 'async function wifiPhotoJob('),
    extractFn(boothBuilt, 'function wifiForSize('),
    extractFn(boothBuilt, 'function pbEncodePrintDataUrls('),
    extractFn(boothBuilt, 'async function printViaWifi('),
    extractFn(boothBuilt, 'async function printViaWifiRaw('),
    extractFn(boothBuilt, 'function printAdjust('),
    extractFn(boothBuilt, 'function printAdjustAll('),
    extractFn(boothBuilt, 'async function printCurrentPhoto('),
    'window.__PBNetResult = function(r){ const j = r && wifiJobs[r.job]; if (!j) return; delete wifiJobs[r.job]; if (r.ok) j.res(r); else j.rej(new Error(r.error || "err")); };',
    'globalThis.__sim = { setLayout, buildPrintCanvas, printPreviewPages, printCurrentPhoto, renderComposite, getPrintSize: () => printSize, setPrintSize: (v) => { printSize = v; }, getLayout: () => currentLayout };'
  ].join('\n');

  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const sim = ctx.__sim;

  // --- SCENARIO 1: Exact customer bug repro (Receipt Solo colour + Now Playing + red ink + cream bg + tierSplit OFF + Print Helper on Epson L3210) ---
  ctx.tierSplit = false;
  ctx.receiptStyle = 'player';
  sim.setPrintSize('4x6');
  sim.setLayout('receipt1c');
  assert.equal(sim.getPrintSize(), '4x6', 'Scenario 1: selecting receipt1c keeps 4x6 photo paper');
  ctx.shotCanvases = [shot1];
  sim.renderComposite();

  // Verify on-screen preview is full colour with red ink and cream backdrop
  const screenStats = analyzeCanvasPixels(ctx.previewCanvas);
  assert.ok(screenStats.coloredRatio > 0.2, `Screen preview should be coloured (got ${screenStats.coloredRatio})`);
  assert.ok(screenStats.redInkPx > 50, `Screen preview should contain red ink #9b1c26 (got ${screenStats.redInkPx})`);
  assert.ok(screenStats.creamBgPx > 1000, `Screen preview should contain cream backdrop #faf8f5 (got ${screenStats.creamBgPx})`);

  // Print via Desktop Print Helper -> EPSON L3210 Series
  records.helperPosts.length = 0;
  helperEnabled = true; useOnlineStation = false; btRoute = false; activeWifiPrinter = null; extraPrinters = [];
  const ok1 = await sim.printCurrentPhoto(false, 1);
  assert.equal(ok1, true);
  assert.equal(records.helperPosts.length, 1);
  const job1 = records.helperPosts[0];
  assert.equal(job1.printer, 'EPSON L3210 Series');
  assert.equal(job1.widthMm, 101.6);
  assert.equal(job1.heightMm, 152.4);
  assert.equal(job1.twoUp, true);
  assert.equal(job1.receipt, undefined);
  assert.ok(job1.pages[0].coloredRatio > 0.2, `Printed 4R sheet MUST be full colour (got ${job1.pages[0].coloredRatio})`);
  assert.ok(job1.pages[0].redInkPx > 50, `Printed 4R sheet MUST preserve red heart/play/text ink (got ${job1.pages[0].redInkPx})`);
  assert.ok(job1.pages[0].creamBgPx > 1000, `Printed 4R sheet MUST preserve warm cream card bg (got ${job1.pages[0].creamBgPx})`);

  // --- SCENARIO 2: All 4 colour receipts (receiptc, receipt1c, receipt2c, receipt4c) print in FULL COLOUR ---
  for (const [lay, nShots] of [['receiptc', 3], ['receipt1c', 1], ['receipt2c', 2], ['receipt4c', 4]]) {
    records.helperPosts.length = 0;
    sim.setPrintSize('receipt80'); // even if coming straight from a B&W thermal roll!
    sim.setLayout(lay);
    assert.equal(sim.getPrintSize(), '4x6', `${lay} must auto-switch off receipt80 to 4x6`);
    ctx.shotCanvases = [shot1, shot2, shot3, shot4].slice(0, nShots);
    ctx.state = 'result';
    sim.renderComposite();
    assert.equal(await sim.printCurrentPhoto(false, 1), true);
    const p = records.helperPosts[0].pages[0];
    assert.ok(p.coloredRatio > 0.15 && p.redInkPx > 20, `${lay} must print full colour with red ink (coloredRatio=${p.coloredRatio}, redInkPx=${p.redInkPx})`);
  }

  // --- SCENARIO 3: Customer MANUALLY picks Receipt 80 mm with Receipt Solo colour on a COLOUR printer (EPSON L3210) ---
  records.helperPosts.length = 0;
  sim.setLayout('receipt1c');
  ctx.shotCanvases = [shot1];
  ctx.state = 'result';
  sim.renderComposite();
  sim.setPrintSize('receipt80');
  ctx.printerMap['receipt80'] = 'EPSON L3210 Series'; // user mapped their colour inkjet to receipt80!
  // Check Print Preview stays full colour too!
  const prevCol = sim.printPreviewPages();
  const prevStats = analyzeCanvasPixels(prevCol[0]);
  assert.ok(prevStats.coloredRatio > 0.2 && prevStats.redInkPx > 50, 'Print preview for colour receipt on colour printer must stay colour');

  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  const job3 = records.helperPosts[0];
  assert.equal(job3.printer, 'EPSON L3210 Series');
  assert.equal(job3.widthMm, 72);
  assert.ok(job3.heightMm > 110 && job3.heightMm < 140, `Physical roll height must be ~125mm at 2x resolution, not doubled (got ${job3.heightMm}mm)`);
  assert.ok(job3.pages[0].coloredRatio > 0.2, `Manual receipt80 on Epson colour printer MUST still print colour (got ${job3.pages[0].coloredRatio})`);
  assert.ok(job3.pages[0].redInkPx > 50, `Manual receipt80 on Epson colour printer MUST preserve red ink (got ${job3.pages[0].redInkPx})`);
  assert.equal(job3.pages[0].w, 1152, 'Manual receipt80 colour receipt keeps crisp 2x width (1152px)');

  // --- SCENARIO 4: Browser window.print() (no Print Helper) with Receipt Solo colour ---
  records.browserPrintPages = [];
  helperEnabled = false;
  sim.setLayout('receipt1c'); // auto-switches back to 4x6
  assert.equal(sim.getPrintSize(), '4x6');
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.browserPrintPages.length, 1);
  assert.ok(records.browserPrintPages[0].stats.coloredRatio > 0.2 && records.browserPrintPages[0].stats.redInkPx > 50, 'Browser print on 4x6 must be full colour');
  assert.ok(records.browserPageCss.includes('101.6mm 152.4mm'));

  // Browser window.print() with manual receipt80 on colour receipt -> ALSO stays full colour!
  records.browserPrintPages = [];
  sim.setPrintSize('receipt80');
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.ok(records.browserPrintPages[0].stats.coloredRatio > 0.2 && records.browserPrintPages[0].stats.redInkPx > 50, 'Browser print on manual receipt80 with colour receipt must still be colour');
  assert.ok(records.browserPageCss.includes('72mm '), `Browser @page should use 72mm width (got ${records.browserPageCss})`);

  // --- SCENARIO 5: Online Print Station (iPad -> Laptop /print-station/) ---
  records.stationPosts.length = 0;
  useOnlineStation = true;
  sim.setLayout('receipt1c'); // 4x6
  assert.equal(sim.getPrintSize(), '4x6');
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.stationPosts.length, 1);
  assert.ok(records.stationPosts[0].page.coloredRatio > 0.2 && records.stationPosts[0].page.redInkPx > 50, 'Online Print Station on 4x6 must receive full colour');

  // Online Print Station with manual receipt80 + colour receipt -> still receives full colour!
  records.stationPosts.length = 0;
  sim.setPrintSize('receipt80');
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.ok(records.stationPosts[0].page.coloredRatio > 0.2 && records.stationPosts[0].page.redInkPx > 50, 'Online Print Station on manual receipt80 with colour receipt must receive full colour');
  useOnlineStation = false;

  // --- SCENARIO 6: Android / iPad Wi-Fi Photo Printer (IPP) & AirPrint / Android Print Dialog ---
  records.wifiIpp.length = 0;
  helperEnabled = false;
  activeWifiPrinter = { name: 'EPSON L8050', ip: '192.168.1.50', ipp: true, raw: false };
  sim.setLayout('receipt1c'); // 4x6
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.wifiIpp.length, 1);
  assert.ok(records.wifiIpp[0].pics[0].coloredRatio > 0.2 && records.wifiIpp[0].pics[0].redInkPx > 50, 'Android/iPad IPP photo printer must print colour receipt in full colour');

  // AirPrint / Android Print Dialog
  activeWifiPrinter = null;
  records.nativeDialog.length = 0;
  nativeDialogBridge = {
    print(title, w, h, imgsJson) {
      records.nativeDialog.push({ title, w, h, imgs: JSON.parse(imgsJson).map(parseSimDataUrl) });
      return JSON.stringify({ ok: true });
    }
  };
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.nativeDialog.length, 1);
  assert.ok(records.nativeDialog[0].imgs[0].coloredRatio > 0.2 && records.nativeDialog[0].imgs[0].redInkPx > 50, 'AirPrint / Android Print Dialog must receive full colour');
  nativeDialogBridge = null;

  // --- SCENARIO 7: B&W Receipt templates (receipt, receipt1, receipt2, receipt4) ALWAYS print pure B&W on thermal ---
  helperEnabled = true;
  ctx.printerMap['receipt80'] = 'Xprinter XP-80C';
  for (const [lay, nShots] of [['receipt', 3], ['receipt1', 1], ['receipt2', 2], ['receipt4', 4]]) {
    records.helperPosts.length = 0;
    sim.setPrintSize('4x6');
    sim.setLayout(lay);
    assert.equal(sim.getPrintSize(), 'receipt80', `${lay} (B&W) must auto-switch to receipt80`);
    ctx.shotCanvases = [shot1, shot2, shot3, shot4].slice(0, nShots);
    ctx.state = 'result';
    sim.renderComposite();
    assert.equal(await sim.printCurrentPhoto(false, 1), true);
    const p = records.helperPosts[0].pages[0];
    assert.equal(p.w, 576, `${lay} must render at exact 576px thermal width`);
    assert.equal(p.maxChroma, 0, `${lay} (B&W) must have ZERO colour chroma (pure grayscale)`);
    assert.equal(p.redInkPx, 0, `${lay} (B&W) must have zero red ink`);
    assert.ok(p.pureBlackPx > 50, `${lay} (B&W) must render crisp pure #000000 ink`);
    assert.ok(p.pureWhitePx > 1000, `${lay} (B&W) must render pure #ffffff backdrop`);
  }

  // --- SCENARIO 8: Colour receipt on REAL THERMAL printers (Xprinter Helper, Bluetooth thermal, Android raw ESC/POS) ---
  // 8a. Desktop Print Helper mapped to Xprinter XP-80C with manual receipt80
  records.helperPosts.length = 0;
  sim.setLayout('receipt1c');
  ctx.shotCanvases = [shot1];
  ctx.state = 'result';
  sim.renderComposite();
  sim.setPrintSize('receipt80');
  ctx.printerMap['receipt80'] = 'Xprinter XP-80C';
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.helperPosts[0].pages[0].w, 576);
  assert.equal(records.helperPosts[0].pages[0].maxChroma, 0, 'Xprinter XP-80C must receive thermal-toned grayscale');
  assert.ok(records.helperPosts[0].pages[0].pureBlackPx > 50, 'Xprinter XP-80C must receive pure black text ink');

  // 8b. Bluetooth Thermal Printer (real toReceiptCanvas + EscPosEncoder)
  records.btPrints.length = 0;
  helperEnabled = false; btRoute = true;
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.btPrints.length, 1);
  assert.equal(records.btPrints[0].srcStats.maxChroma, 0, 'Bluetooth thermal receives pre-toned thermal grayscale');
  assert.equal(records.btPrints[0].monoStats.maxChroma, 0, 'Bluetooth thermal outputs 1-bit monochrome');
  assert.ok(records.btPrints[0].escBytes > 10000, 'Bluetooth thermal emits valid ESC/POS raster buffer');
  btRoute = false;

  // 8c. Android / iPad Raw ESC/POS Thermal Printer
  records.wifiRaw.length = 0;
  activeWifiPrinter = { name: 'Rongta RP30', ip: 'usb://rp30', raw: true, ipp: false };
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.wifiRaw.length, 1);
  assert.ok(records.wifiRaw[0].bytes > 10000, 'Raw ESC/POS thermal emits valid raster payload');
  activeWifiPrinter = null;

  // --- SCENARIO 9: Dual simultaneous printing (Printer 1 = Epson L3210 on 4x6 COLOUR + Extra Printer 2 = Xprinter XP-80C on receipt80 B&W) ---
  records.helperPosts.length = 0;
  helperEnabled = true;
  ctx.printerMap['4x6'] = 'EPSON L3210 Series';
  ctx.printerMap['receipt80'] = 'Xprinter XP-80C';
  extraPrinters = [{ name: 'Xprinter XP-80C', size: 'receipt80', mode: 'extra' }];
  sim.setLayout('receipt1c'); // auto-sets 4x6 for Printer 1!
  ctx.shotCanvases = [shot1];
  ctx.state = 'result';
  sim.renderComposite();
  assert.equal(await sim.printCurrentPhoto(false, 1), true);
  assert.equal(records.helperPosts.length, 2, 'Both Printer 1 and Extra Printer 2 must receive jobs');
  const p1Job = records.helperPosts.find((j) => j.printer === 'EPSON L3210 Series');
  const p2Job = records.helperPosts.find((j) => j.printer === 'Xprinter XP-80C');
  assert.ok(p1Job && p2Job);
  assert.ok(p1Job.pages[0].coloredRatio > 0.2 && p1Job.pages[0].redInkPx > 50, 'Printer 1 (Epson 4x6) prints FULL COLOUR');
  assert.equal(p2Job.pages[0].maxChroma, 0, 'Extra Printer 2 (Xprinter 80mm) simultaneously prints crisp thermal B&W');
  assert.equal(p2Job.pages[0].w, 576);
  extraPrinters = [];

  // --- SCENARIO 10: Every aesthetic receipt style (all 11 styles) prints COLOUR on receipt1c and pure B&W on receipt1 ---
  const ALL_STYLES = ['classic', 'player', 'mixtape', 'statcard', 'zine', 'gazette', 'editorial', 'wanted', 'ticket', 'wedding', 'minimal'];
  for (const st of ALL_STYLES) {
    ctx.receiptStyle = st;
    // Colour receipt -> auto-routes to 4x6 photo paper and prints in full colour
    records.helperPosts.length = 0;
    sim.setPrintSize('receipt80');
    sim.setLayout('receipt1c');
    assert.equal(sim.getPrintSize(), '4x6', `style=${st} receipt1c must route to 4x6`);
    ctx.shotCanvases = [shot1]; ctx.state = 'result';
    sim.renderComposite();
    assert.equal(await sim.printCurrentPhoto(false, 1), true);
    const cp = records.helperPosts[0].pages[0];
    assert.ok(cp.coloredRatio > 0.15, `style=${st} receipt1c must print coloured pixels (got ${cp.coloredRatio})`);
    assert.ok(cp.redInkPx > 10, `style=${st} receipt1c must print coloured ink (got ${cp.redInkPx})`);

    // B&W receipt -> auto-routes to receipt80 thermal roll and prints pure monochrome
    records.helperPosts.length = 0;
    sim.setLayout('receipt1');
    assert.equal(sim.getPrintSize(), 'receipt80', `style=${st} receipt1 must route to receipt80`);
    ctx.shotCanvases = [shot1]; ctx.state = 'result';
    sim.renderComposite();
    assert.equal(await sim.printCurrentPhoto(false, 1), true);
    const bp = records.helperPosts[0].pages[0];
    assert.equal(bp.maxChroma, 0, `style=${st} receipt1 must have zero colour chroma`);
    assert.equal(bp.w, 576, `style=${st} receipt1 must render at 576px thermal width`);
  }
});
