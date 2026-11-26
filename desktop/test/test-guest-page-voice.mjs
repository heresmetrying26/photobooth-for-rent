// Runs the REAL tablet guest page script (guestBridgeHtml) in a sandbox with a fake page and a fake socket, and checks:
//  - it tells the laptop which voices the tablet has ("voiceCaps") as soon as it connects, and looks again when none are loaded yet
//  - it says the words the laptop sends ("voice") with the tablet's own voice, and stops when told ("voiceStop")
//  - it falls back to the page's own speech when the app has no voice bridge
//  - "Printing, please hold…" gets the smaller-letters class while printing, and loses it afterwards
import { strict as assert } from 'node:assert';
import vm from 'node:vm';
import { guestBridgeHtml } from '../lib/guest-bridge.mjs';

const html = guestBridgeHtml('testtoken123');
const SCRIPT = /<script>\n?([\s\S]*?)\n?<\/script>/.exec(html)[1];
assert(/\.gbtn\.printing/.test(html), 'the page has a style for the smaller "Printing, please hold…" label');

function makeEl() {
  const classes = new Set();
  const props = {};
  return {
    offsetHeight: 0,
    style: {
      props,
      setProperty(k, v) { props[k] = String(v); },
      removeProperty(k) { delete props[k]; },
      getPropertyValue(k) { return props[k] || ''; },
      cssText: ''
    },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c)
    },
    attrs: {}, children: [], textContent: '', innerHTML: '', disabled: false,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, append(...cs) { cs.forEach((c) => this.children.push(c)); },
    addEventListener() { }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    querySelector(sel) { return sel === 'img' ? (this.children.find((c) => c && c.tagName === 'IMG') || null) : null; },
    has: (c) => classes.has(c)
  };
}

