// End-to-end test of Shutdown mode against a local @netlify/blobs store and the real desktop licence code.
// Run from the repo root:  node scripts/test-shutdown-mode.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const server = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'pb-blobs-')), token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();
const { privateKey } = generateKeyPairSync('ed25519');

process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64');
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = 'y'.repeat(40);
process.env.PB_LICENSE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const core = await import(url('netlify/lib/core.mjs'));
const lic = await import(url('netlify/lib/license.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const license = (await import(url('netlify/functions/license.mjs'))).default;
const ctx = { ip: '9.9.9.9' };
const post = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), ctx);
  return { status: r.status, ...(await r.json()) };
};
const payload = (l) => JSON.parse(Buffer.from(l.split('.')[1], 'base64url').toString());
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

const T = (await post(admin, { action: 'login', password: 'test-admin-pw' })).token;

// An Online-only Lifetime code (no offline app), and an event code that has the offline app.
const onlineOnly = (await post(admin, { action: 'create', lifetime: true, label: 'Online Only', maxDevices: 5 }, T)).created[0];
const event = (await post(admin, { action: 'create', lifetime: false, days: 3, label: 'Event', maxDevices: 2, offlineOpt: true }, T)).created[0];
const MID1 = 'WIN-ABCD-EFGH-JKLM-NPQR';

// Before shutdown mode
check('shutdown starts OFF', (await post(admin, { action: 'shutdownget' }, T)).on === false);
const pre = await post(license, { action: 'activate', code: onlineOnly.code, mid: MID1, name: 'Laptop A', os: 'win', ver: '1.0.0' });
check('Online-only code cannot use the offline app yet', pre.status === 403 && pre.code === 'no-addon', pre.error);
const evAct = await post(license, { action: 'activate', code: event.code, mid: 'WIN-EVNT-EVNT-EVNT-EVNT', name: 'Event laptop', os: 'win', ver: '1.0.0' });
check('event code with offline app gets a normal licence', evAct.ok && payload(evAct.licence).feat.final === false && payload(evAct.licence).hard < core.FINAL_EXP);

// Turning it on needs the typed confirmation
const noConfirm = await post(admin, { action: 'shutdownset', on: true, confirm: 'yes' }, T);
check('shutdown mode refuses without END SERVICE', noConfirm.status === 400, noConfirm.error);
const on = await post(admin, { action: 'shutdownset', on: true, confirm: 'END SERVICE' }, T);
check('shutdown mode turns ON', on.ok && on.on === true);

// Server side
const act = await post(license, { action: 'activate', code: onlineOnly.code, mid: MID1, name: 'Laptop A', os: 'win', ver: '1.0.0' });
check('Online-only Lifetime code can now activate the offline app', act.ok === true, act.error);
const p = payload(act.licence);
check('licence is final: never asks to check in', p.chk === core.FINAL_EXP && p.hard === core.FINAL_EXP && p.exp === null && p.feat.final === true);
const chk = await post(license, { action: 'checkin', licence: act.licence, mid: MID1, ver: '1.0.0' });
check('check-in returns a final licence', chk.ok && payload(chk.licence).feat.final === true);
const evChk = await post(license, { action: 'checkin', licence: evAct.licence, mid: 'WIN-EVNT-EVNT-EVNT-EVNT', ver: '1.0.0' });
check('non-Lifetime code is not made final', evChk.ok && payload(evChk.licence).feat.final === false && payload(evChk.licence).exp !== null);
const key = await post(admin, { action: 'offlinekey', code: onlineOnly.code, mid: 'WIN-ZZZZ-ZZZZ-ZZZZ-ZZZZ', name: 'No-internet laptop' }, T);
check('Admin offline activation key works and is final', key.ok && payload(key.licence).feat.final === true, key.error);

// The real desktop app code accepts it and never asks for a check-in, even years later
const desk = await import(url('desktop/lib/licence.mjs'));
const dataDir = mkdtempSync(join(tmpdir(), 'pb-desktop-'));
desk.initLicence({ dataDir, pubKeyB64: lic.publicKeyInfo().spki, version: '1.0.0' });
const myKey = await post(admin, { action: 'offlinekey', code: onlineOnly.code, mid: desk.machineId(), name: 'This computer' }, T);
// (this machine's id is a 5th device slot: free one first if needed)
check('Admin makes a key for the test computer', myKey.ok === true, myKey.error);
const accepted = desk.activateOffline(myKey.licence);
check('desktop app accepts the final licence', accepted.ok === true, accepted.error);
let s = desk.status();
check('desktop status OK today, no renew warning', s.ok === true && !s.warn, JSON.stringify({ ok: s.ok, warn: s.warn }));
const realNow = Date.now;
for (const yrs of [1, 3, 10]) {
  Date.now = () => realNow() + yrs * 365 * 86400000;
  s = desk.status();
  check('desktop status OK ' + yrs + ' year(s) later with no check-in', s.ok === true && !s.warn, s.reason || '');
}
Date.now = realNow;
// A normal licence for comparison would have stopped by now
const normal = payload(evAct.licence);
check('a normal licence has a check-in deadline (for comparison)', normal.hard < realNow() + 120 * 86400000);

// Turning it off again
const off = await post(admin, { action: 'shutdownset', on: false }, T);
check('shutdown mode turns OFF', off.ok && off.on === false);
const after = await post(license, { action: 'checkin', licence: act.licence, mid: MID1, ver: '1.0.0' });
check('after OFF, an Online-only code is back to no offline app', after.ok === false && after.reason === 'no-addon');

await server.stop();
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
