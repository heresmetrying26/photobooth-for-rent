import * as I from './imaging.js';
import * as L from './layout.js';
import * as P from './print.js';
import * as S from './sources.js';
import hw from './hw.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Let the browser paint before heavy work. A timer backs up requestAnimationFrame, which never fires in a hidden tab.
const nextFrame = () => new Promise((r) => { let d = false; const go = () => { if (!d) { d = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 60); });

// ---------- settings (kept on this computer only) ----------
const DEFAULTS = {
  shop: 'Rush ID & Photo Print', currency: '₱', pin: '1234', idle: 180,
  idPaper: '4x6', gapMm: 0, marginMm: 0, cutGuides: true,
  prices: { idSheet: 0, '4x6': 0, '5x7': 0, '6x8': 0, '2x3': 0, '2x6': 0 },
};
function loadCfg() {
  try { const c = JSON.parse(localStorage.getItem('rushid.cfg') || '{}'); return { ...DEFAULTS, ...c, prices: { ...DEFAULTS.prices, ...(c.prices || {}) } }; }
  catch (e) { return { ...DEFAULTS, prices: { ...DEFAULTS.prices } }; }
}
let cfg = loadCfg();
const saveCfg = () => { try { localStorage.setItem('rushid.cfg', JSON.stringify(cfg)); } catch (e) { /* private mode */ } };

// ---------- inside the booth (/rush/): its cameras and printers ----------
// The paper sizes are the ones Admin allows for this code; a photo size is offered only if its paper is allowed.
if (hw) {
  L.PAPERS.splice(0, L.PAPERS.length, ...hw.papers().map((p) => ({ id: p.key, label: p.name, w: p.w / 25.4, h: p.h / 25.4 })));
  const ok = L.PHOTO_SIZES.filter((s) => L.PAPERS.some((p) => p.id === s.paper));
  L.PHOTO_SIZES.splice(0, L.PHOTO_SIZES.length, ...ok);
}
const noPrint = () => !!hw && !L.PAPERS.length;
const NO_PRINT_MSG = 'Printing is not switched on for this code. Please ask the owner.';

// ---------- state ----------
const freshId = () => ({ qty: { ...L.PACKAGES[0].qty }, pkg: 'p1', bg: '#ffffff', bgMode: 'color', brightness: 0, contrast: 0, edge: 0, crop: null, cropFor: null, guides: true, flip: false, tab: 'size' });
const state = { screen: 'home', mode: 'id', photos: [], sel: null, id: freshId(), photo: { size: '4x6', fit: 'fill' }, sets: 1, out: null };
let idWork = null;          // the full-size working copy of the photo being framed
let phone = null;           // phone (QR) session
let stopWatch = null;       // folder watcher (Bluetooth)
let camStream = null;
let seq = 0;

const photoById = (id) => state.photos.find((p) => p.id === id);
const sizeById = (id) => L.ID_SIZES.find((s) => s.id === id);

// ---------- small UI helpers ----------
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
async function busy(msg) {
  const l = $('#loader');
  if (!msg) { l.classList.remove('on'); return; }
  l.querySelector('span').textContent = msg; l.classList.add('on'); await nextFrame();
}
function openModal(html, onClose, cls) {
  closeModal();
  const m = $('#modal'); m.innerHTML = '<div class="back" data-act="close"></div><div class="mod' + (cls ? ' ' + cls : '') + '">' + html + '</div>'; m.classList.add('on');
  m._onClose = onClose || null;
}
function closeModal() {
  const m = $('#modal'); if (!m.classList.contains('on')) return;
  m.classList.remove('on'); m.innerHTML = ''; const f = m._onClose; m._onClose = null; if (f) f();
}
const money = (n) => (cfg.currency || '') + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------- photos in the tray ----------
async function addFile(file) {
  if (!file || (file.type && !file.type.startsWith('image/'))) return false;
  try {
    const thumb = await I.thumbURL(file);
    const p = { id: 'p' + (++seq), blob: file, name: file.name || 'photo.jpg', thumb, copies: 1 };
    state.photos.push(p);
    if (state.mode === 'id') state.sel = p.id;
    if (state.screen === 'add' || state.screen === 'photos') render();
    I.preload();
    return true;
  } catch (e) { toast(e.message || 'Could not open that photo.'); return false; }
}
async function addFiles(files) {
  let n = 0; await busy('Adding photos…');
  for (const f of files) if (await addFile(f)) n++;
  await busy('');
  if (n) toast(n + (n === 1 ? ' photo added' : ' photos added'));
}
function removePhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id); if (i < 0) return;
  URL.revokeObjectURL(state.photos[i].thumb); state.photos.splice(i, 1);
  if (state.sel === id) state.sel = state.photos.length ? state.photos[state.photos.length - 1].id : null;
}
async function getWork(p) {
  if (!p._work) {
    p._work = I.decodeFile(p.blob, 2400).then((c) => ({ img: c, w: c.width, h: c.height, cut: null, conf: null, face: undefined }));
    p._work.catch(() => { p._work = null; });
  }
  return p._work;
}

function resetAll() {
  closeModal(); stopCamera();
  if (stopWatch) { stopWatch(); stopWatch = null; }
  if (phone) { phone.stop(); phone = null; }
  state.photos.forEach((p) => URL.revokeObjectURL(p.thumb));
  Object.assign(state, { screen: 'home', photos: [], sel: null, id: freshId(), photo: { size: '4x6', fit: 'fill' }, sets: 1, out: null });
  idWork = null; busy('');
  render();
}

// ---------- screens ----------
const STEPS = { id: ['Photo', 'Frame', 'Print'], photo: ['Photos', 'Size', 'Print'] };
// Android app: turn the screen between portrait and landscape.
const rotBtn = () => (hw && hw.canRotate && hw.canRotate() ? '<button class="btn ghost sm icon" data-act="rot" title="Turn the screen: portrait or landscape" aria-label="Turn the screen">⟳</button>' : '');
function header() {
  const idx = { add: 0, id: 1, photos: 1, review: 2 }[state.screen];
  const steps = STEPS[state.mode].map((t, i) => '<li class="' + (i === idx ? 'on' : i < idx ? 'done' : '') + '"><b>' + (i + 1) + '</b>' + t + '</li>').join('');
  return '<header class="top"><div class="brand" data-act="brand">' + esc(cfg.shop) + '</div><ol class="steps">' + steps + '</ol>' + rotBtn() + '<button class="btn ghost sm" data-act="reset">Start over</button></header>';
}

