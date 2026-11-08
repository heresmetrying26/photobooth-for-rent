import * as I from './imaging.js';
import * as L from './layout.js';
import * as P from './print.js';
import * as S from './sources.js';
import hw from './hw.js';
import * as H from './history.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Let the browser paint before heavy work. A timer backs up requestAnimationFrame, which never fires in a hidden tab.
const nextFrame = () => new Promise((r) => { let d = false; const go = () => { if (!d) { d = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 60); });

// ---------- settings (kept on this computer only) ----------
const DEFAULTS = {
  shop: 'Rush ID & Photo Print', currency: '₱', pin: '1234', idle: 180, keepDays: 30,
  idPaper: '4x6', gapMm: 0, marginMm: 0, cutGuides: true, guideStyle: 'lines',
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
const freshId = () => ({
  qty: { ...L.PACKAGES[0].qty },
  pkg: 'p1',
  preset: null,
  bg: '#ffffff',
  bgMode: 'color',
  brightness: 0,
  contrast: 0,
  autoEnhance: false,
  skinSmooth: 0,
  edge: 0,
  crop: null,
  cropFor: null,
  guides: true,
  flip: false,
  tab: 'size',
  tool: 'move',
  brush: 22,
  attire: 'none',
  attireY: 0,
  attireScale: 1,
  nameTag: { on: false, text: '', sub: '' },
});
const freshPhoto = () => ({ size: '4x6', fit: 'fill', tab: 'photos', sel: null, sheet: 0 });
const state = { screen: 'home', mode: 'id', photos: [], sel: null, id: freshId(), photo: freshPhoto(), sets: 1, out: null, orders: [], pinNext: 'settings' };
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
  state.orders.forEach((o) => URL.revokeObjectURL(o.url));
  Object.assign(state, { screen: 'home', photos: [], sel: null, id: freshId(), photo: freshPhoto(), sets: 1, out: null, orders: [] });
  idWork = null; busy('');
  render();
}

// ---------- screens ----------
const STEPS = { id: ['Photo', 'Frame', 'Print'], photo: ['Photos', 'Size', 'Print'] };
// Android app: turn the screen between portrait and landscape.
const isPortrait = () => innerHeight > innerWidth;
const rotBtn = () => (hw && hw.canRotate && hw.canRotate()
  ? '<button class="btn ghost sm rot" data-act="rot" title="Turn the screen between portrait and landscape" aria-label="Turn the screen"><i class="orient ' + (isPortrait() ? 'land' : 'port') + '"></i><span>' + (isPortrait() ? 'Landscape' : 'Portrait') + '</span></button>' : '');
const prnBtn = () => '<button class="btn ghost sm" data-act="printer-modal" title="Printer and camera settings" aria-label="Printer and camera settings">🖨️ / 📷 <span class="lbl">Hardware</span></button>';
function refreshRot() {
  document.documentElement.classList.toggle('portrait', isPortrait());
  document.documentElement.classList.toggle('landscape', !isPortrait());
  document.querySelectorAll('.rot').forEach((b) => { b.innerHTML = '<i class="orient ' + (isPortrait() ? 'land' : 'port') + '"></i><span>' + (isPortrait() ? 'Landscape' : 'Portrait') + '</span>'; });
}
window.addEventListener('resize', refreshRot);
window.addEventListener('orientationchange', refreshRot);
refreshRot();
function header() {
  const idx = { add: 0, id: 1, photos: 1, review: 2 }[state.screen];
  const steps = STEPS[state.mode].map((t, i) => '<li class="' + (i === idx ? 'on' : i < idx ? 'done' : '') + '"><b>' + (i + 1) + '</b>' + t + '</li>').join('');
  return '<header class="top"><div class="brand" data-act="brand">' + esc(cfg.shop) + '</div><ol class="steps">' + steps + '</ol>' + prnBtn() + rotBtn() + '<button class="btn ghost sm" data-act="reset">Start over</button></header>';
}

function homeHTML() {
  return '<main class="home"><div class="corner">' + prnBtn() + rotBtn() + '<button class="btn ghost sm" data-act="orders-open" title="Past orders (staff)">🗂️ <span class="lbl">Orders</span></button></div><div class="brand big" data-act="brand">' + esc(cfg.shop) + '</div>' +
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

// Touch up: paint over the cut-out to erase leftovers or bring back parts that were cut by mistake.
function toolsHTML() {
  const on = state.id.tool !== 'move';
  return '<div class="tools" id="tools"' + (on ? '' : ' hidden') + '><div class="seg2"><button class="' + (state.id.tool === 'erase' ? 'on' : '') + '" data-act="tool" data-id="erase">Erase</button><button class="' + (state.id.tool === 'restore' ? 'on' : '') + '" data-act="tool" data-id="restore">Restore</button></div>' +
    '<label class="brush"><span>Brush</span><input type="range" min="6" max="80" value="' + state.id.brush + '" data-in="brush" aria-label="Brush size"></label>' +
    '<button class="btn ghost sm" data-act="undo-edit">Undo</button><button class="btn ghost sm" data-act="reset-edits">Reset</button><button class="btn primary sm" data-act="tool-done">Done</button></div>';
}
function multiStripHTML() {
  if (state.photos.length <= 1) return '';
  const items = state.photos.map((p, i) =>
    '<button class="mthumb' + (p.id === state.sel ? ' sel' : '') + '" data-act="sel-id-photo" data-id="' + p.id + '">' +
    '<img src="' + p.thumb + '" alt=""><span class="lbl">Person ' + (i + 1) + '</span>' +
    '</button>'
  ).join('');
  return '<div class="multistrip">' + items +
    '<button class="mthumb add" data-act="to-add" title="Add another photo / person"><i>＋</i><span class="lbl">Add person</span></button>' +
    '</div>';
}

function idHTML() {
  const t = (act, on, label) => '<button class="tb' + (on ? ' on' : '') + '" data-act="' + act + '">' + label + '</button>';
  return '<main class="editor"><div class="stagecol">' +
    multiStripHTML() +
    '<div class="stagewrap" id="stagewrap"><div class="stagebox" id="stagebox"><canvas id="stage"></canvas><canvas id="guide"></canvas><div id="brushcur" hidden></div></div></div>' +
    '<div class="toolbar">' + t('flip', state.id.flip, '↔ Mirror') + t('autofit', false, '◎ Auto-fit') + t('guide', state.id.guides, '◌ Guide') + t('touchup', state.id.tool !== 'move', '✎ Touch up') + t('retake', false, '📷 Retake') + '</div>' + toolsHTML() +
    '<div class="zoomrow" title="Drag the photo to move it. Pinch or use the slider to zoom."><span>−</span><input type="range" id="zoom" min="0" max="100" value="40" data-in="zoom" aria-label="Zoom"><span>＋</span></div></div>' +
    '<div class="panel" id="panel"></div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="to-add">← Photos</button><button class="btn primary big" data-act="id-preview">See my print →</button></footer>';
}

const SWATCHES = [['#ffffff', 'White'], ['#cfe5f7', 'Light blue'], ['#2457b8', 'Blue'], ['#c8202b', 'Red'], ['#d9d9d9', 'Gray']];
const TABS = [
  ['size', 'Size & Presets'],
  ['bg', 'Background'],
  ['attire', 'Formal Attire'],
  ['tag', 'Name Tag'],
  ['fine', 'Fine-tune & Skin']
];

function idPanelHTML() {
  const tab = state.id.tab, q = state.id.qty;
  let body = '';
  if (tab === 'size') {
    const presets = '<div class="subhdr"><span>Government &amp; Visa Profiles</span></div><div class="preset-grid">' +
      L.GOV_PRESETS.map((p) =>
        '<button class="preset-chip' + (state.id.preset === p.id ? ' on' : '') + '" data-act="gov-preset" data-id="' + p.id + '">' +
        '<b>' + p.label + '</b><small>' + p.desc + '</small></button>'
      ).join('') + '</div>';

    const chips = '<div class="subhdr"><span>Print Packages</span></div><div class="chips">' +
      L.PACKAGES.map((p) => '<button class="chip' + (state.id.pkg === p.id ? ' on' : '') + '" data-act="pkg" data-id="' + p.id + '">' + p.label + '</button>').join('') +
      '<button class="chip autofill-chip' + (state.id.pkg === 'autofill' ? ' on' : '') + '" data-act="autofill" title="Auto-fill 1 sheet with chosen sizes">⚡ Auto-fill page</button></div>';

    const cells = '<div class="subhdr"><span>Custom Quantities</span></div><div class="qgrid">' +
      L.ID_SIZES.map((s) => '<div class="qcell">' +
        '<div class="qcell-hdr"><span>' + s.label + '</span><button class="fill-btn" data-act="fill-size" data-id="' + s.id + '" title="Auto-fill 1 sheet with ' + s.label + '">Fill page</button></div>' +
        '<div class="stepper"><button data-act="qty" data-id="' + s.id + '" data-d="-1" aria-label="Fewer">−</button><b' + ((q[s.id] || 0) > 0 ? ' class="on"' : '') + '>' + (q[s.id] || 0) + '</b><button data-act="qty" data-id="' + s.id + '" data-d="1" aria-label="More">＋</button></div>' +
        '</div>').join('') + '</div>';

    body = presets + chips + cells;
  } else if (tab === 'bg') {
    const preset = SWATCHES.some(([c]) => c === state.id.bg.toLowerCase());
    body = '<div class="swatches">' + SWATCHES.map(([c, n]) => '<button class="sw' + (state.id.bgMode === 'color' && state.id.bg.toLowerCase() === c ? ' on' : '') + '" style="--c:' + c + '" data-act="bg" data-c="' + c + '" title="' + n + '"><i></i><small>' + n + '</small></button>').join('') +
      '<label class="sw custom' + (state.id.bgMode === 'color' && !preset ? ' on' : '') + '" title="Pick any colour"><i style="--c:' + state.id.bg + '"><input type="color" value="' + state.id.bg + '" data-in="custombg" aria-label="Custom colour"></i><small>Custom</small></label>' +
      '<button class="sw orig' + (state.id.bgMode === 'original' ? ' on' : '') + '" data-act="bg" data-c="original"><i>🏞️</i><small>Keep mine</small></button></div>' +
      '<p class="hint">The background is made plain automatically. Pick the colour your ID needs.</p>';
  } else if (tab === 'attire') {
    const curAttire = state.id.attire || 'none';
    const attireCards = '<div class="attire-grid">' +
      I.ATTIRES.map((a) =>
        '<button class="attire-card' + (curAttire === a.id ? ' on' : '') + '" data-act="attire-sel" data-id="' + a.id + '">' +
        '<b>' + a.label + '</b><small>' + a.desc + '</small></button>'
      ).join('') + '</div>';

    let attireCtrls = '';
    if (curAttire !== 'none') {
      attireCtrls = '<div class="attire-ctrls">' +
        '<div class="subhdr"><span>Adjust Attire Fit</span></div>' +
        '<label class="sl"><span>Vertical Position (up / down)</span><input type="range" min="-25" max="25" value="' + (state.id.attireY || 0) + '" data-in="attire-y"></label>' +
        '<label class="sl"><span>Shoulder Width (scale)</span><input type="range" min="80" max="130" value="' + Math.round((state.id.attireScale || 1) * 100) + '" data-in="attire-scale"></label>' +
        '<button class="btn ghost sm" data-act="reset-attire">Reset fit</button>' +
        '</div>';
    }
    body = attireCards + attireCtrls;
  } else if (tab === 'tag') {
    const nt = state.id.nameTag || { on: false, text: '', sub: '' };
    body = '<div class="nametag-box">' +
      '<label class="chk" style="font-weight:700;font-size:16px"><input type="checkbox" data-in="tag-on"' + (nt.on ? ' checked' : '') + '> Add Name Tag banner</label>' +
      '<p class="hint">Clean white nameplate banner at the bottom. Required for PRC, Civil Service, Police &amp; military IDs.</p>' +
      '<label class="fld"><span>Full Name</span><input type="text" placeholder="SURNAME, FIRST NAME, M.I." value="' + esc(nt.text || '') + '" data-in="tag-text" autocomplete="off"></label>' +
      '<label class="fld"><span>Subtitle / Agency (optional)</span><input type="text" placeholder="Agency, ID No., or Date" value="' + esc(nt.sub || '') + '" data-in="tag-sub" autocomplete="off"></label>' +
      '</div>';
  } else {
    const cut = state.id.bgMode !== 'original';
    body = '<div class="finerow">' +
      '<button class="btn' + (state.id.autoEnhance ? ' primary' : ' ghost') + ' sm" data-act="toggle-enhance">✨ ' + (state.id.autoEnhance ? 'Auto-Enhance: ON' : 'Auto-Enhance Lighting &amp; Color') + '</button>' +
      '</div>' +
      '<label class="sl"><span>✨ Skin Smoothing &amp; Blemish Softening</span><input type="range" min="0" max="100" value="' + (state.id.skinSmooth || 0) + '" data-in="skin-smooth"></label>' +
      '<label class="sl"><span>Brightness</span><input type="range" min="-30" max="30" value="' + state.id.brightness + '" data-in="brightness"></label>' +
      '<label class="sl"><span>Contrast</span><input type="range" min="-30" max="30" value="' + state.id.contrast + '" data-in="contrast"></label>' +
      (cut ? '<label class="sl"><span>Edge clean-up (hair and shoulders)</span><input type="range" min="-10" max="10" value="' + Math.round(state.id.edge * 10) + '" data-in="edge"></label>' : '') +
      '<button class="btn ghost sm" data-act="reset-fine">Reset all</button>';
  }
  return '<div class="tabs">' + TABS.map(([k, n]) => '<button class="tab' + (tab === k ? ' on' : '') + '" data-act="tab" data-id="' + k + '">' + n + '</button>').join('') + '</div><div class="tabbody">' + body + '</div>';
}

// ---------- photo prints: live sheet preview with zoom, pan and mirror per photo ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const selPhoto = () => photoById(state.photo.sel) || state.photos[0] || null;
// where a photo sits inside its print cell: base scale (fit or fill) x its own zoom, then its pan (-1..1 of the spare room)
function photoGeom(it) {
  const src = it.work.img, iw = src.width, ih = src.height, rot = it.full && iw > ih, ew = rot ? ih : iw, eh = rot ? iw : ih;
  const k0 = it.fit === 'fit' ? Math.min(it.w / ew, it.h / eh) : Math.max(it.w / ew, it.h / eh), k = k0 * (it.zoom || 1);
  const dw = ew * k, dh = eh * k;
  return { rot, dw, dh, mx: Math.max(0, (dw - it.w) / 2), my: Math.max(0, (dh - it.h) / 2) };
}
function paintPhoto(ctx, it, x, y) {
  const src = it.work.img, w = it.w, h = it.h, g = photoGeom(it);
  const dx = x + (w - g.dw) / 2 + clamp(it.ox || 0, -1, 1) * g.mx, dy = y + (h - g.dh) / 2 + clamp(it.oy || 0, -1, 1) * g.my;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.imageSmoothingQuality = 'high';
  if (it.flip) { ctx.translate(2 * x + w, 0); ctx.scale(-1, 1); }          // mirror about the middle of this print
  if (g.rot) { ctx.translate(dx + g.dw, dy); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0, g.dh, g.dw); }
  else ctx.drawImage(src, dx, dy, g.dw, g.dh);
  ctx.restore();
}
// Every print of every photo, packed on sheets of the chosen size.
function photoLayout() {
  const size = L.PHOTO_SIZES.find((s) => s.id === state.photo.size) || L.PHOTO_SIZES[0]; if (!size) return null;
  state.photo.size = size.id;
  const paper = L.paperById(size.paper), items = [];
  for (const p of state.photos) {
    if (!p.work) continue;
    for (let c = 0; c < p.copies; c++) for (let d = 0; d < (size.dup || 1); d++) items.push({ w: L.px(size.w), h: L.px(size.h), work: p.work, pid: p.id, full: !!size.full, fit: state.photo.fit, flip: !!p.flip, zoom: p.zoom || 1, ox: p.ox || 0, oy: p.oy || 0 });
  }
  return { size, paper, items, sheets: L.pack(items, L.px(paper.w), L.px(paper.h), 0, 0) };
}
// A print's rectangle on the finished (upright) sheet; sheets packed sideways are turned a quarter.
const itemRectFinal = (s, it) => (s.rot ? { x: s.H - (it.y + it.h), y: it.x, w: it.h, h: it.w } : { x: it.x, y: it.y, w: it.w, h: it.h });

function ppanelHTML() {
  const tab = state.photo.tab, sel = selPhoto();
  let body = '';
  if (tab === 'photos') {
    const cards = state.photos.map((p) => '<div class="pcard' + (sel && sel.id === p.id ? ' sel' : '') + '" data-act="psel" data-id="' + p.id + '"><div class="thumb"><img class="' + (p.flip ? 'flip' : '') + '" src="' + p.thumb + '" alt=""><button class="fl' + (p.flip ? ' on' : '') + '" data-act="pflip" data-id="' + p.id + '" aria-label="Mirror this photo" title="Mirror">↔</button><button class="x" data-act="rm" data-id="' + p.id + '" aria-label="Remove">×</button></div>' +
      '<div class="stepper"><button data-act="copies" data-id="' + p.id + '" data-d="-1">−</button><b>' + p.copies + '</b><button data-act="copies" data-id="' + p.id + '" data-d="1">＋</button></div></div>').join('');
    body = '<div class="pgrid">' + cards + '</div><button class="btn ghost sm" data-act="to-add">＋ Add more photos</button><p class="hint">Tap a photo to adjust it on the sheet. The number under it is how many copies.</p>';
  } else {
    const sizes = L.PHOTO_SIZES.map((s) => '<button class="opt' + (state.photo.size === s.id ? ' on' : '') + '" data-act="psize" data-id="' + s.id + '"><b>' + s.label + '</b>' + (s.hint ? '<small>' + s.hint + '</small>' : '') + (cfg.prices[s.id] ? '<em>' + money(cfg.prices[s.id]) + ' each</em>' : '') + '</button>').join('');
    body = '<div class="opts">' + sizes + '</div><h3>How should it fit?</h3><div class="seg"><button class="' + (state.photo.fit === 'fill' ? 'on' : '') + '" data-act="pfit" data-id="fill">Fill the page<small>trims the edges</small></button><button class="' + (state.photo.fit === 'fit' ? 'on' : '') + '" data-act="pfit" data-id="fit">Whole photo<small>white borders</small></button></div>' +
      (hw ? '<h3>Printer</h3><div class="printerbox"><p class="paper">Looking for printers…</p></div>' : '');
  }
  return '<div class="tabs two"><button class="tab' + (tab === 'photos' ? ' on' : '') + '" data-act="ptab" data-id="photos">Photos &amp; copies</button><button class="tab' + (tab === 'size' ? ' on' : '') + '" data-act="ptab" data-id="size">Size &amp; fit</button></div><div class="tabbody">' + body + '</div>';
}
function photosHTML() {
  return '<main class="photos2"><div class="pcol"><div class="pwrap" id="pwrap"><canvas id="pprev"></canvas></div>' +
    '<div class="ptools"><div class="sheetnav" id="sheetnav" hidden><button class="tb" data-act="sheet-nav" data-d="-1" aria-label="Previous sheet">‹</button><span id="sheetlbl"></span><button class="tb" data-act="sheet-nav" data-d="1" aria-label="Next sheet">›</button></div>' +
    '<div class="zoomrow" title="Zoom the photo you selected. Drag it on the sheet to move it."><span>−</span><input type="range" id="pzoom" min="100" max="400" value="100" data-in="pzoom" aria-label="Zoom"><span>＋</span></div>' +
    '<button class="tb" data-act="pflip-sel" id="pflipsel">↔ Mirror</button><button class="tb" data-act="preset-photo">Reset</button></div></div>' +
    '<div class="panel" id="ppanel">' + ppanelHTML() + '</div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="to-add">← Photos</button><button class="btn primary big" data-act="photo-preview">See my print →</button></footer>';
}
function renderPPanel() { const p = $('#ppanel'); if (p) { p.innerHTML = ppanelHTML(); fillPrinterBox(); } }

let pLayout = null, pDrawT = 0;
function schedulePreview() { if (pDrawT) return; pDrawT = setTimeout(() => { pDrawT = 0; drawPhotoPreview(); }, 30); }
function drawPhotoPreview() {
  const cv = $('#pprev'), wrap = $('#pwrap'); if (!cv || !wrap) return;
  const lay = photoLayout(); pLayout = lay;
  if (!lay || !lay.sheets) { toast('That size does not fit on the paper.'); return; }
  const n = lay.sheets.length; state.photo.sheet = clamp(state.photo.sheet, 0, n - 1);
  const pw = L.px(lay.paper.w), ph = L.px(lay.paper.h), dpr = Math.min(window.devicePixelRatio || 1, 2);
  const css = Math.max(0.02, Math.min((wrap.clientWidth - 20) / pw, (wrap.clientHeight - 20) / ph));
  const cw = Math.floor(pw * css), ch = Math.floor(ph * css);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px'; cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  const sc = cv.width / pw; lay.css = cw / pw;
  const sheet = lay.sheets[state.photo.sheet];
  const x = cv.getContext('2d');
  x.drawImage(L.renderSheets([sheet], paintPhoto, { cutGuides: !lay.size.full && cfg.cutGuides, guideStyle: cfg.guideStyle || 'lines', scale: sc })[0], 0, 0, cv.width, cv.height);
  x.lineWidth = Math.max(3, cv.width / 200); x.strokeStyle = '#0b6e6e';
  for (const it of sheet.items) if (it.pid === state.photo.sel) { const r = itemRectFinal(sheet, it); x.strokeRect(r.x * sc + x.lineWidth / 2, r.y * sc + x.lineWidth / 2, r.w * sc - x.lineWidth, r.h * sc - x.lineWidth); }
  const nav = $('#sheetnav'); if (nav) { nav.hidden = n < 2; $('#sheetlbl').textContent = 'Sheet ' + (state.photo.sheet + 1) + ' of ' + n; }
  const p = selPhoto(), z = $('#pzoom'); if (z && p) z.value = Math.round((p.zoom || 1) * 100);
  const fb = $('#pflipsel'); if (fb && p) fb.classList.toggle('on', !!p.flip);
}
async function mountPhotos() {
  if (!state.photos.length) { go('add'); return; }
  if (!selPhoto()) state.photo.sel = null; if (!state.photo.sel) state.photo.sel = state.photos[0].id;
  if (state.photos.some((p) => !p.work)) {
    await busy('Preparing photos…');
    try { for (const p of state.photos) p.work = await getWork(p); } catch (e) { await busy(''); toast(e.message); go('add'); return; }
    await busy('');
    if (state.screen !== 'photos') return;
  }
  const cv = $('#pprev'); if (!cv) return;
  let drag = null;
  cv.onpointerdown = (e) => {
    if (!pLayout || !pLayout.sheets) return;
    const r = cv.getBoundingClientRect(), fx = (e.clientX - r.left) / pLayout.css, fy = (e.clientY - r.top) / pLayout.css, sheet = pLayout.sheets[state.photo.sheet];
    const hit = [...sheet.items].reverse().find((it) => { const q = itemRectFinal(sheet, it); return fx >= q.x && fx <= q.x + q.w && fy >= q.y && fy <= q.y + q.h; });
    if (!hit) return;
    if (state.photo.sel !== hit.pid) { state.photo.sel = hit.pid; const pn = $('#ppanel'); if (pn && state.photo.tab === 'photos') renderPPanel(); }
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ } drag = { x: e.clientX, y: e.clientY, sheet }; schedulePreview();
  };
  cv.onpointermove = (e) => {
    if (!drag) return;
    const p = selPhoto(), it = pLayout.items.find((q) => q.pid === p.id); if (!it) return;
    const dxF = (e.clientX - drag.x) / pLayout.css, dyF = (e.clientY - drag.y) / pLayout.css; drag.x = e.clientX; drag.y = e.clientY;
    const g = photoGeom(it), pdx = drag.sheet.rot ? dyF : dxF, pdy = drag.sheet.rot ? -dxF : dyF;     // finished-sheet movement -> the cell's own axes
    if (g.mx > 0) p.ox = clamp((p.ox || 0) + pdx / g.mx, -1, 1);
    if (g.my > 0) p.oy = clamp((p.oy || 0) + pdy / g.my, -1, 1);
    schedulePreview();
  };
  const end = () => { drag = null; };
  cv.onpointerup = end; cv.onpointercancel = end;
  cv.onwheel = (e) => { const p = selPhoto(); if (!p) return; e.preventDefault(); p.zoom = clamp((p.zoom || 1) * (1 - e.deltaY * 0.0012), 1, 4); schedulePreview(); };
  drawPhotoPreview();
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
    (hw ? '<div class="fld"><span>Printer</span><div class="printerbox"><p class="paper">Looking for printers…</p></div></div>' : '') +
    '<div class="qrow"><span>How many sets?</span><div class="stepper"><button data-act="sets" data-d="-1">−</button><b>' + state.sets + '</b><button data-act="sets" data-d="1">＋</button></div></div>' +
    (total ? '<p class="total">Total <b>' + money(total) + '</b></p>' : '') +
    '</div></main>' +
    '<footer class="bar"><button class="btn ghost" data-act="back-review">← Change</button><span class="grow"></span><button class="btn ghost" data-act="qr-dl" title="Send soft copy to your phone via QR code">📱 Soft copy (QR)</button><button class="btn ghost" data-act="save">Save JPG</button><button class="btn primary big" data-act="print">🖨️ Print</button></footer>';
}

