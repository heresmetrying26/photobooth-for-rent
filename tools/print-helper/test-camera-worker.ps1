# Tests the Windows camera worker's "what does Windows have on USB" check (UsbScan / Worker.UsbHint).
# Run with Windows PowerShell, the same one the app uses:
#   powershell -ExecutionPolicy Bypass -File tools\print-helper\test-camera-worker.ps1
# 1) compiles the worker's C# exactly as camera-worker.ps1 does, 2) reads this laptop's real USB list,
# 3) feeds made-up devices through Open() and checks the message the booth would show.
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'camera-worker.ps1')
$m = [regex]::Match($src, "(?s)\`$cs = @'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL could not find the C# part of camera-worker.ps1'; exit 1 }
# A made-up Nikon for section 5. It has to be compiled together with the worker (Add-Type's in-memory code cannot be referenced later).
$fakeSrc = @'
namespace PbTest
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    public class FakePtp : Pb4uCam.Ptp
    {
        public Dictionary<ushort, ushort> Type = new Dictionary<ushort, ushort>();   // property -> PTP data type (4 = 16 bit, 6 = 32 bit)
        public Dictionary<ushort, uint> Cur = new Dictionary<ushort, uint>();
        public Dictionary<ushort, byte> GetSet = new Dictionary<ushort, byte>();     // 1 = the camera lets it be changed now
        public Dictionary<ushort, uint[]> Choices = new Dictionary<ushort, uint[]>();
        public List<string> Writes = new List<string>();
        public bool Refuse;
        public override uint Op(ushort code, params uint[] ps) { return OK; }       // DeviceReady and friends
        void Put(MemoryStream m, ushort type, uint v) { m.WriteByte((byte)v); m.WriteByte((byte)(v >> 8)); if (type == 6) { m.WriteByte((byte)(v >> 16)); m.WriteByte((byte)(v >> 24)); } }
        public override uint OpRead(ushort code, out byte[] data, params uint[] ps)
        {
            data = new byte[0];
            if (code != 0x1014 || ps.Length < 1 || !Cur.ContainsKey((ushort)ps[0])) return 0x200A;   // DevicePropNotSupported
            ushort p = (ushort)ps[0], t = Type[p];
            var m = new MemoryStream();
            Put(m, 4, p); Put(m, 4, t); m.WriteByte(GetSet[p]);
            Put(m, t, Cur[p]); Put(m, t, Cur[p]);                                    // factory default, current
            m.WriteByte(2); Put(m, 4, (uint)Choices[p].Length);
            foreach (uint c in Choices[p]) Put(m, t, c);
            data = m.ToArray();
            return OK;
        }
        public override uint OpWrite(ushort code, byte[] data, params uint[] ps)
        {
            if (code != 0x1016) return OK;
            if (Refuse) return 0x2002;                                               // General Error
            uint v = data[0] | (uint)(data.Length > 1 ? data[1] << 8 : 0) | (uint)(data.Length > 2 ? data[2] << 16 : 0) | (uint)(data.Length > 3 ? data[3] << 24 : 0);
            Cur[(ushort)ps[0]] = v; Writes.Add(ps[0].ToString("X4") + "=" + v);
            return OK;
        }
    }
    // A made-up Canon EOS: answers the event poll (0x9116) with what the test queued, and takes setting writes (0x9110).
    public class FakeEos : Pb4uCam.Ptp
    {
        public List<string> Sets = new List<string>();
        public uint Refuse;          // answer to a "Save to" write (0 = accept it)
        public bool Silent;          // accept it but never announce the change
        public List<byte> Events = new List<byte>();
        static void U(List<byte> l, uint v) { l.Add((byte)v); l.Add((byte)(v >> 8)); l.Add((byte)(v >> 16)); l.Add((byte)(v >> 24)); }
        public void Changed(uint prop, uint val) { U(Events, 16); U(Events, 0xC189); U(Events, prop); U(Events, val); }
        public void Avail(uint prop, int es, params uint[] vals)
        {
            U(Events, (uint)(20 + vals.Length * es)); U(Events, 0xC18A); U(Events, prop); U(Events, es == 4 ? 6U : es == 2 ? 4U : 2U); U(Events, (uint)vals.Length);
            foreach (uint v in vals) { for (int k = 0; k < es; k++) Events.Add((byte)(v >> (8 * k))); }
        }
        public override uint Op(ushort code, params uint[] ps) { return OK; }
        public override uint OpRead(ushort code, out byte[] data, params uint[] ps)
        {
            data = new byte[0];
            if (code == 0x9116) { data = Events.ToArray(); Events.Clear(); }
            return OK;
        }
        public override uint OpWrite(ushort code, byte[] data, params uint[] ps)
        {
            if (code != 0x9110) return OK;
            uint prop = BitConverter.ToUInt32(data, 4), val = BitConverter.ToUInt32(data, 8);
            Sets.Add(prop.ToString("X4") + "=" + val);
            if (prop == 0xD11C && Refuse != 0) return Refuse;
            if (!Silent) Changed(prop, val);
            return OK;
        }
    }

    public class Fake360Ptp : Pb4uCam.Ptp
    {
        public bool IsCanon;
        public uint SaveTo = 4;
        public uint Av = 0x20, Tv = 0x68, Iso = 0x58, Wb = 0, MovieTarget = 0;
        public string RecMedia = "1", LvSel = "0";
        public bool LvOn = false;
        public bool Recording = false;
        public bool PendingMovie = false;
        public byte[] MovieData;
        public List<string> Log = new List<string>();

        static void PutU32(MemoryStream ms, uint v) {
            ms.WriteByte((byte)(v & 0xFF)); ms.WriteByte((byte)((v >> 8) & 0xFF));
            ms.WriteByte((byte)((v >> 16) & 0xFF)); ms.WriteByte((byte)((v >> 24) & 0xFF));
        }
        static void PutU16(MemoryStream ms, ushort v) {
            ms.WriteByte((byte)(v & 0xFF)); ms.WriteByte((byte)(v >> 8));
        }
        static byte[] AvailRec(ushort prop, params uint[] vals) {
            var ms = new MemoryStream();
            PutU32(ms, (uint)(20 + vals.Length * 4));
            PutU32(ms, 0xC18A);
            PutU32(ms, prop);
            PutU32(ms, 4);
            PutU32(ms, (uint)vals.Length);
            foreach (uint v in vals) PutU32(ms, v);
            return ms.ToArray();
        }
        static byte[] ValRec(ushort prop, uint val) {
            var ms = new MemoryStream();
            PutU32(ms, 16); PutU32(ms, 0xC189); PutU32(ms, prop); PutU32(ms, val);
            return ms.ToArray();
        }
        public override uint Op(ushort code, params uint[] ps) {
            Log.Add("OP:" + code.ToString("X4"));
            if (!IsCanon) {
                if (code == 0x90C8) return OK;
                if (code == 0x9201) { LvOn = true; return OK; }
                if (code == 0x9202) { LvOn = false; return OK; }
                if (code == 0x920A) { Recording = true; return OK; }
                if (code == 0x920B) { Recording = false; PendingMovie = true; return OK; }
            } else {
                if (code == 0x911A || code == 0x9115 || code == 0x9114 || code == 0x911D) return OK;
            }
            return OK;
        }
        public override uint OpWrite(ushort code, byte[] data, params uint[] ps) {
            if (IsCanon && code == 0x9110 && data != null && data.Length >= 12) {
                ushort prop = (ushort)(data[4] | (data[5] << 8));
                uint val = (uint)(data[8] | (data[9] << 8) | (data[10] << 16) | (data[11] << 24));
                Log.Add("EOS:" + prop.ToString("X4") + "=" + val);
                if (prop == 0xD11C) SaveTo = val;
                else if (prop == 0xD101) Av = val;
                else if (prop == 0xD102) Tv = val;
                else if (prop == 0xD103) Iso = val;
                else if (prop == 0xD109) Wb = val;
                else if (prop == 0xD1B8) {
                    MovieTarget = val;
                    if (val == 4) Recording = true;
                    else if (val == 0) { Recording = false; PendingMovie = true; }
                }
                return OK;
            }
            if (!IsCanon && code == 0x1016 && ps.Length > 0 && data != null && data.Length > 0) {
                ushort p = (ushort)ps[0];
                string val = data[0].ToString();
                Log.Add("NIK:" + p.ToString("X4") + "=" + val);
                if (p == 0xD10B) RecMedia = val;
                else if (p == 0xD1A6) LvSel = val;
                return OK;
            }
            return OK;
        }
        public override uint OpRead(ushort code, out byte[] data, params uint[] ps) {
            data = new byte[0];
            if (IsCanon && code == 0x9116) {
                var ms = new MemoryStream();
                byte[] b;
                b = ValRec(0xD11C, SaveTo); ms.Write(b, 0, b.Length);
                b = ValRec(0xD11B, 999); ms.Write(b, 0, b.Length);
                b = ValRec(0xD105, 3); ms.Write(b, 0, b.Length);
                b = ValRec(0xD101, Av); ms.Write(b, 0, b.Length);
                b = ValRec(0xD102, Tv); ms.Write(b, 0, b.Length);
                b = ValRec(0xD103, Iso); ms.Write(b, 0, b.Length);
                b = ValRec(0xD109, Wb); ms.Write(b, 0, b.Length);
                b = AvailRec(0xD11C, 2, 4); ms.Write(b, 0, b.Length);
                b = AvailRec(0xD101, 0x20, 0x28); ms.Write(b, 0, b.Length);
                b = AvailRec(0xD102, 0x68, 0x70, 0x78); ms.Write(b, 0, b.Length);
                b = AvailRec(0xD103, 0x58, 0x60, 0x63); ms.Write(b, 0, b.Length);
                b = AvailRec(0xD109, 0, 1, 2); ms.Write(b, 0, b.Length);
                if (PendingMovie) {
                    PendingMovie = false;
                    var ev = new MemoryStream();
                    PutU32(ev, 32); PutU32(ev, 0xC181); PutU32(ev, 0x55550001);
                    PutU32(ev, 0); PutU16(ev, 0x300D); PutU16(ev, 0);
                    PutU32(ev, 0); PutU32(ev, 0); PutU32(ev, (uint)MovieData.Length);
                    byte[] evb = ev.ToArray();
                    ms.Write(evb, 0, evb.Length);
                }
                data = ms.ToArray();
                return OK;
            }
            if (!IsCanon && code == 0x90C7) {
                var ms = new MemoryStream();
                if (PendingMovie) {
                    PendingMovie = false;
                    PutU16(ms, 1); PutU16(ms, 0x4002); PutU32(ms, 0x77770001);
                } else {
                    PutU16(ms, 0);
                }
                data = ms.ToArray();
                return OK;
            }
            if (!IsCanon && code == 0x1014 && ps.Length > 0) {
                ushort p = (ushort)ps[0];
                string cur = p == 0xD10B ? RecMedia : LvSel;
                uint[] ch = new uint[] { 0, 1 };
                var ms = new MemoryStream();
                PutU16(ms, p); PutU16(ms, 2); ms.WriteByte(1);
                ms.WriteByte(0); ms.WriteByte(byte.Parse(cur));
                ms.WriteByte(2); PutU16(ms, (ushort)ch.Length);
                foreach (uint c in ch) ms.WriteByte((byte)c);
                data = ms.ToArray();
                return OK;
            }
            if (code == 0x1008) {
                string name = IsCanon ? "MVI_0001.MOV" : "DSC_0001.MOV";
                byte[] nb = System.Text.Encoding.Unicode.GetBytes(name + "\0");
                var ms = new MemoryStream();
                PutU32(ms, 1); PutU16(ms, 0x300D); PutU16(ms, 0); PutU32(ms, (uint)MovieData.Length);
                for (int k = 0; k < 40; k++) ms.WriteByte(0);
                ms.WriteByte((byte)(name.Length + 1));
                ms.Write(nb, 0, nb.Length);
                data = ms.ToArray();
                return OK;
            }
            if (code == 0x101B && ps.Length >= 3) {
                int off = (int)ps[1], len = Math.Min((int)ps[2], MovieData.Length - off);
                if (len > 0) { data = new byte[len]; Buffer.BlockCopy(MovieData, off, data, 0, len); }
                return OK;
            }
            return OK;
        }
    }
}
'@
Add-Type -TypeDefinition ($m.Groups[1].Value + "`r`n" + $fakeSrc) -Language CSharp

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

