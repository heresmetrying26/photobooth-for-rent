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
  function isKnown58mmPrinter(name) {
    return /(?:^|[^a-z0-9])(?:vo[zx]y[\s_-]*(?:p50|50)|p50|mp[-_ ]?210|pt[-_ ]?210|mpt[-_ ]?(?:ii|iii|2|3)|rpp[-_ ]?(?:02n?|200)|xp[-_ ]?58[a-z0-9]*|pos[-_ ]?58[a-z0-9]*|t[-_ ]?58[a-z0-9]*|gzm?[-_ ]?58|58\s*mm)(?![a-z0-9])/i.test(String(name || ''));
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

  // ── Canvas → monochrome with serpentine Atkinson halftoning ──────────────
  // Uses edge-preserving smoothing, highlight roll-off and 75% error diffusion
  // so highlights stay pure clean white (no pepper grain), midtones are smooth and retro,
  // and text/borders stay crisp.
  function applyThermalTone(lum, dotW, dotH, q) {
    var n = dotW * dotH, x, y, i;
    var clean = new Float32Array(n);
    clean.set(lum);
    var invT2 = 1 / 144;
    for (y = 1; y < dotH - 1; y++) {
      var rm = (y - 1) * dotW, r0 = y * dotW, rp = (y + 1) * dotW;
      for (x = 1; x < dotW - 1; x++) {
        var c0 = lum[r0 + x];
        if (c0 <= 8 || c0 >= 248) continue;
        var s = c0, sw = 1, v, df, wt;
        v = lum[rm + x - 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[rm + x];     df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[rm + x + 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[r0 + x - 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[r0 + x + 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[rp + x - 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[rp + x];     df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        v = lum[rp + x + 1]; df = v - c0; wt = 1 / (1 + df * df * invT2); s += v * wt; sw += wt;
        clean[r0 + x] = s / sw;
      }
    }
    lum.set(clean);
    var lift = dotW <= 384 ? 0.78 : 0.82;
    var lut = new Float32Array(256);
    for (i = 0; i < 256; i++) {
      var u = Math.pow(i / 255, lift);
      if (u > 0.82) {
        var t = (u - 0.82) / (1.0 - 0.82);
        u = 0.82 + (1.0 - 0.82) * (3 * t * t - 2 * t * t * t);
        if (u >= 0.96) u = 1.0;
      }
      lut[i] = Math.max(0, Math.min(255, u * 255));
    }
    for (i = 0; i < n; i++) {
      var ki = (lum[i] + 0.5) | 0;
      lum[i] = lut[ki < 0 ? 0 : ki > 255 ? 255 : ki];
    }
    if (q === 'best') {
      var blur = new Float32Array(n);
      for (y = 0; y < dotH; y++) {
        var y0 = y > 0 ? y - 1 : 0, y1 = y + 1 < dotH ? y + 1 : dotH - 1;
        for (x = 0; x < dotW; x++) {
          var x0 = x > 0 ? x - 1 : 0, x1 = x + 1 < dotW ? x + 1 : dotW - 1;
          var sum = 0, cnt = 0, yy, xx;
          for (yy = y0; yy <= y1; yy++) for (xx = x0; xx <= x1; xx++) { sum += lum[yy * dotW + xx]; cnt++; }
          blur[y * dotW + x] = sum / cnt;
        }
      }
      for (i = 0; i < n; i++) {
        if (lum[i] <= 12 || lum[i] >= 242) continue;
        var df2 = lum[i] - blur[i], adf = df2 < 0 ? -df2 : df2;
        if (adf > 6.0) {
          var mag = adf - 6.0; if (mag > 20) mag = 20;
          lum[i] = Math.max(0, Math.min(255, lum[i] + (df2 < 0 ? -mag : mag) * 0.40));
        }
      }
    }
  }

  function toReceiptGray(src, dotW, quality) {
    dotW = dotW || 576;
    var q = (quality === 'best' || quality === 'normal' || quality === 'draft') ? quality : 'best';
    var scale = dotW / src.width;
    var dotH  = Math.max(1, Math.round(src.height * scale));
    var dst   = document.createElement('canvas');
    dst.width = dotW; dst.height = dotH;
    var ctx = dst.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dotW, dotH);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dotW, dotH);
    var id = ctx.getImageData(0, 0, dotW, dotH), d = id.data;
    var n = dotW * dotH, lum = new Float32Array(n), i;
    for (i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    if (q !== 'draft') applyThermalTone(lum, dotW, dotH, q);
    for (i = 0; i < n; i++) {
      var v = Math.max(0, Math.min(255, Math.round(lum[i])));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    dst._pbToneDone = true;
    return dst;
  }

  function toReceiptCanvas(src, dotW, brightness, quality) {
    dotW = dotW || 576;
    var q = (quality === 'best' || quality === 'normal' || quality === 'draft') ? quality : 'best';
    var scale = dotW / src.width;
    var dotH  = Math.max(1, Math.round(src.height * scale));
    var dst   = document.createElement('canvas');
    dst.width = dotW; dst.height = dotH;
    var ctx = dst.getContext('2d');

    // Fill white background first (in case source has transparent regions)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dotW, dotH);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dotW, dotH);

    var id = ctx.getImageData(0, 0, dotW, dotH), d = id.data;
    var bOffset = (typeof brightness === 'number') ? brightness * 1.28 : 0;
    var n = dotW * dotH, lum = new Float32Array(n), x, y, i;
    for (i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

    var toneDone = !!(src && src._pbToneDone);
    if (!toneDone && q !== 'draft') {
      applyThermalTone(lum, dotW, dotH, q);
    }

    var out = new Uint8Array(n);
    if (q === 'draft') {
      var bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
      for (y = 0; y < dotH; y++) for (x = 0; x < dotW; x++) {
        var tb = (bayer[((y >> 1) & 3) * 4 + ((x >> 1) & 3)] + 0.5) / 16 * 255;
        out[y * dotW + x] = (lum[y * dotW + x] + bOffset) < tb ? 0 : 255;
      }
    } else {
      var stride = dotW + 4;
      var e0 = new Float32Array(stride), e1 = new Float32Array(stride), e2 = new Float32Array(stride), tmp;
      for (y = 0; y < dotH; y++) {
        var row = y * dotW, xi, l, v, e;
        if ((y & 1) === 0) {
          for (x = 0; x < dotW; x++) {
            xi = x + 2;
            l = lum[row + x] + e0[xi] + bOffset;
            v = l < 128 ? 0 : 255;
            e = (l - v) * 0.125;
            out[row + x] = v;
            e0[xi + 1] += e;
            e0[xi + 2] += e;
            e1[xi - 1] += e;
            e1[xi]     += e;
            e1[xi + 1] += e;
            e2[xi]     += e;
          }
        } else {
          for (x = dotW - 1; x >= 0; x--) {
            xi = x + 2;
            l = lum[row + x] + e0[xi] + bOffset;
            v = l < 128 ? 0 : 255;
            e = (l - v) * 0.125;
            out[row + x] = v;
            e0[xi - 1] += e;
            e0[xi - 2] += e;
            e1[xi + 1] += e;
            e1[xi]     += e;
            e1[xi - 1] += e;
            e2[xi]     += e;
          }
        }
        tmp = e0; e0 = e1; e1 = e2; e2 = tmp; e2.fill(0);
      }
    }
    for (i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i]; d[i * 4 + 3] = 255; }
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
    { namePrefix: 'VOZY' }, { namePrefix: 'VOXY' }, { namePrefix: 'G80' }, { namePrefix: 'V80' }, { namePrefix: 'P50' },
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
    var effW = (cmd === 'cat' || cmd === 'luck' || isKnown58mmPrinter(this._name)) ? 384 : this._paperWidth;
    var mono = toReceiptCanvas(canvas, effW, opts.brightness, opts.quality);
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
    if (cmd === 'cat' || cmd === 'luck' || isKnown58mmPrinter(this._name)) paper = '58mm';
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
  function printViaBluetooth(canvas, paper, opts) {
    var targetW = PAPER_WIDTHS[paper || '80mm'] || 576;
    btPrinter._paperWidth = (btPrinter.connected && isKnown58mmPrinter(btPrinter._name)) ? 384 : targetW;
    var p = btPrinter.connected
      ? Promise.resolve()
      : btPrinter.connect();
    return p.then(function() {
      btPrinter._paperWidth = isKnown58mmPrinter(btPrinter._name) ? 384 : targetW;
      return btPrinter.printCanvas(canvas, opts);
    });
  }

  // Expose on global/window
  global._btThermal = {
    BtThermal        : BtThermal,
    EscPosEncoder    : EscPosEncoder,
    CatPrinterEncoder: CatPrinterEncoder,
    isCatDevice      : isCatDevice,
    isKnown58mmPrinter: isKnown58mmPrinter,
    PAPER_WIDTHS     : PAPER_WIDTHS,
    toReceiptCanvas  : toReceiptCanvas,
    toReceiptGray    : toReceiptGray,
    btPrinter        : btPrinter,
    isBtAvailable    : isBtAvailable,
    isNativeAndroid  : isNativeAndroid,
    printViaBluetooth: printViaBluetooth,
  };

}(typeof globalThis !== 'undefined' ? globalThis : window));
