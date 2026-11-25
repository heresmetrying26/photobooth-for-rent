// The Print Helper, built into the app: silent printing to a named printer
// (Windows: .NET printing in PowerShell; Mac: CUPS `lp`) and, on Windows, the
// Nikon / Canon EOS / Sony Alpha camera over USB through Windows' own camera driver (camera-worker.ps1).
// Same endpoints as tools/print-helper/print-helper.js, served to the booth at
// app://booth/helper/... (same origin, so no CORS or permission prompts).
import { tmpdir, platform, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { discoverNetworkPrinters, ippCaps, ippPrintDirect, waitIppIdle, pickMediaName, mediaSizeMm, directFormats, labelMediaType, diagNetworkInfo, ippDiagProbe, ippDiagPrint } from './netprinters.mjs';
import { probeUsbPrinters, makeUsbIppTransport, usbSelphyPrint } from './usbipp.mjs';
import { SELPHY_SPECS, selphySpecFor } from './selphyusb.mjs';
import * as gopro from './cam-gopro.mjs';

export const HELPER_VERSION = '1.1.12-app';
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin' || process.env.PB_TEST_MAC_CAMERA === '1';   // (the env var lets tests run the Mac camera path on another system)
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
let WORKER_PS = '';
// A PowerShell script file needs exactly ONE byte-order mark at the top (Windows PowerShell 5.1 reads it as UTF-8 that way).
// Two make PowerShell run the first comment line as code, so `param([int]$Port)` is ignored and the camera part connects to
// port 0 ("The requested address is not valid in its context 127.0.0.1:0"). Desktop 1.1.87 shipped that way.
export const psFileText = (src) => '﻿' + String(src == null ? '' : src).replace(/^﻿+/, '');
let log = (m) => console.log('[helper] ' + m);
let shrinkPage = null;   // (png Buffer, scale) -> png Buffer of the same size, the picture smaller in the middle on white. Given by the app (Electron).

let toJpeg = null;       // (png Buffer) -> jpeg Buffer. Given by the app (Electron). Needed for printing straight to a printer over IPP.
let rasterize = null;    // (png / jpeg Buffer, page spec) -> PWG Raster Buffer. Given by the app (Electron). For printers that take only PWG Raster (Brother DCP-T420W).
let buildSelphyJob = null;   // (png / jpeg Buffer, wMm, hMm, paperName) -> { data: Buffer, spec }. Given by Electron for native Canon SELPHY USB printing (Neo YUV444).
let selphyPrintOpts = {};
let ippWaitOpts = {};
let directFile = '';     // where the printers used without a driver are remembered between runs

// Printers used straight over IPP (Wi-Fi: Canon SELPHY, Brother DCP-T420W...), with no Windows / Mac driver. They show up
// in the printer list under a name like "Brother DCP-T420W (direct 192.168.1.50)" and the booth picks them like any other.
const direct = new Map();   // name -> { ip, port, path }
// USB printers used straight over libusb when no OS print queue exists for them:
// either driverless IPP-over-USB (7/1/4) or native Canon SELPHY Neo USB (CP820–CP1500).
const usbDirect = new Map();   // name -> usbProbe entry (with usbMode: 'ipp' | 'selphy')
let usbDirectAt = 0;
function loadDirect() {
  try {
    const a = JSON.parse(readFileSync(directFile, 'utf8'));
    for (const d of Array.isArray(a) ? a : []) if (d && d.name && /^\d{1,3}(\.\d{1,3}){3}$/.test(d.ip || '')) direct.set(String(d.name), { ip: d.ip, port: Number(d.port) || 631, path: String(d.path || '') });
  } catch { /* none saved yet */ }
}
function saveDirect() {
  if (!directFile) return;
  try { writeFileSync(directFile, JSON.stringify([...direct].map(([name, v]) => ({ name, ...v })))); } catch { /* ignore */ }
}

function directTarget(name) {
  if (direct.has(name)) {
    const d = direct.get(name);
    return { kind: 'wifi', ip: d.ip, port: d.port, path: d.path, transport: null };
  }
  if (usbDirect.has(name)) {
    const entry = usbDirect.get(name);
    if (entry.usbMode === 'selphy') return { kind: 'usb-selphy', entry };
    return { kind: 'usb', ip: 'localhost', port: 631, path: '', entry, transport: makeUsbIppTransport(entry) };
  }
  return null;
}

async function refreshUsbDirect(sysList, force, preFound) {
  if (!force && usbDirectAt && Date.now() - usbDirectAt < 8000) return;
  usbDirectAt = Date.now();
  try {
    const found = Array.isArray(preFound) ? preFound : await probeUsbPrinters();
    usbDirect.clear();
    const sys = (sysList || []).map((n) => ({ name: n, port: '', host: '' }));
    for (const p of found) {
      const canSelphy = !!(p.isSelphy && p.hasSelphyUsb && buildSelphyJob);
      const canIpp = !!p.hasIppUsb;
      if (!canSelphy && !canIpp) continue;
      // On both Windows and macOS, if the OS already has a print queue for this model (e.g. macOS AirPrint/CUPS queue,
      // Brother USB driver, or Microsoft IPP), keep using that OS queue rather than showing a duplicate "(USB direct)"
      // entry that can conflict with the OS holding the USB interface.
      if (installedAs({ ip: '', name: p.name }, sys)) continue;
      const clean = String(p.name || 'USB printer').replace(/\s*\(USB[^)]*\)\s*$/i, '').replace(/[^\w .\-+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'USB printer';
      const label = clean + ' (USB direct)';
      usbDirect.set(label, { ...p, usbMode: canSelphy ? 'selphy' : 'ipp' });
    }
  } catch { /* libusb unavailable or no USB printers */ }
}

let getSpinInboxDir = () => '';
const movieState = { active: false, state: 'idle', startedAt: 0, brand: '', outDir: '', error: '' };
function readMovieProgress() {
  const dir = movieState.outDir || (typeof getSpinInboxDir === 'function' ? String(getSpinInboxDir() || '') : '');
  let bytesDownloaded = 0, totalBytes = 0, filename = '';
  if (dir && existsSync(dir)) {
    try {
      const partName = readdirSync(dir).find((n) => n.endsWith('.part') && !n.endsWith('.part.meta'));
      if (partName) {
        const partPath = join(dir, partName);
        try { bytesDownloaded = statSync(partPath).size || 0; } catch { /* ignore */ }
        const metaPath = partPath + '.meta';
        if (existsSync(metaPath)) {
          try {
            const m = JSON.parse(readFileSync(metaPath, 'utf8'));
            totalBytes = Number(m && m.total) || 0;
            filename = String((m && m.filename) || partName.slice(0, -5));
          } catch { /* ignore */ }
        }
        if (!filename) filename = partName.slice(0, -5);
      }
    } catch { /* ignore */ }
  }
  const pct = totalBytes > 0 ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100)) : 0;
  return {
    ok: true,
    active: movieState.active,
    state: movieState.state,
    startedAt: movieState.startedAt,
    elapsedMs: movieState.startedAt ? Math.max(0, Date.now() - movieState.startedAt) : 0,
    brand: movieState.brand,
    outDir: dir,
    filename,
    bytesDownloaded,
    totalBytes,
    pct,
    error: movieState.error
  };
}

export function initHelper({ workerPath, logger, shrinkPage: shrink, toJpeg: jpeg, rasterize: raster, selphyJob, selphyPrintOpts: sOpts, ippWaitOpts: iOpts, directPrintersFile, spinInboxDir }) {
  if (logger) { log = logger; gopro.setLogger((m) => log('GoPro: ' + m)); }
  if (typeof shrink === 'function') shrinkPage = shrink;
  if (typeof jpeg === 'function') toJpeg = jpeg;
  if (typeof raster === 'function') rasterize = raster;
  if (typeof selphyJob === 'function') buildSelphyJob = selphyJob;
  else if (selphyJob === null) buildSelphyJob = null;
  selphyPrintOpts = sOpts && typeof sOpts === 'object' ? sOpts : {};
  ippWaitOpts = iOpts && typeof iOpts === 'object' ? iOpts : {};
  if (typeof spinInboxDir === 'function') getSpinInboxDir = spinInboxDir;
  else if (typeof spinInboxDir === 'string') getSpinInboxDir = () => spinInboxDir;
  usbDirect.clear();
  usbDirectAt = 0;
  if (directPrintersFile) { directFile = directPrintersFile; loadDirect(); }
  try { WORKER_PS = readFileSync(workerPath, 'utf8').replace(/^\uFEFF+/, ''); } catch { WORKER_PS = ''; }   // no BOM here: the one written in front of it at start-up is the only one PowerShell may see (two broke every start in 1.1.87)
  refreshPrinters();
  if (IS_WIN && WORKER_PS) camStart().catch((e) => log(String(e && e.message || e)));
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let out = '', err = '', p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message || e) }));
    p.on('close', (code) => resolve({ code, out, err }));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

// ---------- printers (listed in the background, so /status answers at once) ----------
let printersCache = { at: 0, list: [], loading: null };
async function listPrinters() {
  if (IS_WIN) {
    const r = await run('powershell.exe', [...PS, '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | ForEach-Object { $_.Name }']);
    return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const r = await run('lpstat', ['-e']);
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function refreshPrinters() {
  if (printersCache.loading) return printersCache.loading;
  // An empty answer (PowerShell slow or failed right after start-up) never replaces a good list, and is asked for again next time.
  printersCache.loading = listPrinters().then((list) => {
    if (!list.length && printersCache.list.length) return printersCache.list;
    printersCache.list = list; printersCache.at = list.length ? Date.now() : 0; return list;
  })
    .catch(() => printersCache.list).finally(() => { printersCache.loading = null; });
  return printersCache.loading;
}
async function systemPrinters(force) {
  if (force) return refreshPrinters();
  if (!printersCache.at) { await Promise.race([refreshPrinters(), new Promise((r) => setTimeout(r, 6000))]); return printersCache.list; }
  if (Date.now() - printersCache.at > 10000) refreshPrinters();
  return printersCache.list;
}
// The computer's own printers, then Wi-Fi direct IPP printers, then IPP-over-USB direct printers.
async function printers(force) {
  const list = await systemPrinters(force);
  await refreshUsbDirect(list, force);
  const extra = [...direct.keys(), ...usbDirect.keys()].filter((n) => !list.includes(n));
  return extra.length ? [...list, ...extra] : list;
}

// Remembers a printer to print to straight over IPP. Asks it first, so a wrong address is caught here and not at the event.
async function addDirectPrinter({ ip, port, path, name }) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) return { ok: false, error: 'Bad printer address.' };
  const p = Number(port) || 631, rp = /^\/[\w\-./]*$/.test(path || '') ? path : '';
  const caps = await ippCaps(ip, p, rp);
  if (!caps) return { ok: false, error: 'The printer at ' + ip + ' did not answer. Is it on and on the same Wi-Fi as this computer?' };
  const can = directFormats(caps, !!rasterize);   // a JPEG, or (a Brother DCP-T420W) a PWG Raster page the app makes itself
  if (!can.jpeg && !can.pwg) return { ok: false, error: (caps.model || name || 'This printer') + ' can’t take photos straight from the app. Use “Add to this computer” instead.' };
  const label = (String(name || caps.model || 'Photo printer').replace(/\s*\(direct[^)]*\)\s*$/i, '').replace(/[^\w .\-+]/g, ' ').replace(/\s+/g, ' ').trim() || 'Photo printer').slice(0, 48);
  const full = label + ' (direct ' + ip + ')';
  for (const [n, v] of [...direct]) if (v.ip === ip && n !== full) direct.delete(n);
  direct.set(full, { ip, port: p, path: caps.path });
  saveDirect();
  log('Direct printer: ' + full + ' (' + (caps.model || 'unknown model') + ')');
  return { ok: true, printer: full, direct: true };
}

// Verified English labels from Epson's official macOS L8050 PPD (/etc/cups/ppd/EPSON_L8050_Series.ppd).
// Used as a fallback whenever the PPD file cannot be read or leaves a numeric choice unlabeled; the PPD's own
// translation strings always win first so every Mac printer (L8050, L3210, Canon, Brother, HiTi, DNP...) gets
// its exact driver text instead of raw codes like "0", "145", or "306".
const MAC_EPSON_L8050_MEDIA_LABELS = {
  '0': 'Plain paper',
  '2': 'Epson Photo Quality Ink Jet',
  '12': 'Epson Matte',
  '13': 'Epson Premium Glossy',
  '15': 'Epson Premium Semigloss',
  '26': 'Disc Label',
  '75': 'Epson Photo Stickers',
  '92': 'Epson Ultra Glossy',
  '93': 'Envelope',
  '142': 'Letterhead',
  '145': 'Photo Paper Glossy',
  '198': 'PVC ID Card (Borders)',
  '199': 'PVC ID Card (Borderless)'
};
const MAC_EPSON_L8050_QUALITY_LABELS = {
  '302': 'Economy',
  '303': 'Normal',
  '304': 'Fine',
  '305': 'Quality',
  '306': 'High Quality',
  '308': 'Draft'
};
const MAC_EPSON_L8050_CHOICE_LABELS = {
  MediaType: MAC_EPSON_L8050_MEDIA_LABELS,
  EPIJ_Medi: MAC_EPSON_L8050_MEDIA_LABELS,
  EPIJ_Qual: MAC_EPSON_L8050_QUALITY_LABELS
};

function decodePpdString(s) {
  return String(s || '')
    .replace(/(?:<[0-9A-Fa-f]{2}>)+/g, (m) => {
      try { return Buffer.from(m.replace(/[<>]/g, ''), 'hex').toString('utf8'); } catch { return m; }
    })
    .trim();
}

function parsePpdChoiceLabels(ppd) {
  const byKey = Object.create(null);
  const put = (key, val, rawLabel, prefer) => {
    const label = decodePpdString(rawLabel);
    if (!key || !val || !label) return;
    const map = byKey[key] || (byKey[key] = Object.create(null));
    if (!map[val] || prefer || /^\d+$/.test(map[val])) map[val] = label;
  };
  for (const line of String(ppd || '').split(/\r?\n/)) {
    let m = /^\*en(?:_[A-Za-z]{2})?\.([A-Za-z0-9_-]+)\s+([^\s/:]+)\/([^:\r\n]+):/.exec(line);
    if (m) { put(m[1], m[2], m[3], true); continue; }
    m = /^\*([A-Za-z0-9_-]+)\s+([^\s/:]+)\/([^:\r\n]+):/.exec(line);
    if (m) put(m[1], m[2], m[3], false);
  }
  return byKey;
}

function fallbackChoiceLabel(printer, key, val) {
  if (/^EPIJ_Qual$/i.test(key) && MAC_EPSON_L8050_QUALITY_LABELS[val]) return MAC_EPSON_L8050_QUALITY_LABELS[val];
  if (EPSON_L8050.test(String(printer || ''))) {
    const map = MAC_EPSON_L8050_CHOICE_LABELS[key];
    if (map && map[val]) return map[val];
  }
  return '';
}

