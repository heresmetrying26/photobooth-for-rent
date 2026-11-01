// Sony Alpha cameras in PC Remote mode on a Mac, straight over USB (libusb). Part of lib/camera-mac.mjs, which opens the camera and
// hands it over here. A port of the Sony part of tools/print-helper/camera-worker.ps1 (the Windows camera part). Sony's own PTP
// commands (the same ones gphoto2 and Sony's remote tools use):
// connect 0x9201 (phases 1, 2, 3), extended device info 0x9202, all properties 0x9209, set property 0x9205,
// buttons 0x9207 (shutter half press 0xD2C1, full press 0xD2C2),
// live view = object 0xFFFFC002, a new photo = property 0xD215 >= 0x8000, then object 0xFFFFC001.
import { OK, BUSY, GoneError, CamError, sleep, hex, jpegStart, cutJpeg, downloadObject } from './ptp.mjs';

const SONY_LV = 0xFFFFC002, SONY_PHOTO = 0xFFFFC001;
export const SONY_HINT = 'On the camera set USB Connection to PC Remote (MENU > Setup > USB), quit Photos, Image Capture and Imaging Edge, switch the camera off and on, unplug and replug the USB cable, then try again.';

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

// Current value of one property in the 0x9209 blob (-1 when it isn't there):
// entries are  code(2) type(2) getset(1) enabled(1) default(size) current(size) ...
export function sonyVal(d, code) {
  for (let i = 8; i + 8 <= d.length; i++) {
    if (d[i] !== (code & 0xFF) || d[i + 1] !== (code >> 8)) continue;
    const type = d[i + 2] | (d[i + 3] << 8);
    const size = (type === 1 || type === 2) ? 1 : (type === 3 || type === 4) ? 2 : (type === 5 || type === 6) ? 4 : 0;
    if (size === 0 || d[i + 4] > 0x84 || d[i + 5] > 2) continue;
    const cur = i + 6 + size;
    if (cur + size > d.length) continue;
    let v = 0;
    for (let k = 0; k < size; k++) v += d[cur + k] * 2 ** (8 * k);
    return v;
  }
  return -1;
}

// The frame starts with the offset of the JPEG inside it.
export function sonyJpeg(d) {
  let s = -1;
  if (d.length > 8) {
    const off = d.readUInt32LE(0);
    if (off + 1 < d.length && d[off] === 0xFF && d[off + 1] === 0xD8) s = off;
  }
  if (s < 0) s = jpegStart(d);
  return s < 0 ? null : cutJpeg(d, s);
}

