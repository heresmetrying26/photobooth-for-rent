import {
  safe, json, licenses, meta, getSettings, sign, verifyToken, sha,
  newCode, displayCode, normCode, throttle, recordFail, clearFail, normPrint, DAY, MIN, BONUS_SUBFOLDER,
  LIFETIME_EXP, MAX_DEVICES, devicesOf, setDevices, printsStore
, putLicense, delLicense, readIndex, rebuildIndex, windowEnd } from '../lib/core.mjs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { setupsStore } from '../lib/core.mjs';
import { ownerId, eventKeyOf, getAcct, acctPublic, acctKey, payStore, unseal, pm, listJSON, usedMap, batchView, createBatch, batchKey } from '../lib/pay.mjs';
import { cleanEventName, sendMail, codeEmail, EMAIL_RE } from '../lib/core.mjs';

function passwordOk(input) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) throw new Error('ADMIN_PASSWORD env var is not set in Netlify.');
  return timingSafeEqual(sha(input), sha(real));
}

// Status as Admin shows it (also used for filters and counts).
function statusOf(r, now) {
  if (r.status === 'revoked') return 'revoked';
  if (r.status === 'active') return (!r.lifetime && r.expiresAt && r.expiresAt <= now) ? 'expired' : 'active';
  if (r.kind !== 'bonus' && r.startsAt && !r.lifetime) {
    if (r.startsAt + r.days * DAY <= now) return 'expired';
    if (r.startsAt > now) return 'scheduled';
  }
  return 'unused';
}
const THEME_ID_RE = /^[a-z0-9-]{1,40}$/;
const cleanTheme = (v) => (typeof v === 'string' && THEME_ID_RE.test(v)) ? v : null;
// Search + filter over the index. Bonus codes are listed inside their booking
// (filter "bonus" lists them on their own).
function queryIndex(ix, b, now) {
  const all = Object.values(ix.rows);
  const q = String(b.q || '').trim().toLowerCase();
  const qCode = normCode(q);
  const match = (r) => !q || (r.label || '').toLowerCase().includes(q) || (r.folderName || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q)
    || (qCode.length >= 3 && normCode(r.code).includes(qCode));
  // Searching a bonus code also finds its booking.
  const hitParents = new Set(q ? all.filter((r) => r.kind === 'bonus' && r.parent && match(r)).map((r) => r.parent) : []);
  const rows = all.filter((r) => match(r) || hitParents.has(r.key)).map((r) => Object.assign({}, r, { st: statusOf(r, now) }));
  const counts = { all: 0, active: 0, scheduled: 0, unused: 0, lifetime: 0, expired: 0, revoked: 0, bonus: 0 };
  rows.forEach((r) => {
    if (r.kind === 'bonus') { counts.bonus++; return; }
    counts.all++; counts[r.st]++;
    if (r.lifetime) counts.lifetime++;
  });
  const f = String(b.filter || 'all');
  let list = rows.filter((r) => {
    if (f === 'bonus') return r.kind === 'bonus';
    if (r.kind === 'bonus') return false;
    if (f === 'all') return true;
    if (f === 'lifetime') return r.lifetime;
    return r.st === f;
  });
  const sort = String(b.sort || 'newest');
  const by = {
    newest: (a, c) => c.createdAt - a.createdAt,
    oldest: (a, c) => a.createdAt - c.createdAt,
    event: (a, c) => (a.startsAt || a.redeemedAt || 9e15) - (c.startsAt || c.redeemedAt || 9e15),
    ending: (a, c) => ((a.st === 'active' && !a.lifetime) ? a.expiresAt : 9e15) - ((c.st === 'active' && !c.lifetime) ? c.expiresAt : 9e15),
    name: (a, c) => (a.label || a.code).localeCompare(c.label || c.code)
  }[sort] || ((a, c) => c.createdAt - a.createdAt);
  list.sort(by);
  return { list, counts };
}

