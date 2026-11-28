// Direct USB print driver for Epson ESC/P-R ink-tank photo printers on desktop (macOS & Windows):
// Epson L805, L800, L810, L850, L8050, L18050, L210, L3150, L3250, L3276, etc.
//
// Used when the computer has no OS print queue installed for the plugged-in USB printer (especially on
// macOS where Epson L805 exposes only USB Printer Class 7/1/2 ESC/P-R and not AirPrint / IPP-over-USB 7/1/4).
// Implements the exact 360 DPI ESC/P-R wire protocol proven in android/.../EscprJob.kt:
//   @EJL 1284.4 -> REMOTE1 (TI/JS/JH ESCPRLib/HD/PP) -> ESCPR -> setq (cp=0x00 24-bit RGB)
//   -> seti + chku (borderless handshake) -> setj -> sttp -> setn -> PackBits RLE dsnd scanlines
//   -> endp -> endj -> REMOTE1 JE.
// Pure Node: Electron's nativeImage is passed into makeEscprJobBuilder so unit tests run without Electron.

export const EPSON_VENDOR_ID = 0x04b8;

export const EPSON_ESCPR_MEDIA = Object.freeze({
  PLAIN: 0x00,
  MATTE: 0x05,
  PREMIUM_GLOSSY: 0x0b, // EPS_MTID_PGPHOTO (proven borderless photo paper on L805)
  SEMI_GLOSS: 0x0c,
  EPSON_GLOSSY: 0x34 // Epson Photo Paper Glossy (L8050)
});

const DPI = 360;
const BORDER_3MM = 42; // 3 mm at 360 dpi
const BL_LEFT = 36; // Standard Epson ESC/P-R borderless overscan (360 dpi)
const BL_TOP = 42;
const BL_EXTRA_W = 72;
const BL_EXTRA_H = 112;

// Known USB PIDs from Epson drivers & Android NetPrintBridge.kt
const EPSON_ESCP2_ONLY_PIDS = new Set([0x005e]); // L120 / L121 (ESC/P2 only, no ESC/P-R)
const EPSON_ESCPR_KNOWN_PIDS = new Map([
  [0x0866, 'L8050'],
  [0xe671, 'L3210'],
  [0x445a, 'L3276']
]);

const POS_THERMAL_RE = /(?:^|[^A-Za-z0-9])(?:TM|EU|BA|UB|DM)[\s_-]?[A-Z0-9]/i;
const ESCP2_ONLY_NAME_RE = /(?:^|[^A-Za-z0-9])L\s?(?:110|120|121)(?![0-9])/i;
const EPSON_L_NAME_RE = /(?:^|[^A-Za-z0-9])(L\s?(?:1\d\d|2\d\d|3\d\d|5\d\d|8\d\d|[1-8]\d{3}|18050)|ET-?18100)(?![0-9])/i;
const EPSON_L8050_RE = /(?:^|[^A-Za-z0-9])L\s?8050(?![0-9])/i;
const CMD_FIELD_RE = /\bCMD:([^;]+)/i;

/** Borderless sheet sizes from Epson's ESC/P-R media table in 1/360 inch (portrait: short side first). */
export const EPSON_BORDERLESS_PAPERS = Object.freeze([
  Object.freeze({ key: '3.5x5', name: '3.5×5 (3R)', wMm: 88.9, hMm: 127.0, wPx: 1261, hPx: 1800 }),
  Object.freeze({ key: '100x148mm', name: 'Postcard 100×148 mm', wMm: 100.0, hMm: 148.0, wPx: 1417, hPx: 2098 }),
  Object.freeze({ key: '4x6', name: '4×6 (4R)', wMm: 101.6, hMm: 152.4, wPx: 1440, hPx: 2160 }),
  Object.freeze({ key: '16:9', name: '4×7 Wide (16:9)', wMm: 101.6, hMm: 180.6, wPx: 1440, hPx: 2560 }),
  Object.freeze({ key: '5x7', name: '5×7 (5R)', wMm: 127.0, hMm: 177.8, wPx: 1800, hPx: 2522 }),
  Object.freeze({ key: '8x10', name: '8×10 (8R)', wMm: 203.2, hMm: 254.0, wPx: 2880, hPx: 3600 }),
  Object.freeze({ key: 'a4', name: 'A4', wMm: 210.0, hMm: 297.0, wPx: 2976, hPx: 4209 }),
  Object.freeze({ key: 'letter', name: 'Letter', wMm: 215.9, hMm: 279.4, wPx: 3060, hPx: 3960 })
]);

