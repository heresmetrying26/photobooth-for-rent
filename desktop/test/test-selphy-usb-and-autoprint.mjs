// Run: node desktop/test/test-selphy-usb-and-autoprint.mjs
// Tests:
//  1) Canon SELPHY Neo USB encoder (desktop/lib/selphyusb.mjs)
//  2) Direct USB SELPHY probing & printing through desktop/lib/usbipp.mjs + desktop/lib/helper.mjs (mocked libusb)
//  3) Duplicate "(USB direct)" suppression when an OS queue already exists (macOS & Windows), plus SELPHY 4x6 -> Postcard paper matching
//  4) Web Auto-Print toggle visibility when Print Helper connects (protected/src/booth.src.html & protected/booth.html)
//  5) Standalone tools/print-helper/print-helper.js SELPHY single-page splitting, JPEG/PNG support, and dye-sub AirPrint guard
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELPHY_VENDOR_ID, SPEC_P, SPEC_L, SPEC_C,
  isSelphyUsb, selphyModelName, selphySpecFor,
  encodeSelphyJob, makeSelphyJobBuilder,
  selphyStatusDescription, selphyErrorDescription
} from '../lib/selphyusb.mjs';
import { setUsbBackend, probeUsbPrinters, pickUsbSelphyInterface } from '../lib/usbipp.mjs';
import { initHelper, handleHelper, stopHelper, _helperTest } from '../lib/helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ---- 1. SELPHY model recognition, paper specs, and Neo YUV444 job encoding ----
{
  assert.equal(isSelphyUsb(SELPHY_VENDOR_ID, 0x32db), true);
  assert.equal(isSelphyUsb(SELPHY_VENDOR_ID, 0x3302), true);
  assert.equal(isSelphyUsb(SELPHY_VENDOR_ID, 0x327a), true);
  assert.equal(isSelphyUsb(SELPHY_VENDOR_ID, 0x9999, 'Canon SELPHY CP1600'), true);
  assert.equal(isSelphyUsb(0x04b8, 0x3302, 'SELPHY'), false, 'non-Canon vendor never matches');
  assert.equal(selphyModelName(SELPHY_VENDOR_ID, 0x32db), 'Canon SELPHY CP1300');
  assert.equal(selphyModelName(SELPHY_VENDOR_ID, 0x3302), 'Canon SELPHY CP1500');

  assert.equal(selphySpecFor(100, 148), SPEC_P);
  assert.equal(selphySpecFor(101.6, 152.4), SPEC_P, '4x6 in maps to Postcard');
  assert.equal(selphySpecFor(89, 119), SPEC_L);
  assert.equal(selphySpecFor(54, 86), SPEC_C);
  assert.equal(selphySpecFor(100, 148, 'om_card_54x86mm'), SPEC_C, 'explicit paperName overrides dimensions');
  assert.equal(selphySpecFor(100, 148, 'L size 89×119 mm'), SPEC_L);

  assert.equal(selphyStatusDescription(0x01), 'Idle');
  assert.equal(selphyStatusDescription(0x20), 'Laminating protective coat');
  assert.equal(selphyErrorDescription(0x00), '');
  assert.match(selphyErrorDescription(0x06), /Ink cassette empty/);
  assert.match(selphyErrorDescription(0x03), /No paper cassette/);

  // Encode a small custom spec to check exact Neo header + BT.601 YUV444 planes + rotation + alpha compositing
  const tinySpec = { key: 'test', code: 0x50, cols: 2, rows: 3, wMm: 100, hMm: 148, name: 'Test' };
  // Portrait 2x3 BGRA:
  // (0,0)=red (255,0,0,255), (1,0)=white (255,255,255,255)
  // (0,1)=black (0,0,0,255), (1,1)=transparent (0,0,0,0 -> white)
  // (0,2)=blue (0,0,255,255), (1,2)=green (0,255,0,255)
  const bgra = Buffer.from([
    0, 0, 255, 255,   255, 255, 255, 255,
    0, 0, 0, 255,     0, 0, 0, 0,
    255, 0, 0, 255,   0, 255, 0, 255
  ]);
  const job = encodeSelphyJob({ bgra, width: 2, height: 3, spec: tinySpec, turn: false });
  assert.equal(job.length, 32 + 2 * 3 * 3);
  assert.equal(job[0], 0x0f);
  assert.equal(job[3], 0x40);
  assert.equal(job[14], 0x01);
  assert.equal(job[16], 0x01);
  assert.equal(job[18], 0x50);
  assert.equal(job[23], 0x00);
  assert.equal(job.readUInt32LE(24), 2);
  assert.equal(job.readUInt32LE(28), 3);

  const pxAt = (idx) => [job[32 + idx], job[32 + 6 + idx], job[32 + 12 + idx]];
  // Red: Y=(77*255+128)>>8=77, Cb=((-43*255+128)>>8)+128=85, Cr=((128*255+128)>>8)+128=255
  assert.deepEqual(pxAt(0), [77, 85, 255], 'red YUV444 matches CanonSelphyJob.kt');
  // White: (255, 128, 128)
  assert.deepEqual(pxAt(1), [255, 128, 128], 'white YUV444');
  // Black: (0, 128, 128)
  assert.deepEqual(pxAt(2), [0, 128, 128], 'black YUV444');
  // Transparent -> white: (255, 128, 128)
  assert.deepEqual(pxAt(3), [255, 128, 128], 'transparent composites onto white');

  // Landscape 3x2 turned 90 deg clockwise into portrait 2x3:
  // Source (0,0) = red -> lands at destination top-right (dx=1, dy=0) => idx=1
  const landBgra = Buffer.alloc(3 * 2 * 4, 255);
  landBgra[0] = 0; landBgra[1] = 0; landBgra[2] = 255; landBgra[3] = 255; // (0,0) = red
  const turned = encodeSelphyJob({ bgra: landBgra, width: 3, height: 2, spec: tinySpec, turn: true });
  assert.deepEqual([turned[32 + 1], turned[32 + 6 + 1], turned[32 + 12 + 1]], [77, 85, 255], 'landscape top-left rotates 90 deg CW to portrait top-right');

  // makeSelphyJobBuilder with fake nativeImage
  const fakeNative = {
    createFromBuffer(buf) {
      const s = JSON.parse(buf.toString('utf8'));
      const mk = (w, h) => ({
        isEmpty: () => !!s.empty,
        getSize: () => ({ width: w, height: h }),
        resize({ width, height }) { return mk(width, height); },
        toBitmap() {
          const b = Buffer.alloc(w * h * 4, 255);
          b[0] = 0; b[1] = 0; b[2] = 255; b[3] = 255; // (0,0) red marker
          return b;
        }
      });
      return mk(s.w, s.h);
    }
  };
  const build = makeSelphyJobBuilder(fakeNative);
  const resP = build(Buffer.from(JSON.stringify({ w: 600, h: 400 })), 101.6, 152.4);
  assert.equal(resP.spec, SPEC_P);
  assert.equal(resP.data.length, 32 + SPEC_P.cols * SPEC_P.rows * 3);
  assert.equal(resP.data[18], 0x50);
  assert.equal(resP.data.readUInt32LE(24), 1248);
  assert.equal(resP.data.readUInt32LE(28), 1872);
  // Landscape source turned CW -> (0,0) red marker is at top-right (dx = 1247, dy = 0)
  assert.equal(resP.data[32 + 1247], 77);
  console.log('✓ Passed: Canon SELPHY Neo USB header, YUV444 planes, rotation, and paper specs match CanonSelphyJob.kt');
}

