/**
 * bt-thermal.mjs — Bluetooth thermal receipt printer for tablet / mobile.
 *
 * Supports:
 *   • Android native bridge: window.__BTBridge injected by the Android wrapper (RFCOMM SPP)
 *   • Android Chrome (Web Bluetooth): BLE serial / SPP GATT services
 *   • iOS 16+ (Safari / Bluefy / WebBLE): Web Bluetooth LE (Epson TM-m30III, Star, Nordic UART, ISSC)
 *   • Laptop browser direct Web Bluetooth (when available)
 *
 * Usage:
 *   const { printViaBluetooth, isBtAvailable, btPrinter } = window._btThermal;
 *   await printViaBluetooth(canvas, '80mm');
 */
(function(global) {
  'use strict';

  // ── ESC/POS constants ─────────────────────────────────────────────────────
  var ESC = 0x1B, GS = 0x1D, LF = 0x0A;

  // 80 mm paper at 203 dpi = 576 printable dots (typical printable width 72mm).
  // 58 mm paper at 203 dpi = 384 printable dots (typical printable width 48mm).
  var PAPER_WIDTHS = { '80mm': 576, '58mm': 384 };

  // ── ESC/POS encoder ───────────────────────────────────────────────────────
  function EscPosEncoder(paperWidth) {
    this._w   = paperWidth || 576;
    this._buf = [];
  }
  EscPosEncoder.prototype._byte = function() {
    for (var i = 0; i < arguments.length; i++) this._buf.push(arguments[i] & 0xFF);
    return this;
  };
  EscPosEncoder.prototype.initialize = function() {
    return this._byte(ESC, 0x40);        // ESC @ — initialize printer
  };
  EscPosEncoder.prototype.feed = function(n) {
    n = n || 1;
    for (var i = 0; i < n; i++) this._buf.push(LF);
    return this;
  };
  EscPosEncoder.prototype.cut = function(partial) {
    // Feed 3 lines to ensure the content clears the print head before cutting,
    // then send GS V A 0 (feed to cut position and cut)
    this.feed(3);
    return this._byte(GS, 0x56, partial ? 0x42 : 0x41, 0x00);
  };

  /**
   * Raster bit-image (GS v 0) with vertical band slicing.
   * Printing in bands (e.g. 256 lines per band) avoids buffer overflows
   * on budget thermal printers (Xprinter XP-80C, etc.) and ensures
   * flawless rendering regardless of receipt length.
   */
  EscPosEncoder.prototype.image = function(canvas, maxBandHeight) {
    var ctx  = canvas.getContext('2d');
    var W    = canvas.width, H = canvas.height;
    var byteW = Math.ceil(W / 8);
    maxBandHeight = maxBandHeight || 256;

    var imgData = ctx.getImageData(0, 0, W, H).data;

    for (var startY = 0; startY < H; startY += maxBandHeight) {
      var bandH = Math.min(maxBandHeight, H - startY);

      // GS v 0 <m=0> <xL> <xH> <yL> <yH>
      this._byte(GS, 0x76, 0x30, 0x00);
      this._byte(byteW & 0xFF, (byteW >> 8) & 0xFF);
      this._byte(bandH & 0xFF, (bandH >> 8) & 0xFF);

      for (var y = 0; y < bandH; y++) {
        var srcY = startY + y;
        for (var bx = 0; bx < byteW; bx++) {
          var byte = 0;
          for (var bit = 0; bit < 8; bit++) {
            var x = bx * 8 + bit;
            if (x < W) {
              var idx = (srcY * W + x) * 4;
              // Monochrome: dark pixels (lum < 128) are printed (bit 1)
              var lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
              if (lum < 128) byte |= (0x80 >> bit);
            }
          }
          this._buf.push(byte);
        }
      }
    }
    return this;
  };

  EscPosEncoder.prototype.imageLuck = function(canvas, maxBandHeight, feed) {
    for (var i = 0; i < 12; i++) this._buf.push(0x00);
    this._byte(0x10, 0xFF, 0xF1, 0x03);
    this._byte(0x10, 0xFF, 0x10, 0x00, 0x01);
    this.image(canvas, maxBandHeight || 64);
    var feedDots = Math.min(255, Math.max(40, (feed != null ? feed : 3) * 24));
    this._byte(ESC, 0x4A, feedDots);
    return this._byte(0x10, 0xFF, 0xF1, 0x45);
  };

  EscPosEncoder.prototype.getBuffer = function() {
    return new Uint8Array(this._buf);
  };

  // ── LIOTOG C19 / FunPrint / Cat Printer (0x51 0x78) BLE encoder ───────────
  var CAT_CRC8_TABLE = (function() {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
      t[i] = c;
    }
    return t;
  }());
  function catCrc8(payload) {
    var c = 0;
    for (var i = 0; i < payload.length; i++) c = CAT_CRC8_TABLE[(c ^ payload[i]) & 0xFF];
    return c;
  }
  function isCatDevice(name, svcUuid, proto) {
    if (proto === 'cat') return true;
    var s = String(svcUuid || '').toLowerCase();
    if (s.indexOf('ae30') >= 0 || s.indexOf('ae00') >= 0) return true;
    return /^(C19|LIOTOG|MX\d|GB0|GT0|YT0|PD01)/i.test(String(name || '').trim());
  }
  function CatPrinterEncoder() {
    this._w   = 384;
    this._buf = [];
  }
  CatPrinterEncoder.prototype._frame = function(cmd, payload) {
    var len = payload.length;
    this._buf.push(0x51, 0x78, cmd & 0xFF, 0x00, len & 0xFF, (len >> 8) & 0xFF);
    for (var i = 0; i < len; i++) this._buf.push(payload[i] & 0xFF);
    this._buf.push(catCrc8(payload), 0xFF);
    return this;
  };
  CatPrinterEncoder.prototype.encode = function(canvas, feed) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var byteW = 48;
    var imgData = ctx.getImageData(0, 0, W, H).data;

    this._frame(0xA4, [0x33]);
    this._frame(0xAF, [0xE0, 0x2E]);
    this._frame(0xBE, [0x00]);
    this._frame(0xA6, [0xAA, 0x55, 0x17, 0x38, 0x44, 0x5F, 0x5F, 0x5F, 0x44, 0x38, 0x2C]);

    var row = new Uint8Array(byteW);
    for (var y = 0; y < H; y++) {
      for (var bx = 0; bx < byteW; bx++) {
        var byte = 0;
        for (var bit = 0; bit < 8; bit++) {
          var x = bx * 8 + bit;
          if (x < W) {
            var idx = (y * W + x) * 4;
            var lum = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
            if (lum < 128) byte |= (1 << bit);
          }
        }
        row[bx] = byte;
      }
      this._frame(0xA2, row);
    }

    var steps = Math.min(255, Math.max(24, (feed != null ? feed : 3) * 20));
    this._frame(0xA1, [steps & 0xFF, (steps >> 8) & 0xFF]);
    this._frame(0xA6, [0xAA, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17]);
    return this;
  };
  CatPrinterEncoder.prototype.getBuffer = function() {
    return new Uint8Array(this._buf);
  };

  // ── Canvas → monochrome with 2-line Floyd-Steinberg dithering ──────────────
  // Uses two rows of error diffusion for low memory footprint (~4 KB vs 6 MB).
  function toReceiptCanvas(src, dotW) {
    dotW = dotW || 576;
    var scale = dotW / src.width;
    var dotH  = Math.max(1, Math.round(src.height * scale));
    var dst   = document.createElement('canvas');
    dst.width = dotW; dst.height = dotH;
    var ctx = dst.getContext('2d');

    // Fill white background first (in case source has transparent regions)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dotW, dotH);
    ctx.drawImage(src, 0, 0, dotW, dotH);

    var id = ctx.getImageData(0, 0, dotW, dotH), d = id.data;
    var curErr  = new Float32Array(dotW);
    var nextErr = new Float32Array(dotW);

    for (var y = 0; y < dotH; y++) {
      nextErr.fill(0);
      for (var x = 0; x < dotW; x++) {
        var i4 = (y * dotW + x) * 4;
        var lum = 0.299 * d[i4] + 0.587 * d[i4 + 1] + 0.114 * d[i4 + 2] + curErr[x];
        var v = lum < 128 ? 0 : 255;
        var e = lum - v;
        d[i4] = d[i4 + 1] = d[i4 + 2] = v;
        d[i4 + 3] = 255;

        // Distribute error: right (7/16), down-left (3/16), down (5/16), down-right (1/16)
        if (x + 1 < dotW) curErr[x + 1] += e * 7 / 16;
        if (x > 0)        nextErr[x - 1] += e * 3 / 16;
        nextErr[x]     += e * 5 / 16;
        if (x + 1 < dotW) nextErr[x + 1] += e * 1 / 16;
      }
      // Swap rows
      var tmp = curErr;
      curErr = nextErr;
      nextErr = tmp;
    }
    ctx.putImageData(id, 0, 0);
    return dst;
  }

  // ── Chunk-safe Base64 conversion (avoids call stack overflow on large arrays) ──
  function uint8ToBase64(bytes) {
    var bin = '';
    var len = bytes.length;
    var CHUNK_SIZE = 8192;
    for (var i = 0; i < len; i += CHUNK_SIZE) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK_SIZE, len)));
    }
    return btoa(bin);
  }

  // ── Well-known thermal printer Bluetooth services ─────────────────────────
  var WELL_KNOWN_SERVICES = [
    '0000ae30-0000-1000-8000-00805f9b34fb',  // FunPrint / LIOTOG C19 BLE
    '0000ae00-0000-1000-8000-00805f9b34fb',  // FunPrint alt BLE
    '000018f0-0000-1000-8000-00805f9b34fb',  // Generic BLE Serial / Epson
    '0000e781-0000-1000-8000-00805f9b34fb',  // ISSC / Chinese thermal
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',  // ISSC alternative
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',  // Nordic UART Service (NUS)
    '0000ff00-0000-1000-8000-00805f9b34fb',  // POS custom FF00
    '0000fff0-0000-1000-8000-00805f9b34fb',  // POS custom FFF0
    '0000ffe0-0000-1000-8000-00805f9b34fb',  // FunnyPrint / BLE UART
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',  // Star / Chinese POS
    '00001101-0000-1000-8000-00805f9b34fb'   // Classic RFCOMM SPP
  ];

  var PRINTER_FILTERS = [
    { namePrefix: 'C19' }, { namePrefix: 'LIOTOG' }, { namePrefix: 'Liotog' },
    { namePrefix: 'MX' }, { namePrefix: 'GB' }, { namePrefix: 'GT' }, { namePrefix: 'YT' }, { namePrefix: 'PD' },
    { namePrefix: 'XP' }, { namePrefix: 'Xprinter' },
    { namePrefix: 'TM' }, { namePrefix: 'Epson' }, { namePrefix: 'EPSON' },
    { namePrefix: 'POS' }, { namePrefix: 'Receipt' }, { namePrefix: 'Thermal' },
    { namePrefix: 'RPP' }, { namePrefix: 'Bixolon' }, { namePrefix: 'BIXOLON' },
    { namePrefix: 'Star' }, { namePrefix: 'MP' }, { namePrefix: 'BP' },
    { namePrefix: 'Printer' }, { namePrefix: 'MTP' }, { namePrefix: 'BlueTooth' },
    { namePrefix: 'Inner' }, { namePrefix: 'Qsprinter' }
  ];

  // ── BtThermal class ───────────────────────────────────────────────────────
  function BtThermal(opts) {
    opts = opts || {};
    this._paperWidth = opts.paperWidth || 576;
    this._device  = null;
    this._server  = null;
    this._char    = null;
    this._mode    = null;   // 'bridge' | 'spp' | 'le' | null
    this._name    = '';
    this._serviceUuid = '';
    this._proto   = '';
    this.onDisconnect = null;
  }

  Object.defineProperty(BtThermal.prototype, 'connected', { get: function() { return this._mode !== null; } });
  Object.defineProperty(BtThermal.prototype, 'name',      { get: function() { return this._name; } });
  Object.defineProperty(BtThermal.prototype, 'mode',      { get: function() { return this._mode; } });

  BtThermal.prototype.effectiveCmd = function() {
    var prof = {};
    try { prof = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('pb_bt_profile')) || '{}') || {}; } catch(_) {}
    if (prof.cmd === 'cat' || prof.cmd === 'luck' || prof.cmd === 'star') return prof.cmd;
    if (isCatDevice(this._name, this._serviceUuid, this._proto)) return 'cat';
    return 'raster';
  };

  /** Returns 'bridge' | 'web' | null */
  BtThermal.available = function() {
    if (global.__BTBridge && typeof global.__BTBridge.connect === 'function') return 'bridge';
    if (typeof navigator !== 'undefined' && navigator.bluetooth) return 'web';
    return null;
  };

  BtThermal.prototype.connect = function(mode) {
    var resolved = mode || BtThermal.available();
    if (!resolved) {
      return Promise.reject(new Error('Bluetooth is not available. Use Chrome on Android, the Android Wrapper app, or Safari on iOS 16+.'));
    }
    if (resolved === 'bridge') return this._connectBridge();
    return this._connectWebBt();
  };

  // Native Android bridge (RFCOMM SPP / BLE GATT via Java/Kotlin wrapper) ────
  BtThermal.prototype._connectBridge = function() {
    var self = this;
    return Promise.resolve(global.__BTBridge.connect())
      .then(function(res) {
        var r = res;
        if (typeof r === 'string') {
          try { r = JSON.parse(r); } catch(_) { r = { ok: true, name: r }; }
        }
        if (!r || r.ok === false) {
          throw new Error((r && r.error) || 'Android Bluetooth connection failed');
        }
        self._mode = 'bridge';
        self._name = (r && r.name) || 'Bluetooth Printer';
        self._serviceUuid = '';
        self._proto = (r && r.proto) || '';
        return self._name;
      });
  };

  // Web Bluetooth (Chrome Android / iOS Safari / Desktop Chrome) ──────────────
  BtThermal.prototype._connectWebBt = function() {
    var self = this;
    if (!navigator.bluetooth) {
      return Promise.reject(new Error('Web Bluetooth not supported on this browser.'));
    }

    // Try targeted printer filters first; if user rejects or device doesn't match prefix, allow any device
    var reqOpts = {
      filters: PRINTER_FILTERS,
      optionalServices: WELL_KNOWN_SERVICES
    };

    return navigator.bluetooth.requestDevice(reqOpts)
      .catch(function(e) {
        // Fall back to showing all devices if named filters fail or device has custom name
        if (e && e.name === 'NotFoundError') {
          return navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: WELL_KNOWN_SERVICES
          });
        }
        throw e;
      })
      .then(function(device) {
        self._device = device;
        self._name   = device.name || 'Bluetooth Printer';
        self._serviceUuid = '';
        self._proto = '';
        device.addEventListener('gattserverdisconnected', function() { self._onDisconnect(); });
        return device.gatt.connect();
      })
      .then(function(server) {
        self._server = server;
        return self._findWritableChar(server);
      })
      .then(function(c) {
        self._char = c;
        self._mode = 'le';
        return self._name;
      });
  };

  BtThermal.prototype._findWritableChar = function(server) {
    var self = this;

    // Helper: inspect a service's characteristics for write capability (prefer ae01 / ff02)
    function searchService(svc) {
      return svc.getCharacteristics().then(function(chars) {
        var writeChar = null, notifyChar = null;
        for (var i = 0; i < chars.length; i++) {
          var c = chars[i];
          var u = String(c.uuid || '').toLowerCase();
          if (c.properties && c.properties.notify && (u.indexOf('ae02') >= 0 || u.indexOf('ff01') >= 0 || u.indexOf('ff03') >= 0)) {
            notifyChar = c;
          }
          if (c.properties && (c.properties.writeWithoutResponse || c.properties.write)) {
            if (!writeChar || u.indexOf('ae01') >= 0 || u.indexOf('ff02') >= 0) {
              writeChar = c;
            }
          }
        }
        if (!writeChar) return null;
        self._serviceUuid = String(svc.uuid || '').toLowerCase();
        if (notifyChar && typeof notifyChar.startNotifications === 'function') {
          return Promise.resolve(notifyChar.startNotifications()).catch(function() {}).then(function() { return writeChar; });
        }
        return writeChar;
      }).catch(function() { return null; });
    }

    // Attempt services from WELL_KNOWN_SERVICES one by one
    var p = Promise.resolve(null);
    WELL_KNOWN_SERVICES.forEach(function(uuid) {
      p = p.then(function(found) {
        if (found) return found;
        return server.getPrimaryService(uuid)
          .then(searchService)
          .catch(function() { return null; });
      });
    });

    return p.then(function(found) {
      if (found) return found;
      // Fallback: query all primary services
      if (typeof server.getPrimaryServices === 'function') {
        return server.getPrimaryServices().then(function(services) {
          var chain = Promise.resolve(null);
          services.forEach(function(svc) {
            chain = chain.then(function(f) {
              if (f) return f;
              return searchService(svc);
            });
          });
          return chain;
        });
      }
      return null;
    }).then(function(char) {
      if (!char) {
        throw new Error('No writable characteristic found on ' + self._name + '. Ensure Bluetooth is enabled and the printer supports BLE/SPP.');
      }
      return char;
    });
  };

  BtThermal.prototype.disconnect = function() {
    this._mode = null; this._char = null; this._serviceUuid = ''; this._proto = '';
    try { if (this._server && this._server.connected) this._server.disconnect(); } catch(_) {}
    try { if (global.__BTBridge && typeof global.__BTBridge.disconnect === 'function') global.__BTBridge.disconnect(); } catch(_) {}
    this._server = null; this._device = null;
    if (typeof this.onDisconnect === 'function') this.onDisconnect();
  };

  BtThermal.prototype._onDisconnect = function() {
    this._mode = null; this._char = null; this._server = null; this._serviceUuid = ''; this._proto = '';
    if (typeof this.onDisconnect === 'function') this.onDisconnect();
  };

  // Raw write (auto-chunked for BLE MTU and serial buffer limits) ─────────────
  BtThermal.prototype.write = function(data) {
    if (!this._mode) return Promise.reject(new Error('Printer not connected'));

    if (this._mode === 'bridge') {
      var b64 = uint8ToBase64(data);
      return Promise.resolve(global.__BTBridge.write(b64))
        .then(function(res) {
          var r = res;
          if (typeof r === 'string') {
            try { r = JSON.parse(r); } catch(_) {}
          }
          if (r && r.ok === false) throw new Error(r.error || 'Write failed');
        });
    }

    var self = this;
    // BLE characteristic write length must fit in MTU (usually 100-244 bytes).
    // Using 100 bytes for LE is completely safe on all iOS/Android BLE stacks.
    var CHUNK = this._mode === 'le' ? 100 : 512;
    var off = 0;

    function next() {
      if (off >= data.length) return Promise.resolve();
      var chunk = data.subarray(off, off + CHUNK);
      off += CHUNK;
      var p = self._char.properties.writeWithoutResponse
        ? self._char.writeValueWithoutResponse(chunk)
        : self._char.writeValue(chunk);
      return p.then(function() {
        if (off < data.length) {
          return new Promise(function(r) { setTimeout(r, 12); }).then(next);
        }
      });
    }
    return next();
  };

  // High-level print canvas ──────────────────────────────────────────────────
  BtThermal.prototype.printCanvas = function(canvas, opts) {
    opts = opts || {};
    var cut  = opts.cut  !== false;
    var feed = opts.feed != null ? opts.feed : 3;
    if (!this._mode) return Promise.reject(new Error('Printer not connected'));

    var cmd  = this.effectiveCmd();
    var effW = (cmd === 'cat' || cmd === 'luck') ? 384 : this._paperWidth;
    var mono = toReceiptCanvas(canvas, effW);
    if (cmd === 'cat') {
      var catEnc = new CatPrinterEncoder();
      catEnc.encode(mono, feed);
      return this.write(catEnc.getBuffer());
    }
    var enc  = new EscPosEncoder(effW);
    if (cmd === 'luck') {
      enc.imageLuck(mono, 64, feed);
    } else {
      enc.initialize().image(mono).feed(feed);
      if (cut && effW > 384) enc.cut(); else if (cut) enc.feed(2);
    }
    return this.write(enc.getBuffer());
  };

  // Quick test print verification ────────────────────────────────────────────
  BtThermal.prototype.testPrint = function(paper) {
    var cmd = this.effectiveCmd();
    if (cmd === 'cat' || cmd === 'luck') paper = '58mm';
    var dotW = PAPER_WIDTHS[paper || '80mm'] || 576;
    var cvs = document.createElement('canvas');
    cvs.width = dotW;
    cvs.height = 360;
    var ctx = cvs.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';

    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('*** PHOTOBOOTH4U ***', dotW / 2, 50);

    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('THERMAL RECEIPT TEST', dotW / 2, 95);

    ctx.font = '16px sans-serif';
    ctx.fillText(new Date().toLocaleString(), dotW / 2, 130);
    ctx.fillText('Printer: ' + (this._name || 'Bluetooth Printer'), dotW / 2, 160);
    ctx.fillText('Paper: ' + (paper || '80mm') + ' (' + dotW + ' printable dots)', dotW / 2, 190);

    ctx.fillRect(30, 220, dotW - 60, 3);

    ctx.font = 'italic 20px sans-serif';
    ctx.fillText('Bluetooth thermal printing is working!', dotW / 2, 260);

    ctx.font = '15px monospace';
    ctx.fillText('--------------------------------', dotW / 2, 300);

    return this.printCanvas(cvs, { feed: 4, cut: true });
  };

  // ── Module-level singleton ────────────────────────────────────────────────
  var btPrinter = new BtThermal({ paperWidth: 576 });

  function isBtAvailable()   { return BtThermal.available() !== null; }
  function isNativeAndroid() { return !!(global.__BTBridge && global.__BTBridge.connect); }

  /**
   * Connect (if not already) then print.
   * @param {HTMLCanvasElement} canvas
   * @param {'80mm'|'58mm'} paper
   */
  function printViaBluetooth(canvas, paper) {
    btPrinter._paperWidth = PAPER_WIDTHS[paper || '80mm'] || 576;
    var p = btPrinter.connected
      ? Promise.resolve()
      : btPrinter.connect();
    return p.then(function() { return btPrinter.printCanvas(canvas); });
  }

  // Expose on global/window
  global._btThermal = {
    BtThermal        : BtThermal,
    EscPosEncoder    : EscPosEncoder,
    CatPrinterEncoder: CatPrinterEncoder,
    isCatDevice      : isCatDevice,
    PAPER_WIDTHS     : PAPER_WIDTHS,
    toReceiptCanvas  : toReceiptCanvas,
    btPrinter        : btPrinter,
    isBtAvailable    : isBtAvailable,
    isNativeAndroid  : isNativeAndroid,
    printViaBluetooth: printViaBluetooth,
  };

}(typeof globalThis !== 'undefined' ? globalThis : window));
