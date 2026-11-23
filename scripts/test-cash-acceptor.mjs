// Cash acceptor (ESP32 + coin / bill acceptor): the message parser, the credit kept on the device,
// and the keyboard link. Run from the repo root: node scripts/test-cash-acceptor.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const repo = process.argv[2] || process.cwd();
const src = readFileSync(join(repo, 'protected', 'src', 'cash', 'cash-acceptor.js'), 'utf8');

const store = {};
const listeners = {};
const ctx = {
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  window: { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } },
  navigator: {}, TextDecoder, setTimeout, Date, Math, parseInt, Number, String
};
vm.createContext(ctx);
// var / function declarations become properties of the context, exactly as in the booth page.
vm.runInContext(src, ctx);
const run = (code) => vm.runInContext(code, ctx);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL: ' + m); } else console.log('ok   ' + m); };

// 1. parser
const got = [];
ctx.got = got; run('var P = cashParserNew(function (n) { got.push(n); });');
run('P.feed("c5\\n")'); ok(got.join() === '5', 'a P5 coin: "c5" + newline');
run('P.feed("c100\\r\\nc20;")'); ok(got.join() === '5,100,20', 'bills, with CRLF and ";" endings');
run('P.feed("c1"); P.feed("0\\n")'); ok(got[got.length - 1] === 10, 'a message split across two packets still counts once');
const n0 = got.length;
run('P.feed("hello\\nc\\nc0\\nc99999\\nc12x\\n")'); ok(got.length === n0, 'noise, empty, zero, too-long and broken messages credit nothing');
run('P.feed("c7c50\\n")'); ok(got[got.length - 1] === 50 && got.length === n0 + 1, 'a new message over a broken one starts clean');
run('P.feed("c6000\\n")'); ok(got.length === n0 + 1, 'a value above the limit is dropped');
run('P.feed("C25\\n")'); ok(got[got.length - 1] === 25, 'upper-case C also works');

// 2. credit kept on the device, and the sales count
run('cashSetBalance(0); cashStatsReset();');
const heard = [];
ctx.heard = heard; run('cashHooks.credit = function (n) { heard.push(n); };');
run('cashCredit(20); cashCredit(10); cashCredit(5);');
ok(run('cashBalance()') === 35 && heard.join() === '20,10,5', 'coins add up and the booth hears each one');
ok(run('cashSpend(50)') === false && run('cashBalance()') === 35, 'not enough credit: nothing is taken');
ok(run('cashSpend(30)') === true && run('cashBalance()') === 5, 'a session takes its price and keeps the rest');
const st = run('cashStats()');
ok(st.inTotal === 35 && st.sold === 30 && st.sessions === 1, 'the operator count: in 35, sold 30, 1 session');
ok(run('cashCredit(0)') === 0 && run('cashCredit(-5)') === 0 && run('cashCredit(99999)') === 0 && run('cashBalance()') === 5, 'zero, negative and huge credits are ignored');
store.pb_cash_bal = 'abc'; ok(run('cashBalance()') === 0, 'a damaged saved balance reads as 0');

// 3. keyboard link
run('cashSetBalance(0)');
await run('cashStart(false)');
ok(run('cashLink.state') === 'ready' && run('cashLink.mode') === 'keyboard', 'keyboard link starts without any permission');
const handler = listeners.keydown[0];
let stopped = 0;
const key = (k, extra = {}) => { let prevented = false; handler(Object.assign({ key: k, target: { tagName: 'BODY' }, preventDefault() { prevented = true; }, stopPropagation() { stopped++; }, stopImmediatePropagation() { } }, extra)); return prevented; };
key('c'); key('2'); const last = key('0'); const enter = key('Enter');
ok(run('cashBalance()') === 20, 'typed c, 2, 0, Enter credits P20');
ok(last === true && enter === true, 'the digits and the Enter are swallowed (Enter can’t also start a session)');
ok(key('x') === false && key('Enter') === false, 'ordinary keys are left alone');
key('c', { target: { tagName: 'INPUT' } }); key('9', { target: { tagName: 'INPUT' } }); key('Enter', { target: { tagName: 'INPUT' } });
ok(run('cashBalance()') === 20, 'typing in a Setup field never credits');
key('c', { ctrlKey: true }); key('9'); key('Enter');
ok(run('cashBalance()') === 20, 'a Ctrl shortcut is not part of a message');
run('cashSetChosenLink("ble")'); await run('cashStart(false)');
ok(run('cashLink.state') === 'unsupported', 'Bluetooth LE in a browser without it says so, instead of failing silently');
key('c'); key('5'); key('Enter');
ok(run('cashBalance()') === 20, 'with another link chosen the keyboard is ignored');

if (fails) { console.error(fails + ' check(s) failed'); process.exit(1); }
console.log('OK: cash acceptor');
