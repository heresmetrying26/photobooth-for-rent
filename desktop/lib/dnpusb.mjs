// Direct USB print driver for DNP dye-sublimation photo printers on desktop (Windows & macOS):
// DS-RX1 / RX1HS, DS620 / DS620A, and DS40 (also Citizen CX / CY).
//
// Implements the exact 32-byte ESC 'P' DNP wire protocol matching
// android/app/src/main/java/com/photobooth4u/booth/DnpJob.kt:
//   CNTRL QTY / OVERCOAT / CUTTER, IMAGE MULTICUT, three 8-bit bottom-up 300 DPI BMP planes
//   (YPLANE = blue, MPLANE = green, CPLANE = red), then CNTRL START.
// Also queries live STATUS, INFO FREE_PBUFFER, and INFO MQTY (remaining prints on roll).
// Pure Node: Electron's nativeImage is passed into makeDnpJobBuilder so unit tests run without Electron.

export const DNP_VID_CITIZEN = 0x1343;
export const DNP_VID_DNP = 0x1452;

export const DNP_CITIZEN_PIDS = new Map([
  [0x0003, 'DS40'],
  [0x0004, 'DS80'],
  [0x0005, 'DS-RX1'],
  [0x0008, 'DS80D']
]);

export const DNP_PRODUCT_IDS = new Map([
  [0x8b01, 'DS620'],
  [0x9001, 'DS820']
]);

const DNP_NAME_RE = /DS-?RX1(HS)?|DS-?620A?|DS-?40|DS-?80D?|DS-?820A?|QW-?410|CX-?02W?|CY-?02|CZ-?01/i;

/** Returns normalized DNP/Citizen model string ("DS-RX1", "DS620", "DS40"...) or '' if not DNP. */
export function dnpModelName(vid, pid, productName = '') {
  const v = Number(vid) || 0;
  const p = Number(pid) || 0;
  const m = DNP_NAME_RE.exec(String(productName || ''));
  const fromName = m ? m[0].toUpperCase().replace(/^DSRX/, 'DS-RX').replace(/^DS-(\d)/, 'DS$1') : '';
  if (v === DNP_VID_CITIZEN) return DNP_CITIZEN_PIDS.get(p) || fromName || '';
  if (v === DNP_VID_DNP) return DNP_PRODUCT_IDS.get(p) || fromName || 'photo printer';
  return '';
}

export function isDnpUsb(vid, pid, productName = '') {
  return !!dnpModelName(vid, pid, productName);
}

/** 8-inch (DS80 / DS820 / CX-02W) and 4.5-inch (QW410 / CZ-01) models are not built into direct USB yet. */
export function dnpUnsupportedReason(model) {
  const m = String(model || '').toUpperCase();
  if (!m) return '';
  const brand = m.startsWith('C') ? 'Citizen' : 'DNP';
  if (m.includes('80') || m.includes('820') || m.endsWith('W')) {
    return `The ${brand} ${model} (8-inch paper) is not supported for direct USB yet. Install the official ${brand} driver instead.`;
  }
  if (m.includes('QW') || m.startsWith('CZ')) {
    return `The ${brand} ${model} (4.5-inch paper) is not supported for direct USB yet. Install the official ${brand} driver instead.`;
  }
  return '';
}

export const DNP_SHEET_3X5 = Object.freeze({ key: '3.5x5', code: '01', cols: 1920, rows: 1088, printCols: 1548, wMm: 88.9, hMm: 127.0, name: '3.5×5' });
export const DNP_SHEET_4X6 = Object.freeze({ key: '4x6', code: '02', cols: 1920, rows: 1240, printCols: 1844, wMm: 101.6, hMm: 152.4, name: '4×6' });
export const DNP_SHEET_5X7 = Object.freeze({ key: '5x7', code: '03', cols: 1920, rows: 2138, printCols: 1548, wMm: 127.0, hMm: 177.8, name: '5×7' });
export const DNP_SHEET_6X8 = Object.freeze({ key: '6x8', code: '04', cols: 1920, rows: 2436, printCols: 1844, wMm: 152.4, hMm: 203.2, name: '6×8' });
export const DNP_SHEET_6X9 = Object.freeze({ key: '6x9', code: '05', cols: 1920, rows: 2740, printCols: 1844, wMm: 152.4, hMm: 228.6, name: '6×9' });

