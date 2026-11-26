// photobooth4u Helper (printing + camera)
// Runs on the booth laptop and lets the booth (a web page) print straight to a
// named printer with no print dialog — so each paper size can go to its own
// printer (e.g. 2x6 strips to one, 4R to another), like a native booth app.
// Windows: also controls a Nikon or Canon EOS camera over USB through Windows' own camera
// driver (live view + the real shutter), so no driver switch (Zadig) is needed.
// Mac: lets go of a USB camera that macOS grabbed (its camera service, Image Capture), so the
// booth in Chrome can open the camera itself: POST /camera/free (see camfree.mjs).
//
// - Listens on 127.0.0.1:17321 only (never reachable from other computers).
// - Only accepts requests from the photobooth4u site (ALLOWED_ORIGINS).
// - macOS / Linux: prints through CUPS (`lp`). Windows: through .NET printing
//   in PowerShell (built in). Nothing else to install.
// - Paper size: the printer's own paper size that matches the booth's paper
//   (borderless when the printer has it). Cutting comes from the printer's settings.
//
// Build (from any OS, needs Bun):
//   bun build --compile --target=bun-darwin-arm64 print-helper.js --outfile photobooth4u-print-helper-mac-apple-silicon
//   bun build --compile --target=bun-darwin-x64   print-helper.js --outfile photobooth4u-print-helper-mac-intel
//   bun build --compile --target=bun-windows-x64  print-helper.js --outfile photobooth4u-print-helper-windows.exe

import { tmpdir, platform, release as osRelease, homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { freeCamera, guardCamera } from './camfree.mjs';
import {
  startHelperBridge, stopHelperBridge, helperBridgeStatus, handleBridgeCtrl,
  getLanStationInfo, rotateLanStationPin, setStationPrinterFilter, setStationTestSizes,
  buildStationTestJob, renderStationDashboardHtml, recordStationJob
} from './bridge-ctrl.mjs';
import WORKER_PS from './camera-worker.ps1' with { type: 'text' };

const VERSION = '1.1.25';
const PORT = 17321;
const OPEN_STATION_ON_START = process.argv.includes('--station');
const ALLOWED_ORIGINS = new Set([
  'https://photobooth4u.netlify.app',
  'http://localhost:8888',            // netlify dev
  'http://127.0.0.1:' + PORT,         // local Print Station dashboard
  'http://localhost:' + PORT,
  ...(process.env.PB_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const MAX_BODY = 80 * 1024 * 1024;     // 80 MB of page images per job

function stationUrl() { return 'http://127.0.0.1:' + PORT + '/station'; }

function openStationBrowser() {
  const target = stationUrl();
  try {
    const p = IS_WIN
      ? spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true })
      : IS_MAC
      ? spawn('open', [target], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    p.on('error', () => { });
    p.unref();
    return true;
  } catch { return false; }
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ code: -1, out, err: String(e && e.message || e) }));
    p.on('close', code => resolve({ code, out, err }));
    if (input !== undefined) { p.stdin.write(input); }
    p.stdin.end();
  });
}

// ---------- Printers ----------
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

