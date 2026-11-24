import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

console.log('--- Testing Phase 1-3: Spot Rotation (0/90/180/270), Auto-Sectioning & Landscape 4-in-1 Collage ---');

const boothHtmlPath = resolve('protected/booth.html');
const netlifyBoothPath = resolve('netlify/lib/booth.mjs');
const androidBoothPath = resolve('android/app/src/main/assets/booth.html');
const iosBoothPath = resolve('ios/photobooth4u/booth.html');

assert(existsSync(boothHtmlPath), 'protected/booth.html must exist');
assert(existsSync(netlifyBoothPath), 'netlify/lib/booth.mjs must exist');
assert(existsSync(androidBoothPath), 'android booth.html must exist');
assert(existsSync(iosBoothPath), 'ios booth.html must exist');

const html = readFileSync(boothHtmlPath, 'utf8');

// 1. Validate JS syntax of every inline <script> block in protected/booth.html
console.log('1. Validating JS syntax across all script blocks...');
const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
let sm, scriptCount = 0;
while ((sm = scriptRe.exec(html)) !== null) {
  const src = sm[1].trim();
  if (!src) continue;
  scriptCount++;
  new vm.Script(src, { filename: 'booth.html#script-' + scriptCount });
}
assert(scriptCount >= 5, 'Expected multiple script blocks in booth.html');
console.log('   OK: ' + scriptCount + ' script blocks parse cleanly');

// 2. Verify Phase 1, 2 & 3 UI markup & symbols exist in built bundle
console.log('2. Checking UI controls and engine symbols...');
for (const marker of [
  'id="spotRotRow"',
  'data-spot-rot="270"',
  'id="spotSecBox"',
  'id="spotAutoSec"',
  'id="spotSecPreset"',
  'id="spotSecChips"',
  'id="spotSecRotRow"',
  'id="spotRec3"',
  'id="spotRec4"',
  'id="spotRecAll"',
  'id="spotShowSec"',
  'id="sheetOrientRow"',
  'id="sheetOrientLand"',
  'id="sheetBleedChk"',
  'id="pmSpRotBtns"',
  'function normalizeSpotRot',
  'function spotsKey(',
  'function detectFrameSections',
  'function autoSectionFrame',
  'function applySectionBlueprint',
  'function applySectionShotRecipe',
  'function rotateSectionSpots',
  'function sectionDestBox',
  'function moveSplicedSection',
  'function setSplicedSectionRot',
  'function rotateSplicedSection',
  'function resetSplicedSection',
  'function resetAllSplicedSections',
  'function drawSplicedFrameImage',
  'id="spotSecArtRotRow"',
  'function reconcileFrameSections',
  'function uniqueFrameSections',
  'function renderUprightSection',
  'function transformSpotToUprightSection',
  'function splitFrameIntoSections',
  'function saveSectionCutsAsync',
  "id: '4in1'",
  'window.__frameSections'
]) {
  assert(html.includes(marker), 'Missing expected marker in protected/booth.html: ' + marker);
}

// 3. Extract and execute the real production frame/section/collage functions from protected/booth.html
console.log('3. Running live unit tests on extracted production functions...');
const startIdx = html.indexOf('var myFrames = [];');
const endIdx = html.indexOf('function punchFrame(');
const snapStart = html.indexOf('function framesSnapshot()');
const snapEnd = html.indexOf('// ---- Setup preview: sample photo + phone dock ----');
const fitStart = html.indexOf('// ---- Arranging frames on the 4R sheet ----');
const fitEnd = html.indexOf('// Tick / untick a frame in "Your frames".');

assert(startIdx > 0 && endIdx > startIdx, 'Could not locate frame/section code block');
assert(snapStart > 0 && snapEnd > snapStart, 'Could not locate framesSnapshot/applyFramesSetup block');
assert(fitStart > 0 && fitEnd > fitStart, 'Could not locate sheet arrangement block');

const papers = {
  '4x6': { name: '4×6 (4R)', w: 101.6, h: 152.4 },
  '5x7': { name: '5×7 (5R)', w: 127, h: 177.8 },
  A4: { name: 'A4', w: 210, h: 297 }
};

