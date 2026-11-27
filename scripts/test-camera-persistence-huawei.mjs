// Behaviour tests for camera selection stickiness & Huawei MatePad / HarmonyOS WebView stability.
// Run: node scripts/test-camera-persistence-huawei.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
};
const testAsync = async (name, fn) => {
  try { await fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
};

function pageFunction(name) {
  const lines = page.split('\n');
  const a = lines.findIndex(l => l.startsWith('      function ' + name + '(') || l.startsWith('      async function ' + name + '('));
  assert(a >= 0, name + ' not found in protected/booth.html');
  let b = a;
  while (b < lines.length && !/^      }\s*$/.test(lines[b])) b++;
  return lines.slice(a, b + 1).join('\n');
}

function makeSelect() {
  const opts = [];
  let selectedVal = '';
  const sel = {
    options: opts,
    style: {},
    dataset: {},
    appendChild(opt) {
      opts.push(opt);
      if (opts.length === 1) selectedVal = opt.value;
    },
    get innerHTML() { return ''; },
    set innerHTML(v) { if (v === '') { opts.length = 0; selectedVal = ''; } },
    get selectedIndex() {
      const idx = opts.findIndex(o => o.value === selectedVal);
      return idx >= 0 ? idx : (opts.length ? 0 : -1);
    },
    get value() {
      const i = this.selectedIndex;
      return i >= 0 ? opts[i].value : '';
    },
    set value(v) {
      if (opts.some(o => o.value === v)) selectedVal = v;
    },
  };
  return sel;
}

function makeVideo(visible = true) {
  const listeners = new Map();
  return {
    srcObject: null,
    videoWidth: 0,
    videoHeight: 0,
    paused: false,
    offsetParent: visible ? {} : null,
    style: {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) {
      if (listeners.has(ev)) listeners.get(ev).delete(fn);
    },
    emit(ev) {
      if (listeners.has(ev)) for (const fn of Array.from(listeners.get(ev))) fn();
    },
  };
}