// The paper a print will use right now (the sheet being reviewed, the photo size chosen, or the ID paper).
function currentPaperKey() {
  if (state.out && state.out.paper) return state.out.paper.id;
  if (state.mode === 'photo') { const z = L.PHOTO_SIZES.find((x) => x.id === state.photo.size); if (z) return z.paper; }
  return L.paperById(cfg.idPaper).id;
}
// Which printer this paper prints on (the booth's per-paper printer). With the Print Helper every installed printer is listed;
// the Android app lists the Wi-Fi / USB printers it found; otherwise it says how the print will go.
function printerControlHTML(info) {
  let body = '';
  if (info.options && info.options.length) {
    const opts = info.options.slice(); if (info.current && !opts.includes(info.current)) opts.unshift(info.current);
    body = '<select data-in="printer"><option value="">Choose a printer…</option>' + opts.map((n) => '<option value="' + esc(n) + '"' + (n === info.current ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>';
  } else if (info.android && info.android.ok) {
    const a = info.android;
    body = '<div class="plist">' + (a.items.length ? a.items.map((i) => '<button class="pi' + (i.selected ? ' on' : '') + '" data-act="apr" data-id="' + esc(i.id) + '">' + (i.selected ? '✓ ' : '') + esc(i.name) + '</button>').join('') : '<p class="paper">No printers found yet.</p>') + '</div>' +
      '<button class="btn ghost sm" data-act="apr-scan">' + (a.scanning ? 'Searching…' : 'Find printers') + '</button>';
  } else {
    const t = { station: 'Print station', wifi: 'Wi-Fi printer: ' + (info.current || ''), android: 'Android print screen (choose the printer when it opens)', browser: info.current || 'This device’s print dialog' }[info.mode] || '';
    body = '<p class="paper">' + esc(t) + '</p>';
  }
  const canCfg = hw && hw.configurePrinter && info.current && info.options && info.options.includes(info.current);
  const actions = '<div class="prn-actions">' +
    '<button class="btn ghost sm" data-act="prn-refresh" title="Re-scan system and Print Helper printers">🔄 Refresh list</button>' +
    (canCfg ? '<button class="btn ghost sm" data-act="prn-cfg" title="Open printer driver preferences">⚙️ Configure</button>' : '') +
    '</div>';
  return body + actions;
}
async function fillPrinterBox() {
  const boxes = [...document.querySelectorAll('.printerbox')]; if (!boxes.length) return;
  if (hw && hw.printers) {
    let info; try { info = await hw.printers(currentPaperKey()); } catch (e) { return; }
    const html = printerControlHTML(info);
    boxes.forEach((b) => { b.innerHTML = html; });
  } else {
    boxes.forEach((b) => { b.innerHTML = '<p class="paper">Using browser print dialog</p>'; });
  }
}
async function printerModal() {
  const idMode = state.mode === 'id' && L.PAPERS.length > 1;
  const paper = idMode
    ? '<label class="fld"><span>Paper for ID sheets</span><select data-in="paper">' + L.PAPERS.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === currentPaperKey() ? ' selected' : '') + '>' + esc(p.label) + '</option>').join('') + '</select></label>'
    : '<p class="paper">Paper: <b>' + esc((L.paperById(currentPaperKey()) || {}).label || '') + '</b></p>';
  
  let camHTML = '';
  if (hw && hw.cameras) {
    try {
      const cams = await hw.cameras();
      const curCam = hw.currentCamera ? hw.currentCamera() : '';
      if (cams.length) {
        camHTML = '<label class="fld"><span>Camera</span><select data-in="camsel" class="cam-select">' +
          cams.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === curCam ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') +
          '</select></label>';
      }
    } catch (e) { }
  } else if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      if (cams.length) {
        camHTML = '<label class="fld"><span>Camera</span><select data-in="camsel" class="cam-select">' +
          cams.map((c, i) => '<option value="' + esc(c.deviceId) + '">' + esc(c.label || 'Camera ' + (i + 1)) + '</option>').join('') +
          '</select></label>';
      }
    } catch (e) { }
  }

  openModal('<h2>Printers &amp; Cameras</h2>' +
    camHTML +
    paper +
    '<div class="fld"><span>Printer</span><div class="printerbox"><p class="paper">Looking for printers…</p></div></div>' +
    '<div class="mcol"><button class="btn primary big" data-act="close">Done</button></div>');
  fillPrinterBox();
}