function homeHTML() {
  return '<main class="home"><div class="corner">' + rotBtn() + '</div><div class="brand big" data-act="brand">' + esc(cfg.shop) + '</div>' +
    '<p class="lead">Self-service · no staff needed</p>' +
    '<div class="tiles">' +
    '<button class="tile" data-act="start" data-mode="id"><span class="ic">🪪</span><b>Rush ID photo</b><small>Passport, 2×2, 1×1 and more. Plain background.</small></button>' +
    '<button class="tile" data-act="start" data-mode="photo"><span class="ic">🖼️</span><b>Print photos</b><small>4×6, 5×7, 6×8, wallet and strips.</small></button>' +
    '</div>' +
    '<p class="hint">Bring photos on a <b>USB drive</b>, <b>SD card</b>, by <b>Bluetooth</b>, or send them from your phone with a <b>QR code</b>. Or take a picture here.</p></main>';
}

function addHTML() {
  const id = state.mode === 'id';
  const thumbs = state.photos.map((p) => '<div class="thumb' + (id && state.sel === p.id ? ' sel' : '') + '" data-act="pick" data-id="' + p.id + '"><img src="' + p.thumb + '" alt=""><button class="x" data-act="rm" data-id="' + p.id + '" aria-label="Remove">×</button></div>').join('');
  const ok = id ? !!state.sel : state.photos.length > 0;
  const src = (act, ic, t, s) => '<button class="src" data-act="' + act + '"><span class="ic">' + ic + '</span><span class="t"><b>' + t + '</b><small>' + s + '</small></span></button>';
  return '<main class="add">' +
    '<h2>' + (id ? 'Choose the photo for your ID' : 'Add the photos you want to print') + '</h2>' +
    '<div class="sources">' + src('src-cam', '📷', 'Take a photo', 'Use this camera') + src('src-usb', '💾', 'USB / SD card', 'Drive or card reader') + src('src-bt', '🔵', 'Bluetooth', 'Send from your phone') + src('src-qr', '📱', 'Phone (QR)', 'Scan and upload') + '</div>' +
    '<div class="trayhead"><b>' + (state.photos.length ? state.photos.length + (state.photos.length === 1 ? ' photo' : ' photos') : 'No photos yet') + '</b>' + (id && state.photos.length > 1 ? '<span class="hint">Tap the one to use</span>' : '') + '</div>' +
    '<div class="tray' + (thumbs ? '' : ' empty') + '">' + (thumbs || '<p>Your photos will show up here.</p>') + '</div>' +
    '</main><footer class="bar"><button class="btn ghost" data-act="reset">Back</button><button class="btn primary big" data-act="next-add"' + (ok ? '' : ' disabled') + '>Next →</button></footer>';
}

function idHTML() {
  const t = (act, on, label) => '<button class="tb' + (on ? ' on' : '') + '" data-act="' + act + '">' + label + '</button>';
  return '<main class="editor"><div class="stagecol"><div class="stagewrap" id="stagewrap"><div class="stagebox" id="stagebox"><canvas id="stage"></canvas><canvas id="guide"></canvas></div></div>' +
    '<div class="toolbar">' + t('flip', state.id.flip, '↔ Mirror') + t('autofit', false, '◎ Auto-fit') + t('guide', state.id.guides, '◌ Guide') + t('retake', false, '📷 Retake') + '</div>' +
    '<div class="zoomrow" title="Drag the photo to move it. Pinch or use the slider to zoom."><span>−</span><input type="range" id="zoom" min="0" max="100" value="40" data-in="zoom" aria-label="Zoom"><span>＋</span></div></div>' +
    '<div class="panel" id="panel"></div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="to-add">← Photos</button><button class="btn primary big" data-act="id-preview">See my print →</button></footer>';
}

const SWATCHES = [['#ffffff', 'White'], ['#cfe5f7', 'Light blue'], ['#2457b8', 'Blue'], ['#c8202b', 'Red'], ['#d9d9d9', 'Gray']];
const TABS = [['size', 'Size & copies'], ['bg', 'Background'], ['fine', 'Fine-tune']];
function idPanelHTML() {
  const tab = state.id.tab, q = state.id.qty;
  let body = '';
  if (tab === 'size') {
    const chips = L.PACKAGES.map((p) => '<button class="chip' + (state.id.pkg === p.id ? ' on' : '') + '" data-act="pkg" data-id="' + p.id + '">' + p.label + '</button>').join('');
    const cells = L.ID_SIZES.map((s) => '<div class="qcell"><span>' + s.label + '</span><div class="stepper"><button data-act="qty" data-id="' + s.id + '" data-d="-1" aria-label="Fewer">−</button><b' + ((q[s.id] || 0) > 0 ? ' class="on"' : '') + '>' + (q[s.id] || 0) + '</b><button data-act="qty" data-id="' + s.id + '" data-d="1" aria-label="More">＋</button></div></div>').join('');
    body = '<div class="chips">' + chips + '</div><div class="qgrid">' + cells + '</div>';
  } else if (tab === 'bg') {
    const preset = SWATCHES.some(([c]) => c === state.id.bg.toLowerCase());
    body = '<div class="swatches">' + SWATCHES.map(([c, n]) => '<button class="sw' + (state.id.bgMode === 'color' && state.id.bg.toLowerCase() === c ? ' on' : '') + '" style="--c:' + c + '" data-act="bg" data-c="' + c + '" title="' + n + '"><i></i><small>' + n + '</small></button>').join('') +
      '<label class="sw custom' + (state.id.bgMode === 'color' && !preset ? ' on' : '') + '" title="Pick any colour"><i style="--c:' + state.id.bg + '"><input type="color" value="' + state.id.bg + '" data-in="custombg" aria-label="Custom colour"></i><small>Custom</small></label>' +
      '<button class="sw orig' + (state.id.bgMode === 'original' ? ' on' : '') + '" data-act="bg" data-c="original"><i>🏞️</i><small>Keep mine</small></button></div>' +
      '<p class="hint">The background is made plain automatically. Pick the colour your ID needs.</p>';
  } else {
    const cut = state.id.bgMode !== 'original';
    body = '<label class="sl"><span>Brightness</span><input type="range" min="-30" max="30" value="' + state.id.brightness + '" data-in="brightness"></label>' +
      '<label class="sl"><span>Contrast</span><input type="range" min="-30" max="30" value="' + state.id.contrast + '" data-in="contrast"></label>' +
      (cut ? '<label class="sl"><span>Edge clean-up (hair and shoulders)</span><input type="range" min="-10" max="10" value="' + Math.round(state.id.edge * 10) + '" data-in="edge"></label>' : '') +
      '<button class="btn ghost sm" data-act="reset-fine">Reset</button>';
  }
  return '<div class="tabs">' + TABS.map(([k, n]) => '<button class="tab' + (tab === k ? ' on' : '') + '" data-act="tab" data-id="' + k + '">' + n + '</button>').join('') + '</div><div class="tabbody">' + body + '</div>';
}

