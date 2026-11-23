/*
 * photobooth4u — ESP32 Two-Way Controller (Cash Acceptor + Relay Module + NeoPixel LEDs)
 *
 * Works completely OFFLINE over Bluetooth Serial & USB Serial on:
 *   - Android Offline App (PB4uAndroid via native Bluetooth Bridge: BLE UART or Classic BT)
 *   - Windows / Mac / Linux Chrome & Edge (Web Bluetooth BLE UART or USB Web Serial)
 *
 * TWO-WAY SERIAL PROTOCOL (115200 baud / Bluetooth Serial, newline-terminated):
 *   1. ESP32 -> photobooth4u (Coin / Bill credits):
 *        c<pesos>\n          e.g. c5\n (P5 coin)   c100\n (P100 bill)
 *
 *   2. photobooth4u -> ESP32 (Live status commands):
 *        session_idle        Idle/welcome screen (idle NeoPixel effect; cash & studio light off)
 *        template_selection  Guest picking a template/layout (selection NeoPixel effect)
 *        price{50}           Session price in pesos (records targetPesos = 50)
 *        cash_open           App ready for cash (enables coin/bill acceptors + Relay Ch 1 ON)
 *        cash_close          Stops accepting cash (disables acceptors + Relay Ch 1 OFF)
 *        payment_success     Payment confirmed (payment-success NeoPixel; Relay Ch 1 OFF)
 *        session_start       Photo session starts (session-start LEDs; Studio Light Relay Ch 2 ON)
 *        countdown_3         3 seconds before shot
 *        countdown_2         2 seconds before shot
 *        countdown_1         1 second before shot
 *        shutter_flash       Photo captured (white flash burst LEDs + Flash Relay Ch 3 pulse)
 *        start_print         Printing started (printing NeoPixel wave + Aux/Print Relay Ch 4 ON)
 *        print_done          Printing finished (completion NeoPixel + Aux/Print Relay Ch 4 OFF)
 *        session_end         Session finished (Studio Light Relay Ch 2 OFF; return to idle effect)
 *        session_cancel      Cancelled/failed (acceptors disabled; all session relays OFF -> idle)
 *      Bonus manual test commands: ch1_on .. ch8_on, ch1_off .. ch8_off, all_off, ping
 *
 * --------------------------------------------------------------------------
 * CHOOSE BLUETOOTH MODE BELOW (USB Serial at 115200 baud is ALWAYS active):
 *   2 = BLE Nordic UART Service (DEFAULT — two-way, works on Android Tablet App + Chrome/Edge,
 *       uses built-in ESP32 BLE library, zero extra BT libraries, compiles on core 2.x & 3.x)
 *   3 = Classic Bluetooth SPP (two-way serial via BluetoothSerial — Android Tablet App;
 *       pair ESP32 in Android Bluetooth settings, then tap Connect in photobooth4u)
 *   1 = BLE HID Keyboard (LEGACY one-way credits only — cannot receive relay/LED commands)
 *   0 = USB Serial only (two-way via USB cable on Chrome / Edge)
 * --------------------------------------------------------------------------
 */
#define BT_MODE 2

// ---- NeoPixel (WS2812B LED ring / strip) ----
// Set USE_NEOPIXEL to 1 and install "Adafruit NeoPixel" in Arduino Library Manager,
// or set to 0 if using only a Relay Module without NeoPixels.
#define USE_NEOPIXEL       1
#define NEOPIXEL_PIN       13
#define NEOPIXEL_COUNT     16
#define NEOPIXEL_BRIGHT    160   // 0..255

// ---- Relay Module configuration (supports 1, 2, 4, or 8 channels directly!) ----
// Standard 5V/3.3V opto-isolated relay boards trigger on LOW (active-LOW = true).
// Change RELAY_ACTIVE_LOW to false if your relay/MOSFET module triggers on HIGH.
#define NUM_RELAYS         4     // Change up to 8 if using an 8-channel relay board
#define RELAY_ACTIVE_LOW   true
#define FLASH_PULSE_MS     250   // How long Relay Ch 3 pulses on shutter_flash

