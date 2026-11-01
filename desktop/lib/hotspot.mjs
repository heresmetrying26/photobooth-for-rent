// The booth's own Wi-Fi (Windows & Mac): the laptop turns on its own hotspot itself, so guests' phones can join it
// with the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot at the booth.
//
// Windows: start / stop uses Windows Runtime NetworkOperatorTetheringManager. With no external Wi-Fi, `setup` adds
// Microsoft's loopback adapter once.
// Mac: `setup` adds an offline loopback service (BoothDummy) once with administrator privileges, unlocking macOS
// Internet Sharing to Wi-Fi without external internet, routing on bridge100.
import { tmpdir, platform, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
export const HOTSPOT_IP = '192.168.137.1';   // where Windows puts the laptop on its hotspot
let log = (m) => console.log('[hotspot] ' + m);
let cfgStore = { get: () => ({}), save: () => {} };
const st = { busy: false, error: '', needsSetup: false, started: false, fails: 0 };
let keepTimer = null;

// ---------- the PowerShell that talks to Windows ----------
// (No backticks, ${ or backslashes in here: it is a raw template string.)
const TETHER_PS = String.raw`param([string]$Mode, [string]$Ssid, [string]$Pass)
$ErrorActionPreference = 'Stop'
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]
  $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions]
  $opName = 'IAsyncOperation' + [char]96 + '1'
  $asOp = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $opName } | Select-Object -First 1
  $asAct = $ext.GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  function AwaitOp($op, $type) {
    $t = $asOp.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $t.Wait(40000)) { throw 'timed-out' }
    return $t.Result
  }
  function AwaitAct($act) {
    $t = $asAct.Invoke($null, @($act))
    if (-not $t.Wait(40000)) { throw 'timed-out' }
  }
  function GetMgr {
    $mgrType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]
    $p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($p -ne $null) { return $mgrType::CreateFromConnectionProfile($p) }
    foreach ($q in [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()) {
      try { return $mgrType::CreateFromConnectionProfile($q) } catch { }
    }
    throw 'no-connection'
  }
  $opResult = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
  if ($Mode -eq 'status') {
    $m = GetMgr
    Say @{ ok = $true; state = [string]$m.TetheringOperationalState; clients = [int]$m.ClientCount }
  }
  elseif ($Mode -eq 'stop') {
    try {
      $m = GetMgr
      if ($m.TetheringOperationalState -eq 'On') { $null = AwaitOp ($m.StopTetheringAsync()) $opResult }
    } catch { }
    Say @{ ok = $true }
  }
  elseif ($Mode -eq 'start') {
    $m = GetMgr
    $cfg = $m.GetCurrentAccessPointConfiguration()
    $same = ($cfg.Ssid -eq $Ssid -and $cfg.Passphrase -eq $Pass)
    if ($m.TetheringOperationalState -eq 'On' -and $same) { Say @{ ok = $true; state = 'On'; already = $true }; exit 0 }
    if ($m.TetheringOperationalState -eq 'On') { $null = AwaitOp ($m.StopTetheringAsync()) $opResult }
    $cfg.Ssid = $Ssid
    $cfg.Passphrase = $Pass
    try { $cfg.Band = 'TwoPointFourGigahertz' } catch { }
    AwaitAct ($m.ConfigureAccessPointAsync($cfg))
    $r = AwaitOp ($m.StartTetheringAsync()) $opResult
    if ($r.Status -ne 'Success') { throw ('start-failed ' + $r.Status + ' ' + $r.AdditionalErrorMessage) }
    Say @{ ok = $true; state = [string]$m.TetheringOperationalState }
  }
  else { Say @{ ok = $false; error = 'unknown mode' } }
} catch {
  Say @{ ok = $false; error = ([string]$_.Exception.Message) }
}
`;

// Run once, elevated: lets the hotspot start with no other network (Microsoft loopback adapter) and lets guests'
// phones reach the app through the firewall on the hotspot's own subnet. Result is written to $out as JSON.
const SETUP_PS = String.raw`$ErrorActionPreference = 'Stop'
$out = '@OUT@'
$exe = '@EXE@'
$res = @{ ok = $false; loopback = $false; firewall = $false; error = '' }
try {
  netsh advfirewall firewall delete rule name="photobooth4u hotspot guests" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u hotspot guests" dir=in action=allow program="$exe" enable=yes profile=any remoteip=192.168.137.0/24 | Out-Null
  $res.firewall = $true
  $have = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Loopback*' }
  if (-not $have) {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class Pb4uLoop {
  [StructLayout(LayoutKind.Sequential)] struct DevInfo { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", SetLastError=true)] static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid g, IntPtr h);
  [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool SetupDiCreateDeviceInfo(IntPtr set, string name, ref Guid g, string desc, IntPtr h, int flags, ref DevInfo d);
  [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set, ref DevInfo d, int prop, byte[] buf, int size);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiCallClassInstaller(int fn, IntPtr set, ref DevInfo d);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("newdev.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr h, string hwid, string inf, int flags, out bool reboot);
  public static void Install() {
    Guid net = new Guid("4d36e972-e325-11ce-bfc1-08002be10318");
    IntPtr set = SetupDiCreateDeviceInfoList(ref net, IntPtr.Zero);
    if (set == (IntPtr)(-1)) throw new Exception("device list " + Marshal.GetLastWin32Error());
    try {
      DevInfo d = new DevInfo(); d.cbSize = Marshal.SizeOf(d);
      if (!SetupDiCreateDeviceInfo(set, "NET", ref net, null, IntPtr.Zero, 1, ref d)) throw new Exception("create " + Marshal.GetLastWin32Error());
      byte[] id = Encoding.Unicode.GetBytes("*MSLOOP" + (char)0 + (char)0);
      if (!SetupDiSetDeviceRegistryProperty(set, ref d, 1, id, id.Length)) throw new Exception("hwid " + Marshal.GetLastWin32Error());
      if (!SetupDiCallClassInstaller(0x19, set, ref d)) throw new Exception("register " + Marshal.GetLastWin32Error());
      bool reboot;
      string inf = Environment.GetEnvironmentVariable("windir") + "\\inf\\netloop.inf";
      if (!UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, "*MSLOOP", inf, 1, out reboot)) throw new Exception("driver " + Marshal.GetLastWin32Error());
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }
}
"@
    [Pb4uLoop]::Install()
    Start-Sleep -Seconds 6
    $have = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like '*Loopback*' }
  }
  if (-not $have) { throw 'The loopback adapter did not appear.' }
  $ad = $have | Select-Object -First 1
  try { if ($ad.Name -notlike '*Loopback*') { Rename-NetAdapter -Name $ad.Name -NewName 'photobooth4u Loopback' -ErrorAction Stop; $ad = Get-NetAdapter -Name 'photobooth4u Loopback' } } catch { }
  if (-not (Get-NetIPAddress -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -eq 'Manual' })) {
    New-NetIPAddress -InterfaceIndex $ad.ifIndex -IPAddress 10.254.254.1 -PrefixLength 24 -ErrorAction Stop | Out-Null
  }
  $res.loopback = $true
  $res.ok = $true
} catch { $res.error = [string]$_.Exception.Message }
($res | ConvertTo-Json -Compress) | Set-Content -Path $out -Encoding UTF8
`;

// ---------- helpers ----------
function runPs(args, timeout) {
  return new Promise((resolve) => {
    let out = '', err = '', p, done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    try { p = spawn('powershell.exe', args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } fin({ code: -2, out, err: 'timed out' }); }, timeout || 60000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fin({ code: -1, out, err: String(e && e.message || e) }));
    p.on('close', (code) => fin({ code, out, err }));
  });
}
function lastJson(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* next */ } }
  return null;
}
async function tether(mode, ssid, pass, timeout) {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pb4u-hotspot-'));
    const ps1 = join(dir, 'hotspot.ps1');
    writeFileSync(ps1, '﻿' + TETHER_PS);
    const r = await runPs([...PS, '-File', ps1, '-Mode', mode, ...(ssid ? ['-Ssid', ssid, '-Pass', pass] : [])], timeout);
    return lastJson(r.out) || { ok: false, error: (r.err || r.out || 'no answer').trim().slice(0, 300) };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } }
}

