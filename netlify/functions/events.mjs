import { safe, json, licenses, verifyToken, devicesOf, eventsStore, isDriveUrl, MAX_EVENTS, BONUS_SUBFOLDER } from '../lib/core.mjs';

// Called by the booth after it sets up a Drive folder and after each photo
// session, so the /lifetime page can list every event folder with its link.
// Only a valid, unlocked booth (token + its device) can report, and only
// folders that belong to its own code.
export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  const p = verifyToken(b.token);
  if (!p || p.t !== 'rental') return json({ error: 'locked' }, 401);
  const rec = await licenses().get(p.k, { type: 'json' });
  if (!rec || rec.status !== 'active' || rec.expiresAt <= Date.now()) return json({ error: 'locked' }, 401);
  if (!devicesOf(rec).some((d) => d.id === p.d) || p.d !== String(b.deviceId || '')) return json({ error: 'locked' }, 401);

  const folderKey = String(b.folderKey || '').trim().slice(0, 200);
  const folderUrl = String(b.folderUrl || '').trim();
  if (!folderKey || !isDriveUrl(folderUrl)) return json({ error: 'Bad folder' }, 400);

  // The folder must be this code's own: its fixed folder, or for lifetime
  // codes "<folder name> · <event name>".
  const base = (rec.folderName || rec.label || rec.code || '').trim();
  const bonus = rec.kind === 'bonus';
  let name;
  if (rec.lifetime) {
    if (!folderKey.startsWith(base + ' · ')) return json({ error: 'Not your folder' }, 403);
    name = folderKey.slice(base.length + 3);
  } else if (folderKey === base) {
    name = base + (bonus ? ' / ' + (rec.subfolder || BONUS_SUBFOLDER) : '');
  } else {
    return json({ error: 'Not your folder' }, 403);
  }

  // Bonus codes file their folder under the booking they belong to.
  const owner = bonus && rec.parent ? rec.parent : p.k;
  const store = eventsStore();
  const doc = (await store.get(owner, { type: 'json' })) || { events: [] };
  const now = Date.now();
  const id = folderKey + (bonus ? '/' + (rec.subfolder || BONUS_SUBFOLDER) : '');
  let ev = doc.events.find((e) => e.id === id);
  if (!ev) {
    ev = { id, folderKey, name, bonus, folderUrl, firstAt: now, lastAt: null, sessions: 0 };
    doc.events.unshift(ev);
    doc.events = doc.events.slice(0, MAX_EVENTS);
  }
  ev.folderUrl = folderUrl;
  if (b.session) { ev.sessions = (ev.sessions || 0) + 1; ev.lastAt = now; }
  await store.setJSON(owner, doc);
  return json({ ok: true });
});

export const config = { path: '/api/events' };
