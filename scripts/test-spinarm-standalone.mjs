// Verification suite for standalone "360 Arm Cam" iOS & Android apps + slot-free "-360" license logic.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log('PASS:', name);
  passed++;
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function checkBalancedDelimiters(src, label) {
  const stack = [];
  const pairs = { '}': '{', ')': '(', ']': '[' };
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\n') { line++; i++; continue; }
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Double-quoted string (supports Swift \(...) nested interpolation)
    if (ch === '"') {
      i++;
      let interpDepth = 0;
      while (i < src.length) {
        const c = src[i];
        if (c === '\n') line++;
        if (interpDepth === 0) {
          if (c === '\\') {
            if (src[i + 1] === '(') { interpDepth = 1; i += 2; continue; }
            i += 2;
            continue;
          }
          if (c === '"') { i++; break; }
          i++;
        } else {
          if (c === '(') interpDepth++;
          else if (c === ')') interpDepth--;
          else if (c === '"') {
            // Nested string inside Swift \(...)
            i++;
            while (i < src.length) {
              if (src[i] === '\\') { i += 2; continue; }
              if (src[i] === '"') { i++; break; }
              i++;
            }
            continue;
          }
          i++;
        }
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      stack.push({ ch, line });
    } else if (pairs[ch]) {
      const top = stack.pop();
      assert.ok(top && top.ch === pairs[ch], `${label}:${line}: unbalanced '${ch}' (top=${top ? top.ch + '@' + top.line : 'empty'})`);
    }
    i++;
  }
  assert.equal(stack.length, 0, `${label}: unclosed delimiters: ${stack.map((x) => `${x.ch}@${x.line}`).join(', ')}`);
}

// 1. Server -360 slot-free parsing & signing
await test('parseSpin360Code parses -360 suffix variants and preserves regular codes', async () => {
  const { parseSpin360Code } = await import('../netlify/lib/license.mjs');
  assert.deepEqual(parseSpin360Code('PB-ABCD-EFGH-JKLM-360'), { isSpin360Suffix: true, baseCode: 'PB-ABCD-EFGH-JKLM' });
  assert.deepEqual(parseSpin360Code('pb-abcd-efgh-jklm - 360 '), { isSpin360Suffix: true, baseCode: 'pb-abcd-efgh-jklm' });
  assert.deepEqual(parseSpin360Code('PBABCDEFGHJKLM360'), { isSpin360Suffix: true, baseCode: 'PBABCDEFGHJKLM' });
  assert.deepEqual(parseSpin360Code('TESTCODE-360'), { isSpin360Suffix: true, baseCode: 'TESTCODE' });
  assert.deepEqual(parseSpin360Code('PB-ABCD-EFGH-JKLM'), { isSpin360Suffix: false, baseCode: 'PB-ABCD-EFGH-JKLM' });
  assert.deepEqual(parseSpin360Code('TRIAL'), { isSpin360Suffix: false, baseCode: 'TRIAL' });
});

await test('spin360CompanionLicence signs valid Ed25519 360-only licence with 0 device slots', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  process.env.PB_LICENSE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const { spin360CompanionLicence, readLicence, verifyDesktopAppAuth } = await import('../netlify/lib/license.mjs');
  const now = Date.now();
  const rec = {
    key: 'PBABCDEFGHJKLM',
    code: 'PB-ABCD-EFGH-JKLM',
    label: 'Bride & Groom',
    status: 'active',
    lifetime: true,
    expiresAt: 253402300799000,
    maxDevices: 1,
    devices: [{ id: 'app:existing1', no: 1, at: now - 1000, app: { lid: 'aaaaaaaaaaaaaaaaaaaa', mid: 'IPAD-1111-2222-3333' } }],
    extras: { spin360: true }
  };
  const beforeDevices = JSON.stringify(rec.devices);
  const issued = spin360CompanionLicence(rec.key, rec, {
    mid: 'IOS-AAAA-BBBB-CCCC-DDDD',
    name: 'iPhone 15 Pro Max',
    os: 'ios',
    ver: '1.0.0'
  }, now, false);

  assert.match(issued.lid, /^[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(rec.devices), beforeDevices, 'rec.devices must remain untouched');

  const p = readLicence(issued.licence);
  assert.ok(p, 'Ed25519 signature must verify');
  assert.equal(p.typ, 'pb4u-desktop');
  assert.equal(p.mid, 'IOS-AAAA-BBBB-CCCC-DDDD');
  assert.equal(p.feat.spin360Only, true);
  assert.equal(p.feat.extras.spin360, true);
  assert.equal(p.feat.deviceNo, 0);
  assert.ok(p.code.endsWith('-360'), 'masked code must end in -360');

  // Regular cloud endpoints using verifyDesktopAppAuth must reject spin360Only licences
  const auth = await verifyDesktopAppAuth({ licence: issued.licence, mid: p.mid });
  assert.equal(auth.ok, false);
  assert.equal(auth.status, 401);
});