function photosHTML() {
  const cards = state.photos.map((p) => '<div class="pcard"><div class="thumb"><img class="' + (p.flip ? 'flip' : '') + '" src="' + p.thumb + '" alt=""><button class="fl' + (p.flip ? ' on' : '') + '" data-act="pflip" data-id="' + p.id + '" aria-label="Mirror this photo" title="Mirror">↔</button><button class="x" data-act="rm" data-id="' + p.id + '" aria-label="Remove">×</button></div>' +
    '<div class="stepper"><button data-act="copies" data-id="' + p.id + '" data-d="-1">−</button><b>' + p.copies + '</b><button data-act="copies" data-id="' + p.id + '" data-d="1">＋</button></div></div>').join('');
  const sizes = L.PHOTO_SIZES.map((s) => '<button class="opt' + (state.photo.size === s.id ? ' on' : '') + '" data-act="psize" data-id="' + s.id + '"><b>' + s.label + '</b>' + (s.hint ? '<small>' + s.hint + '</small>' : '') + (cfg.prices[s.id] ? '<em>' + money(cfg.prices[s.id]) + ' each</em>' : '') + '</button>').join('');
  return '<main class="photos"><div class="pl"><h3>Copies of each photo</h3><div class="pgrid">' + cards + '</div><button class="btn ghost sm" data-act="to-add">＋ Add more photos</button></div>' +
    '<div class="pr"><h3>Print size</h3><div class="opts">' + sizes + '</div>' +
    '<h3>How should it fit?</h3><div class="seg"><button class="' + (state.photo.fit === 'fill' ? 'on' : '') + '" data-act="pfit" data-id="fill">Fill the page<small>trims the edges</small></button><button class="' + (state.photo.fit === 'fit' ? 'on' : '') + '" data-act="pfit" data-id="fit">Whole photo<small>white borders</small></button></div></div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="to-add">← Photos</button><button class="btn primary big" data-act="photo-preview">See my print →</button></footer>';
}

function reviewHTML() {
  const o = state.out; if (!o) return '';
  const prev = o.canvases.map((c, i) => '<figure><img src="' + c.toDataURL('image/jpeg', 0.7) + '" alt="Sheet ' + (i + 1) + '"><figcaption>' + (o.canvases.length > 1 ? 'Sheet ' + (i + 1) + ' of ' + o.canvases.length : 'Sheet') + '</figcaption></figure>').join('');
  const total = o.unitPrice ? o.unitPrice * state.sets : 0;
  // Paper can be changed here for an ID (a photo's paper follows its size). Inside the booth only the papers Admin allows are listed.
  const paper = state.mode === 'id' && L.PAPERS.length > 1
    ? '<label class="fld"><span>Paper</span><select data-in="paper">' + L.PAPERS.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === o.paper.id ? ' selected' : '') + '>' + esc(p.label) + '</option>').join('') + '</select></label>'
    : '<p class="paper">Paper: <b>' + esc(o.paper.label) + '</b></p>';
  return '<main class="review"><div class="prev">' + prev + '</div><div class="sum"><h3>Your print</h3><ul>' + o.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' +
    '<p class="paper">' + o.canvases.length + (o.canvases.length === 1 ? ' sheet' : ' sheets') + '</p>' + paper +
    (hw ? '<div class="fld" id="printerBox"><span>Printer</span><p class="paper">Looking for printers…</p></div>' : '') +
    '<div class="qrow"><span>How many sets?</span><div class="stepper"><button data-act="sets" data-d="-1">−</button><b>' + state.sets + '</b><button data-act="sets" data-d="1">＋</button></div></div>' +
    (total ? '<p class="total">Total <b>' + money(total) + '</b></p>' : '') +
    '<button class="btn primary big wide" data-act="print">🖨️ Print</button>' +
    '<button class="btn ghost wide" data-act="save">Save as JPG</button></div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="back-review">← Change something</button><span></span></footer>';
}