function render() {
  const s = state.screen, app = $('#app');
  app.className = 's-' + s;
  app.innerHTML = s === 'home' ? homeHTML() : s === 'orders' ? ordersHTML() : header() + ({ add: addHTML, id: idHTML, photos: photosHTML, review: reviewHTML }[s])();
  if (s === 'id') mountId();
  if (s === 'review' || s === 'photos') fillPrinterBox();
  if (s === 'photos') mountPhotos();
}
function go(s) { state.screen = s; render(); }

// ---------- ID editor ----------
const idAspect = () => {
  const act = L.ID_SIZES.filter((s) => (state.id.qty[s.id] || 0) > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0] || L.ID_SIZES[2];
  return act.w / act.h;
};
const idOpts = () => ({
  crop: state.id.crop,
  bg: state.id.bgMode === 'original' ? null : (state.id.tool !== 'move' ? 'checker' : state.id.bg),
  brightness: state.id.brightness,
  contrast: state.id.contrast,
  autoEnhance: !!state.id.autoEnhance,
  skinSmooth: state.id.skinSmooth || 0,
  attire: state.id.attire || 'none',
  attireY: state.id.attireY || 0,
  attireScale: state.id.attireScale || 1,
  nameTag: state.id.nameTag || { on: false },
  flip: state.id.flip,
});
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

