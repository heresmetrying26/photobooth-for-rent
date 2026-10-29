# photobooth4u — Android Native Tablet Kiosk Wrapper

A dedicated Android native wrapper for **photobooth4u** designed for tablets (Samsung Galaxy Tab, Lenovo Tab, Pixel Tablet, etc.) deployed at live events.

---

## Key Features

1. **Direct Bluetooth Thermal Printing (`window.__BTBridge`)**
   - Connects directly to **80 mm and 58 mm Bluetooth thermal receipt printers** (Xprinter XP-80C / T80U, Epson TM-T82X / TM-m30III, Star, Munbyn, RPP, etc.) over **Classic Bluetooth RFCOMM SPP**.
   - Bypasses Android WebView's lack of Web Bluetooth by injecting a native Java/Kotlin bridge (`window.__BTBridge`).
   - Seamlessly auto-connects to paired thermal printers or presents a quick native device picker.
   - Slices ESC/POS raster bit-images into 256-line bands to prevent buffer overflow on low-memory receipt printers.

2. **Kiosk & Event Mode**
   - **Screen Keep-Awake**: Prevents the tablet screen from timing out, dimming, or sleeping during event operations (`FLAG_KEEP_SCREEN_ON`).
   - **Immersive Full-Screen**: Automatically hides system navigation bars and status bars with sticky transient swipe behavior.
   - **Back Button Protection**: Intercepts accidental back button presses with a confirmation dialog so guests cannot exit the photo booth.
   - **Camera Auto-Grant**: WebChromeClient automatically grants camera/microphone permissions without repeated browser pop-ups.

3. **Activation (`AppLicence.kt`)**
   - The app is free to install, but the bundled booth stays behind an **"Activate this tablet"** screen until it's unlocked with a rental code that has the **offline app add-on** — the same signed-licence system the Windows/Mac app uses, and it shares that code's device-slot limit with the desktop app.
   - Needs Wi-Fi once to activate; after that it keeps working offline until the licence's own check-in is due (same cadence as desktop: roughly every 10 weeks, with a month's grace).
   - If a code is removed or disabled in Admin, the tablet loses access the next time it's online.
   - This tablet's ID (for Admin/support) is shown on the activation screen.

4. **Fully Offline Photos, QR Codes and GIFs (`window.__PBLocal`)**
   - The app needs **no internet** during an event. The booth page is bundled inside the app, and every photo and GIF is saved **on the tablet**.
   - Photos are kept in the app's storage under `Pictures/photobooth4u/<event name>/` (a copy also goes to the tablet's shared **Pictures → photobooth4u** folder on Android 10+, so you can copy them off with a USB cable or the Files app).
   - The app runs a small read-only web server (`LocalShareServer.kt`, ports 47777, 47778, 47779, 47787, 47797). The QR on the result screen opens the guest's photo or GIF from the tablet, with a Save button, and an "All photos" page for the event. This is the same address format as the Windows/Mac app (`http://<tablet>:47777/e/<event>/`).
   - **Guests' phones must be on the same Wi-Fi (or hotspot) as the tablet**; the link is plain `http`, to the tablet's address on that network. Put the Wi-Fi name and password in Setup → Share to show a "join the Wi-Fi" QR before the photo QR.
   - Nothing is uploaded anywhere. Photos stay on the tablet until you delete them.

5. **Operator URL Configuration**
   - Long-press anywhere on the screen to open the **Booth Configuration dialog**.
   - Quickly switch between your live domain, a trial URL, or a local network testing URL (`http://192.168.x.x:8888/`).

---

## Building & Installing

### Requirements
- **Android Studio** Hedgehog (2023.1.1) or newer
- **Android SDK** API 34 (Android 14)
- **Minimum Android version**: Android 7.0 (API 24)

### Steps
1. Open the `android` folder in **Android Studio**:
   ```
   File → Open → Select 'photobooth-for-rent-main/android'
   ```
2. Wait for Gradle to sync dependencies.
3. Connect your Android tablet via USB with **USB Debugging** enabled.
4. Click **Run** (`Shift + F10`) or build the APK:
   ```
   Build → Build Bundle(s) / APK(s) → Build APK(s)
   ```
5. The generated APK will be located at:
   `android/app/build/outputs/apk/debug/app-debug.apk`

---

## Setting Up Bluetooth Thermal Printers

### Step 1: Pair the Printer in Android Settings
1. Turn on your thermal printer (e.g. Xprinter XP-80C or Epson TM-T82X).
2. On your Android tablet, open **Settings → Connected devices → Bluetooth**.
3. Tap **Pair new device**.
4. Select your printer from the list (often named `XP-80C`, `Printer001`, `TM-T82X`, `POS-80`, etc.).
5. When prompted for PIN, enter `0000` or `1234` (standard thermal printer PINs).
6. Verify the printer appears under **Paired devices**.

### Step 2: Print in the Booth
1. Open the **photobooth4u** app on the tablet.
2. In the booth setup or Print settings, select **Receipt 80 mm** (or **Receipt 58 mm**).
3. Under the printer section, enable **Bluetooth thermal receipt printer**.
4. Tap **Connect Bluetooth Printer**. The app will automatically connect to your paired printer (or display a quick device selection dialog).
5. Tap **Test print** to verify that the printer feeds, prints the test header, and cuts.
6. Now, every photo session print will be sent straight to the thermal printer!

---

## Architecture Overview

```
booth.html (WebView)
  │
  ├─ window._btThermal.printViaBluetooth(canvas, '80mm')
  │    │
  │    ├─ toReceiptCanvas(canvas) [Floyd-Steinberg dithering]
  │    ├─ EscPosEncoder.image() [Sliced ESC/POS raster bit-image GS v 0]
  │    └─ uint8ToBase64()
  │
  ▼ (calls window.__BTBridge.write(b64))
BTBridge.kt (@JavascriptInterface)
  │
  ├─ Base64.decode()
  └─ outputStream.write(bytes)
       │
       ▼ (RFCOMM BluetoothSocket / SPP)
Thermal Receipt Printer (Xprinter XP-80C / Epson TM-T82X)
```
