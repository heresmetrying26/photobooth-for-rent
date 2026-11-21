# Tests the Windows camera worker's Canon "how long to wait for the photo before pressing the shutter again" rule (CanonWaitLimit)
# and the memory of recent shutter delays it uses (CanonNoteLag / CanonLag). No camera needed.
# Run with Windows PowerShell, the same one the app uses:
#   powershell -ExecutionPolicy Bypass -File tools\print-helper\test-camera-worker-canon-timing.ps1
$ErrorActionPreference = 'Stop'
$src = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'camera-worker.ps1')
$m = [regex]::Match($src, "(?s)\`$cs = @'\r?\n(.*?)\r?\n'@")
if (-not $m.Success) { Write-Output 'FAIL could not find the C# part of camera-worker.ps1'; exit 1 }
Add-Type -TypeDefinition $m.Groups[1].Value -Language CSharp

$fails = 0
function Check([string]$name, [bool]$ok, [string]$got) {
    if ($ok) { Write-Output "ok   $name" } else { Write-Output "FAIL $name`n     got: $got"; $script:fails++ }
}
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$W = [Pb4uCam.Worker]
$limit = $W.GetMethod('CanonWaitLimit', $flags)
$note = $W.GetMethod('CanonNoteLag', $flags)
$lag = $W.GetMethod('CanonLag', $flags)
$lags = $W.GetField('canonLags', $flags).GetValue($null)
function Lim([int]$attempt, [bool]$old, [int]$ms, [bool]$fast) { return [int]$limit.Invoke($null, @($attempt, $old, $ms, $fast)) }

# Not proven yet (the card, or fewer than two timed photos): the old limits, exactly as before.
Check 'older EOS first try, not proven: 6 s' ((Lim 0 $true 1000 $false) -eq 6000) (Lim 0 $true 1000 $false)
Check 'newer EOS first try, not proven: 8 s' ((Lim 0 $false 1000 $false) -eq 8000) (Lim 0 $false 1000 $false)
Check 'a retry, not proven: 8 s' ((Lim 1 $true 1000 $false) -eq 8000 -and (Lim 2 $false 1000 $false) -eq 8000) ((Lim 1 $true 1000 $false))
Check 'no delay measured yet: the old limits' ((Lim 0 $true 0 $true) -eq 6000 -and (Lim 0 $false 0 $true) -eq 8000) ((Lim 0 $true 0 $true))

# Proven fast (photos come straight to the laptop and recent delays were timed): about twice the delay, within bounds.
Check 'fast camera (1.0 s): 3.5 s, not 6 / 8' ((Lim 0 $true 1000 $true) -eq 3500 -and (Lim 0 $false 1000 $true) -eq 3500) ((Lim 0 $true 1000 $true))
Check 'fast camera (1.5 s): 4.5 s' ((Lim 0 $true 1500 $true) -eq 4500 -and (Lim 0 $false 1500 $true) -eq 4500) ((Lim 0 $true 1500 $true))
Check 'a retry waits at least 4.5 s' ((Lim 1 $false 1000 $true) -eq 4500 -and (Lim 2 $false 1000 $true) -eq 4500) ((Lim 1 $false 1000 $true))
Check 'a slow camera (4 s) never waits less than before' ((Lim 0 $true 4000 $true) -eq 6000 -and (Lim 0 $false 4000 $true) -eq 8000) ((Lim 0 $true 4000 $true))
Check 'the limit never goes over the old one' ((Lim 0 $true 60000 $true) -eq 6000 -and (Lim 1 $true 60000 $true) -eq 8000) ((Lim 0 $true 60000 $true))
Check 'a mid camera (2.5 s) waits 6.5 s on a newer EOS, 6 s on an older one' ((Lim 0 $false 2500 $true) -eq 6500 -and (Lim 0 $true 2500 $true) -eq 6000) ((Lim 0 $false 2500 $true))

# The memory of recent delays: the slowest of the last three.
$lags.Clear()
Check 'no delays: 0' (([int]$lag.Invoke($null, $null)) -eq 0) ''
foreach ($v in 1200, 900, 4100) { [void]$note.Invoke($null, @([int]$v)) }
Check 'the slowest of the last three' (([int]$lag.Invoke($null, $null)) -eq 4100) ([string]$lag.Invoke($null, $null))
foreach ($v in 1000, 1100, 1000) { [void]$note.Invoke($null, @([int]$v)) }
Check 'an old slow photo is forgotten after three more' (([int]$lag.Invoke($null, $null)) -eq 1100 -and $lags.Count -eq 3) ("max " + [string]$lag.Invoke($null, $null) + ", count " + $lags.Count)
$lags.Clear()

# The pre-focus the booth asks for during the countdown: the very next shot may skip its own focusing, once, within 12 s.
$take = $W.GetMethod('TakePreFocus', $flags)
$okF = $W.GetField('preFocusOk', $flags)
$swF = $W.GetField('preFocusSw', $flags)
function PreSet([bool]$ok) { $okF.SetValue($null, $ok); $swF.GetValue($null).Restart() }
function PreTake() { return [long]$take.Invoke($null, $null) }
$okF.SetValue($null, $false); $swF.GetValue($null).Reset()
Check 'pre-focus: none asked for: -1 (the shot focuses itself)' ((PreTake) -eq -1) ''
PreSet $true
$ago = PreTake
Check 'pre-focus: a fresh good one is used (returns how long ago)' ($ago -ge 0 -and $ago -lt 1000) ([string]$ago)
Check 'pre-focus: used once only' ((PreTake) -eq -1) ''
PreSet $false
Check 'pre-focus: a focus that missed is not used' ((PreTake) -eq -1) ''
PreSet $true
Start-Sleep -Milliseconds 300
Check 'pre-focus: still fresh after a short wait' ((PreTake) -ge 250) ''
# Make a pre-focus look 13 s old without waiting: a Stopwatch has no setter, so its private "elapsed" field is set directly
# (named "elapsed" on Windows PowerShell's .NET Framework, "_elapsed" on newer .NET). Skipped if neither exists.
$old = New-Object System.Diagnostics.Stopwatch
$field = $null
foreach ($n in 'elapsed', '_elapsed') { if (-not $field) { $field = [System.Diagnostics.Stopwatch].GetField($n, [Reflection.BindingFlags]'NonPublic,Instance') } }
if ($field) {
    $field.SetValue($old, [long](13 * [System.Diagnostics.Stopwatch]::Frequency))
    $old.Start()
    $swF.SetValue($null, $old); $okF.SetValue($null, $true)
    Check 'pre-focus: older than 12 s is not used' ((PreTake) -eq -1) ''
} else { Write-Output 'skip pre-focus: older than 12 s (no Stopwatch field to set)' }
$swF.SetValue($null, (New-Object System.Diagnostics.Stopwatch)); $okF.SetValue($null, $false)

if ($fails -eq 0) { Write-Output 'PASS'; exit 0 } else { Write-Output "FAIL ($fails)"; exit 1 }
