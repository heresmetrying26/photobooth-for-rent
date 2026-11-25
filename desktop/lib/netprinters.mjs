// Finds printers on the same network as this computer, the way "Add a printer" does: every address of the
// local subnet is asked whether it takes print jobs (IPP on port 631, raw on 9100), and each printer that answers
// is asked its name over IPP. Pure Node (no PowerShell / CUPS), so it works the same on Windows and Mac.
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { pickPwgDpi } from './pwgraster.mjs';

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

/** Walks an IPP reply and returns every value as { group, name, tag, value: Buffer }, in order. */
export function parseIppGrouped(buf) {
  const out = [];
  if (!buf || buf.length < 8) return out;
  let p = 8, grp = 0, last = '';
  while (p < buf.length) {
    const tag = buf[p++];
    if (tag === 0x03) break;
    if (tag <= 0x05) { grp = tag; last = ''; continue; }
    if (p + 2 > buf.length) break;
    const nl = buf.readUInt16BE(p); p += 2;
    if (p + nl + 2 > buf.length) break;
    if (nl > 0) { last = buf.toString('latin1', p, p + nl); p += nl; }
    const vl = buf.readUInt16BE(p); p += 2;
    if (p + vl > buf.length) break;
    out.push({ group: grp, name: last, tag, value: buf.subarray(p, p + vl) });
    p += vl;
  }
  return out;
}

/** Walks an IPP reply and returns every value as { name, tag, value: Buffer }, in order (a name carries over to the values after it). */
export function parseIppRaw(buf) {
  return parseIppGrouped(buf).map(({ name, tag, value }) => ({ name, tag, value }));
}

function parseIppJobId(buf) {
  for (const { name, tag, value } of parseIppGrouped(buf)) {
    if (name === 'job-id' && tag === 0x21 && value.length === 4) return value.readInt32BE(0);
  }
  return 0;
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
  const wanted = ['printer-make-and-model', 'document-format-supported', 'media-ready', 'media-supported', 'media-default',
    'print-quality-supported', 'print-color-mode-supported', 'media-type-supported',
    'pwg-raster-document-resolution-supported', 'pwg-raster-document-type-supported',
    'media-top-margin-supported', 'media-bottom-margin-supported', 'media-left-margin-supported', 'media-right-margin-supported'];
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
export function ippPrintJobRequest({ uri, jobName = 'photobooth4u', format = 'image/jpeg', doc, wMm = 0, hMm = 0, mediaName = '', scaling = 'fill', quality = 0, colorMode = '', mediaType = '', marginMm100 = 0, opCode = 0x0002, mediaTypeMode = 'col' }) {
  const memberName = (n) => Buffer.concat([Buffer.from([0x4a]), ippU16(0), ippStr(n)]);
  const memberInt = (n, v) => Buffer.concat([memberName(n), Buffer.from([0x21]), ippU16(0), ippU16(4), ippU32(v)]);
  const memberKeyword = (n, v) => Buffer.concat([memberName(n), Buffer.from([0x44]), ippU16(0), ippStr(v)]);
  const begCol = Buffer.from([0x34, 0, 0, 0, 0]), endCol = Buffer.from([0x37, 0, 0, 0, 0]);
  const mtMode = String(mediaTypeMode || 'col').toLowerCase();
  const parts = [
    Buffer.from([0x02, 0x00, (opCode >> 8) & 0xff, opCode & 0xff, 0, 0, 0, 1, 0x01]),
    ippTagged(0x47, 'attributes-charset', 'utf-8'),
    ippTagged(0x48, 'attributes-natural-language', 'en'),
    ippTagged(0x45, 'printer-uri', uri),
    ippTagged(0x42, 'requesting-user-name', 'photobooth'),
    ippTagged(0x42, 'job-name', jobName),
    ippTagged(0x49, 'document-format', format),
    Buffer.from([0x02])
  ];
  const m = Math.max(0, Math.round(Number(marginMm100) || 0));
  let sentMtInCol = false;
  if (mediaName) parts.push(ippTagged(0x44, 'media', mediaName));
  else if (wMm > 0 && hMm > 0) {
    const putMt = mediaType && (mtMode === 'col' || mtMode === 'both');
    if (putMt) sentMtInCol = true;
    parts.push(Buffer.concat([Buffer.from([0x34]), ippStr('media-col'), ippU16(0)]),
      memberName('media-size'), begCol,
      memberInt('x-dimension', Math.round(Math.min(wMm, hMm) * 100)), memberInt('y-dimension', Math.round(Math.max(wMm, hMm) * 100)),
      endCol,
      memberInt('media-top-margin', m), memberInt('media-bottom-margin', m), memberInt('media-left-margin', m), memberInt('media-right-margin', m),
      ...(putMt ? [memberKeyword('media-type', mediaType)] : []),   // inside media-col, where IPP Everywhere clients put it
      endCol);
  } else if (mediaType && mtMode === 'col') {
    sentMtInCol = true;
    parts.push(Buffer.concat([Buffer.from([0x34]), ippStr('media-col'), ippU16(0)]), memberKeyword('media-type', mediaType), endCol);
  }
  if (scaling) parts.push(ippTagged(0x44, 'print-scaling', scaling));
  if (quality) parts.push(Buffer.concat([Buffer.from([0x23]), ippStr('print-quality'), ippU16(4), ippU32(quality)]));   // enum
  if (colorMode) parts.push(ippTagged(0x44, 'print-color-mode', colorMode));
  if (mediaType && mtMode !== 'none' && (!sentMtInCol || mtMode === 'both')) parts.push(ippTagged(0x44, 'media-type', mediaType));
  parts.push(Buffer.from([0x03]));
  if (opCode !== 0x0004 && doc && doc.length) parts.push(Buffer.from(doc));
  return Buffer.concat(parts);
}

/**
 * The paper (from the printer's own list; loaded paper first) closest to wMm x hMm, within 6 mm, or ''.
 * A printer may list a separate borderless version of a paper ("jpn_hagaki_100x148mm_borderless"): those names are read too,
 * and the one that matches `borderless` wins when two have the same size.
 */
export function pickMediaName(caps, wMm, hMm, borderless = true) {
  if (!(wMm > 0 && hMm > 0) || !caps) return '';
  const want = [Math.min(wMm, hMm), Math.max(wMm, hMm)];
  const re = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)(?:[-_.]?(borderless|full-?bleed))?$/i;
  const pick = (names) => {
    let best = '', bestDiff = 6, bestMatches = false;
    for (const n of names || []) {
      const m = re.exec(n); if (!m) continue;
      const k = m[3] === 'in' ? 25.4 : 1, a = Number(m[1]) * k, b = Number(m[2]) * k;
      const d = Math.max(Math.abs(Math.min(a, b) - want[0]), Math.abs(Math.max(a, b) - want[1]));
      const matches = !!m[4] === !!borderless;
      if (!best ? d <= bestDiff : (d < bestDiff - 0.01 || (Math.abs(d - bestDiff) <= 0.01 && matches && !bestMatches))) { bestDiff = d; best = n; bestMatches = matches; }
    }
    return best;
  };
  const tag = /[-_.]?(borderless|full-?bleed)$/i;
  const ready = pick(caps.mediaReady);
  if (ready) {
    // The paper that is loaded wins; if the printer lists the same paper in the version that matches `borderless`, that version is used.
    if (tag.test(ready) !== !!borderless) {
      const alt = (caps.mediaSupported || []).find((n) => n.replace(tag, '') === ready.replace(tag, '') && tag.test(n) === !!borderless);
      if (alt) return alt;
    }
    return ready;
  }
  const fromSupported = pick(caps.mediaSupported);
  if (fromSupported) return fromSupported;
  if (/selphy|\bcp[\s_-]?(?:820|910|1000|1200|1300|1500)\b/i.test(caps.model || '')) {
    if (Math.abs(want[0] - 54) < 8 && Math.abs(want[1] - 86) < 8) return 'om_card_54x86mm';
    if (Math.abs(want[0] - 89) < 8 && Math.abs(want[1] - 119) < 8) return 'oe_photo-l_3.5x5in';
    if (Math.abs(want[0] - 100) < 8 && Math.abs(want[1] - 148) < 8) return 'jpn_hagaki_100x148mm';
  }
  return '';
}

