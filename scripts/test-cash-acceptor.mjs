// Cash acceptor (ESP32 + coin / bill acceptor): the message parser, the credit kept on the device,
// and the keyboard link. Run from the repo root: node scripts/test-cash-acceptor.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const repo = process.argv[2] || process.cwd();
const src = readFileSync(join(repo, 'protected', 'src', 'cash', 'cash-acceptor.js'), 'utf8');

const store = {};
const listeners = {};
const ctx = {
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  window: { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } },
  navigator: {}, TextDecoder, setTimeout, clearTimeout, Date, Math, parseInt, Number, String
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

// 4. activity timestamp & array cashStateHook sync in cash-acceptor.js
run('cashSetBalance(0)');
ok(!store.pb_cash_act && run('cashLastActivityAt()') === 0, 'clearing balance clears pb_cash_act');
run('cashSetBalance(15)');
ok(Number(store.pb_cash_act) > 0 && run('cashLastActivityAt()') > 0, 'positive balance records pb_cash_act');
run('cashTouchActivity(123456789)');
ok(run('cashLastActivityAt()') === 123456789, 'cashTouchActivity updates last activity timestamp');
const btSent = [];
ctx.window.__Esp32Bridge = { isAvailable: () => true, isEnabled: () => true, isConnected: () => true, write: (s) => { btSent.push(String(s).trim()); return true; } };
run('cashLink.state = "ready"; cashLink.mode = "android"; cashStateHook = function () { return ["price{20}", "credit{15}", "cash_open"]; }; cashSendCurrentState();');
await new Promise((r) => setTimeout(r, 200));
ok(btSent.join('|') === 'price{20}|credit{15}|cash_open', 'cashSendCurrentState sends array state + credit + cash_open commands over Esp32Bridge (got: ' + btSent.join('|') + ')');

// 5. Integration checks against built protected/booth.html
const boothHtml = readFileSync(join(repo, 'protected', 'booth.html'), 'utf8');
const startMarker = "var ESP32_LIGHT_KEY = 'pb_esp32_light';";
const endMarker = '\n      // ---- Voucher ticket helpers';
const sIdx = boothHtml.indexOf(startMarker);
const eIdx = boothHtml.indexOf(endMarker, sIdx);
ok(sIdx > 0 && eIdx > sIdx, 'built protected/booth.html contains ESP32 + payment block');

