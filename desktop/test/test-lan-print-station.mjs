// Offline Wi-Fi / LAN Laptop Print Station test (desktop/lib/lan-print-station.mjs + booth build).
//
//   node desktop/test/test-lan-print-station.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  createStationTestPngDataUrl,
  getLanStationInfo,
  handleLanStationHttp,
  initLanStation,
  recordStationJob,
  renderStationDashboardHtml,
  rotateLanStationPin
} from '../lib/lan-print-station.mjs';
import { startHelperBridge, stopHelperBridge } from '../../tools/print-helper/bridge-ctrl.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pinFile = join(tmpdir(), 'pb4u-lan-station-test-' + process.pid + '.json');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS:', name); }

const printed = [];
let port = 0;
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end('bad'); return; }
  if (await handleLanStationHttp(req, res, u)) return;
  res.writeHead(404); res.end('no');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;
const base = 'http://127.0.0.1:' + port;

try {
  initLanStation({
    getPort: () => port,
    pinFile,
    appKind: 'print-helper',
    version: '1.1.23',
    getPrinters: async () => ['Mitsubishi CP-D80DW', 'Mitsubishi 2x6 cut'],
    getPaper: async ({ printer, widthMm, heightMm, twoUp }) => ({
      ok: true,
      known: true,
      match: { name: twoUp ? '6x4(2x6*2)' : 'PR(4x6)', borderless: true, isDefault: false },
      def: 'PR(4x6)',
      printer,
      w: widthMm,
      h: heightMm
    }),
    printJob: async (body) => {
      printed.push(body);
      return { ok: true };
    }
  });

  const info = getLanStationInfo();
  assert.match(info.pin, /^\d{6}$/, 'initial PIN must be 6 digits');

  await check('OPTIONS preflight exposes x-pb-pin and private network CORS headers', async () => {
    const r = await fetch(base + '/lan-station/print', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers') || '', /x-pb-pin/);
    assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
  });

  await check('/lan-station/hello exposes beacon metadata without leaking printers or PIN', async () => {
    const r = await fetch(base + '/lan-station/hello');
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.app, 'photobooth4u-lan-station');
    assert.equal(j.port, port);
    assert.equal(j.printers, undefined);
    assert.equal(j.pin, undefined);
  });

  await check('missing or wrong PIN is rejected and rate-limited after 10 failures', async () => {
    const r0 = await fetch(base + '/lan-station/status');
    assert.equal(r0.status, 401);
    assert.equal((await r0.json()).reason, 'pin');

    for (let i = 0; i < 9; i++) {
      const rx = await fetch(base + '/lan-station/status', { headers: { 'x-pb-pin': '000000' } });
      assert.equal(rx.status, 401);
    }
    const rLimit = await fetch(base + '/lan-station/status', { headers: { 'x-pb-pin': info.pin } });
    assert.equal(rLimit.status, 429);
    assert.equal((await rLimit.json()).reason, 'rate');
  });

  const freshPin = rotateLanStationPin();
  await check('rotating PIN clears lockout and persists across reload', () => {
    assert.match(freshPin, /^\d{6}$/);
    assert.equal(existsSync(pinFile), true);
  });

  await check('valid PIN fetches laptop printers and paper match', async () => {
    const r = await fetch(base + '/lan-station/status?refresh=1', { headers: { 'x-pb-pin': freshPin } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.printers, ['Mitsubishi CP-D80DW', 'Mitsubishi 2x6 cut']);

    const rp = await fetch(base + '/lan-station/paper?printer=Mitsubishi%202x6%20cut&w=50.8&h=152.4&twoUp=1', { headers: { 'x-pb-pin': freshPin } });
    const jp = await rp.json();
    assert.equal(rp.status, 200);
    assert.equal(jp.match.name, '6x4(2x6*2)');
  });

  await check('POST /lan-station/print forwards job to laptop printer and records history', async () => {
    printed.length = 0;
    const job = {
      printer: 'Mitsubishi CP-D80DW',
      widthMm: 101.6,
      heightMm: 152.4,
      twoUp: false,
      pages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=']
    };
    const r = await fetch(base + '/lan-station/print', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pb-pin': freshPin },
      body: JSON.stringify(job)
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(printed.length, 1);
    assert.equal(printed[0].printer, 'Mitsubishi CP-D80DW');
    assert.equal(getLanStationInfo().jobs[0].printer, 'Mitsubishi CP-D80DW');
    assert.equal(getLanStationInfo().jobs[0].ok, true);
  });

  await check('pure-JS test print generator builds valid 4x6 and 2x6 PNGs and records station jobs', () => {
    for (const [twoUp, expectW] of [[false, 600], [true, 300]]) {
      const url = createStationTestPngDataUrl({ twoUp });
      assert.ok(url.startsWith('data:image/png;base64,'));
      const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(buf.readUInt32BE(16), expectW);
      assert.equal(buf.readUInt32BE(20), 900);
    }
    recordStationJob({ printer: 'Mitsubishi CP-D80DW', pages: 1, paper: '4x6 test', from: 'Laptop Test', ok: true });
    assert.equal(getLanStationInfo().jobs[0].from, 'Laptop Test');
  });

  await check('local station dashboard HTML includes Test Print buttons and inline script parses cleanly', () => {
    const html = renderStationDashboardHtml();
    assert.match(html, /Test 4\u00d76/);
    assert.match(html, /Test 2\u00d76 Cut/);
    assert.match(html, /Driver Preferences/);
    assert.match(html, /Where to Click on the iPad App/);
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'dashboard script must exist');
    new vm.Script(m[1]);
  });

  await check('built booth bundle keeps iPad DSLR camera local, includes Setup tools menu (without camera/printer/resize) and efficient JPEG prints', () => {
    const built = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
    assert.match(built, /id="lanStationRow"/);
    assert.match(built, /function lanStationActive\(/);
    assert.match(built, /function helperFetch\(/);
    assert.match(built, /'x-pb-pin': lanStationCfg\.pin/);
    assert.ok(!/fetch\(HELPER_URL\s*\+/.test(built), 'all helper fetches must go through helperFetch()');
    assert.match(built, /const CAM_HELPER = \(DESKTOP \|\| LANREMOTE\) \? '\/helper' : IOS_APP \? 'http:\/\/localhost:17321' : 'http:\/\/127\.0\.0\.1:17321';/);
    assert.match(built, /if \(LAPTOP_PRINT \|\| TABLET_LOCAL\) printRoute = 'here';/);
    assert.match(built, /if \(\(LAPTOP_PRINT \|\| lanStationActive\(\)\) && route === 'dialog'\)/);
    assert.match(built, /if \(LAPTOP_PRINT \|\| lanStationActive\(\) \|\| route !== 'dialog'\)/);
    // Setup ⋯ menu tools & built-in Desktop Print Station (gated by printStationOpt)
    assert.match(built, /id="setupMenuTools"/);
    assert.match(built, /id="menuPrintStation"/);
    assert.match(built, /id="printStationFab"/);
    assert.match(built, /id="stationDeskOverlay"/);
    assert.match(built, /function printStationAllowed\(\)/);
    assert.ok(!/data-setup-tool="(?:camFab|printFab|pstatFab|scaleFab)"/.test(built), 'Setup tools menu must exclude Camera, Printer, and Resize UI');
    // Efficiency optimizations: JPEG compression for photo prints & 60s cached helper status
    assert.match(built, /toDataURL\('image\/jpeg', 0\.95\)/);
    assert.match(built, /\(helper\.checked \|\| 0\)\) < 60000/);
  });

  await check('end-to-end helper bridge enforces isEnabled gating, fires onJob push, and relays 2x6 cut prints from iPad', async () => {
    server.close();
    const relayJobs = [];
    const pushedJobs = [];
    let enabled = false;
    const pinFile2 = join(tmpdir(), 'pb4u-lan-bridge-test-' + process.pid + '.json');
    try {
      const bp = await startHelperBridge({
        ports: [47891, 47892],
        lanStation: {
          appKind: 'desktop',
          version: '1.1.111',
          pinFile: pinFile2,
          isEnabled: () => enabled,
          onJob: (info) => pushedJobs.push(info),
          getPrinters: async () => ['Mitsubishi CP-D80DW', 'Mitsubishi 2x6 cut'],
          getPaper: async ({ printer, twoUp }) => ({ ok: true, known: true, match: { name: twoUp ? '6x4(2x6*2)' : 'PR(4x6)', borderless: true, isDefault: false }, printer }),
          printJob: async (body) => { relayJobs.push(body); return { ok: true }; }
        }
      });
      assert.ok(bp >= 47891, 'bridge must bind test port');
      const bUrl = 'http://127.0.0.1:' + bp;
      const blocked = await fetch(bUrl + '/lan-station/hello');
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).reason, 'disabled');

      enabled = true;
      const hello = await (await fetch(bUrl + '/lan-station/hello')).json();
      assert.equal(hello.ok, true);
      assert.equal(hello.version, '1.1.111');

      const st = getLanStationInfo();
      const status = await (await fetch(bUrl + '/lan-station/status?refresh=1', { headers: { 'x-pb-pin': st.pin } })).json();
      assert.deepEqual(status.printers, ['Mitsubishi CP-D80DW', 'Mitsubishi 2x6 cut']);

      const testPng = createStationTestPngDataUrl({ twoUp: false });
      const pr = await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({
          printer: 'Mitsubishi 2x6 cut',
          quality: 'best',
          twoUp: true,
          widthMm: 50.8,
          heightMm: 152.4,
          pages: [testPng, testPng]
        })
      });
      const pj = await pr.json();
      assert.equal(pr.status, 200);
      assert.equal(pj.ok, true);
      assert.equal(relayJobs.length, 1);
      assert.equal(relayJobs[0].twoUp, true);
      assert.equal(relayJobs[0].pages.length, 2);
      assert.equal(getLanStationInfo().jobs[0].printer, 'Mitsubishi 2x6 cut');
      assert.equal(pushedJobs.length, 1);
      assert.equal(pushedJobs[0].jobs[0].printer, 'Mitsubishi 2x6 cut');
    } finally {
      stopHelperBridge();
      try { rmSync(pinFile2, { force: true }); } catch { }
    }
  });
} finally {
  server.close();
  try { rmSync(pinFile, { force: true }); } catch { /* ignore */ }
}
console.log(passed + ' checks passed');
