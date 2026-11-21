// Run: node desktop/test/test-pwgraster.mjs
// PWG Raster encoding, and printing a photo to a printer that takes ONLY PWG Raster (a Brother DCP-T420W): no JPEG, no PDF.
import assert from 'node:assert/strict';
import http from 'node:http';
import { encodePwgRaster, makePwgRasterizer, pickPwgDpi, PWG_HEADER } from '../lib/pwgraster.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ippPrintDirect, ippCaps, directFormats, pickMediaType, labelMediaType } from '../lib/netprinters.mjs';
import { setUsbBackend, probeUsbPrinters, decodeChunked, isHttpComplete, parseHttpReply } from '../lib/usbipp.mjs';
import { initHelper, handleHelper, stopHelper } from '../lib/helper.mjs';

// ---- an independent decoder, written from the format description (not from the encoder) ----
function decodePwg(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RaS2');
  const h = buf.subarray(4, 4 + PWG_HEADER);
  assert.equal(h.length, PWG_HEADER);
  const u = (o) => h.readUInt32BE(o);
  const str = (o) => h.toString('latin1', o, o + 64).replace(/\0.*$/s, '');
  const hdr = {
    mediaClass: str(0), mediaType: str(128), dpi: [u(276), u(280)], pagePts: [u(352), u(356)], width: u(372), height: u(376),
    bitsPerColor: u(384), bitsPerPixel: u(388), bytesPerLine: u(392), colorOrder: u(396), colorSpace: u(400), numColors: u(420),
    totalPages: u(452), imageBox: [u(464), u(468), u(472), u(476)], alternatePrimary: u(480), pageSizeName: str(1732)
  };
  const bpp = hdr.numColors;
  const px = Buffer.alloc(hdr.width * hdr.height * bpp);
  let p = 4 + PWG_HEADER, y = 0;
  while (y < hdr.height) {
    const repeat = buf[p++];
    const row = Buffer.alloc(hdr.width * bpp);
    let x = 0;
    while (x < hdr.width) {
      const c = buf[p++];
      assert.notEqual(c, 128, 'the encoder never writes the 128 code');
      if (c <= 127) { const n = c + 1; for (let i = 0; i < n; i++) buf.copy(row, (x + i) * bpp, p, p + bpp); p += bpp; x += n; }
      else { const n = 257 - c; buf.copy(row, x * bpp, p, p + n * bpp); p += n * bpp; x += n; }
    }
    assert.equal(x, hdr.width, 'a row never runs past its width');
    for (let r = 0; r <= repeat; r++) { row.copy(px, (y + r) * hdr.width * bpp); }
    y += repeat + 1;
  }
  assert.equal(y, hdr.height, 'the repeat counts add up to the page height');
  assert.equal(p, buf.length, 'nothing is left over after the last row');
  return { hdr, px };
}

// ---- 1. the encoder: every pixel comes back, across solid areas, repeated rows, long literals and runs over 128 ----
{
  const w = 301, h = 40, bpp = 3;
  const px = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * bpp;
    if (y < 10) { px[o] = px[o + 1] = px[o + 2] = 255; }                                   // white rows (repeat counts)
    else if (y < 20) { px[o] = (x * 7 + y) & 255; px[o + 1] = (x * 13) & 255; px[o + 2] = (x * 31 + y * 3) & 255; }   // noisy: literals
    else if (y < 30) { const v = x < 150 ? 10 : x < 290 ? 200 : 77; px[o] = v; px[o + 1] = v; px[o + 2] = 255 - v; }  // long runs, one over 128
    else { px[o] = x % 2 ? 255 : 0; px[o + 1] = 0; px[o + 2] = 0; }                         // alternating: single pixels
  }
  const file = encodePwgRaster({ pixels: px, width: w, height: h, bpp, dpi: 300, pageWidthPts: 288, pageHeightPts: 432, pageSizeName: 'na_index-4x6_4x6in', mediaType: 'photographic-glossy' });
  const { hdr, px: back } = decodePwg(file);
  assert.deepEqual([hdr.width, hdr.height, hdr.bytesPerLine, hdr.bitsPerPixel, hdr.bitsPerColor, hdr.numColors], [w, h, w * 3, 24, 8, 3]);
  assert.deepEqual(hdr.dpi, [300, 300]); assert.deepEqual(hdr.pagePts, [288, 432]);
  assert.equal(hdr.colorSpace, 19); assert.equal(hdr.colorOrder, 0); assert.equal(hdr.totalPages, 1);
  assert.equal(hdr.mediaClass, 'PwgRaster'); assert.equal(hdr.pageSizeName, 'na_index-4x6_4x6in'); assert.equal(hdr.mediaType, 'photographic-glossy');
  assert.equal(hdr.alternatePrimary, 0x00FFFFFF);
  assert.deepEqual(hdr.imageBox, [0, 0, w, h]);
  assert.ok(back.equals(px), 'the decoded page is pixel for pixel the page that was encoded');
  const cups = decodePwg(encodePwgRaster({ pixels: px, width: w, height: h, bpp, dpi: 300, pageWidthPts: 288, pageHeightPts: 432, imageBox: false }));
  assert.deepEqual(cups.hdr.imageBox, [0, 0, 0, 0], 'imageBox:false leaves the box zero, as CUPS writes it');
  console.log('✓ Passed: a PWG Raster page decodes back to the exact pixels, with the header fields a printer reads');
}

