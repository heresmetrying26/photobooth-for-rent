import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');

// 1. Parse every <script> tag in protected/booth.html to guarantee zero JS syntax errors.
{
  const scriptRe = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m, count = 0;
  while ((m = scriptRe.exec(html)) !== null) {
    const code = m[1];
    if (!code.trim()) continue;
    new vm.Script(code, { filename: 'protected/booth.html#script-' + (++count) });
  }
  assert(count > 5, 'Expected multiple inline <script> blocks in protected/booth.html');
  console.log('PASS: all ' + count + ' inline <script> blocks in protected/booth.html parse cleanly');
}

// Helper to extract balanced block or functions from booth.html
function extractRange(startMarker, endMarker) {
  const i0 = html.indexOf(startMarker);
  assert(i0 >= 0, 'Missing marker: ' + startMarker);
  const i1 = html.indexOf(endMarker, i0);
  assert(i1 > i0, 'Missing end marker: ' + endMarker);
  return html.slice(i0, i1);
}

// Extract __gifencFactory + gifenc + GIF encoder + slideshow helpers
const gifencBlock = extractRange('function __gifencFactory()', '</script>');
const gifCodecBlock = extractRange('// Uniform 2D pixel sampler', 'function sampleClipFrames(');
const slideBlock = extractRange('var GIF_SLIDE_BGS =', '// Puts every GIF frame inside the booth');

