// Direct IPP-over-USB (USB Print Class 7 / Subclass 1 / Protocol 4) and USB printer probing via libusb ("usb" package).
// Used on desktop (especially macOS, where Brother provides no DCP-T420W driver and macOS rejects non-AirPrint USB
// printers, and on Windows when no OS driver queue exists yet). If the printer exposes a 7/1/4 interface, the app sends
// the exact same IPP / PWG Raster jobs over USB that it sends over Wi-Fi. If it exposes only 7/1/2 (e.g. Brother HBP/PJL),
// the probe reports the exact interfaces and IEEE-1284 ID so the app can guide the operator cleanly.
import { createRequire } from 'node:module';
import { isSelphyUsb, selphyModelName, selphyErrorDescription } from './selphyusb.mjs';
import { isDnpUsb, dnpModelName, dnpUnsupportedReason, dnpCmd, dnpIsError, dnpStatusText, parseDnpIntReply, parseDnpMediaRemaining } from './dnpusb.mjs';
import { isEpsonEscprUsb, epsonEscprModelName } from './escprusb.mjs';
import { canScanUsbOffProcess, scanUsbOffProcess } from './usb-enum.mjs';

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
  ['04f9:0478', 'Brother DCP-T820DW'],
  ['1343:0003', 'DNP DS40'],
  ['1343:0004', 'DNP DS80'],
  ['1343:0005', 'DNP DS-RX1 / RX1HS'],
  ['1343:0008', 'DNP DS80D'],
  ['1452:8b01', 'DNP DS620 / DS620A'],
  ['1452:9001', 'DNP DS820 / DS820A']
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
  return interfaces.find((i) => i.cls === 7 && i.sub === 1 && i.proto === 2 && i.hasBulkPair)
    || interfaces.find((i) => i.cls === 7 && i.sub === 1 && i.proto === 2)
    || interfaces.find((i) => i.cls === 7 && i.sub === 1 && i.proto === 1)
    || null;
}

