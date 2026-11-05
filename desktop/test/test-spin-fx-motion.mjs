// Effects must actually MOVE in the rendered video.
//  1. every bundled effect loop is animated for the whole 3 s (the old generator froze them after a few frames)
//  2. the Trajectory / Size / Wobble / Location settings reach the ffmpeg graph and render without errors
//  3. a real render with an effect has frames that differ over time
//  4. a stale effect folder in the data directory is refreshed when this release has newer loops
import { buildArgs, setFxDir, normOptions, refreshUserFx, FX_MOTION, configure, saveFxBake, fxBakePath } from '../lib/spin.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FXDIR = join(HERE, '..', 'resources', 'spin-fx');
const FF = process.env.PB4U_FFMPEG || join(HERE, '..', 'build', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
let failed = 0;
const assert = (c, m) => { if (c) console.log('PASS: ' + m); else { console.error('FAIL: ' + m); failed++; } };
const haveFF = existsSync(FF);
if (!haveFF) console.log('NOTE: no ffmpeg at ' + FF + ' - render checks are skipped');
setFxDir(FXDIR);
const work = mkdtempSync(join(tmpdir(), 'pb4u-fxmotion-'));

// number of pixels whose visibility (alpha) or brightness changes between two frames of a decoded clip
function frames(file, w, h, vcodecIn) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (vcodecIn) args.push('-c:v', vcodecIn);
  args.push('-i', file, '-vf', `scale=${w}:${h}:flags=neighbor`, '-pix_fmt', 'rgba', '-f', 'rawvideo', '-');
  const r = spawnSync(FF, args, { maxBuffer: 1 << 28 });
  const fs = w * h * 4, n = Math.floor(r.stdout.length / fs);
  return { buf: r.stdout, n, fs };
}
function changed(fr, a, b) {
  let d = 0;
  for (let p = 0; p < fr.fs; p += 4) {
    const ia = a * fr.fs + p, ib = b * fr.fs + p;
    const la = fr.buf[ia + 3] > 16 ? fr.buf[ia] + fr.buf[ia + 1] + fr.buf[ia + 2] : 0;
    const lb = fr.buf[ib + 3] > 16 ? fr.buf[ib] + fr.buf[ib + 1] + fr.buf[ib + 2] : 0;
    if (Math.abs(la - lb) > 60) d++;
  }
  return d;
}

