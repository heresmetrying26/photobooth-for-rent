// Comprehensive regression & behavioral tests for iPad 7th gen (3 GB RAM / iPadOS 18)
// save-then-print hang, AirPrint async bridge, low-RAM caps, canvas cleanup, and 30s sync storm.
// Run: node scripts/test-ipad-low-ram-print.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = assemble().html;
const vcSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'ViewController.swift'), 'utf8');
const camSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'NativeCameraBridge.swift'), 'utf8');
const shareSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'LocalShareServer.swift'), 'utf8');
const escprSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'EscprLpdPrint.swift'), 'utf8');
const localSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'PBLocal.swift'), 'utf8');

let passed = 0;
const asyncQueue = [];
const test = (name, fn) => {
  asyncQueue.push({ name, fn });
};

test('built booth.html is byte-identical across protected/, ios/, and android/ and every <script> parses cleanly in V8', () => {
  const sha = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
  const hProt = sha('protected/booth.html');
  const hIos = sha('ios/photobooth4u/booth.html');
  const hAnd = sha('android/app/src/main/assets/booth.html');
  assert.equal(hProt, hIos, 'ios/photobooth4u/booth.html matches protected/booth.html');
  assert.equal(hProt, hAnd, 'android/app/src/main/assets/booth.html matches protected/booth.html');

  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m, count = 0;
  while ((m = re.exec(html))) {
    if (!m[1].trim()) continue;
    count++;
    new vm.Script(m[1], { filename: 'booth-script-' + count + '.js' });
  }
  assert.ok(count >= 1, 'parsed at least one <script> block (' + count + ')');
});

test('all 5 modified Swift files have balanced {}, (), [] delimiters', () => {
  const files = [
    ['ViewController.swift', vcSwift],
    ['NativeCameraBridge.swift', camSwift],
    ['LocalShareServer.swift', shareSwift],
    ['EscprLpdPrint.swift', escprSwift],
    ['PBLocal.swift', localSwift]
  ];
  for (const [name, s] of files) {
    let curly = 0, paren = 0, sq = 0;
    let inLine = false, inBlk = 0, inStr = false, inMl = false, rawHashes = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i], n = s[i + 1], n2 = s[i + 2];
      if (inLine) { if (c === '\n') inLine = false; continue; }
      if (inBlk > 0) {
        if (c === '/' && n === '*') { inBlk++; i++; }
        else if (c === '*' && n === '/') { inBlk--; i++; }
        continue;
      }
      if (inMl) {
        if (c === '\\' && rawHashes === 0) { i++; continue; }
        if (c === '"' && n === '"' && n2 === '"') {
          let ok = true;
          for (let k = 0; k < rawHashes; k++) if (s[i + 3 + k] !== '#') ok = false;
          if (ok) { inMl = false; i += 2 + rawHashes; rawHashes = 0; }
        }
        continue;
      }
      if (inStr) {
        if (c === '\\' && rawHashes === 0) { i++; continue; }
        if (c === '"') {
          let ok = true;
          for (let k = 0; k < rawHashes; k++) if (s[i + 1 + k] !== '#') ok = false;
          if (ok) { inStr = false; i += rawHashes; rawHashes = 0; }
        }
        continue;
      }
      if (c === '/' && n === '/') { inLine = true; i++; continue; }
      if (c === '/' && n === '*') { inBlk = 1; i++; continue; }
      if (c === '#') {
        let h = 0; while (s[i + h] === '#') h++;
        if (s[i + h] === '"') {
          if (s[i + h + 1] === '"' && s[i + h + 2] === '"') { inMl = true; rawHashes = h; i += h + 2; continue; }
          inStr = true; rawHashes = h; i += h; continue;
        }
      }
      if (c === '"' && n === '"' && n2 === '"') { inMl = true; rawHashes = 0; i += 2; continue; }
      if (c === '"') { inStr = true; rawHashes = 0; continue; }
      if (c === '{') curly++; else if (c === '}') curly--;
      if (c === '(') paren++; else if (c === ')') paren--;
      if (c === '[') sq++; else if (c === ']') sq--;
    }
    assert.deepEqual({ curly, paren, sq }, { curly: 0, paren: 0, sq: 0 }, name + ' delimiters balanced');
  }
});

test('iOS ViewController bridgeJs parses cleanly and __PBPrint.print posts async pbPrintAirPrint without blocking prompt()', () => {
  const m = vcSwift.match(/let bridgeJs = """([\s\S]*?)"""/);
  assert.ok(m, 'bridgeJs found in ViewController.swift');
  // Replace Swift string interpolation \(...) (including nested calls like initialStateJson()) with a valid JS literal for V8 execution
  const jsSrc = m[1].replace(/\\\((?:[^()]|\([^()]*\))*\)/g, '{"on":true,"connected":false}');
  new vm.Script(jsSrc, { filename: 'ios-bridge.js' });

  // 1. Primary path: pbPrintAirPrint message handler receives payload and prompt() is NEVER called
  const posted = [];
  let promptCalls = 0;
  const ctx1 = {
    window: {
      webkit: {
        messageHandlers: {
          pbPrintAirPrint: { postMessage: (msg) => posted.push(msg) }
        }
      }
    },
    Navigator: { prototype: {} },
    prompt: () => { promptCalls++; return '{"ok":true}'; },
    setTimeout, clearTimeout, Promise, JSON, String, Number, Object
  };
  ctx1.window.window = ctx1.window;
  vm.runInNewContext(jsSrc, ctx1);
  const res1 = JSON.parse(ctx1.window.__PBPrint.print('Photobooth 4x6', 101.6, 152.4, '["data:image/jpeg;base64,AAA"]'));
  assert.equal(res1.ok, true, 'async AirPrint bridge returns ok:true immediately');
  assert.equal(promptCalls, 0, 'blocking prompt() is NOT called when pbPrintAirPrint is available');
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), {
    jobName: 'Photobooth 4x6',
    widthMm: 101.6,
    heightMm: 152.4,
    pagesJson: '["data:image/jpeg;base64,AAA"]'
  });

  // 2. Fallback path: if pbPrintAirPrint throws, cleanly falls back to __PBPrint_sync__
  let fallbackPrompt = null;
  const ctx2 = {
    window: {
      webkit: {
        messageHandlers: {
          pbPrintAirPrint: { postMessage: () => { throw new Error('missing'); } }
        }
      }
    },
    Navigator: { prototype: {} },
    prompt: (k, v) => { fallbackPrompt = { k, v }; return '{"ok":true}'; },
    setTimeout, clearTimeout, Promise, JSON, String, Number, Object
  };
  vm.runInNewContext(jsSrc, ctx2);
  const res2 = JSON.parse(ctx2.window.__PBPrint.print('Fallback', 100, 150, '["x"]'));
  assert.equal(res2.ok, true);
  assert.equal(fallbackPrompt.k, '__PBPrint_sync__');
});