export function isEpsonL8050Name(text = '') {
  return EPSON_L8050_RE.test(String(text || ''));
}

/**
 * Returns true if the USB device is an Epson ink-tank printer speaking ESC/P-R (e.g. L805, L8050, L3250, L210).
 * Mirrors android/.../NetPrintBridge.kt#usbIsEscpr:
 *   - Rejects non-Epson VIDs, POS/thermal TM-series printers, and ESC/P2-only L120/L121 models.
 *   - When IEEE-1284 Device ID exposes a CMD: field, trusts whether CMD contains ESCPR.
 *   - Otherwise falls back to known PIDs or Epson L-series photo/EcoTank model names.
 */
export function isEpsonEscprUsb(vid, pid, infoText = '', deviceId = '') {
  const v = Number(vid) || 0;
  const p = Number(pid) || 0;
  if (v !== EPSON_VENDOR_ID) return false;
  if (EPSON_ESCP2_ONLY_PIDS.has(p)) return false;
  const combined = `${infoText || ''} ${deviceId || ''}`;
  if (POS_THERMAL_RE.test(combined)) return false;
  if (EPSON_ESCPR_KNOWN_PIDS.has(p)) return true;
  const cmdM = CMD_FIELD_RE.exec(String(deviceId || '') || String(infoText || ''));
  if (cmdM) return /ESCPR/i.test(cmdM[1]);
  if (ESCP2_ONLY_NAME_RE.test(combined)) return false;
  return EPSON_L_NAME_RE.test(combined);
}

/** Normalized Epson model label ("L805", "L8050"...) or '' when not an Epson ESC/P-R USB printer. */
export function epsonEscprModelName(vid, pid, infoText = '', deviceId = '') {
  if (!isEpsonEscprUsb(vid, pid, infoText, deviceId)) return '';
  const known = EPSON_ESCPR_KNOWN_PIDS.get(Number(pid) || 0);
  if (known) return known;
  const combined = `${deviceId || ''} ${infoText || ''}`;
  const m = EPSON_L_NAME_RE.exec(combined);
  if (m && m[1]) return m[1].toUpperCase().replace(/\s+/g, '');
  const mdl = /\bMDL:([^;]+)/i.exec(String(deviceId || ''));
  if (mdl && mdl[1]) return mdl[1].trim();
  return 'ESC/P-R';
}

/** Looks up Epson's 360-dpi borderless table entry for widthMm x heightMm (portrait), or null if unsupported. */
export function epsonBorderlessPaper(widthMm, heightMm) {
  const a = Math.min(Number(widthMm) || 0, Number(heightMm) || 0);
  const b = Math.max(Number(widthMm) || 0, Number(heightMm) || 0);
  if (!(a > 0 && b > 0)) return null;
  return EPSON_BORDERLESS_PAPERS.find((p) => Math.abs(a - p.wMm) <= 1.5 && Math.abs(b - p.hMm) <= 1.5) || null;
}

export function paperPixels360(widthMm, heightMm) {
  const a = Math.min(Number(widthMm) || 101.6, Number(heightMm) || 152.4);
  const b = Math.max(Number(widthMm) || 101.6, Number(heightMm) || 152.4);
  return { wPx: Math.max(1, Math.round((a / 25.4) * DPI)), hPx: Math.max(1, Math.round((b / 25.4) * DPI)) };
}

function u16be(v) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(v & 0xffff, 0);
  return b;
}

function i16be(v) {
  const b = Buffer.allocUnsafe(2);
  b.writeInt16BE(v, 0);
  return b;
}

function u32be(v) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

