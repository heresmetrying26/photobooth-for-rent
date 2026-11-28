// The booth's own Wi-Fi (Windows & Mac): the laptop turns on its own hotspot itself, so guests' phones can join it
// with the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot at the booth.
//
// Windows: start / stop uses Windows Runtime NetworkOperatorTetheringManager. With no external Wi-Fi, `setup` adds
// Microsoft's loopback adapter once.
// Mac: `setup` adds an offline loopback service (BoothDummy) once with administrator privileges, unlocking macOS
// Internet Sharing to Wi-Fi without external internet, routing on bridge100.
import { tmpdir, platform, networkInterfaces, setPriority, constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { randomInt, createHash } from 'node:crypto';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
export const HOTSPOT_IP = '192.168.137.1';   // where Windows puts the laptop on its hotspot
export const TARGET_MAX_CLIENTS = 20;        // Windows WifiMaxPeers target (default OS cap is 8)
export const RECYCLE_COOLDOWN_MS = 180_000;  // never auto-clear more than once per 3 minutes (protects Wi-Fi drivers)
export const RECYCLE_MAX_PER_HOUR = 10;      // hard hourly circuit breaker so flaky drivers are never hammered
export const RECYCLE_IDLE_FULL_MS = 30_000;  // wait 30 s after last guest HTTP activity before clearing at cap
export const RECYCLE_IDLE_NEAR_MS = 120_000; // wait 2 min idle before proactively clearing at cap - 1 (only when cap <= 8)
export const RECYCLE_JOIN_GRACE_MS = 40_000; // never auto-clear within 40 s of a new phone joining
let log = (m) => console.log('[hotspot] ' + m);
let cfgStore = { get: () => ({}), save: () => {} };
const st = { busy: false, recycling: false, error: '', needsSetup: false, started: false, fails: 0,
  driverUnsupported: false, clients: 0, maxClients: 8, hwMaxClients: 0, regMaxClients: 0, venueWifi: '',
  lastClientJoinAt: 0, lastRecycleAt: 0, recycleCount: 0, recycleTimestamps: [], autoRecyclePaused: false,
  recycleBlockedByStation: false, activeDownloads: 0 };   // Option 4: set true when this laptop can't (or must not) host
let keepTimer = null;
let keepTick = 0;
let offlineCheck = () => true;
let trafficCheck = () => ({ activeTransfers: 0, lastGuestActivityAt: 0, stationOnHotspot: false });
// main.mjs passes this in: the page is told when the hotspot changes, so it does not have to keep asking.
let notify = () => {};
function ping() { try { notify(hotspotInfo()); } catch { /* ignore */ } }

// Parse `netsh wlan show wirelesscapabilities` for the hardware/driver P2P GO client cap.
// Returns the highest numeric `P2P Max Mobile AP Clients` found, or 0 if unavailable / localized.
export function parseHwMaxClients(output) {
  const txt = String(output || '');
  let best = 0;
  const re = /P2P\s+Max\s+Mobile\s+AP\s+Clients\s*:\s*(\d+)/gi;
  let m;
  while ((m = re.exec(txt))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > best && n <= 256) best = n;
  }
  return best;
}

// Effective simultaneous client ceiling before phones may start failing:
// if the Wi-Fi adapter advertises a lower hardware/driver cap (e.g. Intel AX201 reports 8)
// than Windows' software MaxClientCount (e.g. 20), watch the lower cap for smart idle-slot clearing.
export function computeEffectiveCap(maxClients, hwMaxClients) {
  const sw = Number(maxClients) > 0 ? Number(maxClients) : 8;
  const hw = Number(hwMaxClients) > 0 ? Number(hwMaxClients) : 0;
  return hw > 0 ? Math.min(sw, hw) : sw;
}

// Pure decision helper for automatic idle-phone slot clearing (unit-testable).
// Returns { shouldRecycle: boolean, reason: string, blockedByStation: boolean }.
export function evaluateAutoRecycle({
  enabled = true,
  paused = false,
  hadCrash = false,
  clients = 0,
  maxClients = 8,
  hwMaxClients = 0,
  activeTransfers = 0,
  lastGuestActivityAt = 0,
  lastClientJoinAt = 0,
  lastRecycleAt = 0,
  recyclesLastHour = 0,
  stationOnHotspot = false,
  now = Date.now()
} = {}) {
  const cap = computeEffectiveCap(maxClients, hwMaxClients);
  const allowNear = cap <= 8;
  const threshold = allowNear ? Math.max(1, cap - 1) : cap;
  if (!enabled || paused || hadCrash || clients <= 0) {
    return { shouldRecycle: false, reason: hadCrash ? 'crash-guard' : (paused ? 'paused' : 'disabled-or-empty'), blockedByStation: false };
  }
  if (clients < threshold) return { shouldRecycle: false, reason: 'below-threshold', blockedByStation: false };
  if (stationOnHotspot) return { shouldRecycle: false, reason: 'station-connected', blockedByStation: true };
  if (activeTransfers > 0) return { shouldRecycle: false, reason: 'active-transfer', blockedByStation: false };
  if (recyclesLastHour >= RECYCLE_MAX_PER_HOUR) {
    return { shouldRecycle: false, reason: 'hourly-limit', blockedByStation: false };
  }
  if (lastRecycleAt > 0 && now - lastRecycleAt < RECYCLE_COOLDOWN_MS) {
    return { shouldRecycle: false, reason: 'cooldown', blockedByStation: false };
  }
  if (lastClientJoinAt > 0 && now - lastClientJoinAt < RECYCLE_JOIN_GRACE_MS) {
    return { shouldRecycle: false, reason: 'recent-join', blockedByStation: false };
  }
  const idleMs = lastGuestActivityAt > 0 ? (now - lastGuestActivityAt) : Infinity;
  const isFull = clients >= cap;
  const needIdleMs = isFull ? RECYCLE_IDLE_FULL_MS : RECYCLE_IDLE_NEAR_MS;
  if (idleMs < needIdleMs) return { shouldRecycle: false, reason: 'recent-activity', blockedByStation: false };
  return { shouldRecycle: true, reason: isFull ? 'full-idle' : 'near-full-idle', blockedByStation: false };
}

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

