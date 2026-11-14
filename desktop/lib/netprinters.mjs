// Finds printers on the same network as this computer, the way "Add a printer" does: every address of the
// local subnet is asked whether it takes print jobs (IPP on port 631, raw on 9100), and each printer that answers
// is asked its name over IPP. Pure Node (no PowerShell / CUPS), so it works the same on Windows and Mac.
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';

const SKIP_ADAPTER = /vmware|virtualbox|vbox|vethernet|hyper-v|docker|wsl|tailscale|zerotier|hamachi|vpn|tap-|tun\d|loopback|bluetooth/i;

const ipToLong = (ip) => ip.split('.').reduce((a, n) => (a * 256) + (parseInt(n, 10) & 255), 0);
const longToIp = (v) => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].join('.');
const prefixOf = (mask) => mask.split('.').reduce((n, o) => n + (parseInt(o, 10) & 255).toString(2).replace(/0/g, '').length, 0);

/** The IPv4 networks this computer is on (virtual adapters, VPNs and link-local addresses left out). */
export function lanSubnets(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (SKIP_ADAPTER.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address) || !a.netmask) continue;
      out.push({ name, address: a.address, prefix: prefixOf(a.netmask) });
    }
  }
  return out;
}

/** Addresses to ask, nearest first: the computer's own /24, then the rest of a bigger subnet (up to a /22). */
export function sweepTargets(subnets) {
  const own = new Set(subnets.map((s) => ipToLong(s.address)));
  const targets = new Set();
  for (const s of subnets) {
    const base = Math.floor(ipToLong(s.address) / 256) * 256;
    for (let h = 1; h <= 254; h++) targets.add(base + h);
  }
  for (const s of subnets) {
    if (s.prefix >= 24 || s.prefix <= 0) continue;
    const p = Math.max(s.prefix, 22), size = 2 ** (32 - p);
    const start = Math.floor(ipToLong(s.address) / size) * size;
    for (let h = 1; h < size - 1; h++) targets.add(start + h);
  }
  for (const v of own) targets.delete(v);
  return [...targets].map(longToIp);
}

export function portOpen(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => end(true));
    s.once('timeout', () => end(false));
    s.once('error', () => end(false));
    s.connect(port, ip);
  });
}