const harness = `
var window = {};
var document = { getElementById: function () { return null; } };
function paperFor(k) { return papers[k] || papers['4x6']; }
function spotsKey(f) {
  return f.spots.map(function (s) {
    return [s.x, s.y, s.w, s.h].map(function (v) { return v.toFixed(4); }).join(',')
      + (s.a ? '@' + s.a : '') + (s.r ? 'r' + normalizeSpotRot(s.r) : '') + (s.z ? '^' + s.z : '');
  }).join(';');
}
function showToast() {}
function scheduleSetupSave() {}
function buildLayoutPicker() {}
function buildSheetPatterns() {}
function buildFramePick() {}
function buildSheetPresetUI() {}
function framesChanged() {}
var currentLayout = 'myframe';
var setupLayout = 'myframe';
var setupActiveFrameId = null;
${html.slice(startIdx, endIdx)}
${html.slice(fitStart, fitEnd)}
${html.slice(snapStart, snapEnd)}
module.exports = {
  getState: function () { return { myFrames, activeFrameId, sheet, sheetPresets, sheetSize }; },
  setState: function (o) {
    if (o.myFrames) myFrames = o.myFrames;
    if (o.activeFrameId !== undefined) activeFrameId = o.activeFrameId;
    if (o.sheet) sheet = o.sheet;
    if (o.sheetSize) sheetSize = o.sheetSize;
  },
  SW, SH, SHEET_PATTERNS, patternCells, fitItem, assignCells, applyPattern, bestPatternFor,
  normalizeSpotRot, spotRotLabel, sortSpotIndicesUpright,
  detectFrameSections, autoSectionFrame, applySectionBlueprint, applySectionShotRecipe,
  rotateSectionSpots, sectionDestBox, moveSplicedSection, setSplicedSectionRot, rotateSplicedSection,
  resetSplicedSection, resetAllSplicedSections, bringSectionToFront, drawSplicedFrameImage,
  reconcileFrameSections, uniqueFrameSections, transformSpotToUprightSection,
  frameStrips, frameCopyStrip, frameShotCount, framePairs, spotsKey,
  cloneFrameSpot, assignFrameSpotShot,
  framesSnapshot, applyFramesSetup
};
`;

const sandbox = {
  papers,
  module: { exports: {} },
  console, Math, Array, Object, Number, String, Uint8Array, Int32Array, Float32Array, Uint8ClampedArray, isFinite
};
vm.runInNewContext(harness, sandbox);
const api = sandbox.module.exports;

// 3a. normalizeSpotRot & spotRotLabel
assert.equal(api.normalizeSpotRot(0), 0);
assert.equal(api.normalizeSpotRot(90), 90);
assert.equal(api.normalizeSpotRot(-90), 270);
assert.equal(api.normalizeSpotRot(180), 180);
assert.equal(api.normalizeSpotRot(-180), 180);
assert.equal(api.normalizeSpotRot(270), 270);
assert.equal(api.normalizeSpotRot(360), 0);
assert.equal(api.spotRotLabel(270), '-90°');
assert.equal(api.spotRotLabel(90), '+90°');
assert.equal(api.spotRotLabel(180), '180°');
assert.equal(api.spotRotLabel(0), '0°');

// 3b. Client's 4-in-1 Landscape 6x4 (1 Polaroid + 1 Mini Wallet + 2x3-shot Mini Strips)
console.log('4. Testing 4-in-1 Landscape (3-shot strips)...');
const f4in1 = {
  id: 'aFrame4in1001',
  name: 'Ronny 40 4in1',
  w: 1800,
  h: 1200,
  spots: [
    { x: 0.043, y: 0.070, w: 0.412, h: 0.739 },   // Polaroid (big bottom chin)
    { x: 0.533, y: 0.050, w: 0.376, h: 0.411 },   // Mini Wallet (big right chin -> -90)
    { x: 0.522, y: 0.537, w: 0.128, h: 0.193 },   // Strip 1 #1
    { x: 0.669, y: 0.537, w: 0.127, h: 0.193 },   // Strip 1 #2
    { x: 0.816, y: 0.537, w: 0.126, h: 0.193 },   // Strip 1 #3 (right footer -> -90)
    { x: 0.522, y: 0.782, w: 0.128, h: 0.192 },   // Strip 2 #1
    { x: 0.670, y: 0.782, w: 0.126, h: 0.192 },   // Strip 2 #2
    { x: 0.816, y: 0.782, w: 0.126, h: 0.192 }    // Strip 2 #3
  ]
};
const secs4 = api.autoSectionFrame(f4in1, null);
assert.equal(secs4.length, 4, '4-in-1 landscape must detect 4 sections');
assert.equal(secs4[0].kind, 'polaroid');
assert.equal(secs4[0].r, 0, 'Polaroid must be 0° upright');
assert.equal(secs4[1].kind, 'wallet');
assert.equal(secs4[1].r, 270, 'Mini Wallet with right chin must auto-rotate -90° (270)');
assert.equal(secs4[2].kind, 'strip');
assert.equal(secs4[2].r, 270, 'Mini Strip 1 must auto-rotate -90° (270)');
assert.deepEqual(Array.from(secs4[2].spots), [2, 3, 4], 'Mini Strip 1 spots ordered left-to-right for -90°');
assert.equal(secs4[3].kind, 'strip');
assert.equal(secs4[3].r, 270, 'Mini Strip 2 must auto-rotate -90° (270)');
assert.deepEqual(Array.from(secs4[3].spots), [5, 6, 7], 'Mini Strip 2 spots ordered left-to-right for -90°');
assert.equal(api.frameShotCount(f4in1), 3, '4-in-1 auto-links duplicate strips to 3 shots');
assert.equal(f4in1.spots[0].r || 0, 0);
for (let i = 1; i <= 7; i++) assert.equal(f4in1.spots[i].r, 270, 'Spot ' + i + ' must be rotated 270°');

