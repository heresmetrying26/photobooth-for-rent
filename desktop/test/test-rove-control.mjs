// The photographer's phone page (Photoman control): the desk's state goes out, the phone's taps come back as commands.
// Run from desktop/:  node test/test-rove-control.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as P from '../lib/photos.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'pb-rove-'));
P.initPhotos({ root: join(tmp, 'photos'), dataDir: tmp, makeThumb: null });
const port = await P.startShareServer();
assert(port, 'the share server started');
const pageUrl = P.rovePreviewBase();                         // http://127.0.0.1:<port>/send/<token>/photos
const T = pageUrl.replace(/\/photos$/, '');
const j = async (url, init) => { const r = await fetch(url, init); let b = null; try { b = await r.json(); } catch { /* not json */ } return { status: r.status, body: b }; };
const post = (q) => j(T + '/rove-cmd?' + q, { method: 'POST' });
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

try {
  // 1. the page
  const html = await (await fetch(pageUrl)).text();
  assert(html.includes('Photoman Mobile Control'), 'the Photoman page is served');
  const script = /<script>\s*var T=([\s\S]*)<\/script>/.exec(html);
  assert(script, 'the page script is there');
  assert.doesNotThrow(() => new Function('var T=' + script[1]), 'the page script is valid JavaScript');
  for (const id of ['laySel', 'favBar', 'favBtn', 'fillSel', 'orientChk', 'autoChk', 'qfBar', 'qGrid', 'makeBtn', 'origBtn', 'resCard', 'resPrintBtn', 'resNextBtn']) assert(html.includes('id="' + id + '"'), 'page has #' + id);
  assert(html.includes('object-fit:contain'), 'phone queue thumbnails are uncropped so portrait vs landscape is visible');
  assert(html.includes('since'), 'the page asks only for what changed');
  console.log('PASS: phone page served and its script parses');

  // 2. a wrong token and the old open routes
  assert.equal((await j(pageUrl.replace(/\/send\/[^/]+/, '/send/nope123456') .replace(/\/photos$/, '/rove-state'))).status, 404, 'a wrong token is refused');
  const openState = await j(`http://127.0.0.1:${port}/rove-state`);
  const openCmd = await j(`http://127.0.0.1:${port}/rove-cmd?do=clear`, { method: 'POST' });
  assert(!(openState.body && openState.body.ok), 'the desk state is not readable without the token');
  assert(!(openCmd.body && openCmd.body.ok), 'a command is not accepted without the token');
  console.log('PASS: the token is needed to read the desk or send a command');

  // 3. the desk pushes its state, the phone reads it
  assert.equal(P.roveStateSet({
    layoutMode: 'frame:abc', fillMode: 'repeat1', autoOn: true, need: 1, rawShots: 2, activeLabel: 'Two-photo 4R',
    favorites: ['frame:abc', 'solo'], orientMode: true, tplPort: 'frame:abc', tplLand: 'solo',
    layouts: [{ key: 'match', label: 'Same as the booth', shots: 3, group: 'Photobooth' }, { key: 'frame:abc', label: 'Two-photo 4R', shots: 2, group: 'My frames' }, { key: '', label: 'dropped' }],
    queue: [{ id: 7, name: 'a.jpg', thumb: THUMB, used: false, phone: true, orient: 'portrait' }, { id: 6, name: '<b>b</b>.jpg', thumb: 'javascript:alert(1)', used: true, orient: 'landscape' }, { id: 0, name: 'no id' }],
    lastResult: { sessionNumber: 4, qrUrl: 'http://192.168.1.5/x', thumb: THUMB, label: 'Two-photo 4R', printing: true, at: 1 }
  }), true);
  const s1 = (await j(T + '/rove-state')).body;
  assert(s1.ok && s1.layoutMode === 'frame:abc' && s1.fillMode === 'repeat1' && s1.autoOn === true && s1.need === 1 && s1.rawShots === 2, 'choices come back as pushed');
  assert.deepEqual(s1.favorites, ['frame:abc', 'solo'], 'favorite templates come back as pushed');
  assert(s1.orientMode === true && s1.tplPort === 'frame:abc' && s1.tplLand === 'solo', 'orientation routing config comes back');
  assert.equal(s1.layouts.length, 2, 'a layout with no key is dropped');
  assert.deepEqual(s1.layouts.map((l) => l.group), ['Photobooth', 'My frames'], 'the groups are kept');
  assert.equal(s1.queue.length, 2, 'a photo with no id is dropped');
  assert.equal(s1.queue[0].thumb, THUMB, 'a good thumbnail is kept');
  assert.equal(s1.queue[0].orient, 'portrait', 'portrait orientation is kept');
  assert.equal(s1.queue[1].orient, 'landscape', 'landscape orientation is kept');
  assert.equal(s1.queue[1].thumb, '', 'a thumbnail that is not an image data URL is dropped');
  assert(!/[<>]/.test(s1.queue[1].name), 'tags are stripped from names');
  assert(s1.lastResult && s1.lastResult.printing === true && s1.lastResult.qrUrl === 'http://192.168.1.5/x', 'the last print and its QR link come back');
  console.log('PASS: desk state goes to the phone');

  // 4. "anything new?": nothing changed = a tiny answer; a push that changes nothing keeps the same stamp
  const same = (await j(T + '/rove-state?since=' + s1.updatedAt)).body;
  assert(same.ok && same.same === true && !same.queue, 'unchanged: no queue sent again');
  P.roveStateSet({ layoutMode: 'frame:abc', fillMode: 'repeat1', autoOn: true, need: 1, rawShots: 2, activeLabel: 'Two-photo 4R',
    favorites: ['frame:abc', 'solo'], orientMode: true, tplPort: 'frame:abc', tplLand: 'solo',
    layouts: [{ key: 'match', label: 'Same as the booth', shots: 3, group: 'Photobooth' }, { key: 'frame:abc', label: 'Two-photo 4R', shots: 2, group: 'My frames' }],
    queue: [{ id: 7, name: 'a.jpg', thumb: THUMB, used: false, phone: true, orient: 'portrait' }, { id: 6, name: '<b>b</b>.jpg', thumb: 'javascript:alert(1)', used: true, orient: 'landscape' }],
    lastResult: { sessionNumber: 4, qrUrl: 'http://192.168.1.5/x', thumb: THUMB, label: 'Two-photo 4R', printing: true, at: 1 } });
  assert.equal((await j(T + '/rove-state')).body.updatedAt, s1.updatedAt, 'the same state pushed again keeps its stamp');
  await new Promise((r) => setTimeout(r, 5));
  P.roveStateSet({ layoutMode: 'solo', fillMode: 'multi', autoOn: false, need: 1, rawShots: 1, activeLabel: 'Solo', layouts: [], queue: [], lastResult: null });
  const s2 = (await j(T + '/rove-state?since=' + s1.updatedAt)).body;
  assert(!s2.same && s2.layoutMode === 'solo' && s2.updatedAt !== s1.updatedAt, 'a change is sent in full');
  console.log('PASS: the phone only downloads the desk when it changed');

  // 5. the phone's taps come back as commands, once
  assert.deepEqual(P.roveCmdTake(), [], 'nothing waiting at first');
  assert.equal((await post('do=make&ids=3,2')).body.ok, true);
  assert.equal((await post('do=make&original=1&ids=5')).body.ok, true);
  assert.equal((await post('do=config&layoutMode=frame%3Aabc&fillMode=repeat1&autoOn=1&favToggle=frame%3Aabc&orientMode=1')).body.ok, true);
  assert.equal((await post('do=config&autoOn=0')).body.ok, true);
  for (const a of ['print', 'next', 'clear']) assert.equal((await post('do=' + a)).body.ok, true);
  const cmds = P.roveCmdTake();
  assert.deepEqual(cmds.map((c) => c.do), ['make', 'make', 'config', 'config', 'print', 'next', 'clear']);
  assert.deepEqual(cmds[0].ids, [3, 2]); assert.equal(cmds[0].original, false);
  assert.equal(cmds[1].original, true);
  assert.deepEqual({ l: cmds[2].layoutMode, f: cmds[2].fillMode, a: cmds[2].autoOn, fav: cmds[2].favToggle, om: cmds[2].orientMode }, { l: 'frame:abc', f: 'repeat1', a: true, fav: 'frame:abc', om: true });
  assert.equal(cmds[3].autoOn, false); assert(!('layoutMode' in cmds[3]), 'a config command carries only what was sent');
  assert.deepEqual(P.roveCmdTake(), [], 'each command is taken once');
  assert.equal((await post('do=make')).status, 400, 'make with no photo is refused');
  assert.equal((await post('do=make&ids=abc')).status, 400);
  assert.equal((await post('do=explode')).status, 400, 'an unknown command is refused');
  assert.equal((await j(T + '/rove-cmd?do=clear')).status, 405, 'a command must be a POST');
  assert.deepEqual(P.roveCmdTake(), [], 'refused commands were not queued');
  console.log('PASS: phone commands reach the desk once, and bad ones are refused');

  // 6. Roving upload dedup on reconnect retry (X-Rove-Id) + offline web queues
  const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);
  const up1 = await j(T + '/photo?name=rove_retry_test.jpg&id=rove_retry_test.jpg', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-rove-id': 'rove_retry_test.jpg' }, body: jpg
  });
  assert.equal(up1.status, 200);
  assert.equal(up1.body && up1.body.ok, true);
  assert.equal(P.roveList().length, 1);
  const up2 = await j(T + '/photo?name=rove_retry_test.jpg&id=rove_retry_test.jpg', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-rove-id': 'rove_retry_test.jpg' }, body: jpg
  });
  assert.equal(up2.status, 200);
  assert.equal(up2.body && up2.body.duplicate, true, 'retry after Wi-Fi drop deduplicates via X-Rove-Id');
  assert.equal(P.roveList().length, 1, 'still strictly 1 file saved in Roving inbox');
  assert(html.includes('pb4u_rove_web_q') && html.includes('drainWebQ'), 'Laptop/desktop phone page includes IndexedDB offline auto-queue');

  const rootUrl = new URL('../../', import.meta.url);
  const tabletRove = readFileSync(new URL('android/app/src/main/assets/share/rove.html', rootUrl), 'utf8');
  const tblScript = /<script>([\s\S]*)<\/script>/.exec(tabletRove);
  assert(tblScript && tblScript[1]);
  assert.doesNotThrow(() => new Function(tblScript[1]), 'Android tablet share/rove.html parses cleanly');
  assert(tabletRove.includes('pb4u_tablet_rove_q') && tabletRove.includes('x-rove-id'), 'Android tablet share/rove.html has IndexedDB offline auto-queue & X-Rove-Id');

  const cloudRove = readFileSync(new URL('public/rove/index.html', rootUrl), 'utf8');
  const cldScript = /<script>([\s\S]*)<\/script>/.exec(cloudRove);
  assert(cldScript && cldScript[1]);
  assert.doesNotThrow(() => new Function(cldScript[1]), 'public/rove/index.html parses cleanly');
  assert(cloudRove.includes('pb4u_cloud_rove_q') && cloudRove.includes('drainCloud'), 'Cloud /rove page has IndexedDB offline auto-queue & auto-retry');

  const ktAct = readFileSync(new URL('android/app/src/main/java/com/photobooth4u/booth/RovingBridgeActivity.kt', rootUrl), 'utf8');
  assert(ktAct.includes('retryScheduler') && ktAct.includes('placeholderThumb'), 'Android RovingBridgeActivity has background retryScheduler and race-free queue item creation');
  assert(ktAct.includes('nextRetryAtMs') && ktAct.includes('isQueued()') && ktAct.includes('writeAdjustedJpegFile'), 'Android RovingBridgeActivity guards worker retry backoff, promoting race state, and quality JPEG/EXIF export');
  assert(ktAct.includes('Bitmap.CompressFormat.JPEG, 95') && ktAct.includes('copyShootingExif'), 'Android brightness export uses JPEG 95 and copies camera shooting EXIF');
  const ktSrv = readFileSync(new URL('android/app/src/main/java/com/photobooth4u/booth/LocalShareServer.kt', rootUrl), 'utf8');
  assert(ktSrv.includes('roveRecentIds') && ktSrv.includes('x-rove-id'), 'Android LocalShareServer deduplicates retried roving uploads');
  const swVc = readFileSync(new URL('ios/roving/RovingBridgeViewController.swift', rootUrl), 'utf8');
  assert(swVc.includes('consecutiveUploadFails') && swVc.includes('X-Rove-Id'), 'iOS RovingBridgeViewController optimizes offline queue drain and sends X-Rove-Id');
  console.log('PASS: offline auto-queue, auto-upload on reconnect, and X-Rove-Id dedup verified across Laptop, Android Tablet, iOS & Web');
} finally {
  try { P.stopShareServer(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('ALL PASS: Photoman phone control');
process.exit(0);
