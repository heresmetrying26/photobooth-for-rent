// Guards against the 1.1.73 laptop bug: "Tap to start" could not be clicked.
//
// The tablet bridge part (protected/src/bridge/tablet-bridge.js) is pasted into the middle of the booth script, but code
// ABOVE it (guestRender -> guestOpen -> tabletGuestOpen) runs during start-up on the laptop app, where DESKTOP is true.
// A top-level `const` / `let` / `class` in that part is not set yet at that moment, so reading it throws
// "Cannot access 'tabletBridge' before initialization". That error stops the whole booth script before it attaches the
// click handler on the start screen. `var` is hoisted (it reads as undefined), so the readers must use `var` and guard.
//
//   node scripts/test-booth-startup.mjs      exit 1 on a problem
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_DIR = join(ROOT, 'protected', 'src', 'bridge');
let bad = 0;
const fail = (m) => { bad++; console.error('FAIL: ' + m); };

for (const f of readdirSync(BRIDGE_DIR).filter((n) => n.endsWith('.js'))) {
  const text = readFileSync(join(BRIDGE_DIR, f), 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    // Only declarations at column 0 are top-level in these parts (everything nested is indented).
    if (/^(const|let|class)\s/.test(line)) fail('bridge/' + f + ':' + (i + 1) + ' top-level ' + line.split(/\s/)[0] + ' (use var): ' + line.slice(0, 80));
  });
}

const tb = readFileSync(join(BRIDGE_DIR, 'tablet-bridge.js'), 'utf8');
// The two functions the start-up code reaches must not throw while tabletBridge is still undefined.
for (const fn of ['tabletGuestOpen', 'tabletCamAvailable']) {
  const m = new RegExp('function ' + fn + '\\(\\)[^\\n]*').exec(tb);
  if (!m) fail(fn + ' not found in tablet-bridge.js');
  else if (!/tabletBridge\s*&&/.test(m[0])) fail(fn + ' must check `tabletBridge &&` before reading it: ' + m[0]);
}

// The built page must carry the same thing (it is what the laptop app, Android and iPad load).
const built = readFileSync(join(ROOT, 'protected', 'booth.html'), 'utf8');
if (!/\nvar tabletBridge = \{/.test(built)) fail('protected/booth.html has no `var tabletBridge` (run npm run build)');
if (/\n(const|let) tabletBridge\b/.test(built)) fail('protected/booth.html still declares tabletBridge with const/let (run npm run build)');

if (bad) { console.error(bad + ' problem(s).'); process.exit(1); }
console.log('OK: bridge parts use var and guard early reads.');