// Verify uniqueFrameSections skips duplicate Mini Strip 2
const uniq4 = api.uniqueFrameSections(f4in1);
assert.equal(uniq4.length, 3, 'Unique cuts should be Polaroid + Mini Wallet + 1 Mini Strip (skip duplicate strip)');

// Verify transformSpotToUprightSection turns Mini Wallet into upright centered portrait
const upWalletSpot = api.transformSpotToUprightSection(f4in1.spots[1], secs4[1]);
assert.equal(upWalletSpot.r || 0, 0, 'Transformed spot in upright wallet frame must have r=0');
assert(upWalletSpot.y < 0.15, 'Top margin of upright wallet should be smaller than bottom chin');
assert(1 - (upWalletSpot.y + upWalletSpot.h) > upWalletSpot.y * 1.4, 'Bottom chin should stay at bottom after +90° upright cut');

// Verify Shot recipes (4shots, all, 3shots)
api.applySectionShotRecipe(f4in1, '4shots');
assert.equal(api.frameShotCount(f4in1), 4, '4shots recipe must require 4 shots');
assert.equal(f4in1.spots[1].s, 4, 'Wallet gets distinct shot #4 in 4shots recipe');
api.applySectionShotRecipe(f4in1, 'all');
assert.equal(api.frameShotCount(f4in1), 8, 'all recipe must require 8 separate shots');
api.applySectionShotRecipe(f4in1, '3shots');
assert.equal(api.frameShotCount(f4in1), 3, '3shots recipe returns to 3 shots');

// Verify rotateSectionSpots flips Mini Strip 1 from -90° to +90° and reverses upright spot order
api.rotateSectionSpots(f4in1, 2, 90);
assert.equal(f4in1.sections[2].r, 90);
assert.deepEqual(Array.from(f4in1.sections[2].spots), [4, 3, 2], 'Flipping strip to +90° reverses upright reading order to right-to-left');
assert.equal(f4in1.spots[4].s, 1, 'Rightmost box becomes shot #1 when strip is +90°');
api.rotateSectionSpots(f4in1, 2, 270); // restore -90°

// 3c. 4-in-1 Landscape with 4-shot mini strips (10 spots)
console.log('5. Testing 4-in-1 Landscape (4-shot mini strips)...');
const f4x4 = {
  id: 'aFrame4in1002', w: 1800, h: 1200,
  spots: [
    { x: 0.04, y: 0.06, w: 0.41, h: 0.75 },
    { x: 0.53, y: 0.05, w: 0.37, h: 0.41 },
    { x: 0.52, y: 0.54, w: 0.09, h: 0.19 }, { x: 0.625, y: 0.54, w: 0.09, h: 0.19 },
    { x: 0.73, y: 0.54, w: 0.09, h: 0.19 }, { x: 0.835, y: 0.54, w: 0.09, h: 0.19 },
    { x: 0.52, y: 0.78, w: 0.09, h: 0.19 }, { x: 0.625, y: 0.78, w: 0.09, h: 0.19 },
    { x: 0.73, y: 0.78, w: 0.09, h: 0.19 }, { x: 0.835, y: 0.78, w: 0.09, h: 0.19 }
  ]
};
const secs4x4 = api.autoSectionFrame(f4x4, null);
assert.equal(secs4x4.length, 4, '4-shot 4-in-1 must detect 4 sections');
assert.equal(api.frameShotCount(f4x4), 4, '4-shot 4-in-1 must auto-link to 4 shots');

