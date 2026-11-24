import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initBridge,
  allBridgeUrls,
  getBridgeInfo,
  renewBridgeToken,
  attachBridgeUpgrade,
  handleBridgeHttp,
  pushBridgeState,
  sendBridgeEvent,
  sendCamCommand,
  guestBridgeHtml
} from '../lib/guest-bridge.mjs';
import { lanAddress, initPhotos, startShareServer, stopShareServer, sharePortNow } from '../lib/photos.mjs';
import { startHelperBridge, stopHelperBridge, helperBridgeStatus, handleBridgeCtrl } from '../../tools/print-helper/bridge-ctrl.mjs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function connectWs(port, path) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        'GET ' + path + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let headerBuf = Buffer.alloc(0);
    let upgraded = false;
    const msgs = [];
    const waiters = [];
    let frameBuf = Buffer.alloc(0);

    function dispatchMsg(op, payload) {
      const item = { op, data: op === 1 ? payload.toString('utf8') : payload };
      if (waiters.length) waiters.shift()(item);
      else msgs.push(item);
    }

    function sendClient(op, data) {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const mask = randomBytes(4);
      let hdr;
      if (payload.length < 126) {
        hdr = Buffer.from([0x80 | op, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        hdr = Buffer.allocUnsafe(4);
        hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(payload.length, 2);
      } else {
        throw new Error('too big for test');
      }
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
      sock.write(Buffer.concat([hdr, mask, masked]));
    }

    sock.on('data', (chunk) => {
      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = headerBuf.subarray(0, idx).toString('utf8');
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        assert(head.startsWith('HTTP/1.1 101'), 'Expected 101 upgrade, got: ' + head);
        assert(head.includes(expected), 'Expected valid Sec-WebSocket-Accept');
        upgraded = true;
        const rem = headerBuf.subarray(idx + 4);
        if (rem.length) frameBuf = rem;
        resolve({
          sock,
          sendText: (t) => sendClient(0x1, t),
          sendJson: (o) => sendClient(0x1, JSON.stringify(o)),
          sendBin: (b) => sendClient(0x2, b),
          nextMsg: (ms = 3000) => {
            if (msgs.length) return Promise.resolve(msgs.shift());
            return new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error('WS message timeout')), ms);
              waiters.push((m) => { clearTimeout(t); res(m); });
            });
          },
          close: () => { try { sock.destroy(); } catch { } }
        });
      } else {
        frameBuf = Buffer.concat([frameBuf, chunk]);
      }
      while (upgraded && frameBuf.length >= 2) {
        const op = frameBuf[0] & 0x0f;
        let len = frameBuf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (frameBuf.length < 4) return;
          len = frameBuf.readUInt16BE(2);
          off = 4;
        }
        if (frameBuf.length < off + len) return;
        const payload = frameBuf.subarray(off, off + len);
        frameBuf = frameBuf.subarray(off + len);
        if (op === 0x8) return;
        dispatchMsg(op, payload);
      }
    });
    sock.on('error', reject);
  });
}

console.log('--- Testing Guest Screen + Camera Bridge ---');

// 1. Validate guestBridgeHtml JS syntax
{
  const html = guestBridgeHtml('testtoken123');
  const m = /<script>\n?([\s\S]*?)\n?<\/script>/.exec(html);
  assert(m, 'guestBridgeHtml contains script');
  new Function(m[1]);
  assert(html.includes('id="gPrintBtn"'), 'guestBridgeHtml has Print button');
  assert(html.includes('id="copiesModal"'), 'guestBridgeHtml has Copies modal');
  assert(html.includes('id="gNextBtn"'), 'guestBridgeHtml has Done / Next guest button');
  // The tablet's guest screen follows the booth's size settings and the live resize preview, like the laptop's guest window
  assert(html.includes('--ui-cd-scale') && html.includes('--ui-btn-scale') && html.includes('--ui-film-scale'), 'guest page uses the booth size settings');
  assert(html.includes('body.edit-preview .cd') && html.includes("st.editPreview"), 'guest page has the live resize preview');
  assert(html.includes("safe('QR codes'"), 'guest page draws the QR codes on their own, so another part cannot stop them');
  console.log('PASS: guestBridgeHtml syntax and print UI verified');
}