const SAFE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rand = (n) => Array.from({ length: n }, () => SAFE[randomInt(SAFE.length)]).join('');

function macCheckDummy() {
  return new Promise((resolve) => {
    if (!IS_MAC) return resolve(false);
    execFile('networksetup', ['-listallnetworkservices'], { timeout: 4000, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(stdout.split('\n').some((l) => l.trim() === 'BoothDummy'));
    });
  });
}

function openMacSharing() {
  return new Promise((resolve) => {
    execFile('open', ['x-apple.systempreferences:com.apple.Sharing-Settings.extension'], () => {
      execFile('open', ['x-apple.systempreferences:com.apple.preferences.sharing'], () => resolve());
    });
  });
}

// Is the laptop's hotspot adapter up right now?
// Windows: 192.168.137.1. Mac: bridge100 (192.168.2.1 / 192.168.3.1).
export function hotspotUp() {
  const nets = networkInterfaces();
  if (IS_WIN) {
    return Object.values(nets).some((l) => (l || []).some((a) => (a.family === 'IPv4' || a.family === 4) && a.address === HOTSPOT_IP));
  }
  if (IS_MAC) {
    return Object.entries(nets).some(([name, list]) =>
      (/^bridge/i.test(name)) && (list || []).some((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal && /^192\.168\./.test(a.address))
    );
  }
  return false;
}

// ---------- what main.mjs uses ----------
export function initHotspot({ get, save, logger }) {
  if (logger) log = logger;
  cfgStore = { get, save };
  const c = get();
  // A name and password made once per laptop (not one shared by every booth).
  if (!c.ssid || !c.pass) { c.ssid = 'photobooth4u-' + rand(4); c.pass = rand(10); }
  c.on = false; save();   // it was switched off when the app last closed
  if (IS_WIN && c.auto) hotspotStart().catch(() => {});
  if (IS_MAC) {
    macCheckDummy().then((has) => {
      st.needsSetup = !has;
      if (!has) {
        st.error = 'Mac needs a 1-time setup to share Wi-Fi offline. Press “Set up (one time)”: your Mac asks for permission once.';
      }
    }).catch(() => {});
  }
  keepAlive();
}

export function hotspotInfo() {
  const c = cfgStore.get();
  return {
    supported: IS_WIN || IS_MAC, ssid: c.ssid || '', pass: c.pass || '', auto: !!c.auto,
    on: (IS_WIN || IS_MAC) && hotspotUp(), wanted: !!c.on, busy: st.busy, error: st.error, needsSetup: st.needsSetup
  };
}

function explain(error) {
  const e = String(error || '');
  if (/no-connection|NetworkLimitedConnectivity|doesn.?t have an Ethernet/i.test(e)) {
    return { needsSetup: true, text: (IS_MAC ? 'Mac' : 'Windows') + ' only starts its hotspot when the laptop has a network to share, and this one has none. Press “Set up (one time)” while you are at the booth or at home: the laptop asks for permission once.' };
  }
  if (/WiFiDeviceOff/.test(e)) return { needsSetup: false, text: 'This laptop’s Wi-Fi is switched off. Turn Wi-Fi on (airplane mode off), then try again.' };
  if (/NotSupported|0x80004002|No such interface/i.test(e)) return { needsSetup: false, text: 'This laptop’s Wi-Fi adapter can’t host a hotspot. Use a pocket Wi-Fi router, or a phone hotspot.' };
  if (/OperationInProgress/.test(e)) return { needsSetup: false, text: 'The laptop is still busy with the hotspot. Wait a few seconds and try again.' };
  return { needsSetup: false, text: 'Couldn’t start the hotspot (' + e.slice(0, 120) + '). Use a pocket Wi-Fi router or a phone hotspot instead.' };
}

export async function hotspotStart() {
  if (!IS_WIN && !IS_MAC) return hotspotInfo();
  if (st.busy) return hotspotInfo();
  const c = cfgStore.get();
  st.busy = true; st.error = ''; st.needsSetup = false;
  c.on = true; cfgStore.save();

  if (IS_MAC) {
    try {
      const hasDummy = await macCheckDummy();
      if (!hasDummy) {
        st.needsSetup = true;
        st.error = 'Press “Set up (one time)” first to prepare your Mac for offline booth Wi-Fi.';
        c.on = false; cfgStore.save();
        return hotspotInfo();
      }
      await new Promise((resolve) => {
        const cmd = 'do shell script "launchctl load -w /System/Library/LaunchDaemons/com.apple.InternetSharing.plist" with administrator privileges';
        execFile('osascript', ['-e', cmd], { timeout: 20000 }, () => resolve());
      });
      await openMacSharing();
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (hotspotUp()) break;
      }
      if (hotspotUp()) {
        st.started = true;
        st.fails = 0;
        log('mac hotspot on');
      } else {
        st.error = 'In System Settings → Sharing, turn Internet Sharing ON (Share from: BoothDummy, to: Wi-Fi).';
      }
    } catch {
      st.error = 'In System Settings → Sharing, turn Internet Sharing ON (Share from: BoothDummy, to: Wi-Fi).';
    } finally {
      st.busy = false;
    }
    return hotspotInfo();
  }

  try {
    const r = await tether('start', c.ssid, c.pass, 70000);
    if (r.ok) { st.started = true; st.fails = 0; log('on: ' + c.ssid); }
    else {
      const x = explain(r.error);
      st.error = x.text; st.needsSetup = x.needsSetup; st.fails++;
      c.on = false; cfgStore.save();
      log('start failed: ' + r.error);
    }
  } finally { st.busy = false; }
  return hotspotInfo();
}

