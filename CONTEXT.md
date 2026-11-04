# Session Context

**Current Task**: Shipped v1.0.67 with 360 live studio preview, custom frame upload, dynamic text positioning, persistent dismissal, and GPU watchdog.

**Key Decisions**:
- Layered HTML canvas preview over video for real-time visual feedback of frames, text, speed, and positioning before rendering.
- Replaced FFmpeg white fades with optical strobe flashes (`drawbox`) to prevent solid white covers in boomerang and speed ramp.
- Capped CPU encode threads with below-normal process priority and implemented 10s GPU watchdog fallback.

**Next Steps**:
- Verify GitHub Actions workflow builds the desktop installers for v1.0.67.
- Test custom uploaded frames and live speed previews on physical station hardware.
- Gather operator feedback on 360 booth workflow performance.