// Safe boot-glitch-free ESP32 DevKit (WROOM-32) output GPIOs for relays 1..8
// (If using an ESP32-WROVER board with PSRAM, change pins 16 & 17 to 32 & 33):
#define RELAY_CASH_PIN     16    // Ch 1: Coin & Bill Acceptor Enable / Power Relay
#define RELAY_LIGHT_PIN    17    // Ch 2: Studio / Ring Light Relay
#define RELAY_FLASH_PIN    18    // Ch 3: Strobe / Camera Flash Relay (250 ms pulse)
#define RELAY_AUX_PIN      19    // Ch 4: Print Indicator / Booth Sign / Aux Relay
#define RELAY_CH5_PIN      21    // Ch 5 (optional 8-ch)
#define RELAY_CH6_PIN      22    // Ch 6 (optional 8-ch)
#define RELAY_CH7_PIN      23    // Ch 7 (optional 8-ch)
#define RELAY_CH8_PIN      25    // Ch 8 (optional 8-ch)

const uint8_t RELAY_PINS[8] = {
  RELAY_CASH_PIN, RELAY_LIGHT_PIN, RELAY_FLASH_PIN, RELAY_AUX_PIN,
  RELAY_CH5_PIN,  RELAY_CH6_PIN,   RELAY_CH7_PIN,   RELAY_CH8_PIN
};

// ---- Cash Acceptor Pins & Calibration ----
// SAFETY: Coin/Bill acceptor signal lines must never exceed 3.3V on ESP32 GPIO.
//   - Open-collector (NO to GND): connect directly to GPIO with INPUT_PULLUP + common GND.
//   - Active 5V/12V output: isolate through a PC817 optocoupler or voltage divider.
#define COIN_PIN              27     // Coin acceptor pulse wire
#define BILL_PIN              26     // Bill acceptor pulse wire
#define TEST_BTN_PIN          0      // Built-in BOOT button on ESP32 (press to test c10)
#define LED_PIN               2      // Built-in blue LED

#define COIN_PESOS_PER_PULSE  1      // 1 pulse = PHP 1 (5 pulses = P5, 10 pulses = P10)
#define BILL_PESOS_PER_PULSE  10     // 1 pulse = PHP 10 (2 pulses = P20, 10 pulses = P100)
#define PULSE_DEBOUNCE_MS     22
#define COIN_TRAIN_GAP_MS     320
#define BILL_TRAIN_GAP_MS     420

// 1 = ignore coin/bill pulses unless cash_open was received from the app (matches idle=disabled).
// 0 = report coin/bill pulses even while idle (for welcome-screen pre-pay without inhibit relay).
#define REQUIRE_CASH_OPEN     1

#define DEVICE_NAME "Photobooth4u-Cash"

#if USE_NEOPIXEL == 1
  #include <Adafruit_NeoPixel.h>
  Adafruit_NeoPixel strip(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
#endif

// ---- Booth LED / Controller State ----
enum BoothState {
  ST_IDLE = 0,
  ST_TEMPLATE_SELECT,
  ST_CASH_OPEN,
  ST_PAYMENT_OK,
  ST_SESSION_START,
  ST_CD_3,
  ST_CD_2,
  ST_CD_1,
  ST_FLASH,
  ST_PRINTING,
  ST_PRINT_DONE,
  ST_CANCEL
};

BoothState boothState = ST_IDLE;
uint32_t stateEnteredMs = 0;
uint32_t targetPesos = 0;
bool cashAccepting = false;
bool flashRelayActive = false;
uint32_t flashRelayOffAt = 0;
uint32_t lastLedUpdateMs = 0;
uint16_t animStep = 0;

String usbRxLine = "";

// ---- Bluetooth Transport ----
#if BT_MODE == 1
  #include <BleKeyboard.h>
  BleKeyboard bleKeyboard(DEVICE_NAME, "photobooth4u", 100);
#elif BT_MODE == 2
  #include <BLEDevice.h>
  #include <BLEServer.h>
  #include <BLEUtils.h>
  #include <BLE2902.h>
  #define NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
  #define NUS_RX_UUID      "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
  #define NUS_TX_UUID      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
  BLECharacteristic *pTxChar = nullptr;
  volatile bool bleClientConnected = false;
  volatile bool bleNeedReAdv = false;

  // ISR/callback-safe RX queue for incoming BLE write chunks
  portMUX_TYPE bleRxMux = portMUX_INITIALIZER_UNLOCKED;
  volatile char bleRxQueue[512];
  volatile uint16_t bleRxHead = 0;
  volatile uint16_t bleRxTail = 0;

  class NusServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer *s) override { bleClientConnected = true; }
    void onDisconnect(BLEServer *s) override {
      bleClientConnected = false;
      bleNeedReAdv = true;
    }
  };

  class NusRxCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *ch) override {
      const uint8_t *data = ch->getData();
      size_t len = ch->getLength();
      if (!data || len == 0) return;
      portENTER_CRITICAL(&bleRxMux);
      for (size_t i = 0; i < len; i++) {
        uint16_t next = (bleRxHead + 1) % sizeof(bleRxQueue);
        if (next != bleRxTail) {
          bleRxQueue[bleRxHead] = (char)data[i];
          bleRxHead = next;
        }
      }
      portEXIT_CRITICAL(&bleRxMux);
    }
  };