// ---- 2. Mocked libusb Canon SELPHY CP1300 (7/1/2 only) through helper.mjs ----
{
  function makeSelphyMock({ vid = 0x04a9, pid = 0x32db, product = 'SELPHY CP1300', statusSeq = null, withIpp = false } = {}) {
    const alts = [
      { bInterfaceNumber: 0, bAlternateSetting: 0, bInterfaceClass: 7, bInterfaceSubClass: 1, bInterfaceProtocol: 2, endpoints: [{ bmAttributes: 2, bEndpointAddress: 0x01 }, { bmAttributes: 2, bEndpointAddress: 0x82 }] }
    ];
    if (withIpp) {
      alts.push({ bInterfaceNumber: 0, bAlternateSetting: 1, bInterfaceClass: 7, bInterfaceSubClass: 1, bInterfaceProtocol: 4, endpoints: [{ bmAttributes: 2, bEndpointAddress: 0x03 }, { bmAttributes: 2, bEndpointAddress: 0x84 }] });
    }
    const receivedJobs = [];
    let curJobChunks = [];
    let statusIdx = 0;
    const defaultSeq = [
      // Initial query + idle before page 1
      [0x01, 0, 0],
      [0x01, 0, 0],
      // Page 1 print cycle: feeding -> Y -> M -> C -> laminate -> idle
      [0x02, 0, 0], [0x04, 0, 0], [0x08, 0, 0], [0x10, 0, 0], [0x20, 0, 0], [0x01, 0, 0],
      // Idle before page 2 + page 2 print cycle
      [0x01, 0, 0],
      [0x02, 0, 0], [0x20, 0, 0], [0x01, 0, 0]
    ];
    const seq = statusSeq || defaultSeq;
    const state = { opened: 0, closed: 0, claimed: 0, released: 0, altSelected: -1 };
    const flushJob = () => {
      if (curJobChunks.length) {
        receivedJobs.push(Buffer.concat(curJobChunks));
        curJobChunks = [];
      }
    };
    const dev = {
      busNumber: 2,
      deviceAddress: 9,
      deviceDescriptor: { idVendor: vid, idProduct: pid, iProduct: 2, iManufacturer: 1 },
      configDescriptor: { interfaces: [alts] },
      open() { state.opened++; },
      close() { flushJob(); state.closed++; },
      getStringDescriptor(idx, cb) { cb(null, idx === 1 ? 'Canon' : product); },
      controlTransfer(bmReq, bReq, wVal, wIdx, len, cb) {
        const id = Buffer.from(`MFG:Canon;MDL:${product};CLS:PRINTER;`, 'latin1');
        const h = Buffer.alloc(2); h.writeUInt16BE(id.length + 2);
        cb(null, Buffer.concat([h, id]));
      },
      interface() {
        return {
          isKernelDriverActive: () => false,
          claim() { state.claimed++; },
          setAltSetting(alt, cb) { state.altSelected = alt; cb(null); },
          release(_c, cb) { flushJob(); state.released++; cb(null); },
          endpoints: [
            {
              transferType: 2, direction: 'out', timeout: 0,
              transfer(data, cb) { curJobChunks.push(Buffer.from(data)); cb(null); }
            },
            {
              transferType: 2, direction: 'in', timeout: 0,
              transfer(_maxLen, cb) {
                flushJob();
                const entry = seq[Math.min(statusIdx++, seq.length - 1)];
                const rd = Buffer.alloc(12);
                rd[0] = entry[0]; rd[1] = entry[1]; rd[2] = entry[2];
                cb(null, rd);
              }
            }
          ]
        };
      }
    };
    return { dev, state, receivedJobs };
  }

  const mock = makeSelphyMock();
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-selphy-'));
  try {
    setUsbBackend({ getDeviceList: () => [mock.dev] });
    const probed = await probeUsbPrinters({ platform: 'darwin' });
    assert.equal(probed.length, 1);
    assert.equal(probed[0].name, 'Canon SELPHY CP1300');
    assert.equal(probed[0].isSelphy, true);
    assert.equal(probed[0].hasSelphyUsb, true);
    assert.equal(probed[0].hasIppUsb, false);
    assert.match(probed[0].note, /Canon SELPHY detected on USB/);
    assert.equal(pickUsbSelphyInterface(probed[0].interfaces).proto, 2);

    // Lightweight builder for fast test execution (validates Neo header + payload sizes)
    const fastBuilder = (buf, wMm, hMm, paperName) => {
      const spec = selphySpecFor(wMm, hMm, paperName);
      const data = Buffer.alloc(32 + 12);
      data[0] = 0x0f; data[3] = 0x40; data[14] = 0x01; data[16] = 0x01; data[18] = spec.code;
      data.writeUInt32LE(spec.cols, 24); data.writeUInt32LE(spec.rows, 28);
      return { data, spec };
    };
    initHelper({
      workerPath: join(dir, 'none.ps1'),
      logger: () => {},
      selphyJob: fastBuilder,
      selphyPrintOpts: { pollMs: 0, idleTimeoutMs: 2000, printTimeoutMs: 5000 },
      directPrintersFile: join(dir, 'direct.json')
    });
    const get = (path, qs = '') => handleHelper(new Request('http://127.0.0.1:17321' + path + (qs ? '?' + qs : ''), { method: 'GET' }), path, new URLSearchParams(qs));
    const post = (path, body) => handleHelper(new Request('http://127.0.0.1:17321' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), path, new URLSearchParams());

    const st = await (await get('/status', 'refresh=1')).json();
    const usbName = 'Canon SELPHY CP1300 (USB direct)';
    assert.ok(st.printers.includes(usbName), 'SELPHY CP1300 appears in /status without macOS driver: ' + JSON.stringify(st.printers));

    const caps = await (await get('/printer/caps', 'printer=' + encodeURIComponent(usbName))).json();
    assert.equal(caps.ok, true);
    assert.equal(caps.known, false);

    const paper4x6 = await (await get('/paper', 'printer=' + encodeURIComponent(usbName) + '&w=101.6&h=152.4')).json();
    assert.equal(paper4x6.ok, true);
    assert.equal(paper4x6.known, true);
    assert.match(paper4x6.match.name, /Postcard 100×148 mm.*USB/);
    assert.equal(paper4x6.paperList.length, 3);

    const cfg = await (await post('/printer/configure', { printer: usbName })).json();
    assert.equal(cfg.ok, true);
    assert.match(cfg.message, /Postcard 100×148 mm/);

    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const printed = await (await post('/print', { printer: usbName, pages: [png, png], widthMm: 100, heightMm: 148 })).json();
    assert.equal(printed.ok, true, JSON.stringify(printed));
    assert.equal(mock.receivedJobs.length, 2, '2 pages sent sequentially in one USB session');
    assert.equal(mock.receivedJobs[0][0], 0x0f);
    assert.equal(mock.receivedJobs[0][18], 0x50);
    assert.equal(mock.state.released, 1);
    assert.ok(mock.state.closed >= 1);

    // Error propagation (e.g. ink cassette empty = 0x06)
    const errMock = makeSelphyMock({ statusSeq: [[0x01, 0, 0], [0x01, 0, 0x06]] });
    setUsbBackend({ getDeviceList: () => [errMock.dev] });
    const failed = await (await post('/print', { printer: usbName, pages: [png], widthMm: 100, heightMm: 148 })).json();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Ink cassette empty/);
    console.log('✓ Passed: Canon SELPHY CP1300 prints over native Neo USB through helper.mjs and reports hardware errors clearly');

    // ---- 3. Fix 3: Duplicate "(USB direct)" suppression on macOS & Windows when OS queue exists ----
    const cp1500Mock = makeSelphyMock({ pid: 0x3302, product: 'SELPHY CP1500', withIpp: true });
    setUsbBackend({ getDeviceList: () => [cp1500Mock.dev] });
    const cp1500Probed = await probeUsbPrinters({ platform: 'darwin' });
    assert.equal(cp1500Probed[0].name, 'Canon SELPHY CP1500');
    assert.equal(cp1500Probed[0].hasSelphyUsb, true);
    assert.equal(cp1500Probed[0].hasIppUsb, true);

    // When macOS/Windows ALREADY has a CUPS/system queue for CP1500 -> no duplicate "(USB direct)" entry
    await _helperTest.refreshUsbDirect(['Canon_SELPHY_CP1500', 'EPSON_L8050'], true, cp1500Probed);
    assert.equal(_helperTest.usbDirect.size, 0, 'no duplicate (USB direct) entry when OS queue Canon_SELPHY_CP1500 already exists');

    // When only an unrelated OS printer exists -> "(USB direct)" IS offered
    await _helperTest.refreshUsbDirect(['EPSON_L8050'], true, cp1500Probed);
    assert.equal(_helperTest.usbDirect.has('Canon SELPHY CP1500 (USB direct)'), true);
    assert.equal(_helperTest.usbDirect.get('Canon SELPHY CP1500 (USB direct)').usbMode, 'selphy');
    console.log('✓ Passed: duplicate (USB direct) entry is suppressed on macOS & Windows when an OS queue already exists');

    // SELPHY pickPaper matches Postcard (100x148 mm) when booth asks for 4x6 (101.6x152.4 mm), while non-SELPHY keeps strict +/-3 mm
    _helperTest.PAPER_CACHE.set('Canon_SELPHY_CP1500', {
      at: Date.now(),
      def: 'Postcard',
      sizes: [
        { key: 'Postcard', name: 'Postcard', w: 100, h: 148, borderless: true },
        { key: 'Card', name: 'Card', w: 54, h: 86, borderless: true }
      ]
    });
    const selphyPick = await _helperTest.pickPaper('Canon_SELPHY_CP1500', 101.6, 152.4);
    assert.ok(selphyPick && selphyPick.key === 'Postcard' && selphyPick.keep === true, 'SELPHY 4x6 matches Postcard 100x148 mm');

    _helperTest.PAPER_CACHE.set('EPSON_L8050', {
      at: Date.now(),
      def: 'A4',
      sizes: [
        { key: 'A4', name: 'A4', w: 210, h: 297, borderless: false },
        { key: 'Postcard', name: 'Postcard', w: 100, h: 148, borderless: true }
      ]
    });
    const epsonPick = await _helperTest.pickPaper('EPSON_L8050', 101.6, 152.4);
    assert.equal(epsonPick, null, 'non-SELPHY printers keep strict +/-3 mm tolerance');
    console.log('✓ Passed: SELPHY CUPS/system queue matches 4x6 to Postcard 100x148 mm without relaxing non-SELPHY matching');
  } finally {
    setUsbBackend(null);
    stopHelper();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 4. Fix 1 & Fix 3B: Web Auto-Print toggle visibility & standalone print-helper.js guards ----
{
  const boothSrc = readFileSync(join(ROOT, 'protected', 'src', 'booth.src.html'), 'utf8');
  assert.ok(boothSrc.includes('const canAuto = LAPTOP_PRINT || !!(helperOn && helper && helper.ok);'), 'booth.src.html shows autoPrintRow on Web when Print Helper connects');
  assert.ok(boothSrc.includes("if (helperOn && helper.ok) return 'Pick a printer for this paper size below and each session prints with no dialog.';"), 'web auto-print hint reflects connected Print Helper');
  const checkHelperFn = boothSrc.slice(boothSrc.indexOf('async function checkHelper(force)'), boothSrc.indexOf('const printerSelect = document.getElementById'));
  assert.ok(checkHelperFn.includes('updateAutoPrintUI()'), 'checkHelper() refreshes auto-print toggle visibility immediately');

  const phSrc = readFileSync(join(ROOT, 'tools', 'print-helper', 'print-helper.js'), 'utf8');
  assert.ok(phSrc.includes('if (DYE_SUB.test(printer)) return [];'), 'standalone print-helper skips AirPrint quality overrides for dye-sub SELPHY queues');
  assert.ok(phSrc.includes('/^data:image\\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/'), 'standalone print-helper accepts both PNG and JPEG pages');
  assert.ok(phSrc.includes('buffers.length > 1 && /selphy|canon.*\\bCP\\s?\\d{3,4}\\b/i.test(name)'), 'standalone print-helper splits multi-page SELPHY jobs into individual single-page jobs');
  console.log('✓ Passed: Web auto-print toggle and standalone Print Helper SELPHY fixes verified');
}
process.exit(0);