function parseCupsOptionsOutput(lpoptionsOut, ppdText, printer) {
  const ppdLabels = ppdText ? parsePpdChoiceLabels(ppdText) : Object.create(null);
  return String(lpoptionsOut || '').split(/\r?\n/).flatMap((line) => {
    const m = /^([^/:]+)\/([^:]*):\s*(.*)$/.exec(line);
    if (!m) return [];
    const key = m[1];
    const optLabels = ppdLabels[key] || null;
    const choices = m[3].trim().split(/\s+/).filter(Boolean).map((v) => {
      const value = v.replace(/^\*/, '');
      let label = (optLabels && optLabels[value]) || '';
      if (!label || /^\d+$/.test(label)) {
        const fb = fallbackChoiceLabel(printer, key, value);
        if (fb) label = fb;
      }
      return { value, label: label || value, selected: v.startsWith('*') };
    });
    return choices.length ? [{ key, label: decodePpdString(m[2]) || key, choices }] : [];
  });
}

async function cupsPrinterOptions(printer) {
  const r = await run('lpoptions', ['-p', printer, '-l']);
  if (r.code !== 0) throw new Error((r.err || r.out || 'Could not read printer options').trim());
  let ppd = '';
  try { ppd = await readFile('/etc/cups/ppd/' + printer + '.ppd', 'utf8'); } catch { ppd = ''; }
  return parseCupsOptionsOutput(r.out, ppd, printer);
}

function launchDetached(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    p.once('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    p.once('spawn', () => { p.unref(); resolve({ ok: true }); });
  });
}

async function openPrinterSettings(printer) {
  if (IS_WIN) {
    const r = await launchDetached('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', printer]);
    return r.ok ? { ok: true, message: 'Printer preferences opened. Set the loaded paper and print quality, then save or apply the changes.' } : r;
  }
  if (platform() === 'darwin') {
    const modern = Number(osRelease().split('.')[0]) >= 22;
    const app = modern ? 'System Settings' : 'System Preferences';
    const pane = modern ? 'x-apple.systempreferences:com.apple.Print-Scan-Settings.extension' : '/System/Library/PreferencePanes/PrintAndFax.prefPane';
    let r = await run('open', [pane]);
    if (r.code !== 0) r = await run('open', ['-a', app]);
    return r.code === 0 ? { ok: true, message: app + ' opened. Select “Printers & Scanners”, then choose “' + printer + '” to review its available settings. If it shows no paper or quality choices, the Mac is using Apple\u2019s generic driver: install the printer maker\u2019s driver for macOS, then press Configure printer again.' } : { ok: false, error: 'Could not open ' + app + '.' };
  }
  return { ok: false, error: 'Opening printer settings is supported on Windows and Mac.' };
}

async function openBluetoothSettings() {
  if (IS_WIN) {
    const r = await launchDetached('cmd.exe', ['/c', 'start', '', 'ms-settings:bluetooth']);
    return r.ok ? { ok: true, message: 'Bluetooth settings opened. Pair the printer, then add it in Printers & scanners so it appears in the printer list.' } : r;
  }
  if (platform() === 'darwin') {
    const r = await launchDetached('open', ['x-apple.systempreferences:com.apple.BluetoothSettings']);
    return r.ok ? { ok: true, message: 'Bluetooth settings opened. Pair the printer, then add it in Printers & Scanners so it appears in the printer list.' } : r;
  }
  return { ok: false, error: 'Opening Bluetooth settings is supported on Windows and Mac.' };
}

// ---------- network printers: find the ones on this Wi-Fi / LAN (like Windows "Add a printer"), and add one ----------
// What this computer already has: name + the address its port points at (Standard TCP/IP ports show it; WSD ports don't).
async function installedPrinterHosts() {
  if (IS_WIN) {
    const r = await run('powershell.exe', [...PS, '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | ForEach-Object { $p = Get-PrinterPort -Name $_.PortName -ErrorAction SilentlyContinue; ($_.Name + "`t" + $_.PortName + "`t" + $p.PrinterHostAddress) }']);
    return r.out.split(/\r?\n/).map((l) => l.split('\t')).filter((c) => c[0]).map((c) => ({ name: c[0].trim(), port: (c[1] || '').trim(), host: (c[2] || '').trim() }));
  }
  const r = await run('lpstat', ['-v']);
  return r.out.split(/\r?\n/).map((l) => /^device for ([^:]+):\s*(\S+)/.exec(l)).filter(Boolean).map((m) => ({ name: m[1].trim(), port: m[2], host: (/\/\/(?:[^@/]*@)?\[?([^\]:/]+)/.exec(m[2]) || [])[1] || '' }));
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// "EPSON L14150 Series" -> "l14150": Windows names the same printer "EPSONC95FED (L14150 Series)", so match on the model code.
const modelCode = (s) => { const m = String(s || '').match(/\b[A-Za-z]{0,4}-?[A-Za-z]?\d{3,}[A-Za-z0-9-]*\b/g); return m ? normName(m[m.length - 1]) : ''; };
function installedAs(printer, installed) {
  const byHost = printer.ip ? installed.find((i) => i.host === printer.ip || (i.port && i.port.includes(printer.ip))) : null;
  if (byHost) return byHost.name;
  const code = modelCode(printer.name);
  if (code.length >= 4) { const hit = installed.find((i) => normName(i.name).includes(code)); if (hit) return hit.name; }
  return '';
}
async function usbProbeReport() {
  const [usbFound, installed] = await Promise.all([probeUsbPrinters().catch(() => []), installedPrinterHosts().catch(() => [])]);
  await refreshUsbDirect(installed.map((i) => i.name), true, usbFound);
  return usbFound.map((p) => {
    const inst = installedAs({ ip: '', name: p.name }, installed);
    const usbDirectEntry = [...usbDirect.entries()].find(([, v]) => v.key === p.key);
    return {
      name: p.name,
      vid: p.vid,
      pid: p.pid,
      vidHex: p.vidHex,
      pidHex: p.pidHex,
      isSelphy: !!p.isSelphy,
      hasSelphyUsb: !!p.hasSelphyUsb,
      hasIppUsb: p.hasIppUsb,
      hasRawPrinter: p.hasRawPrinter,
      deviceId: p.deviceId,
      interfaces: p.interfaces.map((i) => `#${i.num} alt${i.alt} ${i.cls}/${i.sub}/${i.proto}${i.hasBulkPair ? ' bulk' : ''}`),
      installed: inst,
      usbDirectName: usbDirectEntry ? usbDirectEntry[0] : '',
      note: inst ? `Installed on this computer as “${inst}”.` : p.note
    };
  });
}
let discoverRun = null;
function discoverPrinters(extra) {
  if (!discoverRun) {
    discoverRun = (async () => {
      const [res, installed, usbPrinters] = await Promise.all([
        discoverNetworkPrinters({ extra }),
        installedPrinterHosts().catch(() => []),
        usbProbeReport().catch(() => [])
      ]);
      const withDirect = [...installed, ...[...direct.entries()].map(([name, v]) => ({ name, port: 'direct:' + v.ip, host: v.ip }))];
      return {
        ok: true,
        subnets: res.subnets,
        checked: res.checked,
        printers: res.printers.map((p) => ({ ...p, installed: installedAs(p, withDirect) })),
        usbPrinters
      };
    })().finally(() => { discoverRun = null; });
  }
  return discoverRun;
}
// A printer that takes PWG Raster and nothing the system's ready-made drivers use (no JPEG, no PDF, no Apple Raster): a Brother DCP-T420W.
// The app makes the raster pages itself and sends them over IPP, so it needs no driver on either system.
async function takesOnlyRaster(ip, port, path) {
  if (!rasterize) return false;
  const caps = await ippCaps(ip, port, path, 3000).catch(() => null);
  const f = (caps && caps.formats) || [];
  return f.includes('image/pwg-raster') && !f.includes('image/jpeg') && !f.includes('application/pdf') && !f.includes('image/urf');
}
async function addNetworkPrinter({ ip, port, path, name }) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) return { ok: false, error: 'Bad printer address.' };
  const p = Number(port) || 631, rp = /^\/[\w\-./]*$/.test(path || '') ? path : '/ipp/print';
  const url = `http://${ip}:${p}${rp}`;
  // macOS has no driver for such a printer (it is not AirPrint), so the app prints to it directly. Windows has its own IPP driver: tried first below.
  if (!IS_WIN && await takesOnlyRaster(ip, p, rp)) { log('Raster-only printer at ' + ip + ': used straight from the app, no Mac driver.'); return addDirectPrinter({ ip, port: p, path: rp, name }); }
  if (IS_WIN) {
    const script = '$ErrorActionPreference="Stop"; $b=@(Get-Printer|ForEach-Object Name); Add-Printer -IppURL "' + url + '"; $a=@(Get-Printer|ForEach-Object Name); ($a|Where-Object{$b -notcontains $_}) -join "`n"';
    const r = await run('powershell.exe', [...PS, '-Command', script]);
    const added = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (r.code === 0 && added) { await printers(true); return { ok: true, printer: added }; }
    // Windows could not add it, but the app can print to it by itself (a Brother DCP-T420W): no driver needed.
    if (await takesOnlyRaster(ip, p, rp)) { const d = await addDirectPrinter({ ip, port: p, path: rp, name }); if (d.ok) { log('Windows could not add the printer at ' + ip + '; using it straight from the app.'); return d; } }
    // Older Windows builds, or a printer that wants its own driver: hand over to Windows' own "Add a printer".
    launchDetached('cmd.exe', ['/c', 'start', '', 'ms-settings:printers']).catch(() => { });
    return { ok: false, opened: true, error: 'Windows could not add it by itself, so Printers & scanners was opened. Choose Add device and pick ' + (name || ip) + ' there, then come back and refresh.' };
  }
  const queue = (String(name || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Network_Printer_' + ip.replace(/\./g, '_')).slice(0, 60);
  const r = await run('lpadmin', ['-p', queue, '-E', '-v', `ipp://${ip}:${p}${rp}`, '-m', 'everywhere']);
  if (r.code !== 0) return { ok: false, error: (r.err || r.out || 'Could not add the printer.').trim() };
  await printers(true);
  return { ok: true, printer: queue };
}

// ---------- paper sizes: tell the printer which paper to use ----------
// Without this, the printer uses its own default paper (often A4 or Letter),
// so a 4R photo came out on A4. We look up the paper sizes the printer offers
// and pick the one that matches the booth's paper size (borderless if it has it).
const PAPER_CACHE = new Map();
const CAPS_CACHE = new Map();
function formatCapsLabel(val, disp) {
  if (disp && String(disp).trim()) return String(disp).trim();
  const s = String(val || '').replace(/^[a-z0-9]+:/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return s || String(val || '');
}
const WIN_CAPS_PS = String.raw`
param([string]$Printer)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Printing
Add-Type -AssemblyName ReachFramework
$pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
$tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
$cx = [xml]([IO.StreamReader]::new($pq.GetPrintCapabilitiesAsXml()).ReadToEnd())
$curNode = $tx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
$cur = if ($curNode) { $curNode.GetAttribute('name') } else { '' }
$opts = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']"))
foreach ($o in $opts) {
  $nm = $o.GetAttribute('name')
  if (-not $nm) { continue }
  $dn = $o.SelectSingleNode("*[local-name()='Property' and @name='psf:DisplayName']/*[local-name()='Value']")
  $label = if ($dn) { $dn.InnerText } else { '' }
  $sel = if ($nm -eq $cur) { '1' } else { '0' }
  '{0}|{1}|{2}' -f $nm, $label, $sel
}
# Does the driver offer a Borderless mode at all (read from the driver, no print)?
$blo = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']") | Where-Object { $_.GetAttribute('name') -eq 'psk:Borderless' })
'@borderless|' + $(if ($blo.Count -gt 0) { '1' } else { '0' })
`;
async function winPrinterCaps(printer) {
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try {
    const ps1 = join(dir, 'caps.ps1');
    await writeFile(ps1, '﻿' + WIN_CAPS_PS, 'utf8');
    const r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer]);
    const mediaTypes = [];
    let borderless = false;
    for (const line of r.out.split(/\r?\n/)) {
      if (/^@borderless\|1\s*$/.test(line)) { borderless = true; continue; }
      const m = /^([^|]+)\|([^|]*)\|([01])\s*$/.exec(line);
      if (!m) continue;
      const value = m[1].trim();
      mediaTypes.push({ value, label: formatCapsLabel(value, m[2]), selected: m[3] === '1' });
    }
    return { mediaTypes, borderless };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => { }); }
}
async function printerCaps(printer) {
  const c = CAPS_CACHE.get(printer);
  if (c && Date.now() - c.at < 120000) return c.caps;
  let caps = { mediaTypes: [] };
  try {
    if (IS_WIN) {
      caps = await winPrinterCaps(printer);
    } else {
      const opts = await cupsPrinterOptions(printer);
      const mt = opts.find((o) => /^media-?type$/i.test(o.key)) || opts.find((o) => /^EPIJ_Medi$/i.test(o.key));
      const epij = opts.find((o) => /^EPIJ_Medi$/i.test(o.key));
      const pInfo = await paperSizes(printer).catch(() => ({ sizes: [] }));
      const borderless = Array.isArray(pInfo.sizes) && pInfo.sizes.some((s) => s.borderless);
      if (mt) {
        caps = {
          mediaKey: mt.key,
          ...(epij && epij.key !== mt.key ? { epijMediaKey: epij.key } : {}),
          borderless,
          mediaTypes: mt.choices.map((ch) => ({ value: ch.value, label: formatCapsLabel(ch.value, ch.label && ch.label !== ch.value ? ch.label : ''), selected: !!ch.selected }))
        };
      } else {
        caps = { mediaTypes: [], borderless };
      }
    }
  } catch { caps = { mediaTypes: [] }; }
  CAPS_CACHE.set(printer, { at: Date.now(), caps });
  return caps;
}
// The glossy photo paper type of a driver's list ([{ value, label }] or plain strings), or '' when it has none it can be sure of.
// Read from the drivers installed on a real laptop (Windows PageMediaType): Epson "ns0000:EpsonPhotoPaperGlossy" (L8050, L805, L3210,
// L18050), Brother "psk:PhotographicGlossy", Canon "ns0000:PhotoPaperPlusGlossy2" / "GlossyPaperStandard"; the Epson L210 only has
// "psk:PhotographicHighGloss". Matte, luster, silky, semi-gloss, postcard and "contents" papers are never picked as glossy, and an
// opaque name (an HP driver names its papers by numbers) gives ''.
export function pickGlossyMediaType(list) {
  const items = (Array.isArray(list) ? list : []).map((m) => (typeof m === 'string' ? { value: m, label: '' } : m)).filter((m) => m && m.value);
  const bare = (m) => String(m.value).replace(/^[a-z0-9]+:/i, '');
  const prefs = [/^EpsonPhotoPaperGlossy$/i, /^PhotographicGlossy$/i, /^PhotoPaperPlusGlossy\d*$/i, /^GlossyPaperStandard$/i, /^PhotographicHighGloss$/i];
  for (const re of prefs) { const hit = items.find((m) => re.test(bare(m))); if (hit) return hit.value; }
  // macOS PPD labels (e.g. Epson L8050 lists "Epson Ultra Glossy" before "Photo Paper Glossy"): prefer standard Photo Paper Glossy,
  // then Premium Glossy, before falling back to any other glossy paper.
  const stdGlossy = items.find((m) => /^(?:epson\s+)?photo\s+paper\s+glossy$/i.test(String(m.label || '').trim()));
  if (stdGlossy) return stdGlossy.value;
  const premGlossy = items.find((m) => /premium.*gloss/i.test(String(m.label || '')) && !/semi|ultra|matte|luster|lustre/i.test(String(m.label || '')));
  if (premGlossy) return premGlossy.value;
  const generic = items.find((m) => /gloss/i.test(bare(m) + ' ' + (m.label || '')) && !/semi|contents|post.?card|hagaki|matte|luster|lustre|silky|plain|bond|bp71/i.test(bare(m) + ' ' + (m.label || '')));
  return generic ? generic.value : '';
}
const PAPER_NAMES = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], letter: [215.9, 279.4], legal: [215.9, 355.6],
  postcard: [100, 148], hagaki: [100, 148], l: [89, 127], '2l': [127, 178], kg: [102, 152], '4r': [102, 152], '5r': [127, 178], '6r': [152, 203], '8r': [203, 254], '3r': [89, 127],
  '80mm': [80, 297], '58mm': [58, 210], roll80: [80, 297], roll58: [58, 210], receipt80: [80, 297], receipt58: [58, 210]
};
function sizeFromName(key) {
  const k = String(key).toLowerCase();
  let m = /^w(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)/.exec(k);           // CUPS style: width and height in points
  if (m) return [Number(m[1]) * 25.4 / 72, Number(m[2]) * 25.4 / 72];
  m = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|in(?:ch(?:es)?)?)?/.exec(k.replace(/_/g, ' '));
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), u = m[3] || (a < 30 && b < 30 ? 'in' : 'mm');
    const f = u === 'mm' ? 1 : u === 'cm' ? 10 : 25.4;
    return [a * f, b * f];
  }
  const base = k.replace(/\.(?:fullbleed|borderless|fb|bl).*$/, '').replace(/[^a-z0-9]/g, '');
  return PAPER_NAMES[base] || null;
}
const isBorderlessName = (s) => /borderless|full.?bleed|\.fb\b|\bfb\b|\.bl\b|randlos|sans.?marge|sin.?bordes/i.test(String(s));
async function cupsPaperSizes(printer) {
  const sizes = [];
  // The printer's current default paper (marked * by lpoptions; it may carry cutting, e.g. DNP "w288h432-div2").
  const lo = await run('lpoptions', ['-p', printer, '-l']);
  let def = null;
  for (const line of lo.out.split(/\r?\n/)) {
    const m = /^(PageSize|media)\/[^:]*:.*?\*(\S+)/.exec(line);
    if (m) { def = m[2]; break; }
  }
  // 1) The printer's PPD lists every paper size with its exact dimensions (points).
  let ppd = '';
  try { ppd = await readFile('/etc/cups/ppd/' + printer + '.ppd', 'latin1'); } catch { ppd = ''; }
  if (ppd) {
    if (!def) { const d = /^\*DefaultPageSize:\s*(\S+)/m.exec(ppd); if (d) def = d[1]; }
    const area = {};
    for (const m of ppd.matchAll(/^\*ImageableArea\s+([^\s/:]+)(?:\/[^:]*)?:\s*"([\d.\s-]+)"/gm)) area[m[1]] = m[2].trim().split(/\s+/).map(Number);
    for (const m of ppd.matchAll(/^\*PaperDimension\s+([^\s/:]+)(?:\/([^:]*))?:\s*"([\d.]+)\s+([\d.]+)"/gm)) {
      const key = m[1], name = (m[2] || key).trim(), w = Number(m[3]), h = Number(m[4]), a = area[key];
      const full = a && a.length === 4 && a[0] <= 1 && a[1] <= 1 && a[2] >= w - 1 && a[3] >= h - 1;
      sizes.push({ key, name, w: w * 25.4 / 72, h: h * 25.4 / 72, borderless: full || isBorderlessName(key + ' ' + name) });
    }
  }
  if (sizes.length) return { sizes, def };
  // 2) No PPD (driverless printers): the PageSize / media choices, sized from their names.
  for (const line of lo.out.split(/\r?\n/)) {
    const m = /^(PageSize|media)\/[^:]*:\s*(.*)$/.exec(line);
    if (!m) continue;
    for (let key of m[2].trim().split(/\s+/)) {
      key = key.replace(/^\*/, '');
      const d = sizeFromName(key);
      if (d) sizes.push({ key, name: key, w: d[0], h: d[1], borderless: isBorderlessName(key), opt: m[1] });
    }
    if (sizes.length) break;
  }
  return { sizes, def };
}
const WIN_PAPER_PS = String.raw`
param([string]$Printer)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$ps = New-Object System.Drawing.Printing.PrinterSettings
$ps.PrinterName = $Printer
if (-not $ps.IsValid) { throw "Printer not found: $Printer" }
'DEFAULT|' + $ps.DefaultPageSettings.PaperSize.PaperName
foreach ($p in $ps.PaperSizes) { '{0}|{1}|{2}' -f $p.PaperName, $p.Width, $p.Height }
`;
async function winPaperSizes(printer) {
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try {
    const ps1 = join(dir, 'paper.ps1');
    await writeFile(ps1, '﻿' + WIN_PAPER_PS, 'utf8');
    const r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer]);
    const sizes = [];
    let def = null;
    for (const line of r.out.split(/\r?\n/)) {
      if (line.startsWith('DEFAULT|')) { def = line.slice(8).trim() || null; continue; }
      const m = /^(.*)\|(\d+)\|(\d+)\s*$/.exec(line);
      if (!m || !Number(m[2]) || !Number(m[3])) continue;
      sizes.push({ key: m[1], name: m[1], w: Number(m[2]) * 0.254, h: Number(m[3]) * 0.254, borderless: isBorderlessName(m[1]) });
    }
    return { sizes, def };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => { }); }
}
async function paperSizes(printer) {
  const c = PAPER_CACHE.get(printer);
  if (c && Date.now() - c.at < 120000) return { sizes: c.sizes, def: c.def };
  let info = { sizes: [], def: null };
  try { info = IS_WIN ? await winPaperSizes(printer) : await cupsPaperSizes(printer); } catch { info = { sizes: [], def: null }; }
  PAPER_CACHE.set(printer, { at: Date.now(), sizes: info.sizes, def: info.def });
  return { sizes: info.sizes, def: info.def };
}
// The printer's paper size for the booth's paper (mm), or null. Within 3 mm a side; borderless preferred.
// When the printer's default paper already is that size it's kept (keep: true), so its own
// settings (borderless, cutting) stay. A strip on a sheet twice as wide (cut in two) counts too.
// On dye-sub printers (HiTi, DNP, Citizen, Sinfonia, Mitsubishi...), also match split/2-UP paper slots
// when twoUp is explicitly requested, and avoid split slots when a whole 4x6 print is requested.
const near = (s, a, b, tol = 3) => { const sa = Math.min(s.w, s.h), sb = Math.max(s.w, s.h); return Math.abs(sa - a) <= tol && Math.abs(sb - b) <= tol; };
const SPLIT_PAPER_NAME = /(?:(?:^|[^a-z0-9])(?:split|2[\s_-]?up|div2|2[\s_-]?in(?:ch)?[\s_-]?cut|2[\s_-]?strips?)(?=$|[^a-z0-9])|(?:^|[^0-9])(?:2\s*[x×]\s*6|6\s*[x×]\s*2)(?=$|[^0-9])|cut[\s_-]?2\s*[x×]\s*6)/i;
export const isSplitPaperName = (s) => SPLIT_PAPER_NAME.test(String(s || ''));
const isSplitPaper = (s) => !!(s && isSplitPaperName((s.key || '') + ' ' + (s.name || '')));
async function pickPaper(printer, widthMm, heightMm, twoUp) {
  if (!(widthMm > 0 && heightMm > 0)) return null;
  const a = Math.min(widthMm, heightMm), b = Math.max(widthMm, heightMm);
  const allowTwoUp = twoUp !== false && (twoUp === true || a <= 60);
  const isDyeSub = DYE_SUB.test(String(printer || ''));
  const { sizes, def } = await paperSizes(printer);
  const d = def && sizes.find((s) => s.key === def);
  const matchesDim = (s, tol = 3) => near(s, a, b, tol) || (allowTwoUp && a / b < 0.45 && near(s, a * 2, b, tol));
  const scoreOf = (s, tol = 3) => {
    const sa = Math.min(s.w, s.h), sb = Math.max(s.w, s.h);
    const direct = Math.abs(sa - a) <= tol && Math.abs(sb - b) <= tol;
    const da = direct ? Math.abs(sa - a) : Math.abs(sa - a * 2);
    const db = Math.abs(sb - b);
    return da + db - (s.borderless ? 2.5 : 0);
  };
  if (isDyeSub && typeof twoUp === 'boolean') {
    const wantSplit = twoUp === true;
    const cands = sizes.filter((s) => matchesDim(s, 3));
    if (d && matchesDim(d, 3) && isSplitPaper(d) === wantSplit) return { ...d, keep: true };
    const preferred = cands.filter((s) => isSplitPaper(s) === wantSplit);
    if (preferred.length) {
      let bestPref = null;
      for (const s of preferred) {
        const score = scoreOf(s, 3);
        if (!bestPref || score < bestPref.score) bestPref = { ...s, score };
      }
      if (bestPref) return { ...bestPref, keep: bestPref.key === def };
    }
    // No distinct split/whole paper slot listed (e.g. a dedicated queue where 2-inch cut is a driver checkbox):
    // preserve the queue's default when its dimensions match so saved driver preferences stay intact.
    if (d && matchesDim(d, 3)) return { ...d, keep: true };
  } else if (d && matchesDim(d, 3)) {
    return { ...d, keep: true };
  }
  let best = null;
  for (const s of sizes) {
    if (!matchesDim(s, 3)) continue;
    const splitPenalty = isDyeSub && isSplitPaper(s) ? (twoUp === true || a <= 60 ? -4 : 4) : 0;
    const score = scoreOf(s, 3) + splitPenalty;
    if (!best || score < best.score) best = { ...s, score };
  }
  if (!best && /selphy|canon.*\bCP\s?\d{3,4}\b/i.test(printer)) {
    // A Canon SELPHY Postcard sheet is 100 x 148 mm (4.4 mm shorter than 4x6 in = 101.6 x 152.4 mm).
    // When the booth is set to 4x6 and the queue only lists Postcard, match it cleanly.
    if (d && matchesDim(d, 5)) return { ...d, keep: true };
    for (const s of sizes) {
      if (!matchesDim(s, 5)) continue;
      const score = scoreOf(s, 5);
      if (!best || score < best.score) best = { ...s, score };
    }
  }
  return best;
}

