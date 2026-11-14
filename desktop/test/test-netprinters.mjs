import assert from 'node:assert/strict';
import http from 'node:http';
import { lanSubnets, sweepTargets, ippGetAttributes, parseIpp, ippIdentify, portOpen } from '../lib/netprinters.mjs';

// ---- which networks are searched ----
const subnets = lanSubnets({
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.12', netmask: '255.255.255.0', internal: false }, { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
  'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', netmask: '255.255.240.0', internal: false }],
  'Ethernet 2': [{ family: 'IPv4', address: '169.254.10.5', netmask: '255.255.0.0', internal: false }],
  'Office': [{ family: 'IPv4', address: '10.0.5.20', netmask: '255.255.254.0', internal: false }]
});
assert.deepEqual(subnets.map((s) => `${s.address}/${s.prefix}`), ['192.168.1.12/24', '10.0.5.20/23']);
console.log('✓ Passed: only real LAN adapters are searched (no loopback, virtual, or link-local)');

const t24 = sweepTargets([subnets[0]]);
assert.equal(t24.length, 253);
assert.ok(!t24.includes('192.168.1.12') && t24.includes('192.168.1.1') && t24.includes('192.168.1.254') && t24.includes('192.168.1.21'));
const t23 = sweepTargets([subnets[1]]);
assert.equal(t23[0], '10.0.5.1');                                  // the computer's own /24 comes first
assert.ok(t23.includes('10.0.4.77') && t23.includes('10.0.5.250') && !t23.includes('10.0.5.20'));
assert.equal(t23.length, 510 - 1);                                // every host of the /23 (2 x 256 minus network and broadcast), minus ourselves
assert.ok(t23.indexOf('10.0.4.200') > t23.indexOf('10.0.5.254'));  // the other half comes after the computer's own /24
console.log('✓ Passed: sweep covers the computer’s /24 first, then the rest of a larger subnet');

// ---- asking a printer who it is ----
const req = ippGetAttributes('ipp://192.168.1.21:631/ipp/print');
assert.equal(req.readUInt16BE(2), 0x000b);                         // Get-Printer-Attributes
assert.ok(req.includes(Buffer.from('printer-make-and-model')) && req[req.length - 1] === 0x03);

