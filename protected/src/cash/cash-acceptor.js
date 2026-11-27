/* ---- ESP32 Link: Two-way Cash Acceptor + Relay Module + NeoPixel controller (works offline) ----
   1. ESP32 -> Booth (credits): reads coin/bill pulses and sends short messages:
        c<pesos>\n     e.g.  c5\n  (P5 coin)   c100\n  (P100 bill)
   2. Booth -> ESP32 (two-way status commands, newline-terminated):
        session_idle, template_selection, price{50}, credit{5}, cash_open, cash_close,
        payment_success, session_start, countdown_3, countdown_2, countdown_1,
        shutter_flash, start_print, print_done, session_end, session_cancel
   How the ESP32 connects (chosen per device in Setup -> Guest payment / Light & sound):
     ble      : Bluetooth Serial — BLE Nordic UART / Classic BT SPP on Android Tablet App (window.__Esp32Bridge),
                or BLE Nordic UART (Web Bluetooth) on Chrome / Edge. Two-way!
     serial   : USB cable, 115200 baud (Web Serial, Chrome / Edge). Two-way!
     keyboard : BLE HID / USB keyboard typing c<pesos><Enter>. One-way (credits only; cannot receive relay commands).
   Credit is kept on this device (survives reload) and each session takes the price off it.
   Part file: pasted into the booth script, so top-level names are var / function, never const / let. */
var CASH_BAL_KEY = 'pb_cash_bal', CASH_ACT_KEY = 'pb_cash_act', CASH_LINK_KEY = 'pb_cash_link', CASH_STATS_KEY = 'pb_cash_stats';
var CASH_MAX_ONE = 5000;                    // one coin / bill can't be worth more than this (a garbled message is dropped)
var CASH_NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
var CASH_NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // App -> ESP32 (write)
var CASH_NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // ESP32 -> App (notify)
var cashLink = { mode: '', state: 'idle', name: '', note: '' };     // state: idle | connecting | ready | lost | unsupported
var cashHooks = { credit: null, status: null };                    // set by the payment / setup code
var cashKeyParser = null, cashKeyBound = false, cashBle = null, cashSerial = null, cashLinkEnabled = false;
var cashSerialParser = null, cashNativeRetryTimer = null, cashNativeRetryMs = 3000;
var cashStatusTimer = null, cashNativeBridgeRef = null, cashNativeAvailCache = false;
var cashLastCmd = '', cashLastCmdAt = 0, cashLastRx = '';
var cashStateHook = null;

function cashNotifyStatusSoon() {
  if (typeof cashHooks.status !== 'function') return;
  if (cashStatusTimer) return;
  cashStatusTimer = setTimeout(function () {
    cashStatusTimer = null;
    if (typeof cashHooks.status === 'function') { try { cashHooks.status(cashLink); } catch (e) { } }
  }, 80);
}

// Turns the text the ESP32 sends into credits.
// opts: { strictLine: boolean, onLine: function(str) }
// - strictLine = true (BLE / USB Serial): only c<digits> at the start of a line triggers credit (prevents words like "ok:cash_close50" from false-triggering).
// - strictLine = false (Keyboard HID): allows c<digits><Enter> even after a hotkey was pressed on the page.
function cashParserNew(onCredit, opts) {
  var strict = !!(opts && opts.strictLine);
  var onLine = (opts && typeof opts.onLine === 'function') ? opts.onLine : null;
  var st = 0, digits = '', lineBuf = '', atStart = true;
  function reset() { st = 0; digits = ''; lineBuf = ''; atStart = true; }
  function ch(c) {
    if (c === '\n' || c === '\r' || c === ';') {
      if (st === 1 && digits.length > 0) {
        var n = parseInt(digits, 10);
        reset();
        if (n >= 1 && n <= CASH_MAX_ONE) onCredit(n);
      } else {
        var ln = lineBuf;
        reset();
        if (ln && onLine) { try { onLine(ln); } catch (e) { } }
      }
      return;
    }
    if (strict) {
      if (atStart) {
        if (c === ' ' || c === '\t') return;
        atStart = false;
        if (c === 'c' || c === 'C') { st = 1; digits = ''; lineBuf = c; }
        else { st = 2; digits = ''; lineBuf = c; }
        return;
      }
      if (st === 1) {
        if (c >= '0' && c <= '9' && digits.length < 5) { digits += c; lineBuf += c; }
        else { st = 2; digits = ''; if (lineBuf.length < 160) lineBuf += c; }
        return;
      }
      if (lineBuf.length < 160) lineBuf += c;
      return;
    }
    // Non-strict keyboard HID mode: look for 'c' followed immediately by 1..5 digits and Enter.
    if (st === 0) { if (c === 'c' || c === 'C') { st = 1; digits = ''; } return; }
    if (c >= '0' && c <= '9') { if (digits.length < 5) digits += c; else st = 0; return; }
    st = 0; digits = '';
    if (c === 'c' || c === 'C') { st = 1; digits = ''; }
  }
  function feed(text) { text = String(text == null ? '' : text); for (var i = 0; i < text.length; i++) ch(text.charAt(i)); }
  return { ch: ch, feed: feed, reset: reset, active: function () { return st === 1; } };
}

