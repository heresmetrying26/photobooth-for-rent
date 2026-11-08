# Rush ID & Photo Print

A self-service station for **rush ID photos** and **photo printing**. Customers do everything on the screen: pick **Rush ID photo** or **Print photos**, add photos (camera, USB / SD card, Bluetooth folder, phone QR), frame the ID (face found and centred, background made plain white / blue / red by on-device AI), preview, **Print**.

## How it runs: on the booth's own engine

The station is **not** a separate camera/printer program. `https://photobooth4u.netlify.app/rush/` opens the **booth page in "station mode"**, and the Rush screens (this folder) sit on top of it in a frame. So:

- **Cameras:** whatever is chosen in the booth's Setup works the same way: webcams, **DSLR / mirrorless over USB** (Canon, Nikon, Sony), the Windows Print Helper camera, the Android USB webcam code, the Mac Canon driver. A photo is taken with the booth's own `captureShot()`, so a DSLR gives its real photo. (The photo comes out un-mirrored even if the booth's live view is mirrored.)
- **Printers:** printing follows the booth's own routes, copied from *Arrange & Print*: print station, the Windows/Mac **Print Helper** (any installed printer: DNP, HITI, Canon SELPHY, Mitsubishi, Sinfonia, Epson...), Android Wi-Fi/USB direct, Android print service, or the browser dialog. The printer, colour profile and quality chosen for each paper size in the booth's Setup apply, and the code's print limits are counted the same way.
- **Paper sizes** are the ones Admin allows for the code (Admin → the code → Print). If printing is not switched on for the code, the station says so and does not start.
- **Setup:** staff tap the shop name **5 times**, enter the PIN (default **1234**, change it), then **"Cameras & printers: open the booth Setup"**. That shows the booth's normal Setup (step 4 *Camera & printer*) with a **Back to Rush station** button.

The bridge between the two is `window.__PBHW` (in `protected/booth.html`, section "Rush ID & Photo Print station"). It does nothing unless the page is at `/rush/`, so a normal booth is unchanged.

## On the screen

- **No scrolling.** Every screen fits the window (laptop, kiosk, tablet upright or sideways, phone). The ID editor keeps its controls in three tabs (*Size & copies*, *Background*, *Fine-tune*); only a long list of photos scrolls inside its own box.
- **Mirror.** ID editor: **↔ Mirror** under the photo. Photo printing: a **↔** button on each photo. (Photos from the camera come out un-mirrored even if the booth's live view is mirrored; this button is for flipping them on purpose.)
- **Live view.** *Take a photo* opens a large live picture of the booth's selected camera (DSLR live view included), with a 3-2-1 countdown. **📷 Retake** in the ID editor opens it again.
- **Paper and printer.** On the print screen: **Paper** (for an ID; only the sizes Admin allows for the code) and **Printer**. With the Print Helper the printer list shows every installed printer, and the choice is the booth's own per-paper-size printer (also visible in Setup). Without the helper it says how the print will go (print station, Wi-Fi printer, Android print screen, or the device's print dialog).
- **Background colour:** White, Light blue, Blue, Red, Gray, **Custom** (any colour), or Keep mine.
- **Background removal:** MODNet portrait matting (about 26 MB, runs on the device, kept by the browser after the first use), refined so edges follow the real photo, then a **Touch up** brush: **Erase** leftovers, **Restore** parts cut by mistake, Undo, Reset. A checkerboard shows while touching up. If the model cannot run, it falls back to the basic cut-out.
- **Photo prints:** the sheet is shown live. Tap a photo on it, then **zoom** (slider or wheel), **drag** to move it inside its print, **Mirror**, **Reset**; *Fill the page* or *Whole photo*; sheet arrows when there is more than one.
- **Printer & paper:** the **🖨 Printer** button on every screen (and on the print screens) opens printer and paper settings. Print Helper: pick any installed printer. Android: the Wi-Fi/USB printers the app found (**Find printers**); printers that need special handling say so and **More printer settings** opens the booth Setup at *Camera & printer*.
- **Past orders (staff):** finished prints and saves are kept on this device (default 30 days; Settings → *Keep past orders*, 0 = keep nothing). **Orders** on the home screen, behind the staff PIN: view, **Reprint**, **Save**, **Delete** one or **Delete all**. Customers' photos stay out of sight; the idle timer still clears the working screen.
- **Android rotate:** a button that shows the shape it will turn to (**Portrait** / **Landscape**).
- **Android:** a **⟳** button (top right) turns the screen between portrait and landscape; the choice is remembered. Without it the screen follows the tablet.

## Admin switch and codes

- **Admin → a code → "Turn on Rush ID station"** (or tick the box when creating codes). **Off by default.** Only codes with it on can open the station.
- The renter opens `/rush/` and types **the same code** they already have. The lock screen checks the code with the server before the booth page is sent, so a code without the switch is stopped with "This code does not include the Rush ID station."
- Everything else is the booth's code system: expiry, device limit, disabling a code. A laptop uses one device slot for both the booth and `/rush/`. Turning the switch off (or the code expiring) returns an open station to the lock screen within about 5 minutes.
- Typing a never-used code on `/rush/` starts its rental clock, as on the booth. Make Rolly his own code.
- The Rush screens themselves are served by `/api/rush` only to a valid code with the switch on (not a public file).

## Photo sources

| Source | How it works |
|---|---|
| **Camera** | The booth's selected camera (see above). 3-2-1 countdown, oval guide for ID. |
| **USB / SD card** | "Choose photos…" (any browser) or "Browse the whole drive / SD card…" (Chrome/Edge): finds photos in `DCIM/100XXXXX`, thumbnails, tick the ones to add. |
| **Bluetooth** | A web page cannot receive Bluetooth files. The phone sends the file with *Share → Bluetooth* to the computer, Windows saves it in a folder, and the station **watches that folder** and adds new photos (Chrome/Edge). |
| **Phone (QR)** | The station shows a QR code (needs the internet: the phone sends the photo through the site); the phone opens `/rush/u/<CODE>`, picks photos, they appear in seconds. No app. Photos are deleted from the server as soon as the station has them (leftovers after 3 hours). Starting a session needs a valid code with the switch on. |

## Android app (separate APK)

A separate **Rush ID Station** app (id `com.photobooth4u.rushstation`) installs beside the booth app. It is the booth's Android project, so the native USB, Bluetooth, UVC webcam and printer code comes with it.

- It follows the tablet's rotation, with the **⟳** button to force portrait or landscape (remembered).
- **Updates itself in the app:** the app checks for a newer Rush ID Station at launch and every few minutes (the booth's own updater: *New version available → Update*, a download with a progress bar, then Android's install prompt). Staff can also open **Settings → App updates → Check for updates → Update now**. The newest version is the newest `rushid-v*` release on GitHub (the site looks it up and reports it in `/api/updates` as `rush`; no file to edit when you release). The first time, Android asks to allow *Install unknown apps* for the app. The Rush app and the booth app never offer each other's updates. Versions before 1.0.4 do not have this: install 1.0.4 by hand once.
- Build: GitHub → **Actions → "Rush ID Station Android app" → Run workflow**, or push a tag like **`rushid-v1.0.0`** (attaches `rush-id-station-android.apk` to a release). It is its own workflow: the booth's `android.yml` and build files are untouched.
- `android/scripts/make-rush-variant.mjs` patches the CI checkout only: own app id and name, opens `https://photobooth4u.netlify.app/rush/`, skips the booth's offline activation gate (the code lock screen on the site decides), no booth-update prompt, no offline fallback. It stops with a clear message if the booth code it patches ever changes.
- The Android Rush app **needs the internet** (code check). It uses the same client code, with "Rush ID station" on.
- The launcher icon is the booth's. Only the name differs.

## Build and deploy

`npm run build` (Netlify runs it) = `scripts/build-booth.mjs` + `scripts/build-rush.mjs`. The Rush build bundles this folder into one page (`netlify/lib/rush.mjs`, committed like `booth.mjs`; the last good copy is kept if the build fails) and copies the AI files and the phone page into `public/rush/` (not committed). `esbuild` is a dev dependency for that.

After a deploy, check: `/rush/` returns 200; `GET /api/rush` with no code returns **401** (not 5xx); `POST /api/rush/session` `{"action":"create"}` with no code returns **401**; plus the booth checks in CLAUDE.md.

## Local testing

- `cd rush-id && npm install && npm run dev` → <http://localhost:8888>: the **standalone** version (no codes, browser camera and print dialog, QR kept in memory). Handy for the screens; it has no DSLR / printer routes because those belong to the booth engine.
- The standalone version can also be deployed as its own Netlify site (Base directory `rush-id`). It has no lock screen.

## Staff settings (this browser only)

Shop name, currency, PIN, idle seconds before a customer's photos are cleared (default 180), paper for ID sheets (from the sizes Admin allows), gap/margin, cutting lines, prices.

## ID sizes and packages

1×1", 1.5×1.5", 2×2", 1.5×2", 2×3" wallet, Passport 35×45 mm; packages (2×2 ×6, 1×1 ×12, 1.5×2 ×8, Passport ×6, Combo) or any mix. Packed on the sheet automatically (turned sideways when that fits more). Edit `PACKAGES` / `ID_SIZES` in `public/js/layout.js`. Photo printing: 4×6, 5×7, 6×8, wallet (4 per 4×6), strip 2×6 (2 per 4×6); offered only for papers the code may print.

## Known limits

- **Verified here (browser, simulated webcam, mocked Print Helper, stubbed print):** the lock and Admin switch, station mode, the booth's webcam path, un-mirrored capture, mirror, paper list from Admin, paper change, printer choice (the print goes to the chosen printer at the right size and copies), the QR link, screens at laptop / tablet / phone / large sizes with no page scroll, Setup round trip, the normal booth at `/` unchanged. **Not verified (no hardware / Gradle here):** DSLR over USB, the Print Helper, Wi-Fi/USB/Bluetooth printers, DNP/HITI/SELPHY output, the Android APK build and the Android camera/printer bridges. They run through the booth's own code, but test each on the real device before relying on them.
- The Windows/Mac **desktop** app (offline) has no Rush entry yet; use `/rush/` in a browser, or the Android Rush app.
- Staff Setup shows the whole booth Setup (design, text, layout...); only *Camera & printer* matters for the station.
- iPhone HEIC files on a USB/SD card cannot be opened by Chrome; the QR route converts them on the phone.
- The AI background cut-out is the lightweight on-device model: best against a plain wall. The *Edge clean-up* slider helps.
- Measure a printed 2×2 to confirm it is exactly 2 inches; if the driver trims the edges, set a gap/margin in Staff settings.

## Files

```
rush-id/                        (the Rush screens; the booth site builds them into /rush/)
  public/js/app.js              screens and flow
  public/js/hw.js               finds the booth's hardware (window.parent.__PBHW) when embedded
  public/js/imaging.js          decoding, background removal, face finding, ID crop
  public/js/layout.js           sizes, packages, sheet packing
  public/js/print.js            standalone browser printing / save as JPG
  public/js/sources.js          USB/SD folders, Bluetooth folder watching, QR session
  public/upload.html            what the phone opens after scanning the QR
  public/vendor/                MediaPipe + models + QR library (see NOTICE.txt)
  netlify/lib/sessionCore.mjs   QR transfer logic, shared by the standalone and gated versions
  dev-server.mjs                standalone local test server
Outside this folder:
  protected/booth.html          "Rush ID & Photo Print station" section: station mode + window.__PBHW
  public/rush/index.html        /rush/ code lock screen
  netlify/functions/rush.mjs, rushsession.mjs   gated screens, gated QR
  scripts/build-rush.mjs        builds this folder into the site
  netlify/lib/core.mjs, verify.mjs, admin.mjs, app.mjs, public/admin.html   the per-code `rushOpt` switch
  android/scripts/make-rush-variant.mjs, .github/workflows/rushid-android.yml   the Android Rush app
```
