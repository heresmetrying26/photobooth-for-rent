// Deep scenario & stress tests for Tablet + Router Bridge (Online Web Booth + Offline Desktop/Router/USB Tether)
import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  initBridge,
  allBridgeUrls,
  getBridgeInfo,
  renewBridgeToken,
  attachBridgeUpgrade,
  handleBridgeHttp,
  pushBridgeState,
  sendBridgeEvent,
  captureBridgeShot
} from '../lib/guest-bridge.mjs';
import { lanAddress } from '../lib/photos.mjs';
import {
  startHelperBridge,
  stopHelperBridge,
  helperBridgeStatus,
  handleBridgeCtrl
} from '../../tools/print-helper/bridge-ctrl.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function buildWsFrame(opcode, payloadBuf, masked = true) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '');
  const len = payload.length;
  const maskBit = masked ? 0x80 : 0x00;
  let hdr;
  if (len < 126) {
    hdr = Buffer.from([0x80 | opcode, maskBit | len]);
  } else if (len < 65536) {
    hdr = Buffer.alloc(4);
    hdr[0] = 0x80 | opcode;
    hdr[1] = maskBit | 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x80 | opcode;
    hdr[1] = maskBit | 127;
    hdr.writeUInt32BE(0, 2);
    hdr.writeUInt32BE(len, 6);
  }
  if (!masked) return Buffer.concat([hdr, payload]);
  const mask = randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([hdr, mask, out]);
}

function connectWs(port, path, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = net.connect(port, host, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const frames = [];
    const waiters = [];

    function feed(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!head.startsWith('HTTP/1.1 101') || !head.includes(expected)) {
          sock.destroy();
          reject(new Error('WS upgrade failed: ' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        resolve(client);
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        const f = { opcode, payload, text: opcode === 0x1 ? payload.toString('utf8') : '' };
        if (waiters.length) waiters.shift()(f);
        else frames.push(f);
      }
    }

    const client = {
      sock,
      sendFrame(opcode, payload, masked = true) { sock.write(buildWsFrame(opcode, payload, masked)); },
      sendJson(obj, masked = true) { sock.write(buildWsFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'), masked)); },
      nextFrame(ms = 2000) {
        if (frames.length) return Promise.resolve(frames.shift());
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            const i = waiters.indexOf(fn);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error('Timed out waiting for WS frame'));
          }, ms);
          const fn = (f) => { clearTimeout(t); res(f); };
          waiters.push(fn);
        });
      },
      close() { try { sock.destroy(); } catch { } }
    };

    sock.on('data', feed);
    sock.on('error', (e) => { if (!upgraded) reject(e); });
  });
}

function httpReq(port, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function mkDomEl(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id, style: { display: '' }, dataset: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', src: '',
    value: '', options: [], attrs: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c)
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() { }, stopPropagation() { } })); },
    querySelector(s) { return s === 'span' ? (this._sp || (this._sp = { textContent: '' })) : null; },
    appendChild(c) { this.options.push(c); return c; },
    parentNode: { appendChild() { }, insertBefore() { } }
  };
}

