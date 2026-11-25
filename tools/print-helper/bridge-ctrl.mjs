// Tablet Guest Screen + Camera Bridge host for the Online Web Booth (via photobooth4u Print Helper).
//
// Starts the exact same LAN HTTP + WebSocket server as the Desktop App (0.0.0.0:47777-47797) using
// desktop/lib/guest-bridge.mjs, and exposes loopback-only /bridge-ctrl/* endpoints on 127.0.0.1:17321
// so https://photobooth4u.netlify.app/app can pair with an Android/Huawei tablet over the same Wi-Fi
// router, laptop hotspot, or USB tethering — no Desktop App required when running online.
import http from 'node:http';
import {
  initBridge,
  getBridgeInfo,
  renewBridgeToken,
  attachBridgeUpgrade,
  handleBridgeHttp,
  pushBridgeState,
  sendBridgeEvent,
  sendCamCommand,
  waitLatestFrame,
  captureBridgeShot,
  setBridgeMedia
} from '../../desktop/lib/guest-bridge.mjs';
import {
  initLanStation,
  handleLanStationHttp,
  getLanStationInfo,
  rotateLanStationPin,
  renderStationDashboardHtml
} from '../../desktop/lib/lan-print-station.mjs';

const BRIDGE_PORTS = [47777, 47778, 47779, 47787, 47797];
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_ACTIONS = 120;

let bridgeServer = null;
let bridgePort = 0;
let evSeq = 0;
const actionRing = []; // [{ seq, action }]
const pollWaiters = new Set();

function wakePollers() {
  if (!pollWaiters.size) return;
  for (const fn of [...pollWaiters]) {
    pollWaiters.delete(fn);
    try { fn(); } catch { /* ignore */ }
  }
}

export function startHelperBridge({ logger = () => { }, ports = BRIDGE_PORTS, lanStation = null } = {}) {
  if (bridgeServer && bridgePort) return Promise.resolve(bridgePort);
  initBridge({
    getPort: () => bridgePort,
    logger,
    onStatus: () => {
      evSeq++;
      wakePollers();
    },
    onAction: (act) => {
      evSeq++;
      actionRing.push({ seq: evSeq, action: act });
      if (actionRing.length > MAX_ACTIONS) actionRing.splice(0, actionRing.length - MAX_ACTIONS);
      wakePollers();
    }
  });
  if (lanStation) {
    initLanStation({
      ...lanStation,
      getPort: () => bridgePort,
      logger
    });
  }
  return new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= ports.length) {
        bridgePort = 0;
        resolve(0);
        return;
      }
      const p = ports[idx++];
      const s = http.createServer((req, res) => {
        let u;
        try { u = new URL(req.url, 'http://x'); } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Bad request');
          return;
        }
        handleLanStationHttp(req, res, u).then((lanHandled) => {
          if (lanHandled) return true;
          return handleBridgeHttp(req, res, u);
        }).then((handled) => {
          if (!handled && !res.writableEnded) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not found');
          }
        }).catch(() => {
          try {
            if (!res.writableEnded) {
              res.writeHead(500, { 'content-type': 'text/plain' });
              res.end('Error');
            }
          } catch { /* closed */ }
        });
      });
      s.once('error', () => {
        try { s.close(); } catch { /* ignore */ }
        tryNext();
      });
      s.listen(p, '0.0.0.0', () => {
        bridgeServer = s;
        bridgePort = s.address().port || p;
        attachBridgeUpgrade(s);
        resolve(bridgePort);
      });
    };
    tryNext();
  });
}

export { getLanStationInfo, rotateLanStationPin, renderStationDashboardHtml };

export function stopHelperBridge() {
  const s = bridgeServer;
  bridgeServer = null;
  bridgePort = 0;
  wakePollers();
  try { s && s.close(); } catch { /* ignore */ }
}

export function helperBridgeStatus() {
  const info = getBridgeInfo();
  return {
    supported: true,
    port: bridgePort,
    connected: !!info.connected,
    camConnected: !!info.camConnected,
    guestConnected: !!info.guestConnected,
    primaryUrl: info.primaryUrl || null
  };
}

function jsonResp(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(headers || {}) }
  });
}