function cashFeedText(text, source, customParser) {
  if (!cashSerialParser) {
    cashSerialParser = cashParserNew(cashCredit, {
      strictLine: true,
      onLine: function (ln) {
        cashLastRx = ln;
        cashNotifyStatusSoon();
      }
    });
  }
  (customParser || cashSerialParser).feed(text);
}

// ---- credit kept on this device ----
function cashBalance() { try { return Math.max(0, Math.floor(Number(localStorage.getItem(CASH_BAL_KEY)) || 0)); } catch (e) { return 0; } }
function cashTouchActivity(ts) {
  try {
    if (cashBalance() > 0) localStorage.setItem(CASH_ACT_KEY, String(ts || Date.now()));
    else localStorage.removeItem(CASH_ACT_KEY);
  } catch (e) { }
}
function cashLastActivityAt() {
  try {
    if (!(cashBalance() > 0)) return 0;
    var t = Math.floor(Number(localStorage.getItem(CASH_ACT_KEY)) || 0);
    if (!(t > 0)) { t = Date.now(); localStorage.setItem(CASH_ACT_KEY, String(t)); }
    return t;
  } catch (e) { return 0; }
}
function cashSetBalance(n) {
  try {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n) {
      localStorage.setItem(CASH_BAL_KEY, String(n));
      localStorage.setItem(CASH_ACT_KEY, String(Date.now()));
    } else {
      localStorage.removeItem(CASH_BAL_KEY);
      localStorage.removeItem(CASH_ACT_KEY);
    }
  } catch (e) { }
}
// What this booth has taken in cash: money in, money used for sessions, number of sessions. For the operator's count at the end of the day.
function cashStats() {
  var s = null;
  try { s = JSON.parse(localStorage.getItem(CASH_STATS_KEY) || 'null'); } catch (e) { }
  s = s && typeof s === 'object' ? s : {};
  return { since: Number(s.since) || 0, inTotal: Math.max(0, Math.floor(Number(s.inTotal) || 0)), sold: Math.max(0, Math.floor(Number(s.sold) || 0)), sessions: Math.max(0, Math.floor(Number(s.sessions) || 0)) };
}
function cashSaveStats(s) { try { localStorage.setItem(CASH_STATS_KEY, JSON.stringify(s)); } catch (e) { } }
function cashStatsReset() { cashSaveStats({ since: Date.now(), inTotal: 0, sold: 0, sessions: 0 }); }
function cashNote(kind, n) {
  var s = cashStats(); if (!s.since) s.since = Date.now();
  if (kind === 'in') s.inTotal += n; else { s.sold += n; s.sessions += 1; }
  cashSaveStats(s);
}
// One coin / bill arrived.
function cashCredit(n) {
  n = Math.floor(Number(n) || 0);
  if (!(n >= 1 && n <= CASH_MAX_ONE)) return 0;
  if (typeof payCashOn === 'function' && !payCashOn()) return 0;   // Lighting-only mode (free event): ignore stray coin pulses
  cashSetBalance(cashBalance() + n); cashNote('in', n);
  if (typeof cashHooks.credit === 'function') { try { cashHooks.credit(n); } catch (e) { } }
  return n;
}
// Takes `price` off the credit for one session. Returns false (and takes nothing) when there isn't enough.
function cashSpend(price) {
  price = Math.floor(Number(price) || 0);
  if (!(price > 0) || cashBalance() < price) return false;
  cashSetBalance(cashBalance() - price); cashNote('sold', price);
  return true;
}

