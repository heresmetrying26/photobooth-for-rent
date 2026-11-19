# Tests the Windows camera worker's "what does Windows have on USB" check (UsbScan / Worker.UsbHint).
# Run with Windows PowerShell, the same one the app uses:
#   powershell -ExecutionPolicy Bypass -File tools\print-helper\test-camera-worker.ps1
# 1) compiles the worker's C# exactly as camera-worker.ps1 does, 2) reads this laptop's real USB list,
# 3) feeds made-up devices through Open() and checks the message the booth would show.
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'camera-worker.ps1')
$m = [regex]::Match($src, "(?s)\`$cs = @'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL could not find the C# part of camera-worker.ps1'; exit 1 }
Add-Type -TypeDefinition $m.Groups[1].Value -Language CSharp

$fails = 0
function Check([string]$name, [bool]$ok, [string]$got) {
    if ($ok) { Write-Output "ok   $name" } else { Write-Output "FAIL $name`n     got: $got"; $script:fails++ }
}
function Dev([string]$maker, [string]$id, [string]$name, [string]$class, [string]$svc, [bool]$ptp, [uint32]$status, [uint32]$problem) {
    $d = New-Object Pb4uCam.UsbDev
    $d.Maker = $maker; $d.Id = $id; $d.Name = $name; $d.Class = $class; $d.Service = $svc; $d.Ptp = $ptp
    $d.Status = $status; $d.Problem = $problem
    if ($id -match '^USB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})') { $d.VidPid = $Matches[1].ToLowerInvariant() }
    return $d
}
function Set-Usb([object[]]$devs) {
    $l = New-Object 'System.Collections.Generic.List[Pb4uCam.UsbDev]'
    foreach ($d in $devs) { if ($d) { $l.Add($d) } }
    [Pb4uCam.Worker]::UsbDevs = [Func[System.Collections.Generic.List[Pb4uCam.UsbDev]]]{ return , $l }.GetNewClosure()
}
function Set-Wpd([object[]]$devs) {
    $l = New-Object 'System.Collections.Generic.List[Pb4uCam.DevInfo]'
    foreach ($d in $devs) { if ($d) { $l.Add($d) } }
    [Pb4uCam.Worker]::ListDevs = [Func[System.Collections.Generic.List[Pb4uCam.DevInfo]]]{ return , $l }.GetNewClosure()
}
$open = [Pb4uCam.Worker].GetMethod('Open', [Reflection.BindingFlags]'NonPublic,Static')
function Open-Message {
    try { [void]$open.Invoke($null, $null); return 'OPENED' }
    catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; return $e.Message }
}

function Set-Apps([string[]]$names) {
    $l = New-Object 'System.Collections.Generic.List[string]'
    foreach ($n in $names) { $l.Add($n) }
    [Pb4uCam.Worker]::OpenApps = [Func[System.Collections.Generic.List[string]]]{ return , $l }.GetNewClosure()
}

$STARTED = [Pb4uCam.UsbScan]::DN_STARTED
$PROBLEM = [Pb4uCam.UsbScan]::DN_HAS_PROBLEM
$CANON = 'USB\VID_04A9&PID_32B4\0123456789'
$PLAIN = 'NOCAMERA No camera found. Plug the camera into this laptop with a data USB cable and switch it on.'

# --- 1. the real USB list on this laptop (checks the Windows calls themselves) ---
$all = [Pb4uCam.UsbScan]::Devices($false)
Write-Output ("This laptop's USB devices: " + $all.Count)
foreach ($u in $all) { Write-Output ("     " + $u.Id + "  '" + $u.Name + "'  class=" + $u.Class + " driver=" + $u.Service + " started=" + (($u.Status -band $STARTED) -ne 0) + " problem=" + $u.Problem + " ptp=" + $u.Ptp) }
Check 'real scan lists USB devices' ($all.Count -gt 0) $all.Count
Check 'real scan reads names and device types' (@($all | Where-Object { $_.Name -ne '' -and $_.Class -ne '' }).Count -gt 0) ''
Check 'real scan sees started devices' (@($all | Where-Object { ($_.Status -band $STARTED) -ne 0 }).Count -gt 0) ''
Check 'real scan fills vid/pid' (@($all | Where-Object { $_.VidPid -match '^vid_[0-9a-f]{4}&pid_[0-9a-f]{4}$' }).Count -eq $all.Count) ''
$makers = [Pb4uCam.UsbScan]::Devices($true)
Check 'camera-maker scan keeps only camera makers' (@($makers | Where-Object { -not [Pb4uCam.UsbScan]::MAKERS.ContainsKey($_.Id.Substring(8, 4).ToUpperInvariant()) }).Count -eq 0) ''

