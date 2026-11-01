// Simulated Nikon and Sony Alpha cameras (PTP over a fake USB pipe) to run lib/camera-mac.mjs end to end.
// Run: node desktop/test/fake-nikon-sony.mjs   (no camera needed; the Sony run takes ~7 s because the real camera needs 3 s to settle)
const { PtpSession } = await import('../lib/ptp.mjs');
const cam = await import('../lib/camera-mac.mjs');

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 7), Buffer.from([0xFF, 0xD9])]);
const PHOTO = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), Buffer.alloc(200000, 9), Buffer.from([0xFF, 0xD9])]);

const pstr = (s) => { const b = Buffer.alloc(1 + (s.length + 1) * 2); b[0] = s.length + 1; b.write(s, 1, 'utf16le'); return b; };
const arr16 = (a) => { const b = Buffer.alloc(4 + 2 * a.length); b.writeUInt32LE(a.length, 0); a.forEach((v, i) => b.writeUInt16LE(v, 4 + 2 * i)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
function deviceInfo(vendorExt, ops, props, maker, model) {
  const h = Buffer.alloc(8); h.writeUInt16LE(100, 0); h.writeUInt32LE(vendorExt, 2); h.writeUInt16LE(100, 6);
  return Buffer.concat([h, pstr('ext: 1.0'), Buffer.from([0, 0]), arr16(ops), arr16([]), arr16(props), arr16([]), arr16([0x3801]), pstr(maker), pstr(model), pstr('1.0'), pstr('123')]);
}

class Fake {
  constructor() { this.queue = []; this.pendingWrite = null; this.sessionOpen = false; this.log = []; }
  async write(buf) {
    if (this.pendingWrite) { const pw = this.pendingWrite; this.pendingWrite = null; this.onData(pw, buf.subarray(12)); return; }
    const len = buf.readUInt32LE(0), type = buf.readUInt16LE(4), code = buf.readUInt16LE(6), tid = buf.readUInt32LE(8);
    if (type !== 1) throw new Error('not a command');
    const ps = []; for (let o = 12; o + 4 <= len; o += 4) ps.push(buf.readUInt32LE(o));
    this.log.push(code.toString(16));
    if (this.writes && this.writes.includes(code)) { this.pendingWrite = { code, tid, ps }; return; }
    this.handle(code, tid, ps);
  }
  dataOut(tid, code, data) { const h = Buffer.alloc(12); h.writeUInt32LE(12 + data.length, 0); h.writeUInt16LE(2, 4); h.writeUInt16LE(code, 6); h.writeUInt32LE(tid, 8); this.queue.push(Buffer.concat([h, data])); }
  respond(tid, resp, ps = []) { const b = Buffer.alloc(12 + 4 * ps.length); b.writeUInt32LE(b.length, 0); b.writeUInt16LE(3, 4); b.writeUInt16LE(resp, 6); b.writeUInt32LE(tid, 8); ps.forEach((p, i) => b.writeUInt32LE(p, 12 + 4 * i)); this.queue.push(b); }
  common(code, tid) {
    if (code === 0x1002) { this.sessionOpen = true; this.respond(tid, 0x2001); return true; }
    if (code === 0x1003) { this.sessionOpen = false; this.respond(tid, 0x2001); return true; }
    return false;
  }
  async read() { if (!this.queue.length) throw new Error('fake: nothing to read'); return this.queue.shift(); }
  async close() { this.closed = true; }
}

// ---------- Nikon D5600 ----------
class FakeNikon extends Fake {
  constructor() {
    super();
    this.writes = [0x1016];
    this.live = false; this.events = []; this.set = new Map();
    this.cur = new Map([[0xD10B, '0'], [0x5004, '4'], [0x5003, '6000x4000']]);
  }
  desc(code) {
    if (code === 0xD10B) return Buffer.concat([u16(code), u16(2), Buffer.from([1, 0, Number(this.cur.get(code))]), Buffer.from([0])]);
    if (code === 0x5004) return Buffer.concat([u16(code), u16(4), Buffer.from([1]), u16(1), u16(Number(this.cur.get(code))), Buffer.from([2]), u16(3), u16(0), u16(2), u16(4)]);
    if (code === 0x5003) return Buffer.concat([u16(code), u16(0xFFFF), Buffer.from([1]), pstr('6000x4000'), pstr(this.cur.get(code)), Buffer.from([2]), u16(3), pstr('6000x4000'), pstr('2992x2000'), pstr('1496x1000')]);
    return null;
  }
  onData(pw, data) {
    const code = pw.ps[0];
    if (code === 0x5003) { const n = data[0]; this.cur.set(code, data.toString('utf16le', 1, 1 + (n - 1) * 2)); }
    else this.cur.set(code, String(data.length === 1 ? data[0] : data.readUInt16LE(0)));
    this.set.set(code, this.cur.get(code));
    this.respond(pw.tid, 0x2001);
  }
  handle(code, tid, ps) {
    if (this.common(code, tid)) return;
    switch (code) {
      case 0x1001: this.dataOut(tid, code, deviceInfo(0x0A, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x1014, 0x1015, 0x1016, 0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203], [0x5001, 0x5003, 0x5004], 'Nikon Corporation', 'D5600')); return this.respond(tid, 0x2001);
      case 0x1014: { const d = this.desc(ps[0]); if (!d) return this.respond(tid, 0x200A); this.dataOut(tid, code, d); return this.respond(tid, 0x2001); }
      case 0x1015: this.dataOut(tid, code, Buffer.from([87])); return this.respond(tid, 0x2001);
      case 0x90C8: return this.respond(tid, 0x2001);
      case 0x9201: this.live = true; return this.respond(tid, 0x2001);
      case 0x9202: this.live = false; return this.respond(tid, 0x2001);
      case 0x9203: {
        if (!this.live) return this.respond(tid, 0xA00B);
        this.dataOut(tid, code, Buffer.concat([Buffer.alloc(64, 1), JPEG])); return this.respond(tid, 0x2001);
      }
      case 0x90C1: return this.respond(tid, 0x2001);
      case 0x90C0: this.events.push([0xC101, 0x1234]); this.live = false; return this.respond(tid, 0x2001);
      case 0x90C7: {
        const b = Buffer.alloc(2 + 6 * this.events.length); b.writeUInt16LE(this.events.length, 0);
        this.events.forEach((e, i) => { b.writeUInt16LE(e[0], 2 + 6 * i); b.writeUInt32LE(e[1], 4 + 6 * i); });
        this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
      }
      case 0x1008: { const b = Buffer.alloc(16); b.writeUInt16LE(0x3801, 4); b.writeUInt32LE(PHOTO.length, 8); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      case 0x1009: this.dataOut(tid, code, PHOTO); return this.respond(tid, 0x2001);
      default: return this.respond(tid, 0x2005);
    }
  }
}

// ---------- Sony A7 III (PC Remote) ----------
class FakeSony extends Fake {
  constructor() {
    super();
    this.writes = [0x9205, 0x9207];
    this.dest = 0x11; this.mem = 0; this.half = false; this.connected = 0; this.priority = 0;
  }
  entry(code, val) { return Buffer.concat([u16(code), u16(4), Buffer.from([1, 1]), u16(0), u16(val), Buffer.from([0])]); }
  blob() { return Buffer.concat([Buffer.alloc(8), this.entry(0xD222, this.dest), this.entry(0xD215, this.mem), this.entry(0xD213, this.half ? 2 : 1), this.entry(0x500A, 2)]); }
  onData(pw, data) {
    const prop = pw.ps[0];
    if (pw.code === 0x9205) { if (prop === 0xD222) this.dest = data.readUInt16LE(0); if (prop === 0xD25A) this.priority = data[0]; }
    if (pw.code === 0x9207) {
      const v = data.readUInt16LE(0);
      if (prop === 0xD2C1) this.half = v === 2;
      if (prop === 0xD2C2 && v === 2) this.mem = 0x8001;
    }
    this.respond(pw.tid, 0x2001);
  }
  handle(code, tid, ps) {
    if (this.common(code, tid)) return;
    switch (code) {
      case 0x1001: this.dataOut(tid, code, deviceInfo(0x11, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9201, 0x9202, 0x9205, 0x9207, 0x9209], [], 'Sony Corporation', 'ILCE-7M3')); return this.respond(tid, 0x2001);
      case 0x9201: this.connected = ps[0]; return this.respond(tid, 0x2001);
      case 0x9202: { const b = Buffer.alloc(8); b.writeUInt16LE(0x12C, 0); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      case 0x9209: this.dataOut(tid, code, this.blob()); return this.respond(tid, 0x2001);
      case 0x1008: { const b = Buffer.alloc(16); b.writeUInt32LE(ps[0] === 0xFFFFC001 ? PHOTO.length : JPEG.length, 8); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      case 0x1009:
        if (ps[0] === 0xFFFFC002) { const head = Buffer.alloc(16); head.writeUInt32LE(16, 0); this.dataOut(tid, code, Buffer.concat([head, JPEG])); return this.respond(tid, 0x2001); }
        this.mem = 0; this.dataOut(tid, code, PHOTO); return this.respond(tid, 0x2001);
      default: return this.respond(tid, 0x2005);
    }
  }
}

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); if (!ok) failed++; };

async function run(tag, vendor, fake, want) {
  cam.setBackend({
    list: () => [{ vendor, product: 0x1234, key: '1:2' }, { vendor: 0x05ac, product: 0x1234, key: '1:3' }],
    open: async () => new PtpSession(fake),
    free: async () => {}
  });
  const l = JSON.parse((await cam.call('list')).body.toString());
  check(tag + 'list: one camera', l.devices.filter((d) => d.camera).length === 1 && l.devices[0].maker === want.maker);
  const o = await cam.call('open', '');
  const info = o.status === 'OK' ? JSON.parse(o.body.toString()) : {};
  check(tag + 'open', o.status === 'OK', o.status === 'OK' ? '' : o.body.toString().slice(0, 160));
  check(tag + 'name ' + want.name + ', brand ' + want.brand, info.name === want.name && info.brand === want.brand, JSON.stringify(info.name) + ' ' + info.brand);
  const lv = await cam.call('live', 'on');
  check(tag + 'live on', lv.status === 'OK');
  const f = await cam.call('frame', '');
  check(tag + 'frame is the JPEG', f.status === 'OK' && f.kind === 'B' && f.body.equals(JPEG), f.status === 'OK' ? '' : f.body.toString());
  const c = await cam.call('capture', '');
  check(tag + 'capture is the full photo', c.status === 'OK' && c.kind === 'B' && c.body.equals(PHOTO), c.status === 'OK' ? '' : c.body.toString());
  const f2 = await cam.call('frame', '');
  check(tag + 'live view carries on after the photo', f2.status === 'OK' && f2.kind === 'B' && f2.body.equals(JPEG), f2.status === 'OK' ? '' : f2.body.toString());
  const b = JSON.parse((await cam.call('battery', '')).body.toString());
  check(tag + 'battery ' + want.battery, b.battery === want.battery, String(b.battery));
  const x = await cam.call('close', '');
  check(tag + 'close', x.status === 'OK' && fake.closed === true);
  const g = await cam.call('frame', '');
  check(tag + 'frame after close says GONE', g.status === 'GONE', g.body.toString().slice(0, 60));
}

const nik = new FakeNikon();
await run('[Nikon] ', 0x04b0, nik, { maker: 'Nikon', name: 'Nikon D5600', brand: 'nikon', battery: 87 });
check('[Nikon] records to camera memory', nik.set.get(0xD10B) === '1');
check('[Nikon] image quality set to JPEG Fine', nik.set.get(0x5004) === '2');
check('[Nikon] photo size is the smallest >= 2900 px wide', nik.set.get(0x5003) === '2992x2000', String(nik.set.get(0x5003)));
check('[Nikon] live view stopped on close', nik.live === false);

const son = new FakeSony();
await run('[Sony] ', 0x054c, son, { maker: 'Sony', name: 'Sony A7 III', brand: 'sony', battery: -1 });
check('[Sony] connect phases ran (3)', son.connected === 3);
check('[Sony] remote control has priority', son.priority === 1);
check('[Sony] photos go to the computer only', son.dest === 0x01, '0x' + son.dest.toString(16));
check('[Sony] shutter released at the end', son.half === false);

// A Sony left in file-transfer mode lists no remote commands: say so.
class FakeSonyDrive extends FakeSony {
  handle(code, tid, ps) {
    if (code === 0x1001 && !this.common(code, tid)) { this.dataOut(tid, code, deviceInfo(0x11, [0x1001, 0x1002, 0x1003], [], 'Sony Corporation', 'ILCE-7M3')); return this.respond(tid, 0x2001); }
    return super.handle(code, tid, ps);
  }
}
cam.setBackend({ list: () => [{ vendor: 0x054c, product: 1, key: '1:2' }], open: async () => new PtpSession(new FakeSonyDrive()), free: async () => {} });
const m = await cam.call('open', '');
check('[Sony] file-transfer mode says MODE and PC Remote', m.status === 'ERR' && /^MODE /.test(m.body.toString()) && /PC Remote/.test(m.body.toString()), m.body.toString().slice(0, 80));

console.log(failed ? failed + ' FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
