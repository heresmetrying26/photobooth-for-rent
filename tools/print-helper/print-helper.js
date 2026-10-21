// photobooth4u Print Helper
// Runs on the booth laptop and lets the booth (a web page) print straight to a
// named printer with no print dialog — so each paper size can go to its own
// printer (e.g. 2x6 strips to one, 4R to another), like a native booth app.
//
// - Listens on 127.0.0.1:17321 only (never reachable from other computers).
// - Only accepts requests from the photobooth4u site (ALLOWED_ORIGINS).
// - macOS / Linux: prints through CUPS (`lp`). Windows: through .NET printing
//   in PowerShell (built in). Nothing else to install.
// - Paper size, borderless and cutting come from each printer's own default
//   settings, so set those in the printer's preferences once.
//
// Build (from any OS, needs Bun):
//   bun build --compile --target=bun-darwin-arm64 print-helper.js --outfile photobooth4u-print-helper-mac-apple-silicon
//   bun build --compile --target=bun-darwin-x64   print-helper.js --outfile photobooth4u-print-helper-mac-intel
//   bun build --compile --target=bun-windows-x64  print-helper.js --outfile photobooth4u-print-helper-windows.exe

import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const VERSION = '1.0.1';
const PORT = 17321;
const ALLOWED_ORIGINS = new Set([
  'https://photobooth4u.netlify.app',
  'http://localhost:8888',            // netlify dev
  ...(process.env.PB_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
const IS_WIN = platform() === 'win32';
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

// Windows: draw each PNG onto the full page of the named printer, turning it
// 90° when the printer's page is the other way round (e.g. a 6x4 driver page).
const WIN_PRINT_PS = String.raw`
param([string]$Printer, [string]$ListFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# @( ) keeps a one-page list an array (otherwise $files[0] is just the first letter of the path)
$files = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_ })
if ($files.Count -eq 0) { throw "No pages to print" }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
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

async function printPages(printer, pngBuffers){
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
      r = await run('powershell.exe', [...PS, '-File', ps1, '-Printer', printer, '-ListFile', list]);
    } else {
      // Pages are already exactly paper-sized at 300 dpi; fit-to-page keeps
      // them filling the sheet the printer's default paper size defines.
      r = await run('lp', ['-d', printer, '-o', 'fit-to-page', '-t', 'photobooth4u', ...files]);
    }
    if(r.code !== 0) throw new Error((r.err || r.out || ('exit ' + r.code)).trim().slice(0, 300));
  } finally {
    // Give the spooler a moment to read the files before removing them.
    setTimeout(() => rm(dir, { recursive: true, force: true }).catch(() => {}), 60000);
  }
}

// ---------- HTTP ----------
function cors(origin){
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if(origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, status, origin){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', ...cors(origin) } });
}

let printersCache = { at: 0, list: [] };
async function printers(force){
  if(force || Date.now() - printersCache.at > 10000){
    printersCache = { at: Date.now(), list: await listPrinters() };
  }
  return printersCache.list;
}

let queue = Promise.resolve();   // one job at a time

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  async fetch(req){
    const origin = req.headers.get('origin') || '';
    const url = new URL(req.url);
    if(origin && !ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: 'This site is not allowed to print here.' }, 403);
    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    if(req.method === 'GET' && url.pathname === '/status'){
      return json({ ok: true, app: 'photobooth4u-print-helper', version: VERSION, printers: await printers(false) }, 200, origin);
    }

    if(req.method === 'POST' && url.pathname === '/print'){
      if(!origin) return json({ ok: false, error: 'Missing origin' }, 403);
      let body;
      try{ body = await req.json(); }catch(e){ return json({ ok: false, error: 'Bad request' }, 400, origin); }
      const name = String(body.printer || '').trim();
      const pages = Array.isArray(body.pages) ? body.pages : [];
      if(!name) return json({ ok: false, error: 'No printer chosen' }, 400, origin);
      if(!pages.length || pages.length > 20) return json({ ok: false, error: 'No pages' }, 400, origin);
      const list = await printers(true);
      if(!list.includes(name)) return json({ ok: false, error: 'No printer called "' + name + '"' }, 404, origin);
      const buffers = [];
      for(const p of pages){
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p));
        if(!m) return json({ ok: false, error: 'Pages must be PNG images' }, 400, origin);
        buffers.push(Buffer.from(m[1], 'base64'));
      }
      const job = queue.then(() => printPages(name, buffers));
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
console.log('  photobooth4u Print Helper ' + VERSION);
console.log('  Running. Keep this window open while the booth is printing.');
console.log('  (Close it to stop. Listening on 127.0.0.1:' + server.port + ' for ' + [...ALLOWED_ORIGINS][0] + ')');
console.log('');
printers(true).then(list => {
  console.log('  Printers on this computer:');
  (list.length ? list : ['(none found)']).forEach(n => console.log('   - ' + n));
  console.log('');
}).catch(() => {});
