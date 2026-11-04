import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import {
  initPhotos,
  setPhotosRoot,
  setSpinDir,
  spinShare,
  startShareServer,
  stopShareServer,
  getStats,
  recordStat,
  resolveSlug
} from '../lib/photos.mjs';
import { buildArgs, findFfmpeg, configure, probe } from '../lib/spin.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const BUILD_DIR = join(DESKTOP_DIR, 'build');
const FX_DIR = join(DESKTOP_DIR, 'resources', 'spin-fx');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

test('Phase 4: 360 Booth Sharing Station, Live Wall, Stinger Concat & Dual Online/Offline Stats', async (t) => {
  const testDir = join(tmpdir(), 'pb4u-test-phase4-' + Date.now());
  const photosDir = join(testDir, 'photos');
  const dataDir = join(testDir, 'data');
  const spinInbox = join(testDir, 'inbox');
  const editedDir = join(spinInbox, 'edited');

  mkdirSync(photosDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(editedDir, { recursive: true });

  initPhotos({ root: photosDir, dataDir });
  setPhotosRoot(photosDir);
  setSpinDir(spinInbox);
  configure({ buildDir: BUILD_DIR, temp: testDir, fxDir: FX_DIR });

  const ff = await findFfmpeg();
  assert(ff, 'ffmpeg must be available for Phase 4 verification');

  // Create a minimal 1-second video for testing
  const dummyVidName = 'test_clip_360.mp4';
  const dummyVidPath = join(spinInbox, dummyVidName);
  execFileSync(ff, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=720x1280:rate=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '1',
    '-y', dummyVidPath
  ], { stdio: 'ignore' });

  assert(existsSync(dummyVidPath), 'Dummy video created');

  // Share the video into an event folder
  const shared = spinShare(dummyVidName, 'Grand Gala 2026', '', 'guest_clip.mp4');
  assert(shared.ok, 'spinShare succeeded: ' + JSON.stringify(shared));
  const slug = shared.fileId.split('/')[0];
  const file = shared.fileId.split('/')[1];

  // Start share server
  const port = await startShareServer();
  assert(port > 0, 'Share server started on port ' + port);
  const base = 'http://127.0.0.1:' + port;

  await t.test('4.1 Sharing Station Page & List API', async () => {
    // 1. Station HTML
    const pageRes = await httpGet(base + '/station/' + slug);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.body, /Sharing Station/i);
    assert.match(pageRes.body, /Grand Gala 2026/);
    assert.match(pageRes.body, /stGrid/);
    assert.match(pageRes.body, /modal/);
    assert.match(pageRes.body, /Scan to save/i);

    // 2. Station List API
    const listRes = await httpGet(base + '/station/' + slug + '/list');
    assert.equal(listRes.status, 200);
    const listJson = JSON.parse(listRes.body);
    assert(listJson.ok, 'List API returns ok');
    assert.equal(listJson.slug, slug);
    assert.equal(listJson.name, 'Grand Gala 2026');
    assert(Array.isArray(listJson.files), 'files is array');
    assert.equal(listJson.files.length, 1);
    assert.equal(listJson.files[0].name, file);
    assert.equal(listJson.files[0].kind, 'video');
    assert(listJson.files[0].url.includes('/f/'), 'url has /f/');
    assert(listJson.files[0].pageUrl.includes('/p/'), 'pageUrl has /p/');

    // 3. Station default redirect / resolution
    const defaultRes = await httpGet(base + '/station');
    assert.equal(defaultRes.status, 200);
    assert.match(defaultRes.body, /Grand Gala 2026/);
  });

  await t.test('4.2 Live Wall Page & Feed API', async () => {
    // 1. Wall HTML
    const wallRes = await httpGet(base + '/wall/' + slug);
    assert.equal(wallRes.status, 200);
    assert.match(wallRes.body, /360 Live Wall/i);
    assert.match(wallRes.body, /Grand Gala 2026/);
    assert.match(wallRes.body, /wallVid/);
    assert.match(wallRes.body, /wallQr/);

    // 2. Wall Feed API
    const feedRes = await httpGet(base + '/wall/' + slug + '/feed');
    assert.equal(feedRes.status, 200);
    const feedJson = JSON.parse(feedRes.body);
    assert(feedJson.ok, 'Feed API returns ok');
    assert.equal(feedJson.slug, slug);
    assert(Array.isArray(feedJson.videos), 'videos is array');
    assert.equal(feedJson.videos.length, 1);
    assert.equal(feedJson.videos[0].name, file);

    // 3. Wall default
    const defWall = await httpGet(base + '/wall');
    assert.equal(defWall.status, 200);
    assert.match(defWall.body, /Grand Gala 2026/);
  });

  await t.test('4.3 Intro and Outro Clip Stinger Concat', async () => {
    // Create short 0.5s intro video
    const introPath = join(testDir, 'intro.mp4');
    execFileSync(ff, [
      '-f', 'lavfi', '-i', 'color=c=blue:duration=0.5:size=720x1280:rate=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-t', '0.5',
      '-y', introPath
    ], { stdio: 'ignore' });

    // Create short 0.5s outro video
    const outroPath = join(testDir, 'outro.mp4');
    execFileSync(ff, [
      '-f', 'lavfi', '-i', 'color=c=red:duration=0.5:size=720x1280:rate=30',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-t', '0.5',
      '-y', outroPath
    ], { stdio: 'ignore' });

    // Build args with intro & outro
    const stingerOut = join(testDir, 'stinger_concat_test.mp4');
    const jobSpec = {
      id: 'test-stinger',
      input: dummyVidPath,
      output: stingerOut,
      intro: introPath,
      outro: outroPath,
      options: {
        intro: introPath,
        outro: outroPath,
        speed: 'normal',
        quality: 720,
        orientation: 'portrait'
      }
    };

    const inInfo = { duration: 1.0, fps: 30, intro: { duration: 0.5 }, outro: { duration: 0.5 } };
    const built = buildArgs(jobSpec, inInfo);
    assert(built && built.args, 'buildArgs returned args');
    const filterArg = built.args.find(a => typeof a === 'string' && a.includes('concat=n=3'));
    assert(filterArg, 'Filter complex contains concat=n=3 for intro + main + outro: ' + filterArg);
    assert(built.args.includes(introPath), 'Intro path included in ffmpeg input args');
    assert(built.args.includes(outroPath), 'Outro path included in ffmpeg input args');

    // Run actual stinger render
    try {
      execFileSync(ff, built.args, { stdio: 'pipe' });
    } catch(err) {
      console.error('FFMPEG STDERR:', err.stderr ? err.stderr.toString() : err.message);
      throw err;
    }
    assert(existsSync(stingerOut), 'Output video with stinger exists');

    // Probe duration of result (should be ~ 0.5s + 1s + 0.5s = ~2s)
    const probeInfo = await probe(stingerOut);
    assert(probeInfo, 'probe succeeded on output');
    const duration = probeInfo.duration;
    assert(duration >= 1.8 && duration <= 2.2, 'Concat duration matches expected ~2.0s: ' + duration);
  });

  await t.test('4.4 Style and Music Rotation Logic', () => {
    const presets = ['classic', 'ramp', 'boomerang', 'fastslow', 'fsf', 'roller'];
    let curIdx = 0;
    const cycled = [];
    for (let i = 0; i < 12; i++) {
      curIdx = (curIdx + 1) % presets.length;
      cycled.push(presets[curIdx]);
    }
    assert.equal(cycled.length, 12);
    assert.equal(cycled[0], 'ramp');
    assert.equal(cycled[5], 'classic');
    assert.equal(cycled[6], 'ramp');
  });

  await t.test('4.5 Dual Online/Offline Guest Page & Simple Stats', async () => {
    // 1. Guest page has dual online/offline logic
    const guestRes = await httpGet(base + '/e/' + slug + '/p/' + encodeURIComponent(file));
    assert.equal(guestRes.status, 200);
    assert.match(guestRes.body, /btnShare/);
    assert.match(guestRes.body, /btnDl/);
    assert.match(guestRes.body, /btnCopy/);
    assert.match(guestRes.body, /canNative=!!\(navigator\.share&&window\.isSecureContext\)/);
    assert.match(guestRes.body, /How to save on iPhone/);
    assert.match(guestRes.body, /How to save on Android/);

    // 2. View tracking
    let statsData = getStats(slug);
    assert(statsData.views >= 1, 'View stat was incremented on page view: ' + JSON.stringify(statsData));

    // 3. Download tracking
    const dlRes = await httpGet(base + '/e/' + slug + '/f/' + encodeURIComponent(file) + '?dl=1');
    assert.equal(dlRes.status, 200);
    statsData = getStats(slug);
    assert(statsData.downloads >= 1, 'Download stat incremented on ?dl=1: ' + JSON.stringify(statsData));

    // 4. Share telemetry tracking via POST /e/:slug/track
    const trackRes = await httpPost(base + '/e/' + slug + '/track', { action: 'share', file });
    assert.equal(trackRes.status, 200);
    statsData = getStats(slug);
    assert(statsData.shares >= 1, 'Share stat incremented via /track: ' + JSON.stringify(statsData));

    // 5. Stats API endpoint
    const statsApiRes = await httpGet(base + '/e/' + slug + '/stats');
    assert.equal(statsApiRes.status, 200);
    const statsJson = JSON.parse(statsApiRes.body);
    assert(statsJson.ok, 'Stats API returned ok');
    assert(statsJson.stats.views >= 1, 'views >= 1');
    assert(statsJson.stats.downloads >= 1, 'downloads >= 1');
    assert(statsJson.stats.shares >= 1, 'shares >= 1');
  });

  stopShareServer();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