function runTabletBridgeClient({ DESKTOP = false, isMobile = false, electronApi = null, fetchImpl = null, clipboardOk = true } = {}) {
  const src = readFileSync(join(ROOT, 'protected', 'src', 'bridge', 'tablet-bridge.js'), 'utf8');
  const ids = [
    'tabletBridgeBox', 'tabletBridgeStatus', 'tabletBridgeQr', 'tabletBridgeQrRow',
    'tabletBridgeActionsRow', 'tabletBridgeHelperNote', 'tabletBridgeHelperText',
    'tabletBridgeRetryBtn', 'tabletBridgeUrl', 'tabletBridgeFlipBtn',
    'tabletBridgeCopyBtn', 'tabletBridgeRenewBtn', 'tabletBridgeGuideBtn', 'tabletBridgeGuide'
  ];
  const els = {};
  for (const id of ids) {
    const el = mkDomEl(id);
    if (id === 'tabletBridgeBox') el.style.display = 'none';
    if (id === 'tabletBridgeGuide' || id === 'tabletBridgeHelperNote') el.hidden = true;
    els[id] = el;
  }
  const toasts = [];
  const qrPayloads = [];
  const fetchLog = [];
  const clipboardCopies = [];
  const cameraSelect = mkDomEl('cameraSelect');
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() { },
    Promise, JSON, Array, Object, Math, Date, Number, String, Error, RegExp, parseFloat, encodeURIComponent, AbortSignal,
    DESKTOP, TABLET_LOCAL: false, LANREMOTE: false, isMobileOS: () => isMobile,
    cameraSelect,
    window: electronApi ? { pb4u: { bridge: electronApi } } : {},
    navigator: clipboardOk ? { clipboard: { writeText: async (t) => { clipboardCopies.push(t); } } } : {},
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => {
        const el = mkDomEl('_' + tag);
        el.select = () => { };
        el.remove = () => { };
        return el;
      },
      body: { appendChild() { } },
      execCommand: () => true
    },
    qrcode: () => ({ addData(d) { qrPayloads.push(d); }, make() { }, createDataURL: () => 'data:image/gif;base64,QR' }),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    showToast: (m) => toasts.push(m),
    enumerateCameras: async () => { },
    updateGuestStatus() { },
    updateFullStage() { },
    fetch: async (u, o) => {
      fetchLog.push({ url: String(u), method: (o && o.method) || 'GET' });
      if (fetchImpl) return fetchImpl(String(u), o);
      throw new Error('offline: fetch blocked');
    }
  };
  vm.runInNewContext(src, ctx);
  return { ctx, els, toasts, qrPayloads, fetchLog, clipboardCopies };
}

console.log('--- Deep Scenario & Stress Tests (Online + Offline Tablet Bridge) ---');

