# Session Context

**Current Task**: Released v1.0.89 / desktop v1.0.93 / android v1.0.104: full-screen sticker editor, Bluetooth + USB SELPHY printers reconnect by themselves, printer status chip, Arrange & Print.

**Key Decisions**:
- Sticker editor moves to <body> full screen; previewCanvas is moved into #gsoCanvasBox while decorating (gsoMount / gsoUnmount).
- BTBridge never forgets the printer except on Disconnect; `connectSaved` reconnects off the page thread and reports via `window.__BTEvent`. Prints for an off printer wait in `pw.bt.held` / `pw.usb.held`.
- USB printers are re-found by vendor + product id in `wifiRelink` (SELPHY has no model name until USB access is allowed).

**Next Steps**:
- Test on the real GZM5803L and SELPHY: power off/on between guests and mid-print; check the status chip.
- Mac .dmg of 1.0.93 not checked (release touched main.mjs / preload.cjs): open it on a Mac.
- `public/downloads/pb4u-windows-camera-test/*` still deleted in the working tree (not committed); check why.
