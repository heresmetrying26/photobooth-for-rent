# photobooth4u – rental edition

**Lock screen → password → app.** The booth itself (`protected/booth.html`) is never
public; a Netlify Function only sends it to someone with a valid trial or rental license.

## Deploy (functions need Git or the CLI — drag & drop of a folder won't run functions)

1. Put this folder in a GitHub repo and connect it to Netlify (New site → Import from Git),
   **or** with the CLI:  `npm i -g netlify-cli && netlify login && netlify deploy --prod --build`
2. In Netlify → Site configuration → Environment variables, add:
   - `ADMIN_PASSWORD`  – your admin login (make it long)
   - `TOKEN_SECRET`    – 32+ random characters (e.g. from a password generator)
   - `TRIAL_PASSWORD`  – optional; default is `TRIAL` (you can change it later in Admin)
3. Redeploy once after saving the variables.
4. Open `https://photobooth4u.netlify.app/admin.html` to create rental codes.

## Updating the booth
Edit `protected/booth.html` and redeploy. (The build step re-bundles it automatically.)

## How it works
- **Trial password** – reusable, unlocks for N minutes (default 15). Change/disable in Admin.
- **Rental codes** – `PB-XXXX-XXXX-XXXX`, one-time use. Days start counting on first entry,
  or from the event date if one is set (see *Event dates and bonus codes*).
  Bound to the first device; other devices are refused. Expiry is enforced on the server.
- **Admin** – create codes (by days), see status/time left, add days, disable/restore, delete,
  "Allow new device" (if the renter switches tablets), and edit trial settings.
- When time is up, the app returns to the lock screen (after any photo session in progress).

## Camera
- Any camera the computer sees as a webcam works: built-in webcams, USB webcams, Sony/Canon
  cameras in USB-streaming / webcam mode (Sony Imaging Edge Webcam, Canon EOS Webcam Utility),
  or any camera through an HDMI-to-USB capture card. The booth asks for 1920×1080.
- The camera picked in the **Camera** menu is remembered on that device and chosen again
  the next time the booth opens (matched by name if the camera was re-plugged).
- If the camera drops out (cable bumped, camera powered off, HDMI lost) the booth shows
  "Reconnecting…" and keeps retrying by itself; a camera plugged in mid-event is picked up.
- **Mirror the live view** (Camera section of the Photo Session panel): on/off, remembered per
  device. Only the preview is mirrored; saved and printed photos never are.
- The screen is kept awake while the booth is open (browser wake lock).
- Guest photos are uploaded to Drive as high-quality JPEGs (smaller, faster QR codes).

## Weak internet & backup folder
- **Offline at the venue ("scan now, photos arrive later"):** if the booth has no internet when a session ends,
  the result card shows the event's **All photos** QR with "Scan now · your photo arrives here once the booth is
  back online", and the photo waits on the tablet until the connection returns (no retry delay when clearly
  offline). The event folder must have been set up online once (Setup), so the booth knows the gallery link.
- **QR sign:** Setup → 6 Share → **Download QR sign** makes an A5 "Scan for your photos" sign (300 dpi PNG) with the
  event name and gallery QR, to print and stand by the booth.
- **Upload retry + waiting list:** each Drive upload is tried 3 times. If it still fails, the
  photo is kept on the device (IndexedDB) and the Photo Session panel shows **Waiting to
  upload** with **Retry now** / **Save to this computer**. Waiting photos upload by themselves
  every 30 s and when the browser comes back online, also after a reload. The guest gets the
  event's All photos QR meanwhile. Photos the code can no longer upload (expired/locked) stay
  listed until saved to the computer.
- **Backup folder (Chrome / Edge on a computer):** Setup → 6 Share → **Choose backup folder**.
  Every session's photo (full-quality PNG) is then written to `<folder>/<event name>/` instead
  of Downloads. After a browser restart Chrome asks again: tap **Allow saving** (Setup or the
  Photo Session panel). Tablets and other browsers keep saving to Downloads.

## Printing (per rental)
Printing is **off** unless you turn it on in Admin — when creating codes, or later with
**Print settings** on any code (an open booth picks the change up within ~5 minutes).
Pick which paper sizes that renter may use: 2×6 strip, 3R (3.5×5), 4R (4×6), Canon Selphy postcard
(100×148 mm) and card (54×86 mm), 5R (5×7),
6R (6×8), 8R (8×10), A6, A5, A4, Letter — or add up to 6 **custom sizes** (width × height in
inches or mm, e.g. 4×4 in square or 100×148 mm). Custom sizes always print portrait.
Trials have their own print switch in the Trial card (off by default).

When allowed, the booth shows a **Print** box after each session with only the approved
sizes. Prints come out at the real paper size (300 dpi, zero margins):
- **Strip** on 2×6 (or any similarly narrow sheet) prints one strip; on wider sheets it prints
  **two strips side by side** to cut down the middle (the classic photo-booth sheet).
- **Grid** prints one image filling the sheet. Very narrow sheets like 2×6 are Strip-only.
- When the photo and paper shapes are close, the print fills edge to edge (trimming a
  sliver of backdrop); otherwise it fits the whole image with white borders.

## Photo session screen
- **Look:** Photo Session is a dark full-screen "darkroom" (Setup stays light). The camera fills the screen; Camera /
  Printer / time left sit in a small dock (bottom-left, or a bottom bar on narrow screens) and are hidden when locked.
- **Welcome screen** (between guests) is drawn from the event's design: their background, a sample print of their
  layout and the event name, with a pulsing "Tap to start". It is the start button (no separate Start under it).
- **Result:** one card with the QR, **Print** (guest button, if on) and **Done**, all on one screen on phones and
  portrait tablets too. A thin bar under Done shows when the booth returns to the welcome screen. Done goes straight
  back to the welcome screen.
- **Full screen (welcome → countdown → review):** the live view fills the screen, in the photo's exact
  shape, as big as it fits; leftover space is black. Countdown ("2 · Shot 1 of 3") floats top centre, taken
  photos top right, Cancel / Retake / Done as see-through buttons at the bottom. On the welcome screen the
  Setup / Photo Session tabs and the Camera / Printer dock float on top for the operator; while shooting they
  are hidden. When the camera sees more than the photo (e.g. a square photo on a portrait tablet), the black
  around it shows the rest of the live picture, dimmed, with a thin white line at the photo's edge; areas the
  camera can't see stay black (also black with green screen / background swap). The finished-photo screen
  (QR, Print, Done) is unchanged. Not used in traditional mode
  (laptop + guest screen), which has its own guest window.
