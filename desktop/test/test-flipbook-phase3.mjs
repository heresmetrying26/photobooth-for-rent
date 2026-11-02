import assert from 'node:assert';

console.log('--- Testing Flipbook Phase 3: Interactive Guest Experience ---');

// 1. Motion Cues Cycling Math
const CUES = ['Action! Dance & move!', 'Spin or strike a pose!', 'Show your best moves!', 'Big finale! Jump!'];
function getCueAtFrac(frac, cuesEnabled) {
  if (!cuesEnabled) return '';
  const clamped = Math.min(0.99, Math.max(0, frac));
  return CUES[Math.floor(clamped * CUES.length)];
}

assert.strictEqual(getCueAtFrac(0.0, true), 'Action! Dance & move!');
assert.strictEqual(getCueAtFrac(0.1, true), 'Action! Dance & move!');
assert.strictEqual(getCueAtFrac(0.26, true), 'Spin or strike a pose!');
assert.strictEqual(getCueAtFrac(0.51, true), 'Show your best moves!');
assert.strictEqual(getCueAtFrac(0.76, true), 'Big finale! Jump!');
assert.strictEqual(getCueAtFrac(0.99, true), 'Big finale! Jump!');
assert.strictEqual(getCueAtFrac(0.5, false), '');
console.log('✓ Passed: Dynamic motion prompt timing and cycling');

// 2. Flipbook Scrubber Navigation Math
function scrubToCard(clickX, tx1, tx2, totalCards) {
  const tLen = tx2 - tx1;
  const frac = Math.max(0, Math.min(1, (clickX - tx1) / tLen));
  return Math.round(frac * (totalCards - 1));
}

const tx1 = 230, tx2 = 746, totalCards = 26;
assert.strictEqual(scrubToCard(tx1, tx1, tx2, totalCards), 0);
assert.strictEqual(scrubToCard(tx2, tx1, tx2, totalCards), 25);
assert.strictEqual(scrubToCard(tx1 - 50, tx1, tx2, totalCards), 0); // Out of bounds left clamp
assert.strictEqual(scrubToCard(tx2 + 50, tx1, tx2, totalCards), 25); // Out of bounds right clamp
assert.strictEqual(scrubToCard(tx1 + (tx2 - tx1) / 2, tx1, tx2, totalCards), 13); // Midpoint clamp
console.log('✓ Passed: Scrubber coordinate mapping and boundary clamping');

// 3. Flipbook Step & Bounds
function stepCard(currentIdx, dir, totalCards) {
  return Math.max(0, Math.min(totalCards - 1, currentIdx + dir));
}

assert.strictEqual(stepCard(0, -1, totalCards), 0); // clamp min
assert.strictEqual(stepCard(0, 1, totalCards), 1);
assert.strictEqual(stepCard(25, 1, totalCards), 25); // clamp max
assert.strictEqual(stepCard(25, -1, totalCards), 24);
console.log('✓ Passed: Prev/Next step card navigation and boundaries');

// 4. Sheet Grid Click-to-Jump Math
function gridClickToIndex(ptX, ptY, pad, cw, ch, cols, totalItems) {
  if (ptY < pad) return null; // Header area
  const col = Math.floor(ptX / cw);
  const row = Math.floor((ptY - pad) / ch);
  const idx = row * cols + col;
  return (idx >= 0 && idx < totalItems) ? idx : null;
}

const pad = 54, cw = 200, ch = 150, cols = 6;
assert.strictEqual(gridClickToIndex(100, 20, pad, cw, ch, cols, totalCards), null); // Header
assert.strictEqual(gridClickToIndex(50, pad + 10, pad, cw, ch, cols, totalCards), 0); // Card 0 (Row 0, Col 0)
assert.strictEqual(gridClickToIndex(250, pad + 10, pad, cw, ch, cols, totalCards), 1); // Card 1 (Row 0, Col 1)
assert.strictEqual(gridClickToIndex(50, pad + 160, pad, cw, ch, cols, totalCards), 6); // Card 6 (Row 1, Col 0)
assert.strictEqual(gridClickToIndex(1150, pad + 160, pad, cw, ch, cols, totalCards), 11); // Card 11 (Row 1, Col 5)
assert.strictEqual(gridClickToIndex(1150, pad + 700, pad, cw, ch, cols, totalCards), null); // Past totalCards
console.log('✓ Passed: Sheet grid click-to-jump index resolution');

// 5. Timer / Auto-Play State Management
let autoPlaying = false;
let playTimer = null;
let currentCard = 0;

function startAutoPlay(total) {
  stopAutoPlay();
  autoPlaying = true;
  playTimer = { id: 123 }; // mock interval
}

function stopAutoPlay() {
  if (playTimer) playTimer = null;
  autoPlaying = false;
}

startAutoPlay(totalCards);
assert.strictEqual(autoPlaying, true);
assert.notStrictEqual(playTimer, null);

stopAutoPlay();
assert.strictEqual(autoPlaying, false);
assert.strictEqual(playTimer, null);
console.log('✓ Passed: Auto-flip timer state lifecycle');

console.log('All Phase 3 tests passed successfully!');