// 2. Start isolated HTTP + WebSocket bridge server
let port = 0;
const actions = [];
const statuses = [];
initBridge({
  getPort: () => port,
  onAction: (a) => actions.push(a),
  onStatus: (s) => statuses.push(s)
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (await handleBridgeHttp(req, res, url)) return;
  res.writeHead(404); res.end('not found');
});
attachBridgeUpgrade(server);
await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));

try {
  const info0 = getBridgeInfo();
  const base = 'http://127.0.0.1:' + port + '/bridge/' + info0.token;

  // Hello + bad token check
  const rHello = await fetch(base + '/hello');
  assert.equal(rHello.status, 200);
  const jHello = await rHello.json();
  assert.equal(jHello.app, 'photobooth4u-bridge');
  const rBad = await fetch('http://127.0.0.1:' + port + '/bridge/wrongtoken/hello');
  assert.equal(rBad.status, 403);

  // Connect tablet camera WebSocket
  const camWs = await connectWs(port, '/bridge/' + info0.token + '/ws?role=cam');
  camWs.sendJson({
    type: 'hello',
    deviceName: 'HUAWEI MatePad Pro',
    facing: 'front',
    width: 1280,
    height: 960,
    cameras: [{ id: '0', facing: 'back' }, { id: '1', facing: 'front' }]
  });
  await new Promise((r) => setTimeout(r, 50));
  const info1 = getBridgeInfo();
  assert.equal(info1.camConnected, true);
  assert.equal(info1.deviceName, 'HUAWEI MatePad Pro');
  // Setup says which link the tablet came in on (here the test connects from this laptop itself)
  assert(info1.via && info1.via.ip === '127.0.0.1', 'bridge info says which laptop address the tablet used');
  assert.equal(info1.via.kind, 'USB cable (ADB)');

  // Stream preview binary JPEG frame -> read from /bridge-local/frame
  const fakePreview = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  camWs.sendBin(fakePreview);
  await new Promise((r) => setTimeout(r, 40));
  const f1 = await fetch('http://127.0.0.1:' + port + '/bridge-local/frame');
  assert.equal(f1.status, 200);
  const seq1 = Number(f1.headers.get('x-pb-seq'));
  assert(seq1 >= 1);
  assert.deepEqual(Buffer.from(await f1.arrayBuffer()), fakePreview);

  const fNone = await fetch('http://127.0.0.1:' + port + '/bridge-local/frame?after=' + seq1);
  assert.equal(fNone.status, 204);

  // Request capture from laptop -> camWs receives capture cmd -> posts shot -> laptop receives JPEG
  const fullShot = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 8, 7, 6, 5, 0xff, 0xd9]);
  const capPromise = fetch('http://127.0.0.1:' + port + '/bridge-local/capture', { method: 'POST' });
  const capCmdMsg = await camWs.nextMsg();
  const capCmd = JSON.parse(capCmdMsg.data);
  assert.equal(capCmd.type, 'capture');
  assert(capCmd.id);
  const upResp = await fetch(base + '/cam/shot?id=' + encodeURIComponent(capCmd.id), {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: fullShot
  });
  assert.equal(upResp.status, 200);
  const capResp = await capPromise;
  assert.equal(capResp.status, 200);
  assert.deepEqual(Buffer.from(await capResp.arrayBuffer()), fullShot);
  console.log('PASS: Tablet Camera WebSocket preview & full-res shot capture verified');

  // Switch camera command
  const sw = sendCamCommand({ type: 'switchCam' });
  assert.equal(sw.ok, true);
  const swCmd = JSON.parse((await camWs.nextMsg()).data);
  assert.equal(swCmd.type, 'switchCam');

  // Connect tablet guest screen WebSocket -> push state with print options & countdown tick -> verify action back
  const guestWs = await connectWs(port, '/bridge/' + info0.token + '/ws?role=guest');
  pushBridgeState({
    isResult: true,
    printShow: true,
    printGuestCopies: true,
    printMaxCopies: 4,
    printLabel: 'Print',
    nextShow: true
  });
  const stMsg = JSON.parse((await guestWs.nextMsg()).data);
  assert.equal(stMsg.type, 'state');
  assert.equal(stMsg.state.printShow, true);
  assert.equal(stMsg.state.printGuestCopies, true);
  assert.equal(stMsg.state.printMaxCopies, 4);

  sendBridgeEvent({ type: 'tick', num: '3', word: false, progress: 0.5, chip: 'Smile!' });
  const tickMsg = JSON.parse((await guestWs.nextMsg()).data);
  assert.equal(tickMsg.type, 'tick');
  assert.equal(tickMsg.num, '3');

  guestWs.sendJson({ type: 'action', action: 'print', copies: 3 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'print');
  assert.equal(actions[0].copies, 3);

  // Media upload & fetch
  const sampleImg = Buffer.from('fake-jpeg-data');
  const mUp = await fetch('http://127.0.0.1:' + port + '/bridge-local/media/result', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: sampleImg
  });
  assert.equal(mUp.status, 200);
  const mGet = await fetch(base + '/media/result');
  assert.equal(mGet.status, 200);
  assert.deepEqual(Buffer.from(await mGet.arrayBuffer()), sampleImg);
  console.log('PASS: Guest Screen WebSocket sync, print action, and media cache verified');

  // Renew token disconnects old & rejects old token
  const info2 = renewBridgeToken();
  assert.notEqual(info2.token, info0.token);
  const rOld = await fetch(base + '/hello');
  assert.equal(rOld.status, 403);
  const rNew = await fetch('http://127.0.0.1:' + port + '/bridge/' + info2.token + '/hello');
  assert.equal(rNew.status, 200);
  console.log('PASS: Token rotation verified');

  camWs.close();
  guestWs.close();
} finally {
  server.close();
}

