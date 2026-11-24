// Tests for the Wi-Fi / Wi-Fi Direct Printer Diagnostic Engine (Android/Desktop/Web),
// Epson L8050 IPP fixes (media-type inside media-col, print-scaling fallback, Get-Job-Attributes),
// ESC/P-R L8050 720dpi/360dpi High Glossy builder, and /printer-test/ online tester.
// Run: node desktop/test/test-wifi-printer-diag.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ippPrintJobRequest, parseIppGrouped, extractUnsupported,
  ippDiagProbe, ippDiagPrint
} from '../lib/netprinters.mjs';
import { initHelper, handleHelper, stopHelper } from '../lib/helper.mjs';
import { assemble } from '../../scripts/assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
}

// ---- helpers to craft IPP binary replies for our mock Epson L8050 ----
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u16(b.length), b]); };
const attr = (tag, name, val) => Buffer.concat([Buffer.from([tag]), str(name), str(val)]);
const intAttr = (tag, name, v) => Buffer.concat([Buffer.from([tag]), str(name), u16(4), u32(v)]);
const mem = (name) => Buffer.concat([Buffer.from([0x4a]), u16(0), str(name)]);
const memInt = (name, v) => Buffer.concat([mem(name), Buffer.from([0x21]), u16(0), u16(4), u32(v)]);
const memKw = (name, v) => Buffer.concat([mem(name), Buffer.from([0x44]), u16(0), str(v)]);
const BEG = Buffer.from([0x34, 0, 0, 0, 0]);
const END = Buffer.from([0x37, 0, 0, 0, 0]);

function mockL8050AttrsReply() {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01]),
    attr(0x47, 'attributes-charset', 'utf-8'),
    attr(0x48, 'attributes-natural-language', 'en'),
    Buffer.from([0x04]),
    attr(0x41, 'printer-make-and-model', 'EPSON L8050 Series'),
    intAttr(0x23, 'printer-state', 3),
    attr(0x44, 'printer-state-reasons', 'none'),
    attr(0x49, 'document-format-supported', 'image/jpeg'),
    attr(0x49, '', 'application/octet-stream'),
    attr(0x44, 'media-supported', 'na_index-4x6_4x6in'),
    attr(0x44, '', 'iso_a4_210x297mm'),
    attr(0x44, 'media-ready', 'na_index-4x6_4x6in'),
    intAttr(0x21, 'media-top-margin-supported', 0),
    intAttr(0x21, '', 300),
    intAttr(0x21, 'media-left-margin-supported', 0),
    attr(0x44, 'media-col-supported', 'media-size'),
    attr(0x44, '', 'media-type'),
    attr(0x44, '', 'media-top-margin'),
    // media-col-database entry #1: 4x6 borderless glossy
    Buffer.from([0x34]), str('media-col-database'), u16(0),
    mem('media-size'), BEG, memInt('x-dimension', 10160), memInt('y-dimension', 15240), END,
    memInt('media-top-margin', 0), memInt('media-left-margin', 0),
    memKw('media-type', 'photographic-glossy'), memKw('media-source', 'main'),
    END,
    // media-col-database entry #2: A4 plain
    Buffer.from([0x34]), u16(0), u16(0),
    mem('media-size'), BEG, memInt('x-dimension', 21000), memInt('y-dimension', 29700), END,
    memInt('media-top-margin', 300), memInt('media-left-margin', 300),
    memKw('media-type', 'stationery'), memKw('media-source', 'main'),
    END,
    Buffer.from([0x03])
  ]);
}

