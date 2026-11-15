// Behaviour tests for the Instax Link printer driver (protected/src/printer/instax.js).
// Run: node scripts/test-instax.mjs      (no printer, Bluetooth or browser needed)
//
// A simulated INSTAX Link WIDE answers the driver the way the protocol notes say a real one does, so the whole print
// sequence (info, start, numbered chunks, end, print, status polling) is run for real. What this CANNOT prove is that a
// real printer answers the same way: that needs one real try on a WIDE.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assemble } from './assemble-booth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'protected', 'src', 'printer', 'instax.js'), 'utf8');
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS: ' + name); } catch (e) { console.error('FAIL: ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } };

// ---- a sandbox with a fake canvas (records what is drawn) and a localStorage
function makeSandbox() {
  const store = new Map(), drawn = [], canvases = [];
  const mkCanvas = () => {
    const cv = { width: 0, height: 0, ops: [] };
    cv.getContext = () => ({
      fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: '',
      fillRect: (...a) => cv.ops.push(['fillRect', ...a]), save() { }, restore() { }, beginPath() { }, rect: (...a) => cv.ops.push(['clip', ...a]), clip() { },
      translate: (...a) => cv.ops.push(['translate', ...a]), rotate: (...a) => cv.ops.push(['rotate', ...a]),
      drawImage: (s, ...a) => { cv.ops.push(['drawImage', ...a]); drawn.push({ to: cv, src: s, args: a }); }
    });
    // A pretend JPEG whose size gets smaller as quality drops: size = quality * bytesAtFull
    cv.toBlob = (cb, type, q) => { const size = Math.round(q * (cv._full || 300000)); cb({ size, arrayBuffer: async () => new Uint8Array(size).map((_, i) => (i * 7 + 3) & 255).buffer }); };
    canvases.push(cv);
    return cv;
  };
  const win = {
    document: { createElement: () => mkCanvas() },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    navigator: {}, btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h), Promise, Uint8Array, JSON, Date, Math, console
  };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  ctx.document = win.document; ctx.localStorage = win.localStorage;
  vm.runInContext(src, ctx, { filename: 'instax.js' });
  return { win, ctx, store, drawn, canvases, mkCanvas };
}

