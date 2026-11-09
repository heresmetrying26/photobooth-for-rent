// Turns the Android booth project into the standalone "Roving DSLR Bridge" app, in the CI checkout only (see .github/workflows/roving-android.yml).
// The booth's own build files are never changed in git, so a mistake here cannot affect booth releases.
//
// The Roving DSLR Bridge app is a dedicated mobile companion for roaming photographers:
//   - its own app id (com.photobooth4u.rovingbridge) and name ("Roving DSLR Bridge"), so it installs beside the booth app
//   - opens directly into RovingBridgeActivity (no WebView, no kiosk mode, no license code gate needed on the photographer's phone)
//   - listens for USB OTG connected DSLRs (Nikon, Canon EOS, Sony Alpha)
//   - pairs in 1 second by scanning the Photographer Desk QR code displayed on the laptop screen
//   - streams full-res photos directly into the laptop's queue over local Wi-Fi
//
// Usage: node android/scripts/make-roving-variant.mjs [androidProjectDir]      env: ROVING_VERSION_CODE, ROVING_VERSION_NAME
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const code = Math.max(1, parseInt(process.env.ROVING_VERSION_CODE || '1', 10) || 1);
const nameRaw = String(process.env.ROVING_VERSION_NAME || '').replace(/^roving-v/, '');
const name = /^[0-9][0-9A-Za-z.\-]*$/.test(nameRaw) ? nameRaw : '1.0.0';

function edit(rel, pairs) {
  const f = join(ROOT, rel);
  let s = readFileSync(f, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  for (const [a, b, why] of pairs) {
    const from = typeof a === 'string' ? a.replace(/\n/g, nl) : a;
    const hits = typeof from === 'string' ? s.split(from).length - 1 : (s.match(new RegExp(from.source, 'g')) || []).length;
    if (hits !== 1) {
      console.error('Roving variant: ' + rel + ' — expected exactly 1 match for ' + why + ', found ' + hits + '. Update android/scripts/make-roving-variant.mjs.');
      process.exit(1);
    }
    s = typeof from === 'string' ? s.replace(from, () => b.replace(/\n/g, nl)) : s.replace(from, () => b);
  }
  writeFileSync(f, s);
  console.log('patched ' + rel);
}

edit('app/build.gradle', [
  ['applicationId "com.photobooth4u.booth"', 'applicationId "com.photobooth4u.rovingbridge"', 'the application id'],
  [/versionCode \d+/, 'versionCode ' + code, 'versionCode'],
  [/versionName "[^"]*"/, 'versionName "' + name + '"', 'versionName'],
]);

edit('app/src/main/res/values/strings.xml', [
  ['<string name="app_name">photobooth4u</string>', '<string name="app_name">Roving DSLR Bridge</string>', 'the app name'],
]);

// Configure AndroidManifest so RovingBridgeActivity is the primary and only launcher activity,
// and remove kiosk receivers/aliases that are not needed on the photographer's personal phone.
const mainActivityOld = `        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"
            android:screenOrientation="unspecified"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <!-- Plugging the camera in offers this app, and "always" remembers the OK so the booth connects by itself -->
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <!-- USB auto-attach filter: cameras (Nikon, Canon, Sony) and printers (Epson L8050, L3210, L3276, Selphy, thermal) -->
            <meta-data
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                android:resource="@xml/usb_device_filter" />
        </activity>`;

const mainActivityNew = `        <activity
            android:name=".MainActivity"
            android:exported="false"
            android:enabled="false" />`;

const kioskAliasOld = `        <!-- Kiosk Home Launcher: Allows setting photobooth4u as the tablet's default Home app -->
        <activity-alias
            android:name=".KioskHomeLauncher"
            android:targetActivity=".MainActivity"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.HOME" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity-alias>`;

const rovingActivityOld = `        <!-- Roving DSLR Bridge Activity: Connects DSLR via USB and streams to Desktop Booth -->
        <activity
            android:name=".RovingBridgeActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:label="Roving DSLR Bridge"
            android:icon="@mipmap/ic_launcher"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:screenOrientation="unspecified"
            android:windowSoftInputMode="adjustResize" />`;

const rovingActivityNew = `        <!-- Roving DSLR Bridge Activity: Dedicated launcher & USB camera receiver -->
        <activity
            android:name=".RovingBridgeActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:label="Roving DSLR Bridge"
            android:icon="@mipmap/ic_launcher"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:screenOrientation="unspecified"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <!-- USB auto-attach filter: cameras (Nikon, Canon, Sony) -->
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <meta-data
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                android:resource="@xml/usb_device_filter" />
        </activity>`;

const bootReceiverOld = `        <!-- Auto-launch receiver: opens photobooth4u when device powers on or restarts -->
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true"
            android:permission="android.permission.RECEIVE_BOOT_COMPLETED">
            <intent-filter android:priority="999">
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="com.htc.intent.action.QUICKBOOT_POWERON" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </receiver>`;

edit('app/src/main/AndroidManifest.xml', [
  [mainActivityOld, mainActivityNew, 'disable MainActivity in standalone bridge'],
  [kioskAliasOld, '', 'remove KioskHomeLauncher alias'],
  [rovingActivityOld, rovingActivityNew, 'make RovingBridgeActivity the sole launcher and USB receiver'],
  [bootReceiverOld, '', 'remove BootReceiver in standalone bridge'],
]);

console.log('Roving DSLR Bridge variant ready: com.photobooth4u.rovingbridge, version ' + name + ' (code ' + code + ')');
