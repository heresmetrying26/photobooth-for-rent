// Runs the REAL protected/src/bridge/tablet-bridge.js in a sandbox (with stand-ins for the booth's own globals) and checks the screen
// state it builds for the tablet's guest screen: the photo after every shot, the finished photo with / without QR codes, the live
// resize preview, the booth's size settings, and that a slow older update can never replace a newer one.
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(process.env.PB_BRIDGE_SRC || join(ROOT, 'protected', 'src', 'bridge', 'tablet-bridge.js'), 'utf8');
const realFetch = globalThis.fetch;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function section(fn) {
  try { await fn(); } catch (e) { failed++; console.log('FAIL: ' + (e && e.message)); if (!process.env.PB_KEEP_GOING) throw e; }
}
const JPEG = (tag) => 'data:image/jpeg;base64,' + Buffer.from('jpeg-' + tag + '-' + 'x'.repeat(200)).toString('base64');

function makeCtx(opts = {}) {
  const pushed = [];
  let seq = 0;
  const posts = [];
  const ctx = {
    console, setInterval: () => 0, clearInterval() { }, setTimeout, Promise, JSON, Array, Object, Math, Date, Number, String, Error,
    parseFloat, encodeURIComponent, AbortSignal,
    DESKTOP: true, USB_SHOT_MAX: 3000,
    __ui: {},
    window: { pb4u: { bridge: { pushState: (p) => pushed.push(p), info: () => new Promise(() => { }), onStatus() { }, onAction() { }, camCmd() { }, sendEvent() { }, renew() { } } } },
    fetch: async (u, o) => {
      if (String(u).startsWith('data:')) return realFetch(u);
      const m = /bridge-local\/media\/([^?]+)/.exec(String(u));
      if (m) {
        const mySeq = ++seq;
        posts.push(m[1]);
        if (opts.slowFirstResult && m[1] === 'result' && mySeq === 1) await wait(120);
        return { ok: true, json: async () => ({ seq: mySeq }) };
      }
      return { ok: false, json: async () => ({}) };
    },
    // the booth's own globals the bridge reads
    guestWelcomeStyle: 'photo', readyOverlay: { classList: { contains: () => false } }, layoutEditorActive: false,
    state: 'idle', shotCanvases: [], sess: null, welcomeOn: false, pickOpen: false, welcomeDataUrl: '', attractMode: 'poster',
    attractPlaylist: [], attractPosterUrl: '', attractPosterType: 'image', attractPlayIndex: 0, attractPosterFit: 'cover', welcomeBtnOn: false, welcomeGeo: null,
    bgGuestStream: () => null, liveFilterCss: () => '', currentDeviceId: 'tablet-bridge', mirrorPreview: () => true,
    previewCanvas: { toDataURL: () => JPEG('strip') },
    labelInput: { value: 'Birthday' }, currentDateLabel: () => 'NOV 19', layoutBoxAspect: () => 0.8, camAspect: () => 1.3333,
    qrResults: { querySelectorAll: () => ctx.__slots || [] }, printFirstHolding: false,
    filmTrack: { children: [] }, shotThumb: () => 'data:image/jpeg;base64,THUMB',
    pickKeys: [], pickGrid: { children: [] }, pickDesignMode: false, pickDesignsList: [], pickIdx: 0,
    retakeBtn: { hidden: true, textContent: 'Retake' }, doneBtn: { hidden: true, textContent: 'Done' },
    guestLooksOn: false, isTraditional: () => false, guestLookKeys: () => [], FILTER_LABELS: {}, guestLookOpen: false, filterKey: 'normal',
    currentFolderLink: '', gvPrivate: () => false,
    printSection: { classList: { contains: () => false } }, printPrefs: { guestBtn: true, guestCopies: false, copies: 1, printFirst: false },
    printSize: '4x6', maxCopies: () => 3, printLimits: () => ({ se: 0, ev: 0 }), printQueued: 0, printTxt: (k) => k, noPrintSession: () => false,
    willAutoPrint: () => false, MAX_COPIES: 10, qrPopOn: false, hideQrOn: false, printing: false, autoPrint: false,
    qrPop: { phase: '' }, shareStationOn: false,
    layoutDef: () => ({ name: 'Strip' }), shotsNeeded: () => 4, readySub: { textContent: '' }, fx: { hands: '' }, countingDown: false,
    pickTitleText: () => 'Choose', retakesAllowed: () => true, SAMPLE_PORTRAITS: ['<svg id="a"/>', '<svg id="b"/>', '<svg id="c"/>'],
    enumerateCameras: async () => { }, savedCamera: () => null, initCamera: async () => true, showToast() { }, boothTrigger() { }, resetForNextGuest() { },
    updateGuestStatus() { }, updateFullStage() { }, cameraSelect: { options: [], value: '' }, streamActive: false, qrcode: null
  };
  ctx.document = {
    documentElement: { style: { getPropertyValue: (k) => ctx.__ui[k] || '' } },
    getElementById: (id) => (id === 'galleryPopQr' ? { src: '' } : id === 'qrSectionTitle' ? { textContent: ctx.__qrTitle || '' } : null),
    createElement: () => ({ style: {}, classList: { add() { }, remove() { } }, appendChild() { } })
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.tabletBridge.guestConnected = true;
  ctx.tabletBridge.camConnected = true;
  ctx.tabletBridge.port = 4321;
  return { ctx, pushed, posts };
}
const last = (pushed) => pushed[pushed.length - 1];
const slot = (kind, srcTag) => ({ dataset: { kind }, querySelector: (q) => (q === '.qr-img' ? { src: 'data:image/png;base64,' + srcTag } : q === '.qr-caption' ? { textContent: kind + ' caption' } : null) });
const shots = (n) => Array.from({ length: 4 }, (_, i) => (i < n ? { w: 1 } : null));

// 1. The photo just taken is shown on the tablet between shots, and goes away again
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.state = 'capturing'; ctx.shotCanvases = shots(1); ctx.sess = {};
  ctx.tabletBridgePushEvent('review', JPEG('shot1'));
  await wait(150);
  let p = last(pushed);
  assert(p, 'a screen state was sent after the review event');
  assert(/^\/media\/review\?v=\d+/.test(p.resSrc), 'the shot is sent as the review picture, got ' + p.resSrc);
  assert.equal(p.hideCam, true, 'the tablet\'s own camera picture is hidden while the shot is shown');
  assert.equal(p.useRemoteStream, false);
  ctx.tabletBridgePushEvent('reviewEnd');
  await wait(150);
  p = last(pushed);
  assert.equal(p.resSrc, '', 'the shot picture is gone after reviewEnd');
  assert.equal(p.hideCam, false, 'the camera picture is back');
  // a review left over from before a cancelled session is dropped
  ctx.tabletBridgePushEvent('review', JPEG('shot2'));
  ctx.sess = null; ctx.state = 'idle'; ctx.shotCanvases = [];
  await wait(150);
  assert.equal(last(pushed).resSrc, '', 'no picture when there is no session');
  console.log('PASS: the photo after every shot is sent to the tablet and removed again');
});

