import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as SPIN from '../lib/spin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, 'fixtures-spin-print');
mkdirSync(testDir, { recursive: true });

SPIN.configure({
  buildDir: join(__dirname, '..', 'build'),
  temp: join(testDir, 'temp'),
  fxDir: join(__dirname, '..', 'resources', 'spin-fx')
});

function log(msg) { console.log(msg); }
function pass(msg) { console.log('PASS: ' + msg); }

async function runCommand(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: 'pipe' });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  log('--- Spin & Print Frame Extraction Test Suite ---');

  const bin = await SPIN.findFfmpeg();
  assert.ok(bin, 'FFmpeg binary must be available');
  pass('Found FFmpeg binary');

  // Create a 3-second synthetic test video
  const testVideo = join(testDir, 'synth_spin.mp4');
  await runCommand(bin, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30',
    '-t', '3', '-pix_fmt', 'yuv420p', testVideo
  ]);
  assert.ok(existsSync(testVideo), 'Synthetic video created');
  pass('Created synthetic 3-second 1080x1920 portrait video');

  // Test 1: Single hero frame extraction (Solo / Keychain)
  log('\n--- Test 1: Extract 1 hero frame at 50% ---');
  const single = await SPIN.extractFrames({ inputPath: testVideo, times: [1.5] });
  assert.equal(single.length, 1, 'Extracted exactly 1 frame');
  assert.ok(single[0].startsWith('data:image/jpeg;base64,'), 'Frame is a valid JPEG data URL');
  assert.ok(single[0].length > 1000, 'Frame payload contains image data');
  pass('Extracted 1 hero frame as valid JPEG base64');

  // Test 2: Multi-angle sequence extraction (3-shot strip at 25%, 50%, 75%)
  log('\n--- Test 2: Extract 3 sequential frames for photo strip ---');
  const multi = await SPIN.extractFrames({ inputPath: testVideo, times: [0.75, 1.5, 2.25] });
  assert.equal(multi.length, 3, 'Extracted exactly 3 sequential frames');
  multi.forEach((frame, i) => {
    assert.ok(frame.startsWith('data:image/jpeg;base64,'), `Frame ${i + 1} is valid JPEG data URL`);
    assert.ok(frame.length > 1000, `Frame ${i + 1} has valid payload`);
  });
  pass('Extracted 3 sequential frames for multi-angle photo strip / keychain');

  // Cleanup
  try { unlinkSync(testVideo); } catch {}
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  log('\nAll Spin & Print frame extraction tests passed successfully!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
