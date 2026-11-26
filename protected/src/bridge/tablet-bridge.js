// ---- Tablet Guest Screen + Camera Bridge (Android / Huawei MatePad Pro) ----
// These are `var` on purpose, not const/let. This file is pasted in the middle of the booth script, but guestRender() and
// the camera-list code run earlier, during start-up, and they call tabletGuestOpen() / tabletCamAvailable() and use
// `typeof TABLET_CAM_ID`. A const/let that is not set yet throws "Cannot access ... before initialization" on the laptop
// app (DESKTOP is true there), which stops the whole booth script and leaves "Tap to start" with no click handler (1.1.73).
var TABLET_CAM_ID = 'tablet-bridge';
var HELPER_BRIDGE_BASE = 'http://127.0.0.1:17321/bridge-ctrl';
var tabletBridge = {
  mode: '',          // 'desktop' (Electron IPC) or 'helper' (online Web Booth via Print Helper)
  api: null,
  webLaptop: false,
  helperState: '',   // '', 'ready', 'missing', 'outdated'
  info: null,
  port: 0,
  connected: false,
  camConnected: false,
  guestConnected: false,
  deviceName: '',
  facing: 'front',
  width: 0,
  height: 0,
  voiceOk: false,   // the tablet said it can speak the countdown (its voice list came in as the "voiceCaps" action)
  voices: { en: [], fil: [] },   // the tablet's own voices: [{ name, lang, localService }]
  soundOk: false,   // the tablet has the sounds decoded and its audio is running (the "soundCaps" action)
  soundSig: '',     // which own sound files the tablet was last sent
  soundOwn: { shut: false, tick: false },   // does the tablet's shutter / beep come from the operator's own file (a little louder)
  stream: null,
  pumpStop: null,
  bgTimer: null,
  mediaSigs: Object.create(null),
  mediaUrls: Object.create(null),
  mediaUploading: Object.create(null),
  syncQueued: false,
  lastError: '',    // why the last screen update could not be built (shown in Setup), '' when it worked
  lastPushAt: 0,
  aspKey: '',
  buildSeq: 0,      // each picture of the screen that is built gets the next number...
  pushedSeq: 0,     // ...and an older one is never sent after a newer one went out
  reviewSrc: '',    // the photo just taken, shown between shots (Setup: show each photo after it is taken)
  wasUsingCam: false, // remembers tablet camera across a brief Wi-Fi drop so it auto-reclaims on reconnect
  viewport: null,    // guest tablet WebView size { vw, vh } reported by viewportCaps
  welCache: null     // cached welcome card rendered at tablet aspect { key, url, wa }
};

function activeBridgeApi() { return (window.pb4u && window.pb4u.bridge) || (tabletBridge && tabletBridge.api) || null; }
function tabletBridgeReady() { return !!(DESKTOP || (tabletBridge && tabletBridge.mode === 'helper')); }
function tabletBridgeLocalBase() {
  if (tabletBridge && tabletBridge.mode === 'helper') return HELPER_BRIDGE_BASE;
  return (tabletBridge && tabletBridge.port) ? ('http://127.0.0.1:' + tabletBridge.port + '/bridge-local') : '';
}
function tabletGuestOpen() { return !!(tabletBridgeReady() && tabletBridge && tabletBridge.guestConnected); }
function tabletCamAvailable() { return !!(tabletBridgeReady() && tabletBridge && tabletBridge.camConnected && tabletBridge.port); }
function tabletCamOptionLabel() {
  const nm = tabletBridge.deviceName || 'Tablet';
  const side = tabletBridge.facing === 'back' ? 'Rear' : 'Front';
  return 'Tablet Camera · ' + nm + ' (' + side + ')';
}
// ---- The spoken countdown on the tablet ----
// When the tablet's guest screen is connected and the tablet can speak (the guest page sends its voice list as the "voiceCaps" action),
// the tablet says "Get ready... Three, Two, One... Smile!" and the laptop stays quiet. The booth's voice code (voiceEngine, voicesFor,
// voiceSay, voiceStop in the sound section) asks the functions below. No guest screen, or a tablet with no voice = the laptop's own voice.
function tabletVoiceOn() { return !!(tabletGuestOpen() && tabletBridge.voiceOk); }
function tabletVoiceList(lang) {
  const l = tabletBridge.voices && tabletBridge.voices[lang === 'fil' ? 'fil' : 'en'];
  return Array.isArray(l) ? l : [];
}
function tabletVoiceCaps(act) {
  const clean = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 100).filter((v) => v && v.name)
    .map((v) => ({ name: String(v.name), lang: String(v.lang || ''), localService: !!v.localService }));
  const v = (act && act.voices) || {};
  tabletBridge.voices = { en: clean(v.en), fil: clean(v.fil) };
  tabletBridge.voiceOk = tabletBridge.voices.en.length > 0;
  try { if (typeof refreshFxUI === 'function') refreshFxUI(); } catch (e) { }
}
function tabletVoiceSend(text, lang, name, vol) {
  const api = activeBridgeApi();
  if (!tabletVoiceOn() || !api) return false;
  try {
    api.sendEvent({ type: 'voice', text: String(text), lang: lang === 'fil' ? 'fil' : 'en', name: name || '', vol: vol });
    return true;
  } catch (e) { return false; }
}
function tabletVoiceStop() {
  const api = activeBridgeApi();
  if (!tabletGuestOpen() || !api) return;
  try { api.sendEvent({ type: 'voiceStop' }); } catch (e) { }
}

// ---- Beeps, "Pose" chime, start chime and the shutter click on the tablet ----
// The booth's built-in sounds (sound/fx-sounds.js) and the operator's own sound files go to the tablet's guest page once as small WAV files
// (a "sounds" message). When the tablet has decoded them and its audio is running it reports "soundCaps"; from then on the booth's sound
// functions (fxBeep, fxPose, fxShutter, fxStartChime) send a "sound" message for each one and the laptop stays quiet. No guest screen, or a
// tablet whose audio is still locked (a browser that wants a tap first): the laptop plays them as before.
function tabletSoundOn() { return !!(tabletGuestOpen() && tabletBridge.soundOk); }
function tabletSoundPlay(kind) {
  const api = activeBridgeApi();
  if (!tabletSoundOn() || !api) return false;
  const own = kind === 'shut' ? tabletBridge.soundOwn.shut : (kind === 'b1' || kind === 'b2') ? tabletBridge.soundOwn.tick : false;
  try {
    api.sendEvent({ type: 'sound', kind: kind, vol: Number((fx.vol * (own ? 1.1 : 1)).toFixed(3)) });
    return true;
  } catch (e) { return false; }
}
function tabletSoundPack() {
  const own = (o) => { const rec = o && typeof ASSETS !== 'undefined' && ASSETS[o.id]; return rec && rec.url ? rec.url : ''; };
  const sh = own(fx.sShut), tk = own(fx.sTick);
  return {
    sig: (sh ? fx.sShut.id : '') + '|' + (tk ? fx.sTick.id : ''),
    own: { shut: !!sh, tick: !!tk },
    sounds: { shut: sh || fxWavUrl('shut'), b1: tk || fxWavUrl('b1'), b2: tk || fxWavUrl('b2'), pose: fxWavUrl('pose'), chime: fxWavUrl('chime') }
  };
}
function tabletSoundSync(force) {
  const api = activeBridgeApi();
  if (!tabletGuestOpen() || !api) return;
  try {
    const p = tabletSoundPack();
    if (!force && p.sig === tabletBridge.soundSig) return;
    tabletBridge.soundSig = p.sig;
    tabletBridge.soundOwn = p.own;
    api.sendEvent({ type: 'sounds', sig: p.sig, sounds: p.sounds });
  } catch (e) { }
}
function tabletSoundCaps(act) { tabletBridge.soundOk = !!(act && act.ok); }