function makeHarness(cfg = {}) {
  const ls = new Map();
  let nativePref = cfg.nativePref || '';
  let enumDevs = cfg.devices || [];
  const gumCalls = [];
  const logs = [];
  const cameraSelect = makeSelect();
  const video = makeVideo(cfg.videoVisible !== false);
  const scpVideo = makeVideo(!!cfg.scpVisible);
  const cameraError = { style: { display: 'none' } };
  const cameraErrorText = { textContent: '' };
  const recDot = { style: { display: 'none' } };
  const cameraSection = { classList: { remove() { }, add() { } } };

  const sb = {
    console, Math, Object, Array, Map, Set, Promise, Date, String, Number, JSON, RegExp, Error,
    setTimeout, clearTimeout, setInterval, clearInterval,
    IS_ANDROID_APP: cfg.android !== false,
    ANDROID_APP: cfg.android !== false,
    IS_IOS_APP: !!cfg.ios,
    DESKTOP: !!cfg.desktop,
    USB_MAC: false,
    USB_CAM_ID: 'usb-remote',
    UVC_ID: 'pb-uvc-webcam',
    CAM_PREF_KEY: 'pb4u.camera',
    EMPTY_CAM_PREFIX: 'pb-cam-idx:',
    currentDeviceId: null,
    currentStream: null,
    streamActive: false,
    camSleeping: false,
    camWaking: null,
    camUserPickedId: '',
    camLabelProbed: false,
    camInitGen: 0,
    camInitInFlight: false,
    camPendingVisibleCheck: false,
    camVisibleVerifyTimer: null,
    reconnectTimer: null,
    muteTimer: null,
    camListHung: false,
    usbBattTimer: null,
    curStep: cfg.curStep || 1,
    tabSetup: { classList: { contains: (c) => c === 'hidden' ? !cfg.inSetup : false } },
    nativeCam: { active: false, devicesById: Object.create(null) },
    usbCam: {
      supported: true,
      viaHelper: cfg.android !== false,
      helperSees: !!cfg.helperSees,
      helperName: cfg.helperName || '',
      active: false,
      camera: null,
      stream: null,
      name: '',
    },
    window: {
      __PBLocal: cfg.android !== false ? {
        getCameraPref: () => nativePref,
        setCameraPref: (j) => { nativePref = j || ''; return true; },
        listAndroidCameras: () => JSON.stringify(cfg.androidCams || [
          { id: '0', facing: 'back' },
          { id: '1', facing: 'front' },
        ]),
      } : null,
      __pbUvcInfo: cfg.uvcInfo || null,
    },
    localStorage: {
      getItem: k => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: k => ls.delete(k),
    },
    document: {
      hidden: false,
      createElement(tag) {
        if (tag === 'option') return { value: '', textContent: '', dataset: {} };
        return { style: {}, dataset: {} };
      },
      getElementById: () => null,
    },
    navigator: {
      platform: 'Linux armv8l',
      userAgent: 'Mozilla/5.0 (Linux; Android 10; AGS6-W09) PB4uAndroid',
      mediaDevices: {
        enumerateDevices: async () => (typeof enumDevs === 'function' ? enumDevs() : enumDevs),
        getUserMedia: async (c) => {
          gumCalls.push(c);
          if (cfg.onGum) return cfg.onGum(c, gumCalls.length);
          const trk = {
            readyState: 'live',
            muted: false,
            stopped: false,
            stop() { this.stopped = true; this.readyState = 'ended'; },
            addEventListener() { },
            getSettings: () => ({ deviceId: (c.video && c.video.deviceId && (c.video.deviceId.exact || c.video.deviceId.ideal)) || 'dev-auto', facingMode: 'user', width: 1280, height: 720 }),
          };
          return { getVideoTracks: () => [trk], getTracks: () => [trk] };
        },
      },
    },
    cameraSelect,
    video,
    scpVideo,
    cameraError,
    cameraErrorText,
    recDot,
    cameraSection,
    wait: () => Promise.resolve(),
    hasNativeCamBridge: () => false,
    nativeCamBypassed: () => false,
    camHelperProbe: async () => sb.usbCam.helperSees,
    usbOptionLabel: () => 'DSLR / Mirrorless camera (USB)',
    usbUnsupportedNote: () => { },
    refreshCamFab: () => { },
    refreshCameraMenu: () => { },
    usbStopLive: () => { },
    usbCamNote: () => { },
    initUsbCamera: async () => false,
    applyMirror: () => { },
    applyLiveFilter: () => { },
    guestCall: () => { },
    listenVideoFrames: () => { },
    showCameraError: (e) => { cameraError.style.display = 'flex'; cameraErrorText.textContent = e && e.name || 'err'; },
    camWantLive: () => true,
    camLiveSleep: () => { },
    webcamGumSize: () => ({ width: { ideal: 1280 }, height: { ideal: 720 } }),
    usbLog: (kind, info) => logs.push({ kind, info }),
    cameraLost: () => { sb._state.cameraLostCalls++; },
  };

  vm.createContext(sb);
  const fns = [
    'isUsbWebcamOption',
    'isBuiltInCamera',
    'nativeAndroidCams',
    'inferCamFacing',
    'savedCamera',
    'writeSavedCamera',
    'saveCamera',
    'matchSavedOption',
    'camSysTimeout',
    'enumerateCameras',
    'watchTrack',
    'openCameraStream',
    'waitForVideoFrame',
    'initCamera',
    'isFrontCamera',
  ];
  vm.runInContext(fns.map(pageFunction).join('\n'), sb);
  sb._state = { ls, gumCalls, logs, cameraLostCalls: 0, getNativePref: () => nativePref, setDevices: (d) => { enumDevs = d; } };
  return sb;
}

await testAsync('Huawei MatePad SE 11": saved Camera 2 sticks across exit/reopen even when labels are empty and deviceIds rotate', async () => {
  // Session 1: Huawei WebView returns blank labels with session-1 hashes
  const h1 = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: 'sess1_back_hash', label: '' },
      { kind: 'videoinput', deviceId: 'sess1_front_hash', label: '' },
    ],
  });
  await h1.enumerateCameras();
  assert.equal(h1.cameraSelect.options.length, 3);
  assert.equal(h1.cameraSelect.options[0].textContent, 'Back camera (Camera 1)');
  assert.equal(h1.cameraSelect.options[1].textContent, 'Front camera (Camera 2)');
  // Operator picks Camera 1 (Back camera) explicitly
  h1.cameraSelect.value = 'sess1_back_hash';
  h1.saveCamera();
  const persistedNative = h1._state.getNativePref();
  assert(persistedNative.includes('sess1_back_hash'), 'native SharedPreferences saved camera');

  // Session 2 (after exit & reopen): localStorage wiped/unflushed AND WebView rotated deviceIds AND labels are still empty
  const h2 = makeHarness({
    nativePref: persistedNative,
    devices: [
      { kind: 'videoinput', deviceId: 'sess2_rotated_0', label: '' },
      { kind: 'videoinput', deviceId: 'sess2_rotated_1', label: '' },
    ],
  });
  await h2.enumerateCameras();
  assert.equal(h2.cameraSelect.value, 'sess2_rotated_0', 'Back camera (Camera 1) must stick across restart');
  assert.notEqual(h2.cameraSelect.value, 'usb-remote', 'must never revert to DSLR / Mirrorless (USB)');
});

