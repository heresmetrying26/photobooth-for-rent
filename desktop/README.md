# photobooth4u for Windows and Mac (offline app)

The same booth as photobooth4u.netlify.app, installed on a laptop and working with **no internet**.
It is an add-on to a normal PB code (Admin → **Give offline app**). The website is not changed by
anything in this folder, and Netlify never builds it.

## What renters get
- The full booth: designs, frames, layouts, guest options, background AI, retakes, Lock booth, traditional
  mode with the guest screen, vouchers.
- **USB camera**: Windows Nikon through the built-in helper (same as Print Helper 1.1.3, no Zadig);
  Mac over USB, the same way as in Chrome. Webcams and HDMI capture as before.
- **Silent printing** to a named printer per paper size (built in; no Print Helper to install).
- **Photos on the laptop**: `Pictures/photobooth4u/<event>/1_strip.jpg …` (Share & start → *Open photos folder*
  / *Change folder*). Nothing is uploaded.
- **Guests' QR codes** open the photo from the laptop over the booth Wi-Fi
  (`http://<laptop address>:47777/e/<event id>/`): one photo page with a **Save photo** button, and an
  *All photos* gallery. Guests' phones must be on the same Wi-Fi as the laptop (a router at the booth, or the
  laptop's own hotspot). Optional: type the Wi-Fi name and password in Share & start, and guests get a
  **Join Wi-Fi** QR next to their photo QR (also on the printable QR sign).

Not in the app (they need the internet): QR payments (GCash / Maya; vouchers work), the online gallery and
Google Drive, My Events, the laptop print station for iPads, and trial codes.

## The licence (how it stays secure)
- Activation needs the internet once: the renter types their code; photobooth4u.netlify.app checks the
  code has the add-on and a free device slot, and sends back a **licence signed with Ed25519**
  (`PB4U-LIC1.…`). The private key only lives in Netlify (`PB_LICENSE_KEY`); the app has only the public key,
  so nobody can make or extend a licence.
- The licence names **this computer** (Machine ID `WIN-…` / `MAC-…`), so it doesn't work when copied.
- **Rental codes** stop at the code's end date. **Lifetime codes** renew by themselves whenever the
  laptop has internet; without internet they keep working for 75 days + 30 days' grace, then ask to connect once.
- Admin changes (print sizes, vouchers, retakes, lock, removing the laptop, disabling the code, taking the
  add-on away) reach the laptop at its next check-in (when online, at most every 12 hours; renters can
  also tap **Check for changes**).
- Turning the computer clock back locks the booth until the clock is right, and when online the app
  compares its clock with the internet's.
- **No internet at all?** On the activation screen: *Activate without internet* shows the Machine ID.
  In Admin, open the code → **Offline activation key**, paste the Machine ID, copy the licence back to the renter.
- Each laptop uses one of the code's device slots ("Windows app" / "Mac app" in Admin).
  *Deactivate this laptop* (Share & start) frees it.
- The booth page inside the installer is scrambled, and the app is packaged with Electron's integrity
  checks (asar integrity, no run-as-Node, no debugging flags). Code signing comes next (see below).

## Building the installers (GitHub)
1. Once: set `PB_LICENSE_KEY` in Netlify (run `node scripts/make-license-key.mjs` in the repo root) and
   deploy, so `https://photobooth4u.netlify.app/api/license?pub=1` answers. The build reads the public
   key from there (or from a `PB4U_LICENSE_PUB` repository secret, or `desktop/license-pubkey.txt`).
2. Push the repo to GitHub, open **Actions → Desktop app → Run workflow**.
3. After ~10 minutes, download **photobooth4u-windows-latest** (`.exe` installer) and
   **photobooth4u-macos-latest** (`.dmg` for Apple Silicon and Intel) from the run's *Artifacts*.
   Pushing a tag like `desktop-v1.0.0` also attaches them to a GitHub release.

Change `version` in `desktop/package.json` for each new release. The app always contains the booth as it
is in `protected/booth.html` when it is built, so rebuild after booth changes.

### Not code-signed yet
- **Windows**: SmartScreen says "Windows protected your PC" → **More info → Run anyway**. The installer asks
  for admin once (it adds a firewall rule so guests' phones can reach the laptop on private networks).
- **Mac**: the first time, right-click the app → **Open** (or System Settings → Privacy & Security →
  **Open Anyway**). When macOS asks to accept incoming network connections, click **Allow** (that's the
  guests' QR). Signing + notarization (Apple Developer, $99/yr) and a Windows certificate remove these steps.

## Running it from source
```
cd desktop
npm install
npm start          # = node scripts/prepare.mjs && electron .
```
`PB4U_SERVER=http://localhost:8888` points activation at a local `netlify dev`.

## How it's put together
- `main.mjs` — the app. Serves the booth at `app://booth/` (cross-origin isolated, like the website),
  permissions (camera, USB, guest screen on the second monitor), the menu, check-ins.
- `lib/server.mjs` — runs the website's own functions (`setup`, `pay` vouchers, `prints`, `verify`, `app`)
  copied by `scripts/prepare.mjs` from `netlify/`, storing in files (`lib/store.mjs`) instead of Netlify Blobs.
  The licence becomes a local code record, so the booth works exactly like on the web.
- `lib/photos.mjs` — saves photos (the booth's Drive upload goes to `/local/drive`) and serves the guests'
  pages on port 47777 (47778, 47779… if busy).
- `lib/helper.mjs` — printing + the Windows camera, same as `tools/print-helper` (answers at `/helper/…`).
- `lib/licence.mjs` — Machine ID, licence checks, activation, check-ins, clock checks.
- `pages/activate.html` — activation / renewal screen. `preload.cjs` — the small bridge the booth uses.
- In `protected/booth.html`, everything app-only is behind `DESKTOP` (set when `window.__PB.desktop` and
  the bridge exist), so the website behaves as before.
