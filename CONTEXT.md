# Session Context

**Current Task**: Release Desktop 1.1.24 and Android 1.1.42 with deep DSLR battery optimization and dslrBooth-style autofocus test shot workflow.

**Key Decisions**:
- Desktop 1.1.24 verified and deployed with full camera battery saver, autofocus test shot UI, and PTP settle fixes.
- Bumped Android to v1.1.42 (versionCode 144) to trigger APK build on Netlify CDN and in-app auto-update.
- Added comprehensive in-app camera battery guide in Step 4 and Live View sleeping during template selection.

**Next Steps**:
- Push `android-v1.1.42` tag to trigger GitHub Actions Android build.
- Verify in-app update prompt appears on Android devices running v1.1.41.
- Confirm client tests Nikon D5300 with strobe light setup.
