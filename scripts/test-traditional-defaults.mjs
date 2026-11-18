import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const dir = mkdtempSync(join(tmpdir(), 'pb-blobs-test-'));
const server = new BlobsServer({ directory: dir, token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();

const { generateKeyPairSync } = await import('node:crypto');
const { privateKey } = generateKeyPairSync('ed25519');
process.env.PB_LICENSE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64');
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = 'y'.repeat(40);

const core = await import(url('netlify/lib/core.mjs'));
const licenseLib = await import(url('netlify/lib/license.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const licenseFn = (await import(url('netlify/functions/license.mjs'))).default;
const redeem = (await import(url('netlify/functions/redeem.mjs'))).default;

const ctx = { ip: '9.9.9.9' };
const post = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), ctx);
  return { status: r.status, ...(await r.json()) };
};

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : ''));
  if (!ok) fails++;
};

// Login
const login = await post(admin, { action: 'login', password: 'test-admin-pw' });
const T = login.token;
check('admin login', !!T);

// Test 1: Create a code without passing traditional or orientation (moving forward default)
const createRes = await post(admin, { action: 'create', days: 1, label: 'Tablet Client', folderName: 'Tablet Client', maxDevices: 1 }, T);
check('create code succeeds', createRes.status === 200 && createRes.created && createRes.created.length > 0);
const codeObj = createRes.created[0];
const storedRec = await core.licenses().get(codeObj.key, { type: 'json' });
check('new code has traditional: true by default', storedRec.traditional === true);
check('new code has orientation: either by default', storedRec.orientation === 'either');

// Test 2: Verify featuresOf on records with traditional: undefined / true and orientation: landscape / missing
const oldKey = core.normCode('PB-OLD1-TEST-1234');
const defaultRec = {
  key: oldKey,
  code: 'PB-OLD1-TEST-1234',
  orientation: 'landscape',
  print: { enabled: true, sizes: ['4x6'] }
};
const feat = licenseLib.featuresOf(defaultRec, 1);
check('featuresOf defaults traditional to true when omitted', feat.traditional === true);
check('featuresOf upgrades orientation from landscape to either', feat.orientation === 'either');

// Test 3: checkLicense on code with omitted traditional and landscape orientation
const oldDevRec = {
  ...defaultRec,
  status: 'active',
  offlineOpt: true,
  maxDevices: 2,
  expiresAt: Date.now() + 86400000,
  devices: [{ id: 'dev-1', no: 1, at: Date.now() }]
};
await core.licenses().setJSON(oldKey, oldDevRec);
const token = core.sign({ t: 'rental', k: oldKey, d: 'dev-1', exp: Date.now() + 86400000 });
const checkLic = await core.checkLicense(token, 'dev-1');
check('checkLicense returns traditional: true for code', checkLic.traditional === true);
check('checkLicense returns orientation: either for code', checkLic.orientation === 'either');

// Test 4: Activate an offline tablet and test checkin auto-upgrade
const actRes = await post(licenseFn, { action: 'activate', code: 'PB-OLD1-TEST-1234', mid: 'AND-TEST-1234-MID1', name: 'Client Tablet', os: 'android', ver: '1.0.9' });
check('offline tablet activation succeeds', actRes.ok === true && !!actRes.licence);
// Check that the returned signed licence payload has traditional: true and orientation: either
const payload = licenseLib.readLicence(actRes.licence);
check('licence payload has feat.traditional = true', payload && payload.feat && payload.feat.traditional === true);
check('licence payload has feat.orientation = either', payload && payload.feat && payload.feat.orientation === 'either');

// Verify that the record in DB was upgraded
const recAfterAct = await core.licenses().get(oldKey, { type: 'json' });
check('stored record traditional is now true', recAfterAct.traditional === true);
check('stored record orientation is now either', recAfterAct.orientation === 'either');

// Now simulate a tablet checking in later with checkin
const checkinRes = await post(licenseFn, { action: 'checkin', licence: actRes.licence, mid: 'AND-TEST-1234-MID1', ver: '1.0.9' });
check('checkin succeeds', checkinRes.ok === true && !!checkinRes.licence);
const checkinPayload = licenseLib.readLicence(checkinRes.licence);
check('checkin payload has feat.traditional = true', checkinPayload.feat.traditional === true);
check('checkin payload has feat.orientation = either', checkinPayload.feat.orientation === 'either');

// Test 5: Test upgradeallcodes action in admin
const oldUnmigrated = {
  key: 'unmigrated_key',
  code: 'PB-UNMG-TEST-5678',
  traditional: false,
  orientation: 'landscape',
  status: 'active'
};
await core.licenses().setJSON('unmigrated_key', oldUnmigrated);
const upgradeRes = await post(admin, { action: 'upgradeallcodes' }, T);
check('upgradeallcodes admin action succeeds', upgradeRes.ok === true);
const migratedRec = await core.licenses().get('unmigrated_key', { type: 'json' });
check('unmigrated record now has traditional: true', migratedRec.traditional === true);
check('unmigrated record now has orientation: either', migratedRec.orientation === 'either');

await server.stop();
if (fails > 0) {
  console.error(`\nFAILED with ${fails} errors.`);
  process.exit(1);
} else {
  console.log('\nALL TRADITIONAL & ORIENTATION CHECKS PASSED!');
  process.exit(0);
}
