// A simulated Canon EOS (PTP over a fake USB pipe) to run lib/camera-mac.mjs end to end.
// Run: node desktop/test/fake-canon.mjs   (no camera needed)
const { PtpSession } = await import('../lib/ptp.mjs');
const cam = await import('../lib/camera-mac.mjs');

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(3000, 7), Buffer.from([0xFF, 0xD9])]);
const PHOTO = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), Buffer.alloc(200000, 9), Buffer.from([0xFF, 0xD9])]);

function pstr(s) { const b = Buffer.alloc(1 + (s.length + 1) * 2); b[0] = s.length + 1; b.write(s, 1, 'utf16le'); return b; }
function arr16(a) { const b = Buffer.alloc(4 + 2 * a.length); b.writeUInt32LE(a.length, 0); a.forEach((v, i) => b.writeUInt16LE(v, 4 + 2 * i)); return b; }
function deviceInfo(newer) {
  const ops = [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x9151, 0x9152, 0x9153, 0x911D, 0x9107].concat(newer ? [0x9128, 0x9129] : [0x910F]);
  const h = Buffer.alloc(8); h.writeUInt16LE(100, 0); h.writeUInt32LE(0x0B, 2); h.writeUInt16LE(100, 6);
  return Buffer.concat([h, pstr('canon.com: 1.0'), Buffer.from([0, 0]), arr16(ops), arr16([]), arr16([]), arr16([]), arr16([0x3801]), pstr('Canon Inc.'), pstr('Canon EOS 1500D'), pstr('1.0'), pstr('123')]);
}
function ev(type, handle, fmt, size) { const b = Buffer.alloc(0x24); b.writeUInt32LE(0x24, 0); b.writeUInt32LE(type, 4); b.writeUInt32LE(handle, 8); b.writeUInt16LE(fmt, 0x10); b.writeUInt32LE(size, 0x1C); return b; }

class FakeCanon {
  constructor(newer) { this.newer = newer; this.queue = []; this.pendingWrite = null; this.events = []; this.live = false; this.log = []; this.remote = 0; this.sessionOpen = false; this.tid = -1; }
  async write(buf) {
    if (this.pendingWrite) { const pw = this.pendingWrite; this.pendingWrite = null; this.onData(pw, buf.subarray(12)); return; }
    const len = buf.readUInt32LE(0), type = buf.readUInt16LE(4), code = buf.readUInt16LE(6), tid = buf.readUInt32LE(8);
    if (type !== 1) throw new Error('not a command');
    const ps = []; for (let o = 12; o + 4 <= len; o += 4) ps.push(buf.readUInt32LE(o));
    this.log.push(code.toString(16));
    if (code === 0x9110) { this.pendingWrite = { code, tid }; return; }
    this.handle(code, tid, ps);
  }
  onData(pw, data) { const prop = data.readUInt32LE(4), val = data.readUInt32LE(8); if (prop === 0xD1B0) this.live = val === 2; this.respond(pw.tid, 0x2001); }
  dataOut(tid, code, data) { const h = Buffer.alloc(12); h.writeUInt32LE(12 + data.length, 0); h.writeUInt16LE(2, 4); h.writeUInt16LE(code, 6); h.writeUInt32LE(tid, 8); this.queue.push(Buffer.concat([h, data])); }
  respond(tid, resp, ps = []) { const b = Buffer.alloc(12 + 4 * ps.length); b.writeUInt32LE(b.length, 0); b.writeUInt16LE(3, 4); b.writeUInt16LE(resp, 6); b.writeUInt32LE(tid, 8); ps.forEach((p, i) => b.writeUInt32LE(p, 12 + 4 * i)); this.queue.push(b); }
  handle(code, tid, ps) {
    switch (code) {
      case 0x1002: this.sessionOpen = true; return this.respond(tid, 0x2001);
      case 0x1003: this.sessionOpen = false; return this.respond(tid, 0x2001);
      case 0x1001: this.dataOut(tid, code, deviceInfo(this.newer)); return this.respond(tid, 0x2001);
      case 0x9114: this.remote = ps[0]; return this.respond(tid, 0x2001);
      case 0x9115: return this.respond(tid, 0x2001);
      case 0x911D: return this.respond(tid, 0x2001);
      case 0x9151: return this.respond(tid, 0x2001);
      case 0x9152: return this.respond(tid, 0x2001);
      case 0x9116: {
        const b = Buffer.concat(this.events.length ? this.events : [Buffer.alloc(8)]);  // an empty list: size 8 type 0 ends the loop
        this.events = [];
        this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
      }
      case 0x9153:
        if (!this.live) return this.respond(tid, 0xA102);
        { const blk = Buffer.alloc(8 + JPEG.length); blk.writeUInt32LE(blk.length, 0); blk.writeUInt32LE(1, 4); JPEG.copy(blk, 8); this.dataOut(tid, code, blk); return this.respond(tid, 0x2001); }
      case 0x9128: if (ps[0] === 3) this.events.push(ev(0xC181, 0x1234, 0x3801, PHOTO.length)); return this.respond(tid, 0x2001);
      case 0x9129: return this.respond(tid, 0x2001);
      case 0x910F: this.events.push(ev(0xC181, 0x1234, 0x3801, PHOTO.length)); return this.respond(tid, 0x2001, [0]);
      case 0x1009: this.dataOut(tid, code, PHOTO); return this.respond(tid, 0x2001);
      case 0x1008: { const b = Buffer.alloc(16); b.writeUInt32LE(PHOTO.length, 8); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      case 0x9117: return this.respond(tid, 0x2001);
      default: return this.respond(tid, 0x2005);
    }
  }
  async read() { if (!this.queue.length) throw new Error('fake: nothing to read'); return this.queue.shift(); }
  async close() { this.closed = true; }
}

let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); if (!ok) failed++; };

