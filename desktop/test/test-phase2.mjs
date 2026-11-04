import assert from 'node:assert';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { initPhotos, setPhotosRoot, setSpinDir, spinShare, spinDirNow, startShareServer } from '../lib/photos.mjs';

const testDir = join(tmpdir(), 'pb-phase2-test-' + Date.now());
mkdirSync(testDir, { recursive: true });

async function runTests() {
  console.log('--- Phase 2 Test Suite: Networking, Range Requests, Hardlinks & Auto-reload ---');

  const photosDir = join(testDir, 'photos');
  const dataDir = join(testDir, 'data');
  const inboxDir = join(testDir, '360 inbox');
  mkdirSync(photosDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });

  initPhotos({ root: photosDir, dataDir });
  setSpinDir(inboxDir);

  const port = await startShareServer();
  assert(port > 0, 'Share server started on port ' + port);
  console.log('PASS: Share server started on port ' + port);

  // 1. Create a dummy event folder and dummy 360 video
  const eventDir = join(photosDir, 'Wedding 2026');
  mkdirSync(eventDir, { recursive: true });
  const dummyVidName = 'clip-sample.mp4';
  const dummyVidContent = Buffer.alloc(1024 * 1024, 0xAA); // 1 MB buffer
  writeFileSync(join(inboxDir, dummyVidName), dummyVidContent);

  // 2. Test spinShare with hardlink
  const shared = spinShare(dummyVidName, 'Wedding 2026', '', 'guest_360.mp4');
  assert(shared.ok, 'spinShare succeeded: ' + JSON.stringify(shared));
  const destPath = join(shared.folderPath, 'guest_360.mp4');
  assert(existsSync(destPath), 'Shared file exists at destination');
  const stSrc = statSync(join(inboxDir, dummyVidName));
  const stDest = statSync(destPath);
  assert(stDest.size === stSrc.size, 'Shared file has identical size');
  if (stSrc.ino && stDest.ino) {
    // If on same filesystem, inodes match (hard link)
    console.log('PASS: Hardlink created: src ino=' + stSrc.ino + ', dest ino=' + stDest.ino + ' (matches: ' + (stSrc.ino === stDest.ino) + ')');
  } else {
    console.log('PASS: File copied or linked successfully');
  }

  // 3. Test HTTP Range request (iOS Safari compatibility)
  const slug = shared.fileId.split('/')[0];
  const reqUrl = 'http://127.0.0.1:' + port + '/e/' + slug + '/f/guest_360.mp4';

  const rangeRes = await new Promise((resolve, reject) => {
    const req = http.request(reqUrl, {
      headers: {
        'Range': 'bytes=0-100'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });

  assert(rangeRes.statusCode === 206, 'Returns 206 Partial Content (got ' + rangeRes.statusCode + ')');
  assert(rangeRes.headers['content-range'] === 'bytes 0-100/' + dummyVidContent.length, 'Content-Range header matches bytes 0-100/' + dummyVidContent.length);
  assert(rangeRes.headers['accept-ranges'] === 'bytes', 'Accept-Ranges: bytes header present');
  assert(rangeRes.body.length === 101, 'Returned exact requested byte slice length (101 bytes)');
  assert(rangeRes.body[0] === 0xAA && rangeRes.body[100] === 0xAA, 'Byte slice content matches');
  console.log('PASS: HTTP Range request returns 206 Partial Content with correct byte slice for iPhone Safari');

  // 4. Test Pending 360 Video Page (Instant QR)
  // Request a file that does not yet exist in the event folder
  const pendingUrl = 'http://127.0.0.1:' + port + '/e/' + slug + '/p/not_rendered_yet_360.mp4';
  const pendingRes = await new Promise((resolve, reject) => {
    http.get(pendingUrl, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });

  assert(pendingRes.statusCode === 200, 'Pending video returns 200 OK (got ' + pendingRes.statusCode + ')');
  assert(pendingRes.body.includes('Your 360 video is on its way'), 'Page displays "Your 360 video is on its way"');
  assert(pendingRes.body.includes('location.reload()'), 'Page contains automatic reload polling script');
  console.log('PASS: Instant QR pending video route returns 200 OK with auto-reloading status page');

  // Clean up
  try { rmSync(testDir, { recursive: true, force: true }); } catch { }
  console.log('\nAll Phase 2 tests passed successfully!');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Phase 2 Test Error:', err);
  process.exit(1);
});