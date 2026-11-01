// What USB devices does the Mac itself list? Asked when the USB camera can't be found, to tell "the cable / adapter / camera
// mode: macOS can't see a camera at all" apart from "macOS sees it but the booth can't use it". Mac only; elsewhere it says so and does nothing.
import { execFile } from 'node:child_process';

const CAMERA_VENDORS = [0x054c, 0x04b0, 0x04a9, 0x04cb, 0x07b4, 0x04da, 0x0a17];   // Sony, Nikon, Canon, Fujifilm, Olympus, Panasonic, Pentax

function run(bin, args, ms) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

// "0x04a9 (Canon Inc.)" -> 0x04a9
const hex = (v) => { const m = /0x([0-9a-f]{1,4})/i.exec(String(v || '')); return m ? parseInt(m[1], 16) : 0; };

// Walks system_profiler's tree (hubs hold their devices in _items) and lists every device.
export function collect(items, out = []) {
  for (const it of Array.isArray(items) ? items : []) {
    if (it && typeof it === 'object') {
      if (it.vendor_id || it.product_id) out.push({ name: String(it._name || ''), vendor: hex(it.vendor_id), product: hex(it.product_id) });
      if (it._items) collect(it._items, out);
    }
  }
  return out;
}

export function isCamera(d) {
  return CAMERA_VENDORS.includes(d.vendor) || /camera|\beos\b|dslr|alpha|mirrorless/i.test(d.name) && !/facetime|isight|webcam|integrated|hd camera/i.test(d.name);
}

// opts (for tests): { platform, exec }
export async function scanUsb(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin') return { ok: true, mac: false, count: 0, cameras: [] };
  const exec = opts.exec || run;
  for (const type of ['SPUSBHostDataType', 'SPUSBDataType']) {      // newer macOS lists devices under the "host" type
    const text = await exec('/usr/sbin/system_profiler', [type, '-json'], 9000);
    if (!text) continue;
    let tree;
    try { tree = JSON.parse(text)[type]; } catch { continue; }
    const devices = collect(tree).filter((d) => !/hub|bus|controller/i.test(d.name) || isCamera(d));
    if (!devices.length && type === 'SPUSBHostDataType') continue;
    const cameras = devices.filter(isCamera).map((d) => d.name || ('USB ' + d.vendor.toString(16) + ':' + d.product.toString(16)));
    return { ok: true, mac: true, count: devices.length, cameras, devices: devices.map((d) => d.name || '(no name)') };
  }
  return { ok: false, mac: true, count: 0, cameras: [] };
}
