// Guards against the Desktop 1.1.87 camera bug: the Windows camera part never started ("The camera part could not start
// (stopped: The requested address is not valid in its context 127.0.0.1:0)"), over and over, every few seconds.
//
// Cause: tools/print-helper/camera-worker.ps1 was saved with a byte-order mark and the app writes its own BOM in front of the
// script before it runs it. Two BOMs make PowerShell run the first comment line as code, `param([int]$Port)` is then ignored and
// the worker connects to port 0.
//
//   node scripts/test-camera-worker-start.mjs      exit 1 on a problem (the live start-up check runs on Windows only)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { psFileText } from '../desktop/lib/helper.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'tools', 'print-helper', 'camera-worker.ps1');
let bad = 0;
const fail = (m) => { bad++; console.error('FAIL: ' + m); };
const bomCount = (buf) => { let n = 0; while (buf[n * 3] === 0xEF && buf[n * 3 + 1] === 0xBB && buf[n * 3 + 2] === 0xBF) n++; return n; };

// 1. The text the app writes has exactly one BOM, however the source file was saved.
for (const [label, src] of [['no BOM', '# x\nparam([int]$Port)\n'], ['one BOM', '﻿# x\nparam([int]$Port)\n'], ['two BOMs', '﻿﻿# x\nparam([int]$Port)\n']]) {
  const out = Buffer.from(psFileText(src), 'utf8');
  if (bomCount(out) !== 1) fail('psFileText(' + label + ') wrote ' + bomCount(out) + ' BOM(s), expected 1');
  if (out.toString('utf8').replace(/^﻿/, '').indexOf('﻿') >= 0) fail('psFileText(' + label + ') left a stray BOM inside the text');
}
// 2. The worker source is kept BOM-free (the app adds the one it needs).
if (bomCount(readFileSync(WORKER)) !== 0) fail('tools/print-helper/camera-worker.ps1 starts with a BOM; save it without one (the app and the Print Helper add theirs)');

// 3. Windows only: the real worker, written the way the app writes it, must connect back to a local server.
async function liveCheck() {
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-workertest-'));
  try {
    const ps1 = join(dir, 'camera-worker-test.ps1');
    writeFileSync(ps1, psFileText(readFileSync(WORKER, 'utf8')), 'utf8');
    let connected = false;
    const server = createServer((sock) => { connected = true; setTimeout(() => sock.destroy(), 300); });
    const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
    let out = '';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Port', String(port)], { windowsHide: true });
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 40000);
    await new Promise((res) => proc.on('close', res));
    clearTimeout(timer);
    server.close();
    if (!connected) fail('the camera worker did not connect to 127.0.0.1:' + port + '. Its output: ' + out.replace(/\s+/g, ' ').slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (process.platform === 'win32') await liveCheck();
else console.log('(not Windows: skipped the live worker start check)');

if (bad) { console.error(bad + ' problem(s)'); process.exit(1); }
console.log('OK: the camera worker script has one BOM and starts');
