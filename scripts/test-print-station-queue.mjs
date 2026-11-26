// End-to-end test of Online Print Station (netlify/functions/printjobs.mjs + public/print-station/index.html)
// against a local @netlify/blobs BlobsServer:
//   - synced stationMode ('auto' vs 'queue') between booth (iPad) and /print-station/
//   - queue & view first: list, multi-page group preservation, done(ids), and skipIds when switching back to auto.
//
//   node scripts/test-print-station-queue.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;
const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const dir = mkdtempSync(join(tmpdir(), 'pb-printjobs-'));
const server = new BlobsServer({ directory: dir, token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();

process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
  edgeURL: 'http://localhost:' + port,
  uncachedEdgeURL: 'http://localhost:' + port,
  token: 'test-token',
  siteID: 'test-site'
})).toString('base64');
process.env.TOKEN_SECRET = 'z'.repeat(40);
process.env.UPLOAD_SECRET = 'y'.repeat(40);

const core = await import(url('netlify/lib/core.mjs'));
const printjobs = (await import(url('netlify/functions/printjobs.mjs'))).default;

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS:', name); }
async function post(body) {
  const r = await printjobs(new Request('http://x/api/printjobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), { ip: '127.0.0.1' });
  return { status: r.status, j: await r.json() };
}

try {
  const now = Date.now();
  const key = core.normCode('PB-TEST-1111-2222');
  const deviceId = 'ipad-device-1';
  const exp = now + 2 * core.DAY;
  await core.licenses().setJSON(key, {
    key,
    code: 'PB-TEST-1111-2222',
    label: 'Test Booth',
    status: 'active',
    expiresAt: exp,
    devices: [{ id: deviceId, no: 1, at: now, kind: 'iPad' }],
    print: { enabled: true, sizes: ['4x6', '2x6'] }
  });
  const token = core.sign({ t: 'rental', k: key, d: deviceId, exp });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=';

  let stationToken = '';

  await check('signin and booth station start with stationMode=auto', async () => {
    const si = await post({ action: 'signin', code: 'PB-TEST-1111-2222' });
    assert.equal(si.status, 200);
    assert.equal(si.j.ok, true);
    assert.equal(si.j.stationMode, 'auto');
    stationToken = si.j.stationToken;

    const st = await post({ action: 'station', token, deviceId });
    assert.equal(st.status, 200);
    assert.equal(st.j.stationMode, 'auto');
  });

  await check('booth setMode syncs queue mode to /print-station/ and prevents take() from claiming jobs', async () => {
    const sm = await post({ action: 'setMode', token, deviceId, mode: 'queue' });
    assert.equal(sm.status, 200);
    assert.equal(sm.j.stationMode, 'queue');

    const add1 = await post({
      action: 'add', token, deviceId, page: png, copies: 2, group: 'grp1', index: 0, total: 2,
      twoUp: true, paper: { key: 'strip:4x6', name: '4R · 2×6 strips', w: 101.6, h: 152.4 }
    });
    const add2 = await post({
      action: 'add', token, deviceId, page: png, copies: 2, group: 'grp1', index: 1, total: 2,
      twoUp: true, paper: { key: 'strip:4x6', name: '4R · 2×6 strips', w: 101.6, h: 152.4 }
    });
    assert.equal(add1.status, 200);
    assert.equal(add1.j.stationMode, 'queue');
    assert.equal(add2.status, 200);

    const tk = await post({ action: 'take', stationToken, station: 'st-1' });
    assert.equal(tk.status, 200);
    assert.equal(tk.j.stationMode, 'queue');
    assert.equal(tk.j.job, null, 'take must not dispense jobs while in queue mode');
    assert.equal(tk.j.waiting, 2);

    const lst = await post({ action: 'list', stationToken, station: 'st-1', haveIds: [] });
    assert.equal(lst.status, 200);
    assert.equal(lst.j.stationMode, 'queue');
    assert.equal(lst.j.serverIds.length, 2);
    assert.equal(lst.j.newJobs.length, 2);
    assert.equal(lst.j.newJobs[0].group, 'grp1');
    assert.equal(lst.j.newJobs[0].copies, 2);

    // Incremental poll with haveIds skips already-downloaded blobs
    const lst2 = await post({ action: 'list', stationToken, station: 'st-1', haveIds: lst.j.serverIds });
    assert.equal(lst2.status, 200);
    assert.equal(lst2.j.serverIds.length, 2);
    assert.equal(lst2.j.newJobs.length, 0);
  });

  await check('/print-station/ mode change syncs back to booth and skipIds protects held jobs', async () => {
    const lstBefore = await post({ action: 'list', stationToken, station: 'st-1', haveIds: [] });
    const heldIds = lstBefore.j.serverIds;
    assert.equal(heldIds.length, 2);

    const md = await post({ action: 'mode', stationToken, station: 'st-1', mode: 'auto' });
    assert.equal(md.status, 200);
    assert.equal(md.j.stationMode, 'auto');

    // Booth sees the laptop's change to 'auto'
    const st = await post({ action: 'station', token, deviceId });
    assert.equal(st.status, 200);
    assert.equal(st.j.online, true);
    assert.equal(st.j.stationMode, 'auto');

    // A new auto job arrives while heldIds are still sitting in review queue
    const addAuto = await post({
      action: 'add', token, deviceId, page: png, copies: 1, group: 'grpAuto', index: 0, total: 1,
      twoUp: false, paper: { key: '4x6', name: '4R (4×6)', w: 101.6, h: 152.4 }
    });
    assert.equal(addAuto.status, 200);
    assert.equal(addAuto.j.stationMode, 'auto');

    // take with skipIds: heldIds skips grp1 and returns grpAuto
    const tk = await post({ action: 'take', stationToken, station: 'st-1', skipIds: heldIds });
    assert.equal(tk.status, 200);
    assert.ok(tk.j.job);
    assert.equal(tk.j.job.group, 'grpAuto');

    const dnAuto = await post({ action: 'done', stationToken, id: tk.j.job.id });
    assert.equal(dnAuto.status, 200);
    // Now approve/dismiss the grouped review items together via ids: [...]
    const dn = await post({ action: 'done', stationToken, ids: heldIds });
    assert.equal(dn.status, 200);
    const lstEnd = await post({ action: 'list', stationToken, station: 'st-1', haveIds: [] });
    assert.equal(lstEnd.j.serverIds.length, 0);
  });

  await check('public/print-station/index.html renders mode toggle, pending queue, target printer & copies controls', async () => {
    const html = readFileSync(join(repo, 'public', 'print-station', 'index.html'), 'utf8');
    const vm = await import('node:vm');
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'print-station script must exist');
    new vm.Script(m[1], { filename: 'public/print-station/index.html' });
    for (const needle of [
      'id="modeAutoBtn"',
      'id="modeQueueBtn"',
      'id="pendingCard"',
      'id="pendingList"',
      'id="pvModal"',
      'data-q-printer',
      'data-q-cdec',
      'data-q-cinc',
      'function printPagesToTarget(',
      "action: 'list'",
      "action: 'mode'"
    ]) {
      assert.ok(html.includes(needle), 'print-station/index.html missing: ' + needle);
    }
  });
} finally {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(passed + ' checks passed');