// 3. Offline router / hotspot IP filtering (must never pick dummy 10.254.254.1 loopback or VPNs)
{
  const fakeNets = {
    'Ethernet 2': [{ address: '10.254.254.1', family: 'IPv4', internal: false }], // unrenamed hotspot loopback
    'WireGuard Tunnel': [{ address: '10.66.66.2', family: 'IPv4', internal: false }],
    'CloudflareWARP': [{ address: '172.16.0.2', family: 'IPv4', internal: false }],
    'NordLynx': [{ address: '10.5.0.2', family: 'IPv4', internal: false }],
    'Wi-Fi': [
      { address: '169.254.12.34', family: 'IPv4', internal: false },
      { address: '192.168.1.42', family: 'IPv4', internal: false }
    ]
  };
  const urls = allBridgeUrls(fakeNets);
  assert.equal(urls.length, 1, 'Only real router Wi-Fi IP should remain: ' + JSON.stringify(urls));
  assert.equal(urls[0].ip, '192.168.1.42');
  assert.equal(urls[0].kind, 'Wi-Fi');
  assert.equal(lanAddress(fakeNets), '192.168.1.42', 'lanAddress also skips 10.254.254.1 and VPNs');

  // With both USB tether (Ethernet 3) and router Wi-Fi, both are included in priority order
  const multiNets = {
    ...fakeNets,
    'Ethernet 3': [{ address: '192.168.42.10', family: 'IPv4', internal: false }],
    'Local Area Connection* 11': [{ address: '192.168.137.1', family: 'IPv4', internal: false }]
  };
  const multi = allBridgeUrls(multiNets);
  assert.deepEqual(multi.map((x) => x.ip), ['192.168.42.10', '192.168.137.1', '192.168.1.42']);
  console.log('PASS: Offline router / loopback / VPN IP filtering verified');
}

// 4. Verify Windows firewall rules cover offline routers & USB tethering on Public profiles
{
  const nsh = readFileSync(join(ROOT, 'desktop', 'resources', 'installer.nsh'), 'utf8');
  assert(nsh.includes('name="photobooth4u local booth"'), 'installer.nsh creates photobooth4u local booth firewall rule');
  assert(nsh.includes('protocol=TCP localport=47777-47797 enable=yes profile=any remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12'),
    'installer.nsh allows RFC1918 LAN subnets on ports 47777-47797 for all profiles');
  const hotspotSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'hotspot.mjs'), 'utf8');
  assert(hotspotSrc.includes('name="photobooth4u local booth"'), 'hotspot.mjs setup also creates local booth firewall rule');
  console.log('PASS: Windows offline router / LAN firewall rules verified');
}

