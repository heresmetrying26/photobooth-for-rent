// Tests the booth's Canon guide (protected/src/camera/brand-canon.js): what the operator is told when a Canon's photo comes after
// the flash, when its "press without focusing" was turned off, when photos go via the SD card, and when a photo is not taken.
// The two pure functions are cut out of the part file between the "canon-guide:start" and "canon-guide:end" markers and run on their own.
//   node scripts/test-canon-guide.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'protected/src/camera/brand-canon.js'), 'utf8');
const m = /\/\/ canon-guide:start\r?\n([\s\S]*?)\/\/ canon-guide:end/.exec(src);
if (!m) { console.log('FAIL: could not find the canon-guide block in brand-canon.js'); process.exit(1); }
const { canonGuideFrom, canonGuideFail } = new Function(m[1] + '\nreturn { canonGuideFrom, canonGuideFail };')();

let fails = 0;
function check(name, ok, got) {
  if (ok) console.log('ok   ' + name);
  else { console.log('FAIL ' + name + '\n     got: ' + JSON.stringify(got)); fails++; }
}
const ids = (st) => canonGuideFrom(st).map(i => i.id).join(',');

check('no status: nothing to say', canonGuideFrom(null).length === 0 && canonGuideFrom(undefined).length === 0, canonGuideFrom(null));
check('a Canon that is on time (0.4 s) says nothing', ids({ fireOnce: true, lagMs: 400, focusInShot: false, noAfOff: false, toCard: false }) === '', ids({ fireOnce: true, lagMs: 400, focusInShot: false }));
check('focusing inside the shot but quick (0.7 s): nothing yet', ids({ fireOnce: true, lagMs: 700, focusInShot: true }) === '', ids({ fireOnce: true, lagMs: 700, focusInShot: true }));
check('focusing inside the shot at 0.8 s: "late" tip', ids({ fireOnce: true, lagMs: 800, focusInShot: true }) === 'late', ids({ fireOnce: true, lagMs: 800, focusInShot: true }));
const late = canonGuideFrom({ fireOnce: true, lagMs: 1240, focusInShot: true })[0];
check('the late tip names the delay and the MF switch', late && /about 1\.2 s after the flash/.test(late.text) && /AF to MF/.test(late.text), late && late.text);
check('a late photo that was focused beforehand (the delay is something else): nothing', ids({ fireOnce: true, lagMs: 2500, focusInShot: false }) === '', ids({ fireOnce: true, lagMs: 2500, focusInShot: false }));
check('not in "fire once" mode (the early fire covers the delay): nothing', ids({ fireOnce: false, lagMs: 1500, focusInShot: true }) === '', ids({ fireOnce: false, lagMs: 1500, focusInShot: true }));
check('press without focusing turned off: "noaf" tip, whatever the delay', ids({ fireOnce: true, lagMs: 300, focusInShot: true, noAfOff: true }) === 'noaf', ids({ fireOnce: true, lagMs: 300, focusInShot: true, noAfOff: true }));
check('"noaf" replaces "late" (same fix, said once)', ids({ fireOnce: true, lagMs: 1500, focusInShot: true, noAfOff: true }) === 'noaf', ids({ fireOnce: true, lagMs: 1500, focusInShot: true, noAfOff: true }));
check('photos via the card: "card" tip', ids({ fireOnce: true, lagMs: 300, toCard: true }) === 'card', ids({ fireOnce: true, lagMs: 300, toCard: true }));
check('card + late: both, late first', ids({ fireOnce: true, lagMs: 1500, focusInShot: true, toCard: true }) === 'late,card', ids({ fireOnce: true, lagMs: 1500, focusInShot: true, toCard: true }));
const card = canonGuideFrom({ toCard: true })[0];
check('the card tip says JPEG only and a fast card', card && /UHS-I/.test(card.text) && /JPEG only/.test(card.text), card && card.text);

check('a missed photo (FOCUS): checklist', canonGuideFail('FOCUS') && canonGuideFail('FOCUS').id === 'fail', canonGuideFail('FOCUS'));
check('a missed photo (CAPTURE): checklist, any case', canonGuideFail('capture') && canonGuideFail('capture').id === 'fail', canonGuideFail('capture'));
const fail = canonGuideFail('FOCUS');
check('the checklist covers lens switch, mode dial, card lock, menu', fail && /MF/.test(fail.text) && /mode dial/.test(fail.text) && /lock switch/.test(fail.text) && /menu is closed/.test(fail.text), fail && fail.text);
check('other errors (no camera, live view...) get no Canon checklist', canonGuideFail('NOCAMERA') === null && canonGuideFail('LIVEVIEW') === null && canonGuideFail('') === null && canonGuideFail(undefined) === null, [canonGuideFail('NOCAMERA'), canonGuideFail('')]);

if (fails === 0) { console.log('PASS'); process.exit(0); }
console.log('FAIL (' + fails + ')');
process.exit(1);
