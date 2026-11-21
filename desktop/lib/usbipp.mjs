// Direct IPP-over-USB (USB Print Class 7 / Subclass 1 / Protocol 4) and USB printer probing via libusb ("usb" package).
// Used on desktop (especially macOS, where Brother provides no DCP-T420W driver and macOS rejects non-AirPrint USB
// printers, and on Windows when no OS driver queue exists yet). If the printer exposes a 7/1/4 interface, the app sends
// the exact same IPP / PWG Raster jobs over USB that it sends over Wi-Fi. If it exposes only 7/1/2 (e.g. Brother HBP/PJL),
// the probe reports the exact interfaces and IEEE-1284 ID so the app can guide the operator cleanly.
import { createRequire } from 'node:module';

const BROTHER_VID = 0x04f9;
const HP_VID = 0x03f0;
const VENDORS = new Map([
  [0x04f9, 'Brother'],
  [0x04b8, 'Epson'],
  [0x04a9, 'Canon'],
  [0x03f0, 'HP'],
  [0x1343, 'DNP'],
  [0x1452, 'DNP']
]);
const KNOWN_MODELS = new Map([
  ['04f9:0475', 'Brother DCP-T420W'],
  ['04f9:0474', 'Brother DCP-T220'],
  ['04f9:0476', 'Brother DCP-T520W'],
  ['04f9:0477', 'Brother DCP-T720DW'],
  ['04f9:0478', 'Brother DCP-T820DW']
]);

const hex4 = (n) => Number(n || 0).toString(16).padStart(4, '0');

let usbLib = null;
let usbOverride = null;
export function setUsbBackend(mock) { usbOverride = mock || null; }
function getUsb() {
  if (usbOverride) return usbOverride;
  if (!usbLib) {
    try { usbLib = createRequire(import.meta.url)('usb'); } catch { return null; }
  }
  return usbLib;
}

const call = (fn) => new Promise((resolve, reject) => {
  try { fn((err, res) => (err ? reject(err) : resolve(res))); } catch (e) { reject(e); }
});

// ---- HTTP/1.1 framing over IPP-over-USB bulk pipes (handles 100 Continue, Content-Length, and multi-chunk encoding) ----
function skip100Continue(buf) {
  let off = 0;
  for (;;) {
    const headEnd = buf.indexOf('\r\n\r\n', off, 'latin1');
    if (headEnd < 0) return off;
    const statusLineEnd = buf.indexOf('\r\n', off, 'latin1');
    const line = buf.toString('latin1', off, statusLineEnd >= 0 && statusLineEnd < headEnd ? statusLineEnd : headEnd);
    if (/^HTTP\/1\.[01]\s+100\b/i.test(line)) {
      off = headEnd + 4;
      continue;
    }
    return off;
  }
}

/** Decodes HTTP/1.1 chunked transfer-encoding. Returns { complete, data }. */
export function decodeChunked(body) {
  const parts = [];
  let p = 0;
  while (p < body.length) {
    const nl = body.indexOf('\r\n', p, 'latin1');
    if (nl < 0) return { complete: false, data: Buffer.concat(parts) };
    const sizeStr = body.toString('latin1', p, nl).split(';')[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeStr)) return { complete: false, data: Buffer.concat(parts) };
    const size = parseInt(sizeStr, 16);
    p = nl + 2;
    if (size === 0) {
      // Final 0-length chunk ends with an empty trailer line (\r\n)
      if (p + 2 <= body.length && body[p] === 0x0d && body[p + 1] === 0x0a) return { complete: true, data: Buffer.concat(parts) };
      const trailEnd = body.indexOf('\r\n\r\n', p, 'latin1');
      return { complete: trailEnd >= 0, data: Buffer.concat(parts) };
    }
    if (p + size + 2 > body.length) return { complete: false, data: Buffer.concat(parts) };
    parts.push(body.subarray(p, p + size));
    p += size + 2;
  }
  return { complete: false, data: Buffer.concat(parts) };
}

