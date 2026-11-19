// ---- Tablet Guest Screen + Camera Bridge (Android / Huawei MatePad Pro) ----
// These are `var` on purpose, not const/let. This file is pasted in the middle of the booth script, but guestRender() and
// the camera-list code run earlier, during start-up, and they call tabletGuestOpen() / tabletCamAvailable() and use
// `typeof TABLET_CAM_ID`. A const/let that is not set yet throws "Cannot access ... before initialization" on the laptop
// app (DESKTOP is true there), which stops the whole booth script and leaves "Tap to start" with no click handler (1.1.73).
var TABLET_CAM_ID = 'tablet-bridge';
var tabletBridge = {
  info: null,
  port: 0,
  connected: false,
  camConnected: false,
  guestConnected: false,
  deviceName: '',
  facing: 'front',
  stream: null,
  pumpStop: null,
  bgTimer: null,
  mediaSigs: Object.create(null),
  mediaUrls: Object.create(null),
  mediaUploading: Object.create(null),
  syncQueued: false
};

function tabletGuestOpen() { return !!(DESKTOP && tabletBridge && tabletBridge.guestConnected); }
function tabletCamAvailable() { return !!(DESKTOP && tabletBridge && tabletBridge.camConnected && tabletBridge.port); }
function tabletCamOptionLabel() {
  const nm = tabletBridge.deviceName || 'Tablet';
  const side = tabletBridge.facing === 'back' ? 'Rear' : 'Front';
  return 'Tablet Camera · ' + nm + ' (' + side + ')';
}