// macOS CUPS: when a single dye-sub queue exposes an explicit cut/split PPD option (not already encoded in PageSize
// and not a dedicated "2x6 cut" queue whose saved defaults should stay untouched), toggle only the exact option the PPD lists.
async function dyeSubCupsCutOptions(printer, twoUp, pick) {
  try {
    if (IS_WIN || typeof twoUp !== 'boolean' || !DYE_SUB.test(String(printer || ''))) return [];
    if (pick && isSplitPaper(pick)) return [];
    if (twoUp === true && /(?:2\s*[x×]\s*6|split|strip|cut)/i.test(String(printer || ''))) return [];
    const opts = await cupsPrinterOptions(printer);
    const cutOpt = opts.find((o) => /^(?:cut(?:ter|2x6|mode)?|split(?:mode)?|media-?cut|multi-?cut|hiti-?cut|2inch-?cut|strip-?cut)$/i.test(o.key));
    if (!cutOpt || !cutOpt.choices.length) return [];
    const pickChoice = twoUp
      ? cutOpt.choices.find((c) => /(?:2\s*[x×]\s*6|2[\s_-]?in|split|strip)/i.test(c.value))
        || cutOpt.choices.find((c) => /^(?:on|yes|true|1|enable|enabled|cut)$/i.test(c.value))
      : cutOpt.choices.find((c) => /^(?:off|no|none|false|0|disable|disabled|normal|standard|uncut)$/i.test(c.value));
    if (!pickChoice || pickChoice.selected) return [];
    log('Dye-sub CUPS cut option: ' + cutOpt.key + '=' + pickChoice.value);
    return ['-o', cutOpt.key + '=' + pickChoice.value];
  } catch { return []; }
}

// ---------- photo quality for AirPrint queues (Mac) ----------
// A printer added on a Mac as AirPrint is a driverless IPP queue and prints at its draft/normal
// quality unless told otherwise. For those queues only, ask for the best quality and photo paper,
// using just the options the queue lists (DNP / HiTi / SELPHY dye-sub and driver queues keep their own settings).
async function isAirPrintQueue(printer) {
  const r = await run('lpstat', ['-v', printer]);
  return /^device for [^:]+:\s*(?:ipps?|dnssd|mdns|ippusb):/im.test(r.out || '');
}
async function airPrintQualityOptions(printer, want) {
  try {
    if (DYE_SUB.test(printer)) return [];
    if (!(await isAirPrintQueue(printer))) return [];
    const opts = await cupsPrinterOptions(printer);
    const out = [], notes = [];
    const quality = opts.find((o) => /^(?:cups)?print-?quality$/i.test(o.key));
    if (quality) {
      const rank = want === 'draft' ? [/^(?:3|draft|fast)/i, /^(?:4|normal)/i] : want === 'normal' ? [/^(?:4|normal)/i] : [/^(?:5|high|best|photo)/i, /^(?:4|normal)/i];
      let best = null; for (const re of rank) { best = quality.choices.find((c) => re.test(c.value)); if (best) break; }
      if (best) { out.push('-o', quality.key + '=' + best.value); notes.push(quality.key + '=' + best.value); }
    } else { const pq = want === 'draft' ? 3 : want === 'normal' ? 4 : 5; out.push('-o', 'print-quality=' + pq); notes.push('print-quality=' + pq); }
    const type = opts.find((o) => /^media-?type$/i.test(o.key));
    if (type && !type.choices.some((c) => c.selected && /photo|glossy/i.test(c.value))) {
      const photo = type.choices.find((c) => /photo.*gloss|glossy/i.test(c.value)) || type.choices.find((c) => /photo/i.test(c.value));
      if (photo) { out.push('-o', type.key + '=' + photo.value); notes.push(type.key + '=' + photo.value); }
    }
    if (notes.length) log('AirPrint quality: ' + notes.join(', '));
    return out;
  } catch { return []; }
}

