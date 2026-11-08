// Sizes, packages and putting many small photos on one printer sheet.
export const DPI = 300;
export const px = (inch) => Math.round(inch * DPI);
const mm = (v) => v / 25.4;

export const ID_SIZES = [
  { id: '1x1', label: '1×1"', w: 1, h: 1 },
  { id: '1.5x1.5', label: '1.5×1.5"', w: 1.5, h: 1.5 },
  { id: '2x2', label: '2×2"', w: 2, h: 2 },
  { id: '1.5x2', label: '1.5×2"', w: 1.5, h: 2 },
  { id: '2x3', label: '2×3" wallet', w: 2, h: 3 },
  { id: '35x45', label: 'Passport 35×45 mm', w: mm(35), h: mm(45) },
];

export const PACKAGES = [
  { id: 'p1', label: '2×2 · 6 pcs', qty: { '2x2': 6 } },
  { id: 'p2', label: '1×1 · 12 pcs', qty: { '1x1': 12 } },
  { id: 'p3', label: '1.5×2 · 8 pcs', qty: { '1.5x2': 8 } },
  { id: 'p4', label: 'Passport · 6 pcs', qty: { '35x45': 6 } },
  { id: 'p5', label: 'Combo · 2×2 ×3 + 1×1 ×6', qty: { '2x2': 3, '1x1': 6 } },
];

export const PAPERS = [
  { id: '4x6', label: '4×6"', w: 4, h: 6 },
  { id: '5x7', label: '5×7"', w: 5, h: 7 },
  { id: '6x8', label: '6×8"', w: 6, h: 8 },
  { id: 'a4', label: 'A4', w: 8.27, h: 11.69 },
];
export const paperById = (id) => PAPERS.find((p) => p.id === id) || PAPERS[0];

// Photo-print choices. `paper` is the sheet in the printer, `cell` is one print on it,
// `dup` = same photo repeated per copy (a 2×6 strip is printed twice on a 4×6 and cut in half).
export const PHOTO_SIZES = [
  { id: '4x6', label: '4×6"', paper: '4x6', w: 4, h: 6, full: true },
  { id: '5x7', label: '5×7"', paper: '5x7', w: 5, h: 7, full: true },
  { id: '6x8', label: '6×8"', paper: '6x8', w: 6, h: 8, full: true },
  { id: '2x3', label: 'Wallet 2×3"', paper: '4x6', w: 2, h: 3, hint: '4 on a 4×6 sheet' },
  { id: '2x6', label: 'Strip 2×6"', paper: '4x6', w: 2, h: 6, dup: 2, hint: '2 strips per 4×6 sheet, cut in half' },
];

// ---------- packing (guillotine, best short side fit) ----------
function place(sheet, it, gap) {
  const w = it.w + gap, h = it.h + gap;
  let bi = -1, bs = Infinity;
  sheet.free.forEach((r, i) => {
    if (r.w >= w && r.h >= h) {
      const s = Math.min(r.w - w, r.h - h);
      if (s < bs) { bs = s; bi = i; }
    }
  });
  if (bi < 0) return false;
  const r = sheet.free.splice(bi, 1)[0];
  sheet.items.push({ ...it, x: r.x, y: r.y });
  const right = (r.w - w < r.h - h) ? { x: r.x + w, y: r.y, w: r.w - w, h } : { x: r.x + w, y: r.y, w: r.w - w, h: r.h };
  const below = (r.w - w < r.h - h) ? { x: r.x, y: r.y + h, w: r.w, h: r.h - h } : { x: r.x, y: r.y + h, w, h: r.h - h };
  for (const f of [right, below]) if (f.w > 0 && f.h > 0) sheet.free.push(f);
  return true;
}

function packOne(items, W, H, gap, margin) {
  const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w);
  const sheets = [];
  const fresh = () => ({ W, H, items: [], free: [{ x: margin, y: margin, w: W - 2 * margin + gap, h: H - 2 * margin + gap }] });
  for (const it of sorted) {
    let ok = false;
    for (const s of sheets) if (place(s, it, gap)) { ok = true; break; }
    if (!ok) { const s = fresh(); if (!place(s, it, gap)) return null; sheets.push(s); }
  }
  return sheets;
}

// items: [{ w, h (px), ...anything }]. Tries the sheet upright and sideways, keeps the one that needs fewer sheets.
// Sideways sheets are turned back upright when drawn (rot = true) so the printer always gets a portrait page.
export function pack(items, paperW, paperH, gap = 0, margin = 0) {
  const up = packOne(items, paperW, paperH, gap, margin);
  const side = packOne(items, paperH, paperW, gap, margin);
  if (!up && !side) return null;
  if (up && (!side || up.length <= side.length)) return up.map((s) => ({ ...s, rot: false }));
  return side.map((s) => ({ ...s, rot: true }));
}

// paint(ctx, item, x, y) draws one item at (x, y). Returns portrait canvases (paperW x paperH).
export function renderSheets(sheets, paint, { cutGuides = true, scale = 1 } = {}) {
  return sheets.map((s) => {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(s.W * scale)); c.height = Math.max(1, Math.round(s.H * scale));
    const x = c.getContext('2d'); x.setTransform(scale, 0, 0, scale, 0, 0);
    x.fillStyle = '#fff'; x.fillRect(0, 0, s.W, s.H);
    for (const it of s.items) paint(x, it, it.x, it.y);
    if (cutGuides && s.items.length > 1) {
      x.strokeStyle = 'rgba(120,120,120,.55)'; x.lineWidth = Math.max(1, 1 / scale);
      for (const it of s.items) x.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
    }
    if (!s.rot) return c;
    const o = document.createElement('canvas'); o.width = c.height; o.height = c.width;
    const ox = o.getContext('2d'); ox.translate(o.width, 0); ox.rotate(Math.PI / 2); ox.drawImage(c, 0, 0);
    return o;
  });
}
