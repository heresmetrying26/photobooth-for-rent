// Builds the Rush ID & Photo Print station (source: rush-id/) into the main site, at /rush/.
//   - rush-id/public/{index.html, css, js, qrcode} -> ONE html page -> netlify/lib/rush.mjs
//     (served by netlify/functions/rush.mjs only to a valid code that has "Rush ID station" switched on, like the booth)
//   - rush-id/public/vendor (AI files, public like public/bg) -> public/rush/vendor
//   - rush-id/public/upload.html (what the phone opens) -> public/rush/upload.html, pointed at /api/rush/session
// If this fails, the last committed netlify/lib/rush.mjs is kept so a problem here never stops the booth site deploying.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'rush-id', 'public');
const OUT = join(ROOT, 'netlify', 'lib', 'rush.mjs');

try {
  const { buildSync } = await import('esbuild');
  const bundle = buildSync({ entryPoints: [join(SRC, 'js', 'app.js')], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false }).outputFiles[0].text;
  const css = readFileSync(join(SRC, 'css', 'app.css'), 'utf8');
  const qr = readFileSync(join(SRC, 'vendor', 'qrcode.min.js'), 'utf8');
  const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');      // never let inlined code close its own tag
  let html = readFileSync(join(SRC, 'index.html'), 'utf8');
  const swap = (a, b) => { if (!html.includes(a)) throw new Error('rush-id/public/index.html changed: cannot find ' + a); html = html.replace(a, () => b); };
  swap('<link rel="stylesheet" href="/css/app.css">', '<style>' + safe(css) + '</style>');
  swap('<script src="/vendor/qrcode.min.js"></script>', '<script>' + safe(qr) + '</script>');
  swap('<script type="module" src="/js/app.js"></script>', '<script>' + safe(bundle) + '</script>');
  writeFileSync(OUT, 'export default ' + JSON.stringify(html) + ';\n');
  console.log('Bundled rush-id (' + html.length + ' chars) -> netlify/lib/rush.mjs');

  const dest = join(ROOT, 'public', 'rush');
  mkdirSync(dest, { recursive: true });
  rmSync(join(dest, 'vendor'), { recursive: true, force: true });
  cpSync(join(SRC, 'vendor'), join(dest, 'vendor'), { recursive: true });
  const up = readFileSync(join(SRC, 'upload.html'), 'utf8');
  if (!up.includes('/api/session')) throw new Error('rush-id/public/upload.html changed: cannot find /api/session');
  writeFileSync(join(dest, 'upload.html'), up.split('/api/session').join('/api/rush/session'));
  console.log('Copied rush-id vendor files and phone upload page -> public/rush/');
} catch (e) {
  if (existsSync(OUT)) console.warn('WARNING: rush build failed, keeping the last netlify/lib/rush.mjs: ' + (e && e.message || e));
  else { console.error('rush build failed and there is no netlify/lib/rush.mjs: ' + (e && e.message || e)); process.exit(1); }
}
