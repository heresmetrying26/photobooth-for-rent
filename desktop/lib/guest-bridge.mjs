// Tablet Guest Screen + Camera Bridge (Android / Huawei MatePad Pro over USB Tethering, ADB, or Wi-Fi).
//
// Shares the desktop share HTTP server (port 47777+) so nothing extra has to bind a new port:
//   - Tablet native Camera2 opens a WebSocket to  ws://<laptop>:<port>/bridge/<token>/ws?role=cam
//     and streams live JPEG preview frames (binary) + uploads full-res still JPEGs to
//     POST /bridge/<token>/cam/shot?id=<reqId>.
//   - Tablet WebView opens http://<laptop>:<port>/bridge/<token>/guest and connects over WebSocket to
//     ws://<laptop>:<port>/bridge/<token>/ws?role=guest for real-time Guest Screen state, ticks,
//     flashes, QR codes, print buttons/copies modal, and guest touch actions back to the laptop.
//   - Laptop renderer reads live preview frames at http://127.0.0.1:<port>/bridge-local/frame,
//     fires full-res tablet captures at POST http://127.0.0.1:<port>/bridge-local/capture, and
//     pushes binary media (result photo, welcome poster, brand logo, layout thumbs) to
//     POST http://127.0.0.1:<port>/bridge-local/media/<slot>.
import { createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_PAYLOAD = 8 * 1024 * 1024;
const MAX_HTTP_BODY = 32 * 1024 * 1024;
const VIRTUAL_IFACE = /(vEthernet|VirtualBox|VMware|Hyper-V|docker|br-|veth|utun|awdl|llw|bridge|ZeroTier|Tailscale|Loopback|vboxnet|WSL)/i;

let cfg = {
  getPort: () => 0,
  onStatus: () => { },
  onAction: () => { },
  logger: () => { }
};

let token = randomBytes(8).toString('hex');
let camSocket = null;
const guestSockets = new Set();

const camState = {
  connected: false,
  deviceName: '',
  cameras: [],
  facing: 'front',
  width: 0,
  height: 0,
  latestFrame: null,
  frameSeq: 0,
  frameAt: 0
};

let lastStateMsg = null;
const mediaStore = new Map(); // slot -> { type, buf, seq }
let mediaSeq = 0;
const pendingShots = new Map(); // reqId -> { resolve, reject, timer }
const frameWaiters = new Set(); // resolve functions waiting for next frame

function log(msg) {
  try { cfg.logger('[bridge] ' + msg); } catch { /* ignore */ }
}

export function initBridge(options = {}) {
  cfg = {
    getPort: typeof options.getPort === 'function' ? options.getPort : () => 0,
    onStatus: typeof options.onStatus === 'function' ? options.onStatus : () => { },
    onAction: typeof options.onAction === 'function' ? options.onAction : () => { },
    logger: typeof options.logger === 'function' ? options.logger : () => { }
  };
}

export function allBridgeUrls() {
  const port = Number(cfg.getPort()) || 0;
  if (!port) return [];
  const nets = networkInterfaces();
  const cands = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const a of list || []) {
      if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (/^169\.254\./.test(a.address)) continue;
      let score = 0;
      let kind = 'LAN';
      if (/rndis|usb|tether|remote ndis/i.test(name)) { score += 10; kind = 'USB Tether'; }
      else if (/^192\.168\.137\./.test(a.address)) { score += 8; kind = 'Hotspot'; }
      else if (/^(wi-?fi|wlan|en0|en1|wireless|local area connection\*)/i.test(name)) { score += 6; kind = 'Wi-Fi'; }
      // Windows names an Android phone or tablet in USB-tethering mode just "Ethernet 3" (its driver is called Remote NDIS), so the name
      // alone cannot tell it from a wired network. A numbered Ethernet adapter on a private address is listed first: either way it is
      // a cable, steadier than the venue's Wi-Fi, and the tablet takes the first address that answers.
      else if (/^ethernet \d+$/i.test(name)) { score += 11; kind = 'USB tether / Ethernet'; }
      else if (/^ethernet/i.test(name)) { score += 5; kind = 'Ethernet / USB'; }
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (VIRTUAL_IFACE.test(name)) {
        if (/^bridge100$/i.test(name) || (/^192\.168\.[23]\./.test(a.address) && /^bridge/i.test(name))) score += 4;
        else continue;
      }
      cands.push({ ip: a.address, name, kind, score, url: 'http://' + a.address + ':' + port + '/bridge/' + token });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

// The laptop address a connected tablet came in on (so Setup can say "over Wi-Fi" or "over the USB cable").
function socketVia(socket) {
  return String((socket && socket.localAddress) || '').replace(/^::ffff:/, '');
}

export function getBridgeInfo() {
  const port = Number(cfg.getPort()) || 0;
  const addresses = allBridgeUrls();
  let viaIp = '';
  if (camSocket && !camSocket.destroyed) viaIp = socketVia(camSocket);
  else if (guestSockets.size > 0) viaIp = socketVia([...guestSockets][0]);
  const viaHit = viaIp ? addresses.find((x) => x.ip === viaIp) : null;
  const via = viaIp ? { ip: viaIp, kind: viaIp === '127.0.0.1' ? 'USB cable (ADB)' : (viaHit ? viaHit.kind : 'LAN') } : null;
  const adbUrl = port ? 'http://127.0.0.1:' + port + '/bridge/' + token : null;
  const primaryUrl = addresses.length ? addresses[0].url : adbUrl;
  return {
    token,
    port,
    primaryUrl,
    adbUrl,
    addresses: addresses.map((x) => ({ ip: x.ip, name: x.name, kind: x.kind, url: x.url })),
    connected: camState.connected || guestSockets.size > 0,
    via,
    camConnected: camState.connected,
    guestConnected: guestSockets.size > 0,
    guestCount: guestSockets.size,
    deviceName: camState.deviceName || (guestSockets.size > 0 ? 'Tablet' : ''),
    cameras: camState.cameras,
    facing: camState.facing,
    width: camState.width,
    height: camState.height,
    frameSeq: camState.frameSeq,
    frameAt: camState.frameAt
  };
}

function notifyStatus() {
  try { cfg.onStatus(getBridgeInfo()); } catch { /* ignore */ }
}

export function renewBridgeToken() {
  token = randomBytes(8).toString('hex');
  try { if (camSocket) wsClose(camSocket, 1000, 'token renewed'); } catch { /* ignore */ }
  for (const s of [...guestSockets]) {
    try { wsClose(s, 1000, 'token renewed'); } catch { /* ignore */ }
  }
  camState.connected = false;
  camState.latestFrame = null;
  notifyStatus();
  return getBridgeInfo();
}

// ---------- minimal RFC-6455 WebSocket implementation ----------
function wsSendFrame(socket, opcode, payloadBuf) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf || ''), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  try {
    socket.write(Buffer.concat([header, payload]));
    return true;
  } catch {
    return false;
  }
}

function wsSendJson(socket, obj) {
  return wsSendFrame(socket, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function wsClose(socket, code = 1000, reason = '') {
  if (!socket || socket.destroyed) return;
  try {
    const r = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
    const b = Buffer.allocUnsafe(2 + r.length);
    b.writeUInt16BE(code, 0);
    r.copy(b, 2);
    wsSendFrame(socket, 0x8, b);
  } catch { /* ignore */ }
  try { socket.end(); } catch { /* ignore */ }
}

function attachWsReader(socket, onMessage, onDone) {
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];
  let fragLen = 0;

  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const hi = buf.readUInt32BE(2);
        const lo = buf.readUInt32BE(6);
        if (hi !== 0 || lo > MAX_WS_PAYLOAD) { wsClose(socket, 1009, 'too big'); return; }
        len = lo;
        off = 10;
      }
      if (len > MAX_WS_PAYLOAD) { wsClose(socket, 1009, 'too big'); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const raw = buf.subarray(off + 4, need);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
      } else {
        payload = Buffer.from(buf.subarray(off + 4, need));
      }
      buf = buf.subarray(need);

      if (opcode === 0x8) { wsClose(socket, 1000); return; }
      if (opcode === 0x9) { wsSendFrame(socket, 0xA, payload); continue; }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) {
        if (!fragOpcode) continue;
        fragLen += payload.length;
        if (fragLen > MAX_WS_PAYLOAD) { wsClose(socket, 1009, 'too big'); return; }
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const op = fragOpcode;
          fragOpcode = 0; fragChunks = []; fragLen = 0;
          onMessage(op, full);
        }
      } else if (!fin) {
        fragOpcode = opcode;
        fragChunks = [payload];
        fragLen = payload.length;
      } else {
        onMessage(opcode, payload);
      }
    }
  });

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onDone();
  };
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', finish);
}

