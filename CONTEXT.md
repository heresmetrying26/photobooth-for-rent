# Session Context

**Current Task**: Release v1.0.77 (Desktop v1.0.80, Android v1.0.91): animated 360 effects now truly move, and the motion settings apply in the render.

**Key Decisions**:
- Root cause of "static" effects: generator reused one frame buffer on a pipe without draining, so loops froze after a few frames. Fixed; all 40 loops (portrait + landscape) regenerated at 540p/30fps, ~27 MB total.
- `spin.mjs` applies Trajectory/Size/Wobble/Location to particle effects (`FX_MOTION`); frame-style effects ignore them.
- `refreshUserFx` + `loops.version` update the data-folder copy of the loops on start (operator loops kept). Bump `loops.version` whenever loops change.

**Next Steps**:
- GitHub Actions packages installers on tag push (v1.0.77, desktop-v1.0.80, android-v1.0.91).
- Check the larger installer size and render time with effects on the real laptop; verify other effects visually.