// ---- 2. grey pages, and 256+ identical rows (the repeat byte tops out at 255 extra rows) ----
{
  const w = 70, h = 600;
  const px = Buffer.alloc(w * h, 128);
  for (let x = 0; x < w; x++) px[300 * w + x] = x * 3;                                      // one different row in the middle of grey
  const { hdr, px: back } = decodePwg(encodePwgRaster({ pixels: px, width: w, height: h, bpp: 1, dpi: 300, pageWidthPts: 10, pageHeightPts: 20 }));
  assert.equal(hdr.colorSpace, 18); assert.equal(hdr.bitsPerPixel, 8); assert.equal(hdr.numColors, 1);
  assert.ok(back.equals(px));
  assert.throws(() => encodePwgRaster({ pixels: Buffer.alloc(5), width: 10, height: 10, bpp: 3, dpi: 300, pageWidthPts: 1, pageHeightPts: 1 }), /too short/);
  console.log('✓ Passed: a grey page and a very tall run of identical rows both round-trip');
}

// ---- 3. the resolution: 300 dpi, or 600 for a small sheet when asked for the best ----
{
  assert.equal(pickPwgDpi([600, 300], 'normal', 101.6, 152.4), 300);
  assert.equal(pickPwgDpi([600, 300], 'draft', 101.6, 152.4), 300);
  assert.equal(pickPwgDpi([600, 300], 'best', 101.6, 152.4), 600);
  assert.equal(pickPwgDpi([600, 300], 'best', 210, 297), 300, 'an A4 sheet at 600 dpi is too big to send over Wi-Fi');
  assert.equal(pickPwgDpi([600], 'draft', 101.6, 152.4), 600, 'only what the printer lists');
  assert.equal(pickPwgDpi([], 'best', 101.6, 152.4), 300);
  console.log('✓ Passed: the raster resolution is one the printer lists, 600 dpi only for the best quality on a small sheet');
}

// ---- 4. the Electron wrapper: scaling, a picture lying down is turned onto the sheet, see-through goes onto white ----
{
  // A stand-in for Electron's nativeImage: the "file" is {w,h,mark}; pixels are a gradient, with one marker pixel at the top-left corner.
  const fake = {
    createFromBuffer(buf) { return img(JSON.parse(buf.toString())); }
  };
  function img(s) {
    const base = s.from || s;                                                              // the picture the pixels are really taken from
    const px = (x, y) => (base.alpha !== undefined ? [10, 20, 30, base.alpha] : (x === 0 && y === 0 ? [0, 0, 255, 255] : [x * 255 / Math.max(1, base.w - 1), y * 255 / Math.max(1, base.h - 1), 40, 255]));
    return {
      isEmpty: () => !!s.empty, getSize: () => ({ width: s.w, height: s.h }),
      resize({ width, height }) { return img({ ...s, w: width, h: height, from: s }); },
      toBitmap() {
        const b = Buffer.alloc(s.w * s.h * 4);
        for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
          const q = s.from ? [Math.floor(x * s.from.w / s.w), Math.floor(y * s.from.h / s.h)] : [x, y];
          const [r, g, b2, a] = px(q[0], q[1]); const o = (y * s.w + x) * 4;
          b[o] = b2; b[o + 1] = g; b[o + 2] = r; b[o + 3] = a;
        }
        return b;
      }
    };
  }
  const rast = makePwgRasterizer(fake);
  const photo = (o) => Buffer.from(JSON.stringify(o));
  // a landscape picture on a portrait sheet (2 x 3 in at 100 dpi = 200 x 300 px)
  const page = decodePwg(rast(photo({ w: 90, h: 60 }), { wMm: 50.8, hMm: 76.2, dpi: 100, gray: false, pageSizeName: 'custom_test', mediaType: 'stationery' }));
  assert.deepEqual([page.hdr.width, page.hdr.height], [200, 300]);
  assert.deepEqual(page.hdr.pagePts, [144, 216]);
  assert.deepEqual(page.hdr.dpi, [100, 100]);
  assert.equal(page.hdr.mediaType, 'stationery');
  const at = (x, y) => [...page.px.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3)];
  assert.deepEqual(at(199, 0), [0, 0, 255], 'turned a quarter turn clockwise, the picture\'s top-left corner is the sheet\'s top-right');
  assert.ok(at(0, 0)[0] < 30 && at(0, 0)[1] > 200, 'the picture\'s bottom-left is now the sheet\'s top-left (green side grows downward in the picture)');
  // a portrait picture is not turned
  const up = decodePwg(rast(photo({ w: 60, h: 90 }), { wMm: 50.8, hMm: 76.2, dpi: 100 }));
  assert.deepEqual([up.px[0], up.px[1], up.px[2]], [0, 0, 255]);
  assert.equal(up.hdr.pageSizeName, 'custom_photo_50.8x76.2mm');
  // see-through becomes white (premultiplied colour + the missing alpha), and grey is one byte per pixel
  const glass = decodePwg(rast(photo({ w: 60, h: 90, alpha: 0 }), { wMm: 50.8, hMm: 76.2, dpi: 50, gray: true }));
  assert.equal(glass.hdr.numColors, 1);
  assert.ok(glass.px.every((v) => v >= 250), 'a see-through picture prints white');
  assert.throws(() => rast(photo({ w: 1, h: 1, empty: true }), { wMm: 50, hMm: 70, dpi: 100 }), /read the picture/);
  assert.throws(() => rast(photo({ w: 10, h: 10 }), { wMm: 300, hMm: 400, dpi: 600 }), /too large/);
  console.log('✓ Passed: the page is scaled to the sheet at the dpi asked for, turned when lying down, and see-through prints white');
}