// ----- touch-up brush -----
let stroke = null, recutT = 0;
function paintReady() { return state.id.tool !== 'move' && idWork && idWork.matte && idWork.edits; }
function gridPoint(e) {
  const box = $('#stagebox'), r = box.getBoundingClientRect(), cr = state.id.crop, M = idWork.matte;
  const H = cr.h, W = H * r.width / r.height;
  let u = (e.clientX - r.left) / r.width; if (state.id.flip) u = 1 - u;
  const v = (e.clientY - r.top) / r.height;
  const k = M.gw / idWork.w;
  return { gx: (cr.cx - W / 2 + u * W) * k, gy: (cr.cy - H / 2 + v * H) * (M.gh / idWork.h), rad: state.id.brush / r.height * H * k };
}
function dab(e) {
  const g = gridPoint(e), M = idWork.matte;
  if (stroke.last) {                           // fill the gap between two pointer events
    const dx = g.gx - stroke.last.gx, dy = g.gy - stroke.last.gy, n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, g.rad * 0.35)));
    for (let i = 1; i <= n; i++) I.paintDab(idWork.edits, M.gw, M.gh, stroke.last.gx + dx * i / n, stroke.last.gy + dy * i / n, g.rad, state.id.tool);
  } else I.paintDab(idWork.edits, M.gw, M.gh, g.gx, g.gy, g.rad, state.id.tool);
  stroke.last = g;
  if (!recutT) recutT = setTimeout(() => { recutT = 0; recut(); drawStage(); }, 45);
}
function moveBrushCursor(e) {
  const c = $('#brushcur'), box = $('#stagebox'); if (!c || !box) return;
  const r = box.getBoundingClientRect(); c.hidden = state.id.tool === 'move';
  c.style.width = c.style.height = (state.id.brush * 2) + 'px'; c.style.left = (e.clientX - r.left) + 'px'; c.style.top = (e.clientY - r.top) + 'px';
}
function renderTools() {
  const t = $('#tools'); if (t) { t.hidden = state.id.tool === 'move'; t.querySelectorAll('[data-act=tool]').forEach((b) => b.classList.toggle('on', b.dataset.id === state.id.tool)); }
  const b = $('[data-act=touchup]'); if (b) b.classList.toggle('on', state.id.tool !== 'move');
  const box = $('#stagebox'); if (box) box.classList.toggle('paint', state.id.tool !== 'move');
  const c = $('#brushcur'); if (c && state.id.tool === 'move') c.hidden = true;
}

function mountId() {
  renderIdPanel(); sizeStage(); renderTools();
  const box = $('#stagebox'), ptrs = new Map(); let pinch = null;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  box.onpointerdown = (e) => {
    if (paintReady()) { try { box.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ } I.snapshotEdits(idWork.edits); stroke = { last: null }; dab(e); moveBrushCursor(e); return; }
    try { box.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ } ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2 && state.id.crop) pinch = { d: dist(), h: state.id.crop.h };
  };
  box.onpointermove = (e) => {
    if (paintReady()) { moveBrushCursor(e); if (stroke) dab(e); return; }
    if (!ptrs.has(e.pointerId) || !state.id.crop) return;
    const p = ptrs.get(e.pointerId), dx = e.clientX - p.x, dy = e.clientY - p.y; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const cr = state.id.crop;
    if (ptrs.size === 1) { const k = cr.h / box.clientHeight; cr.cx -= dx * k * (state.id.flip ? -1 : 1); cr.cy -= dy * k; }
    else if (pinch) { cr.h = clampH(pinch.h * pinch.d / dist()); syncZoom(); }
    drawStage();
  };
  const up = (e) => { if (stroke) { stroke = null; clearTimeout(recutT); recutT = 0; recut(); drawStage(); } ptrs.delete(e.pointerId); pinch = null; };
  box.onpointerup = up; box.onpointercancel = up;
  box.onpointerleave = () => { const c = $('#brushcur'); if (c) c.hidden = true; };
  box.onwheel = (e) => { if (!state.id.crop) return; e.preventDefault(); state.id.crop.h = clampH(state.id.crop.h * (1 + e.deltaY * 0.0012)); syncZoom(); drawStage(); };
  openId();
}

function saveCurrentIdState() {
  if (state.sel) {
    const p = photoById(state.sel);
    if (p) p.idState = JSON.parse(JSON.stringify(state.id));
  }
}

function loadIdState(p) {
  if (!p) return;
  if (p.idState) {
    state.id = JSON.parse(JSON.stringify(p.idState));
  } else {
    state.id = freshId();
    p.idState = JSON.parse(JSON.stringify(state.id));
  }
}

