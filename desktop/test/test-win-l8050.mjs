// Tests for the Epson L8050 4x6 borderless compensation in the Windows print script (desktop/lib/helper.mjs).
// Run: node desktop/test/test-win-l8050.mjs      (no printer needed)
//
// What this proves: the numbers in the script are the ones Epson's own Windows driver writes for a 4 x 6 in borderless job, and that
// a picture drawn the way the script draws it lands on the sheet edge to edge (0.5 mm of bleed) once the driver has enlarged the page the way
// it was measured to. The measured part (the driver's job and the enlargement) was done once with tools/epson-l8050; the script itself
// was also run into the driver's file-port queue and its lines landed where this model says (see tools/epson-l8050/README.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN_EPSON_L8050_4X6 as G } from '../lib/helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'lib', 'helper.mjs'), 'utf8');
const a = src.indexOf('const WIN_PRINT_PS = String.raw`');
const ps = src.slice(src.indexOf('`', a) + 1, src.indexOf('`;', a));
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS:', name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } };

// setj of a 4x6 borderless job from the L8050 driver (720 dpi): sheet, margins (top, left), area
const SETJ = '00 00 0b 40 00 00 10 e0 ff ea ff b4 00 00 0b d8 00 00 11 30 01 00';
const b = Buffer.from(SETJ.replace(/ /g, ''), 'hex');
const J = { sheetW: b.readUInt32BE(0), sheetH: b.readUInt32BE(4), top: b.readInt16BE(8), left: b.readInt16BE(10), areaW: b.readUInt32BE(12), areaH: b.readUInt32BE(16) };

test('constants are the ones in the driver job', () => {
  assert.equal(G.sheetW, J.sheetW); assert.equal(G.sheetH, J.sheetH);
  assert.equal(G.areaW, J.areaW); assert.equal(G.areaH, J.areaH);
  assert.equal(G.areaLeft, -J.left); assert.equal(G.areaTop, -J.top);
});

// the numbers written into the PowerShell
const encl = (() => { const m = /\$encl = (\d+) \/ (\d+)/.exec(ps); assert.ok(m, '$encl line'); return { n: +m[1], d: +m[2] }; })();
const dycPx = (() => { const m = /\$dyc = \((\d+) \/ (\d+) \* 25\.4\) \* \$um/.exec(ps); assert.ok(m, '$dyc line'); assert.equal(+m[2], 720); return +m[1]; })();
const bleedMm = (() => { const m = /\$bl = ([\d.]+) \* \$um/.exec(ps); assert.ok(m, '$bl line'); return +m[1]; })();

