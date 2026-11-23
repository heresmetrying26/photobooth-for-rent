# ESP32 Offline Cash Acceptor (Coin & Bill Acceptor)

Connect a standard 12V coin acceptor (e.g. CH-926, JY-923, Allan) and/or bill acceptor (e.g. TB74, ICT, Apex) to an ESP32 so guests can pay **offline cash** and trigger photobooth4u automatically.

## Protocol

Every time a coin or bill finishes pulsing, the ESP32 sends a single short text line:

```text
c<pesos>\n
```

Examples:
- `c5\n` → adds ₱5 credit
- `c20\n` → adds ₱20 credit
- `c100\n` → adds ₱100 credit

Valid range per single coin/bill: `1` to `5000`. Line endings accepted: `\n`, `\r`, or `;`.

## Supported Transports

| Mode (`BT_MODE` in `.ino`) | Works on | Pairing / Setup |
| --- | --- | --- |
| `1` — **BLE HID Keyboard** *(default)* | **Android Offline App**, Windows/Mac Desktop App, iPad, Chrome, Safari | Pair `Photobooth4u-Cash` in OS Bluetooth settings. In booth Setup → Guest payment → Cash acceptor → choose **Bluetooth or USB keyboard**. |
| `2` — **BLE Nordic UART (NUS)** | Chrome / Edge (Android, Windows, Mac) | No OS pairing needed; doesn't hide Android's virtual keyboard. Choose **Bluetooth LE serial** and tap **Connect**. |
| `0` / Always on — **USB Serial** (`115200` baud) | Chrome / Edge (Windows, Mac) | Plug ESP32 via USB. Choose **USB cable, serial** and tap **Connect**. |

> **Android tip (BLE Keyboard mode):** After pairing `Photobooth4u-Cash` in Android Bluetooth settings, go to **Settings → System → Languages & input → Physical keyboard → Show on-screen keyboard = ON** so you can still type in Setup while the ESP32 is paired.

## Wiring Safety

1. Power the coin/bill acceptor from its **12V DC supply** (do not power it from the ESP32's 3.3V/5V pin).
2. Connect **12V GND** to **ESP32 GND** (common ground).
3. Set the acceptor switch to **NO (Normally Open / open-collector)** and wire its `COIN` / `PULSE` signal wire to **GPIO 27** (coin) or **GPIO 26** (bill).
   - If your acceptor's signal wire outputs **5V or 12V**, isolate it with a **PC817 optocoupler** (recommended) or a resistor voltage divider so GPIO pins never see more than **3.3V**.
4. Press the ESP32's built-in **BOOT** button (`GPIO 0`) to send a test `c10\n` credit without dropping coins.
