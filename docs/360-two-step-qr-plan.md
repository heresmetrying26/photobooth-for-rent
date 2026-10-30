# 360 video booth: "Step 1 Network / Step 2 Download" QR screen

## What the reference shows
A 360 booth that, when the clip is ready, puts two QR codes on its TV, side by side:
1. **Step 1, Network**: a Wi-Fi QR. Scanning it joins the guest's phone to the booth's own Wi-Fi (no typing a password).
2. **Step 2, Download**: a QR to the clip itself, served from the booth. Nothing goes through the internet.

It works at venues with no internet, and a 360 clip is a big MP4, so serving it over the local network is faster than uploading it.

## What we already have (don't rebuild)
| Piece | Where |
|---|---|
| Local share server (photos, GIFs, mp4/webm, `?dl=1` download, previews) | `android/.../LocalShareServer.kt`, `desktop/lib/photos.mjs` |
| Booth's own Wi-Fi/hotspot address detection | `PBLocal.kt` (~L572), `photos.mjs` (~L127) |
| 360 clip editing (trim, slow-mo, MP4 for phones) | `desktop/lib/spin.mjs` |
| 360 guide for operators | `public/how-to-360/index.html` |
| QR library | `public/gallery/qrcode.min.js`, `scripts/vendor/qrcode.min.js` |

Gap: today the guest gets **one** QR (the page URL) and must already be on the booth Wi-Fi. The Wi-Fi join QR is the missing piece.

## Update: laptop step done
The Wi-Fi name/password setting and Wi-Fi QR already existed for the printed sheet (`wifiInfo()` / `wifiQrText()` in `protected/booth.html`), so step 1 of the plan was not needed. The 360 player window now shows **Step 1: Network** and **Step 2: Download** QRs side by side when a Wi-Fi is set. Android, docs and tests are still to do.

## Plan

### 1. Setup: booth Wi-Fi details
- Add to Setup > Share: **Wi-Fi name (SSID)**, **password**, **security** (WPA / none), **hidden network** toggle. Stored locally with the other booth settings; never sent anywhere.
- Laptop and Android: operator types them in once (a router or phone hotspot they control). Android can't read a normal hotspot's password programmatically, so we ask, and add a "copy from this tablet's hotspot settings" hint.
- Validate on save: SSID required, password 8+ chars for WPA, escape `\ ; , : "` as the Wi-Fi QR format requires.

### 2. Two-QR screen
- Build the payload `WIFI:T:WPA;S:<ssid>;P:<password>;H:false;;` and render it with the existing QR library.
- New "360 finished" screen on the guest display: **Step 1 Network** QR on the left, **Step 2 Download** QR on the right, large and labelled, with the event's branding/overlay in the middle (as in the reference, the clip preview can sit between them).
- Step 2 URL reuses the existing `/e/<event>/p/<file>` page (Save video button). Consider a direct `?dl=1` option for one-tap save.
- Option in Setup > Share: **Show Wi-Fi QR** (on/off). Off = today's behaviour, for venues where guests are already on the Wi-Fi.
- Auto-hide Step 1 when the phone is likely already connected (setting only; we can't detect it).

### 3. Wire it into the 360 flow
- After `spin.mjs` finishes the MP4, save it into the event folder, then show the two-QR screen.
- While rendering, show a "Making your video" state so guests don't scan a link that isn't ready.
- Cap/compress clip size (existing MP4 settings) so downloads over local Wi-Fi stay quick; add a "light" preset for crowded events.

### 4. Edge cases to handle in copy and UI
- Phones may drop a Wi-Fi network that has no internet and fall back to mobile data. Add a one-line tip on the guest page ("If the page won't open, stay on the booth Wi-Fi") and in the operator guide.
- iOS Camera and Android 10+ Camera join Wi-Fi from the QR; older Android may need Google Lens or a QR app. Note this in the guide.
- Many guests at once: keep the server read-only, and make sure large MP4 range requests work for playback.
- Password is visible on the TV by design (QR hides it). Recommend a dedicated booth Wi-Fi with a throwaway password, not the venue's.

### 5. Docs and marketing
- Update `public/how-to-360/index.html` with a "Share by QR with no internet" section and a table of what to set.
- Add a line to the 360 product/pricing copy: works with no internet.

### 6. Test checklist
- iPhone and Android phone: scan Step 1 joins, Step 2 opens, Save video works.
- No internet on the router: still works.
- Special characters in SSID/password (`;`, `,`, `:`, `\`, quotes).
- Laptop build and Android build both show the screen.
- 30+ MB clip downloads with 5 phones at once.

## Open questions
1. Is the 360 flow on **laptop only**, **Android only**, or both? (Plan assumes both; laptop first if only one.)
2. Does the operator use a **separate router** or the device's own hotspot? Affects the Setup wording.
3. Should Step 2 open the page with a preview, or download the file straight away?
4. Show the Wi-Fi password in text under the QR as a fallback for phones that can't scan it?

## Suggested order
1. Setup fields + Wi-Fi QR payload (small, testable alone)
2. Two-QR screen on laptop
3. Same on Android
4. Docs, copy, test checklist
