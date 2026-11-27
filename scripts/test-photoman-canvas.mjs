// Regression tests for Photoman Template Maker canvas rendering and placeholder shot cache.
// Run: node scripts/test-photoman-canvas.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');

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

// Extract balanced function/var snippets by start marker from booth.html.
function extractBlock(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  assert.ok(s >= 0, 'Missing marker: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  assert.ok(e > s, 'Missing end marker: ' + endMarker);
  return html.slice(s, e);
}

function makeCanvasSandbox() {
  const opsLog = [];
  function createCanvas() {
    let _w = 0, _h = 0;
    let stack = [{ tx: 0, ty: 0, clip: null, op: 'source-over', alpha: 1 }];
    const cur = () => stack[stack.length - 1];
    const resetState = () => {
      stack = [{ tx: 0, ty: 0, clip: null, op: 'source-over', alpha: 1 }];
    };
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
          fillStyle: '#000',
          strokeStyle: '#000',
          lineWidth: 1,
          lineJoin: 'miter',
          lineCap: 'butt',
          font: '12px sans-serif',
          textAlign: 'left',
          textBaseline: 'alphabetic',
          shadowColor: 'transparent',
          shadowBlur: 0,
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          imageSmoothingEnabled: true,
          imageSmoothingQuality: 'low',
          get globalAlpha() { return cur().alpha; },
          set globalAlpha(v) { cur().alpha = v; },
          get globalCompositeOperation() { return cur().op; },
          set globalCompositeOperation(v) { cur().op = v; },
          save() {
            const top = cur();
            stack.push({ tx: top.tx, ty: top.ty, clip: top.clip ? { ...top.clip } : null, op: top.op, alpha: top.alpha });
          },
          restore() {
            if (stack.length > 1) stack.pop();
          },
          setTransform(a, b, c, d, e, f) {
            if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) {
              cur().tx = 0; cur().ty = 0;
            }
          },
          translate(x, y) { cur().tx += x; cur().ty += y; },
          rotate() {},
          scale() {},
          beginPath() { cv._lastRect = null; },
          rect(x, y, w, h) { cv._lastRect = { x: x + cur().tx, y: y + cur().ty, w, h }; },
          moveTo() {},
          lineTo() {},
          bezierCurveTo() {},
          quadraticCurveTo() {},
          arc() {},
          ellipse() {},
          closePath() {},
          clip() { if (cv._lastRect) cur().clip = { ...cv._lastRect }; },
          fill() {},
          stroke() {},
          clearRect() {},
          fillRect(x, y, w, h) {
            opsLog.push({ type: 'fillRect', cv, x: x + cur().tx, y: y + cur().ty, w, h, clip: cur().clip ? { ...cur().clip } : null, fill: this.fillStyle });
          },
          strokeRect() {},
          measureText(s) { return { width: String(s || '').length * 8 }; },
          fillText() {},
          strokeText() {},
          createLinearGradient() { return { addColorStop() {} }; },
          createRadialGradient() { return { addColorStop() {} }; },
          drawImage(src, ...args) {
            if (src && src._forceThrow) throw new Error('Simulated drawImage failure');
            const sw = src && (src.naturalWidth || src.width || 0);
            const sh = src && (src.naturalHeight || src.height || 0);
            if (!src || !sw || !sh) {
              throw new Error("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.");
            }
            opsLog.push({ type: 'drawImage', cv, src, args, tx: cur().tx, ty: cur().ty, clip: cur().clip ? { ...cur().clip } : null });
          },
          get _stackDepth() { return stack.length - 1; },
          get _curState() { return cur(); }
        };
      }
    };
    return cv;
  }

  const assets = Object.create(null);
  const ctx = {
    Math, Number, String, Array, Object, Boolean, JSON, Date, Set, Map, Error, Promise,
    Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, console,
    HTMLImageElement: function MockImg() {},
    HTMLVideoElement: function MockVid() {},
    document: { createElement: (tag) => (tag === 'canvas' ? createCanvas() : {}) },
    DESKTOP: false,
    BOX_PROBE: null,
    SHOT_ASPECT: 4 / 3,
    photoFit: 'cover',
    filterKey: 'none',
    softSkin: false,
    dateStamp: false,
    previewSample: null,
    drawnSampleCache: {},
    receiptPrintGrey: false,
    shotCrops: {},
    recordShotSlotBox: () => {},
    backdropColor: '',
    accent: 'gold',
    accentUsed: false,
    assetImg: (id) => (assets[id] ? assets[id].img : null),
    isOutputTarget: () => false,
    offlineOutputScale: () => 1,
    roundRectPath: (c2, x, y, w, h) => { c2.beginPath(); c2.rect(x, y, w, h); },
    applyFilterToCanvas: () => {},
    pmTplById: () => null,
    punchFrame: (src) => src,
    _assets: assets,
    _opsLog: opsLog,
    _createCanvas: createCanvas
  };
  vm.createContext(ctx);
  return ctx;
}

