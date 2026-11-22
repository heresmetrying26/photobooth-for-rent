// GoPro camera (HERO9 Black and newer) for the booth, through the Open GoPro HTTP API (https://github.com/gopro/OpenGoPro).
//
// How the laptop reaches the camera:
//   USB     the GoPro plugged in with a USB-C data cable shows up as a network adapter. The camera is at 172.2X.1YZ.51, where X, Y, Z are the
//           last three digits of its serial number, and the laptop gets 172.2X.1YZ.5x. Control: http://<camera>:8080/gopro/...
//   Wi-Fi   the laptop joined to the camera's own Wi-Fi (Connections > Connect Device > GoPro App). The camera is 10.5.5.9.
//
// Live view and photos: the camera sends video (H.264 in MPEG-TS) by UDP to port 8554 of this laptop. The app itself receives it (so the Windows
// Firewall rule made for photobooth4u.exe by the installer covers it) and hands it to ffmpeg (the one shipped with the app for the 360 desk),
// which writes one JPEG after another; "frame" gives the newest one and "capture" gives the first one after the call, so
// a photo is a 1080p still taken from the live picture (no slow switch between video and photo mode).
//
// call(cmd, arg) answers like camera-mac.mjs / the Windows camera worker:
//   { status: 'OK' | 'ERR' | 'GONE', kind: 'J' json | 'B' bytes | 'N' none, body: Buffer, flags: [] }
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findFfmpeg } from './spin.mjs';

const HTTP_PORT = 8080;
const STREAM_PORT = 8554;
const USB_RE = /^172\.(2\d)\.(1\d\d)\.\d{1,3}$/;      // the laptop's address on the camera's USB network
const WIFI_HOST = '10.5.5.9';                         // the camera's own Wi-Fi
const RES_1080 = 12, FOV_LINEAR = 4;                  // Open GoPro webcam settings (resolution 4 = 480p, 7 = 720p, 12 = 1080p; fov 0 wide, 2 narrow, 3 superview, 4 linear)
const FRAME_FPS = 12;
const MAX_FRAME = 8 * 1024 * 1024;

const WEBCAM_ERRORS = {
  1: 'the camera could not switch preset', 2: 'the camera could not set the window size', 3: 'the camera could not start streaming',
  4: 'the camera is busy with the shutter', 5: 'the camera did not answer in time', 6: 'a setting is not valid for this camera',
  7: 'the camera is not available for webcam use right now (is it recording, or in the middle of a firmware update?)', 8: 'the camera could not leave webcam mode'
};

