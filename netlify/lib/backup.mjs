import { createHash } from 'node:crypto';
import { licenses, eventsStore, meta, getShutdown, signTicket, DRIVE_SCRIPT_URL, notifyOwner } from './core.mjs';

// Full backup of everything a renter needs to sign in again: every code record (devices, agreement, flags, features),
// each code's events list, the Offline App activation map, the shutdown flag and the site settings (without any key,
// secret or token). NOT included: booth designs (setups), guest-payment accounts and vouchers (sealed to a key that is
// not in the backup), and photos (those live in Google Drive for 7 days).
// Format version 1. Restore with scripts/restore-backup.mjs; make final licences with scripts/make-final-licence.mjs.
const SECRETISH = /secret|apikey|api_key|paymongo|token|password/i;

async function readAll(store, prefix) {
  const out = {};
  const listing = await store.list(prefix ? { prefix } : undefined);
  const keys = ((listing && listing.blobs) || []).map((b) => b.key);
  for (let i = 0; i < keys.length; i += 50) {
    const part = await Promise.all(keys.slice(i, i + 50).map((k) => store.get(k, { type: 'json' }).catch(() => null)));
    part.forEach((v, j) => { if (v != null) out[keys[i + j]] = v; });
  }
  return out;
}

export async function buildBackup(now = Date.now()) {
  const m = meta();
  const settings = (await m.get('settings', { type: 'json' }).catch(() => null)) || {};
  const safeSettings = Object.fromEntries(Object.entries(settings).filter(([k]) => !SECRETISH.test(k)));
  return {
    v: 1,
    app: 'photobooth4u',
    at: now,
    licenses: await readAll(licenses()),
    events: await readAll(eventsStore()),
    applic: await readAll(m, 'applic-'),
    shutdown: await getShutdown(),
    settings: safeSettings
  };
}

export const backupName = (now = Date.now(), tag = '') => 'photobooth4u-backup-' + new Date(now + 8 * 3600000).toISOString().slice(0, 10) + (tag ? '-' + tag : '') + '.json';

// Saves the backup in the photobooth Google account's own Drive (a private "photobooth4u-backups" folder, newest 12 kept)
// through the Apps Script relay. The ticket is signed and carries the file name and the SHA-256 of the content,
// so the relay only saves exactly what the server asked it to.
export async function sendBackupToDrive(name, content) {
  const h = createHash('sha256').update(content, 'utf8').digest('hex');
  const ticket = signTicket({ m: 'backup', n: name, h, exp: Date.now() + 2 * 60000 });
  const r = await fetch(DRIVE_SCRIPT_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ backup: ticket, content }), redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(/Upload not allowed|ticket/i.test(j.error || '') ? 'The Google Apps Script relay needs the newest apps-script/upload.gs (Deploy → New version) before backups can be saved.' : (j.error || 'Drive could not save the backup.'));
  return j;
}

// Runs a backup to Drive and records the result for Admin. Used by the weekly schedule and the "Back up now" button.
export async function runDriveBackup(now = Date.now(), tag = '') {
  const m = meta();
  try {
    const data = await buildBackup(now);
    const name = backupName(now, tag);
    const res = await sendBackupToDrive(name, JSON.stringify(data));
    const info = { ok: true, at: now, name, codes: Object.keys(data.licenses).length, kept: res.kept || null };
    await m.setJSON('lastbackup', info);
    return info;
  } catch (e) {
    const info = { ok: false, at: now, error: e.message };
    await m.setJSON('lastbackup', info).catch(() => {});
    await notifyOwner('photobooth4u backup FAILED', 'The backup to Google Drive did not work.\n\n' + e.message + '\n\nOpen Admin → Backup to try again, or download a backup there by hand.');
    return info;
  }
}
