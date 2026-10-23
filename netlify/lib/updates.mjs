// What's new (photobooth4u.netlify.app/updates/) and the laptop app downloads (/app/).
//
// Releasing a new laptop app version:
//   1. Change "version" in desktop/package.json (e.g. 1.0.2) and push.
//   2. Push a tag desktop-v1.0.2 (git tag desktop-v1.0.2 && git push origin desktop-v1.0.2).
//      GitHub Actions builds the installers and attaches them to the release "desktop-v1.0.2".
//   3. When the release has its 3 files, set APP below to the new version, add a note to NOTES, push.
//      /app/ then offers the new files, and every laptop app says "Update available" at its next check-in.
export const REPO = 'heresmetrying26/photobooth-for-rent';
export const APP = { version: '1.0.1', date: '2026-10-23' };
export const HELPER = { version: '1.1.5', date: '2026-10-23' };

export function appDownloads(v = APP.version) {
  const base = 'https://github.com/' + REPO + '/releases/download/desktop-v' + v + '/';
  return {
    version: v,
    windows: base + 'photobooth4u-' + v + '-windows-x64.exe',
    macArm: base + 'photobooth4u-' + v + '-mac-arm64.dmg',
    macIntel: base + 'photobooth4u-' + v + '-mac-x64.dmg'
  };
}

// Newest first. for: 'website' | 'app' (laptop app) | 'helper' (Print Helper).
export const NOTES = [
  {
    date: '2026-10-23', title: 'Tilt handle, photo layers and your own sounds', for: ['website', 'app'], app: '1.0.1',
    items: [
      'Edit photo spots: drag the round ↻ button under a box to tilt it. The angle shows while you turn it.',
      'Bring to front / Send to back: choose which photo is on top where two photo spots overlap.',
      'Upload your own shutter sound and countdown beep (Setup → 5 Session → Light, sound and start).',
      'New “What’s new” page, and laptop app downloads at photobooth4u.netlify.app/app/.'
    ]
  },
  {
    date: '2026-10-23', title: 'Canon EOS cameras on Windows', for: ['helper', 'app'], helper: '1.1.5', app: '1.0.1',
    items: [
      'Canon EOS cameras (DSLR, M and R) now work on Windows, like Nikon: live view and the real shutter, so the flash fires.',
      'Older Canons (60D, 70D, 600D…): turn on “Live View shoot” in the camera’s menu.',
      'The Windows camera test (/camera-test/windows/) shows each step as OK or NO, so it’s easy to see what to fix.'
    ]
  },
  {
    date: '2026-10-23', title: 'New packages and step-by-step guides', for: ['website'],
    items: [
      'Packages: Tablet Booth, Laptop Booth, Laptop 6-Month Pass, Lifetime Online, and Lifetime Online + Offline.',
      'Laptop, Tablet and Offline app guides (PDF) on the About Us page.'
    ]
  },
  {
    date: '2026-10-23', title: 'Simpler Layout step', for: ['website', 'app'],
    items: [
      'Layouts are grouped (your frames, strips, 4R, landscape, receipt). Tick the ones guests can choose from, right on the cards.',
      'Ready designs ask whether to keep your layout or use the design’s own.'
    ]
  },
  {
    date: '2026-10-23', title: 'Receipt printer layouts', for: ['website', 'helper'], helper: '1.1.4',
    items: [
      '80 mm and 58 mm receipt strips (black & white or colour) for thermal receipt printers.',
      'Print Helper 1.1.4 prints receipts at the roll’s full width.'
    ]
  },
  {
    date: '2026-10-23', title: 'The laptop app for Windows & Mac', for: ['app'], app: '1.0.0',
    items: [
      'The full booth as an app: works with no internet at the venue.',
      'Photos save on the laptop; guests scan a QR over the booth Wi-Fi to save their photo.',
      'Printing and the Windows camera are built in (no Print Helper needed).'
    ]
  },
  {
    date: '2026-10-22', title: 'Guest payments and the print station', for: ['website'],
    items: [
      'Guests pay per session with GCash / Maya QR through your own PayMongo, or with vouchers you sell.',
      'Laptop print station: tablets send prints to a laptop with the printer, no pop-up.'
    ]
  }
];
