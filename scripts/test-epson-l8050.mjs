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
  assert.equal(known({ ipp: true, usb: false, name: 'EPSON_L8050_Series' }), true, 'underscore mDNS/USB L8050');
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

test('L8050 USB/Wi-Fi ESC/P-R: L3210 720/1440dpi beta raster blocked, stale rnormal cleared, streaming 360/720dpi + setm + IPP 600dpi wired', () => {
  const html = assemble().html;
  const a = html.indexOf('const WIFI_OPTS_KEY'), b = html.indexOf('function wifiOpts(printer) {');
  assert.ok(a > 0 && b > a, 'printer options block found');
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const f = new Function('localStorage', 'IOS_APP', 'printSize', 'paperFor', 'printerKey',
    html.slice(a, b) + '; return { isEpsonL8050, epsonRasterBetaAllowed, wifiDefaultFor, wifiOptEff, wifiOptsSet };');
  const api = f(store, false, 's4x6', () => ({ w: 101.6, h: 152.4 }), () => 'k');

  const l8050Usb = { usb: true, epsonL: true, borderless: true, escpr: true, epsonModel: 'L8050', vid: 1208, pid: 2150, name: 'Epson L8050 (USB)' };
  const l8050Net = { usb: false, ipp: false, escpr: true, name: 'EPSON L8050 Series' };
  const l3210Usb = { usb: true, epsonL: true, borderless: true, escpr: true, epsonModel: 'L3210', vid: 1208, pid: 58993, name: 'Epson L3210 (USB)' };
  const l18050Usb = { usb: true, epsonL: true, borderless: true, escpr: true, name: 'Epson L18050 (USB)' };

  // L8050 detection + L3210 beta raster block
  assert.equal(api.isEpsonL8050(l8050Usb), true, 'USB L8050 recognized');
  assert.equal(api.isEpsonL8050(l8050Net), true, 'Wi-Fi L8050 recognized');
  assert.equal(api.isEpsonL8050(l3210Usb), false, 'L3210 not L8050');
  assert.equal(api.isEpsonL8050(l18050Usb), false, 'L18050 not L8050');
  assert.equal(api.epsonRasterBetaAllowed(l8050Usb), false, 'L3210 beta raster blocked on L8050');
  assert.equal(api.epsonRasterBetaAllowed(l18050Usb), false, 'L3210 beta raster blocked on L18050');
  assert.equal(api.epsonRasterBetaAllowed(l3210Usb), true, 'L3210 still allowed for beta raster');

  // L8050 ESC/P-R defaults to High + glossy photo paper, and stale rnormal/rbest are neutralized
  assert.equal(api.wifiOptEff(l8050Usb, 'quality'), 'high', 'L8050 USB ESC/P-R defaults to high');
  assert.equal(api.wifiOptEff(l8050Usb, 'media'), 'photo', 'L8050 USB ESC/P-R defaults to photo');
  assert.equal(api.wifiOptEff(l8050Net, 'quality'), 'high', 'L8050 Wi-Fi ESC/P-R defaults to high');
  assert.equal(api.wifiOptEff(l8050Net, 'media'), 'photo', 'L8050 Wi-Fi ESC/P-R defaults to photo');
  api.wifiOptsSet(l8050Usb, 'quality', 'rnormal');
  assert.equal(api.wifiOptEff(l8050Usb, 'quality'), 'high', 'stale rnormal on L8050 falls back to high');
  api.wifiOptsSet(l8050Usb, 'quality', 'rbest');
  assert.equal(api.wifiOptEff(l8050Usb, 'quality'), 'high', 'stale rbest on L8050 falls back to high');
  api.wifiOptsSet(l8050Usb, 'quality', 'high720');
  assert.equal(api.wifiOptEff(l8050Usb, 'quality'), 'high720', 'explicit high720 choice kept for L8050');
  api.wifiOptsSet(l8050Usb, 'quality', 'normal');
  assert.equal(api.wifiOptEff(l8050Usb, 'quality'), 'normal', 'explicit normal choice respected');

  // Dispatch, DPI selection, and UI guards present in booth.html
  assert.ok(/if \(epsonRasterBetaAllowed\(p\) && \/\^r\(normal\|best\)\$\/\.test\(wo\.quality \|\| ''\)\)/.test(html), 'printViaWifiRaw guards printEpsonRaster with epsonRasterBetaAllowed');
  assert.ok(/if \(!epsonRasterBetaAllowed\(p\)\) \{\s*throw new Error\('L3210 beta 720\/1440 dpi raster is not compatible with the 6-ink Epson L8050/.test(html), 'printEpsonRaster refuses L8050 directly');
  assert.ok(/else if \(\(p\.epsonL \|\| p\.escpr\) && isEpsonL8050\(p\)\)/.test(html), 'L8050 ESC/P-R gets dedicated quality dropdown without L3210 beta');
  assert.ok(/function l8050HiResAvailable\(\)/.test(html) && /supportsL8050HiRes/.test(html), 'hi-res L8050 canvas & high720 gated by supportsL8050HiRes() for APK compatibility');
  assert.ok(/function l8050DpiFor\(paper\)/.test(html) && /canonDpiFor\(paper\) \|\| l8050DpiFor\(paper\) \|\| PRINT_DPI/.test(html), 'buildPrintCanvas uses l8050DpiFor');
  assert.ok(/\['high720', 'High 720 dpi \(L8050 4\\u00d76\)'\]/.test(html), 'opt-in High 720 dpi (L8050 4x6) choice wired in UI');
  assert.ok(/pageDpi && pageDpi !== 300 \? \{ dpi: pageDpi \}/.test(html), 'ippRun forwards pageDpi to printIpp');
  assert.ok(/if \(wo && wo\.quality === 'high720' && isEpsonL8050\(p\) && is4x6\)/.test(html), 'Wi-Fi L8050 high720 streams via port 9100 ESC/P-R on 4x6 only');

  // Verify wifiPackPages deduplicates identical copies and scales timeout
  const pkIdx = html.indexOf('function wifiPackPages('), wpIdx = html.indexOf('async function wifiPhotoJob(');
  assert.ok(pkIdx > 0 && wpIdx > pkIdx, 'wifiPackPages found');
  const wifiPackPages = new Function(html.slice(pkIdx, wpIdx) + '; return wifiPackPages;')();
  const c1 = { id: 1 }, c2 = { id: 2 };
  let encCalls = 0;
  const pSame = wifiPackPages([c1, c1, c1, c1], (c) => { encCalls++; return 'pic' + c.id; });
  assert.deepEqual(pSame, { pics: ['pic1'], copies: 4, ms: 360000 }, '4 identical copies encoded once with copies=4 and 360s timeout');
  assert.equal(encCalls, 1, 'encoder called once for identical copies');
  const pDiff = wifiPackPages([c1, c2], (c) => 'pic' + c.id);
  assert.deepEqual(pDiff, { pics: ['pic1', 'pic2'], copies: 1, ms: 180000 }, '2 distinct pages kept separate with 180s timeout');

  // Verify l8050DpiFor behaviour in isolation (old APK vs new APK, IPP 600 vs ESC/P-R 720 vs 5x7 vs Hagaki 100x148)
  const hiIdx = html.indexOf('function l8050HiResAvailable()'), bcIdx = html.indexOf('function buildPrintCanvas(');
  assert.ok(hiIdx > 0 && bcIdx > hiIdx, 'l8050DpiFor block found');
  const mkDpiFn = (opts) => new Function('IOS_APP', 'window', 'wifiPrinter', 'wifiOpts', 'isEpsonL8050', 'epsonLNetPrinter',
    html.slice(hiIdx, bcIdx) + '; return { l8050HiResAvailable, l8050DpiFor };')(
    opts.ios, opts.win, opts.printer, () => opts.wo, api.isEpsonL8050, (p) => !!(p && p.ip && !p.usb && !p.dialog && /L8050/i.test(p.name || ''))
  );
  const p4x6 = { w: 101.6, h: 152.4 }, p5x7 = { w: 127, h: 177.8 }, pHagaki = { w: 100, h: 148 };
  const newApk = { __PBNet: { supportsL8050HiRes: () => true } };
  const oldApk = { __PBNet: {} };
  assert.equal(mkDpiFn({ ios: false, win: oldApk, printer: { ipp: true, ip: '192.168.1.5', name: 'EPSON L8050 Series' }, wo: { quality: 'high' } }).l8050DpiFor(p4x6), 0, 'old APK stays at 300 dpi (returns 0)');
  assert.equal(mkDpiFn({ ios: true, win: newApk, printer: { ipp: true, ip: '192.168.1.5', name: 'EPSON L8050 Series' }, wo: { quality: 'high' } }).l8050DpiFor(p4x6), 0, 'iOS stays untouched');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: { ipp: true, ip: '192.168.1.5', name: 'EPSON L8050 Series' }, wo: { quality: 'high' } }).l8050DpiFor(p4x6), 600, 'L8050 IPP High 4x6 gets 600 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: { ipp: true, ip: '192.168.1.5', name: 'EPSON L8050 Series' }, wo: { quality: 'normal' } }).l8050DpiFor(p4x6), 0, 'L8050 IPP Normal stays 300 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: { ipp: true, ip: '192.168.1.5', name: 'EPSON L8050 Series' }, wo: { quality: 'high720' } }).l8050DpiFor(p4x6), 720, 'L8050 Wi-Fi high720 4x6 gets 720 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: l8050Usb, wo: { quality: 'high720' } }).l8050DpiFor(p4x6), 720, 'L8050 USB ESC/P-R high720 4x6 gets 720 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: l8050Usb, wo: { quality: 'high' } }).l8050DpiFor(p4x6), 360, 'L8050 USB ESC/P-R default high renders at 1:1 native 360 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: { ip: '192.168.223.1', ipp: false, escpr: true, lpd: true, epsonModel: 'L8050', name: 'EPSON L8050 Series' }, wo: { quality: 'high' } }).l8050DpiFor(p4x6), 360, 'L8050 LPD :515 default high renders at 1:1 native 360 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: l8050Usb, wo: { quality: 'high720' } }).l8050DpiFor(p5x7), 0, '5x7 stays at 300 dpi');
  assert.equal(mkDpiFn({ ios: false, win: newApk, printer: l8050Usb, wo: { quality: 'high720' } }).l8050DpiFor(pHagaki), 0, 'Hagaki 100x148 stays at 300 dpi (matches 1.5mm tolerance)');

  // Android EscprJob.kt: seam-free strip streaming + pure dsnd RGB color plane (setq[6]=0x00, NEVER bsnd 0x03!)
  const escKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'EscprJob.kt'), 'utf8');
  assert.ok(/fun streamWithConfig\(/.test(escKt), 'EscprJob.streamWithConfig present');
  assert.ok(/private fun packBitsInto\(/.test(escKt), 'zero-allocation packBitsInto present');
  assert.ok(/val sendSetm: Boolean = false/.test(escKt), 'EscprJob.Config defaults sendSetm=false (pure dsnd mode)');
  assert.ok(/bytes\(media, quality, if \(cfg\.mono\) 1 else 0, 0, 0, 0, 0x00, 0x00, 0x00\)/.test(escKt), 'EscprJob always sets setq[6]=0x00 (EPS_CP_FULLCOLOR 24-bit RGB dsnd, never bsnd 0x03)');
  assert.ok(/bytes\(0x1B, 0x71, 0x0A, 0x00, 0x00, 0x00\), ascii\("seti"\), ByteArray\(10\)/.test(escKt) && /bytes\(0x1B, 0x75, 0x02, 0x00, 0x00, 0x00\), ascii\("chku"\), bytes\(0x01, 0x01\)/.test(escKt), 'EscprJob emits standard dsnd seti(0..0) + chku(01 01) borderless handshake');
  assert.ok(/if \(cfg\.sendSetm && is4x6\)/.test(escKt) && /bytes\(0x1B, 0x6D, 0x07, 0x00, 0x00, 0x00\), ascii\("setm"\)/.test(escKt), 'optional setm is gated to 4x6 only');

  // Android NetPrintBridge.kt: capability flag, streaming USB & TCP, high720, dynamic JFIF DPI
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
  assert.ok(/@JavascriptInterface\s+fun supportsL8050HiRes\(\): Boolean = true/.test(kt), 'supportsL8050HiRes JS bridge method exposed');
  assert.ok(/private fun usbRawStream\(/.test(kt) && /private fun netRawStream\(/.test(kt), 'streaming USB & TCP raw writers present');
  assert.ok(/private fun jpegAtDpi\(j: ByteArray, dpi: Int = 300\)/.test(kt) && /jpegAtDpi\(jpegIn, opts\.dpi\)/.test(kt), 'dynamic JFIF DPI writer wired in sendIppJob');
  assert.ok(/private fun l8050EscprConfig\(/.test(kt) && /qStr == "high720" && is4x6/.test(kt) && /sendSetm = false/.test(kt), 'l8050EscprConfig routes high720 to 720 dpi on 4x6 and uses pure dsnd (sendSetm=false)');
  const streamCalls = (kt.match(/EscprJob\.streamWithConfig\(/g) || []).length;
  assert.ok(streamCalls >= 5, 'EscprJob.streamWithConfig wired into printEscpr (net/usb), printEpsonL, diagPrintSync, and printFromHelper (found ' + streamCalls + ')');
});

test('Android borderless: wifiSave preserves borderless when switching from another printer, underscore L8050 names match, IPP falls back to 3mm before dropping media', () => {
  const html = assemble().html;
  // 1. Prove wifiSave calls _syncColorAdjToPrinter BEFORE setting printPrefs.borderless = true
  const wsIdx = html.indexOf('function wifiSave(p) {'), wsEnd = html.indexOf('function instaxWifiObj(', wsIdx);
  assert.ok(wsIdx > 0 && wsEnd > wsIdx, 'wifiSave found');
  const wsSrc = html.slice(wsIdx, wsEnd);
  const syncPos = wsSrc.indexOf('window._syncColorAdjToPrinter()');
  const blPos = wsSrc.indexOf('printPrefs.borderless = true');
  assert.ok(syncPos > 0 && blPos > syncPos, 'wifiSave syncs active printer profile BEFORE enabling borderless default');

  // Execute wifiSave in a simulated printer-switch lifecycle: Android print dialog -> EPSON L8050 Series -> printPrefsChanged()
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const printPrefs = { borderless: false, preview: false };
  const borderlessToggle = { checked: false };
  const printOptsMap = { 'Android print dialog': { borderless: false } };
  let colorAdjKeyNow = 'Android print dialog';
  let wifiPrinter = { ip: 'android:dialog', name: 'Android print dialog', dialog: true };
  let wifiDefault = wifiPrinter;
  const wifiSizeMap = {};
  const win = {
    _syncColorAdjToPrinter() {
      const k = wifiPrinter ? wifiPrinter.name : '';
      if (k === colorAdjKeyNow || !k) return;
      colorAdjKeyNow = k;
      printPrefs.borderless = !!(printOptsMap[k] && printOptsMap[k].borderless);
      borderlessToggle.checked = printPrefs.borderless;
    }
  };
  const printPrefsChanged = () => {
    win._syncColorAdjToPrinter(); // mirrors refreshPrintUI() -> refreshPrinterHint() -> _syncColorAdjToPrinter()
    printOptsMap[colorAdjKeyNow] = { borderless: !!printPrefs.borderless };
  };
  const runWifiSave = new Function(
    'window', 'localStorage', 'printPrefs', 'borderlessToggle', 'wifiSizeKey', 'wifiSizeMap', 'WIFI_SIZE_MAP_KEY', 'WIFI_PRINTER_KEY',
    'printerBorderlessKnown', 'epsonLUsbIpp', 'epsonLBorderlessModel', 'epsonEscprBorderlessModel', 'photoSheetSize', 'printPrefsChanged',
    'let wifiDefault = null, wifiPrinter = null; ' + wsSrc + '; return (p) => { wifiSave(p); return { wifiPrinter, wifiDefault }; };'
  )(
    win, store, printPrefs, borderlessToggle, () => '4r', wifiSizeMap, 'k1', 'k2',
    (p) => !!(p && /L8050/i.test(p.name || '')), (p) => !!(p && p.ipp && /L8050/i.test(p.name || '')),
    () => false, () => false, () => true, printPrefsChanged
  );
  // Mirror live wifiPrinter reference for win._syncColorAdjToPrinter
  const origSync = win._syncColorAdjToPrinter;
  win._syncColorAdjToPrinter = () => { wifiPrinter = wifiSizeMap['4r'] || wifiPrinter; origSync(); };

  runWifiSave({ ip: '192.168.223.1', name: 'EPSON L8050 Series', ipp: true, usb: false, borderless: false });
  assert.equal(colorAdjKeyNow, 'EPSON L8050 Series', 'active profile switched to L8050');
  assert.equal(printPrefs.borderless, true, 'borderless stays ON after switching from Android print dialog');
  assert.equal(borderlessToggle.checked, true, 'checkbox stays checked');
  assert.equal(printOptsMap['EPSON L8050 Series'].borderless, true, 'borderless=true persisted to L8050 profile');
  assert.equal(printOptsMap['Android print dialog'].borderless, false, 'previous printer profile untouched');

  // 2. Underscore mDNS name EPSON_L8050_Series matches epsonEscprBorderlessModel & epsonLNetPrinter
  const a = html.indexOf('const WIFI_OPTS_KEY'), b = html.indexOf('function wifiOpts(printer) {');
  const api = new Function('localStorage', 'IOS_APP', 'printSize', 'paperFor', 'printerKey',
    html.slice(a, b) + '; return { isEpsonL8050, epsonEscprBorderlessModel };')(store, false, '4r', () => ({ w: 101.6, h: 152.4 }), () => 'k');
  assert.equal(api.epsonEscprBorderlessModel({ escpr: true, name: 'EPSON_L8050_Series' }), true, 'underscore L8050 matches epsonEscprBorderlessModel');
  assert.equal(api.epsonEscprBorderlessModel({ escpr: true, usb: true, vid: 1208, pid: 2150, name: 'USB printer' }), true, 'VID/PID L8050 matches epsonEscprBorderlessModel');

  // 3. Dual-printer setup: _pfSeedBorderless & loadPrintOptsForPrinter default keep L8050 borderless ON across printer/size switches
  assert.ok(/window\._pfSeedBorderless\(p\.name\)/.test(wsSrc), 'wifiSave seeds borderless=true directly into the picked printer profile');
  assert.ok(/window\._pfSeedBorderless = function \(name\)/.test(html), '_pfSeedBorderless helper exported');
  assert.ok(/var defaultBl = false;\s*if \(!printOptsMap\[k\] && k\)/.test(html), 'loadPrintOptsForPrinter defaults borderless=true for uncustomized borderless printers');
  assert.ok(/function buildStripPages\(key\) \{\s*const paper = paperFor\(key\);\s*const dpi = canonDpiFor\(paper\) \|\| l8050DpiFor\(paper\) \|\| PRINT_DPI;/.test(html), 'buildStripPages uses hi-res L8050 DPI');

  // 4. NetPrintBridge.kt tries 3mm margins before dropping paper size (no-media), maps high720 -> High in IPP/PWG, and matches underscore USB L8050 names
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
  const bIdx = kt.indexOf('val baseStd = ArrayList<IppAttempt>()');
  const bEnd = kt.indexOf('val ns =', bIdx);
  assert.ok(bIdx > 0 && bEnd > bIdx, 'baseStd found');
  const bSrc = kt.slice(bIdx, bEnd);
  const pZero = bSrc.indexOf('IppAttempt(true, true, "", ownScaling)');
  const p300 = bSrc.indexOf('IppAttempt(true, true, "", "fill", 0.0, 0.0, 300)');
  const pNoMedia = bSrc.indexOf('IppAttempt(false, true, "", "")');
  assert.ok(pZero >= 0 && p300 > pZero && pNoMedia > p300, 'IPP attempts try 0mm borderless first, then 3mm margins, before dropping media');
  assert.ok(/"high", "high720" -> 5/.test(kt) && /"high", "high720" -> 600/.test(kt), 'IPP & PWG map high720 to High quality / 600 dpi');
  assert.ok(/Regex\("\(\?i\)\(\?:\^\|\[\^A-Za-z0-9\]\)L8050\(\?!\[0-9\]\)"\)\.containsMatchIn\(prod\)/.test(kt), 'USB EpsonLModels.match handles underscore L8050 product descriptors');
});

test('Epson L8050 Direct USB, Wi-Fi LAN, and Wi-Fi Direct reliability: relinking, never-sent fallback, subnet cache refresh, wake retry', () => {
  const html = assemble().html;

  // 1. wifiJobNeverSent distinguishes pre-connect errors from mid-stream errors (never double-prints)
  const jnsMatch = html.match(/function wifiJobNeverSent\(e\) \{[^\n]*\}/);
  assert.ok(jnsMatch, 'wifiJobNeverSent found');
  const wifiJobNeverSent = new Function(jnsMatch[0] + '; return wifiJobNeverSent;')();
  for (const msg of ['Connection refused', 'Could not reach printer at 192.168.223.1 on port 9100', 'connect timed out', 'failed to connect', 'Network is unreachable']) {
    assert.equal(wifiJobNeverSent(new Error(msg)), true, 'never-sent matches: ' + msg);
  }
  for (const msg of ['Printer at 192.168.223.1 stopped answering while receiving photo', 'Broken pipe', 'Connection reset by peer']) {
    assert.equal(wifiJobNeverSent(new Error(msg)), false, 'mid-stream error must NOT retry: ' + msg);
  }

  // 2. wifiRelink follows Router Wi-Fi <-> Wi-Fi Direct IP change AND preserves epsonLForced on USB replug
  const rlIdx = html.indexOf('function wifiRelink(d) {'), rlEnd = html.indexOf('function pbDebug()', rlIdx);
  assert.ok(rlIdx > 0 && rlEnd > rlIdx, 'wifiRelink found');
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const wifiSizeMap = {
    '4r': { ip: '192.168.1.45', name: 'EPSON L8050 Series', ipp: true, usb: false, escpr: false, bcap: false },
    '5r': { ip: 'usb:/dev/bus/usb/001/002', name: 'Epson L8050 (USB)', ipp: false, usb: true, epsonL: true, epsonLForced: true, epsonModel: 'L8050', borderless: true, vid: 1208, pid: 2150 },
    'a4': { ip: '192.168.1.99', name: 'Printer at 192.168.1.99', ipp: true, usb: false }
  };
  let wifiDefault = wifiSizeMap['4r'], wifiPrinter = wifiSizeMap['4r'];
  const runRelink = new Function(
    'localStorage', 'IOS_APP', 'wifiNetAvailable', 'wifiList', 'wifiSizeMap', 'WIFI_SIZE_MAP_KEY', 'WIFI_PRINTER_KEY', 'wifiDefault', 'wifiPrinter',
    html.slice(rlIdx, rlEnd) + '; return (d) => wifiRelink(d);'
  )(store, false, () => true, () => ({ printers: [] }), wifiSizeMap, 'k1', 'k2', wifiDefault, wifiPrinter);
  runRelink({
    printers: [
      { ip: '192.168.223.1', name: 'EPSON L8050 Series', ipp: true, usb: false, escpr: false, bcap: true },
      { ip: 'usb:/dev/bus/usb/001/007', name: 'Epson L8050 (USB)', ipp: true, usb: true, vid: 1208, pid: 2150 }
    ]
  });
  assert.equal(wifiSizeMap['4r'].ip, '192.168.223.1', 'Wi-Fi L8050 relinked from router IP to Wi-Fi Direct 192.168.223.1');
  assert.equal(wifiSizeMap['4r'].bcap, true, 'bcap synced on Wi-Fi relink');
  assert.equal(wifiSizeMap['5r'].ip, 'usb:/dev/bus/usb/001/007', 'replugged USB L8050 relinked to new bus address');
  assert.equal(wifiSizeMap['5r'].epsonLForced, true, 'USB L8050 built-in ESC/P-R mode preserved across replug');
  assert.equal(wifiSizeMap['5r'].borderless, true, 'USB L8050 borderless flag preserved across replug');
  assert.equal(wifiSizeMap['a4'].ip, '192.168.1.99', 'generic IP-named printer is NOT falsely relinked');

  // 3. wifiTestPrint relinks USB/Wi-Fi before printing
  assert.ok(/async function wifiTestPrint\(\) \{\s*if \(wifiTesting\) return;\s*try \{ wifiRelink\(\); wifiSyncForSize\(\); \}/.test(html), 'wifiTestPrint relinks USB/Wi-Fi printer before printing');

  // 4. NetPrintBridge.kt Wi-Fi Direct socket refresh, addByIp wake retry, and netRawStream connect/mid-stream separation
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');
  assert.ok(/System\.currentTimeMillis\(\) - netsAt > 500/.test(kt), 'matchLocalNet refreshes localNets on subnet miss for instant Wi-Fi Direct binding');
  assert.ok(/if \(e\.ippPort == 0 && e\.rawPort == 0 && e\.lpdPort == 0\)\s*\{\s*\/\/ Sleeping Wi-Fi \/ Wi-Fi Direct/.test(kt), 'addByIp retries once to wake sleeping Wi-Fi Direct printers');
  assert.ok(/Could not reach printer at \$ip on port \$port/.test(kt) && /stopped answering while receiving photo/.test(kt), 'netRawStream separates pre-connect errors from mid-stream errors');
});

test('Epson L8050 Wi-Fi Direct LPD Port 515 (/PASSTHRU): discovery, SNMP/Web model lookup, RFC 1179 streaming, relinking, and borderless defaults', () => {
  const html = assemble().html;
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');

  // 1. Kotlin LPD discovery, SNMP/HTTP model lookup, and RFC 1179 binary passthrough streaming
  assert.ok(/if \(e\.lpdPort == 0 && open\(e\.ip, 515, timeoutMs\)\) e\.lpdPort = 515/.test(kt), 'probeInto probes LPD port 515');
  assert.ok(/type\.startsWith\("_printer"\)/.test(kt) && /e\.lpdQueue = rp\.trimStart\('\/'\)/.test(kt), 'mDNS _printer._tcp. populates lpdPort and lpdQueue');
  assert.ok(/private fun snmpQueryModel\(ip: String\)/.test(kt) && /intArrayOf\(1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 3, 1\)/.test(kt), 'SNMPv1 hrDeviceDescr.1 query present');
  assert.ok(/private fun httpProbeModel\(ip: String\)/.test(kt) && /\/PRESENTATION\/HTML\/TOP\/INDEX\.HTML/.test(kt), 'HTTP :80 Epson Web Config model probe present');
  assert.ok(/private fun netLpdStream\(/.test(kt) && /File\.createTempFile\("pb_lpd_", "\.prn", activity\.cacheDir\)/.test(kt), 'netLpdStream spools to cacheDir temp file for exact RFC 1179 byte count');
  assert.ok(/queues\.add\("PASSTHRU"\)/.test(kt) && /queues\.add\("LPT1"\)/.test(kt), 'LPD tries PASSTHRU then LPT1/lp/raw');
  assert.ok(/l\$dfName\\nU\$dfName\\n/.test(kt), 'LPD control file uses lowercase l (binary passthrough)');
  assert.ok(/bos\.write\(0x03\)\s*bos\.write\("\$dataLen \$dfName\\n"/.test(kt), 'LPD sends exact dataLen in 0x03 data-file header');
  assert.ok(/if \(protocol == "lpd"\)/.test(kt) && /netLpdStream\(ip, port, queue\)/.test(kt), 'diagPrintSync supports LPD :515 test prints');
  assert.ok(/\.put\("lpd", it\.lpdPort > 0\)/.test(kt) && /\.put\("lpdPort", it\.lpdPort\)/.test(kt), 'list() exposes lpd and lpdPort flags');
  assert.ok(/if \(isL8050\) obj\.put\("epsonModel", "L8050"\)/.test(kt), 'list() attaches epsonModel=L8050 for discovered Wi-Fi/LPD L8050');

  // 2. booth.html wires lpd flag through wifiSave, printViaWifiRaw, wifiPhotoJob, wifiRelink, and auto-selects lpd_l8050_360 on 515-only probe
  assert.ok(/escpr: !!p\.escpr, lpd: !!p\.lpd,/.test(html), 'wifiSave preserves lpd flag');
  assert.ok(/lpd: !!\(p\.lpd && !p\.raw\)/.test(html), 'escprOpts forwards lpd flag to printEscpr');
  assert.ok(/if \(!o631 && !o9100 && o515\) presetEl\.value = 'lpd_l8050_360';/.test(html), 'diagnostic probe auto-selects lpd_l8050_360 when only port 515 is open');

  // 3. LPD-only Wi-Fi Direct L8050 (192.168.223.1) enables borderless, High quality, and Photo glossy defaults
  const a = html.indexOf('const WIFI_OPTS_KEY'), b = html.indexOf('function wifiOpts(printer) {');
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const api = new Function('localStorage', 'IOS_APP', 'printSize', 'paperFor', 'printerKey',
    html.slice(a, b) + '; return { isEpsonL8050, epsonEscprBorderlessModel, printerBorderlessKnown, wifiOptEff };')(
    store, false, '4r', () => ({ w: 101.6, h: 152.4 }), () => 'k'
  );
  const lpdL8050 = { ip: '192.168.223.1', name: 'EPSON L8050 Series', ipp: false, raw: false, escpr: true, lpd: true, epsonModel: 'L8050' };
  const lpdGenericWfd = { ip: '192.168.223.1', name: 'Epson Wi-Fi Direct (192.168.223.1)', ipp: false, raw: false, escpr: true, lpd: true };
  assert.equal(api.isEpsonL8050(lpdL8050), true, 'LPD L8050 recognized as L8050');
  assert.equal(api.printerBorderlessKnown(lpdL8050), true, 'LPD L8050 enables borderless default');
  assert.equal(api.wifiOptEff(lpdL8050, 'quality'), 'high', 'LPD L8050 defaults to high quality');
  assert.equal(api.wifiOptEff(lpdL8050, 'media'), 'photo', 'LPD L8050 defaults to glossy photo paper');
  assert.equal(api.epsonEscprBorderlessModel(lpdGenericWfd), true, 'fallback Epson Wi-Fi Direct LPD on 192.168.223.1 still allows borderless');

  // 4. wifiRelink upgrades a saved Router IPP L8050 cleanly when switched to Wi-Fi Direct LPD :515
  const rlIdx = html.indexOf('function wifiRelink(d) {'), rlEnd = html.indexOf('function pbDebug()', rlIdx);
  const wifiSizeMap = {
    '4r': { ip: '192.168.1.45', name: 'EPSON L8050 Series', ipp: true, usb: false, escpr: false, lpd: false }
  };
  let wifiDefault = wifiSizeMap['4r'], wifiPrinter = wifiSizeMap['4r'];
  const runRelink = new Function(
    'localStorage', 'IOS_APP', 'wifiNetAvailable', 'wifiList', 'wifiSizeMap', 'WIFI_SIZE_MAP_KEY', 'WIFI_PRINTER_KEY', 'wifiDefault', 'wifiPrinter',
    html.slice(rlIdx, rlEnd) + '; return (d) => wifiRelink(d);'
  )(store, false, () => true, () => ({ printers: [] }), wifiSizeMap, 'k1', 'k2', wifiDefault, wifiPrinter);
  runRelink({ printers: [lpdL8050] });
  assert.equal(wifiSizeMap['4r'].ip, '192.168.223.1', 'relinked from router IP to Wi-Fi Direct 192.168.223.1');
  assert.equal(wifiSizeMap['4r'].ipp, false, 'switched off IPP when only LPD is open');
  assert.equal(wifiSizeMap['4r'].escpr, true, 'enabled ESC/P-R');
  assert.equal(wifiSizeMap['4r'].lpd, true, 'enabled LPD flag');
  assert.equal(wifiSizeMap['4r'].epsonModel, 'L8050', 'synced epsonModel=L8050');

  // 5. wifiRelink upgrades placeholder name at same IP once SNMP/HTTP resolves "EPSON L8050 Series"
  const wifiSizeMap2 = {
    '4r': { ip: '192.168.223.1', name: 'Epson Wi-Fi Direct (192.168.223.1)', ipp: false, usb: false, escpr: true, lpd: true, epsonModel: '' }
  };
  let wd2 = wifiSizeMap2['4r'], wp2 = wifiSizeMap2['4r'];
  const runRelink2 = new Function(
    'localStorage', 'IOS_APP', 'wifiNetAvailable', 'wifiList', 'wifiSizeMap', 'WIFI_SIZE_MAP_KEY', 'WIFI_PRINTER_KEY', 'wifiDefault', 'wifiPrinter',
    html.slice(rlIdx, rlEnd) + '; return (d) => wifiRelink(d);'
  )(store, false, () => true, () => ({ printers: [] }), wifiSizeMap2, 'k1', 'k2', wd2, wp2);
  runRelink2({ printers: [lpdL8050] });
  assert.equal(wifiSizeMap2['4r'].name, 'EPSON L8050 Series', 'placeholder Wi-Fi Direct name upgraded once model resolved');
  assert.equal(wifiSizeMap2['4r'].epsonModel, 'L8050', 'epsonModel upgraded at same IP');
});

test('Wi-Fi Direct hardcoded connections: Brother 192.168.118.1, Epson/HP 192.168.223.1, Canon manual chip 192.168.0.1, no USB-flag leak on Wi-Fi', () => {
  const html = assemble().html;
  const kt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'NetPrintBridge.kt'), 'utf8');

  // 1. NetPrintBridge.list() handles Brother 192.168.118.1 and Epson/HP 192.168.223.1 without leaking USB-only canon/selphy flags onto Wi-Fi entries
  const listBody = kt.slice(kt.indexOf('fun list(): String'), kt.indexOf('usbListInto(arr)'));
  assert.ok(!listBody.includes('.put("canon"') && !listBody.includes('.put("selphy"'), 'Wi-Fi list() must NOT set USB-only canon/selphy flags');
  assert.ok(kt.includes('it.ip == "192.168.118.1"') && kt.includes('Brother Wi-Fi Direct (${it.ip})'), 'NetPrintBridge handles Brother Wi-Fi Direct 192.168.118.1');
  assert.ok(kt.includes('it.ip == "192.168.223.1"') && kt.includes('Epson / HP Wi-Fi Direct (${it.ip})'), 'NetPrintBridge handles Epson/HP Wi-Fi Direct 192.168.223.1');
  assert.ok(listBody.includes('!isHpKnown && !isBrotherKnown'), 'HP and Brother are never routed into Epson ESC/P-R');
  assert.ok(!kt.includes('ip.startsWith("192.168.0.")'), '192.168.0.x consumer router LAN is NOT falsely flagged as Wi-Fi Direct');

  // 2. booth.html has one-touch quick connection chips for all 3 major brands (including manual 192.168.0.1 Canon Direct chip)
  assert.ok(html.includes('data-ip="192.168.223.1"') && html.includes('data-ip="192.168.0.1"') && html.includes('data-ip="192.168.118.1"'), 'booth.html contains Wi-Fi Direct quick connect chips');
  assert.ok(html.includes('id="wdWfdCanonBtn"') && html.includes('id="wdWfdBrotherBtn"'), 'Diagnostic panel has dedicated Canon and Brother Wi-Fi Direct buttons');
  assert.ok(html.includes("detectedBrand = 'Brother'") && html.includes("detectedBrand = 'Epson / HP'") && !html.includes("detectedBrand = 'Canon'"), 'refreshWdNet auto-detects Brother & Epson/HP without hijacking 192.168.0.x routers');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