// ---------- photo quality for Epson macOS driver queues (EPIJ_Qual + Resolution) ----------
// Official Epson macOS drivers (e.g. L8050) default to Normal (303) and 360x360dpi, and are not AirPrint queues
// so airPrintQualityOptions above skips them. Match the booth's Best / Normal / Draft choice to the driver's real
// EPIJ_Qual and Resolution options, respecting Epson's own presets (e.g. Plain paper uses Fine 304 rather than High Quality 306).
function pickCupsDriverQualityOptions(opts, want, activeMediaVal) {
  if (!want || !Array.isArray(opts) || !opts.length) return [];
  const qualOpt = opts.find((o) => /^EPIJ_Qual$/i.test(o.key));
  if (!qualOpt || !qualOpt.choices || !qualOpt.choices.length) return [];
  const resOpt = opts.find((o) => /^Resolution$/i.test(o.key));
  const mediaOpt = opts.find((o) => /^EPIJ_Medi$/i.test(o.key)) || opts.find((o) => /^media-?type$/i.test(o.key));
  const activeChoice = (activeMediaVal && mediaOpt && mediaOpt.choices.find((c) => c.value === activeMediaVal))
    || (mediaOpt && mediaOpt.choices.find((c) => c.selected)) || null;
  const mediaText = activeChoice ? String(activeChoice.label || activeChoice.value) : '';
  const isPlain = !!(activeChoice && (activeChoice.value === '0' || /\bplain\b|letterhead|envelope/i.test(mediaText)));
  const isSticker = !!(activeChoice && (activeChoice.value === '75' || /sticker/i.test(mediaText)));

  let qRanks;
  if (want === 'draft') {
    qRanks = [/^draft$/i, /^economy$/i, /draft|economy|fast/i, /^normal$/i];
  } else if (want === 'normal') {
    qRanks = isPlain
      ? [/^normal$/i, /^standard$/i, /^fine$/i, /^quality$/i]
      : [/^quality$/i, /^fine$/i, /^normal$/i, /^high\s*quality$/i];
  } else {
    // best
    qRanks = isPlain
      ? [/^fine$/i, /^quality$/i, /^normal$/i]
      : isSticker
        ? [/^quality$/i, /^fine$/i, /^high\s*quality$/i]
        : [/^high\s*quality$/i, /^best/i, /^photo/i, /^quality$/i, /^fine$/i];
  }
  let pickedQual = null;
  for (const re of qRanks) {
    pickedQual = qualOpt.choices.find((c) => re.test(String(c.label || c.value).trim()));
    if (pickedQual) break;
  }

  const out = [];
  if (pickedQual) out.push('-o', qualOpt.key + '=' + pickedQual.value);

  if (resOpt && Array.isArray(resOpt.choices) && resOpt.choices.length) {
    const parsed = resOpt.choices.map((c) => {
      const m = /(\d+)\s*x\s*(\d+)\s*dpi/i.exec(c.value) || /(\d+)\s*dpi/i.exec(c.value);
      return { choice: c, dpi: m ? Number(m[1]) : 0 };
    }).filter((x) => x.dpi > 0).sort((a, b) => a.dpi - b.dpi);
    if (parsed.length) {
      let pickedRes;
      if (want === 'draft' || (want === 'normal' && isPlain)) {
        pickedRes = parsed.find((x) => x.dpi >= 300 && x.dpi <= 400) || parsed.find((x) => x.dpi >= 300) || parsed[0];
      } else {
        const capped = parsed.filter((x) => x.dpi <= 1440);
        pickedRes = (capped.length ? capped : parsed)[(capped.length ? capped : parsed).length - 1];
      }
      if (pickedRes) out.push('-o', resOpt.key + '=' + pickedRes.choice.value);
    }
  }
  return out;
}

async function cupsDriverQualityOptions(printer, want, activeMediaVal) {
  try {
    if (!want || DYE_SUB.test(printer)) return [];
    if (await isAirPrintQueue(printer)) return [];
    const opts = await cupsPrinterOptions(printer);
    const out = pickCupsDriverQualityOptions(opts, want, activeMediaVal);
    if (out.length) log('Driver quality: ' + out.filter((x) => x !== '-o').join(', '));
    return out;
  } catch { return []; }
}

// ---------- borderless on AirPrint ink-tank printers (Mac) ----------
// An inkjet (Canon G3030, Epson ...) printing borderless enlarges the picture a little past the paper edge so no
// white line shows. Over AirPrint the Mac has no setting for how much, and a Canon G3030 trimmed about 2.5% off
// every side (the title, the footer and the characters at the edges). So on those queues the page is sent
// 2% smaller on white. At 100% a G3030 trimmed about 2.5 mm a side; at 96% it left about 2 mm of white, so 98% is
// close to edge to edge. Each printer and paper differs a little: the booth's Print settings > Edges (per printer)
// moves each side in or out from there.
// Dye-sub printers (SELPHY, DNP, HiTi ...) print borderless without enlarging, so their pages are left as they are.
const MAC_BORDERLESS_SCALE = 0.98;
// An Epson (L8050, L3210 ...) enlarges a borderless page more than the Canon does, and on a Mac it may be added with Epson's own
// driver instead of AirPrint, which the 98% above never reached: an L8050 trimmed the top strip and the right photos. So an Epson
// gets its own, smaller scale, whatever kind of queue it is. Edges fine-tunes it per printer.
// Measured on an L8050 (Epson driver queue, 4x6) with the edge test: at 94% nothing was trimmed but about 0.6-0.8 mm of white
// was left on the top, bottom and left (right: 0.5 mm trimmed). 96.5% puts about 0.7 mm past the top and bottom edges and
// about 1.2 mm past the left; the right loses about 2.5 mm.
const MAC_EPSON_BORDERLESS_SCALE = 0.965;
// The L8050 on 4x6, measured side by side. A real layout printed at 96.5% was matched to its on-screen preview (13 points, fit
// within 0.4 mm): the page as sent (portrait, a sideways layout turned clockwise) lost 0.8 mm at its top, 2.4 mm at its bottom,
// 0.95 mm on its left and 0.6 mm on its right. With the 94% edge test that gives the printer's enlargement: 5.1% across the short
// side, 6.0% along the long side, and the picture about 0.7 mm toward the bottom of the page. The values below undo that and
// leave about 0.5 mm past every edge (less shows white on some sheets: the feed varies about 0.3 mm). See shrinkBox for the fields.
const MAC_EPSON_L8050_4X6 = { x: 0.9608, y: 0.9496, dx: 0.001, dy: -0.0045 };
const EPSON_L8050 = /(?<![a-z0-9-])l[\s_-]?8050(?![0-9])/i;
const L8050_WIN_GLOSSY = 'ns0000:EpsonPhotoPaperGlossy';       // the paper type name in the L8050's Windows driver (read from the driver on a real laptop)
const EPSON = /epson|(?<![a-z0-9-])l[1-9]\d{2,4}(?![0-9])/i;
const DYE_SUB = /selphy|(?<![a-z])cp[\s_-]?d?\d{2,4}(?![0-9])|(?<![a-z])dnp(?![a-z])|(?<![a-z])ds[\s_-]?(?:rx|\d)|hiti|mitsubishi|kodak|citizen|sinfonia|shinko|dye/i;
async function macBorderlessScale(printer, pick) {
  if (!shrinkPage || !pick || !pick.borderless || DYE_SUB.test(printer)) return 1;
  if (EPSON_L8050.test(printer) && near(pick, 101.6, 152.4)) return MAC_EPSON_L8050_4X6;
  if (EPSON.test(printer)) return MAC_EPSON_BORDERLESS_SCALE;
  try { return (await isAirPrintQueue(printer)) ? MAC_BORDERLESS_SCALE : 1; } catch { return 1; }
}

// Epson L3210 on Windows, borderless: the driver enlarges the page past the paper edge, so a picture sent at 100% loses its edges
// (a strip's frame and the text on the border). Hardcoded: the picture is drawn at this fraction of the sheet, centred. The value
// is the one measured for the L8050 (see MAC_EPSON_BORDERLESS_SCALE); the booth's Print settings > Edges moves each side from here.
const WIN_EPSON_L3210_SCALE = 0.965;

// Epson L8050 on Windows, 4x6 in borderless. Read from Epson's own Windows driver for the L8050 (e1wf1b0e.inf) run into a file port:
// the job's page set-up is the sheet 2880 x 4320 and a print area of 3032 x 4400 (1/720 in) that starts 76 left of and 22 above the
// sheet, and a test page with thin lines (tools/epson-l8050/README.md) shows the driver enlarges the page 3032 / 2880 = 5.28% in both
// directions about the middle of that area, which sits 18 (0.64 mm) below the middle of the sheet. So a picture sent at 100% lost about
// 2.55 mm on the left and right, 3.2 mm at the top and 4.4 mm at the bottom. The picture is drawn smaller by that enlargement and
// 0.64 mm higher, plus 0.5 mm of bleed past every edge (the feed varies about 0.3 mm). The same numbers are in the Mac values above
// (MAC_EPSON_L8050_4X6: 1 / 1.0528 = 0.9498 and a drop of 0.6 mm), which were measured on paper. Kept here as numbers for the script
// below, and checked against the driver's own bytes in desktop/test/test-win-l8050.mjs.
export const WIN_EPSON_L8050_4X6 = { sheetW: 2880, sheetH: 4320, areaW: 3032, areaH: 4400, areaLeft: 76, areaTop: 22, bleedMm: 0.5 };

