import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  initPhotos,
  driveRequest,
  startShareServer,
  stopShareServer,
  sharePortNow,
  guestViewNow,
  setGuestView
} from '../lib/photos.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'pb4u-solo-test-'));
const dataDir = mkdtempSync(join(tmpdir(), 'pb4u-data-test-'));

console.log('--- Testing Solo Photos Feature ---');

try {
  initPhotos({ root: tempRoot, dataDir, makeThumb: null });
  const port = await startShareServer();
  assert(port > 0, 'Share server should start on an available port');

  // 1. Create an event with composite photo + solo photos + gif
  const dummyPixelJpgBase64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

  const folderKey = 'Wedding of Sarah and John';
  const r1 = await driveRequest({
    folderKey,
    filename: '1_strip.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-abc1234567890xyz'
  });
  assert(r1.ok, 'Composite strip should be saved');

  const rSolo1 = await driveRequest({
    folderKey,
    filename: '1_solo_1.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-abc1234567890xyz'
  });
  assert(rSolo1.ok, 'Solo shot 1 should be saved');

  const rSolo2 = await driveRequest({
    folderKey,
    filename: '1_solo_2.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-abc1234567890xyz'
  });
  assert(rSolo2.ok, 'Solo shot 2 should be saved');

  const rSolo3 = await driveRequest({
    folderKey,
    filename: '1_solo_3.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-abc1234567890xyz'
  });
  assert(rSolo3.ok, 'Solo shot 3 should be saved');

  const slug = r1.folderUrl.replace('pb4u-local:', '');

  // Verify subfolder organization on disk in File Explorer / Finder
  assert(existsSync(join(r1.folderPath, 'Prints', '1_strip.jpg')), 'Print layout should be auto-saved in Prints/ subfolder');
  assert(existsSync(join(rSolo1.folderPath, 'Solo Shots', '1_solo_1.jpg')), 'Solo shot 1 should be auto-saved in Solo Shots/ subfolder');
  console.log('PASS: Subfolders auto-created in File Explorer: Prints/ and Solo Shots/');

  // Add GIF to guestCode to test 3-way sequence (Print -> GIF -> Solo shots)
  const rGif = await driveRequest({
    folderKey,
    filename: '1_gif.gif',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-abc1234567890xyz'
  });
  assert(rGif.ok, 'GIF should be saved');
  assert(existsSync(join(rGif.folderPath, 'GIFs', '1_gif.gif')), 'GIF should be auto-saved in GIFs/ subfolder');
  console.log('PASS: Subfolders auto-created in File Explorer: GIFs/');

  // 2. Test nextSession: make sure 1_solo_1, 1_solo_2, etc. don't inflate nextSession number
  const rResolve = await driveRequest({
    folderKey,
    resolveOnly: true
  });
  assert.equal(rResolve.nextSessionNumber, 2, 'Next session number should be 2, not inflated by solo shots');
  console.log('PASS: nextSessionNumber is correct (2)');

  // 3. Test station list endpoint (/station/:slug/list)
  const stationList = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/station/${slug}/list`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  assert(stationList.ok, 'Station list should succeed');
  assert.equal(stationList.files.length, 5, 'Should list 5 files total');
  const soloFiles = stationList.files.filter((f) => f.kind === 'solo');
  const printFiles = stationList.files.filter((f) => f.kind === 'photo');
  const gifFiles = stationList.files.filter((f) => f.kind === 'gif');
  assert.equal(soloFiles.length, 3, 'Should identify 3 solo photos');
  assert.equal(printFiles.length, 1, 'Should identify 1 print photo');
  assert.equal(gifFiles.length, 1, 'Should identify 1 gif');
  console.log('PASS: Station list distinguishes solo photos (kind="solo"), prints (kind="photo"), and gifs (kind="gif")');

  // 4. Test gallery HTML (/e/:slug/)
  const galleryHtml = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/e/${slug}/`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert(galleryHtml.includes('Solo Photos (3)'), 'Gallery HTML should include "Solo Photos (3)" tab');
  assert(galleryHtml.includes('Prints (1)'), 'Gallery HTML should label template composite as "Prints (1)"');
  assert(galleryHtml.includes('data-kind="solo"'), 'Gallery grid items should have data-kind="solo"');
  assert(galleryHtml.includes('filter-solo'), 'Gallery CSS filter rules should include filter-solo');
  console.log('PASS: Gallery page HTML includes Solo Photos tab and correct data-kind attributes');

  // 5. Test solo photo viewing page (/e/:slug/p/:file)
  const soloPageHtml = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/e/${slug}/p/1_solo_1.jpg`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert(soloPageHtml.includes('<h1>Solo photo</h1>'), 'Solo photo page should have "Solo photo" heading');
  assert(soloPageHtml.includes('Save solo photo'), 'Solo photo page should have "Save solo photo" button');
  console.log('PASS: Single photo page shows "Solo photo" title and "Save solo photo" button');

  // 6. Test guest personal view (/o/:code)
  const guestPageHtml = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/o/guest-code-abc1234567890xyz`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  assert(guestPageHtml.includes('Save solo photo'), 'Guest personal page should include Save solo photo button');
  const idxStrip = guestPageHtml.indexOf('1_strip.jpg');
  const idxGif = guestPageHtml.indexOf('1_gif.gif');
  const idxSolo1 = guestPageHtml.indexOf('1_solo_1.jpg');
  const idxSolo2 = guestPageHtml.indexOf('1_solo_2.jpg');
  assert(idxStrip !== -1 && idxGif !== -1 && idxSolo1 !== -1 && idxSolo2 !== -1, 'All files should be present in guest page');
  assert(idxStrip < idxGif, 'Print photo (in template) must appear 1st before GIF');
  assert(idxGif < idxSolo1, 'GIF must appear 2nd before solo shots');
  assert(idxSolo1 < idxSolo2, 'Solo shots must appear 3rd in numerical order');
  console.log('PASS: Guest personal page displays files in exact sequence: 1st Photo (Print) -> 2nd GIF -> 3rd Solo Shots');

  // 7. Test roving photoman session (both designed print 2_solo.jpg and raw solo photo 2_solo_1.jpg)
  const rRovingDesign = await driveRequest({
    folderKey,
    filename: '2_solo.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-roving-456'
  });
  assert(rRovingDesign.ok, 'Roving designed composite print should be saved');

  const rRovingSolo = await driveRequest({
    folderKey,
    filename: '2_solo_1.jpg',
    imageBase64: dummyPixelJpgBase64,
    guestCode: 'guest-code-roving-456'
  });
  assert(rRovingSolo.ok, 'Roving raw solo photo should be saved');

  const rResolve2 = await driveRequest({
    folderKey,
    resolveOnly: true
  });
  assert.equal(rResolve2.nextSessionNumber, 3, 'Next session number should be 3 after session 2');

  const stationList2 = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/station/${slug}/list`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  const soloFiles2 = stationList2.files.filter((f) => f.kind === 'solo');
  const printFiles2 = stationList2.files.filter((f) => f.kind === 'photo');
  assert.equal(soloFiles2.length, 4, 'Should now have 4 solo photos total (3 booth + 1 roving)');
  assert.equal(printFiles2.length, 2, 'Should now have 2 print photos total (1 booth strip + 1 roving design print)');
  console.log('PASS: Roving photoman uploads both designed print (2_solo.jpg) and raw solo photo (2_solo_1.jpg)');

  console.log('\nAll Solo Photos tests passed successfully!');
} finally {
  stopShareServer();
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

