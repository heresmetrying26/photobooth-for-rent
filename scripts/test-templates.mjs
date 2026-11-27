// Regression tests for Receipt templates, Music Player receipt, and Minimalist / 4-Cut Ready Designs.
// Run: node scripts/test-templates.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
const adminHtml = readFileSync(join(ROOT, 'public', 'admin.html'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS:', name);
  } catch (e) {
    console.error('FAIL:', name + '\n  ' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
}

function extractBlock(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s >= 0, 'Missing marker: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  assert.ok(e > s, 'Missing end marker: ' + endMarker);
  return html.slice(s, e);
}

function makeSandbox() {
  const opsLog = [];
  function createCanvas() {
    let _w = 0, _h = 0;
    let stack = [{ tx: 0, ty: 0, clip: null, op: 'source-over', alpha: 1 }];
    const cur = () => stack[stack.length - 1];
    const resetState = () => { stack = [{ tx: 0, ty: 0, clip: null, op: 'source-over', alpha: 1 }]; };
    const cv = {
      _isMockCanvas: true,
      get width() { return _w; },
      set width(v) { _w = Number(v) || 0; resetState(); },
      get height() { return _h; },
      set height(v) { _h = Number(v) || 0; resetState(); },
      toDataURL() { return 'data:image/png;base64,MOCK'; },
      getContext() {
        return {
          canvas: cv,
          fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineJoin: 'miter', lineCap: 'butt',
          miterLimit: 10, font: '12px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
          shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
          imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
          get globalAlpha() { return cur().alpha; },
          set globalAlpha(v) { cur().alpha = v; },
          get globalCompositeOperation() { return cur().op; },
          set globalCompositeOperation(v) { cur().op = v; },
          save() {
            const top = cur();
            stack.push({ tx: top.tx, ty: top.ty, clip: top.clip ? { ...top.clip } : null, op: top.op, alpha: top.alpha });
          },
          restore() { if (stack.length > 1) stack.pop(); },
          setTransform(a, b, c, d) { if (a === 1 && b === 0 && c === 0 && d === 1) { cur().tx = 0; cur().ty = 0; } },
          translate(x, y) { cur().tx += x; cur().ty += y; },
          rotate() {}, scale() {},
          beginPath() { cv._lastRect = null; },
          rect(x, y, w, h) { cv._lastRect = { x: x + cur().tx, y: y + cur().ty, w, h }; },
          roundRect() {}, moveTo() {}, lineTo() {}, arcTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
          arc() {}, ellipse() {}, closePath() {},
          clip() { if (cv._lastRect) cur().clip = { ...cv._lastRect }; },
          fill() {}, stroke() {}, clearRect() {},
          fillRect(x, y, w, h) { opsLog.push({ type: 'fillRect', cv, x, y, w, h, fill: this.fillStyle }); },
          strokeRect() {},
          measureText(s) { return { width: String(s || '').length * 8 }; },
          fillText(t, x, y) { opsLog.push({ type: 'fillText', cv, text: String(t), x, y }); },
          strokeText() {},
          getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }; },
          putImageData() {},
          createLinearGradient() { return { addColorStop() {} }; },
          createRadialGradient() { return { addColorStop() {} }; },
          drawImage(src) {
            const sw = src && (src.naturalWidth || src.width || 0);
            const sh = src && (src.naturalHeight || src.height || 0);
            if (!src || !sw || !sh) throw new Error('drawImage 0x0 source');
            opsLog.push({ type: 'drawImage', cv, src });
          },
          get _stackDepth() { return stack.length - 1; }
        };
      }
    };
    return cv;
  }

  const labelInput = { value: 'Golden Hour', placeholder: '', style: {} };
  const dateInput = { value: '2026-11-27' };
  const stubEl = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, appendChild() {}, querySelectorAll: () => [], children: [] });
  const ctx = {
    Math, Number, String, Array, Object, Boolean, JSON, Date, Set, Map, Error, RegExp, Uint8Array, Uint8ClampedArray, Float32Array, console,
    HTMLImageElement: function MockImg() {},
    HTMLVideoElement: function MockVid() {},
    document: {
      createElement: (tag) => (tag === 'canvas' ? createCanvas() : stubEl()),
      getElementById: () => stubEl(),
      querySelectorAll: () => []
    },
    DESKTOP: false, LANREMOTE: false, LOCALSHARE: false, USB_SHOT_MAX: 3000,
    BOX_PROBE: null, SHOT_ASPECT: 4 / 5, photoFit: 'fill', filterKey: 'none', softSkin: false, dateStamp: false,
    previewSample: null, drawnSampleCache: {}, shotCrops: {},
    labelInput, dateInput,
    currentFont: "'Inter', sans-serif", currentDateFont: "'Courier New', monospace",
    backdropPreset: 'none', elementsChoice: 'auto', backdropColor: null,
    textColor: '#151515', useOutline: false, useShadow: false, outlineColor: '#ffffff',
    frameColorChoice: 'auto', cropFocus: 'center', titleBgEnabled: false, titleBgColor: '#ffffff',
    photoPlacement: 'band', currentFrameColor: '#ffffff', titleSizeMultiplier: 1,
    sessionNumber: 12, overlay: null, logo: null, decor: [],
    previewCanvas: null, setupPreviewCanvas: null,
    printPrefs: { thermalQuality: 'best' }, colorAdj: { brightness: 0 },
    FILTERS: { none: null },
    recordShotSlotBox: () => {},
    pbDrawableReady: (im) => !!(im && (im.naturalWidth || im.width) > 0 && (im.naturalHeight || im.height) > 0),
    isOutputTarget: () => false,
    offlineOutputScale: () => 1,
    currentDateLabel: () => '11/27/26',
    placement: () => 'band',
    isFrameLayout: () => false,
    composePmCanvas: () => {}, composeFrameCanvas: () => {}, composeCard: () => {}, composeCert: () => {},
    pbCaptureDecorBase: () => {}, drawDecorLayer: () => {},
    pbReleaseCanvas: (cv) => { if (cv) { cv.width = 0; cv.height = 0; } },
    _opsLog: opsLog,
    _createCanvas: createCanvas
  };
  vm.createContext(ctx);
  return ctx;
}

