// 360 videos: editing with ffmpeg.
//
// ffmpeg is a separate program shipped with the app (see resources/ffmpeg-NOTICE.txt); we only run it.
// A clip from the 360 camera goes in; an MP4 for phones comes out: trimmed, re-timed (slow motion, speed
// ramp, boomerang), cropped to portrait or landscape, with the event's frame / logo / title drawn over it
// (a transparent PNG made by the booth page) and optional music. Jobs run one at a time.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
let candidates = [], resolved = undefined, resolvedHw = undefined, tempDir = null, fxDirectory = null;

// buildDir: where prepare.mjs put build/ffmpeg (inside app.asar.unpacked when packaged).
export function configure({ buildDir, temp, fxDir, resume = false }) {
  tempDir = temp || null;
  if (fxDir) {
    fxDirectory = fxDir;
  } else if (buildDir) {
    const unpacked = join(buildDir.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked'), 'spin-fx');
    fxDirectory = existsSync(unpacked) ? unpacked : join(buildDir, 'spin-fx');
  } else {
    fxDirectory = null;
  }
  candidates = [];
  if (process.env.PB4U_FFMPEG) candidates.push(process.env.PB4U_FFMPEG);
  if (buildDir) {
    candidates.push(join(buildDir.replace(/app\.asar(?![.\w])/, 'app.asar.unpacked'), 'ffmpeg', EXE));
    candidates.push(join(buildDir, 'ffmpeg', EXE));
  }
  try { const p = createRequire(import.meta.url)('ffmpeg-static'); if (p) candidates.push(p); } catch { /* not installed */ }
  candidates.push('ffmpeg');           // one the laptop already has
  resolved = undefined;
  resolvedHw = undefined;
  if (resume && tempDir) {
    try { resumePendingJobs(); } catch { /* ignore */ }
  }
}

export function setFxDir(dir) { fxDirectory = dir || null; }
export function getFxDir() { return fxDirectory; }

function run(bin, args, { timeout = 0, watchdogMs = 0, onStdout, onProc } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timer = null, watchdogTimer = null, lastActivity = Date.now();
    let p;
    try { p = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out, err: String(e) }); }
    try {
      if (p && p.pid && os.constants && os.constants.priority) {
        os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      }
    } catch { /* ignore unsupported platform */ }
    if (onProc) onProc(p);
    const end = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      resolve({ code, out, err });
    };
    p.stdout.on('data', (d) => {
      lastActivity = Date.now();
      const t = d.toString(); out += t;
      if (onStdout) onStdout(t);
      if (out.length > 200000) out = out.slice(-100000);
    });
    p.stderr.on('data', (d) => {
      const t = d.toString(); err += t;
      if (err.length > 200000) err = err.slice(-100000);
    });
    p.on('error', (e) => end(-1, (err += String(e))));
    p.on('close', (code) => end(code == null ? -1 : code));
    if (timeout) timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } end(-2); }, timeout);
    if (watchdogMs > 0) {
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastActivity > watchdogMs) {
          try { p.kill(); } catch { /* gone */ }
          end(-3);
        }
      }, 1000);
    }
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
    // A clip recorded in a browser (WebM) has no length in its header: remux packets (-c copy) first to find out fast.
    const fast = await run(bin, ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { timeout: 20000 });
    info.duration = durationFromProgress(fast.err);
    if (!info.width) Object.assign(info, { ...parseProbe(fast.err), duration: info.duration });
    if (!info.duration) {
      const d = await run(bin, ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 120000 });
      info.duration = durationFromProgress(d.err);
      if (!info.width) Object.assign(info, { ...parseProbe(d.err), duration: info.duration });
    }
  }
  if (!info.duration) throw new Error('Could not read that video.');
  return info;
}

// Optional hardware H.264 encoder detection (1.5). Tested once with a 1-frame encode and cached.
export async function findHwEncoder() {
  if (resolvedHw !== undefined) return resolvedHw;
  const bin = await findFfmpeg();
  if (!bin) { resolvedHw = null; return null; }
  const order = process.platform === 'darwin'
    ? ['h264_videotoolbox']
    : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  for (const enc of order) {
    const r = await run(bin, [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=30:d=0.1',
      '-frames:v', '1', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-'
    ], { timeout: 5000 });
    if (r.code === 0) { resolvedHw = enc; return resolvedHw; }
  }
  resolvedHw = null;
  return null;
}

// ---------- the ffmpeg command ----------
export const SPEEDS = ['normal', 'slow', 'ramp', 'boomerang', 'custom'];
const REVERSE_MAX = 8;                       // a sequence up to twice this many seconds can also play backwards (held in memory)
const BOOMERANG_MAX = 5;                     // seconds of the clip that go forward then back (it is held in memory)
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f2 = (n) => (Math.round(n * 1000) / 1000).toString();

// Builds an atempo filter chain for any playback rate in [0.25, 4] (ffmpeg atempo accepts [0.5, 100]).
function atempoChain(rate) {
  const r = clamp(Number(rate) || 1, 0.25, 4);
  if (Math.abs(r - 1) < 0.001) return '';
  if (r < 0.5) return 'atempo=0.5,atempo=' + f2(r / 0.5);
  if (r > 2) return 'atempo=2,atempo=' + f2(r / 2);
  return 'atempo=' + f2(r);
}

