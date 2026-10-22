// Gathers everything the app needs from the web app into desktop/build/:
//   booth.bin + meta.json   the booth page (protected/booth.html), scrambled
//   server/                 the web app's own setup / vouchers / prints code, storing on this laptop
//   public/                 background-AI files, the USB camera library, voucher tickets, fonts
//   camera-worker.ps1       the Windows camera part (same as the Print Helper's)
//   license-pubkey.txt      the PUBLIC key licences are checked with
// Run from desktop/:  node scripts/prepare.mjs
// The public key comes from (first found): env PB4U_LICENSE_PUB, env PB_LICENSE_KEY
// (derived), desktop/license-pubkey.txt, or https://photobooth4u.netlify.app/api/license?pub=1.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';

const DESK = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(DESK, '..');
const OUT = join(DESK, 'build');
const SERVER = (process.env.PB4U_SERVER || 'https://photobooth4u.netlify.app').replace(/\/+$/, '');
const KEY_A = 'pb4u·desk·7f3c1e9a';           // must match main.mjs
const log = (m) => console.log('[prepare] ' + m);
const must = (cond, msg) => { if (!cond) { console.error('[prepare] ' + msg); process.exit(1); } };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'server', 'lib'), { recursive: true });
mkdirSync(join(OUT, 'server', 'functions'), { recursive: true });
mkdirSync(join(OUT, 'public', 'fonts', 'files'), { recursive: true });

// ---------- fonts (so text looks right with no internet) ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
async function localFonts(cssUrl, outName) {
  try {
    const r = await fetch(cssUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let css = await r.text();
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
    for (const u of urls) {
      const name = createHash('sha1').update(u).digest('hex').slice(0, 16) + '.woff2';
      const f = join(OUT, 'public', 'fonts', 'files', name);
      if (!existsSync(f)) {
        const fr = await fetch(u, { headers: { 'user-agent': UA } });
        if (!fr.ok) throw new Error('font HTTP ' + fr.status);
        writeFileSync(f, Buffer.from(await fr.arrayBuffer()));
      }
      css = css.split(u).join('/fonts/files/' + name);
    }
    writeFileSync(join(OUT, 'public', 'fonts', outName), css);
    return urls.length;
  } catch (e) {
    log('fonts: could not download (' + e.message + '); the app will use Google Fonts when online.');
    writeFileSync(join(OUT, 'public', 'fonts', outName), '@import url("' + cssUrl + '");\n');
    return 0;
  }
}

// ---------- the booth page ----------
// GitHub's Windows computers check files out with Windows line endings (\r\n); use plain \n everywhere.
const readText = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
let booth = readText(join(ROOT, 'protected', 'booth.html'))
  .replace(/<script type="text\/plain" data-removed-feature="gifenc">[\s\S]*?<\/script>/, '');
const headLink = /<link href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)" rel="stylesheet">/.exec(booth);
must(headLink, 'booth.html: Google Fonts <link> not found');
const guestLink = /<link href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)" rel="stylesheet">' \+/.exec(booth);
const nHead = await localFonts(headLink[1].replace(/&amp;/g, '&'), 'fonts.css');
const nGuest = guestLink ? await localFonts(guestLink[1].replace(/&amp;/g, '&'), 'guest.css') : 0;
if (nHead) {
  booth = booth.replace(headLink[0], '<link href="/fonts/fonts.css" rel="stylesheet">')
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"( crossorigin)?>\n?/g, '');
  log('fonts: ' + nHead + ' files');
}
if (nGuest && guestLink) booth = booth.replace(guestLink[1], 'app://booth/fonts/guest.css');

const k = randomBytes(24).toString('base64url');
const key = createHash('sha256').update(KEY_A + '|' + k).digest();
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([c.update(Buffer.from(booth, 'utf8')), c.final()]);
writeFileSync(join(OUT, 'booth.bin'), Buffer.concat([iv, c.getAuthTag(), enc]));
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ k, built: new Date().toISOString(), chars: booth.length }));
log('booth page: ' + booth.length + ' chars');