export const DNP_SHEETS = Object.freeze([DNP_SHEET_4X6, DNP_SHEET_3X5, DNP_SHEET_5X7, DNP_SHEET_6X8, DNP_SHEET_6X9]);

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Returns true when the requested booth size is a single 2×6 strip (doubled onto 4×6 + 2-inch cut). */
export function isDnpSingleStrip(widthMm, heightMm) {
  const s = Math.min(Number(widthMm) || 0, Number(heightMm) || 0);
  const l = Math.max(Number(widthMm) || 0, Number(heightMm) || 0);
  return s > 0 && s <= 60.0 && near(l, 152.4, 8.0);
}

/** Resolves the DNP sheet for mm dimensions or explicit paperName, or null if unsupported. */
export function dnpSheetFor(widthMm, heightMm, paperName = '') {
  const pn = String(paperName || '').trim().toLowerCase();
  if (pn) {
    if (/3\.5\s*[x×]\s*5|3r/.test(pn)) return DNP_SHEET_3X5;
    if (/5\s*[x×]\s*7|5r/.test(pn)) return DNP_SHEET_5X7;
    if (/6\s*[x×]\s*8|6r/.test(pn)) return DNP_SHEET_6X8;
    if (/6\s*[x×]\s*9/.test(pn)) return DNP_SHEET_6X9;
    if (/4\s*[x×]\s*6|6\s*[x×]\s*4|4r|2\s*[x×]\s*6|strip|split/.test(pn)) return DNP_SHEET_4X6;
  }
  if (isDnpSingleStrip(widthMm, heightMm)) return DNP_SHEET_4X6;
  const s = Math.min(Number(widthMm) || 0, Number(heightMm) || 0);
  const l = Math.max(Number(widthMm) || 0, Number(heightMm) || 0);
  if (!(s > 0 && l > 0)) return DNP_SHEET_4X6;
  if (near(s, 101.6, 6.0) && near(l, 152.4, 6.0)) return DNP_SHEET_4X6;
  if (near(s, 88.9, 5.0) && near(l, 127.0, 5.0)) return DNP_SHEET_3X5;
  if (near(s, 127.0, 5.0) && near(l, 177.8, 6.0)) return DNP_SHEET_5X7;
  if (near(s, 152.4, 5.0) && near(l, 203.2, 6.0)) return DNP_SHEET_6X8;
  if (near(s, 152.4, 5.0) && near(l, 228.6, 6.0)) return DNP_SHEET_6X9;
  return null;
}

/** Builds a 32-byte ESC 'P' DNP protocol command header. */
export function dnpHeader(group, name, len = null) {
  const h = Buffer.alloc(32, 0x20);
  h[0] = 0x1b;
  h[1] = 0x50; // 'P'
  const g = Buffer.from(String(group || ''), 'ascii');
  g.copy(h, 2, 0, Math.min(6, g.length));
  const n = Buffer.from(String(name || ''), 'ascii');
  n.copy(h, 8, 0, Math.min(16, n.length));
  if (len !== null && len !== undefined) {
    Buffer.from(String(len).padStart(8, '0'), 'ascii').copy(h, 24, 0, 8);
  }
  return h;
}

/** Builds a DNP protocol command (32-byte header + optional ASCII payload). */
export function dnpCmd(group, name, payload = null) {
  if (payload === null || payload === undefined) return dnpHeader(group, name, null);
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'ascii');
  return Buffer.concat([dnpHeader(group, name, p.length), p]);
}

