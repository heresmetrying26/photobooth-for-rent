// Phase 3 Test Suite: Square Format 1:1, Landscape FX Loop Mapping, Extra Text Overlay, and Generator
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as SPIN from '../lib/spin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, 'fixtures-phase3');
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
  log('--- Phase 3 Test Suite: Square 1:1, Landscape FX Mapping, Text Overlay & Generator ---');

  // --- Test 1: Square Format (Item 3.5) ---
  log('\n--- Test 1: Square Format (1080x1080 & 720x720) in normOptions and buildArgs ---');
  const sq1080 = SPIN.normOptions({ orientation: 'square', quality: 1080 });
  assert.equal(sq1080.W, 1080, 'Square 1080p width is 1080');
  assert.equal(sq1080.H, 1080, 'Square 1080p height is 1080');
  assert.equal(sq1080.square, true, 'Square flag is true');
  assert.equal(sq1080.orientation, 'square', 'Orientation is square');
  pass('normOptions correctly computes 1080x1080 for square format');

  const sq720 = SPIN.normOptions({ orientation: 'square', quality: 720 });
  assert.equal(sq720.W, 720, 'Square 720p width is 720');
  assert.equal(sq720.H, 720, 'Square 720p height is 720');
  pass('normOptions correctly computes 720x720 for square format');

  const sqArgs = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    options: { orientation: 'square', speed: 'normal', quality: 1080 }
  }, { duration: 5, fps: 30 });

  const sqFit = 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,setsar=1';
  assert.ok(sqArgs.args.join(' ').includes(sqFit), 'Scale-first filter centers and crops 1:1 square');
  pass('buildArgs builds scale-first crop filter for 1080x1080 square format');

  // --- Test 2: Landscape FX Loop Mapping (Item 3.2) ---
  log('\n--- Test 2: Landscape FX Loop Mapping (Native vs Fallback) ---');
  
  // A. Native landscape loop resolution
  const landResolved = SPIN.resolveFx('confetti_gold', 'landscape');
  assert.ok(landResolved, 'Confetti gold resolves in landscape');
  assert.equal(landResolved.isLandscape, true, 'isLandscape flag is true for landscape loop');
  assert.ok(landResolved.path.includes('landscape'), 'Points to landscape loop path');
  pass('resolveFx successfully locates native landscape loop when available');

  const nativeLandArgs = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    options: { orientation: 'landscape', speed: 'normal', fx: 'confetti_gold' }
  }, { duration: 5, fps: 30 });
  const nativeFit = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080';
  assert.ok(nativeLandArgs.args.join(' ').includes(nativeFit), 'Native landscape loop uses 1920x1080 direct fit');
  pass('buildArgs uses direct 1920x1080 fit when native landscape loop is present');

  // B. Fallback portrait loop on landscape output (Aspect-ratio preserving pad instead of 3.56x zoom)
  const portraitOnLandArgs = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    options: { orientation: 'landscape', speed: 'normal' },
    fx: { id: 'custom_portrait', path: join(__dirname, '..', 'resources', 'spin-fx', 'loops', 'confetti_multi.webm'), blend: 'overlay', opacity: 1, isLandscape: false }
  }, { duration: 5, fps: 30 });
  
  const padFilter = 'scale=-1:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
  assert.ok(portraitOnLandArgs.args.join(' ').includes(padFilter), 'Portrait loop mapped to landscape scales to height and pads/centers instead of 3.56x zoom');
  pass('buildArgs scales-to-height and centers portrait loop on landscape without 3.56x particle crop');

  // --- Test 3: Extra Text Overlay & Fade In/Out (Item 3.4) ---
  log('\n--- Test 3: Extra Text Overlay & Fade Timing ---');
  const dummyTextOverlay = join(testDir, 'text-overlay.png');
  writeFileSync(dummyTextOverlay, Buffer.alloc(100));

  // A. Fade mode
  const fadeArgs = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    textOverlay: dummyTextOverlay,
    options: { speed: 'normal', textTiming: 'fade', textFadeIn: 0.8, textFadeOut: 0.8 }
  }, { duration: 6, fps: 30 });

  const fadeFilter = 'fade=in:st=0.3:d=0.8:alpha=1,fade=out:';
  assert.ok(fadeArgs.args.join(' ').includes(fadeFilter), 'Fade-in and fade-out filters applied to text overlay');
  assert.ok(fadeArgs.args.join(' ').includes('overlay=0:0:format=auto[v_txt]'), 'Text overlay combined onto video chain');
  pass('buildArgs generates smooth alpha fade-in and fade-out for timed text overlay');

  // B. Always mode (discrete overlay stream)
  const alwaysArgs = SPIN.buildArgs({
    input: 'test.mp4',
    output: 'out.mp4',
    textOverlay: dummyTextOverlay,
    options: { speed: 'normal', textTiming: 'always' }
  }, { duration: 6, fps: 30 });
  assert.ok(alwaysArgs.args.join(' ').includes('[txt_raw]overlay=0:0:format=auto[v_txt]'), 'Direct overlay applied in always mode');
  pass('buildArgs applies direct overlay for text overlay');

  // --- Test 4: End-to-End Rendering of Square 1:1 Video (Item 3.5) ---
  log('\n--- Test 4: Real Render of Square 1:1 Format (1080x1080) with Text and FX ---');
  const bin = await SPIN.findFfmpeg();
  assert.ok(bin, 'FFmpeg binary found');

  const synthInput = join(testDir, 'synth_input.mp4');
  await runCommand(bin, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', synthInput
  ]);
  assert.ok(existsSync(synthInput), 'Generated 1080x1920 synthetic video');

  const synthOverlay = join(testDir, 'synth_overlay.png');
  // Simple PNG overlay
  await runCommand(bin, [
    '-y', '-f', 'lavfi', '-i', 'color=c=red@0.8:size=1080x1080,format=rgba',
    '-vframes', '1', synthOverlay
  ]);

  const squareOut = join(testDir, 'square_output.mp4');
  const sqJobArgs = SPIN.buildArgs({
    input: synthInput,
    output: squareOut,
    overlay: synthOverlay,
    fx: 'confetti_gold',
    options: { orientation: 'square', speed: 'slow', quality: 1080, audio: 'original' }
  }, { duration: 2, fps: 30, hasAudio: true });

  const renderRes = await runCommand(bin, sqJobArgs.args);
  assert.equal(renderRes.code, 0, 'FFmpeg rendered square video with code 0: ' + renderRes.stderr);
  assert.ok(existsSync(squareOut), 'Square output MP4 created');

  const info = await SPIN.probe(squareOut);
  assert.equal(info.width, 1080, 'Output width is exactly 1080');
  assert.equal(info.height, 1080, 'Output height is exactly 1080');
  pass('Rendered video is verified exactly 1080x1080 (1:1 aspect ratio)');

  // Clean up
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}

  log('\nAll Phase 3 tests passed successfully!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
