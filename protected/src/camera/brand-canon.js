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
