// Canon EOS, Nikon and Sony Alpha cameras on a Mac, straight over USB (libusb), without the browser's WebUSB layer.
// It is a port of tools/print-helper/camera-worker.ps1 (the Windows camera part), which runs the same commands EOS Utility,
// Nikon's tools and gphoto2 use. Canon is handled in this file; Nikon is lib/cam-nikon.mjs and Sony lib/cam-sony.mjs, which
// get the opened camera from here. The booth reaches all of them through the app's /helper/camera/* addresses (lib/helper.mjs),
// so they behave like the Windows camera.
//
// call(cmd, arg) answers like the Windows worker: { status: 'OK' | 'ERR' | 'GONE', kind: 'J' json | 'B' bytes | 'N' none, body: Buffer }.
import { PtpSession, OK, BUSY, GoneError, CamError, TimeoutError, Reader, hex, sleep, listPtpDevices, listAllUsb, openUsbPtp, downloadObject } from './ptp.mjs';
import { freeCamera, guardCamera } from './camfree.mjs';
import { createNikon } from './cam-nikon.mjs';
import { createSony, sonyName } from './cam-sony.mjs';

const NOTREADY = 0xA102;                 // Canon: "not ready yet, ask again"
const CANON = 0x04a9, NIKON = 0x04b0, SONY = 0x054c;   // USB vendor ids
const BRANDS = new Map([[CANON, 'canon'], [NIKON, 'nikon'], [SONY, 'sony']]);
const MAKERS = new Map([[CANON, 'Canon'], [NIKON, 'Nikon'], [SONY, 'Sony']]);

// What talks to the hardware; tests replace it with a fake camera.
const realBackend = {
  list: () => listPtpDevices(),
  all: () => listAllUsb(),
  open: (entry, opts) => openUsbPtp(entry, opts),
  free: async () => { await freeCamera({ quiet: true }); guardCamera(12000); }
};
let backend = realBackend;
export function setBackend(b) { backend = b || realBackend; }

// The last lines are kept so the Camera check screen can show what the camera part did.
const logBuf = [];
const log = (m) => {
  logBuf.push(new Date().toTimeString().slice(0, 8) + ' ' + m);
  if (logBuf.length > 60) logBuf.shift();
  try { console.log('[camera] ' + m); } catch { /* ignore */ }
};

const s = {
  ptp: null, entry: null, name: '', model: '', maker: '', vendorExt: 0, brand: 'canon', drv: null, battery: -1,   // drv: the Nikon / Sony driver (Canon is handled in this file)
  ops: [], props: [], live: false, gotFrame: false, setupNote: '', diag: '',
  eosVals: new Map(), newFiles: [], pollAt: 0, keepAt: 0, liveAt: 0, lastShutterMs: 0, recoverNext: false
};

const has = (op) => s.ops.includes(op);
const u32 = (b, i) => b.readUInt32LE(i);
const u16 = (b, i) => b.readUInt16LE(i);

async function opRetry(code, ...ps) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.ptp.op(code, ...ps);
    if ((r !== BUSY && r !== NOTREADY) || Date.now() - t0 > 3000) return r;
    await sleep(60);
  }
}

// SetDevicePropValueEx: { size 12, setting, value }
async function setEos(prop, val) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(12, 0); b.writeUInt32LE(prop, 4); b.writeUInt32LE(val >>> 0, 8);
  const t0 = Date.now();
  let r;
  for (;;) {
    r = await s.ptp.opWrite(0x9110, b);
    if ((r !== BUSY && r !== NOTREADY) || Date.now() - t0 > 3000) break;
    await sleep(60);
  }
  log('Set ' + hex(prop) + ' = ' + val + ': ' + hex(r));
  if (r === OK) s.eosVals.set(prop, val);
  return r;
}