for (const newer of [true, false]) {
  const fake = new FakeCanon(newer);
  cam.setBackend({
    list: () => [{ vendor: 0x04a9, product: 0x32e1, key: '1:2' }, { vendor: 0x05ac, product: 0x1234, key: '1:3' }],
    open: async () => new PtpSession(fake),
    free: async () => {}
  });
  const tag = newer ? '[0x9128 shutter] ' : '[0x910F shutter] ';
  const l = JSON.parse((await cam.call('list')).body.toString());
  check(tag + 'list: one Canon camera', l.devices.filter((d) => d.camera).length === 1);
  const o = await cam.call('open', '');
  check(tag + 'open', o.status === 'OK', o.body.toString().slice(0, 120));
  check(tag + 'name Canon EOS 1500D', JSON.parse(o.body.toString()).name === 'Canon EOS 1500D');
  const lv = await cam.call('live', 'on');
  check(tag + 'live on', lv.status === 'OK' && fake.live === true);
  const f = await cam.call('frame', '');
  check(tag + 'frame is the JPEG', f.status === 'OK' && f.kind === 'B' && f.body.equals(JPEG));
  const c = await cam.call('capture', '');
  check(tag + 'capture is the full photo', c.status === 'OK' && c.kind === 'B' && c.body.equals(PHOTO), c.status === 'OK' ? '' : c.body.toString());
  const f2 = await cam.call('frame', '');
  check(tag + 'live view restarts after the photo', f2.status === 'OK' && f2.kind === 'B');
  const x = await cam.call('close', '');
  check(tag + 'close leaves remote mode', x.status === 'OK' && fake.remote === 0 && fake.closed === true);
  const g = await cam.call('frame', '');
  check(tag + 'frame after close says GONE', g.status === 'GONE', g.body.toString().slice(0, 60));
}
console.log(failed ? failed + ' FAILED' : 'all passed');
process.exit(failed ? 1 : 0);
