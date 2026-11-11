// The booth's own Wi-Fi (Windows & Mac): the laptop turns on its own hotspot itself, so guests' phones can join it
// with the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot at the booth.
//
// Windows: start / stop uses Windows Runtime NetworkOperatorTetheringManager. With no external Wi-Fi, `setup` adds
// Microsoft's loopback adapter once.
// Mac: `setup` adds an offline loopback service (BoothDummy) once with administrator privileges, unlocking macOS
// Internet Sharing to Wi-Fi without external internet, routing on bridge100.
import { tmpdir, platform, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { randomInt, createHash } from 'node:crypto';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
export const HOTSPOT_IP = '192.168.137.1';   // where Windows puts the laptop on its hotspot
let log = (m) => console.log('[hotspot] ' + m);
let cfgStore = { get: () => ({}), save: () => {} };
const st = { busy: false, error: '', needsSetup: false, started: false, fails: 0,
  driverUnsupported: false };   // Option 4: set true when this laptop can't (or must not) host
let keepTimer = null;
// main.mjs passes this in: the page is told when the hotspot changes, so it does not have to keep asking.
let notify = () => {};
function ping() { try { notify(hotspotInfo()); } catch { /* ignore */ } }

// Crash guard: a small file that exists only while Windows is starting the hotspot. If the app finds it at launch,
// the laptop went down in the middle of a start (a Wi-Fi driver blue screen does exactly that). It is its own file,
// flushed to disk straight away, so it is still there after a crash.
let markFile = '';
function markStart() {
  if (!markFile) return;
  try { const fd = openSync(markFile, 'w'); writeSync(fd, String(Date.now())); fsyncSync(fd); closeSync(fd); } catch { /* ignore */ }
}
function clearMark() { if (markFile) { try { rmSync(markFile, { force: true }); } catch { /* ignore */ } } }
const CRASH_WARN = 'The laptop shut down while it was starting the booth Wi-Fi last time, so it no longer starts by itself. If the laptop crashed (blue screen), use a pocket Wi-Fi router or a phone hotspot instead.';
const CRASH_LOCK = 'The booth Wi-Fi is switched off on this laptop: it shut down twice while starting it. Use a pocket Wi-Fi router or a phone hotspot. Updating the laptop\u2019s Wi-Fi driver turns this back on.';

// Option 1: session-activity tracking for smart idle/wake keepAlive.
// hasSession  = true once the first guest photo session has started.
// lastSession = timestamp of the most recent photo save / session start.
let hasSession = false;
let lastSession = 0;

// Called by main.mjs whenever a photo is saved to /local/drive or the booth
// session tab is opened.  Wakes the hotspot if it went to sleep during idle.
export function hotspotWake() {
  hasSession = true;
  lastSession = Date.now();
  if (resumePending) { resumeNow(); return; }   // just woke from sleep: don't wait out the 12 s, a guest is here
  const c = cfgStore.get();
  if (!IS_WIN || !c.on || st.busy || st.driverUnsupported || st.fails >= 2) return;
  if (!hotspotUp()) {
    log('photo session active - waking hotspot from idle');
    hotspotStart().catch(() => {});
  }
}

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
    $Ssid = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Ssid))
    $Pass = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Pass))
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
  # Option 1: disable Windows 10 mobile hotspot auto-off (stops hosting after ~5 min of idle).
  try { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters' -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue } catch { }
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
    // The name and password go over as base64 so any character (a leading "-", quotes, spaces) arrives unchanged.
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const r = await runPs([...PS, '-File', ps1, '-Mode', mode, ...(ssid ? ['-Ssid', b64(ssid), '-Pass', b64(pass)] : [])], timeout);
    return lastJson(r.out) || { ok: false, error: (r.err || r.out || 'no answer').trim().slice(0, 300) };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } }
}

const SAFE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rand = (n) => Array.from({ length: n }, () => SAFE[randomInt(SAFE.length)]).join('');