/**
 * PackBits RLE over whole pixels (bpp bytes each) matching EscprJob.kt#packBitsInto.
 * Returns a Buffer smaller than row, or null when RLE does not shrink the row.
 */
export function packBitsRow(row, bpp = 3) {
  const n = Math.floor(row.length / bpp);
  const limit = row.length;
  const dst = Buffer.allocUnsafe(limit);
  let pos = 0;

  const same = (a, b) => {
    const ia = a * bpp;
    const ib = b * bpp;
    for (let k = 0; k < bpp; k++) if (row[ia + k] !== row[ib + k]) return false;
    return true;
  };

  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && same(i, i + run)) run++;
    if (run >= 2) {
      if (pos + 1 + bpp >= limit) return null;
      dst[pos++] = (0xff - run + 2) & 0xff;
      row.copy(dst, pos, i * bpp, i * bpp + bpp);
      pos += bpp;
      i += run;
    } else {
      let lit = 1;
      while (i + lit < n && lit < 127 && !(i + lit + 1 < n && same(i + lit, i + lit + 1))) lit++;
      const litBytes = lit * bpp;
      if (pos + 1 + litBytes >= limit) return null;
      dst[pos++] = (lit - 1) & 0xff;
      row.copy(dst, pos, i * bpp, i * bpp + litBytes);
      pos += litBytes;
      i += lit;
    }
  }
  return dst.subarray(0, pos);
}

function resolveMediaCode(mediaType, { isL8050, useBleed }) {
  const mt = String(mediaType || '').toLowerCase();
  if (mt.includes('plain') || mt.includes('stationery')) return EPSON_ESCPR_MEDIA.PLAIN;
  if (mt.includes('matte')) return EPSON_ESCPR_MEDIA.MATTE;
  if (mt.includes('semi') || mt === 'photosg') return EPSON_ESCPR_MEDIA.SEMI_GLOSS;
  if (mt.includes('premium') || mt === 'photopg') return EPSON_ESCPR_MEDIA.PREMIUM_GLOSSY;
  if (mt.includes('gloss') || mt.includes('photo')) return isL8050 ? EPSON_ESCPR_MEDIA.EPSON_GLOSSY : EPSON_ESCPR_MEDIA.PREMIUM_GLOSSY;
  if (isL8050) return EPSON_ESCPR_MEDIA.EPSON_GLOSSY;
  return useBleed ? EPSON_ESCPR_MEDIA.PREMIUM_GLOSSY : EPSON_ESCPR_MEDIA.PLAIN;
}

/**
 * Resolves sheet and printable area geometry at 360 dpi for a direct USB ESC/P-R job.
 */
export function escprGeometry(widthMm, heightMm, { borderless = true, isL8050 = false, mediaType = '' } = {}) {
  const shortMm = Math.min(Number(widthMm) || 101.6, Number(heightMm) || 152.4);
  const longMm = Math.max(Number(widthMm) || 101.6, Number(heightMm) || 152.4);
  const plainRequested = /plain|stationery/i.test(String(mediaType || ''));
  const is4x6 = Math.abs(shortMm - 101.6) <= 1.5 && Math.abs(longMm - 152.4) <= 1.5;
  const ep = borderless && !plainRequested ? epsonBorderlessPaper(shortMm, longMm) : null;

  if (ep && isL8050 && is4x6) {
    return {
      paperW: 1440,
      paperH: 2160,
      areaW: 1516,
      areaH: 2200,
      blLeft: 38,
      blTop: 11,
      marginLeft: -38,
      marginTop: -11,
      useBleed: true,
      paper: ep
    };
  }
  if (ep) {
    return {
      paperW: ep.wPx,
      paperH: ep.hPx,
      areaW: ep.wPx + BL_EXTRA_W,
      areaH: ep.hPx + BL_EXTRA_H,
      blLeft: BL_LEFT,
      blTop: BL_TOP,
      marginLeft: -BL_LEFT,
      marginTop: -BL_TOP,
      useBleed: true,
      paper: ep
    };
  }
  const px = paperPixels360(shortMm, longMm);
  const areaW = Math.max(1, px.wPx - 2 * BORDER_3MM);
  const areaH = Math.max(1, px.hPx - 2 * BORDER_3MM);
  return {
    paperW: px.wPx,
    paperH: px.hPx,
    areaW,
    areaH,
    blLeft: 0,
    blTop: 0,
    marginLeft: BORDER_3MM,
    marginTop: BORDER_3MM,
    useBleed: false,
    paper: null
  };
}