#elif BT_MODE == 3
  #include <BluetoothSerial.h>
  BluetoothSerial SerialBT;
  String btSppRxLine = "";
#endif

// ---- Pulse Interrupts ----
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t coinPulses = 0;
volatile uint32_t coinLastMs = 0;
volatile uint32_t billPulses = 0;
volatile uint32_t billLastMs = 0;
uint32_t testBtnLastMs = 0;

void IRAM_ATTR onCoinPulse() {
  uint32_t now = millis();
  portENTER_CRITICAL_ISR(&mux);
  if (now - coinLastMs >= PULSE_DEBOUNCE_MS) {
    coinPulses++;
    coinLastMs = now;
  }
  portEXIT_CRITICAL_ISR(&mux);
}

void IRAM_ATTR onBillPulse() {
  uint32_t now = millis();
  portENTER_CRITICAL_ISR(&mux);
  if (now - billLastMs >= PULSE_DEBOUNCE_MS) {
    billPulses++;
    billLastMs = now;
  }
  portEXIT_CRITICAL_ISR(&mux);
}

// ---- Relay Helpers ----
void setRelay(uint8_t idx, bool on) {
  if (idx >= NUM_RELAYS || idx >= 8) return;
  uint8_t level = RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW);
  digitalWrite(RELAY_PINS[idx], level);
}

void allRelaysOff() {
  for (uint8_t i = 0; i < NUM_RELAYS && i < 8; i++) {
    setRelay(i, false);
  }
  flashRelayActive = false;
}

void triggerFlashRelay() {
  if (NUM_RELAYS < 3) return;
  setRelay(2, true); // Ch 3: RELAY_FLASH_PIN
  flashRelayActive = true;
  flashRelayOffAt = millis() + FLASH_PULSE_MS;
}

// ---- Serial / Bluetooth Writers ----
void sendLineToHost(const char *msg) {
  Serial.print(msg);
#if BT_MODE == 2
  if (bleClientConnected && pTxChar != nullptr) {
    pTxChar->setValue((uint8_t *)msg, strlen(msg));
    pTxChar->notify();
  }
#elif BT_MODE == 3
  if (SerialBT.hasClient()) {
    SerialBT.print(msg);
  }
#endif
}

void blinkLed(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(35);
    digitalWrite(LED_PIN, LOW);
    if (i + 1 < times) delay(35);
  }
}

void sendCredit(uint32_t pesos, bool bypassCashOpen) {
  if (pesos == 0 || pesos > 5000) return;
#if REQUIRE_CASH_OPEN == 1
  if (!bypassCashOpen && !cashAccepting) return;
#endif

  char msg[16];
  snprintf(msg, sizeof(msg), "c%lu\n", (unsigned long)pesos);
  Serial.print(msg);

#if BT_MODE == 1
  if (bleKeyboard.isConnected()) {
    char num[12];
    snprintf(num, sizeof(num), "c%lu", (unsigned long)pesos);
    bleKeyboard.print(num);
    delay(15);
    bleKeyboard.write(KEY_RETURN);
  }
#elif BT_MODE == 2
  if (bleClientConnected && pTxChar != nullptr) {
    pTxChar->setValue((uint8_t *)msg, strlen(msg));
    pTxChar->notify();
  }
#elif BT_MODE == 3
  if (SerialBT.hasClient()) {
    SerialBT.print(msg);
  }
#endif

  blinkLed(2);
}

