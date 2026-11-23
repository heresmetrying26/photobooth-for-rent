// Free trial for the offline apps (Android / Windows / Mac): the trial password activates a
// short, device-bound licence that works offline. Run from the repo root: node scripts/test-offline-trial.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const dir = mkdtempSync(join(tmpdir(), 'pb-blobs-'));
const server = new BlobsServer({ directory: dir, token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();

process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64');
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = 'y'.repeat(40);
process.env.TRIAL_PASSWORD = 'FREETRIAL';
process.env.PB_LICENSE_KEY = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const lic = (await import(url('netlify/functions/license.mjs'))).default;
const { readLicence } = await import(url('netlify/lib/license.mjs'));
const core = await import(url('netlify/lib/core.mjs'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); } else console.log('ok   ' + m); };
const post = async (body) => {
  const r = await lic(new Request('http://x/api/license', { method: 'POST', body: JSON.stringify(body) }), { ip: '1.2.3.4' });
  return { status: r.status, j: await r.json() };
};
const mid = 'ABCD1234EFGH5678';

// 1. the trial password activates (any case), without a code record
let a = await post({ action: 'activate', code: 'freeTRIAL', mid, name: 'Test tablet', os: 'android', ver: '1.1.0' });
ok(a.status === 200 && a.j.ok && a.j.trial, 'trial password activates an app');
const licText = a.j.licence;
const p = readLicence(licText);
ok(p && p.typ === 'pb4u-desktop' && p.mid === mid, 'licence is signed and bound to this device');
ok(p.feat.trial === true && p.feat.watermark === true, 'licence is marked trial, with the watermark on by default');
ok(p.exp - p.iat === 15 * 60000, 'trial lasts the trial minutes (15 by default)');
ok(p.hard === p.exp && p.chk === p.exp && !p.lifetime, 'it never asks for a check-in, so it runs offline until it ends');
ok(p.feat.vouchers === true, 'vouchers / cash acceptor can be tried');

// 2. a wrong code is still refused
a = await post({ action: 'activate', code: 'NOT-A-CODE', mid, name: 'x', os: 'android', ver: '1' });
ok(a.status === 401, 'a wrong code is still refused');

// 3. check-in keeps the same licence until the end
const c = await post({ action: 'checkin', licence: (await post({ action: 'activate', code: 'FREETRIAL', mid, os: 'win', ver: '1' })).j.licence, mid, ver: '1' });
ok(c.status === 200 && c.j.ok && readLicence(c.j.licence).exp > Date.now(), 'check-in while online keeps the trial licence');

// 4. an ended trial is refused at check-in
const { signLicence } = await import(url('netlify/lib/license.mjs'));
const old = signLicence({ ...p, iat: Date.now() - 3600000, exp: Date.now() - 1000, chk: Date.now() - 1000, hard: Date.now() - 1000 });
const e = await post({ action: 'checkin', licence: old, mid, ver: '1' });
ok(e.j.revoked === true && e.j.reason === 'expired', 'an ended trial is refused at check-in');

// 5. another device cannot use this licence
const o = await post({ action: 'checkin', licence: licText, mid: 'ZZZZ9999YYYY8888', ver: '1' });
ok(o.status === 403, 'a licence is useless on another device');

// 6. trial switched off in Admin
const s = await core.getSettings();
await core.meta().setJSON('settings', { ...s, trialEnabled: false });
a = await post({ action: 'activate', code: 'FREETRIAL', mid, name: 'x', os: 'android', ver: '1' });
ok(a.status !== 200, 'with the trial switched off the password no longer activates');

await server.stop();
if (fails) { console.error(fails + ' check(s) failed'); process.exit(1); }
console.log('OK: offline trial');
process.exit(0);
