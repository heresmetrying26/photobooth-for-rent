// The Print Helper, built into the app: silent printing to a named printer
// (Windows: .NET printing in PowerShell; Mac: CUPS `lp`) and, on Windows, the
// Nikon / Canon EOS camera over USB through Windows' own camera driver (camera-worker.ps1).
// Same endpoints as tools/print-helper/print-helper.js, served to the booth at
// app://booth/helper/... (same origin, so no CORS or permission prompts).
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';

export const HELPER_VERSION = '1.1.5-app';
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

const WIN_PRINT_PS = String.raw`
param([string]$Printer, [string]$ListFile, [switch]$FitWidth)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$files = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
if ($files.Count -eq 0) { throw "No pages to print" }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
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
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list, ...(fit === 'width' ? ['-FitWidth'] : [])]);
    } else {
      const media = fit === 'width' && widthMm > 0 && heightMm > 0 ? ['-o', 'media=Custom.' + Math.round(widthMm) + 'x' + Math.round(heightMm) + 'mm'] : [];
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
