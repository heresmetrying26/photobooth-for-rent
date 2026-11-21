# Epson L8050: what the Windows driver sends for 4 x 6 in borderless

The L8050 is not a small L3210: its Windows driver (`e1wf1b0e.inf`, "EPSON L8050 Series") writes **ESC/P-R** (`setq`, `setj`,
`sttp`, `bsnd` ...), not the older `ESC ( U ...` raster that `tools/epson-raster` decodes for the L3210. The page set-up is plain
and readable, which is what this folder is for. The band data (`bsnd`) is compressed and is not decoded here.

`capture.ps1` prints a test page through a queue that uses the L8050 driver and a **file port** (no printer, no paper, no ink).
`escpr_dump.py` reads the job. Both ran on 2026-11-20 on the booth laptop (the driver is installed there; no L8050 is attached).

## Page set-up the driver writes (`setj`, 720 dpi)

| 4 x 6 in | sheet | print area | area starts (top, left) | past the sheet: left / right / top / bottom |
|---|---|---|---|---|
| bordered | 2880 x 4320 | 2712 x 4152 (3.767 x 5.767 in) | +84, +84 | 2.96 mm inside on every side |
| **borderless** | 2880 x 4320 | **3032 x 4400 (4.211 x 6.111 in)** | **-22, -76** | **2.68 / 2.68 / 0.78 / 2.05 mm** |

* Same borderless numbers for Epson Photo Paper Glossy, semi-gloss, high-gloss, matte **and plain**, at every quality
  (Draft is the same area at 360 dpi: 1440 x 2160 sheet, 1516 x 2200 area, -11, -38).
* `setq` byte 0 is the paper (0x34 Epson Photo Paper Glossy, 0x0b high-gloss, 0x0c semi-gloss, 0x05 matte, 0x00 plain), byte 1 the
  quality (0 draft, 1 standard, 2 high). `setm` byte 1 is 1 for borderless, 0 for bordered.

## How the driver maps the page onto that area

Thin black lines at 10, 25, 50, 75 and 90 % of the page height (`-Pattern hlines`) landed at rows 376-407, 1064-1080, 2200-2216,
3336-3352 and 4008-4040 of the 4400-row area. The model `row = -74 + 4548 x fraction` (the page enlarged **5.28 % in both
directions**, 3032 / 2880, about the middle of the area) gives 381, 1063, 2200, 3337 and 4019. Stretching the page to the area
(1.0185 along) would give 440 / 1100 / 2200 / 3300 / 3960, which does not fit.

So the driver enlarges the page 5.28 % and the sheet only shows part of it. Of the page, a Windows L8050 print loses about
**2.55 mm on the left and right, 3.2 mm at the top and 4.4 mm at the bottom** unless the picture is drawn smaller first.

## What each platform does with it

* **Mac** (`desktop/lib/helper.mjs`, `MAC_EPSON_L8050_4X6`): measured on real paper, and it agrees with the driver: y 0.9496 is
  1 / 1.0528 = 0.9498; dy -0.0045 is the area's middle sitting 0.64 mm below the sheet's middle (the numbers say -0.0040).
  x 0.9608 keeps about 0.6 mm of bleed on each side.
