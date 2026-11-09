# Session Context

**Current Task**: Fix CI release builds and verify seamless roving DSLR bridge pipeline.

**Key Decisions**:
- Fixed Kotlin duplicate variable declarations in UsbCameraHelper.kt (nikonCapture and canonCapture).
- Decoupled photo upload in RovingBridgeActivity with a background executor and added clipboard paste.
- Hardened CI workflows: added set -eo pipefail to android.yml and fallback npm install to desktop.yml.

**Next Steps**:
- Force-update release tags desktop-v1.0.110 and android-v1.1.24 on GitHub.
- Verify GitHub Actions workflow runs complete with successful release assets.
