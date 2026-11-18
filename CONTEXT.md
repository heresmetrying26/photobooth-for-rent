# Session Context

**Current Task**: Released Desktop 1.1.69 (Win/Mac), Android 1.1.81 (`versionCode 183`), and iPad 1.1.4 (`14`) for smoother Canon EOS M50 II live view.

**Key Decisions**:
- Booth page live-view loop (helper path) now prefetches the next frame while the current one is decoded/drawn (one request in flight).
- Android + iPad Canon loops: event poll every 6 s during live view (was 2 s), busy wait 15 ms (was 50 ms), fps logged every 5 s.
- Released without the desktop smoke test, at the user's request.

**Next Steps**:
- Confirm GitHub Actions builds finish green (`desktop-v1.1.69`, `android-v1.1.81`, `ios-v1.1.4`) and Netlify `/api/updates` reports 1.1.69.
- Test Canon M50 II on a real tablet: compare the `Canon live view: N fps` log line before and after.
- Swift and Kotlin changes were never compiled locally; check the CI builds.