function writeBmpHeader(buf, at, w, h, fsize, pixOff) {
  buf[at] = 0x42; // 'B'
  buf[at + 1] = 0x4d; // 'M'
  buf.writeUInt32LE(fsize, at + 2);
  buf.writeUInt32LE(pixOff, at + 10);
  buf.writeUInt32LE(40, at + 14);
  buf.writeUInt32LE(w, at + 18);
  buf.writeUInt32LE(h, at + 22);
  buf.writeUInt16LE(1, at + 26);
  buf.writeUInt16LE(8, at + 28);
  buf.writeUInt32LE(w * h, at + 34);
  buf.writeUInt32LE(11811, at + 38); // 300 dpi in pixels per metre
  buf.writeUInt32LE(11811, at + 42);
}

/**
 * Encodes a BGRA bitmap (Electron nativeImage.toBitmap() layout) into a complete DNP ESC 'P' USB print job.
 *
 * Automatically handles:
 *  - single 2×6 strip doubling onto a 4×6 sheet + 2-inch cut
 *  - 90° orientation alignment to the print head (printCols vs rows)
 *  - full-bleed cover-fit into printCols × rows + edge-clamped bleed across the 1920-dot head width
 *  - bottom-up 8-bit BMP planes (Y = Blue, M = Green, C = Red)
 */