// Build a deterministic mock Canvas2D environment to test real functions from booth.html
function makeMockCanvasEnv() {
  const stats = { composeCalls: 0, cardDraws: 0 };
  class MockCanvas {
    constructor(w = 300, h = 150) { this.width = w; this.height = h; this._rgba = null; }
    getContext() {
      const self = this;
      return {
        canvas: self,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        globalAlpha: 1,
        fillStyle: '#000',
        shadowColor: 'transparent',
        shadowBlur: 0,
        shadowOffsetY: 0,
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        clearRect() {}, fillRect() {},
        createLinearGradient() { return { addColorStop() {} }; },
        drawImage(src) {
          if (src && src._trackSlideDraw) stats.cardDraws++;
        },
        getImageData(x, y, w, h) {
          if (!self._rgba || self._rgba.length !== w * h * 4) {
            const buf = new Uint8ClampedArray(w * h * 4);
            const seed = (self._seed || 1);
            for (let yy = 0; yy < h; yy++) {
              for (let xx = 0; xx < w; xx++) {
                const i = (yy * w + xx) * 4;
                buf[i] = (xx * 3 + seed * 40) & 255;
                buf[i + 1] = (yy * 3 + seed * 70) & 255;
                buf[i + 2] = ((xx + yy) * 2 + seed * 90) & 255;
                buf[i + 3] = 255;
              }
            }
            self._rgba = buf;
          }
          return { data: new Uint8ClampedArray(self._rgba), width: w, height: h };
        }
      };
    }
  }

  class MockImageData {}
  class MockBlob {
    constructor(parts, opts) {
      this._buf = Buffer.concat(parts.map((p) => Buffer.from(p instanceof ArrayBuffer ? new Uint8Array(p) : p)));
      this.type = (opts && opts.type) || '';
      this.size = this._buf.length;
    }
    async arrayBuffer() { return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength); }
  }

  // In-process Web Worker simulator using vm.Context + worker self/onmessage contract
  let workerInstances = 0;
  let lastWorkerAbort = false;
  class MockWorker {
    constructor(url) {
      workerInstances++;
      this._listeners = { message: [], error: [] };
      const code = url._src;
      const wSelf = {
        postMessage: (msg) => {
          queueMicrotask(() => {
            this._listeners.message.forEach((fn) => fn({ data: msg }));
          });
        }
      };
      wSelf.self = wSelf;
      const wCtx = vm.createContext(wSelf);
      vm.runInContext(code, wCtx);
      this._wSelf = wSelf;
    }
    addEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].push(fn); }
    removeEventListener(type, fn) {
      if (!this._listeners[type]) return;
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    }
    postMessage(msg) {
      if (msg && msg.cmd === 'abort') lastWorkerAbort = true;
      queueMicrotask(() => {
        if (typeof this._wSelf.onmessage === 'function') this._wSelf.onmessage({ data: msg });
      });
    }
  }

  let nextShotSeed = 1;
  function makeShot(w, h) {
    const c = new MockCanvas(w, h);
    c._isShot = true;
    c._trackSlideDraw = true;
    c._seed = nextShotSeed++;
    return c;
  }

  const sandbox = {
    console, Math, Array, Object, Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float64Array,
    Promise, Error, Set, Map, JSON, String, Number, Boolean, RegExp, performance,
    setTimeout, clearTimeout,
    HTMLCanvasElement: MockCanvas,
    Blob: MockBlob,
    Worker: MockWorker,
    URL: {
      createObjectURL(blob) { return { _src: blob._buf.toString('utf8') }; },
      revokeObjectURL() {}
    },
    window: {},
    document: {
      createElement(tag) { assert.equal(tag, 'canvas'); return new MockCanvas(); }
    },
    gifFrameSource(fr) { return fr.make ? fr.make() : Promise.resolve(fr.blob); },
    createImageBitmap(b) { return Promise.resolve(b); },
    // Booth state stubs needed by gifSlideshowFrames
    shotCanvases: [makeShot(3000, 2000), makeShot(3000, 2000), makeShot(3000, 2000), makeShot(3000, 2000)],
    shotCrops: {},
    gifSlideCard: 'white',
    gifSlideBg: 'sunset',
    gifSlideFrame: 'card',
    currentLayout: 'strip4',
    overlay: null,
    currentFrameColor: '#ffffff',
    LAYOUT_DEFS: { solo: { shots: 1 }, strip4: { shots: 4 } },
    shotsNeeded(k) { return k === 'solo' ? 1 : 4; },
    drawImageCover(ctx, img, x, y, w, h) { ctx.drawImage(img, 0, 0, img.width, img.height, x, y, w, h); },
    composeCanvas(key, box, slots) {
      stats.composeCalls++;
      box.width = key === 'solo' ? 1200 : 600;
      box.height = 1800;
      slots.forEach((s) => { if (s && s._trackSlideDraw) stats.cardDraws++; });
    },
    stampTrialMark() {},
    getWorkerStats() { return { workerInstances, lastWorkerAbort }; },
    resetAbortFlag() { lastWorkerAbort = false; },
    stats
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(gifencBlock + '\n' + gifCodecBlock + '\n' + slideBlock, ctx);
  return { ctx, MockCanvas, stats };
}

const { ctx, stats } = makeMockCanvasEnv();

// 2. Verify slideCardGeometry dimensions across aspect ratios
{
  const ratios = [
    ['3:2 landscape', 1.5],
    ['16:9 wide', 16 / 9],
    ['1:1 square', 1],
    ['4:5 portrait', 0.8],
    ['2:3 portrait', 2 / 3]
  ];
  for (const [label, ar] of ratios) {
    const g = ctx.slideCardGeometry(ar);
    assert(g.outW <= 960 && g.outH <= 960, label + ' must fit within 960px max side, got ' + g.outW + 'x' + g.outH);
    const drawnPhotoW = g.pw * g.k;
    assert(drawnPhotoW >= 470, label + ' photo width should be crisp (>=470px), got ' + Math.round(drawnPhotoW));
  }
  console.log('PASS: slideCardGeometry scales crisply (photo >=470px, max side <=960px) across all aspect ratios');
}

