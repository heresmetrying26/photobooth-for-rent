// Runs the REAL protected/src/bridge/tablet-bridge.js in a sandbox (with stand-ins for the booth's own globals) and checks the screen
// state it builds for the tablet's guest screen: the photo after every shot, the finished photo with / without QR codes, the live
// resize preview, the booth's size settings, and that a slow older update can never replace a newer one.
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTH = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
const DECLARED = new Set();
for (const m of BOOTH.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) DECLARED.add(m[1]);
for (const m of BOOTH.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) DECLARED.add(m[1]);
for (const m of BOOTH.matchAll(/[,]\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) DECLARED.add(m[1]);
for (const m of BOOTH.matchAll(/\b(?:var|let|const)\s*\{([^}]*)\}/g)) m[1].split(',').forEach((x) => DECLARED.add(x.split(':').pop().split('=')[0].trim()));
const HOST = new Set(['console', 'setInterval', 'clearInterval', 'setTimeout', 'AbortSignal', 'fetch', 'window', 'document', '__ui', '__slots', '__qrTitle']);
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
    labelInput: { value: 'Birthday' }, currentDateLabel: () => 'NOV 19', currentBoxAspect: () => 0.8, camAspect: () => 1.3333, shotBoxAspect: () => 0.75, stageShot: 0,
    qrResults: { querySelectorAll: () => ctx.__slots || [] }, printFirstHolding: false,
    filmTrack: { children: [] }, shotThumb: () => 'data:image/jpeg;base64,THUMB',
    pickKeys: [], pickGrid: { children: [] }, pickDesignMode: false, pickTierMode: false, pickTierFilter: null, pickBackAllowed: false, pickDesignsList: [], pickIdx: 0,
    retakeBtn: { hidden: true, textContent: 'Retake' }, doneBtn: { hidden: true, textContent: 'Done' },
    guestLooksOn: false, isTraditional: () => false, guestLookKeys: () => [], FILTER_LABELS: {}, guestLookOpen: false, filterKey: 'normal',
    currentFolderLink: '', gvPrivate: () => false,
    printSection: { classList: { contains: () => false } }, printPrefs: { guestBtn: true, guestCopies: false, copies: 1, printFirst: false },
    printSize: '4x6', maxCopies: () => 3, printLimits: () => ({ se: 0, ev: 0 }), printQueued: 0, printTxt: (k) => k, noPrintSession: () => false,
    willAutoPrint: () => false, MAX_COPIES: 10, qrPopOn: false, hideQrOn: false, printing: false, autoPrint: false,
    qrPop: { phase: '' }, shareStationOn: false,
    layoutThumbUrl: () => 'data:image/png;base64,AAAA', pickName: (k) => 'Layout ' + k, LAYOUT_DEFS: { a: { shots: 4 }, b: { shots: 2 } },
    frameById: () => null, presetById: () => null, frameShotCount: () => 4, presetShotCount: () => 4,
    layoutDef: () => ({ name: 'Strip' }), shotsNeeded: () => 4, readySub: { textContent: '' }, fx: { hands: '' }, countingDown: false,
    pickTitleText: () => 'Choose', pickSubText: () => 'Tap one', retakesAllowed: () => true, SAMPLE_PORTRAITS: ['<svg id="a"/>', '<svg id="b"/>', '<svg id="c"/>'],
    enumerateCameras: async () => { }, savedCamera: () => null, initCamera: async () => true, showToast() { }, boothTrigger() { }, resetForNextGuest() { },
    updateGuestStatus() { }, updateFullStage() { }, cameraSelect: { options: [], value: '' }, streamActive: false, qrcode: null
  };
  ctx.document = {
    documentElement: { style: { getPropertyValue: (k) => ctx.__ui[k] || '' } },
    getElementById: (id) => (id === 'galleryPopQr' ? { src: '' } : id === 'qrSectionTitle' ? { textContent: ctx.__qrTitle || '' } : null),
    createElement: () => ({ style: {}, classList: { add() { }, remove() { } }, appendChild() { } })
  };
  // Strict: only names the booth page really declares are visible to the code under test (plus the JS and browser globals the
  // sandbox needs). A name the bridge uses that the booth does not have throws ReferenceError, exactly as in the real app. (An
  // earlier version of this test handed the code a stand-in for layoutBoxAspect, which the booth never had, so a bug that made
  // every tablet screen update throw went unnoticed.)
  for (const k of Object.keys(ctx)) if (!HOST.has(k) && !DECLARED.has(k)) delete ctx[k];
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

