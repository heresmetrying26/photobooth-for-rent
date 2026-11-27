// Tests for HiTi & commercial dye-sub 2x6 split / 4x6 whole printing across Desktop, Print Helper, Booth UI, and Print Station.
// Run: node desktop/test/test-hiti-dyesub.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _helperTest } from '../lib/helper.mjs';

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
  const { pickPaper, isSplitPaperName, pickDyeSubCupsCutOption, DYE_SUB, PAPER_CACHE } = _helperTest;

  await check('isSplitPaperName recognizes HiTi/DNP/Citizen split slots and ignores whole 4x6 / XL strips', () => {
    for (const yes of [
      '6x4 Split (6x2 2 prints)',
      '6x4 Split(6x2 2 prints)',
      '6x4/2-UP',
      '4x6 (2-UP)',
      '6x4_split',
      '4x6 (2x6 split)',
      '6x4 (2x6 ×2)',
      'w288h432-div2',
      '4x6 (2-inch cut)',
      '4x6 (2inch cut)',
      '4x6 2-cut',
      '4x6_2cut',
      '4x6*2',
      'PR (4x6)*2',
      '6x4*2',
      '(2) 2x6" cut',
      '6x4 Cut2x6',
      '2x6x2'
    ]) {
      assert.equal(isSplitPaperName(yes), true, 'expected split: ' + yes);
    }
    for (const no of [
      '6x4',
      '4x6',
      'PR (4x6)',
      '4 x 6 in',
      '4x6 (Borderless)',
      '4.5x8',
      '5x7',
      '6x8',
      '6x9',
      '12x6',
      '2x60',
      'XL Strip 8x32',
      'A4'
    ]) {
      assert.equal(isSplitPaperName(no), false, 'expected whole/non-split: ' + no);
    }
  });

  await check('Single HiTi queue (default 6x4): auto-switches to 6x4 Split for 2x6 strips and keeps 6x4 for whole 4x6', async () => {
    PAPER_CACHE.set('HiTi P525L', {
      at: Date.now(),
      def: '6x4',
      sizes: [
        { key: '6x4', name: '6x4', w: 101.6, h: 152.4, borderless: true },
        { key: '6x4 Split (6x2 2 prints)', name: '6x4 Split (6x2 2 prints)', w: 101.6, h: 152.4, borderless: true },
        { key: '6x8', name: '6x8', w: 152.4, h: 203.2, borderless: true }
      ]
    });
    const whole = await pickPaper('HiTi P525L', 101.6, 152.4, false);
    assert.equal(whole.key, '6x4');
    assert.equal(whole.keep, true);

    const strip = await pickPaper('HiTi P525L', 101.6, 152.4, true);
    assert.equal(strip.key, '6x4 Split (6x2 2 prints)');
    assert.equal(strip.keep, false, 'must switch paper slot away from 6x4 default');

    const stripNarrow = await pickPaper('HiTi P525L', 50.8, 152.4, true);
    assert.equal(stripNarrow.key, '6x4 Split (6x2 2 prints)');
    assert.equal(stripNarrow.keep, false);
  });

  await check('Single HiTi queue left on 6x4/2-UP default: auto-switches to whole 6x4 so 4x6 photos are not cut in half', async () => {
    PAPER_CACHE.set('HiTi P750L', {
      at: Date.now(),
      def: '6x4/2-UP',
      sizes: [
        { key: '6x4', name: '6x4', w: 101.6, h: 152.4, borderless: true },
        { key: '6x4/2-UP', name: '6x4/2-UP', w: 101.6, h: 152.4, borderless: true }
      ]
    });
    const strip = await pickPaper('HiTi P750L', 101.6, 152.4, true);
    assert.equal(strip.key, '6x4/2-UP');
    assert.equal(strip.keep, true);

    const whole = await pickPaper('HiTi P750L', 101.6, 152.4, false);
    assert.equal(whole.key, '6x4');
    assert.equal(whole.keep, false, 'must switch away from split default for whole 4x6');
  });

  await check('Dual-queue HiTi (private DEVMODE checkbox): preserves queue default when driver lists only 6x4', async () => {
    PAPER_CACHE.set('HiTi 2x6 cut', {
      at: Date.now(),
      def: '6x4',
      sizes: [
        { key: '6x4', name: '6x4', w: 101.6, h: 152.4, borderless: true },
        { key: '6x8', name: '6x8', w: 152.4, h: 203.2, borderless: true }
      ]
    });
    const strip = await pickPaper('HiTi 2x6 cut', 101.6, 152.4, true);
    assert.equal(strip.key, '6x4');
    assert.equal(strip.keep, true, 'must keep default DEVMODE so private 2-inch cut checkbox stays intact');
  });

  await check('DNP CUPS PPD (w288h432 vs w288h432-div2): auto-switches cleanly for twoUp true/false', async () => {
    PAPER_CACHE.set('DNP DS-RX1', {
      at: Date.now(),
      def: 'w288h432',
      sizes: [
        { key: 'w288h432', name: '4x6', w: 101.6, h: 152.4, borderless: true },
        { key: 'w288h432-div2', name: '4x6 (2x6*2)', w: 101.6, h: 152.4, borderless: true }
      ]
    });
    const strip = await pickPaper('DNP DS-RX1', 101.6, 152.4, true);
    assert.equal(strip.key, 'w288h432-div2');
    assert.equal(strip.keep, false);

    const whole = await pickPaper('DNP DS-RX1', 101.6, 152.4, false);
    assert.equal(whole.key, 'w288h432');
    assert.equal(whole.keep, true);
  });

  await check('DNP Windows PR(4x6) vs PR(4x6)*2 and dedicated 2x6 queue: auto-switches or preserves private DEVMODE', async () => {
    PAPER_CACHE.set('DP-DS620', {
      at: Date.now(),
      def: 'PR (4x6)',
      sizes: [
        { key: 'PR (4x6)', name: 'PR (4x6)', w: 101.6, h: 152.4, borderless: true },
        { key: 'PR (4x6)*2', name: 'PR (4x6)*2', w: 101.6, h: 152.4, borderless: true },
        { key: '6x8', name: '6x8', w: 152.4, h: 203.2, borderless: true }
      ]
    });
    const strip = await pickPaper('DP-DS620', 101.6, 152.4, true);
    assert.equal(strip.key, 'PR (4x6)*2');
    assert.equal(strip.keep, false);

    const whole = await pickPaper('DP-DS620', 101.6, 152.4, false);
    assert.equal(whole.key, 'PR (4x6)');
    assert.equal(whole.keep, true);

    // Dedicated DNP Windows queue where 2-inch cut is a checkbox inside Printing Preferences (only PR (4x6) in PaperSizes)
    PAPER_CACHE.set('DNP 2x6 Strips', {
      at: Date.now(),
      def: 'PR (4x6)',
      sizes: [
        { key: 'PR (4x6)', name: 'PR (4x6)', w: 101.6, h: 152.4, borderless: true }
      ]
    });
    const dedicated = await pickPaper('DNP 2x6 Strips', 101.6, 152.4, true);
    assert.equal(dedicated.key, 'PR (4x6)');
    assert.equal(dedicated.keep, true, 'must keep default DEVMODE so 2-inch cut checkbox stays intact');
  });

  await check('pickDyeSubCupsCutOption toggles DNP macOS PPD cutter options and ignores StpNoCutWaste', () => {
    const dnpPpdOpts = [
      { key: 'StpNoCutWaste', choices: [{ value: 'False', label: 'Off', selected: true }, { value: 'True', label: 'On', selected: false }] },
      { key: 'DNPBoxCutter', choices: [{ value: 'Standard', label: 'Normal (Uncut)', selected: true }, { value: 'Cut2inch', label: '2-inch Cut', selected: false }] }
    ];
    assert.deepEqual(pickDyeSubCupsCutOption(dnpPpdOpts, true), ['-o', 'DNPBoxCutter=Cut2inch']);
    assert.deepEqual(pickDyeSubCupsCutOption(dnpPpdOpts, false), []);

    const cutEnabledOpts = [
      { key: 'CutOperation', choices: [{ value: 'Disable', label: 'Disable', selected: false }, { value: 'Enable', label: '2x6 Cut', selected: true }] }
    ];
    assert.deepEqual(pickDyeSubCupsCutOption(cutEnabledOpts, false), ['-o', 'CutOperation=Disable']);
    assert.deepEqual(pickDyeSubCupsCutOption(cutEnabledOpts, true), []);

    const wasteOnly = [
      { key: 'StpNoCutWaste', choices: [{ value: 'False', label: 'Off', selected: true }, { value: 'True', label: 'On', selected: false }] }
    ];
    assert.deepEqual(pickDyeSubCupsCutOption(wasteOnly, true), []);
  });

  await check('DYE_SUB regex matches HiTi, DNP (incl. QW410/RX1HS/DP-DS620/CUPS underscores), Citizen, Sinfonia, Mitsubishi, SELPHY and excludes Epson/Canon inkjet', () => {
    for (const yes of [
      'HiTi P525L', 'HiTi 2x6 cut', 'HiTi P510S', 'HiTi P750L',
      'DNP DS620', 'DNP 4x6', 'DNP_4x6', 'DNP_2x6_Strips', 'DNP_DS620',
      'DP-DS620', 'DS620A', 'DS820A', 'DS-RX1HS', 'RX1HS', 'RX1 2x6',
      'DP-QW410', 'QW410', 'SL620',
      'Citizen CX-02', 'Sinfonia CS2', 'Mitsubishi CP-D70DW', 'Canon SELPHY CP1500'
    ]) {
      assert.equal(DYE_SUB.test(yes), true, yes);
    }
    for (const no of ['EPSON L8050 Series', 'EPSON L3210 Series', 'Canon G1010 series', 'Brother DCP-T420W', 'HP DeskJet 2700', 'Microsoft Print to PDF']) {
      assert.equal(DYE_SUB.test(no), false, no);
    }
  });

  await check('Desktop helper & standalone Print Helper both protect dye-sub DEVMODE and use TileFlipXY crisp GDI+ drawing', () => {
    for (const rel of ['desktop/lib/helper.mjs', 'tools/print-helper/print-helper.js']) {
      const src = readFileSync(join(root, rel), 'utf8');
      assert.ok(src.includes('[switch]$DyeSub'), rel + ' missing -DyeSub param');
      assert.ok(src.includes('if ($Borderless -and -not $DyeSub)'), rel + ' must skip Borderless PrintTicket on dye-sub');
      assert.ok(src.includes('WrapMode]::TileFlipXY'), rel + ' missing TileFlipXY edge wrap');
      assert.ok(src.includes('PixelOffsetMode]::HighQuality'), rel + ' missing PixelOffsetMode HighQuality');
      assert.ok(src.includes("isDyeSub ? ['-DyeSub'] : []"), rel + ' must pass -DyeSub for dye-sub printers');
      assert.ok(src.includes('dyeSubCupsCutOptions'), rel + ' missing macOS CUPS cut option helper');
    }
  });

  await check('Built protected/booth.html includes LumaBooth-style 2x6 Split Strips Printer card, per-slot driverPaperKey, dye-sub 2x6 guard, and Print Station strip routing', () => {
    const html = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
    for (const needle of [
      'id="stripPrinterCard"',
      'id="stripPrinterSelect"',
      'id="testWhole4x6Btn"',
      'id="testStrip2x6Btn"',
      'id="stripDriverPaperSelect"',
      'function refreshStripPrinterUI()',
      'function isDyeSubPrinter(',
      'const dyeSubPair2x6 =',
      'c._pbAutoTwoUp4x6 = true',
      'const half = Math.round(c.width / 2);',
      'twoUp: isTwoUp',
      "const routeKey = autoTwoUp4x6 ? 'strip:4x6'"
    ]) {
      assert.ok(html.includes(needle), 'Missing expected booth.html feature: ' + needle);
    }
    // Verify no JS regex lookbehind leaked into DYE_SUB_PRINTER_RE (breaks iPadOS 15 Safari)
    // and verify it matches macOS CUPS underscore names and all DNP model names.
    const m = /const DYE_SUB_PRINTER_RE = (\/[^\n]+\/[gimsuy]*);/.exec(html);
    assert.ok(m, 'DYE_SUB_PRINTER_RE must be present');
    assert.ok(!/\(\?<[=!]/.test(m[1]), 'DYE_SUB_PRINTER_RE must not use lookbehind for Safari 15 compatibility');
    const reBody = m[1].slice(1, m[1].lastIndexOf('/'));
    const reFlags = m[1].slice(m[1].lastIndexOf('/') + 1);
    const boothDyeRe = new RegExp(reBody, reFlags);
    for (const yes of ['DNP 4x6', 'DNP_4x6', 'DNP_2x6_Strips', 'DNP_DS620', 'DP-DS620', 'DS620A', 'DS820A', 'DS-RX1HS', 'RX1HS', 'DP-QW410', 'QW410', 'SL620', 'HiTi_4x6', 'Citizen_CX_02', 'Mitsubishi_CP_D80DW']) {
      assert.equal(boothDyeRe.test(yes), true, 'booth DYE_SUB_PRINTER_RE should match: ' + yes);
    }
    for (const no of ['EPSON L8050 Series', 'EPSON L3210 Series', 'Canon G1010 series', 'Brother DCP-T420W', 'Microsoft Print to PDF']) {
      assert.equal(boothDyeRe.test(no), false, 'booth DYE_SUB_PRINTER_RE must not match: ' + no);
    }
  });

  await check('Cloud Print Station (printjobs.mjs & print-station/index.html) supports strip:4x6 routing & twoUp', () => {
    const fnSrc = readFileSync(join(root, 'netlify', 'functions', 'printjobs.mjs'), 'utf8');
    assert.ok(fnSrc.includes('twoUp: !!b.twoUp'), 'printjobs.mjs must persist twoUp');
    assert.ok(fnSrc.includes('.slice(0, 28)'), 'printjobs.mjs must allow strip: paper keys');

    const psHtml = readFileSync(join(root, 'public', 'print-station', 'index.html'), 'utf8');
    for (const needle of [
      "if(k === '4x6' && keys.indexOf('strip:4x6') < 0) keys.push('strip:4x6')",
      'function resolveStationPrinter(',
      'id="testStripBtn"',
      'twoUp: typeof twoUp'
    ]) {
      assert.ok(psHtml.includes(needle), 'print-station/index.html missing: ' + needle);
    }
  });

  console.log('\n' + passed + ' passed');
}

run().catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
