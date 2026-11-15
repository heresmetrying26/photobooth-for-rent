      // ---- Sony photo quality (Sony Alpha only). Everything Sony-specific about the photo is in this file. ----
      // Same pipeline as the other brands (see photo-quality.js): shrink in halving steps, light clean-up, print sharpen.
      // Settings (Camera menu -> Sony photo options): clean-up Off / Auto / Strong, photo tips, "Classic Sony behaviour".
      // A Sony has no separate focus command over USB: it focuses by itself at each shot, so there is no "focus missed" note.
      // Its camera-side behaviour (PC Remote, Save Dest.: PC only, deep sleep) is NOT here: see usbSonyPcOnly and sonyDeepOn.
      // To change only how Sony photos look, change the numbers in tune below.
      CAM_Q.sony = camQMakeProfile({
        id: 'sony', label: 'Sony',
        is: function () { return camIsSony(); },
        keys: { clean: 'pb_sony_clean', tips: 'pb_sony_tips', classic: 'pb_sony_classic' },
        tune: { denoise: [16, 30], sharpen: [0.6, 0.9], page: [0.35, 0.5] }
      });