test('iOS ViewController: AirPrint preserves compact /DCTDecode JPEG when <= maxPx, cancels guard on interactive present, clears temp PDF', () => {
  assert.ok(/import ImageIO/.test(vcSwift), 'ViewController imports ImageIO');
  assert.ok(/userContent\.add\(self, name: "pbPrintAirPrint"\)/.test(vcSwift), 'pbPrintAirPrint message handler registered');
  assert.ok(/else if message\.name == "pbPrintAirPrint"/.test(vcSwift), 'userContentController handles pbPrintAirPrint');
  assert.ok(/private let printQueue = DispatchQueue\(label: "com\.photobooth4u\.print"/.test(vcSwift), 'serial printQueue declared');
  assert.ok(/renderer\.writePDF\(to: pdfUrl\)/.test(vcSwift), 'AirPrint writes PDF to temp file instead of holding Data in RAM');
  assert.ok(/if orient != 1 \|\| max\(pw, ph\) > maxPx/.test(vcSwift), 'AirPrint passes compact native JPEG through when already <= maxPx');
  assert.ok(/CGImageSourceCreateThumbnailAtIndex\(src, 0, thumbOpts as CFDictionary\)/.test(vcSwift), 'AirPrint downsamples oversized pages via ImageIO');
  assert.ok(/CGImageDestinationCreateWithData\(outData as CFMutableData, "public\.jpeg" as CFString/.test(vcSwift), 'Downsampled AirPrint pages re-encode to compact JPEG for /DCTDecode PDF');
  assert.ok(/if shown \{\s*onPresented\?\(\)\s*\} else \{\s*completion\?\(\)\s*\}/.test(vcSwift), 'interactive AirPrint cancels 60s timeout when shown and completes immediately if presentation fails');
  assert.ok(/controller\.printingItem = nil\s*controller\.delegate = nil\s*try\? FileManager\.default\.removeItem\(at: next\.pdfUrl\)/.test(vcSwift), 'AirPrint clears printingItem/delegate and deletes temp PDF on completion');
  assert.ok(/if presentedViewController != nil \|\| isBeingPresented \|\| isBeingDismissed/.test(vcSwift), 'presentPrintController defers cleanly while another sheet is presented');
  assert.ok(/sendIppPrint[\s\S]*?printQueue\.async/.test(vcSwift), 'sendIppPrint runs serially on printQueue');
  assert.ok(/sendEscprPrint[\s\S]*?printQueue\.async/.test(vcSwift), 'sendEscprPrint runs serially on printQueue');
});

test('iOS ViewController, PBLocal, NativeCameraBridge, LocalShareServer & EscprLpdPrint: low-RAM, Photos serialization, ImageIO', () => {
  assert.ok(/ProcessInfo\.processInfo\.physicalMemory <= 3_758_096_384/.test(vcSwift), 'low-RAM threshold is 3.5 GiB');
  assert.ok(/window\.__PB\.iosLowRam=/.test(vcSwift), 'buildPbConfigScript injects window.__PB.iosLowRam');
  assert.ok(/didReceiveMemoryWarning\(\)[\s\S]*?new Event\('pb-memory-pressure'\)/.test(vcSwift), 'didReceiveMemoryWarning dispatches pb-memory-pressure');
  assert.ok(/private func presentShareSheet\(for file: URL, attempt: Int = 0\)[\s\S]*?topAlertPresenter\(\)/.test(vcSwift), 'presentShareSheet uses topAlertPresenter');
  assert.ok(/private let photosQueue = DispatchQueue\(label: "com\.photobooth4u\.photos"/.test(localSwift), 'PBLocal serializes Apple Photos imports on photosQueue');
  assert.ok(/sema\.wait\(timeout: \.now\(\) \+ 10\.0\)/.test(localSwift), 'PBLocal waits for each PHPhotoLibrary transaction before starting the next');
  assert.ok(/static let isLowRamDevice: Bool = ProcessInfo\.processInfo\.physicalMemory <= 3_758_096_384/.test(camSwift), 'NativeCameraBridge detects low-RAM iPads');
  assert.ok(/let maxSide = NativeCameraBridge\.isLowRamDevice \? 1920 : 2400/.test(camSwift), 'NativeCameraBridge caps built-in still capture to 1920px on low-RAM iPads');
  assert.ok(/let maxKeep = NativeCameraBridge\.isLowRamDevice \? 2 : 4/.test(camSwift), 'NativeCameraBridge caps shotStore to 2 on low-RAM iPads');
  assert.ok(/import ImageIO/.test(shareSwift) && /CGImageSourceCreateWithURL\(fileUrl as CFURL, nil\)/.test(shareSwift), 'LocalShareServer generates thumbnails via ImageIO');
  assert.ok(/import ImageIO/.test(escprSwift) && /CGImageSourceCreateThumbnailAtIndex\(src, 0, opts as CFDictionary\)/.test(escprSwift), 'EscprJob decodes JPEG via ImageIO capped to print area');
});

test('booth.html: offlineOutputScale & offlineShotMaxPx cap memory on 3 GB iPads while preserving 4 GB+ iPads', () => {
  const start = html.indexOf('function isLowRamIos()');
  const end = html.indexOf('function offlineJpegQuality(', start);
  assert.ok(start > 0 && end > start, 'offlineOutputScale block found');

  const mkScale = (opts) => new Function(
    'window', 'LOCALSHARE', 'DESKTOP', 'LANREMOTE', 'USB_SHOT_MAX', 'isOutputTarget', 'cameraDetailScale',
    html.slice(start, end) + '; return { isLowRamIos, offlineOutputScale, offlineShotMaxPx };'
  )(
    opts.win, opts.localshare, opts.desktop, opts.lanremote, 2400, () => true, () => opts.detail || 3.5
  );

  const lowIpad = mkScale({ win: { __PB: { ios: true, iosLowRam: true } }, localshare: true, desktop: false, lanremote: false, detail: 3.5 });
  assert.equal(lowIpad.isLowRamIos(), true);
  assert.equal(lowIpad.offlineShotMaxPx(), 1920, 'low-RAM iPad shot max is 1920px');
  const lowSheetScale = lowIpad.offlineOutputScale({ _hiRes: true }, 'sheet');
  assert.ok(lowSheetScale <= Math.sqrt(5000000 / 2160000) + 1e-6, 'low-RAM iPad sheet scale capped at 5 MP');
  assert.ok(lowSheetScale >= 1.5, 'low-RAM iPad sheet scale still >= 1.5x (450 dpi on 4x6)');

  const proIpad = mkScale({ win: { __PB: { ios: true, iosLowRam: false } }, localshare: true, desktop: false, lanremote: false, detail: 3.5 });
  assert.equal(proIpad.isLowRamIos(), false);
  assert.equal(proIpad.offlineShotMaxPx(), 3600, '4 GB+ iPad keeps 3600px shot max');
  assert.ok(proIpad.offlineOutputScale({ _hiRes: true }, 'sheet') > 2.2, '4 GB+ iPad keeps 12 MP ceiling');
});

test('booth.html: cloneShotForSolo caps to 1600px on 3 GB iPads and saveSoloPhotosAsync pauses during printing & AirPrint cooldown', async () => {
  const a = html.indexOf('function cloneShotForSolo(c)');
  const b = html.indexOf('var GV_CODE_RE =', a);
  assert.ok(a > 0 && b > a, 'solo save block found');

  const mkCanvas = (w = 0, h = 0) => ({
    width: w, height: h,
    getContext: () => ({ fillStyle: '', imageSmoothingEnabled: true, imageSmoothingQuality: '', fillRect() {}, drawImage() {} })
  });
  const doc = { createElement: () => mkCanvas() };

  // 1. cloneShotForSolo sizing: 3 GB iPad vs 4 GB+ iPad
  const mkSoloApi = (lowRam, stateObj) => new Function(
    'document', 'isLowRamIos', 'IS_IOS_APP', 'saveSoloPhotos', 'sessionNumber', 'rawFolderKey', 'driveSubfolder',
    'filePrefix', 'deviceTag', 'soloOriginal', 'pbCanvasBlob', 'offlineJpegQuality', 'pbReleaseCanvas', 'pbReleaseShotCanvas',
    'backupDir', 'backupOk', 'DESKTOP_ONLINE', 'driveReady', 'LOCALSHARE', 'navigator', 'uploadToDrive', 'queueUpload',
    'wait', 'softSkin', 'filterKey', 'dateStamp', 'getState',
    'var printing, _pbLastPrintSentAt;' +
    'function _syncState(){ printing = getState().printing; _pbLastPrintSentAt = getState().lastPrintAt; }' +
    html.slice(a, b)
      .replace(/if \(typeof printing !== 'undefined' && printing\)/g, 'if (getState().printing)')
      .replace(/for \(var pw = 0; pw < 80 && printing; pw\+\+\)/g, 'for (var pw = 0; pw < 80 && getState().printing; pw++)')
      .replace(/typeof _pbLastPrintSentAt === 'number' && _pbLastPrintSentAt > 0/g, 'getState().lastPrintAt > 0')
      .replace(/Date\.now\(\) - _pbLastPrintSentAt/g, 'Date.now() - getState().lastPrintAt') +
    '; return { cloneShotForSolo, saveSoloPhotosAsync };'
  )(
    doc, () => lowRam, true, true, 7, () => 'ev', () => '', () => '', () => '',
    async () => null, async () => ({ size: 100 }), () => 0.92,
    (cv) => { cv.width = 0; cv.height = 0; },
    (cv) => { stateObj.released.push(cv); cv.width = 0; cv.height = 0; },
    null, false, false, () => true, true, { onLine: true },
    async (_blob, name) => { stateObj.uploaded.push({ name, printingDuringUpload: stateObj.printing, t: Date.now() }); },
    async () => {},
    (ms) => new Promise((r) => { stateObj.waits.push(ms); setTimeout(r, Math.min(ms, 5)); }),
    false, 'none', false, () => stateObj
  );

  const stLow = { printing: true, lastPrintAt: 0, uploaded: [], released: [], waits: [] };
  const apiLow = mkSoloApi(true, stLow);
  const bigShot = mkCanvas(2400, 3000);
  const lowClone = apiLow.cloneShotForSolo(bigShot);
  assert.deepEqual({ w: lowClone.width, h: lowClone.height }, { w: 1280, h: 1600 }, 'low-RAM iPad solo clone capped at 1600px');

  const stPro = { printing: false, lastPrintAt: 0, uploaded: [], released: [], waits: [] };
  const apiPro = mkSoloApi(false, stPro);
  const proClone = apiPro.cloneShotForSolo(bigShot);
  assert.deepEqual({ w: proClone.width, h: proClone.height }, { w: 2400, h: 3000 }, '4 GB+ iPad keeps full 2400x3000 solo clone');

  // 2. saveSoloPhotosAsync pauses while printing=true and releases every solo canvas
  const s1 = mkCanvas(1280, 1600), s2 = mkCanvas(1280, 1600);
  setTimeout(() => { stLow.printing = false; stLow.lastPrintAt = Date.now() - 2200; }, 12);
  await apiLow.saveSoloPhotosAsync(7, [s1, s2]);
  assert.equal(stLow.uploaded.length, 2, 'both solo shots uploaded after printing finished');
  assert.equal(stLow.uploaded.every((u) => !u.printingDuringUpload), true, 'no solo shot uploaded while printing was true');
  assert.equal(stLow.released.length, 2, 'every solo shot canvas released in finally');
  assert.equal(s1.width, 0);
  assert.equal(s2.width, 0);
  assert.ok(stLow.waits.includes(150), 'waited while printing was active');
  assert.ok(stLow.waits.includes(90), 'low-RAM iPad yields 90ms between solo shots');
});

test('booth.html: l8050DpiFor avoids 600/720 dpi RAM spikes on 3 GB iPads while keeping 4 GB+ iPads full hi-res', () => {
  const hiIdx = html.indexOf('function l8050HiResAvailable()');
  const bcIdx = html.indexOf('function buildPrintCanvas(');
  const run = (lowRam, printer, wo) => new Function(
    'IOS_APP', 'window', 'wifiPrinter', 'wifiOpts', 'isEpsonL8050', 'epsonLNetPrinter',
    html.slice(hiIdx, bcIdx) + '; return l8050DpiFor;'
  )(
    true,
    { __PB: { iosLowRam: lowRam }, __PBNet: { supportsL8050HiRes: () => true } },
    printer, () => wo, () => true, () => true
  )({ w: 101.6, h: 152.4 });

  const ippL8050 = { ip: '192.168.1.5', ipp: true, name: 'EPSON L8050 Series' };
  const lpdL8050 = { ip: '192.168.223.1', ipp: false, escpr: true, lpd: true, name: 'EPSON L8050 Series' };
  assert.equal(run(true, ippL8050, { quality: 'high' }), 0, '3 GB iPad IPP stays at 300 dpi');
  assert.equal(run(true, lpdL8050, { quality: 'high720' }), 360, '3 GB iPad LPD caps high720 to 360 dpi');
  assert.equal(run(false, ippL8050, { quality: 'high' }), 600, '4 GB+ iPad IPP keeps 600 dpi');
  assert.equal(run(false, lpdL8050, { quality: 'high720' }), 720, '4 GB+ iPad LPD keeps 720 dpi');
});

test('booth.html: pbEncodePrintDataUrls deduplicates copies and pbReleaseCanvasList releases every canvas once', () => {
  const a = html.indexOf('function pbEncodePrintDataUrls(');
  const b = html.indexOf('async function printViaWifiRaw(', a);
  const released = [];
  const api = new Function('pbReleaseCanvas', html.slice(a, b) + '; return { pbEncodePrintDataUrls, pbReleaseCanvasList };')(
    (cv) => { released.push(cv.id); cv.width = 0; cv.height = 0; }
  );

  let encodeCount = 0;
  const c1 = { id: 'p1', width: 1200, height: 1800, toDataURL: () => { encodeCount++; return 'data:image/jpeg;base64,AAA'; } };
  const c2 = { id: 'p2', width: 1200, height: 1800, toDataURL: () => { encodeCount++; return 'data:image/jpeg;base64,BBB'; } };
  const urls = api.pbEncodePrintDataUrls([c1, c1, c1, c2, c1], 'image/jpeg', 0.92);
  assert.equal(urls.length, 5);
  assert.equal(encodeCount, 2, 'identical canvas references encoded only once across copies');
  api.pbReleaseCanvasList([c1, c1, c2, null, c1]);
  assert.deepEqual(released, ['p1', 'p2'], 'each unique canvas released once');
  assert.equal(c1.width, 0);
  assert.equal(c2.width, 0);
});

test('booth.html: edgeAdjust releases its temporary full-size canvas', () => {
  const a = html.indexOf('function edgeAdjust(c)');
  const b = html.indexOf('function reapplyFiltersToShots()', a);
  assert.ok(a > 0 && b > a, 'edgeAdjust block found');
  const created = [], released = [];
  const doc = {
    createElement: () => {
      const cv = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      created.push(cv);
      return cv;
    }
  };
  const edgeAdjust = new Function(
    'document', 'cleanEdges', 'printPrefs', 'printSize', 'isReceiptPaper', 'paperFor', 'pbReleaseCanvas',
    html.slice(a, b) + '; return edgeAdjust;'
  )(
    doc, (e) => e, { edges: { t: 2, b: 2, l: 2, r: 2 } }, '4x6', () => false, () => ({ w: 101.6, h: 152.4 }),
    (cv) => { released.push(cv); cv.width = 0; cv.height = 0; }
  );
  const page = { width: 1200, height: 1800, getContext: () => ({ save() {}, setTransform() {}, fillRect() {}, drawImage() {}, restore() {} }) };
  edgeAdjust(page);
  assert.equal(created.length, 1, 'edgeAdjust creates 1 temp canvas');
  assert.equal(released.length, 1, 'edgeAdjust releases its temp canvas');
  assert.equal(created[0].width, 0, 'temp canvas backing store zeroed');
  assert.equal(page._pbEdgeDone, true);
});

test('booth.html: 30s background loadMyThemes & loadProfiles skip rebuilds when data is unchanged and rebuild immediately on change', () => {
  const thA = html.indexOf('var _lastThemesLoadSig = null;');
  const thB = html.indexOf('async function loadMyThemes()', thA);
  assert.ok(thA > 0 && thB > thA, 'rebuildThemesIfChanged found');
  let catsBuilt = 0, gridBuilt = 0;
  const gridEl = { children: [] };
  let curThemes = [{ id: 't1', savedAt: 100 }];
  const thApi = new Function(
    'getMyThemes', 'themeIdAt', 'themeGridEl', 'buildThemeCats', 'buildThemeGrid',
    'var myThemes; ' + html.slice(thA, thB).replace(/myThemes/g, 'getMyThemes()') + '; return { rebuildThemesIfChanged };'
  )(
    () => curThemes, (t) => t.id + '@' + t.savedAt, gridEl,
    () => { catsBuilt++; },
    () => { gridBuilt++; gridEl.children = [{}]; }
  );
  thApi.rebuildThemesIfChanged();
  assert.equal(gridBuilt, 1, 'initial load builds theme grid once');
  thApi.rebuildThemesIfChanged();
  thApi.rebuildThemesIfChanged();
  assert.equal(gridBuilt, 1, 'unchanged 30s polls do NOT rebuild theme grid');
  assert.equal(catsBuilt, 1, 'unchanged 30s polls do NOT rebuild theme categories');
  curThemes = [{ id: 't1', savedAt: 100 }, { id: 't2', savedAt: 200 }];
  thApi.rebuildThemesIfChanged();
  assert.equal(gridBuilt, 2, 'changed themes trigger immediate rebuild');

  const prA = html.indexOf('var _lastProfilesLoadSig = null;');
  const prB = html.indexOf('async function loadProfiles()', prA);
  assert.ok(prA > 0 && prB > prA, 'renderProfilesIfChanged found');
  let profsRendered = 0;
  const listEl = { children: [] };
  let curProfs = [{ id: 'p1', savedAt: 10 }];
  const prApi = new Function(
    'document', 'getProfs', 'profIdAt', 'profActive', 'profUndo', 'renderProfiles', 'refreshProfChip',
    html.slice(prA, prB).replace(/setupProfiles/g, 'getProfs()') + '; return { renderProfilesIfChanged };'
  )(
    { getElementById: () => listEl }, () => curProfs, (p) => p.id + '@' + p.savedAt, null, null,
    () => { profsRendered++; listEl.children = [{}]; }, () => {}
  );
  prApi.renderProfilesIfChanged();
  prApi.renderProfilesIfChanged();
  prApi.renderProfilesIfChanged();
  assert.equal(profsRendered, 1, 'unchanged 30s polls do NOT rebuild profile list');
  curProfs = [{ id: 'p1', savedAt: 20 }];
  prApi.renderProfilesIfChanged();
  assert.equal(profsRendered, 2, 'updated profile triggers immediate re-render');
});

test('booth.html: save/print collision guards, all canvas releases, and memory-pressure cleanup wired', () => {
  assert.ok(/let _pbActiveSavePromise = null;/.test(html), '_pbActiveSavePromise tracks active composite save');
  assert.ok(/var _pbLastPrintSentAt = 0;/.test(html), '_pbLastPrintSentAt tracks AirPrint handoff cooldown');
  assert.ok(/if \(\(IS_IOS_APP \|\| isLowRamIos\(\)\) && _pbActiveSavePromise\)/.test(html), 'printCurrentPhoto waits briefly for composite save before allocating print canvases');
  assert.ok(/if \(!keepPagesForQueue\) releasePages\(\);/.test(html), 'printCurrentPhoto releases print canvases in finally');
  assert.ok(/pbReleaseCanvas\(strip\);/.test(html), 'buildKeychainSheets releases strip canvas');
  assert.ok(/if \(rotTmp\) pbReleaseCanvas\(rotTmp\);/.test(html), 'buildPlainPrint releases rotated temp canvas');
  assert.ok(/pbReleaseCanvas\(s\);\s*\}\s*var fx = VINTAGE_FX/.test(html), 'applyFilterToCanvas releases soft-skin temp canvas');
  assert.ok(/if \(pg && pg !== cv\) pbReleaseCanvas\(pg\);/.test(html), 'wifiPhotoJob releases L8050 bleed canvas');
  assert.ok(/const browserPrintMime = isMobileOS\(\) \? 'image\/jpeg' : 'image\/png';/.test(html), 'mobile Safari window.print uses compact JPEG instead of PNG');
  assert.ok(/window\.addEventListener\('pb-memory-pressure'[\s\S]*?_lutSwatchCache[\s\S]*?filterThumbScratch/.test(html), 'pb-memory-pressure clears LUT swatches and filterThumbScratch');
});

test('booth.html: pb-memory-pressure handler reclaims idle canvases and caches without harming active backgroundImg', () => {
  const start = html.indexOf("window.addEventListener('pb-memory-pressure'");
  const end = html.indexOf('let mainIndex = 0;', start);
  assert.ok(start > 0 && end > start, 'pb-memory-pressure listener found');
  let listener = null;
  let ringReleased = false, phReleased = false;
  const activeBg = { id: 'active-bg' };
  const bgCache = { a: activeBg, b: { id: 'stale-bg' } };
  const lutCache = { k1: 'data:image/png;base64,1' };
  let scratch = { width: 72, height: 72 };
  const preview = { width: 1800, height: 2700, style: { display: 'none' }, _renderedForLayout: 'strip' };
  let pmSamples = [{ a: 1 }];
  const fn = new Function(
    'window', 'webcamReleaseRingPool', '_pbBgImgCache', 'backgroundImg', '_lutSwatchCache',
    'getScratch', 'setScratch', 'pbReleaseCanvas', 'state', 'previewCanvas', 'pbReleasePlaceholderCache', 'getPm', 'setPm',
    'var filterThumbScratch = getScratch(), pmMakerSamples = getPm(); ' +
    html.slice(start, end) +
    '; return { sync: () => { setScratch(filterThumbScratch); setPm(pmMakerSamples); } };'
  )(
    { addEventListener: (_ev, cb) => { listener = cb; } },
    () => { ringReleased = true; },
    bgCache, activeBg, lutCache,
    () => scratch, (v) => { scratch = v; },
    (cv) => { if (cv) { cv.width = 0; cv.height = 0; } },
    'idle', preview, () => { phReleased = true; },
    () => pmSamples, (v) => { pmSamples = v; }
  );
  assert.ok(typeof listener === 'function', 'listener registered');
  listener();
  fn.sync();
  assert.equal(ringReleased, true, 'ring pool released');
  assert.equal(phReleased, true, 'placeholder cache released');
  assert.equal(bgCache.a, activeBg, 'active backgroundImg preserved');
  assert.equal('b' in bgCache, false, 'unused bg cache entry removed');
  assert.deepEqual(Object.keys(lutCache), [], 'LUT swatch cache cleared');
  assert.equal(scratch, null, 'filterThumbScratch released & nulled');
  assert.equal(preview.width, 0, 'hidden idle previewCanvas zeroed');
  assert.equal(preview._renderedForLayout, '', 'previewCanvas layout marker cleared');
  assert.equal(pmSamples, null, 'pmMakerSamples cleared');
});

test('booth.html: offlineJpegQuality trims 3 GB iPad QR/solo payloads (0.90/0.88) while keeping 4 GB+ iPads & Desktop intact', () => {
  const a = html.indexOf('function offlineJpegQuality(');
  const b = html.indexOf('const STRIP_W =', a);
  assert.ok(a > 0 && b > a, 'offlineJpegQuality block found');
  const runQ = (opts, kind) => new Function(
    'window', 'LOCALSHARE', 'DESKTOP', 'LANREMOTE',
    html.slice(a, b) + '; return offlineJpegQuality(arguments[4]);'
  )(opts.win, opts.localshare, opts.desktop, opts.lanremote, kind);

  assert.equal(runQ({ win: { __PB: { ios: true, iosLowRam: true } }, localshare: true, desktop: false, lanremote: false }, 'print'), 0.90, '3 GB iPad composite QR JPEG quality is 0.90');
  assert.equal(runQ({ win: { __PB: { ios: true, iosLowRam: true } }, localshare: true, desktop: false, lanremote: false }, 'solo'), 0.88, '3 GB iPad solo JPEG quality is 0.88');
  assert.equal(runQ({ win: { __PB: { ios: true, iosLowRam: false } }, localshare: true, desktop: false, lanremote: false }, 'print'), 0.95, '4 GB+ iPad keeps 0.95');
  assert.equal(runQ({ win: { __PB: { ios: true, iosLowRam: false } }, localshare: true, desktop: false, lanremote: false }, 'solo'), 0.95, '4 GB+ iPad solo keeps 0.95');
  assert.equal(runQ({ win: {}, localshare: true, desktop: true, lanremote: false }, 'print'), 1, 'Desktop keeps 1.0');
  assert.equal(runQ({ win: { __PB: { ios: true, iosLowRam: true } }, localshare: false, desktop: false, lanremote: false }, 'print'), 0.95, 'Online mode keeps 0.95');
});

test('booth.html: lazy deferred solo saves clone 1-at-a-time AFTER printing and snapshot remaining shots if Next Guest interrupts', async () => {
  const a = html.indexOf('function cloneShotForSolo(c)');
  const b = html.indexOf('var GV_CODE_RE =', a);
  assert.ok(a > 0 && b > a, 'solo save block found');

  let liveClones = 0, peakClones = 0, clonedDuringPrint = 0;
  const mkCanvas = (w = 0, h = 0, tag = '') => ({
    width: w, height: h, tag,
    getContext: () => ({ fillStyle: '', imageSmoothingEnabled: true, imageSmoothingQuality: '', fillRect() {}, drawImage() {} })
  });
  const doc = {
    createElement: () => {
      const cv = mkCanvas(0, 0, 'temp');
      return cv;
    }
  };
  const st = { printing: true, lastPrintAt: 0, autoPendingUntil: 0, uploaded: [], liveShotsReleased: false };
  const api = new Function(
    'document', 'isLowRamIos', 'IS_IOS_APP', 'saveSoloPhotos', 'sessionNumber', 'rawFolderKey', 'driveSubfolder',
    'filePrefix', 'deviceTag', 'soloOriginal', 'pbCanvasBlob', 'offlineJpegQuality', 'pbReleaseCanvas', 'pbReleaseShotCanvas',
    'backupDir', 'backupOk', 'DESKTOP_ONLINE', 'driveReady', 'LOCALSHARE', 'navigator', 'uploadToDrive', 'queueUpload',
    'wait', 'softSkin', 'filterKey', 'dateStamp', 'getState', 'onCloneStart', 'onCloneRelease',
    'var printing, _pbLastPrintSentAt, _pbAutoPrintPendingUntil;' +
    html.slice(a, b)
      .replace(/if \(typeof printing !== 'undefined' && printing\)/g, 'if (getState().printing)')
      .replace(/for \(var pw = 0; pw < 80 && printing; pw\+\+\)/g, 'for (var pw = 0; pw < 80 && getState().printing; pw++)')
      .replace(/typeof _pbLastPrintSentAt === 'number' && _pbLastPrintSentAt > 0/g, 'getState().lastPrintAt > 0')
      .replace(/Date\.now\(\) - _pbLastPrintSentAt/g, 'Date.now() - getState().lastPrintAt')
      .replace(/typeof _pbAutoPrintPendingUntil === 'number' && _pbAutoPrintPendingUntil > Date\.now\(\)/g, 'getState().autoPendingUntil > Date.now()')
      .replace(/_pbAutoPrintPendingUntil > Date\.now\(\) && !\(typeof printing !== 'undefined' && printing\)/g, 'getState().autoPendingUntil > Date.now() && !getState().printing')
      .replace(/return clone;/, 'onCloneStart(clone); return clone;') +
    '; return { cloneShotForSolo, saveSoloPhotosAsync, pbSnapshotDeferredSoloShots };'
  )(
    doc, () => true, true, true, 12, () => 'ev', () => '', () => '', () => '',
    async () => null, async () => ({ size: 100 }), () => 0.88,
    (cv) => { if (cv) { cv.width = 0; cv.height = 0; } },
    (cv) => { if (cv) { if (cv._isSoloClone) liveClones = Math.max(0, liveClones - 1); cv.width = 0; cv.height = 0; } },
    null, false, false, () => true, true, { onLine: true },
    async (_blob, name) => {
      st.uploaded.push({ name, printingDuringUpload: st.printing, liveClones });
      // After shot 1 uploads, simulate the guest immediately tapping "Next guest" (releasing shotCanvases!)
      if (st.uploaded.length === 1 && st.onAfterFirstUpload) st.onAfterFirstUpload();
    },
    async () => {},
    (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 4))),
    false, 'none', false, () => st,
    (cv) => { cv._isSoloClone = true; liveClones++; if (liveClones > peakClones) peakClones = liveClones; if (st.printing) clonedDuringPrint++; },
    () => { liveClones = Math.max(0, liveClones - 1); }
  );

  // Scenario A: normal 4-shot lazy solo save while printing is active -> 0 clones during print, peak 1 clone after print!
  const shotsA = [mkCanvas(1920, 1440, 's1'), mkCanvas(1920, 1440, 's2'), mkCanvas(1920, 1440, 's3'), mkCanvas(1920, 1440, 's4')];
  setTimeout(() => { st.printing = false; st.lastPrintAt = Date.now() - 2600; }, 10);
  await api.saveSoloPhotosAsync(12, shotsA, { lazySource: true });
  assert.equal(clonedDuringPrint, 0, 'ZERO solo canvases cloned while printing is true');
  assert.equal(peakClones, 1, 'peak concurrent solo clone count is 1 (not 4) during normal lazy save');
  assert.equal(liveClones, 0, 'all solo clones released after completion');
  assert.equal(st.uploaded.length, 4, 'all 4 solo shots saved');
  assert.ok(shotsA.every((s) => s.width === 1920), 'live shotCanvases were NOT zeroed by lazy solo save');

  // Scenario B: guest taps Next Guest right after solo #1 finishes -> remaining 3 shots are snapshotted before shotCanvases are zeroed!
  st.uploaded = [];
  liveClones = 0; peakClones = 0; clonedDuringPrint = 0;
  const shotsB = [mkCanvas(1920, 1440, 'b1'), mkCanvas(1920, 1440, 'b2'), mkCanvas(1920, 1440, 'b3'), mkCanvas(1920, 1440, 'b4')];
  st.onAfterFirstUpload = () => {
    st.onAfterFirstUpload = null;
    api.pbSnapshotDeferredSoloShots(shotsB);
    for (let k = 0; k < shotsB.length; k++) { shotsB[k].width = 0; shotsB[k].height = 0; shotsB[k] = null; }
  };
  await api.saveSoloPhotosAsync(13, shotsB, { lazySource: true });
  assert.equal(st.uploaded.length, 4, 'all 4 solo shots still saved even when Next Guest cleared shotCanvases after shot 1');
  assert.equal(liveClones, 0, 'all pre-release snapshotted solo clones released cleanly');
});

test('booth.html: buildPrintCanvas reuses previewCanvas without duplicate composite allocation or zeroing previewCanvas', () => {
  const a = html.indexOf('function buildPrintCanvas(key)');
  const b = html.indexOf('function buildStripPages(key)', a);
  assert.ok(a > 0 && b > a, 'buildPrintCanvas block found');

  let renderCompositeCalls = 0, canvasesCreated = 0, previewReleased = false;
  const preview = { width: 1800, height: 2700, _renderedForLayout: 'grid4', _renderedSession: 5 };
  const doc = {
    createElement: () => {
      canvasesCreated++;
      return {
        width: 0, height: 0,
        getContext: () => ({ fillStyle: '', imageSmoothingQuality: '', fillRect() {}, drawImage() {}, translate() {}, rotate() {} })
      };
    }
  };
  const buildPrintCanvas = new Function(
    'plainResult', 'paperFor', 'canReusePreviewCanvas', 'currentLayout', 'previewCanvas', 'document',
    'renderCompositeToCanvas', 'btPrintCanvas', 'pbReleaseCanvas', 'RECEIPT_W', 'layoutDef',
    'helperOn', 'printPrefs', 'canonDpiFor', 'l8050DpiFor', 'l3210DpiFor', 'PRINT_DPI',
    'sizedPhoto', 'isDyeSubPrinter', 'printerFor', 'stripTwoUp', 'drawFitted', 'drawPhotoOnSheet',
    'var receiptPrintGrey = false, receiptPrint58 = false; ' + html.slice(a, b) + '; return buildPrintCanvas;'
  )(
    false, () => ({ w: 101.6, h: 152.4, receipt: false }), () => true, 'grid4', preview, doc,
    () => { renderCompositeCalls++; }, (s) => s,
    (cv) => { if (cv === preview) previewReleased = true; if (cv) { cv.width = 0; cv.height = 0; } },
    576, () => ({ kind: 'sheet' }), false, {}, () => 0, () => 0, () => 0, 300,
    () => false, () => false, () => '', () => false, () => {}, () => {}
  );

  const page = buildPrintCanvas('4x6');
  assert.equal(renderCompositeCalls, 0, 'buildPrintCanvas skips redundant renderCompositeToCanvas when previewCanvas matches');
  assert.equal(canvasesCreated, 1, 'only allocates the 1 final print sheet canvas (not a duplicate 1800x2700 src)');
  assert.equal(page.width, 1200);
  assert.equal(page.height, 1800);
  assert.equal(previewReleased, false, 'buildPrintCanvas NEVER releases previewCanvas');
  assert.equal(preview.width, 1800, 'previewCanvas stays intact for screen display');
});

test('booth.html: qrPopDrawPhoto caps dpr<=1.5 on 3 GB iPads, skips unchanged redraws, and qrPopEnd releases #qrPopPhoto', () => {
  const a = html.indexOf('var qrPop = { phase:');
  const b = html.indexOf('function showShotReview(i)', a);
  assert.ok(a > 0 && b > a, 'qrPop block found');

  let draws = 0;
  const qpc = { width: 0, height: 0, style: {}, getContext: () => ({ drawImage() { draws++; } }) };
  const ov = { hidden: true, className: '' };
  const preview = { width: 1800, height: 2700, _renderedForLayout: 'grid4', _renderedSession: 2, _renderedBack: false };
  const api = new Function(
    'document', 'window', 'previewCanvas', 'isLowRamIos', 'pbReleaseCanvas', 'qrPopOn', 'state',
    'qrMatchWelcome', 'qrPopDelay', 'qrSection', 'printFirstHolding', 'scheduleResultReset',
    'refreshPanelSolo', 'applyStageAspect', 'syncResultTheme', 'runResultTimerBar', 'resultTimer',
    html.slice(a, b) + '; return { qrPopDrawPhoto, qrPopEnd, qrPop };'
  )(
    { getElementById: (id) => (id === 'qrPopPhoto' ? qpc : id === 'qrPopOv' ? ov : null), body: { classList: { add() {}, remove() {} } } },
    { innerWidth: 810, innerHeight: 1080, devicePixelRatio: 2, addEventListener() {} },
    preview, () => true, (cv) => { cv.width = 0; cv.height = 0; },
    true, 'result', false, 3, { parentNode: null }, false, () => {}, () => {}, () => {}, () => {}, () => {}, 0
  );

  api.qrPopDrawPhoto(true);
  assert.equal(draws, 1, 'initial draw paints #qrPopPhoto once');
  // 810*0.96=777.6, 1080*0.94=1015.2, a=2/3 -> w=676.8, h=1015.2 -> at dpr=1.5: pw=1015, ph=1523 (vs 1354x2030 at dpr=2)
  assert.ok(qpc.width <= 1050 && qpc.height <= 1550, '3 GB iPad caps #qrPopPhoto to dpr<=1.5 (' + qpc.width + 'x' + qpc.height + ')');
  api.qrPopDrawPhoto(false);
  api.qrPopDrawPhoto(false);
  assert.equal(draws, 1, 'unchanged 500ms interval ticks skip redundant GPU drawImage');
  api.qrPopEnd();
  assert.equal(qpc.width, 0, 'qrPopEnd releases #qrPopPhoto width');
  assert.equal(qpc.height, 0, 'qrPopEnd releases #qrPopPhoto height');
});

test('booth.html & Swift: early flat release, GIF collision guard, temp canvas releases, and Swift autoreleasepool hygiene', () => {
  assert.ok(/if \(needsFlatAfterBlob\) \{\s*flat\._pbFlatDone = releaseFlat;\s*\} else \{\s*\/\/ Release the flattened composite canvas[\s\S]*?pbReleaseCanvas\(flat\);/.test(html), 'uploadLayoutForQR frees flat canvas BEFORE base64 & pbSave IPC when master/cuts not needed');
  assert.ok(/saveSoloPhotosAsync\(soloSessionNum, shotCanvases, \{ lazySource: true \}\)/.test(html), 'showQRForCurrentPhoto uses lazy solo saving on 3 GB iPads');
  assert.ok(/if \(typeof pbSnapshotDeferredSoloShots === 'function'\)/.test(html), 'pbReleaseShotList snapshots pending lazy solo shots before zeroing');
  assert.ok(/function showQRForCurrentGIF\(\)[\s\S]*?if \(IS_IOS_APP \|\| isLowRamIos\(\)\)[\s\S]*?_pbActiveSavePromise[\s\S]*?_pbLastPrintSentAt/.test(html), 'showQRForCurrentGIF yields to active composite save & print on iOS/low-RAM iPads');
  assert.ok(/function shotThumb\(shot\)[\s\S]*?finally \{\s*pbReleaseCanvas\(t\);\s*\}/.test(html), 'shotThumb releases temp canvas');
  assert.ok(/function shotReviewUrl\(shot, i\)[\s\S]*?finally \{\s*pbReleaseCanvas\(t\);\s*\}/.test(html), 'shotReviewUrl releases temp canvas');
  assert.ok(/async function printExtraSheet\(sec\)[\s\S]*?finally \{\s*pbReleaseCanvas\(c\);\s*\}/.test(html), 'printExtraSheet releases sheet canvas');
  assert.ok(/helperPages\.forEach\(\(hc, idx\) => \{ if \(hc && hc !== pages\[idx\]\) pbReleaseCanvas\(hc\); \}\);/.test(html), 'printViaHelper releases receipt gray temp canvases');
  assert.ok(/let outcome: DriveOutcome = autoreleasepool \{/.test(localSwift), 'PBLocal.drive isolates base64/JSON/disk write inside tight autoreleasepool');
  assert.ok(/let req: URLRequest = autoreleasepool \{[\s\S]*?r\.httpBody = b\.data\(using: \.utf8\)/.test(vcSwift), 'ViewController.handleLanHttpRequest scopes POST UTF-8 encoding inside autoreleasepool');
  assert.ok(/let sentBytes: Int = autoreleasepool \{[\s\S]*?fh\.readData\(ofLength: chunkSize\)/.test(shareSwift), 'LocalShareServer.sendFileResponse wraps per-chunk FileHandle reads in autoreleasepool');
});

for (const { name, fn } of asyncQueue) {
  try {
    await fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.error('FAIL: ' + name + '\n  ' + ((e && e.stack) || e));
    process.exitCode = 1;
  }
}
console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