function startMockL8050() {
  let jobPolls = 0;
  const ippSrv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (d) => chunks.push(d));
    rq.on('end', () => {
      const body = Buffer.concat(chunks);
      if (rq.url !== '/ipp/print') { rs.writeHead(404).end(); return; }
      const op = body.readUInt16BE(2);
      if (op === 0x000b) {
        rs.writeHead(200, { 'content-type': 'application/ipp' }).end(mockL8050AttrsReply());
        return;
      }
      if (op === 0x0009) {
        // Get-Job-Attributes: processing first, then completed
        jobPolls++;
        const st = jobPolls >= 2 ? 9 : 5;
        const reason = st === 9 ? 'job-completed-successfully' : 'job-printing';
        const rep = Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 2, 0x02]),
          intAttr(0x23, 'job-state', st),
          attr(0x44, 'job-state-reasons', reason),
          Buffer.from([0x03])
        ]);
        rs.writeHead(200, { 'content-type': 'application/ipp' }).end(rep);
        return;
      }
      // Inspect parsed attributes for Validate-Job (0x0004) and Print-Job (0x0002)
      const parsed = parseIppGrouped(body);
      const hasTopMediaType = parsed.some((a) => a.group === 0x02 && a.name === 'media-type');
      const scalingAttr = parsed.find((a) => a.group === 0x02 && a.name === 'print-scaling');
      const scalingVal = scalingAttr ? scalingAttr.value.toString('utf8') : '';
      if (hasTopMediaType) {
        // Strict IPP: reject non-standard top-level media-type with 0x040b + unsupported group 0x05
        const rep = Buffer.concat([
          Buffer.from([0x02, 0x00, 0x04, 0x0b, 0, 0, 0, 1, 0x01]),
          attr(0x41, 'status-message', 'media-type must be inside media-col'),
          Buffer.from([0x05]),
          attr(0x10, 'media-type', ''),
          Buffer.from([0x03])
        ]);
        rs.writeHead(200, { 'content-type': 'application/ipp' }).end(rep);
        return;
      }
      if (scalingVal === 'none') {
        // Simulates printer accepting with 0x0001 and ignoring print-scaling=none
        const rep = Buffer.concat([
          Buffer.from([0x02, 0x00, 0x00, 0x01, 0, 0, 0, 1, 0x05]),
          attr(0x44, 'print-scaling', 'none'),
          ...(op === 0x0002 ? [Buffer.from([0x02]), intAttr(0x21, 'job-id', 42)] : []),
          Buffer.from([0x03])
        ]);
        rs.writeHead(200, { 'content-type': 'application/ipp' }).end(rep);
        return;
      }
      const rep = Buffer.concat([
        Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1]),
        ...(op === 0x0002 ? [Buffer.from([0x02]), intAttr(0x21, 'job-id', 42)] : []),
        Buffer.from([0x03])
      ]);
      rs.writeHead(200, { 'content-type': 'application/ipp' }).end(rep);
    });
  });
  const rawSrv = net.createServer((sock) => { sock.on('data', () => {}); });
  return Promise.all([
    new Promise((r) => ippSrv.listen(0, '127.0.0.1', r)),
    new Promise((r) => rawSrv.listen(0, '127.0.0.1', r))
  ]).then(() => ({
    ippPort: ippSrv.address().port,
    rawPort: rawSrv.address().port,
    close: () => { ippSrv.close(); rawSrv.close(); }
  }));
}

await test('ippPrintJobRequest supports Validate-Job (0x0004) and mediaTypeMode col vs top', () => {
  const colBuf = ippPrintJobRequest({
    uri: 'ipp://192.168.223.1:631/ipp/print', opCode: 0x0004, wMm: 101.6, hMm: 152.4,
    quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: ''
  });
  assert.equal(colBuf.readUInt16BE(2), 0x0004, 'Validate-Job opcode');
  const colAttrs = parseIppGrouped(colBuf);
  assert.ok(!colAttrs.some((a) => a.name === 'media-type'), 'media-type is inside media-col, not top-level');
  assert.ok(colAttrs.some((a) => a.tag === 0x4a && a.value.toString('utf8') === 'media-type'), 'media-type member present in media-col');

  const topBuf = ippPrintJobRequest({
    uri: 'ipp://192.168.223.1:631/ipp/print', opCode: 0x0004, wMm: 101.6, hMm: 152.4,
    quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'top', scaling: 'none'
  });
  const topAttrs = parseIppGrouped(topBuf);
  assert.ok(topAttrs.some((a) => a.group === 0x02 && a.name === 'media-type'), 'explicit top mode emits top-level media-type');
});

