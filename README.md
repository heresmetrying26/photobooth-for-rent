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
- **Upload retry + waiting list:** each Drive upload is tried 3 times. If it still fails, the
  photo is kept on the device (IndexedDB) and the Photo Session panel shows **Waiting to
  upload** with **Retry now** / **Save to this computer**. Waiting photos upload by themselves
  every 30 s and when the browser comes back online, also after a reload. The guest gets the
  event's All photos QR meanwhile. Photos the code can no longer upload (expired/locked) stay
  listed until saved to the computer.
- **Backup folder (Chrome / Edge on a computer):** Setup → 5 Share → **Choose backup folder**.
  Every session's photo (full-quality PNG) is then written to `<folder>/<event name>/` instead
  of Downloads. After a browser restart Chrome asks again: tap **Allow saving** (Setup or the
  Photo Session panel). Tablets and other browsers keep saving to Downloads.

## Printing (per rental)
Printing is **off** unless you turn it on in Admin — when creating codes, or later with
**Print settings** on any code (an open booth picks the change up within ~5 minutes).
Pick which paper sizes that renter may use: 2×6 strip, 3R (3.5×5), 4R (4×6), 5R (5×7),
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

## USB camera (remote control) mode
For DSLR / mirrorless cameras in their **Photo Import / Remote Control** (Canon) or **PTP/MTP**
(Nikon) USB mode, so the camera's own photo settings and flash apply. Pick
**"DSLR / mirrorless over USB (remote control)"** in the Camera menu and choose the camera in
Chrome's USB picker (only the first time; it stays allowed). Live view comes from the camera;
each shot fires the real shutter (about 2.5–3 s per shot incl. transfer, shown as "Saving").
- Chrome or Edge on a **Mac or Android** only. Windows blocks it (camera driver); Safari has no USB.
- Quit Photos, Image Capture, EOS Utility / Nikon apps first. Mode dial on M/P/A/S, JPEG (not RAW).
  A smaller JPEG size (e.g. Medium/Normal) makes each shot faster. Use a mains adapter: live view drains batteries.
- Live view is low-res (e.g. 640×424 on a D5600); the photos are full quality (cropped, max 2000 px).
- If a shot fails (focus, RAW), the live-view frame is used and a note shows.
- Needs the COOP/COEP headers on `/` in `netlify.toml`. Uses web-gphoto2 (LGPL-2.1) from
  `public/camera-test/build/`; `/camera-test/` is a stand-alone test page for any camera.
- Tested: Nikon D5600 on macOS Chrome (shutter, live view, settings). Canon not yet tested.

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
- Tested: macOS/Linux path (CUPS `lp`) end to end with stand-in printers. Windows printing (PowerShell
  .NET) not yet tested on a real printer.

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

## My Events page (`/lifetime/`)
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
Setup is in 5 steps, one at a time: **1 Design** (two tabs: **Ready designs** and **🎨 Colours & background**) · **2 Text** (name,
date, small line, title style, fonts, colour) · **3 Layout** (layout, guests' choice, countdown) ·
**4 Extras** (Frame / Logo / Stickers / Filter tabs) · **5 Share** (Drive folder, all-photos QR to print
ahead, printing). The step bar stays at the top with a one-line summary of each step (red = still
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
- **Your own frames** (Setup → 4 Extras → Frame): upload a frame made in Canva with the photo spots left **white
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

## Online gallery (`/g/<folder id>`)
Guests' QR codes open a photobooth4u gallery page instead of Google Drive: a photo grid,
full-screen viewer with swipe, a Download button per photo, "Download all (Google Drive)",
the "download by" date, and new photos appear by themselves during the event. Admin → **Guest QR
codes** switches every booth back to the plain Drive folder if ever needed. My Events shows both.

**After each session** the booth (and the guest screen) shows a **Your photo** QR code. It opens the
gallery straight on that photo (`/g/<folder>#<file id>`); with Admin set to Drive it opens the file in
Google Drive. The **All photos** QR
for the whole event is only in Setup → 5 Share, to print or share ahead. Between shots the pause
shows the photo just taken and "Next: photo 2 of 3", with no countdown circle.

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