// The numbers above are for the driver's default Borderless setting: Printing preferences > Borderless > Settings > Auto Expand, slider on
// Std. The same dialog has a slider (Min / Med / Std) and "Retain Size"; the driver keeps them in its own bytes of the page settings
// (DEVMODE, byte 7940 = slider 0 Min, 1 Med, 2 Std; byte 7942 = 0 Auto Expand, 1 Retain Size; found by changing the setting in the driver
// and comparing the saved bytes; the layout is checked before they are read) and writes a different job for each. Read from the driver's job
// (tools/epson-l8050, 720 dpi, 4x6 in borderless) and from thin-line test pages through the same queue:
//   Std     area 3032 x 4400 at (-76, -22)  page enlarged 3032/2880 about the middle of the area, which sits 18 px below the sheet's middle
//   Med     area 2956 x 4362 at (-38, -12)  enlarged 2956/2880, middle 9 px below
//   Min     area 2920 x 4342 at (-20, -6)   enlarged 2920/2880, middle 5 px below
//   Retain  area 3032 x 4400 at (-76, -22)  NOT enlarged: the page sits 1:1 at the area's top-left corner, so on paper it is 76 px (2.68 mm)
//           too far left and 22 px (0.78 mm) too high: the left and top edges lose that much and the right and bottom edges stay white.
// A client's Retain Size was the white strip along two sides on a 4R print. Retain Size cannot print edge to edge from the app (the page
// is only 2880 x 4320, so the strips at the right and bottom cannot be drawn on): the picture covers the left and top edges and the
// operator is told to choose Auto Expand.
export const WIN_EPSON_L8050_EXPANSION = {
  std: { areaW: 3032, dy: 18 }, med: { areaW: 2956, dy: 9 }, min: { areaW: 2920, dy: 5 },
  retain: { left: 76, top: 22 },
  devmode: { size: 8192, driverVersion: 768, dmSize: 220, extra: 7972, level: 7940, method: 7942 }
};
const WIN_PRINT_PS = String.raw`
param([string]$Printer, [string]$ListFile, [switch]$FitWidth, [string]$PaperName, [string]$Quality = 'best', [string]$MediaType = '', [switch]$Borderless, [switch]$DyeSub, [int]$CustomW = 0, [int]$CustomH = 0, [int]$ActualW = 0, [int]$ActualH = 0, [double]$EpsonScale = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$files = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
if ($files.Count -eq 0) { throw "No pages to print" }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
# Epson L3210 (also when the queue is a shared or renamed one: the driver's name counts too). Its Windows driver enlarges a
# Borderless page past the paper edge by its own "Expansion" setting, which the app cannot change, so the picture is
# drawn a little smaller to land edge to edge instead of trimmed. Used only in the Borderless (whole sheet) case below.
$edgeScale = 1.0
# Epson L8050 (same way: the queue's or the driver's name). Its driver enlarges a 4x6 Borderless page 5.28% about a point 0.64 mm below
# the middle of the sheet, so a 4x6 picture is drawn smaller and higher by that (see WIN_EPSON_L8050_4X6). Only the 4x6 Borderless
# whole-sheet case below uses it.
$l8050 = $false
if ($EpsonScale -gt 0 -and $EpsonScale -lt 1 -and -not $DyeSub) {
  $dn = ''
  try { Add-Type -AssemblyName System.Printing; $dn = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer).QueueDriver.Name } catch { }
  if (-not $dn) { try { $dn = (Get-Printer -Name $Printer -ErrorAction Stop).DriverName } catch { } }
  if (("$Printer $dn") -match '(?<![a-z0-9])L[\s_-]?3210(?![0-9])') { $edgeScale = $EpsonScale }
  if (("$Printer $dn") -match '(?<![a-z0-9])L[\s_-]?8050(?![0-9])') { $l8050 = $true }
}
# Print quality and paper type: applied on top of the printer's own saved settings (its paper,
# Borderless and orientation stay as they are set). Dye-sub drivers (HiTi, DNP, Citizen, Sinfonia...)
# keep their 2-inch cut, matte/glossy finish and factory color calibration in private DEVMODE bytes, so
# we skip PrintTicketConverter mutations on them unless an explicit MediaType was picked.
if (-not $DyeSub -or $MediaType) {
for ($ptTry = 0; $ptTry -lt 2; $ptTry++) {
  try {
    Add-Type -AssemblyName System.Printing
    Add-Type -AssemblyName ReachFramework
    $pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
    $tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
    $tn = New-Object Xml.XmlNamespaceManager($tx.NameTable)
    $tn.AddNamespace('psf', 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework')
    $cx = [xml]([IO.StreamReader]::new($pq.GetPrintCapabilitiesAsXml()).ReadToEnd())
    if (-not $DyeSub) {
      $qo = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageOutputQuality']/*[local-name()='Option']") | ForEach-Object { $_.name })
      # Best (the default), Normal or Draft, set per printer in the booth. Only an option the driver really lists is used.
      # 'psk:High' is the standard name the Brother, Canon and HP drivers use for their best quality (Epson: ns0000:HighQuality).
      $qpat = switch ($Quality) { 'draft' { 'Draft|Fast|Economy' } 'normal' { 'Normal|Standard' } default { 'HighQuality|Best|Photographic|^psk:High$' } }
      $best = $qo | Where-Object { $_ -match $qpat } | Select-Object -First 1
      $qf = $tx.SelectSingleNode("//psf:Feature[@name='psk:PageOutputQuality']/psf:Option", $tn)
      if ($best -and $qf -and $qf.GetAttribute('name') -ne $best) {
        $qf.SetAttribute('name', $best)
        $vt = $pq.MergeAndValidatePrintTicket($pq.UserPrintTicket, (New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($tx.OuterXml)))))).ValidatedPrintTicket
        $vx = [xml]([IO.StreamReader]::new($vt.GetXmlStream()).ReadToEnd())
        $vq = $vx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageOutputQuality']/*[local-name()='Option']")
        if ($vq -and $vq.GetAttribute('name') -eq $best) {
          $dm = (New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)).ConvertPrintTicketToDevMode($vt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
          $hd = [Runtime.InteropServices.Marshal]::AllocHGlobal($dm.Length)
          [Runtime.InteropServices.Marshal]::Copy($dm, 0, $hd, $dm.Length)
          $doc.PrinterSettings.SetHdevmode($hd); $doc.DefaultPageSettings.SetHdevmode($hd)
          [Runtime.InteropServices.Marshal]::FreeHGlobal($hd)
          [Console]::Out.WriteLine('info|quality ' + $best)
        }
      }
    }
    if ($MediaType) {
      $mhas = $cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']") | Where-Object { $_.GetAttribute('name') -eq $MediaType } | Select-Object -First 1
      if ($mhas) {
        $mconv = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)
        $mh0 = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
        if (-not ('PB4U.K32' -as [type])) {
          Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
        }
        $mp = [PB4U.K32]::GlobalLock($mh0); $mn = ([PB4U.K32]::GlobalSize($mh0)).ToUInt32()
        $mb = New-Object byte[] $mn
        [Runtime.InteropServices.Marshal]::Copy($mp, $mb, 0, $mn)
        [void][PB4U.K32]::GlobalUnlock($mh0); [void][PB4U.K32]::GlobalFree($mh0)
        $mt0 = $mconv.ConvertDevModeToPrintTicket($mb)
        $mx = [xml]([IO.StreamReader]::new($mt0.GetXmlStream()).ReadToEnd())
        $mf = $mx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
        if ($mf -and $mf.GetAttribute('name') -ne $MediaType) {
          $mf.SetAttribute('name', $MediaType)
          $mvt = $pq.MergeAndValidatePrintTicket($mt0, (New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($mx.OuterXml)))))).ValidatedPrintTicket
          $mvx = [xml]([IO.StreamReader]::new($mvt.GetXmlStream()).ReadToEnd())
          $mvo = $mvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
          if ($mvo -and $mvo.GetAttribute('name') -eq $MediaType) {
            $mdm = $mconv.ConvertPrintTicketToDevMode($mvt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
            $mhd = [Runtime.InteropServices.Marshal]::AllocHGlobal($mdm.Length)
            [Runtime.InteropServices.Marshal]::Copy($mdm, 0, $mhd, $mdm.Length)
            $doc.PrinterSettings.SetHdevmode($mhd); $doc.DefaultPageSettings.SetHdevmode($mhd)
            [Runtime.InteropServices.Marshal]::FreeHGlobal($mhd)
            [Console]::Out.WriteLine('info|mediaType ' + $MediaType)
          } else { [Console]::Out.WriteLine('warn|Printer driver did not accept paper type "' + $MediaType + '".') }
        }
      }
    }
    break
  } catch {
    if ($ptTry -eq 0) { Start-Sleep -Milliseconds 250 }
    else { [Console]::Out.WriteLine('info|print ticket not applied: ' + $_.Exception.Message) }
  }
}
}
if ($PaperName) {
  $p = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $PaperName } | Select-Object -First 1
  if ($p) { $doc.DefaultPageSettings.PaperSize = $p }
}
# A size the renter typed in (4 x 12 in ...) that the driver has no paper for: ask the driver for its own "User-Defined"
# paper at exactly that size (Windows print ticket, Epson L-series list it with the width and length it can do). It is
# only kept when the driver confirms the size back; otherwise nothing changes and the printer's own paper is used,
# as before. Never errors out: a print always goes ahead.
$customApplied = $false
if ($CustomW -gt 0 -and $CustomH -gt 0 -and -not $PaperName) {
  try {
    Add-Type -AssemblyName System.Printing
    Add-Type -AssemblyName ReachFramework
    if (-not ('PB4U.K32' -as [type])) {
      Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
    }
    $cq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
    $cc = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $cq.ClientPrintSchemaVersion)
    $ch = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
    $cp = [PB4U.K32]::GlobalLock($ch); $cn = ([PB4U.K32]::GlobalSize($ch)).ToUInt32()
    $cb = New-Object byte[] $cn
    [Runtime.InteropServices.Marshal]::Copy($cp, $cb, 0, $cn)
    [void][PB4U.K32]::GlobalUnlock($ch); [void][PB4U.K32]::GlobalFree($ch)
    $cwMic = [int]($CustomW * 254); $chMic = [int]($CustomH * 254)
    $cxml = @'
<psf:PrintTicket xmlns:psf="http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework" xmlns:psk="http://schemas.microsoft.com/windows/2003/08/printing/printschemakeywords" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" version="1"><psf:Feature name="psk:PageMediaSize"><psf:Option name="psk:CustomMediaSize"><psf:ScoredProperty name="psk:MediaSizeWidth"><psf:ParameterRef name="psk:PageMediaSizeMediaSizeWidth"/></psf:ScoredProperty><psf:ScoredProperty name="psk:MediaSizeHeight"><psf:ParameterRef name="psk:PageMediaSizeMediaSizeHeight"/></psf:ScoredProperty></psf:Option></psf:Feature><psf:ParameterInit name="psk:PageMediaSizeMediaSizeWidth"><psf:Value xsi:type="xsd:integer">__W__</psf:Value></psf:ParameterInit><psf:ParameterInit name="psk:PageMediaSizeMediaSizeHeight"><psf:Value xsi:type="xsd:integer">__H__</psf:Value></psf:ParameterInit></psf:PrintTicket>
'@
    $cxml = $cxml.Replace('__W__', [string]$cwMic).Replace('__H__', [string]$chMic)
    $cwant = New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($cxml))))
    $cvt = $cq.MergeAndValidatePrintTicket($cc.ConvertDevModeToPrintTicket($cb), $cwant).ValidatedPrintTicket
    $cvx = [xml]([IO.StreamReader]::new($cvt.GetXmlStream()).ReadToEnd())
    $cvo = $cvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaSize']/*[local-name()='Option']")
    $cvw = $cvx.SelectSingleNode("//*[local-name()='ParameterInit' and @name='psk:PageMediaSizeMediaSizeWidth']")
    $cvh = $cvx.SelectSingleNode("//*[local-name()='ParameterInit' and @name='psk:PageMediaSizeMediaSizeHeight']")
    if ($cvo -and $cvo.GetAttribute('name') -eq 'psk:CustomMediaSize' -and $cvw -and $cvh -and [int]$cvw.InnerText -eq $cwMic -and [int]$cvh.InnerText -eq $chMic) {
      $cm = $cc.ConvertPrintTicketToDevMode($cvt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
      $chd = [Runtime.InteropServices.Marshal]::AllocHGlobal($cm.Length)
      [Runtime.InteropServices.Marshal]::Copy($cm, 0, $chd, $cm.Length)
      $doc.PrinterSettings.SetHdevmode($chd); $doc.DefaultPageSettings.SetHdevmode($chd)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($chd)
      # .NET reads the driver's own User-Defined entry back (A4); tell it the size that was really asked for.
      $cur = $doc.DefaultPageSettings.PaperSize
      $np = New-Object System.Drawing.Printing.PaperSize($cur.PaperName, $CustomW, $CustomH)
      $np.RawKind = $cur.RawKind
      $doc.DefaultPageSettings.PaperSize = $np
      $customApplied = $true
      [Console]::Out.WriteLine('info|custom paper ' + $CustomW + 'x' + $CustomH + ' (1/100 in) set on the driver')
    } else { [Console]::Out.WriteLine('warn|Printer driver did not accept custom paper size (' + [Math]::Round($CustomW / 100, 2) + 'x' + [Math]::Round($CustomH / 100, 2) + ' in); printed using "' + $doc.DefaultPageSettings.PaperSize.PaperName + '". Set up this custom size in Configure printer if needed.') }
  } catch { [Console]::Out.WriteLine('warn|Custom paper size could not be applied: ' + $_.Exception.Message) }
}
# Borderless: when the booth's paper matched one of the printer's papers, ask the driver for its Borderless mode on
# that paper (Epson L-series keep it as a separate switch, off unless someone ticked it in the printer's preferences,
# and with it off the page is fitted inside a ~3 mm margin: white edges). Only if the driver lists a Borderless
# option and accepts it on this paper; otherwise nothing changes.
if ($Borderless -and -not $DyeSub) {
  try {
    Add-Type -AssemblyName System.Printing
    Add-Type -AssemblyName ReachFramework
    if (-not ('PB4U.K32' -as [type])) {
      Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
    }
    $bq =(New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
    $bc = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $bq.ClientPrintSchemaVersion)
    $bh = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
    $bp = [PB4U.K32]::GlobalLock($bh); $bn = ([PB4U.K32]::GlobalSize($bh)).ToUInt32()
    $bb = New-Object byte[] $bn
    [Runtime.InteropServices.Marshal]::Copy($bp, $bb, 0, $bn)
    [void][PB4U.K32]::GlobalUnlock($bh); [void][PB4U.K32]::GlobalFree($bh)
    $bt = $bc.ConvertDevModeToPrintTicket($bb)
    $bx = [xml]([IO.StreamReader]::new($bt.GetXmlStream()).ReadToEnd())
    $bf = $bx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']")
    $bcx = [xml]([IO.StreamReader]::new($bq.GetPrintCapabilitiesAsXml()).ReadToEnd())
    $bhas = $bcx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option' and @name='psk:Borderless']")
    if ($bf -and $bhas -and $bf.GetAttribute('name') -ne 'psk:Borderless') {
      $bf.SetAttribute('name', 'psk:Borderless')
      $bd = New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($bx.OuterXml))))
      $bv = $bq.MergeAndValidatePrintTicket($bt, $bd).ValidatedPrintTicket
      $bvx = [xml]([IO.StreamReader]::new($bv.GetXmlStream()).ReadToEnd())
      $bvo = $bvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']")
      if ($bvo -and $bvo.GetAttribute('name') -eq 'psk:Borderless') {
        $bm = $bc.ConvertPrintTicketToDevMode($bv, [System.Printing.Interop.BaseDevModeType]::UserDefault)
        $bhd = [Runtime.InteropServices.Marshal]::AllocHGlobal($bm.Length)
        [Runtime.InteropServices.Marshal]::Copy($bm, 0, $bhd, $bm.Length)
        $doc.PrinterSettings.SetHdevmode($bhd); $doc.DefaultPageSettings.SetHdevmode($bhd)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($bhd)
        [Console]::Out.WriteLine('info|borderless switched on')
      } else { [Console]::Out.WriteLine('info|driver did not accept Borderless on this paper') }
    }
  } catch { [Console]::Out.WriteLine('info|borderless not set: ' + $_.Exception.Message) }
}
# Epson L8050 driver, Borderless > Settings: Auto Expand (slider Min / Med / Std) or Retain Size. It decides how far the driver enlarges a
# Borderless page, so the picture is drawn for the one that is set (see WIN_EPSON_L8050_EXPANSION). Read from the driver's own bytes of the
# page settings, and only when their layout is the one it was measured on; otherwise the default (Auto Expand, Std) is assumed.
$l8050Mode = ''; $l8050Level = 2
if ($l8050) {
  try {
    if (-not ('PB4U.K32' -as [type])) {
      Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
    }
    $xh = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
    $xp = [PB4U.K32]::GlobalLock($xh); $xn = ([PB4U.K32]::GlobalSize($xh)).ToUInt32()
    $xb = New-Object byte[] $xn
    [Runtime.InteropServices.Marshal]::Copy($xp, $xb, 0, $xn)
    [void][PB4U.K32]::GlobalUnlock($xh); [void][PB4U.K32]::GlobalFree($xh)
    if ($xn -ge 8192 -and [BitConverter]::ToUInt16($xb, 66) -eq 768 -and [BitConverter]::ToUInt16($xb, 68) -eq 220 -and [BitConverter]::ToUInt16($xb, 70) -eq 7972 -and $xb[7940] -le 2 -and $xb[7942] -le 1) {
      $l8050Mode = if ($xb[7942] -eq 1) { 'retain' } else { 'auto' }; $l8050Level = [int]$xb[7940]
      [Console]::Out.WriteLine('info|Epson L8050 driver Borderless setting: ' + $(if ($l8050Mode -eq 'retain') { 'Retain Size' } else { 'Auto Expand, ' + @('Min', 'Med', 'Std')[$l8050Level] }))
    } else { [Console]::Out.WriteLine('info|Epson L8050 driver settings have another layout than the one measured: Auto Expand, Std assumed') }
  } catch { [Console]::Out.WriteLine('info|Epson L8050 Borderless setting not read: ' + $_.Exception.Message) }
}
$doc.DocumentName = 'photobooth4u'
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.OriginAtMargins = $false
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$script:i = 0
$doc.add_PrintPage({
  param($sender, $e)
  $img = [System.Drawing.Image]::FromFile($files[$script:i])
  try {
    if ($FitWidth) {
      $pa = $e.PageSettings.PrintableArea
      $w = [single]$pa.Width; $h = [single]($w * $img.Height / $img.Width)
      if ($pa.Height -gt 0 -and $h -gt $pa.Height) { $h = [single]$pa.Height; $w = [single]($h * $img.Width / $img.Height) }
      $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $e.Graphics.DrawImage($img, [single](($pa.Width - $w) / 2), [single]0, $w, $h)
      $script:i++
      $e.HasMorePages = ($script:i -lt $files.Count)
      return
    }
    $page = $e.PageBounds
    $pageLandscape = $page.Width -gt $page.Height
    $imgLandscape = $img.Width -gt $img.Height
    if ($pageLandscape -ne $imgLandscape) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $e.Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $drawCrisp = {
      param([single]$dx, [single]$dy, [single]$dw, [single]$dh)
      $pts = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($dx, $dy),
        [System.Drawing.PointF]::new($dx + $dw, $dy),
        [System.Drawing.PointF]::new($dx, $dy + $dh)
      )
      $srcRect = New-Object System.Drawing.RectangleF 0, 0, ([single]$img.Width), ([single]$img.Height)
      $e.Graphics.DrawImage($img, $pts, $srcRect, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    }
    try {
    $hx = $e.PageSettings.HardMarginX; $hy = $e.PageSettings.HardMarginY
    # What the driver says it can print on this paper: the smaller of its printable area and the page's clip.
    # (.NET's PageSettings.PrintableArea stays in portrait even when the driver is set to Landscape.)
    $vis = $e.Graphics.VisibleClipBounds; $pa = $e.PageSettings.PrintableArea
    $paW = if (($pa.Width -gt $pa.Height) -ne $pageLandscape) { $pa.Height } else { $pa.Width }
    $paH = if (($pa.Width -gt $pa.Height) -ne $pageLandscape) { $pa.Width } else { $pa.Height }
    $clip = New-Object System.Drawing.RectangleF $vis.X, $vis.Y, ([Math]::Min($vis.Width, $paW)), ([Math]::Min($vis.Height, $paH))
    [Console]::Out.WriteLine(('info|sheet {0}x{1}, printable {2}x{3} at {4},{5}, hard margin {6},{7} (1/100 in)' -f $page.Width, $page.Height, $clip.Width, $clip.Height, $clip.X, $clip.Y, $hx, $hy))
    # The picture's true size on the sheet, when the booth's paper size is known. It is only given when none of the
    # driver's own papers matched: then the picture is printed at that size, never stretched to whatever paper the
    # printer happens to hold.
    $aw = 0; $ah = 0
    if ($ActualW -gt 0 -and $ActualH -gt 0) { if ($pageLandscape) { $aw = $ActualH; $ah = $ActualW } else { $aw = $ActualW; $ah = $ActualH } }
    # Dye-sub printers (HiTi, DNP, Citizen...) print full-bleed natively even when their Windows driver reports a
    # slightly inset PrintableArea (94-99% for cutter/bleed allowance); never shrink those into white borders.
    $fullBleed = ($clip.Width -ge $page.Width * 0.99 -and $clip.Height -ge $page.Height * 0.99) -or ($DyeSub -and $aw -le 0 -and $clip.Width -ge $page.Width * 0.92 -and $clip.Height -ge $page.Height * 0.92)
    if ($fullBleed) {
      # The driver says the whole sheet is printable (Borderless is on): the picture covers it edge to edge.
      # How far the driver enlarges it past the edge is its own setting (Epson: Borderless > Settings >
      # Expansion), so the app does not add a margin of its own: move that slider if a white line or a
      # trimmed edge shows.
      if ($edgeScale -lt 1) { [Console]::Out.WriteLine(('info|Epson L3210 borderless: picture drawn at {0}% so the driver''s enlargement does not trim the edges' -f [Math]::Round($edgeScale * 100, 1))) }
      $shortU = [Math]::Min($page.Width, $page.Height); $longU = [Math]::Max($page.Width, $page.Height)
      if ($l8050 -and $aw -le 0 -and [Math]::Abs($shortU - 400) -le 3 -and [Math]::Abs($longU - 600) -le 3 -and [Math]::Abs(($page.Width / $page.Height) / ($img.Width / $img.Height) - 1) -le 0.04) {
        # Epson L8050, 4x6 Borderless: the driver enlarges the page by $encl about a point $dyc below the middle of the sheet (along the
        # long side), so the picture is drawn $encl smaller, $dyc/$encl higher, and 0.5 mm bigger than the sheet on every side.
        $encl = 3032 / 2880
        $um = $shortU / 101.6                                  # page units (1/100 in) per mm, from the sheet itself
        $bl = 0.5 * $um; $dyc = (18 / 720 * 25.4) * $um
        # Auto Expand with the slider on Med or Min: the driver enlarges less (see WIN_EPSON_L8050_EXPANSION).
        if ($l8050Mode -eq 'auto' -and $l8050Level -eq 1) { $encl = 2956 / 2880; $dyc = (9 / 720 * 25.4) * $um }
        elseif ($l8050Mode -eq 'auto' -and $l8050Level -eq 0) { $encl = 2920 / 2880; $dyc = (5 / 720 * 25.4) * $um }
        # A page set to Landscape in the driver is turned by the driver, and which way is not known, so the 0.64 mm cannot be moved:
        # the bleed is 0.7 mm instead (no white either way, at most 1.3 mm trimmed on one side).
        if ($pageLandscape) { $bl = 0.7 * $um; $bw = [single](($page.Width + 2 * $bl) / $encl); $bh = [single](($page.Height + 2 * $bl) / $encl); $cx = $page.Width / 2; $cy = $page.Height / 2 }
        else { $bw = [single](($page.Width + 2 * $bl) / $encl); $bh = [single](($page.Height + 2 * $bl) / $encl); $cx = $page.Width / 2; $cy = $page.Height / 2 - $dyc / $encl }
        if ($l8050Mode -eq 'retain' -and -not $pageLandscape) {
          # Retain Size: no enlargement, and the page starts at the area's top-left corner (76 px left of and 22 px above the sheet at 720 dpi).
          # The picture covers the left and top edges (plus the bleed); the right and bottom strips are outside the page and stay white.
          $px = $shortU / 2880
          $rx0 = 76 * $px - $bl; $ry0 = 22 * $px - $bl
          [Console]::Out.WriteLine('warn|The Epson L8050 driver is set to Retain Size (Printing preferences > Borderless > Settings), so the right and bottom edge of the print keep a white strip of about 3 mm. Choose Auto Expand with the slider on Std there.')
          & $drawCrisp ([single](-$hx + $rx0)) ([single](-$hy + $ry0)) ([single]($page.Width - $rx0)) ([single]($page.Height - $ry0))
        } else {
        [Console]::Out.WriteLine(('info|Epson L8050 borderless 4x6: picture drawn at {0}% across and {1}% along so the driver''s enlargement does not trim the edges' -f [Math]::Round($bw / $page.Width * 100, 1), [Math]::Round($bh / $page.Height * 100, 1)))
        & $drawCrisp ([single](-$hx + $cx - $bw / 2)) ([single](-$hy + $cy - $bh / 2)) $bw $bh
        }
      } elseif ($aw -le 0 -and [Math]::Abs(($page.Width / $page.Height) / ($img.Width / $img.Height) - 1) -le 0.04) {
        $bw = [single]($page.Width * $edgeScale); $bh = [single]($page.Height * $edgeScale)
        & $drawCrisp ([single](-$hx + ($page.Width - $bw) / 2)) ([single](-$hy + ($page.Height - $bh) / 2)) $bw $bh
      } else {
        # A different shape or size from this sheet: never stretch it. Real size, centred (smaller only if it would not fit).
        if ($aw -gt 0) { $rs = [Math]::Min([Math]::Min($page.Width / $aw, $page.Height / $ah) * $edgeScale, 1.0); $w = [single]($aw * $rs); $h = [single]($ah * $rs) }
        else { $rs = [Math]::Min($page.Width / $img.Width, $page.Height / $img.Height) * $edgeScale; $w = [single]($img.Width * $rs); $h = [single]($img.Height * $rs) }
        & $drawCrisp ([single](-$hx + ($page.Width - $w) / 2)) ([single](-$hy + ($page.Height - $h) / 2)) $w $h
      }
    } else {
      # The driver keeps a margin it cannot print on. Fit the whole picture inside the part it says it can
      # print, so nothing is cut off at the edges.
      $s = [Math]::Min($clip.Width / $img.Width, $clip.Height / $img.Height)
      $sc = [Math]::Max($clip.Width / $img.Width, $clip.Height / $img.Height)
      if ($customApplied -and ($s / $sc) -ge 0.95) {
        # A renter's own size (the driver gives no Borderless on custom paper): the driver's own unprintable edge is
        # the only border left. Fill the whole printable area and trim the small excess (under 5%) evenly off the
        # two sides, instead of leaving extra white bars.
        $sw = [single]($clip.Width / $sc); $sh = [single]($clip.Height / $sc)
        $src = New-Object System.Drawing.RectangleF ([single](($img.Width - $sw) / 2)), ([single](($img.Height - $sh) / 2)), $sw, $sh
        $dst = New-Object System.Drawing.RectangleF $clip.X, $clip.Y, $clip.Width, $clip.Height
        $e.Graphics.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
      } else {
        if ($aw -gt 0) { $rs = [Math]::Min([Math]::Min($clip.Width / $aw, $clip.Height / $ah), 1.0); $w = [single]($aw * $rs); $h = [single]($ah * $rs) }
        else { $w = [single]($img.Width * $s); $h = [single]($img.Height * $s) }
        & $drawCrisp ([single]($clip.X + ($clip.Width - $w) / 2)) ([single]($clip.Y + ($clip.Height - $h) / 2)) $w $h
      }
    }
    } finally { $ia.Dispose() }
  } finally { $img.Dispose() }
  $script:i++
  $e.HasMorePages = ($script:i -lt $files.Count)
})
$doc.Print()
'ok'
`;
async function printPages(printer, pageItems, fit, widthMm, heightMm, quality, custom, opts) {
  opts = opts || {};
  const twoUp = typeof opts.twoUp === 'boolean' ? opts.twoUp : undefined;
  const reqPaperName = typeof opts.paperName === 'string' ? opts.paperName.trim() : '';
  let reqMediaType = typeof opts.mediaType === 'string' ? opts.mediaType.trim() : '';
  // Hardcoded: an Epson L8050 on Windows with no paper type picked prints on Epson Photo Paper Glossy. Its Windows driver's own
  // default is Plain paper (and Standard quality), so photos came out soft and dull, and an iPad that prints through this laptop
  // never had a way to say otherwise. Picking a paper type in Print settings (Plain included) overrides it. If this driver does not
  // list that paper type the print goes out as before and no warning is shown.
  // 'driver' (Print settings > Paper / media type > Driver default) means the operator wants the driver's own paper type left alone.
  const keepDriverMedia = reqMediaType === 'driver';
  if (keepDriverMedia) reqMediaType = '';
  let defaultedMedia = false;
  if (!reqMediaType && !keepDriverMedia && process.platform === 'win32' && EPSON_L8050.test(printer)) { reqMediaType = L8050_WIN_GLOSSY; defaultedMedia = true; }
  const warnings = [];
  const items = pageItems.map((p) => (Buffer.isBuffer(p) ? { buf: p, ext: 'png' } : p));
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try {
    const files = [];
    for (let i = 0; i < items.length; i++) { const f = join(dir, 'page' + (i + 1) + '.' + (items[i].ext || 'png')); await writeFile(f, items[i].buf); files.push(f); }
    let r;
    const resolvePick = async () => {
      if (fit === 'width') return null;
      if (reqPaperName) {
        const info = await paperSizes(printer);
        const found = info.sizes.find((s) => s.key === reqPaperName || s.name === reqPaperName);
        if (found) return { ...found, keep: found.key === info.def && !reqPaperName, explicit: true };
        return { key: reqPaperName, name: reqPaperName, borderless: isBorderlessName(reqPaperName), explicit: true };
      }
      return pickPaper(printer, widthMm, heightMm, twoUp);
    };
    const pick = await resolvePick();
    if (pick) log('Paper: ' + pick.name + (pick.explicit ? ' (selected by operator)' : pick.keep ? ' (the printer\'s default)' : ''));
    // Any printer that can print borderless prints on its glossy photo paper type unless a paper type was picked (the Epson L8050 on Windows
    // is done above): the driver lists a Borderless mode (Windows), or the paper matched is a borderless one (Mac). A dye-sub printer, a
    // receipt roll and an AirPrint queue on a Mac (which chooses its own photo paper in airPrintQualityOptions) are left as they are. If the
    // driver lists no glossy photo paper that can be told apart, or refuses it, the print goes out as before and no warning is shown.
    if (!reqMediaType && !keepDriverMedia && fit !== 'width' && !DYE_SUB.test(printer)) {
      try {
        const caps = await printerCaps(printer);
        if ((caps.borderless === true || !!(pick && pick.borderless)) && (IS_WIN || !(await isAirPrintQueue(printer)))) {
          const g = pickGlossyMediaType(caps.mediaTypes);
          if (g) { reqMediaType = g; defaultedMedia = true; log('Paper type: ' + g + ' (glossy photo paper, the default for a printer that prints borderless)'); }
        }
      } catch { /* no default: the print goes out as before */ }
    }
    const isDyeSub = DYE_SUB.test(String(printer || ''));
    if (IS_WIN) {
      const ps1 = join(dir, 'print.ps1'), list = join(dir, 'pages.txt');
      await writeFile(ps1, '﻿' + WIN_PRINT_PS, 'utf8');
      await writeFile(list, files.join('\r\n'), 'utf8');
      // A renter's own size with no matching paper in the driver: ask for it as a custom size (hundredths of an inch).
      const cust = custom && !pick && fit !== 'width' && widthMm > 0 && heightMm > 0
        ? ['-CustomW', String(Math.round(Math.min(widthMm, heightMm) / 25.4 * 100)), '-CustomH', String(Math.round(Math.max(widthMm, heightMm) / 25.4 * 100))] : [];
      if (cust.length) log('Paper: no match in the driver, asking for a custom ' + cust[1] + 'x' + cust[3] + ' (1/100 in)');
      // The booth's real paper size, so a sheet that is not the same shape is printed true to size and never stretched.
      // Only when no paper of the driver matched at all (a matched paper, including a strip on a 2x wider cut sheet, keeps its own handling).
      const actual = !pick && fit !== 'width' && widthMm > 0 && heightMm > 0
        ? ['-ActualW', String(Math.round(Math.min(widthMm, heightMm) / 25.4 * 100)), '-ActualH', String(Math.round(Math.max(widthMm, heightMm) / 25.4 * 100))] : [];
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list, ...(quality ? ['-Quality', quality] : []), ...(reqMediaType ? ['-MediaType', reqMediaType] : []), ...(fit === 'width' ? ['-FitWidth'] : []), ...(isDyeSub ? ['-DyeSub'] : []), ...(pick && (!pick.keep || pick.explicit) ? ['-PaperName', pick.key] : []), ...(!isDyeSub && ((pick && (pick.borderless || !pick.explicit)) || cust.length) ? ['-Borderless'] : []), '-EpsonScale', String(WIN_EPSON_L3210_SCALE), ...cust, ...actual]);
    } else {
      const scale = fit === 'width' ? 1 : await macBorderlessScale(printer, pick);
      const perSide = !!scale && typeof scale === 'object';
      const pct = (v) => Math.round(v * 1000) / 10 + '%';
      if (perSide || scale < 1) {
        let done = 0;
        for (let i = 0; i < files.length; i++) {
          try { const b = await shrinkPage(items[i].buf, scale); if (b && b.length) { await writeFile(files[i], b); done++; } } catch (e) { log('Borderless shrink failed: ' + (e && e.message || e)); }
        }
        if (done) log('Borderless: page sent at ' + (perSide ? pct(scale.x) + ' across and ' + pct(scale.y) + ' along the sheet (measured for this printer)' : pct(scale)) + ' so the printer\'s enlargement does not trim the edges');
      }
      const media = fit === 'width' && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(widthMm) + 'x' + Math.round(heightMm) + 'mm']
        : pick && (!pick.keep || pick.explicit) ? ['-o', (pick.opt === 'media' ? 'media=' : 'PageSize=') + pick.key]
          : custom && !pick && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(Math.min(widthMm, heightMm)) + 'x' + Math.round(Math.max(widthMm, heightMm)) + 'mm'] : [];
      const mopts = [];
      if (reqMediaType) {
        try {
          const caps = await printerCaps(printer);
          const mkey = caps.mediaKey || 'media-type';
          if (caps.mediaTypes && caps.mediaTypes.some((m) => m.value === reqMediaType)) {
            mopts.push('-o', mkey + '=' + reqMediaType);
            if (caps.epijMediaKey && caps.epijMediaKey !== mkey) mopts.push('-o', caps.epijMediaKey + '=' + reqMediaType);
            log('Media type: ' + mopts.filter((x) => x !== '-o').join(', '));
          }
        } catch { }
      }
      const cutOpts = await dyeSubCupsCutOptions(printer, twoUp, pick);
      const qopts = await airPrintQualityOptions(printer, quality);
      const dqopts = qopts.length ? [] : await cupsDriverQualityOptions(printer, quality, reqMediaType);
      r = await run('lp', ['-d', printer, ...media, ...cutOpts, ...mopts, ...qopts, ...dqopts, '-o', 'fit-to-page', '-t', 'photobooth4u', ...files]);
    }
    if (r.code !== 0) throw new Error((r.err || r.out || ('exit ' + r.code)).trim().slice(0, 300));
    for (const line of String(r.out || '').split(/\r?\n/)) {
      if (line.startsWith('info|')) log('Page: ' + line.slice(5));
      else if (line.startsWith('warn|')) { const w = line.slice(5).trim(); if (w && !(defaultedMedia && /did not accept paper type/i.test(w))) { warnings.push(w); log('Warn: ' + w); } }
    }
    return { warnings };
  } finally {
    setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => { }), 60000);
  }
}

