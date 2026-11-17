// A simulated GoPro (Open GoPro HTTP API + an MPEG-TS video stream over UDP) to run lib/cam-gopro.mjs end to end, and the helper's camera routes on top of it.
// Run: node desktop/test/test-gopro.mjs   (no camera needed; uses the ffmpeg in desktop/build/ffmpeg or on the PATH)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = [join(HERE, '..', 'build', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')].find(existsSync) || 'ffmpeg';
const HTTP_PORT = 18080, UDP_PORT = 18554;

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };

// ---- the fake camera ----
const calls = [];
let sender = null, state = { webcam: 0 };
function startSender(port) {
  stopSender();
  sender = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'mpegts', 'udp://127.0.0.1:' + port + '?pkt_size=1316'], { stdio: 'ignore' });
}
function stopSender() { if (sender) { try { sender.kill(); } catch { /* gone */ } sender = null; } }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  calls.push(u.pathname + (u.search || ''));
  const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  switch (u.pathname) {
    case '/gopro/camera/info': return j({ info: { model_name: 'HERO12 Black', serial_number: 'C3461324512345', firmware_version: 'H23.01.02.32.00' } });
    case '/gopro/camera/control/wired_usb': return j({});
    case '/gopro/camera/analytics/set_client_info': return j({});
    case '/gopro/camera/keep_alive': return j({});
    case '/gopro/camera/state': return j({ status: { 70: 87, 2: 3 }, settings: {} });
    case '/gopro/webcam/status': return j({ error: 0, status: state.webcam });
    case '/gopro/webcam/preview': state.webcam = 3; return j({ error: 0, status: 3 });
    case '/gopro/webcam/start': {
      if (Number(u.searchParams.get('res')) !== 12) return j({ error: 6, status: 1 });
      state.webcam = 2; startSender(Number(u.searchParams.get('port'))); return j({ error: 0, status: 2 });
    }
    case '/gopro/webcam/stop': state.webcam = 1; stopSender(); return j({ error: 0, status: 1 });
    case '/gopro/webcam/exit': state.webcam = 0; stopSender(); return j({ error: 0, status: 0 });
    default: res.writeHead(404); res.end('{}');
  }
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));

const g = await import('../lib/cam-gopro.mjs');
g.setLogger(() => { });
g.setBackend({ hosts: [{ host: '127.0.0.1', port: HTTP_PORT, mode: 'usb' }], ffmpeg: FFMPEG, streamPort: UDP_PORT });

const dims = (jpg) => { for (let i = 2; i + 9 < jpg.length;) { if (jpg[i] !== 0xFF) { i++; continue; } const m = jpg[i + 1]; if (m >= 0xC0 && m <= 0xC2) return { h: jpg.readUInt16BE(i + 5), w: jpg.readUInt16BE(i + 7) }; i += 2 + jpg.readUInt16BE(i + 2); } return null; };
const json = (r) => JSON.parse(r.body.toString('utf8'));

