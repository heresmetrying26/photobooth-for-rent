# Session Context

**Current Task**: Fix Android tablet gallery loading hang by routing local gallery requests via loopback.

**Key Decisions**:
- Intercepted local share gallery requests in `MainActivity.kt` to load directly via `127.0.0.1` inside WebView.
- Added `localBase()` loopback endpoint to `PBLocal.kt` and supported base64url slugs in `LocalShareServer.kt`.
- Added request timeout handling and "← Back to booth" button in `gallery.html` for kiosk workflow.

**Next Steps**:
- Push commits and tag `android-v1.1.28` to build APK on GitHub Actions.
- Test "Open gallery" on Android tablet in offline mode and on Wi-Fi.
