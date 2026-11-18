# Session Context

**Current Task**: Released Desktop 1.1.68 (Win/Mac), Android 1.1.80 (`versionCode 182`), and iPad 1.1.3 (`13`) for Sony A7 III USB & iPad HDMI stability.

**Key Decisions**:
- Hardened `ILCE-7M3` across Windows, Mac, Android, and iPad: direct Protocol v3 (`0x12C`), `0x9201` `BUSY` retries, shutter release on open/close, width-safe `0x5013`/`0xD222` writes, and `sonyDestBlocked`.
- Hardened iPad `.external` UVC/HDMI capture in `NativeCameraBridge.swift`: skip `AVCapturePhotoOutput` and recover runtime/interruption events cleanly.
- Pushed `main` plus tags `desktop-v1.1.68`, `android-v1.1.80`, and `ios-v1.1.3`.

**Next Steps**:
- Confirm GitHub Actions builds finish green (`desktop-v1.1.68`, `android-v1.1.80`, `ios-v1.1.3`) and Netlify deploys `/api/updates`.
- Test Sony A7 III on physical Windows, Mac, Android, and iPad hardware.
