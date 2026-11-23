/* ---- Cash acceptor: a coin / bill acceptor read by an ESP32 (works offline) ----
   The ESP32 counts the acceptor's pulses and tells the booth how many pesos went in, one short message per
   coin or bill:   c<pesos> then Enter     e.g.  c5<Enter>  (a P5 coin)   c100<Enter>  (a P100 bill)
   How the message gets here (chosen per device in Setup -> Guest payment -> Cash acceptor):
     keyboard : the ESP32 pretends to be a Bluetooth (BLE HID) or USB keyboard and types the message. Works in
                every build: the Android app, the laptop app, iPad and any browser.
     ble      : Bluetooth LE serial (Nordic UART service). Chrome / Edge only (Web Bluetooth).
     serial   : USB cable, 115200 baud. Chrome / Edge only (Web Serial).
   Credit is kept on this device (it survives a reload) and each session takes the price off it.
   Part file: pasted into the booth script, so top-level names are var / function, never const / let. */
var CASH_BAL_KEY = 'pb_cash_bal', CASH_LINK_KEY = 'pb_cash_link', CASH_STATS_KEY = 'pb_cash_stats';
var CASH_MAX_ONE = 5000;                    // one coin / bill can't be worth more than this (a garbled message is dropped)
var CASH_NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', CASH_NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
var cashLink = { mode: '', state: 'idle', name: '', note: '' };     // state: idle | connecting | ready | lost | unsupported
var cashHooks = { credit: null, status: null };                    // set by the payment code
var cashKeyParser = null, cashKeyBound = false, cashBle = null, cashSerial = null, cashLinkEnabled = false;

// Turns the text the ESP32 sends into credits. feed() takes any chunk (a serial / BLE packet can split a message);
// ch() takes one character (the keyboard path). active() is true while a message is half-received.
function cashParserNew(onCredit) {
  var st = 0, digits = '';
  function reset() { st = 0; digits = ''; }
  function ch(c) {
    if (st === 0) { if (c === 'c' || c === 'C') { st = 1; digits = ''; } return; }
    if (c >= '0' && c <= '9') { if (digits.length < 5) digits += c; else reset(); return; }
    if (c === '\n' || c === '\r' || c === ';') {
      var n = digits ? parseInt(digits, 10) : 0;
      reset();
      if (n >= 1 && n <= CASH_MAX_ONE) onCredit(n);
      return;
    }
    reset();
    if (c === 'c' || c === 'C') { st = 1; digits = ''; }       // a new message started over a broken one
  }
  function feed(text) { text = String(text == null ? '' : text); for (var i = 0; i < text.length; i++) ch(text.charAt(i)); }
  return { ch: ch, feed: feed, reset: reset, active: function () { return st > 0; } };
}

// ---- credit kept on this device ----
function cashBalance() { try { return Math.max(0, Math.floor(Number(localStorage.getItem(CASH_BAL_KEY)) || 0)); } catch (e) { return 0; } }
function cashSetBalance(n) { try { n = Math.max(0, Math.floor(Number(n) || 0)); if (n) localStorage.setItem(CASH_BAL_KEY, String(n)); else localStorage.removeItem(CASH_BAL_KEY); } catch (e) { } }
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
function cashSetLink(state, note, name) {
  cashLink.state = state; cashLink.note = note || ''; if (name != null) cashLink.name = name;
  if (typeof cashHooks.status === 'function') { try { cashHooks.status(cashLink); } catch (e) { } }
}
function cashChosenLink() { var m = ''; try { m = localStorage.getItem(CASH_LINK_KEY) || ''; } catch (e) { } return (m === 'ble' || m === 'serial' || m === 'keyboard') ? m : 'keyboard'; }
function cashSetChosenLink(m) { try { localStorage.setItem(CASH_LINK_KEY, m); } catch (e) { } }
function cashSupports(mode) {
  if (mode === 'keyboard') return true;
  if (mode === 'ble') return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  if (mode === 'serial') return typeof navigator !== 'undefined' && !!navigator.serial;
  return false;
}

// ---- keyboard (Bluetooth HID / USB keyboard): the same messages, typed ----
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
  cashKeyParser = cashParserNew(cashCredit);
  if (!cashKeyBound) { window.addEventListener('keydown', cashKeyHandler, true); cashKeyBound = true; }
  cashSetLink('ready', 'Listening for the ESP32 keyboard', 'Keyboard');
}

