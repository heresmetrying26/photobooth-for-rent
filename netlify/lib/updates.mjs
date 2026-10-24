// What's new (photobooth4u.netlify.app/updates/) and the laptop app downloads (/app/).
//
// Releasing a new laptop app version:
//   1. Change "version" in desktop/package.json (e.g. 1.0.3), add it at the top of APP_RELEASES
//      below with a note in NOTES, and push.
//   2. Push a tag desktop-v1.0.3 (git tag desktop-v1.0.3 && git push origin desktop-v1.0.3).
//      GitHub Actions builds the installers and attaches them to the release "desktop-v1.0.3".
//   That's all: the site only offers a version once its 3 installers are on GitHub (checked
//   below), so /app/ and the laptops' "update" prompt switch over by themselves after the build.
export const REPO = 'heresmetrying26/photobooth-for-rent';
// Newest first. The newest one whose installers are on GitHub is the one offered.
export const APP_RELEASES = [
  { version: '1.0.2', date: '2026-10-24' },
  { version: '1.0.1', date: '2026-10-23' }
];
export const APP = APP_RELEASES[0];
export const HELPER = { version: '1.1.6', date: '2026-10-24' };

export function appDownloads(v = APP.version) {
  const base = 'https://github.com/' + REPO + '/releases/download/desktop-v' + v + '/';
  return {
    version: v,
    windows: base + 'photobooth4u-' + v + '-windows-x64.exe',
    macArm: base + 'photobooth4u-' + v + '-mac-arm64.dmg',
    macIntel: base + 'photobooth4u-' + v + '-mac-x64.dmg'
  };
}

// Is this version's release on GitHub with all 3 installers? (null = couldn't check)
async function released(v) {
  const d = appDownloads(v);
  try {
    const rs = await Promise.all([d.windows, d.macArm, d.macIntel].map((u) => fetch(u, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) })));
    return rs.every((r) => r.status === 200 || (r.status >= 300 && r.status < 400));
  } catch { return null; }
}
let live = { at: 0, ttl: 0, v: null };
// The app version to offer: the newest released one (checked at most every 10 minutes).
export async function liveApp() {
  if (live.v && Date.now() - live.at < live.ttl) return live.v;
  for (let i = 0; i < APP_RELEASES.length; i++) {
    const rel = APP_RELEASES[i];
    if (i === APP_RELEASES.length - 1) { live = { at: Date.now(), ttl: 2 * 60000, v: rel }; return rel; }
    if (await released(rel.version)) { live = { at: Date.now(), ttl: 10 * 60000, v: rel }; return rel; }
  }
  return APP;
}

// Newest first. for: 'website' | 'app' (laptop app) | 'helper' (Print Helper).
export const NOTES = [
  {
    date: '2026-10-24', title: 'Your logo on the guest screen', for: ['website', 'app'], app: '1.0.2',
    items: [
      'Setup → 5 Session → Your logo: a corner logo in place of the photobooth4u logo on the guest screen, and a logo on the welcome picture between guests.',
      'Each logo can be its own picture. Tap it in the preview to drag it anywhere and resize it with the round handle.',
      'A small “Powered by photobooth4u” shows under the event date. The start screen keeps the photobooth4u logo.'
    ]
  },
  {
    date: '2026-10-24', title: 'Prints on the right paper size', for: ['helper', 'app'], helper: '1.1.6', app: '1.0.2',
    items: [
      'Prints now tell the printer the paper size picked in the booth (for example 4R / 4×6 instead of the printer’s default A4), borderless when the printer has it.',
      'If the printer has no matching paper size, the printer checklist says so before you print.',
      'A printer already set to the right size keeps its own settings (like 2×6 cutting).'
    ]
  },
  {
    date: '2026-10-24', title: 'The laptop app updates itself', for: ['app'], app: '1.0.2',
    items: [
      'Windows: new versions download in the background; Setup then asks “Restart now” or “Later” (it installs when you close the app).',
      'Mac: Setup says when a new version is out; tap Download, then drag photobooth4u into Applications.',
      'Never during a guest session. Laptops on 1.0.1 or older update by hand once (photobooth4u.netlify.app/app/).'
    ]
  },
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