/** True when `buf` holds a complete HTTP/1.1 response (ignoring leading 100 Continue headers). */
export function isHttpComplete(buf) {
  if (!buf || !buf.length) return false;
  const start = skip100Continue(buf);
  const split = buf.indexOf('\r\n\r\n', start, 'latin1');
  if (split < 0) return false;
  const head = buf.toString('latin1', start, split);
  const cl = /^content-length:\s*(\d+)/im.exec(head);
  const body = buf.subarray(split + 4);
  if (cl) return body.length >= Number(cl[1]);
  if (/^transfer-encoding:\s*[^\r\n]*chunked/im.test(head)) return decodeChunked(body).complete;
  return false;
}

/** Extracts { http, body } from raw HTTP/1.1 response bytes (handling 100 Continue and chunked bodies). */
export function parseHttpReply(buf) {
  if (!buf || !buf.length) return null;
  const start = skip100Continue(buf);
  const split = buf.indexOf('\r\n\r\n', start, 'latin1');
  if (split < 0) return null;
  const head = buf.toString('latin1', start, split);
  const m = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(head);
  const httpCode = m ? Number(m[1]) : 0;
  const rawBody = buf.subarray(split + 4);
  const cl = /^content-length:\s*(\d+)/im.exec(head);
  if (cl) return { http: httpCode, body: rawBody.subarray(0, Number(cl[1])) };
  if (/^transfer-encoding:\s*[^\r\n]*chunked/im.test(head)) {
    return { http: httpCode, body: decodeChunked(rawBody).data };
  }
  return { http: httpCode, body: rawBody };
}

// ---- USB printer descriptor inspection ----
function hasBulkPairDesc(alt) {
  let hasIn = false, hasOut = false;
  for (const ep of (alt && alt.endpoints) || []) {
    if ((ep.bmAttributes & 0x03) !== 2) continue;            // bulk endpoint
    if (ep.bEndpointAddress & 0x80) hasIn = true; else hasOut = true;
  }
  return hasIn && hasOut;
}

function inspectDeviceInterfaces(dev) {
  const out = [];
  let cfg;
  try { cfg = dev.configDescriptor; } catch { return out; }
  if (!cfg || !Array.isArray(cfg.interfaces)) return out;
  for (const alts of cfg.interfaces) {
    for (const a of alts || []) {
      out.push({
        num: a.bInterfaceNumber,
        alt: a.bAlternateSetting || 0,
        cls: a.bInterfaceClass,
        sub: a.bInterfaceSubClass,
        proto: a.bInterfaceProtocol,
        hasBulkPair: hasBulkPairDesc(a)
      });
    }
  }
  return out;
}

export function pickUsbIppInterface(vid, interfaces) {
  return interfaces.find((i) => i.cls === 7 && i.sub === 1 && i.proto === 4 && i.hasBulkPair)
    || interfaces.find((i) => vid === HP_VID && i.cls === 255 && i.sub === 9 && i.proto === 1 && i.hasBulkPair)
    || null;
}

export function pickUsbRawInterface(interfaces) {
  return interfaces.find((i) => i.cls === 7 && i.sub === 1 && (i.proto === 1 || i.proto === 2)) || null;
}

async function readStringDesc(dev, index) {
  if (!index) return '';
  try { return String((await call((cb) => dev.getStringDescriptor(index, cb))) || '').trim(); } catch { return ''; }
}

async function readDeviceId1284(dev, rawIface) {
  if (!rawIface) return '';
  try {
    const wIndex = ((rawIface.num & 0xff) << 8) | (rawIface.alt & 0xff);
    const buf = await call((cb) => dev.controlTransfer(0xA1, 0, 0, wIndex, 1024, cb));
    if (buf && buf.length > 2) return buf.subarray(2).toString('latin1').replace(/\0.*$/s, '').trim();
  } catch { /* OS driver may hold the interface on Windows */ }
  return '';
}