/** The size in mm that a paper name carries ("jpn_hagaki_100x148mm" -> [100, 148], "na_index-4x6_4x6in" -> [101.6, 152.4]), or null. */
export function mediaSizeMm(name) {
  const m = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)(?:[-_.]?(?:borderless|full-?bleed))?$/i.exec(String(name || ''));
  if (!m) return null;
  const k = m[3].toLowerCase() === 'in' ? 25.4 : 1;
  return [Math.round(Number(m[1]) * k * 100) / 100, Math.round(Number(m[2]) * k * 100) / 100];
}

/** The JPEG with 300 dpi written into its header, so a printer that prints it at its own size (no scaling) still gets the sheet's size. */
export function jpegAt300Dpi(buf) {
  const j = Buffer.from(buf);
  if (j.length < 20 || j[0] !== 0xff || j[1] !== 0xd8 || j[2] !== 0xff || j[3] !== 0xe0 || j.toString('latin1', 6, 10) !== 'JFIF') return j;
  j[13] = 1;                    // dots per inch
  j.writeUInt16BE(300, 14); j.writeUInt16BE(300, 16);
  return j;
}

/**
 * Asks a printer what it can take. Returns { path, model, formats, mediaReady, mediaSupported, qualities, colorModes, mediaTypes,
 * pwgRes, pwgTypes } or null. qualities are IPP print-quality numbers (3 draft, 4 normal, 5 high); pwgRes are the dpi a raster
 * page may use; pwgTypes the raster colour types ("srgb_8", "sgray_8").
 * Pass `transport` ({ baseUri, post(path, body, timeoutMs) }) to talk over IPP-over-USB instead of TCP.
 */
export async function ippCaps(ip, port = 631, path = '', timeoutMs = 4000, transport = null) {
  const baseUri = transport ? transport.baseUri : `ipp://${ip}:${port}`;
  const send = transport ? transport.post : (p, body, ms) => ippPost(ip, port, p, body, ms);
  for (const p of [...new Set([path, '/ipp/print', '/ipp', '/', '/ipp/printer', '/printer'].filter(Boolean))]) {
    const r = await send(p, ippCapsRequest(`${baseUri}${p}`), timeoutMs);
    if (!r || r.http !== 200) continue;
    const { status, attrs } = parseIpp(r.body);
    if (status < 0 || status > 2) continue;
    const qualities = [], pwgRes = [];
    let zeroMargin = false;
    for (const v of parseIppRaw(r.body)) {
      if (v.name === 'print-quality-supported' && v.tag === 0x23 && v.value.length === 4) qualities.push(v.value.readUInt32BE(0));
      // A margin of 0 in the supported margins (1/100 mm) is how a printer says it can print edge to edge.
      if (v.tag === 0x21 && v.value.length === 4 && /^media-(?:top|bottom|left|right)-margin-supported$/.test(v.name) && v.value.readUInt32BE(0) === 0) zeroMargin = true;
      // a resolution is 4 bytes across, 4 bytes down, 1 byte units (3 = dots per inch)
      if (v.name === 'pwg-raster-document-resolution-supported' && v.tag === 0x32 && v.value.length === 9 && v.value[8] === 3) pwgRes.push(v.value.readUInt32BE(0));
    }
    return {
      path: p, model: (attrs['printer-make-and-model'] || [])[0] || '',
      formats: (attrs['document-format-supported'] || []).map((s) => s.toLowerCase()),
      mediaReady: attrs['media-ready'] || [], mediaSupported: attrs['media-supported'] || [],
      qualities, pwgRes,
      colorModes: attrs['print-color-mode-supported'] || [], mediaTypes: attrs['media-type-supported'] || [],
      pwgTypes: attrs['pwg-raster-document-type-supported'] || [],
      borderlessCap: zeroMargin || (attrs['media-supported'] || []).some((n) => /[-_.](?:borderless|full-?bleed)$/i.test(n))   // it says it can print edge to edge
    };
  }
  return null;
}

/** What a direct print can do with this printer: the photo as JPEG, or a PWG Raster page (a Brother DCP-T420W takes only that). */
export function directFormats(caps, canRaster = true) {
  const formats = (caps && caps.formats) || [];
  return { jpeg: formats.length === 0 || formats.includes('image/jpeg'), pwg: !!canRaster && formats.includes('image/pwg-raster') };
}

/** The paper type keyword to send ("photographic-glossy", "stationery") for what the booth asked for, from the types the printer lists, or ''. */
export function pickMediaType(caps, wanted) {
  const list = (caps && caps.mediaTypes) || [];
  const w = String(wanted || '').trim().toLowerCase();
  if (!w || !list.length) return '';
  const exact = list.find((t) => t.toLowerCase() === w);
  if (exact) return exact;
  if (/bp71/.test(w)) return list.find((t) => /bp71/i.test(t)) || '';
  if (/inkjet/.test(w)) return list.find((t) => t === 'stationery-inkjet') || list.find((t) => /inkjet/i.test(t)) || '';
  if (/glossy|photo/.test(w)) return list.find((t) => t === 'photographic-glossy') || list.find((t) => /^photographic/.test(t)) || '';
  if (/plain|stationery|normal/.test(w)) return list.find((t) => t === 'stationery') || list.find((t) => /^stationery/.test(t)) || '';
  return '';
}

