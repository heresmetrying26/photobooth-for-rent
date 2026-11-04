# Session Context

**Current Task**: Implemented "Spin & Print" feature allowing physical photo strip / keychain prints directly from 360 videos.

**Key Decisions**:
- Added `extractFrames` in FFmpeg (`spin.mjs`) and HTML5 canvas fallback for extracting hero center or multi-angle sequence frames from 360 clips.
- Added "🖨️ Spin & Print" buttons on 360 Studio Desk and Share Modal, automatically integrating with event frames and layouts.
- Added "and auto-print strip / keychain" option in 360 settings, returning cleanly to 360 desk upon session reset.

**Next Steps**:
- Implement Step 2 in sequence: Universal Bluetooth Remote / Pocket Shutter Clicker triggering.
- Implement Step 3: Beat-drop auto-sync speed ramping.
- Implement Step 4: Live TV Wall audience countdown and celebration replay.
