// Shared PTP movie transfer + Canon EOS exposure helpers for Mac / WinUSB drivers.
// Keeps chunked movie downloads off the Node heap by streaming directly to disk (.part -> atomic rename).
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { OK, CamError, GoneError, hex } from './ptp.mjs';

const VIDEO_EXTS = new Set(['.mov', '.mp4', '.avi', '.m4v']);
const STILL_OR_RAW_EXTS = new Set(['.jpg', '.jpeg', '.thm', '.cr2', '.cr3', '.nef', '.crw', '.arw']);

/**
 * Determine whether a PTP object format or filename extension represents a still image, thumbnail, or RAW file.
 * @param {number} fmt
 * @param {string} ext
 * @returns {boolean}
 */
export function isStillOrRaw(fmt, ext) {
  const e = (ext || '').toLowerCase();
  if (STILL_OR_RAW_EXTS.has(e)) return true;
  return fmt === 0x3801 || fmt === 0x3001 || fmt === 0xB101 || fmt === 0xB103 || fmt === 0xB108;
}

/**
 * Read PTP GetObjectInfo (0x1008) for format code, byte size, filename, and inferred file extension.
 * @param {import('./ptp.mjs').PtpSession} ptp
 * @param {number} handle
 */
export async function ptpObjectMeta(ptp, handle) {
  let fmt = 0, size = 0, ext = '', origName = '';
  try {
    const { resp, data } = await ptp.opRead(0x1008, handle);
    if (resp !== OK || !data || data.length < 12) return { fmt, size, ext, origName };
    fmt = data.readUInt16LE(4);
    size = data.readUInt32LE(8);
    if (data.length >= 54) {
      const nlen = data[52];
      if (nlen > 0 && 53 + nlen * 2 <= data.length) {
        origName = data.subarray(53, 53 + nlen * 2).toString('utf16le').replace(/\0+$/, '');
        const pe = path.extname(origName).toLowerCase();
        if (VIDEO_EXTS.has(pe) || STILL_OR_RAW_EXTS.has(pe)) ext = pe;
      }
    }
    if (!ext) {
      if (fmt === 0xB982) ext = '.mp4';
      else if (fmt === 0x300B) ext = '.avi';
      else if (fmt === 0x300D) ext = '.mov';
      else if (fmt === 0x3801 || fmt === 0x3001) ext = '.jpg';
    }
  } catch (e) {
    if (e instanceof GoneError) throw e;
  }
  return { fmt, size, ext, origName };
}

/**
 * Stream a recorded movie handle over PTP directly to a file inside outDir.
 * Writes `<final>.part` + `<final>.part.meta` during transfer so UI progress polling can read live bytes,
 * then atomically renames to the final `.mov`/`.mp4` file.
 */