// ---- NeoPixel Animations (Non-blocking) ----
#if USE_NEOPIXEL == 1
uint32_t wheelColor(byte pos) {
  pos = 255 - pos;
  if (pos < 85) return strip.Color(255 - pos * 3, 0, pos * 3);
  if (pos < 170) { pos -= 85; return strip.Color(0, pos * 3, 255 - pos * 3); }
  pos -= 170;
  return strip.Color(pos * 3, 255 - pos * 3, 0);
}

void fillColor(uint32_t c) {
  for (uint16_t i = 0; i < strip.numPixels(); i++) strip.setPixelColor(i, c);
  strip.show();
}

void setCountdownRing(uint8_t sec, uint8_t r, uint8_t g, uint8_t b) {
  uint16_t n = strip.numPixels();
  uint16_t lit = (sec == 3) ? n : (sec == 2) ? max((uint16_t)1, (uint16_t)((n * 2) / 3)) : max((uint16_t)1, (uint16_t)(n / 3));
  strip.clear();
  for (uint16_t i = 0; i < lit; i++) strip.setPixelColor(i, strip.Color(r, g, b));
  strip.show();
}

void updateNeoPixel(uint32_t now) {
  if (now - lastLedUpdateMs < 35) return;
  lastLedUpdateMs = now;
  animStep++;

  // Timed transitions back to default states
  uint32_t elapsed = now - stateEnteredMs;
  if (boothState == ST_FLASH && elapsed >= FLASH_PULSE_MS) {
    boothState = ST_SESSION_START;
  } else if ((boothState == ST_CANCEL || boothState == ST_PRINT_DONE) && elapsed >= 1800) {
    boothState = ST_IDLE;
  }

  switch (boothState) {
    case ST_IDLE: {
      for (uint16_t i = 0; i < strip.numPixels(); i++) {
        strip.setPixelColor(i, wheelColor(((i * 256 / strip.numPixels()) + animStep * 2) & 255));
      }
      strip.show();
      break;
    }
    case ST_TEMPLATE_SELECT: {
      strip.clear();
      uint16_t head = animStep % strip.numPixels();
      for (uint16_t k = 0; k < 4; k++) {
        strip.setPixelColor((head + k) % strip.numPixels(), strip.Color(0, 190, 255));
      }
      strip.show();
      break;
    }
    case ST_CASH_OPEN: {
      uint8_t br = 80 + (uint8_t)(85.0 * (0.5 + 0.5 * sin(animStep * 0.25)));
      fillColor(strip.Color(br, (uint8_t)(br * 0.8), 0));
      break;
    }
    case ST_PAYMENT_OK: {
      fillColor(strip.Color(0, 255, 90));
      break;
    }
    case ST_SESSION_START: {
      // Bright neutral-warm studio fill light
      fillColor(strip.Color(255, 240, 220));
      break;
    }
    case ST_CD_3: setCountdownRing(3, 255, 45, 45); break;
    case ST_CD_2: setCountdownRing(2, 255, 175, 0); break;
    case ST_CD_1: setCountdownRing(1, 0, 255, 80); break;
    case ST_FLASH: {
      fillColor(strip.Color(255, 255, 255));
      break;
    }
    case ST_PRINTING: {
      strip.clear();
      uint16_t head = animStep % strip.numPixels();
      for (uint16_t i = 0; i < strip.numPixels(); i++) {
        uint16_t d = (i + strip.numPixels() - head) % strip.numPixels();
        strip.setPixelColor(i, d < 5 ? strip.Color(60, 130, 255) : strip.Color(15, 0, 45));
      }
      strip.show();
      break;
    }
    case ST_PRINT_DONE: {
      fillColor((animStep % 6 < 3) ? strip.Color(0, 255, 100) : strip.Color(40, 255, 180));
      break;
    }
    case ST_CANCEL: {
      fillColor((animStep % 6 < 3) ? strip.Color(255, 20, 20) : strip.Color(40, 0, 0));
      break;
    }
  }
}
#endif

