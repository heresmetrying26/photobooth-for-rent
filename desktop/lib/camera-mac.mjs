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
import { ptpObjectMeta, isStillOrRaw, streamObjectToFile, canonExposureJson, canonSetExposure } from './cam-movie.mjs';

const NOTREADY = 0xA102;                 // Canon: "not ready yet, ask again"
const EOS_AVAIL_SHOTS = 0xD11B;
const EOS_SAVETO = 0xD11C;
const EOS_MULTI_ASPECT = 0xD194;         // 0 = 3:2 (native full sensor), 1 = 1:1, 2 = 4:3, 3/7 = 16:9
const SAVETO_CARD = 2, SAVETO_HOST = 4;
const CANON = 0x04a9, NIKON = 0x04b0, SONY = 0x054c;   // USB vendor ids
const BRANDS = new Map([[CANON, 'canon'], [NIKON, 'nikon'], [SONY, 'sony']]);
const MAKERS = new Map([[CANON, 'Canon'], [NIKON, 'Nikon'], [SONY, 'Sony']]);

// What talks to the hardware; tests replace it with a fake camera.
const realBackend = {
  list: () => listPtpDevices(),
  all: () => listAllUsb(),
  open: (entry, opts) => openUsbPtp(entry, opts),
  free: async () => { if (process.platform === 'darwin') { await freeCamera({ quiet: true }); guardCamera(12000); } }
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
  eosVals: new Map(), eosAvail: new Map(), newFiles: [], pollAt: 0, keepAt: 0, liveAt: 0, liveOffAt: 0, lastShutterMs: 0, recoverNext: false,
  toHost: false, hostGaveUp: false, hostWorked: false, destOrig: SAVETO_CARD, lastPollEvents: 0,
  aspectChanged: false, aspectCrop: false, aspectOrig: 0, movieRec: false, movieRestoredHost: false
};

const has = (op) => s.ops.includes(op);
const u32 = (b, i) => b.readUInt32LE(i);
const u16 = (b, i) => b.readUInt16LE(i);
const canonLensMf = () => s.brand === 'canon' && s.eosVals.get(0xD108) === 3;
function canonIsDslr() {
  if (s.brand !== 'canon') return false;
  const m = ((s.name || '') + ' ' + (s.model || '')).toUpperCase();
  if (!m.includes('EOS')) return false;
  return !/\bEOS (R\d*|RP|RA|M\d*)\b/.test(m);
}
// Canon EOS 1500D / 2000D / Rebel T7 / Kiss X90: keep SD card backup (SaveTo=Card), keep Live View on both
// camera rear LCD and PC (0xD1B0=3 TFT+PC), and do not drop Live View before each shot — restoring pre-1.1.90
// behavior without affecting Canon 60D / 6D / other EOS bodies.
function canonKeepCardAndLcd() {
  if (s.brand !== 'canon') return false;
  const m = ((s.name || '') + ' ' + (s.model || '')).toUpperCase();
  return /\b(1500D|2000D|REBEL\s*T7|KISS\s*X90)\b/.test(m);
}

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
  s.lastPollEvents = 0;
  const { resp, data } = await s.ptp.opRead(0x9116);
  if (resp !== OK || !data.length) return;
  let off = 0;
  while (off + 8 <= data.length) {
    const size = u32(data, off), type = u32(data, off + 4);
    if (size < 8 || off + size > data.length || type === 0) break;
    const end = off + size;
    s.lastPollEvents++;
    if (type === 0xC189 && size >= 16) s.eosVals.set(u32(data, off + 8) & 0xFFFF, u32(data, off + 12));   // a setting changed
    else if (type === 0xC18A && size >= 20) {
      const prop = u32(data, off + 8) & 0xFFFF;
      if (prop === EOS_SAVETO || prop === 0xD101 || prop === 0xD102 || prop === 0xD103 || prop === 0xD109 || prop === 0xD1B8) {
        const cnt = u32(data, off + 16), room = size - 20;
        if (cnt > 0 && cnt <= 128 && room > 0 && room % cnt === 0) {
          const es = room / cnt;
          if (es === 1 || es === 2 || es === 4) {
            const vals = [];
            for (let k = 0; k < cnt; k++) {
              const p = off + 20 + k * es;
              vals.push(es === 4 ? u32(data, p) : es === 2 ? u16(data, p) : data[p]);
            }
            s.eosAvail.set(prop, vals);
          }
        }
      }
    }
    else if ((type === 0xC181 || type === 0xC1A7) && size >= 12)   // a photo was saved on the card
      s.newFiles.push([u32(data, off + 8), type, off + 0x12 <= end ? u16(data, off + 0x10) : 0, off + 0x20 <= end ? (u32(data, off + 0x1C) > 0x10000000 ? 0 : u32(data, off + 0x1C)) : 0]);
    else if ((type === 0xC186 || type === 0xC1A9 || type === 0xC1B8) && size >= 12)   // a photo waits in the camera's memory for us
      s.newFiles.push([u32(data, off + 8), type, off + 0x0E <= end ? u16(data, off + 0x0C) : 0, off + 0x18 <= end ? (u32(data, off + 0x14) > 0x10000000 ? 0 : u32(data, off + 0x14)) : 0]);
    off = end;
  }
}