await test('ippDiagProbe detects ports, dumps media-col-database, and runs Validate-Job matrix accurately', async () => {
  const srv = await startMockL8050();
  try {
    const res = await ippDiagProbe({ ip: '127.0.0.1', port: srv.ippPort, rawPort: srv.rawPort, appVersion: 'test-1.0' });
    assert.equal(res.ok, true);
    assert.equal(res.reachable, true);
    assert.equal(res.ports['631'].open, true);
    assert.equal(res.ports['9100'].open, true);
    assert.equal(res.ipp.answered, true);
    assert.equal(res.ipp.path, '/ipp/print');
    assert.equal(res.ipp.attrs['printer-make-and-model'][0], 'EPSON L8050 Series');
    assert.equal(res.ipp.mediaColDbCount, 2, 'counted both media-col-database entries');
    assert.ok(res.ipp.mediaColDbMediaTypes.includes('photographic-glossy'));
    assert.ok(res.ipp.mediaColDb4x6Samples.some((s) => s.includes('10160x15240') && s.includes('m=(0,0)')));

    const byId = Object.fromEntries(res.validateMatrix.map((x) => [x.id, x]));
    assert.equal(byId['ipp-top-q5-glossy-scNone'].ok, false, 'old top-level media-type rejected');
    assert.ok(byId['ipp-top-q5-glossy-scNone'].unsupported.includes('media-type'));
    assert.equal(byId['ipp-col-q5-glossy-scNone'].ok, true, 'scaling=none accepted with 0x0001');
    assert.equal(byId['ipp-col-q5-glossy-scNone'].clean, false, 'flagged WARN because print-scaling ignored');
    assert.ok(byId['ipp-col-q5-glossy-scNone'].unsupported.some((u) => u.includes('print-scaling')));
    assert.equal(byId['ipp-col-q5-glossy-noSc'].clean, true, 'media-col + q=5 + glossy + no scaling is CLEAN');
    assert.ok(res.recommendation.includes('ipp-col-q5-glossy-noSc'), 'recommendation picks clean winner');
    assert.ok(res.recommendation.includes('old top-level'), 'recommendation flags old ca4428a failure');
  } finally { srv.close(); }
});

await test('ippDiagPrint sends Print-Job and polls Get-Job-Attributes until completed', async () => {
  const srv = await startMockL8050();
  try {
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
    const res = await ippDiagPrint({
      ip: '127.0.0.1', port: srv.ippPort, path: '/ipp/print', protocol: 'ipp',
      imageBase64: tinyJpeg, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: '', pollSeconds: 6
    });
    assert.equal(res.ok, true);
    assert.equal(res.jobId, 42);
    assert.deepEqual(res.unsupported, []);
    assert.ok(res.jobStates.some((s) => s.stateName === 'processing'), 'captured processing state');
    assert.ok(res.jobStates.some((s) => s.stateName === 'completed'), 'captured completed state');
  } finally { srv.close(); }
});

await test('Desktop handleHelper exposes /printer/diag/info, /probe, /print and status.printerDiag', async () => {
  initHelper({ workerPath: '', logger: () => {} });
  const srv = await startMockL8050();
  try {
    const st = await (await handleHelper({ method: 'GET' }, '/status', new URLSearchParams())).json();
    assert.equal(st.printerDiag, true);
    const info = await (await handleHelper({ method: 'GET' }, '/printer/diag/info', new URLSearchParams())).json();
    assert.equal(info.ok, true);
    assert.ok(Array.isArray(info.nets));
    const probe = await (await handleHelper({
      method: 'POST',
      json: async () => ({ ip: '127.0.0.1', port: srv.ippPort, rawPort: srv.rawPort })
    }, '/printer/diag/probe', new URLSearchParams())).json();
    assert.equal(probe.ok, true);
    assert.equal(probe.ipp.attrs['printer-make-and-model'][0], 'EPSON L8050 Series');
  } finally { srv.close(); stopHelper(); }
});

