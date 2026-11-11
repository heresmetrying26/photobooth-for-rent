# Session Context

**Current Task**: Release Desktop v1.1.22 and Android v1.1.39 with LumaShare-style Sharing Station session mode.

**Key Decisions**:
- Defaulted Sharing Station (desktop, android, online) to single-session mode with standby and direct photo QR.
- Added session pills selector so guests can switch between composite strips, solo photos, and GIFs.
- Pushed commits and tags (`desktop-v1.1.22`, `android-v1.1.39`) to trigger GitHub Actions release builds.

**Next Steps**:
- Verify completion of GitHub Actions release builds for Desktop v1.1.22 and Android v1.1.39.
- Pull main after Android APK deploys to Netlify CDN via automated GitHub Action.
- Verify in-app auto-update on desktop and Android test devices.