- **Countdown:** a large ring with "Shot 1 of 4" beside it, top centre.
- **Live view = the camera's whole picture** (its own shape, e.g. 3:2 for a DSLR), with a dashed
  **guide box** showing exactly what each layout's photo box keeps (strip, duo, trio, grid, My frame…).
  Shots are stored whole and cropped once into the box, so the guide matches the print.
- While shooting: bigger live view, taken photos large on the right, **Cancel** (or Esc: nothing is
  saved) and **Retake this photo** during the pause between shots.
- After the last shot: **review** — tap a photo to retake just that one, or **Done** (auto after 12 s;
  Space/clicker = Done). Only the finished strip is saved, uploaded and printed.
- **Mirror** toggle and **filter** chips sit under the live view (same settings as Setup).
- My frame: two matching strips on one sheet (e.g. 4x6 with 2×3 boxes) take half the shots and copy
  them across (switch per frame); borderless boxes touching the edges are detected.
- Print box: on 4R with a strip layout, "Printer for 4R · strip layouts (2 strips, cut)" is its own
  setting, so strips can go to e.g. "HiTi 2x6 cut" and other layouts to "HiTi 4x6".

## USB camera (remote control) mode
For DSLR / mirrorless cameras in their **Photo Import / Remote Control** (Canon), **PTP/MTP**
(Nikon) or **PC Remote** (Sony) USB mode, so the camera's own photo settings and flash apply. Pick
**"DSLR / mirrorless over USB (remote control)"** in the Camera menu and choose the camera in
Chrome's USB picker (only the first time; it stays allowed). Live view comes from the camera;
each shot fires the real shutter (about 2.5–3 s per shot incl. transfer, shown as "Saving").
- Chrome or Edge on a **Mac or Android** with web-gphoto2 (below). Safari has no USB.
- **Windows: Nikon (Helper 1.1+) and Canon EOS (Helper 1.1.5+) through the photobooth4u Helper** (see the next section). No Zadig.
- Quit Photos, Image Capture, EOS Utility / Nikon apps first. Mode dial on M/P/A/S, JPEG (not RAW).
  A smaller JPEG size (e.g. Medium/Normal) makes each shot faster. Use a mains adapter: live view drains batteries.
- Live view is low-res (e.g. 640×424 on a D5600); the photos are full quality (cropped, max 2000 px).
- If a shot fails (focus, RAW), the live-view frame is used and a note shows.
- Needs the COOP/COEP headers on `/` in `netlify.toml`. Uses web-gphoto2 (LGPL-2.1) from
  `public/camera-test/build/`; `/camera-test/` is a stand-alone test page for any camera.
- **Mac desktop app**: macOS' own camera service (`ptpcamerad`, behind Photos / Image Capture) grabs a camera the moment it is
  plugged in, which gives "Another app is using the camera". The app (`desktop/lib/camfree.mjs`, IPC `pb4u:freeCamera`) stops it
  and quits Image Capture before every connect, keeps stopping the service for ~15 s while connecting (macOS restarts it), retries
  once by itself, and connects when a camera is plugged in. In Chrome the same is done by the Mac photobooth4u Helper
  (1.1.10+, `POST /camera/free`): the booth calls it before connecting when the Helper has been used here, and
  after a "busy" error; `/camera-test/mac/` does the same. Without the Helper, quit those apps by hand.
- Tested: Nikon D5600 on macOS Chrome (shutter, live view, settings). Canon and Sony not yet tested. The bundled
  library (libgphoto2 2.5.28) lists Sony A7 III (PC Control) and other bodies up to about 2021; newer Sony bodies
  need a rebuilt library.

### Windows: Nikon / Canon EOS / Sony Alpha over USB through the photobooth4u Helper (1.1 / 1.1.5 / 1.1.9)
Chrome can't open the camera on Windows (Windows' own camera driver holds it), so the helper does it:
- `tools/print-helper/camera-worker.ps1` (built into the helper exe) runs in PowerShell and talks to the camera
  through Windows' WPD/MTP driver ("MTP extension" commands: Nikon live view 0x9201/0x9203, shutter 0x90C0,
  events 0x90C7, GetObject; Canon EOS: remote mode 0x9114, event mode 0x9115, events 0x9116, live view by setting
  0xD1B0 = 2 through 0x9110 and reading 0x9153, shutter 0x910F (older EOS, e.g. 60D) or 0x9128/0x9129 (newer),
  the photo from the ObjectAddedEx / RequestObjectTransfer event, GetObject or 0x9107 in pieces, then 0x9117).
  The helper starts it at launch and keeps it running; it connects back on a private
  127.0.0.1 socket. Endpoints: `GET /camera` (devices), `POST /camera/open`, `POST /camera/live?on=0|1`,
  `GET /camera/frame` (JPEG), `POST /camera/capture` (JPEG), `GET /camera/battery`, `POST /camera/close`.
- On open (Nikon) it sets the camera to JPEG (if it was RAW) and the smallest photo size at least ~2900 px wide
  (D5600: 2992×2000), because the booth uses at most 3000 px and smaller files come over USB faster.
  Canon settings are left as they are (RAW + JPEG: the JPEG is used; RAW only: the booth says to switch to JPEG).
- Canon EOS needs EOS Utility closed, and on older bodies "Live View shoot: Enable" in the camera menu
  (otherwise the camera never sends live view; the helper says so after ~9 s).
- Booth (Windows): the Camera menu has **Nikon / Canon / Sony camera over USB (photobooth4u Helper)**. Picking it once (Chrome asks
  to allow local access) remembers it (`pb_cam_helper`); after that the booth checks the helper on start and every
  6 s, picks a plugged-in camera by itself, switches from the built-in webcam when one is plugged in between guests,
  and keeps retrying when the helper is closed or the camera is unplugged (no Try Again needed).
