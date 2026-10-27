// The Print Helper, built into the app: silent printing to a named printer
// (Windows: .NET printing in PowerShell; Mac: CUPS `lp`) and, on Windows, the
// Nikon / Canon EOS camera over USB through Windows' own camera driver (camera-worker.ps1).
// Same endpoints as tools/print-helper/print-helper.js, served to the booth at
// app://booth/helper/... (same origin, so no CORS or permission prompts).
import { tmpdir, platform, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

export const HELPER_VERSION = '1.1.7-app';
const IS_WIN = platform() === 'win32';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
let WORKER_PS = '';
let log = (m) => console.log('[helper] ' + m);

export function initHelper({ workerPath, logger }) {
  if (logger) log = logger;
  try { WORKER_PS = readFileSync(workerPath, 'utf8'); } catch { WORKER_PS = ''; }
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
  printersCache.loading = listPrinters().then((list) => { printersCache.list = list; printersCache.at = Date.now(); return list; })
    .catch(() => printersCache.list).finally(() => { printersCache.loading = null; });
  return printersCache.loading;
}
async function printers(force) {
  if (force) return refreshPrinters();
  if (!printersCache.at) { await Promise.race([refreshPrinters(), new Promise((r) => setTimeout(r, 1000))]); return printersCache.list; }
  if (Date.now() - printersCache.at > 10000) refreshPrinters();
  return printersCache.list;
}

async function cupsPrinterOptions(printer) {
  const r = await run('lpoptions', ['-p', printer, '-l']);
  if (r.code !== 0) throw new Error((r.err || r.out || 'Could not read printer options').trim());
  return r.out.split(/\r?\n/).flatMap((line) => {
    const m = /^([^/:]+)\/([^:]*):\s*(.*)$/.exec(line);
    if (!m) return [];
    const choices = m[3].trim().split(/\s+/).filter(Boolean).map((v) => ({ value: v.replace(/^\*/, ''), selected: v.startsWith('*') }));
    return choices.length ? [{ key: m[1], label: m[2].trim() || m[1], choices }] : [];
  });
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
    let r = await launchDetached('open', ['-a', app, pane]);
    if (!r.ok) r = await launchDetached('open', ['-a', app]);
    return r.ok ? { ok: true, message: app + ' opened. Select “Printers & Scanners”, then choose “' + printer + '” to review its available settings.' } : r;
  }
  return { ok: false, error: 'Opening printer settings is supported on Windows and Mac.' };
}