// Which printer this paper prints on (the booth's per-paper printer). With the Print Helper every installed printer is listed.
async function fillPrinterBox() {
  const box = $('#printerBox'); if (!box || !hw || !state.out) return;
  let info; try { info = await hw.printers(state.out.paper.id); } catch (e) { return; }
  const b = $('#printerBox'); if (!b) return;
  if (info.options.length) {
    const opts = info.options.slice(); if (info.current && !opts.includes(info.current)) opts.unshift(info.current);
    b.innerHTML = '<span>Printer</span><select data-in="printer"><option value="">Choose a printer…</option>' + opts.map((n) => '<option value="' + esc(n) + '"' + (n === info.current ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>';
  } else {
    const t = { station: 'Print station', wifi: 'Wi-Fi printer: ' + (info.current || ''), android: 'Android print screen (choose the printer when it opens)', browser: info.current || 'This device’s print dialog' }[info.mode] || '';
    b.innerHTML = '<span>Printer</span><p class="paper">' + esc(t) + '</p>';
  }
}

function render() {
  const s = state.screen, app = $('#app');
  app.className = 's-' + s;
  app.innerHTML = s === 'home' ? homeHTML() : header() + ({ add: addHTML, id: idHTML, photos: photosHTML, review: reviewHTML }[s])();
  if (s === 'id') mountId();
  if (s === 'review') fillPrinterBox();
}
function go(s) { state.screen = s; render(); }

// ---------- ID editor ----------
const idAspect = () => {
  const act = L.ID_SIZES.filter((s) => (state.id.qty[s.id] || 0) > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0] || L.ID_SIZES[2];
  return act.w / act.h;
};
const idOpts = () => ({ crop: state.id.crop, bg: state.id.bgMode === 'original' ? null : state.id.bg, brightness: state.id.brightness, contrast: state.id.contrast, flip: state.id.flip });
const hRange = () => ({ min: idWork.h * 0.15, max: Math.max(idWork.h, idWork.w / idAspect()) * 1.8 });
const clampH = (h) => { const r = hRange(); return Math.min(r.max, Math.max(r.min, h)); };

function syncZoom() {
  const z = $('#zoom'); if (!z || !idWork || !state.id.crop) return;
  const r = hRange(); z.value = Math.round(100 * Math.log(state.id.crop.h / r.max) / Math.log(r.min / r.max));
}
function sizeStage() {
  const c = $('#stage'), g = $('#guide'), wrap = $('#stagewrap'); if (!c || !wrap) return;
  const a = idAspect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const aw = Math.max(120, wrap.clientWidth - 6), ah = Math.max(120, wrap.clientHeight - 6);
  let h = ah, w = h * a; if (w > aw) { w = aw; h = w / a; }
  w = Math.floor(w); h = Math.floor(h);
  for (const el of [c, g]) { el.style.width = w + 'px'; el.style.height = h + 'px'; el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
  $('#stagebox').style.width = w + 'px'; $('#stagebox').style.height = h + 'px';
}
function drawGuide() {
  const g = $('#guide'); if (!g) return; const x = g.getContext('2d'); x.clearRect(0, 0, g.width, g.height);
  if (!state.id.guides) return;
  const w = g.width, h = g.height, T = I.HEAD_TARGET;
  x.lineWidth = Math.max(2, h / 220); x.setLineDash([h / 40, h / 60]);
  x.strokeStyle = 'rgba(255,255,255,.95)'; x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 3;
  x.beginPath(); x.ellipse(w / 2, h * (T.top + T.chin) / 2, h * 0.25, h * (T.chin - T.top) / 2, 0, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.moveTo(w * 0.15, h * 0.42); x.lineTo(w * 0.85, h * 0.42); x.stroke();
}
let drawT = 0;
function drawStage() {
  if (drawT) return;
  drawT = setTimeout(() => {      // coalesces bursts of drag / slider events into one draw
    drawT = 0; const c = $('#stage'); if (!c || !idWork || !state.id.crop) return;
    I.drawId(c.getContext('2d'), idWork, idOpts(), c.width, c.height); drawGuide();
  }, 16);
}
function renderIdPanel() { const p = $('#panel'); if (p) p.innerHTML = idPanelHTML(); }

function mountId() {
  renderIdPanel(); sizeStage();
  const box = $('#stagebox'), ptrs = new Map(); let pinch = null;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  box.onpointerdown = (e) => { box.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2 && state.id.crop) pinch = { d: dist(), h: state.id.crop.h }; };
  box.onpointermove = (e) => {
    if (!ptrs.has(e.pointerId) || !state.id.crop) return;
    const p = ptrs.get(e.pointerId), dx = e.clientX - p.x, dy = e.clientY - p.y; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cr = state.id.crop;
    if (ptrs.size === 1) { const k = cr.h / box.clientHeight; cr.cx -= dx * k * (state.id.flip ? -1 : 1); cr.cy -= dy * k; }
    else if (pinch) { cr.h = clampH(pinch.h * pinch.d / dist()); syncZoom(); }
    drawStage();
  };
  const up = (e) => { ptrs.delete(e.pointerId); pinch = null; };
  box.onpointerup = up; box.onpointercancel = up;
  box.onwheel = (e) => { if (!state.id.crop) return; e.preventDefault(); state.id.crop.h = clampH(state.id.crop.h * (1 + e.deltaY * 0.0012)); syncZoom(); drawStage(); };
  openId();
}

async function openId() {
  const p = photoById(state.sel); if (!p) { go('add'); return; }
  const live = () => state.screen === 'id' && state.sel === p.id;
  await busy('Opening your photo…');
  try { idWork = await getWork(p); } catch (e) { await busy(''); toast(e.message); go('add'); return; }
  if (!live()) { await busy(''); return; }
  sizeStage();
  if (state.id.cropFor !== p.id) {
    if (idWork.face === undefined) {
      await busy('Finding your face…');
      try { idWork.face = await I.findFace(idWork.img); } catch (e) { console.error(e); idWork.face = null; }
      if (!live()) { await busy(''); return; }
    }
    state.id.crop = I.autoCrop(idWork.face, idWork.w, idWork.h, idAspect()); state.id.cropFor = p.id;
    if (!idWork.face) toast('We could not find a face. Move and zoom the photo to line it up.');
  }
  syncZoom(); drawStage();
  if (state.id.bgMode !== 'original') { await ensureCut(); if (live()) drawStage(); }
  await busy('');
}

async function ensureCut() {
  const w = idWork; if (!w || w.cut) return true;
  await busy('Making the background plain…');
  try { w.conf = await I.personConfidence(w.img); w.cut = I.makeCutout(w.img, w.conf, state.id.edge); return true; }
  catch (e) { console.error(e); toast('Could not change the background. Using your original.'); state.id.bgMode = 'original'; renderIdPanel(); return false; }
  finally { await busy(''); }
}

// ---------- building the sheets ----------
const gapPx = () => Math.round(cfg.gapMm / 25.4 * L.DPI), marginPx = () => Math.round(cfg.marginMm / 25.4 * L.DPI);

async function buildId() {
  const sizes = L.ID_SIZES.filter((s) => (state.id.qty[s.id] || 0) > 0);
  if (!sizes.length) { toast('Choose at least one photo size.'); return; }
  if (state.id.bgMode !== 'original' && !(await ensureCut())) { drawStage(); }
  await busy('Preparing your print…');
  try {
    const paper = L.paperById(cfg.idPaper), items = [], cache = {};
    for (const s of sizes) {
      const w = L.px(s.w), h = L.px(s.h), c = document.createElement('canvas'); c.width = w; c.height = h;
      I.drawId(c.getContext('2d'), idWork, idOpts(), w, h); cache[s.id] = c;
      for (let i = 0; i < state.id.qty[s.id]; i++) items.push({ w, h, size: s.id });
    }
    const sheets = L.pack(items, L.px(paper.w), L.px(paper.h), gapPx(), marginPx());
    if (!sheets) { toast('That size does not fit on the ' + paper.label + ' paper.'); return; }
    state.out = {
      kind: 'id', paper, canvases: L.renderSheets(sheets, (ctx, it, x, y) => ctx.drawImage(cache[it.size], x, y), { cutGuides: cfg.cutGuides }),
      lines: sizes.map((s) => state.id.qty[s.id] + ' × ' + s.label), unitPrice: 0,
    };
    state.out.unitPrice = cfg.prices.idSheet ? cfg.prices.idSheet * state.out.canvases.length : 0;
    state.sets = 1; go('review');
  } finally { await busy(''); }
}

function paintPhoto(ctx, it, x, y) {
  const src = it.work.img, iw = src.width, ih = src.height, w = it.w, h = it.h;
  const rot = it.full && iw > ih, ew = rot ? ih : iw, eh = rot ? iw : ih;
  const k = it.fit === 'fit' ? Math.min(w / ew, h / eh) : Math.max(w / ew, h / eh);
  const dw = ew * k, dh = eh * k, dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.imageSmoothingQuality = 'high';
  if (it.flip) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }          // mirror about the middle of this print
  if (rot) { ctx.translate(dx + dw, dy); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0, dh, dw); }
  else ctx.drawImage(src, dx, dy, dw, dh);
  ctx.restore();
}

async function buildPhotos() {
  const size = L.PHOTO_SIZES.find((s) => s.id === state.photo.size), paper = L.paperById(size.paper);
  const items = []; let n = 0, prints = 0;
  try {
    for (const p of state.photos) {
      await busy('Preparing photo ' + (++n) + ' of ' + state.photos.length + '…');
      const work = await getWork(p);
      for (let c = 0; c < p.copies; c++) for (let d = 0; d < (size.dup || 1); d++) items.push({ w: L.px(size.w), h: L.px(size.h), work, full: !!size.full, fit: state.photo.fit, flip: !!p.flip });
      prints += p.copies;
    }
    const sheets = L.pack(items, L.px(paper.w), L.px(paper.h), 0, 0);
    if (!sheets) { toast('That size does not fit on the paper.'); return; }
    state.out = {
      kind: 'photo', paper, canvases: L.renderSheets(sheets, paintPhoto, { cutGuides: !size.full }),
      lines: [prints + ' × ' + size.label + (state.photos.length > 1 ? ' (' + state.photos.length + ' photos)' : '')], unitPrice: (cfg.prices[size.id] || 0) * prints,
    };
    state.sets = 1; go('review');
  } catch (e) { toast(e.message || 'Could not prepare the photos.'); }
  finally { await busy(''); }
}

// ---------- camera ----------
function stopCamera() { if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; } }
async function startCamera(deviceId) {
  stopCamera();
  const v = $('#camv'); if (!v) return;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' }, audio: false });
    v.srcObject = camStream; await v.play().catch(() => {});
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('#camsel');
    if (sel) { sel.innerHTML = cams.map((d, i) => '<option value="' + esc(d.deviceId) + '">' + esc(d.label || 'Camera ' + (i + 1)) + '</option>').join(''); sel.style.display = cams.length > 1 ? '' : 'none'; const cur = camStream.getVideoTracks()[0].getSettings().deviceId; if (cur) sel.value = cur; }
  } catch (e) { const m = $('#camerr'); if (m) m.textContent = 'The camera could not be opened. Allow camera access in the browser, or use another way to add photos.'; }
}
// Inside the booth: the live picture is the booth's own (whichever camera is chosen in its Setup), and the photo is taken the booth's way.
let camTimer = 0;
function openCameraHW() {
  openModal('<h2>Take a photo</h2><div class="camwrap"><canvas id="camv"></canvas>' + (state.mode === 'id' ? '<div class="camguide"></div>' : '') + '<div id="camcount"></div></div><p id="camerr" class="err"></p>' +
    '<div class="mrow"><button class="btn primary big" data-act="snap">📸 Take photo</button><button class="btn ghost" data-act="close">Close</button></div>', () => clearInterval(camTimer), 'cam');
  const cv = $('#camv'), v = hw.video, x = cv.getContext('2d');
  if (hw.mirror()) cv.style.transform = 'scaleX(-1)';
  const draw = () => {
    const err = $('#camerr'); if (!cv.isConnected) return;
    if (v.videoWidth) { if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; } x.drawImage(v, 0, 0); if (err) err.textContent = ''; }
    else if (err) err.textContent = 'The camera is not ready. Staff: choose it in Setup (tap the shop name 5 times, then the Setup button).';
  };
  clearInterval(camTimer); camTimer = setInterval(draw, 40); draw();
}
// After a photo is taken on the ID screen (Retake), open it in the editor.
function afterSnap(ok) {
  if (!ok) return;
  if (state.mode === 'id') { closeModal(); toast('Photo taken'); if (state.screen === 'id') { state.id.cropFor = null; render(); } } else toast('Photo added. Take another or close.');
}
async function snapHW() {
  const cc = $('#camcount'), btn = $('[data-act=snap]'); if (!cc || !btn || btn.disabled) return;
  btn.disabled = true;
  for (let i = 3; i > 0; i--) { cc.textContent = i; cc.classList.add('on'); await new Promise((r) => setTimeout(r, 900)); }
  cc.classList.remove('on');
  try {
    const c = await hw.capture();
    const blob = await I.canvasToBlob(c, 'image/jpeg', 0.95);
    afterSnap(await addFile(new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' })));
  } catch (e) { toast((e && e.message) || 'The camera could not take the photo.', 5000); }
  const b2 = $('[data-act=snap]'); if (b2) b2.disabled = false;
}
function openCamera() {
  openModal('<h2>Take a photo</h2><div class="camwrap"><video id="camv" autoplay playsinline muted></video>' + (state.mode === 'id' ? '<div class="camguide"></div>' : '') + '<div id="camcount"></div></div><p id="camerr" class="err"></p>' +
    '<div class="mrow"><select id="camsel" data-in="camsel" style="display:none"></select><button class="btn primary big" data-act="snap">📸 Take photo</button><button class="btn ghost" data-act="close">Close</button></div>', stopCamera, 'cam');
  startCamera();
}
async function snap() {
  const v = $('#camv'); if (!v || !v.videoWidth) return;
  const cc = $('#camcount'), btn = $('[data-act=snap]'); btn.disabled = true;
  for (let i = 3; i > 0; i--) { cc.textContent = i; cc.classList.add('on'); await new Promise((r) => setTimeout(r, 900)); }
  cc.classList.remove('on');
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
  const blob = await I.canvasToBlob(c, 'image/jpeg', 0.95);
  btn.disabled = false;
  afterSnap(await addFile(new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' })));
}

// ---------- USB / SD / Bluetooth / QR ----------
function openUsb() {
  openModal('<h2>USB drive or SD card</h2><p>Plug it in, then choose how to pick your photos.</p>' +
    '<div class="mcol"><button class="btn primary big" data-act="pick-files">Choose photos…</button>' +
    (S.canPickFolder() ? '<button class="btn big" data-act="browse">Browse the whole drive / SD card…</button>' : '<p class="hint">Tip: use Chrome or Edge to browse a whole card at once.</p>') +
    '<button class="btn ghost" data-act="close">Close</button></div>' +
    '<input type="file" id="files" accept="image/*" multiple hidden>');
}
const thumbQ = []; let thumbBusy = 0;
function queueThumb(img, handle) {
  thumbQ.push({ img, handle }); pumpThumbs();
}
async function pumpThumbs() {
  while (thumbBusy < 2 && thumbQ.length) {
    const { img, handle } = thumbQ.shift(); thumbBusy++;
    (async () => { try { const f = await handle.getFile(); img.src = await I.thumbURL(f, 240); img.onload = () => URL.revokeObjectURL(img.src); } catch (e) { img.alt = '?'; } })().finally(() => { thumbBusy--; pumpThumbs(); });
  }
}
let browserItems = [];
async function openBrowser(dir) {
  await busy('Looking for photos…');
  try { browserItems = await S.listImages(dir); } catch (e) { browserItems = []; }
  await busy('');
  if (!browserItems.length) { toast('No photos found in that folder.'); return; }
  thumbQ.length = 0;
  openModal('<h2>Pick your photos</h2><p class="hint">' + browserItems.length + ' found in <b>' + esc(dir.name) + '</b>. Tap to select.</p>' +
    '<div class="bgrid">' + browserItems.map((it, i) => '<label class="gi"><input type="checkbox" data-i="' + i + '"><img alt="" data-i="' + i + '"><span>' + esc(it.name) + '</span></label>').join('') + '</div>' +
    '<div class="mrow"><button class="btn ghost" data-act="sel-all">Select all</button><button class="btn primary big" data-act="add-sel">Add selected</button><button class="btn ghost" data-act="close">Close</button></div>');
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); queueThumb(e.target, browserItems[+e.target.dataset.i].handle); } }), { root: $('.bgrid'), rootMargin: '200px' });
  document.querySelectorAll('.bgrid img').forEach((im) => io.observe(im));
}

