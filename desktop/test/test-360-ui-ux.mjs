// test-360-ui-ux.mjs - Comprehensive UI/UX, Navigation & Layout Test for 360 Studio Desk
import fs from 'node:fs';
import path from 'node:path';

console.log('====================================================');
console.log('  360 Video Studio & Desk UI/UX & Navigation Test');
console.log('====================================================\n');

const boothHtmlPath = path.resolve('protected/booth.html');
const html = fs.readFileSync(boothHtmlPath, 'utf8');

let failed = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

// Test 1: DOM Hierarchy & Two-Column Grid
console.log('Test 1: Studio DOM Hierarchy & Two-Column Grid Layout');
{
  const bodyIdx = html.indexOf('<div class="spin-studio-body">');
  const controlsIdx = html.indexOf('<div class="spin-studio-controls" id="spinStudioControls">');
  const previewIdx = html.indexOf('<div class="spin-studio-preview" id="spinStudioPreview">');
  const overlayCloseIdx = html.indexOf('<!-- 360 Output & Share QR Modal Prompt -->');

  assert(bodyIdx !== -1, '.spin-studio-body exists');
  assert(controlsIdx > bodyIdx, '#spinStudioControls is inside .spin-studio-body');
  assert(previewIdx > controlsIdx, '#spinStudioPreview is placed after #spinStudioControls');
  assert(previewIdx < overlayCloseIdx, '#spinStudioPreview is properly enclosed within .spin-studio-body');

  // Verify that there is NO premature closing div between controls and preview
  const between = html.slice(controlsIdx, previewIdx);
  const openDivs = (between.match(/<div\b/g) || []).length;
  const closeDivs = (between.match(/<\/div>/g) || []).length;
  assert(closeDivs === openDivs, `Balanced div nesting inside #spinStudioControls (opened: ${openDivs}, closed: ${closeDivs})`);
}

// Test 2: Navigation Tabs & Section Order
console.log('\nTest 2: Navigation Tabs and Section Order Alignment');
{
  const tabIds = [];
  const tabRegex = /<button[^>]*class="[^"]*spin-tab-btn[^"]*"[^>]*data-tab="([^"]+)"/g;
  let m;
  while ((m = tabRegex.exec(html)) !== null) {
    if (!m[1].includes('Preview')) tabIds.push(m[1]);
  }

  const expectedTabs = ['spinSecVideos', 'spinSecPresets', 'spinSecLook', 'spinSecText', 'spinSecAudio'];
  assert(JSON.stringify(tabIds) === JSON.stringify(expectedTabs), `Header navigation tabs ordered: ${tabIds.join(' -> ')}`);

  // Verify that sections in #spinStudioControls match the exact tab order
  const secIndices = expectedTabs.map(id => html.indexOf(`id="${id}"`));
  let inOrder = true;
  for (let i = 0; i < secIndices.length - 1; i++) {
    if (secIndices[i] >= secIndices[i + 1]) inOrder = false;
  }
  assert(inOrder, 'DOM panel cards strictly follow the navigation tab order');
}

