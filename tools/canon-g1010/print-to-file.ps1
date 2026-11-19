param([string]$Out, [string]$Media = "", [string]$Quality = "", [string]$Border = "", [string]$Expand = "", [switch]$Full, [switch]$DumpTicket)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Printing
Add-Type -AssemblyName ReachFramework -ErrorAction SilentlyContinue
$name = "Canon G1010 series"
$srv = New-Object System.Printing.LocalPrintServer
$q = $srv.GetPrintQueue($name)
$base = $q.UserPrintTicket
$sr = New-Object System.IO.StreamReader($base.GetXmlStream())
$xml = [xml]$sr.ReadToEnd()
if ($DumpTicket) { $xml.OuterXml; exit 0 }
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace("psf", "http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework")
function Set-Opt($feature, $optName) {
  $node = $xml.SelectSingleNode("//psf:Feature[@name='$feature']", $ns)
  if (-not $node) { Write-Output "feature $feature not in ticket"; return }
  $opt = $node.SelectSingleNode("psf:Option", $ns)
  if ($opt) { $opt.SetAttribute("name", $optName) | Out-Null; Write-Output "set $feature = $optName" }
}
Set-Opt "psk:PageMediaSize" "psk:NorthAmerica4x6"
if ($Media -ne "") { Set-Opt "psk:PageMediaType" $Media }
if ($Quality -ne "") { Set-Opt "psk:PageOutputQuality" $Quality }
if ($Border -ne "") { Set-Opt "psk:PageBorderless" $Border }
if ($Expand -ne "") { Set-Opt "ns0000:PageBorderlessExpandLevel" $Expand }
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.StreamWriter($ms); $w.Write($xml.OuterXml); $w.Flush(); $ms.Position = 0
$ticket = New-Object System.Printing.PrintTicket($ms)
$val = $q.MergeAndValidatePrintTicket($base, $ticket)
Write-Output ("validated media=" + $val.ValidatedPrintTicket.PageMediaType + " quality=" + $val.ValidatedPrintTicket.OutputQuality + " borderless=" + $val.ValidatedPrintTicket.PageBorderless)
$conv = New-Object System.Printing.Interop.PrintTicketConverter($name, $q.ClientPrintSchemaVersion)
$dm = $conv.ConvertPrintTicketToDevMode($val.ValidatedPrintTicket, [System.Printing.Interop.BaseDevModeType]::UserDefault)
Write-Output ("devmode bytes: " + $dm.Length)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class GM { [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint f, UIntPtr n); [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h); [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h); }
"@
$h = [GM]::GlobalAlloc(0x42, [UIntPtr]::new($dm.Length))
$p = [GM]::GlobalLock($h); [Runtime.InteropServices.Marshal]::Copy($dm, 0, $p, $dm.Length); [GM]::GlobalUnlock($h) | Out-Null
$ps = New-Object System.Drawing.Printing.PrinterSettings
$ps.PrinterName = $name
$ps.SetHdevmode($h)
$ps.PrintToFile = $true
$ps.PrintFileName = $Out
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings = $ps
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$doc.add_PrintPage({
  param($s, $e)
  $g = $e.Graphics; $bw = $e.PageBounds.Width; $bh = $e.PageBounds.Height
  $g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $bw, $bh)
  $br2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Rectangle(0,0,$bw,$bh)), [System.Drawing.Color]::FromArgb(255,230,120,60), [System.Drawing.Color]::FromArgb(255,40,90,200), 45.0)
  $g.FillRectangle($br2, 0, 0, $bw, $bh)
  $e.HasMorePages = $false
})
try { $doc.Print(); Write-Output "printed to file" } catch { Write-Output ("ERR: " + $_.Exception.Message) }
if (Test-Path $Out) { Write-Output ((Get-Item $Out).Length.ToString() + " bytes") } else { Write-Output "no output file" }
