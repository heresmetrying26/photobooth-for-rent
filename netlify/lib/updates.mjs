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
  { version: '1.1.116', date: '2026-11-26' },
  { version: '1.1.115', date: '2026-11-26' },
  { version: '1.1.114', date: '2026-11-26' },
  { version: '1.1.113', date: '2026-11-26' },
  { version: '1.1.112', date: '2026-11-25' },
  { version: '1.1.111', date: '2026-11-25' },
  { version: '1.1.110', date: '2026-11-25' },
  { version: '1.1.109', date: '2026-11-25' },
  { version: '1.1.108', date: '2026-11-25' },
  { version: '1.1.107', date: '2026-11-25' },
  { version: '1.1.106', date: '2026-11-25' },
  { version: '1.1.105', date: '2026-11-25' },
  { version: '1.1.104', date: '2026-11-24' },
  { version: '1.1.103', date: '2026-11-24' },
  { version: '1.1.102', date: '2026-11-24' },
  { version: '1.1.101', date: '2026-11-24' },
  { version: '1.1.100', date: '2026-11-23' },
  { version: '1.1.99', date: '2026-11-23' },
  { version: '1.1.98', date: '2026-11-23' },
  { version: '1.1.97', date: '2026-11-23' },
  { version: '1.1.96', date: '2026-11-22' },
  { version: '1.1.95', date: '2026-11-22' },
  { version: '1.1.94', date: '2026-11-22' },
  { version: '1.1.93', date: '2026-11-22' },
  { version: '1.1.92', date: '2026-11-21' },
  { version: '1.1.91', date: '2026-11-21' },
  { version: '1.1.90', date: '2026-11-21' },
  { version: '1.1.89', date: '2026-11-21' },
  { version: '1.1.88', date: '2026-11-21' },
  { version: '1.1.87', date: '2026-11-21' },
  { version: '1.1.86', date: '2026-11-21' },
  { version: '1.1.85', date: '2026-11-21' },
  { version: '1.1.84', date: '2026-11-21' },
  { version: '1.1.83', date: '2026-11-21' },
  { version: '1.1.82', date: '2026-11-20' },
  { version: '1.1.81', date: '2026-11-20' },
  { version: '1.1.80', date: '2026-11-20' },
  { version: '1.1.79', date: '2026-11-19' },
  { version: '1.1.78', date: '2026-11-19' },
  { version: '1.1.77', date: '2026-11-19' },
  { version: '1.1.76', date: '2026-11-19' },
  { version: '1.1.75', date: '2026-11-19' },
  { version: '1.1.74', date: '2026-11-19' },
  { version: '1.1.73', date: '2026-11-18' },
  { version: '1.1.72', date: '2026-11-18' },
  { version: '1.1.71', date: '2026-11-18' },
  { version: '1.1.70', date: '2026-11-18' },
  { version: '1.1.69', date: '2026-11-18' },
  { version: '1.1.68', date: '2026-11-18' },
  { version: '1.1.67', date: '2026-11-18' },
  { version: '1.1.66', date: '2026-11-18' },
  { version: '1.1.65', date: '2026-11-18' },
  { version: '1.1.64', date: '2026-11-17' },
  { version: '1.1.63', date: '2026-11-17' },
  { version: '1.1.62', date: '2026-11-17' },
  { version: '1.1.61', date: '2026-11-17' },
  { version: '1.1.60', date: '2026-11-17' },
  { version: '1.1.59', date: '2026-11-17' },
  { version: '1.1.58', date: '2026-11-17' },
  { version: '1.1.57', date: '2026-11-17' },
  { version: '1.1.56', date: '2026-11-17' },
  { version: '1.1.55', date: '2026-11-16' },
  { version: '1.1.54', date: '2026-11-15' },
  { version: '1.1.53', date: '2026-11-15' },
  { version: '1.1.52', date: '2026-11-15' },
  { version: '1.1.51', date: '2026-11-15' },
  { version: '1.1.50', date: '2026-11-15' },
  { version: '1.1.49', date: '2026-11-15' },
  { version: '1.1.48', date: '2026-11-15' },
  { version: '1.1.47', date: '2026-11-15' },
  { version: '1.1.46', date: '2026-11-15' },
  { version: '1.1.45', date: '2026-11-14' },
  { version: '1.1.44', date: '2026-11-14' },
  { version: '1.1.43', date: '2026-11-14' },
  { version: '1.1.42', date: '2026-11-14' },
  { version: '1.1.41', date: '2026-11-14' },
  { version: '1.1.40', date: '2026-11-14' },
  { version: '1.1.39', date: '2026-11-14' },
  { version: '1.1.38', date: '2026-11-14' },
  { version: '1.1.37', date: '2026-11-14' },
  { version: '1.1.36', date: '2026-11-14' },
  { version: '1.1.35', date: '2026-11-13' },
  { version: '1.1.34', date: '2026-11-12' },
  { version: '1.1.33', date: '2026-11-12' },
  { version: '1.1.32', date: '2026-11-12' },
  { version: '1.1.31', date: '2026-11-12' },
  { version: '1.1.30', date: '2026-11-12' },
  { version: '1.1.29', date: '2026-11-11' },
  { version: '1.1.28', date: '2026-11-11' },
  { version: '1.1.27', date: '2026-11-11' },
  { version: '1.1.26', date: '2026-11-11' },
  { version: '1.1.25', date: '2026-11-11' },
  { version: '1.1.24', date: '2026-11-11' },
  { version: '1.1.23', date: '2026-11-11' },
  { version: '1.1.22', date: '2026-11-11' },
  { version: '1.1.21', date: '2026-11-10' },
  { version: '1.1.20', date: '2026-11-10' },
  { version: '1.1.19', date: '2026-11-10' },
  { version: '1.1.18', date: '2026-11-10' },
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
export const HELPER = { version: '1.1.26', date: '2026-11-26' };
// The newest Android tablet app (tag android-v<version> on GitHub). Tablets ask /api/updates at launch and
// offer to download it when theirs is older. Hosted directly on Netlify CDN for fast, reliable delivery.
// The tablet downloads the APK from the GitHub release, not from the website: Netlify cuts any single download
// after about 60 s, so on a slower connection the 18 MB file never finished ("unexpected end of stream").
// GitHub has no such limit. (The copy in public/downloads is still kept for the /downloads page.)
export const ANDROID = { version: ANDROID_VERSION, date: '2026-11-26', url: 'https://github.com/' + REPO + '/releases/download/android-v' + ANDROID_VERSION + '/photobooth4u-kiosk-android.apk' };

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
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=60', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'photobooth4u-site' }, signal: AbortSignal.timeout(5000) });
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

