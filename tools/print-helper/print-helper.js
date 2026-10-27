// photobooth4u Helper (printing + camera)
// Runs on the booth laptop and lets the booth (a web page) print straight to a
// named printer with no print dialog — so each paper size can go to its own
// printer (e.g. 2x6 strips to one, 4R to another), like a native booth app.
// Windows: also controls a Nikon or Canon EOS camera over USB through Windows' own camera
// driver (live view + the real shutter), so no driver switch (Zadig) is needed.
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

import { tmpdir, platform, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import WORKER_PS from './camera-worker.ps1' with { type: 'text' };

const VERSION = '1.1.8';
const PORT = 17321;
const ALLOWED_ORIGINS = new Set([
  'https://photobooth4u.netlify.app',
  'http://localhost:8888',            // netlify dev
  ...(process.env.PB_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const MAX_BODY = 80 * 1024 * 1024;     // 80 MB of page images per job

function run(cmd, args, input){
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try{ p = spawn(cmd, args, { windowsHide: true }); }
    catch(e){ resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ code: -1, out, err: String(e && e.message || e) }));
    p.on('close', code => resolve({ code, out, err }));
    if(input !== undefined){ p.stdin.write(input); }
    p.stdin.end();
  });
}

// ---------- Printers ----------
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

async function listPrinters(){
  if(IS_WIN){
    const r = await run('powershell.exe', [...PS, '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | ForEach-Object { $_.Name }']);
    return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  const r = await run('lpstat', ['-e']);
  return r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function openBluetoothSettings(){
  if(IS_WIN){
    const r = await launchDetached('cmd.exe', ['/c', 'start', '', 'ms-settings:bluetooth']);
    return r.ok ? { ok: true, message: 'Bluetooth settings opened. Pair the printer, then add it in Printers & scanners so it appears in the printer list.' } : r;
  }
  if(IS_MAC){
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
const PAPER_NAMES = { a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], letter: [215.9, 279.4], legal: [215.9, 355.6],
  postcard: [100, 148], hagaki: [100, 148], l: [89, 127], '2l': [127, 178], kg: [102, 152], '4r': [102, 152], '5r': [127, 178], '6r': [152, 203], '8r': [203, 254], '3r': [89, 127],
  '80mm': [80, 297], '58mm': [58, 210], roll80: [80, 297], roll58: [58, 210], receipt80: [80, 297], receipt58: [58, 210] };
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
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
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
const near = (s, a, b) => { const sa = Math.min(s.w, s.h), sb = Math.max(s.w, s.h); return Math.abs(sa - a) <= 3 && Math.abs(sb - b) <= 3; };
async function pickPaper(printer, widthMm, heightMm) {
  if (!(widthMm > 0 && heightMm > 0)) return null;
  const a = Math.min(widthMm, heightMm), b = Math.max(widthMm, heightMm);
  const { sizes, def } = await paperSizes(printer);
  const d = def && sizes.find((s) => s.key === def);
  if (d && (near(d, a, b) || (a / b < 0.45 && near(d, a * 2, b)))) return { ...d, keep: true };
  let best = null;
  for (const s of sizes) {
    const sa = Math.min(s.w, s.h), sb = Math.max(s.w, s.h);
    if (Math.abs(sa - a) > 3 || Math.abs(sb - b) > 3) continue;
    const score = Math.abs(sa - a) + Math.abs(sb - b) - (s.borderless ? 2.5 : 0);
    if (!best || score < best.score) best = { ...s, score };
  }
  return best;
}

const WIN_PRINT_PS = String.raw`
param([string]$Printer, [string]$ListFile, [switch]$FitWidth, [string]$PaperName)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# @( ) keeps a one-page list an array (otherwise $files[0] is just the first letter of the path)
$files = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
if ($files.Count -eq 0) { throw "No pages to print" }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
if ($PaperName) {
  $p = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $PaperName } | Select-Object -First 1
  if ($p) { $doc.DefaultPageSettings.PaperSize = $p }
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
      $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $e.Graphics.DrawImage($img, [single](($pa.Width - $w) / 2), [single]0, $w, $h)
      $script:i++
      $e.HasMorePages = ($script:i -lt $files.Count)
      return
    }
    $page = $e.PageBounds
    $pageLandscape = $page.Width -gt $page.Height
    $imgLandscape = $img.Width -gt $img.Height
    if ($pageLandscape -ne $imgLandscape) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    # Undo the printer's hard margin so the image covers the whole sheet.
    $hx = $e.PageSettings.HardMarginX; $hy = $e.PageSettings.HardMarginY
    $e.Graphics.DrawImage($img, [single](-$hx), [single](-$hy), [single]$page.Width, [single]$page.Height)
  } finally { $img.Dispose() }
  $script:i++
  $e.HasMorePages = ($script:i -lt $files.Count)
})
$doc.Print()
'ok'
`;

// fit: 'width' = receipt roll (fill the width, length follows the picture).
async function printPages(printer, pngBuffers, fit, widthMm, heightMm){
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try{
    const files = [];
    for(let i = 0; i < pngBuffers.length; i++){
      const f = join(dir, 'page' + (i + 1) + '.png');
      await writeFile(f, pngBuffers[i]);
      files.push(f);
    }
    let r;
    if(IS_WIN){
      const ps1 = join(dir, 'print.ps1'), list = join(dir, 'pages.txt');
      await writeFile(ps1, '﻿' + WIN_PRINT_PS, 'utf8');
      await writeFile(list, files.join('\r\n'), 'utf8');
      const pick = fit === 'width' ? null : await pickPaper(printer, widthMm, heightMm);
      if(pick) log('Paper: ' + pick.name + (pick.keep ? ' (the printer\'s default)' : ''));
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list, ...(fit === 'width' ? ['-FitWidth'] : []), ...(pick && !pick.keep ? ['-PaperName', pick.key] : [])]);
    } else {
      // Pages are already exactly paper-sized at 300 dpi; fit-to-page fills the
      // sheet. The paper size is the printer's own one that matches the booth's.
      const pick = fit === 'width' ? null : await pickPaper(printer, widthMm, heightMm);
      if(pick) log('Paper: ' + pick.name + (pick.keep ? ' (the printer\'s default)' : ''));
      const media = fit === 'width' && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(widthMm) + 'x' + Math.round(heightMm) + 'mm']
        : pick && !pick.keep ? ['-o', (pick.opt === 'media' ? 'media=' : 'PageSize=') + pick.key] : [];
      r = await run('lp', ['-d', printer, ...media, '-o', 'fit-to-page', '-t', 'photobooth4u', ...files]);
    }
    if(r.code !== 0) throw new Error((r.err || r.out || ('exit ' + r.code)).trim().slice(0, 300));
  } finally {
    // Give the spooler a moment to read the files before removing them.
    setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 60000);
  }
}

