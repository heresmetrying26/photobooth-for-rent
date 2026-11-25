// Tests for macOS CUPS PPD English label parsing, Epson L8050 fallback labels, Auto-Glossy selection,
// and Epson EPIJ_Qual + Resolution quality mapping in desktop/lib/helper.mjs and protected/booth.html.
// Run: node desktop/test/test-mac-epson-l8050.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _helperTest } from '../lib/helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  decodePpdString,
  parsePpdChoiceLabels,
  parseCupsOptionsOutput,
  pickGlossyMediaType,
  pickCupsDriverQualityOptions,
  isAirPrintFromInfo,
  MAC_EPSON_L8050_CHOICE_LABELS
} = _helperTest;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS:', name); }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
};

// Real lines captured from /etc/cups/ppd/EPSON_L8050_Series.ppd on a client's MacBook
const REAL_L8050_PPD = `
*APPrinterPreset Photo_on_Glossy: ""
*EPIJ_Medi 145
*EPIJ_Qual 306
*Resolution 720x720dpi
*PageSize T4X6/4 <C3><97> 6 in (Borderless): ""
*PageSize A4/A4: ""
*DefaultEPIJ_Medi: 0
*EPIJ_Medi 0/Plain paper: ""
*EPIJ_Medi 142/Letterhead: ""
*EPIJ_Medi 2/Epson Photo Quality Ink Jet: ""
*EPIJ_Medi 12/Epson Matte: ""
*EPIJ_Medi 92/Epson Ultra Glossy: ""
*EPIJ_Medi 13/Epson Premium Glossy: ""
*EPIJ_Medi 15/Epson Premium Semigloss: ""
*EPIJ_Medi 145/Photo Paper Glossy: ""
*EPIJ_Medi 75/Epson Photo Stickers: ""
*EPIJ_Medi 93/Envelope: ""
*EPIJ_Medi 26/Disc Label: ""
*EPIJ_Medi 198/PVC ID Card (Borders): ""
*EPIJ_Medi 199/PVC ID Card (Borderless): ""
*DefaultEPIJ_Qual: 303
*EPIJ_Qual 302/Economy: ""
*EPIJ_Qual 303/Normal: ""
*EPIJ_Qual 308/Draft: ""
*EPIJ_Qual 304/Fine: ""
*EPIJ_Qual 305/Quality: ""
*EPIJ_Qual 306/High Quality: ""
*DefaultMediaType: 0
*MediaType 0/Plain paper: ""
*MediaType 142/Letterhead: ""
*MediaType 2/Epson Photo Quality Ink Jet: ""
*MediaType 12/Epson Matte: ""
*MediaType 92/Epson Ultra Glossy: ""
*MediaType 13/Epson Premium Glossy: ""
*MediaType 15/Epson Premium Semigloss: ""
*MediaType 145/Photo Paper Glossy: ""
*MediaType 75/Epson Photo Stickers: ""
*MediaType 93/Envelope: ""
*MediaType 26/Disc Label: ""
*MediaType 198/PVC ID Card (Borders): ""
*MediaType 199/PVC ID Card (Borderless): ""
*DefaultResolution: 360x360dpi
*Resolution 180x180dpi/180x180dpi: "<<>>setpagedevice"
*Resolution 360x360dpi/360x360dpi: "<<>>setpagedevice"
*Resolution 720x720dpi/720x720dpi: "<<>>setpagedevice"
*ja.EPIJ_Medi 145/写真用紙: ""
*EPIJ_GryS 0/Grayscale: ""
*EPIJ_GryS 1/Off: ""
`;

const REAL_LPOPTIONS_OUT = [
  'PageSize/Media Size: *A4 T4X6',
  'MediaType/MediaType: *0 142 2 12 92 13 15 145 75 93 26 198 199',
  'Resolution/Resolution: 180x180dpi *360x360dpi 720x720dpi',
  'ColorModel/ColorModel: *RGB',
  'EPIJ_Medi/Media Type: *0 142 2 12 92 13 15 145 75 93 26 198 199',
  'EPIJ_Qual/Print Quality: 302 *303 308 304 305 306',
  'EPIJ_GryS/Grayscale: 0 *1'
].join('\n');

test('parsePpdChoiceLabels reads real Epson L8050 English labels, decodes hex UTF-8, and ignores non-English/preset lines', () => {
  const labels = parsePpdChoiceLabels(REAL_L8050_PPD);
  assert.equal(labels.MediaType['0'], 'Plain paper');
  assert.equal(labels.MediaType['12'], 'Epson Matte');
  assert.equal(labels.MediaType['13'], 'Epson Premium Glossy');
  assert.equal(labels.MediaType['145'], 'Photo Paper Glossy');
  assert.equal(labels.EPIJ_Medi['92'], 'Epson Ultra Glossy');
  assert.equal(labels.EPIJ_Qual['303'], 'Normal');
  assert.equal(labels.EPIJ_Qual['305'], 'Quality');
  assert.equal(labels.EPIJ_Qual['306'], 'High Quality');
  assert.equal(labels.PageSize.T4X6, '4 × 6 in (Borderless)');
  assert.equal(labels.EPIJ_GryS['1'], 'Off');
});

