// End-to-end test of Admin "Replace code" against a REAL @netlify/blobs store (local BlobsServer on a temp dir).
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2] || process.cwd();   // run from the repo root: node scripts/test-replace-code.mjs
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
const ctx = { ip: '9.9.9.9' };
const post = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), ctx);
  return { status: r.status, ...(await r.json()) };
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

const login = await post(admin, { action: 'login', password: 'test-admin-pw' });
const T = login.token;
check('admin login', !!T);

// 1. A lifetime code with an email, used on one device
const made = await post(admin, { action: 'create', lifetime: true, label: 'Test Renter', folderName: 'Test Renter', maxDevices: 5, email: 'renter@example.com', traditional: true, printEnabled: true, printSizes: ['4x6'] }, T);
const old = made.created && made.created[0];
check('created lifetime code', !!old, old && old.code);
const oldKey = old.key;
const r1 = await post(redeem, { code: old.code, deviceId: 'device-AAAAAAAA' });
check('old code redeems on a device', r1.ok === true);
// mark it as bought under the agreement, with guest payments on
const rec = await core.licenses().get(oldKey, { type: 'json' });
rec.agreement = { version: '3.2', acceptedAt: Date.now() }; rec.payOpt = true; rec.freed = [Date.now()];
await core.putLicense(core.licenses(), oldKey, rec);

// 2. Seed what a real renter would have: events, setups per event, logo, theme, PIN
await core.eventsStore().setJSON(oldKey, { events: [{ id: 'e1', name: 'Santos Wedding', folderKey: 'Test Renter · Santos Wedding', folderUrl: 'https://drive.google.com/drive/folders/abc', firstAt: 1, sessions: 3 }] });
const S = core.setupsStore();
const evId = core.setupKeyFor(oldKey + '|santos wedding');
await S.setJSON(evId, { settings: { layout: 'strip' }, updatedAt: 5, hasImage: true });
await S.set(evId + '_img', 'data:image/png;base64,iVBORw0KGgo=');
await S.setJSON(core.setupKeyFor(oldKey + '|_'), { settings: { layout: 'default' }, updatedAt: 6, hasImage: false });
const own = core.setupKeyFor('own|' + oldKey);
await S.set(own + '_a_logo12345', 'data:image/png;base64,LOGOLOGO');
await S.setJSON(own + '_pin', { h: 'a'.repeat(64), at: 7 });
await S.setJSON(own + '_themes', { themes: [{ id: 't1' }], updatedAt: 8 });

// 3. Replace it through the real Admin endpoint
const rep = await post(admin, { action: 'replacecode', code: old.code, reason: 'leak' }, T);
check('replacecode ok', rep.ok === true, JSON.stringify({ code: rep.code, copied: rep.copied, pay: rep.paymentsNeedReconnect }));
const newKey = rep.key;
const nw = await core.licenses().get(newKey, { type: 'json' });
const od = await core.licenses().get(oldKey, { type: 'json' });
check('old code disabled with reason', od.status === 'revoked' && od.revokeReason === 'leak' && od.replacedBy === newKey);
check('old email moved off the old code', od.email === null && od.emailWas === 'renter@example.com');
check('new code keeps email, folder, agreement, swap log', nw.email === 'renter@example.com' && nw.folderName === od.folderName && !!nw.agreement && (nw.freed || []).length === 1);
check('new code has no devices and is lifetime', (nw.devices || []).length === 0 && nw.lifetime === true && nw.status === 'active');

// 4. Data really copied in the real store
const ev2 = await core.eventsStore().get(newKey, { type: 'json' });
check('events list copied', ev2 && ev2.events.length === 1 && ev2.events[0].name === 'Santos Wedding');
const evId2 = core.setupKeyFor(newKey + '|santos wedding');
const su = await S.get(evId2, { type: 'json' });
check('event setup copied', su && su.settings.layout === 'strip' && su.hasImage === true);
check('event backdrop image copied', (await S.get(evId2 + '_img')) === 'data:image/png;base64,iVBORw0KGgo=');
const def = await S.get(core.setupKeyFor(newKey + '|_'), { type: 'json' });
check('default setup copied', def && def.settings.layout === 'default');
const own2 = core.setupKeyFor('own|' + newKey);
check('logo copied', (await S.get(own2 + '_a_logo12345')) === 'data:image/png;base64,LOGOLOGO');
const pin = await S.get(own2 + '_pin', { type: 'json' });
check('lock PIN copied', pin && pin.h === 'a'.repeat(64));
const th = await S.get(own2 + '_themes', { type: 'json' });
check('themes copied', th && th.themes.length === 1);
check('old data left in place', !!(await S.get(evId, { type: 'json' })));

// 5. Behaviour from the renter's side
const oldTry = await post(redeem, { code: old.code, deviceId: 'device-AAAAAAAA' });
check('old code is refused', oldTry.status === 403, oldTry.error);
const newTry = await post(redeem, { code: rep.code, deviceId: 'device-BBBBBBBB' });
check('new code works on a device', newTry.ok === true);
const again = await post(admin, { action: 'replacecode', code: old.code, reason: 'leak' }, T);
check('replacing the old code again is refused', again.status === 409, again.error);
const restore = await post(admin, { action: 'restore', code: old.code }, T);
check('replaced code cannot be restored', restore.status === 400, restore.error);

// 6. Disable with a reason
const made2 = await post(admin, { action: 'create', lifetime: true, label: 'Other', maxDevices: 5 }, T);
const dis = await post(admin, { action: 'revoke', code: made2.created[0].code, reason: 'sharing' }, T);
const o2 = await core.licenses().get(made2.created[0].key, { type: 'json' });
check('disable stores the reason', dis.ok && o2.revokeReason === 'sharing' && !!o2.revokedAt);
const bad = await post(admin, { action: 'revoke', code: made2.created[0].code, reason: 'nonsense' }, T);
check('unknown reason falls back to other', (await core.licenses().get(made2.created[0].key, { type: 'json' })).revokeReason === 'other');

await server.stop();
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