// 5. Verify assembled booth.html, QR deduplication, and Android offline Wi-Fi binding
const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
assert(boothHtml.includes('TABLET_CAM_ID'), 'booth.html includes tablet-bridge.js');
assert(boothHtml.includes('id="tabletBridgeBox"'), 'booth.html includes tabletBridgeBox UI');
assert(boothHtml.includes('id="tabletBridgeGuideBtn"'), 'booth.html includes ? guide button');
assert(boothHtml.includes('id="tabletBridgeGuide"'), 'booth.html includes collapsible step-by-step guide');
assert(boothHtml.includes('id="tabletBridgeHelperNote"'), 'booth.html includes online Print Helper note');
assert(boothHtml.includes('u !== info.primaryUrl'), 'tablet-bridge.js deduplicates primaryUrl from QR urls');
assert(boothHtml.includes('id="gPrint"'), 'booth.html local GUEST_HTML includes Print button');
assert(boothHtml.includes('id="gCopiesModal"'), 'booth.html local GUEST_HTML includes Copies modal');

const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert(manifest.includes('android:name=".GuestBridgeActivity"'), 'AndroidManifest registers GuestBridgeActivity');
assert(manifest.includes('android:usesCleartextTraffic="true"'), 'AndroidManifest allows cleartext local HTTP/WS');
const mainKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'MainActivity.kt'), 'utf8');
assert(mainKt.includes('GuestBridgeActivity::class.java'), 'MainActivity launches GuestBridgeActivity');
const bridgeKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'GuestBridgeActivity.kt'), 'utf8');
assert(bridgeKt.includes('class GuestBridgeActivity'), 'GuestBridgeActivity.kt exists');
assert(bridgeKt.includes('bindProcessToNetwork'), 'GuestBridgeActivity binds process network for offline Wi-Fi WebView');
assert(bridgeKt.includes('network.openConnection(url)'), 'GuestBridgeActivity binds HTTP probes & uploads to Wi-Fi Network');
assert(bridgeKt.includes('network.socketFactory.createSocket()'), 'GuestBridgeActivity binds Camera WebSocket to Wi-Fi Network');
assert(bridgeKt.includes('override fun onReceivedError'), 'GuestBridgeActivity recovers Guest WebView on offline load errors');
assert(bridgeKt.includes('bindBridgeNetwork(null)'), 'GuestBridgeActivity releases process network binding on stop/exit');
assert(bridgeKt.includes('registerOfflineLanCallbacks'), 'GuestBridgeActivity tracks offline Wi-Fi/Ethernet via NetworkCallback');
assert(bridgeKt.includes('removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)'), 'GuestBridgeActivity requests offline Wi-Fi without requiring internet capability');
assert(bridgeKt.includes('probeViaBoundSocket'), 'GuestBridgeActivity binds source IP for USB Tether / Wi-Fi Direct probes');
assert(bridgeKt.includes('sock.keepAlive = true') && bridgeKt.includes('sock.soTimeout = 30000'), 'GuestBridgeActivity sets TCP keepalive + read timeout to heal zombie offline sockets');
const gbSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'guest-bridge.mjs'), 'utf8');
assert(gbSrc.includes('ensureHeartbeat') && gbSrc.includes('setKeepAlive') && gbSrc.includes('forceReconnect') && gbSrc.includes('lastHbAt'), 'guest-bridge.mjs runs WS heartbeat + keepalive + guest watchdog');