// ---- Incoming Command Handler ----
void setBoothState(BoothState st) {
  boothState = st;
  stateEnteredMs = millis();
  animStep = 0;
}

void handleAppCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "session_idle") {
    cashAccepting = false;
    setRelay(0, false); // Ch 1 Cash Acceptor OFF
    setRelay(1, false); // Ch 2 Studio Light OFF
    setRelay(2, false);
    setBoothState(ST_IDLE);
  } else if (cmd == "template_selection") {
    setBoothState(ST_TEMPLATE_SELECT);
  } else if (cmd.startsWith("price{") && cmd.endsWith("}")) {
    String numStr = cmd.substring(6, cmd.length() - 1);
    targetPesos = (uint32_t)numStr.toInt();
  } else if (cmd == "cash_open") {
    cashAccepting = true;
    setRelay(0, true);  // Ch 1 Cash Acceptor ON
    setBoothState(ST_CASH_OPEN);
  } else if (cmd == "cash_close") {
    cashAccepting = false;
    setRelay(0, false); // Ch 1 Cash Acceptor OFF
  } else if (cmd == "payment_success") {
    cashAccepting = false;
    setRelay(0, false); // Ch 1 Cash Acceptor OFF
    setBoothState(ST_PAYMENT_OK);
  } else if (cmd == "session_start") {
    setRelay(1, true);  // Ch 2 Studio Light ON
    setBoothState(ST_SESSION_START);
  } else if (cmd == "countdown_3") {
    setBoothState(ST_CD_3);
  } else if (cmd == "countdown_2") {
    setBoothState(ST_CD_2);
  } else if (cmd == "countdown_1") {
    setBoothState(ST_CD_1);
  } else if (cmd == "shutter_flash") {
    triggerFlashRelay(); // Ch 3 Strobe/Flash Relay pulse
    setBoothState(ST_FLASH);
  } else if (cmd == "start_print") {
    setRelay(3, true);  // Ch 4 Aux / Printing Light Relay ON
    setBoothState(ST_PRINTING);
  } else if (cmd == "print_done") {
    setRelay(3, false); // Ch 4 Aux / Printing Light Relay OFF
    setBoothState(ST_PRINT_DONE);
  } else if (cmd == "session_end") {
    cashAccepting = false;
    setRelay(0, false); // Cash Acceptor OFF
    setRelay(1, false); // Studio Light OFF
    setBoothState(ST_IDLE);
  } else if (cmd == "session_cancel") {
    cashAccepting = false;
    allRelaysOff();
    setBoothState(ST_CANCEL);
  } else if (cmd == "all_off") {
    cashAccepting = false;
    allRelaysOff();
    setBoothState(ST_IDLE);
  } else if (cmd == "ping") {
    sendLineToHost("pong\n");
    return;
  } else if (cmd.startsWith("ch") && cmd.length() >= 6) {
    // Manual test helpers: ch1_on .. ch8_on, ch1_off .. ch8_off
    int ch = cmd.charAt(2) - '1';
    if (ch >= 0 && ch < NUM_RELAYS) {
      if (cmd.endsWith("_on")) setRelay((uint8_t)ch, true);
      else if (cmd.endsWith("_off")) setRelay((uint8_t)ch, false);
    }
  } else {
    return;
  }

  // Acknowledge back to app (safe because it does not start with 'c' + digits)
  String ack = "ok:" + cmd + "\n";
  sendLineToHost(ack.c_str());
  digitalWrite(LED_PIN, HIGH);
  delay(10);
  digitalWrite(LED_PIN, LOW);
}

void feedRxChar(String &buf, char ch) {
  if (ch == '\n' || ch == '\r' || ch == ';') {
    if (buf.length() > 0) {
      String cmd = buf;
      buf = "";
      handleAppCommand(cmd);
    }
  } else if (buf.length() < 96) {
    buf += ch;
  }
}

