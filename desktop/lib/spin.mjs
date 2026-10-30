// 360 videos: editing with ffmpeg.
//
// ffmpeg is a separate program shipped with the app (see resources/ffmpeg-NOTICE.txt); we only run it.
// A clip from the 360 camera goes in; an MP4 for phones comes out: trimmed, re-timed (slow motion, speed
// ramp, boomerang), cropped to portrait or landscape, with the event's frame / logo / title drawn over it
// (a transparent PNG made by the booth page) and optional music. Jobs run one at a time.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
let candidates = [], resolved = undefined, tempDir = null;

// buildDir: where prepare.mjs put build/ffmpeg (inside app.asar.unpacked when packaged).
export function configure({ buildDir, temp }) {
  tempDir = temp || null;
  candidates = [];
  if (process.env.PB4U_FFMPEG) candidates.push(process.env.PB4U_FFMPEG);
  if (buildDir) {
    candidates.push(join(buildDir.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked'), 'ffmpeg', EXE));
    candidates.push(join(buildDir, 'ffmpeg', EXE));
  }
  try { const p = createRequire(import.meta.url)('ffmpeg-static'); if (p) candidates.push(p); } catch { /* not installed */ }
  candidates.push('ffmpeg');           // one the laptop already has
  resolved = undefined;
}

function run(bin, args, { timeout = 0, onStdout, onProc } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timer = null;
    let p;
    try { p = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out, err: String(e) }); }
    if (onProc) onProc(p);
    const end = (code) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ code, out, err }); };
    p.stdout.on('data', (d) => { const t = d.toString(); out += t; if (onStdout) onStdout(t); if (out.length > 200000) out = out.slice(-100000); });
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', (e) => end(-1, (err += String(e))));
    p.on('close', (code) => end(code == null ? -1 : code));
    if (timeout) timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } end(-2); }, timeout);
  });
}

// The first ffmpeg that actually starts. Cached.
export async function findFfmpeg() {
  if (resolved !== undefined) return resolved;
  for (const c of candidates) {
    if (c !== 'ffmpeg' && !existsSync(c)) continue;
    const r = await run(c, ['-version'], { timeout: 8000 });
    if (r.code === 0 && /ffmpeg version/i.test(r.out)) { resolved = c; return resolved; }
  }
  resolved = null;
  return null;
}
export const hasFfmpeg = async () => !!(await findFfmpeg());