await test('wifi-diag.js calibration target, presets, report formatting, and offline localStorage persistence', () => {
  const src = readFileSync(join(ROOT, 'protected', 'src', 'printer', 'wifi-diag.js'), 'utf8');
  const mem = {};
  const ctx = {
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    __PBNet: { diagRunProbe: () => 'started', diagRunPrint: () => 'started', diagNetwork: () => JSON.stringify({ platform: 'android', device: 'Xiaomi Pad 5', appVersion: '1.1.98', nets: [{ iface: 'wlan0', ip: '192.168.223.2', prefix: 24, gateway: '192.168.223.1', boundNetwork: true, wifiDirectHint: true }] }) },
    setTimeout, clearTimeout
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  const wd = ctx._wifiDiag;
  assert.ok(wd && wd.isAvailable());
  assert.ok(wd.PRESETS.some((p) => p.id === 'ipp_rec' && p.mediaTypeMode === 'col' && p.scaling === ''));
  assert.ok(wd.PRESETS.some((p) => p.id === 'lpd_l8050_360' && p.protocol === 'lpd' && p.port === 515 && p.queue === 'PASSTHRU' && p.dpi === 360 && p.mediaCode === 0x34 && p.sendSetm === false));
  assert.ok(wd.PRESETS.some((p) => p.id === 'lpd_l8050_360_pg' && p.protocol === 'lpd' && p.port === 515 && p.mediaCode === 0x0b && p.sendSetm === false));
  assert.ok(wd.PRESETS.some((p) => p.id === 'lpd_l8050_720' && p.protocol === 'lpd' && p.port === 515 && p.queue === 'PASSTHRU' && p.dpi === 720 && p.mediaCode === 0x34 && p.sendSetm === false));
  assert.ok(wd.PRESETS.some((p) => p.id === 'escpr_l8050_720' && p.dpi === 720 && p.mediaCode === 0x34 && p.qualityCode === 2));

  // Mock 2D canvas to verify buildCalibrationCanvas dimensions and drawing calls
  const ops = [];
  const mkCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
      fillRect: (...a) => ops.push(['fillRect', ...a]),
      strokeRect: (...a) => ops.push(['strokeRect', ...a]),
      beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => ops.push(['stroke']),
      fillText: (t) => ops.push(['text', t]),
      save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} })
    })
  });
  const cv = wd.buildCalibrationCanvas(101.6, 152.4, 'IPP media-col q=5', '192.168.223.1', mkCanvas);
  assert.equal(cv.width, 1200, '4 in at 300 dpi');
  assert.equal(cv.height, 1800, '6 in at 300 dpi');
  assert.ok(ops.some((o) => o[0] === 'text' && String(o[1]).includes('TOP EDGE')));
  assert.ok(ops.some((o) => o[0] === 'text' && String(o[1]).includes('SHARPNESS & BANDING')));

  const report = wd.formatReport({
    ip: '192.168.223.1', route: 'bound-network:wlan0(192.168.223.2/24)',
    ports: { 631: { open: true, ms: 12 }, 9100: { open: true, ms: 10 } },
    ipp: { answered: true, path: '/ipp/print', ms: 40, ippStatus: 'successful-ok', attrCount: 30, bodyBytes: 2048, attrs: { 'printer-make-and-model': ['EPSON L8050 Series'] }, mediaColDbCount: 2, mediaColDbMediaTypes: ['photographic-glossy'], mediaColDb4x6Samples: ['10160x15240 m=(0,0) mt=photographic-glossy'] },
    validateMatrix: [{ id: 'ipp-col-q5-glossy-noSc', ok: true, clean: true, http: 200, ippHex: '0x0', ippName: 'successful-ok', unsupported: [], ms: 18 }],
    recommendation: 'Cleanest IPP Validate-Job winner: ipp-col-q5-glossy-noSc'
  }, [{ presetId: 'escpr_l8050_720', protocol: 'escpr', ok: true, bytes: 950000, sendMs: 320, buildMs: 410, replyBytes: 0, config: { dpi: 720, mediaHex: '0x34', qualityCode: 2 } }]);
  assert.ok(report.includes('EPSON L8050 Series') && report.includes('[CLEAN] ipp-col-q5-glossy-noSc') && report.includes('escpr_l8050_720'));
  const lpdReport = wd.formatReport({
    ip: '192.168.223.1', route: 'bound-network:wlan0(192.168.223.11/24)',
    ports: { 631: { open: false, ms: 17 }, 9100: { open: false, ms: 17 }, 515: { open: true, ms: 17 }, 80: { open: true, ms: 3 } },
    webModel: 'EPSON L8050 Series',
    ipp: { answered: false },
    recommendation: 'Port 515 (LPD /PASSTHRU) is OPEN.'
  }, [{ presetId: 'lpd_l8050_360', protocol: 'lpd', port: 515, queue: 'PASSTHRU', ok: true, bytes: 1850000, sendMs: 2400, config: { dpi: 360, mediaHex: '0x34', qualityCode: 2, sendSetm: true } }]);
  assert.ok(lpdReport.includes('Model (SNMP/Web): EPSON L8050 Series') && lpdReport.includes('via LPD :515/PASSTHRU') && lpdReport.includes('lpd_l8050_360'));
  wd.saveLastReport(report);
  assert.equal(wd.loadLastReport(), report);
});

