// Direct dye-sublimation print driver for Canon SELPHY CP-series photo printers over USB:
// CP820 / CP910 / CP1000 / CP1200 / CP1300 / CP1500.
//
// Implements the Canon SELPHY Neo USB protocol (32-byte header + 3-plane YUV444 raster),
// matching android/app/src/main/java/com/photobooth4u/booth/CanonSelphyJob.kt.
// Pure Node: Electron's nativeImage is handed in via makeSelphyJobBuilder so tests run without Electron.

export const SELPHY_VENDOR_ID = 0x04a9;

export const SELPHY_PRODUCT_IDS = new Map([
  [0x327a, 'Canon SELPHY CP910'],
  [0x327b, 'Canon SELPHY CP820'],
  [0x32ae, 'Canon SELPHY CP1000'],
  [0x32b1, 'Canon SELPHY CP1200'],
  [0x32db, 'Canon SELPHY CP1300'],
  [0x3302, 'Canon SELPHY CP1500']
]);

export const SPEC_P = Object.freeze({
  key: 'jpn_hagaki_100x148mm',
  code: 0x50,
  cols: 1248,
  rows: 1872,
  wMm: 100,
  hMm: 148,
  name: 'Postcard 100×148 mm'
});

export const SPEC_L = Object.freeze({
  key: 'oe_photo-l_3.5x5in',
  code: 0x4c,
  cols: 1152,
  rows: 1472,
  wMm: 89,
  hMm: 119,
  name: 'L size 89×119 mm'
});

export const SPEC_C = Object.freeze({
  key: 'om_card_54x86mm',
  code: 0x43,
  cols: 1088,
  rows: 668,
  wMm: 54,
  hMm: 86,
  name: 'Card 54×86 mm'
});

export const SELPHY_SPECS = Object.freeze([SPEC_P, SPEC_L, SPEC_C]);

const SELPHY_NAME_RE = /selphy|\bcp[\s_-]?(?:820|910|1000|1200|1300|1500)\b/i;

export function isSelphyUsb(vid, pid, name = '') {
  if (Number(vid) !== SELPHY_VENDOR_ID) return false;
  if (SELPHY_PRODUCT_IDS.has(Number(pid))) return true;
  return SELPHY_NAME_RE.test(String(name || ''));
}

export function selphyModelName(vid, pid, fallback = '') {
  if (Number(vid) === SELPHY_VENDOR_ID && SELPHY_PRODUCT_IDS.has(Number(pid))) {
    return SELPHY_PRODUCT_IDS.get(Number(pid));
  }
  return String(fallback || '');
}

/**
 * Resolves the SELPHY Neo paper spec from an optional explicit paperName or physical mm dimensions.
 * Matches CanonSelphyJob.specFor: Card (54x86 mm), L size (89x119 mm), else Postcard (100x148 mm / 4x6").
 */
export function selphySpecFor(widthMm, heightMm, paperName = '') {
  const pn = String(paperName || '').trim().toLowerCase();
  if (pn) {
    if (pn === SPEC_C.key || /\bcard\b|54\s*x\s*86/.test(pn)) return SPEC_C;
    if (pn === SPEC_L.key || /\bl[\s_-]?size\b|89\s*x\s*119|3\.5\s*x\s*5/.test(pn)) return SPEC_L;
    if (pn === SPEC_P.key || /postcard|hagaki|100\s*x\s*148|4\s*x\s*6/.test(pn)) return SPEC_P;
  }
  const w = Math.min(Number(widthMm) || 0, Number(heightMm) || 0);
  const h = Math.max(Number(widthMm) || 0, Number(heightMm) || 0);
  const near = (a, b, tol = 10) => Math.abs(a - b) < tol;
  if (w > 0 && h > 0) {
    if (near(w, 54) && near(h, 86)) return SPEC_C;
    if (near(w, 89) && near(h, 119)) return SPEC_L;
  }
  return SPEC_P;
}

/**
 * Encodes a BGRA bitmap (Electron nativeImage.toBitmap() layout) into a Canon SELPHY Neo USB job buffer
 * (32-byte header + sequential Y, U/Cb, V/Cr planes).
 *
 * When `turn` is true, the source bitmap is rotated 90 degrees clockwise into (spec.cols x spec.rows),
 * so source `width` should match `spec.rows` and source `height` should match `spec.cols`.
 */
