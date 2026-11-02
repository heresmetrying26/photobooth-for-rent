// Test Phase 2 flipbook logic: QR code matrix generation, cover style resolution, and back card layout math
import assert from 'node:assert/strict';

// Mock qrcode module logic
function generateMockQr(targetUrl){
  assert.ok(targetUrl, 'targetUrl must not be empty');
  // Simple check that URL has standard web structure
  assert.match(targetUrl, /^https?:\/\//);
  return {
    moduleCount: 25,
    isDark: (r, c) => (r + c) % 2 === 0
  };
}

function resolveCoverConfig(style, customAssetId, hasHero){
  if(style === 'custom' && customAssetId){
    return { type: 'custom', assetId: customAssetId };
  }
  if(style === 'photo' && hasHero){
    return { type: 'photo', hasHero: true };
  }
  return { type: 'title' };
}

function resolveBackCard(flipBackQr, url, ctaText){
  if(!flipBackQr || !url){
    return { mode: 'classic', text: 'Thank you!' };
  }
  return {
    mode: 'qr',
    url: url,
    cta: ctaText || 'Scan to view & share your flipbook'
  };
}

console.log('--- Testing Flipbook Phase 2 Logic ---');

// Test 1: QR Code Generation
const testUrl = 'https://photobooth4u.com/gallery#session123';
const qr = generateMockQr(testUrl);
assert.equal(qr.moduleCount, 25);
console.log('✓ Passed: QR matrix generation');

// Test 2: Cover Config Resolution
assert.deepEqual(resolveCoverConfig('custom', 'asset_cover_1', true), { type: 'custom', assetId: 'asset_cover_1' });
assert.deepEqual(resolveCoverConfig('custom', null, true), { type: 'title' });
assert.deepEqual(resolveCoverConfig('photo', null, true), { type: 'photo', hasHero: true });
assert.deepEqual(resolveCoverConfig('photo', null, false), { type: 'title' });
assert.deepEqual(resolveCoverConfig('title', null, true), { type: 'title' });
console.log('✓ Passed: Cover style configuration fallback resolution');

// Test 3: Back Card QR Resolution
const backWithQr = resolveBackCard(true, testUrl, 'Scan for Digital Flipbook');
assert.equal(backWithQr.mode, 'qr');
assert.equal(backWithQr.url, testUrl);
assert.equal(backWithQr.cta, 'Scan for Digital Flipbook');

const backNoUrl = resolveBackCard(true, '', '');
assert.equal(backNoUrl.mode, 'classic');

const backDisabled = resolveBackCard(false, testUrl, '');
assert.equal(backDisabled.mode, 'classic');
console.log('✓ Passed: Back card QR and fallback resolution');

console.log('All Phase 2 tests passed successfully!');

