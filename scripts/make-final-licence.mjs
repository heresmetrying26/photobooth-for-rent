// Makes FINAL Offline App licences on your own computer, from a backup file, with NO photobooth4u server.
// Use it if the site is gone (Netlify or Google suspended, data lost) and renters' laptops need licences that never
// ask to check in again. See docs/disaster-recovery.md.
//
//   PB_LICENSE_KEY=<your signing key>  node scripts/make-final-licence.mjs --backup backup.json --code PB-XXXX-XXXX-XXXX
//   ...  --code PB-XXXX-XXXX-XXXX --mid WIN-ABCD-EFGH-JKLM-NPQR [--os win|mac|android] [--name "Booth laptop"]
//
// Without --mid it makes a licence for every laptop / tablet already activated on that code (from the backup).
// With --mid it makes one for a new machine (the renter reads its Machine ID on the app's activation screen).
// The renter pastes the licence under "Activate without internet" in the app.
// PowerShell:  $env:PB_LICENSE_KEY = '<key>'; node scripts/make-final-licence.mjs --backup backup.json --code PB-...
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const fail = (m) => { console.error('\n' + m + '\n'); process.exit(1); };

const file = arg('backup'), codeIn = arg('code'), mid = (arg('mid') || '').trim().toUpperCase(), os = arg('os') || null, name = arg('name') || 'Booth computer';
if (!file || !codeIn) fail('Usage: node scripts/make-final-licence.mjs --backup <backup.json> --code <PB-XXXX-XXXX-XXXX> [--mid <Machine ID>] [--os win|mac|android] [--name "Booth laptop"]');
if (!process.env.PB_LICENSE_KEY) fail('Set PB_LICENSE_KEY first (your signing key, the same value as in Netlify).');

const lic = await import(pathToFileURL(join(root, 'netlify/lib/license.mjs')).href);
const key = String(codeIn).toUpperCase().replace(/[^A-Z0-9]/g, '');
let backup;
try { backup = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail('Could not read the backup file: ' + e.message); }
const rec = backup && backup.licenses && backup.licenses[key];
if (!rec) fail('That code is not in this backup.');
if (!rec.lifetime) fail('Only Lifetime codes get final licences. This code is not a Lifetime code.');
if (rec.status === 'revoked') fail('That code is disabled in the backup (reason: ' + (rec.revokeReason || 'unknown') + '). Not making a licence.');

const now = Date.now();
const devices = [];
if (mid) {
  if (!lic.MID_RE.test(mid)) fail('That Machine ID does not look right (example: WIN-ABCD-EFGH-JKLM-NPQR).');
  const existing = (rec.devices || []).find((d) => d.app && d.app.mid === mid);
  const osKey = os || (/^MAC-/.test(mid) ? 'mac' : 'win');
  devices.push(existing || { id: 'app:new', no: (rec.devices || []).reduce((n, d) => Math.max(n, d.no || 0), 0) + 1, app: { lid: randomBytes(10).toString('hex'), mid, os: osKey, name } });
} else {
  for (const d of rec.devices || []) if (d.app) devices.push(d);
  if (!devices.length) fail('No laptop or tablet has been activated on this code. Use --mid <Machine ID> to make one for a new machine.');
}

console.log('\nFinal licences for ' + (rec.label || rec.folderName || rec.code) + ' (' + rec.code + ')\n');
for (const dev of devices) {
  const text = lic.licenceFor(key, rec, dev, now, true);
  const p = lic.readLicence(text);
  if (!p || !p.feat || !p.feat.final) fail('Internal check failed: the licence did not verify as final.');
  console.log('Device ' + dev.no + ' · ' + (dev.app.name || 'unnamed') + ' · Machine ID ' + dev.app.mid + ' · ' + dev.app.os);
  console.log(text + '\n');
}
console.log('Give each licence to its renter: in the app choose "Activate without internet" and paste it. It never asks to check in again.');