await test('all inline <script> blocks in protected/booth.html parse cleanly', () => {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m, count = 0;
  while ((m = re.exec(html)) !== null) {
    if (!m[1].trim()) continue;
    new vm.Script(m[1], { filename: 'booth.html#script-' + (++count) });
  }
  assert.ok(count >= 1, 'Expected at least 1 script block in protected/booth.html');
});

await test('buildPlaceholderShots and pmStageSamplesList never return 0x0 released canvases across size changes or memory pressure', () => {
  const sb = makeCanvasSandbox();
  vm.runInContext(
    extractBlock('function pbReleaseCanvas(cv) {', 'function pbReleaseMotionClips() {') + '\n' +
    extractBlock('function pbShotsMatch(a, b) {', 'function pbCaptureDecorBase(') + '\n' +
    extractBlock('function drawSamplePerson(', 'function grabCameraSample() {') + '\n' +
    extractBlock('var _phCache =', 'var _spotPostTimer = 0;') + '\n' +
    'var pmMakerSamples = null;\n' +
    extractBlock('function pmStageSamplesList(n) {', 'function pmTextBoxNorm('),
    sb
  );

  const maker1 = sb.pmStageSamplesList(3);
  assert.equal(maker1.length, 3);
  maker1.forEach((c) => { assert.ok(c.width > 0 && c.height > 0); });

  // Interleaved calls with Setup (400), Layout thumbs (220), Theme thumbs (260), Booth cards (300)
  const setupShots = sb.buildPlaceholderShots(400, 4);
  const thumbShots = sb.buildPlaceholderShots(220, 4);
  const themeShots = sb.buildPlaceholderShots(260, 4);
  const cardShots = sb.buildPlaceholderShots(300, 1);

  assert.ok(setupShots.every((c) => c.width > 0 && c.height > 0));
  assert.ok(thumbShots.every((c) => c.width > 0 && c.height > 0));
  assert.ok(themeShots.every((c) => c.width > 0 && c.height > 0));
  assert.ok(cardShots.every((c) => c.width > 0 && c.height > 0));

  // Even after LRU eviction or memory pressure clearing all placeholder caches, pmStageSamplesList returns fresh live canvases
  sb.pbReleasePlaceholderCache();
  const maker2 = sb.pmStageSamplesList(2);
  assert.equal(maker2.length, 2);
  maker2.forEach((c) => {
    assert.ok(c.width > 0 && c.height > 0, 'pmStageSamplesList must never return 0x0 canvases after cache release');
  });
});

