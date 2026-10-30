/*
 * navigator.usb (WebUSB) for the photobooth4u Android app's WebView.
 *
 * Android's WebView has no WebUSB, but the booth's USB camera mode (the gPhoto2 WASM library behind
 * /camera-test/build/camera.js) talks to the camera through navigator.usb. This script builds a navigator.usb
 * on top of window.__PBUsb (UsbBridge.kt), which does the real work with Android's UsbManager.
 *
 * It runs before the page's own scripts (addDocumentStartJavaScript, and inlined into the offline booth), and
 * does nothing in a normal browser (navigator.usb already exists) or when the bridge is missing.
 *
 * Transport: transport.call(op, args) -> Promise. Everything below talks only to that, so moving the bulk
 * data to another channel later (e.g. the local web server) means replacing this one function and the
 * matching Kotlin entry point, not the USBDevice code.
 */
(function () {
  'use strict';

  var native = window.__PBUsb;
  if (!native || navigator.usb || window.__pbUsbShim) return;
  window.__pbUsbShim = true;

  // ── transport ────────────────────────────────────────────────────────────────────────────

  var pending = {};
  var nextId = 1;

  function domError(name, message) {
    try { return new DOMException(message || name, name); }
    catch (e) { var err = new Error(message || name); err.name = name; return err; }
  }

  // Camera log: events only the page can see go into the app's camera log (UsbBridge.logFromPage); what Android
  // itself did and returned is logged on the native side.
  function plog(kind, info) {
    try { if (native.logFromPage) native.logFromPage(kind, JSON.stringify(info || {})); } catch (e) { }
  }

  // An error the shim raises itself (before anything reaches Android), logged with its exact text.
  function refused(name, message) {
    plog('shim-refused', { errName: name, error: message });
    return domError(name, message);
  }

  var transport = {
    call: function (op, args) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending[id] = { resolve: resolve, reject: reject };
        try { native.call(id, op, JSON.stringify(args || {})); }
        catch (e) {
          delete pending[id];
          plog('shim-call-throw', { op: op, error: String(e && e.message || e) });
          reject(domError('NetworkError', String(e && e.message || e)));
        }
      });
    }
  };

  // Answers from Kotlin: (callback id, ok, payload).
  window.__pbUsbCb = function (id, ok, payload) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.resolve(payload);
    else p.reject(domError(payload && payload.name || 'NetworkError', payload && payload.message));
  };

  // ── bytes <-> base64 ─────────────────────────────────────────────────────────────────────

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(s);
  }

  function fromBase64(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  }

  // ── descriptor objects (what USBDevice.configurations shows) ────────────────────────────

  function Endpoint(d) {
    this.endpointNumber = d.endpointNumber;
    this.direction = d.direction;
    this.type = d.type;
    this.packetSize = d.packetSize;
  }

  function AlternateInterface(d) {
    this.alternateSetting = d.alternateSetting;
    this.interfaceClass = d.interfaceClass;
    this.interfaceSubclass = d.interfaceSubclass;
    this.interfaceProtocol = d.interfaceProtocol;
    this.interfaceName = d.interfaceName || null;
    this.endpoints = (d.endpoints || []).map(function (e) { return new Endpoint(e); });
  }

  function Interface(d) {
    this.interfaceNumber = d.interfaceNumber;
    this.alternates = (d.alternates || []).map(function (a) { return new AlternateInterface(a); });
    this.alternate = this.alternates[0] || null;
    this.claimed = false;
  }

  function Configuration(d) {
    this.configurationValue = d.configurationValue;
    this.configurationName = d.configurationName || null;
    this.interfaces = (d.interfaces || []).map(function (i) { return new Interface(i); });
  }

  // ── USBDevice ────────────────────────────────────────────────────────────────────────────

  function Device(d) {
    this._id = d.id;
    this.usbVersionMajor = d.usbVersionMajor;
    this.usbVersionMinor = d.usbVersionMinor;
    this.usbVersionSubminor = d.usbVersionSubminor;
    this.deviceClass = d.deviceClass;
    this.deviceSubclass = d.deviceSubclass;
    this.deviceProtocol = d.deviceProtocol;
    this.vendorId = d.vendorId;
    this.productId = d.productId;
    this.deviceVersionMajor = d.deviceVersionMajor;
    this.deviceVersionMinor = d.deviceVersionMinor;
    this.deviceVersionSubminor = d.deviceVersionSubminor;
    this.manufacturerName = d.manufacturerName || null;
    this.productName = d.productName || null;
    this.serialNumber = d.serialNumber || null;
    this.configurations = (d.configurations || []).map(function (c) { return new Configuration(c); });
    this.configuration = null;
    this.opened = false;
  }

  var P = Device.prototype;

  P._needOpen = function () {
    if (!this.opened) throw refused('InvalidStateError', 'The device must be opened first.');
  };

  P._iface = function (n) {
    var cfg = this.configuration;
    if (!cfg) throw refused('InvalidStateError', 'The device must have a configuration selected.');
    for (var i = 0; i < cfg.interfaces.length; i++) if (cfg.interfaces[i].interfaceNumber === n) return cfg.interfaces[i];
    throw refused('NotFoundError', 'The interface number provided is not supported by the device in its current configuration.');
  };

  P.open = function () {
    var self = this;
    return transport.call('open', { id: self._id }).then(function () {
      self.opened = true;
      // Android has already selected the camera's (only) configuration; Chrome reports it the same way.
      if (!self.configuration) self.configuration = self.configurations[0] || null;
    });
  };

  P.close = function () {
    var self = this;
    return transport.call('close', { id: self._id }).then(function () {
      self.opened = false;
      if (self.configuration) self.configuration.interfaces.forEach(function (i) { i.claimed = false; });
    });
  };

  P.forget = function () { return this.close().catch(function () { }); };

  P.selectConfiguration = function (value) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var cfg = self.configurations.filter(function (c) { return c.configurationValue === value; })[0];
      if (!cfg) throw refused('NotFoundError', 'The configuration value provided is not supported by the device.');
      return transport.call('selectConfiguration', { id: self._id, value: value }).then(function () { self.configuration = cfg; });
    });
  };

  P.claimInterface = function (n) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var itf = self._iface(n);
      return transport.call('claimInterface', { id: self._id, number: n }).then(function () { itf.claimed = true; });
    });
  };

  P.releaseInterface = function (n) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var itf = self._iface(n);
      return transport.call('releaseInterface', { id: self._id, number: n }).then(function () { itf.claimed = false; });
    });
  };

  P.selectAlternateInterface = function (n, alt) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var itf = self._iface(n);
      var a = itf.alternates.filter(function (x) { return x.alternateSetting === alt; })[0];
      if (!a) throw refused('NotFoundError', 'The alternate setting provided is not supported by the device.');
      return transport.call('selectAlternateInterface', { id: self._id, number: n, alt: alt }).then(function () { itf.alternate = a; });
    });
  };

  P.clearHalt = function (direction, endpointNumber) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      return transport.call('clearHalt', { id: self._id, direction: direction, endpoint: endpointNumber }).then(function () { });
    });
  };

  P.reset = function () {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      return transport.call('reset', { id: self._id }).then(function () { });
    });
  };

  P.transferIn = function (endpointNumber, length) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      return transport.call('transferIn', { id: self._id, endpoint: endpointNumber, length: length }).then(function (r) {
        var b = fromBase64(r.data);
        return { status: r.status || 'ok', data: new DataView(b.buffer) };
      });
    });
  };

  P.transferOut = function (endpointNumber, data) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      return transport.call('transferOut', { id: self._id, endpoint: endpointNumber, data: toBase64(bytesOf(data)) }).then(function (r) {
        return { status: r.status || 'ok', bytesWritten: r.bytesWritten };
      });
    });
  };

  function controlArgs(self, setup) {
    return {
      id: self._id,
      requestType: setup.requestType,
      recipient: setup.recipient,
      request: setup.request,
      value: setup.value,
      index: setup.index
    };
  }

  P.controlTransferIn = function (setup, length) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var a = controlArgs(self, setup);
      a.length = length;
      return transport.call('controlIn', a).then(function (r) {
        var b = fromBase64(r.data);
        return { status: r.status || 'ok', data: new DataView(b.buffer) };
      });
    });
  };

  P.controlTransferOut = function (setup, data) {
    var self = this;
    return Promise.resolve().then(function () {
      self._needOpen();
      var a = controlArgs(self, setup);
      if (data !== undefined) a.data = toBase64(bytesOf(data));
      return transport.call('controlOut', a).then(function (r) {
        return { status: r.status || 'ok', bytesWritten: r.bytesWritten };
      });
    });
  };

  P.isochronousTransferIn = P.isochronousTransferOut = function () {
    return Promise.reject(domError('NotSupportedError', 'Isochronous USB transfers are not supported in the app.'));
  };

  // ── navigator.usb ────────────────────────────────────────────────────────────────────────

  var devices = {};   // id -> Device, so the same camera is always the same object

  function deviceFor(desc) {
    var d = devices[desc.id];
    if (!d) d = devices[desc.id] = new Device(desc);
    return d;
  }

  function ConnectionEvent(type, device) {
    var e = new Event(type);
    e.device = device;
    return e;
  }

  var usb = new EventTarget();
  usb.onconnect = null;
  usb.ondisconnect = null;

  usb.getDevices = function () {
    return transport.call('list').then(function (r) {
      var list = (r.devices || []).map(deviceFor);
      // Forget cameras that are gone.
      var live = {};
      list.forEach(function (d) { live[d._id] = true; });
      Object.keys(devices).forEach(function (id) { if (!live[id]) delete devices[id]; });
      return list;
    });
  };

  usb.requestDevice = function (options) {
    var filters = options && options.filters;
    if (!Array.isArray(filters)) return Promise.reject(new TypeError("Failed to execute 'requestDevice' on 'USB': required member filters is undefined."));
    return transport.call('request', { filters: filters }).then(function (r) { return deviceFor(r.device); });
  };

  // Plug and unplug news from Kotlin.
  window.__pbUsbEvent = function (kind, desc) {
    var dev;
    if (kind === 'connect') {
      dev = deviceFor(desc);
    } else {
      dev = devices[desc.id];
      if (!dev) return;
      dev.opened = false;
      delete devices[desc.id];
    }
    plog('shim-event', { event: kind, name: desc.productName || '', id: desc.id });
    var ev = ConnectionEvent(kind, dev);
    var handler = usb['on' + kind];
    if (typeof handler === 'function') { try { handler.call(usb, ev); } catch (e) { } }
    usb.dispatchEvent(ev);
  };

  try {
    Object.defineProperty(Navigator.prototype, 'usb', { get: function () { return usb; }, configurable: true });
  } catch (e) {
    navigator.usb = usb;
  }

  // Interfaces some code checks for; harmless if the browser already has them.
  if (!window.USBDevice) window.USBDevice = Device;

  // The booth only turns the camera on in a cross-origin isolated page; say so in the log if the app's page is not one.
  plog('shim-start', { url: String(location.href).slice(0, 120), isolated: !!window.crossOriginIsolated });
  window.addEventListener('load', function () {
    plog('shim-loaded', { isolated: !!window.crossOriginIsolated, usbInNavigator: 'usb' in navigator, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' });
    if (!window.crossOriginIsolated) console.warn('[PBUsb] This page is not cross-origin isolated, so the USB camera mode stays off.');
  });
})();
