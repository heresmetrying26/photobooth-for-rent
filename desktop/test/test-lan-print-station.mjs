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
  approvePendingStationJob,
  buildStationTestJob,
  clearPendingStationJobs,
  createStationTestPngDataUrl,
  dismissAllPendingStationJobs,
  dismissPendingStationJob,
  filterStationPrinters,
  getLanStationInfo,
  getPendingStationJobImage,
  getPendingStationJobPages,
  getStationTestSizes,
  handleLanStationHttp,
  initLanStation,
  printAllPendingStationJobs,
  recordStationJob,
  renderStationDashboardHtml,
  rotateLanStationPin,
  setStationMode,
  setStationPrinterFilter,
  setStationTestSizes
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

  await check('pure-JS test print generator builds proportional PNGs for 4x6, 2x6, 5x7, 8x10, A4 & buildStationTestJob works', () => {
    const cases = [
      [{ twoUp: false }, 600, 900],
      [{ twoUp: true }, 300, 900],
      [{ widthMm: 127, heightMm: 177.8, twoUp: false }, 643, 900],
      [{ widthMm: 203.2, heightMm: 254, twoUp: false }, 720, 900],
      [{ widthMm: 210, heightMm: 297, twoUp: false }, 636, 900]
    ];
    for (const [spec, expectW, expectH] of cases) {
      const url = createStationTestPngDataUrl(spec);
      assert.ok(url.startsWith('data:image/png;base64,'));
      const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(buf.readUInt32BE(16), expectW);
      assert.equal(buf.readUInt32BE(20), expectH);
    }
    const legacyJob = buildStationTestJob('Mitsubishi CP-D80DW', true);
    assert.equal(legacyJob.ok, true);
    assert.equal(legacyJob.printBody.twoUp, true);
    assert.equal(legacyJob.printBody.widthMm, 101.6);
    const customJob = buildStationTestJob('EPSON L8050', { widthMm: 127, heightMm: 177.8, label: '5×7 (5R)', paperName: 'PR(5x7)', twoUp: false });
    assert.equal(customJob.ok, true);
    assert.equal(customJob.printBody.widthMm, 127);
    assert.equal(customJob.printBody.heightMm, 177.8);
    assert.equal(customJob.printBody.paperName, 'PR(5x7)');
    assert.equal(customJob.jobLabel, '5×7 (5R)');
    recordStationJob({ printer: 'Mitsubishi CP-D80DW', pages: 1, paper: customJob.jobLabel, from: 'Laptop Test', ok: true });
    assert.equal(getLanStationInfo().jobs[0].from, 'Laptop Test');
  });

  await check('printer allowlist filtering, hideUnusedPrinters & dynamic testSizes persist across reload and filter /lan-station/status', async () => {
    const busyList = ['AnyDesk Printer', 'Brother MFC', 'Fax', 'Mitsubishi CP-D80DW', 'Sinfonia CS2'];
    assert.deepEqual(filterStationPrinters(busyList), busyList);

    // Untick all -> 0 visible, filtered: true
    setStationPrinterFilter({ selectedPrinters: [], hideUnusedPrinters: false });
    assert.deepEqual(filterStationPrinters(busyList), []);

    // Tick only bottom printer(s) + Hide unused -> hides AnyDesk/Brother/Fax on both laptop & iPad /lan-station/status
    setStationPrinterFilter({ selectedPrinters: ['Mitsubishi CP-D80DW'], hideUnusedPrinters: true });
    assert.deepEqual(filterStationPrinters(busyList), ['Mitsubishi CP-D80DW']);

    setStationTestSizes([
      { id: '4x6', label: '4×6', widthMm: 101.6, heightMm: 152.4, twoUp: false, builtin: true },
      { id: '5x7', label: '5×7 (5R)', widthMm: 127, heightMm: 177.8, twoUp: false },
      { label: 'Custom 6x9', widthMm: 152.4, heightMm: 228.6, twoUp: false, paperName: '6x9 Photo' }
    ]);
    setStationMode('queue');

    // Reload from disk with the same pinFile -> PIN, selectedPrinters, hideUnusedPrinters, custom testSizes & stationMode must survive
    initLanStation({
      getPort: () => port,
      pinFile,
      appKind: 'desktop',
      version: '1.1.112',
      getPrinters: async () => busyList,
      getPaper: async () => ({ ok: true }),
      printJob: async () => ({ ok: true })
    });
    const reloaded = getLanStationInfo();
    assert.equal(reloaded.pin, freshPin);
    assert.deepEqual(reloaded.selectedPrinters, ['Mitsubishi CP-D80DW']);
    assert.equal(reloaded.hideUnusedPrinters, true);
    assert.equal(reloaded.testSizes.length, 3);
    assert.equal(reloaded.testSizes[2].paperName, '6x9 Photo');
    assert.equal(reloaded.testSizesCustomized, true);
    assert.equal(reloaded.stationMode, 'queue');

    const stRes = await fetch(base + '/lan-station/status', { headers: { 'x-pb-pin': freshPin } });
    const stJson = await stRes.json();
    assert.deepEqual(stJson.printers, ['Mitsubishi CP-D80DW']);
    assert.equal(stJson.allPrintersCount, 5);
    assert.equal(stJson.filtered, true);
    assert.equal(stJson.stationMode, 'queue');

    // Restore clean test state
    setStationPrinterFilter({ selectedPrinters: null, hideUnusedPrinters: false });
    setStationTestSizes(null);
    setStationMode('auto');
    assert.equal(getStationTestSizes().length, 2);
  });

  await check('local station dashboard HTML includes filter toolbar, hide unused, dynamic sizes & runs clean workflow in VM', async () => {
    const html = renderStationDashboardHtml();
    assert.match(html, /id="prSearch"/);
    assert.match(html, /id="untickAllBtn"/);
    assert.match(html, /id="tickAllBtn"/);
    assert.match(html, /id="hideUnusedBtn"/);
    assert.match(html, /id="toggleAddSizeBtn"/);
    assert.match(html, /id="drvLoadBtn"/);
    assert.match(html, /id="csAddBtn"/);
    assert.match(html, /Driver Preferences/);
    assert.match(html, /Where to Click on the iPad App/);
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'dashboard script must exist');

    // Interactive DOM + fetch simulation in VM: Untick all -> search -> tick Mitsubishi -> Hide unused -> add custom size -> test print
    const els = {};
    const mkEl = (id) => ({
      id, textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
      className: '', style: {}, dataset: {},
      classList: { toggle: () => { }, add: () => { }, remove: () => { } },
      focus: () => { }, closest: () => null
    });
    ['dashMsg', 'pinTxt', 'ipList', 'prCountBadge', 'hideUnusedBtn', 'refPrBtn', 'prToolbar', 'prSearch',
      'untickAllBtn', 'tickAllBtn', 'prList', 'resetSizesBtn', 'sizeChips', 'toggleAddSizeBtn', 'addSizeBox',
      'presetRow', 'drvPrSel', 'drvLoadBtn', 'drvSzSel', 'drvAddBtn', 'csLabel', 'csW', 'csH', 'csU', 'csTwoUp',
      'csAddBtn', 'newPinBtn', 'jobBody'].forEach((id) => { els[id] = mkEl(id); });
    els.csU.value = 'in';

    let simState = {
      pin: '123456',
      port: 47777,
      addresses: [{ ip: '192.168.137.1', kind: 'Hotspot', port: 47777 }],
      printers: ['AnyDesk Printer', 'Brother MFC', 'Fax', 'Mitsubishi CP-D80DW', 'Samsung Laser'],
      selectedPrinters: null,
      hideUnusedPrinters: false,
      testSizes: [{ id: '4x6', label: '4×6', widthMm: 101.6, heightMm: 152.4, twoUp: false, builtin: true }],
      testSizesCustomized: false,
      stationMode: 'auto',
      pendingJobs: [],
      jobs: []
    };
    const postedPrints = [];
    const approvedCalls = [];
    const sandbox = {
      console, Set, Array, Object, String, Number, Math, JSON, Date, encodeURIComponent,
      setInterval: () => 0,
      document: {
        activeElement: null,
        getElementById: (id) => els[id] || (els[id] = mkEl(id))
      },
      fetch: async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (String(url).startsWith('/station/info')) return { ok: true, json: async () => simState };
        if (url === '/station/mode') {
          simState.stationMode = body.mode === 'queue' ? 'queue' : 'auto';
          return { ok: true, json: async () => ({ ok: true, ...simState }) };
        }
        if (url === '/station/job-approve') {
          approvedCalls.push(body);
          simState.pendingJobs = simState.pendingJobs.filter((x) => x.id !== body.id);
          return { ok: true, json: async () => ({ ok: true, ...simState }) };
        }
        if (url === '/station/printers') {
          simState = { ...simState, ...setStationPrinterFilter(body) };
          return { ok: true, json: async () => ({ ok: true, ...simState }) };
        }
        if (url === '/station/test-sizes') {
          simState = { ...simState, ...setStationTestSizes(body.testSizes) };
          return { ok: true, json: async () => ({ ok: true, ...simState }) };
        }
        if (url === '/station/test-print') {
          postedPrints.push(body);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, json: async () => ({}) };
      }
    };
    vm.runInNewContext(m[1], sandbox);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(els.prList.innerHTML, /AnyDesk Printer/);
    assert.match(els.prList.innerHTML, /Mitsubishi CP-D80DW/);

    // Step 1: Untick all
    await els.untickAllBtn.onclick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(simState.selectedPrinters, []);
    assert.equal(simState.hideUnusedPrinters, false);

    // Step 2: Search 'mits' -> hides A/B printers during pick
    els.prSearch.value = 'mits';
    els.prSearch.oninput();
    assert.doesNotMatch(els.prList.innerHTML, /AnyDesk Printer/);
    assert.match(els.prList.innerHTML, /Mitsubishi CP-D80DW/);

    // Step 3: Tick Mitsubishi -> Hide unused (even with 'mits' previously typed in search!)
    await els.prList.onchange({ target: { closest: () => ({ checked: true, dataset: { sel: 'Mitsubishi CP-D80DW' } }) } });
    await els.hideUnusedBtn.onclick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(simState.hideUnusedPrinters, true);
    assert.equal(els.prSearch.value, '', 'Hide unused clears stale search box');
    assert.match(els.prList.innerHTML, /Mitsubishi CP-D80DW/);
    assert.doesNotMatch(els.prList.innerHTML, /AnyDesk Printer/);
    assert.match(els.prCountBadge.textContent, /1 of 5 ticked \(4 hidden\)/);

    // Step 4: Dynamically add custom 6x9 size -> appears on Test button and posts exact dimensions
    els.csW.value = '6'; els.csH.value = '9'; els.csU.value = 'in';
    await els.csAddBtn.onclick();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(els.prList.innerHTML, /Test 6×9/);
    assert.equal(simState.testSizes.some((s) => Math.round(s.widthMm) === 152 && Math.round(s.heightMm) === 229), true);

    // Step 5: Switch to Queue & view first, render pending job, override printer & copies, approve print
    simState.pendingJobs = [{
      id: 'q-vm-1', at: Date.now(), from: '192.168.2.50', fromName: 'iPad 1',
      printer: 'Mitsubishi CP-D80DW', paper: '4R (4×6)', copies: 1, pageCount: 1, thumb: 'data:image/png;base64,AA=='
    }];
    await els.modeQueueBtn.onclick();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(simState.stationMode, 'queue');
    assert.match(els.pendingList.innerHTML, /4R \(4×6\)/);
    els.pendingList.onchange({ target: { closest: (sel) => (sel === 'select[data-job-printer]' ? { dataset: { jobPrinter: 'q-vm-1' }, value: 'Brother MFC' } : null) } });
    await els.pendingList.onclick({ target: { closest: (sel) => (sel === '[data-job-cinc]' ? { dataset: { jobCinc: 'q-vm-1' } } : null) } });
    await els.pendingList.onclick({ target: { closest: (sel) => (sel === '[data-approve-job]' ? { dataset: { approveJob: 'q-vm-1' }, disabled: false, textContent: 'Print' } : null) } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(approvedCalls.length, 1);
    assert.equal(approvedCalls[0].printer, 'Brother MFC');
    assert.equal(approvedCalls[0].copies, 2);

    setStationPrinterFilter({ selectedPrinters: null, hideUnusedPrinters: false });
    setStationTestSizes(null);
    setStationMode('auto');
  });

  await check('built booth bundle keeps iPad DSLR camera local, includes filtered Print Station, Setup tools & JPEG prints', () => {
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
    assert.match(built, /id="stationDeskPrSearch"/);
    assert.match(built, /id="stationDeskUntickBtn"/);
    assert.match(built, /id="stationDeskHideBtn"/);
    assert.match(built, /id="stationDeskAddSizeBtn"/);
    assert.match(built, /id="stationDeskLoadDrvBtn"/);
    assert.match(built, /id="stationDeskCsAddBtn"/);
    assert.match(built, /pb4u\.lanStation\.setPrinters|api\.setPrinters/);
    assert.match(built, /!lanStationActive\(\) && helperOn && helper\.ok && helperAtLeast\('1\.1\.7'\)/);
    assert.match(built, /function printStationAllowed\(\)/);
    assert.ok(!/data-setup-tool="(?:camFab|printFab|pstatFab|scaleFab)"/.test(built), 'Setup tools menu must exclude Camera, Printer, and Resize UI');
    // Efficiency optimizations: JPEG compression for photo prints & 60s cached helper status
    assert.match(built, /toDataURL\('image\/jpeg', 0\.95\)/);
    assert.match(built, /\(helper\.checked \|\| 0\)\) < 60000/);
    // Queue & view first + synced mode UI across Desktop Print Station, Offline iPad & Online Print Station
    assert.match(built, /id="stationDeskModeAuto"/);
    assert.match(built, /id="stationDeskModeQueue"/);
    assert.match(built, /id="stationDeskPendingList"/);
    assert.match(built, /id="stationDeskPvOverlay"/);
    assert.match(built, /id="lanStationModeBox"/);
    assert.match(built, /id="lanStationModeAutoBtn"/);
    assert.match(built, /id="lanStationModeQueueBtn"/);
    assert.match(built, /id="onlineStationModeWrap"/);
    assert.match(built, /id="ppStationModeWrap"/);
    assert.match(built, /function setOnlineStationMode\(/);
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

      // Queue & view first: iPad switches mode -> laptop holds photo -> operator edits target printer & copies -> prints
      clearPendingStationJobs();
      relayJobs.length = 0;
      const modeRes = await fetch(bUrl + '/lan-station/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ mode: 'queue' })
      });
      assert.equal(modeRes.status, 200);
      assert.equal((await modeRes.json()).stationMode, 'queue');

      const stQueue = await (await fetch(bUrl + '/lan-station/status', { headers: { 'x-pb-pin': st.pin } })).json();
      assert.equal(stQueue.stationMode, 'queue');

      const qRes = await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({
          printer: 'Mitsubishi CP-D80DW',
          widthMm: 101.6,
          heightMm: 152.4,
          paperLabel: '4R (4×6)',
          copies: 2,
          pages: [testPng]
        })
      });
      const qJson = await qRes.json();
      assert.equal(qRes.status, 200);
      assert.equal(qJson.queued, true);
      assert.equal(qJson.stationMode, 'queue');
      assert.equal(qJson.pendingCount, 1);
      assert.equal(relayJobs.length, 0, 'queued photo must NOT auto-print yet');

      const infoPending = getLanStationInfo();
      assert.equal(infoPending.pendingJobs.length, 1);
      assert.equal(infoPending.pendingJobs[0].copies, 2);
      const qId = infoPending.pendingJobs[0].id;
      assert.equal(getPendingStationJobPages(qId).pages.length, 1);
      assert.equal(getPendingStationJobImage(qId, 0).mime, 'image/png');

      // Operator overrides target printer & changes copies from 2 -> 3, then clicks Print
      const apRes = await approvePendingStationJob(qId, { printer: 'Mitsubishi 2x6 cut', copies: 3 });
      assert.equal(apRes.ok, true);
      assert.equal(apRes.pendingCount, 0);
      assert.equal(relayJobs.length, 1);
      assert.equal(relayJobs[0].printer, 'Mitsubishi 2x6 cut');
      assert.equal(relayJobs[0].pages.length, 3);
      assert.equal(getLanStationInfo().jobs[0].copies, 3);
      assert.equal(getLanStationInfo().jobs[0].printer, 'Mitsubishi 2x6 cut');

      // Queue another job, verify dismiss works cleanly, and verify stationMode persists across reload
      const qRes2 = await (await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ printer: '', pages: [testPng, testPng] }) // identical pages w/o copies -> normalized to 2 copies
      })).json();
      assert.equal(qRes2.queued, true);
      assert.equal(getLanStationInfo().pendingJobs[0].copies, 2);
      assert.equal(getLanStationInfo().pendingJobs[0].pageCount, 1);
      const dRes = dismissPendingStationJob(qRes2.id);
      assert.equal(dRes.pendingCount, 0);

      // Print all & Dismiss all + auto mode copies expansion
      await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ printer: 'Mitsubishi CP-D80DW', copies: 1, pages: [testPng] })
      });
      await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ printer: 'Mitsubishi CP-D80DW', copies: 1, pages: [testPng] })
      });
      const allRes = await printAllPendingStationJobs();
      assert.equal(allRes.ok, true);
      assert.equal(allRes.printedCount, 2);
      assert.equal(getLanStationInfo().pendingCount, 0);

      await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ printer: 'Mitsubishi CP-D80DW', pages: [testPng] })
      });
      assert.equal(dismissAllPendingStationJobs().pendingCount, 0);

      setStationMode('auto');
      relayJobs.length = 0;
      const autoCopiesRes = await (await fetch(bUrl + '/lan-station/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pb-pin': st.pin },
        body: JSON.stringify({ printer: 'Mitsubishi CP-D80DW', copies: 3, pages: [testPng] })
      })).json();
      assert.equal(autoCopiesRes.ok, true);
      assert.equal(autoCopiesRes.queued, false);
      assert.equal(relayJobs[0].pages.length, 3);
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