const L8050_NAME = /(?<![a-z0-9-])l[\s_-]?8050(?![0-9])/i;

/**
 * The print quality (IPP number) and paper type a direct JPEG print asks for. Until now the JPEG path asked for neither, so every
 * photo went out on the printer's own default (plain paper, standard quality: banding lines and no borderless on an ink-tank printer).
 * - quality: what the booth asked for (best = 5, normal = 4, draft = 3), only if the printer lists it. An Epson L8050 does not list
 *   its qualities over IPP, so it is asked anyway; if it refuses, the job is sent again without them (see ippPrintDirect).
 * - paper type: the one the operator chose; with none chosen, glossy photo paper for a printer that says it can print borderless
 *   (media-*-margin-supported = 0) on a photo sheet (up to 6 x 8 in), and always for an L8050. `mediaType` 'driver' means "leave it
 *   to the printer". A dye-sub SELPHY keeps its own fixed paper and is never asked.
 */
export function directPhotoOpts(caps, { quality = '', mediaType = '', borderless = true, wMm = 0, hMm = 0 } = {}) {
  const none = { quality: 0, mediaType: '' };
  if (!caps || /selphy/i.test(caps.model || '')) return none;
  const hardL = L8050_NAME.test(caps.model || '');
  const want = ({ draft: 3, normal: 4, best: 5 })[quality] || 0;
  const qv = want && ((caps.qualities || []).includes(want) || hardL) ? want : 0;
  const list = caps.mediaTypes || [];
  let mt = '';
  if (mediaType && mediaType !== 'driver') mt = pickMediaType(caps, mediaType);
  else if (!mediaType) {
    const photoSheet = !(wMm > 0 && hMm > 0) || (Math.min(wMm, hMm) <= 155 && Math.max(wMm, hMm) <= 210);
    if (hardL) mt = list.includes('photographic-glossy') || !list.length ? 'photographic-glossy' : (list.find((t) => /^photographic/.test(t)) || '');
    else if (borderless !== false && caps.borderlessCap && photoSheet && list.includes('photographic-glossy')) mt = 'photographic-glossy';
  }
  return { quality: qv, mediaType: mt };
}

const IPP_MEDIA_LABELS = {
  stationery: 'Plain Paper',
  'stationery-inkjet': 'Inkjet Paper',
  'photographic-glossy': 'Glossy Photo Paper',
  'photographic-semi-gloss': 'Semi-Gloss Photo Paper',
  'photographic-satin': 'Satin Photo Paper',
  'photographic-matte': 'Matte Photo Paper',
  photographic: 'Photo Paper',
  'com.brother-bp71': 'Brother BP71 Photo'
};