function loadTemplateRuntime(sb) {
  const code = [
    extractBlock('const FONT_OPTIONS = [', 'function buildFontDropdown'),
    'function seededRand(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }',
    'function elCount(w, h, base) { return base; }',
    'function visiblePos(rand, w, h) { return [rand() * w, rand() * h]; }',
    'function drawStar(ctx, x, y, r) {}',
    'function drawDecorations() {}',
    extractBlock('function hexToRgb(', 'function drawBackdrop('),
    extractBlock('function rgbToHsl(', 'function computeDominantColor('),
    extractBlock('const STRIP_W = 600', 'function layoutOrder()'),
    'function layoutDef(k) { return LAYOUT_DEFS[k] || LAYOUT_DEFS.strip; }',
    'function isStripLayout(k) { var d = layoutDef(k); return d && d.kind === "strip"; }',
    'function shotsNeeded(k) { return (layoutDef(k) && layoutDef(k).shots) || 3; }',
    extractBlock('function drawBackdrop(', 'async function uploadToLitterbox('),
    extractBlock('function drawImageCover(', 'function renderGridSidePhoto('),
    extractBlock('function renderSheet(', 'function calmBehindText('),
    'function calmBehindText() {}',
    'function calmBox() {}',
    extractBlock('function drawLabelBand(', 'function hexLuminance('),
    'function drawCustomPhotoBackdrop() {}',
    extractBlock('function landscapeCells(', 'const RECEIPT_W = 576'),
    extractBlock('function composeCanvas(', 'function landscapeCells('),
    extractBlock('const RECEIPT_W = 576', 'var titleStyleSelect ='),
    extractBlock('var THEME_CATS = [', 'var themeCat = \'All\';'),
    extractBlock('function withThemeState(t, fn) {', 'function drawThemeThumb(')
  ].join('\n');
  return vm.runInContext(
    code + '\n' +
    'const LABEL_BAND_RATIO = 0.14;\n' +
    'const LAYOUTS = { strip: { w: STRIP_W, contentH: STRIP_CONTENT_H }, strip4: { w: STRIP_W, contentH: STRIP4_CONTENT_H }, stripxl: { w: STRIP_W, contentH: STRIPXL_CONTENT_H }, grid: { w: GRID_W, contentH: GRID_H, render: renderGrid } };\n' +
    '({ FONT_OPTIONS, LAYOUT_DEFS, BACKDROP_PRESETS });',
    sb
  );
}