// 3. Verify gifSlideshowFrames slide caching + localPalettes across all 3 frame modes
{
  // Card mode: 4 shots -> 12 frames (4 holds + 8 crossfades), only 4 paintSlideCard draws (not 20!)
  ctx.gifSlideFrame = 'card';
  stats.cardDraws = 0;
  const cardObj = await ctx.gifSlideshowFrames();
  assert.equal(cardObj.localPalettes, true, 'card mode must set localPalettes=true');
  assert.equal(cardObj.frames.length, 12, '4 shots must produce 12 frames (4 hold + 8 fade)');
  for (let i = 0; i < cardObj.frames.length; i++) {
    const f = await cardObj.frames[i].make();
    assert.equal(f.width, cardObj.width);
    assert.equal(f.height, cardObj.height);
  }
  assert.equal(stats.cardDraws, 4, 'card mode must render each shot once (4 draws), got ' + stats.cardDraws);

  // Design mode: 4 shots -> 12 frames, composeCanvas called 1 initial + 4 cached renders = 5 (not 21!)
  ctx.gifSlideFrame = 'design';
  stats.composeCalls = 0;
  const designObj = await ctx.gifSlideshowFrames();
  assert.equal(designObj.localPalettes, true, 'design mode must set localPalettes=true');
  assert(designObj.width <= 960 && designObj.height <= 960, 'design mode capped at 960px');
  for (let i = 0; i < designObj.frames.length; i++) {
    await designObj.frames[i].make();
  }
  assert.equal(stats.composeCalls, 5, 'design mode must compose 1 initial + 4 cached shots = 5, got ' + stats.composeCalls);

  // Layout mode: 4 shots -> 4 frames, localPalettes=true
  ctx.gifSlideFrame = 'layout';
  stats.composeCalls = 0;
  const layoutObj = await ctx.gifSlideshowFrames();
  assert.equal(layoutObj.localPalettes, true, 'layout mode must set localPalettes=true');
  assert.equal(layoutObj.frames.length, 4, 'layout mode should drop 4 shots one by one');
  for (let i = 0; i < layoutObj.frames.length; i++) {
    await layoutObj.frames[i].make();
  }
  assert.equal(stats.composeCalls, 5, 'layout mode composes 1 initial + 4 steps = 5');
  console.log('PASS: gifSlideshowFrames caches slides (4 renders vs 20) and enables localPalettes across card/design/layout');
}

// Helper to verify GIF89a structure and count frames with Local Color Tables
function inspectGifBytes(buf) {
  assert.equal(buf.subarray(0, 6).toString('ascii'), 'GIF89a', 'Header must be GIF89a');
  assert.equal(buf[buf.length - 1], 0x3b, 'Trailer must be 0x3b');
  // Count Image Descriptors (0x2C) and check Local Color Table flag (bit 7 of packed field)
  // Note: simple structural walk from byte 13 + GCT
  let pos = 6;
  const lsdPacked = buf[10];
  assert((lsdPacked & 0x80) !== 0, 'Frame 0 must have Global Color Table');
  const gctCount = 1 << ((lsdPacked & 7) + 1);
  pos = 13 + gctCount * 3;
  let frameCount = 0, lctCount = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    if (b === 0x3b) break;
    if (b === 0x21) { // extension
      pos++; // label
      while (pos < buf.length) {
        const len = buf[pos++];
        if (len === 0) break;
        pos += len;
      }
    } else if (b === 0x2c) { // image descriptor
      frameCount++;
      const packed = buf[pos + 8];
      pos += 9;
      if (packed & 0x80) {
        lctCount++;
        pos += (1 << ((packed & 7) + 1)) * 3;
      }
      pos++; // LZW min code size
      while (pos < buf.length) {
        const len = buf[pos++];
        if (len === 0) break;
        pos += len;
      }
    } else {
      throw new Error('Unexpected GIF block byte 0x' + b.toString(16) + ' at ' + (pos - 1));
    }
  }
  return { frameCount, lctCount };
}

