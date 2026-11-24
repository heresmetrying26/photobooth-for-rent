// Offline-first cloud sync for the Desktop app (Windows / Mac).
//
// The laptop always reads and writes its own local store first (so everything works
// instantly at venues with no Wi-Fi). Whenever internet is available, setups, saved
// profiles, custom themes and uploaded assets (frames, logos, stickers, backdrops,
// sounds) sync and merge with photobooth4u.netlify.app/api/setup using this laptop's
// signed PB4U-LIC1 licence + machine ID.
//
// Stays separate on this laptop (never synced across devices):
//  - Lock booth PIN (pin-get / pin-set)
//  - Vouchers (/api/pay) and print counts (/api/prints)
//  - Camera, printer, Wi-Fi / hotspot choices and guest photos
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getStore } from './store.mjs';
import * as L from './licence.mjs';
import { handleApi } from './server.mjs';

const LOCAL_KEY = 'LOCAL';
const ASSET_ID_RE = /^a[A-Za-z0-9]{8,32}$/;
const keyFor = (scope) => 'k' + createHash('sha256').update(scope).digest('hex').slice(0, 40);
const LOCAL_OWNER_ID = keyFor('own|' + LOCAL_KEY);

function cleanEventName(v) {
  return String(v || '').replace(/[^\p{L}\p{N} '\u2019&().,!_-]/gu, '').replace(/[\p{L}\p{N}_.-]{20,}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function isLifetime() {
  const s = L.status();
  return !!(s && s.p && s.p.lifetime);
}

function localDocId(eventName) {
  let scope = LOCAL_KEY;
  if (isLifetime()) scope += '|' + (cleanEventName(eventName || '').toLowerCase() || '_');
  return keyFor(scope);
}

// Finds every asset id (aXXXXXXXX...) referenced inside a setup, profile or theme object.
function collectAssetIds(root) {
  const found = new Set();
  const walk = (v, depth) => {
    if (!v || depth > 7) return;
    if (typeof v === 'string') {
      const s = v.startsWith('a:') ? v.slice(2) : v;
      if (ASSET_ID_RE.test(s) && s.length >= 14) found.add(s);
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1);
      return;
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) walk(v[keys[i]], depth + 1);
    }
  };
  walk(root, 0);
  return Array.from(found);
}

let DATA_DIR = null;
let FETCH_FN = null;
let ON_SYNCED = null;
let syncState = {
  syncedAssets: {},
  dirtyAssets: {},
  dirtySetups: {},
  dirtyProfiles: false,
  dirtyThemes: false,
  dirtyFrames: false,
  lastSyncAt: 0
};

const stateFile = () => (DATA_DIR ? join(DATA_DIR, 'setup-sync.json') : null);

function loadSyncState() {
  const f = stateFile();
  if (!f || !existsSync(f)) return;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (raw && typeof raw === 'object') {
      syncState = {
        syncedAssets: (raw.syncedAssets && typeof raw.syncedAssets === 'object') ? raw.syncedAssets : {},
        dirtyAssets: (raw.dirtyAssets && typeof raw.dirtyAssets === 'object') ? raw.dirtyAssets : {},
        dirtySetups: (raw.dirtySetups && typeof raw.dirtySetups === 'object') ? raw.dirtySetups : {},
        dirtyProfiles: !!raw.dirtyProfiles,
        dirtyThemes: !!raw.dirtyThemes,
        dirtyFrames: !!raw.dirtyFrames,
        lastSyncAt: Number(raw.lastSyncAt) || 0
      };
    }
  } catch { /* start fresh */ }
}

function saveSyncState() {
  const f = stateFile();
  if (!f) return;
  try { writeFileSync(f, JSON.stringify(syncState)); } catch { /* ignore */ }
}

export function initSetupSync({ dataDir, fetchFn, onSynced }) {
  DATA_DIR = dataDir;
  FETCH_FN = fetchFn;
  ON_SYNCED = onSynced || null;
  loadSyncState();
}

const jsonRes = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

async function localCall(bodyObj) {
  const req = new Request('app://booth/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj)
  });
  const res = await handleApi(req, '/api/setup');
  let j = {};
  try { j = await res.clone().json(); } catch { j = {}; }
  return { ok: res.status === 200 && j && j.ok, status: res.status, j, res };
}