* **Windows desktop app** (`desktop/lib/helper.mjs`, `WIN_EPSON_L8050_4X6` and the `$l8050` branch of the print script): fixed
  2026-11-20. Before, only the L3210 was compensated and an L8050 4x6 borderless print lost the edges listed above (run through the
  app's own print script into the driver's file port, the picture's top and bottom edge lines never reached the print area). Now a 4x6
  picture is drawn 1 / 1.0528 smaller, 0.64 mm higher, and 0.5 mm bigger than the sheet on every side (0.7 mm both ways for a page the
  driver is set to Landscape, whose turn direction is not known). The same script run into the file port after the change put the top
  edge line at area rows 9-25, the middle at 2175-2190 and the bottom at 4345-4358, as the model predicts (sheet = rows 22-4342).
  Checked without paper by `desktop/test/test-win-l8050.mjs` (numbers tied to the driver's bytes) and that run; **not tried on a real
  L8050 sheet**, and the left/right edges cannot be read from the band data (they follow from the same enlargement, symmetric).
  Other paper sizes are not compensated, nor is the standalone `tools/print-helper/print-helper.js`, which has no Epson compensation.
* **Android, IPP** (`protected/src/printer/epson-l8050.js`): the client's print had a ~3 mm white strip on one side and the
  opposite side cut, which is what a 1:1 page does if the printer starts it at the corner of the area (2.68 mm left of the sheet)
  instead of the corner of the sheet. The booth now sends the picture on a 4.21 x 6.11 in page, 2.68 / 0.78 mm in from the corner,
  with the strips filled from the picture's edge pixels. **Not tried on a real L8050.** If a real print shows the page is placed
  differently, change `GEO` in that file; `scripts/test-epson-l8050.mjs` ties it to the driver numbers above.
* **Android, raw ESC/P-R** (`EscprJob.kt`, `printEpsonL` / `printEscpr`): still uses the L805's numbers (36 / 42 at 360 dpi) and the
  `dsnd` RGB rows, not the `bsnd` bands the L8050 driver writes. Left alone.

## Re-running it

```
Add-PrinterPort -Name C:\temp\pb4u-cap8050.prn
Add-Printer -Name 'PB4U L8050 capture' -DriverName 'EPSON L8050 Series' -PortName C:\temp\pb4u-cap8050.prn
powershell -File capture.ps1 -Pattern hlines -Out C:\temp\bl_hlines.prn
python escpr_dump.py C:\temp\bl_hlines.prn
Remove-Printer -Name 'PB4U L8050 capture'; Remove-PrinterPort -Name C:\temp\pb4u-cap8050.prn
```

## Borderless > Settings: Auto Expand (Min / Med / Std) and Retain Size (2026-11-21)

A client's 4R print had a white strip of 3-5 mm along two sides and the Edge test showed the picture shifted; her driver was on **Retain Size**
(Printing preferences > Borderless > Settings). That dialog ("Expansion") has *Method of Enlargement* (Auto Expand / Retain Size) and a slider
(Min / Med / Std, Std is the default). The driver keeps them in its own bytes of the page settings (DEVMODE, 8192 bytes: 220 public + 7972 driver
bytes): **byte 7940 = slider (0 Min, 1 Med, 2 Std), byte 7942 = method (0 Auto Expand, 1 Retain Size)**, found by changing the setting with
`expansion.ps1` and diffing `HKCU\Printers\DevModePerUser\<queue>` (byte 7988 also moves with the slider: a check value, not used).

`expansion.ps1` (with `win32ui.ps1`) opens the queue's Printing preferences, picks 10 x 15 cm and Borderless, opens Settings and sets the dialog by
control id, so each setting can be captured with `capture.ps1` and read with `escpr_dump.py`:

| setting | area (setj) | origin top, left | what the driver does with the page |
|---|---|---|---|
| Auto Expand, Std (default) | 3032 x 4400 | -22, -76 | enlarged 3032/2880 = 5.28% about the area's middle (18 px below the sheet's middle) |
| Auto Expand, Med | 2956 x 4362 | -12, -38 | enlarged 2956/2880 = 2.64%, middle 9 px below |
| Auto Expand, Min | 2920 x 4342 | -6, -20 | enlarged 2920/2880 = 1.39%, middle 5 px below |
| **Retain Size** | 3032 x 4400 | -22, -76 | **not enlarged**: the page (2880 x 4320) sits 1:1 at the area's top-left corner: rows 0..4320 of the area, which is 76 px (2.68 mm) left of and 22 px (0.78 mm) above the sheet |

Thin-line pages (`-Pattern hlines`) landed where `row = areaH/2 + (page row - 2160) x E` says for all three Auto Expand levels, and at
`row = page row` for Retain Size. Retain Size cannot print edge to edge from the app: the page is only 2880 x 4320, so the 2.68 mm strip at the
right and the 0.78 mm strip at the bottom are outside it. `desktop/lib/helper.mjs` (`WIN_EPSON_L8050_EXPANSION`, `$l8050Mode`) reads the two bytes
(only when the layout matches), draws the picture for the setting, and warns on Retain Size. `desktop/test/test-win-l8050.mjs` ties the numbers to the jobs.
The horizontal part could not be read from the band data (blank bands are not sent, but a band's columns are not decoded), it follows from the same enlargement.
