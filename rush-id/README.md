# Rush ID & Photo Print

A self-service station for **rush ID photos** and **photo printing**. Customers do everything on the screen: pick **Rush ID photo** or **Print photos**, add photos (camera, USB / SD card, Bluetooth folder, phone QR), frame the ID (face found and centred, background made plain white / blue / red by on-device AI), preview, **Print**.

## How it runs: on the booth's own engine

The station is **not** a separate camera/printer program. `https://photobooth4u.netlify.app/rush/` opens the **booth page in "station mode"**, and the Rush screens (this folder) sit on top of it in a frame. So:

- **Cameras:** whatever is chosen in the booth's Setup works the same way: webcams, **DSLR / mirrorless over USB** (Canon, Nikon, Sony), the Windows Print Helper camera, the Android USB webcam code, the Mac Canon driver. A photo is taken with the booth's own `captureShot()`, so a DSLR gives its real photo. (The photo comes out un-mirrored even if the booth's live view is mirrored.)
- **Printers:** printing follows the booth's own routes, copied from *Arrange & Print*: print station, the Windows/Mac **Print Helper** (any installed printer: DNP, HITI, Canon SELPHY, Mitsubishi, Sinfonia, Epson...), Android Wi-Fi/USB direct, Android print service, or the browser dialog. The printer, colour profile and quality chosen for each paper size in the booth's Setup apply, and the code's print limits are counted the same way.
- **Paper sizes** are the ones Admin allows for the code (Admin → the code → Print). If printing is not switched on for the code, the station says so and does not start.
- **Setup:** staff tap the shop name **5 times**, enter the PIN (default **1234**, change it), then **"Cameras & printers: open the booth Setup"**. That shows the booth's normal Setup (step 4 *Camera & printer*) with a **Back to Rush station** button.

The bridge between the two is `window.__PBHW` (in `protected/booth.html`, section "Rush ID & Photo Print station"). It does nothing unless the page is at `/rush/`, so a normal booth is unchanged.

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
| **Phone (QR)** | The station shows a QR code; the phone opens `/rush/u/<CODE>`, picks photos, they appear in seconds. No app. Photos are deleted from the server as soon as the station has them (leftovers after 3 hours). Starting a session needs a valid code with the switch on. |

## Android app (separate APK)

A separate **Rush ID Station** app (id `com.photobooth4u.rushstation`) installs beside the booth app. It is the booth's Android project, so the native USB, Bluetooth, UVC webcam and printer code comes with it.

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

- **Verified here (browser, simulated webcam, stubbed print):** the lock and Admin switch, station mode, the booth's webcam path, un-mirrored capture, paper list from Admin, print routing to the booth's browser-print route (page size, copies), Setup round trip, the normal booth at `/` unchanged. **Not verified (no hardware / Gradle here):** DSLR over USB, the Print Helper, Wi-Fi/USB/Bluetooth printers, DNP/HITI/SELPHY output, the Android APK build and the Android camera/printer bridges. They run through the booth's own code, but test each on the real device before relying on them.
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
