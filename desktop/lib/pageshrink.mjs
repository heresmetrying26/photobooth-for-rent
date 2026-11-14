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

export function makeShrinkPage(nativeImage) {
  return (png, scale) => {
    const im = nativeImage.createFromBuffer(png);
    if (im.isEmpty()) return png;
    const { width, height } = im.getSize();
    const small = im.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' });
    const { width: w, height: h } = small.getSize();
    const px = small.toBitmap();
    const stride = Math.floor(px.length / h);
    if (w > width || h > height || stride < w * 4) return png;
    const out = Buffer.alloc(width * height * 4, 255);           // white, opaque
    const ox = Math.floor((width - w) / 2), oy = Math.floor((height - h) / 2);
    for (let y = 0; y < h; y++) px.copy(out, ((oy + y) * width + ox) * 4, y * stride, y * stride + w * 4);
    return nativeImage.createFromBitmap(out, { width, height }).toPNG();
  };
}