// Test 3: Processing Lock Banner & Interactive Unlock
console.log('\nTest 3: Processing Lock Banner & UI Controls Dimming');
{
  assert(html.includes('id="spinEditLockBanner"'), '#spinEditLockBanner is defined');
  assert(html.includes('id="spinUnlockEditBtn"'), '#spinUnlockEditBtn is defined');
  assert(html.includes('.spin-locked-controls'), '.spin-locked-controls CSS class exists');
  // The scroll area itself must stay live: only the cards are made unclickable, never the whole column
  const lockCss = html.slice(html.indexOf('.spin-locked-controls'), html.indexOf('.spin-locked-controls') + 600);
  assert(/\.spin-locked-controls \.spin-panel-card:not\(#spinSecVideos\)\s*\{[^}]*pointer-events:\s*none/.test(lockCss), 'Locked cards are unclickable but the column still scrolls');
  assert(!/\.spin-locked-controls\s*\{[^}]*pointer-events/.test(html), 'Locked column itself keeps pointer events (scroll wheel / scrollbar work)');
  assert(html.includes('function spinSetCardsInert'), 'Locked cards are made inert so Tab cannot reach them');

  // Check spinModalUpdate lock logic
  assert(html.includes("var controlsCol = document.getElementById('spinStudioControls')"), 'spinModalUpdate targets #spinStudioControls for locking');
  assert(html.includes("controlsCol.classList.toggle('spin-locked-controls', !!isLocked)"), 'Locks/unlocks controls column dynamically');
}

// Test 3b: bug fixes - share QR, typing, rendered preview, mute, Spin & Print preview
console.log('\nTest 3b: Share QR, typing, rendered preview, mute and Spin & Print preview');
{
  const shareVideoStart = html.indexOf('\n    .spin-share-stage video {');
  const shareVideoCss = html.slice(shareVideoStart, shareVideoStart + 300);
  assert(/position:\s*static/.test(shareVideoCss), 'Share video no longer inherits the global absolute video rule (QR codes stay visible)');

  const kd = html.slice(html.indexOf("window.addEventListener('keydown', function (e) {\n        var k = e.key;"), html.indexOf("window.addEventListener('keydown', function (e) {\n        var k = e.key;") + 700);
  assert(/INPUT/.test(kd) && /TEXTAREA/.test(kd) && kd.indexOf('INPUT') < kd.indexOf("k === ' '"), 'Remote-shutter key handler ignores typing in text fields (space works)');

  assert(html.includes('function spinRefreshStudio'), 'Studio preview is refreshed when the share modal closes');
  assert(/function closeSpinShareModal\(noRefresh\)[\s\S]{0,400}spinRefreshStudio\(\)/.test(html), 'Back to Studio re-attaches the preview');
  assert(html.includes('function spinShowRendered'), 'Finished renders show the rendered video by default');
  assert(/it\.status === 'edited'\)\s*\{[\s\S]{0,200}spinShowRendered\(it\)/.test(html), 'spinEdit switches to the rendered video when done');
  assert(/spinSetOverlayPreview\(false\)/.test(html), 'Overlay Preview is switched off once the video is rendered');

  assert(html.includes('id="spinMuteBtn"') && html.includes("localStorage.setItem('pb_spin_muted'"), 'Mute / unmute button for the preview (remembered)');
  assert(html.includes('v.muted = !!spinMuted'), 'Mute state applies to each opened clip');

  assert(html.includes('id="spinPrintPv"') && html.includes('function openSpinPrintPreview'), 'Spin & Print preview overlay exists');
  assert(/if \(!opts\.auto && !opts\.skipPreview\)\s*\{\s*openSpinPrintPreview/.test(html), 'Manual Spin & Print shows the preview first; auto-print skips it');
  // Top-3 UX improvements
  assert(html.includes('function spinSetEditBtn') && /#spinEditBtn small\s*\{/.test(html) && html.includes("'🎬 Edit video', spinPresetLabel()"), 'Edit button: one-line label with the preset as a subtitle (no mid-word wrapping)');
  assert(html.includes('id="spinStateBadge"') && html.includes("'✓ Rendered'") && html.includes("'✎ Draft preview'"), 'Rendered / Draft badge on the live preview');
  assert(html.includes('function spinUnlockEditing') && /it\.edited && !it\.isDrafting\) \{ spinUnlockEditing\(\)/.test(html) && html.includes("'✏️ Edit again'"), 'Edit again button unlocks a rendered clip in one click');
  assert(html.includes('function spinFrameTimes') && html.includes('id="spinPpOffset"') && /spinPrintItem\(spinPp\.it, \{ auto: false, solo: spinPp\.solo, offset:/.test(html), 'Spin & Print preview can re-pick moments (earlier / later slider)');
  assert(html.includes('figcaption') && html.includes('canvases.times'), 'Preview frames show the time they were taken from');
  // Improvements 4-8
  assert(html.includes('function spinPwText') && html.includes('id="spinShareWifiReveal"') && !/'Wi-Fi: ' \+ wf\.ssid \+ \(wf\.pass \? ' \/ ' \+ wf\.pass/.test(html), 'Wi-Fi password is hidden until "Show password" / a tap');
  assert(/id="spinText1" maxlength="60"/.test(html) && /id="spinText2" maxlength="80"/.test(html) && html.includes('function spinUpdateTextHints') && html.includes('Too wide for the video'), 'Text lines have a length limit and a too-wide warning');
  assert(html.includes('Click "Process changes" to apply them to the video.'), 'Draft hint tells the user changes need Process');
  assert(html.includes('id="spinPpPaper"') && html.includes('function spinPpFillPaper') && html.includes('spinPp.origSize'), 'Print preview has a paper-size picker that Back to Studio undoes');
  assert(html.includes('Full-screen video') && !html.includes('Hide QR Codes') && html.includes('v.muted = !!spinMuted;          // follows') && html.includes("'✓ Copied'"), 'Share modal: clearer toggle label, follows mute, visible Copy confirmation');
  assert(/@media \(max-width: 900px\)[\s\S]{0,300}\.spin-studio-preview \{ order: -1/.test(html) && html.includes('@media (pointer: coarse)') && html.includes('sc.scrollHeight > sc.clientHeight'), 'Tablet portrait stacks with preview first; touch targets are finger-sized; tabs still scroll when stacked');
  // Found by simulating the flow in a browser
  assert(html.includes('#spinEditBtn[hidden] { display: none; }'), 'Edit button stays hidden when editing is unavailable (display:flex must not beat [hidden])');
  assert(html.includes('if (!spinCur && spinQueue.length && spinOverlay && !spinOverlay.hidden) spinOpenItem(spinQueue[0]);'), 'The first clip added is selected automatically');
  assert(html.includes('var capH = Math.max(200') && html.includes("Math.round(capH * 9 / 16)"), 'Preview stage is exactly as wide as its aspect ratio needs (no wide black box)');
  assert(html.includes('.spin-pp-page[hidden]') && html.includes('var pick0 = ps0.filter'), 'Print preview still draws when no paper was chosen yet, and never shows a broken image');
  assert(html.includes("stepNum.textContent = wf ? '2' : '1'"), 'A lone download QR is labelled step 1');
  assert(html.includes('.spin-lock-banner { position: sticky; top: 0; z-index: 3; }') && html.includes('#spinCurClipBadge { max-width: 190px'), 'Lock banner stays visible; long clip names are truncated');
  assert(html.includes('.spin-head-title-wrap { display: none; }') && html.includes('.spin-time-seek { flex: 1 1 100%'), 'Narrow (phone) header and timeline fit the screen');
  // spinFrameTimes sanity (pure function copied from the page)
  {
    const m = html.match(/function spinFrameTimes\([\s\S]*?\n      \}/);
    const fn = new Function(m[0] + '; return spinFrameTimes;')();
    const t3 = fn(10, 3, 0), tSolo = fn(10, 1, 0.4), tEdge = fn(10, 3, -0.4);
    assert(Math.abs(t3[0] - 2.5) < 1e-9 && Math.abs(t3[2] - 7.5) < 1e-9, 'Frame times: 3 frames at 25% / 50% / 75% by default');
    assert(Math.abs(tSolo[0] - 9) < 1e-9 && tEdge[0] >= 0.5 - 1e-9, 'Frame times: offset moves frames and is clamped inside the clip');
  }
  assert(html.includes('function spinFinishPrint') && /spinPpPrint[\s\S]{0,400}spinFinishPrint/.test(html), '"Continue to print" hands off to the print screen');
}

// Test 4: Live Aspect Ratio & WYSIWYG Stage
console.log('\nTest 4: Live Aspect Ratio & WYSIWYG Stage');
{
  assert(html.includes('class="spin-stage-wrap" id="spinStageWrap"'), 'Stage wrap element is present');
  assert(html.includes('.spin-stage-wrap.is-square'), 'Square (1:1) aspect ratio class styled');
  assert(html.includes('.spin-stage-wrap.is-portrait'), 'Portrait (9:16) aspect ratio class styled');
  assert(html.includes('.spin-stage-wrap.is-landscape'), 'Landscape (16:9) aspect ratio class styled');
  assert(html.includes('spinPreviewCanvas'), 'Preview canvas for live WYSIWYG text overlay is active');
}

// Test 5: Drag-to-Position & Corner Resize Engine
console.log('\nTest 5: Interactive Drag-to-Position & Corner Resize Engine');
{
  assert(html.includes("cvs.addEventListener('pointerdown'"), 'Pointerdown listener attached for canvas drag');
  assert(html.includes('function hitHandle(lineNum'), 'Interactive corner resize handle hit detection implemented');
  assert(html.includes('function hitBox(lineNum'), 'Interactive text drag bounding box hit detection implemented');
  assert(html.includes('spinText1SizeVal') && html.includes('spinText2SizeVal'), 'Live numerical font size labels present');
}

// Test 6: Presets, Color Grade & Speed Ramp Beat Drop
console.log('\nTest 6: Multi-Presets & Cinematic Motion Controls');
{
  assert(html.includes('id="spinDesignPresetSelect"'), 'Design preset dropdown selector is present');
  assert(html.includes('id="spinSavePresetBtn"'), 'Save preset button is present');
  assert(html.includes('id="spinDeletePresetBtn"'), 'Delete preset button is present');
  assert(html.includes('id="spinLut"'), '3D LUT color grading dropdown is present');
  assert(html.includes('id="spinDropTime"'), 'Beat drop speed ramp timing control is present');
}

// Test 7: Share & QR Modal
console.log('\nTest 7: Dedicated Share & QR Code Modal');
{
  assert(html.includes('id="spinShareModal"'), '#spinShareModal exists');
  assert(html.includes('id="spinShareWifiQrImg"'), 'Step 1 Wi-Fi QR code image container exists');
  assert(html.includes('id="spinShareVideo"'), 'Center video preview player exists');
  assert(html.includes('id="spinShareDlQrImg"'), 'Step 2 Download QR code image container exists');
  assert(html.includes('id="spinShareToggleQr"'), 'Toggle/Hide QR codes button exists');
}

console.log('\n====================================================');
if (failed === 0) {
  console.log('  ALL UI/UX & NAVIGATION TESTS PASSED! ✅');
} else {
  console.error(`  ${failed} TESTS FAILED! ❌`);
  process.exit(1);
}
console.log('====================================================\n');
