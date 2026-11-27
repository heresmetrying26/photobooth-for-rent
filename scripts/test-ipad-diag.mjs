import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { handleIpadDiag } from '../netlify/functions/ipaddiag.mjs';

const ROOT = process.cwd();

function makeMemoryStore() {
  const map = new Map();
  return {
    async get(k, opts) {
      if (!map.has(k)) return null;
      const raw = map.get(k);
      return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(k, v) { map.set(k, JSON.stringify(v)); },
    async delete(k) { map.delete(k); }
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log('PASS:', name);
  passed++;
}

await test('public/ipad-debug/index.html inline script parses cleanly in V8', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/ipad-debug/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert(scripts.length >= 1, 'expected inline script in public/ipad-debug/index.html');
  scripts.forEach((s, i) => new vm.Script(s, { filename: 'ipad-debug-' + i + '.js' }));
});

await test('/api/ipaddiag handles CORS OPTIONS, POST text/plain, sanitization, GET sid & list', async () => {
  const store = makeMemoryStore();
  const optRes = await handleIpadDiag(new Request('https://photobooth4u.netlify.app/api/ipaddiag', { method: 'OPTIONS' }), store);
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('access-control-allow-origin'), '*');

  const fakeB64 = 'data:image/jpeg;base64,' + 'A'.repeat(240);
  const postRes = await handleIpadDiag(new Request('https://photobooth4u.netlify.app/api/ipaddiag', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      sid: 'k7m4p2',
      source: 'ipad-app-booth',
      device: { uaShort: 'iPad OS 18.7 (iPad App 1.1.45)', iosApp: true, iosLowRam: true, appVer: '1.1.45' },
      events: [
        { t: Date.now(), dt: 12, tag: 'PRINT', msg: 'calling print with ' + fakeB64 + ' at 192.168.1.50', data: { state: 'start', canvases: 3, canvasMp: 9.2 } },
        { t: Date.now(), dt: 450, tag: 'LAG', msg: 'stalled', data: { lagMs: 1420 } }
      ]
    })
  }), store);
  assert.equal(postRes.status, 200);
  const pj = await postRes.json();
  assert.equal(pj.ok, true);
  assert.equal(pj.sid, 'K7M4P2');
  assert.equal(pj.count, 2);

  const getRes = await handleIpadDiag(new Request('https://photobooth4u.netlify.app/api/ipaddiag?sid=K7M4P2'), store);
  const gj = await getRes.json();
  assert.equal(gj.found, true);
  assert.equal(gj.session.maxLagMs, 1420);
  assert.equal(gj.session.stallCount, 1);
  assert.equal(gj.session.lastCanvasCount, 3);
  assert(!JSON.stringify(gj).includes('AAAAAAAA'), 'base64 stripped');
  assert(!JSON.stringify(gj).includes('192.168.1.50'), 'IP stripped');
  assert(gj.session.inFlight.includes('PRINT:'));

  const listRes = await handleIpadDiag(new Request('https://photobooth4u.netlify.app/api/ipaddiag?list=1'), store);
  const lj = await listRes.json();
  assert.equal(lj.ok, true);
  assert.equal(lj.sessions.length, 1);
  assert.equal(lj.sessions[0].sid, 'K7M4P2');
});

await test('booth.html includes #hangDiagBox and window.pbDiag flight recorder', () => {
  const html = fs.readFileSync(path.join(ROOT, 'protected/booth.html'), 'utf8');
  assert(html.includes('id="hangDiagStart"'), 'missing #hangDiagStart');
  assert(html.includes('window.pbDiag = pbDiag'), 'missing window.pbDiag');
  assert(html.includes('https://photobooth4u.netlify.app/api/ipaddiag'), 'missing localhost->Netlify API URL');
});

console.log(`${passed} passed`);
