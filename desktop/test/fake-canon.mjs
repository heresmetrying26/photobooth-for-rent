// A simulated Canon EOS (PTP over a fake USB pipe) to run lib/camera-mac.mjs end to end.
// Covers: Canon DSLR with 0x9128 + SaveTo=Host (0xD11C=4 + 0x911A PCHDDCapacity + 0xC186 RAM 0x101B download),
// Canon Mirrorless (EOS R50) with 0x9128(3, ...), and older DSLR with 0x910F card-only.
// Run: node desktop/test/fake-canon.mjs   (no camera needed)
const { PtpSession } = await import('../lib/ptp.mjs');
const cam = await import('../lib/camera-mac.mjs');

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 7), Buffer.from([0xFF, 0xD9])]);
const PHOTO = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), Buffer.alloc(200000, 9), Buffer.from([0xFF, 0xD9])]);

function pstr(s) { const b = Buffer.alloc(1 + (s.length + 1) * 2); b[0] = s.length + 1; b.write(s, 1, 'utf16le'); return b; }
function arr16(a) { const b = Buffer.alloc(4 + 2 * a.length); b.writeUInt32LE(a.length, 0); a.forEach((v, i) => b.writeUInt16LE(v, 4 + 2 * i)); return b; }
function deviceInfo(model, newer, hostMode) {
  let ops = [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x101B, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x9118, 0x9151, 0x9152, 0x9153, 0x911D, 0x9107];
  if (hostMode) ops.push(0x911A);
  ops = ops.concat(newer ? [0x9128, 0x9129] : [0x910F]);
  const h = Buffer.alloc(8); h.writeUInt16LE(100, 0); h.writeUInt32LE(0x0B, 2); h.writeUInt16LE(100, 6);
  return Buffer.concat([h, pstr('canon.com: 1.0'), Buffer.from([0, 0]), arr16(ops), arr16([]), arr16([]), arr16([]), arr16([0x3801]), pstr('Canon Inc.'), pstr(model), pstr('1.0'), pstr('123')]);
}
function evCard(handle, fmt, size) {
  const b = Buffer.alloc(0x24); b.writeUInt32LE(0x24, 0); b.writeUInt32LE(0xC181, 4); b.writeUInt32LE(handle, 8); b.writeUInt16LE(fmt, 0x10); b.writeUInt32LE(size, 0x1C); return b;
}
function evRam(handle, fmt, size) {
  const b = Buffer.alloc(0x18); b.writeUInt32LE(0x18, 0); b.writeUInt32LE(0xC186, 4); b.writeUInt32LE(handle, 8); b.writeUInt16LE(fmt, 0x0C); b.writeUInt32LE(size, 0x14); return b;
}
function evProp(prop, val) {
  const b = Buffer.alloc(16); b.writeUInt32LE(16, 0); b.writeUInt32LE(0xC189, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(val >>> 0, 12); return b;
}
function evAvail(prop, vals) {
  const b = Buffer.alloc(20 + vals.length * 4);
  b.writeUInt32LE(b.length, 0); b.writeUInt32LE(0xC18A, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(6, 12); b.writeUInt32LE(vals.length, 16);
  vals.forEach((v, i) => b.writeUInt32LE(v >>> 0, 20 + i * 4));
  return b;
}

class FakeCanon {
  constructor({ model, newer, dslr, hostMode, keepCardLcd = false, aspectRatio = 0, refuseAspect = false }) {
    this.model = model; this.newer = newer; this.dslr = dslr; this.hostMode = hostMode; this.keepCardLcd = keepCardLcd;
    this.aspectRatio = aspectRatio; this.refuseAspect = refuseAspect;
    this.queue = []; this.pendingWrite = null; this.events = []; this.live = false; this.liveOut = 0;
    this.log = []; this.remote = 0; this.sessionOpen = false;
    this.saveTo = 2; this.availShots = 500; this.halfPressed = false;
    this.liveWhenShot = null; this.sawCap = false; this.sawParam3 = false;
    this.sawPartial = false; this.doneHandles = []; this.cancelHandles = [];
  }
  async write(buf) {
    if (this.pendingWrite) { const pw = this.pendingWrite; this.pendingWrite = null; this.onData(pw, buf.subarray(12)); return; }
    const len = buf.readUInt32LE(0), type = buf.readUInt16LE(4), code = buf.readUInt16LE(6), tid = buf.readUInt32LE(8);
    if (type !== 1) throw new Error('not a command');
    const ps = []; for (let o = 12; o + 4 <= len; o += 4) ps.push(buf.readUInt32LE(o));
    this.log.push(code.toString(16));
    if (code === 0x9110) { this.pendingWrite = { code, tid }; return; }
    this.handle(code, tid, ps);
  }
  onData(pw, data) {
    const prop = data.readUInt32LE(4), val = data.readUInt32LE(8);
    if (prop === 0xD1B0) { this.liveOut = val; this.live = (val === 2 || val === 3); this.events.push(evProp(0xD1B0, val)); }
    else if (prop === 0xD11C) {
      this.saveTo = val;
      this.events.push(evProp(0xD11C, val));
      // Realistic Canon EOS firmware: switching to Host (4) drops AvailableShots to 0 until 0x911A is sent!
      if (val === 4) { this.availShots = 0; this.events.push(evProp(0xD11B, 0)); }
      else { this.availShots = 500; this.events.push(evProp(0xD11B, 500)); }
    } else if (prop === 0xD194) {
      if (this.refuseAspect) { this.respond(pw.tid, 0x2005); return; }
      this.aspectRatio = val;
      this.events.push(evProp(0xD194, val));
    }
    this.respond(pw.tid, 0x2001);
  }
  dataOut(tid, code, data) { const h = Buffer.alloc(12); h.writeUInt32LE(12 + data.length, 0); h.writeUInt16LE(2, 4); h.writeUInt16LE(code, 6); h.writeUInt32LE(tid, 8); this.queue.push(Buffer.concat([h, data])); }
  respond(tid, resp, ps = []) { const b = Buffer.alloc(12 + 4 * ps.length); b.writeUInt32LE(b.length, 0); b.writeUInt16LE(3, 4); b.writeUInt16LE(resp, 6); b.writeUInt32LE(tid, 8); ps.forEach((p, i) => b.writeUInt32LE(p, 12 + 4 * i)); this.queue.push(b); }
  emitPhoto() {
    this.liveWhenShot = this.live;
    if (this.saveTo === 4) {
      if (this.availShots === 0) return;   // firmware refuses capture when 0x911A wasn't sent!
      this.events.push(evRam(0x2001, 0xB103, PHOTO.length));   // RAW (should be skipped + cancelled via 0x9118)
      this.events.push(evRam(0x2002, 0x3801, PHOTO.length));   // JPEG (should be downloaded via 0x101B + completed via 0x9117)
    } else {
      this.events.push(evCard(0x1234, 0x3801, PHOTO.length));
    }
  }
  handle(code, tid, ps) {
    switch (code) {
      case 0x1002: this.sessionOpen = true; return this.respond(tid, 0x2001);
      case 0x1003: this.sessionOpen = false; return this.respond(tid, 0x2001);
      case 0x1001: this.dataOut(tid, code, deviceInfo(this.model, this.newer, this.hostMode)); return this.respond(tid, 0x2001);
      case 0x9114: this.remote = ps[0]; return this.respond(tid, 0x2001);
      case 0x9115:
        if (ps[0] === 1 && this.hostMode) {
          this.events.push(evProp(0xD11C, this.saveTo), evAvail(0xD11C, [2, 4, 6]), evProp(0xD11B, this.availShots), evProp(0xD108, 3));
        }
        if (ps[0] === 1 && this.aspectRatio !== undefined) {
          this.events.push(evProp(0xD194, this.aspectRatio));
        }
        return this.respond(tid, 0x2001);
      case 0x911A:
        this.sawCap = true;
        this.availShots = 9999;
        this.events.push(evProp(0xD11B, 9999));
        return this.respond(tid, 0x2001);
      case 0x911D: return this.respond(tid, 0x2001);
      case 0x9151: return this.respond(tid, 0x2001);
      case 0x9152: this.live = false; return this.respond(tid, 0x2001);
      case 0x9116: {
        const b = Buffer.concat(this.events.length ? this.events : [Buffer.alloc(8)]);
        this.events = [];
        this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
      }
      case 0x9153:
        if (!this.live) return this.respond(tid, 0xA102);
        { const blk = Buffer.alloc(8 + JPEG.length); blk.writeUInt32LE(blk.length, 0); blk.writeUInt32LE(1, 4); JPEG.copy(blk, 8); this.dataOut(tid, code, blk); return this.respond(tid, 0x2001); }
      case 0x9128:
        if (ps[0] === 3) {
          this.sawParam3 = true;
          if (!this.dslr) this.emitPhoto();   // EOS-M / R mirrorless accepts param1=3; DSLRs ignore/reject it
        } else if (ps[0] === 1) {
          this.halfPressed = true;
        } else if (ps[0] === 2 && this.halfPressed) {
          this.emitPhoto();
        }
        return this.respond(tid, 0x2001);
      case 0x9129:
        if (ps[0] === 1) this.halfPressed = false;
        return this.respond(tid, 0x2001);
      case 0x910F: this.emitPhoto(); return this.respond(tid, 0x2001, [0]);
      case 0x101B: {
        this.sawPartial = true;
        const off = ps[1] || 0, max = ps[2] || PHOTO.length;
        this.dataOut(tid, code, PHOTO.subarray(off, Math.min(PHOTO.length, off + max)));
        return this.respond(tid, 0x2001);
      }
      case 0x1009: this.dataOut(tid, code, PHOTO); return this.respond(tid, 0x2001);
      case 0x1008: { const b = Buffer.alloc(16); b.writeUInt32LE(PHOTO.length, 8); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      case 0x9117: this.doneHandles.push(ps[0]); return this.respond(tid, 0x2001);
      case 0x9118: this.cancelHandles.push(ps[0]); return this.respond(tid, 0x2001);
      default: return this.respond(tid, 0x2005);
    }
  }
  async read() { if (!this.queue.length) throw new Error('fake: nothing to read'); return this.queue.shift(); }
  async close() { this.closed = true; }
}

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); if (!ok) failed++; };

const cases = [
  { tag: '[Canon EOS 60D DSLR host+0x9128] ', model: 'Canon EOS 60D', newer: true, dslr: true, hostMode: true },
  { tag: '[Canon EOS 1300D DSLR 16:9->3:2] ', model: 'Canon EOS 1300D', newer: true, dslr: true, hostMode: true, aspectRatio: 3 },
  { tag: '[Canon EOS 1300D DSLR 16:9 refused] ', model: 'Canon EOS 1300D', newer: true, dslr: true, hostMode: true, aspectRatio: 3, refuseAspect: true },
  { tag: '[Canon EOS 1500D DSLR card+LCD] ', model: 'Canon EOS 1500D', newer: true, dslr: true, hostMode: true, keepCardLcd: true },
  { tag: '[Canon EOS R50 Mirrorless host+0x9128] ', model: 'Canon EOS R50', newer: true, dslr: false, hostMode: true },
  { tag: '[Older Canon EOS 550D DSLR card+0x910F] ', model: 'Canon EOS 550D', newer: false, dslr: true, hostMode: false }
];

for (const tc of cases) {
  const fake = new FakeCanon(tc);
  cam.setBackend({
    list: () => [{ vendor: 0x04a9, product: 0x32e1, key: '1:2' }, { vendor: 0x05ac, product: 0x1234, key: '1:3' }],
    open: async () => new PtpSession(fake),
    free: async () => {}
  });
  const tag = tc.tag;
  const l = JSON.parse((await cam.call('list')).body.toString());
  check(tag + 'list: one Canon camera', l.devices.filter((d) => d.camera).length === 1);
  const o = await cam.call('open', '');
  check(tag + 'open', o.status === 'OK', o.body.toString().slice(0, 120));
  const info = JSON.parse(o.body.toString());
  const expectHost = tc.hostMode && !tc.keepCardLcd;
  check(tag + 'name & canonDslr & saveTo', info.name === tc.model && info.canonDslr === tc.dslr && info.canonKeepLive === !!tc.keepCardLcd && info.saveTo === (expectHost ? 'host' : 'card'), JSON.stringify({ name: info.name, dslr: info.canonDslr, keepLive: info.canonKeepLive, saveTo: info.saveTo }));
  if (tc.aspectRatio) {
    if (tc.refuseAspect) {
      check(tag + 'refused 0xD194 sets aspectCrop=true', info.aspectCrop === true && fake.aspectRatio === tc.aspectRatio, JSON.stringify({ aspectCrop: info.aspectCrop, ar: fake.aspectRatio }));
    } else {
      check(tag + 'switches 0xD194 to 3:2 (0) and clears aspectCrop', info.aspectCrop === false && fake.aspectRatio === 0, JSON.stringify({ aspectCrop: info.aspectCrop, ar: fake.aspectRatio }));
    }
  }
  if (expectHost) check(tag + 'called 0x911A PCHDDCapacity on host open', fake.sawCap === true && fake.saveTo === 4);
  if (tc.keepCardLcd) check(tag + 'kept SD card (SaveTo=2) and skipped host switch', fake.sawCap === false && fake.saveTo === 2 && info.toCard === false);
  const lv = await cam.call('live', 'on');
  check(tag + 'live on', lv.status === 'OK' && fake.live === true && fake.liveOut === (tc.keepCardLcd ? 3 : 2), 'liveOut=' + fake.liveOut);
  const f = await cam.call('frame', '');
  check(tag + 'frame is the JPEG', f.status === 'OK' && f.kind === 'B' && f.body.equals(JPEG));
  const c = await cam.call('capture', '');
  check(tag + 'capture is the full photo', c.status === 'OK' && c.kind === 'B' && c.body.equals(PHOTO), c.status === 'OK' ? '' : c.body.toString());
  if (tc.dslr && !tc.keepCardLcd) {
    check(tag + 'DSLR drops live view before shutter (mechanical X-sync)', fake.liveWhenShot === false);
    check(tag + 'DSLR never sends EOS-M param1=3', fake.sawParam3 === false);
  }
  if (tc.keepCardLcd) {
    check(tag + '1500D keeps live view active before shutter and never sends param1=3', fake.liveWhenShot === true && fake.sawParam3 === false);
  }
  if (expectHost) {
    check(tag + 'RAM object downloaded via 0x101B + 0x9117 done + 0x9118 cancel RAW', fake.sawPartial && fake.doneHandles.includes(0x2002) && fake.cancelHandles.includes(0x2001), JSON.stringify({ p: fake.sawPartial, done: fake.doneHandles, cancel: fake.cancelHandles }));
  }
  const f2 = await cam.call('frame', '');
  check(tag + 'live view restarts after the photo', f2.status === 'OK' && f2.kind === 'B');
  const x = await cam.call('close', '');
  check(tag + 'close restores card saveTo, aspect ratio & leaves remote mode', x.status === 'OK' && fake.remote === 0 && fake.saveTo === 2 && fake.closed === true && (!tc.aspectRatio || fake.aspectRatio === tc.aspectRatio), JSON.stringify({ remote: fake.remote, saveTo: fake.saveTo, ar: fake.aspectRatio }));
  const g = await cam.call('frame', '');
  check(tag + 'frame after close says GONE', g.status === 'GONE', g.body.toString().slice(0, 60));
}
console.log(failed ? failed + ' FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
