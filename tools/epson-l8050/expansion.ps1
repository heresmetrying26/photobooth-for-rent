# Drives the Epson L8050 driver's Printing Preferences > Borderless > Settings ("Expansion") dialog on a queue that uses it (default: the capture queue
# 'PB4U L8050 expansion', see README.md). It finds the dialog's controls by id (Auto Expand 4067, Retain Size 4068, slider 4075) and clicks them.
# Needs win32ui.ps1 next to it. Run:  powershell -File expansion.ps1 -Read   |   -Method Auto -Pos 2 -Glossy   |   -Method Retain -Glossy
# -Read          : only report the current Expansion state (does not save)
# -Method Auto|Retain, -Pos <n> : set it and save (inner OK, then main OK)
param([string]$Queue = 'PB4U L8050 expansion', [ValidateSet('', 'Auto', 'Retain')][string]$Method = '', [int]$Pos = -1, [switch]$Read, [switch]$Glossy)
$S = Split-Path $MyInvocation.MyCommand.Path
. "$S\win32ui.ps1"
$title = "$Queue Printing Preferences"
$p = Start-Process rundll32.exe -ArgumentList "printui.dll,PrintUIEntry /e /n `"$Queue`"" -PassThru
$w = Get-Win $title 20
if (-not $w) { 'ERR no preferences dialog'; return }
$pid1 = $w.Current.ProcessId
function Cleanup { Get-Process -Id $pid1 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
# 4x6, borderless on
$ds = Hwnd (Get-Ctl $w 2764); $ci = Combo-Items $ds
$idx = 1; for ($i = 0; $i -lt $ci.Items.Count; $i++) { if ($ci.Items[$i] -like '10 x 15 cm (4 x 6 in)*') { $idx = $i; break } }
Combo-Select $ds $idx; Start-Sleep -Milliseconds 700
if ($Glossy) { $pt = Hwnd (Get-Ctl $w 2755); $pi = Combo-Items $pt; $gi = 6; for ($i = 0; $i -lt $pi.Items.Count; $i++) { if ($pi.Items[$i] -eq 'Photo Paper Glossy') { $gi = $i } }; Combo-Select $pt $gi; Start-Sleep -Milliseconds 500 }
$bh = Hwnd (Get-Ctl $w 2793)
if (-not (Btn-Checked $bh)) { Btn-Click $bh; Start-Sleep -Milliseconds 500 }
$sh = Hwnd (Get-Ctl $w 2794)
$sendPs = Join-Path $env:TEMP 'pb4u-clicker.ps1'
Set-Content $sendPs ("Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class Q{[DllImport(""user32.dll"")]public static extern IntPtr SendMessage(IntPtr h,int m,IntPtr w,IntPtr l);}'`n[void][Q]::SendMessage([IntPtr]" + $sh.ToInt64() + ", 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)") -Encoding UTF8
$errF = Join-Path $env:TEMP 'pb4u-clicker.err'; Remove-Item $errF -ErrorAction SilentlyContinue
$sp = Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$sendPs -PassThru -WindowStyle Hidden -RedirectStandardError $errF
$dlg = $null
for ($i = 0; $i -lt 20 -and -not $dlg; $i++) {
  Start-Sleep -Milliseconds 400
  $dlg = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Expansion')))
}
if (-not $dlg) { 'ERR no Expansion dialog'; Cleanup; return }
$auto = Hwnd (Get-Ctl $dlg 4067); $retain = Hwnd (Get-Ctl $dlg 4068); $tb = Hwnd (Get-Ctl $dlg 4075)
$tmin = [int][W32]::SendMessage($tb, 0x401, [IntPtr]::Zero, [IntPtr]::Zero); $tmax = [int][W32]::SendMessage($tb, 0x402, [IntPtr]::Zero, [IntPtr]::Zero); $tpos = [int][W32]::SendMessage($tb, 0x400, [IntPtr]::Zero, [IntPtr]::Zero)
"state: AutoExpand=$(Btn-Checked $auto) RetainSize=$(Btn-Checked $retain) slider min=$tmin max=$tmax pos=$tpos sliderEnabled=$([W32]::IsWindowEnabled($tb))"
# labels near the slider (Min / ... / Max)
foreach ($k in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))) { "  label: '$($k.Current.Name)' id=$($k.Current.AutomationId)" }
if ($Read -or ($Method -eq '' -and $Pos -lt 0)) { Cleanup; return }
if ($Method -eq 'Auto') { Btn-Click $auto; Start-Sleep -Milliseconds 300 }
if ($Method -eq 'Retain') { Btn-Click $retain; Start-Sleep -Milliseconds 300 }
if ($Pos -ge 0) {
  [void][W32]::SendMessage($tb, 0x405, [IntPtr]1, [IntPtr]$Pos)                                   # TBM_SETPOS
  $par = [W32]::GetParent($tb); [void][W32]::SendMessage($par, 0x114, [IntPtr](4 -bor ($Pos -shl 16)), $tb)   # WM_HSCROLL / SB_THUMBPOSITION
  Start-Sleep -Milliseconds 300
}
"set:   AutoExpand=$(Btn-Checked $auto) RetainSize=$(Btn-Checked $retain) pos=$([int][W32]::SendMessage($tb, 0x400, [IntPtr]::Zero, [IntPtr]::Zero))"
$ok = Hwnd (Get-Ctl $dlg 4077)
[void][W32]::PostMessage($ok, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero); Start-Sleep -Milliseconds 800
$mainOk = Hwnd (Get-Ctl $w 1)
[void][W32]::PostMessage($mainOk, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero); Start-Sleep -Milliseconds 1500
Cleanup
'saved'