// ---------- reading a clip ----------
export function parseProbe(text) {
  const t = String(text || '');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const vline = (t.split('\n').find((l) => /Stream #.*Video:/.test(l) && !/attached pic/i.test(l))) || '';
  const size = /,\s*(\d{2,5})x(\d{2,5})[\s,\[]/.exec(vline);
  let width = size ? Number(size[1]) : 0, height = size ? Number(size[2]) : 0;
  const fps = /([\d.]+)\s*fps/.exec(vline);
  const rot = /rotat\w*(?: of|:)?\s*(-?\d+(?:\.\d+)?)/i.exec(t);
  const rotation = rot ? Math.round(Number(rot[1])) : 0;
  if (Math.abs(rotation) % 180 === 90) { const w = width; width = height; height = w; }   // ffmpeg turns it upright by itself
  return { duration, width, height, fps: fps ? Number(fps[1]) : 0, rotation, hasAudio: /Stream #.*Audio:/.test(t) };
}
// The last "time=00:00:07.52" ffmpeg printed while decoding.
export function durationFromProgress(text) {
  const all = [...String(text || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}
export async function probe(file) {
  const bin = await findFfmpeg(); if (!bin) throw new Error('Video editing is not available on this laptop.');
  const r = await run(bin, ['-hide_banner', '-i', file], { timeout: 20000 });
  const info = parseProbe(r.err);
  if (!info.duration) {
    // A clip recorded in a browser (WebM) has no length in its header: decode it once to find out.
    const d = await run(bin, ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 120000 });
    info.duration = durationFromProgress(d.err);
    if (!info.width) Object.assign(info, { ...parseProbe(d.err), duration: info.duration });
  }
  if (!info.duration) throw new Error('Could not read that video.');
  return info;
}

// ---------- the ffmpeg command ----------
export const SPEEDS = ['normal', 'slow', 'ramp', 'boomerang', 'custom'];
const REVERSE_MAX = 8;                       // a sequence up to twice this many seconds can also play backwards (held in memory)
const BOOMERANG_MAX = 5;                     // seconds of the clip that go forward then back (it is held in memory)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f2 = (n) => (Math.round(n * 1000) / 1000).toString();

export function normOptions(o) {
  o = o || {};
  const speed = SPEEDS.includes(o.speed) ? o.speed : 'slow';
  const q = o.quality === 720 || speed === 'boomerang' || (speed === 'custom' && o.reverse) ? 720 : 1080;      // boomerang and backwards are kept at 720 to stay light
  const short = q, long = Math.round(q * 16 / 9 / 2) * 2;
  const landscape = o.orientation === 'landscape';
  return {
    speed, smooth: !!o.smooth, landscape,
    // custom: the clip is cut in equal parts and each part plays at its own rate (0.25x to 4x); reverse adds the whole thing backwards
    rates: speed === 'custom' ? (Array.isArray(o.rates) ? o.rates : []).map(Number).filter((r) => r >= 0.25 && r <= 4).slice(0, 6) : [],
    reverse: speed === 'custom' && !!o.reverse,
    W: landscape ? long : short, H: landscape ? short : long,
    trimStart: clamp(Number(o.trimStart) || 0, 0, 3600),
    trimEnd: o.trimEnd == null || o.trimEnd === '' ? null : Math.max(0, Number(o.trimEnd) || 0),
    audio: ['music', 'original', 'none'].includes(o.audio) ? o.audio : 'music',
    volume: clamp(o.volume == null ? 0.8 : Number(o.volume), 0, 1)
  };
}
// How long the finished video is.
export function outDuration(speed, d, o) {
  if (speed === 'custom') {
    const rates = o && o.rates && o.rates.length ? o.rates : [1];
    const once = rates.reduce((t, r) => t + (d / rates.length) / r, 0);
    return o && o.reverse ? once * 2 : once;
  }
  if (speed === 'slow') return d * 2;
  if (speed === 'ramp') return d * 1.25;
  if (speed === 'boomerang') return Math.min(d, BOOMERANG_MAX) * 2;
  return d;
}
// { args, duration, W, H } for one clip. overlay / music are file paths or null.
export function buildArgs({ input, output, overlay, music, options }, info) {
  const o = normOptions(options);
  const end = o.trimEnd != null && o.trimEnd > o.trimStart ? Math.min(o.trimEnd, info.duration) : info.duration;
  const D = Math.max(0.5, end - o.trimStart);
  if (o.speed === 'custom' && !o.rates.length) o.rates = [1];
  // Playing backwards holds the whole sequence in memory: only for a short one.
  if (o.speed === 'custom' && o.reverse && outDuration('custom', D, { ...o, reverse: false }) > REVERSE_MAX * 2) o.reverse = false;
  const dur = outDuration(o.speed, D, o);
  const a = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  a.push('-ss', f2(o.trimStart), '-t', f2(D), '-i', input);
  let idx = 1, ovIdx = -1, muIdx = -1;
  if (overlay) { a.push('-i', overlay); ovIdx = idx++; }
  const useMusic = o.audio === 'music' && !!music;
  if (useMusic) { a.push('-stream_loop', '-1', '-i', music); muIdx = idx++; }

  const fit = 'scale=' + o.W + ':' + o.H + ':force_original_aspect_ratio=increase,crop=' + o.W + ':' + o.H + ',setsar=1';
  const f = [];
  let src = '[0:v]';
  if (o.speed === 'slow') {
    f.push(src + (o.smooth ? 'minterpolate=fps=60:mi_mode=blend,' : '') + 'setpts=2.0*PTS,fps=30,' + fit + '[v0]');
  } else if (o.speed === 'ramp') {
    const t1 = f2(D * 0.25), t2 = f2(D * 0.75);
    f.push(src + 'split=3[a][b][c]');
    f.push('[a]trim=0:' + t1 + ',setpts=(PTS-STARTPTS)/2[v1]');
    f.push('[b]trim=' + t1 + ':' + t2 + ',setpts=(PTS-STARTPTS)*2[v2]');
    f.push('[c]trim=' + t2 + ',setpts=(PTS-STARTPTS)/2[v3]');
    f.push('[v1][v2][v3]concat=n=3:v=1:a=0,fps=30,' + fit + '[v0]');
  } else if (o.speed === 'custom') {
    const n = o.rates.length, part = D / n;
    const pre = o.smooth && o.rates.some((r) => r < 1) ? 'minterpolate=fps=60:mi_mode=blend,' : '';
    if (n === 1) {
      f.push(src + pre + 'setpts=' + f2(1 / o.rates[0]) + '*PTS,fps=30,' + fit + (o.reverse ? ',split[a][b]' : '[v0]'));
    } else {
      f.push(src + pre + 'split=' + n + o.rates.map((r, i) => '[s' + i + ']').join(''));
      o.rates.forEach((r, i) => f.push('[s' + i + ']trim=' + f2(i * part) + ':' + f2((i + 1) * part) + ',setpts=(PTS-STARTPTS)/' + f2(r) + '[p' + i + ']'));
      f.push(o.rates.map((r, i) => '[p' + i + ']').join('') + 'concat=n=' + n + ':v=1:a=0,fps=30,' + fit + (o.reverse ? ',split[a][b]' : '[v0]'));
    }
    if (o.reverse) { f.push('[b]reverse[r]'); f.push('[a][r]concat=n=2:v=1:a=0[v0]'); }
  } else if (o.speed === 'boomerang') {
    const Db = f2(Math.min(D, BOOMERANG_MAX));
    f.push(src + 'trim=0:' + Db + ',setpts=PTS-STARTPTS,fps=30,' + fit + ',split[a][b]');
    f.push('[b]reverse[r]');
    f.push('[a][r]concat=n=2:v=1:a=0[v0]');
  } else {
    f.push(src + 'fps=30,' + fit + '[v0]');
  }
  let last = '[v0]';
  if (ovIdx >= 0) {
    f.push('[' + ovIdx + ':v]scale=' + o.W + ':' + o.H + ',format=rgba[ov]');
    f.push(last + '[ov]overlay=0:0:format=auto[v1o]');
    last = '[v1o]';
  }
  f.push(last + 'format=yuv420p[vout]');

  let audioMap = [];
  if (useMusic) {
    const fadeOut = Math.max(0, dur - 1.2);
    f.push('[' + muIdx + ':a]atrim=0:' + f2(dur) + ',asetpts=PTS-STARTPTS,volume=' + f2(o.volume) + ',afade=t=in:st=0:d=0.6,afade=t=out:st=' + f2(fadeOut) + ':d=1.2[aout]');
    audioMap = ['-map', '[aout]'];
  } else if (o.audio === 'original' && info.hasAudio && (o.speed === 'normal' || o.speed === 'slow')) {
    if (o.speed === 'slow') { f.push('[0:a]atempo=0.5[aout]'); audioMap = ['-map', '[aout]']; }
    else audioMap = ['-map', '0:a'];
  }
  a.push('-filter_complex', f.join(';'), '-map', '[vout]', ...audioMap);
  a.push('-t', f2(dur), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (audioMap.length) a.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100'); else a.push('-an');
  a.push('-movflags', '+faststart', output);
  return { args: a, duration: dur, W: o.W, H: o.H };
}

// ---------- jobs ----------
const jobs = new Map();
let seq = 0, chain = Promise.resolve();
export const jobInfo = (id) => { const j = jobs.get(Number(id)); return j ? { id: j.id, state: j.state, pct: j.pct, out: j.out, error: j.error } : null; };
export function cancelJob(id) {
  const j = jobs.get(Number(id)); if (!j) return false;
  if (j.state === 'queued') { j.state = 'cancelled'; return true; }
  if (j.state === 'running' && j.proc) { j.state = 'cancelled'; try { j.proc.kill(); } catch { /* gone */ } return true; }
  return false;
}
const safeBase = (n) => basename(String(n || 'video')).replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';

// inputPath: the clip; outDir: where the finished MP4 goes; the rest as in buildArgs.
export function enqueue({ inputPath, outDir, label, overlay, music, options }) {
  const job = { id: ++seq, state: 'queued', pct: 0, out: null, error: '', proc: null };
  jobs.set(job.id, job);
  chain = chain.then(() => runJob(job, { inputPath, outDir, label, overlay, music, options })).catch(() => {});
  return { id: job.id };
}
async function runJob(job, p) {
  if (job.state === 'cancelled') return;
  job.state = 'running';
  try {
    const bin = await findFfmpeg(); if (!bin) throw new Error('Video editing is not available on this laptop.');
    if (!existsSync(p.inputPath)) throw new Error('That video is no longer in the inbox.');
    mkdirSync(p.outDir, { recursive: true });
    const info = await probe(p.inputPath);
    let name = safeBase(p.inputPath) + (p.label ? ' ' + safeBase(p.label) : ' edited') + '.mp4', i = 2;
    while (existsSync(join(p.outDir, name))) { name = name.replace(/( \(\d+\))?\.mp4$/, ' (' + i + ').mp4'); i++; }
    const outPath = join(p.outDir, '.' + name + '.part.mp4');         // not listed until finished
    const built = buildArgs({ input: p.inputPath, output: outPath, overlay: p.overlay, music: p.music, options: p.options }, info);
    const total = built.duration;
    const r = await run(bin, built.args, {
      onProc: (pr) => { job.proc = pr; },
      onStdout: (t) => { const m = [...t.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop(); if (m) job.pct = clamp(Math.round(Number(m[1]) / 1e6 / total * 100), 0, 99); }
    });
    if (job.state === 'cancelled') { try { unlinkSync(outPath); } catch { /* none */ } return; }
    if (r.code !== 0 || !existsSync(outPath)) {
      const tail = r.err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' | ');
      throw new Error('The video could not be edited' + (tail ? ' (' + tail.slice(0, 300) + ')' : '.'));
    }
    renameSync(outPath, join(p.outDir, name));
    job.out = 'edited/' + name; job.pct = 100; job.state = 'done';
  } catch (e) {
    job.state = job.state === 'cancelled' ? 'cancelled' : 'error';
    job.error = String((e && e.message) || e);
  } finally { job.proc = null; }
}

// The transparent PNG (frame, logo, title) the booth page drew: saved to a temp file for ffmpeg.
const OV_RE = /^pb4u-overlay-\d+-\d+\.png$/;
export function saveOverlay(bytes) {
  if (!tempDir || !bytes || !bytes.length || bytes.length > 25 * 1024 * 1024) return null;
  mkdirSync(tempDir, { recursive: true });
  try {   // tidy up old ones
    for (const n of readdirSync(tempDir)) if (OV_RE.test(n) && Date.now() - statSync(join(tempDir, n)).mtimeMs > 86400000) unlinkSync(join(tempDir, n));
  } catch { /* ignore */ }
  const name = 'pb4u-overlay-' + Date.now() + '-' + (++seq) + '.png';
  writeFileSync(join(tempDir, name), Buffer.from(bytes));
  return name;
}
export function overlayPath(name) { return tempDir && OV_RE.test(String(name || '')) && existsSync(join(tempDir, name)) ? join(tempDir, name) : null; }
