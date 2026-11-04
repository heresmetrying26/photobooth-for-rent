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
    assert(r.args.includes(dummyFxMp4), 'FX file added as input');

    const filterArg = r.args[r.args.indexOf('-filter_complex') + 1];
    assert(filterArg.includes('[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[fx_fit]'), 'FX is scaled/cropped to match output WxH');
    assert(filterArg.includes('format=gbrp[v_base]') && filterArg.includes('[fx_fit]format=gbrp,loop=loop=-1:size=300:start=0,setpts=N/(30*TB)[fx_rgb]'), 'Converts to planar RGB (gbrp) and loops pre-formatted FX frames in memory');
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
    const vpxIdx = r.args.indexOf('libvpx-vp9');
    assert(vpxIdx > 0 && r.args[vpxIdx - 1] === '-c:v' && r.args[vpxIdx + 2] === dummyFxWebm, 'WebM input uses libvpx-vp9 decoder to decode alpha channel');
    const filterArg = r.args[r.args.indexOf('-filter_complex') + 1];
    assert(filterArg.includes('[fx_rgba]colorchannelmixer=aa=0.8,format=yuva420p,loop=loop=-1:size=300:start=0,setpts=N/(30*TB)[fx_alpha]'), 'Alpha channel opacity mixer + yuva420p in-memory loop applied');
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

  console.log('\n--- Test 5: Speed Modes, Filter Chain Structure & Audio Modes (Phase 0.3) ---');
  console.log('\n--- Test 5: Phase 1 Speed Modes, Scale-First Order, High-FPS Slow-Mo, Audio & GPU ---');
  {
    const dummyMusic = join(testDir, 'track.mp3');
    writeFileSync(dummyMusic, Buffer.alloc(1024));

    const slowSmooth = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'slow', smooth: true, orientation: 'portrait', audio: 'original' }
    }, fakeInfo);
    const fgSlow = slowSmooth.args[slowSmooth.args.indexOf('-filter_complex') + 1];
    assert(fgSlow.includes('minterpolate=fps=60:mi_mode=blend'), 'Slow+smooth includes minterpolate');
    assert(fgSlow.includes('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1'), 'Slow+smooth includes portrait fit filter');
    assert(fgSlow.includes('minterpolate=fps=60:mi_mode=blend'), 'Slow+smooth (30fps input) includes minterpolate');
    assert(fgSlow.indexOf('scale=1080:1920') < fgSlow.indexOf('minterpolate=fps=60'), '1.1: Scale/crop runs BEFORE minterpolate');
    assert(fgSlow.includes('[0:a]atempo=0.5[aout]'), 'Original audio in slow mode applies atempo=0.5');

    // 1.2: 60fps source skips minterpolate automatically in slow mode
    const slowSmooth60 = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'slow', smooth: true, orientation: 'portrait', audio: 'original' }
    }, { ...fakeInfo, fps: 60 });
    const fgSlow60 = slowSmooth60.args[slowSmooth60.args.indexOf('-filter_complex') + 1];
    assert(!fgSlow60.includes('minterpolate'), '1.2: 60fps input automatically skips minterpolate for real slow-mo');

    const ramp = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      music: dummyMusic,
      options: { speed: 'ramp', orientation: 'portrait', audio: 'music', volume: 0.75 }
    }, fakeInfo);
    const fgRamp = ramp.args[ramp.args.indexOf('-filter_complex') + 1];
    assert(ramp.duration === 12.5, 'Ramp duration is 1.25x input (12.5s)');
    assert(fgRamp.indexOf('scale=1080:1920') < fgRamp.indexOf('split=3[a][b][c]'), '1.1: Scale/crop runs BEFORE split=3 in ramp mode');
    assert(fgRamp.includes('split=3[a][b][c]') && fgRamp.includes('concat=n=3:v=1:a=0'), 'Ramp splits into 3 segments and concats');
    assert(fgRamp.includes('volume=0.75,afade=t=in:st=0:d=0.6'), 'Music audio includes volume and fade-in');

    // 1.6: Original audio in ramp mode
    const rampOrigAudio = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'ramp', orientation: 'portrait', audio: 'original' }
    }, fakeInfo);
    const fgRampOrig = rampOrigAudio.args[rampOrigAudio.args.indexOf('-filter_complex') + 1];
    assert(fgRampOrig.includes('[0:a]asplit=3[aa][ab][ac]') && fgRampOrig.includes('concat=n=3:v=0:a=1[aout]'), '1.6: Original audio in ramp mode splits, retimes, and concats');

    const boom = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'boomerang', orientation: 'portrait', audio: 'none' }
    }, fakeInfo);
    const fgBoom = boom.args[boom.args.indexOf('-filter_complex') + 1];
    assert(boom.W === 720 && boom.H === 1280, 'Boomerang auto-caps to 720p (720x1280)');
    assert(boom.duration === 10, 'Boomerang caps at 5s forward + 5s reverse = 10s');
    assert(fgBoom.indexOf('scale=720:1280') < fgBoom.indexOf('split[a][b]'), '1.1: Scale/crop runs BEFORE split in boomerang mode');
    assert(fgBoom.includes('reverse[r]') && fgBoom.includes('[a][r]concat=n=2:v=1:a=0'), 'Boomerang reverses and concats');
    assert(boom.args.includes('-an'), 'Audio none passes -an');

    // 1.6: Original audio in boomerang mode
    const boomOrigAudio = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'boomerang', orientation: 'portrait', audio: 'original' }
    }, fakeInfo);
    const fgBoomOrig = boomOrigAudio.args[boomOrigAudio.args.indexOf('-filter_complex') + 1];
    assert(fgBoomOrig.includes('areverse[ar]') && fgBoomOrig.includes('[aa][ar]concat=n=2:v=0:a=1[aout]'), '1.6: Original audio in boomerang mode reverses and concats');

    // 1.1 + 1.6: Custom multi-rate + reverse + 0.25x audio + scale-first
    const customRev = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'custom', rates: [1, 0.25, 2], reverse: true, smooth: true, orientation: 'portrait', audio: 'original' }
    }, { ...fakeInfo, duration: 6 });
    const fgCust = customRev.args[customRev.args.indexOf('-filter_complex') + 1];
    assert(customRev.W === 720 && customRev.H === 1280, 'Custom+reverse auto-caps to 720p');
    assert(fgCust.indexOf('scale=720:1280') < fgCust.indexOf('minterpolate=fps=60'), '1.1: Scale/crop runs BEFORE minterpolate and split in custom mode');
    assert(fgCust.includes('split=3[s0][s1][s2]') && fgCust.includes('reverse') && fgCust.includes('[a][r]concat=n=2:v=1:a=0[v0]'), 'Custom multi-rate + reverse splits and reverses');
    assert(fgCust.includes('atempo=0.5,atempo=0.5') && fgCust.includes('areverse[ar]'), '1.6: Custom 0.25x + reverse chains atempo=0.5,atempo=0.5 and areverse');

    // 1.7: Dynamic zoom & optical beat flash
    const slowZoomFlash = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'slow', orientation: 'portrait', zoom: true, flash: true }
    }, fakeInfo);
    const fgSlowZF = slowZoomFlash.args[slowZoomFlash.args.indexOf('-filter_complex') + 1];
    assert(fgSlowZF.includes('eval=frame') && fgSlowZF.includes('crop=1080:1920'), 'Slow-mo includes dynamic camera punch-in zoom');
    assert(fgSlowZF.includes('drawbox=x=0:y=0:w=in_w:h=in_h:color=white@0.65'), 'Slow-mo includes beat drop optical white flash');

    // Zoom and flash can be disabled cleanly
    const noZF = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      options: { speed: 'slow', orientation: 'portrait', zoom: false, flash: false }
    }, fakeInfo);
    const fgNoZF = noZF.args[noZF.args.indexOf('-filter_complex') + 1];
    assert(!fgNoZF.includes('eval=frame'), 'Zoom is omitted when disabled');
    assert(!fgNoZF.includes('drawbox=x=0:y=0'), 'Flash is omitted when disabled');

    // 1.5: Hardware encoder option
    const gpuArgs = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      hwEncoder: 'h264_nvenc',
      options: { speed: 'normal', orientation: 'portrait', gpu: true }
    }, fakeInfo);
    assert(gpuArgs.args.includes('h264_nvenc'), '1.5: hwEncoder=h264_nvenc emits -c:v h264_nvenc');
  }

  console.log('\n--- Test 6: Square 1:1 Aspect Ratio (Instagram format) ---');
  {
    const sq = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      overlay: dummyOverlay,
      options: { speed: 'slow', orientation: 'square', quality: 1080 }
    }, fakeInfo);
    assert(sq.W === 1080 && sq.H === 1080, 'Square dimensions are 1080x1080');
    const fgSq = sq.args[sq.args.indexOf('-filter_complex') + 1];
    assert(fgSq.includes('scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080'), 'Scales and center-crops into 1:1 square');
  }

  console.log('\n--- Test 7: Custom Animated FX Speed, Opacity & Physics Multipliers ---');
  {
    const customFx = buildArgs({
      input: dummyInput,
      output: dummyOutput,
      fx: { path: dummyFxMp4, blend: 'screen', opacity: 0.9 },
      options: { speed: 'slow', orientation: 'square', fxSpeed: 1.5, fxOpacity: 0.55 }
    }, fakeInfo);
    assert(customFx.W === 1080 && customFx.H === 1080, 'Custom FX in square format has 1080x1080');
    const fgCustom = customFx.args[customFx.args.indexOf('-filter_complex') + 1];
    assert(fgCustom.includes('setpts=N/(30*TB*1.5'), 'FX loop setpts incorporates 1.5x speed');
    assert(fgCustom.includes('blend=all_mode=screen:all_opacity=0.55'), 'FX screen blend incorporates custom 0.55 opacity');
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

