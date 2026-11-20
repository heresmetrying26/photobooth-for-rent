// ---- The booth's built-in sounds: countdown beeps, "Pose" chime, start chime and the camera shutter ----
// Made here as plain sample arrays (no sound files, no Web Audio nodes), once. One definition for every place that needs them:
// this device plays the samples through a buffer (fxPlay in the sound section), and the tablet guest screen gets the same samples
// as small WAV files (fxWavUrl, sent by tabletSoundSync in the tablet bridge) and plays them itself.
// This file is pasted into the middle of the booth script: `var` and function declarations on purpose (see protected/src/bridge).
var FX_SR = 44100;
var fxSoundCache = {};
var fxWavCache = {};

// Same noise every time (the shutter is rendered once, so every shot sounds the same): a small seeded random generator, -1..1.
function fxNoise(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

// A two-pole filter ('bp' band-pass, 'hp' high-pass); returns a function that takes one sample and gives one sample.
function fxBiquad(type, fc, q, sr) {
  var w = 2 * Math.PI * fc / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  var b0, b1, b2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return function (x) {
    var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

// A beep: the level rises to `level` in 12 ms, then falls away to nothing at `dur` (the same shape the booth always used).
function fxTone(out, freq, dur, type, level, when) {
  var sr = FX_SR, i0 = Math.round((when || 0) * sr), n = Math.round((dur + 0.03) * sr), amp = 0.45 * (level || 1), i, t, g, ph, s;
  for (i = 0; i < n && i0 + i < out.length; i++) {
    t = i / sr;
    if (t < 0.012) g = 0.0001 * Math.pow(amp / 0.0001, t / 0.012);
    else if (t < dur) g = amp * Math.pow(0.0001 / amp, (t - 0.012) / (dur - 0.012));
    else g = 0;
    ph = 2 * Math.PI * freq * t;
    s = type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
    out[i0 + i] += s * g;
  }
}

// The camera shutter: a real shutter is not one click but a quick "ka-chak": the mirror slaps up with a dull low thud and the first
// curtain opens with a sharp clack, a moment later the second curtain closes with a lighter, higher clack, then the mirror settles
// with a soft thump. Each part below is a burst of filtered noise, a low thud that drops in pitch, and a crisp tick on the very front.
function fxShutterRender() {
  var sr = FX_SR, out = new Float32Array(Math.round(0.26 * sr)), rnd = fxNoise(20241120), i, peak = 0;
  function clack(at, o) {
    var i0 = Math.round(at * sr), n = Math.min(out.length - i0, Math.round(0.16 * sr));
    var bp = fxBiquad('bp', o.bp, o.q, sr), hp = fxBiquad('hp', o.hp, 0.707, sr), tk = fxBiquad('hp', 3200, 0.707, sr);
    var ph = 0, k, t, x, f;
    for (k = 0; k < n; k++) {
      t = k / sr;
      x = 0;
      if (t < o.len) x += bp(hp(rnd())) * Math.pow(1 - t / o.len, o.pw) * o.lv * 3;                  // the clack itself
      if (t < o.td * 1.6) {                                                                          // the thud, falling in pitch
        f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / (o.td / 4));
        ph += 2 * Math.PI * f / sr;
        x += Math.sin(ph) * Math.min(1, t / 0.002) * Math.exp(-t / (o.td / 3)) * o.tl;
      }
      if (o.tick && t < 0.006) x += tk(rnd()) * (1 - t / 0.006) * o.tick * 1.5;                      // the crisp tick
      out[i0 + k] += x;
    }
  }
  // (The thud is kept modest: a tablet or laptop speaker plays no deep bass, so the clack and the tick carry the sound.)
  clack(0,     { len: 0.050, pw: 3.0, bp: 1100, q: 0.8, hp: 350, lv: 1.4,  f0: 260, f1: 70, td: 0.090, tl: 0.5,  tick: 0.7 });   // mirror up + first curtain
  clack(0.072, { len: 0.035, pw: 3.2, bp: 2100, q: 1.0, hp: 900, lv: 0.9,  f0: 200, f1: 85, td: 0.050, tl: 0.2,  tick: 0.5 });   // second curtain
  clack(0.125, { len: 0.050, pw: 2.4, bp: 650,  q: 0.8, hp: 250, lv: 0.25, f0: 120, f1: 60, td: 0.070, tl: 0.14, tick: 0 });     // mirror settles
  for (i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  var gain = peak > 0 ? 0.85 / peak : 1, fade = Math.round(0.012 * sr);
  for (i = 0; i < out.length; i++) {
    out[i] *= gain;
    if (i > out.length - fade) out[i] *= (out.length - i) / fade;
  }
  return out;
}

// kind: 'b1' (the last countdown beep), 'b2' (the other beeps), 'pose', 'chime' (start without touching), 'shut' (the shutter).
// The samples already hold their own level: play them at the booth's volume setting (fx.vol).
function fxSoundRender(kind) {
  var sr = FX_SR, out;
  if (kind === 'b1') { out = new Float32Array(Math.round(0.20 * sr)); fxTone(out, 988, 0.16, 'sine', 0.9, 0); }
  else if (kind === 'b2') { out = new Float32Array(Math.round(0.14 * sr)); fxTone(out, 740, 0.10, 'sine', 0.9, 0); }
  else if (kind === 'pose') { out = new Float32Array(Math.round(0.27 * sr)); fxTone(out, 1175, 0.09, 'triangle', 0.7, 0); fxTone(out, 1568, 0.14, 'triangle', 0.6, 0.08); }
  else if (kind === 'chime') { out = new Float32Array(Math.round(0.30 * sr)); fxTone(out, 880, 0.10, 'sine', 0.7, 0); fxTone(out, 1320, 0.16, 'sine', 0.6, 0.09); }
  else out = fxShutterRender();
  return out;
}
function fxSamples(kind) { return fxSoundCache[kind] || (fxSoundCache[kind] = fxSoundRender(kind)); }

// The same sound as a small WAV file (16-bit, mono), for the tablet guest screen.
function fxWavUrl(kind) {
  if (fxWavCache[kind]) return fxWavCache[kind];
  var s = fxSamples(kind), n = s.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf), i;
  function str(o, t) { for (var k = 0; k < t.length; k++) dv.setUint8(o + k, t.charCodeAt(k)); }
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, FX_SR, true); dv.setUint32(28, FX_SR * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(s[i] * 32767))), true);
  var u8 = new Uint8Array(buf), bin = '';
  for (i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return (fxWavCache[kind] = 'data:audio/wav;base64,' + btoa(bin));
}
