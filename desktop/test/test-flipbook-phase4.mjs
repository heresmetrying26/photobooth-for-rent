import assert from 'node:assert';

console.log('--- Testing Flipbook Phase 4: Multi-Printer Pooling & Presets ---');

// 1. Grid Preset Logic
function calculateFlipGrid(paper, preset = 'auto') {
  const FLIP_CELL_W = 45, FLIP_CELL_H = 34, FLIP_MARGIN = 4;
  if (preset === '6up') {
    const land = paper.w >= paper.h;
    const cols = land ? 3 : 2, rows = land ? 2 : 3;
    return { cols, rows, per: cols * rows };
  }
  if (preset === '8up') {
    const land = paper.w >= paper.h;
    const cols = land ? 4 : 2, rows = land ? 2 : 4;
    return { cols, rows, per: cols * rows };
  }
  const cols = Math.max(1, Math.floor((paper.w - 2 * FLIP_MARGIN) / FLIP_CELL_W));
  const rows = Math.max(1, Math.floor((paper.h - 2 * FLIP_MARGIN) / FLIP_CELL_H));
  return { cols, rows, per: cols * rows };
}

// 4x6 Landscape (152.4 x 101.6 mm)
const p4x6Land = { w: 152.4, h: 101.6 };
assert.deepStrictEqual(calculateFlipGrid(p4x6Land, '6up'), { cols: 3, rows: 2, per: 6 });
assert.deepStrictEqual(calculateFlipGrid(p4x6Land, '8up'), { cols: 4, rows: 2, per: 8 });

// 4x6 Portrait (101.6 x 152.4 mm)
const p4x6Port = { w: 101.6, h: 152.4 };
assert.deepStrictEqual(calculateFlipGrid(p4x6Port, '6up'), { cols: 2, rows: 3, per: 6 });
assert.deepStrictEqual(calculateFlipGrid(p4x6Port, '8up'), { cols: 2, rows: 4, per: 8 });
assert.deepStrictEqual(calculateFlipGrid(p4x6Port, 'auto'), { cols: 2, rows: 4, per: 8 });

// 6x8 Landscape (203.2 x 152.4 mm)
const p6x8Land = { w: 203.2, h: 152.4 };
assert.deepStrictEqual(calculateFlipGrid(p6x8Land, '8up'), { cols: 4, rows: 2, per: 8 });
console.log('✓ Passed: Paper profile grid presets (6-up, 8-up, auto)');

// 2. Printer Pooling Dispatch Logic
function dispatchPooledPrints({ allPages, copies, singleCopiesPages, p1, p2, poolMode }) {
  if (!p2 || p1 === p2) {
    return { p1Pages: allPages, p2Pages: [] };
  }
  const p1Pages = [];
  const p2Pages = [];
  if (poolMode === 'copies' && copies > 1) {
    for (let c = 0; c < copies; c++) {
      if (c % 2 === 0) p1Pages.push(...singleCopiesPages);
      else p2Pages.push(...singleCopiesPages);
    }
  } else {
    for (let i = 0; i < allPages.length; i++) {
      if (i % 2 === 0) p1Pages.push(allPages[i]);
      else p2Pages.push(allPages[i]);
    }
  }
  return { p1Pages, p2Pages };
}

// Scenario A: 4 sheets, 1 copy, alternate sheets
const sheets4 = ['S0', 'S1', 'S2', 'S3'];
const resA = dispatchPooledPrints({
  allPages: sheets4,
  copies: 1,
  singleCopiesPages: sheets4,
  p1: 'DNP-A',
  p2: 'DNP-B',
  poolMode: 'pages'
});
assert.deepStrictEqual(resA.p1Pages, ['S0', 'S2']);
assert.deepStrictEqual(resA.p2Pages, ['S1', 'S3']);
console.log('✓ Passed: Round-robin page pooling alternates sheets across 2 printers');

// Scenario B: 4 sheets, 2 copies, alternate copies mode
const sheetsCopy = ['S0', 'S1', 'S2', 'S3'];
const allCopies = [...sheetsCopy, ...sheetsCopy];
const resB = dispatchPooledPrints({
  allPages: allCopies,
  copies: 2,
  singleCopiesPages: sheetsCopy,
  p1: 'DNP-A',
  p2: 'DNP-B',
  poolMode: 'copies'
});
assert.deepStrictEqual(resA.p1Pages, ['S0', 'S2']);
assert.deepStrictEqual(resB.p1Pages, ['S0', 'S1', 'S2', 'S3']); // Copy 0
assert.deepStrictEqual(resB.p2Pages, ['S0', 'S1', 'S2', 'S3']); // Copy 1
console.log('✓ Passed: Copy-level pooling distributes full booklets across printers');

// Scenario C: No pool printer (single printer fallback)
const resC = dispatchPooledPrints({
  allPages: sheets4,
  copies: 1,
  singleCopiesPages: sheets4,
  p1: 'DNP-A',
  p2: '',
  poolMode: 'pages'
});
assert.deepStrictEqual(resC.p1Pages, ['S0', 'S1', 'S2', 'S3']);
assert.deepStrictEqual(resC.p2Pages, []);
console.log('✓ Passed: Fallback to single printer when pool printer is unassigned');

// 3. Per-Printer Queue Independence
const printQueues = new Map();
function getPrintQueue(name) {
  if (!printQueues.has(name)) printQueues.set(name, Promise.resolve());
  return printQueues.get(name);
}

const executionOrder = [];
const p1Promise = getPrintQueue('P1').then(async () => {
  await new Promise(r => setTimeout(r, 30));
  executionOrder.push('P1-Job1');
});
printQueues.set('P1', p1Promise);

const p2Promise = getPrintQueue('P2').then(async () => {
  await new Promise(r => setTimeout(r, 10)); // finishes faster than P1
  executionOrder.push('P2-Job1');
});
printQueues.set('P2', p2Promise);

await Promise.all([p1Promise, p2Promise]);
// P2 finishes before P1 because they run concurrently!
assert.deepStrictEqual(executionOrder, ['P2-Job1', 'P1-Job1']);
console.log('✓ Passed: Helper concurrent per-printer queue execution');

console.log('All Phase 4 tests passed successfully!');

