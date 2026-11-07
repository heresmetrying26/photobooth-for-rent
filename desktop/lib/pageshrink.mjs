// A print page made a little smaller, in the middle of a white page of the same size (see the borderless
// note in helper.mjs). Takes Electron's nativeImage, so this file imports nothing and tests can pass it in.
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
