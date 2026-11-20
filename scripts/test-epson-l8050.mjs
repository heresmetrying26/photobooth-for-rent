// Behaviour tests for the Epson L8050 4R borderless page (protected/src/printer/epson-l8050.js).
// Run: node scripts/test-epson-l8050.mjs      (no printer or browser needed)
//
// What this proves: the page is built from the numbers Epson's own Windows driver sends for a 4 x 6 in borderless job, and a printer
// that starts a 1:1 page at the corner of that print area puts the picture on the sheet edge to edge (within half a pixel).
// What it CANNOT prove: that the L8050's own IPP path really starts the page at that corner (it needs one real print).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'protected', 'src', 'printer', 'epson-l8050.js'), 'utf8');
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } };

// A canvas that really holds pixels (nearest-neighbour drawImage), so the page can be inspected.
function mkCanvas(w = 0, h = 0) {
  const cv = { width: w, height: h, px: null };
  const ensure = () => { if (!cv.px || cv.px.length !== cv.width * cv.height) cv.px = new Uint32Array(cv.width * cv.height).fill(0x00000000); };
  cv.getContext = () => ({
    fillStyle: '#000000', imageSmoothingEnabled: true,
    fillRect(x, y, ww, hh) { ensure(); const c = this.fillStyle === '#ffffff' ? 0xffffffff : 0xff000000; for (let j = y; j < y + hh; j++) for (let i = x; i < x + ww; i++) cv.px[j * cv.width + i] = c; },
    drawImage(s, ...a) {
      ensure();
      let sx = 0, sy = 0, sw = s.width, sh = s.height, dx, dy, dw, dh;
      if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
      else if (a.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
      else throw new Error('unexpected drawImage call with ' + a.length + ' arguments');
      for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) {
        const X = dx + i, Y = dy + j; if (X < 0 || Y < 0 || X >= cv.width || Y >= cv.height) continue;
        const u = sx + Math.min(sw - 1, Math.floor(i * sw / dw)), v = sy + Math.min(sh - 1, Math.floor(j * sh / dh));
        cv.px[Y * cv.width + X] = s.px[v * s.width + u];
      }
    }
  });
  return cv;
}
const load = () => { const g = {}; vm.runInNewContext(src, { window: g, globalThis: g, document: { createElement: () => mkCanvas() } }); return g._epsonL8050; };
const L = load();

// ---- the numbers the Windows driver wrote (setj of a 4x6 borderless job, captured through a file-port queue with the L8050 driver)
const SETJ_BORDERLESS = '00 00 0b 40 00 00 10 e0 ff ea ff b4 00 00 0b d8 00 00 11 30 01 00';
function readSetj(hex) {
  const b = Buffer.from(hex.replace(/ /g, ''), 'hex');
  return { sheetW: b.readUInt32BE(0), sheetH: b.readUInt32BE(4), top: b.readInt16BE(8), left: b.readInt16BE(10), areaW: b.readUInt32BE(12), areaH: b.readUInt32BE(16) };
}

test('constants are the ones in the driver job', () => {
  const j = readSetj(SETJ_BORDERLESS);
  assert.equal(L.GEO.sheetW, j.sheetW); assert.equal(L.GEO.sheetH, j.sheetH);
  assert.equal(L.GEO.left, -j.left); assert.equal(L.GEO.top, -j.top);
  assert.equal(L.GEO.left + L.GEO.sheetW + L.GEO.right, j.areaW);
  assert.equal(L.GEO.top + L.GEO.sheetH + L.GEO.bottom, j.areaH);
});

test('page size and offsets at 300 dpi', () => {
  const g = L.layout(1200, 1800);
  assert.deepEqual({ w: g.pageW, h: g.pageH, l: g.left, t: g.top }, { w: 1264, h: 1833, l: 32, t: 9 });
});

for (const [w, h] of [[1200, 1800], [2400, 3600], [600, 900]]) {
  test('sheet lands on the sheet within half a pixel (' + w + 'x' + h + ')', () => {
    const g = L.layout(w, h), s = w / L.GEO.sheetW;
    // The printer puts the page's top-left corner at (-76, -22) of the sheet (in 1/720 in); the picture is g.left / g.top in.
    const sheetX = -L.GEO.left * s + g.left, sheetY = -L.GEO.top * s + g.top;
    assert.ok(Math.abs(sheetX) <= 0.5 && Math.abs(sheetY) <= 0.5, 'picture starts at ' + sheetX + ', ' + sheetY + ' px from the sheet corner');
    // and the page reaches at least as far past the sheet as the print area does, on every side (so no white can show)
    assert.ok(g.pageW - g.left - w >= Math.round(L.GEO.right * s) && g.pageH - g.top - h >= Math.round(L.GEO.bottom * s));
  });
}

