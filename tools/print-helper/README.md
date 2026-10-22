# photobooth4u Helper (Print Helper)

Small local app that lets the booth print straight to a named printer (no dialog), so each paper
size can use its own printer. Renter instructions live on `/downloads/` (public/downloads/index.html).

- Listens on `127.0.0.1:17321` only; accepts requests only from `https://photobooth4u.netlify.app`
  (and `http://localhost:8888` for `netlify dev`). Extra origins: env `PB_ALLOWED_ORIGINS=a,b`.
- `GET /status` → `{ ok, version, printers: [...] }`
- `POST /print` `{ printer, widthMm, heightMm, pages: ["data:image/png;base64,..."] }` → `{ ok }`
- Windows (1.1+): `GET /camera`, `POST /camera/open`, `GET /camera/frame`, `POST /camera/capture`,
  `GET /camera/battery`, `POST /camera/live?on=0|1`, `POST /camera/close` control a Nikon over USB through
  Windows' own camera driver (`camera-worker.ps1`, embedded in the exe and run with PowerShell). `/status`
  includes `camera: { supported, open, name }`. Test with a stand-in worker on any OS:
  `PB_CAMERA_WORKER="node mock-worker.mjs" bun print-helper.js` (the port is added as the last argument).
- macOS/Linux print with CUPS `lp -d <printer> -o fit-to-page`; Windows with .NET `PrintDocument`
  via PowerShell (rotates the image to match the driver's page orientation, fills the full sheet).
- Paper size / borderless / cut come from each printer's default settings.

## Build (any OS, needs Bun 1.2+)
```
bun build --compile --minify --target=bun-darwin-arm64 print-helper.js --outfile photobooth4u-print-helper-mac-apple-silicon
bun build --compile --minify --target=bun-darwin-x64   print-helper.js --outfile photobooth4u-print-helper-mac-intel
bun build --compile --minify --target=bun-windows-x64  print-helper.js --outfile photobooth4u-print-helper-windows.exe
```
**Mac builds made on Windows/Linux must be re-signed before zipping.** Bun's cross-compiled Mac
binaries carry a broken ad-hoc signature (code digest mismatch), and macOS then says the file
"is damaged and can't be opened". Re-sign them with `rcodesign` (apple-codesign, runs on any OS):
```
rcodesign sign --binary-identifier com.photobooth4u.printhelper photobooth4u-print-helper-mac-apple-silicon
rcodesign sign --binary-identifier com.photobooth4u.printhelper photobooth4u-print-helper-mac-intel
```
(On a Mac, `codesign --force --sign - <file>` does the same.)

Zip each (keep the Mac files executable) and put the zips in `public/downloads/`.
Run from source for testing: `bun print-helper.js`.

The apps are unsigned: Mac needs right-click → Open the first time; Windows SmartScreen needs
More info → Run anyway. Signing (Apple Developer ID + notarization, Windows code-signing cert)
removes those warnings.

## Versions
- 1.1.4: answers the booth at once (the printer list is kept and refreshed in the background, so Windows no longer times out with "Can't reach the Print Helper"); receipt printers: `fit: "width"` prints at the roll's full width without stretching (Receipt layouts).
- 1.1.3: Windows camera: photo download reads the photo's size first and falls back to 1 MB pieces when Windows' driver returns nothing; download details in errors.
- 1.1.2: Windows camera: Nikon records to its own memory (no SD card needed for live view and photos), like the Mac booth.
- 1.1.1: Windows camera: accepts Nikons that report themselves as MTP devices (D3400, D5600), clearer live-view errors, and a "Details" diagnostic line on the camera test page.
- 1.1.0: Windows: Nikon camera over USB (live view + real shutter) for the booth, no Zadig. The helper window is
  now titled "photobooth4u Helper". Printing unchanged. Mac builds don't need updating (camera on a Mac works in
  the browser).
- 1.0.1: Windows fix: one-page prints failed (PowerShell turned a one-line file list into a string, so `$files[0]`
  was the letter "C"). Windows now prints silently with `StandardPrintController`. The Mac builds behave the same
  as before, so Mac users can stay on 1.0.0.
- 1.0.0: first release.