function openBluetooth() {
  const watching = !!stopWatch;
  openModal('<h2>Bluetooth</h2>' +
    '<ol class="how"><li>On your phone, choose the photo, tap <b>Share → Bluetooth</b> and pick <b>this computer</b>.</li>' +
    '<li>On this computer, accept the file (Bluetooth icon in the taskbar → <b>Receive a file</b>) and note the folder it is saved in.</li>' +
    '<li>Tap the button below and choose that folder. New photos are added automatically.</li></ol>' +
    '<p id="btstat" class="ok">' + (watching ? 'Watching for photos…' : '') + '</p>' +
    '<div class="mcol">' + (S.canPickFolder()
      ? '<button class="btn primary big" data-act="bt-watch">' + (watching ? 'Choose another folder' : 'Choose the Bluetooth folder') + '</button>' + (watching ? '<button class="btn" data-act="bt-stop">Stop watching</button>' : '')
      : '<p class="err">This browser cannot watch a folder. Use Chrome or Edge, or use the QR option.</p>') +
    '<button class="btn ghost" data-act="close">Close</button></div>');
}

function qrSvg(text) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
async function openQR() {
  openModal('<h2>Send from your phone</h2><div class="qrbox" id="qrbox"><p>Starting…</p></div>' +
    '<ol class="how"><li>Point your phone camera at the code.</li><li>Open the link, choose your photos and tap <b>Send</b>.</li><li>They appear here in a few seconds.</li></ol>' +
    '<p id="qrstat" class="ok"></p><div class="mrow"><button class="btn primary big" data-act="close">Done</button></div>');
  try {
    if (!phone || !phone.code) {
      phone = new S.PhoneSession(async (f) => { if (await addFile(f)) toast('Photo received from your phone'); }, (st) => {
        const el = $('#qrstat'); if (!el) return;
        el.className = st === 'ok' ? 'ok' : 'err';
        el.textContent = st === 'ok' ? (phone && phone.count ? phone.count + ' photo' + (phone.count === 1 ? '' : 's') + ' received' : 'Waiting for your photos…') : st === 'expired' ? 'This code expired. Close and open QR again.' : 'Cannot reach the internet. Check the connection.';
      });
      await phone.start();
    }
    $('#qrbox').innerHTML = qrSvg(phone.url) + '<p class="code">' + phone.code + '</p><p class="hint">' + esc(phone.url.replace(/^https?:\/\//, '')) + '</p>';
    $('#qrstat').textContent = phone.count ? phone.count + ' photos received' : 'Waiting for your photos…'; $('#qrstat').className = 'ok';
  } catch (e) { const b = $('#qrbox'); if (b) b.innerHTML = '<p class="err">Could not start. Check the internet connection and try again.</p>'; phone = null; }
}

// ---------- settings (hidden: tap the shop name 5 times) ----------
let taps = 0, tapT = 0;
function brandTap() {
  clearTimeout(tapT); tapT = setTimeout(() => { taps = 0; }, 2500);
  if (++taps >= 5) { taps = 0; openModal('<h2>Staff only</h2><p>Enter the PIN.</p><div class="mcol"><input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN"><button class="btn primary big" data-act="pin-ok">Open settings</button><button class="btn ghost" data-act="close">Cancel</button></div>'); setTimeout(() => $('#pin') && $('#pin').focus(), 50); }
}
function openSettings() {
  const pr = cfg.prices, pap = L.PAPERS.map((p) => '<option value="' + p.id + '"' + (cfg.idPaper === p.id ? ' selected' : '') + '>' + p.label + '</option>').join('');
  const num = (k, v) => '<input type="number" min="0" step="any" data-k="' + k + '" value="' + v + '">';
  openModal('<h2>Settings</h2><div class="form">' +
    '<label>Shop name<input data-k="shop" value="' + esc(cfg.shop) + '"></label>' +
    '<label>Currency symbol<input data-k="currency" value="' + esc(cfg.currency) + '" maxlength="4"></label>' +
    '<label>Staff PIN<input data-k="pin" value="' + esc(cfg.pin) + '"></label>' +
    '<label>Clear photos after idle (seconds, 0 = never)' + num('idle', cfg.idle) + '</label>' +
    '<label>Paper for ID sheets<select data-k="idPaper">' + pap + '</select></label>' +
    '<label>Gap between ID photos (mm)' + num('gapMm', cfg.gapMm) + '</label>' +
    '<label>Paper margin (mm)' + num('marginMm', cfg.marginMm) + '</label>' +
    '<label class="chk"><input type="checkbox" data-k="cutGuides"' + (cfg.cutGuides ? ' checked' : '') + '> Draw thin cutting lines between ID photos</label>' +
    '<h3>Prices (0 = do not show)</h3>' +
    '<label>Per ID sheet' + num('p.idSheet', pr.idSheet) + '</label>' +
    L.PHOTO_SIZES.map((s) => '<label>Photo ' + s.label + ' (each)' + num('p.' + s.id, pr[s.id] || 0) + '</label>').join('') +
    '</div>' + (hw ? '<div class="mcol"><button class="btn" data-act="hw-setup">Cameras &amp; printers: open the booth Setup</button></div>' : '') +
    '<div class="mrow"><button class="btn primary big" data-act="save-cfg">Save</button><button class="btn ghost" data-act="close">Cancel</button></div>');
}
function saveSettings() {
  document.querySelectorAll('#modal [data-k]').forEach((el) => {
    const k = el.dataset.k, v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, Number(el.value) || 0) : el.value;
    if (k.startsWith('p.')) cfg.prices[k.slice(2)] = v; else cfg[k] = v;
  });
  if (!cfg.pin) cfg.pin = '1234';
  saveCfg(); closeModal(); toast('Settings saved'); render();
}

// ---------- idle: clear a customer's photos if they walk away ----------
let lastTouch = Date.now();
['pointerdown', 'keydown', 'wheel'].forEach((ev) => addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true }));
setInterval(() => {
  if (!cfg.idle || state.screen === 'home' || $('#modal').classList.contains('on') && $('#modal').dataset.idle) return;
  if (Date.now() - lastTouch < cfg.idle * 1000) return;
  let left = 15;
  openModal('<h2>Still there?</h2><p>Your photos will be cleared in <b id="idleleft">' + left + '</b> seconds so nobody else can see them.</p><div class="mrow"><button class="btn primary big" data-act="close">I am still here</button></div>');
  $('#modal').dataset.idle = '1';
  const t = setInterval(() => {
    const el = $('#idleleft');
    if (!el || !$('#modal').dataset.idle) { clearInterval(t); delete $('#modal').dataset.idle; lastTouch = Date.now(); return; }
    el.textContent = --left; if (left <= 0) { clearInterval(t); delete $('#modal').dataset.idle; resetAll(); }
  }, 1000);
}, 5000);

