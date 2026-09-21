# Photo Booth – rental edition

**Lock screen → password → app.** The booth itself (`protected/booth.html`) is never
public; a Netlify Function only sends it to someone with a valid trial or rental license.

## Deploy (functions need Git or the CLI — drag & drop of a folder won't run functions)

1. Put this folder in a GitHub repo and connect it to Netlify (New site → Import from Git),
   **or** with the CLI:  `npm i -g netlify-cli && netlify login && netlify deploy --prod --build`
2. In Netlify → Site configuration → Environment variables, add:
   - `ADMIN_PASSWORD`  – your admin login (make it long)
   - `TOKEN_SECRET`    – 32+ random characters (e.g. from a password generator)
   - `TRIAL_PASSWORD`  – optional; default is `TRIAL` (you can change it later in Admin)
3. Redeploy once after saving the variables.
4. Open `https://YOUR-SITE.netlify.app/admin.html` to create rental codes.

## Updating the booth
Edit `protected/booth.html` and redeploy. (The build step re-bundles it automatically.)

## How it works
- **Trial password** – reusable, unlocks for N minutes (default 15). Change/disable in Admin.
- **Rental codes** – `PB-XXXX-XXXX-XXXX`, one-time use. Days start counting on first entry.
  Bound to the first device; other devices are refused. Expiry is enforced on the server.
- **Admin** – create codes (by days), see status/time left, add days, disable/restore, delete,
  "Allow new device" (if the renter switches tablets), and edit trial settings.
- When time is up, the app returns to the lock screen (after any photo session in progress).