// ---- a simulated INSTAX Link WIDE
function fakePrinter(T, o = {}) {
  const st = { img: [], chunks: [], started: 0, ended: 0, printed: 0, log: [], busyStarts: o.busyStarts || 0, processing: 0, writes: [] };
  const t = { connected: true, onData: null, onClose: null, close() { this.connected = false; } };
  const reply = (op1, op2, result, data) => {
    const body = [0x61, 0x42, 0, 0, op1, op2, result, ...(data || []), 0];
    body[2] = (body.length >> 8) & 255; body[3] = body.length & 255;
    const u = Uint8Array.from(body); u[u.length - 1] = T.checksumOf(u, u.length - 1);
    setTimeout(() => t.onData && t.onData(u), 0);
  };
  t.write = async (u8) => {
    st.writes.push(u8.length);
    // the outbound header is 41 62, the inbound parser wants 61 42: read it by hand
    assert.equal(u8[0], 0x41); assert.equal(u8[1], 0x62);
    const len = (u8[2] << 8) | u8[3]; assert.equal(len, u8.length, 'length field = whole frame');
    let sum = 0; for (let i = 0; i < u8.length; i++) sum += u8[i]; assert.equal(sum & 255, 255, 'checksum makes the sum 255');
    const op1 = u8[4], op2 = u8[5], pl = u8.subarray(6, len - 1);
    st.log.push(op1.toString(16) + '.' + op2.toString(16));
    if (op1 === 0 && op2 === 2 && pl[0] === 0) return reply(0, 2, 0, [0, 0x04, 0xEC, 0x03, 0x48, 2, 0, 0, 0x05, 0x40, 0]);   // 1260 x 840, max 0x00054000 = 344064
    if (op1 === 0 && op2 === 2 && pl[0] === 2) {
      const processing = st.processing > 0; if (processing) st.processing--;
      return reply(0, 2, 0, [2, o.film === undefined ? 0x27 : o.film, 0, o.resultData !== undefined && !processing ? o.resultData : (processing ? 127 : 0), 0, 0, 0, 0, 0]);
    }
    if (op1 === 0x10 && op2 === 0x00) {
      if (st.busyStarts > 0) { st.busyStarts--; return reply(0x10, 0, 1, []); }
      if (o.stuckStarts && (st.stuck = (st.stuck || 0) + 1) <= o.stuckStarts) return reply(0x10, 0, 133, []);
      if (o.startError) return reply(0x10, 0, o.startError, []);
      st.started++; st.size = (pl[4] * 16777216) + (pl[5] << 16) + (pl[6] << 8) + pl[7]; st.img = []; st.next = 0;
      assert.deepEqual([...pl.subarray(0, 4)], [2, 0, 0, 0]);
      return reply(0x10, 0, 0, [0, 0, 0x03, 0x84]);                  // 900
    }
    if (op1 === 0x10 && op2 === 0x01) {
      const idx = (pl[0] * 16777216) + (pl[1] << 16) + (pl[2] << 8) + pl[3];
      if (o.failFrame !== undefined && idx === o.failFrame) return reply(0x10, 1, 179, []);
      assert.equal(idx, st.next++, 'chunks are numbered from 0 in order');
      assert.equal(pl.length, 4 + 900, 'every chunk is the full size');
      st.img.push(...pl.subarray(4));
      return reply(0x10, 1, 0, u32(idx));
    }
    if (op1 === 0x10 && op2 === 0x02) { st.ended++; return reply(0x10, 2, 0, []); }
    if (op1 === 0x10 && op2 === 0x03) { st.cancels = (st.cancels || 0) + 1; return reply(0x10, 3, 0, []); }
    if (op1 === 0x10 && op2 === 0x80 && o.dropAtPrint) { st.printSeen = (st.printSeen || 0) + 1; return; }          // the answer never comes
    if (op1 === 0x10 && op2 === 0x80) { st.printed++; st.processing = o.processing == null ? 2 : o.processing; return reply(0x10, 0x80, 0, [12]); }
    reply(op1, op2, 0x80, []);
  };
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return { t, st };
}

const { win, ctx, store, drawn, mkCanvas } = makeSandbox();
const X = win._instax, T = X._t;

await test('a command is framed with header, whole-frame length and checksum', () => {
  const f = T.buildFrame(0x00, 0x02, [0x00]);
  assert.deepEqual([...f], [0x41, 0x62, 0x00, 0x08, 0x00, 0x02, 0x00, 0x52]);          // worked out by hand: 255 - 173 = 82
  assert.equal(T.buildFrame(0x10, 0x80, []).length, 7);
});

await test('an answer is parsed, and a damaged one is refused', () => {
  const ok = Uint8Array.from([0x61, 0x42, 0x00, 0x09, 0x10, 0x80, 0x00, 0x0C, 0]); ok[8] = T.checksumOf(ok, 8);
  const p = T.parseFrame(ok);
  assert.equal(p.op1, 0x10); assert.equal(p.op2, 0x80); assert.equal(p.result, 0); assert.deepEqual([...p.data], [12]);
  const bad = Uint8Array.from(ok); bad[7] ^= 1;
  assert.equal(T.parseFrame(bad), null);
  assert.equal(T.parseFrame(Uint8Array.from([0x41, 0x62, 0, 8, 0, 2, 0, 0x52])), null, 'our own header is not an answer');
});