// Handles /bridge-ctrl/* requests arriving on 127.0.0.1:17321 from the online Web Booth.
export async function handleBridgeCtrl(req, url, corsHeaders) {
  const p = url.pathname;
  if (!p.startsWith('/bridge-ctrl/')) return null;

  if (!bridgePort) {
    return jsonResp({ ok: false, error: 'Tablet bridge server is not running.' }, 503, corsHeaders);
  }

  if (req.method === 'GET' && p === '/bridge-ctrl/info') {
    return jsonResp({ ok: true, ...getBridgeInfo(), seq: evSeq }, 200, corsHeaders);
  }

  if (req.method === 'POST' && p === '/bridge-ctrl/renew') {
    return jsonResp({ ok: true, ...renewBridgeToken(), seq: evSeq }, 200, corsHeaders);
  }

  if (req.method === 'POST' && p === '/bridge-ctrl/state') {
    let body = {};
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'Bad JSON' }, 400, corsHeaders); }
    const count = pushBridgeState(body || {});
    return jsonResp({ ok: true, count }, 200, corsHeaders);
  }

  if (req.method === 'POST' && p === '/bridge-ctrl/event') {
    let body = {};
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'Bad JSON' }, 400, corsHeaders); }
    const count = sendBridgeEvent(body || {});
    return jsonResp({ ok: true, count }, 200, corsHeaders);
  }

  if (req.method === 'POST' && p === '/bridge-ctrl/cam-cmd') {
    let body = {};
    try { body = await req.json(); } catch { return jsonResp({ ok: false, error: 'Bad JSON' }, 400, corsHeaders); }
    return jsonResp(sendCamCommand(body || {}), 200, corsHeaders);
  }

  if (req.method === 'GET' && p === '/bridge-ctrl/poll') {
    const after = Number(url.searchParams.get('after') || 0);
    const waitMs = Math.min(15000, Math.max(0, Number(url.searchParams.get('wait') || 0)));
    if (waitMs > 0 && evSeq <= after) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { pollWaiters.delete(done); resolve(); }, waitMs);
        const done = () => { clearTimeout(t); resolve(); };
        pollWaiters.add(done);
      });
    }
    const actions = actionRing.filter((x) => x.seq > after).map((x) => x.action);
    return jsonResp({ ok: true, seq: evSeq, info: getBridgeInfo(), actions }, 200, corsHeaders);
  }

  if (req.method === 'GET' && p === '/bridge-ctrl/frame') {
    const { seq, buf } = await waitLatestFrame(url.searchParams.get('after'), url.searchParams.get('wait'));
    const hdrs = new Headers(corsHeaders || {});
    hdrs.set('cache-control', 'no-store');
    hdrs.set('x-pb-seq', String(seq));
    hdrs.set('access-control-expose-headers', 'x-pb-seq');
    if (!buf) {
      return new Response(null, { status: 204, headers: hdrs });
    }
    hdrs.set('content-type', 'image/jpeg');
    return new Response(buf, { status: 200, headers: hdrs });
  }

  if (req.method === 'POST' && p === '/bridge-ctrl/capture') {
    try {
      const jpeg = await captureBridgeShot(15000);
      return new Response(jpeg, {
        status: 200,
        headers: { ...(corsHeaders || {}), 'content-type': 'image/jpeg', 'cache-control': 'no-store' }
      });
    } catch (e) {
      return jsonResp({ ok: false, error: (e && e.message) || 'Capture failed' }, 503, corsHeaders);
    }
  }

  const mm = /^\/bridge-ctrl\/media\/([A-Za-z0-9_.:-]{1,80})$/.exec(p);
  if (mm && req.method === 'POST') {
    const ab = await req.arrayBuffer();
    if (ab.byteLength > MAX_MEDIA_BYTES) {
      return jsonResp({ ok: false, error: 'Media too large' }, 413, corsHeaders);
    }
    const out = setBridgeMedia(mm[1], req.headers.get('content-type'), Buffer.from(ab));
    return jsonResp(out, 200, corsHeaders);
  }

  return jsonResp({ ok: false, error: 'Not found' }, 404, corsHeaders);
}