# The real open-programs scan: run a harmless program (a copy of ping.exe) under the name EOS Utility 3.exe and see it found.
$fakeDir = Join-Path ([IO.Path]::GetTempPath()) ('pb4u-apps-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fakeDir | Out-Null
$fakeApp = $null
try {
    Copy-Item (Join-Path $env:SystemRoot 'System32\PING.EXE') (Join-Path $fakeDir 'EOS Utility 3.exe')
    $fakeApp = Start-Process -FilePath (Join-Path $fakeDir 'EOS Utility 3.exe') -ArgumentList '-n', '8', '127.0.0.1' -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 700
    $busy = [Pb4uCam.UsbScan]::BusyApps()
    Check 'real open-programs scan finds EOS Utility' ($busy.Contains('EOS Utility')) ($busy -join ', ')
    Check 'real open-programs scan lists each program once' (@($busy | Select-Object -Unique).Count -eq $busy.Count) ($busy -join ', ')
} finally {
    if ($fakeApp) { try { $fakeApp.Kill() } catch { } }
    Remove-Item -Recurse -Force $fakeDir -ErrorAction SilentlyContinue
}

# --- 2. messages, through Open() with Windows' camera list empty (the client's case) ---
Set-Wpd @()
Set-Apps @()

Set-Usb @()
$msg = Open-Message
Check 'nothing on USB: the old message' ($msg -eq $PLAIN) $msg

Set-Usb @(Dev 'Canon' $CANON 'MTP USB Device' 'WPD' 'WUDFWpdMtp' $true ($PROBLEM) 10)
$msg = Open-Message
Check 'Canon, driver did not start: DRIVER code' ($msg.StartsWith('DRIVER Windows sees the Canon camera on USB ("MTP USB Device"), but its camera driver didn''t start (code 10)')) $msg
Check 'Canon: Wi-Fi/NFC and EOS Utility advice' ($msg -match 'Wi-Fi/NFC to Disable' -and $msg -match 'close EOS Utility') $msg
Check 'Canon: Device Manager step names the device' ($msg -match 'right-click "MTP USB Device", choose Uninstall device') $msg
Check 'Canon: never says to plug it in first' (-not $msg.Contains('No camera found')) $msg
Check 'Canon: cable, no hub, battery tips' ($msg -match 'cable that came with the camera' -and $msg -match 'no hub' -and $msg -match 'charge the battery' -and $msg -match 'AC adapter') $msg
Check 'Canon: steps are numbered in order' ($msg -match '\(1\) .*Wi-Fi/NFC.*\(2\) .*cable.*\(3\) Close EOS Utility\. \(4\) Switch the camera off and on') $msg

Set-Apps @('EOS Utility')
$msg = Open-Message
Check 'one program open: it is named' ($msg -match '\(3\) Close EOS Utility \(it is open now and may be holding the camera\)\.') $msg
Check 'one program open: the old guess is gone' (-not ($msg -match '\(3\) Close EOS Utility\. ')) $msg

Set-Apps @('EOS Utility', 'Windows Photos', 'Lightroom')
$msg = Open-Message
Check 'three programs open: all named' ($msg -match '\(3\) Close EOS Utility, Windows Photos and Lightroom \(they are open now and may be holding the camera\)\.') $msg

Set-Apps @('Windows Photos', 'Lightroom')
$msg = Open-Message
Check 'two programs open: joined with and' ($msg -match '\(3\) Close Windows Photos and Lightroom \(they are open now') $msg

[Pb4uCam.Worker]::OpenApps = [Func[System.Collections.Generic.List[string]]]{ throw 'boom' }
$msg = Open-Message
Check 'open-programs check failing keeps the generic advice' ($msg -match '\(3\) Close EOS Utility\. ' -and $msg.StartsWith('DRIVER Windows sees the Canon camera')) $msg
Set-Apps @()

Set-Usb @(Dev 'Canon' $CANON 'Canon EOS 1300D' 'WPD' 'WUDFWpdMtp' $true ($STARTED) 0)
$msg = Open-Message
Check 'Canon started but missing from the camera list' ($msg -match "^DRIVER .*didn't add it to its list of cameras \(WPD, driver WUDFWpdMtp\)") $msg

Set-Usb @(Dev 'Canon' $CANON 'MTP USB Device' 'WPD' 'WUDFWpdMtp' $true 0 0)
$msg = Open-Message
Check 'Canon still being set up' ($msg -match '^DRIVER Windows is still setting up the Canon camera') $msg

Set-Usb @(Dev 'Canon' $CANON 'MTP USB Device' '' '' $true ($PROBLEM) 28)
$msg = Open-Message
Check 'no driver at all (code 28): Media Feature Pack' ($msg -match 'code 28' -and $msg -match 'Media Feature Pack') $msg

Set-Usb @(Dev 'Nikon' 'USB\VID_04B0&PID_0442\5' 'D5600' 'WPD' 'WUDFWpdMtp' $true ($PROBLEM) 22)
$msg = Open-Message
Check 'disabled in Device Manager (code 22)' ($msg -match 'Nikon camera' -and $msg -match 'choose Enable device') $msg

Set-Usb @(Dev 'Canon' $CANON 'Canon EOS 1300D' 'USBDevice' 'WinUSB' $true ($STARTED) 0)
$msg = Open-Message
Check 'WinUSB (Zadig): left to the direct USB part' ($msg -eq $PLAIN) $msg

Set-Usb @(Dev 'Sony' 'USB\VID_054C&PID_09CC\1' 'Wireless Controller' 'HIDClass' 'HidUsb' $false ($STARTED) 0)
$msg = Open-Message
Check 'Sony game pad (not PTP) is ignored' ($msg -eq $PLAIN) $msg

Set-Usb @(Dev '' 'USB\VID_0000&PID_0002\5&1' 'Unknown USB Device (Device Descriptor Request Failed)' 'USB' '' $false ($PROBLEM) 43)
$msg = Open-Message
Check 'unreadable USB device: cable / port advice' ($msg -match "^NOCAMERA Windows heard a USB device but couldn't read it" -and $msg -match 'another data USB cable') $msg

Set-Usb @(
    (Dev '' 'USB\VID_0000&PID_0002\5&1' 'Unknown USB Device (Device Descriptor Request Failed)' 'USB' '' $false ($PROBLEM) 43),
    (Dev 'Canon' $CANON 'MTP USB Device' 'WPD' 'WUDFWpdMtp' $true ($PROBLEM) 10))
$msg = Open-Message
Check 'a camera beats an unreadable device' ($msg -match '^DRIVER Windows sees the Canon camera') $msg

[Pb4uCam.Worker]::UsbDevs = [Func[System.Collections.Generic.List[Pb4uCam.UsbDev]]]{ throw 'boom' }
$msg = Open-Message
Check 'USB check failing keeps the old message' ($msg -eq $PLAIN) $msg

# --- 3. Windows' camera list held something else (a phone) that didn't open ---
$phone = New-Object Pb4uCam.DevInfo
$phone.Id = '\\?\usb#vid_04e8&pid_6860#r58m#{6ac27878-a6fa-4155-ba85-f98f491d4f33}'; $phone.Name = 'Galaxy A52'; $phone.Maker = 'Samsung'
Set-Wpd @($phone)
Set-Usb @(Dev 'Canon' $CANON 'MTP USB Device' 'WPD' 'WUDFWpdMtp' $true ($PROBLEM) 10)
$msg = Open-Message
Check 'phone listed, Canon broken: Canon message' ($msg -match '^DRIVER Windows sees the Canon camera') $msg

# --- 4. a camera that IS in Windows' camera list is left to the existing messages ---
$listed = New-Object 'System.Collections.Generic.List[Pb4uCam.DevInfo]'
$c = New-Object Pb4uCam.DevInfo
$c.Id = '\\?\usb#vid_04a9&pid_32b4#0123456789#{6ac27878-a6fa-4155-ba85-f98f491d4f33}'; $c.Name = 'Canon EOS 1300D'; $c.Maker = 'Canon'
$listed.Add($c)
$hint = [Pb4uCam.Worker]::UsbHint($listed)
Check 'camera already in the list: no USB hint' ($null -eq $hint) $hint

if ($fails -eq 0) { Write-Output 'PASS'; exit 0 } else { Write-Output "FAIL ($fails)"; exit 1 }