// ---------- paper sizes: tell the printer which paper to use ----------
// Without this, the printer uses its own default paper (often A4 or Letter),
// so a 4R photo came out on A4. We look up the paper sizes the printer offers
// and pick the one that matches the booth's paper size (borderless if it has it).
const PAPER_CACHE = new Map();
const PAPER_NAMES = { a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], letter: [215.9, 279.4], legal: [215.9, 355.6],
  postcard: [100, 148], hagaki: [100, 148], l: [89, 127], '2l': [127, 178], kg: [102, 152], '4r': [102, 152], '5r': [127, 178], '6r': [152, 203], '8r': [203, 254], '3r': [89, 127] };
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
    $hx = $e.PageSettings.HardMarginX; $hy = $e.PageSettings.HardMarginY
    $e.Graphics.DrawImage($img, [single](-$hx), [single](-$hy), [single]$page.Width, [single]$page.Height)
  } finally { $img.Dispose() }
  $script:i++
  $e.HasMorePages = ($script:i -lt $files.Count)
})
$doc.Print()
'ok'
`;
async function printPages(printer, pngBuffers, fit, widthMm, heightMm) {
  const dir = await mkdtemp(join(tmpdir(), 'pb4u-'));
  try {
    const files = [];
    for (let i = 0; i < pngBuffers.length; i++) { const f = join(dir, 'page' + (i + 1) + '.png'); await writeFile(f, pngBuffers[i]); files.push(f); }
    let r;
    if (IS_WIN) {
      const ps1 = join(dir, 'print.ps1'), list = join(dir, 'pages.txt');
      await writeFile(ps1, '﻿' + WIN_PRINT_PS, 'utf8');
      await writeFile(list, files.join('\r\n'), 'utf8');
      const pick = fit === 'width' ? null : await pickPaper(printer, widthMm, heightMm);
      if (pick) log('Paper: ' + pick.name + (pick.keep ? ' (the printer\'s default)' : ''));
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list, ...(fit === 'width' ? ['-FitWidth'] : []), ...(pick && !pick.keep ? ['-PaperName', pick.key] : [])]);
    } else {
      const pick = fit === 'width' ? null : await pickPaper(printer, widthMm, heightMm);
      if (pick) log('Paper: ' + pick.name + (pick.keep ? ' (the printer\'s default)' : ''));
      const media = fit === 'width' && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(widthMm) + 'x' + Math.round(heightMm) + 'mm']
        : pick && !pick.keep ? ['-o', (pick.opt === 'media' ? 'media=' : 'PageSize=') + pick.key] : [];
      r = await run('lp', ['-d', printer, ...media, '-o', 'fit-to-page', '-t', 'photobooth4u', ...files]);
    }
    if (r.code !== 0) throw new Error((r.err || r.out || ('exit ' + r.code)).trim().slice(0, 300));
  } finally {
    setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 60000);
  }
}

// ---------- camera (Windows) ----------
const camOk = () => (IS_WIN ? !!WORKER_PS : !!process.env.PB_CAMERA_WORKER);
const cam = { proc: null, sock: null, server: null, starting: null, buf: Buffer.alloc(0), wait: null, seq: 0, queue: Promise.resolve(), open: null };
function camReset(why) {
  if (why) log('Camera part stopped: ' + why);
  try { cam.proc && cam.proc.kill(); } catch { /* gone */ }
  try { cam.sock && cam.sock.destroy(); } catch { /* gone */ }
  try { cam.server && cam.server.close(); } catch { /* gone */ }
  if (cam.wait) { const w = cam.wait; cam.wait = null; w.reject(new Error('The camera part stopped. Try again.')); }
  cam.proc = null; cam.sock = null; cam.server = null; cam.buf = Buffer.alloc(0); cam.open = null;
}
function camParse() {
  for (;;) {
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
      await writeFile(ps1, '﻿' + WORKER_PS, 'utf8');
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
      if (e && e.message === 'timeout') { camReset('no answer to ' + cmd); throw new Error('The camera didn’t answer. Check it is on and its USB cable is plugged in.'); }
      throw e;
    } finally { clearTimeout(timer); }
  });
  cam.queue = job.catch(() => {});
  return job;
}
function camError(r) {
  const text = r.body.toString('utf8');
  const m = /^([A-Z]+) (.*)$/s.exec(text);
  return { code: r.status === 'GONE' ? 'GONE' : (m ? m[1] : 'ERROR'), error: m ? m[2] : text };
}

// ---------- requests from the booth ----------
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
let printQueue = Promise.resolve();

// path is what follows /helper (e.g. "/status", "/camera/open").
export async function handleHelper(req, path, search) {
  const method = req.method;
  if (method === 'GET' && path === '/status') {
    return json({ ok: true, app: 'photobooth4u-print-helper', builtIn: true, version: HELPER_VERSION, printers: await printers(false),
      camera: { supported: camOk(), open: !!cam.open, name: cam.open ? cam.open.name : '' } });
  }
  if (path === '/printer/configure' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const name = String(body.printer || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    return json(await openPrinterSettings(name));
  }
  if (path === '/printer/options' && method === 'GET') {
    const name = String(search.get('printer') || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    if (IS_WIN) return json({ ok: true, platformDialog: true, options: [] });
    try { return json({ ok: true, options: await cupsPrinterOptions(name) }); }
    catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  if (path === '/printer/options' && method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
    const name = String(body.printer || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer selected' }, 404);
    if (IS_WIN) return json(await openWindowsPrinterPrefs(name));
    const selected = body.options && typeof body.options === 'object' ? body.options : {};
    try {
      const available = await cupsPrinterOptions(name), args = ['-p', name];
      for (const [key, value] of Object.entries(selected)) {
        const option = available.find((x) => x.key === key);
        if (!option || !option.choices.some((x) => x.value === value)) continue;
        args.push('-o', key + '=' + value);
      }
      if (args.length > 2) {
        const r = await run('lpoptions', args);
        if (r.code !== 0) throw new Error((r.err || r.out || 'Could not save printer options').trim());
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
    const jpeg = (body) => new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } });
    try {
      if (method === 'GET' && path === '/camera') { const r = await camCall('list', '', 20000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'POST' && path === '/camera/open') {
        const r = await camCall('open', '', 60000);
        return send(r, () => { cam.open = JSON.parse(r.body.toString('utf8')); log('Camera connected: ' + cam.open.name); return json({ ok: true, ...cam.open }); });
      }
      if (method === 'POST' && path === '/camera/live') { const on = search.get('on') !== '0'; const r = await camCall('live', on ? 'on' : 'off', 20000); return send(r, () => json({ ok: true })); }
      if (method === 'GET' && path === '/camera/frame') { const r = await camCall('frame', '', 10000); return send(r, () => (r.kind === 'B' ? jpeg(r.body) : new Response(null, { status: 204 }))); }
      if (method === 'POST' && path === '/camera/capture') {
        const t0 = Date.now(); const r = await camCall('capture', '', 45000);
        return send(r, () => { log('Photo taken (' + Math.round(r.body.length / 1024) + ' KB, ' + (Date.now() - t0) + ' ms)'); return jpeg(r.body); });
      }
      if (method === 'GET' && path === '/camera/battery') { const r = await camCall('battery', '', 10000); return send(r, () => json({ ok: true, ...JSON.parse(r.body.toString('utf8')) })); }
      if (method === 'POST' && path === '/camera/close') { const r = await camCall('close', '', 10000); cam.open = null; return send(r, () => json({ ok: true })); }
    } catch (e) {
      cam.open = null;
      return json({ ok: false, code: 'HELPER', error: String(e && e.message || e) }, 503);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }
  if (method === 'GET' && path === '/paper') {
    const name = String(search.get('printer') || '').trim();
    if (!name || !(await printers(false)).includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404);
    const info = await paperSizes(name), pick = await pickPaper(name, Number(search.get('w')) || 0, Number(search.get('h')) || 0);
    const def = info.def && info.sizes.find((x) => x.key === info.def);
    return json({ ok: true, known: info.sizes.length > 0, match: pick ? { name: pick.name, borderless: !!pick.borderless, isDefault: !!pick.keep } : null, def: def ? def.name : (info.def || ''), sizes: info.sizes.slice(0, 40).map((x) => x.name) });
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
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
      if (!m) return json({ ok: false, error: 'Pages must be PNG images' }, 400);
      buffers.push(Buffer.from(m[1], 'base64'));
    }
    const fit = body.fit === 'width' ? 'width' : '';
    const job = printQueue.then(() => printPages(name, buffers, fit, Number(body.widthMm) || 0, Number(body.heightMm) || 0));
    printQueue = job.catch(() => {});
    try { await job; log('Printed ' + buffers.length + ' page(s) on ' + name); return json({ ok: true }); }
    catch (e) { log('Print failed on ' + name + ': ' + (e && e.message || e)); return json({ ok: false, error: String(e && e.message || e) }, 500); }
  }
  return json({ ok: false, error: 'Not found' }, 404);
}
export function stopHelper() { try { cam.proc && cam.proc.kill(); } catch { /* gone */ } }