async function listPrinters() {
  if (IS_WIN) {
    const r = await run('powershell.exe', [...PS, '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | ForEach-Object { $_.Name }']);
    return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  const r = await run('lpstat', ['-e']);
  return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function openBluetoothSettings() {
  if (IS_WIN) {
    const r = await launchDetached('cmd.exe', ['/c', 'start', '', 'ms-settings:bluetooth']);
    return r.ok ? { ok: true, message: 'Bluetooth settings opened. Pair the printer, then add it in Printers & scanners so it appears in the printer list.' } : r;
  }
  if (IS_MAC) {
    const r = await launchDetached('open', ['x-apple.systempreferences:com.apple.BluetoothSettings']);
    return r.ok ? { ok: true, message: 'Bluetooth settings opened. Pair the printer, then add it in Printers & Scanners so it appears in the printer list.' } : r;
  }
  return { ok: false, error: 'Opening Bluetooth settings is supported on Windows and Mac.' };
}

// Windows: draw each PNG onto the full page of the named printer, turning it
// 90° when the printer's page is the other way round (e.g. a 6x4 driver page).
// ---------- paper sizes: tell the printer which paper to use ----------
// Without this, the printer uses its own default paper (often A4 or Letter),
// so a 4R photo came out on A4. We look up the paper sizes the printer offers
// and pick the one that matches the booth's paper size (borderless if it has it).
const PAPER_CACHE = new Map();
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
const DYE_SUB = /selphy|(?<![a-z])cp[\s_-]?d?\d{2,4}(?![0-9])|(?<![a-z])dnp(?![a-z])|(?<![a-z])ds[\s_-]?(?:rx|\d)|hiti|mitsubishi|kodak|citizen|sinfonia|shinko|dye/i;
const SPLIT_PAPER_NAME = /(?:(?:^|[^a-z0-9])(?:split|2[\s_-]?up|div2|2[\s_-]?in(?:ch)?[\s_-]?cut|2[\s_-]?strips?)(?=$|[^a-z0-9])|(?:^|[^0-9])(?:2\s*[x×]\s*6|6\s*[x×]\s*2)(?=$|[^0-9])|cut[\s_-]?2\s*[x×]\s*6)/i;
const isSplitPaper = (s) => !!(s && SPLIT_PAPER_NAME.test((s.key || '') + ' ' + (s.name || '')));
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

async function dyeSubCupsCutOptions(printer, twoUp, pick) {
  try {
    if (IS_WIN || typeof twoUp !== 'boolean' || !DYE_SUB.test(String(printer || ''))) return [];
    if (pick && isSplitPaper(pick)) return [];
    if (twoUp === true && /(?:2\s*[x×]\s*6|split|strip|cut)/i.test(String(printer || ''))) return [];
    const lo = await run('lpoptions', ['-p', printer, '-l']);
    if (lo.code !== 0) return [];
    const opts = [];
    for (const line of lo.out.split(/\r?\n/)) {
      const m = /^([^/:]+)\/([^:]*):\s*(.*)$/.exec(line);
      if (m) opts.push({ key: m[1], choices: m[3].trim().split(/\s+/).filter(Boolean).map(v => ({ value: v.replace(/^\*/, ''), selected: v.startsWith('*') })) });
    }
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

// Photo quality for AirPrint queues (Mac): a printer added as AirPrint is a driverless IPP queue and
// prints at draft/normal quality unless told otherwise. Only for those queues, ask for the best
// quality and photo paper using the options the queue lists; dye-sub (SELPHY / DNP / HiTi) and driver queues keep their own settings.
async function airPrintQualityOptions(printer, want) {
  try {
    if (DYE_SUB.test(printer)) return [];
    const v = await run('lpstat', ['-v', printer]);
    if (!/^device for [^:]+:\s*(?:ipps?|dnssd|mdns|ippusb):/im.test(v.out || '')) return [];
    const lo = await run('lpoptions', ['-p', printer, '-l']);
    const opts = [];
    for (const line of lo.out.split(/\r?\n/)) {
      const m = /^([^/:]+)\/([^:]*):\s*(.*)$/.exec(line);
      if (m) opts.push({ key: m[1], choices: m[3].trim().split(/\s+/).filter(Boolean).map(v => ({ value: v.replace(/^\*/, ''), selected: v.startsWith('*') })) });
    }
    const out = [], notes = [];
    const quality = opts.find(o => /^(?:cups)?print-?quality$/i.test(o.key));
    if (quality) {
      const rank = want === 'draft' ? [/^(?:3|draft|fast)/i, /^(?:4|normal)/i] : want === 'normal' ? [/^(?:4|normal)/i] : [/^(?:5|high|best|photo)/i, /^(?:4|normal)/i];
      let best = null; for (const re of rank) { best = quality.choices.find(c => re.test(c.value)); if (best) break; }
      if (best) { out.push('-o', quality.key + '=' + best.value); notes.push(quality.key + '=' + best.value); }
    } else { const pq = want === 'draft' ? 3 : want === 'normal' ? 4 : 5; out.push('-o', 'print-quality=' + pq); notes.push('print-quality=' + pq); }
    const type = opts.find(o => /^media-?type$/i.test(o.key));
    if (type && !type.choices.some(c => c.selected && /photo|glossy/i.test(c.value))) {
      const photo = type.choices.find(c => /photo.*gloss|glossy/i.test(c.value)) || type.choices.find(c => /photo/i.test(c.value));
      if (photo) { out.push('-o', type.key + '=' + photo.value); notes.push(type.key + '=' + photo.value); }
    }
    if (notes.length) log('AirPrint quality: ' + notes.join(', '));
    return out;
  } catch { return []; }
}

const WIN_PRINT_PS = String.raw`
param([string]$Printer, [string]$ListFile, [switch]$FitWidth, [string]$PaperName, [string]$Quality = 'best', [switch]$Borderless, [switch]$DyeSub)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# @( ) keeps a one-page list an array (otherwise $files[0] is just the first letter of the path)
$files = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
if ($files.Count -eq 0) { throw "No pages to print" }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
# Print quality: the driver's best quality, applied on top of the printer's own saved settings (its paper,
# Borderless and orientation stay as they are set). Dye-sub drivers (HiTi, DNP, Citizen, Sinfonia...)
# keep their 2-inch cut, matte/glossy finish and factory color LUT in private DEVMODE bytes, so skip
# PrintTicketConverter mutations on them.
if (-not $DyeSub) {
for ($ptTry = 0; $ptTry -lt 2; $ptTry++) {
  try {
    Add-Type -AssemblyName System.Printing
    Add-Type -AssemblyName ReachFramework
    $pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
    $tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
    $tn = New-Object Xml.XmlNamespaceManager($tx.NameTable)
    $tn.AddNamespace('psf', 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework')
    $cx = [xml]([IO.StreamReader]::new($pq.GetPrintCapabilitiesAsXml()).ReadToEnd())
    $qo = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageOutputQuality']/*[local-name()='Option']") | ForEach-Object { $_.name })
    # Best (the default), Normal or Draft, set per printer in the booth. Only an option the driver really lists is used.
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
# Borderless: when the booth's paper matched one of the printer's papers, ask the driver for its Borderless mode on
# that paper (Epson L-series keep it as a separate switch, off unless someone ticked it in the printer's preferences,
# and with it off the page is fitted inside a ~3 mm margin: white edges). Only if the driver lists a Borderless
# option and accepts it on this paper; otherwise nothing changes.
if ($Borderless -and -not $DyeSub) {
  try {
    Add-Type -AssemblyName System.Printing
    Add-Type -AssemblyName ReachFramework
    Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
    $bq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
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
$doc.DocumentName = 'photobooth4u'
# Print silently (no "Printing page 1 of 1" window popping over the booth)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.OriginAtMargins = $false
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$script:i = 0
$doc.add_PrintPage({
  param($sender, $e)
  $img = [System.Drawing.Image]::FromFile($files[$script:i])
  try {
    if ($FitWidth) {
      # Receipt roll: fill the printable width, keep the picture's shape (no stretching).
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
    $fullBleed = ($clip.Width -ge $page.Width * 0.99 -and $clip.Height -ge $page.Height * 0.99) -or ($DyeSub -and $clip.Width -ge $page.Width * 0.92 -and $clip.Height -ge $page.Height * 0.92)
    if ($fullBleed) {
      # The driver says the whole sheet is printable (Borderless is on): the picture covers it edge to edge.
      & $drawCrisp ([single](-$hx)) ([single](-$hy)) ([single]$page.Width) ([single]$page.Height)
    } else {
      # The driver keeps a margin it cannot print on. Fit the whole picture inside the part it says it can
      # print, so nothing is cut off at the edges.
      $s = [Math]::Min($clip.Width / $img.Width, $clip.Height / $img.Height)
      $w = [single]($img.Width * $s); $h = [single]($img.Height * $s)
      & $drawCrisp ([single]($clip.X + ($clip.Width - $w) / 2)) ([single]($clip.Y + ($clip.Height - $h) / 2)) $w $h
    }
    } finally { $ia.Dispose() }
  } finally { $img.Dispose() }
  $script:i++
  $e.HasMorePages = ($script:i -lt $files.Count)
})
$doc.Print()
'ok'
`;

// fit: 'width' = receipt roll (fill the width, length follows the picture).
async function printPages(printer, pageItems, fit, widthMm, heightMm, quality, opts) {
  opts = opts || {};
  const twoUp = typeof opts.twoUp === 'boolean' ? opts.twoUp : undefined;
  const reqPaperName = typeof opts.paperName === 'string' ? opts.paperName.trim() : '';
  const isDyeSub = DYE_SUB.test(String(printer || ''));
  const items = pageItems.map((p) => (Buffer.isBuffer(p) ? { buf: p, ext: 'png' } : p));
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try {
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const f = join(dir, 'page' + (i + 1) + '.' + (items[i].ext || 'png'));
      await writeFile(f, items[i].buf);
      files.push(f);
    }
    const resolvePick = async () => {
      if (fit === 'width') return null;
      if (reqPaperName) {
        const info = await paperSizes(printer);
        const found = info.sizes.find((s) => s.key === reqPaperName || s.name === reqPaperName);
        if (found) return { ...found, keep: false, explicit: true };
        return { key: reqPaperName, name: reqPaperName, borderless: isBorderlessName(reqPaperName), explicit: true };
      }
      return pickPaper(printer, widthMm, heightMm, twoUp);
    };
    const pick = await resolvePick();
    if (pick) log('Paper: ' + pick.name + (pick.explicit ? ' (selected by operator)' : pick.keep ? ' (the printer\'s default)' : ''));
    let r;
    if (IS_WIN) {
      const ps1 = join(dir, 'print.ps1'), list = join(dir, 'pages.txt');
      await writeFile(ps1, '﻿' + WIN_PRINT_PS, 'utf8');
      await writeFile(list, files.join('\r\n'), 'utf8');
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list, ...(quality ? ['-Quality', quality] : []), ...(fit === 'width' ? ['-FitWidth'] : []), ...(isDyeSub ? ['-DyeSub'] : []), ...(pick && (!pick.keep || pick.explicit) ? ['-PaperName', pick.key] : []), ...(!isDyeSub && pick ? ['-Borderless'] : [])]);
    } else {
      // Pages are already exactly paper-sized at 300 dpi; fit-to-page fills the
      // sheet. The paper size is the printer's own one that matches the booth's.
      const media = fit === 'width' && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(widthMm) + 'x' + Math.round(heightMm) + 'mm']
        : pick && (!pick.keep || pick.explicit) ? ['-o', (pick.opt === 'media' ? 'media=' : 'PageSize=') + pick.key] : [];
      const cutOpts = await dyeSubCupsCutOptions(printer, twoUp, pick);
      const qopts = await airPrintQualityOptions(printer, quality);
      r = await run('lp', ['-d', printer, ...media, ...cutOpts, ...qopts, '-o', 'fit-to-page', '-t', 'photobooth4u', ...files]);
    }
    if (r.code !== 0) throw new Error((r.err || r.out || ('exit ' + r.code)).trim().slice(0, 300));
    for (const line of String(r.out || '').split(/\r?\n/)) if (line.startsWith('info|')) log('Page: ' + line.slice(5));
  } finally {
    // Give the spooler a moment to read the files before removing them.
    setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => { }), 60000);
  }
}