async function remotePost(payload, timeoutMs = 10000) {
  if (!FETCH_FN) return null;
  const st = L.status();
  const licence = L.currentLicence();
  if (!st.ok || !licence) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await FETCH_FN(L.SERVER + '/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, licence, mid: L.machineId() }),
      signal: ctl.signal
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.status === 200 && !!(j && j.ok), status: r.status, j };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Uploads any locally stored assets in `ids` that haven't been pushed to Netlify yet.
async function pushLocalAssets(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => ASSET_ID_RE.test(String(id || '')) && !syncState.syncedAssets[id]);
  if (!list.length) return true;
  const store = getStore({ name: 'setups' });
  let allOk = true;
  for (const aid of list) {
    const data = await store.get(LOCAL_OWNER_ID + '_a_' + aid);
    if (!data) continue;
    const r = await remotePost({ action: 'asset-put', id: aid, data }, 15000);
    if (r && r.ok) {
      syncState.syncedAssets[aid] = 1;
      delete syncState.dirtyAssets[aid];
    } else {
      syncState.dirtyAssets[aid] = 'put';
      allOk = false;
      if (!r) break; // offline: stop trying more right now
    }
  }
  saveSyncState();
  return allOk;
}

// Downloads any assets in `ids` that aren't in the laptop's local store yet, so synced profiles/setups/frames work offline later.
// Fetches 1 asset per request (3 concurrent) so large PNG frames never exceed Netlify Functions' 6 MB response cap.
async function pullRemoteAssets(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => ASSET_ID_RE.test(String(id || ''))))];
  if (!unique.length) return;
  const store = getStore({ name: 'setups' });
  const missing = [];
  for (const aid of unique) {
    const v = await store.get(LOCAL_OWNER_ID + '_a_' + aid);
    if (!v) missing.push(aid);
    else syncState.syncedAssets[aid] = 1;
  }
  if (!missing.length) { saveSyncState(); return; }
  let cursor = 0;
  let offline = false;
  const worker = async () => {
    while (!offline) {
      const idx = cursor++;
      if (idx >= missing.length) return;
      const aid = missing[idx];
      const r = await remotePost({ action: 'asset-get', ids: [aid] }, 18000);
      if (!r) { offline = true; return; }
      if (r.ok && r.j && r.j.assets && r.j.assets[aid]) {
        await store.set(LOCAL_OWNER_ID + '_a_' + aid, r.j.assets[aid]);
        syncState.syncedAssets[aid] = 1;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  saveSyncState();
}

export async function handleSetupRequest(req) {
  let b = null;
  try { b = JSON.parse(await req.text()); } catch { b = null; }
  if (!b || typeof b !== 'object') return jsonRes({ error: 'Bad request' }, 400);

  // 1. Lock booth PIN is per-device only (never synced to or from other devices).
  if (b.action === 'pin-get' || b.action === 'pin-set') {
    const loc = await localCall(b);
    return loc.res;
  }

  const store = getStore({ name: 'setups' });

  // 2. Uploaded assets (frames, logos, stickers, custom backdrops, sounds)
  if (b.action === 'asset-put') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    const aid = String(b.id || '');
    const r = await remotePost({ action: 'asset-put', id: aid, data: b.data }, 12000);
    if (r && r.ok) {
      syncState.syncedAssets[aid] = 1;
      delete syncState.dirtyAssets[aid];
    } else {
      syncState.dirtyAssets[aid] = 'put';
    }
    saveSyncState();
    return jsonRes({ ok: true, id: aid, synced: !!(r && r.ok) });
  }

  if (b.action === 'asset-delete') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    const aid = String(b.id || '');
    const r = await remotePost({ action: 'asset-delete', id: aid }, 8000);
    if (r && r.ok) {
      delete syncState.syncedAssets[aid];
      delete syncState.dirtyAssets[aid];
    } else {
      syncState.dirtyAssets[aid] = 'del';
    }
    saveSyncState();
    return loc.res;
  }

  if (b.action === 'asset-get') {
    const loc = await localCall(b);
    const assets = (loc.ok && loc.j && loc.j.assets) ? { ...loc.j.assets } : {};
    const wanted = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => ASSET_ID_RE.test(x)).slice(0, 12);
    const missing = wanted.filter((id) => !assets[id]);
    if (missing.length) {
      let cursor = 0;
      let offline = false;
      const worker = async () => {
        while (!offline) {
          const idx = cursor++;
          if (idx >= missing.length) return;
          const aid = missing[idx];
          const r = await remotePost({ action: 'asset-get', ids: [aid] }, 18000);
          if (!r) { offline = true; return; }
          if (r.ok && r.j && r.j.assets && r.j.assets[aid]) {
            assets[aid] = r.j.assets[aid];
            await store.set(LOCAL_OWNER_ID + '_a_' + aid, r.j.assets[aid]);
            syncState.syncedAssets[aid] = 1;
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      saveSyncState();
    }
    return jsonRes({ ok: true, assets });
  }

  // 2b. Account-level uploaded frames library (two-way timestamp + tombstone merge across all devices & events)
  if (b.action === 'frames-get' || b.action === 'frames-save') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    const localDoc = (await store.get(LOCAL_OWNER_ID + '_frames', { type: 'json' })) || {};
    const localFrames = Array.isArray(localDoc.frames) ? localDoc.frames : (Array.isArray(loc.j.frames) ? loc.j.frames : []);
    const localDeleted = (localDoc.deleted && typeof localDoc.deleted === 'object') ? localDoc.deleted : (loc.j.deleted || {});

    await pushLocalAssets(collectAssetIds(localFrames));
    const r = await remotePost({ action: 'frames-save', frames: localFrames, deleted: localDeleted }, 15000);
    if (r && r.ok && Array.isArray(r.j.frames)) {
      const merged = { frames: r.j.frames, deleted: r.j.deleted || {}, updatedAt: r.j.updatedAt || Date.now(), rescued: true };
      await store.setJSON(LOCAL_OWNER_ID + '_frames', merged);
      syncState.dirtyFrames = false;
      syncState.lastSyncAt = Date.now();
      saveSyncState();
      pullRemoteAssets(collectAssetIds(merged.frames)).catch(() => { });
      return jsonRes({ ok: true, frames: merged.frames, deleted: merged.deleted, updatedAt: merged.updatedAt, synced: true });
    }
    if (b.action === 'frames-save') {
      syncState.dirtyFrames = true;
      saveSyncState();
    }
    return jsonRes({ ok: true, frames: localFrames, deleted: localDeleted, updatedAt: localDoc.updatedAt || 0, synced: false });
  }

  // 3. Saved profiles (two-way timestamp + tombstone merge across all devices on the code)
  if (b.action === 'profiles-get' || b.action === 'profiles-save') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    const localDoc = (await store.get(LOCAL_OWNER_ID + '_profiles', { type: 'json' })) || {};
    const localProfiles = Array.isArray(localDoc.profiles) ? localDoc.profiles : (Array.isArray(loc.j.profiles) ? loc.j.profiles : []);
    const localDeleted = (localDoc.deleted && typeof localDoc.deleted === 'object') ? localDoc.deleted : (loc.j.deleted || {});

    await pushLocalAssets(collectAssetIds(localProfiles));
    const r = await remotePost({ action: 'profiles-save', profiles: localProfiles, deleted: localDeleted }, 10000);
    if (r && r.ok && Array.isArray(r.j.profiles)) {
      const merged = { profiles: r.j.profiles, deleted: r.j.deleted || {}, updatedAt: Date.now() };
      await store.setJSON(LOCAL_OWNER_ID + '_profiles', merged);
      syncState.dirtyProfiles = false;
      syncState.lastSyncAt = Date.now();
      saveSyncState();
      pullRemoteAssets(collectAssetIds(merged.profiles)).catch(() => { });
      return jsonRes({ ok: true, profiles: merged.profiles, deleted: merged.deleted, synced: true });
    }
    if (b.action === 'profiles-save') {
      syncState.dirtyProfiles = true;
      saveSyncState();
    }
    return jsonRes({ ok: true, profiles: localProfiles, deleted: localDeleted, synced: false });
  }

  // 4. "My themes" (two-way timestamp + tombstone merge across all devices on the code)
  if (b.action === 'themes-get' || b.action === 'themes-save') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    const localDoc = (await store.get(LOCAL_OWNER_ID + '_themes', { type: 'json' })) || {};
    const localThemes = Array.isArray(localDoc.themes) ? localDoc.themes : (Array.isArray(loc.j.themes) ? loc.j.themes : []);
    const localDeleted = (localDoc.deleted && typeof localDoc.deleted === 'object') ? localDoc.deleted : (loc.j.deleted || {});

    await pushLocalAssets(collectAssetIds(localThemes));
    const r = await remotePost({ action: 'themes-save', themes: localThemes, deleted: localDeleted }, 10000);
    if (r && r.ok && Array.isArray(r.j.themes)) {
      const merged = { themes: r.j.themes, deleted: r.j.deleted || {}, updatedAt: Date.now() };
      await store.setJSON(LOCAL_OWNER_ID + '_themes', merged);
      syncState.dirtyThemes = false;
      syncState.lastSyncAt = Date.now();
      saveSyncState();
      pullRemoteAssets(collectAssetIds(merged.themes)).catch(() => { });
      return jsonRes({ ok: true, themes: merged.themes, deleted: merged.deleted, synced: true });
    }
    if (b.action === 'themes-save') {
      syncState.dirtyThemes = true;
      saveSyncState();
    }
    return jsonRes({ ok: true, themes: localThemes, deleted: localDeleted, synced: false });
  }

  // 5. Current event setup (save / get)
  const cleanEv = cleanEventName(b.event || '');
  const evKey = cleanEv.toLowerCase() || '_';
  const docId = localDocId(cleanEv);

  if (b.action === 'save') {
    const loc = await localCall(b);
    if (!loc.ok) return loc.res;
    await pushLocalAssets(collectAssetIds(b.settings));
    const payload = { action: 'save', event: cleanEv, settings: b.settings };
    if ('image' in b) {
      payload.image = b.image;
    } else if (syncState.dirtySetups[evKey] && syncState.dirtySetups[evKey].imageChanged) {
      const savedDoc = await store.get(docId, { type: 'json' });
      payload.image = (savedDoc && savedDoc.hasImage) ? (await store.get(docId + '_img')) : null;
    }
    const r = await remotePost(payload, 10000);
    if (r && r.ok && r.j && r.j.ok) {
      const updatedAt = r.j.updatedAt || loc.j.updatedAt || Date.now();
      const curDoc = await store.get(docId, { type: 'json' });
      if (curDoc) await store.setJSON(docId, { ...curDoc, updatedAt });
      delete syncState.dirtySetups[evKey];
      syncState.lastSyncAt = Date.now();
      saveSyncState();
      return jsonRes({ ok: true, updatedAt, synced: true });
    }
    syncState.dirtySetups[evKey] = {
      event: cleanEv,
      at: loc.j.updatedAt || Date.now(),
      imageChanged: ('image' in b) || !!(syncState.dirtySetups[evKey] && syncState.dirtySetups[evKey].imageChanged)
    };
    saveSyncState();
    return jsonRes({ ok: true, updatedAt: loc.j.updatedAt || Date.now(), synced: false });
  }

  if (b.action === 'get') {
    const loc = await localCall(b);
    const rem = await remotePost({ action: 'get', event: cleanEv }, 8000);
    if (!rem || !rem.ok || !rem.j || !rem.j.ok) {
      return loc.res;
    }
    const locSettings = loc.ok && loc.j ? loc.j.settings : null;
    const locTs = (loc.ok && loc.j && loc.j.updatedAt) || 0;
    const locImg = (loc.ok && loc.j && loc.j.image) || null;
    const remSettings = rem.j.settings || null;
    const remTs = rem.j.updatedAt || 0;
    const remImg = rem.j.image || null;
    const isDirty = !!syncState.dirtySetups[evKey];

    // Local copy is newer or was edited while offline: push it to Netlify so other devices get it.
    if (locSettings && (isDirty || locTs > remTs)) {
      await pushLocalAssets(collectAssetIds(locSettings));
      const sr = await remotePost({
        action: 'save',
        event: cleanEv,
        settings: locSettings,
        image: locImg,
        updatedAt: locTs
      }, 10000);
      const finalTs = (sr && sr.ok && sr.j && sr.j.updatedAt) ? sr.j.updatedAt : locTs;
      if (sr && sr.ok) {
        await store.setJSON(docId, { settings: locSettings, updatedAt: finalTs, hasImage: !!locImg });
        delete syncState.dirtySetups[evKey];
        syncState.lastSyncAt = Date.now();
        saveSyncState();
      }
      return jsonRes({
        ...rem.j,
        settings: locSettings,
        updatedAt: finalTs,
        image: locImg,
        synced: !!(sr && sr.ok)
      });
    }

    // Remote copy is newer: cache it in the laptop's local store and return it.
    if (remSettings && remTs >= locTs) {
      const targetDocId = (rem.j.latestEvent && !cleanEv) ? localDocId(rem.j.latestEvent) : docId;
      if (remImg) await store.set(targetDocId + '_img', remImg);
      else await store.delete(targetDocId + '_img');
      await store.setJSON(targetDocId, { settings: remSettings, updatedAt: remTs, hasImage: !!remImg });
      if (targetDocId !== docId) {
        if (remImg) await store.set(docId + '_img', remImg);
        else await store.delete(docId + '_img');
        await store.setJSON(docId, { settings: remSettings, updatedAt: remTs, hasImage: !!remImg });
      }
      syncState.lastSyncAt = Date.now();
      saveSyncState();
      pullRemoteAssets(collectAssetIds(remSettings)).catch(() => { });
      return jsonRes({ ...rem.j, synced: true });
    }

    return jsonRes({ ...rem.j, synced: true });
  }

  const loc = await localCall(b);
  return loc.res;
}