test('parsePpdChoiceLabels prefers *en. translations when base label is numeric or missing', () => {
  const ppd = [
    '*EPIJ_Medi 0/0: ""',
    '*EPIJ_Medi 145: ""',
    '*en.EPIJ_Medi 0/Plain Paper: ""',
    '*en.EPIJ_Medi 145/Photo Paper Glossy: ""'
  ].join('\n');
  const labels = parsePpdChoiceLabels(ppd);
  assert.equal(labels.EPIJ_Medi['0'], 'Plain Paper');
  assert.equal(labels.EPIJ_Medi['145'], 'Photo Paper Glossy');
});

test('parseCupsOptionsOutput maps all L8050 numbers to English text using PPD', () => {
  const opts = parseCupsOptionsOutput(REAL_LPOPTIONS_OUT, REAL_L8050_PPD, 'EPSON_L8050_Series');
  const mt = opts.find((o) => o.key === 'MediaType');
  const eq = opts.find((o) => o.key === 'EPIJ_Qual');
  const ps = opts.find((o) => o.key === 'PageSize');
  assert.equal(mt.choices.find((c) => c.value === '0').label, 'Plain paper');
  assert.equal(mt.choices.find((c) => c.value === '145').label, 'Photo Paper Glossy');
  assert.equal(mt.choices.find((c) => c.value === '13').label, 'Epson Premium Glossy');
  assert.equal(mt.choices.find((c) => c.value === '12').label, 'Epson Matte');
  assert.equal(eq.choices.find((c) => c.value === '306').label, 'High Quality');
  assert.equal(eq.choices.find((c) => c.value === '303').selected, true);
  assert.equal(ps.choices.find((c) => c.value === 'T4X6').label, '4 × 6 in (Borderless)');
  // No numeric-only labels left on MediaType, EPIJ_Medi, or EPIJ_Qual
  for (const key of ['MediaType', 'EPIJ_Medi', 'EPIJ_Qual', 'EPIJ_GryS']) {
    const opt = opts.find((o) => o.key === key);
    for (const ch of opt.choices) {
      assert.ok(!/^\d+$/.test(ch.label), `${key} choice ${ch.value} should not be a raw number (got ${ch.label})`);
    }
  }
});

test('parseCupsOptionsOutput falls back to verified hardcoded L8050 English labels even when PPD is unreadable', () => {
  const opts = parseCupsOptionsOutput(REAL_LPOPTIONS_OUT, '', 'EPSON_L8050_Series');
  const mt = opts.find((o) => o.key === 'MediaType');
  const em = opts.find((o) => o.key === 'EPIJ_Medi');
  const eq = opts.find((o) => o.key === 'EPIJ_Qual');
  for (const [val, expected] of Object.entries(MAC_EPSON_L8050_CHOICE_LABELS.MediaType)) {
    assert.equal(mt.choices.find((c) => c.value === val).label, expected, 'MediaType ' + val);
    assert.equal(em.choices.find((c) => c.value === val).label, expected, 'EPIJ_Medi ' + val);
  }
  for (const [val, expected] of Object.entries(MAC_EPSON_L8050_CHOICE_LABELS.EPIJ_Qual)) {
    assert.equal(eq.choices.find((c) => c.value === val).label, expected, 'EPIJ_Qual ' + val);
  }
});

test('pickGlossyMediaType selects Photo Paper Glossy (145) over Ultra Glossy (92) on Mac L8050', () => {
  const opts = parseCupsOptionsOutput(REAL_LPOPTIONS_OUT, REAL_L8050_PPD, 'EPSON_L8050_Series');
  const mt = opts.find((o) => o.key === 'MediaType');
  assert.equal(pickGlossyMediaType(mt.choices), '145');
  // Without standard Photo Paper Glossy, prefers Premium Glossy (13) over Ultra Glossy (92)
  assert.equal(pickGlossyMediaType(mt.choices.filter((c) => c.value !== '145')), '13');
});

