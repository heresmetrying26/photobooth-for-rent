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

// A client's Xiaomi Pad 5 over Wi-Fi printed an L8050 with banding lines and a white border (plain paper, standard quality, Borderless
// off) while the Epson app printed the same photo sharp and borderless: the High / photo-paper settings were USB-only on Android.
test('L8050 on Wi-Fi (Android): High quality + photo paper sent, Borderless turned on when it is picked', () => {
  const html = assemble().html;
  const m = html.match(/function epsonLUsbIpp\(p\) \{[^\n]*\}/);
  assert.ok(m, 'epsonLUsbIpp found in the booth page');
  const known = new Function('EPSON_L_PIDS', m[0] + '; return epsonLUsbIpp;')({ 2150: 'L8050', 58993: 'L3210', 17498: 'L3276' });
  assert.equal(known({ ipp: true, usb: false, name: 'EPSON L8050 Series' }), true, 'Wi-Fi L8050');
  assert.equal(known({ ipp: true, usb: true, vid: 1208, pid: 2150, name: 'Epson L8050 (USB)' }), true, 'USB L8050');
  assert.equal(known({ ipp: true, usb: false, name: 'EPSON L18050 Series' }), false, 'L18050 is another printer');
  assert.equal(known({ ipp: true, usb: false, name: 'EPSON L3210 Series' }), false, 'L3210 is left alone');
  assert.equal(known({ ipp: false, usb: false, name: 'EPSON L8050 Series' }), false, 'no IPP, not this path');
  assert.ok(/if \(p && \(p\.borderless \|\| \(printerBorderlessKnown\(p\) && \(epsonLUsbIpp\(p\)[^\n]*\{ printPrefs\.borderless = true/.test(html), 'picking it turns Borderless on');
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
  assert.ok(/val hardEpsonL = [^\n]*\n[^\n]*e\.usbDev == null && Regex\("\(\?i\)\(\?:\^\|\[\^A-Za-z0-9\]\)L8050\(\?!\[0-9\]\)"\)\.containsMatchIn\(e\.model \+ " " \+ e\.name\)/.test(kt), 'Android sends the settings for a Wi-Fi L8050');
});

// Any printer that can print borderless defaults to Borderless + glossy photo paper + the best quality it lists (USB and Wi-Fi), unless
// the operator chose otherwise. The booth page's own functions are run here with stand-ins for the page's globals.
test('borderless-capable printers: defaults for Borderless, photo paper and quality; what is left out; operator choices win', () => {
  const html = assemble().html;
  const a = html.indexOf('const WIFI_OPTS_KEY'), b = html.indexOf('function wifiOpts(printer) {');
  assert.ok(a > 0 && b > a, 'printer options block found');
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const f = new Function('localStorage', 'IOS_APP', 'printSize', 'paperFor', 'printerKey',
    html.slice(a, b) + '; return { printerBorderlessKnown, wifiDefaultFor, wifiOptEff, wifiOptsSet, photoSheetSize };');
  const sizes = { s4x6: { w: 101.6, h: 152.4 }, a4: { w: 210, h: 297 }, xl: { w: 300, h: 900 } };
  let size = 's4x6';
  const api = f(store, false, 'x', () => sizes[size], () => 'k');
  const L8050 = { ipp: true, usb: false, name: 'EPSON L8050 Series', qualities: [], mediaTypes: [] };
  const generic = { ipp: true, usb: false, name: 'Brother DCP-T520W', bcap: true, qualities: [3, 4, 5], mediaTypes: ['stationery', 'photographic-glossy', 'photographic-matte'] };
  // Known as able to print borderless
  assert.equal(api.printerBorderlessKnown(L8050), true, 'L8050');
  assert.equal(api.printerBorderlessKnown(generic), true, 'IPP printer that lists a margin of 0');
  assert.equal(api.printerBorderlessKnown({ usb: true, epsonL: true, borderless: true, escpr: true, name: 'Epson L3210 (USB)' }), true, 'Epson built-in USB mode');
  assert.equal(api.printerBorderlessKnown({ ipp: true, name: 'EPSON L3210 Series' }), true, 'L3210 over IPP');
  assert.equal(api.printerBorderlessKnown({ escpr: true, raw: false, name: 'EPSON L805 Series' }), true, 'L805 over ESC/P-R');
  // Not known / left out on purpose
  assert.equal(api.printerBorderlessKnown(Object.assign({}, generic, { bcap: false })), false, 'IPP printer that does not say so');
  assert.equal(api.printerBorderlessKnown({ usb: true, canon: true, name: 'Canon PIXMA G1010 (USB)' }), false, 'Canon G-series over USB');
  assert.equal(api.printerBorderlessKnown({ usb: true, escp2: true, name: 'Epson L120 (USB)' }), false, 'L1xx');
  assert.equal(api.printerBorderlessKnown({ ipp: true, bcap: true, name: 'Canon SELPHY CP1500' }), false, 'SELPHY');
  assert.equal(api.printerBorderlessKnown({ raw: true, ipp: false, name: 'Xprinter XP-T80Q' }), false, 'receipt printer');
  assert.equal(api.printerBorderlessKnown({ dialog: true, name: 'Android print dialog', ipp: true, bcap: true }), false, 'print dialog');
  // Defaults: only what the printer lists is asked for
  assert.equal(api.wifiOptEff(L8050, 'quality'), 'high'); assert.equal(api.wifiOptEff(L8050, 'media'), 'photo');
  assert.equal(api.wifiOptEff(generic, 'quality'), 'high'); assert.equal(api.wifiOptEff(generic, 'media'), 'photo');
  const noHigh = Object.assign({}, generic, { name: 'HP DeskJet 4155e', qualities: [3, 4] });
  assert.equal(api.wifiOptEff(noHigh, 'quality'), '', 'no High listed: not asked for');
  assert.equal(api.wifiOptEff(noHigh, 'media'), 'photo');
  assert.equal(api.wifiOptEff(Object.assign({}, generic, { mediaTypes: ['stationery'] }), 'media'), '', 'no photo paper listed: not asked for');
  assert.equal(api.wifiOptEff({ usb: true, epsonL: true, borderless: true, escpr: true, name: 'Epson L3210 (USB)' }, 'media'), 'photo', 'built-in USB mode: photo paper');
  assert.equal(api.wifiOptEff({ ipp: true, name: 'Some Office Printer', qualities: [3, 4, 5], mediaTypes: ['photographic-glossy'] }, 'quality'), '', 'not known as borderless: printer default');
  // The operator's choice wins; "Printer default" chosen on purpose stays
  api.wifiOptsSet(generic, 'quality', 'normal');
  assert.equal(api.wifiOptEff(generic, 'quality'), 'normal', 'chosen quality');
  assert.equal(api.wifiOptEff(generic, 'media'), 'photo', 'paper not touched: still the default');
  api.wifiOptsSet(generic, 'media', '');
  assert.equal(api.wifiOptEff(generic, 'media'), '', 'Printer default chosen on purpose');
  api.wifiOptsSet(L8050, 'quality', 'draft');
  assert.equal(api.wifiOptEff(L8050, 'quality'), 'draft'); assert.equal(api.wifiOptEff(L8050, 'media'), 'photo');
  // Switching Borderless on for an office printer only for photo sizes
  assert.equal(api.photoSheetSize(), true, '4x6'); size = 'a4'; assert.equal(api.photoSheetSize(), false, 'A4 is not a photo size'); size = 'xl'; assert.equal(api.photoSheetSize(), false, 'XL sheet');
  assert.ok(/borderless: !!p\.borderless, bcap: !!p\.bcap, info/.test(html), 'saved printer keeps bcap');
  assert.ok(/printerBorderlessKnown\(p\) && \(epsonLUsbIpp\(p\) \|\| epsonLBorderlessModel\(p\) \|\| epsonEscprBorderlessModel\(p\) \|\| photoSheetSize\(\)\)/.test(html), 'wifiSave turns Borderless on');
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
  assert.ok(/"media-bottom-margin-supported"/.test(kt) && /name\.endsWith\("-margin-supported"\)/.test(kt) && /\.put\("bcap", it\.borderlessCap\)/.test(kt) && /\.put\("bcap", ippEntry\?\.borderlessCap \?: false\)/.test(kt), 'Android asks for the margins and reports bcap (Wi-Fi and USB lists)');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
