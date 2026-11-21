// An iPad that opens the booth from the laptop (http://<laptop>:47777/ipad/<PIN>) prints on the laptop's printer.
//
//   node desktop/test/test-lan-print.mjs      exit 1 on a problem
//
// Server half: lan.mjs hands /helper/status and /helper/print to the laptop's printing service, but only with the PIN
// cookie and only while iPad sharing is on. Page half: the built booth page sends prints to '/helper' (the laptop) when
// it was opened that way, instead of 127.0.0.1 (which on an iPad is the iPad itself).
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLanHandler } from '../lib/lan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS:', name); }

const PIN = '482915';
const state = { on: true, pin: PIN };
const seen = [];
const lan = createLanHandler({
  state: () => state,
  boothPage: async ({ extraHead }) => ({ html: '<!doctype html><html><head>' + extraHead + '</head><body>booth</body></html>' }),
  handleWeb: async (request) => {
    const body = request.method === 'GET' ? '' : await request.text();
    seen.push({ method: request.method, url: request.url, type: request.headers.get('content-type') || '', body });
    if (/\/helper\/status/.test(request.url)) return new Response(JSON.stringify({ ok: true, printers: ['EPSON L3210 Series'], version: '1.1.79' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
  setGuestView: (m) => m,
  licenceOk: () => true
});
const server = http.createServer(async (req, res) => { if (!(await lan(req, res))) { res.writeHead(404); res.end('no'); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const cookie = { cookie: 'pb_ipad=' + PIN };

try {
  await check('the PIN page sets the cookie and tells the booth it came from the laptop', async () => {
    const r = await fetch(base + '/ipad/' + PIN);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') || '', /pb_ipad=482915/);
    assert.match(await r.text(), /window\.__PB\.lanRemote=\{"base":"http:\/\/127\.0\.0\.1:\d+"\}/);
  });

  await check('without the PIN cookie the printing service is locked', async () => {
    seen.length = 0;
    const r = await fetch(base + '/helper/status');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).reason, 'pin');
    assert.equal(seen.length, 0, 'nothing may reach the printing service');
  });

  await check('a wrong PIN cookie is locked too', async () => {
    const r = await fetch(base + '/helper/print', { method: 'POST', headers: { cookie: 'pb_ipad=000000', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  });

  await check('with the PIN the iPad lists the laptop printers', async () => {
    seen.length = 0;
    const r = await fetch(base + '/helper/status?refresh=1', { headers: cookie });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.printers, ['EPSON L3210 Series']);
    assert.equal(seen[0].url, 'app://booth/helper/status?refresh=1');
  });

  await check('with the PIN a print job reaches the laptop untouched', async () => {
    seen.length = 0;
    const job = JSON.stringify({ printer: 'EPSON L3210 Series', widthMm: 101.6, heightMm: 152.4, pages: ['data:image/jpeg;base64,' + 'A'.repeat(300000)] });
    const r = await fetch(base + '/helper/print', { method: 'POST', headers: { ...cookie, 'content-type': 'application/json' }, body: job });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, 'app://booth/helper/print');
    assert.match(seen[0].type, /application\/json/);
    assert.equal(seen[0].body, job, 'the photo must arrive byte for byte');
  });

  await check('turning iPad sharing off locks printing again', async () => {
    state.on = false;
    try {
      const r = await fetch(base + '/helper/status', { headers: cookie });
      assert.equal(r.status, 401);
    } finally { state.on = true; }
  });

  const built = readFileSync(join(root, 'protected', 'booth.html'), 'utf8');
  await check('the built booth page prints through the laptop when opened from it', () => {
    assert.match(built, /const LAPTOP_PRINT = DESKTOP \|\| LANREMOTE;/);
    assert.match(built, /const HELPER_URL = LAPTOP_PRINT \? '\/helper' : 'http:\/\/127\.0\.0\.1:17321';/);
    assert.match(built, /if \(LAPTOP_PRINT\) helperOn = true;/);
    assert.match(built, /\(!isMobileOS\(\) \|\| LANREMOTE\) \? '' : 'none'/, 'the printer list must be shown on an iPad that uses the laptop');
  });

  await check('LANREMOTE can only be true when the page came from the laptop (other devices behave as before)', () => {
    assert.match(built, /const LANREMOTE = !DESKTOP && !!\(window\.__PB && window\.__PB\.lanRemote && window\.__PB\.lanRemote\.base\);/);
    assert.ok(!/DESKTOP\s*\?\s*'\/helper'\s*:\s*'http:\/\/127\.0\.0\.1:17321'/.test(built), 'the old helper address rule must be gone');
  });
} finally {
  server.close();
}
console.log(passed + ' checks passed');