await testAsync('Legacy saved { id, label: "Camera 2" } sticks even with rotated IDs and no native Camera2 metadata', async () => {
  const h = makeHarness({
    androidCams: [],
    devices: [
      { kind: 'videoinput', deviceId: 'new_id_0', label: '' },
      { kind: 'videoinput', deviceId: 'new_id_1', label: '' },
    ],
  });
  h.localStorage.setItem('pb4u.camera', JSON.stringify({ id: 'old_id_1', label: 'Camera 2' }));
  await h.enumerateCameras();
  assert.equal(h.cameraSelect.value, 'new_id_1', 'Camera 2 sticks by slot index/label');
});

await testAsync('Empty deviceId from WebView gets synthetic non-empty ID, saves cleanly, and opens via facingMode', async () => {
  const h = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: '', label: '' },
      { kind: 'videoinput', deviceId: '', label: '' },
    ],
  });
  h.camLabelProbed = true; // simulate probe already done with still-blank IDs
  await h.enumerateCameras({ noProbe: true });
  assert.equal(h.cameraSelect.options[0].value, 'pb-cam-idx:0');
  assert.equal(h.cameraSelect.options[1].value, 'pb-cam-idx:1');
  h.cameraSelect.value = 'pb-cam-idx:1';
  h.saveCamera();
  assert(h._state.getNativePref().includes('pb-cam-idx:1'), 'synthetic ID still persists');
  await h.openCameraStream('pb-cam-idx:1');
  const firstCall = h._state.gumCalls[0];
  assert(firstCall && firstCall.video && firstCall.video.facingMode && firstCall.video.facingMode.exact === 'user', 'maps pb-cam-idx:1 (front) to facingMode user');
});

await testAsync('Cold start with temporarily empty videoDevices does NOT lock onto DSLR / Mirrorless camera (USB)', async () => {
  const h = makeHarness({
    devices: [],
    helperSees: false,
  });
  h.localStorage.setItem('pb4u.camera', JSON.stringify({ id: 'old_cam_2', label: 'Front camera (Camera 2)', index: 1, facing: 'front' }));
  await h.enumerateCameras({ noProbe: true });
  assert.equal(h.cameraSelect.value, '', 'uses Waiting for camera placeholder instead of usb-remote');

  // Now tablet cameras finish enumerating
  h._state.setDevices([
    { kind: 'videoinput', deviceId: 'cam_0', label: '' },
    { kind: 'videoinput', deviceId: 'cam_1', label: '' },
  ]);
  await h.enumerateCameras({ noProbe: true });
  assert.equal(h.cameraSelect.value, 'cam_1', 'restores saved Front camera once cameras appear');
});

await testAsync('Saved built-in camera sticks even if USB helper reports a device; saved DSLR sticks too', async () => {
  const h1 = makeHarness({
    helperSees: true,
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
  });
  h1.localStorage.setItem('pb4u.camera', JSON.stringify({ id: 'cam_1', label: 'Front camera (Camera 2)', index: 1, facing: 'front' }));
  await h1.enumerateCameras({ noProbe: true });
  assert.equal(h1.cameraSelect.value, 'cam_1', 'explicitly saved tablet camera must NOT be hijacked by USB DSLR');

  const h2 = makeHarness({
    helperSees: false,
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
  });
  h2.localStorage.setItem('pb4u.camera', JSON.stringify({ id: 'usb-remote', label: 'DSLR / Mirrorless camera (USB)', isUsb: true }));
  await h2.enumerateCameras({ noProbe: true });
  assert.equal(h2.cameraSelect.value, 'usb-remote', 'explicitly saved DSLR/USB sticks across restart');

  const h3 = makeHarness({
    helperSees: true,
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
  });
  await h3.enumerateCameras({ noProbe: true });
  assert.equal(h3.cameraSelect.value, 'usb-remote', 'first-run with no saved preference still auto-picks plugged-in DSLR');
});

