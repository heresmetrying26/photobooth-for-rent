// Restores a photobooth4u backup (made by Admin → Backup) into a Netlify Blobs store.
// Use it after data loss, or when moving the site to a new Netlify site. See docs/disaster-recovery.md.
//
//   node scripts/restore-backup.mjs --file backup.json --dry-run
//   node scripts/restore-backup.mjs --file backup.json --site-id <Netlify site ID> --token <Netlify personal access token>
//   add --settings to also restore the site settings (otherwise existing settings are left alone)
//
// It writes: every code record, each code's events list, the Offline App activation map and the shutdown flag.
// It never deletes anything. Afterwards open Admin → "Rebuild index" so the code list shows again.
import { readFileSync } from 'node:fs';
import { getStore } from '@netlify/blobs';

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : null; };
const has = (name) => process.argv.includes('--' + name);
const fail = (m) => { console.error('\n' + m + '\n'); process.exit(1); };

const file = arg('file');
if (!file) fail('Usage: node scripts/restore-backup.mjs --file <backup.json> [--dry-run] [--site-id <id> --token <token>] [--settings]');
let b;
try { b = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail('Could not read the backup file: ' + e.message); }
if (!b || b.v !== 1 || b.app !== 'photobooth4u' || !b.licenses) fail('That does not look like a photobooth4u backup (version 1).');

const counts = { licenses: Object.keys(b.licenses).length, events: Object.keys(b.events || {}).length, applic: Object.keys(b.applic || {}).length };
console.log('Backup from ' + new Date(b.at).toLocaleString() + ': ' + counts.licenses + ' codes, ' + counts.events + ' events lists, ' + counts.applic + ' app activations.');
if (has('dry-run')) { console.log('Dry run: nothing written.'); process.exit(0); }

const opts = (name) => Object.assign({ name, consistency: 'strong' }, arg('site-id') && arg('token') ? { siteID: arg('site-id'), token: arg('token') } : {});
const lic = getStore(opts('licenses')), ev = getStore(opts('events')), meta = getStore(opts('meta'));

for (const [k, v] of Object.entries(b.licenses)) await lic.setJSON(k, v);
for (const [k, v] of Object.entries(b.events || {})) await ev.setJSON(k, v);
for (const [k, v] of Object.entries(b.applic || {})) await meta.setJSON(k, v);
if (b.shutdown) await meta.setJSON('shutdown', b.shutdown);
if (has('settings') && b.settings) await meta.setJSON('settings', { ...((await meta.get('settings', { type: 'json' })) || {}), ...b.settings });

console.log('Restored ' + counts.licenses + ' codes, ' + counts.events + ' events lists and ' + counts.applic + ' app activations.');
console.log('Next: open Admin → "Rebuild index". Booth designs, guest-payment accounts and photos are not in a backup.');
