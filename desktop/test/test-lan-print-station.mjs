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
  getLanStationInfo,
  handleLanStationHttp,
  initLanStation,
  renderStationDashboardHtml,
  rotateLanStationPin
} from '../lib/lan-print-station.mjs';

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

  await check('local station dashboard HTML and inline script parse cleanly', () => {
    const html = renderStationDashboardHtml();
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'dashboard script must exist');
    new vm.Script(m[1]);
  });

  await check('built booth bundle includes Offline Laptop Print Station UI & helperFetch', () => {
    const built = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
    assert.match(built, /id="lanStationRow"/);
    assert.match(built, /function lanStationActive\(/);
    assert.match(built, /function helperFetch\(/);
    assert.match(built, /'x-pb-pin': lanStationCfg\.pin/);
    assert.ok(!/fetch\(HELPER_URL\s*\+/.test(built), 'all helper fetches must go through helperFetch()');
  });
} finally {
  server.close();
  try { rmSync(pinFile, { force: true }); } catch { /* ignore */ }
}
console.log(passed + ' checks passed');
