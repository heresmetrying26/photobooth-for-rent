// End-to-end unit & behaviour tests for the 5 client-reported printer & Photoman fixes:
//   1. Photoman Canon SELPHY print sharpness (stepped decode, pbPrintOutputSharpen, lossless local PNG)
//   2. Photoman copies selector + eliminating all double/excess printouts
//   3. macOS + Epson L805 USB cable driverless ESC/P-R detection/printing + installedAs L805 vs L8050 fix
//   4. Popped-out Photoman live printer sync with main booth setup
//   5. Epson L8050 4R IPP freeze/0x507 busy guards (also covered in scripts/test-epson-l8050.mjs)
//
// Run: node desktop/test/test-client-printer-photoman-fixes.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  EPSON_VENDOR_ID,
  EPSON_ESCPR_MEDIA,
  isEpsonEscprUsb,
  epsonEscprModelName,
  epsonBorderlessPaper,
  packBitsRow,
  encodeEscprJob,
  makeEscprJobBuilder
} from '../lib/escprusb.mjs';
import { setUsbBackend, probeUsbPrinters, usbEscprPrint, pickUsbRawInterface } from '../lib/usbipp.mjs';
import { initHelper, _helperTest } from '../lib/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const html = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
const photoQualitySrc = readFileSync(join(ROOT, 'protected', 'src', 'camera', 'photo-quality.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e));
    process.exitCode = 1;
  }
}

function extractFunction(src, signaturePrefix) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.includes(signaturePrefix));
  assert.ok(start >= 0, 'Found ' + signaturePrefix);
  const indent = lines[start].match(/^(\s*)/)[1];
  let end = start;
  while (end < lines.length && !(end > start && lines[end].startsWith(indent + '}'))) end++;
  assert.ok(end < lines.length, 'Found closing brace for ' + signaturePrefix);
  return lines.slice(start, end + 1).join('\n');
}

// ── 1. Photoman Canon SELPHY print sharpness ─────────────────────────────────
await test('Concern 1: pbSteppedDecodeBitmap performs multi-step halving downscale and releases intermediate canvases', () => {
  const fnSrc = extractFunction(html, 'function pbSteppedDecodeBitmap(');
  const created = [];
  const released = [];
  const draws = [];
  const sb = {
    Math,
    document: {
      createElement: () => {
        const cv = {
          width: 0,
          height: 0,
          getContext: () => ({
            imageSmoothingEnabled: false,
            imageSmoothingQuality: '',
            drawImage: (src, ...args) => draws.push({ to: cv, src, args })
          })
        };
        created.push(cv);
        return cv;
      }
    },
    pbReleaseCanvas: (cv) => released.push(cv)
  };
  vm.createContext(sb);
  vm.runInContext(fnSrc, sb);

  // 6000x4000 -> maxSide 2400 => target 2400x1600 (2.5x shrink => 1 intermediate 3000x2000 step + final 2400x1600)
  const bmp = { width: 6000, height: 4000 };
  const out = sb.pbSteppedDecodeBitmap(bmp, 2400);
  assert.equal(out.width, 2400);
  assert.equal(out.height, 1600);
  assert.equal(created.length, 2, '1 intermediate halving step + 1 final output canvas');
  assert.equal(created[0].width, 3000);
  assert.equal(created[0].height, 2000);
  assert.equal(released.length, 1, 'intermediate canvas released');
  assert.equal(released[0], created[0]);
  assert.equal(draws.length, 2);
});