// ---------- actions ----------
const acts = {
  brand: brandTap,
  close: () => { delete $('#modal').dataset.idle; closeModal(); },
  reset: () => { if (!state.photos.length || confirm('Clear everything and start over?')) resetAll(); },
  start: (b) => { if (noPrint()) { toast(NO_PRINT_MSG, 6000); return; } state.mode = b.dataset.mode; state.screen = 'add'; I.preload(); render(); },
  pick: (b) => { if (state.mode === 'id') { state.sel = b.dataset.id; render(); } },
  rm: (b, e) => { e.stopPropagation(); removePhoto(b.dataset.id); if (!state.photos.length && state.screen === 'photos') go('add'); else render(); },
  'next-add': () => { if (state.mode === 'id') { state.id.cropFor = null; go('id'); } else go('photos'); },
  'to-add': () => go('add'),
  'src-cam': () => (hw ? openCameraHW() : openCamera()), 'src-usb': openUsb, 'src-bt': openBluetooth, 'src-qr': openQR,
  snap: () => (hw ? snapHW() : snap()),
  'pick-files': () => $('#files').click(),
  browse: async () => { const d = await S.pickFolder('rushid-usb'); if (d) openBrowser(d); },
  'sel-all': () => document.querySelectorAll('.bgrid input').forEach((i) => { i.checked = true; }),
  'add-sel': async () => {
    const hs = [...document.querySelectorAll('.bgrid input:checked')].map((i) => browserItems[+i.dataset.i].handle);
    if (!hs.length) { toast('Tap the photos you want first.'); return; }
    closeModal(); await busy('Adding photos…'); let n = 0;
    for (const h of hs) { try { if (await addFile(await h.getFile())) n++; } catch (e) { /* skip */ } }
    await busy(''); toast(n + (n === 1 ? ' photo added' : ' photos added'));
  },
  'bt-watch': async () => {
    const d = await S.pickFolder('rushid-bt'); if (!d) return;
    if (stopWatch) stopWatch();
    stopWatch = S.watchFolder(d, async (f) => { if (await addFile(f)) toast('Photo received by Bluetooth'); });
    openBluetooth(); $('#btstat').textContent = 'Watching “' + d.name + '”. Send your photos now.';
  },
  'bt-stop': () => { if (stopWatch) { stopWatch(); stopWatch = null; } openBluetooth(); },
  pkg: (b) => { const p = L.PACKAGES.find((x) => x.id === b.dataset.id); state.id.qty = { ...p.qty }; state.id.pkg = p.id; renderIdPanel(); sizeStage(); drawStage(); },
  qty: (b) => { const id = b.dataset.id; state.id.qty[id] = Math.min(30, Math.max(0, (state.id.qty[id] || 0) + Number(b.dataset.d))); state.id.pkg = 'custom'; renderIdPanel(); sizeStage(); drawStage(); },
  bg: async (b) => {
    const c = b.dataset.c;
    if (c === 'original') state.id.bgMode = 'original'; else { state.id.bgMode = 'color'; state.id.bg = c; }
    renderIdPanel(); drawStage();
    if (c !== 'original' && idWork && !idWork.cut) { await ensureCut(); drawStage(); }
  },
  autofit: () => { if (!idWork) return; state.id.crop = I.autoCrop(idWork.face, idWork.w, idWork.h, idAspect()); syncZoom(); drawStage(); if (!idWork.face) toast('No face found. Move the photo by hand.'); },
  'id-preview': buildId,
  copies: (b) => { const p = photoById(b.dataset.id); p.copies = Math.min(50, Math.max(1, p.copies + Number(b.dataset.d))); render(); },
  psize: (b) => { state.photo.size = b.dataset.id; render(); },
  pfit: (b) => { state.photo.fit = b.dataset.id; render(); },
  'photo-preview': buildPhotos,
  sets: (b) => { state.sets = Math.min(20, Math.max(1, state.sets + Number(b.dataset.d))); render(); },
  'back-review': () => go(state.mode === 'id' ? 'id' : 'photos'),
  print: async () => {
    const o = state.out;
    if (hw) {
      await busy('Sending to the printer…');
      let r; try { r = await hw.print(o.canvases, o.paper.id, state.sets); } catch (e) { r = { ok: false, msg: (e && e.message) || 'Could not print.' }; }
      await busy('');
      if (!r.ok) { toast(r.msg, 7000); return; }
    } else {
      try { await P.printSheets(o.canvases, o.paper, state.sets); } catch (e) { toast('Could not print: ' + (e.message || e)); return; }
    }
    openModal('<h2>Printing…</h2><p>Check the printer. When you have your prints, clear your photos from this screen.</p><div class="mrow"><button class="btn" data-act="close">Print again</button><button class="btn primary big" data-act="finish">Finish &amp; clear my photos</button></div>');
  },
  finish: () => resetAll(),
  save: async () => { await P.downloadSheets(state.out.canvases, state.mode === 'id' ? 'id-photo' : 'photo-print'); toast('Saved'); },
  'pin-ok': () => { if ($('#pin').value === String(cfg.pin)) openSettings(); else { $('#pin').value = ''; toast('Wrong PIN'); } },
  'save-cfg': saveSettings,
  'hw-setup': () => { closeModal(); hw.openSetup(); },
  tab: (b) => { state.id.tab = b.dataset.id; renderIdPanel(); },
  flip: (b) => { state.id.flip = !state.id.flip; b.classList.toggle('on', state.id.flip); drawStage(); },
  guide: (b) => { state.id.guides = !state.id.guides; b.classList.toggle('on', state.id.guides); drawStage(); },
  retake: () => (hw ? openCameraHW() : openCamera()),
  pflip: (b, e) => { e.stopPropagation(); const p = photoById(b.dataset.id); if (p) { p.flip = !p.flip; render(); } },
  'reset-fine': () => {
    state.id.brightness = 0; state.id.contrast = 0; state.id.edge = 0;
    if (idWork && idWork.conf) idWork.cut = I.makeCutout(idWork.img, idWork.conf, 0);
    renderIdPanel(); drawStage();
  },
  rot: () => { if (hw && hw.canRotate && hw.canRotate()) { const next = innerHeight > innerWidth ? 'landscape' : 'portrait'; hw.setOrientation(next); toast(next === 'portrait' ? 'Portrait' : 'Landscape', 1500); } },
};