# --- 5. exposure settings the booth's Camera check reads and sets (props / setprops), with a made-up Nikon ---
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$W = [Pb4uCam.Worker]
$expo = $W.GetMethod('ExposureJson', $flags)
$setx = $W.GetMethod('SetExposure', $flags)
function New-Fake([bool]$nikon, [int]$program, [byte]$shutterSet) {
    $f = New-Object PbTest.FakePtp
    $f.Type[0x500E] = 4; $f.Cur[0x500E] = $program; $f.GetSet[0x500E] = 0; $f.Choices[0x500E] = [uint32[]]@(1, 2, 3, 4)
    $f.Type[0x500D] = 6; $f.Cur[0x500D] = 100; $f.GetSet[0x500D] = $shutterSet                        # 1/100 s, in 0.0001 s
    $f.Choices[0x500D] = [uint32[]]@(30000, 1250, 400, 100, 80, 63, 50, 40, 4294967295)               # ..., 1/100, 1/125, 1/160, 1/200, 1/250, bulb
    $f.Type[0x5007] = 4; $f.Cur[0x5007] = 280; $f.GetSet[0x5007] = 1; $f.Choices[0x5007] = [uint32[]]@(280, 400, 560, 800)   # f/2.8 ...
    $f.Type[0x500F] = 4; $f.Cur[0x500F] = 1250; $f.GetSet[0x500F] = 1; $f.Choices[0x500F] = [uint32[]]@(100, 200, 400, 800, 1250, 1600, 51200)
    $W.GetField('ptp', $flags).SetValue($null, $f)
    $W.GetField('nikon', $flags).SetValue($null, $nikon)
    return $f
}
function Json($s) { return ($s | ConvertFrom-Json) }

