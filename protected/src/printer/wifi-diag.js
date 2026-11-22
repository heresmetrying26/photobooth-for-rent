/*
 * printer/wifi-diag.js: In-app Wi-Fi & Wi-Fi Direct Printer Tester (works 100% offline on Android,
 * including Epson Wi-Fi Direct 192.168.223.1, and on Desktop via /helper/printer/diag/*).
 *
 * One paste-in part of booth.src.html (see scripts/assemble-booth.mjs). Exposes window._wifiDiag.
 */
(function (G) {
  'use strict';

  var STORAGE_KEY = 'pb_wifi_diag_last_v1';
  var pending = {};

  G.__PBNetDiagResult = function (r) {
    try {
      var id = r && r.job;
      if (id && pending[id]) {
        var cb = pending[id];
        delete pending[id];
        clearTimeout(cb.timer);
        cb.resolve(r);
      }
    } catch (e) { }
  };

  var PRESETS = [
    {
      id: 'ipp_rec',
      label: 'IPP · Recommended (media-col 0mm + High + Glossy + NO scaling)',
      shortLabel: 'IPP media-col q=5 glossy no-scaling',
      protocol: 'ipp',
      format: 'image/jpeg',
      withMedia: true,
      marginMm100: 0,
      quality: 5,
      mediaType: 'photographic-glossy',
      mediaTypeMode: 'col',
      scaling: ''
    },
    {
      id: 'ipp_sc_none',
      label: 'IPP · media-col 0mm + High + Glossy + scaling=none',
      shortLabel: 'IPP media-col q=5 glossy sc=none',
      protocol: 'ipp',
      format: 'image/jpeg',
      withMedia: true,
      marginMm100: 0,
      quality: 5,
      mediaType: 'photographic-glossy',
      mediaTypeMode: 'col',
      scaling: 'none'
    },
    {
      id: 'ipp_sc_fill',
      label: 'IPP · media-col 0mm + High + Glossy + scaling=fill',
      shortLabel: 'IPP media-col q=5 glossy sc=fill',
      protocol: 'ipp',
      format: 'image/jpeg',
      withMedia: true,
      marginMm100: 0,
      quality: 5,
      mediaType: 'photographic-glossy',
      mediaTypeMode: 'col',
      scaling: 'fill'
    },
    {
      id: 'ipp_col_only',
      label: 'IPP · media-col 0mm only (no quality / paper type)',
      shortLabel: 'IPP media-col only',
      protocol: 'ipp',
      format: 'image/jpeg',
      withMedia: true,
      marginMm100: 0,
      quality: 0,
      mediaType: '',
      mediaTypeMode: 'none',
      scaling: ''
    },
    {
      id: 'ipp_minimal',
      label: 'IPP · Minimal JPEG (no job attributes)',
      shortLabel: 'IPP minimal JPEG',
      protocol: 'ipp',
      format: 'image/jpeg',
      withMedia: false,
      marginMm100: 0,
      quality: 0,
      mediaType: '',
      mediaTypeMode: 'none',
      scaling: ''
    },
    {
      id: 'escpr_l8050_720',
      label: 'ESC/P-R :9100 · L8050 High Glossy 720 dpi Borderless (0x34, q=2)',
      shortLabel: 'ESCPR :9100 720dpi 0x34 q=2 L8050-BL',
      protocol: 'escpr',
      port: 9100,
      dpi: 720,
      mediaCode: 0x34,
      qualityCode: 2,
      borderless: true,
      l8050Geo: true,
      sendSetiChku: true
    },
    {
      id: 'escpr_l8050_360',
      label: 'ESC/P-R :9100 · L8050 High Glossy 360 dpi Borderless (0x34, q=2)',
      shortLabel: 'ESCPR :9100 360dpi 0x34 q=2 L8050-BL',
      protocol: 'escpr',
      port: 9100,
      dpi: 360,
      mediaCode: 0x34,
      qualityCode: 2,
      borderless: true,
      l8050Geo: true,
      sendSetiChku: true
    },
    {
      id: 'escpr_l805_360',
      label: 'ESC/P-R :9100 · Standard L805 Borderless 360 dpi (0x0B, q=1)',
      shortLabel: 'ESCPR :9100 360dpi 0x0B q=1 L805-BL',
      protocol: 'escpr',
      port: 9100,
      dpi: 360,
      mediaCode: 0x0b,
      qualityCode: 1,
      borderless: true,
      l8050Geo: false,
      sendSetiChku: true
    }
  ];

  function hasNativeAndroid() {
    return !!(G.__PBNet && typeof G.__PBNet.diagRunProbe === 'function' && typeof G.__PBNet.diagRunPrint === 'function');
  }

  function hasDesktopHelper() {
    return !!(G.pb4u && G.pb4u.desktop && G.__PB && G.__PB.desktop);
  }

  function isAvailable() {
    return hasNativeAndroid() || hasDesktopHelper();
  }

  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return PRESETS[0];
  }

  function networkInfo() {
    if (G.__PBNet && typeof G.__PBNet.diagNetwork === 'function') {
      try { return JSON.parse(String(G.__PBNet.diagNetwork() || '{}')); } catch (e) { return null; }
    }
    return null;
  }

  function callNative(fnName, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var timer = setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('Diagnostic step timed out. Check printer Wi-Fi / Wi-Fi Direct connection.'));
        }
      }, timeoutMs || 95000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      try {
        G.__PBNet[fnName].apply(G.__PBNet, [id].concat(args));
      } catch (e) {
        delete pending[id];
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function runProbe(ip, cases) {
    if (hasNativeAndroid()) {
      return callNative('diagRunProbe', [String(ip || '').trim(), cases ? JSON.stringify(cases) : ''], 65000);
    }
    if (hasDesktopHelper()) {
      return fetch('/helper/printer/diag/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip: String(ip || '').trim(), cases: cases || null })
      }).then(function (r) { return r.json(); });
    }
    return Promise.reject(new Error('Wi-Fi diagnostic bridge not available in this app version.'));
  }

  function runPrint(payload) {
    if (hasNativeAndroid()) {
      return callNative('diagRunPrint', [JSON.stringify(payload || {})], 120000);
    }
    if (hasDesktopHelper()) {
      return fetch('/helper/printer/diag/print', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).then(function (r) { return r.json(); });
    }
    return Promise.reject(new Error('Wi-Fi diagnostic bridge not available in this app version.'));
  }

  /**
   * Builds a 1-sheet 300-dpi Sharpness + Borderless Ruler Calibration Target:
   *  - 1 mm ruler ticks (0..6 mm) along ALL 4 edges + corner brackets to measure borderless offset
   *  - 1 px / 2 px / 3 px horizontal & vertical hairline bars to expose Standard/Plain banding vs High/Glossy
   *  - Smooth CMYK / RGB / skin-tone gradient bars to verify 6-ink glossy color density
   *  - Stamped preset / IP / timestamp label so photos of test sheets never get mixed up
   */
  function buildCalibrationCanvas(wMm, hMm, title, subtitle, mk) {
    var sw = Math.min(Number(wMm) || 101.6, Number(hMm) || 152.4);
    var sh = Math.max(Number(wMm) || 101.6, Number(hMm) || 152.4);
    var dpi = 300;
    var ppm = dpi / 25.4;                             // ~11.811 px per mm
    var W = Math.round(sw * ppm);
    var H = Math.round(sh * ppm);
    var cv = mk ? mk() : document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    cv._pbDpi = dpi;
    var g = cv.getContext('2d');

    // Pure white base + subtle edge bleed tint (0..3 mm from edges) so any white border shows immediately
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    var edgeBand = Math.round(3 * ppm);
    g.fillStyle = '#e7eef8';
    g.fillRect(0, 0, W, edgeBand);
    g.fillRect(0, H - edgeBand, W, edgeBand);
    g.fillRect(0, 0, edgeBand, H);
    g.fillRect(W - edgeBand, 0, edgeBand, H);

    // Outer 0 mm hairline frame + 3 mm inner reference box
    g.strokeStyle = '#1b4999';
    g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);
    g.strokeStyle = '#8aa4cc';
    g.lineWidth = 1;
    g.strokeRect(edgeBand, edgeBand, W - 2 * edgeBand, H - 2 * edgeBand);

    // 1 mm ruler ticks (0..6 mm) centered on all 4 sides
    g.fillStyle = '#111111';
    g.strokeStyle = '#111111';
    var fontSmall = Math.max(18, Math.round(W * 0.017));
    var fontMed = Math.max(22, Math.round(W * 0.022));
    var fontBig = Math.max(30, Math.round(W * 0.032));
    g.font = '700 ' + fontSmall + 'px sans-serif';
    g.textBaseline = 'middle';

    function drawRulerTop() {
      var cx = Math.round(W * 0.5);
      for (var mm = 0; mm <= 6; mm++) {
        var y = Math.round(mm * ppm);
        var half = mm % 2 === 0 ? Math.round(9 * ppm) : Math.round(5 * ppm);
        g.lineWidth = mm === 0 ? 3 : 2;
        g.beginPath(); g.moveTo(cx - half, y); g.lineTo(cx + half, y); g.stroke();
        if (mm > 0 && mm % 2 === 0) {
          g.textAlign = 'left';
          g.fillText(mm + 'mm', cx + half + 6, y);
        }
      }
      g.textAlign = 'center';
      g.fillText('▲ TOP EDGE (0-6mm)', cx, Math.round(9.5 * ppm));
    }

    function drawRulerBottom() {
      var cx = Math.round(W * 0.5);
      for (var mm = 0; mm <= 6; mm++) {
        var y = H - Math.round(mm * ppm);
        var half = mm % 2 === 0 ? Math.round(9 * ppm) : Math.round(5 * ppm);
        g.lineWidth = mm === 0 ? 3 : 2;
        g.beginPath(); g.moveTo(cx - half, y); g.lineTo(cx + half, y); g.stroke();
        if (mm > 0 && mm % 2 === 0) {
          g.textAlign = 'left';
          g.fillText(mm + 'mm', cx + half + 6, y);
        }
      }
      g.textAlign = 'center';
      g.fillText('▼ BOTTOM EDGE (0-6mm)', cx, H - Math.round(9.5 * ppm));
    }

    function drawRulerLeft() {
      var cy = Math.round(H * 0.5);
      for (var mm = 0; mm <= 6; mm++) {
        var x = Math.round(mm * ppm);
        var half = mm % 2 === 0 ? Math.round(9 * ppm) : Math.round(5 * ppm);
        g.lineWidth = mm === 0 ? 3 : 2;
        g.beginPath(); g.moveTo(x, cy - half); g.lineTo(x, cy + half); g.stroke();
        if (mm > 0 && mm % 2 === 0) {
          g.textAlign = 'center';
          g.fillText(String(mm), x, cy + half + Math.round(2 * ppm));
        }
      }
      g.save();
      g.translate(Math.round(9.5 * ppm), cy);
      g.rotate(-Math.PI / 2);
      g.textAlign = 'center';
      g.fillText('◀ LEFT EDGE', 0, 0);
      g.restore();
    }

    function drawRulerRight() {
      var cy = Math.round(H * 0.5);
      for (var mm = 0; mm <= 6; mm++) {
        var x = W - Math.round(mm * ppm);
        var half = mm % 2 === 0 ? Math.round(9 * ppm) : Math.round(5 * ppm);
        g.lineWidth = mm === 0 ? 3 : 2;
        g.beginPath(); g.moveTo(x, cy - half); g.lineTo(x, cy + half); g.stroke();
        if (mm > 0 && mm % 2 === 0) {
          g.textAlign = 'center';
          g.fillText(String(mm), x, cy + half + Math.round(2 * ppm));
        }
      }
      g.save();
      g.translate(W - Math.round(9.5 * ppm), cy);
      g.rotate(Math.PI / 2);
      g.textAlign = 'center';
      g.fillText('RIGHT EDGE ▶', 0, 0);
      g.restore();
    }

    drawRulerTop();
    drawRulerBottom();
    drawRulerLeft();
    drawRulerRight();

    // Corner 4mm alignment L-brackets
    var cLen = Math.round(8 * ppm), cOff = Math.round(2 * ppm);
    g.strokeStyle = '#c22b2b';
    g.lineWidth = 3;
    var corners = [
      [cOff, cOff, 1, 1],
      [W - cOff, cOff, -1, 1],
      [cOff, H - cOff, 1, -1],
      [W - cOff, H - cOff, -1, -1]
    ];
    for (var ci = 0; ci < corners.length; ci++) {
      var cr = corners[ci];
      g.beginPath();
      g.moveTo(cr[0] + cr[2] * cLen, cr[1]);
      g.lineTo(cr[0], cr[1]);
      g.lineTo(cr[0], cr[1] + cr[3] * cLen);
      g.stroke();
    }

    // Center title & metadata stamp
    var padX = Math.round(14 * ppm);
    var boxW = W - 2 * padX;
    var yCur = Math.round(16 * ppm);
    g.fillStyle = '#111111';
    g.textAlign = 'center';
    g.font = '700 ' + fontBig + 'px sans-serif';
    g.fillText('photobooth4u · WI-FI PRINT TEST', W / 2, yCur);
    yCur += Math.round(5.5 * ppm);
    g.font = '700 ' + fontMed + 'px sans-serif';
    g.fillStyle = '#1b4999';
    g.fillText(String(title || 'Diagnostic Target'), W / 2, yCur);
    yCur += Math.round(4.5 * ppm);
    g.font = '500 ' + fontSmall + 'px sans-serif';
    g.fillStyle = '#444444';
    g.fillText(String(subtitle || (sw.toFixed(1) + ' x ' + sh.toFixed(1) + ' mm · 300 dpi')), W / 2, yCur);

    // Sharpness & Banding block (1px, 2px, 3px alternating lines + neutral gray smooth ramp)
    yCur += Math.round(6 * ppm);
    g.textAlign = 'left';
    g.fillStyle = '#222222';
    g.font = '700 ' + fontSmall + 'px sans-serif';
    g.fillText('SHARPNESS & BANDING CHECK (1px / 2px / 3px)', padX, yCur);
    yCur += Math.round(3 * ppm);
    var barH = Math.round(15 * ppm);
    var segW = Math.floor(boxW / 3) - 8;
    var pitches = [1, 2, 3];
    for (var pi = 0; pi < pitches.length; pi++) {
      var pitch = pitches[pi];
      var sx = padX + pi * (segW + 12);
      g.fillStyle = '#ffffff';
      g.fillRect(sx, yCur, segW, barH);
      g.fillStyle = '#000000';
      // Left half horizontal lines, right half vertical lines
      var halfW = Math.floor(segW / 2);
      for (var ry = 0; ry < barH; ry += pitch * 2) {
        g.fillRect(sx, yCur + ry, halfW - 2, pitch);
      }
      for (var rx = 0; rx < halfW - 2; rx += pitch * 2) {
        g.fillRect(sx + halfW + 2 + rx, yCur, pitch, barH);
      }
      g.strokeStyle = '#333333';
      g.lineWidth = 1;
      g.strokeRect(sx, yCur, segW, barH);
    }

    // Continuous grayscale + skin-tone + CMY gradient ramps (exposes glossy high-quality vs plain banding)
    yCur += barH + Math.round(7 * ppm);
    g.fillStyle = '#222222';
    g.fillText('GRADIENT & 6-INK DENSITY CHECK (check for banding lines)', padX, yCur);
    yCur += Math.round(3 * ppm);
    var ramps = [
      ['#000000', '#ffffff'],
      ['#2d1b12', '#f7d7c4'],
      ['#00aeef', '#ffffff'],
      ['#ec008c', '#ffffff'],
      ['#fff200', '#ffffff']
    ];
    var rampH = Math.round(7.5 * ppm);
    for (var ri = 0; ri < ramps.length; ri++) {
      var grd = g.createLinearGradient(padX, 0, padX + boxW, 0);
      grd.addColorStop(0, ramps[ri][0]);
      grd.addColorStop(1, ramps[ri][1]);
      g.fillStyle = grd;
      g.fillRect(padX, yCur, boxW, rampH);
      g.strokeStyle = '#888888';
      g.lineWidth = 1;
      g.strokeRect(padX, yCur, boxW, rampH);
      yCur += rampH + Math.round(2 * ppm);
    }

    // Solid color patches
    yCur += Math.round(3 * ppm);
    var cols = ['#00aeef', '#ec008c', '#fff200', '#111111', '#d92626', '#189c46', '#1f5cd1'];
    var swW = Math.floor((boxW - (cols.length - 1) * 8) / cols.length);
    var swH = Math.round(12 * ppm);
    for (var k = 0; k < cols.length; k++) {
      g.fillStyle = cols[k];
      g.fillRect(padX + k * (swW + 8), yCur, swW, swH);
      g.strokeStyle = '#222222';
      g.lineWidth = 1;
      g.strokeRect(padX + k * (swW + 8), yCur, swW, swH);
    }

    // Footer instruction
    yCur += swH + Math.round(7 * ppm);
    g.fillStyle = '#333333';
    g.textAlign = 'center';
    g.font = '600 ' + fontSmall + 'px sans-serif';
    g.fillText('Send a clear photo of all 4 edges + Copy report to support.', W / 2, yCur);
    return cv;
  }

  function formatReport(probeRes, printLog) {
    var lines = [];
    lines.push('=== photobooth4u Wi-Fi / Wi-Fi Direct Printer Diagnostic ===');
    lines.push('Time: ' + new Date().toISOString());
    var net = (probeRes && probeRes.network) || networkInfo();
    if (net) {
      lines.push('Platform: ' + (net.platform || '?') + ' · Device: ' + (net.device || '?') + ' · App: ' + (net.appVersion || '?'));
      var nlist = (net.nets || []).map(function (n) {
        return (n.iface || 'wifi') + '=' + n.ip + '/' + n.prefix + ' (gw ' + n.gateway + ', ' +
          (n.boundNetwork ? 'bound' : 'iface') + (n.wifiDirectHint ? ', Wi-Fi-Direct' : '') + ')';
      });
      lines.push('Interfaces: ' + (nlist.length ? nlist.join('; ') : '(none)'));
    }
    if (probeRes) {
      lines.push('Target IP: ' + (probeRes.ip || '?') + (probeRes.route ? ' · Route: ' + probeRes.route : ''));
      if (probeRes.error) lines.push('Probe error: ' + probeRes.error);
      if (probeRes.ports) {
        var ps = ['631', '9100', '515', '80'].map(function (k) {
          var p = probeRes.ports[k];
          if (!p) return k + ':?';
          return k + ':' + (p.open ? 'OPEN(' + p.ms + 'ms)' : 'closed');
        });
        lines.push('Ports: ' + ps.join('  '));
      }
      if (probeRes.ipp && probeRes.ipp.answered) {
        var ipp = probeRes.ipp;
        var a = ipp.attrs || {};
        lines.push('IPP path: ' + ipp.path + ' (' + ipp.ms + 'ms, ' + ipp.ippStatus + ', ' + ipp.attrCount + ' attrs, ' + ipp.bodyBytes + 'B)');
        lines.push('Model: ' + ((a['printer-make-and-model'] || [])[0] || '(none)') +
          ' · State: ' + ((a['printer-state'] || [])[0] || '?') +
          ' · Reasons: ' + ((a['printer-state-reasons'] || []).join(',') || 'none'));
        lines.push('Formats: ' + ((a['document-format-supported'] || []).join(', ') || '(none)'));
        lines.push('Qualities: ' + ((a['print-quality-supported'] || []).join(', ') || '(none)') +
          ' · Scaling: ' + ((a['print-scaling-supported'] || []).join(', ') || '(none)'));
        lines.push('Media types: ' + ((a['media-type-supported'] || []).join(', ') || '(none)'));
        lines.push('Margins (1/100mm): top=' + ((a['media-top-margin-supported'] || []).join(',') || '-') +
          ' left=' + ((a['media-left-margin-supported'] || []).join(',') || '-'));
        lines.push('Media ready: ' + ((a['media-ready'] || []).join(', ') || '(none)'));
        lines.push('Media-col-supported: ' + ((a['media-col-supported'] || []).join(', ') || '(none)'));
        if (ipp.mediaColDbCount > 0) {
          lines.push('media-col-database: ' + ipp.mediaColDbCount + ' entries; types=' + ((ipp.mediaColDbMediaTypes || []).join(',') || '(none)'));
          if (ipp.mediaColDb4x6Samples && ipp.mediaColDb4x6Samples.length) {
            lines.push('  4x6/0mm samples: ' + ipp.mediaColDb4x6Samples.join(' | '));
          }
        }
        if (a['pwg-raster-document-resolution-supported'] || a['urf-supported']) {
          lines.push('PWG res: ' + ((a['pwg-raster-document-resolution-supported'] || []).join(',') || '-') +
            ' · URF: ' + ((a['urf-supported'] || []).join(',') || '-'));
        }
      } else {
        lines.push('IPP: did not answer' + (probeRes.ipp && probeRes.ipp.error ? ' (' + probeRes.ipp.error + ')' : ''));
      }
      if (probeRes.validateMatrix && probeRes.validateMatrix.length) {
        lines.push('--- Validate-Job matrix (zero paper) ---');
        for (var i = 0; i < probeRes.validateMatrix.length; i++) {
          var v = probeRes.validateMatrix[i];
          var tag = v.clean ? 'CLEAN' : (v.ok ? 'WARN ' : 'FAIL ');
          var detail = v.error ? v.error : ('HTTP ' + v.http + ' ' + v.ippName + ' (' + v.ippHex + ')');
          if (v.unsupported && v.unsupported.length) detail += ' unsup=[' + v.unsupported.join(', ') + ']';
          if (v.statusMessage) detail += ' msg="' + v.statusMessage + '"';
          lines.push('  [' + tag + '] ' + v.id + ': ' + detail + ' (' + (v.ms || 0) + 'ms)');
        }
      }
      if (probeRes.recommendation) lines.push('Summary: ' + probeRes.recommendation);
    }
    if (printLog && printLog.length) {
      lines.push('--- Live 1-sheet print tests ---');
      for (var j = 0; j < printLog.length; j++) {
        var pr = printLog[j];
        var hdr = '  [' + (pr.ok ? 'OK  ' : 'FAIL') + '] ' + (pr.presetId || pr.protocol) + ' -> ';
        if (pr.protocol === 'escpr') {
          hdr += pr.ok
            ? ('sent ' + pr.bytes + 'B in ' + pr.sendMs + 'ms (build ' + pr.buildMs + 'ms, reply ' + pr.replyBytes + 'B) cfg=' + JSON.stringify(pr.config || {}))
            : ('error: ' + (pr.error || 'failed'));
        } else {
          hdr += pr.error
            ? ('error: ' + pr.error)
            : ('HTTP ' + pr.http + ' ' + pr.ippName + ' (' + pr.ippHex + ') jobId=' + pr.jobId + ' ' + pr.sendMs + 'ms');
          if (pr.unsupported && pr.unsupported.length) hdr += ' unsup=[' + pr.unsupported.join(', ') + ']';
          if (pr.jobStates && pr.jobStates.length) {
            hdr += ' states=[' + pr.jobStates.map(function (s) {
              return s.stateName + (s.reasons && s.reasons.length ? '(' + s.reasons.join(',') + ')' : '');
            }).join(' -> ') + ']';
          }
        }
        lines.push(hdr);
      }
    }
    return lines.join('\n');
  }

  function saveLastReport(text) {
    try { localStorage.setItem(STORAGE_KEY, String(text || '')); } catch (e) { }
  }

  function loadLastReport() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  G._wifiDiag = {
    PRESETS: PRESETS,
    getPreset: getPreset,
    isAvailable: isAvailable,
    networkInfo: networkInfo,
    runProbe: runProbe,
    runPrint: runPrint,
    buildCalibrationCanvas: buildCalibrationCanvas,
    formatReport: formatReport,
    saveLastReport: saveLastReport,
    loadLastReport: loadLastReport
  };
})(typeof window !== 'undefined' ? window : globalThis);
