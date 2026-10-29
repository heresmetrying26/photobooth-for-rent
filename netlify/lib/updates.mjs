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
  { version: '1.0.23', date: '2026-10-29' },
  { version: '1.0.22', date: '2026-10-28' },
  { version: '1.0.21', date: '2026-10-28' },
  { version: '1.0.20', date: '2026-10-28' },
  { version: '1.0.19', date: '2026-10-28' },
  { version: '1.0.16', date: '2026-10-27' },
  { version: '1.0.15', date: '2026-10-27' },
  { version: '1.0.14', date: '2026-10-27' },
  { version: '1.0.13', date: '2026-10-27' },
  { version: '1.0.12', date: '2026-10-27' },
  { version: '1.0.11', date: '2026-10-27' },
  { version: '1.0.10', date: '2026-10-26' },
  { version: '1.0.9', date: '2026-10-26' },
  { version: '1.0.8', date: '2026-10-25' },
  { version: '1.0.7', date: '2026-10-25' },
  { version: '1.0.6', date: '2026-10-24' },
  { version: '1.0.5', date: '2026-10-24' },
  { version: '1.0.4', date: '2026-10-24' },
  { version: '1.0.3', date: '2026-10-24' },
  { version: '1.0.2', date: '2026-10-24' },
  { version: '1.0.1', date: '2026-10-23' }
];
export const APP = APP_RELEASES[0];
export const HELPER = { version: '1.1.10', date: '2026-10-28' };
// The newest Android tablet app (tag android-v<version> on GitHub). Tablets ask /api/updates at launch and
// offer to download it when theirs is older. Change it together with versionName in android/app/build.gradle.
export const ANDROID = { version: '1.0.18', date: '2026-10-29', url: 'https://github.com/' + REPO + '/releases/download/android-v1.0.18/photobooth4u-kiosk-android.apk' };

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
    // The newest version being out is stable (10 minutes). While a newer one is still being built an older one is offered, so look again every minute: the new one shows up shortly after its installers land on GitHub.
    if (await released(rel.version)) { live = { at: Date.now(), ttl: i === 0 ? 10 * 60000 : 60000, v: rel }; return rel; }
  }
  return APP;
}