// 3d. Classic 2x6 double vertical strip (6 spots on portrait 4x6)
console.log('6. Testing classic 2x6 double vertical strip & 2 horizontal strips...');
const fDoubleV = {
  id: 'aDoubleVert01', w: 1200, h: 1800,
  spots: [
    { x: 0.05, y: 0.04, w: 0.40, h: 0.24 }, { x: 0.05, y: 0.30, w: 0.40, h: 0.24 }, { x: 0.05, y: 0.56, w: 0.40, h: 0.24 },
    { x: 0.55, y: 0.04, w: 0.40, h: 0.24 }, { x: 0.55, y: 0.30, w: 0.40, h: 0.24 }, { x: 0.55, y: 0.56, w: 0.40, h: 0.24 }
  ]
};
const secsV = api.autoSectionFrame(fDoubleV, null);
assert.equal(secsV.length, 2, 'Double vertical strip detects 2 strips');
assert.equal(secsV[0].r, 0);
assert.equal(secsV[1].r, 0);
assert.equal(api.frameShotCount(fDoubleV), 3);

// 2 horizontal strips stacked top/bottom on landscape 6x4
const fDoubleH = {
  id: 'aDoubleHorz01', w: 1800, h: 1200,
  spots: [
    { x: 0.04, y: 0.06, w: 0.25, h: 0.38 }, { x: 0.32, y: 0.06, w: 0.25, h: 0.38 }, { x: 0.60, y: 0.06, w: 0.25, h: 0.38 },
    { x: 0.04, y: 0.56, w: 0.25, h: 0.38 }, { x: 0.32, y: 0.56, w: 0.25, h: 0.38 }, { x: 0.60, y: 0.56, w: 0.25, h: 0.38 }
  ]
};
const secsH = api.autoSectionFrame(fDoubleH, null);
assert.equal(secsH.length, 2, 'Double horizontal strip detects 2 horizontal strips');
assert.equal(secsH[0].r, 270);
assert.equal(secsH[1].r, 270);
assert.equal(api.frameShotCount(fDoubleH), 3);

// Regular 2x2 Grid must NOT false-split without duplicate artwork
const fGrid4 = {
  id: 'aRegularGrid4', w: 1200, h: 1800,
  spots: [
    { x: 0.05, y: 0.05, w: 0.43, h: 0.38 }, { x: 0.52, y: 0.05, w: 0.43, h: 0.38 },
    { x: 0.05, y: 0.46, w: 0.43, h: 0.38 }, { x: 0.52, y: 0.46, w: 0.43, h: 0.38 }
  ]
};
assert.equal(api.autoSectionFrame(fGrid4, null).length, 0, 'Regular 2x2 Grid should stay whole frame (0 sections)');
assert.equal(api.frameShotCount(fGrid4), 4);

// 3e. Section blueprint preset (4in1-port)
console.log('7. Testing section blueprints & Phase 3C landscape 4-in-1 framesheet...');
const fPort4in1 = {
  id: 'aPort4in10001', w: 1200, h: 1800,
  spots: [
    { x: 0.06, y: 0.04, w: 0.74, h: 0.41 },       // Top Polaroid sideways (+90)
    { x: 0.05, y: 0.54, w: 0.40, h: 0.36 },       // Bottom-left Wallet
    { x: 0.53, y: 0.53, w: 0.19, h: 0.12 }, { x: 0.53, y: 0.67, w: 0.19, h: 0.12 }, { x: 0.53, y: 0.81, w: 0.19, h: 0.12 },
    { x: 0.78, y: 0.53, w: 0.19, h: 0.12 }, { x: 0.78, y: 0.67, w: 0.19, h: 0.12 }, { x: 0.78, y: 0.81, w: 0.19, h: 0.12 }
  ]
};
api.applySectionBlueprint(fPort4in1, '4in1-port');
assert.equal(fPort4in1.sections.length, 4);
assert.equal(fPort4in1.spots[0].r, 90, 'Top Polaroid in portrait 4-in-1 gets +90°');
assert.equal(fPort4in1.spots[1].r || 0, 0, 'Bottom-left Wallet stays upright');
assert.equal(api.frameShotCount(fPort4in1), 3);

