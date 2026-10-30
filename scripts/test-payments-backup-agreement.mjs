// Tests: Admin records the agreement on hand-made codes; refunded / failed payments flag the code (never disable
// it) and email the owner; the full backup, its weekly Drive save, the restore script and the offline
// "make final licence" script. Local blob store + fake Apps Script relay. Run from the repo root:
//   node scripts/test-payments-backup-agreement.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac, createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;
const SECRET = 'y'.repeat(40), WH_SECRET = 'whsec_test_secret_123';

// ---- fake relay: mail + backup tickets, checked like apps-script/upload.gs ----
const mails = [], backups = [];
const used = new Set();
const relay = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const data = JSON.parse(raw || '{}');
    const verify = (ticket) => {
      const [body, sig] = String(ticket || '').split('.');
      if (!sig || sig !== createHmac('sha256', SECRET).update(body).digest('base64url')) return null;
      const t = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (t.exp < Date.now() || used.has(sig)) return null;
      used.add(sig); return t;
    };
    if (data.mail) { const t = verify(data.mail); if (!t || t.m !== 'mail') return res.end(JSON.stringify({ ok: false, error: 'Email not allowed' })); mails.push({ to: t.to, subject: t.s, body: t.b }); return res.end(JSON.stringify({ ok: true })); }
    if (data.backup) {
      const t = verify(data.backup);
      if (!t || t.m !== 'backup' || !/^photobooth4u-backup-\d{4}-\d{2}-\d{2}(-[a-z]{1,12})?\.json$/.test(t.n)) return res.end(JSON.stringify({ ok: false, error: 'Backup not allowed (missing, used or expired ticket).' }));
      if (createHash('sha256').update(String(data.content), 'utf8').digest('hex') !== t.h) return res.end(JSON.stringify({ ok: false, error: 'Backup content did not match its ticket.' }));
      backups.push({ name: t.n, content: data.content });
      return res.end(JSON.stringify({ ok: true, name: t.n, kept: backups.length }));
    }
    res.end(JSON.stringify({ ok: false, error: 'Upload not allowed (missing or expired ticket).' }));
  });
});
await new Promise((r) => relay.listen(0, r));

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const mkServer = async () => { const s = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'pb-blobs-')), token: 'test-token', port: 0, logger: () => {} }); const { port } = await s.start(); return { s, ctx: Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64') }; };
const A = await mkServer();
const { privateKey } = generateKeyPairSync('ed25519');
const KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
process.env.NETLIFY_BLOBS_CONTEXT = A.ctx;
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = SECRET;
process.env.PB_LICENSE_KEY = KEY;
process.env.DRIVE_SCRIPT_URL = 'http://localhost:' + relay.address().port + '/exec';
process.env.ALERT_EMAIL = 'owner@example.test';
process.env.PAYMONGO_WEBHOOK_SECRET = WH_SECRET;

const core = await import(url('netlify/lib/core.mjs'));
const pay = await import(url('netlify/lib/pay.mjs'));
const lic = await import(url('netlify/lib/license.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const subhook = (await import(url('netlify/functions/subhook.mjs'))).default;
const license = (await import(url('netlify/functions/license.mjs'))).default;
const portal = (await import(url('netlify/functions/portal.mjs'))).default;
let ipn = 0;
const call = async (fn, body, token) => {
  const r = await fn(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), { ip: '10.1.0.' + (++ipn) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };
const T = (await call(admin, { action: 'login', password: 'test-admin-pw' })).token;
const mk = async (o) => (await call(admin, { action: 'create', maxDevices: 5, ...o }, T)).created[0];
const get = (key) => core.licenses().get(key, { type: 'json' });

// ===== 1. Hand-made Lifetime codes: agreement recording =====
const withAgr = await mk({ lifetime: true, label: 'Messenger buyer', agreementAccepted: true, offlineOpt: true });
let rec = await get(withAgr.key);
check('Admin create: ticking the agreement records it', rec.agreement && rec.agreement.version === core.AGREEMENT_VERSION && rec.agreement.by === 'admin');
check('...and that turns on the swap limit', core.swapsLimited(rec) === true);
const without = await mk({ lifetime: true, label: 'No agreement yet' });
rec = await get(without.key);
check('Admin create: unticked = nothing recorded', !rec.agreement && core.swapsLimited(rec) === false);
let r = await call(admin, { action: 'setagreement', code: without.code }, T);
rec = await get(without.key);
check('Record agreement later works', r.ok && rec.agreement && core.swapsLimited(rec) === true);
const monthly = await mk({ lifetime: false, days: 3, label: 'Monthly', agreementAccepted: true });
check('A non-Lifetime code never gets an agreement', !(await get(monthly.key)).agreement);
r = await call(admin, { action: 'setagreement', code: monthly.code }, T);
check('Record agreement refuses a non-Lifetime code', r.status === 400);

// ===== 2. Refunded / failed payments =====
const PI = 'pi_test_123456', PAYID = 'pay_test_987654';
const paid = await mk({ lifetime: true, label: 'Paid buyer', email: 'paid@example.com', agreementAccepted: true });
await pay.payStore().setJSON('sub/' + PI, { id: PI, plan: 'lifetime', amount: 4999, name: 'Paid buyer', email: 'paid@example.com', status: 'paid', code: paid.code, paidAt: Date.now() });
const sendHook = async (event, secret = WH_SECRET, live = false) => {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
  const r = await subhook(new Request('http://x/api/subscribe/hook', { method: 'POST', headers: { 'paymongo-signature': 't=' + t + ',te=' + (live ? '' : sig) + ',li=' + (live ? sig : '') }, body: raw }));
  return { status: r.status, text: await r.text() };
};
const ev = (id, type, resource) => ({ data: { id, type: 'event', attributes: { type, livemode: false, data: resource } } });
const payment = { id: PAYID, type: 'payment', attributes: { payment_intent_id: PI, amount: 499900 } };

let before = mails.length;
let h = await sendHook(ev('evt_1', 'payment.refunded', payment), 'wrong-secret');
check('webhook with a wrong signature is refused', h.status === 401 && !(await get(paid.key)).paymentReview);
h = await sendHook(ev('evt_1', 'payment.refunded', payment));
rec = await get(paid.key);
check('refund event flags the code', h.status === 200 && rec.paymentReview && rec.paymentReview.reason === 'refunded' && rec.paymentReview.orderId === PI);
check('...but does NOT disable it', rec.status !== 'revoked');
check('owner got an email naming the code', mails.length === before + 1 && mails[mails.length - 1].subject.includes('REFUNDED') && mails[mails.length - 1].subject.includes(paid.code) && /Nothing was disabled/.test(mails[mails.length - 1].body));
before = mails.length;
await sendHook(ev('evt_1', 'payment.refunded', payment));
check('same event delivered twice: no second email', mails.length === before);
const list = await call(admin, { action: 'list' }, T);
const row = (list.rows || list.list || []).find((x) => x.code === paid.code);
check('Admin list shows the flag', !!(row && row.paymentReview && row.paymentReview.reason === 'refunded'), JSON.stringify(row && row.paymentReview));
r = await call(admin, { action: 'clearpaymentflag', code: paid.code }, T);
check('Clear payment flag works', r.ok && !(await get(paid.key)).paymentReview);

// refund.updated carries only a payment id: not resolvable without PayMongo, so it must be ignored safely
before = mails.length;
h = await sendHook(ev('evt_2', 'payment.refund.updated', { id: 'ref_1', type: 'refund', attributes: { payment_id: PAYID, status: 'succeeded' } }));
check('refund.updated without a known payment is ignored safely', h.status === 200 && mails.length === before);
// a refund event that did not succeed is not a reversal
h = await sendHook(ev('evt_3', 'payment.refund.updated', { id: 'ref_2', type: 'refund', attributes: { payment_intent_id: PI, payment_id: PAYID, status: 'failed' } }));
check('a failed refund is not flagged', !(await get(paid.key)).paymentReview);
h = await sendHook(ev('evt_4', 'payment.refund.updated', { id: 'ref_3', type: 'refund', attributes: { payment_intent_id: PI, payment_id: PAYID, status: 'succeeded' } }));
check('a succeeded refund (with the intent id) is flagged', (await get(paid.key)).paymentReview && (await get(paid.key)).paymentReview.reason === 'refunded');
await call(admin, { action: 'clearpaymentflag', code: paid.code }, T);
// an order that was never paid, or an unknown payment, is ignored
await pay.payStore().setJSON('sub/pi_unpaid', { id: 'pi_unpaid', plan: 'lifetime', amount: 4999, status: 'pending' });
before = mails.length;
await sendHook(ev('evt_5', 'payment.refunded', { id: 'pay_x', type: 'payment', attributes: { payment_intent_id: 'pi_unpaid', amount: 1 } }));
await sendHook(ev('evt_6', 'payment.refunded', { id: 'pay_y', type: 'payment', attributes: { payment_intent_id: 'pi_nobody', amount: 1 } }));
check('unpaid or unknown orders are ignored', mails.length === before);
await sendHook(ev('evt_7', 'payment.paid', payment));
check('other event types are ignored', !(await get(paid.key)).paymentReview);
h = await sendHook(ev('evt_8', 'payment.failed', payment));
check('failed-after-paid is flagged as failed', (await get(paid.key)).paymentReview && (await get(paid.key)).paymentReview.reason === 'failed');
r = await call(admin, { action: 'revoke', code: paid.code, reason: 'payment' }, T);
check('Disable accepts the reason "payment"', r.ok && (await get(paid.key)).revokeReason === 'payment');
r = await call(admin, { action: 'subhookstatus' }, T);
check('payment alerts status says ON (secret set)', r.ok && r.set === true);

// ===== 3. Backup, restore, final licences =====
const dev = await call(license, { action: 'activate', code: withAgr.code, mid: 'WIN-ABCD-EFGH-JKLM-NPQR', name: 'Booth laptop', os: 'win', ver: '1.0.0' });
check('(setup) an Offline App laptop is activated on a code', dev.ok === true, dev.error);
await core.eventsStore().setJSON(withAgr.key, { events: [{ id: 'e1', name: 'Santos Wedding', folderUrl: 'https://drive.google.com/drive/folders/ABCDEFGHIJ1234567890' }] });
await core.meta().setJSON('settings', { trialEnabled: true, trialPassword: 'SECRETTRIAL', paymongoSecretKey: 'sk_live_donotleak', qrTarget: 'gallery' });

const dl = await call(admin, { action: 'backupdownload' }, T);
const backup = JSON.parse(dl.content);
check('Admin backup download contains every code', dl.ok && Object.keys(backup.licenses).length >= 4 && backup.licenses[withAgr.key].agreement && dl.name.endsWith('-manual.json'));
check('backup has the events list and the Offline App activation', backup.events[withAgr.key].events.length === 1 && Object.keys(backup.applic).length === 1);
check('backup leaves out keys, secrets and passwords', backup.settings.qrTarget === 'gallery' && !('paymongoSecretKey' in backup.settings) && !('trialPassword' in backup.settings) && !/sk_live_donotleak|SECRETTRIAL/.test(dl.content));

const drive = await call(admin, { action: 'backupdrive' }, T);
check('Back up now saves to the (fake) Drive relay', drive.ok === true && backups.length === 1 && /^photobooth4u-backup-\d{4}-\d{2}-\d{2}-manual\.json$/.test(backups[0].name), drive.error);
check('what Drive received is the same backup', JSON.parse(backups[0].content).licenses[withAgr.key].label === 'Messenger buyer');
const st = await call(admin, { action: 'backupstatus' }, T);
check('Admin shows the last backup', st.last && st.last.ok === true && st.last.codes >= 4);
const weekly = (await import(url('netlify/functions/backup.mjs')));
await weekly.default();
check('the weekly scheduled function runs and saves too', backups.length === 2 && /-weekly\.json$/.test(backups[1].name) && weekly.config.schedule === '@weekly');
// an old relay (script not redeployed yet) gives a clear message
const backupLib = await import(url('netlify/lib/backup.mjs'));
let msg = '';
const realFetch = globalThis.fetch;
try { globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'Upload not allowed (missing or expired ticket).' })); await backupLib.sendBackupToDrive('photobooth4u-backup-2026-01-01.json', '{}'); } catch (e) { msg = e.message; }
globalThis.fetch = realFetch;
check('an old relay gives a clear "update upload.gs" message', /upload\.gs/.test(msg), msg);

// restore into a SECOND, empty store
const B = await mkServer();
const file = join(mkdtempSync(join(tmpdir(), 'pb-bk-')), 'backup.json');
writeFileSync(file, dl.content);
// Async on purpose: the blob store runs in THIS process, so a blocking spawnSync would freeze it.
const run = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(repo, 'scripts', args[0]), ...args.slice(1)], { cwd: repo, env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
let out = await run(['restore-backup.mjs', '--file', file, '--dry-run'], { NETLIFY_BLOBS_CONTEXT: B.ctx });
check('restore --dry-run reads the backup and writes nothing', out.status === 0 && /Dry run: nothing written/.test(out.stdout), out.stdout + out.stderr);
out = await run(['restore-backup.mjs', '--file', file], { NETLIFY_BLOBS_CONTEXT: B.ctx });
check('restore writes the codes into the empty store', out.status === 0 && /Restored \d+ codes/.test(out.stdout), 'status=' + out.status + ' ' + out.stdout + out.stderr);
process.env.NETLIFY_BLOBS_CONTEXT = B.ctx;
const coreB = await import(url('netlify/lib/core.mjs') + '?b');
const restored = await coreB.licenses().get(withAgr.key, { type: 'json' });
check('restored code matches the original (agreement, devices, label)', restored && restored.label === 'Messenger buyer' && restored.agreement && (restored.devices || []).length === 1);
check('restored events list and activation map are back', !!(await coreB.eventsStore().get(withAgr.key, { type: 'json' })) && Object.keys(backup.applic).length === 1 && !!(await coreB.meta().get(Object.keys(backup.applic)[0], { type: 'json' })));
process.env.NETLIFY_BLOBS_CONTEXT = A.ctx;
out = await run(['restore-backup.mjs', '--file', join(tmpdir(), 'nope.json')], { NETLIFY_BLOBS_CONTEXT: B.ctx });
check('restore with a bad file fails cleanly', out.status !== 0);

// make final licences from the backup file only (no server, no blob store)
out = await run(['make-final-licence.mjs', '--backup', file, '--code', withAgr.code], { PB_LICENSE_KEY: KEY, NETLIFY_BLOBS_CONTEXT: '' });
const licText = (out.stdout.match(/PB4U-LIC1\.[A-Za-z0-9_.-]+/) || [])[0];
check('make-final-licence prints a licence for the activated laptop', out.status === 0 && !!licText, out.stdout + out.stderr);
const p = licText && lic.readLicence(licText);
check('...it verifies, is final and belongs to that laptop', p && p.feat.final === true && p.mid === 'WIN-ABCD-EFGH-JKLM-NPQR' && p.chk === core.FINAL_EXP && p.hard === core.FINAL_EXP && p.exp === null);
out = await run(['make-final-licence.mjs', '--backup', file, '--code', withAgr.code, '--mid', 'MAC-ZZZZ-YYYY-XXXX-WWWW'], { PB_LICENSE_KEY: KEY, NETLIFY_BLOBS_CONTEXT: '' });
const lic2 = (out.stdout.match(/PB4U-LIC1\.[A-Za-z0-9_.-]+/) || [])[0];
const p2 = lic2 && lic.readLicence(lic2);
check('--mid makes a licence for a new machine (macOS)', p2 && p2.mid === 'MAC-ZZZZ-YYYY-XXXX-WWWW' && p2.os === 'mac' && p2.feat.final === true);
out = await run(['make-final-licence.mjs', '--backup', file, '--code', paid.code], { PB_LICENSE_KEY: KEY });
check('a disabled code gets no licence', out.status !== 0 && /disabled/.test(out.stderr));
out = await run(['make-final-licence.mjs', '--backup', file, '--code', monthly.code], { PB_LICENSE_KEY: KEY });
check('a non-Lifetime code gets no licence', out.status !== 0 && /not a Lifetime/.test(out.stderr));
out = await run(['make-final-licence.mjs', '--backup', file, '--code', withAgr.code], { PB_LICENSE_KEY: '' });
check('no signing key: clear message, no licence', out.status !== 0 && /PB_LICENSE_KEY/.test(out.stderr));

await A.s.stop(); await B.s.stop(); relay.close();
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
