// Verifies thermal voucher printing across all routes (Bluetooth, USB/Wi-Fi raw ESC/POS,
// Desktop/Web Print Helper, Android/iPad print dialog, Browser tickets.html), portrait canvas
// sizing, continuous strip packing height, mid-batch stop, and printed-code tracking.
// Run from the repo root:
//   node scripts/test-voucher-thermal.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const booth = readFileSync('protected/booth.html', 'utf8');
const ticketsHtml = readFileSync('public/pay/tickets.html', 'utf8');
const lifetimeHtml = readFileSync('public/lifetime/index.html', 'utf8');

// 1. Markup & static integration checks
assert.ok(booth.includes('id="vPrintSheet"'), 'booth must include #vPrintSheet modal');
assert.ok(booth.includes('data-fmt="thermal80"') && booth.includes('data-fmt="thermal58"') && booth.includes('data-fmt="a4"'), 'modal must expose 80mm, 58mm and A4 choices');
assert.ok(booth.includes('id="vPrintCutEach"') && booth.includes('id="vPrintPreview"'), 'modal must include cut-each toggle and live preview canvas');
assert.ok(booth.includes('openVoucherPrintModal(printData)'), 'Print tickets button must open the voucher print modal');
assert.ok(ticketsHtml.includes('size:80mm auto') && ticketsHtml.includes('size:58mm auto') && ticketsHtml.includes('size:A4'), 'tickets.html must support A4, 80mm and 58mm @page rules');
assert.ok(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/.test(ticketsHtml), 'tickets.html must keep Google Fonts link compatible with desktop/scripts/prepare.mjs');
assert.ok(lifetimeHtml.includes('tier: bt.tier, label: bt.label'), 'My Events portal must pass tier & label to tickets.html');

// 2. Extract voucher thermal helper functions from generated protected/booth.html and run in VM
const startMark = 'var VPRINT_DONE_KEY = \'pb_vprint_done\';';
const endMark = '// ---- Android-compatible A4 ticket sheet printer ----';
const sIdx = booth.indexOf(startMark);
const eIdx = booth.indexOf(endMark);
assert.ok(sIdx > 0 && eIdx > sIdx, 'could not locate thermal voucher section in protected/booth.html');

// Also pull the vPrintFreshCodes helper block
const fnBlock1 = booth.slice(sIdx, booth.indexOf('function fmtShortDate(t)', sIdx));
const fnBlock2 = booth.slice(booth.indexOf('// ---- Voucher ticket helpers (Thermal 80mm / 58mm + A4 sheet) ----'), eIdx);

function makeFakeCanvas() {
  const ops = [];
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect(...a) { ops.push(['fillRect', ...a]); },
    strokeRect(...a) { ops.push(['strokeRect', ...a]); },
    fillText(t, x, y) { ops.push(['fillText', String(t), x, y]); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    stroke() { ops.push(['stroke']); }, fill() { ops.push(['fill']); },
    save() {}, restore() {}, setLineDash() {},
    drawImage(src, x, y) { ops.push(['drawImage', src && src.width, src && src.height, x, y]); },
    measureText(t) {
      const m = /(\d+)px/.exec(this.font);
      const px = m ? Number(m[1]) : 16;
      return { width: String(t || '').length * px * 0.6 };
    }
  };
  return {
    width: 0, height: 0, _ops: ops,
    getContext() { return ctx; },
    toDataURL(mime) { return 'data:' + (mime || 'image/png') + ';base64,FAKE'; }
  };
}