// 8. One part of the screen failing must not blank the rest, and the failure must show in Setup (it used to be swallowed)
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.state = 'idle'; ctx.shotCanvases = []; ctx.pickOpen = true; ctx.pickKeys = ['a', 'b'];
  ctx.layoutThumbUrl = () => { throw new Error('no thumbnail for this layout'); };
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert(p, 'the screen is still sent when the layout picker part fails');
  assert.equal(p.pickOpen, true); assert.equal(p.layouts.length, 0, 'the failed part is left out');
  assert(/layout picker/.test(ctx.tabletBridge.lastError) && /no thumbnail/.test(ctx.tabletBridge.lastError), 'Setup is told which part failed: ' + ctx.tabletBridge.lastError);
  // a failing QR part: the photo and the buttons still go out
  ctx.pickOpen = false; ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.sess = {};
  ctx.qrResults = { querySelectorAll: () => { throw new Error('QR panel is missing'); } };
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert(/^\/media\/result\?v=/.test(p.resSrc), 'the photo still goes out'); assert.equal(p.nextShow, true, 'Done still goes out'); assert.equal(p.showQr, false);
  assert(/QR codes/.test(ctx.tabletBridge.lastError));
  // all parts fine again: the report clears
  ctx.qrResults = { querySelectorAll: () => [slot('photo', 'QR1')] }; ctx.layoutThumbUrl = () => 'data:image/png;base64,AAAA';
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(ctx.tabletBridge.lastError, ''); assert.equal(last(pushed).showQr, true);
  console.log('PASS: one failing part is left out and reported; the rest of the screen still goes to the tablet');
});

// 9. The shapes of the guest picture and the strip come from the booth's own helpers (they used to come from a function that does not exist)
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.currentBoxAspect = () => 0.5; ctx.camAspect = () => 1.5; ctx.shotBoxAspect = () => 0.75;
  ctx.state = 'idle'; ctx.shotCanvases = []; ctx.sess = null;
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.equal(p.ga, 1.5, 'between guests: the camera shape'); assert.equal(p.boxAspect, 0.5, 'the strip photos use the layout box');
  ctx.state = 'capturing'; ctx.sess = {}; ctx.shotCanvases = shots(1);
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).ga, 0.75, 'while shooting: the shot box');
  ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.previewCanvas = { width: 600, height: 1800, style: { display: 'block' }, toDataURL: () => JPEG('strip') };
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).ga, 0.3333, 'the finished strip: its own shape');
  // the booth tells the bridge when the shapes change; an unchanged shape sends nothing more
  ctx.tabletBridgeAspect(); await wait(150);            // the first call after pairing sends the screen once
  const before = pushed.length;
  ctx.tabletBridgeAspect(); await wait(100);
  assert.equal(pushed.length, before, 'same shapes: no new screen');
  ctx.currentBoxAspect = () => 0.8; ctx.tabletBridgeAspect(); await wait(150);
  assert(pushed.length > before, 'a changed shape sends the screen again');
  console.log('PASS: guest picture and strip shapes');
});

// 10. A screen that cannot be built at all is shown in Setup, not swallowed
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.readyOverlay = { classList: { contains: () => { throw new Error('start overlay is gone'); } } };
  ctx.tabletBridge.info = { camConnected: true, guestConnected: true, deviceName: 'Tab', port: 4321 };
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(pushed.length, 0, 'nothing could be sent');
  assert(/start overlay is gone/.test(ctx.tabletBridge.lastError), 'the reason is kept for Setup: ' + ctx.tabletBridge.lastError);
  console.log('PASS: a screen that cannot be built is reported');
});

// 11. The mirror setting and the "Printing, please hold…" flag reach the tablet
await section(async () => {
  const { ctx, pushed } = makeCtx();
  ctx.currentDeviceId = 'tablet-bridge';
  ctx.mirrorPreview = () => true;
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.equal(p.mirror, true, 'Mirror On: the tablet screen is told to mirror its own camera picture');
  ctx.mirrorPreview = () => false;
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).mirror, false, 'Mirror Off reaches the tablet too');
  // a laptop camera shown on the tablet as pictures: mirrored the same way
  ctx.currentDeviceId = 'some-laptop-webcam'; ctx.mirrorPreview = () => true;
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.useRemoteStream, true); assert.equal(p.remoteMirror, true); assert.equal(p.mirror, true);
  // printing: the Print button says "Printing, please hold…" and the tablet shows it smaller
  ctx.state = 'result'; ctx.shotCanvases = shots(4); ctx.sess = {}; ctx.printing = true;
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.printShow, true); assert.equal(p.printBusy, true); assert.equal(p.printDisabled, true);
  ctx.printing = false;
  ctx.tabletBridgeSync(); await wait(150);
  assert.equal(last(pushed).printBusy, false);
  console.log('PASS: mirror setting and the printing flag reach the tablet');
});

