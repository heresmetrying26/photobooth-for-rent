// Benchmark suite for 360 video booth rendering (desktop/lib/spin.mjs).
// Usage:
//   node desktop/scripts/bench-spin.mjs            (full 15s 4K30 benchmark)
//   node desktop/scripts/bench-spin.mjs --quick    (fast 3s 4K30 smoke benchmark)
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configure, findFfmpeg, probe, listFx, buildArgs } from '../lib/spin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const BUILD_DIR = join(DESKTOP_DIR, 'build');
const FX_DIR = existsSync(join(DESKTOP_DIR, 'resources', 'spin-fx'))
  ? join(DESKTOP_DIR, 'resources', 'spin-fx')
  : join(BUILD_DIR, 'spin-fx');
const WORK_DIR = join(tmpdir(), 'pb4u-bench-spin');

const quick = process.argv.includes('--quick');
const clipDur = quick ? 3 : 15;

configure({ buildDir: BUILD_DIR, temp: WORK_DIR, fxDir: FX_DIR });

const ff = await findFfmpeg();
if (!ff) {
  console.error('ERROR: ffmpeg binary not found.');
  process.exit(1);
}

mkdirSync(WORK_DIR, { recursive: true });
const clip = join(WORK_DIR, `clip4k_${clipDur}s.mp4`);

if (!existsSync(clip)) {
  console.log(`Generating synthetic ${clipDur}s 4K30 input clip...`);
  const g = spawnSync(ff, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=3840x2160:rate=30:duration=${clipDur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${clipDur}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', clip
  ], { encoding: 'utf8' });
  if (g.status !== 0) {
    console.error('Failed to generate test clip:', g.stderr.slice(-500));
    process.exit(1);
  }
}

const info = await probe(clip);
console.log(`Input clip: ${(statSync(clip).size / 1e6).toFixed(1)} MB | ${info.width}x${info.height} @ ${info.fps}fps | ${info.duration}s`);

const fxs = listFx();
const fxMp4 = fxs.find((f) => /\.mp4$/i.test(f.file || f.filename || '')) || fxs[0];
const fxWebm = fxs.find((f) => /\.webm$/i.test(f.file || f.filename || ''));
console.log(`FX samples: mp4=${fxMp4 ? fxMp4.id : 'none'}, webm=${fxWebm ? fxWebm.id : 'none'}\n`);

const cases = [
  ['normal 1080p', { speed: 'normal' }],
  ['slow 1080p', { speed: 'slow' }],
  ['slow+smooth 1080p', { speed: 'slow', smooth: true }],
  ['ramp 1080p', { speed: 'ramp' }],
  ['boomerang 720p', { speed: 'boomerang' }],
  ['custom 4 rates', { speed: 'custom', rates: [1, 0.5, 2, 1] }],
  ['custom 3 rates + smooth', { speed: 'custom', rates: [1, 0.25, 1], smooth: true }],
  ['slow + mp4 fx', { speed: 'slow', fx: fxMp4 && fxMp4.id }],
  ['slow + webm fx', { speed: 'slow', fx: fxWebm && fxWebm.id }]
];

console.log('Case'.padEnd(26) + 'Status  Time    OutDur  Size');
console.log('-'.repeat(58));

let failed = 0;
for (const [name, options] of cases) {
  const out = join(WORK_DIR, 'out.mp4');
  const built = buildArgs({
    input: clip,
    output: out,
    overlay: null,
    fx: options.fx,
    music: null,
    options: { ...options, audio: 'none' }
  }, info);

  const t0 = Date.now();
  const r = spawnSync(ff, built.args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const elapsed = (Date.now() - t0) / 1000;
  const ok = r.status === 0 && existsSync(out);
  if (!ok) failed++;

  const sizeStr = ok ? (statSync(out).size / 1e6).toFixed(1).padStart(5) + ' MB' : r.stderr.split('\n').slice(-2).join(' | ');
  console.log(
    `${name.padEnd(26)}${ok ? 'ok    ' : 'FAIL  '}${elapsed.toFixed(1).padStart(6)}s  ${built.duration.toFixed(1).padStart(5)}s  ${sizeStr}`
  );
  try { rmSync(out, { force: true }); } catch { /* ignore */ }
}

if (failed > 0) process.exit(1);

