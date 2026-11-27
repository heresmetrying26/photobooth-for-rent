// Turns the Android booth project into the standalone "360 Arm Cam" app, in the CI checkout only (see .github/workflows/spinarm-android.yml).
// The booth's own build files are never changed in git, so a mistake here cannot affect booth releases.
//
// The 360 Arm Cam app is a dedicated standalone 360 Booth & Arm Camera app:
//   - its own app id (com.photobooth4u.spinarm) and name ("360 Arm Cam"), so it installs beside photobooth4u
//   - its own dark charcoal / vermilion / cream 360 icon (android/resources/spinarm_icon_source.png)
//   - opens into SpinArmGateActivity (Activation screen supporting slot-free <CODE>-360 + free Laptop 360 Desk companion)
//   - once activated, opens straight into SpinArmActivity live camera immediately on every launch
//
// Usage: node android/scripts/make-spinarm-variant.mjs [androidProjectDir]      env: SPINARM_VERSION_CODE, SPINARM_VERSION_NAME
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const code = Math.max(1, parseInt(process.env.SPINARM_VERSION_CODE || '1', 10) || 1);
const nameRaw = String(process.env.SPINARM_VERSION_NAME || '').replace(/^spinarm-android-v/, '');
const name = /^[0-9][0-9A-Za-z.\-]*$/.test(nameRaw) ? nameRaw : '1.0.0';

function edit(rel, pairs) {
  const f = join(ROOT, rel);
  let s = readFileSync(f, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  for (const [a, b, why] of pairs) {
    const from = typeof a === 'string' ? a.replace(/\n/g, nl) : a;
    const hits = typeof from === 'string' ? s.split(from).length - 1 : (s.match(new RegExp(from.source, 'g')) || []).length;
    if (hits !== 1) {
      console.error('SpinArm variant: ' + rel + ' — expected exactly 1 match for ' + why + ', found ' + hits + '. Update android/scripts/make-spinarm-variant.mjs.');
      process.exit(1);
    }
    s = typeof from === 'string' ? s.replace(from, () => b.replace(/\n/g, nl)) : s.replace(from, () => b);
  }
  writeFileSync(f, s);
  console.log('patched ' + rel);
}

edit('app/build.gradle', [
  ['applicationId "com.photobooth4u.booth"', 'applicationId "com.photobooth4u.spinarm"', 'the application id'],
  [/versionCode \d+/, 'versionCode ' + code, 'versionCode'],
  [/versionName "[^"]*"/, 'versionName "' + name + '"', 'versionName'],
]);

edit('app/src/main/res/values/strings.xml', [
  ['<string name="app_name">photobooth4u</string>', '<string name="app_name">360 Arm Cam</string>', 'the app name'],
]);

edit('app/src/main/res/values/colors.xml', [
  [/<color name="ic_launcher_background">[^<]*<\/color>/, '<color name="ic_launcher_background">#1C1A1E</color>', 'the adaptive icon background color'],
]);

// Configure AndroidManifest so SpinArmGateActivity is the sole MAIN/LAUNCHER activity,
// and disable MainActivity / kiosk home / boot receiver so the phone stays normal outside 360 Arm Cam.
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

const spinGateOld = `        <!-- Standalone 360 Arm Cam Activation Gate (only launcher in the standalone 360 Arm Cam variant) -->
        <activity
            android:name=".SpinArmGateActivity"
            android:exported="false"
            android:launchMode="singleTask"
            android:label="360 Arm Cam"
            android:icon="@mipmap/ic_launcher"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"
            android:screenOrientation="unspecified"
            android:windowSoftInputMode="adjustResize" />`;

const spinGateNew = `        <!-- Standalone 360 Arm Cam Activation Gate: sole launcher in standalone 360 Arm Cam app -->
        <activity
            android:name=".SpinArmGateActivity"
            android:exported="true"
            android:launchMode="singleTask"
            android:label="360 Arm Cam"
            android:icon="@mipmap/ic_launcher"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"
            android:screenOrientation="unspecified"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
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
  [mainActivityOld, mainActivityNew, 'disable MainActivity in standalone 360 Arm Cam'],
  [kioskAliasOld, '', 'remove KioskHomeLauncher alias'],
  [spinGateOld, spinGateNew, 'make SpinArmGateActivity the sole launcher'],
  [bootReceiverOld, '', 'remove BootReceiver in standalone 360 Arm Cam'],
]);

console.log('360 Arm Cam variant ready: com.photobooth4u.spinarm, version ' + name + ' (code ' + code + ')');
