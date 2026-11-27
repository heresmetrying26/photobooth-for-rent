// End-to-end tests for DNP Upgrades 1 & 2:
//  1) Persistent warm Windows .NET print worker (desktop/lib/winprint-worker.mjs)
//  2) Desktop Direct-USB DNP driver (desktop/lib/dnpusb.mjs + usbipp.mjs + helper.mjs)
//  3) Optional DNP Hot Folder Print exporter (desktop/lib/hotfolder.mjs + helper.mjs + print-helper.js)
// Run: node desktop/test/test-dnp-upgrades.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWinPrintWorker, WIN_PRINT_WORKER_PS } from '../lib/winprint-worker.mjs';
import {
  DNP_VID_CITIZEN, DNP_VID_DNP,
  dnpModelName, isDnpUsb, dnpUnsupportedReason, dnpSheetFor, isDnpSingleStrip,
  dnpHeader, dnpCmd, encodeDnpJob, dnpStatusText, dnpIsError, parseDnpMediaRemaining
} from '../lib/dnpusb.mjs';
import { setUsbBackend, probeUsbPrinters } from '../lib/usbipp.mjs';
import { createHotFolderStore, detectDnpHotFolders, dropToHotFolder } from '../lib/hotfolder.mjs';
import { initHelper, handleHelper, stopHelper, _helperTest } from '../lib/helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS:', name);
}

// Minimal 1x1 JPEG bytes for data-URL /print tests
const TINY_JPG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x03, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x04, 0x03, 0x03, 0x04, 0x05, 0x08, 0x05, 0x05, 0x04, 0x04, 0x05, 0x0a, 0x07,
  0x07, 0x06, 0x08, 0x0c, 0x0a, 0x0c, 0x0c, 0x0b, 0x0a, 0x0b, 0x0b, 0x0d, 0x0e, 0x12, 0x10, 0x0d,
  0x0e, 0x11, 0x0e, 0x0b, 0x0b, 0x10, 0x16, 0x10, 0x11, 0x13, 0x14, 0x15, 0x15, 0x15, 0x0c, 0x0f,
  0x17, 0x18, 0x16, 0x14, 0x18, 0x12, 0x14, 0x15, 0x14, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xff, 0xc4, 0x00, 0x14,
  0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xbf, 0x00, 0xff, 0xd9
]);
const TINY_JPG_URL = 'data:image/jpeg;base64,' + TINY_JPG.toString('base64');