await test('frames split over two notifications, or glued in one, are both read', () => {
  const mk = (op2, d) => { const u = Uint8Array.from([0x61, 0x42, 0, 8 + d.length, 0x10, op2, 0, ...d, 0]); u[u.length - 1] = T.checksumOf(u, u.length - 1); return u; };
  const a = mk(1, [1, 2, 3]), b = mk(2, []);
  const r = new T.FrameReader();
  assert.equal(r.push(a.subarray(0, 5)).length, 0);
  assert.equal(r.push(a.subarray(5)).length, 1);
  const both = new Uint8Array(a.length + b.length); both.set(a); both.set(b, a.length);
  assert.equal(r.push(both).length, 2);
  assert.equal(r.push(Uint8Array.from([9, 9, 9, ...a])).length, 1, 'noise before a header is skipped');
});

await test('the picture size and the film left are read from the printer answers', () => {
  assert.deepEqual({ ...T.parseImageInfo(Uint8Array.from([0, 0x04, 0xEC, 0x03, 0x48, 2, 0, 0, 5, 0x40, 0])) }, { width: 1260, height: 840, maxSize: 344064 });
  const s = T.parseFunctionInfo(Uint8Array.from([2, 0x37, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(s.film, 7); assert.equal(s.battery, 3);
});

await test('a whole print: start, numbered full chunks, end, print, then waits until it is done', async () => {
  const { t, st } = fakePrinter(T);
  const p = new T.Printer(t);
  const jpeg = Uint8Array.from({ length: 2000 }, (_, i) => (i * 13 + 1) & 255);          // 3 chunks: 900 + 900 + 200
  await p.printJpeg(jpeg, { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 });
  assert.equal(st.started, 1); assert.equal(st.ended, 1); assert.equal(st.printed, 1);
  assert.equal(st.size, 2000, 'the start tells the printer the true file size');
  assert.equal(st.img.length, 2700, 'the last chunk is padded with zeros');
  assert.deepEqual(st.img.slice(0, 2000), [...jpeg]);
  assert.ok(st.img.slice(2000).every(b => b === 0));
  assert.ok(st.log.indexOf('10.80') < st.log.lastIndexOf('0.2'), 'status is asked after the print command');
  assert.equal(st.processing, 0, 'it kept asking until the printer was no longer processing');
});

await test('a printer still busy with the last sheet is waited for', async () => {
  const { t, st } = fakePrinter(T, { busyStarts: 2 });
  const p = new T.Printer(t);
  const real = global.setTimeout; let slept = 0;
  global.setTimeout = (fn, ms) => real(fn, ms === 2500 ? (slept++, 1) : ms);          // the 3 s waits run fast
  try { await p.printJpeg(new Uint8Array(500), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }); } finally { global.setTimeout = real; }
  assert.equal(st.started, 1); assert.ok(slept >= 2);
});

await test('open cover, no film and a jam are said in plain words', async () => {
  for (const [code, re] of [[176, /cover is open/], [177, /out of film/], [180, /jammed/], [144, /battery/]]) {
    const { t } = fakePrinter(T, { startError: code });
    await assert.rejects(new T.Printer(t).printJpeg(new Uint8Array(100), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), re);
  }
  const { t } = fakePrinter(T, { resultData: 2, processing: 0 });
  await assert.rejects(new T.Printer(t).printJpeg(new Uint8Array(100), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), /out of film/, 'status 2 after printing means no film');
});

await test('a printer that never answers fails instead of hanging', async () => {
  const t = { connected: true, onData: null, onClose: null, write: async () => { }, close() { } };
  const p = new T.Printer(t);
  const real = global.setTimeout; global.setTimeout = (fn, ms) => real(fn, Math.min(ms, 5));
  try { await assert.rejects(p.getInfo(), /did not answer/); } finally { global.setTimeout = real; }
});

await test('the page is turned to landscape and fitted inside the WIDE white margin', async () => {
  const page = mkCanvas(); page.width = 732; page.height = 1169;               // 62 x 99 mm at 300 dpi, portrait like every booth paper
  page._full = 300000;
  const jpeg = await T.renderJpeg(page, { width: 1260, height: 840, maxSize: 344064 });
  assert.ok(jpeg.length > 0 && jpeg.length <= 344064);
  const out = drawn.filter(d => d.src && d.src.width === 1169 && d.src.height === 732).pop();
  assert.ok(out, 'the portrait page was first turned into a landscape canvas');
  const final = drawn.filter(d => d.to.width === 1260).pop();
  const [x, y, w, h] = final.args;
  assert.ok(x <= 12.01 && y <= 32.01, 'the picture starts at the margin or covers it');
  assert.ok(w >= 1236 && h >= 776, 'it covers the 1236 x 776 area');
});

await test('a big picture is re-saved smaller until it fits the printer limit', async () => {
  const page = mkCanvas(); page.width = 1169; page.height = 732; page._full = 900000;
  const real = mkCanvas;
  const jpeg = await T.renderJpeg(page, { width: 1260, height: 840, maxSize: 200000 }).catch(e => e);
  // the output canvas is created inside, so its _full is the default 300000: still above 200000 at 0.92, below at 0.64
  assert.ok(jpeg instanceof Uint8Array, String(jpeg));
  assert.ok(jpeg.length <= 200000); void real;
});

await test('a printer is remembered by name and appears as a printer in the lists', async () => {
  const { t } = fakePrinter(T);
  // adopt through the public pairing path using a fake Bluetooth stack
  ctx.navigator.bluetooth = {
    requestDevice: async () => ({ name: 'INSTAX-12345678(IOS)', id: 'dev1', addEventListener() { }, gatt: { connected: true, disconnect() { }, connect: async () => ({ getPrimaryService: async () => ({ getCharacteristics: async () => { const mk = u => ({ uuid: u, startNotifications: async () => { }, addEventListener(_, fn) { if (u.endsWith('84-2d83-473d-9e5f-81e1d02d5273')) t._fire = fn; }, writeValueWithoutResponse: async (v) => { await t.write(new Uint8Array(v)); } }); return [mk('70954783-2d83-473d-9e5f-81e1d02d5273'), mk('70954784-2d83-473d-9e5f-81e1d02d5273')]; } }) }) } })
  };
  t.onData = (u8) => t._fire && t._fire({ target: { value: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) } });
  const name = await X.pair();
  assert.equal(name, 'Instax: INSTAX-12345678(IOS)');
  assert.deepEqual([...X.names()], [name]);
  assert.ok(X.isInstaxName(name)); assert.ok(!X.isInstaxName('EPSON L8050'));
  assert.ok(JSON.parse(store.get('pb_instax_known'))[0].name === 'INSTAX-12345678(IOS)');
  X.forget(name);
  assert.equal(X.names().length, 0);
});

// A fake Web Bluetooth device wired to a simulated printer; asked-for options are recorded in `asked`.
function fakeBluetooth(asked, name, popts) {
  const { t, st } = fakePrinter(T, popts);
  t.onData = (u8) => t._fire && t._fire({ target: { value: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) } });
  let rx = [];                                                   // Bluetooth writes arrive in small pieces: put each frame back together
  const mkc = u => ({ uuid: u, startNotifications: async () => { }, addEventListener(_, fn) { if (u.startsWith('70954784')) t._fire = fn; }, writeValueWithoutResponse: async (v) => { rx = rx.concat([...new Uint8Array(v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)]); while (rx.length >= 4 && rx.length >= ((rx[2] << 8) | rx[3])) { const n = (rx[2] << 8) | rx[3]; const fr = Uint8Array.from(rx.slice(0, n)); rx = rx.slice(n); await t.write(fr); } } });
  const dev = { name, id: 'id-' + name, addEventListener() { }, gatt: { connected: true, disconnect() { }, connect: async () => ({ getPrimaryService: async () => ({ getCharacteristics: async () => [mkc('70954783-2d83-473d-9e5f-81e1d02d5273'), mkc('70954784-2d83-473d-9e5f-81e1d02d5273')] }) }) } };
  return { st, bt: { requestDevice: async (o) => { asked.push(o); return dev; } } };
}