export function encodeDnpJob({
  bgra,
  width,
  height,
  stride = width * 4,
  widthMm = 101.6,
  heightMm = 152.4,
  paperName = '',
  copies = 1,
  matte = false,
  stripCut = false
}) {
  if (!bgra || !bgra.length) throw new Error('DNP job: empty bitmap.');
  if (!(width > 0 && height > 0) || stride < width * 4 || bgra.length < stride * height) {
    throw new Error('DNP job: bitmap buffer is too short.');
  }

  let srcBgra = bgra;
  let srcW = width;
  let srcH = height;
  let srcStride = stride;
  let cut = !!stripCut;
  let sheet;

  if (isDnpSingleStrip(widthMm, heightMm)) {
    // Portrait strip duplicated side-by-side onto a 4x6 portrait canvas, then cut down the middle.
    const rotateStrip = srcW > srcH;
    const stW = rotateStrip ? srcH : srcW;
    const stH = rotateStrip ? srcW : srcH;
    const twoW = stW * 2;
    const two = Buffer.alloc(twoW * stH * 4);
    for (let y = 0; y < stH; y++) {
      for (let x = 0; x < stW; x++) {
        const ox = rotateStrip ? y : x;
        const oy = rotateStrip ? (srcH - 1 - x) : y;
        const sp = oy * srcStride + ox * 4;
        const dp1 = (y * twoW + x) * 4;
        const dp2 = (y * twoW + stW + x) * 4;
        const b = srcBgra[sp], g = srcBgra[sp + 1], r = srcBgra[sp + 2], a = srcBgra[sp + 3];
        two[dp1] = b; two[dp1 + 1] = g; two[dp1 + 2] = r; two[dp1 + 3] = a;
        two[dp2] = b; two[dp2 + 1] = g; two[dp2 + 2] = r; two[dp2 + 3] = a;
      }
    }
    srcBgra = two;
    srcW = twoW;
    srcH = stH;
    srcStride = twoW * 4;
    cut = true;
    sheet = DNP_SHEET_4X6;
  } else {
    sheet = dnpSheetFor(widthMm, heightMm, paperName);
    if (!sheet) {
      const s = Math.round(Math.min(widthMm, heightMm));
      const l = Math.round(Math.max(widthMm, heightMm));
      throw new Error(`A DNP printer can't print ${s}×${l} mm. Choose 4×6, 2×6, 3.5×5, 5×7, 6×8 or 6×9 paper.`);
    }
  }
  if (cut && sheet !== DNP_SHEET_4X6) cut = false;

  const { cols, rows, printCols } = sheet;
  const boxLandscape = printCols > rows;
  const pageLandscape = srcW > srcH;
  const turn = boxLandscape !== pageLandscape;
  const effW = turn ? srcH : srcW;
  const effH = turn ? srcW : srcH;

  // Cover-fit effW x effH into printCols x rows, centered in the 1920-dot head; outer bleed clamps edge pixels.
  const boxL = (cols - printCols) / 2;
  const scale = Math.max(printCols / effW, rows / effH);
  const dw = effW * scale;
  const dh = effH * scale;
  const offX = boxL + (printCols - dw) / 2;
  const offY = (rows - dh) / 2;

  const clampedCopies = Math.max(1, Math.min(99, Math.floor(Number(copies) || 1)));
  const pre = Buffer.concat([
    dnpCmd('CNTRL', 'QTY', String(clampedCopies).padStart(7, '0') + '\r'),
    dnpCmd('CNTRL', 'OVERCOAT', '000000' + (matte ? '01' : '00')),
    dnpCmd('CNTRL', 'CUTTER', String(cut ? 120 : 0).padStart(8, '0')),
    dnpCmd('IMAGE', 'MULTICUT', '000000' + sheet.code)
  ]);
  const end = dnpCmd('CNTRL', 'START');
  const pad = 10;
  const pixOff = 54 + 1024 + pad;
  const planeLen = cols * rows;
  const fsize = pixOff + planeLen;
  const blockLen = 32 + fsize;
  const out = Buffer.alloc(pre.length + blockLen * 3 + end.length);
  pre.copy(out, 0);

  const starts = [0, 0, 0];
  const letters = ['Y', 'M', 'C'];
  for (let k = 0; k < 3; k++) {
    const at = pre.length + blockLen * k;
    dnpHeader('IMAGE', letters[k] + 'PLANE', fsize).copy(out, at);
    writeBmpHeader(out, at + 32, cols, rows, fsize, pixOff);
    starts[k] = at + 32 + pixOff;
  }
  end.copy(out, pre.length + blockLen * 3);

  // Precompute x mapping across 1920 head dots (clamped to [0, effW - 1] so bleed margins never show white).
  const xMap = new Int32Array(cols);
  for (let x = 0; x < cols; x++) {
    let ex = Math.floor((x - offX) / scale);
    if (ex < 0) ex = 0;
    else if (ex >= effW) ex = effW - 1;
    xMap[x] = ex;
  }

  const yStart = starts[0], mStart = starts[1], cStart = starts[2];
  for (let y = 0; y < rows; y++) {
    let ey = Math.floor((y - offY) / scale);
    if (ey < 0) ey = 0;
    else if (ey >= effH) ey = effH - 1;
    const dstRow = (rows - 1 - y) * cols; // BMP rows run bottom to top
    const yo = yStart + dstRow;
    const mo = mStart + dstRow;
    const co = cStart + dstRow;
    for (let x = 0; x < cols; x++) {
      const ex = xMap[x];
      const sx = turn ? ey : ex;
      const sy = turn ? (srcH - 1 - ex) : ey;
      const p = sy * srcStride + sx * 4;
      const a = srcBgra[p + 3];
      let b = srcBgra[p];
      let g = srcBgra[p + 1];
      let r = srcBgra[p + 2];
      if (a !== 255) {
        const w = 255 - a;
        b = b + w > 255 ? 255 : b + w;
        g = g + w > 255 ? 255 : g + w;
        r = r + w > 255 ? 255 : r + w;
      }
      out[yo + x] = b; // blue  -> yellow plane
      out[mo + x] = g; // green -> magenta plane
      out[co + x] = r; // red   -> cyan plane
    }
  }

  return { data: out, sheet, cut, matte: !!matte, copies: clampedCopies };
}

/**
 * Wraps Electron's nativeImage:
 *   (imageBuf, { widthMm, heightMm, paperName, copies, matte, stripCut }) -> { data, sheet, cut, matte, copies }
 */
