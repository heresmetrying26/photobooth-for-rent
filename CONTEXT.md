# Session Context

**Current Task**: Implement camera battery saver and dslrBooth-style autofocus test shot workflow for DSLRs.

**Key Decisions**:
- Dropped Live View mirror during idle/welcome screen, post-capture review, and idle timeout to cut power draw from ~450mA to ~20mA.
- Added `/camera/af` route and setup Step 4 UI for AF test shot and manual focus (MF) lock on Nikon D5300 and Canon EOS.
- Resolved Nikon contrast AF timing bug by settling lens seek before shutter capture command.

**Next Steps**:
- Verify Nikon D5300 with physical strobe test in active event session.
- Confirm lens remains locked in MF with zero shutter delay during multi-shot guest flow.
- Monitor camera temperature and battery longevity over a 1+ hour session.
