Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
}
'@
function Get-Win([string]$title, [int]$wait = 10) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $title)
  for ($i = 0; $i -lt $wait * 2; $i++) {
    $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Get-Ctl($win, [int]$id) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$id)
  $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function Hwnd($el) { [IntPtr]$el.Current.NativeWindowHandle }
function Combo-Items([IntPtr]$h) {
  $n = [int][W32]::SendMessage($h, 0x146, [IntPtr]::Zero, [IntPtr]::Zero)   # CB_GETCOUNT
  $out = @()
  for ($i = 0; $i -lt $n; $i++) {
    $len = [int][W32]::SendMessage($h, 0x149, [IntPtr]$i, [IntPtr]::Zero)   # CB_GETLBTEXTLEN
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [void][W32]::SendMessage($h, 0x148, [IntPtr]$i, $sb)                     # CB_GETLBTEXT
    $out += $sb.ToString()
  }
  $cur = [int][W32]::SendMessage($h, 0x147, [IntPtr]::Zero, [IntPtr]::Zero)    # CB_GETCURSEL
  [pscustomobject]@{ Items = $out; Current = $cur }
}
function Combo-Select([IntPtr]$h, [int]$idx) {
  [void][W32]::SendMessage($h, 0x14E, [IntPtr]$idx, [IntPtr]::Zero)            # CB_SETCURSEL
  $parent = [W32]::GetParent($h); $id = [W32]::GetDlgCtrlID($h)
  $wp = [IntPtr](($id -band 0xFFFF) -bor (1 -shl 16))                           # CBN_SELCHANGE = 1
  [void][W32]::SendMessage($parent, 0x111, $wp, $h)                             # WM_COMMAND
}
function Btn-Click([IntPtr]$h) { [void][W32]::SendMessage($h, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) }   # BM_CLICK
function Btn-Checked([IntPtr]$h) { [int][W32]::SendMessage($h, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero) }  # BM_GETCHECK
