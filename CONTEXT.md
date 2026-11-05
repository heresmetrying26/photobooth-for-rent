# Session Context

**Current Task**: Release v1.0.80 (Desktop v1.0.83, Android v1.0.94): Android print queue, per-printer settings (colour, layout, quality), printer per paper size, optional voucher-to-printer link, per-printer desktop quality, RP30 / Rongta / ArcticBreeze thermal printers.

**Key Decisions**:
- Android prints go into a queue per printer (`enqueuePrint`); the Print button is free right away. Printer profiles are keyed by printer name (Wi-Fi/USB name, Bluetooth name), so they survive a USB re-plug (`wifiRelink` re-points a saved USB printer by name).
- "Link vouchers to printers" is optional (`printPrefs.voucherPrinter`, off by default). The printer is stored by name on each payment option (`payCfg.options[i].printer`) and found through the voucher's label; a device without that printer prints by paper size.
- Print Helper `/print` takes `quality` (best / normal / draft). Windows: PrintTicket PageOutputQuality; Mac AirPrint: print-quality. Best stays the default.
- Thermal printers are recognised by name (RP/RPP, Rongta, ArcticBreeze, HPRT, Gprinter, iDPRT) and an exact "USB Printer Port" USB name; any other unknown USB printer can be tried as thermal by tapping it with a Receipt paper size chosen.
- Edit files with LF endings (.gitattributes eol=lf); read+write scripts on Windows can turn them into CRLF and break `test-360-ui-ux.mjs`.

**Next Steps**:
- Test the RP30A-UB (80 mm, USB + Bluetooth) on a tablet; if it still shows "no driver", get its USB vid:pid from the debug toast and add it.
- Android Kotlin changes were not compiled locally (no SDK): check the GitHub Actions Android build.
- Standalone Print Helper (tools/print-helper) has the quality change but was not re-released (still 1.1.11); `public/downloads/pb4u-windows-camera-test/*` shows as deleted in the working tree (not from this release).
