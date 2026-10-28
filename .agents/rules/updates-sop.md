# SOP: What goes in /updates/ (photobooth4u What's new)

## Rule

Only **renter-facing or guest-facing** features and fixes belong in the public
`netlify/lib/updates.mjs` `NOTES` array (and therefore on `/updates/`).

## What to include (YES)

- New booth UI features visible to renters or guests
- Bug fixes in the web booth, laptop app, or Print Helper that affect end-users
- New layout options, printing sizes, sharing features, GIF mode, etc.
- App version releases (`app: '1.0.x'`) and Helper version bumps

## What to exclude (NO - internal admin only)

- Internal admin-panel features (e.g. admin generates a voucher PDF, admin
  copies a customer message, admin sees new stats)
- Backend / Netlify function changes that users never see
- Dev tooling changes (CI scripts, build system, GitHub Actions)
- Anything that only appears inside /admin or the admin API

## Rule of thumb

Ask: "Would a renter or guest care about this?"
If no -> do NOT add it to NOTES in netlify/lib/updates.mjs.
