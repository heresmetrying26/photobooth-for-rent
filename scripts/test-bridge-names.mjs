// Every name the tablet bridge code reads must be declared by the booth page (or be a JS / browser global).
// Why: protected/src/bridge/tablet-bridge.js is pasted into the booth script and calls booth functions by name. A name the booth does
// not have (it called layoutBoxAspect, which never existed) throws ReferenceError at run time. The tablet's screen update runs inside a
// promise whose errors were swallowed, so from Desktop 1.1.73 to 1.1.79 the tablet never got any screen state (no photo after each
// shot, no QR code, no sizes) and nothing said why. This check reads the code, so it needs no tablet and no booth.
//   node scripts/test-bridge-names.mjs      exit 1 if the bridge uses a name the booth page does not declare
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = process.env.PB_BRIDGE_SRC || join(ROOT, 'protected', 'src', 'bridge', 'tablet-bridge.js');
const BOOTH = process.env.PB_BOOTH || join(ROOT, 'protected', 'booth.html');
const src = readFileSync(BRIDGE, 'utf8');
const booth = readFileSync(BOOTH, 'utf8');

// 1. the code with strings, template text, comments and regex literals blanked out
function codeOnly(t) {
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i], d = t[i + 1];
    if (c === '/' && d === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; i++;
      while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    if (c === '/' && /[=(,:;!&|?{}[\n]\s*$/.test(out.slice(-3) + ' ') ) {   // a regex literal
      i++; while (i < t.length && t[i] !== '/' && t[i] !== '\n') { if (t[i] === '\\') i++; i++; }
      i++; while (/[a-z]/.test(t[i] || '')) i++; out += '0'; continue;
    }
    out += c; i++;
  }
  return out;
}
const code = codeOnly(src);

// 2. names the bridge declares itself (functions, variables, parameters, catch variables, destructuring)
const own = new Set();
for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
  if (m[1]) own.add(m[1]);
  m[2].split(',').forEach((p) => { const n = p.replace(/=.*$/, '').replace(/[.\s]/g, ''); if (n) own.add(n); });
}
for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
for (const m of code.matchAll(/\b(?:var|let|const)\s*[{[]([^}\]]*)[}\]]/g)) m[1].split(',').forEach((x) => own.add(x.split(':').pop().replace(/=.*$/, '').trim()));
for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) m[1].split(',').forEach((p) => { const n = p.replace(/=.*$/, '').replace(/[.\s]/g, ''); if (n) own.add(n); });
for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) own.add(m[1]);
for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);

// 3. names the booth page declares
const declared = new Set();
for (const m of booth.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
for (const m of booth.matchAll(/\b(?:var|let|const|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of booth.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) declared.add(m[1]);
for (const m of booth.matchAll(/\b(?:var|let|const)\s*\{([^}]*)\}/g)) m[1].split(',').forEach((x) => declared.add(x.split(':').pop().replace(/=.*$/, '').trim()));

// 4. JS and browser globals
const GLOBALS = new Set(('Object Array Math Number String JSON Date Promise Error Event Image Set Map RegExp parseFloat parseInt isNaN isFinite ' +
  'encodeURIComponent decodeURIComponent window document console setTimeout setInterval clearInterval clearTimeout fetch createImageBitmap ' +
  'AbortSignal Blob URL FormData Infinity NaN undefined null true false this arguments Symbol Boolean navigator location localStorage requestAnimationFrame ' +
  'if for while switch catch function return typeof new await async else do try finally throw break continue in of var let const delete void instanceof case default ' +
  'getComputedStyle HTMLElement Node').split(/\s+/));

// 5. every name the code reads: not after a dot, and not an object key (`name:` right after `{` or `,`)
const used = new Map();
const lineOf = (idx) => code.slice(0, idx).split('\n').length;
for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
  const name = m[1];
  if (own.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
  const after = code.slice(m.index + name.length).match(/^\s*(:)(?!:)/);
  const before = code.slice(0, m.index).replace(/\s+$/, '').slice(-1);
  if (after && (before === '{' || before === ',' || before === '')) continue;   // an object key, not a read
  if (!used.has(name)) used.set(name, lineOf(m.index));
}
const bad = [...used.entries()].filter(([name]) => !/^\d/.test(name));
if (bad.length) {
  for (const [name, line] of bad) console.error('FAIL: tablet-bridge.js:' + line + ' uses `' + name + '`, which the booth page does not declare');
  console.error(bad.length + ' undeclared name(s). Each one throws ReferenceError when that line runs, and the tablet screen update fails silently.');
  process.exit(1);
}
console.log('OK: every name tablet-bridge.js reads is declared by the booth page (' + own.size + ' own, ' + declared.size + ' booth names).');