export function listFx() {
  if (!fxDirectory || !existsSync(fxDirectory)) return [];
  const catPath = join(fxDirectory, 'catalog.json');
  if (existsSync(catPath)) {
    try {
      const data = JSON.parse(readFileSync(catPath, 'utf8'));
      if (Array.isArray(data)) return data;
    } catch { /* ignore parse error */ }
  }
  return [];
}

function isValidFxFile(p) {
  try {
    return Boolean(p && existsSync(p) && statSync(p).size > 1024);
  } catch {
    return false;
  }
}

function isVp9Webm(filePath) {
  if (!filePath || !/\.webm$/i.test(filePath)) return false;
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const read = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    return !buf.subarray(0, read).includes('V_VP8');
  } catch {
    return true;
  }
}

export function resolveFx(spec, orientation) {
  if (!spec) return null;
  const isLandscape = orientation === 'landscape' || (typeof orientation === 'object' && orientation && (orientation.orientation === 'landscape' || orientation.landscape));
  if (typeof spec === 'object' && spec.path && isValidFxFile(spec.path)) return spec;
  const id = typeof spec === 'string' ? spec.trim() : String(spec.id || spec.file || '').trim();
  if (!id || id === 'none') return null;
  if (isValidFxFile(id)) {
    return {
      id,
      path: id,
      blend: typeof spec === 'object' && spec.blend ? spec.blend : (/\.webm$/i.test(id) ? 'overlay' : 'screen'),
      opacity: typeof spec === 'object' && spec.opacity != null ? Number(spec.opacity) : 1.0,
      isLandscape: /landscape/i.test(id)
    };
  }
  if (fxDirectory && existsSync(fxDirectory)) {
    const catPath = join(fxDirectory, 'catalog.json');
    if (existsSync(catPath)) {
      try {
        const cat = JSON.parse(readFileSync(catPath, 'utf8'));
        if (Array.isArray(cat)) {
          const found = cat.find((item) => item.id === id || item.file === id);
          if (found) {
            const fname = found.file || found.filename || found.path || '';
            let actual = null;
            let isLand = false;
            if (isLandscape) {
              const pLand = join(fxDirectory, 'loops', 'landscape', fname);
              const pLand2 = join(fxDirectory, 'landscape', fname);
              if (isValidFxFile(pLand)) { actual = pLand; isLand = true; }
              else if (isValidFxFile(pLand2)) { actual = pLand2; isLand = true; }
            }
            if (!actual) {
              const p1 = join(fxDirectory, 'loops', fname);
              const p2 = join(fxDirectory, fname);
              actual = isValidFxFile(p1) ? p1 : (isValidFxFile(p2) ? p2 : null);
            }
            if (actual) {
              return {
                id: found.id,
                name: found.name || found.id,
                path: actual,
                blend: found.blend || (/\.webm$/i.test(actual) ? 'overlay' : 'screen'),
                opacity: found.opacity != null ? Number(found.opacity) : 1.0,
                isLandscape: isLand
              };
            }
          }
        }
      } catch { /* ignore json error */ }
    }
    const subDirs = isLandscape ? ['loops/landscape', 'landscape', 'loops', ''] : ['loops', ''];
    for (const sub of subDirs) {
      for (const ext of ['', '.mp4', '.webm']) {
        const p = join(fxDirectory, sub, id + ext);
        if (isValidFxFile(p)) {
          return {
            id,
            path: p,
            blend: /\.webm$/i.test(p) ? 'overlay' : 'screen',
            opacity: 1.0,
            isLandscape: /landscape/i.test(sub) || /landscape/i.test(p)
          };
        }
      }
    }
  }
  return null;
}