// 2. The finished photo: with QR codes, with no QR code, and while printing first
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.sess = {};
  ctx.__slots = [slot('photo', 'QR1'), slot('gif', 'QR2')];
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.equal(p.isResult, true); assert.equal(p.showQr, true);
  assert.equal(p.qrs.length, 2); assert(p.qrs[0].src.startsWith('data:image/png') && p.qrs[1].src.endsWith('QR2'), 'both QR pictures are in the state');
  assert(/^\/media\/result\?v=/.test(p.resSrc), 'the finished photo is sent'); assert.equal(p.printShow, true); assert.equal(p.nextShow, true);
  // no QR code at all (Step 7: no QR)
  ctx.__slots = []; ctx.hideQrOn = true;
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.showQr, false); assert.equal(p.qrs.length, 0); assert.equal(p.isResult, true); assert.equal(p.nextShow, true, 'Done is still there with no QR');
  // print first: the QR waits until printing is done
  ctx.hideQrOn = false; ctx.__slots = [slot('photo', 'QR1')]; ctx.printFirstHolding = true;
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.showQr, false, 'no QR while printing first'); assert.equal(p.msg, 'Printing your photos…');
  ctx.printFirstHolding = false;
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).showQr, true, 'the QR appears when printing is done');
  console.log('PASS: finished photo state: with QR codes, with no QR, and print first');
});

// 3. Stickers: the strip is shown while the guest decorates on the booth screen
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.state = 'capturing'; ctx.shotCanvases = shots(4); ctx.sess = { decorating: true };
  ctx.tabletBridgeSync(); await wait(150);
  const p = last(pushed);
  assert(/^\/media\/result\?v=/.test(p.resSrc), 'the strip is shown while decorating'); assert.equal(p.hideCam, true); assert.equal(p.msg, 'Customising photo…');
  console.log('PASS: sticker (decorate) screen state');
});