// ---- link status ----
function cashHasNativeBridge() {
  if (typeof window === 'undefined' || !window.__Esp32Bridge || typeof window.__Esp32Bridge.isAvailable !== 'function') {
    cashNativeBridgeRef = null;
    cashNativeAvailCache = false;
    return false;
  }
  if (cashNativeBridgeRef !== window.__Esp32Bridge) {
    cashNativeBridgeRef = window.__Esp32Bridge;
    try { cashNativeAvailCache = !!window.__Esp32Bridge.isAvailable(); } catch (e) { cashNativeAvailCache = false; }
  }
  return cashNativeAvailCache;
}
function cashSetLink(state, note, name) {
  cashLink.state = state; cashLink.note = note || ''; if (name != null) cashLink.name = name;
  if (typeof cashHooks.status === 'function') { try { cashHooks.status(cashLink); } catch (e) { } }
}
function cashChosenLink() {
  var m = '';
  try { m = localStorage.getItem(CASH_LINK_KEY) || ''; } catch (e) { }
  if (m === 'ble' || m === 'serial' || m === 'keyboard') return m;
  return cashHasNativeBridge() ? 'ble' : 'keyboard';
}
function cashSetChosenLink(m) { try { localStorage.setItem(CASH_LINK_KEY, m); } catch (e) { } }
function cashSupports(mode) {
  if (mode === 'keyboard') return true;
  if (mode === 'ble') return cashHasNativeBridge() || (typeof navigator !== 'undefined' && !!navigator.bluetooth);
  if (mode === 'serial') return typeof navigator !== 'undefined' && !!navigator.serial;
  return false;
}
function cashConnected() {
  if (cashHasNativeBridge()) {
    try { if (window.__Esp32Bridge.isConnected()) return true; } catch (e) { }
  }
  if (cashBle && cashBle.dev && cashBle.dev.gatt && cashBle.dev.gatt.connected) return true;
  if (cashSerial && cashSerial.port && cashSerial.port.writable && !cashSerial.stop) return true;
  return false;
}
function cashLinkLabel() {
  if (!cashConnected() && cashLink.state !== 'ready') return cashLink.note || 'Not connected';
  var base = (cashLink.name ? cashLink.name + ' · ' : '') + (cashLink.note || 'Connected');
  if (cashLastCmd) base += ' · last sent: ' + cashLastCmd;
  return base;
}

// ---- App -> ESP32 command writer (two-way serial over Android Bridge, Web Bluetooth RX, or USB Web Serial) ----
function cashSend(cmd) {
  var line = String(cmd == null ? '' : cmd).trim().replace(/[\r\n]+/g, ' ');
  if (!line) return false;
  cashLastCmd = line;
  cashLastCmdAt = Date.now();
  var sent = false;

  // 1. Android Tablet Native Bridge (BLE Nordic UART + Classic BT SPP)
  if (cashHasNativeBridge()) {
    try {
      if (window.__Esp32Bridge.isConnected()) {
        sent = !!window.__Esp32Bridge.write(line + '\n');
      }
    } catch (e) { }
  }

  // 2. Web Bluetooth BLE Nordic UART RX characteristic (Chrome / Edge)
  if (!sent && cashBle && cashBle.rxChar && cashBle.dev && cashBle.dev.gatt && cashBle.dev.gatt.connected) {
    try {
      var bytes = new TextEncoder().encode(line + '\n');
      var ch = cashBle.rxChar;
      var dev = cashBle.dev;
      var useNoRsp = !!(ch.properties && ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === 'function');
      cashBle.writeChain = (cashBle.writeChain || Promise.resolve()).then(function () {
        if (!dev.gatt || !dev.gatt.connected) return;
        return useNoRsp ? ch.writeValueWithoutResponse(bytes) : ch.writeValue(bytes);
      }).catch(function () { /* keep write chain alive */ });
      sent = true;
    } catch (e) { }
  }

  // 3. Web Serial (USB cable, Chrome / Edge)
  if (!sent && cashSerial && cashSerial.port && cashSerial.port.writable && !cashSerial.stop) {
    try {
      var port = cashSerial.port;
      var sObj = cashSerial;
      var sBytes = new TextEncoder().encode(line + '\n');
      sObj.writeChain = (sObj.writeChain || Promise.resolve()).then(async function () {
        if (!port.writable || sObj.stop) return;
        var w = port.writable.getWriter();
        try { await w.write(sBytes); } finally { try { w.releaseLock(); } catch (e) { } }
      }).catch(function () { });
      sent = true;
    } catch (e) { }
  }

  cashNotifyStatusSoon();
  return sent;
}
if (typeof window !== 'undefined') window.esp32Send = cashSend;