export async function hotspotStop() {
  if (!IS_WIN && !IS_MAC) return hotspotInfo();
  const c = cfgStore.get();
  c.on = false; cfgStore.save();
  st.error = ''; st.needsSetup = false;
  if (st.busy) return hotspotInfo();
  st.busy = true;

  if (IS_MAC) {
    try {
      await new Promise((resolve) => {
        const cmd = 'do shell script "launchctl unload -w /System/Library/LaunchDaemons/com.apple.InternetSharing.plist" with administrator privileges';
        execFile('osascript', ['-e', cmd], { timeout: 20000 }, () => resolve());
      });
      st.started = false;
      log('mac hotspot off');
    } catch { /* ignore */ }
    finally { st.busy = false; }
    return hotspotInfo();
  }

  try { await tether('stop', '', '', 30000); st.started = false; log('off'); }
  finally { st.busy = false; }
  return hotspotInfo();
}

// Stop the hotspot when the app quits, without holding the quit up.
export function hotspotStopOnQuit() {
  if ((!IS_WIN && !IS_MAC) || !st.started) return;
  if (IS_MAC) {
    try {
      const cmd = 'do shell script "launchctl unload -w /System/Library/LaunchDaemons/com.apple.InternetSharing.plist" with administrator privileges';
      execFile('osascript', ['-e', cmd], () => {});
    } catch { /* ignore */ }
    return;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'pb4u-hotspot-'));
    const ps1 = join(dir, 'hotspot.ps1');
    writeFileSync(ps1, '﻿' + TETHER_PS);
    const p = spawn('powershell.exe', [...PS, '-File', ps1, '-Mode', 'stop'], { windowsHide: true, detached: true, stdio: 'ignore' });
    p.unref();
  } catch { /* ignore */ }
}