// ---------- Camera (Windows) ----------
// A PowerShell child process (camera-worker.ps1, built in) talks to the camera
// through Windows' camera driver and connects back to us on a private local
// socket. One command at a time; replies are "<id> <OK|ERR|GONE> <J|B|N> <len>\n" + bytes.
// PB_CAMERA_WORKER="node mock-camera-worker.mjs" runs a stand-in worker (testing).
const CAMERA_OK = IS_WIN || !!process.env.PB_CAMERA_WORKER;
const cam = { proc: null, sock: null, server: null, starting: null, buf: Buffer.alloc(0), wait: null, seq: 0, queue: Promise.resolve(), open: null, lastErr: '' };

function camReset(why) {
  if (why) log('Camera part stopped: ' + why);
  try { cam.proc && cam.proc.kill(); } catch (e) { }
  try { cam.server && cam.server.stop(true); } catch (e) { }
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
    if (w && head[0] === w.id) { cam.wait = null; w.resolve({ status: head[1], kind: head[2], body }); }
  }
}

async function camStart() {
  if (cam.sock) return;
  if (cam.starting) return cam.starting;
  cam.starting = (async () => {
    let onConn;
    const connected = new Promise((res) => { onConn = res; });
    cam.server = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: {
        open(sock) { if (cam.sock) { sock.end(); return; } cam.sock = sock; onConn(); },
        data(sock, chunk) { if (sock !== cam.sock) return; cam.buf = Buffer.concat([cam.buf, Buffer.from(chunk)]); camParse(); },
        close(sock) { if (sock === cam.sock) camReset('connection closed'); },
        error(sock, e) { if (sock === cam.sock) camReset(String(e && e.message || e)); }
      }
    });
    const port = cam.server.port;
    let cmd, args;
    if (process.env.PB_CAMERA_WORKER) {
      const parts = process.env.PB_CAMERA_WORKER.split(' ');
      cmd = parts[0]; args = [...parts.slice(1), String(port)];
    } else {
      const dir = join(tmpdir(), 'photobooth4u-helper');
      await mkdir(dir, { recursive: true });
      const ps1 = join(dir, 'camera-worker-' + VERSION + '.ps1');
      await writeFile(ps1, '\uFEFF' + String(WORKER_PS).replace(/^\uFEFF+/, ''), 'utf8');   // exactly one BOM: two make PowerShell run the first comment line as code
      cmd = 'powershell.exe'; args = [...PS, '-File', ps1, '-Port', String(port)];
    }
    const proc = spawn(cmd, args, { windowsHide: true });
    cam.proc = proc;
    let early = '';
    const show = d => String(d).split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => { early += s + '\n'; if (/^\[camera\]/.test(s)) log(s.replace(/^\[camera\]\s*/, 'Camera: ')); });
    proc.stdout.on('data', show);
    proc.stderr.on('data', show);
    const exited = new Promise((res) => proc.on('close', code => res(code)));
    proc.on('close', () => { if (cam.proc === proc) camReset(); });
    proc.on('error', e => { early += String(e && e.message || e); });
    const timeout = new Promise((res) => setTimeout(() => res('timeout'), 60000));
    const r = await Promise.race([connected.then(() => 'ok'), exited.then(c => 'exit ' + c), timeout]);
    if (r !== 'ok') {
      camReset();
      const msg = (early.split('\n').filter(Boolean).pop() || r).replace(/^\[camera\]\s*/, '');
      throw new Error('The camera part could not start (' + msg.slice(0, 200) + ').');
    }
  })().finally(() => { cam.starting = null; });
  return cam.starting;
}