$f = New-Fake $true 1 1
$j = Json ($expo.Invoke($null, $null))
Check 'props: a Nikon in manual reports its settings' ($j.supported -and $j.program -eq 1 -and $j.shutter -eq 0.01 -and $j.f -eq 2.8 -and $j.iso -eq 1250) ($j | ConvertTo-Json -Compress)
Check 'props: all three can be changed in manual' ($j.set.shutter -and $j.set.f -and $j.set.iso) ($j | ConvertTo-Json -Compress)

$j = Json ($setx.Invoke($null, @('shutter=0.00625&f=5.6&iso=400')))
Check 'setprops: picks the camera''s nearest entries and sets them' ($j.results.shutter -eq 'set' -and $j.results.f -eq 'set' -and $j.results.iso -eq 'set') ($j | ConvertTo-Json -Compress)
Check 'setprops: wrote 1/160 (63), f/5.6 (560), ISO 400' (($f.Writes -join ' ') -eq '500D=63 5007=560 500F=400') ($f.Writes -join ' ')
Check 'setprops: answers the settings as they are now' ($j.shutter -eq 0.0063 -and $j.f -eq 5.6 -and $j.iso -eq 400) ($j | ConvertTo-Json -Compress)

$j = Json ($setx.Invoke($null, @('f=5.6&iso=400')))
Check 'setprops: a value already set is "same" and is not written again' ($j.results.f -eq 'same' -and $j.results.iso -eq 'same' -and $f.Writes.Count -eq 3) (($f.Writes -join ' ') + ' ' + ($j | ConvertTo-Json -Compress))

