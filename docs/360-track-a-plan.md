# 360 Track A: Send page v2 (no install, iPhone and Android)

Goal: scan the QR on the 360 desk, attach the phone to the arm, the laptop gives the countdown and the stop cue, the phone's own Camera records (Bluetooth remote for start/stop), the clip uploads, the laptop trims, edits (Auto mode) and makes the QR. Offline, no install.

Status key: [x] done and tested here, [~] done but not tested on real hardware, [ ] not done.
Nothing here is committed, versioned or released.

## Done (2026-11-17)

### Server: desktop/lib/photos.mjs
- [x] `spinSendCfgSet`, `spinClipsSet`, `spinSendTake` exports.
- [x] `GET /send/<t>/config`, `GET /send/<t>/clips`.
- [x] `POST /send/<t>/choice` (look, music, speed, text, gif; only what the desk offers; newest wins).
- [x] `POST /send/<t>/act` (reedit, share, print, delete; delete moves the clip to `inbox/deleted/`).
- [x] `POST /send/<t>/cmd?do=countdown` (rate limited).
- [x] Tests: `desktop/test/test-send-v2.mjs` (all pass).

### Phone page (SEND_PAGE in photos.mjs)
- [x] Connected line, recording guide from the desk, optional choices (remembered on the phone), Record now / Choose a video, upload progress with auto-retry (whole file, 3 tries), live status list, guest QR and link, actions (re-edit, share, print, delete with confirm), "Start the countdown on the laptop" button.
- [x] Checked in a browser against a demo server: connects, shows guide, choices, clips, QR image, countdown button works.
- [~] iPhone Camera sheet, Bluetooth remote, long 4K upload over a hotspot: untested.

### IPC: desktop/main.mjs, desktop/preload.cjs
- [x] `pb4u:spinSendSet`, `pb4u:spinClipsSet`, `pb4u:spinSendTake` and bridges.

### Booth page: protected/src/booth.src.html (built into protected/booth.html and the android/ios copies)
- [x] Desk card "Phone send page & spin timer" in Videos & Queue: spin time, spins, arm starts after, keep before, tail, countdown, cut-to-spin, timer sound, which choices phones may make.
- [x] Settings saved in localStorage `pb_spin_send` and pushed to the server every poll (only when changed).
- [x] Clip status pushed to the phone page; phone choices applied per clip (look, music, speed, name, GIF) and put back afterwards (`spinSendApply`, `spinAuto` wrapper).
- [x] Auto-trim: `it.trimA` / `it.trimB` set on arrival from the settings (the renderer already supported them).
- [x] Spin timer overlay (3-2-1, GO, arm starts, SPIN, DONE, STOP with beeps; Esc or click closes); starts from the desk button or the phone's button.
- [x] `npm run build` and `node scripts/assemble-booth.mjs --check` OK at the last build; scripts parse.
- [~] The booth-page parts (settings card, collector, timer, apply/undo) are not exercised end to end: needs the real laptop app.

## Remaining

### Must do before a release
- [ ] Run the laptop app and walk through it once: set the desk card, scan the QR from a phone, upload a clip, check the trim, the Auto-mode edit, the QR on the phone, the timer, and a phone choice (look, music, speed, name, GIF).
- [ ] Re-run `npm run build` and `node scripts/assemble-booth.mjs --check` right before tagging: `protected/src/booth.src.html` is being edited by someone else at the same time, so the generated files go stale.
- [ ] `node scripts/test-camera-quality.mjs` must pass (one check failed only because the booth page was stale after someone else's edit).
- [ ] `desktop/test/test-360-ui-ux.mjs` needs `desktop/protected/booth.html` (made by a desktop build). It was not runnable here.
- [ ] Desktop release steps from CLAUDE.md (smoke test `desktop/scripts/smoke-test.ps1`, tag, check the 3 installers and `/api/updates`). Version bump and changelog in `netlify/lib/updates.mjs` go with the release, not before. 1.1.57 is already released, so this goes in the next version.
- [ ] No Android or iOS app change is needed (the phone uses a browser). The `booth.html` copies get re-synced by `npm run build`.

### Docs (publish only with the release, they go live on the website)
- [ ] public/how-to-360/index.html, docs/360-guide/360-guide.html, client-guide/, docs/platform-comparison/platform-comparison.html, public/about-us/index.html, changelog text in netlify/lib/updates.mjs, the 360 PDF guides.
- [ ] Update docs/360-arm-phone-simulation to the Send page v2 flow (laptop countdown, Bluetooth remote, desk trim, phone status and remote).

### Possible improvements to Track A
- [ ] Smarter trim: detect where the spin starts (needs a real arm clip to tune). Today the cut uses the "arm starts after" setting.
- [ ] Byte-level upload resume (today a failed upload restarts the whole file).
- [ ] Laptop name on the phone page (`laptop` in the config is empty, so it says "the laptop").
- [ ] If Auto mode is off, phone choices and actions only apply when a clip is edited by the Auto path.

## Later tracks (not started)
- Track B: dropped. Record 360 (the laptop-camera recorder) was removed in Desktop 1.1.62 because a wired camera cannot ride a rotating arm; phones record with their own camera.
- Track C: in-app hands-free recording with auto-pair (Android first, iPhone after). Android hides the 360 desk today; find out why first.
- Track D: arm link over Bluetooth from the laptop (needs the controller model and its protocol).

## Open questions
- Usual spin time and a sample arm clip for tuning the trim.
- Untested on real hardware: iPhone Camera sheet, Bluetooth remote, long 4K upload over the hotspot.
- Who else is editing `protected/src/booth.src.html` right now?
