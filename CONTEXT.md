# Session Context

**Current Task**: Release Desktop v1.0.110 and Android v1.1.24 with roving DSLR bridge.

**Key Decisions**:
- Fixed Kotlin duplicate variable declarations in UsbCameraHelper.kt (nikonCapture and canonCapture).
- Decoupled photo upload in RovingBridgeActivity with a background executor and added clipboard paste.
- Cleaned and hardened CI workflow: deduplicated steps, added resilient npm fallbacks, ad-hoc Mac DMG signing.

**Next Steps**:
- Verify roving DSLR OTG bridge with physical cameras (Canon, Nikon, Sony).
- Confirm Photographer Desk on-demand print workflow at the event base station.
