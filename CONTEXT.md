# Session Context

**Current Task**: Release desktop v1.1.13 and android v1.1.30 with dynamic GIF duration, fast-forwarding, and interactive tooltips.

**Key Decisions**:
- Bumped desktop app version to `1.1.13` (replacing `1.0.113`) and Android app to `1.1.30` (versionCode 132).
- Added release notes to `netlify/lib/updates.mjs` and updated download references in `public/downloads/index.html`.
- Prepared release tags `desktop-v1.1.13` and `android-v1.1.30` for GitHub Actions.

**Next Steps**:
- Commit changes and push tags to trigger GitHub Actions release builds.
- Verify desktop and Android release artifacts.