// Reads the camera's news: changed settings, and new photos.
async function poll() {
  s.pollAt = Date.now();
  const { resp, data } = await s.ptp.opRead(0x9116);
  if (resp !== OK || !data.length) return;
  let off = 0;
  while (off + 8 <= data.length) {
    const size = u32(data, off), type = u32(data, off + 4);
    if (size < 8 || off + size > data.length || type === 0) break;
    const end = off + size;
    if (type === 0xC189 && size >= 16) s.eosVals.set(u32(data, off + 8) & 0xFFFF, u32(data, off + 12));   // a setting changed
    else if ((type === 0xC181 || type === 0xC1A7) && size >= 12)   // a photo was saved on the card
      s.newFiles.push([u32(data, off + 8), type, off + 0x12 <= end ? u16(data, off + 0x10) : 0, off + 0x20 <= end ? u32(data, off + 0x1C) : 0]);
    else if (type === 0xC186 && size >= 12)   // a photo waits in the camera's memory for us
      s.newFiles.push([u32(data, off + 8), type, off + 0x0E <= end ? u16(data, off + 0x0C) : 0, off + 0x18 <= end ? u32(data, off + 0x14) : 0]);
    off = end;
  }
}

async function readInfo() {
  const { resp, data } = await s.ptp.opRead(0x1001);
  if (resp !== OK || !data.length) return false;
  const rd = new Reader(data);
  rd.u16(); s.vendorExt = rd.u32(); rd.u16(); rd.str(); rd.u16();
  s.ops = rd.u16Array(); rd.u16Array(); s.props = rd.u16Array(); rd.u16Array(); rd.u16Array();
  s.maker = rd.str(); s.model = rd.str();
  s.diag = 'vendor ' + s.vendorExt + ', ' + s.ops.length + ' ops';
  log('DeviceInfo ' + s.maker + ' ' + s.model + ': ' + s.diag);
  return true;
}

// A camera left on its self-timer takes the picture 2 or 10 seconds after the shutter command, long after "Pose".
async function singleShot() {
  const dm = s.eosVals.get(0xD106);
  if (dm === undefined) return;
  const timer = dm === 0x07 || (dm >= 0x10 && dm <= 0x1F);
  if (!timer) return;
  try {
    const r = await setEos(0xD106, 0);
    log('Drive mode was a self-timer (' + dm + '): set to single shot: ' + hex(r));
    s.setupNote += r === OK ? 'Camera was on self-timer; set to single shot. ' : 'Camera is on self-timer: switch its drive mode to single shot. ';
  } catch (e) { if (e instanceof GoneError) throw e; log('Drive mode not changed: ' + e.message); }
}

async function prepare() {
  s.setupNote = ''; s.eosVals.clear(); s.newFiles = []; s.gotFrame = false;
  if (s.recoverNext) {
    s.recoverNext = false;
    try { await s.ptp.op(0x9115, 0); } catch (e) { if (e instanceof GoneError) throw e; }
    try { await s.ptp.op(0x9114, 0); } catch (e) { if (e instanceof GoneError) throw e; }
    log("Reset the camera's remote mode before connecting (the last session ended without a goodbye)");
    await sleep(600);
  }
  const r = await opRetry(0x9114, 1);   // remote mode on
  log('SetRemoteMode: ' + hex(r));
  const r2 = await opRetry(0x9115, 1);  // send events when asked
  log('SetEventMode: ' + hex(r2));
  if (r !== OK && r2 !== OK)
    throw new CamError('UNSUPPORTED The ' + s.name + " didn't accept remote control (" + hex(r) + '). Canon EOS cameras work; most PowerShot / compact cameras don’t. On an EOS: close EOS Utility, switch the camera off and on, and try again.');
  await poll();      // the first batch lists all settings
  await readInfo();  // in remote mode the camera lists more commands
  await poll();
  if (!has(0x9153)) throw new CamError('UNSUPPORTED The ' + s.name + " doesn't send live view over USB.");
  if (!has(0x910F) && !has(0x9128)) throw new CamError('UNSUPPORTED The ' + s.name + " doesn't take photos over USB.");
  s.lastShutterMs = 0;
  await singleShot();
  s.keepAt = Date.now();
}