// ---- 5. a fake DCP-T420W: takes only PWG Raster ----
const OK = [0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x01];
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
function ippReply(status, attrs) {
  const parts = [Buffer.from([0x02, 0x00, (status >> 8) & 255, status & 255, 0, 0, 0, 1, 0x01]), Buffer.from([0x47, 0, 18]), Buffer.from('attributes-charset'), u16(5), Buffer.from('utf-8'), Buffer.from([0x04])];
  for (const [name, tag, vals] of attrs || []) vals.forEach((v, i) => {
    const n = i === 0 ? Buffer.from(name) : Buffer.alloc(0), val = Buffer.isBuffer(v) ? v : Buffer.from(v);
    parts.push(Buffer.from([tag]), u16(n.length), n, u16(val.length), val);
  });
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}
const dpiVal = (n) => Buffer.concat([u32(n), u32(n), Buffer.from([3])]);
const T420W = (formats) => [
  ['printer-make-and-model', 0x41, ['Brother DCP-T420W']],
  ['document-format-supported', 0x49, formats],
  ['media-ready', 0x44, ['iso_a4_210x297mm']],
  ['media-supported', 0x44, ['iso_a4_210x297mm', 'na_letter_8.5x11in', 'na_index-4x6_4x6in', 'na_5x7_5x7in']],
  ['print-quality-supported', 0x23, [u32(3), u32(4), u32(5)]],
  ['print-color-mode-supported', 0x44, ['color', 'monochrome']],
  ['media-type-supported', 0x44, ['stationery', 'stationery-inkjet', 'photographic-glossy', 'com.brother-bp71']],
  ['pwg-raster-document-resolution-supported', 0x32, [dpiVal(600), dpiVal(300)]],
  ['pwg-raster-document-type-supported', 0x44, ['sgray_8', 'srgb_8']]
];

// Walks a Print-Job request: the attributes as [name, tag, value] and where the document starts.
function readJob(body) {
  const list = []; let p = 8, last = '';
  while (p < body.length) {
    const tag = body[p++];
    if (tag === 0x03) break;
    if (tag <= 0x05) continue;
    const nl = body.readUInt16BE(p); p += 2;
    if (nl) { last = body.toString('latin1', p, p + nl); p += nl; }
    const vl = body.readUInt16BE(p); p += 2;
    list.push([last, tag, body.subarray(p, p + vl)]); p += vl;
  }
  return { attrs: list, doc: body.subarray(p), op: body.readUInt16BE(2) };
}

