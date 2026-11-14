// A tester / rental code upgraded to Lifetime ("makelifetime") must not lose the booth's Setup.
// Run from the repo root: node scripts/test-upgrade-setup.mjs   (uses a REAL local @netlify/blobs store)
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

const T = (await post(admin, { action: 'login', password: 'test-admin-pw' })).token;
const made = await post(admin, { action: 'create', days: 2, label: 'Tester One', folderName: 'Tester One', maxDevices: 2 }, T);
const code = made.created && made.created[0];
check('tester code created', !!code && !code.lifetime);

const dev = 'device-AAAAAAAA';
const r1 = await post(redeem, { code: code.code, deviceId: dev });
check('tester redeems', r1.ok === true && !!r1.token, r1.error);
const tok = r1.token;
const S = (body) => post(setup, { token: tok, deviceId: dev, ...body });

// Before the upgrade: the tester saves a design (no event names on rental codes)
const sv = await S({ action: 'save', settings: { layout: 'strip', theme: 'cafe-receipt' } });
check('setup saved before the upgrade', sv.ok === true);

// Upgrade in Admin
const up = await post(admin, { action: 'makelifetime', code: code.code }, T);
check('makelifetime ok', up.ok === true, up.error);

// Same device, new Lifetime token (the booth re-checks the code when the licence refreshes)
const r2 = await post(redeem, { code: code.code, deviceId: dev });
const tok2 = r2.token || tok;
const S2 = (body) => post(setup, { token: tok2, deviceId: dev, ...body });

const g0 = await S2({ action: 'get' });
check('no event name yet: the old design still loads', g0.ok === true && g0.settings && g0.settings.layout === 'strip' && g0.settings.theme === 'cafe-receipt', JSON.stringify(g0.settings));

const g1 = await S2({ action: 'get', event: 'Santos Wedding' });
check('a new event starts with nothing saved (the booth carries the on-screen design over)', g1.ok === true && g1.settings === null);

const s1 = await S2({ action: 'save', event: 'Santos Wedding', settings: { layout: 'grid' } });
check('event setup saves', s1.ok === true);
const g2 = await S2({ action: 'get', event: 'Santos Wedding' });
check('event setup loads its own design', g2.settings && g2.settings.layout === 'grid');
const g3 = await S2({ action: 'get', event: 'Other Event' });
check('another event is not polluted by it', g3.settings === null);

// Once the event-less scope has its own saved setup it wins over the old one
const s0 = await S2({ action: 'save', settings: { layout: 'single' } });
const g4 = await S2({ action: 'get' });
check('event-less setup saved after the upgrade wins', s0.ok === true && g4.settings && g4.settings.layout === 'single');

await server.stop();
console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
process.exit(fails ? 1 : 0);