// Every few seconds: read news (keeps the camera's list short) and keep it awake.
async function keep() {
  if (!s.pollAt || Date.now() - s.pollAt > 2000) await poll();
  if (Date.now() - s.keepAt > 20000 && has(0x911D)) { await s.ptp.op(0x911D); s.keepAt = Date.now(); }
}

async function liveOn() {
  let started = false;
  if (has(0x9151)) { const ri = await opRetry(0x9151); log('InitiateViewfinder: ' + hex(ri)); started = ri === OK; }
  if (s.eosVals.has(0xD1B1) && s.eosVals.get(0xD1B1) !== 1) await setEos(0xD1B1, 1);   // live view mode
  const r = await setEos(0xD1B0, 2);   // live view to the computer (mirror up)
  if (r !== OK && !started)
    throw new CamError('LIVEVIEW The camera refused live view (' + hex(r) + '). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M. Then try again.');
  s.live = true; s.gotFrame = false; s.liveAt = Date.now();
}

async function liveOff() {
  if (!s.live) return;
  try { await setEos(0xD1B0, 0); if (has(0x9152)) await s.ptp.op(0x9152); }
  catch (e) { if (e instanceof GoneError) throw e; }
  s.live = false;
}

// The camera ended live view by itself (after a photo, its own timeout, a sleep): start it again from the beginning.
async function restartLive() {
  log('Starting live view');
  s.live = false;
  await liveOn();
}

const jpegStart = (d) => { for (let k = 0; k + 1 < d.length && k < 4096; k++) if (d[k] === 0xFF && d[k + 1] === 0xD8) return k; return -1; };

// The live view data is a list of blocks { length, type, data }; one of them is the JPEG.
export function eosJpeg(d) {
  if (!d || d.length < 12) return null;
  let off = 0;
  while (off + 8 <= d.length) {
    const len = u32(d, off);
    if (len < 8 || off + len > d.length) break;
    if (len > 12 && d[off + 8] === 0xFF && d[off + 9] === 0xD8) return Buffer.from(d.subarray(off + 8, off + len));
    off += len;
  }
  const st = jpegStart(d);
  if (st < 0) return null;
  let e = d.length;
  for (let k = d.length - 2; k > st; k--) if (d[k] === 0xFF && d[k + 1] === 0xD9) { e = k + 2; break; }
  return Buffer.from(d.subarray(st, e));
}

async function frame() {
  if (!s.live) await liveOn();
  const t0 = Date.now();
  let last = 0, kicked = false, rearmed = false;
  while (Date.now() - t0 < 3000) {
    await keep();
    const { resp, data } = await s.ptp.opRead(0x9153, 0x00100000);
    last = resp;
    if (resp === OK) {
      const j = eosJpeg(data);
      if (j) { s.gotFrame = true; return j; }
    } else if (resp !== BUSY && resp !== NOTREADY) {
      // The camera ended live view by itself (heat, its time limit, a photo from its own button): switch it back on once.
      if (s.gotFrame && !rearmed) {
        rearmed = true;
        log('Live view was stopped by the camera (' + hex(resp) + '): switching it back on');
        try { await liveOn(); } catch (e) { if (e instanceof GoneError || e instanceof CamError) throw e; }
        await sleep(150);
        continue;
      }
      break;
    }
    // Some models leave live view after a photo or a camera timeout and then only answer "busy" or nothing: start it again, once.
    if (!kicked && Date.now() - t0 > 1200 && Date.now() - s.liveAt > 4000) { kicked = true; await restartLive(); }
    await sleep(50);
  }
  if (last !== OK && last !== BUSY && last !== NOTREADY && last !== 0)
    throw new CamError('LIVEVIEW The camera sends no live view (' + hex(last) + '). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M.');
  if (!s.gotFrame && Date.now() - s.liveAt > 9000)
    throw new CamError("LIVEVIEW The camera isn't sending live view. On the camera: Menu, Live View shoot: Enable (on the 60D / 70D it's in the red camera menu); close the menu; mode dial on P, Tv, Av or M. Then try again.");
  return null;
}

