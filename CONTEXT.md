# Session Context

**Current Task**: Release v1.0.79 (Desktop v1.0.82, Android v1.0.93): colour correction applies to prints only, thermal Best/Normal/Draft quality, calmer Android print settings, Android lock PIN fix.

**Key Decisions**:
- Colour correction is applied once by `printAdjust` to print pages and the print preview; the live camera and shots are untouched. Native Android printer code gets brightness/RGB = 0 so it is not added twice.
- Thermal quality (`printPrefs.thermalQuality`, per printer profile) is image-side only: best = sharpen + Atkinson, normal = Floyd-Steinberg, draft = ordered dots.
- Android only (`.pb-android`): static `.panel-hint` lines clamp to one line (tap to read); photo size, borderless and colour correction sit behind "More options".
- Edit files with LF endings (.gitattributes eol=lf); read+write scripts on Windows can turn them into CRLF and break `test-360-ui-ux.mjs`.

**Next Steps**:
- Netlify does not seem to auto-deploy from main (site still lists desktop 1.0.79): deploy the website by hand (`netlify deploy --prod --build`).
- Try Best/Normal/Draft on a real thermal printer and check the Android print pop-up on a tablet.
- `public/downloads/pb4u-windows-camera-test/*` shows as deleted in the working tree (not from this release); check why.
