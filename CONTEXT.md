# Session Context

**Current Task**: Android v1.0.97 (Android-only release): no 360 desk / Record 360 buttons in the Android app; debug-only Epson L-series Normal 720 / Best 1440 dpi beta now with borderless (booth.html block `epson-raster-beta`, tools/epson-raster/).

**Key Decisions**:
- The Epson beta builds the Windows driver's raster job in JavaScript (byte-identical to tools/epson-raster/gen.py for standard, high, bl_standard, bl_high) and sends it in 2 MB pieces through `__PBNet.printRaw` to the USB printer. Visible only when Admin's debug option is on (`pbDebug()`).
- Borderless is allowed only on 4x6, 3.5x5, 16:9 wide and 100x148 mm for the L3200/3210/3230/1210/1230/1250 (Epson's settings file); the beta covers 4x6 only.
- Edit files with LF endings (.gitattributes eol=lf). `npm run build` rewrites netlify/lib/android-version.mjs from android/app/build.gradle.

**Next Steps**:
- Print a beta Normal and Best sheet (borderless and bordered) on a real L3210 from the tablet; if the printer rejects the job or edges are wrong, compare with tools/epson-raster (README lists unverified points).
- Test the RP30A-UB thermal printer and the Insta360 Ace Pro (needs a data cable / Webcam mode; use Copy camera log).
- `public/downloads/pb4u-windows-camera-test/*` shows as deleted in the working tree (not from these releases); check why.