// Makes sure the camera menu has the tablet in it without waiting for the system's camera list (see renderTabletBridgeSetup).
function tabletEnsureOption() {
  if (!tabletCamAvailable()) return;
  if (Array.from(cameraSelect.options).some(o => o.value === TABLET_CAM_ID)) return;
  Array.from(cameraSelect.options).filter(o => !o.value).forEach(o => o.remove());   // the "Loading cameras…" placeholder
  const opt = document.createElement('option');
  opt.value = TABLET_CAM_ID;
  opt.textContent = tabletCamOptionLabel();
  cameraSelect.appendChild(opt);
}

// A cheap fingerprint of a picture address: its length and a hash of about 64 characters spread over all of it. (The start of
// two different JPEGs is the same, so the old start-and-length check could show the previous guest's photo.)
function tabletPicSig(src) {
  const t = String(src);
  const step = Math.max(1, Math.floor(t.length / 64));
  let h = 0;
  for (let i = 0; i < t.length; i += step) h = (h * 31 + t.charCodeAt(i)) | 0;
  return t.length + ':' + h;
}
// The shape of the guest picture (ga) and of one photo in the side strip (film), worked out the way applyStageAspect() does it for the
// laptop's own guest window: the finished strip's shape, the shot's box while shooting, the camera's shape between guests.
// (This used to call a function called layoutBoxAspect that the booth does not have, so building the screen state threw every
// time and the tablet never got a screen state: no shot preview, no QR code, no sizes. The error was swallowed.)
function tabletGuestAspects() {
  let film = 0.8, ga = 1.3333;
  try { film = currentBoxAspect(); } catch (e) { }
  try {
    const cam = camAspect();
    let box = film;
    try { if (state === 'capturing') box = shotBoxAspect(stageShot); } catch (e) { }
    let strip = false;
    try { strip = (state === 'result' || !!(sess && sess.reviewing)) && previewCanvas.width > 0 && previewCanvas.style.display !== 'none'; } catch (e) { }
    ga = strip ? previewCanvas.width / previewCanvas.height : (state === 'capturing' ? box : cam);
  } catch (e) { }
  return { ga: ga > 0 ? ga : 1.3333, film: film > 0 ? film : 0.8 };
}
// Called by applyStageAspect(): send the screen again when the shapes changed (a new layout, shooting starts, the strip is shown).
function tabletBridgeAspect() {
  if (!tabletGuestOpen()) return;
  const a = tabletGuestAspects();
  const key = a.ga.toFixed(4) + '|' + a.film.toFixed(4);
  if (tabletBridge.aspKey !== key) { tabletBridge.aspKey = key; tabletBridgeSync(); }
}
// The booth's size and opacity settings for the countdown, the buttons and the photo strip (Setup: Display & monitor size,
// Resize on the guest screen). They are CSS variables on the booth page; the guest screen reads the same ones.
function tabletUiVars() {
  const rs = document.documentElement.style, o = {};
  ['cd', 'btn', 'film'].forEach((k) => {
    const sc = parseFloat(rs.getPropertyValue('--ui-' + k + '-scale')), op = parseFloat(rs.getPropertyValue('--ui-' + k + '-opacity'));
    o[k] = sc > 0 ? sc : 1;
    o[k + 'Op'] = op > 0 ? op : 1;
  });
  return o;
}
// Sends a picture to the laptop's bridge so the tablet can load it. A second request for the same picture waits for the one that is
// already on its way (the old code answered with the previous guest's picture, or none), and a new picture for a slot goes after the
// older one, so the bridge never ends up holding the older picture.
async function tabletBridgeUploadMedia(slot, srcUrl, mime, maxDim) {
  if (!tabletBridgeLocalBase() || !srcUrl) return '';
  const sig = tabletPicSig(srcUrl);
  if (tabletBridge.mediaSigs[slot] === sig && tabletBridge.mediaUrls[slot]) return tabletBridge.mediaUrls[slot];
  const cur = tabletBridge.mediaUploading[slot];
  if (cur && cur.sig === sig) return cur.p;
  const after = cur ? cur.p.catch(() => { }) : Promise.resolve();
  const p = after.then(() => tabletUploadMediaNow(slot, srcUrl, mime, maxDim, sig)).finally(() => {
    const now = tabletBridge.mediaUploading[slot];
    if (now && now.p === p) delete tabletBridge.mediaUploading[slot];
  });
  tabletBridge.mediaUploading[slot] = { sig, p };
  return p;
}
async function tabletUploadMediaNow(slot, srcUrl, mime, maxDim, sig) {
  try {
    let blob;
    if (String(srcUrl).startsWith('data:') || String(srcUrl).startsWith('blob:') || String(srcUrl).startsWith('app:')) {
      const r = await fetch(srcUrl);
      blob = await r.blob();
    } else {
      return srcUrl;
    }
    if (maxDim && typeof createImageBitmap === 'function' && /^image\/(png|jpeg|webp)/i.test(blob.type || '')) {
      const bmp = await createImageBitmap(blob);
      try {
        if (Math.max(bmp.width, bmp.height) > maxDim) {
          const s = maxDim / Math.max(bmp.width, bmp.height);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(bmp.width * s));
          c.height = Math.max(1, Math.round(bmp.height * s));
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          blob = await new Promise((res) => c.toBlob(res, mime || 'image/jpeg', 0.85));
        }
      } finally { try { bmp.close(); } catch (e) { } }
    }
    const base = tabletBridgeLocalBase();
    if (!base) return '';
    const resp = await fetch(base + '/media/' + encodeURIComponent(slot), {
      method: 'POST',
      headers: { 'content-type': (blob && blob.type) || mime || 'image/jpeg' },
      body: blob
    });
    if (resp.ok) {
      const j = await resp.json();
      const out = '/media/' + encodeURIComponent(slot) + '?v=' + (j.seq || Date.now());
      tabletBridge.mediaSigs[slot] = sig;
      tabletBridge.mediaUrls[slot] = out;
      return out;
    }
  } catch (e) { /* ignore upload error */ }
  return '';   // not sent: show nothing rather than the picture of an earlier guest that is still in this slot
}

