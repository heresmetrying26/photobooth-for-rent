import { safe, json, checkLicense, verifyToken, licenses, setupsStore, cleanEventName, setupKeyFor as keyFor } from '../lib/core.mjs';

// Saves and loads the booth's Setup (layout, theme, backdrop, event name,
// fonts, timers, filters...) on the server, so it survives refreshes, restarts
// and Safari clearing the iPad, and every device on the same code gets the
// same design.
//   rental / bonus code -> one setup per booking (a bonus code shares its booking's)
//   lifetime code       -> one setup per event name
// Also keeps, per customer (booking / lifetime code):
//   assets  -> uploaded frame overlays, logos and props (images), and own shutter / countdown sounds (short WAV)
//   themes  -> "My themes" saved from the booth
// Trials keep everything on the device only.
const MAX_SETTINGS = 40000;          // bytes of setup JSON
const MAX_IMAGE = 3500000;           // characters of one image (data URL)
const MAX_THEMES_JSON = 400000;      // all of a customer's saved themes (incl. small thumbnails)
const MAX_THEMES = 40;
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
// Own shutter / countdown sounds: the booth trims them to a short WAV before uploading.
const MAX_SOUND = 600000;
const SOUND_RE = /^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/;
const ASSET_ID_RE = /^a[A-Za-z0-9]{8,32}$/;

export default safe(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  const lic = await checkLicense(b.token, String(b.deviceId || ''));
  if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
  if (lic.type !== 'rental') return json({ error: 'Trials keep their setup on this device only.' }, 403);

  const p = verifyToken(b.token);
  const rec = await licenses().get(p.k, { type: 'json' });
  const owner = rec && rec.kind === 'bonus' && rec.parent ? rec.parent : p.k;
  let scope = owner;
  if (lic.folderPrefix) scope += '|' + (cleanEventName(b.event || '').toLowerCase() || '_');
  const id = keyFor(scope);
  const ownerId = keyFor('own|' + owner);
  const store = setupsStore();

  switch (b.action) {
    case 'get': {
      const doc = await store.get(id, { type: 'json' });
      const image = doc && doc.hasImage ? await store.get(id + '_img') : null;
      return json({ ok: true, settings: doc ? doc.settings : null, updatedAt: doc ? doc.updatedAt : 0, image: image || null });
    }

    case 'save': {
      if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) return json({ error: 'Bad settings' }, 400);
      const raw = JSON.stringify(b.settings);
      if (raw.length > MAX_SETTINGS) return json({ error: 'Settings too large' }, 413);
      const old = await store.get(id, { type: 'json' });
      let hasImage = !!(old && old.hasImage);
      if ('image' in b) {
        if (b.image === null) {
          await store.delete(id + '_img');
          hasImage = false;
        } else {
          const img = String(b.image);
          if (img.length > MAX_IMAGE || !IMAGE_RE.test(img)) return json({ error: 'Backdrop photo is too large or not an image.' }, 413);
          await store.set(id + '_img', img);
          hasImage = true;
        }
      }
      const updatedAt = Date.now();
      await store.setJSON(id, { settings: JSON.parse(raw), updatedAt, hasImage });
      return json({ ok: true, updatedAt });
    }

    // ---- Uploaded images (frame overlay, logo, props), shared by all of this customer's events ----
    case 'asset-put': {
      const aid = String(b.id || '');
      const data = String(b.data || '');
      if (!ASSET_ID_RE.test(aid)) return json({ error: 'Bad image id' }, 400);
      const isSound = SOUND_RE.test(data);
      if (isSound ? data.length > MAX_SOUND : (data.length > MAX_IMAGE || !IMAGE_RE.test(data))) return json({ error: isSound ? 'That sound is too long.' : 'That image is too large or not a PNG/JPEG.' }, 413);
      await store.set(ownerId + '_a_' + aid, data);
      return json({ ok: true, id: aid });
    }
    case 'asset-get': {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => ASSET_ID_RE.test(x)).slice(0, 12);
      const assets = {};
      await Promise.all(ids.map(async (aid) => {
        const v = await store.get(ownerId + '_a_' + aid);
        if (v) assets[aid] = v;
      }));
      return json({ ok: true, assets });
    }

    // ---- Lock booth PIN: one per code (bonus codes share their booking's) ----
    case 'pin-get': {
      const doc = await store.get(ownerId + '_pin', { type: 'json' });
      return json({ ok: true, pin: doc && doc.h ? { h: doc.h, at: doc.at || 0 } : null });
    }
    case 'pin-set': {
      const h = String(b.h || '');
      if (!/^[0-9a-f]{64}$/.test(h)) return json({ error: 'Bad PIN' }, 400);
      const at = Date.now();
      await store.setJSON(ownerId + '_pin', { h, at });
      return json({ ok: true, at });
    }

    // ---- "My themes" ----
    case 'themes-get': {
      const doc = await store.get(ownerId + '_themes', { type: 'json' });
      return json({ ok: true, themes: doc && Array.isArray(doc.themes) ? doc.themes : [] });
    }
    case 'themes-save': {
      const themes = Array.isArray(b.themes) ? b.themes.slice(0, MAX_THEMES) : null;
      if (!themes) return json({ error: 'Bad themes' }, 400);
      const raw = JSON.stringify({ themes });
      if (raw.length > MAX_THEMES_JSON) return json({ error: 'Too many saved themes — delete a few first.' }, 413);
      await store.setJSON(ownerId + '_themes', { themes: JSON.parse(raw).themes, updatedAt: Date.now() });
      return json({ ok: true });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
});

export const config = { path: '/api/setup' };