async function switchIdPhoto(id) {
  if (!id || id === state.sel) return;
  saveCurrentIdState();
  state.sel = id;
  const p = photoById(id);
  loadIdState(p);
  await openId();
  render();
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
    const preset = L.GOV_PRESETS.find((x) => x.id === state.id.preset);
    state.id.crop = I.autoCrop(idWork.face, idWork.w, idWork.h, idAspect(), preset ? preset.head : undefined);
    state.id.cropFor = p.id;
    if (!idWork.face) toast('We could not find a face. Move and zoom the photo to line it up.');
  }
  syncZoom(); drawStage();
  if (state.id.bgMode !== 'original' || (state.id.attire && state.id.attire !== 'none')) {
    await ensureCut(); if (live()) drawStage();
  }
  await busy('');
}

// Re-make the cut-out from the matte (after the edge slider or a brush stroke).
function recut() {
  if (!idWork) return;
  if (idWork.matte) idWork.cut = I.buildCutout(idWork, state.id.edge, idWork.edits);
  else if (idWork.conf) idWork.cut = I.makeCutout(idWork.img, idWork.conf, state.id.edge);
}
async function ensureCut() {
  const w = idWork; if (!w || w.cut) return true;
  await busy('Making the background plain…');
  try {
    try { w.matte = await I.computeMatte(w.img); w.edits = I.newEdits(w.matte); w.cut = I.buildCutout(w, state.id.edge, w.edits); }
    catch (e1) {
      console.error('Portrait matting could not run, using the basic cut-out', e1);
      w.matte = null; w.edits = null; w.conf = await I.personConfidence(w.img); w.cut = I.makeCutout(w.img, w.conf, state.id.edge);
    }
    return true;
  }
  catch (e) { console.error(e); toast('Could not change the background. Using your original.'); state.id.bgMode = 'original'; renderIdPanel(); return false; }
  finally { await busy(''); }
}

// ---------- building the sheets ----------
const gapPx = () => Math.round(cfg.gapMm / 25.4 * L.DPI), marginPx = () => Math.round(cfg.marginMm / 25.4 * L.DPI);

function applyAutoFill(targetSizeId) {
  const paper = L.paperById(cfg.idPaper);
  const paperW = L.px(paper.w), paperH = L.px(paper.h);
  const gap = gapPx(), margin = marginPx();
  let chosen = [];
  let initialQty = {};
  
  if (targetSizeId) {
    chosen = [targetSizeId];
    initialQty = { [targetSizeId]: 1 };
  } else {
    chosen = L.ID_SIZES.filter((s) => (state.id.qty[s.id] || 0) > 0).map((s) => s.id);
    if (!chosen.length) chosen = ['2x2'];
    initialQty = { ...state.id.qty };
  }
  
  const filled = L.calcAutoFill(chosen, paperW, paperH, gap, margin, initialQty);
  if (!filled || Object.values(filled).every((v) => v === 0)) {
    toast('Cannot fit that size on ' + paper.label + ' paper.');
    return;
  }
  
  L.ID_SIZES.forEach((s) => {
    state.id.qty[s.id] = filled[s.id] || 0;
  });
  state.id.pkg = 'autofill';
  renderIdPanel();
  sizeStage();
  drawStage();
  
  const summary = Object.entries(filled)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => count + ' × ' + ((L.ID_SIZES.find((x) => x.id === id) || {}).label || id))
    .join(', ');
  toast('Page filled: ' + summary + ' (' + paper.label + ')', 2500);
}

async function applyPreset(presetId) {
  const p = L.GOV_PRESETS.find((x) => x.id === presetId);
  if (!p) return;
  state.id.preset = p.id;
  
  if (p.size) {
    L.ID_SIZES.forEach((s) => { state.id.qty[s.id] = (s.id === p.size ? 6 : 0); });
    state.id.pkg = 'preset-' + p.id;
  }
  
  if (p.bg) {
    state.id.bg = p.bg;
    state.id.bgMode = 'color';
    if (idWork && !idWork.cut) ensureCut().then(drawStage);
  }
  
  if (p.nameTag) {
    if (!state.id.nameTag) state.id.nameTag = { on: false, text: '', sub: '' };
    state.id.nameTag.on = true;
  }
  
  if (p.head && idWork) {
    state.id.crop = I.autoCrop(idWork.face, idWork.w, idWork.h, idAspect(), p.head);
    syncZoom();
  }
  
  renderIdPanel();
  sizeStage();
  drawStage();
  toast('Applied: ' + p.label + ' (' + p.desc + ')', 3000);
}

async function buildId() {
  saveCurrentIdState();
  const activePhotos = state.photos.filter((p) => {
    const q = (p.idState && p.idState.qty) || (p.id === state.sel ? state.id.qty : {});
    return Object.values(q).some((v) => v > 0);
  });
  if (!activePhotos.length) { toast('Choose at least one photo size.'); return; }

  await busy('Preparing your print…');
  try {
    const paper = L.paperById(cfg.idPaper), items = [];
    const summaryLines = [];

    for (let pi = 0; pi < activePhotos.length; pi++) {
      const p = activePhotos[pi];
      const pIdState = p.idState || (p.id === state.sel ? state.id : freshId());
      const pSizes = L.ID_SIZES.filter((s) => (pIdState.qty[s.id] || 0) > 0);
      if (!pSizes.length) continue;

      const pWork = await getWork(p);
      if ((pIdState.bgMode !== 'original' || (pIdState.attire && pIdState.attire !== 'none')) && !pWork.cut) {
        try {
          pWork.matte = await I.computeMatte(pWork.img);
          pWork.edits = I.newEdits(pWork.matte);
          pWork.cut = I.buildCutout(pWork, pIdState.edge || 0, pWork.edits);
        } catch (e) {
          try {
            pWork.conf = await I.personConfidence(pWork.img);
            pWork.cut = I.makeCutout(pWork.img, pWork.conf, pIdState.edge || 0);
          } catch (e2) {
            pIdState.bgMode = 'original';
          }
        }
      }

      if (!pIdState.crop) {
        if (pWork.face === undefined) {
          try { pWork.face = await I.findFace(pWork.img); } catch (e) { pWork.face = null; }
        }
        const a = L.ID_SIZES.filter((s) => (pIdState.qty[s.id] || 0) > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0] || L.ID_SIZES[2];
        const preset = L.GOV_PRESETS.find((x) => x.id === pIdState.preset);
        pIdState.crop = I.autoCrop(pWork.face, pWork.w, pWork.h, a.w / a.h, preset ? preset.head : undefined);
      }

      const pOpts = {
        crop: pIdState.crop,
        bg: pIdState.bgMode === 'original' ? null : pIdState.bg,
        brightness: pIdState.brightness || 0,
        contrast: pIdState.contrast || 0,
        autoEnhance: !!pIdState.autoEnhance,
        skinSmooth: pIdState.skinSmooth || 0,
        attire: pIdState.attire || 'none',
        attireY: pIdState.attireY || 0,
        attireScale: pIdState.attireScale || 1,
        nameTag: pIdState.nameTag || { on: false },
        flip: !!pIdState.flip
      };

      const personLabel = activePhotos.length > 1 ? ' (Person ' + (state.photos.indexOf(p) + 1) + ')' : '';

      for (const s of pSizes) {
        const count = pIdState.qty[s.id];
        const w = L.px(s.w), h = L.px(s.h);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        I.drawId(c.getContext('2d'), pWork, pOpts, w, h);
        summaryLines.push(count + ' × ' + s.label + personLabel);
        for (let i = 0; i < count; i++) {
          items.push({ w, h, size: s.id, canvas: c });
        }
      }
    }

    const sheets = L.pack(items, L.px(paper.w), L.px(paper.h), gapPx(), marginPx());
    if (!sheets) { toast('That size does not fit on the ' + paper.label + ' paper.'); return; }

    state.out = {
      kind: 'id',
      paper,
      canvases: L.renderSheets(sheets, (ctx, it, x, y) => ctx.drawImage(it.canvas, x, y), {
        cutGuides: cfg.cutGuides,
        guideStyle: cfg.guideStyle || 'lines'
      }),
      lines: summaryLines,
      unitPrice: 0,
      saved: false,
    };
    state.out.unitPrice = cfg.prices.idSheet ? cfg.prices.idSheet * state.out.canvases.length : 0;
    state.sets = 1;
    go('review');
  } finally {
    await busy('');
  }
}