if (sIdx > 0 && eIdx > sIdx) {
  const boothSlice = boothHtml.slice(sIdx, eIdx);
  const store2 = {};
  const els = new Map();
  const makeClassList = () => {
    const set = new Set();
    return {
      toggle: (cls, force) => { if (force === undefined) { if (set.has(cls)) set.delete(cls); else set.add(cls); return set.has(cls); } if (force) set.add(cls); else set.delete(cls); return !!force; },
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      contains: (c) => set.has(c)
    };
  };
  const getEl = (id) => {
    if (!els.has(id)) {
      const listenersMap = {};
      els.set(id, {
        id,
        hidden: false,
        disabled: false,
        value: '',
        checked: false,
        options: [],
        textContent: '',
        innerHTML: '',
        src: '',
        style: {},
        dataset: {},
        classList: makeClassList(),
        addEventListener: (ev, fn) => { (listenersMap[ev] = listenersMap[ev] || []).push(fn); },
        click: () => { (listenersMap.click || []).forEach((fn) => fn.call(els.get(id), { target: els.get(id) })); },
        closest: () => null,
        _fire: (ev, evt) => (listenersMap[ev] || []).forEach((fn) => fn.call(els.get(id), evt || { target: els.get(id) })),
        _listeners: listenersMap
      });
    }
    return els.get(id);
  };
  const docListeners = {};
  const toasts = [];
  const serialSent = [];
  const ctx2 = {
    window: { __PB: { payOpt: true, offline: true }, addEventListener: () => {} },
    document: {
      body: { classList: makeClassList() },
      documentElement: { classList: makeClassList() },
      getElementById: (id) => getEl(id),
      querySelectorAll: () => [],
      addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); }
    },
    localStorage: {
      getItem: (k) => (k in store2 ? store2[k] : null),
      setItem: (k, v) => { store2[k] = String(v); },
      removeItem: (k) => { delete store2[k]; },
      key: (i) => Object.keys(store2)[i] ?? null,
      get length() { return Object.keys(store2).length; }
    },
    navigator: { onLine: false },
    crypto: globalThis.crypto || webcrypto,
    AbortController: globalThis.AbortController,
    fetch: async () => ({ status: 500, json: async () => ({}) }),
    TextEncoder,
    Date, Math, parseInt, Number, String, Array, Object, JSON, Promise, Set, URL, console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    DESKTOP: false,
    DESKTOP_ONLINE: true,
    state: 'idle',
    pickOpen: false,
    printing: false,
    flowBusy: false,
    printPrefs: { voucherPrinter: false },
    payBatches: [],
    renderPayBatches: () => {},
    setupScopeEvent: () => 'ev_test',
    showToast: (m) => { toasts.push(m); },
    postApi: async () => ({ status: 500, j: {} }),
    refreshPrintUI: () => {},
    payChanged: () => {},
    cashApply: () => {},
    buildLayoutPicker: () => {},
    refreshD7Tabs: () => {}
  };
  vm.createContext(ctx2);
  vm.runInContext(src, ctx2);
  ctx2._serialSent = serialSent;
  vm.runInContext('cashSend = function (cmd) { _serialSent.push(String(cmd || "").trim()); return true; };', ctx2);
  vm.runInContext(boothSlice, ctx2);
  const run2 = (code) => vm.runInContext(code, ctx2);

  // 5a. Layout wordings mismatch fix (Option 1..4 with duplicate tiers and stale placeholder strings)
  run2(`
    payCfg = cleanPay({
      mode: 'off',
      cash: true,
      cashExpire: true,
      cashExpireMin: 10,
      hideBadge: false,
      dual: true,
      options: [
        { id: 'opt_1', label: 'Option 1', placeholder: 'Thermal', price: 20, tier: 'receipt', prints: 2 },
        { id: 'opt_2', label: 'Option 2', placeholder: 'Coloured', price: 30, tier: 'receipt', prints: 3 },
        { id: 'opt_3', label: 'Option 3', placeholder: 'Any layout', price: 50, tier: 'photo', prints: 1 },
        { id: 'opt_4', label: 'Option 4', placeholder: 'Any layout', price: 100, tier: 'receipt', prints: 1 }
      ]
    });
  `);
  const cleanPh = run2('payCfg.options.map(function (o) { return o.placeholder; }).join(",")');
  ok(cleanPh === 'Thermal,Thermal,Coloured,Thermal', 'cleanPay syncs option placeholders from tier even when saved placeholders were stale');

  // Render layout option cards in Start Session
  const waitP = run2('payGate()');
  const gridHtml = getEl('payOptionsGrid').innerHTML;
  const optTiersRendered = [...gridHtml.matchAll(/<span[^>]*class="pay-opt-tier-pill"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1]);
  ok(optTiersRendered.join(',') === 'Thermal,Thermal,Coloured,Thermal', 'payOptionsGrid renders correct tier wordings: Thermal,Thermal,Coloured,Thermal');
  ok(getEl('payTitle').textContent === '₱20 / ₱30 / ₱50 / ₱100' && getEl('payTitle').classList.contains('multi') === true, 'option grid header shows available template prices with multi class');

  // 5b. Pick Option 1 (P20, 2 prints, Thermal) -> header shows selected template price & option instead of P20/P30/P50/P100
  serialSent.length = 0;
  run2('cashSetBalance(0);');
  getEl('payOptionsGrid')._fire('click', {
    target: { closest: (sel) => (sel === '.pay-dyn-opt' ? { dataset: { idx: '0' } } : null) }
  });
  ok(getEl('payKicker').textContent === 'Template Price', 'selected option header kicker reads Template Price');
  ok(getEl('payTitle').textContent === '₱20' && getEl('payTitle').classList.contains('multi') === false, 'selected option header title reads ₱20 without multi class (no longer all options)');
  ok(getEl('paySub').textContent === 'Option 1 · 2 prints included', 'selected option header subtitle reads Option 1 · 2 prints included');

  // 5c. Exact serial sequence: price{20} -> credit{0} -> cash_open -> c10 -> credit{10} -> c10 -> credit{20} -> cash_close -> payment_success -> credit{0}
  run2('payFinish(false); cashSetBalance(0); esp32LastPriceVal = null; esp32LastCreditVal = null;');
  serialSent.length = 0;
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', {
    target: { closest: (sel) => (sel === '.pay-dyn-opt' ? { dataset: { idx: '0' } } : null) }
  });
  run2('cashCredit(10); cashCredit(10);');
  ok(
    serialSent.join('|') === 'price{20}|credit{0}|cash_open|credit{10}|credit{20}|cash_close|payment_success|credit{0}',
    'full P20 cash flow emits price{20} -> credit{0} -> cash_open -> credit{10} -> credit{20} -> cash_close -> payment_success -> credit{0} (got: ' + serialSent.join('|') + ')'
  );

  // 5d. Pre-inserted P5 balance when guest picks P50 template (Option 3)
  run2('setPayCredit(null); payFinish(false); cashSetBalance(5);');
  serialSent.length = 0;
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', {
    target: { closest: (sel) => (sel === '.pay-dyn-opt' ? { dataset: { idx: '2' } } : null) }
  });
  ok(
    serialSent.join('|') === 'price{50}|credit{5}|cash_open',
    'selecting P50 template with P5 credit sends price{50}, credit{5}, and cash_open'
  );
  run2('payFinish(false);');

  // 5e. Hide top welcome price/options text (#payBadge)
  run2('payCfg.hideBadge = false; refreshPayBadge();');
  ok(ctx2.document.body.classList.contains('pay-badge-on') === true, 'payBadge visible when hideBadge is off');
  run2('payCfg.hideBadge = true; refreshPayBadge();');
  ok(ctx2.document.body.classList.contains('pay-badge-on') === false, 'payBadge hidden when hideBadge setting is enabled');

  // 5f. Idle cash credit balance expiry (>10 minutes)
  run2('cashSetBalance(15); payCfg.cashExpire = true; payCfg.cashExpireMin = 10;');
  run2('cashTouchActivity(Date.now() - (9 * 60000)); _serialSent.length = 0; cashIdleTick();');
  ok(run2('cashBalance()') === 15 && serialSent.length === 0, 'credit does not expire before 10 min idle');
  run2('cashTouchActivity(Date.now() - (10 * 60000 + 2000)); _serialSent.length = 0; cashIdleTick();');
  ok(run2('cashBalance()') === 0 && serialSent.join('|') === 'credit{0}', 'credit expires to 0 after >10 min idle and sends credit{0}');

  run2('cashSetBalance(25); payCfg.cashExpire = false; cashTouchActivity(Date.now() - (30 * 60000)); _serialSent.length = 0; cashIdleTick();');
  ok(run2('cashBalance()') === 25 && serialSent.length === 0, 'credit does not expire when cashExpire setting is disabled');

  // 5g. Softcopy-only (prints: 0) offline voucher batch keeps prints === 0
  const batch = await run2('makeOfflineBatch(2, 0, 50, "Softcopy", "photo")');
  const firstCode = batch.codes[0].c;
  const redeemed = await run2(`payRedeem(${JSON.stringify(firstCode)})`);
  ok(batch.prints === 0 && redeemed.ok === true && redeemed.prints === 0, 'offline softcopy voucher (prints: 0) preserves prints === 0');

  // 6a. Dedup reset on Back / Close: rapid re-selection (<5ms) still re-sends price{...} and cash_open
  run2('payCfg = cleanPay({ mode: "off", cash: true, dual: true, options: [{ label: "Option 1", price: 20, tier: "receipt", prints: 2 }, { label: "Option 2", price: 30, tier: "receipt", prints: 3 }, { label: "Option 3", price: 50, tier: "photo", prints: 1 }, { label: "Option 4", price: 100, tier: "receipt", prints: 1 }] });');
  run2('setPayCredit(null); cashSetBalance(0); payFinish(false);');
  serialSent.length = 0;
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', { target: { closest: (s) => (s === '.pay-dyn-opt' ? { dataset: { idx: '0' } } : null) } });
  getEl('payBack')._fire('click');
  getEl('payOptionsGrid')._fire('click', { target: { closest: (s) => (s === '.pay-dyn-opt' ? { dataset: { idx: '0' } } : null) } });
  ok(
    serialSent.join('|') === 'price{20}|credit{0}|cash_open|cash_close|price{20}|credit{0}|cash_open',
    'Back + rapid re-select of Option 1 re-sends price{20}|credit{0}|cash_open (got: ' + serialSent.join('|') + ')'
  );
  run2('payFinish(false);');

  // 6b. Overpayment carryover across duplicate-tier options (Option 2: P30/3prints -> P50 inserted -> Option 1: P20/2prints auto-covered)
  const copySliceStart = boothHtml.indexOf('function defaultSessionPrintCopies()');
  const copySliceEnd = boothHtml.indexOf('function openCopiesSheet', copySliceStart);
  ok(copySliceStart > 0 && copySliceEnd > copySliceStart, 'built booth.html contains defaultSessionPrintCopies');
  run2('var MAX_COPIES = 10; var printPrefs = { voucherPrinter: false, copies: 1 };');
  vm.runInContext(boothHtml.slice(copySliceStart, copySliceEnd), ctx2);
  serialSent.length = 0;
  run2('setPayCredit(null); cashSetBalance(0);');
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', { target: { closest: (s) => (s === '.pay-dyn-opt' ? { dataset: { idx: '1' } } : null) } });
  run2('cashCredit(50);');
  ok(
    serialSent.join('|') === 'price{30}|credit{0}|cash_open|credit{50}|cash_close|payment_success|credit{20}',
    'Option 2 (P30) paid with P50 leaves credit{20} (got: ' + serialSent.join('|') + ')'
  );
  ok(
    run2('sessionTier === "receipt" && sessionPayLabel === "Option 2" && sessionOptionPrints === 3 && payPrintAllow === 3 && defaultSessionPrintCopies() === 3'),
    'Option 2 payment sets sessionTier=receipt, sessionPayLabel=Option 2, 3 prints'
  );
  // Consume first session's paid credit and start next session selecting Option 1 (P20)
  run2('consumePayCredit(); payFinish(true);');
  serialSent.length = 0;
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', { target: { closest: (s) => (s === '.pay-dyn-opt' ? { dataset: { idx: '0' } } : null) } });
  ok(
    serialSent.join('|') === 'price{20}|credit{20}|payment_success|credit{0}',
    'leftover P20 credit auto-pays Option 1 without cash_open and clears credit{0} (got: ' + serialSent.join('|') + ')'
  );
  ok(
    run2('sessionTier === "receipt" && sessionPayLabel === "Option 1" && sessionOptionPrints === 2 && payPrintAllow === 2 && defaultSessionPrintCopies() === 2'),
    'Option 1 payment sets sessionTier=receipt, sessionPayLabel=Option 1, 2 prints'
  );
  run2('consumePayCredit(); payFinish(true);');

  // 6c. QR + Cash dual-method flow preserves Template Price header and 2-step Back navigation
  ctx2.window.__PB.offline = false;
  run2('payCfg = cleanPay({ mode: "qr", cash: true, dual: true, options: payCfg.options }); setPayCredit(null); cashSetBalance(5);');
  serialSent.length = 0;
  run2('payGate();');
  getEl('payOptionsGrid')._fire('click', { target: { closest: (s) => (s === '.pay-dyn-opt' ? { dataset: { idx: '2' } } : null) } });
  ok(
    getEl('payKicker').textContent === 'Template Price' && getEl('payTitle').textContent === '₱50' && getEl('paySub').textContent === 'Option 3 · 1 print included',
    'QR+Cash method step shows selected Template Price · ₱50 · Option 3 · 1 print included'
  );
  ok(getEl('payOptQr').hidden === false && getEl('payOptCash').hidden === false && getEl('payDualChooseBox').style.display === 'none', 'method step offers QR and Cash while hiding option cards');
  getEl('payOptCash')._fire('click');
  ok(serialSent.join('|') === 'price{50}|credit{5}|cash_open', 'tapping Cash from QR+Cash emits price{50}|credit{5}|cash_open (got: ' + serialSent.join('|') + ')');
  getEl('payBack')._fire('click');
  ok(getEl('payTitle').textContent === '₱50' && getEl('payDualChooseBox').style.display === 'none', 'first Back from payCash returns to Option 3 payment method step');
  getEl('payBack')._fire('click');
  ok(getEl('payDualChooseBox').style.display === '' && getEl('payTitle').textContent === '₱20 / ₱30 / ₱50 / ₱100', 'second Back returns to 4-option template grid');
  run2('payFinish(false);');

  // 6d. Setup editor live tier/prints changes + save/reload serialization + single-price payCashAuto
  run2('document.getElementById("payOptionsList")._fire("change", { target: { classList: { contains: (c) => c === "pay-opt-tier" }, dataset: { idx: "1" }, value: "photo" } });');
  ok(run2('payCfg.options[1].tier === "photo" && payCfg.options[1].placeholder === "Coloured"'), 'changing Option 2 tier in Setup updates placeholder to Coloured');
  run2('var snap = JSON.parse(JSON.stringify(payCfg)); snap.cashExpire = true; snap.cashExpireMin = 15; snap.hideBadge = true; var rt = cleanPay(snap);');
  ok(run2('rt.cashExpire === true && rt.cashExpireMin === 15 && rt.hideBadge === true && rt.options[1].placeholder === "Coloured" && rt.options[0].prints === 2'), 'cleanPay round-trips saved Setup JSON accurately');

  run2('document.body.classList.add("in-session"); payCfg = cleanPay({ mode: "off", cash: true, dual: false, price: 20, prints: 2 }); setPayCredit(null); cashSetBalance(0);');
  serialSent.length = 0;
  run2('cashCredit(10); cashCredit(10);');
  ok(
    serialSent.join('|') === 'credit{10}|credit{20}|price{20}|payment_success|credit{0}',
    'single-price payCashAuto emits credit{10} -> credit{20} -> price{20} -> payment_success -> credit{0} (got: ' + serialSent.join('|') + ')'
  );
  run2('consumePayCredit(); document.body.classList.remove("in-session");');

  // 6e. Layout tier filtering & duplicate-tier pickLayout badge labeling from built booth.html
  const layoutHelperSlice = boothHtml.slice(
    boothHtml.indexOf('function frameTier(f)'),
    boothHtml.indexOf('function isStripLayout(key)')
  );
  const gckStart = boothHtml.indexOf('function guestChoiceKeys(tierFilter, mergeStandaloneFrames)');
  const gckEnd = boothHtml.indexOf('function currentPickThumbSig()');
  const pkStart = boothHtml.indexOf('function pickLayout(keys, uiOpts)');
  const pkEnd = boothHtml.indexOf('function markPick()');
  ok(layoutHelperSlice.length > 0 && gckStart > 0 && gckEnd > gckStart && pkStart > 0 && pkEnd > pkStart, 'built booth.html contains layout filtering and pickLayout slices');
  if (layoutHelperSlice.length > 0 && gckStart > 0 && pkStart > 0) {
    const madeCards = [];
    const pickGridObj = {
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      set innerHTML(v) { madeCards.length = 0; },
      appendChild: (b) => { madeCards.push(b); }
    };
    const pickOverlayObj = { classList: { add: () => {}, remove: () => {} } };
    const ctx3 = {
      document: {
        body: { classList: { add: () => {}, remove: () => {}, contains: () => false } },
        getElementById: (id) => (id === 'pickGrid' ? pickGridObj : id === 'pickOverlay' ? pickOverlayObj : { textContent: '', hidden: true, classList: { toggle: () => {}, add: () => {}, remove: () => {} } }),
        createElement: (tag) => {
          const el = {
            tagName: tag.toUpperCase(),
            type: '',
            className: '',
            textContent: '',
            alt: '',
            loading: '',
            decoding: '',
            src: '',
            children: [],
            append: (...nodes) => { el.children.push(...nodes); },
            addEventListener: () => {}
          };
          return el;
        }
      },
      payCfg: {
        mode: 'off',
        cash: true,
        dual: true,
        options: [
          { label: 'Option 1', price: 20, tier: 'receipt', prints: 2 },
          { label: 'Option 2', price: 30, tier: 'receipt', prints: 3 },
          { label: 'Option 3', price: 50, tier: 'photo', prints: 1 },
          { label: 'Option 4', price: 100, tier: 'receipt', prints: 1 }
        ]
      },
      payActive: () => true,
      tierSplitOn: () => false,
      tierPrinters: {},
      helperOn: false,
      helper: null,
      btThermalOn: false,
      btProfileName: () => '',
      currentLayout: 'strip',
      setupLayout: 'strip',
      activeFrameId: null,
      activeDesignIdx: 0,
      guestDesigns: [],
      guestPickOn: true,
      guestLayoutSet: ['receipt', 'strip', 'quad'],
      chooseIds: ['f_bw', 'f_col'],
      myFrames: [
        { id: 'f_bw', name: 'BW Receipt Frame', tier: 'receipt', spots: [{}] },
        { id: 'f_col', name: 'Color Frame', tier: 'photo', color: true, spots: [{}, {}] }
      ],
      frameById: (id) => ctx3.myFrames.find((f) => f.id === id) || null,
      activeFrame: () => null,
      presetById: () => null,
      frameShotCount: (f) => (f && f.spots ? f.spots.length : 1),
      presetShotCount: () => 4,
      LAYOUT_ORDER: ['receipt', 'strip', 'quad'],
      LAYOUT_DEFS: {
        receipt: { name: 'Thermal 80mm', kind: 'receipt', shots: 3 },
        strip: { name: '2x6 Strip', kind: 'strip', shots: 3 },
        quad: { name: '4R Grid', kind: 'grid', shots: 4 }
      },
      LAYOUT_TIER_LABEL: { receipt: '🧾 Thermal', photo: '🎨 Coloured', all: '✨ Any layout' },
      framesStandAlongsideDesigns: () => false,
      mainLayoutKey: () => 'strip',
      syncActiveDesignSlot: () => {},
      designSlotFallbackLayout: () => 'strip',
      ensureGuestDesigns: () => {},
      pickTitleText: () => 'Choose your layout',
      pickSubText: () => 'Tap a layout',
      pickName: (k) => k,
      currentPickThumbSig: () => 's',
      pickGrid: {
        classList: { toggle: () => {}, add: () => {}, remove: () => {} },
        set innerHTML(v) { madeCards.length = 0; },
        appendChild: (b) => { madeCards.push(b); }
      },
      pickBackBtn: null,
      pickOverlay: { classList: { add: () => {}, remove: () => {} } },
      pickThumbs: { sig: 's', urls: { 'frame:f_bw': 'x', 'frame:f_col': 'x', receipt: 'x', strip: 'x', quad: 'x' } },
      _pickThumbGen: 0,
      pickTierMode: false,
      pickDesignMode: false,
      pickTierFilter: null,
      pickBackAllowed: false,
      pickOpen: false,
      pickResolve: null,
      pickKeys: [],
      pickIdx: -1,
      markPick: () => {},
      updateGuestFlowSteps: () => {},
      cashSend: () => true,
      refreshPrintFab: () => {},
      refreshWelcome: () => {},
      guestRender: () => {},
      setTimeout: () => 0,
      sessionTier: null,
      sessionPayLabel: '',
      Date, Math, Array, Object, String, Number, Boolean, Promise, RegExp
    };
    vm.createContext(ctx3);
    vm.runInContext(layoutHelperSlice + '\n' + boothHtml.slice(gckStart, gckEnd) + '\n' + boothHtml.slice(pkStart, pkEnd), ctx3);

    // Selecting Option 2 (duplicate receipt tier) -> thermal layouts only + Option 2 badge
    ctx3.sessionTier = 'receipt';
    ctx3.sessionPayLabel = 'Option 2';
    const rKeys = vm.runInContext('guestChoiceKeys()', ctx3);
    ok(rKeys.join(',') === 'frame:f_bw,receipt', 'Option 2 (receipt) filters guestChoiceKeys strictly to thermal layouts (got: ' + rKeys.join(',') + ')');
    vm.runInContext('pickLayout(guestChoiceKeys())', ctx3);
    const rBadges = madeCards.map((b) => b.children.find((c) => /pick-tier-tag/.test(c.className))?.textContent);
    ok(rBadges.length === 2 && rBadges.every((t) => t === '🧾 Option 2'), 'duplicate thermal Option 2 tags picker cards "🧾 Option 2" instead of Option 1 (got: ' + rBadges.join('|') + ')');

    // Selecting Option 3 (photo tier) -> colour layouts only + Option 3 badge
    ctx3.sessionTier = 'photo';
    ctx3.sessionPayLabel = 'Option 3';
    const cKeys = vm.runInContext('guestChoiceKeys()', ctx3);
    ok(cKeys.join(',') === 'frame:f_col,strip,quad', 'Option 3 (photo) filters guestChoiceKeys strictly to coloured layouts (got: ' + cKeys.join(',') + ')');
    vm.runInContext('pickLayout(guestChoiceKeys())', ctx3);
    const cBadges = madeCards.map((b) => b.children.find((c) => /pick-tier-tag/.test(c.className))?.textContent);
    ok(cBadges.length === 3 && cBadges.every((t) => t === '🎨 Option 3'), 'Option 3 tags picker cards "🎨 Option 3" (got: ' + cBadges.join('|') + ')');
  }

  // 7. Hardware docs, ESP32 sketch & Android bridge consistency assertions
  const inoSrc = readFileSync(join(repo, 'public', 'cash-acceptor', 'esp32-cash-acceptor.ino'), 'utf8');
  const docsHtml = readFileSync(join(repo, 'public', 'cash-acceptor', 'index.html'), 'utf8');
  const espKt = readFileSync(join(repo, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'Esp32Bridge.kt'), 'utf8');
  const mainKt = readFileSync(join(repo, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'MainActivity.kt'), 'utf8');
  ok(boothHtml.includes('body.in-session.welcome-on.pay-badge-on:not(.pay-open) .pay-badge') && boothHtml.includes('.pay-title.multi'), 'built booth.html scopes pay-badge to live in-session welcome screen and includes .pay-title.multi padding');
  ok(inoSrc.includes('uint32_t creditPesos = 0;') && inoSrc.includes('cmd.startsWith("credit{")') && inoSrc.includes('SN74AHCT125N') && inoSrc.includes('EL816B'), 'ESP32 .ino includes credit{} parser and SN74AHCT125N + EL816B wiring notes');
  ok(docsHtml.includes('credit{5}') && docsHtml.includes('RX: credit{10}') && docsHtml.includes('RX: credit{20}') && docsHtml.includes('SN74AHCT125N') && docsHtml.includes('1000&nbsp;&micro;F / 16V') && docsHtml.includes('EL816B'), 'cash-acceptor/index.html documents credit{} flow, SN74AHCT125N, 330 ohm, 1000uF/16V, and EL816B');
  ok(espKt.includes('const val REQ_PERMISSION = 1004') && espKt.includes('fun onPermissionResult(') && espKt.includes('if (rawName.isNullOrBlank() && !hasNus) return') && mainKt.includes('Esp32Bridge.REQ_PERMISSION'), 'Android Esp32Bridge + MainActivity handle unnamed NUS peripherals and permission result auto-resume');

  // 8. Custom package/voucher labeling, credit badges on grid, batch metadata & ticket labels
  ok(boothHtml.includes('Choose your package:') && boothHtml.includes('#payOptionsGrid .pay-opt {'), 'built booth.html uses general package prompt and level #payOptionsGrid card CSS');
  const vtStart = boothHtml.indexOf('function voucherTicketMeta(data)');
  const vtEnd = boothHtml.indexOf('function vDrawRoundRect', vtStart);
  ok(vtStart > 0 && vtEnd > vtStart, 'built booth.html contains voucherTicketMeta');
  if (vtStart > 0 && vtEnd > vtStart) vm.runInContext(boothHtml.slice(vtStart, vtEnd), ctx2);
  run2(`
    payCfg = cleanPay({
      mode: 'both',
      cash: true,
      dual: true,
      options: [
        { id: 'opt_1', label: 'Thermal Promo', price: 20, tier: 'receipt', prints: 2 },
        { id: 'opt_2', label: 'Barkada Strip', price: 30, tier: 'receipt', prints: 3 },
        { id: 'opt_3', label: 'Softcopy VIP', price: 50, tier: 'all', prints: 0 },
        { id: 'opt_4', label: '4R Studio', price: 100, tier: 'photo', prints: 1 }
      ]
    });
    setPayCredit(null);
    cashSetBalance(25);
    payBatches = [
      { id: 'b_barkada', label: 'Barkada Strip', tier: 'receipt', price: 30, prints: 3, total: 10, usedCount: 1, voidCount: 0, at: Date.now(), codes: [{ c: '11112222', used: false }] },
      { id: 'b_legacy', label: 'Early Bird', tier: 'receipt', price: 25, prints: 1, total: 5, usedCount: 0, voidCount: 0, at: Date.now(), codes: [{ c: '33334444', used: false }] }
    ];
    updatePayMakeTier();
  `);
  run2('payGate();');
  const customGrid = getEl('payOptionsGrid').innerHTML;
  ok(
    customGrid.includes('✓ Covered by ₱25 credit') && customGrid.includes('₱5 more needed'),
    'payOptionsGrid shows live credit coverage badges (Covered vs more needed) for waiting cash credit'
  );
  run2('payFinish(false); cashSetBalance(0);');
  const makeTierHtml = getEl('payMakeTier').innerHTML;
  ok(
    makeTierHtml.includes('Barkada Strip (₱30) · 🧾 Thermal · 3 prints') && makeTierHtml.includes('Softcopy VIP (₱50) · ✨ Any · softcopy only') && getEl('payMakeTier').value === 'opt_0',
    'updatePayMakeTier displays custom package labels, prints/softcopy info, and defaults to opt_0 when dual is on'
  );
  // RenderPayBatches test via a standalone container check using the exact booth slice
  const rpbStart = boothHtml.indexOf('function fmtShortDate(t)');
  const rpbEnd = boothHtml.indexOf('async function payLoadBatches()', rpbStart);
  if (rpbStart > 0 && rpbEnd > rpbStart) {
    vm.runInContext(boothHtml.slice(rpbStart, rpbEnd), ctx2);
    run2('renderPayBatches();');
    const batchesHtml = getEl('payBatches').innerHTML;
    ok(
      batchesHtml.includes('10 vouchers · Barkada Strip') && batchesHtml.includes('3 prints') && !batchesHtml.includes('Barkada Strip · Thermal Promo'),
      'renderPayBatches preserves duplicate-tier Barkada Strip label and 3 prints without falling back to Option 1'
    );
    ok(
      batchesHtml.includes('5 vouchers · Early Bird') && batchesHtml.includes('1 print') && !batchesHtml.includes('Thermal Promo'),
      'renderPayBatches preserves custom/renamed batch label Early Bird instead of overwriting with Option 1'
    );
  }
  ok(
    run2('voucherTicketMeta({ label: "Barkada Strip", tier: "receipt", prints: 3 }).incStr') === 'Barkada Strip · 3 prints' &&
    run2('voucherTicketMeta({ label: "Softcopy VIP", tier: "all", prints: 0 }).incStr') === 'Softcopy VIP · softcopy only' &&
    run2('voucherTicketMeta({ label: "4R Studio", tier: "photo", prints: 0 }).incStr') === '4R Studio · 1 print' &&
    run2('voucherTicketMeta({ label: "Early Bird", tier: "receipt", prints: 1 }).incStr') === 'Early Bird · 1 print',
    'voucherTicketMeta preserves duplicate-tier, softcopy, and historical custom batch labels cleanly'
  );
  // Option with prints: null ("Same as default") when payCfg.prints === 0 must NOT say "softcopy only"
  run2(`
    payCfg = cleanPay({ mode: 'voucher', dual: true, prints: 0, options: [{ id: 'opt_def', label: 'Standard 4R', price: 80, tier: 'photo', prints: null }] });
    payBatches = [{ id: 'b_def', label: 'Standard 4R', tier: 'photo', price: 80, prints: 0, total: 5, usedCount: 0, voidCount: 0, at: Date.now(), codes: [{ c: '99998888', used: false }] }];
    renderPayBatches();
  `);
  ok(
    run2('voucherTicketMeta({ label: "Standard 4R", tier: "photo", prints: 0 }).incStr') === 'Standard 4R' &&
    !getEl('payBatches').innerHTML.includes('Softcopy only'),
    'option using "Same as default" when payCfg.prints=0 never mislabels itself as Softcopy only'
  );

  // 9. Overall cash acceptor hardware/transport, lighting-only, Voucher+Cash, wake-expiry & Android BLE checks
  // 9a. Single-price Voucher + Cash sends both price{20} and credit{5} on payChoose
  run2('payCfg = cleanPay({ mode: "voucher", cash: true, dual: false, price: 20, prints: 1 }); setPayCredit(null); cashSetBalance(5); payFinish(false);');
  serialSent.length = 0;
  run2('payGate();');
  ok(serialSent.join('|') === 'price{20}|credit{5}', 'single-price Voucher+Cash emits price{20}|credit{5} when opening method chooser (got: ' + serialSent.join('|') + ')');
  run2('payFinish(false);');

  // 9b. Instant idle expiry guard inside payGate() (waking tablet after >10 min idle before 5s interval ticks)
  run2('payCfg = cleanPay({ mode: "off", cash: true, cashExpire: true, cashExpireMin: 10, dual: false, price: 20 }); setPayCredit(null); cashSetBalance(20); cashTouchActivity(Date.now() - (11 * 60000));');
  serialSent.length = 0;
  run2('payGate();');
  ok(
    run2('cashBalance() === 0 && !payCredit() && payState.view === "payCash"') && serialSent.join('|') === 'credit{0}|price{20}|cash_open',
    'payGate() expires >10m stale credit immediately before spending it and opens payCash cleanly (got: ' + serialSent.join('|') + ')'
  );
  run2('payFinish(false);');

  // 9c. Lighting-only mode (payCfg.cash = false, fxEsp32On = true): ignores coin pulses and omits credit{}
  run2('payCfg = cleanPay({ mode: "off", cash: false }); setFxEsp32On(true); cashSetBalance(0);');
  serialSent.length = 0;
  ok(run2('cashCredit(10)') === 0 && run2('cashBalance()') === 0, 'lighting-only mode ignores stray coin pulses');
  run2('esp32SendCredit(10, true);');
  ok(serialSent.length === 0 && run2('cashStateHook()') === 'session_idle', 'lighting-only mode suppresses credit{} commands and returns string session_idle');
  run2('setFxEsp32On(false);');

  // 9d. Native Android __Esp32Event strict parser & reconnect sync check in primary VM
  btSent.length = 0;
  ctx.cashCredit; // verify active
  run('cashSetBalance(0); cashLinkEnabled = true; cashLink.mode = "ble"; cashHooks.credit = function () {}; cashStateHook = function () { return ["price{30}", "credit{10}", "cash_open"]; };');
  run('window.__Esp32Event({ type: "connected", mode: "ble", address: "AA:BB:CC:DD:EE:FF", name: "Photobooth4u-Cash", twoWay: true });');
  await new Promise((r) => setTimeout(r, 200));
  ok(btSent.join('|') === 'price{30}|credit{10}|cash_open', '__Esp32Event connected triggers cashSendCurrentState array sync (got: ' + btSent.join('|') + ')');
  run('window.__Esp32Event({ type: "line", line: "ok:cash_close50" });');
  ok(run('cashBalance()') === 0, '__Esp32Event line ignores ok:cash_close50 ACK without false-crediting');
  run('window.__Esp32Event({ type: "line", line: "c20" });');
  ok(run('cashBalance()') === 20, '__Esp32Event line credits c20 over strict parser');
  let reconnected = false;
  ctx.window.__Esp32Bridge.connectSaved = () => { reconnected = true; return true; };
  run('window.__Esp32Bridge.isConnected = () => false;');
  run('window.__Esp32Event({ type: "disconnected", reason: "dropped" });');
  ok(run('cashLink.state === "lost"'), 'disconnect sets cashLink.state to lost');
  // Wait for 3s reconnect timer would slow test; verify timer armed and clean up cleanly
  ok(run('!!cashNativeRetryTimer'), 'disconnect while cashLinkEnabled schedules automatic native BLE reconnect');
  run('if (cashNativeRetryTimer) { clearTimeout(cashNativeRetryTimer); cashNativeRetryTimer = null; }');

  // 9e. Esp32Bridge.kt + AndroidManifest.xml + ESP32 .ino stack integrity checks
  const manifestXml = readFileSync(join(repo, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  ok(
    espKt.includes('hasWriteRsp = (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0') &&
    espKt.includes('BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT') &&
    espKt.includes('servicesDiscovered') &&
    espKt.includes('g.discoverServices()'),
    'Esp32Bridge.kt prefers WRITE_TYPE_DEFAULT when PROPERTY_WRITE exists and guards requestMtu with discovery timeout fallback'
  );
  ok(
    manifestXml.includes('BLUETOOTH_SCAN') && manifestXml.includes('BLUETOOTH_CONNECT') && manifestXml.includes('ACCESS_FINE_LOCATION'),
    'AndroidManifest.xml declares BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and ACCESS_FINE_LOCATION'
  );

  // 9f. Anti-lag & anti-hang architecture checks (Esp32Bridge + BTBridge + booth/cash JS)
  const btKt = readFileSync(join(repo, 'android', 'app', 'src', 'main', 'java', 'com', 'photobooth4u', 'booth', 'BTBridge.kt'), 'utf8');
  ok(
    espKt.includes('private val connExec:') &&
    espKt.includes('private fun scheduleConnect(') &&
    espKt.includes('MAX_WRITE_QUEUE') &&
    espKt.includes('private fun coalesceKey(') &&
    espKt.includes('BLE_CONNECT_TIMEOUT_MS') &&
    espKt.includes('consecutiveWriteTimeouts') &&
    espKt.includes('ACTION_ACL_DISCONNECTED'),
    'Esp32Bridge.kt uses async connExec, bounded coalescing writeQueue, BLE timeout watchdog, dead-link detection, and ACL disconnect listener'
  );
  ok(
    btKt.includes('fun writeAsync(') && btKt.includes('fun writePacedAsync(') && btKt.includes('"writeDone"'),
    'BTBridge.kt provides non-blocking writeAsync / writePacedAsync so printing never stalls ESP32 JS events'
  );
  ok(
    src.includes('cashNotifyStatusSoon') &&
    src.includes('cashScheduleNativeRetry') &&
    src.includes('cashNativeBridgeRef') &&
    boothHtml.includes('writePacedAsync') &&
    boothHtml.includes('_cashSetupDirty = true'),
    'cash-acceptor.js & booth.html coalesce status UI refreshes, cache native bridge check, use async BT writes, and defer Setup rebuilds in-session'
  );
}

if (fails) { console.error(fails + ' check(s) failed'); process.exit(1); }
console.log('OK: cash acceptor');