function openTabletCameraStream() {
  if (!tabletCamAvailable()) throw new Error('Tablet camera is not connected');
  if (tabletBridge.pumpStop) { try { tabletBridge.pumpStop(); } catch (e) { } tabletBridge.pumpStop = null; }
  const localBase = tabletBridgeLocalBase();
  if (!localBase) throw new Error('Tablet camera bridge is not ready');
  const canvas = document.createElement('canvas');
  canvas.width = (tabletBridge.info && tabletBridge.info.width) || 1280;
  canvas.height = (tabletBridge.info && tabletBridge.info.height) || 960;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(24);
  const track = stream.getVideoTracks()[0];
  let alive = true, seq = 0, fails = 0, dropAt = 0;
  const origStop = track.stop.bind(track);
  const stopAll = () => {
    if (!alive) return;
    alive = false;
    try { origStop(); } catch (e) { }
    if (tabletBridge.stream === stream) tabletBridge.stream = null;
  };
  track.stop = stopAll;
  tabletBridge.pumpStop = stopAll;
  tabletBridge.stream = stream;
  tabletBridge.wasUsingCam = true;
  try { const a0 = activeBridgeApi(); if (a0) a0.camCmd({ type: 'live', on: true }); } catch (e) { }

  (async function pump() {
    while (alive) {
      if (!tabletBridge.camConnected) {
        if (!dropAt) dropAt = Date.now();
        // Survive brief 1–4s Wi-Fi/Huawei reconnect blips without kicking the booth back to the laptop webcam.
        if (Date.now() - dropAt < 4500) {
          await wait(200);
          continue;
        }
        tabletBridge.wasUsingCam = true;
        stopAll();
        try { track.dispatchEvent(new Event('ended')); } catch (e) { }
        return;
      }
      if (dropAt) {
        dropAt = 0;
        seq = 0; // fetch the latest frame immediately after a brief reconnect
        try { const a1 = activeBridgeApi(); if (a1) a1.camCmd({ type: 'live', on: true }); } catch (e) { }
      }
      try {
        const r = await fetch(localBase + '/frame?after=' + seq + '&wait=900', {
          cache: 'no-store',
          signal: AbortSignal.timeout(4000)
        });
        if (r.status === 200) {
          const nextSeq = Number(r.headers.get('x-pb-seq') || 0);
          if (nextSeq) seq = nextSeq;
          const bmp = await createImageBitmap(await r.blob());
          if (bmp.width !== canvas.width || bmp.height !== canvas.height) {
            canvas.width = bmp.width; canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          try { bmp.close(); } catch (e) { }
          fails = 0;
        } else {
          await wait(25);
        }
      } catch (e) {
        if (!alive) return;
        if (++fails > 25) {
          tabletBridge.wasUsingCam = true;
          stopAll();
          try { track.dispatchEvent(new Event('ended')); } catch (e2) { }
          return;
        }
        await wait(120);
      }
    }
  })();

  return stream;
}

async function captureTabletShot(index) {
  captureFrame(index);
  const localBase = tabletBridgeLocalBase();
  if (!tabletCamAvailable() || !localBase) return;
  const shots = shotCanvases;
  try {
    const r = await fetch(localBase + '/capture', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(16000)
    });
    if (!r.ok) return;
    const blob = await r.blob();
    if (shotCanvases !== shots || (sess && sess.cancelled)) return;
    const bmp = await createImageBitmap(blob);
    try {
      const sw = bmp.width, sh = bmp.height;
      if (!sw || !sh) return;
      const k = Math.min(1, USB_SHOT_MAX / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.round(sw * k);
      c.height = Math.round(sh * k);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (mirrorPreview()) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(bmp, 0, 0, sw, sh, 0, 0, c.width, c.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      finalizeShotCanvas(c, index);
    } finally { try { bmp.close(); } catch (e) { } }
  } catch (e) {
    console.warn('Tablet full-res shot failed, live frame kept:', e);
  }
}

function tabletGuestPrintState() {
  const result = state === 'result' && shotCanvases.every(Boolean);
  if (!result) return { printShow: false, nextShow: false, printBusy: false };
  const printedFirst = qrPopOn && !hideQrOn && printPrefs.printFirst && willAutoPrint();
  const canPrint = !printSection.classList.contains('hidden') && printPrefs.guestBtn && !!printSize &&
    !(typeof noPrintSession === 'function' && noPrintSession()) && !printedFirst;
  const left = printSize ? maxCopies(printSize) : 0;
  const out = left < 1;
  const lim = printLimits();
  let sub = '';
  if (out) sub = 'Limit reached';
  else if (printQueued > 0) sub = printQueued + (printQueued === 1 ? ' print' : ' prints') + ' in queue';
  else if (lim.se || lim.ev) sub = (left >= MAX_COPIES ? MAX_COPIES + '+' : left) + (left === 1 ? ' print left' : ' prints left');
  return {
    printShow: canPrint,
    printDisabled: !!printing || out,
    printBusy: !!printing,   // "Printing, please hold…" is a long label: the tablet shows it in a smaller size
    printLabel: printing ? printTxt('txtPrinting') : printTxt('txtPrint'),
    printSub: sub,
    printGuestCopies: !!(printPrefs.guestCopies && left > 1),
    printDefaultCopies: Math.max(1, Math.min(Math.max(1, left), printPrefs.copies || 1)),
    printMaxCopies: Math.max(1, left),
    printCopiesTitle: printTxt('txtCopies'),
    printLimitText: (lim.se || lim.ev) ? ('Up to ' + left + (left === 1 ? ' copy' : ' copies') + ' left') : '',
    nextShow: true,
    nextLabel: 'Done'
  };
}

var bridgeRemoteCanvas = null;
function syncRemoteFrameToBridge(active, bgActive) {
  if (active && tabletGuestOpen() && tabletBridge.port) {
    if (!tabletBridge.bgTimer) {
      tabletBridge.bgTimer = setInterval(() => {
        if (!tabletGuestOpen() || !tabletBridge.port || tabletBridge.bgSending) return;
        const src = (bgActive && typeof bgLive !== 'undefined' && bgLive && bgLive.canvas && bgLive.canvas.style.display !== 'none')
          ? bgLive.canvas
          : (typeof camFrameSource === 'function' ? camFrameSource() : null);
        if (!src) return;
        const sw = src.videoWidth || src.width || 0;
        const sh = src.videoHeight || src.height || 0;
        if (!sw || !sh) return;
        let outCanvas = src;
        if (src !== (typeof bgLive !== 'undefined' && bgLive && bgLive.canvas)) {
          if (!bridgeRemoteCanvas) bridgeRemoteCanvas = document.createElement('canvas');
          const scale = Math.min(1, 720 / Math.max(sw, sh));
          bridgeRemoteCanvas.width = Math.max(1, Math.round(sw * scale));
          bridgeRemoteCanvas.height = Math.max(1, Math.round(sh * scale));
          bridgeRemoteCanvas.getContext('2d').drawImage(src, 0, 0, bridgeRemoteCanvas.width, bridgeRemoteCanvas.height);
          outCanvas = bridgeRemoteCanvas;
        }
        tabletBridge.bgSending = true;
        try {
          outCanvas.toBlob((b) => {
            const base = tabletBridgeLocalBase();
            if (!b || !base) { tabletBridge.bgSending = false; return; }
            fetch(base + '/media/remoteFrame', {
              method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: b
            }).catch(() => { }).finally(() => { tabletBridge.bgSending = false; });
          }, 'image/jpeg', 0.72);
        } catch (e) { tabletBridge.bgSending = false; }
      }, 75);
    }
  } else if (tabletBridge.bgTimer) {
    clearInterval(tabletBridge.bgTimer);
    tabletBridge.bgTimer = null;
    tabletBridge.bgSending = false;
  }
}

async function buildAndPushTabletState() {
  const api = activeBridgeApi();
  if (!tabletGuestOpen() || !api) return;
  const buildSeq = ++tabletBridge.buildSeq;
  // One part of the screen that fails (a helper that throws) is left out and reported in Setup; the rest still goes to the tablet.
  const soft = [];
  const T = (tag, fn, fallback) => {
    try { return fn(); } catch (e) {
      soft.push(tag + ': ' + String((e && e.message) || e));
      try { console.error('Tablet guest screen, ' + tag + ' failed:', e); } catch (e2) { }
      return fallback;
    }
  };
  const psMode = guestWelcomeStyle !== 'panel';
  const ready = readyOverlay.classList.contains('ready-active');
  // Setup > Resize on the guest screen: the guest screen shows a sample countdown, sample photos and the buttons instead.
  const ed = typeof layoutEditorActive !== 'undefined' && !!layoutEditorActive;
  const result = !ed && state === 'result' && shotCanvases.every(Boolean);
  const reviewing = !ed && !!(sess && (sess.reviewing || sess.decorating));
  if (tabletBridge.reviewSrc && (!sess || result || ed)) tabletBridge.reviewSrc = '';
  const shotReview = !!tabletBridge.reviewSrc && !reviewing && !result;
  const welcome = !ed && welcomeOn && state === 'idle' && !pickOpen && !ready &&
    (!!welcomeDataUrl || (attractMode === 'poster' && !!(attractPlaylist.length || attractPosterUrl)));
  const bgActive = !!(typeof bgGuestStream === 'function' && bgGuestStream());
  const filterCss = T('live filter', () => liveFilterCss(), '');
  const useRemoteStream = (bgActive || (!!filterCss && currentDeviceId === TABLET_CAM_ID) || (currentDeviceId !== TABLET_CAM_ID)) && !pickOpen && !result && !reviewing && !shotReview && (!welcome || attractMode === 'camera');

  syncRemoteFrameToBridge(useRemoteStream, bgActive);

  let resSrc = '', resFit = 'contain';
  let welWa = welcomeGeo ? Number((welcomeGeo.W / welcomeGeo.H).toFixed(4)) : 1.3333;
  let resBgPromise = Promise.resolve('');
  if (result && typeof qrMatchWelcome !== 'undefined' && qrMatchWelcome && typeof getWelcomeThemeTokens === 'function' && typeof resultBgDataUrl === 'string' && resultBgDataUrl) {
    resBgPromise = tabletBridgeUploadMedia('resbg', resultBgDataUrl, 'image/jpeg', 1400).catch(() => '');
  }
  try {
  if (sess && sess.decorating) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.85), 'image/jpeg', 1600);
  } else if (result) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.9), 'image/jpeg', 1800);
  } else if (reviewing) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.85), 'image/jpeg', 1600);
  } else if (shotReview) {
    resSrc = await tabletBridgeUploadMedia('review', tabletBridge.reviewSrc, 'image/jpeg', 1600);
    resFit = 'contain';
  } else if (welcome && attractMode !== 'video') {
    const slideList = attractPlaylist.length ? attractPlaylist : (attractPosterUrl ? [{ url: attractPosterUrl, type: attractPosterType }] : []);
    const curSlide = (attractMode === 'poster' && slideList.length) ? (slideList[attractPlayIndex] || slideList[0]) : null;
    let rawWel = (curSlide && !welcomeBtnOn && !(typeof brandImgFor === 'function' && brandImgFor('w'))) ? curSlide.url : welcomeDataUrl;
    if (attractMode === 'card' && tabletBridge.viewport && tabletBridge.viewport.vw > 0 && tabletBridge.viewport.vh > 0 && typeof renderWelcomeForViewport === 'function') {
      const vp = tabletBridge.viewport;
      const vpAr = vp.vw / vp.vh;
      if (Math.abs(vpAr - welWa) / Math.max(0.2, welWa) > 0.04) {
        const wKey = tabletPicSig(welcomeDataUrl) + ':' + vp.vw + 'x' + vp.vh;
        if (!tabletBridge.welCache || tabletBridge.welCache.key !== wKey) {
          const rendered = renderWelcomeForViewport(vp.vw, vp.vh);
          if (rendered && rendered.dataUrl) {
            tabletBridge.welCache = { key: wKey, url: rendered.dataUrl, wa: rendered.wa || Number(vpAr.toFixed(4)) };
          }
        }
        if (tabletBridge.welCache && tabletBridge.welCache.key === wKey && tabletBridge.welCache.url) {
          rawWel = tabletBridge.welCache.url;
          welWa = tabletBridge.welCache.wa;
        }
      }
    }
    if (rawWel) {
      resSrc = await tabletBridgeUploadMedia('welcome', rawWel, attractMode === 'camera' ? 'image/png' : 'image/jpeg', 1920);
      resFit = (attractMode === 'poster') ? (attractPosterFit === 'contain' ? 'contain' : (attractPosterFit === 'stretch' ? 'fill' : 'cover')) : 'cover';
    }
  }
  } catch (e) {
    soft.push('photo: ' + String((e && e.message) || e));
    try { console.error('Tablet guest screen, photo failed:', e); } catch (e2) { }
    resSrc = '';
  }

  let layouts = [];
  try {
  if (pickOpen) {
    layouts = await Promise.all(pickKeys.map(async (k, i) => {
      let rawThumb = '';
      let nm = '';
      let sh = '';
      let tag = '';
      let tagCls = '';
      if (pickDesignMode) {
        const srcBtn = pickGrid.children[i];
        const nmEl = srcBtn && srcBtn.querySelector('.pick-name');
        const shEl = srcBtn && srcBtn.querySelector('.pick-shots');
        const tagEl = srcBtn && srcBtn.querySelector('.pick-tier-tag');
        rawThumb = (srcBtn && srcBtn.querySelector('img') && srcBtn.querySelector('img').src) || '';
        nm = (nmEl && nmEl.textContent) || (pickDesignsList[i] && pickDesignsList[i].name) || ('Design ' + (i + 1));
        sh = (shEl && shEl.textContent) || 'Ready';
        if (tagEl && tagEl.textContent) {
          tag = tagEl.textContent;
          tagCls = tagEl.classList.contains('thermal') ? 'thermal' : (tagEl.classList.contains('color') ? 'color' : '');
        }
      } else {
        rawThumb = layoutThumbUrl(k);
        nm = pickName(k);
        const isFr = /^frame:/.test(k), isPr = /^sheet:/.test(k);
        const fObj = isFr && typeof frameById === 'function' ? frameById(k.slice(6)) : null;
        const prObj = isPr && typeof presetById === 'function' ? presetById(k.slice(6)) : null;
        const nShots = isFr ? frameShotCount(fObj) : (isPr ? presetShotCount(prObj) : (LAYOUT_DEFS[k] ? LAYOUT_DEFS[k].shots : 4));
        sh = nShots + (nShots === 1 ? ' shot' : ' shots');
      }
      const isJpeg = /^data:image\/jpe?g/i.test(rawThumb);
      const thumb = rawThumb ? await tabletBridgeUploadMedia('lay_' + i + '_' + k.replace(/[^A-Za-z0-9_-]/g, '_'), rawThumb, isJpeg ? 'image/jpeg' : 'image/png', isJpeg ? 0 : 480) : '';
      return { k, name: nm, shots: sh, thumb, tag, tagCls };
    }));
  }
  } catch (e) {
    soft.push('layout picker: ' + String((e && e.message) || e));
    try { console.error('Tablet guest screen, layout picker failed:', e); } catch (e2) { }
    layouts = [];
  }

  // Setup > Step 7 "Show the QR code in a pop-up": the finished photo is on its own for a few seconds ('wait'), then a card with a
  // big QR code, Print and Done ('show'). The tablet follows the same two phases as the booth screen.
  const qrPopPhase = (!ed && result && qrPopOn && !shareStationOn && typeof qrPop !== 'undefined' && qrPop) ? (qrPop.phase || '') : '';
  const slots = T('QR codes', () => [...qrResults.querySelectorAll('.qr-result')], []);
  const showQr = result && slots.length > 0 && !printFirstHolding && qrPopPhase !== 'wait';
  const qrs = showQr ? T('QR codes', () => slots.map(sl => {
    const im = sl.querySelector('.qr-img');
    return {
      kind: sl.dataset.kind || '',
      src: im ? im.src : '',
      wait: (sl.querySelector('.qr-wait') || {}).textContent || 'One moment…',
      label: (sl.querySelector('.qr-caption') || {}).textContent || ''
    };
  }), []) : [];

  let shots = T('photo strip', () => shotCanvases.map((shot, i) => {
    const mf = filmTrack.children[i];
    return {
      src: shot ? shotThumb(shot) : '',
      pick: !!(mf && mf.classList.contains('pickable')),
      sel: !!(mf && mf.classList.contains('picked'))
    };
  }), []);
  if (ed && !shots.some((x) => x.src) && typeof SAMPLE_PORTRAITS !== 'undefined') {
    const n = typeof shotsNeeded === 'function' ? shotsNeeded() : 4;
    shots = Array.from({ length: n }, (_, i) => ({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(SAMPLE_PORTRAITS[i % SAMPLE_PORTRAITS.length]), pick: false, sel: false }));
  }

  let msg = 'Tap to start', sub = '', chip = 'Ready';
  T('captions', () => {
  if (pickOpen) { msg = pickTitleText(); sub = 'Tap one to start'; chip = 'Pick one'; }
  else if (sess && sess.decorating) { msg = 'Customising photo…'; sub = 'Finish on booth screen'; chip = 'Decorate'; }
  else if (sess && sess.reviewing) {
    msg = 'Check your photos';
    sub = !retakesAllowed() ? 'Tap Done to save' : shotCanvases.length > 1 ? 'Tap a photo to retake it' : 'Retake it, or tap Done';
    chip = 'Review';
  } else if (result) {
    msg = printFirstHolding ? 'Printing your photos…' : 'Looking good!';
    sub = printFirstHolding ? 'Your QR code will appear once printing is done' : (showQr ? 'Scan to get your photo' : (autoPrint ? 'Printing…' : 'Your photo is ready'));
    chip = printFirstHolding ? 'Printing' : 'Done';
  } else if (state === 'capturing' && countingDown) {
    msg = 'Look at the camera';
    sub = shotsNeeded() + (shotsNeeded() === 1 ? ' shot' : ' shots');
    chip = 'Smile!';
  } else if (ready) {
    msg = 'Get ready!';
    sub = readyOverlay.classList.contains('hands') ? (fx.hands === 'smile' ? 'Smile to start' : 'Wave to start') + ' · or tap the screen' : 'Tap to start';
    chip = shotsNeeded() + (shotsNeeded() === 1 ? ' shot' : ' shots');
  } else if (welcome) {
    msg = 'Welcome!'; sub = 'Tap the screen to start';
  } else {
    sub = layoutDef().name + ' · ' + shotsNeeded() + (shotsNeeded() === 1 ? ' shot' : ' shots');
  }
  });

  const asp = tabletGuestAspects();

  const looksShow = T('looks', () => !!(guestLooksOn && isTraditional() && !pickOpen && (ready || state === 'idle') && !(sess && sess.reviewing)), false);
  const looks = looksShow ? T('looks', () => guestLookKeys().map(k => ({ k, label: FILTER_LABELS[k] || k })), []) : [];
  const galleryIdle = T('event gallery', () => !psMode && state === 'idle' && !pickOpen && !ready && !!currentFolderLink && !gvPrivate(), false);
  const printState = T('print buttons', () => tabletGuestPrintState(), { printShow: false, nextShow: false });
  const mirror = T('mirror', () => !!mirrorPreview(), true);
  const dateLabel = T('date', () => currentDateLabel(), '');
  const eventName = T('event name', () => (labelInput.value || '').trim(), '');
  const uiVars = T('sizes', () => tabletUiVars(), {});
  if (qrPopPhase === 'wait') { printState.printShow = false; printState.nextShow = false; }
  const qrTitleEl = document.getElementById('qrSectionTitle');
  let resTheme = null;
  if (result && typeof qrMatchWelcome !== 'undefined' && qrMatchWelcome && typeof getWelcomeThemeTokens === 'function') {
    try {
      const rtok = getWelcomeThemeTokens();
      const bgUrl = await resBgPromise;
      resTheme = {
        on: true,
        bg: bgUrl,
        cardBg: rtok.fillCardColor,
        ink: rtok.ink,
        soft: rtok.soft,
        border: rtok.cardBorder,
        radius: Math.min(rtok.radius, 36),
        btnBg: rtok.btnColor,
        btnInk: rtok.btnInk,
        decoStyle: rtok.decoStyle || 'none',
        decoSecondary: rtok.decoSecondary || '#F28DA0',
        titleFont: rtok.titleFont || ''
      };
    } catch (e) { }
  }

  let clogo = null;
  if (!psMode) {
    try {
      if (typeof brand !== 'undefined' && typeof brandImgFor === 'function' && typeof brandId === 'function' && typeof brandFit === 'function' && typeof ASSETS !== 'undefined') {
        const b = brand && brand.c, im = brandImgFor('c'), id = brandId('c');
        if (b && im && id && ASSETS[id] && ASSETS[id].url) {
          const f = brandFit(im.naturalWidth / im.naturalHeight, (b.s || BRAND_DEF_S.c) * 100, (b.s || BRAND_DEF_S.c) * 100 * BRAND_MAXR);
          const cUrl = await tabletBridgeUploadMedia('clogo', ASSETS[id].url, 'image/png', 800);
          if (cUrl) clogo = { url: cUrl, x: b.x == null ? null : Number(b.x), y: b.y == null ? null : Number(b.y), w: Number(f.w.toFixed(2)), h: Number(f.h.toFixed(2)) };
        }
      }
    } catch (e) { }
  }

  const payload = Object.assign({
    psMode,
    isWelcome: !!welcome,
    welCard: !!(welcome && attractMode === 'card'),
    clogo,
    isResult: result,
    resTheme,
    showQr,
    qrs,
    qrPop: qrPopPhase,
    qrTitle: (qrTitleEl && qrTitleEl.textContent || '').trim(),
    ga: Number(asp.ga.toFixed(4)),
    wa: welWa,
    boxAspect: Number(asp.film.toFixed(4)),
    welFull: !!(welcome && !psMode && welcomeGeo && guestWelcomeStyle !== 'panel'),
    welFullPs: !!(psMode && welcome),
    hideCam: !!(result || reviewing || shotReview || (welcome && attractMode !== 'camera')),
    useRemoteStream: !!useRemoteStream,
    remoteMirror: !!(mirror && !bgActive),
    mirror,
    filterCss: filterCss || '',
    resSrc,
    resFit,
    ev: eventName,
    dt: dateLabel,
    msg, sub, chip,
    countingDown: !!(state === 'capturing' && countingDown),
    showReady: !!(psMode && ready && !pickOpen),
    readySub: readySub ? readySub.textContent : '',
    readyBtn: readyOverlay.classList.contains('hands') ? (fx.hands === 'smile' ? 'Smile to start' : 'Wave to start') : 'Start',
    pickOpen: !!pickOpen && !ed,
    pickIdx,
    pickTitle: pickOpen ? T('layout picker', () => pickTitleText(), '') : '',
    pickSub: pickOpen ? T('layout picker', () => pickSubText(), '') : '',
    pickCanBack: !!(pickOpen && !ed && pickBackAllowed),
    pickTier: !!(pickOpen && !ed && pickTierMode),
    pickBwStep: !!(pickOpen && !ed && !pickTierMode && pickTierFilter === 'receipt'),
    layouts,
    looksShow,
    looksOpen: !!guestLookOpen,
    lookKey: filterKey,
    lookLabel: T('looks', () => FILTER_LABELS[filterKey] || filterKey, ''),
    looks,
    shots,
    retakeShow: ed || !!(sess && !retakeBtn.hidden),
    retakeText: ed ? '\u21BA Retake photo 1' : (retakeBtn.textContent || 'Retake'),
    doneShow: ed || !!(sess && !doneBtn.hidden),
    doneText: ed ? '\u2713 Done \u2014 save my photo' : (doneBtn.textContent || 'Done'),
    ui: uiVars,
    editPreview: ed,
    galleryShow: galleryIdle,
    galleryQr: galleryIdle ? T('event gallery', () => (document.getElementById('galleryPopQr').src || ''), '') : ''
  }, printState);

  if (buildSeq < tabletBridge.pushedSeq || buildSeq !== tabletBridge.buildSeq) return;   // a newer picture of the screen is already pending or went out
  tabletBridge.pushedSeq = buildSeq;
  try {
    api.pushState(payload);
    tabletBridge.lastError = soft.length ? 'part of the screen was left out (' + soft.join('; ') + ')' : '';
    tabletBridge.lastPushAt = Date.now();
  } catch (e) {
    tabletBridge.lastError = 'could not send the screen: ' + String((e && e.message) || e);
    try { console.error('Tablet guest screen could not be sent:', e); } catch (e2) { }
  }
}

