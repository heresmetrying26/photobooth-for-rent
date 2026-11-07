// The booth's hardware, when these screens run inside the booth page at /rush/ (station mode).
// The booth page offers window.__PBHW: the live camera picture and photo (webcam, USB DSLR, helper camera, Android USB webcam...),
// the paper sizes Admin allows for the code, and printing through the booth's own routes (Print Helper, Wi-Fi/USB, Android, Bluetooth).
// Opened on its own (the standalone app), there is none: the app then uses the browser's camera and print dialog.
let hw = null;
try { if (window.parent && window.parent !== window && window.parent.__PBHW) hw = window.parent.__PBHW; } catch (e) { hw = null; }
export default hw;
