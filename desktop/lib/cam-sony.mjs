// Sony Alpha cameras in PC Remote mode on a Mac, straight over USB (libusb). Part of lib/camera-mac.mjs, which opens the camera and
// hands it over here. A port of the Sony part of tools/print-helper/camera-worker.ps1 (the Windows camera part). Sony's own PTP
// commands (the same ones gphoto2 and Sony's remote tools use):
// connect 0x9201 (phases 1, 2, 3), extended device info 0x9202, all properties 0x9209, set property 0x9205,
// buttons 0x9207 (shutter half press 0xD2C1, full press 0xD2C2),
// live view = object 0xFFFFC002, a new photo = property 0xD215 >= 0x8000, then object 0xFFFFC001.
import { OK, BUSY, GoneError, CamError, sleep, hex, jpegStart, cutJpeg, downloadObject } from './ptp.mjs';

const SONY_LV = 0xFFFFC002, SONY_PHOTO = 0xFFFFC001;
export const SONY_HINT = 'On the camera enable PC Remote (MENU > Network > PC Remote Function > PC Remote: On, or MENU > Setup > USB > USB Connection: PC Remote), set Still Img. Save Dest. to PC Only and File Format to JPEG, quit Photos, Image Capture and Imaging Edge, switch the camera off and on, unplug and replug the USB cable, then try again.';

const NAMES = {
  'ILCE-7M2': 'A7 II', 'ILCE-7M3': 'A7 III', 'ILCE-7M4': 'A7 IV', 'ILCE-7M5': 'A7 V',
  'ILCE-7RM2': 'A7R II', 'ILCE-7RM3': 'A7R III', 'ILCE-7RM3A': 'A7R IIIA', 'ILCE-7RM4': 'A7R IV', 'ILCE-7RM4A': 'A7R IVA', 'ILCE-7RM5': 'A7R V',
  'ILCE-7SM2': 'A7S II', 'ILCE-7SM3': 'A7S III', 'ILCE-7C': 'A7C', 'ILCE-7CM2': 'A7C II', 'ILCE-7CR': 'A7CR',
  'ILCE-9': 'A9', 'ILCE-9M2': 'A9 II', 'ILCE-9M3': 'A9 III', 'ILCE-1': 'A1',
  'ILCE-6100': 'A6100', 'ILCE-6400': 'A6400', 'ILCE-6600': 'A6600', 'ILCE-6700': 'A6700'
};
export function sonyName(model) {
  const key = String(model || '').toUpperCase().replace('SONY', '').trim();
  return 'Sony ' + (NAMES[key] || (key === '' ? 'camera' : key));
}

function sonyScalarSize(t) {
  if (t === 1 || t === 2) return 1;
  if (t === 3 || t === 4) return 2;
  if (t === 5 || t === 6) return 4;
  if (t === 7 || t === 8) return 8;
  if (t === 9 || t === 10) return 16;
  return 0;
}

function sonyReadInt(d, pos, t) {
  if (t === 1) return d.readInt8(pos);
  if (t === 2) return d.readUInt8(pos);
  if (t === 3) return d.readInt16LE(pos);
  if (t === 4) return d.readUInt16LE(pos);
  if (t === 5) return d.readInt32LE(pos);
  if (t === 6) return d.readUInt32LE(pos);
  if (t === 7 || t === 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v += d[pos + k] * 2 ** (8 * k);
    return v;
  }
  return -1;
}

function sonySkipValue(d, pos, t) {
  if (pos >= d.length) return -1;
  if ((t & 0x4000) !== 0) {
    if (pos + 4 > d.length) return -1;
    const n = d.readUInt32LE(pos);
    let p = pos + 4;
    const base = t & 0x3FFF;
    for (let k = 0; k < n; k++) { p = sonySkipValue(d, p, base); if (p < 0) return -1; }
    return p;
  }
  if (t === 0xFFFF) {
    const n = d[pos];
    const next = pos + 1 + n * 2;
    return next <= d.length ? next : -1;
  }
  const sz = sonyScalarSize(t);
  if (sz <= 0 || pos + sz > d.length) return -1;
  return pos + sz;
}