await test('the first search also finds other spellings and the Instax service; "show all" lists every device', async () => {
  const asked = [], f = fakeBluetooth(asked, 'Instax-Wide-9');
  ctx.navigator.bluetooth = f.bt;
  const n1 = await X.pair();
  const flt = asked[0].filters;
  assert.ok(flt.some(x => x.namePrefix === 'INSTAX') && flt.some(x => x.namePrefix === 'Instax') && flt.some(x => x.namePrefix === 'instax'), 'three spellings');
  assert.ok(flt.some(x => x.services && x.services[0] === '70954782-2d83-473d-9e5f-81e1d02d5273'), 'and the printer service');
  const n2 = await X.pair({ all: true });
  assert.equal(asked[1].acceptAllDevices, true); assert.ok(!asked[1].filters);
  assert.equal(n1, n2);
  X.forget(n1);
});

await test('a printer set up before is found again by name, with no tap, and then prints', async () => {
  const asked = [], f = fakeBluetooth(asked, 'INSTAX-55555555(IOS)');
  ctx.navigator.bluetooth = f.bt;                                  // no getDevices: the browser remembers nothing
  store.set('pb_instax_known', JSON.stringify([{ name: 'INSTAX-55555555(IOS)', address: 'id-INSTAX-55555555(IOS)' }]));
  let asks = 0;
  win.pb4u = { bluetoothReconnect: async (name) => { asks++; try { await X._autoPair(name); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } } };
  const vname = 'Instax: INSTAX-55555555(IOS)';
  assert.ok(!X.connectedNow(vname));
  const page = mkCanvas(); page.width = 732; page.height = 1169;
  await X.print([page], null, vname, { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 });
  assert.equal(asks, 1, 'the laptop app was asked once');
  assert.equal(JSON.stringify(asked[0].filters), JSON.stringify([{ name: 'INSTAX-55555555(IOS)' }]), 'it asked for exactly that printer by name');
  assert.equal(f.st.printed, 1);
  assert.ok(X.connectedNow(vname));
  X.forget(vname);
});