async function fakePrinter({ formats, refuse = () => false }) {
  const jobs = [];
  const srv = http.createServer((rq, rs) => {
    const ch = []; rq.on('data', (d) => ch.push(d));
    rq.on('end', () => {
      const body = Buffer.concat(ch);
      if (rq.url !== '/ipp/print') { rs.writeHead(404).end(); return; }
      if (body.readUInt16BE(2) === 0x000b) { rs.writeHead(200, { 'content-type': 'application/ipp' }).end(ippReply(0, T420W(formats))); return; }
      const job = readJob(body); jobs.push(job);
      rs.writeHead(200, { 'content-type': 'application/ipp' }).end(ippReply(refuse(job) ? 0x040b : 0, []));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, jobs };
}

const names = (job) => job.attrs.map((a) => a[0]);
// Members of a collection (media-col): each is an entry tagged 0x4a whose value is the member's name.
const members = (job) => job.attrs.filter((a) => a[1] === 0x4a).map((a) => a[2].toString('latin1'));
const text = (job, n) => { const a = job.attrs.find((x) => x[0] === n); return a ? a[2].toString('utf8') : null; };
// The booth's picture: any bytes; the rasterizer below is what the app does with Electron's nativeImage.
const rasterizer = (calls) => (image, spec) => {
  calls.push(spec);
  const w = Math.round(Math.min(spec.wMm, spec.hMm) / 25.4 * 20), h = Math.round(Math.max(spec.wMm, spec.hMm) / 25.4 * 20);   // small stand-in page
  const bpp = spec.gray ? 1 : 3, px = Buffer.alloc(w * h * bpp, 200);
  return encodePwgRaster({ pixels: px, width: w, height: h, bpp, dpi: spec.dpi, pageWidthPts: Math.round(Math.min(spec.wMm, spec.hMm) / 25.4 * 72), pageHeightPts: Math.round(Math.max(spec.wMm, spec.hMm) / 25.4 * 72), pageSizeName: spec.pageSizeName, mediaType: spec.mediaType, imageBox: spec.imageBox });
};

{
  const p = await fakePrinter({ formats: ['application/octet-stream', 'image/pwg-raster', 'application/vnd.brother-hbp'] });
  const caps = await ippCaps('127.0.0.1', p.port);
  assert.equal(caps.model, 'Brother DCP-T420W');
  assert.deepEqual(caps.pwgRes, [600, 300]);
  assert.deepEqual(caps.qualities, [3, 4, 5]);
  assert.deepEqual(caps.pwgTypes, ['sgray_8', 'srgb_8']);
  assert.ok(caps.colorModes.includes('monochrome') && caps.mediaTypes.includes('photographic-glossy'));
  assert.deepEqual(directFormats(caps, true), { jpeg: false, pwg: true });
  assert.deepEqual(directFormats(caps, false), { jpeg: false, pwg: false }, 'with no rasterizer it can not be used straight');
  assert.equal(pickMediaType(caps, 'Glossy Photo'), 'photographic-glossy');
  assert.equal(pickMediaType(caps, 'plain'), 'stationery');
  assert.equal(pickMediaType(caps, 'com.brother-bp71'), 'com.brother-bp71');
  assert.equal(pickMediaType(caps, ''), '');
  assert.equal(pickMediaType(caps, 'matte'), '');
  console.log('✓ Passed: a PWG-only printer is read for its raster resolutions, colour types, qualities and paper types');

  // Without a rasterizer the printer is turned away, with what it does accept.
  await assert.rejects(() => ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1, 2, 3]), widthMm: 101.6, heightMm: 152.4 }), /can’t take photos straight from the app.*pwg-raster/s);

  // A 4 x 6 print, best quality, glossy paper.
  const calls = [];
  const r = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1, 2, 3]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer(calls), quality: 'best', mediaType: 'Glossy Photo' });
  assert.equal(r.format, 'image/pwg-raster'); assert.equal(r.dpi, 600); assert.equal(r.media, 'page 101.6x152.4 mm, zero margins');
  assert.equal(p.jobs.length, 1, 'accepted at the first try');
  const job = p.jobs[0];
  assert.equal(job.op, 0x0002);
  assert.equal(text(job, 'document-format'), 'image/pwg-raster');
  assert.ok(names(job).includes('media-col') && members(job).includes('media-top-margin') && members(job).includes('media-bottom-margin'));
  assert.ok(members(job).includes('media-size') && members(job).includes('media-type'), 'the paper type rides inside media-col');
  assert.ok(!names(job).includes('media-type'), 'and is not sent a second time on its own');
  assert.equal(text(job, 'print-quality'), '\u0000\u0000\u0000\u0005');
  assert.equal(job.attrs.find((a) => a[0] === 'print-quality')[1], 0x23);
  assert.equal(text(job, 'print-color-mode'), 'color');
  assert.ok(!names(job).includes('print-scaling'), 'a raster page is never scaled');
  const sizes = job.attrs.filter((a) => a[1] === 0x21).map((a) => a[2].readUInt32BE(0));
  assert.deepEqual(sizes.slice(0, 2), [10160, 15240], 'the 4 x 6 in paper, in hundredths of a millimetre');
  const page = decodePwg(Buffer.from(job.doc));
  assert.equal(page.hdr.pageSizeName, 'na_index-4x6_4x6in'); assert.equal(page.hdr.mediaType, 'photographic-glossy');
  assert.deepEqual(page.hdr.pagePts, [288, 432]); assert.deepEqual(page.hdr.dpi, [600, 600]);
  assert.deepEqual(page.hdr.imageBox, [0, 0, 0, 0]);
  assert.equal(calls.length, 1); assert.equal(calls[0].gray, false); assert.equal(calls[0].imageBox, false);
  console.log('✓ Passed: a photo goes to a PWG-only printer as image/pwg-raster on the printer\'s own 4 x 6 paper, zero margins, with quality, colour and paper type');

  // Normal quality, plain paper: 300 dpi.
  p.jobs.length = 0;
  const r2 = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), quality: 'normal' });
  assert.equal(r2.dpi, 300); assert.equal(decodePwg(Buffer.from(p.jobs[0].doc)).hdr.dpi[0], 300);
  assert.equal(p.jobs[0].attrs.find((a) => a[0] === 'print-quality')[2].readUInt32BE(0), 4);
  console.log('✓ Passed: normal quality sends 300 dpi');
  p.srv.close();
}

// ---- 6. a printer that refuses the extra settings still prints: they are dropped, the page stays the same ----
{
  const p = await fakePrinter({ formats: ['image/pwg-raster'], refuse: (job) => names(job).includes('print-quality') || names(job).includes('print-color-mode') });
  const r = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), quality: 'best', mediaType: 'photographic-glossy' });
  assert.equal(p.jobs.length, 2, 'once with the settings, once without');
  assert.equal(r.quality, 0); assert.equal(r.mediaType, '');
  assert.ok(!names(p.jobs[1]).includes('print-quality') && !members(p.jobs[1]).includes('media-type') && names(p.jobs[1]).includes('media-col'));
  assert.ok(Buffer.from(p.jobs[0].doc).equals(Buffer.from(p.jobs[1].doc)), 'the same page both times');
  p.srv.close();
  console.log('✓ Passed: settings a printer refuses are dropped and the same page is sent again');
}

// ---- 7. a printer that refuses the zero-margin page gets the paper by its name ----
{
  const p = await fakePrinter({ formats: ['image/pwg-raster'], refuse: (job) => names(job).includes('media-col') });
  const r = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]) });
  assert.equal(r.media, 'na_index-4x6_4x6in');
  assert.equal(text(p.jobs[p.jobs.length - 1], 'media'), 'na_index-4x6_4x6in');
  p.srv.close();
  console.log('✓ Passed: when the zero-margin page is refused, the paper name is tried');
}

// ---- 8. a printer that takes JPEG is still sent a JPEG, even when a rasterizer is available ----
{
  const p = await fakePrinter({ formats: ['image/jpeg', 'image/pwg-raster'] });
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  await ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg, widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), quality: 'best' });
  assert.equal(text(p.jobs[0], 'document-format'), 'image/jpeg');
  assert.deepEqual([...p.jobs[0].doc], [...jpeg]);
  assert.ok(!names(p.jobs[0]).includes('print-quality'), 'JPEG printers are sent exactly what they were before');
  p.srv.close();
  console.log('✓ Passed: a JPEG printer keeps getting a plain JPEG');
}