function reply(attrs) {
  const parts = [Buffer.from([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x04])];
  for (const [name, val] of attrs) {
    const n = Buffer.from(name), v = Buffer.from(val);
    const h = Buffer.alloc(3 + n.length + 2); h[0] = 0x41; h.writeUInt16BE(n.length, 1); n.copy(h, 3); h.writeUInt16BE(v.length, 3 + n.length);
    parts.push(h, v);
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}
const parsed = parseIpp(reply([['printer-make-and-model', 'Brother DCP-T730DW'], ['printer-name', 'BRW1234']]));
assert.equal(parsed.status, 0);
assert.deepEqual(parsed.attrs['printer-make-and-model'], ['Brother DCP-T730DW']);
console.log('✓ Passed: IPP request and reply are read correctly');

const srv = http.createServer((rq, rs) => {
  const chunks = []; rq.on('data', (d) => chunks.push(d));
  rq.on('end', () => {
    if (rq.url !== '/ipp/print') { rs.writeHead(404).end(); return; }       // the first path tried is wrong on purpose below
    rs.writeHead(200, { 'content-type': 'application/ipp' }).end(reply([['printer-make-and-model', 'EPSON L3250 Series']]));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const id = await ippIdentify('127.0.0.1', port, 2000);
assert.equal(id.name, 'EPSON L3250 Series');
assert.equal(id.path, '/ipp/print');
assert.equal(await portOpen('127.0.0.1', port, 500), true);
srv.close();
assert.equal(await portOpen('127.0.0.1', port, 500), false);
assert.equal(await ippIdentify('127.0.0.1', port, 500), null);
console.log('✓ Passed: a printer is found open, named over IPP, and a closed port is reported as not a printer');

// ---- printing straight to a printer (a Canon SELPHY with no driver) ----
{
  const { ippPrintJobRequest, ippPrintDirect, pickMediaName, ippCaps } = await import('../lib/netprinters.mjs');
  const jobReq = ippPrintJobRequest({ uri: 'ipp://10.0.0.5:631/ipp/print', doc: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mediaName: 'jpn_hagaki_100x148mm', scaling: 'fill' });
  assert.equal(jobReq.readUInt16BE(2), 0x0002);                              // Print-Job
  assert.ok(jobReq.includes(Buffer.from('jpn_hagaki_100x148mm')) && jobReq.includes(Buffer.from('print-scaling')) && jobReq.includes(Buffer.from('image/jpeg')));
  assert.deepEqual([...jobReq.subarray(jobReq.length - 4)], [0xff, 0xd8, 0xff, 0xd9]);   // the photo comes right after the end-of-attributes tag
  const colReq = ippPrintJobRequest({ uri: 'ipp://x/', doc: Buffer.from([1]), wMm: 100, hMm: 148, scaling: '' });
  assert.ok(colReq.includes(Buffer.from('media-col')) && colReq.includes(Buffer.from('media-top-margin')) && !colReq.includes(Buffer.from('print-scaling')));
  assert.equal(pickMediaName({ mediaReady: ['na_index-4x6_4x6in'], mediaSupported: ['jpn_hagaki_100x148mm', 'na_index-4x6_4x6in', 'iso_a4_210x297mm'] }, 100, 148), 'na_index-4x6_4x6in');
  assert.equal(pickMediaName({ mediaReady: [], mediaSupported: ['jpn_hagaki_100x148mm', 'om_card_54x86mm'] }, 100, 148), 'jpn_hagaki_100x148mm');
  assert.equal(pickMediaName({ mediaReady: [], mediaSupported: ['jpn_hagaki_100x148mm', 'om_card_54x86mm'] }, 54, 86), 'om_card_54x86mm');
  assert.equal(pickMediaName({ mediaReady: [], mediaSupported: ['iso_a4_210x297mm'] }, 100, 148), '');
  // A printer that lists a borderless version of the paper: it is read, and used when borderless is wanted.
  const both = { mediaReady: ['jpn_hagaki_100x148mm'], mediaSupported: ['jpn_hagaki_100x148mm', 'jpn_hagaki_100x148mm_borderless', 'om_card_54x86mm'] };
  assert.equal(pickMediaName(both, 100, 148, true), 'jpn_hagaki_100x148mm_borderless');
  assert.equal(pickMediaName(both, 100, 148, false), 'jpn_hagaki_100x148mm');
  assert.equal(pickMediaName({ mediaReady: [], mediaSupported: ['na_index-4x6_4x6in-borderless'] }, 101.6, 152.4, true), 'na_index-4x6_4x6in-borderless');
  const { jpegAt300Dpi } = await import('../lib/netprinters.mjs');
  const jfif = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
  const dpi = jpegAt300Dpi(jfif);
  assert.equal(dpi[13], 1); assert.equal(dpi.readUInt16BE(14), 300); assert.equal(dpi.readUInt16BE(16), 300);
  assert.equal(jfif[13], 0, 'the original bytes are left alone');
  const notJfif = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual([...jpegAt300Dpi(notJfif)], [...notJfif]);
  console.log('✓ Passed: a borderless version of the paper is preferred when asked for, and the photo carries 300 dpi');
  console.log('✓ Passed: the direct print request carries the paper name, the photo, and no border settings it was not asked for');

  const multi = (head, attrs) => {
    const parts = [Buffer.from(head)];
    for (const [name, vals] of attrs) vals.forEach((val, i) => {
      const n = Buffer.from(i === 0 ? name : ''), v = Buffer.from(val);
      const h = Buffer.alloc(3 + n.length + 2); h[0] = 0x44; h.writeUInt16BE(n.length, 1); n.copy(h, 3); h.writeUInt16BE(v.length, 3 + n.length);
      parts.push(h, v);
    });
    parts.push(Buffer.from([0x03])); return Buffer.concat(parts);
  };
  const OK = [0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x04];
  const seen = [];
  let refuseNamed = false;
  const sp = http.createServer((rq, rs) => {
    const ch = []; rq.on('data', (d) => ch.push(d));
    rq.on('end', () => {
      const body = Buffer.concat(ch);
      if (rq.url !== '/ipp/print') { rs.writeHead(404).end(); return; }
      if (body.readUInt16BE(2) === 0x000b) {
        rs.writeHead(200, { 'content-type': 'application/ipp' }).end(multi(OK, [['printer-make-and-model', ['Canon SELPHY CP1300']],
          ['document-format-supported', ['application/octet-stream', 'image/jpeg', 'image/urf']], ['media-ready', ['jpn_hagaki_100x148mm']],
          ['media-supported', ['jpn_hagaki_100x148mm', 'om_card_54x86mm']]]));
        return;
      }
      seen.push(body);
      const zeroMargin = body.includes(Buffer.from('media-col'));      // the page asked for as a size with all margins 0 (the borderless way)
      const status = refuseNamed && zeroMargin ? [0x02, 0x00, 0x04, 0x00, 0, 0, 0, 1, 0x03] : [0x02, 0x00, 0x00, 0x00, 0, 0, 0, 1, 0x03];
      rs.writeHead(200, { 'content-type': 'application/ipp' }).end(Buffer.from(status));
    });
  });
  await new Promise((r) => sp.listen(0, '127.0.0.1', r));
  const pp = sp.address().port;
  const caps = await ippCaps('127.0.0.1', pp);
  assert.equal(caps.model, 'Canon SELPHY CP1300');
  assert.deepEqual(caps.mediaReady, ['jpn_hagaki_100x148mm']);
  assert.ok(caps.formats.includes('image/jpeg'));
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  let r1 = await ippPrintDirect({ ip: '127.0.0.1', port: pp, jpeg, widthMm: 100, heightMm: 148 });
  // First try: the printer's own paper (100 x 148 mm) asked for as a page with all four margins 0, which is how a SELPHY is asked for no border.
  assert.equal(r1.media, 'page 100x148 mm, zero margins');
  assert.equal(r1.scaling, 'fill');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes(Buffer.from('media-col')) && seen[0].includes(Buffer.from('media-top-margin')) && !seen[0].includes(Buffer.from('jpn_hagaki_100x148mm')));
  assert.ok(seen[0].includes(Buffer.from([0x00, 0x00, 0x27, 0x10])) && seen[0].includes(Buffer.from([0x00, 0x00, 0x39, 0xd0])));   // 10000 and 14800 (hundredths of a mm)
  assert.deepEqual([...seen[0].subarray(seen[0].length - jpeg.length)], [...jpeg]);
  // The printer refuses the zero-margin page: the paper's name is tried next, and the job still goes through.
  refuseNamed = true; seen.length = 0;
  let r2 = await ippPrintDirect({ ip: '127.0.0.1', port: pp, jpeg, widthMm: 100, heightMm: 148 });
  assert.equal(r2.media, 'jpn_hagaki_100x148mm');
  assert.equal(r2.scaling, 'fill');
  assert.equal(seen.length, 3);                                         // zero margin + fill, zero margin, then the name + fill
  console.log('✓ Passed: a photo asks for the zero-margin page first, then the paper name when the printer refuses it');
  sp.close();
  await assert.rejects(() => ippPrintDirect({ ip: '127.0.0.1', port: pp, jpeg, widthMm: 100, heightMm: 148 }), /did not answer/);
  console.log('✓ Passed: a printer that is off gives a clear message');
}