// Option 4: ask Windows once about this PC's Wi-Fi card (netsh wlan show drivers: instant, no .NET runtime).
// wifi = there is a Wi-Fi card at all. sig = a fingerprint of the driver report, which changes when the driver is
// updated or the card is swapped (works in any Windows language). The driver is also written to the log, so a
// client's crash can be tied to a driver version.
// ("Hosted network supported" in that report is NOT used: it is the old Windows 7 feature and says No on most
// laptops whose Mobile hotspot works fine.)
let hwCache = null;
function probeWifi() {
  if (!IS_WIN) return Promise.resolve({ wifi: true, sig: '' });
  if (hwCache) return Promise.resolve(hwCache);
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'drivers'], { timeout: 6000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const out = String(stdout || '');
      const wifi = !/no wireless interface/i.test(out);
      const flat = out.replace(/\s+/g, ' ').trim();
      const sig = wifi && flat ? createHash('sha1').update(flat).digest('hex').slice(0, 16) : '';
      const pick = (k) => { const m = new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'im').exec(out); return m ? m[1].trim() : ''; };
      if (!wifi) log('No Wi-Fi interface detected on this machine');
      else log('wi-fi driver: ' + ([pick('Driver'), pick('Vendor'), pick('Version'), pick('Date')].filter(Boolean).join(' | ') || 'unknown') + ' [' + (sig || 'no report') + ']');
      hwCache = { wifi, sig };
      resolve(hwCache);
    });
  });
}

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
export function initHotspot({ get, save, logger, dir, onChange }) {
  if (logger) log = logger;
  if (typeof onChange === 'function') notify = onChange;
  cfgStore = { get, save };
  const c = get();
  // A name and password made once per laptop (not one shared by every booth).
  if (!c.ssid || !c.pass) { c.ssid = 'photobooth4u-' + rand(4); c.pass = rand(10); }
  c.on = false;   // it was switched off when the app last closed

  // Crash guard: the marker is still there, so the laptop (or the app) went down during the last start.
  let crashed = false;
  if (IS_WIN && dir) {
    markFile = join(dir, 'hotspot-starting');
    if (existsSync(markFile)) {
      crashed = true;
      clearMark();
      c.crashes = (c.crashes || 0) + 1;
      c.auto = false;   // never start by itself again after that
      log('the last hotspot start never finished (crash?) - count ' + c.crashes + ', auto-start switched off');
    }
  }
  save();

  if (IS_WIN) {
    probeWifi().then(({ wifi, sig }) => {
      // A different driver (updated, or another card) gets a fresh chance.
      if (c.unsafe && sig && c.unsafeSig && sig !== c.unsafeSig) {
        c.unsafe = false; c.unsafeSig = ''; c.crashes = 0; save();
        log('Wi-Fi driver changed - hotspot crash lock cleared');
      }
      if (!c.unsafe && (c.crashes || 0) >= 2) { c.unsafe = true; c.unsafeSig = sig; save(); }
      if (!wifi) {
        st.driverUnsupported = true;
        st.error = 'This laptop has no Wi-Fi adapter, so it can\u2019t make the booth Wi-Fi. Connect it to a pocket Wi-Fi router instead.';
      } else if (c.unsafe) {
        st.driverUnsupported = true;
        st.error = CRASH_LOCK;
        log('hotspot locked: this laptop went down twice while starting it');
      } else if (crashed) {
        st.error = CRASH_WARN;
      } else if (c.auto) {
        // Option 1: start once at launch, then stay idle until a photo session wakes it.
        hotspotStart().catch(() => {});
      }
      ping();
    }).catch(() => {});
  }

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
    on: (IS_WIN || IS_MAC) && hotspotUp(), wanted: !!c.on, busy: st.busy, error: st.error, needsSetup: st.needsSetup,
    // Windows applies the name and password itself, so the operator can choose them. On a Mac, Internet Sharing keeps
    // its own name and password (System Settings → Sharing → Wi-Fi Options), so the app doesn't know the real ones.
    canCustom: IS_WIN, external: IS_MAC, driverUnsupported: !!st.driverUnsupported
  };
}

// A booth Wi-Fi name (1–32 characters) and password (8–63 characters): plain keyboard characters only, so every phone
// reads the Join QR the same way. Returns '' when fine, else the message to show.
export function checkCreds(ssid, pass) {
  const plain = /^[\x20-\x7e]+$/;
  if (!ssid) return 'Type a Wi-Fi name.';
  if (ssid.length > 32) return 'The Wi-Fi name can be 32 characters at most.';
  if (!plain.test(ssid)) return 'Use only letters, numbers and keyboard symbols in the Wi-Fi name.';
  if (pass.length < 8) return 'The password needs at least 8 characters.';
  if (pass.length > 63) return 'The password can be 63 characters at most.';
  if (!plain.test(pass)) return 'Use only letters, numbers and keyboard symbols in the password.';
  return '';
}

