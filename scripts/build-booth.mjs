// Turns protected/booth.html into a JS module that the server function serves
// only to people holding a valid license. The app itself is never in /public,
// so nobody can read it without unlocking.
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../protected/booth.html', import.meta.url);
const out = new URL('../netlify/lib/booth.mjs', import.meta.url);
const html = readFileSync(src, 'utf8');
writeFileSync(out, 'export default ' + JSON.stringify(html) + ';\n');
console.log('Bundled protected/booth.html (' + html.length + ' chars) -> netlify/lib/booth.mjs');