await test('netlify/functions/license.mjs enforces automatic 0-slot standalone activation (plain code or -360) and live checkin', () => {
  const src = read('netlify/functions/license.mjs');
  assert.match(src, /parseSpin360Code\(b\.code\)/);
  assert.match(src, /if \(isSpin360Suffix && !isSpin360App\)/);
  assert.match(src, /if \(isSpin360App\) \{[\s\S]*if \(!extrasOf\(rec\)\.spin360\) return json\(\{ error: NO_SPIN360/);
  assert.match(src, /spin360CompanionLicence\(key, rec,/);
  assert.match(src, /if \(p\.feat && p\.feat\.spin360Only\)/);
  assert.match(src, /await dropMap\(p\.lid\);\s*return json\(\{ ok: true, slotFree: true \}\);/);
});

await test('regular booth apps reject spin360Only licences across Desktop, iOS, and Android', () => {
  assert.match(read('desktop/lib/licence.mjs'), /p\.feat && p\.feat\.spin360Only/);
  assert.match(read('ios/photobooth4u/AppLicence.swift'), /#if !SPINARM_STANDALONE[\s\S]*spin360Only/);
  assert.match(read('android/app/src/main/java/com/photobooth4u/booth/AppLicence.kt'), /ctx\.packageName == "com\.photobooth4u\.spinarm"[\s\S]*spin360Only/);
});

// 2. Icon & iOS asset catalog verification
await test('360 Arm Cam master icon and iOS AppIcon.appiconset are opaque RGB PNGs with dark charcoal palette', () => {
  const pyCheck = `
import json
from pathlib import Path
from PIL import Image

root = Path(${JSON.stringify(ROOT)})
master = Image.open(root / 'android/resources/spinarm_icon_source.png')
assert master.size == (1024, 1024), f'Bad master size {master.size}'
assert master.mode == 'RGB', f'Master icon must be opaque RGB, got {master.mode}'
corner = master.getpixel((8, 8))
assert corner == (0x1C, 0x1A, 0x1E), f'Expected charcoal #1C1A1E background, got {corner}'

appicon = root / 'ios/spinarm/Assets.xcassets/AppIcon.appiconset'
data = json.loads((appicon / 'Contents.json').read_text())
assert len(data['images']) >= 18
for entry in data['images']:
    p = appicon / entry['filename']
    assert p.exists(), f'Missing {p}'
    im = Image.open(p)
    assert im.mode == 'RGB', f'{p.name} must be opaque RGB, got {im.mode}'
    w = float(entry['size'].split('x')[0]) * int(entry['scale'].replace('x', ''))
    assert im.size == (int(round(w)), int(round(w))), f'{p.name}: expected {int(round(w))}, got {im.size}'
print('ICON_OK')
`;
  const out = execFileSync('python', ['-c', pyCheck], { encoding: 'utf8' });
  assert.match(out, /ICON_OK/);
});

// 3. iOS SpinArm360 target & Swift checks
await test('iOS SpinArm360 target, scheme, Info.plist, and Swift files are valid and well-formed', () => {
  const plist = read('ios/spinarm/Info.plist');
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>360 Arm Cam<\/string>/);
  assert.match(plist, /<key>UILaunchScreen<\/key>\s*<dict\/>/);
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSMotionUsageDescription/);
  assert.match(plist, /\$\(PRODUCT_MODULE_NAME\)\.SpinArmSceneDelegate/);

  const scheme = read('ios/photobooth4u.xcodeproj/xcshareddata/xcschemes/SpinArm360.xcscheme');
  assert.match(scheme, /BlueprintIdentifier = "500300012CE8000100000001"/);
  assert.match(scheme, /BuildableName = "SpinArm360\.app"/);

  const pbx = read('ios/photobooth4u.xcodeproj/project.pbxproj');
  checkBalancedDelimiters(pbx, 'project.pbxproj');
  assert.match(pbx, /500300012CE8000100000001 \/\* SpinArm360 \*\//);
  assert.match(pbx, /PRODUCT_BUNDLE_IDENTIFIER = com\.photobooth4u\.spinarm;/);
  assert.match(pbx, /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "SPINARM_STANDALONE";/);
  assert.match(pbx, /INFOPLIST_FILE = spinarm\/Info\.plist;/);
  assert.match(pbx, /100300012CE8000100000012 \/\* Assets\.xcassets in Resources \*\//);

  for (const rel of [
    'ios/spinarm/SpinArmAppDelegate.swift',
    'ios/spinarm/SpinArmSceneDelegate.swift',
    'ios/spinarm/SpinArmGateViewController.swift',
    'ios/photobooth4u/SpinArmViewController.swift',
    'ios/photobooth4u/SpinQuickShareViewController.swift',
    'ios/photobooth4u/AppLicence.swift',
  ]) {
    checkBalancedDelimiters(read(rel), rel);
  }
  assert.match(read('ios/spinarm/SpinArmGateViewController.swift'), /spin360Companion:\s*true/);
  assert.match(read('.github/workflows/spinarm-ios.yml'), /-scheme SpinArm360/);
  assert.match(read('.github/workflows/spinarm-ios.yml'), /photobooth4u-360-arm-cam-ios\.ipa/);
});

// 4. Android SpinArm variant + Roving compatibility dry-run
await test('Android make-spinarm-variant.mjs and make-roving-variant.mjs both patch cleanly', () => {
  checkBalancedDelimiters(read('android/app/src/main/java/com/photobooth4u/booth/SpinArmGateActivity.kt'), 'SpinArmGateActivity.kt');
  checkBalancedDelimiters(read('android/app/src/main/java/com/photobooth4u/booth/SpinArmActivity.kt'), 'SpinArmActivity.kt');
  checkBalancedDelimiters(read('android/app/src/main/java/com/photobooth4u/booth/SpinQuickShareActivity.kt'), 'SpinQuickShareActivity.kt');
  checkBalancedDelimiters(read('android/app/src/main/java/com/photobooth4u/booth/AppLicence.kt'), 'AppLicence.kt');
  assert.match(read('android/app/src/main/java/com/photobooth4u/booth/SpinArmGateActivity.kt'), /spin360Companion\s*=\s*true/);

  const copyAndroidSkeleton = (dest) => {
    mkdirSync(join(dest, 'app/src/main/res/values'), { recursive: true });
    copyFileSync(join(ROOT, 'android/app/build.gradle'), join(dest, 'app/build.gradle'));
    copyFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), join(dest, 'app/src/main/AndroidManifest.xml'));
    copyFileSync(join(ROOT, 'android/app/src/main/res/values/strings.xml'), join(dest, 'app/src/main/res/values/strings.xml'));
    copyFileSync(join(ROOT, 'android/app/src/main/res/values/colors.xml'), join(dest, 'app/src/main/res/values/colors.xml'));
  };

  const tmpSpin = mkdtempSync(join(tmpdir(), 'pb-spinarm-'));
  const tmpRov = mkdtempSync(join(tmpdir(), 'pb-roving-'));
  try {
    copyAndroidSkeleton(tmpSpin);
    execFileSync(process.execPath, [join(ROOT, 'android/scripts/make-spinarm-variant.mjs'), tmpSpin], {
      env: { ...process.env, SPINARM_VERSION_CODE: '7', SPINARM_VERSION_NAME: 'spinarm-android-v1.0.0' },
      stdio: 'pipe'
    });
    const gradle = readFileSync(join(tmpSpin, 'app/build.gradle'), 'utf8');
    const strings = readFileSync(join(tmpSpin, 'app/src/main/res/values/strings.xml'), 'utf8');
    const colors = readFileSync(join(tmpSpin, 'app/src/main/res/values/colors.xml'), 'utf8');
    const manifest = readFileSync(join(tmpSpin, 'app/src/main/AndroidManifest.xml'), 'utf8');

    assert.match(gradle, /applicationId "com\.photobooth4u\.spinarm"/);
    assert.match(gradle, /versionCode 7/);
    assert.match(gradle, /versionName "1\.0\.0"/);
    assert.match(strings, /<string name="app_name">360 Arm Cam<\/string>/);
    assert.match(colors, /<color name="ic_launcher_background">#1C1A1E<\/color>/);
    assert.match(manifest, /android:name="\.SpinArmGateActivity"[\s\S]*android:exported="true"[\s\S]*android\.intent\.category\.LAUNCHER/);
    assert.match(manifest, /android:name="\.MainActivity"\s+android:exported="false"\s+android:enabled="false"/);
    assert.doesNotMatch(manifest, /KioskHomeLauncher/);
    assert.doesNotMatch(manifest, /BootReceiver/);

    // Verify Roving variant script still succeeds cleanly after our AndroidManifest edit!
    copyAndroidSkeleton(tmpRov);
    execFileSync(process.execPath, [join(ROOT, 'android/scripts/make-roving-variant.mjs'), tmpRov], {
      env: { ...process.env, ROVING_VERSION_CODE: '9', ROVING_VERSION_NAME: 'roving-v1.0.5' },
      stdio: 'pipe'
    });
    assert.match(readFileSync(join(tmpRov, 'app/build.gradle'), 'utf8'), /applicationId "com\.photobooth4u\.rovingbridge"/);
  } finally {
    rmSync(tmpSpin, { recursive: true, force: true });
    rmSync(tmpRov, { recursive: true, force: true });
  }
});

// 8. Calibration gate & first-open calibration intro parity (iOS & Android)
await test('360 Arm Cam trigger stays unset until calibrated/enabled and shows first-open calibration intro (iOS & Android)', () => {
  const swift = read('ios/photobooth4u/SpinArmViewController.swift');
  const kt = read('android/app/src/main/java/com/photobooth4u/booth/SpinArmActivity.kt');
  checkBalancedDelimiters(swift, 'SpinArmViewController.swift');
  checkBalancedDelimiters(kt, 'SpinArmActivity.kt');

  // Defaults to manual (Auto-Spin OFF) & uncalibrated threshold
  assert.match(swift, /private var saTrigger: String = "manual"/);
  assert.match(swift, /private var isThresholdCalibrated: Bool = false/);
  assert.match(swift, /guard isThresholdCalibrated, !isPairingScan, !isSettingsOpen, !isQuickSharePresented, stationOverlay\.isHidden, calIntroOverlay\.isHidden, armConfig\.trigger == "arm"/);
  assert.match(swift, /Trigger: Not set/);
  assert.match(swift, /buildCalibrationIntroOverlay\(\)/);
  assert.match(swift, /showCalibrationIntroIfNeeded\(\)/);
  assert.match(swift, /didTapStartCalFromIntro/);
  assert.match(swift, /didTapSkipCalIntro/);
  assert.match(swift, /Calibrate 360 Arm First/);

  assert.match(kt, /private var saTrigger: String = "manual"/);
  assert.match(kt, /private var isThresholdCalibrated: Boolean = false/);
  assert.match(kt, /if \(!isThresholdCalibrated \|\| isSettingsOpen \|\| stationOverlay\.visibility == View\.VISIBLE \|\| calIntroOverlay\.visibility == View\.VISIBLE \|\| armConfig\.trigger != "arm"\)/);
  assert.match(kt, /Trigger: Not set/);
  assert.match(kt, /buildCalibrationIntroOverlay\(root\)/);
  assert.match(kt, /showCalibrationIntroIfNeeded\(\)/);
  assert.match(kt, /Calibrate 360 Arm First/);
});

console.log(`\nALL ${passed} STANDALONE 360 ARM CAM CHECKS PASSED!`);