function shotError(r, res) {
  if (res === 1) return new CamError("FOCUS The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).");
  if (res === 7 || res === 3) return new CamError("CAPTURE The camera can't save the photo (result " + res + "). Check there's an SD card in the camera and it isn't full or locked.");
  if (r === BUSY || r === NOTREADY) return new CamError('CAPTURE The camera is busy (still saving the last photo?). Try again in a moment.');
  return new CamError('CAPTURE The camera refused the photo (' + hex(r) + (res !== 0 ? ', result ' + res : '') + "). Close the camera's menu, set the mode dial to P, Tv, Av or M (not video), and check the SD card.");
}

// Whole, or in 1 MB pieces (Canon's own command, then the standard one).
const download = (h, size, notes) => downloadObject(s.ptp, h, size, notes, has(0x9107) ? 0x9107 : 0x101B);

async function capture() {
  const t0 = Date.now();
  await poll();
  await singleShot();   // the operator may have turned the self-timer on since the session started
  s.newFiles = [];
  let r;
  const shutter = Date.now();
  if (has(0x9128)) {
    // Newer EOS: press the shutter all the way (it focuses, then shoots), then let go.
    r = await opRetry(0x9128, 3, 0);
    log('RemoteReleaseOn: ' + hex(r));
    if (r === OK) { try { await opRetry(0x9129, 3); } catch (e) { if (e instanceof GoneError) throw e; } }
    else {
      const h = await opRetry(0x9128, 1, 0);   // half press (focus)
      const f = h === OK ? await opRetry(0x9128, 2, 0) : h;   // full press
      try { await opRetry(0x9129, 2); await opRetry(0x9129, 1); } catch (e) { if (e instanceof GoneError) throw e; }
      log('Half / full press: ' + hex(h) + ' / ' + hex(f));
      r = f;
    }
    if (r !== OK) throw shotError(r, 0);
  } else {
    // Older EOS (60D, 7D, 550D...): one command; its answer says if it fired.
    let a = await s.ptp.opP(0x910F);
    if (a.resp === BUSY || a.resp === NOTREADY) { await sleep(400); a = await s.ptp.opP(0x910F); }
    const res = a.params.length > 0 ? a.params[0] : 0;
    log('RemoteRelease: ' + hex(a.resp) + ', result ' + res);
    if (a.resp !== OK || res !== 0) throw shotError(a.resp, res);
  }
  // Wait for the camera to say where the photo is (RAW + JPEG: two files).
  const files = [];
  const ew = Date.now();
  let firstAt = -1;
  while (Date.now() - ew < 15000) {
    await poll();
    for (const o of s.newFiles) if (o[2] !== 0x3001) files.push(o);   // not folders
    s.newFiles = [];
    if (files.length > 0 && firstAt < 0) { firstAt = Date.now() - ew; s.lastShutterMs = Math.min(Date.now() - shutter, 10000); log('Shutter lag ' + s.lastShutterMs + ' ms'); }
    if (firstAt >= 0 && Date.now() - ew - firstAt > 350) break;
    await sleep(80);
  }
  if (files.length === 0)
    throw new CamError("FOCUS The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.");
  const notes = ['files ' + files.map((o) => o[0].toString(16).toUpperCase() + '/' + o[2].toString(16).toUpperCase()).join(',')];
  // JPEG first, then anything else that isn't RAW (CRW / CR2 / CR3).
  const order = files.filter((o) => o[2] === 0x3801).concat(files.filter((o) => o[2] !== 0x3801 && o[2] !== 0xB101 && o[2] !== 0xB103 && o[2] !== 0xB108));
  let img = null;
  try {
    for (const o of order) {
      const b = await download(o[0], o[3], notes);
      if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) { img = b; break; }
    }
  } finally {
    // Photos waiting in the camera's memory: tell it we're done so it frees them.
    for (const o of files) if (o[1] === 0xC186) { try { await s.ptp.op(0x9117, o[0]); } catch (e) { if (e instanceof GoneError) throw e; } }
  }
  log('Photo download: ' + notes.join('; '));
  if (!img) {
    if (order.length === 0) throw new CamError('CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).');
    throw new CamError("CAPTURE The photo didn't come through from the camera (" + notes.join('; ') + ').');
  }
  log('Photo ' + Math.round(img.length / 1024) + ' KB in ' + (Date.now() - t0) + ' ms');
  return img;
}