test('not a 4x6 portrait canvas: left alone', () => {
  assert.equal(L.layout(1800, 1200), null);          // landscape
  assert.equal(L.layout(1500, 2100), null);          // 5x7
  assert.equal(L.layout(0, 0), null);
  const cv = mkCanvas(1800, 1200); assert.equal(L.bleedPage(cv, () => mkCanvas()), cv);
});

test('applies only to an L8050, borderless, 4x6', () => {
  const cv = { width: 1200, height: 1800 }, p4 = { w: 101.6, h: 152.4 }, bl = { borderless: true };
  assert.ok(L.applies({ usb: true, vid: 1208, pid: 2150, name: 'USB printer' }, p4, bl, cv));
  assert.ok(L.applies({ name: 'Epson L8050 (USB)' }, p4, bl, cv));
  assert.ok(L.applies({ name: 'EPSON L8050 Series' }, p4, bl, cv));
  assert.ok(!L.applies({ name: 'Epson L8050 (USB)' }, p4, { borderless: false }, cv), 'borderless off');
  assert.ok(!L.applies({ name: 'Epson L8050 (USB)' }, { w: 127, h: 177.8 }, bl, cv), '5x7');
  assert.ok(!L.applies({ name: 'Epson L8050 (USB)' }, p4, bl, { width: 1800, height: 1200 }), 'landscape page');
  for (const n of ['Epson L805', 'Epson L3210', 'EPSON L18050 Series', 'Epson L80500', 'Canon G1010', '']) assert.ok(!L.applies({ name: n }, p4, bl, cv), n);
  assert.ok(!L.applies(null, p4, bl, cv));
});

test('bleedPage: picture 1:1 in place, strips and corners from its own edge pixels', () => {
  const w = 1200, h = 1800, cv = mkCanvas(w, h), RED = 0xff0000ff, GRN = 0xff00ff00, BLU = 0xffff0000, YEL = 0xff00ffff, GRY = 0xff808080;
  cv.px = new Uint32Array(w * h).fill(GRY);
  for (let x = 0; x < w; x++) { cv.px[x] = RED; cv.px[(h - 1) * w + x] = GRN; }             // top row red, bottom row green
  for (let y = 1; y < h - 1; y++) { cv.px[y * w] = BLU; cv.px[y * w + w - 1] = YEL; }       // left column blue, right column yellow
  const page = L.bleedPage(cv, () => mkCanvas()), g = L.layout(w, h), at = (x, y) => page.px[y * page.width + x];
  assert.equal(page.width, g.pageW); assert.equal(page.height, g.pageH);
  assert.equal(at(g.left, g.top + 5), BLU);                          // picture's left column is where the sheet's left edge is
  assert.equal(at(g.left + w - 1, g.top + 5), YEL);
  assert.equal(at(g.left + 5, g.top), RED);
  assert.equal(at(g.left + 5, g.top + h - 1), GRN);
  assert.equal(at(g.left + 600, g.top + 900), GRY);                  // inside: untouched
  assert.equal(at(g.left - 10, g.top + 500), BLU);                   // left strip
  assert.equal(at(g.left + w + 10, g.top + 500), YEL);               // right strip
  assert.equal(at(g.left + 300, g.top - 4), RED);                    // top strip
  assert.equal(at(g.left + 300, g.top + h + 10), GRN);               // bottom strip
  assert.equal(at(0, 0), RED);                                       // corner = the picture's corner pixel
  assert.equal(at(page.width - 1, page.height - 1), GRN);
  for (let i = 0; i < page.px.length; i += 997) assert.notEqual(page.px[i], 0, 'a pixel on the page was never drawn');
});

test('booth page: the part is included and the Wi-Fi/USB photo job uses it', () => {
  const html = assemble().html;
  assert.ok(html.includes('G._epsonL8050 = {'), 'part file pasted into the page');
  assert.ok(/window\._epsonL8050\.applies\(p, paper, wo, cv\) \? window\._epsonL8050\.bleedPage\(cv\)/.test(html), 'ippRun hook');
  assert.ok(/!IOS_APP && window\._epsonL8050/.test(html), 'iPad app left alone');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
