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
        focusMissText: 'The camera could not lock focus on this photo. Check the lens switch is on AF, add light, and point at something with detail.'
      });

      // ---- Canon guide for the operator ----
      // What the booth tells the operator when a Canon does not give its photo at the flash, or does not take the photo. The camera
      // program (the Windows laptop app) reports three things after each photo (see ListJson in camera-worker.ps1): the photo was
      // focused inside the shot, the press without focusing was turned off, photos go via the card. canonGuideFrom turns them into
      // short tips. These two functions touch nothing on the page, so scripts/test-canon-guide.mjs runs them on their own.
      // canon-guide:start
      function canonGuideFrom(st) {
        var out = [];
        if (!st) return out;
        if (st.noAfOff) {
          out.push({ id: 'noaf', text: 'This Canon gave no photo when asked to skip focusing, so it now focuses inside each shot and the photo comes after the flash. Slide the switch on the lens from AF to MF and focus once on the spot where guests stand: then the photo is taken right on the flash.' });
        } else if (st.fireOnce && st.focusInShot && st.lagMs >= 800) {
          out.push({ id: 'late', text: 'This Canon focuses inside every shot, so the photo is taken about ' + (Math.round(st.lagMs / 100) / 10) + ' s after the flash. To get it right on the flash: slide the switch on the lens from AF to MF, and focus once on the spot where guests stand.' });
        }
        if (st.toCard) {
          out.push({ id: 'card', text: 'This Canon is saving each photo on its SD card first, so "Saving" takes longer. Use a fast SD card (UHS-I) and set the image quality to JPEG only, not RAW + JPEG.' });
        }
        return out;
      }
      function canonGuideFail(code) {
        var c = String(code || '').toUpperCase();
        if (c !== 'FOCUS' && c !== 'CAPTURE') return null;
        return { id: 'fail', text: 'The Canon did not take the photo. Check: (1) the lens switch: try MF and focus on the spot where guests stand; (2) the mode dial is on P, Tv, Av or M, not the video camera; (3) the SD card is in, not full, and its lock switch is slid up; (4) the camera\'s menu is closed. Then take a test shot.' };
      }
      // canon-guide:end
      var canonGuideState = { shown: {}, lateRun: 0 };
      function canonGuideShow(items) {
        var el = document.getElementById('canonGuideNote');
        if (!el) return;
        if (!items.length) { el.style.display = 'none'; return; }
        el.textContent = 'ℹ Canon tip: ' + items.map(function (i) { return i.text; }).join(' ');
        el.style.display = '';
      }
      // After each photo (usbAfterShot): the camera program's status becomes the tips, in the Camera menu. A tip that says the
      // photo is late also comes up once as a message, but only when it was late twice in a row (one slow shot is not a pattern).
      function canonGuideUpdate(j) {
        try {
          if (!camIsCanon()) { canonGuideShow([]); canonGuideState.lateRun = 0; return; }
          var lag = Number(j && j.shutterMs) || 0;
          var items = canonGuideFrom({ fireOnce: usbFireOnce(), lagMs: lag, focusInShot: !!(j && j.focusInShot), noAfOff: !!(j && j.noAfOff), toCard: !!(j && j.toCard) });
          canonGuideShow(items);
          var late = items.some(function (i) { return i.id === 'late' || i.id === 'noaf'; });
          canonGuideState.lateRun = late ? canonGuideState.lateRun + 1 : 0;
          items.forEach(function (i) {
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