export function encodeSelphyJob({ bgra, width, height, stride = width * 4, spec = SPEC_P, turn = false }) {
  if (!bgra || !bgra.length) throw new Error('SELPHY job: empty bitmap.');
  const { cols, rows, code } = spec;
  if (!(cols > 0 && rows > 0)) throw new Error('SELPHY job: invalid paper spec.');
  if (!(width > 0 && height > 0) || stride < width * 4 || bgra.length < stride * height) {
    throw new Error('SELPHY job: bitmap buffer is too short.');
  }

  const planeSize = cols * rows;
  const out = Buffer.alloc(32 + planeSize * 3);

  // 32-byte Canon SELPHY Neo header
  out[0] = 0x0f;
  out[3] = 0x40;
  out[14] = 0x01;
  out[16] = 0x01;
  out[18] = code;       // 0x50 ('P'), 0x4C ('L'), or 0x43 ('C')
  out[23] = 0x00;       // 0x00 = YUV444 format
  out.writeUInt32LE(cols, 24);
  out.writeUInt32LE(rows, 28);

  const yOffset = 32;
  const uOffset = 32 + planeSize;
  const vOffset = 32 + planeSize * 2;

  for (let dy = 0; dy < rows; dy++) {
    const rowStart = dy * cols;
    for (let dx = 0; dx < cols; dx++) {
      const sx = turn ? dy : dx;
      const sy = turn ? height - 1 - dx : dy;
      let r = 255, g = 255, b = 255;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const p = sy * stride + sx * 4;
        const a = bgra[p + 3];
        b = bgra[p];
        g = bgra[p + 1];
        r = bgra[p + 2];
        if (a !== 255) {
          const w = 255 - a;
          b = b + w > 255 ? 255 : b + w;
          g = g + w > 255 ? 255 : g + w;
          r = r + w > 255 ? 255 : r + w;
        }
      }

      // Standard ITU-R BT.601 integer fixed-point conversion (matches CanonSelphyJob.kt)
      const yv = (77 * r + 150 * g + 29 * b + 128) >> 8;
      const cb = ((-43 * r - 85 * g + 128 * b + 128) >> 8) + 128;
      const cr = ((128 * r - 107 * g - 21 * b + 128) >> 8) + 128;

      const idx = rowStart + dx;
      out[yOffset + idx] = yv < 0 ? 0 : yv > 255 ? 255 : yv;
      out[uOffset + idx] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
      out[vOffset + idx] = cr < 0 ? 0 : cr > 255 ? 255 : cr;
    }
  }

  return out;
}

/**
 * Wraps Electron's nativeImage: (imageBuf, widthMm, heightMm, paperName) -> { data: Buffer, spec }.
 */
export function makeSelphyJobBuilder(nativeImage) {
  return (imageBuf, widthMm, heightMm, paperName = '') => {
    const spec = selphySpecFor(widthMm, heightMm, paperName);
    const im = nativeImage.createFromBuffer(Buffer.from(imageBuf));
    if (im.isEmpty()) throw new Error('Couldn’t read the picture to print.');
    const src = im.getSize();
    const turn = (src.width > src.height) !== (spec.cols > spec.rows);
    const targetW = turn ? spec.rows : spec.cols;
    const targetH = turn ? spec.cols : spec.rows;
    const resized = (src.width === targetW && src.height === targetH)
      ? im
      : im.resize({ width: targetW, height: targetH, quality: 'best' });
    const sz = resized.getSize();
    const bgra = resized.toBitmap();
    const stride = Math.floor(bgra.length / sz.height);
    if (stride < sz.width * 4) throw new Error('Couldn’t prepare the picture for the Canon SELPHY printer.');
    const data = encodeSelphyJob({ bgra, width: sz.width, height: sz.height, stride, spec, turn });
    return { data, spec };
  };
}

export function selphyStatusDescription(statusByte) {
  switch (statusByte & 0xff) {
    case 0x01: return 'Idle';
    case 0x02: return 'Feeding paper';
    case 0x04: return 'Printing Yellow pass';
    case 0x08: return 'Printing Magenta pass';
    case 0x10: return 'Printing Cyan pass';
    case 0x20: return 'Laminating protective coat';
    default: return 'Working (0x' + (statusByte & 0xff).toString(16).padStart(2, '0') + ')';
  }
}

export function selphyErrorDescription(errorCode) {
  switch (errorCode & 0xff) {
    case 0x00: return '';
    case 0x01: return 'Low battery';
    case 0x02: return 'Paper feed error — check paper cassette';
    case 0x03: return 'No paper cassette inserted';
    case 0x04: return 'Incorrect paper cassette';
    case 0x05: return 'Incorrect paper loaded';
    case 0x06: return 'Ink cassette empty';
    case 0x07: return 'No ink cassette inserted';
    case 0x08: return 'Incorrect ink cassette';
    case 0x09: return 'No paper and no ink';
    case 0x0a: return 'Media/job mismatch — check paper vs ink';
    case 0x0b: return 'Paper jam';
    case 0x0c: return 'Ink ribbon jam';
    case 0x0d: return 'Ink ribbon invalid';
    case 0x0e: return 'Unknown ink cassette';
    case 0x0f: return 'Unknown paper';
    case 0x10: return 'Unknown command';
    default: return 'Printer error (0x' + (errorCode & 0xff).toString(16).padStart(2, '0') + ')';
  }
}