function makePage({ native, web, audio, width = 0, height = 0 } = {}) {
  const els = {};
  const listeners = {};
  const sockets = [];
  const timers = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(d) { this.sent.push(JSON.parse(d)); }
  }
  const window = {
    innerWidth: width, innerHeight: height,
    devicePixelRatio: 1, addEventListener() { }, AudioContext: audio ? audio.AC : undefined,
    __PBVoice: native || undefined,
    speechSynthesis: web ? web.synth : undefined,
    SpeechSynthesisUtterance: web ? web.Utt : undefined
  };
  const ctx = {
    console, JSON, Math, Number, String, Array, Object, Date, parseFloat, parseInt, isNaN, Promise, Uint8Array, atob,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() { },
    window, location: { protocol: 'http:', host: '127.0.0.1:1' }, WebSocket: FakeSocket,
    Image: function () { }, SpeechSynthesisUtterance: web ? web.Utt : undefined,
    document: {
      getElementById: (id) => els[id] || (els[id] = makeEl()),
      createElement: (tag) => Object.assign(makeEl(), { tagName: String(tag || '').toUpperCase() }), addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      body: makeEl(), documentElement: makeEl()
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  assert.equal(sockets.length, 1, 'the page opens its socket to the laptop');
  const ws = sockets[0];
  return {
    els, ws, timers, listeners, window,
    soundCaps: () => ws.sent.filter((m) => m.type === 'action' && m.action === 'soundCaps'),
    open: () => ws.onopen(),
    msg: (o) => ws.onmessage({ data: JSON.stringify(o) }),
    caps: () => ws.sent.filter((m) => m.type === 'action' && m.action === 'voiceCaps'),
    actions: () => ws.sent.filter((m) => m.type === 'action')
  };
}

// 1. The app's own text-to-speech
{
  const calls = [];
  const native = {
    voices: (lang) => JSON.stringify(lang === 'fil' ? [] : [{ name: 'en-us-x-tpd-local', lang: 'en-US', local: true }, { name: 'en-gb-x-gba-network', lang: 'en-GB', local: false }]),
    speak: (t, n, v) => { calls.push(['speak', t, n, v]); return true; },
    stop: () => { calls.push(['stop']); }
  };
  const pg = makePage({ native });
  pg.open();
  const caps = pg.caps();
  assert.equal(caps.length, 1, 'the voice list goes to the laptop when the page connects');
  assert.equal(caps[0].voices.en.length, 2); assert.equal(caps[0].voices.fil.length, 0);
  assert.equal(caps[0].voices.en[0].name, 'en-us-x-tpd-local'); assert.equal(caps[0].voices.en[0].localService, true);
  assert.equal(caps[0].voices.en[1].localService, false);
  assert.equal(pg.timers.length, 0, 'voices were found: no second look needed');
  pg.msg({ type: 'voice', text: 'Three', lang: 'en', name: 'en-us-x-tpd-local', vol: 0.85 });
  assert.deepEqual(calls[0], ['speak', 'Three', 'en-us-x-tpd-local', 0.85]);
  pg.msg({ type: 'voice', text: 'Smile!', lang: 'en', name: '' });
  assert.equal(calls[1][1], 'Smile!'); assert.equal(calls[1][3], 1, 'no volume sent = full volume');
  pg.msg({ type: 'voiceStop' });
  assert.deepEqual(calls[2], ['stop']);
  pg.msg({ type: 'voice', text: '' }); assert.equal(calls.length, 3, 'an empty word is not spoken');
  console.log('PASS: the tablet page says the laptop\'s words with the tablet\'s own voice');
}

// 2. The speech engine is not ready when the page connects: it reports again later
{
  let ready = false;
  const native = { voices: () => (ready ? JSON.stringify([{ name: 'v', lang: 'en-US', local: true }]) : '[]'), speak: () => true, stop() { } };
  const pg = makePage({ native });
  pg.open();
  assert.equal(pg.caps()[0].voices.en.length, 0, 'no voice yet');
  assert.equal(pg.timers.length, 1, 'it looks again in a moment');
  ready = true;
  pg.timers[0].fn();
  const caps = pg.caps();
  assert.equal(caps.length, 2); assert.equal(caps[1].voices.en.length, 1, 'the voice is reported once the engine is up');
  console.log('PASS: the tablet reports its voices again when the speech engine starts late');
}

// 3. No voice bridge in the app: the page's own speech is used
{
  const spoken = [];
  let cancelled = 0;
  class Utt { constructor(t) { this.text = t; } }
  const synth = {
    speaking: true, pending: false, paused: false,
    getVoices: () => [{ name: 'Google US English', lang: 'en-US', localService: false }, { name: 'Filipino', lang: 'fil-PH', localService: true }],
    speak: (u) => spoken.push(u), cancel: () => { cancelled++; }
  };
  const pg = makePage({ web: { synth, Utt } });
  pg.open();
  const caps = pg.caps()[0].voices;
  assert.equal(caps.en.length, 1); assert.equal(caps.fil.length, 1, 'Tagalog voice found through the page speech');
  pg.msg({ type: 'voice', text: 'Dalawa', lang: 'fil', name: 'Filipino', vol: 0.5 });
  assert.equal(spoken.length, 1); assert.equal(spoken[0].text, 'Dalawa'); assert.equal(spoken[0].voice.name, 'Filipino');
  assert.equal(spoken[0].volume, 0.5); assert.equal(cancelled, 1, 'an old word still being said is cut off');
  pg.msg({ type: 'voiceStop' }); assert.equal(cancelled, 2);
  console.log('PASS: the tablet page falls back to its own speech');
}

// 4. No speech at all: nothing breaks, the laptop is told there are no voices
{
  const pg = makePage();
  pg.open();
  assert.equal(pg.caps()[0].voices.en.length, 0);
  pg.msg({ type: 'voice', text: 'Three', lang: 'en', name: '' });
  pg.msg({ type: 'voiceStop' });
  console.log('PASS: a tablet with no voice stays quiet and reports none');
}

// 5. "Printing, please hold…" is shown in smaller letters while printing
{
  const pg = makePage();
  pg.open();
  const base = { psMode: true, isResult: true, printShow: true, nextShow: true, printLabel: 'Print', printDisabled: false, printBusy: false };
  pg.msg({ type: 'state', state: base });
  const btn = pg.els.gPrintBtn;
  assert.equal(btn.has('printing'), false); assert.equal(btn.innerHTML.includes('Print'), true);
  pg.msg({ type: 'state', state: Object.assign({}, base, { printLabel: 'Printing, please hold…', printDisabled: true, printBusy: true }) });
  assert.equal(btn.has('printing'), true, 'smaller letters while printing'); assert.equal(btn.disabled, true);
  assert(btn.innerHTML.includes('Printing, please hold'));
  pg.msg({ type: 'state', state: base });
  assert.equal(btn.has('printing'), false, 'normal size again afterwards');
  // an old laptop app that does not send the flag
  pg.msg({ type: 'state', state: { psMode: true, isResult: true, printShow: true, printLabel: 'Print' } });
  assert.equal(btn.has('printing'), false);
  console.log('PASS: "Printing, please hold…" is shown smaller');
}

// 6. Beeps and the shutter click: the sound files arrive once, then one message per sound
function makeAudio({ state = 'running', failDecode = false } = {}) {
  const log = { decoded: [], played: [], resumed: 0, ctx: null };
  class AC {
    constructor() { this.state = state; this.destination = {}; log.ctx = this; }
    decodeAudioData(ab, ok, bad) {
      log.decoded.push(ab.byteLength);
      if (failDecode) { if (bad) bad(new Error('bad')); return Promise.reject(new Error('bad')); }
      const buf = { n: log.decoded.length };
      if (ok) ok(buf);
      return Promise.resolve(buf);
    }
    createBuffer() { return {}; }
    createBufferSource() { const s = { buffer: null, to: null, connect(n) { s.to = n; }, start() { log.played.push({ buf: s.buffer, gain: s.to && s.to.gain.value }); } }; return s; }
    createGain() { return { gain: { value: 1 }, connect() { } }; }
    resume() { log.resumed++; this.state = 'running'; if (this.onstatechange) this.onstatechange(); return Promise.resolve(); }
  }
  return { AC, log };
}
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const WAV = 'data:audio/wav;base64,' + Buffer.from('RIFF0000WAVEfmt ').toString('base64');
const PACK = (sig) => ({ type: 'sounds', sig, sounds: { shut: WAV, b1: WAV, b2: WAV, pose: WAV, chime: WAV } });
{
  const audio = makeAudio();
  const pg = makePage({ audio });
  pg.open();
  assert.equal(pg.soundCaps().length, 1); assert.equal(pg.soundCaps()[0].ok, false, 'no sounds yet: the laptop plays them');
  pg.msg(PACK('a')); await settle();
  assert.equal(audio.log.decoded.length, 5, 'all five sound files are decoded');
  const caps = pg.soundCaps();
  assert.equal(caps[caps.length - 1].ok, true, 'files decoded and audio running: the tablet says it can play');
  pg.msg({ type: 'sound', kind: 'shut', vol: 0.7 });
  assert.equal(audio.log.played.length, 1); assert.equal(audio.log.played[0].gain, 0.7);
  pg.msg({ type: 'sound', kind: 'b1' }); assert.equal(audio.log.played[1].gain, 0.7, 'no volume sent: a normal one');
  pg.msg({ type: 'sound', kind: 'nope', vol: 1 }); assert.equal(audio.log.played.length, 2, 'an unknown sound is ignored');
  // the operator's own sounds arrive later: replaces the files, the tablet keeps playing
  pg.msg(PACK('b')); await settle();
  assert.equal(audio.log.decoded.length, 10);
  pg.msg({ type: 'sound', kind: 'chime', vol: 0.35 }); assert.equal(audio.log.played[2].gain, 0.35);
  console.log('PASS: the tablet page decodes the sounds, says it can play them, and plays them on cue');
}
// audio locked until a tap (a browser, not the app): not ready until the first tap, then ready
{
  const audio = makeAudio({ state: 'suspended' });
  const pg = makePage({ audio });
  pg.open();
  pg.msg(PACK('a')); await settle();
  let caps = pg.soundCaps();
  assert.equal(caps[caps.length - 1].ok, false, 'audio still locked: the laptop keeps playing the sounds');
  pg.listeners.pointerdown.forEach((fn) => fn());
  caps = pg.soundCaps();
  assert.equal(caps[caps.length - 1].ok, true, 'the first tap unlocks audio and the tablet says it can play');
  assert(audio.log.resumed >= 1);
  console.log('PASS: locked audio is reported as not ready until the first tap');
}
// files that cannot be decoded: never claims it can play
{
  const audio = makeAudio({ failDecode: true });
  const pg = makePage({ audio });
  pg.open();
  pg.msg(PACK('a')); await settle();
  const caps = pg.soundCaps();
  assert.equal(caps[caps.length - 1].ok, false, 'broken files: the laptop keeps playing the sounds');
  pg.msg({ type: 'sound', kind: 'shut', vol: 1 }); assert.equal(audio.log.played.length, 0);
  console.log('PASS: sound files that cannot be decoded are not claimed');
}
// no audio at all
{
  const pg = makePage();
  pg.open();
  pg.msg(PACK('a')); pg.msg({ type: 'sound', kind: 'shut', vol: 1 });
  assert.equal(pg.soundCaps()[pg.soundCaps().length - 1].ok, false);
  console.log('PASS: a page with no audio stays quiet and reports it');
}

// 7. Portrait layout fitting, corner logo, welcome card aspect guard, and tap trigger
{
  assert(/@media\s*\(orientation:\s*portrait\)/.test(html), 'guest page includes portrait responsive CSS');
  const pg = makePage({ width: 800, height: 1280 });
  pg.open();
  pg.els.sideL.offsetHeight = 140;
  pg.els.sideR.offsetHeight = 130;
  pg.els.sideRRes.offsetHeight = 220;

  // Classic "With logo & side text" (!psMode) on portrait tablet fits frame cleanly between sideL and sideR
  pg.msg({
    type: 'state',
    state: {
      psMode: false,
      isWelcome: true,
      wa: 0.75,
      ga: 1.3333,
      resSrc: '/media/welcome?v=1',
      resFit: 'cover',
      clogo: { url: '/media/clogo?v=1', x: null, y: null, w: 12, h: 8 }
    }
  });
  const fw = parseInt(pg.els.frame.style.getPropertyValue('width'), 10);
  const fh = parseInt(pg.els.frame.style.getPropertyValue('height'), 10);
  assert(fw > 0 && fw <= 752, 'portrait panel frame width fits inside 800px viewport: ' + fw);
  assert(fh > 0 && fh <= (1280 * 0.92 - 140 - 130 + 2), 'portrait panel frame height leaves room for top & bottom bars: ' + fh);
  assert(Math.abs(fw / fh - 0.75) < 0.02, 'portrait panel frame preserves wa aspect ratio 0.75: ' + (fw / fh));
  assert.equal(pg.els.glogo.has('off'), false, 'corner logo shown in panel mode');
  assert.equal(pg.els.lgImg.has('hide'), false);

  // Photo session full-screen welcome card with landscape card on portrait tablet switches objectFit to contain
  pg.msg({
    type: 'state',
    state: {
      psMode: true,
      welFullPs: true,
      welCard: true,
      wa: 1.3333,
      ga: 1.3333,
      resSrc: '/media/welcome?v=2',
      resFit: 'cover'
    }
  });
  assert.equal(pg.els.res.style.objectFit, 'contain', 'landscape welcome card on portrait tablet uses contain instead of cropping');
  assert.equal(pg.els.frame.style.getPropertyValue('width'), '', 'CSS handles full-screen wel-full frame');

  // Photo session full-screen welcome card with 4:3 card on 16:9 landscape screen switches objectFit to contain, matching 4:3 stays cover
  const pg169 = makePage({ width: 1280, height: 720 });
  pg169.open();
  pg169.msg({ type: 'state', state: { psMode: true, welFullPs: true, welCard: true, wa: 1.3333, ga: 1.3333, resSrc: '/media/welcome?v=169', resFit: 'cover' } });
  assert.equal(pg169.els.res.style.objectFit, 'contain', '4:3 welcome card on 16:9 guest screen uses contain instead of cropping top/bottom');
  const pg43 = makePage({ width: 1024, height: 768 });
  pg43.open();
  pg43.msg({ type: 'state', state: { psMode: true, welFullPs: true, welCard: true, wa: 1.3333, ga: 1.3333, resSrc: '/media/welcome?v=43', resFit: 'cover' } });
  assert.equal(pg43.els.res.style.objectFit, 'cover', 'matching 4:3 card on 4:3 screen keeps edge-to-edge cover');
  assert(html.includes('body.ps.is-result:not(.has-qr):not(.has-res-actions) .side-r-res{display:none !important;}'), 'empty result side column is hidden in non-themed ps result');
  // Live camera welcome overlay keeps res background transparent so live camera shows through CTA PNG
  pg169.msg({ type: 'state', state: { psMode: true, welFullPs: true, hideCam: false, resSrc: '/media/welcome?v=cam', resFit: 'cover' } });
  assert.equal(pg169.els.res.style.background, 'transparent', 'camera welcome keeps res background transparent over live camera');

  // Photo session result screen on portrait tablet sizes frame above sideRRes at exact ga
  pg.msg({
    type: 'state',
    state: {
      psMode: true,
      isResult: true,
      showQr: true,
      printShow: true,
      nextShow: true,
      ga: 0.6667,
      resSrc: '/media/result?v=3',
      resFit: 'contain'
    }
  });
  const rw = parseInt(pg.els.frame.style.getPropertyValue('width'), 10);
  const rh = parseInt(pg.els.frame.style.getPropertyValue('height'), 10);
  assert(rw > 0 && rw <= 800 * 0.92 + 1, 'portrait result frame fits width');
  assert(rh > 0 && rh <= 1280 * 0.91 - 220 + 2, 'portrait result frame leaves room for QR & Print/Done');
  assert(Math.abs(rw / rh - 0.6667) < 0.02, 'portrait result frame keeps exact ga aspect ratio');

  // Tap while on welcome sends trigger action
  pg.msg({ type: 'state', state: { psMode: false, isWelcome: true, wa: 0.75, ga: 0.75 } });
  pg.listeners.click.forEach((fn) => fn());
  assert(pg.actions().some((a) => a.action === 'trigger'), 'tap on tablet welcome sends trigger action');

  // Full-screen frame CSS resets max-width/max-height caps and reports viewportCaps + patches layout thumbs in place
  assert(html.includes('body:not(.ps):not(.wel) .frame{max-width:56vw;max-height:94vh;}'), '56vw cap applies only to panel side-by-side mode');
  assert(/body\.ps \.frame\{[^}]*max-width:none !important;max-height:none !important;/.test(html), 'body.ps .frame removes 56vw/94vh cap');
  assert(/body\.ps\.wel-full \.frame\{[^}]*max-width:none !important;max-height:none !important;/.test(html), 'body.ps.wel-full .frame fills 100vw x 100vh without cap');
  assert(/body\.wel \.frame\{[^}]*width:min\(100vw,calc\(100vh \* var\(--wa,1\.3333\)\)\) !important;[^}]*max-width:none !important;max-height:none !important;/.test(html), 'body.wel .frame sets full width and clears 56vw/94vh cap');
  assert(html.includes('body.qrpop-wait.is-result .frame,body.qrpop-show.is-result .frame{max-width:92vw;max-height:90vh;}'), 'qrpop result clears 60vw cap');
  assert(html.includes('body.ps.is-result .frame{max-width:92vw;max-height:90vh;}'), 'portrait result clears 60vw cap');
  const vps = pg.actions().filter((a) => a.action === 'viewportCaps');
  assert.equal(vps.length, 1, 'guest page reports viewportCaps on connect');
  assert.deepEqual({ vw: vps[0].vw, vh: vps[0].vh, init: vps[0].init }, { vw: 800, vh: 1280, init: true });
  pg.msg({ type: 'state', state: { psMode: true, pickOpen: true, layouts: [{ k: 'd1', name: 'Design 1', shots: 'Strip', thumb: '' }, { k: 'd2', name: 'Design 2', shots: '4R', thumb: '' }] } });
  const firstBtn = pg.els.pkg.children[0];
  assert(firstBtn, 'picker renders buttons immediately even while thumbs are blank');
  pg.msg({ type: 'state', state: { psMode: true, pickOpen: true, layouts: [{ k: 'd1', name: 'Design 1', shots: 'Strip', thumb: '/media/lay_0_d1?v=1' }, { k: 'd2', name: 'Design 2', shots: '4R', thumb: '' }] } });
  assert.equal(pg.els.pkg.children[0], firstBtn, 'progressive thumb update patches img src in place without rebuilding grid');
  assert(firstBtn.children[0].src.endsWith('/media/lay_0_d1?v=1'), 'patched card image src points to arrived media URL');
  console.log('PASS: portrait panel layout, corner logo, welcome orientation guard, fullscreen frame reset, viewportCaps, and tap trigger verified');
}

console.log('All guest page voice and label tests passed!');