function tabletBridgeSync() {
  if (!tabletGuestOpen() || tabletBridge.syncQueued) return;
  tabletBridge.syncQueued = true;
  setTimeout(() => {
    tabletBridge.syncQueued = false;
    buildAndPushTabletState().catch((e) => {
      tabletBridge.lastError = String((e && e.message) || e);
      try { console.error('Tablet guest screen update failed:', e); } catch (e2) { }
      try { renderTabletBridgeSetup(tabletBridge.info); } catch (e3) { }
    });
  }, 16);
}

function tabletBridgePushEvent(what, a, b, c, d) {
  const api = activeBridgeApi();
  if (!tabletGuestOpen() || !api) return;
  try {
    if (what === 'tick') {
      api.sendEvent({ type: 'tick', num: a, word: !!b, progress: c, chip: d || 'Smile!' });
    } else if (what === 'flash') {
      api.sendEvent({ type: 'flash' });
    } else if (what === 'screenflash') {
      api.sendEvent({ type: 'screenflash', on: !!a });
    } else if (what === 'camera') {
      tabletBridgeSync();
    } else if (what === 'review') {
      // The photo just taken (or the whole strip) is shown on the booth screen: show it on the tablet too.
      tabletBridge.reviewSrc = typeof a === 'string' ? a : '';
      tabletBridgeSync();
    } else if (what === 'reviewEnd') {
      tabletBridge.reviewSrc = '';
      tabletBridgeSync();
    }
  } catch (e) { }
}