// 4. Verify Worker encoding (localPalettes=true vs false), fallback, and cancellation
{
  const makeTestFrames = (localPalettes, count) => {
    const frames = [];
    for (let i = 0; i < count; i++) {
      const c = new (ctx.HTMLCanvasElement)(240, 300);
      c._seed = i + 1;
      frames.push({ time: i * 500, make: async () => c });
    }
    return { frames, width: 240, height: 300, durationMs: count * 500, speed: 1, localPalettes };
  };

  // Worker localPalettes=true (with varying palette sizes across frames)
  const localFrames = makeTestFrames(true, 4);
  const t0 = performance.now();
  const localBlob = await ctx.encodeGif(localFrames);
  const localMs = Math.round(performance.now() - t0);
  const localBuf = Buffer.from(await localBlob.arrayBuffer());
  const localInfo = inspectGifBytes(localBuf);
  assert.equal(localInfo.frameCount, 4, 'Local GIF must contain 4 frames');
  assert.equal(localInfo.lctCount, 3, 'Frames 1..3 must carry their own Local Color Tables');
  assert.equal(ctx.getWorkerStats().workerInstances, 1, 'Should reuse singleton Web Worker');

  // Worker localPalettes=false (global palette)
  const globalFrames = makeTestFrames(false, 4);
  const globalBlob = await ctx.encodeGif(globalFrames);
  const globalBuf = Buffer.from(await globalBlob.arrayBuffer());
  const globalInfo = inspectGifBytes(globalBuf);
  assert.equal(globalInfo.frameCount, 4, 'Global GIF must contain 4 frames');
  assert.equal(globalInfo.lctCount, 0, 'Global palette GIF must not emit Local Color Tables');
  assert.equal(ctx.getWorkerStats().workerInstances, 1, 'Singleton Worker must be reused across jobs');

  // Fallback path (_noWorker: true)
  const fbBlob = await ctx.encodeGif(makeTestFrames(true, 3), { _noWorker: true });
  const fbInfo = inspectGifBytes(Buffer.from(await fbBlob.arrayBuffer()));
  assert.equal(fbInfo.frameCount, 3);
  assert.equal(fbInfo.lctCount, 2);

  // Mid-job cancellation aborts Worker cleanly and returns null
  ctx.resetAbortFlag();
  let calls = 0;
  const cancelled = await ctx.encodeGif(makeTestFrames(true, 5), {
    isCancelled() { return ++calls >= 3; }
  });
  assert.equal(cancelled, null, 'Cancelled encodeGif must return null');
  assert.equal(ctx.getWorkerStats().lastWorkerAbort, true, 'Cancelled encodeGif must post abort to Worker');

  console.log('PASS: Worker encoding (local & global palettes), main-thread fallback, and cancellation verified (' + localMs + ' ms)');

  // 5. Realistic 12-frame 760x648 slideshow throughput & size check
  const hdFrames = [];
  for (let i = 0; i < 12; i++) {
    const c = new (ctx.HTMLCanvasElement)(760, 648);
    c._seed = (i % 4) + 1;
    hdFrames.push({ time: i < 4 ? i * 500 : i * 70, make: async () => c });
  }
  const tHd0 = performance.now();
  const hdBlob = await ctx.encodeGif({ frames: hdFrames, width: 760, height: 648, durationMs: 5800, speed: 1, localPalettes: true });
  const hdMs = Math.round(performance.now() - tHd0);
  const hdBuf = Buffer.from(await hdBlob.arrayBuffer());
  const hdInfo = inspectGifBytes(hdBuf);
  assert.equal(hdInfo.frameCount, 12, '12-frame HD slideshow must encode all 12 frames');
  assert.equal(hdInfo.lctCount, 11, 'Frames 1..11 must carry Local Color Tables');
  assert(hdMs < 5000, '12-frame 760x648 encoding must stay fast, got ' + hdMs + ' ms');
  console.log('PASS: 12-frame 760x648 slideshow encoded in ' + hdMs + ' ms (' + Math.round(hdBuf.length / 1024) + ' KB)');
}
