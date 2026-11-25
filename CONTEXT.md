# Session Context

**Current Task**: Released iPad 1.1.29 (`ios-v1.1.29`, build `39`) combining DJI Osmo Pocket 3 / USB-C webcam support and Epson L8050 Wi-Fi Direct (`192.168.223.1` LPD `:515` + ESC/P-R `360`/`720` dpi + IPP 4x6 borderless bleed).

**Key Decisions**:
- Ported Android's 64-row ESC/P-R strip renderer, RFC 1179 LPD spooling, and `:631`/`:9100`/`:515` + SNMP/HTTP probing to `EscprLpdPrint.swift` and `ViewController.swift` with cellular disabled on TCP sockets.
- Added `_printer._tcp` Bonjour discovery in `Info.plist`, `supportsL8050HiRes()` in native bridge, 1-tap `192.168.223.1` Wi-Fi Direct connect in `booth.src.html`, and iPad `bleedPage` / `600` dpi JFIF support.

**Next Steps**:
- Monitor `.github/workflows/ios.yml` for tag `ios-v1.1.29` to publish `photobooth4u-kiosk-ipad.ipa` on GitHub Releases.
- Physical iPad test against Epson EcoTank L8050 Wi-Fi Direct (`192.168.223.1`) and router Wi-Fi (`360`/`600`/`720` dpi borderless 4x6).
