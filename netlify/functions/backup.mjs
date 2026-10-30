import { runDriveBackup } from '../lib/backup.mjs';

// Weekly backup of all codes to the photobooth Google account's Drive (see lib/backup.mjs).
// If it fails you get an email at ALERT_EMAIL, and Admin → Backup shows the last result.
export default async () => {
  const r = await runDriveBackup(Date.now(), 'weekly');
  console.log('weekly backup', JSON.stringify(r));
  return new Response('ok');
};

export const config = { schedule: '@weekly' };
