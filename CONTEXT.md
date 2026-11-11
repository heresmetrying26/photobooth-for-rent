# Session Context

**Current Task**: Release Desktop v1.1.22 and Android v1.1.39 with LumaShare-style Sharing Station (pure session mode, single-photo QR, multi-item session pills).

**Key Decisions**:
- Defaulted Sharing Station (desktop, android, online) to LumaShare Session Mode: clean standby between sessions, no gallery grid shown.
- QR code on sharing station now points directly to individual photo download (`/e/<slug>/p/<file>` offline, `/g/<folderId>#<fileId>` online), never the full event album.
- Added session pills selector so guests can switch between composite strips, solo photos, and GIFs from their session.
- Fresh session auto-display: opening the station within 2 minutes of photos being taken immediately displays that session.
- Bumped versions to Desktop `1.1.22` and Android `1.1.39` (versionCode 141), tagged `desktop-v1.1.22` and `android-v1.1.39`.

**Next Steps**:
- Push commits and tags (`git push origin main --tags`) to trigger GitHub Actions release builds.
