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
  assert(html.includes('.spin-locked-controls .spin-lock-banner'), 'Locked controls override allows banner interactions');
  assert(html.includes('.spin-locked-controls .spin-lock-banner *'), 'Locked controls override allows unlock button clicks');

  // Check spinModalUpdate lock logic
  assert(html.includes("var controlsCol = document.getElementById('spinStudioControls')"), 'spinModalUpdate targets #spinStudioControls for locking');
  assert(html.includes("controlsCol.classList.toggle('spin-locked-controls', !!isLocked)"), 'Locks/unlocks controls column dynamically');
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
