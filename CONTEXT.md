# Session Context

**Current Task**: Release Desktop v1.1.23 and Android v1.1.40 for 58mm mobile thermal printer USB flow pacing, multi-copy delay, and zero-waste tear feed.

**Key Decisions**:
- Implemented 256-byte paced transfers with 8ms delay and 1.5s post-print physical drain in NetPrintBridge.kt to stop buffer overflow and resets.
- Added 2-second inter-copy delay in booth.html to prevent consecutive prints from colliding with an active mechanical thermal print head.
- Hardcoded all 58mm optimizations directly to `Receipt 58 mm` (no separate 10 cm button) with tight 2-line (~8 mm) tear feed to eliminate bottom waste.

**Next Steps**:
- Verify GitHub Actions re-triggered APK build from retagged `android-v1.1.40` → `65f1c90`.
- Client to re-test: 2nd print should no longer cut off; bottom margin should be tighter (~8 mm tear feed).
- Monitor for any QR code issues on share station page (fix landed in `65f1c90`).