async function openSoftCopyQR() {
  if (!state.out || !state.out.canvases || !state.out.canvases.length) return;
  await busy('Preparing soft copy…');
  try {
    let dlBlob;
    if (state.mode === 'id' && idWork) {
      const c = document.createElement('canvas');
      const actSize = L.ID_SIZES.filter((s) => (state.id.qty[s.id] || 0) > 0)[0] || L.ID_SIZES[2];
      c.width = L.px(actSize.w);
      c.height = L.px(actSize.h);
      I.drawId(c.getContext('2d'), idWork, idOpts(), c.width, c.height);
      dlBlob = await I.canvasToBlob(c, 'image/jpeg', 0.96);
    } else {
      dlBlob = await I.canvasToBlob(state.out.canvases[0], 'image/jpeg', 0.95);
    }

    const previewUrl = URL.createObjectURL(dlBlob);
    let onlineOk = false;

    try {
      if (!phone || !phone.code) {
        phone = new S.PhoneSession(() => {}, () => {});
        await phone.start();
      }
      if (phone && phone.code) {
        await phone.sendSoftCopy(dlBlob, state.mode === 'id' ? 'rush-id-photo.jpg' : 'photo-print.jpg');
        onlineOk = true;
      }
    } catch (netErr) {
      console.warn('PhoneSession cloud start failed (offline):', netErr);
      onlineOk = false;
    }

    if (onlineOk && phone && phone.code) {
      openModal(
        '<h2>📱 Save to Phone (Soft Copy)</h2>' +
        '<div class="qrbox" id="qrbox">' + qrSvg(phone.url) +
        '<p class="code">' + phone.code + '</p>' +
        '<p class="hint">' + esc(phone.url.replace(/^https?:\/\//, '')) + '</p></div>' +
        '<div class="soft-prev"><img src="' + previewUrl + '" alt="Soft Copy Preview"><p>Scan the QR code with your phone camera to download your high-resolution photo directly to your phone gallery.</p></div>' +
        '<div class="mrow">' +
        (navigator.share ? '<button class="btn ghost" data-act="web-share">Share…</button>' : '') +
        '<button class="btn primary big" data-act="close">Done</button></div>',
        () => URL.revokeObjectURL(previewUrl)
      );
    } else {
      // Offline fallback: direct wireless share (AirDrop/Quick Share) or save to USB
      openModal(
        '<h2>📱 Save Soft Copy to Phone</h2>' +
        '<div class="soft-prev"><img src="' + previewUrl + '" alt="Soft Copy Preview">' +
        '<p class="hint" style="color:var(--warn);font-weight:600">Offline Mode (No Internet Connection)</p>' +
        '<p class="hint">Cloud QR code requires active internet. You can still save or transfer your high-resolution photo instantly below:</p></div>' +
        '<div class="mcol">' +
        (navigator.share ? '<button class="btn primary big" data-act="web-share">📲 Share to Phone (AirDrop / Quick Share)</button>' : '') +
        '<button class="btn big" data-act="save">💾 Save JPG to Drive / USB</button>' +
        '<button class="btn ghost" data-act="close">Close</button></div>',
        () => URL.revokeObjectURL(previewUrl)
      );
    }
  } catch (e) {
    toast('Could not prepare soft copy: ' + ((e && e.message) || e), 4500);
  } finally {
    await busy('');
  }
}

async function buildPhotos() {
  try {
    await busy('Preparing your print…');
    for (const p of state.photos) if (!p.work) p.work = await getWork(p);
    const lay = photoLayout();
    if (!lay || !lay.sheets) { toast('That size does not fit on the paper.'); return; }
    const prints = state.photos.reduce((a, p) => a + p.copies, 0);
    state.out = {
      kind: 'photo', paper: lay.paper, canvases: L.renderSheets(lay.sheets, paintPhoto, { cutGuides: !lay.size.full && cfg.cutGuides, guideStyle: cfg.guideStyle || 'lines' }), saved: false,
      lines: [prints + ' × ' + lay.size.label + (state.photos.length > 1 ? ' (' + state.photos.length + ' photos)' : '')], unitPrice: (cfg.prices[lay.size.id] || 0) * prints,
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
async function openCameraHW() {
  openModal('<h2>Take a photo</h2><div class="camwrap"><canvas id="camv"></canvas>' + (state.mode === 'id' ? '<div class="camguide"></div>' : '') + '<div id="camcount"></div></div><p id="camerr" class="err"></p>' +
    '<div class="mrow"><select id="camsel" data-in="camsel" class="cam-select" style="display:none"></select><button class="btn primary big" data-act="snap">📸 Take photo</button><button class="btn ghost" data-act="close">Close</button></div>', () => clearInterval(camTimer), 'cam');
  const cv = $('#camv'), v = hw.video, x = cv.getContext('2d');
  if (hw.mirror()) cv.style.transform = 'scaleX(-1)';

  // Populate camera choices
  if (hw.cameras) {
    try {
      const cams = await hw.cameras();
      const sel = $('#camsel');
      if (sel && cams.length) {
        const cur = hw.currentCamera ? hw.currentCamera() : '';
        sel.innerHTML = cams.map((c) => '<option value="' + esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
        sel.style.display = cams.length > 1 ? '' : 'none';
      }
    } catch (e) { }
  }

  const draw = () => {
    const err = $('#camerr'); if (!cv.isConnected) return;
    if (v.videoWidth) { if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; } x.drawImage(v, 0, 0); if (err) err.textContent = ''; }
    else if (err) err.textContent = 'The camera is not ready. Choose a camera below or check connection.';
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
    '<div class="mrow"><select id="camsel" data-in="camsel" class="cam-select" style="display:none"></select><button class="btn primary big" data-act="snap">📸 Take photo</button><button class="btn ghost" data-act="close">Close</button></div>', stopCamera, 'cam');
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
  } catch (e) {
    const b = $('#qrbox');
    if (b) {
      b.innerHTML = '<p class="err" style="margin-bottom:8px">No internet connection for cloud QR code.</p>' +
        '<p class="hint" style="margin-bottom:12px">Use these offline options to get photos from your phone without internet:</p>' +
        '<div class="mcol" style="gap:8px">' +
        '<button class="btn primary" data-act="src-bt">🔵 Send via Bluetooth (100% Offline)</button>' +
        '<button class="btn" data-act="src-usb">💾 Plug in USB Drive / SD Card</button>' +
        '</div>';
    }
    phone = null;
  }
}

// ---------- past orders (staff only): the finished sheets, kept on this device, with reprint / save / delete ----------
const fmtDate = (t) => { try { return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } };
function ordersHTML() {
  const cards = state.orders.map((o) => '<div class="ocard"><button class="othumb" data-act="order-view" data-id="' + o.id + '" aria-label="View"><img src="' + o.url + '" alt=""></button>' +
    '<div class="ometa"><b>' + esc(o.lines.join(' · ')) + '</b><small>' + esc(fmtDate(o.t)) + ' · ' + esc(o.paper.label) + ' · ' + o.n + (o.n === 1 ? ' sheet' : ' sheets') + '</small></div>' +
    '<div class="oact"><button class="btn sm" data-act="order-reprint" data-id="' + o.id + '">🖨️ Reprint</button><button class="btn ghost sm" data-act="order-save" data-id="' + o.id + '">Save</button><button class="btn ghost sm del" data-act="order-del" data-id="' + o.id + '">Delete</button></div></div>').join('');
  return '<header class="top"><div class="brand">Past orders</div><span class="hint grow">' + (cfg.keepDays ? 'Kept on this device for ' + cfg.keepDays + ' days, then removed.' : 'Not being kept (set days in Settings).') + '</span>' +
    (state.orders.length ? '<button class="btn ghost sm del" data-act="orders-clear">Delete all</button>' : '') + '<button class="btn primary sm" data-act="orders-back">Back</button></header>' +
    '<main class="orders">' + (cards ? '<div class="ogrid">' + cards + '</div>' : '<p class="hint empty">No past orders yet. Finished prints and saves appear here.</p>') + '</main>';
}
async function loadOrders() {
  try { await H.prune(cfg.keepDays); } catch (e) { /* storage not available */ }
  let rows = []; try { rows = await H.listOrders(); } catch (e) { toast('Past orders are not available on this device.'); }
  state.orders.forEach((o) => URL.revokeObjectURL(o.url));
  state.orders = rows.map((o) => ({ ...o, url: URL.createObjectURL(o.thumb) }));
}
async function saveOrderOnce() {
  const o = state.out; if (!o || o.saved || !cfg.keepDays) return;
  o.saved = true;
  try {
    const t = document.createElement('canvas'), c0 = o.canvases[0], k = 360 / c0.height; t.width = Math.round(c0.width * k); t.height = 360; t.getContext('2d').drawImage(c0, 0, 0, t.width, t.height);
    const thumb = await I.canvasToBlob(t, 'image/jpeg', 0.8), blobs = [];
    for (const c of o.canvases) blobs.push(await I.canvasToBlob(c, 'image/jpeg', 0.92));
    await H.saveOrder({ kind: o.kind, lines: o.lines, paper: { id: o.paper.id, label: o.paper.label, w: o.paper.w, h: o.paper.h }, sets: state.sets, thumb }, blobs);
    H.prune(cfg.keepDays).catch(() => {});
  } catch (e) { console.error('Could not keep this order', e); o.saved = false; }
}
async function orderCanvases(id) { const out = []; for (const b of await H.getSheets(id)) out.push(await I.decodeFile(b, 6000)); return out; }
function confirmModal(title, text, act, id) {
  openModal('<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p><div class="mrow"><button class="btn ghost" data-act="close">Cancel</button><button class="btn primary big del" data-act="' + act + '" data-id="' + esc(id || '') + '">Delete</button></div>');
}

// ---------- settings (hidden: tap the shop name 5 times) ----------
let taps = 0, tapT = 0;
function pinModal(next) {
  state.pinNext = next;
  openModal('<h2>Staff only</h2><p>Enter the PIN.</p><div class="mcol"><input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN"><button class="btn primary big" data-act="pin-ok">' + (next === 'orders' ? 'Open past orders' : 'Open settings') + '</button><button class="btn ghost" data-act="close">Cancel</button></div>');
  setTimeout(() => $('#pin') && $('#pin').focus(), 50);
}
function brandTap() {
  clearTimeout(tapT); tapT = setTimeout(() => { taps = 0; }, 2500);
  if (++taps >= 5) { taps = 0; pinModal('settings'); }
}
// ---------- app updates (Android app): the app's own updater downloads and installs the newer Rush ID Station ----------
const canUpdate = () => !!(hw && hw.update && hw.update.available());
function updatesBlock() {
  if (!canUpdate()) return '';
  return '<h3>App updates</h3><div class="fld"><p id="updstat" class="paper">Installed version ' + esc(hw.update.version() || '?') + '</p></div>' +
    '<div class="mrow"><button class="btn" data-act="upd-check">Check for updates</button><button class="btn primary" data-act="upd-start" id="updstart" hidden>Update now</button></div>';
}
let updListening = false;
function showUpdate(r) {
  const el = $('#updstat'), btn = $('#updstart'); if (!el) return;
  const cur = r.current || hw.update.version();
  const t = { checking: 'Checking for updates…', available: 'Version ' + (r.latest || '') + ' is ready (installed ' + cur + ').', latest: 'You have the latest version (' + cur + ').', offline: 'No internet connection. Connect to Wi-Fi and try again.', error: 'Could not check for updates. Try again later.' }[r.state];
  if (t) { el.textContent = t; el.className = 'paper' + (r.state === 'available' ? ' ok' : r.state === 'offline' || r.state === 'error' ? ' err' : ''); }
  if (btn) btn.hidden = r.state !== 'available';
}
function startUpdateCheck() {
  if (!canUpdate()) return;
  if (!updListening) { updListening = true; hw.update.onEvent(showUpdate); }
  hw.update.check();
}
function openSettings() {
  const pr = cfg.prices, pap = L.PAPERS.map((p) => '<option value="' + p.id + '"' + (cfg.idPaper === p.id ? ' selected' : '') + '>' + p.label + '</option>').join('');
  const num = (k, v) => '<input type="number" min="0" step="any" data-k="' + k + '" value="' + v + '">';
  openModal('<h2>Settings</h2><div class="form">' +
    '<label>Shop name<input data-k="shop" value="' + esc(cfg.shop) + '"></label>' +
    '<label>Currency symbol<input data-k="currency" value="' + esc(cfg.currency) + '" maxlength="4"></label>' +
    '<label>Staff PIN<input data-k="pin" value="' + esc(cfg.pin) + '"></label>' +
    '<label>Clear photos after idle (seconds, 0 = never)' + num('idle', cfg.idle) + '</label>' +
    '<label>Keep past orders for (days, 0 = keep nothing)' + num('keepDays', cfg.keepDays) + '</label>' +
    '<label>Paper for ID sheets<select data-k="idPaper">' + pap + '</select></label>' +
    '<label>Gap between ID photos (mm)' + num('gapMm', cfg.gapMm) + '</label>' +
    '<label>Paper margin (mm)' + num('marginMm', cfg.marginMm) + '</label>' +
    '<label class="chk"><input type="checkbox" data-k="cutGuides"' + (cfg.cutGuides ? ' checked' : '') + '> Draw cutting guides between ID photos</label>' +
    '<label>Cutting guide style<select data-k="guideStyle">' +
    '<option value="lines"' + (cfg.guideStyle === 'lines' ? ' selected' : '') + '>Full border lines</option>' +
    '<option value="corners"' + (cfg.guideStyle === 'corners' ? ' selected' : '') + '>Corner tick marks (cutter marks)</option>' +
    '</select></label>' +
    '<h3>Prices (0 = do not show)</h3>' +
    '<label>Per ID sheet' + num('p.idSheet', pr.idSheet) + '</label>' +
    L.PHOTO_SIZES.map((s) => '<label>Photo ' + s.label + ' (each)' + num('p.' + s.id, pr[s.id] || 0) + '</label>').join('') +
    '</div><div class="mcol"><button class="btn" data-act="orders-open-staff">Past orders…</button></div>' + (hw ? '<div class="mcol"><button class="btn" data-act="hw-setup">Cameras &amp; printers: open the booth Setup</button></div>' : '') +
    updatesBlock() +
    '<div class="mrow"><button class="btn primary big" data-act="save-cfg">Save</button><button class="btn ghost" data-act="close">Cancel</button></div>');
  startUpdateCheck();
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
  start: (b) => { if (noPrint()) { toast(NO_PRINT_MSG, 6000); return; } state.mode = b.dataset.mode; state.screen = 'add'; I.preload(); if (state.mode === 'id') I.preloadMatting(); render(); },
  pick: (b) => { if (state.mode === 'id') { state.sel = b.dataset.id; render(); } },
  rm: (b, e) => { e.stopPropagation(); removePhoto(b.dataset.id); if (!state.photos.length && state.screen === 'photos') go('add'); else render(); },
  'next-add': () => { if (state.mode === 'id') { state.id.cropFor = null; go('id'); } else { state.photo.sel = state.photos[0] ? state.photos[0].id : null; go('photos'); } },
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
    saveOrderOnce();
    openModal('<h2>Printing…</h2><p>Check the printer. When you have your prints, clear your photos from this screen.</p><div class="mrow"><button class="btn" data-act="qr-dl">📱 Send to Phone (QR)</button><button class="btn" data-act="close">Print again</button><button class="btn primary big" data-act="finish">Finish &amp; clear my photos</button></div>');
  },
  'qr-dl': openSoftCopyQR,
  'web-share': async () => {
    if (!navigator.share || !state.out || !state.out.canvases) return;
    try {
      const blob = await I.canvasToBlob(state.out.canvases[0], 'image/jpeg', 0.95);
      const file = new File([blob], 'id-photo.jpg', { type: 'image/jpeg' });
      await navigator.share({ files: [file], title: 'Rush ID Photo', text: 'My ID Photo' });
    } catch (e) { /* cancelled */ }
  },
  'gov-preset': (b) => applyPreset(b.dataset.id),
  'attire-sel': async (b) => {
    state.id.attire = b.dataset.id;
    renderIdPanel();
    drawStage();
    if (state.id.attire !== 'none' && idWork && !idWork.cut) {
      await ensureCut();
      drawStage();
    }
  },
  'reset-attire': () => {
    state.id.attireY = 0;
    state.id.attireScale = 1;
    renderIdPanel();
    drawStage();
  },
  'toggle-enhance': () => {
    state.id.autoEnhance = !state.id.autoEnhance;
    renderIdPanel();
    drawStage();
    toast(state.id.autoEnhance ? 'Auto-Enhance: ON' : 'Auto-Enhance: OFF', 1500);
  },
  'sel-id-photo': (b) => switchIdPhoto(b.dataset.id),
  finish: () => resetAll(),
  save: async () => { await P.downloadSheets(state.out.canvases, state.mode === 'id' ? 'id-photo' : 'photo-print'); saveOrderOnce(); toast('Saved'); },
  'pin-ok': async () => {
    if ($('#pin').value !== String(cfg.pin)) { $('#pin').value = ''; toast('Wrong PIN'); return; }
    if (state.pinNext === 'orders') { closeModal(); await loadOrders(); go('orders'); } else openSettings();
  },
  'orders-open': () => pinModal('orders'),
  'orders-open-staff': async () => { closeModal(); await loadOrders(); go('orders'); },
  'orders-back': () => { state.orders.forEach((o) => URL.revokeObjectURL(o.url)); state.orders = []; go('home'); },
  'order-view': async (b) => {
    const o = state.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    await busy('Opening…'); const blobs = await H.getSheets(o.id); await busy('');
    const urls = blobs.map((x) => URL.createObjectURL(x));
    openModal('<h2>' + esc(o.lines.join(' · ')) + '</h2><p class="hint">' + esc(fmtDate(o.t)) + '</p><div class="oview">' + urls.map((u) => '<img src="' + u + '" alt="">').join('') + '</div><div class="mrow"><button class="btn primary" data-act="close">Close</button></div>', () => urls.forEach((u) => URL.revokeObjectURL(u)));
  },
  'order-reprint': async (b) => {
    const o = state.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    await busy('Preparing…'); let cs; try { cs = await orderCanvases(o.id); } catch (e) { await busy(''); toast('Could not open that order.'); return; } await busy('');
    if (hw) { const r = await hw.print(cs, o.paper.id, 1); toast(r.msg, 6000); }
    else { try { await P.printSheets(cs, { w: o.paper.w, h: o.paper.h }, 1); } catch (e) { toast('Could not print: ' + (e.message || e)); } }
  },
  'order-save': async (b) => { const o = state.orders.find((x) => x.id === b.dataset.id); if (!o) return; await P.downloadSheets(await orderCanvases(o.id), 'order-' + o.id); toast('Saved'); },
  'order-del': (b) => confirmModal('Delete this order?', 'The photos in it are removed from this device. This cannot be undone.', 'order-del-yes', b.dataset.id),
  'order-del-yes': async (b) => { await H.deleteOrder(b.dataset.id); closeModal(); await loadOrders(); render(); toast('Deleted'); },
  'orders-clear': () => confirmModal('Delete all past orders?', 'Every saved order is removed from this device. This cannot be undone.', 'orders-clear-yes', ''),
  'orders-clear-yes': async () => { await H.clearOrders(); closeModal(); await loadOrders(); render(); toast('All past orders deleted'); },
  psel: (b) => { state.photo.sel = b.dataset.id; renderPPanel(); schedulePreview(); },
  ptab: (b) => { state.photo.tab = b.dataset.id; renderPPanel(); },
  'sheet-nav': (b) => { state.photo.sheet += Number(b.dataset.d); schedulePreview(); },
  'pflip-sel': () => { const p = selPhoto(); if (p) { p.flip = !p.flip; renderPPanel(); schedulePreview(); } },
  'preset-photo': () => { const p = selPhoto(); if (p) { p.zoom = 1; p.ox = 0; p.oy = 0; schedulePreview(); } },
  'save-cfg': saveSettings,
  'hw-setup': () => { closeModal(); hw.openSetup(); },
  'printer-modal': printerModal,
  'hw-printer-setup': () => { closeModal(); hw.openSetup(4); },
  'prn-refresh': async () => {
    await busy('Refreshing printers…');
    try {
      if (hw && hw.refreshPrinters) await hw.refreshPrinters(currentPaperKey());
      toast('Printer list refreshed', 1500);
      fillPrinterBox();
    } catch (e) {
      toast('Refresh failed: ' + ((e && e.message) || e), 3500);
    } finally {
      await busy('');
    }
  },
  'prn-cfg': async () => {
    if (!hw || !hw.configurePrinter) return;
    let cur = '';
    try {
      const info = await hw.printers(currentPaperKey());
      cur = info && info.current;
    } catch (e) { }
    if (!cur) { toast('Pick a printer first.', 2500); return; }
    await busy('Opening printer settings…');
    try {
      const r = await hw.configurePrinter(cur);
      toast(r.msg, 4000);
    } catch (e) {
      toast('Could not open settings: ' + ((e && e.message) || e), 4000);
    } finally {
      await busy('');
    }
  },
  autofill: () => { applyAutoFill(); },
  'fill-size': (b) => { applyAutoFill(b.dataset.id); },
  apr: (b) => { const r = hw.choosePrinter(currentPaperKey(), b.dataset.id); toast(r.msg, 4500); fillPrinterBox(); },
  'apr-scan': () => { hw.scanPrinters(); let n = 0; const t = setInterval(() => { fillPrinterBox(); if (++n > 40 || !document.querySelector('.printerbox')) clearInterval(t); }, 1200); },
  'upd-check': () => { startUpdateCheck(); },
  'upd-start': () => { toast('Downloading the update. Android will ask you to confirm the install.', 6000); hw.update.start(); },
  tab: (b) => { state.id.tab = b.dataset.id; renderIdPanel(); },
  flip: (b) => { state.id.flip = !state.id.flip; b.classList.toggle('on', state.id.flip); drawStage(); },
  guide: (b) => { state.id.guides = !state.id.guides; b.classList.toggle('on', state.id.guides); drawStage(); },
  retake: () => (hw ? openCameraHW() : openCamera()),
  pflip: (b, e) => { e.stopPropagation(); const p = photoById(b.dataset.id); if (p) { p.flip = !p.flip; render(); } },
  'reset-fine': () => {
    state.id.brightness = 0; state.id.contrast = 0; state.id.edge = 0;
    state.id.autoEnhance = false; state.id.skinSmooth = 0;
    recut();
    renderIdPanel(); drawStage();
  },
  touchup: (b) => {
    if (state.id.bgMode === 'original') { toast('Pick a background colour first. Touch up fixes the cut-out.'); return; }
    if (!idWork || !idWork.matte) { toast(idWork && idWork.cut ? 'Touch up is not available for this photo.' : 'Wait for the background to finish first.'); return; }
    state.id.tool = state.id.tool === 'move' ? 'erase' : 'move'; renderTools(); drawStage();
  },
  tool: (b) => { state.id.tool = b.dataset.id; renderTools(); drawStage(); },
  'tool-done': () => { state.id.tool = 'move'; renderTools(); drawStage(); },
  'undo-edit': () => { if (idWork && idWork.edits && I.undoEdits(idWork.edits)) { recut(); drawStage(); } else toast('Nothing to undo.'); },
  'reset-edits': () => { if (idWork && idWork.edits) { I.clearEdits(idWork.edits); recut(); drawStage(); toast('Touch-ups cleared'); } },
  rot: () => { if (hw && hw.canRotate && hw.canRotate()) { const next = innerHeight > innerWidth ? 'landscape' : 'portrait'; hw.setOrientation(next); toast(next === 'portrait' ? 'Portrait' : 'Landscape', 1500); } },
};

const ins = {
  zoom: (el) => { if (!state.id.crop) return; const r = hRange(); state.id.crop.h = r.max * Math.pow(r.min / r.max, el.value / 100); drawStage(); },
  'attire-y': (el) => { state.id.attireY = Number(el.value); drawStage(); },
  'attire-scale': (el) => { state.id.attireScale = Number(el.value) / 100; drawStage(); },
  'tag-on': (el) => { if (!state.id.nameTag) state.id.nameTag = { on: false, text: '', sub: '' }; state.id.nameTag.on = el.checked; drawStage(); },
  'tag-text': (el) => { if (!state.id.nameTag) state.id.nameTag = { on: true, text: '', sub: '' }; state.id.nameTag.text = el.value; drawStage(); },
  'tag-sub': (el) => { if (!state.id.nameTag) state.id.nameTag = { on: true, text: '', sub: '' }; state.id.nameTag.sub = el.value; drawStage(); },
  'skin-smooth': (el) => { state.id.skinSmooth = Number(el.value); drawStage(); },
  brightness: (el) => { state.id.brightness = Number(el.value); drawStage(); },
  contrast: (el) => { state.id.contrast = Number(el.value); drawStage(); },
  guides: (el) => { state.id.guides = el.checked; drawStage(); },
  edge: (el) => {
    state.id.edge = Number(el.value) / 10;
    recut(); drawStage();
  },
  camsel: async (el) => {
    if (hw && hw.setCamera) {
      await busy('Switching camera…');
      try {
        await hw.setCamera(el.value);
        toast('Camera switched', 1500);
      } catch (e) {
        toast('Could not switch camera: ' + ((e && e.message) || e), 3500);
      } finally {
        await busy('');
      }
    } else {
      startCamera(el.value);
    }
  },
  brush: (el) => { state.id.brush = Number(el.value); },
  pzoom: (el) => { const p = selPhoto(); if (p) { p.zoom = Number(el.value) / 100; schedulePreview(); } },
  custombg: (el) => {
    state.id.bg = el.value; state.id.bgMode = 'color';
    const i = el.closest('i'); if (i) i.style.setProperty('--c', el.value);
    drawStage(); if (idWork && !idWork.cut) ensureCut().then(drawStage);
  },
  paper: async (el) => {
    cfg.idPaper = el.value; saveCfg();
    if (state.id.pkg === 'autofill') applyAutoFill();
    if (state.screen === 'review' && state.mode === 'id' && idWork) await buildId();
    fillPrinterBox();
  },
  printer: (el) => {
    if (hw) {
      hw.setPrinter(currentPaperKey(), el.value);
      toast(el.value ? 'Printer: ' + el.value : 'Using default printer', 2500);
    }
  },
};
const CHANGE_ONLY = ['edge', 'camsel', 'paper', 'printer'];      // selects and the edge slider act when released, not on every move

document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && acts[b.dataset.act]) acts[b.dataset.act](b, e); });
document.addEventListener('input', (e) => { const el = e.target.closest('[data-in]'); if (el && ins[el.dataset.in] && !CHANGE_ONLY.includes(el.dataset.in)) ins[el.dataset.in](el); });
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-in]'); if (el && (CHANGE_ONLY.includes(el.dataset.in) || el.type === 'checkbox')) ins[el.dataset.in](el);
  if (el && el.dataset.in === 'custombg') renderIdPanel();
  if (e.target.id === 'files') { const fs = [...e.target.files]; closeModal(); addFiles(fs); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); if (e.key === 'Enter' && $('#pin') && document.activeElement === $('#pin')) acts['pin-ok'](); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); if (state.screen === 'add' || state.screen === 'photos') addFiles([...e.dataTransfer.files]); });
addEventListener('resize', () => { refreshRot(); if (state.screen === 'id') { sizeStage(); drawStage(); } });
addEventListener('beforeunload', () => { if (phone) phone.stop(); });

H.prune(cfg.keepDays).catch(() => {});          // past orders older than the keep-days setting go on start-up
render();
