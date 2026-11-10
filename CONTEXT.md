# Session Context

**Current Task**: Release desktop v1.1.16 and android v1.1.33 with camera anti-glitch & truncation protection.

**Key Decisions**:
- Bumped desktop app version to `1.1.16` and Android app to `1.1.33` (versionCode 135).
- Added JPEG truncation (missing EOI) check and bottom scanline streak detection with clean viewfinder fallback in booth.html.
- Prepared release tags `desktop-v1.1.16` and `android-v1.1.33` for GitHub Actions.

**Next Steps**:
- Verify builds and smoke tests.
- Push release tags to trigger GitHub Actions release builds.
