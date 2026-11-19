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

      // ISO / shutter / aperture (and the rotation mark, 1 = upright) from the JPEG's EXIF block. null when not found.
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
              const ex = top[0x8769] ? ifd(top[0x8769], [0x829A, 0x829D, 0x8827]) : {};
              return { shutter: ex[0x829A] || 0, f: ex[0x829D] || 0, iso: ex[0x8827] || 0, orientation: top[0x0112] || 1 };
            }
            p += 2 + len;
          }
        } catch (e) { }
        return null;
      }
      function pbShutterText(s) { return !s ? '' : (s >= 0.5 ? (Math.round(s * 10) / 10) + ' s' : '1/' + Math.round(1 / s) + ' s'); }

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