// ---------- camera (Windows) ----------
// On a Mac (and as a WinUSB fallback on Windows) the camera part runs inside the app (lib/camera-mac.mjs, libusb); loaded on demand.
let macCamP = null;
const macCam = () => (macCamP || (macCamP = import('./camera-mac.mjs')));
let winUsbOpen = false;
const camOk = () => (IS_MAC ? true : IS_WIN ? (!!WORKER_PS || true) : !!process.env.PB_CAMERA_WORKER);
// hangs: calls in a row the camera never answered; recover: the camera part was restarted, so the next open tells a Canon to leave remote mode first; resetAt: when it was stopped last.
const cam = { proc: null, sock: null, server: null, starting: null, buf: Buffer.alloc(0), wait: null, seq: 0, queue: Promise.resolve(), open: null, hangs: 0, recover: false, resetAt: 0 };
function camReset(why) {
  if (why) log('Camera part stopped: ' + why);
  cam.resetAt = Date.now();
  try { cam.proc && cam.proc.kill(); } catch { /* gone */ }
  try { cam.sock && cam.sock.destroy(); } catch { /* gone */ }
  try { cam.server && cam.server.close(); } catch { /* gone */ }
  if (cam.wait) { const w = cam.wait; cam.wait = null; w.reject(new Error('The camera part stopped. Try again.')); }
  cam.proc = null; cam.sock = null; cam.server = null; cam.buf = Buffer.alloc(0); cam.open = null;
}
function camParse() {
  for (; ;) {
    const nl = cam.buf.indexOf(10);
    if (nl < 0) return;
    const head = cam.buf.subarray(0, nl).toString('utf8').trim().split(' ');
    const len = Number(head[3]) || 0;
    if (cam.buf.length < nl + 1 + len) return;
    const body = Buffer.from(cam.buf.subarray(nl + 1, nl + 1 + len));
    cam.buf = cam.buf.subarray(nl + 1 + len);
    const w = cam.wait;
    if (w && head[0] === w.id) {
      cam.wait = null;
      if (head[1] === 'OK' && (w.cmd === 'frame' || w.cmd === 'capture')) cam.hangs = 0;   // real work got through, not just a reconnect
      w.resolve({ status: head[1], kind: head[2], body, flags: head.slice(4) });
    }
  }
}
async function camStart() {
  if (cam.sock) return;
  if (cam.starting) return cam.starting;
  cam.starting = (async () => {
    // Give the USB connection a moment to settle after the camera part was stopped.
    const settle = 1500 - (Date.now() - cam.resetAt);
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    let onConn;
    const connected = new Promise((res) => { onConn = res; });
    const server = net.createServer((sock) => {
      if (cam.sock) { sock.end(); return; }
      cam.sock = sock;
      sock.on('data', (chunk) => { if (sock !== cam.sock) return; cam.buf = Buffer.concat([cam.buf, chunk]); camParse(); });
      sock.on('close', () => { if (sock === cam.sock) camReset('connection closed'); });
      sock.on('error', (e) => { if (sock === cam.sock) camReset(String(e && e.message || e)); });
      onConn();
    });
    cam.server = server;
    const port = await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res(server.address().port)); });
    let cmd, args;
    if (process.env.PB_CAMERA_WORKER) {
      const parts = process.env.PB_CAMERA_WORKER.split(' ');
      cmd = parts[0]; args = [...parts.slice(1), String(port)];
    } else {
      const dir = join(tmpdir(), 'photobooth4u-app');
      await mkdir(dir, { recursive: true });
      const ps1 = join(dir, 'camera-worker-' + HELPER_VERSION + '.ps1');
      await writeFile(ps1, psFileText(WORKER_PS), 'utf8');
      cmd = 'powershell.exe'; args = [...PS, '-File', ps1, '-Port', String(port)];
    }
    const proc = spawn(cmd, args, { windowsHide: true });
    cam.proc = proc;
    let early = '';
    const show = (d) => String(d).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((s) => { early += s + '\n'; if (/^\[camera\]/.test(s)) log(s.replace(/^\[camera\]\s*/, 'Camera: ')); });
    proc.stdout.on('data', show);
    proc.stderr.on('data', show);
    const exited = new Promise((res) => proc.on('close', (code) => res(code)));
    proc.on('close', () => { if (cam.proc === proc) camReset(); });
    proc.on('error', (e) => { early += String(e && e.message || e); });
    const timeout = new Promise((res) => setTimeout(() => res('timeout'), 60000));
    const r = await Promise.race([connected.then(() => 'ok'), exited.then((c) => 'exit ' + c), timeout]);
    if (r !== 'ok') {
      camReset();
      const msg = (early.split('\n').filter(Boolean).pop() || r).replace(/^\[camera\]\s*/, '');
      throw new Error('The camera part could not start (' + msg.slice(0, 200) + ').');
    }
  })().finally(() => { cam.starting = null; });
  return cam.starting;
}
// A GoPro (Open GoPro over USB or its Wi-Fi, lib/cam-gopro.mjs) answers the same commands as the DSLR camera part. A DSLR / mirrorless
// camera is used when one is plugged in; the GoPro when that is the camera found. Windows can list a GoPro as a picture-transfer
// device (MTP), so a device named like a GoPro never counts as a DSLR here.
const isGoproDev = (d) => /gopro|\bhero\s?\d/i.test(String((d && d.name) || '') + ' ' + String((d && d.maker) || ''));
const goproJson = (r) => { try { return r && r.status === 'OK' ? JSON.parse(r.body.toString('utf8')) : null; } catch { return null; } };
const dslrPresent = (j) => !!(j && (j.open || (j.devices || []).some((d) => d.camera && !isGoproDev(d))));
const WIN_LIBUSB = () => IS_WIN && !IS_MAC && !process.env.PB_CAMERA_WORKER;
async function winUsbList() {
  if (!WIN_LIBUSB()) return null;
  try {
    const r = await (await macCam()).call('list', '');
    return goproJson(r);
  } catch { return null; }
}
async function camDispatch(cmd, arg, timeoutMs) {
  if (cmd === 'diag') return camRaw(cmd, arg, timeoutMs);
  if (gopro.isOpen()) {
    if (cmd === 'open' && /\brecover\b/.test(arg || '')) await gopro.reset();   // the booth lost the picture: connect again from scratch
    else return gopro.call(cmd, arg);
  }
  if (winUsbOpen) {
    if (cmd === 'close') { const r = await camCallMac('close', '', timeoutMs); winUsbOpen = false; return r; }
    const r = await camCallMac(cmd, arg, timeoutMs);
    if (r.status === 'GONE') winUsbOpen = false;
    else if (cmd === 'list') { const j = goproJson(r); if (j && !j.open) winUsbOpen = false; }
    if (cmd !== 'open' || r.status === 'OK') return r;
    winUsbOpen = false;
  }
  if (cmd === 'list') {
    let r = null;
    let rawErr = null;
    if (WORKER_PS || !WIN_LIBUSB()) {
      try { r = await camRaw(cmd, arg, timeoutMs); } catch (e) { rawErr = e; }   // the DSLR part failed: a GoPro or WinUSB DSLR may still be there
    }
    const j = goproJson(r);
    if (dslrPresent(j)) return r;
    const u = await winUsbList();
    if (dslrPresent(u)) return { status: 'OK', kind: 'J', body: Buffer.from(JSON.stringify(u), 'utf8'), flags: [] };
    const g = await gopro.detect().catch(() => null);
    if (!g) { if (r) return r; if (rawErr) throw rawErr; return { status: 'OK', kind: 'J', body: Buffer.from('{"devices":[],"open":false,"name":""}', 'utf8'), flags: [] }; }
    const out = j || { devices: [] };
    out.devices = (out.devices || []).filter((d) => !isGoproDev(d)).concat([{ name: g.name, maker: 'GoPro', camera: true, gopro: true }]);
    return { status: 'OK', kind: 'J', body: Buffer.from(JSON.stringify(out), 'utf8'), flags: [] };
  }
  if (cmd === 'open') {
    const g = await gopro.detect().catch(() => null);
    if (g) {
      let present = false;
      try { present = dslrPresent(goproJson(await camRaw('list', '', 20000))); } catch { /* check WinUSB next */ }
      if (!present) {
        const u = await winUsbList();
        present = dslrPresent(u);
      }
      if (!present) return gopro.call('open', arg);
    }
    if (!WORKER_PS && WIN_LIBUSB()) {
      const ur = await camCallMac('open', arg, timeoutMs);
      if (ur.status === 'OK') winUsbOpen = true;
      return ur;
    }
    const r = await camRaw('open', arg, timeoutMs);
    if (r.status === 'OK' || !WIN_LIBUSB()) return r;
    const u = await winUsbList();
    if (!dslrPresent(u)) return r;
    const ur = await camCallMac('open', arg, timeoutMs);
    if (ur.status === 'OK') {
      winUsbOpen = true;
      log('Camera opened over direct USB (libusb/WinUSB fallback).');
      return ur;
    }
    const wpdErr = camError(r);
    const usbErr = camError(ur);
    if (wpdErr.code === 'NOCAMERA') return ur;
    if (/WinUSB|built-in camera driver/i.test(usbErr.error)) {
      const msg = wpdErr.code + ' ' + wpdErr.error + ' (If Windows\' built-in driver keeps refusing remote control, you can switch the camera to WinUSB once with Zadig and reconnect.)';
      return { status: r.status, kind: 'N', body: Buffer.from(msg, 'utf8'), flags: [] };
    }
    return r;
  }
  return camRaw(cmd, arg, timeoutMs);
}
function camCall(cmd, arg, timeoutMs) {
  const job = cam.queue.then(() => camDispatch(cmd, arg, timeoutMs));
  cam.queue = job.catch(() => { });
  return job;
}
// The DSLR camera part: the in-app code on a Mac, the PowerShell worker on Windows.
async function camRaw(cmd, arg, timeoutMs) {
  {
    if (IS_MAC) return camCallMac(cmd, arg, timeoutMs);
    await camStart();
    const id = String(++cam.seq);
    const reply = new Promise((resolve, reject) => { cam.wait = { id, cmd, resolve, reject }; });
    cam.sock.write(id + ' ' + cmd + (arg ? ' ' + arg : '') + '\n');
    let timer;
    const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs || 15000); });
    try { return await Promise.race([reply, to]); }
    catch (e) {
      if (e && e.message === 'timeout') {
        camReset('no answer to ' + cmd);
        cam.hangs++; cam.recover = true;
        throw new Error(cam.hangs >= 2
          ? 'The camera stopped answering again. Switch the camera off and on, check its USB cable, then try again.'
          : 'The camera didn’t answer. Check it is on and its USB cable is plugged in.');
      }
      throw e;
    } finally { clearTimeout(timer); }
  }
}
// Mac: the same call, answered by the in-app Canon code instead of a separate worker program.
async function camCallMac(cmd, arg, timeoutMs) {
  const m = await macCam();
  let timer;
  const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs || 15000); });
  try {
    const r = await Promise.race([m.call(cmd, arg), to]);
    if (r.status === 'OK' && (cmd === 'frame' || cmd === 'capture')) cam.hangs = 0;
    return r;
  }
  catch (e) {
    if (e && e.message === 'timeout') {
      log('Camera part stopped: no answer to ' + cmd);
      m.reset().catch(() => { });
      cam.hangs++; cam.recover = true;
      throw new Error(cam.hangs >= 2
        ? 'The camera stopped answering again. Switch the camera off and on, check its USB cable, then try again.'
        : 'The camera didn’t answer. Check it is on and its USB cable is plugged in.');
    }
    throw e;
  } finally { clearTimeout(timer); }
}
function camError(r) {
  const text = r.body.toString('utf8');
  const m = /^([A-Z]+) (.*)$/s.exec(text);
  return { code: r.status === 'GONE' ? 'GONE' : (m ? m[1] : 'ERROR'), error: m ? m[2] : text };
}