$f = New-Fake $true 3 0                                                                           # aperture priority: the shutter is the camera's own
$j = Json ($expo.Invoke($null, $null))
Check 'props: in aperture priority the shutter is not settable' ($j.program -eq 3 -and -not $j.set.shutter -and $j.set.f -and $j.set.iso) ($j | ConvertTo-Json -Compress)
$j = Json ($setx.Invoke($null, @('shutter=0.00625&f=5.6')))
Check 'setprops: a locked shutter is reported and not written' ($j.results.shutter -eq 'locked' -and $j.results.f -eq 'set' -and ($f.Writes -join ' ') -eq '5007=560') (($f.Writes -join ' ') + ' ' + ($j | ConvertTo-Json -Compress))

$f = New-Fake $true 1 1; $f.Refuse = $true
$j = Json ($setx.Invoke($null, @('iso=800')))
Check 'setprops: a camera that refuses is reported as refused' ($j.results.iso -eq 'refused') ($j | ConvertTo-Json -Compress)

$f = New-Fake $true 1 1
$j = Json ($setx.Invoke($null, @('nonsense&shutter=abc&f=')))
Check 'setprops: unreadable input changes nothing' ($f.Writes.Count -eq 0 -and $j.supported) ($j | ConvertTo-Json -Compress)