async function canonSendCapacity() {
  if (s.ops.length > 0 && !has(0x911A)) return false;
  const r = await opRetry(0x911A, 0x0FFFFFFF, 0x00001000, 1);
  log('PCHDDCapacity (0x911A): ' + hex(r));
  return r === OK || r === BUSY;
}

async function canonToHost() {
  s.toHost = false;
  if (canonKeepCardAndLcd()) {
    if (s.eosVals.get(EOS_SAVETO) === SAVETO_HOST) {
      const avCard = s.eosAvail.get(EOS_SAVETO);
      const cardVal = avCard && !avCard.includes(SAVETO_CARD) && avCard.includes(1) ? 1 : SAVETO_CARD;
      try { await setEos(EOS_SAVETO, cardVal); await poll(); } catch (e) { if (e instanceof GoneError) throw e; }
      log('Save to: restored SD card (' + cardVal + ') for ' + s.name);
    } else {
      log('Save to: keeping SD card backup for ' + s.name);
    }
    return;
  }
  if (s.hostGaveUp) return;
  if (!s.eosVals.has(EOS_SAVETO)) return;
  if (s.ops.length > 0 && !has(0x911A)) return;
  const cur = s.eosVals.get(EOS_SAVETO);
  const av = s.eosAvail.get(EOS_SAVETO);
  const hadAvail = s.eosVals.has(EOS_AVAIL_SHOTS);
  if (cur === SAVETO_HOST) {
    s.destOrig = av && !av.includes(SAVETO_CARD) && av.includes(1) ? 1 : SAVETO_CARD;
    if (!(await canonSendCapacity())) { s.hostGaveUp = true; try { await setEos(EOS_SAVETO, s.destOrig); } catch { } return; }
    if (hadAvail) {
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { await poll(); if ((s.eosVals.get(EOS_AVAIL_SHOTS) || 0) > 0) break; await sleep(60); }
      if ((s.eosVals.get(EOS_AVAIL_SHOTS) || 0) === 0) { s.hostGaveUp = true; try { await setEos(EOS_SAVETO, s.destOrig); } catch { } return; }
    }
    s.toHost = true;
    return;
  }
  if (av && !av.includes(SAVETO_HOST)) return;
  const r = await setEos(EOS_SAVETO, SAVETO_HOST);
  if (r !== OK) { s.eosVals.set(EOS_SAVETO, cur); return; }
  if (!(await canonSendCapacity())) { s.hostGaveUp = true; try { await setEos(EOS_SAVETO, cur); } catch { } return; }
  await poll();
  if (s.eosVals.get(EOS_SAVETO) !== SAVETO_HOST) return;
  if (hadAvail) {
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { if ((s.eosVals.get(EOS_AVAIL_SHOTS) || 0) > 0) break; await sleep(60); await poll(); }
    if ((s.eosVals.get(EOS_AVAIL_SHOTS) || 0) === 0) { s.hostGaveUp = true; try { await setEos(EOS_SAVETO, cur); } catch { } return; }
  }
  s.destOrig = cur;
  s.toHost = true;
  log('Save to: the computer (was ' + cur + ')');
}