function makeSandbox(overrides = {}) {
  const store = new Map();
  const calls = { bt: [], wifi: [], helper: [], dialog: [], open: [] };
  const sandbox = {
    Set, Map, Array, Object, Number, String, Math, JSON, Date, Promise, Error, RegExp, setTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    document: { createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : {}) },
    PAPER: {
      receipt80: { name: 'Receipt 80 mm', w: 72, h: 290, receipt: true },
      receipt58: { name: 'Receipt 58 mm', w: 48, h: 195, receipt: true }
    },
    RECEIPT_DPI: 203,
    IOS_APP: false,
    payCfg: { options: [{ label: 'Thermal Strip', tier: 'receipt', price: 80, prints: 2 }] },
    btThermalOn: false,
    helperOn: false,
    helper: { ok: false, printers: [] },
    tierPrinters: {},
    wifiSizeMap: {},
    wifiPrinter: null,
    wifiDefault: null,
    isReceiptPaper: (k) => k === 'receipt80' || k === 'receipt58',
    is58mmPrinterName: (n) => /58|p50|mp210|c19/i.test(String(n || '')),
    printerFor: () => '',
    activeExtraPrinters: () => [],
    isBtThermalAvailable: () => false,
    wifiNetAvailable: () => false,
    wifiRelink: () => {},
    wifiList: () => ({ printers: [] }),
    wifiPKey: (p) => String((p && (p.name || p.ip)) || ''),
    wifiOpts: () => ({}),
    pwBtName: () => '',
    pwSet: () => {},
    printViaWifi: async (pages, paper, wp, wo) => { calls.wifi.push({ pages, paper, wp, wo }); },
    printViaHelper: async (pages, paper, name, opt) => { calls.helper.push({ pages, paper, name, opt }); return true; },
    window: {
      _btThermal: {
        btPrinter: { connected: false, name: '', canReconnect: () => false },
        isKnown58mmPrinter: (n) => /58|p50|mp210/i.test(String(n || '')),
        printViaBluetooth: async (cv, rollW, opts) => { calls.bt.push({ cv, rollW, opts }); }
      },
      __PBPrint: null,
      open: (url, target) => { calls.open.push({ url, target }); return {}; }
    },
    ...overrides
  };
  vm.createContext(sandbox);
  vm.runInContext(fnBlock1 + '\n' + fnBlock2, sandbox);
  return { sb: sandbox, calls, store };
}

const sampleData = {
  event: 'Ana & Marco Wedding Celebration 2026',
  price: 100,
  prints: 1,
  tier: 'receipt',
  label: 'Thermal Strip',
  codes: ['12345678', '23456789', '34567890', '45678901', '56789012']
};

// Test A: Thermal voucher canvas dimensions (strictly portrait, pure B&W _pbToneDone)
{
  const { sb } = makeSandbox();
  const c80 = sb.buildThermalVoucherCanvas(sampleData, '12345678', { dotW: 576, showCutLine: false });
  assert.equal(c80.width, 576);
  assert.ok(c80.height > c80.width, '80mm single ticket must be strictly portrait to prevent CUPS/AirPrint rotation');
  assert.equal(c80._pbToneDone, true, '80mm ticket must set _pbToneDone=true for crisp monochrome text');
  const texts80 = c80._ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(texts80.includes('1234 5678'), '80mm ticket must draw formatted 8-digit code');
  assert.ok(texts80.some((t) => t.includes('₱100')), '80mm ticket must draw price');
  assert.ok(texts80.some((t) => t.includes('THERMAL STRIP ONLY')), '80mm ticket must draw option badge');

  const c58 = sb.buildThermalVoucherCanvas(sampleData, '12345678', { dotW: 384, showCutLine: true });
  assert.equal(c58.width, 384);
  assert.ok(c58.height > c58.width, '58mm single ticket must be strictly portrait');
  assert.equal(c58._pbToneDone, true);
  const texts58 = c58._ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(texts58.includes('CUT HERE'), 'showCutLine=true must draw CUT HERE divider');
}