function makeDnpReply(asciiPayload) {
  const body = Buffer.from(String(asciiPayload), 'ascii');
  const head = Buffer.from(String(body.length).padStart(8, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

function makeMockDnpUsb({ statusCode = 0, freeBuffers = 2, mqty = 450, failStatus = null } = {}) {
  const writes = [];
  let pendingReply = null;
  let printed = false;

  const outEp = {
    transferType: 2,
    direction: 'out',
    timeout: 5000,
    transfer(buf, cb) {
      const b = Buffer.from(buf);
      writes.push(b);
      if (b.length === 32 && b[0] === 0x1b && b[1] === 0x50) {
        const group = b.subarray(2, 8).toString('ascii').trim();
        const name = b.subarray(8, 24).toString('ascii').trim();
        if (group === 'STATUS') {
          const st = failStatus !== null ? failStatus : (printed ? 0 : statusCode);
          pendingReply = makeDnpReply(String(st).padStart(8, '0'));
        } else if (group === 'INFO' && name === 'FREE_PBUFFER') {
          pendingReply = makeDnpReply('FBP' + String(freeBuffers).padStart(2, '0'));
        } else if (group === 'INFO' && name === 'MQTY') {
          pendingReply = makeDnpReply(String(mqty).padStart(8, '0'));
        } else if (group === 'INFO' && name === 'MEDIA') {
          pendingReply = makeDnpReply('200');
        }
      } else if (b.length > 100) {
        printed = true;
      }
      cb(null);
    }
  };
  const inEp = {
    transferType: 2,
    direction: 'in',
    timeout: 1500,
    transfer(_len, cb) {
      if (pendingReply) {
        const r = pendingReply;
        pendingReply = null;
        cb(null, r);
        return;
      }
      const err = new Error('LIBUSB_TRANSFER_TIMED_OUT');
      cb(err);
    }
  };
  const ifaceObj = {
    isKernelDriverActive: () => false,
    claim() { },
    release(_c, cb) { cb(null); },
    endpoints: [outEp, inEp]
  };
  const dev = {
    busNumber: 1,
    deviceAddress: 7,
    deviceDescriptor: {
      idVendor: DNP_VID_CITIZEN,
      idProduct: 0x0005, // DS-RX1 / RX1HS
      iProduct: 0,
      iManufacturer: 0
    },
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
    interface() { return ifaceObj; }
  };
  return { backend: { getDeviceList: () => [dev] }, writes };
}

async function run() {
  // ---- UPGRADE 1: Persistent Windows .NET Print Worker ----
  await check('WIN_PRINT_WORKER_PS protects DyeSub DEVMODE, uses TileFlipXY, and disposes PrintDocument cleanly', () => {
    assert.ok(WIN_PRINT_WORKER_PS.includes('if (-not $DyeSub -or $MediaType)'));
    assert.ok(WIN_PRINT_WORKER_PS.includes('if ($Borderless -and -not $DyeSub)'));
    assert.ok(WIN_PRINT_WORKER_PS.includes('WrapMode]::TileFlipXY'));
    assert.ok(WIN_PRINT_WORKER_PS.includes('PixelOffsetMode]::HighQuality'));
    assert.ok(WIN_PRINT_WORKER_PS.includes('$doc.Dispose()'));
    assert.ok(WIN_PRINT_WORKER_PS.includes('__PBW__:'));
  });

  if (process.platform === 'win32') {
    await check('Live Windows warm print worker boots once, answers warm ping in <250ms, queries paper/caps, and keeps alive after non-transport error', async () => {
      const worker = createWinPrintWorker();
      try {
        assert.equal(await worker.ping(), true);
        const t0 = Date.now();
        assert.equal(await worker.ping(), true);
        const warmMs = Date.now() - t0;
        assert.ok(warmMs < 250, 'expected warm ping < 250ms, got ' + warmMs + 'ms');

        const paper = await worker.paperSizes('Microsoft Print to PDF');
        assert.ok(Array.isArray(paper.sizes) && paper.sizes.length > 0, 'Microsoft Print to PDF should list paper sizes');

        const caps = await worker.printerCaps('Microsoft Print to PDF');
        assert.equal(typeof caps.borderless, 'boolean');

        // Non-existent printer returns real printer error without crashing worker or setting workerTransport=true
        let err = null;
        try { await worker.paperSizes('__NON_EXISTENT_PRINTER_9999__'); } catch (e) { err = e; }
        assert.ok(err, 'expected error for missing printer');
        assert.notEqual(err.workerTransport, true, 'printer-not-found must not be tagged as workerTransport');
        assert.equal(worker.isRunning(), true, 'worker must stay warm after normal printer error');
        assert.equal(await worker.ping(), true, 'worker still answers ping immediately');
      } finally {
        worker.stop();
      }
      assert.equal(worker.isRunning(), false, 'worker must stop cleanly');
    });
  }

  // ---- UPGRADE 2A: Desktop Direct-USB DNP Driver ----
  await check('dnpusb identifies DNP models, guards 8-inch / 4.5-inch models, and resolves sheets + single strips', () => {
    assert.equal(dnpModelName(DNP_VID_CITIZEN, 0x0005), 'DS-RX1');
    assert.equal(dnpModelName(DNP_VID_CITIZEN, 0x0003), 'DS40');
    assert.equal(dnpModelName(DNP_VID_DNP, 0x8b01), 'DS620');
    assert.equal(dnpModelName(DNP_VID_DNP, 0x9001), 'DS820');
    assert.equal(isDnpUsb(DNP_VID_DNP, 0x8b01), true);
    assert.equal(isDnpUsb(0x04b8, 0x0001), false);

    assert.equal(dnpUnsupportedReason('DS-RX1'), '');
    assert.equal(dnpUnsupportedReason('DS620'), '');
    assert.equal(dnpUnsupportedReason('DS40'), '');
    assert.ok(dnpUnsupportedReason('DS80').includes('8-inch'));
    assert.ok(dnpUnsupportedReason('DS820').includes('8-inch'));
    assert.ok(dnpUnsupportedReason('QW410').includes('4.5-inch'));

    assert.equal(dnpSheetFor(101.6, 152.4).code, '02');
    assert.equal(dnpSheetFor(127, 177.8).code, '03');
    assert.equal(dnpSheetFor(152.4, 203.2).code, '04');
    assert.equal(isDnpSingleStrip(50.8, 152.4), true);
    assert.equal(isDnpSingleStrip(101.6, 152.4), false);

    assert.equal(parseDnpMediaRemaining('00000450', 'DS-RX1'), 400);
    assert.equal(parseDnpMediaRemaining('00000385', 'DS620'), 385);
    assert.equal(dnpIsError(1100), true);
    assert.equal(dnpIsError(0), false);
    assert.ok(dnpStatusText(1010).includes('scrap box'));
  });

  await check('encodeDnpJob writes exact 32-byte ESC P headers, 2x6 CUTTER 120, OVERCOAT matte/glossy, and bottom-up Y/M/C BMP planes', () => {
    // Solid test bitmap: BGRA = (B=10, G=120, R=240, A=255)
    const w = 40, h = 60;
    const bgra = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      bgra[i * 4] = 10;
      bgra[i * 4 + 1] = 120;
      bgra[i * 4 + 2] = 240;
      bgra[i * 4 + 3] = 255;
    }

    const job = encodeDnpJob({ bgra, width: w, height: h, widthMm: 101.6, heightMm: 152.4, matte: true, stripCut: true, copies: 2 });
    assert.equal(job.sheet.code, '02');
    assert.equal(job.cut, true);
    assert.equal(job.matte, true);
    assert.equal(job.copies, 2);

    const expectedPre = Buffer.concat([
      dnpCmd('CNTRL', 'QTY', '0000002\r'),
      dnpCmd('CNTRL', 'OVERCOAT', '00000001'),
      dnpCmd('CNTRL', 'CUTTER', '00000120'),
      dnpCmd('IMAGE', 'MULTICUT', '00000002')
    ]);
    assert.deepEqual(job.data.subarray(0, expectedPre.length), expectedPre);

    // Verify 3 plane headers + BMP headers + exact pixel values
    const pixOff = 54 + 1024 + 10;
    const planeLen = 1920 * 1240;
    const fsize = pixOff + planeLen;
    const blockLen = 32 + fsize;
    const expectedValues = [10, 120, 240]; // Y=Blue, M=Green, C=Red
    const letters = ['Y', 'M', 'C'];
    for (let k = 0; k < 3; k++) {
      const at = expectedPre.length + k * blockLen;
      assert.deepEqual(job.data.subarray(at, at + 32), dnpHeader('IMAGE', letters[k] + 'PLANE', fsize));
      assert.equal(job.data.subarray(at + 32, at + 34).toString('ascii'), 'BM');
      assert.equal(job.data.readUInt32LE(at + 32 + 18), 1920);
      assert.equal(job.data.readUInt32LE(at + 32 + 22), 1240);
      assert.equal(job.data.readUInt16LE(at + 32 + 28), 8);
      assert.equal(job.data.readUInt32LE(at + 32 + 38), 11811);
      // Sample center pixel & bleed edge pixel — both must carry exact channel value (zero white bleed!)
      assert.equal(job.data[at + 32 + pixOff + 10], expectedValues[k]);
      assert.equal(job.data[at + 32 + pixOff + 1920 * 600 + 960], expectedValues[k]);
    }
    const endAt = expectedPre.length + blockLen * 3;
    assert.deepEqual(job.data.subarray(endAt), dnpCmd('CNTRL', 'START'));

    // Single 2x6 strip automatically forces 4x6 sheet + CUTTER 120 even if stripCut=false
    const stripJob = encodeDnpJob({ bgra, width: 20, height: 60, widthMm: 50.8, heightMm: 152.4, matte: false, stripCut: false });
    assert.equal(stripJob.sheet.code, '02');
    assert.equal(stripJob.cut, true);
    assert.ok(stripJob.data.subarray(0, 160).includes(Buffer.from('00000120', 'ascii')));
  });

  await check('End-to-end Desktop helper.mjs direct-USB DNP probe, caps, paper, dnp-status (MQTY), print & error handling', async () => {
    const mock = makeMockDnpUsb({ statusCode: 0, freeBuffers: 2, mqty: 450 });
    setUsbBackend(mock.backend);
    try {
      const found = await probeUsbPrinters({ readDescriptors: false });
      assert.equal(found.length, 1);
      assert.equal(found[0].isDnp, true);
      assert.equal(found[0].dnpModel, 'DS-RX1');
      assert.equal(found[0].hasDnpUsb, true);

      // Register direct-USB DNP with mocked builder (no Electron nativeImage needed)
      const tinyBgra = Buffer.alloc(16 * 24 * 4, 200);
      initHelper({
        dnpJob: (_buf, opts) => encodeDnpJob({ bgra: tinyBgra, width: 16, height: 24, ...opts }),
        dnpPrintOpts: { pollMs: 5, settleAfterMs: 10, queryTimeoutMs: 500 },
        logger: () => { }
      });

      // Suppressed when an OS queue for DS-RX1 or renamed "DNP 4x6" already exists
      await _helperTest.refreshUsbDirect(['DNP DS-RX1HS'], true, found);
      assert.equal(_helperTest.usbDirect.size, 0, 'must not duplicate when OS queue exists');
      await _helperTest.refreshUsbDirect(['DNP 4x6'], true, found);
      assert.equal(_helperTest.usbDirect.size, 0, 'must not duplicate when renamed DNP queue exists');

      // Appears when no OS queue exists
      await _helperTest.refreshUsbDirect([], true, found);
      const dnpName = [..._helperTest.usbDirect.keys()][0];
      assert.ok(dnpName && dnpName.includes('DS-RX1') && dnpName.endsWith('(USB direct)'), 'got: ' + dnpName);

      // /printer/caps exposes glossy & matte
      const capsRes = await handleHelper(new Request('http://local/printer/caps'), '/printer/caps', new URLSearchParams({ printer: dnpName }));
      const capsJson = await capsRes.json();
      assert.equal(capsJson.ok, true);
      assert.deepEqual(capsJson.mediaTypes, ['glossy', 'matte']);

      // /paper resolves 4x6 with 2x6 auto-cut label
      const papRes = await handleHelper(new Request('http://local/paper'), '/paper', new URLSearchParams({ printer: dnpName, w: '101.6', h: '152.4', twoUp: '1' }));
      const papJson = await papRes.json();
      assert.equal(papJson.ok, true);
      assert.ok(papJson.match.name.includes('2×6 auto-cut'));

      // /printer/dnp-status returns Idle + live media remaining (450 - 50 DS-RX1 offset = 400)
      const stRes = await handleHelper(new Request('http://local/printer/dnp-status'), '/printer/dnp-status', new URLSearchParams({ printer: dnpName }));
      const stJson = await stRes.json();
      assert.equal(stJson.ok, true);
      assert.equal(stJson.statusText, 'Idle');
      assert.equal(stJson.mediaRemaining, 400);

      // /print sends 2x6 matte job and returns mediaRemaining
      const prReq = new Request('http://local/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ printer: dnpName, pages: [TINY_JPG_URL], widthMm: 101.6, heightMm: 152.4, twoUp: true, mediaType: 'matte' })
      });
      const prRes = await handleHelper(prReq, '/print', new URLSearchParams());
      const prJson = await prRes.json();
      assert.equal(prJson.ok, true);
      assert.equal(prJson.mediaRemaining, 400);

      // Confirm mocked USB bulk writes carried OVERCOAT 00000001 and CUTTER 00000120
      const allWritten = Buffer.concat(mock.writes);
      assert.ok(allWritten.includes(dnpCmd('CNTRL', 'OVERCOAT', '00000001')));
      assert.ok(allWritten.includes(dnpCmd('CNTRL', 'CUTTER', '00000120')));

      // Error propagation: Paper end (1100) fails cleanly with readable message
      const errMock = makeMockDnpUsb({ failStatus: 1100 });
      setUsbBackend(errMock.backend);
      const errReq = new Request('http://local/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ printer: dnpName, pages: [TINY_JPG_URL], widthMm: 101.6, heightMm: 152.4 })
      });
      const errRes = await handleHelper(errReq, '/print', new URLSearchParams());
      const errJson = await errRes.json();
      assert.equal(errRes.status, 500);
      assert.ok(/Paper end/i.test(errJson.error), 'expected Paper end, got: ' + errJson.error);
    } finally {
      setUsbBackend(null);
      _helperTest.usbDirect.clear();
    }
  });

  // ---- UPGRADE 2B: Optional DNP Hot Folder Print Export ----
  await check('hotfolder detects DNP HFP watch folders, skips Archive/Logs, persists store, and writes files atomically', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pb4u-hf-test-'));
    try {
      const printsRoot = join(tmp, 'Prints');
      const d4x6 = join(printsRoot, '4x6');
      const d2x6 = join(printsRoot, '2x6');
      const d6x8 = join(printsRoot, '6x8');
      mkdirSync(d4x6, { recursive: true });
      mkdirSync(d2x6, { recursive: true });
      mkdirSync(d6x8, { recursive: true });
      mkdirSync(join(printsRoot, 'Archive'), { recursive: true });
      mkdirSync(join(printsRoot, 'Logs'), { recursive: true });

      const detected = detectDnpHotFolders({ extraRoots: [printsRoot] });
      const subs = detected.filter((d) => d.dir.startsWith(printsRoot)).map((d) => d.subName).sort();
      assert.deepEqual(subs, ['2x6', '4x6', '6x8']);
      assert.equal(detected.find((d) => d.subName === '2x6').twoUp, true);
      assert.equal(detected.find((d) => d.subName === '4x6').twoUp, false);

      // Persistence & validation
      const storeFile = join(tmp, 'hot-folders.json');
      const store = createHotFolderStore(storeFile);
      assert.equal(store.add({ label: 'Bad', dir: 'relative/path' }).ok, false);
      const added = store.add({ label: 'DNP 4x6', dir: d4x6, format: 'jpg' });
      assert.equal(added.ok, true);
      assert.equal(added.printer, 'Hot Folder: DNP 4x6');

      const reloaded = createHotFolderStore(storeFile);
      assert.deepEqual(reloaded.names(), ['Hot Folder: DNP 4x6']);

      // Atomic drop: 2 pages -> 2 .jpg files, 0 leftover .tmp files
      const dropped = await dropToHotFolder(reloaded.get('Hot Folder: DNP 4x6'), [
        { buf: TINY_JPG, ext: 'jpg' },
        { buf: TINY_JPG, ext: 'jpg' }
      ]);
      assert.equal(dropped.ok, true);
      assert.equal(dropped.files.length, 2);
      const onDisk = readdirSync(d4x6);
      assert.equal(onDisk.length, 2);
      assert.ok(onDisk.every((f) => f.endsWith('.jpg') && !f.endsWith('.tmp')));
      assert.deepEqual(readFileSync(join(d4x6, onDisk[0])), TINY_JPG);

      // End-to-end through helper.mjs
      initHelper({ hotFoldersFile: join(tmp, 'helper-hf.json'), pickHotFolder: async () => d2x6, logger: () => { } });
      const addRes = await handleHelper(new Request('http://local/printer/hotfolder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'DNP 2x6 Strips', dir: d2x6 })
      }), '/printer/hotfolder', new URLSearchParams());
      const addJson = await addRes.json();
      assert.equal(addJson.ok, true);
      assert.equal(addJson.printer, 'Hot Folder: DNP 2x6 Strips');

      const pickRes = await handleHelper(new Request('http://local/printer/hotfolder/pick', { method: 'POST' }), '/printer/hotfolder/pick', new URLSearchParams());
      const pickJson = await pickRes.json();
      assert.equal(pickJson.ok, true);
      assert.equal(pickJson.dir, d2x6);

      const printRes = await handleHelper(new Request('http://local/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ printer: 'Hot Folder: DNP 2x6 Strips', pages: [TINY_JPG_URL], widthMm: 101.6, heightMm: 152.4, twoUp: true })
      }), '/print', new URLSearchParams());
      const printJson = await printRes.json();
      assert.equal(printJson.ok, true);
      assert.equal(readdirSync(d2x6).filter((f) => f.endsWith('.jpg')).length, 1);

      const remRes = await handleHelper(new Request('http://local/printer/hotfolder/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ printer: 'Hot Folder: DNP 2x6 Strips' })
      }), '/printer/hotfolder/remove', new URLSearchParams());
      assert.equal((await remRes.json()).removed, true);
    } finally {
      initHelper({ hotFoldersFile: '', logger: () => { } });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('Built protected/booth.html, tools/print-helper/print-helper.js, and desktop/main.mjs wire all Upgrade 1 & 2 features', () => {
    const booth = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
    for (const needle of ['id="hotFolderBtn"', 'id="hotFolderBox"', '/printer/hotfolder', 'driverless DNP', 'j.mediaRemaining']) {
      assert.ok(booth.includes(needle), 'protected/booth.html missing: ' + needle);
    }
    const ph = readFileSync(join(root, 'tools', 'print-helper', 'print-helper.js'), 'utf8');
    for (const needle of ['createWinPrintWorker', 'createHotFolderStore', 'dropToHotFolder', '/printer/hotfolder']) {
      assert.ok(ph.includes(needle), 'print-helper.js missing: ' + needle);
    }
    const mainSrc = readFileSync(join(root, 'desktop', 'main.mjs'), 'utf8');
    for (const needle of ['makeDnpJobBuilder', 'hot-folders.json', 'pickHotFolder']) {
      assert.ok(mainSrc.includes(needle), 'desktop/main.mjs missing: ' + needle);
    }
  });

  stopHelper();
  console.log('\n' + passed + ' passed');
}

run().catch((err) => {
  stopHelper();
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
