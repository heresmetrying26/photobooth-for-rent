// Isolated Electron utilityProcess child that runs libusb getDeviceList() off the main UI thread.
//
// Why this runs in a separate OS process:
//   On Windows, libusb_get_device_list() synchronously queries SetupAPI and sends DeviceIoControl
//   requests to every USB hub and device. When USB Selective Suspend or a laptop USB controller
//   (e.g. ASUS VivoBook hubs, fingerprint sensors, integrated webcams) stalls a descriptor query,
//   running libusb on Electron's main thread blocks the Win32 message pump for >= 5 s and Windows
//   marks the app "(Not Responding)". Running it here keeps the main UI thread 100% free and lets
//   the parent cleanly kill this process if a kernel USB IOCTL hangs.
import { createRequire } from 'node:module';
import { isSelphyUsb, selphyModelName } from './selphyusb.mjs';
import { isDnpUsb } from './dnpusb.mjs';

const BROTHER_VID = 0x04f9;
const KNOWN_PRINTER_IDS = new Set([
  '04f9:0475', '04f9:0474', '04f9:0476', '04f9:0477', '04f9:0478',
  '1343:0003', '1343:0004', '1343:0005', '1343:0008',
  '1452:8b01', '1452:9001'
]);
const hex4 = (n) => Number(n || 0).toString(16).padStart(4, '0');

const call = (fn) => new Promise((resolve, reject) => {
  try { fn((err, res) => (err ? reject(err) : resolve(res))); } catch (e) { reject(e); }
});

function hasBulkPairDesc(alt) {
  let hasIn = false, hasOut = false;
  for (const ep of (alt && alt.endpoints) || []) {
    if ((ep.bmAttributes & 0x03) !== 2) continue;
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
  } catch { /* OS driver may hold interface */ }
  return '';
}

function reply(msg) {
  try {
    if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
      process.parentPort.postMessage(msg);
    }
  } catch { /* parent closed */ }
}

async function main() {
  let opts = {};
  try { opts = JSON.parse(process.env.PB4U_USB_SCAN_OPTS || '{}') || {}; } catch { opts = {}; }
  const targetPlatform = opts.platform || process.platform;
  const readDescriptors = opts.readDescriptors !== false;

  let usbLib = null;
  try {
    usbLib = createRequire(import.meta.url)('usb');
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e), ptp: [], printers: [] });
    return;
  }
  if (!usbLib || typeof usbLib.getDeviceList !== 'function') {
    reply({ ok: true, ptp: [], printers: [] });
    return;
  }

  let devs = [];
  try { devs = usbLib.getDeviceList() || []; } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e), ptp: [], printers: [] });
    return;
  }

  const ptp = [];
  const printers = [];

  for (const dev of devs) {
    const d = dev && dev.deviceDescriptor;
    if (!d) continue;
    const vid = d.idVendor, pid = d.idProduct;
    const bus = dev.busNumber || 0;
    const address = dev.deviceAddress || 0;
    const ifaces = inspectDeviceInterfaces(dev);

    if (ifaces.some((i) => i.cls === 6 && i.sub === 1)) {
      ptp.push({ vendor: vid, product: pid, bus, address, key: `${bus}:${address}` });
    }

    const isPrinter = ifaces.some((i) => i.cls === 7) || vid === BROTHER_VID || isSelphyUsb(vid, pid, '') || isDnpUsb(vid, pid, '');
    if (!isPrinter) continue;

    const idPair = `${hex4(vid)}:${hex4(pid)}`;
    const knownModel = KNOWN_PRINTER_IDS.has(idPair) || !!selphyModelName(vid, pid);
    const rawIface = ifaces.find((i) => i.cls === 7 && i.sub === 1 && (i.proto === 1 || i.proto === 2)) || null;
    let product = '', manufacturer = '', deviceId = '';

    // On Windows, usbprint.sys usually blocks dev.open(); skip opening devices we already recognize by VID:PID.
    const shouldOpen = readDescriptors && !(targetPlatform === 'win32' && knownModel);
    if (shouldOpen) {
      let opened = false;
      try {
        dev.open();
        opened = true;
        product = await readStringDesc(dev, d.iProduct);
        manufacturer = await readStringDesc(dev, d.iManufacturer);
        if (rawIface && targetPlatform !== 'win32') deviceId = await readDeviceId1284(dev, rawIface);
      } catch { /* OS driver holds the device; VID:PID fallback handles it */ }
      finally { if (opened) { try { dev.close(); } catch { /* ignore */ } } }
    }

    printers.push({
      vid,
      pid,
      bus,
      address,
      product,
      manufacturer,
      deviceId,
      interfaces: ifaces
    });
  }

  reply({ ok: true, ptp, printers });
}

main()
  .catch((e) => reply({ ok: false, error: String((e && e.message) || e), ptp: [], printers: [] }))
  .finally(() => { setTimeout(() => process.exit(0), 10); });