async function tabletBridgeUploadMedia(slot, srcUrl, mime, maxDim) {
  if (!tabletBridge.port || !srcUrl) return '';
  const sig = String(srcUrl).slice(0, 120) + ':' + String(srcUrl).length;
  if (tabletBridge.mediaSigs[slot] === sig && tabletBridge.mediaUrls[slot]) {
    return tabletBridge.mediaUrls[slot];
  }
  if (tabletBridge.mediaUploading[slot] === sig) return tabletBridge.mediaUrls[slot] || '';
  tabletBridge.mediaUploading[slot] = sig;
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
    const resp = await fetch('http://127.0.0.1:' + tabletBridge.port + '/bridge-local/media/' + encodeURIComponent(slot), {
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
  finally { delete tabletBridge.mediaUploading[slot]; }
  return tabletBridge.mediaUrls[slot] || '';
}

function openTabletCameraStream() {
  if (!tabletCamAvailable()) throw new Error('Tablet camera is not connected');
  if (tabletBridge.pumpStop) { try { tabletBridge.pumpStop(); } catch (e) { } tabletBridge.pumpStop = null; }
  const port = tabletBridge.port;
  const canvas = document.createElement('canvas');
  canvas.width = (tabletBridge.info && tabletBridge.info.width) || 1280;
  canvas.height = (tabletBridge.info && tabletBridge.info.height) || 960;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(24);
  const track = stream.getVideoTracks()[0];
  let alive = true, seq = 0, fails = 0;
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
  try { window.pb4u.bridge.camCmd({ type: 'live', on: true }); } catch (e) { }

  (async function pump() {
    while (alive) {
      if (!tabletBridge.camConnected) {
        stopAll();
        try { track.dispatchEvent(new Event('ended')); } catch (e) { }
        return;
      }
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/bridge-local/frame?after=' + seq + '&wait=900', {
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
        if (++fails > 25 || !tabletBridge.camConnected) {
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
  if (!tabletCamAvailable()) return;
  const shots = shotCanvases;
  try {
    const r = await fetch('http://127.0.0.1:' + tabletBridge.port + '/bridge-local/capture', {
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
  if (!result) return { printShow: false, nextShow: false };
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
            if (!b || !tabletBridge.port) { tabletBridge.bgSending = false; return; }
            fetch('http://127.0.0.1:' + tabletBridge.port + '/bridge-local/media/remoteFrame', {
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
  if (!tabletGuestOpen() || !(window.pb4u && window.pb4u.bridge)) return;
  const psMode = guestWelcomeStyle !== 'panel';
  const ready = readyOverlay.classList.contains('ready-active');
  const result = state === 'result' && shotCanvases.every(Boolean);
  const reviewing = !!(sess && (sess.reviewing || sess.decorating));
  const welcome = welcomeOn && state === 'idle' && !pickOpen && !ready &&
    (!!welcomeDataUrl || (attractMode === 'poster' && !!(attractPlaylist.length || attractPosterUrl)));
  const bgActive = !!(typeof bgGuestStream === 'function' && bgGuestStream());
  const filterCss = liveFilterCss();
  const useRemoteStream = (bgActive || (!!filterCss && currentDeviceId === TABLET_CAM_ID) || (currentDeviceId !== TABLET_CAM_ID)) && !result && !reviewing && (!welcome || attractMode === 'camera');

  syncRemoteFrameToBridge(useRemoteStream, bgActive);

  let resSrc = '', resFit = 'contain';
  if (sess && sess.decorating) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.85), 'image/jpeg', 1600);
  } else if (result) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.9), 'image/jpeg', 1800);
  } else if (reviewing) {
    resSrc = await tabletBridgeUploadMedia('result', previewCanvas.toDataURL('image/jpeg', 0.85), 'image/jpeg', 1600);
  } else if (welcome && attractMode !== 'video') {
    const slideList = attractPlaylist.length ? attractPlaylist : (attractPosterUrl ? [{ url: attractPosterUrl, type: attractPosterType }] : []);
    const curSlide = (attractMode === 'poster' && slideList.length) ? (slideList[attractPlayIndex] || slideList[0]) : null;
    const rawWel = (curSlide && !welcomeBtnOn && !(typeof brandImgFor === 'function' && brandImgFor('w'))) ? curSlide.url : welcomeDataUrl;
    if (rawWel) {
      resSrc = await tabletBridgeUploadMedia('welcome', rawWel, 'image/jpeg', 1920);
      resFit = (attractMode === 'poster') ? (attractPosterFit === 'contain' ? 'contain' : (attractPosterFit === 'stretch' ? 'fill' : 'cover')) : 'cover';
    }
  }

  let layouts = [];
  if (pickOpen) {
    layouts = await Promise.all(pickKeys.map(async (k, i) => {
      let rawThumb = '';
      let nm = '';
      let sh = '';
      if (pickDesignMode) {
        const srcBtn = pickGrid.children[i];
        const nmEl = srcBtn && srcBtn.querySelector('.pick-name');
        const shEl = srcBtn && srcBtn.querySelector('.pick-shots');
        rawThumb = (srcBtn && srcBtn.querySelector('img') && srcBtn.querySelector('img').src) || '';
        nm = (nmEl && nmEl.textContent) || (pickDesignsList[i] && pickDesignsList[i].name) || ('Design ' + (i + 1));
        sh = (shEl && shEl.textContent) || 'Ready';
      } else {
        rawThumb = layoutThumbUrl(k);
        nm = pickName(k);
        const isFr = /^frame:/.test(k), isPr = /^sheet:/.test(k);
        const fObj = isFr && typeof frameById === 'function' ? frameById(k.slice(6)) : null;
        const prObj = isPr && typeof presetById === 'function' ? presetById(k.slice(6)) : null;
        const nShots = isFr ? frameShotCount(fObj) : (isPr ? presetShotCount(prObj) : (LAYOUT_DEFS[k] ? LAYOUT_DEFS[k].shots : 4));
        sh = nShots + (nShots === 1 ? ' shot' : ' shots');
      }
      const thumb = rawThumb ? await tabletBridgeUploadMedia('lay_' + i + '_' + k.replace(/[^A-Za-z0-9_-]/g, '_'), rawThumb, 'image/png', 480) : '';
      return { k, name: nm, shots: sh, thumb };
    }));
  }

  const slots = [...qrResults.querySelectorAll('.qr-result')];
  const showQr = result && slots.length > 0 && !printFirstHolding;
  const qrs = showQr ? slots.map(sl => {
    const im = sl.querySelector('.qr-img');
    return {
      kind: sl.dataset.kind || '',
      src: im ? im.src : '',
      wait: (sl.querySelector('.qr-wait') || {}).textContent || 'One moment…',
      label: (sl.querySelector('.qr-caption') || {}).textContent || ''
    };
  }) : [];

  const shots = shotCanvases.map((shot, i) => {
    const mf = filmTrack.children[i];
    return {
      src: shot ? shotThumb(shot) : '',
      pick: !!(mf && mf.classList.contains('pickable')),
      sel: !!(mf && mf.classList.contains('picked'))
    };
  });

  let msg = 'Tap to start', sub = '', chip = 'Ready';
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

  let ga = 1.3333;
  try {
    const box = layoutBoxAspect();
    ga = (typeof camAspect === 'function') ? camAspect() : box;
  } catch (e) { }

  const looksShow = !!(guestLooksOn && isTraditional() && !pickOpen && (ready || state === 'idle') && !(sess && sess.reviewing));
  const looks = looksShow ? guestLookKeys().map(k => ({ k, label: FILTER_LABELS[k] || k })) : [];
  const galleryIdle = !psMode && state === 'idle' && !pickOpen && !ready && !!currentFolderLink && !gvPrivate();
  const printState = tabletGuestPrintState();

  const payload = Object.assign({
    psMode,
    isResult: result,
    showQr,
    qrs,
    ga: Number(ga.toFixed(4)),
    wa: welcomeGeo ? Number((welcomeGeo.W / welcomeGeo.H).toFixed(4)) : 1.3333,
    boxAspect: Number((layoutBoxAspect() || 0.8).toFixed(4)),
    welFull: !!(welcome && !psMode && welcomeGeo && guestWelcomeStyle !== 'panel'),
    welFullPs: !!(psMode && welcome),
    hideCam: !!(result || reviewing || (welcome && attractMode !== 'camera')),
    useRemoteStream: !!useRemoteStream,
    remoteMirror: !!(mirrorPreview() && !bgActive),
    mirror: !!mirrorPreview(),
    filterCss: filterCss || '',
    resSrc,
    resFit,
    ev: (labelInput.value || '').trim(),
    dt: currentDateLabel(),
    msg, sub, chip,
    countingDown: !!(state === 'capturing' && countingDown),
    showReady: !!(psMode && ready && !pickOpen),
    readySub: readySub ? readySub.textContent : '',
    readyBtn: readyOverlay.classList.contains('hands') ? (fx.hands === 'smile' ? 'Smile to start' : 'Wave to start') : 'Start',
    pickOpen: !!pickOpen,
    pickIdx,
    pickTitle: pickOpen ? pickTitleText() : '',
    pickSub: pickDesignMode ? 'Pick a design or frame first' : 'Tap a layout to start your session',
    layouts,
    looksShow,
    looksOpen: !!guestLookOpen,
    lookKey: filterKey,
    lookLabel: FILTER_LABELS[filterKey] || filterKey,
    looks,
    shots,
    retakeShow: !!(sess && !retakeBtn.hidden),
    retakeText: retakeBtn.textContent || 'Retake',
    doneShow: !!(sess && !doneBtn.hidden),
    doneText: doneBtn.textContent || 'Done',
    galleryShow: galleryIdle,
    galleryQr: galleryIdle ? (document.getElementById('galleryPopQr').src || '') : ''
  }, printState);

  try { window.pb4u.bridge.pushState(payload); } catch (e) { }
}

function tabletBridgeSync() {
  if (!tabletGuestOpen() || tabletBridge.syncQueued) return;
  tabletBridge.syncQueued = true;
  setTimeout(() => {
    tabletBridge.syncQueued = false;
    buildAndPushTabletState().catch(() => { });
  }, 16);
}

function tabletBridgePushEvent(what, a, b, c, d) {
  if (!tabletGuestOpen() || !(window.pb4u && window.pb4u.bridge)) return;
  try {
    if (what === 'tick') {
      window.pb4u.bridge.sendEvent({ type: 'tick', num: a, word: !!b, progress: c, chip: d || 'Smile!' });
    } else if (what === 'flash') {
      window.pb4u.bridge.sendEvent({ type: 'flash' });
    } else if (what === 'screenflash') {
      window.pb4u.bridge.sendEvent({ type: 'screenflash', on: !!a });
    } else if (what === 'camera') {
      tabletBridgeSync();
    }
  } catch (e) { }
}

function renderTabletBridgeSetup(info) {
  if (!info) return;
  const wasCam = tabletBridge.camConnected;
  const wasGuest = tabletBridge.guestConnected;
  tabletBridge.info = info;
  tabletBridge.port = info.port || 0;
  tabletBridge.connected = !!info.connected;
  tabletBridge.camConnected = !!info.camConnected;
  tabletBridge.guestConnected = !!info.guestConnected;
  tabletBridge.deviceName = info.deviceName || '';
  tabletBridge.facing = info.facing || 'front';

  const box = document.getElementById('tabletBridgeBox');
  const stEl = document.getElementById('tabletBridgeStatus');
  const qrEl = document.getElementById('tabletBridgeQr');
  const urlEl = document.getElementById('tabletBridgeUrl');
  const flipBtn = document.getElementById('tabletBridgeFlipBtn');
  if (box) box.style.display = DESKTOP ? '' : 'none';
  if (stEl) {
    stEl.classList.toggle('on', !!info.connected);
    const txt = stEl.querySelector('span');
    if (txt) {
      if (info.camConnected && info.guestConnected) txt.textContent = 'Connected: ' + (info.deviceName || 'Tablet') + ' (Guest Screen + Camera ready)';
      else if (info.guestConnected) txt.textContent = 'Guest Screen connected (waiting for camera…)';
      else if (info.camConnected) txt.textContent = 'Camera connected: ' + (info.deviceName || 'Tablet');
      else txt.textContent = 'Not paired yet — scan QR inside the tablet app';
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
    const qrPayload = JSON.stringify({
      app: 'pb4u-bridge',
      url: info.primaryUrl,
      urls: (info.addresses || []).map(a => a.url).concat(info.adbUrl ? [info.adbUrl] : [])
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

  if (wasCam !== tabletBridge.camConnected) {
    enumerateCameras().then(() => {
      if (tabletBridge.camConnected && currentDeviceId !== TABLET_CAM_ID) {
        const saved = savedCamera();
        if (saved && saved.id === TABLET_CAM_ID) {
          cameraSelect.value = TABLET_CAM_ID;
          initCamera(TABLET_CAM_ID);
        } else if (!streamActive) {
          cameraSelect.value = TABLET_CAM_ID;
          initCamera(TABLET_CAM_ID);
        }
      }
    }).catch(() => { });
  }
  if (wasGuest !== tabletBridge.guestConnected) {
    try { updateGuestStatus(); } catch (e) { }
    try { updateFullStage(); } catch (e) { }
    if (tabletBridge.guestConnected) {
      tabletBridgeSync();
    } else {
      syncRemoteFrameToBridge(false, false);
    }
  }
}

(function initTabletBridgeClient() {
  if (!DESKTOP || !(window.pb4u && window.pb4u.bridge)) return;
  const api = window.pb4u.bridge;
  const refreshInfo = () => api.info().then(renderTabletBridgeSetup).catch(() => { });
  refreshInfo();
  setInterval(refreshInfo, 10000);
  api.onStatus(renderTabletBridgeSetup);
  api.onAction((act) => {
    if (!act || !act.action) return;
    const a = act.action;
    if (a === 'trigger') { boothTrigger(true); return; }
    if (a === 'readyStart') { if (readyStartBtn) readyStartBtn.click(); return; }
    if (a === 'pickLayout' && act.key) { if (pickOpen) finishPick(act.key); return; }
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
        api.sendEvent({ type: 'toast', msg: 'Softcopy only — scan QR to save.' });
        return;
      }
      const max = printSize ? maxCopies(printSize) : 0;
      if (max < 1) {
        api.sendEvent({ type: 'toast', msg: 'Print limit reached.' });
        return;
      }
      const copies = Math.max(1, Math.min(max, Number(act.copies) || printPrefs.copies || 1));
      printCurrentPhoto(false, copies);
      return;
    }
    if (a === 'switchCam') {
      api.camCmd({ type: 'switchCam' });
    }
  });

  const copyBtn = document.getElementById('tabletBridgeCopyBtn');
  const renewBtn = document.getElementById('tabletBridgeRenewBtn');
  const flipBtn = document.getElementById('tabletBridgeFlipBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const u = tabletBridge.info && tabletBridge.info.primaryUrl;
    if (u && window.pb4u.copy) { window.pb4u.copy(u); showToast('Tablet bridge address copied.'); }
  });
  if (renewBtn) renewBtn.addEventListener('click', () => {
    api.renew().then((i) => { renderTabletBridgeSetup(i); showToast('New tablet pairing QR created.'); });
  });
  if (flipBtn) flipBtn.addEventListener('click', () => {
    api.camCmd({ type: 'switchCam' });
  });
})();
