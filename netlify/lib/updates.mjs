// What's new (photobooth4u.netlify.app/updates/) and the laptop app downloads (/app/).
//
// Releasing a new laptop app version:
//   1. Change "version" in desktop/package.json (e.g. 1.0.3), add it at the top of APP_RELEASES
//      below with a note in NOTES, and push.
//   2. Push a tag desktop-v1.0.3 (git tag desktop-v1.0.3 && git push origin desktop-v1.0.3).
//      GitHub Actions builds the installers and attaches them to the release "desktop-v1.0.3".
//   That's all: the site only offers a version once its 3 installers are on GitHub (checked
//   below), so /app/ and the laptops' "update" prompt switch over by themselves after the build.
import ANDROID_VERSION from './android-version.mjs';
export const REPO = 'heresmetrying26/photobooth-for-rent';
// Newest first. The newest one whose installers are on GitHub is the one offered.
export const APP_RELEASES = [
  { version: '1.1.17', date: '2026-11-10' },
  { version: '1.1.16', date: '2026-11-10' },
  { version: '1.1.15', date: '2026-11-10' },
  { version: '1.1.14', date: '2026-11-10' },
  { version: '1.1.13', date: '2026-11-09' },
  { version: '1.0.112', date: '2026-11-09' },
  { version: '1.0.111', date: '2026-11-09' },
  { version: '1.0.110', date: '2026-11-09' },
  { version: '1.0.109', date: '2026-11-09' },
  { version: '1.0.108', date: '2026-11-09' },
  { version: '1.0.107', date: '2026-11-08' },
  { version: '1.0.106', date: '2026-11-08' },
  { version: '1.0.105', date: '2026-11-08' },
  { version: '1.0.104', date: '2026-11-08' },
  { version: '1.0.103', date: '2026-11-08' },
  { version: '1.0.102', date: '2026-11-07' },
  { version: '1.0.101', date: '2026-11-07' },
  { version: '1.0.100', date: '2026-11-07' },
  { version: '1.0.99', date: '2026-11-07' },
  { version: '1.0.98', date: '2026-11-07' },
  { version: '1.0.97', date: '2026-11-07' },
  { version: '1.0.96', date: '2026-11-07' },
  { version: '1.0.95', date: '2026-11-06' },
  { version: '1.0.94', date: '2026-11-06' },
  { version: '1.0.93', date: '2026-11-06' },
  { version: '1.0.92', date: '2026-11-06' },
  { version: '1.0.91', date: '2026-11-06' },
  { version: '1.0.90', date: '2026-11-06' },
  { version: '1.0.89', date: '2026-11-06' },
  { version: '1.0.88', date: '2026-11-06' },
  { version: '1.0.87', date: '2026-11-06' },
  { version: '1.0.86', date: '2026-11-06' },
  { version: '1.0.85', date: '2026-11-05' },
  { version: '1.0.84', date: '2026-11-05' },
  { version: '1.0.83', date: '2026-11-05' },
  { version: '1.0.82', date: '2026-11-05' },
  { version: '1.0.81', date: '2026-11-05' },
  { version: '1.0.80', date: '2026-11-05' },
  { version: '1.0.79', date: '2026-11-05' },
  { version: '1.0.78', date: '2026-11-05' },
  { version: '1.0.77', date: '2026-11-05' },
  { version: '1.0.76', date: '2026-11-05' },
  { version: '1.0.75', date: '2026-11-05' },
  { version: '1.0.74', date: '2026-11-04' },
  { version: '1.0.73', date: '2026-11-04' },
  { version: '1.0.72', date: '2026-11-04' },
  { version: '1.0.71', date: '2026-11-04' },
  { version: '1.0.70', date: '2026-11-04' },
  { version: '1.0.69', date: '2026-11-04' },
  { version: '1.0.68', date: '2026-11-04' },
  { version: '1.0.67', date: '2026-11-04' },
  { version: '1.0.66', date: '2026-11-04' },
  { version: '1.0.65', date: '2026-11-04' },
  { version: '1.0.64', date: '2026-11-04' },
  { version: '1.0.63', date: '2026-11-03' },
  { version: '1.0.62', date: '2026-11-02' },
  { version: '1.0.61', date: '2026-11-02' },
  { version: '1.0.60', date: '2026-11-02' },
  { version: '1.0.59', date: '2026-11-02' },
  { version: '1.0.57', date: '2026-11-02' },
  { version: '1.0.56', date: '2026-11-02' },
  { version: '1.0.55', date: '2026-11-02' },
  { version: '1.0.54', date: '2026-11-02' },
  { version: '1.0.53', date: '2026-11-02' },
  { version: '1.0.52', date: '2026-11-02' },
  { version: '1.0.51', date: '2026-11-02' },
  { version: '1.0.50', date: '2026-11-02' },
  { version: '1.0.49', date: '2026-11-02' },
  { version: '1.0.48', date: '2026-11-02' },
  { version: '1.0.47', date: '2026-11-02' },
  { version: '1.0.46', date: '2026-11-01' },
  { version: '1.0.45', date: '2026-11-01' },
  { version: '1.0.44', date: '2026-11-01' },
  { version: '1.0.43', date: '2026-11-01' },
  { version: '1.0.42', date: '2026-11-01' },
  { version: '1.0.41', date: '2026-10-31' },
  { version: '1.0.40', date: '2026-10-31' },
  { version: '1.0.39', date: '2026-10-31' },
  { version: '1.0.38', date: '2026-10-31' },
  { version: '1.0.37', date: '2026-10-31' },
  { version: '1.0.36', date: '2026-10-31' },
  { version: '1.0.35', date: '2026-10-31' },
  { version: '1.0.34', date: '2026-10-30' },
  { version: '1.0.33', date: '2026-10-30' },
  { version: '1.0.32', date: '2026-10-30' },
  { version: '1.0.31', date: '2026-10-30' },
  { version: '1.0.29', date: '2026-10-30' },
  { version: '1.0.28', date: '2026-10-30' },
  { version: '1.0.27', date: '2026-10-30' },
  { version: '1.0.26', date: '2026-10-29' },
  { version: '1.0.25', date: '2026-10-29' },
  { version: '1.0.24', date: '2026-10-29' },
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
// offer to download it when theirs is older. Hosted directly on Netlify CDN for fast, reliable delivery.
export const ANDROID = { version: ANDROID_VERSION, date: '2026-11-09', url: 'https://photobooth4u.netlify.app/downloads/photobooth4u-kiosk-android.apk' };

// The newest Rush ID Station tablet app (tag rushid-v<version> on GitHub, asset rush-id-station-android.apk). The Rush app asks
// /api/updates and offers to download it when its own version is older. Found on GitHub when asked (cached 10 minutes), so a new
// release shows up by itself; RUSH_FALLBACK is only used if GitHub cannot be reached and has nothing cached.
export const RUSH_FALLBACK = { version: '1.0.6', url: 'https://github.com/' + REPO + '/releases/download/rushid-v1.0.6/rush-id-station-android.apk' };
const verParts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const verNewer = (a, b) => { const x = verParts(a), y = verParts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p > q; } return false; };
let liveR = { at: 0, ttl: 0, v: null };
export async function liveRush() {
  if (liveR.v && Date.now() - liveR.at < liveR.ttl) return liveR.v;
  try {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=30', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'photobooth4u-site' }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      let best = null;
      for (const rel of await r.json()) {
        const m = /^rushid-v(\d+(?:\.\d+)*)$/.exec(rel.tag_name || ''); if (!m || rel.draft) continue;
        const a = (rel.assets || []).find((x) => x.name === 'rush-id-station-android.apk'); if (!a || !/^https:\/\//.test(a.browser_download_url || '')) continue;
        if (!best || verNewer(m[1], best.version)) best = { version: m[1], url: a.browser_download_url };
      }
      if (best) { liveR = { at: Date.now(), ttl: 10 * 60000, v: best }; return best; }
    }
  } catch { /* offline / rate limited: keep what we had */ }
  liveR = { at: Date.now(), ttl: 2 * 60000, v: liveR.v || RUSH_FALLBACK };       // look again in 2 minutes
  return liveR.v;
}

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
    date: '2026-11-10', title: 'Desktop 1.1.17 + Android 1.1.34: Minimizable floating layout dock, supersized side photos & budget tablet 0ms lag optimization (VOVE Pad 9 Ultra)', for: ['website', 'app'], app: '1.1.17',
    items: [
      '🚀 Budget Tablet 0ms Lag Optimization: eliminated photo capture delay on generic & budget tablets (VOVE Pad 9 Ultra) by capturing directly from active viewfinder and switching WebView rendering to direct compositor.',
      '⚡ 720p Tablet Viewfinder & GPU Layers: optimized default tablet camera stream to 1280x720 @ 30fps and isolated countdown animations into dedicated GPU compositing layers for rock-solid 30-60fps smoothness.',
      '📐 Minimizable Floating Layout Dock: replaced the bottom bar with a sleek, movable floating dock at top-right with one-tap minimize/expand so Start button sits naturally and unobstructed.',
      '📸 Supersized Side Photos: lifted film track scaling cap to 2.5x (250%) with smooth scrolling, letting session thumbnails grow way bigger on widescreen & 11.5" monitors.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.16 + Android 1.1.33: Anti-glitch safeguard for camera capture & Surface tablets', for: ['website', 'app'], app: '1.1.16',
    items: [
      '📸 Truncated JPEG Stream Guard: automatically detects incomplete camera driver buffers and missing End-of-Image markers on webcams and tablet cameras.',
      '🛡️ Anti-Smear Protection: prevents scanline duplication and bottom streak distortion (common on Microsoft Surface tablets) by safely falling back to the pristine live viewfinder frame.',
      '🔄 Unconstrained Still Retry: re-attempts photo capture unconstrained if driver-specific max resolution dimensions cause buffer overflow.',
      '✨ Flawless Collages: guarantees printed and saved photos remain sharp and glitch-free across all devices.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.15 + Android 1.1.32: Live on-screen layout & resize editor with instant preview', for: ['website', 'app'], app: '1.1.15',
    items: [
      '📐 Live On-Screen Layout Editor: new Resize UI floating tool on the Photo Session dock allows real-time scaling of countdown, buttons, and side photo strip with zero back-and-forth.',
      '👁️ Interactive Live Preview Overlays: temporarily simulates sample countdown, start button, and side film track right over the live camera view while editing.',
      '✓ One-Tap Done Editing: locks in monitor-specific sizes to localStorage and returns seamlessly to shooting mode.',
      '🖥️ Step 7 Live Jump: "Live Resize on Screen" button in Session setup switches directly to camera stage and opens the editor.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.14 + Android 1.1.31: Monitor & display scaling, prominent guest countdown & side photos auto-fit', for: ['website', 'app'], app: '1.1.14',
    items: [
      '🖥️ Display & Monitor Scaling: new Compact (11.5" Mini Monitor), Standard, and Large / TV presets in Step 7 (Session) with fine-tuning dropdowns for buttons, countdown, and side photo scaling.',
      '⏱️ Prominent Guest Countdown: enlarged vector countdown ring and numbers for clear guest visibility from a distance on small 11.5" screens.',
      '📸 Adaptive Side Session Photos: dynamically computes film-track thumbnail heights based on actual shot counts (3 or 4) so all shots fit comfortably on screen without scrolling or squishing.',
      '🎯 Responsive Buttons & Touch Targets: scales session and shutter buttons to optimize vertical screen space while maintaining standard 44px+ touch targets.'
    ]
  },
  {
    date: '2026-11-09', title: 'Desktop 1.1.13 + Android 1.1.30: Dynamic GIF motion, session fast-forward & interactive popups', for: ['website', 'app'], app: '1.1.13',
    items: [
      '⚡ Dynamic GIF motion & duration: removed fixed 2.2s clip limit. GIFs now capture natural countdown motion (up to 5.4s) and dynamically scale frame delay and playback duration.',
      'Full session fast-forward: continuous Full Session mode automatically calculates optimal speed factor (3x–10x) based on session length, delivering smooth 4–5s recaps without dragging.',
      'Seamless Multi-Box & Story Replay: synchronized Multi-Box Boomerang and sequential Story Replay dynamically calibrate timing to layout and loop mode with zero endpoint stutter.',
      'Interactive hover popups: floating preview tooltips provide instant visual descriptions and recommendations when hovering over animation styles and loop modes.'
    ]
  },
  {
    date: '2026-11-09', title: '360 Video: 1 GB high-speed Wi-Fi upload pipeline & real-time upload progress', for: ['website', 'app'], app: '1.0.112',
    items: [
      '⚡ Direct 1 GB high-speed Wi-Fi upload: automatic local network / hotspot detection (&lan=) allows recording phones to stream 360 clips up to 1 GB directly to the booth station in 2–3 seconds over local Wi-Fi.',
      'Real-time upload progress tracking: replaced static progress indicators with live percentage and transferred/total MB counters during video uploads.',
      'Desktop requirement guide on web: clicking 360 desk on the web interface now presents an informative modal explaining GPU & FFmpeg requirements for speed ramps and presets, with one-click desktop app download.',
      'Actionable large-file guidance: clear camera setting recommendations (1080p 30fps) to keep clips under 20 MB when uploading through web relays.'
    ]
  },
  {
    date: '2026-11-09', title: 'Android app 1.1.28: Offline in-app gallery preview & instant Back to booth', for: ['website', 'app'], app: '1.1.28',
    items: [
      '⚡ In-app gallery preview: tapping "Open gallery" on the tablet now opens the event gallery directly inside the app over loopback, avoiding router client isolation and connection hangs.',
      'Offline gallery access: browse all photos saved on the tablet during the event even when completely offline without Wi-Fi.',
      'Kiosk Back button: added "← Back to booth" in the gallery header to instantly return to the camera without disrupting kiosk mode.'
    ]
  },
  {
    date: '2026-11-09', title: 'Full resolution live viewfinder with downsize options & hardware acceleration', for: ['website', 'app'], app: '1.0.111',
    items: [
      '⚡ Crisp full-resolution live viewfinder: camera preview now runs at full camera sensor resolution (1080p+) by default on Android tablet and Desktop apps.',
      'Flexible viewfinder downsize controls: added explicit option in Setup → Camera to downsize the live viewfinder (to 720p or 480p) to eliminate live view lag on slower tablets while keeping photos at full camera resolution.',
      'Hardware GPU acceleration: enabled hardware composition, 3D CSS transforms, and Chromium zero-copy GPU video rasterization for silky smooth live view rendering.',
      'Always-sharp photo captures: camera stills and prints always capture and print at maximum sensor resolution regardless of viewfinder preview downsize.',
      'Optimized countdown capture: eliminated synchronous pixel loop bottlenecks during live countdown sampling.'
    ]
  },
  {
    date: '2026-11-09', title: 'Roving DSLR Bridge: Wired DSLR to Android phone streaming wirelessly to Laptop booth', for: ['website', 'app'], app: '1.0.110',
    items: [
      '📷 Roving DSLR Bridge on Android: connect any Canon, Nikon, or Sony DSLR via USB OTG to an Android phone in your pocket and stream photos wirelessly to your laptop booth in real time.',
      'Physical Shutter Detection: UsbCameraHelper automatically detects when the photographer presses the shutter button on the camera body and downloads the JPEG in ~0.5s.',
      'Pocket Lock Mode & Haptic Feedback: dim screen to save battery and lock touches while keeping the camera shutter live; vibrates on successful photo delivery.',
      'Photographer Desk Queue: incoming roving photos queue automatically in the Photographer Desk section at the base station for review, selection, and on-demand printing with event frames.',
      'Zero-license Transmitter: Android activation gate includes a direct "📷 Roving DSLR Bridge" launcher so any spare Android phone can act as a wireless bridge without burning an extra rental code.'
    ]
  },
  {
    date: '2026-11-09', title: 'High-speed camera live view & capture pipeline performance', for: ['website', 'app'], app: '1.0.109',
    items: [
      '⚡ High-speed camera pipeline: restructured live view frame dispatch and capture processing for near-zero shutter delay on Android tablet and desktop apps.',
      'Silky smooth live preview: optimized frame buffer transfers and render scheduling to eliminate live view stutter while countdown runs.',
      'Faster photo processing: streamlined multi-box layout generation and reduced memory footprint during high-resolution burst captures.',
      'Includes Auto Smart Match GIF motion styles (Story Replay for strips, Multi-Box Boomerang for grids) and seamless 1.0s story replay hold.'
    ]
  },
  {
    date: '2026-11-09', title: 'Auto Smart Match for Live Motion GIFs & seamless story replay pause', for: ['website', 'app'], app: '1.0.108',
    items: [
      '⚡ Auto Smart Match: booth automatically pairs chosen layouts with their optimal motion style (vertical strips automatically use Story Replay Box 1 → 2 → 3 → 4, while 2×2 grids and multi-cut sheets use simultaneous Multi-Box Boomerang).',
      'Seamless Story Replay pause: added calibrated 1.0-second hold on the completed photo strip before repeating, allowing guests to admire the finished print.',
      'Dynamic operator feedback: Setup → Extras dynamically explains the auto-matched motion style whenever a layout is chosen.',
      'Full cross-platform synchronization across Desktop, Android, iOS, and Web.'
    ]
  },
  {
    date: '2026-11-08', title: 'Creative Live Motion GIFs, Radiant K-Film filter & Gallery enhancements', for: ['website', 'app'], app: '1.0.107',
    items: [
      'Multi-Box Boomerang GIF: each layout box records guests\' live motion before each photo snap and loops seamlessly together in strip and grid layouts.',
      'Flexible animation styles in Setup → Extras: choose between Multi-Box Boomerang, Story Replay (sequential 1 → 2 → 3 → 4), or Full Session.',
      'Radiant / K-Film filter: clean, aesthetic skin tones and crisp whites for modern booth shots in setup and live quick filters.',
      'Ultra-smooth looping: endpoint de-duplication removes pause stutter, and 6-frame palette sampling ensures high color fidelity.',
      'Gallery & Offline Sharing: guest personal QR view displays files in exact sequence (1st Print -> 2nd GIF -> 3rd Solo Shots) with solo & GIF badges and one-click "All Media" batch download.'
    ]
  },
  {
    date: '2026-11-08', title: 'Solo photos & roving: high-quality individual raw shots in gallery and dual roving uploads', for: ['website', 'app'], app: '1.0.106',
    items: [
      'New "Include solo shots in gallery" switch in Setup → Share (ON by default): saves high-quality individual raw shots without template design into the event folder for regular booth sessions and roving photoman.',
      'Dedicated "Solo Photos" tab in online and offline event galleries with solo badges, instant filtering, and one-click batch download.',
      'Roving photographer dual-upload: roving shots processed in the Photographer Desk now upload both the high-quality raw solo photo and the composite print with template design, ready for sharing and printing.'
    ]
  },
  {
    date: '2026-11-08', title: 'Rush ID Station 1.0.6: Epson L120 photo boost, printer diagnostics & instant cutting line controls', for: ['website'],
    items: [
      'Added Photo Paper & Ink-Tank Boost (+6% contrast, vibrant colors) and 3.5 mm safe margin guard for Epson L120 and L-series printers.',
      'New "Configure Printer" and "Run Head Cleaning" buttons in Review and Settings directly open Windows printer preferences and maintenance.',
      'Instant cutting line control on the Review screen: switch between None (borderless), subtle corner tick marks, and full borders with 1 tap.',
      'Calibration Test Print sheet with CMYK bars, 16-step grayscale ramp, and text sharpness targets.',
      '1-Tap popular Philippine ID combo packages (Combos A through E: Standard Job, Passport + 2×2, Universal Mix, Student Set, Executive 2×2).',
      'Daily print count and revenue tally in Staff Settings.'
    ]
  },
  {
    date: '2026-11-08', title: 'Android app 1.1.19: Auto-open on boot and Kiosk Home Launcher mode', for: ['website'],
    items: [
      'The Android tablet app (v1.1.19) now includes an auto-start feature: when the tablet powers on or restarts, photobooth4u can open automatically.',
      'Long-press anywhere on the screen to open the new Operator Menu and toggle "Auto-Open on Boot: ON / OFF" with a single tap.',
      'For dedicated event booths, "Kiosk Home Launcher" can be enabled in the Operator Menu to set photobooth4u as the tablet\'s default Home app, launching straight into the booth and preventing guests from exiting with the Home button. To access tablet settings or Wi-Fi, tap Exit → Tablet Settings.',
      'Updated the PDF Tablet Guide (page 6 & 9) with step-by-step instructions for kiosk operation and auto-boot setup.'
    ]
  },
  {
    date: '2026-11-08', title: 'My frames: uploaded frames now stay after a restart, and you can keep up to 100', for: ['website', 'app'], app: '1.0.105',
    items: [
      'Fixed: frames you uploaded could show up white (design missing) or not save after the app was restarted, especially offline. The pictures were kept in a small storage that fills up after a few big frames. They are now kept in the larger on-device storage, and pictures saved the old way are moved over the first time they load. Android app 1.1.18 has the same fix.',
      'My frames now holds up to 100 frames (it was 8). Big frame pictures are also downloaded a few at a time, so a new tablet can get them all back from your account.',
      'Frames that already lost their picture cannot be rebuilt by the update. If they were saved to your account, open the booth online once and they come back; otherwise upload them again.'
    ]
  },
  {
    date: '2026-11-08', title: 'Android tablet: your saved layouts, profiles and themes are back after the 1.1.16 update', for: ['website'],
    items: [
      'Android app 1.1.16 fixed a bug that showed the word "null" on the start screen, but on tablets running offline with a normal rental code it also looked for the saved setup in a new place, so uploaded layouts, profiles and My themes seemed to be gone.',
      'Android app 1.1.17 copies them over from the old place the first time it opens, and keeps the old copies. If you already saved something since the update, that is kept and the uploaded layouts you had before are added back to it.',
      'Only tablets running offline with a normal (not Lifetime) rental code were affected. The website and the laptop app were not.'
    ]
  },
  {
    date: '2026-11-08', title: 'Saved profiles keep your vouchers, and offline no longer changes your payment mode', for: ['website', 'app'], app: '1.0.104',
    items: [
      'A saved profile now includes the event’s voucher batches (which codes are unused, used or cancelled). Tap "Use everything" to bring them back; vouchers already used here stay used. "Design only" leaves vouchers alone.',
      'Profiles also remember your paper size, your own paper sizes, keychain printing and the photographer’s one-big-print setting. These load with "Use everything" too, and are included when you export or import profiles.',
      'Fixed: going offline (Android offline mode or the laptop app) used to switch QR payments off and save that. Your chosen payment mode is now kept; offline just skips QR for the moment.',
      'Fixed: a setup changed while offline is now sent to the server when the tablet is back online, instead of the older copy coming back on other devices. Android app 1.1.16 also gives the offline booth the same Lifetime options as online.',
      'Fixed: the start screen showed the word "null" under the button on the Android tablet when the code has no fixed folder name, and the top corner said "Ready · Traditional booth". It now shows just "Ready", and no "null".'
    ]
  },
  {
    date: '2026-11-08', title: 'Canon over USB: no more "Camera disconnected" between photos', for: ['website', 'app'], app: '1.0.103',
    items: [
      'A Canon (for example the 60D) is still saving the photo when the next live view is asked for, and refuses it for a moment. The booth used to treat that as a lost camera and show "Camera disconnected. Reconnecting…" between shots even though the photo was saved. It now waits (up to 45 seconds), asks the camera for live view again every few seconds, and shows the last picture meanwhile.',
      'While a photo is being taken the booth no longer queues live view requests behind it, and a request that only timed out while the camera was busy saving no longer counts as a lost camera. A cable pulled or a camera switched off is still noticed at once.',
      'The camera log now records "live-back" with how long live view took to return after each photo. Same fix on the Android tablet (app 1.1.15).'
    ]
  },
  {
    date: '2026-11-07', title: 'Save power on the welcome screen: dim, then turn the display off', for: ['website', 'app'], app: '1.0.102',
    items: [
      'New in Setup → Welcome screen → "Save power while waiting": choose after how many minutes without a touch the booth dims the screen, and after how many minutes it goes fully black. Both default to Never, so nothing changes until you set them.',
      'One touch wakes the screen. That first touch only wakes it, so a guest bumping the screen never starts a session by accident. Dimming only happens while the welcome screen is showing, never during a session.',
      'On the Android tablet (app 1.1.13) the tablet\'s own brightness is lowered too, then restored on wake. On a laptop the screen goes dark through the booth itself (the monitor backlight stays on).'
    ]
  },
  {
    date: '2026-11-07', title: 'Canon over USB: reconnects by itself after the camera went to sleep', for: ['website', 'app'], app: '1.0.101',
    items: [
      'A Canon (for example the 60D) left idle for a long time could go to sleep and then stay on "Camera disconnected. Reconnecting…" even though it was still plugged in. The booth now starts a clean camera session after a drop, so it comes back by itself without unplugging the camera.',
      'The app now also sends the camera its "stay awake" signal every 10 seconds, including on older EOS models that do not list it.',
      'The message now says when live view stopped (the camera may have gone to sleep) and to switch the camera off and on if it stays that way. On the camera, setting Auto power off to Disable is still the most reliable setup.'
    ]
  },
  {
    date: '2026-11-08', title: 'Android tablet: USB webcams that only work uncompressed (YUYV)', for: ['website'],
    items: [
      'The Android app (1.1.14) now tries the same size as uncompressed YUYV right after MJPEG, before it steps down to a much smaller size. Some webcams show no picture in MJPEG on a weak tablet port or hub but work in YUYV (for example 1280×720). Uncompressed video is limited by USB, so the frame rate is lower (often about 10 fps at 720p).',
      'New under USB webcam preview: "Max YUYV" starts from the biggest uncompressed size the webcam lists. The Exact size list now shows every MJPEG and YUYV size, including bigger YUYV sizes (for a Logitech Brio on a fast USB port).',
      'If a size is rejected or makes the webcam reset, the app now tries that size once more with the USB library\'s bandwidth fix, and remembers it for that webcam if it gives a picture.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: USB webcam that resets itself no longer stays black', for: ['website'],
    items: [
      'The Android app (1.1.12) remembers webcam sizes that make the webcam reset itself (a weak tablet port or unpowered hub) and skips them next time. If the webcam drops out while starting, the app waits for it to come back and continues with the next size.',
      'Standard sizes (720p, 480p) are tried before odd ones, and the size that worked last time is tried first. For a webcam on a tablet, a powered USB hub is still the most reliable setup.',
      'New: under USB webcam preview you can pick one exact size from the list the webcam reports (for example 1280×960). The booth then uses only that size and shows an error instead of falling back. Max no longer skips sizes that reset the webcam before.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: USB webcam no longer stays black', for: ['website'],
    items: [
      'The Android app (1.1.11) now tries only a short list of sensible webcam sizes, including a lower frame rate for weak tablet USB ports, so a webcam that cannot start at full speed falls back in about 30 seconds instead of staying black.',
      'If the webcam still sends no picture, the message now points to a powered USB-C hub, and "Copy camera log" lists every step the app tried so we can see why.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: print straight to a DNP photo printer over USB (beta)', for: ['website'],
    items: [
      'The Android app (1.1.10) now prints to a DNP DS-RX1 / RX1HS, DS620 / DS620A or DS40 plugged into the tablet with a USB OTG cable. No driver, no laptop, and it works offline.',
      '4×6, 3.5×5, 5×7, 6×8 and 6×9, to match the paper loaded, with a Glossy or Matte finish. Strip layouts on 4×6 paper are cut into two 2×6 strips by the printer.',
      'Paper end, ribbon end, an open door or the wrong paper show as a message on the booth.',
      'This is a beta: run a Test print before your event. See the DNP printing guide for the steps.'
    ]
  },
  {
    date: '2026-11-07', title: '360 Desk: Redrawn Effects (Fire, Diamonds, Bats, Lightning and More)', for: ['website', 'app'], app: '1.0.100',
    items: [
      'Fire & Hot Embers now has real flames along the bottom and glowing embers in every shade rising up the frame, not plain red and orange circles.',
      'Diamond Facets are now cut gems whose facets flash as they tumble. Spooky Bats are flapping bat shapes over low mist. Electric Lightning is branching bolts that flash and fade. Twinkling Galaxy has spiked stars, glow and shooting stars.',
      'Also redrawn: Prism Light Leak, Rainbow Strobe, Art Deco, Hexagon Grid, Neon Frame, Stage Spotlights, Summer Flare, Film 8mm, Retro VHS, Midnight Fireworks (real bursts), New Year Sparklers, Stage Smoke, Disco Ball and UV Glow. Soft glows are now really soft instead of flat discs.',
      'In the 360 desk preview, border, light, lightning, fire and firework effects now play the real effect, so the preview matches the finished video.'
    ]
  },
  {
    date: '2026-11-07', title: 'Receipt printers: colour receipts print cleanly, stickers show, fewer lines', for: ['website', 'app'], app: '1.0.99',
    items: [
      'Colour receipts on a thermal printer now print like the black & white ones: the text stays solid black (before, Lightness greyed it and letters like the “1” in “1x SMILES” broke up), and the wall behind the guests, light clothes and faces keep their shading instead of turning white.',
      'Print quality Best no longer washes out receipt photos: it still sharpens, but keeps the light greys.',
      'Stickers on receipts print dark enough to see (a gold star or a pink bow used to come out almost blank).',
      'Fewer lines across the photos: a thermal print is sent in pieces, and each piece now ends in white paper (the gap between photos) where the printer’s short stop cannot be seen. Works for Bluetooth, and for USB and Wi-Fi printers on the tablet. If you still see a line, choose Smooth + slow printing (4) in the smooth-print test.',
      'Lightness for receipts now changes the photos only. Print the darkness test strip again to pick the level that suits your printer.'
    ]
  },
  {
    date: '2026-11-07', title: 'Check for updates by hand, cleaner receipt photos, stickers that match the filter', for: ['website', 'app'], app: '1.0.98',
    items: [
      'New in Setup › Share: App updates, with a Check for updates button on the laptop app and the tablet. Use it any time, also after you chose Later or Close on an update. Windows downloads and installs it, a Mac downloads it for you to drag into Applications, and the tablet asks Android to install it. It needs the internet.',
      'Receipt printers: photos are turned into dots once, at exactly the printer’s width, so they come out cleaner and sharper (before, they were dotted twice and looked grainy). The print preview shows the real dots. For the best result choose Print quality: Best.',
      'Stickers now take on the photo’s look in the saved photo, the QR copy and the print: black & white on a B&W photo, sepia on sepia, and so on. While guests place them they keep their colours; Preview shows the final look. They also print on receipts (as dots on a B&W receipt) and on keychain and strip sheets.',
      'Tablet: the Wi-Fi and QR signs are saved to the Gallery (Pictures › photobooth4u) so you can print them.'
    ]
  },
  {
    date: '2026-11-07', title: 'Edges: fix a printer that cuts off or leaves white at a side', for: ['website', 'app'], app: '1.0.97',
    items: [
      'New in Print settings: Edges (this printer). Move the picture in or out on the top, bottom, left and right, 0.5 mm a press. Saved for each printer, and used for every print on the laptop app, the tablet and the website.',
      'New: Print edge test. It prints a scale of coloured bars on every side. The first bar you can see on a side is the number to set there, so you do not have to guess: the preview cannot show how much a borderless printer enlarges the picture.',
      'Mac: borderless prints on Canon G-series and other AirPrint ink-tank printers are now sent at 98% (96% left a thin white line on a Canon G3030). Fine-tune any side with Edges.'
    ]
  },
  {
    date: '2026-11-07', title: 'Borderless prints on Mac no longer cut off (Canon G3030 and other ink-tank printers)', for: ['app'], app: '1.0.96',
    items: [
      'On a Mac, Canon G-series, Epson and other ink-tank printers added over AirPrint enlarge a borderless picture a little past the paper edge, which trimmed the title, the footer and the characters at the sides. The app now sends the page slightly smaller, so after the printer enlarges it the whole layout fills the paper edge to edge.',
      'SELPHY, DNP, HiTi and other dye-sub printers do not enlarge, so their prints are unchanged. Windows printing is unchanged.',
      'Tip: keep text about 3 mm in from the edges of a frame design. Borderless paper can sit up to about 1 mm off-centre in any inkjet printer.'
    ]
  },
  {
    date: '2026-11-06', title: 'Arrange & Print, and the QR code in a pop-up', for: ['app', 'website'], app: '1.0.95',
    items: [
      'New in Setup, step 7 Session, "After the photos": Show the QR code in a pop-up. After the last photo the finished picture is shown on its own for a few seconds (almost the whole screen on an upright tablet), then a pop-up shows a big QR code with Print and Done. With "Print first before showing QR" on, the pop-up says Printing and the QR code appears when the print is done. Also on the Android tablet app 1.0.107.',
      'New operator button "Arrange & Print" (it is hidden while the booth is locked, so it opens only after the PIN): pick finished strips from this computer, the event gallery or files, put as many as fit on A4, Letter and other paper, and print.',
      'Crop any strip with the new crop window (drag the edges or corners, or lock the shape to 1:3, 2:3 or square), then tap Keychain 2.5×7.5, 2×6 or 4×6 to fit it to that size. Drag strips in the preview to move them.',
      'Fixed: the Print button seemed to do nothing because its messages were hidden behind the screen. They now show under the button, and you can choose the printer for the paper right there.'
    ]
  },
  {
    date: '2026-11-06', title: 'Android Tablet Updates Download Inside the App', for: ['website'],
    items: [
      'Android tablet app 1.0.106: from the next version on, tapping "Update" downloads it inside the app with a progress bar (no browser, no GitHub page), then Android asks "Update this app?".',
      'The first time, Android asks once to allow photobooth4u to install apps ("Allow from this source"); the update then carries on by itself. If the Wi-Fi drops, tap "Try again".'
    ]
  },
  {
    date: '2026-11-06', title: 'Clicker Fix and Smooth Thermal Prints', for: ['app', 'website'], app: '1.0.94',
    items: [
      'Presenter clicker / Space / Enter: each press now does one thing. Between photos it skips the wait, instead of also showing "Getting the camera ready… one moment".',
      'Thermal receipt printers (Bluetooth, USB and Wi-Fi): lines across the picture? In Print settings, "Print a smooth-print test strip" prints one strip in four ways (Careful, Standard, Smooth, Smooth + slow). Tap the cleanest one; it is saved for that printer only.'
    ]
  },
  {
    date: '2026-11-06', title: 'Bigger Sticker Screen, Printers That Reconnect by Themselves, and Arrange & Print', for: ['app', 'website'], app: '1.0.93',
    items: [
      'Stickers: the Decorate screen now fills the whole screen. The photo is as big as it fits and nothing covers it; stickers sit beside it (landscape) or in a sheet under it that guests can pull up or down (portrait). Bigger sticker buttons, and Smaller / Bigger / Turn / Copy / Remove appear right next to the selected sticker.',
      'Stickers: zoom in to place small stickers (the + / Fit / − buttons, a two-finger pinch on the photo, or a double-tap). Pinch a sticker to resize and turn it.',
      'Bluetooth receipt printer (Android app 1.0.104): the tablet no longer forgets the printer when it is switched off or the app is closed. It links to it again by itself when it is switched back on, and a print sent while it was off waits and goes out when it is back, instead of opening the print screen.',
      'USB SELPHY and other USB printers (Android app): switched off and on again, or unplugged and plugged back in, the booth finds the printer again by itself and keeps its paper, colour and quality settings. Prints sent while it was off wait for it.',
      'New Printer status chip in the operator dock: green when ready, amber while reconnecting, red when a printer is off (with how many prints are waiting). Tap it to reconnect now, send a test print, clear waiting prints or open Print settings. Guests never see it on a locked booth.',
      'Laptop app: Arrange & Print lets you browse the pictures already saved on this laptop (this event first, then older ones) and print them.'
    ]
  },
  {
    date: '2026-11-06', title: 'Laptop App Opens Again (Fix for 1.0.90 and 1.0.91)', for: ['app'], app: '1.0.92',
    items: [
      'Laptop app versions 1.0.90 and 1.0.91 could stay stuck in the background without opening a window. This version fixes it. Because the stuck app cannot update itself, download and install this version from the app download page (/app/). Your settings, photos and licence are kept.'
    ]
  },
  {
    date: '2026-11-06', title: 'Laptop App: Choose Where to Save the Wi-Fi Sign', for: ['app', 'website'], app: '1.0.91',
    items: [
      'The Wi-Fi sign now opens a Save As box (File Explorer on Windows, Finder on Mac) so you pick the folder. It starts in the folder you used last time. If you cancel, nothing is saved and the app says so.'
    ]
  },
  {
    date: '2026-11-06', title: 'Vouchers: Every Payment Option Now Shows Up, Including Option 3', for: ['app', 'website'], app: '1.0.90',
    items: [
      'Fixed: when you added a third (or fourth) payment option, it was missing from the voucher picker next to "Make vouchers", so you could not make or print vouchers for it. Every option now appears as soon as you add, rename or remove it.',
      'Also in this release: named Saved profiles (save a whole setup under a name and load it on any device on your code), and small animated GIFs can be used as pictures.'
    ]
  },
  {
    date: '2026-11-06', title: 'Many Photo Spots, Few Photos: Every Strip Repeats the Same Photos', for: ['app', 'website'], app: '1.0.89',
    items: [
      'New option under your own frame: "Every strip repeats the same N photos, top to bottom". With 24 photo spots in 8 strips of 3 and N = 3, guests take just 3 photos and every strip shows photo 1, 2, 3 from top to bottom. Spots you add later repeat too. N is suggested from your frame; set it to 5 for strips of 5.',
      'In Edit photo spots, the number on each box shows which photo it uses. The setting is saved with the frame and shared with other devices on the same code.'
    ]
  },
  {
    date: '2026-11-06', title: 'Up to 40 Photo Spots per Frame and a Copy Spot Button', for: ['app', 'website'], app: '1.0.87',
    items: [
      'Your own frames can now have up to 40 photo spots (it was 8), for big sheets with many small pictures. Add spot, Split and Find again all use the new limit.',
      'New Copy spot button in Edit photo spots: select a box and tap Copy spot to make another with the same size and tilt, then drag it into place. The copy becomes the next photo in the order.'
    ]
  },
  {
    date: '2026-11-06', title: 'Prints per Payment Option (Softcopy Only), Thermal Darkness Test, Bluetooth Printer Fixes', for: ['app', 'website'], app: '1.0.86',
    items: [
      'Each payment option now has its own Prints choice: the default, No print (softcopy only), or 1 to 5 prints. A softcopy-only option still gives the QR, download and GIF you set in Extras, but the guest gets no paper print (no Print button, no auto-print). Guests see "Softcopy only, no print" or "1 print included" under each option, and voucher tickets show it too. Options must have different labels; a repeated label is numbered automatically.',
      'Thermal prints too dark: the Lightness setting now works on black and white receipt layouts (it used to have no effect on their photos). New Print a darkness test strip button under Print quality prints five Lightness levels on one strip; tap the one that looks best and it is saved for that printer.',
      'Small 58mm Bluetooth printers that printed gibberish, hex text or gaps: jobs are now sent in small pieces with short pauses, in shorter image bands, with no cut command on 58mm. The Test print now uses the right 58mm width. New "Prints gibberish?" checks in the Bluetooth printer settings (text, small picture, full strip) with Speed and Picture mode (Compatibility) choices. The GZQIANJI GZM5803L printer is recognised.',
      'Android app: the tablet now sends Bluetooth print data in paced pieces itself, and a failed print no longer makes the tablet forget the chosen printer.'
    ]
  },
  {
    date: '2026-11-05', title: '360 Desk: Rendered Effects Move Exactly Like the Live Preview', for: ['app', 'website'], app: '1.0.85',
    items: [
      'The 360 desk now draws the particle effect for the finished video with the same engine as the live preview, frame by frame, using your Effect Motion & Behavior settings (Trajectory, Speed, Opacity, Size, Wobble, Location). What moves in the preview now moves the same way in the rendered video.',
      'This covers the particle effects (confetti, hearts, petals, bubbles, snow, dust, stars and so on). Border, light and strobe effects keep their own look.',
      'Rendering a clip with an effect takes a few seconds longer while the effect is drawn. If it cannot be drawn, the video is still made with the previous effect loop.'
    ]
  },
  {
    date: '2026-11-05', title: 'No 360 Buttons on Android, Epson Borderless Test Mode (Android)', for: ['app'], app: '1.0.97',
    items: [
      'The 360 desk and Record 360 buttons no longer show in the Android app (phones and tablets). They stay in the laptop app and on the website.',
      'For testing only (hidden unless Admin turns the debug option on): the Epson L-series built-in Epson mode has Normal 720 dpi and Best 1440 dpi test qualities for 4x6 glossy photo paper, now with borderless as well. It has not been tried on every printer, so the normal printing choices stay as they are.'
    ]
  },
  {
    date: '2026-11-05', title: 'Choose Your Own Booth Wi-Fi Name and Password', for: ['app'], app: '1.0.84',
    items: [
      'Windows laptop: the booth Wi-Fi (the laptop making its own network, no router needed) now has a name and password you choose in Setup. Press "Save name & password"; if the booth Wi-Fi is on, it restarts with the new ones. It still needs no internet.',
      'Android tablet (Android 10 and newer): you can set the booth Wi-Fi password and the end of its name (Android always starts it with DIRECT-pb-). If Android makes its own network instead, Setup tells you the name it used and the Join QR uses that one.',
      'Android tablet: a new "Use the phone\'s own Hotspot instead" button opens Android\'s Hotspot settings, where any name and password can be chosen; type the same ones in the Wi-Fi boxes so the Join QR matches. The app no longer shows a made-up name when the phone\'s own Hotspot is on.',
      'Mac: Setup now explains that the name and password are set in System Settings > Sharing, and no longer locks the Wi-Fi boxes to a name the Mac is not using.'
    ]
  },
  {
    date: '2026-11-05', title: 'Insta360 and USB Camera Help, Epson L-Series Printing (Android)', for: ['app'], app: '1.0.95',
    items: [
      'If an Insta360 (or another USB camera) is plugged into the tablet and does not show as a webcam, the Camera panel and the camera error now say why: for example that it is in phone-control, picture-transfer or USB-drive mode and needs its USB mode set to Webcam on the camera, or that Android still needs your OK to use it. Every USB device the tablet sees is also written to the camera log (Copy camera log).',
      'Epson L3210, L3200, L3230, L1210, L1230 and L1250 printers now warn when a paper size cannot print borderless (these printers do borderless only on 4x6 in, 3.5x5 in, 16:9 wide and 100x148 mm) and print with a normal border on other sizes.',
      'Epson L8050, L3210 and L3276 over USB can be switched to the app\'s own Epson mode (Normal / Draft quality, colour mode, borderless) from the printer list. The default stays driverless printing.'
    ]
  },
  {
    date: '2026-11-05', title: 'Link Vouchers to Printers, Print Quality for Each Printer, More Thermal Printers', for: ['app', 'website'], app: '1.0.83',
    items: [
      'New optional switch in Camera & printer: Link vouchers to printers. When it is on, each payment option in Setup gets a Printer choice, and guests who pay or use a voucher for that option print on that printer, with that printer\'s own colour, brightness and quality. It is off by default, and a device that does not have the linked printer prints the normal way, by paper size.',
      'Print quality (Best, Normal, Draft) for each printer set up through the Print Helper or the laptop app. Best is the default, as before, and is only used if the printer driver offers it. It is saved per printer.',
      'More thermal receipt printers are listed and recognised: Rongta RP and RPP series (RP30, RPP30, RP326, RP80, RPP300), ArcticBreeze RP30, HPRT, Gprinter and iDPRT.'
    ]
  },
  {
    date: '2026-11-05', title: 'Print Queue, Separate Settings for Each Printer, Vouchers Linked to Printers and RP30 Thermal Printer (Android)', for: ['app'], app: '1.0.94',
    items: [
      'Print queue: while a printer is still printing, the next guest\'s print waits in line instead of the Print button staying on "Printing, please hold". Each printer has its own line, so a Canon SELPHY and a Bluetooth thermal printer print at the same time. The button shows how many prints are in the queue. If a queued print fails, the Android print screen opens so the sheet is not lost.',
      'Each printer now keeps its own colour, brightness, photo layout and print quality (Wi-Fi and USB quality, colour mode and paper type too). They are remembered by printer name, so a USB printer that is unplugged and plugged in again finds its settings, and the Bluetooth printer keeps its own settings by its Bluetooth name.',
      'Use two Wi-Fi or USB printers: pick the printer for each paper size, for example the Brother for A4 and the Epson for 4x6.',
      'Optional Link vouchers to printers switch (Camera & printer): each payment option can print on its own printer.',
      'Thermal printers: RP30 / RP30A-UB, Rongta RP and RPP series, ArcticBreeze, HPRT, Gprinter and iDPRT are recognised over Bluetooth and USB. A USB printer the app does not know, including one that only calls itself "USB Printer Port", can now be tried as a thermal receipt printer: choose a Receipt paper size, then tap it in the printer list.'
    ]
  },
  {
    date: '2026-11-05', title: 'Colour Correction for Prints Only, Thermal Print Quality (Best, Normal, Draft)', for: ['app', 'website'], app: '1.0.82',
    items: [
      'Lightness and Red, Green and Blue correction now change only the printed photo and the print preview. The guests\' camera, the photos on screen and the digital copies stay natural.',
      'Thermal printers: new Print quality choice (Best, Normal, Draft) when a receipt paper is selected. Best is sharper with balanced darkness, Normal is the standard look, Draft uses coarse dots for quick tests. It is remembered for each printer.',
      'The old "System Print Dialog · All available printers" button is now "Android print screen · any printer", with a note to use Bluetooth or a Receipt printer for thermal photos.'
    ]
  },
  {
    date: '2026-11-05', title: 'Colour for Prints Only, Thermal Quality, Calmer Print Settings and Lock PIN Fix (Android)', for: ['app'], app: '1.0.93',
    items: [
      'Lightness and colour correction now change only the print and the print preview, not the guests\' camera or screen.',
      'Print quality for thermal printers: Best, Normal or Draft.',
      'Calmer screens: helper sentences show as one line (tap to read it all), and photo size, borderless and colour correction sit behind one "More options" row in Print settings.',
      'Fixed: saving the lock PIN in the Android offline app no longer fails with "Check the internet". The PIN stays on the tablet and survives a code renewal.'
    ]
  },
  {
    date: '2026-11-05', title: 'Separate Colour and Photo Layout for Each Printer, with Printer Profile Chips', for: ['app', 'website'], app: '1.0.81',
    items: [
      'Each printer now keeps its own Lightness and Red, Green and Blue correction. Use it when a thermal printer prints too dark but a photo printer does not. Choosing a printer, or a paper size mapped to another printer, loads the values saved for that printer.',
      'Printer profile chips: tap a printer to edit its colour without changing the paper size. The printer in use is tagged, and a dot marks printers with custom colour. Copy colour from another printer in one tap.',
      'The Lightness & Colour Correction section is collapsed by default. Its header shows the current values (for example Light +25, R -5) and a dot when something is adjusted; Reset stays in the header.',
      'Photo size on paper and Borderless are also remembered per printer and switch with the paper size.',
      'Your existing adjustment stays with the printer you use now; other printers start at 0. Per-printer values are included in the saved setup, so they carry over when you restore it.'
    ]
  },
  {
    date: '2026-11-05', title: 'Separate Colour and Photo Layout for Each Printer (Android)', for: ['app'], app: '1.0.92',
    items: [
      'Each printer keeps its own Lightness and Red, Green and Blue correction, plus its own photo size on paper and Borderless setting. Printer profile chips let you edit another printer without changing the paper size.',
      'Lightness & Colour Correction is collapsed by default and shows its current values in the header.'
    ]
  },
  {
    date: '2026-11-05', title: 'Animated 360 Effects Now Really Move, with Trajectory, Size, Wobble & Location', for: ['app', 'website'], app: '1.0.80',
    items: [
      'Fixed static effects: most of the 40 animated effect loops froze after a few frames, so effects looked like a still picture in the finished video. All loops are rebuilt and now move through the whole clip.',
      'Effect Motion & Behavior now applies in the render, not only in the preview: Trajectory (vortex, falling, rising, burst, beat pulse, wind drift), Size, Wobble and Location (full screen, centre, edges, top, bottom). Frame-style effects such as neon and fire borders keep their own look.',
      'Updated effects reach existing installs: the app refreshes its built-in effect library on start, and keeps any effects you added yourself.',
      'The effect library is a little larger (about 20 MB) because the loops are now truly animated.'
    ]
  },
  {
    date: '2026-11-05', title: 'Animated 360 Effects Now Really Move, and No 360 Buttons on Phones (Android)', for: ['app'], app: '1.0.91',
    items: [
      'Record 360 and 360 desk are no longer shown on Android phones; they stay on tablets (and in the laptop app).',
      'Matches the laptop app version for the 360 desk. Effects are applied by the laptop app, which now renders them with real motion and the Trajectory, Size, Wobble and Location settings.'
    ]
  },
  {
    date: '2026-11-05', title: 'Safer 360 Studio Dialogs, Working Save-as-Preset, Smoother Thumbnails & Re-pick Spinner', for: ['app', 'website'], app: '1.0.79',
    items: [
      'In-page confirmations: Clear list and Remove now open an on-screen box (Cancel is selected by default) and ask whether to keep or delete the original files.',
      'Save as preset now opens a proper name box. The old pop-up does not exist in the laptop app, so naming a preset could fail.',
      'Smoother queue: thumbnails no longer reload while a video renders.',
      'Preset list shows “Current look” instead of a blank box, and Line 2 text now starts at a more readable size.',
      'Spin & Print preview shows a spinner and locks the controls while it takes the frames again after a re-pick.'
    ]
  },
  {
    date: '2026-11-05', title: 'Safer 360 Studio Dialogs, Save-as-Preset & Re-pick Spinner (Android)', for: ['app'], app: '1.0.90',
    items: [
      'On-screen confirmations for Clear list and Remove, a working Save as preset name box, steadier thumbnails, and a spinner while Spin & Print re-picks frames.'
    ]
  },
  {
    date: '2026-11-05', title: 'Sticker Packages, Decorate Timer, Resize & Rotate Handles & a Fixed Live Preview', for: ['app', 'website'], app: '1.0.78',
    items: [
      'Sticker packages: Usual, Birthday, Christmas, Debut, Party and Christening (27 new stickers and banners). Tick which packages guests can use; guests switch between them with tabs.',
      'Decorate timer: choose 15 seconds to 2 minutes, or No timer so guests take their time and tap Done when finished.',
      'Resize and rotate in the sticker’s own box: drag a corner to resize and the round handle to turn, on the guest screen and the Setup preview.',
      'Preview button on the guest sticker screen shows the final photo without the box or handles.',
      'Live 360 preview no longer disappears once the Share QR or progress bar appears, and the guest QR codes under it are compact side-by-side cards.'
    ]
  },
  {
    date: '2026-11-05', title: 'Sticker Packages, Decorate Timer & Resize / Rotate Handles (Android)', for: ['app'], app: '1.0.89',
    items: [
      'Six sticker packages the operator can tick for guests, a selectable decorate timer (or none), and drag-handle resize and rotate on the guest sticker screen.',
      'Fixed the 360 live preview collapsing when the QR codes or progress bar appear.'
    ]
  },
  {
    date: '2026-11-05', title: '360 Studio Polish: Working Share QR, Rendered Preview, Spin & Print Preview & Tablet Layout', for: ['app', 'website'], app: '1.0.77',
    items: [
      'Share + QR fixed: both QR codes show again next to the video, the Wi-Fi password stays hidden until you tap Show, and Back to Studio brings the live preview back.',
      'Rendered preview: a finished video opens as the rendered result with a Rendered badge, the overlay preview switches itself off, and one tap on Edit again unlocks the options.',
      'Spin & Print preview: see the strip or keychain layout and the frames in the 360 booth first, re-pick moments, switch Solo or Multi-angle, choose the paper, then continue to print.',
      'Typing fixed: spaces now work in every text line (the remote-shutter key no longer steals them), with length limits and a too-wide warning.',
      'Easier studio: mute button for the preview, locked options still scroll, the first clip is selected automatically, and a bigger preview that matches the clip shape.',
      'Tablets and phones: stacked layout with the preview on top, finger-sized buttons, and a header and timeline that fit narrow screens.'
    ]
  },
  {
    date: '2026-11-05', title: '360 Studio Polish: Share QR, Rendered Preview, Spin & Print Preview & Tablet Layout (Android)', for: ['app'], app: '1.0.88',
    items: [
      'Working Share + QR, rendered preview with Edit again, mute button, and the Spin & Print preview with re-pick and paper size.',
      'Stacked tablet layout with the live preview on top and finger-sized buttons for the Samsung tablet in portrait.'
    ]
  },
  {
    date: '2026-11-05', title: 'Seamless Side-by-Side 360 Studio Desk, Tab Alignment & Controls Lock Engine', for: ['app', 'website'], app: '1.0.76',
    items: [
      'Seamless Two-Column Studio Layout: Fixed structural grid nesting so editing options and sticky live preview operate harmoniously side-by-side on all screen resolutions without overlap.',
      'Navigation Tab Alignment: Synchronized tab bar with control sections in exact 1:1 order (Queue -> Presets -> Look -> Text -> Audio) with smooth in-card scrolling.',
      'Active Processing Lock: Editing controls automatically dim and lock during video rendering while keeping the Unlock/Edit banner interactive.',
      'WYSIWYG Drag & Corner-Resize: Enhanced interactive canvas text bounding box and handle hit detection.'
    ]
  },
  {
    date: '2026-11-05', title: 'Seamless Side-by-Side 360 Studio Desk & Navigation Alignment (Android)', for: ['app'], app: '1.0.87',
    items: [
      'Two-Column Studio Layout: Restored side-by-side editing controls and sticky live preview for tablets.',
      'Tab & Section Synchronization: Seamless scrolling from header tabs directly to target control panels.',
      'Controls Lock Engine: Visual locking banner and dimming during background rendering.'
    ]
  },
  {
    date: '2026-11-05', title: 'Universal Bluetooth Remote, Beat-Drop Speed Ramping, 3D LUTs & Live TV Audience Sync', for: ['app', 'website'], app: '1.0.75',
    items: [
      'Seamless Side-by-Side 360 Studio Layout: Restored 2-column workspace ensuring editing tabs and live sticky video preview operate harmoniously side-by-side without overlap.',
      'Spin & Print: High-resolution frame extraction for 3-shot photo strips, keychains, and 4R physical prints directly from 360 videos, with QR codes linking back to the clip.',
      'Universal Bluetooth Remote & Gamepad Shutter: Hands-free triggering via wireless selfie remotes (VolumeUp/Down), presentation clickers (PageDown/ArrowRight), foot pedals, and pocket gamepads (HTML5 Gamepad API).',
      'Beat-Drop Sync Speed Ramping: Custom beat drop timestamp synchronization switching from 2× speed to 0.25×/0.5× slow motion with coordinated optical white flash and dynamic punch-in zoom.',
      'Cinematic 3D LUT Color Engine: Professional color grading filters (Glamour B&W, Blockbuster Teal & Orange, Golden Hour, Vibrant Pop, Vintage Film) with live interactive preview.',
      'Live TV Audience Sync: /wall screen features synchronized crowd countdowns ("3... 2... 1... JUMP! 🎬") and instant celebration replay banners ("✨ New 360 Spin Ready!") when new clips land.',
      'Smart Inbox Watcher: Defensive file stability checking guarding against incomplete or truncated video processing during slow SD card or Wi-Fi transfers.'
    ]
  },
  {
    date: '2026-11-05', title: 'Universal Bluetooth Remote, Beat-Drop Speed Ramping, 3D LUTs & Live TV Audience Sync (Android)', for: ['app'], app: '1.0.86',
    items: [
      'Spin & Print Integration: Automatic photo strip generation and keychain printing from 360 clips on tablet.',
      'Universal Remote Triggering: Pocket Bluetooth selfie clickers and volume button triggering support.',
      'Cinematic Color LUTs & Beat-Drop Ramping: Real-time look grading and synchronized speed transitions.'
    ]
  },
  {
    date: '2026-11-04', title: 'Square 1:1 Live Aspect, 40 Animated FX & Multi-Trajectory Motion Engine', for: ['app', 'website'], app: '1.0.74',
    items: [
      'Square 1:1 Live Aspect Ratio: Added non-letterboxed 1:1 Instagram square format with object-fit cover fill and continuous live looping.',
      'Full 40 Animated Effects Catalog: Unlocked all 40 professional animated particle overlays across 6 categories (Celebration, Weddings, VIP, Nightlife, Action, and Holidays).',
      'Live Physics & Motion Trajectories: Added real-time trajectory controls (360° Vortex Orbit, Falling Cascade, Rising Float, Radial Burst, Beat Pulse, Wind Drift).',
      'Motion Customizer Controls: Interactive sliders for effect speed (0.2x-3.0x), opacity (10%-100%), scale (0.4x-2.5x), turbulence/wobble, and screen focus areas.',
      'Spin & Print Hero Frame Extraction: Native high-res video frame extraction for multi-shot acrylic keychain strips and physical prints.'
    ]
  },
  {
    date: '2026-11-04', title: 'Square 1:1 Live Aspect, 40 Animated FX & Multi-Trajectory Motion Engine (Android)', for: ['app'], app: '1.0.85',
    items: [
      'Square 1:1 Live Aspect Ratio: Instant square format with continuous looping preview without freezing.',
      'Full 40 Animated Effects Catalog: Complete access to all 40 overlay effects across 6 categories directly on tablet.',
      'Live Physics Motion Engine: 6 selectable movement paths with live customizable speed, opacity, scale, and focus zones.'
    ]
  },
  {
    date: '2026-11-04', title: 'Multi-Collage Presets & Dynamic Guest Layout Selection', for: ['app', 'website'], app: '1.0.73',
    items: [
      'Collage Presets System: Operators can now save, update, and manage multiple named collage sheet arrangements (e.g. Collage A with 3-shot strips, Collage B with 4-shot strips) directly in Step 3.',
      'Dynamic Guest Layout Selection: When multiple collage presets exist and "Let guests choose layout" is enabled, guests can choose between different collage designs. The booth automatically adjusts camera countdowns, required shot count, and sheet placement per preset.',
      '2.5×7.5 in Keychain Compatibility: Perfect scale consistency when printing multiple keychain strip designs across A4, 4R, and other paper sizes.',
      'Persistent Preset Storage: Presets are serialized with the event setup and restored automatically across booth reboots.'
    ]
  },
  {
    date: '2026-11-04', title: 'Multi-Collage Presets & Dynamic Guest Layout Selection (Android)', for: ['app'], app: '1.0.84',
    items: [
      'Multi-Collage Presets: Create and switch between multiple saved collage layouts on the tablet.',
      'Dynamic Guest Choice: Guests can pick between different collage presets on the start screen with automatic camera countdown and shot count adjustment.',
      'Keychain & Sheet Scaling: Flawless scaling for 2.5×7.5 in acrylic keychains when ganged on A4, 4R, and standard paper.'
    ]
  },
  {
    date: '2026-11-04', title: 'Post-Session Guest Sticker Customisation & Print-First Mode', for: ['app', 'website'], app: '1.0.72',
    items: [
      'Post-Session Guest Sticker Customisation: In Setup (Extras -> Stickers), enable the new toggle to let guests decorate and personalize their photos with stickers right after taking pictures and before printing.',
      'Touch-Friendly Guest Sticker Studio: Includes a 35-second countdown timer, drag-and-drop placement, pinch/tool resizing, rotation, duplicate, and delete controls on the preview canvas.',
      'Non-Destructive Host Templates: Preset host stickers configured in Setup remain protected and intact, while guest stickers are safely reset between sessions.',
      'Print First Before Showing QR: Added toggle in Print Settings (Automatic printing card) to print first, showing a clean "Printing your photo…" indicator and revealing the QR code once printing completes.',
      'Universal Output Sync: Guest stickers automatically reflect across all physical prints, uploaded QR downloads, and saved device backups.'
    ]
  },
  {
    date: '2026-11-04', title: 'Post-Session Guest Sticker Customisation & Print-First Mode (Android)', for: ['app'], app: '1.0.83',
    items: [
      'Post-Session Guest Sticker Customisation: Enable the new toggle in Extras -> Stickers to let guests add stickers to their photo before printing.',
      'Touch & Drag Placement: Interactive sticker tray with sizing, rotation, and deletion tools optimized for tablet touchscreens.',
      'Print First Before Showing QR: Option in Print Settings to print first and reveal the QR code once printing finishes.',
      'Isolated Guest State: Host template stickers stay untouched; guest stickers cleanly reset for each new guest.'
    ]
  },
  {
    date: '2026-11-04', title: 'Real-Time Text/Color WYSIWYG & Dedicated Dual-QR Output Modal', for: ['app', 'website'], app: '1.0.71',
    items: [
      'Instant Live Text & Color Updates: Text inputs and real-time color picker update the preview canvas live on input, without needing to re-edit.',
      'Live Draft Mode for Rendered Videos: Changing styling on previously processed clips automatically switches to raw looping footage with live overlays on top.',
      'Dedicated Output & Share Modal: Clicking Share + QR opens a presentation modal featuring Booth Wi-Fi (Step 1), finished video, and Guest Download QR (Step 2).',
      'QR Code Visibility Toggle: Toggle between dual QR sharing and full-screen clean video preview with the "Hide QR Codes" switch.',
      'One-Click Share Link Copy: Easily copy the guest download link to clipboard directly from the share modal.'
    ]
  },
  {
    date: '2026-11-04', title: 'Real-Time Text/Color WYSIWYG & Dedicated Dual-QR Output Modal (Android)', for: ['app'], app: '1.0.82',
    items: [
      'Instant Live Text & Color Updates: Text inputs and real-time color picker update the preview canvas live on input, without needing to re-edit.',
      'Live Draft Mode for Rendered Videos: Changing styling on previously processed clips automatically switches to raw looping footage with live overlays on top.',
      'Dedicated Output & Share Modal: Clicking Share + QR opens a presentation modal featuring Booth Wi-Fi (Step 1), finished video, and Guest Download QR (Step 2).',
      'QR Code Visibility Toggle: Toggle between dual QR sharing and full-screen clean video preview with the "Hide QR Codes" switch.',
      'One-Click Share Link Copy: Easily copy the guest download link to clipboard directly from the share modal.'
    ]
  },
  {
    date: '2026-11-04', title: 'Full-Page 360 Studio Desk with Sticky Live Side Preview & Turntable Simulation', for: ['app', 'website'], app: '1.0.69',
    items: [
      'Full-Page 360 Studio Interface: Redesigned the 360 booth desk from a modal prompt into a dedicated full-page studio workspace with quick-jump navigation tabs.',
      'Sticky Real-Time Side Preview: WYSIWYG canvas pinned beside controls updates instantly as you customize frames, text lines, fonts, colors, and vertical placement.',
      'Turntable Simulation Stage: Live preview stage renders an animated rotating 360 platform and camera rig when no video is loaded, enabling instant branding preview.',
      'Interactive Playback & Timeline Scrubber: Seek bar with live timecode counter and multi-speed controls (0.25x, 0.5x, 1.0x, 2.0x) for precise video inspection.',
      'Animated Particle FX Simulation: Live particle preview simulates gold dust, confetti, hearts, and bokeh directly on stage.'
    ]
  },
  {
    date: '2026-11-04', title: 'Full-Page 360 Studio Desk with Sticky Live Side Preview & Turntable Simulation (Android)', for: ['app'], app: '1.0.80',
    items: [
      'Full-Page 360 Studio Interface: Redesigned the 360 booth desk from a modal prompt into a dedicated full-page studio workspace with quick-jump navigation tabs.',
      'Sticky Real-Time Side Preview: WYSIWYG canvas pinned beside controls updates instantly as you customize frames, text lines, fonts, colors, and vertical placement.',
      'Turntable Simulation Stage: Live preview stage renders an animated rotating 360 platform and camera rig when no video is loaded, enabling instant branding preview.',
      'Interactive Playback & Timeline Scrubber: Seek bar with live timecode counter and multi-speed controls (0.25x, 0.5x, 1.0x, 2.0x) for precise video inspection.',
      'Animated Particle FX Simulation: Live particle preview simulates gold dust, confetti, hearts, and bokeh directly on stage.'
    ]
  },
  {
    date: '2026-11-04', title: 'Thermal Layouts, Dual Pricing, Custom Labels & Tiered Vouchers (Android)', for: ['app'], app: '1.0.79',
    items: [
      'Dual Option Selection & Pricing: Guests choose between Thermal (e.g. ₱50) and Canon/Dye-Sub Color (e.g. ₱100) directly on the welcome pay screen.',
      'Fully Customizable Option Labels: Personalize labels like "Thermal 50" or "Canon Color 100", seamlessly reflected on welcome buttons, layout picker badges, and printed voucher tickets.',
      'Tiered Vouchers & Auto-Routing: Generate separate vouchers locked to receipt or photo layouts; printer auto-switches between Bluetooth/USB thermal and dye-sub photo printers.',
      'Expanded Thermal Layout Suite: 6 new receipt formats (Solo 1-shot, Duo 2-shot, and 4-shot strip in both B&W and Color) with dynamic receipt height calculation.',
      'Custom Receipt Note & Ready Designs: Enter custom event messages/social handles for receipt slips, plus 5 instant ready-made thermal themes (Minimalist Cafe, Vintage Wedding, Cinema Ticket, Party Strip, and Color Cafe).'
    ]
  },
  {
    date: '2026-11-04', title: 'Dual Pricing, Custom Tier Labels, B&W & Color Thermal Layouts & Ready Designs', for: ['app', 'website'], app: '1.0.68',
    items: [
      'Dual Option Selection & Pricing: Guests choose between Thermal (e.g. ₱50) and Canon/Dye-Sub Color (e.g. ₱100) directly on the welcome pay screen.',
      'Fully Customizable Option Labels: Personalize labels like "Thermal 50" or "Canon Color 100", seamlessly reflected on welcome buttons, layout picker badges, and printed voucher tickets.',
      'Tiered Vouchers & Auto-Routing: Generate separate vouchers locked to receipt or photo layouts; printer auto-switches between Bluetooth/USB thermal and dye-sub photo printers.',
      'Expanded Thermal Layout Suite: 6 new receipt formats (Solo 1-shot, Duo 2-shot, and 4-shot strip in both B&W and Color) with dynamic receipt height calculation.',
      'Custom Receipt Note & Ready Designs: Enter custom event messages/social handles for receipt slips, plus 5 instant ready-made thermal themes (Minimalist Cafe, Vintage Wedding, Cinema Ticket, Party Strip, and Color Cafe).'
    ]
  },
  {
    date: '2026-11-04', title: '360 Live Studio Preview, Custom PNG Frame Upload & Dynamic Placement', for: ['app', 'website'], app: '1.0.67',
    items: [
      'Live Studio Preview Stage: Real-time layered canvas preview lets you view designer frames and custom overlays overlaid over the playing video before committing to rendering.',
      'Custom PNG Frame Upload: Upload bespoke wedding or corporate event PNG frames with instant real-time canvas rendering.',
      'Dynamic Text Placement & Y Slider: Position text at Top (12%), Upper Third (28%), Center (50%), Lower Third (72%), Bottom (84%), or drag a 5%-95% slider with live left/center/right alignment and font choices.',
      'Interactive Live Speed Preview: Preview 0.25x, 0.5x, 1.0x, and 2.0x playback speeds dynamically right on the player stage.',
      'Persistent Video Dismissal & Safe Deletion: Cleared videos stay cleared across app restarts with localStorage persistence and optional file deletion from disk.',
      'System Lag & GPU Stall Protection: CPU threads capped with below-normal process priority and an automated 10-second watchdog timer for hardware GPU mode fallback to CPU.'
    ]
  },
  {
    date: '2026-11-04', title: 'Wedding Floral & Gold Designer Frames, Dynamic Slow-Mo Zoom & Beat Flash', for: ['app', 'website'], app: '1.0.66',
    items: [
      'Wedding Floral & Gold Designer Frame: High-end 4-layer composition matching commercial Touchpix & dslrBooth standards — double metallic gold borders, botanical eucalyptus foliage, ruffled peach & blush garden roses, golden berry sprigs, bottom-left couple calligraphy ("Yustina & George"), and bottom-right serif date ("07.31.2022").',
      'Art Deco Gala & Neon Cyberpunk Frames: Additional luxury templates including 1920s Great Gatsby stepped chevron borders and electric cyan / magenta neon club designs.',
      'Dynamic Slow-Mo Punch-In Zoom: Automatic 1.0x to 1.14x camera push-in and pull-out during slow-motion segments, mimicking an expensive robotic camera arm.',
      'Beat Drop Optical Flash: 0.12s optical white flash at slow-motion speed changes and turnaround points to punctuate music drops and mask framerate changes.',
      'New UI Controls: Designer frame selector, Dynamic zoom toggle, and Beat flash toggle right in the 360 booth settings panel.'
    ]
  },
  {
    date: '2026-11-04', title: 'High-Fidelity 1080p Spin-FX Overlays & Text Overlay Fix', for: ['app', 'website'], app: '1.0.65',
    items: [
      'Redesigned 1080p Animated Spin-FX: Upgraded all 40 particle and overlay loops from low-resolution specks to rich, high-definition 1080p graphics.',
      'Iconic Dollar Bills Rain: Realistic 3D hundred-dollar banknotes with intaglio borders, portrait oval vignettes, holographic security ribbon, corner cartouches, and 3D tumbling physics.',
      'Commercial-Grade Confetti & Streamers: Heavy metallic foil rectangles with 2D yaw rotation, 3D tumbling, specular light sheen, and twisting party streamers.',
      'Festive Balloons & Satin Hearts: 180-280px party balloons with spherical shading, tied knot, and wavy string; large 3D glossy hearts with mathematical cardiac curves.',
      'Organic Rose Petals & Optical Bokeh: Teardrop velvety crimson rose petals with flutter physics; 180-440px prime lens optical bokeh discs with spherical aberration rims.',
      'Text Overlay Bug Fix: Resolved issue where empty modal input cleared global Line 1 text, decoupled text rendering from static frame borders, and enabled automatic text overlay generation.'
    ]
  },
  {
    date: '2026-11-04', title: '360 Photo & Video Booth Overhaul: Hardware GPU Acceleration, Sharing Station & Live Wall', for: ['app', 'website'], app: '1.0.64',
    items: [
      'Scale-First & Hardware GPU Acceleration: Optimized FFmpeg filtergraph scales inputs first, probes for GPU encoders (NVIDIA NVENC, Apple VideoToolbox, Intel QuickSync, AMD AMF), and renders 360 spins up to 3× faster.',
      'High-FPS Real Slow-Motion: Native support for 60 fps and 120 fps recordings — slow-motion effects use real captured frames directly without waiting for software motion interpolation.',
      'Sharing Station (/station): Dedicated iPad/tablet kiosk view with live polling, instant QR code modals, and 35-second auto-reset countdown to keep lines moving away from the platform.',
      'Live Wall Display (/wall): Full-screen TV and projector slideshow automatically looping newest 360 spins with smooth transitions, "New 360 Spin" notification banners, and on-screen QR codes.',
      'Square 1:1 Video Format: Added Instagram-ready Square (1080×1080) format alongside Portrait (9:16) and Landscape (16:9) with automatic aspect-ratio padding.',
      'Custom Text Overlays: Full-featured caption editor supporting two lines of customizable text, custom colors, sizing, drop shadows, top/center/bottom positioning, and timed fade-in/out.',
      'Intro & Outro Video Stingers: Seamlessly attach sponsor branding clips before and after the 360 spin with automatic dimension scaling and normalized audio.',
      'Auto-Rotating Looks & Music: Round-robin cycling automatically varies video styles, particle overlays, and soundtracks per spin so every guest gets a unique clip.',
      'Dual Online & Offline Sharing: Automatic detection of connectivity — triggers native smartphone share sheets when online, and delivers direct high-speed downloads with offline saving guides when connected to local booth Wi-Fi.'
    ]
  },
  {
    date: '2026-11-04', title: 'Epson L120/L121 & Canon G1010/G3030 Direct USB Printing', for: ['app'], app: '1.0.78',
    items: [
      'Added hardcoded direct USB support for Epson L120 and L121 with default color printing.',
      'Added hardcoded USB support and auto-attach permissions for Canon PIXMA G1010 and G3030 family.',
      'Improved background helper printing dispatch and color density tuning.'
    ]
  },
  {
    date: '2026-11-04', title: 'UI Professionalization, Streamlined Printer Badges & Toast Error Cleanup', for: ['app', 'website'], app: '1.0.77',
    items: [
      'Eliminated hardware manufacturer laundry lists (Epson, Canon, Selphy, VOZY, Star, Xprinter) across printer settings for a clean, professional interface.',
      'Streamlined printer selection tags with deduplicated badges (Photo, Receipt, USB, Wi-Fi) and concise status hints.',
      'Silenced raw development JavaScript line error toasts on Android in favor of background Logcat diagnostics.',
      'Refined toast notices and native bridge error messages with professional, user-friendly phrasing.'
    ]
  },
  {
    date: '2026-11-03', title: 'Video/GIF Tap-to-Start, Corporate Sponsor Billboard Playlist & Tablet Portrait Fitting', for: ['website', 'app'], app: '1.0.76',
    items: [
      'Video & Animated GIF Welcome Screens: Tap-to-start screen now accepts looping MP4/WebM videos and multi-frame animated GIFs.',
      'Corporate Sponsor Playlist (Billboard Mode): Upload multiple sponsor videos and brand graphics that automatically cycle and crossfade between guests.',
      'Tablet Portrait Scale-to-Fit: Full-bleed edge-to-edge scaling on Android tablets with zero border bars, custom button accent colors and smooth tap dismiss transition.',
      'IndexedDB Binary Blob Storage & Loop Watchdog: Low-memory binary storage preventing RAM bloat on budget tablets with auto-recovery on sleep/wake.'
    ]
  },
  {
    date: '2026-11-03', title: 'Android Print & Camera Helper (127.0.0.1:17321) for mobile Chrome & direct USB printing', for: ['app'], app: '1.0.75',
    items: [
      'Built-in background Print & Camera Helper: Runs a local helper service on 127.0.0.1:17321 with ongoing foreground notification support, allowing photobooth4u in Google Chrome on Android phones to connect directly via Print Helper.',
      'Silent direct USB OTG printing: Enables 100% silent, zero-dialog printing from mobile Chrome to Epson L3210, L8050, L3276, Canon SELPHY CP1500, and USB POS thermal receipt printers.',
      'Automatic feed rotation: Ensures landscape photos always fill the portrait feed on Epson ink-tank printers with zero edge cutoff.',
      'Background persistence: Foreground service keeps USB connection and HTTP server awake when switching to Chrome or other apps.'
    ]
  },
  {
    date: '2026-11-03', title: 'Landscape 4×6 borderless print fix, Lightness & RGB colour correction & camera stability (Windows & Mac)', for: ['app'], app: '1.0.63',
    items: [
      'Landscape & borderless 4×6 prints (Windows): Prints now fill the whole 4×6 in sheet right-side up even when the printer driver (such as Epson L3210 or L8050) is set to Landscape, fixing 2/3-size prints and upside-down Print Previews.',
      'Lightness / Exposure & RGB colour correction: Adjust lightness/darkness (-100 to +100) and Red, Green, and Blue balance directly in Setup Extras or Print settings, with real-time live preview and print support across thermal and photo printers.',
      'Camera glitch & false-disconnect fixes: Resolved false "Camera disconnected" watchdog loops on built-in/integrated webcams and paused result screens, improved camera error prompts, and added external USB webcam preview/capture resolution controls (Auto, Max, 1080p, 720p, 480p).',
      'Offline voucher sync & single Photo + GIF QR: Guaranteed local offline voucher redemption with automatic cloud batch sync when back online, plus one unified QR code for guests in Photo + GIF mode.'
    ]
  },
  {
    date: '2026-11-03', title: 'External USB webcam support & resolution controls (Android)', for: ['app'], app: '1.0.74',
    items: [
      'Plug-and-play USB webcams: Supports Logitech Brio 4K, Logitech C270 HD, C920, and other UVC webcams via native Android external camera (Android 14+) and built-in UVC fallback (Samsung Galaxy Tab A11, S9 FE, Xiaomi Pad, etc.).',
      'Preview resolution selector: Choose Auto (up to 1080p), Max, 1080p, 720p, or 480p (smoothest for GIFs/boomerangs), with automatic MJPEG fallback and MediaTek USB bandwidth quirks.',
      'Max-resolution still capture: Keep smooth 1080p/720p live view on USB 2.0 tablets while switching to the webcam\u2019s highest supported resolution at capture.',
      'Power & disconnect recovery: Automatic stall detection, hub power guidance, and mid-event hot-plug reconnection.'
    ]
  },
  {
    date: '2026-11-03', title: 'Offline voucher redemption, cloud batch sync & My Events tally (Android)', for: ['app'], app: '1.0.73',
    items: [
      'Guaranteed offline voucher redemption: Local offline batch lookup prevents offline-generated codes from being rejected as unrecognised.',
      'Offline batch syncing: Automatically synchronizes offline-generated voucher batches, used counts, and voided tickets to the server when connected to Wi-Fi.',
      'My Events voucher tally: Complete dashboard bar tallying total vouchers created, redeemed by guests, cancelled, remaining available, and total revenue.'
    ]
  },
  {
    date: '2026-11-03', title: 'Android app stability, hardware acceleration & print memory optimization', for: ['app'], app: '1.0.72',
    items: [
      'Hardware-accelerated Skia ColorMatrixColorFilter: Instant print color adjustments without slow per-pixel CPU loops.',
      'Reduced memory footprint: Downscale-first print rasterization with immediate native bitmap recycling avoids out-of-memory errors on budget tablets.',
      'Kiosk crash resilience: Automatic WebView renderer recovery restores the offline kiosk if Chromium engine encounters memory exhaustion.',
      'Bluetooth & USB reliability: Instant socket cleanup on disconnect and live USB device re-enumeration when hot-plugging printers or cameras.',
      'Enabled largeHeap application flag for seamless handling of high-resolution photo bursts and print jobs.'
    ]
  },
  {
    date: '2026-11-03', title: 'Single QR for Photo + GIF & tablet camera reliability (Android / Web)', for: ['app', 'website'], app: '1.0.71',
    items: [
      'Single unified QR code for Photo + GIF mode: Guests now scan one QR code to access and save both their photo strip and animated GIF with individual save buttons.',
      'Fixed false "Camera disconnected" watchdog on Android tablets: Resolved false disconnection timeouts caused by WebView video pause during result screens.',
      'Accurate camera error reporting: Tablet/built-in cameras no longer display misleading "Check USB cable" prompts.',
      'Transferred Lightness / Exposure and RGB color correction sliders directly into the Print settings panel for fast re-prints.'
    ]
  },
  {
    date: '2026-11-03', title: 'Lightness & RGB colour correction for thermal & photo printers (Android)', for: ['app'], app: '1.0.68',
    items: [
      'New Lightness / Exposure slider (-100 to +100) in Setup Extras to prevent dark or muddy prints on thermal receipt printers.',
      'Fine-tuned RGB color balance sliders (Red, Green, Blue from -100 to +100) with instant real-time live preview after photo sessions.',
      'Adjustments update the post-session preview canvas (#previewCanvas) and live camera view in real time.',
      'Full color correction applied to all supported printers: thermal receipt printers (ESC/POS dithering luminance offset), Epson L-series, Canon SELPHY, Canon PIXMA G, ESC/P2, ESC/P-R, and IPP Wi-Fi printers.'
    ]
  },
  {
    date: '2026-11-03', title: 'Portrait centered welcome card & layout preview fix (Android)', for: ['app'], app: '1.0.67',
    items: [
      'In portrait mode, the sample print is centered horizontally and vertically cleared below the top navigation bar without clipping.',
      'The event details card with "Tap to start" sits neatly below the sample print, centered on the tablet screen with safe clearance from bottom dock controls.',
      'Welcome screen image is fully contained with zero edge cropping across all tablet screen aspect ratios.',
      'Shots preview thumbnails in both shooting and retake review screens are stacked vertically along the right side.'
    ]
  },
  {
    date: '2026-11-03', title: 'Bluetooth thermal printers, settings shortcut & USB detection (Android)', for: ['app'], app: '1.0.66',
    items: [
      'Connect Bluetooth Printer button is now always visible on tablets without needing to select receipt paper first.',
      'Direct shortcut to Android Bluetooth Settings and instant warning notification if Bluetooth is disabled on the tablet.',
      'Added recognized hardware support for VOZY G80, P50 and MP210 thermal receipt printers.',
      'Added recognized hardware support for Star Micronics TSP143III series and Xprinter XP-T80Q / XP-P300.',
      'Wi-Fi & USB printer section renamed and updated with clear [USB] connection indicators.'
    ]
  },
  {
    date: '2026-11-03', title: 'Portrait camera centering, side thumbnails & welcome card fix (Android)', for: ['app'], app: '1.0.65',
    items: [
      'Welcome card layout on vertical tablets: sample strip and card are proportionally balanced with guaranteed bottom padding so the start button is never clipped.',
      'Live camera stage in portrait mode is now vertically and horizontally centered with 100% width coverage.',
      '4R grid polaroid layout fix: camera viewfinder remains centered and full width after preview without shrinking.',
      'Shot preview thumbnails are now cleanly layered top-to-bottom along the right side of the screen.'
    ]
  },
  {
    date: '2026-11-02', title: 'Borderless prints follow the printer’s own setting (Windows)', for: ['app'], app: '1.0.62',
    items: [
      'With Borderless on, the picture is now sent edge to edge and the printer’s own enlargement setting decides the edge (for Epson: Borderless, Settings, Expansion). The extra 3 mm margin added in 1.0.61 is gone, so a printer set to Min no longer gets a white border.',
      'If a white line shows on an edge, move the printer’s Expansion slider one step to the right; if an edge is trimmed, move it back to the left.'
    ]
  },
  {
    date: '2026-11-02', title: 'Photos no longer cut off or zoomed in on ink-tank printers (Windows)', for: ['website', 'app'], app: '1.0.61',
    items: [
      'Printers such as the Epson L3210 no longer lose the edge of the picture. The whole picture is fitted inside the part the printer says it can print. With Borderless on, it is drawn slightly smaller so the printer’s own enlargement does not trim it.',
      'The Printer margins settings and the calibration sheet from 1.0.59 are gone. The app now follows the printer’s own settings (paper, Borderless, orientation) instead of its own margin options.',
      'Prints use the printer’s best quality when its driver offers one. Paper size, Borderless and orientation stay as set in the printer.',
      'Fit the page no longer zooms in and trims the photo when the layout is a little different in shape from the paper (for example a 4×6 layout on 4.3 × 6.2 in paper). The whole photo is kept, with thin white borders where the shapes differ.'
    ]
  },
  {
    date: '2026-11-02', title: 'Find Wi-Fi and network printers from the laptop app', for: ['app'], app: '1.0.60',
    items: [
      'New in Setup, Camera & printer: Find Wi-Fi / network printers. The app asks every address on the Wi-Fi or network you are on which ones are printers, shows each by name, and lets you use it. A printer your computer does not have yet can be added from the same list.',
      'If a printer is not listed, type its IP address (for example 192.168.1.50) and search again. The result says which addresses were searched when nothing is found.'
    ]
  },
  {
    date: '2026-11-02', title: 'Prints no longer cut off, and a second printer (Windows)', for: ['app'], app: '1.0.59',
    items: [
      'Printers that cannot print right to the paper edge (many Epson ink-tank models) no longer lose the edge of the picture. The whole picture is now fitted inside the part the printer can print.',
      'New in Print settings, Printer margins: Automatic, Calibrated, Safe margin, or Edge to edge. Calibrated prints a test sheet, you enter the four edge numbers once, and the print preview then shows the sheet exactly as it will print.',
      'New: a second printer in Print settings. Share the work alternates the sheets between two printers (for example Epson and Canon) so busy events print faster, and if one fails the other takes over. Also print another size prints a second paper at the same time, such as the photo on one printer and a receipt strip on a receipt printer.'
    ]
  },
  {
    date: '2026-11-02', title: 'Easier Setup: flipbook options and printing', for: ['website', 'app'], app: '1.0.57',
    items: [
      'Flipbook and GIF settings in Extras are now grouped into small cards with tap-to-pick buttons and clear on/off switches, with less text to read.',
      'Printing settings moved from Share to Camera & printer, next to the printer and paper choice. A quick summary shows the paper, printer and auto-print at a glance.'
    ]
  },
  {
    date: '2026-11-02', title: 'Print preview: look at every page', for: ['website', 'app'], app: '1.0.56',
    items: [
      'The "Check the print" preview now lets you browse all pages of a flipbook, strip sheet or keychain print, not just page 1. Tap a page number, use the arrows, swipe, or press the left and right arrow keys.'
    ]
  },
  {
    date: '2026-11-02', title: 'Update from the "Tap to start" screen', for: ['app'], app: '1.0.55',
    items: [
      'When a new version of the app is out, a small "Update available" button now shows at the top of the Tap to start screen. Tap it to download and install, so you can update even if the booth itself will not open.'
    ]
  },
  {
    date: '2026-11-02', title: 'Fix: "Tap to start" not responding after the flipbook update', for: ['website', 'app'], app: '1.0.54',
    items: [
      'Fixed a startup error in 1.0.53 that stopped the booth from loading fully, so tapping the start screen did nothing on both the website and the laptop app.'
    ]
  },
  {
    date: '2026-11-02', title: 'Flipbook suite: stack-cut imposition, branded covers, interactive preview, and printer pooling', for: ['website', 'app'], app: '1.0.53',
    items: [
      'Stack-cut collation & binding gutters: slices printed sheets directly into collated piles with 6mm spine margin and staple alignment dots, reducing manual sorting to ~3 seconds.',
      'Hybrid digital deliverables: back-cover dynamic QR codes linking to animated GIFs, plus customizable cover styles (Event Branding, Photo Cover with hero frame, Custom Artwork upload).',
      'Interactive on-screen flipbook experience: interactive scrubber timeline with 3D booklet player, tap-to-flip controls, sheet grid overview with click-to-jump, and phased motion prompts during recording.',
      'High-volume printer pooling: alternates sheets across dual dye-sub printers to cut print wait times in half, with per-printer queue management and 6-up / 8-up grid presets.'
    ]
  },
  {
    date: '2026-11-02', title: 'Mac: fix crash (unexpected quit) when closing the app', for: ['website', 'app'], app: '1.0.52',
    items: [
      'Fixed "photobooth4u quit unexpectedly" (SIGABRT / __assert_rtn on CrBrowserMain) that appeared every time the Mac app was closed.',
      'Root cause: on quit, the app was firing a privileged osascript call to unload Internet Sharing — triggering a macOS authorization prompt mid-teardown, which races with Electron\'s process shutdown and causes a hard abort.',
      'Fix: the app no longer calls launchctl on quit on Mac. Internet Sharing stays on after quit (same as before the 1.0.50 hotspot feature) until the operator turns it off in System Settings.',
      'Also: the powerSaveBlocker, camera-guard timer, and background intervals are now all explicitly stopped before the process exits, preventing dangling native handles that could cause similar crashes.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: natural color blending and transparent animated overlays', for: ['website', 'app'], app: '1.0.51',
    items: [
      'Fixed animated video overlays appearing pinkish or saturated with a magenta wash by upgrading Screen and Addition blend modes to planar RGB compositing.',
      'Fixed WebM overlay effects (Floating Hearts, Streamers, Confetti, Rose Petals, Balloons) covering the person in solid black by decoding VP9 alpha transparency with libvpx-vp9.',
      'Overlays now blend seamlessly with natural skin tones and transparent backgrounds behind floating particles.'
    ]
  },
  {
    date: '2026-11-02', title: 'Mac & Windows laptops: standalone booth Wi-Fi with no router or internet', for: ['website', 'app'], app: '1.0.50',
    items: [
      'Mac laptops can now create their own booth Wi-Fi in Setup → Share with the new “Set up (one time)” and “Make this laptop the booth Wi-Fi” switch.',
      'The app sets up an offline loopback service (BoothDummy) on macOS to unlock Internet Sharing to Wi-Fi without external internet, routing automatically to guests over bridge100.',
      'Guests scan the Join QR and access photos and videos directly with no router, pocket Wi-Fi, or phone hotspot at the booth.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: animated video overlay loops and reliability fix', for: ['website', 'app'], app: '1.0.49',
    items: [
      'Bundles all 40 full procedural animated video overlay loops (WebM VP9 with alpha and H.264 MP4 with Screen blend) for confetti, gold dust, streamers, rose petals, neon cyberpunk, fireworks, and more.',
      'Includes fallback error safety in the 360 video pipeline to ensure video edits complete smoothly even if an overlay asset is unavailable.'
    ]
  },
  {
    date: '2026-11-02', title: 'Android tablet: the tablet can make its own booth Wi-Fi', for: ['website'],
    items: [
      'In Setup → Share there is a new switch, “Make this tablet the booth Wi-Fi”. It turns on a Wi-Fi network from the tablet itself, so guests can scan the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot. The name and password are made for you. Android 13 and newer asks to allow “Nearby devices”; older Android asks for Location.',
      'Switch the tablet’s Wi-Fi on first (it does not need to join a network). While it hosts, many tablets can’t also use another Wi-Fi, so activate and update the app beforehand. If a tablet can’t do it, the app says so and a router or phone hotspot works as before. Android app 1.0.59.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: 40 animated video effects (confetti, sparks, neon, and more)', for: ['website', 'app'], app: '1.0.48',
    items: [
      'The 360 desk’s editing panel has a new "Animated effect" menu with 40 overlay effects: confetti cannons, gold dust storms, rose petals, neon laser grids, burning embers, snowfall, fireworks and more — grouped by Celebration, Weddings, VIP/Luxury, Nightlife, Action/Retro and Holidays.',
      'Effects composite directly over the slow-motion or boomerang clip on the laptop using FFmpeg, with no internet or subscription required. Light effects (sparks, lens flares, light leaks) use a fast screen-blend mode; solid particles (confetti, petals, cash rain) use an alpha-channel overlay.',
      'The chosen effect is remembered between events. Picking "None" skips the overlay step entirely, keeping the same fast processing as before.'
    ]
  },
  {
    date: '2026-11-02', title: 'Windows app: the laptop can make its own booth Wi-Fi', for: ['website', 'app'], app: '1.0.47',
    items: [
      'On Windows, Share & start has a new switch, “Make this laptop the booth Wi-Fi”. It turns on the laptop’s own Wi-Fi, so guests can scan the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot at the booth. The Wi-Fi name and password are made for you.',
      'If the laptop has no network at all, Windows won’t start its hotspot by itself. Press “Set up (one time)”: Windows asks for permission once. While the laptop hosts the Wi-Fi it has no internet unless it is also connected by cable or Wi-Fi, so activate and update the app beforehand.',
      'Some laptops’ Wi-Fi chips can’t host a hotspot. The app tells you, and a router or a phone hotspot works as before. The Mac app is unchanged.'
    ]
  },
  {
    date: '2026-11-01', title: 'Mac: AirPrint printers print at the best quality automatically', for: ['website', 'app'], app: '1.0.46',
    items: [
      'On a Mac, a printer added as AirPrint now prints photos at its highest quality, and on photo paper when the printer offers it, without opening the printer settings. Printers with their own driver (DNP, HiTi and similar) keep their own settings.',
      'Some AirPrint printers list few quality options; then they print at their own default.'
    ]
  },
  {
    date: '2026-11-01', title: 'Mac app: Nikon and Sony Alpha cameras connect straight over USB', for: ['website', 'app'], app: '1.0.45',
    items: [
      'On a Mac the app now connects to a Nikon (D-series and Z-series) or a Sony Alpha camera by itself over USB, the same way it already does for Canon EOS and the same way the Windows app does, instead of through the browser layer. Live view and the real shutter work, and photos come straight to the laptop.',
      'Nikon: set the camera’s USB mode to PTP or MTP. The app records to the camera’s own memory (no SD card needed) and picks JPEG and a photo size that comes over USB quickly.',
      'Sony: set USB Connection to PC Remote (MENU > Setup > USB). Photos go to the computer only, so no memory card is needed. Allow about 3 seconds after connecting before the first photo.',
      'Setup → Camera → Camera check on the Mac now names the Nikon or Sony it finds, not only Canon.'
    ]
  },
  {
    date: '2026-11-01', title: 'Mac app: Camera check', for: ['website', 'app'], app: '1.0.44',
    items: [
      'Setup → Camera has a new Camera check button in the Mac app. It shows what the Mac lists on USB, whether the app can open the Canon camera and get a live picture, and the steps it tried. Copy check result sends the same detail to support.'
    ]
  },
  {
    date: '2026-11-01', title: 'Mac app: Canon EOS cameras connect straight over USB', for: ['website', 'app'], app: '1.0.43',
    items: [
      'On a Mac the app now connects to a Canon EOS camera by itself over USB, the same way the Windows app does, instead of through the browser layer. Nikon and Sony keep working as before.',
      'If the camera is not found, the message now says whether the Mac itself lists a camera (so it is the cable, adapter or camera mode) or whether the app could not open it.'
    ]
  },
  {
    date: '2026-11-01', title: 'Laptop app: a USB camera is found even with a hub or other USB devices plugged in', for: ['website', 'app'], app: '1.0.42',
    items: [
      'The app now only looks at cameras on USB (Canon, Nikon, Sony, Fujifilm, Olympus, Panasonic, Pentax), not at every USB device. A hub, a card reader or the laptop’s own camera could stop a Canon from being found (“Unknown model”).',
      'If the camera is still not found, the message now lists what the app sees, and Copy camera log has the same detail.'
    ]
  },
  {
    date: '2026-11-01', title: 'Photo size on the paper, in plain choices', for: ['website'],
    items: [
      'Print settings now has one row under Photo size on the paper: Fit the page, a real size such as 2×6 strip or 4R, or Fill the page. A real size prints in the middle of a bigger paper such as A4.',
      'Setup step 4 is now Camera & printer, with the printer, paper and a print preview. Android app 1.0.57.'
    ]
  },
  {
    date: '2026-11-01', title: 'Android app: Android print dialog, print settings and more printers over USB', for: ['website'],
    items: [
      'Android app 1.0.44: Print settings has a new Android print dialog choice. It opens Android\u2019s own print screen for any printer the tablet can reach, and a button opens Android print settings so print services (Mopria, Epson, Canon, HP, Brother) can be switched on.',
      'After you pick a Wi-Fi printer the app shows its own colour, quality and paper-type choices, only the ones that printer lists.',
      'USB (OTG): printers with driverless USB printing and receipt printers can be printed to, and some older Epson ink-tank models work in an experimental black-and-white and colour mode. Printers that need their own driver still need the laptop.'
    ]
  },
  {
    date: '2026-10-31', title: 'Android app prints to Wi-Fi and USB printers it finds itself', for: ['website'],
    items: [
      'Android app 1.0.35: Print settings has a new Wi-Fi printer section. Tap Find Wi-Fi printers and the tablet lists printers on the same Wi-Fi, such as Epson, Canon, HP and Brother models that support AirPrint / Mopria, and prints photos straight to the one you pick, with no print dialog.',
      'Printers plugged into the tablet’s USB port appear in the same list. Receipt printers and printers that support IPP-over-USB can be printed to. Printers that need their own driver (for example Epson L120 / L210, DNP, HiTi) are shown as detected but still need the laptop.',
      'Receipt printers on Wi-Fi or USB work too, and if a direct print fails the booth opens the Android print dialog instead. See the new Android printing guide.'
    ]
  },
  {
    date: '2026-10-31', title: 'Card booth: "Flip card" only shows when Card & certificate booths is on', for: ['website', 'app'], app: '1.0.41',
    items: [
      'Laptop app 1.0.41 and the website: the "Flip card" button on the result screen no longer shows on a normal photo booth. It only appears for codes that have Card & certificate booths turned on in Admin.'
    ]
  },
  {
    date: '2026-10-31', title: 'Photo + GIF: guests can retake photos again', for: ['website', 'app'], app: '1.0.40',
    items: [
      'Laptop app 1.0.40 and Android app 1.0.34: with Photo + GIF, the Retake button is back, both between shots and on the final review screen.',
      'The GIF is the first complete run of shots. A retake pressed between shots is in the GIF; a retake at the final review changes the photo but not the GIF.',
      'GIF only still has no photo retakes, and Setup now says so.'
    ]
  },
  {
    date: '2026-10-31', title: 'Canon on Windows: the photo now lands on "Pose", and live view comes back after each shot', for: ['website', 'app'], app: '1.0.39',
    items: [
      'Laptop app 1.0.39: a Canon left on its self-timer (the beeps that get faster before the photo) is put back on single shot, so the picture is taken when the countdown ends instead of seconds later.',
      'The booth learns how long the camera takes from the shutter command to the photo and fires that much earlier, so the saved photo is the pose guests held at "Pose".',
      'After each photo the booth asks the camera for live view straight away and no longer flashes "Reconnecting" while it comes back. A photo that takes over 25 seconds is skipped and the live view picture is used.',
      'Also turn off the beep in the camera menu (Beep: Disable) so guests do not mistake it for the countdown.'
    ]
  },
  {
    date: '2026-10-31', title: 'Android tablet: the Bluetooth printer list shows your receipt printer first', for: ['website'],
    items: [
      'Android app 1.0.32: when you connect a Bluetooth receipt printer, the list now shows the devices that look like printers first. Keyboards, headphones, speakers, watches and phones no longer appear.',
      'A printer with an unusual name is under “Other paired devices” at the bottom of the list, so you can still pick it. If only one printer is found, the tablet connects to it by itself.',
      'The printer must be paired first in Android Settings → Bluetooth, and be a standard (classic Bluetooth) receipt printer, 58 mm or 80 mm.'
    ]
  },
  {
    date: '2026-10-31', title: '360 desk: no more editing the same videos twice', for: ['website', 'app'], app: '1.0.38',
    items: [
      'Laptop app 1.0.38: a video you already edited stays marked as edited when you close and reopen the app, and "Edit new videos by themselves" no longer edits it again.',
      'On the website, the 360 desk has a new Choose folder button that adds every video in a folder.'
    ]
  },
  {
    date: '2026-10-31', title: 'Camera: a frozen or black live view now recovers (Canon on Windows, and webcams)', for: ['website', 'app'], app: '1.0.36',
    items: [
      'Fixed: with a Canon (such as the EOS R50) on Windows, the live view could freeze and then go black during a session, with no message and no way back. Laptop app 1.0.36 starts the live view again properly whenever the camera ends it, when frames stop, and right after every photo.',
      'The booth now watches the Windows camera too: after about 4 seconds without a new picture it asks the camera to start live view again and shows \u201cCamera not responding\u201d, and it reconnects by itself after 15 seconds.',
      'A webcam whose picture stops while the camera is still \u201con\u201d (for example Canon\u2019s EOS Webcam Utility when the camera goes to sleep) is noticed after 8 seconds and reconnected. This part works on the website too.',
      'If it still happens, open the Camera menu \u2192 Copy camera log right after and send it to us: it now says whether the picture stalled, what was tried and what came back.'
    ]
  },
  {
    date: '2026-10-31', title: 'Use a DSLR with an iPad: the iPad uses the laptop’s camera over Wi-Fi', for: ['website', 'app'], app: '1.0.37',
    items: [
      'Laptop app 1.0.37 (Windows): an iPad can now use the real DSLR shutter, live view and flash. Plug the Nikon, Canon EOS or Sony Alpha into the laptop, then in Setup → Share & start turn on “Let an iPad use this laptop’s camera”. The laptop shows an address and a 6-digit PIN: open it in Safari on the iPad (same Wi-Fi) and type the PIN. It works with no internet, and photos save on the laptop. An iPad with a camera and no laptop can’t do this.',
      'No laptop? An iPad can still use a camera through an HDMI-to-USB capture card (no real shutter or flash). The new iPad guide at /how-to-ipad/ explains both ways.',
      'About us: the three monthly plans now sit in one row, and the top menu has an FAQ link.'
    ]
  },
  {
    date: '2026-10-30', title: 'Flip book: sharper pages that differ from each other', for: ['website', 'app'], app: '1.0.34',
    items: [
      'Flip book (website, laptop app 1.0.34 and Android app 1.0.31): pages are no longer near copies of each other, and fewer are blurry. The booth records more pictures than the book needs, keeps the sharpest one around each moment, then spaces the pages so each differs from the last: a still moment gets fewer pages and a lively one gets more.',
      'The default is now 24 frames in a 6 second clip (it was 30). Setups that already chose a number keep it. For bigger changes between pages choose fewer frames (16 or 24) and a 6 or 7 second clip.',
      'Blur also comes from a dim room: the camera then uses a slow shutter. A little more light on the guest helps more than any setting.'
    ]
  },
  {
    date: '2026-10-30', title: 'Windows laptop: a DSLR that stops answering now recovers instead of freezing the booth', for: ['website', 'app'], app: '1.0.33',
    items: [
      'Laptop app 1.0.33 (Windows, Nikon / Canon EOS / Sony Alpha over USB): when the camera stops answering, the booth now waits a moment, reconnects and resets a Canon’s remote mode first. If it happens twice in a row it tells you to switch the camera off and on and check the USB cable.',
      'Canon: if the camera ends live view by itself (heat, or its time limit), the booth switches it back on. Nikon: the booth now keeps the camera’s event list short during long live-view sessions. Memory use stays flat over a long event.',
      'The app now keeps a camera.log file (in %APPDATA%\\photobooth4u) that records which camera command was stuck, so a hang can be diagnosed. A Canon EOS R50 hang is not confirmed fixed yet: if it still happens, send us that file.'
    ]
  },
  {
    date: '2026-10-30', title: 'A Camera step in Setup, with a live view of your camera', for: ['website', 'app'], app: '1.0.32',
    items: [
      'Laptop app 1.0.32 and Android app 1.0.30: Setup has a new step after Layout, Camera. It shows a live view of what the camera sees before you start: the full camera frame by default, or tap “Crop to layout” to see only the part that fits your layout.',
      'The camera picker, Mirror and the camera log moved there from the Session step. Mirror and the live filter show in the live view. The Camera button in Photo Session works as before.',
      'Setup now has 7 steps: Design, Text, Layout, Camera, Extras, Share and Session (Share is step 6 and Session is step 7).'
    ]
  },
  {
    date: '2026-10-30', title: 'Wi-Fi read for you, a Wi-Fi button in the bottom bar, and one-tap printing of earlier photos', for: ['website', 'app'], app: '1.0.31',
    items: [
      'Laptop app 1.0.31: the booth now reads the Wi-Fi the laptop is connected to and fills in the Wi-Fi name and password in Setup → Share & start. Tap “Use current Wi-Fi” to read it again. If the password can’t be read, type it there (on a Mac, allow the Keychain request). The app does not create a Wi-Fi itself: connect the laptop to your router or a phone hotspot first.',
      'New Wi-Fi button in the bottom bar, beside Extras and Lock booth: it shows the Wi-Fi QR so guests can join, then scan their photo QR. In Share & start, “Download WIFI QR Sign” saves a printable Wi-Fi sign. After each session guests now see their Photo and GIF QR codes only.',
      'All photos: on the booth laptop, open an earlier photo and tap Print photo. It prints at once on the printer, paper size and copies you set in Print settings, with no print dialog. It works in the laptop app and in the online gallery when it is open in the same browser as the booth. Guests’ phones keep their own print.',
      'Android app 1.0.29: the USB camera no longer drops out when the camera answers slowly (it pauses and carries on instead of disconnecting), and a camera of another make now says plainly that it can’t be controlled by the app and to use its USB webcam mode instead.',
      'Android app 1.0.28: the same Wi-Fi button and Wi-Fi sign. On the tablet, type the Wi-Fi name and password in Share & start (the tablet does not read them by itself).',
      'The laptop app also includes using the laptop’s DSLR from an iPad over Wi-Fi: see the iPad guide at /how-to-ipad/.'
    ]
  },
  {
    date: '2026-10-30', title: '360 videos: join the Wi-Fi and download, with two QR codes', for: ['website', 'app'], app: '1.0.29',
    items: [
      'Laptop app 1.0.27 and Android app 1.0.23: when you set the booth Wi-Fi name and password in Setup → Share & start, the 360 player shows two codes. Step 1: Network joins the guest’s phone to the booth Wi-Fi, and Step 2: Download opens the video. It works with no internet.',
      'With no Wi-Fi set, you still get the single download code as before.',
      'New look: the finished video now shows between the two codes, with numbered steps on a dark card (laptop 1.0.29, Android 1.0.26).',
      'Android app 1.0.25: the tablet now looks for a new version every 5 minutes while it is open (and when it comes back to the front), like the laptop app, instead of every 6 hours.',
      'What’s new now opens in a window inside the app (laptop 1.0.28, Android 1.0.24) instead of the browser.',
      'Android app 1.0.27: a Nikon, Canon EOS or Sony Alpha camera plugged into the tablet’s USB port now shows up in the Camera list (“Nikon / Canon / Sony camera over USB cable”). Set the camera to PTP / MTP (Nikon), Remote Control (Canon) or PC Remote (Sony), plug it in and tap OK when Android asks.'
    ]
  },
  {
    date: '2026-10-29', title: 'The Android tablet app now speaks the countdown', for: ['website'],
    items: [
      'Android app 1.0.22: the spoken countdown (Get ready, Three, Two, One, Smile!) now works on the tablet, using the tablet\u2019s own text-to-speech voices. It works offline once an English voice is downloaded (Settings \u2192 System \u2192 Languages \u2192 Text-to-speech output).',
      'Choose English or Tagalog (when the tablet has a Filipino voice), the last 3 numbers or every number, and the voice in Setup \u2192 Session. With no voice on the tablet the beeps are used.'
    ]
  },
  {
    date: '2026-10-29', title: 'Guests can see only their own photos, and a spoken countdown', for: ['website', 'app'], app: '1.0.26',
    items: [
      'New: Setup \u2192 Share \u2192 After guests scan their QR. Choose Everyone\u2019s photos (as before), Mine first (their own photos, with a Show photos with other guests button) or Only their own.',
      'Only their own: each guest\u2019s QR opens a page with just their photo, GIF and flipbook. The event gallery is closed to guests, so an old QR or a copied link cannot open it, and the booth hides its All photos button and the guest screen\u2019s All photos QR. Use Lock booth so guests cannot open Setup or Extras.',
      'In the laptop app and the Android tablet app (1.0.21) the event pages answer only the laptop or tablet itself in this mode. It works on the website too, including the free trial.',
      'New: a spoken countdown (Get ready, Three, Two, One, Smile!) using the voices on your device. On by default; choose English or Tagalog (when the device has a Filipino voice), the last 3 numbers or every number, and the voice in Setup \u2192 Session. With no voice on the device the beeps are used. The Android app keeps the beeps for now.'
    ]
  },
  {
    date: '2026-10-29', title: '360 videos work in the laptop app, a simpler bottom bar, print preview and poster fit', for: ['website', 'app'], app: '1.0.25',
    items: [
      'Fixed: in the laptop app the 360 desk could not take videos from Choose videos or play them (the app was blocking its own video server). Videos now upload, play and edit, and Record 360 on the laptop can save to its own inbox.',
      'Fixed: the 360 video player no longer covers the page, and card titles (such as Photographer desk) are readable again in the dark theme.',
      'A simpler bottom bar: Camera, Printer, All photos, Extras and Lock. Photographer desk, 360 desk, Record 360, Video guestbook and Print requests are in the new Extras menu, with a number for new items.',
      'Photographer desk: it now shows the phone QR code at the top. Photos a phone sends appear in the desk list (marked with a phone) next to memory-card photos, with Make print + QR and a new Print original. One photo per print is on by default, and the desk scrolls with many photos.',
      'Quick shot is gone: use the Photographer desk. Phone upload moved there.',
      'Print preview: the first print, and the first after you change the paper or printer, shows how the page will look before anything is sent. Switch it off in Print settings.',
      'Custom welcome poster: a Poster fit choice. Stretch to fill the screen is the default and trims nothing; you can also show the whole poster or fill and trim.',
      'The video guestbook and 360 recording buttons are smaller.'
    ]
  },
  {
    date: '2026-10-29', title: 'Phone photos, guest print requests, video guestbook, GIFs in your frame and 360 recording in the app', for: ['website', 'app'], app: '1.0.24',
    items: [
      'GIFs now get your chosen look and sit in your frame: by default the one-photo Solo layout with your title, even when the photos use a strip. Setup → Extras → Output mode has a GIF frame choice (Solo, the chosen layout, or the plain camera view).',
      'Quick shot and photographer desk photos use the Solo layout (no more one photo repeated on a strip). The desk has a One photo per print switch, and the Quick shot screen has Print framed and Print original.',
      'Photos from a phone: on the Quick shot screen tap Phone upload, the photographer scans the QR code and sends photos. On the laptop and Android apps they go straight to the booth over Wi-Fi; on the website they go through the event folder. Each one is framed, saved and gets a QR code.',
      'Guests can ask for a print: switch on Let guests ask for a print from their phone in the print settings. Their photo page gets an Ask for a print at the booth button and a Print requests button appears in the dock (website, laptop and Android apps).',
      'Guest screen (traditional booth): an optional Look button lets each guest pick a filter. It is off until you tick Let guests choose a look in Setup → Extras → Filter.',
      'Video guestbook: a guest records a message of up to 30 seconds, watches it and gets a QR code. It shows under Videos in the gallery.',
      '360 recording in the app (Android and laptop apps): Record 360 in the dock records the spin from a tablet or phone on the arm, starting with the button or when the arm moves, and sends the clip to the laptop. New speed styles (0.25×, fast then slow, fast slow fast, slow-mo roller) and Edit new videos by themselves can now also get the QR ready.',
      'Flipbook cards no longer have numbers: they print in order, left to right and top to bottom.'
    ]
  },
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