await test('when the booth opens, printers set up before reconnect on their own, and a missing one does not throw', async () => {
  const asked = [], f = fakeBluetooth(asked, 'INSTAX-66666666(IOS)');
  ctx.navigator.bluetooth = f.bt;
  store.set('pb_instax_known', JSON.stringify([{ name: 'INSTAX-66666666(IOS)', address: 'x' }, { name: 'INSTAX-GONE', address: 'y' }]));
  win.pb4u = { bluetoothReconnect: async (name) => { try { await X._autoPair(name === 'INSTAX-GONE' ? 'INSTAX-66666666(IOS)' : name); return name === 'INSTAX-GONE' ? { ok: false, error: 'not found' } : { ok: true }; } catch (e) { return { ok: false, error: e.message }; } } };
  await X.autoReconnect();
  assert.ok(X.connectedNow('Instax: INSTAX-66666666(IOS)'));
  assert.ok(!X.connectedNow('Instax: INSTAX-GONE'));
  X.forget('Instax: INSTAX-66666666(IOS)'); X.forget('Instax: INSTAX-GONE');
  delete win.pb4u;
});


await test('a printer with no film is refused before any picture is sent', async () => {
  const { t, st } = fakePrinter(T, { film: 0x30 });                    // film 0, battery 3
  await assert.rejects(new T.Printer(t).printJpeg(new Uint8Array(500), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), /out of film/);
  assert.equal(st.started, 0);
});

await test('a printer left stuck by an earlier broken upload is cancelled and tried again', async () => {
  const { t, st } = fakePrinter(T, { stuckStarts: 1 });
  await new T.Printer(t).printJpeg(new Uint8Array(500), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 });
  assert.ok(st.cancels >= 1, 'the old upload was cancelled'); assert.equal(st.printed, 1);
  const again = fakePrinter(T, { stuckStarts: 9 });
  const real = global.setTimeout; global.setTimeout = (fn, ms) => real(fn, ms === 1000 ? 1 : ms);
  try { await assert.rejects(new T.Printer(again.t).printJpeg(new Uint8Array(500), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), /stuck.*Switch it off and on/); } finally { global.setTimeout = real; }
});

