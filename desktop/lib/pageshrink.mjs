// A print page made a little smaller, in the middle of a white page of the same size (see the borderless
// note in helper.mjs). Takes Electron's nativeImage, so this file imports nothing and tests can pass it in.
// A print page as a JPEG (for printers that take a photo straight over IPP). Anything see-through goes onto white,
// so a transparent corner prints white and not black.
export function makePngToJpeg(nativeImage, quality = 95) {
  return (png) => {
    const im = nativeImage.createFromBuffer(png);
    if (im.isEmpty()) return null;
    const { width, height } = im.getSize();
    const px = im.toBitmap();                                  // B, G, R, A per pixel
    if (px.length >= width * height * 4) {
      let seeThrough = false;
      for (let i = 3; i < width * height * 4; i += 4) { if (px[i] !== 255) { seeThrough = true; break; } }
      if (seeThrough) {
        const out = Buffer.from(px);
        for (let i = 0; i < width * height * 4; i += 4) {
          const a = out[i + 3];
          if (a === 255) continue;
          for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, out[i + c] + (255 - a));   // premultiplied colour over white
          out[i + 3] = 255;
        }
        return nativeImage.createFromBitmap(out, { width, height }).toJPEG(quality);
      }
    }
    return im.toJPEG(quality);
  };
}

// Where the smaller picture goes on a page of width x height pixels. `scale` is one number (the same on both sides, centred) or
// { x, y, dx, dy } for a printer measured side by side: x is the scale across the short side of a portrait page, y along its long
// side, and dx / dy move the picture off centre by that fraction of the side (+ is right / down). A page that arrives sideways
// gets x and y swapped and no shift, since the printer turns it and which way is not known here.
export function shrinkBox(width, height, scale) {
  let sx, sy, dx = 0, dy = 0;
  if (scale && typeof scale === 'object') {
    sx = Number(scale.x) || 1; sy = Number(scale.y) || 1;
    if (width > height) { const t = sx; sx = sy; sy = t; } else { dx = Number(scale.dx) || 0; dy = Number(scale.dy) || 0; }
  } else { sx = sy = Number(scale) || 1; }
  const w = Math.max(1, Math.min(width, Math.round(width * sx))), h = Math.max(1, Math.min(height, Math.round(height * sy)));
  const ox = Math.max(0, Math.min(width - w, Math.floor((width - w) / 2) + Math.round(width * dx)));
  const oy = Math.max(0, Math.min(height - h, Math.floor((height - h) / 2) + Math.round(height * dy)));
  return { w, h, ox, oy };
}

export function makeShrinkPage(nativeImage) {
  return (png, scale) => {
    const im = nativeImage.createFromBuffer(png);
    if (im.isEmpty()) return png;
    const { width, height } = im.getSize();
    const box = shrinkBox(width, height, scale);
    const small = im.resize({ width: box.w, height: box.h, quality: 'best' });
    const { width: w, height: h } = small.getSize();
    const px = small.toBitmap();
    const stride = Math.floor(px.length / h);
    if (w > width || h > height || stride < w * 4) return png;
    const out = Buffer.alloc(width * height * 4, 255);           // white, opaque
    const ox = Math.min(box.ox, width - w), oy = Math.min(box.oy, height - h);
    for (let y = 0; y < h; y++) px.copy(out, ((oy + y) * width + ox) * 4, y * stride, y * stride + w * 4);
    return nativeImage.createFromBitmap(out, { width, height }).toPNG();
  };
}