// Current value & PTP type of one property in the 0x9209 blob ({ val: -1, type: 0 } when absent):
// header: count(4) reserved(4); entries: code(2) type(2) access(1) enabled(1) default(T) current(T) form(1) ...
// Protocol v3 (0x12C, e.g. A7 III) sends TWO arrays for form=2 enums (n1 supported + n2 available).
function sonyProp(d, code, ver = 2) {
  if (!d || d.length < 8) return { val: -1, type: 0 };
  const count = d.readUInt32LE(0);
  const reserved = d.readUInt32LE(4);
  if (reserved !== 0 || count > 8192) return { val: -1, type: 0 };
  const limit = count > 0 ? count : 4096;
  let pos = 8;
  for (let idx = 0; idx < limit && pos + 7 <= d.length; idx++) {
    const pCode = d.readUInt16LE(pos);
    const type = d.readUInt16LE(pos + 2);
    const getSet = d[pos + 4], enabled = d[pos + 5];
    pos += 6; // skip code(2), type(2), access(1), enabled(1)
    if (getSet > 0x84 || enabled > 2) break;
    pos = sonySkipValue(d, pos, type); // default
    if (pos < 0) break;
    const curStart = pos;
    pos = sonySkipValue(d, pos, type); // current
    if (pos < 0 || pos + 1 > d.length) break;
    if (pCode === code) {
      const sz = sonyScalarSize(type);
      const val = (sz > 0 && sz <= 8 && curStart + sz <= d.length) ? sonyReadInt(d, curStart, type) : -1;
      return { val, type };
    }
    const form = d[pos++];
    if (form === 1) {
      for (let k = 0; k < 3; k++) { pos = sonySkipValue(d, pos, type); if (pos < 0) return { val: -1, type: 0 }; }
    } else if (form === 2) {
      if (pos + 2 > d.length) break;
      const n1 = d.readUInt16LE(pos); pos += 2;
      for (let k = 0; k < n1; k++) { pos = sonySkipValue(d, pos, type); if (pos < 0) return { val: -1, type: 0 }; }
      if (ver >= 3 && pos + 2 <= d.length) {
        const n2 = d.readUInt16LE(pos); pos += 2;
        for (let k = 0; k < n2; k++) { pos = sonySkipValue(d, pos, type); if (pos < 0) return { val: -1, type: 0 }; }
      }
    } else if (form !== 0) {
      break;
    }
  }
  return { val: -1, type: 0 };
}

export function sonyVal(d, code, ver = 2) {
  return sonyProp(d, code, ver).val;
}

// Live-view payload has [offset:u32][size:u32]...; fail closed if EOI (0xFF 0xD9) is missing.
export function sonyJpeg(d) {
  if (!d || d.length <= 8) return null;
  const off = d.readUInt32LE(0);
  const fsize = d.readUInt32LE(4);
  if (off === 0 && fsize === 0) return null;
  let s = -1;
  if (off >= 8 && off + 1 < d.length && d[off] === 0xFF && d[off + 1] === 0xD8) s = off;
  if (s < 0) s = jpegStart(d);
  if (s < 0) return null;
  const limit = (fsize > 0 && s + fsize <= d.length) ? s + fsize : d.length;
  for (let k = limit - 2; k > s; k--) {
    if (d[k] === 0xFF && d[k + 1] === 0xD9) {
      const len = k + 2 - s;
      return len <= 512 * 1024 ? Buffer.from(d.subarray(s, k + 2)) : null;
    }
  }
  return null;
}