await testAsync('Huawei MatePad self-eviction fix: initCamera NEVER opens a second getUserMedia probe while stream is active', async () => {
  const h = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
    onGum: (c) => {
      const trk = {
        readyState: 'live',
        muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'cam_1', facingMode: 'user', width: 1280, height: 720 }),
      };
      // Deliver picture immediately
      setTimeout(() => { h.video.videoWidth = 1280; h.video.videoHeight = 720; h.video.emit('loadeddata'); }, 5);
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const ok = await h.initCamera('cam_1');
  assert.equal(ok, true);
  assert.equal(h._state.gumCalls.length, 1, 'must call getUserMedia exactly once — no overlapping probe eviction!');
  assert.equal(h.streamActive, true);
});

await testAsync('Huawei Kirin 710A self-healing: NoPicture under 1280x720@30fps automatically retries with loose constraints and succeeds', async () => {
  let attempt = 0;
  let firstTrackStopped = false;
  const h = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
    onGum: (c) => {
      attempt++;
      const isFirst = attempt === 1;
      const trk = {
        readyState: 'live',
        muted: false,
        stop() { this.readyState = 'ended'; if (isFirst) firstTrackStopped = true; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'cam_1', facingMode: 'user' }),
      };
      if (!isFirst) {
        // Loose retry succeeds and produces native 4:3 frame
        setTimeout(() => { h.video.videoWidth = 640; h.video.videoHeight = 480; h.video.emit('loadedmetadata'); }, 10);
      }
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  // Speed up waitForVideoFrame timeout for test
  h.waitForVideoFrame = async (vid) => {
    await new Promise(r => setTimeout(r, 30));
    return vid.videoWidth > 0;
  };
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const ok = await h.initCamera('cam_1');
  assert.equal(ok, true, 'should recover via loose retry');
  assert.equal(firstTrackStopped, true, 'stalled first stream must be cleanly stopped before retry');
  assert.equal(attempt, 2, 'must retry once with loose constraints');
  assert.equal(h._state.gumCalls[1].video.frameRate, undefined, 'loose retry must drop frameRate constraint');
  assert.equal(h._state.gumCalls[1].video.width, undefined, 'loose retry must drop width constraint');
  assert.equal(h.cameraError.style.display, 'none', 'no NoPicture error shown after successful recovery');
});

await testAsync('Persistent NoPicture cleanly stops stream and returns false (no zombie streamActive)', async () => {
  let stoppedCount = 0;
  const h = makeHarness({
    devices: [{ kind: 'videoinput', deviceId: 'cam_1', label: '' }],
    androidCams: [{ id: '0', facing: 'back' }],
    onGum: () => {
      const trk = {
        readyState: 'live',
        muted: false,
        stop() { stoppedCount++; this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'cam_1' }),
      };
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.waitForVideoFrame = async () => false;
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const ok = await h.initCamera('cam_1');
  assert.equal(ok, false);
  assert.equal(h.streamActive, false);
  assert.equal(h.currentStream, null);
  assert.equal(stoppedCount, 3, 'initial, loose deviceId, and facingOnly retry streams are all cleanly stopped');
  assert.equal(h.cameraErrorText.textContent, 'NoPicture');
});

await testAsync('Android facingOnly recovery: recovers via facingMode when hashed deviceId yields NoPicture twice', async () => {
  let attempt = 0;
  const h = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: 'bad_back', label: '' },
      { kind: 'videoinput', deviceId: 'bad_front', label: '' },
    ],
    onGum: (c) => {
      attempt++;
      const trk = {
        readyState: 'live',
        muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'bad_front', facingMode: 'user' }),
      };
      if (c && c.video && c.video.facingMode && c.video.facingMode.exact === 'user') {
        setTimeout(() => { h.video.videoWidth = 640; h.video.videoHeight = 480; h.video.emit('loadedmetadata'); }, 5);
      }
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.waitForVideoFrame = async (vid) => {
    await new Promise(r => setTimeout(r, 20));
    return vid.videoWidth > 0;
  };
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const ok = await h.initCamera('bad_front');
  assert.equal(ok, true, 'recovers on 3rd try using facingMode user');
  assert.equal(attempt, 3);
  assert.equal(h._state.gumCalls[2].video.facingMode.exact, 'user');
});

