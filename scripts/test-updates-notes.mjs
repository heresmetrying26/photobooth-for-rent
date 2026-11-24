// Guards against technical jargon, broken Markdown, and wrong platform tags in client-facing release notes (netlify/lib/updates.mjs).
//
//   node scripts/test-updates-notes.mjs      exit 1 on a problem
import { NOTES } from '../netlify/lib/updates.mjs';

const VALID_FOR = new Set(['website', 'app', 'android', 'ipad', 'helper']);
const JARGON_RE = /\*\*|`|\b0x[0-9a-f]+\b|\b[A-Za-z_]\w*\(\)|#[A-Za-z]\w+|\.(kt|swift|mjs|js|ps1|ino|toml)\b|\b(API|IPC|SDK|mDNS|IPP|LPD|SNMP|RFC|YUV|Metal|CoreImage|AVFoundation|AVCapture\w*|AVAssetWriter|MTKView|UIKit|WebView|WebKit|DEVMODE|BroadcastChannel|IndexedDB|captureStream|libusb|WPD|ESC\/P-R|ESC\/P2|ESC\/POS|TileFlipXY|writev|TCP_NODELAY|ImageIO|CoreMotion|getUserMedia|ImageCaptureCore|WinUSB|FIFO|JFIF|Base64|PCHDDCapacity|SetRemoteMode|GUEST_HTML|Skia|largeHeap|compositor|SIGABRT|__assert_rtn|CrBrowserMain|osascript|launchctl|powerSaveBlocker|BoothDummy|bridge100|libvpx|vp9|planar RGB|localStorage|Logcat|FFmpeg|NVENC|VideoToolbox|QuickSync|AMD AMF|filtergraph|WYSIWYG|HTTP|HTML5|loopback|rasterization)\b/i;

// #next is a UI button label in note [2] ("active shots + #next"); allow explicit UI chip labels if needed.
const ALLOW_HASH = new Set(['#next']);

let bad = 0;
const fail = (idx, note, msg) => {
  bad++;
  console.error(`FAIL [${idx}] (${note.date || '?'}): ${msg} — "${String(note.title || '').slice(0, 70)}"`);
};

if (!Array.isArray(NOTES) || NOTES.length === 0) {
  console.error('FAIL: NOTES array is missing or empty.');
  process.exit(1);
}

NOTES.forEach((n, idx) => {
  if (!n || typeof n !== 'object') return fail(idx, {}, 'entry is not an object');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(n.date || ''))) fail(idx, n, 'invalid date format (expected YYYY-MM-DD)');
  if (!n.title || typeof n.title !== 'string' || !n.title.trim()) fail(idx, n, 'missing title');
  if (!Array.isArray(n.items) || n.items.length === 0 || n.items.some((x) => typeof x !== 'string' || !x.trim())) {
    fail(idx, n, 'items must be a non-empty array of strings');
  }
  if (!Array.isArray(n.for) || n.for.length === 0) {
    fail(idx, n, 'missing `for` platform array');
  } else {
    for (const f of n.for) {
      if (!VALID_FOR.has(f)) fail(idx, n, `unknown \`for\` tag "${f}"`);
    }
    if (n.app && !n.for.includes('app')) fail(idx, n, 'has `app` version without "app" in `for`');
    if (n.android && !n.for.includes('android')) fail(idx, n, 'has `android` version without "android" in `for`');
    if (n.ipad && !n.for.includes('ipad')) fail(idx, n, 'has `ipad` version without "ipad" in `for`');
    if (n.helper && !n.for.includes('helper')) fail(idx, n, 'has `helper` version without "helper" in `for`');
    if (n.for.includes('app') && !/\b(Desktop|laptop|Windows|Mac|360|booth|Flipbook|Arrange|Photoman|Vouchers|Spots|Frames|Profiles|Canon|Sony|Nikon|Epson|Clicker|Bluetooth|Roving)\b/i.test(n.title) && /\b(Android|iPad|iOS)\b/i.test(n.title)) {
      fail(idx, n, 'Android/iPad-only title should not include "app" in `for`');
    }
  }

  const lines = [n.title || '', ...(n.items || [])];
  for (const line of lines) {
    const matches = line.match(new RegExp(JARGON_RE.source, 'gi')) || [];
    const unexpected = matches.filter((m) => !ALLOW_HASH.has(m));
    if (unexpected.length) {
      fail(idx, n, `technical wording or markdown found (${[...new Set(unexpected)].join(', ')}). Move technical details to docs/dev-changelog.md`);
    }
  }
});

if (bad) {
  console.error(`${bad} problem(s) in netlify/lib/updates.mjs. Run: node scripts/test-updates-notes.mjs`);
  process.exit(1);
}
console.log(`OK: ${NOTES.length} client release notes checked — plain language, no markdown, valid platform tags.`);
