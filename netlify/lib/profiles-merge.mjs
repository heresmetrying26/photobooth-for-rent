// Saved profiles: joins two copies of a customer's list (the server's and one device's).
// The newer save of each profile wins, and a delete beats an older save, so two tablets
// adding / renaming / deleting profiles never overwrite each other.
export const MAX_PROFILES = 12;
export const MAX_TOMBS = 60;

const ASSET_ID_RE = /^a[A-Za-z0-9]{8,32}$/;
const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

// Keeps only well-formed profiles (and only the fields we know), so a bad client can't store junk.
export function cleanProfiles(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(p.id)
      && typeof p.name === 'string' && p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings))
    .map((p) => ({
      id: p.id,
      name: p.name.slice(0, 40),
      savedAt: Number(p.savedAt) || Date.now(),
      settings: p.settings,
      ...(ASSET_ID_RE.test(String(p.bgAssetId || '')) ? { bgAssetId: p.bgAssetId } : {}),
      ...(typeof p.bgSig === 'string' ? { bgSig: p.bgSig.slice(0, 40) } : {}),
      ...(typeof p.thumb === 'string' && p.thumb.length < 20000 && THUMB_RE.test(p.thumb) ? { thumb: p.thumb } : {}),
    }));
}

export function cleanTombs(t) {
  const out = {};
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    for (const k of Object.keys(t).slice(0, 200)) {
      if (/^[A-Za-z0-9-]{1,40}$/.test(k) && Number(t[k]) > 0) out[k] = Number(t[k]);
    }
  }
  return out;
}

export function mergeProfiles(a, ta, b, tb) {
  const tomb = {};
  for (const t of [cleanTombs(ta), cleanTombs(tb)]) for (const k of Object.keys(t)) tomb[k] = Math.max(tomb[k] || 0, t[k]);
  const keep = Object.keys(tomb).sort((x, y) => tomb[y] - tomb[x]).slice(0, MAX_TOMBS);
  const tombs = {};
  for (const k of keep) tombs[k] = tomb[k];
  const byId = {};
  for (const p of cleanProfiles(a).concat(cleanProfiles(b))) {
    const o = byId[p.id];
    if (!o || p.savedAt > o.savedAt) byId[p.id] = p;
  }
  const profiles = Object.values(byId)
    .filter((p) => !(tombs[p.id] >= p.savedAt))
    .sort((x, y) => y.savedAt - x.savedAt)
    .slice(0, MAX_PROFILES);
  return { profiles, deleted: tombs };
}
