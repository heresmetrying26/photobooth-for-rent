// Admin "Upgrade to monthly / yearly" (action: upgrade). Run from the repo root: node scripts/test-upgrade-plan.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const core = await import(url('netlify/lib/core.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const redeem = (await import(url('netlify/functions/redeem.mjs'))).default;
const setup = (await import(url('netlify/functions/setup.mjs'))).default;
const ctx = { ip: '9.9.9.9' };
const post = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), ctx);
  return { status: r.status, ...(await r.json()) };
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const DAY = 86400000;

const T = (await post(admin, { action: 'login', password: 'test-admin-pw' })).token;
const mk = async (label, days) => (await post(admin, { action: 'create', days, label, folderName: label, maxDevices: 2 }, T)).created[0];

// 1. A 3-day tester that has ALREADY ended, upgraded to monthly: 30 days from today, setup untouched
const a = await mk('Tester Ended', 3);
const dev = 'device-AAAAAAAA';
const r1 = await post(redeem, { code: a.code, deviceId: dev });
check('tester redeems', r1.ok === true && !!r1.token);
const S = (body) => post(setup, { token: r1.token, deviceId: dev, ...body });
check('setup saved', (await S({ action: 'save', settings: { layout: 'strip' } })).ok === true);
let rec = await core.licenses().get(a.key, { type: 'json' });
rec.expiresAt = Date.now() - 2 * DAY;                 // the 3 days are up
await core.putLicense(core.licenses(), a.key, rec);
const blocked = await post(redeem, { code: a.code, deviceId: dev });
check('ended tester is locked out', blocked.ok !== true, blocked.error || blocked.reason);

const up = await post(admin, { action: 'upgrade', code: a.code, plan: 'monthly' }, T);
check('upgrade monthly ok', up.ok === true && up.plan === 'monthly', up.error);
rec = await core.licenses().get(a.key, { type: 'json' });
const left = (rec.expiresAt - Date.now()) / DAY;
check('30 days counted from today, not from the old end date', left > 29.9 && left < 30.1, left.toFixed(2) + ' days left');
check('upgrade is recorded for the handout', rec.upgrade && rec.upgrade.plan === 'monthly' && rec.upgrade.days === 30);
check('same device works again with the same code', (await post(redeem, { code: a.code, deviceId: dev })).ok === true);
const g = await S({ action: 'get' });
check('saved setup is still there', g.ok === true && g.settings && g.settings.layout === 'strip');

// 2. Still running (1 day left) → yearly adds 365 on top of what is left
const b = await mk('Tester Running', 3);
await post(redeem, { code: b.code, deviceId: 'device-BBBBBBBB' });
let rb = await core.licenses().get(b.key, { type: 'json' });
rb.expiresAt = Date.now() + DAY;
await core.putLicense(core.licenses(), b.key, rb);
const upb = await post(admin, { action: 'upgrade', code: b.code, plan: 'yearly' }, T);
rb = await core.licenses().get(b.key, { type: 'json' });
const leftB = (rb.expiresAt - Date.now()) / DAY;
check('yearly adds 365 days to the time left', upb.ok === true && leftB > 365.9 && leftB < 366.1, leftB.toFixed(2));
check('response carries the new end date', upb.expiresAt === rb.expiresAt);

// 3. Not used yet: the days are added to its length
const c = await mk('Tester Unused', 3);
const upc = await post(admin, { action: 'upgrade', code: c.code, plan: 'monthly' }, T);
const rc = await core.licenses().get(c.key, { type: 'json' });
check('unused code: 3 + 30 days, still unused', upc.ok === true && rc.days === 33 && rc.status === 'unused');

// 4. Refused cases
check('bad plan refused', (await post(admin, { action: 'upgrade', code: a.code, plan: 'weekly' }, T)).status === 400);
const lf = (await post(admin, { action: 'create', lifetime: true, label: 'Life', folderName: 'Life', maxDevices: 1 }, T)).created[0];
check('lifetime code refused', (await post(admin, { action: 'upgrade', code: lf.code, plan: 'monthly' }, T)).status === 400);
await post(admin, { action: 'revoke', code: c.code, reason: 'other' }, T);
check('disabled code refused', (await post(admin, { action: 'upgrade', code: c.code, plan: 'monthly' }, T)).status === 400);
check('unknown code refused', (await post(admin, { action: 'upgrade', code: 'NOPE-NOPE-NOPE', plan: 'monthly' }, T)).status >= 400);
check('needs admin login', (await post(admin, { action: 'upgrade', code: a.code, plan: 'monthly' })).status === 401);

await server.stop();
console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
