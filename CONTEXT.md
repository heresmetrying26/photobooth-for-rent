# Session Context

**Current Task**: Release v1.0.74 (Desktop v1.0.77, Android v1.0.88): 360 studio polish found by simulating the full flow (share QR, rendered preview, Spin & Print preview, tablet layout).

**Key Decisions**:
- Share modal video no longer inherits the global absolute `video` rule; QRs show, password is hidden until tapped.
- Rendered clips open as the rendered video (badge, overlay preview off, one-tap Edit again); locked cards stay scrollable.
- Spin & Print shows a layout preview first (re-pick moments, mode, paper); auto-print still skips it.
- Space key no longer hijacked by the remote shutter inside text fields.

**Next Steps**:
- GitHub Actions packages installers on tag push (v1.0.74, desktop-v1.0.77, android-v1.0.88).
- Test real render, Wi-Fi share and printing on the laptop and tablet before the event.
