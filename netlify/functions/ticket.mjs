import { safe, json, checkLicense, signTicket, cleanEventName, TICKET_MS } from '../lib/core.mjs';

// Gives an unlocked booth a short-lived, signed ticket for the ONE Drive folder
// it is allowed to use. The Apps Script refuses uploads without a valid ticket
// and only ever uses the folder written inside it.
//   rental  -> the folder set in Admin (bonus codes: + their subfolder)
//   lifetime-> "<folder name> · <event name>" (event name cleaned here too)
//   trial   -> its own throwaway trial folder
export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);

  const asked = String(b.folderKey || '').trim();
  let folder;
  if (lic.folderPrefix) {
    const pre = lic.folderPrefix + ' · ';
    const ev = asked.startsWith(pre) ? asked.slice(pre.length) : '';
    if (!ev || cleanEventName(ev) !== ev) return json({ error: 'Type an event name using letters and numbers.' }, 400);
    folder = pre + ev;
  } else {
    folder = lic.folderKey;
    if (!folder || asked !== folder) return json({ error: 'This booth can only use its own event folder.' }, 403);
  }

  const exp = Math.min(lic.exp, Date.now() + TICKET_MS);
  const ticket = signTicket({ f: folder, s: lic.subfolder || null, exp });
  return json({ ok: true, ticket, exp, folderKey: folder, subfolder: lic.subfolder || null });
});

export const config = { path: '/api/ticket' };
