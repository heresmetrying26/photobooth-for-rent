# Tests the Windows camera worker's Canon "Save to" setting (0xD11C): photos go to the laptop instead of waiting for the
# SD card, and the camera is put back on the card afterwards (CanonToHost / CanonToCard / CanonAvail).
# Run with Windows PowerShell, the same one the app uses:
#   powershell -ExecutionPolicy Bypass -File tools\print-helper\test-camera-worker-saveto.ps1
# It compiles the worker's C# exactly as camera-worker.ps1 does and feeds it a made-up Canon EOS (no camera needed).
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'camera-worker.ps1')
$m = [regex]::Match($src, "(?s)\`$cs = @'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL could not find the C# part of camera-worker.ps1'; exit 1 }
# A made-up Canon EOS: answers the event poll (0x9116) with what the test queued, and takes setting writes (0x9110).
$fakeSrc = @'
namespace PbTest
{
    using System;
    using System.Collections.Generic;
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
}
'@
Add-Type -TypeDefinition ($m.Groups[1].Value + "`r`n" + $fakeSrc) -Language CSharp

$fails = 0
function Check([string]$name, [bool]$ok, [string]$got) {
    if ($ok) { Write-Output "ok   $name" } else { Write-Output "FAIL $name`n     got: $got"; $script:fails++ }
}
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$W = [Pb4uCam.Worker]

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

if ($fails -eq 0) { Write-Output 'PASS'; exit 0 } else { Write-Output "FAIL ($fails)"; exit 1 }
