// Nikon DSLRs / mirrorless (D-series, Z-series) on a Mac, straight over USB (libusb). Part of lib/camera-mac.mjs, which opens the
// camera and hands it over here. A port of the Nikon part of tools/print-helper/camera-worker.ps1 (the Windows camera part), which
// runs Nikon's own PTP commands (the same ones gphoto2 uses): StartLiveView 0x9201, EndLiveView 0x9202, GetLiveViewImg 0x9203,
// AfDrive 0x90C1, InitiateCaptureRecInSdram 0x90C0, InitiateCaptureRecInMedia 0x9207, GetEvent 0x90C7, DeviceReady 0x90C8.
import { OK, BUSY, GoneError, CamError, sleep, hex, Reader, jpegStart, cutJpeg, downloadObject } from './ptp.mjs';

// Nikons in MTP mode (D3400, D5600...) may not list their own commands, but they still answer them.
const NIKON_OPS = [0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207];
const NOT_IN_LIVE_VIEW = 0xA00B;
const AF_FAILED = 0xA002;

const width = (s) => { const x = String(s).indexOf('x'); const w = x > 0 ? parseInt(String(s).slice(0, x), 10) : 0; return Number.isFinite(w) ? w : 0; };

// ctx: { ptp, ops, props, name, log, note(text) }
export function createNikon(ctx) {
  const { ptp, log } = ctx;
  const has = (op) => ctx.ops.includes(op) || NIKON_OPS.includes(op);
  const d = { brand: 'nikon', live: false, lastShutterMs: 0 };
  let eventAt = Date.now();

  async function waitReady(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await ptp.op(0x90C8);
      if (r === OK) return true;
      if (r !== BUSY) return false;
      await sleep(50);
    }
    return false;
  }

  // A property's type, current value and (when it has a list) the choices.
  async function propDesc(code) {
    const { resp, data } = await ptp.opRead(0x1014, code);
    if (resp !== OK || data.length < 6) return null;
    const rd = new Reader(data);
    rd.u16();
    const o = { type: rd.u16(), current: '', choices: [] };
    rd.u8();
    rd.value(o.type);
    o.current = rd.value(o.type);
    const form = rd.u8();
    if (form === 2) { const n = rd.u16(); for (let k = 0; k < n; k++) o.choices.push(rd.value(o.type)); }
    return o;
  }

  async function setProp(code, type, value) {
    let data;
    if (type === 0xFFFF) {
      const str = Buffer.from(value + '\0', 'utf16le');
      data = Buffer.concat([Buffer.from([value.length + 1]), str]);
    } else {
      const v = Number(value);
      const size = (type === 1 || type === 2) ? 1 : (type === 3 || type === 4) ? 2 : 4;
      data = Buffer.alloc(size);
      for (let k = 0; k < size; k++) data[k] = Math.floor(v / 2 ** (8 * k)) & 0xFF;
    }
    const r = await ptp.opWrite(0x1016, data, code);
    await waitReady(2000);
    return r === OK;
  }

  // Record to the camera's own memory (so no SD card is needed), JPEG, and the smallest photo size still >= ~2900 px wide
  // (the booth uses at most 3000 px; smaller files come over USB much faster).
  d.prepare = async () => {
    try {
      const rm = await propDesc(0xD10B);   // RecordingMedia
      if (rm && rm.current !== '1' && await setProp(0xD10B, rm.type, '1')) { ctx.note('Records to camera memory. '); log('Recording media -> camera memory (SDRAM)'); }
    } catch (e) { if (e instanceof GoneError) throw e; log('Recording media not changed: ' + e.message); }
    try {
      if (ctx.props.includes(0x5004)) {
        const q = await propDesc(0x5004);
        // Nikon: 0 Basic, 1 Normal, 2 Fine (JPEG); higher values include RAW.
        if (q && parseInt(q.current, 10) > 2 && q.choices.includes('2') && await setProp(0x5004, q.type, '2')) { ctx.note('Set to JPEG Fine. '); log('Image quality was RAW; set to JPEG Fine'); }
      }
      if (ctx.props.includes(0x5003)) {
        const s = await propDesc(0x5003);
        if (s && s.type === 0xFFFF && s.choices.length > 1) {
          let best = null, bestW = Infinity;
          for (const c of s.choices) { const w = width(c); if (w >= 2900 && w < bestW) { best = c; bestW = w; } }
          if (best !== null && best !== s.current && await setProp(0x5003, s.type, best)) { ctx.note('Photo size ' + best + '. '); log('Image size ' + s.current + ' -> ' + best); }
        }
      }
    } catch (e) { if (e instanceof GoneError) throw e; log('Photo size not changed: ' + e.message); }
    d.live = false;
  };

  d.alive = async () => { await ptp.op(0x90C8); };

  d.battery = async () => {
    if (!ctx.props.includes(0x5001)) return -1;
    try { const { resp, data } = await ptp.opRead(0x1015, 0x5001); return resp === OK && data.length > 0 ? data[0] : -1; }
    catch (e) { if (e instanceof GoneError) throw e; return -1; }
  };

  d.liveOn = async () => {
    if (d.live) return;
    const r = await ptp.op(0x9201);
    log('StartLiveView: ' + hex(r));
    if (r !== OK && r !== NOT_IN_LIVE_VIEW && r !== BUSY)
      throw new CamError('LIVEVIEW The camera refused live view (' + hex(r) + '). Put an SD card in the camera, close its menu, turn the mode dial to P and extend the kit lens, then try again.');
    await waitReady(6000);
    d.live = true;
  };

  d.liveOff = async () => {
    if (!d.live) return;
    try { await ptp.op(0x9202); } catch (e) { if (e instanceof GoneError) throw e; }
    await waitReady(3000);
    d.live = false;
  };

  // New photo handles from Nikon's event queue (ObjectAdded 0x4002 / 0xC101).
  async function events() {
    const l = [];
    if (!has(0x90C7)) return l;
    const { resp, data } = await ptp.opRead(0x90C7);
    if (resp === OK && data.length >= 2) {
      const rd = new Reader(data);
      const n = rd.u16();
      for (let k = 0; k < n && rd.pos + 6 <= data.length; k++) {
        const code = rd.u16(), p = rd.u32();
        if (code === 0x4002 || code === 0xC101) l.push(p);
      }
    }
    return l;
  }
  const drain = async () => { try { await events(); } catch (e) { if (e instanceof GoneError) throw e; } };

  d.frame = async () => {
    if (!d.live) await d.liveOn();
    // Events are only read when a photo is taken (and now and then here): over hours of live view the camera's list would keep growing.
    if (Date.now() - eventAt > 3000 && has(0x90C7)) { eventAt = Date.now(); await drain(); }
    const t0 = Date.now();
    let restarts = 0, last = 0;
    while (Date.now() - t0 < 2500) {
      const { resp, data } = await ptp.opRead(0x9203);
      last = resp;
      if (resp === OK) {
        const s = jpegStart(data);
        if (s >= 0) return cutJpeg(data, s);
      } else if (resp === NOT_IN_LIVE_VIEW && restarts < 2) {   // not in live view (it stops after a photo on some models)
        restarts++; d.live = false; await d.liveOn(); continue;
      }
      await sleep(40);
    }
    if (last !== OK && last !== BUSY && last !== 0)
      throw new CamError('LIVEVIEW The camera sends no live view (' + hex(last) + '). Put an SD card in the camera, close its menu and turn the mode dial to P.');
    return null;
  };

  d.capture = async () => {
    const t0 = Date.now();
    let r;
    // Focus first while in live view (contrast AF); a miss is fine, the shot decides.
    if (d.live && has(0x90C1)) {
      try { r = await ptp.op(0x90C1); if (r === OK) await waitReady(3000); } catch (e) { if (e instanceof GoneError) throw e; }
    }
    await drain();
    const shutter = Date.now();
    if (has(0x90C0)) r = await ptp.op(0x90C0, 0xFFFFFFFF);   // InitiateCaptureRecInSdram
    else r = await ptp.op(0x100E, 0, 0);
    if (r === AF_FAILED && has(0x9207)) {
      log('Out of focus; shooting without autofocus');
      r = await ptp.op(0x9207, 0xFFFFFFFF, 1);   // InitiateCaptureRecInMedia, no AF, to SDRAM
      if (r !== OK) r = await ptp.op(0x9207, 0xFFFFFFFF, 0);
    }
    if (r === BUSY) { await waitReady(3000); r = await ptp.op(0x90C0, 0xFFFFFFFF); }
    if (r !== OK) {
      if (r === AF_FAILED) throw new CamError("FOCUS The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).");
      if (r === 0xA00A || r === 0xA009) throw new CamError("CAPTURE The camera can't take a photo right now (" + hex(r) + "). Check the memory card isn't full or locked.");
      throw new CamError('CAPTURE The camera refused the photo (' + hex(r) + "). Check the mode dial isn't on video and the camera's menu is closed.");
    }
    await waitReady(10000);
    const handles = [];
    const add = (l) => { for (const h of l) if (!handles.includes(h)) handles.push(h); };
    const ew = Date.now();
    while (Date.now() - ew < 8000) {
      add(await events());
      if (handles.length > 0) { await sleep(150); add(await events()); break; }
      await sleep(100);
    }
    if (handles.length === 0) handles.push(0xFFFF0001);   // the photo in the camera's memory
    d.lastShutterMs = Math.min(Date.now() - shutter, 10000);
    let pick = handles[0];
    if (handles.length > 1) {
      // RAW + JPEG: take the JPEG
      for (const h of handles) {
        try {
          const oi = await ptp.opRead(0x1008, h);
          if (oi.resp === OK && oi.data.length > 6 && oi.data.readUInt16LE(4) === 0x3801) { pick = h; break; }
        } catch (e) { if (e instanceof GoneError) throw e; }
      }
    }
    const notes = ['handles ' + handles.map((h) => h.toString(16).toUpperCase()).join(',')];
    const img = await downloadObject(ptp, pick, 0, notes);
    log('Photo download: ' + notes.join('; '));
    if (img.length < 4) throw new CamError("CAPTURE The photo didn't come through from the camera (" + notes.join('; ') + ').');
    if (!(img[0] === 0xFF && img[1] === 0xD8)) throw new CamError('CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera.');
    log('Photo ' + Math.round(img.length / 1024) + ' KB in ' + (Date.now() - t0) + ' ms');
    // Live view resumes by itself on most models; frame() restarts it if not.
    return img;
  };

  d.close = async () => {
    if (d.live) { try { await ptp.op(0x9202); } catch { /* ignore */ } }
    d.live = false;
  };

  return d;
}