/** Friendly label for an IPP media-type keyword ("photographic-glossy" -> "Glossy Photo Paper"). */
export function labelMediaType(kw) {
  const k = String(kw || '').trim();
  if (!k) return '';
  if (IPP_MEDIA_LABELS[k.toLowerCase()]) return IPP_MEDIA_LABELS[k.toLowerCase()];
  return k.replace(/^com\.[a-z0-9]+-/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Sends one photo straight to a printer over IPP (Wi-Fi TCP, or IPP-over-USB when `transport` is given).
 * Tries the paper the printer names itself first, then a custom size with no margins, then nothing at all,
 * and stops at the first one the printer accepts. Throws an Error with a reason a person can act on.
 */
export async function ippPrintDirect({ ip, port = 631, path = '', jpeg = null, image = null, toJpeg = null, widthMm = 0, heightMm = 0, jobName = 'photobooth4u', timeoutMs = 90000, rasterize = null, quality = '', mediaType = '', paperName = '', borderless = true, transport = null, busyWaitMs = 2500, maxBusyRetries = 24 }) {
  const caps = await ippCaps(ip, port, path, 4000, transport);
  if (!caps) {
    throw new Error(transport
      ? 'The USB printer did not answer over IPP-over-USB. Check its USB cable and power, then try again.'
      : 'The printer at ' + ip + ' did not answer. Is it on and on the same Wi-Fi as this computer? If it joined the Wi-Fi again it may have a new address: choose Find printers and use it again.');
  }
  const can = directFormats(caps, typeof rasterize === 'function');
  if (!can.jpeg && can.pwg) {
    return ippPrintPwg({ ip, port, caps, image: image || jpeg, widthMm, heightMm, jobName, timeoutMs, rasterize, quality, mediaType, paperName, borderless, transport, busyWaitMs, maxBusyRetries });
  }
  const accepted = can.jpeg;
  if (!accepted) throw new Error((caps.model || 'This printer') + ' can’t take photos straight from the app (it accepts: ' + caps.formats.filter((f) => /^(image|application)\//.test(f)).slice(0, 5).join(', ') + ').');
  if ((!jpeg || !jpeg.length) && image && typeof toJpeg === 'function') jpeg = toJpeg(image);
  if (!jpeg || !jpeg.length) throw new Error('Could not prepare the photo for the printer.');
  const named = (paperName && (caps.mediaSupported || []).includes(paperName) ? paperName : '') || pickMediaName(caps, widthMm, heightMm, true);
  const dims = named ? mediaSizeMm(named) : null;
  jpeg = jpegAt300Dpi(jpeg);
  const baseUri = transport ? transport.baseUri : `ipp://${ip}:${port}`;
  const send = transport ? transport.post : (p, body, ms) => ippPost(ip, port, p, body, ms);
  // A Canon SELPHY lists every paper twice: with its normal margins (a few mm of border) and as a "fullbleed" paper with zero margins.
  // Over IPP the fullbleed one is not a different name: it is the same paper asked for as a page size with all four margins 0. Asking by
  // name alone gets the bordered one, so the zero-margin page (sized as the printer's own paper) goes first and the name after it.
  const base = [
    ...(dims ? [{ wMm: dims[0], hMm: dims[1], scaling: 'fill' }, { wMm: dims[0], hMm: dims[1], scaling: '' }] : []),
    ...(named ? [{ mediaName: named, scaling: 'fill' }, { mediaName: named, scaling: '' }] : []),
    ...(widthMm > 0 && heightMm > 0 ? [{ wMm: widthMm, hMm: heightMm, scaling: 'fill' }] : []),
    { scaling: '' }
  ];
  // Each way of asking goes first with the quality / paper type (see directPhotoOpts), then again without them if the printer refuses.
  const dpo = directPhotoOpts(caps, { quality, mediaType, borderless, wMm: dims ? dims[0] : widthMm, hMm: dims ? dims[1] : heightMm });
  const attempts = base.flatMap((a) => (dpo.quality || dpo.mediaType ? [{ ...a, quality: dpo.quality, mediaType: dpo.mediaType }, a] : [a]));
  const sleep = (ms) => (ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve());
  let lastErr = 'The printer didn’t accept the photo.', drops = 0;
  for (const a of attempts) {
    for (const p of [...new Set([caps.path, '/ipp/print', '/ipp', '/'])]) {
      const body = ippPrintJobRequest({ uri: `${baseUri}${p}`, jobName, doc: jpeg, ...a });
      let r = await send(p, body, timeoutMs);
      for (let busy = 0; r && r.http === 200 && parseIpp(r.body).status === 0x0507 && busy < maxBusyRetries; busy++) {
        await sleep(busyWaitMs);
        r = await send(p, body, timeoutMs);
      }
      if (!r) { if (++drops >= 3) throw new Error(transport ? 'Lost the USB printer while sending the photo. Check the USB cable and power, then print again.' : 'Lost the printer while sending the photo. Check it is on and still on the same Wi-Fi, then print again.'); lastErr = 'The printer dropped the connection.'; continue; }
      if (r.http === 200) {
        const { status } = parseIpp(r.body);
        if (status >= 0 && status <= 2) return { media: a.mediaName || (a.wMm ? 'page ' + Math.round(a.wMm * 10) / 10 + 'x' + Math.round(a.hMm * 10) / 10 + ' mm, zero margins' : 'default'), scaling: a.scaling, jobId: parseIppJobId(r.body), path: p, model: caps.model || '' };
        if (status === 0x0507) throw new Error('The printer is still busy with the previous photo (code 0x507). Wait for it to finish, then print again.');
        lastErr = 'The printer refused the photo (code 0x' + status.toString(16) + ').';
      } else if (r.http === 426 || r.http === 301 || r.http === 302) lastErr = 'This printer only accepts secure printing, which the app doesn’t support yet.';
      else if (r.http !== 404) lastErr = 'The printer answered with HTTP ' + r.http + '.';
    }
  }
  throw new Error(lastErr);
}

/**
 * A printer that takes no JPEG and no PDF but does take PWG Raster (a Brother DCP-T420W): the photo is made into a raster page
 * of the printer's own paper size and sent as image/pwg-raster. Borderless photo prints go out zero-margin first (using glossy
 * photo paper when no paper type was chosen on a photo sheet, because the DCP-T420W constrains borderless against plain paper),
 * then with 3 mm margins, then on the paper's name, then with no paper named. Quality / colour / paper type are asked for with
 * the job and dropped again when the printer refuses them.
 */
async function ippPrintPwg({ ip, port, caps, image, widthMm, heightMm, jobName, timeoutMs, rasterize, quality, mediaType, paperName = '', borderless = true, transport = null, busyWaitMs = 2500, maxBusyRetries = 24 }) {
  if (!image || !image.length) throw new Error('Could not prepare the photo for the printer.');
  const types = caps.pwgTypes || [];
  if (types.length && !types.includes('srgb_8') && !types.includes('sgray_8')) {
    throw new Error((caps.model || 'This printer') + '’s raster mode (' + types.slice(0, 3).join(', ') + ') isn’t supported yet.');
  }
  const explicit = paperName && ((caps.mediaSupported || []).includes(paperName) || mediaSizeMm(paperName)) ? paperName : '';
  const named = explicit || pickMediaName(caps, widthMm, heightMm, true);
  const dims = (named && mediaSizeMm(named)) || (widthMm > 0 && heightMm > 0 ? [Math.min(widthMm, heightMm), Math.max(widthMm, heightMm)] : null);
  if (!dims) throw new Error('The paper size is missing, so the photo can’t be prepared for the printer.');
  const gray = types.length > 0 && !types.includes('srgb_8');
  const dpi = pickPwgDpi(caps.pwgRes, quality, dims[0], dims[1]);
  let mt = pickMediaType(caps, mediaType);
  // Brother DCP-T420W requires photo media for borderless output (plain paper / stationery is constrained against 0 margins).
  // For photo sheets (up to 5x8 in) when the operator left paper type at default, request photographic-glossy if the printer lists it.
  if (!mt && borderless !== false && dims[0] <= 155 && dims[1] <= 210 && (caps.mediaTypes || []).includes('photographic-glossy')) {
    mt = 'photographic-glossy';
  }
  const q = ({ draft: 3, normal: 4, best: 5 })[quality] || 0;
  const qv = q && (caps.qualities || []).includes(q) ? q : 0;
  const cm = (caps.colorModes || []).includes(gray ? 'monochrome' : 'color') ? (gray ? 'monochrome' : 'color') : '';
  const page = rasterize(image, {
    wMm: dims[0], hMm: dims[1], dpi, gray, mediaType: mt,
    pageSizeName: named || 'custom_photo_' + Math.round(dims[0] * 10) / 10 + 'x' + Math.round(dims[1] * 10) / 10 + 'mm',
    imageBox: false                                           // the way CUPS writes it, which is what this printer is known to take
  });
  const wantZero = borderless !== false && mt.toLowerCase() !== 'stationery';
  const zeroSized = { wMm: dims[0], hMm: dims[1], marginMm100: 0, scaling: '' };
  const borderedSized = { wMm: dims[0], hMm: dims[1], marginMm100: 300, scaling: '' };
  const opts = { quality: qv, colorMode: cm, mediaType: mt };
  const hasOpts = !!(qv || cm || mt);
  const base = [
    ...(wantZero ? [zeroSized, borderedSized] : [borderedSized]),
    ...(named ? [{ mediaName: named, scaling: '' }] : []),
    { scaling: '' }
  ];
  const attempts = base.flatMap((a) => (hasOpts ? [{ ...a, ...opts }, a] : [a]));
  const baseUri = transport ? transport.baseUri : `ipp://${ip}:${port}`;
  const send = transport ? transport.post : (p, body, ms) => ippPost(ip, port, p, body, ms);
  const sleep = (ms) => (ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve());
  let lastErr = 'The printer didn’t accept the photo.', drops = 0;
  for (const a of attempts) {
    for (const p of [...new Set([caps.path, '/ipp/print', '/ipp', '/'])]) {
      const body = ippPrintJobRequest({ uri: `${baseUri}${p}`, jobName, format: 'image/pwg-raster', doc: page, ...a });
      let r = await send(p, body, timeoutMs);
      for (let busy = 0; r && r.http === 200 && parseIpp(r.body).status === 0x0507 && busy < maxBusyRetries; busy++) {
        await sleep(busyWaitMs);
        r = await send(p, body, timeoutMs);
      }
      if (!r) { if (++drops >= 3) throw new Error(transport ? 'Lost the USB printer while sending the photo. Check the USB cable and power, then print again.' : 'Lost the printer while sending the photo. Check it is on and still on the same Wi-Fi, then print again.'); lastErr = 'The printer dropped the connection.'; continue; }
      if (r.http === 200) {
        const { status } = parseIpp(r.body);
        if (status >= 0 && status <= 2) {
          const marginLabel = a.marginMm100 ? ', ' + (a.marginMm100 / 100) + ' mm margins' : ', zero margins';
          return { media: a.mediaName || (a.wMm ? 'page ' + Math.round(a.wMm * 10) / 10 + 'x' + Math.round(a.hMm * 10) / 10 + ' mm' + marginLabel : 'default'), scaling: '', format: 'image/pwg-raster', dpi, quality: a.quality || 0, mediaType: a.mediaType || '', jobId: parseIppJobId(r.body), path: p, model: caps.model || '' };
        }
        if (status === 0x0507) throw new Error('The printer is still busy with the previous photo (code 0x507). Wait for it to finish, then print again.');
        lastErr = 'The printer refused the photo (code 0x' + status.toString(16) + ').';
      } else if (r.http === 426 || r.http === 301 || r.http === 302) lastErr = 'This printer only accepts secure printing, which the app doesn’t support yet.';
      else if (r.http !== 404) lastErr = 'The printer answered with HTTP ' + r.http + '.';
    }
  }
  throw new Error(lastErr);
}

/**
 * Waits between multi-sheet IPP jobs on a dye-sub photo printer (Canon SELPHY CP1300 / CP1500) so the next sheet
 * does not collide with the ~45s 4-pass ribbon cycle. Polls Get-Job-Attributes (when jobId > 0) and Get-Printer-Attributes.
 */
export async function waitIppIdle({ ip, port = 631, path = '/ipp/print', jobId = 0, transport = null, pollMs = 2000, maxWaitMs = 75000 } = {}) {
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const baseUri = transport ? transport.baseUri : `ipp://${ip}:${port}`;
  const reqPath = path || '/ipp/print';
  const uri = `${baseUri}${reqPath}`;
  const send = transport ? transport.post : (p, body, ms) => ippPost(ip, port, p, body, ms);
  await sleep(Math.min(pollMs, 1500));
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (jobId > 0) {
      const req = Buffer.concat([
        Buffer.from([0x02, 0x00, 0x00, 0x09, 0, 0, 0, 2, 0x01]),
        ippTagged(0x47, 'attributes-charset', 'utf-8'),
        ippTagged(0x48, 'attributes-natural-language', 'en'),
        ippTagged(0x45, 'printer-uri', uri),
        Buffer.from([0x21]), ippStr('job-id'), ippU16(4), ippU32(jobId),
        ippTagged(0x44, 'requested-attributes', 'job-state'),
        Buffer.from([0x03])
      ]);
      const r = await send(reqPath, req, 5000);
      if (r && r.http === 200 && r.body && r.body.length >= 8) {
        const st = r.body.readUInt16BE(2);
        if (st === 0x0406) return;
        let jobState = 0;
        for (const { name, tag, value } of parseIppGrouped(r.body)) {
          if (name === 'job-state' && tag === 0x23 && value.length === 4) { jobState = value.readInt32BE(0); break; }
        }
        if (jobState >= 7) return;
        if (jobState >= 3 && jobState <= 6) { await sleep(pollMs); continue; }
      }
    }
    const preq = Buffer.concat([
      Buffer.from([0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 3, 0x01]),
      ippTagged(0x47, 'attributes-charset', 'utf-8'),
      ippTagged(0x48, 'attributes-natural-language', 'en'),
      ippTagged(0x45, 'printer-uri', uri),
      ippTagged(0x44, 'requested-attributes', 'printer-state'),
      ippTagged(0x44, '', 'printer-state-reasons'),
      Buffer.from([0x03])
    ]);
    const pr = await send(reqPath, preq, 5000);
    if (pr && pr.http === 200 && pr.body && pr.body.length >= 8) {
      let pState = 0;
      const reasons = [];
      for (const { name, tag, value } of parseIppGrouped(pr.body)) {
        if (name === 'printer-state' && tag === 0x23 && value.length === 4) pState = value.readInt32BE(0);
        else if (name === 'printer-state-reasons' && tag >= 0x40) reasons.push(value.toString('utf8').toLowerCase());
      }
      if (pState === 3 && !reasons.some((s) => s.includes('processing') || s.includes('moving-to-paused'))) return;
    }
    await sleep(pollMs);
  }
}

// ---- Wireless printer diagnostics (mirrors Android NetPrintBridge.kt diagProbeSync / diagPrintSync) ----

const IPP_STATUS_NAMES = {
  0x0000: 'successful-ok',
  0x0001: 'successful-ok-ignored-or-substituted-attributes',
  0x0002: 'successful-ok-conflicting-attributes',
  0x0400: 'client-error-bad-request',
  0x0403: 'client-error-not-authorized',
  0x0404: 'client-error-not-possible',
  0x0406: 'client-error-not-found',
  0x040a: 'client-error-document-format-not-supported',
  0x040b: 'client-error-attributes-or-values-not-supported',
  0x040e: 'client-error-conflicting-attributes',
  0x0500: 'server-error-internal-error',
  0x0501: 'server-error-operation-not-supported',
  0x0507: 'server-error-busy'
};
const IPP_JOB_STATES = { 3: 'pending', 4: 'pending-held', 5: 'processing', 6: 'processing-stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' };

export function ippStatusName(code) {
  return IPP_STATUS_NAMES[code] || ('0x' + Math.max(0, Number(code) || 0).toString(16));
}

function ippValText(tag, raw) {
  if (tag === 0x10) return '(unsupported)';
  if (tag === 0x12) return '(unknown)';
  if (tag === 0x13) return '(no-value)';
  if ((tag === 0x21 || tag === 0x23) && raw.length === 4) return String(raw.readInt32BE(0));
  if (tag === 0x22 && raw.length === 1) return raw[0] ? 'true' : 'false';
  if (tag === 0x32 && raw.length === 9) {
    const x = raw.readUInt32BE(0), y = raw.readUInt32BE(4), u = raw[8] === 3 ? 'dpi' : 'dpcm';
    return x === y ? `${x}${u}` : `${x}x${y}${u}`;
  }
  if (tag === 0x33 && raw.length === 8) return `${raw.readInt32BE(0)}..${raw.readInt32BE(4)}`;
  if (tag === 0x34) return '{';
  if (tag === 0x37) return '}';
  if (tag >= 0x40) return raw.toString('utf8');
  return '0x' + raw.toString('hex');
}

export function extractUnsupported(buf) {
  const out = [];
  for (const v of parseIppGrouped(buf)) {
    if (v.group !== 0x05 || v.tag === 0x34 || v.tag === 0x37) continue;
    if (v.tag === 0x4a) { const m = v.value.toString('utf8'); if (m) out.push('member:' + m); }
    else if (v.name) {
      const txt = ippValText(v.tag, v.value);
      out.push(txt && txt !== '(unsupported)' ? `${v.name}=${txt}` : v.name);
    }
  }
  return [...new Set(out)];
}

function extractStatusMessage(buf) {
  const hit = parseIppGrouped(buf).find((v) => v.group === 0x01 && v.name === 'status-message' && (v.tag === 0x41 || v.tag === 0x42));
  return hit ? hit.value.toString('utf8') : '';
}

function extractJobId(buf) {
  const hit = parseIppGrouped(buf).find((v) => v.name === 'job-id' && v.tag === 0x21 && v.value.length === 4);
  return hit ? hit.value.readInt32BE(0) : null;
}

export function ippAllAttrsRequest(uri) {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x0b, 0, 0, 0, 1, 0x01]),
    ippTagged(0x47, 'attributes-charset', 'utf-8'),
    ippTagged(0x48, 'attributes-natural-language', 'en'),
    ippTagged(0x45, 'printer-uri', uri),
    ippTagged(0x44, 'requested-attributes', 'all'),
    Buffer.from([0x03])
  ]);
}