// 12. The countdown voice: the tablet speaks when it can, the laptop otherwise (the real voice code from booth.src.html)
await section(async () => {
  const BOOTH = readFileSync(join(ROOT, 'protected', 'src', 'booth.src.html'), 'utf8');
  const a = BOOTH.indexOf('// ---- Voice countdown:'), b = BOOTH.indexOf('// ---- Screen flash ----');
  assert(a > 0 && b > a, 'the voice section is still in booth.src.html');
  const { ctx } = makeCtx();
  const sent = [];
  ctx.window.pb4u.bridge.sendEvent = (e) => { sent.push(e); };
  ctx.fx = { sound: true, vOn: true, vLang: 'en', vName: '', vCount: '3', vol: 0.7 };
  ctx.navigator = { onLine: true };
  ctx.refreshFxUI = () => { };
  vm.runInContext(BOOTH.slice(a, b), ctx);
  const EN = [{ name: 'en-us-x-tpd-local', lang: 'en-US', localService: true }, { name: 'en-gb-x-gba-network', lang: 'en-GB', localService: false }];
  const FIL = [{ name: 'fil-ph-x-fie-local', lang: 'fil-PH', localService: true }];

  // no tablet voice yet and no voice on the laptop: nothing speaks, the beeps are used
  assert.equal(ctx.voiceViaTablet(), false); assert.equal(ctx.voiceActive(), false);
  assert.equal(ctx.voiceSay('Three'), false); assert.equal(sent.length, 0);

  // the tablet reports its voices (the "voiceCaps" action from its guest page)
  ctx.tabletVoiceCaps({ voices: { en: EN, fil: [] } });
  assert.equal(ctx.voiceViaTablet(), true); assert.equal(ctx.voiceActive(), true, 'voice is on, spoken by the tablet');
  assert.equal(ctx.voiceEngine(), 'tablet');
  assert.equal(ctx.voiceNumber(3), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'voice'); assert.equal(sent[0].text, 'Three'); assert.equal(sent[0].lang, 'en');
  assert.equal(sent[0].name, 'en-us-x-tpd-local', 'a voice stored on the tablet is chosen before one that needs internet');
  assert.equal(sent[0].vol, 0.85);
  assert.equal(ctx.voiceNumber(5), true); assert.equal(sent.length, 1, 'numbers above 3 stay silent in the default setting');
  ctx.voiceReady(0, false, 6);
  assert.equal(sent[1].text, 'Get ready!');
  assert.equal(ctx.voiceSmile(), true); assert.equal(sent[2].text, 'Smile!');
  // the operator's chosen voice (one of the tablet's)
  ctx.fx.vName = 'en-gb-x-gba-network';
  ctx.voiceSay('One'); assert.equal(sent[3].name, 'en-gb-x-gba-network');
  // Tagalog: only when the tablet has a Filipino voice
  ctx.fx.vLang = 'fil'; ctx.fx.vName = '';
  assert.equal(ctx.voiceLang(), 'en', 'no Tagalog voice on the tablet: English is used');
  ctx.tabletVoiceCaps({ voices: { en: EN, fil: FIL } });
  assert.equal(ctx.voiceLang(), 'fil');
  ctx.voiceNumber(2);
  assert.equal(sent[4].text, 'Dalawa'); assert.equal(sent[4].lang, 'fil'); assert.equal(sent[4].name, 'fil-ph-x-fie-local');
  // a cancelled session stops the tablet's voice
  ctx.voiceStop();
  assert.equal(sent[sent.length - 1].type, 'voiceStop');
  // voice switched off in Setup, or sound off: nothing is sent
  const n = sent.length;
  ctx.fx.vOn = false; ctx.voiceSay('One'); assert.equal(sent.length, n, 'voice off: the tablet says nothing');
  ctx.fx.vOn = true; ctx.fx.sound = false; ctx.voiceSay('One'); assert.equal(sent.length, n, 'sound off: the tablet says nothing');
  ctx.fx.sound = true;
  // the tablet goes away: no voice command is sent any more (the laptop would speak, if it has a voice)
  ctx.tabletBridge.guestConnected = false;
  assert.equal(ctx.voiceViaTablet(), false); assert.equal(ctx.voiceSay('One'), false); assert.equal(sent.length, n);
  console.log('PASS: the tablet speaks the countdown when it can');
});

