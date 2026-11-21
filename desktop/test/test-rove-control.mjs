// The photographer's phone page (Photoman control): the desk's state goes out, the phone's taps come back as commands.
// Run from desktop/:  node test/test-rove-control.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
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
  for (const id of ['laySel', 'fillSel', 'autoChk', 'qGrid', 'makeBtn', 'origBtn', 'resCard', 'resPrintBtn', 'resNextBtn']) assert(html.includes('id="' + id + '"'), 'page has #' + id);
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
    layouts: [{ key: 'match', label: 'Same as the booth', shots: 3, group: 'Photobooth' }, { key: 'frame:abc', label: 'Two-photo 4R', shots: 2, group: 'My frames' }, { key: '', label: 'dropped' }],
    queue: [{ id: 7, name: 'a.jpg', thumb: THUMB, used: false, phone: true }, { id: 6, name: '<b>b</b>.jpg', thumb: 'javascript:alert(1)', used: true }, { id: 0, name: 'no id' }],
    lastResult: { sessionNumber: 4, qrUrl: 'http://192.168.1.5/x', thumb: THUMB, label: 'Two-photo 4R', printing: true, at: 1 }
  }), true);
  const s1 = (await j(T + '/rove-state')).body;
  assert(s1.ok && s1.layoutMode === 'frame:abc' && s1.fillMode === 'repeat1' && s1.autoOn === true && s1.need === 1 && s1.rawShots === 2, 'choices come back as pushed');
  assert.equal(s1.layouts.length, 2, 'a layout with no key is dropped');
  assert.deepEqual(s1.layouts.map((l) => l.group), ['Photobooth', 'My frames'], 'the groups are kept');
  assert.equal(s1.queue.length, 2, 'a photo with no id is dropped');
  assert.equal(s1.queue[0].thumb, THUMB, 'a good thumbnail is kept');
  assert.equal(s1.queue[1].thumb, '', 'a thumbnail that is not an image data URL is dropped');
  assert(!/[<>]/.test(s1.queue[1].name), 'tags are stripped from names');
  assert(s1.lastResult && s1.lastResult.printing === true && s1.lastResult.qrUrl === 'http://192.168.1.5/x', 'the last print and its QR link come back');
  console.log('PASS: desk state goes to the phone');

  // 4. "anything new?": nothing changed = a tiny answer; a push that changes nothing keeps the same stamp
  const same = (await j(T + '/rove-state?since=' + s1.updatedAt)).body;
  assert(same.ok && same.same === true && !same.queue, 'unchanged: no queue sent again');
  P.roveStateSet({ layoutMode: 'frame:abc', fillMode: 'repeat1', autoOn: true, need: 1, rawShots: 2, activeLabel: 'Two-photo 4R',
    layouts: [{ key: 'match', label: 'Same as the booth', shots: 3, group: 'Photobooth' }, { key: 'frame:abc', label: 'Two-photo 4R', shots: 2, group: 'My frames' }],
    queue: [{ id: 7, name: 'a.jpg', thumb: THUMB, used: false, phone: true }, { id: 6, name: '<b>b</b>.jpg', thumb: 'javascript:alert(1)', used: true }],
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
  assert.equal((await post('do=config&layoutMode=frame%3Aabc&fillMode=repeat1&autoOn=1')).body.ok, true);
  assert.equal((await post('do=config&autoOn=0')).body.ok, true);
  for (const a of ['print', 'next', 'clear']) assert.equal((await post('do=' + a)).body.ok, true);
  const cmds = P.roveCmdTake();
  assert.deepEqual(cmds.map((c) => c.do), ['make', 'make', 'config', 'config', 'print', 'next', 'clear']);
  assert.deepEqual(cmds[0].ids, [3, 2]); assert.equal(cmds[0].original, false);
  assert.equal(cmds[1].original, true);
  assert.deepEqual({ l: cmds[2].layoutMode, f: cmds[2].fillMode, a: cmds[2].autoOn }, { l: 'frame:abc', f: 'repeat1', a: true });
  assert.equal(cmds[3].autoOn, false); assert(!('layoutMode' in cmds[3]), 'a config command carries only what was sent');
  assert.deepEqual(P.roveCmdTake(), [], 'each command is taken once');
  assert.equal((await post('do=make')).status, 400, 'make with no photo is refused');
  assert.equal((await post('do=make&ids=abc')).status, 400);
  assert.equal((await post('do=explode')).status, 400, 'an unknown command is refused');
  assert.equal((await j(T + '/rove-cmd?do=clear')).status, 405, 'a command must be a POST');
  assert.deepEqual(P.roveCmdTake(), [], 'refused commands were not queued');
  console.log('PASS: phone commands reach the desk once, and bad ones are refused');
} finally {
  try { P.stopShareServer(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('ALL PASS: Photoman phone control');
process.exit(0);
