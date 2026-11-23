/*
 * photobooth4u — ESP32 Offline Cash Acceptor (Coin + Bill Acceptor over Bluetooth / USB)
 *
 * Reads pulse outputs from standard 12V Coin Acceptors (CH-926 / JY-923 / Allan) and
 * Bill Acceptors (TB74 / ICT / Apex) and sends peso credits to photobooth4u:
 *     c<pesos>\n       e.g.  c5\n  (PHP 5 coin)   c100\n  (PHP 100 bill)
 *
 * Works completely OFFLINE on Android Offline App, Windows/Mac Desktop App, iPad,
 * and Chrome/Edge browsers.
 *
 * --------------------------------------------------------------------------
 * CHOOSE ONE BLUETOOTH MODE BELOW (USB Serial at 115200 baud is ALWAYS on):
 *   1 = BLE HID Keyboard (DEFAULT — works EVERYWHERE: Android Offline App,
 *       Windows/Mac Desktop App, iPad, Chrome, Safari).
 *       Install ZIP library: https://github.com/T-vK/ESP32-BLE-Keyboard
 *       Arduino IDE note: if ESP32 board core v3.x gives a std::string/String
 *       compile error, either install "esp32 by Espressif" v2.0.17 in Boards
 *       Manager, OR install NimBLE-Arduino and uncomment #define USE_NIMBLE
 *       inside BleKeyboard.h.
 *   2 = BLE Nordic UART Service (Chrome / Edge Web Bluetooth only, does NOT
 *       hide Android's on-screen keyboard, uses built-in ESP32 BLE library —
 *       ZERO extra libraries, compiles cleanly on ESP32 core 2.x & 3.x).
 *   0 = USB Serial only (plug ESP32 directly into Windows/Mac via USB cable).
 * --------------------------------------------------------------------------
 */
#define BT_MODE 1

// ---- Pin assignments (ESP32 DevKit / WROOM-32) ----
// SAFETY: Coin/Bill acceptor SIGNAL lines are often open-collector (active LOW)
// or 5V/12V! NEVER feed >3.3V straight into an ESP32 GPIO.
//   - Open-collector (NPN / NO to GND, most CH-926 & TB74 set to NO): connect directly
//     to GPIO with INPUT_PULLUP + share Common GND.
//   - 5V / 12V active output: use a PC817 optocoupler or voltage divider (e.g. 10k/4.7k for 5V).
#define COIN_PIN            27      // Coin acceptor pulse wire
#define BILL_PIN            26      // Bill acceptor pulse wire
#define TEST_BTN_PIN        0       // Built-in BOOT button on ESP32 (press to send c10)
#define LED_PIN             2       // Built-in blue LED (flashes on each credit)

// ---- Calibration (adjust to match your acceptor's DIP switches / programming) ----
#define COIN_PESOS_PER_PULSE   1    // e.g. 1 = 1 pulse per PHP 1 (5 pulses = PHP 5, 10 pulses = PHP 10)
#define BILL_PESOS_PER_PULSE   10   // e.g. 10 = 1 pulse per PHP 10 (2 pulses = PHP 20, 10 pulses = PHP 100)

// Pulse timing (milliseconds)
#define PULSE_DEBOUNCE_MS      22   // Ignore electrical bounce shorter than 22 ms
#define COIN_TRAIN_GAP_MS      320  // Wait 320 ms after last coin pulse before reporting
#define BILL_TRAIN_GAP_MS      420  // Wait 420 ms after last bill pulse before reporting

#define DEVICE_NAME "Photobooth4u-Cash"

#if BT_MODE == 1
  #include <BleKeyboard.h>
  BleKeyboard bleKeyboard(DEVICE_NAME, "photobooth4u", 100);
#elif BT_MODE == 2
  #include <BLEDevice.h>
  #include <BLEServer.h>
  #include <BLEUtils.h>
  #include <BLE2902.h>
  // Nordic UART Service (matches protected/src/cash/cash-acceptor.js)
  #define NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
  #define NUS_TX_UUID      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
  BLECharacteristic *pTxChar = nullptr;
  volatile bool bleClientConnected = false;
  volatile bool bleNeedReAdv = false;

  class NusCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer *s) override { bleClientConnected = true; }
    void onDisconnect(BLEServer *s) override {
      bleClientConnected = false;
      bleNeedReAdv = true;
    }
  };
#endif

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

void blinkLed(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(45);
    digitalWrite(LED_PIN, LOW);
    if (i + 1 < times) delay(45);
  }
}

void sendCredit(uint32_t pesos) {
  if (pesos == 0 || pesos > 5000) return;

  char msg[16];
  snprintf(msg, sizeof(msg), "c%lu\n", (unsigned long)pesos);

  // 1. Always send over USB Serial (works with Chrome/Edge Web Serial + Serial Monitor)
  Serial.print(msg);

  // 2. Send over Bluetooth
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
#endif

  blinkLed(2);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  pinMode(COIN_PIN, INPUT_PULLUP);
  pinMode(BILL_PIN, INPUT_PULLUP);
  pinMode(TEST_BTN_PIN, INPUT_PULLUP);

  // FALLING edge for standard active-LOW / open-collector (NO) acceptors.
  // If your acceptor outputs active-HIGH pulses via optocoupler, change to RISING.
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinPulse, FALLING);
  attachInterrupt(digitalPinToInterrupt(BILL_PIN), onBillPulse, FALLING);

#if BT_MODE == 1
  bleKeyboard.begin();
  Serial.println("Photobooth4u Cash Acceptor ready (BLE Keyboard + USB Serial)");
#elif BT_MODE == 2
  BLEDevice::init(DEVICE_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new NusCallbacks());
  BLEService *service = server->createService(NUS_SERVICE_UUID);
  pTxChar = service->createCharacteristic(NUS_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pTxChar->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Photobooth4u Cash Acceptor ready (BLE Nordic UART + USB Serial)");
#else
  Serial.println("Photobooth4u Cash Acceptor ready (USB Serial only)");
#endif

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
  uint32_t now = millis();
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

  if (cCount > 0) sendCredit(cCount * COIN_PESOS_PER_PULSE);
  if (bCount > 0) sendCredit(bCount * BILL_PESOS_PER_PULSE);

  // Hardware test button (BOOT button on ESP32 -> credits PHP 10)
  if (digitalRead(TEST_BTN_PIN) == LOW && (now - testBtnLastMs) > 600) {
    testBtnLastMs = now;
    sendCredit(10);
  }

  delay(10);
}
