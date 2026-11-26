import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PtpSession } from '../lib/ptp.mjs';
import { call as camCall, reset as camReset, setBackend } from '../lib/camera-mac.mjs';

const PHOTO = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), Buffer.alloc(60000, 9), Buffer.from([0xFF, 0xD9])]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2000, 7), Buffer.from([0xFF, 0xD9])]);
const RAW_DATA = Buffer.from('RAW_NEF_OR_CR3_BINARY_DATA_TEST');

const pstr = (s) => { const b = Buffer.alloc(1 + (s.length + 1) * 2); b[0] = s.length + 1; b.write(s, 1, 'utf16le'); return b; };
const arr16 = (a) => { const b = Buffer.alloc(4 + 2 * a.length); b.writeUInt32LE(a.length, 0); a.forEach((v, i) => b.writeUInt16LE(v, 4 + 2 * i)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

function deviceInfo(vendorExt, ops, props, maker, model) {
  const h = Buffer.alloc(8); h.writeUInt16LE(100, 0); h.writeUInt32LE(vendorExt, 2); h.writeUInt16LE(100, 6);
  return Buffer.concat([h, pstr('ext: 1.0'), Buffer.from([0, 0]), arr16(ops), arr16([]), arr16(props), arr16([]), arr16([0x3801]), pstr(maker), pstr(model), pstr('1.0'), pstr('123')]);
}

class FakePipe {
  constructor() { this.queue = []; this.pendingWrite = null; this.sessionOpen = false; }
  async write(buf) {
    if (this.pendingWrite) { const pw = this.pendingWrite; this.pendingWrite = null; this.onData(pw, buf.subarray(12)); return; }
    const len = buf.readUInt32LE(0), type = buf.readUInt16LE(4), code = buf.readUInt16LE(6), tid = buf.readUInt32LE(8);
    if (type !== 1) throw new Error('not a command');
    const ps = []; for (let o = 12; o + 4 <= len; o += 4) ps.push(buf.readUInt32LE(o));
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
  async read() { if (!this.queue.length) throw new Error('nothing to read'); return this.queue.shift(); }
  async close() { this.closed = true; }
}

// 1a. Nikon D7500 with SD card + RAW+JPEG (0x5004 = 4) + saveToCard
{
  class FakeCardNikon extends FakePipe {
    constructor() {
      super();
      this.writes = [0x1016];
      this.events = []; this.opsSeen = [];
      this.cur = new Map([[0xD10B, '1'], [0x5004, '4'], [0x5003, '6000x4000']]);
    }
    desc(code) {
      if (code === 0xD10B) return Buffer.concat([u16(code), u16(2), Buffer.from([1, 1, Number(this.cur.get(code))]), Buffer.from([2, 2, 0, 0, 1])]);
      if (code === 0x5004) return Buffer.concat([u16(code), u16(4), Buffer.from([1]), u16(2), u16(Number(this.cur.get(code))), Buffer.from([2]), u16(3), u16(0), u16(2), u16(4)]);
      if (code === 0x5003) return Buffer.concat([u16(code), u16(0xFFFF), Buffer.from([1]), pstr('6000x4000'), pstr(this.cur.get(code)), Buffer.from([2]), u16(2), pstr('6000x4000'), pstr('4496x3000')]);
      return null;
    }
    onData(pw, data) {
      const code = pw.ps[0];
      if (code === 0x5003) { const n = data[0]; this.cur.set(code, data.toString('utf16le', 1, 1 + (n - 1) * 2)); }
      else this.cur.set(code, String(data.length === 1 ? data[0] : data.readUInt16LE(0)));
      this.respond(pw.tid, 0x2001);
    }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x0A, [0x1001, 0x1002, 0x1003, 0x1004, 0x1008, 0x1009, 0x1014, 0x1015, 0x1016, 0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207], [0x5001, 0x5003, 0x5004], 'Nikon Corporation', 'D7500')); return this.respond(tid, 0x2001);
        case 0x1004: this.dataOut(tid, code, Buffer.concat([u32(1), u32(0x00010001)])); return this.respond(tid, 0x2001);
        case 0x1014: { const d = this.desc(ps[0]); if (!d) return this.respond(tid, 0x200A); this.dataOut(tid, code, d); return this.respond(tid, 0x2001); }
        case 0x1015: this.dataOut(tid, code, Buffer.from([92])); return this.respond(tid, 0x2001);
        case 0x90C8: return this.respond(tid, 0x2001);
        case 0x9207:
          this.opsSeen.push('0x9207:' + ps[1]);
          this.events.push([0x4002, 0x2001], [0x4002, 0x2002]);
          return this.respond(tid, 0x2001);
        case 0x90C7: {
          const b = Buffer.alloc(2 + 6 * this.events.length); b.writeUInt16LE(this.events.length, 0);
          this.events.forEach((e, i) => { b.writeUInt16LE(e[0], 2 + 6 * i); b.writeUInt32LE(e[1], 4 + 6 * i); });
          this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1008: {
          const fmt = ps[0] === 0x2002 ? 0x3801 : 0x3000;
          const sz = ps[0] === 0x2002 ? PHOTO.length : RAW_DATA.length;
          const b = Buffer.alloc(16); b.writeUInt16LE(fmt, 4); b.writeUInt32LE(sz, 8);
          this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1009: this.dataOut(tid, code, ps[0] === 0x2002 ? PHOTO : RAW_DATA); return this.respond(tid, 0x2001);
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const nk = new FakeCardNikon();
  setBackend({ list: () => [{ vendor: 0x04B0, product: 0x0442, name: 'Nikon D7500' }], open: async () => new PtpSession(nk), free: async () => {} });
  const o = await camCall('open', 'saveToCard');
  assert.equal(o.status, 'OK');
  assert.equal(nk.cur.get(0xD10B), '0', 'Nikon saveToCard sets RecordingMedia 0xD10B -> 0 (SD card)');
  assert.equal(nk.cur.get(0x5004), '4', 'Nikon saveToCard preserves RAW+JPEG quality (4)');
  const c = await camCall('capture', '');
  assert.equal(c.status, 'OK');
  assert(c.body[0] === 0xFF && c.body[1] === 0xD8, 'Nikon capture downloads companion JPEG (0x2002) while leaving NEF (0x2001) on card');
  assert(nk.opsSeen.includes('0x9207:0'), 'Nikon saveToCard shoots via InitiateCaptureRecInMedia (0x9207, ..., 0)');
  await camReset();
}

// 1b. Nikon D5300 specifically: Live View ON + 0x9207 returns 0xA00B (InLiveView) -> stops LV, retries 0x9207, queries 0x1008 strictly ONCE per handle!
{
  class FakeD5300Live extends FakePipe {
    constructor() {
      super();
      this.writes = [0x1016];
      this.live = false; this.events = []; this.opsSeen = [];
      this.infoCalls = new Map();
      this.pollCount = 0;
      this.cur = new Map([[0xD10B, '0'], [0x5004, '4'], [0x5003, '6000x4000']]);
    }
    desc(code) {
      if (code === 0xD10B) return Buffer.concat([u16(code), u16(2), Buffer.from([1, 1, Number(this.cur.get(code))]), Buffer.from([2, 2, 0, 0, 1])]);
      if (code === 0x5004) return Buffer.concat([u16(code), u16(4), Buffer.from([1]), u16(2), u16(Number(this.cur.get(code))), Buffer.from([2]), u16(3), u16(0), u16(2), u16(4)]);
      if (code === 0x5003) return Buffer.concat([u16(code), u16(0xFFFF), Buffer.from([1]), pstr('6000x4000'), pstr(this.cur.get(code)), Buffer.from([2]), u16(3), pstr('6000x4000'), pstr('4496x3000'), pstr('2992x2000')]);
      return null;
    }
    onData(pw, data) {
      const code = pw.ps[0];
      if (code === 0x5003) { const n = data[0]; this.cur.set(code, data.toString('utf16le', 1, 1 + (n - 1) * 2)); }
      else this.cur.set(code, String(data.length === 1 ? data[0] : data.readUInt16LE(0)));
      this.respond(pw.tid, 0x2001);
    }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x0A, [0x1001, 0x1002, 0x1003, 0x1004, 0x1008, 0x1009, 0x1014, 0x1015, 0x1016, 0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207], [0x5001, 0x5003, 0x5004], 'Nikon Corporation', 'D5300')); return this.respond(tid, 0x2001);
        case 0x1004: this.dataOut(tid, code, Buffer.concat([u32(1), u32(0x00010001)])); return this.respond(tid, 0x2001);
        case 0x1014: { const d = this.desc(ps[0]); if (!d) return this.respond(tid, 0x200A); this.dataOut(tid, code, d); return this.respond(tid, 0x2001); }
        case 0x1015: this.dataOut(tid, code, Buffer.from([85])); return this.respond(tid, 0x2001);
        case 0x90C8: return this.respond(tid, 0x2001);
        case 0x9201: this.live = true; this.opsSeen.push('lvOn'); return this.respond(tid, 0x2001);
        case 0x9202: this.live = false; this.opsSeen.push('lvOff'); return this.respond(tid, 0x2001);
        case 0x90C1: return this.respond(tid, 0x2001);
        case 0x9207:
          if (this.live) { this.opsSeen.push('9207:lvBlocked'); return this.respond(tid, 0xA00B); }
          this.opsSeen.push('9207:ok');
          this.events.push([0x4002, 0x3001]); // NEF arrives first
          return this.respond(tid, 0x2001);
        case 0x90C7: {
          this.pollCount++;
          if (this.pollCount === 4) this.events.push([0x4002, 0x3002]); // JPG arrives ~300ms later!
          const b = Buffer.alloc(2 + 6 * this.events.length); b.writeUInt16LE(this.events.length, 0);
          this.events.forEach((e, i) => { b.writeUInt16LE(e[0], 2 + 6 * i); b.writeUInt32LE(e[1], 4 + 6 * i); });
          this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1008: {
          this.infoCalls.set(ps[0], (this.infoCalls.get(ps[0]) || 0) + 1);
          const fmt = ps[0] === 0x3002 ? 0x3801 : 0x3000;
          const sz = ps[0] === 0x3002 ? PHOTO.length : RAW_DATA.length;
          const b = Buffer.alloc(16); b.writeUInt16LE(fmt, 4); b.writeUInt32LE(sz, 8);
          this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1009: this.dataOut(tid, code, ps[0] === 0x3002 ? PHOTO : RAW_DATA); return this.respond(tid, 0x2001);
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const d5300 = new FakeD5300Live();
  setBackend({ list: () => [{ vendor: 0x04B0, product: 0x0433, name: 'Nikon D5300' }], open: async () => new PtpSession(d5300), free: async () => {} });
  const o = await camCall('open', 'saveToCard');
  assert.equal(o.status, 'OK');
  assert.equal(d5300.cur.get(0xD10B), '0', 'D5300 keeps SD card');
  assert.equal(d5300.cur.get(0x5004), '4', 'D5300 preserves NEF+Fine RAW');
  assert.equal(d5300.cur.get(0x5003), '4496x3000', 'D5300 uses fast 13.5MP 4496x3000 JPEG (>3900px) while NEF stays 24MP');
  await camCall('live', 'on');
  const c = await camCall('capture', '');
  assert.equal(c.status, 'OK');
  assert(d5300.opsSeen.includes('9207:lvBlocked') && d5300.opsSeen.includes('lvOff') && d5300.opsSeen.includes('9207:ok'), 'D5300 recovers cleanly from 0xA00B during LV by ending LV and retrying 0x9207');
  assert(c.body[0] === 0xFF && c.body[1] === 0xD8, 'D5300 waits for delayed companion JPEG after NEF');
  assert.equal(d5300.infoCalls.get(0x3001), 1, 'No redundant 0x1008 polling bottleneck on NEF handle: queried strictly once');
  await camReset();
}

// 1d. Nikon D5300 accidentally set to RAW-only (0x3000): rejects cleanly without downloading 25MB NEF over USB
{
  class FakeD5300RawOnly extends FakePipe {
    constructor() { super(); this.writes = [0x1016]; this.cur = new Map([[0xD10B, '0'], [0x5004, '3'], [0x5003, '4496x3000']]); this.events = []; this.downloadedRaw = false; }
    desc(code) {
      if (code === 0xD10B) return Buffer.concat([u16(code), u16(2), Buffer.from([1, 1, Number(this.cur.get(code))]), Buffer.from([2, 2, 0, 0, 1])]);
      if (code === 0x5004) return Buffer.concat([u16(code), u16(4), Buffer.from([1]), u16(2), u16(Number(this.cur.get(code))), Buffer.from([2]), u16(3), u16(0), u16(2), u16(3)]);
      if (code === 0x5003) return Buffer.concat([u16(code), u16(0xFFFF), Buffer.from([1]), pstr('6000x4000'), pstr(this.cur.get(code)), Buffer.from([2]), u16(2), pstr('6000x4000'), pstr('4496x3000')]);
      return null;
    }
    onData(pw, data) { this.cur.set(pw.ps[0], String(data[0])); this.respond(pw.tid, 0x2001); }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x0A, [0x1001, 0x1002, 0x1003, 0x1004, 0x1008, 0x1009, 0x1014, 0x1016, 0x90C7, 0x90C8, 0x9207], [0x5003, 0x5004], 'Nikon Corporation', 'D5300')); return this.respond(tid, 0x2001);
        case 0x1004: this.dataOut(tid, code, Buffer.concat([u32(1), u32(0x00010001)])); return this.respond(tid, 0x2001);
        case 0x1014: { const d = this.desc(ps[0]); if (!d) return this.respond(tid, 0x200A); this.dataOut(tid, code, d); return this.respond(tid, 0x2001); }
        case 0x90C8: return this.respond(tid, 0x2001);
        case 0x9207: this.events.push([0x4002, 0x4001]); return this.respond(tid, 0x2001);
        case 0x90C7: {
          const b = Buffer.alloc(2 + 6 * this.events.length); b.writeUInt16LE(this.events.length, 0);
          this.events.forEach((e, i) => { b.writeUInt16LE(e[0], 2 + 6 * i); b.writeUInt32LE(e[1], 4 + 6 * i); });
          this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1008: { const b = Buffer.alloc(16); b.writeUInt16LE(0x3000, 4); b.writeUInt32LE(25_000_000, 8); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
        case 0x1009: this.downloadedRaw = true; this.dataOut(tid, code, RAW_DATA); return this.respond(tid, 0x2001);
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const rawOnly = new FakeD5300RawOnly();
  setBackend({ list: () => [{ vendor: 0x04B0, product: 0x0433, name: 'Nikon D5300' }], open: async () => new PtpSession(rawOnly), free: async () => {} });
  await camCall('open', 'saveToCard');
  const cap = await camCall('capture', '');
  assert.notEqual(cap.status, 'OK');
  assert(cap.body.toString('utf8').includes('RAW photo'), 'D5300 RAW-only returns clear RAW error');
  assert.equal(rawOnly.downloadedRaw, false, 'RAW-only handle (0x3000) is NOT downloaded over USB');
  await camReset();
}

// 2. Sony with PC Only (0x01) + saveToCard -> switches 0xD222 to PC + Camera (0x11) and skips queued RAW on capture
{
  class FakeCardSony extends FakePipe {
    constructor() { super(); this.writes = [0x9205, 0x9207]; this.dest = 0x01; this.stillMode = 1; this.items = []; }
    v3Enum(code, val, all, avail) {
      return Buffer.concat([u16(code), u16(4), Buffer.from([1, 1]), u16(all[0]), u16(val), Buffer.from([2]), u16(all.length), ...all.map(u16), u16(avail.length), ...avail.map(u16)]);
    }
    blob() {
      const memVal = this.items.length ? 0x8001 : 0;
      const entries = [
        this.v3Enum(0x5013, this.stillMode, [1, 2], [1, 2]),
        this.v3Enum(0xD222, this.dest, [0x01, 0x10, 0x11], [0x01, 0x10, 0x11]),
        Buffer.concat([u16(0xD215), u16(4), Buffer.from([1, 1]), u16(0), u16(memVal), Buffer.from([0])]),
        Buffer.concat([u16(0x500A), u16(4), Buffer.from([1, 1]), u16(1), u16(1), Buffer.from([0])])
      ];
      return Buffer.concat([u32(entries.length), u32(0), ...entries]);
    }
    onData(pw, data) {
      if (pw.code === 0x9205 && pw.ps[0] === 0xD222) this.dest = data.readUInt16LE(0);
      if (pw.code === 0x9207 && pw.ps[0] === 0xD2C2 && data.readUInt16LE(0) === 2) {
        this.items = [
          { fmt: 0x3000, data: RAW_DATA },
          { fmt: 0x3801, data: PHOTO }
        ];
      }
      this.respond(pw.tid, 0x2001);
    }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x11, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9201, 0x9202, 0x9205, 0x9207, 0x9209], [], 'Sony Corporation', 'ILCE-7M3')); return this.respond(tid, 0x2001);
        case 0x9201: return this.respond(tid, 0x2001);
        case 0x9202: { const b = Buffer.alloc(8); b.writeUInt16LE(0x12C, 0); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
        case 0x9209: this.dataOut(tid, code, this.blob()); return this.respond(tid, 0x2001);
        case 0x1008: {
          const cur = this.items[0] || { fmt: 0x3801, data: JPEG };
          const b = Buffer.alloc(16); b.writeUInt16LE(cur.fmt, 4); b.writeUInt32LE(cur.data.length, 8);
          this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x1009: {
          const cur = this.items.shift() || { data: JPEG };
          this.dataOut(tid, code, cur.data); return this.respond(tid, 0x2001);
        }
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const sy = new FakeCardSony();
  setBackend({ list: () => [{ vendor: 0x054C, product: 0x0C9F, name: 'Sony A7 III' }], open: async () => new PtpSession(sy), free: async () => {} });
  const o = await camCall('open', 'saveToCard');
  assert.equal(o.status, 'OK');
  assert.equal(sy.dest, 0x11, 'Sony saveToCard switches 0xD222 -> 0x11 (PC + Camera)');
  const c = await camCall('capture', '');
  assert.equal(c.status, 'OK');
  assert(c.body[0] === 0xFF && c.body[1] === 0xD8, 'Sony PC + Camera skips queued RAW and downloads JPEG cleanly');
  await camReset();
}

// 3a. Canon with Host (4) + saveToCard -> restores SD card (2) and captures RAW+JPEG cleanly from card
{
  class FakeCardCanon extends FakePipe {
    constructor() { super(); this.writes = [0x9110]; this.saveTo = 4; this.events = []; }
    evProp(prop, val) { const b = Buffer.alloc(16); b.writeUInt32LE(16, 0); b.writeUInt32LE(0xC189, 4); b.writeUInt32LE(prop, 8); b.writeUInt32LE(val >>> 0, 12); return b; }
    evCard(h, fmt, sz) { const b = Buffer.alloc(0x24); b.writeUInt32LE(0x24, 0); b.writeUInt32LE(0xC181, 4); b.writeUInt32LE(h, 8); b.writeUInt16LE(fmt, 0x10); b.writeUInt32LE(sz, 0x1C); return b; }
    onData(pw, data) {
      const prop = data.readUInt32LE(4), val = data.readUInt32LE(8);
      if (prop === 0xD11C) { this.saveTo = val; this.events.push(this.evProp(0xD11C, val)); }
      this.respond(pw.tid, 0x2001);
    }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x0B, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x101B, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x9118, 0x911A, 0x9128, 0x9129, 0x9151, 0x9152, 0x9153], [], 'Canon Inc.', 'Canon EOS R50')); return this.respond(tid, 0x2001);
        case 0x9114: case 0x9151: case 0x9152: return this.respond(tid, 0x2001);
        case 0x9115:
          if (ps[0] === 1) this.events.push(this.evProp(0xD11C, this.saveTo));
          return this.respond(tid, 0x2001);
        case 0x9116: {
          const b = Buffer.concat(this.events.length ? this.events : [Buffer.alloc(8)]);
          this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001);
        }
        case 0x9128:
          if (ps[0] === 3 || ps[0] === 2) {
            this.events.push(this.evCard(0x5001, 0xB108, RAW_DATA.length));
            this.events.push(this.evCard(0x5002, 0x3801, PHOTO.length));
          }
          return this.respond(tid, 0x2001);
        case 0x9129: return this.respond(tid, 0x2001);
        case 0x1009: this.dataOut(tid, code, ps[0] === 0x5002 ? PHOTO : RAW_DATA); return this.respond(tid, 0x2001);
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const cn = new FakeCardCanon();
  setBackend({ list: () => [{ vendor: 0x04A9, product: 0x3300, name: 'Canon EOS R50' }], open: async () => new PtpSession(cn), free: async () => {} });
  const o = await camCall('open', 'saveToCard');
  assert.equal(o.status, 'OK');
  assert.equal(JSON.parse(o.body.toString('utf8')).toCard, false, 'Canon open with saveToCard sets toCard=false (no false warning toast)');
  const l = await camCall('list', '');
  assert.equal(JSON.parse(l.body.toString('utf8')).toCard, false, 'Canon list with saveToCard sets toCard=false');
  assert.equal(cn.saveTo, 2, 'Canon saveToCard restores 0xD11C=4 -> 2 (SD card)');
  const c = await camCall('capture', '');
  assert.equal(c.status, 'OK');
  assert(c.body[0] === 0xFF && c.body[1] === 0xD8, 'Canon capture downloads JPEG while preserving CR3 on SD card');
  await camReset();
}

// 3b. Canon delayed companion JPEG arriving >220ms after CR3
{
  class FakeDelayedCanon extends FakePipe {
    constructor() { super(); this.writes = [0x9110]; this.saveTo = 2; this.events = []; this.polls = 0; }
    evCard(h, fmt, sz) { const b = Buffer.alloc(0x24); b.writeUInt32LE(0x24, 0); b.writeUInt32LE(0xC181, 4); b.writeUInt32LE(h, 8); b.writeUInt16LE(fmt, 0x10); b.writeUInt32LE(sz, 0x1C); return b; }
    handle(code, tid, ps) {
      if (this.common(code, tid)) return;
      switch (code) {
        case 0x1001: this.dataOut(tid, code, deviceInfo(0x0B, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x9128, 0x9129, 0x9151, 0x9152, 0x9153], [], 'Canon Inc.', 'Canon EOS R6')); return this.respond(tid, 0x2001);
        case 0x9114: case 0x9115: case 0x9151: case 0x9152: return this.respond(tid, 0x2001);
        case 0x9116:
          this.polls++;
          if (this.polls === 7) this.events.push(this.evCard(0x6002, 0x3801, PHOTO.length));
          { const b = Buffer.concat(this.events.length ? this.events : [Buffer.alloc(8)]); this.events = []; this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
        case 0x9128:
          if (ps[0] === 3 || ps[0] === 2) { this.polls = 0; this.events.push(this.evCard(0x6001, 0xB108, RAW_DATA.length)); }
          return this.respond(tid, 0x2001);
        case 0x9129: return this.respond(tid, 0x2001);
        case 0x1009: this.dataOut(tid, code, ps[0] === 0x6002 ? PHOTO : RAW_DATA); return this.respond(tid, 0x2001);
        default: return this.respond(tid, 0x2005);
      }
    }
  }
  const dc = new FakeDelayedCanon();
  setBackend({ list: () => [{ vendor: 0x04A9, product: 0x32F0, name: 'Canon EOS R6' }], open: async () => new PtpSession(dc), free: async () => {} });
  await camCall('open', 'saveToCard');
  const cap = await camCall('capture', '');
  assert.equal(cap.status, 'OK');
  assert(cap.body[0] === 0xFF && cap.body[1] === 0xD8, 'Canon waits for companion JPEG arriving >220ms after CR3');
  await camReset();
}

// 4. Verify Android, iOS & Windows source invariants for D5300/DSLR SD Card, burst draining, and bottleneck guards
const ktHelper = readFileSync('android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt', 'utf8');
assert(ktHelper.includes('setRovingSaveToCard') && ktHelper.includes('keepOnCard'), 'Android UsbCameraHelper supports keepOnCard & setRovingSaveToCard');
assert(ktHelper.includes('if (code == 0x4002) l.add(p)'), 'Android nikonEvents duplicate handle bug fixed');
assert(ktHelper.includes('peekObjectFormat(') && ktHelper.includes('peekIsJpegHeader(') && ktHelper.includes('pollNewPhotos(): List<ByteArray>'), 'Android supports burst polling and RAW header guard');
assert(ktHelper.includes('op(0x90C2, 0)'), 'Android Nikon roving unlocks body shutter controls (0x90C2=0)');
assert(ktHelper.includes('dataOut.write(pend, 12, payloadLen)'), 'Android USB PTP transact streams directly without intermediate copyOfRange heap spike');
const ktAct = readFileSync('android/app/src/main/java/com/photobooth4u/booth/RovingBridgeActivity.kt', 'utf8');
assert(ktAct.includes('Save Backup + RAW on Camera SD Card') && ktAct.includes('cam.pollNewPhotos()'), 'Android RovingBridgeActivity has SD Card RAW toggle and drains bursts');
assert(ktAct.includes('LruCache') && ktAct.includes('dp(720)') && ktAct.includes('gridCols'), 'Android RovingBridgeActivity caches thumbnails in RAM and adapts cleanly for Android tablets');

const swiftHelper = readFileSync('ios/photobooth4u/IccCameraHelper.swift', 'utf8');
assert(swiftHelper.includes('setRovingSaveToCard') && swiftHelper.includes('keepOnCard'), 'iOS IccCameraHelper supports keepOnCard & setRovingSaveToCard');
assert(swiftHelper.includes('if dest == Int64(wantTarget)'), 'iOS ensureSonySaveDest early return checks wantTarget (0x11 vs 0x01)');
assert(swiftHelper.includes('NIKON_NOT_IN_LV') && swiftHelper.includes('checkedFmt'), 'iOS Nikon capture handles D5300 LV conflict & caches 0x1008');
assert(swiftHelper.includes('guard !handles.isEmpty') && swiftHelper.includes('pickFmt == 0x3000'), 'iOS Nikon capture guards empty card handles and rejects RAW before download');
const swiftVc = readFileSync('ios/roving/RovingBridgeViewController.swift', 'utf8');
assert(swiftVc.includes('Save Backup + RAW on Camera SD Card') && swiftVc.includes('Keys.saveToCard'), 'iOS RovingBridgeViewController has SD Card RAW toggle');

const ps1 = readFileSync('tools/print-helper/camera-worker.ps1', 'utf8');
assert(ps1.includes('saveToCard = arg.IndexOf("saveToCard") >= 0;') && ps1.includes('HasStorageCard()') && ps1.includes('checkedFmt'), 'Windows camera-worker.ps1 supports saveToCard, HasStorageCard, and cached 0x1008');
assert(ps1.includes('if (handles.Count == 0) throw new CamException') && ps1.includes('!saveToCard ? "true" : "false"'), 'Windows camera-worker.ps1 guards empty handles and suppresses false toCard warning');

console.log('ALL SD CARD + RAW SAVING & D5300 TESTS PASSED!');