// Windows & Mac keepalive: if the hotspot goes off while wanted, start it again.
function keepAlive() {
  if ((!IS_WIN && !IS_MAC) || keepTimer) return;
  keepTimer = setInterval(() => {
    const c = cfgStore.get();
    if (!c.on || st.busy || st.fails >= 3 || hotspotUp()) return;
    log('hotspot went off by itself, starting it again');
    hotspotStart().catch(() => {});
  }, 20000);
  if (keepTimer.unref) keepTimer.unref();
}

export function hotspotSetAuto(on) {
  const c = cfgStore.get();
  c.auto = !!on; cfgStore.save();
  return hotspotInfo();
}

// One-time set-up with admin rights (a single permission prompt).
export async function hotspotSetup() {
  if (!IS_WIN && !IS_MAC) return { ok: false, error: 'Not supported.' };
  if (st.busy) return { ok: false, error: 'Busy.' };
  st.busy = true; st.error = '';

  if (IS_MAC) {
    try {
      const setupScript = 'do shell script "networksetup -createnetworkservice BoothDummy lo0 && networksetup -setmanual BoothDummy 192.168.1.88 255.255.255.255" with administrator privileges';
      const r = await new Promise((resolve) => {
        execFile('osascript', ['-e', setupScript], { timeout: 60000, encoding: 'utf8' }, (err, stdout, stderr) => {
          resolve({ ok: !err, err: String(stderr || (err && err.message) || '') });
        });
      });
      if (!r.ok) {
        const cancelled = /user canceled/i.test(r.err);
        st.error = cancelled ? 'Set-up was cancelled. Press the button again and enter your Mac password.' : 'Set-up failed: ' + r.err.slice(0, 140);
        return { ok: false, error: st.error };
      }
      st.needsSetup = false;
      st.fails = 0;
      st.error = '';
      log('mac setup done: BoothDummy created');
      await openMacSharing();
      return { ok: true };
    } catch (e) {
      st.error = 'Set-up failed: ' + String(e && e.message || e).slice(0, 140);
      return { ok: false, error: st.error };
    } finally {
      st.busy = false;
    }
  }
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pb4u-hotspot-'));
    const outFile = join(dir, 'setup.json');
    const q = (s) => String(s).replace(/'/g, "''");
    const script = SETUP_PS.replace('@OUT@', () => q(outFile)).replace('@EXE@', () => q(process.execPath));
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const cmd = "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + enc + "'";
    const r = await runPs([...PS, '-Command', cmd], 120000);
    let res = null;
    try { res = JSON.parse(readFileSync(outFile, 'utf8').replace(/^﻿/, '')); } catch { /* not written */ }
    if (!res) {
      const declined = /canceled by the user|cancelled/i.test(r.err || '');
      st.error = declined ? 'Set-up was cancelled. Press the button again and choose Yes when Windows asks.' : 'Set-up didn’t finish (' + String(r.err || 'no answer').trim().slice(0, 120) + ').';
      return { ok: false, error: st.error };
    }
    if (!res.ok) { st.error = 'Set-up failed: ' + String(res.error || '').slice(0, 160); log('setup failed: ' + res.error); return { ok: false, error: st.error }; }
    st.needsSetup = false; st.fails = 0;
    log('setup done');
    return { ok: true };
  } catch (e) {
    st.error = 'Set-up failed: ' + String(e && e.message || e).slice(0, 160);
    return { ok: false, error: st.error };
  } finally {
    st.busy = false;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
