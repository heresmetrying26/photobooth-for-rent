# Epson L3210 raster jobs (Best / Normal quality)

Work in progress. This folder holds the tools used to understand the print jobs the **Windows Epson L3210 driver**
writes, and a generator that makes the same kind of job from any picture.

The generator is also built into the Android booth page (`protected/booth.html`, block `epson-raster-beta`) as a **debug-only
beta**: with Admin's debug option on, the built-in Epson mode of an L3210 / L3200 / L3230 / L1210 / L1230 / L1250 (or L8050 / L3276) offers
"Normal 720 dpi (beta)" and "Best 1440 dpi (beta)" for 4x6 in glossy paper. The JavaScript is byte-for-byte identical to `gen.py`
(checked for both modes) and sends the job in 2 MB pieces through the app's existing USB raw-print call. Not tried on a printer yet.

Why: the Android app's built-in Epson mode (`EscprJob.kt`) speaks ESC/P-R, which has no Best (High) quality and no
verified borderless. The Windows driver speaks Epson's raster language, which does. The jobs below were captured by printing
a test page from the installed driver to a *file port* (no paper, no ink). Nothing here copies Epson code; it reads the
bytes the driver wrote.

## What is decoded (verified by rebuilding the picture from the driver's own jobs)

A job is: `@EJL` header, two `REMOTE1` blocks (`TI US JS JH HD`, then `TI PM DP SN MI US FP PP`), then page set-up
`ESC ( A G U i C c S K D m e v`, then many **passes**, then `FF`, `LD`, `JE`.

| Item | Meaning (as observed) |
|---|---|
| `ESC ( U` `p v h lo hi` | units: `1440 / v` = vertical dpi, `1440 / h` = horizontal grid dpi (Best `2 2 1` = 720 x 1440, Normal `2 2 2` = 720 x 720, plain `4 4 4` = 360, Draft `8 8 4`) |
| `ESC ( m` / `ESC ( e` | print mode / dot size code: Draft `10`/`11`, plain `22`/`14`, Normal photo `52`/`12`, Best photo `70`/`13` |
| `MI` | media: plain `00 01 00 0a`, Epson Photo Paper Glossy `00 01 34 0a` |
| `ESC i c 1 2 wb(2) rows(2)` + PackBits | one band: colour `0 K, 1 M, 2 C, 4 Y`, 2 bits per dot (0 none, 1 small, 2 medium, 3 large), `wb` bytes per row, `rows` nozzle rows |
| `ESC ( $` x | start the next band x grid units to the right (the 360 dpi data pixels sit every `h_dpi/360` grid columns, so Best uses x = 0..3 to interleave) |
| `ESC ( v` n | feed the paper n vertical units (a pass appears to be committed by the feed; CR follows every band) |
| nozzles | 59 per colour, pitch 1/180 in; M is 60 and Y 120 nozzles *behind* C and K |
| printable area (4x6 bordered) | 3.767 x 5.767 in, top at 0.444 in (row 320 at 720 dpi) in the printer's row space, left at x = 0 |

`recon.py` turns any job back into a preview picture; `epsonjob.py` is the reader.

## Generator (`gen.py`)

```
python gen.py standard  photo.jpg  out.prn     # Normal  (720 x 720 dpi)
python gen.py high      photo.jpg  out.prn     # Best    (1440 x 720 dpi)
python gen.py bl_standard photo.jpg out.prn    # Normal, borderless
python gen.py bl_high     photo.jpg  out.prn   # Best, borderless
powershell -File send-raw.ps1 -Printer "EPSON L3210 Series" -File out.prn
```

* 4x6 in **Epson Photo Paper Glossy**. With a border the picture is cover-fitted to the 3.767 x 5.767 in printable area; borderless it fills
  4.2 x 6.236 in (0.1 in past the paper left and right, 0.118 in past the top and bottom).
* Header, page set-up and trailer come from `templates/` (taken from real driver jobs for the same settings).
* Passes are our own interlace (every row and every grid column is printed exactly once). The driver's own pass
  pattern and dot masks are different, so expect different banding.
* Colour: RGB is turned into C M Y K dot levels with tone curves measured from the driver's own output (ordered dither,
  white noise). Black uses K plus a little M and Y (rich black like the driver). Densities track the driver within about 10 to 15 %,
  but real prints will need tuning.

## Checked so far

* Generated Normal and Best jobs parse with the reader and rebuild the test picture (bar, text, gradient, colour registration).
* `send-raw.ps1` delivers the bytes unchanged (checked through the spooler to a file port).

## Not checked (needs the real L3210 and paper)

* Whether the printer accepts our pass pattern, small feeds and `ESC ( v` values.
* Real print colour, banding and any edge/ink-limit problems.
* Borderless was captured with the driver's Borderless box ticked. What changes: `ESC ( c` bottom 4716 -> 5110, remote `FP` `00 00 00` -> `00 b0 ff`,
  bands 378 bytes wide (1512 px = 4.2 in) and a different feed pattern (first feed 55/51, then 17,14 / 9,6). The generator uses the new set-up values
  and the driver's feed patterns with its own pass planner. Unverified on paper: whether the printer keeps the edges clean.
* Other paper sizes and paper types (only 4x6 glossy and plain were captured).
* Porting to Kotlin for the Android app, and USB access to this mode.

## Capturing more jobs

`capture.ps1` prints a test page through a printer queue whose port is a file (create the queue with the L3210 driver and a
local port such as `C:\temp\cap.prn`). Example:

```
capture.ps1 -Printer "PB4U L3210 capture" -Sets "psk:PageOutputQuality=ns0000:HighQuality;psk:PageMediaType=ns0000:EpsonPhotoPaperGlossy;psk:PageMediaSize=ns0000:Fullsize4x6"
```