// Test B: Continuous strip packing stays safely below 210mm so Windows -FitWidth never shrinks
{
  const { sb } = makeSandbox();
  const pages80 = sb.buildThermalVoucherStripPages(sampleData, sampleData.codes, 576);
  assert.equal(pages80.length, 3, '5 tickets at 2/page on 80mm -> 3 pages');
  pages80.forEach((p) => {
    const hMm = p.canvas.height / 203 * 25.4;
    assert.ok(hMm < 180, '80mm strip page height (' + hMm.toFixed(1) + 'mm) must stay well under 210mm');
  });
  const pages58 = sb.buildThermalVoucherStripPages(sampleData, sampleData.codes, 384);
  assert.equal(pages58.length, 2, '5 tickets at 3/page on 58mm -> 2 pages');
  pages58.forEach((p) => {
    const hMm = p.canvas.height / 203 * 25.4;
    assert.ok(hMm < 180, '58mm strip page height (' + hMm.toFixed(1) + 'mm) must stay well under 210mm');
  });
}

// Test C: Printer discovery prioritizes Bluetooth, USB/Wi-Fi raw, and thermal Print Helper printers
{
  const { sb } = makeSandbox({
    isBtThermalAvailable: () => true,
    btThermalOn: true,
    wifiNetAvailable: () => true,
    wifiList: () => ({ printers: [{ name: 'XP-80C USB', ip: 'usb://1', usb: true, raw: true, ipp: false }, { name: 'Epson L8050', ip: '192.168.1.9', ipp: true, raw: false }] }),
    helperOn: true,
    helper: { ok: true, printers: ['Epson L8050', 'Microsoft Print to PDF', 'Xprinter XP-58IIH'] },
    window: {
      _btThermal: {
        btPrinter: { connected: true, name: 'VOZY G80', _paperWidth: 576, canReconnect: () => true },
        isKnown58mmPrinter: (n) => /58|p50/i.test(String(n || ''))
      }
    }
  });
  const targets = sb.voucherThermalTargets();
  assert.equal(targets[0].kind, 'bt');
  assert.equal(targets[1].kind, 'raw');
  assert.equal(targets[1].name, 'XP-80C USB');
  assert.equal(targets[2].kind, 'helper');
  assert.equal(targets[2].name, 'Xprinter XP-58IIH', 'thermal-named helper printer must sort ahead of photo/PDF printers');
  assert.equal(targets[2].is58, true, 'XP-58IIH must be detected as 58mm');
  assert.equal(targets[targets.length - 1].kind, 'browser');
}

// Test D: Bluetooth printing — cutEach vs continuous + mid-batch stop + printed tracking
{
  const { sb, calls } = makeSandbox({ isBtThermalAvailable: () => true });
  const target = { id: 'bt', kind: 'bt', name: 'XP-80C' };
  const r1 = await sb.printThermalVouchers(sampleData, ['11112222', '33334444', '55556666'], { format: 'thermal80', cutEach: true, target });
  assert.deepEqual(Array.from(r1.printed), ['11112222', '33334444', '55556666']);
  assert.equal(calls.bt.length, 3);
  assert.ok(calls.bt.every((c) => c.rollW === '80mm' && c.opts.cut === true && c.opts.brightness === 0));

  calls.bt.length = 0;
  const r2 = await sb.printThermalVouchers(sampleData, ['11112222', '33334444', '55556666'], { format: 'thermal58', cutEach: false, target });
  assert.equal(r2.stopped, false);
  assert.equal(calls.bt.length, 3);
  assert.equal(calls.bt[0].opts.cut, false, 'continuous mode must not cut after ticket 1');
  assert.equal(calls.bt[1].opts.cut, false, 'continuous mode must not cut after ticket 2');
  assert.equal(calls.bt[2].opts.cut, true, 'continuous mode must cut/feed after last ticket');
  assert.ok(calls.bt.every((c) => c.rollW === '58mm'));

  // Cancel after 1 ticket
  calls.bt.length = 0;
  sb.vPrintClearPrinted(['90000001', '90000002', '90000003']);
  let sent = 0;
  const rStop = await sb.printThermalVouchers(sampleData, ['90000001', '90000002', '90000003'], { format: 'thermal80', cutEach: true, target }, (n) => { sent = n; }, () => sent >= 1);
  assert.equal(rStop.stopped, true);
  assert.deepEqual(Array.from(rStop.printed), ['90000001']);
  const done = sb.vPrintDoneSet();
  assert.equal(done.has('90000001'), true, 'printed ticket must be recorded');
  assert.equal(done.has('90000002'), false, 'cancelled tickets must not be marked printed');
}