// 3f. Phase 3C: Landscape Frame Collage (framesheet) + 4in1 pattern + bleed + persistence round-trip
f4in1.saveCuts = true;
const sepPolaroid = { id: 'aSepPolaroid1', name: 'Polaroid', w: 900, h: 1200, spots: [{ x: 0.08, y: 0.07, w: 0.84, h: 0.74 }] };
const sepWallet = { id: 'aSepWallet001', name: 'Mini Wallet', w: 600, h: 900, spots: [{ x: 0.08, y: 0.06, w: 0.84, h: 0.75 }] };
const sepStrip = { id: 'aSepStrip0001', name: 'Mini Strip', w: 300, h: 900, spots: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.25 }, { x: 0.1, y: 0.34, w: 0.8, h: 0.25 }, { x: 0.1, y: 0.63, w: 0.8, h: 0.25 }] };
api.setState({
  myFrames: [f4in1, sepPolaroid, sepWallet, sepStrip],
  activeFrameId: f4in1.id,
  sheetSize: '4x6',
  sheet: { pattern: '4in1', orient: 'landscape', bleed: true, items: [] }
});
assert.equal(api.SW(), 1800, 'Landscape 4x6 SW() must be 1800');
assert.equal(api.SH(), 1200, 'Landscape 4x6 SH() must be 1200');
api.applyPattern('4in1', [sepPolaroid.id, sepWallet.id, sepStrip.id]);
const stAfter = api.getState();
assert.equal(stAfter.sheet.items.length, 4, '4-in-1 pattern creates 4 items on sheet');
assert.equal(stAfter.sheet.items[0].f, sepPolaroid.id, 'Left 3x4 slot picks Polaroid');
assert.equal(stAfter.sheet.items[0].r, 0, 'Left Polaroid sits upright (0°)');
assert.equal(stAfter.sheet.items[1].f, sepWallet.id, 'Top-right 3x2 slot picks Mini Wallet');
assert.equal(stAfter.sheet.items[1].r, 270, 'Top-right Mini Wallet auto-rotates -90° (270)');
assert.equal(stAfter.sheet.items[2].f, sepStrip.id, 'Bottom-right strip 1 picks Mini Strip');
assert.equal(stAfter.sheet.items[2].r, 270, 'Bottom-right strip 1 auto-rotates -90° (270)');
assert.equal(stAfter.sheet.items[3].f, sepStrip.id, 'Bottom-right strip 2 duplicates Mini Strip');
assert.equal(stAfter.sheet.items[3].r, 270, 'Bottom-right strip 2 auto-rotates -90° (270)');
// Verify bleed=true gives exact edge-to-edge width (s = 0.5 for left Polaroid!)
assert(Math.abs(stAfter.sheet.items[0].s - 0.5) < 0.001, 'Bleed mode fits Polaroid edge-to-edge (s=0.5)');

// 3g. Round-trip framesSnapshot() -> applyFramesSetup()
console.log('8. Testing framesSnapshot() <-> applyFramesSetup() round-trip...');
const snap = api.framesSnapshot();
api.applyFramesSetup(snap);
const restored = api.getState();
const rf = restored.myFrames.find((x) => x.id === f4in1.id);
assert(rf, 'Restored 4-in-1 frame must exist');
assert.equal(rf.saveCuts, true, 'saveCuts flag must survive round-trip');
assert.equal(rf.sections.length, 4, '4 sections must survive round-trip');
assert.equal(rf.spots[1].r, 270, 'Spot rotation sp.r=270 must survive round-trip');
assert.equal(restored.sheet.orient, 'landscape', 'sheet.orient must survive round-trip');
assert.equal(restored.sheet.bleed, true, 'sheet.bleed must survive round-trip');
assert.equal(restored.sheet.pattern, '4in1', '4in1 pattern must survive round-trip');

// 3h. Check spotsKey invalidates when sp.r changes
const kBefore = api.spotsKey(rf);
rf.spots[1].r = 90;
const kAfter = api.spotsKey(rf);
assert.notEqual(kBefore, kAfter, 'spotsKey must change when sp.r changes');

// 3i. Check reconcileFrameSections after spot removal
const beforeLen = rf.sections[2].spots.length;
rf.spots.splice(2, 1);
api.reconcileFrameSections(rf);
assert.equal(rf.sections[2].spots.length, beforeLen - 1, 'reconcileFrameSections updates indices after spot delete');
assert(rf.sections.every((sec) => sec.spots.every((idx) => idx >= 0 && idx < rf.spots.length)), 'All section spot indices stay in bounds');

