// Builds protected/booth.html from protected/src/booth.src.html plus the part files it includes.
//
//   protected/src/booth.src.html      the page, with lines like   /*@include camera/nikon.js*/
//   protected/src/camera/*.js         code that belongs to one camera brand (or one topic), pasted in place of the line
//   protected/booth.html              GENERATED: this is what Netlify, the desktop app, Android, iOS and the tests read
//
// Edit the source files, then run `npm run build`. Nothing else reads the part files, and the include is a plain paste
// into the same <script>, so every part shares the page's variables exactly as before.
//
//   node scripts/assemble-booth.mjs           write protected/booth.html
//   node scripts/assemble-booth.mjs --check   exit 1 if protected/booth.html is not what the sources produce
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'protected', 'src');
const SRC = join(SRC_DIR, 'booth.src.html');
const OUT = join(ROOT, 'protected', 'booth.html');
const INCLUDE = /^[ \t]*\/\*@include ([A-Za-z0-9_\-./]+)\*\/[ \t]*\r?\n/gm;

export function assemble() {
  if (!existsSync(SRC)) return null;
  const used = new Set();
  const expand = (text, from, depth) => {
    if (depth > 4) throw new Error('@include nested too deep in ' + from);
    return text.replace(INCLUDE, (_, rel) => {
      if (rel.includes('..')) throw new Error('@include may not leave protected/src: ' + rel);
      const p = join(SRC_DIR, rel);
      if (!existsSync(p)) throw new Error('@include ' + rel + ' (from ' + from + ') does not exist');
      used.add(rel);
      let part = readFileSync(p, 'utf8');
      if (!part.endsWith('\n')) part += '\n';
      return expand(part, rel, depth + 1);
    });
  };
  const html = expand(readFileSync(SRC, 'utf8'), 'booth.src.html', 0);
  return { html, used: [...used] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = assemble();
  if (!built) { console.log('No protected/src/booth.src.html: protected/booth.html is edited directly.'); process.exit(0); }
  if (process.argv.includes('--check')) {
    const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (now !== built.html) {
      console.error('protected/booth.html is out of date with protected/src. Run: npm run build');
      console.error('(If you edited protected/booth.html by hand, copy that change into protected/src first, or it is lost.)');
      process.exit(1);
    }
    console.log('OK: protected/booth.html matches protected/src (' + built.used.length + ' part files).');
  } else {
    writeFileSync(OUT, built.html);
    console.log('Assembled protected/booth.html from protected/src (' + built.used.length + ' part files, ' + built.html.length + ' chars).');
  }
}