// ---------- opening / closing ----------
async function closeCamera() {
  const p = s.ptp;
  if (p) {
    if (s.drv) {
      try { await s.drv.close(); } catch { /* ignore */ }
    } else {
      // Hand the camera back: live view off, out of remote mode.
      try { if (s.live) await setEos(0xD1B0, 0); await p.op(0x9115, 0); await p.op(0x9114, 0); } catch { /* ignore */ }
    }
    try { await p.closeSession(); } catch { /* ignore */ }
    await p.close();
  }
  s.ptp = null; s.entry = null; s.live = false; s.ops = []; s.props = []; s.drv = null; s.brand = 'canon'; s.battery = -1;
}

const infoJson = () => JSON.stringify({ name: s.name, model: s.model, maker: s.maker, brand: s.brand, vendor: s.vendorExt, liveview: s.drv ? s.drv.live : s.live, battery: s.battery, note: s.setupNote, diag: s.diag });

async function alive() {
  if (s.drv) { await s.drv.alive(); return; }
  if (has(0x911D)) { await s.ptp.op(0x911D); return; }
  await s.ptp.opRead(0x1001);
}

async function open(recover) {
  if (s.ptp) { try { await alive(); return infoJson(); } catch { /* reconnect below */ } await closeCamera(); }
  const cams = backend.list().filter((e) => BRANDS.has(e.vendor));
  if (!cams.length) throw new CamError('NOCAMERA No Canon, Nikon or Sony camera found on USB. Plug the camera into this Mac with a data USB cable (not charge-only) and switch it on. Canon: Photo Import / Remote Control. Nikon: PTP or MTP. Sony: PC Remote.');
  await backend.free();
  s.recoverNext = !!recover;
  let lastErr = null;
  for (const entry of cams) {
    let p = null;
    try {
      p = await backend.open(entry, { onBusy: () => backend.free() });
      s.ptp = p; s.entry = entry; s.brand = BRANDS.get(entry.vendor);
      await p.openSession();
      if (!(await readInfo())) { await closeCamera(); continue; }
      if (entry.vendor === CANON) {
        s.name = 'Canon ' + s.model.replace(/Canon/i, '').trim();
        log('Opened ' + s.name);
        await prepare();
      } else {
        s.name = entry.vendor === SONY ? sonyName(s.model) : 'Nikon ' + s.model.replace(/nikon/gi, '').trim();
        log('Opened ' + s.name);
        s.setupNote = '';
        const ctx = { ptp: p, ops: s.ops, props: s.props, name: s.name, log, note: (t) => { s.setupNote += t; }, diag: () => s.diag, addDiag: (t) => { s.diag += '; ' + t; } };
        s.drv = entry.vendor === SONY ? createSony(ctx) : createNikon(ctx);
        await s.drv.prepare();
        s.battery = await s.drv.battery();
      }
      return infoJson();
    } catch (e) {
      lastErr = e;
      log('Skipped a camera: ' + (e && e.message));
      if (s.ptp === p) await closeCamera(); else if (p) await p.close();
    }
  }
  if (lastErr instanceof GoneError) throw new CamError('NOCAMERA The camera disconnected while connecting. Check the USB cable, switch the camera off and on, and try again.');
  if (lastErr instanceof CamError) throw lastErr;
  throw new CamError('DRIVER The camera did not answer (' + (lastErr && lastErr.message) + '). Quit Photos, Image Capture, EOS Utility and Imaging Edge, switch the camera off and on, unplug and replug it, and try again.');
}

function listJson() {
  const devs = backend.list().map((e) => (BRANDS.has(e.vendor)
    ? { name: MAKERS.get(e.vendor) + ' camera', maker: MAKERS.get(e.vendor), camera: true }
    : { name: 'USB camera ' + e.vendor.toString(16) + ':' + e.product.toString(16), maker: '', camera: false }));
  return JSON.stringify({ devices: devs, open: !!s.ptp, name: s.ptp ? s.name : '', shutterMs: s.lastShutterMs });
}

