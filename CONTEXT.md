# Session Context

**Current Task**: Released Desktop 1.1.70 (Win/Mac), Android 1.1.82 (`versionCode 184`), and iPad 1.1.5 (`15`) for iPad front camera and live preview transparency fixes.

**Key Decisions**:
- High-specificity CSS transparency rules placed at end of stylesheet to keep `#stageFrame` transparent over native AVCaptureSession preview layer during sessions.
- Added `.builtInUltraWideCamera` to Swift discovery so 10th-gen / A16 iPad Center Stage front cameras open cleanly.
- Added `nativeCamHasFrame()` guard to prevent blank/black canvas in Setup Step 4 before camera stream initializes.

**Next Steps**:
- Verify Netlify build deploys web updates so existing iPads on 1.1.3/1.1.4 get the live preview CSS fix on "Check for updates".
- Verify GitHub Actions CI builds iPad 1.1.5 IPA for Ultra-Wide / Center Stage native support.
- Test physical iPad on A16 Center Stage front camera.
