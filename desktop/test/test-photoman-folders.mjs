import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import {
  initPhotos,
  driveRequest,
  startShareServer,
  stopShareServer,
  setGuestPrint,
  printReqList,
  printReqRead,
  printNowTake,
  studioFolders,
  studioList,
  studioRead
} from '../lib/photos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const tempRoot = mkdtempSync(join(tmpdir(), 'pb4u-pm-folders-'));
const dataDir = mkdtempSync(join(tmpdir(), 'pb4u-pm-data-'));

const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function httpReq(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf.toString('utf8'), buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

console.log('--- Testing Separate Photoman Folders (End-to-End) ---');

try {
  initPhotos({ root: tempRoot, dataDir, makeThumb: null });
  const port = await startShareServer();
  assert(port > 0, 'Share server must start');
  setGuestPrint(true);

  // 1. Booth vs Photoman separation for the same event
  const ev = 'Gala Night 2026';
  const boothDir = join(tempRoot, ev);
  const pmDir = join(tempRoot, 'Photoman', ev);

  const bStrip = await driveRequest({ folderKey: ev, filename: '1_strip.jpg', buffer: JPG, guestCode: 'booth-guest-code-111111' });
  const bSolo1 = await driveRequest({ folderKey: ev, filename: '1_solo_1.jpg', buffer: JPG, guestCode: 'booth-guest-code-111111' });
  const bSoloPrint = await driveRequest({ folderKey: ev, filename: '2_solo.jpg', buffer: JPG, guestCode: 'booth-guest-code-222222' });
  const bMaster = await driveRequest({ folderKey: ev, filename: '1_strip_master.png', buffer: PNG, guestCode: 'booth-guest-code-111111' });

  assert(bStrip.ok && bSolo1.ok && bSoloPrint.ok && bMaster.ok);
  assert(existsSync(join(boothDir, 'Prints', '1_strip.jpg')), 'Booth strip -> <Event>/Prints/');
  assert(existsSync(join(boothDir, 'Prints', '2_solo.jpg')), 'Booth built-in Solo print -> <Event>/Prints/ (not Solo Shots)');
  assert(existsSync(join(boothDir, 'Solo Shots', '1_solo_1.jpg')), 'Booth solo shot -> <Event>/Solo Shots/');
  assert(existsSync(join(boothDir, 'Masters', '1_strip_master.png')), 'Booth master -> <Event>/Masters/');
  assert(!existsSync(pmDir), 'Photoman folder should not be created before any Photoman photo is saved');

  const slug = bStrip.folderUrl.replace('pb4u-local:', '');

  // Save Photoman photos using all accepted truthy flag styles (boolean, "1", source: "photoman")
  const pmSoloLayout = await driveRequest({ folderKey: ev, filename: '3_solo.jpg', buffer: JPG, guestCode: 'pm-guest-code-33333333', photoman: true });
  const pmSoloRaw = await driveRequest({ folderKey: ev, filename: '3_solo_1.jpg', buffer: JPG, guestCode: 'pm-guest-code-33333333', photoman: true });
  const pmCustom = await driveRequest({ folderKey: ev, filename: '4_pm_polaroid.jpg', buffer: JPG, guestCode: 'pm-guest-code-44444444', photoman: '1' });
  const pmCustomSolo = await driveRequest({ folderKey: ev, filename: '4_solo_1.jpg', buffer: JPG, guestCode: 'pm-guest-code-44444444', source: 'photoman' });
  const pmCut = await driveRequest({ folderKey: ev, filename: '4_cut_1_left.jpg', buffer: JPG, guestCode: 'pm-guest-code-44444444', photoman: true });
  const pmMaster = await driveRequest({ folderKey: ev, filename: '4_pm_polaroid_master.png', buffer: PNG, guestCode: 'pm-guest-code-44444444', photoman: true });

  assert(pmSoloLayout.ok && pmSoloRaw.ok && pmCustom.ok && pmCustomSolo.ok && pmCut.ok && pmMaster.ok);
  assert.equal(pmSoloLayout.folderUrl, bStrip.folderUrl, 'Photoman shares the same event slug');
  assert(existsSync(join(pmDir, 'Prints', '3_solo.jpg')), 'Photoman Solo layout print -> Photoman/<Event>/Prints/');
  assert(existsSync(join(pmDir, 'Solo Shots', '3_solo_1.jpg')), 'Photoman raw solo -> Photoman/<Event>/Solo Shots/');
  assert(existsSync(join(pmDir, 'Prints', '4_pm_polaroid.jpg')), 'Photoman custom template -> Photoman/<Event>/Prints/');
  assert(existsSync(join(pmDir, 'Prints', '4_cut_1_left.jpg')), 'Photoman section cut -> Photoman/<Event>/Prints/');
  assert(existsSync(join(pmDir, 'Solo Shots', '4_solo_1.jpg')), 'Photoman custom solo -> Photoman/<Event>/Solo Shots/');
  assert(existsSync(join(pmDir, 'Masters', '4_pm_polaroid_master.png')), 'Photoman master -> Photoman/<Event>/Masters/');

  // Ensure zero leakage between Booth and Photoman directories
  for (const name of ['3_solo.jpg', '4_pm_polaroid.jpg', '4_cut_1_left.jpg']) {
    assert(!existsSync(join(boothDir, 'Prints', name)), name + ' must not be in booth Prints/');
    assert(!existsSync(join(boothDir, 'Solo Shots', name)), name + ' must not be in booth Solo Shots/');
  }
  for (const name of ['3_solo_1.jpg', '4_solo_1.jpg']) {
    assert(!existsSync(join(boothDir, 'Solo Shots', name)), name + ' must not be in booth Solo Shots/');
  }
  assert(!existsSync(join(boothDir, 'Masters', '4_pm_polaroid_master.png')), 'Photoman master must not be in booth Masters/');
  assert(!existsSync(join(pmDir, 'Prints', '1_strip.jpg')), 'Booth strip must not be in Photoman Prints/');
  console.log('PASS: Booth and Photoman files are cleanly separated into Prints, Solo Shots, and Masters');

  // 2. Restart simulation: reload folders.json + guestcodes.json via initPhotos
  await new Promise((r) => setTimeout(r, 400)); // let debounced saveCodes flush
  initPhotos({ root: tempRoot, dataDir, makeThumb: null });

  const listJson = JSON.parse((await httpReq(port, 'GET', `/e/${slug}/list.json`)).body);
  assert(listJson.ok, 'list.json must work after restart');
  const namesAfterRestart = listJson.files.map((x) => x.n);
  for (const expected of ['1_strip.jpg', '1_solo_1.jpg', '2_solo.jpg', '3_solo.jpg', '3_solo_1.jpg', '4_pm_polaroid.jpg', '4_solo_1.jpg', '4_cut_1_left.jpg']) {
    assert(namesAfterRestart.includes(expected), 'Combined gallery after restart must include ' + expected);
  }
  assert(!namesAfterRestart.some((n) => /master/i.test(n)), 'Masters must never appear in list.json');

  const resolveAfter = await driveRequest({ folderKey: ev, resolveOnly: true });
  assert.equal(resolveAfter.nextSessionNumber, 5, 'nextSessionNumber after restart must count Photoman session 4 -> 5');

  const ownPm = await httpReq(port, 'GET', '/o/pm-guest-code-44444444');
  assert.equal(ownPm.status, 200);
  assert(ownPm.body.includes('4_pm_polaroid.jpg') && ownPm.body.includes('4_solo_1.jpg'), 'Guest personal page serves Photoman files after restart');
  assert(!ownPm.body.includes('master'), 'Guest personal page never leaks master');
  const ownPmFile = await httpReq(port, 'GET', '/o/pm-guest-code-44444444/f/4_pm_polaroid.jpg');
  assert.equal(ownPmFile.status, 200);
  assert.deepEqual(ownPmFile.buf, JPG, 'Guest personal file download returns exact Photoman JPEG bytes');
  console.log('PASS: Reload/restart restores photomanDirMap and serves all combined Booth + Photoman routes');

  // 3. Session grouping (/e/:slug/s/:prefix), Print Requests, and Operator Reprint for Photoman files
  const sess4 = await httpReq(port, 'GET', `/e/${slug}/s/4`);
  assert.equal(sess4.status, 200);
  assert(sess4.body.includes('4_pm_polaroid.jpg') && sess4.body.includes('4_solo_1.jpg'), 'Session page /s/4 includes Photoman custom print + solo');
  assert(sess4.body.indexOf('4_pm_polaroid.jpg') < sess4.body.indexOf('4_solo_1.jpg'), 'Session page shows Photoman print before solo shot');

  const prRes = await httpReq(port, 'POST', `/e/${slug}/print/4_pm_polaroid.jpg`);
  assert.equal(prRes.status, 200);
  const prJson = JSON.parse(prRes.body);
  assert.equal(prJson.ok, true, 'Guest print request on Photoman file succeeds');
  const reqs = printReqList();
  assert.equal(reqs.length, 1);
  assert.deepEqual(printReqRead(reqs[0].id), JPG, 'printReqRead returns exact bytes from Photoman/<Event>/Prints/');

  const pnRes = await httpReq(port, 'POST', `/e/${slug}/printnow/4_pm_polaroid.jpg`, JSON.stringify({ copies: 2 }));
  assert.equal(pnRes.status, 200);
  const pnJobs = printNowTake();
  assert.equal(pnJobs.length, 1);
  assert.deepEqual(pnJobs[0].bytes, JPG, 'printNowTake returns exact bytes from Photoman/<Event>/Prints/');

  // Masters blocked everywhere (file, print request, printnow)
  assert.equal((await httpReq(port, 'GET', `/e/${slug}/f/4_pm_polaroid_master.png`)).status, 404);
  assert.equal((await httpReq(port, 'POST', `/e/${slug}/print/4_pm_polaroid_master.png`)).status, 404);
  assert.equal((await httpReq(port, 'POST', `/e/${slug}/printnow/4_pm_polaroid_master.png`, '{}')).status, 404);
  console.log('PASS: Session page, guest print requests, operator reprint, and Master isolation verified for Photoman');

  // 4. Photoman-only event where the empty booth directory was removed manually
  const pmOnlyEv = 'Photoman Only Event';
  const pmOnlySave = await driveRequest({ folderKey: pmOnlyEv, filename: '1_pm_hero.jpg', buffer: JPG, guestCode: 'pm-only-guest-12345678', photoman: true });
  const pmOnlySlug = pmOnlySave.folderUrl.replace('pb4u-local:', '');
  await new Promise((r) => setTimeout(r, 400));
  rmSync(join(tempRoot, pmOnlyEv), { recursive: true, force: true }); // remove empty booth dir

  assert.equal((await httpReq(port, 'GET', `/e/${pmOnlySlug}/`)).status, 200, 'Gallery still serves Photoman-only event without booth dir');
  assert.equal((await httpReq(port, 'GET', `/e/${pmOnlySlug}/list.json`)).status, 200, 'list.json still serves Photoman-only event');
  assert.equal((await httpReq(port, 'GET', `/e/${pmOnlySlug}/f/1_pm_hero.jpg`)).status, 200, 'File download still serves Photoman-only event');
  assert.equal((await httpReq(port, 'GET', '/o/pm-only-guest-12345678')).status, 200, 'Guest personal page still works without booth dir');
  assert.equal((await httpReq(port, 'POST', `/e/${pmOnlySlug}/print/1_pm_hero.jpg`)).status, 200, 'Print request still works without booth dir');
  const stOnly = JSON.parse((await httpReq(port, 'GET', `/station/${pmOnlySlug}/list`)).body);
  assert.equal(stOnly.files.length, 1, 'Sharing Station still lists Photoman-only event');
  assert(studioFolders(pmOnlyEv).some((x) => x.slug === pmOnlySlug), 'studioFolders includes Photoman-only event');
  assert.equal(studioList(pmOnlySlug).length, 1);
  assert.deepEqual(studioRead(pmOnlySlug, '1_pm_hero.jpg'), JPG);
  console.log('PASS: Photoman-only event stays accessible even if empty booth folder is deleted');

  // 5. Edge case: event literally named "Photoman"
  const litBooth = await driveRequest({ folderKey: 'Photoman', filename: '1_strip.jpg', buffer: JPG });
  const litPm = await driveRequest({ folderKey: 'Photoman', filename: '2_pm_card.jpg', buffer: JPG, photoman: true });
  const litPmSolo = await driveRequest({ folderKey: 'Photoman', filename: '2_solo_1.jpg', buffer: JPG, photoman: true });
  const litSlug = litBooth.folderUrl.replace('pb4u-local:', '');
  assert(existsSync(join(tempRoot, 'Photoman', 'Prints', '1_strip.jpg')));
  assert(existsSync(join(tempRoot, 'Photoman', 'Photoman', 'Prints', '2_pm_card.jpg')));
  assert(existsSync(join(tempRoot, 'Photoman', 'Photoman', 'Solo Shots', '2_solo_1.jpg')));
  const litStation = JSON.parse((await httpReq(port, 'GET', `/station/${litSlug}/list`)).body);
  assert.equal(litStation.files.length, 3, 'Event literally named "Photoman" returns all 3 files without recursion/duplicates');
  console.log('PASS: Event literally named "Photoman" handled cleanly');

  // 6. Bonus subfolder session grouping
  const bPm = await driveRequest({ folderKey: ev, subfolder: 'Bonus', filename: 'BONUS_1_pm_floral.jpg', buffer: JPG, photoman: true });
  const bPmSolo = await driveRequest({ folderKey: ev, subfolder: 'Bonus', filename: 'BONUS_1_solo_1.jpg', buffer: JPG, photoman: true });
  const bonusSlug = bPm.folderUrl.replace('pb4u-local:', '');
  assert(bPm.ok && bPmSolo.ok);
  const bonusSt = JSON.parse((await httpReq(port, 'GET', `/station/${bonusSlug}/list`)).body);
  assert.equal(bonusSt.files.length, 2);
  assert.equal(bonusSt.files[0].sessionUrl, bonusSt.files[1].sessionUrl, 'BONUS_1_pm_floral.jpg and BONUS_1_solo_1.jpg share the same sessionUrl');
  const bonusSess = await httpReq(port, 'GET', `/e/${bonusSlug}/s/BONUS_1`);
  assert(bonusSess.body.includes('BONUS_1_pm_floral.jpg') && bonusSess.body.includes('BONUS_1_solo_1.jpg'), 'Bonus session page shows both print and solo shot');
  console.log('PASS: Bonus subfolder Photoman files group properly on session pages');

  // 7. Cross-platform bundle & contract integrity checks
  const builtBooth = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
  const androidBooth = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'booth.html'), 'utf8');
  const iosBooth = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'booth.html'), 'utf8');
  assert.equal(builtBooth, androidBooth, 'Android booth.html must stay in sync with protected/booth.html');
  assert.equal(builtBooth, iosBooth, 'iOS booth.html must stay in sync with protected/booth.html');

  assert(builtBooth.includes('function isPhotomanSave()'), 'booth.html defines isPhotomanSave');
  assert(builtBooth.includes("if (isPhotoman) q.set('photoman', '1');"), 'booth.html sends photoman=1 to /local/drive');
  assert(builtBooth.includes('if (LOCALSHARE && isPhotoman) payload.photoman = true;'), 'booth.html only adds photoman flag on local tablet saves, keeping Google Drive payload unchanged');
  assert(builtBooth.includes("if (isPhotoman) base = await base.getDirectoryHandle('Photoman', { create: true });"), 'Chrome backup folder nests Photoman under Photoman/<Event>');
  assert(builtBooth.includes('if (DESKTOP_ONLINE && (plainResult || isPhotoman))'), 'Desktop Online mode saves framed Photoman prints locally too');
  assert(!builtBooth.includes('/_solo\\./i'), 'fileCategory in booth.html must not misfile _solo.jpg prints into Solo Shots');

  const mainMjs = readFileSync(join(ROOT, 'desktop', 'main.mjs'), 'utf8');
  assert(mainMjs.includes("photoman: sp.get('photoman') === '1' || sp.get('photoman') === 'true'"), 'desktop/main.mjs forwards photoman query param');

  const pbKt = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'PBLocal.kt'), 'utf8');
  assert(pbKt.includes('fun photomanDirOf(f: Folder)') && pbKt.includes('Photoman/${f.name}'), 'Android PBLocal.kt separates Photoman folder + MediaStore path');
  assert(pbKt.includes('findFile(dir, file) == null'), 'Android print requests resolve subfolder & Photoman files via findFile');

  const pbSwift = readFileSync(join(ROOT, 'ios', 'photobooth4u', 'PBLocal.swift'), 'utf8');
  assert(pbSwift.includes('func photomanDirOf(folder: Folder)') && pbSwift.includes('private func photomanDirFor(dir: URL)'), 'iOS PBLocal.swift separates Photoman folder + combined gallery scan');

  const appsScript = readFileSync(join(ROOT, 'apps-script', 'upload.gs'), 'utf8');
  assert(!/photoman/i.test(appsScript), 'Google Drive Apps Script must remain unchanged');
  console.log('PASS: Cross-platform bundle sync and Desktop/Android/iOS/Drive contracts verified');

  console.log('\nALL PHOTOMAN FOLDER TESTS PASSED!');
} finally {
  stopShareServer();
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