await test('composePmCanvas draws background full-bleed, custom PNG frame, and never crashes or leaks clip/translate on 0x0 inputs', () => {
  const sb = makeCanvasSandbox();
  vm.runInContext(
    extractBlock('function pbReleaseCanvas(cv) {', 'function pbReleaseMotionClips() {') + '\n' +
    extractBlock('function pbShotsMatch(a, b) {', 'function pbCaptureDecorBase(') + '\n' +
    extractBlock('function drawImageCover(', 'function drawPolaroid(') + '\n' +
    extractBlock('var PM_PUNCH_CACHE =', 'function pmDrawFrameDecor(') + '\n' +
    'function pmDrawFrameDecor() {}\n' +
    extractBlock('function composePmCanvas(', 'function composeCanvas('),
    sb
  );

  const bgMock = { naturalWidth: 1600, naturalHeight: 1200, width: 1600, height: 1200 };
  const ovMock = { naturalWidth: 1200, naturalHeight: 1800, width: 1200, height: 1800 };
  sb._assets.bg1 = { img: bgMock };
  sb._assets.ov1 = { img: ovMock };

  const tpl = {
    id: 't1', w: 1200, h: 1800, bgColor: '#fbf6ef', bgPreset: 'none', bgElements: 'none', bgAccent: 'gold',
    frameDecor: 'none', bgAssetId: 'bg1', overlayAssetId: 'ov1', punchWhite: false,
    spots: [{ x: 0.06, y: 0.05, w: 0.88, h: 0.72, s: 1, a: 0, r: 0, radius: 0, borderW: 0 }],
    stickers: [], texts: []
  };

  const stageCv = sb._createCanvas();
  const deadShot = sb._createCanvas(); // 0x0 canvas

  // 1. Even with a 0x0 shot canvas, composePmCanvas must not throw, must draw full-bleed bg and overlay, and leave ctx balanced
  sb.composePmCanvas('pm:t1', stageCv, [deadShot], { template: tpl, previewMaxSide: 840 });
  const ctx0 = stageCv.getContext('2d');
  assert.equal(ctx0._stackDepth, 0);
  assert.equal(ctx0._curState.tx, 0);
  assert.equal(ctx0._curState.ty, 0);
  assert.equal(ctx0._curState.clip, null);

  const bgDraw = sb._opsLog.find((o) => o.type === 'drawImage' && o.cv === stageCv && o.src === bgMock);
  assert.ok(bgDraw, 'Background image must be drawn');
  assert.equal(bgDraw.args[4], 0);
  assert.equal(bgDraw.args[5], 0);
  assert.equal(bgDraw.args[6], stageCv.width);
  assert.equal(bgDraw.args[7], stageCv.height);

  const ovDraw = sb._opsLog.find((o) => o.type === 'drawImage' && o.cv === stageCv && o.src === ovMock);
  assert.ok(ovDraw, 'Custom PNG frame overlay must still be drawn even when a shot is 0x0');
  assert.deepEqual(ovDraw.args, [0, 0, stageCv.width, stageCv.height]);

  // 2. If a render ever fails unexpectedly mid-spot, _pmNeedsReset forces a full canvas reset on the next render (no corner-clipped fillRect)
  const throwingShot = { width: 400, height: 300, _forceThrow: true };
  assert.throws(() => sb.composePmCanvas('pm:t1', stageCv, [throwingShot], { template: tpl, previewMaxSide: 840 }), /Simulated drawImage failure/);

  sb._opsLog.length = 0;
  tpl.bgAssetId = '';
  tpl.bgColor = '#ffffff';
  const goodShot = { width: 400, height: 300 };
  sb.composePmCanvas('pm:t1', stageCv, [goodShot], { template: tpl, previewMaxSide: 840 });
  const bgFill = sb._opsLog.find((o) => o.type === 'fillRect' && o.cv === stageCv && o.fill === '#ffffff');
  assert.ok(bgFill, 'Background fillRect must execute on recovery render');
  assert.equal(bgFill.x, 0, 'Background fillRect must start at x=0 (no leaked translate)');
  assert.equal(bgFill.y, 0, 'Background fillRect must start at y=0 (no leaked translate)');
  assert.equal(bgFill.clip, null, 'Background fillRect must not be clipped to previous spot');
});

await test('Photoman upload handlers preload images synchronously into addAsset', () => {
  assert.match(html, /bind\('pmBgFile',\s*'change'[\s\S]*?loadImageUrl\(dataUrl\)[\s\S]*?addAsset\(dataUrl,\s*null,\s*img\)/);
  assert.match(html, /async function pmImportOverlayFile[\s\S]*?loadImageUrl\(dataUrl\)[\s\S]*?addAsset\(dataUrl,\s*null,\s*img\)/);
});

console.log('Total passed:', passed);