// Static Kotlin brace/paren balance + unique-import check on GuestBridgeActivity.kt
{
  let braces = 0, parens = 0, inStr = false, inLineC = false, inBlockC = false;
  for (let i = 0; i < bridgeKt.length; i++) {
    const c = bridgeKt[i], n = bridgeKt[i + 1];
    if (inLineC) { if (c === '\n') inLineC = false; continue; }
    if (inBlockC) { if (c === '*' && n === '/') { inBlockC = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === '"') inStr = false; continue; }
    if (c === '/' && n === '/') { inLineC = true; i++; continue; }
    if (c === '/' && n === '*') { inBlockC = true; i++; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') braces++; else if (c === '}') braces--;
    if (c === '(') parens++; else if (c === ')') parens--;
    assert(braces >= 0 && parens >= 0, 'Unbalanced delimiter in GuestBridgeActivity.kt at offset ' + i);
  }
  assert.equal(braces, 0, 'Unbalanced braces in GuestBridgeActivity.kt: ' + braces);
  assert.equal(parens, 0, 'Unbalanced parens in GuestBridgeActivity.kt: ' + parens);
  const imports = bridgeKt.match(/^import .+$/gm) || [];
  assert.equal(new Set(imports).size, imports.length, 'Duplicate imports in GuestBridgeActivity.kt');
}

// 6. Real QR encoding density check (deduplicated payload across 1..4 LAN adapters)
{
  const qrSrc = readFileSync(join(ROOT, 'desktop', 'lib', 'qr.js'), 'utf8');
  const qrcode = new Function(qrSrc + '; return qrcode;')();
  const tok = '0123456789abcdef';
  const adb = 'http://127.0.0.1:47777/bridge/' + tok;
  for (const n of [1, 2, 3, 4]) {
    const addrs = Array.from({ length: n }, (_, i) => 'http://192.168.' + (i + 1) + '.140:47777/bridge/' + tok);
    const primary = addrs[0];
    const extras = addrs.concat([adb]).filter((u, idx, arr) => u && u !== primary && arr.indexOf(u) === idx);
    const payload = JSON.stringify({ app: 'pb4u-bridge', url: primary, urls: extras });
    assert.equal(payload.split(primary).length - 1, 1, 'primaryUrl should appear once in QR payload');
    const q = qrcode(0, 'M');
    q.addData(payload);
    q.make();
    assert(q.getModuleCount() > 0 && q.getModuleCount() <= 69, 'QR module size should stay scannable for ' + n + ' adapters');
  }
  console.log('PASS: Deduplicated Step 7 bridge QR encoding verified (1..4 adapters)');
}

