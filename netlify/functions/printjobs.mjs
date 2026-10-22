import { randomInt, createHash } from 'node:crypto';
import {
  safe, json, licenses, meta, sign, verifyToken, normCode, throttle, recordFail, clearFail,
  checkLicense, printJobsStore, jobOwner, getSettings, DAY
} from '../lib/core.mjs';

// Laptop print station: an iPad (or any booth) sends finished pages here, and
// the /print-station/ page open on a laptop at the venue picks them up and
// prints them through the photobooth4u Print Helper (no print dialog), or
// with Chrome's --kiosk-printing.
//
// Booth (signed in with its license token):
//   add      { paper, page, copies, group, index, total } -> { id }
//   station  -> { online, lastSeen }   is a print station open for this booking?
//   pair     -> { code, exp }   trial booths only: a 6-digit code the laptop types once
//            (works for 10 minutes; the laptop then gets this tablet's prints until the trial ends)
// Print station:
//   signin   { code }  -> { stationToken, label, sizes }   (never uses a device slot)
//            code = a rental code, or a trial tablet's 6-digit pairing code
//   take     { stationToken } -> { job | null }   oldest page not being printed yet
//   done     { stationToken, id }                  printed (or given up): remove it
const MAX_PAGE = 4500000;           // characters of one page image (data URL)
const MAX_PENDING = 60;             // pages waiting per booking
const JOB_TTL = 30 * 60000;         // unprinted pages are dropped after 30 minutes
const CLAIM_MS = 3 * 60000;         // a page being printed isn't handed out again for 3 minutes
const BEAT_MS = 15000;              // station "last seen" is written at most this often
const STATION_ONLINE_MS = 30000;
const PAGE_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const ID_RE = /^[a-z0-9]{8,12}-[a-z0-9]{4}$/;

const PAIR_MS = 10 * 60000;          // a pairing code works once, within 10 minutes
const beatKey = (owner) => 'station-' + owner;
const pairKey = (code) => 'pair-' + code;
// A trial's print queue belongs to that one tablet + trial session (the trial
// password is shared, so it can't be the key the way a rental code is).
const trialOwner = (p) => 'trial-' + createHash('sha256').update(String(p.d || '') + '|' + String(p.f || '') + '|' + String(p.exp || '')).digest('hex').slice(0, 24);
const isTrialOwner = (o) => /^trial-[0-9a-f]{24}$/.test(o);
const newId = () => Date.now().toString(36).padStart(9, '0') + '-' + randomInt(36 ** 4).toString(36).padStart(4, '0');