export function ippGetJobAttributesRequest(uri, jobId) {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x09, 0, 0, 0, 2, 0x01]),
    ippTagged(0x47, 'attributes-charset', 'utf-8'),
    ippTagged(0x48, 'attributes-natural-language', 'en'),
    ippTagged(0x45, 'printer-uri', uri),
    Buffer.concat([Buffer.from([0x21]), ippStr('job-id'), ippU16(4), ippU32(jobId)]),
    ippTagged(0x44, 'requested-attributes', 'job-state'),
    ippTagged(0x44, '', 'job-state-reasons'),
    ippTagged(0x44, '', 'job-state-message'),
    Buffer.from([0x03])
  ]);
}

function portProbeTimed(ip, port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (open, error) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ port, open, ms: Date.now() - t0, ...(error ? { error } : {}) });
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false, 'Timeout'));
    s.once('error', (e) => finish(false, e && e.code ? e.code : String(e && e.message || e)));
    s.connect(port, ip);
  });
}

export function diagNetworkInfo({ appVersion = '', printers = [] } = {}) {
  const subnets = lanSubnets();
  const suggestions = new Set();
  let wifiDirectDetected = false;
  const nets = subnets.map((s) => {
    const gw = longToIp((Math.floor(ipToLong(s.address) / 256) * 256) + 1);
    const isEpsonWfd = /^192\.168\.223\./.test(s.address);
    const isBrotherWfd = /^192\.168\.118\./.test(s.address);
    const isP2p = /^192\.168\.49\./.test(s.address);
    const wfd = isEpsonWfd || isBrotherWfd || isP2p;
    if (wfd) wifiDirectDetected = true;
    if (isBrotherWfd) suggestions.add('192.168.118.1');
    if (isEpsonWfd) suggestions.add('192.168.223.1');
    if (gw !== s.address) suggestions.add(gw);
    return { iface: s.name, ip: s.address, prefix: s.prefix, gateway: gw, boundNetwork: false, wifiDirectHint: wfd };
  });
  for (const p of printers) if (p && p.ip) suggestions.add(p.ip);
  return {
    platform: process.platform,
    device: `${os.platform()} ${os.release()} (${os.arch()})`,
    appVersion,
    wifiDirectDetected,
    nets,
    suggestedIps: [...suggestions],
    printers
  };
}

