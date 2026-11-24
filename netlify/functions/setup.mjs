import { safe, json, checkLicense, verifyToken, licenses, setupsStore, cleanEventName, setupKeyFor as keyFor } from '../lib/core.mjs';
import { mergeProfiles, mergeThemes, mergeFrames } from '../lib/profiles-merge.mjs';
import { readLicence, readMap, appDevice } from '../lib/license.mjs';

// Saves and loads the booth's Setup (layout, theme, backdrop, event name,
// fonts, timers, filters...) on the server, so it survives refreshes, restarts
// and Safari clearing the iPad, and every device on the same code gets the
// same design.
//   rental / bonus code -> one setup per booking (a bonus code shares its booking's)
//   lifetime code       -> one setup per event name
// Also keeps, per customer (booking / lifetime code):
//   assets  -> uploaded frame overlays, logos and props (images), and own shutter / countdown sounds (short WAV)
//   frames  -> uploaded frames library (spots, names, tiers, overlays), shared across all events & devices
//   themes  -> "My themes" saved from the booth
// Trials keep everything on the device only.
const MAX_SETTINGS = 350000;         // bytes of setup JSON (supports up to 100 frames + 6 guest designs)
const MAX_IMAGE = 3500000;           // characters of one image (data URL)
const MAX_THEMES_JSON = 400000;      // all of a customer's saved themes (incl. small thumbnails)
const MAX_THEMES = 40;
const MAX_FRAMES_JSON = 1500000;     // all of a customer's uploaded frames metadata (up to 100 frames)
const MAX_PROFILES_JSON = 3000000;   // all of a customer's saved profiles (each is one setup, up to 40 KB, plus a small thumbnail)
const MAX_ASSET_BATCH_BYTES = 4400000; // safely below Netlify Functions' 6 MB HTTP response limit
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const ASSET_IMAGE_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;   // uploaded pictures may also be small animated GIFs
// Own shutter / countdown sounds: the booth trims them to a short WAV before uploading.
const MAX_SOUND = 600000;
const SOUND_RE = /^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/;
const ASSET_ID_RE = /^a[A-Za-z0-9]{8,32}$/;

