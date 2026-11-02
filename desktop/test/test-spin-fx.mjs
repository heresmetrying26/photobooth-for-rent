// Test suite for Phase 1: 360 Animated Video Overlays & Particle Effects compositing
import { buildArgs, resolveFx, setFxDir, listFx, normOptions } from '../lib/spin.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    failed++;
  } else {
    console.log('PASS: ' + msg);
  }
}

const testDir = join(tmpdir(), 'pb4u-test-fx-' + Date.now());
mkdirSync(testDir, { recursive: true });

try {
  // Create dummy test assets
  const dummyInput = join(testDir, 'spin_in.mp4');
  const dummyOutput = join(testDir, 'spin_out.mp4');
  const dummyOverlay = join(testDir, 'branding.png');
  const dummyFxMp4 = join(testDir, 'gold_dust.mp4');
  const dummyFxWebm = join(testDir, 'confetti.webm');
  writeFileSync(dummyInput, 'fake video');
  writeFileSync(dummyOverlay, 'fake png');
  writeFileSync(dummyFxMp4, Buffer.alloc(2048));
  writeFileSync(dummyFxWebm, Buffer.alloc(2048));

  const fakeInfo = { duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true };

  console.log('\n--- Test 1: Standard BuildArgs (No FX) ---');
  {
    const r = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      overlay: dummyOverlay,
      options: { speed: 'slow', orientation: 'portrait' }
    }, fakeInfo);

    assert(r.W === 1080 && r.H === 1920, 'Dimensions are portrait 1080x1920');
    assert(r.duration === 20, 'Duration is 20s (slow-mo)');
    const filterArg = r.args[r.args.indexOf('-filter_complex') + 1];
    assert(!filterArg.includes('fx_fit'), 'No FX filter in graph');
    assert(filterArg.includes('[ov]overlay=0:0:format=auto[v1o]'), 'Static overlay is applied');
    assert(filterArg.includes('[v1o]format=yuv420p[vout]'), 'Output formatted to yuv420p');
  }

  console.log('\n--- Test 2: Screen Blend FX (.mp4) ---');
  {
    const r = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      overlay: dummyOverlay,
      fx: { path: dummyFxMp4, blend: 'screen', opacity: 0.9 },
      options: { speed: 'slow', orientation: 'portrait' }
    }, fakeInfo);

    const streamLoopIdx = r.args.indexOf('-stream_loop');
    assert(streamLoopIdx > 0 && r.args[streamLoopIdx + 1] === '-1', 'Stream loop -1 added for FX');
    assert(r.args[streamLoopIdx + 3] === dummyFxMp4, 'FX file added as input');

    const filterArg = r.args[r.args.indexOf('-filter_complex') + 1];
    assert(filterArg.includes('[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[fx_fit]'), 'FX is scaled/cropped to match output WxH');
    assert(filterArg.includes('format=gbrp[v_base]') && filterArg.includes('format=gbrp[fx_rgb]'), 'Converts to planar RGB (gbrp) before screen blend to prevent YUV pinkish tint');
    assert(filterArg.includes('blend=all_mode=screen:all_opacity=0.9:shortest=1[v_fx]'), 'Screen blend with 0.9 opacity applied');
    assert(filterArg.includes('[v_fx][ov]overlay=0:0:format=auto[v1o]'), 'Layer order: branding overlay sits on top of [v_fx]');
  }

  console.log('\n--- Test 3: Alpha Overlay FX (.webm) ---');
  {
    const r = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      overlay: null, // No branding overlay
      fx: { path: dummyFxWebm, blend: 'overlay', opacity: 0.8 },
      options: { speed: 'slow', orientation: 'landscape' }
    }, fakeInfo);

    assert(r.W === 1920 && r.H === 1080, 'Landscape dimensions 1920x1080');
    const loopIdx = r.args.indexOf('-stream_loop');
    assert(loopIdx > 0 && r.args[loopIdx + 2] === '-c:v' && r.args[loopIdx + 3] === 'libvpx-vp9', 'WebM input uses libvpx-vp9 decoder to decode alpha channel');
    const filterArg = r.args[r.args.indexOf('-filter_complex') + 1];
    assert(filterArg.includes('[fx_rgba]colorchannelmixer=aa=0.8[fx_alpha]'), 'Alpha channel opacity mixer applied');
    assert(filterArg.includes('[fx_alpha]overlay=0:0:format=auto:shortest=1[v_fx]'), 'Overlay filter applied');
    assert(filterArg.includes('[v_fx]format=yuv420p[vout]'), 'Layer directly formats to vout when no static overlay');
  }

  console.log('\n--- Test 4: Catalog & FX Resolution ---');
  {
    // Setup a mock catalog
    const loopsDir = join(testDir, 'loops');
    mkdirSync(loopsDir, { recursive: true });
    const sparklesFile = join(loopsDir, 'sparkles.mp4');
    writeFileSync(sparklesFile, Buffer.alloc(2048));

    const catalog = [
      { id: 'sparkles_gold', name: 'Golden Sparkles', category: 'VIP', file: 'sparkles.mp4', blend: 'screen', opacity: 0.95 }
    ];
    writeFileSync(join(testDir, 'catalog.json'), JSON.stringify(catalog));
    setFxDir(testDir);

    const list = listFx();
    assert(list.length === 1 && list[0].id === 'sparkles_gold', 'listFx reads catalog.json');

    const resolved = resolveFx('sparkles_gold');
    assert(resolved !== null, 'resolveFx found catalog item by ID');
    assert(resolved.blend === 'screen', 'Blend mode resolved correctly');
    assert(resolved.opacity === 0.95, 'Opacity resolved correctly');
    assert(resolved.path === sparklesFile, 'Resolved to correct file path in loops/');

    const nonExistent = resolveFx('not_a_real_effect');
    assert(nonExistent === null, 'Non-existent effect resolves to null safely');

    const none = resolveFx('none');
    assert(none === null, '"none" resolves to null');
  }

} finally {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failed > 0) {
  console.error('\n' + failed + ' test(s) failed!');
  process.exit(1);
} else {
  console.log('\nAll Phase 1 tests passed successfully!');
}

