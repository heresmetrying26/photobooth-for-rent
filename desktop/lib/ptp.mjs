// PTP (Picture Transfer Protocol) over USB, straight to the camera with libusb (the "usb" package).
// Used by the Mac app for Canon EOS cameras (lib/camera-mac.mjs). The framing follows the PTP spec: every message is a
// "container" { length u32, type u16, code u16, transaction u32, payload }, types 1 command, 2 data, 3 response, 4 event.
import { createRequire } from 'node:module';

export const OK = 0x2001, BUSY = 0x2019, SESSION_OPEN = 0x201E;
export class GoneError extends Error {}       // the camera was unplugged / switched off
export class CamError extends Error {}        // a problem the person can fix; the message starts with a CODE word
export class TimeoutError extends Error {}    // the camera did not answer in time

const READ_SIZE = 128 * 1024;                 // a multiple of every USB packet size
const WRITE_CHUNK = 64 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---------- the PTP session (transport independent, so tests can use a fake camera) ----------
// io: { write(buf): Promise, read(len): Promise<Buffer>, close(): Promise }
export class PtpSession {
  constructor(io) {
    this.io = io;
    this.tid = 0;
    this.chunks = [];
    this.have = 0;
  }

  async _fill(n) {
    let empty = 0;
    while (this.have < n) {
      const b = await this.io.read(READ_SIZE);
      if (!b || b.length === 0) { if (++empty > 4) throw new TimeoutError('The camera sent an empty answer.'); continue; }
      empty = 0;
      this.chunks.push(b);
      this.have += b.length;
    }
  }

  _take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.have = rest.length;
    return out;
  }

  _peek(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [all];
    return all.subarray(0, n);
  }

  // One transaction. Returns { resp, params, data } (data is null when the camera sent none).
  async transact(code, params = [], outData = null) {
    const tid = this.tid;
    this.tid = (this.tid + 1) >>> 0;
    const cmd = Buffer.alloc(12 + 4 * params.length);
    cmd.writeUInt32LE(cmd.length, 0); cmd.writeUInt16LE(1, 4); cmd.writeUInt16LE(code, 6); cmd.writeUInt32LE(tid, 8);
    params.forEach((p, i) => cmd.writeUInt32LE(p >>> 0, 12 + 4 * i));
    await this.io.write(cmd);
    if (outData) {
      const dh = Buffer.alloc(12);
      dh.writeUInt32LE(12 + outData.length, 0); dh.writeUInt16LE(2, 4); dh.writeUInt16LE(code, 6); dh.writeUInt32LE(tid, 8);
      await this.io.write(Buffer.concat([dh, outData]));
    }
    let data = null;
    for (;;) {
      await this._fill(12);
      const head = this._peek(12);
      const len = head.readUInt32LE(0), type = head.readUInt16LE(4);
      if (len < 12 || len === 0xFFFFFFFF) throw new CamError('CAPTURE The camera sent data of an unknown length.');
      await this._fill(len);
      const whole = this._take(len);
      if (type === 2) { data = data ? Buffer.concat([data, whole.subarray(12)]) : Buffer.from(whole.subarray(12)); continue; }
      if (type === 3) {
        const ps = [];
        for (let o = 12; o + 4 <= whole.length; o += 4) ps.push(whole.readUInt32LE(o));
        return { resp: whole.readUInt16LE(6), params: ps, data };
      }
      // an event on the bulk pipe: ignore it
    }
  }

  async op(code, ...params) { return (await this.transact(code, params)).resp; }
  async opP(code, ...params) { const r = await this.transact(code, params); return { resp: r.resp, params: r.params }; }
  async opRead(code, ...params) { const r = await this.transact(code, params); return { resp: r.resp, data: r.data || Buffer.alloc(0) }; }
  async opWrite(code, data, ...params) { return (await this.transact(code, params, data)).resp; }

  async openSession() {
    this.tid = 0;
    let r = await this.transact(0x1002, [1]);
    if (r.resp === SESSION_OPEN) {                 // left open by an earlier run: close it and start clean
      try { await this.transact(0x1003, []); } catch { /* ignore */ }
      this.tid = 0;
      r = await this.transact(0x1002, [1]);
    }
    if (r.resp !== OK && r.resp !== SESSION_OPEN) throw new CamError('DRIVER The camera refused to start a session (' + hex(r.resp) + '). Switch it off and on and try again.');
    this.tid = 1;
  }

  async closeSession() { try { await this.transact(0x1003, []); } catch { /* ignore */ } }
  async close() { try { await this.io.close(); } catch { /* ignore */ } }
}

export const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');

// A little reader for PTP datasets (DeviceInfo ...)
export class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  u8() { return this.b[this.i++]; }
  u16() { const v = this.b.readUInt16LE(this.i); this.i += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.i); this.i += 4; return v; }
  str() {
    const n = this.b[this.i++];
    if (!n) return '';
    const s = this.b.toString('utf16le', this.i, this.i + (n - 1) * 2);
    this.i += n * 2;
    return s;
  }
  u16Array() { const n = this.u32(), l = []; for (let k = 0; k < n; k++) l.push(this.u16()); return l; }
}