- **Sony Alpha (1.1.9)**: camera's *USB Connection* must be **PC Remote** (A7 III: MENU > Setup > USB). The worker uses Sony's
  PTP commands the way gphoto2 does: connect 0x9201 (phases 1-3), 0x9202, "application" priority 0xD25A, properties 0x9209
  (ObjectInMemory 0xD215, FocusFound 0xD213), live view = object 0xFFFFC002 (JPEG after a 4-byte offset header), shutter =
  0x9207 with 0xD2C1 (half press) and 0xD2C2 (full press), photo = object 0xFFFFC001 once 0xD215 >= 0x8000. It waits ~3 s after
  connecting (several bodies refuse photos before that) and sets *Still Img. Save Dest.* to PC Only (photos go straight to the
  computer, so **no memory card is needed**; if the camera won't take that it falls back to PC + Camera).
  Photos must be JPEG. Battery isn't shown (Sony reports steps, not percent). Tested only against a simulated A7 III
  (command sequence, errors, two shots in a row); **needs a real Windows + A7 III test**: if Windows' camera driver doesn't pass
  Sony's commands on, the booth says so and shows what the driver allowed.
- Nikon and Canon EOS: tested with a stand-in worker (booth + helper end to end), and the real
  worker's C# compiled as C# 5 (like Windows PowerShell's Add-Type) against simulated Nikon, Canon 60D-style and
  Canon R-style cameras (live view, RAW + JPEG, RAW only, focus failure, download in pieces, live view disabled).
  The WPD camera calls themselves still need a real Windows test with each brand (use /camera-test/windows/).
- **Hangs and long events (Windows)**: a camera call that never answers can't be cancelled, so the helper restarts the camera part
  after 10 s (frame) / 45 s (photo) and tells the booth. Since then: the restart waits 1.5 s for USB to settle; the next connect sends
  `open recover`, which makes a Canon leave remote mode (0x9115 / 0x9114 = 0) before switching it on again; two hangs in a row say
  "switch the camera off and on". The worker logs `Camera call 0x… has waited N s with no answer` (after 3 s) and `Slow camera call`
  (over 1.5 s) so a hang shows which command it was stuck on. Canon: if the camera ends live view by itself (heat, its time limit) the
  worker switches it back on once per frame request. Nikon: the event list is read every 3 s during live view. Every camera request
  is released after use and memory is collected every 400 calls. Tested with a simulated R-series camera and a stub worker; **not on a
  real R50**.