$f = New-Fake $false 1 1                                                                           # not a Nikon
Check 'props: another brand is "supported: false" (the booth hides Apply)' ((Json ($expo.Invoke($null, $null))).supported -eq $false) ''
Check 'setprops: another brand changes nothing' ((Json ($setx.Invoke($null, @('iso=400')))).supported -eq $false -and $f.Writes.Count -eq 0) ''

$f = New-Fake $true 1 1; $f.Cur.Clear()                                                            # the camera answers "not supported" for every property
Check 'props: a camera with none of the properties is "supported: false"' ((Json ($expo.Invoke($null, $null))).supported -eq $false) ''

# --- 6. a Canon EOS sends its photos to the laptop (0xD11C "Save to") instead of waiting for the SD card, and is put back after ---
$toHost = $W.GetMethod('CanonToHost', $flags)
$toCard = $W.GetMethod('CanonToCard', $flags)
$poll = $W.GetMethod('CanonPoll', $flags)
$vals = $W.GetField('eosVals', $flags).GetValue($null)
$avail = $W.GetField('eosAvail', $flags).GetValue($null)
function Get-Flag([string]$n) { return $W.GetField($n, $flags).GetValue($null) }
function New-Eos([object]$cur, [uint32[]]$offers, [int]$es) {
    $e = New-Object PbTest.FakeEos
    $vals.Clear(); $avail.Clear()
    $W.GetField('ptp', $flags).SetValue($null, $e)
    $W.GetField('canonToHost', $flags).SetValue($null, $false)
    $W.GetField('canonHostGaveUp', $flags).SetValue($null, $false)
    if ($null -ne $cur) { $e.Changed(0xD11C, [uint32]$cur) }
    if ($offers) { $e.Avail(0xD11C, $es, $offers) }
    [void]$poll.Invoke($null, $null)                                                                  # the camera's first batch of news
    return $e
}

$e = New-Eos 2 ([uint32[]]@(2, 4)) 4
Check 'save-to: the first poll learns the current value and the choices' ($vals[[uint16]0xD11C] -eq 2 -and ($avail[[uint16]0xD11C] -join ',') -eq '2,4') (($avail[[uint16]0xD11C]) -join ',')
[void]$toHost.Invoke($null, $null)
Check 'save-to: a card camera that offers the computer is set to it' ((Get-Flag 'canonToHost') -and ($e.Sets -join ' ') -eq 'D11C=4') ($e.Sets -join ' ')
[void]$toCard.Invoke($null, @($false))
Check 'save-to: letting go of the camera puts it back on the card' (-not (Get-Flag 'canonToHost') -and ($e.Sets -join ' ') -eq 'D11C=4 D11C=2' -and -not (Get-Flag 'canonHostGaveUp')) ($e.Sets -join ' ')
[void]$toCard.Invoke($null, @($false))
Check 'save-to: putting it back twice writes once' (($e.Sets -join ' ') -eq 'D11C=4 D11C=2') ($e.Sets -join ' ')

$e = New-Eos 2 ([uint32[]]@(2, 4)) 2                                                                 # a model that sends 16 bit values
Check 'save-to: 16 bit choices are read too' (($avail[[uint16]0xD11C] -join ',') -eq '2,4') (($avail[[uint16]0xD11C]) -join ',')

$e = New-Eos 2 ([uint32[]]@(1, 2)) 4
[void]$toHost.Invoke($null, $null)
Check 'save-to: a camera that does not offer the computer is left alone' (-not (Get-Flag 'canonToHost') -and $e.Sets.Count -eq 0) ($e.Sets -join ' ')

$e = New-Eos 2 $null 4
[void]$toHost.Invoke($null, $null)
Check 'save-to: choices not reported: still tries the computer' ((Get-Flag 'canonToHost') -and ($e.Sets -join ' ') -eq 'D11C=4') ($e.Sets -join ' ')