// 13. Beeps and the shutter click: from the tablet when it can play them, from the laptop otherwise (the real sound code from booth.src.html)
await section(async () => {
  const BOOTH = readFileSync(join(ROOT, 'protected', 'src', 'booth.src.html'), 'utf8');
  const a = BOOTH.indexOf('// ---- Sound ----'), b = BOOTH.indexOf('// ---- Screen flash ----');
  assert(a > 0 && b > a, 'the sound section is still in booth.src.html');
  assert(BOOTH.includes('/*@include sound/fx-sounds.js*/'), 'the built-in sounds file is included in the booth page');
  const { ctx } = makeCtx();
  const sent = [], played = [];
  let lastGain = 0;
  ctx.window.pb4u.bridge.sendEvent = (e) => { sent.push(e); };
  Object.assign(ctx, { Float32Array, ArrayBuffer, DataView, Uint8Array, btoa, atob });
  ctx.fx = { sound: true, vol: 0.7, sShut: null, sTick: null, vOn: false, vLang: 'en', vName: '', vCount: '3' };
  ctx.navigator = { onLine: true }; ctx.refreshFxUI = () => { }; ctx.ASSETS = {};
  ctx.document.addEventListener = () => { };
  ctx.window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createBuffer(ch, n) { return { n, d: new Float32Array(n), getChannelData() { return this.d; } }; }
    createBufferSource() { const s = { buffer: null, connect() { }, start: () => played.push({ n: s.buffer.n, gain: lastGain }) }; return s; }
    createGain() { return { gain: { set value(v) { lastGain = v; } }, connect() { } }; }
    resume() { return Promise.resolve(); }
  };
  vm.runInContext(readFileSync(join(ROOT, 'protected', 'src', 'sound', 'fx-sounds.js'), 'utf8'), ctx);
  vm.runInContext(BOOTH.slice(a, b), ctx);
  const N = { shut: Math.round(0.26 * 44100), b1: Math.round(0.2 * 44100), b2: Math.round(0.14 * 44100), pose: Math.round(0.27 * 44100), chime: Math.round(0.3 * 44100) };

  // no tablet that can play sounds: this device plays them
  ctx.fxShutter(); ctx.fxBeep(1); ctx.fxBeep(2); ctx.fxPose(); ctx.fxStartChime();
  assert.deepEqual(played.map((p) => p.n), [N.shut, N.b1, N.b2, N.pose, N.chime], 'every sound plays on this device');
  assert(played.every((p) => p.gain === 0.7), 'at the booth\'s volume');
  assert.equal(sent.length, 0);

  // the tablet says it can play: the sounds go to it, the laptop is quiet
  played.length = 0;
  ctx.tabletBridge.soundOk = true;
  assert.equal(ctx.tabletSoundOn(), true);
  ctx.fxShutter(); ctx.fxBeep(1); ctx.fxBeep(2); ctx.fxPose(); ctx.fxStartChime(); ctx.fxTick(3);
  assert.equal(played.length, 0, 'the laptop plays nothing');
  assert.deepEqual(sent.map((e) => e.type + ':' + e.kind), ['sound:shut', 'sound:b1', 'sound:b2', 'sound:pose', 'sound:chime', 'sound:b2']);
  assert(sent.every((e) => e.vol === 0.7));
  // the operator's own sound files play a little louder
  sent.length = 0; ctx.tabletBridge.soundOwn = { shut: true, tick: true };
  ctx.fxShutter(); ctx.fxBeep(1); ctx.fxPose();
  assert.equal(sent[0].vol, 0.77); assert.equal(sent[1].vol, 0.77); assert.equal(sent[2].vol, 0.7, 'the Pose chime has no own file');
  // the voice says the numbers: no beeps from either
  sent.length = 0; ctx.fx.vOn = true; ctx.tabletVoiceCaps({ voices: { en: [{ name: 'v', lang: 'en-US', localService: true }], fil: [] } });
  ctx.fxTick(3); assert.equal(sent.length, 0, 'voice on: no beep');
  ctx.fx.vOn = false;
  // sound switched off in Setup: nothing anywhere
  ctx.fx.sound = false; ctx.fxShutter(); ctx.fxBeep(1);
  assert.equal(sent.length, 0); assert.equal(played.length, 0);
  ctx.fx.sound = true;
  // the tablet goes away: back to this device
  ctx.tabletBridge.guestConnected = false;
  ctx.fxShutter(); assert.equal(played.length, 1); assert.equal(sent.length, 0);
  ctx.tabletBridge.guestConnected = true; ctx.tabletBridge.soundOk = false;
  ctx.fxShutter(); assert.equal(played.length, 2, 'a tablet that cannot play yet: this device plays');

  // the sound files go to the tablet once, and again only when the operator's own files change
  sent.length = 0; ctx.tabletBridge.soundOwn = { shut: false, tick: false };
  ctx.tabletSoundSync(true);
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'sounds');
  assert.deepEqual(Object.keys(sent[0].sounds).sort(), ['b1', 'b2', 'chime', 'pose', 'shut']);
  assert(Object.values(sent[0].sounds).every((u) => u.startsWith('data:audio/wav;base64,')), 'all five are WAV files');
  ctx.tabletSoundSync(); assert.equal(sent.length, 1, 'nothing changed: nothing sent again');
  ctx.fx.sShut = { id: 'aOwnShutter01', name: 'my.wav' };
  ctx.tabletSoundSync(); assert.equal(sent.length, 1, 'own file not downloaded yet: the built-in one stays');
  ctx.ASSETS.aOwnShutter01 = { url: 'data:audio/wav;base64,QUJD' };
  ctx.tabletSoundSync();
  assert.equal(sent.length, 2); assert.equal(sent[1].sounds.shut, 'data:audio/wav;base64,QUJD', 'the operator\'s own shutter file goes to the tablet');
  assert.equal(ctx.tabletBridge.soundOwn.shut, true); assert.equal(ctx.tabletBridge.soundOwn.tick, false);
  ctx.fx.sShut = null; ctx.tabletSoundSync();
  assert.equal(sent.length, 3); assert(sent[2].sounds.shut.length > 1000 && sent[2].sounds.shut !== 'data:audio/wav;base64,QUJD', 'own file removed: the built-in shutter goes back');
  console.log('PASS: beeps and the shutter come from the tablet when it can play them');
});

