import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initPhotos, driveRequest, startShareServer, stopShareServer,
  setPrintNowConfig, printNowTake, printNowDone
} from '../lib/photos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'pb4u-reprint-test-'));
let port = 0;

try {
  mkdirSync(join(tmp, 'data'), { recursive: true });
  initPhotos({ root: join(tmp, 'photos'), dataDir: join(tmp, 'data') });
  port = await startShareServer();
  assert.ok(port > 0, 'share server must start on a port');
  const base = 'http://127.0.0.1:' + port;

  // Save a tiny 1x1 JPEG into an event folder
  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
  ]);
  const saved = await driveRequest({ folderKey: 'Reprint Test', filename: '1_strip.jpg', buffer: jpg });
  assert.equal(saved.ok, true, 'driveRequest must succeed');
  const slug = saved.folderUrl.replace('pb4u-local:', '');

  // 1. Push a dual thermal + coloured printer config from booth (with Auto-print ON)
  const cfg = {
    printOn: true,
    autoPrint: true,
    sizes: [
      { key: '4x6', name: '4R (4×6)', w: 101.6, h: 152.4, receipt: false },
      { key: 'receipt80', name: 'Receipt 80 mm', w: 72, h: 290, receipt: true }
    ],
    printers: [
      { id: 'helper:Epson L8050', label: 'Epson L8050', kind: 'helper', receipt: false },
      { id: 'helper:XP-80C Thermal', label: 'XP-80C Thermal', kind: 'helper', receipt: false },
      { id: 'bt', label: '🧾 Bluetooth Thermal (connected)', kind: 'bt', receipt: true },
      { id: 'dialog', label: 'System print dialog · choose any printer…', kind: 'dialog', receipt: false }
    ],
    sizePrinters: { '4x6': 'helper:Epson L8050', 'receipt80': 'helper:XP-80C Thermal' },
    defaultSize: '4x6',
    defaultPrinter: 'helper:Epson L8050',
    defaultCopies: 2,
    singleStrip: false,
    thermalQuality: 'best'
  };
  assert.equal(setPrintNowConfig(cfg), true, 'setPrintNowConfig should store config');

  // 2. GET /printnow/config returns prefilled setup
  const rCfg = await fetch(base + '/printnow/config');
  assert.equal(rCfg.status, 200);
  const jCfg = await rCfg.json();
  assert.equal(jCfg.ok, true);
  assert.equal(jCfg.config.defaultPrinter, 'helper:Epson L8050');
  assert.equal(jCfg.config.defaultSize, '4x6');
  assert.equal(jCfg.config.defaultCopies, 2);
  assert.equal(jCfg.config.autoPrint, true);
  assert.equal(jCfg.config.printers.length, 4);
  assert.equal(jCfg.config.sizePrinters.receipt80, 'helper:XP-80C Thermal');

  // 3. GET /e/<slug>/list.json returns event files with CORS
  const rList = await fetch(base + '/e/' + slug + '/list.json');
  assert.equal(rList.status, 200);
  assert.equal(rList.headers.get('access-control-allow-origin'), '*');
  const jList = await rList.json();
  assert.equal(jList.ok, true);
  assert.ok(jList.files.some((f) => f.n === '1_strip.jpg'), 'list.json must include saved photo');

  // 4. GET /e/<slug>/p/1_strip.jpg renders the prefilled reprint modal (app-only, no System dialog button) & valid inline JS
  const rPage = await fetch(base + '/e/' + slug + '/p/1_strip.jpg');
  assert.equal(rPage.status, 200);
  const html = await rPage.text();
  assert.ok(html.includes('id="opPrintModal"'), 'local gallery page must include reprint modal');
  assert.ok(html.includes('id="opPmPrinter"'), 'reprint modal must include printer selector');
  assert.ok(html.includes('id="opPmSize"'), 'reprint modal must include paper size selector');
  assert.ok(html.includes('id="opPmRefresh"'), 'reprint modal must include refresh printers button');
  assert.ok(!html.includes('id="opPmSys"'), 'local gallery reprint modal must not show System dialog button');
  assert.ok(!html.includes('window.print()'), 'operator local gallery reprint must stay in app and never call window.print()');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, 'local gallery photo page must have inline script');
  for (const m of scripts) new Function(m[1]);

  // 5. POST /e/<slug>/printnow/1_strip.jpg with thermal override options
  const rPost = await fetch(base + '/e/' + slug + '/printnow/1_strip.jpg', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 'receipt80', printer: 'helper:XP-80C Thermal', copies: 3, singleStrip: true, thermalQuality: 'normal' })
  });
  assert.equal(rPost.status, 200);
  const jPost = await rPost.json();
  assert.equal(jPost.ok, true);
  assert.ok(jPost.id);

  // 6. printNowTake returns photo bytes + exact override options
  const jobs = printNowTake();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, jPost.id);
  assert.equal(jobs[0].file, '1_strip.jpg');
  assert.equal(jobs[0].bytes.length, jpg.length);
  assert.deepEqual(jobs[0].opts, {
    size: 'receipt80',
    printer: 'helper:XP-80C Thermal',
    copies: 3,
    singleStrip: true,
    thermalQuality: 'normal'
  });

  // 7. printNowDone updates status message cleanly
  assert.equal(printNowDone(jPost.id, true, 'Printing on XP-80C Thermal (3 copies, Receipt 80 mm).'), true);
  const rStat = await fetch(base + '/printnow/' + jPost.id);
  assert.equal(rStat.status, 200);
  const jStat = await rStat.json();
  assert.equal(jStat.state, 'ok');
  assert.equal(jStat.msg, 'Printing on XP-80C Thermal (3 copies, Receipt 80 mm).');

  // 8. Static integrity checks across booth.html, web gallery, Android gallery, iOS LocalShareServer
  const booth = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  assert.ok(booth.includes('id="rgOverlay"') && booth.includes('id="rpModal"'), 'booth.html must have in-booth gallery & reprint modal');
  assert.ok(!booth.includes('id="rpSysBtn"'), 'in-booth reprint modal must not show System dialog button');
  assert.ok(booth.includes('id="rpSettingsBtn"'), 'in-booth reprint modal must have in-app Print settings fallback');
  assert.ok(booth.includes('id="galleryPopReprint"') && booth.includes('id="driveFolderReprint"'), 'booth.html must expose Browse & Reprint buttons');
  assert.ok(booth.includes("route === 'bt'") && booth.includes("route.indexOf('wifi:') === 0") && booth.includes("route.indexOf('instax:') === 0"), 'pnRun must support bt, wifi, and instax routes');
  assert.ok(booth.includes("if (LAPTOP_PRINT && route === 'dialog')"), 'pnRun must block OS dialog on Desktop/LAPTOP_PRINT');
  assert.ok(booth.includes('useBrowserPrint: true'), 'pnRun must delegate browser print dialog back to foreground external gallery tab');
  assert.ok(booth.includes('printSize = oldSize;'), 'pnRun must always restore printSize so Auto-print is untouched');

  const webGal = readFileSync(join(ROOT, 'public', 'gallery', 'index.html'), 'utf8');
  assert.ok(webGal.includes('id="pModal"') && !webGal.includes('id="pSys"') && webGal.includes('r.useBrowserPrint') && webGal.includes('window.__PBPrint'), 'web gallery must have app-only prefilled modal without System dialog button');

  const andGal = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'share', 'gallery.html'), 'utf8');
  assert.ok(andGal.includes('window.__PBPrint.print('), 'Android local gallery must use window.__PBPrint instead of dead window.print()');

  const iosSrv = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'LocalShareServer.swift'), 'utf8');
  assert.ok(iosSrv.includes('onclick=\\"window.print()\\"') && iosSrv.includes('@media print'), 'iOS LocalShareServer must render Print photo button and print CSS');

  console.log('PASS: all gallery reprint tests (Desktop, Web, Android, iPad, thermal + coloured + system dialog)');
} finally {
  stopShareServer();
  rmSync(tmp, { recursive: true, force: true });
}