export function normOptions(o) {
  o = o || {};
  const speed = SPEEDS.includes(o.speed) ? o.speed : 'slow';
  const q = o.quality === 720 || speed === 'boomerang' || (speed === 'custom' && o.reverse) ? 720 : 1080;      // boomerang and backwards are kept at 720 to stay light
  const short = q, long = Math.round(q * 16 / 9 / 2) * 2;
  const orient = o.orientation === 'landscape' ? 'landscape' : (o.orientation === 'square' ? 'square' : 'portrait');
  const landscape = orient === 'landscape';
  const square = orient === 'square';
  const W = square ? q : (landscape ? long : short);
  const H = square ? q : (landscape ? short : long);
  return {
    speed, smooth: !!o.smooth, gpu: !!o.gpu, landscape, square, orientation: orient,
    // custom: the clip is cut in equal parts and each part plays at its own rate (0.25x to 4x); reverse adds the whole thing backwards
    rates: speed === 'custom' ? (Array.isArray(o.rates) ? o.rates : []).map(Number).filter((r) => r >= 0.25 && r <= 4).slice(0, 6) : [],
    reverse: speed === 'custom' && !!o.reverse,
    W, H,
    zoom: o.zoom !== undefined ? !!o.zoom : true,
    flash: o.flash !== undefined ? !!o.flash : true,
    trimStart: clamp(Number(o.trimStart) || 0, 0, 3600),
    trimEnd: o.trimEnd == null || o.trimEnd === '' ? null : Math.max(0, Number(o.trimEnd) || 0),
    audio: ['music', 'original', 'none'].includes(o.audio) ? o.audio : 'music',
    volume: clamp(o.volume == null ? 0.8 : Number(o.volume), 0, 1),
    fx: o.fx || null,
    fxSpeed: o.fxSpeed != null ? clamp(Number(o.fxSpeed), 0.2, 3.0) : 1.0,
    fxOpacity: o.fxOpacity != null ? clamp(Number(o.fxOpacity), 0.05, 1.0) : null,
    fxLocation: o.fxLocation || 'full',
    intro: o.intro || null,
    outro: o.outro || null,
    textTiming: o.textTiming === 'fade' ? 'fade' : 'always',
    textFadeIn: o.textFadeIn != null ? Number(o.textFadeIn) : 0.6,
    textFadeOut: o.textFadeOut != null ? Number(o.textFadeOut) : 0.6,
    dropTime: o.dropTime != null && Number(o.dropTime) > 0 ? clamp(Number(o.dropTime), 0.5, 12) : null,
    lut: ['glam_bw', 'teal_orange', 'golden_hour', 'vibrant', 'vintage', 'none'].includes(o.lut) ? o.lut : (o.lut || 'none')
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
  if (speed === 'ramp') {
    if (o && o.dropTime != null) {
      const t1Val = clamp(o.dropTime * 2, 0.4, Math.max(0.5, d * 0.7));
      const t2Val = Math.min(d - 0.2, Math.max(t1Val + 0.5, d * 0.75));
      return (t1Val / 2) + (t2Val - t1Val) * 2 + (d - t2Val) / 2;
    }
    return d * 1.25;
  }
  if (speed === 'boomerang') return Math.min(d, BOOMERANG_MAX) * 2;
  return d;
}
// { args, duration, W, H } for one clip. overlay / fx / music / intro / outro are file paths or null.
export function buildArgs({ input, output, overlay, textOverlay, fx, music, intro, outro, options, hwEncoder }, info) {
  const o = normOptions(options);
  const introPath = (intro || o.intro) && existsSync(intro || o.intro) ? (intro || o.intro) : null;
  const outroPath = (outro || o.outro) && existsSync(outro || o.outro) ? (outro || o.outro) : null;
  const inFps = Number(info && info.fps) || 0;
  const inDur = Number(info && info.duration) || 1.0;
  const end = o.trimEnd != null && o.trimEnd > o.trimStart ? Math.min(o.trimEnd, inDur) : inDur;
  const D = Math.max(0.5, end - o.trimStart);
  if (o.speed === 'custom' && !o.rates.length) o.rates = [1];
  // Playing backwards holds the whole sequence in memory: only for a short one.
  if (o.speed === 'custom' && o.reverse && outDuration('custom', D, { ...o, reverse: false }) > REVERSE_MAX * 2) o.reverse = false;
  let dur = outDuration(o.speed, D, o);
  const a = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
  a.push('-ss', f2(o.trimStart), '-t', f2(D), '-i', input);

  const fxResolved = resolveFx(fx || o.fx, o.orientation);
  let fxPath = null, fxBlend = 'screen', fxOpacity = 1.0;
  if (fxResolved && fxResolved.path && existsSync(fxResolved.path)) {
    fxPath = fxResolved.path;
    fxBlend = ['overlay', 'screen', 'addition'].includes(fxResolved.blend) ? fxResolved.blend : (/\.webm$/i.test(fxPath) ? 'overlay' : 'screen');
    fxOpacity = clamp(Number(fxResolved.opacity != null ? fxResolved.opacity : 1.0), 0, 1);
  }
  if (o.fxOpacity != null) {
    fxOpacity = o.fxOpacity;
  }

  let idx = 1, fxIdx = -1, ovIdx = -1, txtIdx = -1, muIdx = -1, introIdx = -1, outroIdx = -1;
  if (fxPath) {
    a.push('-stream_loop', '-1');
    if (isVp9Webm(fxPath)) {
      a.push('-c:v', 'libvpx-vp9');
    }
    a.push('-i', fxPath);
    fxIdx = idx++;
  }
  if (overlay) { a.push('-i', overlay); ovIdx = idx++; }
  if (textOverlay) { a.push('-i', textOverlay); txtIdx = idx++; }
  const useMusic = o.audio === 'music' && !!music;
  if (useMusic) { a.push('-stream_loop', '-1', '-i', music); muIdx = idx++; }
  if (introPath) { a.push('-i', introPath); introIdx = idx++; }
  if (outroPath) { a.push('-i', outroPath); outroIdx = idx++; }

  // 1.1: Scale/crop to output dimensions first so minterpolate, split, concat, and fps operate on WxH instead of 4K.
  // 1.2: Skip minterpolate when the source clip already has enough real frames (>=50fps for 0.5x, >=25fps after slowest rate).
  const fit = 'scale=' + o.W + ':' + o.H + ':force_original_aspect_ratio=increase,crop=' + o.W + ':' + o.H + ',setsar=1';
  const f = [];
  let src = '[0:v]';
  if (o.speed === 'slow') {
    const smoothSlow = o.smooth && (inFps <= 0 || inFps < 50);
    const durSlow = D * 2;
    const zoomFilter = o.zoom ? ',scale=w=\'trunc(iw*(1+0.14*sin(t/' + f2(durSlow) + '*PI))/2)*2\':h=\'trunc(ih*(1+0.14*sin(t/' + f2(durSlow) + '*PI))/2)*2\':eval=frame,crop=' + o.W + ':' + o.H : '';
    const flashFilter = o.flash ? ',drawbox=x=0:y=0:w=in_w:h=in_h:color=white@0.65:t=fill:enable=\'between(t,0,0.10)\'' : '';
    f.push(src + fit + ',' + (smoothSlow ? 'minterpolate=fps=60:mi_mode=blend,' : '') + 'setpts=2.0*PTS,fps=30' + zoomFilter + flashFilter + '[v0]');
  } else if (o.speed === 'ramp') {
    let t1Val = D * 0.25;
    if (o.dropTime != null) {
      t1Val = clamp(o.dropTime * 2, 0.4, Math.max(0.5, D * 0.7));
    }
    const t2Val = Math.min(D - 0.2, Math.max(t1Val + 0.5, D * 0.75));
    const t1 = f2(t1Val), t2 = f2(t2Val);
    const bDur = (t2Val - t1Val) * 2;
    const bZoom = o.zoom ? ',scale=w=\'trunc(iw*(1+0.15*sin(t/' + f2(bDur) + '*PI))/2)*2\':h=\'trunc(ih*(1+0.15*sin(t/' + f2(bDur) + '*PI))/2)*2\':eval=frame,crop=' + o.W + ':' + o.H : '';
    f.push(src + fit + ',split=3[a][b][c]');
    f.push('[a]trim=0:' + t1 + ',setpts=(PTS-STARTPTS)/2[v1]');
    f.push('[b]trim=' + t1 + ':' + t2 + ',setpts=(PTS-STARTPTS)*2' + bZoom + '[v2]');
    f.push('[c]trim=' + t2 + ',setpts=(PTS-STARTPTS)/2[v3]');
    const tDrop = t1Val / 2;
    const rampFlash = o.flash ? ',drawbox=x=0:y=0:w=in_w:h=in_h:color=white@0.65:t=fill:enable=\'between(t,' + f2(tDrop) + ',' + f2(tDrop + 0.10) + ')\'' : '';
    f.push('[v1][v2][v3]concat=n=3:v=1:a=0,fps=30' + rampFlash + '[v0]');
  } else if (o.speed === 'custom') {
    const n = o.rates.length, part = D / n;
    const minRate = Math.min(...o.rates);
    const needSmooth = o.smooth && minRate < 1 && (inFps <= 0 || inFps * minRate < 25);
    const pre = needSmooth ? 'minterpolate=fps=60:mi_mode=blend,' : '';
    if (n === 1) {
      f.push(src + fit + ',' + pre + 'setpts=' + f2(1 / o.rates[0]) + '*PTS,fps=30' + (o.reverse ? ',split[a][b]' : '[v0]'));
    } else {
      f.push(src + fit + ',' + pre + 'split=' + n + o.rates.map((r, i) => '[s' + i + ']').join(''));
      o.rates.forEach((r, i) => f.push('[s' + i + ']trim=' + f2(i * part) + ':' + f2((i + 1) * part) + ',setpts=(PTS-STARTPTS)/' + f2(r) + '[p' + i + ']'));
      f.push(o.rates.map((r, i) => '[p' + i + ']').join('') + 'concat=n=' + n + ':v=1:a=0,fps=30' + (o.reverse ? ',split[a][b]' : '[v0]'));
    }
    if (o.reverse) {
      const revFlash = o.flash ? ',drawbox=x=0:y=0:w=in_w:h=in_h:color=white@0.65:t=fill:enable=\'between(t,0,0.10)\'' : '';
      f.push('[b]reverse' + revFlash + '[r]');
      f.push('[a][r]concat=n=2:v=1:a=0[v0]');
    }
  } else if (o.speed === 'boomerang') {
    const Db = f2(Math.min(D, BOOMERANG_MAX));
    const bDur = Math.min(D, BOOMERANG_MAX) * 2;
    const bZoom = o.zoom ? ',scale=w=\'trunc(iw*(1+0.14*sin(t/' + f2(bDur) + '*PI))/2)*2\':h=\'trunc(ih*(1+0.14*sin(t/' + f2(bDur) + '*PI))/2)*2\':eval=frame,crop=' + o.W + ':' + o.H : '';
    const turnPoint = f2(Math.min(D, BOOMERANG_MAX));
    const bFlash = o.flash ? ',drawbox=x=0:y=0:w=in_w:h=in_h:color=white@0.65:t=fill:enable=\'between(t,' + f2(Number(turnPoint) - 0.05) + ',' + f2(Number(turnPoint) + 0.05) + ')\'' : '';
    f.push(src + 'trim=0:' + Db + ',setpts=PTS-STARTPTS,' + fit + ',fps=30,split[a][b]');
    f.push('[b]reverse[r]');
    f.push('[a][r]concat=n=2:v=1:a=0' + bZoom + bFlash + '[v0]');
  } else {
    f.push(src + fit + ',fps=30[v0]');
  }
  let last = '[v0]';
  if (o.lut && o.lut !== 'none') {
    let lutFilter = '';
    if (o.lut === 'glam_bw') {
      lutFilter = ',colorchannelmixer=.3:.4:.3:0:.3:.4:.3:0:.3:.4:.3,curves=all=\'0/0 0.18/0.08 0.72/0.86 1/1\',eq=contrast=1.18:brightness=0.02';
    } else if (o.lut === 'teal_orange') {
      lutFilter = ',curves=r=\'0/0 0.5/0.46 1/1\':b=\'0/0 0.5/0.58 1/1\',eq=saturation=1.25:contrast=1.12';
    } else if (o.lut === 'golden_hour') {
      lutFilter = ',curves=r=\'0/0 0.5/0.55 1/1\':g=\'0/0 0.5/0.52 1/1\':b=\'0/0 0.5/0.45 1/1\',eq=saturation=1.16:gamma=1.04';
    } else if (o.lut === 'vibrant') {
      lutFilter = ',eq=saturation=1.38:contrast=1.14';
    } else if (o.lut === 'vintage') {
      lutFilter = ',curves=all=\'0/0.04 0.5/0.5 1/0.96\',eq=saturation=0.88:contrast=1.06';
    }
    if (lutFilter) {
      f.push(last + lutFilter.slice(1) + '[v_lut]');
      last = '[v_lut]';
    }
  }
  if (fxIdx >= 0) {
    // 1.3: Decode, scale, and format the short FX clip once, then loop the pre-formatted frames in memory.
    const fxSpeed = f2(o.fxSpeed || 1.0);
    const fxLoop = (o.fxSpeed && o.fxSpeed !== 1.0)
      ? 'loop=loop=-1:size=300:start=0,setpts=N/(30*TB*' + fxSpeed + ')'
      : 'loop=loop=-1:size=300:start=0,setpts=N/(30*TB)';
    // 3.2: For landscape outputs, if loop is native landscape, scale directly; if portrait loop, scale to height and pad/center to prevent 3.56x zoom cropping out 70% of particles.
    if (o.landscape && !fxResolved?.isLandscape) {
      f.push('[' + fxIdx + ':v]scale=-1:' + o.H + ':force_original_aspect_ratio=decrease,pad=' + o.W + ':' + o.H + ':(ow-iw)/2:(oh-ih)/2:color=' + (fxBlend === 'overlay' ? '0x00000000' : 'black') + ',setsar=1,fps=30[fx_fit]');
    } else {
      f.push('[' + fxIdx + ':v]scale=' + o.W + ':' + o.H + ':force_original_aspect_ratio=increase,crop=' + o.W + ':' + o.H + ',setsar=1,fps=30[fx_fit]');
    }
    if (fxBlend === 'overlay') {
      if (fxOpacity < 0.999) {
        f.push('[fx_fit]format=rgba[fx_rgba]');
        f.push('[fx_rgba]colorchannelmixer=aa=' + f2(fxOpacity) + ',format=yuva420p,' + fxLoop + '[fx_alpha]');
      } else {
        f.push('[fx_fit]format=yuva420p,' + fxLoop + '[fx_alpha]');
      }
      f.push(last + '[fx_alpha]overlay=0:0:format=auto:shortest=1[v_fx]');
      last = '[v_fx]';
    } else if (fxBlend === 'addition') {
      f.push(last + 'format=gbrp[v_base]');
      f.push('[fx_fit]format=gbrp,' + fxLoop + '[fx_rgb]');
      f.push('[v_base][fx_rgb]blend=all_mode=addition' + (fxOpacity < 0.999 ? ':all_opacity=' + f2(fxOpacity) : '') + ':shortest=1[v_fx]');
      last = '[v_fx]';
    } else {
      f.push(last + 'format=gbrp[v_base]');
      f.push('[fx_fit]format=gbrp,' + fxLoop + '[fx_rgb]');
      f.push('[v_base][fx_rgb]blend=all_mode=screen' + (fxOpacity < 0.999 ? ':all_opacity=' + f2(fxOpacity) : '') + ':shortest=1[v_fx]');
      last = '[v_fx]';
    }
  }
  if (ovIdx >= 0) {
    f.push('[' + ovIdx + ':v]scale=' + o.W + ':' + o.H + ',format=rgba[ov]');
    f.push(last + '[ov]overlay=0:0:format=auto[v1o]');
    last = '[v1o]';
  }
  if (txtIdx >= 0) {
    if (o.textTiming === 'fade') {
      const fadeIn = clamp(Number(o.textFadeIn) || 0.6, 0.1, 2.0);
      const fadeOut = clamp(Number(o.textFadeOut) || 0.6, 0.1, 2.0);
      const fadeOutStart = Math.max(0.1, dur - fadeOut - 0.2);
      f.push('[' + txtIdx + ':v]scale=' + o.W + ':' + o.H + ',format=rgba,fade=in:st=0.3:d=' + f2(fadeIn) + ':alpha=1,fade=out:st=' + f2(fadeOutStart) + ':d=' + f2(fadeOut) + ':alpha=1[txt_fade]');
      f.push(last + '[txt_fade]overlay=0:0:format=auto[v_txt]');
    } else {
      f.push('[' + txtIdx + ':v]scale=' + o.W + ':' + o.H + ',format=rgba[txt_raw]');
      f.push(last + '[txt_raw]overlay=0:0:format=auto[v_txt]');
    }
    last = '[v_txt]';
  }
  const hasStinger = introIdx >= 0 || outroIdx >= 0;
  const mainVLabel = hasStinger ? '[v_main]' : '[vout]';
  f.push(last + 'format=yuv420p' + mainVLabel);

  // 1.6: Audio "Original sound" supported across normal, slow, ramp, custom, and boomerang.
  let audioMap = [];
  const mainALabel = hasStinger ? '[a_main]' : '[aout]';
  if (useMusic) {
    const fadeOut = Math.max(0, dur - 1.2);
    f.push('[' + muIdx + ':a]atrim=0:' + f2(dur) + ',asetpts=PTS-STARTPTS,volume=' + f2(o.volume) + ',afade=t=in:st=0:d=0.6,afade=t=out:st=' + f2(fadeOut) + ':d=1.2' + mainALabel);
    audioMap = ['-map', mainALabel];
  } else if (o.audio === 'original' && info.hasAudio) {
    if (o.speed === 'normal') {
      if (hasStinger) {
        f.push('[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS' + mainALabel);
        audioMap = ['-map', mainALabel];
      } else {
        audioMap = ['-map', '0:a'];
      }
    } else if (o.speed === 'slow') {
      f.push('[0:a]atempo=0.5' + mainALabel);
      audioMap = ['-map', mainALabel];
    } else if (o.speed === 'ramp') {
      const t1 = f2(D * 0.25), t2 = f2(D * 0.75);
      f.push('[0:a]asplit=3[aa][ab][ac]');
      f.push('[aa]atrim=0:' + t1 + ',asetpts=PTS-STARTPTS,atempo=2[a1]');
      f.push('[ab]atrim=' + t1 + ':' + t2 + ',asetpts=PTS-STARTPTS,atempo=0.5[a2]');
      f.push('[ac]atrim=' + t2 + ',asetpts=PTS-STARTPTS,atempo=2[a3]');
      f.push('[a1][a2][a3]concat=n=3:v=0:a=1' + mainALabel);
      audioMap = ['-map', mainALabel];
    } else if (o.speed === 'boomerang') {
      const Db = f2(Math.min(D, BOOMERANG_MAX));
      f.push('[0:a]atrim=0:' + Db + ',asetpts=PTS-STARTPTS,asplit[aa][ab]');
      f.push('[ab]areverse[ar]');
      f.push('[aa][ar]concat=n=2:v=0:a=1' + mainALabel);
      audioMap = ['-map', mainALabel];
    } else if (o.speed === 'custom') {
      const n = o.rates.length, part = D / n;
      if (n === 1) {
        const ac = atempoChain(o.rates[0]);
        const chain = '[0:a]asetpts=PTS-STARTPTS' + (ac ? ',' + ac : '');
        if (o.reverse) {
          f.push(chain + ',asplit[aa][ab]');
          f.push('[ab]areverse[ar]');
          f.push('[aa][ar]concat=n=2:v=0:a=1' + mainALabel);
        } else {
          f.push(chain + mainALabel);
        }
      } else {
        f.push('[0:a]asplit=' + n + o.rates.map((r, i) => '[as' + i + ']').join(''));
        o.rates.forEach((r, i) => {
          const ac = atempoChain(r);
          f.push('[as' + i + ']atrim=' + f2(i * part) + ':' + f2((i + 1) * part) + ',asetpts=PTS-STARTPTS' + (ac ? ',' + ac : '') + '[ap' + i + ']');
        });
        f.push(o.rates.map((r, i) => '[ap' + i + ']').join('') + 'concat=n=' + n + ':v=0:a=1' + (o.reverse ? ',asplit[aa][ab]' : mainALabel));
        if (o.reverse) {
          f.push('[ab]areverse[ar]');
          f.push('[aa][ar]concat=n=2:v=0:a=1' + mainALabel);
        }
      }
      audioMap = ['-map', mainALabel];
    }
  } else if (hasStinger) {
    f.push('anullsrc=r=44100:cl=stereo,atrim=0:' + f2(dur) + mainALabel);
    audioMap = ['-map', mainALabel];
  }

  // 4.3: Concat Intro and/or Outro Stingers
  if (hasStinger) {
    const vSegs = [], aSegs = [];
    let extraDur = 0;
    if (introIdx >= 0) {
      f.push('[' + introIdx + ':v]scale=' + o.W + ':' + o.H + ':force_original_aspect_ratio=increase,crop=' + o.W + ':' + o.H + ',setsar=1,fps=30,setpts=PTS-STARTPTS[v_intro]');
      if (info && info.intro && info.intro.hasAudio) {
        f.push('[' + introIdx + ':a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a_intro]');
      } else {
        const inDur = f2((info && info.intro && info.intro.duration) || 2);
        f.push('anullsrc=r=44100:cl=stereo,atrim=0:' + inDur + ',asetpts=PTS-STARTPTS[a_intro]');
      }
      vSegs.push('[v_intro]'); aSegs.push('[a_intro]');
      extraDur += (info && info.intro && info.intro.duration) || 2;
    }
    vSegs.push('[v_main]'); aSegs.push(mainALabel);
    if (outroIdx >= 0) {
      f.push('[' + outroIdx + ':v]scale=' + o.W + ':' + o.H + ':force_original_aspect_ratio=increase,crop=' + o.W + ':' + o.H + ',setsar=1,fps=30,setpts=PTS-STARTPTS[v_outro]');
      if (info && info.outro && info.outro.hasAudio) {
        f.push('[' + outroIdx + ':a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a_outro]');
      } else {
        const outDur = f2((info && info.outro && info.outro.duration) || 2);
        f.push('anullsrc=r=44100:cl=stereo,atrim=0:' + outDur + ',asetpts=PTS-STARTPTS[a_outro]');
      }
      vSegs.push('[v_outro]'); aSegs.push('[a_outro]');
      extraDur += (info && info.outro && info.outro.duration) || 2;
    }
    const concatInputs = [];
    for (let i = 0; i < vSegs.length; i++) {
      concatInputs.push(vSegs[i], aSegs[i]);
    }
    f.push(concatInputs.join('') + 'concat=n=' + vSegs.length + ':v=1:a=1[vout][aout]');
    audioMap = ['-map', '[aout]'];
    dur += extraDur;
  }
  a.push('-filter_complex', f.join(';'), '-map', '[vout]', ...audioMap);
  a.push('-t', f2(dur), '-r', '30');
  const hw = hwEncoder || (o.gpu && resolvedHw) || null;
  if (hw === 'h264_nvenc') {
    a.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '22', '-pix_fmt', 'yuv420p');
  } else if (hw === 'h264_videotoolbox') {
    a.push('-c:v', 'h264_videotoolbox', '-q:v', '65', '-pix_fmt', 'yuv420p');
  } else if (hw === 'h264_qsv') {
    a.push('-c:v', 'h264_qsv', '-global_quality', '22', '-pix_fmt', 'yuv420p');
  } else if (hw === 'h264_amf') {
    a.push('-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p');
  } else {
    const cpuCount = (typeof os.cpus === 'function' ? os.cpus()?.length : 4) || 4;
    const safeThreads = Math.min(4, Math.max(2, cpuCount - 1));
    a.push('-c:v', 'libx264', '-threads', String(safeThreads), '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  if (audioMap.length) a.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100'); else a.push('-an');
  a.push('-movflags', '+faststart', output);
  return { args: a, duration: dur, W: o.W, H: o.H };
}

// ---------- jobs ----------
// ---------- jobs (1.7: persistent queue + pruning) ----------
const jobs = new Map();
const MAX_JOBS_HISTORY = 100;
let seq = 0, chain = Promise.resolve();

function queueFilePath() {
  return tempDir ? join(tempDir, 'spin-queue.json') : null;
}

function savePendingQueue() {
  const qf = queueFilePath();
  if (!qf) return;
  try {
    mkdirSync(tempDir, { recursive: true });
    const pending = [];
    for (const j of jobs.values()) {
      if ((j.state === 'queued' || j.state === 'running') && j.params) {
        pending.push({ id: j.id, params: j.params });
      }
    }
    writeFileSync(qf, JSON.stringify(pending));
  } catch { /* ignore */ }
}

function pruneJobs() {
  if (jobs.size <= MAX_JOBS_HISTORY) return;
  for (const [id, j] of jobs) {
    if (jobs.size <= MAX_JOBS_HISTORY) break;
    if (j.state === 'done' || j.state === 'error' || j.state === 'cancelled') {
      jobs.delete(id);
    }
  }
}

export function resumePendingJobs() {
  const qf = queueFilePath();
  if (!qf || !existsSync(qf)) return 0;
  let list = [];
  try { list = JSON.parse(readFileSync(qf, 'utf8')) || []; } catch { return 0; }
  if (!Array.isArray(list) || !list.length) return 0;
  let count = 0;
  for (const item of list) {
    const p = item && item.params;
    if (!p || !p.inputPath || !existsSync(p.inputPath)) continue;
    enqueue(p);
    count++;
  }
  return count;
}

export const jobInfo = (id) => { const j = jobs.get(Number(id)); return j ? { id: j.id, state: j.state, pct: j.pct, out: j.out, error: j.error } : null; };
export function cancelJob(id) {
  const j = jobs.get(Number(id)); if (!j) return false;
  if (j.state === 'queued') { j.state = 'cancelled'; savePendingQueue(); return true; }
  if (j.state === 'running' && j.proc) { j.state = 'cancelled'; try { j.proc.kill(); } catch { /* gone */ } savePendingQueue(); return true; }
  return false;
}
const safeBase = (n) => basename(String(n || 'video')).replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'video';

// inputPath: the clip; outDir: where the finished MP4 goes; the rest as in buildArgs.
export function enqueue({ inputPath, outDir, label, overlay, textOverlay, fx, music, intro, outro, options }) {
  pruneJobs();
  const params = { inputPath, outDir, label, overlay, textOverlay, fx, music, intro, outro, options };
  const job = { id: ++seq, state: 'queued', pct: 0, out: null, error: '', proc: null, params };
  jobs.set(job.id, job);
  savePendingQueue();
  chain = chain.then(() => runJob(job, params)).catch(() => {});
  return { id: job.id };
}
async function runJob(job, p) {
  if (job.state === 'cancelled') { savePendingQueue(); return; }
  job.state = 'running';
  savePendingQueue();
  try {
    const bin = await findFfmpeg(); if (!bin) throw new Error('Video editing is not available on this laptop.');
    if (!existsSync(p.inputPath)) throw new Error('That video is no longer in the inbox.');
    mkdirSync(p.outDir, { recursive: true });
    const info = await probe(p.inputPath);
    let name = safeBase(p.inputPath) + (p.label ? ' ' + safeBase(p.label) : ' edited') + '.mp4', i = 2;
    while (existsSync(join(p.outDir, name))) { name = name.replace(/( \(\d+\))?\.mp4$/, ' (' + i + ').mp4'); i++; }
    const outPath = join(p.outDir, '.' + name + '.part.mp4');         // not listed until finished
    const introPath = p.intro || (p.options && p.options.intro) || null;
    const outroPath = p.outro || (p.options && p.options.outro) || null;
    const introInfo = introPath && existsSync(introPath) ? await probe(introPath).catch(() => null) : null;
    const outroInfo = outroPath && existsSync(outroPath) ? await probe(outroPath).catch(() => null) : null;
    const combinedInfo = { ...info, intro: introInfo, outro: outroInfo };
    const useGpu = Boolean(p.options && p.options.gpu);
    const hwEncoder = useGpu ? await findHwEncoder() : null;
    let built = buildArgs({ input: p.inputPath, output: outPath, overlay: p.overlay, textOverlay: p.textOverlay, fx: p.fx, music: p.music, intro: introPath, outro: outroPath, options: p.options, hwEncoder }, combinedInfo);
    const total = built.duration;
    let r = await run(bin, built.args, {
      watchdogMs: hwEncoder ? 10000 : 0,
      onProc: (pr) => { job.proc = pr; },
      onStdout: (t) => { const m = [...t.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop(); if (m) job.pct = clamp(Math.round(Number(m[1]) / 1e6 / total * 100), 0, 99); }
    });
    // If GPU encoding failed at runtime or stalled (watchdog), transparently fall back to libx264.
    if (hwEncoder && job.state !== 'cancelled' && (r.code !== 0 || !existsSync(outPath))) {
      resolvedHw = null;
      try { unlinkSync(outPath); } catch { /* ignore */ }
      built = buildArgs({ input: p.inputPath, output: outPath, overlay: p.overlay, textOverlay: p.textOverlay, fx: p.fx, music: p.music, intro: introPath, outro: outroPath, options: { ...p.options, gpu: false }, hwEncoder: null }, combinedInfo);
      r = await run(bin, built.args, {
        onProc: (pr) => { job.proc = pr; },
        onStdout: (t) => { const m = [...t.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop(); if (m) job.pct = clamp(Math.round(Number(m[1]) / 1e6 / total * 100), 0, 99); }
      });
    }
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
  } finally {
    job.proc = null;
    savePendingQueue();
  }
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

// Spin & Print: extract 1 or more still frames from a 360 video clip for instant photo strip / keychain printing.
export async function extractFrames({ inputPath, times = [1.0] }) {
  const bin = await findFfmpeg();
  if (!bin) throw new Error('FFmpeg not available');
  if (!existsSync(inputPath)) throw new Error('Input video not found: ' + inputPath);
  let dur = 5;
  try {
    const info = await probe(inputPath);
    if (info && info.duration) dur = info.duration;
  } catch { /* use fallback duration */ }
  const tArr = Array.isArray(times) && times.length ? times : [dur * 0.5];
  const results = [];
  const dir = tempDir || os.tmpdir();
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < tArr.length; i++) {
    const t = clamp(Number(tArr[i]) || (dur * 0.5), 0, Math.max(0, dur - 0.05));
    const out = join(dir, 'frame_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 7) + '.jpg');
    const r = await run(bin, [
      '-hide_banner', '-y', '-ss', f2(t), '-i', inputPath,
      '-vframes', '1', '-q:v', '2', out
    ], { timeout: 15000 });
    if (r.code === 0 && existsSync(out)) {
      try {
        const data = readFileSync(out);
        try { unlinkSync(out); } catch { /* ignore */ }
        results.push('data:image/jpeg;base64,' + data.toString('base64'));
      } catch { /* ignore read failure */ }
    }
  }
  return results;
}
