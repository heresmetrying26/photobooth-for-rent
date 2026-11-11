# Session Context

**Current Task**: Release Desktop v1.1.23 and Android v1.1.40 with 58mm mobile thermal printer pacing and Sharing Station QR fix.

**Key Decisions**:
- Fixed QR code generation: removed ESM syntax error in `qr.js`, inlined library in station page to avoid 404/network latency, added retry fallback.
- Implemented 256-byte paced transfers (8ms delay) & 2s inter-copy delay for 58mm USB mobile thermal printers.
- Both `desktop-v1.1.23` and `android-v1.1.40` built and deployed to GitHub Releases and Netlify CDN APK.

**Next Steps**:
- Update desktop and Android apps to v1.1.23 / v1.1.40.
- Verify QR code renders properly on Sharing Station standby and auto-pop modal.
- Test 58mm receipt printing with consecutive copies and tear feed.