function defaultValidateCases(named4x6, supportsPwg) {
  const list = [
    { id: 'ipp-col-q5-glossy-scNone', label: 'media-col (0mm) + glossy IN col + High(5) + scaling=none', withMedia: true, mediaName: '', marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: 'none', format: 'image/jpeg' },
    { id: 'ipp-col-q5-glossy-noSc', label: 'media-col (0mm) + glossy IN col + High(5) + NO scaling', withMedia: true, mediaName: '', marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: '', format: 'image/jpeg' },
    { id: 'ipp-col-q5-glossy-scFill', label: 'media-col (0mm) + glossy IN col + High(5) + scaling=fill', withMedia: true, mediaName: '', marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: 'fill', format: 'image/jpeg' },
    { id: 'ipp-top-q5-glossy-scNone', label: 'OLD ca4428a style: media-col + TOP-LEVEL glossy + High(5) + scaling=none', withMedia: true, mediaName: '', marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'top', scaling: 'none', format: 'image/jpeg' }
  ];
  if (named4x6) list.push({ id: 'ipp-named-q5-glossy-noSc', label: `named media=${named4x6} + High(5) + top glossy + NO scaling`, withMedia: false, mediaName: named4x6, marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'top', scaling: '', format: 'image/jpeg' });
  list.push({ id: 'ipp-col-only-noSc', label: 'media-col (0mm) only (no quality / media-type / scaling)', withMedia: true, mediaName: '', marginMm100: 0, quality: 0, mediaType: '', mediaTypeMode: 'none', scaling: '', format: 'image/jpeg' });
  list.push({ id: 'ipp-minimal', label: 'Minimal JPEG (no job attributes)', withMedia: false, mediaName: '', marginMm100: 0, quality: 0, mediaType: '', mediaTypeMode: 'none', scaling: '', format: 'image/jpeg' });
  if (supportsPwg) list.push({ id: 'ipp-pwg-col-q5-glossy', label: 'PWG Raster + media-col (0mm) + glossy IN col + High(5)', withMedia: true, mediaName: '', marginMm100: 0, quality: 5, mediaType: 'photographic-glossy', mediaTypeMode: 'col', scaling: '', format: 'image/pwg-raster' });
  return list;
}