// ---- 9. odd printers: only colour types it can not do, and no paper size at all ----
{
  const p = await fakePrinter({ formats: ['image/pwg-raster'] });
  await assert.rejects(() => ippPrintDirect({ ip: '127.0.0.1', port: p.port, jpeg: Buffer.from([1]), rasterize: rasterizer([]) }), /paper size is missing/);
  p.srv.close();
  console.log('✓ Passed: a missing paper size gives a plain message');
}

// ---- 10. through the app's own print service: add the printer "direct", then print a PNG page to it ----
{
  const p = await fakePrinter({ formats: ['application/octet-stream', 'image/pwg-raster', 'application/vnd.brother-hbp'] });
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-pwg-'));
  const file = join(dir, 'direct-printers.json'), calls = [];
  initHelper({ workerPath: join(dir, 'none.ps1'), logger: () => {}, rasterize: rasterizer(calls), directPrintersFile: file });
  const post = (path, body) => handleHelper(new Request('http://127.0.0.1:17321' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), path, new URLSearchParams());
  const get = (path, qs = '') => handleHelper(new Request('http://127.0.0.1:17321' + path + (qs ? '?' + qs : ''), { method: 'GET' }), path, new URLSearchParams(qs));
  const added = await (await post('/printer/add', { ip: '127.0.0.1', port: p.port, path: '/ipp/print', name: 'Brother DCP-T420W', direct: true })).json();
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.printer, 'Brother DCP-T420W (direct 127.0.0.1)');
  assert.ok(readFileSync(file, 'utf8').includes('Brother DCP-T420W (direct 127.0.0.1)'), 'remembered for the next start');
  // /printer/caps returns known:true + IPP media keywords + readable labels for direct printers
  const capsRes = await (await get('/printer/caps', 'printer=' + encodeURIComponent(added.printer))).json();
  assert.equal(capsRes.ok, true); assert.equal(capsRes.known, true);
  assert.deepEqual(capsRes.mediaTypes, ['stationery', 'stationery-inkjet', 'photographic-glossy', 'com.brother-bp71']);
  assert.equal(capsRes.mediaLabels['photographic-glossy'], 'Glossy Photo Paper');
  assert.equal(capsRes.mediaLabels['com.brother-bp71'], 'Brother BP71 Photo');
  // /paper returns real numeric w/h (no NaN) for direct printers
  const paperRes = await (await get('/paper', 'printer=' + encodeURIComponent(added.printer) + '&w=101.6&h=152.4')).json();
  assert.equal(paperRes.ok, true); assert.equal(paperRes.known, true);
  assert.ok(paperRes.paperList.length >= 4 && paperRes.paperList.every((x) => Number.isFinite(x.w) && x.w > 0 && Number.isFinite(x.h) && x.h > 0));
  const p4x6 = paperRes.paperList.find((x) => x.key === 'na_index-4x6_4x6in');
  assert.ok(p4x6 && Math.abs(p4x6.w - 101.6) < 0.2 && Math.abs(p4x6.h - 152.4) < 0.2);
  // /printer/configure shows non-SELPHY direct guidance for Brother
  const cfgRes = await (await post('/printer/configure', { printer: added.printer })).json();
  assert.equal(cfgRes.ok, true); assert.match(cfgRes.message, /Glossy Photo Paper/); assert.ok(!/Postcard/i.test(cfgRes.message));
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const printed = await (await post('/print', { printer: added.printer, pages: [png], widthMm: 101.6, heightMm: 152.4, quality: 'best', mediaType: 'Glossy Photo' })).json();
  assert.equal(printed.ok, true, JSON.stringify(printed));
  assert.equal(p.jobs.length, 1);
  assert.equal(text(p.jobs[0], 'document-format'), 'image/pwg-raster');
  assert.equal(decodePwg(Buffer.from(p.jobs[0].doc)).hdr.mediaType, 'photographic-glossy');
  assert.equal(calls[0].dpi, 600);
  // a printer that takes neither a JPEG nor a raster page is still turned away
  const odd = await fakePrinter({ formats: ['application/vnd.brother-hbp'] });
  const refused = await (await post('/printer/add', { ip: '127.0.0.1', port: odd.port, path: '/ipp/print', name: 'Odd', direct: true })).json();
  assert.equal(refused.ok, false); assert.match(refused.error, /can’t take photos straight from the app/);
  odd.srv.close(); p.srv.close(); stopHelper(); rmSync(dir, { recursive: true, force: true });
  console.log('✓ Passed: the print service adds a PWG-only printer direct, reports caps/papers cleanly, remembers it, and prints a PNG page to it');
}

// Helper: extracts [top, bottom, left, right] margins from a job's media-col attributes.
function readMargins(job) {
  const out = {};
  for (let i = 0; i < job.attrs.length - 1; i++) {
    if (job.attrs[i][1] === 0x4a && job.attrs[i + 1][1] === 0x21) {
      const k = job.attrs[i][2].toString('latin1');
      if (k.endsWith('-margin')) out[k] = job.attrs[i + 1][2].readUInt32BE(0);
    }
  }
  return [out['media-top-margin'], out['media-bottom-margin'], out['media-left-margin'], out['media-right-margin']];
}
function colMediaType(job) {
  for (let i = 0; i < job.attrs.length - 1; i++) {
    if (job.attrs[i][1] === 0x4a && job.attrs[i][2].toString('latin1') === 'media-type') {
      return job.attrs[i + 1][2].toString('utf8');
    }
  }
  return '';
}

