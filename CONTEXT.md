# Session Context

**Current Task**: Release v1.0.83 / android v1.0.98: per-option prints ("no print" softcopy option), thermal darkness (Lightness now works on receipt layouts + test strip), Bluetooth 58mm gibberish fixes (paced writes, Compatibility mode, GZM5803L).

**Key Decisions**:
- Each payment option has `prints` (null = default, 0 = softcopy only, 1-5). Found by label (labels forced unique); no server change. `noPrintSession()` hides the guest Print button / auto-print.
- Receipt layouts dither photos in `ditherRegion`, which now applies the printer's Lightness; `printAdjust` skips those pages (`_pbToneDone`).
- Bluetooth jobs are paced (`btPacing`); `BTBridge.writePaced` + `release` need the new APK, the page falls back to JS pacing on older ones. Edit files with LF endings; `npm run build` syncs booth copies and android-version.mjs.

**Next Steps**:
- Run the Bluetooth checks (text / small picture / full strip) on the GZM5803L-BL and the darkness test strip on the 80mm USB printer; tune defaults from the results.
- Not done: printer density command (ESC 7 / GS ( K), lighter film-strip frame layout; guests' "Ask for a print" button is not hidden for no-print sessions.
- `public/downloads/pb4u-windows-camera-test/*` shows as deleted in the working tree (not from these releases); check why.