function renderTabletBridgeHelperNote(stateKey) {
  const box = document.getElementById('tabletBridgeBox');
  const stEl = document.getElementById('tabletBridgeStatus');
  const qrRow = document.getElementById('tabletBridgeQrRow');
  const actsRow = document.getElementById('tabletBridgeActionsRow');
  const note = document.getElementById('tabletBridgeHelperNote');
  const noteTxt = document.getElementById('tabletBridgeHelperText');
  if (box) box.style.display = (DESKTOP || tabletBridge.webLaptop) ? '' : 'none';
  if (qrRow) qrRow.style.display = 'none';
  if (actsRow) actsRow.style.display = 'none';
  if (note) note.hidden = false;
  if (stEl) {
    stEl.classList.remove('on');
    const txt = stEl.querySelector('span');
    if (txt) {
      txt.textContent = stateKey === 'outdated'
        ? 'Print Helper needs update (v1.1.21+) to pair with the Android tablet'
        : 'Online Web Booth — start Print Helper (or open Desktop App) to show the pairing QR';
    }
  }
  if (noteTxt) {
    noteTxt.innerHTML = stateKey === 'outdated'
      ? 'Your running <b>photobooth4u Print Helper</b> is an older version without Tablet Bridge. Download the latest <b>Print Helper (v1.1.21+)</b> or open the <b>Desktop App</b>, then keep the laptop &amp; tablet on the same Wi-Fi.'
      : 'To connect an Android / Huawei tablet while using the <b>online website</b>, start <b>photobooth4u Print Helper (v1.1.21+)</b> on this laptop (same Wi-Fi as the tablet) — or use the <b>photobooth4u Desktop App</b>. Tap <b>?</b> above for the step-by-step guide.';
  }
}