// Sends one command; resolves { status, kind, body }.
function camCall(cmd, arg, timeoutMs) {
  const job = cam.queue.then(async () => {
    await camStart();
    const id = String(++cam.seq);
    const reply = new Promise((resolve, reject) => { cam.wait = { id, resolve, reject }; });
    cam.sock.write(id + ' ' + cmd + (arg ? ' ' + arg : '') + '\n');
    let timer;
    const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs || 15000); });
    try { return await Promise.race([reply, to]); }
    catch (e) {
      // A stuck camera command: restart the camera part so the next try is clean.
      if (e && e.message === 'timeout') { camReset('no answer to ' + cmd); throw new Error('The camera didn’t answer. Check it is on and its USB cable is plugged in.'); }
      throw e;
    }
    finally { clearTimeout(timer); }
  });
  cam.queue = job.catch(() => { });
  return job;
}

// Error text from the worker starts with a code word (NOCAMERA, FOCUS, ...).
function camError(r) {
  const text = r.body.toString('utf8');
  const m = /^([A-Z]+) (.*)$/s.exec(text);
  return { code: r.status === 'GONE' ? 'GONE' : (m ? m[1] : 'ERROR'), error: m ? m[2] : text };
}

// ---------- HTTP ----------
function cors(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Expose-Headers': 'x-pb-seq',
    'Access-Control-Allow-Private-Network': 'true',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', ...cors(origin) } });
}