const reply = (status, kind, body) => ({ status, kind, body: Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8') });

const diagJson = () => JSON.stringify({
  lines: logBuf.slice(-40),
  usb: (backend.all ? backend.all() : []).map((d) => ({ id: d.vendor.toString(16).padStart(4, '0') + ':' + d.product.toString(16).padStart(4, '0'), classes: d.classes || [] })),
  ptp: backend.list().map((e) => ({ id: e.vendor.toString(16).padStart(4, '0') + ':' + e.product.toString(16).padStart(4, '0'), canon: e.vendor === CANON, camera: BRANDS.has(e.vendor), brand: BRANDS.get(e.vendor) || '' })),
  open: !!s.ptp, name: s.ptp ? s.name : ''
});

export function isOpen() { return !!s.ptp; }
export async function reset() { try { await closeCamera(); } catch { /* ignore */ } }

// The same commands the Windows worker answers.
export async function call(cmd, arg) {
  try {
    if (cmd === 'ping') return reply('OK', 'J', '{"ok":true}');
    if (cmd === 'list') return reply('OK', 'J', listJson());
    if (cmd === 'diag') return reply('OK', 'J', diagJson());
    if (cmd === 'open') return reply('OK', 'J', await open(arg === 'recover'));
    if (!s.ptp) throw new GoneError('NOCAMERA The camera isn’t connected.');
    if (cmd === 'info') return reply('OK', 'J', infoJson());
    if (cmd === 'battery') { if (s.drv) s.battery = await s.drv.battery(); return reply('OK', 'J', JSON.stringify({ battery: s.battery })); }
    if (cmd === 'af') {
      if (s.drv && typeof s.drv.af === 'function') await s.drv.af();
      else if (s.brand === 'canon') {
        try {
          await opRetry(0x9128, 1, 0);
          await sleep(800);
          await opRetry(0x9129, 1);
        } catch (e) { }
      }
      return reply('OK', 'J', JSON.stringify({ ok: true }));
    }
    if (cmd === 'live') {
      if (s.drv) { if (arg === 'off') await s.drv.liveOff(); else await s.drv.liveOn(); }
      else if (arg === 'off') await liveOff(); else await restartLive();   // "on" is also how the booth asks for live view again when frames stopped
      return reply('OK', 'N', '');
    }
    if (cmd === 'frame') { const f = s.drv ? await s.drv.frame() : await frame(); return f ? reply('OK', 'B', f) : reply('OK', 'N', ''); }
    if (cmd === 'capture') {
      if (s.drv) { const img = await s.drv.capture(); s.lastShutterMs = s.drv.lastShutterMs || s.lastShutterMs; return reply('OK', 'B', img); }
      try { return reply('OK', 'B', await capture()); }
      finally { s.live = false; }     // a Canon often leaves live view after a photo: the next frame request starts it again
    }
    if (cmd === 'close') { await closeCamera(); return reply('OK', 'N', ''); }
    throw new CamError('BAD Unknown command ' + cmd);
  } catch (e) {
    if (e instanceof GoneError) { log('Camera lost: ' + e.message); await closeCamera(); return reply('GONE', 'N', e.message.startsWith('NOCAMERA') ? e.message : 'NOCAMERA ' + e.message); }
    if (e instanceof CamError) return reply('ERR', 'N', e.message);
    if (e instanceof TimeoutError) {
      // A camera that stopped answering: is it still there?
      let ok = false;
      if (s.ptp) { try { await Promise.race([alive(), sleep(4000).then(() => { throw new Error('t'); })]); ok = true; } catch { /* gone or stuck */ } }
      if (!ok) { await closeCamera(); return reply('GONE', 'N', 'NOCAMERA The camera stopped answering. Switch it off and on, check the USB cable, and try again.'); }
      return reply('ERR', 'N', 'CAPTURE ' + e.message);
    }
    return reply('ERR', 'N', 'ERROR ' + (e && e.message || e));
  }
}