// Called by main.mjs whenever a photo is saved to /local/drive, a Print Station job arrives,
// or the booth session tab is opened.  Wakes the hotspot if it went to sleep during idle.
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

// Marks Print Station / LAN activity without forcing a start when the operator never turned hotspot on.
export function hotspotTouch() {
  hasSession = true;
  lastSession = Date.now();
}

// ---------- the PowerShell that talks to Windows ----------
// (No backticks, ${ or backslashes in here: it is a raw template string.)
const TETHER_PS = String.raw`param([string]$Mode, [string]$Ssid, [string]$Pass, [switch]$PreferOffline)
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
  function GetVenueWifi {
    try {
      $wi = (& netsh wlan show interfaces 2>$null) -join [Environment]::NewLine
      if ($wi -match '(?m)^\s*State\s*:\s*connected\b' -and $wi -match '(?m)^\s*SSID\s*:\s*(.+?)\s*$') { return $Matches[1].Trim() }
    } catch { }
    return ''
  }
  function GetRegMax {
    try {
      $v = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings' -Name 'WifiMaxPeers' -ErrorAction SilentlyContinue).WifiMaxPeers
      if ($v -ne $null) { return [int]$v }
    } catch { }
    return 0
  }
  $script:usingLoopback = $false
  function GetMgr {
    $mgrType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]
    if ($PreferOffline) {
      try {
        # Pure in-process .NET lookup (~90 ms, zero WMI/CIM overhead on normal laptops)
        $lbIds = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.Name -eq 'photobooth4u Loopback' -or $_.Description -like '*KM-TEST Loopback*' } | ForEach-Object { ([string]$_.Id).Trim('{}').ToLowerInvariant() })
        if ($lbIds.Count -gt 0) {
          foreach ($q in [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles()) {
            try {
              $aid = ([string]$q.NetworkAdapter.NetworkAdapterId).Trim('{}').ToLowerInvariant()
              if ($lbIds -contains $aid) {
                $mgr = $mgrType::CreateFromConnectionProfile($q)
                $script:usingLoopback = $true
                return $mgr
              }
            } catch { }
          }
        }
      } catch { }
    }
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
    $mc = 8; try { $mc = [int]$m.MaxClientCount } catch { }
    Say @{ ok = $true; state = [string]$m.TetheringOperationalState; clients = [int]$m.ClientCount; maxClients = $mc; regMaxClients = (GetRegMax); venueWifi = (GetVenueWifi) }
  }
  elseif ($Mode -eq 'stop') {
    try {
      $m = GetMgr
      if ($m.TetheringOperationalState -eq 'On') { $null = AwaitOp ($m.StopTetheringAsync()) $opResult }
    } catch { }
    Say @{ ok = $true }
  }
  elseif ($Mode -eq 'recycle') {
    $m = GetMgr
    if ($m.TetheringOperationalState -eq 'On') {
      $null = AwaitOp ($m.StopTetheringAsync()) $opResult
      Start-Sleep -Milliseconds 2000
    }
    if ($Ssid -and $Pass) {
      $decSsid = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Ssid))
      $decPass = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Pass))
      $cfg = $m.GetCurrentAccessPointConfiguration()
      if ($cfg.Ssid -ne $decSsid -or $cfg.Passphrase -ne $decPass) {
        $cfg.Ssid = $decSsid
        $cfg.Passphrase = $decPass
        AwaitAct ($m.ConfigureAccessPointAsync($cfg))
      }
    }
    $r = AwaitOp ($m.StartTetheringAsync()) $opResult
    if ($r.Status -ne 'Success') {
      Start-Sleep -Milliseconds 1500
      $r = AwaitOp ($m.StartTetheringAsync()) $opResult
    }
    if ($r.Status -ne 'Success') { throw ('recycle-failed ' + $r.Status + ' ' + $r.AdditionalErrorMessage) }
    $mc = 8; try { $mc = [int]$m.MaxClientCount } catch { }
    Say @{ ok = $true; state = [string]$m.TetheringOperationalState; clients = [int]$m.ClientCount; maxClients = $mc; regMaxClients = (GetRegMax); venueWifi = (GetVenueWifi) }
  }
  elseif ($Mode -eq 'start') {
    $Ssid = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Ssid))
    $Pass = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Pass))
    $m = GetMgr
    $cfg = $m.GetCurrentAccessPointConfiguration()
    $same = ($cfg.Ssid -eq $Ssid -and $cfg.Passphrase -eq $Pass)
    $mc = 8; try { $mc = [int]$m.MaxClientCount } catch { }
    if ($m.TetheringOperationalState -eq 'On' -and $same) { Say @{ ok = $true; state = 'On'; already = $true; clients = [int]$m.ClientCount; maxClients = $mc; regMaxClients = (GetRegMax); venueWifi = (GetVenueWifi) }; exit 0 }
    if ($m.TetheringOperationalState -eq 'On') { $null = AwaitOp ($m.StopTetheringAsync()) $opResult }
    $cfg.Ssid = $Ssid
    $cfg.Passphrase = $Pass
    $band = 'TwoPointFourGigahertz'
    $vWifi = GetVenueWifi
    if (-not ($PreferOffline -and $script:usingLoopback -and -not $vWifi)) {
      try {
        $wi = (& netsh wlan show interfaces 2>$null) -join [Environment]::NewLine
        if (($wi -match 'State\s*:\s*connected' -and $wi -match 'Channel\s*:\s*(\d+)' -and [int]$Matches[1] -gt 14) -or ($wi -match ':\s*[56]\s*GHz')) { $band = 'Auto' }
      } catch { }
    }
    try { $cfg.Band = $band } catch { }
    AwaitAct ($m.ConfigureAccessPointAsync($cfg))
    $r = AwaitOp ($m.StartTetheringAsync()) $opResult
    if ($r.Status -ne 'Success') { throw ('start-failed ' + $r.Status + ' ' + $r.AdditionalErrorMessage) }
    Say @{ ok = $true; state = [string]$m.TetheringOperationalState; clients = [int]$m.ClientCount; maxClients = $mc; regMaxClients = (GetRegMax); venueWifi = $vWifi }
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
  try {
    Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $exe -or $_.Program -like '*photobooth4u*.exe' } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  } catch { }
  netsh advfirewall firewall delete rule name="photobooth4u hotspot guests" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u hotspot guests" dir=in action=allow program="$exe" enable=yes profile=any remoteip=192.168.137.0/24 | Out-Null
  netsh advfirewall firewall delete rule name="photobooth4u local booth" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u local booth" dir=in action=allow program="$exe" protocol=TCP localport=47777-47797 enable=yes profile=any remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 | Out-Null
  netsh advfirewall firewall delete rule name="photobooth4u local booth port" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u local booth port" dir=in action=allow protocol=TCP localport=47777-47797 enable=yes profile=any remoteip=192.168.137.0/24,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 | Out-Null
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
  # Disable Windows Mobile Hotspot idle auto-off AND raise default 8-phone cap to 20 (icssvc\Settings).
  try {
    $icsKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings'
    if (-not (Test-Path $icsKey)) { New-Item -Path $icsKey -Force | Out-Null }
    Set-ItemProperty -Path $icsKey -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    $curMax = 0
    try { $curMax = [int](Get-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -ErrorAction SilentlyContinue).WifiMaxPeers } catch { }
    if ($curMax -lt 20) {
      Set-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -Value 20 -Type DWord -ErrorAction SilentlyContinue
      $res.wifiMaxPeers = 20
      try {
        $svc = Get-Service -Name 'icssvc' -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name 'icssvc' -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1000 }
        Start-Service -Name 'icssvc' -ErrorAction SilentlyContinue
      } catch { }
    } else {
      $res.wifiMaxPeers = $curMax
    }
  } catch { }
  try { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters' -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue } catch { }
  $res.ok = $true
} catch { $res.error = [string]$_.Exception.Message }
($res | ConvertTo-Json -Compress) | Set-Content -Path $out -Encoding UTF8
`;