// 4. The booth's size settings and the live resize preview reach the tablet
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.__ui = { '--ui-cd-scale': '1.5', '--ui-btn-scale': '0.88', '--ui-film-scale': '0.95', '--ui-cd-opacity': '1', '--ui-btn-opacity': '0.7', '--ui-film-opacity': '1' };
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.deepEqual({ cd: p.ui.cd, btn: p.ui.btn, film: p.ui.film, btnOp: p.ui.btnOp }, { cd: 1.5, btn: 0.88, film: 0.95, btnOp: 0.7 }, 'size and opacity settings are in the state');
  assert.equal(p.editPreview, false);
  ctx.layoutEditorActive = true; ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.__slots = [slot('photo', 'QR1')];
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.editPreview, true, 'the resize preview is on'); assert.equal(p.isResult, false, 'the result screen gives way to the preview');
  assert.equal(p.retakeShow, true); assert.equal(p.doneShow, true);
  ctx.shotCanvases = []; ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.shots.length, 4, 'sample photos fill the strip'); assert(p.shots.every((s) => s.src.startsWith('data:image/svg+xml')));
  console.log('PASS: size settings and the live resize preview reach the tablet');
});

// 5. A slow older update never replaces a newer one, and keeps the photo and the QR together
await section(async () => {
  const { ctx, pushed } = makeCtx({ slowFirstResult: true });
  ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.sess = {};
  ctx.__slots = [];
  const a = ctx.buildAndPushTabletState();          // slow: still uploading the photo
  await wait(10);
  ctx.__slots = [slot('photo', 'QR1')];             // the QR appears meanwhile
  const b = ctx.buildAndPushTabletState();
  await Promise.all([a, b]);
  const p = last(pushed);
  assert.equal(p.showQr, true, 'the newest state (with the QR) is the one that stays');
  assert(/^\/media\/result\?v=/.test(p.resSrc), 'and it still has the photo, not an empty or old one');
  for (let i = 1; i < pushed.length; i++) assert(pushed[i] !== pushed[i - 1]);
  console.log('PASS: a slow older update cannot replace a newer one');
});

// 6. Two different photos never look the same to the upload cache
await section(async () => {
  const { ctx } = makeCtx();
  // Two real photos of the same size: the first 120 characters (the old check) are the same JPEG header, the rest differs everywhere.
  const photo = (seed) => { let h = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/'; let x = seed; for (let i = 0; i < 4000; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; h += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[x % 64]; } return h; };
  const a = photo(1), b = photo(2);
  assert.equal(a.length, b.length); assert.equal(a.slice(0, 120), b.slice(0, 120));
  assert.notEqual(ctx.tabletPicSig(a), ctx.tabletPicSig(b), 'two different photos of the same size get different fingerprints');
  assert.equal(ctx.tabletPicSig(a), ctx.tabletPicSig(a), 'the same photo gets the same fingerprint');
  console.log('PASS: picture fingerprints');
});
// 7. Setup > Step 7 "Show the QR code in a pop-up": the photo alone first, then the big QR card, like the booth screen
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.sess = {};
  ctx.__slots = [slot('photo', 'QR1')]; ctx.__qrTitle = 'Scan to get your photo';
  ctx.qrPopOn = true; ctx.qrPop = { phase: 'wait' };
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.equal(p.qrPop, 'wait'); assert.equal(p.showQr, false, 'no QR yet: the photo is on its own'); assert.equal(p.printShow, false); assert.equal(p.nextShow, false);
  assert(/^\/media\/result\?v=/.test(p.resSrc), 'the photo is shown while waiting');
  ctx.qrPop = { phase: 'show' };
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.qrPop, 'show'); assert.equal(p.showQr, true); assert.equal(p.qrs.length, 1); assert.equal(p.qrTitle, 'Scan to get your photo');
  assert.equal(p.printShow, true); assert.equal(p.nextShow, true);
  // pop-up with no QR code at all: the card holds Print and Done only
  ctx.hideQrOn = true; ctx.__slots = []; ctx.__qrTitle = '';
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.qrPop, 'show'); assert.equal(p.showQr, false); assert.equal(p.nextShow, true);
  // pop-up finished (or switched off): the normal result screen
  ctx.hideQrOn = false; ctx.__slots = [slot('photo', 'QR1')]; ctx.qrPop = { phase: '' };
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.qrPop, ''); assert.equal(p.showQr, true);
  // the share station has its own hand-off: no pop-up phases on the tablet
  ctx.shareStationOn = true; ctx.qrPop = { phase: 'wait' };
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).qrPop, '');
  console.log('PASS: QR pop-up phases (photo alone, big QR card, no QR, share station)');
});

if (failed) { console.log(failed + ' check(s) failed'); process.exit(1); }
console.log('All tablet state tests passed!');