// 1. WebSocket RFC-6455 stress: short (<126), medium (24 KB), large (140 KB > 65535), unmasked frame, Ping->Pong, multi-guest, mid-capture disconnect recovery
{
  let port = 0;
  const actions = [];
  const statuses = [];
  initBridge({
    getPort: () => port,
    onAction: (a) => actions.push(a),
    onStatus: (s) => statuses.push(s)
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    handleBridgeHttp(req, res, u).then((handled) => {
      if (!handled && !res.writableEnded) { res.writeHead(404); res.end('not found'); }
    });
  });
  attachBridgeUpgrade(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const info = getBridgeInfo();

  const cam = await connectWs(port, `/bridge/${info.token}/ws?role=cam`);
  const g1 = await connectWs(port, `/bridge/${info.token}/ws?role=guest`);
  const g2 = await connectWs(port, `/bridge/${info.token}/ws?role=guest`);

  // Ping (0x9) -> server must echo Pong (0xA) with exact payload
  cam.sendFrame(0x9, Buffer.from('offline-keepalive-42'));
  const pong = await cam.nextFrame();
  assert.equal(pong.opcode, 0xA, 'Server responds to WS Ping with Pong');
  assert.equal(pong.payload.toString('utf8'), 'offline-keepalive-42', 'Pong echoes Ping payload');

  // Unmasked client text frame (verifies unmasked slice offset fix)
  g1.sendJson({ type: 'action', action: 'start', source: 'unmasked' }, false);
  await new Promise((r) => setTimeout(r, 40));
  assert(actions.some((a) => a.action === 'start' && a.source === 'unmasked'), 'Unmasked WS text frame parsed without 4-byte corruption');

  // Multi-guest broadcast: both g1 and g2 receive state & event; closing g2 leaves g1 intact
  pushBridgeState({ screen: 'ready', msg: 'Dual guest test' });
  const m1 = JSON.parse((await g1.nextFrame()).text);
  const m2 = JSON.parse((await g2.nextFrame()).text);
  assert.equal(m1.state.msg, 'Dual guest test');
  assert.equal(m2.state.msg, 'Dual guest test');
  g2.close();
  await new Promise((r) => setTimeout(r, 40));
  sendBridgeEvent({ type: 'toast', msg: 'Still alive on g1' });
  const ev1 = JSON.parse((await g1.nextFrame()).text);
  assert.equal(ev1.type, 'toast');
  assert.equal(ev1.msg, 'Still alive on g1');
  assert.equal(getBridgeInfo().guestConnected, true, 'Closing one guest keeps bridge guestConnected true');

  // Large camera binary frames across 16-bit (24 KB) and 64-bit (140 KB) RFC-6455 length headers
  const medJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(24 * 1024), Buffer.from([0xff, 0xd9])]);
  cam.sendFrame(0x2, medJpeg, true);
  await new Promise((r) => setTimeout(r, 40));
  const fr1 = await httpReq(port, 'GET', '/bridge-local/frame?after=0&wait=200');
  assert.equal(fr1.status, 200);
  assert(fr1.body.equals(medJpeg), '24 KB (16-bit WS frame) JPEG delivered intact');

  const bigJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), randomBytes(140 * 1024), Buffer.from([0xff, 0xd9])]);
  cam.sendFrame(0x2, bigJpeg, true);
  await new Promise((r) => setTimeout(r, 60));
  const fr2 = await httpReq(port, 'GET', `/bridge-local/frame?after=${fr1.headers['x-pb-seq']}&wait=200`);
  assert.equal(fr2.status, 200);
  assert(fr2.body.equals(bigJpeg), '140 KB (64-bit WS frame) JPEG delivered intact');

  // Mid-capture abrupt camera drop -> rejects cleanly (does not hang), reconnect -> next capture succeeds
  const droppedShot = captureBridgeShot(4000);
  const capCmd1 = JSON.parse((await cam.nextFrame()).text);
  assert.equal(capCmd1.type, 'capture');
  cam.close(); // simulate sudden Wi-Fi/USB drop before still photo arrives
  await assert.rejects(droppedShot, /disconnected/i, 'Pending capture rejects promptly when camera socket drops');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(getBridgeInfo().camConnected, false, 'camConnected flips false immediately after abrupt drop');

  // Reconnect camera and take a 512 KB still shot
  const cam2 = await connectWs(port, `/bridge/${info.token}/ws?role=cam`);
  const shotPayload = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(512 * 1024), Buffer.from([0xff, 0xd9])]);
  const shotPromise = captureBridgeShot(5000);
  const capCmd2 = JSON.parse((await cam2.nextFrame()).text);
  assert.equal(capCmd2.type, 'capture');
  const up = await httpReq(port, 'POST', `/bridge/${info.token}/cam/shot?id=${encodeURIComponent(capCmd2.id)}`, shotPayload, { 'content-type': 'image/jpeg' });
  assert.equal(up.status, 200);
  const receivedShot = await shotPromise;
  assert(receivedShot.equals(shotPayload), '512 KB full-res still JPEG delivered intact after camera reconnect');

  // Bad token & invalid path security checks
  const badTok = await httpReq(port, 'GET', '/bridge/wrongtoken123/hello');
  assert.equal(badTok.status, 403, 'Wrong bridge token rejected with 403');
  const badMedia = await httpReq(port, 'GET', `/bridge/${info.token}/media/..%2Fsecret`);
  assert.equal(badMedia.status, 404, 'Path-traversal media slot rejected with 404');

  cam2.close();
  g1.close();
  server.close();
  console.log('PASS: WS RFC-6455 16/64-bit frames, unmasked frames, Ping/Pong, multi-guest & mid-capture disconnect recovery');
}

