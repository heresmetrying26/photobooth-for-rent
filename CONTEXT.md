# Session Context

**Current Task**: Release Desktop 1.1.25 and Android 1.1.43 with clean Wi-Fi UI, auto-linked hotspot, undistorted GIF scaling, and solo white frame.

**Key Decisions**:
- Cleaned up redundant Wi-Fi inputs in Setup Step 6 when hotspot is active; linked hotspot checkboxes.
- Fixed GIF aspect distortion by dynamically sizing slot canvases to native camera ratio and using drawImageCover.
- Isolated Solo 1 large frame GIF to default white border frame without custom strip frame overlay contamination.

**Next Steps**:
- Push `desktop-v1.1.25` and `android-v1.1.43` tags to trigger GitHub Actions builds.
- Verify in-app update prompt for Desktop and Android on client devices.
- Confirm guest GIF playback and clean Wi-Fi setup during booth operations.