await test('Concern 1: pbPrintOutputSharpen sharpens Photoman & SELPHY pages, skips already-sharpened DSLR pages and receipts', () => {
  const sharpenSrc = extractFunction(photoQualitySrc, 'function pbSharpenPage(');
  const targetSrc = extractFunction(html, 'function activePrintTargetName(');
  const outSharpSrc = extractFunction(html, 'function pbPrintOutputSharpen(');
  const isSelphySrc = extractFunction(html, 'function isSelphyName(');

  const makeEdgeCanvas = (w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x < w / 2 ? 100 : 150;
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const cv = {
      width: w,
      height: h,
      _data: data,
      getContext: () => ({
        getImageData: () => ({ data }),
        putImageData: () => { }
      })
    };
    return cv;
  };

  let curPrinter = 'Canon SELPHY CP1500';
  let curSize = 'selphy';
  let pmActive = true;
  const sb = {
    Math, String, Number, Float32Array, Uint8ClampedArray,
    printSize: curSize,
    isPhotomanSave: () => pmActive,
    isReceiptPaper: (k) => /receipt/i.test(String(k || '')),
    printerFor: () => curPrinter,
    forcedPrinterName: () => '',
    tabletPrinterName: () => ''
  };
  vm.createContext(sb);
  vm.runInContext([sharpenSrc, isSelphySrc, targetSrc, outSharpSrc].join('\n'), sb);

  // Photoman + Canon SELPHY: sharpens edge contrast and sets _pbSharp
  const c1 = makeEdgeCanvas(960, 960);
  sb.pbPrintOutputSharpen(c1);
  assert.equal(c1._pbSharp, true);
  assert.ok(c1._data[(480 * 960 + 479) * 4] < 100, 'dark edge side darkened by sharpen');
  assert.ok(c1._data[(480 * 960 + 480) * 4] > 150, 'bright edge side brightened by sharpen');

  // Photobooth DSLR already sharpened by camQPrintSharpen (_pbSharp=true): untouched
  const c2 = makeEdgeCanvas(960, 960);
  c2._pbSharp = true;
  sb.pbPrintOutputSharpen(c2);
  assert.equal(c2._data[(480 * 960 + 479) * 4], 100, 'already-sharpened DSLR page not double-sharpened');
  assert.equal(c2._data[(480 * 960 + 480) * 4], 150);

  // Receipt paper: untouched
  sb.printSize = 'receipt80';
  const c3 = makeEdgeCanvas(960, 960);
  sb.pbPrintOutputSharpen(c3);
  assert.equal(c3._pbSharp, undefined, 'receipt page skipped');
  assert.equal(c3._data[(480 * 960 + 479) * 4], 100);

  // Local SELPHY lossless PNG wiring present in printViaHelper
  assert.ok(/const selphyLossless = !lanStationActive\(\) && !paper\.receipt && typeof isSelphyName === 'function' && isSelphyName\(name\);/.test(html), 'printViaHelper enables lossless PNG for local Canon SELPHY');
  assert.ok(/\(paper\.receipt \|\| selphyLossless\) \? c\.toDataURL\('image\/png'\)/.test(html), 'printViaHelper encodes local SELPHY pages as PNG');
});