await test('all themes in THEMES pass schema, font, preset, art, and category validation', () => {
  const sb = makeSandbox();
  const rt = loadTemplateRuntime(sb);

  const seen = new Set();
  const fontValues = new Set(rt.FONT_OPTIONS.map((f) => f[0]));
  const titleStyleKeys = new Set(sb.TITLE_STYLES.map((s) => s[0]));
  const receiptStyleKeys = new Set(sb.RECEIPT_STYLES.map((s) => s[0]));
  const artKeys = new Set(sb.ART_KEYS);
  const catSet = new Set(sb.THEME_CATS);

  assert.ok(catSet.has('Receipt'), 'THEME_CATS must include Receipt');
  assert.ok(catSet.has('Minimalist'), 'THEME_CATS must include Minimalist');

  sb.THEMES.forEach((t) => {
    assert.match(t.id, /^[a-z0-9-]{1,40}$/, 'Invalid theme id: ' + t.id);
    assert.ok(!seen.has(t.id), 'Duplicate theme id: ' + t.id);
    seen.add(t.id);
    assert.ok(Array.isArray(t.cats) && t.cats.length > 0, 'Missing cats on ' + t.id);
    t.cats.forEach((c) => assert.ok(catSet.has(c), 'Unknown cat "' + c + '" on ' + t.id));
    assert.ok(fontValues.has(t.font), 'Font not in FONT_OPTIONS on ' + t.id + ': ' + t.font);
    if (t.dateFont) assert.ok(fontValues.has(t.dateFont), 'dateFont not in FONT_OPTIONS on ' + t.id + ': ' + t.dateFont);
    if (t.preset !== 'none') assert.ok(rt.BACKDROP_PRESETS[t.preset], 'Unknown preset on ' + t.id + ': ' + t.preset);
    if (t.titleStyle) assert.ok(titleStyleKeys.has(t.titleStyle), 'Unknown titleStyle on ' + t.id + ': ' + t.titleStyle);
    if (t.receiptStyle) assert.ok(receiptStyleKeys.has(t.receiptStyle), 'Unknown receiptStyle on ' + t.id + ': ' + t.receiptStyle);
    if (t.art) t.art.forEach((ak) => assert.ok(artKeys.has(ak), 'Unknown art key on ' + t.id + ': ' + ak));
    if (t.layout) assert.ok(rt.LAYOUT_DEFS[t.layout], 'Unknown layout on ' + t.id + ': ' + t.layout);
  });

  // Ensure music player, minimalist, and zero trademarked/copied names exist
  assert.ok(seen.has('music-player-receipt'));
  assert.ok(seen.has('music-strip-receipt'));
  assert.ok(seen.has('music-color-receipt'));
  assert.ok(seen.has('mixtape-receipt'));
  assert.ok(seen.has('studio-white-4cut'));
  assert.ok(seen.has('matte-noir-4cut'));
  assert.ok(seen.has('cobalt-studio-4cut'));

  const forbidden = /phototags|super\s*snap|snap\s*hero|life\s*4\s*cuts|spotify|vogue|receiptify/i;
  sb.THEMES.forEach((t) => {
    assert.ok(!forbidden.test(t.name), 'Copied/trademarked name found in theme: ' + t.name);
  });
});

await test('composeReceipt renders all 11 receipt styles across 1, 2, 3, and 4 shots in B&W, thermal grey, and colour', () => {
  const sb = makeSandbox();
  loadTemplateRuntime(sb);

  const mockShot = { naturalWidth: 800, naturalHeight: 1000, width: 800, height: 1000 };
  const shots = [mockShot, mockShot, mockShot, mockShot];
  const receiptLayouts = ['receipt1', 'receipt2', 'receipt', 'receipt4', 'receipt1c', 'receipt2c', 'receiptc', 'receipt4c'];

  sb.labelInput.value = 'Summer Music Fest 2026';
  sb.kickerText = 'LIVE STAGE · SETLIST';
  sb.receiptCustomNote = '@studio.booth · #memories';

  sb.RECEIPT_STYLES.forEach(([styleKey]) => {
    sb.receiptStyle = styleKey;
    receiptLayouts.forEach((lay) => {
      [false, true].forEach((grey) => {
        sb.receiptPrintGrey = grey;
        const cv = sb._createCanvas();
        sb.composeReceipt(lay, cv, shots);
        assert.equal(cv.width, 576, `${styleKey}/${lay} width must be 576`);
        assert.ok(cv.height > 500, `${styleKey}/${lay} height too small: ${cv.height}`);
        assert.equal(cv.getContext('2d')._stackDepth, 0, `${styleKey}/${lay} leaked ctx save/restore`);
      });
    });
  });

  // Verify Music Player receipt actually draws title, timestamps, and NOW PLAYING
  sb.receiptStyle = 'player';
  sb.receiptPrintGrey = false;
  sb._opsLog.length = 0;
  const pcv = sb._createCanvas();
  sb.composeReceipt('receipt1', pcv, [mockShot]);
  const texts = sb._opsLog.filter((o) => o.type === 'fillText' && o.cv === pcv).map((o) => o.text);
  assert.ok(texts.some((t) => t.includes('NOW PLAYING')), 'Player style must draw NOW PLAYING');
  assert.ok(texts.some((t) => /^\d{2}:\d{2}$/.test(t)), 'Player style must draw mm:ss timestamps');
  assert.ok(texts.some((t) => t.includes('Summer Music Fest')), 'Player style must draw event title');
});

