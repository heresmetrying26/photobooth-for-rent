# Session Context

**Current Task**: Release Desktop v1.1.23 and Android v1.1.40 for 58mm mobile thermal printer USB flow pacing, multi-copy delay, and 10 cm paper size.

**Key Decisions**:
- Implemented 256-byte paced transfers with 8ms delay and 1.5s post-print physical drain in NetPrintBridge.kt to stop buffer overflow and resets.
- Added 2-second inter-copy delay in booth.html to prevent consecutive prints from colliding with an active mechanical thermal print head.
- Added "Receipt 58 mm (10 cm)" paper size to scale any 2x6 custom frame, strip, or receipt into an exact compact 10 cm strip.

**Next Steps**:
- Verify APK build and in-app update on Android tablet with MP58C7 printer.
- Confirm client test with "Receipt 58 mm (10 cm)" and standard "Receipt 58 mm".
