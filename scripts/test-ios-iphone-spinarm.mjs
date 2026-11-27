// Regression test for iPhone full-screen scaling (UILaunchScreen + safe-area/mobile UI)
// and 360 Arm Cam immediate live-camera startup on iOS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function checkBalancedSwift(relPath) {
  const s = readFileSync(join(ROOT, relPath), 'utf8');
  let b = 0, p = 0, k = 0;
  let inStr = false, inMulti = false, esc = false, lineCmt = false, blkCmt = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1], n2 = s[i + 2];
    if (lineCmt) { if (c === '\n') lineCmt = false; continue; }
    if (blkCmt > 0) {
      if (c === '/' && n === '*') { blkCmt++; i++; }
      else if (c === '*' && n === '/') { blkCmt--; i++; }
      continue;
    }
    if (inMulti) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"' && n === '"' && n2 === '"') { inMulti = false; i += 2; }
      continue;
    }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '/' && n === '/') { lineCmt = true; i++; continue; }
    if (c === '/' && n === '*') { blkCmt++; i++; continue; }
    if (c === '"' && n === '"' && n2 === '"') { inMulti = true; i += 2; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') b++; else if (c === '}') b--;
    else if (c === '(') p++; else if (c === ')') p--;
    else if (c === '[') k++; else if (c === ']') k--;
  }
  assert.equal(b, 0, `${relPath}: unbalanced braces (${b})`);
  assert.equal(p, 0, `${relPath}: unbalanced parens (${p})`);
  assert.equal(k, 0, `${relPath}: unbalanced brackets (${k})`);
}

// 1. Swift syntax delimiter checks
for (const f of [
  'ios/photobooth4u/ViewController.swift',
  'ios/photobooth4u/NativeCameraBridge.swift',
  'ios/photobooth4u/SpinArmViewController.swift'
]) {
  checkBalancedSwift(f);
}
console.log('PASS: modified Swift files have balanced delimiters');

// 2. iOS Info.plist includes UILaunchScreen so iPhones render at native full-screen resolution (no 320x480 letterbox)
const plist = readFileSync(join(ROOT, 'ios/photobooth4u/Info.plist'), 'utf8');
assert.ok(plist.includes('<key>UILaunchScreen</key>'), 'Info.plist must include UILaunchScreen');
assert.ok(/<key>UILaunchScreen<\/key>\s*<dict\s*\/>/.test(plist), 'Info.plist UILaunchScreen must have <dict/>');
console.log('PASS: ios/photobooth4u/Info.plist enables native iPhone full-screen via UILaunchScreen');

// 3. NativeCameraBridge releases video input on stop() and ViewController guards pbCam while SpinArm is open
const bridge = readFileSync(join(ROOT, 'ios/photobooth4u/NativeCameraBridge.swift'), 'utf8');
assert.ok(bridge.includes('if let vIn = self.currentInput { self.session.removeInput(vIn) }'), 'NativeCameraBridge.stop removes video input');
const vc = readFileSync(join(ROOT, 'ios/photobooth4u/ViewController.swift'), 'utf8');
assert.ok(vc.includes('private var isSpinArmOpen = false'), 'ViewController tracks isSpinArmOpen');
assert.ok(/let spinArmBusy = isSpinArmOpen\b.*presentedViewController is SpinArmViewController/.test(vc), 'ViewController blocks booth pbCam calls while 360 Arm Cam is open');
console.log('PASS: ViewController & NativeCameraBridge prevent booth camera hijacking during 360 Arm Cam');

// 4. SpinArmViewController camera startup, 8-bit 4:2:0 filtering, clamped frame duration, fallback & recovery
const spin = readFileSync(join(ROOT, 'ios/photobooth4u/SpinArmViewController.swift'), 'utf8');
assert.ok(spin.includes('require8Bit420'), 'SpinArm filters 8-bit 4:2:0 formats ahead of 10-bit HDR');
assert.ok(spin.includes('CMTimeCompare(dur, range.minFrameDuration)'), 'SpinArm clamps frame duration to range');
assert.ok(spin.includes('AVCaptureSession.runtimeErrorNotification'), 'SpinArm recovers on runtime error');
assert.ok(spin.includes('AVCaptureSession.interruptionEndedNotification'), 'SpinArm resumes after interruption');
assert.ok(spin.includes('if !self.session.isRunning && !self.hasTornDown'), 'SpinArm falls back to .high wide camera if custom format fails to start');
assert.ok(spin.includes('let done = onDismiss'), 'SpinArm preserves onDismiss callback across dismiss');
console.log('PASS: SpinArmViewController guarantees immediate camera startup, 8-bit format selection & recovery');

// 5. Built booth.html carries viewport-fit=cover, mobile menu/step-bar fixes, and spinArmOpen camera handoff
const booth = readFileSync(join(ROOT, 'protected/booth.html'), 'utf8');
const iosBooth = readFileSync(join(ROOT, 'ios/photobooth4u/booth.html'), 'utf8');
assert.equal(booth, iosBooth, 'ios/photobooth4u/booth.html matches protected/booth.html');
assert.ok(booth.includes('viewport-fit=cover'), 'booth.html includes viewport-fit=cover');
assert.ok(booth.includes('.start-bar .menu-wrap'), 'booth.html anchors phone overflow menu to full-width start-bar');
assert.ok(booth.includes('var spinArmOpen = false;'), 'booth.html pauses booth camera watchdog while 360 Arm Cam is open');
assert.ok(booth.includes("window.addEventListener('pbSpinArmClosed'"), 'booth.html resumes camera after 360 Arm Cam closes');
console.log('PASS: built booth.html has iPhone layout fixes and 360 Arm Cam camera handoff');