class CamError extends Error { }
class GoneError extends Error { }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (status, kind, body, flags) => ({ status, kind, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8'), flags: flags || [] });

// ---- overridable for tests: { hosts: [{ host, port, mode }] , ffmpeg, streamPort, lanIps: () => [...] } ----
let backend = {};
export function setBackend(b) { backend = b || {}; }

let logFn = (m) => console.log('[gopro] ' + m);
export function setLogger(fn) { if (typeof fn === 'function') logFn = fn; }
const log = (m) => { try { logFn(m); } catch { /* ignore */ } };

const s = {
  open: false, host: '', port: HTTP_PORT, mode: '', name: '', info: null, battery: -1,
  ff: null, udp: null, ffErr: '', frame: null, frameAt: 0, buf: Buffer.alloc(0), streaming: false, starting: null,
  keep: null, keepFails: 0, gen: 0, movieRec: false, moviePrevFiles: null, movieWasStreaming: false
};

// ---------- talking to the camera ----------
function httpGet(host, port, path, ms, binary) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: ms || 4000, agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 64 * 1024 * 1024) { req.destroy(new Error('too big')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function getJson(path, ms) {
  const r = await httpGet(s.host, s.port, path, ms);
  let j = {};
  try { j = JSON.parse(r.body.toString('utf8') || '{}'); } catch { /* not JSON */ }
  if (r.status >= 400 && r.status !== 0) { const e = new CamError('ERROR The GoPro refused ' + path.split('?')[0] + ' (HTTP ' + r.status + ').'); e.status = r.status; e.json = j; throw e; }
  return j;
}

// Where could a GoPro be? USB: one address per adapter the camera made; Wi-Fi: the camera's own network.
export function candidates(ifaces) {
  if (backend.hosts) return backend.hosts.slice();
  const out = [], seen = new Set();
  const all = ifaces || os.networkInterfaces();
  for (const list of Object.values(all)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const m = USB_RE.exec(a.address || '');
      if (m) { const host = '172.' + m[1] + '.' + m[2] + '.51'; if (!seen.has(host)) { seen.add(host); out.push({ host, port: HTTP_PORT, mode: 'usb' }); } }
      else if ((a.address || '').startsWith('10.5.5.') && !seen.has(WIFI_HOST)) { seen.add(WIFI_HOST); out.push({ host: WIFI_HOST, port: HTTP_PORT, mode: 'wifi' }); }
    }
  }
  return out;
}

// The first candidate that answers like a GoPro: { host, port, mode, name, serial, firmware }, or null.
export async function detect(ifaces) {
  for (const c of candidates(ifaces)) {
    try {
      const r = await httpGet(c.host, c.port, '/gopro/camera/info', 2500);
      if (r.status !== 200) continue;
      const j = JSON.parse(r.body.toString('utf8') || '{}');
      const info = j.info || j;                                   // the answer comes as { info: { model_name, serial_number, ... } }
      const model = String(info.model_name || info.model || '').trim();
      return { host: c.host, port: c.port, mode: c.mode, name: 'GoPro ' + (model.replace(/^GoPro\s*/i, '') || 'camera'), serial: String(info.serial_number || ''), firmware: String(info.firmware_version || '') };
    } catch { /* not here */ }
  }
  return null;
}

// ---------- live view: the camera's UDP video, turned into JPEGs by ffmpeg ----------
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
function onFfData(chunk) {
  s.buf = s.buf.length ? Buffer.concat([s.buf, chunk]) : chunk;
  for (; ;) {
    const a = s.buf.indexOf(SOI);
    if (a < 0) { s.buf = Buffer.alloc(0); return; }
    const b = s.buf.indexOf(EOI, a + 2);
    if (b < 0) { if (a > 0) s.buf = s.buf.subarray(a); if (s.buf.length > MAX_FRAME) s.buf = Buffer.alloc(0); return; }
    s.frame = Buffer.from(s.buf.subarray(a, b + 2));
    s.frameAt = Date.now();
    s.buf = s.buf.subarray(b + 2);
  }
}

async function startFfmpeg() {
  const exe = backend.ffmpeg || await findFfmpeg();
  if (!exe) throw new CamError('ERROR Live view from a GoPro needs ffmpeg, which is missing from this copy of the app. Reinstall the latest photobooth4u.');
  const port = backend.streamPort || STREAM_PORT;
  // The video comes in on stdin: -f mpegts says what it is, a small probe keeps the start quick.
  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer+discardcorrupt', '-flags', 'low_delay',
    '-probesize', '500000', '-analyzeduration', '500000', '-f', 'mpegts', '-i', 'pipe:0',
    '-an', '-vf', 'fps=' + FRAME_FPS, '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
  const gen = ++s.gen;
  s.buf = Buffer.alloc(0); s.frame = null; s.frameAt = 0; s.ffErr = '';
  // Listen first, so nothing the camera sends is lost.
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve, reject) => {
    sock.once('error', (e) => reject(new CamError('ERROR This computer could not listen for the GoPro picture on port ' + port + ' (' + (e && e.code || e && e.message || e) + '). Close other apps that use the GoPro (GoPro Webcam, OBS) and try again.')));
    sock.bind(port, '0.0.0.0', resolve);
  });
  sock.on('error', () => { /* ignore later socket errors */ });
  try { sock.setRecvBufferSize(4 * 1024 * 1024); } catch { /* keep the default */ }
  const p = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  s.ff = p; s.udp = sock;
  p.stdin.on('error', () => { /* ffmpeg stopped */ });
  sock.on('message', (msg) => {
    if (gen !== s.gen || !p.stdin.writable) return;
    if (p.stdin.writableLength > 4 * 1024 * 1024) return;   // ffmpeg is behind: drop, so the picture stays live
    p.stdin.write(msg);
  });
  p.stdout.on('data', (c) => { if (gen === s.gen) onFfData(c); });
  p.stderr.on('data', (c) => { s.ffErr = (s.ffErr + String(c)).slice(-600); });
  p.on('error', (e) => { s.ffErr += String(e && e.message || e); });
  p.on('close', () => { if (s.ff === p) { s.ff = null; s.streaming = false; try { sock.close(); } catch { /* closed */ } if (s.udp === sock) s.udp = null; } });
}