// Firewall-only elevated fix (Windows): removes any auto-created Inbound Block rules (which override Allow on Public/Hotspot
// profiles) and adds profile=any Allow rules for ports 47777-47797 + 192.168.137.0/24. Runs only when explicitly clicked.
const FIX_FIREWALL_PS = String.raw`$ErrorActionPreference = 'Stop'
$out = '@OUT@'
$exe = '@EXE@'
$res = @{ ok = $false; removedBlocks = 0; error = '' }
try {
  try {
    $blocks = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $exe -or $_.Program -like '*photobooth4u*.exe' } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' })
    foreach ($b in $blocks) {
      Remove-NetFirewallRule -Name $b.Name -ErrorAction SilentlyContinue
      $res.removedBlocks++
    }
  } catch { }
  netsh advfirewall firewall delete rule name="photobooth4u hotspot guests" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u hotspot guests" dir=in action=allow program="$exe" enable=yes profile=any remoteip=192.168.137.0/24 | Out-Null
  netsh advfirewall firewall delete rule name="photobooth4u local booth" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u local booth" dir=in action=allow program="$exe" protocol=TCP localport=47777-47797 enable=yes profile=any remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 | Out-Null
  netsh advfirewall firewall delete rule name="photobooth4u local booth port" | Out-Null
  netsh advfirewall firewall add rule name="photobooth4u local booth port" dir=in action=allow protocol=TCP localport=47777-47797 enable=yes profile=any remoteip=192.168.137.0/24,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12 | Out-Null
  try {
    $icsKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings'
    if (-not (Test-Path $icsKey)) { New-Item -Path $icsKey -Force | Out-Null }
    Set-ItemProperty -Path $icsKey -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue
    $curMax = 0
    try { $curMax = [int](Get-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -ErrorAction SilentlyContinue).WifiMaxPeers } catch { }
    if ($curMax -lt 20) {
      Set-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -Value 20 -Type DWord -ErrorAction SilentlyContinue
    }
  } catch { }
  try { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters' -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue } catch { }
  $res.ok = $true
} catch { $res.error = [string]$_.Exception.Message }
($res | ConvertTo-Json -Compress) | Set-Content -Path $out -Encoding UTF8
`;

