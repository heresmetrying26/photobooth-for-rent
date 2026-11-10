# Session Context

**Current Task**: Release Desktop v1.1.21 and Android v1.1.38 with Live Layout Editor improvements (sticker corner handles, dummy guest photos, 4th photo resizing & top bar clearance).

**Key Decisions**:
- Bumped desktop app version to `1.1.21` and Android app to `1.1.38` (versionCode 140).
- Scoped all `.leb-handle` and `.leb-resizable` corner points strictly to layout editor mode (`body.layout-editing`), eliminating any handle leakage into live guest sessions.
- Injected rich, colorful SVG dummy guest photo placeholders with "Photo 1"–"Photo 4" badges into empty sample frames.
- Attached corner resize handles directly to each photo frame (including the 4th photo) and ensured 28px bottom breathing room so handles are never pushed offscreen or clipped.
- Positioned countdown preview overlay cleanly below the topbar header tabs (`top: 74px !important`) with high z-index.
- Prepared release tags `desktop-v1.1.21` and `android-v1.1.38` for GitHub Actions.

**Next Steps**:
- Push main branch and release tags (`git push origin main --tags`) to trigger GitHub Actions release builds.