// ---------- Camera (Windows) ----------
// A PowerShell child process (camera-worker.ps1, built in) talks to the camera
// through Windows' camera driver and connects back to us on a private local
// socket. One command at a time; replies are "<id> <OK|ERR|GONE> <J|B|N> <len>\n" + bytes.
// PB_CAMERA_WORKER="node mock-camera-worker.mjs" runs a stand-in worker (testing).
const CAMERA_OK = IS_WIN || !!process.env.PB_CAMERA_WORKER;
const cam = { proc: null, sock: null, server: null, starting: null, buf: Buffer.alloc(0), wait: null, seq: 0, queue: Promise.resolve(), open: null, lastErr: '' };

function camReset(why){
  if(why) log('Camera part stopped: ' + why);
  try{ cam.proc && cam.proc.kill(); }catch(e){}
  try{ cam.server && cam.server.stop(true); }catch(e){}
  if(cam.wait){ const w = cam.wait; cam.wait = null; w.reject(new Error('The camera part stopped. Try again.')); }
  cam.proc = null; cam.sock = null; cam.server = null; cam.buf = Buffer.alloc(0); cam.open = null;
}

function camParse(){
  for(;;){
    const nl = cam.buf.indexOf(10);
    if(nl < 0) return;
    const head = cam.buf.subarray(0, nl).toString('utf8').trim().split(' ');
    const len = Number(head[3]) || 0;
    if(cam.buf.length < nl + 1 + len) return;
    const body = Buffer.from(cam.buf.subarray(nl + 1, nl + 1 + len));
    cam.buf = cam.buf.subarray(nl + 1 + len);
    const w = cam.wait;
    if(w && head[0] === w.id){ cam.wait = null; w.resolve({ status: head[1], kind: head[2], body }); }
  }
}

