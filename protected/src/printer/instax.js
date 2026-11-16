/*
 * printer/instax.js: Fujifilm INSTAX Link (WIDE) instant-film printers over Bluetooth LE.
 *
 * One paste-in part of booth.src.html (see scripts/assemble-booth.mjs). It exposes window._instax.
 *
 * What it does
 *   - frames the printer's own protocol (header, length, opcode, checksum) and sends a JPEG in chunks
 *   - turns a print page (canvas) into the JPEG the printer wants: its own size, under its own byte limit
 *   - talks to the printer through ONE of two links:
 *       Web Bluetooth     the laptop app (Electron) and Chrome/Edge
 *       window.__InstaxBridge   the Android tablet app (InstaxBridge.kt), because Android's WebView has no Web Bluetooth
 *   - keeps one link per printer, and one job at a time per printer, so two Instax printers can print at the same time
 *
 * The protocol was worked out by others (javl/InstaxBLE, linssenste/instax-link-web, paorin/InstaxLink); this is a
 * re-implementation from the byte layout, not a copy of their code.
 *
 * Tested without a printer (scripts/test-instax.mjs); NOT yet tried on a real INSTAX Link WIDE.
 */
(function (G) {
  'use strict';

  var SVC = '70954782-2d83-473d-9e5f-81e1d02d5273';
  var CH_WRITE = '70954783-2d83-473d-9e5f-81e1d02d5273';
  var CH_NOTIFY = '70954784-2d83-473d-9e5f-81e1d02d5273';
  var OPTIONAL_SERVICES = [SVC, '0000180a-0000-1000-8000-00805f9b34fb', '00001800-0000-1000-8000-00805f9b34fb', '0000e0ff-3c17-d293-8e48-14fe2e4da212'];
  // The printer names itself INSTAX-xxxxxxxx(IOS). Web Bluetooth prefixes are case-sensitive, so the other spellings are listed
  // too, and a printer that advertises the Instax service is found whatever it is called.
  var NAME_FILTERS = [{ namePrefix: 'INSTAX' }, { namePrefix: 'Instax' }, { namePrefix: 'instax' }, { services: [SVC] }];
  var VIRTUAL = 'Instax: ';                  // how a printer is named in the booth's printer lists
  var KNOWN_KEY = 'pb_instax_known';
  var DEFAULT_CHUNK = 900;                   // data bytes per packet (WIDE and mini); SQUARE uses 1808
  var MAX_JPEG = 105 * 1024;                 // the picture is kept under this even when the printer allows more: BLE is slow (about 1 s per KB), so a bigger file only makes the sheet slower and a long upload is more likely to drop
  var BLE_WRITE = 182;                       // bytes per Bluetooth write (a 185-byte ATT payload minus its header)

  // Printer result codes worth a plain sentence.
  var RESULT_TEXT = {
    1: 'The Instax printer is busy.',
    130: 'The Instax printer lost track of the picture. Switch it off and on, then try again.',
    133: 'The Instax printer is stuck. Switch it off and on, then try again.',
    144: 'The Instax printer battery is too low. Charge it.',
    145: 'The Instax printer has no battery.',
    146: 'The Instax printer battery is too hot.',
    176: 'The Instax printer cover is open. Close it.',
    177: 'The Instax printer is out of film. Load a new pack.',
    178: 'The Instax printer is out of film. Load a new pack.',
    179: 'The Instax printer did not accept the picture.',
    180: 'The film is jammed in the Instax printer.',
    181: 'The Instax printer could not print. Check the film.',
    192: 'The Instax printer memory is full. Switch it off and on.',
    194: 'The Instax printer is still printing.'
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Rejects when p takes longer than ms (a Bluetooth connect can hang for a long time).
  function withTimeout(p, ms, msg) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(msg || 'The Instax printer did not answer.')); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ---------------------------------------------------------------- frames
  // Booth to printer: 41 62 | length (2, whole frame, big-endian) | op1 op2 | payload | checksum
  // Printer to booth: 61 42 | length (2)                           | op1 op2 | result | data | checksum
  // checksum = 255 - (sum of every earlier byte & 255)
  function checksumOf(u8, end) {
    var s = 0;
    for (var i = 0; i < end; i++) s = (s + u8[i]) & 255;
    return (255 - s) & 255;
  }
  function buildFrame(op1, op2, payload) {
    var p = payload || [], n = 7 + p.length, f = new Uint8Array(n);
    f[0] = 0x41; f[1] = 0x62; f[2] = (n >> 8) & 255; f[3] = n & 255; f[4] = op1; f[5] = op2;
    for (var i = 0; i < p.length; i++) f[6 + i] = p[i];
    f[n - 1] = checksumOf(f, n - 1);
    return f;
  }
  // One whole inbound frame, or null when it is not one (wrong header, short, bad checksum).
  function parseFrame(u8) {
    if (!u8 || u8.length < 8 || u8[0] !== 0x61 || u8[1] !== 0x42) return null;
    var len = (u8[2] << 8) | u8[3];
    if (len < 8 || len > u8.length) return null;
    if (checksumOf(u8, len - 1) !== u8[len - 1]) return null;
    return { op1: u8[4], op2: u8[5], result: u8[6], data: u8.subarray(7, len - 1), len: len };
  }
  // Notifications normally carry one whole frame each; this also copes with a frame split over two, or two in one.
  function FrameReader() { this.buf = new Uint8Array(0); }
  FrameReader.prototype.push = function (chunk) {
    var out = [], b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf, 0); b.set(chunk, this.buf.length);
    for (; ;) {
      var i = 0;
      while (i + 1 < b.length && !(b[i] === 0x61 && b[i + 1] === 0x42)) i++;      // skip to the next header
      if (i > 0) b = b.subarray(i);
      if (b.length < 4) break;
      var len = (b[2] << 8) | b[3];
      if (len < 8) { b = b.subarray(2); continue; }
      if (b.length < len) break;
      var f = parseFrame(b.subarray(0, len));
      if (f) { out.push(f); b = b.subarray(len); } else b = b.subarray(2);          // damaged: look for the next header
    }
    this.buf = new Uint8Array(b);
    return out;
  };
  function u32at(d, i) { return ((d[i] * 16777216) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3]) >>> 0; }
  function u32bytes(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }

  // 0x00 0x02 with [0]: the picture the printer takes. [width u16][height u16][type][option][max bytes u32]
  function parseImageInfo(d) {
    if (!d || d.length < 11) return null;
    return { width: (d[1] << 8) | d[2], height: (d[3] << 8) | d[4], maxSize: u32at(d, 7) };
  }
  // 0x00 0x02 with [2]: film left, flags, what the printer is doing.
  function parseFunctionInfo(d) {
    if (!d || d.length < 5) return null;
    return { film: d[1] & 15, battery: (d[1] >> 4) & 7, charging: !!(d[1] & 128), coverOpen: !!(d[2] & 1), result: d[3] };
  }
  function resultText(code) { return RESULT_TEXT[code] || ('The Instax printer reported error ' + code + '.'); }

  // ---------------------------------------------------------------- the picture
  function hasWide(info) { return info.width === 1260 && info.height === 840; }
  function chunkFor(info) { return info && info.width === 800 && info.height === 800 ? 1808 : DEFAULT_CHUNK; }

  // The page (a canvas, already colour-adjusted) as a JPEG the printer takes.
  // The page is portrait like every other paper in the booth; the film is landscape, so it is turned back here.
  async function renderJpeg(src, info) {
    var W = info.width || 1260, H = info.height || 840;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    var a = src;
    if ((a.width >= a.height) !== (W >= H)) {               // turn it 90 degrees (the booth turned landscape pages clockwise)
      var r = document.createElement('canvas'); r.width = src.height; r.height = src.width;
      var rg = r.getContext('2d'); rg.translate(0, r.height); rg.rotate(-Math.PI / 2); rg.drawImage(src, 0, 0);
      a = r;
    }
    // The WIDE prints its picture inside a white margin: 12 px left and right, 32 px top and bottom.
    var mx = hasWide(info) ? 12 : 0, my = hasWide(info) ? 32 : 0;
    var rw = W - 2 * mx, rh = H - 2 * my, k = Math.max(rw / a.width, rh / a.height);
    var dw = a.width * k, dh = a.height * k;
    g.save(); g.beginPath(); g.rect(mx, my, rw, rh); g.clip();
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(a, mx + (rw - dw) / 2, my + (rh - dh) / 2, dw, dh);
    g.restore();
    var limit = Math.min(info.maxSize > 0 ? info.maxSize : MAX_JPEG, MAX_JPEG);
    var steps = [0.92, 0.85, 0.78, 0.7, 0.64, 0.58, 0.52, 0.46, 0.4, 0.34, 0.28];
    for (var i = 0; i < steps.length; i++) {
      var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', steps[i]); });
      if (!blob) throw new Error('Could not make the picture for the Instax printer.');
      if (blob.size <= limit || i === steps.length - 1) {
        if (blob.size > limit) throw new Error('The picture is too big for the Instax printer (' + blob.size + ' bytes, it takes ' + limit + ').');
        return new Uint8Array(await blob.arrayBuffer());
      }
    }
    throw new Error('Could not make the picture for the Instax printer.');
  }

  // ---------------------------------------------------------------- the printer (protocol over a transport)
  // A transport has: write(u8) -> Promise, onData = function (u8), onClose = function (), connected, close().
  function Printer(transport) {
    this.t = transport; this.reader = new FrameReader(); this.waiter = null; this.info = null; this.film = null;
    var self = this;
    transport.onData = function (u8) {
      var frames = self.reader.push(u8);
      for (var i = 0; i < frames.length; i++) {
        var w = self.waiter, f = frames[i];
        if (w && w.op1 === f.op1 && w.op2 === f.op2) { self.waiter = null; clearTimeout(w.timer); w.resolve(f); }
      }
    };
    var prevClose = transport.onClose;
    transport.onClose = function () {
      if (self.waiter) { var w = self.waiter; self.waiter = null; clearTimeout(w.timer); w.reject(new Error('The Instax printer disconnected.')); }
      self.info = null;
      if (prevClose) prevClose();
    };
  }
  // Sends one command and waits for its answer. Only one at a time.
  Printer.prototype.request = function (op1, op2, payload, timeoutMs) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.waiter) return reject(new Error('The Instax printer is still answering.'));
      var w = { op1: op1, op2: op2, resolve: resolve, reject: reject };
      w.timer = setTimeout(function () { if (self.waiter === w) { self.waiter = null; reject(new Error('The Instax printer did not answer.')); } }, timeoutMs || 3000);
      self.waiter = w;
      Promise.resolve(self.t.write(buildFrame(op1, op2, payload))).catch(function (e) {
        if (self.waiter === w) { self.waiter = null; clearTimeout(w.timer); reject(e); }
      });
    });
  };
  // A question about the printer (op 0x00): if it does not answer, ask once more before giving up.
  Printer.prototype.ask = async function (op1, op2, payload, timeoutMs) {
    try { return await this.request(op1, op2, payload, timeoutMs); }
    catch (e) {
      if (op1 !== 0 || !/did not answer/i.test((e && e.message) || '') || !this.t.connected) throw e;
      await sleep(300);
      return this.request(op1, op2, payload, timeoutMs);
    }
  };
  Printer.prototype.getInfo = async function () {
    if (this.info) return this.info;
    var f = await this.ask(0x00, 0x02, [0]);
    var inf = f.result === 0 ? parseImageInfo(f.data) : null;
    if (!inf || !inf.width || !inf.height) throw new Error('This does not look like an Instax Link printer (it gave no picture size).');
    inf.chunk = chunkFor(inf);
    return (this.info = inf);
  };
  Printer.prototype.status = async function () {
    var f = await this.ask(0x00, 0x02, [2]);
    var s = f.result === 0 ? parseFunctionInfo(f.data) : null;
    if (s) this.film = s;
    return s;
  };
  // Prints one JPEG (Uint8Array). Resolves when the printer has finished, rejects with a sentence for the operator.
  // this.printSent turns true the moment the print command goes out: from then on the job must never be sent again
  // (a lost answer does not mean the sheet was not made), so a failure after that point carries .uncertain = true.
  Printer.prototype.printJpeg = async function (jpeg, opt) {
    opt = opt || {};
    this.printSent = false;
    var info = await this.getInfo(), n = jpeg.length, chunk = info.chunk;
    // Look first: no point sending a picture to a printer with its cover open or no film.
    var s0 = null;
    try { s0 = await this.status(); } catch (e0) { s0 = null; }
    if (s0) {
      if (s0.coverOpen || s0.result === 1) throw new Error(resultText(176));
      if (s0.result === 2 || s0.film === 0) throw new Error(resultText(177));
    }
    var start = null, stuck = 0;
    for (var tries = 0; tries < 40; tries++) {
      start = await this.request(0x10, 0x00, [2, 0, 0, 0].concat(u32bytes(n)), 5000);
      if (start.result === 1 || start.result === 194) { await sleep(2500); continue; }          // the last sheet is still being made
      if ((start.result === 133 || start.result === 130) && stuck++ < 2) {                        // left over from a broken upload: cancel it, then again
        try { await this.request(0x10, 0x03, [], 2000); } catch (e1) { }
        await sleep(1000);
        continue;
      }
      break;
    }
    if (start.result !== 0) throw new Error(resultText(start.result));
    var fs = start.data && start.data.length >= 4 ? u32at(start.data, 0) : 0;
    if (fs >= 64 && fs <= 2048) chunk = fs;
    var total = Math.ceil(n / chunk);
    try {
      for (var i = 0; i < total; i++) {
        var pl = new Uint8Array(4 + chunk);
        pl.set(u32bytes(i), 0); pl.set(jpeg.subarray(i * chunk, (i + 1) * chunk), 4);          // the last one stays zero-padded
        var r = await this.request(0x10, 0x01, pl, 6000);
        if (r.result !== 0) throw new Error(resultText(r.result));
        if (opt.onProgress) opt.onProgress(i + 1, total);
      }
      var e = await this.request(0x10, 0x02, [], 15000);
      if (e.result !== 0) throw new Error(resultText(e.result));
    } catch (up) {
      // Free the printer, so the next try does not meet a half-finished upload.
      try { if (this.t.connected) await this.request(0x10, 0x03, [], 2000); } catch (e2) { }
      throw up;
    }
    await sleep(opt.prePrintMs == null ? 1000 : opt.prePrintMs);          // the printer wants a moment between the last data and the print command
    this.printSent = true;
    var p;
    try { p = await this.request(0x10, 0x80, [], 15000); }
    catch (pe) {
      var u = new Error('The connection dropped just as the Instax printer was starting. The sheet may still print: check the printer before printing again.');
      u.uncertain = true; throw u;
    }
    if (p.result !== 0) throw new Error(resultText(p.result));
    // The sheet is being made. Ask until the printer says it is done (127 = still working).
    await sleep(opt.firstWaitMs == null ? 1500 : opt.firstWaitMs);
    var until = Date.now() + (opt.maxWaitMs || 150000), fails = 0;
    for (; ;) {
      var st = null;
      try { st = await this.status(); fails = 0; } catch (err) { st = null; fails++; }
      if (st && st.result !== 127) {
        if (st.result === 1) throw new Error(resultText(176));
        if (st.result === 2) throw new Error(resultText(177));
        if (st.result === 240) throw new Error('The Instax printer reported an error. Switch it off and on.');
        return true;
      }
      // The printer took the print command and carries on by itself, even if the link has dropped or it stops answering.
      if (!this.t.connected || fails >= 5) return true;
      if (Date.now() > until) throw new Error('The Instax printer took too long. Check it, then try again.');
      await sleep(opt.pollMs == null ? 1000 : opt.pollMs);
    }
  };

  // ---------------------------------------------------------------- link 1: Web Bluetooth (laptop app, Chrome, Edge)
  function WebTransport(device) { this.device = device; this.wc = null; this.nc = null; this.size = BLE_WRITE; this.delay = 4; this.connected = false; this.onData = null; this.onClose = null; }
  WebTransport.prototype.connect = async function () {
    var self = this, d = this.device;
    if (!this._bound) {
      this._bound = true;
      d.addEventListener('gattserverdisconnected', function () { self.connected = false; if (self.onClose) self.onClose(); });
    }
    var server = await d.gatt.connect();
    var svc = await server.getPrimaryService(SVC);
    var chars = await svc.getCharacteristics(), i;
    this.wc = null; this.nc = null;
    for (i = 0; i < chars.length; i++) { if (chars[i].uuid === CH_WRITE) this.wc = chars[i]; if (chars[i].uuid === CH_NOTIFY) this.nc = chars[i]; }
    if (!this.wc || !this.nc) throw new Error('This Bluetooth device is not an Instax Link printer.');
    await this.nc.startNotifications();
    this.nc.addEventListener('characteristicvaluechanged', function (ev) {
      var v = ev.target.value; if (!v || !self.onData) return;
      self.onData(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    this.connected = true;
  };
  WebTransport.prototype.write = async function (u8) {
    for (var off = 0; off < u8.length;) {
      var part = u8.subarray(off, off + this.size), ok = false, fails = 0;
      while (!ok) {
        if (!this.connected) throw new Error('The Instax printer disconnected.');
        try {
          if (this.wc.writeValueWithoutResponse) await this.wc.writeValueWithoutResponse(part); else await this.wc.writeValue(part);
          ok = true;
        } catch (e) {
          fails++; this.delay = Math.min(200, this.delay * 2);
          if (fails === 4 && this.size > 128) { this.size = 128; part = u8.subarray(off, off + this.size); }
          else if (fails === 8 && this.size > 20) { this.size = 20; part = u8.subarray(off, off + this.size); }
          else if (fails > 12) throw e;
          await sleep(this.delay);
        }
      }
      off += part.length;
      await sleep(this.delay);
      if (this.delay > 4) this.delay = Math.max(4, Math.floor(this.delay * 0.8));
    }
  };
  WebTransport.prototype.close = function () { try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { } this.connected = false; };

  // ---------------------------------------------------------------- link 2: the Android app (InstaxBridge.kt)
  // Events come back through window.__InstaxEvent({ type, address, ... }).
  var bridgeLinks = {}, bridgeWaiters = [];
  function bridge() { return G.__InstaxBridge || null; }
  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
  function unb64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  G.__InstaxEvent = function (ev) {
    if (!ev) return;
    if (ev.type === 'data') { var l = bridgeLinks[ev.address]; if (l && l.onData) l.onData(unb64(ev.b64 || '')); return; }
    if (ev.type === 'closed') { var l2 = bridgeLinks[ev.address]; if (l2) { l2.connected = false; if (l2.onClose) l2.onClose(); } }
    for (var i = bridgeWaiters.length - 1; i >= 0; i--) {                      // an answer someone is waiting for
      var w = bridgeWaiters[i];
      if (w.types.indexOf(ev.type) >= 0 && (!w.address || w.address === ev.address) && (!w.id || w.id === ev.id)) { bridgeWaiters.splice(i, 1); clearTimeout(w.timer); if (ev.type === 'error' || ev.ok === false) w.reject(new Error(ev.error || ev.message || 'Bluetooth error')); else w.resolve(ev); }
    }
  };
  var bridgeSeq = 0;
  function bridgeWait(types, address, ms, id) {
    return new Promise(function (resolve, reject) {
      var w = { types: types.concat(['error']), address: address, id: id || '', resolve: resolve, reject: reject };
      w.timer = setTimeout(function () { var k = bridgeWaiters.indexOf(w); if (k >= 0) bridgeWaiters.splice(k, 1); reject(new Error('The Instax printer did not answer.')); }, ms);
      bridgeWaiters.push(w);
    });
  }
  function BridgeTransport(address) { this.address = address; this.connected = false; this.onData = null; this.onClose = null; bridgeLinks[address] = this; }
  BridgeTransport.prototype.connect = async function () {
    var wait = bridgeWait(['connected'], this.address, 25000);
    var r = JSON.parse(bridge().connect(this.address) || '{}');
    if (!r.ok) { bridgeWaiters.pop(); throw new Error(r.error || 'Could not connect to the Instax printer.'); }
    await wait; this.connected = true;
  };
  BridgeTransport.prototype.write = async function (u8) {
    var b = bridge();
    if (b && typeof b.writeAsync === 'function') {
      var id = 'w' + (++bridgeSeq);
      var wait = bridgeWait(['written'], this.address, 30000, id);
      var ra = JSON.parse(b.writeAsync(this.address, b64(u8), id) || '{}');
      if (!ra.ok) {
        var idx = bridgeWaiters.findIndex(function (x) { return x.id === id; });
        if (idx >= 0) { clearTimeout(bridgeWaiters[idx].timer); bridgeWaiters.splice(idx, 1); }
        throw new Error(ra.error || 'Could not send to the Instax printer.');
      }
      await wait;
      return;
    }
    var r = JSON.parse(b.write(this.address, b64(u8)) || '{}');
    if (!r.ok) throw new Error(r.error || 'Could not send to the Instax printer.');
  };
  BridgeTransport.prototype.close = function () { try { bridge().disconnect(this.address); } catch (e) { } this.connected = false; };

  // ---------------------------------------------------------------- the printers this booth knows
  // links[name] = { name, address, t (transport), p (Printer) }; jobs[name] = the promise that ends when its last print ends
  var links = {}, jobs = {}, active = {}, listeners = [];
  function changed() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (e) { } } }
  function known() { try { var a = JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.name === 'string'; }) : []; } catch (e) { return []; } }
  function remember(name, address) {
    try {
      var k = known().filter(function (x) { return x.name !== name; });
      k.push({ name: name, address: address || '' });
      localStorage.setItem(KNOWN_KEY, JSON.stringify(k.slice(-6)));
    } catch (e) { }
  }
  function forget(vname) {
    try { localStorage.setItem(KNOWN_KEY, JSON.stringify(known().filter(function (x) { return VIRTUAL + x.name !== vname; }))); } catch (e) { }
    var l = links[vname]; if (l) { try { l.t.close(); } catch (e) { } delete links[vname]; }
    changed();
  }
  function isInstaxName(n) { return typeof n === 'string' && n.indexOf(VIRTUAL) === 0; }
  function names() { return known().map(function (x) { return VIRTUAL + x.name; }); }
  function available() {
    var b = bridge();
    if (b) { try { return !!b.isAvailable(); } catch (e) { return false; } }
    return !!(G.navigator && G.navigator.bluetooth);
  }
  function isAndroidApp() { return !!bridge(); }
  function connectedNow(vname) { var l = links[vname]; return !!(l && l.t.connected); }

  function adopt(name, address, t) {
    var v = VIRTUAL + name, l = links[v];
    if (l && l.t !== t) { try { l.t.close(); } catch (e) { } }
    l = { name: v, address: address, t: t, p: new Printer(t) };
    var prev = t.onClose;
    t.onClose = function () { if (prev) prev(); changed(); };
    links[v] = l;
    remember(name, address);
    changed();
    return l;
  }

  // Picks a printer (the operator taps the button: Bluetooth needs a tap) and connects to it. Resolves with the booth's name for it.
  // opts.all: list every Bluetooth device, not only the ones that call themselves INSTAX (for a printer that shows under another name).
  async function pair(opts) {
    var all = !!(opts && opts.all);
    if (bridge()) {
      var wait = bridgeWait(['picked'], '', 90000);
      var b = bridge();
      var r = JSON.parse((all && typeof b.pickAll === 'function' ? b.pickAll() : b.pick()) || '{}');
      if (!r.ok) { bridgeWaiters.pop(); throw new Error(r.error || 'Could not look for Instax printers.'); }
      var ev = await wait;
      var tb = new BridgeTransport(ev.address);
      await tb.connect();
      var lb = adopt(ev.name || 'INSTAX', ev.address, tb);
      await lb.p.getInfo();
      return lb.name;
    }
    if (!G.navigator || !G.navigator.bluetooth) throw new Error('This browser cannot use Bluetooth. Use the photobooth4u app, or Chrome / Edge.');
    var dev = await G.navigator.bluetooth.requestDevice(all ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES } : { filters: NAME_FILTERS, optionalServices: OPTIONAL_SERVICES });
    var tw = new WebTransport(dev);
    await tw.connect();
    var lw = adopt(dev.name || 'INSTAX', dev.id || '', tw);
    await lw.p.getInfo();
    return lw.name;
  }

  // Used by the laptop app only: it runs this "as a tap" (Chromium opens the Bluetooth chooser only for one) and takes the
  // printer with this exact name without asking anyone. See pb4u:bluetoothReconnect in desktop/main.mjs.
  async function autoPair(name) {
    if (!G.navigator || !G.navigator.bluetooth) throw new Error('No Bluetooth here.');
    var dev = await G.navigator.bluetooth.requestDevice({ filters: [{ name: String(name) }], optionalServices: OPTIONAL_SERVICES });
    var t = new WebTransport(dev);
    await t.connect();
    var l = adopt(dev.name || name, dev.id || '', t);
    await l.p.getInfo();
    return l.name;
  }

  async function findDevice(k) {
    var nav = G.navigator;
    if (!nav || !nav.bluetooth || !nav.bluetooth.getDevices) return null;
    var devs = []; try { devs = await nav.bluetooth.getDevices(); } catch (e) { }
    return devs.filter(function (d) { return d.name === k.name || d.id === k.address; })[0] || null;
  }

  // Makes sure the link to a known printer is up, with no tap from the operator:
  //   Android app           links straight to the saved address
  //   Web Bluetooth         re-opens a printer this window already knows, or one the browser remembers (getDevices)
  //   laptop app            asks the app to find it again by name (the app runs the request as a tap)
  var ensuring = {};
  function ensure(vname) {
    if (ensuring[vname]) return ensuring[vname];                     // two callers (a print and the background reconnect) share one attempt
    var pr = ensureOnce(vname);
    ensuring[vname] = pr;
    var done = function () { if (ensuring[vname] === pr) delete ensuring[vname]; };
    pr.then(done, done);
    return pr;
  }
  async function ensureOnce(vname) {
    var l = links[vname];
    if (l && l.t.connected) return l;
    var k = known().filter(function (x) { return VIRTUAL + x.name === vname; })[0];
    var nm = l ? l.name.slice(VIRTUAL.length) : (k ? k.name : '');
    if (!l) {
      if (!k) throw new Error('The Instax printer is not set up. Open Printer settings and tap Connect Instax printer.');
      if (bridge()) l = adopt(k.name, k.address, new BridgeTransport(k.address));
      else { var dv = await findDevice(k); if (dv) l = adopt(k.name, k.address, new WebTransport(dv)); }
    }
    var lastErr = null;
    if (l) {
      // Up to 3 tries, a second apart: a link that is still closing from the last time, or a printer that is slow to wake, often answers the second time.
      for (var at = 0; at < 3; at++) {
        try { await withTimeout(l.t.connect(), 20000, 'The Instax printer took too long to connect.'); l.p.info = null; changed(); return l; }
        catch (e) { lastErr = e; try { l.t.close(); } catch (e3) { } if (at < 2) await sleep(1000 * (at + 1)); }
      }
    }
    if (!bridge() && nm && G.pb4u && typeof G.pb4u.bluetoothReconnect === 'function') {
      var rr = null;
      try { rr = await G.pb4u.bluetoothReconnect(nm); } catch (e) { rr = null; }
      if (rr && rr.ok && links[vname] && links[vname].t.connected) { changed(); return links[vname]; }
      throw new Error('Could not find ' + nm + '. Switch it on and keep it close.' + (rr && rr.error ? ' (' + rr.error + ')' : ''));
    }
    if (lastErr) throw new Error('Could not reach ' + nm + '. Switch it on and keep it close, or tap Connect Instax printer. (' + ((lastErr && lastErr.message) || lastErr) + ')');
    throw new Error(nm + ' is not connected. Open Printer settings and tap Connect Instax printer.');
  }

  // Tries to bring every printer set up before back on its own (the booth calls this when it opens). Never throws.
  var reconnecting = false;
  async function autoReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    try {
      var ns = names();
      for (var i = 0; i < ns.length; i++) { if (!connectedNow(ns[i]) && !active[ns[i]]) { try { await ensure(ns[i]); } catch (e) { } } }
    } finally { reconnecting = false; changed(); }
  }

  // Prints every page (canvases) on one printer. One job at a time per printer; two printers run side by side.
  function print(pages, paper, vname, opt) {
    opt = opt || {};
    var run = function () {
      return ensure(vname).then(async function (link) {
        var info = await link.p.getInfo();
        for (var i = 0; i < pages.length; i++) {
          var jpeg = await renderJpeg(pages[i], info);
          try { await link.p.printJpeg(jpeg, opt); }
          catch (e) {                                           // one retry on a dropped link
            if (link.p.printSent || e.uncertain || !/disconnect|did not answer/i.test((e && e.message) || '')) throw e;          // never send a job again once its print command went out
            link.t.close(); link = await ensure(vname); await link.p.getInfo();
            await link.p.printJpeg(jpeg, opt);
          }
          if (opt.onPage) opt.onPage(i + 1, pages.length);
        }
        return true;
      });
    };
    active[vname] = (active[vname] || 0) + 1;
    var job = (jobs[vname] || Promise.resolve()).catch(function () { }).then(run);
    var left = function () { active[vname] = Math.max(0, (active[vname] || 1) - 1); };
    job.then(left, left);
    jobs[vname] = job.catch(function () { });
    return job;
  }

  // For the printer settings screen.
  async function status(vname) {
    var l = links[vname];
    if (!l || !l.t.connected) return { connected: false };
    try {
      var s = await l.p.status(), i = await l.p.getInfo();
      return { connected: true, film: s ? s.film : null, battery: s ? s.battery : null, width: i.width, height: i.height };
    } catch (e) { return { connected: l.t.connected, error: (e && e.message) || String(e) }; }
  }

  G._instax = {
    VIRTUAL: VIRTUAL, available: available, isAndroidApp: isAndroidApp, isInstaxName: isInstaxName, names: names,
    pair: pair, print: print, status: status, forget: forget, connectedNow: connectedNow, autoReconnect: autoReconnect, _autoPair: autoPair,
    onChange: function (fn) { listeners.push(fn); },
    // for the tests
    _t: { buildFrame: buildFrame, parseFrame: parseFrame, FrameReader: FrameReader, Printer: Printer, renderJpeg: renderJpeg, parseImageInfo: parseImageInfo, parseFunctionInfo: parseFunctionInfo, checksumOf: checksumOf, u32bytes: u32bytes, resultText: resultText }
  };
})(typeof window !== 'undefined' ? window : globalThis);
