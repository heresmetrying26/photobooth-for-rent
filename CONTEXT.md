# Session Context

**Current Task**: Release Desktop v1.1.19 and Android v1.1.36 with Separate Sharing Station (live auto-pop, audio chime, fast booth handoff & privacy mode).

**Key Decisions**:
- Bumped desktop app version to `1.1.19` and Android app to `1.1.36` (versionCode 138).
- Implemented Separate Sharing Station across Desktop (`desktop/lib/photos.mjs`), Android (`LocalShareServer.kt`), and Web (`public/station/index.html`).
- Added live auto-pop, offline Web Audio melodic chime, countdown timer bar, and privacy mode (single session vs gallery).
- Added "Show QR on a separate Sharing Station" toggle with 2s animated handoff overlay and pairing QR in `protected/booth.html`.
- Prepared release tags `desktop-v1.1.19` and `android-v1.1.36` for GitHub Actions.

**Next Steps**:
- Push main branch and release tags (`git push origin main --tags`) to trigger GitHub Actions release builds.