function modelFromDeviceId(id) {
  const m = /\bMDL:([^;]+)/i.exec(String(id || ''));
  const mfg = /\bMFG:([^;]+)/i.exec(String(id || ''));
  if (!m) return '';
  const model = m[1].trim(), maker = mfg ? mfg[1].trim() : '';
  return maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ${model}` : model;
}

/**
 * Probes every connected USB printer visible to libusb.
 * Never throws: returns [] if libusb is unavailable or no USB printers are attached.
 */
export async function probeUsbPrinters({ platform = process.platform, readDescriptors = true } = {}) {
  const u = getUsb();
  if (!u || typeof u.getDeviceList !== 'function') return [];
  let devs = [];
  try { devs = u.getDeviceList() || []; } catch { return []; }
  const results = [];
  for (const dev of devs) {
    const d = dev && dev.deviceDescriptor;
    if (!d) continue;
    const vid = d.idVendor, pid = d.idProduct;
    const ifaces = inspectDeviceInterfaces(dev);
    const isPrinter = ifaces.some((i) => i.cls === 7) || vid === BROTHER_VID;
    if (!isPrinter) continue;
    const ippIface = pickUsbIppInterface(vid, ifaces);
    const rawIface = pickUsbRawInterface(ifaces);
    const idPair = `${hex4(vid)}:${hex4(pid)}`;
    let product = '', manufacturer = '', deviceId = '';
    if (readDescriptors) {
      let opened = false;
      try {
        dev.open();
        opened = true;
        product = await readStringDesc(dev, d.iProduct);
        manufacturer = await readStringDesc(dev, d.iManufacturer);
        if (rawIface && platform !== 'win32') deviceId = await readDeviceId1284(dev, rawIface);
      } catch { /* On Windows, usbprint.sys often blocks dev.open() — fall back to VID:PID */ }
      finally { if (opened) { try { dev.close(); } catch { /* ignore */ } } }
    }
    const vendorName = VENDORS.get(vid) || manufacturer || '';
    const known = KNOWN_MODELS.get(idPair) || '';
    const from1284 = modelFromDeviceId(deviceId);
    let name = known || from1284 || '';
    if (!name && product) name = vendorName && !product.toLowerCase().includes(vendorName.toLowerCase()) ? `${vendorName} ${product}` : product;
    if (!name) name = (vendorName ? vendorName + ' ' : '') + `USB printer (${idPair})`;

    const key = `usb:${dev.busNumber || 0}:${dev.deviceAddress || 0}:${idPair}`;
    let note = '';
    if (ippIface) {
      note = 'Supports driverless IPP-over-USB (7/1/4): the app can print straight to it over USB.';
    } else if (vid === BROTHER_VID) {
      note = platform === 'win32'
        ? `${name} is connected on USB without an IPP-over-USB (7/1/4) interface. Install Brother’s Windows USB driver so it appears in your printer list, or connect it to Wi-Fi and use Find Wi-Fi / network printers for driverless printing.`
        : `${name} is connected on USB, but exposes only Brother’s proprietary USB interface (no IPP-over-USB 7/1/4) and macOS has no driver for it. Connect it to Wi-Fi and use Find Wi-Fi / network printers to print straight from this Mac with no driver.`;
    } else {
      note = platform === 'win32'
        ? `${name} is connected on USB without IPP-over-USB (7/1/4). Install its Windows driver so it appears in your printer list.`
        : `${name} is connected on USB without IPP-over-USB (7/1/4). Add it in System Settings → Printers & Scanners or connect over Wi-Fi.`;
    }

    results.push({
      key, vid, pid, vidHex: hex4(vid), pidHex: hex4(pid),
      bus: dev.busNumber || 0, address: dev.deviceAddress || 0,
      name, product, manufacturer, deviceId,
      hasIppUsb: !!ippIface,
      hasRawPrinter: !!rawIface,
      ippIface,
      interfaces: ifaces,
      note
    });
  }
  return results;
}

// ---- Serialized IPP-over-USB HTTP/1.1 request/response over bulk pipes ----
const usbQueues = new Map();
function enqueueUsb(key, fn) {
  const prev = usbQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  usbQueues.set(key, next.catch(() => { }));
  return next;
}

function findLiveDevice(entry) {
  const u = getUsb();
  if (!u || typeof u.getDeviceList !== 'function') return null;
  let devs = [];
  try { devs = u.getDeviceList() || []; } catch { return null; }
  const exact = devs.find((d) => d.deviceDescriptor && d.deviceDescriptor.idVendor === entry.vid && d.deviceDescriptor.idProduct === entry.pid && d.busNumber === entry.bus && d.deviceAddress === entry.address);
  if (exact) return exact;
  return devs.find((d) => d.deviceDescriptor && d.deviceDescriptor.idVendor === entry.vid && d.deviceDescriptor.idProduct === entry.pid) || null;
}

async function writeBulk(ep, buf) {
  const CHUNK = 32 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK) {
    const slice = buf.subarray(off, Math.min(buf.length, off + CHUNK));
    await call((cb) => ep.transfer(slice, cb));
  }
}

/**
 * Sends one IPP request over IPP-over-USB (HTTP/1.1 carried on the printer's 7/1/4 bulk endpoints).
 * Returns { http, body } or null on transport failure.
 */
export function usbIppPost(entry, path, body, timeoutMs = 90000) {
  return enqueueUsb(entry.key || `${entry.vid}:${entry.pid}`, async () => {
    const dev = findLiveDevice(entry);
    if (!dev) return null;
    const ifaces = inspectDeviceInterfaces(dev);
    const want = pickUsbIppInterface(entry.vid, ifaces);
    if (!want) return null;
    let opened = false, claimed = null;
    try {
      dev.open();
      opened = true;
      const iface = dev.interface(want.num);
      try { if (iface.isKernelDriverActive && iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* macOS / Windows */ }
      iface.claim();
      claimed = iface;
      const altCount = ifaces.filter((i) => i.num === want.num).length;
      if ((want.alt !== 0 || altCount > 1) && typeof iface.setAltSetting === 'function') {
        await call((cb) => iface.setAltSetting(want.alt, cb));
      }
      let outEp = null, inEp = null;
      for (const ep of iface.endpoints || []) {
        if (ep.transferType !== 2) continue;                 // LIBUSB_TRANSFER_TYPE_BULK = 2
        if (ep.direction === 'out' && !outEp) outEp = ep;
        if (ep.direction === 'in' && !inEp) inEp = ep;
      }
      if (!outEp || !inEp) return null;
      const reqTimeout = Math.max(5000, Number(timeoutMs) || 90000);
      outEp.timeout = reqTimeout;
      inEp.timeout = Math.min(4000, reqTimeout);

      const docBuf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      const head = Buffer.from(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/ipp\r\nContent-Length: ${docBuf.length}\r\n\r\n`,
        'latin1'
      );
      await writeBulk(outEp, head);
      if (docBuf.length) await writeBulk(outEp, docBuf);

      const chunks = [];
      let total = 0;
      const deadline = Date.now() + reqTimeout;
      while (Date.now() < deadline) {
        let piece = null;
        try { piece = await call((cb) => inEp.transfer(16384, cb)); }
        catch (e) {
          if (/TIMED_OUT|TIMEOUT/i.test(String((e && (e.message || e.errno)) || e))) {
            if (total > 0) break;
            continue;
          }
          throw e;
        }
        if (piece && piece.length > 0) {
          chunks.push(piece);
          total += piece.length;
          if (isHttpComplete(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks))) break;
        } else if (total > 0) {
          break;
        }
      }
      if (!total) return null;
      return parseHttpReply(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    } catch {
      return null;
    } finally {
      if (claimed) { try { await call((cb) => claimed.release(true, cb)); } catch { /* ignore */ } }
      if (opened) { try { dev.close(); } catch { /* ignore */ } }
    }
  });
}

/** Builds a pluggable transport accepted by ippCaps / ippPrintDirect in netprinters.mjs. */
export function makeUsbIppTransport(entry) {
  return {
    baseUri: 'ipp://localhost',
    post: (path, body, timeoutMs) => usbIppPost(entry, path, body, timeoutMs)
  };
}