// ── 2. Photoman copies selector & duplicate-print prevention ─────────────────
await test('Concern 2: Photoman copies UI, atomic deskPrintBusy lock, and Show-on-Booth noAutoPrint guard', async () => {
  assert.ok(/id="deskResCopiesMinus"/.test(html) && /id="deskResCopiesVal"/.test(html) && /id="deskResCopiesPlus"/.test(html), 'Copies stepper HTML present in #deskResCard');
  assert.ok(/id="deskResPrinter"/.test(html), 'Active printer badge HTML present in #deskResCard');
  assert.ok(/if \(!opts\.noAutoPrint\) maybeAutoPrint\(\);/.test(html), 'startDeskResult honours opts.noAutoPrint');
  assert.ok(/type: 'show-on-booth'[\s\S]{0,160}noAutoPrint: true/.test(html), 'popped-out Show on Booth sets noAutoPrint: true');
  assert.ok(/var noAuto = m\.noAutoPrint !== false;/.test(html), 'show-on-booth receiver defaults noAutoPrint to true');
  assert.ok(/if \(dCtx && typeof deskPrintCtx === 'function'\) \{\s*deskLastManualPrintAt = 0;\s*deskPrintCtx\(dCtx, ppv\.auto, ppv\.copies\);/.test(html), 'Print Preview confirm routes Photoman prints through deskPrintCtx lock & badge counter');

  // Execute deskPrintCtx in an isolated sandbox to verify atomic concurrency lock & copy count handling
  const fnPrint = extractFunction(html, 'async function deskPrintCtx(');
  const fnMax = extractFunction(html, 'function deskMaxCopies(');
  const fnSet = extractFunction(html, 'function deskSetCopies(');

  let printCalls = [];
  let releasePrint;
  const sb = {
    Math, Number, Date, Array, Promise,
    MAX_COPIES: 10,
    deskCopies: 1,
    deskPrintBusy: false,
    deskLastManualPrintAt: 0,
    printing: false,
    DESK_STANDALONE: false,
    printSize: '4x6',
    printPrefs: { copies: 4 }, // main booth has 4 copies, Photoman manual Print must use deskCopies!
    deskLast: { live: true, sessionNumber: 7, printing: false, printedCopies: 0 },
    maxCopies: () => 5,
    printSettings: () => ['4x6'],
    sizeFitsLayout: () => true,
    showToast: () => { },
    deskRenderResultCard: () => { },
    deskRemoteMark: () => { },
    deskWithPrintLock: async (fn) => await fn(),
    deskRunWithBoothCtx: async (_ctx, fn) => await fn(),
    printCurrentPhoto: (isAuto, copies) => new Promise((res) => {
      printCalls.push({ isAuto, copies });
      releasePrint = () => res(true);
    })
  };
  vm.createContext(sb);
  vm.runInContext([fnMax, fnSet, fnPrint].join('\n'), sb);

  // Stepper sets 3 copies (clamped to maxCopies=5)
  sb.deskSetCopies(3);
  assert.equal(sb.deskCopies, 3);
  sb.deskSetCopies(99);
  assert.equal(sb.deskCopies, 5, 'clamped to session maxCopies');
  sb.deskSetCopies(2);

  const ctx = { sessionNum: 7, printedCopies: 0 };
  const p1 = sb.deskPrintCtx(ctx, false);
  // Concurrent second tap while first print is in flight MUST be rejected synchronously!
  const p2 = await sb.deskPrintCtx(ctx, false);
  assert.equal(p2, false, 'concurrent second click blocked while first print is busy');
  assert.equal(printCalls.length, 1, 'only 1 print job sent');
  assert.deepEqual(printCalls[0], { isAuto: false, copies: 2 }, 'uses Photoman deskCopies (2), NOT hidden main booth printPrefs.copies (4)');

  releasePrint();
  assert.equal(await p1, true);
  assert.equal(ctx.printedCopies, 2);
  assert.equal(sb.deskLast.printedCopies, 2);

  // Immediate double-tap within 1.5s debounce is also blocked
  const p3 = await sb.deskPrintCtx(ctx, false);
  assert.equal(p3, false, 'rapid post-finish double-tap within 1.5s debounced');
  assert.equal(printCalls.length, 1);
});

// ── 3. macOS + Epson L805 USB cable driverless detection & printing ──────────
await test('Concern 3: escprusb.mjs classifies Epson L805 / L8050 vs L120 / TM thermal and encodes valid ESC/P-R stream', () => {
  const l805Id = 'MFG:EPSON;CMD:ESCPL2,BDC,D4,D4PX,ESCPR1,END4;MDL:L805 Series;CLS:PRINTER;DES:EPSON L805 Series;';
  assert.equal(isEpsonEscprUsb(EPSON_VENDOR_ID, 0x08d1, 'EPSON L805 Series', l805Id), true);
  assert.equal(epsonEscprModelName(EPSON_VENDOR_ID, 0x08d1, 'EPSON L805 Series', l805Id), 'L805');
  assert.equal(isEpsonEscprUsb(EPSON_VENDOR_ID, 0x08d1, 'EPSON L805 Series', ''), true, 'matches L805 by name when deviceId unavailable');
  assert.equal(isEpsonEscprUsb(EPSON_VENDOR_ID, 0x0866, 'EPSON L8050 Series', ''), true);
  assert.equal(epsonEscprModelName(EPSON_VENDOR_ID, 0x0866, 'EPSON L8050 Series', ''), 'L8050');
  assert.equal(isEpsonEscprUsb(EPSON_VENDOR_ID, 0x005e, 'EPSON L120 Series', 'MFG:EPSON;CMD:ESCPL2,BDC;MDL:L120 Series;'), false, 'excludes ESC/P2-only L120');
  assert.equal(isEpsonEscprUsb(EPSON_VENDOR_ID, 0x0202, 'EPSON TM-T88V', ''), false, 'excludes thermal POS TM-T88V');
  assert.equal(isEpsonEscprUsb(0x04a9, 0x32c0, 'Canon SELPHY CP1500', ''), false, 'excludes non-Epson VID');

  // Verify PackBits RLE shrinks solid runs
  const solid = Buffer.alloc(30, 0x42);
  const packed = packBitsRow(solid, 3);
  assert.ok(packed && packed.length < solid.length, 'PackBits compresses repeated RGB pixels');

  // Encode a 4x6 borderless L805 job from a tiny BGRA buffer (fast test)
  const w = 8, h = 12;
  const bgra = Buffer.alloc(w * h * 4, 255);
  // Put a colored pixel at (0,0) -> BGR=(10, 20, 30, 255)
  bgra[0] = 10; bgra[1] = 20; bgra[2] = 30; bgra[3] = 255;

  const l805Job = encodeEscprJob({ bgra, width: w, height: h, widthMm: 101.6, heightMm: 152.4, borderless: true, isL8050: false });
  assert.equal(l805Job.media, EPSON_ESCPR_MEDIA.PREMIUM_GLOSSY, 'L805 borderless uses Premium Glossy (0x0B)');
  assert.equal(l805Job.geo.paperW, 1440);
  assert.equal(l805Job.geo.paperH, 2160);
  assert.equal(l805Job.geo.areaW, 1512);
  assert.equal(l805Job.geo.areaH, 2272);
  assert.equal(l805Job.geo.marginLeft, -36);
  assert.equal(l805Job.geo.marginTop, -42);
  const latin = l805Job.data.toString('latin1');
  assert.ok(latin.includes('@EJL 1284.4'), 'contains EJL header');
  assert.ok(latin.includes('REMOTE1') && latin.includes('ESCPRLib'), 'contains REMOTE1/ESCPRLib');
  const setqPos = l805Job.data.indexOf('setq', 0, 'latin1');
  assert.ok(setqPos > 0, 'contains setq');
  assert.equal(l805Job.data[setqPos + 4], EPSON_ESCPR_MEDIA.PREMIUM_GLOSSY);
  assert.equal(l805Job.data[setqPos + 10], 0x00, 'setq colorPlane byte 6 MUST be 0x00 (24-bit RGB dsnd)');
  assert.ok(latin.includes('seti') && latin.includes('chku'), 'emits L805 borderless seti+chku handshake');
  assert.ok(latin.includes('setj') && latin.includes('sttp') && latin.includes('setn') && latin.includes('dsnd'), 'emits setj/sttp/setn/dsnd');
  assert.ok(latin.includes('endp') && latin.includes('endj'), 'emits endp/endj trailer');

  // L8050 uses L8050 borderless geometry (38/11 -> 1516x2200) and media 0x34
  const l8050Job = encodeEscprJob({ bgra, width: w, height: h, widthMm: 101.6, heightMm: 152.4, borderless: true, isL8050: true });
  assert.equal(l8050Job.media, EPSON_ESCPR_MEDIA.EPSON_GLOSSY);
  assert.equal(l8050Job.geo.areaW, 1516);
  assert.equal(l8050Job.geo.areaH, 2200);
  assert.equal(l8050Job.geo.marginLeft, -38);
  assert.equal(l8050Job.geo.marginTop, -11);

  // pickUsbRawInterface prefers bidirectional 7/1/2 with bulk IN+OUT over unidirectional 7/1/1 alt setting
  const pickedRaw = pickUsbRawInterface([
    { num: 0, alt: 0, cls: 7, sub: 1, proto: 1, hasBulkPair: false },
    { num: 0, alt: 1, cls: 7, sub: 1, proto: 2, hasBulkPair: true }
  ]);
  assert.equal(pickedRaw.proto, 2);
  assert.equal(pickedRaw.alt, 1);

  assert.ok(epsonBorderlessPaper(101.6, 152.4), '4x6 is in borderless table');
  assert.equal(epsonBorderlessPaper(50.8, 152.4), null, '2x6 is not in borderless table');
});

await test('Concern 3: installedAs no longer confuses Epson L805 with EPSON_L8050_Series and registers L805 as usb-escpr', async () => {
  const { installedAs, refreshUsbDirect, directTarget, usbDirect } = _helperTest;

  // Regression check: having EPSON_L8050_Series installed MUST NOT hide a plugged-in Epson L805!
  const installedL8050 = [{ name: 'EPSON_L8050_Series', port: 'dnssd://EPSON%20L8050', host: '' }];
  assert.equal(installedAs({ ip: '', name: 'EPSON L805 Series' }, installedL8050), '', 'L805 does NOT collide with EPSON_L8050_Series');
  assert.equal(installedAs({ ip: '', name: 'EPSON L8050 Series' }, installedL8050), 'EPSON_L8050_Series', 'L8050 still matches EPSON_L8050_Series');

  const installedL805 = [{ name: 'EPSON_L805_Series_2164', port: 'usb://EPSON/L805', host: '' }];
  assert.equal(installedAs({ ip: '', name: 'EPSON L805 Series' }, installedL805), 'EPSON_L805_Series_2164', 'L805 matches EPSON_L805_Series_2164');

  // Mock a macOS USB Epson L805 exposing only 7/1/2 (no IPP-over-USB 7/1/4)
  const written = [];
  const l805IdStr = 'MFG:EPSON;CMD:ESCPL2,BDC,D4,D4PX,ESCPR1,END4;MDL:L805 Series;CLS:PRINTER;';
  const idBuf = Buffer.concat([Buffer.from([0x00, l805IdStr.length + 2]), Buffer.from(l805IdStr, 'latin1')]);
  const mockDev = {
    busNumber: 1,
    deviceAddress: 9,
    deviceDescriptor: { idVendor: EPSON_VENDOR_ID, idProduct: 0x08d1, iProduct: 1, iManufacturer: 2 },
    configDescriptor: {
      interfaces: [[{
        bInterfaceNumber: 0,
        bAlternateSetting: 0,
        bInterfaceClass: 7,
        bInterfaceSubClass: 1,
        bInterfaceProtocol: 2,
        endpoints: [
          { bmAttributes: 2, bEndpointAddress: 0x01 },
          { bmAttributes: 2, bEndpointAddress: 0x82 }
        ]
      }]]
    },
    open() { },
    close() { },
    getStringDescriptor(idx, cb) { cb(null, idx === 1 ? 'L805 Series' : 'EPSON'); },
    controlTransfer(_bm, _req, _val, _idx, _len, cb) { cb(null, idBuf); },
    interface() {
      return {
        isKernelDriverActive: () => false,
        claim() { },
        release(_close, cb) { cb(null); },
        endpoints: [
          { transferType: 2, direction: 'out', timeout: 0, transfer(buf, cb) { written.push(Buffer.from(buf)); cb(null); } },
          { transferType: 2, direction: 'in', timeout: 0, transfer(_len, cb) { cb(null, Buffer.alloc(0)); } }
        ]
      };
    }
  };
  setUsbBackend({ getDeviceList: () => [mockDev] });
  try {
    const probed = await probeUsbPrinters({ platform: 'darwin', force: true });
    assert.equal(probed.length, 1);
    assert.equal(probed[0].name, 'EPSON L805 Series');
    assert.equal(probed[0].isEpsonEscpr, true);
    assert.equal(probed[0].hasEscprUsb, true);
    assert.equal(probed[0].hasIppUsb, false);

    // Register escprJob builder in helper and verify refreshUsbDirect adds L805 even when L8050 is installed
    const fakeNativeImage = {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 4, height: 6 }),
        resize: () => ({ getSize: () => ({ width: 4, height: 6 }), toBitmap: () => Buffer.alloc(4 * 6 * 4, 180) }),
        toBitmap: () => Buffer.alloc(4 * 6 * 4, 180)
      })
    };
    initHelper({ workerPath: '', deferWarm: true, escprJob: makeEscprJobBuilder(fakeNativeImage) });
    await refreshUsbDirect(['EPSON_L8050_Series'], true, probed);
    const label = 'EPSON L805 Series (USB direct)';
    assert.ok(usbDirect.has(label), 'L805 registered in usbDirect even with EPSON_L8050_Series installed');
    assert.equal(directTarget(label).kind, 'usb-escpr');

    // Exercise usbEscprPrint over the mocked bulk pipe
    const payload = Buffer.from('@EJL 1284.4\nFAKE_ESCPR_STREAM', 'latin1');
    const res = await usbEscprPrint(probed[0], [payload], { settleAfterMs: 0 });
    assert.equal(res.ok, true);
    assert.equal(Buffer.concat(written).toString('latin1'), payload.toString('latin1'));
  } finally {
    setUsbBackend(null);
    initHelper({ workerPath: '', deferWarm: true, escprJob: null });
  }
});