// ctx: { ptp, ops, props, name, diag, log, note(text) }
export function createSony(ctx) {
  const { ptp, log } = ctx;
  const d = { brand: 'sony', live: false, lastShutterMs: 0 };
  let clock = 0;   // when the connection was made

  const fail = (what, r) => new CamError('DRIVER The ' + ctx.name + " didn't accept remote control (" + what + ', ' + hex(r) + '). ' + SONY_HINT + ' [' + ctx.diag() + ']');

  async function props() {
    const { resp, data } = await ptp.opRead(0x9209);
    return resp === OK ? data : Buffer.alloc(0);
  }
  // Sony "buttons": 1 = released, 2 = pressed.
  const button = (prop, value) => ptp.opWrite(0x9207, Buffer.from([value & 0xFF, value >> 8]), prop);
  const release = async () => { try { await button(0xD2C2, 1); await button(0xD2C1, 1); } catch (e) { if (e instanceof GoneError) throw e; } };

  d.prepare = async () => {
    clock = 0;
    if (!ctx.ops.includes(0x9201) || !ctx.ops.includes(0x9202))
      throw new CamError('MODE The ' + ctx.name + ' is connected as a file-transfer drive, not for remote control. ' + SONY_HINT + ' [' + ctx.diag() + ']');
    let r = (await ptp.opRead(0x9201, 1, 0, 0)).resp; if (r !== OK) throw fail('connect 1', r);
    r = (await ptp.opRead(0x9201, 2, 0, 0)).resp; if (r !== OK) throw fail('connect 2', r);
    let ver = 2;
    for (let t = 0; t < 20; t++) {
      const g = await ptp.opRead(0x9202, 0x12C, 1);
      if (g.resp === OK && g.data.length >= 2) { ver = (g.data[0] | (g.data[1] << 8)) === 0x12C ? 3 : 2; break; }
      await sleep(100);
    }
    r = (await ptp.opRead(0x9201, 3, 0, 0)).resp; if (r !== OK) throw fail('connect 3', r);
    clock = Date.now();
    ctx.addDiag('sony protocol ' + ver);
    log('Sony connected, protocol ' + ver);
    // Remote control wins over the camera's own buttons ("application" priority).
    try { await ptp.opWrite(0x9205, Buffer.from([1]), 0xD25A); }
    catch (e) { if (e instanceof GoneError) throw e; log('Priority mode not set: ' + e.message); }
    // Several bodies (A7 III, A7R IV, ZV-1...) only take photos about 3 s after connecting:
    // wait here, while the booth shows "connecting", not during the first guest's photo.
    let p = Buffer.alloc(0);
    while (Date.now() - clock < 3000) { p = await props(); await sleep(150); }
    // Photos go straight to the computer ("PC Only"), so no memory card is needed: with PC + Camera or Camera Only some bodies
    // refuse to shoot when the card is missing. 1 = PC Only, 0x11 = PC + Camera, 0x10 = Camera Only.
    const dest = sonyVal(p, 0xD222);
    if (dest >= 0 && dest !== 0x01) {
      let ok = false;
      for (const want of [0x01, 0x11]) {
        try {
          if (await ptp.opWrite(0x9205, Buffer.from([want & 0xFF, want >> 8]), 0xD222) !== OK) continue;
          if (sonyVal(await props(), 0xD222) !== want) continue;   // the camera must really have taken it
          ok = true;
          ctx.note(want === 0x01 ? 'Photos go to the computer only (no memory card needed). ' : 'Photos go to the computer and the card. ');
          log('Save destination 0x' + dest.toString(16).toUpperCase() + ' -> 0x' + want.toString(16).toUpperCase());
          break;
        } catch (e) { if (e instanceof GoneError) throw e; log('Save destination not changed: ' + e.message); }
      }
      if (!ok) log('Could not change the save destination (it is 0x' + dest.toString(16).toUpperCase() + '); photos may need a memory card');
    }
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
      let r;
      try { r = (await ptp.opRead(0x1008, SONY_LV)).resp; }
      catch (e) { if (e instanceof GoneError) throw e; r = OK; }
      if (r === 0x2009) { last = r; await sleep(50); continue; }   // InvalidObjectHandle: not ready yet (up to 1 s on some bodies)
      const g = await ptp.opRead(0x1009, SONY_LV);
      last = g.resp;
      if (g.resp === OK && g.data.length > 8) {
        const j = sonyJpeg(g.data);
        if (j) return j;
      }
      await sleep(g.resp === 0x200F ? 20 : 40);   // AccessDenied: asked too fast
    }
    if (last !== OK && last !== BUSY && last !== 0 && last !== 0x2009)
      throw new CamError('LIVEVIEW The camera sends no live view (' + hex(last) + "). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.");
    return null;
  };

  d.capture = async () => {
    const t0 = Date.now();
    // The first photo right after connecting has to wait for the camera to settle.
    while (clock && Date.now() - clock < 3000) { await props(); await sleep(150); }
    // A photo left in the camera's memory by an earlier attempt would be handed over instead of this one.
    for (let k = 0; k < 4; k++) {
      if (sonyVal(await props(), 0xD215) !== 0x8001) break;
      await downloadObject(ptp, SONY_PHOTO, 0, []);
      log("Cleared an old photo from the camera's memory");
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
      if (sonyVal(await props(), 0x500A) !== 1) {
        const hold = Date.now();
        while (Date.now() - hold < 1000) {
          const p = await props();
          const ff = sonyVal(p, 0xD213), om = sonyVal(p, 0xD215);
          if (ff === 2 || ff === 3 || om >= 0x8000) break;
          await sleep(50);
        }
      }
    } finally { await release(); }
    // Wait for the photo to appear in the camera's memory.
    let mem = -1;
    const ew = Date.now();
    while (Date.now() - ew < 15000) {
      mem = sonyVal(await props(), 0xD215);
      if (mem >= 0x8000) break;
      await sleep(100);
    }
    const notes = ['memory ' + (mem < 0 ? '?' : '0x' + mem.toString(16).toUpperCase())];
    if (mem < 0x8000) {
      log('No photo appeared: ' + notes[0]);
      throw new CamError("FOCUS The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check the camera's Still Img. Save Dest. is PC Only and its Release w/o Card setting is Enable.");
    }
    d.lastShutterMs = Math.min(Date.now() - shutter, 10000);
    const img = await downloadObject(ptp, SONY_PHOTO, 0, notes);   // whole photo, or in 1 MB pieces
    log('Photo download: ' + notes.join('; '));
    if (img.length < 4) throw new CamError("CAPTURE The photo didn't come through from the camera (" + notes.join('; ') + ').');
    if (!(img[0] === 0xFF && img[1] === 0xD8)) throw new CamError('CAPTURE The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.');
    log('Photo ' + Math.round(img.length / 1024) + ' KB in ' + (Date.now() - t0) + ' ms');
    return img;
  };

  d.close = async () => { d.live = false; };

  return d;
}
