# Session Context

**Current Task**: Release v1.0.76 (Desktop v1.0.79, Android v1.0.90): in-page dialogs, working Save-as-preset, in-place queue tiles, preset placeholder, bigger Line 2 default, re-pick spinner.

**Key Decisions**:
- `pbChoose` in-page choice box replaces confirm() in the 360 studio (Cancel focused); `askText` and the choice box sit above the studio (z-index 10100).
- Save as preset uses `askText` because the laptop app has no `prompt()`.
- Queue tiles are updated in place by clip id; video thumbnails reload only when their source changes.
- Line 2 default size is 34; re-pick shows a spinner and locks the preview controls.

**Next Steps**:
- GitHub Actions packages installers on tag push (v1.0.76, desktop-v1.0.79, android-v1.0.90).
- Still to test on real hardware: render progress/cancel/errors, Wi-Fi sharing, Epson/Canon printing.
