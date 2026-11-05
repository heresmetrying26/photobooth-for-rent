"""Reader for the ESC/P-Raster jobs the Epson L3210 Windows driver writes (see notes in the repo)."""
import struct


def packbits_decode(d, i, need):
    out = bytearray()
    while len(out) < need:
        n = d[i]; i += 1
        if n < 128:
            out += d[i:i + n + 1]; i += n + 1
        elif n > 128:
            out += bytes([d[i]]) * (257 - n); i += 1
    return bytes(out), i


class Job:
    def __init__(self, path_or_bytes):
        self.d = open(path_or_bytes, 'rb').read() if isinstance(path_or_bytes, str) else path_or_bytes
        self.remote = []          # list of remote command lists
        self.setup = []           # (cmd, bytes) page setup commands in order, before the first raster
        self.ops = []             # ('v', n) | ('x', n) | ('band', color, bpp, wbytes, rows, data) in order
        self._parse()

    def _parse(self):
        d = self.d; i = 0; n = len(d); in_raster = False
        while i < n:
            b = d[i]
            if b == 0 and d[i:i + 3] == b'\x00\x00\x00' and i + 3 < n and d[i + 3] == 0x1b: i += 3; continue
            if b == 0x0d: self.ops.append(('cr',)); i += 1; continue
            if b == 0x0c: self.ops.append(('ff',)); i += 1; continue
            if b == 0x0a: self.ops.append(('lf',)); i += 1; continue
            assert b == 0x1b, (i, d[i:i + 16].hex(' '))
            c = d[i + 1]
            if c == 0x01:
                j = d.index(b'\n', i); j = d.index(b'\n', j + 1); i = j + 1
            elif c == 0x40: i += 2
            elif c == 0x28:
                x = chr(d[i + 2]); ln = struct.unpack('<H', d[i + 3:i + 5])[0]
                if x == 'R':
                    j = i + 5 + ln; cmds = []
                    while d[j:j + 4] != b'\x1b\x00\x00\x00':
                        nm = d[j:j + 2].decode('latin1'); l2 = struct.unpack('<H', d[j + 2:j + 4])[0]
                        cmds.append((nm, d[j + 4:j + 4 + l2])); j += 4 + l2
                    self.remote.append(cmds); i = j + 4
                else:
                    body = d[i + 5:i + 5 + ln]; i += 5 + ln
                    if x == 'd': continue       # padding
                    if x == 'v': self.ops.append(('v', struct.unpack('<I', body)[0]))
                    elif x == '$': self.ops.append(('x', struct.unpack('<I', body)[0]))
                    else: self.setup.append((x, body))
            elif c == 0x55: self.setup.append(('U', d[i + 2:i + 3])); i += 3
            elif c == 0x69:
                col, comp, bpp = d[i + 2], d[i + 3], d[i + 4]
                wb, rows = struct.unpack('<HH', d[i + 5:i + 9]); i += 9
                data, i = packbits_decode(d, i, wb * rows) if comp == 1 else (d[i:i + wb * rows], i + wb * rows)
                self.ops.append(('band', col, bpp, wb, rows, data))
            else:
                raise ValueError('unknown ESC %02x at %d' % (c, i))

    def setup_dict(self):
        out = {}
        for k, v in self.setup: out.setdefault(k, []).append(v)
        return out
