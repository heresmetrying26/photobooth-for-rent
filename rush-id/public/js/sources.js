// Where photos come from besides the camera: a USB drive / SD card (a folder), the folder
// Bluetooth files are received into, and the phone QR session.
const IMG_RE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const SKIP = /^(\.|\$|system volume information|windows|program files)/i;

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

export async function pickFolder(id) {
  try { return await window.showDirectoryPicker({ id: id || 'rushid', mode: 'read' }); }
  catch (e) { return null; }   // cancelled
}

// All photos in a drive/folder (SD cards keep them in DCIM/100xxxxx, so we look a few folders deep).
export async function listImages(dir, depth = 3, cap = 600, prefix = '', out = []) {
  for await (const [name, h] of dir.entries()) {
    if (out.length >= cap) break;
    if (h.kind === 'file') { if (IMG_RE.test(name)) out.push({ name, handle: h, path: prefix + name }); }
    else if (depth > 0 && !SKIP.test(name)) await listImages(h, depth - 1, cap, prefix + name + '/', out);
  }
  return out;
}

// Calls onNew(file) for every photo that appears in the folder from now on (Bluetooth inbox, a card reader...).
// A file is only taken once its size stopped changing, so half-received photos are never picked up.
export function watchFolder(dir, onNew) {
  const seen = new Map(), pending = new Map();
  let stopped = false, first = true;
  const tick = async () => {
    if (stopped) return;
    try {
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || !IMG_RE.test(name)) continue;
        const f = await h.getFile(), key = f.lastModified + ':' + f.size;
        if (seen.get(name) === key) continue;
        if (first) { seen.set(name, key); continue; }
        if (pending.get(name) === key && f.size > 0) { pending.delete(name); seen.set(name, key); onNew(f); }
        else pending.set(name, key);
      }
      first = false;
    } catch (e) { /* folder unplugged: keep trying, it may come back */ }
    if (!stopped) setTimeout(tick, 1500);
  };
  tick();
  return () => { stopped = true; };
}

// ---------- phone QR session ----------
// The gated /rush version sets window.__RUSH = { api, uploadPath, headers() }; the standalone app uses the defaults.
const RC = () => window.__RUSH || {};
const apiUrl = () => RC().api || '/api/session';
const authHeaders = () => (RC().headers ? RC().headers() : {});
const jsonHeaders = () => ({ 'content-type': 'application/json', ...authHeaders() });
export class PhoneSession {
  constructor(onPhoto, onStatus) { this.onPhoto = onPhoto; this.onStatus = onStatus; this.got = new Set(); this.count = 0; }
  async call(body) {
    return fetch(apiUrl(), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ...body, code: this.code, secret: this.secret }) });
  }
  async start() {
    const r = await fetch(apiUrl(), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ action: 'create' }) });
    if (r.status === 401) throw new Error('This station is locked. Ask the owner to switch it on.');
    if (!r.ok) throw new Error('Could not start a phone session.');
    const j = await r.json(); this.code = j.code; this.secret = j.secret;
    this.timer = setInterval(() => this.poll(), 2500);
    return this;
  }
  get url() { return location.origin + (RC().uploadPath || '/u/') + this.code; }
  async poll() {
    if (this.busy || !this.code) return;
    this.busy = true;
    try {
      const r = await this.call({ action: 'list' });
      if (r.status === 404) { this.onStatus('expired'); this.stop(); return; }
      const { ids } = await r.json();
      for (const id of ids) {
        if (this.got.has(id)) continue;
        const g = await this.call({ action: 'get', id });
        if (!g.ok) continue;
        const blob = await g.blob(); const name = decodeURIComponent(g.headers.get('x-name') || '') || 'phone.jpg';
        this.got.add(id);
        await this.onPhoto(new File([blob], name, { type: blob.type }));
        this.count++;
        await this.call({ action: 'del', id }).catch(() => {});
        this.onStatus('ok');
      }
      this.onStatus('ok');
    } catch (e) { this.onStatus('offline'); }
    finally { this.busy = false; }
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.code) { const body = JSON.stringify({ action: 'close', code: this.code, secret: this.secret }); this.code = null; fetch(apiUrl(), { method: 'POST', headers: jsonHeaders(), body, keepalive: true }).catch(() => {}); }
  }
}
