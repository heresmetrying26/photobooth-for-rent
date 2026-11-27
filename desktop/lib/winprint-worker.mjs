// Persistent warm Windows .NET print worker.
//
// Keeps one background PowerShell process alive with System.Drawing, System.Printing, ReachFramework,
// and PB4U.K32 already loaded so every Windows print job, paper-size query, and capability query skips
// cold PowerShell + .NET startup (~0.8-1.5 s saved per print).
//
// Protocol: UTF-8 newline-delimited JSON on stdin; framed replies prefixed with "__PBW__:" on stdout so
// stray driver or .NET output can never corrupt the channel. If the worker ever exits or fails to start,
// callers fall back seamlessly to one-shot PowerShell printing.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IS_WIN = process.platform === 'win32';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const FRAME_PREFIX = '__PBW__:';

// Single UTF-8 BOM helper (matches helper.mjs psFileText; Windows PowerShell 5.1 requires exactly one BOM).
const withSingleBom = (src) => '\uFEFF' + String(src == null ? '' : src).replace(/^\uFEFF+/, '');

export const WIN_PRINT_WORKER_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Drawing
try { Add-Type -AssemblyName System.Printing } catch { }
try { Add-Type -AssemblyName ReachFramework } catch { }
if (-not ('PB4U.K32' -as [type])) {
  Add-Type -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
[DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
[DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
'@ -Name K32 -Namespace PB4U
}

function Send-Frame($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine('__PBW__:' + $json)
  [Console]::Out.Flush()
}

function Handle-Paper($req) {
  $printer = [string]$req.printer
  $ps = New-Object System.Drawing.Printing.PrinterSettings
  $ps.PrinterName = $printer
  if (-not $ps.IsValid) { throw "Printer not found: $printer" }
  $def = [string]$ps.DefaultPageSettings.PaperSize.PaperName
  $sizes = New-Object System.Collections.ArrayList
  foreach ($p in $ps.PaperSizes) {
    if ($p.Width -gt 0 -and $p.Height -gt 0) {
      [void]$sizes.Add(@([string]$p.PaperName, [int]$p.Width, [int]$p.Height))
    }
  }
  return @{ id = $req.id; ok = $true; def = $def; sizes = @($sizes) }
}

function Handle-Caps($req) {
  $printer = [string]$req.printer
  $pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($printer)
  $tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
  $cx = [xml]([IO.StreamReader]::new($pq.GetPrintCapabilitiesAsXml()).ReadToEnd())
  $curNode = $tx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
  $cur = if ($curNode) { $curNode.GetAttribute('name') } else { '' }
  $opts = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']"))
  $media = New-Object System.Collections.ArrayList
  foreach ($o in $opts) {
    $nm = $o.GetAttribute('name')
    if (-not $nm) { continue }
    $dn = $o.SelectSingleNode("*[local-name()='Property' and @name='psf:DisplayName']/*[local-name()='Value']")
    $label = if ($dn) { [string]$dn.InnerText } else { '' }
    $sel = if ($nm -eq $cur) { 1 } else { 0 }
    [void]$media.Add(@([string]$nm, $label, $sel))
  }
  $blo = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']") | Where-Object { $_.GetAttribute('name') -eq 'psk:Borderless' })
  return @{ id = $req.id; ok = $true; borderless = ($blo.Count -gt 0); mediaTypes = @($media) }
}

function Handle-Print($req) {
  $logs = New-Object System.Collections.ArrayList
  $addLog = { param([string]$s) [void]$logs.Add($s) }

  $Printer = [string]$req.printer
  $files = @($req.files | Where-Object { $_ })
  if ($files.Count -eq 0) { throw "No pages to print" }
  $FitWidth = [bool]$req.fitWidth
  $PaperName = if ($req.paperName) { [string]$req.paperName } else { '' }
  $Quality = if ($req.quality) { [string]$req.quality } else { 'best' }
  $MediaType = if ($req.mediaType) { [string]$req.mediaType } else { '' }
  $Borderless = [bool]$req.borderless
  $DyeSub = [bool]$req.dyeSub
  $CustomW = if ($req.customW) { [int]$req.customW } else { 0 }
  $CustomH = if ($req.customH) { [int]$req.customH } else { 0 }
  $ActualW = if ($req.actualW) { [int]$req.actualW } else { 0 }
  $ActualH = if ($req.actualH) { [int]$req.actualH } else { 0 }
  $EpsonScale = if ($req.epsonScale) { [double]$req.epsonScale } else { 0.0 }

  $doc = New-Object System.Drawing.Printing.PrintDocument
  try {
    $doc.PrinterSettings.PrinterName = $Printer
    if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: $Printer" }

    $edgeScale = 1.0
    $l8050 = $false
    if ($EpsonScale -gt 0 -and $EpsonScale -lt 1 -and -not $DyeSub) {
      $dn = ''
      try { $dn = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer).QueueDriver.Name } catch { }
      if (-not $dn) { try { $dn = (Get-Printer -Name $Printer -ErrorAction Stop).DriverName } catch { } }
      if (("$Printer $dn") -match '(?<![a-z0-9])L[\s_-]?3210(?![0-9])') { $edgeScale = $EpsonScale }
      if (("$Printer $dn") -match '(?<![a-z0-9])L[\s_-]?8050(?![0-9])') { $l8050 = $true }
    }

    # Dye-sub drivers (DNP, HiTi, Citizen, Sinfonia, Mitsubishi...) keep 2-inch cut, matte/glossy finish
    # and factory color LUT in private DEVMODE bytes, so skip PrintTicketConverter mutations unless MediaType is explicit.
    if (-not $DyeSub -or $MediaType) {
      for ($ptTry = 0; $ptTry -lt 2; $ptTry++) {
        try {
          $pq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
          $tx = [xml]([IO.StreamReader]::new($pq.UserPrintTicket.GetXmlStream()).ReadToEnd())
          $tn = New-Object Xml.XmlNamespaceManager($tx.NameTable)
          $tn.AddNamespace('psf', 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework')
          $cx = [xml]([IO.StreamReader]::new($pq.GetPrintCapabilitiesAsXml()).ReadToEnd())
          if (-not $DyeSub) {
            $qo = @($cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageOutputQuality']/*[local-name()='Option']") | ForEach-Object { $_.name })
            $qpat = switch ($Quality) { 'draft' { 'Draft|Fast|Economy' } 'normal' { 'Normal|Standard' } default { 'HighQuality|Best|Photographic|^psk:High$' } }
            $best = $qo | Where-Object { $_ -match $qpat } | Select-Object -First 1
            $qf = $tx.SelectSingleNode("//psf:Feature[@name='psk:PageOutputQuality']/psf:Option", $tn)
            if ($best -and $qf -and $qf.GetAttribute('name') -ne $best) {
              $qf.SetAttribute('name', $best)
              $vt = $pq.MergeAndValidatePrintTicket($pq.UserPrintTicket, (New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($tx.OuterXml)))))).ValidatedPrintTicket
              $vx = [xml]([IO.StreamReader]::new($vt.GetXmlStream()).ReadToEnd())
              $vq = $vx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageOutputQuality']/*[local-name()='Option']")
              if ($vq -and $vq.GetAttribute('name') -eq $best) {
                $dm = (New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)).ConvertPrintTicketToDevMode($vt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
                $hd = [Runtime.InteropServices.Marshal]::AllocHGlobal($dm.Length)
                [Runtime.InteropServices.Marshal]::Copy($dm, 0, $hd, $dm.Length)
                $doc.PrinterSettings.SetHdevmode($hd); $doc.DefaultPageSettings.SetHdevmode($hd)
                [Runtime.InteropServices.Marshal]::FreeHGlobal($hd)
                & $addLog ('info|quality ' + $best)
              }
            }
          }
          if ($MediaType) {
            $mhas = $cx.SelectNodes("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']") | Where-Object { $_.GetAttribute('name') -eq $MediaType } | Select-Object -First 1
            if ($mhas) {
              $mconv = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $pq.ClientPrintSchemaVersion)
              $mh0 = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
              $mp = [PB4U.K32]::GlobalLock($mh0); $mn = ([PB4U.K32]::GlobalSize($mh0)).ToUInt32()
              $mb = New-Object byte[] $mn
              [Runtime.InteropServices.Marshal]::Copy($mp, $mb, 0, $mn)
              [void][PB4U.K32]::GlobalUnlock($mh0); [void][PB4U.K32]::GlobalFree($mh0)
              $mt0 = $mconv.ConvertDevModeToPrintTicket($mb)
              $mx = [xml]([IO.StreamReader]::new($mt0.GetXmlStream()).ReadToEnd())
              $mf = $mx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
              if ($mf -and $mf.GetAttribute('name') -ne $MediaType) {
                $mf.SetAttribute('name', $MediaType)
                $mvt = $pq.MergeAndValidatePrintTicket($mt0, (New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($mx.OuterXml)))))).ValidatedPrintTicket
                $mvx = [xml]([IO.StreamReader]::new($mvt.GetXmlStream()).ReadToEnd())
                $mvo = $mvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaType']/*[local-name()='Option']")
                if ($mvo -and $mvo.GetAttribute('name') -eq $MediaType) {
                  $mdm = $mconv.ConvertPrintTicketToDevMode($mvt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
                  $mhd = [Runtime.InteropServices.Marshal]::AllocHGlobal($mdm.Length)
                  [Runtime.InteropServices.Marshal]::Copy($mdm, 0, $mhd, $mdm.Length)
                  $doc.PrinterSettings.SetHdevmode($mhd); $doc.DefaultPageSettings.SetHdevmode($mhd)
                  [Runtime.InteropServices.Marshal]::FreeHGlobal($mhd)
                  & $addLog ('info|mediaType ' + $MediaType)
                } else { & $addLog ('warn|Printer driver did not accept paper type "' + $MediaType + '".') }
              }
            }
          }
          break
        } catch {
          if ($ptTry -eq 0) { Start-Sleep -Milliseconds 200 }
          else { & $addLog ('info|print ticket not applied: ' + $_.Exception.Message) }
        }
      }
    }

    if ($PaperName) {
      $p = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $PaperName } | Select-Object -First 1
      if ($p) { $doc.DefaultPageSettings.PaperSize = $p }
    }

    $customApplied = $false
    if ($CustomW -gt 0 -and $CustomH -gt 0 -and -not $PaperName) {
      try {
        $cq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
        $cc = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $cq.ClientPrintSchemaVersion)
        $ch = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
        $cp = [PB4U.K32]::GlobalLock($ch); $cn = ([PB4U.K32]::GlobalSize($ch)).ToUInt32()
        $cb = New-Object byte[] $cn
        [Runtime.InteropServices.Marshal]::Copy($cp, $cb, 0, $cn)
        [void][PB4U.K32]::GlobalUnlock($ch); [void][PB4U.K32]::GlobalFree($ch)
        $cwMic = [int]($CustomW * 254); $chMic = [int]($CustomH * 254)
        $cxml = '<psf:PrintTicket xmlns:psf="http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework" xmlns:psk="http://schemas.microsoft.com/windows/2003/08/printing/printschemakeywords" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" version="1"><psf:Feature name="psk:PageMediaSize"><psf:Option name="psk:CustomMediaSize"><psf:ScoredProperty name="psk:MediaSizeWidth"><psf:ParameterRef name="psk:PageMediaSizeMediaSizeWidth"/></psf:ScoredProperty><psf:ScoredProperty name="psk:MediaSizeHeight"><psf:ParameterRef name="psk:PageMediaSizeMediaSizeHeight"/></psf:ScoredProperty></psf:Option></psf:Feature><psf:ParameterInit name="psk:PageMediaSizeMediaSizeWidth"><psf:Value xsi:type="xsd:integer">__W__</psf:Value></psf:ParameterInit><psf:ParameterInit name="psk:PageMediaSizeMediaSizeHeight"><psf:Value xsi:type="xsd:integer">__H__</psf:Value></psf:ParameterInit></psf:PrintTicket>'
        $cxml = $cxml.Replace('__W__', [string]$cwMic).Replace('__H__', [string]$chMic)
        $cwant = New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($cxml))))
        $cvt = $cq.MergeAndValidatePrintTicket($cc.ConvertDevModeToPrintTicket($cb), $cwant).ValidatedPrintTicket
        $cvx = [xml]([IO.StreamReader]::new($cvt.GetXmlStream()).ReadToEnd())
        $cvo = $cvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageMediaSize']/*[local-name()='Option']")
        $cvw = $cvx.SelectSingleNode("//*[local-name()='ParameterInit' and @name='psk:PageMediaSizeMediaSizeWidth']")
        $cvh = $cvx.SelectSingleNode("//*[local-name()='ParameterInit' and @name='psk:PageMediaSizeMediaSizeHeight']")
        if ($cvo -and $cvo.GetAttribute('name') -eq 'psk:CustomMediaSize' -and $cvw -and $cvh -and [int]$cvw.InnerText -eq $cwMic -and [int]$cvh.InnerText -eq $chMic) {
          $cm = $cc.ConvertPrintTicketToDevMode($cvt, [System.Printing.Interop.BaseDevModeType]::UserDefault)
          $chd = [Runtime.InteropServices.Marshal]::AllocHGlobal($cm.Length)
          [Runtime.InteropServices.Marshal]::Copy($cm, 0, $chd, $cm.Length)
          $doc.PrinterSettings.SetHdevmode($chd); $doc.DefaultPageSettings.SetHdevmode($chd)
          [Runtime.InteropServices.Marshal]::FreeHGlobal($chd)
          $cur = $doc.DefaultPageSettings.PaperSize
          $np = New-Object System.Drawing.Printing.PaperSize($cur.PaperName, $CustomW, $CustomH)
          $np.RawKind = $cur.RawKind
          $doc.DefaultPageSettings.PaperSize = $np
          $customApplied = $true
          & $addLog ('info|custom paper ' + $CustomW + 'x' + $CustomH + ' (1/100 in) set on the driver')
        } else { & $addLog ('warn|Printer driver did not accept custom paper size (' + [Math]::Round($CustomW / 100, 2) + 'x' + [Math]::Round($CustomH / 100, 2) + ' in); printed using "' + $doc.DefaultPageSettings.PaperSize.PaperName + '". Set up this custom size in Configure printer if needed.') }
      } catch { & $addLog ('warn|Custom paper size could not be applied: ' + $_.Exception.Message) }
    }

    if ($Borderless -and -not $DyeSub) {
      try {
        $bq = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($Printer)
        $bc = New-Object System.Printing.Interop.PrintTicketConverter($Printer, $bq.ClientPrintSchemaVersion)
        $bh = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
        $bp = [PB4U.K32]::GlobalLock($bh); $bn = ([PB4U.K32]::GlobalSize($bh)).ToUInt32()
        $bb = New-Object byte[] $bn
        [Runtime.InteropServices.Marshal]::Copy($bp, $bb, 0, $bn)
        [void][PB4U.K32]::GlobalUnlock($bh); [void][PB4U.K32]::GlobalFree($bh)
        $bt = $bc.ConvertDevModeToPrintTicket($bb)
        $bx = [xml]([IO.StreamReader]::new($bt.GetXmlStream()).ReadToEnd())
        $bf = $bx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']")
        $bcx = [xml]([IO.StreamReader]::new($bq.GetPrintCapabilitiesAsXml()).ReadToEnd())
        $bhas = $bcx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option' and @name='psk:Borderless']")
        if ($bf -and $bhas -and $bf.GetAttribute('name') -ne 'psk:Borderless') {
          $bf.SetAttribute('name', 'psk:Borderless')
          $bd = New-Object System.Printing.PrintTicket((New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($bx.OuterXml))))
          $bv = $bq.MergeAndValidatePrintTicket($bt, $bd).ValidatedPrintTicket
          $bvx = [xml]([IO.StreamReader]::new($bv.GetXmlStream()).ReadToEnd())
          $bvo = $bvx.SelectSingleNode("//*[local-name()='Feature' and @name='psk:PageBorderless']/*[local-name()='Option']")
          if ($bvo -and $bvo.GetAttribute('name') -eq 'psk:Borderless') {
            $bm = $bc.ConvertPrintTicketToDevMode($bv, [System.Printing.Interop.BaseDevModeType]::UserDefault)
            $bhd = [Runtime.InteropServices.Marshal]::AllocHGlobal($bm.Length)
            [Runtime.InteropServices.Marshal]::Copy($bm, 0, $bhd, $bm.Length)
            $doc.PrinterSettings.SetHdevmode($bhd); $doc.DefaultPageSettings.SetHdevmode($bhd)
            [Runtime.InteropServices.Marshal]::FreeHGlobal($bhd)
            & $addLog 'info|borderless switched on'
          } else { & $addLog 'info|driver did not accept Borderless on this paper' }
        }
      } catch { & $addLog ('info|borderless not set: ' + $_.Exception.Message) }
    }

    $l8050Mode = ''; $l8050Level = 2
    if ($l8050) {
      try {
        $xh = $doc.PrinterSettings.GetHdevmode($doc.DefaultPageSettings)
        $xp = [PB4U.K32]::GlobalLock($xh); $xn = ([PB4U.K32]::GlobalSize($xh)).ToUInt32()
        $xb = New-Object byte[] $xn
        [Runtime.InteropServices.Marshal]::Copy($xp, $xb, 0, $xn)
        [void][PB4U.K32]::GlobalUnlock($xh); [void][PB4U.K32]::GlobalFree($xh)
        if ($xn -ge 8192 -and [BitConverter]::ToUInt16($xb, 66) -eq 768 -and [BitConverter]::ToUInt16($xb, 68) -eq 220 -and [BitConverter]::ToUInt16($xb, 70) -eq 7972 -and $xb[7940] -le 2 -and $xb[7942] -le 1) {
          $l8050Mode = if ($xb[7942] -eq 1) { 'retain' } else { 'auto' }; $l8050Level = [int]$xb[7940]
          & $addLog ('info|Epson L8050 driver Borderless setting: ' + $(if ($l8050Mode -eq 'retain') { 'Retain Size' } else { 'Auto Expand, ' + @('Min', 'Med', 'Std')[$l8050Level] }))
        } else { & $addLog 'info|Epson L8050 driver settings have another layout than the one measured: Auto Expand, Std assumed' }
      } catch { & $addLog ('info|Epson L8050 Borderless setting not read: ' + $_.Exception.Message) }
    }

    $doc.DocumentName = 'photobooth4u'
    $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
    $doc.OriginAtMargins = $false
    $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
    $state = @{ idx = 0 }
    $doc.add_PrintPage({
      param($sender, $e)
      $img = [System.Drawing.Image]::FromFile($files[$state.idx])
      try {
        if ($FitWidth) {
          $pa = $e.PageSettings.PrintableArea
          $w = [single]$pa.Width; $h = [single]($w * $img.Height / $img.Width)
          if ($pa.Height -gt 0 -and $h -gt $pa.Height) { $h = [single]$pa.Height; $w = [single]($h * $img.Width / $img.Height) }
          $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $e.Graphics.DrawImage($img, [single](($pa.Width - $w) / 2), [single]0, $w, $h)
          $state.idx++
          $e.HasMorePages = ($state.idx -lt $files.Count)
          return
        }
        $page = $e.PageBounds
        $pageLandscape = $page.Width -gt $page.Height
        $imgLandscape = $img.Width -gt $img.Height
        if ($pageLandscape -ne $imgLandscape) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
        $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $e.Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $ia = New-Object System.Drawing.Imaging.ImageAttributes
        $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $drawCrisp = {
          param([single]$dx, [single]$dy, [single]$dw, [single]$dh)
          $pts = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new($dx, $dy),
            [System.Drawing.PointF]::new($dx + $dw, $dy),
            [System.Drawing.PointF]::new($dx, $dy + $dh)
          )
          $srcRect = New-Object System.Drawing.RectangleF 0, 0, ([single]$img.Width), ([single]$img.Height)
          $e.Graphics.DrawImage($img, $pts, $srcRect, [System.Drawing.GraphicsUnit]::Pixel, $ia)
        }
        try {
          $hx = $e.PageSettings.HardMarginX; $hy = $e.PageSettings.HardMarginY
          $vis = $e.Graphics.VisibleClipBounds; $pa = $e.PageSettings.PrintableArea
          $paW = if (($pa.Width -gt $pa.Height) -ne $pageLandscape) { $pa.Height } else { $pa.Width }
          $paH = if (($pa.Width -gt $pa.Height) -ne $pageLandscape) { $pa.Width } else { $pa.Height }
          $clip = New-Object System.Drawing.RectangleF $vis.X, $vis.Y, ([Math]::Min($vis.Width, $paW)), ([Math]::Min($vis.Height, $paH))
          & $addLog ('info|sheet {0}x{1}, printable {2}x{3} at {4},{5}, hard margin {6},{7} (1/100 in)' -f $page.Width, $page.Height, $clip.Width, $clip.Height, $clip.X, $clip.Y, $hx, $hy)
          $aw = 0; $ah = 0
          if ($ActualW -gt 0 -and $ActualH -gt 0) { if ($pageLandscape) { $aw = $ActualH; $ah = $ActualW } else { $aw = $ActualW; $ah = $ActualH } }
          $fullBleed = ($clip.Width -ge $page.Width * 0.99 -and $clip.Height -ge $page.Height * 0.99) -or ($DyeSub -and $aw -le 0 -and $clip.Width -ge $page.Width * 0.92 -and $clip.Height -ge $page.Height * 0.92)
          if ($fullBleed) {
            if ($edgeScale -lt 1) { & $addLog ('info|Epson L3210 borderless: picture drawn at {0}% so the driver''s enlargement does not trim the edges' -f [Math]::Round($edgeScale * 100, 1)) }
            $shortU = [Math]::Min($page.Width, $page.Height); $longU = [Math]::Max($page.Width, $page.Height)
            if ($l8050 -and $aw -le 0 -and [Math]::Abs($shortU - 400) -le 3 -and [Math]::Abs($longU - 600) -le 3 -and [Math]::Abs(($page.Width / $page.Height) / ($img.Width / $img.Height) - 1) -le 0.04) {
              $encl = 3032 / 2880
              $um = $shortU / 101.6
              $bl = 0.5 * $um; $dyc = (18 / 720 * 25.4) * $um
              if ($l8050Mode -eq 'auto' -and $l8050Level -eq 1) { $encl = 2956 / 2880; $dyc = (9 / 720 * 25.4) * $um }
              elseif ($l8050Mode -eq 'auto' -and $l8050Level -eq 0) { $encl = 2920 / 2880; $dyc = (5 / 720 * 25.4) * $um }
              if ($pageLandscape) { $bl = 0.7 * $um; $bw = [single](($page.Width + 2 * $bl) / $encl); $bh = [single](($page.Height + 2 * $bl) / $encl); $cx = $page.Width / 2; $cy = $page.Height / 2 }
              else { $bw = [single](($page.Width + 2 * $bl) / $encl); $bh = [single](($page.Height + 2 * $bl) / $encl); $cx = $page.Width / 2; $cy = $page.Height / 2 - $dyc / $encl }
              if ($l8050Mode -eq 'retain' -and -not $pageLandscape) {
                $px = $shortU / 2880
                $rx0 = 76 * $px - $bl; $ry0 = 22 * $px - $bl
                & $addLog 'warn|The Epson L8050 driver is set to Retain Size (Printing preferences > Borderless > Settings), so the right and bottom edge of the print keep a white strip of about 3 mm. Choose Auto Expand with the slider on Std there.'
                & $drawCrisp ([single](-$hx + $rx0)) ([single](-$hy + $ry0)) ([single]($page.Width - $rx0)) ([single]($page.Height - $ry0))
              } else {
                & $addLog ('info|Epson L8050 borderless 4x6: picture drawn at {0}% across and {1}% along so the driver''s enlargement does not trim the edges' -f [Math]::Round($bw / $page.Width * 100, 1), [Math]::Round($bh / $page.Height * 100, 1))
                & $drawCrisp ([single](-$hx + $cx - $bw / 2)) ([single](-$hy + $cy - $bh / 2)) $bw $bh
              }
            } elseif ($aw -le 0 -and [Math]::Abs(($page.Width / $page.Height) / ($img.Width / $img.Height) - 1) -le 0.04) {
              $bw = [single]($page.Width * $edgeScale); $bh = [single]($page.Height * $edgeScale)
              & $drawCrisp ([single](-$hx + ($page.Width - $bw) / 2)) ([single](-$hy + ($page.Height - $bh) / 2)) $bw $bh
            } else {
              if ($aw -gt 0) { $rs = [Math]::Min([Math]::Min($page.Width / $aw, $page.Height / $ah) * $edgeScale, 1.0); $w = [single]($aw * $rs); $h = [single]($ah * $rs) }
              else { $rs = [Math]::Min($page.Width / $img.Width, $page.Height / $img.Height) * $edgeScale; $w = [single]($img.Width * $rs); $h = [single]($img.Height * $rs) }
              & $drawCrisp ([single](-$hx + ($page.Width - $w) / 2)) ([single](-$hy + ($page.Height - $h) / 2)) $w $h
            }
          } else {
            $s = [Math]::Min($clip.Width / $img.Width, $clip.Height / $img.Height)
            $sc = [Math]::Max($clip.Width / $img.Width, $clip.Height / $img.Height)
            if ($customApplied -and ($s / $sc) -ge 0.95) {
              $sw = [single]($clip.Width / $sc); $sh = [single]($clip.Height / $sc)
              $src = New-Object System.Drawing.RectangleF ([single](($img.Width - $sw) / 2)), ([single](($img.Height - $sh) / 2)), $sw, $sh
              $dst = New-Object System.Drawing.RectangleF $clip.X, $clip.Y, $clip.Width, $clip.Height
              $e.Graphics.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
            } else {
              if ($aw -gt 0) { $rs = [Math]::Min([Math]::Min($clip.Width / $aw, $clip.Height / $ah), 1.0); $w = [single]($aw * $rs); $h = [single]($ah * $rs) }
              else { $w = [single]($img.Width * $s); $h = [single]($img.Height * $s) }
              & $drawCrisp ([single]($clip.X + ($clip.Width - $w) / 2)) ([single]($clip.Y + ($clip.Height - $h) / 2)) $w $h
            }
          }
        } finally { $ia.Dispose() }
      } finally { $img.Dispose() }
      $state.idx++
      $e.HasMorePages = ($state.idx -lt $files.Count)
    })
    $doc.Print()
  } finally {
    try { $doc.Dispose() } catch { }
  }
  return @{ id = $req.id; ok = $true; logs = @($logs) }
}

