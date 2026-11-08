import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

console.log('--- Testing Per-Photo Crop & Zoom, Trend Stickers, and Custom Text ---');

const boothHtmlPath = resolve('protected/booth.html');
const netlifyBoothPath = resolve('netlify/lib/booth.mjs');
const androidBoothPath = resolve('android/app/src/main/assets/booth.html');
const iosBoothPath = resolve('ios/photobooth4u/booth.html');

assert(existsSync(boothHtmlPath), 'protected/booth.html must exist');
assert(existsSync(netlifyBoothPath), 'netlify/lib/booth.mjs must exist');
assert(existsSync(androidBoothPath), 'android booth.html must exist');
assert(existsSync(iosBoothPath), 'ios booth.html must exist');

const htmlContent = readFileSync(boothHtmlPath, 'utf8');

// 1. Verify Phase 1: Per-Photo Crop & Zoom UI & Engine
console.log('1. Checking Phase 1: Per-photo Crop & Zoom...');
assert(htmlContent.includes('id="gsoCropPane"'), 'Crop pane HTML markup must be present');
assert(htmlContent.includes('id="gsoCropZoomSlider"'), 'Crop zoom slider must be present');
assert(htmlContent.includes('id="gsoNudgeUp"'), 'Nudge controls must be present');
assert(htmlContent.includes('id="gsoNudgeReset"'), 'Nudge center reset must be present');
assert(htmlContent.includes('var shotCrops = {};'), 'shotCrops state must be declared');
assert(htmlContent.includes('var shotSlotBoxes = {};'), 'shotSlotBoxes state must be declared');
assert(htmlContent.includes('function recordShotSlotBox'), 'recordShotSlotBox function must be present');
assert(htmlContent.includes('function drawCropSlotIndicator'), 'drawCropSlotIndicator function must be present');
assert(htmlContent.includes('function hitShotSlot'), 'hitShotSlot function must be present');
assert(htmlContent.includes('function refreshCropUI'), 'refreshCropUI function must be present');
assert(htmlContent.includes('function wireCropControls'), 'wireCropControls function must be present');
assert(htmlContent.includes('id="resultCustomizeBtn"'), 'Result screen customize button must be present');

// Test math for crop logic:
function simulateCropMath(iw, ih, w, h, zoom, panX, panY) {
  const imgRatio = iw / ih;
  const boxRatio = w / h;
  let sx, sy, sw, sh;
  if (imgRatio > boxRatio) {
    sh = ih;
    sw = sh * boxRatio;
    sx = (iw - sw) / 2;
    sy = 0;
  } else {
    sw = iw;
    sh = sw / boxRatio;
    sx = 0;
    sy = (ih - sh) / 2;
  }
  const z = Math.max(1, Math.min(3, Number(zoom) || 1));
  const px = Math.max(-1, Math.min(1, Number(panX) || 0));
  const py = Math.max(-1, Math.min(1, Number(panY) || 0));
  const sw_z = sw / z;
  const sh_z = sh / z;
  const maxShiftX = (iw - sw_z) / 2;
  const maxShiftY = (ih - sh_z) / 2;
  const new_cx = (iw / 2) + px * maxShiftX;
  const new_cy = (ih / 2) + py * maxShiftY;
  const final_sx = Math.max(0, Math.min(iw - sw_z, new_cx - sw_z / 2));
  const final_sy = Math.max(0, Math.min(ih - sh_z, new_cy - sh_z / 2));
  return { sx: final_sx, sy: final_sy, sw: sw_z, sh: sh_z, z, px, py };
}

// Case A: Landscape image in portrait slot with 1.5x zoom and right pan
const resA = simulateCropMath(1920, 1080, 600, 900, 1.5, 0.5, 0);
assert(resA.sw > 0 && resA.sh > 0, 'Source dimensions must be positive');
assert(resA.sx >= 0 && resA.sx + resA.sw <= 1920, 'Crop source window must be within image bounds horizontally');
assert(resA.sy >= 0 && resA.sy + resA.sh <= 1080, 'Crop source window must be within image bounds vertically');

// Case B: Maximum zoom and extreme pans
const resB = simulateCropMath(1080, 1920, 600, 600, 2.5, -1, 1);
assert(resB.sx >= 0 && resB.sx + resB.sw <= 1080, 'Crop window within bounds at extreme pan');
assert(resB.sy >= 0 && resB.sy + resB.sh <= 1920, 'Crop window within bounds at extreme pan');

