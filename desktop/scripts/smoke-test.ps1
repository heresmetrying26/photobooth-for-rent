# Start-up check for the packaged Windows app: does it open a window without errors?
# Desktop v1.0.90 and v1.0.91 shipped with a missing server file. They stayed stuck in the background with
# no window, and couldn't update themselves. Run this on every build before pushing a desktop-v* tag.
#
# Run from desktop/ after `npm run dist:win`:
#   powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
# Or point it at another copy:  -Exe "C:\Program Files\photobooth4u\photobooth4u.exe"
# Exit code 0 = passed, 1 = failed.
param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\dist\win-unpacked\photobooth4u.exe'),
  [int]$WaitSeconds = 40
)
$ErrorActionPreference = 'Stop'
$Exe = [System.IO.Path]::GetFullPath($Exe)
if (-not (Test-Path $Exe)) { Write-Host "FAIL: $Exe not found. Run npm run dist:win first."; exit 1 }

# A copy that is already open holds the single-instance lock, so a new one would just quit.
if (Get-Process photobooth4u -ErrorAction SilentlyContinue) {
  Write-Host 'FAIL: photobooth4u is already running. Close it (or End task in Task Manager) and run this again.'
  exit 1
}

$out = Join-Path $env:TEMP 'pb4u-smoke-out.txt'
$err = Join-Path $env:TEMP 'pb4u-smoke-err.txt'
Remove-Item $out, $err -ErrorAction SilentlyContinue
$env:ELECTRON_ENABLE_LOGGING = '1'
Write-Host "Starting $Exe"
$p = Start-Process $Exe -PassThru -RedirectStandardOutput $out -RedirectStandardError $err

$window = $false; $renderer = $false
for ($i = 0; $i -lt $WaitSeconds; $i++) {
  Start-Sleep 1
  if ($p.HasExited) { break }
  $p.Refresh()
  if ($p.MainWindowTitle) { $window = $true }
  $renderer = [bool](Get-CimInstance Win32_Process -Filter "Name='photobooth4u.exe'" | Where-Object { $_.CommandLine -match '--type=renderer' })
  if ($window -and $renderer) { Start-Sleep 5; break }   # a few more seconds, so errors right after opening are caught too
}
$exited = $p.HasExited
Stop-Process -Name photobooth4u -Force -ErrorAction SilentlyContinue

$errText = if (Test-Path $err) { Get-Content $err -Raw } else { '' }
$bad = @()
if ($errText -match 'ERR_MODULE_NOT_FOUND|Cannot find module|UnhandledPromiseRejection|Uncaught|SyntaxError|ReferenceError|TypeError') {
  $bad += 'errors in the start-up log'
}
if ($exited) { $bad += 'the app closed by itself' }
elseif (-not $window) { $bad += "no window opened within $WaitSeconds s" }
elseif (-not $renderer) { $bad += 'the window has no page (no renderer process)' }

if ($bad.Count) {
  Write-Host ('FAIL: ' + ($bad -join '; '))
  if ($errText) { Write-Host '--- start-up errors ---'; Write-Host $errText.Trim() }
  exit 1
}
Write-Host 'PASS: the app opened its window with no start-up errors.'
exit 0
