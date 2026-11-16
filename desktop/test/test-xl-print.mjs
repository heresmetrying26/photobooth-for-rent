import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHelper, _helperTest } from '../lib/helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('PASS:', name);
  });
}

async function run() {
  const { pickPaper, sizeFromName, formatCapsLabel, PAPER_CACHE } = _helperTest;

  await check('sizeFromName parses inches, mm, Custom XL, and CUPS names', () => {
    assert.deepEqual(sizeFromName('4x12in').map((n) => Math.round(n * 10)), [1016, 3048]);
    assert.deepEqual(sizeFromName('Custom.203x813mm'), [203, 813]);
    assert.deepEqual(sizeFromName('om_small-photo_100x150mm'), [100, 150]);
    const letter = sizeFromName('na_letter_8.5x11in');
    assert.ok(letter && Math.abs(letter[0] - 215.9) < 0.2 && Math.abs(letter[1] - 279.4) < 0.2);
  });

  await check('formatCapsLabel formats PrintSchema media names cleanly', () => {
    assert.equal(formatCapsLabel('psk:PhotographicGlossy', ''), 'Photographic Glossy');
    assert.equal(formatCapsLabel('psk:Plain', 'Plain Paper'), 'Plain Paper');
    assert.equal(formatCapsLabel('epns200:Matte_Paper', ''), 'Matte Paper');
  });

  await check('pickPaper avoids false 4x12 -> 8x12 match while preserving 2x6 on 4x6 and borderless priority', async () => {
    PAPER_CACHE.set('EPSON L8050 Series', {
      at: Date.now(),
      def: '4x6 (8x12 test default)',
      sizes: [
        { key: 'A4', name: 'A4', w: 210, h: 297, borderless: false },
        { key: '4x6', name: '4 x 6 in', w: 101.6, h: 152.4, borderless: false },
        { key: '4x6bl', name: '4 x 6 in (Borderless)', w: 101.6, h: 152.4, borderless: true },
        { key: 'xl832', name: 'XL Strip 8x32', w: 203.2, h: 812.8, borderless: false }
      ]
    });

    // Standard 4x6 chooses borderless on L8050
    const p46 = await pickPaper('EPSON L8050 Series', 101.6, 152.4);
    assert.equal(p46.key, '4x6bl');

    // 8x32 matches custom User-Defined driver slot
    const p832 = await pickPaper('EPSON L8050 Series', 203.2, 812.8);
    assert.equal(p832.key, 'xl832');

    // Default 8x12 sheet MUST NOT match a 4x12 XL strip (a = 101.6 > 60)
    PAPER_CACHE.set('EPSON L3210 Series', {
      at: Date.now(),
      def: '8x12',
      sizes: [
        { key: '8x12', name: '8x12', w: 203.2, h: 304.8, borderless: false },
        { key: '4x6bl', name: '4x6 (Borderless)', w: 101.6, h: 152.4, borderless: true }
      ]
    });
    const p412 = await pickPaper('EPSON L3210 Series', 101.6, 304.8);
    assert.equal(p412, null);

    // 2x6 on 4x6 default DOES keep default when twoUp is omitted or true, and does NOT match 4x6 when twoUp is false
    PAPER_CACHE.set('HiTi P525L', {
      at: Date.now(),
      def: '4x6_split',
      sizes: [{ key: '4x6_split', name: '4x6 (2x6 split)', w: 101.6, h: 152.4, borderless: true }]
    });
    const p26TwoUp = await pickPaper('HiTi P525L', 50.8, 152.4, true);
    assert.equal(p26TwoUp.key, '4x6_split');
    assert.equal(p26TwoUp.keep, true);
    const p26Single = await pickPaper('HiTi P525L', 50.8, 152.4, false);
    assert.equal(p26Single, null);
  });

  await check('handleHelper validates POST /print input and missing printer gracefully', async () => {
    const resNoPages = await handleHelper(new Request('http://127.0.0.1:17321/print', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ printer: 'EPSON L3210 Series', pages: [] })
    }), '/print', new URLSearchParams());
    assert.equal(resNoPages.status, 400);
    const jNoPages = await resNoPages.json();
    assert.equal(jNoPages.ok, false);

    const resMissingCaps = await handleHelper(
      new Request('http://127.0.0.1:17321/printer/caps?printer=', { method: 'GET' }),
      '/printer/caps',
      new URLSearchParams('printer=')
    );
    assert.equal(resMissingCaps.status, 404);
  });

  await check('assembled protected/booth.html includes XL Strip 4, 48in limit, media/slot/layout-paper/Instax hooks', () => {
    const html = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
    for (const needle of [
      "id=\"xlPresetRow\"",
      "data-xlpreset=\"8x32in\"",
      "stripxl: { name: 'XL Strip 4'",
      "hi = u === 'in' ? 48 : 1220",
      "id=\"printerMediaSelect\"",
      "id=\"driverPaperSelect\"",
      "id=\"singleStripToggle\"",
      "id=\"posterDpiRow\"",
      "id=\"layoutPaperSelect\"",
      "pollInstaxStatus(",
      "isInstaxPrinter(pname) && !helperOn"
    ]) {
      assert.ok(html.includes(needle), 'Missing expected booth.html feature: ' + needle);
    }
  });

  console.log('\n' + passed + ' passed');
}

run().catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
