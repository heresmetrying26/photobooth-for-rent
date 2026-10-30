// Tests: (1) the email on a Lifetime code can't be changed by the renter, (2) the owner gets an email when a
// Lifetime renter frees a device slot, and nothing is blocked or suspended. Uses a local blob store and a fake
// Apps Script mail relay. Run from the repo root:  node scripts/test-email-lock-and-alerts.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;
const OWNER = 'owner@example.test';

// ---- fake mail relay: records every mail ticket it is given ----
const mails = [];
let relayMode = 'ok';
const relay = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const data = JSON.parse(raw || '{}');
    if (relayMode === 'fail' || !data.mail) return res.end(JSON.stringify({ ok: false, error: 'relay down' }));
    const t = JSON.parse(Buffer.from(String(data.mail).split('.')[0], 'base64url').toString());
    mails.push({ to: t.to, subject: t.s, body: t.b });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => relay.listen(0, r));

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const server = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'pb-blobs-')), token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();
const { privateKey } = generateKeyPairSync('ed25519');
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64');
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = 'y'.repeat(40);
process.env.PB_LICENSE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
process.env.DRIVE_SCRIPT_URL = 'http://localhost:' + relay.address().port + '/exec';
process.env.ALERT_EMAIL = OWNER;

const core = await import(url('netlify/lib/core.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const portal = (await import(url('netlify/functions/portal.mjs'))).default;
const redeem = (await import(url('netlify/functions/redeem.mjs'))).default;
const license = (await import(url('netlify/functions/license.mjs'))).default;
let ipn = 0;
const call = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), { ip: '10.0.0.' + (++ipn) });
  return { status: r.status, ...(await r.json()) };
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

const T = (await call(admin, { action: 'login', password: 'test-admin-pw' })).token;
const mk = async (o) => (await call(admin, { action: 'create', maxDevices: 5, ...o }, T)).created[0];
const DAY = 86400000;

// ===== 1. Email lock =====
const lt = await mk({ lifetime: true, label: 'Maria', email: 'maria@example.com' });
let rec = await core.licenses().get(lt.key, { type: 'json' });
rec.agreement = { version: '3.2' }; await core.putLicense(core.licenses(), lt.key, rec);

const tryEmail = (code, email, name = 'Maria') => call(portal, { code, action: 'account.save', name, email });
let r = await tryEmail(lt.code, 'someone.else@example.com');
check('Lifetime: changing the email is refused', r.status === 403 && r.code === 'email-locked', r.error);
r = await tryEmail(lt.code, '');
check('Lifetime: clearing the email is refused', r.status === 403 && r.code === 'email-locked');
r = await tryEmail(lt.code, 'MARIA@example.com', 'Maria Santos');
check('Lifetime: saving the same email with a new name works', r.ok === true && r.label === 'Maria Santos' && r.email === 'maria@example.com', r.error);
rec = await core.licenses().get(lt.key, { type: 'json' });
check('Lifetime: the email on file did not change', rec.email === 'maria@example.com');
const view = await call(portal, { code: lt.code });
check('My Events data says the email is locked', view.ok && view.emailLocked === true);

const oldLt = await mk({ lifetime: true, label: 'Older buyer', email: 'old@example.com' });    // no agreement on it
r = await tryEmail(oldLt.code, 'new@example.com', 'Older buyer');
check('Older Lifetime code (no agreement) is locked too', r.status === 403 && r.code === 'email-locked');

const noEmail = await mk({ lifetime: true, label: 'No email yet' });
r = await tryEmail(noEmail.code, 'first@example.com', 'No email yet');
check('Lifetime code with no email can add its first one', r.ok === true && r.email === 'first@example.com', r.error);
r = await tryEmail(noEmail.code, 'second@example.com', 'No email yet');
check('...and then it is locked', r.status === 403 && r.code === 'email-locked');

const monthly = await mk({ lifetime: false, days: 3, label: 'Rental', email: 'rent@example.com' });
r = await tryEmail(monthly.code, 'rent2@example.com', 'Rental');
check('Non-Lifetime codes are not affected', r.ok === true && r.email === 'rent2@example.com', r.error);

r = await call(admin, { action: 'setemail', code: lt.code, email: 'fixed@example.com' }, T);
rec = await core.licenses().get(lt.key, { type: 'json' });
check('Admin can still change a Lifetime email (typo fix)', r.ok === true && rec.email === 'fixed@example.com');
r = await call(admin, { action: 'transfer', code: lt.code, email: 'newowner@example.com' }, T);
check('Admin Transfer code still works', r.ok === true);

