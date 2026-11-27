// Optional DNP Hot Folder Print (HFP) exporter for Windows & macOS.
//
// Lets operators register any watched folder (e.g. C:\DNP\Hot Folder\Prints\4x6, ...\2x6, or
// ~/Documents/HotFolderPrint/Prints/4x6) as a virtual printer ("Hot Folder: DNP 4x6").
//
// Uses atomic write (.pb4u-*.tmp -> rename to pb4u_<ts>_<seq>.jpg/.png) so DNP Hot Folder Print
// never picks up a partially written file. Works automatically with Printer 1, 2x6 Split Strips
// Printer, Auto-Print, Lightness/Colour/Edges, and Offline Laptop Print Station (iPad & Android).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const HOT_FOLDER_PREFIX = 'Hot Folder: ';
const MAX_HOT_FOLDERS = 24;
const SKIP_SUBDIRS = new Set(['archive', 'archives', 'error', 'errors', 'backup', 'backups', 'log', 'logs', 'temp', 'tmp', 'processed', 'done']);

let dropSeq = 0;

export function isHotFolderPrinterName(name) {
  return String(name || '').startsWith(HOT_FOLDER_PREFIX);
}

export function sanitizeHotFolderLabel(raw, fallbackDir = '') {
  const clean = String(raw || '')
    .replace(/^Hot\s*Folder\s*:\s*/i, '')
    .replace(/[\r\n\t\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  if (clean) return clean;
  const base = basename(String(fallbackDir || '').replace(/[\\/]+$/, '')) || 'DNP';
  return ('DNP ' + base).slice(0, 48);
}

export function hotFolderPrinterName(label) {
  return HOT_FOLDER_PREFIX + sanitizeHotFolderLabel(label);
}

function guessHotFolderMeta(subName) {
  const s = String(subName || '').toLowerCase();
  const twoUp = /(?:^|[^0-9])2\s*[x×]\s*6(?:$|[^0-9])|split|2[\s_-]?up|2[\s_-]?cut|2[\s_-]?in(?:ch)?|(?:4\s*[x×]\s*6|6\s*[x×]\s*4)[\s_-]*(?:\*|x)?2(?:$|[^0-9])/i.test(s);
  let widthMm = 101.6, heightMm = 152.4;
  if (/3\.5\s*[x×]\s*5|3r/.test(s)) { widthMm = 88.9; heightMm = 127.0; }
  else if (/5\s*[x×]\s*7|5r/.test(s)) { widthMm = 127.0; heightMm = 177.8; }
  else if (/6\s*[x×]\s*8|6r/.test(s)) { widthMm = 152.4; heightMm = 203.2; }
  else if (/6\s*[x×]\s*9/.test(s)) { widthMm = 152.4; heightMm = 228.6; }
  else if (/8\s*[x×]\s*10|8r/.test(s)) { widthMm = 203.2; heightMm = 254.0; }
  else if (/8\s*[x×]\s*12/.test(s)) { widthMm = 203.2; heightMm = 304.8; }
  else if (/6\s*[x×]\s*14/.test(s)) { widthMm = 152.4; heightMm = 355.6; }
  else if (/6\s*[x×]\s*20/.test(s)) { widthMm = 152.4; heightMm = 508.0; }
  else if (/4\.5\s*[x×]\s*8/.test(s)) { widthMm = 114.3; heightMm = 203.2; }
  return { twoUp, widthMm, heightMm };
}

/**
 * Scans standard Windows & macOS DNP Hot Folder Print (HFP) installation roots and returns
 * discovered print-size watch folders (e.g. 4x6, 2x6, 5x7, 6x8, 6x14).
 */
export function detectDnpHotFolders({ platform = process.platform, home = homedir(), extraRoots = [] } = {}) {
  const roots = [
    ...(Array.isArray(extraRoots) ? extraRoots : []),
    ...(platform === 'win32'
      ? [
        'C:\\DNP\\Hot Folder\\Prints',
        'C:\\DNP\\HotFolder\\Prints',
        'C:\\DNP\\HotFolderPrint\\Prints',
        join(home, 'Documents', 'HotFolderPrint', 'Prints'),
        join(home, 'Documents', 'DNP', 'Hot Folder', 'Prints'),
        join(home, 'Documents', 'DNP', 'HotFolder', 'Prints')
      ]
      : [
        join(home, 'Documents', 'HotFolderPrint', 'Prints'),
        join(home, 'Documents', 'DNP', 'HotFolder', 'Prints'),
        join(home, 'Documents', 'DNP', 'Hot Folder', 'Prints')
      ])
  ];

  const found = [];
  const seenDirs = new Set();
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let st;
    try { st = statSync(root); } catch { continue; }
    if (!st.isDirectory()) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    let subFound = 0;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      if (SKIP_SUBDIRS.has(ent.name.toLowerCase())) continue;
      const full = resolve(join(root, ent.name));
      const key = platform === 'win32' ? full.toLowerCase() : full;
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      const meta = guessHotFolderMeta(ent.name);
      const label = sanitizeHotFolderLabel('DNP ' + ent.name, full);
      found.push({
        label,
        printerName: hotFolderPrinterName(label),
        dir: full,
        subName: ent.name,
        format: 'jpg',
        ...meta
      });
      subFound++;
      if (found.length >= MAX_HOT_FOLDERS) return found;
    }
    if (subFound === 0) {
      const full = resolve(root);
      const key = platform === 'win32' ? full.toLowerCase() : full;
      if (!seenDirs.has(key)) {
        seenDirs.add(key);
        const label = sanitizeHotFolderLabel('DNP Hot Folder', full);
        found.push({
          label,
          printerName: hotFolderPrinterName(label),
          dir: full,
          subName: basename(full),
          format: 'jpg',
          twoUp: false,
          widthMm: 101.6,
          heightMm: 152.4
        });
      }
    }
  }
  return found;
}

function formatTimestamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${p3(d.getMilliseconds())}`;
}

/**
 * Atomically drops one or more page buffers into a watched Hot Folder.
 * Writes each page to a dot-prefixed `.tmp` file first, then atomically renames to `.jpg` or `.png`
 * so DNP Hot Folder Print never reads a half-written image.
 */
export async function dropToHotFolder(entry, pageItems, { toJpeg = null } = {}) {
  if (!entry || !entry.dir) throw new Error('Hot Folder has no target directory.');
  const dir = resolve(String(entry.dir));
  await mkdir(dir, { recursive: true });
  const items = (Array.isArray(pageItems) ? pageItems : []).map((p) => (Buffer.isBuffer(p) ? { buf: p, ext: 'png' } : p));
  if (!items.length) throw new Error('No pages to send to Hot Folder.');

  const wantFmt = entry.format === 'png' ? 'png' : 'jpg';
  const written = [];
  const ts = formatTimestamp();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let outBuf = Buffer.isBuffer(it.buf) ? it.buf : Buffer.from(it.buf);
    let ext = it.ext === 'jpg' || it.ext === 'jpeg' ? 'jpg' : 'png';
    if (wantFmt === 'jpg' && ext !== 'jpg' && typeof toJpeg === 'function') {
      try {
        const j = await toJpeg(outBuf);
        if (j && j.length) { outBuf = j; ext = 'jpg'; }
      } catch { /* fall back to original PNG buffer */ }
    }
    const seq = String(++dropSeq).padStart(4, '0');
    const rnd = randomBytes(3).toString('hex');
    const tmpPath = join(dir, `.pb4u-${ts}-${seq}-${rnd}.tmp`);
    const finalName = `pb4u_${ts}_${seq}${items.length > 1 ? '_p' + (i + 1) : ''}.${ext}`;
    const finalPath = join(dir, finalName);
    try {
      await writeFile(tmpPath, outBuf);
      await rename(tmpPath, finalPath);
      written.push(finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => { });
      throw new Error(`Could not write to Hot Folder "${dir}": ${(err && err.message) || err}`);
    }
  }
  return { ok: true, dir, files: written };
}

/**
 * Persistent store of operator-configured Hot Folder targets (JSON file on disk).
 */
export function createHotFolderStore(filePath = '') {
  const byName = new Map(); // "Hot Folder: <label>" -> { name, label, dir, format, widthMm, heightMm, twoUp }

  function load(pathOverride) {
    const fp = pathOverride !== undefined ? pathOverride : filePath;
    if (pathOverride !== undefined) filePath = fp;
    byName.clear();
    if (!fp || !existsSync(fp)) return;
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf8'));
      for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item.dir !== 'string' || !item.dir.trim()) continue;
        const dir = resolve(item.dir.trim());
        const label = sanitizeHotFolderLabel(item.label || item.name, dir);
        const name = hotFolderPrinterName(label);
        const meta = guessHotFolderMeta(label + ' ' + basename(dir));
        byName.set(name, {
          name,
          label,
          dir,
          format: item.format === 'png' ? 'png' : 'jpg',
          twoUp: typeof item.twoUp === 'boolean' ? item.twoUp : meta.twoUp,
          widthMm: Number(item.widthMm) > 0 ? Number(item.widthMm) : meta.widthMm,
          heightMm: Number(item.heightMm) > 0 ? Number(item.heightMm) : meta.heightMm
        });
        if (byName.size >= MAX_HOT_FOLDERS) break;
      }
    } catch { /* ignore corrupt or empty file */ }
  }

  function save() {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify([...byName.values()], null, 2), 'utf8');
    } catch { /* ignore disk errors */ }
  }

  function list() {
    return [...byName.values()].map((x) => ({ ...x, exists: existsSync(x.dir) }));
  }

  function names() {
    return [...byName.keys()];
  }

  function get(printerName) {
    return byName.get(String(printerName || '')) || null;
  }

  function add({ label = '', name = '', dir = '', format = 'jpg', createIfMissing = true } = {}) {
    const rawDir = String(dir || '').trim();
    if (!rawDir || /[\r\n\0]/.test(rawDir)) return { ok: false, error: 'Choose a valid folder path.' };
    if (!isAbsolute(rawDir)) return { ok: false, error: 'Enter a full folder path (for example C:\\DNP\\Hot Folder\\Prints\\4x6).' };
    const absDir = resolve(rawDir);
    if (!existsSync(absDir)) {
      if (!createIfMissing) return { ok: false, error: 'Folder does not exist: ' + absDir };
      try { mkdirSync(absDir, { recursive: true }); }
      catch (e) { return { ok: false, error: 'Could not create folder: ' + ((e && e.message) || e) }; }
    } else {
      try {
        if (!statSync(absDir).isDirectory()) return { ok: false, error: 'Path is a file, not a folder: ' + absDir };
      } catch (e) {
        return { ok: false, error: 'Cannot access folder: ' + ((e && e.message) || e) };
      }
    }
    const cleanLabel = sanitizeHotFolderLabel(label || name, absDir);
    const printerName = hotFolderPrinterName(cleanLabel);
    if (!byName.has(printerName) && byName.size >= MAX_HOT_FOLDERS) {
      return { ok: false, error: 'Too many Hot Folders saved (max ' + MAX_HOT_FOLDERS + '). Remove one first.' };
    }
    const meta = guessHotFolderMeta(cleanLabel + ' ' + basename(absDir));
    const entry = {
      name: printerName,
      label: cleanLabel,
      dir: absDir,
      format: format === 'png' ? 'png' : 'jpg',
      ...meta
    };
    byName.set(printerName, entry);
    save();
    return { ok: true, printer: printerName, entry: { ...entry, exists: true } };
  }

  function remove(printerName) {
    const key = String(printerName || '').trim();
    const deleted = byName.delete(key) || byName.delete(hotFolderPrinterName(key));
    if (deleted) save();
    return { ok: true, removed: deleted };
  }

  if (filePath) load(filePath);
  return { load, list, names, get, add, remove };
}