export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);
  const jobs = printJobsStore();
  const now = Date.now();

  // ---------- booth side ----------
  if (b.action === 'add' || b.action === 'station' || b.action === 'pair') {
    const lic = await checkLicense(b.token, String(b.deviceId || ''));
    if (!lic.valid) return json({ error: 'locked', reason: lic.reason }, 401);
    const p = verifyToken(b.token);
    const trial = lic.type === 'trial';
    const owner = trial ? trialOwner(p) : jobOwner(await licenses().get(p.k, { type: 'json' }));
    const beat = await meta().get(beatKey(owner), { type: 'json' });
    const lastSeen = (beat && beat.at) || 0;
    if (b.action === 'station') return json({ ok: true, online: now - lastSeen < STATION_ONLINE_MS, lastSeen, trial });
    if (b.action === 'pair') {
      if (!trial) return json({ error: 'Rental booths sign in on the laptop with their code.' }, 400);
      const t = await throttle('pair', context.ip, 30);
      if (t.blocked) return json({ error: 'Too many pairing codes. Please wait a few minutes.' }, 429);
      await recordFail(t);                       // counts codes made, not failures
      let code = '';
      for (let i = 0; i < 5 && !code; i++) {
        const c = String(randomInt(1000000)).padStart(6, '0');
        if (!(await meta().get(pairKey(c), { type: 'json' }))) code = c;
      }
      if (!code) return json({ error: 'Please try again.' }, 503);
      const exp = Math.min(now + PAIR_MS, lic.exp);
      await meta().setJSON(pairKey(code), { owner, exp, trialEnd: lic.exp });
      return json({ ok: true, code, exp, online: now - lastSeen < STATION_ONLINE_MS });
    }

    if (!lic.print || !lic.print.enabled) return json({ error: 'Printing is off for this code.' }, 403);
    const page = String(b.page || '');
    if (page.length > MAX_PAGE || !PAGE_RE.test(page)) return json({ error: 'That page is too large or not an image.' }, 413);
    const paper = b.paper || {};
    const w = Number(paper.w), h = Number(paper.h);
    if (!(w > 10 && w < 600 && h > 10 && h < 600)) return json({ error: 'Bad paper size' }, 400);
    const { blobs } = await jobs.list({ prefix: owner + '/' });
    if (blobs.length >= MAX_PENDING) return json({ error: 'The print station has too many pages waiting. Check the laptop.' }, 429);
    const id = newId();
    await jobs.setJSON(owner + '/' + id, {
      id, at: now, page,
      paper: { key: String(paper.key || '').slice(0, 20), name: String(paper.name || '').slice(0, 40), w, h },
      copies: Math.max(1, Math.min(20, Math.floor(Number(b.copies) || 1))),
      group: String(b.group || id).slice(0, 40), index: Math.max(0, Math.floor(Number(b.index) || 0)), total: Math.max(1, Math.floor(Number(b.total) || 1)),
      device: lic.deviceNo || 1
    });
    return json({ ok: true, id, online: now - lastSeen < STATION_ONLINE_MS });
  }

  // ---------- print station side ----------
  if (b.action === 'signin') {
    const t = await throttle('station', context.ip, 10);
    if (t.blocked) return json({ error: 'Too many wrong attempts. Please wait a few minutes and try again.' }, 429);
    const digits = String(b.code || '').replace(/[\s-]/g, '');
    if (/^\d{6}$/.test(digits)) {                  // a trial tablet's pairing code
      const pair = await meta().get(pairKey(digits), { type: 'json' });
      if (pair) await meta().delete(pairKey(digits));   // works once
      if (!pair || !(pair.exp > now) || !isTrialOwner(pair.owner)) {
        await recordFail(t);
        return json({ error: 'That pairing code isn’t valid or has expired. On the tablet, tap “New code” and try again.' }, 401);
      }
      await clearFail(t);
      const s = await getSettings();
      const stationToken = sign({ t: 'station', k: pair.owner, exp: pair.trialEnd });
      return json({ ok: true, stationToken, label: 'Trial booth', code: '', trial: true, sizes: (s.trialPrintEnabled && s.trialPrintSizes) || [] });
    }
    const key = normCode(b.code);
    let rec = key ? await licenses().get(key, { type: 'json' }) : null;
    if (!rec) { await recordFail(t); return json({ error: 'That code is not valid.' }, 401); }
    await clearFail(t);
    if (rec.kind === 'bonus' && rec.parent) rec = (await licenses().get(rec.parent, { type: 'json' })) || rec;
    if (rec.status === 'revoked') return json({ error: 'This code has been disabled. Please contact the owner.' }, 403);
    if (rec.status === 'active' && !rec.lifetime && rec.expiresAt <= now) return json({ error: 'This code has expired.' }, 403);
    const stationToken = sign({ t: 'station', k: rec.key, exp: now + 3 * DAY });
    return json({ ok: true, stationToken, label: rec.label || rec.code, code: rec.code, sizes: (rec.print && rec.print.enabled && rec.print.sizes) || [] });
  }

  const st = verifyToken(b.stationToken);
  if (!st || st.t !== 'station' || !(st.exp > now)) return json({ error: 'signin' }, 401);
  const owner = st.k;

  if (b.action === 'take') {
    if (!isTrialOwner(owner)) {
      const rec = await licenses().get(owner, { type: 'json' });
      if (!rec || rec.status === 'revoked') return json({ error: 'signin' }, 401);
    }
    const beat = await meta().get(beatKey(owner), { type: 'json' });
    if (!beat || now - beat.at > BEAT_MS) await meta().setJSON(beatKey(owner), { at: now });
    const { blobs } = await jobs.list({ prefix: owner + '/' });
    const keys = blobs.map((x) => x.key).sort();
    for (const k of keys) {
      const id = k.slice(owner.length + 1);
      if (!ID_RE.test(id)) continue;
      const born = parseInt(id.split('-')[0], 36);
      if (now - born > JOB_TTL) { await jobs.delete(k); await jobs.delete('claim/' + k); continue; }
      const claim = await jobs.get('claim/' + k, { type: 'json' });
      if (claim && now - claim.at < CLAIM_MS && claim.by !== b.station) continue;
      const job = await jobs.get(k, { type: 'json' });
      if (!job) continue;
      await jobs.setJSON('claim/' + k, { at: now, by: String(b.station || '').slice(0, 40) });
      return json({ ok: true, job, waiting: keys.length });
    }
    return json({ ok: true, job: null, waiting: 0 });
  }

  if (b.action === 'done') {
    const id = String(b.id || '');
    if (!ID_RE.test(id)) return json({ error: 'Bad id' }, 400);
    await jobs.delete(owner + '/' + id);
    await jobs.delete('claim/' + owner + '/' + id);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action.' }, 400);
});

export const config = { path: '/api/printjobs' };
