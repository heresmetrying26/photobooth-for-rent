# Prints a test page through a print queue that uses the EPSON L8050 Series driver and writes to a FILE (no printer, no paper, no ink),
# then copies the job out. See README.md in this folder.
#
#   powershell -File capture.ps1 -Pattern hlines -Out C:\temp\bl_hlines.prn
#   -Pattern  white | black | vstripe | hstripe | hlines | frame
#   -Sets     driver options, e.g. 'psk:PageMediaSize=ns0000:Fullsize4x6;psk:PageBorderless=psk:Borderless;psk:PageMediaType=ns0000:EpsonPhotoPaperGlossy;psk:PageOutputQuality=ns0000:HighQuality'
#
# One-time set-up of the queue (as an administrator):
#   Add-PrinterPort -Name C:\temp\pb4u-cap8050.prn
#   Add-Printer -Name 'PB4U L8050 capture' -DriverName 'EPSON L8050 Series' -PortName C:\temp\pb4u-cap8050.prn
# and remove it again when done (Remove-Printer, Remove-PrinterPort).
param(
  [string]$Printer = 'PB4U L8050 capture',
  [string]$Port = 'C:\temp\pb4u-cap8050.prn',
  [string]$Out = '',
  [string]$Sets = 'psk:PageMediaSize=ns0000:Fullsize4x6;psk:PageBorderless=psk:Borderless;psk:PageMediaType=ns0000:EpsonPhotoPaperGlossy;psk:PageOutputQuality=ns0000:Standard',
  [string]$Paper = '10 x 15 cm (4 x 6 in)',
  [string]$Pattern = 'white'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Printing
Add-Type -AssemblyName ReachFramework
if (Test-Path $Port) { Remove-Item $Port -Force }
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $Printer
if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }
$pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
$tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
foreach ($pair in ($Sets -split ';' | Where-Object { $_ })) {
  $k, $v = $pair -split '=', 2
  $f = $tx.SelectSingleNode("//*[local-name()='Feature' and @name='$k']")
  if (-not $f) { Write-Output "feature not in ticket: $k"; continue }
  $f.SelectSingleNode("*[local-name()='Option']").SetAttribute('name', $v)
}
$ms = New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($tx.OuterXml))
$vt = $pq.MergeAndValidatePrintTicket($pq.UserPrintTicket, (New-Object System.Printing.PrintTicket($ms))).ValidatedPrintTicket
$dm = (New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)).ConvertPrintTicketToDevMode($vt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
$hd = [Runtime.InteropServices.Marshal]::AllocHGlobal($dm.Length)
[Runtime.InteropServices.Marshal]::Copy($dm, 0, $hd, $dm.Length)
$doc.PrinterSettings.SetHdevmode($hd); $doc.DefaultPageSettings.SetHdevmode($hd)
[Runtime.InteropServices.Marshal]::FreeHGlobal($hd)
$p = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $Paper } | Select-Object -First 1
if ($p) { $doc.DefaultPageSettings.PaperSize = $p }
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.DocumentName = 'pb4u-l8050-capture'
$W = 1200; $H = 1800
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
switch ($Pattern) {
  'black'   { $g.FillRectangle([System.Drawing.Brushes]::Black, 0, 0, $W, $H) }
  'vstripe' { $g.FillRectangle([System.Drawing.Brushes]::Black, [int]($W*0.40), 0, [int]($W*0.10), $H) }
  'hstripe' { $g.FillRectangle([System.Drawing.Brushes]::Black, 0, [int]($H*0.40), $W, [int]($H*0.10)) }
  # thin lines at 10 / 25 / 50 / 75 / 90 % of the page height: where each lands in the print area shows how the driver maps the page
  'hlines'  { foreach ($pp in 0.10,0.25,0.50,0.75,0.90) { $g.FillRectangle([System.Drawing.Brushes]::Black, 0, [int]($H*$pp), $W, 6) } }
  'frame'   { $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 24); $g.DrawRectangle($pen, 12, 12, $W-24, $H-24) }
  default   { }
}
$g.Dispose()
$doc.add_PrintPage({ param($s, $e) $e.Graphics.DrawImage($bmp, 0, 0, $e.PageBounds.Width, $e.PageBounds.Height); $e.HasMorePages = $false })
$doc.Print()
if ($Out) { $t = 0; while (-not (Test-Path $Port) -and $t -lt 30) { Start-Sleep 1; $t++ }; Start-Sleep 3; Copy-Item $Port $Out -Force; "saved $Out" }