export function pickUsbSelphyInterface(interfaces) {
  return interfaces.find((i) => i.cls === 7 && i.sub === 1 && (i.proto === 2 || i.proto === 1) && i.hasBulkPair)
    || interfaces.find((i) => i.cls === 7 && i.hasBulkPair)
    || interfaces.find((i) => i.hasBulkPair)
    || null;
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

function buildPrinterProbeEntry({ vid, pid, bus, address, interfaces, product, manufacturer, deviceId, platform }) {
  const ippIface = pickUsbIppInterface(vid, interfaces);
  const rawIface = pickUsbRawInterface(interfaces);
  const idPair = `${hex4(vid)}:${hex4(pid)}`;
  const vendorName = VENDORS.get(vid) || manufacturer || '';
  const known = KNOWN_MODELS.get(idPair) || selphyModelName(vid, pid) || '';
  const from1284 = modelFromDeviceId(deviceId);
  let name = known || from1284 || '';
  if (!name && product) name = vendorName && !product.toLowerCase().includes(vendorName.toLowerCase()) ? `${vendorName} ${product}` : product;
  if (!name) name = (vendorName ? vendorName + ' ' : '') + `USB printer (${idPair})`;

  const selphy = isSelphyUsb(vid, pid, `${name} ${product} ${deviceId}`);
  const selphyIface = selphy ? pickUsbSelphyInterface(interfaces) : null;

  const dnpModel = dnpModelName(vid, pid, `${name} ${product} ${deviceId}`);
  const dnp = !!dnpModel;
  const dnpUnsupported = dnp ? dnpUnsupportedReason(dnpModel) : '';
  const dnpIface = (dnp && !dnpUnsupported) ? pickUsbSelphyInterface(interfaces) : null;

  const epsonEscprModel = (!selphy && !dnp) ? epsonEscprModelName(vid, pid, `${name} ${product}`, deviceId) : '';
  const epsonEscpr = !!epsonEscprModel;
  const escprIface = epsonEscpr ? (rawIface || pickUsbSelphyInterface(interfaces)) : null;

  const key = `usb:${bus || 0}:${address || 0}:${idPair}`;
  let note = '';
  if (selphy && selphyIface) {
    note = 'Canon SELPHY detected on USB: the app can print straight to it over USB with no driver.';
  } else if (dnp && dnpIface) {
    note = `DNP ${dnpModel} detected on USB: the app can print straight to it over USB (driverless, auto 2×6 cut, glossy/matte & live remaining media counter) or through its official DNP driver.`;
  } else if (dnp && dnpUnsupported) {
    note = dnpUnsupported;
  } else if (ippIface) {
    note = 'Supports driverless IPP-over-USB (7/1/4): the app can print straight to it over USB.';
  } else if (epsonEscpr && escprIface) {
    note = `Epson ${epsonEscprModel} detected on USB: the app can print straight to it over USB with no driver.`;
  } else if (vid === BROTHER_VID) {
    note = platform === 'win32'
      ? `${name} is connected on USB without an IPP-over-USB (7/1/4) interface. Install Brother’s Windows USB driver so it appears in your printer list, or connect it to Wi-Fi and use Find Wi-Fi / network printers for driverless printing.`
      : `${name} is connected on USB, but exposes only Brother’s proprietary USB interface (no IPP-over-USB 7/1/4) and macOS has no driver for it. Connect it to Wi-Fi and use Find Wi-Fi / network printers to print straight from this Mac with no driver.`;
  } else {
    note = platform === 'win32'
      ? `${name} is connected on USB without IPP-over-USB (7/1/4). Install its Windows driver so it appears in your printer list.`
      : `${name} is connected on USB without IPP-over-USB (7/1/4). Add it in System Settings → Printers & Scanners or connect over Wi-Fi.`;
  }

  return {
    key, vid, pid, vidHex: hex4(vid), pidHex: hex4(pid),
    bus: bus || 0, address: address || 0,
    name, product, manufacturer, deviceId,
    isSelphy: selphy,
    hasSelphyUsb: !!selphyIface,
    selphyIface,
    isDnp: dnp,
    dnpModel,
    dnpUnsupportedReason: dnpUnsupported,
    hasDnpUsb: !!dnpIface,
    dnpIface,
    isEpsonEscpr: epsonEscpr,
    epsonEscprModel,
    hasEscprUsb: !!escprIface,
    escprIface,
    hasIppUsb: !!ippIface,
    hasRawPrinter: !!rawIface,
    ippIface,
    interfaces,
    note
  };
}

/**
 * Probes every connected USB printer visible to libusb.
 * Inside Electron (when no test mock is active), runs libusb inside an isolated utilityProcess
 * so slow/suspended Windows USB hubs can never block the main UI thread.
 * Never throws: returns [] if libusb is unavailable or no USB printers are attached.
 */
export async function probeUsbPrinters({ platform = process.platform, readDescriptors = true, force = false, logger = null } = {}) {
  if (!usbOverride && canScanUsbOffProcess()) {
    const scan = await scanUsbOffProcess({ platform, readDescriptors, force, logger });
    if (!scan.unavailable) {
      if (!scan.ok || !Array.isArray(scan.printers)) return [];
      return scan.printers.map((raw) => buildPrinterProbeEntry({
        vid: raw.vid,
        pid: raw.pid,
        bus: raw.bus || 0,
        address: raw.address || 0,
        interfaces: Array.isArray(raw.interfaces) ? raw.interfaces : [],
        product: raw.product || '',
        manufacturer: raw.manufacturer || '',
        deviceId: raw.deviceId || '',
        platform
      }));
    }
  }
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
    const isPrinter = ifaces.some((i) => i.cls === 7) || vid === BROTHER_VID || isSelphyUsb(vid, pid, '') || isDnpUsb(vid, pid, '');
    if (!isPrinter) continue;
    const rawIface = pickUsbRawInterface(ifaces);
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
    results.push(buildPrinterProbeEntry({
      vid, pid, bus: dev.busNumber || 0, address: dev.deviceAddress || 0,
      interfaces: ifaces, product, manufacturer, deviceId, platform
    }));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isUsbTimeout = (e) => /TIMED_OUT|TIMEOUT/i.test(String((e && (e.message || e.errno)) || e));

async function readSelphyStatus(inEp, timeoutMs) {
  inEp.timeout = timeoutMs;
  try {
    const buf = await call((cb) => inEp.transfer(12, cb));
    return buf && buf.length ? buf : null;
  } catch (e) {
    if (isUsbTimeout(e)) return null;
    throw e;
  }
}

/**
 * Sends one or more Canon SELPHY Neo USB jobs (32-byte header + YUV444 planes) directly over libusb bulk pipes.
 * Mirrors NetPrintBridge.kt printSelphy: initial status check, wait for Idle (0x01), bulk write, wait for print cycle completion.
 */
export function usbSelphyPrint(entry, jobBuffers, { pollMs = 500, idleTimeoutMs = 45000, printTimeoutMs = 120000, writeTimeoutMs = 60000 } = {}) {
  const jobs = Array.isArray(jobBuffers) ? jobBuffers.filter((b) => b && b.length) : [];
  if (!jobs.length) return Promise.reject(new Error('No pages to print.'));
  return enqueueUsb(entry.key || `${entry.vid}:${entry.pid}`, async () => {
    const dev = findLiveDevice(entry);
    if (!dev) throw new Error('The Canon SELPHY USB printer is not connected. Check its USB cable and power.');
    const ifaces = inspectDeviceInterfaces(dev);
    const want = pickUsbSelphyInterface(ifaces);
    if (!want) throw new Error('This Canon SELPHY has no usable USB bulk printer interface.');
    let opened = false, claimed = null;
    try {
      try {
        dev.open();
        opened = true;
      } catch (e) {
        throw new Error('Could not open Canon SELPHY over USB (' + String((e && e.message) || e) + '). If macOS/Windows already added it as a system printer, choose that printer name instead, or connect it over Wi-Fi.');
      }
      const iface = dev.interface(want.num);
      try { if (iface.isKernelDriverActive && iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* macOS / Windows */ }
      try {
        iface.claim();
        claimed = iface;
      } catch (e) {
        throw new Error('Canon SELPHY USB port is busy (' + String((e && e.message) || e) + '). If it is already added in Printers & Scanners, choose that printer name instead.');
      }
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
      if (!outEp) throw new Error('Canon SELPHY has no USB data output endpoint.');
      if (!inEp) throw new Error('Canon SELPHY has no USB status reply endpoint.');
      outEp.timeout = Math.max(10000, Number(writeTimeoutMs) || 60000);

      // Initial status query to clear any stale error flag (matches NetPrintBridge.kt)
      const init = await readSelphyStatus(inEp, 3000);
      if (init && init.length >= 3 && init[2] !== 0) {
        await readSelphyStatus(inEp, 1000);
      }

      const ACTIVE_STATES = new Set([0x02, 0x04, 0x08, 0x10, 0x20]);
      for (const jobData of jobs) {
        // 1. Wait for printer to be Idle (status 0x01)
        const waitEnd = Date.now() + Math.max(1000, idleTimeoutMs);
        while (Date.now() < waitEnd) {
          const rd = await readSelphyStatus(inEp, 2000);
          if (rd && rd.length >= 12) {
            const status = rd[0] & 0xff;
            const err = rd[2] & 0xff;
            if (err !== 0) throw new Error('Canon SELPHY error: ' + selphyErrorDescription(err));
            if (status === 0x01) break;
          }
          if (pollMs > 0) await sleep(pollMs);
        }

        // 2. Write Neo YUV444 job over bulk OUT
        await writeBulk(outEp, Buffer.isBuffer(jobData) ? jobData : Buffer.from(jobData));

        // 3. Wait for print cycle to run and return to Idle (0x01)
        const printEnd = Date.now() + Math.max(2000, printTimeoutMs);
        let printingSeen = false;
        while (Date.now() < printEnd) {
          const rd = await readSelphyStatus(inEp, 3000);
          if (rd && rd.length >= 12) {
            const status = rd[0] & 0xff;
            const err = rd[2] & 0xff;
            if (err !== 0) throw new Error('Canon SELPHY error during print: ' + selphyErrorDescription(err));
            if (ACTIVE_STATES.has(status)) printingSeen = true;
            if (printingSeen && status === 0x01) break;
          }
          if (pollMs > 0) await sleep(pollMs);
        }
      }
      return { ok: true, pages: jobs.length };
    } finally {
      if (claimed) { try { await call((cb) => claimed.release(true, cb)); } catch { /* ignore */ } }
      if (opened) { try { dev.close(); } catch { /* ignore */ } }
    }
  });
}

async function dnpDrainIn(inEp) {
  if (!inEp) return;
  inEp.timeout = 60;
  for (let i = 0; i < 8; i++) {
    try {
      const piece = await call((cb) => inEp.transfer(4096, cb));
      if (!piece || !piece.length) break;
    } catch { break; }
  }
}

async function dnpQuery(outEp, inEp, group, name, timeoutMs = 4000) {
  if (!outEp || !inEp) return null;
  await dnpDrainIn(inEp);
  const cmd = dnpCmd(group, name, null);
  outEp.timeout = 5000;
  await call((cb) => outEp.transfer(cmd, cb));
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + Math.max(500, timeoutMs);
  inEp.timeout = Math.min(1500, Math.max(250, timeoutMs));
  while (Date.now() < deadline) {
    let piece = null;
    try { piece = await call((cb) => inEp.transfer(4096, cb)); }
    catch (e) {
      if (isUsbTimeout(e)) {
        if (total > 0) break;
        continue;
      }
      return null;
    }
    if (piece && piece.length > 0) {
      chunks.push(piece);
      total += piece.length;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      if (all.length >= 8) {
        const lenStr = all.subarray(0, 8).toString('ascii').trim();
        const len = /^\d+$/.test(lenStr) ? Number(lenStr) : NaN;
        if (!Number.isFinite(len)) return all.toString('ascii').trim();
        if (all.length >= 8 + len) return all.subarray(8, 8 + len).toString('ascii').trim();
      }
    } else if (total > 0) {
      break;
    }
  }
  const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  return all.length > 8 ? all.subarray(8).toString('ascii').trim() : null;
}

async function withDnpUsbSession(entry, { writeTimeoutMs = 60000 } = {}, fn) {
  const dev = findLiveDevice(entry);
  if (!dev) throw new Error('The DNP USB printer is not connected. Check its USB cable and power.');
  const ifaces = inspectDeviceInterfaces(dev);
  const want = pickUsbSelphyInterface(ifaces);
  if (!want) throw new Error('This DNP printer has no usable USB bulk printer interface.');
  let opened = false, claimed = null;
  try {
    try {
      dev.open();
      opened = true;
    } catch (e) {
      throw new Error('Could not open DNP printer over USB (' + String((e && e.message) || e) + '). If Windows/macOS already installed the DNP driver queue, choose that printer name instead.');
    }
    const iface = dev.interface(want.num);
    try { if (iface.isKernelDriverActive && iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* macOS / Windows */ }
    try {
      iface.claim();
      claimed = iface;
    } catch (e) {
      throw new Error('DNP USB port is busy (' + String((e && e.message) || e) + '). Choose the installed DNP driver queue instead.');
    }
    const altCount = ifaces.filter((i) => i.num === want.num).length;
    if ((want.alt !== 0 || altCount > 1) && typeof iface.setAltSetting === 'function') {
      await call((cb) => iface.setAltSetting(want.alt, cb));
    }
    let outEp = null, inEp = null;
    for (const ep of iface.endpoints || []) {
      if (ep.transferType !== 2) continue;
      if (ep.direction === 'out' && !outEp) outEp = ep;
      if (ep.direction === 'in' && !inEp) inEp = ep;
    }
    if (!outEp) throw new Error('DNP printer has no USB data output endpoint.');
    outEp.timeout = Math.max(10000, Number(writeTimeoutMs) || 60000);
    return await fn(outEp, inEp);
  } finally {
    if (claimed) { try { await call((cb) => claimed.release(true, cb)); } catch { /* ignore */ } }
    if (opened) { try { dev.close(); } catch { /* ignore */ } }
  }
}

/**
 * Queries live DNP status, free page buffers, and remaining media count (INFO MQTY) over USB.
 */
export function usbDnpStatus(entry, { queryTimeoutMs = 4000 } = {}) {
  return enqueueUsb(entry.key || `${entry.vid}:${entry.pid}`, async () => {
    return await withDnpUsbSession(entry, {}, async (outEp, inEp) => {
      const stRaw = await dnpQuery(outEp, inEp, 'STATUS', '', queryTimeoutMs);
      const statusCode = parseDnpIntReply(stRaw);
      const fbRaw = await dnpQuery(outEp, inEp, 'INFO', 'FREE_PBUFFER', queryTimeoutMs);
      const freeBuffers = parseDnpIntReply(fbRaw);
      const mqtyRaw = await dnpQuery(outEp, inEp, 'INFO', 'MQTY', queryTimeoutMs);
      const mediaRemaining = parseDnpMediaRemaining(mqtyRaw, entry.dnpModel || entry.name || '');
      const mediaCode = await dnpQuery(outEp, inEp, 'INFO', 'MEDIA', queryTimeoutMs);
      return {
        ok: true,
        model: entry.dnpModel || entry.name || 'DNP',
        statusCode,
        statusText: statusCode !== null ? dnpStatusText(statusCode) : 'Ready',
        isError: statusCode !== null && dnpIsError(statusCode),
        freeBuffers,
        mediaRemaining,
        mediaCode: mediaCode || ''
      };
    });
  });
}

/**
 * Sends one or more DNP ESC 'P' USB jobs directly over libusb bulk pipes.
 * Mirrors android/app/src/main/java/com/photobooth4u/booth/DnpJob.send: checks STATUS and INFO FREE_PBUFFER
 * before each sheet, writes bulk payload, waits for print completion, and reports live remaining prints (INFO MQTY).
 */
export function usbDnpPrint(entry, jobBuffers, {
  pollMs = 1000,
  busyTimeoutMs = 90000,
  printTimeoutMs = 120000,
  writeTimeoutMs = 60000,
  settleAfterMs = 6000,
  queryTimeoutMs = 4000
} = {}) {
  const jobs = Array.isArray(jobBuffers) ? jobBuffers.filter((b) => b && b.length) : [];
  if (!jobs.length) return Promise.reject(new Error('No pages to print.'));
  return enqueueUsb(entry.key || `${entry.vid}:${entry.pid}`, async () => {
    return await withDnpUsbSession(entry, { writeTimeoutMs }, async (outEp, inEp) => {
      const fail = (st) => { throw new Error('DNP printer: ' + dnpStatusText(st)); };
      let answers = !!inEp;
      for (const jobData of jobs) {
        if (answers && inEp) {
          const waitStart = Date.now();
          while (true) {
            const st = parseDnpIntReply(await dnpQuery(outEp, inEp, 'STATUS', '', queryTimeoutMs));
            if (st === null) { answers = false; break; }
            if (dnpIsError(st)) fail(st);
            const fb = parseDnpIntReply(await dnpQuery(outEp, inEp, 'INFO', 'FREE_PBUFFER', queryTimeoutMs));
            if (fb === null || fb > 0) break;
            if (Date.now() - waitStart > Math.max(1000, busyTimeoutMs)) {
              throw new Error('The DNP printer stayed busy for 90 seconds. Check it and retry.');
            }
            if (pollMs > 0) await sleep(pollMs);
          }
        }
        await writeBulk(outEp, Buffer.isBuffer(jobData) ? jobData : Buffer.from(jobData));
      }
      let mediaRemaining = null;
      if (answers && inEp) {
        const doneStart = Date.now();
        let started = false;
        while (Date.now() - doneStart < Math.max(2000, printTimeoutMs)) {
          if (pollMs > 0) await sleep(pollMs);
          const st = parseDnpIntReply(await dnpQuery(outEp, inEp, 'STATUS', '', queryTimeoutMs));
          if (st === null) break;
          if (dnpIsError(st)) fail(st);
          if (st === 1) started = true;
          if ((st === 0 || st === 900) && (started || Date.now() - doneStart > settleAfterMs)) break;
        }
        try {
          const mqtyRaw = await dnpQuery(outEp, inEp, 'INFO', 'MQTY', queryTimeoutMs);
          mediaRemaining = parseDnpMediaRemaining(mqtyRaw, entry.dnpModel || entry.name || '');
        } catch { /* optional telemetry */ }
      }
      return { ok: true, pages: jobs.length, mediaRemaining };
    });
  });
}

async function escprDrainInOnce(inEp) {
  if (!inEp) return;
  inEp.timeout = 40;
  for (let i = 0; i < 4; i++) {
    try {
      const piece = await call((cb) => inEp.transfer(1024, cb));
      if (!piece || !piece.length) break;
    } catch { break; }
  }
}

/**
 * Sends one or more Epson ESC/P-R USB jobs directly over libusb bulk OUT pipes (7/1/2 or 7/1/1).
 * Periodically drains bulk IN so the printer's bidirectional status buffer never fills and stalls writes.
 */
export function usbEscprPrint(entry, jobBuffers, {
  writeTimeoutMs = 90000,
  settleAfterMs = 400
} = {}) {
  const jobs = Array.isArray(jobBuffers) ? jobBuffers.filter((b) => b && b.length) : [];
  if (!jobs.length) return Promise.reject(new Error('No pages to print.'));
  return enqueueUsb(entry.key || `${entry.vid}:${entry.pid}`, async () => {
    const dev = findLiveDevice(entry);
    if (!dev) throw new Error('The Epson USB printer is not connected. Check its USB cable and power.');
    const ifaces = inspectDeviceInterfaces(dev);
    const want = pickUsbRawInterface(ifaces) || pickUsbSelphyInterface(ifaces);
    if (!want) throw new Error('This Epson printer has no usable USB bulk printer interface.');
    let opened = false, claimed = null;
    try {
      try {
        dev.open();
        opened = true;
      } catch (e) {
        throw new Error('Could not open Epson printer over USB (' + String((e && e.message) || e) + '). If macOS/Windows already added it as a system printer, choose that printer name instead.');
      }
      const iface = dev.interface(want.num);
      try { if (iface.isKernelDriverActive && iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* macOS / Windows */ }
      try {
        iface.claim();
        claimed = iface;
      } catch (e) {
        throw new Error('Epson USB port is busy (' + String((e && e.message) || e) + '). If it is already added in Printers & Scanners, choose that printer name instead.');
      }
      const altCount = ifaces.filter((i) => i.num === want.num).length;
      if ((want.alt !== 0 || altCount > 1) && typeof iface.setAltSetting === 'function') {
        await call((cb) => iface.setAltSetting(want.alt, cb));
      }
      let outEp = null, inEp = null;
      for (const ep of iface.endpoints || []) {
        if (ep.transferType !== 2) continue; // LIBUSB_TRANSFER_TYPE_BULK
        if (ep.direction === 'out' && !outEp) outEp = ep;
        if (ep.direction === 'in' && !inEp) inEp = ep;
      }
      if (!outEp) throw new Error('Epson printer has no USB data output endpoint.');
      outEp.timeout = Math.max(15000, Number(writeTimeoutMs) || 90000);
      await escprDrainInOnce(inEp);
      const CHUNK = 32 * 1024;
      for (let ji = 0; ji < jobs.length; ji++) {
        const buf = Buffer.isBuffer(jobs[ji]) ? jobs[ji] : Buffer.from(jobs[ji]);
        let chunksSinceDrain = 0;
        for (let off = 0; off < buf.length; off += CHUNK) {
          const slice = buf.subarray(off, Math.min(buf.length, off + CHUNK));
          await call((cb) => outEp.transfer(slice, cb));
          if (inEp && ++chunksSinceDrain >= 8) {
            chunksSinceDrain = 0;
            await escprDrainInOnce(inEp);
          }
        }
        await escprDrainInOnce(inEp);
        if (settleAfterMs > 0) await sleep(settleAfterMs);
      }
      return { ok: true, pages: jobs.length };
    } finally {
      if (claimed) { try { await call((cb) => claimed.release(true, cb)); } catch { /* ignore */ } }
      if (opened) { try { dev.close(); } catch { /* ignore */ } }
    }
  });
}