// ---- 11. Brother DCP-T420W paper-type, borderless/plain-paper margin rules, and 3 mm fallback ----
{
  const p = await fakePrinter({ formats: ['application/octet-stream', 'image/pwg-raster', 'application/vnd.brother-hbp'] });
  const caps = await ippCaps('127.0.0.1', p.port);
  assert.equal(pickMediaType(caps, 'inkjet'), 'stationery-inkjet');
  assert.equal(pickMediaType(caps, 'bp71'), 'com.brother-bp71');
  assert.equal(labelMediaType('stationery'), 'Plain Paper');
  assert.equal(labelMediaType('stationery-inkjet'), 'Inkjet Paper');
  assert.equal(labelMediaType('photographic-glossy'), 'Glossy Photo Paper');
  assert.equal(labelMediaType('com.brother-bp71'), 'Brother BP71 Photo');

  // Default 4x6 photo sheet (mediaType empty, borderless on): auto-selects photographic-glossy + 0 mm margins.
  const rPhoto = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, image: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]) });
  assert.equal(rPhoto.mediaType, 'photographic-glossy');
  assert.deepEqual(readMargins(p.jobs[0]), [0, 0, 0, 0]);
  assert.equal(colMediaType(p.jobs[0]), 'photographic-glossy');
  assert.equal(decodePwg(Buffer.from(p.jobs[0].doc)).hdr.mediaType, 'photographic-glossy');

  // Plain paper (stationery): NEVER asks for 0 margins (Brother constrains borderless against stationery); uses 3 mm (300).
  p.jobs.length = 0;
  const rPlain = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, image: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), mediaType: 'plain' });
  assert.equal(p.jobs.length, 1, 'plain paper accepted on the first try with 3 mm margins');
  assert.equal(rPlain.mediaType, 'stationery');
  assert.match(rPlain.media, /3 mm margins/);
  assert.deepEqual(readMargins(p.jobs[0]), [300, 300, 300, 300]);
  assert.equal(colMediaType(p.jobs[0]), 'stationery');

  // borderless: false on glossy paper: uses 3 mm margins while preserving photographic-glossy.
  p.jobs.length = 0;
  const rBord = await ippPrintDirect({ ip: '127.0.0.1', port: p.port, image: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), mediaType: 'photographic-glossy', borderless: false });
  assert.equal(p.jobs.length, 1);
  assert.deepEqual(readMargins(p.jobs[0]), [300, 300, 300, 300]);
  assert.equal(colMediaType(p.jobs[0]), 'photographic-glossy');
  assert.match(rBord.media, /3 mm margins/);

  // Explicit paperName override (5x7) is honored even if widthMm/heightMm were 4x6.
  p.jobs.length = 0;
  await ippPrintDirect({ ip: '127.0.0.1', port: p.port, image: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, paperName: 'na_5x7_5x7in', rasterize: rasterizer([]), mediaType: 'bp71' });
  const pg5x7 = decodePwg(Buffer.from(p.jobs[0].doc));
  assert.equal(pg5x7.hdr.pageSizeName, 'na_5x7_5x7in');
  assert.equal(pg5x7.hdr.mediaType, 'com.brother-bp71');
  p.srv.close();

  // If a printer rejects 0-margin media-col, it falls back to 3 mm media-col with media-type still inside media-col.
  const pNoZero = await fakePrinter({
    formats: ['image/pwg-raster'],
    refuse: (job) => names(job).includes('media-col') && readMargins(job).every((m) => m === 0)
  });
  const rFallback = await ippPrintDirect({ ip: '127.0.0.1', port: pNoZero.port, image: Buffer.from([1]), widthMm: 101.6, heightMm: 152.4, rasterize: rasterizer([]), mediaType: 'photographic-glossy' });
  assert.match(rFallback.media, /3 mm margins/);
  assert.equal(rFallback.mediaType, 'photographic-glossy');
  const accepted = pNoZero.jobs[pNoZero.jobs.length - 1];
  assert.deepEqual(readMargins(accepted), [300, 300, 300, 300]);
  assert.equal(colMediaType(accepted), 'photographic-glossy');
  pNoZero.srv.close();
  console.log('✓ Passed: DCP-T420W photo borderless auto-glossy, plain paper 3 mm margins, paperName override, and 3 mm fallback all work');
}

// ---- 12. IPP-over-USB HTTP/1.1 framing: 100 Continue, Content-Length, multi-chunk Transfer-Encoding: chunked ----
{
  // Multi-chunk Transfer-Encoding: chunked with chunk extension
  const bodyA = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x03]);
  const chunkedRaw = Buffer.concat([
    Buffer.from('4;ext=1\r\n', 'latin1'), bodyA.subarray(0, 4), Buffer.from('\r\n', 'latin1'),
    Buffer.from('6\r\n', 'latin1'), bodyA.subarray(4), Buffer.from('\r\n', 'latin1'),
    Buffer.from('0\r\n\r\n', 'latin1')
  ]);
  assert.equal(decodeChunked(chunkedRaw.subarray(0, 12)).complete, false);
  const dec = decodeChunked(chunkedRaw);
  assert.equal(dec.complete, true);
  assert.ok(dec.data.equals(bodyA));

  // Leading 100 Continue + 200 OK chunked reply
  const fullReply = Buffer.concat([
    Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/ipp\r\n\r\n', 'latin1'),
    chunkedRaw
  ]);
  assert.equal(isHttpComplete(fullReply.subarray(0, 25)), false, '100 Continue alone is not complete');
  assert.equal(isHttpComplete(fullReply.subarray(0, fullReply.length - 5)), false, 'missing terminating 0 chunk is not complete');
  assert.equal(isHttpComplete(fullReply), true);
  const parsed = parseHttpReply(fullReply);
  assert.equal(parsed.http, 200);
  assert.ok(parsed.body.equals(bodyA));

  // Leading 100 Continue + Content-Length
  const clReply = Buffer.concat([
    Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: ' + bodyA.length + '\r\n\r\n', 'latin1'),
    bodyA
  ]);
  assert.equal(isHttpComplete(clReply.subarray(0, clReply.length - 1)), false);
  assert.equal(isHttpComplete(clReply), true);
  assert.ok(parseHttpReply(clReply).body.equals(bodyA));
  console.log('✓ Passed: IPP-over-USB HTTP/1.1 handles 100 Continue, Content-Length, and multi-chunk chunked responses');
}