function cashSendCurrentState() {
  setTimeout(function () {
    if (!cashConnected()) return;
    var cmds = ['session_idle'];
    if (typeof cashStateHook === 'function') {
      try {
        var c = cashStateHook();
        if (Array.isArray(c) && c.length) cmds = c;
        else if (c) cmds = [c];
      } catch (e) { }
    }
    for (var i = 0; i < cmds.length; i++) {
      if (cmds[i]) cashSend(cmds[i]);
    }
  }, 150);
}

// ---- keyboard (Bluetooth HID / USB keyboard): c<pesos><Enter> (one-way) ----
function cashKeyHandler(e) {
  if (!cashLinkEnabled || cashLink.mode !== 'keyboard' || !cashKeyParser) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  var t = e.target, tag = t && t.tagName ? String(t.tagName).toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;   // someone typing in Setup
  var k = e.key, was = cashKeyParser.active();
  if (k === 'Enter') k = '\n'; else if (!k || k.length !== 1) return;
  cashKeyParser.ch(k);
  // Swallow the rest of a message (the digits and the Enter) so Enter can't also start a session or press a button.
  if (was || cashKeyParser.active()) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
}
function cashKeyStart() {
  cashKeyParser = cashParserNew(cashCredit, { strictLine: false });
  if (!cashKeyBound) { window.addEventListener('keydown', cashKeyHandler, true); cashKeyBound = true; }
  cashSetLink('ready', 'Listening for ESP32 keyboard (credits only; use BLE/USB serial for relays)', 'Keyboard');
}

function cashScheduleNativeRetry() {
  if (!cashLinkEnabled || cashLink.mode !== 'ble' || !cashHasNativeBridge() || cashNativeRetryTimer) return;
  var waitMs = cashNativeRetryMs;
  cashNativeRetryMs = Math.min(15000, Math.round(cashNativeRetryMs * 1.6));
  cashNativeRetryTimer = setTimeout(function () {
    cashNativeRetryTimer = null;
    if (cashLinkEnabled && cashLink.mode === 'ble' && cashHasNativeBridge() && !cashConnected()) {
      try { window.__Esp32Bridge.connectSaved(); } catch (e) { }
    }
  }, waitMs);
}

// ---- Android native Bluetooth Bridge events (window.__Esp32Bridge -> window.__Esp32Event) ----
if (typeof window !== 'undefined') {
  window.__Esp32Event = function (raw) {
    var ev = null;
    try { ev = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return; }
    if (!ev || !ev.type) return;
    if (ev.type === 'connected') {
      if (cashNativeRetryTimer) { clearTimeout(cashNativeRetryTimer); cashNativeRetryTimer = null; }
      cashNativeRetryMs = 3000;
      cashBle = { dev: null, onGone: null, rxChar: null, writeChain: Promise.resolve(), native: true, mode: ev.mode || 'ble', address: ev.address || '', name: ev.name || 'ESP32', twoWay: ev.twoWay !== false };
      var tag = ev.mode === 'spp' ? 'Classic BT connected' : 'Bluetooth connected';
      if (ev.twoWay !== false) tag += ' (two-way)';
      cashSetLink('ready', tag, ev.name || 'ESP32');
      cashSendCurrentState();
    } else if (ev.type === 'disconnected') {
      cashBle = null;
      if (!cashLinkEnabled || cashLink.mode !== 'ble') {
        cashSetLink('idle', '', '');
        return;
      }
      cashSetLink('lost', ev.reason || 'Bluetooth disconnected. Reconnecting…', '');
      cashScheduleNativeRetry();
    } else if (ev.type === 'line') {
      if (ev.line != null) cashFeedText(String(ev.line) + '\n', 'ble');
    } else if (ev.type === 'error') {
      var msg = String(ev.error || 'Bluetooth error');
      var isSilent = !!ev.silent;
      if (!cashConnected()) {
        if (isSilent && cashLinkEnabled && cashLink.mode === 'ble') {
          cashSetLink('lost', 'ESP32 offline — retrying automatically…', '');
          cashScheduleNativeRetry();
        } else {
          cashSetLink('idle', msg === 'Cancelled.' ? 'Tap “Connect” to pick the ESP32' : msg, '');
        }
      }
      if (!isSilent && typeof showToast === 'function' && msg && msg !== 'Cancelled.') {
        try { showToast(msg, 4500); } catch (e) { }
      }
    }
  };
}