// Background sync (runs on app start, after check-in, periodically while online, or when the operator clicks "Sync now").
let syncingNow = false;
export async function syncAllNow() {
  if (syncingNow || !FETCH_FN) return { ok: false, busy: true };
  const st = L.status();
  if (!st.ok || !L.currentLicence()) return { ok: false, reason: 'locked' };
  syncingNow = true;
  let changed = false;
  try {
    const store = getStore({ name: 'setups' });

    // 1. Flush any dirty assets (uploads / deletes queued while offline)
    const dirtyAssetIds = Object.keys(syncState.dirtyAssets || {});
    for (const aid of dirtyAssetIds) {
      const op = syncState.dirtyAssets[aid];
      if (op === 'del') {
        const r = await remotePost({ action: 'asset-delete', id: aid }, 8000);
        if (!r) return { ok: false, offline: true };
        if (r.ok) { delete syncState.dirtyAssets[aid]; delete syncState.syncedAssets[aid]; }
      } else {
        const data = await store.get(LOCAL_OWNER_ID + '_a_' + aid);
        if (!data) { delete syncState.dirtyAssets[aid]; continue; }
        const r = await remotePost({ action: 'asset-put', id: aid, data }, 15000);
        if (!r) return { ok: false, offline: true };
        if (r.ok) { syncState.syncedAssets[aid] = 1; delete syncState.dirtyAssets[aid]; }
      }
    }

    // Also scan all local asset blobs in the setups store so assets created before this update get uploaded too.
    const listed = await store.list({ prefix: LOCAL_OWNER_ID + '_a_' });
    const allLocalAssetIds = (listed && Array.isArray(listed.blobs) ? listed.blobs : [])
      .map((b) => String(b.key || '').slice((LOCAL_OWNER_ID + '_a_').length))
      .filter((id) => ASSET_ID_RE.test(id));
    if (allLocalAssetIds.length) {
      const ok = await pushLocalAssets(allLocalAssetIds);
      if (!ok) return { ok: false, offline: true };
    }

    // 2. Flush any dirty event setups queued while offline
    const dirtyEvKeys = Object.keys(syncState.dirtySetups || {});
    for (const evKey of dirtyEvKeys) {
      const info = syncState.dirtySetups[evKey];
      const evName = (info && info.event) || '';
      const dId = localDocId(evName);
      const localDoc = await store.get(dId, { type: 'json' });
      if (!localDoc || !localDoc.settings) { delete syncState.dirtySetups[evKey]; continue; }
      await pushLocalAssets(collectAssetIds(localDoc.settings));
      const payload = {
        action: 'save',
        event: evName,
        settings: localDoc.settings,
        updatedAt: localDoc.updatedAt || (info && info.at) || Date.now(),
        ifNewer: true
      };
      if (info && info.imageChanged) {
        payload.image = localDoc.hasImage ? (await store.get(dId + '_img')) : null;
      }
      const r = await remotePost(payload, 10000);
      if (!r) return { ok: false, offline: true };
      if (r.ok && r.j) {
        if (r.j.outdated && r.j.settings) {
          if (r.j.image) await store.set(dId + '_img', r.j.image);
          else await store.delete(dId + '_img');
          await store.setJSON(dId, { settings: r.j.settings, updatedAt: r.j.updatedAt, hasImage: !!r.j.image });
          pullRemoteAssets(collectAssetIds(r.j.settings)).catch(() => { });
          changed = true;
        } else if (r.j.updatedAt) {
          await store.setJSON(dId, { ...localDoc, updatedAt: r.j.updatedAt });
        }
        delete syncState.dirtySetups[evKey];
      }
    }

    // 3. Two-way merge Saved Profiles
    const profDoc = (await store.get(LOCAL_OWNER_ID + '_profiles', { type: 'json' })) || {};
    const localProfiles = Array.isArray(profDoc.profiles) ? profDoc.profiles : [];
    const localProfDel = (profDoc.deleted && typeof profDoc.deleted === 'object') ? profDoc.deleted : {};
    await pushLocalAssets(collectAssetIds(localProfiles));
    const pr = await remotePost({ action: 'profiles-save', profiles: localProfiles, deleted: localProfDel }, 10000);
    if (!pr) return { ok: false, offline: true };
    if (pr.ok && Array.isArray(pr.j.profiles)) {
      const sig = (arr) => (arr || []).map((p) => p.id + '@' + (p.savedAt || 0)).sort().join('|');
      if (sig(pr.j.profiles) !== sig(localProfiles)) changed = true;
      await store.setJSON(LOCAL_OWNER_ID + '_profiles', { profiles: pr.j.profiles, deleted: pr.j.deleted || {}, updatedAt: Date.now() });
      syncState.dirtyProfiles = false;
      await pullRemoteAssets(collectAssetIds(pr.j.profiles));
    }

    // 4. Two-way merge My Themes
    const thmDoc = (await store.get(LOCAL_OWNER_ID + '_themes', { type: 'json' })) || {};
    const localThemes = Array.isArray(thmDoc.themes) ? thmDoc.themes : [];
    const localThmDel = (thmDoc.deleted && typeof thmDoc.deleted === 'object') ? thmDoc.deleted : {};
    await pushLocalAssets(collectAssetIds(localThemes));
    const tr = await remotePost({ action: 'themes-save', themes: localThemes, deleted: localThmDel }, 10000);
    if (tr && tr.ok && Array.isArray(tr.j.themes)) {
      const sig = (arr) => (arr || []).map((t) => t.id + '@' + (t.savedAt || 0)).sort().join('|');
      if (sig(tr.j.themes) !== sig(localThemes)) changed = true;
      await store.setJSON(LOCAL_OWNER_ID + '_themes', { themes: tr.j.themes, deleted: tr.j.deleted || {}, updatedAt: Date.now() });
      syncState.dirtyThemes = false;
      await pullRemoteAssets(collectAssetIds(tr.j.themes));
    }

    // 5. Two-way merge Account Uploaded Frames
    const frLoc = await localCall({ action: 'frames-get' });
    const frDoc = (await store.get(LOCAL_OWNER_ID + '_frames', { type: 'json' })) || {};
    const localFrames = Array.isArray(frDoc.frames) ? frDoc.frames : (Array.isArray(frLoc.j && frLoc.j.frames) ? frLoc.j.frames : []);
    const localFrDel = (frDoc.deleted && typeof frDoc.deleted === 'object') ? frDoc.deleted : ((frLoc.j && frLoc.j.deleted) || {});
    await pushLocalAssets(collectAssetIds(localFrames));
    const fr = await remotePost({ action: 'frames-save', frames: localFrames, deleted: localFrDel }, 15000);
    if (fr && fr.ok && Array.isArray(fr.j.frames)) {
      const sig = (arr) => (arr || []).map((f) => f.id + '@' + (f.savedAt || 0)).sort().join('|');
      if (sig(fr.j.frames) !== sig(localFrames)) changed = true;
      await store.setJSON(LOCAL_OWNER_ID + '_frames', { frames: fr.j.frames, deleted: fr.j.deleted || {}, updatedAt: fr.j.updatedAt || Date.now(), rescued: true });
      syncState.dirtyFrames = false;
      await pullRemoteAssets(collectAssetIds(fr.j.frames));
    }

    syncState.lastSyncAt = Date.now();
    saveSyncState();
    if (changed && ON_SYNCED) {
      try { ON_SYNCED({ lastSyncAt: syncState.lastSyncAt }); } catch { /* ignore */ }
    }
    return { ok: true, changed, lastSyncAt: syncState.lastSyncAt };
  } finally {
    syncingNow = false;
  }
}
