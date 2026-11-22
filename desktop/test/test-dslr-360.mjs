// End-to-end automated verification for Desktop DSLR / Capture Card / GoPro 360 capture:
// - winsensor.mjs calibration math & mocked WinRT streaming
// - photos.mjs spinSaveVideo atomic inbox write & spinList pickup
// - camera-mac.mjs / cam-nikon.mjs Canon + Nikon exposure (including WB), movie start/stop + 1.5MB chunked stream
// - Sony USB movie rejection guidance
// - cam-gopro.mjs & helper.mjs /camera/movie/{start,status,stop}
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtpSession } from '../lib/ptp.mjs';
import * as cam from '../lib/camera-mac.mjs';
import * as gopro from '../lib/cam-gopro.mjs';
import * as sensor from '../lib/winsensor.mjs';
import { initPhotos, setSpinDir, spinSaveVideo, spinList } from '../lib/photos.mjs';
import { initHelper, handleHelper, stopHelper } from '../lib/helper.mjs';

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log('PASS ' + msg);
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const ptpStr = (s) => Buffer.concat([Buffer.from([s ? s.length + 1 : 0]), s ? Buffer.from(s + '\0', 'utf16le') : Buffer.alloc(0)]);
const u16Arr = (arr) => Buffer.concat([u32(arr.length), ...arr.map(u16)]);
const deviceInfo = (vendor, ops, props, maker, model) => Buffer.concat([
  u16(100), u32(vendor), u16(100), ptpStr(''), u16(0),
  u16Arr(ops), u32(0), u16Arr(props), u32(0), u32(0),
  ptpStr(maker), ptpStr(model), ptpStr('1.0'), ptpStr('0001')
]);
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);

// Minimal in-memory PtpSession transport stub (mirrors fake-canon.mjs / fake-nikon-sony.mjs)
class BaseFakeTransport {
  constructor() { this.q = []; this.closed = false; }
  async write(buf) {
    const type = buf.readUInt16LE(4), code = buf.readUInt16LE(6), tid = buf.readUInt32LE(8);
    if (type === 1) {
      const ps = []; for (let o = 12; o + 4 <= buf.length; o += 4) ps.push(buf.readUInt32LE(o));
      if (this.pendingWrite && this.pendingWrite.tid === tid) return;
      this.handle(code, tid, ps);
    } else if (type === 2 && this.pendingWrite && this.pendingWrite.tid === tid) {
      const payload = buf.subarray(12);
      const pw = this.pendingWrite; this.pendingWrite = null;
      this.onData(pw, payload);
    }
  }
  async read() { return this.q.shift() || Buffer.alloc(0); }
  async close() { this.closed = true; }
  dataOut(tid, code, data) {
    const hdr = Buffer.alloc(12);
    hdr.writeUInt32LE(12 + data.length, 0); hdr.writeUInt16LE(2, 4); hdr.writeUInt16LE(code, 6); hdr.writeUInt32LE(tid, 8);
    this.q.push(Buffer.concat([hdr, data]));
  }
  respond(tid, resp, ...ps) {
    const b = Buffer.alloc(12 + ps.length * 4);
    b.writeUInt32LE(b.length, 0); b.writeUInt16LE(3, 4); b.writeUInt16LE(resp, 6); b.writeUInt32LE(tid, 8);
    ps.forEach((v, i) => b.writeUInt32LE(v >>> 0, 12 + i * 4));
    this.q.push(b);
  }
  common(code, tid) {
    if (code === 0x1002 || code === 0x1003) { this.respond(tid, 0x2001); return true; }
    return false;
  }
  onData(pw) { this.respond(pw.tid, 0x2001); }
}