test('the script uses the driver numbers: enlargement, middle of the area, bleed', () => {
  assert.equal(encl.n, G.areaW); assert.equal(encl.d, G.sheetW);                       // the page is enlarged areaW / sheetW
  assert.equal(dycPx, G.areaH / 2 - G.areaTop - G.sheetH / 2);                         // the area's middle is 18 px below the sheet's middle
  assert.equal(bleedMm, G.bleedMm);
  assert.ok(/-match '\(\?<!\[a-z0-9\]\)L\[\\s_-\]\?8050\(\?!\[0-9\]\)'/.test(ps), 'L8050 name match');
  assert.ok(/if \(\$l8050 -and \$aw -le 0 -and \[Math\]::Abs\(\$shortU - 400\) -le 3 -and \[Math\]::Abs\(\$longU - 600\) -le 3/.test(ps), '4x6 only, no size given');
});

test('L3210 and other printers keep the old branch', () => {
  assert.ok(/elseif \(\$aw -le 0 -and \[Math\]::Abs\(\(\$page\.Width \/ \$page\.Height\)/.test(ps));
  assert.ok(/\$edgeScale = \$EpsonScale/.test(ps));
  const re = /(?<![a-z0-9])L[\s_-]?8050(?![0-9])/i;
  for (const n of ['EPSON L8050 Series', 'Epson L8050', 'L8050']) assert.ok(re.test(n), n);
  for (const n of ['EPSON L805 Series', 'EPSON L18050 Series', 'EPSON L3210 Series', 'EPSON L80500']) assert.ok(!re.test(n), n);
});

// What the script draws (page units 1/100 in, W x H sheet) and what the driver does with it.
function drawn(W, H, landscape) {
  const um = Math.min(W, H) / 101.6, dyc = (dycPx / 720 * 25.4) * um, e = encl.n / encl.d;
  const bl = (landscape ? landscapeBleedMm : bleedMm) * um;
  const bw = (W + 2 * bl) / e, bh = (H + 2 * bl) / e;
  const cx = W / 2, cy = landscape ? H / 2 : H / 2 - dyc / e;
  return { x0: cx - bw / 2, x1: cx + bw / 2, y0: cy - bh / 2, y1: cy + bh / 2, um, bl, dyc, e };
}
// The driver: page enlarged e about the middle of the area; the area's middle is dyc below the sheet's middle (along the long side).
// `sign` is which way a Landscape page is turned (unknown), so both are tried.
const onSheet = (d, W, H, landscape, sign = 1) => {
  const m = (v, len, off) => (v - len / 2) * d.e + len / 2 + off;
  return landscape
    ? { x0: m(d.x0, W, sign * d.dyc), x1: m(d.x1, W, sign * d.dyc), y0: m(d.y0, H, 0), y1: m(d.y1, H, 0) }
    : { x0: m(d.x0, W, 0), x1: m(d.x1, W, 0), y0: m(d.y0, H, d.dyc), y1: m(d.y1, H, d.dyc) };
};
const landscapeBleedMm = (() => { const m = /if \(\$pageLandscape\) \{ \$bl = ([\d.]+) \* \$um/.exec(ps); assert.ok(m, 'landscape bleed line'); return +m[1]; })();

test('portrait 4x6: the picture ends 0.5 mm past every edge of the sheet', () => {
  const d = drawn(400, 600, false), s = onSheet(d, 400, 600, false), mm = (u) => u / d.um;
  assert.ok(Math.abs(mm(-s.x0) - 0.5) < 0.02 && Math.abs(mm(s.x1 - 400) - 0.5) < 0.02, 'across: ' + mm(-s.x0) + ' / ' + mm(s.x1 - 400));
  assert.ok(Math.abs(mm(-s.y0) - 0.5) < 0.02 && Math.abs(mm(s.y1 - 600) - 0.5) < 0.02, 'along: ' + mm(-s.y0) + ' / ' + mm(s.y1 - 600));
});

test('landscape 4x6 (either way the driver turns it): never white, at most 1.4 mm trimmed', () => {
  for (const sign of [1, -1]) {
    const d = drawn(600, 400, true), s = onSheet(d, 600, 400, true, sign), mm = (u) => u / d.um;
    for (const v of [-s.x0, s.x1 - 600, -s.y0, s.y1 - 400]) assert.ok(mm(v) > 0 && mm(v) < 1.4, 'sign ' + sign + ' past the edge by ' + mm(v) + ' mm');
  }
});

test('a 4x6 picture at the old 100% would have lost the edges listed in the notes', () => {
  // Old: the page drawn 400 x 600 at 0,0. The sheet shows the page from v where (v - mid) * e + mid + off = 0 (or = the sheet's length);
  // what is outside that is lost. In mm of the page: left/right 2.55, top 3.2, bottom 4.4.
  const e = encl.n / encl.d, um = 400 / 101.6, dyc = (dycPx / 720 * 25.4) * um;
  const left = (200 - 200 / e) / um, top = (300 - (300 + dyc) / e) / um, bottom = (300 - (300 - dyc) / e) / um;
  assert.ok(Math.abs(left - 2.55) < 0.05, 'left ' + left);
  assert.ok(Math.abs(top - 3.2) < 0.05, 'top ' + top);
  assert.ok(Math.abs(bottom - 4.4) < 0.05, 'bottom ' + bottom);
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