function handleCamText(msg) {
  let j;
  try { j = JSON.parse(msg); } catch { return; }
  if (!j || typeof j !== 'object') return;
  if (j.type === 'hello') {
    camState.connected = true;
    camState.deviceName = String(j.deviceName || 'Huawei / Android Tablet').slice(0, 80);
    camState.cameras = Array.isArray(j.cameras) ? j.cameras.slice(0, 8) : [];
    camState.facing = j.facing === 'back' ? 'back' : 'front';
    camState.width = Number(j.width) || camState.width;
    camState.height = Number(j.height) || camState.height;
    log('Camera connected: ' + camState.deviceName + ' (' + camState.facing + ')');
    notifyStatus();
    return;
  }
  if (j.type === 'status') {
    if (j.facing) camState.facing = j.facing === 'back' ? 'back' : 'front';
    if (j.width) camState.width = Number(j.width) || camState.width;
    if (j.height) camState.height = Number(j.height) || camState.height;
    notifyStatus();
    return;
  }
  if (j.type === 'shotError' && j.id) {
    const p = pendingShots.get(String(j.id));
    if (p) {
      pendingShots.delete(String(j.id));
      clearTimeout(p.timer);
      p.reject(new Error(String(j.error || 'Tablet camera capture failed')));
    }
  }
}

function pushFrame(buf) {
  if (!buf || !buf.length) return;
  camState.latestFrame = buf;
  camState.frameSeq++;
  camState.frameAt = Date.now();
  if (frameWaiters.size) {
    for (const resolve of [...frameWaiters]) {
      frameWaiters.delete(resolve);
      try { resolve(true); } catch { /* ignore */ }
    }
  }
}

export function attachBridgeUpgrade(httpServer) {
  if (!httpServer) return;
  httpServer.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    const m = /^\/bridge\/([A-Za-z0-9_-]{6,64})\/ws\/?$/.exec(url.pathname);
    if (!m || m[1] !== token) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = String(req.headers['sec-websocket-key'] || '').trim();
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const role = url.searchParams.get('role') === 'cam' ? 'cam' : 'guest';
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);

    if (role === 'cam') {
      if (camSocket && camSocket !== socket) wsClose(camSocket, 1000, 'replaced');
      camSocket = socket;
      camState.connected = true;
      notifyStatus();
      attachWsReader(socket, (op, payload) => {
        if (op === 0x2) pushFrame(payload);
        else if (op === 0x1) handleCamText(payload.toString('utf8'));
      }, () => {
        if (camSocket === socket) {
          camSocket = null;
          camState.connected = false;
          for (const [id, p] of pendingShots) {
            clearTimeout(p.timer);
            p.reject(new Error('Tablet camera disconnected'));
            pendingShots.delete(id);
          }
          notifyStatus();
        }
      });
    } else {
      guestSockets.add(socket);
      notifyStatus();
      if (lastStateMsg) wsSendJson(socket, lastStateMsg);
      attachWsReader(socket, (op, payload) => {
        if (op !== 0x1) return;
        let j;
        try { j = JSON.parse(payload.toString('utf8')); } catch { return; }
        if (j && j.type === 'action') {
          try { cfg.onAction(j); } catch { /* ignore */ }
        }
      }, () => {
        guestSockets.delete(socket);
        notifyStatus();
      });
    }
  });
}

// ---------- Laptop -> Tablet controls ----------
export function pushBridgeState(state) {
  const msg = { type: 'state', state: state || {} };
  lastStateMsg = msg;
  for (const s of guestSockets) wsSendJson(s, msg);
  return guestSockets.size;
}

export function sendBridgeEvent(ev) {
  if (!ev || typeof ev !== 'object') return 0;
  if (ev.type === 'state') return pushBridgeState(ev.state);
  let n = 0;
  for (const s of guestSockets) {
    if (wsSendJson(s, ev)) n++;
  }
  return n;
}

export function sendCamCommand(cmd) {
  if (!camSocket || camSocket.destroyed) return { ok: false, error: 'Tablet camera not connected' };
  const ok = wsSendJson(camSocket, cmd || {});
  return { ok };
}

async function requestTabletShot(timeoutMs = 15000) {
  if (!camSocket || camSocket.destroyed) {
    throw new Error('Tablet camera is not connected');
  }
  const id = randomBytes(6).toString('hex');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingShots.delete(id);
      if (camState.latestFrame && Date.now() - camState.frameAt < 2500) {
        resolve(camState.latestFrame);
      } else {
        reject(new Error('Tablet camera timed out taking photo'));
      }
    }, timeoutMs);
    pendingShots.set(id, { resolve, reject, timer });
    if (!wsSendJson(camSocket, { type: 'capture', id })) {
      clearTimeout(timer);
      pendingShots.delete(id);
      reject(new Error('Could not send capture command to tablet'));
    }
  });
}

function readRawBody(req, maxBytes = MAX_HTTP_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, type, body, extra) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...(extra || {})
  });
  res.end(body);
  return true;
}

function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

// ---------- HTTP handlers (called from photos.mjs handleShare) ----------
export async function handleBridgeHttp(req, res, url) {
  const p = url.pathname;

  // 1. Loopback-only endpoints used by the laptop's Electron renderer
  if (p.startsWith('/bridge-local/')) {
    if (!isLoopback(req)) return send(res, 403, 'text/plain', 'Loopback only');
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      return send(res, 204, 'text/plain', '', { ...cors, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
    }
    if (p === '/bridge-local/frame' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      const waitMs = Math.min(2000, Math.max(0, Number(url.searchParams.get('wait') || 0)));
      if (waitMs > 0 && camState.frameSeq <= after && camState.connected) {
        await new Promise((resolve) => {
          const t = setTimeout(() => { frameWaiters.delete(done); resolve(false); }, waitMs);
          const done = () => { clearTimeout(t); resolve(true); };
          frameWaiters.add(done);
        });
      }
      if (!camState.latestFrame || (after > 0 && camState.frameSeq <= after)) {
        return send(res, 204, 'text/plain', '', { ...cors, 'x-pb-seq': String(camState.frameSeq) });
      }
      return send(res, 200, 'image/jpeg', camState.latestFrame, {
        ...cors,
        'x-pb-seq': String(camState.frameSeq),
        'access-control-expose-headers': 'x-pb-seq'
      });
    }
    if (p === '/bridge-local/capture' && req.method === 'POST') {
      try {
        const jpeg = await requestTabletShot(15000);
        return send(res, 200, 'image/jpeg', jpeg, cors);
      } catch (e) {
        return send(res, 503, 'application/json', JSON.stringify({ ok: false, error: (e && e.message) || 'Capture failed' }), cors);
      }
    }
    const mm = /^\/bridge-local\/media\/([A-Za-z0-9_.:-]{1,80})$/.exec(p);
    if (mm && req.method === 'POST') {
      const slot = mm[1];
      const ct = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
      const buf = await readRawBody(req, 20 * 1024 * 1024);
      if (buf.length) {
        mediaSeq++;
        mediaStore.set(slot, { type: ct, buf, seq: mediaSeq });
        if (mediaStore.size > 60) {
          const oldest = mediaStore.keys().next().value;
          if (oldest && oldest !== slot) mediaStore.delete(oldest);
        }
      } else {
        mediaStore.delete(slot);
      }
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, seq: mediaSeq, slot }), cors);
    }
    return send(res, 404, 'text/plain', 'Not found', cors);
  }

  // 2. Public pairing check & token-protected tablet bridge routes
  const bm = /^\/bridge\/([A-Za-z0-9_-]{6,64})(?:\/(.*))?$/.exec(p);
  if (!bm) return false;
  if (bm[1] !== token) {
    return send(res, 403, 'text/html; charset=utf-8', '<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:40px;background:#0d0c0e;color:#fff"><h2>Bridge pairing expired</h2><p>Scan the new QR code in photobooth4u Setup → Guest screen.</p></body></html>');
  }
  const rest = '/' + String(bm[2] || '').replace(/\/+$/, '');
  const cors = { 'access-control-allow-origin': '*' };

  if (rest === '/hello' && req.method === 'GET') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      app: 'photobooth4u-bridge',
      port: Number(cfg.getPort()) || 0,
      camConnected: camState.connected,
      guestConnected: guestSockets.size > 0
    }), cors);
  }
  if ((rest === '' || rest === '/' || rest === '/guest') && req.method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', guestBridgeHtml(bm[1]));
  }
  if (rest === '/cam/frame' && req.method === 'POST') {
    const buf = await readRawBody(req, 6 * 1024 * 1024);
    if (buf.length) pushFrame(buf);
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, seq: camState.frameSeq }), cors);
  }
  if (rest === '/cam/shot' && req.method === 'POST') {
    const id = String(url.searchParams.get('id') || '');
    const buf = await readRawBody(req, MAX_HTTP_BODY);
    const pending = pendingShots.get(id);
    if (pending) {
      pendingShots.delete(id);
      clearTimeout(pending.timer);
      if (buf.length) pending.resolve(buf);
      else pending.reject(new Error('Empty capture from tablet'));
    }
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, bytes: buf.length }), cors);
  }
  const gm = /^\/media\/([A-Za-z0-9_.:-]{1,80})$/.exec(rest);
  if (gm && req.method === 'GET') {
    const item = mediaStore.get(gm[1]);
    if (!item) return send(res, 404, 'text/plain', 'Not found');
    return send(res, 200, item.type, item.buf, { 'cache-control': 'no-store' });
  }
  return send(res, 404, 'text/plain', 'Not found');
}