// ctx: { ptp, ops, props, name, model, product, diag, log, note(text) }
export function createSony(ctx) {
  const { ptp, log } = ctx;
  const d = { brand: 'sony', live: false, lastShutterMs: 0 };
  const isA7M3 = /ILCE-7M3/i.test(ctx.model || ctx.name || '');
  let clock = 0;   // when the connection was made
  let ver = isA7M3 ? 3 : 2;
  let destBlocked = false;

  const fail = (what, r) => new CamError('DRIVER The ' + ctx.name + " didn't accept remote control (" + what + ', ' + hex(r) + '). ' + SONY_HINT + ' [' + ctx.diag() + ']');

  async function props() {
    const { resp, data } = await ptp.opRead(0x9209);
    return resp === OK ? data : Buffer.alloc(0);
  }
  // Sony "buttons": 1 = released, 2 = pressed.
  const button = (prop, value) => ptp.opWrite(0x9207, Buffer.from([value & 0xFF, value >> 8]), prop);
  const release = async () => { try { await button(0xD2C2, 1); await button(0xD2C1, 1); } catch (e) { if (e instanceof GoneError) throw e; } };

  async function connectPhase(phase) {
    let r = 0;
    for (let t = 0; t < 12; t++) {
      r = (await ptp.opRead(0x9201, phase, 0, 0)).resp;
      if (r === OK || r !== BUSY) return r;
      await sleep(150);
    }
    return r;
  }

  function scalarBuf(val, type) {
    if (type === 5 || type === 6) {
      const b = Buffer.alloc(4); b.writeUInt32LE(val >>> 0, 0); return b;
    }
    if (type === 1 || type === 2) return Buffer.from([val & 0xFF]);
    return Buffer.from([val & 0xFF, (val >> 8) & 0xFF]);
  }

  async function ensureSaveDest(curDest, destType = 4) {
    const wantTarget = ctx.saveToCard ? 0x11 : 0x01;
    if (curDest === wantTarget) { destBlocked = false; return curDest; }
    if (destBlocked && curDest !== 0x10) return curDest;
    let ok = false;
    const prefs = ctx.saveToCard ? [0x11, 0x01] : [0x01, 0x11];
    for (const want of prefs) {
      try {
        if (await ptp.opWrite(0x9205, scalarBuf(want, destType || 4), 0xD222) !== OK) continue;
        if (sonyVal(await props(), 0xD222, ver) !== want) continue;   // the camera must really have taken it
        ok = true;
        destBlocked = !ctx.saveToCard && (want !== 0x01);
        ctx.note(want === 0x01 ? 'Photos go to the computer only (no memory card needed). ' : 'Backup + RAW saved to camera SD card (PC + Camera). ');
        log('Save destination 0x' + curDest.toString(16).toUpperCase() + ' -> 0x' + want.toString(16).toUpperCase());
        return want;
      } catch (e) { if (e instanceof GoneError) throw e; log('Save destination not changed: ' + e.message); }
    }
    if (!ok) {
      destBlocked = true;
      log('Could not change the save destination (it is 0x' + curDest.toString(16).toUpperCase() + '); photos may need a memory card');
    }
    return curDest;
  }

  d.prepare = async () => {
    clock = 0;
    destBlocked = false;
    ver = isA7M3 ? 3 : 2;
    if (!ctx.ops.includes(0x9201) || !ctx.ops.includes(0x9202))
      throw new CamError('MODE The ' + ctx.name + ' is connected as a file-transfer drive, not for remote control. ' + SONY_HINT + ' [' + ctx.diag() + ']');
    let r = await connectPhase(1); if (r !== OK) throw fail('connect 1', r);
    r = await connectPhase(2); if (r !== OK) throw fail('connect 2', r);
    let askV2 = !isA7M3 && (/ILCE-6400/i.test(ctx.model || ctx.name || '') || ctx.product === 0x0CAA);
    for (let t = 0; t < 20; t++) {
      const g = askV2 ? await ptp.opRead(0x9202, 0xC8) : await ptp.opRead(0x9202, 0x12C, 1);
      if (g.resp === OK && g.data.length >= 2) { ver = (g.data[0] | (g.data[1] << 8)) >= 0x12C ? 3 : 2; break; }
      if (!askV2 && (g.resp === 0x2005 || g.resp === 0x2006 || g.resp === 0x201D)) { askV2 = true; continue; }
      await sleep(100);
    }
    r = await connectPhase(3); if (r !== OK) throw fail('connect 3', r);
    clock = Date.now();
    ctx.addDiag('sony protocol ' + ver + (isA7M3 ? ' (ILCE-7M3)' : ''));
    log('Sony connected, protocol ' + ver);
    // Clear any shutter button held down by an interrupted earlier session, then give remote control priority.
    await release();
    try { await ptp.opWrite(0x9205, Buffer.from([1]), 0xD25A); }
    catch (e) { if (e instanceof GoneError) throw e; log('Priority mode not set: ' + e.message); }
    // Several bodies (A7 III, A7R IV, A6400, ZV-1...) only take photos about 3 s after connecting:
    // wait here, while the booth shows "connecting", not during the first guest's photo.
    let p = Buffer.alloc(0);
    while (Date.now() - clock < 3000) {
      const np = await props();
      if (np.length) p = np;
      await sleep(150);
    }
    if (!p.length) p = await props();
    // Ensure Single Shooting mode (0x5013 = 1) so continuous/bracket drive doesn't fire bursts.
    const scm = sonyProp(p, 0x5013, ver);
    if (scm.val >= 0 && scm.val !== 1) {
      try {
        const sr = await ptp.opWrite(0x9205, scalarBuf(1, scm.type || 4), 0x5013);
        if (sr === OK) log('Still capture mode ' + scm.val + ' -> 1');
      } catch (e) { if (e instanceof GoneError) throw e; log('Still capture mode not changed: ' + e.message); }
    }
    // Photos go straight to the computer ("PC Only"), so no memory card is needed: with PC + Camera or Camera Only some bodies
    // refuse to shoot when the card is missing. 1 = PC Only, 0x11 = PC + Camera, 0x10 = Camera Only.
    const dest = sonyProp(p, 0xD222, ver);
    const wantTarget = ctx.saveToCard ? 0x11 : 0x01;
    if (dest.val >= 0 && dest.val !== wantTarget) await ensureSaveDest(dest.val, dest.type);
    d.live = true;   // Sony live view has no start command: the frames are simply there
  };

  d.alive = async () => { await ptp.opRead(0x1001); };
  d.battery = async () => -1;   // Sony reports battery in steps, not percent
  d.liveOn = async () => { d.live = true; };
  d.liveOff = async () => { d.live = false; };

  d.frame = async () => {
    d.live = true;
    const t0 = Date.now();
    let last = 0;
    while (Date.now() - t0 < 2500) {
      const g = await ptp.opRead(0x1009, SONY_LV);
      last = g.resp;
      if (g.resp === OK) {
        if (g.data.length === 8 || g.data.length === 0) { await sleep(15); continue; }   // 8 zero bytes = "no new frame yet"
        const j = sonyJpeg(g.data);
        if (j) return j;
      }
      await sleep(g.resp === 0x200F ? 20 : g.resp === 0x2009 ? 50 : 30);   // AccessDenied / InvalidObjectHandle
    }
    if (last !== OK && last !== BUSY && last !== 0 && last !== 0x2009)
      throw new CamError('LIVEVIEW The camera sends no live view (' + hex(last) + "). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.");
    return null;
  };

  d.capture = async () => {
    const t0 = Date.now();
    // The first photo right after connecting has to wait for the camera to settle.
    while (clock && Date.now() - clock < 3000) { await props(); await sleep(150); }
    // A photo left in the camera's memory by an earlier attempt would be handed over instead of this one; also ensure save dest is PC.
    let pre = Buffer.alloc(0);
    for (let k = 0; k < 4; k++) {
      pre = await props();
      if (sonyVal(pre, 0xD215, ver) < 0x8000) break;
      await downloadObject(ptp, SONY_PHOTO, 0, []);
      log("Cleared an old photo from the camera's memory");
    }
    const curDest = sonyProp(pre, 0xD222, ver);
    const wantTarget = ctx.saveToCard ? 0x11 : 0x01;
    if (curDest.val === 0x10 || (!destBlocked && curDest.val >= 0 && curDest.val !== wantTarget)) {
      await ensureSaveDest(curDest.val, curDest.type);
    }
    // Half press, full press (the camera focuses, then shoots).
    const shutter = Date.now();
    let r = await button(0xD2C1, 2);
    if (r === OK) r = await button(0xD2C2, 2);
    if (r !== OK) {
      await release();
      throw new CamError('CAPTURE The camera refused the shutter (' + hex(r) + "). Check the mode dial isn't on video, the camera's menu is closed and it is in PC Remote mode.");
    }
    try {
      // Hold until focus is found (1 s at most). Manual focus needs no wait.
      if (sonyVal(await props(), 0x500A, ver) !== 1) {
        const hold = Date.now();
        while (Date.now() - hold < 1000) {
          const p = await props();
          const ff = sonyVal(p, 0xD213, ver), om = sonyVal(p, 0xD215, ver);
          if (ff === 2 || ff === 3 || om >= 0x8000) break;
          await sleep(50);
        }
      }
    } finally { await release(); }
    // Wait for the photo to appear in the camera's memory.
    let mem = -1;
    const ew = Date.now();
    while (Date.now() - ew < 15000) {
      mem = sonyVal(await props(), 0xD215, ver);
      if (mem >= 0x8000) break;
      await sleep(100);
    }
    const notes = ['memory ' + (mem < 0 ? '?' : '0x' + mem.toString(16).toUpperCase())];
    if (mem < 0x8000) {
      log('No photo appeared: ' + notes[0]);
      throw new CamError("FOCUS The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check the camera's Still Img. Save Dest. is PC Only and its Release w/o Card setting is Enable.");
    }
    d.lastShutterMs = Math.min(Date.now() - shutter, 10000);
    // Peek ObjectFormat when available so RAW+JPEG skips RAW and picks the JPEG, then drain any trailing queued RAW.
    let img = Buffer.alloc(0);
    let sawRaw = false;
    for (let k = 0; k < 4; k++) {
      let fmt = 0, size = 0;
      try {
        const oi = await ptp.opRead(0x1008, SONY_PHOTO);
        if (oi.resp === OK && oi.data.length >= 12) {
          fmt = oi.data.readUInt16LE(4);
          size = oi.data.readUInt32LE(8);
          notes.push('info ' + hex(oi.resp) + ' fmt ' + hex(fmt) + ' ' + size + ' B');
        } else if (k > 0) break;
      } catch (e) { if (e instanceof GoneError) throw e; if (k > 0) break; }
      if (fmt !== 0 && fmt !== 0x3801 && fmt !== 0x3808) {
        sawRaw = true;
        await downloadObject(ptp, SONY_PHOTO, size, notes);
        notes.push('skipped non-JPEG ' + hex(fmt));
        const waitNext = Date.now();
        let more = false;
        while (Date.now() - waitNext < 4000) {
          if (sonyVal(await props(), 0xD215, ver) >= 0x8000) { more = true; break; }
          await sleep(60);
        }
        if (!more) break;
        continue;
      }
      const b = await downloadObject(ptp, SONY_PHOTO, size, notes);
      if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8) { img = b; break; }
      if (b.length >= 4) sawRaw = true;
      if (sonyVal(await props(), 0xD215, ver) < 0x8000) break;
    }
    if (img.length >= 4 && sonyVal(await props(), 0xD215, ver) >= 0x8000) {
      await downloadObject(ptp, SONY_PHOTO, 0, notes);
      notes.push('drained trailing');
    }
    log('Photo download: ' + notes.join('; '));
    if (img.length < 4) {
      if (sawRaw) throw new CamError('CAPTURE The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.');
      throw new CamError("CAPTURE The photo didn't come through from the camera (" + notes.join('; ') + ').');
    }
    log('Photo ' + Math.round(img.length / 1024) + ' KB in ' + (Date.now() - t0) + ' ms');
    return img;
  };

  d.close = async () => {
    d.live = false;
    try { await release(); } catch { /* ignore */ }
  };

  return d;
}
