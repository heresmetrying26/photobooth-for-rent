import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configure, findFfmpeg, saveLutCube, lutCubePath, buildArgs } from '../desktop/lib/spin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);
const lut = require('../protected/src/camera/lut-engine.js');

let passed = 0;
function ok(msg) { console.log('PASS:', msg); passed++; }

// 1. Parse a 3D .cube LUT (with comments, BOM, and TITLE), pack -> unpack -> sample CPU at 100%, 50%, 0%
{
  const lines = [
    '\uFEFF# Sample warm film LUT',
    'TITLE "Warm Test"',
    'LUT_3D_SIZE 2',
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0'
  ];
  // b -> g -> r order: swap R and B channels (output = (b, g, r))
  for (let b = 0; b < 2; b++) {
    for (let g = 0; g < 2; g++) {
      for (let r = 0; r < 2; r++) {
        lines.push(`${b}.0 ${g}.0 ${r}.0`);
      }
    }
  }
  const parsed = lut.lutParseCube(lines.join('\n'));
  assert.equal(parsed.title, 'Warm Test');
  assert.equal(parsed.size, 2);
  assert.equal(parsed.data.length, 2 * 2 * 2 * 3);

  const packed = lut.lutPackRgba(parsed);
  assert.equal(packed.width, 4);
  assert.equal(packed.height, 2);

  const unpacked = lut.lutUnpackRgba(packed.rgba, packed.width, packed.height);
  assert.ok(unpacked);
  assert.equal(unpacked.size, 2);

  const out = [0, 0, 0];
  lut.lutSampleCpu(unpacked.bytes, unpacked.size, 255, 128, 0, 1.0, out);
  assert(Math.abs(out[0] - 0) < 1 && Math.abs(out[1] - 128) < 1 && Math.abs(out[2] - 255) < 1, '100% strength swaps R/B');

  lut.lutSampleCpu(unpacked.bytes, unpacked.size, 255, 128, 0, 0.5, out);
  assert(Math.abs(out[0] - 127.5) < 1 && Math.abs(out[1] - 128) < 1 && Math.abs(out[2] - 127.5) < 1, '50% strength blends halfway');

  lut.lutSampleCpu(unpacked.bytes, unpacked.size, 200, 100, 50, 0.0, out);
  assert.deepEqual(out, [200, 100, 50], '0% strength keeps original pixel');
  ok('3D .cube parse, RGBA 2D pack/unpack, and CPU trilinear interpolation with strength');
}

// 2. Resampling a giant 64x64x64 .cube down to 33x33x33 preserves values
{
  const N = 64, lines = ['LUT_3D_SIZE 64'];
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        lines.push(`${(1 - r / (N - 1)).toFixed(6)} ${(1 - g / (N - 1)).toFixed(6)} ${(1 - b / (N - 1)).toFixed(6)}`);
      }
    }
  }
  const parsed = lut.lutParseCube(lines.join('\n'), { maxSize: 33 });
  assert.equal(parsed.size, 33);
  const packed = lut.lutPackRgba(parsed);
  const unpacked = lut.lutUnpackRgba(packed.rgba, packed.width, packed.height);
  const out = [0, 0, 0];
  lut.lutSampleCpu(unpacked.bytes, unpacked.size, 51, 102, 204, 1.0, out);
  assert(Math.abs(out[0] - 204) <= 2 && Math.abs(out[1] - 153) <= 2 && Math.abs(out[2] - 51) <= 2);
  ok('64x64x64 .cube resamples down to 33x33x33 cleanly');
}

