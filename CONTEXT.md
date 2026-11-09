# Session Context

**Current Task**: Separate 360 Video Desk into optional ₱1,500 add-on and exclude from base Lifetime packages.

**Key Decisions**:
- Lifetime Offline (₱3,999) & Online+Offline (₱4,999) now exclude 360 booth by default (`spin360: false`).
- Added `addon_spin360` (₱1,500 one-time) in `plans.mjs` and updated pricing/marketing/agreement pages.
- Bundled and synchronized `protected/booth.html` to mobile assets and Netlify libraries.

**Next Steps**:
- Push commits to `origin/main` to deploy to Netlify and build desktop/Android releases.
