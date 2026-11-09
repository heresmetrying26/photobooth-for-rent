# Session Context

**Current Task**: Add layout picker cancel button & unclutter toolbar when booth is unlocked.
**Current Task**: Fix CI release builds and verify seamless roving DSLR bridge pipeline.

**Key Decisions**:
- Hidden opDock, topbar and sessionControls when body.picking is active to declutter layout selection.
- Added Cancel button to pickOverlay and Escape key handling to safely reset to attract screen.
- Compacted unlocked opDock.bar buttons with responsive icon-only layout on smaller screens.
- Fixed Kotlin duplicate variable declarations in UsbCameraHelper.kt (nikonCapture and canonCapture).
- Decoupled photo upload in RovingBridgeActivity with a background executor and added clipboard paste.
- Hardened CI workflows: added set -eo pipefail to android.yml and fallback npm install to desktop.yml.

**Next Steps**:
- Verify layout selection and cancellation on physical booth devices.
- Test physical DSLR USB OTG roving bridge capture with auto-print.
- Force-update release tags desktop-v1.0.110 and android-v1.1.24 on GitHub.
- Verify GitHub Actions workflow runs complete with successful release assets.