async function camStart(){
  if(cam.sock) return;
  if(cam.starting) return cam.starting;
  cam.starting = (async () => {
    let onConn;
    const connected = new Promise((res) => { onConn = res; });
    cam.server = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: {
        open(sock){ if(cam.sock){ sock.end(); return; } cam.sock = sock; onConn(); },
        data(sock, chunk){ if(sock !== cam.sock) return; cam.buf = Buffer.concat([cam.buf, Buffer.from(chunk)]); camParse(); },
        close(sock){ if(sock === cam.sock) camReset('connection closed'); },
        error(sock, e){ if(sock === cam.sock) camReset(String(e && e.message || e)); }
      }
    });
    const port = cam.server.port;
    let cmd, args;
    if(process.env.PB_CAMERA_WORKER){
      const parts = process.env.PB_CAMERA_WORKER.split(' ');
      cmd = parts[0]; args = [...parts.slice(1), String(port)];
    } else {
      const dir = join(tmpdir(), 'photobooth4u-helper');
      await mkdir(dir, { recursive: true });
      const ps1 = join(dir, 'camera-worker-' + VERSION + '.ps1');
      await writeFile(ps1, '﻿' + WORKER_PS, 'utf8');
      cmd = 'powershell.exe'; args = [...PS, '-File', ps1, '-Port', String(port)];
    }
    const proc = spawn(cmd, args, { windowsHide: true });
    cam.proc = proc;
    let early = '';
    const show = d => String(d).split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => { early += s + '\n'; if(/^\[camera\]/.test(s)) log(s.replace(/^\[camera\]\s*/, 'Camera: ')); });
    proc.stdout.on('data', show);
    proc.stderr.on('data', show);
    const exited = new Promise((res) => proc.on('close', code => res(code)));
    proc.on('close', () => { if(cam.proc === proc) camReset(); });
    proc.on('error', e => { early += String(e && e.message || e); });
    const timeout = new Promise((res) => setTimeout(() => res('timeout'), 60000));
    const r = await Promise.race([connected.then(() => 'ok'), exited.then(c => 'exit ' + c), timeout]);
    if(r !== 'ok'){
      camReset();
      const msg = (early.split('\n').filter(Boolean).pop() || r).replace(/^\[camera\]\s*/, '');
      throw new Error('The camera part could not start (' + msg.slice(0, 200) + ').');
    }
  })().finally(() => { cam.starting = null; });
  return cam.starting;
}

// Sends one command; resolves { status, kind, body }.
function camCall(cmd, arg, timeoutMs){
  const job = cam.queue.then(async () => {
    await camStart();
    const id = String(++cam.seq);
    const reply = new Promise((resolve, reject) => { cam.wait = { id, resolve, reject }; });
    cam.sock.write(id + ' ' + cmd + (arg ? ' ' + arg : '') + '\n');
    let timer;
    const to = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs || 15000); });
    try{ return await Promise.race([reply, to]); }
    catch(e){
      // A stuck camera command: restart the camera part so the next try is clean.
      if(e && e.message === 'timeout'){ camReset('no answer to ' + cmd); throw new Error('The camera didn’t answer. Check it is on and its USB cable is plugged in.'); }
      throw e;
    }
    finally{ clearTimeout(timer); }
  });
  cam.queue = job.catch(() => {});
  return job;
}

// Error text from the worker starts with a code word (NOCAMERA, FOCUS, ...).
function camError(r){
  const text = r.body.toString('utf8');
  const m = /^([A-Z]+) (.*)$/s.exec(text);
  return { code: r.status === 'GONE' ? 'GONE' : (m ? m[1] : 'ERROR'), error: m ? m[2] : text };
}

