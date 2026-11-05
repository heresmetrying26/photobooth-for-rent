"""General reconstruction of an L3210 Windows-driver job into per-ink dot planes (any quality mode)."""
import sys
from PIL import Image
from epsonjob import Job

# byte -> 4 two-bit values (MSB first)
EXPAND = [bytes([(b >> 6) & 3, (b >> 4) & 3, (b >> 2) & 3, b & 3]) for b in range(256)]


def modes(job):
    u = job.setup_dict()['U'][0]
    page, vcode, hcode = u[0], u[1], u[2]
    return dict(v_dpi=1440 // vcode, h_dpi=1440 // hcode, vcode=vcode, hcode=hcode,
                page_len=int.from_bytes(job.setup_dict()['C'][0][:4], 'little'),
                page_w=int.from_bytes(job.setup_dict()['S'][0][:4], 'little') * (1440 // hcode) // 1440,
                )


def recon(path, dy_nozzle=None, max_rows=None):
    """Returns planes{color: (width, height, bytearray rows)} on a grid of (h_dpi x v_dpi)."""
    job = Job(path); m = modes(job)
    pitch = m['v_dpi'] // 180                # rows between nozzles (nozzle pitch is 1/180 in)
    xstep = m['h_dpi'] // 360                # grid columns per data pixel (data pixels are 360 dpi)
    H = m['page_len'] + 2000 if max_rows is None else max_rows
    W = int(4.0 * m['h_dpi']) + 64
    dy_nozzle = dy_nozzle or {0: 0, 2: 0, 1: -60, 4: -120}
    planes = {c: [bytearray(W) for _ in range(H)] for c in (0, 1, 2, 4)}
    Y = 0; X = 0; used = 0
    for op in job.ops:
        if op[0] == 'v': Y += op[1]
        elif op[0] == 'x': X = op[1]
        elif op[0] == 'cr': X = 0
        elif op[0] == 'band':
            _, col, bpp, wb, rows, data = op
            for n in range(rows):
                y = Y + pitch * (n + dy_nozzle[col])
                if not (0 <= y < H): continue
                row = data[n * wb:(n + 1) * wb]
                vals = b''.join(EXPAND[b] for b in row)
                tgt = planes[col][y]
                x0 = X * (m['h_dpi'] // (1440 // m['hcode'])) if False else X   # X is in 1/(1440/hcode) in units = grid columns
                end = x0 + xstep * len(vals)
                if end > W: vals = vals[: (W - x0 + xstep - 1) // xstep]; end = W
                seg = tgt[x0:end:xstep]
                tgt[x0:end:xstep] = bytes(max(a, b) for a, b in zip(seg, vals))   # a dot may be overprinted
    return m, planes, (W, H)


def compose(m, planes, size, out_w=600):
    W, H = size
    # downscale each plane by box averaging into an RGB preview
    step_x = max(1, W // out_w); step_y = step_x * m['v_dpi'] // m['h_dpi'] if m['h_dpi'] else step_x
    step_y = max(1, step_y)
    ow, oh = W // step_x, H // step_y
    img = Image.new('RGB', (ow, oh), (255, 255, 255)); px = img.load()
    for oy in range(oh):
        acc = {c: [0] * ow for c in planes}
        for dy in range(step_y):
            y = oy * step_y + dy
            for c in planes:
                row = planes[c][y]
                a = acc[c]
                for ox in range(ow):
                    a[ox] += sum(row[ox * step_x:(ox + 1) * step_x])
        norm = 3.0 * step_x * step_y
        for ox in range(ow):
            c = acc[2][ox] / norm; mm = acc[1][ox] / norm; ye = acc[4][ox] / norm; k = acc[0][ox] / norm
            px[ox, oy] = (int(255 * (1 - c) * (1 - k)), int(255 * (1 - mm) * (1 - k)), int(255 * (1 - ye) * (1 - k)))
    return img


if __name__ == '__main__':
    path, out = sys.argv[1], sys.argv[2]
    dym = int(sys.argv[3]) if len(sys.argv) > 3 else -60
    dyy = int(sys.argv[4]) if len(sys.argv) > 4 else -120
    m, planes, size = recon(path, {0: 0, 2: 0, 1: dym, 4: dyy})
    print(m, size)
    img = compose(m, planes, size)
    img.save(out); print('saved', img.size)
