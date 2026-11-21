// PWG Raster ("image/pwg-raster", PWG 5102.4): the page format that Mopria / IPP Everywhere printers take when they
// do not take a JPEG or a PDF. The Brother DCP-T420W is one of them: it lists
//   document-format-supported = application/octet-stream, image/pwg-raster, application/vnd.brother-hbp
// and nothing else, so a photo has to be turned into a raster page and sent over IPP (Wi-Fi) with no driver.
// Same encoder as android/.../PwgRaster.kt, written from the published format description. Pure Node: Electron's
// nativeImage is handed in by the caller (makePwgRasterizer below), so tests run without Electron.
//
// File: the 4-byte sync word "RaS2", then per page a 1796-byte big-endian header and the compressed rows.
// A row is a repeat count (extra copies of the row, 0 to 255), then runs of whole pixels: a count byte 0..127
// repeats the next pixel count+1 times, 129..255 means 257-count literal pixels follow (128 is never written).

export const PWG_HEADER = 1796;
// Keeps the page in memory: about A4 at 300 dpi in colour. A4 at 600 dpi (100 MB of pixels) is left to a smaller dpi.
export const PWG_MAX_PIXELS = 26_000_000;

const put32 = (h, off, v) => h.writeUInt32BE(v >>> 0, off);
const putStr = (h, off, s) => { if (s) h.write(String(s).slice(0, 63), off, 'ascii'); };

/**
 * Encodes one page. `pixels` is chunky and top to bottom: width * height * bpp bytes (bpp 3 = sRGB, 1 = sGray).
 * Returns a Buffer holding the whole PWG Raster file for that one page.
 *   pageWidthPts / pageHeightPts   the sheet in points (1/72 in), short side first
 *   pageSizeName                   the IPP name of the paper ("na_index-4x6_4x6in"), written into the header
 *   mediaType                      the IPP paper type ("photographic-glossy"), written into the header
 *   imageBox                       true writes the whole page as the image box; false leaves it zero, exactly as CUPS does
 */
export function encodePwgRaster({ pixels, width, height, bpp = 3, dpi = 300, pageWidthPts, pageHeightPts, pageSizeName = '', mediaType = '', imageBox = true }) {
  if (bpp !== 1 && bpp !== 3) throw new Error('PWG raster: bpp must be 1 or 3.');
  if (!(width > 0 && height > 0)) throw new Error('PWG raster: empty page.');
  const stride = width * bpp;
  if (!pixels || pixels.length < stride * height) throw new Error('PWG raster: the pixel data is too short for the page.');

  const h = Buffer.alloc(PWG_HEADER);
  h.write('PwgRaster', 0, 'ascii');                       // MediaClass
  putStr(h, 128, mediaType);                              // MediaType
  put32(h, 276, dpi); put32(h, 280, dpi);                 // HWResolution
  put32(h, 340, 1);                                       // NumCopies
  put32(h, 352, pageWidthPts); put32(h, 356, pageHeightPts);   // PageSize (points)
  put32(h, 372, width); put32(h, 376, height);
  put32(h, 384, 8);                                       // BitsPerColor
  put32(h, 388, 8 * bpp);                                 // BitsPerPixel
  put32(h, 392, stride);                                  // BytesPerLine
  put32(h, 396, 0);                                       // ColorOrder: chunky
  put32(h, 400, bpp === 1 ? 18 : 19);                     // ColorSpace: sGray / sRGB
  put32(h, 420, bpp);                                     // NumColors
  put32(h, 452, 1);                                       // TotalPageCount
  put32(h, 456, 1); put32(h, 460, 1);                     // CrossFeedTransform, FeedTransform
  if (imageBox) { put32(h, 472, width); put32(h, 476, height); }   // ImageBox left / top stay 0
  put32(h, 480, 0x00FFFFFF);                              // AlternatePrimary: white
  putStr(h, 1732, pageSizeName);                          // PageSizeName

  // Worst case every pixel is a literal: one control byte per 128 pixels plus the row's repeat byte.
  const out = Buffer.allocUnsafe(4 + PWG_HEADER + height * (1 + stride + Math.ceil(width / 128) + 1));
  let o = 0;
  out.write('RaS2', o, 'ascii'); o += 4;
  h.copy(out, o); o += PWG_HEADER;

  let prevStart = -1, repeats = 0, rowOutAt = 0;
  const flush = (start) => { o = encodeRow(pixels, start, width, bpp, out, rowOutAt, repeats); };
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    if (prevStart >= 0 && repeats < 255 && pixels.compare(pixels, prevStart, prevStart + stride, start, start + stride) === 0) { repeats++; continue; }
    if (prevStart >= 0) flush(prevStart);
    prevStart = start; repeats = 0; rowOutAt = o;
  }
  flush(prevStart);
  return out.subarray(0, o);
}