class FakeCanonMovie extends BaseFakeTransport {
  constructor(movieBuf) {
    super();
    this.movie = movieBuf;
    this.saveTo = 4; this.availShots = 999; this.remote = 0; this.live = false;
    this.av = 0x20; this.tv = 0x68; this.iso = 0x58; this.wb = 0; this.movieTarget = 0;
    this.pendingMovie = false;
    this.calls = [];
  }
  availRec(prop, vals) { return Buffer.concat([u32(20 + vals.length * 4), u32(0xC18A), u32(prop), u32(4), u32(vals.length), ...vals.map(u32)]); }
  valRec(prop, val) { return Buffer.concat([u32(16), u32(0xC189), u32(prop), u32(val)]); }
  onData(pw, data) {
    if (pw.code === 0x9110 && data.length >= 12) {
      const prop = data.readUInt16LE(4), val = data.readUInt32LE(8);
      this.calls.push(`set:${prop.toString(16)}=${val}`);
      if (prop === 0xD11C) this.saveTo = val;
      else if (prop === 0xD101) this.av = val;
      else if (prop === 0xD102) this.tv = val;
      else if (prop === 0xD103) this.iso = val;
      else if (prop === 0xD109) this.wb = val;
      else if (prop === 0xD1B8) { this.movieTarget = val; if (val === 0) this.pendingMovie = true; }
      return this.respond(pw.tid, 0x2001);
    }
    return this.respond(pw.tid, 0x2001);
  }
  handle(code, tid, ps) {
    if (this.common(code, tid)) return;
    if (code === 0x1001) {
      this.dataOut(tid, code, deviceInfo(0x0B, [0x1001, 0x1002, 0x1003, 0x1008, 0x101B, 0x910F, 0x9110, 0x9114, 0x9115, 0x9116, 0x911A, 0x9128, 0x9129, 0x9153, 0x9107], [], 'Canon Inc.', 'Canon EOS M6 Mark II'));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x9114) { this.remote = ps[0] || 0; return this.respond(tid, 0x2001); }
    if (code === 0x9115 || code === 0x911A || code === 0x9154) return this.respond(tid, 0x2001);
    if (code === 0x9110) { this.pendingWrite = { code, tid, ps }; return; }
    if (code === 0x9116) {
      const recs = [
        this.valRec(0xD11C, this.saveTo), this.valRec(0xD11B, this.availShots),
        this.valRec(0xD105, 20), this.valRec(0xD101, this.av), this.valRec(0xD102, this.tv), this.valRec(0xD103, this.iso), this.valRec(0xD109, this.wb),
        this.availRec(0xD11C, [2, 4]), this.availRec(0xD101, [0x20, 0x28]),
        this.availRec(0xD102, [0x68, 0x70, 0x78]), this.availRec(0xD103, [0x58, 0x60]), this.availRec(0xD109, [0, 1, 2])
      ];
      if (this.pendingMovie) {
        this.pendingMovie = false;
        recs.push(Buffer.concat([u32(32), u32(0xC181), u32(0x33330001), u32(0), u16(0x300D), u16(0), u32(0), u32(0), u32(this.movie.length)]));
      }
      this.dataOut(tid, code, Buffer.concat(recs));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x1008) {
      const nm = 'MVI_0042.MOV';
      const hdr = Buffer.concat([u32(1), u16(0x300D), u16(0), u32(this.movie.length), Buffer.alloc(40), ptpStr(nm)]);
      this.dataOut(tid, code, hdr);
      return this.respond(tid, 0x2001);
    }
    if (code === 0x101B) {
      const [, off, len] = ps;
      this.dataOut(tid, code, this.movie.subarray(off, off + len));
      return this.respond(tid, 0x2001);
    }
    return this.respond(tid, 0x2001);
  }
}

