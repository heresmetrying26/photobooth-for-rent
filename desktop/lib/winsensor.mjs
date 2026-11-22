// Windows tablet motion sensor bridge (Gyrometer & Accelerometer via WinRT in PowerShell)
// Used for Surface Pro / Windows 2-in-1 tablets mounted on a 360 spinning arm so the
// desktop app can auto-start recording when the arm begins rotating sideways.
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const IS_WIN = platform() === 'win32';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let backend = null;
export function setBackend(b) { backend = b || null; }

const PROBE_PS = [
  "$ErrorActionPreference='Stop'",
  "[Windows.Devices.Sensors.Gyrometer, Windows.Devices.Sensors, ContentType=WindowsRuntime] | Out-Null",
  "[Windows.Devices.Sensors.Accelerometer, Windows.Devices.Sensors, ContentType=WindowsRuntime] | Out-Null",
  "$g = [Windows.Devices.Sensors.Gyrometer]::GetDefault()",
  "$a = [Windows.Devices.Sensors.Accelerometer]::GetDefault()",
  "$res = @{ gyro = ($null -ne $g); accel = ($null -ne $a) } | ConvertTo-Json -Compress",
  "Write-Output $res"
].join('\n');

const STREAM_PS = [
  "$ErrorActionPreference='Stop'",
  "[Windows.Devices.Sensors.Gyrometer, Windows.Devices.Sensors, ContentType=WindowsRuntime] | Out-Null",
  "[Windows.Devices.Sensors.Accelerometer, Windows.Devices.Sensors, ContentType=WindowsRuntime] | Out-Null",
  "$g = [Windows.Devices.Sensors.Gyrometer]::GetDefault()",
  "$a = [Windows.Devices.Sensors.Accelerometer]::GetDefault()",
  "$inv = [System.Globalization.CultureInfo]::InvariantCulture",
  "if ($null -eq $g -and $null -eq $a) { Write-Output '{\"available\":false}'; exit 0 }",
  "if ($null -ne $g) { try { $m = [uint32][Math]::Max(16, [int]$g.MinimumReportInterval); $g.ReportInterval = [uint32][Math]::Min(100, [int]$m) } catch {} }",
  "if ($null -ne $a) { try { $m = [uint32][Math]::Max(16, [int]$a.MinimumReportInterval); $a.ReportInterval = [uint32][Math]::Min(100, [int]$m) } catch {} }",
  "$hasG = ($null -ne $g); $hasA = ($null -ne $a)",
  "Write-Output ('{\"available\":true,\"gyro\":' + ($hasG.ToString().ToLowerInvariant()) + ',\"accel\":' + ($hasA.ToString().ToLowerInvariant()) + '}')",
  "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
  "while ($true) {",
  "  $gx = 0.0; $gy = 0.0; $gz = 0.0; $ax = 0.0; $ay = 0.0; $az = -1.0",
  "  if ($hasG) { try { $gr = $g.GetCurrentReading(); if ($null -ne $gr) { $gx = $gr.AngularVelocityX; $gy = $gr.AngularVelocityY; $gz = $gr.AngularVelocityZ } } catch {} }",
  "  if ($hasA) { try { $ar = $a.GetCurrentReading(); if ($null -ne $ar) { $ax = $ar.AccelerationX; $ay = $ar.AccelerationY; $az = $ar.AccelerationZ } } catch {} }",
  "  $dps = [Math]::Sqrt($gx*$gx + $gy*$gy + $gz*$gz)",
  "  $gd = [Math]::Abs([Math]::Sqrt($ax*$ax + $ay*$ay + $az*$az) - 1.0)",
  "  $line = ('{\"t\":' + $sw.ElapsedMilliseconds + ',\"dps\":' + $dps.ToString('0.##',$inv) + ',\"gd\":' + $gd.ToString('0.###',$inv) + ',\"gx\":' + $gx.ToString('0.##',$inv) + ',\"gy\":' + $gy.ToString('0.##',$inv) + ',\"gz\":' + $gz.ToString('0.##',$inv) + '}')",
  "  Write-Output $line",
  "  [Console]::Out.Flush()",
  "  Start-Sleep -Milliseconds 25",
  "}"
].join('\n');

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

