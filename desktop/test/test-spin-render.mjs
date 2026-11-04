// Phase 0.2: Rendered-frame integration test for 360 video booth (spin.mjs).
// Renders a 2s synthetic clip with animated FX, static branding/text overlay, and audio,
// then inspects decoded pixel regions to verify no layer is blank or missing.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  configure,
  findFfmpeg,
  probe,
  buildArgs,
  saveOverlay,
  overlayPath,
  enqueue,
  jobInfo
} from '../lib/spin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const BUILD_DIR = join(DESKTOP_DIR, 'build');
const FX_DIR = existsSync(join(DESKTOP_DIR, 'resources', 'spin-fx'))
  ? join(DESKTOP_DIR, 'resources', 'spin-fx')
  : join(BUILD_DIR, 'spin-fx');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    failed++;
  } else {
    console.log('PASS: ' + msg);
  }
}

// Minimal pure-Node RGBA PNG encoder so we can build a crisp 1080x1920 overlay with known pixel bands.
function makeRgbaPng(width, height, drawPixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function readRegionAvgRgb(rawRgb, width, x0, y0, w, h) {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const idx = (y * width + x) * 3;
      rSum += rawRgb[idx];
      gSum += rawRgb[idx + 1];
      bSum += rawRgb[idx + 2];
      count++;
    }
  }
  return { r: rSum / count, g: gSum / count, b: bSum / count };
}

const testDir = join(tmpdir(), 'pb4u-test-render-' + Date.now());
mkdirSync(testDir, { recursive: true });