// ── 4. Popped-out Photoman live printer sync ─────────────────────────────────
await test('Concern 4: popped-out Photoman syncs live printer switches from main booth via BroadcastChannel & localStorage', () => {
  const buildFn = extractFunction(html, 'function deskBuildPrinterSnapshot(');
  const labelFn = extractFunction(html, 'function deskActivePrinterLabel(');
  const applyFn = extractFunction(html, 'function deskApplyPrinterSnapshot(');
  const storageFn = extractFunction(html, 'function deskSyncPrinterStateFromStorage(');

  // Verify all printer savers broadcast updates to popped-out Photoman
  for (const name of ['savePrinterMap', 'saveDriverPaperMap', 'saveExtraPrinters', 'saveProfileMaps', 'printPrefsChanged', 'setAutoPrint', 'setPrintRoute', 'wifiSave', 'wifiOptsSet', 'saveLanStationCfg']) {
    const fnText = extractFunction(html, 'function ' + name + '(');
    assert.ok(fnText.includes('deskNotifyPrinterChanged'), name + ' calls deskNotifyPrinterChanged()');
  }
  assert.ok(html.includes("m.type === 'printer-sync' && DESK_STANDALONE"), 'BroadcastChannel handles printer-sync in popped-out Photoman');
  assert.ok(html.includes("window.addEventListener('storage'"), 'popped-out Photoman listens to storage events for printer changes');

  // Run snapshot -> apply -> storage sync in sandbox simulating popped-out Photoman stuck on L805 while main booth switched to L8050
  const store = new Map();
  let helperRefreshed = false;
  let syncedColorAdj = false;
  const sb = {
    Object, JSON, Array, String, Number, Boolean,
    PRINTER_MAP_KEY: 'pb_printer_map',
    DRIVER_PAPER_KEY: 'pb_driver_paper_map',
    PRINT_OPTS_MAP_KEY: 'pb_print_opts_by_printer',
    COLOR_ADJ_MAP_KEY: 'pb_color_adj_by_printer',
    COLOR_ADJ_KEY: 'pb_color_adj',
    WIFI_PRINTER_KEY: 'pb_wifi_printer',
    WIFI_SIZE_MAP_KEY: 'pb_wifi_printer_by_size',
    WIFI_OPTS_KEY: 'pb_wifi_print_opts',
    WIFI_OPTS_MAP_KEY: 'pb_wifi_print_opts_by_printer',
    HELPER_KEY: 'pb_print_helper',
    LAN_STATION_KEY: 'pb_lan_station_cfg',
    ROUTE_KEY: 'pb_print_route',
    LAPTOP_PRINT: true,
    deskApplyingRemoteSetup: false,
    printerMap: { '4x6': 'EPSON_L805_Series_2164' },
    driverPaperMap: {},
    printOptsMap: {},
    colorAdjMap: {},
    colorAdj: { brightness: 0, red: 0, green: 0, blue: 0, hue: 0, sat: 0 },
    printSize: '4x6',
    soloPaper: null,
    printPrefs: { auto: false, copies: 1, borderless: false },
    autoPrint: false,
    helperOn: true,
    helperToggle: { checked: true },
    helper: { ok: true, printers: ['EPSON_L805_Series_2164'] },
    printRoute: 'here',
    wifiPrinter: null,
    wifiDefault: null,
    wifiSizeMap: {},
    wifiOptsShared: { color: '', quality: '', media: '' },
    wifiOptsMap: {},
    lanStationCfg: { enabled: false },
    colorAdjKeyNow: 'EPSON_L805_Series_2164',
    window: { _colorAdj: null, _syncColorAdjToPrinter: () => { syncedColorAdj = true; } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    zeroAdj: () => ({ brightness: 0, red: 0, green: 0, blue: 0, hue: 0, sat: 0 }),
    cleanPrintPrefs: (p) => Object.assign({ auto: false, copies: 1, borderless: false }, p || {}),
    lanStationActive: () => false,
    lanStationQueueNoPrinter: () => false,
    useStation: () => false,
    loadLanStationCfg: () => ({ enabled: false }),
    paperFor: (k) => (k === '4x6' ? { name: '4×6' } : null),
    printerFor: (k) => sb.printerMap[k] || '',
    activePrintTargetName: (k) => sb.printerMap[k] || '',
    wifiSyncForSize: () => { },
    refreshPrintUI: () => { },
    refreshPrintSummary: () => { },
    deskUpdatePrinterBadge: () => { },
    deskRenderResultCard: () => { },
    checkHelper: async () => { helperRefreshed = true; return { ok: true }; }
  };
  vm.createContext(sb);
  vm.runInContext([buildFn, labelFn, applyFn, storageFn].join('\n'), sb);

  assert.equal(sb.deskActivePrinterLabel().text, 'EPSON_L805_Series_2164 · 4×6');

  // 1. Live BroadcastChannel push from main booth switches to L8050
  sb.deskApplyPrinterSnapshot({
    printerMap: { '4x6': 'EPSON_L8050_Series' },
    printSize: '4x6',
    autoPrint: true,
    printPrefs: { auto: true, copies: 1, borderless: true }
  });
  assert.equal(sb.printerMap['4x6'], 'EPSON_L8050_Series');
  assert.equal(sb.autoPrint, true);
  assert.equal(sb.colorAdjKeyNow, null, 'resets colorAdjKeyNow so printer profile reloads');
  assert.equal(syncedColorAdj, true);
  assert.equal(helperRefreshed, true, 'refreshes helper printer list when newly synced printer is not yet cached');
  assert.equal(sb.deskActivePrinterLabel().text, 'EPSON_L8050_Series · 4×6');

  // 2. Fallback localStorage sync (e.g. if BroadcastChannel was missed) picks up another printer switch
  store.set('pb_printer_map', JSON.stringify({ '4x6': 'Canon SELPHY CP1500' }));
  store.set('pb_print_paper', '4x6');
  sb.deskSyncPrinterStateFromStorage();
  assert.equal(sb.printerMap['4x6'], 'Canon SELPHY CP1500');
  assert.equal(sb.deskActivePrinterLabel().text, 'Canon SELPHY CP1500 · 4×6');
});

console.log('\n' + passed + ' test groups passed');
