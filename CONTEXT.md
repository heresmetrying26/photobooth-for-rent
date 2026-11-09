# Session Context

**Current Task**: Separate standalone Roving DSLR Bridge APK with instant camera QR code pairing.

**Key Decisions**:
- Created dedicated standalone `roving-dslr-bridge-android.apk` variant script & GitHub workflow.
- Added in-app ZXing camera QR scanner to `RovingBridgeActivity` for 1-second pairing.
- Dedicated download card and instructions added to `public/downloads/index.html`.

**Next Steps**:
- Verify roving DSLR OTG bridge with physical cameras (Canon, Nikon, Sony).
- Confirm Photographer Desk queue and print workflow on base station laptop.