// 7. Live end-to-end check on real 0.0.0.0 share server over this machine's LAN Wi-Fi IP
{
  const tmp = join(tmpdir(), 'pb4u-bridge-e2e-' + Date.now());
  initPhotos({ root: tmp, dataDir: tmp });
  initBridge({ getPort: sharePortNow });
  const livePort = await startShareServer();
  assert(livePort >= 47777 && livePort <= 47797, 'startShareServer bound port ' + livePort);
  try {
    const infoLive0 = getBridgeInfo();
    const lan = infoLive0.addresses.find((a) => a.kind === 'Wi-Fi') || infoLive0.addresses[0];
    if (lan) {
      const rH = await fetch(lan.url + '/hello');
      assert.equal(rH.status, 200);
      assert.equal((await rH.json()).app, 'photobooth4u-bridge');
      const rG = await fetch(lan.url + '/guest');
      assert.equal(rG.status, 200);
      assert((await rG.text()).includes('/ws?role=guest'));

      const key = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host: lan.ip, port: livePort }, () => {
          sock.write(
            'GET /bridge/' + infoLive0.token + '/ws?role=cam HTTP/1.1\r\n' +
            'Host: ' + lan.ip + ':' + livePort + '\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: ' + key + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
          );
        });
        let h = '';
        sock.on('data', (d) => {
          h += d.toString('utf8');
          if (h.includes('\r\n\r\n')) {
            assert(h.startsWith('HTTP/1.1 101'), 'Expected 101 on LAN WS upgrade');
            assert(h.includes(expectedAccept), 'Expected valid Sec-WebSocket-Accept on LAN WS');
            const st = getBridgeInfo();
            assert.equal(st.camConnected, true);
            assert.equal(st.via && st.via.ip, lan.ip);
            assert.equal(st.via && st.via.kind, lan.kind);
            sock.destroy();
            resolve();
          }
        });
        sock.on('error', reject);
      });
      console.log('PASS: Live 0.0.0.0 share server LAN IP (' + lan.ip + ':' + livePort + ') HTTP + WS bridge verified');
    }
  } finally {
    stopShareServer();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// 8. End-to-end Online Web Booth + Print Helper bridge (tools/print-helper/bridge-ctrl.mjs)
{
  const hPort = await startHelperBridge({ ports: [0] });
  assert(hPort > 0, 'startHelperBridge bound a port');
  try {
    const cors = { 'Access-Control-Allow-Origin': 'https://photobooth4u.netlify.app', 'Access-Control-Expose-Headers': 'x-pb-seq' };
    const callCtrl = async (method, path, body, contentType) => {
      const u = new URL('http://127.0.0.1:17321' + path);
      const req = new Request(u.href, {
        method,
        headers: contentType ? { 'content-type': contentType } : {},
        body
      });
      return await handleBridgeCtrl(req, u, cors);
    };

    const rInfo = await callCtrl('GET', '/bridge-ctrl/info');
    assert.equal(rInfo.status, 200);
    const jInfo = await rInfo.json();
    assert.equal(jInfo.ok, true);
    assert.equal(jInfo.port, hPort);
    assert(jInfo.token);
    assert.equal(helperBridgeStatus().supported, true);

    // Connect tablet camera + guest WS directly to the Print Helper bridge server
    const hCam = await connectWs(hPort, '/bridge/' + jInfo.token + '/ws?role=cam');
    hCam.sendJson({ type: 'hello', deviceName: 'Online Router Tablet', facing: 'front', width: 1280, height: 960 });
    const hGuest = await connectWs(hPort, '/bridge/' + jInfo.token + '/ws?role=guest');
    await new Promise((r) => setTimeout(r, 40));

    // Preview frame through /bridge-ctrl/frame
    const previewJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7, 0xff, 0xd9]);
    hCam.sendBin(previewJpg);
    await new Promise((r) => setTimeout(r, 40));
    const rFrame = await callCtrl('GET', '/bridge-ctrl/frame?after=0&wait=500');
    assert.equal(rFrame.status, 200);
    assert(Number(rFrame.headers.get('x-pb-seq')) >= 1);
    assert.deepEqual(Buffer.from(await rFrame.arrayBuffer()), previewJpg);

    // Capture full-res shot through /bridge-ctrl/capture
    const fullJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 5, 4, 3, 2, 1, 0xff, 0xd9]);
    const capP = callCtrl('POST', '/bridge-ctrl/capture');
    const cmd = JSON.parse((await hCam.nextMsg()).data);
    assert.equal(cmd.type, 'capture');
    const shotUp = await fetch('http://127.0.0.1:' + hPort + '/bridge/' + jInfo.token + '/cam/shot?id=' + encodeURIComponent(cmd.id), {
      method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: fullJpg
    });
    assert.equal(shotUp.status, 200);
    const rCap = await capP;
    assert.equal(rCap.status, 200);
    assert.deepEqual(Buffer.from(await rCap.arrayBuffer()), fullJpg);

    // Media upload through /bridge-ctrl/media/result -> fetched by tablet
    const mediaBytes = Buffer.from('online-web-booth-result');
    const rMed = await callCtrl('POST', '/bridge-ctrl/media/result', mediaBytes, 'image/jpeg');
    assert.equal(rMed.status, 200);
    const tMed = await fetch('http://127.0.0.1:' + hPort + '/bridge/' + jInfo.token + '/media/result');
    assert.equal(tMed.status, 200);
    assert.deepEqual(Buffer.from(await tMed.arrayBuffer()), mediaBytes);

    // Push state & event -> received by tablet guest WS
    const rSt = await callCtrl('POST', '/bridge-ctrl/state', JSON.stringify({ msg: 'Online ready', isResult: false }), 'application/json');
    assert.equal(rSt.status, 200);
    assert.equal(JSON.parse((await hGuest.nextMsg()).data).state.msg, 'Online ready');
    const rEv = await callCtrl('POST', '/bridge-ctrl/event', JSON.stringify({ type: 'flash' }), 'application/json');
    assert.equal(rEv.status, 200);
    assert.equal(JSON.parse((await hGuest.nextMsg()).data).type, 'flash');

    // Tablet action -> wakes up /bridge-ctrl/poll immediately
    const seqBefore = (await (await callCtrl('GET', '/bridge-ctrl/info')).json()).seq;
    const pollP = callCtrl('GET', '/bridge-ctrl/poll?after=' + seqBefore + '&wait=2000');
    await new Promise((r) => setTimeout(r, 30));
    hGuest.sendJson({ type: 'action', action: 'trigger' });
    const rPoll = await pollP;
    assert.equal(rPoll.status, 200);
    const jPoll = await rPoll.json();
    assert(jPoll.actions.some((a) => a.action === 'trigger'), 'poll received trigger action from tablet');

    // Renew token through /bridge-ctrl/renew
    const rRen = await callCtrl('POST', '/bridge-ctrl/renew');
    assert.equal(rRen.status, 200);
    assert.notEqual((await rRen.json()).token, jInfo.token);

    hCam.close();
    hGuest.close();
    console.log('PASS: Online Web Booth + Print Helper bridge (/bridge-ctrl/*) E2E verified');
  } finally {
    stopHelperBridge();
  }
}