$e = New-Eos $null $null 4
[void]$toHost.Invoke($null, $null)
Check 'save-to: a camera that does not list it is left alone' (-not (Get-Flag 'canonToHost') -and $e.Sets.Count -eq 0) ($e.Sets -join ' ')

$e = New-Eos 2 ([uint32[]]@(2, 4)) 4; $e.Refuse = 0x2002
[void]$toHost.Invoke($null, $null)
Check 'save-to: a camera that refuses stays on the card, no crash' (-not (Get-Flag 'canonToHost') -and $vals[[uint16]0xD11C] -eq 2) ("$($vals[[uint16]0xD11C]) " + ($e.Sets -join ' '))

$e = New-Eos 2 ([uint32[]]@(2, 4)) 4; $e.Silent = $true
$vals[[uint16]0xD11C] = [uint32]2
[void]$toHost.Invoke($null, $null)
Check 'save-to: accepted and not announced: taken as set (the first photo tells)' ((Get-Flag 'canonToHost')) ($e.Sets -join ' ')

$e = New-Eos 4 ([uint32[]]@(2, 4)) 4
[void]$toHost.Invoke($null, $null)
Check 'save-to: left on the computer by a crashed session: kept, and returned to the card at the end' ((Get-Flag 'canonToHost') -and $e.Sets.Count -eq 0) ($e.Sets -join ' ')
[void]$toCard.Invoke($null, @($false))
Check 'save-to: ... the card value is 2 (SD)' (($e.Sets -join ' ') -eq 'D11C=2') ($e.Sets -join ' ')

$e = New-Eos 2 ([uint32[]]@(2, 4)) 4
[void]$toHost.Invoke($null, $null)
[void]$toCard.Invoke($null, @($true))
Check 'save-to: giving up puts it back and remembers' ((Get-Flag 'canonHostGaveUp') -and -not (Get-Flag 'canonToHost') -and ($e.Sets -join ' ') -eq 'D11C=4 D11C=2') ($e.Sets -join ' ')
[void]$toHost.Invoke($null, $null)
Check 'save-to: after giving up it is not tried again' (-not (Get-Flag 'canonToHost') -and $e.Sets.Count -eq 2) ($e.Sets -join ' ')
$W.GetField('canonHostGaveUp', $flags).SetValue($null, $false)

# --- 7. Nikon White Balance, Canon EOS exposure, and 360 Movie recording / streaming download ---
$null = $W.GetField('canon', $flags).SetValue($null, $false)
$null = $W.GetField('nikon', $flags).SetValue($null, $false)
$null = $W.GetField('sony', $flags).SetValue($null, $false)

# Nikon WB check
$fwb = New-Fake $true 1 1
$fwb.Type[0x5005] = 4; $fwb.Cur[0x5005] = 2; $fwb.GetSet[0x5005] = 1; $fwb.Choices[0x5005] = [uint32[]]@(2, 4, 5, 6)
$jwb = Json ($expo.Invoke($null, $null))
Check 'props: Nikon reads white balance 0x5005 & choices' ($jwb.wb -eq 2 -and $jwb.set.wb -and $jwb.wbChoices.Count -eq 4) ($jwb | ConvertTo-Json -Compress)
$jwb2 = Json ($setx.Invoke($null, @('wb=4')))
Check 'setprops: Nikon writes white balance 0x5005 = 4 (Daylight)' ($jwb2.results.wb -eq 'set' -and $jwb2.wb -eq 4) ($jwb2 | ConvertTo-Json -Compress)