// ---- 13. USB printer probing and direct IPP-over-USB printing through helper.mjs (mocked libusb) ----
{
  const makeMockUsbDevice = ({ vid = 0x04f9, pid = 0x0475, withIppUsb = true, bus = 1, addr = 7, onIppRequest = null } = {}) => {
    const alts = [
      { bInterfaceNumber: 1, bAlternateSetting: 0, bInterfaceClass: 7, bInterfaceSubClass: 1, bInterfaceProtocol: 2, endpoints: [{ bmAttributes: 2, bEndpointAddress: 0x01 }, { bmAttributes: 2, bEndpointAddress: 0x82 }] }
    ];
    if (withIppUsb) {
      alts.push({ bInterfaceNumber: 1, bAlternateSetting: 1, bInterfaceClass: 7, bInterfaceSubClass: 1, bInterfaceProtocol: 4, endpoints: [{ bmAttributes: 2, bEndpointAddress: 0x03 }, { bmAttributes: 2, bEndpointAddress: 0x84 }] });
    }
    const state = { altSelected: -1, released: 0, closed: 0 };
    let rxBuf = Buffer.alloc(0);
    let pendingReply = null;
    let replyOff = 0;

    const buildChunkedHttp = (ippBuf) => {
      const mid = Math.max(1, Math.floor(ippBuf.length / 2));
      return Buffer.concat([
        Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/ipp\r\n\r\n', 'latin1'),
        Buffer.from(mid.toString(16) + '\r\n', 'latin1'), ippBuf.subarray(0, mid), Buffer.from('\r\n', 'latin1'),
        Buffer.from((ippBuf.length - mid).toString(16) + '\r\n', 'latin1'), ippBuf.subarray(mid), Buffer.from('\r\n0\r\n\r\n', 'latin1')
      ]);
    };

    const dev = {
      busNumber: bus,
      deviceAddress: addr,
      deviceDescriptor: { idVendor: vid, idProduct: pid, iProduct: 2, iManufacturer: 1 },
      configDescriptor: { interfaces: [alts] },
      open() { rxBuf = Buffer.alloc(0); pendingReply = null; replyOff = 0; },
      close() { state.closed++; },
      getStringDescriptor(idx, cb) { cb(null, idx === 1 ? 'Brother' : 'DCP-T420W'); },
      controlTransfer(bmReq, bReq, wVal, wIdx, len, cb) {
        const id = Buffer.from('MFG:Brother;CMD:HBP,PJL;MDL:DCP-T420W;CLS:PRINTER;', 'latin1');
        cb(null, Buffer.concat([u16(id.length + 2), id]));
      },
      interface(num) {
        assert.equal(num, 1);
        return {
          isKernelDriverActive: () => false,
          claim() {},
          setAltSetting(alt, cb) { state.altSelected = alt; cb(null); },
          release(_closeEps, cb) { state.released++; cb(null); },
          endpoints: [
            {
              transferType: 2, direction: 'out', timeout: 0,
              transfer(data, cb) {
                rxBuf = Buffer.concat([rxBuf, data]);
                const split = rxBuf.indexOf('\r\n\r\n', 0, 'latin1');
                if (split >= 0) {
                  const head = rxBuf.toString('latin1', 0, split);
                  const cl = Number((/content-length:\s*(\d+)/i.exec(head) || [])[1] || 0);
                  const path = (/^POST\s+(\S+)/.exec(head) || [])[1] || '/';
                  const body = rxBuf.subarray(split + 4);
                  if (body.length >= cl && onIppRequest) {
                    const ippResp = onIppRequest(path, body.subarray(0, cl));
                    pendingReply = ippResp ? buildChunkedHttp(ippResp) : Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n', 'latin1');
                    replyOff = 0;
                  }
                }
                cb(null);
              }
            },
            {
              transferType: 2, direction: 'in', timeout: 0,
              transfer(maxLen, cb) {
                if (!pendingReply || replyOff >= pendingReply.length) return cb(null, Buffer.alloc(0));
                const slice = pendingReply.subarray(replyOff, Math.min(pendingReply.length, replyOff + Math.min(maxLen, 64)));
                replyOff += slice.length;
                cb(null, slice);
              }
            }
          ]
        };
      }
    };
    return { dev, state };
  };

  // Case A: Brother DCP-T420W WITH 7/1/4 IPP-over-USB interface (alternate setting 1)
  const usbJobs = [];
  const mockA = makeMockUsbDevice({
    withIppUsb: true,
    onIppRequest(path, body) {
      if (path !== '/ipp/print') return null;
      if (body.readUInt16BE(2) === 0x000b) {
        return ippReply(0, T420W(['application/octet-stream', 'image/pwg-raster', 'application/vnd.brother-hbp']));
      }
      const job = readJob(body);
      usbJobs.push(job);
      return ippReply(0, []);
    }
  });
  const dir = mkdtempSync(join(tmpdir(), 'pb4u-usb-'));
  try {
    setUsbBackend({ getDeviceList: () => [mockA.dev] });
    const probed = await probeUsbPrinters({ platform: 'darwin' });
    assert.equal(probed.length, 1);
    assert.equal(probed[0].name, 'Brother DCP-T420W');
    assert.equal(probed[0].vidHex, '04f9');
    assert.equal(probed[0].pidHex, '0475');
    assert.equal(probed[0].hasIppUsb, true);
    assert.equal(probed[0].hasRawPrinter, true);
    assert.equal(probed[0].ippIface.alt, 1);
    assert.match(probed[0].deviceId, /MDL:DCP-T420W/);

    const calls = [];
    initHelper({ workerPath: join(dir, 'none.ps1'), logger: () => {}, rasterize: rasterizer(calls), directPrintersFile: join(dir, 'direct.json') });
    const get = (path, qs = '') => handleHelper(new Request('http://127.0.0.1:17321' + path + (qs ? '?' + qs : ''), { method: 'GET' }), path, new URLSearchParams(qs));
    const post = (path, body) => handleHelper(new Request('http://127.0.0.1:17321' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), path, new URLSearchParams());

    const st = await (await get('/status', 'refresh=1')).json();
    const usbName = 'Brother DCP-T420W (USB direct)';
    assert.ok(st.printers.includes(usbName), 'USB direct printer appears in /status: ' + JSON.stringify(st.printers));

    const probeRes = await (await get('/printer/usb-probe')).json();
    assert.equal(probeRes.ok, true);
    assert.equal(probeRes.printers.length, 1);
    assert.equal(probeRes.printers[0].installed, '', 'empty IP never falsely matches unrelated OS printers like Microsoft Print to PDF');
    assert.equal(probeRes.printers[0].usbDirectName, usbName);

    const capsRes = await (await get('/printer/caps', 'printer=' + encodeURIComponent(usbName))).json();
    assert.equal(capsRes.ok, true); assert.equal(capsRes.known, true);
    assert.ok(capsRes.mediaTypes.includes('photographic-glossy') && capsRes.mediaTypes.includes('com.brother-bp71'));

    const paperRes = await (await get('/paper', 'printer=' + encodeURIComponent(usbName) + '&w=101.6&h=152.4')).json();
    assert.equal(paperRes.ok, true); assert.equal(paperRes.known, true);
    assert.match(paperRes.match.name, /USB/);
    assert.ok(paperRes.paperList.every((x) => Number.isFinite(x.w) && Number.isFinite(x.h)));

    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const printed = await (await post('/print', { printer: usbName, pages: [png], widthMm: 101.6, heightMm: 152.4, quality: 'best', mediaType: 'photographic-glossy' })).json();
    assert.equal(printed.ok, true, JSON.stringify(printed));
    assert.equal(mockA.state.altSelected, 1, 'switched to alternate setting 1 for 7/1/4 IPP-over-USB');
    assert.equal(usbJobs.length, 1);
    assert.equal(text(usbJobs[0], 'document-format'), 'image/pwg-raster');
    assert.deepEqual(readMargins(usbJobs[0]), [0, 0, 0, 0]);
    const usbPage = decodePwg(Buffer.from(usbJobs[0].doc));
    assert.equal(usbPage.hdr.pageSizeName, 'na_index-4x6_4x6in');
    assert.equal(usbPage.hdr.mediaType, 'photographic-glossy');
    assert.deepEqual(usbPage.hdr.dpi, [600, 600]);
    assert.deepEqual(usbPage.hdr.imageBox, [0, 0, 0, 0]);

    // Case B: Brother DCP-T420W WITHOUT 7/1/4 (only 7/1/2 legacy HBP/PJL)
    const mockB = makeMockUsbDevice({ withIppUsb: false });
    setUsbBackend({ getDeviceList: () => [mockB.dev] });
    const probedWin = await probeUsbPrinters({ platform: 'win32' });
    assert.equal(probedWin[0].hasIppUsb, false);
    assert.equal(probedWin[0].hasRawPrinter, true);
    assert.match(probedWin[0].note, /Brother’s Windows USB driver/);
    const probedMac = await probeUsbPrinters({ platform: 'darwin' });
    assert.equal(probedMac[0].hasIppUsb, false);
    assert.match(probedMac[0].note, /proprietary USB interface.*Wi-Fi/s);

    const stNoIpp = await (await get('/status', 'refresh=1')).json();
    assert.ok(!stNoIpp.printers.includes(usbName), 'no broken (USB direct) entry when 7/1/4 is absent');
    const probeNoIpp = await (await get('/printer/usb-probe')).json();
    assert.equal(probeNoIpp.printers[0].hasIppUsb, false);
    assert.equal(probeNoIpp.printers[0].usbDirectName, '');
    console.log('✓ Passed: IPP-over-USB (7/1/4) prints PWG Raster direct through helper.mjs, and 7/1/2-only Brother gives clear OS guidance');
  } finally {
    setUsbBackend(null);
    stopHelper();
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(0);
