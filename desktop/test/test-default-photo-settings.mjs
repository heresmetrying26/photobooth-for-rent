// Laptop app (Windows / Mac) and direct printers: a printer that can print borderless defaults to its glossy photo paper type and its
// best quality, unless the operator picked something else. Run: node desktop/test/test-default-photo-settings.mjs
//
// What this proves: the paper-type picker gives the right answer for the paper-type lists read from real drivers (installed on the booth
// laptop, read with GetPrintCapabilities, no print), the print code asks for it, and 'Driver default' still turns it off.
// What it CANNOT prove: that a driver accepts the paper type on a real sheet (needs a printer), or anything on a Mac.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { _helperTest, initHelper, handleHelper, stopHelper } from '../lib/helper.mjs';
import { assemble } from '../../scripts/assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { pickGlossyMediaType: pick } = _helperTest;
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } };
const L = (...v) => v.map((value) => ({ value, label: '' }));

await test('glossy photo paper is found in the lists of real drivers', () => {
  assert.equal(pick(L('psk:Plain', 'psk:Bond', 'psk:PhotographicMatte', 'psk:HighResolution', 'psk:PhotographicHighGloss', 'psk:PhotographicSemiGloss', 'ns0000:EpsonPhotoPaperGlossy')), 'ns0000:EpsonPhotoPaperGlossy', 'Epson L8050 / L3210');
  assert.equal(pick(L('psk:HighResolution', 'psk:PhotographicHighGloss', 'psk:PhotographicSemiGloss', 'ns0000:EpsonPhotoPaperGlossy', 'psk:PhotographicMatte', 'psk:Bond')), 'ns0000:EpsonPhotoPaperGlossy', 'Epson L805');
  assert.equal(pick(L('psk:Plain', 'psk:PhotographicGlossy', 'ns0001:BrInkjet', 'ns0001:BrBP71PhotographicGlossy')), 'psk:PhotographicGlossy', 'Brother DCP-T: the plain glossy photo type, not BP71');
  assert.equal(pick(L('psk:Plain', 'ns0000:PhotoPaperPlusGlossy2', 'ns0000:PhotoPaperProLuster', 'ns0000:SuperPhotoSilky', 'ns0000:GlossyPaperStandard', 'ns0000:MattePhoto', 'ns0000:ContentsGlossy', 'ns0000:JapanesePostcard', 'psk:HighResolution')), 'ns0000:PhotoPaperPlusGlossy2', 'Canon G1010');
  assert.equal(pick(L('psk:Plain', 'psk:PhotographicMatte', 'psk:PhotographicHighGloss', 'psk:EnvelopePlain')), 'psk:PhotographicHighGloss', 'Epson L210: its only glossy type');
});

await test('nothing is picked when nothing can be told to be glossy photo paper', () => {
  assert.equal(pick(L('ns0000:_0_1004_0000_0_600x600', 'ns0000:_5_1069_0000_0_600x600', 'ns0000:_2_1077_0000_0_600x600')), '', 'HP: numbered names');
  assert.equal(pick(L('psk:Plain', 'psk:PhotographicMatte', 'psk:PhotographicSemiGloss')), '', 'matte, semi-gloss and plain are not glossy');
  assert.equal(pick(L('ns0000:ContentsGlossy', 'ns0000:JapanesePostcard', 'ns0000:PhotoPaperProLuster')), '', 'contents, postcard and luster papers are not picked');
  assert.equal(pick([]), ''); assert.equal(pick(undefined), '');
  assert.equal(pick(['photographic-glossy', 'stationery']), 'photographic-glossy', 'a CUPS / IPP name is found by its text');
});

const src = readFileSync(join(ROOT, 'desktop', 'lib', 'helper.mjs'), 'utf8');
await test('print code: default for a borderless printer, Driver default turns it off, High quality includes psk:High', () => {
  assert.ok(/if \(!reqMediaType && !keepDriverMedia && fit !== 'width' && !DYE_SUB\.test\(printer\)\)/.test(src), 'the default is applied only with no paper type picked, never on a receipt roll or a dye-sub');
  assert.ok(/caps\.borderless === true \|\| !!\(pick && pick\.borderless\)/.test(src), 'only a printer that offers Borderless');
  assert.ok(/IS_WIN \|\| !\(await isAirPrintQueue\(printer\)\)/.test(src), 'a Mac AirPrint queue keeps choosing its own photo paper');
  assert.ok(/reqMediaType === 'driver'/.test(src), "'driver' leaves the paper type alone");
  assert.ok(/default \{ 'HighQuality\|Best\|Photographic\|\^psk:High\$' \}/.test(src), 'psk:High (Brother, Canon, HP) counts as the best quality');
  assert.ok(/@borderless\|/.test(src), 'the Windows caps script reports whether the driver offers Borderless');
});

await test('booth page: Auto / Driver default choices for the paper type', () => {
  const html = assemble().html;
  assert.ok(/function mediaAutoLabel\(caps\)/.test(html));
  assert.equal((html.match(/addM\('driver', 'Driver default/g) || []).length, 2, 'both paper-type lists offer Driver default');
  assert.equal((html.match(/addM\('', mediaAutoLabel\(caps\)\)/g) || []).length, 2, 'both lists start with Auto');
  assert.ok(!/addM\('', 'Driver default \(recommended\)'\)/.test(html), 'the old first choice is gone');
  assert.ok(/autoMedia: j\.autoMedia \|\| ''/.test(html), 'the page keeps what Auto resolves to');
});

// Real drivers: only on a Windows laptop that has them installed (read only, nothing is printed).
const caps = async (name) => { const r = await handleHelper({ method: 'GET' }, '/printer/caps', new URLSearchParams({ printer: name })); return r.status === 200 ? r.json() : null; };
if (process.platform === 'win32') {
  initHelper({ workerPath: '', logger: () => { } });
  const st = await (await handleHelper({ method: 'GET' }, '/status', new URLSearchParams())).json();
  const have = (n) => st.printers.includes(n);
  await test('Windows drivers on this laptop: Auto resolves as expected (read only)', async () => {
    const want = { 'EPSON L8050 Series': 'ns0000:EpsonPhotoPaperGlossy', 'EPSON L3210 Series': 'ns0000:EpsonPhotoPaperGlossy', 'Canon G1010 series': 'ns0000:PhotoPaperPlusGlossy2', 'EPSON L120 Series': '', 'EPSON L210 Series': '' };
    let n = 0;
    for (const [name, auto] of Object.entries(want)) {
      if (!have(name)) continue;
      const j = await caps(name); n++;
      assert.ok(j && j.ok, name);
      assert.equal(j.autoMedia, auto, name);
    }
    console.log('  (' + n + ' installed driver(s) checked)');
  });
  stopHelper();
} else console.log('SKIP: real Windows drivers (not a Windows laptop)');

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
process.exit(process.exitCode || 0);
