      // ---- Photo quality for cameras over USB: the part every brand shares ----
      // A camera's photo (e.g. 24 MP, noisy at a high ISO) is shrunk into its box in halving steps (the browser's one-step shrink
      // skips pixels: grainy, jagged), then lightly denoised and sharpened at the size it is printed. The printed page gets a final
      // light sharpen (paper softens a picture).
      //
      // Each brand has its OWN profile in camera/brand-<name>.js (its settings keys, how strong the clean-up is, what it warns about).
      // To change how one brand's photos look, edit only that brand's file. Nothing here knows a brand's name.
      // A profile is made with camQMakeProfile({...}) and added to CAM_Q. The shot path (captureShot), the layout drawing and the
      // print step only ever call the camQ* functions below, with the profile of the camera that is connected right now.
      const CAM_Q = {};
      function camQProfile() { for (const id in CAM_Q) { try { if (CAM_Q[id].is()) return CAM_Q[id]; } catch (e) { } } return null; }
      function camQStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
      function camQSave(key, v) { try { localStorage.setItem(key, v); } catch (e) { } }
      // Default numbers: [auto, strong]. A brand overrides any of them in its own file.
      //   denoise: how much a pixel's brightness may differ from its neighbours and still be averaged with them
      //   sharpen: unsharp-mask amount for each box        page: the same, once more on the whole printed page
      const CAM_Q_TUNE = { denoise: [16, 30], sharpen: [0.6, 0.9], page: [0.35, 0.5] };
      function camQMakeProfile(o) {
        // isoClean / isoGrain: from the shot's EXIF ISO. Up to isoClean there is no grain worth removing (shrinking a big photo into its
        // box already averages the grain away), from isoGrain it is removed fully, in between lightly (see camQDenoiseFor).
        const p = Object.assign({ tooSlow: false, defaultClean: 'auto', isoWarn: 1600, isoClean: 1250, isoGrain: 3200, slowShutter: 1 / 60 }, o);
        p.tune = Object.assign({}, CAM_Q_TUNE, o.tune || {});
        p.classic = function () { return camQStore(p.keys.classic) === '1'; };
        p.tips = function () { return !p.classic() && camQStore(p.keys.tips) === '1'; };
        p.cleanMode = function () {
          if (p.tooSlow || p.classic()) return 'off';
          const v = camQStore(p.keys.clean);
          return (v === 'off' || v === 'strong' || v === 'auto') ? v : p.defaultClean;
        };
        return p;
      }

      // ISO / shutter / aperture / flash / exposure mode (and the rotation mark, 1 = upright) from the JPEG's EXIF block. null when not found.
      // flash = the camera's own EXIF Flash value (bit 0 = the flash fired), or -1 when the photo has no such record.
      // program = the EXIF ExposureProgram (1 manual, 2 program, 3 aperture priority, 4 shutter priority, 5-8 scene modes), 0 = not recorded.
      async function pbReadExif(blob) {
        try {
          const b = new Uint8Array(await blob.slice(0, 131072).arrayBuffer());
          if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
          let p = 2;
          while (p + 10 < b.length && b[p] === 0xFF) {
            const mk = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
            if (len < 2) break;
            if (mk === 0xE1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
              const t = p + 10, le = b[t] === 0x49;
              const u16 = function (o) { return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]); };
              const u32 = function (o) { return le ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0) : (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0); };
              const ifd = function (off, want) {
                const out = {}, n = u16(t + off);
                for (let k = 0; k < n; k++) {
                  const e = t + off + 2 + k * 12;
                  if (e + 12 > b.length) break;
                  const tag = u16(e), type = u16(e + 2);
                  if (want.indexOf(tag) < 0) continue;
                  if (type === 3) out[tag] = u16(e + 8);
                  else if (type === 4) out[tag] = u32(e + 8);
                  else if (type === 5) { const o = t + u32(e + 8), d = u32(o + 4); out[tag] = d ? u32(o) / d : 0; }
                }
                return out;
              };
              const top = ifd(u32(t + 4), [0x8769, 0x0112]);
              if (!top[0x8769] && !top[0x0112]) return null;
              const ex = top[0x8769] ? ifd(top[0x8769], [0x829A, 0x829D, 0x8827, 0x9209, 0x8822]) : {};
              return { shutter: ex[0x829A] || 0, f: ex[0x829D] || 0, iso: ex[0x8827] || 0, flash: ex[0x9209] === undefined ? -1 : ex[0x9209], program: ex[0x8822] || 0, orientation: top[0x0112] || 1 };
            }
            p += 2 + len;
          }
        } catch (e) { }
        return null;
      }
      function pbShutterText(s) { return !s ? '' : (s >= 0.5 ? (Math.round(s * 10) / 10) + ' s' : '1/' + Math.round(1 / s) + ' s'); }

      // What the camera itself recorded about its flash for this photo (EXIF Flash, bit 0 = fired). '' when the photo has no record.
      // Lets the operator tell "the flash fired but the room light was already enough" from "the camera never used its flash".
      function pbFlashText(ex) {
        if (!ex || typeof ex.flash !== 'number' || ex.flash < 0) return '';
        return (ex.flash & 1) ? 'Flash fired' : 'Flash did not fire';
      }
      // A flash photo taken faster than the camera can sync with a flash (most cameras: 1/160 to 1/250 s): the flash only lights part of the frame.
      // Manual strobes and wireless triggers do not set the EXIF flash bit, so when "Flash or strobe" is selected also check shutter vs sync.
      function pbFlashWarnings(ex, camName, light, profile) {
        const w = [];
        if (!ex || !(ex.shutter > 0)) return w;
        const fired = typeof ex.flash === 'number' && ex.flash >= 0 && (ex.flash & 1) === 1;
        if (!fired && light !== 'flash') return w;
        const p = profile || (camName && typeof camQProfile === 'function' ? camQProfile() : null);
        const sync = (p && p.guide && typeof p.guide.syncFor === 'function' && p.guide.syncFor(camName || '')) || (1 / 250);
        if (ex.shutter < sync - 1e-9) {
          w.push((fired ? 'The flash fired at ' : 'Flash or strobe mode with shutter ') + pbShutterText(ex.shutter) + ', faster than this camera can sync with a flash (' + pbShutterText(sync) + ' or slower), so the flash lights only part of the photo. Use a shutter of ' + pbShutterText(sync) + ' or slower (mode M or Tv).');
        }
        return w;
      }

      // ---- Camera check: what the camera is set to, against what suits the way the event is lit ----
      // The numbers are a starting point for a photobooth (guests 1 to 2 m away, moving a little, in a dim room), not a rule.
      // A brand changes any of them in its own profile (guide: { ... } in brand-<name>.js): the names of its exposure modes (modeNames),
      // the fastest shutter its flash can sync with (syncFor), where its mode dial is (modeHow) and what to do on that camera when the
      // flash did not fire (flashHow). ex = the numbers from pbReadExif (null before a test shot); light = 'flash' | 'steady' | 'room'.
      // shutter / slowest are exposure times in seconds; fMin / fMax and isoMax are the range that counts as fine.
      const CAM_GUIDE = {
        modeNames: ['', 'M', 'P', 'Av', 'Tv'],
        syncDefault: 1 / 200,
        light: {
          flash: { name: 'Flash or strobe', programs: [1], shutter: 1 / 160, slowest: 1 / 100, f: 5.6, fMin: 4, fMax: 11, iso: 400, isoMax: 800 },
          steady: { name: 'Steady lights', programs: [1], shutter: 1 / 125, slowest: 1 / 60, f: 4, fMin: 2.8, fMax: 8, iso: 800, isoMax: 1600 },
          room: { name: 'Room light only', programs: [3, 2], shutter: 1 / 60, slowest: 1 / 60, f: 4, fMin: 1, fMax: 5.6, iso: 1600, isoMax: 1600 }
        }
      };
      function camGuideModeName(g, program) {
        if (program >= 5 && program <= 8) return 'Scene';
        return (g.modeNames || CAM_GUIDE.modeNames)[program] || '';
      }
      function pbApertureText(f) { return f > 0 ? 'f/' + (Math.round(f * 10) / 10) : ''; }
      // The rows of the table: { key, label, current, suggested, status, how }. status: 'ok' | 'change' | 'info' | 'unknown'.
      // how = what to do about it, only for 'change'. Pure (no page access) so it can be tested.
      function camGuideRows(p, ex, light, camName) {
        const g = Object.assign({}, CAM_GUIDE, (p && p.guide) || {});
        const L = Object.assign({}, CAM_GUIDE.light[light] || CAM_GUIDE.light.flash, (g.light && g.light[light]) || {});
        const sync = (typeof g.syncFor === 'function' && g.syncFor(camName || '')) || g.syncDefault;
        const rows = [];
        const add = function (key, label, current, suggested, status, how) { rows.push({ key: key, label: label, current: current || '—', suggested: suggested, status: status, how: status === 'change' ? (how || '') : '' }); };
        // Mode (the dial on the camera: a program cannot change it)
        const wantMode = camGuideModeName(g, L.programs[0]);
        if (!(ex && ex.program)) add('mode', 'Mode', '', wantMode, 'unknown');
        else add('mode', 'Mode', camGuideModeName(g, ex.program), wantMode, L.programs.indexOf(ex.program) >= 0 ? 'ok' : 'change', (g.modeHow || 'Turn the mode dial on top of the camera to') + ' ' + wantMode + '.');
        // Shutter
        const wantShutter = Math.max(L.shutter, sync);
        if (!(ex && ex.shutter > 0)) add('shutter', 'Shutter', '', pbShutterText(wantShutter), 'unknown');
        else {
          const tooFast = light === 'flash' && ex.shutter < sync - 1e-9, tooSlow = ex.shutter > L.slowest + 1e-9;
          add('shutter', 'Shutter', pbShutterText(ex.shutter), pbShutterText(wantShutter), tooFast || tooSlow ? 'change' : 'ok',
            tooFast ? 'Faster than this camera can sync with a flash, so the flash lights only part of the photo. Use ' + pbShutterText(wantShutter) + ' or slower.'
              : light === 'flash' ? 'Slow for a flash photo: the room light adds blur and ghosting. Use ' + pbShutterText(wantShutter) + '.'
                : 'Slow: moving guests will blur. Use ' + pbShutterText(wantShutter) + ' or faster, and raise the ISO or add light.');
        }
        // Aperture
        if (!(ex && ex.f > 0)) add('aperture', 'Aperture', '', pbApertureText(L.f), 'unknown');
        else {
          const wide = ex.f < L.fMin - 0.05, narrow = ex.f > L.fMax + 0.05;
          add('aperture', 'Aperture', pbApertureText(ex.f), pbApertureText(L.f), wide || narrow ? 'change' : 'ok',
            wide ? 'Wide open: only part of a group will be sharp. Close it to ' + pbApertureText(L.f) + '.' : 'Closed down too far: little light reaches the camera. Open it to ' + pbApertureText(L.f) + '.');
        }
        // ISO
        if (!(ex && ex.iso > 0)) add('iso', 'ISO', '', String(L.iso), 'unknown');
        else add('iso', 'ISO', String(ex.iso), String(L.iso), ex.iso > L.isoMax ? 'change' : 'ok', 'Grain: ISO ' + ex.iso + ' is high. Add light or a flash so the camera can use ISO ' + L.iso + '.');
        // Flash: what the camera itself recorded for this photo
        const known = !!(ex && typeof ex.flash === 'number' && ex.flash >= 0), fired = known && (ex.flash & 1) === 1;
        if (!known) add('flash', 'Flash', '', light === 'flash' ? 'Fires' : 'Off', 'unknown');
        else if (light === 'flash') add('flash', 'Flash', fired ? 'Fired' : 'Did not fire', 'Fires', fired ? 'ok' : 'change', g.flashHow || 'Switch the flash on (raise the built-in flash, or turn on the flash on the hot shoe) and set it to automatic (TTL) flash.');
        else add('flash', 'Flash', fired ? 'Fired' : 'Off', 'Off', fired ? 'info' : 'ok');
        // The suggestion as a number, for the Apply button: shutter in seconds, aperture as the f-number, ISO.
        const wants = { shutter: wantShutter, aperture: L.f, iso: L.iso };
        rows.forEach(function (r) { if (wants[r.key]) r.want = wants[r.key]; });
        return rows;
      }
      // One line above the table, or ''.
      function camGuideNote(light, ex) {
        if (light === 'room') return 'Room light only: at an event a flash or steady lights are highly recommended.';
        if (!ex) return 'Take a test shot to read the camera’s settings.';
        return '';
      }

      // The "Camera check" card in the Camera step (#camGuide): lighting chips, the Current / Suggested table, and what to change.
      // camGuideEx = the numbers of the latest photo the camera took (a test shot or a session shot); null until there is one.
      var camGuideEx = null;
      function camGuideLight() { const v = camQStore('pb_cam_light'); return v === 'steady' || v === 'room' ? v : 'flash'; }
      function camGuideSetExif(ex) { camGuideEx = ex || null; try { camGuideRender(); } catch (e) { } }
      function camGuideRender() {
        const box = document.getElementById('camGuide'), tb = document.getElementById('camGuideRows');
        if (!box || !tb) return;
        const rb = document.getElementById('camGuideReadBtn'), ab = document.getElementById('camGuideApplyBtn');
        if (rb && !rb._pbBound) { rb._pbBound = true; rb.addEventListener('click', function () { camGuideMsg('Reading the camera…'); camGuideProbe().then(function () { camGuideMsg(camGuideCan ? '' : 'This camera cannot be read from here: take a test shot instead.'); }); }); }
        if (ab && !ab._pbBound) { ab._pbBound = true; ab.addEventListener('click', function () { camGuideApply(); }); }
        const light = camGuideLight(), p = camQProfile();
        box.querySelectorAll('[data-light]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.light === light);
          if (!b._pbBound) { b._pbBound = true; b.addEventListener('click', function () { camQSave('pb_cam_light', b.dataset.light); camGuideRender(); }); }
        });
        const rows = camGuideRows(p, camGuideEx, light, (typeof usbCam !== 'undefined' && usbCam && usbCam.name) || '');
        const colour = { ok: '#1d6f45', change: '#b3261e', info: '#1f5fa8', unknown: 'var(--ink-dim)' };
        const mark = { ok: '✓ ', change: '⚠ ', info: '', unknown: '' };
        tb.textContent = '';
        rows.forEach(function (r) {
          const tr = document.createElement('tr');
          [r.label, mark[r.status] + r.current, r.suggested].forEach(function (t, i) {
            const td = document.createElement('td');
            td.textContent = t;
            td.style.cssText = 'padding:4px 6px; border-top:1px solid var(--line);' + (i === 0 ? 'font-weight:700;' : '') + (i === 1 ? 'font-weight:700; color:' + colour[r.status] + ';' : '');
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        const how = document.getElementById('camGuideHow');
        if (how) {
          how.textContent = '';
          rows.filter(function (r) { return r.how; }).forEach(function (r) { const d = document.createElement('div'); d.textContent = '⚠ ' + r.label + ': ' + r.how; how.appendChild(d); });
          how.style.display = how.firstChild ? 'block' : 'none';
        }
        const note = document.getElementById('camGuideNote'), nt = camGuideNote(light, camGuideEx);
        if (note) { note.textContent = nt; note.style.display = nt ? 'block' : 'none'; }
        try { if (p && typeof p.onGuideRender === 'function') p.onGuideRender(light); } catch (e) { }
      }

      // "Read from camera" and "Apply suggested settings": only where the camera program can read and set the camera's shutter, aperture
      // and ISO (the Windows and Android camera programs for the cameras they support; for any other camera they answer "not
      // supported" and the two buttons stay hidden). Apply sets those three numbers inside the mode the camera is in. The mode is the
      // dial on the camera: it is never changed. A setting the camera will not take is reported, never forced.
      var camGuideCan = false;
      function camGuideCamera() { return (typeof usbCam !== 'undefined' && usbCam && usbCam.camera && typeof usbCam.camera.getExposure === 'function') ? usbCam.camera : null; }
      function camGuideMsg(t) { const e = document.getElementById('camGuideApplyMsg'); if (e) { e.textContent = t || ''; e.style.display = t ? 'block' : 'none'; } }
      function camGuideApplyUi() { const r = document.getElementById('camGuideApplyRow'); if (r) r.style.display = camGuideCan ? 'block' : 'none'; }
      // A camera reports its shutter as a count of 0.0001 s (1/160 s comes as 0.0063): show the speed its dial calls it (1/160, not 1/159).
      const PB_SHUTTERS = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4];
      function pbSnapShutter(s) {
        if (!(s > 0) || s >= 0.3) return s || 0;   // 1/3 s and slower: the number already is what the dial shows
        let best = s, bd = Infinity;
        PB_SHUTTERS.forEach(function (n) { const d = Math.abs(Math.log(1 / n) - Math.log(s)); if (d < bd) { bd = d; best = 1 / n; } });
        return best;
      }
      // The camera's own numbers become the table's "Current". Whether the flash fired is only known from a photo: kept from the last one.
      function camGuideTake(j) {
        camGuideEx = { program: j.program || 0, shutter: pbSnapShutter(j.shutter || 0), f: j.f || 0, iso: j.iso || 0, flash: camGuideEx && typeof camGuideEx.flash === 'number' ? camGuideEx.flash : -1 };
        camGuideRender();
      }
      // Asked once when the camera connects (and by "Read from camera"): can this camera be read and set from here?
      async function camGuideProbe() {
        const cam = camGuideCamera();
        camGuideCan = false;
        if (cam) { try { const j = await cam.getExposure(); if (j) { camGuideCan = true; camGuideTake(j); } } catch (e) { } }
        camGuideApplyUi();
      }
      async function camGuideApply() {
        const cam = camGuideCamera();
        if (!cam) return;
        const rows = camGuideRows(camQProfile(), camGuideEx, camGuideLight(), (usbCam && usbCam.name) || '');
        const want = {};
        rows.forEach(function (r) { if (r.want && r.status === 'change') want[r.key === 'aperture' ? 'f' : r.key] = r.want; });
        if (!Object.keys(want).length) { camGuideMsg(camGuideEx ? 'Nothing to change: the settings already match.' : 'Take a test shot or press Read from camera first.'); return; }
        camGuideMsg('Setting the camera…');
        let j = null;
        try { j = await cam.setExposure(want); } catch (e) { camGuideMsg('The camera did not answer. Change the settings on the camera instead.'); return; }
        if (!j || j.supported === false) { camGuideMsg('This camera cannot be set from here. Change the settings on the camera instead.'); return; }
        const names = { shutter: 'Shutter', f: 'Aperture', iso: 'ISO' }, notDone = [];
        Object.keys(j.results || {}).forEach(function (k) {
          const s = j.results[k];
          if (s === 'locked') notDone.push(names[k] + ' is set by the camera in its current mode (turn the mode dial to the suggested mode first)');
          else if (s === 'refused' || s === 'unsupported') notDone.push(names[k] + ' was not accepted: change it on the camera');
        });
        camGuideTake(j);
        camGuideMsg(notDone.length ? 'Done, except: ' + notDone.join('; ') + '.' : 'Done. The camera now shows the suggested settings.');
      }

      // What to tell the operator about a photo: grain, motion blur, no focus lock. A brand can add its own lines (p.extraWarnings).
      function camQWarnings(p, ex, focusMiss) {
        const w = [];
        if (focusMiss) w.push(p.focusMissText || 'The camera could not lock focus on this photo. Check the lens switch is on AF, add light, and point at something with detail.');
        if (ex && ex.iso >= p.isoWarn) w.push('ISO ' + ex.iso + ' adds visible grain. Add light, use the flash, or open the aperture, so the camera can use a lower ISO.');
        if (ex && ex.shutter > p.slowShutter) w.push('Shutter ' + pbShutterText(ex.shutter) + ' is slow: moving guests will blur. Add light or flash, or allow a higher ISO.');
        if (typeof p.extraWarnings === 'function') { try { p.extraWarnings(ex, focusMiss).forEach(function (t) { w.push(t); }); } catch (e) { } }
        return w;
      }

      // Edge-preserving denoise (3x3, weights fall off with the brightness difference) then a fine unsharp mask, in place.
      // d = RGBA bytes. tune = { denoise: [auto, strong], sharpen: [auto, strong] } (see CAM_Q_TUNE).
      function pbCleanPixels(d, w, h, mode, denoise, tune) {
        tune = tune || CAM_Q_TUNE;
        const strong = mode === 'strong', n = w * h, si = strong ? 1 : 0;
        const amt = tune.sharpen[si];
        let src = d;
        if (denoise) {
          const T = Math.max(1, tune.denoise[si]), inv = 1 / (T * T), lum = new Uint8Array(n);
          for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
          src = new Uint8ClampedArray(d.length); src.set(d);
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const i = y * w + x, l0 = lum[i]; let sr = 0, sg = 0, sb = 0, sw = 0;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const j = i + dy * w + dx, df = lum[j] - l0, wt = 1 / (1 + df * df * inv), q = j * 4;
                  sr += d[q] * wt; sg += d[q + 1] * wt; sb += d[q + 2] * wt; sw += wt;
                }
              }
              const p = i * 4; src[p] = sr / sw; src[p + 1] = sg / sw; src[p + 2] = sb / sw;
            }
          }
        }
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const p = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
              const o = p + c, m = (src[o - 4 - w * 4] + src[o - w * 4] + src[o + 4 - w * 4] + src[o - 4] + src[o] + src[o + 4] + src[o - 4 + w * 4] + src[o + w * 4] + src[o + 4 + w * 4]) / 9;
              d[o] = src[o] + amt * (src[o] - m);   // Uint8ClampedArray clamps + rounds
            }
          }
        }
      }
      function pbSharpenPage(d, w, h, amt) {
        const src = new Uint8ClampedArray(d.length); src.set(d);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const p = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
              const o = p + c, m = (src[o - 4 - w * 4] + src[o - w * 4] + src[o + 4 - w * 4] + src[o - 4] + src[o] + src[o + 4] + src[o - 4 + w * 4] + src[o + w * 4] + src[o + 4 + w * 4]) / 9;
              d[o] = src[o] + amt * (src[o] - m);
            }
          }
        }
      }

      // How much grain removal a shot gets: 0 none, 1 full, in between light. The grain average blends a pixel with its neighbours
      // whenever they look alike, and real fine detail of low contrast (skin pores, eyelashes, hair) looks alike too: measured
      // on a +-8 level texture at print size, the average kept 7-48% of the detail, against 65-95% for a plain shrink. That is
      // why a clean photo was sharp on its own but soft inside a frame. A low-ISO photo has no grain worth that, so it is only
      // sharpened; grain removal comes in lightly, then fully, as the ISO climbs. Strong (dim rooms) always removes it fully.
      // A shot with no EXIF ISO (a webcam) is left as before.
      function camQDenoiseFor(p, img, mode) {
        if (mode === 'strong') return 1;
        const iso = img && img._cqIso;
        if (!(iso > 0)) return 1;
        if (iso <= p.isoClean) return 0;
        if (iso < p.isoGrain) return 0.6;
        return 1;
      }

      // The part of a photo that goes in one box, shrunk to the box's own pixel size (halving steps) and cleaned. Cached per shot.
      // Returns null when the photo should be drawn the ordinary way (classic mode, or nothing to gain).
      function camQTile(p, ctx, img, sx, sy, sw, sh, w, h) {
        if (p.classic()) return null;
        const mode = p.cleanMode();
        let k = 1; try { const m = ctx.getTransform(); k = Math.hypot(m.a, m.b) || 1; } catch (e) { }
        const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
        const ratio = Math.max(sw / tw, sh / th);
        if (ratio < 1.5 && mode === 'off') return null;
        const dk = camQDenoiseFor(p, img, mode);
        const key = [Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), tw, th, mode, dk].join(',');
        const cache = img._cqCache || (img._cqCache = new Map());
        if (cache.has(key)) return cache.get(key);
        let cur = img, cx = sx, cy = sy, cw = sw, ch = sh;
        while (cw > tw * 2 || ch > th * 2) {
          const nw = Math.max(tw, Math.ceil(cw / 2)), nh = Math.max(th, Math.ceil(ch / 2));
          const t = document.createElement('canvas'); t.width = nw; t.height = nh;
          const tx = t.getContext('2d'); tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = 'high';
          tx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
          cur = t; cx = 0; cy = 0; cw = nw; ch = nh;
        }
        const out = document.createElement('canvas'); out.width = tw; out.height = th;
        const ox = out.getContext('2d', { willReadFrequently: true }); ox.imageSmoothingEnabled = true; ox.imageSmoothingQuality = 'high';
        ox.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
        // Bigger output (2x) makes boxes bigger, so the cap is higher on a laptop (higher still when it only sharpens, which is
        // about twice as quick as the grain pass); a tablet's CPU keeps the lower one.
        const cqMax = (typeof DESKTOP !== 'undefined' && DESKTOP) ? (dk === 0 ? 10000000 : 6000000) : 4500000;
        if (mode !== 'off' && tw * th <= cqMax && tw > 8 && th > 8) {
          try {
            const c0 = performance.now(), id = ox.getImageData(0, 0, tw, th);
            // Grain is only removed when the photo was shrunk (or is 1:1) and the box is small enough for it to be quick. An
            // enlarged photo has no grain to remove (the average would only soften it) and a huge box makes the clean-up slow.
            // Sharpening runs in every case: it is what makes a photo look crisp on paper.
            const tune = dk === 1 ? p.tune : Object.assign({}, p.tune, { denoise: p.tune.denoise.map(function (v) { return v * dk; }) });
            pbCleanPixels(id.data, tw, th, mode, dk > 0 && ratio >= 1 && tw * th <= 2600000, tune); ox.putImageData(id, 0, 0);
            const ms = Math.round(performance.now() - c0);
            // A laptop too slow for the clean-up (one box taking over 1.5 s) drops it for the rest of the session, so guests never
            // wait; the stepwise shrink stays. Logged in the camera log; the Camera menu note says so.
            if (ms > 1500 && !p.tooSlow) {
              p.tooSlow = true;
              try { usbLog(p.id + '-clean-slow', { ms: ms, w: tw, h: th }); } catch (e2) { }
              const el = document.getElementById('camQWarnNote');
              if (el) { el.textContent = '⚠ Photo clean-up is too slow on this computer (' + ms + ' ms for one photo), so it is switched off for now. Photos still print sharp.'; el.style.display = ''; }
            }
          } catch (e) { }
        }
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(key, out);
        return out;
      }

      // Printed page: a last light sharpen when the page holds a photo from one of these cameras.
      function camQPrintSharpen(c) {
        if (!c || c._pbSharp || c.width < 900 || c.height < 900 || c.width * c.height > 16000000) return;
        if (!Array.isArray(shotCanvases)) return;
        const shot = shotCanvases.find(function (s) { return s && s._cq && CAM_Q[s._cq]; });
        if (!shot) return;
        const p = CAM_Q[shot._cq], mode = p.cleanMode();
        if (mode === 'off') return;
        c._pbSharp = true;
        const ctx = c.getContext('2d'), id = ctx.getImageData(0, 0, c.width, c.height);
        pbSharpenPage(id.data, c.width, c.height, p.tune.page[mode === 'strong' ? 1 : 0]);
        ctx.putImageData(id, 0, 0);
      }

      // During a session the warning goes to the operator only (Camera menu + camera log), never onto the guest's screen.
      async function camQShotNote(p, file, canvas, prefetchedEx) {
        try {
          const ex = prefetchedEx !== undefined ? prefetchedEx : await pbReadExif(file);
          const w = camQWarnings(p, ex, !!(file && file._focusMiss));
          try {
            const camName = (typeof usbCam !== 'undefined' && usbCam && usbCam.name) || '';
            pbFlashWarnings(ex, camName, camGuideLight(), p).forEach(function (t) { w.push(t); });
          } catch (e) { }
          // The ISO decides how much grain removal this photo gets (camQDenoiseFor); a box or preview drawn before it was known is drawn again.
          if (canvas && ex && ex.iso > 0 && canvas._cqIso !== ex.iso) {
            canvas._cqIso = ex.iso;
            canvas._cqCache = null;
            try { if (typeof previewCanvas !== 'undefined' && previewCanvas) previewCanvas._renderedForLayout = ''; } catch (e) { }
          }
          usbLog(p.id + '-shot', { iso: ex && ex.iso, shutter: ex && ex.shutter, f: ex && ex.f, focusMiss: !!(file && file._focusMiss) });
          const el = document.getElementById('camQWarnNote');
          if (el && p.tips()) {
            if (w.length) { el.textContent = '⚠ Last photo: ' + w.join(' '); el.style.display = ''; }
            else el.style.display = 'none';
          }
        } catch (e) { }
      }

      // Between photos the layout is drawn once off-screen, so each photo's clean-up (cached) is done while the guests pose
      // for the next one, not while the result screen waits. The last photo is left: the result screen draws it right away.
      function camQPrewarm(p, finalShot) {
        if (finalShot || !p || p.cleanMode() === 'off') return;
        setTimeout(function () {
          try {
            if (!Array.isArray(shotCanvases) || !shotCanvases.some(function (s) { return s && s._cq === p.id; })) return;
            const t0 = performance.now(), cv = document.createElement('canvas');
            cv._hiRes = true;
            composeCanvas(currentLayout, cv, shotCanvases);
            usbLog(p.id + '-prewarm', { ms: Math.round(performance.now() - t0), w: cv.width, h: cv.height });
          } catch (e) { }
        }, 120);
      }

      // The shot path calls this once per photo: marks the canvas so the layout drawing and the print step know whose profile applies.
      function camQOnShot(file, canvas, prefetchedEx) {
        const p = camQProfile();
        if (!p) return null;
        canvas._cq = p.id;
        if (prefetchedEx && prefetchedEx.iso > 0) { canvas._cqIso = prefetchedEx.iso; canvas._cqCache = null; }
        camQShotNote(p, file, canvas, prefetchedEx);   // warned about ISO / shutter / focus (operator only); the ISO is kept on the shot
        return p;
      }

      // The "<Brand> photo options" box in the Camera menu: shown only while that brand is connected.
      function camQUiSync() {
        try { camGuideRender(); } catch (e) { }   // the Camera check card follows the connected camera too
        try { camGuideProbe(); } catch (e) { }    // and finds out once whether this camera can be read and set from here
        const row = document.getElementById('camQRow'), sel = document.getElementById('camQCleanSel');
        if (!row || !sel) return;
        const p = camQProfile();
        row.style.display = p ? '' : 'none';
        if (!p) return;
        const set = function (id, text) { const e = document.getElementById(id); if (e) e.textContent = text; };
        set('camQTitle', p.label + ' photo options');
        set('camQCleanHint', 'Reduces grain and sharpens ' + p.label + ' photos at the size they are printed. Auto suits most events; Strong is for dim rooms (it can soften skin).');
        set('camQTipsName', 'Show ' + p.label + ' photo tips');
        set('camQClassicName', 'Classic ' + p.label + ' behaviour');
        set('camQClassicHint', p.classicHint || ('Turns all the ' + p.label + ' photo improvements off (clean-up and sharper shrink) and goes back to how the photos looked before. Use it if shots look different or feel slower.'));
        const tips = document.getElementById('camQTipsChk'), classic = document.getElementById('camQClassicChk');
        const stored = camQStore(p.keys.clean);
        sel.value = (stored === 'off' || stored === 'strong' || stored === 'auto') ? stored : p.defaultClean;
        if (tips) tips.checked = camQStore(p.keys.tips) === '1';
        if (classic) classic.checked = p.classic();
        const redraw = function () {
          if (Array.isArray(shotCanvases)) shotCanvases.forEach(function (s) { if (s) s._cqCache = null; });
          try { if (state === 'result') renderComposite(); } catch (e) { }
        };
        if (!sel._pbBound) {
          sel._pbBound = true;
          sel.addEventListener('change', function () { const q = camQProfile(); if (!q) return; camQSave(q.keys.clean, sel.value); redraw(); });
          if (tips) tips.addEventListener('change', function () {
            const q = camQProfile(); if (!q) return;
            camQSave(q.keys.tips, tips.checked ? '1' : '0');
            if (!tips.checked) { const n = document.getElementById('camQWarnNote'); if (n) n.style.display = 'none'; }
          });
          if (classic) classic.addEventListener('change', function () {
            const q = camQProfile(); if (!q) return;
            camQSave(q.keys.classic, classic.checked ? '1' : '0');
            q.tooSlow = false; redraw();
            try { usbLog(q.id + '-classic', { on: classic.checked }); } catch (e) { }
            showToast(classic.checked ? (q.classicOnToast || ('Classic ' + q.label + ' behaviour on: photos look as before.')) : q.label + ' photo improvements on.', 4000);
          });
        }
      }
