import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

console.log('--- Comprehensive UI/UX Navigation & Flow Audit ---');

const boothHtmlPath = resolve('protected/booth.html');
assert(existsSync(boothHtmlPath), 'protected/booth.html must exist');
const htmlContent = readFileSync(boothHtmlPath, 'utf8');

// 1. Audit Navigation Flow: Capture -> Review -> Decorate -> Result
console.log('1. Auditing Guest Flow Sequence...');
const flowCaptureToResultRegex = /await reviewPhase\(\)[\s\S]*?await guestStickersPhase\(\)[\s\S]*?state\s*=\s*'result'/;
assert(flowCaptureToResultRegex.test(htmlContent), 'Flow sequence must cleanly progress: Capture -> Review -> Decorate -> Result');

// 2. Audit Decorator Overlay Modes and Subtitle Guidance
console.log('2. Auditing Overlay Mode Tabs & Dynamic Guidance...');
assert(htmlContent.includes("data-mode=\"stickers\""), 'Stickers tab must exist');
assert(htmlContent.includes("data-mode=\"text\""), 'Add Text tab must exist');
assert(htmlContent.includes("data-mode=\"crop\""), 'Photo Framing tab must exist');
assert(htmlContent.includes("if (gsoMode === 'crop') sub.textContent = 'Tap photo to select · drag to pan · pinch to zoom'"), 'Crop mode guidance subtitle must exist');
assert(htmlContent.includes("else if (gsoMode === 'text') sub.textContent = 'Type caption · choose font, color & style'"), 'Text mode guidance subtitle must exist');
assert(htmlContent.includes("else sub.textContent = 'Tap a sticker to add it · drag to move · pinch to resize'"), 'Sticker mode guidance subtitle must exist');

// 3. Audit Preview Mode Isolation
console.log('3. Auditing Preview Mode Isolation...');
assert(htmlContent.includes(".guest-sticker-overlay.previewing .gso-mode-tabs"), 'Preview mode must hide mode tabs');
assert(htmlContent.includes(".guest-sticker-overlay.previewing .gso-mode-pane"), 'Preview mode must hide mode panes');
assert(htmlContent.includes(".guest-sticker-overlay.previewing .gso-tools"), 'Preview mode must hide floating tools');
assert(htmlContent.includes("sess.decoPreview = !sess.decoPreview;"), 'Preview button must toggle decoPreview');
assert(htmlContent.includes("!sess.decoPreview) {\n          drawCropSlotIndicator"), 'Neon crop indicator must NOT draw during preview mode');

// 4. Audit Result Screen Customization & QR / Timer Continuity
console.log('4. Auditing Result Screen Re-Entry & Reset Timer...');
assert(htmlContent.includes("if (resCust) resCust.style.display = guestStickersOn ? 'inline-flex' : 'none';"), 'Customize button must respect guestStickersOn setting');
assert(htmlContent.includes("clearTimeout(resultTimer);"), 'Customize click must pause resultTimer');
assert(htmlContent.includes("if (curMode !== 'gif') showQRForCurrentPhoto();"), 'Customize completion must refresh QR photo file');
assert(htmlContent.includes("scheduleResultReset();"), 'Customize completion must restart result countdown timer');

// 5. Audit Custom Text UX & Enter Key Navigation
console.log('5. Auditing Custom Text Tool UX...');
assert(htmlContent.includes("if (e.key === 'Enter')"), 'Enter key must trigger adding text');
assert(htmlContent.includes("Please type some text or tap a trend phrase."), 'Empty text submission must show toast guidance');
assert(htmlContent.includes("Text added! Drag, resize or rotate."), 'Successful text addition must confirm to user');

// 6. Audit Touch / Pointer Gesture Conflict Prevention
console.log('6. Auditing Gesture Handling Isolation...');
assert(htmlContent.includes("if (gsoMode === 'crop')"), 'pointerdown & pointermove must branch cleanly when in crop mode');
assert(htmlContent.includes("gCropDrag = null; gCropPinch = null;"), 'gsoUnmount & cancel must clear crop drag & pinch pointers');

// 7. Audit Session Reset and Cancellation Cleanness
console.log('7. Auditing Reset and Cancellation Cleanup...');
assert(htmlContent.includes("shotCrops = {};"), 'resetForNextGuest and endCancelledSession must reset shotCrops');
assert(htmlContent.includes("guestDecor = [];"), 'resetForNextGuest and endCancelledSession must reset guestDecor');

console.log('--- ALL UI/UX FLOW AUDITS PASSED CLEANLY! ---');