// ---- Bluetooth LE serial (Chrome / Edge) ----
function cashBleDrop() {
  try { if (cashBle && cashBle.dev && cashBle.dev.gatt && cashBle.dev.gatt.connected) cashBle.dev.gatt.disconnect(); } catch (e) { }
  if (cashBle && cashBle.dev && cashBle.onGone) { try { cashBle.dev.removeEventListener('gattserverdisconnected', cashBle.onGone); } catch (e) { } }
  cashBle = null;
}
async function cashBleOpen(dev) {
  var parser = cashParserNew(cashCredit), dec = new TextDecoder();
  var srv = await dev.gatt.connect();
  var svc = await srv.getPrimaryService(CASH_NUS);
  var ch = await svc.getCharacteristic(CASH_NUS_TX);
  ch.addEventListener('characteristicvaluechanged', function (ev) { parser.feed(dec.decode(ev.target.value)); });
  await ch.startNotifications();
  cashSetLink('ready', 'Bluetooth connected', dev.name || 'ESP32');
}
// Needs a tap (Chrome asks which device). Later starts reuse the allowed device quietly.
async function cashBleConnect(pick) {
  if (!cashSupports('ble')) { cashSetLink('unsupported', 'Bluetooth LE isn’t available in this browser. Use the keyboard link, or Chrome / Edge.'); return false; }
  cashBleDrop(); cashSetLink('connecting', 'Connecting…');
  try {
    var dev = null;
    if (!pick && navigator.bluetooth.getDevices) {
      var list = await navigator.bluetooth.getDevices();
      dev = (list || []).filter(function (d) { return /photobooth|pb[-_ ]?cash|esp32/i.test(d.name || ''); })[0] || null;
    }
    if (!dev) {
      if (!pick) { cashSetLink('idle', 'Tap “Connect” to pick the ESP32'); return false; }
      dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [CASH_NUS] }, { namePrefix: 'Photobooth' }, { namePrefix: 'PB-Cash' }], optionalServices: [CASH_NUS] });
    }
    var onGone = function () {
      if (!cashBle || cashBle.dev !== dev) return;
      cashSetLink('lost', 'Bluetooth lost. Reconnecting…');
      setTimeout(function () { if (cashLinkEnabled && cashLink.mode === 'ble' && cashBle && cashBle.dev === dev) cashBleOpen(dev).catch(function () { cashSetLink('lost', 'Bluetooth lost. Tap “Connect”.'); }); }, 2500);
    };
    dev.addEventListener('gattserverdisconnected', onGone);
    cashBle = { dev: dev, onGone: onGone };
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
  var me = { port: port, reader: null, stop: false }, parser = cashParserNew(cashCredit), dec = new TextDecoder();
  cashSerial = me;
  cashSetLink('ready', 'USB connected', 'ESP32 (USB)');
  (async function () {
    try {
      while (port.readable && !me.stop) {
        me.reader = port.readable.getReader();
        try {
          for (;;) { var r = await me.reader.read(); if (r.done) break; if (r.value) parser.feed(dec.decode(r.value, { stream: true })); }
        } finally { try { me.reader.releaseLock(); } catch (e) { } }
      }
    } catch (e) { /* unplugged */ }
    if (cashSerial === me) { cashSerial = null; try { await port.close(); } catch (e) { } cashSetLink('lost', 'USB unplugged. Plug it back in, then tap “Connect”.'); }
  })();
}
async function cashSerialConnect(pick) {
  if (!cashSupports('serial')) { cashSetLink('unsupported', 'USB serial isn’t available in this browser. Use the keyboard link, or Chrome / Edge.'); return false; }
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

// ---- start / stop (the payment code calls these) ----
// pick = true when the operator tapped “Connect” (needed for Bluetooth / USB the first time).
async function cashStart(pick) {
  var m = cashChosenLink();
  cashLinkEnabled = true;
  if (cashLink.mode && cashLink.mode !== m) await cashStopLink(true);
  cashLink.mode = m;
  if (!cashSupports(m)) { cashSetLink('unsupported', m === 'ble' ? 'Bluetooth LE isn’t available here. Use the keyboard link, or Chrome / Edge.' : 'USB serial isn’t available here. Use the keyboard link, or Chrome / Edge.'); return false; }
  if (m === 'keyboard') { if (!cashKeyParser) cashKeyStart(); else cashSetLink('ready', 'Listening for the ESP32 keyboard', 'Keyboard'); return true; }
  if (cashLink.state === 'ready' && !pick) return true;
  if (cashLink.state === 'connecting') return false;
  return m === 'ble' ? cashBleConnect(!!pick) : cashSerialConnect(!!pick);
}
async function cashStopLink(keepEnabled) {
  if (!keepEnabled) cashLinkEnabled = false;
  cashBleDrop(); await cashSerialDrop();
  if (cashKeyParser) cashKeyParser.reset();
  cashKeyParser = null;
  cashLink.mode = ''; cashSetLink('idle', '', '');
}
