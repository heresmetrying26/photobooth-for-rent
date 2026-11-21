      // ---- Canon photo quality (Canon EOS only). Everything Canon-specific about the photo is in this file. ----
      // Same pipeline as the other brands (see photo-quality.js): shrink in halving steps, light clean-up, print sharpen.
      // Settings (Camera menu -> Canon photo options): clean-up Off / Auto / Strong, photo tips, "Classic Canon behaviour".
      // Canon's camera-side settings are left as the camera has them (RAW + JPEG: the JPEG is used). The shutter timing for older
      // EOS bodies (60D) is NOT here: it is usbShutterLead / USB_LEAD_CANON_MAX in the shot timing code.
      // To change only how Canon photos look, change the numbers in tune below.
      CAM_Q.canon = camQMakeProfile({
        id: 'canon', label: 'Canon',
        is: function () { return camIsCanon(); },
        keys: { clean: 'pb_canon_clean', tips: 'pb_canon_tips', classic: 'pb_canon_classic' },
        // Starts with the same numbers as the other brands. NOT yet tuned on real Canon photos: compare a test shot with the
        // clean-up Off and Auto, then change the numbers here (each is [auto, strong]).
        tune: { denoise: [16, 30], sharpen: [0.6, 0.9], page: [0.35, 0.5] },
        focusMissText: 'The camera could not lock focus on this photo. Check the lens switch is on AF, add light, and point at something with detail.',
        // Camera check (see CAM_GUIDE in photo-quality.js): Canon's mode names, the fastest shutter its flash syncs with, and flash advice.
        // Flash sync: 60D 1/250 s, 6D and 6D Mark II 1/180 s, most other EOS 1/200 s. In live view a flash needs Silent LV shoot and
        // Exposure simulation switched off (the booth keeps live view on until the shutter).
        guide: {
          modeNames: ['', 'M', 'P', 'Av', 'Tv'],
          modeHow: 'Turn the mode dial on top of the camera to',
          syncFor: function (name) { return /\b60D\b/i.test(name) ? 1 / 250 : /\b6D\b/i.test(name) ? 1 / 180 : 1 / 200; },
          flashHow: 'Using a Canon Speedlite: raise the built-in flash (60D) or turn the Speedlite on (E-TTL) and set Flash firing to Enable. Using a manual flash, studio strobe or wireless trigger (normal for EXIF to say "Did not fire"): in the camera menu set Silent LV shoot (Silent shoot. on 60D) to Disable — Mode 1 or 2 makes external flashes fire with no effect on the photo — set Exposure simulation to Disable, and keep shutter at 1/160 s or slower in M mode (set optical slave strobes to S2 or flash to M).'
        },
        onGuideRender: function () { try { if (typeof canonGuideRefresh === 'function') canonGuideRefresh(); } catch (e) { } }
      });

      // ---- Canon guide for the operator ----
      // What the booth tells the operator when a Canon does not give its photo at the flash, does not take the photo, or is set to flash.
      // The camera program (the Windows laptop app) reports focusInShot, noAfOff, toCard, olderCanon, lensMf (see ListJson in camera-worker.ps1).
      // canonGuideFrom turns them into short tips. These two functions touch nothing on the page, so scripts/test-canon-guide.mjs runs them on their own.
      // canon-guide:start
      function canonGuideFrom(st) {
        var out = [];
        if (!st) return out;
        if (!st.lensMf) {
          if (st.noAfOff) {
            out.push({ id: 'noaf', text: 'This Canon gave no photo when asked to skip focusing, so it now focuses inside each shot and the photo comes after the flash. Slide the switch on the lens from AF to MF and focus once on the spot where guests stand: then the photo is taken right on the flash.' });
          } else if (st.olderCanon && (!st.lagMs || st.lagMs >= 700)) {
            out.push({ id: 'older', text: 'This Canon focuses inside each shot, so on AF the booth fires slightly early to keep photos on time. To shoot right on the flash: slide the switch on the lens from AF to MF and focus once on the spot where guests stand.' });
          } else if (st.fireOnce && st.focusInShot && st.lagMs >= 800) {
            out.push({ id: 'late', text: 'This Canon focuses inside every shot, so the photo is taken about ' + (Math.round(st.lagMs / 100) / 10) + ' s after the flash. To get it right on the flash: slide the switch on the lens from AF to MF, and focus once on the spot where guests stand.' });
          }
        }
        if (st.toCard) {
          out.push({ id: 'card', text: 'This Canon is saving each photo on its SD card first, so "Saving" takes longer. Use a fast SD card (UHS-I) and set the image quality to JPEG only, not RAW + JPEG.' });
        }
        if (st.aspectCrop) {
          out.push({ id: 'aspect', text: 'This Canon is set to a cropped Aspect ratio (such as 16:9 or 1:1) while Live View is 3:2, which makes photos look zoomed in after each shot. In the camera menu (Live View shoot. -> Aspect ratio), set it to 3:2.' });
        }
        if (st.flashMode) {
          out.push({ id: 'flash', text: 'Flash / strobe with Canon live view (6D / 60D / 1300D): in the camera menu set Silent LV shoot (Silent shoot.) to Disable (Mode 1 or 2 makes external flashes fire with no effect on the photo), set Exposure simulation to Disable, use M mode at 1/160 s or slower (S2 if using an optical slave), and allow 3–4 s between photos so the flash/strobe finishes recycling.' });
        }
        return out;
      }
      function canonGuideFail(code) {
        var c = String(code || '').toUpperCase();
        if (c !== 'FOCUS' && c !== 'CAPTURE') return null;
        return { id: 'fail', text: 'The Canon did not take the photo. Check: (1) the lens switch: try MF and focus on the spot where guests stand; (2) the mode dial is on P, Tv, Av or M, not the video camera; (3) the SD card is in, not full, and its lock switch is slid up; (4) the camera\'s menu is closed. Then take a test shot.' };
      }
      // canon-guide:end
      var canonGuideState = { shown: {}, lateRun: 0, fastRun: 0, lastStatus: null };
      function canonGuideShow(items) {
        var el = document.getElementById('canonGuideNote');
        if (!el) return;
        if (!items.length) { el.style.display = 'none'; return; }
        el.textContent = 'ℹ Canon tip: ' + items.map(function (i) { return i.text; }).join(' ');
        el.style.display = '';
      }
      function canonGuideBuild(j) {
        var lag = Number(j && j.shutterMs) || 0;
        var mf = !!((j && j.lensMf) || (typeof usbCam !== 'undefined' && usbCam && usbCam.lensMf) || canonGuideState.fastRun >= 2);
        var older = !!((j && j.olderCanon) || (typeof usbCam !== 'undefined' && usbCam && usbCam.olderCanon));
        var aspectCrop = !!((j && j.aspectCrop) || (typeof usbCam !== 'undefined' && usbCam && usbCam.aspectCrop));
        return canonGuideFrom({
          fireOnce: typeof usbFireOnce === 'function' ? usbFireOnce() : false,
          lagMs: lag,
          focusInShot: !!(j && j.focusInShot),
          noAfOff: !!(j && j.noAfOff),
          toCard: !!(j && j.toCard),
          aspectCrop: aspectCrop,
          olderCanon: older,
          lensMf: mf,
          flashMode: typeof camGuideLight === 'function' ? camGuideLight() === 'flash' : false
        });
      }
      function canonGuideRefresh() {
        try {
          if (!camIsCanon()) { canonGuideShow([]); return; }
          canonGuideShow(canonGuideBuild(canonGuideState.lastStatus));
        } catch (e) { }
      }
      // On connect and after each photo (usbAfterShot): the camera program's status becomes the tips in the Camera menu.
      // A tip that says the photo is late also comes up once as a toast after two late shots in a row.
      function canonGuideUpdate(j, isConnect) {
        try {
          if (!camIsCanon()) { canonGuideShow([]); canonGuideState.lateRun = 0; canonGuideState.fastRun = 0; canonGuideState.lastStatus = null; return; }
          var lag = Number(j && j.shutterMs) || 0;
          if (!isConnect && lag > 0) {
            if (lag < 600) canonGuideState.fastRun++;
            else if (lag >= 700) canonGuideState.fastRun = 0;
          }
          canonGuideState.lastStatus = j || null;
          var items = canonGuideBuild(j);
          canonGuideShow(items);
          if (isConnect) return;
          var late = items.some(function (i) { return i.id === 'late' || i.id === 'noaf'; });
          canonGuideState.lateRun = late ? canonGuideState.lateRun + 1 : 0;
          items.forEach(function (i) {
            if (i.id === 'flash' || i.id === 'older') return;
            if (canonGuideState.shown[i.id]) return;
            if ((i.id === 'late' || i.id === 'noaf') && canonGuideState.lateRun < 2) return;
            canonGuideState.shown[i.id] = true;
            usbLog('canon-guide', { id: i.id, lagMs: lag });
            try { showToast('Canon tip: ' + i.text, 12000); } catch (e) { }
          });
        } catch (e) { }
      }
      // A photo that failed: the failed-photo message is already on screen; the checklist stays in the Camera menu.
      function canonGuideOnFail(err) {
        try {
          if (!camIsCanon()) return;
          var g = canonGuideFail(err && err.code);
          if (g) canonGuideShow([g]);
        } catch (e) { }
      }