// Windows takes a few seconds to list printers, so the list is kept and
// refreshed in the background; /status answers straight away.
let printersCache = { at: 0, list: [], loading: null };
function refreshPrinters() {
  if (printersCache.loading) return printersCache.loading;
  printersCache.loading = listPrinters()
    .then(list => { printersCache.list = list; printersCache.at = Date.now(); return list; })
    .catch(() => printersCache.list)
    .finally(() => { printersCache.loading = null; });
  return printersCache.loading;
}
async function printers(force) {
  if (force) return refreshPrinters();
  if (!printersCache.at) return refreshPrinters();               // first time: wait for the list
  if (Date.now() - printersCache.at > 10000) refreshPrinters();  // old: refresh for next time
  return printersCache.list;
}

function launchDetached(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' }); }
    catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); return; }
    p.once('error', e => resolve({ ok: false, error: String(e && e.message || e) }));
    p.once('spawn', () => { p.unref(); resolve({ ok: true }); });
  });
}

async function openPrinterSettings(printer) {
  if (IS_WIN) {
    const r = await launchDetached('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', printer]);
    return r.ok ? { ok: true, message: 'Printer preferences opened. Set the loaded paper and print quality, then save or apply the changes.' } : r;
  }
  if (IS_MAC) {
    const modern = Number(osRelease().split('.')[0]) >= 22;
    const app = modern ? 'System Settings' : 'System Preferences';
    const pane = modern ? 'x-apple.systempreferences:com.apple.Print-Scan-Settings.extension' : '/System/Library/PreferencePanes/PrintAndFax.prefPane';
    let r = await run('open', [pane]);
    if (r.code !== 0) r = await run('open', ['-a', app]);
    return r.code === 0 ? { ok: true, message: app + ' opened. Select “Printers & Scanners”, then choose “' + printer + '” to review its available settings.' } : { ok: false, error: 'Could not open ' + app + '.' };
  }
  return { ok: false, error: 'Opening printer settings is supported on Windows and Mac.' };
}

let queue = Promise.resolve();   // one job at a time

async function lookupPaperInfo(name, w, h, twoUp) {
  if (!name || !(await printers(false)).includes(name)) return { ok: false, error: 'No printer called "' + name + '"' };
  const info = await paperSizes(name);
  const pick = await pickPaper(name, Number(w) || 0, Number(h) || 0, twoUp);
  const def = info.def && info.sizes.find((x) => x.key === info.def);
  return {
    ok: true,
    known: info.sizes.length > 0,
    match: pick ? { name: pick.name, borderless: !!pick.borderless, isDefault: !!pick.keep } : null,
    def: def ? def.name : (info.def || ''),
    sizes: info.sizes.slice(0, 40).map((x) => x.name),
    paperList: info.sizes.slice(0, 80).map((x) => ({
      key: x.key, name: x.name, w: Math.round(x.w * 10) / 10, h: Math.round(x.h * 10) / 10, borderless: !!x.borderless
    }))
  };
}