async function allLicenses() {
  const store = licenses();
  const { blobs } = await store.list();
  const rows = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return rows.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

const intIn = (v, min, max) => {
  const n = Math.floor(Number(v));
  return n >= min && n <= max ? n : null;
};

// Opening time sent by the admin page as epoch ms (the page converts the
// date/time picker using the admin's own clock). null/blank = no date.
function readStart(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Math.floor(Number(v));
  const now = Date.now();
  if (!Number.isFinite(n) || n < now - 30 * DAY || n > now + 3 * 365 * DAY) return { ok: false };
  return { ok: true, value: n };
}

async function freshKey(store) {
  let key;
  do { key = newCode(); } while (await store.get(key));
  return key;
}

// The bonus code that belongs to a booking: same folder (its photos go in a
// subfolder), same print / laptop settings, N minutes from first entry.
function bonusRecord(key, parent, minutes) {
  return {
    key, code: displayCode(key), kind: 'bonus', parent: parent.key,
    label: (parent.label || parent.code) + ' · Bonus', folderName: parent.folderName, subfolder: BONUS_SUBFOLDER,
    minutes, days: 0, startsAt: null, print: parent.print, traditional: !!parent.traditional, retakeOpt: !!parent.retakeOpt, payOpt: !!parent.payOpt, lockOpt: !!parent.lockOpt, defaultTheme: parent.defaultTheme || null,
    status: 'unused', createdAt: Date.now() + 1, redeemedAt: null, expiresAt: null, deviceId: null
  };
}

export default safe(async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'Bad request' }, 400);

  if (b.action === 'login') {
    const t = await throttle('admin', context.ip, 6);
    if (t.blocked) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
    if (!passwordOk(b.password || '')) {
      await recordFail(t);
      return json({ error: 'Wrong admin password.' }, 401);
    }
    await clearFail(t);
    return json({ token: sign({ t: 'admin', exp: Date.now() + 8 * 3600000 }) });
  }

  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const p = verifyToken(auth);
  if (!p || p.t !== 'admin' || p.exp <= Date.now()) return json({ error: 'Session expired. Please log in again.' }, 401);

  const store = licenses();
  // Print / laptop-mode changes on a booking also apply to its bonus code.
  const syncBonus = async (rec, patch) => {
    if (!rec.bonusKey) return;
    const bonus = await store.get(rec.bonusKey, { type: 'json' });
    if (bonus) await putLicense(store, rec.bonusKey, { ...bonus, ...patch });
  };
  const getRec = async () => {
    const key = normCode(b.code);
    const rec = key ? await store.get(key, { type: 'json' }) : null;
    return { key, rec };
  };

  switch (b.action) {
    case 'list': {
      // Paged list from the index: { q, filter, sort, page, size }
      const now = Date.now();
      const ix = await readIndex();
      const { list, counts } = queryIndex(ix, b, now);
      const size = Math.min(100, Math.max(5, Number(b.size) || 25));
      const pages = Math.max(1, Math.ceil(list.length / size));
      const page = Math.min(pages, Math.max(1, Number(b.page) || 1));
      const rows = list.slice((page - 1) * size, page * size).map((r) => {
        const bonus = r.bonusKey && ix.rows[r.bonusKey] ? Object.assign({}, ix.rows[r.bonusKey], { st: statusOf(ix.rows[r.bonusKey], now) }) : null;
        return Object.assign(r, { bonus });
      });
      const all = Object.values(ix.rows).filter((r) => r.kind !== 'bonus');
      const stats = {
        total: all.length,
        activeNow: all.filter((r) => statusOf(r, now) === 'active').length,
        upcoming: all.filter((r) => statusOf(r, now) === 'scheduled').length,
        lifetime: all.filter((r) => r.lifetime && r.status !== 'revoked').length,
        next7: all.filter((r) => r.startsAt && r.startsAt > now && r.startsAt < now + 7 * DAY).length
      };
      return json({ rows, counts, stats, page, pages, total: list.length, settings: await getSettings(), now, indexBuiltAt: ix.builtAt || null });
    }

    case 'get': { // one booking in full (+ its bonus code), for the expanded row
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const bonus = rec.bonusKey ? await store.get(rec.bonusKey, { type: 'json' }) : null;
      return json({ rec, bonus, now: Date.now() });
    }

    case 'export': { // every row matching the current search/filter, for CSV
      const now = Date.now();
      const { list } = queryIndex(await readIndex(), b, now);
      return json({ rows: list.slice(0, 20000), now });
    }

    case 'reindex':
      return json({ ok: true, count: Object.keys((await rebuildIndex()).rows).length });

    case 'bulk': { // disable / restore / delete many codes at once
      const op = b.op;
      if (!['revoke', 'restore', 'delete'].includes(op)) return json({ error: 'Unknown bulk action.' }, 400);
      const codes = (Array.isArray(b.codes) ? b.codes : []).map(normCode).filter(Boolean).slice(0, 200);
      let done = 0;
      for (const key of codes) {
        const rec = await store.get(key, { type: 'json' });
        if (!rec) continue;
        if (op === 'delete') {
          await delLicense(store, key);
          if (rec.bonusKey) await delLicense(store, rec.bonusKey);
        } else {
          rec.status = op === 'revoke' ? 'revoked' : (rec.redeemedAt ? 'active' : 'unused');
          await putLicense(store, key, rec);
        }
        done++;
      }
      return json({ ok: true, done });
    }

    case 'theme': { // starting theme for a booking (used until the renter saves their own design)
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.defaultTheme = cleanTheme(b.theme);
      await putLicense(store, key, rec);
      if (rec.bonusKey) {
        const bonus = await store.get(rec.bonusKey, { type: 'json' });
        if (bonus) { bonus.defaultTheme = rec.defaultTheme; await putLicense(store, rec.bonusKey, bonus); }
      }
      return json({ ok: true });
    }

    case 'create': {
      const lifetime = !!b.lifetime;
      const days = lifetime ? (intIn(b.days, 1, 365) || 1) : intIn(b.days, 1, 365);
      const count = intIn(b.count || 1, 1, 20);
      const maxDevices = intIn(b.maxDevices || 1, 1, MAX_DEVICES);
      if (!days) return json({ error: 'Days must be between 1 and 365.' }, 400);
      if (!maxDevices) return json({ error: 'Devices must be between 1 and ' + MAX_DEVICES + '.' }, 400);
      if (!count) return json({ error: 'Count must be between 1 and 20.' }, 400);
      const label = String(b.label || '').trim().slice(0, 80);
      const folderName = String(b.folderName || label).trim().slice(0, 80);
      const print = normPrint(b.printEnabled, b.printSizes, { eventLimit: b.printEventLimit, sessionLimit: b.printSessionLimit });
      if (b.printEnabled && !print.enabled) return json({ error: 'Pick at least one paper size, or turn printing off.' }, 400);
      const start = readStart(b.startsAt);
      if (!start.ok) return json({ error: 'Pick a valid opening date.' }, 400);
      const bonusMinutes = b.bonus ? intIn(b.bonusMinutes, 5, 1440) : null;
      if (b.bonus && !bonusMinutes) return json({ error: 'Bonus length must be 5-1440 minutes.' }, 400);
      const email = String(b.email || '').trim().toLowerCase();
      if (email && !EMAIL_RE.test(email)) return json({ error: 'That email address doesn’t look right.' }, 400);
      if (email && count > 1) return json({ error: 'An email can be on one code only. Make one code at a time when adding an email.' }, 400);
      if (email && lifetime && Object.values((await readIndex()).rows).some((r) => r.lifetime && r.kind !== 'bonus' && String(r.email || '').toLowerCase() === email)) {
        return json({ error: 'That email is already on another lifetime code (one email per lifetime code).' }, 409);
      }
      // Drive folders are matched by name, so two bookings with the same
      // folder name would share one folder (and see each other's photos).
      if (!b.sameFolderOk) {
        const want = (folderName || label).toLowerCase();
        const clash = want && Object.values((await readIndex()).rows).find((l) => l.kind !== 'bonus' && String(l.folderName || '').trim().toLowerCase() === want);
        if (clash) return json({ error: 'The Drive folder "' + (folderName || label) + '" is already used by ' + clash.code + '. Both bookings would share one folder.', duplicate: true, code: clash.code }, 409);
      }
      const created = [];
      for (let i = 0; i < count; i++) {
        const key = await freshKey(store);
        // Keep a dedicated Drive folder name. If neither field was supplied,
        // fall back to the code so the renter never has to configure Drive.
        const rec = { key, code: displayCode(key), kind: 'rental', label: label || displayCode(key), folderName: folderName || displayCode(key), days, lifetime, maxDevices, defaultTheme: cleanTheme(b.defaultTheme), startsAt: start.value, print, traditional: !!b.traditional, status: 'unused', createdAt: Date.now(), redeemedAt: null, expiresAt: null, deviceId: null, email: email || null };
        let bonus = null;
        if (bonusMinutes) {
          bonus = bonusRecord(await freshKey(store), rec, bonusMinutes);
          rec.bonusKey = bonus.key;
          await putLicense(store, bonus.key, bonus);
        }
        await putLicense(store, key, rec);
        created.push(rec);
        if (bonus) created.push(bonus);
      }
      return json({ created });
    }

    case 'schedule': { // set, change or remove the opening date of a code that hasn't been used yet
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      if (rec.kind === 'bonus') return json({ error: 'Bonus codes have no opening date — change its length instead.' }, 400);
      if (rec.status !== 'unused') return json({ error: 'Only a code that has not been used yet can be rescheduled. Use + Add days instead.' }, 400);
      const start = readStart(b.startsAt);
      if (!start.ok) return json({ error: 'Pick a valid opening date.' }, 400);
      rec.startsAt = start.value;
      await putLicense(store, key, rec);
      return json({ ok: true, startsAt: rec.startsAt });
    }

    case 'addbonus': { // give an existing booking a bonus code
      const { key, rec } = await getRec();
      if (!rec || rec.kind === 'bonus') return json({ error: 'Code not found.' }, 404);
      if (rec.bonusKey && await store.get(rec.bonusKey)) return json({ error: 'This booking already has a bonus code.' }, 400);
      const minutes = intIn(b.minutes, 5, 1440);
      if (!minutes) return json({ error: 'Bonus length must be 5-1440 minutes.' }, 400);
      const bonus = bonusRecord(await freshKey(store), rec, minutes);
      await putLicense(store, bonus.key, bonus);
      rec.bonusKey = bonus.key;
      await putLicense(store, key, rec);
      return json({ ok: true, created: [bonus] });
    }

    case 'bonusminutes': { // change a bonus code's total length; applies to an open booth within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec || rec.kind !== 'bonus') return json({ error: 'Bonus code not found.' }, 404);
      const minutes = intIn(b.minutes, 5, 1440);
      if (!minutes) return json({ error: 'Bonus length must be 5-1440 minutes.' }, 400);
      rec.minutes = minutes;
      if (rec.redeemedAt) rec.expiresAt = rec.redeemedAt + minutes * MIN;
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'revoke': {
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.status = 'revoked';
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'restore': {
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.status = rec.redeemedAt ? 'active' : 'unused';
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'unbind': { // free one device (deviceNo) or all of them, so the code can be entered on another device
      const { key, rec } = await getRec();
      if (!rec || rec.status !== 'active') return json({ error: 'Only an active code can be moved to a new device.' }, 400);
      const no = b.deviceNo == null ? null : Number(b.deviceNo);
      setDevices(rec, no == null ? [] : devicesOf(rec).filter((d) => d.no !== no));
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'devices': { // change how many devices a code may be used on
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const max = intIn(b.maxDevices, 1, MAX_DEVICES);
      if (!max) return json({ error: 'Devices must be between 1 and ' + MAX_DEVICES + '.' }, 400);
      const used = devicesOf(rec).length;
      if (max < used) return json({ error: 'This code is in use on ' + used + ' devices. Remove some first.' }, 400);
      rec.maxDevices = max;
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'makelifetime': { // upgrade a booking to lifetime access
      const { key, rec } = await getRec();
      if (!rec || rec.kind === 'bonus') return json({ error: 'Code not found.' }, 404);
      if (rec.lifetime) return json({ error: 'This code is already lifetime.' }, 400);
      rec.lifetime = true;
      if (rec.status === 'active') rec.expiresAt = LIFETIME_EXP;
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'extend': {
      const add = intIn(b.days, 1, 365);
      if (!add) return json({ error: 'Days must be between 1 and 365.' }, 400);
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      if (rec.kind === 'bonus') return json({ error: 'For a bonus code, change its length in minutes instead.' }, 400);
      if (rec.lifetime) return json({ error: 'Lifetime codes never expire.' }, 400);
      if (rec.status === 'active') rec.expiresAt = Math.max(rec.expiresAt, Date.now()) + add * DAY;
      else if (rec.status === 'unused') rec.days += add;
      else return json({ error: 'Restore this code before extending it.' }, 400);
      await putLicense(store, key, rec);
      return json({ ok: true });
    }

    case 'print': { // change printing for one code; applies to an active booth within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const print = normPrint(b.printEnabled, b.printSizes, { eventLimit: b.printEventLimit, sessionLimit: b.printSessionLimit });
      if (b.printEnabled && !print.enabled) return json({ error: 'Pick at least one paper size, or turn printing off.' }, 400);
      rec.print = print;
      await putLicense(store, key, rec);
      await syncBonus(rec, { print });
      return json({ ok: true, print });
    }

    case 'printusage': { // sheets printed so far: one count per event (lifetime codes have one per event name)
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const ps = printsStore();
      const events = [];
      const one = await ps.get(key, { type: 'json' });
      if (one) events.push({ id: key, name: rec.lifetime ? '(no event name)' : (rec.folderName || rec.label || rec.code), used: one.used || 0, at: one.updatedAt || 0 });
      if (rec.lifetime) {
        const { blobs } = await ps.list({ prefix: key + '|' });
        for (const bl of blobs.slice(0, 200)) {
          const d = await ps.get(bl.key, { type: 'json' });
          if (d) events.push({ id: bl.key, name: d.event || bl.key.slice(key.length + 1), used: d.used || 0, at: d.updatedAt || 0 });
        }
      }
      events.sort((x, y) => (y.at || 0) - (x.at || 0));
      return json({ ok: true, events, total: events.reduce((n, e) => n + e.used, 0), limit: (rec.print && rec.print.eventLimit) || 0 });
    }

    case 'printreset': { // start an event's print count again from 0 (e.g. the renter bought more prints)
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const id = String(b.id || key);
      if (id !== key && !id.startsWith(key + '|')) return json({ error: 'Not this code\'s count.' }, 400);
      await printsStore().delete(id);
      return json({ ok: true });
    }

    case 'lockopt': { // "Lock booth" (guest-only screen with a PIN) for this code
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.lockOpt = !!b.lockOpt;
      await putLicense(store, key, rec);
      await syncBonus(rec, { lockOpt: rec.lockOpt });
      return json({ ok: true, lockOpt: rec.lockOpt });
    }

    case 'pinreset': { // forgotten lock PIN: the booth clears it and unlocks within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.pinResetAt = Date.now();
      await putLicense(store, key, rec);
      // The code's shared PIN (kept with the setups, per booking / lifetime code) is removed too.
      const owner = rec.kind === 'bonus' && rec.parent ? rec.parent : (rec.key || key);
      const pinId = 'k' + createHash('sha256').update('own|' + owner).digest('hex').slice(0, 40) + '_pin';
      try { await setupsStore().delete(pinId); } catch (e) { /* nothing saved yet */ }
      await syncBonus(rec, { pinResetAt: rec.pinResetAt });
      return json({ ok: true, pinResetAt: rec.pinResetAt });
    }

    case 'retakeopt': { // lets the renter switch retakes on/off per event; an open booth picks it up within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.retakeOpt = !!b.retakeOpt;
      await putLicense(store, key, rec);
      await syncBonus(rec, { retakeOpt: rec.retakeOpt });
      return json({ ok: true, retakeOpt: rec.retakeOpt });
    }

    case 'setemail': { // the renter's email (for "Forgot your code?" and "Email code")
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const email = String(b.email || '').trim().toLowerCase();
      if (email && !EMAIL_RE.test(email)) return json({ error: 'That email address doesn’t look right.' }, 400);
      if (email && rec.lifetime && Object.values((await readIndex()).rows).some((r) => r.lifetime && r.kind !== 'bonus' && r.key !== key && String(r.email || '').toLowerCase() === email)) {
        return json({ error: 'That email is already on another lifetime code (one email per lifetime code).' }, 409);
      }
      rec.email = email || null;
      await putLicense(store, key, rec);
      return json({ ok: true, email: rec.email || '' });
    }

    case 'sendcode': { // email the code to the renter's saved address
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      if (!rec.email) return json({ error: 'Add the renter’s email first.' }, 400);
      try { await sendMail(Object.assign({ to: rec.email }, codeEmail([rec], process.env.URL || new URL(req.url).origin))); }
      catch (e) { return json({ error: 'Couldn’t send: ' + e.message }, 502); }
      return json({ ok: true, to: rec.email });
    }

    case 'payopt': { // guest payments add-on (vouchers + the renter's own PayMongo); an open booth picks it up within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.payOpt = !!b.payOpt;
      await putLicense(store, key, rec);
      await syncBonus(rec, { payOpt: rec.payOpt });
      return json({ ok: true, payOpt: rec.payOpt });
    }

    case 'payinfo': { // PayMongo connection (never the key), money taken and voucher batches for one booking
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const bk = rec.kind === 'bonus' && rec.parent ? rec.parent : rec.key;
      const oid = ownerId(bk);
      const paid = (await listJSON('pp/' + oid + '/', 1000)).filter((x) => x.status === 'paid');
      const used = await usedMap(oid);
      const batches = (await listJSON('vb/' + oid + '/', 200)).sort((x, y) => y.at - x.at).map((bt) => batchView(bt, used));
      return json({ ok: true, payOpt: !!rec.payOpt, lifetime: !!rec.lifetime, acct: acctPublic(await getAcct(oid)),
        paid: { count: paid.length, total: paid.reduce((s, x) => s + x.amount, 0), live: paid.filter((x) => x.live).reduce((s, x) => s + x.amount, 0) }, batches });
    }

    case 'payreset': { // forgotten payments PIN: removes the PIN AND disconnects PayMongo (the renter connects again)
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const oid = ownerId(rec.kind === 'bonus' && rec.parent ? rec.parent : rec.key);
      const acct = await getAcct(oid);
      if (acct && acct.enc && acct.whId) { try { await pm(unseal(acct.enc, oid), 'POST', '/webhooks/' + acct.whId + '/disable'); } catch (e) {} }
      await payStore().delete(acctKey(oid));
      return json({ ok: true });
    }

    case 'vbatch': { // make vouchers for a booking (event name needed for lifetime codes)
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const bk = rec.kind === 'bonus' && rec.parent ? rec.parent : rec.key;
      const life = !!rec.lifetime;
      const evName = life ? cleanEventName(b.event || '') : (rec.folderName || rec.label || '');
      if (life && !evName) return json({ error: 'Type the event name exactly as the renter uses it in the booth.' }, 400);
      const bt = await createBatch(ownerId(bk), { ev: eventKeyOf(life, evName), evName, count: b.count, prints: b.prints, price: b.price, label: b.label, by: 'admin' });
      return json({ ok: true, batch: batchView(bt, {}) });
    }

    case 'vvoid': { // void the unused vouchers of a batch
      const { rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      const oid = ownerId(rec.kind === 'bonus' && rec.parent ? rec.parent : rec.key);
      const bt = await payStore().get(batchKey(oid, String(b.id || '')), { type: 'json' });
      if (!bt) return json({ error: 'Batch not found.' }, 404);
      const used = await usedMap(oid);
      bt.voided = bt.codes.filter((c) => !used[c]);
      await payStore().setJSON(batchKey(oid, bt.id), bt);
      return json({ ok: true, batch: batchView(bt, used) });
    }

    case 'traditional': { // laptop + guest screen mode; applies to an open booth within ~5 minutes
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      rec.traditional = !!b.traditional;
      await putLicense(store, key, rec);
      await syncBonus(rec, { traditional: rec.traditional });
      return json({ ok: true, traditional: rec.traditional });
    }

    case 'qrprefs': { // "Open on your phone" QR on the gallery page
      const settings = { ...(await getSettings()) };
      if (typeof b.galleryQr === 'boolean') settings.galleryQr = b.galleryQr;
      await meta().setJSON('settings', settings);
      return json({ ok: true, settings });
    }

    case 'qrtarget': { // where every booth QR code points: the online gallery or the Drive folder
      const settings = { ...(await getSettings()), qrTarget: b.qrTarget === 'drive' ? 'drive' : 'gallery' };
      await meta().setJSON('settings', settings);
      return json({ settings });
    }

    case 'delete': { // deleting a booking also deletes its bonus code
      const { key, rec } = await getRec();
      if (!rec) return json({ error: 'Code not found.' }, 404);
      await delLicense(store, key);
      if (rec.bonusKey) await delLicense(store, rec.bonusKey);
      if (rec.kind === 'bonus' && rec.parent) {
        const parent = await store.get(rec.parent, { type: 'json' });
        if (parent && parent.bonusKey === key) { delete parent.bonusKey; await putLicense(store, rec.parent, parent); }
      }
      return json({ ok: true });
    }

    case 'settings': {
      const pw = String(b.trialPassword || '').trim();
      const minutes = intIn(b.trialMinutes, 1, 240);
      const prefix = String(b.trialFolderPrefix || 'Trial test shots').trim().slice(0, 60);
      if (pw.length < 3 || pw.length > 40) return json({ error: 'Trial password must be 3-40 characters.' }, 400);
      if (!minutes) return json({ error: 'Trial length must be 1-240 minutes.' }, 400);
      if (!prefix) return json({ error: 'Trial folder name cannot be empty.' }, 400);
      const trialPrint = normPrint(b.trialPrintEnabled, b.trialPrintSizes, { eventLimit: b.trialPrintEventLimit, sessionLimit: b.trialPrintSessionLimit });
      if (b.trialPrintEnabled && !trialPrint.enabled) return json({ error: 'Pick at least one trial paper size, or turn trial printing off.' }, 400);
      const settings = { trialEnabled: !!b.trialEnabled, trialPassword: pw, trialMinutes: minutes, trialFolderPrefix: prefix,
        trialPrintEnabled: trialPrint.enabled, trialPrintSizes: trialPrint.sizes.length ? trialPrint.sizes : ['4x6'],
        trialPrintEventLimit: trialPrint.eventLimit, trialPrintSessionLimit: trialPrint.sessionLimit,
        trialTraditional: !!b.trialTraditional,
        trialRetakeOpt: !!b.trialRetakeOpt,
        trialLockOpt: !!b.trialLockOpt,
        trialWatermark: b.trialWatermark !== false };
      const prev = await getSettings();
      settings.qrTarget = prev.qrTarget; settings.galleryQr = prev.galleryQr !== false;
      await meta().setJSON('settings', settings);
      return json({ settings });
    }

    default:
      return json({ error: 'Unknown action.' }, 400);
  }
});

export const config = { path: '/api/admin' };