### iPad with a DSLR (laptop app, first version after 1.0.29)
Safari and Chrome on iPad have no USB, so an iPad can't run the Nikon / Canon / Sony USB remote itself. Two ways (guide: `/how-to-ipad/`):
- **iPad + the laptop's camera (Windows laptop app):** Setup → Share & start → *Let an iPad use this laptop's camera*. The laptop shows
  `http://<laptop>:47777/ipad` and a 6-digit PIN (`settings.json`: `ipadOn`, `ipadPin`; off by default). The iPad opens that in Safari; the laptop serves the
  booth page itself (`desktop/lib/lan.mjs`, mounted on the guests' photo server) plus `/api/*`, `/helper/*` (camera), `/local/drive` (photos) and the
  static files, all same-origin, so Safari's mixed-content block never applies. Only requests with the PIN cookie are answered; wrong PINs are rate limited.
  In the booth, `window.__PB.lanRemote` (set by the laptop) makes it use `/helper` for the camera like the laptop window does (`LANREMOTE` in `protected/booth.html`),
  and saves/QR go through the laptop (`LOCALSHARE`). Printing from the iPad stays AirPrint. Mac laptops can serve the iPad page, but their USB camera is WebUSB inside the
  app window, not the Helper, so the iPad can't use it yet. **Not tested on a real iPad + DSLR.**
- **iPad + HDMI capture card:** webcam path (no shutter / flash).

### Canon SELPHY (CP1300 / CP1500)
Works as is: iPad over AirPrint, Android over Mopria (or Canon Print Service), laptops over USB/Wi-Fi with
the Print Helper or the print station. Allow the **Canon Selphy postcard (100×148 mm)** size for the renter
(true 4R is 101.6×152.4, so it would trim a sliver). No 2×6 paper: strip layouts print two strips on the
postcard to cut. About 41 s per print, so plan 1 print per session for busy events.

### Receipt photo booth (layouts Receipt / Receipt colour)
Looks like a shop receipt: event name, order number and time, 3 square photos, a few joke line items
("TOTAL … PRICELESS"), a barcode and "THANK YOU!". Made 576 px wide = 80 mm thermal paper at 203 dpi.
- **Receipt** (black & white): photos are dithered (tiny dots) so a thermal receipt printer (Epson TM-T20/T82,
  Xprinter, Rongta…) prints them sharp. Allow **Receipt 80 mm** and/or **Receipt 58 mm** in Admin → Printing.
  Receipt paper only prints the Receipt layouts; with a receipt roll allowed, the B&W receipt picks it by default.
- **Receipt colour**: same look with colour photos, for photo printers (2 receipts side by side on 4R, or 2×6).
- Printing: the page is as long as the receipt (~28 cm on 80 mm, ~18 cm on 58 mm). In the receipt printer's
  Windows settings choose **roll paper** (e.g. "Roll Paper 80 × 297 mm" or longer) and cut at the end of the document.
  Through the Print Helper **1.1.4+** (Windows) it prints at the roll's full width without stretching (`fit: "width"`);
  older Windows helpers fall back to the print dialog. The print station, desktop app and Mac (CUPS) do the same.

### Print limits, copies and the guest Print button
- **Limits (Admin → Print settings, also when creating codes and for the trial):** *per event* (sheets for the
  whole event, all devices together) and *per session* (sheets one guest session may print). Empty = no limit.
  Copies count (2 copies = 2 sheets; keychain/strip pages count each page). The event count lives on the server
  (`/api/prints`, Blobs store `prints`; lifetime codes count per event name), so reloads and extra devices share it.
  Admin → Print settings shows **Prints so far** per event with **Reset count** (e.g. the renter bought more prints).
  If the booth is offline when it prints, the guest still gets the print and the sheets are added once it's back online.
  A cancelled AirPrint/print dialog still counts (a web page can't tell it was cancelled).
- **Setup → 6 Share → Printing** (saved with the setup, so every device on the code gets it):
  **Print button for guests** (shows after each session, also when the booth is locked), **Print automatically
  after each session**, **Copies each time**, **Let guests choose how many copies** (a big “How many copies?”
  sheet, never more than the limits allow) and **Change the wording guests see** (Print button, “Printing, please
  hold…”, the copies question, the limit-reached message).
- **Print automatically** now works on tablets too: on an iPad the AirPrint sheet opens by itself after each session
  and the guest only taps Print (a web page can't skip that sheet). Traditional booths keep the old behaviour (turns
  on after the first print; with the Print Helper or `--kiosk-printing` there's no dialog). If a Home Screen iPad app
  doesn't open the AirPrint sheet, run the booth in a Safari tab or use the laptop print station.

### Laptop print station (`/print-station/`) — tablet printing with no pop-up
For DNP / HiTi printers (not AirPrint) or when guests shouldn't see the AirPrint sheet:
1. On the laptop connected to the printer, start the **Print Helper**, open
   `https://photobooth4u.netlify.app/print-station/` and sign in with the booking code (doesn't use a device slot).
   Pick a printer per paper size, **Print a test page**.
2. On the iPad or Android tablet: **Printer → Send prints to → Laptop print station** (or Setup → 6 Share). The booth
   shows whether the station is on.
- **Trials** pair instead (the trial password is shared, so it can't sign a laptop in): with Laptop print station
  picked, the trial tablet shows a 6-digit **pairing code**. Type it on the laptop's print-station page. It works
  once, within 10 minutes ("New code" makes another); the laptop then gets only that tablet's prints until the
  trial ends.
3. Prints (and auto-prints) go iPad → `/api/printjobs` (Blobs store `printjobs`, max 60 waiting, dropped after 30
   minutes) → the station page → Print Helper → printer, with no dialog. Without the helper the station uses Chrome's
   print dialog (or none with `--kiosk-printing`).
- The station polls every 2.5 s (5 s when quiet) from a worker, so it keeps going in a background tab; keep the
  laptop plugged in and awake. Each poll is one function call, so leave it closed when no event is running.
- No Print Helper rebuild was needed: the station page talks to the helper you already ship.

### Printer per paper size + Print Helper
In the Print box, **Printer for <size>** remembers which printer each paper size uses (saved on that
computer). Without the helper it's a reminder of what to pick in the print dialog. With the
**photobooth4u Print Helper** running and **Print Helper on this computer** switched on, prints go
straight to that printer with no dialog (Auto-print included), so 2×6 and 4R can use different printers.
- Downloads + renter steps: `/downloads/` (Mac Apple Silicon / Intel, Windows). Source and build:
  `tools/print-helper/`. Listens on 127.0.0.1:17321, only accepts the photobooth4u origin.
- Paper size / borderless / cut come from each printer's own defaults. One printer, two sizes:
  add it twice with different defaults (e.g. "HiTi 4x6", "HiTi 2x6 cut").
- The booth only contacts the helper when the switch is on (Chrome asks once to allow local access).
- Tested: macOS/Linux path (CUPS `lp`) end to end with stand-in printers (re-checked Oct 2026).
- **Windows 1.0.0 could not print** (a one-page job made PowerShell read the file list as a single string, so it
  tried to open a file called "C"). Fixed in **1.0.1**, which also prints silently (no "Printing page 1 of 1"
  window). The booth and the print station tell Windows users still on 1.0.0 to update. 1.0.1 has not been tried
  on a real Windows printer yet.
- Tablets (iPad / Android) can't run the Print Helper: they print with AirPrint / Mopria, or through the laptop
  print station (which uses the helper on the laptop).

### Kiosk / silent printing (no print dialog)
Browsers always show a print dialog unless Chrome/Edge is started in kiosk-printing mode,
which sends every print straight to the **default printer**:

1. Set the photo printer as the computer's **default printer**, and in its printer
   preferences choose the paper size you'll use (e.g. 4×6) and **borderless** if offered.
2. Close all Chrome windows, then start Chrome with:
   - Windows (shortcut target):
     `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing https://photobooth4u.netlify.app/`
   - macOS: `open -a "Google Chrome" --args --kiosk --kiosk-printing https://photobooth4u.netlify.app/`
   - Edge works the same with `msedge.exe --kiosk https://photobooth4u.netlify.app/ --kiosk-printing`.
   Leave out `--kiosk` if you want a normal window but still silent printing.
3. Do one test print first. If the size or margins are off, fix them in the printer's own
   preferences — silent mode uses the printer defaults for anything the page doesn't set.

Without kiosk mode the normal print dialog opens: pick the photo printer, set Margins to
**None** and Scale to **Default/100%**, then print.

## Light, sound and start (Setup → 7 Session → Light, sound and start)
- **Screen flash:** the whole screen turns white ~0.35 s before each photo and stays on through the shot, so the
  front camera gets a fill light in dim rooms (the traditional booth's guest screen flashes too). A web page can't
  raise the brightness: set the tablet's brightness to max. Off by default.
- **Countdown beeps and shutter click:** made in the browser (Web Audio), no sound files. Soft / Normal / Loud and a
  test button. iPad and Android only allow sound after a tap, so the first tap (start screen / welcome) turns it on.
- **Start without touching:** Off (tap) / **Wave** / **Smile**, with Less / Normal / More sensitivity. Tapping still
  works. While Setup → Session is open a live meter shows what the booth sees, so you can try it.
  - Wave: watches for movement in the middle of the picture for most of a second (no download).
  - Smile: MediaPipe Face Mesh (`public/bg/facemesh/`, ~17 MB in the repo, ~10 MB download the first time, then
    cached) measures mouth width against face width with the corners lifted; faces far from the camera are ignored.
    Thresholds come from real photos (neutral ~0.36-0.37, clear smiles 0.44-0.49).
  - After a session the booth waits 4 s before it can start again by itself. The welcome screen says "Wave to start"
    / "Smile to start".

## Background swap / green screen (Setup → 5 Extras → Green screen)
- **No cloth (AI):** cuts guests out with Google MediaPipe's selfie segmentation and puts them on a new background.
  Runs entirely on the device (no photo leaves it, no fees). Files are in `public/bg/` (MediaPipe Tasks Vision 1.0.1
  runtime ~12 MB + a 250 KB model, Apache 2.0, see `public/bg/NOTICE.txt`); they load only when this mode is on and are
  cached for a week. Best with guests close to the camera; hats and props held away from the body may be cut off.
- **Green screen:** classic chroma key (green, blue, or **Pick from camera** = the colour at the top of the picture)
  with a **Strength** slider and colour-spill removal. Cleanest edges; needs an evenly lit cloth.
- 9 built-in backgrounds (drawn in the browser, nothing to license) or **Upload your own picture** (saved with the
  customer's images like logos, so every device gets it).
- Applied to every shot (so uploads, QR photos and prints have it), to **Preview with my camera**, and (switch) to the
  live view, including the traditional booth's guest screen. Slower tablets get fewer live frames automatically; the
  photos themselves are always processed at full quality.
- The model file is MediaPipe's `selfie_segmentation.tflite` with TFLite metadata added so MediaPipe Tasks accepts it
  (normalisation mean 0 / std 255, label "person").

## Event dates and bonus codes
- **Event date (optional).** When creating a code, set *Opens on* + *From time*. The code is
  refused before then ("This code opens on Oct 25, 2026, 12:00 AM"), and once open it runs for
  the **Days** you set *from that opening time* (1 day = 24 hours), even if the renter enters it
  later in the day. Leave it blank for the old behaviour (days start on first entry).
  Unused codes have **Set date / Change date / Remove date** in the list. Dates are shown in
  Philippine time; set the `BOOTH_TZ` env var (e.g. `Asia/Singapore`) to change it.
- **Bonus code.** Tick *Include a bonus code* and set its length in minutes (5–1440, default 60),
  or add one later with **+ Bonus code**. The bonus code:
  - can be used any time until the booking's window ends (e.g. to test before the event);
  - runs for its minutes from first entry; **Change length** sets a new total at any time
    (an open booth picks it up within ~5 minutes);
  - shares the booking's Drive folder, print and laptop-mode settings (changing those on the
    booking updates the bonus too), and deleting the booking deletes its bonus code;
  - uploads into a **Bonus** subfolder of the event folder, with file names starting
    `BONUS_` (BONUS_1_strip.jpg, BONUS_2_strip.jpg…), numbered separately from event photos.

  The subfolder needs the Google Apps Script to read the `subfolder` field the booth now sends
  (see below). Until it does, bonus photos land in the main event folder, still named `BONUS_…`.

### Apps Script: bonus subfolder
In `doPost`, after the event folder is found/created from `folderKey`, add:

```js
if (data.subfolder) {
  const name = String(data.subfolder).trim();
  const it = folder.getFoldersByName(name);
  folder = it.hasNext() ? it.next() : folder.createFolder(name);
}
```
(`data` = the parsed request body, `folder` = the event folder.) Do this for both the
`resolveOnly` call and uploads, so the QR, `folderUrl` and `nextSessionNumber` all use the
subfolder. Then **Deploy → Manage deployments → Edit → New version** so the same URL updates.

## Lifetime codes and several devices
- **Devices** (1–50, when creating a code or later with the *Devices: N* button): how many
  tablets/laptops can use the same code. Each new device takes a free slot and gets a number
  (Device 1, 2, 3…). All devices on a code share its Drive folder and QR; when a code allows
  more than one device, file names end in the device number (`3_strip_cam2.jpg`) so two devices
  never write the same name. **Remove** a device in Admin to lock it out (within ~5 minutes)
  and free its slot; numbers are never reused.
- **Lifetime** (tick when creating, or *Make lifetime* on an existing code): never expires.
  Instead of one fixed folder, the booth asks for an **event name** and each event gets its own
  top-level Drive folder: `<Drive folder name> · <event name>` (e.g. `Juan Photobooth · Santos
  Wedding`). Devices at the same event must type the same event name to share one folder/QR.
  Only letters, numbers, spaces and basic punctuation are kept, so a renter can't point the
  booth at any other Drive folder. Ticking Lifetime also ticks Traditional (Pro); untick it for
  tablets.
- Storage: everything still goes to your Google Drive. The hourly cleanup script
  (`apps-script/cleanup.gs`) treats each `Client · Event` folder as an event, so it is deleted
  7 days after that event's last photo. No Apps Script change is needed for this.

## Your frames: guests choose, or all on one sheet
- Setup → 3 Layout → **Your frames**: tick frames. 1 ticked = that frame on its own. With 2 or more ticked, choose
  **Guests choose one** (each guest taps the frame they want before the countdown; works when the booth is locked;
  combines with "Guests choose the layout") or **All on one sheet** (the old collage) with a **Sheet size**
  (4R, Selphy postcard, 5R, 6R, 8R, A5, A4, Letter; the arrangement re-fits to the size). Saved as `frameMode`,
  `chooseIds`, `sheetSize`. Older setups with 2+ frames keep "All on one sheet".
- **Full screen:** the booth goes full screen with the first tap (browsers need a tap); a locked booth goes back to
  full screen on every tap. ⋯ → Full screen switches it on/off (remembered per device). Not on iPhone / Home Screen apps.
- Background **No cloth (AI)** is labelled Beta, "we keep improving it".

## Photo windows: colour picker, highlight, cut to the window, tilted spots
- **Edit photo spots → Photo windows:** *Pick window colour*, then tap a window in the preview: that colour (± *Match*)
  counts as a photo window like white / see-through, and the spots are found again (`f.key = { c:[r,g,b], t }`).
  *White / see-through only* clears it. Uploading a flat frame with no white or see-through windows (and almost no
  transparency) keeps it as a frame and opens the picker straight away.
- **Highlight:** while editing, the windows (see-through areas of the punched frame) are tinted blue.
- **Cut to the window:** each photo is drawn ~4% bigger and cut to its own window (`frameMasks`: see-through areas
  split into windows; a window two spots share is split between them), so photos never spill into a neighbour and
  tilted corners are filled. Spots over solid art (no window) are drawn as before.
- **Tilted spots:** detection fits the smallest box turned up to ±25° (`minAreaBox`) and stores `a` (degrees) on the
  spot. Edit photo spots: drag/resize work turned, *Tilt °* field and ↺/↻ 1° buttons; split keeps the tilt.
- **Snap to window** (Edit photo spots → Selected box): put a box roughly over one window and tap Snap. For tilts
  within ±10° of the box it finds the strongest straight window edge near each side (edge pixels of white /
  see-through / picked colour; a side may show only a corner piece when windows overlap) and fits position, size
  and tilt (`snapSpot`). Sides with no edge found stay where they were (the toast says how many of 4 were found).

## Offline app licences (Windows / Mac desktop app)
- **Add-on per code:** Admin → *Give offline app* (`offlineOpt`). Without it the app says the offline app isn't in
  their plan. Same code as the web booth; each activated laptop takes one device slot (kind *Windows app* / *Mac app*)
  and is never replaced as a "stale" device by /api/redeem.
- **`/api/license`:** `activate { code, mid, name, os, ver }` (first use starts the code like /api/redeem; throttled),
  `checkin { licence, mid, ver }` (fresh licence, or `revoked` with reason removed / disabled / no-addon / expired),
  `deactivate { licence, mid }` (frees the slot), `GET ?pub=1` (public key).
- **Licence** = `PB4U-LIC1.<payload>.<Ed25519 signature>`, signed with `PB_LICENSE_KEY` (private, Netlify env only;
  make it once with `node scripts/make-license-key.mjs` and never change it). The app holds only the public key, so
  licences can't be made or edited without the server. Payload: activation id, machine id, lifetime / `exp`, `chk`
  (check in after 75 days when online), `hard` (stops 30 days after that without a check-in; rentals stop at `exp`),
  and the same add-ons as the web booth (printing, vouchers, retakes, lock, mode, folder name).
- **Admin:** device chips show the laptop name and last check-in; *Deactivate* removes it (cancelled at its next
  check-in). *Offline activation key*: paste a laptop's Machine ID (`WIN-…` / `MAC-…`) and send the renter the key.
  Removing the device in My Events works the same way.
- **Packages (Admin → Create → Package):** Tablet Booth (1 day), Laptop Booth (1 day, offline app allowed), Laptop
  6-Month Pass (183 days, `offlineOnly`: /api/redeem and checkLicense refuse it on the website, the app takes it), and
  Lifetime (offline app included). Codes with an end date get licences with `hard = exp`, so a pass works offline for
  its whole period with no check-ins; lifetime laptops still renew every 75 (+30) days. Admin row: *Laptop app only* /
  *Allow website too* (action `offlineonly`).
- **The app itself** lives in `desktop/` (Electron, Windows + Mac): the full booth offline, photos saved on the laptop,
  guests' QR over the booth Wi-Fi, built-in printing and Windows camera, vouchers. Built by GitHub Actions
  (*Actions → Desktop app*); Netlify ignores it. See [desktop/README.md](desktop/README.md). In `protected/booth.html`
  the app-only parts are behind `DESKTOP`, so the website is unchanged.

## My Events page (`/lifetime/`)
- **Your details & devices:** renters change their **name** (the Drive folder name is frozen first, so photos
  stay in the same folder) and **email**, see each device (type, added, last used, "This device") and **Remove**
  one to free its slot (that booth locks within ~5 minutes). Device type comes from the unlock page.
- **Forgot your code?** (sign-in screen): emails every code registered to that address (same answer for unknown
  addresses; 5 requests/hour per IP, 3 emails/hour per address). Admin has **Add/Change email** and
  **Email code to renter**; Admin search also matches email.
- **Email is sent by the Apps Script relay** (`apps-script/upload.gs`, MailApp, from the Google account that owns
  the script, ~100/day free). One-time step: paste the new `upload.gs`, **Deploy → Manage deployments → Edit →
  New version → Deploy**, and approve the new "Send email as you" permission.
- **No Drive folder links for renters or guests:** My Events, the booth's Setup and the gallery only offer the
  online gallery (with Download all). Admin still has the Drive links.
- **From the booth:** Setup has a **My Events ↗** button (top bar; on phones in the ⋯ menu). It opens
  `/lifetime/?booth=1`, which signs in with that booth's own login, so nothing to type. Hidden during the
  session, when locked, and for trials.
- **Printing (lifetime codes):** once Admin has switched printing on for the code, the renter picks the paper sizes
  (any built-in size incl. Canon Selphy, plus up to 6 custom sizes) and the limits per event / per session in
  **My Events → Printing** (`/api/portal` action `print.save`). Booths pick it up within ~5 minutes or on reload.
A page for customers to find every event's Drive folder again, from any phone or computer.
- **Sign in** with their code, or open the link from Admin → **Copy events page link**
  (`/lifetime/#PB-XXXX-XXXX-XXXX`, signs them in and is then remembered on that device). On a
  device that already runs the booth, it signs in by itself. It never uses up a device slot.
- **Shows** each event with its last-photo time, number of sessions, **Show QR / Copy link /
  Open folder**, and the "download by" date (7 days after the last photo; 1 day for Bonus
  folders). Deleted events stay listed, greyed out. Works for all rental codes; a bonus code
  shows its booking.
- **How it fills up:** the booth reports each Drive folder to `/api/events` when it's set up and
  after every session (rentals only; the server checks the folder belongs to that code). Events
  from before this update appear once the booth opens that folder again.
- The booth's Google Drive panel also has **Open folder / Copy link / All my events** under the QR.
- **Lifetime codes** entered on the lock screen go to `/lifetime/?welcome=1` first (welcome
  message, **Download setup guide**, **Open photo booth**). Next visits to `/` open the booth
  directly. The guide is `public/lifetime/photobooth4u-setup-guide.pdf` (7 pages). Its source is
  `docs/setup-guide/guide.html` (fonts and images alongside); edit it and run
  `node docs/setup-guide/build-guide.mjs` to print a new PDF with Chrome.
- If you change EVENT_DAYS / BONUS_DAYS in `apps-script/cleanup.gs`, change EVENT_KEEP_DAYS /
  BONUS_KEEP_DAYS in `netlify/lib/core.mjs` to match.

## Security: signed Drive uploads (do this once)
The booth never talks to Google Drive on its own authority any more. Before each Drive call it
asks `/api/ticket` for a ticket signed with `UPLOAD_SECRET`; the ticket names the ONE folder
(and optional Bonus subfolder) that code may use, and expires within 12 hours (trials: when the
trial ends). The Apps Script (`apps-script/upload.gs`) rejects anything without a valid ticket
and ignores whatever folder the browser sends. So a trial user can't reach other events'
folders, and nobody can point the script at other Drive folders.

**Deploy in this order (so nothing breaks in between):**
1. Netlify → Site configuration → Environment variables → add `UPLOAD_SECRET` (32+ random
   characters; e.g. run `crypto.randomUUID()+crypto.randomUUID()` in a browser console). Deploy.
   The booth now sends tickets; your old script just ignores them, so it keeps working.
2. Apps Script → replace the upload code with `apps-script/upload.gs` → Project Settings →
   Script Properties → add `UPLOAD_SECRET` with the **same** value → Deploy → Manage
   deployments → Edit → Version: **New version** → Deploy (the URL stays the same).
3. Test with the trial password: the folder QR should appear and a session should upload.

The new script also skips folders in the Trash (so a re-used event name gets a fresh folder),
creates the Bonus subfolder, and locks while creating folders so two devices can't make two
folders with the same name.

## Other safeguards
- **Safari / iPad:** a device not seen for 7 days gives up its slot when the code is entered on a
  new device (Safari wipes a site's saved data after ~7 days unused). Devices that are used keep
  their slot. Tip for iPad users: Share → Add to Home Screen (home-screen apps aren't wiped).
- **Same folder name:** Admin warns if a new booking's Drive folder name is already used by
  another code; OK = share it on purpose (returning client), Cancel = rename.
- **QR codes** are made on the device (`scripts/vendor/qrcode.min.js`, MIT, inlined in the booth
  and My Events), so no outside service sees the folder links and QRs work on weak internet.

## Layouts, countdown and date
- **Layouts** (Setup → 3 · Layout; each card shows the current design): Classic strip (3), Strip 4, Polaroid 4, Grid 4,
  Hero 1+3, Solo, Duo, Trio, Feature 1+2, Film 6. Strips print two side by side on 4R; every
  other layout is built as an exact 4R (4×6) sheet. New sheet layouts are one line each in
  `SHEET_ROWS` + `LAYOUT_DEFS` inside `protected/booth.html`.
- **Countdown**: 3 / 5 / 7 / 10 s, fine-tuned in ½-second steps (2–15 s). A ring drains smoothly
  while the numbers tick whole seconds. Optional extra time before the first shot, and a pause
  between shots.
- **Date**: tap the calendar icon next to the event name to add today's date; tap the date to
  pick another day; Remove (or the icon again) takes it off. Works on iPad and Android.

## Design: themes, saved setup, frame, logo and stickers
Setup is in 7 steps, one at a time: **1 Design** (two tabs: **Ready designs** and **🎨 Colours & background**) · **2 Text** (name,
date, small line, title style, fonts, colour) · **3 Layout** (layout, guests' choice, countdown) ·
**4 Camera** (a live view of the camera, full frame or cropped to the layout, the camera picker, Mirror and the camera log) ·
**5 Extras** (Frame / Logo / Stickers / Filter tabs) · **6 Share** (Drive folder, all-photos QR to print
ahead, printing) · **7 Session** (countdown, welcome screen, sounds, payment). The step bar stays at the top with a one-line summary of each step (red = still
needed), and a bar at the bottom always shows the save status and **Start photo session**. On a
laptop or tablet in landscape the **preview stays beside the steps**; on phones the **👁 Preview** button
in the bottom bar (it pulses on the first visit) opens the preview just above the bar, and the steps still
scroll above it, so you can change colours or arrange frames and watch the result. **✕ Hide** closes it. **Try with my camera** uses one frame from the camera (never
uploaded). Tapping a template shows it big first (**Use this design / Cancel**); after using it the
booth goes to step 2 with the name box ready. Fonts are shown as cards with the event's own name,
in Script / Elegant / Modern / Fun (plus **Recent**), with ready-made **pairs** for the name and the
small line; a template's own colours come first under Text colour.

- **Themes** (20 originals) by category: Wedding, Birthday, Debut, Kids Party, Graduation,
  Christening, Christmas, New Year, Corporate. A theme only fills in the settings, so everything
  can still be changed afterwards. **Colours & background** has six numbered parts, each with a
  one-line explanation: 1 Background style, 2 Background colour, 3 **Gold details colour** (switches
  the gold lines/confetti/artwork to silver, rose gold, champagne, white or black), 4 Sprinkles,
  5 Photo border, 6 Your own background photo. Only some designs draw gold details (e.g. Gold
  Chevron, Art Deco Navy, White Marble, plus gold stickers); for the others the booth checks the
  preview and says there is nothing to change instead of showing buttons that do nothing.
- **Your own frames** (Setup → 5 Extras → Frame): upload a frame made in Canva with the photo spots left **white
  or see-through**. The booth finds the boxes (numbered in reading order), puts shot 1, 2, 3… in
  them and keeps the design on top; **Fix spots** lets you move, resize, add or remove a box. The
  layout becomes **My frame** (a 2×6-shaped frame prints two side by side on 4R). An image with no
  boxes (or one see-through middle) is a plain overlay drawn on top of any layout. **Logo**: PNG/JPG
  in a corner or centre, adjustable size.
- **Frame collage** (was "My frames sheet"): two or more frames on one 4R print. In **3 · Layout →
  Your frames** tick the frames to use (1 ticked = **My frame**, 2+ = **Frame collage**; **+ Upload
  more** is right there). The booth picks the arrangement that fits them best; change it under
  *Arrange them on the 4R sheet* (One, 2 side by side, Top + bottom, Tall + 2, Tall + 1 + 2 strips,
  3 strips, 4 quarters, 4 strips; 5+ frames get a grid), **⇄ Swap places** moves every frame to the
  next spot, **+ Add a copy** repeats a frame. Then tap a frame in the preview to drag it, resize it,
  swap it for another frame, turn it 90° or duplicate it. With no frames uploaded, the Layout list
  shows a single **My frame · Upload a frame** card that opens the upload. The guest
  takes as many shots as the biggest frame needs; smaller frames use the first shots.
- **Keychain prints (2.5×7.5 in)**: allow the **2.5×7.5 in keychain** paper in Admin → Print
  settings. Design strip frames at **1:3** (e.g. 750 × 2250 px); the frame list shows "fits 2.5×7.5
  keychain ✓". Printing a frames sheet on keychain (or 2×6) paper prints **each strip frame on its
  own page**, copies included (two copies = two keychains); the 4R size still prints the whole sheet.
  On bigger paper (A4, Letter, 8R…) tick **Keychain strips at real size** in the Print box: every
  strip prints exactly 2.5×7.5 in, as many per page as fit (3 upright on A4/Letter, or 4 sideways
  when that saves a page), with thin cut lines. Print at 100% / "actual size", not "fit to page".
- **Templates** (shown first in the theme gallery): Teddy Bear Party, Carnival Fun, Burgundy Line
  Florals, Sage Line Florals, Ivory Monogram, Blush Roses 18, Black & Gold 18, Pink Plush
  Christening, Little Bear Christening, Boho Pampas. A template also sets the layout, a **title
  style** (2 Text → Title style: small line above "The wedding of", small line below "Turns
  one", letter blocks, monogram, big number "18") with its **small line**, and original vector
  artwork (awning, teddy bear, bunny, line florals, roses, pampas). Two landscape 4R layouts
  (**Landscape 3 / Landscape 4**) put the event name in its own panel; they print turned on 4R.
- **Stickers / props**: 19 built-in (8 shown, the rest under **More stickers**) plus the
  renter's own PNGs. Tap to add, drag on the preview to place, then size / turn / duplicate /
  bring to front / remove. Up to 30 on one layout.
- **My themes**: "★ Save my current design as a theme" keeps the whole design (frame, logo,
  stickers included) under the customer's code; every device on that code sees it.
- **Saved setup**: the design is saved to the server per booking (per event for lifetime codes)
  and comes back after a refresh, a restart, or on another device. A bonus code uses its
  booking's design. Trials keep it on the device only. Bottom bar **⋯ → Reset setup** starts over.
- **Starting theme** (Admin): a booking can open with a chosen theme (e.g. Graduation) until the
  renter saves their own design.
- **Guests' screen**: welcome card between guests (always on), layout choice each session, review
  after each shot, and filters.
- **Event name over busy backdrops**: when lines, borders or confetti sit behind the event name and
  date, the booth softly fades them out right behind the words so the text stays clear.
- Uploaded images are kept in the `setups` Blobs store; nothing new to set up.

## Guest payments: vouchers + the renter's own PayMongo (add-on)
An add-on you switch on per code in Admin (**Give guest payments**). Then, per event, the renter picks in the booth:
**Setup → 7 Session → Guest payment → Free / QR payment / Vouchers / QR + vouchers**, the price per session
(₱20–₱20,000) and optional "prints included" (overrides the per-session print limit for paid sessions).

**Guests:** the welcome screen shows "₱120 per session · Tap to start". Tapping opens the pay sheet:
- *QR payment* — a one-time QR Ph from the **renter's** PayMongo (GCash, Maya, any bank app), 5-minute timer;
  the session starts by itself when PayMongo confirms (webhook, with a direct check every few seconds as backup).
- *Voucher* — a big number pad; 8-digit codes like `6041 0839`, each works once, only for its event.
- A paid session is kept on the tablet until the countdown starts (a reload or Cancel at "Get ready" doesn't lose it).
- Offline: vouchers still work (the tablet keeps a hashed list of the event's unused codes and syncs "used" later;
  give each tablet its own batch if several run offline). QR payment needs internet; with "QR + vouchers" the
  booth falls back to vouchers.

**Vouchers:** made in the booth (Setup → Guest payment → Make vouchers) or by you in Admin (**Payments & vouchers**).
**Print tickets** opens `/pay/tickets.html`: 10 cut-out tickets per A4 (event, code, price, what's included).
Cancel unused vouchers per batch. My Events lists every batch for reprinting.

**PayMongo connect (My Events → Guest payments):** the renter pastes their **secret key** once and sets a 4–8 digit
payments PIN (needed to replace or disconnect). The server checks the key with PayMongo and sets up the payment
webhook on their account by itself. Money goes straight to the renter's PayMongo; nothing passes through you.
My Events shows payments (live vs test) per event. Test keys (`sk_test_`) show a "Simulate payment" button on the
booth. QR Ph must be enabled on their PayMongo account (PayMongo support). PayMongo's QR Ph fee is 1.5%.

**Security of the renter's key:**
- Encrypted with AES-256-GCM using `PB_VAULT_KEY` (Netlify environment variable, never in code or the database),
  bound to that booking, stored in the Blobs store `pay`. The webhook signing secret is encrypted the same way.
- Write-only: no endpoint ever returns it (Admin, My Events and the booth only see "test/live · …last4").
- Only decrypted in memory for the PayMongo call that needs it; never sent to the tablet, never logged.
- Webhooks are verified with PayMongo's HMAC-SHA256 signature; forged "paid" messages are rejected.
- Admin **Reset payments PIN** also disconnects PayMongo (so nobody can swap in another key with a reset).
- Limit: whoever controls the Netlify account could change the code, so state in your terms that keys are only
  used to create the renter's own payments.

**One-time setup (you):** in Netlify → Site configuration → Environment variables add
`PB_VAULT_KEY` = 32+ random characters, then redeploy. Generate one with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` or in PowerShell
`$b=New-Object byte[] 48;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);[Convert]::ToBase64String($b)`.
Keep it secret and **never change it**: a new value makes every saved key unreadable (renters would reconnect).
Files: `netlify/lib/pay.mjs`, `netlify/functions/pay.mjs` (`/api/pay`), `netlify/functions/payhook.mjs`
(`/api/pay/hook`), `public/pay/tickets.html`.

## Online gallery (`/g/<folder id>`)
Guests' QR codes open a photobooth4u gallery page instead of Google Drive: a photo grid,
full-screen viewer with swipe, a Download button per photo, "Download all (Google Drive)",
the "download by" date, and new photos appear by themselves during the event. Admin → **Guest QR
codes** switches every booth back to the plain Drive folder if ever needed. My Events shows both.

**After each session** the booth (and the guest screen) shows a **Your photo** QR code. It opens the
gallery straight on that photo (`/g/<folder>#<file id>`); with Admin set to Drive it opens the file in
Google Drive. The **All photos** QR
for the whole event is only in Setup → 6 Share, to print or share ahead. Between shots the pause
shows the photo just taken and "Next: photo 2 of 3", with no countdown circle.

**Gallery page QR (Admin → Guest QR codes → "QR code on the gallery page", on by default):** an
"Open on your phone" QR card at the top of the gallery on laptops/TVs, and a **QR** button on phones (so
a guest can let a friend scan it). Photos and prints never carry a QR code.

**Trial watermark (Admin → Trial password → "Watermark trial photos", on by default):** trial
photos get a faint photobooth4u logo in the bottom-left corner on screen, in the saved/uploaded
photo and on prints. Rental codes never get it.

How it works: `netlify/functions/gallery.mjs` asks the Apps Script relay for the folder's file
list (only folders inside the photobooth4u Drive folder can be listed) and caches it for a few
seconds; photos load from Google's own thumbnails.

**One-time step:** paste the new `apps-script/upload.gs` into the Apps Script project, then
Deploy → Manage deployments → Edit → Version: **New version** → Deploy (same URL). Until then the
gallery shows a button to the Drive folder instead.

## Admin with many codes
The code list reads one small index (in the `meta` store) instead of every code, so it stays
fast with thousands of bookings: search (client, Drive folder or code, including a bonus code),
filters with counts, sorting, 25/50/100 per page, rows that open for the full details and
actions, bulk disable / restore / delete (up to 200), **Export CSV** of the current view, and
**Rebuild index** (only needed if the list ever looks out of date). The index builds itself the
first time Admin opens after this update.

## Traditional booth (laptop + guest screen)
Admin turns it on per rental code (**Make traditional**, or tick it when generating codes); the
trial has its own switch. An open booth switches within ~5 minutes. Tablets (iPad / Android)
stay in the normal tablet mode.

1. Connect the second monitor and set Windows/macOS display to **Extend**.
2. Start Chrome or Edge **without `--kiosk`** but with silent printing, e.g.
   `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://photobooth4u.netlify.app/`
   (`--kiosk` forces one full-screen window, which blocks the guest screen.)
3. Unlock, finish Setup, go to **Photo Session → Open guest screen**. Allow pop-ups and
   "window management" if Chrome asks; it then moves the guest screen to the second monitor.
   Click the guest screen once for full screen.
4. Guests start a session by tapping the guest screen, or pressing **Space / Enter** or a
   presenter clicker (Page Down / arrows). The finished photo and QR show on the guest screen.

**Auto-print** (traditional only): after the operator's first print, every following session
prints by itself on the same paper size (switch it off any time in the Print box). With
`--kiosk-printing` there is no dialog at all.
