"""Generate an Epson L3210 print job (ESC/P-Raster, the format the Windows driver writes) from a picture.

Modes: 'standard' (Normal, 720x720 dpi) and 'high' (Best, 1440x720 dpi), 4x6 in photo paper, bordered.
Header / page set-up / trailer bytes are copied from a job the real Windows driver wrote for the same settings.
"""
import sys, struct, random, io, os, gzip
from PIL import Image, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))

PITCH_ROWS = {'standard': 4, 'high': 4, 'bl_standard': 4, 'bl_high': 4}
MODE = {
    #            v_dpi h_dpi xstep(grid cols per 360dpi data px)  top row  advance pattern     first feed   printed area (inches)
    'standard':    dict(v=720, h=720,  xstep=2, top=320, adv=(26, 25), y0=112, aw=3.767, ah=5.767),
    'high':        dict(v=720, h=1440, xstep=4, top=320, adv=(14, 13), y0=100, aw=3.767, ah=5.767),
    # borderless: the image runs 0.1 in past the paper on each side and 0.118 in past the top and bottom (4.2 x 6.236 in)
    'bl_standard': dict(v=720, h=720,  xstep=2, top=166, adv=(17, 14), y0=4, aw=4.2, ah=6.236),
    'bl_high':     dict(v=720, h=1440, xstep=4, top=166, adv=(9, 6),   y0=4, aw=4.2, ah=6.236),
}
N = 59                      # nozzles per colour used
DY = {0: 0, 2: 0, 1: -60, 4: -120}          # nozzle-array offsets in nozzles (relative to cyan/black)


def packbits(row):
    out = bytearray(); i = 0; n = len(row)
    while i < n:
        j = i
        while j + 1 < n and row[j + 1] == row[i] and j - i < 127: j += 1
        run = j - i + 1
        if run >= 2:
            out.append(257 - run); out.append(row[i]); i = j + 1
        else:
            k = i
            while k < n and k - i < 128 and not (k + 1 < n and row[k] == row[k + 1]): k += 1
            if k == i: k = i + 1
            out.append(k - i - 1); out += row[i:k]; i = k
    return bytes(out)


def pack2(vals):
    return bytes((a << 6) | (b << 4) | (c << 2) | d for a, b, c, d in zip(vals[0::4], vals[1::4], vals[2::4], vals[3::4]))