test('pickCupsDriverQualityOptions matches Epson L8050 presets for Best, Normal, Draft, and empty default', () => {
  const opts = parseCupsOptionsOutput(REAL_LPOPTIONS_OUT, REAL_L8050_PPD, 'EPSON_L8050_Series');
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'best', '145'), ['-o', 'EPIJ_Qual=306', '-o', 'Resolution=720x720dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'best', '13'), ['-o', 'EPIJ_Qual=306', '-o', 'Resolution=720x720dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'best', '75'), ['-o', 'EPIJ_Qual=305', '-o', 'Resolution=720x720dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'best', '0'), ['-o', 'EPIJ_Qual=304', '-o', 'Resolution=720x720dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'normal', '145'), ['-o', 'EPIJ_Qual=305', '-o', 'Resolution=720x720dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'normal', '0'), ['-o', 'EPIJ_Qual=303', '-o', 'Resolution=360x360dpi']);
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'draft', '145'), ['-o', 'EPIJ_Qual=308', '-o', 'Resolution=360x360dpi']);
  // Empty quality (e.g. Print Station / iPad LAN remote) defaults to Best, matching Windows & AirPrint
  assert.deepEqual(pickCupsDriverQualityOptions(opts, '', '145'), ['-o', 'EPIJ_Qual=306', '-o', 'Resolution=720x720dpi']);
  // Driver default (activeMediaVal=''): reads selected media type from queue (factory *0 Plain -> Fine 304)
  assert.deepEqual(pickCupsDriverQualityOptions(opts, 'best', ''), ['-o', 'EPIJ_Qual=304', '-o', 'Resolution=720x720dpi']);
  // Driver default when operator saved *145 Glossy in Configure printer (both MediaType & EPIJ_Medi synced) -> High Quality 306
  const savedGlossyOut = REAL_LPOPTIONS_OUT.replaceAll('*0 142', '0 142').replaceAll('15 145 75', '15 *145 75');
  const savedOpts = parseCupsOptionsOutput(savedGlossyOut, REAL_L8050_PPD, 'EPSON_L8050_Series');
  assert.deepEqual(pickCupsDriverQualityOptions(savedOpts, 'best', ''), ['-o', 'EPIJ_Qual=306', '-o', 'Resolution=720x720dpi']);
  // Non-Epson printer without EPIJ_Qual is left untouched
  const nonEpson = parseCupsOptionsOutput('PageSize/Media Size: *4x6\nResolution/Resolution: *300dpi 600dpi', '', 'DNP_DS620');
  assert.deepEqual(pickCupsDriverQualityOptions(nonEpson, 'best', ''), []);
});

test('isAirPrintFromInfo distinguishes Wi-Fi Bonjour official Epson driver from true AirPrint queues', () => {
  const bonjourUri = 'device for EPSON_L8050_Series: dnssd://EPSON%20L8050%20Series._printer._tcp.local./?bidi';
  const usbUri = 'device for EPSON_L8050_Series: usb://EPSON/L8050%20Series?serial=12345';
  const airPrintPpd = '*NickName: "EPSON L8050 Series-AirPrint"\n*APAirPrint: True\n';
  assert.equal(isAirPrintFromInfo(usbUri, REAL_L8050_PPD), false, 'USB Epson driver is not AirPrint');
  assert.equal(isAirPrintFromInfo(bonjourUri, REAL_L8050_PPD), false, 'Wi-Fi Bonjour Epson official driver (EPIJ_Medi/EPIJ_Qual) is NOT AirPrint');
  assert.equal(isAirPrintFromInfo(bonjourUri, '*cupsFilter: "application/vnd.cups-raster 0 /Library/Printers/EPSON/InkjetPrinter2/Filter/rastertoescpII.app"\n'), false, 'Epson InkjetPrinter2 filter path is NOT AirPrint');
  assert.equal(isAirPrintFromInfo(bonjourUri, airPrintPpd), true, 'True AirPrint PPD stays AirPrint');
  assert.equal(isAirPrintFromInfo(bonjourUri, ''), true, 'Driverless dnssd queue without PPD stays AirPrint');
});

test('decodePpdString decodes CUPS UTF-8 hex escapes cleanly', () => {
  assert.equal(decodePpdString('4 <C3><97> 6 in (Borderless)'), '4 × 6 in (Borderless)');
  assert.equal(decodePpdString('Photo Paper Glossy'), 'Photo Paper Glossy');
});

test('built booth.html and helper.mjs keep UI labels, sync, cache invalidation, and AirPrint guards intact', () => {
  const html = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  const helperSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'helper.mjs'), 'utf8');
  assert.ok(html.includes('op.textContent = c.label || c.value;'), 'pbCupsOptionsUI renders c.label || c.value');
  assert.ok(html.includes("'EPIJ_Qual', 'Resolution'"), 'pbCupsOptionsUI promotes EPIJ_Qual alongside Resolution');
  assert.ok(html.includes("o.key === 'MediaType' ? 'EPIJ_Medi'"), 'pbCupsOptionsUI keeps MediaType and EPIJ_Medi synced');
  assert.ok(html.includes('delete paperChecks[k]'), 'pbCupsOptionsUI clears paperChecks after saving');
  assert.ok(helperSrc.includes('airPrintQualityOptions(printer, quality, !!(reqMediaType || keepDriverMedia))'), 'AirPrint respects explicit MediaType and Driver default');
  assert.ok(helperSrc.includes('PAPER_CACHE.delete(name);') && helperSrc.includes('CAPS_CACHE.delete(name);'), 'POST /printer/options invalidates server caches');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
process.exit(process.exitCode || 0);
