// Behaviour tests for the green screen keyer (protected/src/camera/chroma-key.js).
// Run: node scripts/test-chroma-key.mjs      (no camera, browser or network needed)
//
// These RUN the keyer on a made-up booth picture (cloth with a shadow and noise, a guest in a white shirt with black hair and
// green light on the edges) and compare it with a copy of the old keyer, so "seamless" is measured, not guessed:
//   - the cloth, including the shadowed part and a bright wrinkle, is replaced completely
//   - white, black and skin stay solid (the old keyer let ~6% of the new background through white)
//   - the edge has less green than the old keyer left
//   - the live view smooths from frame to frame and doesn't leave a trail
//   - blue screens and grey screens work, and the page uses this file
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'protected', 'src', 'camera', 'chroma-key.js'), 'utf8');
const page = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.message)); process.exitCode = 1; } };

const sb = { Math, Uint8Array, Uint8ClampedArray, Int32Array, Uint32Array, Float32Array, parseInt };
vm.createContext(sb);
vm.runInContext(src, sb);
const { ckRun } = sb;

// ---- the old keyer, kept here only to compare against ----
function oldKey(d, bd, w, h, hex, tol) {
  const r0 = parseInt(hex.slice(1, 3), 16), g0 = parseInt(hex.slice(3, 5), 16), b0 = parseInt(hex.slice(5, 7), 16);
  const kcb = 128 - 0.168736 * r0 - 0.331264 * g0 + 0.5 * b0, kcr = 128 + 0.5 * r0 - 0.418688 * g0 - 0.081312 * b0, isGreen = g0 >= b0, soft = 26 + tol * 0.25;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    let a = (Math.sqrt((cb - kcb) * (cb - kcb) + (cr - kcr) * (cr - kcr)) - tol) / soft; a = a <= 0 ? 0 : a >= 1 ? 1 : a;
    if (a === 0) { d[i] = bd[i]; d[i + 1] = bd[i + 1]; d[i + 2] = bd[i + 2]; continue; }
    if (isGreen) { const lim = r > b ? r : b; if (g > lim) g = lim; } else { const lim = r > g ? r : g; if (b > lim) b = lim; }
    d[i] = r * a + bd[i] * (1 - a); d[i + 1] = g * a + bd[i + 1] * (1 - a); d[i + 2] = b * a + bd[i + 2] * (1 - a);
  }
}

// ---- a made-up booth picture ----
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const W = 400, H = 300;
const SHIRT = [240, 240, 240], SKIN = [205, 155, 125], HAIR = [22, 16, 12];
// signed distance to the guest (negative inside): a head, a body, and a few thin hairs
function guest(x, y) {
  const head = Math.hypot(x - 200, y - 120) - 55;
  const body = (Math.hypot((x - 200) / 125, (y - 275) / 115) - 1) * 115;
  let s = Math.min(head, body);
  for (let k = 0; k < 6; k++) { const hx = 165 + k * 14, dist = Math.abs(x - (hx + (y - 60) * 0.05)); if (y < 70 && y > 40) s = Math.min(s, dist - 0.8); }   // thin hairs standing up
  return s;
}
function guestColour(x, y) { return y < 100 && Math.hypot(x - 200, y - 120) < 56 ? HAIR : Math.hypot(x - 200, y - 120) < 56 ? SKIN : SHIRT; }
function makeScene(cloth, seed, opts) {
  opts = opts || {};
  const rnd = rng(seed), d = new Uint8ClampedArray(W * H * 4), cov = new Float32Array(W * H);
  const dom = cloth[2] > cloth[1] ? 2 : 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = i * 4;
    let shade = 1.05 - 0.4 * (y / H);                                           // the cloth is darker lower down
    if (Math.abs((x - 300) + (y - 150) * 0.6) < 25) shade *= 0.5;               // a shadow of a fold
    const n = (rnd() - 0.5) * 12;
    let c = [cloth[0] * shade + n, cloth[1] * shade + n, cloth[2] * shade + n];
    if (x >= 60 && x < 66 && y >= 60 && y < 66) c = [150, 200, 150];            // a bright wrinkle: pale green, not quite the cloth
    const s = guest(x, y), a = Math.max(0, Math.min(1, 0.5 - s)); cov[i] = a;
    const f = guestColour(x, y).slice();
    if (s > -14) { const sp = (1 - Math.max(0, -s) / 14) * 45; f[dom] += sp; }  // green light from the cloth on the guest's edge
    for (let k = 0; k < 3; k++) d[j + k] = f[k] * a + c[k] * (1 - a);
    d[j + 3] = 255;
  }
  return { d, cov };
}
function flat(rgb, w, h) { const a = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < a.length; i += 4) { a[i] = rgb[0]; a[i + 1] = rgb[1]; a[i + 2] = rgb[2]; a[i + 3] = 255; } return a; }
const px = (d, x, y) => { const j = (y * W + x) * 4; return [d[j], d[j + 1], d[j + 2]]; };
const maxDiff = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
const GREEN = '#1eaa46', CLOTH = [30, 170, 70];
const sm = (rgb) => ({ data: flat(rgb, 8, 8), sw: 8, sh: 8 });