void pollIncomingCommands() {
  while (Serial.available() > 0) {
    feedRxChar(usbRxLine, (char)Serial.read());
  }
#if BT_MODE == 2
  static String bleRxLine = "";
  for (;;) {
    char ch = 0;
    bool hasChar = false;
    portENTER_CRITICAL(&bleRxMux);
    if (bleRxTail != bleRxHead) {
      ch = bleRxQueue[bleRxTail];
      bleRxTail = (bleRxTail + 1) % sizeof(bleRxQueue);
      hasChar = true;
    }
    portEXIT_CRITICAL(&bleRxMux);
    if (!hasChar) break;
    feedRxChar(bleRxLine, ch);
  }
#elif BT_MODE == 3
  while (SerialBT.available() > 0) {
    feedRxChar(btSppRxLine, (char)SerialBT.read());
  }
#endif
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  for (uint8_t i = 0; i < NUM_RELAYS && i < 8; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    setRelay(i, false);
  }

  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(BILL_PIN, INPUT_PULLUP);
  pinMode(TEST_BTN_PIN, INPUT_PULLUP);

  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);
  attachInterrupt(digitalPinToInterrupt(BILL_PIN), onBillPulse, FALLING);

#if USE_NEOPIXEL == 1
  strip.begin();
  strip.setBrightness(NEOPIXEL_BRIGHT);
  strip.show();
#endif

#if BT_MODE == 1
  bleKeyboard.begin();
  Serial.println("Photobooth4u ESP32 ready (BLE Keyboard one-way + USB Serial two-way)");
#elif BT_MODE == 2
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new NusServerCallbacks());
  BLEService *service = server->createService(NUS_SERVICE_UUID);
  pTxChar = service->createCharacteristic(NUS_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pTxChar->addDescriptor(new BLE2902());
  BLECharacteristic *pRxChar = service->createCharacteristic(
    NUS_RX_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  pRxChar->setCallbacks(new NusRxCallbacks());
  service->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Photobooth4u ESP32 ready (BLE Nordic UART two-way + USB Serial)");
#elif BT_MODE == 3
  SerialBT.begin(DEVICE_NAME);
  Serial.println("Photobooth4u ESP32 ready (Classic Bluetooth SPP two-way + USB Serial)");
#else
  Serial.println("Photobooth4u ESP32 ready (USB Serial two-way)");
#endif

  setBoothState(ST_IDLE);
  blinkLed(3);
}

void loop() {
#if BT_MODE == 2
  if (bleNeedReAdv) {
    bleNeedReAdv = false;
    delay(150);
    BLEDevice::startAdvertising();
  }
#endif

  pollIncomingCommands();

  uint32_t now = millis();

  // Turn off momentary Flash/Strobe Relay pulse when done
  if (flashRelayActive && (int32_t)(now - flashRelayOffAt) >= 0) {
    setRelay(2, false);
    flashRelayActive = false;
  }

  // Count completed coin/bill pulse trains
  uint32_t cCount = 0;
  uint32_t bCount = 0;
  portENTER_CRITICAL(&mux);
  if (coinPulses > 0 && (now - coinLastMs) >= COIN_TRAIN_GAP_MS) {
    cCount = coinPulses;
    coinPulses = 0;
  }
  if (billPulses > 0 && (now - billLastMs) >= BILL_TRAIN_GAP_MS) {
    bCount = billPulses;
    billPulses = 0;
  }
  portEXIT_CRITICAL(&mux);

  if (cCount > 0) sendCredit(cCount * COIN_PESOS_PER_PULSE, false);
  if (bCount > 0) sendCredit(bCount * BILL_PESOS_PER_PULSE, false);

  // Hardware test button (BOOT button on ESP32 -> credits PHP 10)
  if (digitalRead(TEST_BTN_PIN) == LOW && (now - testBtnLastMs) > 600) {
    testBtnLastMs = now;
    sendCredit(10, true);
  }

#if USE_NEOPIXEL == 1
  updateNeoPixel(now);
#endif

  delay(8);
}
