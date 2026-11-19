# Canon G1010 (and G-series) print stream: how it was captured

The Android app sends a Canon PIXMA G1010 its jobs over USB (`android/.../CanonJob.kt`, colour tables in `CanonLut.kt`).
Canon does not publish that language, so the bytes were copied from **Canon's own Windows driver**, made to print **to a file**
(no printer needed), and compared command by command. Nothing here talks to a printer.

## Method

1. Install Canon's Windows printer driver for the model (the `Canon G1010 series` queue; the port can be `LPT1:` with no printer).
2. `print-to-file.ps1 -Out job.prn -Media <option> -Quality <option> -Border <option>` prints a gradient to a file through that
   driver. It builds a Windows PrintTicket (paper type, quality, borderless) and turns it into a DEVMODE, so every driver option
   can be varied. Options are listed by the driver itself (`System.Printing` `GetPrintCapabilitiesAsXml()`): media
   `psk:Plain`, `ns0000:MattePhoto`, `ns0000:PhotoPaperPlusGlossy2`, ...; quality `psk:Draft|Normal|High`; borderless `psk:Borderless`.
3. `colour-chart.ps1 -Out chart.prn -Media ... -Quality ...` prints a 9 x 9 x 9 colour chart (729 patches, R/G/B = 0, 32 ... 255,
   27 x 27 grid, black frame). Reading the ink per patch back from the job gives the colour tables in `CanonLut.kt`
   (average pixel value x 100 per ink, node = r * 81 + g * 9 + b).

## What the jobs contain (all verified against captures)

* IVEC XML wrapper, job id `00000001`: `StartJob`, `SetJobConfiguration` (date), `VendorCmd ModeShift`, native data, `EndJob`.
* Native data: `ESC [ K`, then `ESC ( T b c d t p P l v w C q y b I J [e] L`, then bands `ESC ( F` of 8 rows (PackBits, `0x80` ends a
  row), `ESC ( e 0001`, FF, `ESC ( b 0`, `ESC @`.
* `ESC ( e <n>` skips `n` blank 8-row bands (at the start and inside the page); Canon never sends a fully blank band.
* Quality byte (`ESC ( c`): 1 = 300 dpi Draft, 2 = 600 dpi Standard, 3 = 600 dpi High (finer drops, so its ink table differs).
* Ink formats (`ESC ( t`, order K, C, M, Y): plain Standard `1,2,2,1` bits; plain High `2,2,2,2`; photo papers C, M, Y only, 2 bits.
* Borderless only changes the print-area line (`ESC ( p`): offset (-66, -47), 2533 x 3766 (the sheet is 2400 x 3600 at 600 dpi).
* Paper codes (`ESC ( c / P / l / w`): plain 00/00/00/00, glossy (Photo Paper Plus Glossy II) 1D/32/23/03, matte 0A/1C/10/0F.

## Verifying

Evaluate the header lines of `build600` for each variant and compare with the captured job byte for byte (done for plain, glossy and
matte, Standard and High, bordered and borderless). Ports of the dither and of the band / skip logic were run against the captures too:
the skip counts matched Canon's exactly, and mean ink amounts matched the tables.

Still untested on a physical printer at the time of writing: everything above except the 300 dpi stream (which a client's G1010 prints).