// ---------- HTTP ----------
function cors(origin){
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if(origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, status, origin){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', ...cors(origin) } });
}

// Windows takes a few seconds to list printers, so the list is kept and
// refreshed in the background; /status answers straight away.
let printersCache = { at: 0, list: [], loading: null };
function refreshPrinters(){
  if(printersCache.loading) return printersCache.loading;
  printersCache.loading = listPrinters()
    .then(list => { printersCache.list = list; printersCache.at = Date.now(); return list; })
    .catch(() => printersCache.list)
    .finally(() => { printersCache.loading = null; });
  return printersCache.loading;
}
async function printers(force){
  if(force) return refreshPrinters();
  if(!printersCache.at) return refreshPrinters();               // first time: wait for the list
  if(Date.now() - printersCache.at > 10000) refreshPrinters();  // old: refresh for next time
  return printersCache.list;
}

function launchDetached(cmd, args){
  return new Promise((resolve) => {
    let p;
    try{ p = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' }); }
    catch(e){ resolve({ ok: false, error: String(e && e.message || e) }); return; }
    p.once('error', e => resolve({ ok: false, error: String(e && e.message || e) }));
    p.once('spawn', () => { p.unref(); resolve({ ok: true }); });
  });
}

async function openPrinterSettings(printer){
  if(IS_WIN){
    const r = await launchDetached('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', printer]);
    return r.ok ? { ok: true, message: 'Printer preferences opened. Set the loaded paper and print quality, then save or apply the changes.' } : r;
  }
  if(IS_MAC){
    const modern = Number(osRelease().split('.')[0]) >= 22;
    const app = modern ? 'System Settings' : 'System Preferences';
    const pane = modern ? 'x-apple.systempreferences:com.apple.Print-Scan-Settings.extension' : '/System/Library/PreferencePanes/PrintAndFax.prefPane';
    let r = await run('open', [pane]);
    if(r.code !== 0) r = await run('open', ['-a', app]);
    return r.code === 0 ? { ok: true, message: app + ' opened. Select “Printers & Scanners”, then choose “' + printer + '” to review its available settings.' } : { ok: false, error: 'Could not open ' + app + '.' };
  }
  return { ok: false, error: 'Opening printer settings is supported on Windows and Mac.' };
}

let queue = Promise.resolve();   // one job at a time

const server = Bun.serve({
  idleTimeout: 60,                     // a camera photo can take a while
  hostname: '127.0.0.1',
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  async fetch(req){
    const origin = req.headers.get('origin') || '';
    const url = new URL(req.url);
    if(origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'This site is not allowed to print here.' }, 403);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    if(req.method === 'GET' && url.pathname === '/status'){
      return json({ ok: true, app: 'photobooth4u-print-helper', version: VERSION, printers: await printers(url.searchParams.get('refresh') === '1'),
        camera: { supported: CAMERA_OK, open: !!cam.open, name: cam.open ? cam.open.name : '' } }, 200, origin);
    }

    if(url.pathname.startsWith('/camera')){
      if(!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      if(!CAMERA_OK) return json({ ok: false, code: 'UNSUPPORTED', error: 'Camera control through the helper is for Windows. On a Mac, the booth connects to the camera by itself.' }, 501, origin);
      const send = (r, okFn) => {
        if(r.status === 'OK') return okFn();
        const e = camError(r);
        if(e.code === 'GONE' || e.code === 'NOCAMERA') cam.open = null;
        return json({ ok: false, code: e.code, error: e.error }, e.code === 'GONE' ? 410 : e.code === 'NOCAMERA' ? 404 : 409, origin);
      };
      const jpeg = (body, extra) => new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store', ...cors(origin), ...(extra || {}) } });
      try{
        if(req.method === 'GET' && url.pathname === '/camera'){
          const r = await camCall('list', '', 20000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if(req.method === 'POST' && url.pathname === '/camera/open'){
          const r = await camCall('open', '', 60000);
          return send(r, () => { cam.open = JSON.parse(r.body.toString('utf8')); log('Camera connected: ' + cam.open.name); return json({ ok: true, ...cam.open }, 200, origin); });
        }
        if(req.method === 'POST' && url.pathname === '/camera/live'){
          const on = url.searchParams.get('on') !== '0';
          const r = await camCall('live', on ? 'on' : 'off', 20000);
          return send(r, () => json({ ok: true }, 200, origin));
        }
        if(req.method === 'GET' && url.pathname === '/camera/frame'){
          const r = await camCall('frame', '', 10000);
          return send(r, () => r.kind === 'B' ? jpeg(r.body) : new Response(null, { status: 204, headers: cors(origin) }));
        }
        if(req.method === 'POST' && url.pathname === '/camera/capture'){
          const t0 = Date.now();
          const r = await camCall('capture', '', 45000);
          return send(r, () => { log('Photo taken (' + Math.round(r.body.length / 1024) + ' KB, ' + (Date.now() - t0) + ' ms)'); return jpeg(r.body); });
        }
        if(req.method === 'GET' && url.pathname === '/camera/battery'){
          const r = await camCall('battery', '', 10000);
          return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) }, 200, origin));
        }
        if(req.method === 'POST' && url.pathname === '/camera/close'){
          const r = await camCall('close', '', 10000);
          cam.open = null;
          return send(r, () => json({ ok: true }, 200, origin));
        }
      }catch(e){
        cam.open = null;
        return json({ ok: false, code: 'HELPER', error: String(e && e.message || e) }, 503, origin);
      }
      return json({ ok: false, error: 'Not found' }, 404, origin);
    }

    if(req.method === 'GET' && url.pathname === '/paper'){
      const name = String(url.searchParams.get('printer') || '').trim();
      if(!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404, origin);
      const info = await paperSizes(name), pick = await pickPaper(name, Number(url.searchParams.get('w')) || 0, Number(url.searchParams.get('h')) || 0);
      const def = info.def && info.sizes.find((x) => x.key === info.def);
      return json({ ok: true, known: info.sizes.length > 0, match: pick ? { name: pick.name, borderless: !!pick.borderless, isDefault: !!pick.keep } : null, def: def ? def.name : (info.def || ''), sizes: info.sizes.slice(0, 40).map((x) => x.name) }, 200, origin);
    }
    if(req.method === 'POST' && url.pathname === '/printer/configure'){
      if(!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      let body;
      try{ body = await req.json(); }catch(e){ return json({ ok: false, error: 'Bad request' }, 400, origin); }
      const name = String(body.printer || '').trim();
      if(!name) return json({ ok: false, error: 'Choose a printer first.' }, 400, origin);
      let list = await printers(false);
      if(!list.includes(name)) list = await printers(true);
      if(!list.includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404, origin);
      const result = await openPrinterSettings(name);
      return json(result, result.ok ? 200 : 500, origin);
    }
    if(req.method === 'POST' && url.pathname === '/printer/bluetooth'){
      if(!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      const result = await openBluetoothSettings();
      return json(result, result.ok ? 200 : 500, origin);
    }
    if(req.method === 'POST' && url.pathname === '/print'){
      if(!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      let body;
      try{ body = await req.json(); }catch(e){ return json({ ok: false, error: 'Bad request' }, 400, origin); }
      const name = String(body.printer || '').trim();
      const pages = Array.isArray(body.pages) ? body.pages : [];
      if(!name) return json({ ok: false, error: 'No printer chosen' }, 400, origin);
      if(!pages.length || pages.length > 20) return json({ ok: false, error: 'No pages' }, 400, origin);
      let list = await printers(false);
      if(!list.includes(name)) list = await printers(true);       // a printer added just now
      if(!list.includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404, origin);
      const buffers = [];
      for(const p of pages){
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
        if(!m) return json({ ok: false, error: 'Pages must be PNG images' }, 400, origin);
        buffers.push(Buffer.from(m[1], 'base64'));
      }
      const fit = body.fit === 'width' ? 'width' : '';
      const job = queue.then(() => printPages(name, buffers, fit, Number(body.widthMm) || 0, Number(body.heightMm) || 0));
      queue = job.catch(() => {});
      try{
        await job;
        log('Printed ' + buffers.length + ' page(s) on ' + name);
        return json({ ok: true }, 200, origin);
      }catch(e){
        log('Print failed on ' + name + ': ' + (e && e.message || e));
        return json({ ok: false, error: String(e && e.message || e) }, 500, origin);
      }
    }
    return json({ ok: false, error: 'Not found' }, 404, origin);
  },
  error(e){ return json({ ok: false, error: String(e && e.message || e) }, 500); }
});

function log(msg){ console.log('[' + new Date().toLocaleTimeString() + '] ' + msg); }

console.log('');
console.log('  photobooth4u Helper ' + VERSION + ' (printing' + (CAMERA_OK ? ' + Nikon / Canon camera over USB' : '') + ')');
console.log('  Running. Keep this window open while the booth is in use.');
console.log('  (Close it to stop. Listening on 127.0.0.1:' + server.port + ' for ' + [...ALLOWED_ORIGINS][0] + ')');
console.log('');
printers(true).then(list => {
  console.log('  Printers on this computer:');
  (list.length ? list : ['(none found)']).forEach(n => console.log('   - ' + n));
  console.log('');
  if(CAMERA_OK) console.log('  Camera: plug in a Nikon or Canon EOS camera, switch it on, and pick it in the booth.\n');
}).catch(() => {});
process.on('exit', () => { try{ cam.proc && cam.proc.kill(); }catch(e){} });
// Windows: get the camera part ready now, so the booth finds the camera quickly.
if(IS_WIN) camStart().catch(e => log(String(e && e.message || e)));