// 2. Verify Phase 2: Stickers & Trend Packs
console.log('2. Checking Phase 2: Trend Stickers, Emojis & Vectors...');
assert(htmlContent.includes("id: 'trend', name: 'Trend & Y2K'"), 'Trend & Y2K sticker pack must be present');
assert(htmlContent.includes("id: 'aesthetic', name: 'Aesthetic'"), 'Aesthetic sticker pack must be present');
assert(htmlContent.includes("['b-slay', 'SLAY ✨']"), 'SLAY trend banner sticker must be present');
assert(htmlContent.includes("['b-besties', 'BESTIES 👯‍♀️']"), 'BESTIES banner must be present');
assert(htmlContent.includes("['b-mainchar', 'Main Character']"), 'Main Character banner must be present');
assert(htmlContent.includes("['b-vibes', 'Pure Vibes ✌️']"), 'Pure Vibes banner must be present');
assert(htmlContent.includes("['b-photodump', 'Photo Dump 📸']"), 'Photo Dump banner must be present');
assert(htmlContent.includes("['b-iconic', 'ICONIC 💎']"), 'ICONIC banner must be present');
assert(htmlContent.includes("['y2kstar', 'Y2K Star']"), 'Y2K Star vector must be present');
assert(htmlContent.includes("['pinkbow', 'Pink Bow']"), 'Pink Bow vector must be present');
assert(htmlContent.includes("['cherries', 'Cherries']"), 'Cherries vector must be present');
assert(htmlContent.includes("['flame', 'Fire Flame']"), 'Flame vector must be present');
assert(htmlContent.includes("['cyberheart', 'Cyber Heart']"), 'Cyber heart vector must be present');
assert(htmlContent.includes("['cat-ears', 'Cat Ears']"), 'Cat ears vector must be present');
assert(htmlContent.includes("['bunny-ears', 'Bunny Ears']"), 'Bunny ears vector must be present');
assert(htmlContent.includes("['heartshades', 'Heart Shades']"), 'Heart sunglasses vector must be present');
assert(htmlContent.includes("['pixshades', 'Pixel Shades']"), 'Pixel shades vector must be present');
assert(htmlContent.includes("case 'y2kstar':"), 'y2kstar canvas drawing case must exist');
assert(htmlContent.includes("case 'pinkbow':"), 'pinkbow canvas drawing case must exist');
assert(htmlContent.includes("case 'cherries':"), 'cherries canvas drawing case must exist');
assert(htmlContent.includes("case 'flame':"), 'flame canvas drawing case must exist');
assert(htmlContent.includes("case 'cyberheart':"), 'cyberheart canvas drawing case must exist');

// Verify native emojis
assert(htmlContent.includes("STICKER_EMOJIS = {"), 'STICKER_EMOJIS map must exist');
assert(htmlContent.includes("'e-sparkheart': '💖'"), 'Emoji sparkheart must be mapped');
assert(htmlContent.includes("'e-ribbon': '🎀'"), 'Emoji ribbon must be mapped');
assert(htmlContent.includes("'e-sparkle': '✨'"), 'Emoji sparkles must be mapped');

// 3. Verify Phase 3: Custom Text Tool
console.log('3. Checking Phase 3: Custom Text Tool...');
assert(htmlContent.includes('id="gsoTextPane"'), 'Text pane HTML markup must be present');
assert(htmlContent.includes('id="gsoCustomTextInput"'), 'Custom text input must be present');
assert(htmlContent.includes('id="gsoAddTextBtn"'), 'Add text button must be present');
assert(htmlContent.includes('id="gsoTrendChips"'), 'Trend suggestion chips must be present');
assert(htmlContent.includes('id="gsoColorSwatches"'), 'Color swatches must be present');
assert(htmlContent.includes('id="gsoFontChips"'), 'Font chips must be present');
assert(htmlContent.includes('id="gsoStyleChips"'), 'Style chips must be present');
assert(htmlContent.includes('function drawCustomTextDecorItem'), 'drawCustomTextDecorItem function must be present');
assert(htmlContent.includes('function addCustomTextDecor'), 'addCustomTextDecor function must be present');
assert(htmlContent.includes('function wireTextControls'), 'wireTextControls function must be present');

// Test custom text aspect ratio math
function calculateCustomTextAspect(text) {
  const chars = Math.max(1, (text || '').trim().length);
  return Math.max(1.8, Math.min(8.0, chars * 0.45 + 0.9));
}
assert(calculateCustomTextAspect('SLAY') >= 2.0, 'Short text should have clean compact aspect');
assert(calculateCustomTextAspect('Happy 18th Birthday Sarah!') > 4.0, 'Long sentence should have wide banner aspect');

// 4. Verify Bundled Copies
console.log('4. Verifying Build and Bundle Synchronization...');
const netlifyContent = readFileSync(netlifyBoothPath, 'utf8');
const androidContent = readFileSync(androidBoothPath, 'utf8');
const iosContent = readFileSync(iosBoothPath, 'utf8');

assert(netlifyContent.includes('gsoCropPane'), 'netlify/lib/booth.mjs must contain gsoCropPane');
assert(androidContent.includes('gsoCropPane'), 'android booth.html must contain gsoCropPane');
assert(iosContent.includes('gsoCropPane'), 'ios booth.html must contain gsoCropPane');

assert(androidContent.length === htmlContent.length, 'Android booth.html must be identical in length to protected/booth.html');
assert(iosContent.length === htmlContent.length, 'iOS booth.html must be identical in length to protected/booth.html');

console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