await test('all minimalist & 4-cut themes render cleanly across composeCanvas without stack leaks', () => {
  const sb = makeSandbox();
  const rt = loadTemplateRuntime(sb);
  const mockShot = { naturalWidth: 800, naturalHeight: 1000, width: 800, height: 1000 };
  const shots = [mockShot, mockShot, mockShot, mockShot, mockShot, mockShot];

  const minThemes = sb.THEMES.filter((t) => t.cats.includes('Minimalist') && (!t.layout || rt.LAYOUT_DEFS[t.layout].kind !== 'receipt'));
  assert.ok(minThemes.length >= 16, 'Expected at least 16 Minimalist non-receipt themes, got ' + minThemes.length);

  minThemes.forEach((t) => {
    const cv = sb._createCanvas();
    const lk = t.layout || 'strip4';
    sb.withThemeState(t, () => {
      sb.composeCanvas(lk, cv, shots);
    });
    assert.ok(cv.width > 0 && cv.height > 0, `Theme ${t.id} rendered 0x0`);
    assert.equal(cv.getContext('2d')._stackDepth, 0, `Theme ${t.id} leaked ctx stack`);
  });
});

await test('all Christmas themes (2x6, 4R, landscape 2-shot) render cleanly across composeCanvas', () => {
  const sb = makeSandbox();
  const rt = loadTemplateRuntime(sb);
  const mockShot = { naturalWidth: 800, naturalHeight: 1000, width: 800, height: 1000 };
  const shots = [mockShot, mockShot, mockShot, mockShot, mockShot, mockShot];

  const xmas = sb.THEMES.filter((t) => t.cats.includes('Christmas'));
  assert.ok(xmas.length >= 26, 'Expected >=26 Christmas themes total, got ' + xmas.length);

  const strips = xmas.filter((t) => t.layout && rt.LAYOUT_DEFS[t.layout].kind === 'strip');
  const sheets = xmas.filter((t) => t.layout && (rt.LAYOUT_DEFS[t.layout].kind === 'sheet' || rt.LAYOUT_DEFS[t.layout].kind === 'polaroid'));
  const lands = xmas.filter((t) => t.layout === 'land2' || t.layout === 'land2t');
  assert.ok(strips.length >= 9, 'Expected >=9 Christmas 2x6 strips, got ' + strips.length);
  assert.ok(sheets.length >= 8, 'Expected >=8 Christmas 4R sheets, got ' + sheets.length);
  assert.ok(lands.length >= 8, 'Expected >=8 Christmas landscape 2-shot designs, got ' + lands.length);

  xmas.forEach((t) => {
    const cv = sb._createCanvas();
    const lk = t.layout || 'strip';
    sb.withThemeState(t, () => {
      sb.composeCanvas(lk, cv, shots);
    });
    assert.ok(cv.width > 0 && cv.height > 0, `Christmas theme ${t.id} rendered 0x0`);
    assert.equal(cv.getContext('2d')._stackDepth, 0, `Christmas theme ${t.id} leaked ctx stack`);
  });
});

await test('public/admin.html THEME_LIST contains all new Receipt, Minimalist, and Christmas theme IDs', () => {
  const sb = makeSandbox();
  loadTemplateRuntime(sb);
  const themeIds = new Set(sb.THEMES.map((t) => t.id));
  const m = /var THEME_LIST = (\[[\s\S]*?\]);/.exec(adminHtml);
  assert.ok(m, 'Missing THEME_LIST in public/admin.html');
  const list = vm.runInNewContext(m[1]);
  const adminIds = new Set();
  list.forEach((grp) => grp[1].forEach(([id]) => adminIds.add(id)));
  adminIds.forEach((id) => assert.ok(themeIds.has(id), 'admin.html lists unknown theme id: ' + id));
  ['music-player-receipt', 'mixtape-receipt', 'studio-white-4cut', 'matte-noir-4cut', 'cobalt-studio-4cut', 'aura-blush-4cut', 'xmas-nordic-plaid', 'xmas-tartan-grid4', 'xmas-l2-pine-garland', 'xmas-l2-minimal-cream'].forEach((id) => {
    assert.ok(adminIds.has(id), 'admin.html THEME_LIST missing ' + id);
  });
});

console.log('All template tests passed (' + passed + '/' + passed + ').');