async function enqueuePrintBody(body) {
  const name = String((body && body.printer) || '').trim();
  const pages = Array.isArray(body && body.pages) ? body.pages : [];
  if (!name) return { status: 400, body: { ok: false, error: 'No printer chosen' } };
  if (!pages.length || pages.length > 20) return { status: 400, body: { ok: false, error: 'No pages' } };
  let list = await printers(false);
  if (!list.includes(name)) list = await printers(true);       // a printer added just now
  if (!list.includes(name)) return { status: 404, body: { ok: false, error: 'No printer called "' + name + '"' } };
  const buffers = [];
  for (const p of pages) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
    if (!m) return { status: 400, body: { ok: false, error: 'Pages must be PNG or JPEG images' } };
    buffers.push({ buf: Buffer.from(m[2], 'base64'), ext: m[1] === 'jpeg' ? 'jpg' : 'png' });
  }
  const fit = body.fit === 'width' ? 'width' : '';
  const quality = ['draft', 'normal', 'best'].includes(body.quality) ? body.quality : '';
  const opts = {
    twoUp: typeof body.twoUp === 'boolean' ? body.twoUp : undefined,
    paperName: typeof body.paperName === 'string' ? body.paperName.slice(0, 120) : ''
  };
  const wMm = Number(body.widthMm) || 0, hMm = Number(body.heightMm) || 0;
  const job = queue.then(async () => {
    // A Canon SELPHY (CP1500 / CP1300...) can stall, print only yellow, or freeze the print queue when several
    // photos reach it in one job, so each page goes as its own single-page job, one after the other.
    if (buffers.length > 1 && /selphy|canon.*\bCP\s?\d{3,4}\b/i.test(name)) {
      for (const it of buffers) await printPages(name, [it], fit, wMm, hMm, quality, opts);
      return;
    }
    await printPages(name, buffers, fit, wMm, hMm, quality, opts);
  });
  queue = job.catch(() => { });
  try {
    await job;
    log('Printed ' + buffers.length + ' page(s) on ' + name);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    log('Print failed on ' + name + ': ' + (e && e.message || e));
    return { status: 500, body: { ok: false, error: String(e && e.message || e) } };
  }
}

