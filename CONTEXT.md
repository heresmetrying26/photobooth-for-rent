# Session Context

**Current Task**: Resolve photo session lag on VOVE Pad 9 Ultra / Android tablets.

**Key Decisions**:
- Fixed `webcamMaxShot` bypass on built-in tablet cameras (`isBuiltInCamera`) so frames are captured instantly from viewfinder.
- Switched `MainActivity.kt` WebView layer to `LAYER_TYPE_NONE` to eliminate offscreen FBO copy bottlenecks.
- Optimized Android tablet default viewfinder resolution to 720p for smooth 30fps and added countdown GPU compositing layers.

**Next Steps**:
- Verify tablet performance during live photo session on VOVE Pad 9 Ultra.
- Test external USB webcams and built-in front/rear tablet cameras.