$tmpMov = Join-Path ([IO.Path]::GetTempPath()) ('pb4u-mov-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpMov | Out-Null
try {
    $canonStart = $W.GetMethod('CanonMovieStart', $flags)
    $canonStop = $W.GetMethod('CanonMovieStop', $flags)
    $nikStart = $W.GetMethod('NikonMovieStart', $flags)
    $nikStop = $W.GetMethod('NikonMovieStop', $flags)
    $cBytes = New-Object byte[] 150000
    (New-Object Random 42).NextBytes($cBytes)

    $cp = New-Object PbTest.Fake360Ptp
    $cp.IsCanon = $true; $cp.MovieData = $cBytes
    $W.GetField('ptp', $flags).SetValue($null, $cp)
    $W.GetField('canon', $flags).SetValue($null, $true)
    $W.GetField('nikon', $flags).SetValue($null, $false)
    $W.GetField('canonToHost', $flags).SetValue($null, $true)
    $W.GetField('canonHostGaveUp', $flags).SetValue($null, $false)
    $W.GetField('canonDestOrig', $flags).SetValue($null, [uint32]2)
    $eosVals = $W.GetField('eosVals', $flags).GetValue($null); $eosVals.Clear()
    $eosAvail = $W.GetField('eosAvail', $flags).GetValue($null); $eosAvail.Clear()
    $opsList = $W.GetField('ops', $flags).GetValue($null); $opsList.Clear(); [void]$opsList.Add([uint16]0x911A); [void]$opsList.Add([uint16]0x101B)

    $cj = Json ($expo.Invoke($null, $null))
    Check 'props: Canon reads shutter (1/60), f/2.8, ISO 400, WB 0' ($cj.supported -and [Math]::Abs($cj.shutter - (1.0/60)) -lt 0.002 -and $cj.f -eq 2.8 -and $cj.iso -eq 400 -and $cj.wb -eq 0 -and $cj.set.shutter) ($cj | ConvertTo-Json -Compress)
    $cj2 = Json ($setx.Invoke($null, @('shutter=0.004&iso=1000&wb=1')))
    Check 'setprops: Canon picks nearest Tv (1/250=0x78), ISO (1000=0x63), WB (1)' ($cj2.results.shutter -eq 'set' -and $cj2.results.iso -eq 'set' -and $cj2.results.wb -eq 'set' -and $cp.Tv -eq 0x78 -and $cp.Iso -eq 0x63 -and $cp.Wb -eq 1) ($cp.Log -join ' ')

    [void]$canonStart.Invoke($null, $null)
    Check 'CanonMovieStart switches SaveTo to card (2) and sets 0xD1B8=4' ($cp.SaveTo -eq 2 -and $cp.MovieTarget -eq 4 -and $cp.Recording) ($cp.Log -join ' ')
    $cs = Json ($canonStop.Invoke($null, @([string]$tmpMov)))
    $cDisk = Get-Item $cs.path
    Check 'CanonMovieStop streams exact 150 KB .mov to temp folder & restores SaveTo=4' ($cs.ok -and $cs.bytes -eq 150000 -and $cDisk.Length -eq 150000 -and $cp.SaveTo -eq 4 -and -not (Get-ChildItem $tmpMov -Filter '*.part')) (($cs | ConvertTo-Json -Compress) + ' SaveTo=' + $cp.SaveTo)

    # Nikon movie test
    $nBytes = New-Object byte[] 120000
    (New-Object Random 77).NextBytes($nBytes)
    $np = New-Object PbTest.Fake360Ptp
    $np.IsCanon = $false; $np.MovieData = $nBytes
    $W.GetField('ptp', $flags).SetValue($null, $np)
    $W.GetField('canon', $flags).SetValue($null, $false)
    $W.GetField('nikon', $flags).SetValue($null, $true)
    $W.GetField('live', $flags).SetValue($null, $false)

    [void]$nikStart.Invoke($null, $null)
    Check 'NikonMovieStart switches media->Card(0), LV->Movie(1), starts LV & rec 0x920A' ($np.RecMedia -eq '0' -and $np.LvSel -eq '1' -and $np.LvOn -and $np.Recording) ($np.Log -join ' ')
    $ns = Json ($nikStop.Invoke($null, @([string]$tmpMov)))
    $nDisk = Get-Item $ns.path
    Check 'NikonMovieStop stops rec 0x920B, streams 120 KB .mov & restores 0xD1A6/0xD10B' ($ns.ok -and $ns.bytes -eq 120000 -and $nDisk.Length -eq 120000 -and $np.RecMedia -eq '1' -and $np.LvSel -eq '0') (($ns | ConvertTo-Json -Compress) + ' media=' + $np.RecMedia + ' lvSel=' + $np.LvSel)
} finally {
    Remove-Item -Recurse -Force $tmpMov -ErrorAction SilentlyContinue
}

if ($fails -eq 0) { Write-Output 'PASS'; exit 0 } else { Write-Output "FAIL ($fails)"; exit 1 }