// ---------- requests from the booth ----------
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const printQueues = new Map();
function getPrintQueue(name) {
  if (!printQueues.has(name)) printQueues.set(name, Promise.resolve());
  return printQueues.get(name);
}

// path is what follows /helper (e.g. "/status", "/camera/open").
export async function handleHelper(req, path, search) {
  const method = req.method;
  if (method === 'GET' && path === '/status') {
    const refresh = search.get('refresh') === '1';
    if (refresh) { PAPER_CACHE.clear(); CAPS_CACHE.clear(); }
    return json({
      ok: true, app: 'photobooth4u-print-helper', builtIn: true, version: HELPER_VERSION, printerDiag: true, printers: await printers(refresh),
      camera: { supported: camOk(), open: !!cam.open, name: cam.open ? cam.open.name : '' }
    });
  }
  if (method === 'GET' && path === '/printer/caps') {
    const name = String(search.get('printer') || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404);
    const dt = directTarget(name);
    if (dt) {
      if (dt.kind === 'usb-selphy') return json({ ok: true, known: false, mediaTypes: [], mediaLabels: {}, mediaDefault: '', autoMedia: '' });
      const cached = CAPS_CACHE.get(name);
      if (cached && Date.now() - cached.at < 120000) return json({ ok: true, ...cached.caps });
      const caps = await ippCaps(dt.ip, dt.port, dt.path, 3500, dt.transport).catch(() => null);
      const list = (caps && Array.isArray(caps.mediaTypes) ? caps.mediaTypes : []).filter(Boolean);
      const mediaLabels = {};
      for (const kw of list) mediaLabels[kw] = labelMediaType(kw);
      const autoMedia = ((caps && caps.borderlessCap) || EPSON_L8050.test((caps && caps.model) || '')) && !/selphy/i.test((caps && caps.model) || '') && list.includes('photographic-glossy') ? 'photographic-glossy' : '';
      const out = { known: list.length > 0, mediaTypes: list, mediaLabels, mediaDefault: '', autoMedia };
      CAPS_CACHE.set(name, { at: Date.now(), caps: out });
      return json({ ok: true, ...out });
    }
    const raw = await printerCaps(name);
    const items = Array.isArray(raw && raw.mediaTypes) ? raw.mediaTypes : [];
    const mediaLabels = {};
    let mediaDefault = '';
    const mediaTypes = [];
    for (const it of items) {
      if (!it || !it.value) continue;
      mediaTypes.push(it.value);
      mediaLabels[it.value] = it.label || it.value;
      if (it.selected && !mediaDefault) mediaDefault = it.value;
    }
    // autoMedia: the paper type a print uses when none is picked (the glossy photo paper of a printer that prints borderless); the Print settings show it.
    const autoMedia = (raw && raw.borderless === true && !DYE_SUB.test(name)) ? pickGlossyMediaType(items) : '';
    return json({ ok: true, known: mediaTypes.length > 0, mediaTypes, mediaLabels, mediaDefault, autoMedia, ...(raw && raw.mediaKey ? { mediaKey: raw.mediaKey } : {}) });
  }
  if (method === 'GET' && path === '/printer/usb-probe') {
    try { return json({ ok: true, platform: platform(), printers: await usbProbeReport() }); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/configure' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const name = String(body.printer || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    if (directTarget(name)) {
      const msg = /selphy/i.test(name)
        ? 'This printer is used straight from the app, with no driver, so there are no system settings to change. Choose Postcard 100×148 mm paper in the app and load the matching paper and ink cassette.'
        : 'This printer is used straight from the app with no driver needed. Choose paper size, Paper Type (pick Glossy Photo Paper for borderless photo prints) and Print Quality right here in Print settings.';
      return json({ ok: true, message: msg });
    }
    if (platform() === 'darwin') {
      // macOS has no per-printer preferences window like Windows: hand the driver's own options (paper, media type, quality...) to the app to show.
      try { const options = await cupsPrinterOptions(name); if (options.length) return json({ ok: true, options }); } catch { /* fall back to System Settings */ }
    }
    return json(await openPrinterSettings(name));
  }
  if (path === '/printer/bluetooth' && method === 'POST') return json(await openBluetoothSettings());
  if (path === '/printer/discover' && method === 'GET') {
    const extra = String(search.get('ip') || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
    try { return json(await discoverPrinters(extra)); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/diag/info' && method === 'GET') {
    try { return json({ ok: true, ...diagNetworkInfo({ appVersion: HELPER_VERSION }) }); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/diag/probe' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    try {
      const res = await ippDiagProbe({ ip: body.ip, port: body.port || 631, rawPort: body.rawPort || 9100, cases: body.cases || null, appVersion: HELPER_VERSION });
      return json(res);
    } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/diag/print' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    try { return json(await ippDiagPrint(body)); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/add' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    try {
      if (body.direct === true) return json(await addDirectPrinter({ ip: String(body.ip || ''), port: body.port, path: String(body.path || ''), name: String(body.name || '') }));
      return json(await addNetworkPrinter({ ip: String(body.ip || ''), port: body.port, path: String(body.path || ''), name: String(body.name || '') }));
    }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/options' && method === 'GET') {
    const name = String(search.get('printer') || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    if (directTarget(name)) return json({ ok: true, options: [] });
    if (IS_WIN) return json({ ok: true, platformDialog: true, options: [] });
    try { return json({ ok: true, options: await cupsPrinterOptions(name) }); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/options' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const name = String(body.printer || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    if (directTarget(name)) return json({ ok: true });
    if (IS_WIN) return json(await openPrinterSettings(name));
    const selected = body.options && typeof body.options === 'object' ? { ...body.options } : {};
    try {
      const available = await cupsPrinterOptions(name), args = ['-p', name];
      // Epson macOS drivers expose both MediaType and EPIJ_Medi with identical codes; keep them in sync unless both were sent explicitly.
      if (selected.MediaType !== undefined && selected.EPIJ_Medi === undefined) selected.EPIJ_Medi = selected.MediaType;
      else if (selected.EPIJ_Medi !== undefined && selected.MediaType === undefined) selected.MediaType = selected.EPIJ_Medi;
      for (const [key, value] of Object.entries(selected)) {
        const option = available.find((x) => x.key === key);
        if (!option || !option.choices.some((x) => x.value === value)) continue;
        args.push('-o', key + '=' + value);
      }
      if (args.length > 2) {
        const r = await run('lpoptions', args);
        if (r.code !== 0) throw new Error((r.err || r.out || 'Could not save printer options').trim());
        PAPER_CACHE.delete(name);
        CAPS_CACHE.delete(name);
      }
      return json({ ok: true });
    } catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path.startsWith('/camera')) {
    if (!camOk()) return json({ ok: false, code: 'UNSUPPORTED', error: 'On a Mac the booth connects to the camera by itself.' }, 501);
    const send = (r, okFn) => {
      if (r.status === 'OK') return okFn();
      const e = camError(r);
      if (e.code === 'GONE' || e.code === 'NOCAMERA') cam.open = null;
      return json({ ok: false, code: e.code, error: e.error }, e.code === 'GONE' ? 410 : e.code === 'NOCAMERA' ? 404 : 409);
    };
    const classic = search.get('classic') === '1' ? 'classic' : '';   // booth setting "Classic Nikon behaviour": the camera part keeps its old JPEG / autofocus behaviour
    const jpeg = (body) => new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
    try {
      if (method === 'GET' && path === '/camera/diag' && IS_MAC) { const r = await camCall('diag', '', 8000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'GET' && path === '/camera') { const r = await camCall('list', '', 20000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'GET' && path === '/camera/info') { const r = await camCall('info', '', 8000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'POST' && path === '/camera/open') {
        if (search.get('fresh') === '1') cam.recover = true;   // the booth lost the picture: start a clean camera session
        const r = await camCall('open', [cam.recover ? 'recover' : '', classic].filter(Boolean).join(' '), 60000);
        cam.recover = false;
        return send(r, () => { cam.open = JSON.parse(r.body.toString('utf8')); log('Camera connected: ' + cam.open.name); return json({ ok: true, ...cam.open }); });
      }
      if (method === 'POST' && path === '/camera/af') { const afArg = [classic, search.get('pre') === '1' ? 'pre' : ''].filter(Boolean).join(' '); const r = await camCall('af', afArg, 15000); return send(r, () => json({ ok: true })); }
      if (method === 'POST' && path === '/camera/live') { const on = search.get('on') !== '0'; const r = await camCall('live', on ? 'on' : 'off', 20000); return send(r, () => json({ ok: true })); }
      if (method === 'GET' && path === '/camera/frame') { const r = await camCall('frame', '', 10000); return send(r, () => (r.kind === 'B' ? jpeg(r.body) : new Response(null, { status: 204 }))); }
      if (method === 'POST' && path === '/camera/capture') {
        const t0 = Date.now(); const r = await camCall('capture', classic, 45000);
        return send(r, () => {
          const miss = Array.isArray(r.flags) && r.flags.includes('focus-miss');   // a Nikon photo taken without a focus lock
          log('Photo taken (' + Math.round(r.body.length / 1024) + ' KB, ' + (Date.now() - t0) + ' ms)' + (miss ? ', NOT focused' : ''));
          const res = jpeg(r.body);
          if (miss) { res.headers.set('x-pb-focus', 'miss'); res.headers.set('access-control-expose-headers', 'x-pb-focus'); }
          return res;
        });
      }
      if (method === 'GET' && path === '/camera/battery') { const r = await camCall('battery', '', 10000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'GET' && path === '/camera/movie/status') { return json(readMovieProgress()); }
      // The booth's Camera check & 360 Video settings: read/set shutter, aperture, ISO & white balance (Nikon & Canon EOS; other cameras answer supported:false).
      // Only finite numbers ever reach the camera program: each value goes through Number().
      if (method === 'GET' && path === '/camera/props') { const r = await camCall('props', '', 10000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'POST' && path === '/camera/setprops') {
        const q = ['shutter', 'f', 'iso', 'wb'].map((k) => {
          const raw = search.get(k);
          if (raw === null || raw === '') return '';
          const v = Number(raw);
          return Number.isFinite(v) && (k === 'wb' ? (v >= 0 && v < 100000) : (v > 0 && v < 100000)) ? k + '=' + v : '';
        }).filter(Boolean).join('&');
        const r = await camCall('setprops', q, 20000);
        return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }));
      }
      if (method === 'POST' && path === '/camera/movie/start') {
        const outDir = typeof getSpinInboxDir === 'function' ? String(getSpinInboxDir() || '') : '';
        if (!outDir) return json({ ok: false, code: 'NOFOLDER', error: 'Spin inbox folder is not configured yet.' }, 409);
        try { mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
        movieState.active = true; movieState.state = 'recording'; movieState.startedAt = Date.now();
        movieState.outDir = outDir; movieState.error = ''; movieState.brand = (cam.open && cam.open.brand) || '';
        const r = await camCall('moviestart', '', 25000);
        if (r.status !== 'OK') { movieState.active = false; movieState.state = 'idle'; movieState.startedAt = 0; }
        return send(r, () => {
          const info = JSON.parse(r.body.toString('utf8'));
          movieState.brand = info.brand || movieState.brand;
          return json({ ok: true, ...info, startedAt: movieState.startedAt });
        });
      }
      if (method === 'POST' && path === '/camera/movie/stop') {
        const outDir = movieState.outDir || (typeof getSpinInboxDir === 'function' ? String(getSpinInboxDir() || '') : '');
        if (!outDir) { movieState.active = false; movieState.state = 'idle'; return json({ ok: false, code: 'NOFOLDER', error: 'Spin inbox folder is not configured yet.' }, 409); }
        try { mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
        movieState.state = 'downloading'; movieState.outDir = outDir;
        try {
          const r = await camCall('moviestop', outDir, 180000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }));
        } finally {
          movieState.active = false; movieState.state = 'idle'; movieState.startedAt = 0;
        }
      }
      if (method === 'POST' && path === '/camera/close') { movieState.active = false; movieState.state = 'idle'; movieState.startedAt = 0; movieState.error = ''; const r = await camCall('close', '', 10000); cam.open = null; return send(r, () => json({ ok: true })); }
    } catch (e) {
      cam.open = null;
      return json({ ok: false, code: 'HELPER', error: String(e && e.message || e) }, 503);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }
  if (method === 'GET' && path === '/paper') {
    const name = String(search.get('printer') || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404);
    const twoUpQ = search.get('twoUp');
    const twoUp = twoUpQ === '1' ? true : twoUpQ === '0' ? false : undefined;
    const dtPaper = directTarget(name);
    if (dtPaper) {
      if (dtPaper.kind === 'usb-selphy') {
        const w = Number(search.get('w')) || 0, h = Number(search.get('h')) || 0;
        const spec = w > 0 && h > 0 ? selphySpecFor(w, h) : null;
        const paperList = SELPHY_SPECS.map((s) => ({ key: s.key, name: s.name, w: s.wMm, h: s.hMm, borderless: true }));
        return json({
          ok: true,
          known: true,
          match: spec ? { name: spec.name + ' (sent straight over USB)', borderless: true, isDefault: false } : null,
          def: '',
          sizes: paperList.map((s) => s.name),
          paperList
        });
      }
      // A printer used straight over IPP (Wi-Fi or IPP-over-USB) names its own papers: say which one this booth size will go on.
      const caps = await ippCaps(dtPaper.ip, dtPaper.port, dtPaper.path, 3000, dtPaper.transport);
      if (!caps) return json({ ok: true, known: false });
      const media = pickMediaName(caps, Number(search.get('w')) || 0, Number(search.get('h')) || 0);
      const paperList = caps.mediaSupported.slice(0, 80).map((s) => {
        const dims = mediaSizeMm(s);
        return dims ? { key: s, name: s, w: Math.round(dims[0] * 10) / 10, h: Math.round(dims[1] * 10) / 10, borderless: true } : null;
      }).filter(Boolean);
      return json({ ok: true, known: true, match: media ? { name: media + (dtPaper.kind === 'usb' ? ' (sent straight over USB)' : ' (sent straight to the printer)'), borderless: true, isDefault: false } : null, def: '', sizes: caps.mediaSupported.slice(0, 40), paperList });
    }
    const info = await paperSizes(name), pick = await pickPaper(name, Number(search.get('w')) || 0, Number(search.get('h')) || 0, twoUp);
    const def = info.def && info.sizes.find((x) => x.key === info.def);
    return json({ ok: true, known: info.sizes.length > 0, match: pick ? { name: pick.name, borderless: !!pick.borderless, isDefault: !!pick.keep } : null, def: def ? def.name : (info.def || ''), sizes: info.sizes.slice(0, 40).map((x) => x.name), paperList: info.sizes.slice(0, 80).map((x) => ({ key: x.key, name: x.name, w: Math.round(x.w * 10) / 10, h: Math.round(x.h * 10) / 10, borderless: !!x.borderless })) });
  }
  if (method === 'POST' && path === '/print') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const name = String(body.printer || '').trim();
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (!name) return json({ ok: false, error: 'No printer chosen' }, 400);
    if (!pages.length || pages.length > 20) return json({ ok: false, error: 'No pages' }, 400);
    let list = await printers(false);
    if (!list.includes(name)) list = await printers(true);
    if (!list.includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404);
    const buffers = [];
    for (const p of pages) {
      const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
      if (!m) return json({ ok: false, error: 'Pages must be PNG or JPEG images' }, 400);
      buffers.push({ buf: Buffer.from(m[2], 'base64'), ext: m[1] === 'jpeg' ? 'jpg' : 'png' });
    }
    const fit = body.fit === 'width' ? 'width' : '';
    const prev = getPrintQueue(name);
    const quality = ['draft', 'normal', 'best'].includes(body.quality) ? body.quality : '';
    const opts = {
      twoUp: typeof body.twoUp === 'boolean' ? body.twoUp : undefined,
      paperName: typeof body.paperName === 'string' ? body.paperName.slice(0, 120) : '',
      mediaType: typeof body.mediaType === 'string' ? body.mediaType.slice(0, 120) : ''
    };
    const dp = directTarget(name);
    const warnings = [];
    const job = dp && dp.kind === 'usb-selphy'
      ? prev.then(async () => {
        if (!buildSelphyJob) throw new Error('Could not prepare the photo for the Canon SELPHY printer.');
        const wMm = Number(body.widthMm) || 100, hMm = Number(body.heightMm) || 148;
        const built = buffers.map((it) => buildSelphyJob(it.buf, wMm, hMm, opts.paperName));
        await usbSelphyPrint(dp.entry, built.map((b) => b.data), selphyPrintOpts);
        log('Direct USB SELPHY print on ' + name + ': ' + built[0].spec.name + ' (' + built.length + ' page' + (built.length === 1 ? '' : 's') + ')');
      })
      : dp
        ? prev.then(async () => {
          // No driver: each page goes straight over IPP (Wi-Fi or IPP-over-USB) as JPEG or PWG Raster.
          for (let bi = 0; bi < buffers.length; bi++) {
            const it = buffers[bi];
            const jpeg = it.ext === 'jpg' ? it.buf : null;
            if (!jpeg && !toJpeg && !rasterize) throw new Error('Could not prepare the photo for the printer.');
            const r = await ippPrintDirect({
              ip: dp.ip, port: dp.port, path: dp.path, transport: dp.transport,
              jpeg, toJpeg, image: it.buf, widthMm: Number(body.widthMm) || 0, heightMm: Number(body.heightMm) || 0,
              rasterize, quality, mediaType: opts.mediaType, paperName: opts.paperName,
              borderless: typeof body.borderless === 'boolean' ? body.borderless : undefined,
              ...(ippWaitOpts.busyWaitMs !== undefined ? { busyWaitMs: ippWaitOpts.busyWaitMs } : {}),
              ...(ippWaitOpts.maxBusyRetries !== undefined ? { maxBusyRetries: ippWaitOpts.maxBusyRetries } : {})
            });
            log((dp.kind === 'usb' ? 'Direct USB print on ' : 'Direct print on ') + name + ': paper ' + r.media + (r.format === 'image/pwg-raster' ? ', PWG raster ' + r.dpi + ' dpi' + (r.mediaType ? ', ' + r.mediaType : '') : ', scaling ' + (r.scaling || 'printer default')));
            if (bi < buffers.length - 1 && /selphy|\bcp[\s_-]?(?:820|910|1000|1200|1300|1500)\b/i.test(name + ' ' + (r.model || ''))) {
              await waitIppIdle({ ip: dp.ip, port: dp.port, path: r.path || dp.path, jobId: r.jobId, transport: dp.transport, ...ippWaitOpts });
            }
          }
        })
        : prev.then(async () => {
          const wMm = Number(body.widthMm) || 0, hMm = Number(body.heightMm) || 0;
          // A Canon SELPHY CP1500 can stop halfway, print only yellow or freeze the Windows print service when several photos reach it
          // in one print job, so on a SELPHY each page goes as its own job, one after the other.
          if (buffers.length > 1 && /selphy|\bcp[\s_-]?(?:820|910|1000|1200|1300|1500)\b|canon.*\bCP\s?\d{3,4}\b/i.test(name)) {
            for (const it of buffers) { const res = await printPages(name, [it], fit, wMm, hMm, quality, body.custom === true, opts); if (res && res.warnings) warnings.push(...res.warnings); }
            return;
          }
          const res = await printPages(name, buffers, fit, wMm, hMm, quality, body.custom === true, opts);
          if (res && res.warnings) warnings.push(...res.warnings);
        });
    printQueues.set(name, job.catch(() => { }));
    try { await job; log('Printed ' + buffers.length + ' page(s) on ' + name); return json({ ok: true, ...(warnings.length ? { warnings: Array.from(new Set(warnings)) } : {}) }); }
    catch (e) { log('Print failed on ' + name + ': ' + (e && e.message || e)); return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  return json({ ok: false, error: 'Not found' }, 404);
}
export function stopHelper() {
  try { cam.proc && cam.proc.kill(); } catch { /* gone */ }
  gopro.reset().catch(() => { });
  if (macCamP) macCamP.then((m) => m.reset()).catch(() => { });
}
export const _helperTest = { pickPaper, sizeFromName, formatCapsLabel, pickGlossyMediaType, parsePpdChoiceLabels, parseCupsOptionsOutput, pickCupsDriverQualityOptions, MAC_EPSON_L8050_CHOICE_LABELS, isSplitPaperName, DYE_SUB, refreshUsbDirect, installedAs, usbDirect, PAPER_CACHE, CAPS_CACHE };
