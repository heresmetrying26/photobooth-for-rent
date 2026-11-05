param([string]$Printer = 'PB4U L3210 capture', [string]$Sets = '', [string]$Paper = '10 x 15 cm (4 x 6 in)')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Printing
Add-Type -AssemblyName ReachFramework
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
$pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
$tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
foreach ($pair in ($Sets -split ';' | Where-Object { $_ })) {
  $k, $v = $pair -split '=', 2
  $f = $tx.SelectSingleNode("//*[local-name()='Feature' and @name='$k']")
  if (-not $f) { Write-Output "feature not in ticket: $k"; continue }
  $o = $f.SelectSingleNode("*[local-name()='Option']")
  $o.SetAttribute('name', $v)
}
$ms = New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($tx.OuterXml))
$vt = $pq.MergeAndValidatePrintTicket($pq.UserPrintTicket, (New-Object System.Printing.PrintTicket($ms))).ValidatedPrintTicket
$vx = [xml]([IO.StreamReader]::new($vt.GetXmlStream()).ReadToEnd())
foreach ($f in $vx.SelectNodes("//*[local-name()='Feature']")) {
  if ($f.name -match 'PageOutputQuality|PageMediaType|PageMediaSize|PageResolution|PageBorderless|PageOutputColor') {
    $o = $f.SelectSingleNode("*[local-name()='Option']"); Write-Output ("validated {0} = {1}" -f $f.name, $o.name)
  }
}
$dm = (New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)).ConvertPrintTicketToDevMode($vt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
$hd = [Runtime.InteropServices.Marshal]::AllocHGlobal($dm.Length)
[Runtime.InteropServices.Marshal]::Copy($dm, 0, $hd, $dm.Length)
$doc.PrinterSettings.SetHdevmode($hd); $doc.DefaultPageSettings.SetHdevmode($hd)
[Runtime.InteropServices.Marshal]::FreeHGlobal($hd)
$p = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $Paper } | Select-Object -First 1
if ($p) { $doc.DefaultPageSettings.PaperSize = $p }
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.DocumentName = 'pb4u-capture'
$bmp = New-Object System.Drawing.Bitmap 1200, 1800
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$br = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(1200, 0)), [System.Drawing.Color]::DeepSkyBlue, [System.Drawing.Color]::OrangeRed)
$g.FillRectangle($br, 0, 0, 1200, 1800)
$g.FillRectangle([System.Drawing.Brushes]::Black, 100, 200, 1000, 300)
$g.DrawString('PB4U TEST', (New-Object System.Drawing.Font('Arial', 120, [System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::White, 150, 250)
$g.Dispose()
$doc.add_PrintPage({ param($s, $e) $e.Graphics.DrawImage($bmp, 0, 0, $e.PageBounds.Width, $e.PageBounds.Height); $e.HasMorePages = $false })
$doc.Print()
'printed'
