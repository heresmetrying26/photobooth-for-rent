// Turns protected/booth.html into a JS module that the server function serves
// only to people holding a valid license. The app itself is never in /public,
// so nobody can read it without unlocking.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const src = new URL('../protected/booth.html', import.meta.url);
const out = new URL('../netlify/lib/booth.mjs', import.meta.url);
const html = readFileSync(src, 'utf8');
writeFileSync(out, 'export default ' + JSON.stringify(html) + ';\n');
console.log('Bundled protected/booth.html (' + html.length + ' chars) -> netlify/lib/booth.mjs');

const androidAsset = new URL('../android/app/src/main/assets/booth.html', import.meta.url);
if (existsSync(androidAsset)) {
  copyFileSync(src, androidAsset);
  console.log('Synced to android/app/src/main/assets/booth.html');
}

const iosAsset = new URL('../ios/photobooth4u/booth.html', import.meta.url);
if (existsSync(iosAsset)) {
  copyFileSync(src, iosAsset);
  console.log('Synced to ios/photobooth4u/booth.html');
}

// The newest Android app version offered to tablets comes from versionName in android/app/build.gradle,
// so it can never be left behind when a new APK is released (netlify/lib/updates.mjs reads this file).
const gradle = new URL('../android/app/build.gradle', import.meta.url);
if (existsSync(gradle)) {
  const m = /versionName\s+"([0-9.]+)"/.exec(readFileSync(gradle, 'utf8'));
  if (m) {
    writeFileSync(new URL('../netlify/lib/android-version.mjs', import.meta.url), "export default '" + m[1] + "';\n");
    console.log('Android app version ' + m[1] + ' -> netlify/lib/android-version.mjs');
  }
}