async function canonToCard(giveUp) {
  if (giveUp) s.hostGaveUp = true;
  if (!s.toHost) return;
  s.toHost = false;
  try { await setEos(EOS_SAVETO, s.destOrig); } catch (e) { if (e instanceof GoneError) throw e; }
}

// EOS battery arrives as property 0xD111 in the event stream: quarter steps (1=Low 6=25% 2=50% 5=75% 3=100%) on most bodies, a percent on some.
async function canonBattery() {
  try { if (Date.now() - s.pollAt > 2000) await poll(); } catch (e) { if (e instanceof GoneError) throw e; }
  const v = s.eosVals.get(0xD111);
  if (v === undefined) return -1;
  const map = { 1: 10, 6: 25, 2: 50, 5: 75, 3: 100 };
  if (map[v] !== undefined) return map[v];
  return v >= 7 && v <= 100 ? v : -1;
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

// Canon EOS USB Live View (0x9153) always sends the full uncropped 3:2 frame, while Aspect ratio (0xD194) crops still JPEGs.
// Switch to 3:2 (0) for the booth session and restore on closeCamera().
async function canonAspect32() {
  const ar = s.eosVals.get(EOS_MULTI_ASPECT);
  if (ar === undefined || ar === 0) { s.aspectCrop = false; return; }
  try {
    const r = await setEos(EOS_MULTI_ASPECT, 0);
    if (r === OK) await poll();
    const now = s.eosVals.get(EOS_MULTI_ASPECT);
    const ok = r === OK && (now === undefined || now === 0);
    log('Aspect ratio was ' + ar + ': set to 3:2 (0): ' + hex(r) + (ok ? '' : ' (kept ' + now + ')'));
    if (ok) {
      if (!s.aspectChanged) { s.aspectOrig = ar; s.aspectChanged = true; }
      s.aspectCrop = false;
      s.setupNote += 'Camera aspect ratio was cropped; set to 3:2. ';
    } else {
      s.aspectCrop = true;
      s.setupNote += 'Camera aspect ratio is not 3:2: set Aspect ratio to 3:2 on the camera. ';
    }
  } catch (e) { if (e instanceof GoneError) throw e; s.aspectCrop = true; log('Aspect ratio not changed: ' + e.message); }
}

async function canonRestoreAspect() {
  if (!s.aspectChanged) return;
  s.aspectChanged = false;
  try { const r = await setEos(EOS_MULTI_ASPECT, s.aspectOrig); log('Aspect ratio: restored to ' + s.aspectOrig + ': ' + hex(r)); }
  catch (e) { if (e instanceof GoneError) throw e; }
}

async function prepare() {
  s.setupNote = ''; s.eosVals.clear(); s.eosAvail.clear(); s.newFiles = []; s.gotFrame = false;
  s.toHost = false; s.hostWorked = false; s.liveOffAt = 0; s.aspectChanged = false; s.aspectCrop = false; s.aspectOrig = 0;
  s.movieRec = false; s.movieRestoredHost = false;
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
  await canonAspect32();
  try { await canonToHost(); } catch (e) { if (e instanceof GoneError) throw e; log('Save to host not set: ' + e.message); }
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
  const targetOut = canonKeepCardAndLcd() ? 3 : 2;   // 3 = TFT + PC (rear LCD + laptop), 2 = PC only
  let r = await setEos(0xD1B0, targetOut);   // live view to the computer (mirror up)
  // Only fall back to PC-only (2) if TFT+PC (3) was genuinely refused — never on transient BUSY/NOTREADY.
  if (r !== OK && r !== BUSY && r !== NOTREADY && targetOut === 3) {
    log('Live view TFT+PC (0xD1B0=3) refused (' + hex(r) + '): falling back to PC-only (2)');
    r = await setEos(0xD1B0, 2);
  }
  if (r !== OK && !started)
    throw new CamError('LIVEVIEW The camera refused live view (' + hex(r) + '). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M. Then try again.');
  s.live = true; s.gotFrame = false; s.liveAt = Date.now(); s.liveOffAt = 0;
}

async function liveOff() {
  const outOn = (s.eosVals.get(0xD1B0) || 0) !== 0;
  if (!s.live && !outOn) return;
  try { await setEos(0xD1B0, 0); if (has(0x9152)) await s.ptp.op(0x9152); }
  catch (e) { if (e instanceof GoneError) throw e; }
  s.live = false; s.liveOffAt = Date.now();
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

// Whole, or in 1 MB pieces. For RAM / host objects (0xC186 / 0xC1A9 / 0xC1B8), download directly in 1 MB chunks via 0x101B (libgphoto2).
async function download(h, size, notes, ramPhoto = false) {
  if (ramPhoto && size > 0) {
    for (const piece of has(0x9107) ? [0x101B, 0x9107] : [0x101B]) {
      const parts = [];
      let off = 0, pr = 0;
      try {
        while (off < size) {
          const g = await s.ptp.opRead(piece, h, off, Math.min(1048576, size - off));
          pr = g.resp;
          if (pr !== OK || g.data.length === 0) break;
          parts.push(g.data); off += g.data.length;
        }
      } catch (e) { if (e instanceof GoneError) throw e; pr = 0; }
      notes.push('pieces ' + hex(piece) + ' ' + hex(pr) + ' ' + off + ' B');
      if (pr === OK && off >= size) return Buffer.concat(parts);
    }
  }
  return downloadObject(s.ptp, h, size, notes, has(0x9107) ? 0x9107 : 0x101B);
}

async function canonHalfFull(lensMf, skipAf, lvStillOn = false) {
  let afFlag = (skipAf && !lensMf) ? 1 : 0;
  let h = await opRetry(0x9128, 1, afFlag);
  if (h !== OK && afFlag === 1) { afFlag = 0; h = await opRetry(0x9128, 1, 0); }
  if (h === OK) {
    const fast = lensMf || afFlag === 1;
    const t0 = Date.now(), maxWait = fast ? 80 : (lvStillOn ? 550 : 350);
    while (Date.now() - t0 < maxWait) {
      await poll();
      if (fast && s.lastPollEvents > 0) break;
      await sleep(40);
    }
  }
  let f = h === OK ? await opRetry(0x9128, 2, afFlag) : h;
  if (f !== OK && afFlag === 1) f = await opRetry(0x9128, 2, 0);
  try { await opRetry(0x9129, 2); await poll(); await opRetry(0x9129, 1); } catch (e) { if (e instanceof GoneError) throw e; }
  log('Half / full press (mf=' + (lensMf ? '1' : '0') + ' af=' + afFlag + '): ' + hex(h) + ' / ' + hex(f));
  return f;
}

async function capture() {
  const t0 = Date.now();
  await poll();
  await singleShot();   // the operator may have turned the self-timer on since the session started
  if (!s.aspectCrop) await canonAspect32();
  if (s.toHost && (s.eosVals.get(EOS_AVAIL_SHOTS) === undefined || s.eosVals.get(EOS_AVAIL_SHOTS) < 100)) {
    await canonSendCapacity();
    await poll();
  }
  const isDslr = canonIsDslr();
  const dropLvForShot = isDslr && !canonKeepCardAndLcd();
  if (dropLvForShot) {
    let turnedOffHere = false;
    if (s.live || (s.eosVals.get(0xD1B0) || 0) !== 0) {
      log('DSLR capture: ending live view before shutter (mechanical flash sync)');
      await liveOff();
      turnedOffHere = true;
    }
    const maxSettle = turnedOffHere ? 500 : 350;
    const minSettle = turnedOffHere ? 320 : 220;
    while (s.liveOffAt && Date.now() - s.liveOffAt < maxSettle) {
      await poll();
      if ((s.eosVals.get(0xD1B0) || 0) === 0 && Date.now() - s.liveOffAt >= minSettle) break;
      await sleep(40);
    }
  }
  s.newFiles = [];
  let r;
  const shutter = Date.now();
  const lensMf = canonLensMf();
  if (has(0x9128)) {
    if (isDslr) {
      r = await canonHalfFull(lensMf, false, !dropLvForShot);
    } else {
      r = await opRetry(0x9128, 3, lensMf ? 1 : 0);
      log('RemoteReleaseOn: ' + hex(r));
      if (r === OK) { await sleep(80); await poll(); try { await opRetry(0x9129, 3); } catch (e) { if (e instanceof GoneError) throw e; } }
      else r = await canonHalfFull(lensMf, false, !dropLvForShot);
    }
    if (r !== OK) throw shotError(r, 0);
  } else {
    // Older EOS without 0x9128: one command; its answer says if it fired.
    let a = await s.ptp.opP(0x910F);
    if (a.resp === BUSY || a.resp === NOTREADY) { await sleep(400); a = await s.ptp.opP(0x910F); }
    const res = a.params.length > 0 ? a.params[0] : 0;
    log('RemoteRelease: ' + hex(a.resp) + ', result ' + res);
    if (a.resp !== OK || res !== 0) throw shotError(a.resp, res);
  }
  // Wait for the camera to say where the photo is (RAW + JPEG: two files).
  const files = [];
  let ew = Date.now();
  let firstAt = -1;
  const maxTry = has(0x9128) ? 2 : 1;
  for (let attempt = 0; attempt <= maxTry; attempt++) {
    const limit = s.toHost ? 4500 : (attempt === 0 ? 6000 : 7000);
    while (Date.now() - ew < limit) {
      await poll();
      for (const o of s.newFiles) if (o[2] !== 0x3001) files.push(o);   // not folders
      s.newFiles = [];
      if (files.length > 0 && firstAt < 0) { firstAt = Date.now() - ew; if (attempt === 0) { s.lastShutterMs = Math.min(Date.now() - shutter, 10000); log('Shutter lag ' + s.lastShutterMs + ' ms'); } }
      const hasJpeg = files.some((o) => o[2] === 0x3801);
      if (firstAt >= 0 && Date.now() - ew - firstAt > (hasJpeg ? 120 : 220)) break;
      await sleep(50);
    }
    if (files.length > 0 || attempt >= maxTry) break;
    if (s.live) { await liveOff(); await sleep(300); }
    if (isDslr && attempt === 1 && has(0x910F)) {
      let a2 = await s.ptp.opP(0x910F);
      if (a2.resp === BUSY || a2.resp === NOTREADY) { await sleep(400); a2 = await s.ptp.opP(0x910F); }
      const res2 = a2.params.length > 0 ? a2.params[0] : 0;
      if (a2.resp === OK && (res2 === 7 || res2 === 8)) throw shotError(a2.resp, res2);
    } else if (has(0x9128)) {
      if (isDslr) await canonHalfFull(lensMf, true);
      else { const r2 = await opRetry(0x9128, 3, 1); if (r2 === OK) { await sleep(80); await poll(); try { await opRetry(0x9129, 3); } catch { } } }
    } else {
      await s.ptp.opP(0x910F);
    }
    ew = Date.now();
  }
  if (files.length === 0) {
    if (s.toHost && !s.hostWorked) await canonToCard(true);
    throw new CamError("FOCUS The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.");
  }
  const ramPhoto = files.some((o) => o[1] === 0xC186 || o[1] === 0xC1A9 || o[1] === 0xC1B8);
  const cardPhoto = files.some((o) => o[1] !== 0xC186 && o[1] !== 0xC1A9 && o[1] !== 0xC1B8);
  if (s.toHost && !ramPhoto && cardPhoto) await canonToCard(true);
  const notes = [(ramPhoto ? 'sent to computer ' : 'on card ') + 'files ' + files.map((o) => o[0].toString(16).toUpperCase() + '/' + o[2].toString(16).toUpperCase()).join(',')];
  // JPEG first, then anything else that isn't RAW (CRW / CR2 / CR3).
  const order = files.filter((o) => o[2] === 0x3801).concat(files.filter((o) => o[2] !== 0x3801 && o[2] !== 0xB101 && o[2] !== 0xB103 && o[2] !== 0xB108));
  let img = null, downloadedHandle = 0;
  try {
    for (const o of order) {
      const isRam = o[1] === 0xC186 || o[1] === 0xC1A9 || o[1] === 0xC1B8;
      const b = await download(o[0], o[3], notes, isRam);
      if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) { img = b; downloadedHandle = o[0]; break; }
    }
  } finally {
    // Photos waiting in the camera's memory: tell it we're done so it frees them.
    for (const o of files) {
      if (o[1] === 0xC186 || o[1] === 0xC1A9 || o[1] === 0xC1B8) {
        try { await opRetry(o[0] !== downloadedHandle && has(0x9118) ? 0x9118 : 0x9117, o[0]); }
        catch (e) { if (e instanceof GoneError) throw e; }
      }
    }
  }
  log('Photo download: ' + notes.join('; '));
  if (!img) {
    if (ramPhoto && s.toHost && !s.hostWorked) await canonToCard(true);
    if (order.length === 0) throw new CamError('CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).');
    throw new CamError("CAPTURE The photo didn't come through from the camera (" + notes.join('; ') + ').');
  }
  if (ramPhoto && s.toHost) s.hostWorked = true;
  log('Photo ' + Math.round(img.length / 1024) + ' KB in ' + (Date.now() - t0) + ' ms');
  return img;
}

async function canonMovieStart() {
  if (s.movieRec) return JSON.stringify({ ok: true, brand: 'canon', recording: true });
  s.movieRestoredHost = false;
  try { await poll(); } catch (e) { if (e instanceof GoneError) throw e; }
  const curSaveto = s.eosVals.get(EOS_SAVETO);
  if (s.toHost || curSaveto === SAVETO_HOST) {
    await canonToCard(false);
    s.movieRestoredHost = true;
    try { await poll(); } catch (e) { if (e instanceof GoneError) throw e; }
  }
  s.newFiles = [];
  let r = await setEos(0xD1B8, 4);
  if (r !== OK) {
    if (!s.live) {
      try { await restartLive(); await sleep(300); } catch (e) { if (e instanceof GoneError) throw e; }
      try { await poll(); } catch (e) { if (e instanceof GoneError) throw e; }
    }
    r = await setEos(0xD1B8, 4);
  }
  if (r !== OK) {
    if (s.movieRestoredHost) { s.movieRestoredHost = false; try { await canonToHost(); } catch (e) { if (e instanceof GoneError) throw e; } }
    throw new CamError("CAPTURE The Canon camera didn't start movie recording (" + hex(r) + '). Turn the mode dial to Movie (video camera icon), insert a formatted SD card with free space, and close any open camera menu.');
  }
  s.movieRec = true;
  log('Canon movie recording started');
  return JSON.stringify({ ok: true, brand: 'canon', recording: true });
}

async function canonMovieStop(outDir) {
  const t0 = Date.now();
  try {
    try {
      let r = await setEos(0xD1B8, 0);
      if (r === BUSY || r === NOTREADY) { await sleep(250); await setEos(0xD1B8, 0); }
    } finally { s.movieRec = false; }

    let pickHandle = 0, pickSize = 0, pickExt = '.mov';
    const ew = Date.now();
    while (Date.now() - ew < 15000) {
      await poll();
      if (s.newFiles.length > 0) {
        await sleep(250);
        await poll();
        let bestHandle = 0, bestSize = 0, bestExt = '.mov';
        for (const o of s.newFiles) {
          const meta = await ptpObjectMeta(s.ptp, o[0]);
          const fmt = meta.fmt || o[2];
          const sz = meta.size || o[3];
          const ext = meta.ext || (fmt === 0xB982 ? '.mp4' : fmt === 0x300B ? '.avi' : '.mov');
          if (isStillOrRaw(fmt, meta.ext)) continue;
          if (!bestHandle || sz > bestSize) { bestHandle = o[0]; bestSize = sz; bestExt = ext; }
        }
        if (bestHandle) { pickHandle = bestHandle; pickSize = bestSize; pickExt = bestExt; break; }
      }
      await sleep(100);
    }
    if (!pickHandle) {
      throw new CamError('CAPTURE The camera stopped recording, but no movie file appeared from the camera. Make sure an SD card with free space is inserted.');
    }
    const res = await streamObjectToFile(s.ptp, pickHandle, pickSize, pickExt, outDir, 'canon-360-', { canonPiece: has(0x9107) });
    log('Canon movie downloaded: ' + res.filename + ' (' + Math.round(res.bytes / 1024) + ' KB) in ' + (Date.now() - t0) + ' ms');
    return JSON.stringify({ ok: true, brand: 'canon', path: res.path, filename: res.filename, bytes: res.bytes, format: res.format });
  } finally {
    if (s.movieRestoredHost) {
      s.movieRestoredHost = false;
      try { await canonToHost(); } catch (e) { if (e instanceof GoneError) throw e; }
    }
  }
}

// ---------- opening / closing ----------
async function closeCamera() {
  const p = s.ptp;
  if (p) {
    if (s.drv) {
      try { await s.drv.close(); } catch { /* ignore */ }
    } else {
      // Hand the camera back: stop active movie recording, photos on card again, aspect ratio restored, live view off, out of remote mode.
      try { if (s.movieRec) { await setEos(0xD1B8, 0); s.movieRec = false; } } catch { /* ignore */ }
      try { await canonToCard(false); } catch { /* ignore */ }
      try { await canonRestoreAspect(); } catch { /* ignore */ }
      try { if (s.live) await setEos(0xD1B0, 0); await p.op(0x9115, 0); await p.op(0x9114, 0); } catch { /* ignore */ }
    }
    try { await p.closeSession(); } catch { /* ignore */ }
    await p.close();
  }
  s.ptp = null; s.entry = null; s.live = false; s.liveOffAt = 0; s.ops = []; s.props = []; s.drv = null; s.brand = 'canon'; s.battery = -1;
  s.toHost = false; s.hostGaveUp = false; s.hostWorked = false; s.aspectChanged = false; s.aspectCrop = false; s.aspectOrig = 0;
  s.movieRec = false; s.movieRestoredHost = false;
}

const infoJson = () => {
  const cn = s.brand === 'canon' && !s.drv;
  const mf = cn && canonLensMf();
  const older = cn && !has(0x9128);
  const dslr = cn && canonIsDslr();
  const keepLive = cn && canonKeepCardAndLcd();
  return JSON.stringify({
    name: s.name, model: s.model, maker: s.maker, brand: s.brand, vendor: s.vendorExt,
    liveview: s.drv ? s.drv.live : s.live, battery: s.battery, note: s.setupNote, diag: s.diag,
    shutterMs: s.lastShutterMs, preFocus: !cn || has(0x9128), olderCanon: older, lensMf: mf, canonDslr: dslr, canonKeepLive: keepLive,
    saveTo: cn ? (s.toHost ? 'host' : 'card') : '', toCard: cn && !s.toHost && !keepLive, aspectCrop: cn && s.aspectCrop
  });
};

async function alive() {
  if (s.drv) { await s.drv.alive(); return; }
  if (has(0x911D)) { await s.ptp.op(0x911D); return; }
  await s.ptp.opRead(0x1001);
}

async function open(recover) {
  if (s.ptp) { try { await alive(); return infoJson(); } catch { /* reconnect below */ } await closeCamera(); }
  const cams = backend.list().filter((e) => BRANDS.has(e.vendor));
  if (!cams.length) throw new CamError('NOCAMERA No Canon, Nikon or Sony camera found on USB. Plug the camera into this ' + (process.platform === 'win32' ? 'PC' : 'Mac') + ' with a data USB cable (not charge-only) and switch it on. Canon: Photo Import / Remote Control. Nikon: PTP or MTP. Sony: PC Remote.');
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
        s.battery = await canonBattery();
      } else {
        s.name = entry.vendor === SONY ? sonyName(s.model) : 'Nikon ' + s.model.replace(/nikon/gi, '').trim();
        log('Opened ' + s.name);
        s.setupNote = '';
        const ctx = { ptp: p, ops: s.ops, props: s.props, name: s.name, model: s.model, product: entry.product, log, note: (t) => { s.setupNote += t; }, diag: () => s.diag, addDiag: (t) => { s.diag += '; ' + t; } };
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
  throw new CamError('DRIVER The camera did not answer (' + (lastErr && lastErr.message) + '). ' + (process.platform === 'win32' ? 'Close EOS Utility and Imaging Edge' : 'Quit Photos, Image Capture, EOS Utility and Imaging Edge') + ', switch the camera off and on, unplug and replug it, and try again.');
}

async function listJson() {
  if (s.ptp) {
    try { await alive(); }
    catch { log('Camera lost'); await closeCamera(); }
  }
  const devs = backend.list().map((e) => (BRANDS.has(e.vendor)
    ? { name: MAKERS.get(e.vendor) + ' camera', maker: MAKERS.get(e.vendor), camera: true }
    : { name: 'USB camera ' + e.vendor.toString(16) + ':' + e.product.toString(16), maker: '', camera: false }));
  const cn = !!s.ptp && s.brand === 'canon' && !s.drv;
  const mf = cn && canonLensMf();
  const keepLive = cn && canonKeepCardAndLcd();
  return JSON.stringify({
    devices: devs, open: !!s.ptp, name: s.ptp ? s.name : '', shutterMs: s.lastShutterMs,
    toCard: cn && !s.toHost && !keepLive, olderCanon: cn && !has(0x9128), lensMf: mf, canonDslr: cn && canonIsDslr(),
    canonKeepLive: keepLive, aspectCrop: cn && s.aspectCrop
  });
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
    if (cmd === 'list') return reply('OK', 'J', await listJson());
    if (cmd === 'diag') return reply('OK', 'J', diagJson());
    if (cmd === 'open') return reply('OK', 'J', await open(String(arg || '').split(' ').includes('recover')));
    if (!s.ptp) throw new GoneError('NOCAMERA The camera isn’t connected.');
    if (cmd === 'info') return reply('OK', 'J', infoJson());
    if (cmd === 'battery') { if (s.drv) s.battery = await s.drv.battery(); else if (s.brand === 'canon') s.battery = await canonBattery(); return reply('OK', 'J', JSON.stringify({ battery: s.battery })); }
    if (cmd === 'props') {
      if (s.drv && typeof s.drv.props === 'function') return reply('OK', 'J', JSON.stringify(await s.drv.props()));
      if (s.brand === 'canon') { try { await poll(); } catch (e) { if (e instanceof GoneError) throw e; } return reply('OK', 'J', JSON.stringify(canonExposureJson({ eosVals: s.eosVals, eosAvail: s.eosAvail }))); }
      return reply('OK', 'J', '{"supported":false}');
    }
    if (cmd === 'setprops') {
      if (s.drv && typeof s.drv.setProps === 'function') return reply('OK', 'J', JSON.stringify(await s.drv.setProps(arg)));
      if (s.brand === 'canon') return reply('OK', 'J', JSON.stringify(await canonSetExposure({ eosVals: s.eosVals, eosAvail: s.eosAvail, setEos, poll }, arg)));
      return reply('OK', 'J', '{"supported":false}');
    }
    if (cmd === 'moviestart') {
      if (s.drv && typeof s.drv.movieStart === 'function') return reply('OK', 'J', JSON.stringify(await s.drv.movieStart()));
      if (s.brand === 'canon') return reply('OK', 'J', await canonMovieStart());
      throw new CamError("UNSUPPORTED Sony Alpha cameras don't transfer 360 videos over USB in PC Remote mode. Choose HDMI Capture Card / Webcam in Camera Source.");
    }
    if (cmd === 'moviestop') {
      if (s.drv && typeof s.drv.movieStop === 'function') return reply('OK', 'J', JSON.stringify(await s.drv.movieStop(arg)));
      if (s.brand === 'canon') return reply('OK', 'J', await canonMovieStop(arg));
      throw new CamError("UNSUPPORTED Sony Alpha cameras don't transfer 360 videos over USB in PC Remote mode.");
    }
    if (cmd === 'af') {
      const isPre = String(arg || '').split(' ').includes('pre');
      if (s.drv && typeof s.drv.af === 'function') await s.drv.af();
      else if (s.brand === 'canon' && !canonLensMf() && !(isPre && canonIsDslr()) && has(0x9128)) {
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
