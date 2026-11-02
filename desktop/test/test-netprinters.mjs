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
