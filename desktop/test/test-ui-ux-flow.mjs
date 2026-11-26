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

// 8. Audit Seamless Kiosk Navigation, Back-to-Layout, Stepper, Live Text Styling & Safe Undo
console.log('8. Auditing Seamless Kiosk Flow, Stepper, Back Navigation & Live Text Editing...');
assert(htmlContent.includes('data-gfs-slot="pick"'), 'Pick overlay must have step progress slot');
assert(htmlContent.includes('data-gfs-slot="ready"'), 'Ready overlay must have step progress slot');
assert(htmlContent.includes('data-gfs-slot="decorate"'), 'Decorate overlay must have step progress slot');
assert(htmlContent.includes('data-gfs-slot="result"'), 'Result screen must have step progress slot');
assert(htmlContent.includes('function updateGuestFlowSteps'), 'updateGuestFlowSteps controller must exist');
assert(htmlContent.includes('id="readyBackBtn"'), 'Get Ready screen must include Back / Change layout button');
assert(htmlContent.includes('id="readyLayoutPill"'), 'Get Ready screen must display selected layout pill');
assert(htmlContent.includes("if (sessRes === '__back__' && canBackToPick) continue;"), 'beginGuestFlow must loop cleanly back to layout picker without cancelling session');
assert(htmlContent.includes("doneBtn.textContent = guestStickersOn"), 'Review Done button must adapt label when Customize step follows');
assert(htmlContent.includes('id="gsoUndoBtn"'), 'Decorate overlay must include Undo button');
assert(htmlContent.includes('id="gsoBwBadge"'), 'Decorate overlay must include B&W thermal indicator badge');
assert(htmlContent.includes('id="gsoTextLiveNote"'), 'Text pane must show live-editing indicator when text item selected');
assert(htmlContent.includes('function applyLiveTextStyleToSelection'), 'Tapping font/color/style must live-update selected text item');
assert(htmlContent.includes('function syncTextChipsFromSelection'), 'Selecting a text item must sync text control chips');
assert(htmlContent.includes('@keyframes pbOverlayIn') && htmlContent.includes('prefers-reduced-motion: reduce'), 'Smooth overlay transition animation must respect prefers-reduced-motion');
assert(htmlContent.includes("if (typeof qrPopDrawPhoto === 'function'"), 'Result Customize re-edit must refresh QR popup photo canvas');