# ---- tone curves measured from the Windows driver (Normal mode, mean dot value per 720x720 cell vs ink amount 0..1) ----
def curve(points):
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    def f(a):
        if a <= xs[0]: return ys[0]
        for i in range(1, len(xs)):
            if a <= xs[i]:
                t = (a - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + t * (ys[i] - ys[i - 1])
        return ys[-1]
    return f


CURVE_C = curve([(0, 0), (.10, .106), (.255, .284), (.49, .595), (.725, .848), (.96, .884), (1, .90)])
CURVE_M = curve([(0, 0), (.15, .0), (.27, .104), (.38, .319), (.494, .668), (.608, 1.095), (.68, 1.371), (1, 2.2)])
CURVE_Y = curve([(0, 0), (.04, .017), (.275, .212), (.51, .51), (.745, .924), (.9, 1.27), (1, 1.45)])
K_FULL = 0.88                      # mean value of black ink for pure black
UCR_M = 0.40; UCR_Y = 0.20          # how much magenta / yellow is removed under black (rich black as the driver does it)


def plane_luts(scale):
    """LUTs (256 entries) from ink amount (0..255) to dot level x85 (0..255) for the given density scale."""
    def mk(cv, ucr=0.0):
        return [min(255, int(round(cv(a / 255.0) * scale * 85))) for a in range(256)]
    return mk


def threshold_tile():
    """256 x 256 white-noise threshold tile from a fixed linear congruential generator (the same one is used in booth.html)."""
    s = 12345; tile = bytearray(256 * 256)
    for i in range(256 * 256):
        s = (s * 1103515245 + 12345) & 0x7fffffff
        tile[i] = (s >> 16) & 255
    return bytes(tile)


def ordered_threshold(w, h):
    t = Image.frombytes('L', (256, 256), threshold_tile())
    big = Image.new('L', (w, h))
    for y in range(0, h, 256):
        for x in range(0, w, 256): big.paste(t, (x, y))
    return big


def dots_from_density(dens85, thr):
    """dens85: 'L' image where 85 = one dot-size unit. Returns 'L' image of dot values 0..3."""
    lvl = dens85.point([v // 85 for v in range(256)])
    frac = dens85.point([min(255, (v % 85) * 3) for v in range(256)])
    up = ImageChops.subtract(frac, thr).point([0] + [1] * 255)
    return ImageChops.add(lvl, up)


def make_planes(img, mode):
    m = MODE[mode]
    cols = int(round(m['aw'] * m['h'])); rows = int(round(m['ah'] * m['v']))
    img = img.convert('RGB')
    if img.size != (cols, rows):          # (a picture already at the dot-grid size is used as it is)
        # cover-fit to the printable area by its real proportions in inches (the dot grid is not square: 1440 x 720 per inch in Best)
        sw, sh = img.size; want = m['aw'] / m['ah']
        if sw / sh > want:
            nw = int(round(sh * want)); l = (sw - nw) // 2; img = img.crop((l, 0, l + nw, sh))
        else:
            nh = int(round(sw / want)); t = (sh - nh) // 2; img = img.crop((0, t, sw, t + nh))
        img = img.resize((cols, rows), Image.LANCZOS)
    r, g, b = img.split()
    ac, am, ay = ImageChops.invert(r), ImageChops.invert(g), ImageChops.invert(b)
    kmin = ImageChops.darker(ImageChops.darker(ac, am), ay)
    kk = kmin.point([int(255 * max(0.0, (v / 255.0 - 0.5) / 0.5) ** 1.5) for v in range(256)])   # 0..255 "how black"
    scale = (720.0 / m['h']) * (720.0 / m['v'])
    mk = plane_luts(scale)
    thr = ordered_threshold(cols, rows)
    # under-colour removal: reduce M and Y (not C) where it is black
    def ucr(a, u): return ImageChops.subtract(a, kk.point([int(v * u) for v in range(256)]))
    dens = {
        2: ac.point(mk(CURVE_C)),
        1: ucr(am, UCR_M).point(mk(CURVE_M)),
        4: ucr(ay, UCR_Y).point(mk(CURVE_Y)),
        0: kk.point([min(255, int(round(v / 255.0 * K_FULL * scale * 85))) for v in range(256)]),
    }
    return {c: dots_from_density(d, thr) for c, d in dens.items()}, cols, rows


def template(mode, ref_path=None):
    """Header + page set-up and trailer of a job the Windows driver wrote for this mode (templates/*.gz), or of a given .prn."""
    if ref_path:
        d = open(ref_path, 'rb').read()
        return d[:d.index(b'\x1b(v')], d[d.rindex(b'\x0c\x1b@\x1b(R'):]
    rd = lambda n: gzip.open(os.path.join(HERE, 'templates', '%s.%s.gz' % (mode, n))).read()
    return rd('head'), rd('tail')


def export_tables(mode):
    """Everything the JavaScript generator in booth.html needs for one mode (tone tables, header / trailer as zero-run segments)."""
    m = MODE[mode]; scale = (720.0 / m['h']) * (720.0 / m['v']); mk = plane_luts(scale)
    head, tail = template(mode)
    def segs(b):
        out = []; i = 0
        while i < len(b):
            if b[i] == 0:
                j = i
                while j < len(b) and b[j] == 0: j += 1
                if j - i >= 64: out.append(j - i); i = j; continue          # a number = that many zero bytes
            j = i
            while j < len(b) and not (b[j] == 0 and b[j:j + 64] == bytes(64)): j += 1
            out.append(list(b[i:j])); i = j
        return out
    return dict(
        v=m['v'], h=m['h'], xstep=m['xstep'], top=m['top'], adv=list(m['adv']), y0=m['y0'], aw=m['aw'], ah=m['ah'],
        KK=[int(255 * max(0.0, (v / 255.0 - 0.5) / 0.5) ** 1.5) for v in range(256)],
        UM=[int(v * UCR_M) for v in range(256)], UY=[int(v * UCR_Y) for v in range(256)],
        LC=mk(CURVE_C), LM=mk(CURVE_M), LY=mk(CURVE_Y),
        LK=[min(255, int(round(v / 255.0 * K_FULL * scale * 85))) for v in range(256)],
        head=segs(head), tail=list(tail))


def build_job(img, mode, ref_path=None):
    m = MODE[mode]; pitch = PITCH_ROWS[mode]; xstep = m['xstep']
    planes, cols, rows = make_planes(img, mode)
    raw = {c: p.tobytes() for c, p in planes.items()}
    header, trailer = template(mode, ref_path)
    out = bytearray(header)
    Y = 0
    y_first = m['y0']; out += b'\x1b(v\x04\x00' + struct.pack('<I', y_first); Y = y_first
    y_end = m['top'] + rows + 480 + 240
    printed = {c: [0] * rows for c in planes}          # bitmask of x offsets already printed per row
    class_count = {}                                      # per residue class: how many passes so far (-> x offset cycle)
    p = 0
    stats = {'passes': 0, 'bands': 0}
    last_end = len(out)
    while Y <= y_end:
        cls = Y % pitch
        xo = class_count.get(cls, 0) % xstep; class_count[cls] = class_count.get(cls, 0) + 1
        any_band = False
        for c in (2, 1, 4, 0):
            band_rows = []
            nonzero = False
            for n in range(N):
                yrow = Y + pitch * (n + DY[c]) - m['top']            # target row in the plane
                if 0 <= yrow < rows and not (printed[c][yrow] >> xo) & 1:
                    printed[c][yrow] |= 1 << xo
                    vals = raw[c][yrow * cols + xo:(yrow + 1) * cols:xstep][:cols // xstep]
                    vals = vals + bytes((-len(vals)) % 4)
                    if any(vals): nonzero = True
                    band_rows.append(vals)
                else:
                    band_rows.append(None)
            if not nonzero: continue
            wb = (cols // xstep + 3) // 4
            blob = bytearray()
            for vr in band_rows:
                blob += packbits(pack2(vr) if vr is not None else bytes(wb))
            if xo: out += b'\x1b($\x04\x00' + struct.pack('<I', xo)
            out += b'\x1bi' + bytes([c, 1, 2]) + struct.pack('<HH', wb, N) + blob + b'\r'
            stats['bands'] += 1; any_band = True; last_end = len(out)
        stats['passes'] += 1
        adv = m['adv'][p % len(m['adv'])]; p += 1
        if Y + adv > y_end: break
        Y += adv
        out += b'\x1b(v\x04\x00' + struct.pack('<I', adv)
    del out[last_end:]                                     # no feed after the last pass that prints anything (as the driver does)
    out += trailer
    unfinished = sum(1 for c in printed for r_ in printed[c] if r_ != (1 << xstep) - 1)
    stats['rows_incomplete'] = unfinished; stats['Y_last'] = Y
    return bytes(out), stats


if __name__ == '__main__':
    if len(sys.argv) < 4:
        sys.exit('usage: python gen.py <standard|high> <picture> <out.prn> [reference.prn]')
    mode, src, dst = sys.argv[1:4]
    ref = sys.argv[4] if len(sys.argv) > 4 else None
    data, st = build_job(Image.open(src), mode, ref)
    open(dst, 'wb').write(data)
    print(mode, 'bytes', len(data), st)