const serverCfg = {
  idleTimeout: 60,                     // a camera photo can take a while
  hostname: '127.0.0.1',
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    const origin = req.headers.get('origin') || '';
    const url = new URL(req.url);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'This site is not allowed to print here.' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    if (req.method === 'GET' && url.pathname === '/status') {
      return json({
        ok: true, app: 'photobooth4u-print-helper', version: VERSION, printers: await printers(url.searchParams.get('refresh') === '1'),
        camera: { supported: CAMERA_OK, open: !!cam.open, name: cam.open ? cam.open.name : '', free: IS_MAC },
        bridge: helperBridgeStatus()
      }, 200, origin);
    }

    if (url.pathname.startsWith('/bridge-ctrl/')) {
      if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      return await handleBridgeCtrl(req, url, cors(origin));
    }

    if (url.pathname.startsWith('/camera')) {
      if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      // Mac: stop macOS' camera service so the browser can open the camera over USB (it keeps stopping it for ~15 s).
      if (req.method === 'POST' && url.pathname === '/camera/free') {
        const r = await freeCamera();
        guardCamera(15000);
        return json({ ...r }, 200, origin);
      }
      if (!CAMERA_OK) return json({ ok: false, code: 'UNSUPPORTED', error: 'Camera control through the helper is for Windows. On a Mac, the booth connects to the camera by itself.' }, 501, origin);
      const send = (r, okFn) => {
        if (r.status === 'OK') return okFn();
        const e = camError(r);
        if (e.code === 'GONE' || e.code === 'NOCAMERA') cam.open = null;
        return json({ ok: false, code: e.code, error: e.error }, e.code === 'GONE' ? 410 : e.code === 'NOCAMERA' ? 404 : 409, origin);
      };
      const jpeg = (body, extra) => new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store', ...cors(origin), ...(extra || {}) } });
      const classic = url.searchParams.get('classic') === '1' ? 'classic' : '';
      try {
        if (req.method === 'GET' && url.pathname === '/camera') {
          const r = await camCall('list', '', 20000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if (req.method === 'GET' && url.pathname === '/camera/info') {
          const r = await camCall('info', '', 8000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if (req.method === 'POST' && url.pathname === '/camera/open') {
          const saveCard = url.searchParams.get('saveToCard') === '1' ? 'saveToCard' : '';
          const openArg = [url.searchParams.get('fresh') === '1' ? 'recover' : '', classic, saveCard].filter(Boolean).join(' ');
          const r = await camCall('open', openArg, 60000);
          return send(r, () => { cam.open = JSON.parse(r.body.toString('utf8')); log('Camera connected: ' + cam.open.name); return json({ ok: true, ...cam.open }, 200, origin); });
        }
        if (req.method === 'POST' && url.pathname === '/camera/af') {
          const afArg = [classic, url.searchParams.get('pre') === '1' ? 'pre' : ''].filter(Boolean).join(' ');
          const r = await camCall('af', afArg, 15000);
          return send(r, () => json({ ok: true }, 200, origin));
        }
        if (req.method === 'POST' && url.pathname === '/camera/live') {
          const on = url.searchParams.get('on') !== '0';
          const r = await camCall('live', on ? 'on' : 'off', 20000);
          return send(r, () => json({ ok: true }, 200, origin));
        }
        if (req.method === 'GET' && url.pathname === '/camera/frame') {
          const r = await camCall('frame', '', 10000);
          return send(r, () => r.kind === 'B' ? jpeg(r.body) : new Response(null, { status: 204, headers: cors(origin) }));
        }
        if (req.method === 'POST' && url.pathname === '/camera/capture') {
          const t0 = Date.now();
          const r = await camCall('capture', classic, 45000);
          return send(r, () => { log('Photo taken (' + Math.round(r.body.length / 1024) + ' KB, ' + (Date.now() - t0) + ' ms)'); return jpeg(r.body); });
        }
        if (req.method === 'GET' && url.pathname === '/camera/battery') {
          const r = await camCall('battery', '', 10000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        // The booth's Camera check: read the camera's shutter / aperture / ISO, and set them (Nikon; any other camera answers
        // supported:false). Only numbers ever reach the camera program: each value goes through Number().
        if (req.method === 'GET' && url.pathname === '/camera/props') {
          const r = await camCall('props', '', 10000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if (req.method === 'POST' && url.pathname === '/camera/setprops') {
          const q = ['shutter', 'f', 'iso', 'wb'].map((k) => {
            const raw = url.searchParams.get(k);
            if (raw === null || raw === '') return '';
            const v = Number(raw);
            return Number.isFinite(v) && (k === 'wb' ? (v >= 0 && v < 100000) : (v > 0 && v < 100000)) ? k + '=' + v : '';
          }).filter(Boolean).join('&');
          const r = await camCall('setprops', q, 20000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if (req.method === 'POST' && url.pathname === '/camera/close') {
          const r = await camCall('close', '', 10000);
          cam.open = null;
          return send(r, () => json({ ok: true }, 200, origin));
        }
      } catch (e) {
        cam.open = null;
        return json({ ok: false, code: 'HELPER', error: String(e && e.message || e) }, 503, origin);
      }
      return json({ ok: false, error: 'Not found' }, 404, origin);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/station')) {
      return new Response(renderStationDashboardHtml(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (req.method === 'GET' && url.pathname === '/station/info') {
      const pr = await printers(url.searchParams.get('refresh') === '1');
      return json({ ...getLanStationInfo(), printers: pr }, 200, origin);
    }
    if (req.method === 'POST' && url.pathname === '/station/new-pin') {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Not allowed' }, 403);
      return json({ ok: true, pin: rotateLanStationPin() }, 200, origin);
    }
    if (req.method === 'POST' && url.pathname === '/station/printers') {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Not allowed' }, 403);
      let body = {};
      try { body = await req.json(); } catch (e) { }
      const info = setStationPrinterFilter(body && typeof body === 'object' ? body : {});
      return json({ ok: true, ...info }, 200, origin);
    }
    if (req.method === 'POST' && url.pathname === '/station/test-sizes') {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Not allowed' }, 403);
      let body = {};
      try { body = await req.json(); } catch (e) { }
      const info = setStationTestSizes(body && body.testSizes !== undefined ? body.testSizes : null);
      return json({ ok: true, ...info }, 200, origin);
    }
    if (req.method === 'POST' && url.pathname === '/station/test-print') {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'Not allowed' }, 403);
      let body = {};
      try { body = await req.json(); } catch (e) { }
      const specOrTwoUp = (body && (body.widthMm || body.heightMm || body.label || body.paperName)) ? body : !!(body && body.twoUp);
      const built = buildStationTestJob(body && body.printer, specOrTwoUp);
      if (!built.ok) return json({ ok: false, error: built.error }, 400, origin);
      const out = await enqueuePrintBody(built.printBody);
      recordStationJob({
        printer: built.printer,
        pages: 1,
        paper: built.jobLabel,
        from: 'Laptop Test',
        ok: !!(out && out.status === 200 && out.body && out.body.ok),
        error: out && out.body && out.body.error ? out.body.error : ''
      });
      return json(out.body, out.status, origin);
    }

    if (req.method === 'GET' && url.pathname === '/paper') {
      const name = String(url.searchParams.get('printer') || '').trim();
      const twoUpQ = url.searchParams.get('twoUp');
      const twoUp = twoUpQ === '1' ? true : twoUpQ === '0' ? false : undefined;
      const out = await lookupPaperInfo(name, url.searchParams.get('w'), url.searchParams.get('h'), twoUp);
      return json(out, out.ok ? 200 : 404, origin);
    }
    if (req.method === 'POST' && url.pathname === '/printer/configure') {
      if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request' }, 400, origin); }
      const name = String(body.printer || '').trim();
      if (!name) return json({ ok: false, error: 'Choose a printer first.' }, 400, origin);
      let list = await printers(false);
      if (!list.includes(name)) list = await printers(true);
      if (!list.includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404, origin);
      const result = await openPrinterSettings(name);
      return json(result, result.ok ? 200 : 500, origin);
    }
    if (req.method === 'POST' && url.pathname === '/printer/bluetooth') {
      if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      const result = await openBluetoothSettings();
      return json(result, result.ok ? 200 : 500, origin);
    }
    if (req.method === 'POST' && url.pathname === '/print') {
      if (!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      let body;
      try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'Bad request' }, 400, origin); }
      const out = await enqueuePrintBody(body);
      return json(out.body, out.status, origin);
    }
    return json({ ok: false, error: 'Not found' }, 404, origin);
  },
  error(e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
};

let server;
try {
  server = Bun.serve(serverCfg);
} catch (bindErr) {
  let alreadyUp = false;
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/station/info', { signal: AbortSignal.timeout(1500) });
    alreadyUp = r.ok;
  } catch { }
  if (alreadyUp) {
    console.log('');
    console.log('  photobooth4u Print Helper is already running on 127.0.0.1:' + PORT + '.');
    console.log('  Opening Laptop Print Station dashboard (' + stationUrl() + ')...');
    openStationBrowser();
    await new Promise(r => setTimeout(r, 400));
    process.exit(0);
  }
  throw bindErr;
}

function log(msg) { console.log('[' + new Date().toLocaleTimeString() + '] ' + msg); }

function printStationBanner(bp) {
  const ls = getLanStationInfo();
  const ips = (ls.addresses || []).map(a => a.ip + (bp !== 47777 ? ':' + bp : '') + ' (' + a.kind + ')');
  console.log('  ------------------------------------------------------------------');
  console.log('  OFFLINE IPAD PRINT STATION (Wi-Fi / No Internet Needed)');
  console.log('    Laptop IP  : ' + (ips.length ? ips.join('  |  ') : ('Connect Wi-Fi or Hotspot (port ' + bp + ')')));
  console.log('    6-Digit PIN: ' + ls.pin);
  console.log('    Dashboard  : ' + stationUrl());
  console.log('  ------------------------------------------------------------------');
  console.log('    Press [O] + Enter -> Open Print Station Dashboard in Browser');
  console.log('    Press [N] + Enter -> New 6-Digit PIN');
  console.log('    Press [R] + Enter -> Refresh Printers & Wi-Fi IP');
  console.log('  ------------------------------------------------------------------\n');
}

console.log('');
console.log('  photobooth4u Helper ' + VERSION + ' (printing' + (CAMERA_OK ? ' + Nikon / Canon / Sony camera over USB' : '') + (IS_MAC ? ' + frees USB cameras for the browser' : '') + ')');
console.log('  Running. Keep this window open while the booth is in use.');
console.log('  (Close it to stop. Listening on 127.0.0.1:' + server.port + ' for ' + [...ALLOWED_ORIGINS][0] + ')');
console.log('');
printers(true).then(list => {
  console.log('  Printers on this computer:');
  (list.length ? list : ['(none found)']).forEach(n => console.log('   - ' + n));
  console.log('');
  if (CAMERA_OK) console.log('  Camera: plug in a Nikon or Canon EOS camera, switch it on, and pick it in the booth.\n');
}).catch(() => { });
process.on('exit', () => { try { cam.proc && cam.proc.kill(); } catch (e) { } try { stopHelperBridge(); } catch (e) { } });
// Start LAN server (ports 47777-47797) for Offline iPad Print Station & Tablet Bridge.
startHelperBridge({
  logger: log,
  lanStation: {
    appKind: 'print-helper',
    version: VERSION,
    pinFile: join(homedir(), '.photobooth4u-lan-station.json'),
    getPrinters: printers,
    getPaper: ({ printer, widthMm, heightMm, twoUp }) => lookupPaperInfo(printer, widthMm, heightMm, twoUp),
    printJob: async (body) => (await enqueuePrintBody(body)).body
  }
}).then((bp) => {
  if (bp) {
    const st = helperBridgeStatus();
    log('Tablet Bridge ready on port ' + bp + (st.primaryUrl ? ' (' + st.primaryUrl + ')' : '') + ' — allow Windows Firewall (Private & Public) if asked.');
    printStationBanner(bp);
    if (OPEN_STATION_ON_START) {
      log('Opening Laptop Print Station in your browser (' + stationUrl() + ')...');
      openStationBrowser();
    }
  }
}).catch(() => { });
if (process.stdin && typeof process.stdin.on === 'function' && process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    const cmd = String(chunk || '').trim().toLowerCase();
    if (!cmd) return;
    if (cmd === 'o' || cmd === 'open' || cmd === 's' || cmd === 'station') {
      log('Opening ' + stationUrl() + ' in your browser...');
      openStationBrowser();
    } else if (cmd === 'n' || cmd === 'pin' || cmd === 'new') {
      const next = rotateLanStationPin();
      console.log('  New 6-Digit PIN: ' + next + '\n');
    } else if (cmd === 'r' || cmd === 'refresh') {
      const list = await printers(true).catch(() => []);
      console.log('  Printers on this computer:');
      (list.length ? list : ['(none found)']).forEach(n => console.log('   - ' + n));
      const bp = helperBridgeStatus().port || 47777;
      printStationBanner(bp);
    }
  });
}
// Windows: get the camera part ready now, so the booth finds the camera quickly.
if (IS_WIN) camStart().catch(e => log(String(e && e.message || e)));
