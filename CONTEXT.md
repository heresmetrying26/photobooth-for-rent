# Session Context

**Current Task**: Release desktop v1.1.17 and android v1.1.34 with minimizable floating layout dock, supersized side photos, and budget tablet 0ms lag optimization (VOVE Pad 9 Ultra).

**Key Decisions**:
- Bumped desktop app version to `1.1.17` and Android app to `1.1.34` (versionCode 136).
- Replaced bottom layout bar with a minimizable floating dock (movable by header, collapsible to pill) so Start button sits centered and unobstructed in its true position.
- Raised side film track photo scaling limit to 2.5x (250%) with smooth vertical scrolling.
- Integrated commit `3e6bef4` perf optimizations (bypassing takePhoto latency on built-in tablet cameras, switching WebView layer to LAYER_TYPE_NONE, defaulting to 720p viewfinder, and hardware compositing for countdown).
- Prepared release tags `desktop-v1.1.17` and `android-v1.1.34` for GitHub Actions.

**Next Steps**:
- Verify builds and smoke tests.
- Push release tags to trigger GitHub Actions release builds.
