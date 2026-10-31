# Disaster recovery: if photobooth4u goes away suddenly

The agreement promises Lifetime renters a final Offline App that keeps working with no photobooth4u
servers. Shutdown mode (Admin) does that while the site still works. This page is for when it does not
(Netlify or the Google account suspended, data lost). Do the first two steps NOW, while everything works.

## 1. Keep the signing key safe (once)

`PB_LICENSE_KEY` (in Netlify, Site configuration, Environment variables) is the private key that signs every
Offline App licence. Without it nobody can make licences. Copy its value into a password manager and onto
an offline backup (USB stick or printed in a safe). Never put it in the repository or send it by chat.
If you ever lose it, existing licences keep working until their check-in date, but no new ones can be made.

## 2. Keep backups of the codes (automatic, plus your own copy)

- **Automatic:** every week the site saves a full backup into a private `photobooth4u-backups` folder in the
  photobooth Google Drive (newest 12 kept). Admin, "Backup (all codes)" shows the last result and has
  "Back up to Drive now". If a backup fails you get an email at ALERT_EMAIL.
  The Apps Script (`apps-script/upload.gs`) must be on the newest version for this to work.
- **Your own copy:** in Admin, "Download a backup file" now and then, and keep it with the key. It holds
  every code, so treat it like a password list.
- A backup holds: every code record (devices, agreement, flags, features), each code's events list, the
  Offline App activations and the shutdown flag. It does not hold booth designs, guest-payment accounts or photos.

## 3. If the site is gone: make final licences yourself

Needs Node.js, this repository, your backup file and the signing key. No internet or photobooth4u server.

```
# PowerShell
$env:PB_LICENSE_KEY = '<the key>'
node scripts/make-final-licence.mjs --backup photobooth4u-backup-2026-11-01.json --code PB-XXXX-XXXX-XXXX
```

That prints a final licence for every laptop already activated on the code. For a new machine add
`--mid <Machine ID>` (the renter reads it on the app's activation screen). The renter pastes the licence under
"Activate without internet". It never asks to check in again. Codes that were disabled are skipped.

## 4. If you move to a new Netlify site: restore the codes

```
node scripts/restore-backup.mjs --file backup.json --dry-run
node scripts/restore-backup.mjs --file backup.json --site-id <new site id> --token <Netlify personal access token>
```

Then open Admin, "Rebuild index". Restoring never deletes anything. Set the environment variables again
(`TOKEN_SECRET`, `UPLOAD_SECRET`, `PB_LICENSE_KEY`, `ADMIN_PASSWORD`, `ALERT_EMAIL`, ...). The new site must use the
SAME `PB_LICENSE_KEY`, or old licences stop verifying.
