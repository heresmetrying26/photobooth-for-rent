// Nikon DSLRs / mirrorless (D-series, Z-series) on a Mac, straight over USB (libusb). Part of lib/camera-mac.mjs, which opens the
// camera and hands it over here. A port of the Nikon part of tools/print-helper/camera-worker.ps1 (the Windows camera part), which
// runs Nikon's own PTP commands (the same ones gphoto2 uses): StartLiveView 0x9201, EndLiveView 0x9202, GetLiveViewImg 0x9203,
// AfDrive 0x90C1, InitiateCaptureRecInSdram 0x90C0, InitiateCaptureRecInMedia 0x9207, GetEvent 0x90C7, DeviceReady 0x90C8.
import { OK, BUSY, GoneError, CamError, sleep, hex, Reader, jpegStart, cutJpeg, downloadObject } from './ptp.mjs';
import { ptpObjectMeta, isStillOrRaw, streamObjectToFile } from './cam-movie.mjs';

const NIKON_WB_IDS = [2, 4, 5, 6, 7, 32784, 32785, 32787];
const NIKON_WB_NAMES = ['Auto', 'Daylight', 'Fluorescent', 'Tungsten', 'Flash', 'Cloudy', 'Shade', 'Custom'];

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
  let movieRec = false, prevMedia = null, prevLvSel = null;

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
    const o = { type: rd.u16(), getSet: rd.u8(), current: '', choices: [] };
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

  async function hasStorageCard() {
    try {
      const { resp, data } = await ptp.opRead(0x1004);
      if (resp !== OK || data.length < 8) return false;
      const cnt = data.readUInt32LE(0);
      for (let i = 0; i < cnt && 4 + (i + 1) * 4 <= data.length; i++) {
        const sid = data.readUInt32LE(4 + i * 4);
        if (sid !== 0 && sid !== 0x00010000) return true;
      }
      return false;
    } catch (e) { if (e instanceof GoneError) throw e; return false; }
  }

  // Record to SDRAM when saveToCard is false (no SD card needed), or SD card preserving RAW+JPEG when saveToCard is true.
  d.prepare = async () => {
    const saveToCard = !!ctx.saveToCard;
    try {
      const rm = await propDesc(0xD10B);   // RecordingMedia
      if (saveToCard && await hasStorageCard()) {
        if (rm && rm.current !== '0' && await setProp(0xD10B, rm.type, '0')) { log('Recording media -> SD card (backup + RAW kept)'); }
        ctx.note('Backup + RAW saved to camera SD card. ');
      } else {
        if (rm && rm.current !== '1' && await setProp(0xD10B, rm.type, '1')) { ctx.note('Records to camera memory. '); log('Recording media -> camera memory (SDRAM)'); }
        if (saveToCard) ctx.note('No SD card in camera — saving on computer only. ');
      }
    } catch (e) { if (e instanceof GoneError) throw e; log('Recording media not changed: ' + e.message); }
    try {
      if (ctx.props.includes(0x5004)) {
        const q = await propDesc(0x5004);
        // Nikon: 0 Basic, 1 Normal, 2 Fine (JPEG); higher values include RAW.
        const curQ = q ? parseInt(q.current, 10) : 2;
        const shouldFine = saveToCard ? (curQ < 2) : (curQ !== 2);
        if (q && shouldFine && q.choices.includes('2') && await setProp(0x5004, q.type, '2')) { ctx.note('Set to JPEG Fine. '); log('Image quality was ' + q.current + '; set to JPEG Fine'); }
      }
      if (ctx.props.includes(0x5003)) {
        const s = await propDesc(0x5003);
        if (s && s.type === 0xFFFF && s.choices.length > 1) {
          let best = null, bestW = Infinity, big = null, bigW = 0;
          for (const c of s.choices) {
            const w = width(c);
            if (w >= 3900 && w < bestW) { best = c; bestW = w; }
            if (w > bigW) { big = c; bigW = w; }
          }
          if (best === null) best = big;
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
    // EndLiveView is refused (busy) while the camera is still saving the last photo; ask again until it accepts, or live view stays on.
    let r = 0;
    for (let k = 0; k < 14; k++) {
      try { r = await ptp.op(0x9202); } catch (e) { if (e instanceof GoneError) throw e; r = 0xFFFF; }
      if (r === OK || r === NOT_IN_LIVE_VIEW) { d.live = false; break; }
      await sleep(300);
    }
    if (d.live) log('EndLiveView not accepted (' + hex(r) + '): live view may still be on, will ask again');
    else await waitReady(3000);
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

  // Live view autofocus (same as the Windows camera part): wait until the camera is ready again, at most ~2 s in all, one more try
  // after a miss if there is time, and a camera that refuses at once (lens on MF) is not a miss. true = focused (or not reported).
  let afRefusedLogged = false;
  async function nikonAf() {
    const t0 = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const one = Date.now();
      const r = await ptp.op(0x90C1);
      if (r === OK) {
        await sleep(250);
        await waitReady(Math.max(300, 2000 - (Date.now() - t0)));
        await drain();
        log('Autofocus' + (attempt ? ' (second try)' : '') + ': done in ' + (Date.now() - t0) + ' ms');
        return true;
      }
      log('Autofocus' + (attempt ? ' (second try)' : '') + ': ' + hex(r) + ' after ' + (Date.now() - one) + ' ms');
      if (r !== AF_FAILED && r !== BUSY) return true;
      if (attempt === 0 && Date.now() - one < 200) {
        if (!afRefusedLogged) { afRefusedLogged = true; log('Autofocus refused at once: lens on MF? Shooting with the lens as it is'); }
        return true;
      }
      if (Date.now() - t0 > 900) break;
      await sleep(250);
    }
    return false;
  }

  d.af = async () => {
    if (!d.live) await d.liveOn();
    return has(0x90C1) ? nikonAf() : true;
  };

  d.capture = async () => {
    const t0 = Date.now();
    let r;
    // Focus first while in live view (contrast AF); a miss is fine, the shot decides.
    if (d.live && has(0x90C1)) {
      try { await nikonAf(); } catch (e) { if (e instanceof GoneError) throw e; }
    }
    await drain();
    const captureToCard = !!ctx.saveToCard && has(0x9207) && await hasStorageCard();
    let useCardOp = captureToCard;
    let shotToCard = false;
    if (captureToCard) {
      r = await ptp.op(0x9207, 0xFFFFFFFF, 0);
      // Nikon D5300 / D5xxx often refuses 0x9207 while Live View is active (0xA00B / BUSY): stop LV, waitReady, retry once.
      if ((r === NOT_IN_LIVE_VIEW || r === BUSY) && d.live) {
        await d.liveOff();
        await waitReady(2500);
        r = await ptp.op(0x9207, 0xFFFFFFFF, 0);
      }
      if (r === OK) shotToCard = true;
      else if (r === 0x2005 && has(0x90C0)) { useCardOp = false; r = await ptp.op(0x90C0, 0xFFFFFFFF); }
    } else {
      if (has(0x90C0)) r = await ptp.op(0x90C0, 0xFFFFFFFF);   // InitiateCaptureRecInSdram
      else r = await ptp.op(0x100E, 0, 0);
    }
    if (r === AF_FAILED && has(0x9207)) {
      log('Out of focus; shooting without autofocus');
      r = await ptp.op(0x9207, 0xFFFFFFFF, useCardOp ? 0 : 1);
      if (r !== OK && !useCardOp) r = await ptp.op(0x9207, 0xFFFFFFFF, 0);
      else if (r === OK && useCardOp) shotToCard = true;
    }
    if (r === BUSY) {
      await waitReady(3000);
      if (useCardOp) { r = await ptp.op(0x9207, 0xFFFFFFFF, 0); if (r === OK) shotToCard = true; }
      else r = await ptp.op(0x90C0, 0xFFFFFFFF);
    }
    if (r !== OK) {
      if (r === AF_FAILED) throw new CamError("FOCUS The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).");
      if (r === 0xA00A || r === 0xA009) throw new CamError("CAPTURE The camera can't take a photo right now (" + hex(r) + "). Check the memory card isn't full or locked.");
      throw new CamError('CAPTURE The camera refused the photo (' + hex(r) + "). Check the mode dial isn't on video and the camera's menu is closed.");
    }
    await waitReady(10000);
    const handles = [];
    const checkedFmt = new Map();
    const add = (l) => { for (const h of l) if (!handles.includes(h)) handles.push(h); };
    const ew = Date.now();
    let foundJpeg = false;
    while (Date.now() - ew < 8000) {
      add(await events());
      if (handles.length > 0) {
        if (!shotToCard) {
          // From the start (so the autofocus above counts: it is most of a Nikon's delay) until the camera reports the photo.
          // The booth fires the shutter that much earlier, so the photo lands on "Pose".
          d.lastShutterMs = Math.min(Date.now() - t0, 10000);
          log('Shutter lag ' + d.lastShutterMs + ' ms');
          await sleep(150); add(await events()); break;
        }
        for (const h of handles) {
          if (checkedFmt.has(h)) continue;
          try {
            const oi = await ptp.opRead(0x1008, h);
            const fmt = (oi.resp === OK && oi.data.length > 6) ? oi.data.readUInt16LE(4) : 0;
            checkedFmt.set(h, fmt);
            if (fmt === 0x3801 || fmt === 0x3808) foundJpeg = true;
          } catch (e) { if (e instanceof GoneError) throw e; }
        }
        if (foundJpeg || Date.now() - ew > 3500) {
          d.lastShutterMs = Math.min(Date.now() - t0, 10000);
          log('Shutter lag ' + d.lastShutterMs + ' ms');
          await sleep(120); add(await events()); break;
        }
      }
      await sleep(100);
    }
    if (handles.length === 0 && !shotToCard) handles.push(0xFFFF0001);   // the photo in the camera's memory
    if (handles.length === 0) throw new CamError("CAPTURE The photo didn't come through from the camera (no file announced). Check the SD card isn't full or write-protected.");
    let pick = handles[0];
    if (handles.length > 1) {
      // RAW + JPEG: take the JPEG
      for (const h of handles) {
        if (checkedFmt.get(h) === 0x3801 || checkedFmt.get(h) === 0x3808) { pick = h; break; }
        if (checkedFmt.has(h)) continue;
        try {
          const oi = await ptp.opRead(0x1008, h);
          const f = (oi.resp === OK && oi.data.length > 6) ? oi.data.readUInt16LE(4) : 0;
          if (f === 0x3801 || f === 0x3808) { pick = h; break; }
        } catch (e) { if (e instanceof GoneError) throw e; }
      }
    }
    const pickFmt = checkedFmt.get(pick) || 0;
    if (pick !== 0xFFFF0001 && (pickFmt === 0x3000 || pickFmt === 0xB101 || pickFmt === 0xB103 || pickFmt === 0xB108)) {
      throw new CamError('CAPTURE The camera saved a RAW photo. Set Image quality to JPEG or RAW + JPEG on the camera.');
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

  const nearChoice = (desc, want, scale) => {
    let best = null, bestD = Infinity;
    for (const c of desc.choices || []) {
      const v = Number(c);
      if (!Number.isFinite(v)) continue;
      const x = v * scale;
      if (x <= 0 || x > 60000) continue;
      const dd = Math.abs(Math.log(x) - Math.log(want));
      if (dd < bestD) { bestD = dd; best = c; }
    }
    return best;
  };

  async function nikonPropFor(stillCode, movieCode, inMovieLv) {
    if (inMovieLv && movieCode) {
      try { const md = await propDesc(movieCode); if (md && md.choices.length > 0) return { code: movieCode, desc: md }; } catch { /* ignore */ }
    }
    return { code: stillCode, desc: await propDesc(stillCode) };
  }

  d.props = async () => {
    let inMovieLv = false;
    try { const lvs = await propDesc(0xD1A6); if (lvs && lvs.current === '1') inMovieLv = true; } catch { /* ignore */ }
    let m = null, t = null, f = null, i = null, wb = null;
    try {
      m = await propDesc(0x500E);
      t = (await nikonPropFor(0x500D, 0xD1A8, inMovieLv)).desc;
      f = (await nikonPropFor(0x5007, 0xD1A9, inMovieLv)).desc;
      i = (await nikonPropFor(0x500F, 0xD1AA, inMovieLv)).desc;
      try { wb = await propDesc(0x5005); } catch { /* ignore */ }
    } catch (e) { if (e instanceof GoneError) throw e; }
    if (!t && !f && !i) return { supported: false };
    const canSet = (desc) => !!(desc && desc.getSet === 1 && desc.choices.length > 0);
    const num = (desc) => desc && Number.isFinite(Number(desc.current)) ? Number(desc.current) : 0;
    const out = {
      supported: true,
      program: Math.round(num(m)),
      shutter: num(t) * 0.0001,
      f: num(f) / 100,
      iso: Math.round(num(i)),
      set: { shutter: canSet(t), f: canSet(f), iso: canSet(i) }
    };
    if (wb) {
      out.wb = Math.round(num(wb));
      out.wbChoices = wb.choices.map((c) => {
        const id = Number(c), idx = NIKON_WB_IDS.indexOf(id);
        return idx >= 0 ? { v: id, label: NIKON_WB_NAMES[idx] } : null;
      }).filter(Boolean);
      out.set.wb = canSet(wb);
    }
    return out;
  };

  d.setProps = async (arg) => {
    const want = new Map();
    for (const kv of String(arg || '').split(/[&\s]+/).filter(Boolean)) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq), v = Number(kv.slice(eq + 1));
      if (Number.isFinite(v) && (k === 'wb' ? v >= 0 : v > 0)) want.set(k, v);
    }
    let inMovieLv = false;
    try { const lvs = await propDesc(0xD1A6); if (lvs && lvs.current === '1') inMovieLv = true; } catch { /* ignore */ }
    const results = {};
    for (const [key, stillCode, movieCode, scale] of [
      ['shutter', 0x500D, 0xD1A8, 0.0001],
      ['f', 0x5007, 0xD1A9, 0.01],
      ['iso', 0x500F, 0xD1AA, 1]
    ]) {
      if (!want.has(key)) continue;
      try {
        const { code, desc } = await nikonPropFor(stillCode, movieCode, inMovieLv);
        if (!desc) results[key] = 'unsupported';
        else if (desc.getSet !== 1 || desc.choices.length === 0) results[key] = 'locked';
        else {
          const pick = nearChoice(desc, want.get(key), scale);
          results[key] = pick === null ? 'unsupported' : pick === desc.current ? 'same' : (await setProp(code, desc.type, pick)) ? 'set' : 'refused';
        }
      } catch (e) { if (e instanceof GoneError) throw e; results[key] = 'refused'; }
    }
    if (want.has('wb')) {
      try {
        const wd = await propDesc(0x5005);
        const target = String(Math.round(want.get('wb')));
        if (!wd) results.wb = 'unsupported';
        else if (wd.getSet !== 1 || wd.choices.length === 0) results.wb = 'locked';
        else if (!wd.choices.includes(target)) results.wb = 'unsupported';
        else results.wb = wd.current === target ? 'same' : (await setProp(0x5005, wd.type, target)) ? 'set' : 'refused';
      } catch (e) { if (e instanceof GoneError) throw e; results.wb = 'refused'; }
    }
    return { ...(await d.props()), results };
  };

  async function restoreMovieProps() {
    try {
      if (prevLvSel) {
        if (d.live) { try { await ptp.op(0x9202); await waitReady(1500); } catch { /* ignore */ } d.live = false; }
        try { await setProp(0xD1A6, prevLvSel.type, prevLvSel.value); } catch { /* ignore */ }
        prevLvSel = null;
      }
    } finally {
      if (prevMedia) {
        try { await setProp(0xD10B, prevMedia.type, prevMedia.value); } catch { /* ignore */ }
        prevMedia = null;
      }
    }
  }

  d.movieStart = async () => {
    if (movieRec) return { ok: true, brand: 'nikon', recording: true };
    await drain();
    try {
      let rmed = null;
      try { rmed = await propDesc(0xD10B); } catch (e) { if (e instanceof GoneError) throw e; }
      if (rmed && rmed.current !== '0') {
        prevMedia = { type: rmed.type, value: rmed.current };
        if (!(await setProp(0xD10B, rmed.type, '0'))) {
          prevMedia = null;
          throw new CamError("CAPTURE Couldn't switch Nikon recording media to SD Card for movie capture. Insert an SD card with free space.");
        }
      }
      let lvs = null;
      try { lvs = await propDesc(0xD1A6); } catch (e) { if (e instanceof GoneError) throw e; }
      if (lvs && lvs.current !== '1' && lvs.getSet === 1 && lvs.choices.includes('1')) {
        prevLvSel = { type: lvs.type, value: lvs.current };
        if (d.live) { await d.liveOff(); await waitReady(2000); }
        if (!(await setProp(0xD1A6, lvs.type, '1'))) prevLvSel = null;
      }
      if (!d.live) await d.liveOn();
      await drain();
      let r = await ptp.op(0x920A);
      if (r === BUSY) { await waitReady(2500); r = await ptp.op(0x920A); }
      if (r !== OK) {
        throw new CamError("CAPTURE The Nikon camera didn't start movie recording (" + hex(r) + '). Flip the photo/movie selector to Movie, insert an SD card with free space, and close any open camera menu.');
      }
      movieRec = true;
      log('Nikon movie recording started');
      return { ok: true, brand: 'nikon', recording: true };
    } catch (e) {
      await restoreMovieProps();
      throw e;
    }
  };

  d.movieStop = async (outDir) => {
    const t0 = Date.now();
    try {
      try {
        let r = await ptp.op(0x920B);
        if (r === BUSY) { await waitReady(2500); r = await ptp.op(0x920B); }
        await waitReady(5000);
      } finally { movieRec = false; }

      const handles = [];
      const add = (l) => { for (const h of l) if (!handles.includes(h)) handles.push(h); };
      const ew = Date.now();
      let pickHandle = 0, pickSize = 0, pickExt = '.mov';
      while (Date.now() - ew < 15000) {
        add(await events());
        if (handles.length > 0) {
          await sleep(200);
          add(await events());
          let bestH = 0, bestSz = 0, bestExt = '.mov';
          for (const h of handles) {
            const meta = await ptpObjectMeta(ptp, h);
            if (isStillOrRaw(meta.fmt, meta.ext)) continue;
            const ext = meta.ext || (meta.fmt === 0xB982 ? '.mp4' : meta.fmt === 0x300B ? '.avi' : '.mov');
            if (!bestH || meta.size > bestSz) { bestH = h; bestSz = meta.size; bestExt = ext; }
          }
          if (bestH) { pickHandle = bestH; pickSize = bestSz; pickExt = bestExt; break; }
        }
        await sleep(100);
      }
      if (!pickHandle) {
        throw new CamError('CAPTURE The Nikon stopped recording, but no movie file appeared from the camera. Make sure an SD card with free space is inserted.');
      }
      const res = await streamObjectToFile(ptp, pickHandle, pickSize, pickExt, outDir, 'nikon-360-');
      log('Nikon movie downloaded: ' + res.filename + ' (' + Math.round(res.bytes / 1024) + ' KB) in ' + (Date.now() - t0) + ' ms');
      return { ok: true, brand: 'nikon', path: res.path, filename: res.filename, bytes: res.bytes, format: res.format };
    } finally {
      await restoreMovieProps();
    }
  };

  d.close = async () => {
    try { if (movieRec) { await ptp.op(0x920B); movieRec = false; } } catch { /* ignore */ }
    await restoreMovieProps().catch(() => {});
    if (d.live) { try { await ptp.op(0x9202); } catch { /* ignore */ } }
    d.live = false;
  };

  return d;
}