const DIAG_WANTED_ATTRS = new Set([
  'printer-make-and-model', 'printer-name', 'printer-info', 'printer-dns-sd-name',
  'printer-state', 'printer-state-reasons', 'printer-state-message',
  'ipp-versions-supported', 'operations-supported', 'document-format-supported', 'document-format-default',
  'print-quality-supported', 'print-quality-default', 'print-color-mode-supported', 'print-color-mode-default',
  'print-scaling-supported', 'print-scaling-default',
  'media-supported', 'media-ready', 'media-default',
  'media-type-supported', 'media-source-supported', 'media-col-supported',
  'media-top-margin-supported', 'media-bottom-margin-supported', 'media-left-margin-supported', 'media-right-margin-supported',
  'pwg-raster-document-resolution-supported', 'pwg-raster-document-type-supported', 'urf-supported',
  'printer-resolution-supported', 'color-supported'
]);

/** Full zero-paper Wi-Fi / Wi-Fi Direct probe (ports, Get-Printer-Attributes "all", Validate-Job matrix). */
export async function ippDiagProbe({ ip: rawIp, port = 631, rawPort = 9100, cases = null, appVersion = '' } = {}) {
  const ip = String(rawIp || '').trim();
  const out = { ok: true, ip, timestamp: Date.now(), network: diagNetworkInfo({ appVersion }) };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ...out, ok: false, error: 'Invalid IPv4 address: ' + ip };

  const [p631, p9100, p515, p80] = await Promise.all([
    portProbeTimed(ip, port, 3000),
    portProbeTimed(ip, rawPort, 2500),
    portProbeTimed(ip, 515, 1500),
    portProbeTimed(ip, 80, 1500)
  ]);
  out.ports = { 631: p631, 9100: p9100, 515: p515, 80: p80 };
  if (!p631.open && !p9100.open) {
    out.reachable = false;
    out.ipp = { answered: false };
    out.validateMatrix = [];
    out.recommendation = `Printer ${ip} did not answer on port ${port} (IPP) or ${rawPort} (raw/ESC/P-R). Check power, 2.4 GHz Wi-Fi / Wi-Fi Direct connection, and router AP Isolation (Privacy Separator).`;
    return out;
  }
  out.reachable = true;

  let chosenPath = '', named4x6 = '', supportsPwg = false;
  out.ipp = { answered: false };
  if (p631.open) {
    for (const path of ['/ipp/print', '/ipp', '/', '/ipp/printer', '/printer']) {
      const t0 = Date.now();
      const uri = `ipp://${ip}:${port}${path}`;
      let r = await ippPost(ip, port, path, ippAllAttrsRequest(uri), 8000);
      if (!r || r.http !== 200 || parseIpp(r.body).status > 2) {
        r = await ippPost(ip, port, path, ippCapsRequest(uri), 6000);
      }
      if (!r || r.http !== 200) continue;
      const status = r.body.length >= 4 ? r.body.readUInt16BE(2) : -1;
      if (status < 0 || status > 2) continue;
      chosenPath = path;
      const attrs = {}, allNames = new Set();
      let dbTotal = 0, inDb = false, dbDepth = 0, curMember = '', curX = 0, curY = 0, curTop = -1, curLeft = -1, curMt = '', curSrc = '';
      const dbMediaTypes = new Set(), dbSample4x6 = [];
      for (const v of parseIppGrouped(r.body)) {
        if (v.group === 0x05) continue;
        if (v.name && !inDb) allNames.add(v.name);
        if (v.name === 'media-col-database' || inDb) {
          if (v.name === 'media-col-database' && v.tag === 0x34 && !inDb) {
            inDb = true; dbDepth = 1; dbTotal++;
            curMember = ''; curX = 0; curY = 0; curTop = -1; curLeft = -1; curMt = ''; curSrc = '';
            continue;
          }
          if (inDb) {
            if (v.tag === 0x34) { dbDepth++; continue; }
            if (v.tag === 0x37) {
              dbDepth--;
              if (dbDepth <= 0) {
                inDb = false;
                if (curMt) dbMediaTypes.add(curMt);
                if (((curX >= 9900 && curX <= 10400 && curY >= 14700 && curY <= 15500) || curTop === 0) && dbSample4x6.length < 16) {
                  dbSample4x6.push(`${curX}x${curY} m=(${curTop},${curLeft}) mt=${curMt || '-'} src=${curSrc || '-'}`);
                }
              }
              continue;
            }
            if (v.tag === 0x4a) { curMember = v.value.toString('utf8'); continue; }
            const txt = ippValText(v.tag, v.value);
            if (curMember === 'x-dimension') curX = Number(txt) || curX;
            else if (curMember === 'y-dimension') curY = Number(txt) || curY;
            else if (curMember === 'media-top-margin') curTop = Number(txt);
            else if (curMember === 'media-left-margin') curLeft = Number(txt);
            else if (curMember === 'media-type') curMt = txt;
            else if (curMember === 'media-source') curSrc = txt;
            continue;
          }
        }
        if (DIAG_WANTED_ATTRS.has(v.name) && v.tag !== 0x34 && v.tag !== 0x37 && v.tag !== 0x4a) {
          const list = (attrs[v.name] = attrs[v.name] || []);
          const txt = ippValText(v.tag, v.value);
          if (txt && list.length < 64) list.push(txt);
        }
      }
      const formats = (attrs['document-format-supported'] || []).map((s) => s.toLowerCase());
      supportsPwg = formats.includes('image/pwg-raster');
      const mediaAll = [...(attrs['media-ready'] || []), ...(attrs['media-supported'] || [])];
      named4x6 = mediaAll.find((n) => {
        const sz = mediaSizeMm(n);
        return sz && Math.abs(sz[0] - 101.6) <= 3 && Math.abs(sz[1] - 152.4) <= 5;
      }) || '';
      out.ipp = {
        answered: true, path, ms: Date.now() - t0, ippStatus: ippStatusName(status),
        bodyBytes: r.body.length, attrCount: allNames.size, attrs,
        mediaColDbCount: dbTotal, mediaColDbMediaTypes: [...dbMediaTypes], mediaColDb4x6Samples: dbSample4x6
      };
      break;
    }
  }

  const valResults = [];
  if (chosenPath) {
    const runCases = Array.isArray(cases) && cases.length ? cases : defaultValidateCases(named4x6, supportsPwg);
    const uri = `ipp://${ip}:${port}${chosenPath}`;
    for (let i = 0; i < runCases.length; i++) {
      const c = runCases[i] || {};
      const id = c.id || ('case-' + i);
      const label = c.label || id;
      const t0 = Date.now();
      const body = ippPrintJobRequest({
        uri, jobName: 'pb4u-validate', format: c.format || 'image/jpeg', doc: null,
        wMm: c.withMedia !== false ? (Number(c.widthMm) || 101.6) : 0,
        hMm: c.withMedia !== false ? (Number(c.heightMm) || 152.4) : 0,
        mediaName: c.mediaName || '', scaling: c.scaling || '', quality: Number(c.quality) || 0,
        colorMode: c.colorMode || '', mediaType: c.mediaType || '', marginMm100: Number(c.marginMm100) || 0,
        opCode: 0x0004, mediaTypeMode: c.mediaTypeMode || 'col'
      });
      const r = await ippPost(ip, port, chosenPath, body, 8000);
      if (!r) {
        valResults.push({ id, label, ok: false, clean: false, error: 'Connection dropped or timed out', ms: Date.now() - t0 });
        continue;
      }
      const ipp = r.http === 200 && r.body.length >= 4 ? r.body.readUInt16BE(2) : -1;
      const unsupported = r.http === 200 ? extractUnsupported(r.body) : [];
      const statusMessage = r.http === 200 ? extractStatusMessage(r.body) : '';
      const accepted = r.http === 200 && ipp >= 0 && ipp <= 2;
      valResults.push({
        id, label, http: r.http, ipp, ippHex: '0x' + Math.max(0, ipp).toString(16), ippName: ippStatusName(ipp),
        ok: accepted, clean: accepted && unsupported.length === 0 && ipp === 0, unsupported, statusMessage, ms: Date.now() - t0
      });
    }
  }
  out.validateMatrix = valResults;

  const rec = [];
  rec.push(p9100.open ? 'Port 9100 (raw ESC/P-R) is OPEN.' : 'Port 9100 (raw ESC/P-R) is CLOSED.');
  if (chosenPath) {
    const clean = valResults.find((r) => r.clean && r.id !== 'ipp-minimal');
    const anyOk = valResults.find((r) => r.ok && r.id !== 'ipp-minimal');
    const oldBad = valResults.find((r) => r.id === 'ipp-top-q5-glossy-scNone' && !r.ok);
    if (clean) rec.push(`Cleanest IPP Validate-Job winner: ${clean.id} (0 ignored attributes).`);
    else if (anyOk) rec.push(`IPP accepted ${anyOk.id} but ignored some attributes — check unsupported list and also test ESC/P-R on port 9100.`);
    else rec.push('IPP Validate-Job rejected photo options (or Validate-Job unsupported) — run a 1-sheet live test.');
    if (oldBad) rec.push('Confirmed: old top-level media-type + scaling=none failed Validate-Job on this printer.');
  } else {
    rec.push('IPP port 631 did not answer Get-Printer-Attributes — use ESC/P-R on port 9100 if open.');
  }
  out.recommendation = rec.join(' ');
  return out;
}