// ---- Bluetooth serial (Android __Esp32Bridge BLE/SPP + Chrome / Edge Web Bluetooth BLE NUS) ----
function cashBleDrop() {
  if (cashNativeRetryTimer) { clearTimeout(cashNativeRetryTimer); cashNativeRetryTimer = null; }
  if (cashHasNativeBridge() && ((cashBle && cashBle.native) || (typeof window.__Esp32Bridge.isConnected === 'function' && window.__Esp32Bridge.isConnected()))) {
    try { window.__Esp32Bridge.disconnect(); } catch (e) { }
  }
  try { if (cashBle && cashBle.dev && cashBle.dev.gatt && cashBle.dev.gatt.connected) cashBle.dev.gatt.disconnect(); } catch (e) { }
  if (cashBle && cashBle.dev && cashBle.onGone) { try { cashBle.dev.removeEventListener('gattserverdisconnected', cashBle.onGone); } catch (e) { } }
  cashBle = null;
}
async function cashBleOpen(dev) {
  var parser = cashParserNew(cashCredit, { strictLine: true, onLine: function (ln) { cashLastRx = ln; } }), dec = new TextDecoder();
  var srv = await dev.gatt.connect();
  var svc = await srv.getPrimaryService(CASH_NUS);
  var ch = await svc.getCharacteristic(CASH_NUS_TX);
  var rx = null;
  try { rx = await svc.getCharacteristic(CASH_NUS_RX); } catch (e) { rx = null; }
  if (cashBle && cashBle.dev === dev) cashBle.rxChar = rx;
  ch.addEventListener('characteristicvaluechanged', function (ev) { cashFeedText(dec.decode(ev.target.value), 'ble', parser); });
  await ch.startNotifications();
  cashSetLink('ready', 'Bluetooth connected' + (rx ? ' (two-way)' : ' (read-only)'), dev.name || 'ESP32');
  cashSendCurrentState();
}
// Needs a tap the first time (Android native picker or Chrome device chooser). Later starts reuse the saved device quietly.
async function cashBleConnect(pick) {
  if (!cashSupports('ble')) { cashSetLink('unsupported', 'Bluetooth serial isn’t available in this browser. Use Keyboard, or Chrome / Edge / Android App.'); return false; }
  if (cashHasNativeBridge()) {
    try {
      if (!pick && window.__Esp32Bridge.isConnected()) {
        if (!cashBle || !cashBle.native) {
          var sv0 = {};
          try { sv0 = JSON.parse(window.__Esp32Bridge.savedDevice() || '{}') || {}; } catch (e) { }
          cashBle = { dev: null, onGone: null, rxChar: null, writeChain: Promise.resolve(), native: true, mode: sv0.mode || 'ble', address: sv0.address || '', name: sv0.name || 'ESP32', twoWay: true };
          cashSetLink('ready', (sv0.mode === 'spp' ? 'Classic BT connected' : 'Bluetooth connected') + ' (two-way)', sv0.name || 'ESP32');
        }
        return true;
      }
    } catch (e) { }
    if (!pick) {
      var saved = '';
      try { saved = window.__Esp32Bridge.savedDevice() || ''; } catch (e) { }
      if (!saved) { cashSetLink('idle', 'Tap “Connect” to pick the ESP32'); return false; }
      cashSetLink('connecting', 'Connecting to saved ESP32…');
      var started = false;
      try { started = !!window.__Esp32Bridge.connectSaved(); } catch (e) { started = false; }
      if (!started) { cashSetLink('idle', 'Tap “Connect” to pick the ESP32'); return false; }
      return true;
    }
    cashSetLink('connecting', 'Searching for ESP32 controllers…');
    try { window.__Esp32Bridge.pick(); return true; }
    catch (e) { cashSetLink('idle', 'Couldn’t open Bluetooth picker.'); return false; }
  }
  cashBleDrop(); cashSetLink('connecting', 'Connecting…');
  try {
    var dev = null;
    if (!pick && navigator.bluetooth.getDevices) {
      var list = await navigator.bluetooth.getDevices();
      dev = (list || []).filter(function (d) { return /photobooth|pb[-_ ]?(cash|4u)|esp32|relay|booth/i.test(d.name || ''); })[0] || null;
    }
    if (!dev) {
      if (!pick) { cashSetLink('idle', 'Tap “Connect” to pick the ESP32'); return false; }
      dev = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CASH_NUS] }, { namePrefix: 'Photobooth' }, { namePrefix: 'PB-Cash' }, { namePrefix: 'PB4U' }, { namePrefix: 'ESP32' }],
        optionalServices: [CASH_NUS]
      });
    }
    var onGone = function () {
      if (!cashBle || cashBle.dev !== dev) return;
      cashSetLink('lost', 'Bluetooth lost. Reconnecting…');
      setTimeout(function () { if (cashLinkEnabled && cashLink.mode === 'ble' && cashBle && cashBle.dev === dev) cashBleOpen(dev).catch(function () { cashSetLink('lost', 'Bluetooth lost. Tap “Connect”.'); }); }, 2500);
    };
    dev.addEventListener('gattserverdisconnected', onGone);
    cashBle = { dev: dev, onGone: onGone, rxChar: null, writeChain: Promise.resolve(), native: false };
    await cashBleOpen(dev);
    return true;
  } catch (e) {
    cashBleDrop();
    cashSetLink('idle', (e && e.name === 'NotFoundError') ? 'No device picked' : 'Couldn’t connect: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
}

// ---- USB serial (Chrome / Edge) ----
async function cashSerialDrop() {
  var s = cashSerial; cashSerial = null;
  if (!s) return;
  s.stop = true;
  try { if (s.reader) await s.reader.cancel(); } catch (e) { }
  try { await s.port.close(); } catch (e) { }
}
async function cashSerialOpen(port) {
  await port.open({ baudRate: 115200 });
  var me = { port: port, reader: null, stop: false, writeChain: Promise.resolve() };
  var parser = cashParserNew(cashCredit, { strictLine: true, onLine: function (ln) { cashLastRx = ln; } }), dec = new TextDecoder();
  cashSerial = me;
  cashSetLink('ready', 'USB connected (two-way)', 'ESP32 (USB)');
  cashSendCurrentState();
  (async function () {
    try {
      while (port.readable && !me.stop) {
        me.reader = port.readable.getReader();
        try {
          for (;;) { var r = await me.reader.read(); if (r.done) break; if (r.value) cashFeedText(dec.decode(r.value, { stream: true }), 'serial', parser); }
        } finally { try { me.reader.releaseLock(); } catch (e) { } }
      }
    } catch (e) { /* unplugged */ }
    if (cashSerial === me) { cashSerial = null; try { await port.close(); } catch (e) { } cashSetLink('lost', 'USB unplugged. Plug it back in, then tap “Connect”.'); }
  })();
}
async function cashSerialConnect(pick) {
  if (!cashSupports('serial')) { cashSetLink('unsupported', 'USB serial isn’t available in this browser. Use Bluetooth or Keyboard, or Chrome / Edge.'); return false; }
  await cashSerialDrop(); cashSetLink('connecting', 'Connecting…');
  try {
    var port = null;
    if (!pick) { var known = await navigator.serial.getPorts(); port = (known && known[0]) || null; }
    if (!port) {
      if (!pick) { cashSetLink('idle', 'Tap “Connect” to pick the ESP32'); return false; }
      port = await navigator.serial.requestPort();
    }
    await cashSerialOpen(port);
    return true;
  } catch (e) {
    cashSerial = null;
    cashSetLink('idle', (e && e.name === 'NotFoundError') ? 'No device picked' : 'Couldn’t connect: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
}

// ---- start / stop (the payment / lighting code calls these) ----
// pick = true when the operator tapped “Connect” (needed for Bluetooth / USB the first time).
async function cashStart(pick) {
  var m = cashChosenLink();
  cashLinkEnabled = true;
  if (cashLink.mode && cashLink.mode !== m) await cashStopLink(true);
  cashLink.mode = m;
  if (!cashSupports(m)) { cashSetLink('unsupported', m === 'ble' ? 'Bluetooth serial isn’t available here. Use Keyboard, or Chrome / Edge / Android App.' : 'USB serial isn’t available here. Use Bluetooth or Keyboard, or Chrome / Edge.'); return false; }
  if (m === 'keyboard') { if (!cashKeyParser) cashKeyStart(); else cashSetLink('ready', 'Listening for ESP32 keyboard (credits only; use BLE/USB serial for relays)', 'Keyboard'); return true; }
  if (cashLink.state === 'ready' && !pick) return true;
  if (cashLink.state === 'connecting' && !pick) return false;
  return m === 'ble' ? cashBleConnect(!!pick) : cashSerialConnect(!!pick);
}
async function cashStopLink(keepEnabled) {
  if (!keepEnabled) cashLinkEnabled = false;
  cashBleDrop(); await cashSerialDrop();
  if (cashKeyParser) cashKeyParser.reset();
  cashKeyParser = null;
  cashLink.mode = ''; cashSetLink('idle', '', '');
}