// Newest first. for: 'website' | 'app' (laptop app) | 'helper' (Print Helper).
export const NOTES = [
  {
    date: '2026-10-29', title: 'Vintage looks, photographer desk, flipbook and a 360 video desk', for: ['website', 'app'], app: '1.0.23',
    items: [
      'Vintage looks: Film, Faded, 70s, Instant and Noir, with grain, darker corners and a warm light leak, plus an optional orange date stamp on each photo. They are in the filter picker and on the guests’ filter strip, and apply to photos and flipbook frames (GIFs are recorded without filters).',
      'Photographer desk: a roving photographer’s photos go into your frame, print and get a QR code. Drop or choose the photos, or (laptop app) pick a folder the camera software saves into and new photos appear by themselves. Quick shot turns a phone or tablet into a handheld camera: every tap is saved quietly and you show the QR when a guest asks.',
      'Flipbook: guests record a short clip and the booth prints its frames as numbered cards on sheets (cut, stack, staple), with a cover card and a back card. They also get an animated GIF QR code.',
      '360 video desk: videos from the 360 arm’s camera arrive from a folder or from the recording phone’s browser. The laptop app edits them (slow motion, speed ramp or boomerang, your frame, logo and title, music, trim) and shares the finished video with a QR code. The website shares the original video, up to about 28 MB.',
      'All of these are included with every package and switched on by default. In Admin you can switch any of them off for a client.',
      'New Event Pass for ₱499 (24 hours, tablet or laptop) replaces the Tablet and Laptop booth passes, and the 1-hour practice code is gone: use the free trial to test first.'
    ]
  },
  {
    date: '2026-10-29', title: 'Android tablet app now needs a code, same as the laptop app', for: ['website'],
    items: [
      'The Android app (v1.0.7) is still free to install, but now stays on an \u201cActivate this tablet\u201d screen until it\u2019s unlocked with a rental code that has the offline app add-on \u2014 the same signed-licence system the Windows/Mac app already uses.',
      'It needs Wi-Fi once to activate, then keeps working offline until the licence\u2019s own renewal is due, in the background, same as the laptop app.',
      'One code\u2019s offline-app device slots are now shared between the desktop and Android apps.',
    ]
  },
  {
    date: '2026-10-29', title: 'Fix: the Android tablet sometimes tried to load the live website and failed', for: ['website'],
    items: [
      'A tablet that had ever been pointed at the live website (via the hidden Booth Configuration screen) kept trying that on every launch, even at a venue with no Wi-Fi \u2014 showing Android\u2019s own \u201ccould not be loaded, internet disconnected\u201d page instead of the booth.',
      'The app now checks for a real internet connection before it ever tries the live site, and falls back to the bundled offline booth on any load failure, not just specific error types.',
    ]
  },
  {
    date: '2026-10-28', title: 'Android tablet app \u2014 photos, GIFs and QR codes now work fully offline', for: ['website'],
    items: [
      'The Android tablet app (v1.0.5) now saves every photo and GIF on the tablet, so a photo QR works at a venue with no internet at all.',
      'Guests scan the QR with their phone, on the same Wi-Fi or hotspot as the tablet, to open their photo or GIF, tap Save, or browse the event\u2019s All photos page.',
      'Copies are also kept in the tablet\u2019s Pictures \u203a photobooth4u folder, one folder per event, so you can copy them off afterwards.',
      'Put your Wi-Fi name and password in Setup \u203a Share and the booth shows a \u201cjoin the Wi-Fi\u201d QR first.',
    ]
  },
  {
    date: '2026-10-28', title: 'USB cameras recover faster after a drop-out, and laptops hear about updates sooner', for: ['website', 'app'], app: '1.0.22',
    items: [
      'If a USB camera (Canon, Nikon or Sony) stops answering or is unplugged, the booth now notices within a few seconds and reconnects by itself, instead of leaving a frozen picture on screen for up to 20 seconds. \u201cReconnecting\u201d shows meanwhile.',
      'The booth now keeps a short camera log. If a camera keeps dropping out, open the Camera menu, tap \u201cCopy camera log\u201d and send it to us.',
      'The laptop app now checks for a new version every few minutes instead of every few hours.'
    ]
  },
  {
    date: '2026-10-28', title: 'Fix: \u201cTap to start\u201d sometimes stopped responding', for: ['website', 'app'], app: '1.0.21',
    items: [
      'The welcome screen no longer comes back while the camera is still being opened, and a tap during that time now says \u201cGetting the camera ready\u201d instead of doing nothing.',
      'If a start gets stuck for more than a minute and a half, or a session breaks halfway, the booth unlocks itself and returns to the welcome screen so guests can tap again.'
    ]
  },
  {
    date: '2026-10-28', title: 'Sony photos save straight to the computer, and a stuck camera no longer freezes the booth', for: ['website', 'app'], app: '1.0.20',
    items: [
      'Sony cameras now send each photo straight to the computer instead of writing it to the memory card first, so no memory card is needed and shots should save sooner.',
      'If a USB camera stops answering after a shot, the booth now gives up after a minute, uses the live view frame for that photo and carries on, instead of freezing.'
    ]
  },
  {
    date: '2026-10-28', title: 'Sony cameras over USB, and easier camera setup on Mac', for: ['website', 'app', 'helper'], app: '1.0.19', helper: '1.1.10',
    items: [
      'Sony Alpha cameras (built for the A7 III) can now be used over USB on Windows, in the laptop app or through the Print Helper 1.1.9 or newer: live view comes from the camera and every shot fires the real shutter, so the camera\u2019s own photo settings and flash apply.',
      'On the camera set USB Connection to PC Remote (MENU > Setup > USB), use JPEG, plug it in, then pick \u201cNikon / Canon / Sony camera over USB\u201d in the Camera menu. It reconnects by itself after that. This is the first Sony release: if your model does not connect, the booth shows what to check.',
      'Mac laptop app: the app now lets go of a camera that macOS grabbed (\u201cAnother app is using the camera\u201d) by itself and connects when you plug the camera in.',
      'Mac in Chrome: the Print Helper 1.1.10 does the same, so the booth can open a Sony, Canon or Nikon over USB without quitting Photos or Image Capture by hand.'
    ]
  },
  {
    date: '2026-10-28', title: 'Android tablet app \u2014 true offline kiosk mode', for: ['website'],
    items: [
      'The Android tablet APK (v1.0.2) now opens and runs fully offline \u2014 no internet connection is required at the venue.',
      'The booth page is bundled inside the app; if the device has no network when opened, it automatically loads the local copy instead of showing a \u201cWeb page not available\u201d error.',
      'Bluetooth thermal printing and all booth features (GIF mode, retakes, lock screen) continue to work completely offline.',
      'You only need Wi-Fi or a hotspot once \u2014 to unlock a rental code before the event.',
    ]
  },
  {
    date: '2026-10-27', title: 'GIF mode in the offline laptop app', for: ['app'], app: '1.0.16',
    items: [
      'When GIF mode is switched on in the admin panel for a code, the offline laptop app now shows a "Take GIF" chip in Photo Session alongside the regular photo mode.',
      'The app captures a short burst of frames and stitches them into an animated GIF, saved next to the regular photos in your backup folder.',
      'A GIF gallery tab appears in My Events so guests can browse and download their GIFs, just like photos.'
    ]
  },
  {
    date: '2026-10-27', title: 'Reprint a photo and safer app updates', for: ['website', 'app'], app: '1.0.15',
    items: [
      'Open a photo in either gallery and choose Print photo to print that single image again.',
      'The laptop app now handles installer download and file errors without an uncaught main-process stream error.'
    ]
  },
  {
    date: '2026-10-27', title: 'Quicker event sharing and booth controls', for: ['website', 'app'], app: '1.0.14',
    items: [
      'Open the All photos event gallery QR from the Photo Session dock, or show it on the guest screen while the booth is idle.',
      'Save or change the booth PIN in Setup, then lock the booth from the Photo Session dock when guests are ready.',
      'Get Ready now has a larger Cancel button beside Start, or below the smile / wave cue in hands-free mode.',
    ]
  },
  {
    date: '2026-10-27', title: 'A clearer downloads page', for: ['website'],
    items: [
      'The downloads page now highlights a desktop installer for your device and includes clearer setup guidance for Windows, Mac, and Print Helper.'
    ]
  },
  {
    date: '2026-10-27', title: 'Open Mac printer settings', for: ['app'], app: '1.0.13',
    items: [
      'The desktop app now opens macOS Printers & Scanners for the selected printer instead of showing raw numeric driver option values.'
    ]
  },
  {
    date: '2026-10-27', title: 'Open printer settings from the web booth', for: ['website', 'helper'], helper: '1.1.7',
    items: [
      'Choose a printer in the web booth and open its Windows printer preferences or Mac Printers & Scanners settings through the Print Helper.'
    ]
  },
  {
    date: '2026-10-27', title: 'A clearer printer setup', for: ['website', 'app'], app: '1.0.12',
    items: [
      'Choose a printer and open its settings before printing in the laptop app.',
      'The web booth now explains the difference between choosing a print route and turning on automatic printing, with a checklist for browser printing, Print Helper, and the laptop print station.'
    ]
  },
  {
    date: '2026-10-27', title: 'Printer setup and sharing improvements', for: ['website', 'app'], app: '1.0.11',
    items: [
      'Laptop app: configure paper type and print quality from the selected printer’s installed driver. Save the settings once and later booth prints reuse them; Windows opens the printer preferences, while Mac shows the available driver options.',
      'Laptop app: the All photos QR is available during offline sessions and opens the event gallery over the booth Wi-Fi; each photo QR appears when that photo is ready.',
      'Website: clearer guest QR sharing and improved GIF capture quality and gallery browsing.'
    ]
  },
  {
    date: '2026-10-26', title: 'Expanded macOS support (Big Sur 11+ & Monterey 12.7+)', for: ['app'], app: '1.0.10',
    items: [
      'Expanded macOS compatibility: the offline app now supports macOS 11 (Big Sur) and macOS 12 (Monterey 12.7+) in addition to Ventura, Sonoma, and Sequoia.',
      'Universal Mac compatibility: packages both Apple Silicon (M1/M2/M3/M4) and Intel x64 architectures.'
    ]
  },
  {
    date: '2026-10-26', title: 'Custom frame naming and layout improvements', for: ['website', 'app'], app: '1.0.9',
    items: [
      'Custom frame names: give any uploaded frame a custom name (e.g. "Blue Teddy") directly from the frame settings panel, making it easy to identify frames in multi-frame layouts.',
      'Saved layout persistence: frame names are automatically saved with your layout snapshots, restored when loading designs, and preserved across export and import.',
      'UI enhancements: frame labels throughout the editor and sheet view now reflect your custom frame names.'
    ]
  },
  {
    date: '2026-10-25', title: 'Full-screen camera viewfinder & vertical filter options', for: ['website', 'app'], app: '1.0.8',
    items: [
      'Full-screen viewfinder: the live camera now fills the screen from top to bottom on the web as well as desktop, eliminating wide letterboxing during photo sessions.',
      'Vertical filters: filter options on the Get ready screen are now docked vertically in the bottom-right corner, keeping the Start button clean, centered, and completely unobstructed.'
    ]
  },
  {
    date: '2026-10-25', title: 'Step reorder: Share before Session', for: ['website', 'app'], app: '1.0.7',
    items: [
      'Setup steps reordered: Share is now Step 5 and Session is Step 6, so you set up your photo folder and sharing options before starting the booth session.',
      'Updated Step 5 and Step 6 summaries, folder validation, and navigation shortcuts.',
      'Updated About Us slides showcase.'
    ]
  },
  {
    date: '2026-10-24', title: 'Frame settings and photo spots right under your frame', for: ['website', 'app'], app: '1.0.6',
    items: [
      'Adding your own frame: the frame settings, Edit photo spots tools and collage sheet options now appear directly below your frame card instead of far down in the preview area.',
      '"Your frames" moves to the top of the Layout step when you upload a frame, so you see your frame and its editing tools first — no scrolling past preset layouts.',
      'Mobile: tapping "Edit photo spots" on small screens now docks the live canvas preview so you can see spot changes in real time.',
      'A "Preview" quick-toggle button on the frame toolbar lets you show or hide the live preview with one tap.',
      'Clicks inside the editing controls no longer accidentally re-select a layout card.'
    ]
  },
  {
    date: '2026-10-24', title: 'Your logo in Photo Session, and a wider camera view', for: ['website', 'app'], app: '1.0.5',
    items: [
      'The top-left logo (Setup → 5 Session → Your logo) now also shows at the top of Photo Session, on laptops and tablets. Setup keeps the photobooth4u logo.',
      'The bottom-left bar has Camera, Printer and Backup folder, with a small “Powered by photobooth4u” under them. Tap Backup folder to see where photos save, allow saving again, or change the folder.',
      'The camera view now uses the full width (the Backup folder card is gone from the right).',
      'Guest screen: between guests the welcome picture fills its box, matching the preview in Setup.'
    ]
  },
  {
    date: '2026-10-24', title: 'Save my design works in the laptop app', for: ['app', 'website'], app: '1.0.4',
    items: [
      'Save my design (Setup → 1 Design) now opens a box to name your design, in the laptop app too, where it didn’t open before.'
    ]
  },
  {
    date: '2026-10-24', title: 'Easier start for guests', for: ['website', 'app'], app: '1.0.3',
    items: [
      'Choose your layout: no layout is picked until the guest taps one, and there’s no Start button on that screen.',
      'Smile or Wave to start: the Get ready screen says “Smile to start” or “Wave to start” instead of showing a Start button. Tapping the screen still works.'
    ]
  },
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
      'Packages: Tablet Booth, Laptop Booth, Lifetime Online, Lifetime Offline, and Lifetime Online + Offline.',
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