class FakeNikonMovie extends BaseFakeTransport {
  constructor(movieBuf) {
    super();
    this.movie = movieBuf;
    this.props = new Map([
      [0x500E, { type: 4, cur: 1, choices: [1, 2, 3, 4], gs: 0 }],
      [0x500D, { type: 6, cur: 100, choices: [125, 100, 80, 63, 40], gs: 1 }],
      [0x5007, { type: 4, cur: 280, choices: [280, 400, 560], gs: 1 }],
      [0x500F, { type: 4, cur: 400, choices: [100, 200, 400, 800], gs: 1 }],
      [0x5005, { type: 4, cur: 2, choices: [2, 4, 5, 6], gs: 1 }],
      [0xD10B, { type: 2, cur: 1, choices: [0, 1], gs: 1 }],
      [0xD1A6, { type: 2, cur: 0, choices: [0, 1], gs: 1 }]
    ]);
    this.pendingMovie = false;
    this.live = false;
  }
  onData(pw, data) {
    if (pw.code === 0x1016) {
      const e = this.props.get(pw.ps[0]);
      if (e) e.cur = e.type === 2 ? data[0] : (e.type === 4 ? data.readUInt16LE(0) : data.readUInt32LE(0));
    }
    return this.respond(pw.tid, 0x2001);
  }
  handle(code, tid, ps) {
    if (this.common(code, tid)) return;
    if (code === 0x1001) {
      this.dataOut(tid, code, deviceInfo(0x0A, [0x1001, 0x1002, 0x1003, 0x1008, 0x1014, 0x1016, 0x101B, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x920A, 0x920B], [0x5005, 0x5007, 0x500D, 0x500E, 0x500F, 0xD10B, 0xD1A6], 'Nikon Corporation', 'Z 6'));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x1014) {
      const e = this.props.get(ps[0]);
      if (!e) return this.respond(tid, 0x200A);
      const val = (v) => (e.type === 2 ? Buffer.from([v]) : e.type === 4 ? u16(v) : u32(v));
      this.dataOut(tid, code, Buffer.concat([u16(ps[0]), u16(e.type), Buffer.from([e.gs]), val(e.choices[0]), val(e.cur), Buffer.from([2]), u16(e.choices.length), ...e.choices.map(val)]));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x1016) { this.pendingWrite = { code, tid, ps }; return; }
    if (code === 0x9201) { this.live = true; return this.respond(tid, 0x2001); }
    if (code === 0x9202) { this.live = false; return this.respond(tid, 0x2001); }
    if (code === 0x920A) return this.respond(tid, 0x2001);
    if (code === 0x920B) { this.pendingMovie = true; return this.respond(tid, 0x2001); }
    if (code === 0x90C7) {
      this.dataOut(tid, code, this.pendingMovie ? (this.pendingMovie = false, Buffer.concat([u16(1), u16(0x4002), u32(0x88880001)])) : u16(0));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x1008) {
      const nm = 'DSC_0099.MP4';
      this.dataOut(tid, code, Buffer.concat([u32(1), u16(0xB982), u16(0), u32(this.movie.length), Buffer.alloc(40), ptpStr(nm)]));
      return this.respond(tid, 0x2001);
    }
    if (code === 0x101B) {
      const [, off, len] = ps;
      this.dataOut(tid, code, this.movie.subarray(off, off + len));
      return this.respond(tid, 0x2001);
    }
    return this.respond(tid, 0x2001);
  }
}

const rootTmp = mkdtempSync(join(tmpdir(), 'pb4u-360-test-'));
const spinTmp = join(rootTmp, 'spin-inbox');
mkdirSync(spinTmp, { recursive: true });