export async function streamObjectToFile(ptp, handle, size, ext, outDir, prefix = 'dslr-360-', opts = {}) {
  const safeDir = String(outDir || '').trim().replace(/^["']|["']$/g, '');
  if (!safeDir || !fs.existsSync(safeDir)) {
    throw new CamError('BAD Destination folder for movie download does not exist: ' + safeDir);
  }
  let targetExt = ext || '.mov';
  let targetSize = Number(size) || 0;
  if (targetSize === 0) {
    const meta = await ptpObjectMeta(ptp, handle);
    if (meta.size > 0) targetSize = meta.size;
    if (meta.ext && targetExt === '.mov') targetExt = meta.ext;
  }
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const fileName = `${prefix}${stamp}${targetExt}`;
  const finalPath = path.join(safeDir, fileName);
  const partPath = finalPath + '.part';
  const metaPath = partPath + '.meta';
  const notes = [];
  let committed = false;
  let off = 0;

  try {
    try { await fsp.writeFile(metaPath, JSON.stringify({ total: targetSize, filename: fileName })); } catch { /* ignore */ }
    const pieceOps = opts.canonPiece ? [0x101B, 0x9107] : [0x101B];
    const fh = await fsp.open(partPath, 'w');
    try {
      for (const piece of pieceOps) {
        await fh.truncate(0);
        off = 0;
        let pr = 0;
        try {
          if (targetSize > 0) {
            while (off < targetSize) {
              const g = await ptp.opRead(piece, handle, off, Math.min(1048576, targetSize - off));
              pr = g.resp;
              if (pr !== OK || !g.data || g.data.length === 0) break;
              await fh.write(g.data, 0, g.data.length, off);
              off += g.data.length;
            }
          } else {
            for (;;) {
              const g = await ptp.opRead(piece, handle, off, 1048576);
              pr = g.resp;
              if (pr !== OK || !g.data || g.data.length === 0) break;
              await fh.write(g.data, 0, g.data.length, off);
              off += g.data.length;
              if (g.data.length < 1048576) break;
            }
          }
        } catch (e) {
          if (e instanceof GoneError) throw e;
          pr = 0;
        }
        notes.push(`${hex(piece)} ${hex(pr)} ${off}/${targetSize}`);
        if (off >= 16 && (targetSize === 0 || off >= targetSize)) break;
      }

      if (off === 0 || (targetSize > 0 && off < targetSize)) {
        try {
          const g = await ptp.opRead(0x1009, handle);
          if (g.resp === OK && g.data && g.data.length >= 16) {
            await fh.truncate(0);
            await fh.write(g.data, 0, g.data.length, 0);
            off = g.data.length;
            notes.push(`0x1009 ${off}`);
          }
        } catch (e) {
          if (e instanceof GoneError) throw e;
        }
      }
    } finally {
      await fh.close().catch(() => {});
    }

    if (off < 16 || (targetSize > 0 && off < targetSize)) {
      throw new CamError(`CAPTURE Incomplete movie download from camera (${off} / ${targetSize} B; ${notes.join('; ')}).`);
    }
    if (fs.existsSync(finalPath)) await fsp.unlink(finalPath).catch(() => {});
    await fsp.rename(partPath, finalPath);
    committed = true;
    return { ok: true, path: finalPath, filename: fileName, bytes: off, format: targetExt.replace(/^\./, ''), notes };
  } finally {
    await fsp.unlink(metaPath).catch(() => {});
    if (!committed) await fsp.unlink(partPath).catch(() => {});
  }
}

// Canon EOS APEX code tables matching tools/print-helper/camera-worker.ps1
export const CANON_TV = new Map([
  [0x10, 30], [0x18, 15], [0x20, 8], [0x28, 4], [0x30, 2], [0x38, 1], [0x3B, 0.8], [0x3D, 0.6],
  [0x40, 0.5], [0x43, 0.4], [0x45, 0.3], [0x48, 0.25], [0x4B, 0.2], [0x4D, 0.16],
  [0x50, 0.125], [0x53, 0.1], [0x55, 1 / 13], [0x58, 1 / 15], [0x5B, 1 / 20], [0x5C, 1 / 20], [0x5D, 1 / 25],
  [0x60, 1 / 30], [0x63, 1 / 40], [0x64, 1 / 45], [0x65, 1 / 50], [0x68, 1 / 60], [0x6B, 1 / 80], [0x6C, 1 / 90], [0x6D, 1 / 100],
  [0x70, 1 / 125], [0x73, 1 / 160], [0x74, 1 / 180], [0x75, 1 / 200], [0x78, 1 / 250], [0x7B, 1 / 320], [0x7C, 1 / 350], [0x7D, 1 / 400],
  [0x80, 1 / 500], [0x83, 1 / 640], [0x84, 1 / 750], [0x85, 1 / 800], [0x88, 1 / 1000], [0x8B, 1 / 1250], [0x8C, 1 / 1500], [0x8D, 1 / 1600],
  [0x90, 1 / 2000], [0x93, 1 / 2500], [0x94, 1 / 3000], [0x95, 1 / 3200], [0x98, 1 / 4000], [0xA0, 1 / 8000]
]);

export const CANON_AV = new Map([
  [0x08, 1.0], [0x0B, 1.1], [0x0C, 1.2], [0x0D, 1.2], [0x10, 1.4], [0x13, 1.6], [0x14, 1.8], [0x15, 1.8],
  [0x18, 2.0], [0x1B, 2.2], [0x1C, 2.5], [0x1D, 2.5], [0x20, 2.8], [0x23, 3.2], [0x24, 3.5], [0x25, 3.5],
  [0x28, 4.0], [0x2B, 4.5], [0x2C, 4.5], [0x2D, 5.0], [0x30, 5.6], [0x33, 6.3], [0x34, 6.7], [0x35, 7.1],
  [0x38, 8.0], [0x3B, 9.0], [0x3C, 9.5], [0x3D, 10], [0x40, 11], [0x43, 13], [0x44, 13], [0x45, 14],
  [0x48, 16], [0x4B, 18], [0x4C, 19], [0x4D, 20], [0x50, 22], [0x53, 25], [0x55, 29], [0x58, 32]
]);

export const CANON_ISO = new Map([
  [0x00, 0], [0x40, 50], [0x48, 100], [0x4B, 125], [0x4D, 160], [0x50, 200], [0x53, 250], [0x55, 320],
  [0x58, 400], [0x5B, 500], [0x5D, 640], [0x60, 800], [0x63, 1000], [0x65, 1250], [0x68, 1600],
  [0x6B, 2000], [0x6D, 2500], [0x70, 3200], [0x73, 4000], [0x75, 5000], [0x78, 6400], [0x7B, 8000],
  [0x7D, 10000], [0x80, 12800], [0x88, 25600], [0x90, 51200]
]);

export const CANON_WB_LABELS = new Map([
  [0, 'Auto'], [1, 'Daylight'], [2, 'Shade'], [3, 'Cloudy'], [4, 'Tungsten'],
  [5, 'Fluorescent'], [6, 'Flash'], [8, 'Custom'], [9, 'Kelvin']
]);

const HALF_STOP_ALIAS = new Set([0x0C, 0x14, 0x1C, 0x24, 0x2C, 0x34, 0x44, 0x4C, 0x5C, 0x64, 0x6C, 0x74, 0x7C, 0x84, 0x8C, 0x94]);

function canonCanSet(eosVals, eosAvail, prop) {
  const av = eosAvail.get(prop);
  if (av && av.length > 0) return av.length > 1;
  return eosVals.has(prop);
}

function canonPickApex(eosAvail, prop, want, table) {
  if (!(want > 0)) return -1;
  const av = eosAvail.get(prop);
  const hasAv = !!(av && av.length > 0);
  let bestCode = -1, bestD = Infinity;
  for (const [c, v] of table.entries()) {
    if (!(v > 0)) continue;
    if (hasAv) { if (!av.includes(c)) continue; }
    else if (HALF_STOP_ALIAS.has(c)) continue;
    const dd = Math.abs(Math.log(v) - Math.log(want));
    if (dd < bestD) { bestD = dd; bestCode = c; }
  }
  return bestCode;
}

export function canonExposureJson({ eosVals, eosAvail }) {
  const hasTv = eosVals.has(0xD102), hasAv = eosVals.has(0xD101), hasIso = eosVals.has(0xD103);
  if (!hasTv && !hasAv && !hasIso && !eosAvail.has(0xD102) && !eosAvail.has(0xD101) && !eosAvail.has(0xD103)) {
    return { supported: false };
  }
  const wbAv = eosAvail.get(0xD109);
  const wbIds = (wbAv && wbAv.length > 0) ? wbAv : [...CANON_WB_LABELS.keys()];
  const wbChoices = wbIds.map((id) => ({ v: id, label: CANON_WB_LABELS.get(id) || `WB ${id}` }));
  const out = {
    supported: true,
    program: eosVals.get(0xD105) ?? 0,
    shutter: hasTv ? (CANON_TV.get(eosVals.get(0xD102)) || 0) : 0,
    f: hasAv ? (CANON_AV.get(eosVals.get(0xD101)) || 0) : 0,
    iso: hasIso ? Math.round(CANON_ISO.get(eosVals.get(0xD103)) || 0) : 0,
    wbChoices,
    set: {
      shutter: canonCanSet(eosVals, eosAvail, 0xD102),
      f: canonCanSet(eosVals, eosAvail, 0xD101),
      iso: canonCanSet(eosVals, eosAvail, 0xD103),
      wb: canonCanSet(eosVals, eosAvail, 0xD109)
    }
  };
  if (eosVals.has(0xD109)) out.wb = eosVals.get(0xD109);
  return out;
}

export async function canonSetExposure({ eosVals, eosAvail, setEos, poll }, arg) {
  const want = new Map();
  for (const kv of String(arg || '').split(/[&\s]+/).filter(Boolean)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const k = kv.slice(0, eq), v = Number(kv.slice(eq + 1));
    if (Number.isFinite(v) && (k === 'wb' ? v >= 0 : v > 0)) want.set(k, v);
  }
  const results = {};
  for (const [key, prop, table] of [
    ['shutter', 0xD102, CANON_TV],
    ['f', 0xD101, CANON_AV],
    ['iso', 0xD103, CANON_ISO]
  ]) {
    if (!want.has(key)) continue;
    const av = eosAvail.get(prop);
    const hasList = !!(av && av.length > 0);
    const hasCur = eosVals.has(prop);
    const cur = eosVals.get(prop);
    let state;
    try {
      if (!hasCur && !hasList) state = 'unsupported';
      else if (hasList && av.length <= 1) state = 'locked';
      else {
        const pick = canonPickApex(eosAvail, prop, want.get(key), table);
        if (pick < 0) state = 'unsupported';
        else if (hasCur && pick === cur) state = 'same';
        else state = (await setEos(prop, pick)) === OK ? 'set' : 'refused';
      }
    } catch (e) {
      if (e instanceof GoneError) throw e;
      state = 'refused';
    }
    results[key] = state;
  }
  if (want.has('wb')) {
    const target = Math.round(want.get('wb'));
    const av = eosAvail.get(0xD109);
    const hasList = !!(av && av.length > 0);
    const hasCur = eosVals.has(0xD109);
    let state;
    try {
      if (!hasCur && !hasList) state = 'unsupported';
      else if (hasList && av.length <= 1) state = 'locked';
      else if (hasList && !av.includes(target)) state = 'unsupported';
      else if (hasCur && eosVals.get(0xD109) === target) state = 'same';
      else state = (await setEos(0xD109, target)) === OK ? 'set' : 'refused';
    } catch (e) {
      if (e instanceof GoneError) throw e;
      state = 'refused';
    }
    results.wb = state;
  }
  await poll().catch(() => {});
  return { ...canonExposureJson({ eosVals, eosAvail }), results };
}
