// The phone "Send" page v2 and its endpoints: config, clips, choice, act, cmd.
// Run from desktop/:  node test/test-send-v2.mjs
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as P from '../lib/photos.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'pb-send-'));
const inbox = join(tmp, 'inbox'); mkdirSync(inbox, { recursive: true });
P.initPhotos({ root: join(tmp, 'photos'), dataDir: tmp, makeThumb: null });
P.setSpinDir(inbox);
const port = await P.startShareServer();
assert(port, 'the share server started');
const base = P.spinPreviewBase();
const j = async (path, init) => { const r = await fetch(base + path, init); let b = null; try { b = await r.json(); } catch { /* not json */ } return { status: r.status, body: b }; };
const post = (path) => j(path, { method: 'POST' });
const clip = (n) => { writeFileSync(join(inbox, n), Buffer.alloc(20000, 1)); return n; };

try {
  // the page
  const html = await (await fetch(base)).text();
  assert(html.includes('360 Arm Phone') && !html.includes('__T__'), 'page served, token filled in');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(script), 'the page script is valid JavaScript');
  for (const id of ['conn', 'guide', 'choices', 'cd', 'recent', 'clips', 'list']) assert(html.includes('id="' + id + '"'), 'page has #' + id);
  console.log('PASS: page served and its script parses');

  // wrong token
  const bad = await fetch(base.replace(/\/send\/.*/, '/send/nope123456/config'));
  assert.equal(bad.status, 404, 'wrong token is refused');

  // config
  let c = await j('/config');
  assert.equal(c.status, 200); assert.equal(c.body.ok, true); assert.equal(c.body.choices.look, false);
  assert.equal(c.body.arm.trigger, 'arm'); assert.equal(c.body.arm.stopMode, 'follow'); assert.equal(c.body.arm.fps, 60);
  P.spinSendCfgSet({ guide: {}, choices: {}, arm: { trigger: 'bogus', stopMode: 'bogus', fps: 99 } });
  c = await j('/config');
  assert.equal(c.body.arm.trigger, 'arm'); assert.equal(c.body.arm.stopMode, 'follow'); assert.equal(c.body.arm.fps, 60);
  P.spinSendCfgSet({ guide: { spinSec: 8, spins: 1, recordSec: 10.5, trigger: 'Start when the arm moves', note: '<b>x</b>' }, choices: { look: true, music: true, speed: true, text: true, gif: true },
    music: [{ key: 'm1', title: 'Chill' }, { key: '', title: 'bad' }], speeds: [{ key: 'slow', title: 'Slow' }], laptop: 'Booth laptop',
    arm: { trigger: 'desk', stopMode: 'fixed', fixedSec: 999, tailSec: -2, maxSec: 120, cooldownSec: 25, fps: 120 } });
  c = await j('/config');
  assert.equal(c.body.guide.recordSec, 10.5); assert.equal(c.body.music.length, 1, 'an option without a key is dropped');
  assert(!c.body.guide.note.includes('<'), 'markup is stripped from texts');
  assert.equal(c.body.arm.trigger, 'desk'); assert.equal(c.body.arm.stopMode, 'fixed');
  assert.equal(c.body.arm.fixedSec, 60, 'fixedSec clamped'); assert.equal(c.body.arm.tailSec, 0, 'tailSec clamped');
  assert.equal(c.body.arm.maxSec, 60, 'maxSec clamped'); assert.equal(c.body.arm.cooldownSec, 20, 'cooldownSec clamped');
  assert.equal(c.body.arm.fps, 120);
  console.log('PASS: config');

  // choice
  assert.equal((await post('/choice?name=ghost.mp4&look=a')).status, 400, 'a clip that is not in the inbox is refused');
  assert.equal((await post('/choice?name=' + encodeURIComponent('../evil.mp4'))).status, 400, 'a path is refused');
  const n1 = clip('one.mp4');
  P.spinLookOfferSet({ on: true, looks: [{ key: 'gold', title: 'Gold', icon: '★', c1: '#C93D27', c2: '#E0A21B' }] });
  let r = await post('/choice?name=' + n1 + '&look=nope&music=zzz');
  assert.equal(r.body.queued, false, 'choices that are not on the lists are ignored');
  r = await post('/choice?name=' + n1 + '&look=gold&music=m1&speed=slow&text=' + encodeURIComponent('Ana <3') + '&gif=1');
  assert.equal(r.body.queued, true);
  await post('/choice?name=' + n1 + '&look=gold&music=m1');
  let q = P.spinSendTake();
  assert.equal(q.filter((x) => x.type === 'choice').length, 1, 'the newest choice for a clip wins');
  assert.equal(q[0].look, 'gold'); assert.equal(q[0].music, 'm1');
  assert.equal(P.spinSendTake().length, 0, 'taking empties the queue');
  P.spinSendCfgSet({ guide: {}, choices: { look: false } });
  r = await post('/choice?name=' + n1 + '&look=gold');
  assert.equal(r.body.queued, false, 'a choice the desk does not offer is ignored');
  console.log('PASS: choice');

  // act
  assert.equal((await post('/act?name=' + n1 + '&do=explode')).status, 400);
  assert.equal((await post('/act?name=' + n1 + '&do=reedit')).status, 200);
  q = P.spinSendTake(); assert.equal(q[0].do, 'reedit');
  assert.equal((await post('/act?name=' + n1 + '&do=delete')).status, 200);
  assert(!existsSync(join(inbox, n1)) && existsSync(join(inbox, 'deleted', n1)), 'delete moves the clip to deleted/');
  assert.equal(P.spinSendTake()[0].do, 'delete');
  assert.equal((await post('/act?name=' + n1 + '&do=reedit')).status, 400, 'a deleted clip is no longer in the inbox');
  assert.equal((await j('/act?name=x.mp4&do=reedit')).status, 405, 'GET is refused');
  console.log('PASS: act');

  // cmd
  assert.equal((await post('/cmd?do=countdown')).status, 200);
  assert.equal((await post('/cmd?do=countdown')).status, 429, 'commands are rate limited');
  assert.equal((await post('/cmd?do=reboot')).status, 400);
  assert.equal(P.spinSendTake().filter((x) => x.type === 'cmd').length, 1);
  console.log('PASS: cmd');

  // clips
  P.spinClipsSet([{ name: 'a.mp4', status: 'editing', pct: 130, url: 'javascript:alert(1)' }, { name: 'b.mp4', status: 'ready', url: 'http://192.168.1.2:47777/e/x/p/b.mp4', look: 'Gold' }, { name: '', status: 'new' }]);
  const cl = (await j('/clips')).body.clips;
  assert.equal(cl.length, 2); assert.equal(cl[0].pct, 100, 'percent is capped'); assert.equal(cl[0].url, '', 'only http(s) links are passed on');
  assert.equal(cl[1].status, 'ready'); assert.equal(cl[1].look, 'Gold');
  console.log('PASS: clips');

  // arm-state, arm-poll, wall cue & desk->arm commands
  assert.equal(P.spinArmStateNow().connected, false, 'arm starts disconnected');
  let armRes = await j('/arm-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device: 'iPhone 15 Pro', state: 'idle', gyroDps: 4.5, thresholdDps: 28, battery: 88, fps: 60, lens: '0.5×' })
  });
  assert.equal(armRes.status, 200); assert.equal(armRes.body.ok, true);
  let armNow = P.spinArmStateNow();
  assert.equal(armNow.connected, true); assert.equal(armNow.device, 'iPhone 15 Pro');
  assert.equal(armNow.battery, 88); assert.equal(armNow.thresholdDps, 28);

  // Query fallback + recording transition -> recAt + wall cue
  armRes = await post('/arm-state?state=recording&recSec=2.5&gyroDps=52');
  assert.equal(armRes.status, 200);
  const conn = P.spinConnectInfo(false);
  assert.equal(conn.arm.state, 'recording');
  assert(conn.recAt > 0, 'recording state updates conn.recAt');
  assert.equal(P.getWallCue().action, 'recording', 'recording state triggers wall cue');

  // Transition out of recording clears wall cue
  armRes = await j('/arm-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'cooldown', gyroDps: 3.1 })
  });
  assert.equal(armRes.status, 200);
  assert.equal(P.getWallCue().action, 'idle', 'leaving recording resets wall cue to idle');

  // Desk -> arm commands & single drain
  assert.equal(P.spinArmCmdPush('invalid').ok, false, 'invalid arm command rejected');
  assert.equal(P.spinArmCmdPush('start').ok, true);
  assert.equal(P.spinArmCmdPush('calibrate').ok, true);
  const poll1 = await j('/arm-poll');
  assert.equal(poll1.status, 200);
  assert.deepEqual(poll1.body.cmds.map((x) => x.cmd), ['start', 'calibrate']);
  assert.equal((await post('/arm-state?state=idle')).body.cmds.length, 0, 'commands drained after delivery');

  assert.equal(P.spinArmCmdPush('stop').ok, true);
  const stWithCmd = await post('/arm-state?state=recording');
  assert.deepEqual(stWithCmd.body.cmds.map((x) => x.cmd), ['stop'], 'arm-state delivers pending commands');
  assert.equal((await j('/arm-poll')).body.cmds.length, 0, 'commands drained after arm-state');
  console.log('PASS: arm-state & arm-poll');
  console.log('ALL PASS');
} finally {
  P.stopShareServer();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(0);