await testAsync('Concurrent camera switches serialize via camInitGen and stop superseded stream cleanly', async () => {
  let cam1Stopped = false;
  let resolveCam1;
  const h = makeHarness({
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
    onGum: (c) => {
      const id = c.video && c.video.deviceId && c.video.deviceId.exact;
      if (id === 'cam_0') {
        return new Promise(res => {
          resolveCam1 = () => {
            const trk = {
              readyState: 'live', muted: false,
              stop() { cam1Stopped = true; this.readyState = 'ended'; },
              addEventListener() { },
              getSettings: () => ({ deviceId: 'cam_0', facingMode: 'environment' }),
            };
            res({ getVideoTracks: () => [trk], getTracks: () => [trk] });
          };
        });
      }
      const trk2 = {
        readyState: 'live', muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'cam_1', facingMode: 'user' }),
      };
      setTimeout(() => { h.video.videoWidth = 1280; h.video.videoHeight = 720; h.video.emit('loadeddata'); }, 5);
      return { getVideoTracks: () => [trk2], getTracks: () => [trk2] };
    },
  });
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const p1 = h.initCamera('cam_0');
  const p2 = h.initCamera('cam_1');
  const ok2 = await p2;
  resolveCam1();
  const ok1 = await p1;
  assert.equal(ok2, true, 'newer camera switch succeeds');
  assert.equal(ok1, false, 'stale superseded switch exits cleanly');
  assert.equal(cam1Stopped, true, 'stale late-resolving stream is stopped immediately');
  assert.equal(h.currentDeviceId, 'cam_1');
  assert.equal(h.camInitInFlight, false);
});