function stopFfmpeg() {
  s.gen++;
  const p = s.ff, sock = s.udp; s.ff = null; s.udp = null; s.streaming = false;
  s.buf = Buffer.alloc(0);
  if (sock) { try { sock.close(); } catch { /* closed */ } }
  if (p) { try { p.stdin.end(); } catch { /* gone */ } try { p.kill(); } catch { /* gone */ } }
}

async function startStream() {
  if (s.streaming && s.ff) return;
  if (s.starting) return s.starting;
  s.starting = (async () => {
    await startFfmpeg();
    try {
      if (s.mode === 'usb') {
        // The webcam mode of the camera: leave any earlier stream, enter preview, then start at 1080p with the Linear lens (no fish-eye).
        let st = {};
        try { st = await getJson('/gopro/webcam/status', 4000); } catch { /* older firmware: carry on */ }
        if (Number(st.status) >= 2) { try { await getJson('/gopro/webcam/stop', 6000); await sleep(400); } catch { /* ignore */ } }
        try { await getJson('/gopro/webcam/preview', 8000); await sleep(300); } catch { /* start works without it on newer firmware */ }
        const q = '/gopro/webcam/start?res=' + RES_1080 + '&fov=' + FOV_LINEAR + '&port=' + (backend.streamPort || STREAM_PORT) + '&protocol=TS';
        const j = await getJson(q, 10000);
        if (j && Number(j.error) > 0) throw new CamError('ERROR The GoPro would not start its webcam picture: ' + (WEBCAM_ERRORS[Number(j.error)] || ('error ' + j.error)) + '.');
      } else {
        await getJson('/gopro/camera/stream/start?port=' + (backend.streamPort || STREAM_PORT), 8000);
      }
      // First picture. The camera needs a few seconds to start sending.
      const t0 = Date.now();
      while (!s.frame && Date.now() - t0 < 12000) {
        if (!s.ff) throw new CamError('ERROR Could not decode the GoPro picture' + (s.ffErr ? ' (' + s.ffErr.trim().split('\n').pop().slice(0, 160) + ')' : '') + '.');
        await sleep(120);
      }
      if (!s.frame) throw new CamError('ERROR The GoPro started, but no picture reached this computer. Windows Firewall may be blocking it: allow photobooth4u (and ffmpeg) on private networks, then try again.');
      s.streaming = true;
    } catch (e) {
      stopFfmpeg();
      throw e;
    }
  })().finally(() => { s.starting = null; });
  return s.starting;
}

async function stopStream() {
  stopFfmpeg();
  if (!s.open) return;
  try {
    if (s.mode === 'usb') { await getJson('/gopro/webcam/stop', 5000); await getJson('/gopro/webcam/exit', 5000).catch(() => { }); }
    else await getJson('/gopro/camera/stream/stop', 5000);
  } catch { /* the camera is gone or already stopped */ }
}

// ---------- keeping the camera awake and noticing it was unplugged ----------
function startKeep() {
  stopKeep();
  s.keepFails = 0;
  const t = setInterval(async () => {
    if (!s.open) return;
    try { await httpGet(s.host, s.port, '/gopro/camera/keep_alive', 2500); s.keepFails = 0; }
    catch { if (++s.keepFails >= 3) { log('Camera stopped answering'); markGone(); } }
  }, 3000);
  if (t.unref) t.unref();
  s.keep = t;
}
function stopKeep() { if (s.keep) { clearInterval(s.keep); s.keep = null; } }
function markGone() { s.open = false; stopKeep(); stopFfmpeg(); }

