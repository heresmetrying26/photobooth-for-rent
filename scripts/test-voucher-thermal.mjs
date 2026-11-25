// Verifies thermal voucher printing across all routes (Bluetooth, USB/Wi-Fi raw ESC/POS,
// Desktop/Web Print Helper, Android/iPad print dialog, Browser tickets.html), portrait canvas
// sizing, header vertical geometry (with/without event date, price, 1-2 lines), absence of
// "ONLY" badge on thermal tickets, strip packing height, mid-batch stop, and printed tracking.
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
assert.ok(booth.includes('eventDate: voucherEventDateStr()'), 'Print tickets handler must pass optional eventDate');
assert.ok(ticketsHtml.includes('size:80mm auto') && ticketsHtml.includes('size:58mm auto') && ticketsHtml.includes('size:A4'), 'tickets.html must support A4, 80mm and 58mm @page rules');
assert.ok(ticketsHtml.includes('rt-date') && ticketsHtml.includes('ev-date'), 'tickets.html must render optional eventDate');
assert.ok(!ticketsHtml.includes('rt-pill') && !ticketsHtml.includes('THERMAL ONLY'), 'tickets.html thermal layout must not include THERMAL ONLY pill');
assert.ok(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/.test(ticketsHtml), 'tickets.html must keep Google Fonts link compatible with desktop/scripts/prepare.mjs');
assert.ok(lifetimeHtml.includes('tier: bt.tier, label: bt.label'), 'My Events portal must pass tier & label to tickets.html');

// 2. Extract voucher thermal helper functions from generated protected/booth.html and run in VM
const startMark = "var VPRINT_DONE_KEY = 'pb_vprint_done';";
const endMark = '// ---- Android-compatible A4 ticket sheet printer ----';
const sIdx = booth.indexOf(startMark);
const eIdx = booth.indexOf(endMark);
assert.ok(sIdx > 0 && eIdx > sIdx, 'could not locate thermal voucher section in protected/booth.html');

const fnBlock1 = booth.slice(sIdx, booth.indexOf('function fmtShortDate(t)', sIdx));
const fnBlock2 = booth.slice(booth.indexOf('// ---- Voucher ticket helpers (Thermal 80mm / 58mm + A4 sheet) ----'), eIdx);

function makeFakeCanvas() {
  const ops = [];
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    fillRect(...a) { ops.push(['fillRect', ...a]); },
    strokeRect(...a) { ops.push(['strokeRect', ...a]); },
    fillText(t, x, y) { ops.push(['fillText', String(t), x, y, this.font]); },
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
    dateOn: false,
    dateInput: { value: '' },
    currentDateLabel: () => '',
    payCfg: { dual: true, options: [{ label: 'Thermal Strip', tier: 'receipt', price: 80, prints: 2 }] },
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
  eventDate: 'Nov 25, 2026',
  price: 100,
  prints: 1,
  tier: 'receipt',
  label: 'Thermal Strip',
  codes: ['12345678', '23456789', '34567890', '45678901', '56789012']
};

// Test A: Thermal voucher canvas — NO "ONLY" pill, optional eventDate, strictly portrait, pure B&W
{
  const { sb } = makeSandbox();
  const c80 = sb.buildThermalVoucherCanvas(sampleData, '12345678', { dotW: 576, showCutLine: false });
  assert.equal(c80.width, 576);
  assert.ok(c80.height > c80.width, '80mm single ticket must be strictly portrait to prevent CUPS/AirPrint rotation');
  assert.equal(c80._pbToneDone, true, '80mm ticket must set _pbToneDone=true for crisp monochrome text');
  const texts80 = c80._ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(texts80.includes('1234 5678'), '80mm ticket must draw formatted 8-digit code');
  assert.ok(texts80.includes('Nov 25, 2026'), '80mm ticket must draw eventDate when provided');
  assert.ok(texts80.some((t) => t.includes('₱100')), '80mm ticket must draw price');
  assert.ok(!texts80.some((t) => /\bONLY\b/i.test(t)), 'thermal ticket must NOT contain THERMAL/COLOR ONLY badge');

  // Without eventDate: must not draw any date line
  const noDate = sb.buildThermalVoucherCanvas({ ...sampleData, eventDate: '' }, '12345678', { dotW: 576, showCutLine: false });
  const noDateTexts = noDate._ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(!noDateTexts.includes('Nov 25, 2026'), 'ticket must omit eventDate when not set');

  const c58 = sb.buildThermalVoucherCanvas(sampleData, '12345678', { dotW: 384, showCutLine: true });
  assert.equal(c58.width, 384);
  assert.ok(c58.height > c58.width, '58mm single ticket must be strictly portrait');
  assert.equal(c58._pbToneDone, true);
  const texts58 = c58._ops.filter((o) => o[0] === 'fillText').map((o) => o[1]);
  assert.ok(texts58.includes('Nov 25, 2026'), '58mm ticket must draw eventDate when provided');
  assert.ok(texts58.includes('CUT HERE'), 'showCutLine=true must draw CUT HERE divider');
  assert.ok(!texts58.some((t) => /\bONLY\b/i.test(t)), '58mm ticket must NOT contain ONLY badge');
}