export function makeDnpJobBuilder(nativeImage) {
  return (imageBuf, opts = {}) => {
    const widthMm = Number(opts.widthMm) || 101.6;
    const heightMm = Number(opts.heightMm) || 152.4;
    const paperName = String(opts.paperName || '');
    const stripCut = !!opts.stripCut;
    const matte = !!opts.matte;
    const copies = Math.max(1, Math.min(99, Math.floor(Number(opts.copies) || 1)));
    const sheet = dnpSheetFor(widthMm, heightMm, paperName);
    if (!sheet) {
      const s = Math.round(Math.min(widthMm, heightMm));
      const l = Math.round(Math.max(widthMm, heightMm));
      throw new Error(`A DNP printer can't print ${s}×${l} mm. Choose 4×6, 2×6, 3.5×5, 5×7, 6×8 or 6×9 paper.`);
    }
    const im = nativeImage.createFromBuffer(Buffer.from(imageBuf));
    if (im.isEmpty()) throw new Error('Couldn’t read the picture to print.');
    const src = im.getSize();
    // High-quality resize via Chromium Skia near target 300 DPI head resolution so pixel text & photos stay crisp.
    let working = im;
    if (!isDnpSingleStrip(widthMm, heightMm)) {
      const boxLandscape = sheet.printCols > sheet.rows;
      const pageLandscape = src.width > src.height;
      const targetW = boxLandscape === pageLandscape ? sheet.printCols : sheet.rows;
      const targetH = boxLandscape === pageLandscape ? sheet.rows : sheet.printCols;
      const scale = Math.max(targetW / src.width, targetH / src.height);
      const rw = Math.max(1, Math.round(src.width * scale));
      const rh = Math.max(1, Math.round(src.height * scale));
      if (Math.abs(rw - src.width) > 2 || Math.abs(rh - src.height) > 2) {
        working = im.resize({ width: rw, height: rh, quality: 'best' });
      }
    }
    const sz = working.getSize();
    const bgra = working.toBitmap();
    const stride = Math.floor(bgra.length / sz.height);
    if (stride < sz.width * 4) throw new Error('Couldn’t prepare the picture for the DNP printer.');
    return encodeDnpJob({ bgra, width: sz.width, height: sz.height, stride, widthMm, heightMm, paperName, copies, matte, stripCut });
  };
}

export function dnpIsError(st) {
  return Number(st) >= 1000;
}

export function dnpStatusText(st) {
  switch (Number(st)) {
    case 0: return 'Idle';
    case 1: return 'Printing';
    case 500: return 'Cooling the print head';
    case 510: return 'Cooling the paper motor';
    case 900: return 'Standby';
    case 1000: return 'Cover open — close the printer door';
    case 1010: return 'No scrap box — put the scrap box back';
    case 1100: return 'Paper end — load a new paper roll';
    case 1200: return 'Ribbon end — load a new ribbon';
    case 1300: return 'Paper jam — open the printer and clear the paper';
    case 1400: return 'Ribbon error — check the ribbon is loaded properly';
    case 1500: return 'Paper definition error — the loaded paper doesn’t match the print size chosen';
    case 1600: return 'Data error — power the printer off and on, then retry';
    case 2000: return 'Head voltage error';
    case 2100: return 'Head position error';
    case 2200: return 'Power supply fan error';
    case 2300: return 'Cutter error';
    case 2400: return 'Pinch roller error';
    case 2500: return 'Head temperature error';
    case 2600: return 'Media temperature error';
    case 2610: return 'Paper motor temperature error';
    case 2700: return 'Ribbon tension error';
    case 2800: return 'RFID module error';
    case 3000: return 'System error — power the printer off and on';
    default: return Number(st) >= 1000 ? `Printer error ${st}` : `Busy (${st})`;
  }
}

/** Parses an ASCII integer reply from STATUS ("00000000") or INFO FREE_PBUFFER ("FBP02"). */
export function parseDnpIntReply(reply) {
  const m = /\d+/.exec(String(reply || ''));
  return m ? Number(m[0]) : null;
}

/** Parses DNP INFO MQTY reply (remaining media count). */
export function parseDnpMediaRemaining(reply, model = '') {
  const n = parseDnpIntReply(reply);
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  // Legacy DS40 / DS-RX1 firmware reports MQTY with a 50-print reserve offset when >= 50 (per Gutenprint dnpds40).
  const m = String(model || '').toUpperCase();
  if ((m === 'DS40' || m.startsWith('DS-RX1') || m.startsWith('RX1')) && n >= 50) return n - 50;
  return n;
}