async function readBattery() {
  try {
    const j = await getJson('/gopro/camera/state', 4000);
    const v = j && j.status && j.status['70'];                    // status 70 = internal battery percentage
    if (typeof v === 'number' && v >= 0 && v <= 100) return v;
    const bars = j && j.status && j.status['2'];                  // status 2 = battery bars (0..4) when the percentage isn't there
    if (typeof bars === 'number' && bars >= 0 && bars <= 4) return bars * 25;
  } catch { /* unknown */ }
  return -1;
}

// ---------- the commands the booth sends ----------
async function open() {
  if (s.open) { try { await httpGet(s.host, s.port, '/gopro/camera/keep_alive', 2500); return info(); } catch { markGone(); } }
  const f = await detect();
  if (!f) throw new GoneError('NOCAMERA No GoPro found. Switch the GoPro on and plug it into this computer with a USB-C data cable (not charge-only). With Wi-Fi: join this computer to the GoPro’s own Wi-Fi first. On Windows the GoPro must show up as a network adapter (install GoPro Webcam from gopro.com/webcam if it does not).');
  s.host = f.host; s.port = f.port; s.mode = f.mode; s.name = f.name; s.info = f;
  if (s.mode === 'usb') { try { await getJson('/gopro/camera/control/wired_usb?p=1', 4000); } catch { /* HERO9 with old firmware: not needed */ } }
  try { await getJson('/gopro/camera/analytics/set_client_info', 3000); } catch { /* optional */ }
  s.open = true; startKeep();
  s.battery = await readBattery();
  log('Connected: ' + s.name + ' (' + s.mode + ' ' + s.host + ', firmware ' + (f.firmware || '?') + ')');
  try { await startStream(); }
  catch (e) { s.open = false; stopKeep(); throw e; }
  return info();
}
const info = () => JSON.stringify({ name: s.name, battery: s.battery, gopro: true, mode: s.mode, serial: s.info ? s.info.serial : '' });

async function newestFrame(afterMs, waitMs) {
  const t0 = Date.now();
  for (; ;) {
    if (!s.ff && !s.starting) throw new GoneError('NOCAMERA The GoPro picture stopped. Check the USB cable and that the camera is on.');
    if (s.frame && s.frameAt >= afterMs) return s.frame;
    if (Date.now() - t0 > waitMs) return s.frame && Date.now() - s.frameAt < 2500 ? s.frame : null;
    await sleep(40);
  }
}

async function listMediaFiles() {
  const j = await getJson('/gopro/media/list', 5000);
  const out = [];
  for (const dir of (j && Array.isArray(j.media) ? j.media : [])) {
    const d = dir && dir.d ? String(dir.d) : '';
    for (const f of (dir && Array.isArray(dir.fs) ? dir.fs : [])) {
      if (f && f.n) out.push({ dir: d, name: String(f.n), key: `${d}/${f.n}`, size: Number(f.s || 0) });
    }
  }
  return out;
}