function renderTabletBridgeSetup(info) {
  if (!info) return;
  const wasCam = tabletBridge.camConnected;
  const wasGuest = tabletBridge.guestConnected;
  const wasFacing = tabletBridge.facing;
  const wasW = tabletBridge.width || 0;
  const wasH = tabletBridge.height || 0;
  tabletBridge.info = info;
  tabletBridge.port = info.port || 0;
  tabletBridge.connected = !!info.connected;
  tabletBridge.camConnected = !!info.camConnected;
  tabletBridge.guestConnected = !!info.guestConnected;
  tabletBridge.deviceName = info.deviceName || '';
  tabletBridge.facing = info.facing || 'front';
  tabletBridge.width = Number(info.width) || 0;
  tabletBridge.height = Number(info.height) || 0;

  const box = document.getElementById('tabletBridgeBox');
  const stEl = document.getElementById('tabletBridgeStatus');
  const qrEl = document.getElementById('tabletBridgeQr');
  const qrRow = document.getElementById('tabletBridgeQrRow');
  const actsRow = document.getElementById('tabletBridgeActionsRow');
  const note = document.getElementById('tabletBridgeHelperNote');
  const urlEl = document.getElementById('tabletBridgeUrl');
  const flipBtn = document.getElementById('tabletBridgeFlipBtn');
  if (box) box.style.display = (DESKTOP || tabletBridge.webLaptop) ? '' : 'none';
  if (qrRow) qrRow.style.display = 'flex';
  if (actsRow) actsRow.style.display = 'flex';
  if (note) note.hidden = true;
  if (stEl) {
    stEl.classList.toggle('on', !!info.connected);
    const txt = stEl.querySelector('span');
    if (txt) {
      const modeTag = tabletBridge.mode === 'helper' ? ' · via Print Helper' : '';
      if (info.camConnected && info.guestConnected) txt.textContent = 'Connected: ' + (info.deviceName || 'Tablet') + ' (Guest Screen + Camera ready)' + (info.via ? ' \u00b7 over ' + info.via.kind + ' (' + info.via.ip + ')' : '') + modeTag;
      else if (info.guestConnected) txt.textContent = 'Guest Screen connected (waiting for camera…)' + modeTag;
      else if (info.camConnected) txt.textContent = 'Camera connected: ' + (info.deviceName || 'Tablet') + modeTag;
      else txt.textContent = 'Not paired yet — scan QR inside the tablet app' + modeTag;
      // Say so when the booth could not build the tablet's screen, instead of leaving it to look like a tablet that is simply slow.
      if (tabletBridge.lastError && info.guestConnected) txt.textContent += ' \u00b7 the tablet screen could not be updated: ' + tabletBridge.lastError;
    }
  }
  if (urlEl) {
    const lines = [];
    if (info.primaryUrl) lines.push(info.primaryUrl);
    if (info.addresses && info.addresses.length > 1) {
      lines.push('Other addresses: ' + info.addresses.slice(1, 3).map(a => a.kind + ': ' + a.url).join(' · '));
    }
    if (info.adbUrl) lines.push('USB ADB: ' + info.adbUrl);
    urlEl.textContent = lines.join('\n') || 'Starting local server…';
  }
  if (qrEl && info.primaryUrl && typeof qrcode === 'function') {
    const extras = (info.addresses || []).map(a => a.url)
      .concat(info.adbUrl ? [info.adbUrl] : [])
      .filter((u, idx, arr) => u && u !== info.primaryUrl && arr.indexOf(u) === idx);
    const qrPayload = JSON.stringify({
      app: 'pb4u-bridge',
      url: info.primaryUrl,
      urls: extras
    });
    if (qrEl.dataset.sig !== qrPayload) {
      qrEl.dataset.sig = qrPayload;
      try {
        const q = qrcode(0, 'M');
        q.addData(qrPayload);
        q.make();
        qrEl.src = q.createDataURL(5, 2);
      } catch (e) { }
    }
  }
  if (flipBtn) {
    flipBtn.disabled = !info.camConnected;
    flipBtn.textContent = 'Flip tablet camera (' + (info.facing === 'back' ? 'Rear' : 'Front') + ')';
  }
  const useCamBtn = document.getElementById('tabletBridgeUseCamBtn');
  if (useCamBtn) useCamBtn.disabled = !info.camConnected;

  if (wasCam !== tabletBridge.camConnected) {
    if (tabletBridge.camConnected) {
      // Do not wait for the system's camera list first: on some laptops it never answers (a virtual camera such as Camo or
      // EOS Webcam Utility), and the tablet camera never started. Put the tablet in the menu and start it right away.
      try {
        tabletEnsureOption();
        if (currentDeviceId !== TABLET_CAM_ID) {
          const saved = savedCamera();
          if ((saved && saved.id === TABLET_CAM_ID) || !streamActive || tabletBridge.wasUsingCam) {
            tabletBridge.wasUsingCam = true;
            cameraSelect.value = TABLET_CAM_ID;
            initCamera(TABLET_CAM_ID);
          }
        }
      } catch (e) { }
    } else if (currentDeviceId === TABLET_CAM_ID) {
      // Remember that the tablet camera was active so a brief Wi-Fi drop auto-reclaims it on reconnect.
      tabletBridge.wasUsingCam = true;
    }
    // Then fill in the rest of the list (and drop the tablet from it when it goes away) once the system answers.
    enumerateCameras().catch(() => { });
  }
  if (wasGuest !== tabletBridge.guestConnected) {
    try { updateGuestStatus(); } catch (e) { }
    try { if (typeof applyStageAspect === 'function') applyStageAspect(); else if (typeof updateFullStage === 'function') updateFullStage(); } catch (e) { }
    if (tabletBridge.guestConnected) {
      tabletBridgeSync();
      tabletSoundSync(true);      // a tablet that just connected gets the sound files
    } else {
      syncRemoteFrameToBridge(false, false);
      tabletBridge.soundOk = false;
      tabletBridge.soundSig = '';
      // The tablet is gone: the laptop speaks again until a tablet reports its voices.
      tabletBridge.voiceOk = false;
      tabletBridge.voices = { en: [], fil: [] };
      try { if (typeof refreshFxUI === 'function') refreshFxUI(); } catch (e) { }
    }
  }
  if (wasFacing !== tabletBridge.facing) {
    // The tablet camera was flipped (front <-> rear): the menu name and Mirror "Auto" follow it, and the tablet's screen hears about it.
    try {
      const opt = Array.from(cameraSelect.options).find((o) => o.value === TABLET_CAM_ID);
      if (opt) opt.textContent = tabletCamOptionLabel();
      if (currentDeviceId === TABLET_CAM_ID) applyMirror();
    } catch (e) { }
  }
  if (tabletBridge.camConnected && tabletBridge.width > 0 && tabletBridge.height > 0 && ((wasW > 0 && wasH > 0 && (wasW > wasH) !== (tabletBridge.width > tabletBridge.height)) || wasW === 0)) {
    try { if (typeof applyStageAspect === 'function') applyStageAspect(); } catch (e) { }
  }
}

