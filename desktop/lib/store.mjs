// A stand-in for @netlify/blobs that keeps everything in files on this laptop.
// The booth's own server code (netlify/functions, copied in by
// scripts/prepare.mjs) imports getStore() from here instead, so setup saves,
// themes, PINs, vouchers and print counts all work with no internet.
//
//   <data dir>/<store name>/<encoded key>.json
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let ROOT = null;
export function setStoreRoot(dir) { ROOT = dir; mkdirSync(dir, { recursive: true }); }

// Keys can hold "/" and other characters files can't; this keeps them readable
// and reversible (and case-safe on Mac / Windows, which ignore case).
const enc = (k) => String(k).replace(/[^a-z0-9._-]/g, (c) => '~' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const dec = (f) => f.replace(/~([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

const stores = new Map();
export function getStore(opts) {
  const name = String(typeof opts === 'string' ? opts : opts && opts.name).replace(/[^a-z0-9_-]/gi, '');
  if (!ROOT) throw new Error('Local store is not ready');
  if (stores.has(name)) return stores.get(name);
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const file = (k) => join(dir, enc(k) + '.v');
  const st = {
    async get(k, o) {
      const f = file(k);
      if (!existsSync(f)) return null;
      let v;
      try { v = readFileSync(f, 'utf8'); } catch { return null; }
      if (o && o.type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    },
    async set(k, v) {
      const f = file(k), tmp = f + '.tmp' + process.pid;
      writeFileSync(tmp, String(v));
      renameSync(tmp, f);
    },
    async setJSON(k, v) { return st.set(k, JSON.stringify(v)); },
    async delete(k) { try { rmSync(file(k), { force: true }); } catch { /* gone */ } },
    async list(o) {
      const p = (o && o.prefix) || '';
      let names = [];
      try { names = readdirSync(dir); } catch { names = []; }
      const keys = names.filter((n) => n.endsWith('.v')).map((n) => dec(n.slice(0, -2))).filter((k) => k.startsWith(p));
      return { blobs: keys.map((key) => ({ key, etag: '' })), directories: [] };
    }
  };
  stores.set(name, st);
  return st;
}
