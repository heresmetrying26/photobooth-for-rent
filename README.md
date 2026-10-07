# Photo Booth – rental edition

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
4. Open `https://YOUR-SITE.netlify.app/admin.html` to create rental codes.

## Updating the booth
Edit `protected/booth.html` and redeploy. (The build step re-bundles it automatically.)

## How it works
- **Trial password** – reusable, unlocks for N minutes (default 15). Change/disable in Admin.
- **Rental codes** – `PB-XXXX-XXXX-XXXX`, one-time use. Days start counting on first entry.
  Bound to the first device; other devices are refused. Expiry is enforced on the server.
- **Admin** – create codes (by days), see status/time left, add days, disable/restore, delete,
  "Allow new device" (if the renter switches tablets), and edit trial settings.
- When time is up, the app returns to the lock screen (after any photo session in progress).

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

### Kiosk / silent printing (no print dialog)
Browsers always show a print dialog unless Chrome/Edge is started in kiosk-printing mode,
which sends every print straight to the **default printer**:

1. Set the photo printer as the computer's **default printer**, and in its printer
   preferences choose the paper size you'll use (e.g. 4×6) and **borderless** if offered.
2. Close all Chrome windows, then start Chrome with:
   - Windows (shortcut target):
     `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing https://YOUR-SITE.netlify.app/`
   - macOS: `open -a "Google Chrome" --args --kiosk --kiosk-printing https://YOUR-SITE.netlify.app/`
   - Edge works the same with `msedge.exe --kiosk https://YOUR-SITE.netlify.app/ --kiosk-printing`.
   Leave out `--kiosk` if you want a normal window but still silent printing.
3. Do one test print first. If the size or margins are off, fix them in the printer's own
   preferences — silent mode uses the printer defaults for anything the page doesn't set.

Without kiosk mode the normal print dialog opens: pick the photo printer, set Margins to
**None** and Scale to **Default/100%**, then print.