const st = {
  proc: null,
  buf: '',
  available: null,
  gyro: false,
  accel: false,
  running: false,
  latest: { t: 0, dps: 0, gDelta: 0, gx: 0, gy: 0, gz: 0, source: 'none' },
  listeners: new Set()
};

function emitReading(r) {
  st.latest = r;
  for (const fn of st.listeners) {
    try { fn(r); } catch { /* ignore */ }
  }
}

export function parseSensorLine(rawLine, caps = {}) {
  const s = String(rawLine || '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  if (typeof j.available === 'boolean') return { meta: true, available: j.available, gyro: !!j.gyro, accel: !!j.accel };
  const dps = Number(j.dps) || 0;
  const gDelta = Number(j.gd != null ? j.gd : j.gDelta) || 0;
  const hasGyro = caps.gyro !== false && (caps.gyro === true || dps > 0);
  const source = caps.gyro ? 'gyro' : (caps.accel ? 'accel' : (hasGyro ? 'gyro' : 'accel'));
  return {
    meta: false,
    t: Number(j.t) || Date.now(),
    dps: Math.round(dps * 10) / 10,
    gDelta: Math.round(gDelta * 1000) / 1000,
    gx: Number(j.gx) || 0,
    gy: Number(j.gy) || 0,
    gz: Number(j.gz) || 0,
    source
  };
}

export function computeSensitivity({ stillSamples = [], spinSamples = [], unit = 'dps' } = {}) {
  const clean = (arr) => (Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const still = clean(stillSamples);
  const spin = clean(spinSamples);
  if (unit === 'g') {
    const base = still.length ? Math.max(...still) : 0.04;
    const peak = spin.length ? Math.max(...spin) : 0.45;
    const sorted = spin.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : peak * 0.7;
    const active = Math.max(median, peak * 0.7);
    const start = clamp(Math.max(base * 1.8 + 0.04, base + (active - base) * 0.35), 0.08, 1.5);
    const stop = clamp(Math.max(base * 1.2 + 0.015, start * 0.45), 0.04, start * 0.8);
    return {
      unit: 'g',
      baseline: Math.round(base * 1000) / 1000,
      peak: Math.round(peak * 1000) / 1000,
      median: Math.round(median * 1000) / 1000,
      startThresh: Math.round(start * 100) / 100,
      stopThresh: Math.round(stop * 100) / 100
    };
  }
  const base = still.length ? Math.max(...still) : 3.0;
  const sorted = spin.slice().sort((a, b) => a - b);
  const peak = spin.length ? Math.max(...spin) : 60.0;
  const median = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : peak * 0.7;
  const active = Math.max(median, peak * 0.7);
  const start = clamp(Math.round(Math.max(base * 1.7 + 6.0, base + (active - base) * 0.35, 12.0)), 10, 120);
  const stop = clamp(Math.round(Math.min(start - 4.0, Math.max(base + 2.0, start * 0.45, 5.0))), 4, Math.max(4, start - 3));
  return {
    unit: 'dps',
    baseline: Math.round(base * 10) / 10,
    peak: Math.round(peak * 10) / 10,
    median: Math.round(median * 10) / 10,
    startThresh: start,
    stopThresh: stop
  };
}

export async function probeSensor() {
  if (backend && typeof backend.probe === 'function') {
    const r = await backend.probe();
    st.available = !!r.available; st.gyro = !!r.gyro; st.accel = !!r.accel;
    return { ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none', running: st.running };
  }
  if (!IS_WIN) {
    return { ok: true, available: false, gyro: false, accel: false, source: 'none', running: false, reason: 'Windows tablet sensors are only on Windows.' };
  }
  if (st.running && st.available !== null) {
    return { ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none', running: true };
  }
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (res) => { if (done) return; done = true; resolve(res); };
    let proc;
    try { proc = spawn('powershell.exe', psArgs(PROBE_PS), { windowsHide: true }); }
    catch (e) { return finish({ ok: false, available: false, gyro: false, accel: false, source: 'none', error: String(e && e.message || e) }); }
    const timer = setTimeout(() => { try { proc.kill(); } catch { } finish({ ok: false, available: false, gyro: false, accel: false, source: 'none', error: 'Sensor probe timed out' }); }, 8000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); finish({ ok: false, available: false, gyro: false, accel: false, source: 'none', error: String(e && e.message || e) }); });
    proc.on('close', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{')).pop() || '';
      try {
        const j = JSON.parse(line || '{}');
        st.gyro = !!j.gyro;
        st.accel = !!j.accel;
        st.available = !!(j.gyro || j.accel);
        finish({ ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none', running: st.running });
      } catch {
        finish({ ok: false, available: false, gyro: false, accel: false, source: 'none', error: err.trim() || 'Could not inspect Windows sensors' });
      }
    });
  });
}

export async function startSensor(onReading) {
  if (typeof onReading === 'function') st.listeners.add(onReading);
  if (backend && typeof backend.start === 'function') {
    const r = await backend.start((raw) => {
      const p = typeof raw === 'string' ? parseSensorLine(raw, st) : raw;
      if (p && !p.meta) emitReading(p);
    });
    st.running = !!(r && r.ok !== false);
    st.available = r && r.available !== undefined ? !!r.available : true;
    st.gyro = r && r.gyro !== undefined ? !!r.gyro : true;
    st.accel = r && r.accel !== undefined ? !!r.accel : false;
    return { ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none' };
  }
  if (!IS_WIN) {
    return { ok: true, available: false, gyro: false, accel: false, source: 'none' };
  }
  if (st.running && st.proc) {
    return { ok: true, available: !!st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none' };
  }
  const p = await probeSensor();
  if (!p.available) return p;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => { if (settled) return; settled = true; resolve(res); };
    let proc;
    try { proc = spawn('powershell.exe', psArgs(STREAM_PS), { windowsHide: true }); }
    catch (e) { return settle({ ok: false, available: false, error: String(e && e.message || e) }); }
    st.proc = proc;
    st.buf = '';
    st.running = true;
    const timer = setTimeout(() => { settle({ ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none' }); }, 6000);

    proc.stdout.on('data', (chunk) => {
      if (st.proc !== proc) return;
      st.buf += chunk.toString('utf8');
      const lines = st.buf.split(/\r?\n/);
      st.buf = lines.pop() || '';
      for (const ln of lines) {
        const parsed = parseSensorLine(ln, st);
        if (!parsed) continue;
        if (parsed.meta) {
          st.available = !!parsed.available;
          st.gyro = !!parsed.gyro;
          st.accel = !!parsed.accel;
          clearTimeout(timer);
          settle({ ok: true, available: st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none' });
          if (!st.available) stopSensor();
        } else {
          emitReading(parsed);
        }
      }
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (st.proc === proc) { st.proc = null; st.running = false; }
      settle({ ok: true, available: !!st.available, gyro: st.gyro, accel: st.accel, source: st.gyro ? 'gyro' : st.accel ? 'accel' : 'none' });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      if (st.proc === proc) { st.proc = null; st.running = false; }
      settle({ ok: false, available: false, error: String(e && e.message || e) });
    });
  });
}

export function stopSensor() {
  if (backend && typeof backend.stop === 'function') {
    try { backend.stop(); } catch { /* ignore */ }
  }
  const p = st.proc;
  st.proc = null;
  st.running = false;
  st.buf = '';
  if (p) {
    try { p.kill(); } catch { /* gone */ }
  }
  return { ok: true };
}

export const latestSensor = () => ({ ...st.latest, running: st.running, available: !!st.available, gyro: st.gyro, accel: st.accel });
