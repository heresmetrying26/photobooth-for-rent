# End-to-end tests for Canon EOS 60D / 6D / Mirrorless fixes in tools/print-helper/camera-worker.ps1:
#   1. 0x911A PCHDDCapacity + AvailableShots (0xD11B) handshake for SaveTo=Host (0xD11C=4)
#   2. Immediate revert to card when 0x911A is unsupported/fails or AvailableShots stays 0
#   3. DSLR two-stage shutter 0x9128(1,0)->0x9128(2,0)->0x9129(2)->0x9129(1) (never EOS-M param1=3)
#   4. DSLR mechanical flash X-sync: drops Live View (0xD1B0=0) before shutter (and 0 ms extra wait after Pose)
#   5. RAM (0xC186) direct 0x101B chunked download + 0x9117 TransferComplete + 0x9118 CancelTransfer on RAW
#   6. 0x910F RemoteRelease fallback on DSLRs that list it + immediate error on result 7 (card full/locked)
#   7. CloseCamera() resets per-camera Canon failure flags (canonHostGaveUp, canonNoAfBad, canonHostWorked)
#   8. WPD 0x802A0002 / 0x802A0003 throw GoneException
#   9. Mirrorless (EOS R50 / M50) keeps param1=3 & Live View; DSLRs (60D, 6D, 5D, 1500D, Rebel) detected as DSLR
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\print-helper\test-camera-worker-canon-capture.ps1
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'camera-worker.ps1')
$m = [regex]::Match($src, "(?s)\`$cs = @'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL could not find the C# part of camera-worker.ps1'; exit 1 }

$fakeSrc = @'
namespace PbCanonTest
{
    using System;
    using System.Collections.Generic;

    public class RealisticEos : Pb4uCam.Ptp
    {
        public bool IsDslr = true;
        public bool RefuseCap = false;
        public bool ZeroAvailForever = false;
        public bool Ignore9128 = false;
        public uint RemoteReleaseResult = 0;
        public bool Forbid1009OnRam = true;

        public uint SaveTo = 2;
        public uint AvailShots = 500;
        public uint AspectRatio = 0;
        public bool RefuseAspect = false;
        public bool LiveOn = false;
        public bool HalfPressed = false;

        public int CapCalls = 0;
        public bool SawParam3 = false;
        public bool Saw1009OnRam = false;
        public bool Saw101B = false;
        public bool? LiveWhenShot = null;
        public List<string> LogOps = new List<string>();
        public List<uint> DoneHandles = new List<uint>();
        public List<uint> CancelHandles = new List<uint>();
        public List<byte> Events = new List<byte>();
        public byte[] PhotoBytes;

        public RealisticEos()
        {
            PhotoBytes = new byte[120000];
            PhotoBytes[0] = 0xFF; PhotoBytes[1] = 0xD8; PhotoBytes[2] = 0xFF; PhotoBytes[3] = 0xE1;
            for (int i = 4; i < PhotoBytes.Length - 2; i++) PhotoBytes[i] = (byte)(i & 0xFF);
            PhotoBytes[PhotoBytes.Length - 2] = 0xFF; PhotoBytes[PhotoBytes.Length - 1] = 0xD9;
        }

        static void U32(List<byte> l, uint v) { l.Add((byte)v); l.Add((byte)(v >> 8)); l.Add((byte)(v >> 16)); l.Add((byte)(v >> 24)); }
        static void U16(List<byte> l, ushort v) { l.Add((byte)v); l.Add((byte)(v >> 8)); }

        public void EvProp(uint prop, uint val)
        {
            U32(Events, 16); U32(Events, 0xC189); U32(Events, prop); U32(Events, val);
        }
        public void EvAvail(uint prop, params uint[] vals)
        {
            U32(Events, (uint)(20 + vals.Length * 4)); U32(Events, 0xC18A); U32(Events, prop); U32(Events, 6); U32(Events, (uint)vals.Length);
            foreach (uint v in vals) U32(Events, v);
        }
        public void EvRam(uint handle, ushort fmt, uint size)
        {
            U32(Events, 0x18); U32(Events, 0xC186); U32(Events, handle);
            U16(Events, fmt); U16(Events, 0);
            U32(Events, 0); U32(Events, size);
        }
        public void EvCard(uint handle, ushort fmt, uint size)
        {
            U32(Events, 0x24); U32(Events, 0xC181); U32(Events, handle); U32(Events, 0);
            U16(Events, fmt); U16(Events, 0);
            U32(Events, 0); U32(Events, 0); U32(Events, 0); U32(Events, size); U32(Events, 0);
        }

        void EmitShot()
        {
            LiveWhenShot = LiveOn;
            if (SaveTo == 4)
            {
                if (AvailShots == 0) return;   // Canon EOS firmware refuses host capture when AvailableShots == 0
                EvRam(0x2001, 0xB103, (uint)PhotoBytes.Length);   // RAW
                EvRam(0x2002, 0x3801, (uint)PhotoBytes.Length);   // JPEG
                if (AvailShots > 0) AvailShots--;
            }
            else
            {
                EvCard(0x1234, 0x3801, (uint)PhotoBytes.Length);
            }
        }

        public override uint Op(ushort code, params uint[] ps)
        {
            LogOps.Add(code.ToString("X4") + (ps.Length > 0 ? "(" + string.Join(",", ps) + ")" : ""));
            if (code == 0x911A)
            {
                CapCalls++;
                if (RefuseCap) return 0x2005;
                if (!ZeroAvailForever) { AvailShots = 9999; EvProp(0xD11B, 9999); }
                return OK;
            }
            if (code == 0x9152) { LiveOn = false; return OK; }
            if (code == 0x9128)
            {
                uint p1 = ps.Length > 0 ? ps[0] : 0;
                if (p1 == 3)
                {
                    SawParam3 = true;
                    if (!IsDslr && !Ignore9128) EmitShot();
                }
                else if (p1 == 1)
                {
                    HalfPressed = true;
                    EvProp(0xD11B, AvailShots);
                }
                else if (p1 == 2)
                {
                    if (HalfPressed && !Ignore9128) EmitShot();
                }
                return OK;
            }
            if (code == 0x9129)
            {
                if (ps.Length > 0 && ps[0] == 1) HalfPressed = false;
                return OK;
            }
            if (code == 0x9117 && ps.Length > 0) { DoneHandles.Add(ps[0]); return OK; }
            if (code == 0x9118 && ps.Length > 0) { CancelHandles.Add(ps[0]); return OK; }
            return OK;
        }

        public override uint OpP(ushort code, out uint[] answer, params uint[] ps)
        {
            LogOps.Add(code.ToString("X4") + "P");
            answer = new uint[] { RemoteReleaseResult };
            if (code == 0x910F && RemoteReleaseResult == 0) EmitShot();
            return OK;
        }

        public override uint OpRead(ushort code, out byte[] data, params uint[] ps)
        {
            data = new byte[0];
            if (code == 0x9116)
            {
                data = Events.ToArray();
                Events.Clear();
                return OK;
            }
            if (code == 0x101B)
            {
                Saw101B = true;
                int off = ps.Length > 1 ? (int)ps[1] : 0;
                int max = ps.Length > 2 ? (int)ps[2] : PhotoBytes.Length;
                if (off >= PhotoBytes.Length) return OK;
                int take = Math.Min(max, PhotoBytes.Length - off);
                data = new byte[take];
                Buffer.BlockCopy(PhotoBytes, off, data, 0, take);
                return OK;
            }
            if (code == 0x1009)
            {
                uint h = ps.Length > 0 ? ps[0] : 0;
                if (Forbid1009OnRam && (h == 0x2001 || h == 0x2002)) { Saw1009OnRam = true; return 0x2005; }
                data = PhotoBytes;
                return OK;
            }
            if (code == 0x1008)
            {
                data = new byte[16];
                byte[] sz = BitConverter.GetBytes((uint)PhotoBytes.Length);
                Buffer.BlockCopy(sz, 0, data, 8, 4);
                return OK;
            }
            return OK;
        }

        public override uint OpWrite(ushort code, byte[] data, params uint[] ps)
        {
            if (code != 0x9110) return OK;
            uint prop = BitConverter.ToUInt32(data, 4), val = BitConverter.ToUInt32(data, 8);
            LogOps.Add("SET_" + prop.ToString("X4") + "=" + val);
            if (prop == 0xD1B0) { LiveOn = (val == 2); EvProp(0xD1B0, val); }
            else if (prop == 0xD11C)
            {
                SaveTo = val;
                EvProp(0xD11C, val);
                if (val == 4) { AvailShots = 0; EvProp(0xD11B, 0); }
                else { AvailShots = 500; EvProp(0xD11B, 500); }
            }
            else if (prop == 0xD194)
            {
                if (RefuseAspect) return 0x2005;
                AspectRatio = val;
                EvProp(0xD194, val);
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

$flags = [Reflection.BindingFlags]'NonPublic,Static'
$W = [Pb4uCam.Worker]
$ops = $W.GetField('ops', $flags).GetValue($null)
$vals = $W.GetField('eosVals', $flags).GetValue($null)
$avail = $W.GetField('eosAvail', $flags).GetValue($null)
$newFiles = $W.GetField('canonNew', $flags).GetValue($null)
$lags = $W.GetField('canonLags', $flags).GetValue($null)

$mToHost = $W.GetMethod('CanonToHost', $flags)
$mToCard = $W.GetMethod('CanonToCard', $flags)
$mPoll = $W.GetMethod('CanonPoll', $flags)
$mLiveOn = $W.GetMethod('CanonLiveOn', $flags)
$mLiveOff = $W.GetMethod('CanonLiveOff', $flags)
$mCapture = $W.GetMethod('CanonCapture', $flags)
$mClose = $W.GetMethod('CloseCamera', $flags)
$mIsDslr = $W.GetMethod('CanonIsDslr', $flags)
$mInfoJson = $W.GetMethod('InfoJson', $flags)
$mAspect32 = $W.GetMethod('CanonAspect32', $flags)
$mCheck = [Pb4uCam.Ptp].GetMethod('Check', $flags)

function Reset-Worker([PbCanonTest.RealisticEos]$cam, [string]$model, [uint16[]]$opList, [uint32]$initialSaveTo, [uint32]$afMode) {
    $vals.Clear(); $avail.Clear(); $newFiles.Clear(); $lags.Clear(); $ops.Clear()
    foreach ($o in $opList) { [void]$ops.Add($o) }
    $W.GetField('ptp', $flags).SetValue($null, $cam)
    $W.GetField('canon', $flags).SetValue($null, $true)
    $W.GetField('nikon', $flags).SetValue($null, $false)
    $W.GetField('sony', $flags).SetValue($null, $false)
    $W.GetField('camName', $flags).SetValue($null, $model)
    $W.GetField('camModel', $flags).SetValue($null, $model)
    $W.GetField('camMaker', $flags).SetValue($null, 'Canon Inc.')
    $W.GetField('live', $flags).SetValue($null, $false)
    $W.GetField('canonToHost', $flags).SetValue($null, $false)
    $W.GetField('canonHostGaveUp', $flags).SetValue($null, $false)
    $W.GetField('canonHostWorked', $flags).SetValue($null, $false)
    $W.GetField('canonNoAfBad', $flags).SetValue($null, $false)
    $W.GetField('canonFocusInShot', $flags).SetValue($null, $false)
    $W.GetField('canonAspectChanged', $flags).SetValue($null, $false)
    $W.GetField('canonAspectCrop', $flags).SetValue($null, $false)
    $W.GetField('canonAspectOrig', $flags).SetValue($null, [uint32]0)
    $W.GetField('canonLiveOffSw', $flags).GetValue($null).Reset()
    $cam.SaveTo = $initialSaveTo
    $cam.AvailShots = if ($initialSaveTo -eq 4) { 0 } else { 500 }
    $cam.EvProp(0xD11C, $initialSaveTo)
    $cam.EvAvail(0xD11C, [uint32[]]@(2, 4, 6))
    $cam.EvProp(0xD11B, $cam.AvailShots)
    $cam.EvProp(0xD108, $afMode)
    $cam.EvProp(0xD194, $cam.AspectRatio)
    [void]$mPoll.Invoke($null, $null)
}

$eos60Ops = [uint16[]]@(0x1008, 0x1009, 0x101B, 0x9107, 0x910F, 0x9110, 0x9114, 0x9115, 0x9116, 0x9117, 0x9118, 0x911A, 0x9128, 0x9129, 0x9151, 0x9152, 0x9153)

# --- 1. CanonIsDslr classification ---
foreach ($pair in @(
    @('Canon EOS 60D', $true),
    @('Canon EOS 6D', $true),
    @('Canon EOS 5D Mark III', $true),
    @('Canon EOS 1500D', $true),
    @('Canon EOS Rebel T7', $true),
    @('Canon EOS R50', $false),
    @('Canon EOS R6', $false),
    @('Canon EOS RP', $false),
    @('Canon EOS M50', $false)
)) {
    $W.GetField('canon', $flags).SetValue($null, $true)
    $W.GetField('camName', $flags).SetValue($null, $pair[0])
    $W.GetField('camModel', $flags).SetValue($null, $pair[0])
    $got = [bool]$mIsDslr.Invoke($null, $null)
    Check ("CanonIsDslr: $($pair[0]) => $($pair[1])") ($got -eq $pair[1]) ([string]$got)
}

# --- 2. Canon EOS 60D (MF) full capture: 0x911A + LV drop + two-stage 0x9128 + 0x101B RAM + 0x9117/0x9118 ---
$cam = New-Object PbCanonTest.RealisticEos
$cam.IsDslr = $true
Reset-Worker $cam 'Canon EOS 60D' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
Check '60D connect: switched to host + called 0x911A + AvailableShots > 0' (
    ($W.GetField('canonToHost', $flags).GetValue($null) -eq $true) -and $cam.CapCalls -ge 1 -and $vals[[uint16]0xD11B] -gt 0
) ("toHost=$($W.GetField('canonToHost', $flags).GetValue($null)) capCalls=$($cam.CapCalls) avail=$($vals[[uint16]0xD11B])")

[void]$mLiveOn.Invoke($null, $null)
Check '60D live view turned on' ($cam.LiveOn -eq $true) ([string]$cam.LiveOn)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$img = $mCapture.Invoke($null, $null)
$sw.Stop()
Check '60D standalone capture returns full JPEG fast (< 1500 ms)' ($img.Length -eq $cam.PhotoBytes.Length -and $sw.ElapsedMilliseconds -lt 1500) ("len=$($img.Length) ms=$($sw.ElapsedMilliseconds)")
Check '60D DSLR dropped Live View before firing (mechanical flash sync)' ($cam.LiveWhenShot -eq $false) ([string]$cam.LiveWhenShot)
Check '60D DSLR never sent EOS-M param1=3' ($cam.SawParam3 -eq $false) ($cam.LogOps -join ' ')
Check '60D RAM object downloaded via 0x101B (never 0x1009)' ($cam.Saw101B -and -not $cam.Saw1009OnRam) ("101B=$($cam.Saw101B) 1009=$($cam.Saw1009OnRam)")
Check '60D RAW+JPEG: 0x9117 on JPEG (0x2002) and 0x9118 on RAW (0x2001)' (($cam.DoneHandles -contains 0x2002) -and ($cam.CancelHandles -contains 0x2001)) ("done=$($cam.DoneHandles -join ',') cancel=$($cam.CancelHandles -join ',')")

# --- 3. Canon EOS 6D session capture when Pose already turned Live View off >= 350 ms earlier (0 ms extra mirror wait) ---
$cam6d = New-Object PbCanonTest.RealisticEos
$cam6d.IsDslr = $true
Reset-Worker $cam6d 'Canon EOS 6D' $eos60Ops 4 3   # already left on Host (4) with AvailShots=0!
[void]$mToHost.Invoke($null, $null)
Check '6D left on SaveTo=4 still sends 0x911A and recovers AvailableShots' (
    ($W.GetField('canonToHost', $flags).GetValue($null) -eq $true) -and $cam6d.CapCalls -ge 1 -and $vals[[uint16]0xD11B] -gt 0
) ("toHost=$($W.GetField('canonToHost', $flags).GetValue($null)) capCalls=$($cam6d.CapCalls) avail=$($vals[[uint16]0xD11B])")

[void]$mLiveOn.Invoke($null, $null)
[void]$mLiveOff.Invoke($null, $null)     # simulates "Pose" calling /camera/live?on=0
Start-Sleep -Milliseconds 360
$sw6 = [System.Diagnostics.Stopwatch]::StartNew()
$img6 = $mCapture.Invoke($null, $null)
$sw6.Stop()
Check '6D session shot after Pose LiveOff fires with 0 extra mirror wait (< 500 ms)' ($img6.Length -eq $cam6d.PhotoBytes.Length -and $sw6.ElapsedMilliseconds -lt 500 -and $cam6d.LiveWhenShot -eq $false) ("ms=$($sw6.ElapsedMilliseconds) live=$($cam6d.LiveWhenShot)")

# --- 4. Mid-session AvailableShots refresh (< 100 triggers 0x911A before firing) ---
$capsBefore = $cam6d.CapCalls
$vals[[uint16]0xD11B] = [uint32]12
$cam6d.AvailShots = 12
$img6b = $mCapture.Invoke($null, $null)
Check '6D refreshes 0x911A when AvailableShots drops below 100' ($cam6d.CapCalls -gt $capsBefore -and $img6b.Length -eq $cam6d.PhotoBytes.Length) ("before=$capsBefore after=$($cam6d.CapCalls)")

# --- 5. Immediate fallback to card if 0x911A fails OR AvailableShots stays 0 ---
$camBadCap = New-Object PbCanonTest.RealisticEos
$camBadCap.RefuseCap = $true
Reset-Worker $camBadCap 'Canon EOS 60D' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
Check '0x911A refused -> immediately reverts to card and sets canonHostGaveUp' (
    ($W.GetField('canonToHost', $flags).GetValue($null) -eq $false) -and
    ($W.GetField('canonHostGaveUp', $flags).GetValue($null) -eq $true) -and
    $camBadCap.SaveTo -eq 2
) ("toHost=$($W.GetField('canonToHost', $flags).GetValue($null)) gaveUp=$($W.GetField('canonHostGaveUp', $flags).GetValue($null)) saveTo=$($camBadCap.SaveTo)")

$camZero = New-Object PbCanonTest.RealisticEos
$camZero.ZeroAvailForever = $true
Reset-Worker $camZero 'Canon EOS 60D' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
Check 'AvailableShots stays 0 -> immediately reverts to card and sets canonHostGaveUp' (
    ($W.GetField('canonToHost', $flags).GetValue($null) -eq $false) -and
    ($W.GetField('canonHostGaveUp', $flags).GetValue($null) -eq $true) -and
    $camZero.SaveTo -eq 2
) ("toHost=$($W.GetField('canonToHost', $flags).GetValue($null)) gaveUp=$($W.GetField('canonHostGaveUp', $flags).GetValue($null)) saveTo=$($camZero.SaveTo)")

# --- 6. CloseCamera() resets stale failure flags across camera swaps (60D -> 6D) ---
$W.GetField('canonHostGaveUp', $flags).SetValue($null, $true)
$W.GetField('canonNoAfBad', $flags).SetValue($null, $true)
$W.GetField('canonHostWorked', $flags).SetValue($null, $true)
[void]$mClose.Invoke($null, $null)
Check 'CloseCamera() resets canonHostGaveUp, canonNoAfBad, canonHostWorked, canonToHost' (
    (-not $W.GetField('canonHostGaveUp', $flags).GetValue($null)) -and
    (-not $W.GetField('canonNoAfBad', $flags).GetValue($null)) -and
    (-not $W.GetField('canonHostWorked', $flags).GetValue($null)) -and
    (-not $W.GetField('canonToHost', $flags).GetValue($null))
) ("gaveUp=$($W.GetField('canonHostGaveUp', $flags).GetValue($null)) noAf=$($W.GetField('canonNoAfBad', $flags).GetValue($null))")

# --- 7. Canon Mirrorless (EOS R50) uses param1=3 and does not force LV off ---
$camR50 = New-Object PbCanonTest.RealisticEos
$camR50.IsDslr = $false
Reset-Worker $camR50 'Canon EOS R50' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
[void]$mLiveOn.Invoke($null, $null)
$imgR = $mCapture.Invoke($null, $null)
Check 'EOS R50 mirrorless uses param1=3, stays in LV, downloads RAM via 0x101B' (
    $imgR.Length -eq $camR50.PhotoBytes.Length -and $camR50.SawParam3 -and $camR50.LiveWhenShot -eq $true -and $camR50.Saw101B
) ("param3=$($camR50.SawParam3) live=$($camR50.LiveWhenShot) 101B=$($camR50.Saw101B)")

# --- 8. 0x910F fallback on DSLR when 0x9128 produces no photo ---
$camFb = New-Object PbCanonTest.RealisticEos
$camFb.IsDslr = $true
$camFb.Ignore9128 = $true
Reset-Worker $camFb 'Canon EOS 60D' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
$imgFb = $mCapture.Invoke($null, $null)
Check 'DSLR falls back to 0x910F when 0x9128 yields no photo' ($imgFb.Length -eq $camFb.PhotoBytes.Length -and ($camFb.LogOps -contains '910FP')) ($camFb.LogOps -join ' ')

# --- 9. WPD 0x802A0002 & 0x802A0003 map to GoneException ---
foreach ($hr in @(0x802A0002, 0x802A0003)) {
    $isGone = $false
    try {
        [void]$mCheck.Invoke($null, @([int]$hr, 'Camera command'))
    } catch {
        $ex = $_.Exception
        while ($ex.InnerException) { $ex = $ex.InnerException }
        $isGone = ($ex -is [Pb4uCam.GoneException])
    }
    Check ("Ptp.Check(0x{0:X8}) throws GoneException" -f $hr) $isGone ([string]$isGone)
}

# --- 10. InfoJson reports canonDslr and saveTo ---
Reset-Worker $cam 'Canon EOS 60D' $eos60Ops 2 3
[void]$mToHost.Invoke($null, $null)
$inf = ($mInfoJson.Invoke($null, $null) | ConvertFrom-Json)
Check 'InfoJson reports canonDslr=true, saveTo="host", toCard=false, lensMf=true, aspectCrop=false' (
    $inf.canonDslr -eq $true -and $inf.saveTo -eq 'host' -and $inf.toCard -eq $false -and $inf.lensMf -eq $true -and $inf.aspectCrop -eq $false
) ($inf | ConvertTo-Json -Compress)

# --- 11. Canon EOS 1300D non-3:2 aspect ratio (0xD194=3 16:9) auto-switches to 3:2 and restores on close ---
$cam1300 = New-Object PbCanonTest.RealisticEos
$cam1300.IsDslr = $true
$cam1300.AspectRatio = 3
Reset-Worker $cam1300 'Canon EOS 1300D' $eos60Ops 2 3
[void]$mAspect32.Invoke($null, $null)
$inf1300 = ($mInfoJson.Invoke($null, $null) | ConvertFrom-Json)
Check '1300D switches 0xD194 from 16:9 (3) to 3:2 (0) and clears aspectCrop' (
    $cam1300.AspectRatio -eq 0 -and
    ($W.GetField('canonAspectChanged', $flags).GetValue($null) -eq $true) -and
    $inf1300.aspectCrop -eq $false -and
    $inf1300.canonDslr -eq $true
) ("ar=$($cam1300.AspectRatio) changed=$($W.GetField('canonAspectChanged', $flags).GetValue($null)) info=$($inf1300 | ConvertTo-Json -Compress)")
[void]$mClose.Invoke($null, $null)
Check '1300D CloseCamera() restores original 0xD194 (3) and clears aspect flags' (
    $cam1300.AspectRatio -eq 3 -and
    (-not $W.GetField('canonAspectChanged', $flags).GetValue($null)) -and
    (-not $W.GetField('canonAspectCrop', $flags).GetValue($null))
) ("ar=$($cam1300.AspectRatio) changed=$($W.GetField('canonAspectChanged', $flags).GetValue($null)) crop=$($W.GetField('canonAspectCrop', $flags).GetValue($null))")

# --- 12. Canon EOS 1300D refusing 0xD194 reports aspectCrop=true in InfoJson ---
$cam1300Ref = New-Object PbCanonTest.RealisticEos
$cam1300Ref.IsDslr = $true
$cam1300Ref.AspectRatio = 3
$cam1300Ref.RefuseAspect = $true
Reset-Worker $cam1300Ref 'Canon EOS 1300D' $eos60Ops 2 3
[void]$mAspect32.Invoke($null, $null)
$infRef = ($mInfoJson.Invoke($null, $null) | ConvertFrom-Json)
Check '1300D refusing 0xD194 sets canonAspectCrop=true and InfoJson.aspectCrop=true' (
    $cam1300Ref.AspectRatio -eq 3 -and $infRef.aspectCrop -eq $true
) ("ar=$($cam1300Ref.AspectRatio) info=$($infRef | ConvertTo-Json -Compress)")

[void]$mClose.Invoke($null, $null)
if ($fails -eq 0) { Write-Output 'PASS'; exit 0 } else { Write-Output "FAIL ($fails)"; exit 1 }