// Elevated 1-time capacity boost (Windows): raises icssvc\Settings\WifiMaxPeers from default 8 to 20,
// disables PeerlessTimeoutEnabled in icssvc\Settings, and restarts icssvc so the higher cap applies immediately with no reboot.
const BOOST_LIMIT_PS = String.raw`$ErrorActionPreference = 'Stop'
$out = '@OUT@'
$target = [int]'@MAX@'
if ($target -lt 8) { $target = 8 }
if ($target -gt 32) { $target = 32 }
$res = @{ ok = $false; wifiMaxPeers = 0; serviceRestarted = $false; error = '' }
try {
  $icsKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings'
  if (-not (Test-Path $icsKey)) { New-Item -Path $icsKey -Force | Out-Null }
  Set-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -Value $target -Type DWord -ErrorAction Stop
  Set-ItemProperty -Path $icsKey -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue
  try { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters' -Name 'PeerlessTimeoutEnabled' -Value 0 -Type DWord -ErrorAction SilentlyContinue } catch { }
  try {
    $svc = Get-Service -Name 'icssvc' -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') {
      Stop-Service -Name 'icssvc' -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 1000
    }
    Start-Service -Name 'icssvc' -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    $res.serviceRestarted = $true
  } catch { }
  $readBack = 0
  try { $readBack = [int](Get-ItemProperty -Path $icsKey -Name 'WifiMaxPeers' -ErrorAction SilentlyContinue).WifiMaxPeers } catch { }
  $res.wifiMaxPeers = if ($readBack -gt 0) { $readBack } else { $target }
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
    // Lower priority so background PowerShell polls never preempt Electron UI, DSLR Live View, or printing on normal laptops.
    try { if (p && p.pid && osConstants && osConstants.priority) setPriority(p.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ }
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
async function tether(mode, ssid, pass, timeout, preferOffline = false) {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pb4u-hotspot-'));
    const ps1 = join(dir, 'hotspot.ps1');
    writeFileSync(ps1, '﻿' + TETHER_PS);
    // The name and password go over as base64 so any character (a leading "-", quotes, spaces) arrives unchanged.
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const r = await runPs([...PS, '-File', ps1, '-Mode', mode, ...(ssid ? ['-Ssid', b64(ssid), '-Pass', b64(pass)] : []), ...(preferOffline ? ['-PreferOffline'] : [])], timeout);
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
function readRegWifiMaxPeers() {
  if (!IS_WIN) return Promise.resolve(0);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\icssvc\\Settings', '/v', 'WifiMaxPeers'], { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      const m = /WifiMaxPeers\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout || ''));
      resolve(m ? parseInt(m[1], 16) : 0);
    });
  });
}
function probeWifi() {
  if (!IS_WIN) return Promise.resolve({ wifi: true, sig: '', hwMaxClients: 0, regMaxClients: 0 });
  if (hwCache) return Promise.resolve(hwCache);
  return new Promise((resolve) => {
    const pDrivers = new Promise((r) => execFile('netsh', ['wlan', 'show', 'drivers'], { timeout: 6000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => r(String(stdout || ''))));
    const pCaps = new Promise((r) => execFile('netsh', ['wlan', 'show', 'wirelesscapabilities'], { timeout: 6000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => r(String(stdout || ''))));
    Promise.all([pDrivers, pCaps, readRegWifiMaxPeers()]).then(([out, capsOut, regMax]) => {
      const wifi = !/no wireless interface/i.test(out);
      const flat = out.replace(/\s+/g, ' ').trim();
      const sig = wifi && flat ? createHash('sha1').update(flat).digest('hex').slice(0, 16) : '';
      const pick = (k) => { const m = new RegExp('^\\s*' + k + '\\s*:\\s*(.+)$', 'im').exec(out); return m ? m[1].trim() : ''; };
      const hwMaxClients = wifi ? parseHwMaxClients(capsOut) : 0;
      const regMaxClients = Number(regMax) || 0;
      if (!wifi) log('No Wi-Fi interface detected on this machine');
      else log('wi-fi driver: ' + ([pick('Driver'), pick('Vendor'), pick('Version'), pick('Date')].filter(Boolean).join(' | ') || 'unknown') + ' [' + (sig || 'no report') + ']' + (hwMaxClients ? ' hwMaxClients=' + hwMaxClients : '') + (regMaxClients ? ' regWifiMaxPeers=' + regMaxClients : ''));
      hwCache = { wifi, sig, hwMaxClients, regMaxClients };
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
export function initHotspot({ get, save, logger, dir, onChange, skipAuto, isOffline, getTraffic }) {
  if (logger) log = logger;
  if (typeof onChange === 'function') notify = onChange;
  if (typeof isOffline === 'function') offlineCheck = isOffline;
  if (typeof getTraffic === 'function') trafficCheck = getTraffic;
  cfgStore = { get, save };
  const c = get();
  // A name and password made once per laptop (not one shared by every booth).
  if (!c.ssid || !c.pass) { c.ssid = 'photobooth4u-' + rand(4); c.pass = rand(10); }
  if (typeof c.autoRecycle !== 'boolean') c.autoRecycle = true;   // smart crowd slot recycling ON by default
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
      c.autoRecycle = false;   // never auto-cycle a Wi-Fi driver that crashed
      log('the last hotspot start never finished (crash?) - count ' + c.crashes + ', auto-start & auto-clear switched off');
    }
  }
  save();

  if (IS_WIN) {
    probeWifi().then(({ wifi, sig, hwMaxClients, regMaxClients }) => {
      if (hwMaxClients > 0) st.hwMaxClients = hwMaxClients;
      if (regMaxClients > 0) {
        st.regMaxClients = regMaxClients;
        if (st.maxClients < regMaxClients) st.maxClients = regMaxClients;
      }
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
      } else if (c.auto && !skipAuto) {
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
  const up = (IS_WIN || IS_MAC) && hotspotUp();
  const maxClients = st.maxClients || 8;
  const hwMaxClients = st.hwMaxClients || 0;
  const regMaxClients = st.regMaxClients || 0;
  const effectiveMaxClients = computeEffectiveCap(maxClients, hwMaxClients);
  return {
    supported: IS_WIN || IS_MAC, ssid: c.ssid || '', pass: c.pass || '', auto: !!c.auto,
    on: up, wanted: !!c.on, busy: st.busy, recycling: !!st.recycling, error: st.error, needsSetup: st.needsSetup,
    clients: up ? (st.clients || 0) : 0, maxClients, hwMaxClients, regMaxClients, effectiveMaxClients,
    targetMaxClients: TARGET_MAX_CLIENTS,
    canBoostLimit: IS_WIN && !st.driverUnsupported && maxClients < TARGET_MAX_CLIENTS && regMaxClients < TARGET_MAX_CLIENTS,
    autoRecycle: c.autoRecycle !== false,
    lastRecycleAt: st.lastRecycleAt || 0,
    recycleCount: st.recycleCount || 0,
    recycleBlockedByStation: up ? !!st.recycleBlockedByStation : false,
    activeDownloads: up ? (st.activeDownloads || 0) : 0,
    venueWifi: up ? (st.venueWifi || '') : '',
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
    const preferOffline = !!(typeof offlineCheck === 'function' && offlineCheck());
    const r = await tether('start', c.ssid, c.pass, 70000, preferOffline);
    if (r.ok) {
      st.started = true; st.fails = 0;
      if (typeof r.clients === 'number') st.clients = r.clients;
      if (typeof r.maxClients === 'number' && r.maxClients > 0) st.maxClients = r.maxClients;
      if (typeof r.regMaxClients === 'number' && r.regMaxClients >= 0) st.regMaxClients = r.regMaxClients;
      st.venueWifi = typeof r.venueWifi === 'string' ? r.venueWifi : '';
      log('on: ' + c.ssid + ' (maxClients=' + st.maxClients + (st.hwMaxClients ? ', hwMax=' + st.hwMaxClients : '') + ')' + (st.venueWifi ? ' (warning: also connected to venue Wi-Fi "' + st.venueWifi + '")' : ''));
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

// Windows & Mac keepalive: if the hotspot goes off while wanted, start it again quickly (15 s),
// poll connected guest count + venue Wi-Fi conflicts (every 15 s under crowd load, else 30 s),
// and auto-clear stale idle phones when approaching capacity so guests never stall at 8+.
let lastUp = false;
let statusPolling = false;
function keepAlive() {
  if ((!IS_WIN && !IS_MAC) || keepTimer) return;
  keepTimer = setInterval(() => {
    const c = cfgStore.get();
    keepTick++;
    // Tell the page when the hotspot went on or off by itself (reading the network list costs nothing).
    const up = hotspotUp();
    if (up !== lastUp && !st.recycling) {
      lastUp = up;
      if (!up) { st.clients = 0; st.venueWifi = ''; st.recycleBlockedByStation = false; st.activeDownloads = 0; }
      ping();
    }
    if (!c.on || st.busy || st.driverUnsupported || st.fails >= 2) return;
    if (up) {
      const effectiveCap = computeEffectiveCap(st.maxClients, st.hwMaxClients);
      const nearCap = st.clients >= Math.max(1, effectiveCap - 1);
      const quietIdle = st.clients === 0 && (Date.now() - lastSession > 2 * 60 * 1000);
      // Calm CPU-friendly cadence: 60 s when idle with 0 phones, 30 s normally, 15 s only when nearly/at full capacity.
      const due = nearCap || (!quietIdle && (keepTick % 2 === 0)) || (quietIdle && (keepTick % 4 === 0));
      if (IS_WIN && !statusPolling && due) {
        statusPolling = true;
        const preferOffline = !!(typeof offlineCheck === 'function' && offlineCheck());
        tether('status', '', '', 12000, preferOffline).then((r) => {
          if (!r || !r.ok) return;
          const now = Date.now();
          const prevClients = st.clients;
          const nextClients = typeof r.clients === 'number' ? r.clients : st.clients;
          const nextMax = (typeof r.maxClients === 'number' && r.maxClients > 0) ? r.maxClients : st.maxClients;
          const nextReg = (typeof r.regMaxClients === 'number' && r.regMaxClients >= 0) ? r.regMaxClients : st.regMaxClients;
          const nextVenue = typeof r.venueWifi === 'string' ? r.venueWifi : st.venueWifi;
          if (nextClients > prevClients) st.lastClientJoinAt = now;
          if (nextClients === 0) st.lastClientJoinAt = 0;
          const traffic = (() => {
            try { return (typeof trafficCheck === 'function' && trafficCheck()) || {}; } catch { return {}; }
          })();
          const nextActiveDl = Number(traffic.activeTransfers) || 0;
          st.recycleTimestamps = (st.recycleTimestamps || []).filter((t) => now - t < 3600_000);
          const decision = evaluateAutoRecycle({
            enabled: c.autoRecycle !== false,
            paused: !!st.autoRecyclePaused,
            hadCrash: (c.crashes || 0) > 0 || !!c.unsafe,
            clients: nextClients,
            maxClients: nextMax,
            hwMaxClients: st.hwMaxClients,
            activeTransfers: nextActiveDl,
            lastGuestActivityAt: Number(traffic.lastGuestActivityAt) || 0,
            lastClientJoinAt: st.lastClientJoinAt,
            lastRecycleAt: st.lastRecycleAt,
            recyclesLastHour: st.recycleTimestamps.length,
            stationOnHotspot: !!traffic.stationOnHotspot,
            now
          });
          const changed = nextClients !== st.clients || nextMax !== st.maxClients || nextReg !== st.regMaxClients
            || nextVenue !== st.venueWifi || nextActiveDl !== st.activeDownloads
            || !!decision.blockedByStation !== !!st.recycleBlockedByStation;
          st.clients = nextClients;
          st.maxClients = nextMax;
          st.regMaxClients = nextReg;
          st.venueWifi = nextVenue;
          st.activeDownloads = nextActiveDl;
          st.recycleBlockedByStation = !!decision.blockedByStation;
          if (changed) ping();
          if (decision.shouldRecycle && !st.busy) {
            log('auto-clearing idle phones (' + nextClients + '/' + computeEffectiveCap(nextMax, st.hwMaxClients) + ', reason=' + decision.reason + ')');
            hotspotRecycle({ auto: true }).catch(() => {});
          }
        }).catch(() => {}).finally(() => { statusPolling = false; });
      }
      return;
    }
    // IDLE RULE: never restart before the first photo session or Print Station activity has happened.
    if (!hasSession) return;
    // IDLE RULE: keep hotspot alive through multi-hour events & dinner breaks (up to 4 hours since last session/print).
    if (Date.now() - lastSession > 4 * 60 * 60 * 1000) return;
    log('hotspot went off during active event - restarting');
    hotspotStart().catch(() => {});
  }, 15000);   // 15 s check for fast recovery from weak-venue-Wi-Fi drops
  if (keepTimer.unref) keepTimer.unref();
}

export function hotspotSetAuto(on) {
  const c = cfgStore.get();
  c.auto = !!on; cfgStore.save();
  return hotspotInfo();
}

export function hotspotSetAutoRecycle(on) {
  const c = cfgStore.get();
  c.autoRecycle = !!on; cfgStore.save();
  ping();
  return hotspotInfo();
}

// Quickly cycles the Windows Mobile Hotspot in a single WinRT session (~2-3 s) to drop lingering idle
// pocket phones while keeping the same SSID, password, IP (192.168.137.1), and Join QR code.
export async function hotspotRecycle({ auto = false } = {}) {
  if (!IS_WIN) return { ok: false, error: 'Clearing idle phones is only supported on Windows.', info: hotspotInfo() };
  if (st.driverUnsupported) return { ok: false, error: st.error || 'Wi-Fi adapter does not support hotspot.', info: hotspotInfo() };
  if (st.busy) return { ok: false, error: 'The Wi-Fi is busy. Try again in a moment.', info: hotspotInfo() };
  const c = cfgStore.get();
  if (!hotspotUp()) return { ok: false, error: 'The booth Wi-Fi is not running.', info: hotspotInfo() };
  // For manual clicks, briefly wait up to 4 s if a guest photo download is actively streaming.
  if (!auto) {
    for (let i = 0; i < 8; i++) {
      let tr = null;
      try { tr = typeof trafficCheck === 'function' ? trafficCheck() : null; } catch { tr = null; }
      if (!tr || !tr.activeTransfers) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const prevClients = st.clients || 0;
  st.busy = true;
  st.recycling = true;
  st.error = '';
  ping();
  let needFallbackStart = false;
  try {
    markStart();
    const preferOffline = !!(typeof offlineCheck === 'function' && offlineCheck());
    const r = await tether('recycle', c.ssid, c.pass, 45000, preferOffline);
    if (r && r.ok) {
      st.started = true;
      st.fails = 0;
      st.clients = typeof r.clients === 'number' ? r.clients : 0;
      if (typeof r.maxClients === 'number' && r.maxClients > 0) st.maxClients = r.maxClients;
      if (typeof r.regMaxClients === 'number' && r.regMaxClients >= 0) st.regMaxClients = r.regMaxClients;
      st.venueWifi = typeof r.venueWifi === 'string' ? r.venueWifi : st.venueWifi;
      st.lastRecycleAt = Date.now();
      st.recycleCount = (st.recycleCount || 0) + 1;
      if (auto) {
        st.recycleTimestamps = (st.recycleTimestamps || []).filter((t) => st.lastRecycleAt - t < 3600_000);
        st.recycleTimestamps.push(st.lastRecycleAt);
      } else {
        st.autoRecyclePaused = false;
      }
      st.lastClientJoinAt = 0;
      st.recycleBlockedByStation = false;
      log((auto ? 'auto-' : '') + 'cleared ' + prevClients + ' idle phone(s); back on (' + st.clients + '/' + st.maxClients + ')');
      return { ok: true, cleared: prevClients, info: hotspotInfo() };
    }
    if (auto) {
      st.autoRecyclePaused = true;
      log('auto-recycle paused for this run after driver error (' + String((r && r.error) || 'unknown') + ')');
    } else {
      log('recycle failed (' + String((r && r.error) || 'unknown') + ') - recovering with full start');
    }
    needFallbackStart = true;
  } catch (e) {
    if (auto) st.autoRecyclePaused = true;
    log('recycle threw (' + String(e && e.message || e) + ') - recovering with full start');
    needFallbackStart = true;
  } finally {
    clearMark();
    st.recycling = false;
    st.busy = false;
    ping();
  }
  if (needFallbackStart) {
    const info = await hotspotStart();
    if (info.on) {
      st.lastRecycleAt = Date.now();
      st.recycleCount = (st.recycleCount || 0) + 1;
      st.lastClientJoinAt = 0;
      st.recycleBlockedByStation = false;
      ping();
      return { ok: true, cleared: prevClients, info: hotspotInfo() };
    }
    return { ok: false, error: info.error || 'Could not restart booth Wi-Fi after clearing phones.', info };
  }
  return { ok: false, error: 'Could not clear idle phones.', info: hotspotInfo() };
}

// One-time elevated Windows boost: raises icssvc\Settings\WifiMaxPeers from 8 to 20 and restarts icssvc (no reboot needed).
export async function hotspotRaiseLimit(target = TARGET_MAX_CLIENTS) {
  if (!IS_WIN) return { ok: false, error: 'Raising the 8-phone limit is only needed on Windows.', info: hotspotInfo() };
  if (st.driverUnsupported) return { ok: false, error: st.error || 'Wi-Fi adapter does not support hotspot.', info: hotspotInfo() };
  if (st.busy) return { ok: false, error: 'The Wi-Fi is busy. Try again in a moment.', info: hotspotInfo() };
  const maxVal = Math.max(8, Math.min(32, Math.floor(Number(target) || TARGET_MAX_CLIENTS)));
  const c = cfgStore.get();
  const wasUp = hotspotUp() || !!c.on;
  st.busy = true;
  st.error = '';
  ping();
  let dir = '';
  let boosted = false;
  let boostErr = '';
  try {
    // Gracefully stop the virtual SoftAP before restarting icssvc so fragile Wi-Fi drivers are never shocked mid-broadcast.
    if (hotspotUp()) {
      try {
        await tether('stop', '', '', 20000);
        await new Promise((r) => setTimeout(r, 1500));
      } catch { /* proceed */ }
    }
    dir = mkdtempSync(join(tmpdir(), 'pb4u-boost-'));
    const outFile = join(dir, 'boost.json');
    const q = (s) => String(s).replace(/'/g, "''");
    const script = BOOST_LIMIT_PS
      .replace('@OUT@', () => q(outFile))
      .replace('@MAX@', () => String(maxVal));
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const cmd = "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + enc + "'";
    const r = await runPs([...PS, '-Command', cmd], 90000);
    let res = null;
    try { res = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* not written */ }
    if (!res) {
      const declined = /canceled by the user|cancelled/i.test(r.err || '');
      boostErr = declined ? 'Cancelled. Click Allow up to 20 phones again and choose Yes when Windows asks.' : 'Could not update Windows hotspot limit (' + String(r.err || 'no answer').trim().slice(0, 120) + ').';
    } else if (!res.ok) {
      boostErr = 'Could not update Windows hotspot limit: ' + String(res.error || '').slice(0, 140);
    } else {
      st.regMaxClients = Number(res.wifiMaxPeers) || maxVal;
      hwCache = null;   // refresh cached regMaxClients on next probe
      boosted = true;
      log('raised Windows WifiMaxPeers to ' + st.regMaxClients + ' (serviceRestarted=' + !!res.serviceRestarted + ')');
    }
  } catch (e) {
    boostErr = 'Could not update Windows hotspot limit: ' + String(e && e.message || e).slice(0, 140);
  } finally {
    st.busy = false;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    ping();
  }
  if (!boosted) return { ok: false, error: boostErr || 'Could not raise phone limit.', info: hotspotInfo() };
  if (wasUp) {
    const prevFails = st.fails;
    const info = await hotspotStart();
    if (!info.on) {
      st.fails = prevFails;   // never lock the hotspot after a 1-time limit boost attempt
      return { ok: false, error: info.error || 'Limit updated, but hotspot needs to be turned back on.', info: hotspotInfo() };
    }
    return { ok: true, wifiMaxPeers: st.regMaxClients, maxClients: st.maxClients, hwMaxClients: st.hwMaxClients, info };
  }
  try {
    const preferOffline = !!(typeof offlineCheck === 'function' && offlineCheck());
    const sr = await tether('status', '', '', 12000, preferOffline);
    if (sr && sr.ok && typeof sr.maxClients === 'number' && sr.maxClients > 0) st.maxClients = sr.maxClients;
  } catch { /* ignore */ }
  ping();
  return { ok: true, wifiMaxPeers: st.regMaxClients, maxClients: st.maxClients, hwMaxClients: st.hwMaxClients, info: hotspotInfo() };
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
    try { res = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* not written */ }
    if (!res) {
      const declined = /canceled by the user|cancelled/i.test(r.err || '');
      st.error = declined ? 'Set-up was cancelled. Press the button again and choose Yes when Windows asks.' : 'Set-up didn’t finish (' + String(r.err || 'no answer').trim().slice(0, 120) + ').';
      return { ok: false, error: st.error };
    }
    if (!res.ok) { st.error = 'Set-up failed: ' + String(res.error || '').slice(0, 160); log('setup failed: ' + res.error); return { ok: false, error: st.error }; }
    st.needsSetup = false; st.fails = 0;
    if (Number(res.wifiMaxPeers) > 0) {
      st.regMaxClients = Number(res.wifiMaxPeers);
      if (st.maxClients < st.regMaxClients) st.maxClients = st.regMaxClients;
      hwCache = null;
    }
    log('setup done' + (st.regMaxClients ? ' (WifiMaxPeers=' + st.regMaxClients + ')' : ''));
    return { ok: true };
  } catch (e) {
    st.error = 'Set-up failed: ' + String(e && e.message || e).slice(0, 160);
    return { ok: false, error: st.error };
  } finally {
    st.busy = false;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// On-demand elevated Windows Firewall repair for Offline Print Station / Hotspot (Public profile).
export async function hotspotFixFirewall() {
  if (!IS_WIN) return { ok: false, error: 'Firewall repair is only needed on Windows.' };
  if (st.busy) return { ok: false, error: 'Busy. Try again in a moment.' };
  st.busy = true;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'pb4u-fw-'));
    const outFile = join(dir, 'fw.json');
    const q = (s) => String(s).replace(/'/g, "''");
    const script = FIX_FIREWALL_PS.replace('@OUT@', () => q(outFile)).replace('@EXE@', () => q(process.execPath));
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const cmd = "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + enc + "'";
    const r = await runPs([...PS, '-Command', cmd], 90000);
    let res = null;
    try { res = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* not written */ }
    if (!res) {
      const declined = /canceled by the user|cancelled/i.test(r.err || '');
      return { ok: false, error: declined ? 'Cancelled. Click Fix Firewall again and choose Yes when Windows asks.' : 'Firewall update didn’t finish.' };
    }
    if (!res.ok) return { ok: false, error: 'Firewall update failed: ' + String(res.error || '').slice(0, 140) };
    log('firewall repaired (removedBlocks=' + (res.removedBlocks || 0) + ')');
    return { ok: true, removedBlocks: Number(res.removedBlocks) || 0 };
  } catch (e) {
    return { ok: false, error: 'Firewall update failed: ' + String(e && e.message || e).slice(0, 140) };
  } finally {
    st.busy = false;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