(function initTabletBridgeClient() {
  const guideBtn = document.getElementById('tabletBridgeGuideBtn');
  const guideBox = document.getElementById('tabletBridgeGuide');
  if (guideBtn && guideBox) {
    guideBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = guideBox.hidden;
      guideBox.hidden = !open;
      guideBtn.classList.toggle('open', open);
      guideBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  const isDesktop = !!(DESKTOP && window.pb4u && window.pb4u.bridge);
  const isTabletOrRemote = (typeof TABLET_LOCAL !== 'undefined' && TABLET_LOCAL) || (typeof LANREMOTE !== 'undefined' && LANREMOTE);
  const isMobile = typeof isMobileOS === 'function' && isMobileOS();
  const isWebLaptop = !isDesktop && !isTabletOrRemote && !isMobile;
  if (!isDesktop && !isWebLaptop) return;

  function handleAction(act) {
    if (!act || !act.action) return;
    const api = activeBridgeApi();
    const a = act.action;
    if (a === 'voiceCaps') { tabletVoiceCaps(act); return; }
    if (a === 'soundCaps') { tabletSoundCaps(act); return; }
    if (a === 'viewportCaps') {
      const vw = Math.round(Number(act.vw) || 0), vh = Math.round(Number(act.vh) || 0);
      if (vw > 0 && vh > 0) {
        const prev = tabletBridge.viewport;
        const prevAr = prev && prev.vh ? (prev.vw / prev.vh) : 0;
        const nextAr = vw / vh;
        tabletBridge.viewport = { vw, vh };
        if (act.init) {
          tabletSoundSync(true);
          tabletBridgeSync();
        } else if (!prev || Math.abs(prevAr - nextAr) > 0.015) {
          tabletBridgeSync();
        }
      } else if (act.init) {
        tabletSoundSync(true);
        tabletBridgeSync();
      }
      return;
    }
    if (a === 'trigger') { boothTrigger(true); return; }
    if (a === 'readyStart') { if (readyStartBtn) readyStartBtn.click(); return; }
    if (a === 'pickLayout' && act.key) { if (pickOpen) finishPick(act.key); return; }
    if (a === 'pickBack') { if (pickOpen && pickBackAllowed) finishPick('__back__'); return; }
    if (a === 'pickLook' && act.key) { guestPickLook(act.key); return; }
    if (a === 'toggleLooks') { guestLookOpen = !guestLookOpen; guestRender(); return; }
    if (a === 'retake') { if (retakeBtn && !retakeBtn.hidden) retakeBtn.click(); return; }
    if (a === 'done') { if (doneBtn && !doneBtn.hidden) doneBtn.click(); return; }
    if (a === 'retakeIndex') {
      const fr = filmTrack && filmTrack.querySelector('.film-frame[data-i="' + Number(act.index) + '"]');
      if (fr) fr.click();
      return;
    }
    if (a === 'nextGuest') {
      if (state === 'result' && typeof resetForNextGuest === 'function') resetForNextGuest();
      return;
    }
    if (a === 'print') {
      if (state !== 'result' || printing) return;
      if (typeof noPrintSession === 'function' && noPrintSession()) {
        if (api) api.sendEvent({ type: 'toast', msg: 'Softcopy only — scan QR to save.' });
        return;
      }
      const max = printSize ? maxCopies(printSize) : 0;
      if (max < 1) {
        if (api) api.sendEvent({ type: 'toast', msg: 'Print limit reached.' });
        return;
      }
      const copies = Math.max(1, Math.min(max, Number(act.copies) || printPrefs.copies || 1));
      printCurrentPhoto(false, copies);
      return;
    }
    if (a === 'switchCam') {
      if (api) api.camCmd({ type: 'switchCam' });
    }
  }

  if (isDesktop) {
    tabletBridge.mode = 'desktop';
    tabletBridge.api = window.pb4u.bridge;
    const api = window.pb4u.bridge;
    const refreshInfo = () => api.info().then(renderTabletBridgeSetup).catch(() => { });
    refreshInfo();
    setInterval(refreshInfo, 10000);
    api.onStatus(renderTabletBridgeSetup);
    api.onAction(handleAction);
  } else {
    // Online Web Booth on a laptop: connect to the local Tablet Bridge inside photobooth4u Print Helper (127.0.0.1:17321).
    tabletBridge.webLaptop = true;
    let pollActive = false;
    let pollSeq = 0;

    const helperApi = {
      info: () => fetch(HELPER_BRIDGE_BASE + '/info', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)),
      renew: () => fetch(HELPER_BRIDGE_BASE + '/renew', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
      pushState: (st) => fetch(HELPER_BRIDGE_BASE + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(st || {}) }).catch(() => { }),
      sendEvent: (ev) => fetch(HELPER_BRIDGE_BASE + '/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev || {}) }).catch(() => { }),
      camCmd: (cmd) => fetch(HELPER_BRIDGE_BASE + '/cam-cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd || {}) }).catch(() => { })
    };

    function markHelperDown(stateKey) {
      const wasActive = tabletBridge.mode === 'helper';
      pollActive = false;
      tabletBridge.mode = '';
      tabletBridge.api = null;
      tabletBridge.helperState = stateKey;
      if (wasActive) {
        renderTabletBridgeSetup({ port: 0, connected: false, camConnected: false, guestConnected: false, addresses: [] });
      }
      renderTabletBridgeHelperNote(stateKey);
    }

    async function runHelperPoll() {
      if (pollActive) return;
      pollActive = true;
      let fails = 0;
      while (pollActive && tabletBridge.mode === 'helper') {
        try {
          const r = await fetch(HELPER_BRIDGE_BASE + '/poll?after=' + pollSeq + '&wait=15000', {
            cache: 'no-store',
            signal: AbortSignal.timeout(20000)
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          fails = 0;
          if (typeof j.seq === 'number') pollSeq = j.seq;
          if (j.info) renderTabletBridgeSetup(j.info);
          if (Array.isArray(j.actions)) {
            j.actions.forEach((act) => { try { handleAction(act); } catch (e) { } });
          }
        } catch (e) {
          if (++fails >= 3) {
            markHelperDown('missing');
            return;
          }
          await wait(1200);
        }
      }
    }

    async function probeHelperBridge(manual) {
      let r = null, j = null;
      try {
        r = await fetch(HELPER_BRIDGE_BASE + '/info', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
        if (r.ok) j = await r.json();
      } catch (e) { r = null; }
      if (j && j.ok && j.port) {
        tabletBridge.mode = 'helper';
        tabletBridge.api = helperApi;
        tabletBridge.helperState = 'ready';
        if (typeof j.seq === 'number') pollSeq = j.seq;
        try { renderTabletBridgeSetup(j); } catch (e) { }
        runHelperPoll();
        if (manual) showToast('Tablet Bridge ready via Print Helper ✓', 3000);
        return;
      }
      if (r && r.status === 404) {
        markHelperDown('outdated');
        if (manual) showToast('Update Print Helper to v1.1.21+ for Tablet Bridge.', 4500);
        return;
      }
      markHelperDown('missing');
      if (manual) showToast('Print Helper not detected on this laptop yet.', 3500);
    }

    renderTabletBridgeHelperNote('missing');
    probeHelperBridge(false);
    setInterval(() => {
      if (tabletBridge.mode === 'helper') {
        helperApi.info().then((j) => { if (j && j.ok) renderTabletBridgeSetup(j); }).catch(() => { });
      } else {
        probeHelperBridge(false);
      }
    }, 10000);

    const retryBtn = document.getElementById('tabletBridgeRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      probeHelperBridge(true).finally(() => { retryBtn.disabled = false; });
    });
  }

  const copyBtn = document.getElementById('tabletBridgeCopyBtn');
  const renewBtn = document.getElementById('tabletBridgeRenewBtn');
  const flipBtn = document.getElementById('tabletBridgeFlipBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const u = tabletBridge.info && tabletBridge.info.primaryUrl;
    if (!u) return;
    if (window.pb4u && window.pb4u.copy) { window.pb4u.copy(u); showToast('Tablet bridge address copied.'); }
    else if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(u).then(() => showToast('Tablet bridge address copied.')).catch(() => { });
    } else {
      try {
        const ta = document.createElement('textarea');
        ta.value = u;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Tablet bridge address copied.');
      } catch (e) { }
    }
  });
  if (renewBtn) renewBtn.addEventListener('click', () => {
    const api = activeBridgeApi();
    if (api && api.renew) api.renew().then((i) => { renderTabletBridgeSetup(i); showToast('New tablet pairing QR created.'); }).catch(() => { });
  });
  if (flipBtn) flipBtn.addEventListener('click', () => {
    const api = activeBridgeApi();
    if (api && api.camCmd) api.camCmd({ type: 'switchCam' });
  });

  // A way to pick the tablet camera by hand. The Camera menu hides itself when there is only one choice (a laptop with no
  // webcam), so if the automatic pick in renderTabletBridgeSetup() did not happen there was no way to choose it.
  if (flipBtn && flipBtn.parentNode && !document.getElementById('tabletBridgeUseCamBtn')) {
    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = 'action-btn';
    useBtn.id = 'tabletBridgeUseCamBtn';
    useBtn.style.cssText = 'width:auto; margin:0;';
    useBtn.textContent = 'Use tablet camera';
    useBtn.disabled = !tabletBridge.camConnected;
    flipBtn.parentNode.insertBefore(useBtn, flipBtn);
    useBtn.addEventListener('click', async () => {
      if (!tabletCamAvailable()) { showToast('The tablet camera is not connected yet. Open the bridge on the tablet first.', 5000); return; }
      useBtn.disabled = true;
      try {
        // No waiting for the system's camera list: it can hang on some laptops, and the tablet camera does not need it.
        tabletEnsureOption();
        cameraSelect.value = TABLET_CAM_ID;
        const ok = await Promise.race([initCamera(TABLET_CAM_ID), new Promise(res => setTimeout(() => res('slow'), 15000))]);
        try { saveCamera(); } catch (e) { }
        showToast(ok === 'slow' ? 'The tablet camera is taking a long time to start. Check the tablet is still on the bridge screen.'
          : ok ? 'Using the tablet camera.' : 'The tablet camera did not start. Check the tablet is still on the bridge screen.', 5000);
        try { enumerateCameras().catch(() => { }); } catch (e) { }
      } catch (e) {
        showToast('Tablet camera error: ' + ((e && e.message) || e), 6000);
      } finally {
        useBtn.disabled = !tabletBridge.camConnected;
      }
    });
  }
})();
