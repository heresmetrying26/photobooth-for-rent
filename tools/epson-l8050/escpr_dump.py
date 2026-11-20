"""Reads a print job written by the Epson L8050 Windows driver (ESC/P-R: setq / setj / bsnd) and prints its page geometry.

    python escpr_dump.py job.prn [more.prn ...]

For each job: the sheet, the print area and how far the area reaches past each edge of the sheet (setj, 720 dpi), and the
rows that carry ink (blank bands are not sent, so a test page with thin lines shows where each line landed in the area).
Only the geometry is decoded: the band data itself is compressed and is not.
"""
import struct
import sys


def commands(d):
    i = d.find(b'\x1b(R\x06\x00\x00ESCPR')
    if i < 0:
        return
    i += 11
    n = len(d)
    while i + 10 <= n and d[i] == 0x1B:
        c = d[i + 1]
        ln = struct.unpack('<I', d[i + 2:i + 6])[0]
        if c == 0 and ln == 0:
            i += 4
            continue
        yield d[i + 6:i + 10].decode('latin1'), d[i + 10:i + 10 + ln]
        i += 10 + ln


def show(path):
    d = open(path, 'rb').read()
    print('=====', path)
    bands = []
    for name, data in commands(d):
        if name == 'setq' and len(data) == 9:
            print('  setq  media 0x%02x  quality %d' % (data[0], data[1]))
        elif name == 'setj' and len(data) >= 20:
            pw, ph, mt, ml, aw, ah = struct.unpack('>IIhhII', data[:20])
            mm = lambda p: p / 720 * 25.4
            print('  setj  sheet %dx%d (%.2fx%.2f mm)  area %dx%d (%.3fx%.3f in)  origin top %d left %d' % (pw, ph, mm(pw), mm(ph), aw, ah, aw / 720, ah / 720, mt, ml))
            print('        past the sheet (mm): left %.2f  right %.2f  top %.2f  bottom %.2f' % (mm(-ml), mm(aw + ml - pw), mm(-mt), mm(ah + mt - ph)))
        elif name == 'bsnd':
            bands.append((struct.unpack('>H', data[5:7])[0], data[0], len(data)))
    if bands:
        print('  bands with ink: %d, rows %d .. %d' % (len(bands), bands[0][0], bands[-1][0] + bands[-1][1]))
        print('  (y, size) %s' % [(y, s) for y, _, s in bands[:40]])
    else:
        print('  no bands: a blank page')


if __name__ == '__main__':
    for p in sys.argv[1:]:
        show(p)