// 3. 1D .cube LUT parsing + strength-blended .cube export + iOS ColorCube RGBA bytes
{
  const txt1d = ['TITLE "Gamma Boost"', 'LUT_1D_SIZE 3', '0.0 0.0 0.0', '0.7 0.6 0.5', '1.0 1.0 1.0'].join('\n');
  const parsed = lut.lutParseCube(txt1d);
  assert.equal(parsed.size, 33);
  const packed = lut.lutPackRgba(parsed);
  const unpacked = lut.lutUnpackRgba(packed.rgba, packed.width, packed.height);

  const out = [0, 0, 0];
  lut.lutSampleCpu(unpacked.bytes, unpacked.size, 128, 128, 128, 1.0, out);
  assert(Math.abs(out[0] - 179) <= 2 && Math.abs(out[1] - 153) <= 2 && Math.abs(out[2] - 128) <= 2);

  const cubeExport = lut.lutToCubeText(unpacked.bytes, unpacked.size, 0.5, 'Half Boost');
  const reparsed = lut.lutParseCube(cubeExport);
  assert.equal(reparsed.size, 33);
  const unpacked2 = lut.lutUnpackRgba(lut.lutPackRgba(reparsed).rgba, 33 * 33, 33);
  const outHalf = [0, 0, 0];
  lut.lutSampleCpu(unpacked2.bytes, unpacked2.size, 128, 128, 128, 1.0, outHalf);
  assert(Math.abs(outHalf[0] - 153) <= 2 && Math.abs(outHalf[1] - 140) <= 2 && Math.abs(outHalf[2] - 128) <= 2);

  const rgbaCube = lut.lutToCubeRgbaBytes(unpacked.bytes, unpacked.size, 1.0);
  assert.equal(rgbaCube.length, 33 * 33 * 33 * 4);
  assert.equal(rgbaCube[3], 255);
  ok('1D .cube support, strength-blended .cube export, and iOS RGBA cube buffer');
}

// 4. Malformed .cube files throw clean errors
{
  assert.throws(() => lut.lutParseCube(''), /Empty/);
  assert.throws(() => lut.lutParseCube('TITLE "No size"\n0 0 0'), /Missing/);
  assert.throws(() => lut.lutParseCube('LUT_3D_SIZE 4\n0 0 0'), /Incomplete/);
  ok('Malformed .cube validation throws clean errors');
}