export default safe(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      }
    });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  let codeKey = null;
  let rec = null;
  let folderPrefix = null;

  // Offline apps (Windows, Mac, Android, iPad) authenticate with their signed PB4U-LIC1 licence + machine id.
  if (b.licence && b.mid && process.env.PB_LICENSE_KEY) {
    const lp = readLicence(b.licence);
    const mid = String(b.mid || '').trim().toUpperCase();
    if (!lp || lp.typ !== 'pb4u-desktop' || lp.mid !== mid) {
      return json({ error: 'locked', reason: 'invalid' }, 401);
    }
    const map = await readMap(lp.lid);
    rec = map ? await licenses().get(map.key, { type: 'json' }) : null;
    const dev = rec && appDevice(rec, (a) => a.lid === lp.lid && a.mid === mid);
    if (!rec || !dev) return json({ error: 'locked', reason: 'device-removed' }, 401);
    if (rec.status === 'revoked') return json({ error: 'locked', reason: 'revoked' }, 401);
    if (rec.status !== 'active' || rec.expiresAt <= Date.now()) return json({ error: 'locked', reason: 'expired' }, 401);
    codeKey = map.key;
    folderPrefix = rec.lifetime ? ((rec.folderName || rec.label || rec.code || '').trim() || null) : null;
  } else {
    const lic = await checkLicense(b.token, String(b.deviceId || ''));
    if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
    if (lic.type !== 'rental') return json({ error: 'Trials keep their setup on this device only.' }, 403);
    const p = verifyToken(b.token);
    codeKey = p.k;
    rec = await licenses().get(codeKey, { type: 'json' });
    folderPrefix = lic.folderPrefix;
  }

  const owner = rec && rec.kind === 'bonus' && rec.parent ? rec.parent : codeKey;
  const cleanEv = cleanEventName(b.event || '');
  let scope = owner;
  if (folderPrefix) scope += '|' + (cleanEv.toLowerCase() || '_');
  const id = keyFor(scope);
  const ownerId = keyFor('own|' + owner);
  const store = setupsStore();

  // Ensures the account-level frames store (`ownerId + '_frames'`) exists and rescues any legacy
  // frames stored inside event setups or saved profiles so previously uploaded frames reappear automatically.
  async function loadAccountFramesDoc() {
    const existing = await store.get(ownerId + '_frames', { type: 'json' });
    if (existing && existing.rescued) {
      return {
        frames: Array.isArray(existing.frames) ? existing.frames : [],
        deleted: existing.deleted && typeof existing.deleted === 'object' ? existing.deleted : {},
        updatedAt: existing.updatedAt || 0,
        rescued: true
      };
    }
    const rescued = [];
    const seenDocIds = new Set();
    const pushFromSetup = (doc) => {
      const list = doc && doc.settings && Array.isArray(doc.settings.frames) ? doc.settings.frames : [];
      for (const f of list) {
        if (f && typeof f === 'object') rescued.push({ ...f, savedAt: Number(f.savedAt) || Number(doc.updatedAt) || 1 });
      }
    };
    const trySetupDoc = async (docId) => {
      if (!docId || seenDocIds.has(docId)) return;
      seenDocIds.add(docId);
      const d = await store.get(docId, { type: 'json' }).catch(() => null);
      if (d) pushFromSetup(d);
    };
    await trySetupDoc(id);
    if (folderPrefix) {
      const latest = await store.get(ownerId + '_latest', { type: 'json' }).catch(() => null);
      if (latest && latest.docId) await trySetupDoc(latest.docId);
      await trySetupDoc(keyFor(owner + '|_'));
    }
    await trySetupDoc(keyFor(owner));
    const profDoc = await store.get(ownerId + '_profiles', { type: 'json' }).catch(() => null);
    if (profDoc && Array.isArray(profDoc.profiles)) {
      for (const p of profDoc.profiles) {
        if (p && p.settings && Array.isArray(p.settings.frames)) {
          for (const f of p.settings.frames) {
            if (f && typeof f === 'object') rescued.push({ ...f, savedAt: Number(f.savedAt) || Number(p.savedAt) || 1 });
          }
        }
      }
    }
    const merged = mergeFrames(existing && existing.frames, existing && existing.deleted, rescued, {});
    const out = { frames: merged.frames, deleted: merged.deleted, updatedAt: (existing && existing.updatedAt) || Date.now(), rescued: true };
    if (merged.frames.length || (existing && existing.frames)) {
      await store.setJSON(ownerId + '_frames', out).catch(() => {});
    }
    return out;
  }

  switch (b.action) {
    case 'get': {
      let doc = await store.get(id, { type: 'json' });
      let docId = id;
      let latestEvent = '';
      // If a Lifetime device opens without an event folder typed yet, load the latest saved event setup across this code's devices
      // (or fall back to a pre-upgrade rental setup if none exists yet).
      if (folderPrefix && scope === owner + '|_') {
        const latest = await store.get(ownerId + '_latest', { type: 'json' });
        if (latest && latest.docId && (!doc || (latest.updatedAt || 0) > (doc.updatedAt || 0))) {
          const latestDoc = await store.get(latest.docId, { type: 'json' });
          if (latestDoc) { doc = latestDoc; docId = latest.docId; latestEvent = latest.event || ''; }
        }
        if (!doc) {
          const legacyId = keyFor(owner);
          const legacy = await store.get(legacyId, { type: 'json' });
          if (legacy) { doc = legacy; docId = legacyId; }
        }
      }
      const image = doc && doc.hasImage ? await store.get(docId + '_img') : null;
      const ownerRec = owner === codeKey ? rec : await licenses().get(owner, { type: 'json' });   // a frame Admin made for this renter
      const sf = ownerRec && ownerRec.startFrame;
      const sl = ownerRec && ownerRec.startLogo;
      const sn = ownerRec && (ownerRec.startName || null);
      const isCharm = /charm/i.test((sn || '') + ' ' + ((ownerRec && ownerRec.label) || ''));
      return json({
        ok: true,
        settings: doc ? doc.settings : null,
        updatedAt: doc ? doc.updatedAt : 0,
        image: image || null,
        ...(latestEvent ? { latestEvent } : {}),
        startFrame: sf ? { id: sf.id, name: sf.name } : null,
        startLogo: sl ? { id: sl.id, name: sl.name } : null,
        startName: sn,
        startCardOnly: ownerRec && ownerRec.startCardOnly !== undefined ? !!ownerRec.startCardOnly : true,
        startSampleLayout: (ownerRec && ownerRec.startSampleLayout) || 'strip',
        startDeco: (ownerRec && ownerRec.startDeco) || (isCharm ? 'ribbon-waves' : 'none'),
        startDecoLabel: (ownerRec && ownerRec.startDecoLabel) || (isCharm ? 'Waves' : 'None'),
        startPalette: (ownerRec && ownerRec.startPalette) || (isCharm ? 'charm-pink' : 'monochrome'),
        startPaletteLabel: (ownerRec && ownerRec.startPaletteLabel) || (isCharm ? 'Charm Blush' : 'Monochrome'),
        adminPresetUpdatedAt: (ownerRec && ownerRec.adminPresetUpdatedAt) || 0
      });
    }

    case 'save': {
      if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) return json({ error: 'Bad settings' }, 400);
      const raw = JSON.stringify(b.settings);
      if (raw.length > MAX_SETTINGS) return json({ error: 'Settings too large' }, 413);
      const old = await store.get(id, { type: 'json' });
      const now = Date.now();
      const clientTs = Number(b.updatedAt) > 0 && Number(b.updatedAt) <= now + 60000 ? Math.min(now, Math.trunc(Number(b.updatedAt))) : now;
      if (b.ifNewer && old && (old.updatedAt || 0) > clientTs) {
        const image = old.hasImage ? await store.get(id + '_img') : null;
        return json({ ok: true, outdated: true, settings: old.settings, updatedAt: old.updatedAt, image: image || null });
      }
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
      const updatedAt = Math.max(now, (old && old.updatedAt ? old.updatedAt + 1 : 0));
      const parsedSettings = JSON.parse(raw);
      await store.setJSON(id, { settings: parsedSettings, updatedAt, hasImage });
      if (folderPrefix) {
        await store.setJSON(ownerId + '_latest', { docId: id, event: cleanEv, updatedAt });
      }
      // Passively preserve any uploaded frames inside the account-level library (merge-only, never deletes).
      if (Array.isArray(parsedSettings.frames) && parsedSettings.frames.length) {
        try {
          const curFrames = await loadAccountFramesDoc();
          // Keep explicit savedAt when present; default to 1 (not Date.now()) so an older client saving an
          // outdated event setup can preserve never-deleted frames without resurrecting newly deleted ones.
          const incoming = parsedSettings.frames.map((f) => ({ ...f, savedAt: Number(f && f.savedAt) || 1 }));
          const mergedF = mergeFrames(curFrames.frames, curFrames.deleted, incoming, {});
          if (JSON.stringify(mergedF).length <= MAX_FRAMES_JSON) {
            await store.setJSON(ownerId + '_frames', { frames: mergedF.frames, deleted: mergedF.deleted, updatedAt: Date.now(), rescued: true });
          }
        } catch { /* non-fatal */ }
      }
      return json({ ok: true, updatedAt });
    }

    // ---- Uploaded images (frame overlay, logo, props), shared by all of this customer's events ----
    case 'asset-put': {
      const aid = String(b.id || '');
      const data = String(b.data || '');
      if (!ASSET_ID_RE.test(aid)) return json({ error: 'Bad image id' }, 400);
      const isSound = SOUND_RE.test(data);
      if (isSound ? data.length > MAX_SOUND : (data.length > MAX_IMAGE || !ASSET_IMAGE_RE.test(data))) return json({ error: isSound ? 'That sound is too long.' : 'That image is too large or not a PNG/JPEG/GIF.' }, 413);
      await store.set(ownerId + '_a_' + aid, data);
      return json({ ok: true, id: aid });
    }
    // Only used for a profile's own backdrop picture, once no profile uses it any more.
    case 'asset-delete': {
      const aid = String(b.id || '');
      if (!ASSET_ID_RE.test(aid)) return json({ error: 'Bad image id' }, 400);
      await store.delete(ownerId + '_a_' + aid);
      return json({ ok: true });
    }
    case 'asset-get': {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => ASSET_ID_RE.test(x)).slice(0, 12);
      const assets = {};
      const fetched = await Promise.all(ids.map(async (aid) => [aid, await store.get(ownerId + '_a_' + aid)]));
      let totalBytes = 0;
      let truncated = false;
      for (const [aid, v] of fetched) {
        if (!v) continue;
        // Keep response safely under Netlify Functions' 6 MB HTTP response ceiling.
        if (totalBytes > 0 && totalBytes + v.length > MAX_ASSET_BATCH_BYTES) {
          truncated = true;
          break;
        }
        assets[aid] = v;
        totalBytes += v.length;
      }
      return json({ ok: true, assets, ...(truncated ? { truncated: true } : {}) });
    }

    // ---- Account-level uploaded frames library (persists across all events, devices & updates) ----
    case 'frames-get': {
      const doc = await loadAccountFramesDoc();
      return json({ ok: true, frames: doc.frames, deleted: doc.deleted, updatedAt: doc.updatedAt });
    }
    case 'frames-save': {
      if (!Array.isArray(b.frames)) return json({ error: 'Bad frames' }, 400);
      const old = await loadAccountFramesDoc();
      const merged = mergeFrames(old.frames, old.deleted, b.frames, b.deleted);
      const raw = JSON.stringify(merged);
      if (raw.length > MAX_FRAMES_JSON) return json({ error: 'Too many uploaded frames — remove a few first.' }, 413);
      const updatedAt = Date.now();
      await store.setJSON(ownerId + '_frames', { frames: merged.frames, deleted: merged.deleted, updatedAt, rescued: true });
      return json({ ok: true, frames: merged.frames, deleted: merged.deleted, updatedAt });
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
      return json({ ok: true, themes: doc && Array.isArray(doc.themes) ? doc.themes : [], deleted: doc && doc.deleted ? doc.deleted : {} });
    }
    case 'themes-save': {
      if (!Array.isArray(b.themes)) return json({ error: 'Bad themes' }, 400);
      for (const t of b.themes) {
        if (t && t.settings && JSON.stringify(t.settings).length > MAX_SETTINGS) return json({ error: 'A theme is too large to save.' }, 413);
      }
      const old = await store.get(ownerId + '_themes', { type: 'json' });
      const merged = mergeThemes(old && old.themes, old && old.deleted, b.themes, b.deleted);
      const raw = JSON.stringify(merged);
      if (raw.length > MAX_THEMES_JSON) return json({ error: 'Too many saved themes — delete a few first.' }, 413);
      await store.setJSON(ownerId + '_themes', { themes: merged.themes, deleted: merged.deleted, updatedAt: Date.now() });
      return json({ ok: true, themes: merged.themes, deleted: merged.deleted });
    }

    // ---- Saved profiles: whole setups saved under a name, shared by all of this customer's events ----
    case 'profiles-get': {
      const doc = await store.get(ownerId + '_profiles', { type: 'json' });
      return json({ ok: true, profiles: doc && Array.isArray(doc.profiles) ? doc.profiles : [], deleted: doc && doc.deleted ? doc.deleted : {} });
    }
    // The device sends its list; it is merged with the server's (newer save wins, a delete beats an older save)
    // and the merged list is sent back, so two tablets never overwrite each other.
    case 'profiles-save': {
      if (!Array.isArray(b.profiles)) return json({ error: 'Bad profiles' }, 400);
      for (const p of b.profiles) {
        if (p && p.settings && JSON.stringify(p.settings).length > MAX_SETTINGS) return json({ error: 'A profile is too large to save.' }, 413);
      }
      const old = await store.get(ownerId + '_profiles', { type: 'json' });
      const merged = mergeProfiles(old && old.profiles, old && old.deleted, b.profiles, b.deleted);
      const raw = JSON.stringify(merged);
      if (raw.length > MAX_PROFILES_JSON) return json({ error: 'Too many saved profiles — delete a few first.' }, 413);
      await store.setJSON(ownerId + '_profiles', { profiles: merged.profiles, deleted: merged.deleted, updatedAt: Date.now() });
      return json({ ok: true, profiles: merged.profiles, deleted: merged.deleted });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
});

export const config = { path: '/api/setup' };