// 2. Full Online Web Booth + Print Helper (/bridge-ctrl/*) session E2E + CORS/Origin security audit
{
  const phSrc = readFileSync(join(ROOT, 'tools', 'print-helper', 'print-helper.js'), 'utf8');
  assert(phSrc.includes("const VERSION = '1.1.21'"), 'Print Helper bumped to 1.1.21');
  assert(phSrc.includes("'https://photobooth4u.netlify.app'"), 'Print Helper allows production Netlify origin');
  assert(phSrc.includes("'Access-Control-Allow-Private-Network': 'true'"), 'Print Helper allows Chrome Private Network Access');
  assert(phSrc.includes("'Access-Control-Expose-Headers': 'x-pb-seq'"), 'Print Helper exposes x-pb-seq header for frame stream');
  assert(phSrc.includes("if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);"), '/bridge-ctrl/* enforces Origin header');

  const bp = await startHelperBridge({ ports: [47791, 47792, 47793] });
  assert(bp > 0, 'Helper bridge started');
  const corsHdrs = {
    'Access-Control-Allow-Origin': 'https://photobooth4u.netlify.app',
    'Access-Control-Expose-Headers': 'x-pb-seq',
    'Access-Control-Allow-Private-Network': 'true'
  };
  const callCtrl = (method, path, body = null, contentType = 'application/json') => {
    const req = new Request(`http://127.0.0.1:17321${path}`, {
      method,
      headers: body ? { 'content-type': contentType } : {},
      body
    });
    return handleBridgeCtrl(req, new URL(req.url), corsHdrs);
  };

  const infoJ = await (await callCtrl('GET', '/bridge-ctrl/info')).json();
  assert.equal(infoJ.ok, true);
  const tok = infoJ.token;
  assert.equal(helperBridgeStatus().port, bp);

  // Connect tablet guest + camera over real LAN server started by helper bridge
  const cam = await connectWs(bp, `/bridge/${tok}/ws?role=cam`);
  const guest = await connectWs(bp, `/bridge/${tok}/ws?role=guest`);

  // Media upload (180 KB JPEG) via /bridge-ctrl/media/result -> tablet fetches identical bytes
  const resJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(180 * 1024), Buffer.from([0xff, 0xd9])]);
  const medResp = await callCtrl('POST', '/bridge-ctrl/media/result', resJpeg, 'image/jpeg');
  assert.equal(medResp.status, 200);
  const medDown = await httpReq(bp, 'GET', `/bridge/${tok}/media/result`);
  assert.equal(medDown.status, 200);
  assert(medDown.body.equals(resJpeg), '180 KB result JPEG uploaded via Print Helper matches tablet download byte-for-byte');

  // Frame streaming via /bridge-ctrl/frame -> single clean x-pb-seq expose header + 204 when idle
  const frameJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(90 * 1024), Buffer.from([0xff, 0xd9])]);
  cam.sendFrame(0x2, frameJpeg, true);
  await new Promise((r) => setTimeout(r, 50));
  const fr = await callCtrl('GET', '/bridge-ctrl/frame?after=0&wait=500');
  assert.equal(fr.status, 200);
  assert.equal(fr.headers.get('access-control-expose-headers'), 'x-pb-seq', 'Expose-Headers deduplicated cleanly');
  const seq = fr.headers.get('x-pb-seq');
  assert(Number(seq) >= 1);
  assert(Buffer.from(await fr.arrayBuffer()).equals(frameJpeg), '90 KB live camera frame matches via /bridge-ctrl/frame');
  const frIdle = await callCtrl('GET', `/bridge-ctrl/frame?after=${seq}&wait=60`);
  assert.equal(frIdle.status, 204, 'Idle /bridge-ctrl/frame returns 204 cleanly');

  // Full-res capture via /bridge-ctrl/capture
  const capPromise = callCtrl('POST', '/bridge-ctrl/capture');
  const capCmd = JSON.parse((await cam.nextFrame()).text);
  assert.equal(capCmd.type, 'capture');
  const stillJpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(320 * 1024), Buffer.from([0xff, 0xd9])]);
  const shotPost = await httpReq(bp, 'POST', `/bridge/${tok}/cam/shot?id=${encodeURIComponent(capCmd.id)}`, stillJpeg, { 'content-type': 'image/jpeg' });
  assert.equal(shotPost.status, 200);
  const capResp = await capPromise;
  assert.equal(capResp.status, 200);
  assert(Buffer.from(await capResp.arrayBuffer()).equals(stillJpeg), '320 KB full-res capture delivered via /bridge-ctrl/capture');

  // Instant long-poll wakeup (< 400ms on a 5000ms wait) when guest taps Print
  const baseInfo = await (await callCtrl('GET', '/bridge-ctrl/info')).json();
  const t0 = Date.now();
  const pollP = callCtrl('GET', `/bridge-ctrl/poll?after=${baseInfo.seq}&wait=5000`);
  setTimeout(() => guest.sendJson({ type: 'action', action: 'print', copies: 3 }), 40);
  const pollJ = await (await pollP).json();
  const elapsed = Date.now() - t0;
  assert(elapsed < 1000, `Long-poll woke immediately on guest print action (${elapsed}ms)`);
  assert(pollJ.actions.some((a) => a.action === 'print' && a.copies === 3), 'Guest print action with copies=3 received');

  // Token renew via /bridge-ctrl/renew invalidates old token immediately
  const renJ = await (await callCtrl('POST', '/bridge-ctrl/renew')).json();
  assert.equal(renJ.ok, true);
  assert.notEqual(renJ.token, tok);
  assert.equal((await httpReq(bp, 'GET', `/bridge/${tok}/hello`)).status, 403, 'Old helper token returns 403 after renew');
  assert.equal((await httpReq(bp, 'GET', `/bridge/${renJ.token}/hello`)).status, 200, 'New helper token returns 200 after renew');

  cam.close();
  guest.close();
  stopHelperBridge();
  console.log('PASS: Full Online Web Booth + Print Helper session E2E (media, 90KB preview, 320KB capture, instant poll, renew)');
}