await test('Android Kotlin, iOS Swift, assembled booth.html, and /printer-test/ static checks', () => {
  const checkBraces = (file, src) => {
    let depth = 0;
    let inStr = false, inChar = false, inLineC = false, inBlockC = false, esc = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (inLineC) { if (c === '\n') inLineC = false; continue; }
      if (inBlockC) { if (c === '*' && n === '/') { inBlockC = false; i++; } continue; }
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (inChar) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === "'") inChar = false; continue; }
      if (c === '/' && n === '/') { inLineC = true; i++; continue; }
      if (c === '/' && n === '*') { inBlockC = true; i++; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === "'") { inChar = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    assert.equal(depth, 0, file + ' has unbalanced curly braces (depth=' + depth + ')');
  };

  const netKt = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/NetPrintBridge.kt'), 'utf8');
  const mainKt = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/MainActivity.kt'), 'utf8');
  const escKt = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/EscprJob.kt'), 'utf8');
  const camKt = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt'), 'utf8');
  const iosSw = readFileSync(join(ROOT, 'ios/photobooth4u/ViewController.swift'), 'utf8');
  checkBraces('NetPrintBridge.kt', netKt);
  checkBraces('MainActivity.kt', mainKt);
  checkBraces('EscprJob.kt', escKt);
  checkBraces('UsbCameraHelper.kt', camKt);
  checkBraces('ViewController.swift', iosSw);

  // Key fixes present in Android & iOS
  assert.ok(/targets\.add\(base or 1L\)/.test(netKt), 'Android sweep probes .1 Wi-Fi Direct gateway first');
  assert.ok(/s\.bind\(InetSocketAddress\(n\.addr, 0\)\)/.test(netKt), 'Android binds P2P Wi-Fi Direct local IP');
  assert.ok(/baseStd\.add\(IppAttempt\(true, true, "", ""\)\)/.test(netKt), 'Android drops print-scaling in fallback while keeping media-col + opts');
  assert.ok(/fun diagRunProbe/.test(netKt) && /fun diagRunPrint/.test(netKt) && /fun diagNetwork/.test(netKt) && /fun copyText/.test(netKt), 'Android JS bridge exposes diag & native clipboard methods');
  assert.ok(/path\.startsWith\("\/api\/printerdiag"\)/.test(mainKt), 'MainActivity allows /api/printerdiag through when online');
  assert.ok(/watchIppJob\(e, path, jobId\)/.test(netKt), 'Android polls Get-Job-Attributes after Print-Job');
  assert.ok(/MEDIA_EPSON_GLOSSY = 0x34/.test(escKt) && /fun buildWithConfig/.test(escKt), 'EscprJob supports L8050 720dpi 0x34 q=2');
  assert.ok(/path == "\/printer\/diag\/probe"/.test(camKt) && /path == "\/printer\/diag\/print"/.test(camKt), 'Android 17321 helper exposes /printer/diag/*');
  assert.ok(/w\.member\("media-type"\)/.test(iosSw) && /\(true, true, ""\)/.test(iosSw), 'iOS puts media-type inside media-col and drops scaling in fallback');

  const html = assemble().html;
  assert.ok(html.includes('id="wifiDiagPanel"') && html.includes('id="wdRefreshNetBtn"') && html.includes('copyReportText') && html.includes('window._wifiDiag'), 'booth.html includes in-app Wi-Fi printer tester with clipboard & Wi-Fi refresh');
  const webDiag = readFileSync(join(ROOT, 'public/printer-test/index.html'), 'utf8');
  const swJs = readFileSync(join(ROOT, 'public/printer-test/sw.js'), 'utf8');
  assert.ok(webDiag.includes('/printer/diag/probe') && webDiag.includes('/printer/diag/print') && webDiag.includes('192.168.223.1'), '/printer-test/ page wired to helper diag routes');
  assert.ok(swJs.includes("url.hostname === '127.0.0.1'"), 'sw.js never intercepts loopback helper requests');
});

console.log(passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
process.exit(process.exitCode || 0);