const ins = {
  zoom: (el) => { if (!state.id.crop) return; const r = hRange(); state.id.crop.h = r.max * Math.pow(r.min / r.max, el.value / 100); drawStage(); },
  brightness: (el) => { state.id.brightness = Number(el.value); drawStage(); },
  contrast: (el) => { state.id.contrast = Number(el.value); drawStage(); },
  guides: (el) => { state.id.guides = el.checked; drawStage(); },
  edge: (el) => {
    state.id.edge = Number(el.value) / 10;
    if (idWork && idWork.conf) { idWork.cut = I.makeCutout(idWork.img, idWork.conf, state.id.edge); drawStage(); }
  },
  camsel: (el) => startCamera(el.value),
  custombg: (el) => {
    state.id.bg = el.value; state.id.bgMode = 'color';
    const i = el.closest('i'); if (i) i.style.setProperty('--c', el.value);
    drawStage(); if (idWork && !idWork.cut) ensureCut().then(drawStage);
  },
  paper: async (el) => { cfg.idPaper = el.value; saveCfg(); await buildId(); },
  printer: (el) => { if (hw && state.out) { hw.setPrinter(state.out.paper.id, el.value); toast(el.value ? 'Printer: ' + el.value : 'Using the booth’s default printer', 2500); } },
};
const CHANGE_ONLY = ['edge', 'camsel', 'paper', 'printer'];      // selects and the edge slider act when released, not on every move

document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && acts[b.dataset.act]) acts[b.dataset.act](b, e); });
document.addEventListener('input', (e) => { const el = e.target.closest('[data-in]'); if (el && ins[el.dataset.in] && !CHANGE_ONLY.includes(el.dataset.in)) ins[el.dataset.in](el); });
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-in]'); if (el && CHANGE_ONLY.includes(el.dataset.in)) ins[el.dataset.in](el);
  if (el && el.dataset.in === 'custombg') renderIdPanel();
  if (e.target.id === 'files') { const fs = [...e.target.files]; closeModal(); addFiles(fs); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); if (e.key === 'Enter' && $('#pin') && document.activeElement === $('#pin')) acts['pin-ok'](); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); if (state.screen === 'add' || state.screen === 'photos') addFiles([...e.dataTransfer.files]); });
addEventListener('resize', () => { if (state.screen === 'id') { sizeStage(); drawStage(); } });
addEventListener('beforeunload', () => { if (phone) phone.stop(); });

render();