await test('a picture that fails half way is cancelled so the printer is not left half-loaded', async () => {
  const { t, st } = fakePrinter(T, { failFrame: 1 });
  await assert.rejects(new T.Printer(t).printJpeg(new Uint8Array(3000), { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), /did not accept the picture/);
  assert.equal(st.cancels, 1); assert.equal(st.printed, 0);
});

await test('a print command whose answer is lost is never sent again (no second sheet of film)', async () => {
  const asked = [], f = fakeBluetooth(asked, 'INSTAX-77777777(IOS)', { dropAtPrint: true });
  ctx.navigator.bluetooth = f.bt;
  const name = await X.pair();
  const page = mkCanvas(); page.width = 732; page.height = 1169;
  const real = global.setTimeout; global.setTimeout = (fn, ms) => real(fn, ms >= 15000 ? 5 : ms);          // only the wait for the print answer is shortened
  try { await assert.rejects(X.print([page], null, name, { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), /may still print/); } finally { global.setTimeout = real; }
  assert.equal(f.st.started, 1, 'the picture was sent once');
  assert.equal(f.st.printSeen, 1, 'the print command was sent once');
  X.forget(name);
});

await test('the picture is kept small (about 105 KB) even when the printer allows far more', async () => {
  const page = mkCanvas(); page.width = 732; page.height = 1169;
  const jpeg = await T.renderJpeg(page, { width: 1260, height: 840, maxSize: 1000000 });
  assert.ok(jpeg.length <= 105 * 1024, 'got ' + jpeg.length);
});

await test('two Instax printers print at the same time, and each keeps its own order', async () => {
  // run the real Printer over two fake printers through the job queue shape used by print()
  const A = fakePrinter(T), B = fakePrinter(T);
  const pa = new T.Printer(A.t), pb = new T.Printer(B.t);
  const jpeg = new Uint8Array(1800);
  await Promise.all([pa.printJpeg(jpeg, { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 }), pb.printJpeg(jpeg, { firstWaitMs: 0, prePrintMs: 0, pollMs: 1 })]);
  assert.equal(A.st.printed, 1); assert.equal(B.st.printed, 1);
});

await test('the page, the laptop app and the Android app are all wired to the driver', () => {
  const page = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  for (const w of ['G._instax = {', 'async function printViaInstax', 'if (isInstaxPrinter(name)) return printViaInstax', 'if (p && p.instax) { await window._instax.print', 'id="instaxPrinterBtn"', 'id="instaxAllBtn"', "add('__instax_connect__'", '.concat(instaxNames())', '_instax.autoReconnect()'])
    assert.ok(page.includes(w), 'protected/booth.html is missing: ' + w);
  assert.equal(assemble().html, page, 'protected/booth.html is what the sources produce (run npm run build)');
  const android = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'booth.html'), 'utf8');
  assert.equal(android, page, 'the Android copy of the page is the same page (run npm run build)');
  const mainSrc = readFileSync(join(ROOT, 'desktop', 'main.mjs'), 'utf8');
  assert.ok(mainSrc.includes("'select-bluetooth-device'") && mainSrc.includes("'pb4u:bluetoothReconnect'"), 'the laptop app answers the Bluetooth picker and reconnects by name');
  assert.ok(readFileSync(join(ROOT, 'desktop', 'preload.cjs'), 'utf8').includes('bluetoothReconnect'), 'the page can ask the laptop app to reconnect');
  assert.ok(readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'InstaxBridge.kt'), 'utf8').includes('fun pickAll()'), 'the Android bridge can list every device');
  assert.ok(readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'MainActivity.kt'), 'utf8').includes('"__InstaxBridge"'), 'the Android app injects the bridge');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