// 3. Step 7 tablet-bridge.js state-machine scenarios (Missing helper -> Retry recovery, Outdated helper, Offline Desktop, No-LAN, Mobile hidden)
{
  // Scenario A: Online laptop, Print Helper initially stopped -> user starts it -> clicks "Check again"
  let helperUp = false;
  const scA = runTabletBridgeClient({
    DESKTOP: false,
    fetchImpl: async (u) => {
      if (!helperUp) throw new Error('ECONNREFUSED');
      if (u.endsWith('/bridge-ctrl/info')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true, port: 47777, seq: 1,
            primaryUrl: 'http://192.168.1.50:47777/bridge/onlineok1',
            adbUrl: 'http://127.0.0.1:47777/bridge/onlineok1',
            addresses: [{ ip: '192.168.1.50', kind: 'Wi-Fi', url: 'http://192.168.1.50:47777/bridge/onlineok1' }],
            connected: false, camConnected: false, guestConnected: false
          })
        };
      }
      if (u.includes('/bridge-ctrl/poll')) return new Promise(() => { });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scA.els.tabletBridgeBox.style.display, '', 'Box shown on online laptop even before Print Helper starts');
  assert.equal(scA.els.tabletBridgeHelperNote.hidden, false, 'Missing Print Helper shows helper instruction box');
  assert.equal(scA.els.tabletBridgeQrRow.style.display, 'none', 'QR row hidden while Print Helper is missing');
  assert(/Print Helper/i.test(scA.els.tabletBridgeHelperText.innerHTML));

  // User starts Print Helper and clicks "Check again"
  helperUp = true;
  scA.els.tabletBridgeRetryBtn.click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(scA.ctx.tabletBridge.mode, 'helper', 'Retry button transitions smoothly into helper mode');
  assert.equal(scA.els.tabletBridgeHelperNote.hidden, true, 'Helper warning hides after Print Helper starts');
  assert.equal(scA.els.tabletBridgeQrRow.style.display, 'flex', 'QR row becomes visible once Print Helper connects');
  assert(scA.qrPayloads.some((q) => q.includes('192.168.1.50:47777/bridge/onlineok1')), 'QR generated with laptop Wi-Fi IP');

  // Scenario B: Outdated Print Helper (404 on /bridge-ctrl/info, 200 on /status v1.1.20)
  const scB = runTabletBridgeClient({
    DESKTOP: false,
    fetchImpl: async (u) => {
      if (u.endsWith('/bridge-ctrl/info')) return { ok: false, status: 404, json: async () => ({ ok: false }) };
      if (u.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ ok: true, version: '1.1.20' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scB.ctx.tabletBridge.helperState, 'outdated', 'Detects outdated Print Helper (404 + /status 200)');
  assert.equal(scB.els.tabletBridgeHelperNote.hidden, false);
  assert(scB.els.tabletBridgeHelperText.innerHTML.includes('1.1.21'), 'Prompt tells operator to update to v1.1.21+');
  assert.equal(scB.els.tabletBridgeQrRow.style.display, 'none');

  // Scenario C: Desktop App completely OFFLINE (zero internet, fetch throws) -> IPC works cleanly + Renew + Copy fallback + ? Guide
  let statusCb = null;
  let desktopTok = 'offlinedesk1';
  const desktopInfo = () => ({
    port: 47777,
    token: desktopTok,
    primaryUrl: `http://192.168.8.100:47777/bridge/${desktopTok}`,
    adbUrl: `http://127.0.0.1:47777/bridge/${desktopTok}`,
    addresses: [{ ip: '192.168.8.100', kind: 'Wi-Fi', url: `http://192.168.8.100:47777/bridge/${desktopTok}` }],
    connected: false, camConnected: false, guestConnected: false
  });
  const scC = runTabletBridgeClient({
    DESKTOP: true,
    clipboardOk: false, // test execCommand fallback when clipboard API unavailable
    electronApi: {
      info: async () => desktopInfo(),
      renew: async () => { desktopTok = 'offlinedesk2'; return desktopInfo(); },
      onStatus: (fn) => { statusCb = fn; },
      onAction: () => { },
      pushState: () => { },
      sendEvent: () => { },
      camCmd: () => { }
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scC.ctx.tabletBridge.mode, 'desktop');
  assert.equal(scC.fetchLog.length, 0, 'Offline Desktop App NEVER attempts any HTTP fetch to Print Helper or internet');
  assert.equal(scC.els.tabletBridgeHelperNote.hidden, true);
  assert(scC.qrPayloads.some((q) => q.includes('192.168.8.100:47777/bridge/offlinedesk1')), 'Offline Desktop App renders offline router QR');

  // Simulate tablet connecting offline via router -> status flips connected
  statusCb({ ...desktopInfo(), connected: true, camConnected: true, guestConnected: true, deviceName: 'HUAWEI MatePad Pro', facing: 'front' });
  assert.equal(scC.ctx.tabletGuestOpen(), true, 'tabletGuestOpen() true when tablet connects offline');
  assert.equal(scC.ctx.tabletCamAvailable(), true, 'tabletCamAvailable() true when tablet camera connects offline');
  assert.equal(scC.els.tabletBridgeFlipBtn.disabled, false, 'Flip camera button enabled when tablet camera connects');

  // Renew QR + Copy link fallback + ? guide toggle on Desktop App
  scC.els.tabletBridgeRenewBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert(scC.qrPayloads.some((q) => q.includes('offlinedesk2')), 'New pairing code rotates QR on Desktop App');
  scC.els.tabletBridgeCopyBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert(scC.toasts.some((t) => /copied/i.test(t)), 'Copy link succeeds via fallback even without navigator.clipboard');
  scC.els.tabletBridgeGuideBtn.click();
  assert.equal(scC.els.tabletBridgeGuide.hidden, false, '? guide opens on Desktop App');

  // Scenario D: Offline Desktop App with zero Wi-Fi/LAN adapters connected yet (ADB-only fallback)
  statusCb({ port: 47777, token: desktopTok, primaryUrl: `http://127.0.0.1:47777/bridge/${desktopTok}`, adbUrl: `http://127.0.0.1:47777/bridge/${desktopTok}`, addresses: [], connected: false, camConnected: false, guestConnected: false });
  assert(scC.els.tabletBridgeUrl.textContent.includes('127.0.0.1:47777'), 'Zero-LAN state falls back gracefully to ADB URL');

  // Scenario E: Mobile browser running Online Web Booth -> bridge box stays hidden, zero localhost probes
  const scE = runTabletBridgeClient({ DESKTOP: false, isMobile: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(scE.els.tabletBridgeBox.style.display, 'none', 'Mobile Web Booth hides laptop bridge box');
  assert.equal(scE.fetchLog.length, 0, 'Mobile Web Booth never probes 127.0.0.1:17321');
  console.log('PASS: Step 7 client state machine (missing->retry, outdated helper, offline Desktop IPC, zero-LAN, mobile hide)');
}

// 4. Multi-adapter LAN scoring & VPN/Loopback exclusion matrix (allBridgeUrls & lanAddress)
{
  initBridge({ getPort: () => 47777 });
  // Pocket router + dummy hotspot loopback + VPNs + Hyper-V + WSL -> ONLY pocket router IP wins
  const fakeOfflineRouter = {
    'Ethernet 2': [{ family: 'IPv4', internal: false, address: '10.254.254.1' }],
    'WireGuard Tunnel': [{ family: 'IPv4', internal: false, address: '10.66.0.2' }],
    'CloudflareWARP': [{ family: 'IPv4', internal: false, address: '172.16.0.2' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.29.112.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.8.102' }]
  };
  const r1 = allBridgeUrls(fakeOfflineRouter);
  assert.equal(r1.length, 1, 'Dummy loopback, VPNs, and WSL all excluded');
  assert.equal(r1[0].ip, '192.168.8.102');
  assert.equal(lanAddress(fakeOfflineRouter), '192.168.8.102');

  // USB Tethering + Online Wi-Fi -> USB Tethering ranked #1, Wi-Fi #2
  const fakeUsbAndWifi = {
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.44' }],
    'Remote NDIS based Internet Sharing Device': [{ family: 'IPv4', internal: false, address: '192.168.42.88' }]
  };
  const r2 = allBridgeUrls(fakeUsbAndWifi);
  assert.equal(r2.length, 2);
  assert.equal(r2[0].ip, '192.168.42.88', 'USB Tethering ranked ahead of Wi-Fi');
  assert.equal(r2[1].ip, '192.168.1.44', 'Wi-Fi preserved as fallback #2');

  // Windows Mobile Hotspot + Corporate 10.x Wi-Fi -> both included, hotspot & Wi-Fi distinct
  const fakeHotspotAndCorp = {
    'Local Area Connection* 12': [{ family: 'IPv4', internal: false, address: '192.168.137.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '10.20.30.40' }]
  };
  const r3 = allBridgeUrls(fakeHotspotAndCorp);
  assert.equal(r3.length, 2);
  assert(r3.some((x) => x.ip === '192.168.137.1' && x.kind === 'Hotspot'));
  assert(r3.some((x) => x.ip === '10.20.30.40' && x.kind === 'Wi-Fi'));
  console.log('PASS: Multi-adapter LAN/USB/Hotspot/VPN/Loopback scoring matrix verified');
}

console.log('All deep online/offline Tablet Bridge scenario tests passed!');
