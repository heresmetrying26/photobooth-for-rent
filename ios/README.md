# photobooth4u — iOS / iPadOS Native Wrapper

A dedicated iPadOS native wrapper for **photobooth4u** enabling **direct USB DSLR & mirrorless tethering** via Apple's native `ImageCaptureCore` framework, fully offline event operations, and local Wi-Fi QR code sharing.

---

## Architecture Overview

```
booth.html (WKWebView)
  │
  ├─ Calls http://127.0.0.1:17321 (CAM_HELPER)
  │    │
  │    ▼
  │  IccCameraHelper.swift
  │    │
  │    ├─ ImageCaptureCore (ICDeviceBrowser, ICCameraDevice)
  │    ├─ Native PTP Command Engine (requestSendPTPCommand)
  │    ├─ Shutter Trigger (PTP InitiateCapture via requestSendPTPCommand)
  │    └─ Live View JPEG Extractor
  │         │
  │         ▼ USB-C Cable (Data)
  │       Canon EOS / Nikon / Sony Alpha DSLR
  │
  ├─ window.__PBLocal (Offline Event Storage)
  │    │
  │    ▼
  │  PBLocal.swift
  │    ├─ Saves to Documents/Pictures/photobooth4u/<event>/
  │    └─ Saves to iPad Camera Roll (Photos app)
  │
  ├─ LocalShareServer.swift (Port 47777)
  │    │
  │    ▼ Guests scan QR code over local Wi-Fi
  │  http://<ipad-ip>:47777/e/<event>/
  │
  └─ window.__PBVoice (Spoken Countdowns)
       │
       ▼
     VoiceBridge.swift (AVSpeechSynthesizer)
```

---

## Key Capabilities

1. **Direct USB DSLR Tethering (`ImageCaptureCore`)**
   - Connects to Canon, Nikon, and Sony DSLRs/mirrorless cameras via a USB-C cable or Apple USB Camera Adapter.
   - Streams live view viewfinder directly onto the iPad screen.
   - Programmatically triggers the camera shutter and receives high-resolution JPEGs.
   - Bypasses Safari's lack of WebUSB by running a lightweight embedded local server on `127.0.0.1:17321`.

2. **100% Offline Operation**
   - The entire booth engine (`booth.html`) is bundled into the application.
   - Photos, GIFs, and videos are saved locally to the iPad.
   - Requires internet only once to activate the rental licence.

3. **Local Wi-Fi QR Code Downloads**
   - An embedded HTTP server (`LocalShareServer.swift` on port 47777) serves event photo galleries and single-photo downloads.
   - Guests connect their phones to the same Wi-Fi or hotspot and scan the QR code to save their pictures.

4. **Kiosk Lockdown & Screen Keep-Awake**
   - Screen keep-awake is active (`isIdleTimerDisabled = true`) to prevent sleeping during live events.
   - Status bar and home indicator auto-hide for an immersive photo booth experience.
   - Works seamlessly with iPadOS **Guided Access** for physical kiosk lockup.

---

## Hardware Connection Setup

```
[DSLR Camera]
      ↕ (USB Data Cable)
[Powered USB Hub with Power Delivery] ── (Wall Outlet Charger)
      ↕ (USB-C)
[iPad USB-C Port]
```

### Camera Settings:
- **Canon EOS**: Set USB connection to *PC Remote / Computer*.
- **Nikon**: Set USB connection to *MTP / PTP*.
- **Sony Alpha**: Set USB connection to *PC Remote* (in Setup Menu).
- Set exposure dial to **Manual (M)** mode.

---

## Building in Xcode

### Prerequisites:
- macOS running **Xcode 15+**
- Active **Apple Developer Account** (for signing and TestFlight deployment)

### Steps:
1. Open the `ios` directory in Xcode.
2. In **Signing & Capabilities**, select your Apple Developer Team.
3. Run `ios/scripts/copy_booth.sh` to refresh `booth.html` from `protected/booth.html`.
4. Connect your iPad via USB.
5. Select your iPad as the target device and click **Run** (`Cmd + R`).
6. For distribution, select **Product → Archive** and upload to **TestFlight**.

---

## Standalone Target: Roving DSLR Bridge (`RovingDSLRBridge`)

The Xcode project also includes a separate standalone app target **`RovingDSLRBridge`** (`com.photobooth4u.rovingbridge`, source in `ios/roving/`), equivalent to Android's `roving-dslr-bridge-android.apk`:

- **No booth license code / no WebView / no kiosk lock** — installs independently beside `photobooth4u`.
- **Direct USB PTP physical-shutter polling** via shared `IccCameraHelper.swift` (`ROVING_STANDALONE` compilation flag): Canon EOS / R-series (incl. EOS R50), Nikon, Sony Alpha, and passive `ImageCaptureCore` fallback.
- **1-Second QR Pairing & Offline Disk Queue** — scans the laptop Photographer Desk QR code, monitors local Wi-Fi/Ethernet via `NWPathMonitor`, queues full-res JPEGs safely if Wi-Fi drops, and gives haptic confirmation on delivery.
- **Canon EOS R50 Setup:** Set *Menu → Wrench → Choose USB connection app* to **Photo Import/Remote Control** (not *Canon app(s) for iPhone*), turn Wi-Fi/Bluetooth OFF, and connect with a USB-C data cable on iPhone 15/16/17 (or Apple Lightning to USB 3 Camera Adapter + external power on older Lightning iPhones).
- **CI Build:** `.github/workflows/roving-ios.yml` builds `roving-dslr-bridge-ios.ipa` (scheme `RovingDSLRBridge`, tags `roving-ios-v*`).