// One row: the repeat byte, then its runs. Returns where the output ends.
function encodeRow(px, start, width, bpp, out, o, repeats) {
  out[o++] = repeats;
  const same = bpp === 3
    ? (a, b) => px[a] === px[b] && px[a + 1] === px[b + 1] && px[a + 2] === px[b + 2]
    : (a, b) => px[a] === px[b];
  let i = 0;
  while (i < width) {
    const at = start + i * bpp;
    let run = 1;
    while (i + run < width && run < 128 && same(at, start + (i + run) * bpp)) run++;
    if (run >= 2) {
      out[o++] = run - 1;
      for (let k = 0; k < bpp; k++) out[o++] = px[at + k];
      i += run;
    } else {
      let lit = 1;
      while (i + lit < width && lit < 128 && !(i + lit + 1 < width && same(start + (i + lit) * bpp, start + (i + lit + 1) * bpp))) lit++;
      if (lit === 1) {                                    // a single pixel is a repeat of one
        out[o++] = 0;
        for (let k = 0; k < bpp; k++) out[o++] = px[at + k];
      } else {
        out[o++] = 257 - lit;
        px.copy(out, o, at, at + lit * bpp);
        o += lit * bpp;
      }
      i += lit;
    }
  }
  return o;
}

const mmText = (v) => String(Math.round(v * 10) / 10);

/**
 * The resolution to send: one the printer lists (pwg-raster-document-resolution-supported), 300 dpi unless "best" is asked
 * for and the page is small enough to be sent at 600. Falls back to what the printer lists, then to 300.
 */
export function pickPwgDpi(available, quality, wMm, hMm) {
  const avail = (available && available.length ? available : [300]).slice().sort((a, b) => a - b);
  const px = (d) => Math.round(Math.min(wMm, hMm) / 25.4 * d) * Math.round(Math.max(wMm, hMm) / 25.4 * d);
  // "best" sends 600 dpi when the sheet is up to about 5x7 in (12.6 M pixels); a bigger sheet at 600 dpi would take minutes over Wi-Fi.
  const want = quality === 'best' && px(600) <= 13_000_000 ? 600 : 300;
  const fits = avail.filter((d) => px(d) <= PWG_MAX_PIXELS);
  const list = fits.length ? fits : avail;
  return list.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), list[0]);
}

/**
 * Wraps Electron's nativeImage: (photo as PNG / JPEG bytes, page spec) -> PWG Raster file.
 * spec: { wMm, hMm, dpi, gray, pageSizeName, mediaType, imageBox }. The photo is turned to fit the sheet's long side,
 * scaled to the sheet at `dpi`, and anything see-through goes onto white.
 */
export function makePwgRasterizer(nativeImage) {
  return (image, spec) => {
    const { wMm, hMm, dpi = 300, gray = false, pageSizeName = '', mediaType = '', imageBox = true } = spec || {};
    const shortMm = Math.min(wMm, hMm), longMm = Math.max(wMm, hMm);
    const wPx = Math.round(shortMm / 25.4 * dpi), hPx = Math.round(longMm / 25.4 * dpi);
    if (!(wPx > 0 && hPx > 0) || wPx * hPx > PWG_MAX_PIXELS) throw new Error('This page is too large for the printer’s raster mode.');
    const im = nativeImage.createFromBuffer(Buffer.from(image));
    if (im.isEmpty()) throw new Error('Couldn’t read the picture to print.');
    const src = im.getSize();
    const turn = src.width > src.height;                    // a picture lying down goes onto the sheet's long side
    const small = im.resize(turn ? { width: hPx, height: wPx, quality: 'best' } : { width: wPx, height: hPx, quality: 'best' });
    const sz = small.getSize();
    const bgra = small.toBitmap();                          // B, G, R, A per pixel
    const stride = Math.floor(bgra.length / sz.height);
    if (stride < sz.width * 4) throw new Error('Couldn’t prepare the picture for the printer.');
    const bpp = gray ? 1 : 3;
    const pixels = Buffer.allocUnsafe(wPx * hPx * bpp);
    // Source pixel (sx, sy) of the (possibly turned) picture -> its place on the page. A turned picture is rotated 90 degrees clockwise.
    for (let dy = 0; dy < hPx; dy++) {
      for (let dx = 0; dx < wPx; dx++) {
        const sx = turn ? dy : dx, sy = turn ? sz.height - 1 - dx : dy;
        if (sx >= sz.width || sy >= sz.height || sx < 0 || sy < 0) { pixels.fill(255, (dy * wPx + dx) * bpp, (dy * wPx + dx + 1) * bpp); continue; }
        const p = sy * stride + sx * 4, a = bgra[p + 3];
        let b = bgra[p], g = bgra[p + 1], r = bgra[p + 2];
        if (a !== 255) { b = Math.min(255, b + 255 - a); g = Math.min(255, g + 255 - a); r = Math.min(255, r + 255 - a); }   // premultiplied colour over white
        const q = (dy * wPx + dx) * bpp;
        if (gray) pixels[q] = (299 * r + 587 * g + 114 * b) / 1000;
        else { pixels[q] = r; pixels[q + 1] = g; pixels[q + 2] = b; }
      }
    }
    return encodePwgRaster({
      pixels, width: wPx, height: hPx, bpp, dpi,
      pageWidthPts: Math.round(shortMm / 25.4 * 72), pageHeightPts: Math.round(longMm / 25.4 * 72),
      pageSizeName: pageSizeName || 'custom_photo_' + mmText(shortMm) + 'x' + mmText(longMm) + 'mm', mediaType, imageBox
    });
  };
}
