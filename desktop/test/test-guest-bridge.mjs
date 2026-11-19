import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initBridge,
  getBridgeInfo,
  renewBridgeToken,
  attachBridgeUpgrade,
  handleBridgeHttp,
  pushBridgeState,
  sendBridgeEvent,
  sendCamCommand,
  guestBridgeHtml
} from '../lib/guest-bridge.mjs';

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

// 3. Verify assembled booth.html and Android files
const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
assert(boothHtml.includes('TABLET_CAM_ID'), 'booth.html includes tablet-bridge.js');
assert(boothHtml.includes('id="tabletBridgeBox"'), 'booth.html includes tabletBridgeBox UI');
assert(boothHtml.includes('id="gPrint"'), 'booth.html local GUEST_HTML includes Print button');
assert(boothHtml.includes('id="gCopiesModal"'), 'booth.html local GUEST_HTML includes Copies modal');

const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
assert(manifest.includes('android:name=".GuestBridgeActivity"'), 'AndroidManifest registers GuestBridgeActivity');
const mainKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'MainActivity.kt'), 'utf8');
assert(mainKt.includes('GuestBridgeActivity::class.java'), 'MainActivity launches GuestBridgeActivity');
const bridgeKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'GuestBridgeActivity.kt'), 'utf8');
assert(bridgeKt.includes('class GuestBridgeActivity'), 'GuestBridgeActivity.kt exists');
console.log('PASS: Assembled booth.html and Android manifest/activities verified');
console.log('All Guest Bridge tests passed!');
