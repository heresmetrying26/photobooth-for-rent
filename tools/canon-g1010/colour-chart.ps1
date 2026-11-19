param([string]$Out, [string]$Media = "psk:Plain", [string]$Quality = "psk:Normal")
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Printing
Add-Type -AssemblyName ReachFramework -ErrorAction SilentlyContinue
$name = "Canon G1010 series"
$srv = New-Object System.Printing.LocalPrintServer
$q = $srv.GetPrintQueue($name)
$base = $q.UserPrintTicket
$sr = New-Object System.IO.StreamReader($base.GetXmlStream())
$xml = [xml]$sr.ReadToEnd()
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace("psf", "http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework")
function Set-Opt($feature, $optName) {
  $node = $xml.SelectSingleNode("//psf:Feature[@name='$feature']", $ns)
  if ($node) { $opt = $node.SelectSingleNode("psf:Option", $ns); if ($opt) { $opt.SetAttribute("name", $optName) | Out-Null } }
}
Set-Opt "psk:PageMediaSize" "psk:NorthAmerica4x6"
Set-Opt "psk:PageMediaType" $Media
Set-Opt "psk:PageOutputQuality" $Quality
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.StreamWriter($ms); $w.Write($xml.OuterXml); $w.Flush(); $ms.Position = 0
$ticket = New-Object System.Printing.PrintTicket($ms)
$val = $q.MergeAndValidatePrintTicket($base, $ticket)
$conv = New-Object System.Printing.Interop.PrintTicketConverter($name, $q.ClientPrintSchemaVersion)
$dm = $conv.ConvertPrintTicketToDevMode($val.ValidatedPrintTicket, [System.Printing.Interop.BaseDevModeType]::UserDefault)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class GM2 { [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint f, UIntPtr n); [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h); [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h); }
"@
$h = [GM2]::GlobalAlloc(0x42, [UIntPtr]::new($dm.Length))
$p = [GM2]::GlobalLock($h); [Runtime.InteropServices.Marshal]::Copy($dm, 0, $p, $dm.Length); [GM2]::GlobalUnlock($h) | Out-Null
$ps = New-Object System.Drawing.Printing.PrinterSettings
$ps.PrinterName = $name
$ps.SetHdevmode($h)
$ps.PrintToFile = $true
$ps.PrintFileName = $Out
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings = $ps
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$levels = @(0,32,64,96,128,160,192,224,255)
$doc.add_PrintPage({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $bw = $e.PageBounds.Width; $bh = $e.PageBounds.Height
  $g.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $bw, $bh)
  $pw = 11.0; $ph = 17.0; $x0 = 40.0; $y0 = 40.0; $fr = 4.0
  $g.FillRectangle([System.Drawing.Brushes]::Black, [single]($x0 - $fr), [single]($y0 - $fr), [single](27 * $pw + 2 * $fr), [single](27 * $ph + 2 * $fr))
  for ($i = 0; $i -lt 729; $i++) {
    $r = $levels[[int][math]::Floor($i / 81)]; $gg = $levels[[int][math]::Floor(($i % 81) / 9)]; $b = $levels[$i % 9]
    $col = $i % 27; $row = [int][math]::Floor($i / 27)
    $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $r, $gg, $b))
    $g.FillRectangle($br, [single]($x0 + $col * $pw), [single]($y0 + $row * $ph), [single]$pw, [single]$ph)
    $br.Dispose()
  }
  $e.HasMorePages = $false
})
try { $doc.Print(); Write-Output "printed" } catch { Write-Output ("ERR: " + $_.Exception.Message) }
if (Test-Path $Out) { Write-Output ((Get-Item $Out).Length.ToString() + " bytes") } else { Write-Output "no output" }
