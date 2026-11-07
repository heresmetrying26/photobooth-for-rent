// Turns the Android booth project into the "Rush ID Station" app, in the CI checkout only (see .github/workflows/rushid-android.yml).
// The booth's own build files are never changed in git, so a mistake here cannot affect booth releases.
//
// The Rush app is the same Android app (same cameras, USB, Bluetooth and printer code), but:
//   - its own app id and name, so it installs beside the booth app
//   - no offline activation gate: it opens https://photobooth4u.netlify.app/rush/ and the code lock screen there decides
//     (the code must have "Rush ID station" switched on in Admin)
//   - no "new booth version" prompt (that would offer the booth APK)
//   - no offline booth fallback (the Rush station needs the internet for its code check)
// Every edit must match exactly once, or the build stops with a message, so a change to the booth code is never missed silently.
//
// Usage: node android/scripts/make-rush-variant.mjs [androidProjectDir]      env: RUSH_VERSION_CODE, RUSH_VERSION_NAME
// The default is the android/ folder this script sits in (it holds app/ and build.gradle).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const code = Math.max(1, parseInt(process.env.RUSH_VERSION_CODE || '1', 10) || 1);
const nameRaw = String(process.env.RUSH_VERSION_NAME || '').replace(/^rushid-v/, '');
const name = /^[0-9][0-9A-Za-z.\-]*$/.test(nameRaw) ? nameRaw : '1.0.0-dev';

function edit(rel, pairs) {
  const f = join(ROOT, rel);
  let s = readFileSync(f, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  for (const [a, b, why] of pairs) {
    const from = typeof a === 'string' ? a.replace(/\n/g, nl) : a;
    const hits = typeof from === 'string' ? s.split(from).length - 1 : (s.match(new RegExp(from.source, 'g')) || []).length;
    if (hits !== 1) { console.error('Rush variant: ' + rel + ' — expected exactly 1 match for ' + why + ', found ' + hits + '. The booth code changed; update android/scripts/make-rush-variant.mjs.'); process.exit(1); }
    s = typeof from === 'string' ? s.replace(from, () => b.replace(/\n/g, nl)) : s.replace(from, () => b);
  }
  writeFileSync(f, s);
  console.log('patched ' + rel);
}

edit('app/build.gradle', [
  ['applicationId "com.photobooth4u.booth"', 'applicationId "com.photobooth4u.rushstation"', 'the application id'],
  [/versionCode \d+/, 'versionCode ' + code, 'versionCode'],
  [/versionName "[^"]*"/, 'versionName "' + name + '"', 'versionName'],
]);
edit('app/src/main/res/values/strings.xml', [
  ['<string name="app_name">photobooth4u</string>', '<string name="app_name">Rush ID Station</string>', 'the app name'],
]);
edit('app/src/main/java/com/photobooth4u/booth/MainActivity.kt', [
  // Start: skip the offline activation gate and open the online Rush station.
  ['    private fun bootWithLicence() {\n        val st = licence.status()',
   '    private fun bootWithLicence() {\n        // Rush ID Station build: the code lock screen on the site decides who may use it.\n        if (isNetworkAvailable()) webView.loadUrl(BASE_URL + "rush/") else webView.loadData("<body style=\'font-family:sans-serif;padding:24px;background:black;color:white\'><h2>No internet connection</h2><p>Connect to Wi-Fi, then close and reopen the app.</p></body>", "text/html", "UTF-8")\n        if (true) return\n        val st = licence.status()',
   'bootWithLicence()'],
  // No "new booth version" prompt.
  ['    private fun checkForAppUpdate(manual: Boolean = false) {\n',
   '    private fun checkForAppUpdate(manual: Boolean = false) {\n        if (true) return          // Rush ID Station build: the booth update would be offered here\n',
   'checkForAppUpdate()'],
  // No offline booth page.
  ['    private fun loadOfflineBooth() {\n        offlineLoaded = true',
   '    private fun loadOfflineBooth() {\n        if (true) { runOnUiThread { webView.loadData("<body style=\'font-family:sans-serif;padding:24px;background:black;color:white\'><h2>No internet connection</h2><p>The Rush ID Station needs the internet. Connect to Wi-Fi, then close and reopen the app.</p></body>", "text/html", "UTF-8") }; return }\n        offlineLoaded = true',
   'loadOfflineBooth()'],
]);
console.log('Rush ID Station variant ready: com.photobooth4u.rushstation, version ' + name + ' (code ' + code + ')');
