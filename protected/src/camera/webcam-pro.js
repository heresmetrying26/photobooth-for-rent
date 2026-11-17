      // ---- Webcam Pro: photo clean-up, multi-frame low-light stacking, live FPS warning, and hardware UVC controls ----
      // Works with any standard USB / built-in webcam (Logitech, Razer, Elgato, OBSBOT, Insta360, Anker, Surface, etc.).
      // Registers CAM_Q.webcam with is: () => false so DSLR brand detection (camQProfile) stays untouched; webcam shots are
      // tagged explicitly via webcamMarkShot(canvas) when clean-up is enabled.
      CAM_Q.webcam = camQMakeProfile({
        id: 'webcam',
        label: 'Webcam',
        is: function () { return false; },
        keys: { clean: 'pb_webcam_clean', tips: 'pb_webcam_tips', classic: 'pb_webcam_classic' },
        tune: { denoise: [20, 34], sharpen: [0.65, 0.95], page: [0.35, 0.5] }
      });

      const WEBCAM_STACK_KEY = 'pb_webcam_stack';
      const WEBCAM_FPS_WARN_KEY = 'pb_webcam_fps_warn';
      const WEBCAM_UVC_PREFIX = 'pb4u.webcamUvc.';
      const WEBCAM_UVC_DEF_PREFIX = 'pb4u.webcamUvcDef.';
      function webcamStackOn() { return camQStore(WEBCAM_STACK_KEY) !== '0'; }
      function webcamTipsOn() { return camQStore(WEBCAM_FPS_WARN_KEY) !== '0'; }

      function webcamMarkShot(canvas) {
        if (!canvas) return null;
        if (typeof USB_CAM_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === USB_CAM_ID) return null;
        const p = CAM_Q.webcam;
        if (!p || p.cleanMode() === 'off') return null;
        canvas._cq = p.id;
        return p;
      }

      // ---- 1. Multi-frame low-light temporal stacking (averages stationary noise across up to 2 recent frames) ----
      const webcamFrameRing = [];
      let webcamRingPool = null;
      let webcamRingNext = 0;
      let webcamLastRingAt = 0;

      function webcamEnsureRingPool() {
        if (webcamRingPool) return webcamRingPool;
        webcamRingPool = [0, 1].map(function () {
          const cv = document.createElement('canvas');
          const cx = cv.getContext('2d', { willReadFrequently: true });
          return { canvas: cv, ctx: cx, w: 0, h: 0, at: 0 };
        });
        return webcamRingPool;
      }

      function webcamPushFrame(v) {
        if (typeof state === 'undefined' || state !== 'capturing') return;
        if ((typeof IOS_APP !== 'undefined' && IOS_APP) || (typeof window !== 'undefined' && window.__PB && window.__PB.ios)) return;
        if (!webcamStackOn()) return;
        if (typeof USB_CAM_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === USB_CAM_ID) return;
        if (!v || !v.videoWidth || !v.videoHeight) return;
        const now = Date.now();
        if (now - webcamLastRingAt < 40) return;
        webcamLastRingAt = now;
        const pool = webcamEnsureRingPool();
        const slot = pool[webcamRingNext];
        webcamRingNext = (webcamRingNext + 1) % pool.length;
        const w = v.videoWidth, h = v.videoHeight;
        if (slot.canvas.width !== w || slot.canvas.height !== h) {
          slot.canvas.width = w;
          slot.canvas.height = h;
        }
        const sctx = slot.ctx;
        if (!sctx) return;
        if (typeof sctx.setTransform === 'function') sctx.setTransform(1, 0, 0, 1, 0, 0);
        if (typeof mirrorPreview === 'function' && mirrorPreview()) {
          sctx.translate(w, 0);
          sctx.scale(-1, 1);
        }
        sctx.drawImage(v, 0, 0, w, h);
        if (typeof sctx.setTransform === 'function') sctx.setTransform(1, 0, 0, 1, 0, 0);
        slot.w = w;
        slot.h = h;
        slot.at = now;
        if (webcamFrameRing.indexOf(slot) < 0) webcamFrameRing.push(slot);
        if (webcamFrameRing.length > 2) webcamFrameRing.shift();
      }

      // Pure pixel-blending kernel: blends recent frames onto stationary pixels (diff < 38) to cut grain,
      // while preserving 100% of moving pixels (diff >= 38) so guests never ghost.
      function webcamBlendFrames(curData, prevBuffers, w, h) {
        if (!curData || !prevBuffers || !prevBuffers.length || !w || !h) return false;
        const total = w * h * 4;
        const nBuf = prevBuffers.length;
        let blended = false;
        for (let p = 0; p < total; p += 4) {
          const r0 = curData[p], g0 = curData[p + 1], b0 = curData[p + 2];
          let wSum = 1, rSum = r0, gSum = g0, bSum = b0;
          for (let k = 0; k < nBuf; k++) {
            const pb = prevBuffers[k];
            if (!pb || pb.length < p + 3) continue;
            const pr = pb[p], pg = pb[p + 1], pbv = pb[p + 2];
            let dr = r0 - pr; if (dr < 0) dr = -dr;
            let dg = g0 - pg; if (dg < 0) dg = -dg;
            let db = b0 - pbv; if (db < 0) db = -db;
            const diff = dr + dg + db;
            if (diff < 38) {
              const wt = (1 - diff / 38) * 0.35;
              rSum += pr * wt;
              gSum += pg * wt;
              bSum += pbv * wt;
              wSum += wt;
            }
          }
          if (wSum > 1) {
            curData[p] = rSum / wSum;
            curData[p + 1] = gSum / wSum;
            curData[p + 2] = bSum / wSum;
            blended = true;
          }
        }
        return blended;
      }

      function webcamApplyStack(ctx, w, h) {
        if (!ctx || !w || !h || !webcamStackOn()) { webcamFrameRing.length = 0; return false; }
        if (typeof USB_CAM_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === USB_CAM_ID) {
          webcamFrameRing.length = 0;
          return false;
        }
        const now = Date.now();
        const fresh = webcamFrameRing.filter(function (s) {
          return s && s.w === w && s.h === h && (now - s.at) <= 250 && s.ctx;
        });
        if (!fresh.length) { webcamFrameRing.length = 0; return false; }
        try {
          const curImg = ctx.getImageData(0, 0, w, h);
          const prevBuffers = fresh.map(function (s) { return s.ctx.getImageData(0, 0, w, h).data; });
          const did = webcamBlendFrames(curImg.data, prevBuffers, w, h);
          if (did) ctx.putImageData(curImg, 0, 0);
          webcamFrameRing.length = 0;
          return did;
        } catch (e) {
          webcamFrameRing.length = 0;
          return false;
        }
      }

      // ---- 2. Live FPS measurement & low-light motion-blur warning ----
      let webcamLiveFps = 0;
      let webcamFpsSmooth = 0;
      let webcamLastRvfc = 0;
      let webcamLastFpsAt = 0;
      let webcamLowFpsStreak = 0;

      function webcamClearFpsWarning() {
        const el = document.getElementById('camQWarnNote');
        if (el && el.dataset && el.dataset.pbWebcamWarn === '1') {
          el.style.display = 'none';
          el.textContent = '';
          delete el.dataset.pbWebcamWarn;
        }
      }

      function webcamFpsTick() {
        const now = Date.now();
        const hasUsb = (typeof USB_CAM_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === USB_CAM_ID);
        const vEl = (typeof activeCamVideo === 'function' ? activeCamVideo() : null) || (typeof video !== 'undefined' ? video : null);
        const active = (typeof streamActive !== 'undefined' && streamActive)
          && !hasUsb
          && !document.hidden
          && !(typeof camSleeping !== 'undefined' && camSleeping)
          && !(typeof reconnectTimer !== 'undefined' && reconnectTimer)
          && vEl && !vEl.paused && vEl.videoWidth > 0;
        const curCount = typeof rvfcCount === 'number' ? rvfcCount : 0;
        if (!active) {
          webcamLastRvfc = curCount;
          webcamLastFpsAt = now;
          webcamLiveFps = 0;
          webcamFpsSmooth = 0;
          webcamLowFpsStreak = 0;
          webcamClearFpsWarning();
          return;
        }
        if (webcamLastFpsAt > 0 && curCount > 0) {
          const dt = (now - webcamLastFpsAt) / 1000;
          const df = curCount - webcamLastRvfc;
          if (dt >= 0.8 && df > 0) {
            const inst = df / dt;
            webcamFpsSmooth = webcamFpsSmooth ? (webcamFpsSmooth * 0.5 + inst * 0.5) : inst;
            webcamLiveFps = Math.max(1, Math.round(webcamFpsSmooth));
            if (webcamLiveFps < 18) {
              webcamLowFpsStreak++;
              if (webcamLowFpsStreak >= 3 && webcamTipsOn()) {
                const el = document.getElementById('camQWarnNote');
                if (el) {
                  el.textContent = '\u26A0 Low light detected (~' + webcamLiveFps + ' fps): webcam slowed its shutter for a dark room, so moving guests may blur. Add lighting, switch on Screen Flash, or lower Exposure in Webcam Controls.';
                  el.style.display = '';
                  el.dataset.pbWebcamWarn = '1';
                }
              }
            } else if (webcamLiveFps >= 20) {
              webcamLowFpsStreak = 0;
              webcamClearFpsWarning();
            }
          }
        }
        webcamLastRvfc = curCount;
        webcamLastFpsAt = now;
      }

      // ---- 3. Hardware UVC controls via MediaStreamTrack capabilities ----
      let webcamUvcDefaults = null;
      let webcamUvcTimer = null;
      let webcamUvcBusy = false;
      let webcamUvcPending = null;

      async function webcamFlushUvc(track) {
        if (webcamUvcBusy || !webcamUvcPending) return;
        webcamUvcBusy = true;
        try {
          while (webcamUvcPending) {
            const batch = webcamUvcPending;
            webcamUvcPending = null;
            await webcamApplyConstraintsObj(track, batch);
            const saved = webcamLoadUvc();
            Object.assign(saved, batch);
            webcamSaveUvc(saved);
          }
        } finally {
          webcamUvcBusy = false;
        }
      }

      function webcamCamKey() {
        const trk = (typeof currentStream !== 'undefined' && currentStream && currentStream.getVideoTracks) ? currentStream.getVideoTracks()[0] : null;
        const sel = (typeof cameraSelect !== 'undefined' && cameraSelect && cameraSelect.options) ? cameraSelect.options[cameraSelect.selectedIndex] : null;
        const lbl = (trk && trk.label) || (sel && sel.textContent) || (typeof currentDeviceId !== 'undefined' && currentDeviceId) || 'default';
        return String(lbl).toLowerCase().replace(/[^a-z0-9]+/g, '_');
      }

      function webcamLoadUvc(key) {
        try {
          const raw = localStorage.getItem(WEBCAM_UVC_PREFIX + (key || webcamCamKey()));
          return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
      }

      function webcamSaveUvc(obj, key) {
        try { localStorage.setItem(WEBCAM_UVC_PREFIX + (key || webcamCamKey()), JSON.stringify(obj || {})); } catch (e) { }
      }

      function webcamLoadUvcDef(key) {
        try {
          const raw = localStorage.getItem(WEBCAM_UVC_DEF_PREFIX + (key || webcamCamKey()));
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      }

      function webcamSaveUvcDef(obj, key) {
        try { localStorage.setItem(WEBCAM_UVC_DEF_PREFIX + (key || webcamCamKey()), JSON.stringify(obj || {})); } catch (e) { }
      }

      const WEBCAM_NUM_PROPS = ['focusDistance', 'brightness', 'exposureCompensation', 'contrast', 'colorTemperature', 'zoom'];

      function webcamNeutralDefaults(caps) {
        const def = {};
        if (Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') >= 0) def.focusMode = 'continuous';
        if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf('continuous') >= 0) def.whiteBalanceMode = 'continuous';
        WEBCAM_NUM_PROPS.forEach(function (k) {
          const cap = caps[k];
          if (!cap || typeof cap.min !== 'number' || typeof cap.max !== 'number' || cap.max <= cap.min) return;
          if (k === 'exposureCompensation' && cap.min <= 0 && cap.max >= 0) def[k] = 0;
          else if (k === 'zoom') def[k] = cap.min;
          else def[k] = Math.round(((cap.min + cap.max) / 2) * 100) / 100;
        });
        return def;
      }

      function webcamCaptureDefaults(caps, sets) {
        const def = webcamNeutralDefaults(caps);
        const minLockedBoth = !!(
          caps.brightness && caps.contrast &&
          typeof caps.brightness.min === 'number' && typeof caps.contrast.min === 'number' &&
          sets.brightness === caps.brightness.min && sets.contrast === caps.contrast.min
        );
        WEBCAM_NUM_PROPS.forEach(function (k) {
          const cap = caps[k];
          if (!cap || typeof cap.min !== 'number' || typeof cap.max !== 'number' || cap.max <= cap.min) return;
          if (minLockedBoth && (k === 'brightness' || k === 'contrast')) return;
          if (typeof sets[k] === 'number' && !isNaN(sets[k])) {
            def[k] = Math.max(cap.min, Math.min(cap.max, sets[k]));
          }
        });
        return def;
      }

      function webcamSanitizeApplyObj(caps, src) {
        const out = {};
        if (!src || !caps) return out;
        if (src.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.indexOf(src.focusMode) >= 0) {
          out.focusMode = src.focusMode;
        }
        if (src.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf(src.whiteBalanceMode) >= 0) {
          out.whiteBalanceMode = src.whiteBalanceMode;
        }
        WEBCAM_NUM_PROPS.forEach(function (k) {
          if (k === 'focusDistance' && out.focusMode === 'continuous') return;
          if (k === 'colorTemperature' && out.whiteBalanceMode === 'continuous') return;
          const cap = caps[k];
          const val = Number(src[k]);
          if (cap && typeof cap.min === 'number' && typeof cap.max === 'number' && cap.max > cap.min && !isNaN(val)) {
            out[k] = Math.max(cap.min, Math.min(cap.max, val));
          }
        });
        return out;
      }

      async function webcamApplyConstraintsObj(track, obj) {
        if (!track || typeof track.applyConstraints !== 'function' || !obj) return;
        const keys = Object.keys(obj);
        if (!keys.length) return;
        try {
          await track.applyConstraints({ advanced: [obj] });
        } catch (e) {
          // Some webcams reject multi-key advanced blocks when one property is read-only; apply one by one.
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i], single = {}; single[k] = obj[k];
            try { await track.applyConstraints({ advanced: [single] }); } catch (e2) { }
          }
        }
      }

      async function webcamOnStreamReady(stream) {
        webcamLiveFps = 0;
        webcamFpsSmooth = 0;
        webcamLastRvfc = typeof rvfcCount === 'number' ? rvfcCount : 0;
        webcamLastFpsAt = Date.now();
        webcamLowFpsStreak = 0;
        webcamFrameRing.length = 0;
        webcamClearFpsWarning();
        clearTimeout(webcamUvcTimer);
        webcamUvcPending = null;
        webcamUvcDefaults = null;

        const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
        if (track && typeof track.getCapabilities === 'function') {
          let caps = {}, sets = {};
          try { caps = track.getCapabilities() || {}; } catch (e) { caps = {}; }
          try { sets = (typeof track.getSettings === 'function' ? track.getSettings() : {}) || {}; } catch (e) { sets = {}; }
          const saved = webcamLoadUvc();
          const hasSaved = !!(saved && Object.keys(saved).length);
          const storedDef = webcamLoadUvcDef();
          if (storedDef && typeof storedDef === 'object' && Object.keys(storedDef).length) {
            const base = hasSaved ? webcamNeutralDefaults(caps) : webcamCaptureDefaults(caps, sets);
            // Replace any legacy poisoned baseline where both brightness & contrast were frozen at cap.min
            if (
              caps.brightness && caps.contrast &&
              storedDef.brightness === caps.brightness.min && storedDef.contrast === caps.contrast.min &&
              base.brightness !== caps.brightness.min && base.contrast !== caps.contrast.min
            ) {
              storedDef.brightness = base.brightness;
              storedDef.contrast = base.contrast;
              webcamSaveUvcDef(storedDef);
            }
            webcamUvcDefaults = Object.assign({}, base, storedDef);
          } else {
            webcamUvcDefaults = hasSaved ? webcamNeutralDefaults(caps) : webcamCaptureDefaults(caps, sets);
            webcamSaveUvcDef(webcamUvcDefaults);
          }
          const toApply = webcamSanitizeApplyObj(caps, saved);
          if (Object.keys(toApply).length) {
            await webcamApplyConstraintsObj(track, toApply);
          }
        }
        webcamSyncUvcUI();
      }

      async function webcamResetUvc() {
        clearTimeout(webcamUvcTimer);
        webcamUvcTimer = null;
        webcamUvcPending = null;
        const key = webcamCamKey();
        try { localStorage.removeItem(WEBCAM_UVC_PREFIX + key); } catch (e) { }
        const track = (typeof currentStream !== 'undefined' && currentStream && currentStream.getVideoTracks) ? currentStream.getVideoTracks()[0] : null;
        let caps = {};
        if (track && typeof track.getCapabilities === 'function') {
          try { caps = track.getCapabilities() || {}; } catch (e) { caps = {}; }
        }
        const def = Object.assign({}, webcamNeutralDefaults(caps), webcamUvcDefaults || webcamLoadUvcDef(key) || {});
        webcamUvcDefaults = def;
        const applyDef = webcamSanitizeApplyObj(caps, def);
        if (track && Object.keys(applyDef).length) {
          await webcamApplyConstraintsObj(track, applyDef);
        }
        webcamSyncUvcUI(def);
        if (typeof showToast === 'function') showToast('Webcam controls reset to defaults.', 2500);
      }

      function webcamQueueUvcApply(track, patch, delayMs) {
        webcamUvcPending = Object.assign(webcamUvcPending || {}, patch);
        clearTimeout(webcamUvcTimer);
        webcamUvcTimer = setTimeout(function () { webcamFlushUvc(track); }, delayMs || 0);
      }

      function webcamSyncUvcUI(forcedVals) {
        webcamBindStaticProUI();
        const box = document.getElementById('webcamUvcControls');
        const empty = document.getElementById('webcamUvcEmptyHint');
        const resetBtn = document.getElementById('webcamUvcResetBtn');
        if (!box) return;
        box.innerHTML = '';

        const hasUsb = (typeof USB_CAM_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === USB_CAM_ID);
        const isAndroidUvc = (typeof UVC_ID !== 'undefined' && typeof currentDeviceId !== 'undefined' && currentDeviceId === UVC_ID);
        const noCtrlMsg = isAndroidUvc
          ? 'Photo clean-up, low-light stacking and FPS monitoring are active for this USB webcam. (Focus and exposure are managed automatically by the tablet\u2019s USB video driver.)'
          : 'This camera does not expose focus or exposure sliders in this browser.';
        const track = (!hasUsb && typeof currentStream !== 'undefined' && currentStream && currentStream.getVideoTracks)
          ? currentStream.getVideoTracks()[0] : null;
        if (!track || typeof track.getCapabilities !== 'function') {
          if (empty) { empty.textContent = noCtrlMsg; empty.style.display = ''; }
          if (resetBtn) resetBtn.style.display = 'none';
          return;
        }

        let caps = {}, sets = {};
        try { caps = track.getCapabilities() || {}; } catch (e) { caps = {}; }
        try { sets = (typeof track.getSettings === 'function' ? track.getSettings() : {}) || {}; } catch (e) { sets = {}; }
        const saved = webcamLoadUvc();
        const fv = forcedVals && typeof forcedVals === 'object' ? forcedVals : null;
        let count = 0;

        function addToggle(label, checked, onChange) {
          count++;
          const row = document.createElement('label');
          row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; font-size:12px; color:var(--ink); cursor:pointer;';
          const span = document.createElement('span');
          span.textContent = label;
          const inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.checked = !!checked;
          inp.addEventListener('change', function () { onChange(inp.checked); });
          row.appendChild(span);
          row.appendChild(inp);
          box.appendChild(row);
          return inp;
        }

        function addSlider(prop, label, unit, onExtra) {
          const cap = caps[prop];
          if (!cap || typeof cap.min !== 'number' || typeof cap.max !== 'number' || cap.max <= cap.min) return null;
          count++;
          const step = (typeof cap.step === 'number' && cap.step > 0) ? cap.step : ((cap.max - cap.min) > 20 ? 1 : 0.1);
          const cur = (fv && typeof fv[prop] === 'number' && !isNaN(fv[prop])) ? fv[prop]
            : (typeof saved[prop] === 'number' && !isNaN(saved[prop])) ? saved[prop]
            : (typeof sets[prop] === 'number' && !isNaN(sets[prop])) ? sets[prop]
            : (prop === 'exposureCompensation' && cap.min <= 0 && cap.max >= 0) ? 0
            : (prop === 'zoom' ? cap.min : Math.round(((cap.min + cap.max) / 2) * 100) / 100);
          const fmt = function (v) {
            const n = Number(v);
            const txt = Math.abs(step) < 1 ? (Math.round(n * 100) / 100) : Math.round(n);
            return unit ? (txt + unit) : String(txt);
          };

          const wrap = document.createElement('div');
          wrap.style.cssText = 'margin-top:8px;';
          const head = document.createElement('div');
          head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--ink); margin-bottom:2px;';
          const lbl = document.createElement('span');
          lbl.textContent = label;
          const valSpan = document.createElement('span');
          valSpan.style.cssText = 'font-weight:700; font-variant-numeric:tabular-nums;';
          valSpan.textContent = fmt(cur);
          head.appendChild(lbl);
          head.appendChild(valSpan);

          const rng = document.createElement('input');
          rng.type = 'range';
          rng.min = String(cap.min);
          rng.max = String(cap.max);
          rng.step = String(step);
          rng.value = String(Math.max(cap.min, Math.min(cap.max, cur)));
          rng.style.cssText = 'width:100%; margin:0;';
          rng.addEventListener('input', function () {
            const v = Number(rng.value);
            valSpan.textContent = fmt(v);
            const patch = {}; patch[prop] = v;
            if (typeof onExtra === 'function') onExtra(patch);
            webcamQueueUvcApply(track, patch, 60);
          });
          rng.addEventListener('change', function () {
            const v = Number(rng.value);
            const patch = {}; patch[prop] = v;
            if (typeof onExtra === 'function') onExtra(patch);
            webcamQueueUvcApply(track, patch, 0);
          });
          wrap.appendChild(head);
          wrap.appendChild(rng);
          box.appendChild(wrap);
          return rng;
        }

        let lockFocusChk = null;
        if (Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') >= 0 && (caps.focusMode.indexOf('manual') >= 0 || caps.focusMode.indexOf('single-shot') >= 0)) {
          const manualMode = caps.focusMode.indexOf('manual') >= 0 ? 'manual' : 'single-shot';
          const curFocus = (fv && fv.focusMode) || saved.focusMode || sets.focusMode || 'continuous';
          lockFocusChk = addToggle('Lock Focus (stop autofocus hunting)', curFocus !== 'continuous', function (locked) {
            webcamQueueUvcApply(track, { focusMode: locked ? manualMode : 'continuous' }, 0);
          });
        }
        addSlider('focusDistance', 'Focus Distance', '', function (patch) {
          if (Array.isArray(caps.focusMode) && caps.focusMode.indexOf('manual') >= 0) {
            patch.focusMode = 'manual';
            if (lockFocusChk) lockFocusChk.checked = true;
          }
        });
        addSlider('brightness', 'Brightness', '');
        addSlider('exposureCompensation', 'Exposure', '');
        addSlider('contrast', 'Contrast', '');

        let autoWbChk = null;
        if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf('continuous') >= 0 && caps.whiteBalanceMode.indexOf('manual') >= 0) {
          const curWb = (fv && fv.whiteBalanceMode) || saved.whiteBalanceMode || sets.whiteBalanceMode || 'continuous';
          autoWbChk = addToggle('Auto White Balance', curWb === 'continuous', function (autoOn) {
            webcamQueueUvcApply(track, { whiteBalanceMode: autoOn ? 'continuous' : 'manual' }, 0);
          });
        }
        addSlider('colorTemperature', 'Color Temperature (Warmth)', ' K', function (patch) {
          if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.indexOf('manual') >= 0) {
            patch.whiteBalanceMode = 'manual';
            if (autoWbChk) autoWbChk.checked = false;
          }
        });
        addSlider('zoom', 'Zoom', 'x');

        if (empty) {
          empty.textContent = noCtrlMsg;
          empty.style.display = count ? 'none' : '';
        }
        if (resetBtn) resetBtn.style.display = count ? '' : 'none';
      }

      function webcamBindStaticProUI() {
        const cleanSel = document.getElementById('webcamCleanSel');
        if (cleanSel) {
          const stored = camQStore(CAM_Q.webcam.keys.clean);
          cleanSel.value = (stored === 'off' || stored === 'strong' || stored === 'auto') ? stored : CAM_Q.webcam.defaultClean;
          if (!cleanSel._pbBound) {
            cleanSel._pbBound = true;
            cleanSel.addEventListener('change', function () {
              camQSave(CAM_Q.webcam.keys.clean, cleanSel.value);
              if (Array.isArray(shotCanvases)) shotCanvases.forEach(function (s) { if (s) s._cqCache = null; });
              try { if (typeof state !== 'undefined' && state === 'result' && typeof renderComposite === 'function') renderComposite(); } catch (e) { }
            });
          }
        }
        const stackChk = document.getElementById('webcamStackToggle');
        if (stackChk) {
          stackChk.checked = webcamStackOn();
          if (!stackChk._pbBound) {
            stackChk._pbBound = true;
            stackChk.addEventListener('change', function () {
              camQSave(WEBCAM_STACK_KEY, stackChk.checked ? '1' : '0');
              if (!stackChk.checked) webcamFrameRing.length = 0;
            });
          }
        }
        const tipsChk = document.getElementById('webcamTipsToggle');
        if (tipsChk) {
          tipsChk.checked = webcamTipsOn();
          if (!tipsChk._pbBound) {
            tipsChk._pbBound = true;
            tipsChk.addEventListener('change', function () {
              camQSave(WEBCAM_FPS_WARN_KEY, tipsChk.checked ? '1' : '0');
              if (!tipsChk.checked) webcamClearFpsWarning();
            });
          }
        }
        const resetBtn = document.getElementById('webcamUvcResetBtn');
        if (resetBtn && !resetBtn._pbBound) {
          resetBtn._pbBound = true;
          resetBtn.addEventListener('click', function () { webcamResetUvc(); });
        }
      }
      webcamBindStaticProUI();