// Saves the operator's own booth Wi-Fi name and password. When the hotspot is on, it restarts with the new ones.
export async function hotspotSetCreds(ssidIn, passIn) {
  if (!IS_WIN) return { ok: false, error: 'This laptop sets its own Wi-Fi name in System Settings → Sharing.', info: hotspotInfo() };
  const ssid = String(ssidIn == null ? '' : ssidIn).trim();
  const pass = String(passIn == null ? '' : passIn);
  const bad = checkCreds(ssid, pass);
  if (bad) return { ok: false, error: bad, info: hotspotInfo() };
  if (st.busy) return { ok: false, error: 'The Wi-Fi is busy. Try again in a few seconds.', info: hotspotInfo() };
  const c = cfgStore.get();
  const changed = c.ssid !== ssid || c.pass !== pass;
  c.ssid = ssid; c.pass = pass; cfgStore.save();
  if (changed && (c.on || hotspotUp())) await hotspotStart();   // stops, reconfigures and starts it again with the new name
  const info = hotspotInfo();
  return { ok: !info.error, error: info.error || '', info };
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
  // Option 4: bail immediately if this laptop can't host - no PowerShell spawn.
  if (IS_WIN && st.driverUnsupported) return hotspotInfo();
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
    markStart();
    const r = await tether('start', c.ssid, c.pass, 70000);
    if (r.ok) {
      st.started = true; st.fails = 0; log('on: ' + c.ssid);
      if (c.crashes) { c.crashes = 0; cfgStore.save(); }
    }
    else {
      const x = explain(r.error);
      st.error = x.text; st.needsSetup = x.needsSetup; st.fails++;
      c.on = false; cfgStore.save();
      log('start failed: ' + r.error);
      // Option 4: only "this card can't host" locks the toggle. Other failures (Wi-Fi switched off, set-up needed,
      // a time-out) leave it usable, so the operator can fix the cause and try again; after two of them the app
      // stops trying by itself (see hotspotWake and keepAlive).
      if (/NotSupported|0x80004002|No such interface/i.test(String(r.error || ''))) {
        st.driverUnsupported = true;
        log('this Wi-Fi card can\u2019t host - hotspot switched off for this run');
      }
    }
  } finally { clearMark(); st.busy = false; ping(); }
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
  finally { st.busy = false; ping(); }
  return hotspotInfo();
}

// Sleep: a Wi-Fi card that is still hosting when the laptop sleeps is a common cause of driver crashes on wake.
// So the hotspot is stopped before sleep, and started again a little after wake when it was on. (Windows only: on
// a Mac, stopping needs the administrator prompt.)
let sleepWanted = false, sleepStop = null;
export function hotspotSuspend() {
  if (!IS_WIN) return;
  const c = cfgStore.get();
  if (!c.on) return;
  sleepWanted = true;
  log('laptop is going to sleep - stopping the hotspot');
  sleepStop = hotspotStop().catch(() => {});
}
let resumePending = false, resumeTimer = null;
// Starts the hotspot again after a sleep. Runs 12 s after wake, or at once when a guest starts a session sooner
// (hotspotWake), so a short session doesn't reach its QR before the booth Wi-Fi is back.
function resumeNow() {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (!resumePending) return;
  if (st.busy) { resumeTimer = setTimeout(resumeNow, 2000); return; }   // still stopping from before the sleep
  resumePending = false;
  const c = cfgStore.get();
  if (c.on || st.driverUnsupported) return;   // the operator already switched it on, or it is locked
  log('laptop woke up - starting the hotspot again');
  hotspotStart().catch(() => {});
}
export function hotspotResume() {
  if (!IS_WIN || !sleepWanted) return;
  sleepWanted = false;
  resumePending = true;
  const stopping = sleepStop; sleepStop = null;
  Promise.resolve(stopping).then(() => {
    if (resumePending && !resumeTimer) resumeTimer = setTimeout(resumeNow, 12000);   // let the Wi-Fi card settle first
  }).catch(() => {});
}

// Stop the hotspot when the app quits, without holding the quit up.
export function hotspotStopOnQuit() {
  if (keepTimer) { clearInterval(keepTimer); keepTimer = null; }
  if ((!IS_WIN && !IS_MAC) || !st.started) return;
  st.started = false;
  if (IS_MAC) {
    // On macOS, never trigger privileged AppleScripts (osascript with administrator privileges)
    // during app termination. Spawning an authorization prompt while the window and process
    // are being torn down triggers SIGABRT / __assert_rtn, and launchctl unload -w on
    // /System/Library is blocked by System Integrity Protection (SIP) on modern macOS anyway.
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
let lastUp = false;
function keepAlive() {
  if ((!IS_WIN && !IS_MAC) || keepTimer) return;
  keepTimer = setInterval(() => {
    const c = cfgStore.get();
    // Tell the page when the hotspot went on or off by itself (reading the network list costs nothing).
    const up = hotspotUp();
    if (up !== lastUp) { lastUp = up; ping(); }
    // Skip completely if not wanted, busy, locked, already up, or the fail cap is reached
    // (Option 4: stop hammering a broken driver).
    if (!c.on || st.busy || st.driverUnsupported || st.fails >= 2 || up) return;
    // IDLE RULE: never restart before the first photo session has happened.
    if (!hasSession) return;
    // IDLE RULE: go back to idle if no session for >20 minutes.
    if (Date.now() - lastSession > 20 * 60 * 1000) return;
    log('hotspot went off during active event - restarting');
    hotspotStart().catch(() => {});
  }, 60000);   // 60 s check (was 20 s)
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
  if (IS_WIN && st.driverUnsupported) return { ok: false, error: st.error || 'Wi-Fi adapter does not support hotspot.' };
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
