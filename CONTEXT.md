# Session Context

**Current Task**: Release v1.0.78 (Desktop v1.0.81, Android v1.0.92): printer profiles. Each printer keeps its own colour correction, photo size on paper and borderless; profile chips; collapsible colour section.

**Key Decisions**:
- Profiles live in localStorage `pb_color_adj_by_printer` / `pb_print_opts_by_printer` and in the setup export (`printerProfiles`). Copies stays global.
- `printPrefs` / `colorAdj` stay the live values of the printer in use; chips edit other printers without touching them.
- Edit files with LF endings (.gitattributes eol=lf); scripts that read+write on Windows can turn them into CRLF and break `test-360-ui-ux.mjs`.

**Next Steps**:
- GitHub Actions packages installers on tag push (desktop-v1.0.81, android-v1.0.92); Netlify deploys the website from main.
- Check the profile chips on a real laptop with two printers (thermal + photo) and on a tablet.
- `public/downloads/pb4u-windows-camera-test/*` shows as deleted in the working tree (not from this release); check why.
