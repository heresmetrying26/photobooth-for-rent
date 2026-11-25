// Test Flipbook card layout, border padding, wider left binding gutter (6-18 mm), and setup persistence
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRINT_DPI = 300;
const MM = PRINT_DPI / 25.4;

function getFlipGutterPx(cw, mm, gutterOn, gutterMm) {
  if (!gutterOn) return 0;
  const gMm = Number(gutterMm) || 12;
  return Math.min(Math.max(1, Math.round(gMm * mm)), Math.round(cw * 0.45));
}

function getFlipBorderPadPx(rw, rh, mm, borderSize) {
  const padMm = borderSize === 'thin' ? 1.2 : borderSize === 'wide' ? 3.5 : 2.2;
  return Math.min(Math.max(1, Math.round(padMm * mm)), Math.round(Math.min(rw, rh) * 0.22));
}

function containBox(iw, ih, x, y, w, h) {
  const k = Math.min(w / iw, h / ih);
  const dw = iw * k, dh = ih * k;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

console.log('--- Testing Flipbook Layout, Borders & Left Binding Margin ---');

// 1. Left binding gutter math on 4R (4x6 portrait, 8-up: cell 46.8 x 36.1 mm)
const cw4x6 = ((101.6 - 8) / 2) * MM;
const ch4x6 = ((152.4 - 8) / 4) * MM;
assert.equal(getFlipGutterPx(cw4x6, MM, false, 12), 0, 'Disabled gutter must be 0 px');
for (const gMm of [6, 10, 12, 15, 18]) {
  const gw = getFlipGutterPx(cw4x6, MM, true, gMm);
  assert.equal(gw, Math.round(gMm * MM), `${gMm} mm gutter on 4R 8-up should match exact mm`);
  assert.ok(cw4x6 - gw >= cw4x6 * 0.55, `${gMm} mm gutter must leave >= 55% width for photo`);
}
// Clamp check on tiny custom card (25 mm wide) with 18 mm gutter
const cwTiny = 25 * MM;
assert.equal(getFlipGutterPx(cwTiny, MM, true, 18), Math.round(cwTiny * 0.45), 'Tiny cell must clamp gutter to 45%');
console.log('✓ Passed: Left binding margin math (6/10/12/15/18 mm + clamp)');

// 2. Staple placement leaves generous bending room on wider gutters
for (const gMm of [6, 10, 12, 15, 18]) {
  const gw = getFlipGutterPx(cw4x6, MM, true, gMm);
  const dotX = Math.min(Math.round(gw * 0.42), Math.round(5.5 * MM));
  assert.ok(dotX > 0 && dotX < gw, `Staple dot for ${gMm} mm must stay inside gutter`);
  if (gMm >= 12) {
    assert.ok(gw - dotX >= Math.round(6 * MM), `Wider ${gMm} mm gutter must leave >= 6 mm bend room after staple`);
  }
}
console.log('✓ Passed: Staple dot alignment & page-bend clearance');

// 3. Border thickness scaling (thin / medium / wide)
const rw12 = cw4x6 - getFlipGutterPx(cw4x6, MM, true, 12);
const padThin = getFlipBorderPadPx(rw12, ch4x6, MM, 'thin');
const padMed = getFlipBorderPadPx(rw12, ch4x6, MM, 'medium');
const padWide = getFlipBorderPadPx(rw12, ch4x6, MM, 'wide');
assert.ok(padThin < padMed && padMed < padWide, 'Border padding must scale thin < medium < wide');
assert.ok(rw12 - 2 * padWide > rw12 * 0.5, 'Wide border must leave > 50% width for photo');
console.log('✓ Passed: Border thickness scaling (thin < medium < wide)');

// 4. Cover & Back contain geometry (no QR / title cropping even at 18 mm gutter + wide border)
const rw18 = cw4x6 - getFlipGutterPx(cw4x6, MM, true, 18);
const pad18 = getFlipBorderPadPx(rw18, ch4x6, MM, 'wide');
const innerW = rw18 - 2 * pad18, innerH = ch4x6 - 2 * pad18;
const box = containBox(800, 600, pad18, pad18, innerW, innerH);
assert.ok(box.x >= pad18 - 0.01 && box.y >= pad18 - 0.01, 'Contained cover/back must stay inside left/top');
assert.ok(box.x + box.w <= pad18 + innerW + 0.01 && box.y + box.h <= pad18 + innerH + 0.01, 'Contained cover/back must stay inside right/bottom');
console.log('✓ Passed: Cover & Back QR uncropped contain math at 18 mm gutter');

// 5. Verify built protected/booth.html contains all controls, defaults, persistence, and valid JS syntax
const builtHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
const requiredIds = [
  'flipLayoutPreview',
  'flipLayoutPreviewMeta',
  'flipCardLayoutSelect',
  'flipBorderSizeSelect',
  'flipBorderColorRow',
  'flipBorderColorInput',
  'flipCardCaptionInput',
  'flipOverlayInput',
  'flipOverlayThumb',
  'flipOverlayRemove',
  'flipOverlayBorderToggle',
  'flipGutterDetails',
  'flipGutterMmSelect'
];
for (const id of requiredIds) {
  assert.ok(builtHtml.includes(`id="${id}"`), `Built booth.html missing element id="${id}"`);
}
assert.ok(builtHtml.includes('var flipGutterMm = 12;'), 'Default flipGutterMm must be 12');
assert.ok(builtHtml.includes("var flipCardLayout = 'bordered';"), "Default flipCardLayout must be 'bordered'");
assert.ok(builtHtml.includes('flipOverlayAssetId: flipOverlayAssetId'), 'collectSetup must persist flipOverlayAssetId');
assert.ok(builtHtml.includes('flipGutterMm: flipGutterMm'), 'collectSetup must persist flipGutterMm');
assert.ok(builtHtml.includes('ids.push(flipOverlayAssetId)'), 'designAssetIds must include flipOverlayAssetId');
assert.ok(builtHtml.includes('addAsset(url, undefined, preImg)'), 'Uploaded PNG border/cover must pre-decode image before addAsset');
assert.ok(builtHtml.includes('id === flipOverlayAssetId && typeof refreshFlipLayoutUI'), 'registerAsset onload must refresh flipbook layout preview');
assert.ok(builtHtml.includes('b.c._flipPhotoCover = true;'), 'makeFlipCover must flag photographic covers so fallback title covers never crop');
assert.ok(builtHtml.includes("fbci.addEventListener('change', onFlipBorderColorPick)"), 'Custom border colour input must listen to change for Safari/iOS/Android');

// Verify every inline <script> block in built protected/booth.html parses with zero syntax errors
const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
let m, scriptCount = 0;
while ((m = scriptRe.exec(builtHtml)) !== null) {
  const code = m[1];
  if (!code.trim()) continue;
  new vm.Script(code, { filename: `protected/booth.html#script-${++scriptCount}` });
}
assert.ok(scriptCount > 0, 'Should have parsed inline scripts in protected/booth.html');
console.log(`✓ Passed: Built protected/booth.html DOM IDs, defaults, persistence & ${scriptCount} valid script blocks`);

console.log('All Flipbook layout & binding tests passed successfully!');