// 9. Sandbox check: Online Web Booth mode (DESKTOP=false) shows #tabletBridgeBox, toggles ? guide, and connects via Print Helper
{
  const src = readFileSync(join(ROOT, 'protected', 'src', 'bridge', 'tablet-bridge.js'), 'utf8');
  const els = {};
  const mkEl = (id, init = {}) => {
    const listeners = {};
    const cls = new Set();
    const el = {
      id, style: { display: 'none' }, hidden: !!init.hidden, disabled: false, dataset: {},
      textContent: '', innerHTML: '', src: '',
      classList: { toggle: (c, f) => (f ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      querySelector: () => el._span || null,
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() { }, stopPropagation() { } })); }
    };
    if (init.withSpan) el._span = { textContent: '' };
    els[id] = el;
    return el;
  };
  mkEl('tabletBridgeBox');
  mkEl('tabletBridgeGuideBtn');
  mkEl('tabletBridgeGuide', { hidden: true });
  mkEl('tabletBridgeStatus', { withSpan: true });
  mkEl('tabletBridgeHelperNote', { hidden: true });
  mkEl('tabletBridgeHelperText');
  mkEl('tabletBridgeRetryBtn');
  mkEl('tabletBridgeQrRow');
  mkEl('tabletBridgeActionsRow');
  mkEl('tabletBridgeQr');
  mkEl('tabletBridgeUrl');
  mkEl('tabletBridgeFlipBtn');
  mkEl('tabletBridgeCopyBtn');
  mkEl('tabletBridgeRenewBtn');

  let qrMade = '';
  const postedStates = [];
  const ctx = {
    console, setTimeout, setInterval: () => 0, clearInterval() { }, Promise, JSON, Array, Object, Math, Date, Number, String, Error,
    parseFloat, encodeURIComponent, AbortSignal,
    DESKTOP: false, TABLET_LOCAL: false, LANREMOTE: false, isMobileOS: () => false,
    window: {},
    document: { getElementById: (id) => els[id] || null, createElement: () => mkEl('_dyn') },
    qrcode: () => ({ addData(d) { qrMade = d; }, make() { }, createDataURL: () => 'data:image/gif;base64,OK' }),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    showToast() { }, enumerateCameras: async () => { }, updateGuestStatus() { }, updateFullStage() { },
    fetch: async (u, o) => {
      const s = String(u);
      if (s.endsWith('/bridge-ctrl/info')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true, port: 47777, seq: 1,
            primaryUrl: 'http://192.168.1.42:47777/bridge/abc12345',
            adbUrl: 'http://127.0.0.1:47777/bridge/abc12345',
            addresses: [{ ip: '192.168.1.42', kind: 'Wi-Fi', url: 'http://192.168.1.42:47777/bridge/abc12345' }],
            connected: false, camConnected: false, guestConnected: false
          })
        };
      }
      if (s.includes('/bridge-ctrl/poll')) return new Promise(() => { }); // stay pending during test
      if (s.endsWith('/bridge-ctrl/state')) { postedStates.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
  vm.runInNewContext(src, ctx);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(els.tabletBridgeBox.style.display, '', 'Online Web Booth shows #tabletBridgeBox');
  assert.equal(ctx.tabletBridge.mode, 'helper', 'Online Web Booth activates helper bridge mode');
  assert.equal(els.tabletBridgeHelperNote.hidden, true, 'Helper note hides once Print Helper answers');
  assert(qrMade.includes('192.168.1.42:47777/bridge/abc12345'), 'QR generated with laptop Wi-Fi IP on online Web Booth');

  // Toggle the ? guide button open and closed
  assert.equal(els.tabletBridgeGuide.hidden, true);
  els.tabletBridgeGuideBtn.click();
  assert.equal(els.tabletBridgeGuide.hidden, false, '? button opens step-by-step guide');
  assert.equal(els.tabletBridgeGuideBtn.attrs['aria-expanded'], 'true');
  els.tabletBridgeGuideBtn.click();
  assert.equal(els.tabletBridgeGuide.hidden, true, '? button closes step-by-step guide');
  assert.equal(els.tabletBridgeGuideBtn.attrs['aria-expanded'], 'false');
  console.log('PASS: Online Web Booth client mode + ? guide toggle verified');
}