// ---------- the web app's server code, storing on this laptop ----------
const BLOBS = /from '@netlify\/blobs';/;
function copyServer(rel, outRel, edits) {
  let s = readText(join(ROOT, 'netlify', rel));
  for (const [a, b] of edits) {
    const before = s;
    s = typeof a === 'string' ? s.split(a).join(b) : s.replace(a, b);
    must(s !== before, rel + ': expected text not found (' + String(a).slice(0, 60) + ')');
  }
  writeFileSync(join(OUT, 'server', outRel), s);
}
copyServer('lib/core.mjs', 'lib/core.mjs', [[BLOBS, "from '../../../lib/store.mjs';"]]);
copyServer('lib/pay.mjs', 'lib/pay.mjs', [[BLOBS, "from '../../../lib/store.mjs';"]]);
copyServer('functions/app.mjs', 'functions/app.mjs', [
  ["import booth from '../lib/booth.mjs';\n", ''],
  ['let html = booth;', "let html = globalThis.__pb4uBooth || '';"]
]);
for (const f of ['verify', 'setup', 'pay', 'prints']) copyServer('functions/' + f + '.mjs', 'functions/' + f + '.mjs', []);

// ---------- files the booth loads ----------
const pub = (p) => join(ROOT, 'public', p);
for (const p of ['bg', 'camera-test/build', 'pay']) {
  if (existsSync(pub(p))) cpSync(pub(p), join(OUT, 'public', p), { recursive: true });
  else log('warning: public/' + p + ' is missing (' + (p === 'camera-test/build' ? 'USB camera on Mac won’t work' : 'part of the booth won’t work') + ')');
}
// Voucher tickets page: same local fonts as the booth.
const tickets = join(OUT, 'public', 'pay', 'tickets.html');
if (nHead && existsSync(tickets)) {
  writeFileSync(tickets, readText(tickets)
    .replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/, '<link href="/fonts/fonts.css" rel="stylesheet">')
    .replace(/<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"( crossorigin)?>\n?/g, ''));
}
cpSync(join(ROOT, 'tools', 'print-helper', 'camera-worker.ps1'), join(OUT, 'camera-worker.ps1'));

// ---------- the licence public key ----------
async function publicKey() {
  if (process.env.PB4U_LICENSE_PUB) return process.env.PB4U_LICENSE_PUB.trim();
  if (process.env.PB_LICENSE_KEY) {
    const priv = createPrivateKey({ key: Buffer.from(process.env.PB_LICENSE_KEY.trim(), 'base64'), format: 'der', type: 'pkcs8' });
    return createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
  }
  const saved = join(DESK, 'license-pubkey.txt');
  if (existsSync(saved)) { const t = readFileSync(saved, 'utf8').trim(); if (t) return t; }
  try {
    const r = await fetch(SERVER + '/api/license?pub=1');
    const j = await r.json();
    if (j && j.spki) { writeFileSync(saved, j.spki + '\n'); return j.spki; }
  } catch { /* below */ }
  return '';
}
const spki = await publicKey();
if (!spki) {
  must(process.argv.includes('--no-key'), 'No licence public key. Set PB_LICENSE_KEY in Netlify and deploy first (so ' + SERVER + '/api/license?pub=1 works), or put the key in desktop/license-pubkey.txt.');
  log('warning: building WITHOUT a licence key (--no-key): the app will refuse to activate.');
} else {
  const raw = Buffer.from(spki, 'base64');
  must(raw.length === 44, 'license-pubkey.txt does not look like an Ed25519 public key');
  writeFileSync(join(OUT, 'license-pubkey.txt'), spki + '\n');
  log('licence key: ' + raw.subarray(12).toString('hex').slice(0, 16) + '…');
}
log('done -> ' + OUT);