try {
  // 1. winsensor.mjs tests
  const metaP = sensor.parseSensorLine('{"available":true,"gyro":true,"accel":false}');
  ok(metaP && metaP.meta === true && metaP.gyro === true, 'winsensor: parses capability meta line');
  const sampP = sensor.parseSensorLine('{"t":120,"dps":42.7,"gd":0.03}', { gyro: true });
  ok(sampP && !sampP.meta && sampP.dps === 42.7 && sampP.source === 'gyro', 'winsensor: parses gyro sample');
  const calDps = sensor.computeSensitivity({ stillSamples: [1.5, 2.8, 3.1], spinSamples: [48, 65, 72, 68], unit: 'dps' });
  ok(calDps.startThresh > calDps.baseline && calDps.startThresh < calDps.peak && calDps.stopThresh < calDps.startThresh, 'winsensor: calibrates dps thresholds cleanly');
  const calG = sensor.computeSensitivity({ stillSamples: [0.02, 0.04], spinSamples: [0.42, 0.55, 0.5], unit: 'g' });
  ok(calG.unit === 'g' && calG.startThresh > 0.08 && calG.stopThresh < calG.startThresh, 'winsensor: calibrates accel delta-g thresholds');

  let emitMock = null;
  let stopped = false;
  sensor.setBackend({
    probe: async () => ({ available: true, gyro: true, accel: true }),
    start: async (cb) => { emitMock = cb; return { ok: true, available: true, gyro: true, accel: true }; },
    stop: () => { stopped = true; }
  });
  const pr = await sensor.probeSensor();
  ok(pr.ok && pr.available && pr.gyro, 'winsensor: probeSensor reads backend');
  const seen = [];
  await sensor.startSensor((r) => seen.push(r));
  emitMock('{"t":50,"dps":33.2,"gd":0.01}');
  ok(seen.length === 1 && sensor.latestSensor().dps === 33.2, 'winsensor: startSensor forwards readings and updates latestSensor');
  sensor.stopSensor();
  ok(stopped === true, 'winsensor: stopSensor cleans up backend');
  sensor.setBackend(null);

  // 2. photos.mjs::spinSaveVideo test
  initPhotos({ root: join(rootTmp, 'photos'), dataDir: join(rootTmp, 'data'), makeThumb: async () => null });
  setSpinDir(spinTmp);
  const sampleWebm = crypto.randomBytes(16384);
  const svBad = await spinSaveVideo({ filename: 'bad.webm', buffer: Buffer.from('tiny') });
  ok(svBad.ok === false, 'photos::spinSaveVideo rejects empty/tiny video buffers');
  const svOk = await spinSaveVideo({ filename: '../unsafe clip.mp4', buffer: sampleWebm });
  ok(svOk.ok && svOk.filename === 'unsafe-clip.mp4' && readFileSync(svOk.path).equals(sampleWebm), 'photos::spinSaveVideo atomically writes sanitized MP4 into 360 inbox');
  ok(!readdirSync(spinTmp).some((n) => n.endsWith('.part')), 'photos::spinSaveVideo leaves no .part temp files');
  ok(spinList({ minAgeMs: 0 }).some((it) => it.name === 'unsafe-clip.mp4'), 'photos::spinList immediately discovers saved capture');

  // 3. Canon M6 II via camera-mac.mjs (props, setprops, 1.5MB chunked moviestart/moviestop)
  const canonMov = crypto.randomBytes(1500000); // > 1MB forces multi-chunk 0x101B streaming
  const fc = new FakeCanonMovie(canonMov);
  cam.setBackend({ list: () => [{ vendor: 0x04a9, product: 0x32b4, key: '1:1' }], open: async () => new PtpSession(fc), free: async () => {} });
  let res = await cam.call('open', '');
  ok(res.status === 'OK', 'camera-mac Canon open succeeds');
  const cp = JSON.parse((await cam.call('props', '')).body.toString());
  ok(cp.supported && Math.abs(cp.shutter - (1 / 60)) < 0.002 && cp.f === 2.8 && cp.wb === 0 && cp.wbChoices.length === 3, 'camera-mac Canon props reads Av/Tv/ISO/WB');
  const csp = JSON.parse((await cam.call('setprops', 'shutter=0.004&iso=800&wb=1')).body.toString());
  ok(csp.results.shutter === 'set' && csp.results.iso === 'set' && csp.results.wb === 'set' && fc.tv === 0x78 && fc.wb === 1, 'camera-mac Canon setprops picks nearest APEX + WB');
  const cms = await cam.call('moviestart', '');
  ok(cms.status === 'OK' && fc.saveTo === 2 && fc.movieTarget === 4, 'camera-mac Canon moviestart switches SaveTo->card(2) & 0xD1B8=4');
  const cmst = await cam.call('moviestop', spinTmp);
  const cmJson = JSON.parse(cmst.body.toString());
  ok(cmJson.ok && cmJson.bytes === canonMov.length && readFileSync(cmJson.path).equals(canonMov) && fc.saveTo === 4, 'camera-mac Canon moviestop streams 1.5MB .mov in multiple chunks & restores SaveTo=4');
  await cam.call('close', '');

  // 4. Nikon Z6 via cam-nikon.mjs (WB + movie)
  const nikMp4 = crypto.randomBytes(300000);
  const fn = new FakeNikonMovie(nikMp4);
  cam.setBackend({ list: () => [{ vendor: 0x04b0, product: 0x0442, key: '1:2' }], open: async () => new PtpSession(fn), free: async () => {} });
  await cam.call('open', '');
  const np = JSON.parse((await cam.call('props', '')).body.toString());
  ok(np.supported && np.wb === 2 && np.wbChoices.length === 4 && np.set.wb, 'cam-nikon props reads WB 0x5005 & choices');
  const nsp = JSON.parse((await cam.call('setprops', 'wb=4')).body.toString());
  ok(nsp.results.wb === 'set' && fn.props.get(0x5005).cur === 4, 'cam-nikon setprops writes WB');
  await cam.call('moviestart', '');
  ok(fn.props.get(0xD10B).cur === 0 && fn.props.get(0xD1A6).cur === 1 && fn.live === true, 'cam-nikon moviestart switches Card(0), Movie LV(1) & LV on');
  const nmst = JSON.parse((await cam.call('moviestop', spinTmp)).body.toString());
  ok(nmst.ok && nmst.bytes === nikMp4.length && readFileSync(nmst.path).equals(nikMp4) && fn.props.get(0xD10B).cur === 1 && fn.props.get(0xD1A6).cur === 0, 'cam-nikon moviestop streams MP4 & restores 0xD1A6/0xD10B');
  await cam.call('close', '');

  // 4b. Sony USB movie rejection guidance
  class FakeSonyStub extends BaseFakeTransport {
    handle(code, tid) {
      if (this.common(code, tid)) return;
      if (code === 0x1001) { this.dataOut(tid, code, deviceInfo(0x11, [0x1001, 0x1002, 0x1003, 0x1008, 0x1009, 0x9201, 0x9202, 0x9205, 0x9207, 0x9209], [], 'Sony Corporation', 'ILCE-7M3')); return this.respond(tid, 0x2001); }
      if (code === 0x9202) { const b = Buffer.alloc(8); b.writeUInt16LE(0x12C, 0); this.dataOut(tid, code, b); return this.respond(tid, 0x2001); }
      if (code === 0x9209) { this.dataOut(tid, code, Buffer.alloc(8)); return this.respond(tid, 0x2001); }
      return this.respond(tid, 0x2001);
    }
  }
  cam.setBackend({ list: () => [{ vendor: 0x054c, product: 0x1234, key: '1:3' }], open: async () => new PtpSession(new FakeSonyStub()), free: async () => {} });
  await cam.call('open', '');
  const sm = await cam.call('moviestart', '');
  ok(sm.status === 'ERR' && /^UNSUPPORTED /.test(sm.body.toString()) && /Capture Card/i.test(sm.body.toString()), 'Sony USB moviestart returns UNSUPPORTED pointing to HDMI Capture Card');
  await cam.call('close', '');
  cam.setBackend(null);

  // 5. GoPro movie + helper /camera/movie/* endpoints
  const gpMp4 = crypto.randomBytes(220000);
  let gpState = { hasRecorded: false, webcamStarted: false, webcamStopped: false, shutterStart: false, shutterStop: false };
  const ffExe = [join(process.cwd(), 'desktop', 'build', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')].find(existsSync) || 'ffmpeg';
  let udpSender = null;
  const stopUdp = () => { if (udpSender) { try { udpSender.kill(); } catch { } udpSender = null; } };

  const gpSrv = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/gopro/camera/info') { res.writeHead(200); res.end(JSON.stringify({ info: { model_name: 'HERO12 Black', serial_number: 'C3501325000001' } })); return; }
    if (u.pathname === '/gopro/camera/state') { res.writeHead(200); res.end(JSON.stringify({ status: { 70: 95 } })); return; }
    if (u.pathname === '/gopro/webcam/start') {
      gpState.webcamStarted = true;
      stopUdp();
      const port = Number(u.searchParams.get('port')) || 8554;
      udpSender = spawn(ffExe, ['-re', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=15', '-c:v', 'mpeg2video', '-f', 'mpegts', `udp://127.0.0.1:${port}?pkt_size=1316`], { windowsHide: true, stdio: 'ignore' });
      res.writeHead(200); res.end('{"error":0,"status":2}'); return;
    }
    if (u.pathname === '/gopro/webcam/stop') { gpState.webcamStopped = true; stopUdp(); res.writeHead(200); res.end('{"error":0,"status":1}'); return; }
    if (u.pathname === '/gopro/camera/shutter/start') { gpState.shutterStart = true; res.writeHead(200); res.end('{}'); return; }
    if (u.pathname === '/gopro/camera/shutter/stop') { gpState.shutterStop = true; gpState.hasRecorded = true; res.writeHead(200); res.end('{}'); return; }
    if (u.pathname === '/gopro/media/list') {
      const files = gpState.hasRecorded ? [{ n: 'GX010001.MP4', s: String(gpMp4.length) }] : [];
      res.writeHead(200); res.end(JSON.stringify({ media: [{ d: '100GOPRO', fs: files }] })); return;
    }
    if (u.pathname === '/videos/DCIM/100GOPRO/GX010001.MP4') {
      res.writeHead(200, { 'content-length': String(gpMp4.length) }); res.end(gpMp4); return;
    }
    res.writeHead(200); res.end('{}');
  });
  await new Promise((r) => gpSrv.listen(0, '127.0.0.1', r));
  const gpPort = gpSrv.address().port;

  try {
    gopro.setBackend({ hosts: [{ host: '127.0.0.1', port: gpPort, mode: 'usb' }], ffmpeg: ffExe, streamPort: 18554 });
    initHelper({ workerPath: join(process.cwd(), 'tools', 'print-helper', 'camera-worker.ps1'), spinInboxDir: () => spinTmp, logger: () => {} });
    const hr = (m, p) => { const [pa, q] = p.split('?'); return handleHelper(new Request('http://x/helper' + pa + (q ? '?' + q : ''), { method: m }), pa, new URLSearchParams(q || '')); };

    let hOpen = await hr('POST', '/camera/open');
    let hOpenBody = await hOpen.clone().text().catch(() => '');
    ok(hOpen.status === 200 && gopro.isOpen(), 'helper + GoPro open succeeds (' + hOpen.status + ': ' + hOpenBody + ')');
    let hStart = await hr('POST', '/camera/movie/start');
    ok(hStart.status === 200 && gpState.webcamStopped && gpState.shutterStart, 'helper /camera/movie/start stops webcam & triggers GoPro shutter');
    let hStat = await (await hr('GET', '/camera/movie/status')).json();
    ok(hStat.ok && hStat.active && hStat.state === 'recording', 'helper /camera/movie/status reports recording immediately');
    let hStop = await (await hr('POST', '/camera/movie/stop')).json();
    ok(hStop.ok && gpState.shutterStop && hStop.bytes === gpMp4.length && readFileSync(hStop.path).equals(gpMp4), 'helper /camera/movie/stop polls media & downloads GoPro MP4 into spin inbox');
    let hClose = await hr('POST', '/camera/close');
    ok(hClose.status === 200 && !gopro.isOpen(), 'helper /camera/close resets GoPro');
  } finally {
    stopUdp();
    stopHelper();
    await gopro.reset();
    try { gpSrv.close(); gpSrv.closeAllConnections && gpSrv.closeAllConnections(); } catch { }
    gopro.setBackend({});
  }

  console.log(`\nALL ${passed} DSLR/360 CAPTURE CHECKS PASSED`);
} finally {
  try { rmSync(rootTmp, { recursive: true, force: true }); } catch { }
}
process.exit(0);