/**
 * Encodes a 32-bit BGRA bitmap (Electron nativeImage.toBitmap() layout) into a complete ESC/P-R print job Buffer.
 */
export function encodeEscprJob({
  bgra,
  width,
  height,
  stride = width * 4,
  widthMm = 101.6,
  heightMm = 152.4,
  borderless = true,
  mediaType = '',
  quality = '',
  mono = false,
  isL8050 = false,
  turn = false,
  now = new Date()
}) {
  const geo = escprGeometry(widthMm, heightMm, { borderless, isL8050, mediaType });
  const { paperW, paperH, areaW, areaH, blLeft, blTop, marginLeft, marginTop, useBleed } = geo;
  const dstW = useBleed ? paperW : areaW;
  const dstH = useBleed ? paperH : areaH;
  const l = useBleed ? Math.max(0, Math.min(blLeft, areaW - paperW)) : 0;
  const t = useBleed ? Math.max(0, Math.min(blTop, areaH - paperH)) : 0;

  const media = resolveMediaCode(mediaType, { isL8050, useBleed });
  const qLower = String(quality || '').toLowerCase();
  const qualityCode = qLower === 'draft' ? 0x00 : (isL8050 && (qLower === 'best' || qLower === 'high' || !qLower) ? 0x02 : 0x01);

  const chunks = [];
  // ── Job start header ──
  chunks.push(
    Buffer.from([0x00, 0x00, 0x00, 0x1b, 0x01]),
    Buffer.from('@EJL 1284.4\n@EJL     \n', 'latin1'),
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1b, 0x28, 0x52, 0x08, 0x00, 0x00]),
    Buffer.from('REMOTE1', 'latin1'),
    Buffer.from([0x54, 0x49, 0x08, 0x00, 0x00]),
    u16be(now.getFullYear()),
    Buffer.from([now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]),
    Buffer.from([0x4a, 0x53, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]), // JS
    Buffer.from([0x4a, 0x48, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('ESCPRLib', 'latin1'), // JH
    Buffer.from([0x48, 0x44, 0x03, 0x00, 0x00, 0x03, 0x04]), // HD
    Buffer.from([0x50, 0x50, 0x03, 0x00, 0x00, 0x01, 0xff]), // PP
    Buffer.from([0x1b, 0x00, 0x00, 0x00]), // exit REMOTE1
    Buffer.from([0x1b, 0x28, 0x52, 0x06, 0x00, 0x00]),
    Buffer.from('ESCPR', 'latin1'),
    // setq: byte 6 MUST be 0x00 (EPS_CP_FULLCOLOR 24-bit RGB dsnd scanlines)
    Buffer.from([0x1b, 0x71, 0x09, 0x00, 0x00, 0x00]),
    Buffer.from('setq', 'latin1'),
    Buffer.from([media, qualityCode, mono ? 1 : 0, 0, 0, 0, 0x00, 0x00, 0x00])
  );

  if (useBleed) {
    // Standard epson-inkjet-printer-escpr borderless handshake (required on L805 for edge-to-edge output).
    chunks.push(
      Buffer.from([0x1b, 0x71, 0x0a, 0x00, 0x00, 0x00]),
      Buffer.from('seti', 'latin1'),
      Buffer.alloc(10),
      Buffer.from([0x1b, 0x75, 0x02, 0x00, 0x00, 0x00]),
      Buffer.from('chku', 'latin1'),
      Buffer.from([0x01, 0x01])
    );
  }

  // setj: 360 dpi (resByte = 0x00), bidirectional
  chunks.push(
    Buffer.from([0x1b, 0x6a, 0x16, 0x00, 0x00, 0x00]),
    Buffer.from('setj', 'latin1'),
    u32be(paperW),
    u32be(paperH),
    i16be(marginTop),
    i16be(marginLeft),
    u32be(areaW),
    u32be(areaH),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x1b, 0x70, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('sttp', 'latin1'),
    Buffer.from([0x1b, 0x70, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from('setn', 'latin1'),
    Buffer.from([0x01])
  );

  // ── Scanlines with seamless edge-pixel bleed ──
  const row = Buffer.allocUnsafe(areaW * 3);
  for (let ay = 0; ay < areaH; ay++) {
    const dy = ay < t ? 0 : ay >= t + dstH ? dstH - 1 : ay - t;
    let white = true;
    for (let ax = 0; ax < areaW; ax++) {
      const dx = ax < l ? 0 : ax >= l + dstW ? dstW - 1 : ax - l;
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
      if (mono) {
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        r = lum; g = lum; b = lum;
      }
      const o = ax * 3;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      if (r !== 0xff || g !== 0xff || b !== 0xff) white = false;
    }
    if (white) continue;
    const rle = packBitsRow(row, 3);
    const useRle = rle !== null && rle.length < row.length;
    const data = useRle ? Buffer.from(rle) : Buffer.from(row);
    const len = 7 + data.length;
    const dsndHdr = Buffer.allocUnsafe(17);
    dsndHdr[0] = 0x1b;
    dsndHdr[1] = 0x64;
    dsndHdr.writeUInt32LE(len, 2);
    dsndHdr.write('dsnd', 6, 'latin1');
    dsndHdr.writeUInt16BE(0, 10);
    dsndHdr.writeUInt16BE(ay, 12);
    dsndHdr[14] = useRle ? 1 : 0;
    dsndHdr.writeUInt16BE(data.length, 15);
    chunks.push(dsndHdr, data);
  }

  // ── Page end & job end ──
  chunks.push(
    Buffer.from([0x1b, 0x70, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from('endp', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from([0x1b, 0x6a, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('endj', 'latin1'),
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1b, 0x28, 0x52, 0x08, 0x00, 0x00]),
    Buffer.from('REMOTE1', 'latin1'),
    Buffer.from([0x4a, 0x45, 0x01, 0x00, 0x00]), // JE
    Buffer.from([0x1b, 0x00, 0x00, 0x00])
  );

  return { data: Buffer.concat(chunks), geo, media, qualityCode };
}

/**
 * Wraps Electron's nativeImage: (imageBuf, opts) -> { data: Buffer, geo, media, qualityCode }.
 */
export function makeEscprJobBuilder(nativeImage) {
  return (imageBuf, { widthMm = 101.6, heightMm = 152.4, borderless = true, mediaType = '', quality = '', mono = false, isL8050 = false } = {}) => {
    const im = nativeImage.createFromBuffer(Buffer.from(imageBuf));
    if (im.isEmpty()) throw new Error('Couldn’t read the picture to print.');
    const geo = escprGeometry(widthMm, heightMm, { borderless, isL8050, mediaType });
    const dstW = geo.useBleed ? geo.paperW : geo.areaW;
    const dstH = geo.useBleed ? geo.paperH : geo.areaH;
    const src = im.getSize();
    const turn = (src.width > src.height) !== (dstW > dstH);
    const targetW = turn ? dstH : dstW;
    const targetH = turn ? dstW : dstH;
    const resized = (src.width === targetW && src.height === targetH)
      ? im
      : im.resize({ width: targetW, height: targetH, quality: 'best' });
    const sz = resized.getSize();
    const bgra = resized.toBitmap();
    const stride = Math.floor(bgra.length / sz.height);
    if (stride < sz.width * 4) throw new Error('Couldn’t prepare the picture for the Epson USB printer.');
    return encodeEscprJob({
      bgra,
      width: sz.width,
      height: sz.height,
      stride,
      widthMm,
      heightMm,
      borderless,
      mediaType,
      quality,
      mono,
      isL8050,
      turn
    });
  };
}