function streamHttpToFile(urlPath, outDir, ext = '.mp4', ms = 120000) {
  const safeDir = String(outDir || '').trim().replace(/^["']|["']$/g, '');
  if (!safeDir || !fs.existsSync(safeDir)) return Promise.reject(new CamError('BAD Destination folder does not exist: ' + safeDir));
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const fileName = `gopro-360-${stamp}${ext}`;
  const finalPath = path.join(safeDir, fileName);
  const partPath = finalPath + '.part';
  const metaPath = partPath + '.meta';
  return new Promise((resolve, reject) => {
    const req = http.get({ host: s.host, port: s.port, path: urlPath, timeout: ms, agent: false, headers: { connection: 'close' } }, (res) => {
      if ((res.statusCode || 0) >= 400 || res.statusCode === 0) {
        res.resume();
        return reject(new CamError(`CAPTURE GoPro download failed (HTTP ${res.statusCode || 0}).`));
      }
      const total = Number(res.headers['content-length'] || 0) || 0;
      try { fs.writeFileSync(metaPath, JSON.stringify({ total, filename: fileName })); } catch { /* ignore */ }
      const ws = fs.createWriteStream(partPath);
      let bytes = 0, settled = false;
      const fail = (err) => {
        if (settled) return; settled = true;
        try { ws.destroy(); } catch { /* ignore */ }
        fsp.unlink(partPath).catch(() => {});
        fsp.unlink(metaPath).catch(() => {});
        reject(err);
      };
      res.on('data', (c) => { bytes += c.length; });
      res.pipe(ws);
      ws.on('finish', () => {
        if (settled) return; settled = true;
        fsp.unlink(metaPath).catch(() => {});
        if (bytes < 16) {
          fsp.unlink(partPath).catch(() => {});
          return reject(new CamError('CAPTURE GoPro returned an empty video file.'));
        }
        try {
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
          fs.renameSync(partPath, finalPath);
          resolve({ ok: true, brand: 'gopro', path: finalPath, filename: fileName, bytes, format: ext.replace(/^\./, '') });
        } catch (err) {
          fsp.unlink(partPath).catch(() => {});
          reject(err);
        }
      });
      ws.on('error', fail);
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      fsp.unlink(partPath).catch(() => {});
      fsp.unlink(metaPath).catch(() => {});
      reject(err);
    });
  });
}

async function movieStart() {
  if (s.movieRec) return JSON.stringify({ ok: true, brand: 'gopro', recording: true });
  s.movieWasStreaming = !!(s.streaming || s.ff);
  if (s.mode === 'usb') {
    await stopStream();
    await sleep(350);
  }
  try {
    const list = await listMediaFiles();
    s.moviePrevFiles = new Set(list.map((f) => f.key));
  } catch {
    s.moviePrevFiles = null;
  }
  try {
    await getJson('/gopro/camera/shutter/start', 6000);
  } catch (e) {
    try {
      await getJson('/gopro/camera/presets/set_group?id=1000', 4000);
      await sleep(300);
      await getJson('/gopro/camera/shutter/start', 6000);
    } catch {
      if (s.movieWasStreaming) { s.movieWasStreaming = false; await startStream().catch(() => {}); }
      throw new CamError("CAPTURE The GoPro wouldn't start video recording. Switch it to Video mode and check that the SD card has free space.");
    }
  }
  s.movieRec = true;
  log('GoPro movie recording started');
  return JSON.stringify({ ok: true, brand: 'gopro', recording: true });
}

async function movieStop(outDir) {
  const safeDir = String(outDir || '').trim().replace(/^["']|["']$/g, '');
  if (!safeDir || !fs.existsSync(safeDir)) throw new CamError('BAD Destination folder does not exist: ' + safeDir);
  try {
    try { await getJson('/gopro/camera/shutter/stop', 6000); }
    finally { s.movieRec = false; }

    await sleep(450);
    let pick = null;
    const ew = Date.now();
    while (Date.now() - ew < 12000) {
      try {
        const list = await listMediaFiles();
        const videos = list.filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name));
        if (s.moviePrevFiles) {
          const fresh = videos.filter((f) => !s.moviePrevFiles.has(f.key));
          if (fresh.length > 0) { pick = fresh[fresh.length - 1]; break; }
        } else if (videos.length > 0) {
          pick = videos[videos.length - 1]; break;
        }
      } catch { /* retrying */ }
      await sleep(450);
    }
    if (!pick) throw new CamError('CAPTURE GoPro stopped recording, but no new MP4 appeared in its media list.');
    const ext = path.extname(pick.name).toLowerCase() || '.mp4';
    const dl = await streamHttpToFile(`/videos/DCIM/${encodeURIComponent(pick.dir)}/${encodeURIComponent(pick.name)}`, safeDir, ext);
    log('GoPro movie downloaded: ' + dl.filename + ' (' + Math.round(dl.bytes / 1024) + ' KB)');
    return JSON.stringify(dl);
  } finally {
    s.moviePrevFiles = null;
    if (s.movieWasStreaming) {
      s.movieWasStreaming = false;
      await sleep(300);
      await startStream().catch(() => {});
    }
  }
}

export function isOpen() { return s.open; }
export async function reset() {
  stopKeep();
  const was = s.open, wasRec = s.movieRec;
  s.open = false; s.movieRec = false; s.moviePrevFiles = null; s.movieWasStreaming = false;
  stopFfmpeg();
  if (was) {
    if (wasRec) { try { await getJson('/gopro/camera/shutter/stop', 2500); } catch { /* ignore */ } }
    try { if (s.mode === 'usb') { await getJson('/gopro/webcam/stop', 3000); await getJson('/gopro/webcam/exit', 3000); } else await getJson('/gopro/camera/stream/stop', 3000); } catch { /* ignore */ }
  }
}

export async function listJson() {
  if (s.open) return JSON.stringify({ devices: [{ name: s.name, maker: 'GoPro', camera: true, gopro: true }], open: true, name: s.name });
  const f = await detect();
  return JSON.stringify({ devices: f ? [{ name: f.name, maker: 'GoPro', camera: true, gopro: true }] : [], open: false, name: '' });
}

export async function call(cmd, arg) {
  try {
    if (cmd === 'ping') return reply('OK', 'J', '{"ok":true}');
    if (cmd === 'list') return reply('OK', 'J', await listJson());
    if (cmd === 'open') return reply('OK', 'J', await open());
    if (!s.open) throw new GoneError('NOCAMERA The GoPro isn’t connected.');
    if (cmd === 'info') return reply('OK', 'J', info());
    if (cmd === 'battery') { s.battery = await readBattery(); return reply('OK', 'J', JSON.stringify({ battery: s.battery })); }
    if (cmd === 'af') return reply('OK', 'J', '{"ok":true}');          // a GoPro focuses by itself
    if (cmd === 'live') { if (arg === 'off') await stopStream(); else await startStream(); return reply('OK', 'N', ''); }
    if (cmd === 'frame') {
      if (!s.streaming) { try { await startStream(); } catch (e) { if (e instanceof CamError) return reply('ERR', 'N', e.message); throw e; } }
      const f = s.frame && Date.now() - s.frameAt < 4000 ? s.frame : null;
      if (!f && s.streaming && s.ff && Date.now() - s.frameAt > 6000) throw new GoneError('NOCAMERA The GoPro picture stopped. Check the USB cable and that the camera is on.');
      return f ? reply('OK', 'B', f) : reply('OK', 'N', '');
    }
    if (cmd === 'capture') {
      if (!s.streaming) await startStream();
      const f = await newestFrame(Date.now() - 20, 3500);
      if (!f) throw new CamError('CAPTURE The GoPro picture did not arrive. Try again.');
      return reply('OK', 'B', f);
    }
    if (cmd === 'moviestart') return reply('OK', 'J', await movieStart());
    if (cmd === 'moviestop') return reply('OK', 'J', await movieStop(arg));
    if (cmd === 'close') { await reset(); return reply('OK', 'N', ''); }
    throw new CamError('BAD Unknown command ' + cmd);
  } catch (e) {
    if (e instanceof GoneError) { markGone(); return reply('GONE', 'N', e.message.startsWith('NOCAMERA') ? e.message : 'NOCAMERA ' + e.message); }
    if (e instanceof CamError) return reply('ERR', 'N', e.message);
    if (e && /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timeout|ECONNRESET/i.test(String(e.message || e.code))) { markGone(); return reply('GONE', 'N', 'NOCAMERA The GoPro stopped answering. Switch it off and on, check the USB cable, and try again.'); }
    return reply('ERR', 'N', 'ERROR ' + (e && e.message || e));
  }
}
