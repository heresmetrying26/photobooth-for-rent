// Runs the REAL protected/src/sound/fx-sounds.js (the booth's built-in beeps, chimes and camera shutter) and checks the samples:
// right length and loudness, no broken numbers, the same every time, a valid WAV file for the tablet, and that the shutter is
// really "ka-chak" (a loud first clack, a second clack about 70 ms later, a soft thump after that) and not one plain click.
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = () => {
  const ctx = { Math, Float32Array, ArrayBuffer, DataView, Uint8Array, String, Number, btoa };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(ROOT, 'protected', 'src', 'sound', 'fx-sounds.js'), 'utf8'), ctx);
  return ctx;
};
const A = load(), B = load();
const SR = 44100;

for (const [kind, sec] of [['shut', 0.26], ['b1', 0.2], ['b2', 0.14], ['pose', 0.27], ['chime', 0.3]]) {
  const s = A.fxSamples(kind);
  assert.equal(s.length, Math.round(sec * SR), kind + ' has the right length');
  let peak = 0, bad = 0, nonZero = 0;
  for (let i = 0; i < s.length; i++) { if (!Number.isFinite(s[i])) bad++; peak = Math.max(peak, Math.abs(s[i])); if (Math.abs(s[i]) > 1e-4) nonZero++; }
  assert.equal(bad, 0, kind + ' has no broken numbers');
  assert(peak > 0.2 && peak <= 0.9, kind + ' is loud enough and does not clip (peak ' + peak.toFixed(3) + ')');
  assert(nonZero > s.length * 0.2, kind + ' is not mostly silence');
  // the same samples every time (the tablet and the laptop must sound alike, and every shot sounds the same)
  const t = B.fxSamples(kind);
  let same = true; for (let i = 0; i < s.length; i++) if (s[i] !== t[i]) { same = false; break; }
  assert(same, kind + ' is the same on every render');
  // a valid WAV file
  const url = A.fxWavUrl(kind);
  assert(url.startsWith('data:audio/wav;base64,'));
  const wav = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE'); assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(24), SR, kind + ' WAV sample rate'); assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(40), s.length * 2); assert.equal(wav.length, 44 + s.length * 2);
}
console.log('PASS: built-in sounds are the right size, loud enough, steady and valid WAV files');

// The shutter: energy per 5 ms
{
  const s = A.fxSamples('shut'), step = Math.round(0.005 * SR), rms = [];
  for (let i = 0; i + step <= s.length; i += step) { let e = 0; for (let j = i; j < i + step; j++) e += s[j] * s[j]; rms.push(Math.sqrt(e / step)); }
  const at = (ms) => rms[Math.round(ms / 5)];
  assert(at(0) > 0.1, 'a loud first clack right at the start');
  assert(at(72) > at(60) * 2 && at(72) > 0.05, 'a second clack about 70 ms later, clearly separate from the first');
  assert(at(72) < at(0), 'the second clack is lighter than the first');
  assert(at(125) > at(110) && at(125) > 0.02, 'a soft thump after the two clacks');
  assert(at(125) < at(72), 'and it is softer than the second clack');
  assert(at(240) < 0.01, 'it ends cleanly');
  // most of the energy is in the clack (above 800 Hz), not in the bass a small speaker cannot play
  const hp = A.fxBiquad('hp', 800, 0.707, SR);
  let eh = 0, et = 0; for (let i = 0; i < Math.round(0.11 * SR); i++) { const y = hp(s[i]); eh += y * y; et += s[i] * s[i]; }
  assert(eh / et > 0.3, 'enough of the shutter is above 800 Hz to be heard on a tablet or laptop speaker (' + (eh / et).toFixed(2) + ')');
  // it is not as loud as a clipped click but at least as loud as the beeps
  let pk = 0; for (const v of s) pk = Math.max(pk, Math.abs(v));
  let pb = 0; for (const v of A.fxSamples('b1')) pb = Math.max(pb, Math.abs(v));
  assert(pk > pb, 'the shutter is louder than a beep');
  console.log('PASS: the shutter is a double clack with a soft thump, not one plain click');
}

// The beeps keep the shape the booth always had: rise in 12 ms, fall away at the end
{
  const s = A.fxSamples('b1');
  assert(Math.abs(s[0]) < 0.001, 'starts from silence');
  let k = 0; for (let i = 0; i < Math.round(0.02 * SR); i++) k = Math.max(k, Math.abs(s[i]));
  assert(k > 0.3, 'full level within 20 ms');
  assert(Math.abs(s[Math.round(0.17 * SR)]) < 0.001, 'silent after the beep');
  console.log('PASS: the countdown beeps keep their old shape');
}
console.log('All sound tests passed!');