// 9. Executable VM Verification of Seamless Flow Functions
console.log('9. Running Executable VM Seamless Flow Checks...');
import vm from 'node:vm';

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  assert(start >= 0, `Could not find ${sig} in booth.html`);
  let i = src.indexOf('{', start), d = 0, ins = false, q = '', esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ins) { if (ch === '\\') esc = true; else if (ch === q) ins = false; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { ins = true; q = ch; continue; }
    if (ch === '{') d++; else if (ch === '}' && --d === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed ${sig}`);
}

{
  const mkEl = (extra = {}) => Object.assign({
    hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
    style: { display: '' }, dataset: {},
    classList: { _s: new Set(), toggle(c, v) { v ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    querySelectorAll() { return []; }
  }, extra);
  const els = {
    gsoTools: mkEl(), gsoUndoBtn: mkEl({ disabled: true }), gsoSkipBtn: mkEl({ textContent: 'Skip' }),
    gsoTextLiveNote: mkEl({ hidden: true }), gsoColorSwatches: mkEl(), gsoFontChips: mkEl(), gsoStyleChips: mkEl(),
    readyLayoutPill: mkEl({ hidden: true }), readySub: mkEl(),
    slotPick: mkEl({ dataset: { gfsSlot: 'pick' } }),
    slotReady: mkEl({ dataset: { gfsSlot: 'ready' } }),
    slotDecorate: mkEl({ dataset: { gfsSlot: 'decorate' } }),
    slotResult: mkEl({ dataset: { gfsSlot: 'result' } })
  };
  let redrawCount = 0;
  const ctx = {
    LAYOUT_DEFS: { rec3: { name: 'Receipt (3)', kind: 'receipt', color: false, shots: 3 } },
    currentLayout: 'rec3', activeFrameId: '', guestStickersOn: true, previewCanvas: { width: 576 },
    customTextState: { font: 'manrope', color: '#ffffff', style: 'pill' },
    guestDecor: [], selGuestDecor: -1, gsoView: {},
    readySub: els.readySub, firstTimerSec: 5, timerSec: 3, betweenSec: 2, advanceMode: 'auto', flipSec: 3,
    fmtSec: (v) => String(v), shotsNeeded: () => 3, pickName: () => 'Receipt (3)',
    willAutoPrint: () => true, guestFlowHasPickNow: () => true, layoutDef: (k) => ctx.LAYOUT_DEFS[k],
    ensureCustomTextAspect: (d) => { d.aspect = 0.25; },
    parseCustomTextDecor: (d) => JSON.parse(decodeURIComponent(d.src.slice(2))),
    gsoPlaceTools: () => {},
    gsoRedraw: () => { redrawCount++; },
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => sel === '[data-gfs-slot]' ? [els.slotPick, els.slotReady, els.slotDecorate, els.slotResult] : []
    },
    encodeURIComponent, decodeURIComponent, JSON, Array, Object, Number, String, Math
  };
  const vmCode = [
    extractFn(htmlContent, 'function isReceiptLayoutNow('),
    extractFn(htmlContent, 'function isBwReceiptLayoutNow('),
    extractFn(htmlContent, 'function updateGuestFlowSteps('),
    extractFn(htmlContent, 'function updateReadySub('),
    extractFn(htmlContent, 'function syncTextChipsFromSelection('),
    extractFn(htmlContent, 'function applyLiveTextStyleToSelection('),
    extractFn(htmlContent, 'function refreshGuestStickerControls('),
    'globalThis.__t = { isReceiptLayoutNow, isBwReceiptLayoutNow, updateGuestFlowSteps, updateReadySub, syncTextChipsFromSelection, applyLiveTextStyleToSelection, refreshGuestStickerControls };'
  ].join('\n');
  vm.createContext(ctx);
  vm.runInContext(vmCode, ctx);
  const t = ctx.__t;

  assert.equal(t.isReceiptLayoutNow(), true);
  assert.equal(t.isBwReceiptLayoutNow(), true);
  t.updateReadySub();
  assert.equal(els.readyLayoutPill.hidden, false);
  assert.equal(els.readyLayoutPill.textContent, '🧾 Receipt (3)');
  t.updateGuestFlowSteps('decorate');
  assert.equal(els.slotPick.hidden, true);
  assert.equal(els.slotDecorate.hidden, false);
  assert(els.slotDecorate.innerHTML.includes('3. Customize') && els.slotDecorate.innerHTML.includes('4. Receipt'));
  t.updateGuestFlowSteps('result');
  assert(els.slotResult.innerHTML.includes('✓ Customize') && els.slotResult.innerHTML.includes('4. Receipt'));

  const txtSrc = 't:' + encodeURIComponent(JSON.stringify({ t: 'HELLO', f: 'serif', c: '#ff7597', st: 'outline' }));
  ctx.guestDecor = [{ src: txtSrc, x: 0.5, y: 0.5, s: 0.35, r: 0 }];
  ctx.selGuestDecor = 0;
  t.refreshGuestStickerControls({ skipPlace: true });
  assert.equal(els.gsoUndoBtn.disabled, false);
  assert.equal(els.gsoSkipBtn.textContent, 'Clear');
  assert.equal(els.gsoTextLiveNote.hidden, false);
  assert.equal(ctx.customTextState.font, 'serif');
  assert.equal(ctx.customTextState.color, '#ff7597');
  assert.equal(ctx.customTextState.style, 'outline');

  ctx.customTextState.style = 'neon';
  ctx.customTextState.color = '#00b4d8';
  t.applyLiveTextStyleToSelection();
  const updated = JSON.parse(decodeURIComponent(ctx.guestDecor[0].src.slice(2)));
  assert.equal(updated.st, 'neon');
  assert.equal(updated.c, '#00b4d8');
  assert.equal(updated.t, 'HELLO');
  assert.equal(redrawCount, 1);

  ctx.guestDecor = [];
  ctx.selGuestDecor = -1;
  t.refreshGuestStickerControls({ skipPlace: true });
  assert.equal(els.gsoUndoBtn.disabled, true);
  assert.equal(els.gsoSkipBtn.textContent, 'Skip');
  assert.equal(els.gsoTextLiveNote.hidden, true);
}

console.log('--- ALL UI/UX FLOW AUDITS PASSED CLEANLY! ---');
