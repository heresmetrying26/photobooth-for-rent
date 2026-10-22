// The booth's server, running inside the app.
//
// scripts/prepare.mjs copies the web app's own Netlify functions (setup, pay,
// prints, verify, app) into build/server, with their storage pointed at files
// on this laptop (lib/store.mjs). Here we:
//  - turn the signed licence into a local "code" record those functions read
//    (print sizes, vouchers, retakes, lock, mode, folder name… all from Admin)
//  - sign a local booth token for it (a random secret kept on this laptop)
//  - answer the booth's /api/* calls with those functions
//  - build the booth page (/api/app) and add the app's own bits to it
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setStoreRoot, getStore } from './store.mjs';

const LOCAL_KEY = 'LOCAL';
const LIFETIME_EXP = 253402300799000;
let BUILD = null, core = null, routes = null, booth = '';

export function initServer({ buildDir, dataDir }) {
  BUILD = buildDir;
  setStoreRoot(join(dataDir, 'store'));
  // Secrets the copied functions need, made once per laptop.
  const f = join(dataDir, 'secrets.json');
  let s = null;
  try { s = JSON.parse(readFileSync(f, 'utf8')); } catch { s = null; }
  if (!s || !s.TOKEN_SECRET) {
    s = { TOKEN_SECRET: randomBytes(32).toString('base64url'), UPLOAD_SECRET: randomBytes(32).toString('base64url'), PB_VAULT_KEY: randomBytes(32).toString('base64url') };
    writeFileSync(f, JSON.stringify(s));
  }
  Object.assign(process.env, s);
  process.env.PAYMONGO_API_BASE = 'http://127.0.0.1:9/offline';   // QR payments are online-only; never call out
}
export function setBoothHtml(html) { booth = html; globalThis.__pb4uBooth = html; }

async function load() {
  if (routes) return;
  const dir = join(BUILD, 'server');
  core = await import(pathToFileURL(join(dir, 'lib', 'core.mjs')).href);
  routes = {};
  for (const name of ['app', 'verify', 'setup', 'pay', 'prints']) {
    const f = join(dir, 'functions', name + '.mjs');
    if (!existsSync(f)) continue;
    const m = await import(pathToFileURL(f).href);
    routes[m.config.path] = m.default;
  }
}

// The local code record, rebuilt from the licence each time it changes.
export async function syncRecord(p, deviceId, ok) {
  await load();
  const feat = (p && p.feat) || {};
  const store = getStore({ name: 'licenses' });
  const old = (await store.get(LOCAL_KEY, { type: 'json' })) || {};
  const exp = Math.min(p && p.exp ? p.exp : LIFETIME_EXP, p && p.hard ? p.hard : LIFETIME_EXP);
  const rec = {
    ...old,
    code: LOCAL_KEY, kind: 'rental', status: ok ? 'active' : 'revoked',
    redeemedAt: old.redeemedAt || Date.now(), expiresAt: exp,
    lifetime: !!(p && p.lifetime), label: (p && p.renter) || '',
    folderName: (p && p.lifetime ? feat.folderPrefix : feat.folderKey) || (p && p.renter) || '',
    print: feat.print || { enabled: false, sizes: [] },
    traditional: !!feat.traditional, retakeOpt: !!feat.retakeOpt, payOpt: !!feat.vouchers, lockOpt: !!feat.lockOpt,
    pinResetAt: feat.pinResetAt || 0, defaultTheme: feat.defaultTheme || null,
    maxDevices: feat.multiDevice ? 10 : 1,
    devices: [{ id: deviceId, no: feat.deviceNo || 1, at: old.redeemedAt || Date.now() }],
    nextDeviceNo: (feat.deviceNo || 1) + 1, deviceId
  };
  await store.setJSON(LOCAL_KEY, rec);
  return rec;
}
export async function localToken(deviceId) {
  await load();
  const rec = await getStore({ name: 'licenses' }).get(LOCAL_KEY, { type: 'json' });
  return core.sign({ t: 'rental', k: LOCAL_KEY, d: deviceId, exp: rec ? rec.expiresAt : Date.now() });
}

export async function handleApi(req, pathname) {
  await load();
  const fn = routes[pathname];
  if (!fn) return new Response(JSON.stringify({ error: 'This needs the internet version (photobooth4u.netlify.app).' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return fn(req, { ip: '127.0.0.1' });
}

// The booth page, exactly as the web app makes it, plus the app's extras.
export async function boothPage({ deviceId, extraHead }) {
  await load();
  const token = await localToken(deviceId);
  const res = await routes['/api/app'](new Request('app://booth/api/app', { headers: { authorization: 'Bearer ' + token, 'x-device-id': deviceId } }), { ip: '127.0.0.1' });
  if (res.status !== 200) return { locked: true, reason: ((await res.json().catch(() => ({}))).reason) || 'invalid' };
  let html = await res.text();
  const head = '<script>try{localStorage.setItem("pb_token",' + JSON.stringify(res.headers.get('x-refreshed-token') || token) + ');localStorage.setItem("pb_device",' + JSON.stringify(deviceId) + ');}catch(e){}</script>' + (extraHead || '');
  const at = html.indexOf('<script>window.__PB=');
  const end = at >= 0 ? html.indexOf('</script>', at) : -1;
  html = end >= 0 ? html.slice(0, end + 9) + head + html.slice(end + 9) : head + html;
  return { html };
}
export const hasBooth = () => !!booth;
