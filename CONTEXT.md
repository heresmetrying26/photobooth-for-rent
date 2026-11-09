# Session Context

**Current Task**: Release Desktop v1.0.110 and Android v1.1.24 with Roving DSLR Bridge.

**Key Decisions**:
- UsbCameraHelper polls physical shutter presses on Canon, Nikon, and Sony DSLRs over USB OTG.
- RovingBridgeActivity streams JPEGs via HTTP POST to desktop booth with haptic feedback & pocket lock.
- Incoming roving photos queue automatically in Photographer Desk for review before printing.

**Next Steps**:
- Commit and push to main and create release tags (desktop-v1.0.110, android-v1.1.24).
- Verify CI builds and releases on GitHub Actions.
