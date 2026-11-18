# Session Context

**Current Task**: Released Desktop 1.1.65 & Android 1.1.77 with optional Photographer desk photo editing (applied to print + guest QR), separate countdown timers, native iOS camera bridge, and /features/ guide.

**Key Decisions**:
- Added optional per-photo editor (`✎ Edit photo`) in the Photographer desk queue (`brightness`, `contrast`, `warmth`, `saturation`, presets, Hold to compare) applied to print + QR outputs while leaving Roving inbox originals untouched.
- Placed the `✎ Edited` badge at bottom-left (`bottom: 6px; left: 6px;`) so it never collides with selection, phone (`📱`), or `Printed` badges.
- Bumped Desktop to `1.1.65` and Android to `1.1.77` (`versionCode 179`), pushed `main`, `desktop-v1.1.65`, and `android-v1.1.77`.

**Next Steps**:
- Confirm GitHub Actions workflows for `desktop-v1.1.65` and `android-v1.1.77` finish green and attach installers/APK.
- Confirm Netlify production deploy succeeds and `/api/updates` + `/features/` load live.