// 3j. Multi-color 4-in-1 regression (Black Polaroid + Grey Wallet + Royal Blue Strip 1 + Dark Navy Strip 2)
console.log('9. Testing multi-color 4-in-1 (different colored mini strips)...');
{
  const W = 360, H = 240;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const paint = (x0, y0, x1, y1, r, g, b) => {
    for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++)
      for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x++) {
        const o = (y * W + x) * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      }
  };
  paint(0, 0, 0.5, 1, 5, 5, 5);           // Black Polaroid
  paint(0.5, 0, 1, 0.5, 85, 85, 85);      // Grey Wallet
  paint(0.5, 0.5, 1, 0.75, 10, 75, 200);  // Royal Blue Mini Strip 1
  paint(0.5, 0.75, 1, 1, 20, 35, 70);     // Dark Navy Mini Strip 2
  const mSpots = [
    { x: 0.043, y: 0.070, w: 0.412, h: 0.735 },
    { x: 0.533, y: 0.048, w: 0.376, h: 0.413 },
    { x: 0.521, y: 0.537, w: 0.128, h: 0.194 },
    { x: 0.670, y: 0.537, w: 0.126, h: 0.194 },
    { x: 0.816, y: 0.537, w: 0.126, h: 0.194 },
    { x: 0.521, y: 0.782, w: 0.128, h: 0.192 },
    { x: 0.670, y: 0.782, w: 0.126, h: 0.192 },
    { x: 0.816, y: 0.782, w: 0.126, h: 0.192 }
  ];
  mSpots.forEach((sp) => paint(sp.x, sp.y, sp.x + sp.w, sp.y + sp.h, 255, 255, 255));
  // Provide canvas factory inside sandbox for pixel sampling
  const makeMockCanvas = () => {
    const cv = { width: 0, height: 0, _rgba: null };
    cv.getContext = () => ({
      drawImage(src) {
        const cw = cv.width, ch = cv.height, out = new Uint8ClampedArray(cw * ch * 4);
        for (let y = 0; y < ch; y++) {
          const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * src.height / ch));
          for (let x = 0; x < cw; x++) {
            const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * src.width / cw));
            const si = (sy * src.width + sx) * 4, di = (y * cw + x) * 4;
            out[di] = src._rgba[si]; out[di + 1] = src._rgba[si + 1]; out[di + 2] = src._rgba[si + 2]; out[di + 3] = 255;
          }
        }
        cv._rgba = out;
      },
      getImageData() { return { data: cv._rgba }; }
    });
    return cv;
  };
  sandbox.document.createElement = makeMockCanvas;
  const mockImg = { width: W, height: H, _rgba: rgba };
  const fMulti = { id: 'aMultiColor01', w: 1024, h: 682, spots: mSpots };
  const mSecs = api.autoSectionFrame(fMulti, mockImg);
  assert.equal(mSecs.length, 4, 'Multi-color 4-in-1 must split into 4 sections (not 5 vertical columns)');
  assert.equal(mSecs[0].kind, 'polaroid'); assert.equal(mSecs[0].r, 0);
  assert.equal(mSecs[1].kind, 'wallet');   assert.equal(mSecs[1].r, 270);
  assert.equal(mSecs[2].kind, 'strip');    assert.equal(mSecs[2].r, 270);
  assert.equal(mSecs[3].kind, 'strip');    assert.equal(mSecs[3].r, 270);
  assert.deepEqual(Array.from(mSecs[2].spots), [2, 3, 4], 'Royal Blue strip must group horizontal spots [2,3,4]');
  assert.deepEqual(Array.from(mSecs[3].spots), [5, 6, 7], 'Dark Navy strip must group horizontal spots [5,6,7]');
  assert.equal(api.frameShotCount(fMulti), 3, 'Multi-color 4-in-1 auto-links to 3 shots');
  assert.equal(api.uniqueFrameSections(fMulti, mockImg).length, 4, 'Different-colored strips must BOTH be kept in unique QR/Split cuts');

  // 3k. Option A: Rigid Move & Rotate spliced sections (size locked, zero stretching) without splitting into separate frames
  console.log('10. Testing Option A Edit layout (rigid Move + Rotate, exact size locked, persistence & reset)...');
  const origWalletSpot = { ...fMulti.spots[1] };
  const origWpx = origWalletSpot.w * fMulti.w;
  const origHpx = origWalletSpot.h * fMulti.h;
  assert.equal(fMulti.sections[1].name, 'Mini Wallet');
  assert.equal(fMulti.sections[1].r, 270);
  assert.equal(fMulti.sections[1].artRot || 0, 0);

  // Rotate Mini Wallet +90° CW: physical pixel width & height MUST swap cleanly with zero stretching!
  assert.equal(api.rotateSplicedSection(fMulti, 1, 90), true);
  assert.equal(fMulti.sections[1].artRot, 90, 'Mini Wallet artRot must be 90');
  assert.equal(fMulti.sections[1].r, 0, 'Mini Wallet photo orientation turns from 270 (-90°) to 0° upright');
  assert.equal(fMulti.spots[1].r || 0, 0, 'Mini Wallet spot sp.r turns to 0° upright');
  const rotWpx = fMulti.spots[1].w * fMulti.w;
  const rotHpx = fMulti.spots[1].h * fMulti.h;
  assert(Math.abs(rotWpx - origHpx) < 1e-6, 'Rotated Mini Wallet spot pixel width must equal original pixel height (zero stretching)');
  assert(Math.abs(rotHpx - origWpx) < 1e-6, 'Rotated Mini Wallet spot pixel height must equal original pixel width (zero stretching)');

  // Check sectionDestBox preserves true physical size (3x2 sideways -> 2x3 upright)
  const box90 = api.sectionDestBox(fMulti.sections[1], fMulti.w, fMulti.h);
  assert(Math.abs(box90.w * fMulti.w - fMulti.sections[1].h * fMulti.h) < 1e-6, 'Section width in px equals original section height in px');
  assert(Math.abs(box90.h * fMulti.h - fMulti.sections[1].w * fMulti.w) < 1e-6, 'Section height in px equals original section width in px');

  // Drag / move Mini Wallet to the left side of the 4x6 preview canvas (keeping size locked)
  api.bringSectionToFront(fMulti, 1);
  assert.equal(api.moveSplicedSection(fMulti, 1, 0.25, 0.5, false), true);
  const movedBox = api.sectionDestBox(fMulti.sections[1], fMulti.w, fMulti.h);
  assert(Math.abs(movedBox.cx - 0.25) < 1e-6, 'Moved Mini Wallet center X must be 0.25');
  assert(Math.abs(movedBox.cy - 0.5) < 1e-6, 'Moved Mini Wallet center Y must be 0.5');
  assert(Math.abs(fMulti.spots[1].w * fMulti.w - origHpx) < 1e-6, 'Moving never resizes Mini Wallet spot width');
  assert(Math.abs(fMulti.spots[1].h * fMulti.h - origWpx) < 1e-6, 'Moving never resizes Mini Wallet spot height');

  // Verify persistence round-trip preserves sec.artRot, sec.dx, sec.dy, sec.z
  api.setState({ myFrames: [fMulti], activeFrameId: fMulti.id });
  const snapSplice = api.framesSnapshot();
  assert.equal(snapSplice.frames[0].sections[1].artRot, 90, 'framesSnapshot must persist sec.artRot=90');
  assert(Math.abs(snapSplice.frames[0].sections[1].dx - 0.25) < 1e-3, 'framesSnapshot must persist sec.dx');
  assert(Math.abs(snapSplice.frames[0].sections[1].dy - 0.5) < 1e-3, 'framesSnapshot must persist sec.dy');
  assert(snapSplice.frames[0].sections[1].z > 0, 'framesSnapshot must persist sec.z');
  api.applyFramesSetup(snapSplice);
  const fRestoredSplice = api.getState().myFrames[0];
  assert.equal(fRestoredSplice.sections[1].artRot, 90, 'applyFramesSetup must restore sec.artRot=90');
  assert(Math.abs(fRestoredSplice.sections[1].dx - 0.25) < 1e-3, 'applyFramesSetup must restore sec.dx');
  assert(Math.abs(fRestoredSplice.sections[1].dy - 0.5) < 1e-3, 'applyFramesSetup must restore sec.dy');

  // Resetting the piece restores exact original spot coordinates, size & photo rotation
  assert.equal(api.resetAllSplicedSections(fMulti), true);
  assert.equal(fMulti.sections[1].artRot || 0, 0);
  assert.equal(fMulti.sections[1].dx, undefined);
  assert.equal(fMulti.sections[1].dy, undefined);
  assert.equal(fMulti.sections[1].r, 270);
  assert.equal(fMulti.spots[1].r, 270);
  assert(Math.abs(fMulti.spots[1].x - origWalletSpot.x) < 1e-9, 'Spot X restored identically after reset');
  assert(Math.abs(fMulti.spots[1].y - origWalletSpot.y) < 1e-9, 'Spot Y restored identically after reset');
  assert(Math.abs(fMulti.spots[1].w - origWalletSpot.w) < 1e-9, 'Spot W restored identically after reset');
  assert(Math.abs(fMulti.spots[1].h - origWalletSpot.h) < 1e-9, 'Spot H restored identically after reset');

  // 11. Duplicate Spot (same Photo #), Photo # reassignment (6 spots -> 4 shots) & 60-frame snapshot scaling
  console.log('11. Testing duplicate spot (same Photo #), 6-spot->4-shot compaction, and 60-frame scale...');
  const fStrip6 = {
    id: 'strip6',
    name: '6-spot strip',
    w: 600,
    h: 1800,
    spots: [0, 1, 2, 3].map((i) => ({ x: 0.1, y: 0.05 + i * 0.15, w: 0.8, h: 0.12 })),
  };
  assert.equal(api.frameShotCount(fStrip6), 4, 'Starts as 4 spots taking 4 shots');
  const dup1 = api.cloneFrameSpot(fStrip6, 0, true, 40);
  const dup2 = api.cloneFrameSpot(fStrip6, 1, true, 40);
  assert.ok(dup1 && dup2, 'cloneFrameSpot must clone same-photo spots');
  assert.equal(fStrip6.spots.length, 6, 'Now 6 total spots on strip');
  assert.equal(api.frameShotCount(fStrip6), 4, '6 spots with 2 duplicates must take only 4 shots');
  assert.deepEqual(Array.from(api.framePairs(fStrip6)), [0, 1, 2, 3, 0, 1], 'Pairs map spots 5 & 6 back to shots 1 & 2');

  // Reassign Photo # directly on a 6-spot automatic strip -> compact & verify 4 shots
  const fAuto6 = {
    id: 'auto6',
    name: 'Auto 6-spot strip',
    w: 600,
    h: 1800,
    spots: [0, 1, 2, 3, 4, 5].map((i) => ({ x: 0.1, y: 0.04 + i * 0.15, w: 0.8, h: 0.12 })),
  };
  assert.equal(api.frameShotCount(fAuto6), 6);
  assert.equal(api.assignFrameSpotShot(fAuto6, 4, 1, 40), true, 'Assigning spot 5 -> Photo #1 succeeds');
  // Gap compaction: [1,2,3,4,1,6] compacts to [1,2,3,4,1,5]
  assert.equal(api.frameShotCount(fAuto6), 5, 'Compacts gap so unused Photo #6 shifts to #5');
  assert.equal(api.assignFrameSpotShot(fAuto6, 5, 2, 40), true, 'Assigning spot 6 -> Photo #2 succeeds');
  assert.equal(api.frameShotCount(fAuto6), 4, '6 spots reusing #1 and #2 now take 4 shots total');
  assert.deepEqual(Array.from(api.framePairs(fAuto6)), [0, 1, 2, 3, 0, 1], 'Reassigned pairs map spots 5 & 6 to shots 1 & 2');

  // Round-trip persistence of 60 frames with duplicated spots (well within Netlify MAX_SETTINGS = 120000)
  const manyFrames = [];
  for (let i = 0; i < 60; i++) {
    manyFrames.push({
      id: 'a' + String(1000000000000000 + i),
      name: 'Event Frame ' + (i + 1),
      w: 1200,
      h: 1800,
      spots: fStrip6.spots.map((sp) => ({ ...sp })),
    });
  }
  api.setState({ myFrames: manyFrames, activeFrameId: manyFrames[0].id });
  const snap60 = api.framesSnapshot();
  const snapBytes = JSON.stringify(snap60).length;
  assert.equal(snap60.frames.length, 60, '60 frames snapshotted');
  assert.ok(snapBytes < 60000, '60-frame snapshot must fit comfortably under setup size limit (got ' + snapBytes + ' bytes)');
  api.applyFramesSetup(snap60);
  assert.equal(api.getState().myFrames.length, 60, '60 frames restored cleanly');
  assert.equal(api.frameShotCount(api.getState().myFrames[59]), 4, 'Restored frame keeps 4-shot duplicate spot count');

  // Verify new UI & performance controls exist across built booth bundle
  for (const id of [
    'spotDupSame', 'spotPhotoRow', 'spotShotDec', 'spotShotInc', 'spotShotChips',
    'pmSpDupSame', 'FRAME_CACHE_PREV', 'evictFrameCache', 'lay-frame-toolbar',
    'LT_IDB_KEY', 'assetThumbUrl', 'scheduleSpotPostRefresh',
  ]) {
    assert.ok(html.includes(id), 'Expected symbol/UI id in booth.html: ' + id);
  }
}

console.log('ALL PHASE 1-3 ROTATION & AUTO-SECTION TESTS PASSED! ✓');