await testAsync('Background OS track eviction marks sleeping without false cameraLost loop', async () => {
  const trackListeners = new Map();
  const h = makeHarness({
    devices: [{ kind: 'videoinput', deviceId: 'cam_1', label: '' }],
    onGum: () => {
      const trk = {
        readyState: 'live', muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener(ev, fn) { trackListeners.set(ev, fn); },
        getSettings: () => ({ deviceId: 'cam_1', facingMode: 'user' }),
      };
      setTimeout(() => { h.video.videoWidth = 1280; h.video.videoHeight = 720; h.video.emit('loadeddata'); }, 5);
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  assert.equal(await h.initCamera('cam_1'), true);
  // App moves to background and HarmonyOS revokes camera
  h.document.hidden = true;
  trackListeners.get('ended')();
  assert.equal(h._state.cameraLostCalls, 0, 'must not spam cameraLost while backgrounded');
  assert.equal(h.streamActive, false, 'streamActive cleared so foreground return wakes camera');
  assert.equal(h.camSleeping, true, 'marked sleeping so foreground return wakes cleanly');
});

await testAsync('Cold-start hidden video with live unmuted track defers check instead of false NoPicture', async () => {
  const h = makeHarness({
    videoVisible: false,
    devices: [
      { kind: 'videoinput', deviceId: 'cam_0', label: '' },
      { kind: 'videoinput', deviceId: 'cam_1', label: '' },
    ],
    onGum: () => {
      const trk = {
        readyState: 'live', muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: 'cam_1', facingMode: 'user', width: 1280, height: 720 }),
      };
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.waitForVideoFrame = async () => false;
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  const ok = await h.initCamera('cam_1');
  assert.equal(ok, true, 'hidden cold-start video with live track succeeds without false NoPicture');
  assert.equal(h.camPendingVisibleCheck, true, 'schedules visible-frame check once video appears');
  assert.equal(h.cameraError.style.display, 'none');
  // Verify auto-mirror accuracy on Huawei blank-label cameras
  h.cameraSelect.value = 'cam_1';
  assert.equal(h.isFrontCamera(), true, 'Front camera mirrors by default');
  h.cameraSelect.value = 'cam_0';
  assert.equal(h.isFrontCamera(), false, 'Back camera does not mirror by default');
});

await testAsync('Legacy saved Camera 1 sticks even when cold start auto-opened before enumeration', async () => {
  let enumCalls = 0;
  const h = makeHarness({
    devices: () => {
      enumCalls++;
      // First enumerate returns empty; after stream opens, both cameras appear
      if (enumCalls === 1) return [];
      return [
        { kind: 'videoinput', deviceId: 'cam_back_0', label: '' },
        { kind: 'videoinput', deviceId: 'cam_front_1', label: '' },
      ];
    },
    onGum: (c) => {
      const id = (c.video && c.video.deviceId && c.video.deviceId.exact) || 'cam_front_1';
      const trk = {
        readyState: 'live', muted: false,
        stop() { this.readyState = 'ended'; },
        addEventListener() { },
        getSettings: () => ({ deviceId: id, facingMode: id === 'cam_back_0' ? 'environment' : 'user' }),
      };
      setTimeout(() => { h.video.videoWidth = 1280; h.video.videoHeight = 720; h.video.emit('loadeddata'); }, 5);
      return { getVideoTracks: () => [trk], getTracks: () => [trk] };
    },
  });
  h.localStorage.setItem('pb4u.camera', JSON.stringify({ id: 'old_hash_0', label: 'Camera 1' }));
  h.camLabelProbed = true;
  await h.enumerateCameras({ noProbe: true });
  assert.equal(h.cameraSelect.value, '', 'initially waiting placeholder');
  const ok = await h.initCamera(h.cameraSelect.value || null);
  assert.equal(ok, true);
  assert.equal(h.currentDeviceId, 'cam_back_0', 'automatically switched from front to saved Camera 1 (back)');
  assert.equal(h.cameraSelect.value, 'cam_back_0');
});

test('Android native layer has synchronous camera prefs, Camera2 BACKWARD_COMPATIBLE filter, permission gate, and USB printer exclusion', () => {
  const pbLocal = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/PBLocal.kt'), 'utf8');
  const mainAct = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/MainActivity.kt'), 'utf8');
  const usbCam = readFileSync(join(ROOT, 'android/app/src/main/java/com/photobooth4u/booth/UsbCameraHelper.kt'), 'utf8');
  assert(/fun getCameraPref\(\)/.test(pbLocal), 'PBLocal.getCameraPref present');
  assert(/fun setCameraPref\(/.test(pbLocal) && /\.commit\(\)/.test(pbLocal), 'PBLocal.setCameraPref uses synchronous commit()');
  assert(/fun listAndroidCameras\(\)/.test(pbLocal) && /REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE/.test(pbLocal), 'PBLocal.listAndroidCameras filters BACKWARD_COMPATIBLE');
  assert(/flushPendingWebPermissions/.test(mainAct) && /pb-camera-permission/.test(mainAct), 'MainActivity gates & flushes WebView permissions cleanly');
  assert(/onTrimMemory/.test(mainAct) && /pb-memory-pressure/.test(mainAct), 'MainActivity forwards OS memory pressure trims to WebView');
  assert(/webView\.destroy\(\)/.test(mainAct) && /recreate\(\)/.test(mainAct), 'MainActivity recreates Activity after dead WebView renderer');
  assert(/USB_CLASS_PRINTER/.test(usbCam), 'UsbCameraHelper excludes USB printers from isCamera()');
});

test('Endurance: listenVideoFrames cancels prior callbacks and never stacks duplicate rVFC loops', () => {
  let nextId = 1;
  const activeCbs = new Map();
  const fakeVideo = {
    paused: false,
    requestVideoFrameCallback(cb) { const id = nextId++; activeCbs.set(id, cb); return id; },
    cancelVideoFrameCallback(id) { activeCbs.delete(id); },
  };
  const sb = {
    camLat: [],
    rvfcCount: 0,
    streamActive: true,
    currentStream: {},
    webcamPushFrame: () => { },
  };
  vm.createContext(sb);
  vm.runInContext(pageFunction('stopVideoFrames') + '\n' + pageFunction('listenVideoFrames'), sb);
  for (let i = 0; i < 20; i++) sb.listenVideoFrames(fakeVideo);
  assert.equal(activeCbs.size, 1, '20 repeated listenVideoFrames calls must leave exactly 1 active loop');
  // Fire one frame and confirm rvfcCount increments by 1 (not 20)
  const [id, cb] = Array.from(activeCbs.entries())[0];
  activeCbs.delete(id);
  cb(1000, { captureTime: 960 });
  assert.equal(sb.rvfcCount, 1, 'single frame advances rvfcCount by exactly 1');
  assert.equal(activeCbs.size, 1, 're-armed cleanly for next frame');
  sb.stopVideoFrames(fakeVideo);
  assert.equal(activeCbs.size, 0, 'stopVideoFrames cancels queued callback');
});

test('Endurance: isAndroidBuiltInSteady prevents 2s HAL thrashing during events and allows thermal rest after 5 min true idle', () => {
  const now = Date.now();
  const sb = {
    Date,
    IS_ANDROID_APP: true,
    USB_CAM_ID: 'usb-remote',
    UVC_ID: 'pb-uvc-webcam',
    currentDeviceId: 'cam_front',
    isBuiltInCamera: () => true,
    state: 'idle',
    flowBusy: false,
    fx: { hands: 'off' },
    usbTouchAt: now - 30_000, // 30 s since last guest
    document: { hidden: false, getElementById: () => ({ hidden: true }) },
    ANDROID_BUILTIN_IDLE_MS: 5 * 60 * 1000,
  };
  vm.createContext(sb);
  vm.runInContext(pageFunction('isAndroidBuiltInSteady'), sb);
  assert.equal(sb.isAndroidBuiltInSteady(), true, 'stays steady between guests (< 5 min idle)');
  sb.usbTouchAt = now - 6 * 60 * 1000; // 6 min true idle on welcome screen
  assert.equal(sb.isAndroidBuiltInSteady(), false, 'allows thermal rest after 5+ min true idle');
  sb.state = 'capturing';
  assert.equal(sb.isAndroidBuiltInSteady(), true, 'never sleeps while capturing');
  sb.state = 'idle';
  sb.fx.hands = 'wave';
  assert.equal(sb.isAndroidBuiltInSteady(), true, 'never sleeps while hands-free wave/smile is enabled');
  sb.fx.hands = 'off';
  sb.usbTouchAt = now - 5_000;
  sb.document.hidden = true;
  assert.equal(sb.isAndroidBuiltInSteady(), false, 'sleeps cleanly when app is backgrounded');
});

test('Endurance: Android tablets skip heavy default CPU pixel stacking/clean-up (like iPad) and release ring pool canvases', () => {
  const store = new Map();
  const canvases = [];
  const sb = {
    console, Math, Object, Array, Map, Uint8Array, Uint8ClampedArray, Date, String, Number,
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10; AGS6-W09) PB4uAndroid' },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: {
      createElement: () => {
        const cv = { width: 0, height: 0, getContext: () => ({ drawImage() { }, setTransform() { }, translate() { }, scale() { } }) };
        canvases.push(cv);
        return cv;
      },
      getElementById: () => null,
    },
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout: () => 0,
    USB_CAM_ID: 'usb-remote', currentDeviceId: 'cam_1', state: 'capturing', countingDown: true,
    usbCam: { name: '', camera: { info: {} } }, usbLog: () => { }, showToast: () => { }, shotCanvases: [],
  };
  vm.createContext(sb);
  const pq = readFileSync(join(ROOT, 'protected', 'src', 'camera', 'photo-quality.js'), 'utf8');
  const wp = readFileSync(join(ROOT, 'protected', 'src', 'camera', 'webcam-pro.js'), 'utf8');
  vm.runInContext(pq + '\n' + wp, sb);
  assert.equal(vm.runInContext('CAM_Q.webcam.cleanMode()', sb), 'off', 'Android defaultClean is off');
  assert.equal(vm.runInContext('webcamStackOn()', sb), false, 'Android default webcamStackOn is false');
  // Explicit operator override still works, and ring pool releases cleanly
  store.set('pb_webcam_stack', '1');
  assert.equal(vm.runInContext('webcamStackOn()', sb), true, 'operator can still opt in to stacking');
  vm.runInContext('webcamPushFrame({ videoWidth: 1280, videoHeight: 720 })', sb);
  assert.equal(canvases[0].width, 1280, 'ring slot allocated when explicitly opted in');
  vm.runInContext('webcamReleaseRingPool()', sb);
  assert.equal(canvases[0].width, 0, 'webcamReleaseRingPool shrinks canvas to 0x0');
  assert.equal(canvases[0].height, 0, 'webcamReleaseRingPool shrinks canvas height to 0');
});

test('Endurance: pbReleaseFlipbookResult shrinks all flipbook canvases and setLayout/retake release replaced shots', () => {
  const mkCv = (w, h) => ({ width: w, height: h });
  const c1 = mkCv(800, 600), c2 = mkCv(800, 600), cov = mkCv(800, 600), bck = mkCv(800, 600);
  const sb = { flipbookResult: { cards: [c1, c2], cover: cov, back: bck } };
  vm.createContext(sb);
  vm.runInContext(pageFunction('pbReleaseCanvas') + '\n' + pageFunction('pbReleaseFlipbookResult'), sb);
  sb.pbReleaseFlipbookResult();
  assert.equal(sb.flipbookResult, null);
  for (const cv of [c1, c2, cov, bck]) {
    assert.equal(cv.width, 0);
    assert.equal(cv.height, 0);
  }
  assert(page.includes('if (shotCanvases[pick]) pbReleaseShotCanvas(shotCanvases[pick]);'), 'retake releases old shot canvas');
  assert(page.includes('if (shotCanvases.length !== shotsNeeded()) {\n          pbReleaseShotList(shotCanvases);'), 'setLayout releases old shot canvases');
});

test('Android exit/reopen camera teardown, QR kiosk safety, auto-return timer, and review framing', () => {
  const mainKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'MainActivity.kt'), 'utf8');
  const shareKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'LocalShareServer.kt'), 'utf8');
  // Camera teardown across exit / background / reopen (fixes Huawei camera lock until Force Stop)
  assert(mainKt.includes('private fun destroyWebViewSafely()'), 'MainActivity defines destroyWebViewSafely');
  assert(mainKt.includes('webView.loadUrl("about:blank")'), 'destroyWebViewSafely navigates to about:blank to trigger Blink MediaStream teardown');
  assert(mainKt.includes('webView.destroy()'), 'destroyWebViewSafely destroys WebView in onDestroy');
  assert(mainKt.includes('override fun onStop()') && mainKt.includes('releaseWebCameraNow { pauseWebViewIfHidden() }'), 'MainActivity waits for JS camera release before pausing WebView onStop');
  assert(mainKt.includes('PrintHelperService.stop(this)') && mainKt.includes('finishAndRemoveTask()'), 'Exit button stops PrintHelperService and removes task cleanly');
  assert(mainKt.includes('dispatchNetSyncEvent("pb-app-resume", 450L)'), 'onResume dispatches pb-app-resume unconditionally (including offline kiosks)');
  assert(mainKt.includes('val isLocalShare = curUrl.startsWith("http://127.0.0.1:")'), 'Back button on local share page returns cleanly to booth');
  assert(shareKt.includes('← Back to booth'), 'LocalShareServer renders Back to booth button on own-tablet /o/ page');

  // Booth JS camera timeout + teardown + cold-start recovery + Android backdrop-filter disable
  assert(page.includes('window.__pbReleaseCameraNow = releaseBuiltInCameraNow'), 'booth exposes __pbReleaseCameraNow');
  assert(page.includes('function scheduleAndroidCameraResume(') && page.includes('scheduleAndroidCameraResume(true)'), 'booth defines scheduleAndroidCameraResume with automatic retry');
  assert(page.includes('Camera did not respond in time') && page.includes('err._pbTimeout = true;') && page.includes('if (e && e._pbTimeout) { gumTimedOut = true; break; }'), 'openCameraStream caps hung getUserMedia timeouts instead of retrying 13 times');
  assert(page.includes('html.pb-android *') && page.includes('backdrop-filter: none !important;'), 'Android disables expensive backdrop-filter blur over live camera');

  // Local QR "Open" link removed, auto-return timer visible & persisted, pre-print review framing wired
  assert(!page.includes("a.className = 'qr-link'"), 'no clickable qr-link Open anchor is created under QR codes');
  assert(page.includes('id="resultReviewSelect"') && !page.includes('<select id="resultReviewSelect" hidden>'), 'resultReviewSelect is visibly exposed');
  assert(page.includes("setSelectValue('resultReviewSelect', resultReviewSec)"), 'applySetup restores resultReviewSec');
  assert(page.includes('id="reviewFramingToggle"') && page.includes('id="reviewFramingBar"') && page.includes('function reviewFramingRedraw()'), 'pre-print review framing toggle, bar, and redraw are wired');
  assert(page.includes('if (targetCanvas === previewCanvas && !BOX_PROBE) shotSlotBoxes = {};'), 'composeCanvas clears stale shotSlotBoxes');
  assert(page.includes('recordShotSlotBox(shot._shotIndex, ctx, -drawW / 2, -drawH / 2, drawW, drawH)'), 'drawFrameInto records shotSlotBoxes for masked frames');
  assert(page.includes('cv === previewCanvas && !cv._fastPreview'), 'previewCanvas uses fast 1x redraw during interactive framing');
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures' : ''));