// ---- IPP (RFC 8011): just enough to ask a printer who it is ----
function ippAttr(tag, name, value) {
  const n = Buffer.from(name, 'utf8'), v = Buffer.from(value, 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  let p = 0;
  b[p++] = tag; b.writeUInt16BE(n.length, p); p += 2; n.copy(b, p); p += n.length;
  b.writeUInt16BE(v.length, p); p += 2; v.copy(b, p);
  return b;
}

export function ippGetAttributes(uri) {
  const head = Buffer.from([0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, 0x01]);   // IPP 2.0, Get-Printer-Attributes, request 1, operation group
  const wanted = ['printer-make-and-model', 'printer-name', 'printer-info', 'printer-uri-supported'];
  return Buffer.concat([
    head,
    ippAttr(0x47, 'attributes-charset', 'utf-8'),
    ippAttr(0x48, 'attributes-natural-language', 'en'),
    ippAttr(0x45, 'printer-uri', uri),
    ...wanted.map((w, i) => ippAttr(0x44, i === 0 ? 'requested-attributes' : '', w)),
    Buffer.from([0x03])
  ]);
}

/** Walks an IPP reply and returns { status, attrs: { name: [values as text] } }. */
export function parseIpp(buf) {
  const attrs = {};
  if (!buf || buf.length < 8) return { status: -1, attrs };
  const status = buf.readUInt16BE(2);
  let p = 8, last = '';
  while (p < buf.length) {
    const tag = buf[p++];
    if (tag === 0x03) break;
    if (tag <= 0x05) continue;
    if (p + 2 > buf.length) break;
    const nl = buf.readUInt16BE(p); p += 2;
    if (p + nl + 2 > buf.length) break;
    if (nl > 0) { last = buf.toString('latin1', p, p + nl); p += nl; }
    const vl = buf.readUInt16BE(p); p += 2;
    if (p + vl > buf.length) break;
    if (tag >= 0x40) (attrs[last] = attrs[last] || []).push(buf.toString('utf8', p, p + vl));
    p += vl;
  }
  return { status, attrs };
}

function ippPost(ip, port, path, body, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ host: ip, port, path, method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/ipp', 'content-length': body.length } }, (res) => {
      const parts = [];
      res.on('data', (d) => { parts.push(d); });
      res.on('end', () => resolve({ http: res.statusCode, body: Buffer.concat(parts) }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** Asks one printer its name. Returns { name, model, path } or null when it does not speak IPP. */
export async function ippIdentify(ip, port = 631, timeoutMs = 3000) {
  for (const path of ['/ipp/print', '/ipp', '/']) {
    const r = await ippPost(ip, port, path, ippGetAttributes(`ipp://${ip}:${port}${path}`), timeoutMs);
    if (!r || r.http !== 200) continue;
    const { status, attrs } = parseIpp(r.body);
    if (status < 0 || status > 2) continue;
    const model = (attrs['printer-make-and-model'] || [])[0] || '';
    const name = model || (attrs['printer-info'] || [])[0] || (attrs['printer-name'] || [])[0] || '';
    return { name, model, path };
  }
  return null;
}

/**
 * Looks for printers on the local network. Resolves with [{ ip, name, ipp, raw, port, path }], named printers first.
 * `progress` (optional) is called with { checked, total, found } as the sweep goes.
 */
export async function discoverNetworkPrinters({ timeoutMs = 900, concurrency = 96, progress, subnets, extra = [] } = {}) {
  const nets = subnets || lanSubnets();
  const targets = [...new Set([...extra, ...sweepTargets(nets)])];
  const found = new Map();
  let next = 0, checked = 0;
  const report = () => { if (progress) try { progress({ checked, total: targets.length, found: found.size }); } catch { /* ignore */ } };
  async function worker() {
    while (next < targets.length) {
      const ip = targets[next++];
      const [ipp, raw] = await Promise.all([portOpen(ip, 631, timeoutMs), portOpen(ip, 9100, timeoutMs)]);
      checked++;
      if (ipp || raw) found.set(ip, { ip, ipp, raw, port: ipp ? 631 : 9100, path: '', name: '' });
      report();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  await Promise.all([...found.values()].filter((f) => f.ipp).map(async (f) => {
    const id = await ippIdentify(f.ip, 631);
    if (id) { f.name = id.name; f.path = id.path; }
  }));
  return {
    subnets: nets.map((s) => `${s.address}/${s.prefix}`),
    checked: targets.length,
    printers: [...found.values()].sort((a, b) => (!!b.name - !!a.name) || ipToLong(a.ip) - ipToLong(b.ip))
  };
}

// ---- Direct IPP printing: one photo sent straight to a printer, no Windows / Mac driver ----
// Used for the Canon SELPHY (CP1300 and the other Wi-Fi models), which accepts a JPEG over IPP / AirPrint.
// Same idea as the Android app (NetPrintBridge.kt): name the paper the printer itself lists, ask it not to leave a border.
const ippU16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const ippU32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const ippStr = (s) => { const v = Buffer.from(s, 'utf8'); return Buffer.concat([ippU16(v.length), v]); };
const ippTagged = (tag, name, value) => Buffer.concat([Buffer.from([tag]), ippStr(name), ippStr(value)]);

/** Get-Printer-Attributes for the settings a direct print needs: file types, paper loaded / supported, model. */
export function ippCapsRequest(uri) {
  const wanted = ['printer-make-and-model', 'document-format-supported', 'media-ready', 'media-supported', 'media-default'];
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, 0x01]),
    ippTagged(0x47, 'attributes-charset', 'utf-8'),
    ippTagged(0x48, 'attributes-natural-language', 'en'),
    ippTagged(0x45, 'printer-uri', uri),
    ...wanted.map((w, i) => ippTagged(0x44, i === 0 ? 'requested-attributes' : '', w)),
    Buffer.from([0x03])
  ]);
}

/**
 * Print-Job (RFC 8011 operation 0x0002). `mediaName` names a paper the printer lists ("jpn_hagaki_100x148mm");
 * otherwise `wMm` x `hMm` is asked for as a custom size with zero margins (the standard way to ask for no border).
 * `scaling` is a print-scaling value ("fill", "none") or '' to leave it out.
 */
export function ippPrintJobRequest({ uri, jobName = 'photobooth4u', format = 'image/jpeg', doc, wMm = 0, hMm = 0, mediaName = '', scaling = 'fill' }) {
  const memberName = (n) => Buffer.concat([Buffer.from([0x4a]), ippU16(0), ippStr(n)]);
  const memberInt = (n, v) => Buffer.concat([memberName(n), Buffer.from([0x21]), ippU16(0), ippU16(4), ippU32(v)]);
  const begCol = Buffer.from([0x34, 0, 0, 0, 0]), endCol = Buffer.from([0x37, 0, 0, 0, 0]);
  const parts = [
    Buffer.from([0x02, 0x00, 0x00, 0x02, 0, 0, 0, 1, 0x01]),
    ippTagged(0x47, 'attributes-charset', 'utf-8'),
    ippTagged(0x48, 'attributes-natural-language', 'en'),
    ippTagged(0x45, 'printer-uri', uri),
    ippTagged(0x42, 'requesting-user-name', 'photobooth'),
    ippTagged(0x42, 'job-name', jobName),
    ippTagged(0x49, 'document-format', format),
    Buffer.from([0x02])
  ];
  if (mediaName) parts.push(ippTagged(0x44, 'media', mediaName));
  else if (wMm > 0 && hMm > 0) {
    parts.push(Buffer.concat([Buffer.from([0x34]), ippStr('media-col'), ippU16(0)]),
      memberName('media-size'), begCol,
      memberInt('x-dimension', Math.round(Math.min(wMm, hMm) * 100)), memberInt('y-dimension', Math.round(Math.max(wMm, hMm) * 100)),
      endCol,
      memberInt('media-top-margin', 0), memberInt('media-bottom-margin', 0), memberInt('media-left-margin', 0), memberInt('media-right-margin', 0),
      endCol);
  }
  if (scaling) parts.push(ippTagged(0x44, 'print-scaling', scaling));
  parts.push(Buffer.from([0x03]), Buffer.from(doc || []));
  return Buffer.concat(parts);
}

/** The paper (from the printer's own list; loaded paper first) closest to wMm x hMm, within 6 mm, or ''. */
export function pickMediaName(caps, wMm, hMm) {
  if (!(wMm > 0 && hMm > 0) || !caps) return '';
  const want = [Math.min(wMm, hMm), Math.max(wMm, hMm)];
  const re = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)$/;
  const pick = (names) => {
    let best = '', bestDiff = 6;
    for (const n of names || []) {
      const m = re.exec(n); if (!m) continue;
      const k = m[3] === 'in' ? 25.4 : 1, a = Number(m[1]) * k, b = Number(m[2]) * k;
      const d = Math.max(Math.abs(Math.min(a, b) - want[0]), Math.abs(Math.max(a, b) - want[1]));
      if (d <= bestDiff) { bestDiff = d; best = n; }
    }
    return best;
  };
  return pick(caps.mediaReady) || pick(caps.mediaSupported);
}

/** Asks a printer what it can take. Returns { path, model, formats, mediaReady, mediaSupported } or null. */
export async function ippCaps(ip, port = 631, path = '', timeoutMs = 4000) {
  for (const p of [...new Set([path, '/ipp/print', '/ipp', '/'].filter(Boolean))]) {
    const r = await ippPost(ip, port, p, ippCapsRequest(`ipp://${ip}:${port}${p}`), timeoutMs);
    if (!r || r.http !== 200) continue;
    const { status, attrs } = parseIpp(r.body);
    if (status < 0 || status > 2) continue;
    return {
      path: p, model: (attrs['printer-make-and-model'] || [])[0] || '',
      formats: (attrs['document-format-supported'] || []).map((s) => s.toLowerCase()),
      mediaReady: attrs['media-ready'] || [], mediaSupported: attrs['media-supported'] || []
    };
  }
  return null;
}

/**
 * Sends one JPEG to the printer. Tries the paper the printer names itself first, then a custom size with no margins, then
 * nothing at all, and stops at the first one the printer accepts. Throws an Error with a reason a person can act on.
 */
export async function ippPrintDirect({ ip, port = 631, path = '', jpeg, widthMm = 0, heightMm = 0, jobName = 'photobooth4u', timeoutMs = 90000 }) {
  const caps = await ippCaps(ip, port, path);
  if (!caps) throw new Error('The printer at ' + ip + ' did not answer. Is it on and on the same Wi-Fi as this computer? If it joined the Wi-Fi again it may have a new address: choose Find printers and use it again.');
  const accepted = caps.formats.length === 0 || caps.formats.includes('image/jpeg');
  if (!accepted) throw new Error((caps.model || 'This printer') + ' can’t take photos straight from the app (it accepts: ' + caps.formats.filter((f) => /^(image|application)\//.test(f)).slice(0, 5).join(', ') + ').');
  const named = pickMediaName(caps, widthMm, heightMm);
  const attempts = [
    ...(named ? [{ mediaName: named, scaling: 'fill' }, { mediaName: named, scaling: '' }] : []),
    ...(widthMm > 0 && heightMm > 0 ? [{ wMm: widthMm, hMm: heightMm, scaling: 'fill' }] : []),
    { scaling: '' }
  ];
  let lastErr = 'The printer didn’t accept the photo.', drops = 0;
  for (const a of attempts) {
    for (const p of [...new Set([caps.path, '/ipp/print', '/ipp', '/'])]) {
      const body = ippPrintJobRequest({ uri: `ipp://${ip}:${port}${p}`, jobName, doc: jpeg, ...a });
      const r = await ippPost(ip, port, p, body, timeoutMs);
      if (!r) { if (++drops >= 3) throw new Error('Lost the printer while sending the photo. Check it is on and still on the same Wi-Fi, then print again.'); lastErr = 'The printer dropped the connection.'; continue; }
      if (r.http === 200) {
        const { status } = parseIpp(r.body);
        if (status >= 0 && status <= 2) return { media: a.mediaName || (a.wMm ? 'custom' : 'default'), scaling: a.scaling };
        lastErr = 'The printer refused the photo (code 0x' + status.toString(16) + ').';
      } else if (r.http === 426 || r.http === 301 || r.http === 302) lastErr = 'This printer only accepts secure printing, which the app doesn’t support yet.';
      else if (r.http !== 404) lastErr = 'The printer answered with HTTP ' + r.http + '.';
    }
  }
  throw new Error(lastErr);
}
