// Test stack-cut and sequential imposition algorithms for photobooth flipbook
import assert from 'node:assert/strict';

function flipGrid(paperW, paperH, cellW = 45, cellH = 34, margin = 4){
  const cols = Math.max(1, Math.floor((paperW - 2 * margin) / cellW));
  const rows = Math.max(1, Math.floor((paperH - 2 * margin) / cellH));
  return { cols, rows, per: cols * rows };
}

function generateImposition(totalItems, perSheet, mode = 'stack'){
  const totalSheets = Math.max(1, Math.ceil(totalItems / perSheet));
  const sheets = [];

  for(let s = 0; s < totalSheets; s++){
    const cells = [];
    for(let k = 0; k < perSheet; k++){
      let idx;
      if(mode === 'stack'){
        idx = k * totalSheets + s;
      } else {
        idx = s * perSheet + k;
      }
      cells.push(idx < totalItems ? idx : null);
    }
    sheets.push(cells);
  }
  return { totalSheets, sheets };
}

function simulateCutAndStack(impositionResult, perSheet){
  const { totalSheets, sheets } = impositionResult;
  // Pile k contains items across sheet 0..totalSheets-1 at cell k
  const assembled = [];
  for(let k = 0; k < perSheet; k++){
    for(let s = 0; s < totalSheets; s++){
      const item = sheets[s][k];
      if(item !== null && item !== undefined){
        assembled.push(item);
      }
    }
  }
  return assembled;
}

console.log('--- Testing Flipbook Stack-Cut Imposition Math ---');

// Case 1: Standard 4x6" paper (152.4 x 101.6 mm) with 26 items (Cover + 24 frames + Back)
const grid4x6 = flipGrid(152.4, 101.6);
console.log(`Grid for 4x6: ${grid4x6.cols} cols x ${grid4x6.rows} rows = ${grid4x6.per} cards per sheet`);
assert.equal(grid4x6.per >= 6, true, '4x6 should fit at least 6 cards');

const testCases = [
  { name: '26 items, 6 per sheet (3x2)', count: 26, per: 6 },
  { name: '32 items, 6 per sheet (3x2)', count: 32, per: 6 },
  { name: '18 items, 6 per sheet (3x2)', count: 18, per: 6 },
  { name: '42 items, 8 per sheet (4x2)', count: 42, per: 8 },
  { name: '5 items, 6 per sheet (single sheet)', count: 5, per: 6 },
  { name: '1 item, 6 per sheet (single item)', count: 1, per: 6 }
];

for(const tc of testCases){
  const imp = generateImposition(tc.count, tc.per, 'stack');
  const assembled = simulateCutAndStack(imp, tc.per);
  
  // Verify assembled booklet order
  assert.equal(assembled.length, tc.count, `${tc.name}: Assembled count must match total items`);
  for(let i = 0; i < tc.count; i++){
    assert.equal(assembled[i], i, `${tc.name}: Item at index ${i} must be ${i}, got ${assembled[i]}`);
  }
  console.log(`✓ Passed: ${tc.name} -> ${imp.totalSheets} sheets, perfect 0..${tc.count - 1} order`);
}

// Case 2: Verify sequential grid mode still functions as expected
const seqImp = generateImposition(15, 6, 'grid');
assert.equal(seqImp.sheets[0][0], 0);
assert.equal(seqImp.sheets[0][5], 5);
assert.equal(seqImp.sheets[1][0], 6);
assert.equal(seqImp.sheets[2][0], 12);
assert.equal(seqImp.sheets[2][3], null);
console.log('✓ Passed: Sequential grid verification');

console.log('All flipbook imposition tests passed successfully!');
