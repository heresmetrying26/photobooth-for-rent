      // ---- Nikon photo quality (Nikon cameras only). Everything Nikon-specific about the photo is in this file. ----
      // Settings (Camera menu -> Nikon photo options): clean-up Off / Auto / Strong, photo tips, "Classic Nikon behaviour".
      // Classic also tells the camera program to use its old JPEG / autofocus behaviour (the "classic" word on the camera calls:
      // see classicQ in the helper client, which reads pb_nikon_classic). Photo tips: the warnings, the test shot's focus crop and
      // the between-photo prep.
      CAM_Q.nikon = camQMakeProfile({
        id: 'nikon', label: 'Nikon',
        is: function () { return /nikon/i.test(usbCam.name || ''); },
        keys: { clean: 'pb_nikon_clean', tips: 'pb_nikon_tips', classic: 'pb_nikon_classic' },
        classicHint: 'Turns all the Nikon photo improvements off (clean-up, sharper shrink, new autofocus wait) and goes back to how the Nikon worked before. Use it if shots feel slower or different.',
        classicOnToast: 'Classic Nikon behaviour on: photos and autofocus work as before.',
        // Camera check (see CAM_GUIDE in photo-quality.js): Nikon's mode names (A and S, not Av and Tv), flash sync (1/200 s on
        // the D5300 / D5600) and flash advice.
        guide: {
          modeNames: ['', 'M', 'P', 'A', 'S'],
          modeHow: 'Turn the mode dial on top of the camera to',
          syncFor: function () { return 1 / 200; },
          flashHow: 'Press the flash button on the front of the camera to raise the built-in flash, or switch the flash on the hot shoe on and set it to TTL. Then take the test shot again.'
        }
        // tune: the default numbers (see CAM_Q_TUNE) are the ones tuned on a D5300 / D5600
      });