// ---------- libusb transport ----------
let usbLib = null;
function lib() {
  if (!usbLib) usbLib = createRequire(import.meta.url)('usb');
  return usbLib;
}

const errText = (e) => String((e && (e.message || e.errno)) || e);
function mapUsbError(e) {
  const t = errText(e);
  if (/NO_DEVICE|NOT_FOUND|-4\b/.test(t) && !/TIMED_OUT/.test(t)) return new GoneError('The camera was unplugged or switched off (' + t + ').');
  if (/TIMED_OUT|TIMEOUT/.test(t)) return new TimeoutError('The camera did not answer (' + t + ').');
  return e instanceof Error ? e : new Error(t);
}

const call = (fn) => new Promise((resolve, reject) => { try { fn((err, res) => (err ? reject(err) : resolve(res))); } catch (e) { reject(e); } });

class UsbIo {
  constructor(dev, iface, inEp, outEp) {
    this.dev = dev; this.iface = iface; this.inEp = inEp; this.outEp = outEp;
    this.packet = (outEp.descriptor && outEp.descriptor.wMaxPacketSize) || 512;
    inEp.timeout = 10000; outEp.timeout = 10000;
  }
  async write(buf) {
    try {
      for (let o = 0; o < buf.length; o += WRITE_CHUNK) await call((cb) => this.outEp.transfer(buf.subarray(o, o + WRITE_CHUNK), cb));
      if (buf.length % this.packet === 0) await call((cb) => this.outEp.transfer(Buffer.alloc(0), cb));   // end of a transfer on a packet boundary
    } catch (e) { throw mapUsbError(e); }
  }
  async read(len) {
    try { return await call((cb) => this.inEp.transfer(len, cb)); }
    catch (e) { throw mapUsbError(e); }
  }
  async close() {
    try { await call((cb) => this.iface.release(true, cb)); } catch { /* ignore */ }
    try { this.dev.close(); } catch { /* ignore */ }
  }
}

const PTP_CLASS = 6;

function ptpInterface(dev) {
  let cfg;
  try { cfg = dev.configDescriptor; } catch { return null; }
  if (!cfg || !cfg.interfaces) return null;
  for (const alts of cfg.interfaces) {
    for (const a of alts) if (a.bInterfaceClass === PTP_CLASS && a.bInterfaceSubClass === 1) return a;
  }
  return null;
}

// Every USB device that has a PTP (still image) interface. { dev, vendor, product, key }
export function listPtpDevices() {
  const out = [];
  let devs = [];
  try { devs = lib().getDeviceList(); } catch { return out; }
  for (const dev of devs) {
    const d = dev.deviceDescriptor;
    if (!d || !ptpInterface(dev)) continue;
    out.push({ dev, vendor: d.idVendor, product: d.idProduct, key: dev.busNumber + ':' + dev.deviceAddress });
  }
  return out;
}

// Every USB device libusb can see (not only cameras): { vendor, product, classes }. For the Camera check screen.
export function listAllUsb() {
  const out = [];
  let devs = [];
  try { devs = lib().getDeviceList(); } catch { return out; }
  for (const dev of devs) {
    const d = dev.deviceDescriptor;
    if (!d) continue;
    const classes = [];
    try { for (const alts of (dev.configDescriptor && dev.configDescriptor.interfaces) || []) for (const a of alts) if (!classes.includes(a.bInterfaceClass)) classes.push(a.bInterfaceClass); } catch { /* no descriptor */ }
    out.push({ vendor: d.idVendor, product: d.idProduct, classes });
  }
  return out;
}

// Opens the device, takes its PTP interface (macOS' own camera service may hold it for a moment: it is retried) and starts a session.
export async function openUsbPtp(entry, { tries = 10, onBusy = null } = {}) {
  const dev = entry.dev;
  const want = ptpInterface(dev);
  if (!want) throw new CamError('NOCAMERA The camera has no USB picture interface. Switch it on and check its cable.');
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      dev.open();
      const iface = dev.interface(want.bInterfaceNumber);
      try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* not on macOS */ }
      iface.claim();
      let inEp = null, outEp = null;
      for (const ep of iface.endpoints) {
        const bulk = (ep.transferType === 2);
        if (!bulk) continue;
        if (ep.direction === 'in' && !inEp) inEp = ep;
        if (ep.direction === 'out' && !outEp) outEp = ep;
      }
      if (!inEp || !outEp) { try { dev.close(); } catch { /* ignore */ } throw new CamError('NOCAMERA The camera has no usable USB data pipe.'); }
      const io = new UsbIo(dev, iface, inEp, outEp);
      const session = new PtpSession(io);
      return session;
    } catch (e) {
      last = e;
      try { dev.close(); } catch { /* ignore */ }
      if (e instanceof CamError) throw e;
      if (onBusy) { try { await onBusy(); } catch { /* ignore */ } }
      await sleep(500);
    }
  }
  throw new CamError('BUSY Another program is holding the camera (' + errText(last) + '). Quit Photos, Image Capture and EOS Utility, switch the camera off and on, then try again.');
}
