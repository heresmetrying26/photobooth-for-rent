import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as SPIN from '../lib/spin.mjs';
import { initPhotos, setSpinDir, spinList, setWallCue, getWallCue } from '../lib/photos.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, 'fixtures-360-improvements');
mkdirSync(testDir, { recursive: true });

function log(msg) { console.log(msg); }
function pass(msg) { console.log('  PASS: ' + msg); }

async function main() {
  log('====================================================');
  log('  360 Booth Advanced Improvements Test Suite');
  log('====================================================\n');

  // ----------------------------------------------------
  // TEST 1: Beat-Drop Sync Speed Ramping & Custom dropTime
  // ----------------------------------------------------
  log('Test 1: Beat-Drop Sync Speed Ramping (dropTime logic)');
  const norm1 = SPIN.normOptions({ speed: 'ramp', dropTime: 3.5 });
  assert.equal(norm1.speed, 'ramp');
  assert.equal(norm1.dropTime, 3.5, 'dropTime normalized properly');

  // Verify buildArgs places the speed transition at dropTime = 2.5s
  const dur = 10;
  const res1 = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    options: SPIN.normOptions({ speed: 'ramp', dropTime: 2.5 }),
    hasMusic: false
  }, { duration: dur, fps: 30 });
  const args1 = res1.args;
  const filterGraph = args1.find((a, i) => args1[i - 1] === '-filter_complex');
  assert.ok(filterGraph, 'Filter complex is generated');
  assert.ok(filterGraph.includes('2.5'), 'Custom dropTime 2.5s is injected into ramp timeline');
  assert.ok(filterGraph.includes('drawbox') || filterGraph.includes('colorchannelmixer') || filterGraph.includes('scale') || filterGraph.includes('crop'), 'Ramp visual effects generated');
  pass('Custom dropTime successfully directs speed ramp transitions and optical beats');

  // ----------------------------------------------------
  // TEST 2: Cinematic 3D LUT Color Grading Engine
  // ----------------------------------------------------
  log('\nTest 2: Cinematic 3D LUT Color Engine (Color grading filters)');
  const luts = ['glam_bw', 'teal_orange', 'golden_hour', 'vibrant', 'vintage', 'none'];
  for (const lutName of luts) {
    const opt = SPIN.normOptions({ speed: 'slow', lut: lutName });
    assert.equal(opt.lut, lutName, `LUT ${lutName} is recognized`);

    const res = SPIN.buildArgs({
      input: 'test.mp4',
      output: 'out.mp4',
      options: opt,
      hasMusic: false
    }, { duration: 5, fps: 30 });
    const args = res.args;
    const fg = args.find((a, i) => args[i - 1] === '-filter_complex');
    if (lutName === 'glam_bw') {
      assert.ok(fg.includes('colorchannelmixer=.3:.4:.3'), 'Glamour B&W color filter applied');
    } else if (lutName === 'teal_orange') {
      assert.ok(fg.includes('curves=r=') && fg.includes('b='), 'Teal & Orange curve grading applied');
    } else if (lutName === 'golden_hour') {
      assert.ok(fg.includes('curves=r=') && fg.includes('gamma=1.04'), 'Golden Hour color filter applied');
    } else if (lutName === 'vibrant') {
      assert.ok(fg.includes('eq=saturation=1.38'), 'Vibrant Pop saturation boost applied');
    } else if (lutName === 'vintage') {
      assert.ok(fg.includes('eq=saturation=0.88'), 'Vintage Film tone curves applied');
    }
    pass(`LUT preset "${lutName}" generates deterministic FFmpeg filters`);
  }

  // ----------------------------------------------------
  // TEST 3: Smart Inbox Watcher (File Stability Guard)
  // ----------------------------------------------------
  log('\nTest 3: Smart Inbox Watcher (Guards incomplete/slow file writes)');
  const inboxDir = join(testDir, 'spin-inbox');
  mkdirSync(inboxDir, { recursive: true });
  initPhotos({ root: testDir, dataDir: testDir });
  setSpinDir(inboxDir);

  // File A: Ready, complete file (> 10KB, old mtime)
  const readyFile = join(inboxDir, 'ready_spin.mp4');
  writeFileSync(readyFile, Buffer.alloc(25000, 1));

  // File B: Actively writing file (size < 10KB or fresh mtime)
  const partialFile = join(inboxDir, 'partial_upload.mp4');
  writeFileSync(partialFile, Buffer.alloc(500, 0)); // 500 bytes (too small)

  // File C: Incomplete temporary download file
  const tmpFile = join(inboxDir, 'recording.mp4.tmp');
  writeFileSync(tmpFile, Buffer.alloc(30000, 0));

  // File D: Incomplete part file
  const partFile = join(inboxDir, 'transfer.part');
  writeFileSync(partFile, Buffer.alloc(50000, 0));

  const list = spinList({ minAgeMs: 0 }); // test size and extension filtering
  const names = list.map(x => x.name);
  assert.ok(names.includes('ready_spin.mp4'), 'Complete video file is listed');
  assert.ok(!names.includes('partial_upload.mp4'), 'Incomplete <10KB file is filtered out');
  assert.ok(!names.includes('recording.mp4.tmp'), '.tmp file is filtered out');
  assert.ok(!names.includes('transfer.part'), '.part file is filtered out');
  pass('Smart Inbox Watcher accurately rejects partial/temporary files');

  // Test age settling guard
  const freshFile = join(inboxDir, 'fresh_transfer.mp4');
  writeFileSync(freshFile, Buffer.alloc(20000, 1));
  // minAgeMs = 5000ms: file written just now should be held back
  const listAgeGuard = spinList({ minAgeMs: 5000 });
  const namesAgeGuard = listAgeGuard.map(x => x.name);
  assert.ok(!namesAgeGuard.includes('fresh_transfer.mp4'), 'Freshly writing file held back until settling');
  pass('Smart Inbox Watcher holds actively written files until write settling');

  // ----------------------------------------------------
  // TEST 4: Live TV Audience Sync (setWallCue & getWallCue)
  // ----------------------------------------------------
  log('\nTest 4: Live TV Audience Sync (Real-time Crowd Countdown & Replay Cues)');
  setWallCue('countdown', '3', 3000);
  let cue = getWallCue();
  assert.equal(cue.action, 'countdown');
  assert.equal(cue.text, '3');
  assert.ok(cue.expiresAt > Date.now());
  pass('Countdown cue initialized');

  setWallCue('countdown', 'JUMP! 🎬', 2000);
  cue = getWallCue();
  assert.equal(cue.action, 'countdown');
  assert.equal(cue.text, 'JUMP! 🎬');
  pass('Pose / Jump climax cue set');

  setWallCue('celebrate', '✨ FRESH OFF THE 360! ✨', 5000);
  cue = getWallCue();
  assert.equal(cue.action, 'celebrate');
  assert.equal(cue.text, '✨ FRESH OFF THE 360! ✨');
  pass('Celebration replay badge cue set');

  // Test cue expiration (min duration is 500ms to avoid screen flicker)
  setWallCue('countdown', '1', 500);
  await new Promise(r => setTimeout(r, 600));
  const expiredCue = getWallCue();
  assert.equal(expiredCue.action, 'idle', 'Expired cue automatically reverts to idle');
  pass('Expired crowd cues automatically revert to idle');

  // Cleanup test fixtures
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}

  log('\n====================================================');
  log('  ALL 360 IMPROVEMENTS TESTS PASSED SUCCESSFULLY! ✅');
  log('====================================================');
}

main().catch(err => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