// Test A2: Exhaustive vertical geometry check across all 8 header combinations on both 80mm and 58mm
{
  const { sb } = makeSandbox();
  for (const dotW of [576, 384]) {
    const is58 = dotW === 384;
    const dividerBottom = (is58 ? 10 + 38 : 14 + 54) + 2;
    const boxTop = (is58 ? 10 + 154 : 14 + 226) - (is58 ? 2 : 2.5);
    for (const ev of ['My Event', 'Ana & Marco Grand Garden Wedding Celebration 2026']) {
      for (const eventDate of ['', 'Nov 25, 2026']) {
        for (const price of [0, 150]) {
          const cv = sb.buildThermalVoucherCanvas({ ...sampleData, event: ev, eventDate, price }, '12345678', { dotW, showCutLine: false });
          const headerTexts = cv._ops.filter((o) => o[0] === 'fillText' && o[1] !== 'PHOTOBOOTH4U · VOUCHER' && o[2] === dotW / 2 && o[3] < boxTop + 10);
          assert.ok(headerTexts.length >= 1, 'header must draw at least event name');
          let prevY = dividerBottom;
          for (const item of headerTexts) {
            const y = item[3];
            assert.ok(y > prevY + 8, `header overlap on ${dotW}px (${ev}/${eventDate}/${price}): ${item[1]} at y=${y} vs prev=${prevY}`);
            assert.ok(y <= boxTop - 2, `header collided with code box on ${dotW}px (${ev}/${eventDate}/${price}): ${item[1]} at y=${y} vs boxTop=${boxTop}`);
            prevY = y;
          }
        }
      }
    }
  }
}

// Test A3: voucherEventDateStr formatting & dual=false isolation
{
  const sOff = makeSandbox({ dateOn: false, dateInput: { value: '2026-11-25' } });
  assert.equal(sOff.sb.voucherEventDateStr(), '', 'dateOn=false must return empty string even if input has value');

  const sOn = makeSandbox({ dateOn: true, dateInput: { value: '2026-11-25' } });
  assert.equal(sOn.sb.voucherEventDateStr(), 'Nov 25, 2026', 'dateOn=true must format YYYY-MM-DD cleanly without timezone drift');

  const sSingle = makeSandbox({ payCfg: { dual: false, options: [{ label: 'Leftover Option', tier: 'all', prints: 0 }] } });
  const meta = sSingle.sb.voucherTicketMeta({ label: '1 photo session', tier: 'all', prints: 2 });
  assert.equal(meta.incStr, '1 photo session · 2 prints', 'dual=false must ignore leftover payCfg.options');
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

// Test C: Printer discovery & PH thermal model detection
{
  const { sb } = makeSandbox({
    isBtThermalAvailable: () => true,
    btThermalOn: true,
    wifiNetAvailable: () => true,
    wifiList: () => ({ printers: [{ name: 'XP-80C USB', ip: 'usb://1', usb: true, raw: true, ipp: false }, { name: 'Epson L8050', ip: '192.168.1.9', ipp: true, raw: false }] }),
    helperOn: true,
    helper: { ok: true, printers: ['Epson L8050', 'Microsoft Print to PDF', 'Xprinter XP-58IIH', 'ZJ-80 Thermal', 'Rongta RP80'] },
    window: {
      _btThermal: {
        btPrinter: { connected: true, name: 'VOZY G80', _paperWidth: 576, canReconnect: () => true },
        isKnown58mmPrinter: (n) => /58|p50/i.test(String(n || ''))
      }
    }
  });
  for (const nm of ['XP-80C', 'XP-58IIH', 'ZJ-58', 'ZJ-80', 'Gprinter GP-80', 'Rongta RP80', 'VOZY G80', 'VOZY P50', 'EPSON TM-T82X', 'POS-58', 'POS80', 'ArcticBreeze']) {
    assert.equal(sb.isThermalPrinterName(nm), true, nm + ' must be recognized as a thermal printer');
  }
  assert.equal(sb.isThermalPrinterName('Epson L8050'), false);
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

// Test E: USB/Wi-Fi raw ESC/POS & Print Helper & Browser fallback (with eventDate forwarded)
{
  const { sb, calls, store } = makeSandbox();
  const rawTarget = { id: 'raw:XP-80C', kind: 'raw', name: 'XP-80C', printerObj: { name: 'XP-80C', ip: 'usb://1', raw: true, usb: true } };
  await sb.printThermalVouchers(sampleData, ['10000001', '10000002'], { format: 'thermal80', cutEach: false, target: rawTarget });
  assert.equal(calls.wifi.length, 2);
  assert.equal(calls.wifi[0].wo.noCut, true);
  assert.equal(calls.wifi[1].wo.noCut, false);
  assert.equal(calls.wifi[0].paper.receipt, true);

  const helperTarget = { id: 'helper:POS-80', kind: 'helper', name: 'POS-80' };
  await sb.printThermalVouchers(sampleData, ['20000001', '20000002'], { format: 'thermal80', cutEach: true, target: helperTarget });
  assert.equal(calls.helper.length, 2, 'cutEach must send 1 job per voucher for driver auto-cut');
  assert.equal(calls.helper[0].paper.receipt, true);
  assert.equal(calls.helper[0].opt.sizeKey, 'receipt80');

  calls.helper.length = 0;
  await sb.printThermalVouchers(sampleData, ['20000001', '20000002', '20000003'], { format: 'thermal80', cutEach: false, target: helperTarget });
  assert.equal(calls.helper.length, 2, 'continuous 80mm packs 2 + 1 tickets into 2 safe-height jobs');

  const browserTarget = { id: 'browser', kind: 'browser', name: 'Browser print' };
  await sb.printThermalVouchers(sampleData, ['30000001', '30000002'], { format: 'thermal58', cutEach: false, target: browserTarget });
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].url, '/pay/tickets.html');
  const saved = JSON.parse(store.get('pb_ticket_print'));
  assert.equal(saved.format, 'thermal58');
  assert.equal(saved.cutEach, false);
  assert.equal(saved.autoPrint, true);
  assert.equal(saved.eventDate, 'Nov 25, 2026');
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

console.log('OK: all thermal voucher triple-check tests passed (clean layout without ONLY badge, optional eventDate, 8-combo geometry check, strip packing, discovery, all 5 routes, cancel & printed tracking).');