// New and old, on the same picture and a dark background (shows any see-through best)
const BG = [20, 20, 60];
const scene = makeScene(CLOTH, 7);
const neu = new Uint8ClampedArray(scene.d), old = new Uint8ClampedArray(scene.d);
const bd = flat(BG, W, H);
ckRun(neu, bd, sm(BG), W, H, { hex: GREEN, tol: 48, live: false }, {});
oldKey(old, bd, W, H, GREEN, 48);

test('the cloth is replaced completely, including the shadow and the bright wrinkle', () => {
  for (const [x, y] of [[20, 20], [370, 40], [20, 280], [340, 120], [300, 150], [63, 63], [380, 280]]) {
    const o = px(neu, x, y);
    assert(maxDiff(o, BG) <= 2, 'cloth at ' + x + ',' + y + ' still shows (' + o + ')');
  }
});
test('white, skin and black hair stay solid (no new background showing through)', () => {
  const shirt = px(neu, 200, 250), skin = px(neu, 200, 140), hair = px(neu, 200, 85);
  assert(maxDiff(shirt, SHIRT) <= 3, 'shirt ' + shirt + ' vs ' + SHIRT);
  assert(maxDiff(skin, SKIN) <= 4, 'skin ' + skin + ' vs ' + SKIN);
  assert(maxDiff(hair, HAIR) <= 4, 'hair ' + hair + ' vs ' + HAIR);
  const oldShirt = px(old, 200, 250);
  assert(maxDiff(oldShirt, SHIRT) > 8, 'expected the old keyer to leave the shirt see-through, got ' + oldShirt + ' (test scene is not exercising it)');
});
// Green tint on the guest's edge (3 px either side; green light further inside the guest is a lighting matter, see README), compared with the ideal result (the real guest colour mixed with the new background by how much
// of the pixel the guest covers). Positive = greener than it should be. Tint = g - (r+b)/2, which is what the eye sees as a green rim.
function rimTint(keyed, sc, bgRgb) {
  let sum = 0, worst = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = guest(x, y);
    if (s < -3 || s > 3) continue;                                           // the edge band (3 px either side)
    const i = y * W + x, j = i * 4, c = sc.cov[i], f = guestColour(x, y);
    const ideal = [0, 1, 2].map(k => f[k] * c + bgRgb[k] * (1 - c));
    const err = (keyed[j + 1] - (keyed[j] + keyed[j + 2]) / 2) - (ideal[1] - (ideal[0] + ideal[2]) / 2);
    sum += Math.max(0, err); worst = Math.max(worst, err); n++;
  }
  return { mean: sum / n, worst: worst };
}
test('the edge has less green than the old keyer left', () => {
  const GREY = [128, 128, 128], g = flat(GREY, W, H), a = new Uint8ClampedArray(scene.d), b = new Uint8ClampedArray(scene.d);
  ckRun(a, g, sm(GREY), W, H, { hex: GREEN, tol: 48, live: false }, {});
  oldKey(b, g, W, H, GREEN, 48);
  const nu = rimTint(a, scene, GREY), ol = rimTint(b, scene, GREY);
  console.log('      edge green tint, mean / worst:  new ' + nu.mean.toFixed(1) + ' / ' + nu.worst.toFixed(0) + '   old ' + ol.mean.toFixed(1) + ' / ' + ol.worst.toFixed(0));
  assert(ol.mean > 2, 'the test scene does not show the old green rim (' + ol.mean + ')');
  assert(nu.mean < ol.mean * 0.6, 'mean rim green ' + nu.mean + ' vs old ' + ol.mean);
});
test('skin with green light on it is not turned see-through', () => {
  // solid skin pixels inside the head (2+ px from the edge, below the hair) where the cloth's light has added green
  // (the soft background for the edge glow is skin-coloured here, so the glow changes nothing and only see-through shows)
  const GREY = [128, 128, 128], g = flat(GREY, W, H), a = new Uint8ClampedArray(scene.d), b = new Uint8ClampedArray(scene.d);
  ckRun(a, g, sm(SKIN), W, H, { hex: GREEN, tol: 48, live: false }, {});
  oldKey(b, g, W, H, GREEN, 48);
  let n = 0, seeNew = 0, seeOld = 0;
  for (let y = 105; y < 170; y++) for (let x = 100; x < 300; x++) {
    const s = guest(x, y); if (s > -2 || s < -13 || Math.hypot(x - 200, y - 120) > 54) continue;
    const j = (y * W + x) * 4; n++;
    if (a[j] < SKIN[0] - 12) seeNew++;
    if (b[j] < SKIN[0] - 12) seeOld++;
  }
  console.log('      solid skin pixels turned see-through: new ' + seeNew + ' of ' + n + '   old ' + seeOld + ' of ' + n);
  assert(seeNew <= n * 0.01, seeNew + ' of ' + n + ' became see-through');
  assert(seeNew < seeOld, 'not better than the old keyer');
});
test('the edge is soft: a few blended pixels across the edge, not a one-pixel cut', () => {
  // along rows through the head, count pixels that are neither the background nor the skin
  const width = (img) => { let tot = 0, rows = 0; for (let y = 105; y < 140; y += 5) for (const [x0, x1] of [[135, 160], [240, 265]]) { let c = 0; for (let x = x0; x < x1; x++) { const p = px(img, x, y); if (maxDiff(p, BG) > 12 && maxDiff(p, SKIN) > 12) c++; } tot += c; rows++; } return tot / rows; };
  const nw = width(neu), ow = width(old);
  console.log('      pixels across the edge: new ' + nw.toFixed(1) + '  old ' + ow.toFixed(1));
  assert(nw >= 2, 'edge is only ' + nw + ' px wide');
});
test('thin hairs keep their strength (the soft edge does not thin them out)', () => {
  // six 1.6 px white hairs standing up from the head; opacity = how far the pixel is from the background towards white
  const opacity = (img) => { let sum = 0, cnt = 0; for (let k = 0; k < 6; k++) { let best = 0; for (let dx = -2; dx <= 2; dx++) { const p = px(img, 165 + k * 14 + dx, 55); best = Math.max(best, (p[0] - BG[0]) / (SHIRT[0] - BG[0])); } sum += best; cnt++; } return sum / cnt; };
  const nu = opacity(neu), ol = opacity(old);
  console.log('      hair strength: new ' + nu.toFixed(2) + '  old ' + ol.toFixed(2));
  assert(nu >= 0.5 && nu > ol, 'hairs are only ' + (nu * 100).toFixed(0) + '% strong (old keyer ' + (ol * 100).toFixed(0) + '%)');   // the edge glow tints a hair toward the new background, so not 100%
});
test('a guest wearing the screen colour family is not touched when the hue is different (skin, yellow)', () => {
  const w2 = 60, h2 = 40, d = flat([230, 205, 60], w2, h2), big = flat(BG, w2, h2);
  // left half cloth, right half a yellow shirt
  for (let y = 0; y < h2; y++) for (let x = 0; x < 30; x++) { const j = (y * w2 + x) * 4; d[j] = 30; d[j + 1] = 170; d[j + 2] = 70; }
  ckRun(d, big, sm(BG), w2, h2, { hex: GREEN, tol: 48, live: false }, {});
  const left = [d[(20 * w2 + 5) * 4], d[(20 * w2 + 5) * 4 + 1], d[(20 * w2 + 5) * 4 + 2]], right = [d[(20 * w2 + 55) * 4], d[(20 * w2 + 55) * 4 + 1], d[(20 * w2 + 55) * 4 + 2]];
  assert(maxDiff(left, BG) <= 2, 'cloth side ' + left);
  assert(maxDiff(right, [230, 205, 60]) <= 8, 'yellow shirt changed to ' + right);
});
test('Strength: higher removes more of a pale cloth; lower keeps more', () => {
  const pale = [150, 200, 150];
  const run = (tol) => { const d = flat(pale, 40, 40), b = flat(BG, 40, 40); const p = flat([128, 128, 128], 40, 40); for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) { const j = (y * 40 + x) * 4; d[j] = p[j]; d[j + 1] = p[j + 1]; d[j + 2] = p[j + 2]; } ckRun(d, b, sm(BG), 40, 40, { hex: GREEN, tol, live: false }, {}); const j = (20 * 40 + 35) * 4; return d[j]; };
  assert(run(90) < run(20), 'pale pixel at strength 90 = ' + run(90) + ', at 20 = ' + run(20));
});
test('live view: smoother between frames than photos, and a moving guest leaves no trail', () => {
  const st = {}, still = {};
  let jitterLive = 0, jitterStill = 0, prevL = null, prevS = null;
  for (let f = 0; f < 6; f++) {
    const sc = makeScene(CLOTH, 100 + f), a = new Uint8ClampedArray(sc.d), b = new Uint8ClampedArray(sc.d);
    ckRun(a, bd, sm(BG), W, H, { hex: GREEN, tol: 48, live: true, now: f * 40 }, st);
    ckRun(b, bd, sm(BG), W, H, { hex: GREEN, tol: 48, live: false }, still);
    if (prevL) for (let y = 40; y < 280; y++) for (let x = 100; x < 300; x++) { const j = (y * W + x) * 4; if (Math.abs(guest(x, y)) < 3) { jitterLive += Math.abs(a[j] - prevL[j]); jitterStill += Math.abs(b[j] - prevS[j]); } }
    prevL = a; prevS = b;
  }
  console.log('      frame-to-frame change on the edge: live ' + jitterLive + '  photo-mode ' + jitterStill);
  assert(jitterLive <= jitterStill, 'live ' + jitterLive + ' vs ' + jitterStill);
  // the guest is gone in the next frame (only cloth): after one frame there must be no ghost left
  const empty = makeScene(CLOTH, 5), cloth = new Uint8ClampedArray(empty.d.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const j = (y * W + x) * 4; for (let k = 0; k < 3; k++) cloth[j + k] = CLOTH[k]; cloth[j + 3] = 255; }
  ckRun(cloth, bd, sm(BG), W, H, { hex: GREEN, tol: 48, live: true, now: 6 * 40 }, st);
  assert(maxDiff(px(cloth, 200, 250), BG) <= 3 && maxDiff(px(cloth, 200, 140), BG) <= 3, 'a ghost of the guest stayed: ' + px(cloth, 200, 250) + ' ' + px(cloth, 200, 140));
});
test('blue screen works the same way', () => {
  const BLUE = [20, 70, 185], sc = makeScene(BLUE, 3), d = new Uint8ClampedArray(sc.d);
  ckRun(d, bd, sm(BG), W, H, { hex: '#1446b9', tol: 48, live: false }, {});
  assert(maxDiff(px(d, 20, 20), BG) <= 2 && maxDiff(px(d, 340, 120), BG) <= 2, 'blue cloth still shows');
  assert(maxDiff(px(d, 200, 250), SHIRT) <= 3 && maxDiff(px(d, 200, 140), SKIN) <= 4, 'guest changed');
});
test('a grey / white screen colour (picked by mistake) still runs and keys the grey', () => {
  const GREYCLOTH = [128, 128, 128], sc = makeScene(GREYCLOTH, 3), d = new Uint8ClampedArray(sc.d);
  ckRun(d, bd, sm(BG), W, H, { hex: '#808080', tol: 48, live: false }, {});
  assert(maxDiff(px(d, 20, 20), BG) <= 8, 'grey cloth ' + px(d, 20, 20));
});
test('nobody in front of the cloth, and a picture that is all guest: no crash, no wipe-out', () => {
  const empty = flat(CLOTH, 80, 60), allGuest = flat([200, 150, 120], 80, 60), b = flat(BG, 80, 60);
  ckRun(empty, b, sm(BG), 80, 60, { hex: GREEN, tol: 48, live: false }, {});
  ckRun(allGuest, b, sm(BG), 80, 60, { hex: GREEN, tol: 48, live: false }, {});
  assert(maxDiff([empty[0], empty[1], empty[2]], BG) <= 2, 'empty cloth not replaced');
  assert(maxDiff([allGuest[100], allGuest[101], allGuest[102]], [200, 150, 120]) <= 3, 'guest wiped');
});
test('a big photo (1920x1080) keys in a reasonable time', () => {
  const w = 1920, h = 1080, d = flat(CLOTH, w, h), b = flat(BG, w, h), t0 = Date.now();
  ckRun(d, b, sm(BG), w, h, { hex: GREEN, tol: 48, live: false }, {});
  const ms = Date.now() - t0; console.log('      1920x1080: ' + ms + ' ms');
  assert(ms < 4000, ms + ' ms');
});
test('the page uses this file, and the page on disk is what the sources build', () => {
  assert(page.includes('function ckRun(') && page.includes('function ckMatte('), 'chroma-key.js is not in booth.html');
  assert(page.includes('ckRun(fg.data, bgPixels(w, h), bgSmall(w, h)'), 'chromaKey() does not call ckRun');
  assert(!page.includes('function keyCbCr('), 'the old keyer is still in the page');
  assert(page.includes('chromaKey(x, w, h, true)'), 'live view does not use the live smoothing');
  const built = assemble();
  assert(built && built.html === page, 'protected/booth.html is not what protected/src builds: run npm run build');
});
console.log(passed + ' passed');
