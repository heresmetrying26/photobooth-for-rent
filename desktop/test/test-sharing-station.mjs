import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

console.log('--- Testing Sharing Station System (Desktop, Android & Online) ---');

// 1. Verify Desktop photos.mjs
const photosCode = readFileSync(join(ROOT, 'desktop', 'lib', 'photos.mjs'), 'utf8');
assert(photosCode.includes('function stationHtml('), 'stationHtml function exists in photos.mjs');
assert(photosCode.includes('playChime()'), 'Web Audio chime exists in photos.mjs');
assert(photosCode.includes('openModal(newest)'), 'Auto-pop logic exists in photos.mjs');
assert(photosCode.includes('privacyOnly'), 'Privacy mode support exists in photos.mjs');
console.log('PASS: Desktop lib/photos.mjs contains auto-pop, audio chime, and privacy mode');

// 2. Verify Android LocalShareServer & Assets
const androidServer = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'LocalShareServer.kt'), 'utf8');
assert(androidServer.includes('/qr.js'), 'LocalShareServer.kt handles /qr.js');
assert(androidServer.includes('share/station.html'), 'LocalShareServer.kt loads share/station.html');
assert(existsSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'share', 'station.html')), 'Android asset share/station.html exists');
assert(existsSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'share', 'qr.js')), 'Android asset share/qr.js exists');

const androidStationHtml = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'share', 'station.html'), 'utf8');
assert(androidStationHtml.includes('playChime()'), 'Android station.html has playChime');
assert(androidStationHtml.includes('openModal(newest)'), 'Android station.html has auto-pop');
assert(androidStationHtml.includes('privacyOnly'), 'Android station.html has privacy mode');
console.log('PASS: Android LocalShareServer & assets support auto-pop, audio chime, and privacy mode');

// 3. Verify Online Sharing Station (public/station/index.html & netlify.toml)
assert(existsSync(join(ROOT, 'public', 'station', 'index.html')), 'public/station/index.html exists');
assert(existsSync(join(ROOT, 'public', 'qr.js')), 'public/qr.js exists');
const publicStationHtml = readFileSync(join(ROOT, 'public', 'station', 'index.html'), 'utf8');
assert(publicStationHtml.includes('/api/gallery?f='), 'Online station connects to /api/gallery');
assert(publicStationHtml.includes('playChime()'), 'Online station has playChime');
assert(publicStationHtml.includes('openModal(newest)'), 'Online station has auto-pop');
assert(publicStationHtml.includes('privacyOnly'), 'Online station has privacy mode');

const netlifyToml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
assert(netlifyToml.includes('from = "/station/*"'), 'netlify.toml redirects /station/* to /station/index.html');
console.log('PASS: Online Sharing Station page and Netlify routing verified');

// 4. Verify Booth Engine (protected/booth.html)
const boothHtml = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
assert(boothHtml.includes('id="shareStationToggle"'), 'shareStationToggle exists in booth.html');
assert(boothHtml.includes('id="shareStationHandoffSelect"'), 'shareStationHandoffSelect exists in booth.html');
assert(boothHtml.includes('id="shareStationPrivacySelect"'), 'shareStationPrivacySelect exists in booth.html');
assert(boothHtml.includes('id="shareStationPairBtn"'), 'shareStationPairBtn exists in booth.html');
assert(boothHtml.includes('id="shareStationHandoffOverlay"'), 'shareStationHandoffOverlay exists in booth.html');
assert(boothHtml.includes('id="shareStationModal"'), 'shareStationModal exists in booth.html');
assert(boothHtml.includes('triggerShareStationHandoff()'), 'triggerShareStationHandoff exists in booth.html');
assert(boothHtml.includes('shareStation: shareStationOn'), 'snapshotSetup includes shareStation');
console.log('PASS: Booth engine (booth.html) UI controls, modal, and handoff logic verified');

console.log('All Sharing Station tests passed successfully!');

