/*
 * printer/epson-l8050.js: Epson L8050, 4 x 6 in (4R), borderless, sent over IPP (the Android and iPad apps, USB or Wi-Fi).
 *
 * One paste-in part of booth.src.html (see scripts/assemble-booth.mjs). It exposes window._epsonL8050.
 *
 * The problem (a client's L8050 on an Android tablet): a borderless 4R print came out with a white strip of about 3 mm on one
 * side of the sheet and the opposite side cut off; the Edges settings did not get rid of it. The page is a plain 4 x 6 in
 * picture, so the printer is placing it 1:1 from the top-left corner of its borderless print area, and that corner is NOT the
 * corner of the sheet.
 *
 * Where the numbers come from: Epson's own Windows driver for the L8050 (e1wf1b0e.inf), run on a laptop with the printer queue
 * pointed at a file (no paper, no ink), Borderless on, 4 x 6 in. The page set-up (the `setj` command of the job, 720 dpi) is
 *     sheet  2880 x 4320   (4.000 x 6.000 in)
 *     area   3032 x 4400   (4.211 x 6.111 in), starting 76 left of and 22 above the sheet
 * so the printer prints 76 (2.68 mm) past the left and the right edge, 22 (0.78 mm) past the top and 58 (2.05 mm) past the
 * bottom. The same numbers came out for glossy, semi-gloss, high-gloss and matte photo paper and for plain paper, in every
 * quality (Draft is the same at 360 dpi). The driver also enlarges the page 5.28% about the middle of that area (checked with line
 * test pages through the same queue); that is what the Mac and Windows hardcodes in desktop/lib/helper.mjs undo, and it matches
 * the Mac values measured on real paper there (1/1.0528 = 0.9498; the page sits 0.64 mm low).
 *
 * What this does: it sends the picture on a page the size of that area, with the sheet's picture 76 / 22 px (at 720 dpi) in from
 * the page's top-left corner, and the strips around it filled with the picture's own edge pixels. The printer puts the page's
 * corner on the area's corner, so the picture lands on the sheet edge to edge and the strips are printed off the paper.
 *
 * NOT YET TRIED ON A REAL L8050. The area is the driver's; that the printer's own IPP path starts a 1:1 page at the same corner
 * is what the client's print points to (white strip 2.7 to 3.3 mm on the side the area reaches farthest past the sheet, the
 * opposite side cut) but it is not proven. The booth's Edges settings still move each side from here.
 */
(function (G) {
  'use strict';

  // The sheet and the print area, in 1/720 inch, from the driver's job (see above).
  var GEO = { sheetW: 2880, sheetH: 4320, left: 76, top: 22, right: 76, bottom: 58 };
  var SHEET_MM = [101.6, 152.4];

  function isL8050(p) {
    return !!(p && (String(p.epsonModel || '').toUpperCase() === 'L8050' || (p.usb && p.vid === 1208 && p.pid === 2150) || /(?:^|[^A-Za-z0-9])L8050(?![0-9])/i.test(String(p.name || ''))));
  }
  function is4x6(paper) {
    if (!paper) return false;
    var a = Math.min(paper.w, paper.h), b = Math.max(paper.w, paper.h);
    return Math.abs(a - SHEET_MM[0]) <= 1.5 && Math.abs(b - SHEET_MM[1]) <= 1.5;
  }

  // Where things go on the page for a sheet picture of w x h pixels (a 4 x 6 in portrait page at any dpi).
  // Returns the page size and the offset of the picture, in whole pixels, or null when the canvas is not a 4 x 6 portrait page.
  function layout(w, h) {
    if (!(w > 0 && h > 0) || h <= w) return null;
    if (Math.abs(w / h - GEO.sheetW / GEO.sheetH) > 0.01) return null;
    var s = w / GEO.sheetW;                                   // pixels per 1/720 inch
    var L = Math.round(GEO.left * s), T = Math.round(GEO.top * s), R = Math.round(GEO.right * s), B = Math.round(GEO.bottom * s);
    return { pageW: L + w + R, pageH: T + h + B, left: L, top: T, right: R, bottom: B };
  }

  // Applies to: a 4 x 6 in borderless job to an L8050 over IPP (Android and iPad apps).
  function applies(p, paper, wo, cv) {
    return isL8050(p) && !!(wo && wo.borderless) && is4x6(paper) && !!cv && !!layout(cv.width, cv.height);
  }

  // The page to send: the picture in place, the strips around it from its own edge pixels. `mk` makes a canvas (tests pass their own).
  function bleedPage(cv, mk) {
    var w = cv.width, h = cv.height, g = layout(w, h);
    if (!g) return cv;
    var page = mk ? mk() : document.createElement('canvas');
    page.width = g.pageW; page.height = g.pageH;
    if (cv._pbDpi) page._pbDpi = cv._pbDpi;
    var x = page.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, g.pageW, g.pageH);
    x.imageSmoothingEnabled = false;
    var L = g.left, T = g.top, R = g.right, B = g.bottom;
    // The four sides: one row / column of the picture stretched over the strip.
    x.drawImage(cv, 0, 0, w, 1, L, 0, w, T);
    x.drawImage(cv, 0, h - 1, w, 1, L, T + h, w, B);
    x.drawImage(cv, 0, 0, 1, h, 0, T, L, h);
    x.drawImage(cv, w - 1, 0, 1, h, L + w, T, R, h);
    // The four corners: the corner pixel.
    x.drawImage(cv, 0, 0, 1, 1, 0, 0, L, T);
    x.drawImage(cv, w - 1, 0, 1, 1, L + w, 0, R, T);
    x.drawImage(cv, 0, h - 1, 1, 1, 0, T + h, L, B);
    x.drawImage(cv, w - 1, h - 1, 1, 1, L + w, T + h, R, B);
    // The picture itself, 1:1.
    x.drawImage(cv, L, T);
    return page;
  }

  G._epsonL8050 = { GEO: GEO, isL8050: isL8050, is4x6: is4x6, layout: layout, applies: applies, bleedPage: bleedPage };
})(typeof window !== 'undefined' ? window : globalThis);