export function guestBridgeHtml(tok) {
  const safeTok = JSON.stringify(String(tok || ''));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Guest screen</title>
<style>
:root{--bg:#F5F1EA;--ink:#1C1A1E;--dim:#6B666C;--red:#C93D27;--ui-cd-scale:1;--ui-btn-scale:1;--ui-film-scale:1;--ui-cd-opacity:1;--ui-btn-opacity:1;--ui-film-opacity:1;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;height:100%;background:transparent;color:var(--ink);font-family:Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;overflow:hidden;user-select:none;}
.g{position:fixed;inset:0;display:grid;grid-template-columns:1fr auto 1fr;gap:2.4vw;padding:3vh 2.4vw;align-items:center;background:var(--bg);}
.side{height:100%;display:flex;flex-direction:column;justify-content:space-between;align-items:center;text-align:center;gap:2vh;min-width:0;}
.logo{display:flex;align-items:center;gap:.7vw;}
.mark{display:grid;grid-template-columns:1fr 1fr;gap:.25vw;width:2.2vw;height:2.2vw;min-width:22px;min-height:22px;}.mark i{background:var(--ink);border-radius:3px;}.mark i:nth-child(2){background:var(--red);}
.word{display:flex;align-items:flex-start;}.word b{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(20px,2.4vw,44px);letter-spacing:-.035em;line-height:1;}
.word em{font-style:normal;margin-left:.3vw;padding:.15em .4em .25em;border-radius:.4em;background:var(--red);color:#fff;font-weight:800;font-size:clamp(10px,1vw,19px);line-height:1;transform:rotate(-7deg);}
.ev{font-family:Fraunces,Georgia,serif;font-style:italic;font-size:clamp(18px,2vw,38px);margin:0;}.dt{font-weight:700;letter-spacing:.2em;font-size:clamp(10px,.9vw,16px);color:var(--dim);margin:.6vh 0 0;}
.msg{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(22px,2.6vw,52px);line-height:1.1;margin:0;letter-spacing:-.02em;}
.sub{font-weight:700;letter-spacing:.24em;text-transform:uppercase;font-size:clamp(10px,.85vw,15px);color:var(--red);margin:1.4vh 0 0;}
.frame{position:relative;height:94vh;aspect-ratio:4/5;border-radius:18px;overflow:hidden;background:transparent;box-shadow:0 20px 50px rgba(60,40,20,.22);}
.frame img.vremote,.frame img.res{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}.frame img.vremote{display:none;}.frame img.res{object-fit:contain;background:var(--bg);display:none;}
.cd{position:absolute;top:2.5%;right:2%;display:none;align-items:center;justify-content:center;z-index:4;opacity:var(--ui-cd-opacity,1);}
.cdw{position:relative;width:calc(min(18vh,11vw) * var(--ui-cd-scale,1));aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;}
.cdw svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg);}
.cdw .trk{fill:rgba(20,18,22,.5);stroke:rgba(255,255,255,.25);stroke-width:4;}.cdw .bar{fill:none;stroke:var(--red);stroke-width:4;stroke-linecap:round;}
.num{position:relative;color:#fff;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:calc(min(8vh,5vw) * var(--ui-cd-scale,1));line-height:1;text-shadow:0 0 20px rgba(0,0,0,.4);}
.num.word{font-size:calc(min(3vh,1.8vw) * var(--ui-cd-scale,1));letter-spacing:.04em;text-transform:uppercase;}
.cd.pausing .cdw{display:none;}
.flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:90;transition:opacity 120ms ease-out;}.flash.on{opacity:.92;transition:opacity 20ms;}
.film{display:flex;flex-direction:column;gap:1.2vh;align-items:center;opacity:var(--ui-film-opacity,1);}
.film div{position:relative;height:min(calc(min(15vh, calc(62vh / var(--n,3) - 1.2vh)) * var(--ui-film-scale,1)), calc(66vh / var(--n,3) - 1.2vh));aspect-ratio:var(--box-aspect,0.8);border-radius:8px;border:2px dashed #D6CEC1;background-size:cover;background-position:center;}
.film div.pick{cursor:pointer;}
.film div.pick::after{content:"↺ Tap to retake";position:absolute;left:0;right:0;bottom:0;padding:.5vh .3vw;border-radius:0 0 6px 6px;background:rgba(20,16,22,.62);color:#fff;font:800 clamp(10px,.85vw,15px) Manrope,sans-serif;text-align:center;}
.film div.sel{outline:5px solid var(--red);outline-offset:3px;}.film div.sel::after{content:"✓ Will retake";background:var(--red);}
.film div.f{border:2px solid var(--red);}
.gb{display:flex;flex-direction:column;gap:calc(1.4vh * min(var(--ui-btn-scale,1),1.35));width:min(100%,calc(22vw * max(1,min(var(--ui-btn-scale,1),1.35))));min-width:180px;opacity:var(--ui-btn-opacity,1);}
.gbtn{min-height:calc(max(54px,7vh) * min(var(--ui-btn-scale,1),1.35));padding:calc(1vh * min(var(--ui-btn-scale,1),1.35)) calc(1.2vw * min(var(--ui-btn-scale,1),1.35));border-radius:99px;border:2px solid var(--ink);background:#fff;color:var(--ink);font:800 calc(clamp(14px,1.25vw,24px) * min(var(--ui-btn-scale,1),1.35)) Manrope,sans-serif;cursor:pointer;touch-action:manipulation;}
.gbtn.strong{background:var(--red);border-color:transparent;color:#fff;}
.gbtn:disabled{opacity:.55;cursor:default;}
.gbtn small{display:block;font-size:.72em;font-weight:700;opacity:.88;margin-top:2px;}
.chip{padding:.8vh 1.2vw;border-radius:99px;background:var(--ink);color:#fff;font-weight:800;font-size:clamp(10px,.85vw,15px);letter-spacing:.18em;text-transform:uppercase;}
.qrs{display:flex;flex-direction:column;gap:2vh;align-items:center;}
.qrb{display:flex;flex-direction:column;align-items:center;gap:.8vh;}
.qr{width:min(22vh,14vw);min-width:120px;aspect-ratio:1/1;background:#fff;border-radius:14px;padding:10px;box-shadow:0 10px 30px rgba(60,40,20,.12);display:flex;align-items:center;justify-content:center;}
.qr img{width:100%;height:100%;display:block;}
.qr span{font-weight:700;color:var(--dim);font-size:clamp(11px,.85vw,15px);text-align:center;padding:8px;}
.qrl{font-weight:800;letter-spacing:.18em;text-transform:uppercase;font-size:clamp(10px,.9vw,16px);color:var(--red);}
.res-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;width:100%;margin-top:8px;}
.res-actions .gbtn{min-width:140px;padding:12px 22px;font-size:clamp(14px,1.15vw,20px);}
.gallery-pill{position:fixed;right:2vw;bottom:2vh;z-index:20;padding:12px 18px;border:0;border-radius:99px;background:var(--red);color:#fff;font:800 clamp(12px,1vw,17px) Manrope,sans-serif;box-shadow:0 8px 24px rgba(28,26,30,.22);cursor:pointer;}
.gallery-card{position:fixed;right:2vw;bottom:calc(2vh + 58px);z-index:22;width:min(300px,90vw);padding:18px;border-radius:18px;background:#fff;color:var(--ink);box-shadow:0 18px 44px rgba(28,26,30,.28);text-align:center;}
.gallery-card h2{margin:0;font:600 22px Fraunces,Georgia,serif;}.gallery-card img{width:min(210px,60vw);aspect-ratio:1;object-fit:contain;margin:8px auto;display:block;}
.gallery-card button{margin-top:10px;min-height:42px;padding:0 20px;border:1px solid #D6CEC1;border-radius:99px;background:#fff;font:800 13px Manrope,sans-serif;cursor:pointer;}
.lk{position:absolute;left:0;right:0;bottom:2.6%;z-index:12;display:flex;flex-direction:column;align-items:center;gap:1vh;pointer-events:none;}.lk>*{pointer-events:auto;}
.lkpill{min-height:max(48px,6vh);padding:0 2vw;border:0;border-radius:99px;background:rgba(20,18,22,.74);color:#fff;font:800 clamp(14px,1.15vw,22px) Manrope,sans-serif;cursor:pointer;}
.lkrow{display:flex;gap:1.2vw;max-width:94%;overflow-x:auto;padding:1vh 1.4vw;border-radius:24px;background:rgba(20,18,22,.78);}
.lkb{flex:none;display:flex;flex-direction:column;align-items:center;gap:.6vh;border:0;background:none;color:#fff;font:700 clamp(11px,.95vw,17px) Manrope,sans-serif;cursor:pointer;padding:8px 14px;border-radius:14px;}
.lkb.on{background:var(--red);}
.gready{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.2vh;padding:4vh 4vw;background:radial-gradient(circle at center,rgba(0,0,0,.15),rgba(0,0,0,.48));text-align:center;color:#fff;}
.gready-title{margin:0;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(34px,5vw,76px);line-height:1.05;text-shadow:0 4px 24px rgba(0,0,0,.5);}
.gready-sub{margin:0;font:700 clamp(13px,1.3vw,22px) Manrope,sans-serif;color:rgba(255,255,255,.88);}
.gready-btn{min-height:calc(max(58px,7.5vh) * min(var(--ui-btn-scale,1),1.45));padding:0 calc(clamp(28px,4vw,56px) * min(var(--ui-btn-scale,1),1.45));border:0;border-radius:999px;background:var(--red);color:#fff;font:800 calc(clamp(18px,1.8vw,30px) * min(var(--ui-btn-scale,1),1.45)) Manrope,sans-serif;cursor:pointer;box-shadow:0 14px 34px rgba(201,61,39,.45);opacity:var(--ui-btn-opacity,1);}
.pk{position:fixed;inset:0;z-index:30;background:rgba(13,12,14,.94);display:flex;flex-direction:column;align-items:center;gap:clamp(14px,3vh,34px);padding:4vh 4vw;overflow:hidden;}
.pkt{flex:none;margin:0;color:#fff;font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(26px,3.6vw,64px);}
.pksb{flex:none;margin:-1.8vh 0 0;font:600 clamp(13px,1.2vw,20px) Manrope,sans-serif;color:rgba(255,255,255,.7);}
.pkg{flex:1 1 auto;width:100%;min-height:0;overflow-y:auto;display:flex;gap:2.4vw;justify-content:center;align-items:flex-start;align-content:flex-start;flex-wrap:wrap;padding:0 1vw 3vh;}
.pkb{display:flex;flex-direction:column;align-items:center;gap:1.2vh;padding:1.2vh;border-radius:18px;border:4px solid transparent;background:rgba(255,255,255,.08);color:#fff;font:700 clamp(14px,1.3vw,24px) Manrope,sans-serif;cursor:pointer;}
.pkb img{height:44vh;max-width:28vw;object-fit:contain;border-radius:10px;background:#fff;}
.pkg.tier .pkb img{height:46vh;max-width:36vw;}
.pkg.tier-bw .pkb img{filter:grayscale(1) contrast(1.06);}
.pkb .pks{font-size:clamp(10px,.8vw,14px);font-weight:700;color:rgba(255,255,255,.8);background:rgba(255,255,255,.14);padding:2px 10px;border-radius:99px;}
.pkb .pktag{font-size:clamp(10px,.85vw,15px);font-weight:800;padding:3px 10px;border-radius:99px;}
.pkb .pktag.thermal{background:#fef3c7;color:#92400e;}
.pkb .pktag.color{background:#e0f2fe;color:#0369a1;}
.pkb.sel{border-color:var(--red);background:rgba(255,255,255,.16);}
.pk-back{flex:none;min-height:46px;padding:0 28px;border:1.5px solid rgba(255,255,255,.45);border-radius:999px;background:rgba(255,255,255,.18);color:#fff;font:700 clamp(14px,1.1vw,18px) Manrope,sans-serif;cursor:pointer;}
.logo .lg{display:block;object-fit:contain;}.logo.off{visibility:hidden;}
.clogo{position:fixed;z-index:8;object-fit:contain;pointer-events:none;transform:translate(-50%,-50%);}
.pwr{display:flex;align-items:center;justify-content:center;gap:.4em;margin-top:1.4vh;color:var(--dim);font-weight:700;font-size:clamp(9px,.72vw,14px);letter-spacing:.06em;}
.pwr .mk{display:grid;grid-template-columns:1fr 1fr;gap:1px;width:1.1em;height:1.1em;}.pwr .mk i{background:var(--ink);border-radius:2px;}.pwr .mk i:nth-child(2){background:var(--red);}
.pwr b{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.4em;letter-spacing:-.03em;color:var(--ink);}.pwr b em{font-style:normal;color:var(--red);}
/* Photo Session clean full-screen mode */
body.ps{background:transparent;color:#F5F1EA;}
body.ps .g{background:transparent;display:block;padding:0;}
body.ps.opaque-bg .g{background:#0d0c0e;}
body.ps .side-l,body.ps .side-r .chip,body.ps .clogo,body.ps .gallery-pill{display:none !important;}
body.ps .side-r{display:contents !important;}
body.ps .frame{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(100vw,calc(100vh * var(--ga,1.3333))) !important;height:min(100vh,calc(100vw / var(--ga,1.3333))) !important;aspect-ratio:var(--ga,1.3333) !important;border-radius:0;box-shadow:none;background:transparent;}
body.ps.wel-full .frame{left:0;top:0;transform:none;width:100vw !important;height:100vh !important;aspect-ratio:auto !important;}
body.ps .frame img.res{background:#000;}
body.ps .cd{position:fixed;top:max(20px,2.4vh);left:50%;right:auto;transform:translateX(-50%);z-index:46;padding:calc(10px * var(--ui-cd-scale,1)) calc(18px * var(--ui-cd-scale,1));border-radius:999px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.2);}
body.ps .cdw{width:calc(clamp(56px,8vmin,84px) * var(--ui-cd-scale,1));}
body.ps .num{font-size:calc(clamp(30px,4.6vmin,48px) * var(--ui-cd-scale,1));text-shadow:none;}
body.ps .num.word{font-size:calc(clamp(13px,1.8vmin,18px) * var(--ui-cd-scale,1));}
body.ps .film{position:fixed;top:max(16px,2vh);right:max(16px,1.6vw);z-index:50;display:flex !important;flex-direction:column;gap:8px;padding:8px;border-radius:16px;background:rgba(0,0,0,.55);max-height:calc(100vh - 120px);overflow:auto;}
body.ps .film.no-shots{display:none !important;}
body.ps .film div{height:auto !important;width:min(calc(clamp(64px,9vmin,120px) * var(--ui-film-scale,1)), calc(((100vh - 140px) / var(--n,4) - 10px) * var(--box-aspect,.8)));aspect-ratio:var(--box-aspect,.8);border:2px solid rgba(255,255,255,.85);}
body.ps .film div:not(.f){display:none !important;}
body.ps .gb{position:fixed;left:50%;bottom:max(18px,2.4vh);transform:translateX(-50%);z-index:45;display:flex;flex-direction:row;justify-content:center;gap:calc(12px * min(var(--ui-btn-scale,1),1.35));width:max-content;max-width:calc(100vw - 32px);flex-wrap:wrap;}
body.ps .gbtn{background:rgba(0,0,0,.62);border:1.5px solid rgba(255,255,255,.32);color:#fff;padding:calc(12px * min(var(--ui-btn-scale,1),1.35)) calc(26px * min(var(--ui-btn-scale,1),1.35));min-height:calc(52px * min(var(--ui-btn-scale,1),1.35));font-size:calc(clamp(15px,1.3vw,24px) * min(var(--ui-btn-scale,1),1.35));white-space:nowrap;}
body.ps .gbtn.strong{background:rgba(201,61,39,.95);border-color:transparent;}
.gbtn.printing,.res-actions .gbtn.printing,body.ps .gbtn.printing{font-size:calc(clamp(11px,.95vw,17px) * min(var(--ui-btn-scale,1),1.35));padding-left:calc(14px * min(var(--ui-btn-scale,1),1.35));padding-right:calc(14px * min(var(--ui-btn-scale,1),1.35));white-space:normal;line-height:1.15;}
body.ps.is-result .g{display:flex;align-items:center;justify-content:center;gap:3.5vw;padding:3vh 3.5vw;background:#0d0c0e;}
body.ps.is-result .frame{position:relative;left:auto;top:auto;transform:none;width:auto !important;height:86vh !important;max-width:60vw;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.55);}
body.ps.is-result .side-r-res{display:flex;flex-direction:column;align-items:center;gap:16px;z-index:10;max-width:34vw;}
body.ps.is-result .qrs{position:relative;z-index:10;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:20px 24px;}
body.ps.is-result .qrl{color:#fff;}
body.ps.is-result:not(.has-qr):not(.has-res-actions) .frame{max-width:92vw;height:90vh !important;}.qrtitle{display:none;margin:0 0 6px;font:600 clamp(22px,3.4vw,30px) Fraunces,Georgia,serif;text-align:center;color:var(--ink);}body.qrpop-wait .qrs,body.qrpop-wait .res-actions{display:none !important;}body.qrpop-show .g::after{content:"";position:fixed;inset:0;background:rgba(14,11,16,.62);z-index:55;pointer-events:none;}body.qrpop-show.is-result .side-r-res{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;max-width:none;width:min(640px,94vw);max-height:calc(100vh - 24px);overflow:auto;background:#fff;color:var(--ink);border-radius:26px;padding:26px 26px 20px;box-shadow:0 30px 90px rgba(0,0,0,.5);gap:12px;}body.qrpop-show .qrtitle{display:block;}body.qrpop-show.is-result .qrs{background:none;border:0;padding:0;backdrop-filter:none;flex-direction:row;flex-wrap:wrap;justify-content:center;gap:18px;}body.qrpop-show .qr{width:min(340px,74vw,46vh);min-width:0;box-shadow:none;border:1px solid #E6DED2;}body.qrpop-show .qrs.two .qr{width:min(260px,42vw,36vh);}body.qrpop-show.is-result .qrl{color:var(--red);}body.qrpop-show .gbtn{background:#fff;color:var(--ink);border:2px solid var(--ink);backdrop-filter:none;}body.qrpop-show .gbtn.strong{background:var(--red);border-color:var(--red);color:#fff;}
body.ps.is-result.res-themed .g{background-color:#1C1A1E;background-image:var(--res-bg-img,none);background-size:cover;background-position:center;background-repeat:no-repeat;}
body.ps.is-result.res-themed .frame{background:transparent;box-shadow:none;overflow:visible;}
body.ps.is-result.res-themed .frame img.res{background:transparent;border-radius:12px;filter:drop-shadow(0 20px 48px rgba(28,26,30,.40));}
body.ps.is-result.res-themed .side-r-res{position:relative;background:var(--res-card-bg,#fff);color:var(--res-card-ink,#111827);border:1.5px solid var(--res-card-border,rgba(28,26,30,.08));border-radius:var(--res-card-radius,28px);padding:24px 26px;box-shadow:0 24px 64px rgba(28,26,30,.24);}
body.ps.is-result.res-themed.qrpop-wait .side-r-res,body.ps.is-result.res-themed:not(.has-qr):not(.has-res-actions) .side-r-res{display:none !important;}
body.ps.is-result.res-themed.qrpop-show .g::after{background:rgba(28,26,30,.34);}
body.ps.is-result.res-themed.qrpop-show .side-r-res{position:fixed;background:var(--res-card-bg,#fff);color:var(--res-card-ink,#111827);border:1.5px solid var(--res-card-border,rgba(28,26,30,.08));border-radius:var(--res-card-radius,28px);padding:28px 26px 22px;box-shadow:0 30px 90px rgba(28,26,30,.36);}
body.ps.is-result.res-themed[data-res-deco="pop-retro"] .side-r-res{border:2.5px solid #18181B;box-shadow:10px 10px 0 var(--res-deco-secondary,#F28DA0),10px 10px 0 2.5px #18181B;}
body.ps.is-result.res-themed[data-res-deco="coquette-stitch"] .side-r-res::after{content:"";position:absolute;inset:10px;border:2px dashed var(--res-deco-secondary,#F28DA0);border-radius:calc(var(--res-card-radius,28px) - 8px);pointer-events:none;}
body.ps.is-result.res-themed .qrtitle{font-family:var(--res-title-font,Fraunces,Georgia,serif);color:var(--res-card-ink,#111827);}
body.ps.is-result.res-themed .qrs{background:transparent;border:0;padding:0;}
body.ps.is-result.res-themed .qrl{color:var(--res-card-ink,#111827);}
body.ps.is-result.res-themed .gbtn{background:rgba(128,128,128,.08);color:var(--res-card-ink,#111827);border:1.5px solid var(--res-card-border,rgba(28,26,30,.18));}
body.ps.is-result.res-themed .gbtn.strong{background:var(--res-btn-bg,#C93D27);border-color:transparent;color:var(--res-btn-ink,#fff);}
body.edit-preview .frame img.res,body.edit-preview .gready,body.edit-preview .pk{display:none !important;}body.edit-preview .cd{display:flex !important;}body.edit-preview .gb{display:flex !important;}body.edit-preview .gb .gbtn{display:inline-flex !important;align-items:center;justify-content:center;}body.edit-preview .film{display:flex !important;}body.edit-preview .film div.f{display:block !important;}body.wel .g{display:block;padding:0;}body.wel .side,body.wel .clogo{display:none !important;}
body.wel .frame{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);height:min(100vh,calc(100vw / var(--wa,1.3333))) !important;aspect-ratio:var(--wa,1.3333) !important;border-radius:0;box-shadow:none;}
.copies-modal{position:fixed;inset:0;z-index:80;background:rgba(10,10,12,.76);display:flex;align-items:center;justify-content:center;padding:20px;}
.copies-card{background:#fff;color:var(--ink);border-radius:22px;padding:26px 28px;width:min(380px,92vw);text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.45);}
.copies-card h3{margin:0 0 14px;font:600 26px Fraunces,Georgia,serif;}
.stepper{display:inline-flex;align-items:center;gap:18px;background:#F5F1EA;border-radius:999px;padding:8px 14px;}
.stepper button{width:48px;height:48px;border-radius:50%;border:0;background:#1C1A1E;color:#fff;font:800 22px Manrope,sans-serif;cursor:pointer;}
.stepper button:disabled{opacity:.3;}
.stepper b{font:800 28px Manrope,sans-serif;min-width:44px;text-align:center;}
.copies-left{margin:12px 0 0;color:var(--dim);font-size:13px;font-weight:700;}
.copies-btns{display:flex;gap:10px;margin-top:20px;}
.copies-btns button{flex:1;min-height:50px;border-radius:99px;font:800 15px Manrope,sans-serif;cursor:pointer;border:1.5px solid #D6CEC1;background:#fff;color:var(--ink);}
.copies-btns button.go{background:var(--red);border-color:var(--red);color:#fff;}
.toast{position:fixed;top:max(18px,2.4vh);left:50%;transform:translateX(-50%);z-index:95;background:rgba(20,18,22,.88);color:#fff;padding:12px 22px;border-radius:999px;font:700 14px Manrope,sans-serif;border:1px solid rgba(255,255,255,.18);pointer-events:none;transition:opacity .2s;}
.conn-dot{position:fixed;left:12px;top:12px;z-index:95;padding:5px 10px;border-radius:99px;background:rgba(201,61,39,.9);color:#fff;font:800 11px Manrope,sans-serif;}
.hide{display:none !important;}
</style>
</head>
<body class="ps">
<div class="conn-dot" id="connDot">Connecting to laptop…</div>
<div class="toast hide" id="toast"></div>
<div class="pk hide" id="pk"><p class="pkt" id="pkt">Choose your layout</p><p class="pksb" id="pksb">Tap a design to start your session</p><div class="pkg" id="pkg"></div><button type="button" class="pk-back hide" id="pkBack">&larr; Back</button></div>
<div class="g">
  <div class="side side-l">
    <div class="logo off" id="glogo"><img class="lg hide" id="lgImg" alt=""></div>
    <div><p class="msg" id="msg">Tap to start</p><p class="sub" id="sub"></p></div>
    <div><p class="ev" id="ev"></p><p class="dt" id="dt"></p><div class="pwr hide" id="pwr"></div></div>
  </div>
  <div class="frame" id="frame">
    <img id="vRemote" class="vremote" alt="">
    <img id="res" class="res" alt="Your photo">
    <div class="gready hide" id="gReady"><p class="gready-title">Get ready!</p><p class="gready-sub" id="gReadySub"></p><button type="button" class="gready-btn" id="gReadyBtn">Start</button></div>
    <div class="cd" id="cd"><div class="cdw"><svg viewBox="0 0 100 100"><circle class="trk" cx="50" cy="50" r="46"/><circle class="bar" id="bar" cx="50" cy="50" r="46" pathLength="100" stroke-dasharray="100" stroke-dashoffset="0"/></svg><div class="num" id="num">5</div></div></div>
    <div class="lk hide" id="lk"><button class="lkpill" id="lkPill" type="button"></button><div class="lkrow hide" id="lkRow"></div></div>
  </div>
  <div class="side side-r">
    <span class="chip" id="chip">Ready</span>
    <div class="film" id="film"></div>
    <div class="gb hide" id="gb"><button class="gbtn strong hide" id="gRetake" type="button"></button><button class="gbtn hide" id="gDone" type="button"></button></div>
    <div class="side-r-res">
      <p class="qrtitle" id="qrTitle"></p>
      <div class="qrs hide" id="qrw"></div>
      <div class="res-actions hide" id="resActions">
        <button class="gbtn strong hide" id="gPrintBtn" type="button"></button>
        <button class="gbtn hide" id="gNextBtn" type="button">Done</button>
      </div>
    </div>
  </div>
</div>
<div class="flash" id="flash"></div>
<button class="gallery-pill hide" id="galleryPill" type="button">▦ Event gallery</button>
<section class="gallery-card hide" id="guestGallery"><h2>All event photos</h2><img id="guestGalleryQr" alt="Gallery QR"><button id="guestGalleryClose" type="button">Close</button></section>
<div class="copies-modal hide" id="copiesModal"><div class="copies-card"><h3 id="copiesTitle">How many copies?</h3><div class="stepper"><button type="button" id="copiesMinus">&minus;</button><b id="copiesVal">1</b><button type="button" id="copiesPlus">+</button></div><p class="copies-left" id="copiesLeft"></p><div class="copies-btns"><button type="button" id="copiesCancel">Cancel</button><button type="button" class="go" id="copiesGo">Print</button></div></div></div>
<img class="clogo hide" id="clogo" alt="">
<script>
(function(){
  var TOK = ${safeTok};
  var base = '/bridge/' + TOK;
  var $ = function(id){ return document.getElementById(id); };
  var els = {
    conn: $('connDot'), toast: $('toast'), pk: $('pk'), pkt: $('pkt'), pksb: $('pksb'), pkg: $('pkg'), pkBack: $('pkBack'),
    glogo: $('glogo'), lgImg: $('lgImg'), clogo: $('clogo'), pwr: $('pwr'),
    msg: $('msg'), sub: $('sub'), ev: $('ev'), dt: $('dt'), chip: $('chip'),
    frame: $('frame'), vRemote: $('vRemote'), res: $('res'),
    gReady: $('gReady'), gReadySub: $('gReadySub'), gReadyBtn: $('gReadyBtn'),
    cd: $('cd'), bar: $('bar'), num: $('num'), flash: $('flash'),
    lk: $('lk'), lkPill: $('lkPill'), lkRow: $('lkRow'),
    film: $('film'), gb: $('gb'), gRetake: $('gRetake'), gDone: $('gDone'),
    qrw: $('qrw'), qrTitle: $('qrTitle'), resActions: $('resActions'), gPrintBtn: $('gPrintBtn'), gNextBtn: $('gNextBtn'),
    galleryPill: $('galleryPill'), galleryCard: $('guestGallery'), galleryQr: $('guestGalleryQr'),
    copiesModal: $('copiesModal'), copiesTitle: $('copiesTitle'), copiesMinus: $('copiesMinus'),
    copiesVal: $('copiesVal'), copiesPlus: $('copiesPlus'), copiesLeft: $('copiesLeft'),
    copiesCancel: $('copiesCancel'), copiesGo: $('copiesGo')
  };
  var ws = null, curState = null, toastTimer = null, remotePollOn = false;
  var copyCount = 1, copyMax = 1, lastRectSig = '';

  function sendAction(action, extra){
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(Object.assign({ type: 'action', action: action }, extra || {}))); } catch(e){}
  }
  function showToast(msg){
    if (!msg) return;
    els.toast.textContent = msg;
    els.toast.classList.remove('hide');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ els.toast.classList.add('hide'); }, 3500);
  }
  function syncNativePreview(){
    var b = window.__PBTabletBridge;
    if (!b || typeof b.setPreviewRect !== 'function') return;
    var st = curState || {};
    var showCam = !st.hideCam && !st.useRemoteStream;
    var r = els.frame.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var left = Math.round(r.left * dpr), top = Math.round(r.top * dpr), w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    var bg = st.psMode ? '#0d0c0e' : '#F5F1EA';
    var sig = [left, top, w, h, showCam ? 1 : 0, st.mirror ? 1 : 0, bg].join('|');
    if (sig !== lastRectSig) {
      lastRectSig = sig;
      try { b.setPreviewRect(left, top, w, h, !!showCam, !!st.mirror, bg); } catch(e){}
    }
  }
  function startRemoteLoop(){
    if (remotePollOn) return;
    remotePollOn = true;
    var img = els.vRemote;
    function step(){
      if (!curState || !curState.useRemoteStream) { remotePollOn = false; img.style.display = 'none'; return; }
      var next = new Image();
      next.onload = function(){
        if (curState && curState.useRemoteStream) {
          img.src = next.src;
          img.style.display = 'block';
          setTimeout(step, 35);
        } else { remotePollOn = false; }
      };
      next.onerror = function(){ if (curState && curState.useRemoteStream) setTimeout(step, 200); else remotePollOn = false; };
      next.src = base + '/media/remoteFrame?t=' + Date.now();
    }
    step();
  }
  // Each part of the screen is drawn on its own: an error in one (a bad picture, a missing field) must not stop the QR code,
  // the buttons or the photo from showing.
  function safe(name, fn){ try { fn(); } catch (e) { try { console.log('guest screen: ' + name + ' failed: ' + (e && e.message)); } catch (e2) { } } }
  function applyUi(ui){
    if (!ui) return;
    var rs = document.documentElement.style;
    var map = { cd: '--ui-cd-scale', btn: '--ui-btn-scale', film: '--ui-film-scale', cdOp: '--ui-cd-opacity', btnOp: '--ui-btn-opacity', filmOp: '--ui-film-opacity' };
    Object.keys(map).forEach(function(k){ var v = parseFloat(ui[k]); if (v > 0) rs.setProperty(map[k], String(v)); });
  }
  function applyState(st){
    st = st || {};
    curState = st;
    var ps = st.psMode !== false;
    safe('settings', function(){
      applyUi(st.ui);
      document.body.classList.toggle('ps', ps);
      document.body.classList.toggle('opaque-bg', !!(st.hideCam || st.useRemoteStream));
      document.body.classList.toggle('wel', !!st.welFull);
      document.body.classList.toggle('wel-full', !!st.welFullPs);
      document.body.classList.toggle('is-result', !!(ps && st.isResult));
      document.body.classList.toggle('has-qr', !!(ps && st.showQr));
      document.body.classList.toggle('has-res-actions', !!(ps && st.isResult && (st.printShow || st.nextShow)));
      document.body.classList.toggle('edit-preview', !!st.editPreview);
      document.body.classList.toggle('qrpop-wait', st.qrPop === 'wait');
      document.body.classList.toggle('qrpop-show', st.qrPop === 'show');
      var rt = st.resTheme;
      var rtOn = !!(ps && st.isResult && rt && rt.on);
      document.body.classList.toggle('res-themed', rtOn);
      if (rtOn) {
        var rbs = document.body.style;
        var bgTarget = rt.bg ? (rt.bg.indexOf('/media/') === 0 ? (base + rt.bg) : rt.bg) : '';
        if (bgTarget) rbs.setProperty('--res-bg-img', 'url("' + bgTarget + '")');
        else rbs.removeProperty('--res-bg-img');
        if (rt.cardBg) rbs.setProperty('--res-card-bg', rt.cardBg);
        if (rt.ink) rbs.setProperty('--res-card-ink', rt.ink);
        if (rt.border) rbs.setProperty('--res-card-border', rt.border);
        if (rt.radius) rbs.setProperty('--res-card-radius', rt.radius + 'px');
        if (rt.btnBg) rbs.setProperty('--res-btn-bg', rt.btnBg);
        if (rt.btnInk) rbs.setProperty('--res-btn-ink', rt.btnInk);
        if (rt.decoSecondary) rbs.setProperty('--res-deco-secondary', rt.decoSecondary);
        if (rt.titleFont) rbs.setProperty('--res-title-font', rt.titleFont);
        document.body.setAttribute('data-res-deco', rt.decoStyle || 'none');
      } else {
        document.body.removeAttribute('data-res-deco');
      }
      if (st.ga) document.body.style.setProperty('--ga', String(st.ga));
      if (st.wa) document.body.style.setProperty('--wa', String(st.wa));
      if (st.boxAspect) els.film.style.setProperty('--box-aspect', String(st.boxAspect));
      els.ev.textContent = st.ev || '';
      els.dt.textContent = st.dt || '';
      els.msg.textContent = st.msg || 'Tap to start';
      els.sub.textContent = st.sub || '';
      els.chip.textContent = st.chip || 'Ready';
    });

    safe('photo', function(){
      if (st.resSrc) {
        var target = st.resSrc.indexOf('/media/') === 0 ? (base + st.resSrc) : st.resSrc;
        if (els.res.getAttribute('data-src') !== target) { els.res.setAttribute('data-src', target); els.res.src = target; }
        els.res.style.display = 'block';
        els.res.style.objectFit = st.resFit || 'contain';
      } else {
        els.res.style.display = 'none';
        els.res.removeAttribute('data-src');
      }
    });

    safe('live picture', function(){
      if (st.useRemoteStream) {
        els.vRemote.style.transform = st.remoteMirror ? 'scaleX(-1)' : 'scaleX(1)';
        els.vRemote.style.filter = st.filterCss || '';
        startRemoteLoop();
      } else {
        els.vRemote.style.display = 'none';
      }
    });

    safe('countdown', function(){
      if (st.editPreview) {
        // The live resize preview (Setup: Resize on the guest screen): a sample countdown, sample photos and the buttons.
        els.cd.style.display = 'flex'; els.cd.classList.remove('pausing');
        els.num.textContent = '3'; els.num.classList.remove('word'); els.bar.style.strokeDashoffset = '0';
      } else if (!st.countingDown) {
        els.cd.style.display = 'none';
      }
    });

    safe('get ready', function(){
      els.gReady.classList.toggle('hide', !st.showReady);
      if (st.showReady) {
        els.gReadySub.textContent = st.readySub || '';
        els.gReadyBtn.textContent = st.readyBtn || 'Start';
      }
    });

    safe('layout picker', function(){
      els.pk.classList.toggle('hide', !st.pickOpen);
      if (st.pickOpen) {
        els.pkt.textContent = st.pickTitle || 'Choose your layout';
        els.pksb.textContent = st.pickSub || 'Tap a design to start your session';
        if (els.pkBack) els.pkBack.classList.toggle('hide', !st.pickCanBack);
        els.pkg.classList.toggle('tier', !!st.pickTier);
        els.pkg.classList.toggle('tier-bw', !!st.pickBwStep);
        var sig = (st.pickTier ? 'T:' : '') + (st.pickBwStep ? 'B:' : '') + (st.layouts || []).map(function(x){ return x.k + ':' + x.thumb + ':' + (x.tag || ''); }).join('|');
        if (els.pkg.getAttribute('data-sig') !== sig) {
          els.pkg.setAttribute('data-sig', sig);
          els.pkg.innerHTML = '';
          (st.layouts || []).forEach(function(item){
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'pkb'; b.setAttribute('data-k', item.k);
            var im = document.createElement('img');
            im.src = item.thumb && item.thumb.indexOf('/media/') === 0 ? (base + item.thumb) : (item.thumb || '');
            var sp = document.createElement('span'); sp.textContent = item.name || '';
            var sh = document.createElement('span'); sh.className = 'pks'; sh.textContent = item.shots || '';
            b.append(im, sp, sh);
            if (item.tag) {
              var tg = document.createElement('span');
              tg.className = 'pktag' + (item.tagCls ? ' ' + item.tagCls : '');
              tg.textContent = item.tag;
              b.append(tg);
            }
            b.onclick = function(e){ e.stopPropagation(); sendAction('pickLayout', { key: item.k }); };
            els.pkg.appendChild(b);
          });
        }
        [].forEach.call(els.pkg.children, function(b, idx){ b.classList.toggle('sel', idx === st.pickIdx); });
      }
    });

    safe('looks', function(){
      els.lk.classList.toggle('hide', !st.looksShow);
      if (st.looksShow) {
        els.lkPill.textContent = '✨ Look: ' + (st.lookLabel || st.lookKey || 'Normal');
        els.lkRow.classList.toggle('hide', !st.looksOpen);
        var lsig = (st.looks || []).map(function(l){ return l.k; }).join(',');
        if (els.lkRow.getAttribute('data-sig') !== lsig) {
          els.lkRow.setAttribute('data-sig', lsig);
          els.lkRow.innerHTML = '';
          (st.looks || []).forEach(function(l){
            var lb = document.createElement('button');
            lb.type = 'button'; lb.className = 'lkb'; lb.setAttribute('data-k', l.k); lb.textContent = l.label;
            lb.onclick = function(e){ e.stopPropagation(); sendAction('pickLook', { key: l.k }); };
            els.lkRow.appendChild(lb);
          });
        }
        [].forEach.call(els.lkRow.children, function(b){ b.classList.toggle('on', b.getAttribute('data-k') === st.lookKey); });
      }
    });

    safe('photo strip', function(){
      var shots = st.shots || [];
      els.film.classList.toggle('hide', !!st.showQr);
      els.film.classList.toggle('no-shots', !st.editPreview && !shots.some(function(s){ return !!s.src; }));
      els.film.style.setProperty('--n', String(Math.max(3, shots.length)));
      if (els.film.children.length !== shots.length) {
        els.film.innerHTML = '';
        for (var i = 0; i < shots.length; i++) els.film.appendChild(document.createElement('div'));
      }
      shots.forEach(function(s, i){
        var d = els.film.children[i];
        d.className = (s.src ? 'f ' : '') + (s.pick ? 'pick ' : '') + (s.sel ? 'sel' : '');
        d.style.backgroundImage = s.src ? 'url("' + s.src + '")' : '';
        d.onclick = s.pick ? function(e){ e.stopPropagation(); sendAction('retakeIndex', { index: i }); } : null;
      });
    });

    safe('retake and done', function(){
      els.gRetake.textContent = st.retakeText || 'Retake';
      els.gRetake.classList.toggle('hide', !st.retakeShow);
      els.gDone.textContent = st.doneText || 'Done';
      els.gDone.classList.toggle('hide', !st.doneShow);
      els.gb.classList.toggle('hide', !st.retakeShow && !st.doneShow);
    });

    safe('QR codes', function(){
      els.qrw.classList.toggle('hide', !st.showQr);
      els.qrw.classList.toggle('two', (st.qrs || []).length > 1);
      els.qrTitle.textContent = st.qrPop === 'show' ? (st.qrTitle || '') : '';
      if (st.showQr) {
        var qrs = st.qrs || [];
        var qsig = qrs.map(function(q){ return q.kind + '|' + (q.src ? q.src.length + ':' + q.src.slice(-24) : 'wait') + '|' + q.label; }).join(',');
        if (els.qrw.getAttribute('data-sig') !== qsig) {
          els.qrw.setAttribute('data-sig', qsig);
          els.qrw.innerHTML = '';
          qrs.forEach(function(q){
            var box = document.createElement('div'); box.className = 'qrb';
            var qbox = document.createElement('div'); qbox.className = 'qr';
            if (q.src) { var im = document.createElement('img'); im.src = q.src; im.alt = 'QR code'; qbox.appendChild(im); }
            else { var sp = document.createElement('span'); sp.textContent = q.wait || 'Preparing…'; qbox.appendChild(sp); }
            var lbl = document.createElement('span'); lbl.className = 'qrl'; lbl.textContent = q.label || '';
            box.append(qbox, lbl);
            els.qrw.appendChild(box);
          });
        }
      }
    });

    safe('print and done', function(){
      var showPrint = !!(st.isResult && st.printShow);
      var showNext = !!(st.isResult && st.nextShow);
      els.resActions.classList.toggle('hide', !showPrint && !showNext);
      els.gPrintBtn.classList.toggle('hide', !showPrint);
      els.gPrintBtn.classList.toggle('printing', !!(showPrint && st.printBusy));   // "Printing, please hold…" is long: smaller letters
      if (showPrint) {
        els.gPrintBtn.disabled = !!st.printDisabled;
        els.gPrintBtn.innerHTML = '🖨️ ' + (st.printLabel || 'Print') + (st.printSub ? '<small>' + st.printSub + '</small>' : '');
        copyMax = Math.max(1, Number(st.printMaxCopies) || 1);
        if (!st.printGuestCopies) els.copiesModal.classList.add('hide');
      } else {
        els.copiesModal.classList.add('hide');
      }
      els.gNextBtn.classList.toggle('hide', !showNext);
      els.gNextBtn.textContent = st.nextLabel || 'Done';
    });

    safe('event gallery', function(){
      els.galleryPill.classList.toggle('hide', !st.galleryShow);
      if (st.galleryShow && st.galleryQr) els.galleryQr.src = st.galleryQr;
      else els.galleryCard.classList.add('hide');
    });

    safe('camera position', function(){ syncNativePreview(); });
  }

  function renderCopies(){
    els.copiesVal.textContent = String(copyCount);
    els.copiesMinus.disabled = copyCount <= 1;
    els.copiesPlus.disabled = copyCount >= copyMax;
    els.copiesLeft.textContent = curState && curState.printLimitText ? curState.printLimitText : '';
  }

  if (els.pkBack) els.pkBack.onclick = function(e){ e.stopPropagation(); sendAction('pickBack'); };
  els.gReadyBtn.onclick = function(e){ e.stopPropagation(); sendAction('readyStart'); };
  els.gReady.onclick = function(e){ e.stopPropagation(); sendAction('readyStart'); };
  els.lk.onclick = function(e){ e.stopPropagation(); };
  els.lkPill.onclick = function(e){ e.stopPropagation(); sendAction('toggleLooks'); };
  els.gRetake.onclick = function(e){ e.stopPropagation(); sendAction('retake'); };
  els.gDone.onclick = function(e){ e.stopPropagation(); sendAction('done'); };
  els.gNextBtn.onclick = function(e){ e.stopPropagation(); sendAction('nextGuest'); };
  els.gPrintBtn.onclick = function(e){
    e.stopPropagation();
    if (!curState || curState.printDisabled) return;
    if (curState.printGuestCopies && copyMax > 1) {
      copyCount = Math.max(1, Math.min(copyMax, Number(curState.printDefaultCopies) || 1));
      els.copiesTitle.textContent = curState.printCopiesTitle || 'How many copies?';
      els.copiesGo.textContent = curState.printLabel || 'Print';
      renderCopies();
      els.copiesModal.classList.remove('hide');
    } else {
      sendAction('print', { copies: Number(curState.printDefaultCopies) || 1 });
    }
  };
  els.copiesModal.onclick = function(e){ e.stopPropagation(); if (e.target === els.copiesModal) els.copiesModal.classList.add('hide'); };
  els.copiesMinus.onclick = function(){ if (copyCount > 1) { copyCount--; renderCopies(); } };
  els.copiesPlus.onclick = function(){ if (copyCount < copyMax) { copyCount++; renderCopies(); } };
  els.copiesCancel.onclick = function(){ els.copiesModal.classList.add('hide'); };
  els.copiesGo.onclick = function(){ els.copiesModal.classList.add('hide'); sendAction('print', { copies: copyCount }); };
  els.galleryPill.onclick = function(e){ e.stopPropagation(); els.galleryCard.classList.toggle('hide'); };
  els.galleryCard.onclick = function(e){ e.stopPropagation(); };
  $('guestGalleryClose').onclick = function(e){ e.stopPropagation(); els.galleryCard.classList.add('hide'); };
  document.addEventListener('click', function(){
    if (!curState) return;
    if (curState.retakeShow || curState.doneShow || curState.isResult || curState.pickOpen) return;
    sendAction('trigger');
  });

  // ---- Spoken countdown: the laptop sends the words, this tablet says them (the laptop stays quiet) ----
  // The app's own text-to-speech (window.__PBVoice) is used when the tablet app has it; otherwise the page's speechSynthesis.
  // The tablet tells the laptop which voices it has ("voiceCaps"); with none, the laptop keeps speaking itself.
  var voiceReports = 0;
  function voiceNative(){
    try { var v = window.__PBVoice; return v && typeof v.speak === 'function' && typeof v.voices === 'function' ? v : null; } catch(e){ return null; }
  }
  function voiceWeb(){
    try { return window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null; } catch(e){ return null; }
  }
  function voiceListFor(lang){
    var out = [];
    var nat = voiceNative();
    if (nat) {
      try {
        out = JSON.parse(nat.voices(lang) || '[]').map(function(v){ return { name: String(v.name), lang: String(v.lang || ''), localService: !!v.local }; });
      } catch(e){ out = []; }
    } else {
      var ss = voiceWeb();
      if (ss) {
        var re = lang === 'fil' ? /^(fil|tl)([-_]|$)/i : /^en([-_]|$)/i;
        try {
          out = (ss.getVoices() || []).filter(function(v){ return re.test(v.lang || ''); })
            .map(function(v){ return { name: v.name, lang: v.lang, localService: !!v.localService }; });
        } catch(e){ out = []; }
      }
    }
    return out;
  }
  function reportVoices(){
    var en = voiceListFor('en'), fil = voiceListFor('fil');
    sendAction('voiceCaps', { voices: { en: en, fil: fil } });
    // The speech engine takes a moment to start (and a browser fills its voice list late): look again for a while.
    if (!en.length && ++voiceReports < 14) setTimeout(reportVoices, 1500);
  }
  function voiceSpeak(m){
    var text = String(m.text || '');
    if (!text) return;
    var vol = Number(m.vol); if (!(vol > 0 && vol <= 1)) vol = 1;
    var nat = voiceNative();
    if (nat) { try { nat.speak(text, String(m.name || ''), vol); } catch(e){} return; }
    var ss = voiceWeb();
    if (!ss) return;
    try {
      if (ss.speaking || ss.pending) ss.cancel();      // never let a late word pile up behind the next one
      if (ss.paused) ss.resume();
      var u = new SpeechSynthesisUtterance(text);
      var vs = ss.getVoices() || [], pick = null, i;
      for (i = 0; i < vs.length; i++) { if (vs[i].name === m.name) { pick = vs[i]; break; } }
      if (pick) { u.voice = pick; u.lang = pick.lang; } else { u.lang = m.lang === 'fil' ? 'fil-PH' : 'en-US'; }
      u.volume = vol; u.rate = 1; u.pitch = 1;
      ss.speak(u);
    } catch(e){}
  }
  function voiceHush(){
    var nat = voiceNative();
    if (nat) { try { nat.stop(); } catch(e){} return; }
    var ss = voiceWeb();
    try { if (ss && (ss.speaking || ss.pending)) ss.cancel(); } catch(e){}
  }
  try { var ssv = voiceWeb(); if (ssv && ssv.addEventListener) ssv.addEventListener('voiceschanged', function(){ voiceReports = 0; reportVoices(); }); } catch(e){}

  // ---- Beeps, "Pose" chime and the shutter click: the laptop sends the sound files once ("sounds"), then one "sound" message per beep ----
  // The tablet tells the laptop when it can play them ("soundCaps"): the files are decoded and its audio is running. Until then, and in a
  // browser that keeps audio locked until the first tap, the laptop plays them itself.
  var SND_KINDS = ['shut', 'b1', 'b2', 'pose', 'chime'];
  var snd = { ctx: null, bufs: {}, gen: 0, primed: false, lastOk: null };
  function sndCtx(){
    if (snd.ctx) return snd.ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { snd.ctx = new AC(); snd.ctx.onstatechange = function(){ reportSound(); }; }
    } catch(e){ snd.ctx = null; }
    return snd.ctx;
  }
  function sndUnlock(){
    var c = snd.ctx;
    if (!c) return;
    if (c.state === 'suspended') { try { var p = c.resume(); if (p && p.catch) p.catch(function(){}); } catch(e){} }
    if (!snd.primed) {
      snd.primed = true;
      try { var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch(e){}
    }
  }
  function sndReady(){
    var c = snd.ctx, i;
    if (!c || c.state !== 'running') return false;
    for (i = 0; i < SND_KINDS.length; i++) { if (!snd.bufs[SND_KINDS[i]]) return false; }
    return true;
  }
  function reportSound(force){
    var ok = sndReady();
    if (force === true || ok !== snd.lastOk) { snd.lastOk = ok; sendAction('soundCaps', { ok: ok }); }
  }
  function sndBytes(url){
    var t = atob(String(url).split(',')[1] || ''), a = new Uint8Array(t.length), i;
    for (i = 0; i < t.length; i++) a[i] = t.charCodeAt(i);
    return a.buffer;
  }
  function sndDecode(c, ab){
    return new Promise(function(res, rej){ try { var pr = c.decodeAudioData(ab, res, rej); if (pr && pr.then) pr.then(res, rej); } catch(e){ rej(e); } });
  }
  function sndLoad(m){
    var c = sndCtx();
    if (!c || !m || !m.sounds) return;
    var gen = ++snd.gen;
    var left = 0;
    SND_KINDS.forEach(function(k){
      var url = m.sounds[k];
      if (typeof url !== 'string' || !url) return;
      left++;
      var done = function(){ if (--left === 0 && gen === snd.gen) reportSound(true); };
      var bytes;
      try { bytes = sndBytes(url); } catch(e){ done(); return; }
      sndDecode(c, bytes).then(function(buf){ if (gen === snd.gen) snd.bufs[k] = buf; done(); }, function(){ done(); });
    });
    if (!left) reportSound(true);
  }
  function sndPlay(kind, vol){
    var c = snd.ctx, b = snd.bufs[kind];
    if (!c || !b) return;
    if (c.state === 'suspended') sndUnlock();
    try {
      var s = c.createBufferSource(), g = c.createGain();
      s.buffer = b; g.gain.value = (vol > 0 && vol <= 2) ? vol : 0.7;
      s.connect(g); g.connect(c.destination); s.start(0);
    } catch(e){}
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function(ev){ document.addEventListener(ev, sndUnlock, true); });

  function connectWs(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + base + '/ws?role=guest');
    ws.onopen = function(){
      els.conn.classList.add('hide');
      syncNativePreview();
      voiceReports = 0;
      reportVoices();
      reportSound(true);
    };
    ws.onclose = function(){
      els.conn.textContent = 'Reconnecting to laptop…';
      els.conn.classList.remove('hide');
      setTimeout(connectWs, 1200);
    };
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (!m || !m.type) return;
      if (m.type === 'state') applyState(m.state);
      else if (m.type === 'tick') {
        els.cd.style.display = 'flex';
        els.cd.classList.toggle('pausing', m.num === '');
        els.num.textContent = m.num || '';
        els.num.classList.toggle('word', !!m.word);
        els.bar.style.strokeDashoffset = String(100 * (1 - (Number(m.progress) || 0)));
        els.chip.textContent = m.chip || 'Smile!';
      } else if (m.type === 'flash') {
        els.flash.classList.add('on');
        els.cd.style.display = 'none';
        setTimeout(function(){ els.flash.classList.remove('on'); }, 180);
      } else if (m.type === 'screenflash') {
        els.flash.style.cssText = m.on ? 'position:fixed;inset:0;background:#fff;opacity:1;z-index:99;transition:none;' : '';
      } else if (m.type === 'toast') {
        showToast(m.msg);
      } else if (m.type === 'voice') {
        voiceSpeak(m);
      } else if (m.type === 'voiceStop') {
        voiceHush();
      } else if (m.type === 'sounds') {
        sndLoad(m);
      } else if (m.type === 'sound') {
        sndPlay(m.kind, Number(m.vol));
      }
    };
  }
  window.addEventListener('resize', function(){ lastRectSig = ''; syncNativePreview(); });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function(){ syncNativePreview(); }).observe(els.frame);
  }
  connectWs();
})();
</script>
</body>
</html>`;
}
