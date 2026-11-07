// Storage for phone uploads (QR). On Netlify this is Netlify Blobs.
// When running locally with dev-server.mjs (globalThis.__RUSHID_LOCAL) it is plain memory,
// so the whole app can be tried without a Netlify account.
import { getStore } from '@netlify/blobs';

const mem = new Map(); // store name -> Map(key -> { data:Buffer|string, metadata })

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
function conv(data, type) {
  if (type === 'json') return JSON.parse(String(data));
  if (type === 'arrayBuffer') { const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data)); return toArrayBuffer(b); }
  return String(data);
}

function memStore(name) {
  if (!mem.has(name)) mem.set(name, new Map());
  const m = mem.get(name);
  return {
    async get(key, o = {}) { const e = m.get(key); return e ? conv(e.data, o.type) : null; },
    async getWithMetadata(key, o = {}) { const e = m.get(key); return e ? { data: conv(e.data, o.type), metadata: e.metadata } : null; },
    async set(key, data, o = {}) { m.set(key, { data: typeof data === 'string' ? data : Buffer.from(data), metadata: o.metadata || {} }); },
    async setJSON(key, obj, o = {}) { m.set(key, { data: JSON.stringify(obj), metadata: o.metadata || {} }); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}

export const store = (name) => (globalThis.__RUSHID_LOCAL ? memStore(name) : getStore({ name, consistency: 'strong' }));