try {
  configure({ buildDir: BUILD_DIR, temp: testDir, fxDir: FX_DIR });
  const ff = await findFfmpeg();
  assert(Boolean(ff), 'Bundled or system ffmpeg is available');

  // 1. Generate a 2s synthetic source video (dark blue background #001848) + audio
  const inputClip = join(testDir, 'input_2s.mp4');
  const genIn = spawnSync(ff, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x001848:s=1080x1920:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', inputClip
  ], { encoding: 'utf8' });
  assert(genIn.status === 0 && existsSync(inputClip), 'Generated 2s synthetic input clip');

  // 2. Generate a synthetic MP4 FX loop with a bright white/yellow center block on pure black
  // so screen-blending noticeably brightens the center region of the frame.
  const fxLoop = join(testDir, 'fx_center_glow.mp4');
  const genFx = spawnSync(ff, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=540x960:r=30:d=2,drawbox=x=170:y=380:w=200:h=200:color=0xFFE040@1.0:t=fill',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    fxLoop
  ], { encoding: 'utf8' });
  assert(genFx.status === 0 && existsSync(fxLoop), 'Generated synthetic FX loop');

  // 3. Create a 1080x1920 transparent PNG overlay with:
  //    - Top branding header (y < 160): solid red (240, 20, 20, 255)
  //    - Bottom text/label band (y >= 1700): solid green (20, 220, 40, 255)
  //    - Middle: transparent (0, 0, 0, 0)
  const pngBytes = makeRgbaPng(1080, 1920, (x, y) => {
    if (y < 160) return [240, 20, 20, 255];
    if (y >= 1700) return [20, 220, 40, 255];
    return [0, 0, 0, 0];
  });
  const ovName = saveOverlay(pngBytes);
  const ovPath = overlayPath(ovName);
  assert(Boolean(ovName && ovPath && existsSync(ovPath)), 'saveOverlay() saved 1080x1920 RGBA overlay PNG');

  // 4. Render 2s clip with overlay + FX + original audio
  console.log('\n--- Test 1: Rendered Frame Layer Verification (Base + FX + Overlay/Text) ---');
  const info = await probe(inputClip);
  assert(info.width === 1080 && info.height === 1920 && Math.abs(info.duration - 2) < 0.2, 'probe() reads input dimensions and duration');

  const outMp4 = join(testDir, 'rendered_out.mp4');
  const built = buildArgs({
    input: inputClip,
    output: outMp4,
    overlay: ovPath,
    fx: { path: fxLoop, blend: 'screen', opacity: 0.9 },
    music: null,
    options: { speed: 'normal', orientation: 'portrait', quality: 1080, audio: 'original' }
  }, info);

  const renderRes = spawnSync(ff, built.args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert(renderRes.status === 0 && existsSync(outMp4), 'ffmpeg rendered output MP4 without error');

  const outInfo = await probe(outMp4);
  assert(outInfo.width === 1080 && outInfo.height === 1920, `Output dimensions are 1080x1920 (got ${outInfo.width}x${outInfo.height})`);
  assert(Math.abs(outInfo.duration - 2) < 0.25, `Output duration is ~2.0s (got ${outInfo.duration}s)`);
  assert(outInfo.hasAudio === true, 'Output preserves audio stream');

  // Decode a single frame at t=0.5s to raw RGB24 and verify each visual layer
  const rawFramePath = join(testDir, 'frame.rgb');
  const extRes = spawnSync(ff, [
    '-hide_banner', '-y',
    '-ss', '0.5', '-i', outMp4,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    rawFramePath
  ], { encoding: 'utf8' });
  assert(extRes.status === 0 && existsSync(rawFramePath), 'Extracted raw RGB24 frame at t=0.5s');

  const rawRgb = readFileSync(rawFramePath);
  assert(rawRgb.length === 1080 * 1920 * 3, 'Raw frame byte length matches 1080x1920x3');

  const topHeader = readRegionAvgRgb(rawRgb, 1080, 440, 40, 200, 80);
  const midBase = readRegionAvgRgb(rawRgb, 1080, 80, 400, 120, 120);
  const midFx = readRegionAvgRgb(rawRgb, 1080, 460, 880, 160, 160);
  const botTextBand = readRegionAvgRgb(rawRgb, 1080, 440, 1760, 200, 80);

  assert(topHeader.r > 180 && topHeader.g < 70 && topHeader.b < 70,
    `Top branding overlay rendered red (avg RGB: ${Math.round(topHeader.r)},${Math.round(topHeader.g)},${Math.round(topHeader.b)})`);
  assert(botTextBand.g > 160 && botTextBand.r < 70 && botTextBand.b < 80,
    `Bottom label/text overlay band rendered green (avg RGB: ${Math.round(botTextBand.r)},${Math.round(botTextBand.g)},${Math.round(botTextBand.b)})`);
  assert(midBase.b > 40 && midBase.r < 40,
    `Base video visible in un-occluded area (avg RGB: ${Math.round(midBase.r)},${Math.round(midBase.g)},${Math.round(midBase.b)})`);
  assert(midFx.r > 160 && midFx.g > 130,
    `Screen-blended FX layer visible in center (avg RGB: ${Math.round(midFx.r)},${Math.round(midFx.g)},${Math.round(midFx.b)})`);

  // 5. Test enqueue() + real catalog WebM alpha FX end-to-end
  console.log('\n--- Test 2: Job Queue End-to-End with Catalog WebM Alpha FX ---');
  const outDir = join(testDir, 'edited');
  const { id } = enqueue({
    inputPath: inputClip,
    outDir,
    label: 'phase0',
    overlay: ovPath,
    fx: 'confetti_multi',
    music: null,
    options: { speed: 'normal', orientation: 'portrait', quality: 720, audio: 'none' }
  });

  let job = jobInfo(id);
  const deadline = Date.now() + 30000;
  while (job && (job.state === 'queued' || job.state === 'running') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    job = jobInfo(id);
  }
  assert(job && job.state === 'done' && job.pct === 100, `Queued WebM FX job completed (state=${job && job.state}, error=${job && job.error})`);
  const editedFile = join(outDir, String(job.out || '').replace(/^edited\//, ''));
  assert(existsSync(editedFile), 'Edited MP4 file written to edited/ folder');
  const editedInfo = await probe(editedFile);
  assert(editedInfo.width === 720 && editedInfo.height === 1280, `720p output dimensions are 720x1280 (got ${editedInfo.width}x${editedInfo.height})`);
} finally {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failed > 0) {
  console.error('\n' + failed + ' rendered-frame test(s) failed!');
  process.exit(1);
} else {
  console.log('\nAll Phase 0.2 rendered-frame tests passed successfully!');
}