try {
  const catalog = JSON.parse(readFileSync(join(FXDIR, 'catalog.json'), 'utf8'));

  console.log('\n--- Test 1: every effect loop is animated (not a frozen picture) ---');
  if (haveFF) {
    const frozen = [];
    for (const item of catalog) {
      const file = join(FXDIR, 'loops', item.file);
      const fr = frames(file, 54, 96, /\.webm$/i.test(file) ? 'libvpx-vp9' : '');
      if (fr.n < 60) { frozen.push(item.id + ' (frames=' + fr.n + ')'); continue; }
      // compare three moments spread over the loop; a frozen loop is identical at all of them
      const a = changed(fr, 10, 40), b = changed(fr, 40, 70), c = changed(fr, 5, 80);
      if (Math.max(a, b, c) < 3) frozen.push(item.id);
    }
    assert(frozen.length === 0, 'All ' + catalog.length + ' effect loops move through the whole loop' + (frozen.length ? ' - frozen: ' + frozen.join(', ') : ''));
  }

  console.log('\n--- Test 2: Trajectory / Size / Wobble / Location are applied in the ffmpeg graph ---');
  {
    const info = { duration: 6, width: 1080, height: 1920, fps: 30, hasAudio: false };
    const g = (opts, fx = 'confetti_multi') => {
      const r = buildArgs({ input: 'in.mp4', output: 'out.mp4', options: { speed: 'plain', orientation: 'portrait', quality: 720, fx, ...opts } }, info);
      return r.args[r.args.indexOf('-filter_complex') + 1];
    };
    const base = g({});
    assert(!base.includes('fx_pre'), 'Default options keep the original effect graph unchanged');
    assert(g({ fxMovement: 'rise' }).includes('vflip'), 'Rising Float flips the layer so it rises');
    assert(g({ fxMovement: 'drift' }).includes('scroll=horizontal='), 'Wind Drift scrolls the layer sideways');
    assert(/rotate=a='[\d.]+\*t'/.test(g({ fxMovement: 'vortex' })), 'Vortex Orbit rotates the layer over time');
    assert(g({ fxMovement: 'burst' }).includes('mod(t,2.4)'), 'Radial Burst expands the layer in cycles');
    assert(g({ fxMovement: 'beat_pulse' }).includes('sin(t*4.4)'), 'Beat Pulse pulses the layer');
    assert(g({ fxScale: 200 }).includes('scale=iw*2:ih*2'), 'Size 2x zooms the layer');
    assert(g({ fxScale: 50 }).includes('hstack') && g({ fxScale: 50 }).includes('vstack'), 'Size 0.5x tiles smaller copies so the frame stays covered');
    assert(g({ fxWobble: 80 }).includes('sin(2*PI*0.35*t'), 'Wobble sways the layer');
    assert(g({ fxLocation: 'top' }).includes('crop=720:') && g({ fxLocation: 'top' }).includes('pad=720:1280:0:0'), 'Top half limits the effect to the top');
    assert(g({ fxLocation: 'edges' }).includes('drawbox='), 'Perimeter / Edges clears the centre');
    assert(!g({ fxMovement: 'vortex', fxWobble: 50 }, 'neon_cyberpunk').includes('fx_pre'), 'Frame-like effects (neon border) ignore the motion settings');
    const o = normOptions({ fxMovement: 'nonsense', fxScale: 9999, fxWobble: -5, fxLocation: 'x' });
    assert(o.fxMovement === 'none' && o.fxScale === 2.5 && o.fxWobble === 0 && o.fxLocation === 'full', 'Bad values are clamped to safe ones');
    assert(FX_MOTION.has('confetti_multi') && !FX_MOTION.has('fire_border'), 'Particle effects take the settings, border effects do not');
  }

  console.log('\n--- Test 3: a real render has a moving effect, for every Trajectory ---');
  if (haveFF) {
    const input = join(work, 'in.mp4');
    const mk = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1080x1920:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', input]);
    assert(mk.status === 0, 'Test clip created');
    const info = { duration: 4, width: 1080, height: 1920, fps: 30, hasAudio: false };
    for (const [fx, opts, label] of [
      ['confetti_multi', {}, 'default'],
      ['confetti_multi', { fxMovement: 'vortex', fxWobble: 50 }, 'vortex + wobble'],
      ['hearts_floating', { fxMovement: 'rise', fxScale: 150 }, 'rise + 1.5x size'],
      ['gold_dust', { fxMovement: 'drift', fxLocation: 'top' }, 'drift in the top half (screen blend)'],
      ['balloons_pastel', { fxMovement: 'burst', fxScale: 60, fxLocation: 'edges' }, 'burst, small size, edges'],
      ['fairy_dust', { fxMovement: 'beat_pulse', fxLocation: 'center', fxOpacity: 60 }, 'beat pulse, centre, 60% opacity']
    ]) {
      const out = join(work, 'out_' + fx + '_' + label.replace(/\W+/g, '_') + '.mp4');
      const b = buildArgs({ input, output: out, options: { speed: 'plain', orientation: 'portrait', quality: 720, audio: 'none', fx, ...opts } }, info);
      const r = spawnSync(FF, b.args.filter((a) => a !== 'pipe:1' && a !== '-progress'), { encoding: 'utf8', maxBuffer: 1 << 26 });
      const ok = r.status === 0 && existsSync(out);
      if (!ok) console.error(String(r.stderr).slice(-700));
      assert(ok, 'Renders (' + fx + ': ' + label + ')');
      if (ok) {
        const fr = frames(out, 90, 160, '');
        const best = Math.max(changed(fr, 20, 50), changed(fr, 50, 90), changed(fr, 10, 100));
        assert(best > 20, 'The effect moves in the render (' + fx + ': ' + label + ', ' + best + ' pixels changed)');
      }
    }
  }

  console.log('\n--- Test 4: a stale effect folder in the data directory is refreshed ---');
  {
    const bundled = join(work, 'bundled'), user = join(work, 'user');
    for (const d of [bundled, user]) { mkdirSync(join(d, 'loops', 'landscape'), { recursive: true }); mkdirSync(join(d, 'thumbs'), { recursive: true }); }
    writeFileSync(join(bundled, 'catalog.json'), JSON.stringify([{ id: 'a', file: 'a.mp4', thumb: 'a.webp' }]));
    writeFileSync(join(bundled, 'loops', 'a.mp4'), 'NEW-A'); writeFileSync(join(bundled, 'loops', 'landscape', 'a.mp4'), 'NEW-A-L'); writeFileSync(join(bundled, 'thumbs', 'a.webp'), 'NEW-T');
    writeFileSync(join(bundled, 'loops.version'), '2');
    writeFileSync(join(user, 'catalog.json'), JSON.stringify([{ id: 'a', file: 'a.mp4', thumb: 'a.webp' }, { id: 'mine', file: 'mine.mp4', thumb: 'mine.webp' }]));
    writeFileSync(join(user, 'loops', 'a.mp4'), 'OLD-A'); writeFileSync(join(user, 'loops', 'mine.mp4'), 'MY-OWN');
    assert(refreshUserFx(user, bundled) === true, 'Older data folder is refreshed');
    assert(readFileSync(join(user, 'loops', 'a.mp4'), 'utf8') === 'NEW-A' && readFileSync(join(user, 'loops', 'landscape', 'a.mp4'), 'utf8') === 'NEW-A-L', 'Built-in loops (and landscape variants) are replaced');
    assert(readFileSync(join(user, 'loops', 'mine.mp4'), 'utf8') === 'MY-OWN' && JSON.parse(readFileSync(join(user, 'catalog.json'), 'utf8')).some((c) => c.id === 'mine'), 'The operator’s own loop and catalog entry are kept');
    assert(refreshUserFx(user, bundled) === false, 'Not refreshed again once the version matches');
    assert(refreshUserFx(join(work, 'none'), bundled) === false, 'No data folder: nothing to do');
  }
  console.log('\n--- Test 5: the effect baked by the booth page (the live preview\'s own engine) is what the render lays over the clip ---');
  if (haveFF) {
    configure({ temp: join(work, 'temp'), fxDir: FXDIR });
    // stand-in for the page's frames: a red square that moves across a transparent picture, 2 s = 60 PNGs
    const pngDir = join(work, 'pngs'); mkdirSync(pngDir, { recursive: true });
    const mkPng = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black@0:s=360x640:r=30:d=2,format=rgba', '-f', 'lavfi', '-i', 'color=c=red:s=60x60:r=30:d=2,format=rgba',
      '-filter_complex', "[0:v][1:v]overlay=x='t*150':y=200:format=auto,format=rgba", '-start_number', '1', join(pngDir, 'p%04d.png')]);
    assert(mkPng.status === 0, 'Test frames created');
    const pngs = []; for (let i = 1; i <= 60; i++) pngs.push(readFileSync(join(pngDir, 'p' + String(i).padStart(4, '0') + '.png')));
    const parts = []; for (const p of pngs) { const h = Buffer.alloc(4); h.writeUInt32LE(p.length); parts.push(h, p); }
    const saved = saveFxBake(Buffer.concat(parts));
    assert(saved && saved.frames === 60 && fxBakePath(saved.token) && existsSync(join(fxBakePath(saved.token), 'f0060.png')), 'The page\'s frames are saved in a folder of their own');
    assert(fxBakePath('../../etc') === null && fxBakePath('pb4u-fxbake-1-1') === null, 'Only a folder this app made is accepted (never a path from the page)');
    assert(saveFxBake(Buffer.from([1, 2, 3])) === null, 'Garbage is refused');
    const input = join(work, 'in5.mp4');
    spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1080x1920:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', input]);
    const info = { duration: 4, width: 1080, height: 1920, fps: 30, hasAudio: false };
    const o5 = { speed: 'normal', orientation: 'portrait', quality: 720, audio: 'none', fx: 'confetti_multi', fxBakeDir: fxBakePath(saved.token) };
    const b = buildArgs({ input, output: join(work, 'out5.mp4'), options: o5 }, info);
    const gr = b.args[b.args.indexOf('-filter_complex') + 1];
    assert(b.args.join(' ').includes('f%04d.png') && !b.args.some((a) => /confetti_multi\.(webm|mp4)$/.test(a)), 'The baked frames replace the pre-made loop');
    assert(gr.includes('[fx_baked]') && !gr.includes('fx_pre') && !gr.includes('loop=loop'), 'No second motion is applied on top of the baked one');
    const nb = buildArgs({ input, output: 'x.mp4', options: { ...o5, fx: 'fire_border' } }, info);
    assert(!nb.args.join(' ').includes('f%04d.png'), 'Border / light effects ignore the baked frames (they keep their loop)');
    const nb2 = buildArgs({ input, output: 'x.mp4', options: { ...o5, fxBakeDir: join(work, 'nowhere') } }, info);
    assert(!nb2.args.join(' ').includes('f%04d.png') && nb2.args.some((a) => /confetti_multi\.(webm|mp4)$/.test(a)), 'No baked frames: falls back to the pre-made loop');
    const out = join(work, 'out5.mp4');
    const r = spawnSync(FF, b.args.filter((a) => a !== 'pipe:1' && a !== '-progress'), { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (!(r.status === 0 && existsSync(out))) console.error(String(r.stderr).slice(-700));
    assert(r.status === 0 && existsSync(out), 'Renders with the baked effect');
    if (r.status === 0) {
      const fr = frames(out, 90, 160, '');
      assert(fr.n >= 115, 'The 2 s of baked frames repeat to cover the whole 4 s clip (' + fr.n + ' frames)');
      // the square is at x = t*150 px of 360 px: find the red pixels in a few frames and check they travel, then start over once the baked frames repeat
      const redX = (i) => { let sx = 0, c = 0; for (let y = 0; y < 160; y++) for (let x = 0; x < 90; x++) { const p = i * fr.fs + (y * 90 + x) * 4; if (fr.buf[p] > 200 && fr.buf[p + 1] < 80 && fr.buf[p + 2] < 80) { sx += x; c++; } } return c > 4 ? sx / c : -1; };
      const x5 = redX(5), x25 = redX(25), x50 = redX(50);
      assert(x5 >= 0 && x25 > x5 + 5 && x50 > x25 + 5, 'The baked effect travels across the render (x: ' + [x5, x25, x50].map((v) => Math.round(v)).join(' -> ') + ')');
      assert(redX(65) >= 0 && redX(65) < x25, 'Past the baked length it starts over instead of freezing');
    }
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failed > 0) { console.error('\n' + failed + ' test(s) failed!'); process.exit(1); }
console.log('\nAll effect-motion tests passed successfully!');
