# Session Context

**Current Task**: Release v1.0.75 (Desktop v1.0.78, Android v1.0.89): sticker packages, decorate timer, resize/rotate handles, guest Preview, and the 360 live-preview collapse fix.

**Key Decisions**:
- Six sticker packages (Usual, Birthday, Christmas, Debut, Party, Christening); operator ticks which guests can use, saved as `stickerPacks`.
- Decorate time is `guestStickerSec` (0 = no timer, guest taps Done); default stays 35 s.
- Selection box with corner + rotate handles (`drawDecorBox`/`hitDecorHandle`), measured in screen pixels; box never prints.
- 360 preview card no longer shrinks the video stage (flex-shrink fix); sidebar QR codes use compact styling.

**Next Steps**:
- GitHub Actions packages installers on tag push (v1.0.75, desktop-v1.0.78, android-v1.0.89).
- Test handles and the sticker screen with real touch on the Samsung tablet before the event.