// 14. Two-step B&W vs Coloured picker: Step 1 sends 2 cards with tags, Step 2 sends Back flag & B&W filter flag
await section(async () => {
  const { ctx, pushed } = makeCtx();
  const mkBtn = (nm, sh, tag, cls) => ({
    querySelector: (s) => s === '.pick-name' ? { textContent: nm }
      : s === '.pick-shots' ? { textContent: sh }
      : s === '.pick-tier-tag' ? { textContent: tag, classList: { contains: (c) => c === cls } }
      : s === 'img' ? { src: JPEG(nm) } : null
  });
  ctx.pickOpen = true;
  ctx.pickDesignMode = true;
  ctx.pickTierMode = true;
  ctx.pickTierFilter = null;
  ctx.pickBackAllowed = false;
  ctx.pickKeys = ['tier:receipt', 'tier:photo'];
  ctx.pickGrid = { children: [mkBtn('B&W designs', '5 layouts', '🧾 Black & white', 'thermal'), mkBtn('Coloured designs', '23 layouts', '🎨 Full colour', 'color')] };
  ctx.pickTitleText = () => 'B&W or Coloured?';
  ctx.pickSubText = () => 'Pick a style to see its layouts';
  ctx.tabletBridgeSync(); await wait(150);
  let p = last(pushed);
  assert.equal(p.pickOpen, true);
  assert.equal(p.pickTier, true);
  assert.equal(p.pickCanBack, false);
  assert.equal(p.pickTitle, 'B&W or Coloured?');
  assert.equal(p.pickSub, 'Pick a style to see its layouts');
  assert.equal(p.layouts.length, 2);
  assert.equal(p.layouts[0].tag, '🧾 Black & white');
  assert.equal(p.layouts[0].tagCls, 'thermal');
  assert.equal(p.layouts[1].tag, '🎨 Full colour');
  assert.equal(p.layouts[1].tagCls, 'color');

  // Step 2: B&W layouts with Back allowed
  ctx.pickDesignMode = false;
  ctx.pickTierMode = false;
  ctx.pickTierFilter = 'receipt';
  ctx.pickBackAllowed = true;
  ctx.pickKeys = ['a', 'b'];
  ctx.pickTitleText = () => 'B&W designs';
  ctx.pickSubText = () => 'Tap a layout to start your session';
  ctx.tabletBridgeSync(); await wait(150);
  p = last(pushed);
  assert.equal(p.pickTier, false);
  assert.equal(p.pickCanBack, true);
  assert.equal(p.pickBwStep, true);
  assert.equal(p.pickTitle, 'B&W designs');
  console.log('PASS: 2-step B&W vs Coloured picker state (Step 1 tags + Step 2 Back button) reaches the tablet');
});

if (failed) { console.log(failed + ' check(s) failed'); process.exit(1); }
console.log('All tablet state tests passed!');