// ===== 2. Device freed alerts =====
const seed = async (code, key, devs) => { const x = await core.licenses().get(key, { type: 'json' }); x.status = 'active'; x.redeemedAt = Date.now(); x.expiresAt = x.lifetime ? core.LIFETIME_EXP : Date.now() + 5 * DAY; core.setDevices(x, devs); await core.putLicense(core.licenses(), key, x); return x; };
const devs = () => [{ id: 'dev-iPad-1', no: 1, kind: 'iPad', at: Date.now() - 3 * DAY, seen: Date.now() - 1 * DAY }, { id: 'dev-Win-2', no: 2, kind: 'Windows computer', at: Date.now() - 2 * DAY, seen: Date.now() - 2 * DAY }];

const a = await mk({ lifetime: true, label: 'Alert Renter', email: 'alert@example.com' });
await seed(a.code, a.key, devs());
let before = mails.length;
r = await call(portal, { code: a.code, action: 'device.remove', no: 1 });
check('device.remove still succeeds', r.ok === true, r.error);
check('owner got exactly one email', mails.length === before + 1 && mails[mails.length - 1].to === OWNER);
const m1 = mails[mails.length - 1];
check('email names the code, renter and what happened', m1.subject.includes(a.code) && m1.body.includes('Alert Renter') && m1.body.includes('removed it on My Events') && m1.body.includes('iPad'), m1.subject);
check('email says nothing was suspended', /Nothing was suspended or blocked/.test(m1.body));
rec = await core.licenses().get(a.key, { type: 'json' });
check('the code is NOT suspended and keeps working', rec.status === 'active' && core.devicesOf(rec).length === 1);
r = await call(portal, { code: a.code });
check('renter can still sign in afterwards', r.ok === true);

// owner relay broken: the renter's action must still work
relayMode = 'fail';
before = mails.length;
r = await call(portal, { code: a.code, action: 'device.remove', no: 2 });
check('mail relay down: device.remove still succeeds, no email', r.ok === true && mails.length === before, r.error);
relayMode = 'ok';

// not a Lifetime code: no alert
const rent = await mk({ lifetime: false, days: 5, label: 'Plain rental', maxDevices: 2 });
await seed(rent.code, rent.key, devs());
before = mails.length;
r = await call(portal, { code: rent.code, action: 'device.remove', no: 1 });
check('non-Lifetime code: no alert email', r.ok === true && mails.length === before);

// ALERT_EMAIL not set: no alert, action works
const b2 = await mk({ lifetime: true, label: 'No alert address', email: 'b2@example.com' });
await seed(b2.code, b2.key, devs());
delete process.env.ALERT_EMAIL;
before = mails.length;
r = await call(portal, { code: b2.code, action: 'device.remove', no: 1 });
check('ALERT_EMAIL not set: action works, no email', r.ok === true && mails.length === before);
process.env.ALERT_EMAIL = OWNER;

// Offline App deactivate
const MID = 'WIN-ABCD-EFGH-JKLM-NPQR';
const off = await mk({ lifetime: true, label: 'Offline Renter', email: 'off@example.com', offlineOpt: true });
const act = await call(license, { action: 'activate', code: off.code, mid: MID, name: 'Booth laptop', os: 'win', ver: '1.0.0' });
check('offline app activates', act.ok === true, act.error);
before = mails.length;
const deact = await call(license, { action: 'deactivate', licence: act.licence, mid: MID });
check('offline app deactivate works', deact.ok === true);
check('owner got an email for the Offline App deactivation', mails.length === before + 1 && /deactivated it in the Offline App/.test(mails[mails.length - 1].body) && /Booth laptop/.test(mails[mails.length - 1].body));

// Automatic slot takeover (device unused 7+ days)
const st = await mk({ lifetime: true, label: 'Stale Renter', email: 'stale@example.com', maxDevices: 1 });
await seed(st.code, st.key, [{ id: 'dev-old-ipad', no: 1, kind: 'iPad', at: Date.now() - 30 * DAY, seen: Date.now() - 9 * DAY }]);
before = mails.length;
const take = await call(redeem, { code: st.code, deviceId: 'dev-brand-new-1' });
check('new device takes over the stale slot', take.ok === true, take.error);
check('owner got an email for the automatic replacement', mails.length === before + 1 && /replaced automatically/.test(mails[mails.length - 1].body) && /unused for 7\+ days/.test(mails[mails.length - 1].body));
rec = await core.licenses().get(st.key, { type: 'json' });
check('code still active after takeover', rec.status === 'active');

await server.stop();
relay.close();
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
