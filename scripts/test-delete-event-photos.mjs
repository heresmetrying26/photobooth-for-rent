// Test of Admin "Delete event photos": the Netlify side against a local blob store and a fake Apps Script relay
// that checks tickets the same way apps-script/upload.gs does. Run from the repo root:
//   node scripts/test-delete-event-photos.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const repo = process.argv[2] || process.cwd();
const url = (p) => pathToFileURL(join(repo, p)).href;
const SECRET = 'y'.repeat(40);

// ---- fake relay: same ticket rules as upload.gs verifyTrashTicket_ / trashEventFolder_ ----
const trashed = new Set(), usedTickets = new Set();
let relayMode = 'new';                         // 'old' = a relay without the trash code
const ROOT = 'ROOTFOLDERIDROOTFOLDERID';
const relay = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const out = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const data = JSON.parse(raw || '{}');
    if (relayMode === 'old' || !data.trash) return out({ ok: false, error: 'Upload not allowed (missing or expired ticket). Reload the booth and try again.' });
    const [body, sig] = String(data.trash).split('.');
    const good = createHmac('sha256', SECRET).update(body).digest('base64url');
    if (!sig || sig !== good) return out({ ok: false, error: 'Delete not allowed (missing, used or expired ticket).' });
    const t = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (t.m !== 'trash' || t.f || !/^[A-Za-z0-9_-]{10,80}$/.test(t.id) || t.exp < Date.now()) return out({ ok: false, error: 'Delete not allowed (missing, used or expired ticket).' });
    if (usedTickets.has(sig)) return out({ ok: false, error: 'Delete not allowed (missing, used or expired ticket).' });
    usedTickets.add(sig);
    if (t.id === ROOT) return out({ ok: false, error: 'not-allowed' });
    if (trashed.has(t.id)) return out({ ok: true, already: true });
    trashed.add(t.id);
    out({ ok: true });
  });
});
await new Promise((r) => relay.listen(0, r));

const { BlobsServer } = await import(url('node_modules/@netlify/blobs/dist/server.js'));
const server = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'pb-blobs-')), token: 'test-token', port: 0, logger: () => {} });
const { port } = await server.start();
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: 'http://localhost:' + port, uncachedEdgeURL: 'http://localhost:' + port, token: 'test-token', siteID: 'test-site' })).toString('base64');
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TOKEN_SECRET = 'x'.repeat(40);
process.env.UPLOAD_SECRET = SECRET;
process.env.DRIVE_SCRIPT_URL = 'http://localhost:' + relay.address().port + '/exec';

const core = await import(url('netlify/lib/core.mjs'));
const admin = (await import(url('netlify/functions/admin.mjs'))).default;
const ctx = { ip: '9.9.9.9' };
const post = async (body, token) => {
  const r = await admin(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }), ctx);
  return { status: r.status, ...(await r.json()) };
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

const T = (await post({ action: 'login', password: 'test-admin-pw' })).token;
const code = (await post({ action: 'create', lifetime: true, label: 'Renter', maxDevices: 5 }, T)).created[0];
const F1 = 'FOLDERIDONE1234567890', F2 = 'FOLDERIDTWO1234567890';
await core.eventsStore().setJSON(code.key, { events: [
  { id: 'e1', name: 'Santos Wedding', folderKey: 'x', folderUrl: 'https://drive.google.com/drive/folders/' + F1, firstAt: 1, lastAt: 2, sessions: 12 },
  { id: 'e2', name: 'Cruz Debut', folderKey: 'y', folderUrl: 'https://drive.google.com/drive/folders/' + F2, firstAt: 3, lastAt: 4, sessions: 7 },
  { id: 'e3', name: 'No Link', folderKey: 'z', folderUrl: '', firstAt: 5, sessions: 0 }
] });

check('driveFolderId reads a folder link', core.driveFolderId('https://drive.google.com/drive/folders/' + F1 + '?usp=sharing') === F1);
const list = await post({ action: 'events', code: code.code }, T);
check('Admin lists the code’s events', list.ok && list.events.length === 3 && list.events[0].name === 'Santos Wedding' && list.events[2].hasFolder === false);

const del = await post({ action: 'deleteevent', code: code.code, id: 'e1' }, T);
check('delete event 1 succeeds', del.ok === true && del.name === 'Santos Wedding', del.error);
check('relay trashed exactly that folder', trashed.has(F1) && !trashed.has(F2));
const after = await post({ action: 'events', code: code.code }, T);
check('event 1 is marked deleted, event 2 untouched', !!after.events[0].deletedAt && !after.events[1].deletedAt);
const again = await post({ action: 'deleteevent', code: code.code, id: 'e1' }, T);
check('deleting it again is harmless', again.ok === true);

const noEv = await post({ action: 'deleteevent', code: code.code, id: 'nope' }, T);
check('unknown event is refused', noEv.status === 404, noEv.error);
const noLink = await post({ action: 'deleteevent', code: code.code, id: 'e3' }, T);
check('event without a Drive link is refused', noLink.status === 400, noLink.error);
const noAuth = await post({ action: 'deleteevent', code: code.code, id: 'e2' });
check('needs the admin login', noAuth.status === 401);
check('...and nothing was trashed without it', !trashed.has(F2));

// A forged or reused ticket never reaches a folder
const forged = await fetch(process.env.DRIVE_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ trash: core.signTicket({ m: 'trash', id: F2, exp: Date.now() - 1000 }) }) }).then((r) => r.json());
check('relay refuses an expired ticket', forged.ok === false && !trashed.has(F2));
const rootTry = await fetch(process.env.DRIVE_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ trash: core.signTicket({ m: 'trash', id: ROOT, exp: Date.now() + 60000 }) }) }).then((r) => r.json());
check('relay refuses the root folder', rootTry.ok === false && rootTry.error === 'not-allowed');

// An old relay (script not redeployed yet) gives a clear message and changes nothing
relayMode = 'old';
const oldRelay = await post({ action: 'deleteevent', code: code.code, id: 'e2' }, T);
check('old relay: clear "redeploy upload.gs" message', oldRelay.status === 502 && /upload\.gs/.test(oldRelay.error), oldRelay.error);
const still = await post({ action: 'events', code: code.code }, T);
check('old relay: event is NOT marked deleted', !still.events[1].deletedAt);

await server.stop();
relay.close();
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