// Test E: USB/Wi-Fi raw ESC/POS & Print Helper & Android dialog & Browser fallback
{
  const { sb, calls, store } = makeSandbox();
  // Raw USB/Wi-Fi continuous mode
  const rawTarget = { id: 'raw:XP-80C', kind: 'raw', name: 'XP-80C', printerObj: { name: 'XP-80C', ip: 'usb://1', raw: true, usb: true } };
  await sb.printThermalVouchers(sampleData, ['10000001', '10000002'], { format: 'thermal80', cutEach: false, target: rawTarget });
  assert.equal(calls.wifi.length, 2);
  assert.equal(calls.wifi[0].wo.noCut, true);
  assert.equal(calls.wifi[1].wo.noCut, false);
  assert.equal(calls.wifi[0].paper.receipt, true);

  // Print Helper cut-each vs continuous
  const helperTarget = { id: 'helper:POS-80', kind: 'helper', name: 'POS-80' };
  await sb.printThermalVouchers(sampleData, ['20000001', '20000002'], { format: 'thermal80', cutEach: true, target: helperTarget });
  assert.equal(calls.helper.length, 2, 'cutEach must send 1 job per voucher for driver auto-cut');
  assert.equal(calls.helper[0].paper.receipt, true);
  assert.equal(calls.helper[0].opt.sizeKey, 'receipt80');

  calls.helper.length = 0;
  await sb.printThermalVouchers(sampleData, ['20000001', '20000002', '20000003'], { format: 'thermal80', cutEach: false, target: helperTarget });
  assert.equal(calls.helper.length, 2, 'continuous 80mm packs 2 + 1 tickets into 2 safe-height jobs');

  // Browser fallback
  const browserTarget = { id: 'browser', kind: 'browser', name: 'Browser print' };
  await sb.printThermalVouchers(sampleData, ['30000001', '30000002'], { format: 'thermal58', cutEach: false, target: browserTarget });
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].url, '/pay/tickets.html');
  const saved = JSON.parse(store.get('pb_ticket_print'));
  assert.equal(saved.format, 'thermal58');
  assert.equal(saved.cutEach, false);
  assert.equal(saved.autoPrint, true);
  assert.deepEqual(saved.codes, ['30000001', '30000002']);
}

// Test F: Native Android / iPad __PBPrint fallback
{
  const dlgCalls = [];
  const { sb } = makeSandbox({
    window: {
      _btThermal: { btPrinter: {} },
      __PBPrint: {
        print(title, w, h, pagesJson) {
          dlgCalls.push({ title, w, h, pages: JSON.parse(pagesJson) });
          return JSON.stringify({ ok: true });
        }
      },
      open: () => ({})
    }
  });
  await sb.printThermalVouchers(sampleData, ['40000001', '40000002'], {
    format: 'thermal80', cutEach: true, target: { id: 'dialog', kind: 'dialog', name: 'Android print dialog' }
  });
  assert.equal(dlgCalls.length, 1);
  assert.equal(dlgCalls[0].w, 72);
  assert.ok(dlgCalls[0].h > dlgCalls[0].w, 'dialog page must be portrait');
  assert.equal(dlgCalls[0].pages.length, 2);
}

console.log('OK: all thermal voucher printing tests passed (80mm/58mm canvas, strip packing, discovery, BT/USB-WiFi/Helper/Dialog/Browser routing, cancel & printed tracking).');