Send-Frame @{ ready = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $cmd = [string]$req.cmd
    if ($cmd -eq 'quit') { Send-Frame @{ id = $req.id; ok = $true }; break }
    elseif ($cmd -eq 'ping') { Send-Frame @{ id = $req.id; ok = $true; pong = $true } }
    elseif ($cmd -eq 'paper') { Send-Frame (Handle-Paper $req) }
    elseif ($cmd -eq 'caps') { Send-Frame (Handle-Caps $req) }
    elseif ($cmd -eq 'print') { Send-Frame (Handle-Print $req) }
    else { Send-Frame @{ id = $req.id; ok = $false; error = ('Unknown command: ' + $cmd) } }
  } catch {
    $rid = if ($req -and $null -ne $req.id) { $req.id } else { 0 }
    Send-Frame @{ id = $rid; ok = $false; error = [string]$_.Exception.Message; logs = @() }
  }
}
`;

/**
 * Creates a persistent warm Windows .NET print worker controller.
 * Safe to instantiate on any OS (all operations fail cleanly with unsupported on non-Windows).
 */
export function createWinPrintWorker({ logger = () => { }, bootTimeoutMs = 25000 } = {}) {
  let proc = null;
  let scriptDir = '';
  let starting = null;
  let seq = 0;
  let buf = '';
  let inflight = null; // { id, resolve, reject, timer }
  let queue = Promise.resolve();
  let stopped = false;

  function cleanupDir(dir) {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => { });
  }

  function transportErr(msg) {
    const e = new Error(msg || 'Windows print worker unavailable');
    e.workerTransport = true;
    return e;
  }

  function reset(reason) {
    const oldProc = proc;
    const oldDir = scriptDir;
    proc = null;
    scriptDir = '';
    buf = '';
    if (inflight) {
      const cur = inflight;
      inflight = null;
      clearTimeout(cur.timer);
      cur.reject(transportErr(reason || 'Windows print worker stopped'));
    }
    if (oldProc) {
      try { oldProc.kill(); } catch { /* ignore */ }
    }
    if (oldDir) cleanupDir(oldDir);
  }

  function handleLine(line, onReady) {
    if (!line.startsWith(FRAME_PREFIX)) return;
    let msg = null;
    try { msg = JSON.parse(line.slice(FRAME_PREFIX.length)); } catch { return; }
    if (msg && msg.ready) {
      if (onReady) onReady();
      return;
    }
    if (inflight && msg && Number(msg.id) === inflight.id) {
      const cur = inflight;
      inflight = null;
      clearTimeout(cur.timer);
      cur.resolve(msg);
    }
  }

  async function ensureStarted() {
    if (!IS_WIN) throw transportErr('Persistent Windows print worker is Windows-only.');
    if (stopped) throw transportErr('Windows print worker is stopped.');
    if (proc && !proc.killed && proc.exitCode === null) return;
    if (starting) return starting;

    starting = (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pb4u-wpw-'));
      const ps1 = join(dir, 'print-worker.ps1');
      await writeFile(ps1, withSingleBom(WIN_PRINT_WORKER_PS), 'utf8');

      let readyResolve = null;
      let readyReject = null;
      const readyP = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
      let readyDone = false;
      const markReady = () => { if (!readyDone) { readyDone = true; readyResolve(); } };
      const failReady = (err) => { if (!readyDone) { readyDone = true; readyReject(err); } };

      const child = spawn('powershell.exe', [...PS_ARGS, '-File', ps1], { windowsHide: true });
      proc = child;
      scriptDir = dir;
      buf = '';
      let stderrTail = '';

      child.stdout.on('data', (chunk) => {
        if (proc !== child) return;
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          handleLine(line, markReady);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
      });
      child.on('error', (err) => {
        failReady(transportErr('Print worker spawn error: ' + (err && err.message || err)));
        if (proc === child) reset('Print worker spawn error: ' + (err && err.message || err));
      });
      child.on('close', (code) => {
        failReady(transportErr('Print worker exited during start (code ' + code + (stderrTail ? ': ' + stderrTail.trim() : '') + ')'));
        if (proc === child) reset('Print worker exited (code ' + code + ')');
      });

      const bootTimer = setTimeout(() => {
        failReady(transportErr('Print worker start timeout'));
        if (proc === child) reset('Print worker start timeout');
      }, Math.max(3000, Number(bootTimeoutMs) || 25000));

      try {
        await readyP;
        logger('Windows warm print worker ready.');
      } finally {
        clearTimeout(bootTimer);
      }
    })().finally(() => { starting = null; });

    return starting;
  }

  function callWorker(payload, timeoutMs = 60000) {
    const runOne = async () => {
      await ensureStarted();
      if (!proc || !proc.stdin || proc.stdin.destroyed) throw transportErr('Print worker stdin unavailable');
      const id = ++seq;
      const req = { ...payload, id };
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (inflight && inflight.id === id) {
            reset('Print worker timed out on ' + payload.cmd);
          }
        }, Math.max(1000, Number(timeoutMs) || 60000));
        inflight = { id, resolve, reject, timer };
        try {
          proc.stdin.write(JSON.stringify(req) + '\n', 'utf8');
        } catch (err) {
          reset('Print worker write failed: ' + (err && err.message || err));
        }
      });
    };
    const next = queue.then(runOne, runOne);
    queue = next.catch(() => { });
    return next;
  }

  return {
    isRunning: () => !!(proc && !proc.killed && proc.exitCode === null),
    warm() {
      if (!IS_WIN || stopped) return Promise.resolve(false);
      return ensureStarted().then(() => true).catch((e) => {
        logger('Windows warm print worker failed to pre-warm (will retry / fallback): ' + (e && e.message || e));
        return false;
      });
    },
    async ping(timeoutMs = 10000) {
      const r = await callWorker({ cmd: 'ping' }, timeoutMs);
      return !!(r && r.ok && r.pong);
    },
    async paperSizes(printer, timeoutMs = 15000) {
      const r = await callWorker({ cmd: 'paper', printer }, timeoutMs);
      if (!r || !r.ok) throw new Error((r && r.error) || 'Paper query failed');
      return { def: r.def || null, sizes: Array.isArray(r.sizes) ? r.sizes : [] };
    },
    async printerCaps(printer, timeoutMs = 15000) {
      const r = await callWorker({ cmd: 'caps', printer }, timeoutMs);
      if (!r || !r.ok) throw new Error((r && r.error) || 'Caps query failed');
      return { borderless: !!r.borderless, mediaTypes: Array.isArray(r.mediaTypes) ? r.mediaTypes : [] };
    },
    async print(opts, timeoutMs = 90000) {
      const r = await callWorker({ cmd: 'print', ...opts }, timeoutMs);
      if (!r || !r.ok) throw new Error((r && r.error) || 'Print failed');
      return { logs: Array.isArray(r.logs) ? r.logs : [] };
    },
    stop() {
      stopped = true;
      if (proc && proc.stdin && !proc.stdin.destroyed) {
        try { proc.stdin.write(JSON.stringify({ id: ++seq, cmd: 'quit' }) + '\n', 'utf8'); } catch { /* ignore */ }
      }
      reset('Stopped');
    }
  };
}