// The newest iPad offline app (tag ios-v<version> on GitHub, asset photobooth4u-kiosk-ipad.ipa).
export const IOS_FALLBACK = { version: '1.1.33', url: 'https://github.com/' + REPO + '/releases/download/ios-v1.1.33/photobooth4u-kiosk-ipad.ipa' };
let liveI = { at: 0, ttl: 0, v: null };
export async function liveIos() {
  if (liveI.v && Date.now() - liveI.at < liveI.ttl) return liveI.v;
  try {
    const r = await fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=60', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'photobooth4u-site' }, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      let best = null;
      for (const rel of await r.json()) {
        const m = /^ios-v(\d+(?:\.\d+)*)$/.exec(rel.tag_name || ''); if (!m || rel.draft) continue;
        const a = (rel.assets || []).find((x) => x.name === 'photobooth4u-kiosk-ipad.ipa'); if (!a || !/^https:\/\//.test(a.browser_download_url || '')) continue;
        if (!best || verNewer(m[1], best.version)) best = { version: m[1], url: a.browser_download_url };
      }
      if (best) { liveI = { at: Date.now(), ttl: 10 * 60000, v: best }; return best; }
    }
  } catch { /* offline / rate limited: keep what we had */ }
  liveI = { at: Date.now(), ttl: 2 * 60000, v: liveI.v || IOS_FALLBACK };
  return liveI.v;
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

// Newest first. for: 'website' | 'app' (laptop app) | 'android' | 'ipad' | 'helper' (Print Helper).
// Keep titles and items in plain client language (no markdown, hex codes, or internal symbols). Put technical notes in docs/dev-changelog.md.
export const NOTES = [
  {
    date: '2026-11-26', title: 'Desktop 1.1.116, Android 1.2.25 & iPad 1.1.33: Epson L3210 Crisp 720 dpi Direct USB Printing, Edge-to-Edge Tablet Bridge & Rotation Sync, Centered Canva Overlay Bar & Lag-Free Design Picker', for: ['website', 'app', 'android', 'ipad'], app: '1.1.116', android: '1.2.25', ipad: '1.1.33',
    items: [
      '🖨️ Epson L3210 crisp 720 dpi & true colours on Android tablets (including Huawei): Calibrated direct USB photo printing for Epson L3210 with sharp 720 dpi default (plus 1440×720 Best, 360 dpi Normal, and Draft) tuned from the official Epson L3210 driver to prevent rainbow bands, shifted colours, and Borderless edge mismatches across 4×6, 3.5×5, 100×148 mm, and 16:9 paper.',
      '⚡ Faster, stall-free printing on Android & Huawei Chrome: Streams high-resolution photo prints smoothly without freezing the booth or overflowing tablet memory, unlocks Epson L3210 Print Helper selection in Android Chrome when USB printing is running, shows a clearer tap prompt for Android USB permission, and supports wireless Epson L3210 printing through Laptop Print Station.',
      '📱 True full-screen Tablet Bridge & instant rotation sync: Fills portrait and landscape Android tablets edge to edge in Welcome, design picker, live camera, and finished photo / QR views, and automatically refreshes orientation, framing, and sound when rotating the tablet or reconnecting.',
      '🎨 Centered Canva overlay button: Centers the "+ Add Canva overlay / sticker" bar cleanly inside Preview across Laptop, Android, and iPad apps.',
      '✨ Faster design chooser & smoother start: Opens layout choices right away without freezing while thumbnails load in the background, and jumps straight to Get Ready when a guest picks a design.'
    ]
  },
  {
    date: '2026-11-26', title: 'Desktop 1.1.115, Android 1.2.24, iPad 1.1.32, Print Helper 1.1.26 & Roving DSLR Bridge 1.1.5 / 1.0.2: Receipt Brightness & Compact Vouchers, Lag-Free Stickers & Text, Guided Flow & Camera SD Backup', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.115', android: '1.2.24', ipad: '1.1.32', helper: '1.1.26',
    items: [
      '✨ Fine-tune print now visible for Thermal Receipt Printers: When Receipt 80 mm or Receipt 58 mm is chosen, Fine-tune print stays open so you can adjust Brightness, Contrast, Saturation, Shadows, Highlights, and Sharpen cleanly before printing.',
      '🎟️ Compact Thermal Vouchers: Shortens 80 mm and 58 mm paper vouchers by over half with a tighter top-to-bottom layout while keeping tall upright orientation on receipt printers.',
      '⚡ Faster, lag-free stickers and custom text: Keeps your photo collage cached while dragging, resizing, typing, or changing sticker and text sliders so edits feel instant even on tablets.',
      '🧭 Seamless guest flow & live text controls: Adds a clear step progress bar (Style, Take Photos, Decorate, Done), a Change layout back button on Get Ready, live font, size, and colour restyling on selected text, Undo and Clear buttons, and clear black-and-white receipt preview notices.',
      '📺 Edge-to-edge Tablet Guest Screen & Welcome Fit: Fills camera-cutout borders cleanly on Android tablets and automatically fits welcome cards and layout previews to each guest tablet screen.',
      '💾 Save Backup + RAW on Camera SD Card & Offline Queue Upgrades: Optional switch across booth apps, Print Helper 1.1.26, and Roving DSLR Bridge (Android 1.1.5 / iOS 1.0.2) keeps full RAW and JPEG copies on your camera card while streaming JPEGs, alongside automatic phone upload queuing, reliable slow-Wi-Fi Photographer Desk processing, sharper Roving brightness export, mobile template-maker preview stacking, and a simpler beginner view for 360 Booth.'
    ]
  },
  {
    date: '2026-11-26', title: 'Desktop 1.1.113, Android 1.2.22, iPad 1.1.30 & Website: Guided Photoman Template Maker, Guest Screen Aspect Fixes & Clean Menu Gating', for: ['website', 'app', 'android', 'ipad'], app: '1.1.113', android: '1.2.22', ipad: '1.1.30',
    items: [
      '🎨 Guided Photoman Template Maker with hover previews: Work through clean step tabs (Presets and PNG, Background and Decor, Spots Text and Logo), hover any starter preset card to preview how it looks right on the canvas before creating, and tap the question-mark guide button anytime for a 5-step walkthrough.',
      '📷 Cleaner Photographer Desk: Switch cleanly between Queue, Template and Flow, Template Maker, and Connect and QR one view at a time, get guided Choose Photos and Connect buttons on an empty queue, and build custom frames directly inside Template Maker.',
      '📺 Portrait Guest Screen & Tap to Start fixes: Keeps portrait and extended display frames proportioned without stretching, prevents welcome logo overlap, and allows guests or tablets to tap to start a photo session when ready.',
      '🧰 Clean Setup menu visibility & Arrange and Print gating: Keeps Arrange and Print safely off unless enabled for a code in Admin, and keeps the Setup More menu clean across Desktop, Android, and iPad apps.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.112, Print Helper 1.1.25, Android 1.2.21 & iPad App (OTA): Clean Print Station Printer Picker & Dynamic Paper Sizes', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.112', android: '1.2.21', helper: '1.1.25',
    items: [
      '☑️ Untick all, search & hide unused printers in Offline Print Station: Click Untick all, filter by printer name instead of scrolling past office or PDF printers, tick only the printer(s) you use, and click Hide unused so unneeded printers stay hidden on both the laptop screen and the paired iPad/Android dropdown.',
      '📏 Dynamically add other paper sizes (+ Add paper size): Add 3.5×5 (3R), 5×7 (5R), 6×8 (6R), 8×10 (8R), Postcard, Keychain, A6, A5, A4, Letter, load sizes directly from your printer driver, or add custom inches/mm sizes (with optional 2-up cut) right alongside your 4×6 and 2×6 Cut test buttons.'
    ]
  },
  {
    date: '2026-11-25', title: 'Android 1.2.20: Offline Laptop Print Station over Booth Wi-Fi & Setup More Menu Tools', for: ['website', 'android'], android: '1.2.20',
    items: [
      '🖨️ Offline Laptop Print Station (Android Tablet App): Connect your Android tablet over your booth router or laptop hotspot to print straight to a Mitsubishi D80, DNP, HiTi, Canon, or Epson USB printer plugged into a Windows or Mac laptop — with zero internet and zero pop-ups.',
      '🔎 1-tap Wi-Fi detection & 6-digit PIN pairing: Open Laptop Print Station on the laptop (when enabled by your rental admin), tap Find Laptop on Wi-Fi in Setup → Printer on your Android tablet, enter the 6-digit PIN, and pick your printer for 4×6 or 2×6 cut strips.',
      '🧰 Quick Setup Menu & Faster Wi-Fi Printing: Open workspace tools directly from the ⋯ menu in Setup and send prints over local Wi-Fi as lightweight high-quality images for faster sessions.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.111 & iPad App (OTA): Setup More Menu Tools, Gated Offline Print Station & Faster Wi-Fi Printing', for: ['website', 'app', 'ipad'], app: '1.1.111',
    items: [
      '🧰 Tools inside Setup More menu (⋯): Open Photographer desk, 360 desk, Print requests, Arrange & Print, Video guestbook, All photos, Backup folder, and Booth Wi-Fi directly from Setup without starting a session first (keeps Camera, Printer, and resize controls focused inside Photo Session).',
      '🖨️ Built-in Offline Print Station in Laptop App Tools: Admin can enable Print Station per client code in Admin. Once enabled, it appears inside both Setup → ⋯ and Photo Session → Tools with your Laptop Wi-Fi address, 6-digit PIN, Mobile Hotspot switch, Driver Preferences, Test 4×6 / Test 2×6 Cut buttons, and live incoming iPad prints (while pausing laptop camera preview to save CPU).',
      '⚡ Faster iPad-to-laptop Wi-Fi printing: Photo sheets are sent as lightweight high-quality images and use cached printer status checks, cutting wireless send time per print.'
    ]
  },
  {
    date: '2026-11-25', title: 'Print Helper 1.1.24 & iPad App (OTA): Offline Laptop Print Station for Mitsubishi, DNP & HiTi USB Printers', for: ['website', 'ipad', 'helper'], helper: '1.1.24',
    items: [
      '🖨️ Offline Laptop Print Station (iPad & Android Apps): Print directly over your booth Wi-Fi or laptop hotspot to a Mitsubishi D80, DNP, HiTi, Canon, or Epson USB printer plugged into a Windows or Mac laptop — with zero internet and zero pop-ups.',
      '🔎 1-tap Wi-Fi detection & 6-digit PIN pairing: Open Laptop Print Station on the laptop (uses zero extra device slots), tap Find Laptop on Wi-Fi in Setup → Printer on your iPad app, enter the 6-digit PIN, and pick your printer for 4×6 or 2×6 strips.',
      '📋 Built-in Laptop Dashboard with Test Print: View your laptop Wi-Fi address, rotate your 6-digit PIN, open driver preferences, send Test 4×6 or Test 2×6 Cut prints right from the laptop, and watch incoming iPad prints live.'
    ]
  },
  {
    date: '2026-11-25', title: 'Roving DSLR Bridge v1.1.4 (Android) & Android 1.2.19: Pick-to-Send Review Mode, Brightness Before Sending & Photoman Polaroid/Landscape Designer', for: ['website', 'android'], android: '1.2.19',
    items: [
      '☑️ Pick-to-Send mode in Roving DSLR Bridge (Android): Switch between Auto-Send All and Pick to Send so DSLR shots stay on your phone for quick review — send only the best shots one by one, multi-select batches, or skip blinks before they reach the laptop.',
      '☀️ Brightness slider before sending (Roving DSLR Bridge Android): Lighten or darken shots (-30% to +40%) with instant live preview on each photo or set a default brightness boost for dim venues, while leaving 0% photos untouched at original DSLR quality.',
      '🖼️ Portrait & Landscape visibility everywhere: Uncropped photo thumbnails with Portrait and Landscape badges and filter pills in Roving Photoman Studio, Photographer Phone Control, and the Roving DSLR Bridge review gallery.',
      '⭐ Favorite templates, 1-tap switching & automatic orientation routing: Pin your go-to templates (such as 4R 2-up Polaroid and 4R Landscape 1-Spot) to a quick-switch bar, or turn on Auto-switch by orientation so solo portrait shots and group landscape shots automatically pick the right layout.',
      '🎨 Independent Photoman Landscape & Polaroid Template Maker: Design 2-up Polaroid and Landscape frames completely separately from your main booth setup with full patterns, decorative borders, florals, stickers with Mirror Half, rotated and outlined text, and 1-click Matching Pair creation.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.110, iPad 1.1.29 & Website: Desktop Online Mode with Google Drive & PayMongo, Device Labels, iPad Wireless Printing & DJI Osmo Pocket 3', for: ['website', 'app', 'ipad'], app: '1.1.110', ipad: '1.1.29',
    items: [
      'Desktop Online Mode (Windows & Mac): Run your online booth right inside the photobooth4u desktop app with built-in silent printing, USB DSLR cameras, and HDMI guest screen — no browser or separate Print Helper needed. Every photo saves a local copy on your laptop and uploads straight to Google Drive at the same time, with an online QR guests can scan or snap a photo of to download at home.',
      'PayMongo QR Ph in the Desktop App: Connect your PayMongo account once in My Events on the website, and any desktop device running in Online Mode accepts live QR Ph payments automatically.',
      'Per-device Online/Offline control & Device Labels: Give each laptop or tablet a friendly label (such as Main Booth or Studio Mac) when activating your code, in Setup, or on My Events so each slot is easy to tell apart on multi-device codes. Specific desktop devices can run in Online, Offline, or Both modes without affecting other devices on the same code.',
      'Direct wireless printing from iPad (Epson EcoTank L8050 & Wi-Fi printers): Print borderless glossy 4x6 photos directly from the iPad app over Wi-Fi Direct or your event Wi-Fi router — even on printers without Apple AirPrint, with no laptop needed.',
      'DJI Osmo Pocket 3 & external USB-C camera support on iPad: Plug a Pocket 3 into a USB-C iPad (iPadOS 17 or newer) and tap Webcam for automatic detection, crisp 1080p prints, proper framing on portrait stands, and automatic reconnect if bumped, plus a new step-by-step setup guide on the website.',
      'Faster, sharper animated GIF slideshows and Photographer Desk upgrades: Pin favorite layouts, automatically match portrait or landscape templates to each incoming shot, and generate cleaner GIF slideshows faster.'
    ]
  },
  {
    date: '2026-11-25', title: 'Roving DSLR Bridge v1.1.3 (Android): Offline Wi-Fi Routing, Screen-Off Queue Reliability & Duplicate-Safe Upload', for: ['website'],
    items: [
      '📶 Offline booth Wi-Fi / hotspot routing fix: binds local uploads and connection checks directly to the booth Wi-Fi network so reconnects succeed even when 4G/5G mobile data stays enabled.',
      '⚡ Faster reconnect & mid-upload recovery: detects Wi-Fi readiness immediately, aborts stalled connections on Wi-Fi drops, and starts fresh connections after drops.',
      '🔋 Screen-off Pocket Mode reliability: keeps the device awake while Pocket Mode or pending queue uploads are active so shutter capture and auto-retry keep running if the screen turns off.',
      '🛡️ Queue & receiver hardening: quarantines oversized (>80 MB) or empty files so they never block newer shots, closes startup restore races, arms auto-retry after failed Save & Test, and prevents duplicate or cut-off uploads on the laptop receiver.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.109, Android 1.2.18, iPad 1.1.28 & Website: Thermal voucher printing, Flipbook borders & overlays, printer fixes & Tablet Bridge reconnect', for: ['website', 'app', 'android', 'ipad'], app: '1.1.109', android: '1.2.18', ipad: '1.1.28',
    items: [
      '🧾 Print vouchers on thermal receipt printers (58 mm & 80 mm): Tap Print tickets in Setup › Session › Payment & vouchers to print clean black-and-white voucher slips straight to your Bluetooth, USB, Wi-Fi, or laptop thermal printer (or A4 sheets). Choose Next 1, a custom batch, or all unused codes, pick auto-cut or continuous tear strips, track which codes were already printed, and automatically include your event date when enabled.',
      '📖 Flipbook borders, custom PNG frame overlays & live Setup preview: Add clean borders around every flipbook card, upload your own transparent frame overlay, pick a wider left binding margin for stapling or binding, and preview changes right inside Setup.',
      '🖨️ Cleaner thermal prints & reliable Canon SELPHY printing (Android, iPad & Laptop): Removed grainy speckling on thermal receipt photos across Rongta, VOZY, and 58 mm / 80 mm models, protected 58 mm printers from cut-command glitches, and improved multi-sheet Canon SELPHY CP1300 / CP1500 printing on Android, iPad, and laptop.',
      '📱 Stronger Tablet Bridge reconnect on Huawei & Android tablets: Survives brief Wi-Fi drops without kicking back to the laptop webcam, automatically reconnects the tablet camera when Wi-Fi returns, and adds Huawei Wi-Fi+ troubleshooting steps to the setup guide.',
      '📶 New Offline QR Sharing & Booth Wi-Fi guide: Added a visual step-by-step guide explaining how guests download photos over your booth Wi-Fi when the venue has no internet.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.108 & Website: Wi-Fi & USB Mac Epson L8050 Auto-Glossy + High Quality fix', for: ['website', 'app'], app: '1.1.108',
    items: [
      '📶 Fixed Wi-Fi Mac Epson L8050 printing: Epson L8050 printers connected over Wi-Fi using Epson’s Mac driver now get automatic Photo Paper Glossy and High Quality at 720 dpi just like USB.',
      '🖨️ Print Station & iPad printing through a Mac: Remote prints sent through a Mac laptop to an Epson L8050 now default to Best quality, saving Configure printer refreshes paper slots right away, and AirPrint queues keep your chosen paper type.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.107 & Website: Mac Epson L8050 readable paper & quality names + automatic Glossy High Quality', for: ['website', 'app'], app: '1.1.107',
    items: [
      '🖨️ Readable English printer settings on Mac: Paper types, print quality, and driver options in Configure printer and Paper / media type now show real names like Photo Paper Glossy, Epson Premium Glossy, Matte, and High Quality instead of driver code numbers.',
      '✨ Automatic Glossy photo paper & High Quality on Mac Epson L8050: Borderless prints on Epson L8050 now automatically select Photo Paper Glossy and High Quality at 720 dpi when Print quality is set to Best, with Print Quality placed right at the top of Configure printer.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.106, Android 1.2.17, Print Helper 1.1.22 & Website: Tablet Bridge live-preview mirror fix + updated setup guide', for: ['website', 'app', 'android', 'helper'], app: '1.1.106', android: '1.2.17', helper: '1.1.22',
    items: [
      '🪞 Fixed Tablet Bridge camera mirroring (Android): The live preview on Android and Huawei front cameras now matches the Mirror On/Off toggle and the saved photo instead of appearing flipped opposite.',
      '📖 Updated visual Tablet Bridge guide: Clear step-by-step laptop-first Wi-Fi setup (Same Wi-Fi Router & Laptop Booth Wi-Fi) with visual mockups showing both the Activation screen and the long-press Operator Menu pop-up for already-activated tablets.'
    ]
  },
  {
    date: '2026-11-25', title: 'Desktop 1.1.105, Android 1.2.16, Print Helper 1.1.21 & Website: Reliable online & offline Tablet Bridge + built-in setup guide', for: ['website', 'app', 'android', 'helper'], app: '1.1.105', android: '1.2.16', helper: '1.1.21',
    items: [
      '📶 Fixed offline router timeouts (Android & Windows): Android and Huawei tablets now stay locked onto your offline pocket router, laptop hotspot, or USB cable instead of timing out or jumping to mobile data, and the Windows installer automatically allows local bridge traffic on both Private and Public Wi-Fi.',
      '🌐 Tablet Bridge on the online website: You can now pair an Android or Huawei tablet as your Guest Screen and Camera straight from the online website in Chrome or Edge using Print Helper 1.1.21 — and it keeps working even if venue internet drops mid-event.',
      '❓ Built-in ? guide in Setup Step 7: Added a quick ? guide button right next to Tablet Bridge with step-by-step online, offline, and timeout troubleshooting tips, plus automatic connection keepalive and auto-reconnect on quiet pocket routers.'
    ]
  },
  {
    date: '2026-11-24', title: 'Android 1.2.15 & Website: Epson L8050 Wi-Fi & Wi-Fi Direct printing + true-color fix', for: ['website', 'android'], android: '1.2.15',
    items: [
      '📶 Epson L8050 wireless printing (Android): The tablet app now finds and connects to Epson L8050 printers on Wi-Fi and Wi-Fi Direct automatically — even on printers where standard wireless printing is turned off by default.',
      '🎨 True-color and sharper Epson L8050 prints: Fixed faded or off-color prints over USB and Wi-Fi, made 4×6 prints sharper by default (with an optional extra-sharp setting), and added a Premium Glossy paper option alongside Epson Glossy.',
      '🧪 Easier Wi-Fi printer testing: Added one-tap Epson L8050 test presets to the Wi-Fi Printer Test tool that automatically pick the right connection when wireless settings differ.'
    ]
  },
  {
    date: '2026-11-24', title: 'Android 1.2.14 & Website: Sharper, borderless Epson L8050 printing over USB and Wi-Fi', for: ['website', 'android'], android: '1.2.14',
    items: [
      '🖨️ Epson L8050 color band fix (Android): Fixed rainbow color bands on 6-ink Epson L8050 and L18050 printers and automatically cleared older problem print settings.',
      '✨ Sharper 4×6 prints without tablet slowdowns: Improved Epson L8050 borderless print quality on 4×6 photo paper while keeping memory use low so tablets stay fast and stable.',
      '📐 Borderless setting stays turned on: Switching printers or pairing a receipt printer alongside a photo printer no longer resets your Borderless setting back to off.',
      '📶 Faster Wi-Fi Direct & USB reconnection: Switching between regular Wi-Fi and printer Wi-Fi Direct updates right away, sleeping printers wake automatically, and unplugged USB printers reconnect before your test print.'
    ]
  },
  {
    date: '2026-11-24', title: 'Desktop 1.1.104, Android 1.2.13, iPad 1.1.27 & Website: Simpler Photo Spot Editor, Working Frame Search & Overlay Fix', for: ['website', 'app', 'android', 'ipad'], app: '1.1.104', android: '1.2.13', ipad: '1.1.27',
    items: [
      '✨ Cleaner, faster Edit photo spots: Added a one-click bar to repeat photos across strips or keep every spot separate, kept advanced frame options neatly tucked away until needed, and showed resize/tilt handles only on the photo box you tapped.',
      '🔍 Working frame search & category tabs: Fixed the Your frames search box and All / Selected / Strips / 4R / Full filter tabs with live counts and a quick Show all frames reset.',
      '📍 No more jumping back to the top: Picking a frame near the bottom of Your frames now keeps your place instead of scrolling back to the top.',
      '🧩 Uploaded overlays appear right away: Fixed a timing issue and overly strict background removal that could leave newly added PNG or Canva overlays invisible.'
    ]
  },
  {
    date: '2026-11-24', title: 'Desktop 1.1.103, Android 1.2.12, iPad 1.1.26 & Website: Restored Layout Picker & Startup Sync', for: ['website', 'app', 'android', 'ipad'], app: '1.1.103', android: '1.2.12', ipad: '1.1.26',
    items: [
      '🛠️ Layout picker & uploaded frames restored: Fixed an error that stopped accounts with uploaded frames from displaying their frames and built-in layouts in Setup → Layout.',
      '🔄 Reliable startup sync: Your saved setup and uploaded frames now finish syncing cleanly every time the booth opens across Web, Laptop, Android, and iPad.'
    ]
  },
  {
    date: '2026-11-24', title: 'Desktop 1.1.102, Android 1.2.11, iPad 1.1.25 & Website: Account-Wide Uploaded Frames & Seamless Cloud Sync', for: ['website', 'app', 'android', 'ipad'], app: '1.1.102', android: '1.2.11', ipad: '1.1.25',
    items: [
      '🖼️ Uploaded frames stay in your account: Your uploaded frames now live in a permanent account library (with older frames rescued automatically). Switching events, loading a profile, updating the app, or resetting Setup will not erase your frames.',
      '🔄 Seamless syncing across Laptop, Android, iPad & Web: Fixed false offline warnings on hotspots and venue Wi-Fi, added automatic syncing when waking the app or reconnecting to Wi-Fi, and lets you tap the save status label to sync anytime.',
      '⚡ Reliable large-frame downloads & bigger setups: Large frame images now download smoothly one by one without timing out, larger event setups are supported, and a blank tablet can no longer overwrite a newer setup saved on another device.'
    ]
  },
  {
    date: '2026-11-24', title: 'Desktop 1.1.101, Android 1.2.10, iPad 1.1.24 & Website: Simpler Setup, Live Hover Layout Previews & Faster Mobile Preview', for: ['website', 'app', 'android', 'ipad'], app: '1.1.101', android: '1.2.10', ipad: '1.1.24',
    items: [
      '🖼️ Live hover layout previews: Hovering over Chosen layout, Solo layout, Plain camera, or Slideshow frame buttons now shows a live thumbnail preview alongside the active layout name.',
      '🧭 Clearer Session tabs & synced voucher-printer switch: Split Pay & photos into Countdown & retakes and Payment & vouchers (hidden when payments are off), and added a synced Link each option / voucher to its own printer switch.',
      '✨ Cleaner Design & Printer setup: Simplified the Design bar and tucked advanced printer options into tidy expandable sections while keeping everyday print controls up front.',
      '📱 Faster phone & tablet preview: Improved docked mobile preview controls with quick frame switching and fixed long layout name wrapping.'
    ]
  },
  {
    date: '2026-11-23', title: 'Android 1.2.09 & Website: Two-way smart lighting & relay control for cash-acceptor booths', for: ['website', 'android'], android: '1.2.09',
    items: [
      '⚡ Two-way Bluetooth & USB lighting control: Connect a compatible relay or LED light controller box over Bluetooth or USB (alongside coin/bill acceptors) on Android tablets and Chrome/Edge.',
      '💡 Lights react to every booth step: Booth lighting and relays can now turn on and off automatically for idle waiting, payment open, countdown, shutter flash, printing, and session end.',
      '🎛️ Built-in lighting controls & quick tests: Added lighting controls in Setup → Light, sound and start (works on free events too) with quick buttons to test lights, flash, and coin slot states, plus updated setup instructions on /cash-acceptor/.'
    ]
  },
  {
    date: '2026-11-23', title: 'Android 1.2.08, iPad 1.1.23 & Website: Lightness & Colour Correction Restored on Tablets', for: ['website', 'android', 'ipad'], android: '1.2.08', ipad: '1.1.23',
    items: [
      '🎨 Restored Lightness & Colour Correction (and Colour presets) in Print Settings on Android tablets, Android phones, iPads, and Print Station mode.',
      '📐 Restored Photo size on paper, Borderless, Edges (margins) / Edge test, and Thermal print quality / darkness & smooth-print test strips on Android and iPad.',
      '👆 Lightness & Colour Correction now appears directly in Print Settings on the Android app instead of being nested inside More options.'
    ]
  },
  {
    date: '2026-11-23', title: 'Android 1.2.07 & Website: Multi-Layout Selection on Uploaded Frames', for: ['website', 'android'], android: '1.2.07',
    items: [
      '✅ Fixed uploaded frames ("Your frames") so multiple frames and built-in layouts can be tapped and ticked together in Setup → 3. Layout on Android tablets and phones.',
      '👆 Larger touch-friendly tick targets and clear highlight borders on all ticked cards; tapping a frame card or tick automatically builds up multiple guest choices (and lets you untick the active main layout cleanly).',
      '💾 Preserved ticked uploaded frames across restarts and uploads (uploading multiple frames automatically enables guest layout choice), plus smoother Android preview touch handling.'
    ]
  },
  {
    date: '2026-11-23', title: 'Roving DSLR Bridge v1.1.2 (Android): Save photos when out of Wi-Fi range & send automatically on reconnect', for: ['website', 'android'],
    items: [
      '📦 Offline photo queue: Photos taken while out of Wi-Fi range stay saved safely on the phone even if the app closes, instead of failing.',
      '🔄 Automatic upload on reconnect: As soon as the booth Wi-Fi or laptop is back in range, queued photos send automatically in the order they were taken.',
      '⏳ Pending counter & 1-tap Retry Now: See how many photos are waiting on the main screen, Pocket Lock, and Session Gallery (and clearing the gallery protects unsent photos).'
    ]
  },
  {
    date: '2026-11-23', title: 'Android 1.2.06 & Website: Easier Wi-Fi Printer Test copy & live status refresh', for: ['website', 'android'],
    items: [
      '📋 Reliable Copy test report button: Copying the Printer Report or Wi-Fi Printer Test report now works reliably offline in the Android app.',
      '📶 Live Wi-Fi status refresh: Opening the Wi-Fi Printer Test drawer (or tapping Refresh Wi-Fi) checks your current connection right away and detects Epson Wi-Fi Direct automatically.',
      '📡 Send report to support: Works directly from the Android app whenever internet is connected, and automatically copies the report if you are offline.'
    ]
  },
  {
    date: '2026-11-23', title: 'Desktop 1.1.100, Android 1.2.05, iPad 1.1.22 & Website: Cooler, smoother iPad camera, DSLR & Welcome video playback', for: ['website', 'app', 'android', 'ipad'], app: '1.1.100', android: '1.2.05', ipad: '1.1.22',
    items: [
      '⚡ Cooler, smoother iPad camera & USB DSLR live preview: Pauses background camera filters while the Welcome video or branded card is showing, keeping the iPad cooler and eliminating preview stutter.',
      '🎬 Faster, lighter Welcome videos on iPad, Android & Laptop: Frees video memory when leaving Setup and handles large Welcome videos smoothly even on budget 2 GB tablets.',
      '🔋 Lower idle battery & CPU use: Stops unnecessary background checks when no remote or controller is connected and keeps screen orientation changes snappy.'
    ]
  },
  {
    date: '2026-11-23', title: 'Desktop 1.1.99, Android 1.2.04, iPad 1.1.21 & Website: Freeform Multi-Overlays in Layout, Remove-All Overlays, and Click-to-Slice Edit Layout', for: ['website', 'app', 'android', 'ipad'], app: '1.1.99', android: '1.2.04', ipad: '1.1.21',
    items: [
      '🧩 Sticker-style freeform overlays in 2 · Layout (Your frames & Frame collage): uploaded PNG overlays now start small with their natural aspect ratio so you can add multiple overlays, drag to move, resize from corners or slider, rotate from the top handle or slider, Duplicate to copy onto another strip, bring to front, or toggle Fit full frame — plus Canva Free outer-white knockout that keeps white inside outlines.',
      '🧹 Apply & Remove overlays across all frames: alongside Apply to all frames, a Remove overlays from all frames button lets you clear overlays across every uploaded frame in one step.',
      '📐 On-demand Edit layout slicing: uploaded frames stay whole by default and only slice into cuttable sections when you explicitly click Edit layout (with Clear sections to return to a whole frame anytime).'
    ]
  },
  {
    date: '2026-11-23', title: 'Android 1.2.03 & Website: Test guest payments in the free trial & easier DIY payment/lighting setup', for: ['website', 'android'], android: '1.2.03',
    items: [
      '🧪 Test guest payments in the free web trial: The free web trial now unlocks Guest payments in Setup so you can try coin/bill acceptors and your own QR payment setup in Chrome or Edge before renting.',
      '📄 Simpler DIY setup guide on /cash-acceptor/: Added 1-click file downloads, copy buttons, and a quick 2-minute dashboard guide with no command-line tools needed.',
      '📱 Android custom payment server fix: Fixed Android offline apps so your own custom payment server link connects smoothly without being blocked.'
    ]
  },
  {
    date: '2026-11-23', title: 'Desktop 1.1.98, Android 1.2.02 & iPad 1.1.20: Welcome-Matched QR Screen, Idle Video Sound, Offline Trial & Cash Acceptor', for: ['website', 'app', 'android', 'ipad'], app: '1.1.98', android: '1.2.02', ipad: '1.1.20',
    items: [
      '✨ Welcome-matched QR & sharing screen + clean guest flow: The QR & sharing screen now matches your custom Welcome screen theme, with the photobooth4u logo removed from active session and guest screens.',
      '🎬 Idle video sound toggle & iPad USB camera fix: Added an optional sound toggle for Welcome videos, fixed a black preview on iPad external USB cameras, and kept the event name editable inside Share.',
      '🖼️ Custom PNG overlays on Your frames: Add PNG overlays directly onto uploaded frames while keeping white doodles inside artwork intact.',
      '🪙 Offline app free trial & coin/bill cash acceptor: Try the offline Laptop, Android, and iPad apps with a trial code, connect a Bluetooth or USB coin/bill cash acceptor box, or connect your own PayMongo QR payment setup.'
    ]
  },
  {
    date: '2026-11-23', title: 'iPad 1.1.19: Silky-smooth live camera & filters on iPad A16 and Center Stage iPads', for: ['ipad'], ipad: '1.1.19',
    items: [
      '⚡ Faster, smoother iPad A16 & Center Stage camera: Live preview runs smoothly at full speed without lag while still capturing sharp high-resolution photos.',
      '🔄 No more 1-second stutter in portrait mode: Fixed camera rotation hiccups and smoothed out layout updates so movement feels instant.',
      '🎨 Smoother live filters & non-fullscreen previews: Live filters run smoothly without slowing down the screen, and viewfinder resolution choices in Setup apply cleanly.'
    ]
  },
  {
    date: '2026-11-23', title: 'Desktop 1.1.97, Print Helper 1.1.20, Android 1.1.101 & iPad 1.1.18: HiTi & Dye-Sub 2×6 Auto-Cut, Secondary Printer & Direct USB Canon SELPHY', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.97', android: '1.1.101', ipad: '1.1.18', helper: '1.1.20',
    items: [
      '✂️ New Secondary 2×6 Split Strips Printer card in Print settings: Assign Printer 1 to full 4×6 prints and a second printer slot to 2×6 cut strips (each with its own Lightness, Colour Correction, Edges, and paper slot) plus 1-tap test buttons.',
      '🖨️ Smarter HiTi, DNP & Citizen photo printer support (Windows & Mac): Automatically switches between full 4×6 and 2×6 cut paper modes, preserves your printer finish and color settings, prevents thin white edge hairlines, and pairs 2×6 strips neatly onto 4×6 sheets.',
      '📱 iPad & Android Print Station split routing: Choose separate printers for full 4×6 prints and 2×6 cut strips on /print-station/ with updated step-by-step HiTi setup tips on /how-to-print-hiti/.',
      '🔌 Direct USB Canon SELPHY printing (Windows & Mac Laptop App): Print straight to a Canon SELPHY (CP820–CP1500) over USB even when no system printer driver is installed.'
    ]
  },
  {
    date: '2026-11-22', title: 'Desktop 1.1.96, Android 1.1.100 & iPad 1.1.17: In-Place Edit Layout for Multi-Section & 4-in-1 Frames', for: ['website', 'app', 'android', 'ipad'], app: '1.1.96', android: '1.1.100', ipad: '1.1.17',
    items: [
      '📐 New Edit Layout mode for 4-in-1 and multi-section custom frames: Tap Edit layout right under your uploaded frame to slice, drag, and rotate individual sections (such as Polaroid, Mini Wallet, or Mini Photo Strips) inside one 4×6 sheet.',
      '🔒 Exact print sizes stay locked with zero stretching: Rotating a sideways section keeps its photo window aligned with gentle edge snapping, clean layering, 1-tap Reset layout, and automatic saving.'
    ]
  },
  {
    date: '2026-11-22', title: 'Android 1.1.99 & iPad 1.1.16: Epson L8050 Wi-Fi / Wi-Fi Direct printing fixes & built-in Wi-Fi Printer Test', for: ['website', 'android', 'ipad'], android: '1.1.99', ipad: '1.1.16',
    items: [
      '🖨️ Fixed Epson L8050 and other Wi-Fi photo printers refusing to print after the glossy update: Printers now receive paper type and quality settings cleanly, sleeping printers wake and retry automatically, and Wi-Fi Direct connections are found first.',
      '🔎 New built-in offline Wi-Fi / Wi-Fi Direct Printer Test (Setup → Printer → Wi-Fi / Wi-Fi Direct Printer Test, and /printer-test/): Checks printer compatibility without wasting paper, prints a 1-sheet sharpness and edge ruler test, warns if a job stalls, and lets you copy a full support report offline.'
    ]
  },
  {
    date: '2026-11-22', title: 'Desktop 1.1.95, Print Helper 1.1.19, Android 1.1.98 & iPad 1.1.15: Canon EOS 1500D SD Card + Rear Screen Live View & 2-Step Picker', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.95', android: '1.1.98', ipad: '1.1.15', helper: '1.1.19',
    items: [
      '📷 Canon EOS 1500D / 2000D / Rebel T7 support: Keeps saving backups onto the camera SD card while sending photos to the laptop, and keeps the live preview visible on both the camera screen and the booth screen.',
      '🎨 2-Step Black & White vs Coloured Layout Picker: When Separate B&W and colour prints is on, guests pick B&W designs or Coloured designs first and then pick their layout — synced across external guest screens too.',
      '🔄 Rotate individual photo spots (90° / 180° / 270°), auto-section 4-in-1 layouts, and build landscape collages.',
      '📱 New interactive 360 Booth guides (/how-to-360/dslr/ and /how-to-360/iphone/) plus iPhone/iPad 360 Arm Camera downloads on /downloads/.'
    ]
  },
  {
    date: '2026-11-22', title: 'Desktop 1.1.94 + Print Helper 1.1.18: 360 Booth for DSLR / Mirrorless, Capture Card & GoPro with Tablet Motion Trigger', for: ['website', 'app', 'helper'], app: '1.1.94', helper: '1.1.18',
    items: [
      '🌀 New Record 360 tab in the 360 Desk: Connect a Canon, Nikon, GoPro, or capture card on your 360 arm alongside a Windows tablet or laptop and save clips straight into your 360 Inbox with automatic speed effects, music, overlays, Live Wall cues, and QR sharing.',
      '⚙️ In-app camera video exposure controls: Adjust Shutter Speed (with 1/125 and 1/250 action presets), Aperture, ISO, White Balance, and Autofocus right inside the booth on Canon and Nikon cameras.',
      '📐 Automatic spin motion trigger: Surface Pro and Windows 2-in-1 tablets on the arm can start recording automatically when the arm spins and stop after a set time or when the arm stops, alongside iPhone/iPad Arm Sensor and remote clicker triggers.',
      '📦 Smooth large video transfers: High-frame-rate 360 clips transfer smoothly with a live progress bar so large recordings never freeze the app.'
    ]
  },
  {
    date: '2026-11-22', title: 'Desktop 1.1.93, Android 1.1.97 & iPad 1.1.14: in-app All Photos Reprint Pop-up, glossy defaults & steady preview', for: ['website', 'app', 'android', 'ipad'], app: '1.1.93', android: '1.1.97', ipad: '1.1.14',
    items: [
      '🖨️ New in-app Browse & Reprint gallery and pop-up: Tap All photos → Browse & Reprint to reprint earlier photos right inside the app without a system print pop-up. Switch printer, paper size, and copies on the spot.',
      '🛠️ Fixed gallery reprinting inside the Android app, iPad local gallery, private online galleries, and web browsers without Print Helper.',
      '✨ Glossy photo paper & Best quality by default: The laptop app and direct Wi-Fi/USB printers now start on glossy photo paper and best quality for borderless photo printers (any setting you pick manually still wins).',
      '📐 Steady Setup preview: Switching paper sizes across all 22 built-in layouts keeps the sheet centered at its true shape without jumping or shifting buttons.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.92: fix blank booth screen on startup in 1.1.91, plus 3-mode Final Shots Slideshow GIF', for: ['website', 'app'], app: '1.1.92',
    items: [
      '🛠️ Fixed Desktop 1.1.91 failing to show the booth screen on startup and added an automatic build check so incomplete app builds cannot be released.',
      '🖼️ Final Shots Slideshow GIF now offers 3 slide frames: Polaroid card, Event design / my template (each photo framed in your 1-photo design), and Event layout, still photos (photos drop into your strip or grid one by one).'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.91, Print Helper 1.1.17, Android 1.1.96 & iPad 1.1.13: fix Canon 1300D zoom-in, Slideshow GIF & consistent print brightness', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.91', android: '1.1.96', ipad: '1.1.13', helper: '1.1.17',
    items: [
      '📷 Fixed Canon EOS 1300D (and other Canon cameras) zooming in after each shot: The booth automatically keeps the camera on full 3:2 framing while connected (and restores your camera setting afterwards) so the live preview matches the saved photo.',
      '🖼️ Final Shots Slideshow GIF mode: Turn guests’ final photos into a cross-fading slideshow on Polaroid-style cards or inside your event’s own design.',
      '📐 Tighter custom-frame framing & accurate review previews: Reduced hidden edge crop inside custom frames from ~8% to ~1.6% so heads and edges are not unexpectedly clipped.',
      '🖨️ Fixed occasional dark prints or lost print settings: Lightness and colour tweaks no longer reset when refreshing printers, and Windows printing retries automatically if the printer queue is briefly busy.',
      '⚡ Better timing for entry-level Canon cameras (1200D/1300D/1500D) and updated Canon flash guide tips.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.90 + Print Helper 1.1.16: Canon EOS 60D / 6D capture fix, external flash sync & faster sessions', for: ['website', 'app', 'helper'], app: '1.1.90', helper: '1.1.16',
    items: [
      '📸 Fixed Canon EOS 60D and 6D cameras failing to take photos when connected to a laptop, and improved handling for RAW+JPEG so photos download reliably.',
      '⚡ Reliable external flash & studio strobe sync on Canon DSLRs: The camera pauses live view briefly during the "Pose" moment so hot-shoe flashes and studio strobes fire cleanly in sync with the shutter.',
      '🚀 Faster between shots and after the last shot: Reduced wait checks between photos so the booth moves straight to the Review and Result screen faster.',
      '🔌 Swapping between different Canon camera bodies resets camera settings cleanly, and unplugged cables are detected immediately.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.89: the Windows camera part starts again, clearer webcam messages, and Photoman shows your framed photo', for: ['website', 'app'], app: '1.1.89',
    items: [
      '📷 Fixed: on Windows the camera part (DSLR / mirrorless control) never started in 1.1.87 and 1.1.88 ("The camera part could not start ... 127.0.0.1:0"). It starts again. Update, then reopen the app.',
      '🔎 If Windows does not answer the request for its list of webcams (a virtual camera driver such as Camo, EOS Webcam Utility or DroidCam is the usual cause), the booth now says so and what to switch off, instead of a helper error. When a webcam is busy, it names the app that is using it.',
      '🔁 The Camera step in Setup now has a Try again button under the camera message (before, only the guest screen had one).',
      '🖼️ Photoman: the Live Output Preview now shows the photos Auto-frame has received (the other spots stay sample) and, after a print, the finished framed print ("Just made · Session #N"), instead of going back to the sample.',
      '☝️ Photoman: Auto-frame no longer takes your hand-picked photos in arrival order. It waits 30 seconds after your last tap, and the hint shows "You picked 2 of 4".'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.88 + iPad 1.1.12: 360 Motion Trigger — starts recording by itself when the arm spins', for: ['website', 'app', 'ipad'], app: '1.1.88', ipad: '1.1.12',
    items: [
      '🌀 360 Motion Trigger: Mount an iPhone or iPad on the spinning arm and it automatically starts recording the moment the arm spins, then stops when the arm stops or after your chosen duration (3–60 seconds). No connection to the 360 motor needed.',
      '🎯 Guided sensitivity setup: A quick "Hold Still → Spin Arm" step calibrates start and stop speeds for your spinner, alongside a manual slider, cooldown, and 30/60/120 fps options.',
      '🆓 Free companion mode: On the iPad app’s activation screen, tap "360 Arm Camera (Free Companion)" and scan the QR in the laptop’s 360 Desk — uses no extra device slot.',
      '💻 Live status in 360 Desk: See the Arm Phone’s live spin state and battery with Start, Stop, and Calibrate controls while the guest TV shows "360 SPINNING". Clips transfer over booth Wi-Fi and wait safely if the laptop disconnects.',
      '📱 iPad 1.1.12 adds the new 360 Arm Camera screen with wide/standard/front lens switching, tap-to-focus, exposure/focus lock, and an accidental-tap screen lock.'
    ]
  },
  {
    date: '2026-11-21', title: 'iPad 1.1.11: fix portrait split/shifted camera preview and countdown frame lag', for: ['ipad'], ipad: '1.1.11',
    items: [
      '📸 Fixed iPad portrait camera preview bug: Fixed the issue where the camera preview could split or shift off-center with a black gap during countdowns.',
      '⚡ Smoother countdown & live filters: Live filters no longer pile up or lag during the countdown, and GIF/boomerang frame capture runs smoothly.',
      '🪟 Cleaner between-shot photo review: The live camera hides cleanly while reviewing each taken shot and stays aligned if the iPad rotates or resizes.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.87 + Android 1.1.95 + iPad 1.1.10 + Helper 1.1.15: Photoman Studio Workspace, Template Maker & Canon Fixes', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.87', android: '1.1.95', ipad: '1.1.10', helper: '1.1.15',
    items: [
      '🎨 Photoman Template Maker: Build separate Photographer Desk templates (4R, 5R, 2×6 Strip, Square) with presets, draggable/tiltable photo spots, text layers, studio logos, and frame punch-out without changing your main booth design.',
      '🪟 Dedicated Photoman Studio & Pop-Out Window: Full-screen Photographer Studio workspace with instant previews (Framed + QR vs Print Original), guest QR card, helpful (?) tips, and live sync when popped out into its own window or tab.',
      '📸 Better Canon manual-focus & flash support (Desktop 1.1.87 + Print Helper 1.1.15): Skips autofocus pauses when the lens switch is set to MF and shows clear reminders for external flash and studio strobe camera settings.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.86 + Android 1.1.94 + iPad 1.1.9 + Helper 1.1.14: Photographer desk templates, B&W / colour split, Camera check & direct printing', for: ['website', 'app', 'android', 'ipad', 'helper'], app: '1.1.86', android: '1.1.94', ipad: '1.1.9', helper: '1.1.14',
    items: [
      '📷 Photographer desk (Photoman): choose a template (the booth’s layout, Solo or any built-in layout, or an uploaded frame) without changing the booth’s own layout or paper, pick how photo spots fill (a photo per spot or one photo fills every spot), and enable Auto-frame to frame new arrivals automatically.',
      '📱 Phone control (laptop app): the Photoman desk’s phone page now syncs live state and lets you pick photos, change template, Make print + QR, Print copy, and move to the Next guest right from your phone.',
      '🧾 B&W / colour print split (opt-in, Setup → Layout): optional switch to tag B&W (thermal) vs Colour layouts and frames, and route each kind to its own printer in Setup → Printer. Off by default.',
      '🎛️ Cleaner Setup tabs & Camera check: Camera and Printer are now separate steps, Text sits inside Design, and Camera check reads your exposure settings and lets you apply suggested shutter, aperture and ISO to a Nikon over USB (Desktop, Android, Print Helper 1.1.14).',
      '🖨️ Built-in driverless USB and Wi-Fi printing on Laptop (no extra printer setup needed for many models), plus automatic printer re-discovery and print-problem alerts on iPad.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.85 (Win/Mac): the camera shoots once, at the shutter sound and flash (Nikon and Canon), with a guide for Canon', for: ['website', 'app'], app: '1.1.85',
    items: [
      '📸 Windows laptop app, Nikon and Canon over USB: the camera now takes ONE real photo, at the moment of the shutter sound and flash. Before, the app fired the shutter early to make up for the camera’s delay, so a Nikon clicked at “2” or “1”, and a live-view picture sat in the strip until the real photo replaced it. Both are gone. If the camera fails, the live-view picture from the shutter moment is still used, so a session never ends with a missing photo.',
      '🎯 To keep the photo close to the flash, a Nikon or a newer Canon (6D and similar) is focused during the last seconds of the countdown, and the shot then fires without focusing again. If a Canon ever gives no photo that way, it goes back to focusing inside the shot for the rest of the run. An older Canon (60D and similar) cannot focus beforehand, so its photo is taken a moment after the flash. Sony and the Mac / tablet camera parts still fire early by the delay they measured, as before, but they too no longer put a live-view picture in the strip first.',
      '⏱️ Canon: when the first shutter press does nothing (for example it could not focus), the app now waits about twice the camera’s own delay (3.5 to 4.5 seconds at least) before pressing again, instead of 6 or 8 seconds. A “busy” answer to that second press no longer fails the shot.',
      'ℹ️ New Canon guide (Setup → Camera, a blue “Canon tip” box): it says when the photo comes after the flash because the lens focuses inside the shot (slide the lens switch from AF to MF and focus once on the spot where guests stand), when photos still go through the SD card (use a fast card, JPEG only), and, when a photo was not taken, a short checklist (lens switch, mode dial, SD card lock, closed menu). The “after the flash” tip also shows once on screen after two late photos in a row.',
      '🧪 Not tried on a real Nikon or Canon yet. Please tell us how the photo timing feels, and send camera.log (in the photobooth4u folder under %APPDATA%): each Canon photo line says whether it was focused beforehand and how long the camera took.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.84 (Win/Mac): Epson L8050 4×6 borderless follows the driver’s Borderless Settings (Auto Expand Std / Med / Min, or Retain Size)', for: ['website', 'app'], app: '1.1.84',
    items: [
      '🖨️ Windows laptop app, Epson L8050: the driver’s Printing preferences > Borderless > Settings has a slider (Std / Med / Min) and “Retain Size”. They change how far the driver enlarges a borderless page: Std 5.3%, Med 2.6%, Min 1.4%, and Retain Size not at all. The app drew every picture for Std, so a driver on Med or Min left a white edge, and Retain Size left a white strip of about 3 mm along the right and bottom and cut the left and top. The app now reads that setting and draws the picture for it.',
      '⚠️ Retain Size cannot print edge to edge from the app (the page is smaller than the area the printer prints on). The picture now covers the left and top edges, and the booth says so: choose Auto Expand with the slider on Std in Printing preferences > Borderless > Settings. That is also what a client on Retain Size with a white strip along two sides needs.',
      '🧪 Measured on the driver’s file-port queue (no paper): where the picture lands for each setting matches the model. Not tried on a real L8050 sheet yet: print the Edge test and tell us how the edges look.'
    ]
  },
  {
    date: '2026-11-21', title: 'Desktop 1.1.83 (Win/Mac): Canon photos reach the booth faster, with a shorter wait between shots', for: ['website', 'app'], app: '1.1.83',
    items: [
      '📸 Canon cameras on a Windows laptop (60D, 6D and the like): the camera now sends each photo straight to the laptop instead of saving it on its SD card first. That removes most of the “Saving” wait after each shot, and RAW + JPEG no longer slows it down. The photo is the same full-size JPEG as before. When the booth lets go of the camera it puts “save to card” back, so photos you take on the camera itself are still saved.',
      '⏱️ Shorter wait between shots with a USB camera: the pause set in Setup → Photos now counts from the flash, not from the moment the photo arrives, so guests no longer wait for the camera and then wait the full pause again. The photo stays up for at least 2 seconds (or the whole pause, if you set it shorter) so guests can look at it or press Retake. Tap-to-continue and webcams work as before.',
      '🛟 If a Canon does not accept the new setting, or its photos stop arriving, the app goes back to saving on the card by itself and the shot still goes through.',
      '🧪 Not tried on a real Canon yet: please time “Saving” on a 60D or 6D and tell us. The camera log (camera.log in the photobooth4u folder under %APPDATA%) says “sent to computer” for each photo that took the new route.'
    ]
  },
  {
    date: '2026-11-20', title: 'Desktop 1.1.82 (Win/Mac) + Android 1.1.93: the tablet guest screen mirrors like the booth, and speaks, beeps and clicks by itself', for: ['website', 'app', 'android'], app: '1.1.82', android: '1.1.93',
    items: [
      '🗣️ With a tablet guest screen connected, the voice countdown (“Get ready… Three, Two, One… Smile!”) is now said by the tablet, not the laptop. Setup → Session → Voice lists the tablet’s own voices while it is connected (Tagalog only if the tablet has a Filipino voice). With no tablet, or a tablet with no voice, the laptop speaks as before.',
      '🔊 The countdown beeps, the “Pose” chime, the start chime and the shutter click now come out of the tablet too, and the laptop stays quiet. Your own uploaded shutter and beep files are sent to the tablet as well. If the tablet’s sound is not ready yet (a browser that wants one tap first), the laptop plays them as before.',
      '📸 New built-in shutter sound: a camera-style “ka-chak” (clack, second clack, soft thump) instead of one plain click. You can still upload your own in Setup → Session → Sound.',
      '🪞 Android tablet app 1.1.93: Mirror view in Setup → Camera now applies to the tablet’s own camera picture whichever camera is used. Before, the tablet only mirrored its front camera, so Mirror On did nothing on the rear camera. “Auto” follows the side the tablet reports, also after you flip the tablet camera. Update the tablet app for this one.',
      '🖨️ The tablet’s Print button shows “Printing, please hold…” in smaller letters so it fits inside the button.',
      '🧪 Not tried on a real tablet yet: please test the voice, the beeps, the shutter and Mirror, and tell us how they sound. The voice and the sounds need the new laptop app; Mirror and the tablet’s speech engine need the new tablet app too.'
    ]
  },
  {
    date: '2026-11-20', title: 'Desktop 1.1.81 (Win/Mac) + Android 1.1.92: Epson L8050 prints 4×6 borderless edge to edge', for: ['website', 'app', 'android'], app: '1.1.81', android: '1.1.92',
    items: [
      '🖨️ Windows laptop app, Epson L8050, 4×6 in with Borderless on: the printer’s Windows driver enlarges the page about 5% past the paper, so the edges of the picture were cut off (about 2.5 mm on the left and right, 3 mm at the top and 4.5 mm at the bottom). The app now draws the picture smaller and a little higher so it lands on the sheet edge to edge, with about 0.5 mm to spare. Other paper sizes are not changed.',
      '🖨️ Android app, Epson L8050, 4×6 in with Borderless on (USB or Wi-Fi): the printer started the picture about 2.7 mm to the left of the sheet, which left a white strip along one side and cut off the other side. The picture is now sent on a page the size of the printer’s own print area, so it lands on the sheet. If you moved Print settings → Edges by hand to fix this, set them back to 0.',
      '🧪 We could not try either change on a real L8050 sheet yet: please print a test and tell us how the edges look. Use glossy photo paper and tick Borderless in Print settings. The iPad app is not changed.'
    ]
  },
  {
    date: '2026-11-20', title: 'Desktop 1.1.80 (Win/Mac): the tablet guest screen now really gets its screen from the booth (photo after every shot, QR codes, QR pop-up, your sizes), and an Epson L8050 on Windows prints on glossy photo paper by default', for: ['website', 'app'], app: '1.1.80',
    items: [
      '🐞 Fixed: since the tablet guest screen (Laptop Guest + Camera Bridge) was first released, the booth could not build the screen it sends to the tablet. It called a function the booth does not have, and the error was hidden. So the tablet only showed the camera and the countdown. It never got the photo after each shot, the finished photo with its QR code, the QR pop-up, Print and Done, the layout choice, the welcome screen or your screen sizes. All of these now reach the tablet, the same as on the laptop’s own guest screen. After updating the laptop, pair the tablet again.',
      '🛠 If one part of the tablet screen cannot be built, the rest still goes to the tablet, and Setup → Guest screen → Tablet Bridge now says which part failed instead of failing silently.',
      '🖨️ Windows laptop app, Epson L8050: the printer’s Windows driver starts on Plain paper and Standard quality, so photos came out soft and dull unless a paper type was picked. The app already asks for Best quality; it now also asks for Epson Photo Paper Glossy when no paper type is picked. Choose another paper type (Plain paper included) in Print settings and that one is used instead. An iPad that opens the booth from this laptop (Setup → Share & start) prints through the same driver and gets the same result.',
      '🧪 We could not try the L8050 change on a real printer yet: print a test and tell us how it looks. Load glossy photo paper, or choose Plain paper in Print settings.'
    ]
  },
  {
    date: '2026-11-20', title: 'iPad 1.1.8: print straight to a Wi-Fi photo printer that is not AirPrint (Epson L8050)', for: ['ipad'], ipad: '1.1.8',
    items: [
      '🖨️ iPad app: A Wi-Fi photo printer that is not AirPrint (for example an Epson L8050 that only works with Epson Smart Panel) can now be used. In Setup → Printers, type the printer’s IP address and tap Add. The iPad checks the printer and shows it as Photo with its own name within a few seconds. Tap it to select it, then Test print. The iPad and printer must be on the same Wi-Fi, and tap Allow if the iPad asks for Local Network access.',
      '🎚️ For an Epson L8050 the Quality and Paper menus are available (High / Normal / Draft, and Glossy / Semi-gloss / Matte / Plain paper), and it prints on High quality, glossy photo paper unless you choose otherwise.',
      '⚠️ Please run a test print first; printers that do not support standard network photo printing cannot be added this way.',
      '🔢 Fixed the iPad app reporting its version number accurately when checking for updates.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.79 (Win/Mac) + Android 1.1.91: the tablet guest screen now matches the booth screen, and Epson L8050 over USB prints High quality on glossy photo paper', for: ['website', 'app', 'android'], app: '1.1.79', android: '1.1.91',
    items: [
      '🖨️ Android app, Epson L8050 over USB: the printer does not list its print qualities or paper types over USB, so the app sent none of them and every job came out on the printer’s own default (plain paper, standard quality), and the Quality and Paper menus never appeared. The app now asks for the quality and paper you pick anyway, the menus are there (High / Normal / Draft, and Glossy / Semi-gloss / Matte / Plain paper), and the L8050 prints on High quality, glossy photo paper unless you choose otherwise. The app also recognises the L8050 by its name. We could not try this on a real L8050 yet: please print a test and tell us how it looks.',
      '📸 Tablet as the guest screen (Laptop Guest + Camera Bridge): the photo the booth shows after each shot (Setup: show each photo after it is taken) now shows on the tablet too, with Retake and Next photo.',
      '🔳 The QR pop-up (Setup → Step 7 “Show the QR code in a pop-up”) now works on the tablet: the finished photo on its own for a few seconds, then a card with a big QR code, Print and Done. With “no QR code” the card holds Print and Done only.',
      '📐 The screen sizes you set (Display & monitor size, and “Resize on the guest screen”) now apply to the tablet: the countdown, the buttons and the photo strip follow your sizes and see-through levels, with a live preview on the tablet while you resize.',
      '🛡️ The tablet screen is steadier: each part (photo, QR code, buttons) is drawn on its own, a slow update can no longer replace a newer one, and one guest’s photo is never shown in place of the next guest’s.',
      '🔌 Setup → Guest screen → Tablet Bridge now says which link the tablet is using (Wi-Fi, laptop hotspot, USB tethering / Ethernet, or USB cable), and a numbered Ethernet adapter (how Windows names USB tethering) is listed first in the pairing QR. A cable is steadier than venue Wi-Fi.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.78 (Win/Mac) + Android 1.1.90 + iPad 1.1.7: offline-first cloud sync for Saved Profiles, My Themes, event setups and uploaded frames across all devices, plus smoother thermal receipt prints', for: ['website', 'app', 'android', 'ipad'], app: '1.1.78', android: '1.1.90', ipad: '1.1.7',
    items: [
      '☁️ Saved Profiles, My Themes, current event Setup and uploaded frames/logos/stickers/backdrops/sounds now sync automatically across the laptop app, Android tablet app, iPad app and web booth whenever connected to Wi-Fi — while keeping offline event operation 100% instant and unaffected.',
      '🖼️ All frames, logos, stickers and backdrops used inside synced Saved Profiles and My Themes are automatically downloaded and cached on the device while on Wi-Fi, so you can switch profiles offline at the venue with no internet.',
      '🔒 Each device now keeps its own 4-digit Lock PIN, voucher batches and print counts separately on that device (Admin’s Reset PIN still unlocks any device).',
      '🧾 Thermal receipt layout: removed the grainy preview dithering in Setup and upgraded thermal print tone, shadow detail and smooth dot shading for sharper receipt prints.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.77 (Win/Mac): the camera menu no longer freezes on laptops where Windows never lists the cameras, so the tablet camera starts', for: ['website', 'app'], app: '1.1.77',
    items: [
      '📷 On some laptops Windows never answers when the booth asks it for the list of cameras (a virtual camera such as Camo or EOS Webcam Utility with nothing behind it can do this). The booth waited for that answer forever, so the Camera menu stayed empty, no camera started, and “Use tablet camera” did nothing. The booth now waits a few seconds, then carries on with the cameras it knows.',
      '📲 The tablet camera (Laptop Guest + Camera Bridge) now starts as soon as the tablet is paired, without waiting for the laptop’s own camera list, and the “Use tablet camera” button starts it straight away and says if it is slow to start.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.76 (Win/Mac) + Android 1.1.89: tablet as the booth camera keeps its live picture running, Epson Wi-Fi printing fallback, and failed prints reported', for: ['website', 'app', 'android'], app: '1.1.76', android: '1.1.89',
    items: [
      '🖨️ Android app, Epson ink-tank photo printers over Wi-Fi (L805, L3250, L8050, L18050 and similar): when the standard Wi-Fi print job fails, for example on a printer’s own Wi-Fi Direct network, the photo is now sent in Epson’s own print mode instead, the same way the app already sends over USB. Once it works for a printer, later prints in that session go straight to it. A photo that may already be printing is never sent twice.',
      '🩺 Printer reports (Admin): a print that fails, or a failed test print, is now always reported to Admin → Printer reports, even when “Send printer diagnostics” is switched off. Only the printer’s name, USB ID, paper size and the error message are sent; no photos, guest details or network addresses. With the switch on, everything is reported as before.',
      '📷 Tablet as the booth camera (Laptop Guest + Camera Bridge): when the laptop was not showing the tablet’s own preview, the tablet camera could send the laptop only one picture every few seconds, so the laptop’s live view stayed black (“Waiting for the camera…”). The tablet app now keeps its camera feed running at full speed all the time. Update the tablet to Android 1.1.89, then tell us how the live view looks.',
      '🖥️ Laptop app: Setup → Guest screen → Tablet Bridge now has a “Use tablet camera” button next to “Flip tablet camera”. The Camera menu hides itself when the laptop has only one camera, so if the tablet camera was not picked automatically there was no way to choose it by hand. The button picks it, remembers the choice, and says why if it cannot start.',
      '📲 Tablet app: “🖥️ Laptop Guest + Camera Bridge” is now the first item of the Operator Menu (long-press the booth screen). Before, it was only inside “Booth Mode & URL”.'
    ]
  },
  {
    date: '2026-11-19', title: 'Android 1.1.88: Canon G1010 prints with Canon’s own colours, sharper, borderless on 4x6, and a slowest Best quality', for: ['android'], android: '1.1.88',
    items: [
      'Canon PIXMA G1010 (and other G-series over USB), 4x6: colours no longer come out faded. The ink for every colour is taken from what Canon’s own Windows driver puts down (measured on matte photo paper, glossy photo paper and plain paper), including its bigger dots for deep colours, so reds, blues and dark backgrounds print with the same depth as from a PC.',
      'Sharper: in High and Best quality, on photo paper and when printing borderless, the booth now builds a true 600 dpi page (2400 x 3600) instead of a 300 dpi one, so the extra dots carry real picture detail. The dots are also placed the way Canon places them, so flat tones no longer show faint stripes.',
      'Borderless on 4x6 now works on the Canon: the picture fills the whole sheet and the rim the printer sprays past the edge repeats the picture’s own edge, so nothing is cut off and no white edge shows. Switch Borderless on in the printer settings.',
      'New Best quality (600 dpi, slowest): Canon’s own High setting, with finer drops. White margins in a design are skipped the way Canon’s driver skips them. Normal and Draft are unchanged.'
    ]
  },
  {
    date: '2026-11-19', title: 'Android 1.1.87: Canon G1010 prints sharper in High quality (600 dpi) and on photo paper', for: ['android'], android: '1.1.87',
    items: [
      'Canon PIXMA G1010 (and G-series printers over USB): the High (600 dpi) quality is back and now works. It sends the same page data that Canon’s own Windows driver sends at its Standard 600 dpi setting, checked command by command with the driver, for 4x6 prints on plain paper. Photo paper (glossy) and matte photo paper are sent the way Canon’s driver sends them too: cyan, magenta and yellow ink only, 600 dpi. Other paper sizes stay at 300 dpi. Normal and Draft are unchanged. Please test a print on your own printer and tell us how it looks.'
    ]
  },
  {
    date: '2026-11-19', title: 'Android 1.1.86: Canon PIXMA G1010 prints reliably over USB; Brother USB printers recognised', for: ['android'], android: '1.1.86',
    items: [
      'Canon PIXMA G-series over USB (G1010 / G2010 and similar): prints at 300 dpi, the mode a G1010 was tried and printed on. The “Best (600 dpi, beta)” quality is removed for Canon printers because a G1010 did not print at all with it; use Normal or Draft. Newer G-series (G3010 family) ask the printer which page language it takes, and there is a new “Canon print language” choice in the printer options (Automatic is right for almost everyone).',
      'Brother ink-tank printers (DCP-T series) are recognised over USB, and the printer options list more paper types (inkjet paper, Brother BP71 photo). A printer that needs its own driver now says so on screen, with its USB ID, so it can be set up or reported.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.75 (Win/Mac): sharper high-resolution prints, original DSLR solo photos & backup masters', for: ['website', 'app'], app: '1.1.75',
    items: [
      '🖼️ Sharper prints: Laptop prints now render at much higher print detail (up to 750–900 DPI at top quality) so text, faces, and borders print crisper.',
      '📷 Original DSLR solo shots: On the laptop app, upright DSLR and full-size webcam solo shots keep the camera’s own untouched full-size photo whenever no mirror, background swap, or filter is applied.',
      '🎯 Sharper Nikon & low-ISO photos: Nikon DSLRs now automatically shoot at high-quality fine JPEG, and well-lit shots skip extra smoothing so skin and eyelash details stay crisp.',
      '💾 Optional Master photo copies: Keeps a private full-quality copy of every finished print in a "Masters" folder for you (on by default on the laptop app, never shown to guests), with faster photo saving.'
    ]
  },
  {
    date: '2026-11-19', title: 'Desktop 1.1.74 (Win/Mac): fixes "Tap to start" not responding in 1.1.73', for: ['website', 'app'], app: '1.1.74',
    items: [
      '👆 Fixed: in Desktop 1.1.73 the "Tap to start" screen could not be clicked, so the booth never opened. A start-up error in the new tablet guest-screen code stopped the booth page from finishing loading on the laptop app. If you are on 1.1.73, update to 1.1.74 from the update prompt on that screen (your activation, designs and photos stay).'
    ]
  },
  {
    date: '2026-11-19', title: 'Helper 1.1.13: Windows camera check says what Windows sees when a camera is not found', for: ['website', 'helper'], helper: '1.1.13',
    items: [
      '🔍 When the Windows helper cannot find a camera, it now checks Windows’ USB list and says what it found instead of only "No camera found": a camera whose driver did not start, one Windows is still setting up, one that is disabled in Device Manager, or a USB device Windows could not read. Each message says what to try.',
      '📝 The camera log now lists every camera-maker USB device Windows sees, with its device type, driver and Device Manager problem code, so a camera that shows up in Device Manager but not in the booth (for example a Canon EOS 1300D) can be traced from the Windows camera test report.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.73 (Win/Mac) + Android 1.1.85: Tablet Guest Screen + Camera Bridge & Guest Print Options', for: ['website', 'app', 'android'], app: '1.1.73', android: '1.1.85',
    items: [
      '📱 Tablet Guest Screen + Camera Bridge: Pair an Android tablet via QR over USB cable or laptop Wi-Fi to use the tablet as both the live Guest Screen and the booth camera.',
      '📷 Smooth guest live view & sharp photos: The tablet shows a smooth live camera preview behind the Guest Screen while sending full-quality photos straight to the laptop.',
      '🖨️ Guest Screen Print & Copies options: Both the paired tablet Guest Screen and extended-monitor Guest Screen now let guests tap Print, pick how many copies they want, see remaining print limits, and tap Done.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.72 (Win/Mac) + Helper 1.1.12: Canon EOS 1300D / Rebel T6 USB detection fix', for: ['website', 'app', 'helper'], app: '1.1.72', helper: '1.1.12',
    items: [
      '📷 Fixed Canon EOS 1300D / Rebel T6 / Kiss X80 not showing up: Resolved an issue where Windows listed these cameras as a generic USB device so the booth could not see them.',
      '🔍 Automatic Canon recognition: The booth now spots Canon cameras by their USB hardware signature even when Windows gives them a generic name, and retries connection cleanly on plug-in.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.71 (Win/Mac) + Android 1.1.83 + iPad 1.1.6: Camera preview between shots & live view hold', for: ['website', 'app', 'android', 'ipad'], app: '1.1.71', android: '1.1.83', ipad: '1.1.6',
    items: [
      '📷 Camera live view hold: camera live view now stays running through all shots and after the final shot until the result screen opens (eliminates premature camera sleep/blackout after last shot).',
      '🖼️ Between-shots review: still-image photo review with Retake option displays seamlessly between photos, and the full strip review screen allows retaking shot 3 before saving.',
      '🔋 Preserved battery saving: camera automatically goes to sleep during guest review and sticker decoration phase to preserve camera battery life.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.70 (Win/Mac) + Android 1.1.82 + iPad 1.1.5: iPad front camera & live preview fix', for: ['website', 'app', 'android', 'ipad'], app: '1.1.70', android: '1.1.82', ipad: '1.1.5',
    items: [
      '📱 iPad live camera preview fix: Fixed the black screen during photo sessions on iPad so the live camera view always shows clearly.',
      '📷 iPad Center Stage & Ultra-Wide front camera: The iPad app now discovers and uses the wide-angle Center Stage front camera on newer iPads (10th-gen / A16).',
      '⚡ Smooth real-time preview: Removed the 1-second lag and blank preview issue in Setup Step 4 for a smooth, responsive camera feed.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.69 (Win/Mac) + Android 1.1.81 + iPad 1.1.4: Smoother Canon EOS M50 II live view over USB', for: ['website', 'app', 'android', 'ipad'], app: '1.1.69', android: '1.1.81', ipad: '1.1.4',
    items: [
      '🎞️ Smoother live view with every USB camera in the app: the booth now asks for the next picture while the current one is being drawn, so the camera is never left idle between frames.',
      '📷 Canon EOS (M50 Mark II and others) on Android & iPad: the camera is checked for news every 6 s instead of 2 s while live view runs (no more small hitch), and a busy camera is asked again right away.',
      '📊 Live view speed and picture size are now recorded in the camera log so any lag can be checked easily.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.68 (Win/Mac) + Android 1.1.80 + iPad 1.1.3: More reliable Sony A7 III USB & iPad capture card support', for: ['website', 'app', 'android', 'ipad'], app: '1.1.68', android: '1.1.80', ipad: '1.1.3',
    items: [
      '📷 More reliable Sony A7 III USB connection (Windows, Mac, Android & iPad): Connects more consistently, retries automatically when the camera is briefly busy, and resets properly when opened or closed.',
      '⚙️ Steady Sony settings & startup: Applies single-shot and save-to-computer settings cleanly without errors during the first few seconds after plugging in.',
      '🍎 Better Mac Sony USB stability: Keeps the connection alive when idle and detects unplugged cables right away.',
      '🎥 iPad HDMI capture card stability: Takes snapshots smoothly from external HDMI capture cards without freezing and recovers automatically if a connection hiccups.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.67 (Win/Mac) + Android 1.1.79 + iPad 1.1.2: More reliable Sony A6400 & Alpha USB camera support', for: ['website', 'app', 'android', 'ipad'], app: '1.1.67', android: '1.1.79', ipad: '1.1.2',
    items: [
      '📷 Better Sony A6400 & Alpha USB support (Windows, Mac, Android & iPad): More reliable camera handshake and automatic setup for single shooting and saving photos straight to the booth.',
      '👁️ Faster, glitch-free Sony live view: Ignores blank warm-up frames and broken frames so the live camera view looks clean and steady.',
      '🖼️ Reliable RAW + JPEG & Android USB transfers: Skips unneeded RAW files cleanly and transfers full photos reliably on Android tablets.',
      '🍎 Better Windows & Mac Sony fallback: Windows automatically uses an alternate USB mode if the standard driver blocks the camera, and the Mac app now supports the same camera helpers and deep sleep behavior.'
    ]
  },
  {
    date: '2026-11-18', title: 'iPad app 1.1.1: Faster built-in iPad camera, smoother Video Guestbook & 1st-photo timer fix', for: ['ipad'], ipad: '1.1.1',
    items: [
      '⏱️ 1st-photo countdown timer saves properly: Your custom 2–60 second first-photo timer now saves and restores reliably across reloads and cloud sync.',
      '📷 Zero-lag built-in iPad camera & capture cards: Uses the iPad’s native camera engine for instant live preview, filters, and crisp photos (including HDMI capture cards on iPadOS 17+).',
      '🎥 Smoother Video Guestbook with sound: Records smoother video messages with all 15 looks and microphone audio.',
      '🔌 Stronger USB DSLR support: Automatically rescans connected cameras and shows clearer Canon M50 setup tips if a connection gets stuck.'
    ]
  },
  {
    date: '2026-11-18', title: 'iPad app 1.1.0: Zero-lag built-in iPad camera, smoother Video Guestbook & Canon M50 USB fix', for: ['ipad'], ipad: '1.1.0',
    items: [
      '📷 Zero-lag built-in iPad camera & capture cards: Switched from the slower browser camera to the iPad’s native camera engine for instant live preview, smooth filters, and fast capture.',
      '🎥 Smoother Video Guestbook with sound: Records crisp video messages with all 15 looks and microphone audio without preview lag.',
      '🔌 Stronger USB DSLR support: Automatically rescans connected cameras and shows clearer Canon M50 setup hints.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.66 + Android 1.1.78: Real-time branded card sync, direct preset selection & color profile enhancements', for: ['website', 'app', 'android'], app: '1.1.66', android: '1.1.78',
    items: [
      '⚡ Real-time admin welcome card sync: changes made in Admin to card layout, decoration, and palette now synchronize automatically to live and newly reopened booths without manual configuration.',
      '🎨 Default Studio Monochrome: newly created non-Charm booths default cleanly to Studio Monochrome and minimal decoration, while Charm Up booths retain signature Charm Blush and Waves.',
      '🎛️ Direct-selection preview toolbar: instant 1-click chip controls for welcome card layout, decoration, and palette inside the preview modal with auto-open on table click and reverse cycling support.',
      '📐 Spacing & responsive layout fix: generous distance between cards and photo strips in landscape with vertically stacked responsive hierarchy in portrait to eliminate crowding.',
      '🌈 Hardware color profile persistency: complete preservation of hue shift, saturation, temperature, tint, brightness, contrast, and color presets across app restarts.'
    ]
  },
  {
    date: '2026-11-18', title: 'Desktop 1.1.65 + Android 1.1.77: Optional Roving DSLR photo editing before QR & print', for: ['website', 'app', 'android'], app: '1.1.65', android: '1.1.77',
    items: [
      '✎ Photographer desk photo editor: optionally adjust brightness, contrast, warmth, and colour saturation (or pick 1-click presets like Brighten, Warm, Cool, Vivid, Matte, and Black & white) with live preview and Hold to compare before printing.',
      '📲 Edited QR delivery: when you apply an edit, both the print (framed or Print original) and the guest’s QR download use the edited photo while keeping the original file untouched in the Roving inbox.',
      '⏱️ Separate 1st & succeeding photo countdowns: configure independent 2–60 s countdown timers for the first shot and follow-up shots with quick preset chips or exact values.',
      '📷 Smoother iPad camera & feature guide: upgraded built-in iPad camera support for smoother sessions, plus a new Full app & feature guide at /features/.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.64 + Android 1.1.76: Branded welcome cards, aesthetics, and 1-click color palettes', for: ['website', 'app', 'android'], app: '1.1.64', android: '1.1.76',
    items: [
      '🎀 Branded welcome card aesthetics: choose from 6 designer decoration styles including Luxe Corner Waves, Aura & Sparkles, Coquette Stitched, Pop Retro 3D, and Scrapbook Doodles.',
      '🎨 1-Click color palette harmonies: curated color combinations (Charm Blush & Navy, Sweet Berry, Matcha & Cream, Midnight Gold, Lilac Dream, Peach Sunset, and Studio Monochrome) coordinating card background, typography, button, and decorative accents.',
      '✨ Decoupled standalone cards: welcome cards can now be centered symmetrically without a side photo strip sample for a luxury billboard look.',
      '💼 Admin pre-customization: pre-set client brand names, logos, card styles, decorations, and color palettes right from the Admin dashboard before deployment.',
      '🖨️ Mac printer driver settings: inspect Mac printer driver options directly for color matching and print quality.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.63: cleaner, more seamless green screen, and GoPro cameras', for: ['website', 'app'], app: '1.1.63',
    items: [
      'Green screen is cleaner. White shirts, black hair and skin used to be slightly see-through, so the new background ghosted through them; they are now solid. A shadow or fold in the cloth, or a bright wrinkle, no longer shows through either.',
      'Edges are softer and have no green rim: the cloth’s green is pulled off the guest hardest at the edge, the edge is feathered about a pixel, thin flyaway hairs are kept, and a little of the new background glows onto the edge so the guest sits in the scene.',
      'The live view is steadier (no shimmer along the edge, and a moving guest leaves no trail). On a slower laptop the live picture is worked on at a smaller size so it stays smooth; the photos themselves are always full quality.',
      'For the best result: stretch the cloth wrinkle-free, light it separately and evenly, and keep guests about a metre (3 ft) in front of it so green light doesn’t bounce onto their skin.',
      'GoPro cameras can be used as the booth camera (Open GoPro). This has not been tried on a real GoPro yet, so test it before an event.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.62: Record 360 removed, 360 phone page is the way to record', for: ['website', 'app'], app: '1.1.62',
    items: [
      'The Record 360 screen is gone from the laptop app (Extras menu). A cable from a camera on a turning arm winds up, so the phone on the arm records with its own camera and sends the video from the 360 desk QR page. Nothing to install on the phone.',
      'The 360 phone page shows how long to record, lets you pick a look, music, speed, a name or a GIF, shows each video as it is edited with its guest QR, and can start the spin timer on the laptop.',
      'The 360 guide, How to 360 page and other docs now describe the phone page instead of Record 360.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.61 + Android 1.1.75: Fix button clipping at large scale, eliminate webcam lag, and top-level uploaded frames', for: ['website', 'app', 'android'], app: '1.1.61', android: '1.1.75',
    items: [
      'Fixed Cancel, Look, Mirror, and filter swatches getting cut off when scaling up display/button sizes on the Get Ready screen.',
      'Fixed built-in laptop & external webcam hanging/lagging: streamlined filter previews and defaulted built-in laptop cameras to a smooth 720p live view.',
      'Guest Design Picker now shows Uploaded Frames (Frame 1, Frame 2...) right alongside Design 1 / Design 2 as standalone choices — tapping a frame goes straight to capture, while tapping a Ready Design opens its ticked standard layouts.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.60: more Bluetooth pocket printers, and the 360 send page with more controls', for: ['website', 'app'], app: '1.1.60',
    items: [
      'Bluetooth pocket printers: added LIOTOG C19 / FunPrint (cat printer) and WalkPrint / Luck Jingle printers. The Bluetooth picker now asks you to select the printer to connect.',
      '360: the page a phone opens from the 360 desk QR shows how long to record and offers a look, music, speed, a name on the video and a GIF. It shows each video as it is sent, edited and ready with the guest QR, and can re-edit, share, print or delete it. Nothing to install on the phone.',
      '360 desk: new Phone send page & spin timer card (spin time, when the arm starts, cut each new video to the spin) with a full-screen 3-2-1 timer and stop beep.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.59 + Android 1.1.74: Keep reset webcam defaults across Photo Session start & camera wake', for: ['website', 'app', 'android'], app: '1.1.59', android: '1.1.74',
    items: [
      'Fixed clicking Reset webcam controls reverting back to 1 Brightness and 1 Contrast when entering Photo Session or waking the camera stream.',
      'Clean reset defaults now stay saved across camera restarts and automatically fix webcams that opened with skewed default sliders.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.58 + Android 1.1.73: Consolidated QR hub, hover guides, multi-design Ready designs, and clean Photo Session', for: ['website', 'app', 'android'], app: '1.1.58', android: '1.1.73',
    items: [
      'QR & after-session consolidated into one hub (Step 7 tab 4): Side-by-side + QR, LumaShare Pop-up + QR, LumaShare Pop-up No QR, Side panel No QR, and Sharing Station, along with synced Print first, gallery privacy, and Solo photos controls.',
      'Mouse hover & focus (?) help guides added across Setup and Printer Settings so secondary explanations stay out of the way until hovered or tapped.',
      'Ready Designs multi-design lineup (Design 1, Design 2...) with per-design colours/fonts/branding plus a one-click Tick all layouts button so guests can pick a design first and then pick any ticked layout in that style.',
      'Cleaner Photo Session screen: Camera, Printer, Backup, All photos, Wi-Fi, Resize UI, and add-ons live inside one compact Tools menu beside Lock, and filters/mirror fold into a single Look toggle.'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.57 + Android 1.1.72: revamped Extras & Welcome setup, full-screen Guest view default, webcam reset fix & Printer 1/2/3 cards', for: ['website', 'app', 'android'], app: '1.1.57', android: '1.1.72',
    items: [
      'Setup step 5 (Extras) revamped into 3 clear cards (Output mode, Decor & Stickers / Filters / Green screen, and Video guestbook) with visual filter swatches and clean switches.',
      'Step 7 Welcome preview now syncs Stretch / Fit / Crop right away without black bars or lag, and the external Guest screen now defaults to clean full-screen Photo Session mode from start to finish.',
      'Webcam Controls: Reset webcam controls now restores the camera\'s true opening defaults instead of snapping Brightness and Contrast to 1 and 1.',
      'Printer setup redesigned into collapsible Printer 1 -> + Add Printer 2 / 3... cards with per-printer quality, media, driver paper slot, edges, colour correction, Copy settings from Printer 1, round-robin sharing across all Share printers, and parallel Extra-size printing.',
      'Desktop app: "Let an iPad use this laptop\'s camera" is now off by default (Admin opt-in per code).'
    ]
  },
  {
    date: '2026-11-17', title: 'Desktop 1.1.56 + Android 1.1.71: cleaner guest screen between guests and a simpler Setup step 7', for: ['website', 'app', 'android'], app: '1.1.56', android: '1.1.71',
    items: [
      'Guest screen between guests: new "Picture only" option (the default) fills the whole second screen with your welcome picture, with no logo, "Welcome!", event name or Ready tag around it. Choose "With logo & welcome text" in Setup to keep the earlier look.',
      'Setup step 7 is split into numbered tabs in guest order: Welcome screen, Pay & photos, Sound & start, QR & sharing, and Screen & lock, with a Next button at the end of each tab instead of one long page.',
      'Fixed the Welcome screen block in Setup swallowing the Guest screen and Lock booth blocks.'
    ]
  },
  {
    date: '2026-11-16', title: 'Desktop 1.1.55 + Android 1.1.70: XL strips (4x12, 8x24, 8x32), Epson/generic driver media & paper slots, per-layout paper switching & Instax Link Wide upgrades', for: ['website', 'app', 'android'], app: '1.1.55', android: '1.1.70',
    items: [
      'XL strips up to 48 inches (1220 mm): added the XL Strip 4 (1:4 tall) layout, 1-tap XL presets (4x12, 8x24, 8x32 in), an optional faster-print mode for large sheets, and fixed 4x12 strips falsely matching 8x12 sheets.',
      'Generic Windows & Mac printer options (including Epson L8050 and L3210): pick Paper / media type (Glossy, Matte, Plain), bind an exact Driver paper slot / User-Defined preset per size, toggle 1 strip per sheet (no 2-up pairing), and see driver custom-size warnings.',
      'Per-layout paper size mapping in Setup lets switching layouts (or using the guest layout picker) automatically switch paper size and its assigned printer.',
      'Instax Link Wide improvements: automatic multi-printer Bluetooth reconnect, live film & battery readout, transfer % progress, cover-open check before printing, Chrome/Edge Bluetooth printing without Print Helper, and smoother Android tablet printing.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.54 + Android 1.1.69: smarter USB webcam connection, low-light stacking, photo clean-up and webcam controls', for: ['website', 'app', 'android'], app: '1.1.54', android: '1.1.69',
    items: [
      'Plugging in a USB webcam or HDMI capture card now moves it ahead of built-in laptop/tablet cameras and switches automatically when not shooting. On Android tablets, external USB webcams also take priority even if the tablet camera was saved before.',
      'Webcam captures now run photo clean-up (noise reduction, edge-safe sharpening, highlight protection and skin-tone balance) and optional low-light multi-frame stacking (Off, Auto in dim light or Always).',
      'Setup now includes a Pro controls panel for USB webcams (brightness, contrast, saturation, autofocus/manual focus and auto/manual exposure where supported) plus a live preview speed warning when dim lighting slows the camera feed.',
      'Windows laptop app: closing a busy camera now also closes the Windows Camera app and Logitech Capture if they are holding the webcam.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.53: Canon DSLRs (6D, 70D, 5D...) on Windows take the photo instead of "The camera didn\'t take a photo"', for: ['website', 'app'], app: '1.1.53',
    items: [
      'On Windows, a Canon DSLR such as the EOS 6D is now shot the way Canon\'s own remote tools do it (half press, let it focus, full press, release). Before, one combined press could return "OK" without the camera taking a photo.',
      'If a Canon still does not take the photo, the app now tries again by itself: first with live view off (the camera focuses with its viewfinder sensor), then without waiting for autofocus, instead of failing after one try. The shutter is always released afterwards so the next photo is not refused.',
      'Older Canon (60D...) that answer "mirror still up" now end live view and shoot again; a write-protected SD card is named as such. Newer Canon models that hand the photo over from camera memory are recognised too.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.52: Insta360 Ace Pro and USB webcams open cleanly on Windows without "camera is busy" errors', for: ['website', 'app'], app: '1.1.52',
    items: [
      'On Windows, the laptop app now uses a smoother webcam driver mode so Insta360 Ace Pro and other USB webcams no longer get stuck saying "The camera is busy in another app".',
      'Insta360 Ace Pro is now recognised automatically as a USB webcam, closes conflicting Insta360 background apps if they are holding the camera, and gives it extra time to wake up.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.51: Mac prints on an Epson L8050 balanced per-side (no white line, footer details and unicorn feet kept)', for: ['website', 'app'], app: '1.1.51',
    items: [
      'On a Mac, an Epson L8050 printing 4x6 borderless now uses measured per-side scaling and offset instead of a uniform shrink. This leaves about 0.5 mm of picture past every edge, keeping bottom details (like unicorn feet and hearts) intact without showing white lines.',
      'If you adjusted Edges for this printer previously, keep or reset them to 0 (Print settings > Edges > Reset to 0) after updating. Fine-tune with Edges only if an individual printer feed varies.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.50: the start screen shows the name you set in My Events', for: ['website', 'app'], app: '1.1.50',
    items: [
      'If you changed your name in My Events, the start screen still showed the old one (the name of your photo folder). It now shows the name from My Events. Your photo folder keeps its name, so photos stay in the same place.',
      'A name typed for the print in Setup is still shown first. The laptop app picks up a new name the next time it is opened with internet.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.49: Mac prints on an Epson L8050 now reach the paper edge (no thin white line)', for: ['website', 'app'], app: '1.1.49',
    items: [
      'On a Mac, 1.1.48 stopped an Epson L8050 from cutting the layout off, but an edge test on an L8050 showed the page then stopped a little short of the paper: about 0.6 to 0.8 mm of white on the top, bottom and left. Epson printers on a Mac are now sent the page at 96.5% (it was 94%), so the picture runs slightly past those edges. Canon G-series printers and Windows are unchanged.',
      'If you set Edges for this printer while on 1.1.48, set them back to 0 after updating (Print settings > Edges > Reset to 0), then print one photo to check. Use Edges only if a side still shows white (press −) or is trimmed (press +).'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.48: Mac prints on an Epson L8050 (and other Epson L-series) are no longer cut off at the top and right', for: ['website', 'app'], app: '1.1.48',
    items: [
      'On a Mac, an Epson L8050 (and similar Epson printers) printing borderless enlarged the page past the paper and trimmed the top strip, the footer and the right-hand photos. Epson printers now get their own, smaller page size on a Mac (94%), whether the printer was added over AirPrint or with Epson’s driver. Canon G-series printers keep their 98% setting, and Windows is unchanged.',
      'It was worked out from photos, not measured on an L8050 here. Print the edge test once on a fresh sheet and use Print settings > Edges for any side that is still trimmed (press +) or shows a thin white line (press −).'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.47: Nikon photo tips are optional, and a Classic Nikon behaviour switch', for: ['website', 'app'], app: '1.1.47',
    items: [
      'The Nikon photo improvements from 1.1.46 (sharper shrink, clean-up, JPEG Fine, autofocus wait) work quietly in the background. The warnings, the test shot’s 100% focus crop and the between-photo preparation are now off until you tick “Show Nikon photo tips” under Setup > Camera > Nikon photo options (shown only while a Nikon is connected).',
      'New “Classic Nikon behaviour” switch in the same place: it turns all the Nikon photo improvements off, including the autofocus timing, and the Nikon works as it did before 1.1.46. Use it if shots feel slower or different. It applies from the next photo.'
    ]
  },
  {
    date: '2026-11-15', title: 'Desktop 1.1.46: sharper, less grainy Nikon photos; a Nikon keeps its mirror down on the start screen', for: ['website', 'app'], app: '1.1.46',
    items: [
      'Nikon cameras (not yet tried on a real D5300): each photo is now shrunk into its frame in steps instead of one jump, then lightly cleaned of grain and sharpened at the size it is printed, and the printed page gets a last light sharpen. Under Setup > Camera, “Nikon photo clean-up” can be set to Off, Auto (default) or Strong. If a computer is too slow for it, it switches itself off.',
      'A Nikon is now set to JPEG Fine (before, only RAW was changed, so Basic or Normal stayed blocky at a high ISO).',
      'Nikon autofocus waits until the camera has finished focusing (up to about 2 s) and tries once more after a miss, instead of waiting a fixed 1.2 s. A lens switched to MF is left alone. A photo taken without a focus lock, a high ISO or a slow shutter shows a note in the Camera menu, and the test shot shows ISO, shutter and a 100% crop to judge focus.',
      'A Nikon no longer raises its mirror when a guest touches the start or welcome screen (Touch to Start); it wakes when the guest presses Start. Canon, Sony and webcams are unchanged.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.68: Epson L805 prints borderless edge to edge over Wi-Fi; the Lock button asks first', for: ['android'], android: '1.1.68',
    items: [
      'A Wi-Fi Epson L805 (and similar) now prints borderless to the edge of the paper. Tried on an L805 with four variants of the job: the two commands Epson’s driver expects before the job were what was missing, so the printer had been ignoring the start position and printing the picture about 3 mm inside the sheet. Borderless is sent as Premium Glossy photo paper, so load glossy photo paper; it covers 3.5x5 in (3R), 4x6 in, 5x7 in, 8x10 in, 100x148 mm, 16:9 wide, A4 and Letter. The 1.1.67 test picker is gone. Print the edge test once on the paper in use and use Edges for any side that is still a fraction of a millimetre off.',
      'The Lock button on the dock now asks “Lock the booth?” first, so a stray tap during a session does not lock it.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.67: borderless test methods for the Wi-Fi Epson L805', for: ['android'], android: '1.1.67',
    items: [
      'The Wi-Fi Epson L805 still printed borderless with the picture about 3 mm inside the sheet. Epson’s own Windows driver sends the printer a different job for borderless, with a full-bleed marker this app did not send. With the Admin debug option on, Print settings now has a Borderless test method (0 to 4) under Print edge test that adds those commands in different ways; the Printer report shows the method used. Normal use is unchanged (method 0). Once one works it will be built in.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.66: Epson L805 borderless is sent as Premium Glossy photo paper', for: ['android'], android: '1.1.66',
    items: [
      'A Wi-Fi Epson L805 (and similar) still started the picture about 3 mm inside the sheet in 1.1.65. The cause: the job named a paper type this printer does not have, and it does not print borderless on plain paper, so it stayed in its bordered mode. Borderless is now sent with the printer’s Premium Glossy photo paper setting, so load glossy photo paper. It could not be tried on a printer here: print the edge test once on the paper in use.',
      'Borderless on these printers now covers every size the L805’s Epson driver lists for it: 3.5x5 in (3R), 4x6 in, 5x7 in, 8x10 in, 100x148 mm, 16:9 wide, A4 and Letter. Other sizes print with the normal border.'
    ]
  },
  {
    date: '2026-11-14', title: 'Desktop 1.1.45: Canon SELPHY on Wi-Fi asked for the borderless page first, one photo per job on a SELPHY', for: ['website', 'app'], app: '1.1.45',
    items: [
      'On a Canon SELPHY (CP1500 and the other CP models) that prints through the computer’s printer driver, several photos are now sent as one print job each, one after the other. A CP1500 can stop halfway, print only yellow or freeze the print service when it gets several photos in one job.',
      'A Canon SELPHY lists each paper twice, with a border and without. The app now asks for the page with zero margins first (that is the borderless one), and only then for the paper by its name, which gets the bordered one. This is an attempt at the white border some SELPHY prints had; it could not be tried on a printer here.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.65: Epson L805 borderless now sent the way Epson’s own driver sends it', for: ['android'], android: '1.1.65',
    items: [
      'A Wi-Fi Epson ink-tank photo printer (L805 and similar) printing borderless now gets the same job layout Epson’s own driver uses: the page starts a little before the sheet edge and runs a little past every edge, and the picture fills the sheet exactly, so nothing is cut off. Android 1.1.64 started the picture about 3 mm inside the sheet (white top and left, trimmed bottom and right). Borderless is sent on 3.5x5 in (3R), 4x6 in, 5x7 in and A4, the sizes the L805’s Epson driver lists as borderless; other sizes print with the normal border. It could not be tried on a printer here: print the edge test once on the paper in use, and use Edges only if a side still shows white or is trimmed.',
      'The printer report for a Wi-Fi Epson without a paper list now says so and shows how the last photo was sent (borderless or border, paper size).'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.64: Epson L805 prints borderless over Wi-Fi, tidier Edges settings', for: ['android'], android: '1.1.64',
    items: [
      'A Wi-Fi Epson ink-tank photo printer (L805, L850 and similar, L2xx and up) now prints borderless on photo paper when Borderless is ticked in Print settings, on 3.5x5 (3R), 4x6, 5x7, 8x10, A4, 16:9 and 100x148 mm paper. Before, the Borderless tick was ignored for these printers and every print had a 3 mm white border. On any other paper size the print keeps its border. It could not be tried on an L805 here: print the edge test once and use Edges if a side is trimmed or a white line shows.',
      'Print settings: the Edges rows (Top, Bottom, Left, Right) no longer run into each other, and the hint now says the edge test is printed without your Edges and that Edges cannot remove a border the printer keeps by itself.'
    ]
  },
  {
    date: '2026-11-14', title: 'Desktop 1.1.44 + Android 1.1.63: Canon SELPHY borderless attempt and a printer report', for: ['website', 'app', 'android'], app: '1.1.44', android: '1.1.63',
    items: [
      'A Canon SELPHY on Wi-Fi: if the printer lists a borderless version of the loaded paper, the app now uses it when Borderless is on, and the photo carries its 300 dpi size so a printer that prints it at its own size no longer shrinks it. This is an attempt at the white border some SELPHY prints had; it could not be tried on a printer here.',
      'Print settings (Android app) has a new Printer report button for a Wi-Fi printer. It shows the paper sizes the printer lists and how it last accepted a photo, and copies them, so support can see why a printer adds a border.',
      'The video guestbook saves the video mirrored, like the preview, and has a switch for it under Setup > Extras.'
    ]
  },
  {
    date: '2026-11-14', title: 'Desktop 1.1.43 + Android 1.1.62: choose the video guestbook quality, sharper video, a more reliable Flip camera', for: ['website', 'app', 'android'], app: '1.1.43', android: '1.1.62',
    items: [
      'New "Video quality" choice in Setup > Extras > Video guestbook: Auto, Smooth (480p, the lightest), Standard (720p) or High (1080p). If messages stutter on a phone or tablet, choose Smooth. It is saved on that device only, so a strong laptop on the same code can stay on High.',
      'Sharper video on Auto: looks start at a bigger picture, the video rate is higher, and a strong laptop or tablet keeps up to 1080p. A look still steps down by itself, or switches off, on a device that cannot keep up.',
      'Flip camera is more reliable: it tries the phone’s camera list first, then asks for the back or front camera by name, and says so clearly if the phone will not switch. The back camera is no longer shown mirrored.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.61: Canon SELPHY Wi-Fi prints fill the whole postcard', for: ['android'], android: '1.1.61',
    items: [
      'On a Canon SELPHY over Wi-Fi the app now asks the printer to scale the page to the whole postcard first, so the photo no longer comes out smaller than the paper with a white border all round. If the printer refuses, the app falls back to the way it asked before.'
    ]
  },
  {
    date: '2026-11-14', title: 'Desktop 1.1.42 + Android 1.1.60: smoother video guestbook on ordinary phones and tablets', for: ['website', 'app', 'android'], app: '1.1.42', android: '1.1.60',
    items: [
      'Video guestbook messages are recorded at 720p and 30 frames a second at most, with a lower video rate on ordinary Android phones and tablets, so recording no longer stutters. The booth’s own camera setting is put back when the guestbook closes.',
      'Looks draw on a smaller picture and only when the camera sends a new frame. On a device that cannot keep up, the picture shrinks further, and if that is still not enough the look switches itself off so the message stays smooth.',
      'While the guestbook is open the booth pauses its live green-screen picture and its wave / smile detection, so nothing else slows the recording (and a wave can no longer start a photo session by accident).'
    ]
  },
  {
    date: '2026-11-14', title: 'Desktop 1.1.41 + Android 1.1.59: video guestbook looks (beauty and more), flip camera, steadier camera and microphone', for: ['website', 'app', 'android'], app: '1.1.41', android: '1.1.59',
    items: [
      'Video guestbook looks: guests tap a small "Look" button and pick Beauty (soft skin), Dreamy glow, Golden hour, Pastel, Rosé, Fresh mint, Cinema, Neon night, Camcorder, Noir, Film, B&W, Warm or Cool. The look is part of the saved video. In Setup > Video guestbook, choose the starting look (or "Same as the photos"), or untick "Let guests choose a look" to hide the button.',
      'A Flip camera button on the guestbook screen switches between the front and back camera of a phone or tablet. The booth goes back to its own camera when the guestbook closes.',
      'The guestbook checks that the camera is really live before recording and opens it again if another app or a permission box took it, and the microphone no longer holds the screen if its permission box is not answered.',
      'Mac: the app now asks for microphone permission, so guestbook messages have sound. Windows and Android already did (Android since 1.1.58).'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.58: video guestbook records the full length, with sound', for: ['android'], android: '1.1.58',
    items: [
      'Video guestbook messages are no longer cut short (a 30-second message could stop at about 10 seconds), and the camera picture no longer goes black while a guest is recording. The booth now keeps the camera on for as long as the guestbook screen is open, and the screen saver no longer dims the screen during a message.',
      'The Android app now asks for microphone permission, so video guestbook messages have sound. Tap Allow when the tablet asks after the update.',
      'If a recording ever does stop by itself, the guest sees "Stopped early" and can retake it.'
    ]
  },
  {
    date: '2026-11-14', title: 'Android 1.1.57: Epson L805 photos over Wi-Fi and a printer checklist that ticks', for: ['android'], android: '1.1.57',
    items: [
      'A Wi-Fi Epson ink-tank photo printer without AirPrint (L805, L800, L810, L850 and similar) is now listed as a photo printer, not a receipt printer, and prints photos over Wi-Fi the same way it does over a USB cable. If you had already picked it, open Print settings once so the app updates it.',
      'The printer setup checklist in Print settings now works on the Android app: it ticks when a printer is found, when one is chosen for the paper size, and after a print or test print works. It no longer mentions AirPrint or the iPad on a tablet.'
    ]
  },
  {
    date: '2026-11-13', title: 'Android 1.1.56: easier-to-tap tick boxes and clearer setup wording', for: ['android'], android: '1.1.56',
    items: [
      'Every tick box row in Setup is now at least 40 px tall with the same box size, so switches are easier to hit on a tablet. Nothing moved and every option is where it was.',
      'When "No QR code for guests" is on, "Show the QR code in a pop-up" now says why it is greyed out, and a note says guests still get their QR code on a Sharing Station if you use one.',
      'Plainer wording for a few options (faster video export, smoother slow motion, resize on the guest screen, display & monitor size), consistent spelling, and names for the colour dots so screen readers can read them.'
    ]
  },
  {
    date: '2026-11-13', title: 'Android 1.1.55: 80mm USB receipt printers (Xprinter XP-T80Q etc.) print in one go again', for: ['android'], android: '1.1.55',
    items: [
      'Since Android 1.1.40, prints to USB receipt printers were sent in tiny slow pieces to protect small 58mm printers. A fast 80mm printer (for example the Xprinter XP-T80Q at 200 mm/s) ran out of data, stopped and restarted while printing, and each stop left a line across the strip.',
      '80mm USB receipt printers and USB photo printers are now sent the picture at full speed again. The slow, careful sending stays for 58mm printers only.'
    ]
  },
  {
    date: '2026-11-12', title: 'Desktop 1.1.32: Epson photo prints now fill the 4R sheet edge to edge', for: ['website', 'app'], app: '1.1.32',
    items: [
      'Fixed Epson printers (L8050, L3210 and similar) on Windows printing 4R with white edges and the picture smaller than the paper. The app now switches on the Borderless mode of the printer driver for the booth paper size by itself, so you no longer have to tick it in the printer preferences. Printers without a Borderless option print as before.'
    ]
  },
  {
    date: '2026-11-12', title: 'Desktop 1.1.31 + Android 1.1.49: a Guestbook tab in the offline galleries', for: ['website', 'app', 'android'], app: '1.1.31', android: '1.1.49',
    items: [
      'The laptop and tablet photo pages now have their own Guestbook tab, with a Download all guestbook videos button that saves a few messages per zip so older phones keep up. Guestbook messages no longer show under 360 Videos or on the 360 live wall.',
      'Fixed the tablet guest photo page not loading its tabs.',
      'The online gallery zips guestbook videos three at a time, so it is lighter on older phones.'
    ]
  },
  {
    date: '2026-11-12', title: 'Desktop 1.1.30 + Android 1.1.48: more designs, a smarter 360 desk and video guestbook questions', for: ['website', 'app', 'android'], app: '1.1.30', android: '1.1.48',
    items: [
      '360 desk: a new Auto mode switch edits every new video by itself and gets its QR code ready. Use the same look, a different look each time, or let the guest choose on the booth screen or on their phone. There is no text on the video unless you want it.',
      '360 desk: 12 more looks (30 in all) with real previews, a song and opening or ending clip for each look, GIF and square clips, and a 540p Light size for busy Wi-Fi.',
      '360 desk: a Connect panel checks the editor, the inbox folder and the network, shows when the last video arrived, and warns if a recording started but no video came. The phone send page can be saved to the home screen, and Record 360 can start when a guest steps in.',
      'Video guestbook: up to 5 questions, messages of 15, 30 or 60 seconds, and a Guestbook tab in the online gallery with Download all.',
      'The Design picker has 23 new ready-made designs: Baby Shower, Summer, Anniversary and Prom, plus new Kids Party, Corporate, Debut, Christmas, New Year, Graduation and Wedding looks.',
      'There are 4 new categories (Baby Shower, Summer, Anniversary, Prom) and 4 new backdrops (sunset, neon, polka dots, gingham). They are drawn by the app, so the app does not get bigger.',
      'The design list loads faster: pictures are drawn only when you scroll to them.'
    ]
  },
  {
    date: '2026-11-12', title: 'Android 1.1.47: 58mm Bluetooth printers no longer print choppy after the first part', for: ['android'], android: '1.1.47',
    items: [
      'Small 58mm Bluetooth printers printed the first part of a dark strip correctly and then only short broken pieces. Dark areas print slower than light ones, and the printer cannot tell the tablet to wait, so its small buffer overflowed and data was lost.',
      'The strip is now sent band by band, and after each dark band the tablet waits for the printer to catch up. Light pictures print as fast as before; a dark strip takes a few seconds longer. 80mm printers are not changed.',
      'If a 58mm printer still breaks up, set Speed to Slow and safe in the Bluetooth printer settings.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.29 + Android 1.1.46: camera live view really switches off when idle', for: ['website', 'app', 'android'], app: '1.1.29', android: '1.1.46',
    items: [
      'Nikon: the camera is now asked again until it accepts live view off. Right after the last photo it answered busy, and live view stayed on through the result and Touch to Start screens. The booth also asks again for the first minute after the camera is put to sleep.',
      'On the Get ready screen the camera turns off 2 seconds after the last touch if the guest has not pressed Start. A touch wakes it, and pressing Start brings the picture back before the countdown begins.',
      'The camera now switches live view off 2 seconds after it is no longer needed (it was 2.5 seconds). Touching the Touch to Start or welcome screen wakes a resting camera early, so it is ready when the guest presses Start.',
      'Wave or smile to start still keeps the camera on, because it needs the picture. Turn the battery saver off in Setup > Camera if you prefer the camera always on.'
    ]
  },
  {
    date: '2026-11-11', title: 'Android 1.1.45: camera rests when not in use', for: ['android'], android: '1.1.45',
    items: [
      'The tablet no longer keeps the camera running on the Touch to Start screen. A built-in or USB webcam stops completely, and a Nikon or Canon switches its live view off, so the battery lasts longer. Turn it off in Setup > Camera.',
      'The camera wakes as soon as a guest touches the start or welcome screen, so it is ready when they press Start.',
      'Setup: the camera only runs on the Camera & Printer step, and pauses after 2 minutes without a touch.',
      'Sony cameras cannot switch live view off over USB, so after 10 idle minutes the tablet lets go of the camera so it can rest, and reconnects when a guest touches the screen (a few seconds). Turn this off in Setup > Camera if your Sony switches itself off.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.28: camera rests when not in use, guest Wi-Fi page, 360 presets', for: ['app'], app: '1.1.28',
    items: [
      'Camera battery saver: a webcam stops completely (its light goes off) and a Nikon or Canon switches its live view off. This happens on the Touch to Start screen, on the result and QR screens, and in Setup outside the Camera & Printer step. The camera wakes in about a second when a guest taps Start. Turn it off in Setup > Camera.',
      'Setup: the camera only runs on the Camera & Printer step, and pauses after 2 minutes without a touch.',
      'Sony cameras can not switch live view off over USB, so after 10 idle minutes the booth now lets go of the camera so it can rest, and reconnects when a guest touches the screen (a few seconds). Turn this off in Setup > Camera if your Sony switches itself off.',
      'New guest Wi-Fi page (/wifi or /join on the booth address) with a QR code to join the booth Wi-Fi, and an operator guide (/guide).',
      '360 desk: a gallery of ready-made looks, one-tap auto-edit and quick colour, motion, text and effect controls.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.27: safer booth Wi-Fi and graphics on older laptops', for: ['app'], app: '1.1.27',
    items: [
      'Booth Wi-Fi crash guard: if the laptop shuts down while starting its own booth Wi-Fi, the app stops starting it by itself. If that happens twice in a row, the switch is locked and the app asks you to use a pocket Wi-Fi router or a phone hotspot. It unlocks after the Wi-Fi driver is updated.',
      'Lighter on the laptop: the app no longer checks the booth Wi-Fi in the background every few seconds. It wakes the booth Wi-Fi when a guest starts a session, and the Wi-Fi checks on the settings page pause during sessions.',
      'Sleep: the booth Wi-Fi is turned off before the laptop sleeps and comes back after it wakes.',
      'A failed start (Wi-Fi switched off, or one-time set-up still needed) no longer blocks the switch: fix the cause and try again.',
      'The Join QR follows the booth Wi-Fi when it starts or stops, also during a session.',
      'Graphics: the app now respects the list of graphics drivers known to crash, so older laptops draw a little slower instead of crashing. After two graphics crashes in a week it starts in safe graphics for 30 days.',
      'One-time set-up also stops Windows 10 from switching the booth Wi-Fi off after 5 idle minutes.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.26 + Android 1.1.44: 58mm printer reliability & image quality improvements', for: ['website', 'app', 'android'], app: '1.1.26', android: '1.1.44',
    items: [
      '🔒 Print Lock for 58mm: disabled the Print button while a 58mm job is still physically printing — prevents double-tap garbled prints when tapped twice.',
      '🎨 Accurate brightness for USB prints: Bluetooth and USB receipt prints now read the same lightness/brightness slider value — USB previously ignored the slider setting.',
      '📡 Smoother Bluetooth Smooth mode on 58mm: sends Smooth-mode prints in smaller pieces so compact printers with tiny memory do not glitch or drop parts of the strip.',
      '⏱️ Scaled USB finish wait: waits longer for long custom strips to finish feeding out before closing the connection.',
      '🔑 Safer back-to-back USB printing: ensures two USB prints never overlap when multiple jobs wait in line.',
      '🖼️ Sharper 58mm text and borders: improved picture scaling for 58mm paper so borders and thin text print cleaner.',
      '🖨️ Smarter 58mm detection: automatically recognizes more 58mm portable printers (including MP-series models) even if "58" is not in the device name.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.25 + Android 1.1.43: Clean Wi-Fi UI, auto-linked hotspot, undistorted GIF scaling & solo white frame', for: ['website', 'app', 'android'], app: '1.1.25', android: '1.1.43',
    items: [
      '📶 Clean Wi-Fi UI: removed duplicate Wi-Fi name and password boxes when the laptop booth Wi-Fi is turned on.',
      '🔗 Auto-linked Hotspot Checkboxes: turning on "Make this laptop the booth Wi-Fi" now automatically turns on "Turn it on whenever the app opens", and keeps the dock Wi-Fi QR button accessible offline.',
      '🖼️ Clean Solo GIF White Border: when printing with multi-photo or strip frames, Solo (1 large photo) GIFs now use the clean default white border instead of stretching a strip frame.',
      '📐 Undistorted GIF Scaling: fixed stretched or squished GIFs in Multi-Box Boomerang and sequential GIFs across wide, portrait, and standard cameras.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.24 + Android 1.1.42: Deep DSLR battery saver, autofocus test shot & session QR', for: ['website', 'app', 'android'], app: '1.1.24', android: '1.1.42',
    items: [
      '🔋 Deep DSLR Battery Saver: Keeps the DSLR camera resting during the welcome screen, layout picker, payment, and review screens — greatly reducing battery drain and camera heat between guests.',
      '🎯 Quick Autofocus & Test Shot setup: Added Setup Step 4 tools ("Auto-Focus Lens" and "Take Test Shot") so you can focus once during setup and switch the lens to manual focus for instant shutter response all event.',
      '⏱️ Cooler Live View: Keeps camera live view running smoothly without overworking the camera processor.',
      '📋 Built-in Battery & Heat Tips: Added a quick DSLR battery and heat checklist inside Setup Step 4.',
      '🔒 "Only their own" privacy fix: guests scanning the sharing station QR can now view their own session photos (strip, solos, GIF all on one page) instead of being blocked.',
      '📲 Single session QR: when a session has multiple items (print strip + solo shots + GIF), the QR opens one page showing all of them together so guests only scan once.',
      '⏱️ Adjustable handoff pause: "Show photo Xs" now offers 2, 3, 5, 7, 10, and 15 seconds before switching back to the sharing screen.',
      '🔄 Auto-update fix: ensures tablets on older versions receive this update prompt reliably.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.23 + Android 1.1.40: Sharing Station QR fix, 58mm printer pacing & zero-waste paper feed', for: ['website', 'app', 'android'], app: '1.1.23', android: '1.1.40',
    items: [
      '📱 Sharing Station QR Fix: Fixed missing or broken QR codes on the Sharing Station offline and on Windows laptops.',
      '🚀 Steady 58mm USB printing: Slows data pacing slightly for compact 58mm portable receipt printers (like MP58C7 / POS-58) so strips never turn into garbled characters.',
      '🛡️ Multi-Copy protection: Adds a short pause between consecutive copies so back-to-back prints never collide.',
      '✂️ Zero-waste tear feed: Stops 58mm paper right at the tear bar (~8 mm feed) to avoid wasting blank receipt paper.',
      '🖨️ Automatic setup: All 58mm print fixes turn on by themselves whenever a 58mm printer is selected.'
    ]
  },
  {
    date: '2026-11-11', title: 'Desktop 1.1.22 + Android 1.1.39: Sharing Station — pure session mode, single-photo QR & multi-item pills', for: ['website', 'app', 'android'], app: '1.1.22', android: '1.1.39',
    items: [
      '🔒 Pure Session Mode: the Sharing Station no longer displays an event-wide photo grid by default. It stays on a clean, branded standby screen between sessions and automatically pops only the current session\'s photos.',
      '📲 Single-Photo QR Code: scanning the station QR with a phone camera now opens only that specific photo or strip directly in the high-res downloader, never the entire event gallery.',
      '✨ Multi-Item Session Selector: for sessions with composite strips, solo photos, or GIFs, interactive pills allow guests to switch between their session assets and scan direct QR codes for each one.',
      '⚡ Fresh Session Auto-Display: opening or refreshing the station page within 2 minutes of taking photos immediately shows that session instead of an empty screen.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.21 + Android 1.1.38: Live Layout Editor — sticker corner handles, dummy guest photos & top bar clearance', for: ['website', 'app', 'android'], app: '1.1.21', android: '1.1.38',
    items: [
      '🎯 Scoped Resize Handles: the 4 sticker corner handles and dashed outlines now strictly only show when actively inside "Resize Layout" mode, with zero handle leakage into live guest sessions.',
      '🖼️ Realistic Dummy Guest Photos: empty film track slots in the layout preview now render 4 colorful guest portraits with smiling cartoon avatars and "Photo 1"–"Photo 4" badges, providing an accurate, beautiful preview of side photo strips.',
      '📏 4th Photo Resizing & Viewport Clearance: each photo frame (including the 4th photo) has its own 4 corner handles and bottom breathing room, allowing operators to easily grab and resize the strip from any photo.',
      '📐 Top Bar Offset Clearance: countdown preview overlay is positioned below the header tabs so top corner handles are 100% visible, unobstructed, and clickable.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.20 + Android 1.1.37: Sharing Station — fix wrong event on separate phone', for: ['website', 'app', 'android'], app: '1.1.20', android: '1.1.37',
    items: [
      '🔧 Fixed: Scanning the Sharing Station QR on a separate phone no longer opens an old/previous event. The pairing QR now always uses the active event folder.',
      '🔄 "Seeing wrong event?" button: if the station phone is showing a different event\'s photos, a "⟳ Reload to resync" button appears on the standby screen after ~15 seconds so you can recover without re-scanning.',
      '📲 Offline (Desktop/Android): station pairing automatically resolves to the latest active event so an older QR scan will not lock you onto a past event.',
      '🌐 Online: the pairing QR now reads the live event name typed in the booth instead of an older saved value.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.19 + Android 1.1.36: Separate Sharing Station with live auto-pop, audio chime & fast booth hand-off', for: ['website', 'app', 'android'], app: '1.1.19', android: '1.1.36',
    items: [
      '📱 Separate Sharing Station: display your QR codes and photos on a separate phone or tablet stand, freeing the camera booth to start the next session immediately.',
      '⚡ 2-Second Fast Booth Handoff: skips the long 20–30s result wait on the main booth screen with an on-screen prompt directing guests to the sharing stand.',
      '✨ Live Auto-Pop on Phone: incoming photo strips automatically pop up full-screen on the phone with a large, high-contrast QR code for instant camera roll download.',
      '🔔 Melodic Audio Chime: plays a clean chime on the sharing stand whenever a session finishes — works 100% offline with no audio files needed.',
      '🔒 Privacy Mode: option to show only the current session (hides the past event gallery and auto-clears after 35s) for privacy-conscious weddings and corporate events.',
      '📴 Works 100% Offline & Online: supported over local booth Wi-Fi on Laptop & Android tablets, and via cloud sync on the web version.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.18 + Android 1.1.35: 58mm thermal printer — fix cut-off sides, blank paper feed, and bottom glitch', for: ['website', 'app', 'android'], app: '1.1.18', android: '1.1.35',
    items: [
      '🖨️ 58mm Right-Side Cutoff Fixed: receipt layouts and custom 2×6 strips now automatically select "Receipt 58mm" paper when a 58mm printer (e.g. MP58C7) is detected, preventing the right edge from getting clipped.',
      '🔁 Auto-Correction on Startup: if "Receipt 80mm" was saved from a previous session, the app now automatically switches to "Receipt 58mm" when a 58mm printer connects.',
      '📄 Blank Paper Feed Fixed: 58mm mobile printers have no auto-cutter — the app now stops cleanly instead of feeding endless blank paper after each print.',
      '🔧 Bottom Glitch / Repeating Strip Fixed: prints are now sent in smaller chunks to 58mm printers so compact printers with small memory never glitch at the bottom.',
      '✅ 80mm and all other thermal/photo printers are completely unaffected by these changes.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.17 + Android 1.1.34: Minimizable floating layout dock, bigger side photos & zero-lag budget tablets', for: ['website', 'app', 'android'], app: '1.1.17', android: '1.1.34',
    items: [
      '🚀 Zero-Lag Budget Tablets: Eliminated shutter capture delay on budget Android tablets by snapping directly from the live camera view.',
      '⚡ Smooth 720p Viewfinder & Countdown: Tuned tablet camera preview speed and animations so countdowns stay smooth without stutter.',
      '📐 Minimizable Floating Layout Dock: Replaced the bottom bar with a movable floating dock at top-right with one-tap minimize/expand so the Start button stays clear.',
      '📸 Bigger Side Photos: Raised side photo track scaling up to 250% with smooth scrolling so session previews look much bigger on widescreen and 11.5" monitors.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.16 + Android 1.1.33: Anti-glitch safeguard for camera capture & Surface tablets', for: ['website', 'app', 'android'], app: '1.1.16', android: '1.1.33',
    items: [
      '📸 Incomplete Photo Guard: Automatically spots incomplete camera photos from webcams and tablet cameras before saving.',
      '🛡️ Anti-Smear Protection: Prevents smeared lines at the bottom of photos (common on Surface tablets) by falling back cleanly to the clear live view frame.',
      '🔄 Automatic Retry: Retries photo capture automatically if the camera runs into a temporary buffer glitch.',
      '✨ Clean Collages: Keeps printed and saved photos sharp and glitch-free across all devices.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.15 + Android 1.1.32: Live on-screen layout & resize editor with instant preview', for: ['website', 'app', 'android'], app: '1.1.15', android: '1.1.32',
    items: [
      '📐 Live On-Screen Layout Editor: new Resize UI floating tool on the Photo Session dock lets you scale the countdown, buttons, and side photo strip directly on screen.',
      '👁️ Interactive Live Preview Overlays: temporarily shows a sample countdown, start button, and side photo strip right over your live camera view while editing.',
      '✓ One-Tap Done Editing: saves the sizes for that screen and returns straight to shooting mode.',
      '🖥️ Step 7 Live Jump: "Live Resize on Screen" button in Session setup switches directly to the camera screen and opens the editor.'
    ]
  },
  {
    date: '2026-11-10', title: 'Desktop 1.1.14 + Android 1.1.31: Monitor & display scaling, prominent guest countdown & side photos auto-fit', for: ['website', 'app', 'android'], app: '1.1.14', android: '1.1.31',
    items: [
      '🖥️ Display & Monitor Scaling: new Compact (11.5" Mini Monitor), Standard, and Large / TV presets in Step 7 (Session) with fine-tuning choices for buttons, countdown, and side photos.',
      '⏱️ Prominent Guest Countdown: larger countdown ring and numbers so guests can easily see them from a distance on compact 11.5" screens.',
      '📸 Adaptive Side Session Photos: automatically adjusts side thumbnail heights based on shot count (3 or 4) so every shot fits comfortably without squishing.',
      '🎯 Responsive Buttons & Touch Targets: keeps session and shutter buttons comfortable and easy to tap on any screen size.'
    ]
  },
  {
    date: '2026-11-09', title: 'Desktop 1.1.13 + Android 1.1.30: Dynamic GIF motion, session fast-forward & interactive popups', for: ['website', 'app', 'android'], app: '1.1.13', android: '1.1.30',
    items: [
      '⚡ Dynamic GIF motion & duration: removed fixed 2.2s clip limit. GIFs now capture natural countdown motion (up to 5.4s) and adjust playback speed cleanly.',
      'Full session fast-forward: Full Session mode automatically picks the right fast-forward speed (3x–10x) for smooth 4–5s recaps.',
      'Seamless Multi-Box & Story Replay: synchronized Multi-Box Boomerang and Story Replay loop smoothly with zero end-of-loop stutter.',
      'Interactive hover popups: hovering over animation styles and loop modes shows quick visual descriptions and recommendations.'
    ]
  },
  {
    date: '2026-11-09', title: '360 Video: 1 GB high-speed Wi-Fi upload & live progress', for: ['website', 'app'], app: '1.0.112',
    items: [
      '⚡ Fast local Wi-Fi uploads up to 1 GB: recording phones automatically spot your booth Wi-Fi or hotspot and transfer 360 clips straight to the booth in seconds.',
      'Live upload progress: shows live percentage and transferred MB counters while videos upload.',
      'Laptop app guide for 360 effects: clicking 360 Desk on the website explains how the Laptop app renders slow-motion and effects faster, with a one-click download link.',
      'Helpful size tips: suggests camera settings (1080p 30fps) for smaller clips when sending over regular web connections.'
    ]
  },
  {
    date: '2026-11-09', title: 'Android app 1.1.28: Offline in-app gallery preview & instant Back to booth', for: ['android'], android: '1.1.28',
    items: [
      '⚡ In-app gallery preview: tapping "Open gallery" on the tablet opens the event gallery right inside the app, avoiding router blocks and connection hangs.',
      'Offline gallery access: browse all photos saved on the tablet during the event even with no internet.',
      'Kiosk Back button: added "← Back to booth" in the gallery header to return straight to the camera without leaving kiosk mode.'
    ]
  },
  {
    date: '2026-11-09', title: 'Full resolution live viewfinder with downsize options & smoother preview', for: ['website', 'app', 'android'], app: '1.0.111',
    items: [
      '⚡ Crisp full-resolution live preview: camera live view now runs at full camera clarity (1080p+) by default on Android tablets and Laptop apps.',
      'Flexible live preview size controls: added an option in Setup → Camera to lower the live preview resolution (720p or 480p) on slower tablets while keeping saved photos at full quality.',
      'Smoother hardware rendering: smoother live camera display and faster countdown performance.',
      'Always-sharp photo captures: printed and saved photos always stay at the camera’s full resolution regardless of preview size.'
    ]
  },
  {
    date: '2026-11-09', title: 'Roving DSLR Bridge: Wired DSLR to Android phone streaming wirelessly to Laptop booth', for: ['website', 'app', 'android'], app: '1.0.110',
    items: [
      '📷 Roving DSLR Bridge on Android: connect any Canon, Nikon, or Sony DSLR via USB cable (OTG) to an Android phone in your pocket and stream photos wirelessly to your laptop booth in real time.',
      'Automatic Shutter Detection: automatically detects when the photographer presses the shutter button on the camera and transfers the photo in about half a second.',
      'Pocket Lock Mode & Vibration Alert: dims the phone screen to save battery and prevent accidental taps while keeping the connection live, vibrating when each photo is delivered.',
      'Photographer Desk Queue: incoming roving photos appear automatically in the Photographer Desk at the booth for reviewing, framing, and printing.',
      'No extra licence needed: the Android activation screen includes a direct "📷 Roving DSLR Bridge" button so any spare Android phone can send photos without using a device slot.'
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
    date: '2026-11-08', title: 'Android app 1.1.19: Auto-open on boot and Kiosk Home Launcher mode', for: ['android'], android: '1.1.19',
    items: [
      'The Android tablet app (v1.1.19) now includes an auto-start feature: when the tablet powers on or restarts, photobooth4u can open automatically.',
      'Long-press anywhere on the screen to open the new Operator Menu and toggle "Auto-Open on Boot: ON / OFF" with a single tap.',
      'For dedicated event booths, "Kiosk Home Launcher" can be enabled in the Operator Menu to set photobooth4u as the tablet\'s default Home app, launching straight into the booth and preventing guests from exiting with the Home button. To access tablet settings or Wi-Fi, tap Exit → Tablet Settings.',
      'Updated the PDF Tablet Guide (page 6 & 9) with step-by-step instructions for kiosk operation and auto-boot setup.'
    ]
  },
  {
    date: '2026-11-08', title: 'My frames: uploaded frames now stay after a restart, and you can keep up to 100', for: ['website', 'app', 'android'], app: '1.0.105', android: '1.1.18',
    items: [
      'Fixed: frames you uploaded could show up white (design missing) or not save after the app was restarted, especially offline. The pictures were kept in a small storage that fills up after a few big frames. They are now kept in the larger on-device storage, and pictures saved the old way are moved over the first time they load. Android app 1.1.18 has the same fix.',
      'My frames now holds up to 100 frames (it was 8). Big frame pictures are also downloaded a few at a time, so a new tablet can get them all back from your account.',
      'Frames that already lost their picture cannot be rebuilt by the update. If they were saved to your account, open the booth online once and they come back; otherwise upload them again.'
    ]
  },
  {
    date: '2026-11-08', title: 'Android tablet: your saved layouts, profiles and themes are back after the 1.1.16 update', for: ['android'], android: '1.1.17',
    items: [
      'Android app 1.1.16 fixed a bug that showed the word "null" on the start screen, but on tablets running offline with a normal rental code it also looked for the saved setup in a new place, so uploaded layouts, profiles and My themes seemed to be gone.',
      'Android app 1.1.17 copies them over from the old place the first time it opens, and keeps the old copies. If you already saved something since the update, that is kept and the uploaded layouts you had before are added back to it.',
      'Only tablets running offline with a normal (not Lifetime) rental code were affected. The website and the laptop app were not.'
    ]
  },
  {
    date: '2026-11-08', title: 'Saved profiles keep your vouchers, and offline no longer changes your payment mode', for: ['website', 'app', 'android'], app: '1.0.104', android: '1.1.16',
    items: [
      'A saved profile now includes the event’s voucher batches (which codes are unused, used or cancelled). Tap "Use everything" to bring them back; vouchers already used here stay used. "Design only" leaves vouchers alone.',
      'Profiles also remember your paper size, your own paper sizes, keychain printing and the photographer’s one-big-print setting. These load with "Use everything" too, and are included when you export or import profiles.',
      'Fixed: going offline (Android offline mode or the laptop app) used to switch QR payments off and save that. Your chosen payment mode is now kept; offline just skips QR for the moment.',
      'Fixed: a setup changed while offline is now sent to the server when the tablet is back online, instead of the older copy coming back on other devices. Android app 1.1.16 also gives the offline booth the same Lifetime options as online.',
      'Fixed: the start screen showed the word "null" under the button on the Android tablet when the code has no fixed folder name, and the top corner said "Ready · Traditional booth". It now shows just "Ready", and no "null".'
    ]
  },
  {
    date: '2026-11-08', title: 'Canon over USB: no more "Camera disconnected" between photos', for: ['website', 'app', 'android'], app: '1.0.103', android: '1.1.15',
    items: [
      'A Canon (for example the 60D) is still saving the photo when the next live view is asked for, and refuses it for a moment. The booth used to treat that as a lost camera and show "Camera disconnected. Reconnecting…" between shots even though the photo was saved. It now waits (up to 45 seconds), asks the camera for live view again every few seconds, and shows the last picture meanwhile.',
      'While a photo is being taken the booth no longer queues live view requests behind it, and a request that only timed out while the camera was busy saving no longer counts as a lost camera. A cable pulled or a camera switched off is still noticed at once.',
      'The camera log now records "live-back" with how long live view took to return after each photo. Same fix on the Android tablet (app 1.1.15).'
    ]
  },
  {
    date: '2026-11-07', title: 'Save power on the welcome screen: dim, then turn the display off', for: ['website', 'app', 'android'], app: '1.0.102', android: '1.1.13',
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
    date: '2026-11-08', title: 'Android tablet: USB webcams that only work uncompressed (YUYV)', for: ['android'], android: '1.1.14',
    items: [
      'The Android app (1.1.14) now tries the same size as uncompressed YUYV right after MJPEG, before it steps down to a much smaller size. Some webcams show no picture in MJPEG on a weak tablet port or hub but work in YUYV (for example 1280×720). Uncompressed video is limited by USB, so the frame rate is lower (often about 10 fps at 720p).',
      'New under USB webcam preview: "Max YUYV" starts from the biggest uncompressed size the webcam lists. The Exact size list now shows every MJPEG and YUYV size, including bigger YUYV sizes (for a Logitech Brio on a fast USB port).',
      'If a size is rejected or makes the webcam reset, the app now tries that size once more with the USB library\'s bandwidth fix, and remembers it for that webcam if it gives a picture.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: USB webcam that resets itself no longer stays black', for: ['android'], android: '1.1.12',
    items: [
      'The Android app (1.1.12) remembers webcam sizes that make the webcam reset itself (a weak tablet port or unpowered hub) and skips them next time. If the webcam drops out while starting, the app waits for it to come back and continues with the next size.',
      'Standard sizes (720p, 480p) are tried before odd ones, and the size that worked last time is tried first. For a webcam on a tablet, a powered USB hub is still the most reliable setup.',
      'New: under USB webcam preview you can pick one exact size from the list the webcam reports (for example 1280×960). The booth then uses only that size and shows an error instead of falling back. Max no longer skips sizes that reset the webcam before.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: USB webcam no longer stays black', for: ['android'], android: '1.1.11',
    items: [
      'The Android app (1.1.11) now tries only a short list of sensible webcam sizes, including a lower frame rate for weak tablet USB ports, so a webcam that cannot start at full speed falls back in about 30 seconds instead of staying black.',
      'If the webcam still sends no picture, the message now points to a powered USB-C hub, and "Copy camera log" lists every step the app tried so we can see why.'
    ]
  },
  {
    date: '2026-11-07', title: 'Android tablet: print straight to a DNP photo printer over USB (beta)', for: ['android'], android: '1.1.10',
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
    date: '2026-11-06', title: 'Android Tablet Updates Download Inside the App', for: ['android'], android: '1.0.106',
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
    date: '2026-11-06', title: 'Bigger Sticker Screen, Printers That Reconnect by Themselves, and Arrange & Print', for: ['app', 'website', 'android'], app: '1.0.93', android: '1.0.104',
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
    date: '2026-11-05', title: 'No 360 Buttons on Android, Epson Borderless Test Mode (Android)', for: ['android'], android: '1.0.97',
    items: [
      'The 360 desk and Record 360 buttons no longer show in the Android app (phones and tablets). They stay in the laptop app and on the website.',
      'For testing only (hidden unless Admin turns the debug option on): the Epson L-series built-in Epson mode has Normal 720 dpi and Best 1440 dpi test qualities for 4x6 glossy photo paper, now with borderless as well. It has not been tried on every printer, so the normal printing choices stay as they are.'
    ]
  },
  {
    date: '2026-11-05', title: 'Choose Your Own Booth Wi-Fi Name and Password', for: ['app', 'android'], app: '1.0.84',
    items: [
      'Windows laptop: the booth Wi-Fi (the laptop making its own network, no router needed) now has a name and password you choose in Setup. Press "Save name & password"; if the booth Wi-Fi is on, it restarts with the new ones. It still needs no internet.',
      'Android tablet (Android 10 and newer): you can set the booth Wi-Fi password and the end of its name (Android always starts it with DIRECT-pb-). If Android makes its own network instead, Setup tells you the name it used and the Join QR uses that one.',
      'Android tablet: a new "Use the phone\'s own Hotspot instead" button opens Android\'s Hotspot settings, where any name and password can be chosen; type the same ones in the Wi-Fi boxes so the Join QR matches. The app no longer shows a made-up name when the phone\'s own Hotspot is on.',
      'Mac: Setup now explains that the name and password are set in System Settings > Sharing, and no longer locks the Wi-Fi boxes to a name the Mac is not using.'
    ]
  },
  {
    date: '2026-11-05', title: 'Insta360 and USB Camera Help, Epson L-Series Printing (Android)', for: ['android'], android: '1.0.95',
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
    date: '2026-11-05', title: 'Print Queue, Separate Settings for Each Printer, Vouchers Linked to Printers and RP30 Thermal Printer (Android)', for: ['android'], android: '1.0.94',
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
    date: '2026-11-05', title: 'Colour for Prints Only, Thermal Quality, Calmer Print Settings and Lock PIN Fix (Android)', for: ['android'], android: '1.0.93',
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
    date: '2026-11-05', title: 'Separate Colour and Photo Layout for Each Printer (Android)', for: ['android'], android: '1.0.92',
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
    date: '2026-11-05', title: 'Animated 360 Effects Now Really Move, and No 360 Buttons on Phones (Android)', for: ['android'], android: '1.0.91',
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
    date: '2026-11-05', title: 'Safer 360 Studio Dialogs, Save-as-Preset & Re-pick Spinner (Android)', for: ['android'], android: '1.0.90',
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
    date: '2026-11-05', title: 'Sticker Packages, Decorate Timer & Resize / Rotate Handles (Android)', for: ['android'], android: '1.0.89',
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
    date: '2026-11-05', title: '360 Studio Polish: Share QR, Rendered Preview, Spin & Print Preview & Tablet Layout (Android)', for: ['android'], android: '1.0.88',
    items: [
      'Working Share + QR, rendered preview with Edit again, mute button, and the Spin & Print preview with re-pick and paper size.',
      'Stacked tablet layout with the live preview on top and finger-sized buttons for the Samsung tablet in portrait.'
    ]
  },
  {
    date: '2026-11-05', title: 'Seamless Side-by-Side 360 Studio Desk, Tab Alignment & Controls Lock Engine', for: ['app', 'website'], app: '1.0.76',
    items: [
      'Seamless Two-Column Studio Layout: Fixed layout spacing so editing options and live preview sit neatly side by side on all screen sizes without overlapping.',
      'Navigation Tab Alignment: Matched the top tab bar to the control sections in exact order (Queue -> Presets -> Look -> Text -> Audio) with smooth scrolling.',
      'Active Processing Lock: Editing controls dim and lock while a video is rendering, while keeping the Unlock/Edit banner ready.',
      'Easy Drag & Corner Resize: Smoother dragging and resizing on text boxes right inside the preview.'
    ]
  },
  {
    date: '2026-11-05', title: 'Seamless Side-by-Side 360 Studio Desk & Navigation Alignment (Android)', for: ['android'], android: '1.0.87',
    items: [
      'Two-Column Studio Layout: Restored side-by-side editing controls and sticky live preview for tablets.',
      'Tab & Section Synchronization: Seamless scrolling from header tabs directly to target control panels.',
      'Controls Lock Engine: Visual locking banner and dimming during background rendering.'
    ]
  },
  {
    date: '2026-11-05', title: 'Universal Bluetooth Remote, Beat-Drop Speed Ramping, Film Color Looks & Live TV Sync', for: ['app', 'website'], app: '1.0.75',
    items: [
      'Seamless Side-by-Side 360 Studio Layout: Two-column workspace keeps editing tabs and the live video preview side by side without overlap.',
      'Spin & Print: Pick crisp moments from 360 videos to print 3-shot photo strips, keychains, and 4R photos, with QR codes linking back to the clip.',
      'Universal Bluetooth Remote & Gamepad Shutter: Start sessions hands-free with wireless selfie remotes, presentation clickers, foot pedals, or pocket gamepads.',
      'Beat-Drop Sync Speed Ramping: Set a beat-drop moment where the video slows from 2× speed into smooth 0.25×/0.5× slow motion with a white flash and dynamic zoom.',
      'Cinematic Color Grading Looks: Professional color looks (Glamour B&W, Teal & Orange, Golden Hour, Vibrant Pop, Vintage Film) with live preview.',
      'Live TV Audience Sync: The TV display (/wall) shows synchronized crowd countdowns ("3... 2... 1... JUMP! 🎬") and replay banners ("✨ New 360 Spin Ready!") as new clips land.',
      'Smart Inbox Watcher: Waits for incoming videos to finish saving before editing so slow transfers never cut clips short.'
    ]
  },
  {
    date: '2026-11-05', title: 'Universal Bluetooth Remote, Beat-Drop Speed Ramping, Film Color Looks & Live TV Sync (Android)', for: ['android'], android: '1.0.86',
    items: [
      'Spin & Print Integration: Automatic photo strip generation and keychain printing from 360 clips on tablet.',
      'Universal Remote Triggering: Pocket Bluetooth selfie clickers and volume button triggering support.',
      'Cinematic Color Looks & Beat-Drop Ramping: Real-time look grading and synchronized speed transitions.'
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
    date: '2026-11-04', title: 'Square 1:1 Live Aspect, 40 Animated FX & Multi-Trajectory Motion Engine (Android)', for: ['android'], android: '1.0.85',
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
      'Persistent Preset Storage: Presets are saved with your event setup and restored automatically when you reopen the booth.'
    ]
  },
  {
    date: '2026-11-04', title: 'Multi-Collage Presets & Dynamic Guest Layout Selection (Android)', for: ['android'], android: '1.0.84',
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
    date: '2026-11-04', title: 'Post-Session Guest Sticker Customisation & Print-First Mode (Android)', for: ['android'], android: '1.0.83',
    items: [
      'Post-Session Guest Sticker Customisation: Enable the new toggle in Extras -> Stickers to let guests add stickers to their photo before printing.',
      'Touch & Drag Placement: Interactive sticker tray with sizing, rotation, and deletion tools optimized for tablet touchscreens.',
      'Print First Before Showing QR: Option in Print Settings to print first and reveal the QR code once printing finishes.',
      'Isolated Guest State: Host template stickers stay untouched; guest stickers cleanly reset for each new guest.'
    ]
  },
  {
    date: '2026-11-04', title: 'Instant Live Text & Color Preview + Dual-QR Share Window', for: ['app', 'website'], app: '1.0.71',
    items: [
      'Instant Live Text & Color Updates: Text and color changes appear live on the video preview right as you type or pick a color, without re-rendering first.',
      'Live Draft Preview for Edited Videos: Adjusting text or style on a finished clip switches cleanly to live preview so you see changes immediately.',
      'Dedicated Share Window: Clicking Share + QR opens a clean presentation screen showing Booth Wi-Fi (Step 1), the finished video, and Guest Download QR (Step 2).',
      'QR Code Visibility Toggle: Switch between dual QR sharing and a clean full-screen video preview using "Hide QR Codes".',
      'One-Click Share Link Copy: Copy the guest download link directly from the share window.'
    ]
  },
  {
    date: '2026-11-04', title: 'Instant Live Text & Color Preview + Dual-QR Share Window (Android)', for: ['android'], android: '1.0.82',
    items: [
      'Instant Live Text & Color Updates: Text and color changes appear live on the video preview right as you type or pick a color, without re-rendering first.',
      'Live Draft Preview for Edited Videos: Adjusting text or style on a finished clip switches cleanly to live preview so you see changes immediately.',
      'Dedicated Share Window: Clicking Share + QR opens a clean presentation screen showing Booth Wi-Fi (Step 1), the finished video, and Guest Download QR (Step 2).',
      'QR Code Visibility Toggle: Switch between dual QR sharing and a clean full-screen video preview using "Hide QR Codes".',
      'One-Click Share Link Copy: Copy the guest download link directly from the share window.'
    ]
  },
  {
    date: '2026-11-04', title: 'Full-Page 360 Studio Desk with Sticky Live Side Preview & Turntable Simulation', for: ['app', 'website'], app: '1.0.69',
    items: [
      'Full-Page 360 Studio Workspace: Upgraded the 360 desk into a full-page studio with quick-jump navigation tabs.',
      'Sticky Live Side Preview: Preview stays pinned beside your controls and updates immediately as you customize frames, text, fonts, and colors.',
      'Turntable Preview Stage: Shows a rotating 360 platform preview even before a video is loaded so you can design branding ahead of the event.',
      'Interactive Playback & Scrubber: Seek bar with live timer and speed choices (0.25x, 0.5x, 1.0x, 2.0x) to inspect every moment.',
      'Animated Particle Simulation: Live preview shows gold dust, confetti, hearts, and bokeh directly on stage.'
    ]
  },
  {
    date: '2026-11-04', title: 'Full-Page 360 Studio Desk with Sticky Live Side Preview & Turntable Simulation (Android)', for: ['android'], android: '1.0.80',
    items: [
      'Full-Page 360 Studio Workspace: Upgraded the 360 desk into a full-page studio with quick-jump navigation tabs.',
      'Sticky Live Side Preview: Preview stays pinned beside your controls and updates immediately as you customize frames, text, fonts, and colors.',
      'Turntable Preview Stage: Shows a rotating 360 platform preview even before a video is loaded so you can design branding ahead of the event.',
      'Interactive Playback & Scrubber: Seek bar with live timer and speed choices (0.25x, 0.5x, 1.0x, 2.0x) to inspect every moment.',
      'Animated Particle Simulation: Live preview shows gold dust, confetti, hearts, and bokeh directly on stage.'
    ]
  },
  {
    date: '2026-11-04', title: 'Thermal Layouts, Dual Pricing, Custom Labels & Tiered Vouchers (Android)', for: ['android'], android: '1.0.79',
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
      'Persistent Video Dismissal & Safe Deletion: Cleared videos stay cleared across app restarts and can optionally be removed from your computer.',
      'Smooth Laptop Performance: Limits background rendering load so the booth stays responsive while processing videos.'
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
    date: '2026-11-04', title: '360 Photo & Video Booth Overhaul: Faster Video Rendering, Sharing Station & Live TV Wall', for: ['app', 'website'], app: '1.0.64',
    items: [
      'Faster 360 Video Rendering: Uses your laptop’s graphics hardware when available so 360 spin videos process up to 3× faster.',
      'Smooth High-Frame-Rate Slow Motion: Supports 60 fps and 120 fps recordings for crisp, buttery slow-motion clips.',
      'Sharing Station (/station): Dedicated iPad/tablet screen with instant QR code pop-ups and a 35-second auto-reset so guests clear the 360 platform quickly.',
      'Live Wall Display (/wall): Full-screen TV and projector slideshow automatically looping newest 360 spins with "New 360 Spin" banners and QR codes.',
      'Square 1:1 Video Format: Added Instagram-ready Square (1080×1080) format alongside Portrait (9:16) and Landscape (16:9).',
      'Custom Text Overlays: Two lines of customizable text with custom colors, sizing, drop shadows, placement, and smooth fades.',
      'Intro & Outro Video Stingers: Automatically attach sponsor clips before and after each 360 spin with balanced audio.',
      'Auto-Rotating Looks & Music: Automatically cycles video styles, particle effects, and soundtracks between guests.',
      'Online & Offline Sharing: Uses native phone sharing when online and high-speed direct downloads over booth Wi-Fi when offline.'
    ]
  },
  {
    date: '2026-11-04', title: 'Epson L120/L121 & Canon G1010/G3030 Direct USB Printing', for: ['android'], android: '1.0.78',
    items: [
      'Added built-in direct USB support for Epson L120 and L121 with default color printing.',
      'Added built-in USB support and automatic permissions for Canon PIXMA G1010 and G3030 printers.',
      'Improved background printing speed and color richness.'
    ]
  },
  {
    date: '2026-11-04', title: 'Cleaner Printer Settings, Streamlined Badges & Friendly Notices', for: ['app', 'website', 'android'], app: '1.0.77',
    items: [
      'Simplified printer settings to hide clutter and long hardware lists for a cleaner, easier setup screen.',
      'Streamlined printer labels with clear badges (Photo, Receipt, USB, Wi-Fi) and helpful status hints.',
      'Replaced technical pop-up messages on Android tablets with plain, easy-to-follow notices.'
    ]
  },
  {
    date: '2026-11-03', title: 'Video/GIF Tap-to-Start, Sponsor Playlist & Tablet Portrait Fitting', for: ['website', 'android'], android: '1.0.76',
    items: [
      'Video & Animated GIF Welcome Screens: Tap-to-start screen now accepts looping MP4/WebM videos and animated GIFs.',
      'Corporate Sponsor Playlist (Billboard Mode): Upload multiple sponsor videos and brand graphics that automatically cycle and crossfade between guests.',
      'Tablet Portrait Scale-to-Fit: Full-bleed edge-to-edge scaling on Android tablets with no black bars, custom button colors, and smooth tap transitions.',
      'Low-Memory Welcome Video Storage: Keeps looping videos running smoothly on budget tablets without slowing down the booth.'
    ]
  },
  {
    date: '2026-11-03', title: 'Android Print & Camera Helper for Chrome & Direct USB Printing', for: ['android'], android: '1.0.75',
    items: [
      'Built-in Print Helper on Android: Lets Google Chrome on Android phones and tablets connect straight to USB printers through the photobooth4u app.',
      'Silent direct USB printing: Print from Chrome to Epson L3210, L8050, L3276, Canon SELPHY CP1500, and USB receipt printers with no print pop-up.',
      'Automatic photo rotation: Ensures landscape photos automatically fit portrait photo printers without cutting off edges.',
      'Stays connected in background: Keeps USB printers ready while switching between Chrome and the helper app.'
    ]
  },
  {
    date: '2026-11-03', title: 'Landscape 4×6 borderless print fix, Lightness & RGB colour correction & camera stability (Windows & Mac)', for: ['app'], app: '1.0.63',
    items: [
      'Landscape & borderless 4×6 prints (Windows): Prints now fill the whole 4×6 in sheet right-side up even when the printer driver (such as Epson L3210 or L8050) is set to Landscape, fixing 2/3-size prints and upside-down Print Previews.',
      'Lightness / Exposure & RGB colour correction: Adjust lightness/darkness (-100 to +100) and Red, Green, and Blue balance directly in Setup Extras or Print settings, with real-time live preview and print support across thermal and photo printers.',
      'Camera glitch & false-disconnect fixes: Resolved false "Camera disconnected" messages on built-in webcams and paused result screens, improved camera error tips, and added USB webcam preview resolution options (Auto, Max, 1080p, 720p, 480p).',
      'Offline voucher sync & single Photo + GIF QR: Reliable offline voucher redemption with automatic cloud sync when back online, plus one unified QR code for guests in Photo + GIF mode.'
    ]
  },
  {
    date: '2026-11-03', title: 'External USB webcam support & resolution controls (Android)', for: ['android'], android: '1.0.74',
    items: [
      'Plug-and-play USB webcams: Supports Logitech Brio 4K, Logitech C270 HD, C920, and other standard USB webcams on Android tablets.',
      'Preview resolution selector: Choose Auto (up to 1080p), Max, 1080p, 720p, or 480p (smoothest for GIFs/boomerangs) to match your tablet speed.',
      'Max-resolution still capture: Keeps smooth 1080p/720p live view while snapping photos at the webcam\u2019s highest quality.',
      'Power & disconnect recovery: Automatic stall recovery, powered USB hub tips, and instant reconnection if a cable is replugged mid-event.'
    ]
  },
  {
    date: '2026-11-03', title: 'Offline voucher redemption, cloud batch sync & My Events tally (Android)', for: ['android'], android: '1.0.73',
    items: [
      'Guaranteed offline voucher redemption: Local offline batch lookup prevents offline-generated codes from being rejected as unrecognised.',
      'Offline batch syncing: Automatically synchronizes offline-generated voucher batches, used counts, and voided tickets to the server when connected to Wi-Fi.',
      'My Events voucher tally: Complete dashboard bar tallying total vouchers created, redeemed by guests, cancelled, remaining available, and total revenue.'
    ]
  },
  {
    date: '2026-11-03', title: 'Android app stability, faster color prints & smoother performance on budget tablets', for: ['android'], android: '1.0.72',
    items: [
      'Instant print color adjustments: Lightness and color adjustments apply immediately without slowing down printing.',
      'Lower memory use when printing: Prevents memory crashes on budget tablets during high-resolution photo bursts and print jobs.',
      'Automatic screen recovery: Automatically recovers the booth screen if a budget tablet runs low on memory mid-event.',
      'Stronger Bluetooth & USB reliability: Cleans up dropped connections right away and re-detects printers and cameras when replugged.'
    ]
  },
  {
    date: '2026-11-03', title: 'Single QR for Photo + GIF & tablet camera reliability (Android / Web)', for: ['android', 'website'], android: '1.0.71',
    items: [
      'Single unified QR code for Photo + GIF mode: Guests scan one QR code to view and save both their photo strip and animated GIF with separate save buttons.',
      'Fixed false "Camera disconnected" alerts on Android tablets: Resolved false disconnection alerts when returning from the result screen.',
      'Clearer camera error tips: Built-in tablet cameras no longer show misleading "Check USB cable" messages.',
      'Moved Lightness and color adjustment sliders directly into Print settings for faster reprint tweaks.'
    ]
  },
  {
    date: '2026-11-03', title: 'Lightness & RGB colour correction for thermal & photo printers (Android)', for: ['android'], android: '1.0.68',
    items: [
      'New Lightness / Exposure slider (-100 to +100) in Setup Extras to prevent dark or muddy prints on thermal receipt printers.',
      'Fine-tuned RGB color balance sliders (Red, Green, Blue from -100 to +100) with instant live preview after photo sessions.',
      'Adjustments update both the post-session preview and live camera view in real time.',
      'Works across all supported printers: Bluetooth/USB thermal receipt printers, Epson L-series, Canon SELPHY, Canon PIXMA G, and Wi-Fi photo printers.'
    ]
  },
  {
    date: '2026-11-03', title: 'Portrait centered welcome card & layout preview fix (Android)', for: ['android'], android: '1.0.67',
    items: [
      'In portrait mode, the sample print is centered horizontally and vertically cleared below the top navigation bar without clipping.',
      'The event details card with "Tap to start" sits neatly below the sample print, centered on the tablet screen with safe clearance from bottom dock controls.',
      'Welcome screen image is fully contained with zero edge cropping across all tablet screen aspect ratios.',
      'Shots preview thumbnails in both shooting and retake review screens are stacked vertically along the right side.'
    ]
  },
  {
    date: '2026-11-03', title: 'Bluetooth thermal printers, settings shortcut & USB detection (Android)', for: ['android'], android: '1.0.66',
    items: [
      'Connect Bluetooth Printer button is now always visible on tablets without needing to select receipt paper first.',
      'Direct shortcut to Android Bluetooth Settings and instant warning notification if Bluetooth is disabled on the tablet.',
      'Added recognized hardware support for VOZY G80, P50 and MP210 thermal receipt printers.',
      'Added recognized hardware support for Star Micronics TSP143III series and Xprinter XP-T80Q / XP-P300.',
      'Wi-Fi & USB printer section renamed and updated with clear [USB] connection indicators.'
    ]
  },
  {
    date: '2026-11-03', title: 'Portrait camera centering, side thumbnails & welcome card fix (Android)', for: ['android'], android: '1.0.65',
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
    date: '2026-11-02', title: 'Mac: fix crash when closing the app', for: ['website', 'app'], app: '1.0.52',
    items: [
      'Fixed the "photobooth4u quit unexpectedly" pop-up that appeared every time the Mac app was closed.',
      'Stopped running an extra Mac permission check while the app is closing, so Internet Sharing stays on until you turn it off in System Settings.',
      'Cleanly stops background timers and camera checks when closing so the app shuts down smoothly.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: natural color blending and transparent animated overlays', for: ['website', 'app'], app: '1.0.51',
    items: [
      'Fixed animated video overlays appearing tinted pink or washed out so skin tones and colors stay natural.',
      'Fixed Floating Hearts, Streamers, Confetti, Rose Petals, and Balloons overlays showing solid black behind particles instead of clear transparency.',
      'Overlays now blend cleanly over guests with crisp transparent backgrounds.'
    ]
  },
  {
    date: '2026-11-02', title: 'Mac & Windows laptops: standalone booth Wi-Fi with no router or internet', for: ['website', 'app'], app: '1.0.50',
    items: [
      'Mac laptops can now create their own booth Wi-Fi in Setup → Share with the new “Set up (one time)” and “Make this laptop the booth Wi-Fi” switch.',
      'The app configures Mac Internet Sharing automatically so it works offline without an active internet connection.',
      'Guests scan the Join QR and access photos and videos directly with no router, pocket Wi-Fi, or phone hotspot at the booth.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: animated video overlay loops and reliability fix', for: ['website', 'app'], app: '1.0.49',
    items: [
      'Bundles all 40 animated video overlay loops (confetti, gold dust, streamers, rose petals, neon effects, fireworks, and more) with clean transparent backgrounds.',
      'Adds a safety fallback so 360 video edits still finish cleanly even if an overlay file is missing.'
    ]
  },
  {
    date: '2026-11-02', title: 'Android tablet: the tablet can make its own booth Wi-Fi', for: ['android'], android: '1.0.59',
    items: [
      'In Setup → Share there is a new switch, “Make this tablet the booth Wi-Fi”. It turns on a Wi-Fi network from the tablet itself, so guests can scan the Join QR and open their photos with no router, pocket Wi-Fi or phone hotspot. The name and password are made for you. Android 13 and newer asks to allow “Nearby devices”; older Android asks for Location.',
      'Switch the tablet’s Wi-Fi on first (it does not need to join a network). While it hosts, many tablets can’t also use another Wi-Fi, so activate and update the app beforehand. If a tablet can’t do it, the app says so and a router or phone hotspot works as before. Android app 1.0.59.'
    ]
  },
  {
    date: '2026-11-02', title: '360 desk: 40 animated video effects (confetti, sparks, neon, and more)', for: ['website', 'app'], app: '1.0.48',
    items: [
      'The 360 desk’s editing panel has a new "Animated effect" menu with 40 overlay effects: confetti cannons, gold dust storms, rose petals, neon laser grids, burning embers, snowfall, fireworks and more — grouped by Celebration, Weddings, VIP/Luxury, Nightlife, Action/Retro and Holidays.',
      'Effects blend directly over the slow-motion or boomerang clip right on the laptop with no internet or extra subscription required.',
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
    date: '2026-11-01', title: 'Photo size on the paper, in plain choices', for: ['website', 'android'], android: '1.0.57',
    items: [
      'Print settings now has one row under Photo size on the paper: Fit the page, a real size such as 2×6 strip or 4R, or Fill the page. A real size prints in the middle of a bigger paper such as A4.',
      'Setup step 4 is now Camera & printer, with the printer, paper and a print preview. Android app 1.0.57.'
    ]
  },
  {
    date: '2026-11-01', title: 'Android app: Android print dialog, print settings and more printers over USB', for: ['android'], android: '1.0.44',
    items: [
      'Android app 1.0.44: Print settings has a new Android print dialog choice. It opens Android\u2019s own print screen for any printer the tablet can reach, and a button opens Android print settings so print services (Mopria, Epson, Canon, HP, Brother) can be switched on.',
      'After you pick a Wi-Fi printer the app shows its own colour, quality and paper-type choices, only the ones that printer lists.',
      'USB (OTG): printers with driverless USB printing and receipt printers can be printed to, and some older Epson ink-tank models work in an experimental black-and-white and colour mode. Printers that need their own driver still need the laptop.'
    ]
  },
  {
    date: '2026-10-31', title: 'Android app prints to Wi-Fi and USB printers it finds itself', for: ['android'], android: '1.0.35',
    items: [
      'Android app 1.0.35: Print settings has a new Wi-Fi printer section. Tap Find Wi-Fi printers and the tablet lists printers on the same Wi-Fi, such as Epson, Canon, HP and Brother models that support AirPrint / Mopria, and prints photos straight to the one you pick, with no print dialog.',
      'Printers plugged into the tablet’s USB port appear in the same list. Receipt printers and driverless USB printers can be printed to. Printers that need their own driver (for example Epson L120 / L210, DNP, HiTi) are shown as detected but still need the laptop.',
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
    date: '2026-10-31', title: 'Photo + GIF: guests can retake photos again', for: ['website', 'app', 'android'], app: '1.0.40', android: '1.0.34',
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
    date: '2026-10-31', title: 'Android tablet: the Bluetooth printer list shows your receipt printer first', for: ['android'], android: '1.0.32',
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
    date: '2026-10-31', title: 'Use a DSLR with an iPad: the iPad uses the laptop’s camera over Wi-Fi', for: ['website', 'app', 'ipad'], app: '1.0.37',
    items: [
      'Laptop app 1.0.37 (Windows): an iPad can now use the real DSLR shutter, live view and flash. Plug the Nikon, Canon EOS or Sony Alpha into the laptop, then in Setup → Share & start turn on “Let an iPad use this laptop’s camera”. The laptop shows an address and a 6-digit PIN: open it in Safari on the iPad (same Wi-Fi) and type the PIN. It works with no internet, and photos save on the laptop. An iPad with a camera and no laptop can’t do this.',
      'No laptop? An iPad can still use a camera through an HDMI-to-USB capture card (no real shutter or flash). The new iPad guide at /how-to-ipad/ explains both ways.',
      'About us: the three monthly plans now sit in one row, and the top menu has an FAQ link.'
    ]
  },
  {
    date: '2026-10-30', title: 'Flip book: sharper pages that differ from each other', for: ['website', 'app', 'android'], app: '1.0.34', android: '1.0.31',
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
    date: '2026-10-30', title: 'A Camera step in Setup, with a live view of your camera', for: ['website', 'app', 'android'], app: '1.0.32', android: '1.0.30',
    items: [
      'Laptop app 1.0.32 and Android app 1.0.30: Setup has a new step after Layout, Camera. It shows a live view of what the camera sees before you start: the full camera frame by default, or tap “Crop to layout” to see only the part that fits your layout.',
      'The camera picker, Mirror and the camera log moved there from the Session step. Mirror and the live filter show in the live view. The Camera button in Photo Session works as before.',
      'Setup now has 7 steps: Design, Text, Layout, Camera, Extras, Share and Session (Share is step 6 and Session is step 7).'
    ]
  },
  {
    date: '2026-10-30', title: 'Wi-Fi read for you, a Wi-Fi button in the bottom bar, and one-tap printing of earlier photos', for: ['website', 'app', 'android'], app: '1.0.31', android: '1.0.29',
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
    date: '2026-10-30', title: '360 videos: join the Wi-Fi and download, with two QR codes', for: ['website', 'app', 'android'], app: '1.0.29', android: '1.0.27',
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
    date: '2026-10-29', title: 'The Android tablet app now speaks the countdown', for: ['android'], android: '1.0.22',
    items: [
      'Android app 1.0.22: the spoken countdown (Get ready, Three, Two, One, Smile!) now works on the tablet, using the tablet\u2019s own text-to-speech voices. It works offline once an English voice is downloaded (Settings \u2192 System \u2192 Languages \u2192 Text-to-speech output).',
      'Choose English or Tagalog (when the tablet has a Filipino voice), the last 3 numbers or every number, and the voice in Setup \u2192 Session. With no voice on the tablet the beeps are used.'
    ]
  },
  {
    date: '2026-10-29', title: 'Guests can see only their own photos, and a spoken countdown', for: ['website', 'app', 'android'], app: '1.0.26', android: '1.0.21',
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
    date: '2026-10-29', title: 'Phone photos, guest print requests, video guestbook, GIFs in your frame and 360 recording in the app', for: ['website', 'app', 'android'], app: '1.0.24',
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
    date: '2026-10-29', title: 'Android tablet app now needs a code, same as the laptop app', for: ['android'], android: '1.0.7',
    items: [
      'The Android app (v1.0.7) is still free to install, but now stays on an \u201cActivate this tablet\u201d screen until it\u2019s unlocked with a rental code that has the offline app add-on \u2014 the same signed-licence system the Windows/Mac app already uses.',
      'It needs Wi-Fi once to activate, then keeps working offline until the licence\u2019s own renewal is due, in the background, same as the laptop app.',
      'One code\u2019s offline-app device slots are now shared between the desktop and Android apps.',
    ]
  },
  {
    date: '2026-10-29', title: 'Fix: the Android tablet sometimes tried to load the live website and failed', for: ['android'],
    items: [
      'A tablet that had ever been pointed at the live website (via the hidden Booth Configuration screen) kept trying that on every launch, even at a venue with no Wi-Fi \u2014 showing Android\u2019s own \u201ccould not be loaded, internet disconnected\u201d page instead of the booth.',
      'The app now checks for a real internet connection before it ever tries the live site, and falls back to the bundled offline booth on any load failure, not just specific error types.',
    ]
  },
  {
    date: '2026-10-28', title: 'Android tablet app \u2014 photos, GIFs and QR codes now work fully offline', for: ['android'], android: '1.0.5',
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
    date: '2026-10-28', title: 'Android tablet app \u2014 true offline kiosk mode', for: ['android'], android: '1.0.2',
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
