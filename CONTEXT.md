# Session Context

**Current Task**: Release Desktop v1.0.109 and Android v1.1.23 with camera performance optimizations.

**Key Decisions**:
- Bumped Desktop app to v1.0.109 and Android tablet app to v1.1.23 (versionCode 125).
- Bundled camera live view & capture performance optimizations from commit c24522b into release.
- Added automated CI step to deploy built Android APK to Netlify CDN on tag push.

**Next Steps**:
- Push release tags desktop-v1.0.109 and android-v1.1.23 to trigger GitHub Actions builds.
- Verify in-app updater on Android tablet and desktop apps.