try {
  // candidate addresses: the USB network of the camera, and its Wi-Fi
  g.setBackend({});
  const usb = g.candidates({ eth: [{ family: 'IPv4', address: '172.26.139.50' }, { family: 'IPv4', address: '192.168.1.5' }] });
  ok(usb.length === 1 && usb[0].host === '172.26.139.51' && usb[0].mode === 'usb', 'USB network 172.26.139.x -> camera 172.26.139.51');
  const wifi = g.candidates({ w: [{ family: 'IPv4', address: '10.5.5.100' }] });
  ok(wifi.length === 1 && wifi[0].host === '10.5.5.9' && wifi[0].mode === 'wifi', 'GoPro Wi-Fi 10.5.5.x -> camera 10.5.5.9');
  ok(g.candidates({ x: [{ family: 'IPv4', address: '192.168.0.2' }, { family: 'IPv6', address: 'fe80::1' }] }).length === 0, 'an ordinary network is not a GoPro');
  g.setBackend({ hosts: [{ host: '127.0.0.1', port: HTTP_PORT, mode: 'usb' }], ffmpeg: FFMPEG, streamPort: UDP_PORT });

  let r = await g.call('list');
  ok(r.status === 'OK' && json(r).devices[0].name === 'GoPro HERO12 Black' && json(r).devices[0].camera, 'list shows "GoPro HERO12 Black"');
  r = await g.call('frame');
  ok(r.status === 'GONE', 'frame before open: camera not connected');

  const t0 = Date.now();
  r = await g.call('open');
  ok(r.status === 'OK' && json(r).name === 'GoPro HERO12 Black' && json(r).battery === 87, 'open: name + battery 87% (' + (Date.now() - t0) + ' ms to first picture)');
  ok(calls.some((c) => c.startsWith('/gopro/camera/control/wired_usb?p=1')), 'wired USB control switched on');
  ok(calls.some((c) => /^\/gopro\/webcam\/start\?res=12&fov=4&port=18554&protocol=TS$/.test(c)), 'webcam started at 1080p, linear lens, TS');

  r = await g.call('frame');
  ok(r.status === 'OK' && r.kind === 'B' && r.body[0] === 0xFF && r.body[1] === 0xD8, 'frame is a JPEG (' + Math.round(r.body.length / 1024) + ' KB)');
  const d = dims(r.body);
  ok(d && d.w === 1920 && d.h === 1080, 'frame is 1920x1080 (got ' + (d ? d.w + 'x' + d.h : '?') + ')');

  const before = Date.now();
  r = await g.call('capture');
  ok(r.status === 'OK' && r.kind === 'B' && r.body.length > 20000, 'capture returns a photo (' + Math.round(r.body.length / 1024) + ' KB)');
  ok(Date.now() - before < 2500, 'capture is quick (' + (Date.now() - before) + ' ms)');

  r = await g.call('battery');
  ok(r.status === 'OK' && json(r).battery === 87, 'battery 87%');
  r = await g.call('af');
  ok(r.status === 'OK', 'autofocus answers OK (a GoPro focuses itself)');

  r = await g.call('live', 'off');
  ok(r.status === 'OK' && calls.includes('/gopro/webcam/stop'), 'live off stops the webcam');
  r = await g.call('live', 'on');
  r = await g.call('frame');
  ok(r.status === 'OK' && r.kind === 'B', 'live on again: frames come back');

  r = await g.call('close');
  ok(r.status === 'OK' && calls.includes('/gopro/webcam/exit') && !g.isOpen(), 'close leaves webcam mode');

  // the routes the booth page calls (/helper/camera/...), with the Windows camera worker running next to the GoPro
  if (process.platform === 'win32') {
    const { initHelper, handleHelper, stopHelper } = await import('../lib/helper.mjs');
    initHelper({ workerPath: join(HERE, '..', 'build', 'camera-worker.ps1'), logger: () => { } });
    const hr = (method, path) => { const [p, q] = path.split('?'); return handleHelper(new Request('http://x/helper' + p + (q ? '?' + q : ''), { method }), p, new URLSearchParams(q || '')); };
    let res = await hr('GET', '/camera');
    let body = await res.json();
    ok(res.status === 200 && body.devices.some((d) => d.gopro && d.name === 'GoPro HERO12 Black'), 'helper: GET /camera lists the GoPro when no DSLR is plugged in');
    res = await hr('POST', '/camera/open');
    body = await res.json();
    ok(res.status === 200 && body.name === 'GoPro HERO12 Black', 'helper: POST /camera/open connects the GoPro');
    res = await hr('POST', '/camera/live?on=1'); ok(res.status === 200, 'helper: live view on');
    res = await hr('GET', '/camera/frame'); const f = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200 && res.headers.get('content-type') === 'image/jpeg' && f[0] === 0xFF && f[1] === 0xD8, 'helper: GET /camera/frame is a JPEG');
    res = await hr('POST', '/camera/capture'); const p = Buffer.from(await res.arrayBuffer());
    ok(res.status === 200 && p.length > 20000 && p[0] === 0xFF, 'helper: POST /camera/capture is a photo (' + Math.round(p.length / 1024) + ' KB)');
    res = await hr('GET', '/camera/battery'); body = await res.json();
    ok(res.status === 200 && body.battery === 87, 'helper: battery 87%');
    res = await hr('GET', '/status'); body = await res.json();
    ok(body.camera && body.camera.open && body.camera.name === 'GoPro HERO12 Black', 'helper: /status shows the open GoPro');
    res = await hr('POST', '/camera/close'); ok(res.status === 200 && !g.isOpen(), 'helper: close');
    stopHelper();
  }

  // the camera refuses (error 7 = not available)
  const startOld = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/gopro/webcam/start') { res.writeHead(200); res.end('{"error":7,"status":1}'); return; }
    startOld(req, res);
  });
  r = await g.call('open');
  ok(r.status === 'ERR' && /not available/.test(r.body.toString()) && !g.isOpen(), 'a camera that refuses webcam mode gives a readable error');
  server.removeAllListeners('request'); server.on('request', startOld);

  // camera gone
  server.close(); server.closeAllConnections && server.closeAllConnections();
  r = await g.call('open');
  ok(r.status === 'GONE' && /^NOCAMERA/.test(r.body.toString()), 'no camera answering -> NOCAMERA');
  await g.reset();
} catch (e) {
  failed++; console.log('FAIL exception: ' + (e && e.stack || e));
} finally {
  stopSender(); try { server.close(); } catch { /* closed */ }
  await g.reset();
}
console.log(failed ? '\n' + failed + ' FAILED' : '\nAll GoPro checks passed');
process.exit(failed ? 1 : 0);