// 5. 360 Spin FFmpeg lut3d integration (saveLutCube + lutCubePath + buildArgs + real ffmpeg render)
{
  const tmp = mkdtempSync(join(tmpdir(), 'pb4u-lut-test-'));
  try {
    configure({ buildDir: join(ROOT, 'desktop', 'build'), temp: tmp });
    // Red -> Blue swap cube
    const rbCube = 'LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n';
    const fname = saveLutCube(rbCube);
    assert(fname && /^pb4u-lut-\d+-\d+\.cube$/.test(fname), 'valid temp lut filename');
    const full = lutCubePath(fname);
    assert(full && existsSync(full), 'saved temp lut exists on disk');
    assert.equal(lutCubePath('../evil.cube'), null, 'rejects path traversal');

    const inVid = join(tmp, 'red.mp4');
    const outVid = join(tmp, 'graded.mp4');
    const built = buildArgs({
      input: inVid,
      output: outVid,
      options: { lut: 'lut_custom_1', lutFile: fname, speed: 'normal', orientation: 'portrait', quality: 540 }
    }, { duration: 0.6, fps: 30 });
    const fc = built.args[built.args.indexOf('-filter_complex') + 1];
    assert(fc.includes("lut3d=file='") && fc.includes(":interp=tetrahedral[v_lut]"), 'ffmpeg filtergraph uses lut3d');
    assert(!fc.includes('\\pb4u-lut'), 'slashes normalized for ffmpeg filtergraph');

    const ff = await findFfmpeg();
    if (ff) {
      const gen = spawnSync(ff, ['-y', '-f', 'lavfi', '-i', 'color=c=0xFF0000:s=128x128:d=0.6:r=30', '-pix_fmt', 'yuv420p', inVid], { encoding: 'utf8' });
      assert.equal(gen.status, 0, 'synthetic red video created: ' + (gen.stderr || ''));
      const run = spawnSync(ff, built.args, { encoding: 'utf8' });
      assert.equal(run.status, 0, 'ffmpeg lut3d render succeeded: ' + (run.stderr || ''));
      const probeFrame = spawnSync(ff, ['-v', 'error', '-i', outVid, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(probeFrame.status, 0, 'decoded graded frame');
      const px = probeFrame.stdout;
      assert(px.length >= 3, 'frame bytes present');
      // Red input (255,0,0) swapped by LUT should become blue-dominant (B >> R)
      const r = px[0], g = px[1], b = px[2];
      assert(b > 200 && r < 60 && g < 60, `expected blue-graded output from red input, got (${r},${g},${b})`);
      ok(`360 Spin real FFmpeg lut3d render transformed red -> blue (${r},${g},${b})`);
    } else {
      ok('360 Spin saveLutCube, path validation, and FFmpeg lut3d filtergraph (ffmpeg binary not present)');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 6. Booth bundle includes lut-engine.js, UI controls, no window.prompt in LUT code, and valid JS syntax
{
  const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  assert(boothHtml.includes('function lutParseCube('), 'built booth.html includes lut-engine.js');
  assert(boothHtml.includes('id="addLutBtn"') && boothHtml.includes('id="lutStrengthSlider"') && boothHtml.includes('id="guestLookMaxInput"'), 'built booth.html includes LUT & guest-cap controls');
  assert(!boothHtml.includes("prompt('Rename LUT filter:'"), 'LUT rename uses in-page askText instead of window.prompt');
  assert(boothHtml.includes('state.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE)'), 'WebGL checks MAX_TEXTURE_SIZE before rendering');
  const scriptMatches = [...boothHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(scriptMatches.length > 0, 'inline scripts found in booth.html');
  for (const m of scriptMatches) {
    new vm.Script(m[1]);
  }
  ok('protected/booth.html matches sources and all inline <script> blocks pass JS syntax parse');
}

// 7. VM test: applySetup restores customLuts, custom filterKey, and user-chosen guestLookMax cap
{
  const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  const asStart = boothHtml.indexOf('function applySetup(');
  const asEnd = boothHtml.indexOf('function setupScopeEvent()', asStart);
  assert(asStart > 0 && asEnd > asStart, 'applySetup slice present');
  const noop = () => { };
  const dummyEl = () => ({ value: '', checked: false, style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }, querySelectorAll: () => [], children: [] });
  const ensured = [];
  const ctx = {
    console, Math, Number, String, Array, Object, Boolean, JSON, Promise, setTimeout, clearTimeout, isFinite,
    setupApplying: false, state: 'idle',
    FILTERS: { none: '', bw: 'grayscale(1)', warm: 'sepia(.2)' },
    customLuts: [],
    customLutById(k) { return ctx.customLuts.find((l) => l && l.id === k) || null; },
    isCustomLutKey(k) { return !!ctx.customLutById(k); },
    filterExists(k) { return !!k && (Object.prototype.hasOwnProperty.call(ctx.FILTERS, k) || ctx.isCustomLutKey(k)); },
    GUEST_LOOK_MAX: 6, guestLookMax: 6,
    clampGuestLookMax(v) { const n = Math.round(Number(v)); return isFinite(n) && n >= 1 ? Math.min(20, n) : 6; },
    ensureAssets(ids) { ensured.push(...ids); },
    rebuildCustomFilterChips: noop, refreshSpinLutOptions: noop, spinLookToUI: noop,
    refreshGuestLooksUI: noop, markFilterChips: noop, applyLiveFilter: noop,
    softSkinToggle: dummyEl(), dateStampToggle: dummyEl(), softSkin: false, dateStamp: false,
    guestLookBase: null, guestLooksOn: false, guestLookSet: ['none', 'bw'], filterKey: 'none',
    labelInput: dummyEl(), selectFont: noop, isHex: () => false, setTextColorUI: noop,
    titleSizeSlider: dummyEl(), titleBgToggle: dummyEl(), titleBgColorWrap: dummyEl(), titleBgColorInput: dummyEl(),
    outlineToggle: dummyEl(), outlineColorSelect: dummyEl(), shadowToggle: dummyEl(),
    setTimer: noop, setFirstTimer: noop, setSelectValue: noop, refreshAdvanceUI: noop, reviewEachToggle: dummyEl(),
    refreshQrPopUI: noop, refreshAfterThemeUI: noop, refreshShareStationUI: noop, refreshRetakeUI: noop,
    updateColorAdjUI: noop, extraOn: () => false, isGifAllowed: () => false,
    refreshGifLayoutUI: noop, refreshFlipPoolUI: noop,
    setFrameColorUI: noop, photoPlacementSelect: dummyEl(), ELEMENT_SETS: {}, setBackdropColorUI: noop,
    clearCustomPhoto: noop, BACKDROP_PRESETS: {}, ACCENTS: { gold: 1 }, markAccentChips: noop,
    STICKER_NAMES: {}, STICKER_PACKS: [], refreshGuestStickersUI: noop, TITLE_STYLES: [['classic']],
    receiptNoteInput: null, validArt: () => '', validArtPal: () => '', refreshTitleUI: noop,
    window: { _isPosterVideo: () => false, _isPosterGif: () => false },
    applyPrintPrefs: noop, applyGbPrefs: noop, applyBgRepSetup: noop, applyFxSetup: noop, applyGvSetup: noop,
    refreshSoloUI: noop, cleanBrand: (b) => b || {}, applyPaySetup: noop, applyFramesSetup: noop, applyTplsSetup: noop,
    boothType: 'photo', typesAllowed: () => false, btApplyCfg: noop, guestPickToggle: dummyEl(), syncBoothTypeUI: noop,
    setLayout: noop, refreshGuestLayoutChoices: noop, dateInput: dummyEl(), setDateOn: noop, applyLabelInputFont: noop,
    setActivePresetBtn: noop, updateBandPositionVisibility: noop, markThemeCards: noop, refreshDecorUI: noop,
    renderComposite: noop, renderSetupPreview: noop, refreshStartScreen: noop, guestRender: noop,
    scheduleWelcomeRender: noop, refreshWelcome: noop, deskNotifySetupChanged: noop,
    document: { getElementById: () => null }, welcomeToggle: dummyEl(), welcomeMsgInput: dummyEl(),
    welcomeBtnToggle: dummyEl(), welcomeSampleToggle: dummyEl(), welcomeCustomToggle: dummyEl(),
    welcomeGreetingInput: dummyEl(), welcomeTitleInput: dummyEl(), welcomeSubInput: dummyEl(),
    welcomeStep1Input: dummyEl(), welcomeStep2Input: dummyEl(), welcomeStep3Input: dummyEl(),
    frameColorChoice: 'auto', photoPlacement: 'band', cropFocus: 'center', elementsChoice: 'auto',
    backdropColor: null, pendingCustom: false, backdropPreset: 'none', bgImageDataUrl: null,
    accent: 'gold', overlay: null, logo: null, decor: [], guestStickersOn: false, stickerPacksOn: [],
    guestStickerSec: 35, myProps: [], selDecor: -1, titleStyle: 'classic', kickerText: '', receiptCustomNote: '',
    titleUpper: false, themeArt: '', artPal: '', saveSoloPhotos: true, brand: {}, setupLayout: 'strip',
    guestPickOn: false, frameMode: 'choose', dateOn: false, guestDesigns: [], activeDesignIdx: 0,
    guestLayoutSet: [], chooseIds: [], activeFrameId: null, includeFramesInDesignPick: true,
    GIF_SLIDE_BGS: {}, outputMode: 'photo', gifLayoutMode: 'solo', gifMotionStyle: 'auto',
    gifSlideCard: 'white', gifSlideBg: '', gifSlideFrame: 'card', gifLoopMode: 'forward', flipSec: 5,
    flipFrames: 16, flipCover: false, flipBack: false, flipCollation: 'stack', flipGutter: false,
    flipGutterMm: 12, flipNumbers: false, flipCardLayout: 'bordered', flipBorderSize: 'medium',
    flipBorderColor: '#fff', flipCardCaption: '', flipOverlayAssetId: null, flipOverlayBorder: false,
    flipCues: false, flipCoverStyle: 'title', flipCoverAssetId: null, flipBackQr: false, flipBackText: '',
    flipGridPreset: 'auto', flipPrinterPool: '', flipPoolMode: 'pages',
    betweenSec: 1, advanceMode: 'auto', reviewEach: false, qrPopOn: false, hideQrOn: false,
    qrPopDelay: 3, qrMatchWelcome: true, shareStationOn: false, shareStationHandoff: '', shareStationPrivacy: '',
    allowRetake: false, colorAdj: {}, saverDimMin: 0, saverOffMin: 0,
    welcomeOn: true, welcomeMsg: '', welcomeBtnOn: true, welcomeSampleOn: true, welcomeSampleLayout: 'strip',
    welcomeCardBg: '', welcomeCardFontColor: '', welcomeCardRadius: 32, welcomeStepStyle: 'numbers',
    welcomeDecoStyle: 'none', welcomePalette: 'warm', welcomeCustomOn: false, welcomeTitle: '', welcomeFont: '',
    welcomeSub: '', welcomeStepsOn: true, welcomeStep1: '', welcomeStep2: '', welcomeStep3: '',
    welcomeBtnColor: '#C93D27', welcomeBtnPos: 'bottom', attractMode: 'card', attractPosterId: '',
    attractSlideDuration: 6, attractVideoSound: false, attractActiveKey: '', attractRestoreHold: null,
    attractPlaylist: [], attractPosterFit: 'cover', attractPosterType: 'image', backgroundImg: null,
    bgThumb: dummyEl(), removeBgBtn: dummyEl(), bgInput: dummyEl(), fontSelect: dummyEl(), dateFontSelect: dummyEl(),
    setAttractModeUI: noop, setWelcomeBtnColorUI: noop, setWelcomeBtnPosUI: noop, setGuestStyleUI: noop,
    refreshOutputModeUI: noop, guestWelcomeStyle: 'photo', MAX_FRAMES: 30, myFrames: [], frameById: () => null,
    okFrameAssetId: () => true, updateBandPositionVisibility: noop, applyLabelInputFont: noop, buildLayoutPicker: noop,
    themeId: null, layoutPicked: true, attractRestoreSeq: 0, attractPosterUrl: '', photoHue: 0, photoSat: 0,
    computeDominantColor: () => ({ h: 0, s: 0 }), softSkinOn: false, dateStampOn: false,
    welcomeDataUrl: '', welcomeBackdrop: '', welcomeBgColor: '', welcomeThemeId: null,
    setTimer: noop, setFirstTimer: noop,
    RECEIPT_STYLES: [['classic']], LOGO_POS: { br: 1 }, LAYOUT_DEFS: { strip: { name: 'Strip', shots: 3 } },
    guestPickToggle: dummyEl(), refreshDecorUI: noop, refreshFrameUI: noop, redrawAll: noop, refreshBrandUI: noop,
    designAssetIds: () => []
  };
  vm.createContext(ctx);
  vm.runInContext(boothHtml.slice(asStart, asEnd), ctx);
  ctx.applySetup({
    customLuts: [
      { id: 'lut_wedding1', name: 'Wedding Warm', assetId: 'aAbCdEfGh12345678', size: 33, strength: 75 },
      { id: 'bad_id', name: 'Bad', assetId: 'aAbCdEfGh12345678', size: 33, strength: 50 }
    ],
    filter: 'lut_wedding1',
    guestLooks: true,
    guestLookMax: 10,
    guestLookSet: ['none', 'bw', 'warm', 'lut_wedding1']
  }, null, { skipDesignSync: true, fastGuest: true });
  assert.equal(ctx.customLuts.length, 1, 'sanitizes and restores valid customLuts');
  assert.equal(ctx.customLuts[0].strength, 75);
  assert.equal(ctx.filterKey, 'lut_wedding1', 'restores active custom LUT filterKey');
  assert.equal(ctx.guestLookMax, 10, 'restores client-chosen guestLookMax');
  assert.equal(ctx.guestLookSet.length, 4, 'keeps all 4 looks under cap=10');
  assert.deepEqual(ensured, ['aAbCdEfGh12345678'], 'queues asset load for LUT PNG');

  // Lowering cap trims guestLookSet cleanly
  ctx.applySetup({ guestLookMax: 2, guestLookSet: ['none', 'bw', 'warm', 'lut_wedding1'] }, null, { skipDesignSync: true, fastGuest: true });
  assert.equal(ctx.guestLookMax, 2);
  assert.deepEqual(ctx.guestLookSet, ['none', 'bw']);
  ok('applySetup restores customLuts, strength, guestLookMax, and asset hydration');
}

console.log(passed + ' passed');