// 10. Guest WebView offline zombie-socket heartbeat + reconnect watchdog
{
  const html = guestBridgeHtml('offlineHbTok');
  const script = /<script>\n?([\s\S]*?)\n?<\/script>/.exec(html)[1];
  let now = 100000;
  const intervals = [];
  const timeouts = [];
  const sockets = [];
  const els = {};
  const mkEl = () => {
    const classes = new Set();
    return {
      style: { setProperty() { }, removeProperty() { }, cssText: '' },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on; },
        contains: (c) => classes.has(c)
      },
      textContent: '', innerHTML: '', disabled: false,
      setAttribute() { }, getAttribute: () => null, removeAttribute() { },
      appendChild() { }, append() { }, addEventListener() { },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), querySelector: () => null
    };
  };
  class FakeWs {
    constructor(u) { this.url = u; this.readyState = 1; this.sent = []; this.closed = false; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  const FakeDate = Object.assign(function () { return new Date(now); }, { now: () => now });
  const ctx = {
    console, JSON, Math, Number, String, Array, Object, Date: FakeDate, parseFloat, parseInt, isNaN, Promise, Uint8Array, atob,
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() { },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() { },
    window: { devicePixelRatio: 1, addEventListener() { } },
    location: { protocol: 'http:', host: '192.168.8.10:47777' },
    WebSocket: FakeWs,
    Image: function () { },
    document: {
      getElementById: (id) => els[id] || (els[id] = mkEl()),
      createElement: () => mkEl(), addEventListener() { },
      body: mkEl(), documentElement: mkEl()
    }
  };
  vm.runInNewContext(script, ctx);
  assert.equal(sockets.length, 1);
  assert.equal(intervals.length, 1, 'guest page installs heartbeat watchdog interval');
  const firstWs = sockets[0];
  firstWs.onopen();

  // Heartbeat arrives after 20s -> replied & keeps connection alive
  now += 20000;
  firstWs.onmessage({ data: JSON.stringify({ type: 'hb' }) });
  assert(firstWs.sent.some((m) => m.type === 'hb'), 'guest page echoes heartbeat frame');
  now += 15000; // only 15s since last hb (< 28s)
  intervals[0].fn();
  assert.equal(firstWs.closed, false, 'active heartbeat keeps socket open');

  // Offline pocket router silently drops link -> >28s without hb closes zombie socket & schedules reconnect
  now += 20000; // 35s since last hb
  intervals[0].fn();
  assert.equal(firstWs.closed, true, 'stale offline socket closed by watchdog');
  assert.equal(els.connDot.textContent, 'Reconnecting to laptop…');
  const reconnectTimer = timeouts.find((t) => t.ms === 1200);
  assert(reconnectTimer, 'reconnect scheduled after closing zombie socket');
  reconnectTimer.fn();
  assert.equal(sockets.length, 2, 'watchdog reconnect opens a fresh WebSocket');
  console.log('PASS: Guest WebView heartbeat & offline zombie-socket watchdog verified');
}

console.log('PASS: Assembled booth.html and Android offline Wi-Fi bridge binding verified');
console.log('All Guest Bridge tests passed!');
