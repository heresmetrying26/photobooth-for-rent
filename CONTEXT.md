# Session Context

**Current Task**: Fix CI release steps for Desktop v1.0.109 and Android v1.1.23.

**Key Decisions**:
- Fixed working-directory in android.yml for Netlify CDN deploy step.
- Updated desktop package-lock.json to match v1.0.109 for Windows CI npm ci.
- Deployed compiled v1.1.23 APK directly into public/downloads/ for Netlify CDN.

**Next Steps**:
- Push fixes to main and update release tags.
- Verify GitHub Actions workflow completions.