/** Explicit 1-sheet live IPP Print-Job diagnostic + Get-Job-Attributes polling. */
export async function ippDiagPrint({ ip: rawIp, port = 631, path = '/ipp/print', protocol = 'ipp', imageBase64 = '', widthMm = 101.6, heightMm = 152.4, format = 'image/jpeg', withMedia = true, mediaName = '', marginMm100 = 0, quality = 5, colorMode = '', mediaType = 'photographic-glossy', mediaTypeMode = 'col', scaling = '', pollSeconds = 12 } = {}) {
  const ip = String(rawIp || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, ip, protocol, error: 'Invalid IPv4 address: ' + ip };
  if (String(protocol).toLowerCase() === 'escpr') {
    return { ok: false, ip, protocol: 'escpr', error: 'ESC/P-R port 9100 diagnostic prints run directly on the Android app helper (not the desktop helper).' };
  }
  const cleanB64 = String(imageBase64 || '').replace(/^data:[^,]*,/, '');
  if (!cleanB64) return { ok: false, ip, protocol: 'ipp', error: 'Missing calibration imageBase64.' };
  const doc = jpegAt300Dpi(Buffer.from(cleanB64, 'base64'));
  const uri = `ipp://${ip}:${port}${path || '/ipp/print'}`;
  const reqBody = ippPrintJobRequest({
    uri, jobName: 'pb4u-diag', format, doc,
    wMm: withMedia ? Number(widthMm) || 101.6 : 0, hMm: withMedia ? Number(heightMm) || 152.4 : 0,
    mediaName, scaling, quality: Number(quality) || 0, colorMode, mediaType, marginMm100: Number(marginMm100) || 0,
    opCode: 0x0002, mediaTypeMode: mediaTypeMode || 'col'
  });
  const t0 = Date.now();
  const r = await ippPost(ip, port, path || '/ipp/print', reqBody, 90000);
  if (!r) return { ok: false, ip, protocol: 'ipp', path, sendMs: Date.now() - t0, error: 'Connection dropped or timed out' };
  const ipp = r.http === 200 && r.body.length >= 4 ? r.body.readUInt16BE(2) : -1;
  const unsupported = r.http === 200 ? extractUnsupported(r.body) : [];
  const statusMessage = r.http === 200 ? extractStatusMessage(r.body) : '';
  const jobId = r.http === 200 ? extractJobId(r.body) : null;
  const ok = r.http === 200 && ipp >= 0 && ipp <= 2;
  const jobStates = [];
  const maxPoll = Math.max(0, Math.min(30, Number(pollSeconds) || 0));
  if (ok && jobId != null && maxPoll > 0) {
    const until = Date.now() + maxPoll * 1000;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, Math.min(2000, Math.max(250, until - Date.now()))));
      const jr = await ippPost(ip, port, path || '/ipp/print', ippGetJobAttributesRequest(uri, jobId), 5000);
      if (!jr || jr.http !== 200) continue;
      let st = 0; const reasons = []; let message = '';
      for (const v of parseIppGrouped(jr.body)) {
        if (v.group === 0x05) continue;
        if (v.name === 'job-state' && v.tag === 0x23 && v.value.length === 4) st = v.value.readInt32BE(0);
        if (v.name === 'job-state-reasons' && v.tag === 0x44) reasons.push(v.value.toString('utf8'));
        if (v.name === 'job-state-message' && (v.tag === 0x41 || v.tag === 0x42) && !message) message = v.value.toString('utf8');
      }
      if (st) {
        jobStates.push({ atMs: Date.now() - t0, state: st, stateName: IPP_JOB_STATES[st] || `unknown(${st})`, reasons, message });
        if (st === 7 || st === 8 || st === 9) break;
      }
    }
  }
  return {
    ok, ip, protocol: 'ipp', path, format, docBytes: doc.length, sendMs: Date.now() - t0,
    http: r.http, ipp, ippHex: '0x' + Math.max(0, ipp).toString(16), ippName: ippStatusName(ipp),
    unsupported, statusMessage, jobId: jobId == null ? -1 : jobId, jobStates
  };
}
